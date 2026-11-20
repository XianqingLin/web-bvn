/**
 * BattleRenderer —— 战斗画面渲染（DESIGN §5）。
 *
 * 唯一输入 = SimSnapshot（契约）：位置在相邻两快照间线性插值，
 * 动画帧/朝向取最新快照；相机纯渲染；HUD 读快照；
 * 表现事件按 tick 去重消费（不回读 sim 内部状态）。
 */
import { Application, Assets, ColorMatrixFilter, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
// 高级混合模式注册（darken/lighten/hard-light/subtract…走 BlendModeFilter 实现）。
// pixi.js@8.22.0 的打包缺陷：主入口不引 advanced-blend-modes/init，不显式 import 则
// 这些 blendMode 静默回退 normal（darken 白底直接画出来 = 白矩形块）。
import 'pixi.js/advanced-blend-modes';
import type { BLEND_MODES as TBlendMode } from 'pixi.js';
import type { SimSnapshot } from '@bvn/core';
import type { FighterAtlas, FireAtlas, MapAtlas } from '@bvn/data';
import { frameTexture, loadFighterAtlas, loadFireAtlas, loadMapAtlas, type LoadedFighterAtlas, type LoadedFireAtlas, type LoadedMapAtlas } from './atlas.js';
import { FightHud, type HudSpec } from './hud.js';

const TICK_MS = 1000 / 60;
const LOGICAL_W = 1000;
const LOGICAL_H = 600;

/**
 * Flash blendMode → Pixi blendMode（批次 37）。采集桥把顶层 blendMode 元件
 * 单独采集（透明底 = 源不变），渲染层在此映射对场景混合。
 * 'layer'（组合隔离）采集侧已视为 normal 不拆；未知值回退 normal（不遮场景）。
 */
function pixiBlendMode(flash: string): TBlendMode {
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
const DESIGN_VIEW_W = 800;
const DESIGN_VIEW_H = 600;

/** baked/bisha.json 的 mc 块（tools/bisha-pack 产物，schema bvn/bisha@1） */
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
}

/** mc 流帧特效规格（切片 26：XG_bs/XG_cbs；tools/bisha-pack EFFECTS 产物） */
export interface EffectMcData {
  dir: string;
  frames: number;
  fps: number;
  /** 画布原点（mc 空间）：PNG (0,0) 对应的世界偏移，display 位 = org + origin */
  origin: [number, number];
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
  /** 全屏闪（原版 ShineEffectView：ADD 色块 10×降采样拉伸近似） */
  shine?: { color: number; alpha: number };
  freezeMs?: number;
}

/** baked/hitspark.json 结构（schema bvn/hitspark@1）。 */
export interface HitsparkBaked {
  schema: string;
  effects: Record<string, HitsparkEffect>;
  hit: { byType: Record<string, string> };
  defense: { byType: Record<string, string>; fallback: string };
  /** 钢身族（doSteelHitEffect：kan 系/qdj 系/其余；数组 = 渲染层随机择一） */
  steel: Record<string, string[]>;
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

interface FighterSprite {
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
interface BulletSprite {
  root: Container;
  body: Sprite;
  /** 已应用的动画帧（避免每渲染帧换纹理） */
  appliedFrame: number;
}

export class BattleRenderer {
  private world: Container;
  /** 背景层容器：随视口缩放但不随相机平移（原版 bgLayer 挂 stage，scrollRect 之外） */
  private bgFixed: Container;
  private mapLayer: Container;
  /** front_fix 层：随地图固定（原版在角色层之上、无视差） */
  private mapFrontFixLayer: Container;
  /** front 层：前景（原版 0.1 视差，屏幕上比世界移动更快） */
  private mapFrontLayer: Container;
  private fighterLayer: Container;
  /** 残影层（切片 47，原版 ShadowEffectView）：挂在角色层之下、地图层之上 */
  private shadowLayer: Container;
  private bulletLayer: Container;
  private bulletGfx: Graphics;
  /** attacker 色块回退（独立道具缺图集条目时） */
  private attackerGfx: Graphics;
  private fxLayer: Container;
  /** 全屏闪层（修复批次 35 shine；屏幕空间，world 之上 HUD 之下） */
  private shineLayer: Container;
  private hudLayer: Container;
  /** 切人黑幕（切片 22）：屏幕空间，覆盖全屏；原版 BlackBackView 800×600 挂
   *  gameStage 底层（角色之下、bg 之上），web 端等价 = stage 上 bgFixed 与 world 之间 */
  private blackLayer: Graphics;
  /** 切人横幅+立绘屏幕空间容器（切片 26 移入屏幕空间：原版横幅挂在 BlackBackView
   *  ——stage 子级、scrollRect 之外，不随相机平移/缩放；切片 22 误放 world 内会随
   *  聚焦相机漂移）。层序 = 黑幕之上、world（角色）之下 */
  private cutinScreen: Container;
  private cutinLayer: Container;
  private cutinBand: Sprite;
  private cutinFace: Sprite;
  /** 立绘白闪叠层（原版 color offset 255→50→0 的近似：白色加色叠加） */
  private cutinFaceFlash: Sprite;
  private sprites = new Map<number, FighterSprite>();
  /** 辅助精灵（切片 12）：key = 召唤者 fighter id（同主同时至多一个辅助） */
  private assistSprites = new Map<number, FighterSprite>();
  /** 切人立绘寻址（切片 22）：fighter id / 辅助 ownerId → atlasId（load 装配） */
  private fighterAtlasById = new Map<number, string>();
  private assisterAtlasByOwner = new Map<number, string>();
  /** fire 图集（切片 14 多角色）：键 = 出场者 atlasId；无条目 = 色块回退 */
  private fireLoadedFighter = new Map<string, LoadedFireAtlas>();
  private fireLoadedAssister = new Map<string, LoadedFireAtlas>();
  /** bullet 精灵：key = bullet id；快照缺席即移除（despawn 收尾） */
  private bulletSprites = new Map<number, BulletSprite>();
  /** attacker 精灵（切片 13-A4）：key = attacker id；同 bullet 模式 */
  private attackerSprites = new Map<number, BulletSprite>();
  private mapLoaded: LoadedMapAtlas | null = null;
  /** 视觉层整体下移量（原版 MapMain.initlize 的 bottomOffset，切片 13-A2） */
  private mapBottomOffset = 0;
  /** 死亡线（原版归一后 = gameSize.y；front 层纵向视差公式用） */
  private mapBottom = LOGICAL_H;
  /** front 层基础位（装配后、视差前） */
  private frontBaseX = 0;
  private frontBaseY = 0;
  /** bg 素材尺寸（cover 铺满可见区用，原版 bg 恰好 = GAME_SIZE 满屏） */
  private bgSize = { w: 0, h: 0 };
  private bgSprite: Sprite | null = null;
  private roundText: Text | null = null;
  private hintText: Text | null = null;

  /** 切人插图（切片 22）：mc 流帧纹理 + 已装载立绘纹理 */
  private bishaMc: BishaMcData | null = null;
  private bishaBandTex: Texture[] = [];
  private bishaFaceTex = new Map<string, Texture>(); // key = `${atlasId}:${faceName}`
  /** 当前演出：事件捕获（face/owner/槽位），锁清除即收场。
   *  mcPosY = 原版 BlackBackView.showBishaFace 的 `mc.y = 100 + 100/zoom`
   * （zoom = 演出开始时相机目标缩放因子；切片 22 为常数 200，切片 26 补上联动）。 */
  private cutin: {
    active: boolean;
    faceName: string | null;
    faceTex: Texture | null;
    slot: 1 | 2;
    mcPosY: number;
    accMs: number;
    frame: number;
  } = { active: false, faceName: null, faceTex: null, slot: 1, mcPosY: 200, accMs: 0, frame: 0 };

  /** 必杀光效 mc 流帧（切片 26）：spec + 预载纹理（key = bisha / bisha_super） */
  private bishaEffects: Record<string, EffectMcData> = {};
  private effectTex = new Map<string, Texture[]>();
  /** 在播 mc 特效视图（原版 EffectView：direct 恒 1、加色混合、30fps 播尽自移除） */
  private mcEffects: {
    root: Container;
    body: Sprite;
    texs: Texture[];
    fps: number;
    accMs: number;
    frame: number;
  }[] = [];

  /** 命中火花（修复批次 35）：baked 表 + 预载纹理；火花视图（30fps 播尽自移除） */
  private hitspark: HitsparkBaked | null = null;
  private sparkTex = new Map<string, Texture[]>();
  private sparkFx: { root: Container; body: Sprite; texs: Texture[]; accMs: number; frame: number }[] =
    [];
  /** 全屏闪（原版 ShineEffectView：ADD 色块，15fps 衰减 5%，≤5% 移除） */
  private shines: { sp: Sprite; alpha: number; accMs: number }[] = [];
  /** 世界抖动（原版 EffectCtrler.renderShakeX/Y：30fps 步进，pow 逐 2 帧线性衰减、
   *  direct 逐帧翻转；offset 应用到 world+bgFixed（原版 = gameStage 整体位移） */
  private shakeSt = {
    powX: 0,
    powY: 0,
    dxX: 1,
    dxY: 1,
    frameX: 0,
    frameY: 0,
    loseX: 0,
    loseY: 0,
    holdX: 0,
    holdY: 0,
  };
  private shakeAccMs = 0;
  private shakeOffX = 0;
  private shakeOffY = 0;

  /** 相机聚焦（切片 26，原版 GameStage.cameraFocusOne/cameraResume）：super 必杀/
   *  万解聚焦施法者，cutinLock 清除即恢复双焦点（null = 双焦点，autoZoom 接管） */
  private camFocus: { kind: 'fighter' | 'assister'; id: number } | null = null;

  private prev: SimSnapshot | null = null;
  private next: SimSnapshot | null = null;
  private accMs = 0;
  private lastEventsTick = new Map<string, number>();

  /** 残影（切片 47，原版 ShadowEffectView）：key = `${ownerKind}:${id}`；
   *  r/g/b 为原版 ColorTransform 加色偏移（非 0 时挂 ColorMatrixFilter 近似）。
   *  停止条件 = endShadow 事件 / 角色快照 actionState 变化（原版 doAction/idle/
   *  doHurt 统一 endShadow 的渲染层近似——激活态不进 core，纯表现）。 */
  private shadowStates = new Map<string, { r: number; g: number; b: number }>();
  /** 残影快照序列（30Hz 步进：每 2 步拍一帧，alpha 0.8 起步每步 -0.1，≤0 移除） */
  private shadowGhosts: { root: Container; alpha: number }[] = [];
  private shadowAccMs = 0;
  private shadowStep = 0;
  /** 加色偏移滤镜缓存（同色残影共享一个 ColorMatrixFilter） */
  private shadowFilters = new Map<string, ColorMatrixFilter>();

  /** 相机（逻辑坐标）：中心点 + 缩放因子（原版 GameCamera 语义：
   *  factor = 原版 zoom，1 = 满屏逻辑区；有效缩放 = fitZoom × factor）。
   *  缓动 = 原版 ease：逐帧 delta/5（tweenSpd = CAMERA_TWEEN_SPD/SPEED_PLUS_DEFAULT） */
  private camX = LOGICAL_W / 2;
  private camY = LOGICAL_H / 2;
  private zoomFactor = 1;
  private zoomTarget = 1;
  /** 世界容器宽（屏幕 CSS 逻辑像素）：缩放 = worldW / LOGICAL_W */
  private viewW = LOGICAL_W;
  private viewH = LOGICAL_H;

  constructor(private app: Application) {
    this.bgFixed = new Container();
    this.cutinScreen = new Container();
    this.world = new Container();
    this.mapLayer = new Container();
    this.mapFrontFixLayer = new Container();
    this.mapFrontLayer = new Container();
    this.shadowLayer = new Container();
    this.fighterLayer = new Container();
    this.bulletLayer = new Container();
    this.bulletGfx = new Graphics();
    this.attackerGfx = new Graphics();
    this.fxLayer = new Container();
    this.hudLayer = new Container();
    this.blackLayer = new Graphics();
    this.blackLayer.visible = false;
    this.cutinLayer = new Container();
    this.cutinBand = new Sprite(Texture.WHITE);
    this.cutinBand.visible = false;
    this.cutinFace = new Sprite(Texture.WHITE);
    this.cutinFace.visible = false;
    this.cutinFaceFlash = new Sprite(Texture.WHITE);
    this.cutinFaceFlash.visible = false;
    this.cutinFaceFlash.blendMode = 'add';
    this.cutinLayer.addChild(this.cutinBand, this.cutinFace, this.cutinFaceFlash);
    this.cutinLayer.visible = false;
    this.bulletLayer.addChild(this.attackerGfx, this.bulletGfx);
    // 层序（镜像原版：GameStage[_blackBack < bgLayer < gameLayer[map < player < …]]]；
    // web 端 bg/黑幕/切人横幅均在屏幕空间）：
    //   bg(屏幕固定) < 黑幕(屏幕固定) < 切人横幅/立绘(屏幕固定) <
    //   world[ map < 角色 < 独立道具/飞行道具 < front_fix < front(视差) < 特效 ]
    this.world.addChild(
      this.mapLayer,
      this.shadowLayer,
      this.fighterLayer,
      this.bulletLayer,
      this.mapFrontFixLayer,
      this.mapFrontLayer,
      this.fxLayer,
    );
    this.cutinScreen.addChild(this.cutinLayer);
    this.shineLayer = new Container();
    app.stage.addChild(
      this.bgFixed,
      this.blackLayer,
      this.cutinScreen,
      this.world,
      this.shineLayer,
      this.hudLayer,
    );
    this.onResize();
    app.renderer.on('resize', this.onResize, this);
  }

  private onResize(): void {
    // 布局使用 CSS 逻辑尺寸,不能把乘过 DPR 的画布物理像素当成游戏坐标。
    this.viewW = this.app.renderer.screen.width;
    this.viewH = this.app.renderer.screen.height;
  }

  /** 加载战斗素材（app await；onProgress = 分步进度回报 0..1，加载页进度条消费，块 9）。 */
  async load(spec: BattleAssetsSpec, onProgress?: (fraction: number) => void): Promise<void> {
    // 分步总数由 spec 预推（与下方 await 序列一一对应；步骤增删须同步）
    const fireCount = Object.values(spec.fireAtlases ?? {}).reduce(
      (s, m) => s + Object.keys(m).length,
      0,
    );
    const effectFrames = Object.values(spec.bisha?.effects ?? {}).reduce((s, e) => s + e.frames, 0);
    const faceCount = spec.bisha
      ? [
          ...spec.fighters.map((f) => f.atlasId),
          ...(spec.assisters ?? []).map((a) => a.atlasId),
        ].reduce((s, id) => s + Object.keys(spec.bisha!.faces[id] ?? {}).length, 0)
      : 0;
    const total =
      1 /*map*/ +
      spec.fighters.length +
      (spec.assisters?.length ?? 0) +
      fireCount +
      (spec.bisha ? spec.bisha.mc.frames + effectFrames + faceCount : 0) +
      (spec.hitspark ? Object.keys(spec.hitspark.baked.effects).length : 0) +
      (spec.hud ? 1 : 0);
    let done = 0;
    const tick = () => {
      done++;
      onProgress?.(Math.min(done / total, 1));
    };
    const atlasFor = async (atlasId: string, kind: 'fighter' | 'assister'): Promise<FighterAtlas> => {
      if (spec.fighterAtlasJson?.[atlasId]) return spec.fighterAtlasJson[atlasId]!;
      const url = `${spec.baseUrl}/${kind === 'assister' ? 'assistants' : 'fighters'}/${atlasId}.atlas.json`;
      return (await this.fetchJson(url)) as FighterAtlas;
    };

    const mapAtlas: MapAtlas =
      spec.mapAtlasJson ??
      ((await this.fetchJson(`${spec.baseUrl}/maps/${spec.mapAtlasId}.atlas.json`)) as MapAtlas);
    // atlas JSON 内 file 为裸文件名，sheet PNG 与 atlas JSON 同目录（assets/<kind>/）
    this.mapLoaded = await loadMapAtlas(`${spec.baseUrl}/maps`, mapAtlas);
    this.mapBottomOffset = spec.mapBottomOffset ?? 0;
    this.mapBottom = spec.mapBottom ?? LOGICAL_H;
    this.buildMap();
    tick();

    for (const f of spec.fighters) {
      const kind = f.kind ?? 'fighter';
      const atlas = await atlasFor(f.atlasId, kind);
      const loaded = await loadFighterAtlas(`${spec.baseUrl}/${kind === 'assister' ? 'assistants' : 'fighters'}`, atlas);
      this.sprites.set(f.slot, this.makeSprite(f.atlasId, loaded, f.formIndex ?? 0));
      this.fighterAtlasById.set(f.slot, f.atlasId);
      tick();
    }

    for (const a of spec.assisters ?? []) {
      const atlas = await atlasFor(a.atlasId, 'assister');
      const loaded = await loadFighterAtlas(`${spec.baseUrl}/assistants`, atlas);
      this.assistSprites.set(a.ownerId, this.makeSprite(a.atlasId, loaded, 0));
      this.assisterAtlasByOwner.set(a.ownerId, a.atlasId);
      tick();
    }

    // fire 元件图集（切片 14 多角色）：按出场者 atlasId 装载；缺失条目色块回退
    for (const kind of ['fighter', 'assister'] as const) {
      for (const [ownerAtlasId, fireAtlasId] of Object.entries(spec.fireAtlases?.[kind] ?? {})) {
        const atlasJson =
          spec.fireAtlasJson?.[fireAtlasId] ??
          ((await this.fetchJson(
            `${spec.baseUrl}/fires/${kind}/${fireAtlasId}.atlas.json`,
          )) as FireAtlas);
        const loaded = await loadFireAtlas(`${spec.baseUrl}/fires/${kind}`, atlasJson);
        (kind === 'fighter' ? this.fireLoadedFighter : this.fireLoadedAssister).set(
          ownerAtlasId,
          loaded,
        );
        tick();
      }
    }

    // 切人插图（切片 22）：mc 流帧全量 + 出场者立绘（仅当前对局涉及的包）
    if (spec.bisha) {
      this.bishaMc = spec.bisha.mc;
      this.bishaBandTex = [];
      for (let i = 1; i <= spec.bisha.mc.frames; i++) {
        this.bishaBandTex.push(await Assets.load<Texture>(`${spec.baseUrl}/${spec.bisha.mc.dir}/${i}.webp`));
        tick();
      }
      // 必杀光效流帧（切片 26）：bisha(XG_bs) / bisha_super(XG_cbs)
      this.bishaEffects = {};
      this.effectTex.clear();
      for (const [id, eff] of Object.entries(spec.bisha.effects ?? {})) {
        const texs: Texture[] = [];
        for (let i = 1; i <= eff.frames; i++) {
          texs.push(await Assets.load<Texture>(`${spec.baseUrl}/${eff.dir}/${i}.webp`));
          tick();
        }
        this.bishaEffects[id] = eff;
        this.effectTex.set(id, texs);
      }
      // 横幅常驻位：内容（PNG 减对称出血）横向拉伸铺满可见逻辑区（见 cutinScaleX），
      // x = canvasOrigin×sx 使内容左缘贴视口 0；y 为烘焙初值（演出期由 mcPosY 联动接管，切片 26）
      const mcSx0 = this.cutinScaleX(spec.bisha.mc);
      this.cutinBand.scale.set(mcSx0, 1);
      this.cutinBand.position.set(
        spec.bisha.mc.canvasOrigin[0] * mcSx0,
        spec.bisha.mc.mcPos[1] + spec.bisha.mc.canvasOrigin[1],
      );
      for (const atlasId of new Set([
        ...spec.fighters.map((f) => f.atlasId),
        ...(spec.assisters ?? []).map((a) => a.atlasId),
      ])) {
        for (const [faceName, path] of Object.entries(spec.bisha.faces[atlasId] ?? {})) {
          const tex = await Assets.load<Texture>(`${spec.baseUrl}/${path}`);
          this.bishaFaceTex.set(`${atlasId}:${faceName}`, tex);
          tick();
        }
      }
    } else {
      this.bishaMc = null;
    }

    // 命中/防御火花（修复批次 35）：全部元件流帧预载（共 19 元件 ~230 帧，vite 缓存后廉价）
    if (spec.hitspark) {
      this.hitspark = spec.hitspark.baked;
      this.sparkTex.clear();
      for (const [id, eff] of Object.entries(this.hitspark.effects)) {
        const texs: Texture[] = [];
        for (let i = 1; i <= eff.frames; i++) {
          texs.push(await Assets.load<Texture>(`${spec.baseUrl}/${eff.dir}/${i}.webp`));
        }
        this.sparkTex.set(id, texs);
        tick();
      }
    } else {
      this.hitspark = null;
    }

    // 对局 HUD（切片 30）：纹理装载 + 静态树（重建对局时先拆旧树）
    if (spec.hud) {
      this.hud?.destroy();
      this.hud = new FightHud(this.hudLayer, spec.hud);
      await this.hud.load(spec.baseUrl);
      tick();
    } else {
      this.hud?.destroy();
      this.hud = null;
    }
  }

  private async fetchJson(url: string): Promise<unknown> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`render: 资源 JSON 加载失败 ${url} (${res.status})`);
    return res.json();
  }

  private buildMap(): void {
    this.bgFixed.removeChildren();
    this.mapLayer.removeChildren();
    this.mapFrontFixLayer.removeChildren();
    this.mapFrontLayer.removeChildren();
    const loaded = this.mapLoaded;
    if (!loaded) return;
    // 原版 MapMain.initlize：map/front/front_fix 三层视觉整体 y += bottomOffset
    //（= gameSize.y - 原始 line_bottom.y），bg 不动；floor 容器是碰撞标记
    //（initFloor 只读坐标，从不显示），跳过。
    loaded.atlas.layers.forEach((ly, i) => {
      const tex = loaded.textures[i];
      if (!tex) return;
      const sp = new Sprite(tex);
      if (ly.name === 'floor') return;
      if (ly.name === 'bg') {
        // bg（原版 drawDisplay 抽成 Bitmap 挂 stage）：不受相机平移。
        // 原版 bg 恰好铺满 800×600 舞台；web 端可见逻辑区随窗口宽高比变化，
        // 在 updateCamera 里按 cover 铺满（居中裁边）。
        this.bgSize = { w: tex.width, h: tex.height };
        this.bgSprite = sp;
        this.bgFixed.addChild(sp);
        return;
      }
      // 图层 display 原点偏移 + 内容 bounds 偏移 + initlize 整体下移
      sp.position.set(ly.x + ly.bx, ly.y + ly.by + this.mapBottomOffset);
      if (ly.name === 'front_fix') this.mapFrontFixLayer.addChild(sp);
      else if (ly.name === 'front') {
        this.frontBaseX = sp.x;
        this.frontBaseY = sp.y;
        this.mapFrontLayer.addChild(sp);
      } else this.mapLayer.addChild(sp);
    });
  }

  private makeSprite(atlasId: string, loaded: LoadedFighterAtlas, formIndex: number): FighterSprite {
    const root = new Container();
    const body = new Sprite(Texture.WHITE);
    body.visible = false;
    root.addChild(body);
    this.fighterLayer.addChild(root);
    return { root, body, parts: [], atlasId, loaded, formIndex, appliedPng: -1, appliedFacing: 0 };
  }

  /** sim tick 后由 app 调：滚动快照窗口，消费表现事件。 */
  onSnapshot(snap: SimSnapshot): void {
    this.prev = this.next;
    this.next = snap;
    if (!this.prev) this.prev = snap;
    this.accMs = 0;
    this.consumeEvents(snap);
  }

  private consumeEvents(snap: SimSnapshot): void {
    // 残影自动清除（切片 47）：原版 FighterMcCtrler.doAction/idle/doHurt 统一
    // endShadow——渲染层近似 = 角色 actionState 变化即停（先清后消费事件，
    // 同拍「清 + 重开」顺序与原版一致）。辅助无 actionState，仅靠显式 endShadow。
    if (this.prev) {
      for (const f of snap.state.fighters) {
        const p = this.prev.state.fighters.find((x) => x.id === f.id);
        if (p && p.actionState !== f.actionState) {
          this.shadowStates.delete(`fighter:${f.id}`);
        }
      }
    }
    for (const ev of snap.events) {
      const key = `${ev.tick}:${ev.type}:${String(ev.payload['id'] ?? '')}`;
      const last = this.lastEventsTick.get(key);
      if (last === ev.tick) continue; // 去重
      this.lastEventsTick.set(key, ev.tick);
      if (ev.type === 'hit:connect') {
        // 命中火花三件套（修复批次 35，原版 doHitEffect/doDefenseEffect/
        // doSteelHitEffect 分流；hitstop 冻结在 core 已结算）：
        // 火花钉 hitRect∩身体区相交中心 + 受击者闪红 + HUD 连击计数
        this.spawnHitSpark(ev.payload);
        const attacker = ev.payload['attacker'];
        const target = ev.payload['target'];
        if (typeof attacker === 'number') this.hud?.onHit(attacker);
        const sp = typeof target === 'number' ? this.sprites.get(target) : undefined;
        if (sp) {
          sp.body.tint = 0xff4444;
          setTimeout(() => {
            sp.body.tint = 0xffffff;
          }, 90);
        }
      } else if (ev.type === 'fighter:form') {
        // 万解形态切换：切图集 forms 下标，强制重应用贴图。
        // 事件 form = sim 侧下标（过滤空根帧后的紧凑数组），图集 forms 是
        // 含空根帧的全数组——按 rootFrame 换算全数组下标（21F 修复差一位；
        // rootFrame 缺失时回退原下标行为，兼容旧事件源）。
        const fighter = ev.payload['fighter'];
        const form = ev.payload['form'];
        const rootFrame = ev.payload['rootFrame'];
        if (typeof fighter !== 'number' || typeof form !== 'number') continue;
        const sp = this.sprites.get(fighter);
        if (sp && sp.loaded) {
          let idx = form;
          if (typeof rootFrame === 'number') {
            const byRoot = sp.loaded.atlas.forms.findIndex(
              (f) => f.rootFrame === rootFrame,
            );
            if (byRoot >= 0) idx = byRoot;
          }
          if (idx !== sp.formIndex) {
            sp.formIndex = idx;
            sp.appliedPng = -1;
          }
        }
      } else if (ev.type === 'effect') {
        const id = String(ev.payload['id']);
        // 必杀/万解开场（切片 22/26）：黑幕/横幅/立绘显示由 SimState.cutinLock 驱动
        //（事件与锁同 tick 落快照）；end 系交给锁清除。原版 EffectCtrler.bisha/wanKai：
        // 光效 isSuper ? bisha_super : bisha，wanKai 恒 super；位置 (施法者.x, y-50)；
        // isSuper 分支 cameraFocusOne（聚焦 + zoom 3.5）。
        if (id === 'bisha' || id === 'wanKai') {
          const params = (ev.payload['params'] ?? {}) as Record<string, unknown>;
          const isSuper = id === 'wanKai' || params['isSuper'] === true;
          this.spawnMcEffect(
            isSuper ? 'bisha_super' : 'bisha',
            Number(ev.payload['x'] ?? 0),
            Number(ev.payload['y'] ?? 0) - 50,
          );
          if (isSuper) {
            const owner = ev.payload['owner'];
            const ownerKind = ev.payload['ownerKind'];
            if (typeof owner === 'number' && (ownerKind === 'fighter' || ownerKind === 'assister')) {
              this.camFocus = { kind: ownerKind, id: owner };
            }
          }
          if (this.bishaMc) this.beginCutin(snap, ev.payload, isSuper);
        } else if (id === 'shine') {
          // 全屏色闪（修复批次 40：招2_CHK 等时间轴 shine 触发此前被静默丢弃）。
          // 原版 FighterEffectCtrler.shine(color)：白=0.3 其余=0.2，EffectCtrler.shine
          // 加 ShineEffectView 全屏。params 两形态：fighter 时间轴 = 裸色值；
          // attacker 道具转发 = { arg }。缺省白。
          const raw = ev.payload['params'] as unknown;
          const arg =
            typeof raw === 'number'
              ? raw
              : raw !== null && typeof raw === 'object' && typeof (raw as Record<string, unknown>)['arg'] === 'number'
                ? ((raw as Record<string, unknown>)['arg'] as number)
                : undefined;
          const color = arg === undefined ? 0xffffff : arg;
          this.spawnShine(color >>> 0, color === 0xffffff ? 0.3 : 0.2);
        } else if (id === 'shake') {
          // 世界抖动（修复批次 44：击飞落地 shake 此前未消费）。params 两形态：
          // core 落地 = { x, y, time }（EffectCtrler 层值）；时间轴 shake = { arg }
          //（FighterEffectCtrler.shake 语义：pow=max(powX,powY)、恒竖向 ×2）。
          const p = (ev.payload['params'] ?? {}) as Record<string, unknown>;
          if (typeof p['y'] === 'number' || typeof p['x'] === 'number') {
            this.doShake(Number(p['x'] ?? 0), Number(p['y'] ?? 0), Number(p['time'] ?? 0));
          } else if (typeof p['arg'] === 'number') {
            this.doShake(0, p['arg'] * 2, 0);
          }
        } else if (id === 'shadow') {
          // 残影开始（切片 47，原版 FighterEffectCtrler.shadow → ShadowEffectView：
          // 每特效帧截图留影，r/g/b = ColorTransform 加色偏移）。owner 寻址 =
          // 角色/辅助精灵；激活态纯渲染层，不进 core。
          const p = (ev.payload['params'] ?? {}) as Record<string, unknown>;
          const owner = p['owner'];
          const kind = p['ownerKind'];
          if (typeof owner === 'number' && (kind === 'fighter' || kind === 'assister')) {
            this.shadowStates.set(`${kind}:${owner}`, {
              r: Number(p['r'] ?? 0),
              g: Number(p['g'] ?? 0),
              b: Number(p['b'] ?? 0),
            });
          }
        } else if (id === 'endShadow') {
          const p = (ev.payload['params'] ?? {}) as Record<string, unknown>;
          const owner = p['owner'];
          const kind = p['ownerKind'];
          if (typeof owner === 'number' && (kind === 'fighter' || kind === 'assister')) {
            this.shadowStates.delete(`${kind}:${owner}`);
          } else {
            this.shadowStates.clear(); // 无 owner 旧事件兜底：全停
          }
        } else {
          // 通用控制器特效（修复批次 44：jump/touchFloor 尘土 + hit_floor 落地尘土系
          // 此前未消费）。跳/落地尘土走火花管线（30fps 播尽自移除，规格随烘焙）。
          // 事件 id 'touchFloor' 归一化为烘焙 id 'touch_floor'（时间轴与物理落地
          // emit 同键，渲染层按 tick+id 去重防双播）。
          const sparkId = id === 'touchFloor' ? 'touch_floor' : id;
          if (this.hitspark?.effects[sparkId] && this.sparkTex.get(sparkId)) {
            const p = (ev.payload['params'] ?? {}) as Record<string, unknown>;
            // direct = 发射者朝向（切片 47：dash/dash_air 帧位镜像，原版
            // doEffectById(id, x, y, _target.direct)）
            const direct = p['direct'] === -1 ? -1 : 1;
            this.spawnSparkById(
              sparkId,
              Number(ev.payload['x'] ?? 0),
              Number(ev.payload['y'] ?? 0),
              direct,
            );
          }
        }
      }
      // sound/voice/hit:connect 等音频事件由 app 层 AudioSubsystem 消费（切片 27），render 不处理
    }
  }

  /** bisha/startWanKai 事件 → 演出状态（原版 showFace：faceId = 施法者在目标右侧 ? 2 : 1）。 */
  private beginCutin(snap: SimSnapshot, payload: Record<string, unknown>, isSuper: boolean): void {
    const params = (payload['params'] ?? {}) as Record<string, unknown>;
    const face = typeof params['face'] === 'string' ? params['face'] : null;
    const owner = params['owner'];
    const ownerKind = params['ownerKind'];
    // 施法者 x：角色 = fighters[id]；辅助 = assisters[id]
    let casterX: number | null = null;
    let atlasId: string | null = null;
    if (ownerKind === 'fighter' && typeof owner === 'number') {
      const f = snap.state.fighters.find((x) => x.id === owner);
      casterX = f?.x ?? null;
      atlasId = this.fighterAtlasById.get(owner) ?? null;
    } else if (ownerKind === 'assister' && typeof owner === 'number') {
      const a = snap.state.assisters.find((x) => x.id === owner);
      casterX = a?.x ?? null;
      atlasId = this.assisterAtlasByOwner.get(a?.ownerId ?? -1) ?? null;
    }
    if (casterX === null) return;
    // 目标 = 对面角色（双人对局 fighters[0/1]；辅助侧切人取对面角色位）
    const target = snap.state.fighters.find((f) => f.id !== owner) ?? snap.state.fighters[0];
    const slot: 1 | 2 = target && casterX > target.x ? 2 : 1;
    // 立绘同横幅守卫：仅主战（原版 target is FighterMain）
    const faceTex =
      ownerKind === 'fighter' && face && atlasId
        ? (this.bishaFaceTex.get(`${atlasId}:${face}`) ?? null)
        : null;
    // 横幅 y 联动（原版 showBishaFace：100 + 100/zoom，zoom = 演出开始时的相机目标因子）
    const mcPosY = 100 + 100 / this.zoomTarget;
    this.cutin = { active: true, faceName: face, faceTex, slot, mcPosY, accMs: 0, frame: 0 };
    const mcSx = this.cutinScaleX(this.bishaMc!);
    this.cutinBand.scale.set(mcSx, 1);
    this.cutinBand.position.set(
      this.bishaMc!.canvasOrigin[0] * mcSx,
      mcPosY + this.bishaMc!.canvasOrigin[1],
    );
  }

  /** 切人 mc 横向布局因子（批次 29）：横幅内容宽 = 1066 画布减去两侧对称透明出血
   *  |canvasOrigin.x| ≈ 798px，在原版恰好铺满 800×600 游戏区（原版 mc 挂
   *  scrollRect(0,0,800,600) 的 root、mc.x=0，BlackBackView 实测）。
   *  移植版可见逻辑区 = viewW/fitZoom（1000+，随纵横比），800 宽内容不可能盖满
   *  → 内容横向拉伸铺满 visW（速度线横幅，横向拉伸不可感知；与 bgFixed cover 同款
   *  适配），立绘槽位 wx 同比例外推，保持"贴 band 两端"的原版构图。 */
  private cutinScaleX(mc: BishaMcData): number {
    const visW = this.viewW / Math.min(this.viewW / LOGICAL_W, this.viewH / LOGICAL_H);
    return visW / Math.max(mc.canvasSize[0] + 2 * mc.canvasOrigin[0], 1);
  }

  /** mc 流帧特效（切片 26，原版 EffectView）：加色混合，30fps 播尽自移除；
   *  direct 恒 1（doEffectById 缺省参，XG_bs/XG_cbs 不镜像）。 */
  private spawnMcEffect(id: string, x: number, y: number): void {
    const spec = this.bishaEffects[id];
    const texs = this.effectTex.get(id);
    if (!spec || !texs || texs.length === 0) return;
    const root = new Container();
    const body = new Sprite(texs[0]);
    body.blendMode = 'add';
    root.addChild(body);
    root.position.set(x + spec.origin[0], y + spec.origin[1]);
    this.fxLayer.addChild(root);
    this.mcEffects.push({ root, body, texs, fps: spec.fps, accMs: 0, frame: 0 });
  }

  /** mc 特效帧推进（30fps）+ 播尽移除。 */
  private updateMcEffects(dtMs: number): void {
    for (const e of this.mcEffects) {
      e.accMs += dtMs;
      const f = Math.floor(e.accMs / (1000 / e.fps));
      if (f >= e.texs.length) continue;
      if (f !== e.frame) {
        e.frame = f;
        e.body.texture = e.texs[f]!;
      }
    }
    const done = this.mcEffects.filter((e) => Math.floor(e.accMs / (1000 / e.fps)) >= e.texs.length);
    for (const e of done) {
      this.fxLayer.removeChild(e.root);
      e.root.destroy({ children: true });
    }
    if (done.length > 0) this.mcEffects = this.mcEffects.filter((e) => !done.includes(e));
  }

  /**
   * 命中火花（修复批次 35，镜像原版 EffectCtrler 分流；随机项全部在渲染层，
   * 不触碰 sim 确定性）：钢身族随机择一 → 破防横抖 → 防御竖抖 → 普通命中。
   * 原版 quirk 保留：命中系 VO 的 shake{pow:6} 是 doEffectVO 死代码（只读
   * shake.x/y），命中火花不抖；仅防御（pow→y）与破防（x）抖。
   */
  private spawnHitSpark(p: Record<string, unknown>): void {
    const hk = this.hitspark;
    if (!hk) return;
    const sparkType = Number(p['sparkType'] ?? p['hitType'] ?? 0);
    const x = Number(p['x'] ?? 0);
    const y = Number(p['y'] ?? 0);
    const direct = Number(p['direct'] ?? 1) >= 0 ? 1 : -1;
    let id: string | null = null;
    let shake: { x?: number; y?: number; time?: number } | null = null;
    if (p['steel'] === true) {
      // 钢身族（doSteelHitEffect：KAN/KAN_HEAVY→kan、DA/DA_HEAVY→qdj、其余→mfdj；
      // 族内随机择一，hitType 0 无钢身特效）
      const fam =
        sparkType === 1 || sparkType === 6
          ? 'kan'
          : sparkType === 2 || sparkType === 3
            ? 'qdj'
            : 'mfdj';
      const list = hk.steel[fam] ?? [];
      id = sparkType !== 0 && list.length > 0 ? list[Math.floor(Math.random() * list.length)]! : null;
    } else if (p['breakDef'] === true) {
      id = hk.breakDef.id;
      shake = hk.breakDef.shake;
    } else if (p['blocked'] === true) {
      // 防御表回退 defense_5（原版 getDefenseEffect 缺表项；core freeze 表同源）
      id = hk.defense.byType[String(sparkType)] ?? hk.defense.fallback;
      if (id) shake = { y: hk.shake.defense.pow, time: hk.shake.defense.time };
    } else {
      // 普通命中表：type 0/10 无表项 = 无特效不抖（原版 getHitEffect 无回退）
      id = hk.hit.byType[String(sparkType)] ?? null;
    }
    const eff = id !== null ? hk.effects[id] : null;
    if (!id || !eff) return;
    this.spawnSparkById(id, x, y, direct);
    if (eff.shine) this.spawnShine(eff.shine.color, eff.shine.alpha);
    if (shake) this.doShake(shake.x ?? 0, shake.y ?? 0, shake.time ?? 0);
  }

  /** 按烘焙 id 生成火花/尘土特效（命中分流与通用控制器特效共用管线）。 */
  private spawnSparkById(id: string, x: number, y: number, direct: 1 | -1 = 1): void {
    const eff = this.hitspark?.effects[id];
    if (!eff) return;
    const texs = this.sparkTex.get(id);
    if (!texs || texs.length === 0) return;
    const root = new Container();
    const body = new Sprite(texs[0]!);
    if (eff.blendMode === 'add') body.blendMode = 'add';
    else if (eff.blendMode === 'hardlight') body.blendMode = 'hard-light';
    else if (eff.blendMode === 'lighten') body.blendMode = 'lighten';
    root.addChild(body);
    // EffectView.start（切片 47 对齐原语义）：MC 原点钉命中点；非旋转件
    // display.scaleX = direct、display.x = orgX + offsetX×direct——父容器镜像
    // 自动翻转子位偏移（offset×direct 数学等价），randRotate 件 direct 恒 1。
    root.position.set(x, y);
    body.position.set(eff.origin[0], eff.origin[1]);
    if (eff.randRotate) root.rotation = Math.random() * Math.PI * 2;
    else root.scale.x = direct;
    this.fxLayer.addChild(root);
    this.sparkFx.push({ root, body, texs, accMs: 0, frame: 0 });
  }

  /** 火花帧推进（30fps 播尽自移除，同 mc 流帧管线）。 */
  private updateSparkFx(dtMs: number): void {
    for (const e of this.sparkFx) {
      e.accMs += dtMs;
      const f = Math.floor(e.accMs / (1000 / 30));
      if (f < e.texs.length && f !== e.frame) {
        e.frame = f;
        e.body.texture = e.texs[f]!;
      }
    }
    const done = this.sparkFx.filter((e) => Math.floor(e.accMs / (1000 / 30)) >= e.texs.length);
    for (const e of done) {
      this.fxLayer.removeChild(e.root);
      e.root.destroy({ children: true });
    }
    if (done.length > 0) this.sparkFx = this.sparkFx.filter((e) => !done.includes(e));
  }

  /**
   * 残影步进（切片 47，原版 ShadowEffectView.render 30Hz）：
   *   - 拍照：每 2 个特效帧拍一帧（_addBpGap=1 → addBpFrame++ > 1），快照 = 角色
   *     精灵当前帧（body 贴图 + 帧位 + 朝向缩放；blendMode 子层 parts 不拍——
   *     残影语料均为本体动作，近似成立）；
   *   - 衰减：每步 alpha −0.1（_alphaLose），起步 0.8（_alphaStart）→ 存活 8 步
   *     ≈ 267ms，与原版同步；≤0 移除。
   * 加色偏移（ColorTransform redOffset/greenOffset/blueOffset）用 ColorMatrixFilter
   * 第 5 列加法近似，同色共享一个滤镜实例。
   */
  private updateShadows(dtMs: number, next: SimSnapshot): void {
    this.shadowAccMs += dtMs;
    const steps = Math.min(Math.floor(this.shadowAccMs / (1000 / 30)), 4);
    if (steps <= 0) return;
    this.shadowAccMs -= steps * (1000 / 30);
    this.shadowStep += steps;
    // 衰减存量残影
    const dead: number[] = [];
    for (let i = this.shadowGhosts.length - 1; i >= 0; i--) {
      const gh = this.shadowGhosts[i]!;
      gh.alpha -= 0.1 * steps;
      gh.root.alpha = Math.max(gh.alpha, 0);
      if (gh.alpha <= 0) dead.push(i);
    }
    for (const i of dead) {
      const gh = this.shadowGhosts[i]!;
      this.shadowLayer.removeChild(gh.root);
      gh.root.destroy({ children: true });
    }
    if (dead.length > 0) this.shadowGhosts = this.shadowGhosts.filter((_, i) => !dead.includes(i));
    // 拍照（每 2 特效帧）
    if (this.shadowStep % 2 === 0) {
      for (const [key, st] of this.shadowStates) {
        const sp = this.shadowTargetOf(key, next);
        if (!sp || !sp.root.visible || !sp.body.visible) continue;
        const root = new Container();
        const body = new Sprite(sp.body.texture);
        body.position.set(sp.body.x, sp.body.y);
        root.addChild(body);
        root.position.set(sp.root.x, sp.root.y);
        root.scale.set(sp.root.scale.x, sp.root.scale.y);
        root.alpha = 0.8;
        const filter = this.shadowFilterOf(st);
        if (filter) {
          root.filters = [filter];
          filter.enabled = true;
        }
        this.shadowLayer.addChild(root);
        this.shadowGhosts.push({ root, alpha: 0.8 });
        // 拍照卡上限（原版存活 ~4 张；卡帧堆积防御）
        while (this.shadowGhosts.length > 24) {
          const old = this.shadowGhosts.shift()!;
          this.shadowLayer.removeChild(old.root);
          old.root.destroy({ children: true });
        }
      }
    }
    // 辅助退场清理（快照缺席即停残影）
    for (const key of this.shadowStates.keys()) {
      if (key.startsWith('assister:') && !this.shadowTargetOf(key, next)) {
        this.shadowStates.delete(key);
      }
    }
  }

  /** 残影 key → 目标精灵（fighter:<id> / assister:<assisterId>）。 */
  private shadowTargetOf(key: string, next: SimSnapshot): FighterSprite | null {
    const colon = key.indexOf(':');
    const kind = key.slice(0, colon);
    const id = Number(key.slice(colon + 1));
    if (kind === 'fighter') return this.sprites.get(id) ?? null;
    const a = next.state.assisters.find((x) => x.id === id);
    return a ? (this.assistSprites.get(a.ownerId) ?? null) : null;
  }

  /** 加色偏移滤镜（ColorTransform redOffset 系 → ColorMatrixFilter 第 5 列）。 */
  private shadowFilterOf(st: { r: number; g: number; b: number }): ColorMatrixFilter | null {
    if (st.r === 0 && st.g === 0 && st.b === 0) return null;
    const key = `${st.r},${st.g},${st.b}`;
    let f = this.shadowFilters.get(key);
    if (!f) {
      f = new ColorMatrixFilter();
      // pixi v8 matrix getter 返回内部数组，原地改第 5 列（加色偏移）
      const m = f.matrix;
      m[4] = st.r / 255;
      m[9] = st.g / 255;
      m[14] = st.b / 255;
      this.shadowFilters.set(key, f);
    }
    return f;
  }

  /** 全屏闪（原版 shine(color, alpha) → ShineEffectView：亮色 ADD / 暗色 DARKEN
   *  且 alpha×0.8，色块覆盖 gameStage）。 */
  private spawnShine(color: number, alpha: number): void {
    const sp = new Sprite(Texture.WHITE);
    sp.width = this.viewW;
    sp.height = this.viewH;
    sp.tint = color;
    if (color > 0x7fffff) {
      sp.blendMode = 'add';
    } else {
      sp.blendMode = 'darken';
      alpha *= 0.8;
    }
    sp.alpha = alpha;
    this.shineLayer.addChild(sp);
    this.shines.push({ sp, alpha, accMs: 0 });
  }

  /** 闪衰减（原版 ShineEffectView：FPS_GAME 60 / FPS_SHINE 15 → renderGap=3，
   *  每步线性 _loseAlpha=renderGap+1=0.04（100 刻度），alpha ≤0.05 移除，约 0.46s 淡出）。
   *  修正（2026-11-19）：此前误用 ×0.95 指数衰减（约 2.5s 淡出）——亮屏滞留远超原版。 */
  private updateShines(dtMs: number): void {
    const STEP_MS = 1000 / 15;
    for (const s of this.shines) {
      s.accMs += dtMs;
      while (s.accMs >= STEP_MS) {
        s.accMs -= STEP_MS;
        s.alpha -= 0.04;
      }
      s.sp.alpha = Math.max(s.alpha, 0);
    }
    const done = this.shines.filter((s) => s.alpha <= 0.05);
    for (const s of done) {
      this.shineLayer.removeChild(s.sp);
      s.sp.destroy();
    }
    if (done.length > 0) this.shines = this.shines.filter((s) => !done.includes(s));
  }

  /** 抖动发起（原版 EffectCtrler.shake：pow 累加（已有则 +|pow|/2）、
   *  lose = ceil(pow / (time/1000×30)) 下限 1——30fps 内线性衰减到 0）。 */
  private doShake(powX: number, powY: number, time: number): void {
    const s = this.shakeSt;
    if (powX !== 0) {
      if (s.powX === 0) {
        s.dxX = powX > 0 ? 1 : -1;
        s.powX = Math.abs(powX);
      } else {
        s.powX += Math.abs(powX) / 2;
      }
    }
    if (powY !== 0) {
      if (s.powY === 0) {
        s.dxY = powY > 0 ? 1 : -1;
        s.powY = Math.abs(powY);
      } else {
        s.powY += Math.abs(powY) / 2;
      }
    }
    if (time <= 0) time = 500;
    s.loseX = Math.max(1, Math.ceil(s.powX / ((time / 1000) * 30)));
    s.loseY = Math.max(1, Math.ceil(s.powY / ((time / 1000) * 30)));
  }

  /**
   * 抖动步进（镜像 EffectCtrler.renderShakeX/Y：30fps 帧；每帧 offset = (hold+pow)
   * ×direct、direct 逐帧翻转；pow 每 2 帧衰减 lose，衰减尽复位 offset 0。
   * X 轴先 frameX++ 后翻转，Y 轴先翻转后 frameY++（原版两函数的语序差）。
   */
  private advanceShake(dtMs: number): void {
    this.shakeAccMs += dtMs;
    while (this.shakeAccMs >= 1000 / 30) {
      this.shakeAccMs -= 1000 / 30;
      const s = this.shakeSt;
      const shakeX = s.holdX + s.powX;
      if (shakeX > 0) {
        this.shakeOffX = shakeX * s.dxX;
        let ended = false;
        if (s.powX > 0 && s.frameX % 2 === 0) {
          s.powX -= s.loseX;
          if (s.powX < s.loseX) {
            s.powX = 0;
            this.shakeOffX = 0;
            s.frameX = 0;
            s.loseX = 0;
            ended = true;
          }
        }
        if (!ended) {
          s.frameX++;
          s.dxX *= -1;
        }
      } else {
        this.shakeOffX = 0;
      }
      const shakeY = s.holdY + s.powY;
      if (shakeY > 0) {
        this.shakeOffY = shakeY * s.dxY;
        let ended = false;
        if (s.powY > 0 && s.frameY % 2 === 0) {
          s.powY -= s.loseY;
          if (s.powY < s.loseY) {
            s.powY = 0;
            this.shakeOffY = 0;
            s.frameY = 0;
            s.loseY = 0;
            ended = true;
          }
        }
        if (!ended) {
          s.dxY *= -1;
          s.frameY++;
        }
      } else {
        this.shakeOffY = 0;
      }
    }
  }

  /**
   * 切人演出帧推进（切片 22，原版 BlackBackView/BishaFaceEffectView 语义）：
   *   - 黑幕：SimState.cutinLock ≠ null 期间全屏覆盖（屏幕空间）；
   *   - 地图：原版 getMap().setVisible(false) → map/front 层隐藏；
   *   - 横幅+立绘：bisha_face_mc gotoAndPlay(2)（0-based 帧 1 起，30fps），
   *     播到 destory（全透明）/stop（空帧）自然消失；黑幕保持到 endBisha 解锁
     *     （语料缺 end 系时 = 黑幕挂到保护性解锁，原版为软锁，web 端有解锁兜底）。
   */
  private updateCutin(next: SimSnapshot, dtMs: number): void {
    const lock = next.state.cutinLock;
    const mc = this.bishaMc;
    const cutinActive = lock !== null && mc !== null;
    this.blackLayer.visible = cutinActive;
    if (cutinActive) {
      // 黑幕盖满当前视口（屏幕空间；resize 后重画）
      if (this.blackW !== this.viewW || this.blackH !== this.viewH) {
        this.blackW = this.viewW;
        this.blackH = this.viewH;
        this.blackLayer.clear().rect(0, 0, this.viewW, this.viewH).fill(0x000000);
      }
    }
    // 相机聚焦收场（原版 endBisha/endWanKai → cameraResume：双焦点 + autoZoom 接管）
    if (lock === null) this.camFocus = null;
    // 地图隐藏（原版 getMap().setVisible(false)；front 系同属地图视觉层）
    this.mapLayer.visible = lock === null;
    this.mapFrontFixLayer.visible = lock === null;
    this.mapFrontLayer.visible = lock === null;
    // 横幅/立绘 = 屏幕空间（scale = fitZoom：800×600 舞台规格 → 视口像素，
    // 不随相机平移/缩放——切片 26 移出 world）
    this.cutinScreen.visible = cutinActive;
    this.cutinScreen.scale.set(Math.min(this.viewW / LOGICAL_W, this.viewH / LOGICAL_H));
    this.cutinLayer.visible = cutinActive;
    if (!cutinActive) {
      // 解锁（endBisha/endWanKai/保护性解锁）：演出收场，等待下次事件
      this.cutin.active = false;
      return;
    }
    // 锁存在但无演出信息（如联机中途入局错过事件）：只显示黑幕（+主战横幅）
    if (!this.cutin.active) {
      this.cutin = {
        active: true,
        faceName: null,
        faceTex: null,
        slot: 1,
        mcPosY: 100 + 100 / this.zoomTarget,
        accMs: 0,
        frame: 0,
      };
      const mcSx = this.cutinScaleX(mc);
      this.cutinBand.scale.set(mcSx, 1);
      this.cutinBand.position.set(
        mc.canvasOrigin[0] * mcSx,
        this.cutin.mcPosY + mc.canvasOrigin[1],
      );
    }
    const c = this.cutin;
    c.accMs += dtMs;
    c.frame = Math.min(1 + Math.floor(c.accMs / (1000 / mc.fps)), mc.frames - 1);
    // 横幅流帧（0-based 帧 f ↔ 文件 f+1；帧 0 为 gotoAndPlay(2) 前的白屏态，不显示）。
    // 横幅/立绘仅主战（修复批次 42：原版 EffectCtrler.bisha 的
    // `face && target is FighterMain` 守卫——showFace→showBishaFace（蓝条）只对
    // FighterMain 调用；辅助施放 bisha 只有黑幕+位置光效，辅助侧此前误挂横幅）
    const bandTex = lock.kind === 'fighter' ? this.bishaBandTex[c.frame] : undefined;
    if (bandTex) {
      this.cutinBand.visible = true;
      this.cutinBand.texture = bandTex;
    } else this.cutinBand.visible = false;
    // 立绘槽位（原版 showFace 把 254×180 face 加进 facemc{slot}）
    const slotArr = mc.slots[`facemc${c.slot}`];
    const s = slotArr?.[c.frame] ?? null;
    const tex = c.faceTex;
    if (!s || !tex) {
      this.cutinFace.visible = false;
      this.cutinFaceFlash.visible = false;
      return;
    }
    // 锚 = transformationPoint（缩放绕点）；槽位 wx/wy 即 mc 空间的 W_T →
    // 屏幕位 x = wx × 内容拉伸因子（band 铺满 visW，槽位同比例外推保持贴端构图）、
    // y = mcPosY + wy。canvasOrigin 只用于 band PNG 定位，不参与立绘定位
    //（多减一次 = 整体右偏 134/下偏 12，槽 2 被推出屏右缘——批次 29 修复）
    const [wx = 0, wy = 0, sx = 1, sy = 1, ro = 0, go = 0, bo = 0, al = 1] = s;
    const mcSx = this.cutinScaleX(mc);
    this.cutinFace.visible = true;
    this.cutinFace.texture = tex;
    this.cutinFace.anchor.set(mc.faceAnchor[0] / mc.faceSize[0], mc.faceAnchor[1] / mc.faceSize[1]);
    this.cutinFace.position.set(wx * mcSx, c.mcPosY + wy);
    this.cutinFace.scale.set((sx * mc.faceSize[0]) / tex.width, (sy * mc.faceSize[1]) / tex.height);
    this.cutinFace.alpha = al;
    // 白闪近似：原版 color offset (255→50→0) = 加色白化 → 白 tint 同变换叠加
    const flash = Math.max(ro, go, bo);
    this.cutinFaceFlash.visible = flash > 0 && al > 0;
    if (this.cutinFaceFlash.visible) {
      this.cutinFaceFlash.texture = tex;
      this.cutinFaceFlash.anchor.set(this.cutinFace.anchor.x, this.cutinFace.anchor.y);
      this.cutinFaceFlash.position.copyFrom(this.cutinFace.position);
      this.cutinFaceFlash.scale.copyFrom(this.cutinFace.scale);
      this.cutinFaceFlash.alpha = Math.min(flash / 255, 1) * al;
    }
  }

  /** 黑幕重画缓存（视口尺寸变化才重建） */
  private blackW = 0;
  private blackH = 0;

  /**
   * 开局特写相机（intro 切片，原版 GameStartCtrler.preRenderStart/
   * renderStart1v1 的 cameraFocusOne）：step 0-2 聚焦 P1、3-5 聚焦 P2
   * （zoom 3.5 与必杀特写同款），step ≥6（resume/字样段）双焦点 autoZoom
   * 接管。每帧重设（updateCutin 在无锁时清 camFocus，intro 需随后覆写）。
   */
  private updateIntro(next: SimSnapshot): void {
    const intro = next.state.intro;
    if (intro == null || intro.step >= 6) return;
    const target = intro.step < 3 ? next.state.fighters[0] : next.state.fighters[1];
    if (target) this.camFocus = { kind: 'fighter', id: target.id };
  }

  /**
   * 回合结束特写（终局演出收编，原版 FightUI.playKO cameraFocusOne(loser) /
   * renderEnd cameraFocusOne(winner)，zoom 3.5 同款）：winApplied 前聚焦败方
   * （KO 飞尸特写），之后聚焦胜方（WIN 姿势特写）；over 定格保持。
   * 平局不聚焦（原版 playKO(null) 无 focusOne）。每帧重设（updateCutin 在无锁
   * 时清 camFocus，本方法随后覆写；updateIntro 优先）。
   */
  private updateRoundEnd(next: SimSnapshot): void {
    const re = next.state.roundEnd;
    if (re == null || re.draw || re.winnerId < 0) return;
    this.camFocus = { kind: 'fighter', id: re.winApplied ? re.winnerId : re.loserId };
  }

  /** 每渲染帧调用：插值推进。dtMs 自上次调用以来的毫秒数。 */
  update(dtMs: number): void {
    if (!this.next) return;
    this.accMs = Math.min(this.accMs + dtMs, TICK_MS);
    const alpha = this.accMs / TICK_MS;
    const prev = this.prev!;
    const next = this.next;

    // —— 战斗体：位置插值，朝向/动画帧取最新 ——
    const activeIds = new Set(next.state.fighters.map((f) => f.id));
    for (const f of next.state.fighters) {
      const sp = this.sprites.get(f.id);
      if (!sp) continue;
      const p = prev.state.fighters.find((x) => x.id === f.id) ?? f;
      const ix = p.x + (f.x - p.x) * alpha;
      const iy = p.y + (f.y - p.y) * alpha;

      sp.root.visible = true;
      sp.root.position.set(ix, iy);
      if (sp.appliedFacing !== f.facing) {
        sp.root.scale.x = f.facing;
        sp.appliedFacing = f.facing;
      }
      // 内层帧 = 最新快照
      this.applyFrame(sp, f.actLabel !== null ? f.animFrame : 0);
    }
    // 团队 bench（切片 36）：快照缺席的角色精灵隐藏（换人入场后复显——
    // roster 全员预载、id 定精灵，入场即换无需重绑图集）
    for (const [id, sp] of this.sprites) {
      if (!activeIds.has(id) && sp.root.visible) {
        sp.root.visible = false;
        sp.appliedPng = -1;
      }
    }

    this.updateAttackers(prev, next, alpha);
    this.updateBullets(prev, next, alpha);
    this.updateAssisters(prev, next, alpha);
    this.updateMcEffects(dtMs);
    this.updateShadows(dtMs, next);
    this.updateSparkFx(dtMs);
    this.updateShines(dtMs);
    this.updateCutin(next, dtMs);
    this.updateIntro(next);
    this.updateRoundEnd(next);
    this.updateCamera(next, dtMs);
    // 世界抖动（原版 gameStage.x/y 整体位移）：叠加在相机变换之后（world+bgFixed）
    this.advanceShake(dtMs);
    if (this.shakeOffX !== 0 || this.shakeOffY !== 0) {
      this.world.x += this.shakeOffX;
      this.world.y += this.shakeOffY;
      this.bgFixed.x += this.shakeOffX;
      this.bgFixed.y += this.shakeOffY;
    }
    // HUD（切片 30）：屏幕空间钉扎重摆 + 快照驱动（血/气/能量/辅助格/连击）
    const fitZoom = Math.min(this.viewW / LOGICAL_W, this.viewH / LOGICAL_H);
    if (this.hud) {
      this.hud.layout(this.viewW, this.viewH, fitZoom);
      this.hud.update(next, dtMs);
    }
  }

  /** 辅助实体（切片 12）：位置插值 + 时间轴帧，退场隐藏。 */
  private updateAssisters(
    prev: SimSnapshot,
    next: SimSnapshot,
    alpha: number,
  ): void {
    for (const [ownerId, sp] of this.assistSprites) {
      const a = next.state.assisters.find((x) => x.ownerId === ownerId);
      if (!a) {
        sp.root.visible = false;
        sp.appliedPng = -1;
        continue;
      }
      sp.root.visible = true;
      const p = prev.state.assisters.find((x) => x.ownerId === ownerId) ?? a;
      const ix = p.x + (a.x - p.x) * alpha;
      const iy = p.y + (a.y - p.y) * alpha;
      sp.root.position.set(ix, iy);
      if (sp.appliedFacing !== a.facing) {
        sp.root.scale.x = a.facing;
        sp.appliedFacing = a.facing;
      }
      // 辅助是 free-running 根时间轴：直接按 animFrame 取帧（actLabel 仅是
      // 标签跳转记忆，出生时为 null 不代表无画面）
      this.applyFrame(sp, a.animFrame);
    }
  }

  /**
   * 独立道具（切片 13-A4；B5 原点锚定）：fire 元件精灵静态首帧渲染。
   *
   * attacker 无自身时间轴推进（寿命/命中矩形见 AttackerState 注），故只画
   * frames[0]。B5 起 core x/y = 元件原点世界坐标：精灵容器直接锚原点 +
   * scale.x 翻转（同角色 root 模式）；回退色块画 fbHit 矩形（沿朝向镜像
   * 平移到原点，同 core attackerLocalRect 约定）；缺图集条目或首帧缺纹理
   * 回退命中矩形色块（纯表现实体 hit=null 用青绿色区分）。
   */
  private updateAttackers(
    prev: SimSnapshot,
    next: SimSnapshot,
    alpha: number,
  ): void {
    const g = this.attackerGfx;
    g.clear();
    for (const a of next.state.attackers) {
      const p = prev.state.attackers.find((x) => x.id === a.id) ?? a;
      const ix = p.x + (a.x - p.x) * alpha;
      const iy = p.y + (a.y - p.y) * alpha;
      // viaAssist：owner 是辅助——图集走辅助侧 fire 包（同 bullet 分支）
      const loaded = a.viaAssist
        ? this.fireLoadedAssister.get(this.assistSprites.get(a.ownerId)?.atlasId ?? '')
        : this.fireLoadedFighter.get(this.sprites.get(a.ownerId)?.atlasId ?? '');
      const el = loaded?.atlas.fires[a.name];
      // 只要求图集条目存在（首帧可为空：atmc 等元件第 1 帧留空淡入，
      // png=-1 帧由 applyFireFrame 逐帧隐藏——按首帧判空会误回退色块）
      if (!loaded || !el || el.frames.length === 0) {
        // 回退色块：fbHit 沿朝向镜像平移到原点（facing=-1 时 x 轴翻转）
        const rx = ix + (a.facing === 1 ? a.fbHit.x : -a.fbHit.x - a.fbHit.w);
        const ry = iy + a.fbHit.y;
        this.drawPropBlock(
          g,
          a.facing,
          a.fbHit.w,
          a.fbHit.h,
          a.hit?.hitType ?? null,
          rx,
          ry,
        );
        continue;
      }
      let sp = this.attackerSprites.get(a.id);
      if (!sp) {
        const root = new Container();
        const body = new Sprite(Texture.WHITE);
        body.visible = false;
        root.addChild(body);
        this.bulletLayer.addChild(root);
        sp = { root, body, appliedFrame: -1 };
        this.attackerSprites.set(a.id, sp);
      }
      // B5 原点锚：容器 = 元件原点，子帧内容由图集 rel（相对原点）承载
      sp.root.position.set(ix, iy);
      sp.root.scale.x = a.facing;
      // 内层时间轴动画帧（animTotal=0 无时间轴时回退首帧；切片 13-A5）
      this.applyFireFrame(sp, loaded, a.name, a.animTotal > 0 ? a.animFrame : 1);
    }
    // despawn 收尾：快照缺席即移除（寿命到期/命中失效统一走这里）
    for (const [id, sp] of this.attackerSprites) {
      if (!next.state.attackers.some((x) => x.id === id)) {
        this.bulletLayer.removeChild(sp.root);
        sp.root.destroy({ children: true });
        this.attackerSprites.delete(id);
      }
    }
  }

  /**
   * 飞行道具（切片 13-A3）：fire 元件精灵按自身时间轴帧渲染；无图集条目
   * （animTotal=0 / 元件缺采 / 该侧图集未装）回退命中矩形色块。
   *
   * 元件原点锚 = RectUtils.apply 逆运算（rel = main 子对象 bounds 相对元件
   * 原点，direct=1 空间）：mcX = direct>0 ? rect.x - rel.x : rect.x + rel.x
   * + rel.w；mcY = rect.y - rel.y。main 缺失（0 矩形）时退化为矩形左上角。
   * 翻转用容器 scale.x = facing（同角色 root 模式）；帧取最新快照不插值。
   */
  private updateBullets(
    prev: SimSnapshot,
    next: SimSnapshot,
    alpha: number,
  ): void {
    const g = this.bulletGfx;
    g.clear();
    for (const b of next.state.bullets) {
      const p = prev.state.bullets.find((x) => x.id === b.id) ?? b;
      const ix = p.x + (b.x - p.x) * alpha;
      const iy = p.y + (b.y - p.y) * alpha;
      const loaded = b.viaAssist
        ? this.fireLoadedAssister.get(this.assistSprites.get(b.ownerId)?.atlasId ?? '')
        : this.fireLoadedFighter.get(this.sprites.get(b.ownerId)?.atlasId ?? '');
      const el = loaded?.atlas.fires[b.name];
      if (!loaded || !el || b.animTotal <= 0) {
        this.drawPropBlock(g, b.facing, b.w, b.h, b.hit.hitType, ix, iy);
        continue;
      }
      let sp = this.bulletSprites.get(b.id);
      if (!sp) {
        const root = new Container();
        const body = new Sprite(Texture.WHITE);
        body.visible = false;
        root.addChild(body);
        this.bulletLayer.addChild(root);
        sp = { root, body, appliedFrame: -1 };
        this.bulletSprites.set(b.id, sp);
      }
      const rel = el.main;
      sp.root.position.set(b.facing === 1 ? ix - rel.x : ix + rel.x + rel.w, iy - rel.y);
      sp.root.scale.x = b.facing;
      this.applyFireFrame(sp, loaded, b.name, b.animFrame);
    }
    // despawn 收尾：快照缺席即移除（残留段播尽/寿命到期/出界统一走这里）
    for (const [id, sp] of this.bulletSprites) {
      if (!next.state.bullets.some((x) => x.id === id)) {
        this.bulletLayer.removeChild(sp.root);
        sp.root.destroy({ children: true });
        this.bulletSprites.delete(id);
      }
    }
  }

  /** 色块回退（bullet 切片 8 / attacker 切片 13-A4 占位表现）：命中矩形 + 朝向尖端。 */
  private drawPropBlock(
    g: Graphics,
    facing: 1 | -1,
    w: number,
    h: number,
    hitType: number | null,
    ix: number,
    iy: number,
  ): void {
    // 颜色按 hitType 粗分（1-3 近战系红 / 4-6 魔法系紫 / 7-10 属性系橙 / 摔白；
    // null = 纯表现实体，青绿色）
    const color =
      hitType === null
        ? 0x44ddaa
        : hitType <= 3
          ? 0xff5544
          : hitType <= 6
            ? 0xcc66ff
            : hitType <= 10
              ? 0xffaa33
              : 0xffffff;
    g.rect(ix, iy, w, h).fill({ color, alpha: 0.85 });
    // 尖端：朝 facing 方向的小三角指示
    const tipX = facing === 1 ? ix + w : ix;
    g.moveTo(tipX, iy + h / 2 - 5).lineTo(tipX + facing * 8, iy + h / 2).lineTo(tipX, iy + h / 2 + 5).fill({ color, alpha: 0.85 });
  }

  /** 应用 fire 元件帧：查图集 fires[name].frames[animFrame-1]。 */
  private applyFireFrame(
    sp: BulletSprite,
    loaded: LoadedFireAtlas,
    name: string,
    animFrame: number,
  ): void {
    if (sp.appliedFrame === animFrame) return;
    sp.appliedFrame = animFrame;
    const frame = loaded.atlas.fires[name]?.frames[animFrame - 1];
    if (!frame || frame.png < 0) {
      sp.body.visible = false;
      return;
    }
    const tex = frameTexture(loaded, frame.png);
    if (!tex) {
      sp.body.visible = false;
      return;
    }
    sp.body.visible = true;
    sp.body.texture = tex;
    // frame.x/y = 内容相对元件原点偏移（容器已按 facing 镜像）
    sp.body.position.set(frame.x ?? 0, frame.y ?? 0);
  }

  /** 应用内层动画帧：查图集 form.frames[animFrame-1]。 */
  private applyFrame(sp: FighterSprite, animFrame: number): void {
    if (!sp.loaded) return;
    if (sp.appliedPng === animFrame) return;
    sp.appliedPng = animFrame;
    if (animFrame <= 0) {
      sp.body.visible = false;
      this.hideParts(sp);
      return;
    }
    const form = sp.loaded.atlas.forms[sp.formIndex];
    const frame = form?.frames[animFrame - 1];
    if (!frame || frame.png < 0) {
      sp.body.visible = false;
      this.hideParts(sp);
      if (!frame || !frame.parts?.length) return;
    } else {
      const tex = frameTexture(sp.loaded, frame.png);
      if (!tex) {
        sp.body.visible = false;
        this.hideParts(sp);
        return;
      }
      sp.body.visible = true;
      sp.body.texture = tex;
      // frame.x/y = 内容相对 root 原点偏移（root 原点 = 角色坐标，翻转绕原点）
      sp.body.position.set(frame.x ?? 0, frame.y ?? 0);
    }
    // 混合模式子层（批次 37）：采集桥把顶层 blendMode 元件拆出整帧合成，
    // 此处对场景做对应混合（原版 Flash：子对象混合对"真实场景底"生效——
    // darken 白闪白区透出场景、screen 黑幕黑区透出场景）。png 保存的是
    // "混合前源内容"（透明底采集 = 源不变）。绘制次序在 base 之后（原版
    // blend 元件均为顶层特效，z 序近似成立）。
    const parts = frame.parts;
    if (!parts || parts.length === 0) {
      this.hideParts(sp);
      return;
    }
    while (sp.parts.length < parts.length) {
      const s = new Sprite(Texture.WHITE);
      s.visible = false;
      sp.root.addChild(s);
      sp.parts.push(s);
    }
    for (let i = 0; i < sp.parts.length; i++) {
      const s = sp.parts[i]!;
      const part = parts[i];
      if (!part || part.png < 0) {
        s.visible = false;
        continue;
      }
      const ptex = frameTexture(sp.loaded, part.png);
      if (!ptex) {
        s.visible = false;
        continue;
      }
      s.visible = true;
      s.texture = ptex;
      s.position.set(part.x ?? 0, part.y ?? 0);
      s.blendMode = pixiBlendMode(part.blend);
    }
  }

  private hideParts(sp: FighterSprite): void {
    for (const s of sp.parts) s.visible = false;
  }

  /**
   * 相机（切片 26 对齐原版 GameCamera；批次 23 追补 autoZoom 视口基准）：
   *   - 双焦点（常态）：中心 = 双方中点；自适应缩放 = 原版 renderTwo autoZoom
   *     `zoom = min(screenW/distX, screenH/distY)×0.8` clamp [1, 2.5]
   *     （autoZoomMin/Max = initCamera 真值）——双方拉开拉远镜头、贴身推近。
   *     视口基准 = 原版 `_screenSize` = GAME_SIZE **800×600 常量**（批次 23 追补：
   *     此前误用实际可见区 viewW/fitZoom——宽屏下 1066 使 zx 偏大 → zoom 偏大、
   *     贴身推近过狠；渲染可见区仍随纵横比铺满，仅 zoom 数值节奏对齐原版）；
   *   - 单焦点（super 必杀/万解，原版 cameraFocusOne）：聚焦施法者 + zoom 3.5
   *     （autoZoom 仅双焦点生效），cutinLock 清除由 updateCutin 恢复双焦点；
   *   - 缓动 = 原版 ease：逐帧 delta/5（tweenSpd = CAMERA_TWEEN_SPD/SPEED_PLUS_DEFAULT
   *     = 5），位置 snap 0.5 世界 px、缩放 snap 0.5/800；按 dt 折算帧衰减；
   *   - clamp 保持批次 17 语义：平滑值按当前有效 zoom 夹取（原版夹目标值，
   *     此处防缩放过渡期越界露底，保守偏离）。
   */
  private updateCamera(snap: SimSnapshot, dtMs: number): void {
    const fs = snap.state.fighters;
    if (fs.length === 0) return;
    const fitZoom = Math.min(this.viewW / LOGICAL_W, this.viewH / LOGICAL_H);

    let tx: number;
    let ty: number;
    let zoomT: number;
    const focus = this.camFocus;
    if (focus) {
      const caster =
        focus.kind === 'fighter'
          ? fs.find((f) => f.id === focus.id)
          : snap.state.assisters.find((a) => a.id === focus.id);
      tx = caster?.x ?? this.camX;
      ty = caster?.y ?? this.camY;
      zoomT = 3.5;
    } else {
      tx = fs.reduce((s, f) => s + f.x, 0) / fs.length;
      ty = fs.reduce((s, f) => s + f.y, 0) / fs.length;
      zoomT = this.zoomTarget;
      if (fs.length >= 2) {
        const distX = Math.abs(fs[0]!.x - fs[1]!.x);
        const distY = Math.abs(fs[0]!.y - fs[1]!.y);
        const zx = distX > 0 ? DESIGN_VIEW_W / distX : Infinity;
        const zy = distY > 0 ? DESIGN_VIEW_H / distY : Infinity;
        zoomT = Math.min(Math.max(Math.min(zx, zy) * 0.8, 1), 2.5);
      }
    }

    // 缓动（原版 ease(current, target, snap)：delta ≥ snap 时 current += delta/tweenSpd）
    const k = 1 - Math.pow(1 - 1 / 5, Math.min(dtMs / (1000 / 60), 4));
    this.camX = Math.abs(tx - this.camX) < 0.5 ? tx : this.camX + (tx - this.camX) * k;
    this.camY = Math.abs(ty - this.camY) < 0.5 ? ty : this.camY + (ty - this.camY) * k;
    this.zoomTarget = zoomT;
    this.zoomFactor =
      Math.abs(zoomT - this.zoomFactor) < 0.5 / 800
        ? zoomT
        : this.zoomFactor + (zoomT - this.zoomFactor) * k;

    const zoom = fitZoom * this.zoomFactor;
    // 相机不进模拟：纯渲染变换。按快照舞台边界 clamp（版边牵引的渲染面）。
    const st = snap.state.stage;
    const halfW = this.viewW / zoom / 2;
    const halfH = this.viewH / zoom / 2;
    const loX = st.leftBound + halfW;
    const hiX = st.rightBound - halfW;
    const cx = loX > hiX ? (st.leftBound + st.rightBound) / 2 : Math.min(Math.max(this.camX, loX), hiX);
    // 垂直：视口不得越出地图显示边界（原版 GameCamera fixBorder：setY 把
    // scrollRect.y 夹死在 [_fbR.y, _fbR.height]）。地图内容底边 = bottomY
    //（baked 地图 line_bottom 归一化 600），顶边 = 0；zoom=1 时视口恰为
    // 整张地图，任何情况下不露出 bg 全景的地图区以下部分。
    const loY = halfH;
    const hiY = st.bottomY - halfH;
    const cy = loY > hiY ? st.bottomY / 2 : Math.min(Math.max(this.camY, loY), hiY);
    this.applyCameraTransform(cx, cy, zoom);
    // front 层视差（镜像原版 MapMain.render，scrollRect 语义换算为本相机）：
    //   front.x = defaultX - 0.1·camLeft（camLeft = 视口左缘世界 x）
    //   front.y = defaultY + max(0, (bottom - camTop)·0.1)
    // front 在屏幕上比世界移动更快（近景语义）；front_fix 无视差、随地图固定。
    const camLeft = cx - halfW;
    const camTop = cy - halfH;
    this.mapFrontLayer.position.set(
      this.frontBaseX - camLeft * 0.1,
      this.frontBaseY + Math.max(0, (this.mapBottom - camTop) * 0.1),
    );
  }

  /** 相机变换应用（updateCamera 尾段共用；屏幕空间 bg cover 不随相机平移）。 */
  private applyCameraTransform(cx: number, cy: number, zoom: number): void {
    this.world.scale.set(zoom);
    this.world.position.set(this.viewW / 2 - cx * zoom, this.viewH / 2 - cy * zoom);
    // bg：随视口缩放、不随相机平移（原版 bgLayer 挂 stage，scrollRect 之外）；
    // cover 铺满可见逻辑区并居中（可见区 = viewW/zoom × viewH/zoom）
    this.bgFixed.scale.set(zoom);
    if (this.bgSprite && this.bgSize.w > 0) {
      const bw = this.viewW / zoom;
      const bh = this.viewH / zoom;
      const bk = Math.max(bw / this.bgSize.w, bh / this.bgSize.h);
      this.bgSprite.scale.set(bk);
      this.bgSprite.position.set((bw - this.bgSize.w * bk) / 2, (bh - this.bgSize.h * bk) / 2);
    }
  }

  /** 首帧定位（块 9）：装载完成、首快照前按默认相机（逻辑屏中心，zoom=1 基准）摆好
   *  world/bg/HUD。此前换场景首帧 world@原点、bg 未 cover → "进场黑边"；首个真实
   *  快照到达后 updateCamera 即接管（舞台边界未知，按默认 0..LOGICAL 夹取）。 */
  prime(): void {
    const fitZoom = Math.min(this.viewW / LOGICAL_W, this.viewH / LOGICAL_H);
    const zoom = fitZoom * this.zoomFactor;
    const halfW = this.viewW / zoom / 2;
    const halfH = this.viewH / zoom / 2;
    const loX = halfW;
    const hiX = LOGICAL_W - halfW;
    const cx = loX > hiX ? LOGICAL_W / 2 : Math.min(Math.max(LOGICAL_W / 2, loX), hiX);
    const loY = halfH;
    const hiY = LOGICAL_H - halfH;
    const cy = loY > hiY ? LOGICAL_H / 2 : Math.min(Math.max(LOGICAL_H / 2, loY), hiY);
    this.applyCameraTransform(cx, cy, zoom);
    this.hud?.layout(this.viewW, this.viewH, fitZoom);
  }

  /** 舞台五层显隐（块 9）：装载期隐藏（加载画面之下不露地图/HUD），战斗 enter 时开启。
   *  blackLayer/cutinLayer 的内层显隐由 update 流程自管，开关只作用于本层容器。 */
  setStageVisible(v: boolean): void {
    for (const c of [this.bgFixed, this.blackLayer, this.cutinScreen, this.world, this.hudLayer]) {
      c.visible = v;
    }
  }

  private hudGfx: Graphics | null = null;

  /** 对局 HUD（切片 30）：FightHud 实例（load 装配，update 驱动） */
  private hud: FightHud | null = null;

  /** 装配方（app）可选：屏幕底部按键提示。 */
  setHint(text: string): void {
    if (!this.hintText) {
      this.hintText = new Text('', { fontFamily: 'monospace', fontSize: 13, fill: 0x9aa0b0 });
      this.hintText.anchor.set(0.5, 1);
      this.hintText.position.set(this.viewW / 2, this.viewH - 8);
      this.hudLayer.addChild(this.hintText);
    }
    this.hintText.text = text;
  }

  /** 场景退出清理（切片 14）：卸显示对象与监听，复用同一 Application。 */
  destroy(): void {
    this.app.renderer.off('resize', this.onResize, this);
    this.hud?.destroy();
    this.hud = null;
    for (const sp of this.bulletSprites.values()) sp.root.destroy({ children: true });
    this.bulletSprites.clear();
    for (const sp of this.attackerSprites.values()) sp.root.destroy({ children: true });
    this.attackerSprites.clear();
    for (const e of this.mcEffects) e.root.destroy({ children: true });
    this.mcEffects = [];
    for (const gh of this.shadowGhosts) gh.root.destroy({ children: true });
    this.shadowGhosts = [];
    this.shadowStates.clear();
    this.shadowFilters.clear();
    this.app.stage.removeChild(
      this.bgFixed,
      this.blackLayer,
      this.cutinScreen,
      this.world,
      this.hudLayer,
    );
    this.blackLayer.destroy();
    this.bgFixed.destroy({ children: true });
    this.cutinScreen.destroy({ children: true });
    this.world.destroy({ children: true });
    this.hudLayer.destroy({ children: true });
  }
}
