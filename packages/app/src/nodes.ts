/**
 * 节点选择系统（docs/server-selection.md，2026-11-22 立项）。
 *
 * 房间服从"烘死单地址"升级为"多节点清单 + 自动测速择优 + 手动切换"。
 * 本模块是纯 app 层：不碰 sim/core，对局期协议零改动。唯一出口是选出的
 * serverUrl 写回 flow.serverUrl。设计规格与边界见 docs/server-selection.md。
 */
import type { Flow } from './flow.js';
import type {
  NodeEntry, NodeManifest, NodePreference, ProbeResult, Selection,
} from '@bvn/net';
import { decide, SELECT_TTL_MS } from '@bvn/net';

// 核心类型与纯决策逻辑在 @bvn/net（node-select.ts，可单测）；本模块只做清单加载/测速/DOM。

/** 冷启动种子（manifest 拉不到时回落）；正式值烘在 .env.production，可编辑。 */
export const SEED_MANIFEST: NodeManifest = {
  version: 1,
  autoSelectEnabled: true,
  matchNode: 'cn',
  nodes: [
    { id: 'cn', name: '国内节点', url: 'wss://120.48.185.202/bvn-ws', enabled: true },
    { id: 'cf', name: '外服节点', url: 'wss://bvn.gamedock.cn', enabled: true },
  ],
};

const MANIFEST_URL = import.meta.env.VITE_NODE_MANIFEST ?? 'https://bvn.gamedock.cn/manifest';

/** 拉权威清单，失败/非法回落种子。超时短线（2s）避免冷启动卡住。 */
export async function loadManifest(fetchFn: typeof fetch = fetch): Promise<NodeManifest> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2000);
    let res: Response;
    try {
      res = await fetchFn(MANIFEST_URL, { signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return SEED_MANIFEST;
    const data = (await res.json()) as Partial<NodeManifest>;
    if (!Array.isArray(data.nodes) || data.nodes.length === 0) return SEED_MANIFEST;
    return {
      version: typeof data.version === 'number' ? data.version : 1,
      autoSelectEnabled: data.autoSelectEnabled !== false,
      matchNode: typeof data.matchNode === 'string' ? data.matchNode : 'cn',
      nodes: data.nodes
        .filter((n) => n && typeof n.id === 'string' && typeof n.url === 'string')
        .map((n) => ({
          id: n.id!, name: n.name ?? n.id!, url: n.url!, enabled: n.enabled !== false,
        })),
    };
  } catch {
    return SEED_MANIFEST;
  }
}

// ---------- 偏好状态机（localStorage 持久化；决策逻辑在 net） ----------

const PREF_KEY = 'bvn.nodePref';

/** 手填/URL 强制指定存在 bvn.server（沿用现有键），非空即跳过自动选择。 */
export function forcedServerUrl(): string | null {
  return localStorage.getItem('bvn.server');
}

export function loadPreference(): NodePreference {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return { mode: 'auto' };
    const p = JSON.parse(raw) as NodePreference;
    return p.mode === 'manual' && typeof p.manualId === 'string' ? p : { mode: 'auto' };
  } catch {
    return { mode: 'auto' };
  }
}

export function savePreference(p: NodePreference): void {
  localStorage.setItem(PREF_KEY, JSON.stringify(p));
}

// ---------- 测速 ----------

