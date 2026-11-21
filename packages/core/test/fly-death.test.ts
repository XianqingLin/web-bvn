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

  it('硬直致死（hurtType==0）：KO tick 保持 HURT_ING 被打；计尽 → 倒地段 击飞_弹/击飞_倒 → DEAD 躺姿（批次 66）', () => {
    const { snaps, koTick, extra } = playKill({
      ...KILL_HEAVY,
      hurtType: 0,
      hity: 0,
    });
    expect(koTick).toBeGreaterThanOrEqual(0);
    const f = snaps[koTick]!.state.fighters[1]!;
    expect(
      f.actionState,
      '硬直致死 KO tick 不当场 DEAD（原版 doHurt 致死继续 HURT_ING 硬直）',
    ).toBe(ActionState.HURT_ING);
    expect(f.actLabel).toBe('被打');
    const after = snaps.slice(koTick);
    const fxAll = after.flatMap(effectIds);
    expect(fxAll, '倒地段应发 hit_floor_low（原版 playHurtDown hitFloor(1)）').toContain(
      'hit_floor_low',
    );
    const tan = after.find((s) => s.state.fighters[1]!.actLabel === '击飞_弹');
    expect(tan, '地面收尾先播 击飞_弹（原版 playHurtDown 延时段）').toBeDefined();
    const down = after.find(
      (s) => s.state.fighters[1]!.actionState === ActionState.HURT_DOWN,
    );
    expect(down, '随后 击飞_倒 倒地段（原版 playHurtDown2）').toBeDefined();
    expect(down!.state.fighters[1]!.actLabel).toBe('击飞_倒');
    const deadIdx = after.findIndex(
      (s) =>
        s.state.fighters[1]!.actionState === ActionState.DEAD &&
        s.state.fighters[1]!.onGround,
    );
    expect(deadIdx).toBeGreaterThan(0);
    const corpse = after[deadIdx]!.state.fighters[1]!;
    expect(corpse.actLabel, '躺姿定格 = 击飞_倒（原版 case 4 不 goFrame）').toBe('击飞_倒');
    expect(corpse.mcHold, '躺姿保持冻结').toBe(true);
    for (const s of after.slice(0, deadIdx + 1)) {
      const lbl = s.state.fighters[1]!.actLabel;
      expect(lbl, '正常 KO 败方不播 失败').not.toBe('失败');
      expect(lbl, '尸体不起身').not.toBe('起身');
    }
    const voiceIdx = after.findIndex((s) =>
      s.events.some((e) => e.type === 'voice' && e.payload.kind === 'die'),
    );
    expect(voiceIdx, 'die voice 随硬直计尽收尾转换点发出（非 KO tick）').toBeGreaterThan(0);
    for (const s of extra) {
      const cf = s.state.fighters[1]!;
      expect(cf.actionState).toBe(ActionState.DEAD);
      expect(cf.actLabel).toBe('击飞_倒');
    }
  });

  it('破防致死：KO tick 不当场 DEAD——破防硬直播尽 → 倒地段 → DEAD 躺姿（批次 66，原版 doBreakDefense 无 DIE 检查）', () => {
    // P1 破防技（isBreakDef，drain = 能量上限 90%）：hit1 削血 50（hp 150→100）、
    // 能量 100→10；hit2 削血 50（hp 100→50 > 0 不走 KO 分支）、能量 < 90 →
    // 破防削血 power/10 = 100 → hp 归 0 走破防致死
    const def = makeDef('t');
    const atkDef: FighterDef = {
      ...makeDef('atk'),
      actions: {
        k1: {
          power: 1000,
          hitType: 1,
          hitx: 3,
          hity: 0,
          hurtTime: 300,
          hurtType: 0,
          isBreakDef: true,
          isApplyG: true,
        },
      },
      attackLabels: { k1: '砍1' },
      triggers: [
        { frame: 174, target: 'mc', op: 'endAct', args: [] },
        { frame: 175, target: 'mc', op: 'idle', args: ['站立'] },
      ],
    };
    for (const fr of [172, 173]) {
      atkDef.areas[fr] = [
        { name: 'bdmn', x: -10, y: -40, w: 20, h: 40 },
        { name: 'k1atm', x: 10, y: -40, w: 30, h: 30 },
      ];
    }
    const sim = new Sim({
      seed: 1,
      stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
      fighters: [
        { id: 1, x: 300, def: atkDef },
        { id: 2, x: 330, hp: 150, def },
      ],
    } as never);
    const snaps: SimSnapshot[] = [];
    let koTick = -1;
    for (let i = 0; i < 800; i++) {
      // i=2 / i=42 两度出刀；P2 全程按住 ↓ 防御
      const p1 = i === 2 || i === 42 ? Btn.attack : 0;
      const snap = sim.tick({ p1, p2: Btn.down });
      snaps.push(snap);
      if (koTick < 0 && snap.events.some((e) => e.type === 'fighter:ko')) koTick = i;
      if (
        koTick >= 0 &&
        snap.state.fighters[1]!.actionState === ActionState.DEAD &&
        snap.state.fighters[1]!.onGround
      ) {
        break;
      }
    }
    expect(koTick).toBeGreaterThanOrEqual(0);
    const f = snaps[koTick]!.state.fighters[1]!;
    expect(f.hp).toBe(0);
    expect(
      f.actionState,
      '破防致死 KO tick 不当场 DEAD（原版 doBreakDefense 削血后照常进破防硬直）',
    ).toBe(ActionState.HURT_ING);
    expect(f.actLabel).toBe('被打');
    const after = snaps.slice(koTick);
    const tan = after.find((s) => s.state.fighters[1]!.actLabel === '击飞_弹');
    expect(tan, '破防硬直播尽走同款倒地段收尾（port 偏离登记：原版回站立）').toBeDefined();
    const dead = after.find(
      (s) =>
        s.state.fighters[1]!.actionState === ActionState.DEAD &&
        s.state.fighters[1]!.onGround,
    );
    expect(dead).toBeDefined();
    expect(dead!.state.fighters[1]!.actLabel).toBe('击飞_倒');
    for (const s of after) {
      expect(s.state.fighters[1]!.actLabel, '不播 失败').not.toBe('失败');
    }
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
