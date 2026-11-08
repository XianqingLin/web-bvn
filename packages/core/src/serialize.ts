/**
 * 确定性序列化与状态哈希（DESIGN §3.8）。
 * 快照哈希是渲染基准、对拍基准、联机失步检测载体，必须跨端一致：
 * 对象键显式排序（不依赖属性插入顺序），数值走 IEEE754 双精度
 * 的规范字符串表示（ECMAScript Number::toString，跨引擎确定）。
 */

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
