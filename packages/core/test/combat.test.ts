import { describe, expect, it } from 'vitest';
import {
  ActionState,
  Btn,
  Sim,
  type FighterDef,
  type SimConfig,
  type SimEvent,
  type SimState,
  type AreaRect,
} from '../src/index.js';

/**
 * 切片 5 战斗机制测试：防御/破防/背刺/瞬步/技/必杀/连段槽/训练模式。
 * 手工 def（30Hz 帧布局）：站立 1-9、走 10-33、砍1 55-71（k1atm 58-59）、
 * 砍2 261-277、防御 143-148、防御恢复 149-160、瞬步 161-180、
 * 招1 181-210（zh1atm 185-186）、必杀 211-260。
 */

const HIT_K1 = { power: 30, hitType: 1, hitx: 3, hity: 0, hurtTime: 300, hurtType: 0, isBreakDef: false };

function makeDef(): FighterDef {
  const labels: FighterDef['labels'] = {
    站立: { index: 0, duration: 9 },
    走: { index: 9, duration: 24 },
    起跳: { index: 33, duration: 5 },
    跳中: { index: 38, duration: 6 },
    落: { index: 44, duration: 6 },
    落地: { index: 50, duration: 4 },
    砍1: { index: 54, duration: 17 },
    被打: { index: 71, duration: 8 },
    击飞: { index: 79, duration: 10 },
    击飞_倒: { index: 89, duration: 9 },
    起身: { index: 98, duration: 9 },
    失败: { index: 122, duration: 20 },
    防御: { index: 142, duration: 6 },
    防御恢复: { index: 148, duration: 12 },
    瞬步: { index: 160, duration: 20 },
    招1: { index: 180, duration: 30 },
    必杀: { index: 210, duration: 50 },
    砍2: { index: 260, duration: 17 },
  };
  const areas: FighterDef['areas'] = {};
  for (let fr = 1; fr <= 280; fr++) {
    const list: AreaRect[] = [{ name: 'bdmn', x: -10, y: -40, w: 20, h: 40 }];
    if (fr === 58 || fr === 59) list.push({ name: 'k1atm', x: 10, y: -40, w: 30, h: 30 });
    if (fr === 185 || fr === 186) list.push({ name: 'zh1atm', x: 10, y: -40, w: 30, h: 30 });
    areas[fr] = list;
  }
  return {
    id: 'test',
    formIndex: 0,
    speed: 6,
    jumpPower: 15,
    heavy: 3,
    actions: {
      k1: { ...HIT_K1 },
      k2: { ...HIT_K1 },
      zh1: { ...HIT_K1 },
      bs: { power: 100, hitType: 5, hitx: 10, hity: 0, hurtTime: 0, hurtType: 1, isBreakDef: false },
    },
    labels,
    areas,
    totalFrames: 280,
    // 砍1 第 57 帧改写攻击槽为 砍2（连段；对照原版 ichigo 砍1@134 帧 setAttack）
    triggers: [{ frame: 57, target: 'mc', op: 'setAttack', args: ['砍2'] }],
    attackLabels: { k1: '砍1', k2: '砍2', zh1: '招1', bs: '必杀' },
  };
}

function makeConfig(opts: { p2x?: number; training?: boolean } = {}): SimConfig {
  const def = makeDef();
  return {
    seed: 1,
    stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
    fighters: [
      { id: 1, x: 100, def },
      { id: 2, x: opts.p2x ?? 130, def },
    ],
    ...(opts.training ? { training: true } : {}),
  };
}

interface PlayResult {
  sim: Sim;
  events: SimEvent[];
  snaps: { tick: number; state: SimState }[];
}

/** 驱动 sim：segments 逐段 [tick 数, p1 位图, p2 位图]，聚合事件与逐 tick 快照。 */
function play(sim: Sim, segments: [number, number, number][]): PlayResult {
  const events: SimEvent[] = [];
  const snaps: { tick: number; state: SimState }[] = [];
  for (const [frames, p1, p2] of segments) {
    for (let i = 0; i < frames; i++) {
      const snap = sim.tick({ p1, p2 });
      events.push(...snap.events);
      snaps.push({ tick: snap.tick, state: snap.state });
    }
  }
  return { sim, events, snaps };
}

function mutated(sim: Sim, mutate: (s: SimState) => void, opts?: { training?: boolean }): Sim {
  const state = JSON.parse(sim.serializeState()) as SimState;
  mutate(state);
  return Sim.fromState(state, sim.getDefEntries(), opts);
}

