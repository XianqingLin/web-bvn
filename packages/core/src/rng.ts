/**
 * 注入种子的确定性 RNG（mulberry32）。
 * 契约硬规则 1：core 禁止 Math.random；随机状态是单个 uint32，
 * 存于 SimState.rngState，随快照整体序列化/恢复。
 */

/** 推进状态，返回新状态。 */
export function rngNext(state: number): number {
  return (state + 0x6d2b79f5) >>> 0;
}

/** 由当前状态取 [0, 1) 均匀值（不推进状态；推进用 rngNext）。 */
export function rngFloat(state: number): number {
  let t = state >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** 由当前状态取 [min, max] 闭区间整数（不推进状态）。 */
export function rngInt(state: number, min: number, max: number): number {
  return min + Math.floor(rngFloat(state) * (max - min + 1));
}
