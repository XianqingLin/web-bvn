#!/usr/bin/env node
/**
 * ui-pack：切片 15 选人页原版化资产管线。
 *
 * FFDec CLI 按元件导出（主时间轴为空，不能按帧导出）：
 *   1. face.swf  -export image  → 266 张头像（文件名 = "<symbolId>_<类名>.<ext>"），
 *      剥掉数字前缀后按类名落盘 assets/ui/faces/（类名 = fighter.xml face 属性 = select.json id / id_b）；
 *   2. select.swf -export sprite → 挑选场景壳元件（背景/格子/光标/展示框/地图面板）拷为
 *      assets/ui/select/<逻辑名>.png；
 *   2b. title.swf -export sprite → stg_title 90 帧（2351×749，动画主时间轴在 sprite 内、
 *       "menu" 标签 = 帧 65）→ sharp 转 WebP q80 → assets/ui/title/<帧>.webp（~8.5MB）；
 *   2c. common_ui.swf -export sprite → mc_wzbtn 按钮板 388×75 + wzimg_bgimg hover 帧两帧
 *       → assets/ui/menu/；
 *   3. 地图缩略图 15 张 + random.png 原样拷入 assets/ui/maps/（450×240，与 select_map_mc ct 区同尺寸）；
 *   4. 产出 baked/ui.json（schema bvn/ui@1）：类名→文件映射 + select 元件表 + 原版布局常量
 *       + title 流帧参数 + menu 按钮阶梯布局常量。
 *
 * 坐标语义（FFDec sprite 导出的 PNG 画布原点 = 元件内容 bounds 左上角，注册点偏移已换算）：
 *   - 光标 PNG 放在 格子位 + (-18,-26)（select_item_mc 内层 mc 摆放矩阵 translateX/Y=-360/-520 twips）；
 *   - 地图缩略图放在 select_map PNG 内 (97.5,24)，kuang 框叠回 (92,19)（原版 kuang 在缩略图之上）；
 *   - 大头像放在展示框 PNG 内 (4.75,4.75)；P2 展示框内容容器镜像（scaleX=-1，原点 x=248.6）；
 *   - stg_title 帧 PNG 内 舞台(0,0) 位于 (859,100)（由时间轴 union bounds 反推，与 FFDec
 *       画布 2351×749 对上）；原版把 stg_title 以 (0,0) 直接 addChild 到 800×600 舞台，
 *       播放时须把帧 PNG 挂在 舞台-(859,100) 并裁剪到舞台矩形（原版窗口即舞台）。
 *   - 按钮组挂进 stg_title 内 identity 占位 btnct → 舞台 (470,100)；wzbtn bg 子件在 (0,-5)。
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
import sharp from 'sharp';

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
const TITLE_SWF = resolve(opt('title-swf', 'OpenBleachVsNaruto/swf_source/#FighterTester/swfs/title.swf'));
const COMMON_SWF = resolve(opt('common-swf', 'OpenBleachVsNaruto/swf_source/#FighterTester/swfs/common_ui.swf'));
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

// common_ui.swf 元件表：逻辑名 → [spriteId, 帧号]（mc_wzbtn 常态板 + wzimg_bgimg hover/开态）
const MENU_ELEMENTS = {
  wzbtn: [14, 1], // 菜单按钮板 388×75（常态，English 标签叠其上）
  wzbtn_bg1: [13, 1], // hover 高亮板（橙色；挂 (0,-5)，中文小字叠 (10,45)）
  wzbtn_bg2: [13, 2], // 开态/子项板（蓝色）
};

// title.swf stg_title（sprite 64）流帧参数（90 帧全部唯一；运行时仅 1-50 与 65-75 可见，见 PROGRESS 切片 16）
const TITLE = {
  spriteId: 64,
  frames: 90,
  fps: 30, // title.swf frameRate（MovieClip 播放速率随文档）
  /** 帧脚本 addFrameScript(49, stop)：intro 播到帧 50 定格，等点击/任意键 */
  introFrom: 2,
  introStop: 50,
  /** gotoAndPlay("menu")：按钮段从帧 65 播到帧 75 定格（addFrameScript(74, stop)） */
  menuFrame: 65,
  menuStop: 75,
  /** 帧 PNG 内原版舞台 (0,0) 的位置（union bounds 反推） */
  stageOriginInFrame: [859, 100],
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
run(FFDEC, ['-export', 'sprite', join(SCRATCH, 'title'), TITLE_SWF]);
run(FFDEC, ['-export', 'sprite', join(SCRATCH, 'menu'), COMMON_SWF]);

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