/** 找到目标首次受伤（hp < 初始 1000）的快照。 */
function firstHurtSnap(res: PlayResult, id: number): { tick: number; state: SimState } {
  const snap = res.snaps.find((s) => s.state.fighters.find((f) => f.id === id)!.hp < 1000);
  if (!snap) throw new Error('目标从未受伤');
  return snap;
}

describe('防御', () => {
  it('按住 ↓ 进入防御，命中只削 5% 血 + 能量损耗，不进受击态', () => {
    const res = play(new Sim(makeConfig()), [
      [1, Btn.attack, Btn.down],
      [30, 0, Btn.down],
    ]);
    const hit = firstHurtSnap(res, 2);
    const p2 = hit.state.fighters[1]!;
    expect(p2.actionState).toBe(ActionState.DEFENCE_ING);
    expect(p2.hp).toBeCloseTo(1000 - 30 * 0.05, 6); // DEFENSE_LOSE_HP_RATE
    expect(p2.energy).toBe(100 - Math.min(50, Math.floor(30 / 5))); // 94
    expect(res.events.some((e) => e.type === 'fighter:guard')).toBe(true);
    expect(res.events.some((e) => e.type === 'fighter:guardBreak')).toBe(false);
  });

  it('防御者背对攻击者 → 防御无效（背刺，全额伤害 + 受击）', () => {
    const res = play(new Sim(makeConfig()), [
      [5, 0, Btn.down | Btn.right], // p2 防御并转向右（背对左侧攻击者）
      [1, Btn.attack, Btn.down],
      [10, 0, Btn.down],
    ]);
    const hit = firstHurtSnap(res, 2);
    const p2 = hit.state.fighters[1]!;
    expect(p2.hp).toBe(1000 - 30); // 全额
    expect(p2.actionState).toBe(ActionState.HURT_ING);
    expect(res.events.some((e) => e.type === 'fighter:guard')).toBe(false);
  });

  it('能量不足 → 破防：削血 1/10 + 强制受击', () => {
    let sim = new Sim(makeConfig());
    sim = mutated(sim, (s) => {
      // 1 而非 5：防御中能量仍以 0.4/tick 回充，5 会在命中前回充越过阈值 6
      s.fighters[1]!.energy = 1; // drain = min(50, 30/5) = 6 > 1
    });
    const res = play(sim, [
      [1, Btn.attack, Btn.down],
      [10, 0, Btn.down],
    ]);
    const hit = firstHurtSnap(res, 2);
    const p2 = hit.state.fighters[1]!;
    expect(res.events.some((e) => e.type === 'fighter:guardBreak')).toBe(true);
    expect(p2.hp).toBeCloseTo(1000 - 30 * 0.05 - 30 / 10, 6);
    expect(p2.actionState).toBe(ActionState.HURT_ING);
    expect(p2.energy).toBe(0);
    expect(p2.energyOverload).toBe(true);
  });

  it('松开 ↓ 退出防御进入 防御恢复', () => {
    const res = play(new Sim(makeConfig()), [
      [5, 0, Btn.down],
      [1, 0, 0], // 松开
    ]);
    const p2 = res.snaps.at(-1)!.state.fighters[1]!;
    expect(p2.actionState).toBe(ActionState.NORMAL);
    expect(p2.actLabel).toBe('防御恢复');
  });
});

describe('瞬步', () => {
  it('耗能量 20（可透支），DASH_ING 且不可被命中，结束恢复', () => {
    const res = play(new Sim(makeConfig({ p2x: 500 })), [
      [1, Btn.dash, 0],
      [2, 0, 0],
    ]);
    let p1 = res.snaps.at(-1)!.state.fighters[0]!;
    expect(p1.actionState).toBe(ActionState.DASH_ING);
    expect(p1.energy).toBe(80);
    expect(p1.isAllowBeHit).toBe(false);
    expect(p1.actLabel).toBe('瞬步');
    // 瞬步标签 20 帧（40 tick）播完 → endAction → NORMAL + 可被命中
    play(res.sim, [[45, 0, 0]]);
    p1 = getFighter(res.sim, 1);
    expect(p1.actionState).toBe(ActionState.NORMAL);
    expect(p1.isAllowBeHit).toBe(true);
  });

  it('能量透支：energy=10 也能瞬步（扣到 0 + 过载）', () => {
    let sim = new Sim(makeConfig({ p2x: 500 }));
    sim = mutated(sim, (s) => {
      s.fighters[0]!.energy = 10;
    });
    const res = play(sim, [
      [1, Btn.dash, 0],
      [1, 0, 0],
    ]);
    const p1 = res.snaps.at(-1)!.state.fighters[0]!;
    expect(p1.actionState).toBe(ActionState.DASH_ING);
    expect(p1.energy).toBe(0);
    expect(p1.energyOverload).toBe(true);
  });

  it('过载状态下不能透支瞬步', () => {
    let sim = new Sim(makeConfig({ p2x: 500 }));
    sim = mutated(sim, (s) => {
      s.fighters[0]!.energy = 10;
      s.fighters[0]!.energyOverload = true;
    });
    const res = play(sim, [
      [1, Btn.dash, 0],
      [1, 0, 0],
    ]);
    expect(res.snaps.at(-1)!.state.fighters[0]!.actionState).not.toBe(ActionState.DASH_ING);
  });
});

