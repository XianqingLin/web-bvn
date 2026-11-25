/**
 * 嵌套动画叠加层播放器（切片 45）。
 *
 * 背景：FFDec 帧导出把嵌套 MovieClip 冻结在其当前内部帧——主时间轴定格期间持续循环的
 * 元件（主菜单气泡、选人页旋涡/地图面板 fx）烘不进底板，ui-pack 改烘"干净底板 + 叠加层
 * 帧序"，本类在运行时按原版 Flash 语义合成：
 *   - 显隐/位置/缩放/透明度由**板帧**驱动（ui.json segs keys 常量段，未放置/已移除 = 隐藏）；
 *   - 内部播放头独立于板帧按墙时 fps 循环：gotoAndPlay 跳板帧**不复位**嵌套播放头
 *     （原版嵌套 clip 一经放置持续走带），移除即暂停、重新放置从帧 1 重来；
 *   - 跳过（skip）只跳板帧，播放头照走——与原版点击跳过表现一致。
 * 帧纹理走 FrameStream（blob 全量预下载 + 按需解码），多实例共用同目录时 pixi 纹理
 * 缓存兜底去重。
 */
import { Sprite } from 'pixi.js';
import { FrameStream } from './stream.js';

/** ui.json 里的放置常量段：[from, to, x, y, sx, sy, alpha]（板帧闭区间）。 */
export type FxKey = [number, number, number, number, number, number, number];

export interface FxSegment {
  depth: number;
  from: number;
  to: number;
  keys: FxKey[];
}

/** ui.json 叠加层规格（title.fx[].segs / select.mapFx[] 共用字段）。 */
export interface FxSpec {
  dir: string;
  frames: number;
  fps: number;
  /** 裁剪帧尺寸（px） */
  size: [number, number];
  /** 帧去重映射（tools/stream-dedup：槽位 → 磁盘帧号）；缺省恒等 */
  map?: number[];
}

/** 板帧 → 本实例渲染状态（坐标 = 场景最终屏幕位，含 OX 偏移与 origin 换算；null = 隐藏）。 */
export interface FxLayout {
  x: number;
  y: number;
  sx: number;
  sy: number;
  alpha: number;
}

export class OverlayFx {
  readonly ui = new Sprite();
  private readonly stream: FrameStream;
  private readonly fps: number;
  private readonly frames: number;
  private playMs = 0;
  private wasVisible = false;
  private disposed = false;

  constructor(spec: FxSpec, private readonly layoutOf: (plateFrame: number) => FxLayout | null) {
    this.ui.visible = false;
    this.fps = spec.fps;
    this.frames = spec.frames;
    this.stream = new FrameStream({ dir: spec.dir, frames: spec.frames, ...(spec.map ? { map: spec.map } : {}) });
  }

  /** 预热首帧（场景 enter 时调用，避免首次显示白块）。 */
  preload(): void {
    this.stream.ensure(1, 2);
  }

  update(plateFrame: number, dtMs: number): void {
    // 宿主 Container 销毁后 Sprite.position/scale 会被 Pixi v8 置 null；幂等兜底。
    if (this.disposed) return;
    const lay = this.layoutOf(plateFrame);
    if (!lay) {
      // 未放置/已移除：隐藏且播放头暂停（原版移除 = 挂起，重新放置从帧 1 走）
      this.ui.visible = false;
      this.wasVisible = false;
      return;
    }
    this.ui.visible = true;
    // 重新放置（隐藏 → 可见沿）从帧 1 重来（原版 addChild 重摆语义；持续可见则照走）
    if (!this.wasVisible) this.playMs = 0;
    this.wasVisible = true;
    this.playMs += dtMs;
    const f = (Math.floor((this.playMs * this.fps) / 1000) % this.frames) + 1;
    const tex = this.stream.get(f);
    if (tex) this.ui.texture = tex;
    else if (this.stream.failed(f)) {
      /* 失败帧保持上一画面 */
    } else this.stream.ensure(f, 2);
    this.ui.alpha = lay.alpha;
    this.ui.position.set(lay.x, lay.y);
    this.ui.scale.set(lay.sx, lay.sy);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stream.dispose();
  }
}

/** 常量段查找：板帧所在 key（无匹配返回 null）。 */
export function fxKeyAt(keys: FxKey[], frame: number): FxKey | null {
  for (const k of keys) if (frame >= k[0] && frame <= k[1]) return k;
  return null;
}
