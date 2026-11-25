/**
 * baked 数据装配助手（app 各场景共用；与 tools/replay 同一编译接线）。
 * 路径约定：dev（vite root = 仓库根）用 /packages/data/… 绝对路径；
 * 构建（base './'，嵌平台 /g/bvn/）用相对路径，dist 下自带 packages/data/baked、
 * packages/data/assets（assets 为指向真实资源目录的 junction，见 scripts/prepare-dist.mjs）。
 */
import {
  compileAssistant,
  compileFighterForms,
  compileFighterRuntime,
  compileMapStage,
} from '@bvn/data';
import type { Ctx } from './host.js';

const DATA_BASE = import.meta.env.BASE_URL;
export const BAKED = `${DATA_BASE}packages/data/baked`;
export const ASSETS = `${DATA_BASE}packages/data/assets`;

// ---------- select.json（tools/select-pack 产物，schema bvn/select@1） ----------

export interface SelectEntry {
  id: string;
  name: string;
  /** 0=死神 1=火影 -1=随机全池（random 项） */
  comicType: number;
  row: number;
  col: number;
  /** 原版网格像素偏移 "dx,dy"（未用，保留布局信息） */
  offset: string | null;
  /** 形态切换目标 id（原版 more=；选人页未实现切换，仅保留） */
  more: string | null;
  /** 共用 swf 基名（fighter.xml file url；形态角色如 sasuke_juin → sasuke，
   *  XFL/fire/语音/贴帧音按此寻址，图集按 id 自寻；随机项 null） */
  swf: string | null;
  /** 原版进场形态帧（fighter.xml startFrame；缺省 1 = 首含动画形态） */
  startFrame: number;
}

export interface SelectData {
  schema: string;
  chars: SelectEntry[];
  assists: SelectEntry[];
  maps: { id: string; name: string }[];
}

export function loadSelect(ctx: Ctx): Promise<SelectData> {
  return ctx.assets.json<SelectData>(`${BAKED}/select.json`);
}

// ---------- ui.json（tools/ui-pack 产物 + tools/stream-sheet --ui 拼图清单 + tools/stream-dedup 帧去重；schema bvn/ui@8，拼图后 @9，帧去重后 @10；切片 15/45/46/设置面板切片） ----------

export interface UiSelectData {
  elements: Record<string, string>;
  /** 光标 PNG 原点相对格子位偏移 */
  cursorOffset: [number, number];
  /** 地图面板：缩略图/kuang 相对 select_map.png 左上角（450×240 缩略图） */
  mapPicOffset: [number, number];
  mapKuangOffset: [number, number];
  mapTextPos: [number, number];
  /** 展示框大头像 ct 偏移；P2 镜像容器原点 */
  faceBigOffset: [number, number];
  faceBigP2Origin: [number, number];
  /** 展示框位置（原版 800×600 舞台坐标） */
  selectedPos: { p1: [number, number]; p2: [number, number] };
  /** 地图面板位置（原版 800×600 舞台坐标） */
  mapPanelPos: [number, number];
  /** 原版 select_config 布局（格子起点/间距由行列数推导） */
  layout: {
    stage: [number, number];
    gridOrigin: [number, number];
    gridPadding: { left: number; right: number; top: number; bottom: number };
    unit: [number, number];
  };
  /** 切片 45：旋涡背景叠加层（pos = stg_select.png 内锚点 px，scale 拉伸；红通道烘焙期清零）
   *  map = 帧去重映射（tools/stream-dedup：槽位 → 磁盘帧号），下同 */
  vortex: {
    char: number;
    dir: string;
    frames: number;
    fps: number;
    size: [number, number];
    pos: [number, number];
    scale: [number, number];
    map?: number[];
  } | null;
  /** 切片 45：地图面板 fx（pos = select_map.png 内锚点；scale[0]<0 = 镜像，锚点为可见区右缘） */
  mapFx: {
    char: number;
    depth: number;
    dir: string;
    frames: number;
    fps: number;
    size: [number, number];
    pos: [number, number];
    scale: [number, number];
    map?: number[];
    /** Tier 2 tween 化（DESIGN §4.8）：单贴图 + 内部补间替代帧流 */
    tween?: import('./scenes/fx.js').FxTweenSpec;
  }[];
}

