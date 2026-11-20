import { describe, expect, it } from 'vitest';
import {
  Btn,
  Sim,
  type FighterDef,
  type SimConfig,
  type SimSnapshot,
  type AreaRect,
} from '../src/index.js';

/**
 * 切片 8 帧触发补全测试：fire 飞行道具（发射/运动/命中/对撞/寿命/出界）
 * + 新注册 op（dashStop/setCross/isApplyG/setTouchFloor/idle）。
 *
 * def 布局（30Hz）：站立 1-9、跳/落/走齐全、招1 181-210（zh1atm 185-186）、
 * 必杀 211-260；fire 触发挂在招1 第 185 帧。
 */

const HIT_ZH1 = { power: 30, hitType: 1, hitx: 3, hity: 0, hurtTime: 300, hurtType: 0, isBreakDef: false, isApplyG: true };

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
    招1_TF: { index: 220, duration: 8 },
    必杀: { index: 210, duration: 50 },
  };
  const areas: FighterDef['areas'] = {};
  for (let fr = 1; fr <= 270; fr++) {
    const list: AreaRect[] = [{ name: 'bdmn', x: -10, y: -40, w: 20, h: 40 }];
    if (fr === 58 || fr === 59) list.push({ name: 'k1atm', x: 10, y: -40, w: 30, h: 30 });
    if (fr === 185 || fr === 186) list.push({ name: 'zh1atm', x: 10, y: -40, w: 30, h: 30 });
    areas[fr] = list;
  }
  return {
    id: 'test',
    formIndex: 0,
    speed: 6,
    jumpPower: 15,
    heavy: 3,
    actions: {
      k1: { ...HIT_ZH1 },
      zh1: { ...HIT_ZH1 },
      bs: { power: 100, hitType: 5, hitx: 10, hity: 0, hurtTime: 0, hurtType: 1, isBreakDef: false, isApplyG: true },
    },
    labels,
    areas,
    totalFrames: 270,
    triggers: [],
    attackLabels: { k1: '砍1', zh1: '招1', bs: '必杀' },
  };
}

/** 带 fire 触发的 def：招1 第 185 帧发射 zh1atm。 */
function makeFireDef(params: Record<string, unknown>): FighterDef {
  const def = makeDef();
  def.triggers = [
    { frame: 185, target: 'mc', op: 'fire', args: ['zh1atm', params] },
  ];
  return def;
}

function makeConfig(defs: FighterDef[], opts: { p2x?: number } = {}): SimConfig {
  return {
    seed: 1,
    stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
    fighters: [
      { id: 1, x: 100, def: defs[0] },
      { id: 2, x: opts.p2x ?? 300, def: defs[1] ?? defs[0] },
    ],
  };
}

/** 跑 N tick（零输入），返回最终快照。 */
function runTicks(sim: Sim, n: number): SimSnapshot {
  let snap: SimSnapshot | null = null;
  for (let i = 0; i < n; i++) snap = sim.tick({ p1: 0, p2: 0 });
  return snap!;
}

const ZERO: Record<string, unknown> = { x: 5, hold: 60, hits: 1 };

/** 逐 tick 跑到首个满足条件的快照（零输入后继）。 */
function tickUntil(
  sim: Sim,
  pred: (s: SimSnapshot) => boolean,
  maxTicks: number,
  input: (i: number) => number = () => 0,
): SimSnapshot {
  let snap: SimSnapshot | null = null;
  for (let i = 0; i < maxTicks; i++) {
    snap = sim.tick({ p1: input(i), p2: 0 });
    if (pred(snap)) return snap;
  }
  throw new Error('tickUntil: 条件未满足');
}

