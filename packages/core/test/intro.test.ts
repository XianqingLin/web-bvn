import { describe, expect, it } from 'vitest';
import {
  Btn,
  Sim,
  ActionState,
  type FighterDef,
  type SimConfig,
  type SimSnapshot,
} from '../src/index.js';

/**
 * intro 切片机制测试：开局特写+语音演出（原版 GameStartCtrler.start1v1/
 * renderStart1v1 的 actionEnable=false 冻结语义）。
 * def 帧布局沿用切片 22 测试骨架：站立 0-9、走 9-33、开场 100-119。
 * 冻结语义：输入/物理/推挤/命中/回合计时停走，角色时间轴 30Hz 推进；
 * say 步等 开场 播完；skip = back 键 just-down（仅字样出场前）；
 * 缺 开场 标签跳过 say 步（原版软锁的有意识偏离）。
 */

const INTRO_ING = ActionState.INTRO_ING;

function makeDef(withOpening: boolean): FighterDef {
  const labels: FighterDef['labels'] = {
    站立: { index: 0, duration: 9 },
    走: { index: 9, duration: 24 },
  };
  if (withOpening) labels['开场'] = { index: 100, duration: 20 };
  const areas: FighterDef['areas'] = {};
  for (let fr = 1; fr <= 130; fr++) {
    areas[fr] = [{ name: 'bdmn', x: -10, y: -40, w: 20, h: 40 }];
  }
  return {
    id: 'test',
    formIndex: 0,
    speed: 6,
    jumpPower: 15,
    heavy: 3,
    actions: {},
    labels,
    areas,
    attackLabels: {},
    triggers: [],
  };
}

function makeConfig(withOpening: boolean): SimConfig {
  return {
    seed: 1,
    intro: true,
    stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
    fighters: [
      { id: 1, x: 100, def: makeDef(withOpening) },
      { id: 2, x: 300, def: makeDef(withOpening) },
    ],
  };
}

/** 双方按给定输入推进 sim，收集快照序列。 */
function drive(
  sim: Sim,
  n: number,
  p1: (i: number) => number = () => 0,
  p2: (i: number) => number = () => 0,
): SimSnapshot[] {
  const snaps: SimSnapshot[] = [];
  for (let i = 0; i < n; i++) {
    snaps.push(sim.tick({ p1: p1(i), p2: p2(i) }));
  }
  return snaps;
}

