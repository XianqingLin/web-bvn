/**
 * 节点择优的纯决策逻辑（DESIGN §6.2）。
 * 放在 net 包以便单测（无 DOM / 无 app 依赖）；app 层 nodes.ts 负责清单加载、
 * ping 测速与 DOM，复用这里的 score/decide。
 */

export interface NodeEntry {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

export interface NodeManifest {
  version: number;
  autoSelectEnabled: boolean;
  matchNode: string;
  nodes: NodeEntry[];
}

export interface ProbeResult {
  nodeId: string;
  ok: boolean;
  rttP50: number;
  rttP95: number;
  queue: number;
}

export type SelectMode = 'auto' | 'manual';

export interface NodePreference {
  mode: SelectMode;
  manualId?: string;
  lastResult?: { nodeId: string; rttP50: number; jitter: number; at: number };
}

export interface Selection {
  nodeId: string;
  url: string;
  reason: 'forced' | 'auto' | 'manual' | 'fallback';
  results: ProbeResult[];
}

export const SELECT_TTL_MS = 30 * 60 * 1000;

/** 评分 = p50 + λ·抖动 + 负载惩罚（文档 §3）。越低越好。 */
export function score(r: ProbeResult, lambda = 1, loadPenaltyMs = 2): number {
  if (!r.ok) return Infinity;
  return r.rttP50 + lambda * (r.rttP95 - r.rttP50) + r.queue * loadPenaltyMs;
}

/**
 * 决策核心（纯函数）：给定清单/偏好/强制地址/探测结果，选出节点。
 * 强制地址优先级最高（forced）。auto：缓存有效沿用 lastResult，否则按 score 选。
 * manual：锁定节点，不可用则降级到 score 最优的可用节点（reason=fallback）。
 * 全部探测失败 → matchNode → 清单首项。
 */
export function decide(
  manifest: NodeManifest,
  pref: NodePreference,
  forced: string | null,
  results: ProbeResult[],
  nowMs: number = Date.now(),
): Selection {
  if (forced) return { nodeId: '(forced)', url: forced, reason: 'forced', results };

  const enabled = manifest.nodes.filter((n) => n.enabled);
  const byId = (id: string) => enabled.find((n) => n.id === id);
  const okResults = results.filter((r) => r.ok);
  const best = [...okResults].sort((a, b) => score(a) - score(b))[0];

  if (pref.mode === 'manual' && pref.manualId) {
    const locked = byId(pref.manualId);
    const lockedOk = okResults.find((r) => r.nodeId === pref.manualId);
    if (locked && lockedOk) {
      return { nodeId: locked.id, url: locked.url, reason: 'manual', results };
    }
    // 锁定节点不可用 → 降级到可用最优，保留 manual 意图（节点恢复后切回）
    if (best) {
      const n = byId(best.nodeId)!;
      return { nodeId: n.id, url: n.url, reason: 'fallback', results };
    }
  }

  if (manifest.autoSelectEnabled && pref.lastResult &&
      nowMs - pref.lastResult.at < SELECT_TTL_MS) {
    const cached = byId(pref.lastResult.nodeId);
    if (cached && (okResults.length === 0 || okResults.some((r) => r.nodeId === cached.id && r.ok))) {
      return { nodeId: cached.id, url: cached.url, reason: 'auto', results };
    }
  }

  if (manifest.autoSelectEnabled && best) {
    const n = byId(best.nodeId)!;
    return { nodeId: n.id, url: n.url, reason: 'auto', results };
  }

  const fallback = byId(manifest.matchNode) ?? enabled[0] ?? manifest.nodes[0];
  return {
    nodeId: fallback?.id ?? '(none)',
    url: fallback?.url ?? 'ws://localhost:8787',
    reason: 'fallback',
    results,
  };
}
