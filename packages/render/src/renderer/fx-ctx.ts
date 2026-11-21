/**
 * FxCtx —— 特效子系统共享上下文（renderer.ts 拆分的基础设施）。
 *
 * 三类成员：
 *   - 构造期固定引用：图层容器 / 精灵寻址 Map（BattleRenderer 构造时装配，
 *     与编排器持有同一对象引用，天然共享）；
 *   - load 重建的资源仓（assets）：字段整体替换，模块每次现读不缓存；
 *   - 视口 / 地图视觉态（viewW/viewH/mapView）：onResize、buildMap 时原地改写。
 */
import { ColorMatrixFilter } from 'pixi.js';
import type { Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { BishaMcData, EffectMcData, FighterSprite, HitsparkBaked } from './types.js';

/** load 重建的烘焙资源（字段整体替换；模块用前现读，不在构造期缓存） */
export interface FxAssets {
  /** 命中/防御火花 baked 表（修复批次 35） */
  hitspark: HitsparkBaked | null;
  sparkTex: Map<string, Texture[]>;
  /** 切人插图（切片 22）：mc 流帧规格 + 横幅纹理 + 已装载立绘（key = `${atlasId}:${faceName}`） */
  bishaMc: BishaMcData | null;
  bishaBandTex: Texture[];
  bishaFaceTex: Map<string, Texture>;
  /** 必杀光效 mc 流帧（切片 26）：spec + 预载纹理（key = bisha / bisha_super） */
  bishaEffects: Record<string, EffectMcData>;
  effectTex: Map<string, Texture[]>;
}

/** 地图视觉态（load/buildMap 写入，相机读取） */
export interface MapViewState {
  /** 视觉层整体下移量（原版 MapMain.initlize 的 bottomOffset，切片 13-A2） */
  bottomOffset: number;
  /** 死亡线（原版归一后 = gameSize.y；front 层纵向视差公式用） */
  bottom: number;
  /** front 层基础位（装配后、视差前） */
  frontBaseX: number;
  frontBaseY: number;
  /** bg 素材尺寸（cover 铺满可见区用，原版 bg 恰好 = GAME_SIZE 满屏） */
  bgSize: { w: number; h: number };
  bgSprite: Sprite | null;
}

export interface FxCtx {
  /** 世界容器宽/高（屏幕 CSS 逻辑像素；onResize 原地改写） */
  viewW: number;
  viewH: number;

  // —— 图层（构造期固定引用，层序见 BattleRenderer 构造器） ——
  fxLayer: Container;
  /** 残影层（切片 47，原版 ShadowEffectView）：挂在角色层之下、地图层之上 */
  shadowLayer: Container;
  /** 全屏闪层（修复批次 35 shine；屏幕空间，world 之上 HUD 之下） */
  shineLayer: Container;
  /** KO 背景层（KO 终结演出链，原版 BGEffect：effect 置舞台最底层 + 地图隐藏） */
  kobgLayer: Container;
  /** 切人黑幕（切片 22）：屏幕空间，覆盖全屏；原版 BlackBackView 800×600 挂
   *  gameStage 底层（角色之下、bg 之上），web 端等价 = stage 上 bgFixed 与 world 之间 */
  blackLayer: Graphics;
  /** 切人横幅+立绘屏幕空间容器（切片 26 移入屏幕空间：原版横幅挂在 BlackBackView
   *  ——stage 子级、scrollRect 之外，不随相机平移/缩放；切片 22 误放 world 内会随
   *  聚焦相机漂移）。层序 = 黑幕之上、world（角色）之下 */
  cutinScreen: Container;
  cutinLayer: Container;
  cutinBand: Sprite;
  cutinFace: Sprite;
  /** 立绘白闪叠层（原版 color offset 255→50→0 的近似：白色加色叠加） */
  cutinFaceFlash: Sprite;
  mapLayer: Container;
  /** front_fix 层：随地图固定（原版在角色层之上、无视差） */
  mapFrontFixLayer: Container;
  /** front 层：前景（原版 0.1 视差，屏幕上比世界移动更快） */
  mapFrontLayer: Container;

  // —— 精灵寻址（load 填充，与编排器同一 Map 引用） ——
  sprites: Map<number, FighterSprite>;
  /** 辅助精灵（切片 12）：key = 召唤者 fighter id（同主同时至多一个辅助） */
  assistSprites: Map<number, FighterSprite>;
  /** 切人立绘寻址（切片 22）：fighter id / 辅助 ownerId → atlasId（load 装配） */
  fighterAtlasById: Map<number, string>;
  assisterAtlasByOwner: Map<number, string>;
  /** 加色偏移滤镜缓存（同色偏移共享一个 ColorMatrixFilter；残影与挂身特效共用） */
  colorOffsetFilters: Map<string, ColorMatrixFilter>;

  assets: FxAssets;
  mapView: MapViewState;
}

/** 加色偏移滤镜（ColorTransform redOffset 系 → ColorMatrixFilter 第 5 列；
 *  负偏移 = 减色，Fire (255,25,−255) 类色调同通道）。 */
export function colorOffsetFilterOf(
  ctx: FxCtx,
  st: { r: number; g: number; b: number },
): ColorMatrixFilter | null {
  if (st.r === 0 && st.g === 0 && st.b === 0) return null;
  const key = `${st.r},${st.g},${st.b}`;
  let f = ctx.colorOffsetFilters.get(key);
  if (!f) {
    f = new ColorMatrixFilter();
    // pixi v8 matrix getter 返回内部数组，原地改第 5 列（加色偏移）
    const m = f.matrix;
    m[4] = st.r / 255;
    m[9] = st.g / 255;
    m[14] = st.b / 255;
    ctx.colorOffsetFilters.set(key, f);
  }
  return f;
}
