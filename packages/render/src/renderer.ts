/**
 * BattleRenderer —— 战斗画面渲染编排器（DESIGN §5）。
 *
 * 唯一输入 = SimSnapshot（契约）：位置在相邻两快照间线性插值，
 * 动画帧/朝向取最新快照；相机纯渲染；HUD 读快照；
 * 表现事件按 tick 去重消费（不回读 sim 内部状态）。
 *
 * 本类只负责：图层装配、资源加载、事件路由、每帧调度顺序；
 * 具体特效/相机/帧应用逻辑在 ./renderer/ 子模块（纯搬移，调度顺序不变）。
 */
import { Application, Assets, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
// 高级混合模式注册（darken/lighten/hard-light/subtract…走 BlendModeFilter 实现）。
// pixi.js@8.22.0 的打包缺陷：主入口不引 advanced-blend-modes/init，不显式 import 则
// 这些 blendMode 静默回退 normal（darken 白底直接画出来 = 白矩形块）。
import 'pixi.js/advanced-blend-modes';
import type { SimSnapshot } from '@bvn/core';
import type { FighterAtlas, FireAtlas, MapAtlas } from '@bvn/data';
import {
  loadFighterAtlas,
  loadFireAtlas,
  loadMapAtlas,
  loadSheetFrames,
  type LoadedFighterAtlas,
  type LoadedFireAtlas,
  type LoadedMapAtlas,
} from './atlas.js';
import { FightHud } from './hud.js';
import {
  LOGICAL_H,
  LOGICAL_W,
  TICK_MS,
  type BattleAssetsSpec,
  type BulletSprite,
  type FighterSprite,
} from './renderer/types.js';
// 对外资源类型契约保持从 renderer 出口暴露（index.ts export * 不变）
export * from './renderer/types.js';
import type { FxCtx } from './renderer/fx-ctx.js';
import { applyFireFrame, applyFrame, drawPropBlock } from './renderer/frames.js';
import { CameraRig } from './renderer/camera.js';
import { ShakeFx } from './renderer/fx/shake.js';
import { McEffectFx, ShineFx, SparkFx } from './renderer/fx/particles.js';
import { BuffAuraFx, GlowFx, ShadowFx, SpecialFx } from './renderer/fx/attached.js';
import { CutinFx, KobgFx, PassiveFx } from './renderer/fx/cutin.js';

/**
 * 批量并发加载纹理：每完成一张即回调（加载页按"帧"上报进度），并发上限避免请求洪水。
 * 修复加载条在最后 10% 长时间不动：原先 hitspark 等 600+ 张图串行下载且整整一段只
 * 回报一次进度，实际下载几十秒而进度条目标值不动。并发 + 逐帧回报让条形持续走动。
 */
async function loadTextures(
  urls: readonly string[],
  onEach?: () => void,
  concurrency = 12,
): Promise<Texture[]> {
  const out = new Array<Texture>(urls.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= urls.length) return;
      out[i] = await Assets.load<Texture>(urls[i]!);
      onEach?.();
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * 有界并发遍历（结果按原序）：特效装载用——此前 bisha effects / hitspark 逐特效
 * 串行 await，46 个特效 = 46 次往返排队；无界 Promise.all 又会在慢链路上同时
 * 打满几十个连接。limit=6 与 loadTextures 同量级。
 */
async function runPool<T, R>(items: readonly T[], limit: number, run: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await run(items[i]!, i);
    }
  });
  await Promise.all(runners);
  return out;
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
  /** KO 背景层（KO 终结演出链，原版 BGEffect：effect 置舞台最底层 + 地图隐藏） */
  private kobgLayer: Container;
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
  private roundText: Text | null = null;
  private hintText: Text | null = null;

  private prev: SimSnapshot | null = null;
  private next: SimSnapshot | null = null;
  private accMs = 0;
  private lastEventsTick = new Map<string, number>();

  private hudGfx: Graphics | null = null;
  /** 对局 HUD（切片 30）：FightHud 实例（load 装配，update 驱动） */
  private hud: FightHud | null = null;

  /** 特效子系统共享上下文（图层/精灵 Map 与上方字段同一引用） */
  private ctx: FxCtx;
  /** 子系统实例（调度顺序见 update；构造依赖顺序见 constructor） */
  private cam: CameraRig;
  private shake: ShakeFx;
  private shines: ShineFx;
  private mcFx: McEffectFx;
  private sparks: SparkFx;
  private shadows: ShadowFx;
  private special: SpecialFx;
  private buffs: BuffAuraFx;
  private glow: GlowFx;
  private kobg: KobgFx;
  private cutin: CutinFx;
  private passive: PassiveFx;

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
    // KO 背景层置世界最底层（原版 BGEffect addChildAt(effect.display, 0)：
    // gameStage index 0，地图隐藏时即背景板；随相机变换）
    this.kobgLayer = new Container();
    this.kobgLayer.visible = false;
    this.kobgLayer.eventMode = 'none';
    this.world.addChildAt(this.kobgLayer, 0);
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

    this.ctx = {
      viewW: LOGICAL_W,
      viewH: LOGICAL_H,
      fxLayer: this.fxLayer,
      shadowLayer: this.shadowLayer,
      shineLayer: this.shineLayer,
      kobgLayer: this.kobgLayer,
      blackLayer: this.blackLayer,
      cutinScreen: this.cutinScreen,
      cutinLayer: this.cutinLayer,
      cutinBand: this.cutinBand,
      cutinFace: this.cutinFace,
      cutinFaceFlash: this.cutinFaceFlash,
      mapLayer: this.mapLayer,
      mapFrontFixLayer: this.mapFrontFixLayer,
      mapFrontLayer: this.mapFrontLayer,
      sprites: this.sprites,
      assistSprites: this.assistSprites,
      fighterAtlasById: this.fighterAtlasById,
      assisterAtlasByOwner: this.assisterAtlasByOwner,
      colorOffsetFilters: new Map(),
      assets: {
        hitspark: null,
        sparkTex: new Map(),
        bishaMc: null,
        bishaBandTex: [],
        bishaFaceTex: new Map(),
        bishaEffects: {},
        effectTex: new Map(),
      },
      mapView: {
        bottomOffset: 0,
        bottom: LOGICAL_H,
        frontBaseX: 0,
        frontBaseY: 0,
        bgSize: { w: 0, h: 0 },
        bgSprite: null,
      },
    };
    // 构造依赖顺序：shake/shines/special → sparks（派生调用）；cam → cutin（mcPosY 联动）
    this.cam = new CameraRig(this.ctx, this.world, this.bgFixed);
    this.shake = new ShakeFx();
    this.shines = new ShineFx(this.ctx);
    this.mcFx = new McEffectFx(this.ctx);
    this.special = new SpecialFx(this.ctx);
    this.glow = new GlowFx(this.ctx);
    this.buffs = new BuffAuraFx(this.ctx);
    this.shadows = new ShadowFx(this.ctx);
    this.sparks = new SparkFx(this.ctx, { special: this.special, shines: this.shines, shake: this.shake });
    this.kobg = new KobgFx(this.ctx);
    this.cutin = new CutinFx(this.ctx, this.cam);
    this.passive = new PassiveFx(this.sparks);

    this.onResize();
    app.renderer.on('resize', this.onResize, this);
  }

  private onResize(): void {
    // 布局使用 CSS 逻辑尺寸,不能把乘过 DPR 的画布物理像素当成游戏坐标。
    this.ctx.viewW = this.app.renderer.screen.width;
    this.ctx.viewH = this.app.renderer.screen.height;
  }

  /** 加载战斗素材（app await；onProgress = 分步进度回报 0..1，加载页进度条消费，块 9）。 */
  async load(spec: BattleAssetsSpec, onProgress?: (fraction: number) => void): Promise<void> {
    // —— 阶段 0：对局涉及的全部图集 JSON 一次取齐（map/fighters/assisters/fires，
    //     小体积并行一往返；本来就要取，提前只为 total 精确预推）——
    // total 按真实 sheet/layer 数计（2026-11-23 修条形冻结：此前每实体 1 tick，
    // 主力角色 26 张 sheet ~8MB 下完前条形数分钟不动）。
    const mapAtlasP: Promise<MapAtlas> = spec.mapAtlasJson
      ? Promise.resolve(spec.mapAtlasJson)
      : (this.fetchJson(`${spec.baseUrl}/maps/${spec.mapAtlasId}.atlas.json`) as Promise<MapAtlas>);
    // 角色图集 JSON：同 atlasId 可双槽/跨侧复用，按 kind:atlasId 去重落同一 Promise
    const fighterJsonByKey = new Map<string, Promise<FighterAtlas>>();
    const fighterJsonOf = (atlasId: string, kind: 'fighter' | 'assister'): Promise<FighterAtlas> => {
      const key = `${kind}:${atlasId}`;
      let p = fighterJsonByKey.get(key);
      if (!p) {
        p = (spec.fighterAtlasJson?.[atlasId]
          ? Promise.resolve(spec.fighterAtlasJson[atlasId]!)
          : this.fetchJson(
              `${spec.baseUrl}/${kind === 'assister' ? 'assistants' : 'fighters'}/${atlasId}.atlas.json`,
            )) as Promise<FighterAtlas>;
        fighterJsonByKey.set(key, p);
      }
      return p;
    };
    // fire 图集 JSON：键 = kind:fireAtlasId
    const fireEntries: { owner: string; kind: 'fighter' | 'assister'; id: string }[] = [];
    for (const kind of ['fighter', 'assister'] as const) {
      for (const [owner, id] of Object.entries(spec.fireAtlases?.[kind] ?? {})) {
        fireEntries.push({ owner, kind, id });
      }
    }
    const fireJsonByKey = new Map<string, Promise<FireAtlas>>();
    const fireJsonOf = (kind: 'fighter' | 'assister', id: string): Promise<FireAtlas> => {
      const key = `${kind}:${id}`;
      let p = fireJsonByKey.get(key);
      if (!p) {
        p = (spec.fireAtlasJson?.[id]
          ? Promise.resolve(spec.fireAtlasJson[id]!)
          : this.fetchJson(`${spec.baseUrl}/fires/${kind}/${id}.atlas.json`)) as Promise<FireAtlas>;
        fireJsonByKey.set(key, p);
      }
      return p;
    };
    await Promise.all([
      mapAtlasP,
      ...spec.fighters.map((f) => fighterJsonOf(f.atlasId, f.kind ?? 'fighter')),
      ...(spec.assisters ?? []).map((a) => fighterJsonOf(a.atlasId, 'assister')),
      ...fireEntries.map((e) => fireJsonOf(e.kind, e.id)),
    ]);
    const mapAtlas = await mapAtlasP;
    // JSON 全部就绪（上面 Promise.all 已等待），落成同步查找表
    const fighterAtlasOf = new Map<string, FighterAtlas>();
    for (const [key, p] of fighterJsonByKey) fighterAtlasOf.set(key, await p);
    const fireAtlasOf = new Map<string, FireAtlas>();
    for (const [key, p] of fireJsonByKey) fireAtlasOf.set(key, await p);

    // —— 分步总数按真实 sheet/layer 数预推（与下方 await 序列、tick 粒度一一对应；步骤增删须同步） ——
    const effectFrames = Object.values(spec.bisha?.effects ?? {}).reduce((s, e) => s + e.frames, 0);
    const faceCount = spec.bisha
      ? [
          ...spec.fighters.map((f) => f.atlasId),
          ...(spec.assisters ?? []).map((a) => a.atlasId),
        ].reduce((s, id) => s + Object.keys(spec.bisha!.faces[id] ?? {}).length, 0)
      : 0;
    const total =
      mapAtlas.layers.length /*每层 1 tick*/ +
      [...spec.fighters.map((f) => `${f.kind ?? 'fighter'}:${f.atlasId}`), ...(spec.assisters ?? []).map((a) => `assister:${a.atlasId}`)].reduce(
        (s, key) => s + fighterAtlasOf.get(key)!.sheets.length,
        0,
      ) +
      fireEntries.reduce((s, e) => s + fireAtlasOf.get(`${e.kind}:${e.id}`)!.sheets.length, 0) +
      (spec.bisha ? spec.bisha.mc.frames + effectFrames + faceCount : 0) +
      // hitspark 按实际帧数计数（不是特效数）：进度分母必须匹配 tick 粒度（sheet 下完按承载帧数补 tick）
      (spec.hitspark
        ? Object.values(spec.hitspark.baked.effects).reduce((s, e) => s + e.frames, 0)
        : 0) +
      // HUD tick（2026-11-23 拼图）：拼图元素按帧数计（hud.load 内 sheet 下完补 tick），
      // 旧包逐帧目录整包回退 = 1 tick，单图不计
      (spec.hud
        ? Object.values(spec.hud.data.elements).reduce(
            (s, el) =>
              s +
              (typeof el === 'string' ? (el.endsWith('.webp') ? 0 : 1) : el.sheets.cells.length),
            0,
          )
        : 0);
    let done = 0;
    const tick = () => {
      done++;
      onProgress?.(Math.min(done / total, 1));
    };
    // atlas JSON 内 file 为裸文件名，sheet PNG 与 atlas JSON 同目录（assets/<kind>/）
    this.mapLoaded = await loadMapAtlas(`${spec.baseUrl}/maps`, mapAtlas, tick); // 每层 1 tick
    this.ctx.mapView.bottomOffset = spec.mapBottomOffset ?? 0;
    this.ctx.mapView.bottom = spec.mapBottom ?? LOGICAL_H;
    this.buildMap();

    for (const f of spec.fighters) {
      const kind = f.kind ?? 'fighter';
      const atlas = fighterAtlasOf.get(`${kind}:${f.atlasId}`)!;
      const loaded = await loadFighterAtlas(`${spec.baseUrl}/${kind === 'assister' ? 'assistants' : 'fighters'}`, atlas, tick);
      this.sprites.set(f.slot, this.makeSprite(f.atlasId, loaded, f.formIndex ?? 0));
      this.fighterAtlasById.set(f.slot, f.atlasId);
    }

    for (const a of spec.assisters ?? []) {
      const atlas = fighterAtlasOf.get(`assister:${a.atlasId}`)!;
      const loaded = await loadFighterAtlas(`${spec.baseUrl}/assistants`, atlas, tick);
      this.assistSprites.set(a.ownerId, this.makeSprite(a.atlasId, loaded, 0));
      this.assisterAtlasByOwner.set(a.ownerId, a.atlasId);
    }

    // fire 元件图集（切片 14 多角色）：按出场者 atlasId 装载；缺失条目色块回退
    for (const kind of ['fighter', 'assister'] as const) {
      for (const [ownerAtlasId, fireAtlasId] of Object.entries(spec.fireAtlases?.[kind] ?? {})) {
        const loaded = await loadFireAtlas(`${spec.baseUrl}/fires/${kind}`, fireAtlasOf.get(`${kind}:${fireAtlasId}`)!, tick);
        (kind === 'fighter' ? this.fireLoadedFighter : this.fireLoadedAssister).set(
          ownerAtlasId,
          loaded,
        );
      }
    }

    // 切人插图（切片 22）：mc 流帧全量 + 出场者立绘（仅当前对局涉及的包）
    if (spec.bisha) {
      const bisha = spec.bisha;
      this.ctx.assets.bishaMc = bisha.mc;
      // mc 流帧（2026-11-22 拼图清单优先：842 请求 → ~50 sheet；逐帧回退保留兼容）
      this.ctx.assets.bishaBandTex = bisha.mc.sheets
        ? await loadSheetFrames(spec.baseUrl, bisha.mc.dir, bisha.mc.sheets, bisha.mc.frames, tick)
        : await loadTextures(
            Array.from({ length: bisha.mc.frames }, (_, i) => `${spec.baseUrl}/${bisha.mc.dir}/${i + 1}.webp`),
            tick,
          );
      // 必杀光效流帧（切片 26）：bisha(XG_bs) / bisha_super(XG_cbs)——有界并发（此前逐特效串行）
      this.ctx.assets.bishaEffects = {};
      this.ctx.assets.effectTex.clear();
      const effectEntries = Object.entries(spec.bisha.effects ?? {});
      const effectTexs = await runPool(effectEntries, 6, async ([, eff]) =>
        eff.sheets
          ? await loadSheetFrames(spec.baseUrl, eff.dir, eff.sheets, eff.frames, tick)
          : await loadTextures(
              Array.from({ length: eff.frames }, (_, i) => `${spec.baseUrl}/${eff.dir}/${i + 1}.webp`),
              tick,
            ),
      );
      effectEntries.forEach(([id, eff], i) => {
        this.ctx.assets.bishaEffects[id] = eff;
        this.ctx.assets.effectTex.set(id, effectTexs[i]!);
      });
      // 横幅常驻位：内容（PNG 减对称出血）横向拉伸铺满可见逻辑区（见 cutinScaleX），
      // x = canvasOrigin×sx 使内容左缘贴视口 0；y 为烘焙初值（演出期由 mcPosY 联动接管，切片 26）
      const mcSx0 = this.cutin.scaleX(spec.bisha.mc);
      this.cutinBand.scale.set(mcSx0, 1);
      this.cutinBand.position.set(
        spec.bisha.mc.canvasOrigin[0] * mcSx0,
        spec.bisha.mc.mcPos[1] + spec.bisha.mc.canvasOrigin[1],
      );
      const faceEntries: { key: string; url: string }[] = [];
      for (const atlasId of new Set([
        ...spec.fighters.map((f) => f.atlasId),
        ...(spec.assisters ?? []).map((a) => a.atlasId),
      ])) {
        for (const [faceName, path] of Object.entries(spec.bisha.faces[atlasId] ?? {})) {
          faceEntries.push({ key: `${atlasId}:${faceName}`, url: `${spec.baseUrl}/${path}` });
        }
      }
      const faceTexs = await loadTextures(faceEntries.map((e) => e.url), tick);
      faceEntries.forEach((e, i) => this.ctx.assets.bishaFaceTex.set(e.key, faceTexs[i]!));
    } else {
      this.ctx.assets.bishaMc = null;
    }

    // 命中/防御火花（修复批次 35）：全部元件流帧预载——有界并发（此前逐特效串行
    // 46 次往返；跨境慢链路上即数分钟），清单在（stream-sheet 产物）走 sheet 装载，
    // 逐帧回退兼容旧包
    if (spec.hitspark) {
      this.ctx.assets.hitspark = spec.hitspark.baked;
      this.ctx.assets.sparkTex.clear();
      this.sparks.resetWarnings();
      const sparkEntries = Object.entries(this.ctx.assets.hitspark.effects);
      const sparkTexs = await runPool(sparkEntries, 6, async ([, eff]) =>
        eff.sheets
          ? await loadSheetFrames(spec.baseUrl, eff.dir, eff.sheets, eff.frames, tick)
          : await loadTextures(
              Array.from({ length: eff.frames }, (_, i) => `${spec.baseUrl}/${eff.dir}/${i + 1}.webp`),
              tick,
            ),
      );
      sparkEntries.forEach(([id], i) => this.ctx.assets.sparkTex.set(id, sparkTexs[i]!));
    } else {
      this.ctx.assets.hitspark = null;
    }

    // 对局 HUD（切片 30）：纹理装载 + 静态树（重建对局时先拆旧树）。
    // 拼图清单随 sheet 下载逐段补 tick（2026-11-23），分母已按帧数预推
    if (spec.hud) {
      this.hud?.destroy();
      this.hud = new FightHud(this.hudLayer, spec.hud);
      await this.hud.load(spec.baseUrl, tick);
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
        this.ctx.mapView.bgSize = { w: tex.width, h: tex.height };
        this.ctx.mapView.bgSprite = sp;
        this.bgFixed.addChild(sp);
        return;
      }
      // 图层 display 原点偏移 + 内容 bounds 偏移 + initlize 整体下移
      sp.position.set(ly.x + ly.bx, ly.y + ly.by + this.ctx.mapView.bottomOffset);
      if (ly.name === 'front_fix') this.mapFrontFixLayer.addChild(sp);
      else if (ly.name === 'front') {
        this.ctx.mapView.frontBaseX = sp.x;
        this.ctx.mapView.frontBaseY = sp.y;
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
    // 持续震屏自动清理（切片 52）：原版 FighterMcCtrler doAction/idle/doHurt
    // 统一 endShake——渲染层近似 = owner actionState 变化 / 死亡 / 快照缺席
    //（残影同款范式，先清后消费事件）；辅助 owner 无 actionState，仅
    // 退场（快照缺席）清。
    if (this.prev) {
      this.shadows.prescan(snap, this.prev);
      this.shake.prescan(snap, this.prev);
    }
    // 持续挂身特效收尾判定（原版 SpecialEffectView.render）：目标回
    // NORMAL/HURT_DOWN/HURT_DOWN_TAN（弹起态同原版 24，切片 54 补齐）
    // → 转 finish 段 + resumeColor；目标快照缺席（团队 bench 下场）→ 即刻移除。
    // 先清后消费事件：同拍「收尾 + 重挂」顺序与原版一致。
    this.special.prescan(snap);
    // buff 光环熄灭巡检（切片 51，原版 BuffEffectView.render：buff.finished ||
    // !isAlive 移除）：buff 计满熄灭 / 角色死亡 / 团队下场（快照缺席）→ 移除。
    this.buffs.prescan(snap);
    // 钢身发光开关巡检（切片 51）：开关态以快照 steelBody 为准（sim 静默清钢身
    // 不发事件），颜色取 startGlow 事件最近值；快照缺席（下场）清灯。
    this.glow.prescan(snap);

    for (const ev of snap.events) {
      // 去重键含 params（切片 51）：同 tick 多 buff 施加（不同 kind）互不吞——
      // 重投递同事件 params 相等仍去重，touchFloor 双发（同 id 同 params）语义不变。
      const key = `${ev.tick}:${ev.type}:${String(ev.payload['id'] ?? '')}:${JSON.stringify(
        ev.payload['params'] ?? null,
      )}`;
      const last = this.lastEventsTick.get(key);
      if (last === ev.tick) continue; // 去重
      this.lastEventsTick.set(key, ev.tick);
      if (ev.type === 'hit:connect') {
        // 命中火花三件套（修复批次 35，原版 doHitEffect/doDefenseEffect/
        // doSteelHitEffect 分流；hitstop 冻结在 core 已结算）：
        // 火花钉 hitRect∩身体区相交中心 + 受击者闪红 + HUD 连击计数
        this.sparks.spawnHitSpark(ev.payload);
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
          this.mcFx.spawn(
            isSuper ? 'bisha_super' : 'bisha',
            Number(ev.payload['x'] ?? 0),
            Number(ev.payload['y'] ?? 0) - 50,
          );
          if (isSuper) {
            const owner = ev.payload['owner'];
            const ownerKind = ev.payload['ownerKind'];
            if (typeof owner === 'number' && (ownerKind === 'fighter' || ownerKind === 'assister')) {
              this.cam.focus = { kind: ownerKind, id: owner };
            }
          }
          if (this.ctx.assets.bishaMc) this.cutin.begin(snap, ev.payload, isSuper);
        } else if (id === 'shine') {
          // 全屏色闪（修复批次 40：招2_CHK 等时间轴 shine 触发此前被静默丢弃）。
          // 原版 FighterEffectCtrler.shine(color)：白=0.3 其余=0.2，EffectCtrler.shine
          // 加 ShineEffectView 全屏。params 三形态：fighter 时间轴 = 裸色值；
          // attacker 道具转发 = { arg }；KO 终结演出链 = { color, alpha }
          //（原版 FightUI.playKO EffectCtrler.shine(0xFFFFFF, 0.5)，KO 白闪 α0.5
          // 与角色时间轴 0.3 不同）。缺省白。
          const raw = ev.payload['params'] as unknown;
          let color = 0xffffff;
          let alpha: number | null = null;
          if (typeof raw === 'number') {
            color = raw;
          } else if (raw !== null && typeof raw === 'object') {
            const r = raw as Record<string, unknown>;
            if (typeof r['arg'] === 'number') color = r['arg'];
            if (typeof r['color'] === 'number') color = r['color'];
            if (typeof r['alpha'] === 'number') alpha = r['alpha'];
          }
          this.shines.spawn(color >>> 0, alpha ?? (color === 0xffffff ? 0.3 : 0.2));
        } else if (id === 'shake') {
          // 世界抖动（修复批次 44：击飞落地 shake 此前未消费）。params 两形态：
          // core 落地 = { x, y, time }（EffectCtrler 层值）；时间轴 shake = { arg }
          //（FighterEffectCtrler.shake 语义：pow=max(powX,powY)、恒竖向 ×2）。
          const p = (ev.payload['params'] ?? {}) as Record<string, unknown>;
          if (typeof p['y'] === 'number' || typeof p['x'] === 'number') {
            this.shake.doShake(Number(p['x'] ?? 0), Number(p['y'] ?? 0), Number(p['time'] ?? 0));
          } else if (typeof p['arg'] === 'number') {
            this.shake.doShake(0, p['arg'] * 2, 0);
          }
        } else if (id === 'shadow') {
          // 残影开始（切片 47，原版 FighterEffectCtrler.shadow → ShadowEffectView：
          // 每特效帧截图留影，r/g/b = ColorTransform 加色偏移）。owner 寻址 =
          // 角色/辅助精灵；激活态纯渲染层，不进 core。
          const p = (ev.payload['params'] ?? {}) as Record<string, unknown>;
          const owner = p['owner'];
          const kind = p['ownerKind'];
          if (typeof owner === 'number' && (kind === 'fighter' || kind === 'assister')) {
            this.shadows.start(`${kind}:${owner}`, {
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
            this.shadows.stop(`${kind}:${owner}`);
          } else {
            this.shadows.stopAll(); // 无 owner 旧事件兜底：全停
          }
        } else if (id === 'kobg') {
          // KO 背景层（KO 终结演出链，原版 FightUI.playKO bsKO →
          // EffectCtrler.BGEffect("kobg", 2)：effect 置舞台最底层、地图隐藏，
          // holdFrame = hold×30 帧计满移除并恢复地图——KobgFx.update 每帧推进）
          const p = (ev.payload['params'] ?? {}) as Record<string, unknown>;
          const st = snap.state.stage;
          this.kobg.spawn(
            Math.max(1, Math.round(Number(p['hold'] ?? 2) * 30)),
            st.leftBound,
            st.rightBound - st.leftBound,
          );
        } else if (id === 'buffUp') {
          // buff 视觉（切片 51，原版 FighterBuffCtrler speedUp/attackUp/defenseUp
          // → doEffectById("buff_effect_*") + doBuffEffect("buff_*")）：一次性火花
          // 钉施加点（direct=1 原版缺省朝向）+ 光环挂身（单实例去重——原版重复
          // 施加叠加重复光环视为缺陷，偏离登记）；光环熄灭由快照 buffs 差分巡检。
          const p = (ev.payload['params'] ?? {}) as Record<string, unknown>;
          const fighter = p['fighter'];
          const kind = String(p['kind'] ?? '');
          if (
            typeof fighter === 'number' &&
            (kind === 'speed' || kind === 'power' || kind === 'defense')
          ) {
            const sparkId = `buff_effect_${kind}`;
            if (this.ctx.assets.hitspark) {
              this.sparks.spawnById(
                sparkId,
                Number(ev.payload['x'] ?? 0),
                Number(ev.payload['y'] ?? 0),
                1,
              );
            }
            this.buffs.attach(fighter, kind, snap);
          }
        } else if (id === 'startGlow' || id === 'endGlow') {
          // 钢身发光颜色（切片 51，原版 setSteelBody → startGlow/endGlow）：
          // 事件只携色（isSuper → 黄 0xFFFF00，原版 FighterMcCtrler setSteelBody
          // isSuper 分支），开关态由快照 steelBody 差分巡检统一处理。
          const p = (ev.payload['params'] ?? {}) as Record<string, unknown>;
          const fighter = p['fighter'];
          if (typeof fighter === 'number') {
            if (id === 'startGlow') {
              this.glow.setColor(fighter, p['isSuper'] === true ? 0xffff00 : 0xffffff);
            } else {
              this.glow.clearColor(fighter);
            }
          }
        } else if (id === 'startShake') {
          // 持续震屏（切片 52，原版 EffectCtrler.startShake：置 hold 保持项，
          // advanceShake 的 holdX/holdY 通道接入；单槽覆盖语义同原版全局
          // _shakeHoldX/Y）。params = { owner, ownerKind, x, y }。
          const p = (ev.payload['params'] ?? {}) as Record<string, unknown>;
          const owner = p['owner'];
          const kind = p['ownerKind'];
          this.shake.startHold(
            Number(p['x'] ?? 0),
            Number(p['y'] ?? 0),
            typeof owner === 'number' && (kind === 'fighter' || kind === 'assister')
              ? { kind, id: owner }
              : null,
          );
        } else if (id === 'endShake') {
          // 震屏结束（原版 EffectCtrler.endShake：hold 清零 + gameStage 位移
          // 即时回零——衰减 pow 若仍>0，下一 30fps 步进重新落位）。
          this.shake.endHold();
        } else if (id === 'startGhostStep') {
          // 幽步启动（切片 53，原版 FighterMcCtrler.startGhostStep →
          // effectCtrler.ghostStep()：shadow(0,0,255) 蓝残影 + justRender 白名单
          // + 黑幕/地图隐藏 + snd_ghost_jump）。黑幕/地图隐藏由 CutinFx.update 按
          // 快照 ghostTicks 差分驱动（sim 冻结同源）；此处只挂蓝残影
          //（复用切片 47 ShadowEffectView 机制，色偏移 = 原版 ColorTransform(0,0,255)）。
          const p = (ev.payload['params'] ?? {}) as Record<string, unknown>;
          const owner = p['owner'];
          if (typeof owner === 'number') {
            this.shadows.start(`fighter:${owner}`, { r: 0, g: 0, b: 255 });
          }
        } else if (id === 'endGhostStep') {
          // 幽步结束（原版 effectCtrler.endGhostStep → endShadow）：停蓝残影。
          // 地面步全程 NORMAL，残影 actionState 差分自动清理不触发——依赖显式
          // 事件；空中步结束回 NORMAL 双路径同拍先清后消费，幂等。
          const p = (ev.payload['params'] ?? {}) as Record<string, unknown>;
          const owner = p['owner'];
          if (typeof owner === 'number') {
            this.shadows.stop(`fighter:${owner}`);
          }
        } else if (id === 'replaceSkill') {
          // 替身启动（切片 55，原版 EffectCtrler.replaceSkill：黑幕 + 地图隐藏
          // + doEffectById("replaceSp", 预瞬移点)；replaceSp2 同点下一演出帧补放
          // ——PassiveFx.update 按快照 ticksLeft 差分补放）。黑幕/地图隐藏由
          // CutinFx.update 按快照 passiveFreeze 差分驱动（sim 冻结同源）。
          const p = (ev.payload['params'] ?? {}) as Record<string, unknown>;
          const x = Number(ev.payload['x'] ?? 0);
          const y = Number(ev.payload['y'] ?? 0);
          this.passive.begin(
            'replace',
            Number(p['owner'] ?? 0),
            x,
            y,
            snap.state.passiveFreeze?.ticksLeft ?? 20,
          );
          this.sparks.spawnById('replaceSp', this.passive.x, this.passive.y, 1);
        } else if (id === 'startEnergyExplode') {
          // 灵压爆发启动（原版 EffectCtrler.energyExplode：黑幕 + 地图隐藏 +
          // doEffectById("explodeSp", 施法点)；explodeSp2 由 endEnergyExplode 事件补放）
          const p = (ev.payload['params'] ?? {}) as Record<string, unknown>;
          const x = Number(ev.payload['x'] ?? 0);
          const y = Number(ev.payload['y'] ?? 0);
          this.passive.begin(
            'explode',
            Number(p['owner'] ?? 0),
            x,
            y,
            snap.state.passiveFreeze?.ticksLeft ?? 42,
          );
          this.sparks.spawnById('explodeSp', this.passive.x, this.passive.y, 1);
        } else if (id === 'endEnergyExplode') {
          // 爆发收尾（原版 endEnergyExplode：doEffectById("explodeSp2") + resume
          // + 黑幕淡出 + 地图恢复；黑幕/地图由 CutinFx 快照差分恢复）
          if (this.passive.kind === 'explode') {
            this.sparks.spawnById('explodeSp2', this.passive.x, this.passive.y, 1);
          }
        } else {
          // 通用控制器特效（修复批次 44：jump/touchFloor 尘土 + hit_floor 落地尘土系
          // 此前未消费）。跳/落地尘土走火花管线（30fps 播尽自移除，规格随烘焙）。
          // 事件 id 'touchFloor' 归一化为烘焙 id 'touch_floor'（时间轴与物理落地
          // emit 同键，渲染层按 tick+id 去重防双播）。
          // 缺件（表项/纹理）不在此短路——spawnById 内部静默告警（切片 57
          // 诊断链路：前置判断会把告警短路成纯静默丢弃），告警后安全返回。
          const sparkId = id === 'touchFloor' ? 'touch_floor' : id;
          if (this.ctx.assets.hitspark) {
            const p = (ev.payload['params'] ?? {}) as Record<string, unknown>;
            // direct = 发射者朝向（切片 47：dash/dash_air 帧位镜像，原版
            // doEffectById(id, x, y, _target.direct)）
            const direct = p['direct'] === -1 ? -1 : 1;
            this.sparks.spawnById(
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

  /** 开局特写相机（intro 切片，原版 GameStartCtrler.preRenderStart/
   *  renderStart1v1 的 cameraFocusOne）：step 0-2 聚焦 P1、3-5 聚焦 P2
   * （zoom 3.5 与必杀特写同款），step ≥6（resume/字样段）双焦点 autoZoom
   * 接管。每帧重设（CutinFx.update 在无锁时清 camFocus，intro 需随后覆写）。
   */
  private updateIntro(next: SimSnapshot): void {
    const intro = next.state.intro;
    if (intro == null || intro.step >= 6) return;
    const target = intro.step < 3 ? next.state.fighters[0] : next.state.fighters[1];
    if (target) this.cam.focus = { kind: 'fighter', id: target.id };
  }

  /**
   * 回合结束特写（终局演出收编，原版 FightUI.playKO cameraFocusOne(loser) /
   * renderEnd cameraFocusOne(winner)，zoom 3.5 同款）：winApplied 前聚焦败方
   * （KO 飞尸特写），之后聚焦胜方（WIN 姿势特写）；over 定格保持。
   * 平局不聚焦（原版 playKO(null) 无 focusOne）。每帧重设（CutinFx.update 在无锁
   * 时清 camFocus，本方法随后覆写；updateIntro 优先）。
   */
  private updateRoundEnd(next: SimSnapshot): void {
    const re = next.state.roundEnd;
    if (re == null || re.draw || re.winnerId < 0) return;
    this.cam.focus = { kind: 'fighter', id: re.winApplied ? re.winnerId : re.loserId };
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
      // 替身残效半透明（切片 55，原版 renderAnimate _replaceSkillFrame 期
      // _mainMc.alpha = 0.5，恢复置 1）
      sp.root.alpha = (f.replaceTicks ?? 0) > 0 ? 0.5 : 1;
      if (sp.appliedFacing !== f.facing) {
        sp.root.scale.x = f.facing;
        sp.appliedFacing = f.facing;
      }
      // 内层帧 = 最新快照
      applyFrame(sp, f.actLabel !== null ? f.animFrame : 0);
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
    this.mcFx.update(dtMs);
    this.shadows.update(dtMs, next);
    this.special.update(dtMs, next);
    this.buffs.update(dtMs);
    this.sparks.update(dtMs);
    this.glow.update();
    this.shines.update(dtMs);
    this.passive.update(next);
    this.cutin.update(next, dtMs);
    this.kobg.update(next, dtMs);
    this.updateIntro(next);
    this.updateRoundEnd(next);
    this.cam.update(next, dtMs);
    // 世界抖动（原版 gameStage.x/y 整体位移）：叠加在相机变换之后（world+bgFixed）
    this.shake.advance(dtMs);
    if (this.shake.offX !== 0 || this.shake.offY !== 0) {
      this.world.x += this.shake.offX;
      this.world.y += this.shake.offY;
      this.bgFixed.x += this.shake.offX;
      this.bgFixed.y += this.shake.offY;
    }
    // HUD（切片 30）：屏幕空间钉扎重摆 + 快照驱动（血/气/能量/辅助格/连击）
    const fitZoom = Math.min(this.ctx.viewW / LOGICAL_W, this.ctx.viewH / LOGICAL_H);
    if (this.hud) {
      this.hud.layout(this.ctx.viewW, this.ctx.viewH, fitZoom);
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
      applyFrame(sp, a.animFrame);
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
        drawPropBlock(
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
        sp = { root, body, parts: [], appliedFrame: -1 };
        this.attackerSprites.set(a.id, sp);
      }
      // B5 原点锚：容器 = 元件原点，子帧内容由图集 rel（相对原点）承载
      sp.root.position.set(ix, iy);
      sp.root.scale.x = a.facing;
      // 内层时间轴动画帧（animTotal=0 无时间轴时回退首帧；切片 13-A5）
      applyFireFrame(sp, loaded, a.name, a.animTotal > 0 ? a.animFrame : 1);
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
        drawPropBlock(g, b.facing, b.w, b.h, b.hit.hitType, ix, iy);
        continue;
      }
      let sp = this.bulletSprites.get(b.id);
      if (!sp) {
        const root = new Container();
        const body = new Sprite(Texture.WHITE);
        body.visible = false;
        root.addChild(body);
        this.bulletLayer.addChild(root);
        sp = { root, body, parts: [], appliedFrame: -1 };
        this.bulletSprites.set(b.id, sp);
      }
      const rel = el.main;
      sp.root.position.set(b.facing === 1 ? ix - rel.x : ix + rel.x + rel.w, iy - rel.y);
      sp.root.scale.x = b.facing;
      applyFireFrame(sp, loaded, b.name, b.animFrame);
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

  /** 首帧定位（块 9）：装载完成、首快照前按默认相机（逻辑屏中心，zoom=1 基准）摆好
   *  world/bg/HUD。此前换场景首帧 world@原点、bg 未 cover → "进场黑边"；首个真实
   *  快照到达后 updateCamera 即接管（舞台边界未知，按默认 0..LOGICAL 夹取）。 */
  prime(): void {
    this.cam.prime();
    const fitZoom = Math.min(this.ctx.viewW / LOGICAL_W, this.ctx.viewH / LOGICAL_H);
    this.hud?.layout(this.ctx.viewW, this.ctx.viewH, fitZoom);
  }

  /** 舞台六层显隐（块 9）：装载期隐藏（加载画面之下不露地图/HUD），战斗 enter 时开启。
   *  blackLayer/cutinLayer 的内层显隐由 update 流程自管，开关只作用于本层容器。 */
  setStageVisible(v: boolean): void {
    for (const c of [
      this.bgFixed,
      this.blackLayer,
      this.cutinScreen,
      this.world,
      this.shineLayer,
      this.hudLayer,
    ]) {
      c.visible = v;
    }
  }

  /** 装配方（app）可选：屏幕底部按键提示。 */
  setHint(text: string): void {
    if (!this.hintText) {
      this.hintText = new Text('', { fontFamily: 'monospace', fontSize: 13, fill: 0x9aa0b0 });
      this.hintText.anchor.set(0.5, 1);
      this.hintText.position.set(this.ctx.viewW / 2, this.ctx.viewH - 8);
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
    this.mcFx.dispose();
    this.shadows.dispose();
    this.ctx.colorOffsetFilters.clear();
    this.special.dispose();
    this.buffs.dispose();
    this.glow.dispose();
    this.shake.dispose();
    this.app.stage.removeChild(
      this.bgFixed,
      this.blackLayer,
      this.cutinScreen,
      this.world,
      this.shineLayer,
      this.hudLayer,
    );
    this.blackLayer.destroy();
    this.bgFixed.destroy({ children: true });
    this.cutinScreen.destroy({ children: true });
    this.world.destroy({ children: true });
    this.shineLayer.destroy({ children: true });
    this.hudLayer.destroy({ children: true });
  }
}
