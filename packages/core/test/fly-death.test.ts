import { describe, expect, it } from 'vitest';
import { ActionState, Btn, Sim, type FighterDef, type SimConfig, type SimSnapshot, type SimState } from '../src/index.js';
import { enterHurt } from '../src/fighter/machine.js';
import { createInitialState } from '../src/state.js';

/**
 * 击飞致死飞尸演出（修复批次 65，原版 FighterMcCtrler.doHurt + FighterMC.renderHurtFly
 * case 4 实证）：hurtType≠0 致死不当场 DEAD——doHurt 致死只发 DIE + isAlive=false，
 * 代码继续 playHurtFly，尸体走完整 击飞→落地→（弹起）→击飞_倒；case 4 首查 isAlive
 * 才转 DEAD（躺姿定格，跳过起身）。此前移植版当场 enterDead → 尸体播「失败」定格
 * 末帧（直立姿势），边缘 KO 目击缺陷根因。
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
    失败: { index: 100, duration: 21 },
    跳中: { index: 130, duration: 10 },
    落: { index: 140, duration: 8 },
    起跳: { index: 150, duration: 8 },
    落地: { index: 160, duration: 10 },
    砍1: { index: 170, duration: 5 },
  };
  const areas: FighterDef['areas'] = {};
  for (let fr = 1; fr <= 180; fr++) {
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

/** 重击飞致死命中（hity=6 > HIT_DOWN_BY_HITY=5 → 落地直接 击飞_倒）。 */
const KILL_HEAVY = {
  power: 2000,
  hitType: 1,
  hitx: 3,
  hity: 6,
  hurtTime: 300,
  hurtType: 1,
  isBreakDef: false,
  isApplyG: true,
};

/** 轻击飞致死命中（hity=-3 → 落地 击飞_弹 弹起 → 二次落地 击飞_倒）。 */
const KILL_LIGHT = {
  power: 2000,
  hitType: 1,
  hitx: 4,
  hity: -3,
  hurtTime: 300,
  hurtType: 1,
  isBreakDef: false,
  isApplyG: true,
};

function makeConfig(kill: typeof KILL_HEAVY): SimConfig {
  const def = makeDef('t');
  const atkDef: FighterDef = {
    ...makeDef('atk'),
    actions: { k1: kill },
    attackLabels: { k1: '砍1' },
    triggers: [
      { frame: 174, target: 'mc', op: 'endAct', args: [] },
      { frame: 175, target: 'mc', op: 'idle', args: ['站立'] },
    ],
  };
  // 砍1 时间轴帧 171-175（index 170, duration 5）：172/173 挂 k1atm 判定区
  for (const fr of [172, 173]) {
    atkDef.areas[fr] = [
      { name: 'bdmn', x: -10, y: -40, w: 20, h: 40 },
      { name: 'k1atm', x: 10, y: -40, w: 30, h: 30 },
    ];
  }
  return {
    seed: 1,
    stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
    fighters: [
      { id: 1, x: 300, def: atkDef },
      { id: 2, x: 330, def },
    ],
  } as never;
}

function effectIds(snap: SimSnapshot): string[] {
  return snap.events
    .filter((e) => e.type === 'effect')
    .map((e) => String(e.payload['id']));
}

/** 真实命中管线：P1 砍1 击杀 P2（贴身），返回 KO 后至躺姿定格的全程采样
 *  + 定格后再跑 120 tick 的死后采样（extra）。 */
function playKill(kill: typeof KILL_HEAVY, maxTicks = 2000) {
  const sim = new Sim(makeConfig(kill));
  sim.tick({ p1: 0, p2: 0 });
  sim.tick({ p1: Btn.attack, p2: 0 });
  let koTick = -1;
  const snaps: SimSnapshot[] = [];
  const extra: SimSnapshot[] = [];
  for (let i = 0; i < maxTicks; i++) {
    const snap = sim.tick({ p1: 0, p2: 0 });
    snaps.push(snap);
    if (koTick < 0 && snap.events.some((e) => e.type === 'fighter:ko')) koTick = i;
    const f = snap.state.fighters[1]!;
    if (koTick >= 0 && f.actionState === ActionState.DEAD && f.onGround) {
      for (let j = 0; j < 120; j++) extra.push(sim.tick({ p1: 0, p2: 0 }));
      break;
    }
  }
  return { snaps, koTick, extra };
}

