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
 * 切片 55：受击被动——替身 replaceSkill（comicType 1）/ 灵压爆发
 * energyExplode（comicType 0）。触发门与两套机制的确定性验收：
 *
 * 手工 def（同 hitstop.test 简化版）：站立 1-9、砍1 55-71（k1atm 58-59，
 * power 30 硬直 hurtType 0）、被打段 71-79。P1@100 / P2@130，k1 命中
 * → P2 进 HURT_ING 硬直（hurtTime 300ms = 9 动画帧），期间按住辅助键
 * （原版 specailSkill = 按住）+ 资源满足 → 被动触发。
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

function makeDef(): FighterDef {
  const labels: FighterDef['labels'] = {
    站立: { index: 0, duration: 9 },
    被打: { index: 71, duration: 8 },
    击飞: { index: 79, duration: 10 },
    击飞_倒: { index: 89, duration: 9 },
    起身: { index: 98, duration: 9 },
    砍1: { index: 54, duration: 17 },
  };
  const areas: FighterDef['areas'] = {};
  for (let fr = 1; fr <= 120; fr++) {
    const list: AreaRect[] = [{ name: 'bdmn', x: -10, y: -40, w: 20, h: 40 }];
    if (fr === 58 || fr === 59) list.push({ name: 'k1atm', x: 10, y: -40, w: 30, h: 30 });
    areas[fr] = list;
  }
  return {
    id: 'test',
    formIndex: 0,
    speed: 6,
    jumpPower: 15,
    heavy: 3,
    defenseType: 0,
    actions: {
      k1: { power: 30, hitType: 1, hitx: 3, hity: 0, hurtTime: 300, hurtType: 0, isBreakDef: false, isApplyG: true } satisfies HitDef,
    },
    labels,
    areas,
    totalFrames: 120,
    triggers: [
      { frame: 69, target: 'mc', op: 'endAct', args: [] },
      { frame: 70, target: 'mc', op: 'idle', args: ['站立'] },
    ],
    attackLabels: { k1: '砍1' },
  };
}

