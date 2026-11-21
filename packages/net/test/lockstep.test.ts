/**
 * lockstep 联调测试（切片 6 门禁）：
 *  1. 双客户端经 LoopbackTransport 对跑剧本 —— 两端 finalHash 相等，
 *     且等于单机直跑同一输入的 finalHash（证明 lockstep 抽象零漂移）；
 *  2. 停步语义：远端输入未到时 frame 返回 null（画面减速等待）；
 *  3. 失步检测：两端状态不同 → onDesync 触发；
 *  4. 配置错配：hello 指纹不一致 → onConfigMismatch 触发；
 *  5. ws 端到端：spawn 真实 relay 进程，两个 node ws 客户端对跑同一剧本
 *     （异步送达路径，含停步等待）。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  Btn,
  createDefaultConfig,
  ScriptedInputSource,
  Sim,
  type ButtonMask,
} from '@bvn/core';
import {
  INPUT_DELAY,
  LockstepClient,
  makeConfigHash,
  loopbackPair,
  startSession,
  RoomJoinError,
} from '../src/index.js';
import type { WsLike } from '../src/index.js';

// 与 tools/replay 剧本同构的程序段（Btn: right=8, down=2, attack=16, jump=32）
const PROGRAM = [
  { frames: 30, p1: Btn.right, p2: 0 },
  { frames: 10, p1: Btn.right | Btn.attack, p2: Btn.jump },
  { frames: 40, p1: 0, p2: Btn.down },
  { frames: 15, p1: Btn.left, p2: Btn.down | Btn.attack },
  { frames: 25, p1: 0, p2: Btn.left | Btn.jump },
] as const;
const TOTAL_TICKS = PROGRAM.reduce((n, s) => n + s.frames, 0);

function scripted(): ScriptedInputSource {
  return new ScriptedInputSource(PROGRAM);
}

/** 单机直跑：lockstep 结果的黄金参照。 */
function runDirect(): string {
  const sim = new Sim(createDefaultConfig(1));
  const src = scripted();
  let hash = '';
  for (let t = 0; t < TOTAL_TICKS; t++) {
    hash = sim.tick(src.frame(t)).hash;
  }
  return hash;
}

const CFG_HASH = makeConfigHash({
  seed: 1,
  stage: createDefaultConfig(1).stage,
  fighters: ['ichigo', 'ichigo'],
});

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * 双端同步驱动（loopback：消息同步送达，一轮一 tick）。
 * 与 app 主循环同构：prefill（等价 prime 的逐 tick 版）→ frame → tick →
 * afterTick → poll（当前掩码存入 INPUT_DELAY 帧后的槽位）。
 */
function drivePair(
  ca: LockstepClient,
  cb: LockstepClient,
  simA: Sim,
  simB: Sim,
): [string, string] {
  const srcA = scripted();
  const srcB = scripted();
  const pa = (t: number): ButtonMask => srcA.frame(t).p1;
  const pb = (t: number): ButtonMask => srcB.frame(t).p2;
  ca.begin();
  cb.begin();
  for (let k = 0; k < INPUT_DELAY; k++) {
    ca.poll(pa(k));
    cb.poll(pb(k));
  }
  let hashA = '';
  let hashB = '';
  for (let t = 0; t < TOTAL_TICKS; t++) {
    const fa = ca.frame(t);
    const fb = cb.frame(t);
    if (!fa || !fb) throw new Error(`tick ${t} 输入未就绪（loopback 同步送达，不应停步）`);
    const sa = simA.tick(fa);
    ca.afterTick(sa.tick, sa.hash);
    ca.poll(pa(t + INPUT_DELAY));
    hashA = sa.hash;
    const sb = simB.tick(fb);
    cb.afterTick(sb.tick, sb.hash);
    cb.poll(pb(t + INPUT_DELAY));
    hashB = sb.hash;
  }
  return [hashA, hashB];
}

/**
 * 双端异步驱动（真实 ws：消息异步送达），停步时等待重试——
 * 同时覆盖了 frame()==null 的减速语义。
 */
