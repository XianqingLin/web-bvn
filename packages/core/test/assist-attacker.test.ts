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
 * 切片 13-A6 机制测试：辅助 addAttacker（独立道具，viaAssist）+
 * setHitTarget 命中续接（原版 renderCheckTargetHit 语义）+
 * 跳转落点首帧触发器（gotoAndPlay 后播放头停在落点帧，不吞帧）。
 *
 * 布局镜像 byakuya 辅助抓取时间轴：f50 setHitTarget('chkm','CHK')、
 * f51 gotoAndPlay('CHK_False')（默认未中分支）、CHK 标签（f52）首帧
 * addAttacker('atmmc')——命中续接跳 CHK 后 addAttacker 必须在落点首帧
 * 执行（修复前跳转后仍 +1 推进，落点被吞进 CHK_False 段）。
 */

function makeFighterDef(): FighterDef {
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
  for (let fr = 1; fr <= 200; fr++) {
    areas[fr] = [{ name: 'bdmn', x: -10, y: -40, w: 20, h: 40 }];
  }
  return {
    id: 'test-f',
    formIndex: 0,
    speed: 6,
    jumpPower: 15,
    heavy: 3,
    actions: {},
    labels,
    areas,
    totalFrames: 200,
    triggers: [],
    attackLabels: {},
  };
}

/** byakuya 抓取段镜像（简化）：chkm 一帧窗口 50、默认跳转 51、CHK 首帧挂 atmmc。 */
function makeAssistDef(areaW: number): AssisterDef {
  return {
    id: 't-assist',
    // 原版 getHitVOByDisplayName('atmmc') 亦 null（FighterHitModel.as:45：
    // 'atmmc'→'mc' 查表 miss）——伤害实际来自内层逐帧 hitVO（重型层，未导出）
    actions: {},
    labels: {
      CHK: { index: 51, duration: 1 },
      CHK_False: { index: 52, duration: 18 },
    },
    areas: { 50: [{ name: 'chkm', x: 0, y: -530, w: areaW, h: 1000 }] },
    totalFrames: 80,
    triggers: [
      { frame: 50, target: 'assister', op: 'setHitTarget', args: ['chkm', 'CHK'] },
      { frame: 51, target: 'assister', op: 'gotoAndPlay', args: ['CHK_False'] },
      {
        frame: 52,
        target: 'assister',
        op: 'addAttacker',
        args: [
          'atmmc',
          { x: { followTarget: true, offset: 0 }, y: { followTarget: true, offset: -30 }, applyG: false },
        ],
      },
    ],
    loopTriggers: [],
    fires: { atmmc: { totalFrames: 15, labels: {} } },
  };
}

function makeConfig(areaW: number): SimConfig {
  const def = makeFighterDef();
  return {
    seed: 1,
    stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
    fighters: [
      { id: 1, x: 300, def, assistId: 't-assist' },
      { id: 2, x: 700, def },
    ],
    assistants: { 't-assist': makeAssistDef(areaW) },
  };
}

/** 召唤辅助并跑到指定 tick，逐 tick 记录快照。 */
function runAssist(config: SimConfig, ticks: number): SimState[] {
  const sim = new Sim(config);
  const snaps: SimState[] = [];
  for (let t = 0; t < ticks; t++) {
    snaps.push(sim.tick({ p1: t < 2 ? Btn.assist : 0, p2: 0 }).state);
  }
  return snaps;
}

describe('切片 13-A6：辅助 addAttacker + 命中续接', () => {
  it('命中路径：CHK 续接跳转落点首帧 addAttacker → viaAssist 道具跟随目标', () => {
    const snaps = runAssist(makeConfig(1000), 120);
    // 命中续接：setHitTarget 注册后 chkm 与目标身体相交 → 跳 CHK（未吞帧：
    // CHK 标签帧 52 可观测，未滑进 CHK_False 段；CHK 仅 1 帧，瞬时可见）
    const chkSnap = snaps.find((s) => s.assisters[0]?.actLabel === 'CHK');
    expect(chkSnap).toBeDefined();
    expect(chkSnap!.assisters[0]!.animFrame).toBe(52);
    const atkSnap = snaps.find((s) => s.attackers.some((a) => a.viaAssist))!;
    expect(atkSnap).toBeDefined();
    const atk = atkSnap.attackers.find((a) => a.viaAssist)!;
    expect(atk.name).toBe('atmmc');
    expect(atk.ownerId).toBe(1); // 回气归属召唤者（原版 getOwnerFighter 回溯）
    expect(atk.animTotal).toBe(15); // 辅助 fire 元件时间轴元数据
    expect(atk.hit).toBeNull(); // 原版 hitModel 查 'atmmc' 亦 null（纯表现占位）
    // followTarget：生成后 x 吸附目标、y = 目标 y - 30（params 轴偏移；
    // 生成 tick 先落在辅助锚点，随后每 tick 追踪目标）
    const later = snaps[snaps.indexOf(atkSnap) + 6]!;
    const atk2 = later.attackers.find((a) => a.viaAssist)!;
    const p2 = later.fighters[1]!;
    expect(atk2.x).toBe(p2.x);
    expect(atk2.y).toBe(p2.y - 30);
  });

  it('命中路径后续：道具播尽移除（animTotal=15），辅助时间轴播尽退场', () => {
    const snaps = runAssist(makeConfig(1000), 220);
    const last = snaps.at(-1)!;
    expect(last.attackers).toHaveLength(0); // 15 帧播尽移除（30Hz ≈ 30 tick）
    expect(last.assisters).toHaveLength(0); // totalFrames=80 播尽 finish
    // 生成过（守卫：不是一开始就没召唤）
    expect(snaps.some((s) => s.attackers.some((a) => a.viaAssist))).toBe(true);
  });

  it('未中路径：chkm 不相交 → 默认 CHK_False 分支，无道具生成', () => {
    const snaps = runAssist(makeConfig(10), 120);
    const assister = snaps.map((s) => s.assisters[0]).findLast(Boolean)!;
    expect(assister.actLabel).toBe('CHK_False');
    expect(snaps.every((s) => s.attackers.every((a) => !a.viaAssist))).toBe(true);
  });
});