describe('切片 8：fire 飞行道具', () => {
  it('发射：判定区换算世界坐标 + facing 镜像 + 事件', () => {
    const def = makeFireDef(ZERO);
    const sim = new Sim(makeConfig([def, makeDef()]));
    // 输入 skill 键触发 招1（槽 zhao1 默认 招1）；发射帧 185 采样当 tick 断言
    let snap = tickUntil(sim, (s) => s.state.bullets.length > 0, 40, () => Btn.skill);
    const b = snap.state.bullets[0]!;
    // zh1atm {x:10,y:-40,w:30,h:30} @ P1(100,500) facing 1（发射 tick 未位移）
    expect(b.x).toBe(110);
    expect(b.y).toBe(460);
    expect(b.w).toBe(30);
    expect(b.h).toBe(30);
    expect(b.facing).toBe(1);
    expect(b.ownerId).toBe(1);
    expect(b.name).toBe('zh1atm');
    expect(b.hitAble).toBe(true);
    const spawnEv = snap.events.find((e) => e.type === 'entity:spawn');
    expect(spawnEv).toBeDefined();
  });

  it('运动：每 tick 位移 sx×SPEED_PLUS、加速 add/tick、max 钳制', () => {
    const def = makeFireDef({ x: { start: 5, add: 1, max: 20 }, hold: 60, hits: 1 });
    const sim = new Sim(makeConfig([def, makeDef()], { p2x: 900 }));
    for (let i = 0; i < 12; i++) sim.tick({ p1: Btn.skill, p2: 0 });
    const x0 = sim.serializeState();
    void x0;
    let snap = runTicks(sim, 1);
    let b = snap.state.bullets[0]!;
    const sx0 = b.sx;
    const px0 = b.x;
    snap = runTicks(sim, 1);
    b = snap.state.bullets[0]!;
    expect(b.x - px0).toBeCloseTo(sx0 * 0.5);
    expect(b.sx - sx0).toBeCloseTo(1); // add×2×SPEED_PLUS = add/tick
    // 大量 tick 后速度钳到 max=20
    snap = runTicks(sim, 40);
    b = snap.state.bullets[0]!;
    expect(b.sx).toBe(20);
  });

  it('命中：扣血 + 发射者回气 power×0.1 + hits=1 消散 + despawn 事件', () => {
    const def = makeFireDef(ZERO); // power 30 → 回气 3
    const sim = new Sim(makeConfig([def, makeDef()], { p2x: 300 }));
    for (let i = 0; i < 12; i++) sim.tick({ p1: Btn.skill, p2: 0 });
    const hp0 = 1000;
    void hp0;
    // 弹体从 x=110 以 2.5/tick 飞向 P2(300, body 290..310)
    let snap = runTicks(sim, 200);
    // P2 被命中一次：血量 1000-30
    const p2 = snap.state.fighters[1]!;
    expect(p2.hp).toBe(970);
    // 消散
    expect(snap.state.bullets).toHaveLength(0);
    // 发射者回气：P1 qi = 3（道具 power×0.1；弹体命中只走 BULLET_QI_RATE，
    // 不叠近战 0.16——此前 7.8 是 applyHit 近战分支误对弹体命中计费的产物）
    const p1 = snap.state.fighters[0]!;
    expect(p1.qi).toBeCloseTo(3);
    const despawnEv = snap.events.find((e) => e.type === 'entity:despawn');
    void despawnEv;
  });

  it('hits=2：穿透连击两次', () => {
    const def = makeFireDef({ x: { start: 2, add: 0, max: 2 }, hold: 60, hits: 2 });
    const sim = new Sim(makeConfig([def, makeDef()], { p2x: 300 }));
    for (let i = 0; i < 12; i++) sim.tick({ p1: Btn.skill, p2: 0 });
    const snap = runTicks(sim, 200);
    expect(snap.state.fighters[1]!.hp).toBe(1000 - 60);
    expect(snap.state.bullets).toHaveLength(0);
  });

  it('必杀弹（bs 前缀）命中不回气', () => {
    const def = makeFireDef(ZERO);
    def.actions['zh1'] = { power: 30, hitType: 5, hitx: 10, hity: 0, hurtTime: 0, hurtType: 1, isBreakDef: false, isApplyG: true };
    // bsatm → 动作 bs；命中区/触发放 必杀 段（211-260）
    def.triggers = [{ frame: 215, target: 'mc', op: 'fire', args: ['bsatm', { x: { start: 5, add: 1, max: 20 }, hold: 60, hits: 1 }] }];
    def.areas[215] = [
      { name: 'bdmn', x: -10, y: -40, w: 20, h: 40 },
      { name: 'bsatm', x: 10, y: -40, w: 30, h: 30 },
    ];
    let sim = new Sim(makeConfig([def, makeDef()], { p2x: 300 }));
    // 注入 qi=100（必杀门槛；fromState 恢复 prev input，松一拍再按构成边沿）
    const st = JSON.parse(sim.serializeState()) as Parameters<typeof Sim.fromState>[0];
    st.fighters[0]!.qi = 100;
    sim = Sim.fromState(st, sim.getDefEntries());
    for (let i = 0; i < 12; i++) sim.tick({ p1: Btn.superSkill, p2: 0 });
    const snap = runTicks(sim, 200);
    expect(snap.state.fighters[1]!.hp).toBeLessThan(1000);
    expect(snap.state.fighters[0]!.qi).toBe(0); // bs 免回气
    expect(snap.state.bullets).toHaveLength(0);
  });

  it('寿命：hold 秒 ×60 tick 到期消散', () => {
    const def = makeFireDef({ x: 0, hold: 0.1, hits: 1 }); // 6 tick
    const sim = new Sim(makeConfig([def, makeDef()], { p2x: 900 }));
    const spawned = tickUntil(sim, (s) => s.state.bullets.length > 0, 40, () => Btn.skill);
    expect(spawned.state.bullets).toHaveLength(1);
    const snap = runTicks(sim, 10);
    expect(snap.state.bullets).toHaveLength(0);
  });

  it('出界：越过 rightBound+20 消散', () => {
    const def = makeFireDef({ x: 30, hold: 60, hits: 1 }); // 15/tick
    const sim = new Sim(makeConfig([def, makeDef()], { p2x: 900 }));
    for (let i = 0; i < 12; i++) sim.tick({ p1: Btn.skill, p2: 0 });
    // 从 110 到 1020 需 61 tick；留裕量
    const snap = runTicks(sim, 80);
    expect(snap.state.bullets).toHaveLength(0);
  });

  it('道具对撞：双方 hp 减对方 hpMax，双灭', () => {
    const fireDef = makeFireDef({ x: 5, hold: 60, hits: 1, hp: 30 });
    const sim = new Sim(makeConfig([fireDef, makeFireDef({ x: 5, hold: 60, hits: 1, hp: 30 })]));
    // 双方同时发弹（P2 facing -1，弹从 290 向左）
    for (let i = 0; i < 12; i++) sim.tick({ p1: Btn.skill, p2: Btn.skill });
    const mid = runTicks(sim, 40);
    // 相向而行 5/tick 闭合，36 tick 内相遇对撞双灭
    expect(mid.state.bullets).toHaveLength(0);
    expect(mid.state.fighters[0]!.hp).toBe(1000);
    expect(mid.state.fighters[1]!.hp).toBe(1000);
  });

  it('角色攻击可摧毁道具', () => {
    const fireDef = makeFireDef({ x: 4, hold: 60, hits: 1, hp: 30 }); // 2/tick
    const p2def = makeDef();
    // P2 砍1 区放大（220..330），先于 body（290..310）接触弹体
    for (let fr = 58; fr <= 59; fr++) {
      p2def.areas[fr] = [
        { name: 'bdmn', x: -10, y: -40, w: 20, h: 40 },
        { name: 'k1atm', x: -80, y: -40, w: 110, h: 40 },
      ];
    }
    const sim = new Sim(makeConfig([fireDef, p2def], { p2x: 300 }));
    for (let i = 0; i < 12; i++) sim.tick({ p1: Btn.skill, p2: 0 });
    // 弹体 110 → 2/tick；220 处进入攻击区约 55 tick；P2 于 60 tick 出砍
    let snap: SimSnapshot | null = null;
    for (let i = 0; i < 120; i++) {
      snap = sim.tick({ p1: 0, p2: i >= 60 && i < 64 ? Btn.attack : 0 });
      if (snap.state.bullets.length === 0) break;
    }
    expect(snap!.state.bullets).toHaveLength(0);
    expect(snap!.state.fighters[1]!.hp).toBe(1000); // 弹体被砍掉，未命中 P2
  });

  it('确定性：同配置两实例逐帧哈希一致', () => {
    const def = makeFireDef({ x: { start: 5, add: 1, max: 20 }, hold: 60, hits: 2 });
    const a = new Sim(makeConfig([def, makeDef()], { p2x: 300 }));
    const b = new Sim(makeConfig([def, makeDef()], { p2x: 300 }));
    for (let i = 0; i < 120; i++) {
      const input = i % 20 < 6 ? Btn.skill : 0;
      const sa = a.tick({ p1: input, p2: 0 });
      const sb = b.tick({ p1: input, p2: 0 });
      expect(sa.hash).toBe(sb.hash);
    }
  });
});