async function drivePairAsync(
  ca: LockstepClient,
  cb: LockstepClient,
  simA: Sim,
  simB: Sim,
): Promise<[string, string]> {
  const srcA = scripted();
  const srcB = scripted();
  const pa = (t: number): ButtonMask => srcA.frame(t).p1;
  const pb = (t: number): ButtonMask => srcB.frame(t).p2;
  ca.begin();
  cb.begin();
  for (let k = 0; k < INPUT_DELAY; k++) {
    ca.poll(pa(k));
    cb.poll(pb(k));
  }
  let hashA = '';
  let hashB = '';
  for (let t = 0; t < TOTAL_TICKS; t++) {
    let fa = ca.frame(t);
    let fb = cb.frame(t);
    while (!fa || !fb) {
      await sleep(1);
      fa = ca.frame(t);
      fb = cb.frame(t);
    }
    const sa = simA.tick(fa);
    ca.afterTick(sa.tick, sa.hash);
    ca.poll(pa(t + INPUT_DELAY));
    hashA = sa.hash;
    const sb = simB.tick(fb);
    cb.afterTick(sb.tick, sb.hash);
    cb.poll(pb(t + INPUT_DELAY));
    hashB = sb.hash;
  }
  return [hashA, hashB];
}

describe('lockstep（loopback 同进程）', () => {
  it('双端对跑剧本：finalHash 一致、无失步、等于单机直跑', () => {
    const [ta, tb] = loopbackPair();
    const desyncs: number[] = [];
    const ca = new LockstepClient({
      transport: ta,
      localPlayer: 1,
      configHash: CFG_HASH,
      onDesync: (tick) => desyncs.push(tick),
    });
    const cb = new LockstepClient({
      transport: tb,
      localPlayer: 2,
      configHash: CFG_HASH,
    });
    ca.begin();
    cb.begin();
    const [hashA, hashB] = drivePair(ca, cb, new Sim(createDefaultConfig(1)), new Sim(createDefaultConfig(1)));
    expect(hashA).toBe(hashB);
    expect(hashA).toBe(runDirect());
    expect(desyncs).toEqual([]);
  });

  it('远端输入未到 → frame 返回 null（停步语义）', () => {
    const [ta, tb] = loopbackPair();
    const ca = new LockstepClient({ transport: ta, localPlayer: 1 });
    const cb = new LockstepClient({ transport: tb, localPlayer: 2 });
    ca.begin();
    cb.begin();
    const srcA = scripted();
    const srcB = scripted();
    // 双端预填 0..2（等价 prime）
    for (let k = 0; k < INPUT_DELAY; k++) {
      ca.poll(srcA.frame(k).p1);
      cb.poll(srcB.frame(k).p2);
    }
    // A 独自推进：本地输入有前瞻（poll 采样槽 t+3），但远端只填了 0..2 → 第 3 tick 起停步
    const simA = new Sim(createDefaultConfig(1));
    let done = 0;
    for (let t = 0; t < 10; t++) {
      const f = ca.frame(t);
      if (!f) break;
      const snap = simA.tick(f);
      ca.afterTick(snap.tick, snap.hash);
      ca.poll(srcA.frame(t + INPUT_DELAY).p1);
      done++;
    }
    expect(done).toBe(3);
    // 对端推进后停步解除
    const simB = new Sim(createDefaultConfig(1));
    for (let t = 0; t < 4; t++) {
      const f = cb.frame(t);
      if (!f) break;
      const snap = simB.tick(f);
      cb.afterTick(snap.tick, snap.hash);
      cb.poll(srcB.frame(t + INPUT_DELAY).p2);
    }
    expect(ca.frame(3)).not.toBeNull();
  });

  it('两端状态失步 → onDesync 触发', () => {
    const [ta, tb] = loopbackPair();
    const desyncs: number[] = [];
    const ca = new LockstepClient({
      transport: ta,
      localPlayer: 1,
      onDesync: (tick) => desyncs.push(tick),
    });
    const cb = new LockstepClient({ transport: tb, localPlayer: 2 });
    ca.begin();
    cb.begin();
    // B 用不同 seed 的 sim —— 状态哈希必然不同
    drivePair(ca, cb, new Sim(createDefaultConfig(1)), new Sim(createDefaultConfig(2)));
    expect(desyncs.length).toBeGreaterThan(0);
  });

  it('配置指纹不一致 → onConfigMismatch 触发', () => {
    const [ta, tb] = loopbackPair();
    const aBad: string[] = [];
    const ca = new LockstepClient({
      transport: ta,
      localPlayer: 1,
      configHash: 'aaaa1111',
      onConfigMismatch: (l) => aBad.push(l),
    });
    const cb = new LockstepClient({
      transport: tb,
      localPlayer: 2,
      configHash: 'bbbb2222',
    });
    ca.begin();
    cb.begin();
    expect(aBad).toEqual(['aaaa1111']);
  });
});

