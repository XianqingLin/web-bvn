/**
 * 集成冒烟：对真实 ichigo XFL 跑一遍提取。
 * 参考仓库不在时跳过（CI 无参考仓库也能跑单测）。
 * 提取须放 beforeAll：vitest 的 describe.skipIf 只跳过 it()，describe 体在收集期
 * 照常执行——体级调用在参考仓库缺失时会让收集崩掉、整文件 FAIL 而非 skip
 * （2026-11-22 实证）。路径优先工作区 references/（2026-11-22 迁出仓库根），
 * 兼容仓内旧位置。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractFighter } from '../src/fighter.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const REF_ROOT = [
  join(REPO_ROOT, '..', 'references', 'OpenBleachVsNaruto'),
  join(REPO_ROOT, 'OpenBleachVsNaruto'),
].find((p) => existsSync(p));
const ICHIGO_XFL = REF_ROOT ? join(REF_ROOT, 'swf_source', 'f_fighter', 'ichigo') : null;
const FIGHTER_XML = REF_ROOT ? join(REF_ROOT, 'swf_output', 'assets', 'config', 'fighter.xml') : null;

describe.skipIf(!ICHIGO_XFL)('ichigo XFL 提取（集成）', () => {
  let pkg: ReturnType<typeof extractFighter>['pkg'];
  let validation: ReturnType<typeof extractFighter>['validation'];

  beforeAll(() => {
    ({ pkg, validation } = extractFighter({
      xflDir: ICHIGO_XFL!,
      id: 'ichigo',
      ...(existsSync(FIGHTER_XML!) ? { fighterXmlPath: FIGHTER_XML } : {}),
    }));
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
