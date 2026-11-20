import { describe, expect, it } from 'vitest';
import {
  ActionState,
  Btn,
  Sim,
  type FighterDef,
  type SimConfig,
  type SimState,
  type AreaRect,
} from '../src/index.js';
import { worldRect } from '../src/fighter/def.js';

/**
 * 手工构造的最小角色 def（不依赖 baked 数据，core 测试自持）。
 * 时间轴布局（30Hz 帧）：
 *   站立 1-9（循环）、走 10-33（循环）、起跳 34-38、跳中 39-44、落 45-50、
 *   落地 51-54、砍1 55-71（k1atm 在 58-59）、被打 72-79、击飞 80-89、
 *   击飞_倒 90-98、起身 99-107、跳砍 108-122、失败 123-143
 */
function makeDef(overrides: Partial<FighterDef> = {}): FighterDef {
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
    跳砍: { index: 107, duration: 15 },
    失败: { index: 122, duration: 21 },
  };
  const areas: FighterDef['areas'] = {};
  for (let fr = 1; fr <= 143; fr++) {
    const list: AreaRect[] = [{ name: 'bdmn', x: -10, y: -40, w: 20, h: 40 }];
    if (fr === 58 || fr === 59) {
      list.push({ name: 'k1atm', x: 10, y: -40, w: 30, h: 30 });
    }
    areas[fr] = list;
  }
  return {
    id: 'test',
    formIndex: 0,
    speed: 6,
    jumpPower: 15,
    heavy: 3,
    actions: {
      k1: { power: 30, hitType: 1, hitx: 3, hity: 0, hurtTime: 300, hurtType: 0, isBreakDef: false, isApplyG: true },
    },
    labels,
    areas,
    totalFrames: 143,
    triggers: [
      // 对齐真实数据（修复批次 20）：动作标签尾部 endAct + idle 重定向——
      // 时间轴顺流只发生在无收尾脚本的连续标签（必杀桩帧家族），
      // 真实语料每个动作段尾部都有收尾脚本，fixture 须同构
      { frame: 69, target: 'mc', op: 'endAct', args: [] },
      { frame: 70, target: 'mc', op: 'idle', args: ['站立'] },
      { frame: 120, target: 'mc', op: 'endAct', args: [] },
      { frame: 121, target: 'mc', op: 'idle', args: ['站立'] },
    ],
    attackLabels: { k1: '砍1' },
    ...overrides,
  };
}

function makeConfig(overrides: {
  p2x?: number;
  def2?: FighterDef | null;
  def1?: FighterDef | null;
  seed?: number;
} = {}): SimConfig {
  const def1 = overrides.def1 === undefined ? makeDef() : overrides.def1;
  const def2 = overrides.def2 === undefined ? makeDef() : overrides.def2;
  const fighters: SimConfig['fighters'] = [
    { id: 1, x: 100, ...(def1 ? { def: def1 } : {}) },
    { id: 2, x: overrides.p2x ?? 500, ...(def2 ? { def: def2 } : {}) },
  ];
  return {
    seed: overrides.seed ?? 1,
    stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
    fighters,
  };
}

function runTicks(sim: Sim, n: number, input = { p1: 0, p2: 0 }) {
  let last;
  for (let i = 0; i < n; i++) last = sim.tick(input);
  return last!;
}

describe('状态机（跳跃/落地）', () => {
  it('跳跃进入 JUMP_ING，落回地面后回 NORMAL 并播放 落地', () => {
    const sim = new Sim(makeConfig());
    const snap = sim.tick({ p1: Btn.jump, p2: 0 }); // 起跳 tick：JUMP_ING（切片 10：延迟 2 tick 后施加速度）
    const f = snap.state.fighters[0]!;
    expect(f.actionState).toBe(ActionState.JUMP_ING);
    const snap2 = runTicks(sim, 2); // JUMP_DELAY_GROUND 结束 → 离地
    const f0 = snap2.state.fighters[0]!;
    expect(f0.onGround).toBe(false);
    expect(f0.vy).toBeLessThan(0);
    // 跳跃上升 30 tick（vy -7.5，damp 0.25/tick）+ 下落，120 tick 内必落地
    const end = runTicks(sim, 120);
    const f2 = end.state.fighters[0]!;
    expect(f2.actionState).toBe(ActionState.NORMAL);
    expect(f2.onGround).toBe(true);
    expect(f2.y).toBe(500);
    // 落地恢复后回到 站立 循环
    const end2 = runTicks(sim, 30);
    expect(end2.state.fighters[0]!.actLabel).toBe('站立');
  });

  it('跳跃高度受 def.jumpPower 驱动', () => {
    const sim = new Sim(makeConfig());
    let minY = 500;
    let last = sim.tick({ p1: Btn.jump, p2: 0 });
    minY = Math.min(minY, last.state.fighters[0]!.y);
    for (let i = 0; i < 100; i++) {
      last = sim.tick({ p1: 0, p2: 0 });
      minY = Math.min(minY, last.state.fighters[0]!.y);
    }
    // 上升位移 ≈ Σ|vy|（速度类 ×SPEED_PLUS：jumpPower 15 → 7.5/tick 起步）
    expect(500 - minY).toBeGreaterThan(80);
    expect(500 - minY).toBeLessThan(200);
  });
});

