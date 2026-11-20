import { describe, expect, it } from 'vitest';
import { Sim, type FighterDef, type SimSnapshot, type SimState } from '../src/index.js';
import { enterHurt } from '../src/fighter/machine.js';
import { createInitialState } from '../src/state.js';

/**
 * 击飞三段式弹起（切片 54，原版 FighterMC.renderHurtFly 1→2→3→4 收编）：
 * 轻击飞 落地→击飞_落→击飞_弹 弹起→二次落地 击飞_倒（hit_floor_low）；
 * 重击飞 落地→击飞_落→击飞_倒（hit_floor_heavy+yan，不弹）。
 */

function makeDef(id: string): FighterDef {
  const labels: FighterDef['labels'] = {
    站立: { index: 0, duration: 9 },
    走: { index: 9, duration: 24 },
    被打: { index: 40, duration: 10 },
    击飞: { index: 50, duration: 10 },
    击飞_落: { index: 60, duration: 10 },
    击飞_弹: { index: 70, duration: 9 },
    击飞_倒: { index: 80, duration: 9 },
    起身: { index: 90, duration: 8 },
    跳中: { index: 100, duration: 10 },
    落: { index: 110, duration: 8 },
    起跳: { index: 120, duration: 8 },
    落地: { index: 130, duration: 10 },
    砍1: { index: 140, duration: 5 },
  };
  const areas: FighterDef['areas'] = {};
  for (let fr = 1; fr <= 150; fr++) {
    areas[fr] = [{ name: 'bdmn', x: -10, y: -40, w: 20, h: 40 }];
  }
  return {
    id,
    formIndex: 0,
    speed: 6,
    jumpPower: 15,
    heavy: 3,
    actions: {},
    labels,
    areas,
    triggers: [],
  } as FighterDef;
}

/** 轻击飞命中：hity=-3（向上，未超 HIT_DOWN_BY_HITY=5）→ 弹起路径。 */
const LAUNCH_LIGHT: Parameters<typeof enterHurt>[2] = {
  power: 30,
  hitType: 1,
  hitx: 4,
  hity: -3,
  hurtTime: 400,
  hurtType: 1,
  isBreakDef: false,
  isApplyG: true,
};

/** 重击飞命中：hity=6（>5）→ 重击倒地路径。 */
const LAUNCH_HEAVY: Parameters<typeof enterHurt>[2] = {
  power: 30,
  hitType: 1,
  hitx: 5,
  hity: 6,
  hurtTime: 400,
  hurtType: 1,
  isBreakDef: false,
  isApplyG: true,
};

function makeSim(state: SimState): Sim {
  const def = makeDef('t');
  return Sim.fromState(state, [
    [1, def],
    [2, def],
  ]);
}

function buildState(): SimState {
  const def = makeDef('t');
  return createInitialState({
    seed: 1,
    stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
    fighters: [
      { id: 1, x: 300, hp: 1000, def },
      { id: 2, x: 700, hp: 1000, def },
    ],
  } as never);
}

function effectIds(snap: SimSnapshot): string[] {
  return snap.events
    .filter((e) => e.type === 'effect')
    .map((e) => String(e.payload['id']));
}

