/**
 * dev 预览页（切片 4 起，切片 6 接入联机模式）。
 *
 * 装配（与 tools/replay 同一接线，浏览器侧 fetch 版）：
 *   baked runtime + XFL JSON → compileFighterRuntime → SimConfig；
 *   baked map JSON → compileMapStage；图集 JSON → render.load()。
 * 输入经 InputSource 抽象喂 sim（DESIGN §9.7）：
 *   ?mode=solo（默认）训练模式：键盘源，P2 假人，R 键重置；
 *   ?mode=net&action=create|join&room=码[&server=ws://host:port][&port=8787][&role=p2]
 *     lockstep 联机：房间服务器编排（create 开房拿码，join 凭码入房），
 *     输入源 = LockstepClient（远端输入未到时本帧停步等待）。
 */
import { Application } from 'pixi.js';
import { Sim, Btn, type ButtonMask, type InputSource } from '@bvn/core';
import {
  INPUT_DELAY,
  startSession,
  makeConfigHash,
  type WsLike,
} from '@bvn/net';
import { compileAssistant, compileFighterForms, compileFighterRuntime, compileMapStage } from '@bvn/data';
import { BattleRenderer } from '@bvn/render';

const BAKED = '/packages/data/baked';
const ASSETS = '/packages/data/assets';

const FIGHTER_ID = 'ichigo';
const ASSIST_ID = 'gaara'; // 切片 13：capture 桥修复后任一辅助全帧可见；选 gaara（修复前 0%）作验收样本
const MAP_ID = 'KonohaMura';
const NET_SEED = 1;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

/** 可选 JSON（404 = null）：fire 包等按角色可选的资源。 */
async function fetchJsonOptional<T>(url: string): Promise<T | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  return (res.json() as Promise<T>) ?? null;
}

// ---------- 键盘 → ButtonMask ----------
// J 攻击 K 跳 L 瞬步 U 技 I 必杀；P1 用 WASD，P2 用方向键（同机双窗口各用一套）
const KEYMAP_P1: Record<string, number> = {
  KeyW: Btn.up,
  KeyS: Btn.down,
  KeyA: Btn.left,
  KeyD: Btn.right,
  KeyJ: Btn.attack,
  KeyK: Btn.jump,
  KeyL: Btn.dash,
  KeyU: Btn.skill,
  KeyI: Btn.superSkill,
  KeyO: Btn.assist,
};
const KEYMAP_P2: Record<string, number> = {
  ArrowUp: Btn.up,
  ArrowDown: Btn.down,
  ArrowLeft: Btn.left,
  ArrowRight: Btn.right,
  Digit1: Btn.attack,
  Digit2: Btn.jump,
  Digit3: Btn.dash,
};
const keys = new Set<string>();
window.addEventListener('keydown', (e) => keys.add(e.code));
window.addEventListener('keyup', (e) => keys.delete(e.code));

function maskFor(map: Record<string, number>): ButtonMask {
  let m = 0;
  for (const k of keys) {
    const bit = map[k];
    if (bit !== undefined) m |= bit;
  }
  return m;
}

/** 本地键盘输入源（solo 模式）：恒即时返回当前按住位图。 */
class KeyboardSource implements InputSource {
  constructor(private readonly map: Record<string, number>) {}
  frame(): { p1: ButtonMask; p2: ButtonMask } {
    return { p1: maskFor(this.map), p2: 0 };
  }
}

