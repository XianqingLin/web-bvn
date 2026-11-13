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
 *     hits1@(62.15,121.95)、hits2@(662.15,121.95)、startKOmc@(0,0 未收编)；
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
// 头像框底 shape 150 = picture_090 (102×64)
await putShape('face-bg', 150, 102, 64);
// 能量条：槽底 shape 119 = picture_061 (140×10)；填充 sprite 117 (2帧 flash)；标签 sprite 132 (2帧 comicType)
await putShape('energy-bg', 119, 140, 10);
await putFrames('energy-fill', spriteDir(117, '能量填充'), 2, 2);
await putFrames('energy-label', spriteDir(132, '能量标签'), 2, 2);
// 气条：槽体 shape 57 = shape_001（底板+黑槽合成体 159×19）；分段 60/68 (139×12) +
// 71 (140×12) + 74 帧1 (140×12 满气)；ghost 65 (2帧)；段字图标 84 (4帧)
await putShape('qi-slot', 57, 159, 19);
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
};

mkdirSync(dirname(OUT_BAKED), { recursive: true });
writeFileSync(OUT_BAKED, JSON.stringify(doc));
console.log(
  `hud-pack: ${Object.keys(el).length} 元素 → ${OUT_ASSETS} + ${OUT_BAKED}`,
);
