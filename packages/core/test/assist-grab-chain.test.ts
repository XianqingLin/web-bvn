import { describe, expect, it } from 'vitest';
import {
  Btn,
  Sim,
  type AssisterDef,
  type FighterDef,
  type SimConfig,
  type SimState,
} from '../src/index.js';

/**
 * 切片 21 B1 机制测试：byakuya 抓取链 customFunc 三函数 + attacker 元件
 * 脚本分派 + finishIfNoAttacker 守卫 + loop 同标签 rewind 保活。
 *
 * 时间轴镜像 byakuya baked（帧号 1 基，与 compileAssistant 输出同基）：
 *   f50 setHitTarget('chkm','CHK')；f51 gotoAndPlay('CHK_False')（miss 分支，
 *   跳过 CHK 段）；f52 addCustomFunc(ownerDeadClearAttacker)+addAttacker；
 *   f60 removeCustomFunc+addCustomFunc(attackerEndOnTargetLeave{state:21})；
 *   f72 finishIfNoAttacker+gotoAndPlay('loop')（loop 标签 71-74，
 *   totalFrames=74 → 71/72 ping-pong 保活）。
 * attacker 元件（atmmc，totalFrames 15）：f9 stop（定格吸附）、
 *   f10 stopFollowTarget（'end' 落点解除吸附）。
 */

const HIT = {
  power: 10,
  hitType: 1,
  hitx: 3,
  hity: 0,
  hurtTime: 5000, // 长硬直：受击方长时间停留在 HURT_ING(21)
  hurtType: 0,
  isBreakDef: false,
  isApplyG: true,
};