/** ws 形状（浏览器原生与测试桩共用）；只用到 open/message/close。 */
export interface ProbeSocket {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export type ProbeSocketFactory = (url: string) => ProbeSocket;

const PING_ROUNDS = 5;
const PING_INTERVAL_MS = 100;
const PROBE_TIMEOUT_MS = 1500;

/** 对单节点并行测速：多轮 ping 取 p50/p95，超时/错误剔除。 */
export function probeNode(
  entry: NodeEntry,
  makeSocket: ProbeSocketFactory,
  now: () => number = () => performance.now(),
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<ProbeResult> {
  const fail = (): ProbeResult => ({
    nodeId: entry.id, ok: false, rttP50: Infinity, rttP95: Infinity, queue: 0,
  });
  return new Promise((resolve) => {
    let sock: ProbeSocket;
    try {
      sock = makeSocket(entry.url);
    } catch {
      resolve(fail());
      return;
    }
    const rtts: number[] = [];
    const sent = new Map<number, number>();
    let queue = 0;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch { /* ignore */ }
      if (!ok || rtts.length === 0) { resolve(fail()); return; }
      const s = [...rtts].sort((a, b) => a - b);
      const p50 = s[Math.floor((s.length - 1) * 0.5)]!;
      const p95 = s[Math.floor((s.length - 1) * 0.95)]!;
      resolve({ nodeId: entry.id, ok: true, rttP50: p50, rttP95: p95, queue });
    };
    const timer = setTimeout(() => finish(rtts.length > 0), PROBE_TIMEOUT_MS);
    const clear = () => clearTimeout(timer);
    sock.onmessage = (ev) => {
      let msg: { t?: string; id?: number; queue?: number };
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
      } catch { return; }
      if (msg.t === 'pong' && typeof msg.id === 'number') {
        const t0 = sent.get(msg.id);
        if (t0 !== undefined) {
          rtts.push(now() - t0);
          sent.delete(msg.id);
          if (typeof msg.queue === 'number') queue = msg.queue;
        }
      }
    };
    sock.onerror = () => { clear(); finish(false); };
    sock.onclose = () => { clear(); finish(rtts.length > 0); };
    sock.onopen = () => {
      void (async () => {
        for (let i = 0; i < PING_ROUNDS; i++) {
          if (settled) return;
          const id = i + 1;
          sent.set(id, now());
          try { sock.send(JSON.stringify({ t: 'ping', id })); } catch { clear(); finish(false); return; }
          await wait(PING_INTERVAL_MS);
        }
        // 末轮发出后给 pong 留一个 RTT 窗（超时定时器兜底）
      })();
    };
  });
}

/** 构造浏览器 WebSocket 工厂（测速用原生 sockets，不复用对局连接）。 */
export function browserSocketFactory(): ProbeSocketFactory {
  return (url) => new WebSocket(url) as unknown as ProbeSocket;
}

/**
 * 完整选择流程：拉清单 → 若强制/手动且无需测速则直选；否则并行测速 → decide →
 * 写回 flow.serverUrl + 持久化偏好 + 埋点 console。返回 Selection。
 */
export async function selectNode(flow: Flow): Promise<Selection> {
  const forced = forcedServerUrl();
  const [manifest, pref] = await Promise.all([loadManifest(), Promise.resolve(loadPreference())]);
  let results: ProbeResult[] = [];
  // 强制指定或 auto 缓存有效时免测速；manual 仍需测速以显示延迟/判定降级
  const needProbe = !forced && (pref.mode === 'manual' ||
    !manifest.autoSelectEnabled || !pref.lastResult ||
    Date.now() - pref.lastResult.at >= SELECT_TTL_MS);
  if (needProbe) {
    const targets = manifest.nodes.filter((n) => n.enabled);
    results = await Promise.all(targets.map((n) => probeNode(n, browserSocketFactory())));
  }
  const sel = decide(manifest, pref, forced, results);
  flow.serverUrl = sel.url;
  const rtt = results.find((r) => r.nodeId === sel.nodeId && r.ok)?.rttP50;
  flow.nodeInfo = rtt === undefined
    ? { nodeId: sel.nodeId, reason: sel.reason }
    : { nodeId: sel.nodeId, reason: sel.reason, rttP50: rtt };
  if (sel.reason === 'auto' && results.length) {
    const r = results.find((x) => x.nodeId === sel.nodeId);
    if (r) savePreference({ mode: 'auto', lastResult: { nodeId: sel.nodeId, rttP50: r.rttP50, jitter: r.rttP95 - r.rttP50, at: Date.now() } });
  }
  const r = results.find((x) => x.nodeId === sel.nodeId);
  console.log(`[node] 选中 ${sel.nodeId}（${sel.reason}）${r ? ` RTT p50=${Math.round(r.rttP50)}ms jitter=${Math.round(r.rttP95 - r.rttP50)}ms` : ''} → ${sel.url}`);
  return sel;
}

/** 手动切换节点（Menu 面板调用）：写偏好 + 重选。 */
export async function switchNode(flow: Flow, nodeId: string): Promise<Selection> {
  savePreference({ mode: 'manual', manualId: nodeId });
  return selectNode(flow);
}

/** 恢复自动选择（Menu 面板调用）。 */
export async function restoreAuto(flow: Flow): Promise<Selection> {
  savePreference({ mode: 'auto' });
  return selectNode(flow);
}

/**
 * 跨节点加入引导（文档 §4）：深链 `?room=<code>&node=<id>`。
 * 若目标节点与当前 flow.serverUrl 对应的节点不同，切到目标节点 URL 再入房。
 * 返回是否需要切换（供 UI 提示"该房间在 XX 节点"）。
 */
