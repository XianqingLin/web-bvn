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
 * 多局制切片·回合计时（原版 GameCtrler.renderGameTime/timeover/drawGame +
 * runNext isSingleMode 三局两胜）：递减、timeover hp 判胜/平局、平局重开。
 * 团队流转/1v1 三局两胜主链在 team.test.ts。
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

/** 1v1 配置：fightTime 1 秒（62 tick 归零——快进 timeover），hp 100（单击 30 不致死）。 */
function makeConfig(opts: { p1Hp?: number } = {}): SimConfig {
  const def = makeDef('test');
  return {
    seed: 1,
    fightTime: 1,
    stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
    fighters: [
      { id: 1, x: 100, hp: opts.p1Hp ?? 100, def },
      { id: 2, x: 130, hp: 100, def },
    ],
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

describe('回合计时（多局制切片）', () => {
  it('递减 62 tick/秒：gameTime 1 秒归零 → timeover 置位（双方满血 = 平局）', () => {
    // 原版 renderGameTime 挂 30Hz renderAnimate 内 31 次调用减 1 秒 → 62 tick
    const res = play(new Sim(makeConfig()), [[1, 0, 0], [120, 0, 0]]);
    const reIdx = res.snaps.findIndex((s) => s.state.roundEnd != null);
    expect(reIdx).toBeGreaterThanOrEqual(0);
    const reSnap = res.snaps[reIdx]!;
    // 置位时刻 = roundFrame 62（tick 61 快照；roundFrame 自 tick 0 起每拍 +1）
    expect(reSnap.tick).toBe(61);
    expect(reSnap.state.match.gameTime).toBe(0);
    expect(reSnap.state.roundEnd!.timerOver).toBe(true);
    // 双方满血 → 平局（原版 hp 相等 → drawGame）；胜方判定取 P1（hp>=）
    expect(reSnap.state.roundEnd!.draw).toBe(true);
    // timeover 无 KO 表现链（原版 playTimeOver 无 hit_end/白闪/kobg/屏震）
    expect(res.events.some((e) => e.type === 'effect' && e.payload['id'] === 'hit_end')).toBe(false);
    expect(res.events.some((e) => e.type === 'effect' && e.payload['id'] === 'shine')).toBe(false);
    expect(res.events.some((e) => e.type === 'effect' && e.payload['id'] === 'shake')).toBe(false);
    expect(reSnap.state.fighters.every((f) => f.hp === 100)).toBe(true);
    // 平局不计胜场
    expect(reSnap.state.match.p1Wins).toBe(0);
    expect(reSnap.state.match.p2Wins).toBe(0);
  });

  it('timeover 平局 → 字样演出计满重开该轮（round++/满血/gameTime 重置，无 match:over）', () => {
    const res = play(new Sim(makeConfig()), [
      [1, 0, 0],
      [120, 0, 0], // timeover 置位@62
      [320, 0, 0], // 平局演出计满 ROUND_END_TOTAL=300 → 1v1 draw 重开
    ]);
    const end = stateOf(res);
    expect(end.match.round).toBe(2);
    expect(end.roundEnd).toBeUndefined();
    // 重开 = 原版 buildNextRound(false)：满血回出生点 + gameTime 重置满
    expect(end.fighters.every((f) => f.hp === 100)).toBe(true);
    expect(end.fighters[0]!.x).toBe(100);
    expect(end.fighters[1]!.x).toBe(130);
    expect(end.match.gameTime).toBe(1);
    // 字样重播（原版 startNextRound 无特写，intro 直入字样步）
    expect(end.intro).toBeDefined();
    expect(end.intro!.step).toBe(7);
    expect(res.events.some((e) => e.type === 'match:over')).toBe(false);
    expect(res.events.some((e) => e.type === 'round:start')).toBe(true);
  });

  it('timeover hp 判胜：低血方判负（未死）→ 胜方 WIN 演出 + 逐局计胜 → 重开', () => {
    const res = play(new Sim(makeConfig()), [
      [1, 0, Btn.attack], // p2 先手命中 → p1 hp 100→70
      [120, 0, 0], // timeover@62：p2 hp 高 → 胜方 side 2（原版 timeover hp 比较）
      [200, 0, 0], // WIN 落位（字样窗 120 + 延迟 60，置位后 ~242）
    ]);
    const reIdx = res.snaps.findIndex((s) => s.state.roundEnd != null);
    const reSnap = res.snaps[reIdx]!;
    expect(reSnap.state.roundEnd!.timerOver).toBe(true);
    expect(reSnap.state.roundEnd!.draw).toBe(false);
    expect(reSnap.state.roundEnd!.winnerId).toBe(2);
    expect(reSnap.state.roundEnd!.loserId).toBe(1);
    // 胜场逐局计（原版 doGameEnd wins++）
    expect(reSnap.state.match.p2Wins).toBe(1);
    expect(reSnap.state.match.p1Wins).toBe(0);
    // 败方活人（原版 timeover 不死）：无终结慢镜头、winnerDelay 恒 1s
    expect(reSnap.state.fighters.find((f) => f.id === 1)!.hp).toBe(70);
    // WIN 落位（字样窗 120 + 延迟 60 后）：胜方 WIN_ING + 胜利 label
    const winSnap = res.snaps.find((s) => s.state.roundEnd?.winApplied === true)!;
    const winner = winSnap.state.fighters.find((f) => f.id === 2)!;
    expect(winner.actionState).toBe(ActionState.WIN_ING);
    expect(winner.actLabel).toBe('胜利');
    // 1v1 无回血（原版 case1 isTeamMode 门）
    expect(winner.hp).toBe(100);
    // 演出计满（winAppliedHold ≈ 242 → 推进 ~482）→ wins<2 → 重开（round 2）
    const cont = play(res.sim, [[420, 0, 0]]);
    const r2 = stateOf(cont);
    expect(r2.match.round).toBe(2);
    expect(r2.match.p2Wins).toBe(1);
    expect(r2.fighters.every((f) => f.hp === 100)).toBe(true);
    expect(cont.events.some((e) => e.type === 'match:over')).toBe(false);
  });

  it('训练模式无时限：gameTimeMax -1，长时间不置位', () => {
    const def = makeDef('test');
    const cfg: SimConfig = {
      seed: 1,
      training: true,
      stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
      fighters: [
        { id: 1, x: 100, hp: 100, def },
        { id: 2, x: 130, hp: 100, def },
      ],
    };
    const res = play(new Sim(cfg), [[300, 0, 0]]);
    const st = stateOf(res);
    expect(st.match.gameTimeMax).toBe(-1);
    expect(st.match.gameTime).toBe(-1);
    expect(st.roundEnd).toBeUndefined();
    expect(res.events.some((e) => e.type === 'round:end')).toBe(false);
  });
});