function makeConfig(opts: { comic2?: number; qi2?: number; energy2?: number } = {}): SimConfig {
  return {
    seed: 1,
    stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
    fighters: [
      { id: 1, x: 100, def: makeDef() },
      {
        id: 2,
        x: 130,
        def: makeDef(),
        ...(opts.comic2 !== undefined ? { comicType: opts.comic2 } : {}),
      },
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

/** P1 出刀 → P2 受击 HURT_ING 期间 P2 按住辅助键（segments 覆盖整个硬直窗）。 */
function triggerSegments(): [number, number, number][] {
  return [
    [1, Btn.attack, 0],
    [6, 0, 0],
    [30, 0, Btn.assist],
    [220, 0, 0],
  ];
}

describe('受击被动 · 替身 replaceSkill（comicType 1）', () => {
  it('HURT_ING + 辅助键按住 → 瞬移目标旁 + 回血 + 演出冻结 20 tick', () => {
    const sim = mutated(new Sim(makeConfig({ comic2: 1 })), (s) => {
      s.fighters[1]!.qi = 100;
    });
    const res = play(sim, triggerSegments());
    const start = res.snaps.findIndex((s) => s.state.passiveFreeze !== undefined);
    expect(start).toBeGreaterThanOrEqual(0);
    // 消耗：qi 100 + 受击回气 2.55 − 消耗 100 = 2.55；能量 100−100 = 0
    //（原版门 50 但消耗 100，照搬；满能量恰好归零不透支）
    const s0 = res.snaps[start]!.state.fighters[1]!;
    expect(s0.qi).toBeCloseTo(2.55, 5);
    expect(s0.energy).toBe(0);
    expect(s0.energyOverload).toBe(false);
    // 演出事件：replaceSkill 钉预瞬移点（x=130；replaceSp/replaceSp2 特效由
    // 渲染层按本事件 + passiveFreeze 快照差分补放，core 不发火花 id）
    const ev = res.events.find((e) => e.type === 'effect' && e.payload['id'] === 'replaceSkill');
    expect(ev).toBeDefined();
    expect(ev!.payload['x']).toBe(130);
    // 冻结：passiveFreeze {replace,20} 起，逐 tick 递减，全场动画停走
    const pf = res.snaps[start]!.state.passiveFreeze!;
    expect(pf).toMatchObject({ kind: 'replace', ownerId: 2, ticksLeft: 20 });
    for (let k = 1; k < 20; k++) {
      expect(res.snaps[start + k]!.state.passiveFreeze!.ticksLeft).toBe(20 - k);
      expect(res.snaps[start + k]!.state.fighters[0]!.animFrame).toBe(
        res.snaps[start]!.state.fighters[0]!.animFrame,
      );
    }
    // 替身瞬移（原版 moveToTarget(200,0)：目标贴左版边镜像 → P1.x+200=300）+
    // 回血（hurtHit.getDamage() = 30，clamp hpMax）+ 回站立 + 残效免伤
    //（replaceTicks 触发 tick 即计入动画步 → 首个快照 ≤30）
    expect(s0.x).toBe(300);
    expect(s0.hp).toBe(1000);
    expect(s0.actionState).toBe(0); // NORMAL
    expect(s0.replaceTicks).toBeGreaterThan(0);
    expect(s0.replaceTicks!).toBeLessThanOrEqual(30);
    expect(s0.isAllowBeHit).toBe(false);
    expect(s0.hurtChain).toBeUndefined();
    // 残效到期：30 动画帧 = 60 tick 后恢复可被命中
    const after = res.snaps[start + 80]!.state.fighters[1]!;
    expect(after.replaceTicks).toBeUndefined();
    expect(after.isAllowBeHit).toBe(true);
  });

  it('qi < 100 不触发（受击回气 2.55 不足以补足门）', () => {
    const sim = mutated(new Sim(makeConfig({ comic2: 1 })), (s) => {
      s.fighters[1]!.qi = 90;
    });
    const res = play(sim, triggerSegments());
    expect(res.snaps.some((s) => s.state.passiveFreeze !== undefined)).toBe(false);
  });

  it('energy < 50 不触发（冻结回充冷却，排除触发窗内回充翻越门）', () => {
    const sim = mutated(new Sim(makeConfig({ comic2: 1 })), (s) => {
      s.fighters[1]!.qi = 100;
      s.fighters[1]!.energy = 30;
      s.fighters[1]!.energyGap = 300; // 触发窗内能量回充被 gap 压住
    });
    const res = play(sim, triggerSegments());
    expect(res.snaps.some((s) => s.state.passiveFreeze !== undefined)).toBe(false);
  });
});

describe('受击被动 · 灵压爆发 energyExplode（comicType 0）', () => {
  it('定身 + 钢身 + 定点命中窗：对手吃 power 50 / hitType 5 击飞', () => {
    const sim = mutated(new Sim(makeConfig({ qi2: 100 })), (s) => {
      s.fighters[1]!.qi = 100;
    });
    const res = play(sim, triggerSegments());
    const start = res.snaps.findIndex((s) => s.state.passiveFreeze !== undefined);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(res.snaps[start]!.state.passiveFreeze).toMatchObject({
      kind: 'explode',
      ownerId: 2,
      ticksLeft: 42,
    });
    // 演出事件 + 钢身 + 定点命中区（世界坐标：facing -1 → x = 130+100-200=30）
    expect(
      res.events.some((e) => e.type === 'effect' && e.payload['id'] === 'startEnergyExplode'),
    ).toBe(true);
    const s0 = res.snaps[start]!.state.fighters[1]!;
    expect(s0.steelBody).toBe(true);
    expect(s0.explodeHit).toMatchObject({ x: 30, y: 300, w: 200, h: 210, facing: -1 });
    // 触发 tick 即计入动画步（animate tick 上同帧递减）→ 首个快照 9 或 10
    expect(s0.explodeHitTicks).toBeGreaterThan(8);
    expect(s0.explodeSteelTicks).toBeGreaterThan(55);
    // 冻结 42 tick 逐减（tick 42 减到 0 后清除）
    expect(res.snaps[start + 41]!.state.passiveFreeze!.ticksLeft).toBe(1);
    expect(res.snaps[start + 42]!.state.passiveFreeze).toBeUndefined();
    // 命中窗激活（t 7..1）：P1 在爆发区内 → 吃 50 伤害 + 击飞（hurtType 1）
    const hit = res.events.find(
      (e) => e.type === 'hit:connect' && e.payload['hitType'] === 5,
    );
    expect(hit).toBeDefined();
    const p1Hit = res.snaps.find(
      (s) => s.state.fighters[0]!.actionState === 22, // HURT_FLYING
    );
    expect(p1Hit).toBeDefined();
    expect(p1Hit!.state.fighters[0]!.hp).toBe(1000 - 50);
    // 钢身残效：60 动画帧 = 120 tick 后自然收钢身
    const late = res.snaps[res.snaps.length - 1]!.state.fighters[1]!;
    expect(late.explodeSteelTicks).toBeUndefined();
    expect(late.steelBody).toBe(false);
    expect(late.explodeHit).toBeUndefined();
    expect(late.isAllowBeHit).toBe(true);
  });
});
