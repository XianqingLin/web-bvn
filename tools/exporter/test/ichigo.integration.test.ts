/**
 * 集成冒烟：对真实 ichigo XFL 跑一遍提取。
 * 原版参考仓库不在时会跳过（CI 无参考仓库也能跑单测）。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractFighter } from '../src/fighter.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const ICHIGO_XFL = join(
  REPO_ROOT,
  'OpenBleachVsNaruto',
  'swf_source',
  'f_fighter',
  'ichigo',
);
const FIGHTER_XML = join(
  REPO_ROOT,
  'OpenBleachVsNaruto',
  'swf_output',
  'assets',
  'config',
  'fighter.xml',
);

describe.skipIf(!existsSync(ICHIGO_XFL))('ichigo XFL 提取（集成）', () => {
  const { pkg, validation } = extractFighter({
    xflDir: ICHIGO_XFL,
    id: 'ichigo',
    ...(existsSync(FIGHTER_XML) ? { fighterXmlPath: FIGHTER_XML } : {}),
  });

  it('校验无 error', () => {
    expect(validation.errors).toEqual([]);
  });

  it('五形态（普通/卍解/半虚/虚化/零段）与 fighterId 回填', () => {
    expect(pkg.forms.length).toBeGreaterThanOrEqual(5);
    const ids = pkg.forms.map((f) => f.fighterId);
    expect(ids).toContain('ichigo');
    expect(ids).toContain('ichigo_bankai');
  });

  it('defineAction 表：k1/cbs 数值与原版一致（module-map §6.2 抽样）', () => {
    const normal = pkg.forms.find((f) => f.fighterId === 'ichigo')!;
    expect(normal.actions['k1']).toMatchObject({ power: 40, hitType: 1, hitx: 3 });
    expect(normal.actions['cbs']).toMatchObject({ power: 450, hitx: 40, isBreakDef: false });
    expect(normal.stats).toMatchObject({ speed: 6, jumpPower: 15, heavy: 3 });
  });

  it('主符号绑定且含帧标签（站立/走/砍1）', () => {
    const normal = pkg.forms.find((f) => f.fighterId === 'ichigo')!;
    expect(normal.symbol).not.toBeNull();
    const sym = pkg.symbols[normal.symbol!]!;
    expect(sym).toBeDefined();
    expect(Object.keys(sym.labels)).toEqual(expect.arrayContaining(['站立', '走']));
  });

  it('帧触发无损提取（含 mc/effect/fighter 三类目标）', () => {
    const all = Object.values(pkg.symbols).flatMap((s) => s.triggers);
    expect(all.length).toBeGreaterThan(100);
    expect(new Set(all.map((t) => t.target))).toEqual(new Set(['mc', 'fighter', 'effect']));
    expect(all.some((t) => t.op === 'fire')).toBe(true);
  });
});