// ---------- 装配 ----------
async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') ?? 'solo';
  // net 模式下 role 只选键位（位次由房间服务器分配）：role=p2 用方向键，
  // 避免同机双窗口两套键盘互抢；两机联调时各自省略即可
  const netRole = mode === 'net' ? (params.get('role') === 'p2' ? 2 : 1) : null;
  // 房间服务器地址：?server=ws://host:port（云服务器部署用）；
  // 缺省 ws://localhost[:port]（本机联调）
  const netServer = params.get('server') ?? `ws://localhost:${params.get('port') ?? '8787'}`;
  const keymap = netRole === 2 ? KEYMAP_P2 : KEYMAP_P1;

  const app = new Application();
  await app.init({ width: 1000, height: 600, background: 0x0a0a12, antialias: true });
  const host = document.getElementById('stage');
  if (!host) throw new Error('#stage 缺失');
  host.appendChild(app.canvas);
  app.canvas.style.width = '100%';
  app.canvas.style.height = '100%';

  // 数据装配（与 replay.mjs 一致）
  const runtime = await fetchJson<import('@bvn/data').RuntimeFighterPackage>(
    `${BAKED}/fighters-runtime/${FIGHTER_ID}.json`,
  );
  const xfl = await fetchJson<import('@bvn/data').FighterPackage>(`${BAKED}/fighters/${FIGHTER_ID}.json`);
  // fire 元数据（切片 13-A3）：可选——角色无 fire 包时 bullet 走无动画生命周期
  const fires = await fetchJsonOptional<import('@bvn/data').FirePackage>(
    `${BAKED}/fires/fighter/${FIGHTER_ID}.json`,
  );
  const firesTable = fires?.fires;
  const def = compileFighterRuntime(runtime, xfl, undefined, firesTable);
  // 多形态（切片 10 万解切换）：编译全部含动画的形态，def 即 forms[0]
  const forms = compileFighterForms(runtime, xfl, firesTable);
  const mapPkg = await fetchJson<import('@bvn/data').MapPackage>(`${BAKED}/maps/${MAP_ID}.json`);
  const { stage, p1Spawn, p2Spawn } = compileMapStage(mapPkg);

  // 辅助定义（切片 12）：solo 模式注入；net 模式两端配置指纹需一致，暂不注入
  const assistXfl = await fetchJson<import('@bvn/data').AssistantPackage>(
    `${BAKED}/assistants/${ASSIST_ID}.json`,
  );
  const assistRuntime = await fetchJson<import('@bvn/data').RuntimeFighterPackage>(
    `${BAKED}/assistants-runtime/${ASSIST_ID}.json`,
  );
  const assistFires = await fetchJsonOptional<import('@bvn/data').FirePackage>(
    `${BAKED}/fires/assister/${ASSIST_ID}.json`,
  );
  const assistDef = compileAssistant(assistXfl, assistRuntime, assistFires?.fires);

  const makeSim = (training: boolean): Sim =>
    new Sim({
      seed: NET_SEED,
      stage,
      training,
      fighters: [
        {
          id: 1, x: p1Spawn?.x ?? 300, y: p1Spawn?.y ?? stage.groundY, def, forms,
          ...(training ? { assistId: ASSIST_ID } : {}),
        },
        {
          id: 2, x: p2Spawn?.x ?? 700, y: p2Spawn?.y ?? stage.groundY, def, forms,
          ...(training ? { assistId: ASSIST_ID } : {}),
        },
      ],
      ...(training ? { assistants: { [ASSIST_ID]: assistDef } } : {}),
    });

  // 渲染装配
  const renderer = new BattleRenderer(app);
  await renderer.load({
    baseUrl: ASSETS,
    fighters: [
      { slot: 1, atlasId: FIGHTER_ID, formIndex: def.formIndex },
      { slot: 2, atlasId: FIGHTER_ID, formIndex: def.formIndex },
    ],
    ...(netRole === null
      ? { assisters: [{ ownerId: 1, atlasId: ASSIST_ID }, { ownerId: 2, atlasId: ASSIST_ID }] }
      : {}),
    mapAtlasId: MAP_ID,
    mapBottomOffset: mapPkg.bottomOffset,
    mapBottom: mapPkg.bottom,
    fireAtlasIds: {
      ...(fires ? { fighter: FIGHTER_ID } : {}),
      ...(assistFires ? { assister: ASSIST_ID } : {}),
    },
  });

  const TICK_MS = 1000 / 60;
  let acc = 0;
  let last = performance.now();
  let sim: Sim;
  let inputSource: InputSource;

  if (netRole === null) {
    // —— solo：训练模式，键盘源，R 重置 ——
    sim = makeSim(true);
    inputSource = new KeyboardSource(keymap);
    renderer.setHint('A/D 移动  W跳  S防御  J攻击  L瞬步  U技  I必杀  O召唤辅助  R重置');
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyR') sim = makeSim(true);
    });
    let nextTick = 0;
    app.ticker.add(() => {
      const now = performance.now();
      acc += Math.min(now - last, 100);
      last = now;
      let stepped = false;
      while (acc >= TICK_MS) {
        const f = inputSource.frame(nextTick);
        if (!f) break; // 键盘源恒非 null，类型完备性保护
        const snap = sim.tick({ p1: f.p1, p2: f.p2 });
        renderer.onSnapshot(snap);
        nextTick++;
        acc -= TICK_MS;
        stepped = true;
      }
      if (stepped || acc > 0) renderer.update(acc);
    });
  } else {
    // —— net：lockstep 联机（房间服务器 create/join，局域网两机或同机双窗口） ——
    // ?mode=net&action=create            开新房（P1），房间码显示在提示里
    // ?mode=net&action=join&room=ABCD    加入房间（P2）
    sim = makeSim(false);
    const action = params.get('action') === 'join' ? 'join' : 'create';
    const joinRoom = params.get('room') ?? undefined;
    if (action === 'join' && !joinRoom) throw new Error('join 需要 &room=房间码');
    const runningHint = () => `房间 ${currentRoom} —— 联机 P${player}（延迟 ${INPUT_DELAY} 帧）`;
    let currentRoom = joinRoom ?? '…';
    let player: 1 | 2 = action === 'create' ? 1 : 2;

    renderer.setHint(action === 'create' ? '创建房间中…' : `加入房间 ${joinRoom}…`);
    const socket = new WebSocket(netServer);
    await new Promise<void>((res, rej) => {
      socket.addEventListener('open', () => res(), { once: true });
      socket.addEventListener('error', () => rej(new Error('无法连接房间服务器')), { once: true });
    });
    let peerLost = false;
    const { client } = await startSession(socket as unknown as WsLike, {
      action,
      room: joinRoom,
      configHash: makeConfigHash({
        seed: NET_SEED,
        stage,
        fighters: [FIGHTER_ID, FIGHTER_ID],
      }),
      onWelcome: (p, room) => {
        player = p;
        currentRoom = room;
        renderer.setHint(`房间 ${room} —— 你是 P${p}，等待对手…`);
      },
      onDesync: (tick, a, b) => renderer.setHint(`失步！tick ${tick}（${a} vs ${b}）`),
      onPeerLost: () => {
        peerLost = true;
        renderer.setHint('对端断开——冻结等待（对手回到房间可继续）');
      },
      onConfigMismatch: () => renderer.setHint('配置不一致：两端地图/角色/种子必须相同'),
    });
    client.prime(maskFor(keymap));
    renderer.setHint(runningHint());

    let nextTick = 0;
    let stalledSince = -1;
    app.ticker.add(() => {
      const now = performance.now();
      acc += Math.min(now - last, 100);
      last = now;
      let stepped = false;
      while (acc >= TICK_MS) {
        const f = client.frame(nextTick);
        if (!f) break; // 远端输入未到：本帧停步等待（lockstep 减速语义）
        const snap = sim.tick(f);
        client.afterTick(snap.tick, snap.hash);
        client.poll(maskFor(keymap));
        nextTick++;
        stepped = true;
      }
      // 停步看门狗：>5s 无进展提示可能断线（断线处理 = 冻结等待，判负归阶段 4）
      if (!stepped && nextTick > 0 && !peerLost) {
        if (stalledSince < 0) stalledSince = now;
        else if (now - stalledSince > 5000) renderer.setHint('等待对手输入…（对手可能卡顿或已断线）');
      } else {
        if (stalledSince >= 0 && !peerLost) renderer.setHint(runningHint());
        stalledSince = -1;
      }
      if (stepped || acc > 0) renderer.update(acc);
    });
  }
}

void boot();
