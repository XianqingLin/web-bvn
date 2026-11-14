import { describe, expect, it } from 'vitest';
import {
  ActionState,
  Btn,
  Sim,
  type AreaRect,
  type FighterDef,
  type SimConfig,
  type SimEvent,
  type SimState,
} from '../src/index.js';

/**
 * 切片 9 机制测试：回气资源 / 摔技与抓取吸附 / 目标系 op / 万解 / 空中槽 /
 * 自定义受击动作 / 独立道具（addAttacker）。
 * def 帧布局在切片 5 基础上追加：万解 281-310、跳砍 311-322（jk1atm 316-317）、
 * 摔1 323-342（mtmc 锚点区全程）、跳招 343-352、招2_CHK 353-362。
 * 命中续接检查区 chkm 在 招1 帧 183-190；独立道具生成区 zh3mc 在 招1 帧 185-190。
 */

const HIT_K1 = {
  power: 30,
  hitType: 1,
  hitx: 3,
  hity: 0,
  hurtTime: 300,
  hurtType: 0,
  isBreakDef: false,
  isApplyG: true,
};

function makeDef(): FighterDef {
  const labels: FighterDef['labels'] = {
    站立: { index: 0, duration: 9 },
    走: { index: 9, duration: 24 },
    起跳: { index: 33, duration: 5 },
    跳中: { index: 38, duration: 6 },
    落: { index: 44, duration: 6 },
    落地: { index: 50, duration: 4 },
    砍1: { index: 54, duration: 17 },
    被打: { index: 71, duration: 8 },
    击飞: { index: 79, duration: 10 },
    击飞_倒: { index: 89, duration: 9 },
    起身: { index: 98, duration: 9 },
    失败: { index: 122, duration: 20 },
    防御: { index: 142, duration: 6 },
    防御恢复: { index: 148, duration: 12 },
    瞬步: { index: 160, duration: 20 },
    招1: { index: 180, duration: 30 },
    必杀: { index: 210, duration: 50 },
    砍2: { index: 260, duration: 17 },
    万解: { index: 280, duration: 30 },
    跳砍: { index: 311, duration: 12 },
    摔1: { index: 323, duration: 20 },
    跳招: { index: 343, duration: 10 },
    招2_CHK: { index: 353, duration: 10 },
  };
  const areas: FighterDef['areas'] = {};
  for (let fr = 1; fr <= 362; fr++) {
    const list: AreaRect[] = [{ name: 'bdmn', x: -10, y: -40, w: 20, h: 40 }];
    if (fr === 58 || fr === 59) list.push({ name: 'k1atm', x: 10, y: -40, w: 30, h: 30 });
    if (fr === 316 || fr === 317) list.push({ name: 'jk1atm', x: 10, y: -40, w: 30, h: 30 });
    if (fr === 215 || fr === 216) list.push({ name: 'bsatm', x: 10, y: -40, w: 30, h: 30 });
    if (fr >= 324 && fr <= 343) list.push({ name: 'mtmc', x: 20, y: -30, w: 20, h: 20 });
    if (fr >= 353 && fr <= 362) list.push({ name: 'k2atm', x: 10, y: -40, w: 30, h: 30 });
    if (fr >= 183 && fr <= 190) list.push({ name: 'chkm', x: 10, y: -40, w: 30, h: 30 });
    if (fr >= 185 && fr <= 190) list.push({ name: 'zh3mc', x: 10, y: -40, w: 30, h: 30 });
    areas[fr] = list;
  }
  return {
    id: 'test',
    formIndex: 0,
    speed: 6,
    jumpPower: 15,
    heavy: 3,
    actions: {
      k1: { ...HIT_K1 },
      k2: { ...HIT_K1 },
      zh1: { ...HIT_K1 },
      zh3: { ...HIT_K1 },
      jk1: { ...HIT_K1 },
      sh1: { ...HIT_K1 },
      bs: { power: 100, hitType: 5, hitx: 10, hity: 0, hurtTime: 0, hurtType: 1, isBreakDef: false, isApplyG: true },
    },
    labels,
    areas,
    totalFrames: 362,
    triggers: [
      // 摔1 首帧（index 323 → 帧号 324）：抓取吸附（锚点 mtmc 判定区中心）；
      // 释放由 sim 吸附巡检（动作结束）
      { frame: 324, target: 'mc', op: 'moveTarget', args: [{ followmc: 'mtmc' }] },
      // 招1 第 3 帧：命中续接检查区 → 与目标身体相交后切 招2_CHK
      { frame: 183, target: 'mc', op: 'setHitTarget', args: ['chkm', '招2_CHK'] },
      // 招1 第 4 帧：瞬移到目标旁（语料 [30,0,true]）
      { frame: 184, target: 'mc', op: 'moveToTarget', args: [30, 0, true] },
      // 招1 第 5 帧：独立道具（跟随目标，悬停）
      { frame: 185, target: 'mc', op: 'addAttacker', args: ['zh3mc', { x: { followTarget: true, offset: 0 }, y: { followTarget: true, offset: -25 }, applyG: false }] },
      // 万解首帧（index 280 → 帧号 281）：万解演出事件（effect 消费）
      { frame: 281, target: 'effect', op: 'startWanKai', args: [] },
      // 站立第 5 帧：自定义受击动作（自我携带——被攻击时播专用受击动画）
      { frame: 5, target: 'fighter', op: 'setHurtAction', args: ['被打'] },
      // 招1 第 6 帧：投技携带受击方受击动画（攻击方动作时间轴触发）
      { frame: 186, target: 'fighter', op: 'setHurtAction', args: ['被打'] },
      // 动作标签尾部 endAct + idle 重定向（真实数据同构，修复批次 20）：
      // 时间轴顺流只发生在无收尾脚本的连续标签；本 fixture 的
      // 砍1→被打、招1→必杀、必杀→砍2、砍2→万解、跳砍→摔1、摔1→跳招、
      // 跳招→招2_CHK 帧号全部连续，攻击态须由收尾脚本终止
      { frame: 69, target: 'mc', op: 'endAct', args: [] },
      { frame: 70, target: 'mc', op: 'idle', args: ['站立'] },
      { frame: 208, target: 'mc', op: 'endAct', args: [] },
      { frame: 209, target: 'mc', op: 'idle', args: ['站立'] },
      { frame: 258, target: 'mc', op: 'endAct', args: [] },
      { frame: 259, target: 'mc', op: 'idle', args: ['站立'] },
      { frame: 275, target: 'mc', op: 'endAct', args: [] },
      { frame: 276, target: 'mc', op: 'idle', args: ['站立'] },
      { frame: 321, target: 'mc', op: 'endAct', args: [] },
      { frame: 322, target: 'mc', op: 'idle', args: ['站立'] },
      { frame: 341, target: 'mc', op: 'endAct', args: [] },
      { frame: 342, target: 'mc', op: 'idle', args: ['站立'] },
      { frame: 351, target: 'mc', op: 'endAct', args: [] },
      { frame: 352, target: 'mc', op: 'idle', args: ['站立'] },
    ],
    attackLabels: { k1: '砍1', k2: '砍2', zh1: '招1', jk1: '跳砍', sh1: '摔1', bs: '必杀' },
  };
}

