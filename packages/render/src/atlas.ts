/**
 * 图集 → Pixi 纹理：加载 sheet PNG + 按 quad 建 Texture 缓存。
 */
import { Assets, Rectangle, Texture } from 'pixi.js';
import type { FighterAtlas, MapAtlas } from '@bvn/data';

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

export function frameTexture(loaded: LoadedFighterAtlas, pngId: number): Texture | null {
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

/** 加载地图图集（每子图层一张 PNG）。 */
export async function loadMapAtlas(baseUrl: string, atlas: MapAtlas): Promise<LoadedMapAtlas> {
  const textures: Texture[] = await Promise.all(
    atlas.layers.map((ly) => Assets.load<Texture>(`${baseUrl}/${ly.file}`)),
  );
  return { atlas, textures };
}
