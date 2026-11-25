#!/usr/bin/env node
/**
 * ui-pack：切片 15 选人页原版化资产管线。
 *
 * FFDec CLI 按元件导出（主时间轴为空，不能按帧导出）：
 *   1. face.swf  -export image  → 266 张头像（文件名 = "<symbolId>_<类名>.<ext>"），
 *      剥掉数字前缀后按类名落盘 assets/ui/faces/（类名 = fighter.xml face 属性 = select.json id / id_b）；
 *   2. select.swf -export sprite → 挑选场景壳元件（背景/格子/光标/展示框/地图面板）拷为
 *      assets/ui/select/<逻辑名>.png（切片 45：stg_select/select_map 内嵌套动画元件
 *      （旋涡 71/扫光 93/箭头 96/kuang 99）经 swf2xml 手术剔除后重导"干净底板"，帧序
 *      单独导出为叠加层 assets/ui/select-fx/<char>/，位置经模板匹配实测校准）；
 *   2b. title.swf 三层夹心（2026-11-24 重审立项）：底板/顶板 XML 手术（剔 fx+顶层 /
 *       只留顶层；顶板另剔 5DPLAY 导流横幅栈 char 19——2026-11-24 决策移除，见 3b 内注）
 *       → stg_title 各 90 帧（底板 WebP q80 ~8.5MB、顶板 α WebP）；fx 叠加层
 *       9 元件帧序 + vs（59 遮罩扫光）合成帧 → assets/ui/title-fx/<char>/（~1.5MB）；
 *       放置 keys（placementSegments）写进 baked ui.json title.fx；
 *   2c. common_ui.swf -export sprite → mc_wzbtn 按钮板 388×75 + wzimg_bgimg hover 帧两帧
 *       → assets/ui/menu/；
 *   2f. common_ui.swf sprite 26（logo_movie）→ assets/ui/logo-tween/base.webp（开场徽标演出，单贴图 + alpha 补间）；
 *   2e. setting 底板（设置面板切片，2026-11-24）：原版 setting.swf 未独立存在于参考仓库
 *       （swfs/ 仅 common_ui/gameover/howtoplay/select/title），但主程序 FighterTester.swf
 *       把整套 UI SWF 作为 [Embed] ByteArray 打包（SymbolClass setting_swf$<md5>ByteArray
 *       = character 5）——抽 ByteArray → FFDec 直读内嵌 SWF（ZWS）→ stg_set_ui（暗化
 *       标题版画背景 + OPTION 标题 + 一护立绘，单帧静态）导出帧 1 → assets/ui/setting/1.webp；
 *       画布原点（内容 union 左上，含立绘出血）写 ui.json setting.stageOriginInFrame，
 *       运行时挂 舞台-origin 并裁剪到 800×600 舞台矩形（原版 root scrollRect 语义）；
 *   3. 地图缩略图 15 张 + random.png 原样拷入 assets/ui/maps/（450×240，与 select_map_mc ct 区同尺寸）；
 *   4. 产出 baked/ui.json（schema bvn/ui@8）：类名→文件映射 + select 元件表 + 原版布局常量
 *       + title/logo 流帧参数 + menu 按钮阶梯布局常量 + setting 底板规格。
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
import { createHash } from 'node:crypto';
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
import { parseSwfXml, removePlacements, contentBounds, placementSegments } from './swf-nest.mjs';
import { extractLogoTween } from './logo-tween.mjs';

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
/** 主程序编译产物：setting.swf 等以 [Embed] ByteArray 内嵌（SymbolClass 名单） */
const MAIN_SWF = resolve(opt('main-swf', 'OpenBleachVsNaruto/_release/extracted/swf_output/FighterTester.swf'));
/** 内嵌 setting.swf 的 ByteArray character id 与底板导出名（symbols.csv 实证） */
const SETTING = { embedChar: 5, plate: 'stg_set_ui' };
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