export interface UiData {
  schema: string;
  /** 头像类名 → assets/ui/faces/ 下文件名（grid = id，大头像 = id_b） */
  faces: Record<string, string>;
  select: UiSelectData;
  maps: { dir: string };
  /** 切片 16：title 开场流帧（原版 stg_title 帧脚本语义）；切片 46：三层夹心规格 */
  title: {
    dir: string;
    /** 顶板（d>25：logo 文字/下载徽标/白闪/©，色变换由 FFDec 烘死） */
    topDir: string;
    frames: number;
    fps: number;
    /** 帧去重映射（tools/stream-dedup：槽位 → 磁盘帧号；底/顶板各一份） */
    map?: number[];
    topMap?: number[];
    /** 板画布原点（板各自内容 union 左上 ≠ 原板，运行时按各自原点挂载） */
    stageOriginInFrame: [number, number];
    topStageOriginInFrame: [number, number];
    introFrom: number;
    introStop: number;
    menuFrame: number;
    menuStop: number;
    /** fx 叠加层（2026-11-24 纯构造，见 ui-pack 3b 头注；2026-11-25 增流帧拼图清单） */
    fx: {
      elements: Record<
        string,
        {
          dir: string;
          frames: number;
          fps: number;
          size: [number, number];
          origin: [number, number];
          /** 流帧拼图清单（tools/stream-sheet --ui 产物）；缺省 = 无清单，走逐帧回退 */
          sheets?: import('@bvn/render').StreamSheetSpec;
          /** 帧去重映射（tools/stream-dedup：槽位 → 磁盘帧号） */
          map?: number[];
          /** Tier 2 tween 化（DESIGN §4.8）：单贴图 + 内部补间替代帧流 */
          tween?: import('./scenes/fx.js').FxTweenSpec;
        }
      >;
      instances: {
        char: number;
        depth: number;
        from: number;
        to: number;
        /** [(from,to,x,y,sx,sy,alpha)]，stg_title 局部坐标（= 原版舞台坐标） */
        keys: [number, number, number, number, number, number, number][];
      }[];
    };
  };
  /** 切片 16：主菜单按钮（原版 MenuBtnGroup/MenuBtn 规格） */
  menu: {
    elements: Record<string, string>;
    groupPos: [number, number];
    xadd: number;
    yadd: number;
    btnHeight: number;
    childHeight: number;
    bgOffset: [number, number];
    cnTextPos: [number, number];
    versionPad: [number, number];
  };
  /** 切片 29：logo 开场徽标演出（原版 LogoStage：gotoAndPlay(2) 播到帧 66 COMPLETE → 进菜单）。
   *  Tier 2 tween 化（DESIGN §4.8）：逐帧流已收编为单贴图 + alpha 关键帧补间。 */
  logo: {
    frames: number;
    fps: number;
    from: number;
    stop: number;
    stageOriginInFrame: [number, number];
    /** 单贴图（恒等定格帧白底合成，assets/ 下路径）+ alpha 关键帧 [帧号(1 起), alpha]
     *  线性插值——从 SWF logo_movie d2 CXFORM 白↔本色互补渐变导出（α = mult/256；
     *  互补渐变作用于压平合成帧与白底上 alpha 淡入淡出逐像素同式）。 */
    tween: { texture: string; keys: [number, number][] };
  };
  /** 设置面板切片：原版 stg_set_ui 单帧静态板（暗化标题版画背景 + OPTION 标题 + 一护立绘；
   *  板画布 = 内容 union，立绘出血越出 800×600 舞台 → 运行时挂 舞台-origin 并裁剪到舞台矩形） */
  setting: {
    dir: string;
    frames: number;
    stageOriginInFrame: [number, number];
    /** 原版箭头/光标元件首帧（origin = 注册点在 PNG 内位置，摆放时以注册点对齐） */
    arrows: Record<'txt_arrow' | 'select_arrow', { file: string; origin: [number, number] }>;
  };
}

export function loadUi(ctx: Ctx): Promise<UiData> {
  return ctx.assets.json<UiData>(`${BAKED}/ui.json`);
}

/** 头像纹理 URL（kind：'' = 50×50 格子头像 / '_b' = 245×62 大头像 / '_m' = 102×64 对局血条脸）。 */
export function uiFaceUrl(ui: UiData, id: string, kind: '' | '_b' | '_m'): string | null {
  const file = ui.faces[id + kind];
  return file ? `${ASSETS}/ui/faces/${file}` : null;
}

// ---------- hud.json（tools/ui-pack/hud-pack 产物，schema bvn/hud@1，切片 30） ----------

export function loadHud(ctx: Ctx): Promise<import('@bvn/render').HudData> {
  return ctx.assets.json<import('@bvn/render').HudData>(`${BAKED}/hud.json`);
}

// ---------- bisha.json（tools/bisha-pack 产物，schema bvn/bisha@3，切片 22） ----------

