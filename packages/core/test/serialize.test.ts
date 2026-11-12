import { describe, expect, it } from 'vitest';
import { behaviorHash, behaviorStringify, behaviorView, fnv1a, stableStringify } from '../src/serialize.js';
import { createInitialState, type SimState } from '../src/state.js';

describe('stableStringify', () => {
  it('对象键显式排序（不依赖插入顺序）', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('嵌套对象同样排序', () => {
    expect(stableStringify({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });
});

describe('behaviorStringify（空容器/null 省略）', () => {
  it('null 字段省略', () => {
    expect(behaviorStringify({ a: null, b: 1 })).toBe('{"b":1}');
  });

  it('空对象/空数组省略，非空保留', () => {
    expect(behaviorStringify({ e: {}, a: [], v: 0, f: false, s: '' })).toBe('{"f":false,"s":"","v":0}');
    expect(behaviorStringify({ m: { k: 1 } })).toBe('{"m":{"k":1}}');
    expect(behaviorStringify({ arr: [1, 2] })).toBe('{"arr":[1,2]}');
  });

  it('嵌套清空后整体省略（{a:{b:null}} → {} → 省略）', () => {
    expect(behaviorStringify({ outer: { a: { b: null } }, keep: 1 })).toBe('{"keep":1}');
  });

  it('数组内空容器以 null 占位保序位', () => {
    expect(behaviorStringify({ arr: [{}, 1] })).toBe('{"arr":[null,1]}');
  });

  it('0/false/空串 不省略（默认值参与哈希）', () => {
    expect(behaviorStringify({ z: 0 })).toBe('{"z":0}');
  });

  it('值从空变非空 → 哈希变化（不漏报行为变更）', () => {
    const h1 = fnv1a(behaviorStringify({ m: {} }));
    const h2 = fnv1a(behaviorStringify({ m: { k: 1 } }));
    expect(h1).not.toBe(h2);
  });
});

describe('behaviorView / behaviorHash', () => {
  function makeState(): SimState {
    const state = createInitialState({
      seed: 1,
      stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
      fighters: [{ id: 1, x: 300 }, { id: 2, x: 700 }],
    });
    state.fighters[0]!.qi = 30;
    return state;
  }

  it('剥除 fighters[].input 与实体 name，其余字段保留', () => {
    const state = makeState();
    state.bullets.push({
      id: 9, ownerId: 1, facing: 1, name: 'zh1atm', x: 0, y: 0, w: 10, h: 10,
      sx: 0, sy: 0, addX: 0, addY: 0, minX: 0, maxX: 0, minY: 0, maxY: 0,
      holdTicks: 60, hitTimes: 1, hp: 100, hpMax: 100,
      hit: { actionId: 'a1', power: 10 }, hitAble: true, viaAssist: false,
      animTotal: 0, animFrame: 0, animLabels: {}, hitAnim: false,
    } as never);
    const view = behaviorView(state) as SimState;
    expect('input' in view.fighters[0]!).toBe(false);
    expect('name' in view.bullets[0]!).toBe(false);
    expect(view.bullets[0]!.holdTicks).toBe(60);
    expect(view.fighters[0]!.qi).toBe(30);
  });

  it('行为值变化 → behaviorHash 变化', () => {
    const a = makeState();
    const b = makeState();
    b.fighters[0]!.hp = 990;
    expect(behaviorHash(a)).not.toBe(behaviorHash(b));
  });

  it('恒空/恒 null 字段加入 → behaviorHash 不变（表示漂移免疫）', () => {
    const a = makeState();
    const b = makeState();
    (b.fighters[0] as Record<string, unknown>).newEmptyBookkeeping = {};
    (b.fighters[0] as Record<string, unknown>).newNullField = null;
    expect(behaviorHash(a)).toBe(behaviorHash(b));
  });

  it('表示字段（input 缓冲内容）变化 → behaviorHash 不变', () => {
    const a = makeState();
    const b = makeState();
    b.fighters[0]!.input.buffer = b.fighters[0]!.input.buffer.map(() => 9);
    expect(behaviorHash(b)).toBe(behaviorHash(a));
  });
});
