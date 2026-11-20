import { describe, expect, it } from 'vitest';
import {
  ActionState,
  Btn,
  Sim,
  type FighterDef,
  type SimConfig,
  type SimEvent,
  type SimState,
  type AreaRect,
} from '../src/index.js';

/**
 * 切片 35 尾巴·团队模式 3+1 装配（对局侧）：roster 装配、回合结束/换人/终局流转。
 * 原版参照：GameRunFighterGroup / GameCtrler.runNext-startNextTeamFight-nextFighter /
 * GameEndCtrler / GameStage.resetFight / GameStartCtrler.start1v1。
 */

const HIT_K1 = { power: 30, hitType: 1, hitx: 3, hity: 0, hurtTime: 300, hurtType: 0, isBreakDef: false, isApplyG: true };

function makeDef(id: string): FighterDef {
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
    胜利: { index: 142, duration: 30 },
    防御: { index: 172, duration: 6 },
    防御恢复: { index: 178, duration: 12 },
    瞬步: { index: 190, duration: 20 },
    招1: { index: 210, duration: 30 },
    必杀: { index: 240, duration: 50 },
    砍2: { index: 290, duration: 17 },
  };
  const areas: FighterDef['areas'] = {};
  for (let fr = 1; fr <= 310; fr++) {
    const list: AreaRect[] = [{ name: 'bdmn', x: -10, y: -40, w: 20, h: 40 }];
    if (fr === 58 || fr === 59) list.push({ name: 'k1atm', x: 10, y: -40, w: 30, h: 30 });
    areas[fr] = list;
  }
  return {
    id,
    formIndex: 0,
    speed: 6,
    jumpPower: 15,
    heavy: 3,
    actions: { k1: { ...HIT_K1 } },
    labels,
    areas,
    totalFrames: 310,
    triggers: [
      { frame: 69, target: 'mc', op: 'endAct', args: [] },
      { frame: 70, target: 'mc', op: 'idle', args: ['站立'] },
    ],
    attackLabels: { k1: '砍1' },
  };
}

/**
 * 团队配置：hp=25（砍1 单击必杀）、p1 roster [1,3,5]（comicType 0,0,1）、
 * p2 roster [2,4,6]（comicType 0,1,0）；p2 首名出生气 50（换人气继承验证用）。
 */
function makeTeamConfig(opts: { p2Roster?: number[]; p1Hp?: number } = {}): SimConfig {
  const def = makeDef('test');
  return {
    seed: 1,
    stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
    fighters: [
      { id: 1, x: 100, hp: opts.p1Hp ?? 25, qi: 500, comicType: 0, def },
      { id: 2, x: 130, hp: 25, qi: 50, comicType: 0, def },
      { id: 3, x: 100, hp: 25, comicType: 0, def },
      { id: 4, x: 130, hp: 25, comicType: 1, def },
      { id: 5, x: 100, hp: 25, comicType: 1, def },
      { id: 6, x: 130, hp: 25, comicType: 0, def },
    ],
    teams: { p1: [1, 3, 5], p2: opts.p2Roster ?? [2, 4, 6] },
  };
}

interface PlayResult {
  sim: Sim;
  events: SimEvent[];
  snaps: { tick: number; state: SimState }[];
}

/** 驱动 sim：segments 逐段 [tick 数, p1 位图, p2 位图]。 */
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

const stateOf = (res: PlayResult): SimState => res.snaps[res.snaps.length - 1]!.state;

