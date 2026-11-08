import { describe, expect, it } from 'vitest';
import {
  extractCtrlerCalls,
  extractDefineActions,
  extractNamedDefine,
  extractStatAssignments,
  matchBracket,
  parseArg,
  parseObjectLiteral,
  splitTopLevel,
} from '../src/asargs.js';

describe('AS 参数解析器', () => {
  it('字面量：数字/字符串/布尔/null', () => {
    expect(parseArg('30')).toBe(30);
    expect(parseArg('-10.5')).toBe(-10.5);
    expect(parseArg('"走"')).toBe('走');
    expect(parseArg('true')).toBe(true);
    expect(parseArg('null')).toBe(null);
  });

  it('标识符编码为 $ref，表达式保留为 $expr', () => {
    expect(parseArg('bsface1')).toEqual({ $ref: 'bsface1' });
    expect(parseArg('snd_die')).toEqual({ $ref: 'snd_die' });
    expect(parseArg('a+b*2')).toEqual({ $expr: 'a+b*2' });
  });

  it('对象字面量：裸键 + 数字/布尔值', () => {
    expect(parseObjectLiteral('{power:30,hitType:1,isBreakDef:false}')).toEqual({
      power: 30,
      hitType: 1,
      isBreakDef: false,
    });
  });

  it('splitTopLevel 忽略字符串与括号内的逗号', () => {
    expect(splitTopLevel('a,"b,c",{x:1,y:2}', ',')).toEqual(['a', '"b,c"', '{x:1,y:2}']);
  });

  it('matchBracket 尊重字符串', () => {
    const s = 'foo("(", 1)';
    expect(matchBracket(s, 3)).toBe(s.length - 1);
  });
});

describe('调用提取', () => {
  it('defineAction 表', () => {
    const script = 'defineAction("k1",{power:40,hitType:1,hitx:3,hity:0,hurtTime:300,hurtType:0,isBreakDef:false});';
    const out = extractDefineActions(script);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('k1');
    expect(out[0]!.data['power']).toBe(40);
    expect(out[0]!.data['isBreakDef']).toBe(false);
  });

  it('ctrler 调用：parent. 前缀与三类目标', () => {
    const script = `
parent.$mc_ctrler.loop("走");
$mc_ctrler.setSteelBody(true);
$fighter_ctrler.moveToTarget();
$effect_ctrler.shine("s1",{x:1});
`;
    const out = extractCtrlerCalls(script);
    expect(out.map((c) => [c.target, c.op])).toEqual([
      ['mc', 'loop'],
      ['mc', 'setSteelBody'],
      ['fighter', 'moveToTarget'],
      ['effect', 'shine'],
    ]);
    expect(out[0]!.args).toEqual(['走']);
    expect(out[3]!.args[1]).toEqual({ x: 1 });
  });

  it('数值赋值与声音绑定', () => {
    const script = `
$fighter_ctrler.speed = 6;
$fighter_ctrler.jumpPower = 15;
$fighter_ctrler.heavy = 3;
$fighter_ctrler.defineBishaFace("Ichigo_1",bsface1);
$fighter_ctrler.defineHurtSound(snd_hurt1,snd_hurt2);
$fighter_ctrler.defineDieSound(snd_die);
`;
    expect(extractStatAssignments(script)).toEqual({ speed: 6, jumpPower: 15, heavy: 3 });
    const defs = extractNamedDefine(script);
    expect(defs.map((d) => d.op)).toEqual([
      'defineBishaFace',
      'defineHurtSound',
      'defineDieSound',
    ]);
    expect(defs[0]!.args).toEqual(['Ichigo_1', { $ref: 'bsface1' }]);
    expect(defs[1]!.args).toEqual([{ $ref: 'snd_hurt1' }, { $ref: 'snd_hurt2' }]);
  });
});