function makeConfig(opts: { p2x?: number; def?: FighterDef } = {}): SimConfig {
  const def = opts.def ?? makeDef();
  return {
    seed: 1,
    stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
    fighters: [
      { id: 1, x: 100, def },
      { id: 2, x: opts.p2x ?? 130, def },
    ],
  };
}

/** 追加帧触发器（构造前注入 def，constructor 建索引）+ 状态预置。
 * dropTriggers：按 op 名剔除默认触发器（addAttacker 用例需绕开
 * 命中续接——瞬移后 chkm 立即与目标身体相交会抢先切 招2_CHK）。 */
function makeSim(
  opts: {
    p2x?: number;
    triggers?: { frame: number; target: string; op: string; args: unknown[] }[];
    dropTriggers?: string[];
    mutate?: (s: SimState) => void;
  } = {},
): Sim {
  const def = makeDef();
  if (opts.dropTriggers) {
    def.triggers = def.triggers.filter((t) => !opts.dropTriggers!.includes(t.op));
  }
  for (const t of opts.triggers ?? []) {
    def.triggers.push(t as never);
  }
  const sim = new Sim(makeConfig({ p2x: opts.p2x, def }));
  if (opts.mutate) {
    const state = JSON.parse(sim.serializeState()) as SimState;
    opts.mutate(state);
    return Sim.fromState(state, sim.getDefEntries());
  }
  return sim;
}

