#!/usr/bin/env node
/**
 * loading-pack：进战斗加载画面资产管线（切片 31，§4.3 块 9）。
 *
 * 来源 loading.swf（内嵌于 FighterTester.swf binaryData，与 ui-pack winner 同源提取）。
 * 原版语义（LoadingStage.as）：加载画面 = ResUtils.fight 的 loading_fight_mc（背景 +
 * sltui[bar[进度条]]），进度 = bar.bar.scaleX，消息 = bar.txt（右对齐动态文本）。
 *
 * 结构（FFDec XML 导出实证，坐标 twips→px /20）：
 *   loading_fight_mc(sprite 63) = bg(sprite 47)@(0,0) + sltui(sprite 62)@(0,0)
 *   bg(sprite 47) = sprite 43 ×1.75 @(-316,-208) + VS 纹章(shape 46) —— 导出画布 1400×1050，
 *       舞台 (0,0) 位于画布 (316,208)，裁 800×600 即原版舞台视野；
 *   sltui = bar(sprite 61, loadingbar_mc)@(17,555.1)：
 *     - 槽 shape 49 = 764×15（位图填充 bitmap 48）
 *     - 填充 bar(sprite 52)@(2,5)：shape 51 = 760×5（锚点左端，scaleX 从左往右缩）
 *     - 转圈 spinner(sprite 57) 30 帧（shape 56 = 14×14 方框旋转，导出画布 20×20，
 *       画布 (10,10) = 旋转中心）叠 label 组内 @(7,8.5)
 *     - "加载中"美术字 shape 54 = 66×18（bounds 19.05..85.05, 0..18）
 *       → 组合：spinner 画布左上落 bar 空间 (1.95,-22.95)，美术字落 (24,-21.45)
 *     - txt（DefineEditText 60）@(352.1,18.3)：右对齐 14px 青色 RGB(0,218,248)，
 *       字段右缘 = bar 空间 x 761.95（352.1 + 409.85）
 *
 * 产出：assets/ui/loading/（bg.webp + track/fill/label.png + spin/<n>.png）
 *       baked/loading.json（schema bvn/loading@1）。
 *
 * 用法：node tools/ui-pack/loading-pack.mjs [--ffdec PATH] [--out-assets DIR] [--out-baked FILE]
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
const OUT_ASSETS = resolve(opt('out-assets', 'packages/data/assets/ui/loading'));
const OUT_BAKED = resolve(opt('out-baked', 'packages/data/baked/loading.json'));
const SCRATCH = resolve(import.meta.dirname, '_scratch/loading-pack');

// ---------- 布局常量（FFDec XML 实证；改规格先改这里再跑工具核对） ----------
const BG = { stageOriginInExport: [316, 208], size: [800, 600] };
const BAR = {
  /** bar 容器在原版舞台的摆放位（sltui→bar 矩阵 340,11102 twips） */
  pos: [17, 555.1],
  track: { pos: [0, 0], size: [764, 15] },
  fill: { pos: [2, 5], size: [760, 5] },
  /** spinner 30 帧循环 @30fps；PNG 原点 = 旋转中心 (10,10) 反推落位 */
  spin: { pos: [1.95, -22.95], size: [20, 20], center: [10, 10], frames: 30, fps: 30 },
  label: { pos: [24, -21.45], size: [66, 18] },
  /** 动态消息文本：右缘锚点（字段 x -2..409.85 + 摆放位 352.1） */
  txt: { rightEdge: 761.95, centerY: 28.7, size: 14, color: '#00daf8' },
};

function run(cmd, args_) {
  console.log(`$ ${cmd} ${args_.join(' ')}`);
  execFileSync(cmd, args_, { stdio: ['ignore', 'pipe', 'inherit'] });
}

// ---------- 1. 提取 loading.swf 并导出 ----------
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
if (!existsSync(FFDEC)) throw new Error(`FFDec CLI 不存在：${FFDEC}`);
run(FFDEC, ['-export', 'binaryData', join(SCRATCH, 'src'), FIGHTER_TESTER_SWF]);
{
  const bin = readdirSync(join(SCRATCH, 'src')).find((f) => f.includes('loading_swf') && f.endsWith('.bin'));
  if (!bin) throw new Error('FighterTester.swf 未找到内嵌 loading.swf binaryData');
  copyFileSync(join(SCRATCH, 'src', bin), join(SCRATCH, 'loading.swf'));
}
run(FFDEC, ['-export', 'sprite', join(SCRATCH, 'sprites'), join(SCRATCH, 'loading.swf')]);
run(FFDEC, ['-export', 'shape', join(SCRATCH, 'shapes'), join(SCRATCH, 'loading.swf')]);