// 设置页箭头/光标（2026-11-25）：逻辑名 → 元件类名（sprite 按类名定位，不硬编码 ID）
const SETTING_ARROWS = {
  txt_arrow: 'txt_arrow_mc', // ◄► 数值箭头（setting.swf；next 用 scaleX=-1 镜像复用）
  select_arrow: 'select_arrow_mc', // 焦点光标（common_ui.swf；挂行 (x-10, y+15)）
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

// common_ui.swf sprite 26（logo_movie）开场徽标演出参数（切片 29）：
// 帧 1 脚本 stop()，帧 66 脚本 stop()+dispatchEvent(COMPLETE) → LogoStage gotoAndPlay(2) 播 2..66
const LOGO = {
  spriteId: 26,
  frames: 66,
  fps: 30,
  from: 2,
  stop: 66,
  /** 画布 = 舞台 800×600（实测 union），帧 PNG 内舞台 (0,0) 在 (0,0) */
  stageOriginInFrame: [0, 0],
};

// ---- 切片 45：嵌套动画叠加层 ----

// select.swf：stg_select（sprite 75）的 bg（sprite 72）只装旋涡 71（105 帧循环），
// 放置带 scale(1.25,1.6667) + redAdd −255（紫→蓝，烘焙期清零红通道精确等价）。
const SELECT_VORTEX = { char: 71, bgSprite: 72, frames: 105, scale: [1.25, 1.6666565] };

// select_map（sprite 100，1 帧）内动画元件：93 扫光(d1)、96 箭头×2(d3 正/d5 镜像 sx=-1)、
// 99 kuang 框(d9)。剔除后底板只剩 76（空元件 → 无静态内容）。
// posOverride：93 光层画面平滑自相似（模板匹配极小平移歧义），锚点用解析位
// O+放置位（(78,0)，已被 kuang(92,19)/箭头 d3(584,118)/d5(57,118) 三点独立证实）
const SELECT_MAP_FX = [
  { char: 93, depth: 1, posOverride: [78, 0] },
  { char: 96, depth: 3 },
  { char: 96, depth: 5 },
  { char: 99, depth: 9 },
];

function run(cmd, args_) {
  console.log(`$ ${cmd} ${args_.join(' ')}`);
  execFileSync(cmd, args_, { stdio: ['ignore', 'pipe', 'inherit'] });
}

/** 文件 md5（手术有效性守卫 / 静态帧折叠用）。 */
const fileMd5 = (p) => createHash('md5').update(readFileSync(p)).digest('hex');

/** FFDec 图片导出文件名 "<symbolId>_<类名>.<ext>" → 类名。 */
const stripSymbolPrefix = (f) => f.replace(/^\d+_/, '');

/** FFDec sprite 导出目录：DefineSprite_<id>[_...] → 目录路径。 */
function findSpriteDir(exportDir, spriteId, what) {
  const dir = readdirSync(exportDir).find(
    (d) => d === `DefineSprite_${spriteId}` || d.startsWith(`DefineSprite_${spriteId}_`),
  );
  if (!dir) throw new Error(`未找到 sprite ${spriteId}（${what}）`);
  return join(exportDir, dir);
}

// ---------- 1. FFDec 导出 ----------
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
if (!existsSync(FFDEC)) throw new Error(`FFDec CLI 不存在：${FFDEC}`);
run(FFDEC, ['-export', 'image', join(SCRATCH, 'face'), FACE_SWF]);
run(FFDEC, ['-export', 'sprite', join(SCRATCH, 'select'), SELECT_SWF]);
run(FFDEC, ['-export', 'sprite', join(SCRATCH, 'title'), TITLE_SWF]);
run(FFDEC, ['-export', 'sprite', join(SCRATCH, 'menu'), COMMON_SWF]);

// ---------- 1b. swf2xml + 嵌套动画手术 → 干净底板 swf（切片 45，select 侧） ----------
run(FFDEC, ['-swf2xml', SELECT_SWF, join(SCRATCH, 'select.xml')]);
const selectXml = readFileSync(join(SCRATCH, 'select.xml'), 'utf8');
const selectModel = parseSwfXml(selectXml);
// 旋涡：sprite 72 只装 71（1 帧）；map fx：sprite 100（1 帧）上剔 93/96×2/99
const selectCleanXml = removePlacements(
  removePlacements(selectXml, SELECT_VORTEX.bgSprite, [
    { depth: 1, charId: SELECT_VORTEX.char, from: 1, to: 1 },
  ]),
  100,
  SELECT_MAP_FX.map((s) => ({ depth: s.depth, charId: s.char, from: 1, to: 1 })),
);
writeFileSync(join(SCRATCH, 'select-clean.xml'), selectCleanXml);
run(FFDEC, ['-xml2swf', join(SCRATCH, 'select-clean.xml'), join(SCRATCH, 'select-clean.swf')]);
run(FFDEC, ['-export', 'sprite', join(SCRATCH, 'select-clean'), join(SCRATCH, 'select-clean.swf')]);
if (fileMd5(join(SCRATCH, 'select-clean.swf')) === fileMd5(SELECT_SWF)) {
  throw new Error('select-clean 手术无效（clean swf 与原版逐字节相同）');
}

// ---------- 1c. 嵌套叠加层工具 ----------
/** 读 PNG 为 RGBA 原始缓冲。 */
const rawBuf = (file) => sharp(file).raw().toBuffer({ resolveWithObject: true });

/** 全帧像素相同 → 折叠为 1 帧（静态"动画"元件，省带宽）；否则原帧数。
 *  按 PNG 像素哈希比较（FFDec 导出字节流有压滤差异，字节哈希会误判）。 */
async function collapseStaticFrames(framesDir, frameCount) {
  const h1 = createHash('md5').update(await sharp(join(framesDir, '1.png')).raw().toBuffer()).digest('hex');
  for (let i = 2; i <= frameCount; i++) {
    const h = createHash('md5').update(await sharp(join(framesDir, `${i}.png`)).raw().toBuffer()).digest('hex');
    if (h !== h1) return frameCount;
  }
  console.log(`  ${framesDir.split(/[\\/]/).pop()}：${frameCount} 帧像素全同 → 折叠 1 帧`);
  return 1;
}

/** 逐帧 α 外包盒（canvas 像素，帧间 union）+ 不透明像素最多的帧号。 */
async function alphaScan(framesDir, frameCount) {
  let bb = null;
  let bestF = 0;
  let bestN = -1;
  for (let f = 1; f <= frameCount; f++) {
    const { data, info } = await rawBuf(join(framesDir, `${f}.png`));
    let n = 0;
    let x0 = info.width;
    let y0 = info.height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        if (data[(y * info.width + x) * 4 + 3] > 10) {
          n++;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (n === 0) continue;
    bb = bb
      ? { x: Math.min(bb.x, x0), y: Math.min(bb.y, y0), x2: Math.max(bb.x2, x1), y2: Math.max(bb.y2, y1) }
      : { x: x0, y: y0, x2: x1, y2: y1 };
    if (n > bestN) {
      bestN = n;
      bestF = f;
    }
  }
  if (!bb) throw new Error(`${framesDir} 全帧透明`);
  return { bb: { x: bb.x, y: bb.y, w: bb.x2 - bb.x + 1, h: bb.y2 - bb.y + 1 }, bestF };
}

/** 暴力模板匹配（SSE，忽略模板半透明像素），返回 plate 内最佳左上角坐标。 */
function matchTemplate(plate, tpl, win) {
  const pd = plate.data;
  const pw = plate.info.width;
  const td = tpl.data;
  const tw = tpl.info.width;
  const th = tpl.info.height;
  let best = null;
  for (let oy = win.y; oy <= win.y + win.h - th; oy++) {
    for (let ox = win.x; ox <= win.x + win.w - tw; ox++) {
      let sse = 0;
      for (let ty = 0; ty < th; ty++) {
        const pr = (oy + ty) * pw;
        const tr = ty * tw;
        let done = false;
        for (let tx = 0; tx < tw; tx++) {
          if (td[(tr + tx) * 4 + 3] < 200) continue;
          const p = (pr + ox + tx) * 4;
          const t = (tr + tx) * 4;
          for (let c = 0; c < 3; c++) {
            const d = pd[p + c] - td[t + c];
            sse += d * d;
          }
          if (best && sse >= best.sse) {
            done = true;
            break;
          }
        }
        if (done) break;
      }
      if (!best || sse < best.sse) best = { x: ox, y: oy, sse };
    }
  }
  if (!best) throw new Error('模板匹配搜索窗口无效');
  return best;
}

/** α 通道模板匹配（全半透明元件兜底：导出板 RGB 有预乘往返误差，α 遮罩稳定）。 */
function matchTemplateAlpha(plate, tpl, win) {
  const pd = plate.data;
  const pw = plate.info.width;
  const td = tpl.data;
  const tw = tpl.info.width;
  const th = tpl.info.height;
  let best = null;
  for (let oy = win.y; oy <= win.y + win.h - th; oy++) {
    for (let ox = win.x; ox <= win.x + win.w - tw; ox++) {
      let sse = 0;
      for (let ty = 0; ty < th; ty++) {
        const pr = (oy + ty) * pw;
        const tr = ty * tw;
        let done = false;
        for (let tx = 0; tx < tw; tx++) {
          if (td[(tr + tx) * 4 + 3] < 8) continue;
          const d = pd[(pr + ox + tx) * 4 + 3] - td[(tr + tx) * 4 + 3];
          sse += d * d;
          if (best && sse >= best.sse) {
            done = true;
            break;
          }
        }
        if (done) break;
      }
      if (!best || sse < best.sse) best = { x: ox, y: oy, sse };
    }
  }
  if (!best) throw new Error('α 模板匹配搜索窗口无效');
  return best;
}

/**
 * 叠加层校准：α 外包定裁剪窗 + 模板匹配实测画布偏移。
 * 原板里嵌套元件被 FFDec 冻结在未知内部帧 → 逐帧试配模板取最小 SSE。
 * @param exp 注册点在 plate 画布坐标的期望位置（canvas 声明误差由匹配吸收，仅定搜索窗）
 * @param scale 放置缩放（允许负 sx = 镜像）
 * @returns {{crop:[x,y,w,h], plateTL:[x,y], sse, tplFrame}} plateTL = 裁剪窗左上角在
 *   plate 画布坐标的实测落点（scaled 空间；origin 由调用方按需换算）。
 */
async function calibrateOverlay(framesDir, frameCount, plateBuf, exp, scale = [1, 1], pad = 32) {
  const { bb } = await alphaScan(framesDir, frameCount);
  const mirrored = scale[0] < 0;
  const cw = Math.round(bb.w * Math.abs(scale[0]));
  const ch = Math.round(bb.h * scale[1]);
  // 裁剪窗（canvas 像素，pad 4 夹到画布内）
  const frameMeta = await sharp(join(framesDir, '1.png')).metadata();
  const crop = [
    Math.max(0, bb.x - 4),
    Math.max(0, bb.y - 4),
    Math.min(frameMeta.width, bb.x + bb.w + 4) - Math.max(0, bb.x - 4),
    Math.min(frameMeta.height, bb.y + bb.h + 4) - Math.max(0, bb.y - 4),
  ];
  // 期望 α 外包左上角 = 注册点 + scale*外包（镜像时右缘为左上）
  const expX = Math.round(mirrored ? exp.x - Math.abs(scale[0]) * (bb.x + bb.w) : exp.x + scale[0] * bb.x);
  const expY = Math.round(exp.y + scale[1] * bb.y);
  // 逐帧试配：模板帧 = 原板冻结相位（未知），取最小 SSE。
  // 三级模式（首个出解的级即用）：实心 RGB → 半透明 RGB（全半透明元件如 93 光层，
  // RGB 有小幅预乘往返误差但模板窗若未他物覆盖仍可配）→ α 遮罩兜底
  const TW = Math.min(48, bb.w);
  const TH = Math.min(48, bb.h);
  let best = null;
  const tryFrames = Math.min(frameCount, 30);
  for (const mode of [
    { dense: 200, alphaMatch: false },
    { dense: 64, alphaMatch: false },
    { dense: 8, alphaMatch: true },
  ]) {
    const dense = mode.dense;
    for (let k = 1; k <= tryFrames; k++) {
      const frame = await rawBuf(join(framesDir, `${k}.png`));
      // 模板窗：αbbox 内找匹配像素最密的 ≤48×48 子区
      let bestTpl = null;
      for (let oy = bb.y; oy + TH <= bb.y + bb.h; oy += 4) {
        for (let ox = bb.x; ox + TW <= bb.x + bb.w; ox += 4) {
          let n = 0;
          for (let y = 0; y < TH; y++)
            for (let x = 0; x < TW; x++)
              if (frame.data[((oy + y) * frame.info.width + ox + x) * 4 + 3] > dense) n++;
          if (!bestTpl || n > bestTpl.n) bestTpl = { x: ox, y: oy, n };
        }
      }
      if (!bestTpl || bestTpl.n < 64) continue;
      let tpl = await sharp(frame.data, { raw: frame.info })
        .extract({ left: bestTpl.x, top: bestTpl.y, width: TW, height: TH })
        .raw()
        .toBuffer({ resolveWithObject: true });
      if (scale[0] !== 1 || scale[1] !== 1) {
        let s = sharp(tpl.data, { raw: tpl.info }).resize(
          Math.max(1, Math.round(TW * Math.abs(scale[0]))),
          Math.max(1, Math.round(TH * scale[1])),
        );
        if (mirrored) s = s.flop();
        tpl = await s.png().toBuffer().then((b) => sharp(b).raw().toBuffer({ resolveWithObject: true }));
      }
      const sw = tpl.info.width;
      const sh = tpl.info.height;
      const tplSX = mirrored ? cw - Math.round(bestTpl.x * Math.abs(scale[0])) - sw : Math.round(bestTpl.x * scale[0]);
      const tplSY = Math.round(bestTpl.y * scale[1]);
      // 搜索窗锚 = 模板窗期望位（exp + 模板窗在 scaled 内容内的偏移）±pad：
      // 大元件的密窗可远离内容 TL，锚在 exp 本身会把真位关在窗外；
      // pad 需覆盖「content union 远离注册点」的元件（title 大美术偏移达 ~200px）
      const win = {
        x: Math.max(0, expX + tplSX - pad),
        y: Math.max(0, expY + tplSY - pad),
        w: Math.min(plateBuf.info.width - Math.max(0, expX + tplSX - pad), sw + pad * 2),
        h: Math.min(plateBuf.info.height - Math.max(0, expY + tplSY - pad), sh + pad * 2),
      };
      const m = mode.alphaMatch ? matchTemplateAlpha(plateBuf, tpl, win) : matchTemplate(plateBuf, tpl, win);
      if (!best || m.sse < best.sse) {
        // 裁剪窗左上角在 scaled 空间相对模板窗的偏移 → plate 落点
        const cropSX = mirrored
          ? cw - Math.round(crop[0] * Math.abs(scale[0])) - Math.round(crop[2] * Math.abs(scale[0]))
          : Math.round(crop[0] * scale[0]);
        const cropSY = Math.round(crop[1] * scale[1]);
        best = { sse: m.sse, tplFrame: k, plateTL: [m.x - (tplSX - cropSX), m.y - (tplSY - cropSY)] };
      }
    }
    if (best) break;
  }
  if (!best) throw new Error(`${framesDir} 校准失败：无可配模板帧`);
  return { crop, ...best };
}

/** 叠加帧序烘焙：按 crop 裁剪全部帧 →（可选色变换）→ WebP q80。 */
async function bakeOverlayFrames(framesDir, frameCount, crop, outDir, mod = null) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (let i = 1; i <= frameCount; i++) {
    const src = join(framesDir, `${i}.png`);
    let img = sharp(src).extract({ left: crop[0], top: crop[1], width: crop[2], height: crop[3] });
    if (mod) img = mod(img);
    await img.webp({ quality: 80 }).toFile(join(outDir, `${i}.webp`));
  }
}

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
  // `*_w` = 胜者立绘（原版仅街机结算页消费，2026-11-21 结算画面整块移除后不导出）
  if (/_w\.(png|jpg|jpeg)$/i.test(cls)) continue;
  faces[cls.replace(/\.(png|jpg|jpeg)$/i, '')] = f;
  cpSync(join(faceExportDir, f), join(facesDir, f));
}
const faceCount = Object.keys(faces).length;