export async function resolveJoinNode(
  flow: Flow,
  room: string,
  nodeId: string | null,
): Promise<{ switched: boolean; nodeId: string | null }> {
  if (!room || !nodeId) return { switched: false, nodeId };
  const manifest = await loadManifest();
  const target = manifest.nodes.find((n) => n.id === nodeId && n.enabled);
  if (!target) return { switched: false, nodeId };
  const current = manifest.nodes.find((n) => n.url === flow.serverUrl);
  if (current?.id === nodeId) return { switched: false, nodeId };
  // 目标节点与当前不同 → 锁定到目标节点（写 manual 意图，避免后台 selectNode 又切走）
  flow.serverUrl = target.url;
  savePreference({ mode: 'manual', manualId: nodeId });
  flow.nodeInfo = { nodeId, reason: 'manual' };
  console.log(`[node] 跨节点加入：已切换到 ${target.name}（${nodeId}）→ 房间 ${room}`);
  return { switched: true, nodeId };
}

/** 当前节点显示文本（Menu 标签用）："节点：国内节点 · 38ms（自动）"。 */
export function nodeDisplayText(flow: Flow, manifest: NodeManifest = SEED_MANIFEST): string {
  const info = flow.nodeInfo;
  const id = info?.nodeId;
  const node = manifest.nodes.find((n) => n.id === id);
  const name = node?.name ?? (forcedServerUrl() ? '自定义' : id ?? '检测中');
  const rtt = info?.rttP50 ? ` · ${Math.round(info.rttP50)}ms` : '';
  const mode = info?.reason === 'manual' ? '手动' : info?.reason === 'forced' ? '指定' : info?.reason === 'fallback' ? '备用' : '自动';
  return `节点：${name}${rtt}（${mode}）`;
}

/**
 * Menu 节点切换浮层（DOM）：列出各节点 + 延迟，点击切换；"恢复自动"按钮。
 * 纯 DOM 覆盖层，不依赖 Pixi 布局；onChanged 回调供 Menu 刷新标签文本。
 */
export function showNodePanel(flow: Flow, host: HTMLElement, onChanged: () => void): void {
  void (async () => {
    const manifest = await loadManifest();
    // 复用已有面板则先移除
    document.getElementById('bvn-node-panel')?.remove();
    const panel = document.createElement('div');
    panel.id = 'bvn-node-panel';
    Object.assign(panel.style, {
      position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
      background: '#101828ee', color: '#e7eefc', padding: '20px 26px', borderRadius: '10px',
      border: '1px solid #33405c', font: '14px/1.6 system-ui, sans-serif', zIndex: '9999',
      minWidth: '260px', boxShadow: '0 8px 40px #000a',
    } as CSSStyleDeclaration);
    const title = document.createElement('div');
    title.textContent = '选择联机节点';
    Object.assign(title.style, { fontWeight: 'bold', fontSize: '16px', marginBottom: '10px' });
    panel.appendChild(title);
    const pref = loadPreference();
    for (const n of manifest.nodes.filter((x) => x.enabled)) {
      const btn = document.createElement('button');
      const current = flow.nodeInfo?.nodeId === n.id;
      btn.textContent = `${n.name}${n.id === manifest.matchNode ? '（匹配服）' : ''}${current ? ' ← 当前' : ''}`;
      Object.assign(btn.style, {
        display: 'block', width: '100%', margin: '6px 0', padding: '8px 12px',
        background: current ? '#2b6cb0' : '#1c2740', color: '#fff', border: '1px solid #3a4a6a',
        borderRadius: '6px', cursor: 'pointer', textAlign: 'left',
      } as CSSStyleDeclaration);
      btn.onclick = () => {
        void switchNode(flow, n.id).then(() => { onChanged(); panel.remove(); });
      };
      panel.appendChild(btn);
    }
    const auto = document.createElement('button');
    auto.textContent = pref.mode === 'auto' ? '自动择优（当前）' : '恢复自动择优';
    Object.assign(auto.style, {
      display: 'block', width: '100%', marginTop: '12px', padding: '8px 12px',
      background: pref.mode === 'auto' ? '#2f855a' : '#1c2740', color: '#fff',
      border: '1px solid #3a4a6a', borderRadius: '6px', cursor: 'pointer',
    } as CSSStyleDeclaration);
    auto.onclick = () => { void restoreAuto(flow).then(() => { onChanged(); panel.remove(); }); };
    panel.appendChild(auto);
    const close = document.createElement('div');
    close.textContent = '点击空白处关闭';
    Object.assign(close.style, { marginTop: '10px', fontSize: '11px', color: '#8492ad', textAlign: 'center', cursor: 'pointer' });
    close.onclick = () => panel.remove();
    panel.appendChild(close);
    host.appendChild(panel);
  })();
}
