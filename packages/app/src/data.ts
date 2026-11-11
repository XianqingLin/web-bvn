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

// ---------- 角色包 ----------

export interface FighterPack {
  id: string;
  /** def = forms[formIndex]（切片 10 多形态） */
  def: import('@bvn/core').FighterDef;
  forms: import('@bvn/core').FighterDef[];
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
  return { id, def, forms, hasFires: fires !== null };
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