interface PlayResult {
  sim: Sim;
  events: SimEvent[];
  snaps: { tick: number; state: SimState }[];
}

function play(sim: Sim, segments: [number, number, number][]): PlayResult {
  const events: SimEvent[] = [];
  const snaps: { tick: number; state: SimState }[] = [];
  for (const [frames, p1, p2] of segments) {
    for (let i = 0; i < frames; i++) {
      const snap = sim.tick({ p1, p2 });
      events.push(...snap.events);
      snaps.push({ tick: snap.tick, state: snap.state });
    }
  }
  return { sim, events, snaps };
}

describe('切片 9：回气资源', () => {
  it('近战命中回气：攻击方 power×0.16 封顶 15，受击方 power×0.085 封顶 20', () => {
    const res = play(new Sim(makeConfig()), [[10, Btn.attack, 0]]);
    const p1 = res.snaps.at(-1)!.state.fighters[0]!;
    const p2 = res.snaps.at(-1)!.state.fighters[1]!;
    expect(p1.qi).toBeCloseTo(30 * 0.16); // 4.8（非必杀 k1）
    expect(p2.qi).toBeCloseTo(30 * 0.085); // 2.55
  });

  it('必杀命中攻击方不回气，受击方照常回气', () => {
    const sim = makeSim({ mutate: (s) => { s.fighters[0]!.qi = 100; } });
    const res = play(sim, [[10, Btn.superSkill, 0]]);
    expect(res.snaps.at(-1)!.state.fighters[0]!.qi).toBe(0); // 扣 100，bs 命中不回
    expect(res.snaps.at(-1)!.state.fighters[1]!.qi).toBeCloseTo(100 * 0.085);
  });

  it('回气封顶：power×0.16 ≤ 15、power×0.085 ≤ 20', () => {
    const def = makeDef();
    def.actions['k1'].power = 500;
    const sim = new Sim(makeConfig({ def }));
    const res = play(sim, [[10, Btn.attack, 0]]);
    expect(res.snaps.at(-1)!.state.fighters[0]!.qi).toBeCloseTo(15);
    expect(res.snaps.at(-1)!.state.fighters[1]!.qi).toBeCloseTo(20);
  });
});

describe('切片 9：摔技与抓取吸附', () => {
  it('攻击键 + 朝目标移动 + 贴身 → 摔技触发（SKILL_ING）', () => {
    // 先走近贴身（推挤后间隙 <2px），再 攻击+前方向
    const res = play(new Sim(makeConfig()), [
      [4, Btn.right, 0],
      [1, Btn.attack | Btn.right, 0],
    ]);
    const p1 = res.snaps.at(-1)!.state.fighters[0]!;
    expect(p1.actionState).toBe(ActionState.SKILL_ING);
    expect(p1.actLabel).toBe('摔1');
    expect(p1.attackId).toBe('sh1');
  });

  it('moveTarget：目标被吸向自身锚点区中心，动作结束释放并恢复重力', () => {
    const res = play(new Sim(makeConfig()), [
      [4, Btn.right, 0],
      [1, Btn.attack | Btn.right, 0],
      [46, 0, 0],
    ]);
    const grabTickSnap = res.snaps.find((s) => s.state.fighters[0]!.moveTarget !== null);
    expect(grabTickSnap).toBeDefined();
    // 吸附中：目标在自身前方（锚点区中心 x = P1.x + 30×facing）
    if (grabTickSnap) {
      const p1 = grabTickSnap.state.fighters[0]!;
      const p2 = grabTickSnap.state.fighters[1]!;
      expect(p2.x).toBeGreaterThan(p1.x);
    }
    // 动作结束（吸附巡检：攻击态结束即释放）+ 目标重力恢复
    expect(res.snaps.at(-1)!.state.fighters[0]!.moveTarget).toBeNull();
    expect(res.snaps.at(-1)!.state.fighters[1]!.applyG).toBe(true);
  });
});

