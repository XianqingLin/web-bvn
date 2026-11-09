import { describe, expect, it } from 'vitest';
import {
  Btn,
  Sim,
  type FloorSpan,
  type SimConfig,
  type SimState,
  type StageState,
} from '../src/index.js';

/** 合成舞台：主地面 500 + 一块悬空平台（x∈[100,200]，站面 300）。 */
function makeStage(): StageState {
  return {
    leftBound: 50,
    rightBound: 950,
    groundY: 500,
    bottomY: 600,
    floors: [{ xFrom: 100, xTo: 200, y: 300 } as FloorSpan],
  };
}

function makeConfig(p1: { x: number; y?: number }): SimConfig {
  return {
    seed: 1,
    stage: makeStage(),
    fighters: [
      { id: 1, x: p1.x, y: p1.y },
      { id: 2, x: 800 },
    ],
  };
}

describe('多段地板落地（对照原版 GameLogic.isInAir 语义）', () => {
  it('重力坠落吸附平台段', () => {
    // 重力驱动的坠落显式速度恒为 0，必被平台容差捕获（原版 applayG 模型）
    const sim = new Sim(makeConfig({ x: 150, y: 200 }));
    let last = sim.tick({ p1: 0, p2: 0 });
    for (let i = 1; i < 60; i++) last = sim.tick({ p1: 0, p2: 0 });
    expect(last.state.fighters[0]!.y).toBe(300);
    expect(last.state.fighters[0]!.vy).toBe(0);
  });

  it('走出平台边缘后坠落到主地面', () => {
    const sim = new Sim(makeConfig({ x: 150, y: 300 }));
    // 平台右缘 200：以 4px/tick 向右走出需要 ~13 tick，再留坠落时间
    let last = sim.tick({ p1: Btn.right, p2: 0 });
    for (let i = 1; i < 120; i++) last = sim.tick({ p1: Btn.right, p2: 0 });
    expect(last.state.fighters[0]!.x).toBeGreaterThan(200);
    expect(last.state.fighters[0]!.y).toBe(500);
  });

  it('快速下落（显式 vy ≥ 阈值）穿过平台段，落在主地面', () => {
    const sim = new Sim(makeConfig({ x: 150 }));
    // 直接构造下落中的状态：显式 vy=3（≥ 2.5 阈值），位于平台上方
    const st = JSON.parse(sim.serializeState()) as SimState;
    st.fighters[0]!.vy = 3;
    st.fighters[0]!.y = 250;
    st.fighters[0]!.gRamp = 0;
    const falling = Sim.fromState(st);
    let last = falling.tick({ p1: 0, p2: 0 });
    for (let i = 1; i < 120; i++) last = falling.tick({ p1: 0, p2: 0 });
    expect(last.state.fighters[0]!.y).toBe(500);
  });

  it('主地面吸附带：接近地面即被吸附（优先于平台段）', () => {
    const sim = new Sim(makeConfig({ x: 800, y: 495 }));
    const last = sim.tick({ p1: 0, p2: 0 });
    expect(last.state.fighters[0]!.y).toBe(500);
  });

  it('地图版边：左右边界来自地图数据', () => {
    const sim = new Sim(makeConfig({ x: 300 }));
    let last = sim.tick({ p1: Btn.left, p2: 0 });
    for (let i = 1; i < 600; i++) last = sim.tick({ p1: Btn.left, p2: 0 });
    expect(last.state.fighters[0]!.x).toBeGreaterThanOrEqual(50);
  });

  it('带平台段的舞台同样满足确定性门禁（双跑逐帧哈希相等）', () => {
    const run = (): string[] => {
      const sim = new Sim(makeConfig({ x: 150, y: 200 }));
      const hashes: string[] = [];
      for (let i = 0; i < 200; i++) {
        const mask = i % 17 === 0 ? Btn.right : i % 23 === 0 ? Btn.left : 0;
        hashes.push(sim.tick({ p1: mask, p2: mask }).hash);
      }
      return hashes;
    };
    expect(run()).toEqual(run());
  });
});
