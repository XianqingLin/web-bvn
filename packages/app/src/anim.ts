/**
 * 极简补间（TweenLite 近似：显示对象数字属性路径 + Back.easeOut）。
 * 从 menu.ts 提取共享（切片 29 菜单流打磨：选人页格子动画复用）。
 * 全局 tween 表：场景串行切换（SceneHost），exit 时 clearTweens 防泄漏。
 */

import type { Container } from 'pixi.js';

/** 属性路径（'x' / 'scale.x' / 'alpha' …）读写（pixi 的 scale/position 是 ObservablePoint）。 */
function getProp(o: Container, path: string): number {
  let cur: unknown = o;
  for (const seg of path.split('.')) cur = (cur as Record<string, unknown>)[seg];
  return cur as number;
}
function setProp(o: Container, path: string, v: number): void {
  const segs = path.split('.');
  let cur: unknown = o;
  for (const seg of segs.slice(0, -1)) cur = (cur as Record<string, unknown>)[seg];
  (cur as Record<string, number>)[segs[segs.length - 1]!] = v;
}

interface Tween {
  obj: Container;
  paths: string[];
  from: number[];
  to: number[];
  t: number;
  dur: number;
  ease: (k: number) => number;
  delay: number;
  done: (() => void) | undefined;
}
const tweens: Tween[] = [];

/** 原版 Back.easeOut（TweenLite 同参）。 */
export const backOut = (k: number) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * (k - 1) ** 3 + c1 * (k - 1) ** 2;
};

export function tweenOf(
  obj: Container,
  to: Record<string, number>,
  durMs: number,
  opts: { ease?: (k: number) => number; delayMs?: number; done?: () => void } = {},
): void {
  const paths = Object.keys(to);
  // overwrite 语义（TweenLite 同名属性覆盖）：同对象同属性的旧补间作废。否则
  // menu 主菜单连发两次 layout(true)（关旧组 + 开新组）会对同一按钮连发两个
  // 位移补间，tickTweens 逆序遍历下旧补间每帧最后写入反而获胜——把后开的
  // 父项钉在关态位上、盖住新子项（联机对战 → 本地双人把 NET PLAY 压在 1v1 槽位）。
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    if (tw && tw.obj === obj && tw.paths.some((p) => paths.includes(p))) tweens.splice(i, 1);
  }
  tweens.push({
    obj,
    paths,
    from: paths.map((p) => getProp(obj, p)),
    to: paths.map((p) => to[p]!),
    t: 0,
    dur: durMs,
    ease: opts.ease ?? backOut,
    delay: opts.delayMs ?? 0,
    done: opts.done,
  });
}

export function tickTweens(dtMs: number): void {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    if (!tw) continue;
    if (tw.obj.destroyed) {
      // 显示对象已销毁（如阶段切换 destroy 先于末帧补间）：丢弃，防 setProp 打在
      // null _position 上（pixi destroy 后 transform 置空，`.x` setter 即崩）
      tweens.splice(i, 1);
      continue;
    }
    if (tw.delay > 0) {
      tw.delay -= dtMs;
      continue;
    }
    tw.t = Math.min(tw.dur, tw.t + dtMs);
    const k = tw.dur > 0 ? tw.ease(tw.t / tw.dur) : 1;
    for (let p = 0; p < tw.paths.length; p++) {
      const path = tw.paths[p];
      if (path) setProp(tw.obj, path, (tw.from[p] ?? 0) + ((tw.to[p] ?? 0) - (tw.from[p] ?? 0)) * k);
    }
    if (tw.t >= tw.dur) {
      tweens.splice(i, 1);
      tw.done?.();
    }
  }
}

/** 场景 exit 时清空全局 tween 表（防泄漏 + 防回调落到已销毁对象）。 */
export function clearTweens(): void {
  tweens.length = 0;
}
