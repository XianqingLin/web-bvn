/**
 * 主菜单 title 三层夹心 · fx 叠加层播放器（切片 46，2026-11-24 重审立项）。
 *
 * 语义（原版 Flash 嵌套 MovieClip）：
 *   - 可见性/位置/缩放/透明度由**板帧**驱动（ui.json title.fx instances keys，根放置段
 *     常量压缩；段外 = 未放置/已移除 = 隐藏）；
 *   - 内部播放头（元件自身时间轴的脉冲循环）在**板推进时按板帧同步推进**、板定格/停帧
 *     时按墙时推进——正常播放两模型等价（同为文档 fps），网络停帧时与底板保持一致；
 *     定格期（stop 脚本）板帧不动 → 照走（原版嵌套 clip 一经放置持续走带）；
 *   - 隐藏 → 可见沿播放头归零（原版重新放置从帧 1 走）；跳板帧（skip）不归零
 *     （原版 gotoAndPlay 不复位嵌套播放头）；
 *   - 摆位 = keys(x,y,sx,sy) + 元件内容 union 左上 origin（= FFDec 导出画布原点），
 *     纯几何，无模板匹配（构造数据来自 SWF 标签语义，见 PROGRESS §2.4）。
 * 同元件多实例（光斑 40×4）共享一条 FrameStream（纹理去重）。
 */
import { Container, Sprite } from 'pixi.js';
import { FrameStream, SheetFrameStream } from './stream.js';
import { FxTweenContent, type FxTweenSpec } from './fx.js';

export interface TitleFxElement {
  dir: string;
  frames: number;
  fps: number;
  /** 裁剪帧尺寸（px，= 内容 union 尺寸） */
  size: [number, number];
  /** 内容 union 左上（元件局部坐标；PNG 画布原点） */
  origin: [number, number];
  /** 流帧拼图清单（tools/stream-sheet --ui 产物，2026-11-25）；缺省 = 逐帧回退 */
  sheets?: import('@bvn/render').StreamSheetSpec;
  /** 帧去重映射（tools/stream-dedup：槽位 → 磁盘帧号）；缺省恒等 */
  map?: number[];
  /** Tier 2 tween 化（DESIGN §4.8）：单贴图 + 内部补间替代帧流；缺省 = 走流 */
  tween?: FxTweenSpec;
}

export interface TitleFxInstance {
  char: number;
  depth: number;
  from: number;
  to: number;
  /** [(from,to,x,y,sx,sy,alpha)]，板帧闭区间常量段 */
  keys: [number, number, number, number, number, number, number][];
}

interface Layer {
  readonly sprite: Sprite;
  readonly el: TitleFxElement;
  readonly inst: TitleFxInstance;
  readonly stream: FrameStream | SheetFrameStream | null;
  /** 内部时间轴补间（el.tween 存在时；与 stream 互斥） */
  readonly tween: FxTweenContent | null;
  /** 内部播放头（帧，浮点累加） */
  play: number;
  wasVisible: boolean;
}

const keyAt = (inst: TitleFxInstance, plateFrame: number) => {
  if (plateFrame < inst.from || plateFrame > inst.to) return null;
  for (const k of inst.keys) if (plateFrame >= k[0] && plateFrame <= k[1]) return k;
  return null;
};

export class TitleFxLayer {
  readonly ui = new Container();
  private readonly layers: Layer[] = [];
  private readonly streams: (FrameStream | SheetFrameStream)[] = [];
  private disposed = false;

