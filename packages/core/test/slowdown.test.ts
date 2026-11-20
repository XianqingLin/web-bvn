import { describe, expect, it } from 'vitest';
import {
  Btn,
  Sim,
  type FighterDef,
  type SimConfig,
  type SimState,
  type AreaRect,
} from '../src/index.js';

/**
 * 切片 49：slowDown 全局慢放（原版 EffectCtrler.slowDown(1.5, t*1000)，KO 链
 * 折算范式进 sim——DESIGN §3.5）。
 *
 * 手工 def（30Hz 帧布局，同 hitstop.test 简化版）：站立 1-9、砍1 55-71
 * （k1atm 58-59），砍1 第 57/59 帧挂 slowDown 触发（双触发验重置语义）。
 * 双方距离拉远（100 vs 800）不命中，只验慢放本体。
 */

const SLOW_SCALE = 1 / 1.5; // 原版 speedPlus = SPEED_PLUS_DEFAULT/1.5
const SLOW_ANIM_EVERY = 3; // 原版 ceil(FPS_GAME/(30/1.5)) = 3

function makeDef(retrigger = false): FighterDef {
  const labels: FighterDef['labels'] = {
    站立: { index: 0, duration: 9 },
    被打: { index: 71, duration: 8 },
    砍1: { index: 54, duration: 17 },
  };
  const areas: FighterDef['areas'] = {};
  for (let fr = 1; fr <= 100; fr++) {
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
    actions: {},
    labels,
    areas,
    totalFrames: 100,
    triggers: [
      { frame: 57, target: 'mc', op: 'slowDown', args: [0.5] },
      ...(retrigger ? [{ frame: 59, target: 'mc', op: 'slowDown', args: [1] }] : []),
      { frame: 69, target: 'mc', op: 'endAct', args: [] },
      { frame: 70, target: 'mc', op: 'idle', args: ['站立'] },
    ],
    attackLabels: { k1: '砍1' },
  };
}

