/**
 * 图集类型（DESIGN §4"图集"）：tools/atlas-pack 的产物 schema。
 *
 * bvn/atlas@1      角色/辅助：唯一帧装进 sheet，帧引用 pngId → sheet 内 quad；
 *                  forms[i].frames[j] = 内层动画帧 → {png, x, y}（x/y = 内容
 *                  相对角色 root 原点的偏移，root 原点 = 引擎角色坐标，
 *                  翻转绕原点 —— 与 BaseGameSprite 一致）。
 * bvn/map-atlas@1  地图：每子图层一张 PNG + 相对地图 root 的偏移。
 *
 * 图集是表现资源，不进 sim、不影响确定性。
 */

export interface AtlasQuad {
  sheet: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 帧内混合模式子对象（批次 37：Flash blendMode 元件单独采集，渲染层对场景混合） */
export interface AtlasFramePart {
  png: number;
  /** 内容左上角相对角色 root 原点的偏移（root 局部坐标，同 base png） */
  x?: number;
  y?: number;
  /** Flash blendMode 原词（darken/screen/multiply/lighten/subtract/hardlight/…） */
  blend: string;
}

export interface AtlasFrameRef {
  /** 内层动画帧号（1 起）；png=-1 表示该帧无可见内容 */
  frame: number;
  png: number;
  /** 内容左上角相对角色 root 原点的偏移（root 局部坐标） */
  x?: number;
  y?: number;
  /** Flash 混合模式子对象（顶层 blendMode ≠ normal/layer；采集时拆出整帧合成） */
  parts?: AtlasFramePart[];
}

export interface AtlasForm {
  /** 角色形态对应的 root 时间轴帧号（1 起） */
  rootFrame: number;
  frames: AtlasFrameRef[];
}

export interface FighterAtlas {
  schema: 'bvn/atlas@1';
  kind: 'fighter' | 'assister';
  id: string;
  sheets: { file: string; w: number; h: number }[];
  /** pngId → sheet 内 quad */
  frames: Record<string, AtlasQuad>;
  forms: AtlasForm[];
}

export interface MapAtlasLayer {
  name: string;
  png: number;
  file: string;
  w: number;
  h: number;
  /** 图层 display 原点相对地图 root 的偏移 */
  x: number;
  y: number;
  /** 内容 bounds 相对图层自身原点的偏移（内容左上角 = root 局部 (x+bx, y+by)） */
  bx: number;
  by: number;
}

export interface MapAtlas {
  schema: 'bvn/map-atlas@1';
  kind: 'map';
  id: string;
  layers: MapAtlasLayer[];
}

/** fire 元件渲染数据（bvn/fire-atlas@1 的 fires 表项）。 */
export interface FireElementAtlas {
  /** 元件摆放在内层时间轴上的坐标（渲染容器锚定用） */
  rootX: number;
  rootY: number;
  totalFrames: number;
  labels: Record<string, number>;
  /** 'main' 子对象 bounds（原版 Bullet._bulletArea 锚；无 main = 0 矩形） */
  main: { x: number; y: number; w: number; h: number };
  frames: AtlasFrameRef[];
}

/** fire 元件图集（assets/fires/<ownerKind>/<id>.atlas.json，bvn/fire-atlas@1）。 */
export interface FireAtlas {
  schema: 'bvn/fire-atlas@1';
  kind: 'fire';
  ownerKind: 'fighter' | 'assister';
  id: string;
  sheets: { file: string; w: number; h: number }[];
  /** pngId → sheet 内 quad */
  frames: Record<string, AtlasQuad>;
  fires: Record<string, FireElementAtlas>;
}

export function validateFireAtlas(pkg: unknown): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const a = pkg as FireAtlas;
  if (a.schema !== 'bvn/fire-atlas@1') errors.push(`schema 应为 bvn/fire-atlas@1，收到 ${a.schema}`);
  if (a.ownerKind !== 'fighter' && a.ownerKind !== 'assister') {
    errors.push(`ownerKind 非法: ${a.ownerKind}`);
  }
  if (!Array.isArray(a.sheets) || a.sheets.length === 0) errors.push('sheets 为空');
  if (!a.frames || typeof a.frames !== 'object') errors.push('frames 缺失');
  if (!a.fires || typeof a.fires !== 'object') errors.push('fires 缺失');
  const pngIds = new Set(Object.keys(a.frames ?? {}));
  for (const [nm, el] of Object.entries(a.fires ?? {})) {
    if (!el.frames) {
      errors.push(`fire ${nm} 缺 frames`);
      continue;
    }
    for (const fr of el.frames) {
      if (fr.png >= 0 && !pngIds.has(String(fr.png))) {
        errors.push(`fire ${nm} frame ${fr.frame} 引用不存在的 png ${fr.png}`);
      }
    }
  }
  return { errors, warnings };
}

export function validateFighterAtlas(pkg: unknown): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const a = pkg as FighterAtlas;
  if (a.schema !== 'bvn/atlas@1') errors.push(`schema 应为 bvn/atlas@1，收到 ${a.schema}`);
  if (a.kind !== 'fighter' && a.kind !== 'assister') errors.push(`kind 非法: ${a.kind}`);
  if (!Array.isArray(a.sheets) || a.sheets.length === 0) errors.push('sheets 为空');
  if (!a.frames || typeof a.frames !== 'object') errors.push('frames 缺失');
  if (!Array.isArray(a.forms)) errors.push('forms 缺失');
  const pngIds = new Set(Object.keys(a.frames ?? {}));
  for (const f of a.forms ?? []) {
    for (const fr of f.frames) {
      if (fr.png >= 0 && !pngIds.has(String(fr.png))) {
        errors.push(`form ${f.rootFrame} frame ${fr.frame} 引用不存在的 png ${fr.png}`);
      }
      if (fr.png >= 0 && (fr.x === undefined || fr.y === undefined)) {
        errors.push(`form ${f.rootFrame} frame ${fr.frame} 缺 bounds 偏移 x/y`);
      }
      for (const part of fr.parts ?? []) {
        if (part.png >= 0 && !pngIds.has(String(part.png))) {
          errors.push(`form ${f.rootFrame} frame ${fr.frame} part 引用不存在的 png ${part.png}`);
        }
        if (part.png >= 0 && (part.x === undefined || part.y === undefined)) {
          errors.push(`form ${f.rootFrame} frame ${fr.frame} part 缺 bounds 偏移 x/y`);
        }
        if (typeof part.blend !== 'string' || part.blend.length === 0) {
          errors.push(`form ${f.rootFrame} frame ${fr.frame} part 缺 blend`);
        }
      }
    }
  }
  return { errors, warnings };
}

export function validateMapAtlas(pkg: unknown): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const a = pkg as MapAtlas;
  if (a.schema !== 'bvn/map-atlas@1') errors.push(`schema 应为 bvn/map-atlas@1，收到 ${a.schema}`);
  if (!Array.isArray(a.layers)) errors.push('layers 缺失');
  for (const ly of a.layers ?? []) {
    if (!ly.file) errors.push(`layer ${ly.name} 缺 file`);
  }
  return { errors, warnings };
}
