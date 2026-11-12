import { describe, expect, it } from 'vitest';
import { Btn, Sim, type FighterDef, type SimEvent, type SimSnapshot } from '../src/index.js';

/**
 * 切片 22 机制测试：必杀/万解切人冻结锁（原版 EffectCtrler.bisha/wanKai 的
 * GameCtrler.pause 语义）。def 帧布局沿用切片 8/9 测试骨架：
 * 站立 0-9、走 9-33、必杀 210-260、万解 280-310。
 * 冻结语义：锁置位后全场停走（对手/计时），仅施法者时间轴 30Hz 推进；
 * endBisha/endWanKai 解锁；锁主脱战（收招/死亡）保护性解锁（防软锁）。
 * 注意：事件按 tick 发（bisha 在必杀进入后 ~2 tick 即到），跨 tick 收集。
 */

const HIT_K1 = {
  power: 30,
  hitType: 1,
  hitx: 3,
  hity: 0,
  hurtTime: 300,
  hurtType: 0,
  isBreakDef: false,
  isApplyG: true,
};

/** WAN_KAI_ING（def.ts ActionState；测试断言用） */
const WAN_KAI_ING = 50;

function makeDef(): FighterDef {
  const labels: FighterDef['labels'] = {
    站立: { index: 0, duration: 9 },
    走: { index: 9, duration: 24 },
    必杀: { index: 210, duration: 50 },
    万解: { index: 280, duration: 30 },
  };
  const areas: FighterDef['areas'] = {};
  for (let fr = 1; fr <= 310; fr++) {
    areas[fr] = [{ name: 'bdmn', x: -10, y: -40, w: 20, h: 40 }];
  }
  return {
    id: 'test',
    formIndex: 0,
    speed: 6,
    jumpPower: 15,
    heavy: 3,
    actions: { k1: { ...HIT_K1 } },
    labels,
    areas,
    attackLabels: { k1: '砍1' },
    triggers: [],
  };
}

function makeConfig(defs: FighterDef[], opts?: { p2x?: number; qi?: number[] }) {
  return {
    seed: 1,
    stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
    fighters: [
      { id: 1, x: 100, def: defs[0], qi: opts?.qi?.[0] ?? 0 },
      { id: 2, x: opts?.p2x ?? 300, def: defs[1] ?? defs[0], qi: opts?.qi?.[1] ?? 0 },
    ],
  };
}

/** 逐 tick 推进并累积快照（事件按 tick 发，跨 tick 收集）。 */
function collect(
  sim: Sim,
  n: number,
  input: (i: number) => number = () => 0,
): { snaps: SimSnapshot[]; events: SimEvent[] } {
  const snaps: SimSnapshot[] = [];
  const events: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    const s = sim.tick({ p1: input(i), p2: 0 });
    snaps.push(s);
    events.push(...s.events);
  }
  return { snaps, events };
}

function effectId(e: SimEvent): string | null {
  return e.type === 'effect' && typeof e.payload['id'] === 'string' ? e.payload['id'] : null;
}

