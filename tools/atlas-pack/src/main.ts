/**
 * tools/atlas-pack —— capture 桥产物 → PixiJS 图集（DESIGN §4"图集"环节）。
 *
 * 输入：~/Documents/bvn-atlas/（tools/atlas-capture 采集产物）
 *   atlas_char_<kind>_<id>.json + png/<kind>_<id>/<n>.png
 *   atlas_map_<id>.json + png/map_<id>/<n>.png
 *
 * 输出：packages/data/assets/
 *   fighters/<id>.atlas.json + <id>.sheet-<n>.png    （bvn/atlas@1）
 *   assistants/<id>.atlas.json + <id>.sheet-<n>.png
 *   maps/<id>.atlas.json + <id>.layer-<k>.png        （bvn/map-atlas@1）
 *
 * 打包：shelf（货架）装箱，2048×2048 上限；唯一帧按 (h 降序, w 降序, id 升序)
 * 排序 —— 顺序固定，重跑输出逐字节一致（图集本身不进 sim，但可复现是底线）。
 *
 * 用法：node dist/main.js [captureDir] [--out <dir>] [--sheet 2048]
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULT_OUT = resolve(ROOT, 'packages/data/assets');

interface CapturePngMeta {
  id: number;
  w: number;
  h: number;
}
interface CaptureFrame {
  frame: number;
  png: number;
  x?: number;
  y?: number;
}
interface CaptureRootFrame {
  rootFrame: number;
  frames: CaptureFrame[];
}
interface CaptureChar {
  kind: string;
  id: string;
  fileUrl: string;
  pngCount: number;
  pngs: CapturePngMeta[];
  rootFrames: CaptureRootFrame[];
}
interface CaptureMapLayer {
  name: string;
  png: number;
  w: number;
  h: number;
  x: number;
  y: number;
  bx: number;
  by: number;
}
interface CaptureMap {
  id: string;
  fileUrl: string;
  layers: CaptureMapLayer[];
}
/** fire 元件采集记录（capFire 产出；missing = 时间轴上未找到） */
interface CaptureFireElem {
  missing?: boolean;
  rootX?: number;
  rootY?: number;
  totalFrames?: number;
  labels?: Record<string, number>;
  main?: { x: number; y: number; w: number; h: number };
  frames?: CaptureFrame[];
}
interface CaptureFire {
  kind: string;
  ownerKind: 'fighter' | 'assister';
  id: string;
  fileUrl: string;
  pngCount: number;
  pngs: CapturePngMeta[];
  fires: Record<string, CaptureFireElem>;
}

interface PlacedFrame {
  sheet: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface AtlasPkg {
  schema: string;
  kind: string;
  id: string;
  sheets: { file: string; w: number; h: number }[];
  frames: Record<string, PlacedFrame>;
  forms: CaptureRootFrame[];
}

interface MapAtlasPkg {
  schema: string;
  kind: 'map';
  id: string;
  layers: (CaptureMapLayer & { file: string })[];
}

/** bvn/fire-atlas@1：fire 元件图集（每个 ownerKind+id 一份） */
interface FireAtlasPkg {
  schema: 'bvn/fire-atlas@1';
  kind: 'fire';
  ownerKind: 'fighter' | 'assister';
  id: string;
  sheets: { file: string; w: number; h: number }[];
  /** pngId → sheet 内 quad */
  frames: Record<string, PlacedFrame>;
  /** 元件名 → 元件级元数据（frames 引用 pngId） */
  fires: Record<
    string,
    {
      rootX: number;
      rootY: number;
      totalFrames: number;
      labels: Record<string, number>;
      main: { x: number; y: number; w: number; h: number };
      frames: CaptureFrame[];
    }
  >;
}

/** bvn/fire@1：baked fire 元数据（core def 注入用，无渲染数据） */
interface FireBakedPkg {
  schema: 'bvn/fire@1';
  kind: 'fire';
  ownerKind: 'fighter' | 'assister';
  id: string;
  fires: Record<string, { totalFrames: number; labels: Record<string, number> }>;
}

function fail(msg: string): never {
  console.error(`atlas-pack: ${msg}`);
  process.exit(2);
}

// ---------- 参数 ----------
const args = process.argv.slice(2);
const positional: string[] = [];
const flags: Record<string, string | true> = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a.startsWith('--')) {
    flags[a.slice(2)] = args[i + 1] && !args[i + 1]!.startsWith('--') ? args[++i]! : true;
  } else {
    positional.push(a);
  }
}
const captureDir = resolve(
  positional[0] ?? join(homedir(), 'Documents', 'bvn-atlas'),
);
const outDir = resolve(typeof flags['out'] === 'string' ? flags['out'] : DEFAULT_OUT);
const SHEET = Number(flags['sheet'] ?? 2048);
if (!Number.isInteger(SHEET) || SHEET < 256) fail('--sheet 必须是 ≥256 的整数');

