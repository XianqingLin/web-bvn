import { describe, expect, it } from 'vitest';
import {
  Btn,
  Sim,
  evaluateTriggerCondition,
  type AreaRect,
  type BehaviorArg,
  type BehaviorContext,
  type FighterDef,
  type SimConfig,
  type TriggerCondition,
} from '../src/index.js';

/**
 * 切片 11 机制测试：条件触发（原版 if($xx_ctrler.query()){...}else{...} 帧脚本）。
 * 查询求值语义（justHit/targetInRange/getTargetState/getSelf/getTargetSP）
 * 与 sim 分派（then/else 分支体、negate、cmp）。
 */

const HIT = {
  power: 30,
  hitType: 1,
  hitx: 2,
  hity: 0,
  hurtTime: 300,
  hurtType: 0,
  isBreakDef: false,
  isApplyG: true,
};

function makeDef(triggers: FighterDef['triggers']): FighterDef {
  const areas: FighterDef['areas'] = {};
  for (let fr = 1; fr <= 60; fr++) {
    const list: AreaRect[] = [{ name: 'bdmn', x: -10, y: -40, w: 20, h: 40 }];
    if (fr >= 58 && fr <= 60) list.push({ name: 'k1atm', x: 10, y: -40, w: 30, h: 30 });
    areas[fr] = list;
  }
  return {
    id: 'test',
    formIndex: 0,
    rootFrame: 1,
    speed: 6,
    jumpPower: 15,
    heavy: 3,
    actions: { k1: { ...HIT } },
    labels: {
      站立: { index: 0, duration: 9 },
      走: { index: 9, duration: 24 },
      落: { index: 44, duration: 6 },
      砍1: { index: 54, duration: 6 },
      击飞: { index: 79, duration: 10 },
    },
    areas,
    totalFrames: 60,
    triggers,
    attackLabels: { k1: '砍1' },
  };
}

function makeConfig(def: FighterDef): SimConfig {
  return {
    seed: 1,
    stage: { leftBound: 0, rightBound: 1000, groundY: 400, bottomY: 600, floors: [] },
    fighters: [
      { id: 1, x: 200, def },
      { id: 2, x: 400, def },
    ],
  };
}

function minimalCtx(f: {
  x: number;
  y: number;
  facing: 1 | -1;
}): BehaviorContext {
  // 求值器只用 f/fighters/stage；其余桥接字段给空实现。
  // targetOf 按 id 区分目标，id 必须显式给出；f 与 fighters[0] 同引用。
  const self = { ...f, id: 1 };
  const target = { ...f, id: 2, facing: (f.facing === 1 ? -1 : 1) as 1 | -1 };
  return {
    f: self as never,
    def: null,
    fighters: [self as never, target as never],
    stage: { leftBound: 0, rightBound: 1000, groundY: 400, bottomY: 600, floors: [] },
    emit: () => {},
    spawnBullet: () => {},
    spawnAttacker: () => {},
    switchForm: () => {},
  };
}

describe('条件查询求值语义', () => {
  it('targetInRange：前向距离窗（朝向相对 x + y 差）', () => {
    const ctx = minimalCtx({ x: 200, y: 400, facing: 1 });
    const cond: TriggerCondition = { target: 'fighter', op: 'targetInRange', args: [[0, 300]] };
    ctx.fighters[1]!.x = 400; // 前向 200
    expect(evaluateTriggerCondition(cond, ctx)).toBe(true);
    ctx.fighters[1]!.x = 600; // 前向 400 超窗
    expect(evaluateTriggerCondition(cond, ctx)).toBe(false);
    // 背对目标：前向距离为负，窗 [0,300] 不含
    const back = minimalCtx({ x: 400, y: 400, facing: 1 });
    back.fighters[1]!.x = 200;
    expect(evaluateTriggerCondition(cond, back)).toBe(false);
    // y 窗
    const withY: TriggerCondition = {
      target: 'fighter',
      op: 'targetInRange',
      args: [[0, 300], [-50, 50]],
    };
    ctx.fighters[1]!.x = 300;
    ctx.fighters[1]!.y = 410;
    expect(evaluateTriggerCondition(withY, ctx)).toBe(true);
    ctx.fighters[1]!.y = 500;
    expect(evaluateTriggerCondition(withY, ctx)).toBe(false);
  });

  it('getSelf/getTargetSP 属性链 + cmp', () => {
    const ctx = minimalCtx({ x: 0, y: 400, facing: 1 });
    (ctx.fighters[0] as { onGround: boolean }).onGround = true;
    const inAir: TriggerCondition = {
      target: 'fighter',
      op: 'getSelf',
      args: [],
      path: ['isInAir'],
    };
    expect(evaluateTriggerCondition(inAir, ctx)).toBe(false);
    (ctx.fighters[0] as { onGround: boolean }).onGround = false;
    expect(evaluateTriggerCondition(inAir, ctx)).toBe(true);
    // hp < hpMax 形态
    const hp: TriggerCondition = {
      target: 'fighter',
      op: 'getSelf',
      args: [],
      path: ['hp'],
      cmp: { op: '<', value: 1000 },
    };
    (ctx.fighters[0] as { hp: number }).hp = 500;
    expect(evaluateTriggerCondition(hp, ctx)).toBe(true);
    (ctx.fighters[0] as { hp: number }).hp = 1000;
    expect(evaluateTriggerCondition(hp, ctx)).toBe(false);
  });

  it('getTargetState 比较 + negate', () => {
    const ctx = minimalCtx({ x: 0, y: 400, facing: 1 });
    (ctx.fighters[1] as { actionState: number }).actionState = 21;
    const cond: TriggerCondition = {
      target: 'fighter',
      op: 'getTargetState',
      args: [],
      cmp: { op: '==', value: 21 },
    };
    expect(evaluateTriggerCondition(cond, ctx)).toBe(true);
    expect(evaluateTriggerCondition({ ...cond, negate: true }, ctx)).toBe(false);
    (ctx.fighters[1] as { actionState: number }).actionState = 0;
    expect(evaluateTriggerCondition(cond, ctx)).toBe(false);
  });

  it('justHit：目标 lastHurtHitId 匹配（含防御可选）', () => {
    const ctx = minimalCtx({ x: 0, y: 400, facing: 1 });
    (ctx.fighters[1] as { lastHurtHitId: string | null }).lastHurtHitId = 'k1';
    (ctx.fighters[1] as { lastDefHitId: string | null }).lastDefHitId = null;
    const cond: TriggerCondition = { target: 'fighter', op: 'justHit', args: ['k1'] };
    expect(evaluateTriggerCondition(cond, ctx)).toBe(true);
    expect(evaluateTriggerCondition({ ...cond, negate: true }, ctx)).toBe(false);
    (ctx.fighters[1] as { lastHurtHitId: string | null }).lastHurtHitId = 'k2';
    expect(evaluateTriggerCondition(cond, ctx)).toBe(false);
    // 防御命中在 includeDefense=true 时也成立
    (ctx.fighters[1] as { lastDefHitId: string | null }).lastDefHitId = 'k1';
    expect(evaluateTriggerCondition({ ...cond, args: ['k1', true] as BehaviorArg[] }, ctx)).toBe(true);
  });

  it('未知查询 op = false（确定性静默）', () => {
    const ctx = minimalCtx({ x: 0, y: 400, facing: 1 });
    expect(
      evaluateTriggerCondition({ target: 'fighter', op: 'getAttacker', args: ['x'] }, ctx),
    ).toBe(false);
  });
});