describe('切片 9：目标系 op', () => {
  it('setHitTarget：检查区与目标身体相交 → 切续接标签并清除', () => {
    const res = play(new Sim(makeConfig()), [[12, Btn.skill, 0]]);
    const switched = res.snaps.find((s) => s.state.fighters[0]!.actLabel === '招2_CHK');
    expect(switched).toBeDefined();
    expect(switched!.state.fighters[0]!.hitTarget).toBeNull();
    expect(switched!.state.fighters[0]!.hitTargetChecker).toBeNull();
  });

  it('moveToTarget：瞬移到目标旁并转身（语料 [30,0,true]）', () => {
    const res = play(makeSim({ p2x: 700 }), [[1, Btn.skill, 0], [7, 0, 0]]);
    const p1 = res.snaps.at(-1)!.state.fighters[0]!;
    // fx = t.x + 30×facing = 730（推挤/clamp 后 ≈735），setDirect → 背向目标
    expect(Math.abs(p1.x - 735)).toBeLessThan(15);
    expect(p1.facing).toBe(-1);
  });

  it('hurtFly：主动击飞（HURT_FLYING + 击飞标签 + 后撤位移）', () => {
    const res = play(
      makeSim({ triggers: [{ frame: 5, target: 'mc', op: 'hurtFly', args: [-15, -5] }] }),
      [[14, 0, 0]],
    );
    const s = res.snaps.find((s) => s.state.fighters[0]!.actionState === ActionState.HURT_FLYING);
    expect(s).toBeDefined();
    expect(s!.state.fighters[0]!.actLabel).toBe('击飞');
    // 后撤（x<0 沿朝向反演）：物理下一 tick 生效
    const moved = res.snaps.find((s2) => s2.state.fighters[0]!.x < 100);
    expect(moved).toBeDefined();
  });

  it('loseHp：自削血；归零 → 死亡 + fighter:ko', () => {
    const res = play(
      makeSim({
        triggers: [{ frame: 5, target: 'fighter', op: 'loseHp', args: [100] }],
        mutate: (s) => { s.fighters[0]!.hp = 50; },
      }),
      [[14, 0, 0]],
    );
    const p1 = res.snaps.at(-1)!.state.fighters[0]!;
    expect(p1.hp).toBe(0);
    expect(p1.actionState).toBe(ActionState.DEAD);
    expect(res.events.some((e) => e.type === 'fighter:ko')).toBe(true);
  });

  it('addHp 系：clamp 到 hpMax；addHpLosePercent 补已损比例', () => {
    const res = play(
      makeSim({
        triggers: [
          { frame: 5, target: 'fighter', op: 'addHpLosePercent', args: [0.5] },
          { frame: 7, target: 'fighter', op: 'addHpPercent', args: [10] },
        ],
        mutate: (s) => { s.fighters[0]!.hp = 500; },
      }),
      [[20, 0, 0]],
    );
    // 500 + (1000-500)×0.5 = 750，再 + hpMax×10 → clamp 1000
    expect(res.snaps.at(-1)!.state.fighters[0]!.hp).toBe(1000);
  });
});