if (!existsSync(captureDir)) fail(`capture 目录不存在: ${captureDir}`);

// ---------- PNG 解码 ----------
const pngCache = new Map<string, PNG>();
function loadPng(path: string): PNG {
  const cached = pngCache.get(path);
  if (cached) return cached;
  const png = PNG.sync.read(readFileSync(path));
  pngCache.set(path, png);
  return png;
}

// ---------- shelf 装箱 ----------
interface Rect {
  id: number;
  w: number;
  h: number;
}

function pack(items: Rect[], sheetSize: number): {
  sheets: { w: number; h: number; used: (Rect & PlacedFrame)[] }[];
  placements: Map<number, PlacedFrame>;
} {
  const sorted = [...items].sort((a, b) => b.h - a.h || b.w - a.w || a.id - b.id);
  const sheets: { w: number; h: number; used: (Rect & PlacedFrame)[] }[] = [];
  const placements = new Map<number, PlacedFrame>();
  for (const it of sorted) {
    if (it.w > sheetSize || it.h > sheetSize) {
      fail(`帧 ${it.id} 尺寸 ${it.w}x${it.h} 超过 sheet 上限 ${sheetSize}`);
    }
    let placed = false;
    for (let si = 0; si < sheets.length && !placed; si++) {
      const s = sheets[si]!;
      // 逐行扫描游标（帧按 h 降序进入，天然形成货架行）
      const rows = new Map<number, { maxX: number; maxH: number }>();
      for (const p of s.used) {
        const r = rows.get(p.y) ?? { maxX: 0, maxH: 0 };
        r.maxX = Math.max(r.maxX, p.x + p.w);
        r.maxH = Math.max(r.maxH, p.h);
        rows.set(p.y, r);
      }
      const rowYs = [...rows.keys()].sort((a, b) => a - b);
      for (const y of rowYs) {
        const r = rows.get(y)!;
        if (r.maxX + it.w <= sheetSize && it.h <= r.maxH) {
          s.used.push({ ...it, sheet: si, x: r.maxX, y });
          placements.set(it.id, { sheet: si, x: r.maxX, y, w: it.w, h: it.h });
          placed = true;
          break;
        }
      }
      if (placed) continue;
      // 新行：找已有行底之上的空隙
      let ny = 0;
      for (const y of rowYs) {
        const r = rows.get(y)!;
        const rowBottom = y + r.maxH;
        if (ny < rowBottom) ny = rowBottom;
      }
      if (ny + it.h <= sheetSize) {
        s.used.push({ ...it, sheet: si, x: 0, y: ny });
        placements.set(it.id, { sheet: si, x: 0, y: ny, w: it.w, h: it.h });
        placed = true;
      }
    }
    if (!placed) {
      sheets.push({ w: sheetSize, h: sheetSize, used: [] });
      const s = sheets[sheets.length - 1]!;
      s.used.push({ ...it, sheet: sheets.length - 1, x: 0, y: 0 });
      placements.set(it.id, { sheet: sheets.length - 1, x: 0, y: 0, w: it.w, h: it.h });
    }
  }
  return { sheets, placements };
}

// ---------- sheet 合成 ----------
function composite(
  sheetItems: (Rect & PlacedFrame)[],
  pngDir: string,
  sheetSize: number,
): PNG {
  const out = new PNG({ width: sheetSize, height: sheetSize });
  for (const it of sheetItems) {
    const src = loadPng(join(pngDir, `${it.id}.png`));
    if (src.width !== it.w || src.height !== it.h) {
      fail(`png ${it.id} 实际 ${src.width}x${src.height} 与元数据 ${it.w}x${it.h} 不符`);
    }
    PNG.bitblt(src, out, 0, 0, it.w, it.h, it.x, it.y);
  }
  return out;
}

// ---------- 字符打包 ----------
function packChar(cap: CaptureChar, kindDir: string, kind: string): { atlas: AtlasPkg; sheets: { file: string; bytes: Buffer }[] } {
  const pngDir = join(captureDir, 'png', `${kind}_${cap.id}`);
  const items: Rect[] = cap.pngs.map((p) => ({ id: p.id, w: p.w, h: p.h }));
  const { sheets, placements } = pack(items, SHEET);

  const sheetFiles: { file: string; w: number; h: number }[] = [];
  const sheetBuffers: { file: string; bytes: Buffer }[] = [];
  for (let i = 0; i < sheets.length; i++) {
    const s = sheets[i]!;
    const file = `${cap.id}.sheet-${i}.png`;
    const png = composite(s.used, pngDir, SHEET);
    sheetBuffers.push({ file, bytes: PNG.sync.write(png, { deflateLevel: 9 }) });
    sheetFiles.push({ file, w: SHEET, h: SHEET });
  }

  const frames: Record<string, PlacedFrame> = {};
  for (const [id, p] of placements) {
    frames[String(id)] = p;
  }

  const atlas: AtlasPkg = {
    schema: 'bvn/atlas@1',
    kind,
    id: cap.id,
    sheets: sheetFiles,
    frames,
    forms: cap.rootFrames,
  };
  return { atlas, sheets: sheetBuffers };
}