describe('条件触发 sim 分派', () => {
  it('cond 成立走 then、不成立走 else（每帧标签驱动验证）', () => {
    // 帧 5 触发（站立帧区间内）：targetInRange([0,1000]) → then gotoAndPlay 砍1 / else gotoAndPlay 落
    // 角色相距 200 ∈ 窗 → 走 then。
    const def = makeDef([
      {
        frame: 5,
        target: 'mc',
        op: 'if',
        args: [],
        cond: { target: 'fighter', op: 'targetInRange', args: [[0, 1000]] },
        then: [{ target: 'mc', op: 'gotoAndPlay', args: ['砍1'] }],
        else: [{ target: 'mc', op: 'gotoAndPlay', args: ['落'] }],
      },
    ]);
    const sim = new Sim(makeConfig(def));
    const mask = 0;
    // 推进到触发执行（标签切到 砍1 且未播完）为止
    let state: { fighters: { id: number; actLabel: string | null }[] } | null = null;
    let found = false;
    for (let i = 0; i < 200; i++) {
      sim.tick({ p1: mask, p2: mask });
      state = JSON.parse(sim.serializeState()) as {
        fighters: { id: number; actLabel: string | null }[];
      };
      if (state.fighters[0]!.actLabel === '砍1') {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
    expect(state!.fighters[1]!.actLabel).toBe('砍1');
  });

  it('else 分支在条件不成立时执行', () => {
    const def = makeDef([
      {
        frame: 5,
        target: 'mc',
        op: 'if',
        args: [],
        cond: { target: 'fighter', op: 'targetInRange', args: [[500, 1000]] },
        then: [{ target: 'mc', op: 'gotoAndPlay', args: ['砍1'] }],
        else: [{ target: 'mc', op: 'gotoAndPlay', args: ['落'] }],
      },
    ]);
    const sim = new Sim(makeConfig(def)); // 相距 200，不在 [500,1000]
    const mask = 0;
    let sawFall = false;
    for (let i = 0; i < 200; i++) {
      sim.tick({ p1: mask, p2: mask });
      const st = JSON.parse(sim.serializeState()) as {
        fighters: { id: number; actLabel: string | null }[];
      };
      if (st.fighters[0]!.actLabel === '落') {
        sawFall = true;
        break;
      }
    }
    expect(sawFall).toBe(true);
  });

  it('含条件触发的对局双跑哈希一致（确定性）', () => {
    const def = makeDef([
      {
        frame: 3,
        target: 'mc',
        op: 'if',
        args: [],
        cond: { target: 'fighter', op: 'getTargetState', args: [], cmp: { op: '==', value: 0 } },
        then: [{ target: 'fighter', op: 'addQi', args: [10] }],
        else: [{ target: 'mc', op: 'gotoAndPlay', args: ['走'] }],
      },
      {
        frame: 6,
        target: 'mc',
        op: 'if',
        args: [],
        cond: { target: 'fighter', op: 'targetInRange', args: [[0, 1000]] },
        then: [{ target: 'mc', op: 'gotoAndPlay', args: ['砍1'] }],
      },
    ]);
    const run = () => {
      const sim = new Sim(makeConfig(def));
      let hash = '';
      for (let i = 0; i < 120; i++) {
        const mask = i % 20 < 3 ? Btn.attack : 0;
        hash = sim.tick({ p1: mask, p2: 0 }).hash;
      }
      return hash;
    };
    expect(run()).toBe(run());
  });
});