describe('起跳尘土分流 + 落地尘土状态门（切片 56）', () => {
  const isEffect = (snap: { events: { type: string; payload: Record<string, unknown> }[] }, id: string) =>
    snap.events.some((e) => e.type === 'effect' && e.payload['id'] === id);

  it('地面跳发 jump 尘土，空中二段跳发 jump_air（原版 renderJumpAnimate isInAir 分流）', () => {
    const sim = new Sim(makeConfig());
    sim.tick({ p1: Btn.jump, p2: 0 }); // 预约（延迟 2→1）
    const launch = runTicks(sim, 1); // 延迟计满 → 地面起跳
    expect(isEffect(launch, 'jump')).toBe(true);
    expect(isEffect(launch, 'jump_air')).toBe(false);
    // 空中二段跳（doAirJump 延迟 1 tick，本 tick 计满即发射）
    const air = sim.tick({ p1: Btn.jump, p2: 0 });
    expect(isEffect(air, 'jump_air')).toBe(true);
    expect(isEffect(air, 'jump')).toBe(false);
  });

  it('跳跃落地发 touchFloor 尘土', () => {
    const sim = new Sim(makeConfig());
    sim.tick({ p1: Btn.jump, p2: 0 });
    runTicks(sim, 2);
    let end: ReturnType<Sim['tick']> | undefined;
    for (let i = 0; i < 120; i++) {
      end = sim.tick({ p1: 0, p2: 0 });
      if (end.state.fighters[0]!.onGround) break;
    }
    expect(end!.state.fighters[0]!.onGround).toBe(true);
    expect(isEffect(end!, 'touchFloor')).toBe(true);
  });

  it('空中攻击触地续接（setTouchFloor 预约）落地发尘土——攻击态不吞', () => {
    // 跳砍拉长到 60 动画帧（120 tick），攻击态持续到落地之后；
    // 起手第 2 帧预约续接标签（落地发生在 +10 tick 内，须早于落地）
    const base = makeDef();
    const def = makeDef({
      totalFrames: 200,
      labels: { ...base.labels, 跳砍: { index: 125, duration: 60 } },
      triggers: [
        { frame: 127, target: 'mc', op: 'setTouchFloor', args: ['落地'] },
        { frame: 180, target: 'mc', op: 'endAct', args: [] },
        { frame: 181, target: 'mc', op: 'idle', args: ['站立'] },
      ],
      attackLabels: { k1: '砍1', k2: '跳砍' },
      actions: {
        k1: { power: 30, hitType: 1, hitx: 3, hity: 0, hurtTime: 300, hurtType: 0, isBreakDef: false, isApplyG: true },
        k2: { power: 30, hitType: 1, hitx: 3, hity: 0, hurtTime: 300, hurtType: 0, isBreakDef: false, isApplyG: true },
      },
    });
    const sim = new Sim(makeConfig({ def1: def }));
    sim.tick({ p1: Btn.jump, p2: 0 });
    runTicks(sim, 1); // 离地
    const airAtk = sim.tick({ p1: Btn.attack, p2: 0 }); // 空中攻击 跳砍
    expect(airAtk.state.fighters[0]!.actLabel).toBe('跳砍');
    let end: ReturnType<Sim['tick']> | undefined;
    let sawReserved = false;
    for (let i = 0; i < 200; i++) {
      end = sim.tick({ p1: 0, p2: 0 });
      const f = end.state.fighters[0]!;
      if (f.touchFloor === '落地') sawReserved = true;
      if (f.onGround) break;
    }
    expect(sawReserved).toBe(true);
    expect(end!.state.fighters[0]!.onGround).toBe(true);
    // 攻击态（非 NORMAL/JUMP_ING）落地仍发尘土（原版 act = 预约标签非空）
    expect(isEffect(end!, 'touchFloor')).toBe(true);
  });

  // 受击用例共用：P2 判定区加高（y -120..-10），起手即活——P1 升空轨迹快，
  // 原 58-59 帧矮区跟不上；命中时机在发射 tick +2，P1 已离地
  function tallHitDef(actions: FighterDef['actions']): FighterDef {
    const base = makeDef();
    const areas: FighterDef['areas'] = {};
    for (let fr = 1; fr <= 143; fr++) {
      const list: AreaRect[] = [{ name: 'bdmn', x: -10, y: -40, w: 20, h: 40 }];
      if (fr >= 55 && fr <= 70) list.push({ name: 'k1atm', x: 10, y: -120, w: 30, h: 110 });
      areas[fr] = list;
    }
    return { ...base, areas, actions: actions! };
  }

  it('HURT_ING 空中受击落地无尘土（原版 renderHurt 拦截）', () => {
    // hurtTime 5000 → 硬直 150+ tick，覆盖剩余飞行时间
    const hurtDef = tallHitDef({
      k1: { power: 30, hitType: 1, hitx: 3, hity: 0, hurtTime: 5000, hurtType: 0, isBreakDef: false, isApplyG: true },
    });
    const sim = new Sim(makeConfig({ p2x: 110, def2: hurtDef }));
    sim.tick({ p1: Btn.jump, p2: 0 });
    runTicks(sim, 1); // 离地
    sim.tick({ p1: 0, p2: Btn.attack }); // P2 起手，下 tick 命中空中 P1
    let end: ReturnType<Sim['tick']> | undefined;
    let hurt = false;
    for (let i = 0; i < 200; i++) {
      end = sim.tick({ p1: 0, p2: 0 });
      if (end.state.fighters[0]!.actionState === ActionState.HURT_ING) hurt = true;
      if (end.state.fighters[0]!.onGround) break;
    }
    const f = end!.state.fighters[0]!;
    expect(hurt).toBe(true);
    expect(f.onGround).toBe(true);
    expect(f.actionState).toBe(ActionState.HURT_ING);
    expect(isEffect(end!, 'touchFloor')).toBe(false);
  });

  it('DEAD 空中死亡落地无尘土（原版 touchFloor isAlive 守卫）', () => {
    const killDef = tallHitDef({
      k1: { power: 9999, hitType: 1, hitx: 3, hity: 0, hurtTime: 500, hurtType: 0, isBreakDef: false, isApplyG: true },
    });
    const sim = new Sim(makeConfig({ p2x: 110, def2: killDef }));
    sim.tick({ p1: Btn.jump, p2: 0 });
    runTicks(sim, 1); // 离地
    sim.tick({ p1: 0, p2: Btn.attack }); // P2 起手，下 tick 致死空中 P1
    let dead = false;
    let end: ReturnType<Sim['tick']> | undefined;
    for (let i = 0; i < 200; i++) {
      end = sim.tick({ p1: 0, p2: 0 });
      if (end.state.fighters[0]!.actionState === ActionState.DEAD) dead = true;
      if (end.state.fighters[0]!.onGround) break;
    }
    expect(dead).toBe(true);
    expect(end!.state.fighters[0]!.actionState).toBe(ActionState.DEAD);
    expect(isEffect(end!, 'touchFloor')).toBe(false);
  });
});