  constructor(
    elements: Record<string, TitleFxElement>,
    instances: TitleFxInstance[],
    /** 场景级偏移（舞台 800×600 在逻辑屏内的 OX）；y 恒 0（stg_title (0,0)=舞台 (0,0)） */
    private readonly stageOffset: [number, number],
  ) {
    const streamByDir = new Map<string, FrameStream | SheetFrameStream>();
    for (const inst of [...instances].sort((a, b) => a.depth - b.depth)) {
      const el = elements[String(inst.char)];
      if (!el) throw new Error(`title fx 元件 ${inst.char} 缺帧序规格`);
      let stream = streamByDir.get(el.dir) ?? null;
      let tween: FxTweenContent | null = null;
      if (el.tween) {
        // Tier 2 tween 化：单贴图 + 内部补间，无流
        tween = new FxTweenContent(el.tween);
      } else if (!stream) {
        // 拼图清单优先（2026-11-25）：sheet 纹理常驻 + cell quad，零逐帧解码/上传；
        // 无清单回退逐帧 FrameStream（lazy：构造期不全量预取——10 条流 ~350 请求
        // 会打满 HTTP 连接池，把同场景按钮贴图/板首帧压到队尾——切片 46 实测 4.4s
        // 黑屏根因；帧按播放进度 ensure 逐帧拉）
        stream = el.sheets
          ? new SheetFrameStream({
              dir: el.dir,
              frames: el.frames,
              sheets: el.sheets,
              ...(el.map ? { map: el.map } : {}),
            })
          : new FrameStream({ dir: el.dir, frames: el.frames, lazy: true, ...(el.map ? { map: el.map } : {}) });
        streamByDir.set(el.dir, stream);
        this.streams.push(stream);
      }
      const sprite = new Sprite();
      sprite.visible = false;
      if (tween) sprite.addChild(tween.sprite);
      this.ui.addChild(sprite);
      this.layers.push({ sprite, el, inst, stream, tween, play: 0, wasVisible: false });
    }
  }

  /** 元件流列表（game-loading 预载用：拼图 sheet blob 预下载）。 */
  elementStreams(): (FrameStream | SheetFrameStream)[] {
    return this.streams;
  }

  /** 预热各元件帧 1..2（场景 enter 时调用，避免首次显示白块）。 */
  preload(): void {
    for (const s of this.elementStreams()) s.ensure(1, 2);
  }

  /**
   * @param plateFrame 当前显示板帧
   * @param dtMs 本 tick 墙时
   * @param plateAdvanced 本 tick 板帧是否推进（推进时 fx 按板帧同步走）
   * @param plateDelta 板推进帧数（plateAdvanced 时有效）
   */
  update(plateFrame: number, dtMs: number, plateAdvanced: boolean, plateDelta: number): void {
    if (this.disposed) return;
    for (const l of this.layers) {
      const k = keyAt(l.inst, plateFrame);
      if (!k) {
        // 未放置/已移除：隐藏且播放头暂停（原版移除 = 挂起，重新放置从帧 1 走）
        l.sprite.visible = false;
        l.wasVisible = false;
        continue;
      }
      const [, , x, y, sx, sy, alpha] = k;
      if (!l.wasVisible) l.play = 0;
      l.wasVisible = true;
      l.play += plateAdvanced ? plateDelta : (dtMs * l.el.fps) / 1000;
      const f = (Math.floor(l.play) % l.el.frames) + 1;
      if (l.tween) {
        // Tier 2 tween：内容 = 单贴图 + 内部补间（origin 已含贴图 TL 元件位，外层只挂
        // 放置位——union origin 不进外层，防双重偏移）
        l.tween.apply(f);
        l.sprite.position.set(this.stageOffset[0] + x, y);
      } else if (l.stream) {
        const tex = l.stream.get(f);
        if (tex) l.sprite.texture = tex;
        else if (!l.stream.failed(f)) l.stream.ensure(f, 2); // 失败帧保持上一画面
        // PNG 画布原点 = 内容 union 左上（origin）→ 挂位 = 放置位 + scale×origin
        l.sprite.position.set(this.stageOffset[0] + x + sx * l.el.origin[0], y + sy * l.el.origin[1]);
      }
      l.sprite.visible = true;
      l.sprite.alpha = alpha;
      l.sprite.scale.set(sx, sy);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of this.streams) s.dispose();
    this.layers.length = 0;
  }
}