export interface BishaData {
  schema: string;
  /** mc_016 流帧规格（renderer BishaMcData 结构一致） */
  mc: import('@bvn/render').BishaMcData;
  /** pkgId → faceName → baseUrl 相对路径 */
  faces: Record<string, Record<string, string>>;
  /** 必杀光效 mc 流帧（切片 26；renderer EffectMcData 结构一致） */
  effects: { bisha: import('@bvn/render').EffectMcData; bisha_super: import('@bvn/render').EffectMcData };
}

export function loadBisha(ctx: Ctx): Promise<BishaData> {
  return ctx.assets.json<BishaData>(`${BAKED}/bisha.json`);
}

// ---------- hitspark.json（tools/hit-pack 产物，schema bvn/hitspark@2，修复批次 35） ----------

/** 命中/防御火花烘焙包（renderer HitsparkBaked 结构一致）。 */
export type HitsparkData = import('@bvn/render').HitsparkBaked;

export function loadHitspark(ctx: Ctx): Promise<HitsparkData> {
  return ctx.assets.json<HitsparkData>(`${BAKED}/hitspark.json`);
}

// ---------- audio.json（tools/sound-pack 产物，schema bvn/audio@1，切片 27） ----------

export interface AudioManifest {
  schema: string;
  se: { hit1: string; hit2: string; step: string[] };
  swc: Record<string, string>;
  fx: Record<string, string>;
  bgm: Record<string, string>;
  fighterBgm: Record<string, { url: string; rate: number }>;
  mapBgm: Record<string, string>;
  hit: { byType: Record<string, string>; blocked: Record<string, string>; steel: string; guardBreak: string };
  effectSound: Record<string, string>;
  /** 开场/结算字样播报音（banner 段，批次 62）：bannerRound/bannerFight/... → 文件 */
  banner: Record<string, string>;
  /** swf 基名 → 命名音类 → 文件（forms.sounds 引用按此解析） */
  voices: Record<string, Record<string, string>>;
}

export function loadAudio(ctx: Ctx): Promise<AudioManifest> {
  return ctx.assets.json<AudioManifest>(`${BAKED}/audio.json`);
}

// ---------- timeline-sounds.json（tools/sound-pack/frame-sounds 产物，切片 28；
//            批次 62 寻址改 `<kind>/<id>`：fighter/assistant 基名 16 处相同，裸 id 互覆） ----------

/** 单帧贴帧音条目（sid = SWF DefineSound characterId）。 */
export interface TimelineSoundEntry {
  sid: number;
  /** 重播次数（原版 SoundInfo LoopCount；>1 才写出，语料仅 1 例） */
  loops?: number;
}

/** 角色包：formIndex → 帧 → 条目[]；辅助包：root 帧 → 条目[]。 */
export type TimelinePackage = {
  forms?: Record<string, Record<string, TimelineSoundEntry[]>>;
  root?: Record<string, TimelineSoundEntry[]>;
};

export interface TimelineSoundsManifest {
  schema: string;
  /** 键 = `<kind>/<swfId>`（kind: fighter|assister） */
  packages: Record<string, TimelinePackage>;
  /** `<kind>/<swfId>/<sid>` → 音频 url（assets/audio 相对路径） */
  files: Record<string, string>;
}

export function loadTimelineSounds(ctx: Ctx): Promise<TimelineSoundsManifest> {
  return ctx.assets.json<TimelineSoundsManifest>(`${BAKED}/timeline-sounds.json`);
}

// ---------- loading.json（tools/ui-pack/loading-pack 产物，schema bvn/loading@2，切片 31） ----------

/** 进战斗加载画面（原版 LoadingStage/loading_fight_mc 规格；坐标 = 800×600 舞台 px）。 */
export interface LoadingData {
  schema: string;
  bg: { url: string; size: [number, number] };
  /** 游戏初始化封面（原版 GameLoadingStage/loading_cover_mc = cover_bgimg + 同款 bar） */
  cover: { url: string; size: [number, number]; /** 封面内 loadingbar_mc 摆放位 */ barPos: [number, number] };
  /** 加载页选人面板角标（原版 seltwzmc：帧 1..3 = 1st/2nd/3rd 位次，帧 4 = assist） */
  seltwz: { dir: string; frames: number };
  bar: {
    pos: [number, number];
    track: { url: string; pos: [number, number]; size: [number, number] };
    fill: { url: string; pos: [number, number]; size: [number, number] };
    spin: { dir: string; pos: [number, number]; size: [number, number]; center: [number, number]; frames: number; fps: number };
    label: { url: string; pos: [number, number]; size: [number, number] };
    /** 动态消息文本（原版 bar.txt：右对齐 14px 青 #00daf8） */
    txt: { rightEdge: number; centerY: number; size: number; color: string };
  };
}