// ---------- 地图打包 ----------
function packMap(cap: CaptureMap): { atlas: MapAtlasPkg; layers: { file: string; bytes: Buffer }[] } {
  const pngDir = join(captureDir, 'png', `map_${cap.id}`);
  const layers: (CaptureMapLayer & { file: string })[] = [];
  const buffers: { file: string; bytes: Buffer }[] = [];
  for (const ly of cap.layers) {
    const src = loadPng(join(pngDir, `${ly.png}.png`));
    if (src.width !== ly.w || src.height !== ly.h) {
      fail(`map ${cap.id} layer ${ly.name} png 实际 ${src.width}x${src.height} 与元数据不符`);
    }
    const file = `${cap.id}.layer-${layers.length}.png`;
    layers.push({ ...ly, file });
    buffers.push({ file, bytes: PNG.sync.write(src, { deflateLevel: 9 }) });
  }
  const atlas: MapAtlasPkg = {
    schema: 'bvn/map-atlas@1',
    kind: 'map',
    id: cap.id,
    layers,
  };
  return { atlas, layers: buffers };
}

// ---------- fire 打包 ----------
// capture 产物 atlas_fire_<ownerKind>_<id>.json → 两路输出：
//   assets/fires/<ownerKind>/<id>.atlas.json + sheet-<n>.png（bvn/fire-atlas@1）
//   baked/fires/<ownerKind>/<id>.json（bvn/fire@1，只留 totalFrames+labels）
// 采集 missing 的元件两路都不出现（消费端确定性静默/渲染回退色块）。
function packFire(cap: CaptureFire): {
  atlas: FireAtlasPkg;
  baked: FireBakedPkg;
  sheets: { file: string; bytes: Buffer }[];
} {
  const pngDir = join(captureDir, 'png', `fire_${cap.ownerKind}_${cap.id}`);
  const items: Rect[] = cap.pngs.map((p) => ({ id: p.id, w: p.w, h: p.h }));
  const { sheets, placements } = pack(items, SHEET);

  const sheetFiles: { file: string; w: number; h: number }[] = [];
  const sheetBuffers: { file: string; bytes: Buffer }[] = [];
  for (let i = 0; i < sheets.length; i++) {
    const s = sheets[i]!;
    const file = `${cap.id}.sheet-${i}.png`;
    const png = composite(s.used, pngDir, SHEET);
    sheetBuffers.push({ file, bytes: PNG.sync.write(png, { deflateLevel: 9 }) });
    sheetFiles.push({ file, w: SHEET, h: SHEET });
  }

  const frames: Record<string, PlacedFrame> = {};
  for (const [id, p] of placements) {
    frames[String(id)] = p;
  }

  const firesAtlas: FireAtlasPkg['fires'] = {};
  const firesBaked: FireBakedPkg['fires'] = {};
  for (const [nm, e] of Object.entries(cap.fires)) {
    if (e.missing || e.frames === undefined || e.totalFrames === undefined) continue;
    firesAtlas[nm] = {
      rootX: e.rootX ?? 0,
      rootY: e.rootY ?? 0,
      totalFrames: e.totalFrames,
      labels: e.labels ?? {},
      main: e.main ?? { x: 0, y: 0, w: 0, h: 0 },
      frames: e.frames,
    };
    firesBaked[nm] = { totalFrames: e.totalFrames, labels: e.labels ?? {} };
  }

  const atlas: FireAtlasPkg = {
    schema: 'bvn/fire-atlas@1',
    kind: 'fire',
    ownerKind: cap.ownerKind,
    id: cap.id,
    sheets: sheetFiles,
    frames,
    fires: firesAtlas,
  };
  const baked: FireBakedPkg = {
    schema: 'bvn/fire@1',
    kind: 'fire',
    ownerKind: cap.ownerKind,
    id: cap.id,
    fires: firesBaked,
  };
  return { atlas, baked, sheets: sheetBuffers };
}

// ---------- 主流程 ----------
function sha1(b: Buffer | string): string {
  return createHash('sha1').update(b).digest('hex');
}

