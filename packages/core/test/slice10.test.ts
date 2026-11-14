import { describe, expect, it } from 'vitest';
import {
  ActionState,
  Btn,
  Sim,
  switchForm,
  type AreaRect,
  type FighterDef,
  type SimConfig,
  type SimEvent,
  type SimState,
} from '../src/index.js';

/**
 * 切片 10 机制测试：逐区命中结算（摔技二段分流语义）/ 二段跳 / 快速下落 /
 * 瞬身步家族（地面步/空中瞬跳）/ 万解形态切换（doWanKai/switchForm）+ 确定性。
 *
 * def 帧布局：砍1 55-71（k1atm 58-59、k12atm 65-66——同一动作两个命中段）；
 * 开场 500-509（形态切换演出标签）。双形态 def：rootFrame 1 / 200。
 */

const HIT_K1 = {
  power: 30,
  hitType: 1,
  hitx: 0, // 0 位移：两段命中期间目标不动，几何保持
  hity: 0,
  hurtTime: 300,
  hurtType: 0,
  isBreakDef: false,
  isApplyG: true,
};

const HIT_K12 = { ...HIT_K1, power: 60 };

function makeLabels(): FighterDef['labels'] {
  return {
    站立: { index: 0, duration: 9 },
    走: { index: 9, duration: 24 },
    起跳: { index: 33, duration: 5 },
    跳中: { index: 38, duration: 6 },
    落: { index: 44, duration: 6 },
    落地: { index: 50, duration: 4 },
    砍1: { index: 54, duration: 17 },
    被打: { index: 71, duration: 8 },
    击飞: { index: 79, duration: 10 },
    防御: { index: 142, duration: 6 },
    防御恢复: { index: 148, duration: 12 },
    瞬步: { index: 160, duration: 20 },
    开场: { index: 500, duration: 10 },
  };
}

function makeAreas(): FighterDef['areas'] {
  const areas: FighterDef['areas'] = {};
  for (let fr = 1; fr <= 510; fr++) {
    const list: AreaRect[] = [{ name: 'bdmn', x: -10, y: -40, w: 20, h: 40 }];
    if (fr === 58 || fr === 59) list.push({ name: 'k1atm', x: 10, y: -40, w: 30, h: 30 });
    if (fr === 65 || fr === 66) list.push({ name: 'k12atm', x: 10, y: -40, w: 30, h: 30 });
    areas[fr] = list;
  }
  return areas;
}

function makeForm(rootFrame: number, formIndex: number): FighterDef {
  return {
    id: 'test',
    formIndex,
    rootFrame,
    speed: 6,
    jumpPower: 15,
    heavy: 3,
    actions: { k1: { ...HIT_K1 }, k12: { ...HIT_K12 } },
    labels: makeLabels(),
    areas: makeAreas(),
    totalFrames: 510,
    triggers: [],
    attackLabels: { k1: '砍1' },
  };
}

function makeConfig(opts: { p2x?: number; forms?: FighterDef[]; floors?: SimConfig['stage']['floors'] } = {}): SimConfig {
  const forms = opts.forms ?? [makeForm(1, 0)];
  return {
    seed: 1,
    stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: opts.floors ?? [] },
    fighters: [
      { id: 1, x: 100, def: forms[0], forms },
      { id: 2, x: opts.p2x ?? 700, def: forms[0], forms },
    ],
  };
}

/** 追加帧触发器（构造前注入 form0 def）+ 状态预置。缺省双形态（rootFrame 1/200）。 */
function makeSim(
  opts: {
    p2x?: number;
    floors?: SimConfig['stage']['floors'];
    triggers?: { frame: number; target: string; op: string; args: unknown[] }[];
    mutate?: (s: SimState) => void;
  } = {},
): Sim {
  const forms = [makeForm(1, 0), makeForm(200, 1)];
  forms[0]!.triggers.push(...((opts.triggers ?? []) as never));
  const sim = new Sim(makeConfig({ p2x: opts.p2x, floors: opts.floors, forms }));
  if (opts.mutate) {
    const state = JSON.parse(sim.serializeState()) as SimState;
    opts.mutate(state);
    return Sim.fromState(state, sim.getDefEntries());
  }
  return sim;
}

