/**
 * 集成冒烟：对真实 kon（魂）辅助 XFL 跑一遍提取。
 * 提取须放 beforeAll：vitest 的 describe.skipIf 只跳过 it()，describe 体在收集期
 * 照常执行——体级调用在参考仓库缺失时会让收集崩掉、整文件 FAIL 而非 skip
 * （2026-11-22 实证）。路径优先工作区 references/（2026-11-22 迁出仓库根），
 * 兼容仓内旧位置。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractAssistant } from '../src/assistant.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const REF_ROOT = [
  join(REPO_ROOT, '..', 'references', 'OpenBleachVsNaruto'),
  join(REPO_ROOT, 'OpenBleachVsNaruto'),
].find((p) => existsSync(p));
const KON_XFL = REF_ROOT ? join(REF_ROOT, 'swf_source', 'f_assistant', 'kon') : null;

describe.skipIf(!KON_XFL)('kon XFL 提取（集成）', () => {
  let pkg: ReturnType<typeof extractAssistant>['pkg'];
  let validation: ReturnType<typeof extractAssistant>['validation'];

  beforeAll(() => {
    ({ pkg, validation } = extractAssistant({ xflDir: KON_XFL!, id: 'kon' }));
  });

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