describe('击飞致死飞尸演出（修复批次 65）', () => {
  it('KO tick 不当场 DEAD：击飞类致死保持 HURT_FLYING（原版 doHurt 致死后继续 playHurtFly）', () => {
    const { snaps, koTick } = playKill(KILL_HEAVY);
    expect(koTick).toBeGreaterThanOrEqual(0);
    const koSnap = snaps[koTick]!;
    const f = koSnap.state.fighters[1]!;
    expect(f.hp).toBe(0);
    expect(f.actionState, '击飞致死 KO tick 保持 HURT_FLYING').toBe(ActionState.HURT_FLYING);
    expect(f.actLabel, '飞行姿势定格').toBe('击飞');
    expect(f.hurtFlyStage, '三段式子状态机照常置位').toBe(1);
  });

  it('重击飞致死：完整落地倒地段 → DEAD 击飞_倒 躺姿定格（不播 失败/不起身）', () => {
    const { snaps, koTick } = playKill(KILL_HEAVY);
    const after = snaps.slice(koTick);
    const fxAll = after.flatMap(effectIds);
    expect(fxAll, '重击倒地应发 hit_floor_heavy').toContain('hit_floor_heavy');
    expect(fxAll, '重击倒地应发 hit_floor_yan').toContain('hit_floor_yan');
    // 落地前不得转 DEAD（原版 case 1-3 无 isAlive 门）
    const down = after.find(
      (s) => s.state.fighters[1]!.actionState === ActionState.HURT_DOWN,
    );
    expect(down, '应进 HURT_DOWN 倒地段').toBeDefined();
    expect(down!.state.fighters[1]!.actLabel).toBe('击飞_倒');
    const deadIdx = after.findIndex(
      (s) =>
        s.state.fighters[1]!.actionState === ActionState.DEAD &&
        s.state.fighters[1]!.onGround,
    );
    expect(deadIdx).toBeGreaterThan(0);
    const corpse = after[deadIdx]!.state.fighters[1]!;
    expect(corpse.actLabel, '躺姿定格 = 击飞_倒（原版 case 4 不 goFrame）').toBe('击飞_倒');
    expect(corpse.mcHold, '躺姿保持 goFrame false 冻结').toBe(true);
    // 死前全程不得出现 失败/起身 标签
    for (const s of after.slice(0, deadIdx + 1)) {
      const lbl = s.state.fighters[1]!.actLabel;
      expect(lbl, '飞尸不得播 失败').not.toBe('失败');
      expect(lbl, '飞尸不得起身').not.toBe('起身');
    }
    // 死后永久躺姿（case 4 转 DEAD 后停走，跳过起身）
    const { extra } = playKill(KILL_HEAVY);
    expect(extra.length).toBeGreaterThan(0);
    for (const s of extra) {
      const f = s.state.fighters[1]!;
      expect(f.actionState).toBe(ActionState.DEAD);
      expect(f.actLabel).toBe('击飞_倒');
    }
  });

  it('轻击飞致死：落地→击飞_弹 弹起→二次落地→DEAD 击飞_倒（弹起段对尸体生效）', () => {
    const { snaps, koTick } = playKill(KILL_LIGHT);
    const after = snaps.slice(koTick);
    const fxAll = after.flatMap(effectIds);
    let sawTan = false;
    for (const s of after) {
      const f = s.state.fighters[1]!;
      if (f.actionState === ActionState.HURT_DOWN_TAN && f.actLabel === '击飞_弹') {
        sawTan = true;
      }
    }
    expect(sawTan, '轻击飞致死应有弹起段（原版 case 2 轻击分支无 isAlive 门）').toBe(true);
    expect(fxAll, '弹起首落地应发 hit_floor').toContain('hit_floor');
    expect(fxAll, '二次落地应发 hit_floor_low').toContain('hit_floor_low');
    const corpse = after.at(-1)!.state.fighters[1]!;
    expect(corpse.actionState).toBe(ActionState.DEAD);
    expect(corpse.actLabel).toBe('击飞_倒');
  });

  it('非击飞致死维持当场 DEAD + 失败 标签（hurtType==0 路径不变）', () => {
    const { snaps, koTick } = playKill({
      ...KILL_HEAVY,
      hurtType: 0,
      hity: 0,
    });
    expect(koTick).toBeGreaterThanOrEqual(0);
    const f = snaps[koTick]!.state.fighters[1]!;
    expect(f.actionState).toBe(ActionState.DEAD);
    expect(f.actLabel).toBe('失败');
  });

  it('playHurtFly 强制重力：击飞类命中 isApplyG=false 仍 applyG=true（防止尸体悬空）', () => {
    const def = makeDef('t');
    const state: SimState = createInitialState({
      seed: 1,
      stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
      fighters: [
        { id: 1, x: 300, hp: 1000, def },
        { id: 2, x: 700, hp: 1000, def },
      ],
    } as never);
    const f2 = state.fighters[1]!;
    enterHurt(
      f2,
      def,
      { ...KILL_HEAVY, isApplyG: false },
      -1,
      false,
    );
    expect(f2.actionState).toBe(ActionState.HURT_FLYING);
    expect(f2.applyG, '原版 playHurtFly 无条件 isApplyG=true').toBe(true);
  });
});