// ---------- 3b. title 流帧 → assets/ui/title/<n>.webp（WebP q80：~8.5MB / 90 帧） ----------
const titleDir = join(OUT_ASSETS, 'title');
rmSync(titleDir, { recursive: true, force: true });
mkdirSync(titleDir, { recursive: true });
{
  const spriteDir = readdirSync(join(SCRATCH, 'title')).find(
    (d) => d === `DefineSprite_${TITLE.spriteId}` || d.startsWith(`DefineSprite_${TITLE.spriteId}_`),
  );
  if (!spriteDir) throw new Error(`title.swf 未找到 sprite ${TITLE.spriteId}`);
  const frames = readdirSync(join(SCRATCH, 'title', spriteDir)).filter((f) => f.endsWith('.png'));
  if (frames.length !== TITLE.frames) {
    throw new Error(`stg_title 帧数变化：${frames.length} ≠ ${TITLE.frames}（规格须同步更新）`);
  }
  for (let i = 1; i <= TITLE.frames; i++) {
    const src = join(SCRATCH, 'title', spriteDir, `${i}.png`);
    await sharp(src).webp({ quality: 80 }).toFile(join(titleDir, `${i}.webp`));
  }
}

// ---------- 3c. menu 按钮 → assets/ui/menu/ ----------
const menuDir = join(OUT_ASSETS, 'menu');
rmSync(menuDir, { recursive: true, force: true });
mkdirSync(menuDir, { recursive: true });
{
  const menuExportDir = join(SCRATCH, 'menu');
  for (const [logical, [spriteId, frame]] of Object.entries(MENU_ELEMENTS)) {
    const dir = readdirSync(menuExportDir).find(
      (d) => d === `DefineSprite_${spriteId}` || d.startsWith(`DefineSprite_${spriteId}_`),
    );
    if (!dir) throw new Error(`common_ui.swf 未找到 sprite ${spriteId}（${logical}）`);
    const src = join(menuExportDir, dir, `${frame}.png`);
    if (!existsSync(src)) throw new Error(`common_ui.swf sprite ${spriteId} 缺帧 ${frame}（${logical}）`);
    cpSync(src, join(menuDir, `${logical}.png`));
  }
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
  // ---- 切片 16：title 开场流帧 + 主菜单按钮（原版 MenuStage/MenuBtnGroup/MenuBtn 规格） ----
  title: {
    dir: 'ui/title',
    frames: TITLE.frames,
    fps: TITLE.fps,
    /** 帧 PNG 内原版舞台 (0,0) 位置：挂载时 sprite 位置 = 舞台位 - stageOriginInFrame，并裁剪到舞台矩形 */
    stageOriginInFrame: TITLE.stageOriginInFrame,
    /** 原版 stg_title 帧脚本语义：intro 播 introFrom..introStop 定格；点击后 menuFrame..menuStop 定格 */
    introFrom: TITLE.introFrom,
    introStop: TITLE.introStop,
    menuFrame: TITLE.menuFrame,
    menuStop: TITLE.menuStop,
  },
  menu: {
    elements: Object.fromEntries(Object.keys(MENU_ELEMENTS).map((k) => [k, `ui/menu/${k}.png`])),
    /** 按钮组在原版 800×600 舞台内的位置（stg_title 内 btnct 占位 identity → 舞台坐标） */
    groupPos: [470, 100],
    /** MenuBtnGroup 阶梯：后一项 x += xadd；y += 项高 + yadd */
    xadd: -40,
    yadd: 5,
    btnHeight: 75,
    childHeight: 55, // childMode（scaleY 0.75）后 MenuBtn.height
    /** hover 板相对按钮原点偏移（mc_wzbtn 内 bg 子件摆放矩阵 translateY=-100 twips） */
    bgOffset: [0, -5],
    /** 中文小字在 hover 板内的位置（MenuBtn 构造） */
    cnTextPos: [10, 45],
    /** 版本字位置 = 舞台右下角内缩（MenuStage.afterBuild） */
    versionPad: [15, 10],
  },
};

mkdirSync(dirname(OUT_BAKED), { recursive: true });
writeFileSync(OUT_BAKED, JSON.stringify(doc));
console.log(
  `ui-pack: faces ${faceCount} / select ${Object.keys(SELECT_ELEMENTS).length} 元件 / title ${TITLE.frames} 帧 / menu ${Object.keys(MENU_ELEMENTS).length} 元件 / maps ${mapCount} 张 → ${OUT_ASSETS} + ${OUT_BAKED}`,
);
