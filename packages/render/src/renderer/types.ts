/**
 * renderer 子模块共享类型与常量（自 renderer.ts 拆出，纯搬移）。
 * 资产规格接口 = BattleRenderer 的对外资源契约；FighterSprite/BulletSprite
 * 为渲染层内部精灵结构（frames/attached 等子模块共用）。
 */
import type { BLEND_MODES as TBlendMode, Container, Sprite } from 'pixi.js';
import type { FighterAtlas, FireAtlas, MapAtlas } from '@bvn/data';
import type { LoadedFighterAtlas } from '../atlas.js';
import type { HudSpec } from '../hud.js';

export const TICK_MS = 1000 / 60;
export const LOGICAL_W = 1000;
export const LOGICAL_H = 600;

/**
 * Flash blendMode → Pixi blendMode（批次 37）。采集桥把顶层 blendMode 元件
 * 单独采集（透明底 = 源不变），渲染层在此映射对场景混合。
 * 'layer'（组合隔离）采集侧已视为 normal 不拆；未知值回退 normal（不遮场景）。
 */
export function pixiBlendMode(flash: string): TBlendMode {
  switch (flash) {
    case 'add':
      return 'add';
    case 'screen':
      return 'screen';
    case 'multiply':
      return 'multiply';
    case 'darken':
      return 'darken';
    case 'lighten':
      return 'lighten';
    case 'subtract':
      return 'subtract';
    case 'hardlight':
      return 'hard-light';
    case 'overlay':
      return 'overlay';
    case 'difference':
      return 'difference';
    case 'invert':
      return 'negation';
    default:
      return 'normal';
  }
}
/** 原版 GameCamera._screenSize = GameConfig.GAME_SIZE 800×600：autoZoom 的设计视口
 *  常量（批次 23 追补，§4.3 块 11）——原版战斗可视区恒为 800×600（root scrollRect），
 *  与浏览器纵横比无关；移植版可见区随纵横比更大，但 zoom 数值节奏须对齐原版。 */
export const DESIGN_VIEW_W = 800;
export const DESIGN_VIEW_H = 600;

/** baked/bisha.json 的 mc 块（tools/bisha-pack 产物，schema bvn/bisha@3） */
export interface BishaMcData {
  dir: string;
  frames: number;
  fps: number;
  destoryFrame: number;
  canvasOrigin: [number, number];
  canvasSize: [number, number];
  /** 原版 mc 在 effect.swf 里的 authored 摆放 (0,200)。x 不再直接使用（横幅内容按
   *  可见逻辑区拉伸铺满，见 cutinScaleX——批次 29）；y 仅作演出前 band 初值，
   *  演出期被 mcPosY 联动取代。 */
  mcPos: [number, number];
  faceSize: [number, number];
  faceAnchor: [number, number];
  /** 0-based 帧 → [W_Tx, W_Ty, scaleX, scaleY, rOff, gOff, bOff, alphaMul] | null */
  slots: { facemc1: (number[] | null)[]; facemc2: (number[] | null)[] };
  /** 流帧拼图清单（tools/stream-sheet 产物，2026-11-22 战斗加载降请求）；
   *  缺省 = 无拼图，走逐帧装载回退。 */
  sheets?: StreamSheetSpec;
}

/** mc 流帧特效规格（切片 26：XG_bs/XG_cbs；tools/bisha-pack EFFECTS 产物） */
export interface EffectMcData {
  dir: string;
  frames: number;
  fps: number;
  /** 画布原点（mc 空间）：PNG (0,0) 对应的世界偏移，display 位 = org + origin */
  origin: [number, number];
  /** 流帧拼图清单（tools/stream-sheet 产物）；缺省 = 无拼图，走逐帧装载回退。 */
  sheets?: StreamSheetSpec;
}

/**
 * 流帧拼图清单（tools/stream-sheet 产物，2026-11-22 战斗加载降请求）：统一画布
 * 流帧按行优先货架拼进少量 sheet webp，请求次数从逐帧 1:1 降到 1:N。
 * 单元格尺寸 = 统一画布实测值（cell），帧纹理 = sheet 纹理上 cell 尺寸的 quad
 * （Texture.frame），消费端 Texture[] 形状与逐帧装载完全一致。
 */
export interface StreamSheetSpec {
  /** sheet 文件名（相对 baseUrl/dir） */
  sheets: string[];
  /** 统一画布帧尺寸（实测） */
  cell: [number, number];
  /** 0-based 帧 → [sheetIdx, x, y]；宽高 = cell */
  cells: [number, number, number][];
}

/** 切人插图资源（切片 22）：mc 流帧 + 立绘映射（pkgId → faceName → baseUrl 相对路径） */
export interface BishaAssets {
  mc: BishaMcData;
  faces: Record<string, Record<string, string>>;
  /** 必杀光效 mc 流帧（切片 26；缺省 = 不播光效） */
  effects?: { bisha?: EffectMcData; bisha_super?: EffectMcData };
}

/**
 * 命中/防御火花规格（修复批次 35；baked/hitspark.json = tools/hit-pack 产物，
 * 逐条对照原版 EffectModel.as 注册表）。坐标约定：MC 原点钉命中点，
 * 帧位 = origin×direct（EffectView display.x = orgX + offsetX×direct）。
 */