describe('判定区（世界坐标换算）', () => {
  it('facing=1 时世界矩形 = 本地 + 锚点', () => {
    const f = { x: 100, y: 500, facing: 1 as const };
    const r = worldRect(f, { name: 'k1atm', x: 10, y: -40, w: 30, h: 30 });
    expect(r).toEqual({ x: 110, y: 460, w: 30, h: 30 });
  });

  it('facing=-1 时世界矩形按锚点镜像', () => {
    const f = { x: 100, y: 500, facing: -1 as const };
    const r = worldRect(f, { name: 'k1atm', x: 10, y: -40, w: 30, h: 30 });
    // 镜像后仍是攻击者前方（左侧）：本地 x∈[10,40] → 世界 x∈[-40,-10]
    expect(r).toEqual({ x: 60, y: 460, w: 30, h: 30 });
  });
});

describe('命中判定与结算', () => {
  function setupClose() {
    const sim = new Sim(makeConfig({ p2x: 130 })); // 砍1 世界 x∈[110,140]，p2 bdmn x∈[120,140]
    // 靠近至攻击距离内（p1 面向 p2）
    runTicks(sim, 10);
    return sim;
  }

  it('攻击命中：扣血 + 受击硬直 + hit:connect 事件', () => {
    const sim = setupClose();
    const snap = sim.tick({ p1: Btn.attack, p2: 0 });
    expect(snap.state.fighters[0]!.actionState).toBe(ActionState.ATTACK_ING);
    // 攻击持续到判定帧（anim 帧 58-59，30Hz），命中发生在动画帧管线
    let hitEvent = null;
    let hurt: ActionState | null = null;
    let voiceHurt = false;
    let last;
    for (let i = 0; i < 40; i++) {
      last = sim.tick({ p1: 0, p2: 0 });
      const ev = last.events.find((e) => e.type === 'hit:connect');
      if (ev) {
        hitEvent = ev;
        expect(ev.payload.steel).toBe(false); // 命中音/钢身音分流键（切片 27）
      }
      if (last.events.some((e) => e.type === 'voice' && e.payload.kind === 'hurt')) {
        voiceHurt = true; // 重击类型（hitType 1 KAN）→ 受击语音信号
      }
      if (last.state.fighters[1]!.actionState === ActionState.HURT_ING) hurt = ActionState.HURT_ING;
    }
    expect(hitEvent).not.toBeNull();
    expect(hitEvent!.payload.attacker).toBe(1);
    expect(hitEvent!.payload.target).toBe(2);
    expect(hitEvent!.payload.power).toBe(30);
    expect(hurt).toBe(ActionState.HURT_ING);
    expect(voiceHurt).toBe(true);
    expect(last!.state.fighters[1]!.hp).toBe(970);
  });

  it('一次攻击对同一目标只结算一次', () => {
    const sim = setupClose();
    sim.tick({ p1: Btn.attack, p2: 0 });
    const end = runTicks(sim, 40);
    expect(end.state.fighters[1]!.hp).toBe(970); // 仅一次 power=30
  });

  it('受击硬直结束后恢复 NORMAL', () => {
    const sim = setupClose();
    sim.tick({ p1: Btn.attack, p2: 0 });
    // hurtTime 300ms → 9 动画帧 +3 偏移 = 12 动画帧 = 24 tick
    const end = runTicks(sim, 30);
    expect(end.state.fighters[1]!.actionState).toBe(ActionState.NORMAL);
    expect(end.state.fighters[1]!.actLabel).toBe('站立');
  });

  it('击杀：hp 归零进 DEAD 并发 fighter:ko', () => {
    const def = makeDef({
      actions: {
        k1: { power: 2000, hitType: 1, hitx: 3, hity: 0, hurtTime: 300, hurtType: 0, isBreakDef: false, isApplyG: true },
      },
    });
    const sim = new Sim(makeConfig({ p2x: 130, def1: def }));
    sim.tick({ p1: Btn.attack, p2: 0 });
    let ko = false;
    let voiceDie = false;
    let end;
    for (let i = 0; i < 40; i++) {
      end = sim.tick({ p1: 0, p2: 0 });
      if (end.events.some((e) => e.type === 'fighter:ko')) ko = true;
      if (end.events.some((e) => e.type === 'voice' && e.payload.kind === 'die')) voiceDie = true;
    }
    expect(ko).toBe(true);
    expect(voiceDie).toBe(true); // KO 同 tick 发死亡语音信号（切片 27）
    expect(end!.state.fighters[1]!.actionState).toBe(ActionState.DEAD);
    expect(end!.state.fighters[1]!.hp).toBe(0);
  });

  it('钢身：掉血但不受击状态变化', () => {
    const def2 = makeDef({ triggers: [{ frame: 1, target: 'mc', op: 'setSteelBody', args: [true] }] });
    const sim = new Sim(makeConfig({ p2x: 130, def2 }));
    sim.tick({ p1: Btn.attack, p2: 0 });
    const end = runTicks(sim, 40);
    // 修复批次 34 收编 doSteelHurt：减伤 65%（30×0.65=19.5）+ 受击窗（4 帧，
    // 段内不重命中——判定区 2 动画帧窗内受击窗未到期）+ 击退（hitx 推离）
    expect(end.state.fighters[1]!.hp).toBe(1000 - 19.5);
    expect(end.state.fighters[1]!.actionState).toBe(ActionState.NORMAL); // 无硬直
    expect(end.state.fighters[1]!.steelBody).toBe(true);
  });
});