describe('团队装配（切片 36）', () => {
  it('初始装配：只有各队队首进 fighters，roster/待出场收进 match.teams', () => {
    const res = play(new Sim(makeTeamConfig()), [[1, 0, 0]]);
    const st = stateOf(res);
    expect(st.fighters.map((f) => f.id)).toEqual([1, 2]);
    expect(st.match.teams).toBeDefined();
    expect(st.match.teams!.p1.map((s) => s.id)).toEqual([1, 3, 5]);
    expect(st.match.teams!.p2.map((s) => s.id)).toEqual([2, 4, 6]);
    expect(st.match.teams!.pending1).toEqual([3, 5]);
    expect(st.match.teams!.pending2).toEqual([4, 6]);
    // comicType 抄进槽位（换人气继承加成判定）
    expect(st.match.teams!.p1[0]!.comicType).toBe(0);
    expect(st.match.teams!.p2[1]!.comicType).toBe(1);
  });

  it('KO → 回合结束：胜方 WIN+胜利+血量恢复，hold 计满换人（气继承 + 同系加成）', () => {
    // p1 hp 100：先挨 p2 一击（100→70）再反杀，验证恢复 =(hpMax−hp)×0.33。
    // 批次 60 注：受击滑行改按原版纯 HURT_DAMPING 衰减后滑步变长（hitx 3
    // → 滑 ~22px），反杀前需先走回攻击距离。
    const res = play(new Sim(makeTeamConfig({ p1Hp: 100 })), [
      [1, 0, Btn.attack],
      [650, 0, 0], // p1 挨打 → 被打 硬直解除（hurtTime 300 @30Hz）
      [14, Btn.right, 0], // 走回攻击距离（滑步变长后的补位）
      [1, Btn.attack, 0],
      [260, 0, 0], // KO@~30 → hold≈257（过 WIN 门 240——字样 120 + showWinner 延迟 120，未达换人推进 420）
    ]);
    // KO 已置位：胜方 id1、败方 id2 死亡（KO 当拍；WIN 演出在 KO 字样窗口
    // WIN_TEXT_GATE=120 计满后才应用）
    const reIdx = res.snaps.findIndex((s) => s.state.roundEnd != null);
    expect(reIdx).toBeGreaterThanOrEqual(0);
    const reSnap = res.snaps[reIdx]!;
    expect(reSnap.state.roundEnd!.winnerId).toBe(1);
    expect(reSnap.state.roundEnd!.loserId).toBe(2);
    // KO 字样窗口内 WIN 不应用（原版 pause+KO 字样期胜方维持当前动作）
    const gateSnap = res.snaps[reIdx + 60]!;
    expect(gateSnap.state.roundEnd!.winApplied).toBe(false);
    // WIN 应用后：actionState=WIN_ING + 胜利 label + 血量恢复
    const winSnap = res.snaps.find((s) => s.state.roundEnd?.winApplied === true)!;
    const winner = winSnap.state.fighters.find((f) => f.id === 1)!;
    expect(winner.actionState).toBe(ActionState.WIN_ING);
    expect(winner.actLabel).toBe('胜利');
    expect(winner.hp).toBeCloseTo(70 + 30 * 0.33, 6);
    // 演出计满（字样窗口 120 + showWinner 延迟 120 + 胜利动作 180 = 推进 420，
    // 空输入不跳）→ 换人：id4 入场
    const cont = play(res.sim, [[220, 0, 0]]);
    const end = stateOf(cont);
    expect(end.roundEnd).toBeUndefined();
    expect(end.fighters.map((f) => f.id)).toEqual([1, 4]);
    // 气继承（原版 lastLoserQi + 同 comicType +100，封顶 300）：KO 路径不吃
    // 受击回气（applyHit 在 hp<=0 提前返回）；id2 先手命中 p1 一次吃攻击回气
    // power×0.16 = 4.8 → KO 时 qi = 54.8；id4 comicType=1 ≠ 败方 0 → 不加成
    expect(end.fighters.find((f) => f.id === 4)!.qi).toBeCloseTo(54.8, 6);
    // 回合推进 + 换人开场（入场方 P2 获得特写：skip=2，跳过 P1 focus/say
    // 从 step 3 = P2 focus 起）
    expect(end.match.round).toBe(2);
    expect(end.intro).toBeDefined();
    const introSnap = cont.snaps.find((s) => s.state.intro?.skip === 2)!;
    expect(introSnap.state.intro!.step).toBe(3);
    expect(end.intro!.skip).toBe(2);
    // 胜方血量保持恢复后值（原版 resetFight 满血 + lastWinnerHp 回填净效果）
    expect(end.fighters.find((f) => f.id === 1)!.hp).toBeCloseTo(70 + 30 * 0.33, 6);
    expect(cont.events.some((e) => e.type === 'fighter:enter')).toBe(true);
    expect(res.events.some((e) => e.type === 'round:end')).toBe(true);
    expect(cont.events.some((e) => e.type === 'round:start')).toBe(true);
  });

  it('换人气继承同系加成：败方与入场者 comicType 相同 → +100（封顶 300）', () => {
    // p2 roster [2,4,6] → 入场者 id4 comicType=1 ≠ 败方 id2(0)。改 roster
    // 顺序让 id4 先出场不可行（roster 即出场序）——改为败方 comicType=1 的
    // 对侧验证：用 p1 roster [1,3,5]KO p2 后跳过。此处直接改配置：
    // p2 roster [2]，单一成员 + 同系场景由 id6（comicType 0）二轮验证。
    // 简化：单独构造 id2 败、id6（0）为下一名的 roster [2,6]——同系 +100。
    const cfg = makeTeamConfig({ p2Roster: [2, 6] });
    const res = play(new Sim(cfg), [
      [1, Btn.attack, 0],
      [540, 0, 0], // KO@~30 → 换人推进 hold 420@~450 + 入场开场起步
    ]);
    const end = stateOf(res);
    expect(end.fighters.map((f) => f.id)).toEqual([1, 6]);
    // id2 KO 时 qi = 50（KO 不吃受击回气）→ id6 comicType=0 同败方 → +100 = 150
    expect(end.fighters.find((f) => f.id === 6)!.qi).toBeCloseTo(150, 6);
  });

  it('skip（back）可跳过回合结束演出：置位当拍计满换人', () => {
    const res = play(new Sim(makeTeamConfig()), [
      [1, Btn.attack, 0],
      [40, 0, 0], // roundEnd 已置位
    ]);
    // back 跳过演出 → hold 立即计满 → 下一 tick 换人
    const end = stateOf(play(res.sim, [[3, Btn.back, 0]]));
    expect(end.roundEnd).toBeUndefined();
    expect(end.fighters.map((f) => f.id)).toEqual([1, 4]);
  });

  it('败方侧耗尽 → 终局：match:over {winner} + over 冻结', () => {
    const cfg = makeTeamConfig({ p2Roster: [2] });
    const res = play(new Sim(cfg), [
      [1, Btn.attack, 0],
      [540, 0, 0], // KO@~30 → 终局推进 hold 420@~450 → match:over + over 冻结
    ]);
    const end = stateOf(res);
    expect(end.roundEnd?.over).toBe(true);
    expect(res.events.some((e) => e.type === 'match:over' && e.payload['winner'] === 1)).toBe(true);
    expect(end.match.p2Wins).toBe(0);
    expect(end.match.p1Wins).toBe(1);
    // 终局冻结：继续 tick 不再换人
    const after = stateOf(play(res.sim, [[10, 0, 0]]));
    expect(after.fighters.map((f) => f.id)).toEqual([1, 2]);
  });

  it('两轮换人打满 → 胜方侧终局判定', () => {
    // 节拍：KO 字样窗口 120 + showWinner 延迟 120 + 胜利动作 180 = 换人推进
    // hold 420；换人开场 ≈282 tick → 入场后可操作窗口在 KO 后 ~730 tick 起，
    // 攻击窗口取 770+
    const res = play(new Sim(makeTeamConfig()), [
      [1, Btn.attack, 0],
      [770, 0, 0], // id2 败@~31 → id4 入场@~451，开场收@~733
      [1, Btn.attack, 0],
      [840, 0, 0], // id4 败@~802 → id6 入场@~1222，开场收@~1504
      [1, Btn.attack, 0],
      [890, 0, 0], // id6 败@~1644 → p2 耗尽 → match:over@~2064
    ]);
    expect(res.events.some((e) => e.type === 'match:over' && e.payload['winner'] === 1)).toBe(true);
    const end = stateOf(res);
    expect(end.roundEnd?.over).toBe(true);
    expect(end.match.round).toBeGreaterThanOrEqual(3);
  });

  it('确定性：团队流程两遍全量状态哈希一致', () => {
    const segs: [number, number, number][] = [
      [1, Btn.attack, 0],
      [770, 0, 0],
      [1, Btn.attack, 0],
      [840, 0, 0],
      [1, Btn.attack, 0],
      [890, 0, 0],
    ];
    const a = play(new Sim(makeTeamConfig()), segs);
    const b = play(new Sim(makeTeamConfig()), segs);
    expect(a.sim.serializeState()).toBe(b.sim.serializeState());
  });

  it('1v1 终局演出收编：KO 置位 roundEnd（teams 不落键）→ hold 计满 match:over', () => {
    const def = makeDef('test');
    const cfg: SimConfig = {
      seed: 1,
      stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
      fighters: [
        { id: 1, x: 100, hp: 25, def },
        { id: 2, x: 130, hp: 25, def },
      ],
    };
    const res = play(new Sim(cfg), [
      [1, Btn.attack, 0],
      [260, 0, 0], // KO@~30 → hold≈257：KO 字样窗口 + showWinner 延迟过、WIN 已应用
    ]);
    const st = stateOf(res);
    // 终局演出置位（1v1 与 team 同一状态机，原版 GameEndCtrler 通用语义）
    expect(st.roundEnd).toBeDefined();
    expect(st.roundEnd!.winnerId).toBe(1);
    expect(st.roundEnd!.loserId).toBe(2);
    expect(st.roundEnd!.winApplied).toBe(true);
    // 胜方未满血（挨过 p2 首击？无——p1 hp 25 满血反杀）→ perfect
    expect(st.roundEnd!.perfect).toBe(true);
    // 1v1 无回血（原版 case1 isTeamMode 门）
    expect(st.fighters.find((f) => f.id === 1)!.hp).toBe(25);
    expect(st.match.teams).toBeUndefined();
    // 演出未计满：无 match:over
    expect(res.events.some((e) => e.type === 'match:over')).toBe(false);
    // hold 计满 → 终局（match:over winner 1）
    const cont = play(res.sim, [[200, 0, 0]]);
    expect(cont.events.some((e) => e.type === 'match:over' && e.payload['winner'] === 1)).toBe(true);
    expect(stateOf(cont).roundEnd?.over).toBe(true);
    expect(stateOf(cont).match.p1Wins).toBe(1);
  });

  it('KO 终结演出链：hit_end 打点事件 + 击飞败方终结慢镜头（半速 → 落地 → 延迟 → WIN）', () => {
    // 击飞致死（原版 FightUI.renderEnd：败方 HURT_FLYING → slowDown(2,0) 半速
    // 直到落地 → _showWinnerDelay → showWinner）：hity -30 大抛物线保证字样
    // 窗口（hold 120）内败方仍在空中
    const def = makeDef('test');
    const cfg: SimConfig = {
      seed: 1,
      stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
      fighters: [
        { id: 1, x: 100, hp: 25, def: { ...def, actions: { k1: { power: 30, hitType: 1, hitx: 3, hity: -30, hurtTime: 300, hurtType: 1, isBreakDef: false, isApplyG: true } } } },
        { id: 2, x: 130, hp: 25, def },
      ],
    };
    const res = play(new Sim(cfg), [
      [1, Btn.attack, 0],
      [200, 0, 0], // KO@~31 → hold≈169：字样窗口过、飞尸仍在空中
    ]);
    // KO 同拍表现事件（原版 playKO：hit_end 钉败方位 + 白闪 α0.5 + 屏震；
    // 平局才省略 hit_end/shine）
    const koEv = res.events.filter((e) => e.type === 'effect' && e.payload['id'] === 'hit_end');
    expect(koEv.length).toBe(1);
    const loserAtKo = res.snaps.find((s) => s.state.roundEnd != null)!.state.fighters.find((f) => f.id === 2)!;
    expect(koEv[0]!.payload['x']).toBe(loserAtKo.x);
    expect(koEv[0]!.payload['y']).toBe(loserAtKo.y);
    const shine = res.events.find((e) => e.type === 'effect' && e.payload['id'] === 'shine');
    expect(shine!.payload['params']).toEqual({ color: 0xffffff, alpha: 0.5 });
    // 字样窗口过后败方仍在空中 → 慢镜头激活（位移半速 + 动画 15Hz）
    const gate = res.snaps[res.snaps.length - 1]!.state.roundEnd!;
    expect(gate.slow).toBe(true);
    // 落地前 WIN 不应用
    expect(gate.winApplied).toBe(false);
    // 慢镜头到落地 → 延迟 → WIN（长飞尸实时 >2s → 短延迟 60 折算）
    const cont = play(res.sim, [[600, 0, 0]]);
    const applied = cont.snaps.find((s) => s.state.roundEnd?.winApplied === true);
    expect(applied).toBeDefined();
    // WIN 落位拍 slow 不强制 false（批次 63 窗口冻结后时序后移）：尸体
    // HURT_DOWN_TAN 弹起可落入延迟窗再置 slow——原版 renderEnd 的
    // _showWinnerDelay 分支先行、弹起不清延迟，落位拍语义一致
    // 落地时刻（slow 最后为 true 的快照）→ winAppliedHold 差 = showWinner 延迟
    //（原版 _showWinnerDelay 2s/1s 折算 120/60 tick；落地拍快照 slow 仍为 true、
    //  下一拍才检出落地关慢镜头，故差值带 1 拍快照边界偏移）
    let landHold = -1;
    for (const s of [...res.snaps, ...cont.snaps]) {
      if (s.state.roundEnd?.slow === true) landHold = s.state.roundEnd.hold;
    }
    expect(landHold).toBeGreaterThan(120);
    const delta = applied!.state.roundEnd!.winAppliedHold - landHold;
    expect(delta === 59 || delta === 60 || delta === 119 || delta === 120).toBe(true);
  });

  it('1v1 训练模式不置位 roundEnd（训练语义不打断）', () => {
    const def = makeDef('test');
    const cfg: SimConfig = {
      seed: 1,
      training: true,
      stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
      fighters: [
        { id: 1, x: 100, hp: 25, def },
        { id: 2, x: 130, hp: 25, def },
      ],
    };
    const res = play(new Sim(cfg), [
      [1, Btn.attack, 0],
      [40, 0, 0],
    ]);
    const st = stateOf(res);
    expect(st.roundEnd).toBeUndefined();
    expect(res.events.some((e) => e.type === 'match:over')).toBe(false);
  });
});
