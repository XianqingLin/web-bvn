import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { compileFighterRuntime } from '../src/fighter.js';
import { loadFighterPackage, loadRuntimeFighterPackage } from '../src/load.node.js';

const BAKED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../baked');

describe('compileFighterRuntime（RuntimeFighterPackage → core 角色定义）', () => {
  const runtime = loadRuntimeFighterPackage(BAKED_DIR, 'ichigo', 'fighters-runtime');
  const xfl = loadFighterPackage(BAKED_DIR, 'ichigo');
  const def = compileFighterRuntime(runtime, xfl);

  it('形态选择：跳过无动画数据的空形态', () => {
    // ichigo forms[0] totalFrames=0（dump 空帧形态），应取 forms[1]
    expect(def.formIndex).toBe(1);
    expect(def.totalFrames).toBeGreaterThan(0);
  });

  it('形态数值来自 XFL 形态脚本（speed/jumpPower/heavy）', () => {
    expect(def.speed).toBe(6);
    expect(def.jumpPower).toBe(15);
    expect(def.heavy).toBe(3);
  });

  it('攻击标签映射按 checkFrame 语义只收存在的标签', () => {
    expect(def.attackLabels['k1']).toBe('砍1');
    expect(def.attackLabels['k2']).toBe('砍2');
    expect(def.attackLabels['kj1']).toBe('跳砍');
    // 必杀族 POC 不映射
    expect(def.attackLabels['bs']).toBeUndefined();
  });

  it('判定区按帧收录，攻击判定名 = <actionId>atm', () => {
    const k1 = def.labels['砍1']!;
    const frames = Object.keys(def.areas)
      .map(Number)
      .filter((f) => f > k1.index && f <= k1.index + k1.duration);
    const atmFrames = frames.filter((f) =>
      def.areas[f]!.some((a) => a.name === 'k1atm'),
    );
    expect(atmFrames.length).toBeGreaterThan(0);
    // 受击体在站立帧存在
    expect(def.areas[1]!.some((a) => a.name === 'bdmn')).toBe(true);
  });

  it('帧触发取自 XFL 符号时间轴，帧号 0 起 → 1 起', () => {
    expect(def.triggers.length).toBeGreaterThan(0);
    // XFL mc_0059 f25 loop("走")（0 起）→ 触发帧 26（1 起）
    const loop = def.triggers.find((t) => t.op === 'loop');
    expect(loop).toBeDefined();
    expect(loop!.frame).toBeGreaterThan(0);
  });

  it('动作表为形态动作（XFL 形态表覆盖 runtime 全局表）', () => {
    expect(Object.keys(def.actions).length).toBeGreaterThan(0);
    expect(def.actions['k1']).toBeDefined();
  });
});
