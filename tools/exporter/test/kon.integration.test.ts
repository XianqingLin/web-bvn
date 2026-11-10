/**
 * 集成冒烟：对真实 kon（魂）辅助 XFL 跑一遍提取。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractAssistant } from '../src/assistant.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const KON_XFL = join(REPO_ROOT, 'OpenBleachVsNaruto', 'swf_source', 'f_assistant', 'kon');

describe.skipIf(!existsSync(KON_XFL))('kon XFL 提取（集成）', () => {
  const { pkg, validation } = extractAssistant({ xflDir: KON_XFL, id: 'kon' });

  it('校验无 error', () => {
    expect(validation.errors).toEqual([]);
  });

  it('defineAction 表（atm1，与原版一致）', () => {
    expect(pkg.actions['atm1']).toMatchObject({
      power: 10,
      hitType: 2,
      hurtTime: 500,
      isBreakDef: false,
    });
  });

  it('assister 目标触发提取（endAct 等）', () => {
    const all = [
      ...pkg.timeline.triggers,
      ...Object.values(pkg.symbols).flatMap((s) => s.triggers),
    ];
    expect(all.some((t) => t.target === 'assister' && t.op === 'endAct')).toBe(true);
  });

  it('buff 链与目标扣气数据化（切片 12：attackUp → fighter:buffAttackUp；qi-=30 → fighterTarget:addQi）', () => {
    const all = [
      ...pkg.timeline.triggers,
      ...Object.values(pkg.symbols).flatMap((s) => s.triggers),
    ];
    expect(
      all.some(
        (t) => t.target === 'fighter' && t.op === 'buffAttackUp' && t.args[0] === 0.3,
      ),
    ).toBe(true);
    expect(
      all.some(
        (t) => t.target === 'fighterTarget' && t.op === 'addQi' && t.args[0] === -30,
      ),
    ).toBe(true);
  });
});
