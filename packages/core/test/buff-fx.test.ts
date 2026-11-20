import { describe, expect, it } from 'vitest';
import { Btn, Sim, type FighterDef, type SimConfig, type SimSnapshot } from '../src/index.js';

/**
 * 切片 51：buff 视觉特效 + 钢身发光事件锚点。
 *
 * 原版语义：
 *  - FighterBuffCtrler.speedUp/attackUp/defenseUp → doEffectById("buff_effect_*")
 *    + doBuffEffect("buff_*")（EffectModel.initBuffEffect 表）；
 *  - FighterMcCtrler.setSteelBody(v, isSuper) → FighterEffectCtrler.startGlow/
 *    endGlow（GlowFilter 颜色 isSuper ? 0xFFFF00 : 0xFFFFFF）。
 *
 * 移植折算：core 只发 `effect` 事件（buffUp / startGlow / endGlow），视觉全在
 * 渲染层（光环熄灭/发光开关按快照 buffs/steelBody 差分，不进 core）；事件不改
 * sim 行为，behaviorHash 零漂移。
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
    // 钢身窗口（切片 51 事件锚点）：f5 开（isSuper）→ f8 关
    //（站立 label 仅 9 帧，关灯触发须落在循环窗口内）
    triggers: [
      { frame: 5, target: 'mc', op: 'setSteelBody', args: [true, true] },
      { frame: 8, target: 'mc', op: 'setSteelBody', args: [false] },
    ],
    attackLabels: { zh1: '招1' },
  };
}

/** 合成辅助：f2 施加 attackUp(2, 5)（buffUp 事件锚点）。 */
function makeAssistDef() {
  return {
    id: 't-buff',
    actions: {},
    labels: {},
    areas: {},
    totalFrames: 40,
    triggers: [{ frame: 2, target: 'fighter' as const, op: 'buffAttackUp', args: [2, 5] }],
    loopTriggers: [],
  };
}

function makeConfig(): SimConfig {
  return {
    seed: 1,
    stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
    fighters: [
      { id: 1, x: 300, def: makeFighterDef(), assistId: 't-buff' },
      { id: 2, x: 700, def: makeFighterDef() },
    ],
    assistants: { 't-buff': makeAssistDef() },
  };
}

function runTicks(sim: Sim, ticks: number, summon = false): SimSnapshot[] {
  const out: SimSnapshot[] = [];
  for (let i = 0; i < ticks; i++) {
    out.push(sim.tick({ p1: summon && i < 2 ? Btn.assist : 0, p2: 0 }));
  }
  return out;
}

/** 收集全程 effect 事件（动态定位——动画帧 30Hz 推进，帧触发落 tick 不钉死）。 */
function effectEvents(snaps: SimSnapshot[], id: string): SimSnapshot['events'] {
  return snaps.flatMap((s) =>
    s.events.filter((e) => e.type === 'effect' && e.payload['id'] === id),
  );
}

describe('buff 视觉特效 + 钢身发光事件（切片 51）', () => {
  it('buffAttackUp 施发 effect buffUp（kind=power）+ buff 进状态', () => {
    const sim = new Sim(makeConfig());
    const snaps = runTicks(sim, 10, true);
    const evs = effectEvents(snaps, 'buffUp');
    expect(evs.length).toBeGreaterThanOrEqual(1);
    const params = evs[0]!.payload['params'] as Record<string, unknown>;
    expect(params['fighter']).toBe(1);
    expect(params['kind']).toBe('power');
    const f = snaps.at(-1)!.state.fighters[0]!;
    expect(f.buffs.attackUp).not.toBeNull();
    // hold 5s×60=300 起，随 tick 递减（施加到收尾已流逝数 tick）
    expect(f.buffs.attackUp!.holdTicks).toBeGreaterThan(0);
    expect(f.buffs.attackUp!.holdTicks).toBeLessThanOrEqual(5 * 60);
  });

  it('setSteelBody(true,true) → startGlow isSuper；setSteelBody(false) → endGlow', () => {
    const sim = new Sim(makeConfig());
    const snaps = runTicks(sim, 20);
    const start = effectEvents(snaps, 'startGlow');
    expect(start.length).toBeGreaterThanOrEqual(1);
    // p1/p2 同 def：各自发事件，fighter 参数区分
    const p1 = start.find(
      (e) => (e.payload['params'] as Record<string, unknown>)['fighter'] === 1,
    );
    expect(p1).toBeDefined();
    expect((p1!.payload['params'] as Record<string, unknown>)['isSuper']).toBe(true);
    const end = effectEvents(snaps, 'endGlow');
    expect(end.length).toBeGreaterThanOrEqual(1);
    // 开关态 = 快照 steelBody（渲染层差分真值）：startGlow 时开、endGlow 后熄
    const startTick = p1!.tick;
    const endTick = end.find(
      (e) => (e.payload['params'] as Record<string, unknown>)['fighter'] === 1,
    )!.tick;
    const withSteel = snaps.find((s) => s.tick === startTick)!;
    const afterEnd = snaps.find((s) => s.tick === endTick + 1)!;
    expect(withSteel.state.fighters[0]!.steelBody).toBe(true);
    expect(afterEnd.state.fighters[0]!.steelBody).toBe(false);
  });

  it('事件不改 sim 行为：behaviorHash 稳定可重现', () => {
    const a = runTicks(new Sim(makeConfig()), 20, true).map((s) => s.behaviorHash);
    const b = runTicks(new Sim(makeConfig()), 20, true).map((s) => s.behaviorHash);
    expect(a).toEqual(b);
  });
});