export interface HitsparkEffect {
  dir: string;
  /** 帧数（= 帧文件数；原版 cacheBitmapData 不缓存末帧，渲染帧数 = totalFrames−1） */
  frames: number;
  /** 画布尺寸（FFDec 统一画布 = 全帧 union bounds） */
  canvas: [number, number];
  /** 帧 bounds 原点（PNG (0,0) 相对 MC 原点的偏移，direct=1） */
  origin: [number, number];
  blendMode?: 'add' | 'hardlight';
  /** EffectView randRotate：渲染层随机旋转（绕 MC 原点=命中点） */
  randRotate?: boolean;
  /** 帧位 x 随 direct 镜像（防御火花族） */
  followDirect?: boolean;
  /** 特效目标色调（specialEffectId 件，原版 targetColorOffset：ColorTransform
   *  加色偏移 [r, g, b]，挂受击者、finish 时 resumeColor） */
  colorOffset?: [number, number, number];
  /** 帧标签（label → 1-based 帧号；specialEffectId 件 loop/finish 段位） */
  labels?: Record<string, number>;
  /** 全时间轴循环（buff 光环件，原版 BuffEffectView 构造器 loopPlay=true：
   *  与帧标签 loop 段回跳不同——播到末缓存帧回卷，无 finish 段） */
  loopPlay?: boolean;
  /** 全屏闪（原版 ShineEffectView：ADD 色块 10×降采样拉伸近似） */
  shine?: { color: number; alpha: number };
  freezeMs?: number;
  /** 流帧拼图清单（tools/stream-sheet 产物，2026-11-22 战斗加载降请求）；
   *  缺省 = 无拼图，走逐帧装载回退。 */
  sheets?: StreamSheetSpec;
}

/** baked/hitspark.json 结构（schema bvn/hitspark@2，2026-11-22 随流帧拼图升版）。 */
export interface HitsparkBaked {
  schema: string;
  effects: Record<string, HitsparkEffect>;
  hit: { byType: Record<string, string> };
  defense: { byType: Record<string, string>; fallback: string };
  /** 钢身族（doSteelHitEffect：kan 系/qdj 系/其余；数组 = 渲染层随机择一） */
  steel: Record<string, string[]>;
  /** specialEffectId 持续挂身特效：hitType → mc id（EffectModel addHitEffect
   *  FIRE/ICE/ELECTRIC 表；仅未防御命中路径触发） */
  special?: { byType: Record<string, string> };
  shake: { defense: { pow: number; time: number } };
  breakDef: { id: string; freezeMs: number; shake: { x: number; time: number } };
}

/** 战斗资源清单（app 装配后传入） */
export interface BattleAssetsSpec {
  /** 素材基 URL（图集 JSON 与 sheet PNG 同目录） */
  baseUrl: string;
  /** 战斗出场角色：slot = SimState.fighters 里的 fighter id；
   *  formIndex = FighterDef.formIndex（对应图集 forms 数组下标） */
  fighters: { slot: number; atlasId: string; kind?: 'fighter' | 'assister'; formIndex?: number }[];
  /** 辅助（切片 12）：ownerId = 召唤者 fighter id；atlasId = 辅助包 id */
  assisters?: { ownerId: number; atlasId: string }[];
  mapAtlasId: string;
  mapAtlasJson?: MapAtlas;
  /** 原版 MapMain.initlize 视觉层整体下移量（baked map JSON bottomOffset；缺省 0） */
  mapBottomOffset?: number;
  /** 死亡线 bottom（front 层纵向视差公式用；缺省 = 逻辑高） */
  mapBottom?: number;
  fighterAtlasJson?: Record<string, FighterAtlas>;
  /**
   * fire 元件图集（切片 13-A3 引入，切片 14 多角色化）：键为**出场者 atlasId**
   * （fighter 侧 = 角色 atlasId；assister 侧 = 辅助 atlasId），值为 fire 图集 id。
   * bullet 按 owner 归属（ownerId → 对应精灵的 atlasId）选择；缺条目回退色块。
   * attacker（切片 13-A4）同为 fighter 侧 owner（addAttacker 仅角色侧注册）。
   */
  fireAtlases?: { fighter?: Record<string, string>; assister?: Record<string, string> };
  fireAtlasJson?: Record<string, FireAtlas>;
  /** 必杀/万解切人插图（切片 22）：缺省 = 不渲染切人（黑幕/横幅/立绘全缺） */
  bisha?: BishaAssets;
  /** 命中/防御火花（修复批次 35）：缺省 = 命中无火花特效 */
  hitspark?: { baked: HitsparkBaked };
  /** 对局 HUD（切片 30）：缺省 = 不渲染 HUD */
  hud?: HudSpec;
}

export interface FighterSprite {
  root: Container;
  body: Sprite;
  /** 混合模式子层（批次 37：Flash blendMode 元件，帧含 parts 时启用） */
  parts: Sprite[];
  atlasId: string;
  loaded: LoadedFighterAtlas | null;
  /** 图集 forms 下标（= FighterDef.formIndex） */
  formIndex: number;
  /** 已应用的内层帧 pngId（避免每渲染帧换纹理） */
  appliedPng: number;
  appliedFacing: number;
}

/** 道具精灵（bullet 切片 13-A3 / attacker 切片 13-A4）：容器 = 元件原点锚，子 Sprite = 当前帧内容 */
export interface BulletSprite {
  root: Container;
  body: Sprite;
  /** 混合模式子层（与角色 applyFrame 同构；fire 帧含 parts 时启用） */
  parts: Sprite[];
  /** 已应用的动画帧（避免每渲染帧换纹理） */
  appliedFrame: number;
}