describe('房间服务器（真实进程端到端）', () => {
  /** spawn room-server，等 stdout 端口号 */
  async function spawnServer(): Promise<{ proc: ReturnType<typeof spawn>; port: number }> {
    const serverPath = fileURLToPath(new URL('../../../server/room-server.mjs', import.meta.url));
    const proc = spawn(process.execPath, [serverPath], {
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const port = await new Promise<number>((res, rej) => {
      let out = '';
      proc.stdout!.on('data', (d: Buffer) => {
        out += d.toString();
        const m = out.match(/room-server listening (\d+)/);
        if (m) res(Number(m[1]));
      });
      proc.on('exit', (code) => rej(new Error(`room-server 提前退出：${code}`)));
    });
    return { proc, port };
  }

  function openSocket(port: number): Promise<WebSocket> {
    return new Promise((res, rej) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}`);
      sock.on('open', () => res(sock));
      sock.on('error', rej);
    });
  }

  it(
    'create + join 对跑剧本：finalHash 一致且等于单机直跑',
    { timeout: 30_000 },
    async () => {
      const { proc, port } = await spawnServer();
      try {
        const sockA = await openSocket(port);
        const welcomed: string[] = [];
        // 注意：startSession 要等到 start 广播才 resolve，而 start 需要双方
        // hello——create/join 必须并发进行，不能先 await A 再连 B
        const pA = startSession(sockA as unknown as WsLike, {
          action: 'create',
          configHash: CFG_HASH,
          onWelcome: (_p, room) => welcomed.push(room),
        });
        const sockB = await openSocket(port);
        const joinWhenReady = async () => {
          while (welcomed.length === 0) await sleep(2);
          return startSession(sockB as unknown as WsLike, {
            action: 'join',
            room: welcomed[0]!,
            configHash: CFG_HASH,
          });
        };
        const [sa, sb] = await Promise.all([pA, joinWhenReady()]);
        expect(sb.player).toBe(2);
        expect(welcomed).toHaveLength(1);
        expect(welcomed[0]!).toMatch(/^\d{6}$/);

        const [hashA, hashB] = await drivePairAsync(
          sa.client,
          sb.client,
          new Sim(createDefaultConfig(1)),
          new Sim(createDefaultConfig(1)),
        );
        expect(hashA).toBe(hashB);
        expect(hashA).toBe(runDirect());
        sockA.close();
        sockB.close();
      } finally {
        proc.kill();
      }
    },
  );

  it('加入不存在的房间 → RoomJoinError(room-not-found)', { timeout: 30_000 }, async () => {
    const { proc, port } = await spawnServer();
    try {
      const sock = await openSocket(port);
      await expect(
        startSession(sock as unknown as WsLike, { action: 'join', room: 'ZZZZ' }),
      ).rejects.toBeInstanceOf(RoomJoinError);
      sock.close();
    } finally {
      proc.kill();
    }
  });

  it('房间满员 → RoomJoinError(room-full)', { timeout: 30_000 }, async () => {
    const { proc, port } = await spawnServer();
    try {
      const sockA = await openSocket(port);
      const welcomed: string[] = [];
      const pA = startSession(sockA as unknown as WsLike, {
        action: 'create',
        configHash: CFG_HASH,
        onWelcome: (_p, room) => welcomed.push(room),
      });
      const sockB = await openSocket(port);
      const joinWhenReady = async () => {
        while (welcomed.length === 0) await sleep(2);
        return startSession(sockB as unknown as WsLike, {
          action: 'join',
          room: welcomed[0]!,
          configHash: CFG_HASH,
        });
      };
      const [, { room }] = await Promise.all([pA, joinWhenReady()]);
      // 两人已就位并 start；第三个连接应被拒
      const sockC = await openSocket(port);
      await expect(
        startSession(sockC as unknown as WsLike, { action: 'join', room }),
      ).rejects.toMatchObject({ code: 'room-full' });
      sockA.close();
      sockB.close();
      sockC.close();
    } finally {
      proc.kill();
    }
  });
});