// ---------- 3. select 元件 → assets/ui/select/ ----------
// stg_select（剔旋涡 71）与 select_map（剔 93/96/99）取干净板合成回原画布矩形，
// 其余元件照旧取原导出（切片 45）。
const selectDir = join(OUT_ASSETS, 'select');
rmSync(selectDir, { recursive: true, force: true });
mkdirSync(selectDir, { recursive: true });
const selectExportDir = join(SCRATCH, 'select');
const selectCleanExportDir = join(SCRATCH, 'select-clean');
let stgSelectOff = null; // 干净 stg_select 画布原点在原画布（=stg_select local）的偏移
let selectMapOff = null; // 干净 select_map 画布原点在原画布的偏移
/** 干净板对齐原板：模板 = 原板静态内容区，匹配回干净板 → 干净画布原点在原画布的偏移。
 *  偏移幅度未知（FFDec union 画布缩小），先 1/2 降采样全画布粗配再全分辨率细配。 */
async function alignCleanPlate(origPlatePng, tplBox, cleanFramePng) {
  const origMeta = await sharp(origPlatePng).metadata();
  const cleanMeta0 = await sharp(cleanFramePng).metadata();
  const tpl = await sharp(origPlatePng).extract(tplBox).raw().toBuffer({ resolveWithObject: true });
  const half = (b) =>
    sharp(b.data, { raw: b.info })
      .resize(Math.ceil(b.info.width / 2), Math.ceil(b.info.height / 2))
      .raw()
      .toBuffer({ resolveWithObject: true });
  const cleanFull = await rawBuf(cleanFramePng);
  // 画布未缩（FFDec 内容 union 仍跨满原画布，如 title 背景）→ 原点对齐 (0,0) 直通：
  // 匹配法在同尺寸下易被模板窗内的被剔元件像素带偏（title stage 中心即此情形）
  if (cleanFull.info.width === origMeta.width && cleanFull.info.height === origMeta.height) {
    return { off: [0, 0], orig: origMeta, clean: cleanMeta0, sse: 0 };
  }
  const coarse = matchTemplate(await half(cleanFull), await half(tpl), {
    x: 0,
    y: 0,
    w: Math.ceil(cleanFull.info.width / 2),
    h: Math.ceil(cleanFull.info.height / 2),
  });
  const m = matchTemplate(cleanFull, tpl, {
    x: Math.max(0, coarse.x * 2 - 4),
    y: Math.max(0, coarse.y * 2 - 4),
    w: tpl.info.width + 8,
    h: tpl.info.height + 8,
  });
  // 干净画布原点在原画布的位置 = 模板原位 − 匹配位（m 是模板在干净画布内的落点）
  const off = [tplBox.left - m.x, tplBox.top - m.y];
  const cleanMeta = await sharp(cleanFramePng).metadata();
  if (off[0] < 0 || off[1] < 0 || off[0] + cleanMeta.width > origMeta.width || off[1] + cleanMeta.height > origMeta.height) {
    throw new Error(`干净板画布对不上原画布（clean ${cleanMeta.width}x${cleanMeta.height} off=${off} orig ${origMeta.width}x${origMeta.height}）`);
  }
  return { off, orig: origMeta, clean: cleanMeta, sse: m.sse };
}
for (const [logical, [spriteId, frame]] of Object.entries(SELECT_ELEMENTS)) {
  const dir = readdirSync(selectExportDir).find(
    (d) => d === `DefineSprite_${spriteId}` || d.startsWith(`DefineSprite_${spriteId}_`),
  );
  if (!dir) throw new Error(`select.swf 未找到 sprite ${spriteId}（${logical}）`);
  const src = join(selectExportDir, dir, `${frame}.png`);
  if (!existsSync(src)) throw new Error(`select.swf sprite ${spriteId} 缺帧 ${frame}（${logical}）`);
  if (logical === 'stg_select' || logical === 'select_map') {
    if (logical === 'select_map') {
      // 静态板 76 是空元件 → select_map 无任何静态内容（全部可见内容 = 93 光层/
      // 96 箭头×2/99 kuang，均走运行时叠加层，切片 45）：干净板 = 原导出画布尺寸
      // 全透明（PNG 尺寸/引用不变，setup.ts 面板底只作层级容器）
      const origMeta = await sharp(src).metadata();
      await sharp({
        create: { width: origMeta.width, height: origMeta.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .png()
        .toFile(join(selectDir, `${logical}.png`));
      selectMapOff = [0, 0];
      console.log(`select select_map 干净板：76 空元件 → 无静态内容，${origMeta.width}x${origMeta.height} 全透明`);
      continue;
    }
    const cleanDir = readdirSync(selectCleanExportDir).find(
      (d) => d === `DefineSprite_${spriteId}` || d.startsWith(`DefineSprite_${spriteId}_`),
    );
    if (!cleanDir) throw new Error(`select-clean.swf 未找到 sprite ${spriteId}（${logical}）`);
    const cleanSrc = join(selectCleanExportDir, cleanDir, `${frame}.png`);
    // 模板区：stg_select = 顶部横幅内静态区
    const tplBox = { left: 200, top: 30, width: 120, height: 60 };
    const { off, orig, clean } = await alignCleanPlate(src, tplBox, cleanSrc);
    const padded = await sharp({
      create: { width: orig.width, height: orig.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: cleanSrc, left: off[0], top: off[1] }])
      .png()
      .toFile(join(selectDir, `${logical}.png`));
    if (logical === 'stg_select') stgSelectOff = off;
    else selectMapOff = off;
    console.log(`select ${logical} 干净板：${clean.width}x${clean.height} → ${orig.width}x${orig.height} @(${off})`);
  } else {
    cpSync(src, join(selectDir, `${logical}.png`));
  }
}

// ---------- 3a-bis. select 叠加层（旋涡 + 地图面板 fx）→ assets/ui/select-fx/<char>/ ----------
const selectFx = { vortex: null, mapFx: [] };
{
  const selectFxDir = join(OUT_ASSETS, 'select-fx');
  // 旋涡：原板 = stg_select 原导出帧 1（FFDec 冻结相位未知 → 逐帧试配）
  const vortexDir = findSpriteDir(selectCleanExportDir, SELECT_VORTEX.char, 'select-clean 旋涡');
  const stgPlate = await rawBuf(join(findSpriteDir(selectExportDir, 75, 'stg_select'), '1.png'));
  const vortexCal = await calibrateOverlay(vortexDir, SELECT_VORTEX.frames, stgPlate, { x: 0, y: 0 }, SELECT_VORTEX.scale);
  // redAdd −255（sprite 72→71 放置）：newR = clamp(r−255) = 0 → 烘焙期清零红通道精确等价
  const vortexFrames = await collapseStaticFrames(vortexDir, SELECT_VORTEX.frames);
  await bakeOverlayFrames(vortexDir, vortexFrames, vortexCal.crop, join(selectFxDir, String(SELECT_VORTEX.char)), (img) =>
    img.linear([0, 1, 1], [0, 0, 0]),
  );
  selectFx.vortex = {
    char: SELECT_VORTEX.char,
    dir: `ui/select-fx/${SELECT_VORTEX.char}`,
    frames: vortexFrames,
    fps: 30,
    size: [vortexCal.crop[2], vortexCal.crop[3]],
    pos: [+vortexCal.plateTL[0].toFixed(2), +vortexCal.plateTL[1].toFixed(2)],
    scale: SELECT_VORTEX.scale,
  };
  console.log(`select 旋涡：${SELECT_VORTEX.frames} 帧 crop ${vortexCal.crop.join('x')} pos [${selectFx.vortex.pos}] sse ${Math.round(vortexCal.sse / 1000)}k`);

  // 地图面板 fx：原板 = select_map 原导出帧 1；注册点期望位 = 画布原点 O + 放置位。
  // O：PNG 坐标 = local + (78,0)。实证于静态 kuang 偏移 mapKuangOffset(92,19) =
  // d9 放置位(14,19)+(78,0)（画布原点在 local (−78,0)；下方 kuang 校准落点交叉验证）
  const mapPlate = await rawBuf(join(findSpriteDir(selectExportDir, 100, 'select_map'), '1.png'));
  const MAP_CANVAS_ORIGIN = [78, 0];
  const row100 = selectModel.sprites.get(100).frames[0] || {};
  for (const fx of SELECT_MAP_FX) {
    const p = row100[fx.depth];
    if (!p) throw new Error(`select_map d${fx.depth} 无放置（char ${fx.char}）`);
    const framesDir = findSpriteDir(selectCleanExportDir, fx.char, `select-clean map fx ${fx.char}`);
    const frameCount = await collapseStaticFrames(framesDir, selectModel.sprites.get(fx.char).frameCount);
    const cal = await calibrateOverlay(
      framesDir,
      frameCount,
      mapPlate,
      { x: MAP_CANVAS_ORIGIN[0] + p.x, y: MAP_CANVAS_ORIGIN[1] + p.y },
      [p.sx, p.sy],
    );
    let plateTL = cal.plateTL;
    // 显式解析位覆盖（画面平滑自相似 → 模板匹配歧义的元件，如 93 光层）
    if (fx.posOverride && p.sx > 0) {
      console.log(`  元件 ${fx.char} 锚点用解析位 [${fx.posOverride}]（校准 [${plateTL}]）`);
      plateTL = fx.posOverride;
    }
    await bakeOverlayFrames(framesDir, frameCount, cal.crop, join(selectFxDir, String(fx.char)));
    const px = p.sx < 0 ? plateTL[0] + cal.crop[2] * Math.abs(p.sx) : plateTL[0];
    selectFx.mapFx.push({
      char: fx.char,
      depth: fx.depth,
      dir: `ui/select-fx/${fx.char}`,
      frames: frameCount,
      fps: 30,
      size: [cal.crop[2], cal.crop[3]],
      pos: [+px.toFixed(2), +plateTL[1].toFixed(2)],
      scale: [+p.sx.toFixed(4), +p.sy.toFixed(4)],
    });
    console.log(`select map-fx char ${fx.char} d${fx.depth}：${frameCount} 帧 crop ${cal.crop.join('x')} pos [${selectFx.mapFx.at(-1).pos}] sse ${Math.round(cal.sse / 1000)}k`);
  }
  // 交叉验证：动画 kuang（99）校准落点应与静态 kuang 元件偏移一致（O 实证依据）
  const kuang = selectFx.mapFx.find((f) => f.char === 99);
  if (!kuang || Math.abs(kuang.pos[0] - 92) > 2 || Math.abs(kuang.pos[1] - 19) > 2) {
    throw new Error(`kuang 99 校准落点 [${kuang?.pos}] 偏离静态 kuang 偏移 (92,19)——O 假设失效`);
  }
}

// ---------- 3b. title 三层夹心（2026-11-24 重审立项，见 PROGRESS §2.4 / DESIGN §4） ----------
// 旧路线（FFDec 帧导出直接烘 90 帧 + 运行时模板匹配叠加）已证伪（嵌套 MC 被冻结在未知
// 内部帧、模板匹配被上层元件污染）。改纯构造：放置/变换 keys 全部来自 SWF 标签语义
//（Flash Player 自身执行的数据），不校准、不与原板核对。
//
// 三层夹心：
//   底板 assets/ui/title/      = 手术剔除 fx（全部 frameCount>1 嵌套 sprite 放置段）
//                                与顶层（d>25 静态段）后的 stg_title 90 帧；
//   叠加层 ×10                 = fx 元件各自帧序（assets/ui/title-fx/<char>/，内部脉冲由
//                                FFDec 烘进帧）+ vs（sprite 59：56 是 clipDepth 遮罩，
//                                烘"37 + 58∩56k"合成帧规避运行时遮罩）；
//   顶板 assets/ui/title-top/  = 只留 d>25（logo 文字/下载徽标/白闪/©）的 90 帧（α WebP）。
// keys（placementSegments 逐段常量压缩）：[(from,to,x,y,sx,sy,alpha)]，实例 = char×depth；
// origin = 元件内容 union 左上（= FFDec 导出画布原点，运行时 pos = x + sx*origin）。
const TITLE_FX_CHARS = [29, 32, 35, 38, 40, 41, 44, 47, 52];
const titleFx = { elements: {}, instances: [] };
const titlePlates = { bottomOrigin: null, topOrigin: null };
{
  run(FFDEC, ['-swf2xml', TITLE_SWF, join(SCRATCH, 'title.xml')]);
  const titleXml = readFileSync(join(SCRATCH, 'title.xml'), 'utf8');
  const titleModel = parseSwfXml(titleXml);
  const ROOT = TITLE.spriteId;
  const isFxChar = (id) => (titleModel.sprites.get(id)?.frameCount ?? 1) > 1;
  const allChars = [
    ...new Set(
      titleModel.sprites
        .get(ROOT)
        .frames.flatMap((row) => Object.values(row || {}).filter((p) => p?.charId != null).map((p) => p.charId)),
    ),
  ];
  const rootSegs = placementSegments(titleModel, ROOT, allChars);
  // 底板手术：fx 全部段 + 顶层（d>25）全部段
  const bottomSpecs = rootSegs
    .filter((s) => isFxChar(s.charId) || s.depth > 25)
    .map((s) => ({ depth: s.depth, charId: s.charId, from: s.from, to: s.to }));
  // 顶板手术：d<=25 全部段（char-less 窗口，连静态底图带 fx 一起剔）+ 59 段
  //（59 内扫光 56 是 clipDepth 遮罩，烘板会冻结成死帧 → 59 由运行时合成帧替代；
  //  同深度 37 的两个段（18-25/65-90）保留在顶板）+ 5DPLAY 导流横幅栈
  //（char 19 logomc_3，d27 独占、1..90 恒置 @(666.45,391.3)；2026-11-24 决策：
  //  他站导流广告不进重构版，整段剔除——原版单元件放置，剔即全帧消失，
  //  右下角自营需求由运行时独立元素承担，不烘进板）
  const topSpecs = rootSegs
    .filter((s) => s.depth <= 25 || s.charId === 59)
    .map((s) => ({ depth: s.depth, from: s.from, to: s.to }));
  topSpecs.push({ depth: 27, charId: 19, from: 1, to: TITLE.frames });
  const bakePlates = async (xml, what) => {
    const cleaned = removePlacements(xml, ROOT, what === 'bottom' ? bottomSpecs : topSpecs);
    const outXml = join(SCRATCH, `title-${what}.xml`);
    const outSwf = join(SCRATCH, `title-${what}.swf`);
    writeFileSync(outXml, cleaned);
    run(FFDEC, ['-xml2swf', outXml, outSwf]);
    if (fileMd5(outSwf) === fileMd5(TITLE_SWF)) throw new Error(`title-${what} 手术无效（与原版逐字节相同）`);
    const expDir = join(SCRATCH, `title-${what}`);
    run(FFDEC, ['-export', 'sprite', expDir, outSwf]);
    const dir = findSpriteDir(expDir, ROOT, `title-${what} stg_title`);
    const frames = readdirSync(dir).filter((f) => f.endsWith('.png'));
    if (frames.length !== TITLE.frames) {
      throw new Error(`title-${what} 帧数变化：${frames.length} ≠ ${TITLE.frames}`);
    }
    // 板画布 = 干净 sprite 内容 union（FFDec 画布原点 = union 左上，方法已对原板实证）；
    // 手术剔的内容改变 union → **每板各存 stageOriginInFrame**（剔顶层后底板原点上移、
    // 顶板只剩 logo/徽标族原点大幅左移，运行时按各自原点挂载）。
    run(FFDEC, ['-swf2xml', outSwf, join(SCRATCH, `title-${what}-check.xml`)]);
    const cleanModel = parseSwfXml(readFileSync(join(SCRATCH, `title-${what}-check.xml`), 'utf8'));
    const cb = contentBounds(cleanModel, ROOT);
    const stageOrigin = [-cb.minX, -cb.minY];
    const outDir = join(OUT_ASSETS, what === 'bottom' ? 'title' : 'title-top');
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    for (let i = 1; i <= TITLE.frames; i++) {
      const src = join(dir, `${i}.png`);
      if (i === 1) {
        const meta = await sharp(src).metadata();
        if (Math.abs(meta.width - (cb.maxX - cb.minX)) > 1.5 || Math.abs(meta.height - (cb.maxY - cb.minY)) > 1.5) {
          throw new Error(`title-${what} 画布 ${meta.width}x${meta.height} ≠ 干净内容 union ${(cb.maxX - cb.minX).toFixed(1)}x${(cb.maxY - cb.minY).toFixed(1)}`);
        }
      }
      await sharp(src).webp({ quality: 80 }).toFile(join(outDir, `${i}.webp`));
    }
    console.log(
      `title ${what} 板：${frames.length} 帧 画布 union [${cb.minX.toFixed(1)},${cb.minY.toFixed(1)}..${cb.maxX.toFixed(1)},${cb.maxY.toFixed(1)}] stageOrigin [${stageOrigin.map((v) => +v.toFixed(2))}]`,
    );
    return stageOrigin.map((v) => +v.toFixed(2));
  };
  titlePlates.bottomOrigin = await bakePlates(titleXml, 'bottom');
  titlePlates.topOrigin = await bakePlates(titleXml, 'top');

  // fx 元件帧序：内部脉冲由 FFDec 烘进帧；canvas 自检 = 内容 union 尺寸
  const titleExportDir = join(SCRATCH, 'title');
  for (const char of TITLE_FX_CHARS) {
    const framesDir = findSpriteDir(titleExportDir, char, `title fx ${char}`);
    const frameCount = titleModel.sprites.get(char).frameCount;
    const collapsed = await collapseStaticFrames(framesDir, frameCount);
    const cb = contentBounds(titleModel, char);
    const meta = await sharp(join(framesDir, '1.png')).metadata();
    if (Math.abs(meta.width - (cb.maxX - cb.minX)) > 1.5 || Math.abs(meta.height - (cb.maxY - cb.minY)) > 1.5) {
      throw new Error(`fx ${char} 画布 ${meta.width}x${meta.height} ≠ 内容 union ${(cb.maxX - cb.minX).toFixed(1)}x${(cb.maxY - cb.minY).toFixed(1)}（origin 语义失效）`);
    }
    const outDir = join(OUT_ASSETS, 'title-fx', String(char));
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    for (let i = 1; i <= collapsed; i++) {
      await sharp(join(framesDir, `${i}.png`)).webp({ quality: 80 }).toFile(join(outDir, `${i}.webp`));
    }
    titleFx.elements[char] = {
      dir: `ui/title-fx/${char}`,
      frames: collapsed,
      fps: TITLE.fps,
      size: [meta.width, meta.height],
      origin: [+cb.minX.toFixed(2), +cb.minY.toFixed(2)],
    };
  }

  // vs（sprite 59）：d1 shape37 常态 VS / d2 sprite56（clipDepth=5 遮罩，9 帧扫光，
  // Flash 语义 = 56 自身不渲染、只做 d3..d5 的 α 遮罩）/ d4 shape58 高光版。
  // 烘"37 + (58 ∩ 56k)"合成帧；运行时按 59 根放置 keys 摆放（与其它 fx 同模型）。
  {
    const s59 = titleModel.sprites.get(59);
    const row59 = s59.frames[0] || {};
    const p37 = row59[1];
    const p56 = row59[2];
    const p58 = row59[4];
    if (!p37 || !p56 || !p58) throw new Error(`sprite 59 内部放置缺失（${[1, 2, 4].filter((d) => !row59[d])}）`);
    const cb59 = contentBounds(titleModel, 59);
    const cb37 = contentBounds(titleModel, 37);
    const cb58 = contentBounds(titleModel, 58);
    const cb56 = contentBounds(titleModel, 56);
    const W = Math.ceil(cb59.maxX - cb59.minX);
    const H = Math.ceil(cb59.maxY - cb59.minY);
    // 元件 PNG（画布原点 = 其内容 union 左上）摆到 59 画布：off = at + cb.min − cb59.min
    const offOf = (cb, at) => [Math.round(at[0] + cb.minX - cb59.minX), Math.round(at[1] + cb.minY - cb59.minY)];
    const exportSub = async (specs, what) => {
      const cleaned = removePlacements(titleXml, 59, specs);
      const outXml = join(SCRATCH, `title-vs-${what}.xml`);
      const outSwf = join(SCRATCH, `title-vs-${what}.swf`);
      writeFileSync(outXml, cleaned);
      run(FFDEC, ['-xml2swf', outXml, outSwf]);
      const expDir = join(SCRATCH, `title-vs-${what}`);
      run(FFDEC, ['-export', 'sprite', expDir, outSwf]);
      const png = join(findSpriteDir(expDir, 59, `vs ${what}`), '1.png');
      const meta = await sharp(png).metadata();
      return { png, meta };
    };
    const base = await exportSub(
      [
        { depth: 2, charId: 56, from: 1, to: 1 },
        { depth: 4, charId: 58, from: 1, to: 1 },
      ],
      'base',
    );
    const shine = await exportSub(
      [
        { depth: 1, charId: 37, from: 1, to: 1 },
        { depth: 2, charId: 56, from: 1, to: 1 },
      ],
      'shine',
    );
    // 自检：37-only 画布应 ≈ cb37（FFDec 若把遮罩 56 当内容渲染，画布会混入 56 区域）
    if (Math.abs(base.meta.width - (cb37.maxX - cb37.minX)) > 1.5 || Math.abs(base.meta.height - (cb37.maxY - cb37.minY)) > 1.5) {
      throw new Error(`vs base 画布 ${base.meta.width}x${base.meta.height} ≠ shape37 union ${(cb37.maxX - cb37.minX).toFixed(1)}x${(cb37.maxY - cb37.minY).toFixed(1)}（FFDec 渲染了遮罩？）`);
    }
    const off37 = offOf(cb37, [p37.x, p37.y]);
    const off58 = offOf(cb58, [p58.x, p58.y]);
    const off56 = offOf(cb56, [p56.x, p56.y]);
    const mask56Dir = findSpriteDir(titleExportDir, 56, 'title vs 遮罩扫光');
    const vsFrames = titleModel.sprites.get(56).frameCount;
    const outDir = join(OUT_ASSETS, 'title-fx', '59');
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const w58 = Math.ceil(cb58.maxX - cb58.minX);
    const h58 = Math.ceil(cb58.maxY - cb58.minY);
    // 58（高光版）原始 RGBA：遮罩用像素级 α 乘法实现（56 画布 > 58 画布，
    // sharp composite 要求输入不大于底图，且 off56−off58 可为负 → 直接读像素）
    const shine58 = await sharp(shine.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const sw = shine58.info.width;
    const sh = shine58.info.height;
    for (let k = 1; k <= vsFrames; k++) {
      const m = await sharp(join(mask56Dir, `${k}.png`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const md = m.data;
      const mw = m.info.width;
      const d = Buffer.from(shine58.data); // 逐帧拷贝
      const px = off56[0] - off58[0];
      const py = off56[1] - off58[1];
      for (let yy = 0; yy < m.info.height; yy++) {
        const cy = py + yy;
        if (cy < 0 || cy >= sh) continue;
        for (let xx = 0; xx < mw; xx++) {
          const cx = px + xx;
          if (cx < 0 || cx >= sw) continue;
          // Flash 遮罩 = 被遮内容 α × 遮罩 α（dest-in 语义）
          const di = (cy * sw + cx) * 4 + 3;
          d[di] = (d[di] * md[(yy * mw + xx) * 4 + 3] + 127) / 255 | 0;
        }
      }
      const masked58 = await sharp(d, { raw: { ...shine58.info } }).png().toBuffer();
      await sharp({
        create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .composite([
          { input: base.png, left: off37[0], top: off37[1] },
          { input: masked58, left: off58[0], top: off58[1] },
        ])
        .webp({ quality: 80 })
        .toFile(join(outDir, `${k}.webp`));
    }
    titleFx.elements[59] = {
      dir: 'ui/title-fx/59',
      frames: vsFrames,
      fps: TITLE.fps,
      size: [W, H],
      origin: [+cb59.minX.toFixed(2), +cb59.minY.toFixed(2)],
    };
    console.log(`title vs（59 遮罩扫光）：${vsFrames} 合成帧 ${W}x${H} origin [${titleFx.elements[59].origin}]`);
  }

  // 实例 keys：char×depth 的根放置段（move-only 矩阵/色变换已并入段常量）
  for (const s of rootSegs.filter((s) => isFxChar(s.charId) || s.charId === 59)) {
    titleFx.instances.push({
      char: s.charId,
      depth: s.depth,
      from: s.from,
      to: s.to,
      keys: s.keys.map((k) => [
        k.from,
        k.to,
        +k.x.toFixed(2),
        +k.y.toFixed(2),
        +k.sx.toFixed(4),
        +k.sy.toFixed(4),
        +k.alpha.toFixed(4),
      ]),
    });
  }
  console.log(
    `title fx：${Object.keys(titleFx.elements).length} 元件 / ${titleFx.instances.length} 实例 ` +
      `（keys ${titleFx.instances.reduce((a, i) => a + i.keys.length, 0)} 段）`,
  );
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

// ---------- 3e. setting 底板（设置面板切片：FighterTester.swf 内嵌 setting.swf 抽取） ----------
let settingPlate = null;
{
  const binDir = join(SCRATCH, 'setting-bin');
  run(FFDEC, ['-export', 'binaryData', binDir, MAIN_SWF, '-selectid', String(SETTING.embedChar)]);
  const binFile = readdirSync(binDir).find((f) => f.startsWith(`${SETTING.embedChar}_setting`));
  if (!binFile) throw new Error(`FighterTester.swf 未内嵌 setting.swf（character ${SETTING.embedChar}）`);
  const settingSwf = join(SCRATCH, 'setting.swf');
  cpSync(join(binDir, binFile), settingSwf);
  const magic = readFileSync(settingSwf).subarray(0, 3).toString('latin1');
  if (magic !== 'ZWS' && magic !== 'CWS') throw new Error(`内嵌 setting.swf 魔数异常：${magic}`);

  // 底板 character id 从内嵌 SWF 自己的 SymbolClass 名单解析（不硬编码）
  const scDir = join(SCRATCH, 'setting-sc');
  run(FFDEC, ['-export', 'symbolClass', scDir, settingSwf]);
  const csv = readdirSync(scDir).find((f) => f.endsWith('.csv'));
  const row = readFileSync(join(scDir, csv ?? ''), 'utf8')
    .split('\n')
    .find((l) => l.split(';')[1]?.trim().replace(/^"|"$/g, '') === SETTING.plate);
  if (!row) throw new Error(`setting.swf SymbolClass 无 ${SETTING.plate}`);
  const plateId = Number(row.split(';')[0]);

  const expDir = join(SCRATCH, 'setting');
  run(FFDEC, ['-export', 'sprite', expDir, settingSwf, '-selectid', String(plateId)]);
  const dir = findSpriteDir(expDir, plateId, 'setting stg_set_ui');
  const frames = readdirSync(dir).filter((f) => f.endsWith('.png'));
  if (frames.length !== 1) throw new Error(`stg_set_ui 应为单帧静态板（实际 ${frames.length} 帧）`);
  // 画布原点 = 内容 union 左上；立绘出血越出 800×600 舞台 → 运行时裁剪到舞台矩形
  run(FFDEC, ['-swf2xml', settingSwf, join(SCRATCH, 'setting.xml')]);
  const settingModel = parseSwfXml(readFileSync(join(SCRATCH, 'setting.xml'), 'utf8'));
  const cb = contentBounds(settingModel, plateId);
  const origin = [-cb.minX, -cb.minY].map((v) => +v.toFixed(2));
  const outDir = join(OUT_ASSETS, 'setting');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  await sharp(join(dir, '1.png')).webp({ quality: 80 }).toFile(join(outDir, '1.webp'));

  // 设置页箭头/光标（原版 SetBtn.txt_arrow_mc 在 setting.swf、SetBtnGroup.select_arrow_mc 在
  // common_ui.swf）：按类名取 sprite 首帧，origin = 注册点在 PNG 内的位置（= -内容 union 左上）
  const settingSpriteDir = join(SCRATCH, 'setting-sprites');
  run(FFDEC, ['-export', 'sprite', settingSpriteDir, settingSwf]);
  run(FFDEC, ['-swf2xml', COMMON_SWF, join(SCRATCH, 'common.xml')]);
  const commonModel = parseSwfXml(readFileSync(join(SCRATCH, 'common.xml'), 'utf8'));
  const arrows = {};
  for (const [key, srcDir, srcModel, cls] of [
    ['txt_arrow', settingSpriteDir, settingModel, SETTING_ARROWS.txt_arrow],
    ['select_arrow', join(SCRATCH, 'menu'), commonModel, SETTING_ARROWS.select_arrow],
  ]) {
    const arrowDir = readdirSync(srcDir).find((d) => d.endsWith(`_${cls}`));
    if (!arrowDir) throw new Error(`未找到箭头元件 ${cls}（${key}）`);
    const id = Number(arrowDir.match(/^DefineSprite_(\d+)_/)?.[1]);
    const src = join(srcDir, arrowDir, '1.png');
    if (!existsSync(src)) throw new Error(`箭头元件 ${cls} 缺首帧`);
    const b = contentBounds(srcModel, id);
    cpSync(src, join(outDir, `${key}.png`));
    arrows[key] = { file: `ui/setting/${key}.png`, origin: [-b.minX, -b.minY].map((v) => +v.toFixed(2)) };
    console.log(`设置箭头：${cls}（sprite ${id}）→ assets/ui/setting/${key}.png origin [${arrows[key].origin}]`);
  }

  settingPlate = { dir: 'ui/setting', frames: 1, stageOriginInFrame: origin, arrows };
  console.log(`setting 底板：${SETTING.plate} 1 帧 画布 union [${cb.minX.toFixed(1)},${cb.minY.toFixed(1)}..${cb.maxX.toFixed(1)},${cb.maxY.toFixed(1)}] origin [${origin}] → assets/ui/setting/1.webp`);
}

// ---------- 3f. logo 补间化（Tier 2，DESIGN §4.8）：单贴图 + alpha 补间 ----------
// logo_movie 实为两层：d1 白矩形铺满舞台（帧 1..65 常驻、末帧移除）+ d2 logo 图形逐帧
// CXFORM 白↔本色灰度互补渐变（mult+add ≡ 1，alpha 恒 1，无 blend mode）。互补渐变作用于
// 压平合成帧与「白底上 alpha 淡入淡出」逐像素同式 → 恒等定格帧（帧 20）单贴图 +
// CXFORM 导出的 alpha 关键帧补间忠实还原；参数提取与断言见 logo-tween.mjs。
// 逐帧流烘焙已停（2026-11-25 目检通过收编）；取帧源 = FFDec sprite 导出 PNG（common.xml
// 由 3e 的 swf2xml 生成，本段须在其后）。
let logoTween = null;
{
  const tween = extractLogoTween(readFileSync(join(SCRATCH, 'common.xml'), 'utf8'), {
    spriteId: LOGO.spriteId,
    frames: LOGO.frames,
    logoChar: 19,
    bgChar: 17,
  });
  const outTweenDir = join(OUT_ASSETS, 'logo-tween');
  rmSync(outTweenDir, { recursive: true, force: true });
  mkdirSync(outTweenDir, { recursive: true });
  const src = join(findSpriteDir(join(SCRATCH, 'menu'), LOGO.spriteId, 'common_ui.swf logo_movie'), `${tween.texFrame}.png`);
  await sharp(src).webp({ quality: 80 }).toFile(join(outTweenDir, 'base.webp'));
  logoTween = { texture: 'ui/logo-tween/base.webp', keys: tween.keys };
  console.log(`logo tween：帧 ${tween.texFrame} 单贴图 + ${tween.keys.length} 关键帧 [${tween.keys.map(([f, a]) => `${f}:${a}`).join(', ')}] → assets/ui/logo-tween/base.webp`);
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
  schema: 'bvn/ui@8',
  faces, // 类名 → faces/ 下文件名（grid/_b/_m；*_w 胜者立绘不导出——结算画面已移除）
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
    // ---- 切片 45：嵌套动画叠加层 ----
    /** 旋涡背景（sprite 71 循环，红通道烘焙期清零；pos = stg_select.png 内锚点，scale 拉伸） */
    vortex: selectFx.vortex,
    /** 地图面板 fx（pos = select_map.png 内锚点；scale[0]<0 = 镜像，锚点为可见区右缘） */
    mapFx: selectFx.mapFx,
  },
  maps: { dir: 'ui/maps' },
  // ---- 切片 16：title 开场流帧 + 主菜单按钮（原版 MenuStage/MenuBtnGroup/MenuBtn 规格） ----
  // ---- 切片 46：三层夹心（底板 dir / 顶板 topDir / fx 叠加层，语义见 3b 段头注） ----
  title: {
    dir: 'ui/title',
    /** 顶板（d>25：logo 文字/下载徽标/白闪/©，色变换由 FFDec 烘死） */
    topDir: 'ui/title-top',
    frames: TITLE.frames,
    fps: TITLE.fps,
    /** 板画布原点 = 干净 sprite 内容 union 左上（板各不相同，运行时按各自原点挂载） */
    stageOriginInFrame: titlePlates.bottomOrigin,
    topStageOriginInFrame: titlePlates.topOrigin,
    /** 原版 stg_title 帧脚本语义：intro 播 introFrom..introStop 定格；点击后 menuFrame..menuStop 定格 */
    introFrom: TITLE.introFrom,
    introStop: TITLE.introStop,
    menuFrame: TITLE.menuFrame,
    menuStop: TITLE.menuStop,
    /** fx 叠加层（2026-11-24 纯构造）：elements[char] = 帧序规格（origin = 内容 union 左上
     *  = FFDec 画布原点）；instances = char×depth 根放置段，keys [(from,to,x,y,sx,sy,alpha)]
     *  为 stg_title 局部坐标（= 原版舞台坐标），运行时 pos = x + sx*origin[0]（y 同）。 */
    fx: titleFx,
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
  // ---- 切片 29：logo 开场徽标演出（原版 LogoStage：gotoAndPlay(2) 播到帧 66 COMPLETE） ----
  logo: {
    frames: LOGO.frames,
    fps: LOGO.fps,
    from: LOGO.from,
    stop: LOGO.stop,
    stageOriginInFrame: LOGO.stageOriginInFrame,
    // Tier 2 tween 化（DESIGN §4.8）：单贴图 + alpha 关键帧补间（2026-11-25 目检通过收编，
    // 逐帧流已停烘）
    tween: logoTween,
  },
  // ---- 设置面板切片：原版 stg_set_ui 单帧静态板（背景 + OPTION 标题 + 一护立绘） ----
  setting: settingPlate,
};

mkdirSync(dirname(OUT_BAKED), { recursive: true });
writeFileSync(OUT_BAKED, JSON.stringify(doc));
console.log(
  `ui-pack: faces ${faceCount} / select ${Object.keys(SELECT_ELEMENTS).length} 元件 / title 三层夹心（${TITLE.frames}+${TITLE.frames} 帧 + fx ${Object.keys(titleFx.elements).length} 元件） / select-fx 旋涡+${selectFx.mapFx.length} / menu ${Object.keys(MENU_ELEMENTS).length} 元件 / setting 底板 / maps ${mapCount} 张 → ${OUT_ASSETS} + ${OUT_BAKED}`,
);