function play(
  sim: Sim,
  segments: [number, number, number][],
): { sim: Sim; events: SimEvent[]; snaps: { tick: number; state: SimState }[] } {
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

describe('切片 10：逐区命中结算（摔技二段分流语义）', () => {
  it('同一动作的两个命中段各自结算：k1atm(30) + k12atm(60)，多段按受击窗重命中（修复批次 34）', () => {
    // 砍1 时间轴内 k1atm 帧 58-59、k12atm 帧 65-66：逐区解析后两段独立命中。
    // 修复批次 34 拆除跨帧去重门（原版 checkHit 每帧重扫）：hitx=0 目标静止，
    // k12atm 段内受击窗到期（被打标签播尽 endAction 恢复 allow）→ 重命中一次，
    // 合计 30 + 60×2。多段命中频率由受击方 HURT_GAP_FRAME=4 帧窗限频。
    const res = play(makeSim({ p2x: 130 }), [
      [1, Btn.attack, 0],
      [31, 0, 0], // 仍处于 砍1（17 动画帧 = 34 tick）内采样
    ]);
    const p1 = res.snaps.at(-1)!.state.fighters[0]!;
    const p2 = res.snaps.at(-1)!.state.fighters[1]!;
    expect(p1.actionState).toBe(ActionState.ATTACK_ING);
    expect(p2.hp).toBe(1000 - 30 - 60 - 60);
    const hitEvents = res.events.filter((e) => e.type === 'hit:connect');
    expect(hitEvents.length).toBe(3); // k1 一击 + k12 段内两击
  });

  it('两段命中之间血量单调递减（重复命中按受击窗限频）', () => {
    const res = play(makeSim({ p2x: 130 }), [
      [1, Btn.attack, 0],
      [31, 0, 0],
    ]);
    let prev = 1000;
    for (const s of res.snaps) {
      const hp = s.state.fighters[1]!.hp;
      expect(hp).toBeLessThanOrEqual(prev);
      expect(hp).toBeGreaterThanOrEqual(1000 - 30 - 60 - 60);
      prev = hp;
    }
  });
});

describe('切片 10：跳跃家族（jumpTimes / 起跳延迟 / 快速下落）', () => {
  it('二段跳：地面跳 + 空中跳各耗 1，jumpTimes 耗尽后不可再跳', () => {
    const res = play(makeSim(), [
      [1, Btn.jump, 0], // 地面跳：JUMP_ING + 起跳延迟 2
      [2, 0, 0], // 延迟结束 → 离地
    ]);
    const after = res.snaps.at(-1)!.state.fighters[0]!;
    expect(after.onGround).toBe(false);
    expect(after.vy).toBeLessThan(0);
    expect(after.jumpTimes).toBe(1);

    const res2 = play(makeSim(), [
      [1, Btn.jump, 0],
      [5, 0, 0], // 稳定上升段
      [1, Btn.jump, 0], // 空中跳（延迟 1）
      [1, 0, 0], // 延迟结束
    ]);
    const air = res2.snaps.at(-1)!.state.fighters[0]!;
    expect(air.jumpTimes).toBe(0);
    expect(air.vy).toBeLessThan(0);
    expect(air.onGround).toBe(false);

    // jumpTimes=0 后再按跳：不重新起跳（继续原上升轨迹，无二次上抛折点）
    const y0 = air.y;
    const res3 = play(makeSim(), [
      [1, Btn.jump, 0],
      [5, 0, 0],
      [1, Btn.jump, 0],
      [1, 0, 0],
      [1, Btn.jump, 0], // 第三跳：拒绝
      [4, 0, 0],
    ]);
    const third = res3.snaps.at(-1)!.state.fighters[0]!;
    expect(third.jumpTimes).toBe(0);
    expect(third.y).toBeLessThan(y0);
  });

  it('快速下落（↓+跳）：jumpTimes 清零、穿平台下坠、落到主地面', () => {
    const res = play(
      makeSim({
        floors: [{ xFrom: 200, xTo: 300, y: 300 }],
        mutate: (s) => {
          s.fighters[0]!.x = 250;
          s.fighters[0]!.y = 300; // 站在平台上
        },
      }),
      [
        [1, Btn.down | Btn.jump, 0], // 快速下落发起
        [80, 0, 0], // 穿过平台落到主地面
      ],
    );
    const first = res.snaps[0]!.state.fighters[0]!;
    expect(first.jumpTimes).toBe(0);
    expect(first.onGround).toBe(false);
    expect(first.vy).toBe(2.5);
    const end = res.snaps.at(-1)!.state.fighters[0]!;
    expect(end.onGround).toBe(true);
    expect(end.y).toBe(500);
  });
});

describe('切片 10：瞬身步家族', () => {
  it('地面瞬身步（dash+↓）：气 60 + 能量 80、免伤穿越、结束后回位', () => {
    // 防御先发起（防御分支先于瞬身步一拍），缓冲中的 dash 在防御分支接瞬身步
    const res = play(
      makeSim({
        mutate: (s) => {
          s.fighters[0]!.qi = 100;
        },
      }),
      [
        [1, Btn.down | Btn.dash, 0],
        [1, Btn.down, 0],
      ],
    );
    const g = res.snaps.at(-1)!.state.fighters[0]!;
    expect(g.ghostTicks).toBeGreaterThan(0);
    expect(g.qi).toBe(40); // 100 - 60
    expect(g.energy).toBe(20); // 100 - 80
    expect(g.isAllowBeHit).toBe(false);
    expect(g.isCross).toBe(true);
    expect(g.vx).toBe(4); // move(8,0) × 0.5 × facing(1)

    const res2 = play(res.sim, [[26, 0, 0]]);
    const end = res2.snaps.at(-1)!.state.fighters[0]!;
    expect(end.ghostTicks).toBe(0);
    expect(end.isAllowBeHit).toBe(true);
    expect(end.actionState).toBe(ActionState.NORMAL);
    expect(end.ghostCooldown).toBe(0); // 自然到期：无连续冷却
  });

  it('气不足 60 → 地面瞬身步拒绝（不消耗资源）', () => {
    const res = play(
      makeSim({
        mutate: (s) => {
          s.fighters[0]!.qi = 59;
        },
      }),
      [
        [1, Btn.down | Btn.dash, 0],
        [2, Btn.down, 0],
      ],
    );
    const f = res.snaps.at(-1)!.state.fighters[0]!;
    expect(f.ghostTicks).toBe(0);
    expect(f.qi).toBe(59);
    expect(f.energy).toBe(100);
  });

  it('空中瞬跳（dash+↑）：vy -6 / dampY 0.05 / jumpTimes-1，结束后续飘（airMove）', () => {
    const res = play(
      makeSim({
        mutate: (s) => {
          s.fighters[0]!.qi = 100;
        },
      }),
      [
        [1, Btn.jump, 0], // 地面跳
        [4, 0, 0], // 离地稳定上升
        [1, Btn.dash | Btn.up, 0], // 空中瞬跳
      ],
    );
    const g = res.snaps.at(-1)!.state.fighters[0]!;
    expect(g.ghostTicks).toBeGreaterThan(0);
    expect(g.actionState).toBe(ActionState.JUMP_ING);
    expect(g.vy).toBeLessThan(0);
    expect(g.vy).toBeGreaterThan(-6.5);
    expect(g.dampY).toBe(0.05);
    expect(g.jumpTimes).toBe(0); // 地面跳 1 + 瞬跳 1
    expect(g.isAllowBeHit).toBe(false);

    const res2 = play(res.sim, [[24, 0, 0]]);
    const end = res2.snaps.at(-1)!.state.fighters[0]!;
    expect(end.ghostTicks).toBe(0);
    expect(end.airMove).toBe(true); // 原版 ghostType 1 结束：空中可行走
    expect(end.dampY).toBeGreaterThan(0); // 恢复 damping(0,-vy/10) 语义
    expect(end.onGround).toBe(false);
  });
});

describe('切片 10：万解形态切换', () => {
  it('switchForm 单元：下一形态 / rootFrame 寻址 / 无匹配静默', () => {
    const forms = [makeForm(1, 0), makeForm(200, 1)];
    const sim = makeSim();
    const state = JSON.parse(sim.serializeState()) as SimState;
    const fighter = state.fighters[0]!;

    const next = switchForm(fighter, forms, 0); // 下一形态
    expect(next).not.toBeNull();
    expect(fighter.formIndex).toBe(1);
    expect(fighter.actLabel).toBe('开场'); // 新形态播 开场
    expect(fighter.animFrame).toBe(501);
    expect(fighter.slots.attack).toBe('砍1'); // 槽按新形态重填

    fighter.formIndex = 0;
    expect(switchForm(fighter, forms, 200)?.formIndex).toBe(1); // rootFrame 寻址
    fighter.formIndex = 1;
    expect(switchForm(fighter, forms, 0)).toBeNull(); // 已是末形态
    expect(switchForm(fighter, forms, 999)).toBeNull(); // 无匹配 rootFrame
    expect(fighter.formIndex).toBe(1);
  });

  it('帧触发 switchForm：formIndex 切换 + 开场演出 + fighter:form 事件', () => {
    const res = play(
      makeSim({
        p2x: 130,
        triggers: [{ frame: 56, target: 'fighter', op: 'switchForm', args: [0] }],
      }),
      [
        [1, Btn.attack, 0],
        [5, 0, 0],
      ],
    );
    const f = res.snaps.at(-1)!.state.fighters[0]!;
    expect(f.formIndex).toBe(1);
    expect(f.actLabel).toBe('开场');
    const formEvents = res.events.filter((e) => e.type === 'fighter:form');
    expect(formEvents.length).toBeGreaterThan(0);
    expect((formEvents[0]!.payload as { fighter: number; form: number }).form).toBe(1);
  });

  it('单形态（forms 未注册第二形态）switchForm 静默：formIndex 不变、无事件', () => {
    const sim = new Sim(makeConfig({ p2x: 130 }));
    const res = play(sim, [
      [1, Btn.attack, 0],
      [5, 0, 0],
    ]);
    const f = res.snaps.at(-1)!.state.fighters[0]!;
    expect(f.formIndex).toBe(0);
    expect(res.events.every((e) => e.type !== 'fighter:form')).toBe(true);
  });
});

describe('切片 10：确定性', () => {
  it('瞬身步/跳跃/攻击混合剧本：序列化恢复后哈希一致', () => {
    const frames = Array.from({ length: 200 }, (_, i) => ({
      p1:
        i === 10
          ? Btn.down | Btn.dash
          : i === 11
            ? Btn.down
            : i === 40
              ? Btn.jump
              : i === 45
                ? Btn.jump
                : i === 80
                  ? Btn.attack
                  : 0,
      p2: i === 20 ? Btn.jump : 0,
    }));
    const simA = makeSim();
    for (let i = 0; i < 100; i++) simA.tick(frames[i]!);
    const saved = simA.serializeState();
    const tailA = frames.slice(100).map((f) => simA.tick(f).hash);

    const simB = Sim.fromState(Sim.deserializeState(saved), simA.getDefEntries());
    const tailB = frames.slice(100).map((f) => simB.tick(f).hash);
    expect(tailB).toEqual(tailA);
  });
});