const spriteDir = (id, what) => {
  const d = readdirSync(join(SCRATCH, 'sprites')).find(
    (x) => x === `DefineSprite_${id}` || x.startsWith(`DefineSprite_${id}_`),
  );
  if (!d) throw new Error(`loading.swf 未找到 sprite ${id}（${what}）`);
  return join(SCRATCH, 'sprites', d);
};

/** shape SVG 光栅化（FFDec shape 导出路径；直出位图 JPEG3 alpha 损坏，同 hud-pack 结论）。 */
async function shapePng(id, expectW, expectH) {
  const svg = join(SCRATCH, 'shapes', `${id}.svg`);
  if (!existsSync(svg)) throw new Error(`loading.swf 未找到 shape ${id}`);
  return sharp(svg, { density: 72 }).resize(expectW, expectH).png().toBuffer();
}

// ---------- 2. 产出 assets/ui/loading/ ----------
rmSync(OUT_ASSETS, { recursive: true, force: true });
mkdirSync(OUT_ASSETS, { recursive: true });

// bg：sprite 47 导出 1400×1050 → 裁舞台 800×600（无 bar 元件，动态件运行时重建）
{
  const png = join(spriteDir(47, 'bg'), '1.png');
  const meta = await sharp(png).metadata();
  if (meta.width !== 1400 || meta.height !== 1050) {
    throw new Error(`sprite 47 导出画布变化：${meta.width}×${meta.height} ≠ 1400×1050（规格须同步更新）`);
  }
  await sharp(png)
    .extract({ left: BG.stageOriginInExport[0], top: BG.stageOriginInExport[1], width: BG.size[0], height: BG.size[1] })
    .webp({ quality: 80 })
    .toFile(join(OUT_ASSETS, 'bg.webp'));
}

// 进度条槽 / 填充 / 美术字（shape 光栅化，尺寸由 XML bounds 锁定）
writeFileSync(join(OUT_ASSETS, 'track.png'), await shapePng(49, BAR.track.size[0], BAR.track.size[1]));
writeFileSync(join(OUT_ASSETS, 'fill.png'), await shapePng(51, BAR.fill.size[0], BAR.fill.size[1]));
writeFileSync(join(OUT_ASSETS, 'label.png'), await shapePng(54, BAR.label.size[0], BAR.label.size[1]));

// spinner：sprite 57 全帧（旋转循环；帧画布恒 20×20 = 全周期 union bounds）
{
  const dir = join(OUT_ASSETS, 'spin');
  mkdirSync(dir, { recursive: true });
  const src = spriteDir(57, 'spinner');
  const frames = readdirSync(src).filter((f) => f.endsWith('.png'));
  if (frames.length !== BAR.spin.frames) {
    throw new Error(`spinner 帧数变化：${frames.length} ≠ ${BAR.spin.frames}（规格须同步更新）`);
  }
  for (let i = 1; i <= BAR.spin.frames; i++) {
    copyFileSync(join(src, `${i}.png`), join(dir, `${i}.png`));
  }
}

// ---------- 3. baked/loading.json ----------
const rel = (n) => `ui/loading/${n}`;
writeFileSync(OUT_BAKED, JSON.stringify({
  schema: 'bvn/loading@1',
  bg: { url: rel('bg.webp'), size: BG.size },
  bar: {
    pos: BAR.pos,
    track: { url: rel('track.png'), pos: BAR.track.pos, size: BAR.track.size },
    fill: { url: rel('fill.png'), pos: BAR.fill.pos, size: BAR.fill.size },
    spin: { dir: rel('spin'), pos: BAR.spin.pos, size: BAR.spin.size, center: BAR.spin.center, frames: BAR.spin.frames, fps: BAR.spin.fps },
    label: { url: rel('label.png'), pos: BAR.label.pos, size: BAR.label.size },
    txt: BAR.txt,
  },
}, null, 2) + '\n');
console.log(`loading-pack 完成 → ${OUT_ASSETS} + ${OUT_BAKED}`);