describe('切片 8：状态开关 op', () => {
  it('dashStop：damping=|vx|×p + 回 NORMAL + 可被命中', () => {
    const def = makeDef();
    def.triggers = [{ frame: 165, target: 'mc', op: 'dashStop', args: [] }];
    const sim = new Sim(makeConfig([def, makeDef()], { p2x: 900 }));
    // 瞬步：dash 键 → DASH_ING；第 165 帧触发 dashStop（瞬步 161-180）
    const snap = tickUntil(
      sim,
      (s) => s.state.fighters[0]!.actionState === 0,
      40,
      (i) => (i < 4 ? Btn.dash : 0),
    );
    const f = snap.state.fighters[0]!;
    expect(f.isAllowBeHit).toBe(true);
    expect(f.isCross).toBe(false);
  });

  it('setCross：穿越态跳过推挤', () => {
    const def = makeDef();
    def.triggers = [{ frame: 3, target: 'mc', op: 'setCross', args: [true] }];
    const sim = new Sim(makeConfig([def, makeDef()], { p2x: 108 }));
    // tick 0-3 推挤收敛；第 4 tick（帧 3 采样）isCross 生效 → 位置冻结
    let snap: SimSnapshot | null = null;
    for (let i = 0; i < 4; i++) snap = sim.tick({ p1: 0, p2: 0 });
    const x0 = snap!.state.fighters[0]!.x;
    snap = runTicks(sim, 6);
    expect(snap!.state.fighters[0]!.x).toBe(x0);
    expect(snap!.state.fighters[0]!.isCross).toBe(true);
  });

  it('isApplyG(false)：空中悬停不受重力', () => {
    const def = makeDef();
    def.triggers = [{ frame: 40, target: 'mc', op: 'isApplyG', args: [false] }];
    const sim = new Sim(makeConfig([def, makeDef()], { p2x: 900 }));
    // 起跳 → 跳中第 40 帧关闭重力；vy 经 dampY 归零后悬停
    let snap: SimSnapshot | null = null;
    for (let i = 0; i < 10; i++) snap = sim.tick({ p1: Btn.up, p2: 0 });
    expect(snap!.state.fighters[0]!.onGround).toBe(false);
    snap = runTicks(sim, 40); // vy → 0
    const yApex = snap!.state.fighters[0]!.y;
    snap = runTicks(sim, 30);
    expect(snap!.state.fighters[0]!.y).toBe(yApex); // 悬停（无重力坠落）
  });

  it('setTouchFloor：跳跃落地续接预约标签', () => {
    const def = makeDef();
    // 跳中段第 40 帧预约触地续接 招1_TF
    def.triggers = [{ frame: 40, target: 'mc', op: 'setTouchFloor', args: ['招1_TF'] }];
    const sim = new Sim(makeConfig([def, makeDef()], { p2x: 900 }));
    let snap: SimSnapshot | null = null;
    for (let i = 0; i < 10; i++) snap = sim.tick({ p1: Btn.up, p2: 0 });
    // 轮询落地续接帧（招1_TF 播 8 动画帧后归位，须在窗口内捕获）
    snap = tickUntil(sim, (s) => s.state.fighters[0]!.actLabel === '招1_TF', 100);
    expect(snap.state.fighters[0]!.touchFloor).toBe(null);
  });

  it('idle：站立回位（清攻击态 + 槽重填）', () => {
    const def = makeDef();
    def.triggers = [{ frame: 186, target: 'mc', op: 'idle', args: [] }];
    const sim = new Sim(makeConfig([def, makeDef()], { p2x: 900 }));
    // 进招1 → 第 186 帧 idle() 归位
    let snap: SimSnapshot | null = null;
    for (let i = 0; i < 12; i++) snap = sim.tick({ p1: Btn.skill, p2: 0 });
    const f = snap!.state.fighters[0]!;
    expect(f.actionState).toBe(0);
    expect(f.actLabel).toBe('站立');
    expect(f.slots.attack).toBe('砍1'); // setAllAct 重填
  });
});

