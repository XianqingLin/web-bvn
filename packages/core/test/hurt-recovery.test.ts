import { describe, expect, it } from 'vitest';
import { Sim, type FighterDef, type SimState } from '../src/index.js';
import { enterHurt, startJump } from '../src/fighter/machine.js';
import { createInitialState } from '../src/state.js';

/** 受击恢复回归（2026-11-17 悬浮卡死修复）+ 原版无惯性跳跃回归（起跳清 vx）。 */

function makeDef(id: string): FighterDef {
  const labels: FighterDef['labels'] = {
    站立: { index: 0, duration: 9 },
    走: { index: 9, duration: 24 },
    被打: { index: 40, duration: 10 },
    击飞: { index: 50, duration: 10 },
    击飞_倒: { index: 60, duration: 10 },
    起身: { index: 70, duration: 8 },
    跳中: { index: 80, duration: 10 },
    落: { index: 90, duration: 8 },
    起跳: { index: 100, duration: 8 },
    落地: { index: 110, duration: 10 },
  };
  const areas: FighterDef['areas'] = {};
  for (let fr = 1; fr <= 130; fr++) {
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

/** byakuya tk 原版数值：hitType 11（摔）、hitx/hity 0、hurtTime 700、isApplyG false */
const TK: Parameters<typeof enterHurt>[2] = {
  power: 30,
  hitType: 11,
  hitx: 0,
  hity: 0,
  hurtTime: 700,
  hurtType: 0,
  isBreakDef: false,
  isApplyG: false,
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

describe('isApplyG:false 命中后受击恢复（回归：悬浮卡死修复）', () => {
  it('空中硬直中再被摔投命中（tk × air_hurt）→ 计时恢复后须回落地面回 idle', () => {
    const state = buildState();
    const f2 = state.fighters[1]!;
    // 连击中被 tk 再次命中：已在空中 HURT_ING（被打）中段
    f2.y = 400;
    f2.onGround = false;
    f2.actionState = 21 /* HURT_ING */;
    f2.vy = 0.5;
    f2.dampY = 0.25;
    f2.actLabel = '被打';
    f2.hurtTimer = 10;
    enterHurt(f2, makeDef('t'), TK, -1, true);
    expect(f2.applyG).toBe(false);
    const sim = makeSim(state);
    const zero = { p1: 0, p2: 0 };
    let landed = -1;
    for (let i = 0; i < 600; i++) {
      const f = sim.tick(zero).state.fighters[1]!;
      if (f.onGround && f.actionState === 0 /* NORMAL */) {
        landed = i;
        break;
      }
      // 修复前：applyG 恒 false → 重力门永久跳过 → 悬浮卡死
      expect(f.applyG || f.onGround || f.actionState === 21, `tick ${i} 悬浮卡死复现`).toBe(true);
    }
    expect(landed, '600 tick 内应落地回 idle').toBeGreaterThanOrEqual(0);
  });

  it('地面摔投硬直计时结束 → applyG 复位（原版 idle 链语义）', () => {
    const state = buildState();
    const f2 = state.fighters[1]!;
    enterHurt(f2, makeDef('t'), TK, -1, false);
    const sim = makeSim(state);
    const zero = { p1: 0, p2: 0 };
    // 硬直播完（hurtTime 700ms ≈ 21 帧@30Hz + 偏移）
    for (let i = 0; i < 120; i++) sim.tick(zero);
    const after = sim.tick(zero).state.fighters[1]!;
    expect(after.applyG).toBe(true);
  });
});

describe('原版无惯性跳跃（起跳清水平速度，FighterMain.jump 语义）', () => {
  it('地面带速起跳 → 发射瞬间 vx/dampX 清零', () => {
    const state = buildState();
    const f2 = state.fighters[1]!;
    const def = makeDef('t');
    f2.vx = 6; // 跑动速度
    f2.dampX = 0;
    expect(startJump(f2, def)).toBe(true);
    const sim = makeSim(state);
    const zero = { p1: 0, p2: 0 };
    let launched = false;
    for (let i = 0; i < 20; i++) {
      const f = sim.tick(zero).state.fighters[1]!;
      if (!f.onGround) {
        launched = true;
        expect(f.vx, '起跳发射须清零水平速度（原版 setVelocity(0, -jumpPower)）').toBe(0);
        expect(f.dampX).toBe(0);
        expect(f.vy).toBeLessThan(0);
        break;
      }
    }
    expect(launched).toBe(true);
  });

  it('跳跃全程无水平漂移：起跳后 vx 保持 0 直到落地', () => {
    const state = buildState();
    const f2 = state.fighters[1]!;
    const def = makeDef('t');
    f2.vx = 6;
    startJump(f2, def);
    const sim = makeSim(state);
    const zero = { p1: 0, p2: 0 };
    let sawAir = false;
    for (let i = 0; i < 200; i++) {
      const f = sim.tick(zero).state.fighters[1]!;
      if (!f.onGround) sawAir = true;
      if (sawAir && f.onGround) {
        expect(f.actionState).toBe(0);
        break;
      }
      if (sawAir) expect(f.vx, `tick ${i} 空中出现水平速度`).toBe(0);
    }
    expect(sawAir).toBe(true);
  });
});