describe('推挤（heavy 系数）', () => {
  it('body 重叠时按 heavy 比例分离', () => {
    // p2 开局即与 p1 的 body 重叠（x=115 → p1 bdmn [90,110] p2 [105,125]）
    const def2 = makeDef({ heavy: 1 });
    const sim = new Sim(makeConfig({ p2x: 115, def2 }));
    const end = runTicks(sim, 5);
    const [a, b] = end.state.fighters;
    // 两 bdmn 不再重叠（p1 heavy=3 挪得少，p2 heavy=1 挪得多）
    const ra = { x: a!.x - 10, w: 20 };
    const rb = { x: b!.x - 10, w: 20 };
    const overlap = Math.min(ra.x + ra.w, rb.x + rb.w) - Math.max(ra.x, rb.x);
    expect(overlap).toBeLessThanOrEqual(0);
    expect(Math.abs(a!.x - 100)).toBeLessThan(Math.abs(b!.x - 115));
  });
});

describe('behaviors 注册表（契约硬规则 7）', () => {
  it('addQi/moveOnce 按原版语义执行', () => {
    const def = makeDef({
      triggers: [
        { frame: 1, target: 'fighter', op: 'addQi', args: [50] },
        { frame: 2, target: 'mc', op: 'moveOnce', args: [10, 0] },
      ],
    });
    const sim = new Sim(makeConfig({ def1: def }));
    // 站立循环 1-9 帧每圈重放触发；跑 20 tick（10 动画帧）跨两圈
    const end = runTicks(sim, 20);
    expect(end.state.fighters[0]!.qi).toBe(100); // 300 上限内累计两圈
    expect(end.state.fighters[0]!.x).toBeGreaterThan(100); // moveOnce 位移生效
  });

  it('endAct 收招不换播放头：攻击态保持到标签播尽才回 NORMAL（原版 endAct 语义）', () => {
    const def = makeDef({
      attackLabels: { k1: '砍1' },
      // 标签尾 idle@70 收尾（真实数据同构）：不拦截 endAct 不动播放头的考察窗（帧 57-68）
      triggers: [
        { frame: 56, target: 'mc', op: 'endAct', args: [] },
        { frame: 70, target: 'mc', op: 'idle', args: ['站立'] },
      ],
    });
    const sim = new Sim(makeConfig({ p2x: 9999, def1: def }));
    sim.tick({ p1: Btn.attack, p2: 0 });
    // endAct@帧56：槽清空/attackId 清空，但不回位——帧 58-70 仍是攻击态
    //（原版 endAct 不动播放头，后续帧触发仍会执行；偏离修正前曾立即回 NORMAL）
    const afterEndAct = runTicks(sim, 6);
    expect(afterEndAct.state.fighters[0]!.actionState).not.toBe(ActionState.NORMAL);
    expect(afterEndAct.state.fighters[0]!.attackId).toBeNull();
    expect(afterEndAct.state.fighters[0]!.slots.attack).toBeNull();
    // 标签尾 idle@70 重定向（真实数据同构：动作段尾都有收尾脚本）回 NORMAL
    let ended = false;
    for (let i = 0; i < 40; i++) {
      const s = sim.tick({ p1: 0, p2: 0 });
      if (s.state.fighters[0]!.actionState === ActionState.NORMAL) ended = true;
    }
    expect(ended).toBe(true); // 远处无人命中，播尽后回 NORMAL
  });

  it('未注册 op 静默忽略（确定性）', () => {
    const def = makeDef({
      triggers: [{ frame: 1, target: 'mc', op: 'totallyUnknownOp', args: [1, 'x'] }],
    });
    const sim = new Sim(makeConfig({ def1: def }));
    const end = runTicks(sim, 10);
    expect(end.state.fighters[0]!.qi).toBe(0);
  });
});

describe('带角色定义的确定性（完工门禁）', () => {
  const script: { p1: number; p2: number }[] = [];
  {
    let s = 42 >>> 0;
    const next = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) & 0x7ff);
    for (let i = 0; i < 400; i++) script.push({ p1: next(), p2: next() });
  }

  it('同一输入序列两遍逐帧哈希一致（含判定区/触发）', () => {
    const run = () => {
      const sim = new Sim(makeConfig({ p2x: 300 }));
      return script.map((f) => sim.tick(f).hash);
    };
    expect(run()).toEqual(run());
  });

  it('序列化/恢复（注入 defs）后哈希一致（rollback 预留接口）', () => {
    const cut = 150;
    const simA = new Sim(makeConfig({ p2x: 300 }));
    for (let i = 0; i < cut; i++) simA.tick(script[i]!);
    const saved = simA.serializeState();
    const tailA = script.slice(cut).map((f) => simA.tick(f).hash);

    const simB = Sim.fromState(
      Sim.deserializeState(saved) as SimState,
      simA.getDefEntries(),
    );
    const tailB = script.slice(cut).map((f) => simB.tick(f).hash);
    expect(tailB).toEqual(tailA);
  });
});
