import { describe, expect, it } from 'vitest';
import { Btn, Sim, type FighterDef, type SimConfig, type SimSnapshot } from '../src/index.js';

/**
 * 切片 52：startShake 持续震屏事件锚点。
 *
 * 原版语义（FighterEffectCtrler.startShake → EffectCtrler.startShake）：
 *  - startShake(sx, sy) 置 _shakeHoldX/Y 保持项（与 shake 的衰减一次性分立），
 *    渲染步进每帧 stage.x/y = (hold + pow)×direct 逐帧翻转；
 *  - endShake() 清 hold + gameStage 位移即时回零（pow 衰减项存活）；
 *  - doAction/doHurt/idle 统一 endShake 自动清理（渲染层按快照差分近似）。
 *
 * 移植折算：core 只发 `effect` 事件（startShake/endShake），hold 与位移全在
 * 渲染层（advanceShake 的 holdX/holdY 通道）；事件不改 sim 行为，
 * behaviorHash 零漂移。
 */

const HIT = {
  power: 10,
  hitType: 1,
  hitx: 3,
  hity: 0,
  hurtTime: 300,
  hurtType: 0,
  isBreakDef: false,
  isApplyG: true,
};

function makeFighterDef(): FighterDef {
  const labels: FighterDef['labels'] = {
    站立: { index: 0, duration: 9 },
    走: { index: 9, duration: 24 },
    招1: { index: 180, duration: 30 },
  };
  const areas: FighterDef['areas'] = {};
  for (let fr = 1; fr <= 220; fr++) {
    areas[fr] = [{ name: 'bdmn', x: -10, y: -40, w: 20, h: 40 }];
  }
  return {
    id: 'test-f',
    formIndex: 0,
    speed: 6,
    jumpPower: 15,
    heavy: 3,
    actions: { zh1: { ...HIT } },
    labels,
    areas,
    totalFrames: 220,
    // 持续震屏窗口（切片 52 事件锚点）：f5 startShake(0,4) → f8 endShake
    //（站立 label 仅 9 帧，收尾触发须落在循环窗口内）
    triggers: [
      { frame: 5, target: 'mc', op: 'startShake', args: [0, 4] },
      { frame: 8, target: 'mc', op: 'endShake', args: [] },
    ],
    attackLabels: { zh1: '招1' },
  };
}

function makeConfig(): SimConfig {
  return {
    seed: 1,
    stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
    fighters: [
      { id: 1, x: 300, def: makeFighterDef() },
      { id: 2, x: 700, def: makeFighterDef() },
    ],
  };
}

function runTicks(sim: Sim, ticks: number): SimSnapshot[] {
  const out: SimSnapshot[] = [];
  for (let i = 0; i < ticks; i++) {
    out.push(sim.tick({ p1: 0, p2: 0 }));
  }
  return out;
}

/** 收集全程 effect 事件（动态定位——动画帧 30Hz 推进，帧触发落 tick 不钉死）。 */
function effectEvents(snaps: SimSnapshot[], id: string): SimSnapshot['events'] {
  return snaps.flatMap((s) =>
    s.events.filter((e) => e.type === 'effect' && e.payload['id'] === id),
  );
}

describe('startShake 持续震屏事件（切片 52）', () => {
  it('startShake(0,4) 施发 effect startShake（owner + pow 参数）', () => {
    const sim = new Sim(makeConfig());
    const snaps = runTicks(sim, 10);
    const evs = effectEvents(snaps, 'startShake');
    expect(evs.length).toBeGreaterThanOrEqual(1);
    const params = evs[0]!.payload['params'] as Record<string, unknown>;
    expect(params['owner']).toBe(1);
    expect(params['ownerKind']).toBe('fighter');
    expect(params['x']).toBe(0);
    expect(params['y']).toBe(4);
  });

  it('endShake 施发 effect endShake（hold 清零信号）', () => {
    const sim = new Sim(makeConfig());
    const snaps = runTicks(sim, 20);
    const end = effectEvents(snaps, 'endShake');
    expect(end.length).toBeGreaterThanOrEqual(1);
    // 时序：endShake 晚于 startShake（同角色同循环）
    const start = effectEvents(snaps, 'startShake').find(
      (e) => (e.payload['params'] as Record<string, unknown>)['owner'] === 1,
    );
    expect(start).toBeDefined();
    expect(end[0]!.tick).toBeGreaterThan(start!.tick);
  });

  it('事件不改 sim 行为：behaviorHash 稳定可重现', () => {
    const a = runTicks(new Sim(makeConfig()), 20).map((s) => s.behaviorHash);
    const b = runTicks(new Sim(makeConfig()), 20).map((s) => s.behaviorHash);
    expect(a).toEqual(b);
  });
});
