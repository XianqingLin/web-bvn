#!/usr/bin/env node
/**
 * ui-pack：切片 15 选人页原版化资产管线。
 *
 * FFDec CLI 按元件导出（主时间轴为空，不能按帧导出）：
 *   1. face.swf  -export image  → 266 张头像（文件名 = "<symbolId>_<类名>.<ext>"），
 *      剥掉数字前缀后按类名落盘 assets/ui/faces/（类名 = fighter.xml face 属性 = select.json id / id_b）；
 *   2. select.swf -export sprite → 挑选场景壳元件（背景/格子/光标/展示框/地图面板）拷为
 *      assets/ui/select/<逻辑名>.png；
 *   3. 地图缩略图 15 张 + random.png 原样拷入 assets/ui/maps/（450×240，与 select_map_mc ct 区同尺寸）；
 *   4. 产出 baked/ui.json（schema bvn/ui@1）：类名→文件映射 + select 元件表 + 原版布局常量。
 *
 * 坐标语义（FFDec sprite 导出的 PNG 画布原点 = 元件内容 bounds 左上角，注册点偏移已换算）：
 *   - 光标 PNG 放在 格子位 + (-18,-26)（select_item_mc 内层 mc 摆放矩阵 translateX/Y=-360/-520 twips）；
 *   - 地图缩略图放在 select_map PNG 内 (97.5,24)，kuang 框叠回 (92,19)（原版 kuang 在缩略图之上）；
 *   - 大头像放在展示框 PNG 内 (4.75,4.75)；P2 展示框内容容器镜像（scaleX=-1，原点 x=248.6）。
 *
 * 用法：node tools/ui-pack/ui-pack.mjs [--ffdec PATH] [--out-assets DIR] [--out-baked FILE]
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const ROOT = resolve(import.meta.dirname, '../..');
const FFDEC = resolve(opt('ffdec', 'C:/Program Files (x86)/FFDec/ffdec-cli.exe'));
const FACE_SWF = resolve(
  opt('face-swf', 'OpenBleachVsNaruto/_release/extracted/swf_output/assets/face.swf'),
);
const SELECT_SWF = resolve(opt('select-swf', 'OpenBleachVsNaruto/swf_source/#FighterTester/swfs/select.swf'));
const MAP_DIR = resolve(opt('map-dir', 'OpenBleachVsNaruto/swf_output/assets/map'));
const OUT_ASSETS = resolve(opt('out-assets', 'packages/data/assets/ui'));
const OUT_BAKED = resolve(opt('out-baked', 'packages/data/baked/ui.json'));
const SCRATCH = resolve(import.meta.dirname, '_scratch/ui-pack');

// select.swf 元件表：逻辑名 → [spriteId, 帧号]（帧号 1 起）
const SELECT_ELEMENTS = {
  stg_select: [75, 1], // 选人页背景 800×600
  slt_item: [79, 1], // 60×60 头像格框（ct 在 (0,0)，头像垫在框下）
  cursor_p1: [105, 1], // 光标 P1 蓝色（内层 mc 帧 1；PNG 原点 = 格子位 + (-18,-26)）
  cursor_p2: [105, 2], // 光标 P2 粉色
  selected_p1: [87, 1], // 已选展示框 P1 253×70（大头像 ct (4.75,4.75)）
  selected_p2: [84, 1], // 已选展示框 P2（内容容器 scaleX=-1 原点 x=248.6）
  select_map: [100, 1], // 地图选择面板 642×286（bg+箭头+kuang 烘焙）
  select_map_kuang: [99, 1], // kuang 框 458×248（须叠在缩略图之上）
  select_map_txt: [90, 1], // 地图名牌 183×32
};

function run(cmd, args_) {
  console.log(`$ ${cmd} ${args_.join(' ')}`);
  execFileSync(cmd, args_, { stdio: ['ignore', 'pipe', 'inherit'] });
}

/** FFDec 图片导出文件名 "<symbolId>_<类名>.<ext>" → 类名。 */
const stripSymbolPrefix = (f) => f.replace(/^\d+_/, '');

// ---------- 1. FFDec 导出 ----------
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
if (!existsSync(FFDEC)) throw new Error(`FFDec CLI 不存在：${FFDEC}`);
run(FFDEC, ['-export', 'image', join(SCRATCH, 'face'), FACE_SWF]);
run(FFDEC, ['-export', 'sprite', join(SCRATCH, 'select'), SELECT_SWF]);

