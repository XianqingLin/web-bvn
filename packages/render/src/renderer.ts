/**
 * BattleRenderer —— 战斗画面渲染（DESIGN §5）。
 *
 * 唯一输入 = SimSnapshot（契约）：位置在相邻两快照间线性插值，
 * 动画帧/朝向取最新快照；相机纯渲染；HUD 读快照；
 * 表现事件按 tick 去重消费（不回读 sim 内部状态）。
 */
import { Application, Assets, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { SimSnapshot } from '@bvn/core';
import type { FighterAtlas, FireAtlas, MapAtlas } from '@bvn/data';
import { frameTexture, loadFighterAtlas, loadFireAtlas, loadMapAtlas, type LoadedFighterAtlas, type LoadedFireAtlas, type LoadedMapAtlas } from './atlas.js';

const TICK_MS = 1000 / 60;
const LOGICAL_W = 1000;
const LOGICAL_H = 600;

/** baked/bisha.json 的 mc 块（tools/bisha-pack 产物，schema bvn/bisha@1） */
export interface BishaMcData {
  dir: string;
  frames: number;
  fps: number;
  destoryFrame: number;
  canvasOrigin: [number, number];
  canvasSize: [number, number];
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
}

interface FighterSprite {
  root: Container;
  body: Sprite;
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
  private bulletLayer: Container;
  private bulletGfx: Graphics;
  /** attacker 色块回退（独立道具缺图集条目时） */
  private attackerGfx: Graphics;
  private fxLayer: Container;
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

  /** 相机聚焦（切片 26，原版 GameStage.cameraFocusOne/cameraResume）：super 必杀/
   *  万解聚焦施法者，cutinLock 清除即恢复双焦点（null = 双焦点，autoZoom 接管） */
  private camFocus: { kind: 'fighter' | 'assister'; id: number } | null = null;

  private prev: SimSnapshot | null = null;
  private next: SimSnapshot | null = null;
  private accMs = 0;
  private lastEventsTick = new Map<string, number>();

  /** 相机（逻辑坐标）：中心点 + 缩放因子（原版 GameCamera 语义：
   *  factor = 原版 zoom，1 = 满屏逻辑区；有效缩放 = fitZoom × factor）。
   *  缓动 = 原版 ease：逐帧 delta/5（tweenSpd = CAMERA_TWEEN_SPD/SPEED_PLUS_DEFAULT） */
  private camX = LOGICAL_W / 2;
  private camY = LOGICAL_H / 2;
  private zoomFactor = 1;
  private zoomTarget = 1;
  /** 世界容器宽（屏幕像素）：缩放 = worldW / LOGICAL_W */
  private viewW = LOGICAL_W;
  private viewH = LOGICAL_H;

  constructor(private app: Application) {
    this.bgFixed = new Container();
    this.cutinScreen = new Container();
    this.world = new Container();
    this.mapLayer = new Container();
    this.mapFrontFixLayer = new Container();
    this.mapFrontLayer = new Container();
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
      this.fighterLayer,
      this.bulletLayer,
      this.mapFrontFixLayer,
      this.mapFrontLayer,
      this.fxLayer,
    );
    this.cutinScreen.addChild(this.cutinLayer);
    app.stage.addChild(this.bgFixed, this.blackLayer, this.cutinScreen, this.world, this.hudLayer);
    this.onResize();
    app.renderer.on('resize', this.onResize, this);
  }

  private onResize(): void {
    this.viewW = this.app.renderer.width;
    this.viewH = this.app.renderer.height;
  }

  /** 加载战斗素材（app await）。 */
  async load(spec: BattleAssetsSpec): Promise<void> {
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

    for (const f of spec.fighters) {
      const kind = f.kind ?? 'fighter';
      const atlas = await atlasFor(f.atlasId, kind);
      const loaded = await loadFighterAtlas(`${spec.baseUrl}/${kind === 'assister' ? 'assistants' : 'fighters'}`, atlas);
      this.sprites.set(f.slot, this.makeSprite(f.atlasId, loaded, f.formIndex ?? 0));
      this.fighterAtlasById.set(f.slot, f.atlasId);
    }

    for (const a of spec.assisters ?? []) {
      const atlas = await atlasFor(a.atlasId, 'assister');
      const loaded = await loadFighterAtlas(`${spec.baseUrl}/assistants`, atlas);
      this.assistSprites.set(a.ownerId, this.makeSprite(a.atlasId, loaded, 0));
      this.assisterAtlasByOwner.set(a.ownerId, a.atlasId);
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
      }
    }

    // 切人插图（切片 22）：mc 流帧全量 + 出场者立绘（仅当前对局涉及的包）
    if (spec.bisha) {
      this.bishaMc = spec.bisha.mc;
      this.bishaBandTex = [];
      for (let i = 1; i <= spec.bisha.mc.frames; i++) {
        this.bishaBandTex.push(await Assets.load<Texture>(`${spec.baseUrl}/${spec.bisha.mc.dir}/${i}.webp`));
      }
      // 必杀光效流帧（切片 26）：bisha(XG_bs) / bisha_super(XG_cbs)
      this.bishaEffects = {};
      this.effectTex.clear();
      for (const [id, eff] of Object.entries(spec.bisha.effects ?? {})) {
        const texs: Texture[] = [];
        for (let i = 1; i <= eff.frames; i++) {
          texs.push(await Assets.load<Texture>(`${spec.baseUrl}/${eff.dir}/${i}.webp`));
        }
        this.bishaEffects[id] = eff;
        this.effectTex.set(id, texs);
      }
      // 横幅常驻位：PNG (0,0) = mc 空间 canvasOrigin → 屏幕逻辑位 = mcPos + canvasOrigin
      //（y 向 mcPosY 随演出更新——原版 100 + 100/zoom 联动，切片 26）
      this.cutinBand.position.set(
        spec.bisha.mc.mcPos[0] + spec.bisha.mc.canvasOrigin[0],
        spec.bisha.mc.mcPos[1] + spec.bisha.mc.canvasOrigin[1],
      );
      for (const atlasId of new Set([
        ...spec.fighters.map((f) => f.atlasId),
        ...(spec.assisters ?? []).map((a) => a.atlasId),
      ])) {
        for (const [faceName, path] of Object.entries(spec.bisha.faces[atlasId] ?? {})) {
          const tex = await Assets.load<Texture>(`${spec.baseUrl}/${path}`);
          this.bishaFaceTex.set(`${atlasId}:${faceName}`, tex);
        }
      }
    } else {
      this.bishaMc = null;
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
    return { root, body, atlasId, loaded, formIndex, appliedPng: -1, appliedFacing: 0 };
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
    for (const ev of snap.events) {
      const key = `${ev.tick}:${ev.type}:${String(ev.payload['id'] ?? '')}`;
      const last = this.lastEventsTick.get(key);
      if (last === ev.tick) continue; // 去重
      this.lastEventsTick.set(key, ev.tick);
      if (ev.type === 'hit:connect') {
        // 最小表现：受击者闪红
        const target = ev.payload['target'];
        const sp = typeof target === 'number' ? this.sprites.get(target) : undefined;
        if (sp) {
          sp.body.tint = 0xff4444;
          setTimeout(() => {
            sp.body.tint = 0xffffff;
          }, 90);
        }
      } else if (ev.type === 'fighter:form') {
        // 万解形态切换：切图集 forms 下标，强制重应用贴图
        const fighter = ev.payload['fighter'];
        const form = ev.payload['form'];
        if (typeof fighter !== 'number' || typeof form !== 'number') continue;
        const sp = this.sprites.get(fighter);
        if (sp && form !== sp.formIndex) {
          sp.formIndex = form;
          sp.appliedPng = -1;
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
    const faceTex = face && atlasId ? (this.bishaFaceTex.get(`${atlasId}:${face}`) ?? null) : null;
    // 横幅 y 联动（原版 showBishaFace：100 + 100/zoom，zoom = 演出开始时的相机目标因子）
    const mcPosY = 100 + 100 / this.zoomTarget;
    this.cutin = { active: true, faceName: face, faceTex, slot, mcPosY, accMs: 0, frame: 0 };
    this.cutinBand.position.set(
      this.bishaMc!.mcPos[0] + this.bishaMc!.canvasOrigin[0],
      mcPosY + this.bishaMc!.canvasOrigin[1],
    );
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
    // 锁存在但无演出信息（如联机中途入局错过事件）：只显示黑幕+横幅
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
      this.cutinBand.position.set(
        mc.mcPos[0] + mc.canvasOrigin[0],
        this.cutin.mcPosY + mc.canvasOrigin[1],
      );
    }
    const c = this.cutin;
    c.accMs += dtMs;
    c.frame = Math.min(1 + Math.floor(c.accMs / (1000 / mc.fps)), mc.frames - 1);
    // 横幅流帧（0-based 帧 f ↔ 文件 f+1；帧 0 为 gotoAndPlay(2) 前的白屏态，不显示）
    const bandTex = this.bishaBandTex[c.frame];
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
    // 锚 = transformationPoint（缩放绕点）；position = W_T - canvasOrigin + mcPos
    const [wx = 0, wy = 0, sx = 1, sy = 1, ro = 0, go = 0, bo = 0, al = 1] = s;
    this.cutinFace.visible = true;
    this.cutinFace.texture = tex;
    this.cutinFace.anchor.set(mc.faceAnchor[0] / mc.faceSize[0], mc.faceAnchor[1] / mc.faceSize[1]);
    this.cutinFace.position.set(
      mc.mcPos[0] + wx - mc.canvasOrigin[0],
      c.mcPosY + wy - mc.canvasOrigin[1],
    );
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

  /** 每渲染帧调用：插值推进。dtMs 自上次调用以来的毫秒数。 */
  update(dtMs: number): void {
    if (!this.next) return;
    this.accMs = Math.min(this.accMs + dtMs, TICK_MS);
    const alpha = this.accMs / TICK_MS;
    const prev = this.prev!;
    const next = this.next;

    // —— 战斗体：位置插值，朝向/动画帧取最新 ——
    for (const f of next.state.fighters) {
      const sp = this.sprites.get(f.id);
      if (!sp) continue;
      const p = prev.state.fighters.find((x) => x.id === f.id) ?? f;
      const ix = p.x + (f.x - p.x) * alpha;
      const iy = p.y + (f.y - p.y) * alpha;

      sp.root.position.set(ix, iy);
      if (sp.appliedFacing !== f.facing) {
        sp.root.scale.x = f.facing;
        sp.appliedFacing = f.facing;
      }
      // 内层帧 = 最新快照
      this.applyFrame(sp, f.actLabel !== null ? f.animFrame : 0);
    }

    this.updateAttackers(prev, next, alpha);
    this.updateBullets(prev, next, alpha);
    this.updateAssisters(prev, next, alpha);
    this.updateMcEffects(dtMs);
    this.updateCutin(next, dtMs);
    this.updateCamera(next, dtMs);
    this.updateHud(next);
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
      return;
    }
    const form = sp.loaded.atlas.forms[sp.formIndex];
    const frame = form?.frames[animFrame - 1];
    if (!frame || frame.png < 0) {
      sp.body.visible = false;
      return;
    }
    const tex = frameTexture(sp.loaded, frame.png);
    if (!tex) {
      sp.body.visible = false;
      return;
    }
    sp.body.visible = true;
    sp.body.texture = tex;
    // frame.x/y = 内容相对 root 原点偏移（root 原点 = 角色坐标，翻转绕原点）
    sp.body.position.set(frame.x ?? 0, frame.y ?? 0);
  }

  /**
   * 相机（切片 26 对齐原版 GameCamera）：
   *   - 双焦点（常态）：中心 = 双方中点；自适应缩放 = 原版 renderTwo autoZoom
   *     `zoom = min(visW/distX, visH/distY)×0.8` clamp [1, 2.5]（autoZoomMin/Max =
   *     initCamera 真值）——双方拉开拉远镜头、贴身推近；
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
    const visW = this.viewW / fitZoom;
    const visH = this.viewH / fitZoom;

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
        const zx = distX > 0 ? visW / distX : Infinity;
        const zy = distY > 0 ? visH / distY : Infinity;
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

  private hudGfx: Graphics | null = null;

  private updateHud(snap: SimSnapshot): void {
    if (!this.hudGfx) {
      this.hudGfx = new Graphics();
      this.hudLayer.addChild(this.hudGfx);
    }
    const g = this.hudGfx;
    g.clear();
    // 屏幕空间固定 HUD：血条 + 气 + 回合计数
    const pad = 24;
    const barW = 340;
    const fs = snap.state.fighters;
    fs.forEach((f, idx) => {
      const left = idx === 0;
      const x0 = left ? pad : this.viewW - pad - barW;
      const y0 = pad + idx * 44;
      const hpRatio = Math.max(0, f.hp / 1000);
      const qiRatio = Math.min(1, f.qi / 300);
      // 底
      g.rect(x0, y0, barW, 14).fill(0x000000, 0.45);
      g.rect(x0 + 2, y0 + 2, (barW - 4) * hpRatio, 10).fill(left ? 0x4fc3f7 : 0xff7043, 1);
      g.rect(x0, y0 + 18, barW * 0.6, 6).fill(0x000000, 0.45);
      g.rect(x0 + 1, y0 + 19, (barW * 0.6 - 2) * qiRatio, 4).fill(0xffd54f, 1);
    });
    const m = snap.state.match;
    g.rect(this.viewW / 2 - 60, pad, 120, 26).fill(0x000000, 0.5);
    if (!this.roundText) {
      this.roundText = new Text('', { fontFamily: 'monospace', fontSize: 18, fill: 0xffffff });
      this.roundText.anchor.set(0.5);
      this.roundText.position.set(this.viewW / 2, pad + 13);
      this.hudLayer.addChild(this.roundText);
    }
    this.roundText.text = `R${m.round}  ${m.p1Wins} - ${m.p2Wins}`;
    this.roundText.visible = true;
  }

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
    for (const sp of this.bulletSprites.values()) sp.root.destroy({ children: true });
    this.bulletSprites.clear();
    for (const sp of this.attackerSprites.values()) sp.root.destroy({ children: true });
    this.attackerSprites.clear();
    for (const e of this.mcEffects) e.root.destroy({ children: true });
    this.mcEffects = [];
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