function makeConfig(retrigger = false): SimConfig {
  return {
    seed: 1,
    stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
    fighters: [
      { id: 1, x: 100, def: makeDef(retrigger) },
      { id: 2, x: 800, def: makeDef(retrigger) },
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
): { snaps: SimState[] } {
  const snaps: SimState[] = [];
  for (const [frames, p1, p2] of segments) {
    for (let i = 0; i < frames; i++) {
      snaps.push(sim.tick({ p1, p2 }).state);
    }
  }
  return { snaps };
}

describe('slowDown 全局慢放（切片 49）', () => {
  it('op 置位：rate 1.5 折算（scale=2/3、animEvery=3、计时 t×60）', () => {
    const { snaps } = play(new Sim(makeConfig()), [[1, Btn.attack, 0], [40, 0, 0]]);
    const i = snaps.findIndex((s) => s.slowDown != null);
    expect(i).toBeGreaterThan(0);
    expect(snaps[i]!.slowDown).toEqual({ ticksLeft: 30, scale: SLOW_SCALE, animEvery: SLOW_ANIM_EVERY });
  });

  it('计时实时间递减（含置位 tick 共 30 个快照），到期清除', () => {
    const { snaps } = play(new Sim(makeConfig(false)), [[1, Btn.attack, 0], [60, 0, 0]]);
    const active = snaps.filter((s) => s.slowDown != null);
    expect(active).toHaveLength(30);
    expect(active[0]!.slowDown!.ticksLeft).toBe(30);
    expect(active[29]!.slowDown!.ticksLeft).toBe(1);
    expect(snaps[snaps.length - 1]!.slowDown).toBeUndefined();
  });

  it('重复触发重置计时（57 帧 0.5s → 59 帧 1s：ticksLeft 回升 60）', () => {
    const { snaps } = play(new Sim(makeConfig(true)), [[1, Btn.attack, 0], [80, 0, 0]]);
    const i = snaps.findIndex((s) => s.slowDown != null);
    expect(i).toBeGreaterThan(0);
    // 帧触发 30Hz 推进：57 帧置位后 59 帧在同一次慢放窗口内重置为 60
    const afterFirst = snaps.slice(i);
    const resetIdx = afterFirst.findIndex((s) => s.slowDown!.ticksLeft === 60);
    expect(resetIdx).toBeGreaterThan(0);
    // 活跃快照 = 重置前残余（resetIdx 个）+ 重置后 60 个
    expect(snaps.filter((s) => s.slowDown != null)).toHaveLength(resetIdx + 60);
  });

  it('慢放期位移 ×2/3（空中无重力载体）', () => {
    const inject = (s: SimState, slow: boolean) => {
      const f = s.fighters[0]!;
      f.x = 100;
      f.y = 460;
      f.onGround = false;
      f.applyG = false;
      f.vy = 0;
      f.vx = 3;
      f.dampX = 0;
      f.jumpDelay = 0;
      s.fighters[1]!.x = 800;
      if (slow) s.slowDown = { ticksLeft: 10, scale: SLOW_SCALE, animEvery: SLOW_ANIM_EVERY };
    };
    const slowRun = play(mutated(new Sim(makeConfig()), (s) => inject(s, true)), [[6, 0, 0]]).snaps;
    const normRun = play(mutated(new Sim(makeConfig()), (s) => inject(s, false)), [[6, 0, 0]]).snaps;
    // 慢放：每 tick 位移 3×(2/3)=2；常速：3
    expect(slowRun[5]!.fighters[0]!.x).toBeCloseTo(100 + 6 * 3 * SLOW_SCALE, 6);
    expect(normRun[5]!.fighters[0]!.x).toBeCloseTo(100 + 6 * 3, 6);
    // 速度本体不缩（原版 _velocity 在速度空间，缩放发生在消费侧 move()）
    expect(slowRun[5]!.fighters[0]!.vx).toBe(3);
  });

  it('慢放期重力斜坡增量与消费同步折算', () => {
    const inject = (s: SimState, slow: boolean) => {
      const f = s.fighters[0]!;
      f.x = 100;
      f.y = 460;
      f.onGround = false;
      f.applyG = true;
      f.vy = 0;
      f.vx = 0;
      f.dampX = 0;
      f.jumpDelay = 0;
      s.fighters[1]!.x = 800;
      if (slow) s.slowDown = { ticksLeft: 10, scale: SLOW_SCALE, animEvery: SLOW_ANIM_EVERY };
    };
    const slowRun = play(mutated(new Sim(makeConfig()), (s) => inject(s, true)), [[4, 0, 0]]).snaps;
    const normRun = play(mutated(new Sim(makeConfig()), (s) => inject(s, false)), [[4, 0, 0]]).snaps;
    // gRamp 存量不缩、增量 GRAVITY_STEP×scale（慢放 0.2/tick vs 常速 0.3/tick；
    // KO 链范式——gRamp 基值不可比，只比每 tick 增量）
    let slowDelta = 0;
    let normDelta = 0;
    for (let k = 1; k < 4; k++) {
      slowDelta += slowRun[k]!.fighters[0]!.gRamp - slowRun[k - 1]!.fighters[0]!.gRamp;
      normDelta += normRun[k]!.fighters[0]!.gRamp - normRun[k - 1]!.fighters[0]!.gRamp;
    }
    expect(slowDelta).toBeCloseTo(3 * 0.3 * SLOW_SCALE, 6);
    expect(normDelta).toBeCloseTo(3 * 0.3, 6);
  });

  it('慢放期时间轴 20Hz：每 3 tick 推进一帧（命中判定同门）', () => {
    const { snaps } = play(new Sim(makeConfig()), [[1, Btn.attack, 0], [40, 0, 0]]);
    const i = snaps.findIndex((s) => s.slowDown != null);
    // 置位 tick 起 6 个快照：门 = tick%3===0 → 恰 2 次推进
    let advances = 0;
    for (let k = i + 1; k <= i + 6; k++) {
      if (snaps[k]!.fighters[0]!.animFrame !== snaps[k - 1]!.fighters[0]!.animFrame) advances += 1;
    }
    expect(advances).toBe(2);
    // 推进 tick 恰为 tick%3===0
    const advTicks: number[] = [];
    for (let k = i + 1; k <= i + 6; k++) {
      if (snaps[k]!.fighters[0]!.animFrame !== snaps[k - 1]!.fighters[0]!.animFrame) {
        advTicks.push(snaps[k]!.tick);
      }
    }
    for (const t of advTicks) expect(t % 3).toBe(0);
  });

  it('弹位移/加速 ×2/3（原版 Bullet 位移与 addSpeed 均乘 speedPlus）', () => {
    const makeBullet = (s: SimState) => {
      s.bullets = [
        {
          id: 100,
          ownerId: 1,
          facing: 1,
          name: 'testb',
          x: 500,
          y: 460,
          w: 10,
          h: 10,
          sx: 3,
          sy: 0,
          addX: 1,
          addY: 0,
          minX: -999,
          maxX: 999,
          minY: -999,
          maxY: 999,
          holdTicks: -1,
          hitTimes: -1,
          hp: 100,
          hpMax: 100,
          hit: null as never,
          hitAble: false,
          viaAssist: false,
          animTotal: 0,
          animFrame: 1,
          animLabels: {},
          hitAnim: false,
        },
      ];
      s.nextEntityId = 101;
    };
    const slowRun = play(mutated(new Sim(makeConfig()), (s) => {
      makeBullet(s);
      s.slowDown = { ticksLeft: 10, scale: SLOW_SCALE, animEvery: SLOW_ANIM_EVERY };
    }), [[3, 0, 0]]).snaps;
    const normRun = play(mutated(new Sim(makeConfig()), makeBullet), [[3, 0, 0]]).snaps;
    // 递推核对（sx 每 tick 复合增长）：位移 = sx×SPEED_PLUS×scale、加速 = add×scale
    const simulate = (scale: number) => {
      let x = 500;
      let sx = 3;
      for (let k = 0; k < 3; k++) {
        x += sx * 0.5 * scale;
        sx += 1 * scale;
      }
      return { x, sx };
    };
    expect(slowRun[2]!.bullets[0]!.x).toBeCloseTo(simulate(SLOW_SCALE).x, 6);
    expect(slowRun[2]!.bullets[0]!.sx).toBeCloseTo(simulate(SLOW_SCALE).sx, 6);
    expect(normRun[2]!.bullets[0]!.x).toBeCloseTo(simulate(1).x, 6);
    expect(normRun[2]!.bullets[0]!.sx).toBeCloseTo(simulate(1).sx, 6);
  });
});
