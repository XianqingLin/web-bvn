/**
 * 图集 → Pixi 纹理：加载 sheet PNG + 按 quad 建 Texture 缓存。
 */
import { Assets, Rectangle, Texture } from 'pixi.js';
import type { FighterAtlas, FireAtlas, MapAtlas } from '@bvn/data';
import type { StreamSheetSpec } from './renderer/types.js';

export interface LoadedFighterAtlas {
  atlas: FighterAtlas;
  /** pngId → frame 纹理（惰性建） */
  textures: Map<number, Texture>;
  sources: Texture['source'][];
}

/** 加载一个角色/辅助图集（atlas JSON + 全部 sheet）。 */
export async function loadFighterAtlas(
  baseUrl: string,
  atlas: FighterAtlas,
): Promise<LoadedFighterAtlas> {
  // 并行加载：sheet 数量多（主力角色 20+ 张），串行 fetch+解码拖慢进入对局
  const sources: Texture['source'][] = await Promise.all(
    atlas.sheets.map((s) => Assets.load<Texture>(`${baseUrl}/${s.file}`).then((t) => t.source)),
  );
  return { atlas, textures: new Map(), sources };
}

export function frameTexture(loaded: LoadedFighterAtlas | LoadedFireAtlas, pngId: number): Texture | null {
  const cached = loaded.textures.get(pngId);
  if (cached !== undefined) return cached;
  const quad = loaded.atlas.frames[String(pngId)];
  if (!quad) return null;
  const source = loaded.sources[quad.sheet];
  if (!source) return null;
  const tex = new Texture({
    source,
    frame: new Rectangle(quad.x, quad.y, quad.w, quad.h),
  });
  loaded.textures.set(pngId, tex);
  return tex;
}

export interface LoadedMapAtlas {
  atlas: MapAtlas;
  /** layer index → 纹理 */
  textures: Texture[];
}

export interface LoadedFireAtlas {
  atlas: FireAtlas;
  /** pngId → frame 纹理（惰性建，与角色图集同缓存模式） */
  textures: Map<number, Texture>;
  sources: Texture['source'][];
}

/** 加载 fire 元件图集（atlas JSON + 全部 sheet）。 */
export async function loadFireAtlas(baseUrl: string, atlas: FireAtlas): Promise<LoadedFireAtlas> {
  const sources: Texture['source'][] = await Promise.all(
    atlas.sheets.map((s) => Assets.load<Texture>(`${baseUrl}/${s.file}`).then((t) => t.source)),
  );
  return { atlas, textures: new Map(), sources };
}

/** 加载地图图集（每子图层一张 PNG）。 */
export async function loadMapAtlas(baseUrl: string, atlas: MapAtlas): Promise<LoadedMapAtlas> {
  const textures: Texture[] = await Promise.all(
    atlas.layers.map((ly) => Assets.load<Texture>(`${baseUrl}/${ly.file}`)),
  );
  return { atlas, textures };
}

/**
 * 流帧拼图装载（tools/stream-sheet 清单，2026-11-22 战斗加载降请求）：
 * 并行拉 sheet（请求数 1:N），逐帧在共享 sheet 源上建 cell 尺寸的 quad 纹理——
 * 输出 Texture[] 形状与逐帧装载一致，消费端无感。onEach 逐帧回调
 * （加载页进度条语义保持"按帧数 tick"，total 分母不变）。
 */
export async function loadSheetFrames(
  baseUrl: string,
  dir: string,
  spec: StreamSheetSpec,
  frames: number,
  onEach?: () => void,
): Promise<Texture[]> {
  const sources = await Promise.all(
    spec.sheets.map((s) => Assets.load<Texture>(`${baseUrl}/${dir}/${s}`).then((t) => t.source)),
  );
  const [w, h] = spec.cell;
  const out = new Array<Texture>(frames);
  for (let i = 0; i < frames; i++) {
    const [si, x, y] = spec.cells[i]!;
    out[i] = new Texture({ source: sources[si]!, frame: new Rectangle(x, y, w, h) });
    onEach?.();
  }
  return out;
}
