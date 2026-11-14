import { describe, expect, it } from 'vitest';
import {
  Btn,
  Sim,
  type FighterDef,
  type SimConfig,
  type SimEvent,
  type SimState,
  type AreaRect,
} from '../src/index.js';

/**
 * 修复批次 35：打击特效三件套的 core 侧——hitstop（freezeTicks）+ spark
 * 钉点（hitRect∩身体区相交中心）+ sparkType（手防 KAN→DA 转换）。
 *
 * 手工 def（30Hz 帧布局，同 combat.test 简化版）：站立 1-9、砍1 55-71
 * （k1atm 58-59）、防御 143-148、招1 181-210（zh1atm 185-186）。
 * 交点几何：k1atm 世界矩形 (110..140)∩bdmn (120..140, y 460..500∩460..490)
 * → 相交中心 (130, 475)（纯 hitArea 中心是 (125, 475)，可区分）。
 */

interface HitDef {
  power: number;
  hitType: number;
  hitx: number;
  hity: number;
  hurtTime: number;
  hurtType: number;
  isBreakDef: boolean;
  isApplyG: boolean;
}

function makeDef(defenseType = 0): FighterDef {
  const labels: FighterDef['labels'] = {
    站立: { index: 0, duration: 9 },
    被打: { index: 71, duration: 8 },
    击飞: { index: 79, duration: 10 },
    击飞_倒: { index: 89, duration: 9 },
    起身: { index: 98, duration: 9 },
    防御: { index: 142, duration: 6 },
    防御恢复: { index: 148, duration: 12 },
    砍1: { index: 54, duration: 17 },
    招1: { index: 180, duration: 30 },
    砍2: { index: 260, duration: 17 },
  };
  const areas: FighterDef['areas'] = {};
  for (let fr = 1; fr <= 280; fr++) {
    const list: AreaRect[] = [{ name: 'bdmn', x: -10, y: -40, w: 20, h: 40 }];
    if (fr === 58 || fr === 59) list.push({ name: 'k1atm', x: 10, y: -40, w: 30, h: 30 });
    if (fr === 185 || fr === 186) list.push({ name: 'zh1atm', x: 10, y: -40, w: 30, h: 30 });
    if (fr === 270 || fr === 271) list.push({ name: 'k2atm', x: 10, y: -40, w: 30, h: 30 });
    areas[fr] = list;
  }
  return {
    id: 'test',
    formIndex: 0,
    speed: 6,
    jumpPower: 15,
    heavy: 3,
    defenseType,
    actions: {
      k1: { power: 30, hitType: 1, hitx: 3, hity: 0, hurtTime: 300, hurtType: 0, isBreakDef: false, isApplyG: true } satisfies HitDef,
      zh1: { power: 40, hitType: 6, hitx: 3, hity: 0, hurtTime: 300, hurtType: 0, isBreakDef: false, isApplyG: true } satisfies HitDef,
      k2: { power: 10, hitType: 0, hitx: 3, hity: 0, hurtTime: 300, hurtType: 0, isBreakDef: false, isApplyG: true } satisfies HitDef,
    },
    labels,
    areas,
    totalFrames: 280,
    // 动作尾部收尾脚本（防时间轴顺流串入相邻标签，同 combat.test）+
    // 砍1 第 57 帧 setAttack('砍2') 连段槽改写（type 0 用例的第二刀入口）。
    // 批次 38：受击无敌窗 ×2（4→8 tick）后 k2atm 从 264/265 移到 270/271——
    // 原位置落在加宽后的无敌窗内（夹具边际时序，真实连段相隔约 19 帧不受影响）
    triggers: [
      { frame: 57, target: 'mc', op: 'setAttack', args: ['砍2'] },
      { frame: 69, target: 'mc', op: 'endAct', args: [] },
      { frame: 70, target: 'mc', op: 'idle', args: ['站立'] },
      { frame: 208, target: 'mc', op: 'endAct', args: [] },
      { frame: 209, target: 'mc', op: 'idle', args: ['站立'] },
      { frame: 277, target: 'mc', op: 'endAct', args: [] },
      { frame: 278, target: 'mc', op: 'idle', args: ['站立'] },
    ],
    attackLabels: { k1: '砍1', zh1: '招1', k2: '砍2' },
  };
}

function makeConfig(opts: { defense2?: number } = {}): SimConfig {
  return {
    seed: 1,
    stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
    fighters: [
      { id: 1, x: 100, def: makeDef() },
      { id: 2, x: 130, def: makeDef(opts.defense2 ?? 0) },
    ],
  };
}

function mutated(sim: Sim, mutate: (s: SimState) => void): Sim {
  const state = JSON.parse(sim.serializeState()) as SimState;
  mutate(state);
  return Sim.fromState(state, sim.getDefEntries());
}

function play(
  sim: Sim,
  segments: [number, number, number][],
): { events: SimEvent[]; snaps: { tick: number; state: SimState }[] } {
  const events: SimEvent[] = [];
  const snaps: { tick: number; state: SimState }[] = [];
  for (const [frames, p1, p2] of segments) {
    for (let i = 0; i < frames; i++) {
      const snap = sim.tick({ p1, p2 });
      events.push(...snap.events);
      snaps.push({ tick: snap.tick, state: snap.state });
    }
  }
  return { events, snaps };
}