// ---------- 2. 头像 → assets/ui/faces/ ----------
const facesDir = join(OUT_ASSETS, 'faces');
rmSync(facesDir, { recursive: true, force: true });
mkdirSync(facesDir, { recursive: true });
const faces = {};
// FFDec 单类型导出直接落盘；混多类型时会建 images/ 子目录，两种都兼容
const faceExportDir = existsSync(join(SCRATCH, 'face', 'images'))
  ? join(SCRATCH, 'face', 'images')
  : join(SCRATCH, 'face');
if (!existsSync(faceExportDir)) throw new Error('face 导出目录缺失（FFDec 输出结构变化？）');
for (const f of readdirSync(faceExportDir)) {
  const cls = stripSymbolPrefix(f);
  faces[cls.replace(/\.(png|jpg|jpeg)$/i, '')] = f;
  cpSync(join(faceExportDir, f), join(facesDir, f));
}
const faceCount = Object.keys(faces).length;

// ---------- 3. select 元件 → assets/ui/select/ ----------
const selectDir = join(OUT_ASSETS, 'select');
rmSync(selectDir, { recursive: true, force: true });
mkdirSync(selectDir, { recursive: true });
const selectExportDir = join(SCRATCH, 'select');
for (const [logical, [spriteId, frame]] of Object.entries(SELECT_ELEMENTS)) {
  const dir = readdirSync(selectExportDir).find(
    (d) => d === `DefineSprite_${spriteId}` || d.startsWith(`DefineSprite_${spriteId}_`),
  );
  if (!dir) throw new Error(`select.swf 未找到 sprite ${spriteId}（${logical}）`);
  const src = join(selectExportDir, dir, `${frame}.png`);
  if (!existsSync(src)) throw new Error(`select.swf sprite ${spriteId} 缺帧 ${frame}（${logical}）`);
  cpSync(src, join(selectDir, `${logical}.png`));
}

// ---------- 4. 地图缩略图 → assets/ui/maps/ ----------
const mapsDir = join(OUT_ASSETS, 'maps');
rmSync(mapsDir, { recursive: true, force: true });
mkdirSync(mapsDir, { recursive: true });
cpSync(MAP_DIR, mapsDir, { recursive: true });
const mapCount = readdirSync(mapsDir).filter((f) => f.endsWith('.png')).length;

// ---------- 5. baked/ui.json ----------
/** 原版 select_config 布局（select.xml stage_setting/layout + SelectStageConfigVO 默认 unitSize）。 */
const LAYOUT = {
  stage: [800, 600], // 原版舞台；app 端 1000×600 居中横向偏移 +100
  gridOrigin: [15, 100], // x + left, y + top
  gridArea: [800, 600], // width/height
  gridPadding: { left: 15, right: 15, top: 100, bottom: 10 },
  unit: [50, 50], // 头像尺寸（格子框 60×60，头像 (0,0) 垫底、框叠加）
};

const doc = {
  schema: 'bvn/ui@1',
  faces, // 类名 → faces/ 下文件名（266 类 = 67 形态 × grid/_b/_m/_w）
  select: {
    elements: Object.fromEntries(Object.keys(SELECT_ELEMENTS).map((k) => [k, `ui/select/${k}.png`])),
    /** 光标 PNG 原点相对格子位偏移（select_item_mc 内层 mc 摆放矩阵） */
    cursorOffset: [-18, -26],
    /** 地图面板：缩略图/kuang 相对 select_map.png 左上角位置（450×240 缩略图） */
    mapPicOffset: [97.5, 24],
    mapKuangOffset: [92, 19],
    /** 名牌相对原版舞台位置：(800-183)/2, 600-32-35 */
    mapTextPos: [308.5, 533],
    /** 展示框大头像 ct 偏移；P2 容器镜像原点 */
    faceBigOffset: [4.75, 4.75],
    faceBigP2Origin: [248.6, 4.75],
    /** 已选展示框位置（原版 SelectUIFactory：P1 x=10；P2 x=800-265；y=600-80） */
    selectedPos: { p1: [10, 520], p2: [535, 520] },
    /** 地图面板位置（原版：(800-bg.width)/2 ≈ 157, 600*0.25=150；app 端再加舞台居中偏移） */
    mapPanelPos: [157, 150],
    layout: LAYOUT,
  },
  maps: { dir: 'ui/maps' },
};

mkdirSync(dirname(OUT_BAKED), { recursive: true });
writeFileSync(OUT_BAKED, JSON.stringify(doc));
console.log(
  `ui-pack: faces ${faceCount} / select ${Object.keys(SELECT_ELEMENTS).length} 元件 / maps ${mapCount} 张 → ${OUT_ASSETS} + ${OUT_BAKED}`,
);
