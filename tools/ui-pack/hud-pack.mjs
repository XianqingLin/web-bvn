#!/usr/bin/env node
/**
 * hud-pack：对局 HUD 原版化资产管线（切片 30）。
 *
 * 来源 fight.swf（ResUtils.fight [Embed] → 内嵌于 FighterTester.swf binaryData）：
 *   1. FFDec binaryData 导出 → 挑 fight_swf bin；
 *   2. FFDec sprite 导出 → 挑 HUD 动态零件（血条填充/气条分段/能量条/胜利星/连击数字等）；
 *   3. FFDec shape 导出（SVG 光栅化）→ 按内容尺寸挑纯底板（血条槽/头像框/能量槽等；
 *      直出位图的 JPEG3 alpha 通道损坏，shape 渲染路径干净）；
 *   4. 产出 baked/hud.json（schema bvn/hud@1）：文件映射 + XFL 逆向布局常量。
 *
 * 坐标规格来源：XFL 工程 swf_source/embed/fight（重建版源码，坐标=像素）：
 *   - ui_fight(mc_044) 顶层：hpbarmc@(400,45.6)、fzqi1@(48,534.1)、fzqi2@(749,534.1,a=-1)、
 *     hits1@(62.15,121.95)、hits2@(662.15,121.95)、startKOmc@(0,0)（开局段已收编，intro 切片）；
 *   - 血条填充 bar/redbar 内容 x[-260,0]（锚点右端，scaleX 从右往左缩）；
 *   - 气条三段 bar1..3 139/139/140×12 同位叠放（scaleX 按 qi 等级），bar4=满气动画帧 1；
 *   - 能量条填充 123×5 锚点右端；fzqi 辅助格 64×45 scrollRect 底部向上填充。
 *
 * 用法：node tools/ui-pack/hud-pack.mjs [--ffdec PATH] [--out-assets DIR] [--out-baked FILE]
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const ROOT = resolve(import.meta.dirname, '../..');
const FFDEC = resolve(opt('ffdec', 'C:/Program Files (x86)/FFDec/ffdec-cli.exe'));
const FIGHTER_TESTER_SWF = resolve(
  opt('fighter-tester-swf', 'OpenBleachVsNaruto/_release/extracted/swf_output/FighterTester.swf'),
);
const OUT_ASSETS = resolve(opt('out-assets', 'packages/data/assets/ui/hud'));
const OUT_BAKED = resolve(opt('out-baked', 'packages/data/baked/hud.json'));
const SCRATCH = resolve(import.meta.dirname, '_scratch/hud-pack');

function run(cmd, args_) {
  console.log(`$ ${cmd} ${args_.join(' ')}`);
  execFileSync(cmd, args_, { stdio: ['ignore', 'pipe', 'inherit'] });
}

// ---------- 1. 提取 fight.swf 并导出 ----------
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
if (!existsSync(FFDEC)) throw new Error(`FFDec CLI 不存在：${FFDEC}`);
run(FFDEC, ['-export', 'binaryData', join(SCRATCH, 'src'), FIGHTER_TESTER_SWF]);
{
  const bin = readdirSync(join(SCRATCH, 'src')).find((f) => f.includes('fight_swf') && f.endsWith('.bin'));
  if (!bin) throw new Error('FighterTester.swf 未找到内嵌 fight.swf binaryData');
  copyFileSync(join(SCRATCH, 'src', bin), join(SCRATCH, 'fight.swf'));
}
const FIGHT_SWF = join(SCRATCH, 'fight.swf');
run(FFDEC, ['-export', 'sprite', join(SCRATCH, 'sprites'), FIGHT_SWF]);
run(FFDEC, ['-export', 'shape', join(SCRATCH, 'shapes'), FIGHT_SWF]);

const spriteDir = (id, what) => {
  const d = readdirSync(join(SCRATCH, 'sprites')).find(
    (x) => x === `DefineSprite_${id}` || x.startsWith(`DefineSprite_${id}_`),
  );
  if (!d) throw new Error(`fight.swf 未找到 sprite ${id}（${what}）`);
  return join(SCRATCH, 'sprites', d);
};

/**
 * 按 shape id 挑底板（FFDec shape SVG 光栅化）。
 * 直出位图（-export image）的 JPEG3 alpha 通道损坏（洋红噪点），shape 渲染路径干净；
 * shape id ↔ XFL picture 映射由内容尺寸唯一锁定（规格见 XFL picture 表）。
 */
