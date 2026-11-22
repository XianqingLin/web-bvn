/**
 * rollback 联调测试（2026-11-22 立项门禁）：
 *  1. 零延迟网络：双端 finalHash 相等且等于单机直跑，且零回滚（预测从未出错）；
 *  2. 延迟网络（单程 6 tick）：预测出错 → 回滚纠正，两端最终收敛到与单机直跑
 *     完全一致的状态；纠正段事件恒空（表现不重放）；tick 恰好交付一次；
 *  3. 失步检测：两端 sim 种子不同 → 确认槽位哈希不等 → onDesync 触发；
 *  4. 对端静默超时：远端长期不发送 → 静默超时冻结（onPeerLost + step 返回 null）；
 *  5. ws 端到端：真实 relay 进程，两客户端对跑同一剧本（input/hash 透传兼容，
 *     服务器零改动），finalHash 相等且等于单机直跑。
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
  joinRoom,
  makeConfigHash,
  rollbackStart,
  RollbackSession,
  type NetMessage,
  type RollbackStep,
  type Transport,
  type WsLike,
} from '../src/index.js';

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

/** 单机直跑：rollback 结果的黄金参照。 */
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
 * 延迟网络对（测试专用）：单向时延 = delayTicks 个 tick。消息按发送序、
 * 按 due tick 批量送达；step 内新发的消息（如确认哈希）同样入队延迟。
 */
function makeDelayedSides(delayTicks: number) {
  let nowTick = 0;
  const qab: { msg: NetMessage; due: number }[] = [];
  const qba: { msg: NetMessage; due: number }[] = [];
  let cbA: ((m: NetMessage) => void) | null = null;
  let cbB: ((m: NetMessage) => void) | null = null;
  const ta: Transport = {
    send: (m) => qab.push({ msg: m, due: nowTick + delayTicks }),
    onMessage: (cb) => {
      cbA = cb;
    },
    onClose: () => {},
    close: () => {},
  };
  const tb: Transport = {
    send: (m) => qba.push({ msg: m, due: nowTick + delayTicks }),
    onMessage: (cb) => {
      cbB = cb;
    },
    onClose: () => {},
    close: () => {},
  };
  const flush = (): void => {
    const qs: [{ msg: NetMessage; due: number }[], (() => ((m: NetMessage) => void) | null)][] = [
      [qab, () => cbB],
      [qba, () => cbA],
    ];
    for (const [q, target] of qs) {
      for (let i = 0; i < q.length; ) {
        if (q[i]!.due <= nowTick) {
          const { msg } = q.splice(i, 1)[0]!;
          target()?.(msg);
        } else {
          i++;
        }
      }
    }
  };
  return {
    ta,
    tb,
    setTick: (t: number) => {
      nowTick = t;
    },
    flush,
  };
}

/** 交付账本：delivered = 正常消费的快照 tick 集；corrections 统计与事件审计。 */
interface Ledger {
  deliveredTicks: number[];
  rollbackFroms: number[];
  correctionCount: number;
  correctionEvents: number;
  eventKeys: string[];
}

function ledger(): Ledger {
  return {
    deliveredTicks: [],
    rollbackFroms: [],
    correctionCount: 0,
    correctionEvents: 0,
    eventKeys: [],
  };
}

function consume(s: RollbackStep, led: Ledger): void {
  if (s.rolledBackFrom !== null) led.rollbackFroms.push(s.rolledBackFrom);
  for (const c of s.corrections) {
    led.correctionCount += 1;
    led.correctionEvents += c.events.length;
  }
  led.deliveredTicks.push(s.snapshot.tick);
  for (const ev of s.snapshot.events) {
    led.eventKeys.push(`${ev.tick}:${ev.type}`);
  }
}

