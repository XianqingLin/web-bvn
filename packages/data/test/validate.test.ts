import { describe, expect, it } from 'vitest';
import { validateFighterPackage, type FighterPackage } from '../src/index.js';

function minimalValid(): FighterPackage {
  return {
    schema: 'bvn/fighter@1',
    id: 'test',
    source: { kind: 'xfl', path: 'f_fighter/test', hash: 'abc123' },
    forms: [
      {
        frame: 1,
        fighterId: 'test',
        symbol: '元件/mc_0001',
        stats: { speed: 6, jumpPower: 15, heavy: 3 },
        actions: {
          k1: {
            power: 40,
            hitType: 1,
            hitx: 3,
            hity: 0,
            hurtTime: 300,
            hurtType: 0,
            isBreakDef: false,
          },
        },
        sounds: {},
      },
    ],
    symbols: {
      '元件/mc_0001': {
        labels: { 站立: { index: 0, duration: 9 }, 走: { index: 9, duration: 24 } },
        triggers: [
          { frame: 32, target: 'mc', op: 'loop', args: ['走'] },
          { frame: 5, target: 'effect', op: 'playSoundHit', args: [{ $ref: 'snd_hit' }] },
        ],
      },
    },
  };
}

describe('数据校验器（DESIGN §7 验收闸门）', () => {
  it('合法包通过，无 error', () => {
    const r = validateFighterPackage(minimalValid());
    expect(r.errors).toEqual([]);
  });

  it('action 缺字段 / 类型错误被抓出', () => {
    const pkg = minimalValid();
    // @ts-expect-error 故意破坏
    delete pkg.forms[0].actions.k1.power;
    // @ts-expect-error 故意破坏
    pkg.forms[0].actions.k1.isBreakDef = 'yes';
    const r = validateFighterPackage(pkg);
    expect(r.errors.some((e) => e.includes('缺字段 power'))).toBe(true);
    expect(r.errors.some((e) => e.includes('isBreakDef'))).toBe(true);
  });

  it('form 主符号必须在 symbols 表中（引用完整性）', () => {
    const pkg = minimalValid();
    pkg.forms[0]!.symbol = '元件/mc_9999';
    const r = validateFighterPackage(pkg);
    expect(r.errors.some((e) => e.includes('不在 symbols 表中'))).toBe(true);
  });

  it('trigger 的 loop 标签引用缺失记 warning 而非 error', () => {
    const pkg = minimalValid();
    pkg.symbols['元件/mc_0001']!.triggers.push({
      frame: 10,
      target: 'mc',
      op: 'loop',
      args: ['不存在的标签'],
    });
    const r = validateFighterPackage(pkg);
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes('不存在的标签'))).toBe(true);
  });

  it('标识符引用必须编码为 { $ref } 且非空', () => {
    const pkg = minimalValid();
    pkg.symbols['元件/mc_0001']!.triggers.push({
      frame: 1,
      target: 'effect',
      op: 'sound',
      args: [{ $ref: '' }],
    });
    const r = validateFighterPackage(pkg);
    expect(r.errors.some((e) => e.includes('$ref'))).toBe(true);
  });

  it('form frame 重复被抓出', () => {
    const pkg = minimalValid();
    pkg.forms.push({ ...pkg.forms[0]! });
    const r = validateFighterPackage(pkg);
    expect(r.errors.some((e) => e.includes('frame 重复'))).toBe(true);
  });
});