export function makeFighterDef(): FighterDef {
  const labels: FighterDef['labels'] = {
    站立: { index: 0, duration: 9 },
    走: { index: 9, duration: 24 },
    砍1: { index: 54, duration: 17 },
    被打: { index: 71, duration: 8 },
    击飞: { index: 79, duration: 10 },
    击飞_倒: { index: 89, duration: 9 },
    起身: { index: 98, duration: 9 },
  };
  const areas: FighterDef['areas'] = {};
  for (let fr = 1; fr <= 120; fr++) {
    const list: FighterDef['areas'][number] = [
      { name: 'bdmn', x: -10, y: -40, w: 20, h: 40 },
    ];
    if (fr === 58 || fr === 59) list.push({ name: 'k1atm', x: 10, y: -40, w: 420, h: 40 });
    areas[fr] = list;
  }
  return {
    id: 'test-f',
    formIndex: 0,
    speed: 6,
    jumpPower: 15,
    heavy: 3,
    actions: { k1: { ...HIT } },
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

export function makeGrabAssistDef(areaW: number): AssisterDef {
  return {
    id: 't-grab',
    actions: {},
    labels: {
      CHK: { index: 51, duration: 1 },
      CHK_False: { index: 52, duration: 18 },
      loop: { index: 70, duration: 4 },
    },
    areas: { 50: [{ name: 'chkm', x: 0, y: -530, w: areaW, h: 1000 }] },
    totalFrames: 74,
    triggers: [
      { frame: 50, target: 'assister', op: 'setHitTarget', args: ['chkm', 'CHK'] },
      { frame: 51, target: 'assister', op: 'gotoAndPlay', args: ['CHK_False'] },
      {
        frame: 52,
        target: 'assister',
        op: 'addCustomFunc',
        args: [{ kind: 'ownerDeadClearAttacker', attacker: 'atmmc' }],
      },
      {
        frame: 52,
        target: 'assister',
        op: 'addAttacker',
        args: [
          'atmmc',
          {
            x: { followTarget: true, offset: 0 },
            y: { followTarget: true, offset: -30 },
            applyG: false,
          },
        ],
      },
      { frame: 60, target: 'assister', op: 'removeCustomFunc', args: [] },
      {
        frame: 60,
        target: 'assister',
        op: 'addCustomFunc',
        args: [
          {
            kind: 'attackerEndOnTargetLeave',
            attacker: 'atmmc',
            state: 21,
            endLabel: 'end',
            next: 'finishWhenAttackerGone',
          },
        ],
      },
      { frame: 72, target: 'assister', op: 'finishIfNoAttacker', args: ['atmmc'] },
      { frame: 72, target: 'assister', op: 'gotoAndPlay', args: ['loop'] },
    ],
    loopTriggers: [],
    fires: { atmmc: { totalFrames: 15, labels: { end: 10 } } },
    attackerScripts: {
      atmmc: {
        labels: { end: 10 },
        triggers: [
          { frame: 9, target: 'attacker', op: 'stop', args: [] },
          { frame: 10, target: 'attacker', op: 'stopFollowTarget', args: [] },
        ],
      },
    },
  };
}

export function makeConfig(areaW: number): SimConfig {
  const def = makeFighterDef();
  return {
    seed: 1,
    stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
    fighters: [
      { id: 1, x: 300, def, assistId: 't-grab' },
      { id: 2, x: 700, def },
    ],
    assistants: { 't-grab': makeGrabAssistDef(areaW) },
  };
}

interface Snap {
  tick: number;
  state: SimState;
}

/** 召唤辅助（+可选攻击）并跑 N tick，逐 tick 快照。 */
export function run(config: SimConfig, ticks: number, attackAt = -1): { sim: Sim; snaps: Snap[] } {
  const sim = new Sim(config);
  const snaps: Snap[] = [];
  for (let t = 0; t < ticks; t++) {
    const bit = (t < 2 ? Btn.assist : 0) | (t === attackAt ? Btn.attack : 0);
    const snap = sim.tick({ p1: bit, p2: 0 });
    snaps.push({ tick: snap.tick, state: snap.state });
  }
  return { sim, snaps };
}

/** 从快照分叉：hp 置 0（模拟死亡，辅助退场判定只读 hp）后继续跑。 */
function continueAfterKill(
  sim: Sim,
  snap: Snap,
  config: SimConfig,
  ticks: number,
): Snap[] {
  const state = JSON.parse(JSON.stringify(snap.state)) as SimState;
  state.fighters[0]!.hp = 0;
  const sim2 = Sim.fromState(state, sim.getDefEntries(), {
    assistants: config.assistants,
  });
  const out: Snap[] = [];
  for (let t = 0; t < ticks; t++) {
    out.push({ tick: t, state: sim2.tick({ p1: 0, p2: 0 }).state });
  }
  return out;
}

describe('切片 21：byakuya 抓取链 customFunc + attacker 元件脚本', () => {
  it('命中路径：attacker stop@9 定格吸附 → loop 保活 → 目标离开 21 释放 → 播尽 → finish', () => {
    const { sim, snaps } = run(makeConfig(1000), 400, 6);
    // 定格：attacker 到达帧 9 → stop → animHold
    const holdSnap = snaps.find((s) =>
      s.state.attackers.some((a) => a.viaAssist && a.animHold && a.animFrame === 9),
    );
    expect(holdSnap).toBeDefined();
    const held = holdSnap!.state.attackers.find((a) => a.viaAssist)!;
    const heldP2 = holdSnap!.state.fighters[1]!;
    expect(held.y).toBe(heldP2.y - 30); // 吸附期间 followTarget 保持
    // loop 保活：远超 totalFrames-1(73) 边界仍在场（此前实现 loop 走到
    // 时间轴末自动退场——同标签守卫吞掉 rewind）
    const late = snaps[200]!;
    expect(late.state.assisters).toHaveLength(1);
    expect(late.state.attackers).toHaveLength(1);
    const lateAssist = late.state.assisters[0]!;
    expect(lateAssist.animFrame).toBeGreaterThanOrEqual(71);
    expect(lateAssist.actLabel).toBe('loop');
    // 释放：目标硬直结束离开 21 → attacker 跳 'end'（帧 ≥10、解除定格）
    const endSnap = snaps.find((s) =>
      s.state.attackers.some((a) => a.viaAssist && !a.animHold && a.animFrame >= 10),
    );
    expect(endSnap).toBeDefined();
    expect(endSnap!.state.fighters[1]!.actionState).not.toBe(21);
    // 末态：attacker 播尽移除 → finishWhenAttackerGone/finishIfNoAttacker → 辅助退场
    const last = snaps.at(-1)!.state;
    expect(last.attackers).toHaveLength(0);
    expect(last.assisters).toHaveLength(0);
  });

  it('owner 死亡（checkFunc 窗口内）：customFunc 先清 attacker 再退场，无 end 播放', () => {
    const { sim, snaps } = run(makeConfig(1000), 300, 6);
    // attacker 已生成、辅助帧 53-58（ownerDeadClearAttacker 在槽）
    const mid = snaps.find((s) => {
      const a = s.state.assisters[0];
      return (
        a !== undefined && a.animFrame >= 53 && a.animFrame <= 58 && s.state.attackers.length > 0
      );
    });
    expect(mid).toBeDefined();
    const after = continueAfterKill(sim, mid!, makeConfig(1000), 40);
    const gone = after.find((s) => s.state.assisters.length === 0);
    expect(gone).toBeDefined();
    // 同一动画帧：attacker 已被 checkFunc 移除（stopFollow+removeSelf）
    expect(gone!.state.attackers).toHaveLength(0);
    // 全程无 end 段播放
    expect(after.every((s) => s.state.attackers.every((a) => a.animFrame < 10))).toBe(true);
  });

  it('owner 死亡（loop 段，目标仍在 21）：辅助退场；attacker 定格孤儿（原版同语义）', () => {
    const { sim, snaps } = run(makeConfig(1000), 300, 6);
    const mid = snaps.find(
      (s) =>
        s.state.assisters[0] !== undefined &&
        s.state.assisters[0]!.animFrame >= 71 &&
        s.state.attackers.some((a) => a.animHold),
    );
    expect(mid).toBeDefined();
    const after = continueAfterKill(sim, mid!, makeConfig(1000), 40);
    // 辅助退场（owner 死亡判定在 customFunc 之后；p2 仍处 21 → checkFunc1
    // 门态未离开 → 无释放，attacker stop 定格不自动移除——原版孤儿语义）
    const assistGone = after.findIndex((s) => s.state.assisters.length === 0);
    expect(assistGone).toBeGreaterThanOrEqual(0);
    expect(assistGone).toBeLessThanOrEqual(2); // 下一动画帧即退场
    const last = after.at(-1)!.state;
    expect(last.attackers).toHaveLength(1);
    expect(last.attackers[0]!.animFrame).toBe(9);
    expect(last.attackers[0]!.animHold).toBe(true);
  });

  it('未中路径：CHK_False 分支跳过 CHK 段 → 无 attacker → finishIfNoAttacker 退场', () => {
    const { snaps } = run(makeConfig(10), 250);
    expect(snaps.every((s) => s.state.attackers.every((a) => !a.viaAssist))).toBe(true);
    expect(snaps.some((s) => s.state.assisters[0]?.actLabel === 'CHK_False')).toBe(true);
    expect(snaps.at(-1)!.state.assisters).toHaveLength(0);
  });
});