describe('击飞三段式弹起（切片 54）', () => {
  it('轻击飞：落地→击飞_落→击飞_弹 弹起→二次落地 击飞_倒→起身→恢复', () => {
    const state = buildState();
    const f2 = state.fighters[1]!;
    f2.y = 460;
    f2.onGround = false;
    enterHurt(f2, makeDef('t'), LAUNCH_LIGHT, -1, true);
    expect(f2.actionState).toBe(22 /* HURT_FLYING */);
    expect(f2.hurtFlyStage).toBe(1);
    expect(f2.hurtFlyTimer).toBe(15); // HURT_JUMP_FRAME

    const sim = makeSim(state);
    const zero = { p1: 0, p2: 0 };
    const fxAll: string[] = [];
    let sawFall = false;
    let sawTan = false;
    let sawDownAgain = false;
    let bounced = false;
    for (let i = 0; i < 600; i++) {
      const snap = sim.tick(zero);
      fxAll.push(...effectIds(snap));
      const f = snap.state.fighters[1]!;
      if (f.actLabel === '击飞_落') sawFall = true;
      if (f.actionState === 24 /* HURT_DOWN_TAN */) {
        sawTan = true;
        if (f.actLabel === '击飞_弹' && f.vy < 0 && f.mcHold) bounced = true;
      }
      if (sawTan && f.onGround && f.actionState === 23 /* HURT_DOWN */) {
        sawDownAgain = true;
        // 二次落地必播 hit_floor_low（原版 hitFloor(1)）
        expect(fxAll.includes('hit_floor_low'), '二次落地应发 hit_floor_low').toBe(true);
        expect(f.mcHold, '击飞_倒 定格（goFrame false）').toBe(true);
        break;
      }
    }
    expect(sawFall, '应展示 击飞_落').toBe(true);
    expect(sawTan, '应进入 HURT_DOWN_TAN 弹起').toBe(true);
    expect(bounced, '弹起 = 击飞_弹 定格 + 向上速度').toBe(true);
    expect(sawDownAgain, '二次落地应回 HURT_DOWN').toBe(true);
    expect(fxAll.includes('hit_floor'), '首次落地（弹起）应发 hit_floor').toBe(true);
    // 弹起后应起身恢复
    let recovered = false;
    for (let i = 0; i < 300; i++) {
      const f = sim.tick(zero).state.fighters[1]!;
      if (f.actionState === 0 && f.onGround && f.actLabel === '站立') {
        recovered = true;
        break;
      }
    }
    expect(recovered, '倒地计时后应起身恢复回 站立').toBe(true);
  });

  it('轻击飞最短飞行门：落地早于 15 动画帧时站地等待，不提前弹起', () => {
    const state = buildState();
    const f2 = state.fighters[1]!;
    // 贴地起跳：hity 上抛很小，几 tick 内落地
    f2.y = 498;
    f2.onGround = false;
    enterHurt(f2, makeDef('t'), LAUNCH_LIGHT, -1, true);
    const sim = makeSim(state);
    const zero = { p1: 0, p2: 0 };
    let landedTick = -1;
    for (let i = 0; i < 60; i++) {
      const f = sim.tick(zero).state.fighters[1]!;
      if (f.onGround && landedTick < 0) landedTick = i;
      // 落地后、飞行门计满前不得进入 击飞_落/弹起
      if (landedTick >= 0 && f.hurtFlyStage === 1) {
        expect(f.actLabel, '飞行门未尽不得切 击飞_落').not.toBe('击飞_落');
        expect(f.actionState, '飞行门未尽保持 HURT_FLYING').toBe(22);
      }
      if (f.hurtFlyStage === 2) {
        // 击飞_落 出现时机不得早于 15 动画帧 = 30 tick
        expect(i, '击飞_落 出现 tick ≥ 最短飞行门').toBeGreaterThanOrEqual(28);
        break;
      }
    }
    expect(landedTick, '应先落地').toBeGreaterThanOrEqual(0);
    expect(f2).toBeDefined();
  });

  it('重击飞：落地→击飞_落→击飞_倒（不弹起），重尘土+烟+强震屏', () => {
    const state = buildState();
    const f2 = state.fighters[1]!;
    f2.y = 440;
    f2.onGround = false;
    enterHurt(f2, makeDef('t'), LAUNCH_HEAVY, -1, true);
    expect(f2.hurtHeavy).toBe(true);
    expect(f2.hurtFlyTimer).toBe(0);
    const sim = makeSim(state);
    const zero = { p1: 0, p2: 0 };
    const fxAll: string[] = [];
    let sawTan = false;
    let down = -1;
    for (let i = 0; i < 300; i++) {
      const snap = sim.tick(zero);
      fxAll.push(...effectIds(snap));
      const f = snap.state.fighters[1]!;
      if (f.actionState === 24) sawTan = true; // 重击不得弹起
      if (f.actionState === 23 && down < 0) {
        down = i;
        break;
      }
    }
    expect(down, '重击应直接倒地').toBeGreaterThanOrEqual(0);
    expect(sawTan, '重击不得进入弹起态').toBe(false);
    expect(fxAll.includes('hit_floor_heavy'), '重击倒地应发 hit_floor_heavy').toBe(true);
    expect(fxAll.includes('hit_floor_yan'), '重击倒地应发 hit_floor_yan').toBe(true);
    expect(fxAll.includes('hit_floor_low'), '重击路径无二次落地').toBe(false);
  });

  it('弹起/飞行中再被击飞命中 → 子状态机重入 stage 1（juggle）', () => {
    const def = makeDef('t');
    const state = buildState();
    const f2 = state.fighters[1]!;
    // 先走一遍轻击飞进入弹起态（手动模拟弹起中：HURT_DOWN_TAN + 击飞_弹 定格）
    enterHurt(f2, def, LAUNCH_LIGHT, -1, true);
    f2.hurtFlyStage = 3;
    f2.actionState = 24 /* HURT_DOWN_TAN */;
    f2.actLabel = '击飞_弹';
    f2.mcHold = true;
    f2.onGround = false;
    // 空中再吃一发轻击飞 → 子状态机整体重入（原版 playHurtFly 重入初始化）
    enterHurt(f2, def, LAUNCH_LIGHT, 1, true);
    expect(f2.hurtFlyStage).toBe(1);
    expect(f2.hurtFlyTimer).toBe(15);
    expect(f2.actionState).toBe(22 /* HURT_FLYING */);
    expect(f2.mcHold, '飞行姿势定格（goFrame false）').toBe(true);
    expect(f2.actLabel).toBe('击飞');
    const fly = def.labels['击飞']!;
    expect(f2.animFrame, 'juggle 重入重置帧号（goFrame gotoAndStop）').toBe(fly.index + 1);
  });
});
