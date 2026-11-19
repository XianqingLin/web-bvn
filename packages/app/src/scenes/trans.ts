/**
 * 黑幕转场（切片 41）：复刻原版 TransUI / StateCtrler.transIn-transOut 语义。
 *
 * 原版 common_ui trans_mc（sprite 5，70 帧）实际内容 = 一块纯黑矩形做 alpha 渐变
 * （FFDec 导帧实证，无图形细节）：
 *   fadin  帧 10(α0)→帧 22(α1) ≈ 430ms 合拢，帧 26 停（脚本事件 → 切场景）；
 *   fadout 帧 45(α1)→帧 56(α0) ≈ 370ms 打开，帧 61 停。
 * 因此这里用连续 alpha 补间等价复刻（偏离登记：原版为 30fps 逐帧 alpha，视觉等价）。
 *
 * overlay 挂 pixi.stage（高于 uiRoot 与战斗自建渲染器），跨 switchTo 存活；
 * 模块级单例 + pixi ticker 驱动（不依赖场景 update，异步 enter 期间也走针）。
 */
import { Graphics } from 'pixi.js';
import { UI_H, UI_W } from '../ui.js';
import type { SceneCtx } from './scene.js';

/** fadin 帧 10→22 @30fps */
const FADE_IN_MS = 430;
/** fadout 帧 45→56 @30fps */
const FADE_OUT_MS = 370;

let overlay: Graphics | null = null;
/** 转场令牌：新转场使旧 ticker 回调失效（原版 transUI 单实例语义） */
let runId = 0;

function ensureOverlay(ctx: SceneCtx): Graphics {
  if (!overlay || overlay.destroyed) {
    overlay = new Graphics();
    overlay.rect(0, 0, UI_W, UI_H).fill({ color: 0x000000 });
    ctx.pixi.stage.addChild(overlay);
  }
  return overlay;
}

/** overlay 画在 1000×600 逻辑屏坐标（与 SceneHost.uiRoot 同款等比缩放居中）。 */
function fitTransform(ctx: SceneCtx): void {
  if (!overlay) return;
  const { width, height } = ctx.pixi.renderer.screen;
  const zoom = Math.min(width / UI_W, height / UI_H);
  overlay.scale.set(zoom);
  overlay.position.set((width - UI_W * zoom) / 2, (height - UI_H * zoom) / 2);
}

/** 合拢到全黑后切场景（原版 StateCtrler.transIn(finish)：帧 26 stop 事件回调）。 */
export function transIn(ctx: SceneCtx, next: () => void): void {
  const g = ensureOverlay(ctx);
  fitTransform(ctx);
  const id = ++runId;
  g.visible = true;
  g.alpha = 0;
  const t0 = performance.now();
  const tick = (): void => {
    if (id !== runId) {
      ctx.pixi.ticker.remove(tick);
      return;
    }
    fitTransform(ctx);
    const k = Math.min(1, (performance.now() - t0) / FADE_IN_MS);
    g.alpha = k;
    if (k >= 1) {
      ctx.pixi.ticker.remove(tick);
      next();
    }
  };
  ctx.pixi.ticker.add(tick);
}

/** 打开黑幕（原版 StateCtrler.transOut：帧 61 stop；完成后销毁 overlay）。 */
export function transOut(ctx: SceneCtx): void {
  if (!overlay || overlay.destroyed) return;
  const g = overlay;
  const id = ++runId;
  const a0 = g.alpha;
  const t0 = performance.now();
  const tick = (): void => {
    if (id !== runId) {
      ctx.pixi.ticker.remove(tick);
      return;
    }
    fitTransform(ctx);
    const k = Math.min(1, (performance.now() - t0) / FADE_OUT_MS);
    g.alpha = a0 * (1 - k);
    if (k >= 1) {
      ctx.pixi.ticker.remove(tick);
      g.destroy();
      if (overlay === g) overlay = null;
    }
  };
  ctx.pixi.ticker.add(tick);
}

/** 撤销未完成转场（原版 StageCtrler.clearTrans：不经过 transIn 的场景切回时清残留黑幕）。 */
export function clearTrans(): void {
  runId++;
  if (overlay && !overlay.destroyed) overlay.destroy();
  overlay = null;
}
