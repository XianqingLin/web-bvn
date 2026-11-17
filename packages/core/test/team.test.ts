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
    // p1 hp 100：先挨 p2 一击（100→70）再反杀，验证恢复 =(hpMax−hp)×0.33
    const res = play(new Sim(makeTeamConfig({ p1Hp: 100 })), [
      [1, 0, Btn.attack],
      [650, 0, 0], // p1 挨打 → 被打 硬直解除（hurtTime 300 @30Hz）
      [1, Btn.attack, 0],
      [40, 0, 0],
    ]);
    // KO 已置位：胜方 id1、败方 id2 死亡（KO 当拍，WIN 演出下一 tick 才应用）
    const reIdx = res.snaps.findIndex((s) => s.state.roundEnd != null);
    expect(reIdx).toBeGreaterThanOrEqual(0);
    const reSnap = res.snaps[reIdx]!;
    expect(reSnap.state.roundEnd!.winnerId).toBe(1);
    expect(reSnap.state.roundEnd!.loserId).toBe(2);
    // WIN 应用后（tickRoundEnd 首拍）：actionState=WIN_ING + 胜利 label + 血量恢复
    const winSnap = res.snaps.find((s) => s.state.roundEnd?.winApplied === true)!;
    const winner = winSnap.state.fighters.find((f) => f.id === 1)!;
    expect(winner.actionState).toBe(ActionState.WIN_ING);
    expect(winner.actLabel).toBe('胜利');
    expect(winner.hp).toBeCloseTo(70 + 30 * 0.33, 6);
    // 演出计满（180 tick，空输入不跳）→ 换人：id4 入场
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
      [260, 0, 0],
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
      [260, 0, 0],
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
    // 节拍：roundEnd hold 180 + 换人开场（focus 30 + gap 18 + resume 6 + banner
    // 156 ≈ 210）→ 入场后可操作窗口在 KO 后 ~400 tick 起，攻击窗口取 450+
    const res = play(new Sim(makeTeamConfig()), [
      [1, Btn.attack, 0],
      [450, 0, 0], // id2 败 → id4 入场（演出计满）
      [1, Btn.attack, 0],
      [500, 0, 0], // id4 败 → id6 入场
      [1, Btn.attack, 0],
      [450, 0, 0], // id6 败 → p2 耗尽 → match:over
    ]);
    expect(res.events.some((e) => e.type === 'match:over' && e.payload['winner'] === 1)).toBe(true);
    const end = stateOf(res);
    expect(end.roundEnd?.over).toBe(true);
    expect(end.match.round).toBeGreaterThanOrEqual(3);
  });

  it('确定性：团队流程两遍全量状态哈希一致', () => {
    const segs: [number, number, number][] = [
      [1, Btn.attack, 0],
      [450, 0, 0],
      [1, Btn.attack, 0],
      [500, 0, 0],
      [1, Btn.attack, 0],
      [450, 0, 0],
    ];
    const a = play(new Sim(makeTeamConfig()), segs);
    const b = play(new Sim(makeTeamConfig()), segs);
    expect(a.sim.serializeState()).toBe(b.sim.serializeState());
  });

  it('1v1（无 teams）零漂移：roundEnd/teams 不落键', () => {
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
      [40, 0, 0],
    ]);
    const st = stateOf(res);
    expect(st.roundEnd).toBeUndefined();
    expect(st.match.teams).toBeUndefined();
    // 1v1 KO 不置位（结束判定归 app 层）
    expect(res.events.some((e) => e.type === 'match:over')).toBe(false);
    expect(st.fighters.find((f) => f.id === 2)!.hp).toBe(0);
  });
});
