/**
 * baked 数据装配助手（app 各场景共用；与 tools/replay 同一编译接线）。
 * 路径约定：vite root = 仓库根，baked/assets 以 /packages/data/… 静态可 fetch。
 */
import {
  compileAssistant,
  compileFighterForms,
  compileFighterRuntime,
  compileMapStage,
} from '@bvn/data';
import type { Ctx } from './host.js';

export const BAKED = '/packages/data/baked';
export const ASSETS = '/packages/data/assets';

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

// ---------- ui.json（tools/ui-pack 产物，schema bvn/ui@1，切片 15） ----------

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
}

export interface UiData {
  schema: string;
  /** 头像类名 → assets/ui/faces/ 下文件名（grid = id，大头像 = id_b） */
  faces: Record<string, string>;
  select: UiSelectData;
  maps: { dir: string };
  /** 切片 16：title 开场流帧（原版 stg_title 帧脚本语义） */
  title: {
    dir: string;
    frames: number;
    fps: number;
    /** 帧 PNG 内原版舞台 (0,0) 位置 */
    stageOriginInFrame: [number, number];
    introFrom: number;
    introStop: number;
    menuFrame: number;
    menuStop: number;
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
}

export function loadUi(ctx: Ctx): Promise<UiData> {
  return ctx.assets.json<UiData>(`${BAKED}/ui.json`);
}

/** 头像纹理 URL（kind：'' = 50×50 格子头像 / '_b' = 245×62 大头像）。 */
export function uiFaceUrl(ui: UiData, id: string, kind: '' | '_b'): string | null {
  const file = ui.faces[id + kind];
  return file ? `${ASSETS}/ui/faces/${file}` : null;
}

// ---------- bisha.json（tools/bisha-pack 产物，schema bvn/bisha@1，切片 22） ----------

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
  /** swf 基名 → 命名音类 → 文件（forms.sounds 引用按此解析） */
  voices: Record<string, Record<string, string>>;
}

export function loadAudio(ctx: Ctx): Promise<AudioManifest> {
  return ctx.assets.json<AudioManifest>(`${BAKED}/audio.json`);
}

// ---------- 角色包 ----------

export interface FighterPack {
  id: string;
  /** def = forms[formIndex]（切片 10 多形态） */
  def: import('@bvn/core').FighterDef;
  forms: import('@bvn/core').FighterDef[];
  /** 当前形态语音绑定（forms[formIndex].sounds 原样引用，切片 27 语音消费用） */
  sounds: import('@bvn/data').SoundDefines;
  /** fire 包是否存在（renderer fireAtlases 装配用） */
  hasFires: boolean;
}

export async function loadFighterPack(ctx: Ctx, id: string): Promise<FighterPack> {
  const runtime = await ctx.assets.json<import('@bvn/data').RuntimeFighterPackage>(
    `${BAKED}/fighters-runtime/${id}.json`,
  );
  const xfl = await ctx.assets.json<import('@bvn/data').FighterPackage>(
    `${BAKED}/fighters/${id}.json`,
  );
  const fires = await ctx.assets.jsonOptional<import('@bvn/data').FirePackage>(
    `${BAKED}/fires/fighter/${id}.json`,
  );
  const def = compileFighterRuntime(runtime, xfl, undefined, fires?.fires);
  const forms = compileFighterForms(runtime, xfl, fires?.fires);
  const formIndex = def.formIndex ?? 0;
  return {
    id,
    def,
    forms,
    sounds: xfl.forms[formIndex]?.sounds ?? {},
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
