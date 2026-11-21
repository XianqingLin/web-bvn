import { describe, expect, it } from 'vitest';
import { ActionState, Btn, Sim, type FighterDef, type SimConfig } from '../src/index.js';

/**
 * 角色侧 attacker 元件脚本回归（2026-11-21，原版 $attacker_ctrler.*）：
 *
 * 背景：原版 addAttacker 元件时间轴带 FighterAttackerCtrler 转发的帧脚本，
 * 驱动道具位移（move/damping）、命中续接跳转（setHitTarget + gotoAndPlay）
 * 与元件内弹体（fire）。切片 21 只给辅助侧接了脚本通道，角色生成道具
 * （pain 招1/招2 等 23 角色语料）此前静止在生成点、续接/爆炸不触发。
 *
 * fixture：道具 testmc 生成后 move(6,0)（3/tick）飞行；fire frame 3 起
 * tatm 命中区激活 + setHitTarget('tatm','hit')；接触 → gotoAndPlay('hit')@9
 * → frame 10 大命中区结算 t 动作伤害（40）。
 */

function makeDef(): FighterDef {
  const labels: FighterDef['labels'] = {
    站立: { index: 0, duration: 9 },
    砍1: { index: 54, duration: 17 },
  };
  const areas: FighterDef['areas'] = {};
  for (let fr = 1; fr <= 80; fr++) {
    const list = [{ name: 'bdmn', x: -10, y: -40, w: 20, h: 40 }];
    if (fr === 55) list.push({ name: 'testmc', x: 0, y: -40, w: 20, h: 40 });
    areas[fr] = list;
  }
  const triggers = [
    { frame: 2, target: 'attacker' as const, op: 'move', args: [6, 0] },
    { frame: 3, target: 'attacker' as const, op: 'setHitTarget', args: ['tatm', 'hit'] },
  ];
  return {
    id: 'test',
    formIndex: 0,
    speed: 6,
    jumpPower: 15,
    heavy: 3,
    actions: {
      t: { power: 40, hitType: 1, hitx: 2, hity: 0, hurtTime: 300, hurtType: 0, isBreakDef: false, isApplyG: true },
    },
    labels,
    areas,
    totalFrames: 80,
    triggers: [{ frame: 55, target: 'mc', op: 'addAttacker', args: ['testmc'] }],
    attackLabels: { k1: '砍1' },
    fires: {
      testmc: {
        totalFrames: 20,
        labels: { hit: 9 },
        org: { x: 0, y: 0 },
        hits: {
          '3': [{ name: 'tatm', x: 5, y: -20, w: 30, h: 30 }],
          '10': [{ name: 'tatm', x: 5, y: -20, w: 60, h: 40 }],
        },
        triggers: [...triggers],
      },
    },
    attackerScripts: {
      testmc: { labels: { hit: 9 }, triggers: [...triggers] },
    },
  };
}

function makeConfig(def: FighterDef, p2x: number): SimConfig {
  return {
    seed: 1,
    stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
    fighters: [
      { id: 1, x: 300, def },
      { id: 2, x: p2x, def },
    ],
  };
}

describe('角色侧 attacker 元件脚本（$attacker_ctrler）', () => {
  it('move 驱动道具飞行，接触目标 → setHitTarget 续接跳转 hit 段 + 伤害结算', () => {
    const def = makeDef();
    const sim = new Sim(makeConfig(def, 380));
    sim.tick({ p1: Btn.attack, p2: 0 }); // 砍1 起手（frame 55 生成道具）
    let spawnX: number | null = null;
    let movedX = 0;
    let hitLabel = false;
    let damage = 0;
    for (let i = 0; i < 120; i++) {
      const snap = sim.tick({ p1: 0, p2: 0 });
      const a = snap.state.attackers[0];
      if (a) {
        if (spawnX === null) spawnX = a.x;
        movedX = a.x;
        if (a.animFrame >= 9 && a.animFrame <= 12) hitLabel = true;
      }
      damage = Math.max(damage, 1000 - snap.state.fighters[1]!.hp);
    }
    expect(spawnX).not.toBeNull();
    // 飞行：move(6) → 3/tick，生成后持续前移
    expect(movedX).toBeGreaterThan((spawnX ?? 300) + 20);
    // 续接跳转到达 hit 段且命中区结算伤害
    expect(hitLabel).toBe(true);
    expect(damage).toBe(40);
  });

  it('目标超程无接触 → 不续接不伤害，removeSelf/播尽移除后正常收招', () => {
    const def = makeDef();
    const sim = new Sim(makeConfig(def, 700));
    sim.tick({ p1: Btn.attack, p2: 0 });
    let maxDmg = 0;
    let despawnTick = -1;
    for (let i = 0; i < 200; i++) {
      const snap = sim.tick({ p1: 0, p2: 0 });
      maxDmg = Math.max(maxDmg, 1000 - snap.state.fighters[1]!.hp);
      if (despawnTick < 0 && i > 0 && snap.state.attackers.length === 0) {
        despawnTick = snap.tick;
      }
    }
    expect(maxDmg).toBe(0);
    // 无接触：既不在续接跳转、也不被命中——20 帧时间轴按 animTotal-1 播尽
    // 约定移除（fixture 无 removeSelf@38，约 spawn+33 tick）
    expect(despawnTick).toBeGreaterThan(30);
    expect(despawnTick).toBeLessThan(45);
    const f = sim.tick({ p1: 0, p2: 0 }).state.fighters[0]!;
    expect(f.actLabel).toBe('站立');
    expect(f.actionState).toBe(ActionState.NORMAL);
  });
});