describe('intro 切片：开局特写+语音演出', () => {
  it('缺省配置无 intro（replay/batch 零漂移）', () => {
    const sim = new Sim({
      seed: 1,
      stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
      fighters: [
        { id: 1, x: 100, def: makeDef(true) },
        { id: 2, x: 300, def: makeDef(true) },
      ],
    });
    const snaps = drive(sim, 5, () => Btn.right, () => Btn.right);
    expect(snaps[0]!.state.intro).toBeUndefined();
    // 立即可动（无冻结）
    expect(snaps[4]!.state.fighters[1]!.x).toBeGreaterThan(300);
  });

  it('状态机全序列：特写→语音→gap→特写→语音→gap→resume→字样→结束', () => {
    const sim = new Sim(makeConfig(true));
    const snaps = drive(sim, 500);
    const first = snaps[0]!;
    // tick 0 即冻结 + round:start 照发
    expect(first.state.intro).toEqual({ step: 0, hold: 1 });
    expect(first.events.some((e) => e.type === 'round:start')).toBe(true);
    // 全程观测
    const steps = new Set<number>();
    let sawSayP1 = false;
    let sawSayP2 = false;
    const roundFrames = new Set<number>();
    let endTick = -1;
    for (let i = 0; i < snaps.length; i++) {
      const st = snaps[i]!.state;
      if (st.intro == null) {
        if (endTick < 0) endTick = i;
        continue;
      }
      steps.add(st.intro.step);
      roundFrames.add(st.match.roundFrame);
      if (st.intro.step === 1 && st.fighters[0]!.actionState === INTRO_ING) sawSayP1 = true;
      if (st.intro.step === 4 && st.fighters[1]!.actionState === INTRO_ING) sawSayP2 = true;
    }
    expect(sawSayP1).toBe(true);
    expect(sawSayP2).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // say 步内 开场 标签生效
    const saySnap = snaps.find(
      (s) => s.state.intro?.step === 1 && s.state.fighters[0]!.actLabel === '开场',
    );
    expect(saySnap).toBeDefined();
    // 冻结期 roundFrame 停走（原版 renderGameTime 被 actionEnable 门控）
    expect(roundFrames.size).toBe(1);
    // 结束后双方回位 NORMAL（≈31+39+18+31+39+18+30+156 ≈ 362 tick）
    expect(endTick).toBeGreaterThan(0);
    const after = snaps[endTick]!;
    expect(after.state.fighters[0]!.actionState).toBe(ActionState.NORMAL);
    expect(after.state.fighters[1]!.actionState).toBe(ActionState.NORMAL);
  });

  it('冻结期物理停走：按住方向双角色位移恒定，结束后可动', () => {
    const sim = new Sim(makeConfig(true));
    const snaps = drive(sim, 400, () => Btn.right, () => Btn.right);
    for (const s of snaps) {
      if (s.state.intro == null) continue;
      expect(s.state.fighters[0]!.x).toBe(100);
      expect(s.state.fighters[1]!.x).toBe(300);
    }
    // 演出结束后可动（无输入锁死）
    const last = snaps[snaps.length - 1]!;
    expect(last.state.fighters[1]!.x).toBeGreaterThan(300);
  });

  it('缺 开场 标签：say 步直接跳过（原版软锁的有意识偏离）', () => {
    const sim = new Sim(makeConfig(false));
    const snaps = drive(sim, 400);
    // step 1/4 不出现在快照（进入即步进）
    const sayTicks = snaps.filter(
      (s) => s.state.intro != null && (s.state.intro.step === 1 || s.state.intro.step === 4),
    );
    expect(sayTicks.length).toBe(0);
    // 全程时长 = 无 say 等待（31+18+31+18+30+156 ≈ 284 tick）
    const end = snaps.findIndex((s) => s.state.intro == null);
    expect(end).toBeGreaterThan(200);
    expect(end).toBeLessThan(300);
  });

  it('skip：字样出场前 back 键 just-down 即恢复正常管线', () => {
    const sim = new Sim(makeConfig(true));
    // 首 tick 按下 back（step 0 < 7 可跳）
    const snaps = drive(sim, 40, (i) => (i < 10 ? Btn.back : 0) | Btn.right, () => Btn.right);
    // skip tick 快照 intro 即 null（back just-down 当 tick 生效）
    const skipIdx = snaps.findIndex((s) => s.state.intro == null);
    expect(skipIdx).toBeGreaterThanOrEqual(0);
    expect(skipIdx).toBeLessThan(10);
    // 跳过后双角色立即可动
    expect(snaps[39]!.state.fighters[1]!.x).toBeGreaterThan(300);
    // INTRO_ING 不残留
    expect(snaps[skipIdx]!.state.fighters[0]!.actionState).not.toBe(INTRO_ING);
  });

  it('skip：字样段（step 7）不可跳，播完自动结束', () => {
    const sim = new Sim(makeConfig(false));
    // 缺 开场 → ~128 tick 进 step 7（resume 6→30 后）；tick 160 起按住 back（step 7 内 just-down）
    const snaps = drive(sim, 400, (i) => (i >= 160 ? Btn.back : 0));
    const step7 = snaps.filter((s) => s.state.intro?.step === 7);
    expect(step7.length).toBeGreaterThan(100);
    expect(step7.every((s) => s.state.intro != null)).toBe(true);
    // 播完自动结束（字样 156 tick）
    const end = snaps.findIndex((s) => s.state.intro == null);
    expect(end).toBeGreaterThan(200);
  });

  it('冻结期流程步照跑：能量/辅助气维持满值（满值起步不可观测回充，烟雾断言管线不崩）', () => {
    const sim = new Sim(makeConfig(true));
    const snaps = drive(sim, 60);
    expect(snaps.every((s) => s.state.fighters[0]!.energy === 100)).toBe(true);
    expect(snaps.every((s) => s.state.fighters[0]!.fzqi === 100)).toBe(true);
  });
});