describe('切片 9：万解', () => {
  it('攻击+跳 同按（qi≥300）→ WAN_KAI_ING + 开场演出事件', () => {
    const sim = makeSim({ mutate: (s) => { s.fighters[0]!.qi = 300; } });
    const res = play(sim, [[2, Btn.attack | Btn.jump, 0]]);
    const p1 = res.snaps.at(-1)!.state.fighters[0]!;
    expect(p1.actionState).toBe(ActionState.WAN_KAI_ING);
    expect(p1.qi).toBe(0); // 消耗 300
    expect(p1.isAllowBeHit).toBe(false); // 演出中不可被打
    expect(res.events.some((e) => e.type === 'effect' && (e.payload as { id?: string }).id === 'wanKai')).toBe(true);
  });

  it('qi 不足 300 → 不触发万解', () => {
    const sim = makeSim({ mutate: (s) => { s.fighters[0]!.qi = 299; } });
    const res = play(sim, [[2, Btn.attack | Btn.jump, 0]]);
    expect(res.snaps.at(-1)!.state.fighters[0]!.actionState).not.toBe(ActionState.WAN_KAI_ING);
  });
});

describe('切片 9：空中槽', () => {
  it('跳起后攻击 → 跳砍（attackAIR），airHitTimes 递减', () => {
    const res = play(new Sim(makeConfig()), [
      [1, Btn.jump, 0],
      [2, 0, 0], // 切片 10：JUMP_DELAY_GROUND 起跳延迟
      [1, Btn.attack, 0],
      [2, 0, 0],
    ]);
    const p1 = res.snaps.at(-1)!.state.fighters[0]!;
    expect(p1.actLabel).toBe('跳砍');
    expect(p1.attackId).toBe('jk1');
    expect(p1.airHitTimes).toBe(0);
  });

  it('空中攻击次数耗尽 → 落地前不再触发', () => {
    const res = play(new Sim(makeConfig()), [
      [1, Btn.jump, 0],
      [2, 0, 0], // 切片 10：起跳延迟
      [1, Btn.attack, 0],
      [2, 0, 0],
      [24, 0, 0], // 跳砍播完（12 动画帧 = 24 tick）
      [1, Btn.attack, 0], // 仍在空中，airHitTimes=0
      [2, 0, 0],
    ]);
    const p1 = res.snaps.at(-1)!.state.fighters[0]!;
    expect(p1.actLabel).not.toBe('跳砍');
  });
});

