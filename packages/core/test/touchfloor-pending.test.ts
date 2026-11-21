import { describe, expect, it } from 'vitest';
import { ActionState, Btn, Sim, type FighterDef, type SimConfig } from '../src/index.js';

/**
 * 触地续接·预约消费回归（修复批次 68，2026-11-21）：
 *
 * 原版 renderFloorAction 头部每 tick 轮询 `if(!_isTouchFloor) touchFloor()`
 * ——预约消费不依赖落地事件。移植版此前只在 onLanded（落地事件）消费，
 * 「预约在已落地状态挂上」（小跳攻击落地早于 setTouchFloor 帧触发）即永久
 * 悬空 → stop 冻结后 endAct/idle 不可达 → movePercent 残速 + dampX=0
 * 永久滑步（斑目一角 砍技2 = J→J→W+J 实测卡死）。
 *
 * 修复：physics 站地分支逐 tick `pollTouchFloorPending` 兜底消费。
 * 本 fixture 复刻 砍技2 结构：
 *   砍技2（帧 21-28）：movePercent(1,-1)@21 → dampingPercent(0,0.5)@21 →
 *     setTouchFloor('砍技2_TF')@23 → stop@25
 *   砍技2_TF（帧 29-34）：endAct@30 → idle('站立')@33
 */

function makeDef(hop: number): FighterDef {
  const labels: FighterDef['labels'] = {
    站立: { index: 0, duration: 9 },
    砍技2: { index: 20, duration: 8 },
    砍技2_TF: { index: 28, duration: 6 },
  };
  const areas: FighterDef['areas'] = {};
  for (let fr = 1; fr <= 40; fr++) {
    areas[fr] = [{ name: 'bdmn', x: -10, y: -40, w: 20, h: 40 }];
  }
  return {
    id: 'test',
    formIndex: 0,
    speed: 6,
    jumpPower: 15,
    heavy: 3,
    actions: {
      kj2: { power: 50, hitType: 6, hitx: 3, hity: 0, hurtTime: 500, hurtType: 0, isBreakDef: false, isApplyG: true },
    },
    labels,
    areas,
    totalFrames: 40,
    triggers: [
      { frame: 21, target: 'mc', op: 'movePercent', args: [1, -hop] },
      { frame: 21, target: 'mc', op: 'dampingPercent', args: [0, 0.5] },
      { frame: 23, target: 'mc', op: 'setTouchFloor', args: ['砍技2_TF', true] },
      { frame: 25, target: 'mc', op: 'stop', args: [] },
      { frame: 30, target: 'mc', op: 'endAct', args: [] },
      { frame: 33, target: 'mc', op: 'idle', args: ['站立'] },
    ],
    attackLabels: { kj2: '砍技2' },
  };
}

function makeConfig(def: FighterDef): SimConfig {
  return {
    seed: 1,
    stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
    fighters: [
      { id: 1, x: 300, def },
      { id: 2, x: 700, def },
    ],
  };
}

/** 发起 W+J（上+攻击 → skill2 槽 = 砍技2），随后松手观测。 */
function runCombo(sim: Sim, ticks: number) {
  let started = false;
  let sawContinuation = false;
  for (let i = 0; i < ticks; i++) {
    const snap = sim.tick(i === 0 ? { p1: Btn.up | Btn.attack, p2: 0 } : { p1: 0, p2: 0 });
    const f = snap.state.fighters[0]!;
    if (f.actLabel === '砍技2') started = true;
    if (f.actLabel === '砍技2_TF') sawContinuation = true;
  }
  return { started, sawContinuation };
}

describe('触地续接·预约轮询消费（修复批次 68）', () => {
  it('小跳先落地、setTouchFloor 后挂上（站地预约）→ 轮询消费，正常收招不滑步', () => {
    // hop=1：vy=-3、dampY=1.5 → 2 tick 升完，顶点 4.5px 在吸附带内，
    // 第 3 tick 落地——早于 setTouchFloor@23 的帧触发（第 4 tick）
    const def = makeDef(1);
    const sim = new Sim(makeConfig(def));
    const { started, sawContinuation } = runCombo(sim, 60);
    expect(started).toBe(true);
    expect(sawContinuation).toBe(true);
    const f = sim.tick({ p1: 0, p2: 0 }).state.fighters[0]!;
    expect(f.actLabel).toBe('站立');
    expect(f.actionState).toBe(ActionState.NORMAL);
    expect(f.onGround).toBe(true);
    expect(f.touchFloor).toBeNull();
    // 收招后站定：连续多 tick 位移不变（修复前 movePercent 残速 + dampX=0
    // 永久滑步，且 stop 冻结使 endAct/idle 不可达）
    const s1 = sim.tick({ p1: 0, p2: 0 }).state.fighters[0]!;
    const s2 = sim.tick({ p1: 0, p2: 0 }).state.fighters[0]!;
    expect(s2.x).toBe(s1.x);
  });

  it('预约先挂上、后落地（正常空中路径）→ onLanded 消费，行为不回归', () => {
    // hop=3：vy=-9、dampY=1.5 → 6 tick 升完，顶点 27px 超出吸附带，
    // 落地晚于 setTouchFloor@23 与 stop@25——预约在落地事件消费
    const def = makeDef(3);
    const sim = new Sim(makeConfig(def));
    const { started, sawContinuation } = runCombo(sim, 90);
    expect(started).toBe(true);
    expect(sawContinuation).toBe(true);
    const f = sim.tick({ p1: 0, p2: 0 }).state.fighters[0]!;
    expect(f.actLabel).toBe('站立');
    expect(f.actionState).toBe(ActionState.NORMAL);
    expect(f.onGround).toBe(true);
    expect(f.touchFloor).toBeNull();
  });
});