/** 首个 hit:connect 事件（payload 带 spark 字段）。 */
function firstHit(events: SimEvent[]): SimEvent {
  const ev = events.find((e) => e.type === 'hit:connect');
  if (!ev) throw new Error('no hit:connect event');
  return ev;
}

describe('打击停顿 hitstop（修复批次 35）', () => {
  it('轻击（type 1）冻结 3 tick，spark 钉相交区中心', () => {
    const res = play(new Sim(makeConfig()), [[1, Btn.attack, 0], [30, 0, 0]]);
    const ev = firstHit(res.events);
    expect(ev.payload).toMatchObject({
      sparkType: 1,
      blocked: false,
      breakDef: false,
      direct: 1,
      x: 130, // k1atm(110..140)∩bdmn(120..140) → 120..140 中心（hitArea 中心是 125）
      y: 475, // 460..490 中心
    });
    const i = res.snaps.findIndex((s) => s.state.freezeTicks === 3);
    expect(i).toBeGreaterThanOrEqual(0);
    // 逐 tick 递减：3 → 2 → 1 → 0，动画/物理全程停走
    expect(res.snaps[i + 1]!.state.freezeTicks).toBe(2);
    expect(res.snaps[i + 2]!.state.freezeTicks).toBe(1);
    expect(res.snaps[i + 3]!.state.freezeTicks).toBe(0);
    for (let k = 0; k < 3; k++) {
      expect(res.snaps[i + k]!.state.fighters[0]!.animFrame).toBe(
        res.snaps[i]!.state.fighters[0]!.animFrame,
      );
      expect(res.snaps[i + k]!.state.fighters[1]!.animFrame).toBe(
        res.snaps[i]!.state.fighters[1]!.animFrame,
      );
    }
  });

  it('重击（type 6 KAN_HEAVY）冻结 24 tick', () => {
    const res = play(new Sim(makeConfig()), [[1, Btn.skill, 0], [40, 0, 0]]);
    const ev = firstHit(res.events);
    expect(ev.payload).toMatchObject({ sparkType: 6, blocked: false });
    expect(res.snaps.some((s) => s.state.freezeTicks === 24)).toBe(true);
  });

  it('type 0（NONE）无特效不冻：freezeTicks 恒 0', () => {
    // 砍1 第 57 帧 setAttack('砍2')（k2 = type 0）→ 连段第二刀
    const res = play(new Sim(makeConfig()), [
      [1, Btn.attack, 0],
      [6, 0, 0],
      [1, Btn.attack, 0],
      [30, 0, 0],
    ]);
    const hits = res.events.filter((e) => e.type === 'hit:connect');
    const k2Hit = hits.find((e) => (e.payload as { hitType?: number }).hitType === 0);
    expect(k2Hit).toBeDefined();
    expect((k2Hit!.payload as { sparkType?: number }).sparkType).toBe(0);
    // 只有第一刀（type 1）冻 3 tick：freeze>0 的快照恰 3 个（第二刀不再叠加）
    expect(res.snaps.filter((s) => s.state.freezeTicks > 0)).toHaveLength(3);
  });
});

describe('防御特效与停顿（修复批次 35）', () => {
  it('剑防（defenseType 0）：sparkType 不转，轻击冻 3', () => {
    const res = play(new Sim(makeConfig({ defense2: 0 })), [
      [1, Btn.attack, Btn.down],
      [30, 0, Btn.down],
    ]);
    const ev = firstHit(res.events);
    expect(ev.payload).toMatchObject({ sparkType: 1, blocked: true, breakDef: false });
    expect(res.snaps.some((s) => s.state.freezeTicks === 3)).toBe(true);
  });

  it('手防（defenseType 1）：KAN→DA（1→2）、KAN_HEAVY→DA_HEAVY（6→3）', () => {
    const res = play(new Sim(makeConfig({ defense2: 1 })), [
      [1, Btn.attack, Btn.down],
      [30, 0, Btn.down],
    ]);
    const ev = firstHit(res.events);
    expect(ev.payload).toMatchObject({ hitType: 1, sparkType: 2, blocked: true });
    expect(res.snaps.some((s) => s.state.freezeTicks === 3)).toBe(true);
    // 重击被手防 → sparkType 3、冻 24
    const res2 = play(new Sim(makeConfig({ defense2: 1 })), [
      [1, Btn.skill, Btn.down],
      [40, 0, Btn.down],
    ]);
    const ev2 = firstHit(res2.events);
    expect(ev2.payload).toMatchObject({ hitType: 6, sparkType: 3, blocked: true });
    expect(res2.snaps.some((s) => s.state.freezeTicks === 24)).toBe(true);
  });

  it('破防（能量不足）：breakDef 冻 30 tick + payload.breakDef', () => {
    let sim = new Sim(makeConfig({ defense2: 0 }));
    sim = mutated(sim, (s) => {
      s.fighters[1]!.energy = 1; // drain = min(50, 30/5) = 6 > 1
    });
    const res = play(sim, [[1, Btn.attack, Btn.down], [30, 0, Btn.down]]);
    const ev = firstHit(res.events);
    expect(ev.payload).toMatchObject({ sparkType: 1, blocked: true, breakDef: true });
    expect(res.snaps.some((s) => s.state.freezeTicks === 30)).toBe(true);
  });
});