describe('切片 9：独立道具（addAttacker）', () => {
  it('生成事件 + followTarget 重定位 + 寿命到期消散', () => {
    // 剔除 setHitTarget：瞬移转身后 chkm 会立即与目标相交抢先切 招2_CHK，
    // 帧 185 的 addAttacker 就走不到了（真实连锁，见 setHitTarget 用例）
    const res = play(
      makeSim({ p2x: 200, dropTriggers: ['setHitTarget'] }),
      [[1, Btn.skill, 0], [210, 0, 0]],
    );
    const spawn = res.events.find(
      (e) => e.type === 'entity:spawn' && (e.payload as { kind?: string }).kind === 'attacker',
    );
    expect(spawn).toBeDefined();
    const mid = res.snaps.find((s) => s.state.attackers.length > 0)!;
    const a = mid.state.attackers[0]!;
    expect(a.applyG).toBe(false);
    expect(a.name).toBe('zh3mc');
    // B5 原点锚定：a.y = target.y + offsetY（元件原点）；生成帧判定区
    // 平移为回退矩形 fbHit（缺逐帧数据 = 以 local 中心为 org，世界矩形
    // 与旧中心语义等价：rect.y = a.y + fbHit.y = target.y - 25 - h/2）
    expect(a.y).toBe(mid.state.fighters[1]!.y - 25);
    expect(a.y + a.fbHit.y).toBe(mid.state.fighters[1]!.y - 25 - a.h / 2);
    // 寿命占位 120 tick 到期
    expect(res.snaps.at(-1)!.state.attackers).toHaveLength(0);
    expect(
      res.events.some(
        (e) => e.type === 'entity:despawn' && (e.payload as { kind?: string }).kind === 'attacker',
      ),
    ).toBe(true);
  });

  it('命中：扣血 + 所有者回气 power×0.15 + 投技携带受击动画 + 单次命中', () => {
    // P2 拉远：近战 zh1atm 打不到，仅道具命中；剔除默认 setHurtAction，
    // 改为道具生成同帧（185）携带——携带须先于道具命中结算
    const res = play(
      makeSim({
        p2x: 200,
        dropTriggers: ['setHitTarget', 'setHurtAction'],
        triggers: [{ frame: 185, target: 'fighter', op: 'setHurtAction', args: ['被打'] }],
      }),
      [[1, Btn.skill, 0], [12, 0, 0]],
    );
    const p2 = res.snaps.at(-1)!.state.fighters[1]!;
    expect(p2.hp).toBe(970); // 1000 - 30
    // 投技携带：受击方播专用受击动画而非通用受击态（HURT_ACT_ING）
    expect(p2.actLabel).toBe('被打');
    expect(p2.actionState).toBe(ActionState.HURT_ACT_ING);
    expect(p2.qi).toBeCloseTo(30 * 0.085); // 受击回气
    const p1 = res.snaps.at(-1)!.state.fighters[0]!;
    expect(p1.qi).toBeCloseTo(30 * 0.15); // 4.5（attacker 回气；zh3 非 bs）
    // 修复批次 34：默认 def 的 zh3mc 无逐帧 fires 数据 → 回退占位路径
    //（保留单次命中门的移植自创近似）；继续 tick 不再扣血。
    // 逐帧数据路径的多段命中见 B5 描述的多段命中窗用例。
    play(res.sim, [[10, 0, 0]]);
    expect(res.snaps.at(-1)!.state.fighters[1]!.hp).toBe(970);
  });

  // —— 切片 13-A5：attacker 元件时间轴生命周期（原版 FighterAttacker.renderAnimate） ——

  /** 注入 fires 元数据的 attacker sim（zh3mc → anim；剔 setHitTarget 同上）。 */
  function makeAnimSim(totalFrames: number, labels: Record<string, number> = {}): Sim {
    const def = makeDef();
    def.fires = { zh3mc: { totalFrames, labels } };
    def.triggers = def.triggers.filter((t) => t.op !== 'setHitTarget');
    return new Sim(makeConfig({ p2x: 200, def }));
  }

  it('anim 注入 + 30Hz 推进：发射帧已到 2、每 2 tick +1、播尽移除（off-by-one）', () => {
    const sim = makeAnimSim(9);
    // 按住 skill 进 招1，捕获首个含 attacker 的快照（生成 tick）
    let spawned: ReturnType<Sim['tick']> | null = null;
    for (let i = 0; i < 200 && !spawned; i++) {
      const s = sim.tick({ p1: i < 12 ? Btn.skill : 0, p2: 0 });
      if (s.state.attackers.length > 0) spawned = s;
    }
    expect(spawned).not.toBeNull();
    const a0 = spawned!.state.attackers[0]!;
    expect(a0.animTotal).toBe(9);
    expect(a0.animFrame).toBe(2); // 生成 tick 已推进一步（stepHitResolution 先行）
    // 每 2 tick +1：10 tick 后帧 7 仍在（未到 totalFrames-1）
    let mid: ReturnType<Sim['tick']> | null = null;
    for (let i = 0; i < 10; i++) mid = sim.tick({ p1: 0, p2: 0 });
    expect(mid!.state.attackers[0]!.animFrame).toBe(7);
    // 再 2 tick → 帧 8 = totalFrames-1 → 播尽移除（原版不播末帧）
    let end: ReturnType<Sim['tick']> | null = null;
    for (let i = 0; i < 2; i++) end = sim.tick({ p1: 0, p2: 0 });
    expect(end!.state.attackers).toHaveLength(0);
  });

  it('无 anim 数据（animTotal=0）回退 holdTicks 占位寿命', () => {    const sim = makeSim({ p2x: 200, dropTriggers: ['setHitTarget'] });
    let spawnTick = -1;
    for (let i = 0; i < 300; i++) {
      const s = sim.tick({ p1: i === 0 ? Btn.skill : 0, p2: 0 });
      if (spawnTick < 0 && s.state.attackers.length > 0) spawnTick = s.tick;
      if (spawnTick >= 0) {
        if (s.tick - spawnTick < 120) {
          expect(s.state.attackers.length).toBe(1); // 占位寿命内仍在
        } else {
          expect(s.state.attackers).toHaveLength(0); // 120 tick 到期消散
          break;
        }
      }
    }
    expect(spawnTick).toBeGreaterThanOrEqual(0);
  });

  it('setHurtAction（自我携带）：受击时播专用受击动画而非进受击态', () => {
    // 站立第 5 帧 setHurtAction('被打')（tick 8）；随后 P2 反击命中 P1
    const res = play(makeSim(), [
      [9, 0, 0],
      [1, 0, Btn.attack],
      [10, 0, 0],
    ]);
    const p1 = res.snaps.at(-1)!.state.fighters[0]!;
    expect(p1.hp).toBe(970);
    expect(p1.actLabel).toBe('被打');
    expect(p1.actionState).toBe(ActionState.HURT_ACT_ING);
    // 受击方回气（通用受击态与自定义受击动画都结算）
    expect(p1.qi).toBeCloseTo(30 * 0.085);
  });
});