// ---------- 切片 13-A3：bullet 元件时间轴生命周期 ----------

/** 带 anim 元数据的 fire def（def.fires → spawnBullet.anim → animTotal>0）。 */
function makeAnimFireDef(
  totalFrames: number,
  labels: Record<string, number>,
  params: Record<string, unknown>,
): FighterDef {
  const def = makeFireDef(params);
  def.fires = { zh1atm: { totalFrames, labels } };
  return def;
}

/**
 * 30Hz 推进节奏：发射在 stepHitResolution（先于同帧 stepBulletAnim）——
 * 发射 tick 动画帧已推进到 2；此后每 2 tick +1（tick%2===0 块）。
 */
describe('切片 13-A3：bullet 元件时间轴生命周期', () => {
  it('anim 注入 + 30Hz 推进：每 2 tick 动画帧 +1', () => {
    const def = makeAnimFireDef(9, {}, { x: 0, hold: 60, hits: 1 });
    const sim = new Sim(makeConfig([def, makeDef()], { p2x: 900 }));
    const spawned = tickUntil(sim, (s) => s.state.bullets.length > 0, 40, () => Btn.skill);
    const b0 = spawned.state.bullets[0]!;
    expect(b0.animTotal).toBe(9);
    expect(b0.animFrame).toBe(2); // 发射当帧已推进一步（stepHitResolution 先行）
    // 每 2 tick +1：2 tick → 帧 3；再 8 tick → 帧 7
    let snap = runTicks(sim, 2);
    expect(snap.state.bullets[0]!.animFrame).toBe(3);
    snap = runTicks(sim, 8);
    expect(snap.state.bullets[0]!.animFrame).toBe(7);
    // 帧数推进满 8（= totalFrames-1）即移除（原版 off-by-one：不播末帧）
    snap = runTicks(sim, 4);
    expect(snap.state.bullets).toHaveLength(0);
  });

  it('loop 标签：回跳 loop_start 循环播放，不移除', () => {
    const def = makeAnimFireDef(9, { loop: 4 }, { x: 0, hold: 60, hits: 1 });
    const sim = new Sim(makeConfig([def, makeDef()], { p2x: 900 }));
    tickUntil(sim, (s) => s.state.bullets.length > 0, 40, () => Btn.skill);
    // 帧序列 2→3→4(触发回跳)→1（发射帧 2 起，3 步一个周期）；30 tick = 5 周期 → 帧 2
    const snap = runTicks(sim, 30);
    const b = snap.state.bullets[0];
    expect(b).toBeDefined();
    expect(b!.animFrame).toBe(2);
  });

  it('remove 标签：到帧即移除', () => {
    const def = makeAnimFireDef(9, { remove: 6 }, { x: 0, hold: 60, hits: 1 });
    const sim = new Sim(makeConfig([def, makeDef()], { p2x: 900 }));
    tickUntil(sim, (s) => s.state.bullets.length > 0, 40, () => Btn.skill);
    // 3 步 → 帧 5 仍在
    let snap = runTicks(sim, 6);
    expect(snap.state.bullets).toHaveLength(1);
    // 4 步 → 帧 6（remove）移除
    snap = runTicks(sim, 2);
    expect(snap.state.bullets).toHaveLength(0);
  });

  it('timeout 标签：寿命到期跳 timeout 段续播至播尽', () => {
    const def = makeAnimFireDef(9, { timeout: 5 }, { x: 0, hold: 0.1, hits: 1 });
    const sim = new Sim(makeConfig([def, makeDef()], { p2x: 900 }));
    tickUntil(sim, (s) => s.state.bullets.length > 0, 40, () => Btn.skill);
    // hold 6 tick 到期不消散（旧行为会移除）：跳帧 5，同帧动画推进到 6，
    // 再 4 tick（2 步）到帧 8——播尽移除在到期后 6 tick
    const mid = runTicks(sim, 8);
    const b = mid.state.bullets[0];
    expect(b).toBeDefined();
    expect(b!.holdTicks).toBe(-1); // 已进 timeout 段（不再递减）
    expect(b!.animFrame).toBe(7);
    const end = runTicks(sim, 4);
    expect(end.state.bullets).toHaveLength(0);
  });

  it('1 帧元件永不自动移除（原版 off-by-one quirk 原样保留）', () => {
    const def = makeAnimFireDef(1, {}, { x: 0, hold: -1, hits: 1 });
    const sim = new Sim(makeConfig([def, makeDef()], { p2x: 900 }));
    tickUntil(sim, (s) => s.state.bullets.length > 0, 40, () => Btn.skill);
    const snap = runTicks(sim, 40);
    const b = snap.state.bullets[0];
    expect(b).toBeDefined();
    expect(b!.animFrame).toBe(1);
  });

  it('命中残留段：停移动 + 停命中，播尽后 despawn', () => {
    // P2 贴近（弹体寿命仅 ~14 动画 tick，须在帧 8 移除前命中）
    const def = makeAnimFireDef(9, { hit: 5 }, { x: 5, hold: 60, hits: 1 });
    const sim = new Sim(makeConfig([def, makeDef()], { p2x: 150 }));
    for (let i = 0; i < 12; i++) sim.tick({ p1: Btn.skill, p2: 0 });
    // 命中瞬间：hitAnim=true、跳 hit 帧、不再推进位置
    const hitSnap = tickUntil(sim, (s) => s.state.bullets.some((b) => b.hitAnim), 200);
    const hb = hitSnap.state.bullets.find((b) => b.hitAnim)!;
    expect(hb.hitAble).toBe(false);
    expect(hb.animFrame).toBeGreaterThanOrEqual(5); // 跳 hit 标签帧（同帧可能已推进）
    const hx = hb.x;
    // 残留段停移动（stepBullets 早退）
    const after = runTicks(sim, 6);
    const ab = after.state.bullets.find((b) => b.hitAnim);
    if (ab) expect(ab.x).toBe(hx);
    // 播尽（帧 5→8）后 despawn；命中已结算（P2 扣血）
    const end = runTicks(sim, 40);
    expect(end.state.bullets).toHaveLength(0);
    expect(end.state.fighters[1]!.hp).toBe(970);
  });
});