describe('技 / 必杀', () => {
  it('技能键 → 招1（SKILL_ING，无消耗）', () => {
    const res = play(new Sim(makeConfig({ p2x: 500 })), [[2, Btn.skill, 0]]);
    const p1 = res.snaps.at(-1)!.state.fighters[0]!;
    expect(p1.actionState).toBe(ActionState.SKILL_ING);
    expect(p1.actLabel).toBe('招1');
    expect(p1.attackId).toBe('zh1');
  });

  it('必杀无气不发动；气够 → BISHA_ING 扣 100 气', () => {
    let sim = new Sim(makeConfig({ p2x: 500 }));
    // 按住 superSkill 2 tick 但 qi=0 不发动
    let res = play(sim, [[2, Btn.superSkill, 0]]);
    expect(res.snaps.at(-1)!.state.fighters[0]!.actionState).toBe(ActionState.NORMAL); // qi=0
    sim = mutated(sim, (s) => {
      s.fighters[0]!.qi = 100;
    });
    // 必须松开一拍再按：fromState 恢复 prev input，按住态不构成新的按下边沿
    res = play(sim, [
      [1, 0, 0],
      [2, Btn.superSkill, 0],
    ]);
    const p1 = res.snaps.at(-1)!.state.fighters[0]!;
    expect(p1.actionState).toBe(ActionState.BISHA_ING);
    expect(p1.actLabel).toBe('必杀');
    expect(p1.qi).toBe(0);
  });
});

describe('连段（动作槽）', () => {
  it('砍1 时间轴 setAttack 触发后，再按攻击接 砍2', () => {
    const res = play(new Sim(makeConfig({ p2x: 500 })), [
      [1, Btn.attack, 0],
      [6, 0, 0],
    ]);
    // 触发帧 57（起手后第 4 tick 采样）→ 槽已改写
    expect(res.snaps.at(-1)!.state.fighters[0]!.slots.attack).toBe('砍2');
    play(res.sim, [
      [1, Btn.attack, 0],
      [2, 0, 0],
    ]);
    const p1 = getFighter(res.sim, 1);
    expect(p1.actLabel).toBe('砍2');
    expect(p1.attackId).toBe('k2');
  });

  it('endAction 后动作槽重填默认值', () => {
    const res = play(new Sim(makeConfig({ p2x: 500 })), [
      [1, Btn.attack, 0],
      [60, 0, 0],
    ]);
    const p1 = res.snaps.at(-1)!.state.fighters[0]!;
    expect(p1.slots.attack).toBe('砍1');
  });
});

describe('训练模式', () => {
  it('受击不 KO（血保 1）并恒定回复', () => {
    let sim = new Sim(makeConfig({ training: true }));
    sim = mutated(sim, (s) => {
      s.fighters[1]!.hp = 500;
    }, { training: true });
    const res = play(sim, [
      [1, Btn.attack, 0],
      [40, 0, 0],
      [1, Btn.attack, 0],
      [40, 0, 0],
    ]);
    const last = res.snaps.at(-1)!.state.fighters[1]!;
    expect(last.hp).toBeGreaterThan(0);
    expect(last.actionState).not.toBe(ActionState.DEAD);
    expect(res.events.some((e) => e.type === 'fighter:ko')).toBe(false);
  });
});

/** 从 sim 当前状态取 fighter（serializeState 保真）。 */
function getFighter(sim: Sim, id: number): SimState['fighters'][number] {
  const state = JSON.parse(sim.serializeState()) as SimState;
  return state.fighters.find((f) => f.id === id)!;
}
