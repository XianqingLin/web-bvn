import { describe, expect, it } from 'vitest';
import {
  advancePlayerInput,
  Btn,
  createDefaultConfig,
  createPlayerInput,
  INPUT_BUFFER_FRAMES,
  rngFloat,
  rngNext,
  Sim,
  type InputFrame,
} from '../src/index.js';

/**
 * 测试剧本生成器：本地 LCG（与 core RNG 无关），生成确定的伪随机输入序列。
 * 同 (ticks, scriptSeed) 必得同序列。
 */
function makeScript(ticks: number, scriptSeed: number): InputFrame[] {
  let s = scriptSeed >>> 0;
  const next = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
  const frames: InputFrame[] = [];
  for (let i = 0; i < ticks; i++) {
    frames.push({ p1: next() & 0x7ff, p2: next() & 0x7ff });
  }
  return frames;
}

function runHashes(frames: InputFrame[], seed: number): string[] {
  const sim = new Sim(createDefaultConfig(seed));
  return frames.map((f) => sim.tick(f).hash);
}

describe('确定性（契约硬规则 1 / 完工门禁）', () => {
  it('同一输入序列跑两遍，逐帧哈希相等', () => {
    const frames = makeScript(600, 42);
    expect(runHashes(frames, 1)).toEqual(runHashes(frames, 1));
  });

  it('输入确实影响模拟（骨架冒烟：走路改变状态哈希）', () => {
    const frames = makeScript(120, 42);
    const idle: InputFrame[] = Array.from({ length: 120 }, () => ({ p1: 0, p2: 0 }));
    expect(runHashes(frames, 1)).not.toEqual(runHashes(idle, 1));
  });

  it('SimState 序列化/恢复后继续推进，哈希与不中断运行一致（rollback 预留接口）', () => {
    const frames = makeScript(300, 7);
    const cut = 100;

    const simA = new Sim(createDefaultConfig(1));
    for (let i = 0; i < cut; i++) simA.tick(frames[i]!);
    const saved = simA.serializeState();
    const tailA = frames.slice(cut).map((f) => simA.tick(f).hash);

    const simB = Sim.fromState(Sim.deserializeState(saved));
    const tailB = frames.slice(cut).map((f) => simB.tick(f).hash);

    expect(tailB).toEqual(tailA);
  });

  it('牵引边界：两角色中点 ± PLAYFIELD_HALF_WIDTH 之外不可达（ADR-4）', () => {
    const sim = new Sim(createDefaultConfig(1));
    // P1 一直向右走 600 tick，无边界时 x = 300 + 4*600 = 2700，远超一屏
    let last = sim.tick({ p1: Btn.right, p2: 0 });
    for (let i = 1; i < 600; i++) last = sim.tick({ p1: Btn.right, p2: 0 });
    const [p1, p2] = last.state.fighters;
    // P2 原地不动（x=700），版边右缘 = 700 + 500 = 1200，clamp 到地图右界 1000
    expect(p1!.x).toBeLessThanOrEqual(1000);
    expect(p2!.x).toBe(700);
  });
});

describe('输入缓冲（ADR-3）', () => {
  it('按下边沿后窗口内 buffered 有效，justDown 仅首帧', () => {
    const pi = createPlayerInput();
    const press = advancePlayerInput(pi, Btn.attack);
    expect(press.justDown(Btn.attack)).toBe(true);
    expect(press.buffered(Btn.attack)).toBe(true);
    // 松开按键后，缓冲在窗口内仍有效
    for (let i = 0; i < INPUT_BUFFER_FRAMES - 1; i++) {
      const v = advancePlayerInput(pi, 0);
      expect(v.buffered(Btn.attack)).toBe(true);
      expect(v.justDown(Btn.attack)).toBe(false);
    }
    // 窗口耗尽
    const expired = advancePlayerInput(pi, 0);
    expect(expired.buffered(Btn.attack)).toBe(false);
  });

  it('consume 后同一按下边沿不能再次触发', () => {
    const pi = createPlayerInput();
    const press = advancePlayerInput(pi, Btn.jump);
    press.consume(Btn.jump);
    expect(press.buffered(Btn.jump)).toBe(false);
    // 下一 tick 仍然无效（未被重新置位）
    const next = advancePlayerInput(pi, Btn.jump);
    expect(next.buffered(Btn.jump)).toBe(false);
    expect(next.justDown(Btn.jump)).toBe(false);
  });
});

describe('RNG（契约硬规则 1：注入种子）', () => {
  const seq = (seed: number): number[] => {
    const out: number[] = [];
    let s = seed >>> 0;
    for (let i = 0; i < 16; i++) {
      s = rngNext(s);
      out.push(rngFloat(s));
    }
    return out;
  };

  it('同种子同序列，异种子异序列', () => {
    expect(seq(123)).toEqual(seq(123));
    expect(seq(123)).not.toEqual(seq(124));
  });
});