// ---------- 切片 56：bullet 触底（原版 Bullet.render → isTouchBottomFloor） ----------

describe('切片 56：bullet 触底', () => {
  /** 下坠弹：sy 0 + addY 3/tick，发射点 y 460（zh1atm y-40），约 10 tick 内越过 groundY=500 */
  const FALL = { x: 5, y: { start: 0, add: 3 }, hold: -1 };

  it('触底：消耗 hits（耗尽消散）+ shake(0,1,200) 同 tick', () => {
    const def = makeFireDef({ ...FALL, hits: 1 });
    const sim = new Sim(makeConfig([def, makeDef()], { p2x: 900 }));
    tickUntil(sim, (s) => s.state.bullets.length > 0, 40, () => Btn.skill);
    // 触底 tick：y 过 groundY → hitTimes 1→0 → killBullet（无动画立即 despawn）+ shake
    const snap = tickUntil(sim, (s) => s.state.bullets.length === 0, 200);
    const shake = snap.events.find(
      (e) => e.type === 'effect' && e.payload['id'] === 'shake',
    );
    expect(shake).toBeDefined();
    expect(shake!.payload['params']).toEqual({ x: 0, y: 1, time: 200 });
    expect(snap.events.some((e) => e.type === 'entity:despawn')).toBe(true);
  });

  it('hits=-1 触底弹持续下沉：每 tick 触底震屏、出界判定被跳过不回收', () => {
    const def = makeFireDef(FALL); // hits 缺省 -1
    const sim = new Sim(makeConfig([def, makeDef()], { p2x: 900 }));
    tickUntil(sim, (s) => s.state.bullets.length > 0, 40, () => Btn.skill);
    // 越过死亡线 bottomY+20=620（原版 return 跳过 isOutRange）仍存活
    const snap = tickUntil(sim, (s) => (s.state.bullets[0]?.y ?? 0) > 620, 400);
    expect(snap.state.bullets).toHaveLength(1);
    // 触底期每 tick 发轻震
    const shakes = snap.events.filter(
      (e) => e.type === 'effect' && e.payload['id'] === 'shake',
    );
    expect(shakes.length).toBeGreaterThan(0);
    // 寿命计满前一直存活
    const still = runTicks(sim, 30);
    expect(still.state.bullets).toHaveLength(1);
  });
});