describe('切片 22：必杀切人冻结锁', () => {
  it('bisha 置锁：对手冻结、施法者时间轴继续、endBisha 解锁', () => {
    const def = makeDef();
    // 切人演出段：212 bisha → 222 endBisha（30Hz 推进，冻结约 20 tick）
    def.triggers = [
      { frame: 212, target: 'effect', op: 'bisha', args: [false, 'Test_1'] },
      { frame: 222, target: 'effect', op: 'endBisha', args: [] },
    ];
    const sim = new Sim(makeConfig([def, makeDef()], { qi: [100] }));
    // 必杀键连按 12 tick 触发必杀（qi 门槛 100）+ 后续 40 tick 播完
    const { events } = collect(sim, 52, (i) => (i < 12 ? Btn.superSkill : 0));
    // 事件时序：bisha 先于 endBisha
    const ids = events.map(effectId);
    expect(ids).toContain('bisha');
    expect(ids).toContain('endBisha');
    expect(ids.indexOf('bisha')).toBeLessThan(ids.indexOf('endBisha'));
  });

  it('bisha 冻结窗口：对手位移停走、施法者 animFrame 推进、解锁恢复', () => {
    const def = makeDef();
    def.triggers = [
      { frame: 212, target: 'effect', op: 'bisha', args: [false, 'Test_1'] },
      { frame: 222, target: 'effect', op: 'endBisha', args: [] },
    ];
    const sim = new Sim(makeConfig([def, makeDef()], { qi: [100] }));
    const frozenX: number[] = [];
    const casterFrames: number[] = [];
    const locks: (string | null)[] = [];
    for (let i = 0; i < 52; i++) {
      const s = sim.tick({ p1: i < 12 ? Btn.superSkill : 0, p2: Btn.right });
      frozenX.push(s.state.fighters[1]!.x);
      casterFrames.push(s.state.fighters[0]!.animFrame);
      locks.push(
        s.state.cutinLock
          ? `${s.state.cutinLock.kind}:${s.state.cutinLock.type}`
          : null,
      );
    }
    // 锁曾置位且为 fighter:bisha
    expect(locks.some((l) => l === 'fighter:bisha')).toBe(true);
    const locked = locks
      .map((l, i) => [l, i] as const)
      .filter(([l]) => l !== null) as [string, number][];
    const first = locked[0]![1];
    const last = locked[locked.length - 1]![1];
    // 冻结窗口内对手 x 不动（stepInputs/物理停走）
    expect(new Set(frozenX.slice(first, last + 1)).size).toBe(1);
    // 施法者动画在冻结窗口内推进（30Hz）
    expect(Math.max(...casterFrames.slice(first, last + 1))).toBeGreaterThan(
      Math.min(...casterFrames.slice(first, last + 1)),
    );
    // 解锁后对手恢复移动（p2 仍按住右）
    const afterUnlock = frozenX.slice(last + 1);
    expect(afterUnlock.length).toBeGreaterThan(0);
    expect(new Set(afterUnlock).size).toBeGreaterThan(1);
    expect(locks.slice(last + 1).every((l) => l === null)).toBe(true);
  });

  it('bisha 事件 payload 带 owner/ownerKind/face', () => {
    const def = makeDef();
    def.triggers = [
      { frame: 212, target: 'effect', op: 'bisha', args: [true, 'Test_1'] },
      { frame: 222, target: 'effect', op: 'endBisha', args: [] },
    ];
    const sim = new Sim(makeConfig([def, makeDef()], { qi: [100] }));
    const { events } = collect(sim, 60, (i) => (i < 12 ? Btn.superSkill : 0));
    const bisha = events.find((e) => effectId(e) === 'bisha');
    expect(bisha).toBeDefined();
    expect(bisha!.payload['params']).toMatchObject({
      isSuper: true,
      face: 'Test_1',
      owner: 1,
      ownerKind: 'fighter',
    });
    const endBisha = events.find((e) => effectId(e) === 'endBisha');
    expect(endBisha).toBeDefined();
    // endBisha 到来后锁清除（快照级验证：解在 collect 覆盖的 60 tick 内）
    expect(sim.serializeState()).not.toContain('"cutinLock":{"kind"');
  });

  it('保护性解锁：语料缺 endBisha 时收招即解锁（防软锁）', () => {
    const def = makeDef();
    def.triggers = [{ frame: 212, target: 'effect', op: 'bisha', args: [false, null] }];
    const sim = new Sim(makeConfig([def, makeDef()], { qi: [100] }));
    let locked = false;
    let snap: SimSnapshot | null = null;
    for (let i = 0; i < 300; i++) {
      snap = sim.tick({ p1: i < 12 ? Btn.superSkill : 0, p2: 0 });
      if (snap.state.cutinLock !== null) locked = true;
      if (locked && snap.state.cutinLock === null) {
        // 必杀段 50 动画帧播尽收招回待机 → 解锁（必杀 211 起 30Hz×50 帧 < 300 tick）
        expect(snap.state.fighters[0]!.actionState).toBe(0);
        return;
      }
    }
    void snap;
    throw new Error('冻结锁未在收招后解除（软锁）');
  });

  it('万解：startWanKai 置锁冻结对手，endWanKai 解锁', () => {
    const def = makeDef();
    def.triggers = [
      { frame: 282, target: 'effect', op: 'startWanKai', args: ['Test_3'] },
      { frame: 292, target: 'effect', op: 'endWanKai', args: [] },
    ];
    const sim = new Sim(makeConfig([def, makeDef()], { qi: [300] }));
    // 万解进入：attack 缓冲 + jump 按住（machine.ts wankaiPress），qi 门槛 300
    const frozenX: number[] = [];
    const locks: (string | null)[] = [];
    let wankaiSeen = false;
    for (let i = 0; i < 160; i++) {
      const s = sim.tick({
        p1: (i < 12 ? Btn.attack : 0) | Btn.jump,
        p2: Btn.right,
      });
      if (s.state.fighters[0]!.actionState === WAN_KAI_ING) wankaiSeen = true;
      frozenX.push(s.state.fighters[1]!.x);
      locks.push(
        s.state.cutinLock
          ? `${s.state.cutinLock.kind}:${s.state.cutinLock.type}`
          : null,
      );
    }
    expect(wankaiSeen).toBe(true);
    expect(locks.some((l) => l === 'fighter:wanKai')).toBe(true);
    const lockedIdx = locks
      .map((l, i) => [l, i] as const)
      .filter(([l]) => l !== null) as [string, number][];
    const first = lockedIdx[0]![1];
    const last = lockedIdx[lockedIdx.length - 1]![1];
    // 冻结窗口内对手 x 不动
    expect(new Set(frozenX.slice(first, last + 1)).size).toBe(1);
    // endWanKai 后解锁
    expect(locks.slice(last + 1).every((l) => l === null)).toBe(true);
  });

  it('锁定期间 match 计时冻结', () => {
    const def = makeDef();
    def.triggers = [
      { frame: 212, target: 'effect', op: 'bisha', args: [false, null] },
      { frame: 222, target: 'effect', op: 'endBisha', args: [] },
    ];
    const sim = new Sim(makeConfig([def, makeDef()], { qi: [100] }));
    const framesDuring: number[] = [];
    let sawLock = false;
    for (let i = 0; i < 120; i++) {
      const s = sim.tick({ p1: i < 12 ? Btn.superSkill : 0, p2: 0 });
      if (s.state.cutinLock !== null) {
        sawLock = true;
        framesDuring.push(s.state.match.roundFrame);
      } else if (sawLock) {
        break;
      }
    }
    expect(sawLock).toBe(true);
    // 冻结窗口内 roundFrame 全等（计时停走）
    expect(new Set(framesDuring).size).toBe(1);
  });
});