async function shapePng(id, expectW, expectH) {
  const svg = join(SCRATCH, 'shapes', `${id}.svg`);
  if (!existsSync(svg)) throw new Error(`fight.swf 未找到 shape ${id}`);
  const png = await sharp(svg, { density: 72 }).resize(expectW, expectH).png().toBuffer();
  return png;
}
async function putShape(name, id, w, h) {
  await sharp(await shapePng(id, w, h)).toFile(join(OUT_ASSETS, `${name}.png`));
  el[name] = `ui/hud/${name}.png`;
}

/** 平均色（判歧义：绿填充 vs 红残影）。 */
async function avgColor(p) {
  const { data } = await sharp(p).resize(1, 1).raw().toBuffer({ resolveWithObject: true });
  return [data[0], data[1], data[2]];
}

/** 位图内容是否与参照 PNG 一致（64×45 歧义：sprite 95 = fz-fill picture_073）。 */
async function sameImage(a, b) {
  const [ra, rb] = await Promise.all([sharp(a).raw().toBuffer(), sharp(b).raw().toBuffer()]);
  return ra.length === rb.length && ra.equals(rb);
}

// ---------- 2. 零件 → assets/ui/hud/ ----------
rmSync(OUT_ASSETS, { recursive: true, force: true });
mkdirSync(OUT_ASSETS, { recursive: true });
const el = {};
/** startKOmc Round 数字合成规格（数字块产出；无则 baked 不含该字段） */
let startKONumSpec = null;
/** Round 词居中 delta（数字块产出；无数字块时字样组合退词-only 居中） */
let startKOWordDelta = 39.5;
/** 逐帧居中 delta（数字块产出；数字窗口内为词 delta 占位，运行时按回合覆盖） */
let startKOFrameDeltas = null;
async function put(name, src) {
  copyFileSync(src, join(OUT_ASSETS, `${name}.png`));
  el[name] = `ui/hud/${name}.png`;
}
async function putFrames(name, dir, frames, expect) {
  mkdirSync(join(OUT_ASSETS, name), { recursive: true });
  const files = readdirSync(dir).filter((f) => f.endsWith('.png'));
  if (expect && files.length !== expect) {
    throw new Error(`${name} 帧数变化：${files.length} ≠ ${expect}（规格须同步更新）`);
  }
  for (let i = 1; i <= frames; i++) {
    copyFileSync(join(dir, `${i}.png`), join(OUT_ASSETS, name, `${i}.png`));
  }
  el[name] = `ui/hud/${name}`;
}