// —— B5：逐帧命中矩形（fires org/hits；原版 FighterAttacker.findHitArea 语义） ——

/** 注入 org/hits 逐帧数据的 def（zh3mc 帧 2 命中区名可配；区矩形与生成
 * 帧判定区同形：{x:-15,y:-15,w:30,h:30}，org=(25,-25)=判定区中心）。 */
function makeFrameDef(hitName = 'zh3atm'): FighterDef {
  const def = makeDef();
  def.fires = {
    zh3mc: {
      totalFrames: 9,
      labels: {},
      org: { x: 25, y: -25 },
      hits: { '2': [{ name: hitName, x: -15, y: -15, w: 30, h: 30 }] },
    },
  };
  def.triggers = def.triggers.filter((t) => t.op !== 'setHitTarget');
  return def;
}

/** 播到首个含 attacker 的快照，再继续 tick 到动作收尾。 */
function playToAttacker(sim: Sim, extraTicks = 20): {
  spawn: ReturnType<Sim['tick']>;
  last: ReturnType<Sim['tick']>;
} {
  let spawn: ReturnType<Sim['tick']> | null = null;
  for (let i = 0; i < 200 && !spawn; i++) {
    const s = sim.tick({ p1: i < 12 ? Btn.skill : 0, p2: 0 });
    if (s.state.attackers.length > 0) spawn = s;
  }
  if (spawn === null) throw new Error('attacker 未生成');
  let last = spawn;
  for (let i = 0; i < extraTicks; i++) last = sim.tick({ p1: 0, p2: 0 });
  return { spawn, last };
}