function main(): void {
  const files = readdirSync(captureDir).filter((f) => f.endsWith('.json') && f !== 'manifest.json');
  const charFiles = files.filter((f) => f.startsWith('atlas_char_'));
  const mapFiles = files.filter((f) => f.startsWith('atlas_map_'));
  const fireFiles = files.filter((f) => f.startsWith('atlas_fire_'));

  const bakedDir = resolve(ROOT, 'packages/data/baked');
  const targets = [
    { dir: join(outDir, 'fighters'), label: 'fighters' },
    { dir: join(outDir, 'assistants'), label: 'assistants' },
    { dir: join(outDir, 'maps'), label: 'maps' },
    { dir: join(outDir, 'fires', 'fighter'), label: 'fires/fighter' },
    { dir: join(outDir, 'fires', 'assister'), label: 'fires/assister' },
  ];
  for (const t of targets) mkdirSync(t.dir, { recursive: true });
  for (const d of ['fires/fighter', 'fires/assister']) {
    mkdirSync(join(bakedDir, d), { recursive: true });
  }

  let failures = 0;
  const stats = {
    fighters: 0,
    assistants: 0,
    maps: 0,
    fires: 0,
    uniqueFrames: 0,
    totalFrames: 0,
    bytes: 0,
  };

  for (const f of charFiles) {
    const cap = JSON.parse(readFileSync(join(captureDir, f), 'utf8')) as CaptureChar;
    const kindDir = cap.kind === 'assister' ? 'assistants' : 'fighters';
    try {
      const { atlas, sheets } = packChar(cap, kindDir, cap.kind);
      writeFileSync(join(outDir, kindDir, `${cap.id}.atlas.json`), JSON.stringify(atlas));
      for (const s of sheets) {
        writeFileSync(join(outDir, kindDir, s.file), s.bytes);
        stats.bytes += s.bytes.length;
      }
      stats.uniqueFrames += cap.pngs.length;
      stats.totalFrames += cap.rootFrames.reduce((n, rf) => n + rf.frames.length, 0);
      if (cap.kind === 'assister') stats.assistants++;
      else stats.fighters++;
      console.log(
        `atlas-pack: ${cap.kind} ${cap.id} → ${sheets.length} sheet（唯一帧 ${cap.pngs.length}）`,
      );
    } catch (e) {
      console.error(`error[${cap.id}]: ${(e as Error).message}`);
      failures++;
    }
  }

  for (const f of mapFiles) {
    const cap = JSON.parse(readFileSync(join(captureDir, f), 'utf8')) as CaptureMap;
    try {
      const { atlas, layers } = packMap(cap);
      writeFileSync(join(outDir, 'maps', `${cap.id}.atlas.json`), JSON.stringify(atlas));
      for (const s of layers) {
        writeFileSync(join(outDir, 'maps', s.file), s.bytes);
        stats.bytes += s.bytes.length;
      }
      stats.maps++;
      console.log(`atlas-pack: map ${cap.id} → ${layers.length} layer`);
    } catch (e) {
      console.error(`error[map:${cap.id}]: ${(e as Error).message}`);
      failures++;
    }
  }

  for (const f of fireFiles) {
    const cap = JSON.parse(readFileSync(join(captureDir, f), 'utf8')) as CaptureFire;
    try {
      const { atlas, baked, sheets } = packFire(cap);
      writeFileSync(
        join(outDir, 'fires', cap.ownerKind, `${cap.id}.atlas.json`),
        JSON.stringify(atlas),
      );
      writeFileSync(
        join(bakedDir, 'fires', cap.ownerKind, `${cap.id}.json`),
        JSON.stringify(baked),
      );
      for (const s of sheets) {
        writeFileSync(join(outDir, 'fires', cap.ownerKind, s.file), s.bytes);
        stats.bytes += s.bytes.length;
      }
      stats.fires++;
      stats.uniqueFrames += cap.pngs.length;
      stats.totalFrames += Object.values(cap.fires).reduce(
        (n, e) => n + (e.frames ? e.frames.length : 0),
        0,
      );
      console.log(
        `atlas-pack: fire ${cap.ownerKind} ${cap.id} → ${sheets.length} sheet、元件 ${Object.keys(baked.fires).length}/${Object.keys(cap.fires).length}`,
      );
    } catch (e) {
      console.error(`error[fire:${cap.ownerKind}:${cap.id}]: ${(e as Error).message}`);
      failures++;
    }
  }

  console.log(
    `atlas-pack: fighters=${stats.fighters} assistants=${stats.assistants} maps=${stats.maps} fires=${stats.fires} ` +
      `唯一帧=${stats.uniqueFrames} 总帧引用=${stats.totalFrames} 素材=${Math.round(stats.bytes / 1024 / 1024)}MB`,
  );
  if (failures > 0) {
    console.error(`atlas-pack: ❌ ${failures} 项失败`);
    process.exit(1);
  }
  console.log('atlas-pack: ✅ 全部完成');
}

main();
