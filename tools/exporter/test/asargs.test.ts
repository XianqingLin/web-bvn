import { describe, expect, it } from 'vitest';
import {
  extractCtrlerCalls,
  extractDefineActions,
  extractNamedDefine,
  extractStatAssignments,
  matchBracket,
  matchOwnerSpeedBuff,
  matchWindFieldCustomFunc,
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

describe('B4 惯用语识别', () => {
  it('matchOwnerSpeedBuff：var 捕获 owner speed + speedUp(var*R, H)', () => {
    const script = `
var ownerSpeed:Number = $assisterCtrler.getOwner().speed;
$assisterCtrler.getBuffCtrl().speedUp(ownerSpeed * 0.25, 6);
`;
    expect(matchOwnerSpeedBuff(script)).toEqual({ rate: 0.25, hold: 6 });
  });

  it('matchOwnerSpeedBuff：变量名不绑定', () => {
    const script = `
var sp:Number = $assisterCtrler.getOwner().speed;
$assisterCtrler.getBuffCtrl().speedUp(sp * 1.5, 30);
`;
    expect(matchOwnerSpeedBuff(script)).toEqual({ rate: 1.5, hold: 30 });
  });

  it('matchOwnerSpeedBuff：缺 speedUp 调用 → null', () => {
    const script = 'var ownerSpeed:Number = $assisterCtrler.getOwner().speed;';
    expect(matchOwnerSpeedBuff(script)).toBe(null);
  });

  it('matchOwnerSpeedBuff：speedUp 参数非 var*R 形态 → null', () => {
    const script = `
var ownerSpeed:Number = $assisterCtrler.getOwner().speed;
$assisterCtrler.getBuffCtrl().speedUp(3, 6);
`;
    expect(matchOwnerSpeedBuff(script)).toBe(null);
  });

  const WIND_CORPUS = `
const LEVEL:Array = [0.8, 0.65, 0.5, 0.35, 0.2];
function setBulletSpeedLevel(level:Number, direct:int):void {
  var sprites:Array = getGameSprites();
  for (var i:int = 0; i < sprites.length; i++) {
    var sp = sprites[i] as Bullet;
    if (sp != null && sp.isBullet()) {
      sp.speedLevel = level * direct;
    }
  }
}
function fuutonFunc():void {
  setBulletSpeedLevel(level, selfDirect);
  if (getTargetState() == 23) {
    return;
  }
  var targetSP = getTargetSP();
  targetSP.x += finalSpeed * selfDirect;
}
`;

  it('matchWindFieldCustomFunc：风场函数体特征 → levels', () => {
    expect(matchWindFieldCustomFunc(WIND_CORPUS, 'fuutonFunc')).toEqual({
      kind: 'windField',
      levels: [0.8, 0.65, 0.5, 0.35, 0.2],
    });
  });

  it('matchWindFieldCustomFunc：缺 HURT_DOWN 门 → null', () => {
    const noGate = WIND_CORPUS.replace('== 23', '== 99');
    expect(matchWindFieldCustomFunc(noGate, 'fuutonFunc')).toBe(null);
  });

  it('matchWindFieldCustomFunc：缺 targetSP.x 拉扯 → null', () => {
    const noPull = WIND_CORPUS.replace('targetSP.x +=', 'targetSP.y -=');
    expect(matchWindFieldCustomFunc(noPull, 'fuutonFunc')).toBe(null);
  });

  it('matchWindFieldCustomFunc：函数体未调用弹速级辅助 → null', () => {
    const noCall = WIND_CORPUS.replace('setBulletSpeedLevel(level, selfDirect);', '');
    expect(matchWindFieldCustomFunc(noCall, 'fuutonFunc')).toBe(null);
  });

  it('matchWindFieldCustomFunc：两个弹速级特征函数（歧义）→ null', () => {
    const twoHelpers = WIND_CORPUS.replace(
      'const LEVEL:Array',
      'function setBulletSpeedLevel2(level:Number, direct:int):void {\n  var gs:Array = getGameSprites();\n  for each (var s in gs) { if (s.isBullet()) { s.speedLevel = 0; } }\n}\nconst LEVEL:Array',
    );
    expect(matchWindFieldCustomFunc(twoHelpers, 'fuutonFunc')).toBe(null);
  });

  it('matchWindFieldCustomFunc：无数值数组常量（LEVEL 缺失）→ null', () => {
    const noLevels = WIND_CORPUS.replace('const LEVEL:Array = [0.8, 0.65, 0.5, 0.35, 0.2];', '');
    expect(matchWindFieldCustomFunc(noLevels, 'fuutonFunc')).toBe(null);
  });
});