// 血条：槽底 shape 142 = picture_076 (271×23) + 顶装饰 shape 134 = picture_008 (268×19)；
// 填充 sprite 137/140 (260×15，锚右；绿=主条 / 红=残影)
await putShape('hp-slot', 142, 271, 23);
await putShape('hp-deco', 134, 268, 19);
{
  const a = spriteDir(137, '血条填充');
  const b = spriteDir(140, '血条残影');
  const ca = await avgColor(join(a, '1.png'));
  const cb = await avgColor(join(b, '1.png'));
  const green = ca[1] > ca[0] ? [a, b] : [b, a];
  await put('hp-fill', join(green[0], '1.png'));
  await put('hp-red', join(green[1], '1.png'));
}
// 头像顶层框 shape 150 = picture_090 (102×64)：内部为半透明玻璃暗罩（脸透出
// 变暗），mc_034 里位于最顶层不被 mask 裁剪（hud.ts buildFace 深度序：黑底 +
// 脸槽被六边形 mask 裁 → 框盖顶；曾垫底被脸图盖住 = 缺框）
await putShape('face-bg', 150, 102, 64);
// 能量条：槽底 shape 119 = picture_061 (140×10)；填充 sprite 117 (2帧 flash)；标签 sprite 132 (2帧 comicType)
await putShape('energy-bg', 119, 140, 10);
await putFrames('energy-fill', spriteDir(117, '能量填充'), 2, 2);
await putFrames('energy-label', spriteDir(132, '能量标签'), 2, 2);
// 气条：槽体 shape 57 = shape_001（底板+黑槽合成体 159×19）；分段 60/68 (139×12) +
// 71 (140×12) + 74 帧1 (140×12 满气)；ghost 65 (2帧)；段字图标 84 (4帧)；
// 顶层装饰框 shape 86 = picture_063 (191×23)：XFL 重建源图层标 visible=false 系
// FFDec 导出伪影——编译 SWF qbar_barmc(sprite 87) 渲染 191×24 含此框（曾漏烘 = 缺框）
await putShape('qi-slot', 57, 159, 19);
await putShape('qi-frame', 86, 191, 23);
{
  const s1 = join(spriteDir(60, '气条1'), '1.png');
  const s2 = join(spriteDir(68, '气条2'), '1.png');
  const same =
    readFileSync(s1).equals(readFileSync(s2)) ||
    (await avgColor(s1)).join(',') === (await avgColor(s2)).join(',');
  await put('qi-seg-1', s1);
  await put('qi-seg-2', same ? s1 : s2);
  await put('qi-seg-3', join(spriteDir(71, '气条3'), '1.png'));
  await put('qi-seg-4', join(spriteDir(74, '气条4'), '1.png'));
}
await putFrames('qi-ghost', spriteDir(65, '幽步箭头'), 2, 2);
await putFrames('qi-txt', spriteDir(84, '气条段字'), 4, 4);
// 辅助格：底 shape 97 = picture_072 (66×47)；填充 sprite 95 (64×45)；顶层 shape 89/94
// 中不等于填充的 64×45；红点 sprite 92 (11×11)
await putShape('fz-bg', 97, 66, 47);
{
  const fillPng = join(spriteDir(95, '辅助格填充'), '1.png');
  await put('fz-fill', fillPng);
  const a = await shapePng(89, 64, 45);
  const b = await shapePng(94, 64, 45);
  const fa = await sameImage(a, fillPng);
  const fb = await sameImage(b, fillPng);
  if (fa && fb) throw new Error('fz 64×45 两 shape 均与填充一致（规格冲突）');
  const topPng = fa ? b : a;
  await sharp(topPng).toFile(join(OUT_ASSETS, 'fz-top.png'));
  el['fz-top'] = 'ui/hud/fz-top.png';
}
await put('fz-dot', join(spriteDir(92, '辅助格红点'), '1.png'));
// 辅助头像（mc_025 facemc，SWF 深度序——批次 33 修正）：底 黑底 shape 100 =
// picture_075 (55×39，bounds Xmin 11tw=0.55px/Ymin 0) → 裁剪 shape 101 (clipDepth 5，
// 54×37，bounds Xmin 10tw=0.5px/Ymin 20tw=1px) → ct 脸槽（空容器，QiBar 加 50×50 脸，
// 被 101 裁剪）→ 顶 六边形框 shape 103 = picture_070 (55×37，bounds Ymin 20tw=1px)。
// 曾按 shape id 大小误判 103 为底/100 为顶 → 黑块盖住头像。
await putShape('face-assist-shade', 100, 55, 39);
await putShape('face-assist-mask', 101, 54, 37);
await putShape('face-assist-frame', 103, 55, 37);
// READY 闪字 sprite 108 (20帧，f1-13 显 / f14-19 空)；时间板 shape 162 = picture_045
// (75×54) + ∞ sprite 165
await putFrames('ready-anim', spriteDir(108, 'READY 动画'), 20, 20);
await putShape('time-bg', 162, 75, 54);
await put('time-inf', join(spriteDir(165, '无限符号'), '1.png'));
// 连击：HITS 字 sprite 52 (59×30)；数字 sprite 22 (10帧，帧 N = 数字 N-1)
await put('hits-label', join(spriteDir(52, 'HITS 字'), '1.png'));
await putFrames('num', spriteDir(22, '连击数字'), 10, 10);
// 胜利星 sprite 157 (40帧；in_bleach 10..29 / in_naruto 30..40)
await putFrames('win', spriteDir(157, '胜利星'), 40, 40);
// 开局字样（startKOmc = mc_043，sprite 228，画布 663×466）：XFL 帧标签
// stop@0 dur9 / start@9 dur45 / fight@54 dur33 / stop@87 dur7 / go:fight@139 / ko@144 /
// winner@199 / timeover@219 / drawgame@266。本切片只收编开局段 = start+fight
// （XFL 帧 9..87 = FFDec PNG 10..88，79 帧；renderStartAndKO 每 30Hz tick 手动
// nextFrame，78 步走完 → COMPLETE）。KO/timeover/winner/drawgame 结算段遗留。
// PNG(0,0) = 画布原点 mc(13,103)（像素取证：帧 36-53 静态 scale-1 nummc 实例 +
// 6098px 数字 blob 恒等解出）；摆放 = ui_fight.startKOmc@(0,0) + showStart y=-50
// → PNG(0,0) 落 ui_fight (13,53)。嵌套 nummc（Round 计数）已烘进各帧位图。
{
  const dir = spriteDir(228, 'startKOmc 字样');
  const files = readdirSync(dir).filter((f) => f.endsWith('.png'));
  if (files.length !== 317) throw new Error(`startKOmc 帧数变化：${files.length} ≠ 317（规格须同步更新）`);
  const STARTKO_FRAMES = 79;
  mkdirSync(join(OUT_ASSETS, 'startko'), { recursive: true });
  for (let i = 0; i < STARTKO_FRAMES; i++) {
    copyFileSync(join(dir, `${i + 10}.png`), join(OUT_ASSETS, 'startko', `${i + 1}.png`));
  }
  el['startko'] = 'ui/hud/startko';

  // —— Round 数字（nummc 收编修正，批次 43）——
  // 原版 nummc（mc_041）由 mc_043 帧脚本 nummc.gotoAndPlay("r"+$round) 控制
  // （FightUI.showStart: startKOmc.$round = round）：数字 1..5 = 静态位图
  // （swf id 182/185/188/191/194，画布锚 mc_041(10,2)）+ 实例级遮罩揭示动画。
  // FFDec 帧导出不执行脚本 → 原始嵌套时间轴被烘进位图（数字 1 于资产帧
  // 18-43、数字 2 于 44-45），第二回合起字样错轮、回合 1 末尾还闪数字 2。
  // 修正：字样帧位图数字区擦除 + 数字位图独立导出逐帧合成（数字窗口 =
  // 揭示 18-27 + 稳定 28-45；帧 46+ Fight! 文本侵入数字矩形故不擦）。
  // 偏离登记（2026-11-19）：① 数字 2-5 的揭示借数字 1 的逐帧 alpha 遮罩
  // （原版为遮罩扫掠纯 alpha 语义，揭示瞬间的加色闪光 RGB 无法由 alpha
  // 遮罩复原，~0.3s 微差）；② 原版 round≥5 用 start_final 段（XFL 另段未
  // 收编）→ 恒用 start 段，数字按 min(round,5) 封顶（3v3 最多 5 回合）。
  const NUM = {
    /** 数字擦除区（字样画布坐标；词右缘 x431、数字画布 x[441,527] y[340,457]
     *  + 揭示闪光 y~296 起外扩） */
    erase: { x0: 433, y0: 290, x1: 540, y1: 460 },
    /** 数字帧合成画布（数字位图锚 (441,340) 的外扩裁剪）与摆放点 */
    crop: { x0: 441, y0: 290, w: 87, h: 171 },
    /** 数字显示窗口（资产帧号）：揭示 18-27 + 稳定 28-45 */
    from: 18,
    to: 45,
    /** swf 位图 id = 数字 1..5（-selectid image:png_gif_jpeg_alpha 导出，
     *  JPEG3 alpha 噪点以分离 alpha 通道规避） */
    ids: [182, 185, 188, 191, 194],
    /** 揭示遮罩参照 alpha（a_stable=0 的闪光区按 a_k/REF 计） */
    flashRef: 200,
  };
  const pngOf = (assetFrame) => join(dir, `${assetFrame + 9}.png`); // 资产帧 N ↔ PNG N+9
  const cropRaw = async (path) => {
    const { data, info } = await sharp(path)
      .extract({ left: NUM.crop.x0, top: NUM.crop.y0, width: NUM.crop.w, height: NUM.crop.h })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return data;
  };
  // 揭示遮罩（数字 1 逐帧 alpha ÷ 稳定帧 alpha；闪光区按 flashRef）
  const aStable = await cropRaw(pngOf(28));
  const masks = [];
  for (let n = NUM.from; n <= 27; n++) {
    const aK = await cropRaw(pngOf(n));
    const mask = Buffer.alloc(NUM.crop.w * NUM.crop.h);
    for (let i = 0; i < mask.length; i++) {
      const s = aStable[i * 4 + 3];
      const k = aK[i * 4 + 3];
      mask[i] = s > 0 ? Math.min(255, Math.round((k / s) * 255)) : Math.min(255, Math.round((k / NUM.flashRef) * 255));
    }
    masks.push(mask);
  }
  // 数字位图导出 + RGBA 组合（jpg 色 + alpha.png 第 4 通道）
  const numDir = join(SCRATCH, 'numimg');
  rmSync(numDir, { recursive: true, force: true });
  run(FFDEC, ['-selectid', NUM.ids.join(','), '-format', 'image:png_gif_jpeg_alpha', '-export', 'image', numDir, FIGHT_SWF]);
  const glyphOf = async (id) => {
    const rgb = await sharp(join(numDir, `${id}.jpg`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const al = await sharp(join(numDir, `${id}.alpha.png`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const out = Buffer.alloc(rgb.info.width * rgb.info.height * 4);
    for (let i = 0; i < rgb.info.width * rgb.info.height; i++) {
      out[i * 4] = rgb.data[i * 4];
      out[i * 4 + 1] = rgb.data[i * 4 + 1];
      out[i * 4 + 2] = rgb.data[i * 4 + 2];
      out[i * 4 + 3] = al.data[i * 4 + 3];
    }
    return { data: out, w: rgb.info.width, h: rgb.info.height };
  };
  // 帧位图擦除（资产帧 18..45 = 输出 PNG N..；先于数字合成完成即可）
  for (let n = NUM.from; n <= NUM.to; n++) {
    const p = join(OUT_ASSETS, 'startko', `${n}.png`);
    const { data, info } = await sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let y = NUM.erase.y0; y <= NUM.erase.y1; y++) {
      for (let x = NUM.erase.x0; x <= NUM.erase.x1; x++) data[(y * info.width + x) * 4 + 3] = 0;
    }
    await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(p);
  }
  // 数字合成帧：startko-num/<资产帧号> 连续铺 5 组（运行时按 round 选组）
  const numOut = join(OUT_ASSETS, 'startko-num');
  mkdirSync(numOut, { recursive: true });
  const per = NUM.to - NUM.from + 1;
  for (let d = 1; d <= NUM.ids.length; d++) {
    const g = await glyphOf(NUM.ids[d - 1]);
    if (g.w > NUM.crop.w || g.h > NUM.crop.h - 50) {
      throw new Error(`数字 ${d} 位图 ${g.w}×${g.h} 超出合成画布 ${NUM.crop.w}×${NUM.crop.h}`);
    }
    for (let n = NUM.from; n <= NUM.to; n++) {
      const canvas = Buffer.alloc(NUM.crop.w * NUM.crop.h * 4);
      const gx = 0; // 数字锚 (441,340) − 裁剪原点 (441,290)
      const gy = 50;
      const useMask = n <= 27;
      for (let y = 0; y < g.h; y++) {
        for (let x = 0; x < g.w; x++) {
          const gi = (y * g.w + x) * 4;
          const ci = ((y + gy) * NUM.crop.w + (x + gx)) * 4;
          const m = useMask ? masks[n - NUM.from][y * NUM.crop.w + x] / 255 : 1;
          canvas[ci] = g.data[gi];
          canvas[ci + 1] = g.data[gi + 1];
          canvas[ci + 2] = g.data[gi + 2];
          canvas[ci + 3] = Math.round((g.data[gi + 3] / 255) * m * 255);
        }
      }
      const idx = (d - 1) * per + (n - NUM.from) + 1;
      await sharp(canvas, { raw: { width: NUM.crop.w, height: NUM.crop.h, channels: 4 } })
        .png()
        .toFile(join(numOut, `${idx}.png`));
    }
  }
  el['startko-num'] = 'ui/hud/startko-num';
  // —— per-round 居中 delta（修复批次 62）——
  // 批次 44 的固定 39.5 = 单帧实测，实测帧含揭示闪光像素（bbox 右缘被闪光外扩
  // 推远）且不适配逐回合数字宽度 → 用户实测仍不居中。改烘焙 per-round delta：
  // 组合（Round 词 @ 稳定帧 + 稳定数字 glyph）不透明像素 bbox 中心 cxc（字样
  // 画布坐标）→ delta = 387 - cxc。推导：center 钉扎下 PNG 原点 design x =
  // pos[0]+delta（pos[0]=13），内容像素 cx_canvas 落 13+delta+cx_canvas，令组合
  // 中心 = 400（800 舞台中线）解出；批次 44 实测（canvas 186..509，去闪光后
  // 即词区）复核 387-347.5 = 39.5 一致。
  const alphaBBox = (data, w, h, xLimit = Infinity) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < Math.min(w, xLimit); x++) {
        if (data[(y * w + x) * 4 + 3] > 0) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    return x1 < x0 ? null : { x0, y0, x1, y1 };
  };
  const WORD_FRAME = 30; // 稳定数字窗口（28..45）取中帧：词完整、数字区已擦除
  const wordRaw = await sharp(join(OUT_ASSETS, 'startko', `${WORD_FRAME}.png`))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // 词 bbox 限 x<433（数字擦除区左缘——揭示闪光向左外扩的残留不计入）
  const wordBBox = alphaBBox(wordRaw.data, wordRaw.info.width, wordRaw.info.height, 433);
  if (!wordBBox) throw new Error(`hud-pack: startko 帧 ${WORD_FRAME} 无词内容`);
  const deltaOf = (bb) => 387 - (bb.x0 + bb.x1) / 2;
  startKOWordDelta = deltaOf(wordBBox);
  const numDeltas = [];
  for (let d = 1; d <= NUM.ids.length; d++) {
    const g = await glyphOf(NUM.ids[d - 1]);
    const gb = alphaBBox(g.data, g.w, g.h);
    if (!gb) throw new Error(`hud-pack: 数字 ${d} 位图无内容`);
    // 数字画布区 = 字样画布 (441+lx, 340+ly)；组合 bbox = 词 ∪ 稳定数字
    numDeltas.push(deltaOf({ x0: Math.min(wordBBox.x0, 441 + gb.x0), y0: 0, x1: Math.max(wordBBox.x1, 441 + gb.x1), y1: 0 }));
  }
  // 分段居中（实测）：词-only 帧（字样出现 ~10..17，bbox 中心 307.5 → 固定
  // 39.5 下偏左 40px）与 Fight! 段（46..79，中心 ~407 → 偏右 ~59px）在固定
  // delta 下都不居中（用户实测"回合字样不居中"的第二根因）。按段烘焙：
  //   frameDeltas[assetFrame-1]：1..17 = 词 delta（前置 shine 小件随词区）；
  //   18..45 = 词 delta 占位（运行时按回合用 num.centerDeltas 覆盖——数字
  //   位图运行时合成，烘焙帧已擦除）；46..79 = Fight! 段逐帧 bbox。
  const fightDeltas = [];
  for (let n = NUM.to + 1; n <= STARTKO_FRAMES; n++) {
    const fr = await sharp(join(OUT_ASSETS, 'startko', `${n}.png`))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const bb = alphaBBox(fr.data, fr.info.width, fr.info.height);
    // 空帧（末帧空黑 = 播完即隐语义）沿用前一帧 delta，运行时反正不可见
    if (!bb) {
      fightDeltas.push(fightDeltas.length > 0 ? fightDeltas.at(-1) : startKOWordDelta);
      continue;
    }
    fightDeltas.push(deltaOf(bb));
  }
  const frameDeltas = [];
  for (let n = 1; n <= STARTKO_FRAMES; n++) {
    frameDeltas.push(n <= NUM.to ? startKOWordDelta : fightDeltas[n - NUM.to - 1]);
  }
  startKOFrameDeltas = frameDeltas;
  startKONumSpec = {
    pos: [NUM.crop.x0, NUM.crop.y0],
    from: NUM.from,
    to: NUM.to,
    digits: NUM.ids.length,
    frames: per,
    centerDeltas: numDeltas,
  };
}

// —— 结算字样 KO 段（回合结算流程收编）：XFL 标签 ko@144，帧脚本实证
// （FFDec -export script：mc_043_42.as frame190 stop+COMPLETE）→ 播 XFL
// 144..190 = PNG 145..191，47 帧 @30fps，末帧空黑（播完即隐，运行时无需定格）。
// 摆位：playKO2 设 startKOmc.y=0（showStart 的 -50 被覆写）→ PNG(0,0) 落
// ui_fight (13,103)（canvasOrigin 换算同 startKO 段）。
{
  const dir = spriteDir(228, 'startKOmc 字样');
  const KO_FROM = 145; // XFL 帧 144 = FFDec PNG 145（XFL = PNG - 1）
  const KO_FRAMES = 47; // XFL 144..190
  mkdirSync(join(OUT_ASSETS, 'startko-ko'), { recursive: true });
  for (let i = 0; i < KO_FRAMES; i++) {
    copyFileSync(join(dir, `${KO_FROM + i}.png`), join(OUT_ASSETS, 'startko-ko', `${i + 1}.png`));
  }
  el['startko-ko'] = 'ui/hud/startko-ko';
}

// —— 胜利字样（winnermc = mc_042，sprite 221，嵌套于 mc_043 winner 段）：
// 帧脚本实证（mc_042_44.as）：自身时间轴 1..28 "Winner" 缩放入场；frame29 非
// perfect stop+COMPLETE（定格 Winner）；perfect 续播至 frame56 stop（定格
// Winner+Perfect）。动画期 mc_043 停在帧 210 等 COMPLETE（不随父时间轴走）→
// 必须独立烘焙独立驱动。摆位（mc_043 帧脚本 frame200：winnermc.x=$winnerX、
// y=$winnerY=90；FightUI.showWinner：$winnerX = 30|546 按胜方侧、startKOmc.y=30）
// → 原点 ui_fight = (30|546, 120)。PNG(0,0) = sprite 原点（各帧内容全正坐标，
// 帧间对齐由 FFDec 统一画布保证；目检项）。
{
  const dir = spriteDir(221, 'winnermc 胜利字样');
  const WIN_FRAMES = 56;
  mkdirSync(join(OUT_ASSETS, 'winnerko'), { recursive: true });
  for (let i = 1; i <= WIN_FRAMES; i++) {
    copyFileSync(join(dir, `${i}.png`), join(OUT_ASSETS, 'winnerko', `${i}.png`));
  }
  el['winnerko'] = 'ui/hud/winnerko';
}

// ---------- 3. baked/hud.json ----------
const doc = {
  schema: 'bvn/hud@1',
  elements: el,
  /** 帧集目录（帧 PNG 1..frames；putFrames 已登记 dir 键） */
  hp: {
    /** hpbarmc 原点（XFL mc_040 静止帧） */
    origin: [400, 45.6],
    /** 血条槽：P1/P2 在 hpbarmc 局部位移（P2 a=-1 镜像）；槽 271×23 */
    bar: { p1: [-299.65, -14.5], p2: [298.25, -14.5], size: [271, 23], decoPos: [1.5, 1] },
    /** 填充条：内容 x[-260,0] 锚点右端，scaleX = hp/hpMax；redbar 同位（延迟残影） */
    fillPos: [263.95, 4.35],
    fillSize: [260, 15],
    /** 头像框（picture_090 102×64）；头像 = ui.faces[id+'_m'] 同尺寸叠上 */
    face: { p1: [-400, -40], p2: [400, -40], size: [102, 64] },
    /** 能量条（mc_032）：bg 在 mc_031@(-70,5) 内 (-70,-5) → mc_032 局部 (-140,0)；填充锚右 */
    energy: {
      p1: [-25.05, 9.2],
      p2: [24.45, 9.2],
      bgPos: [-140, 0],
      fillPos: [-9.5, 3.05],
      /** 填充 sprite 画布 124×5，内容 x[-121.5,2.5]，锚点在原 x=121.5（=121.5/124） */
      fillAnchorX: 121.5 / 124,
      labelPos: [-170.95, 5.1],
    },
    /** 胜利星（mc_036）：w1/w2 槽位；in_bleach/in_naruto 帧段 */
    win: { p1: [-92.25, 35.3], p2: [39.75, 35.3], w1: [29.5, -8], w2: [-0.5, -8] },
    /** 时间板（mc_038）：bg 75×54 @(-37.5,-27)；∞ 43×27 @(-43,0) */
    time: { bgPos: [-37.5, -27], infPos: [-43, 0] },
  },
  qi: {
    /** fzqi1/fzqi2 舞台原点（P2 a=-1 镜像） */
    p1Origin: [48, 534.1],
    p2Origin: [749, 534.1],
    /** mc_026 子件静止位（XFL fadin 终帧） */
    readyPos: [18.1, -2.9],
    facePos: [-10.55, 5],
    fzbarPos: [-15, 1.5],
    fzFillPos: [0.2, 0.8],
    fzTopPos: [1, 1],
    fzDotPos: [0, 0],
    fzSize: [66, 47],
    fzFillSize: [64, 45],
    /** barmc(mc_022)：槽体 shape_001（底板+黑槽合成体 159×19，画布原点 = mc_022 局部
     *  (9.9,0.85)）；分段 139×12；ghost/段字 */
    barPos: [35.95, 24.45],
    slotPos: [9.9, 0.85],
    /** 顶层装饰框 picture_063（mc_022 最上层，XFL matrix ty=-0.45） */
    framePos: [0, -0.45],
    segPos: [9.7, 5.65],
    segSize: [139, 12],
    ghostPos: [82.4, -3.2],
    ghostAnchorX: 2.5 / 8,
    txtPos: [161.3, 11.25],
  },
  hits: {
    p1: [62.15, 121.95],
    p2: [662.15, 121.95],
    ctOffset: [-23.5, 1],
    labelPos: [65.05, 3],
    labelInner: [-28.5, 0],
    digitWidth: 35,
    /** MCNumber.show：xoffset = -width+45（数字右缘锚） */
    digitRightX: 45,
  },
  /** 胜利星帧段（sprite 157；XFL 标签 in_bleach@9/in_naruto@29，0 基 → PNG 10/30 起） */
  winAnim: { frames: 40, bleach: [10, 29], naruto: [30, 40], fps: 30 },
  /** READY 闪字：20 帧 @30fps 循环（f1-13 显 / f14-19 空） */
  readyAnim: { frames: 20, fps: 30 },
  /** 开局字样（startKOmc start+fight 段）：79 帧 @30fps（core 冻结期 30Hz 步进，
   * 78 步走完 → 156 sim ticks）；canvasOrigin = PNG(0,0) 在 mc_043 局部坐标；
   * pos = ui_fight 舞台摆放点（startKOmc@(0,0) + showStart y=-50 + 原点换算）；
   * num = Round 数字合成帧（nummc 收编修正）：pos = 数字画布相对 startKO 摆放点
   * 的偏移，帧窗口 [from,to]（资产帧号），frames = 每数字帧数，digits = 数字数
   * （1..digits 按 min(round,5) 选组）；centerDelta / num.centerDeltas = per-round
   * 居中偏移（修复批次 62：center 钉扎下 PNG 原点 x = pos + delta，delta 使
   * Round 词+数字组合 bbox 中心对齐 800 舞台中线；per-round = 数字宽度自适应，
   * num.absent 时退词-only delta）；frameDeltas = 逐帧居中 delta（资产帧 1 基
   * 下标 0 起；数字窗口 18..45 内为词 delta 占位——数字位图运行时合成，运行时
   * 按回合以 num.centerDeltas 覆盖；46..79 Fight! 段逐帧实测） */
  startKO: {
    frames: 79,
    fps: 30,
    canvasOrigin: [13, 103],
    pos: [13, 53],
    centerDelta: startKOWordDelta,
    ...(startKOFrameDeltas ? { frameDeltas: startKOFrameDeltas } : {}),
    ...(startKONumSpec ? { num: startKONumSpec } : {}),
  },
  /** 结算字样（回合结算流程收编）：ko = startKOmc KO 段（XFL 144..190，47 帧
   *  @30fps，末帧空黑），pos = ui_fight 摆放点（playKO2 y=0 + PNG 画布原点）；
   *  winner = 嵌套 winnermc（sprite 221）独立时间轴，frames = 56（帧脚本
   *  frame29 非 perfect 定格 / frame56 perfect 定格），perfectFrom = Perfect
   *  段起始资产帧号，posP1/posP2 = 原点 ui_fight 摆位（$winnerX 30|546 按胜方
   *  侧、$winnerY 90 + showWinner startKOmc.y=30）。 */
  endKO: {
    ko: { frames: 47, fps: 30, pos: [13, 103] },
    winner: { frames: 56, perfectFrom: 30, posP1: [30, 120], posP2: [546, 120] },
  },
};

mkdirSync(dirname(OUT_BAKED), { recursive: true });
writeFileSync(OUT_BAKED, JSON.stringify(doc));
console.log(
  `hud-pack: ${Object.keys(el).length} 元素 → ${OUT_ASSETS} + ${OUT_BAKED}`,
);
