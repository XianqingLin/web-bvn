/**
 * Node 侧烘焙数据加载器（读文件 + 校验，errors 非空即抛）。
 *
 * 单独入口 `@bvn/data/node`：主入口保持浏览器可用（无 node:fs）。
 * core 不使用本文件（core 禁 I/O，数据经 SimConfig 注入）；
 * 调用方：tools/replay、（未来的）app 资源装载、测试。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AssistantPackage,
  FighterPackage,
  FirePackage,
  MapPackage,
  RuntimeFighterPackage,
} from './types.js';
import type { FighterAtlas, FireAtlas, MapAtlas } from './assets.js';
import {
  validateAssistantPackage,
  validateFighterPackage,
  validateFirePackage,
  validateMapPackage,
  validateRuntimeFighterPackage,
  type ValidationResult,
} from './validate.js';
import { validateFighterAtlas, validateFireAtlas, validateMapAtlas } from './assets.js';

function readValidated<T>(path: string, schema: string, validate: (pkg: T) => ValidationResult): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`baked 数据读取失败: ${path} :: ${(e as Error).message}`);
  }
  const pkg = parsed as T;
  if ((pkg as { schema?: string }).schema !== schema) {
    throw new Error(`${path}: schema 应为 "${schema}"，收到 "${(pkg as { schema?: string }).schema}"`);
  }
  const res = validate(pkg);
  if (res.errors.length > 0) {
    throw new Error(`${path} 校验失败:\n  ${res.errors.join('\n  ')}`);
  }
  return pkg as T;
}

/** 加载并校验地图包（baked/maps/<id>.json，schema bvn/map@1）。 */
export function loadMapPackage(bakedDir: string, id: string): MapPackage {
  return readValidated(
    join(bakedDir, 'maps', `${id}.json`),
    'bvn/map@1',
    validateMapPackage,
  );
}

/** 加载并校验运行时角色/辅助包（schema bvn/fighter-runtime@1）。 */
export function loadRuntimeFighterPackage(
  bakedDir: string,
  id: string,
  kind: 'fighters-runtime' | 'assistants-runtime',
): RuntimeFighterPackage {
  return readValidated(
    join(bakedDir, kind, `${id}.json`),
    'bvn/fighter-runtime@1',
    validateRuntimeFighterPackage,
  );
}

/** 加载并校验 XFL 静态角色包（schema bvn/fighter@1）。 */
export function loadFighterPackage(bakedDir: string, id: string): FighterPackage {
  return readValidated(
    join(bakedDir, 'fighters', `${id}.json`),
    'bvn/fighter@1',
    validateFighterPackage,
  );
}

/** 加载并校验 XFL 静态辅助包（schema bvn/assistant@1）。 */
export function loadAssistantPackage(bakedDir: string, id: string): AssistantPackage {
  return readValidated(
    join(bakedDir, 'assistants', `${id}.json`),
    'bvn/assistant@1',
    validateAssistantPackage,
  );
}

/** 加载并校验角色/辅助图集（assets/<kind>/<id>.atlas.json，schema bvn/atlas@1）。 */
export function loadFighterAtlas(assetsDir: string, id: string, kind: 'fighters' | 'assistants'): FighterAtlas {
  return readValidated<FighterAtlas>(
    join(assetsDir, kind, `${id}.atlas.json`),
    'bvn/atlas@1',
    validateFighterAtlas,
  );
}

/** 加载并校验地图图集（assets/maps/<id>.atlas.json，schema bvn/map-atlas@1）。 */
export function loadMapAtlas(assetsDir: string, id: string): MapAtlas {
  return readValidated<MapAtlas>(
    join(assetsDir, 'maps', `${id}.atlas.json`),
    'bvn/map-atlas@1',
    validateMapAtlas,
  );
}

/** 加载并校验 fire 元数据包（baked/fires/<ownerKind>/<id>.json，schema bvn/fire@1）。 */
export function loadFirePackage(
  bakedDir: string,
  ownerKind: 'fighter' | 'assister',
  id: string,
): FirePackage {
  return readValidated<FirePackage>(
    join(bakedDir, 'fires', ownerKind, `${id}.json`),
    'bvn/fire@1',
    validateFirePackage,
  );
}

/** 加载并校验 fire 元件图集（assets/fires/<ownerKind>/<id>.atlas.json，schema bvn/fire-atlas@1）。 */
export function loadFireAtlas(
  assetsDir: string,
  ownerKind: 'fighter' | 'assister',
  id: string,
): FireAtlas {
  return readValidated<FireAtlas>(
    join(assetsDir, 'fires', ownerKind, `${id}.atlas.json`),
    'bvn/fire-atlas@1',
    validateFireAtlas,
  );
}