describe('rollback（延迟网络模拟）', () => {
  it('近零延迟（送达滞后一拍）：收敛到单机直跑', () => {
    const net = makeDelayedSides(0);
    const a = new RollbackSession({
      transport: net.ta,
      sim: new Sim(createDefaultConfig(1)),
      localPlayer: 1,
      configHash: CFG_HASH,
    });
    const b = new RollbackSession({
      transport: net.tb,
      sim: new Sim(createDefaultConfig(1)),
      localPlayer: 2,
      configHash: CFG_HASH,
    });
    a.begin();
    b.begin();
    const srcA = scripted();
    const srcB = scripted();
    const ledA = ledger();
    const ledB = ledger();
    let hashA = '';
    let hashB = '';
    for (let t = 0; t < TOTAL_TICKS; t++) {
      net.setTick(t);
      net.flush();
      const sa = a.step(srcA.frame(t).p1);
      const sb = b.step(srcB.frame(t).p2);
      if (!sa || !sb) throw new Error(`tick ${t} 停步（预测兜底下不应停步）`);
      consume(sa, ledA);
      consume(sb, ledB);
      hashA = sa.snapshot.hash;
      hashB = sb.snapshot.hash;
    }
    expect(hashA).toBe(hashB);
    expect(hashA).toBe(runDirect());
  });

  it('单程 6 tick 延迟：预测出错 → 回滚纠正 → 收敛到单机直跑', () => {
    const net = makeDelayedSides(6);
    const a = new RollbackSession({
      transport: net.ta,
      sim: new Sim(createDefaultConfig(1)),
      localPlayer: 1,
      configHash: CFG_HASH,
    });
    const b = new RollbackSession({
      transport: net.tb,
      sim: new Sim(createDefaultConfig(1)),
      localPlayer: 2,
      configHash: CFG_HASH,
    });
    a.begin();
    b.begin();
    const srcA = scripted();
    const srcB = scripted();
    const ledA = ledger();
    const ledB = ledger();
    let hashA = '';
    let hashB = '';
    for (let t = 0; t < TOTAL_TICKS; t++) {
      net.setTick(t);
      net.flush();
      const sa = a.step(srcA.frame(t).p1);
      const sb = b.step(srcB.frame(t).p2);
      if (!sa || !sb) throw new Error(`tick ${t} 停步（延迟网络在预测窗口内不应停步）`);
      consume(sa, ledA);
      consume(sb, ledB);
      hashA = sa.snapshot.hash;
      hashB = sb.snapshot.hash;
    }
    // 双端收敛且等于真实时间线（rollback 正确性的核心断言）
    expect(hashA).toBe(hashB);
    expect(hashA).toBe(runDirect());
    // 剧本里双方都有输入变化 → 两端都应发生过预测纠正
    expect(ledA.correctionCount).toBeGreaterThan(0);
    expect(ledB.correctionCount).toBeGreaterThan(0);
    // 纠正段事件恒空（表现不重放）；交付 tick 恰好一次且有序
    expect(ledA.correctionEvents).toBe(0);
    expect(ledB.correctionEvents).toBe(0);
    for (const led of [ledA, ledB]) {
      expect(new Set(led.deliveredTicks).size).toBe(led.deliveredTicks.length);
      expect(led.deliveredTicks).toEqual([...led.deliveredTicks].sort((x, y) => x - y));
      expect(led.deliveredTicks.length).toBe(TOTAL_TICKS);
    }
  });

  it('两端 sim 种子不同 → onDesync 触发', () => {
    const net = makeDelayedSides(4);
    const desyncs: number[] = [];
    const a = new RollbackSession({
      transport: net.ta,
      sim: new Sim(createDefaultConfig(1)),
      localPlayer: 1,
      configHash: CFG_HASH,
      hashStride: 10,
      onDesync: (tick) => desyncs.push(tick),
    });
    const b = new RollbackSession({
      transport: net.tb,
      sim: new Sim(createDefaultConfig(2)),
      localPlayer: 2,
      configHash: CFG_HASH,
      hashStride: 10,
      onDesync: (tick) => desyncs.push(tick),
    });
    a.begin();
    b.begin();
    const srcA = scripted();
    const srcB = scripted();
    for (let t = 0; t < TOTAL_TICKS; t++) {
      net.setTick(t);
      net.flush();
      const sa = a.step(srcA.frame(t).p1);
      const sb = b.step(srcB.frame(t).p2);
      if (!sa || !sb) throw new Error(`tick ${t} 停步`);
    }
    net.setTick(TOTAL_TICKS);
    net.flush();
    expect(desyncs.length).toBeGreaterThan(0);
  });

  it('对端静默超时 → 冻结（step 返回 null + onPeerLost）', async () => {
    const net = makeDelayedSides(0);
    // B 端不驱动（永不发送）：A 独自推进，超过静默超时后冻结
    const lost: number[] = [];
    const a = new RollbackSession({
      transport: net.ta,
      sim: new Sim(createDefaultConfig(1)),
      localPlayer: 1,
      configHash: CFG_HASH,
      peerTimeoutMs: 60,
      onPeerLost: () => lost.push(1),
    });
    a.begin();
    const srcA = scripted();
    let done = 0;
    for (let t = 0; t < 10; t++) {
      if (a.step(srcA.frame(t).p1) === null) break;
      done++;
    }
    await sleep(80); // 跨过 60ms 静默超时（对端始终沉默）
    expect(a.step(srcA.frame(done).p1)).toBeNull();
    expect(lost).toEqual([1]);
  });
});

