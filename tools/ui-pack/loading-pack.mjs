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
 *       【偏离登记】不逐帧烘焙：只取帧 1 基准位，运行时绕画布中心连续旋转。
 *       依据：30 帧@30fps = 每秒一圈；帧 1→2 旋转相关性实测 +12°/帧（顺时针，
 *       30×12° 恰满 360°）——连续 transform 与帧循环逐 tick 等价且更平滑。
 *     - "加载中"美术字 shape 54 = 66×18（bounds 19.05..85.05, 0..18）
 *       → 组合：spinner 画布左上落 bar 空间 (1.95,-22.95)，美术字落 (24,-21.45)
 *     - txt（DefineEditText 60）@(352.1,18.3)：右对齐 14px 青色 RGB(0,218,248)，
 *       字段右缘 = bar 空间 x 761.95（352.1 + 409.85）
 *
 *   loading_cover_mc(sprite 65)（GameLoadingStage"绊"初始化封面）= cover_bgimg(bitmap 64)
 *       @(0,0)（804×604，取左上 800×600 舞台区）+ bar（同款 loadingbar_mc 61）@(18,526.4)
 *       —— bar 部件复用 loading.json bar 段，运行时重建（bar 内 fill 动态，不烘死）；
 *   seltwzmc(sprite 9) 4 帧 = 加载页选人面板角标（SelectedFighterUI.setFighterIndex/
 *       setAssister）：帧 1..3 = 1st/2nd/3rd 位次，帧 4 = assist；画布 77×48（union）。
 *
 * 产出：assets/ui/loading/（bg.webp + cover.webp + track/fill/label/spin.png + seltwz/<n>.png）、
 *       baked/loading.json（schema bvn/loading@3）。
 *
 * 用法：node tools/ui-pack/loading-pack.mjs [--ffdec PATH] [--out-assets DIR] [--out-baked FILE]
 *   （本工具按 pack 管线约定只产 PNG（bg/cover 例外：sharp 直出 webp）；产完必须跑
 *     `pnpm assets:webp` 统一转 WebP 并把 baked 清单 .png 改写 .webp，运行时按 .webp 加载）
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
  /** spinner：帧 1 基准位 + 运行时连续旋转；30 帧@30fps = 每秒一圈（帧序顺时针 +12°/帧） */
  spin: { pos: [1.95, -22.95], size: [20, 20], center: [10, 10], frames: 30, fps: 30 },
  label: { pos: [24, -21.45], size: [66, 18] },
  /** 动态消息文本：右缘锚点（字段 x -2..409.85 + 摆放位 352.1） */
  txt: { rightEdge: 761.95, centerY: 28.7, size: 14, color: '#00daf8' },
};
// GameLoadingStage"绊"封面：cover_bgimg(bitmap 64) 804×604 @(0,0)，取左上舞台区；
// bar（同款 loadingbar_mc）在封面里的摆放位（sltui→bar 矩阵 360,10528 twips）。
const COVER = { stageOriginInExport: [0, 0], size: [800, 600], barPos: [18, 526.4] };
// seltwzmc(sprite 9) 角标：帧 1..3 位次 / 帧 4 assist（SelectedFighterUI.setFighterIndex /
// setAssister；FFDec 导出画布 = 全 4 帧 union bounds 77×48）。
const SELTWZ = { frames: 4, canvas: [77, 48] };

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
run(FFDEC, ['-export', 'image', join(SCRATCH, 'images'), join(SCRATCH, 'loading.swf')]);

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

// spinner：sprite 57 只烘帧 1（基准位；旋转语义收进 baked 的 turnsPerSec，
// 运行时连续 transform——见头部偏离登记。帧数守卫保留：源 sprite 变了必须炸出来）
{
  const src = spriteDir(57, 'spinner');
  const frames = readdirSync(src).filter((f) => f.endsWith('.png'));
  if (frames.length !== BAR.spin.frames) {
    throw new Error(`spinner 帧数变化：${frames.length} ≠ ${BAR.spin.frames}（规格须同步更新）`);
  }
  copyFileSync(join(src, '1.png'), join(OUT_ASSETS, 'spin.png'));
}

// 封面：bitmap 64 导出 804×604 → 裁左上 800×600 舞台区
{
  const png = join(SCRATCH, 'images', '64_cover_bgimg.png');
  if (!existsSync(png)) throw new Error(`loading.swf 未找到位图 64（cover_bgimg）：${png}`);
  const meta = await sharp(png).metadata();
  if (meta.width !== 804 || meta.height !== 604) {
    throw new Error(`cover_bgimg 导出画布变化：${meta.width}×${meta.height} ≠ 804×604（规格须同步更新）`);
  }
  await sharp(png)
    .extract({ left: COVER.stageOriginInExport[0], top: COVER.stageOriginInExport[1], width: COVER.size[0], height: COVER.size[1] })
    .webp({ quality: 80 })
    .toFile(join(OUT_ASSETS, 'cover.webp'));
}

// 角标：sprite 9 全帧（union 画布 77×48，帧 1..3 位次 / 帧 4 assist）
{
  const dir = join(OUT_ASSETS, 'seltwz');
  mkdirSync(dir, { recursive: true });
  const src = spriteDir(9, 'seltwzmc');
  const frames = readdirSync(src).filter((f) => f.endsWith('.png'));
  if (frames.length !== SELTWZ.frames) {
    throw new Error(`seltwzmc 帧数变化：${frames.length} ≠ ${SELTWZ.frames}（规格须同步更新）`);
  }
  for (let i = 1; i <= SELTWZ.frames; i++) {
    const meta = await sharp(join(src, `${i}.png`)).metadata();
    if (meta.width !== SELTWZ.canvas[0] || meta.height !== SELTWZ.canvas[1]) {
      throw new Error(`seltwzmc 帧 ${i} 画布变化：${meta.width}×${meta.height} ≠ ${SELTWZ.canvas.join('×')}（规格须同步更新）`);
    }
    copyFileSync(join(src, `${i}.png`), join(dir, `${i}.png`));
  }
}

// ---------- 3. baked/loading.json ----------
const rel = (n) => `ui/loading/${n}`;
writeFileSync(OUT_BAKED, JSON.stringify({
  schema: 'bvn/loading@3',
  bg: { url: rel('bg.webp'), size: BG.size },
  /** GameLoadingStage"绊"初始化封面（bar 部件复用下方 bar 段，运行时重建） */
  cover: { url: rel('cover.webp'), size: COVER.size, barPos: COVER.barPos },
  /** 加载页选人面板角标 seltwzmc：帧 1..3 = 位次、帧 4 = assist */
  seltwz: { dir: rel('seltwz'), frames: SELTWZ.frames },
  bar: {
    pos: BAR.pos,
    track: { url: rel('track.png'), pos: BAR.track.pos, size: BAR.track.size },
    fill: { url: rel('fill.png'), pos: BAR.fill.pos, size: BAR.fill.size },
    spin: { url: rel('spin.png'), pos: BAR.spin.pos, size: BAR.spin.size, center: BAR.spin.center, turnsPerSec: BAR.spin.frames / BAR.spin.fps },
    label: { url: rel('label.png'), pos: BAR.label.pos, size: BAR.label.size },
    txt: BAR.txt,
  },
}, null, 2) + '\n');
console.log(`loading-pack 完成 → ${OUT_ASSETS} + ${OUT_BAKED}`);
