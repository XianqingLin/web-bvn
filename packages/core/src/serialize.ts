/**
 * 确定性序列化与状态哈希（DESIGN §3.8）。
 * 快照哈希是渲染基准、对拍基准、联机失步检测载体，必须跨端一致：
 * 对象键显式排序（不依赖属性插入顺序），数值走 IEEE754 双精度
 * 的规范字符串表示（ECMAScript Number::toString，跨引擎确定）。
 */
import type { SimState } from './state.js';

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const src = v as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) {
        sorted[k] = src[k];
      }
      return sorted;
    }
    return v;
  });
}

/** FNV-1a 32 位，输出 8 位十六进制。位运算跨端确定。 */
export function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function hashState(state: unknown): string {
  return fnv1a(stableStringify(state));
}

/**
 * 行为哈希序列化（tools/replay 门禁专用，DESIGN §3.8）：在 stableStringify 的
 * 键序规范之上再省略 null / 空对象 / 空数组——给 SimState 新增「恒空/恒 null」
 * 的记录字段不再漂移基线；值一旦非空即参与哈希，不漏报行为变更。
 * 数组内的空容器以 null 占位保序位（位置语义优先）。
 */
export function behaviorStringify(value: unknown): string {
  const pruned = pruneEmpty(value);
  // 根值整体为空时 JSON.stringify(undefined) 返回 undefined，锚定为 "null"
  return JSON.stringify(pruned === undefined ? null : pruned);
}

/**
 * 行为视图：replay 门禁哈希的投影 = SimState 剥除「表现/调试专用」字段
 * （denylist 设计：新字段默认进哈希，漏登记只会多漂不漏报）。剥除表：
 * - fighters[].input：输入缓冲历史完全由输入流（剧本）决定，非模拟产物；
 * - bullets[].name / attackers[].name：元件名仅渲染/调试消费（逻辑在生成帧
 *   已解析进 fbHit/hit/animTotal 等字段），同名异值不影响后续行为。
 * 登记纪律：纯表现/输入派生字段入本表须同 commit 更新本注释与 DESIGN §3.8。
 */
export function behaviorView(state: SimState): unknown {
  return {
    ...state,
    fighters: state.fighters.map((f) => {
      const { input: _input, ...rest } = f;
      return rest;
    }),
    bullets: state.bullets.map(({ name: _name, ...rest }) => rest),
    attackers: state.attackers.map(({ name: _name, ...rest }) => rest),
  };
}

/** 行为哈希 = 行为视图 + 空容器省略序列化的 FNV-1a（tools/replay 门禁用）。 */
export function behaviorHash(state: SimState): string {
  return fnv1a(behaviorStringify(behaviorView(state)));
}

function pruneEmpty(v: unknown): unknown {
  if (v === null) return undefined;
  if (Array.isArray(v)) {
    if (v.length === 0) return undefined;
    return v.map((item) => pruneEmpty(item) ?? null);
  }
  if (typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      const pruned = pruneEmpty(src[k]);
      if (pruned !== undefined) out[k] = pruned;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return v;
}