describe('rollback（真实 relay 进程端到端）', () => {
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
    'create + join 对跑剧本：回滚收敛，finalHash 一致且等于单机直跑',
    { timeout: 30_000 },
    async () => {
      const { proc, port } = await spawnServer();
      try {
        const sockA = await openSocket(port);
        const sockB = await openSocket(port);
        let room = '';
        // joinRoom 的 welcome 回调拿房码；rollbackStart 等 start 广播——
        // create/join 必须并发（同 lockstep e2e 教训）
        const pA = (async () => {
          const { player } = await joinRoom(sockA as unknown as WsLike, 'create', undefined, (_p, r) => {
            room = r;
          });
          return rollbackStart(sockA as unknown as WsLike, player, {
            sim: new Sim(createDefaultConfig(1)),
            configHash: CFG_HASH,
          });
        })();
        const pB = (async () => {
          while (!room) await sleep(2);
          const { player } = await joinRoom(sockB as unknown as WsLike, 'join', room);
          return rollbackStart(sockB as unknown as WsLike, player, {
            sim: new Sim(createDefaultConfig(1)),
            configHash: CFG_HASH,
          });
        })();
        const [sa, sb] = await Promise.all([pA, pB]);
        expect(sa.player).toBe(1);
        expect(sb.player).toBe(2);
        expect(sa.session).toBeInstanceOf(RollbackSession);

        const srcA = scripted();
        const srcB = scripted();
        let hashA = '';
        let hashB = '';
        for (let t = 0; t < TOTAL_TICKS; t++) {
          let ra: RollbackStep | null = null;
          let rb: RollbackStep | null = null;
          while (ra === null || rb === null) {
            if (ra === null) ra = sa.session.step(srcA.frame(t).p1);
            if (rb === null) rb = sb.session.step(srcB.frame(t).p2);
            if (ra === null || rb === null) await sleep(1);
          }
          // rollback 恒不停步 → 上面 while 不 await；每 tick 让出事件循环，
          // 否则 socket 帧写不出（真实 app 每渲染帧天然让出，无此问题）
          await new Promise((r) => setImmediate(r));
          hashA = ra.snapshot.hash;
          hashB = rb.snapshot.hash;
        }
        expect(hashA).toBe(hashB);
        expect(hashA).toBe(runDirect());
        sockA.close();
        sockB.close();
      } finally {
        proc.kill();
      }
    },
  );
});