describe('B5：逐帧命中矩形', () => {
  it('逐帧路径：hasFrameData 生成（hit/hitId=null + fbHit=local−org）+ 命中区帧解析命中', () => {
    const sim = new Sim(makeConfig({ p2x: 200, def: makeFrameDef() }));
    // 命中发生在 spawn 后 1~2 tick（followX 下一 tick 才把原点吸到 target），
    // 道具 animTotal=9 约 16 tick 播尽——少 tick 快照抓「命中后仍在场」
    const { spawn, last } = playToAttacker(sim, 2);
    const a = spawn.state.attackers[0]!;
    // hasFrameData：不再用动作表兜底（命中检查逐帧解析）
    expect(a.hit).toBeNull();
    expect(a.hitId).toBeNull();
    // 原点锚定：x/y = 锚点 + 轴 offset（x offset 0 → 锚点原值；y -25）。
    // followX 轴从下一 tick 起重定位到 target + offset（spawn tick 未走 stepAttackers）
    expect(a.x).toBe(spawn.state.fighters[0]!.x);
    expect(a.y).toBe(spawn.state.fighters[1]!.y - 25);
    // fbHit = 生成帧判定区 − org（元件局部 direct=1）
    expect(a.fbHit).toEqual({ x: -15, y: -15, w: 30, h: 30 });
    // 帧 2 命中区 zh3atm → 去 atm 解析 zh3 动作 → 与目标身体相交命中
    const p2 = last.state.fighters[1]!;
    expect(p2.hp).toBe(970); // 1000 - 30
    const p1 = last.state.fighters[0]!;
    expect(p1.qi).toBeCloseTo(30 * 0.15); // attacker 回气（zh3 非 bs）
    expect(spawn.state.attackers[0]!.hitAble).toBe(true);
    // 修复批次 34：拆除单次命中失效门——attacker 不因命中失效，多段命中
    // 靠受击方 4 帧无敌窗限频（hitAble 仅供回退占位路径使用）
    expect(last.state.attackers[0]!.hitAble).toBe(true);
  });

  it('命中区名无动作表解析 = 纯表现：全程无判定', () => {
    const sim = new Sim(makeConfig({ p2x: 200, def: makeFrameDef('xyzmc') }));
    const { last } = playToAttacker(sim, 30);
    expect(last.state.fighters[1]!.hp).toBe(1000);
  });

  it('修复批次 34：多段命中窗逐帧重复命中，频率由受击 4 帧窗限频（蓝染 bs1atm 同构）', () => {
    // zh3atm 命中窗铺满帧 2-8（7 个动画帧），followTarget 锚定使判定区始终
    // 套住目标——原版语义：attacker 不因命中失效，多段逐段扣血；移植版此前
    // 单次命中门让首段之后全部失效（蓝染 I 必杀"只出特效不掉血"根因）。
    const def = makeFrameDef();
    const hits: Record<string, { name: string; x: number; y: number; w: number; h: number }[]> = {};
    for (let fr = 2; fr <= 8; fr++) {
      hits[String(fr)] = [{ name: 'zh3atm', x: -15, y: -15, w: 30, h: 30 }];
    }
    def.fires = { zh3mc: { totalFrames: 9, labels: {}, org: { x: 25, y: -25 }, hits } };
    const sim = new Sim(makeConfig({ p2x: 200, def }));
    // 手动循环收集全部 hit:connect（spawn tick 事件 + 后续 tick）
    let spawn: ReturnType<Sim['tick']> | null = null;
    let last: ReturnType<Sim['tick']> | null = null;
    let hitCount = 0;
    for (let i = 0; i < 200 && !spawn; i++) {
      const s = sim.tick({ p1: i < 12 ? Btn.skill : 0, p2: 0 });
      if (s.state.attackers.length > 0) spawn = s;
    }
    if (spawn === null) throw new Error('attacker 未生成');
    hitCount += spawn.events.filter((e) => e.type === 'hit:connect').length;
    last = spawn;
    for (let i = 0; i < 20; i++) {
      last = sim.tick({ p1: 0, p2: 0 });
      hitCount += last!.events.filter((e) => e.type === 'hit:connect').length;
    }
    const p2 = last!.state.fighters[1]!;
    expect(p2.hp).toBeLessThan(970); // 多段扣血：首段之后仍有命中
    expect(hitCount).toBeGreaterThanOrEqual(2); // 至少两段
    expect(hitCount).toBeLessThanOrEqual(7); // 受击窗限频：不可能每帧命中
    expect(p2.hp).toBe(1000 - 30 * hitCount);
  });
});