export function loadLoading(ctx: Ctx): Promise<LoadingData> {
  return ctx.assets.json<LoadingData>(`${BAKED}/loading.json`);
}

// ---------- 角色包 ----------

export interface FighterPack {
  id: string;
  /** 共用 swf 基名（XFL/fire/语音/贴帧音寻址用；基础角色 = id） */
  swf: string;
  /** def = forms[formIndex]（切片 10 多形态） */
  def: import('@bvn/core').FighterDef;
  forms: import('@bvn/core').FighterDef[];
  /** 当前形态语音绑定（forms[formIndex].sounds 原样引用，切片 27 语音消费用） */
  sounds: import('@bvn/data').SoundDefines;
  /** fire 包是否存在（renderer fireAtlases 装配用） */
  hasFires: boolean;
}

/**
 * 角色包装配。swf = 共用 swf 基名（select.json chars[].swf，形态角色 ≠ id）：
 * runtime/图集按形态 id，XFL/fire 按 swf 基名（原版形态角色与基础角色共用同一
 * swf，baked/fighters 与 baked/fires/fighter 只按基名烘焙）。基础角色 swf=id，
 * XFL 包必在；未知 id（无 select 元数据）按 id 兜底。
 * startFrame = 原版进场形态（fighter.xml，58 角色实证：缺省形态 = 含动画
 * 形态中第 startFrame 个；基础角色恒 1，形态角色 >1 决定直接选入时的形态）。
 */
export async function loadFighterPack(
  ctx: Ctx,
  id: string,
  swf = id,
  startFrame = 1,
): Promise<FighterPack> {
  const runtime = await ctx.assets.json<import('@bvn/data').RuntimeFighterPackage>(
    `${BAKED}/fighters-runtime/${id}.json`,
  );
  const xfl = await ctx.assets.jsonOptional<import('@bvn/data').FighterPackage>(
    `${BAKED}/fighters/${swf}.json`,
  );
  const fires = await ctx.assets.jsonOptional<import('@bvn/data').FirePackage>(
    `${BAKED}/fires/fighter/${swf}.json`,
  );
  const xflDef = xfl ?? undefined;
  const forms = compileFighterForms(runtime, xflDef, fires?.fires);
  // 进场形态：含动画形态数组第 startFrame 个（clamp 越界）；sim 侧初始
  // formIndex 用该数组下标，render 初始用 def.formIndex（全数组下标，与图集对齐）
  const def = forms[Math.min(Math.max(startFrame - 1, 0), forms.length - 1)]!;
  return {
    id,
    swf,
    def,
    forms,
    sounds: xfl?.forms[def.formIndex ?? 0]?.sounds ?? {},
    hasFires: fires !== null,
  };
}

// ---------- 辅助包 ----------

export interface AssistPack {
  id: string;
  /** AssisterDef（data.AssisterView 与 core AssisterDef 结构一致） */
  def: import('@bvn/core').AssisterDef;
  hasFires: boolean;
}

export async function loadAssistPack(ctx: Ctx, id: string): Promise<AssistPack> {
  const xfl = await ctx.assets.json<import('@bvn/data').AssistantPackage>(
    `${BAKED}/assistants/${id}.json`,
  );
  const runtime = await ctx.assets.json<import('@bvn/data').RuntimeFighterPackage>(
    `${BAKED}/assistants-runtime/${id}.json`,
  );
  const fires = await ctx.assets.jsonOptional<import('@bvn/data').FirePackage>(
    `${BAKED}/fires/assister/${id}.json`,
  );
  const def: import('@bvn/core').AssisterDef = compileAssistant(xfl, runtime, fires?.fires);
  // comicType 注入（切片 55）：出场特效分流 fz_naruto/fz_bleach（原版
  // assistant.xml comic_type → select.json assists[].comicType；缺省 = 死神侧）
  const select = await ctx.assets.jsonOptional<SelectData>(`${BAKED}/select.json`);
  const comicType = select?.assists.find((a) => a.id === id)?.comicType;
  if (comicType === 1) def.comicType = 1;
  return { id, def, hasFires: fires !== null };
}

// ---------- 地图包 ----------

export interface MapPack {
  id: string;
  pkg: import('@bvn/data').MapPackage;
  stage: import('@bvn/data').StageView;
  p1Spawn: { x: number; y: number } | null;
  p2Spawn: { x: number; y: number } | null;
}

export async function loadMapPack(ctx: Ctx, id: string): Promise<MapPack> {
  const pkg = await ctx.assets.json<import('@bvn/data').MapPackage>(`${BAKED}/maps/${id}.json`);
  const { stage, p1Spawn, p2Spawn } = compileMapStage(pkg);
  return { id, pkg, stage, p1Spawn, p2Spawn };
}
