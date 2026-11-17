#!/usr/bin/env node
/**
 * WebP 转换实验：把某个角色的 sprite sheet（无损 PNG）转成有损 WebP，
 * 量化体积收益与像素差异（PSNR），产物写入 tools/_scratch/（gitignore，可再生）。
 *
 * 用法：node tools/webp-experiment.mjs [fighterId] [quality...]
 *   默认 ichigo，quality 75/85 两组对比。
 *
 * 产物：tools/_scratch/webp-experiment/<id>/q<q>/<name>.webp
 * 指标：PNG 总量 vs WebP 总量；逐张 PSNR（RGBA 全通道，回归解码对比）。
 */
import { mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ASSETS = path.join(ROOT, 'packages', 'data', 'assets', 'fighters');
const OUT_ROOT = path.join(ROOT, 'tools', '_scratch', 'webp-experiment');

const fighterId = process.argv[2] ?? 'ichigo';
const qualities = (process.argv[3] ? process.argv.slice(3) : ['75', '85']).map(Number);

const dir = ASSETS;
if (!existsSync(dir)) {
  console.error(`资源目录不存在: ${dir}`);
  process.exit(1);
}
// sheet 平铺在 fighters/ 下：{id}.sheet-N.png
const sheets = (await readdir(dir)).filter((f) => f.startsWith(`${fighterId}.sheet-`) && f.endsWith('.png')).sort();
if (sheets.length === 0) {
  console.error(`目录内没有 PNG: ${dir}`);
  process.exit(1);
}
console.log(`${fighterId}: ${sheets.length} 张 sheet\n`);

/** PSNR：压平到黑底后的合成 RGB（肉眼感知指标，半透明边缘的预乘量化误差
 *  在合成时被 alpha 压回，不虚高）+ alpha 通道（WebP 有损模式 alpha 默认无损）。 */
const psnrComposite = (a, b) => {
  let rgbSum = 0;
  let aSum = 0;
  for (let i = 0; i < a.length; i += 4) {
    const aa = a[i + 3] / 255;
    const ba = b[i + 3] / 255;
    for (let c = 0; c < 3; c++) {
      const d = a[i + c] * aa - b[i + c] * ba;
      rgbSum += d * d;
    }
    const da = a[i + 3] - b[i + 3];
    aSum += da * da;
  }
  const n = a.length / 4;
  const rgbMse = rgbSum / (n * 3);
  const aMse = aSum / n;
  const rgbPsnr = rgbMse === 0 ? Infinity : 10 * Math.log10(255 * 255 / rgbMse);
  const aPsnr = aMse === 0 ? Infinity : 10 * Math.log10(255 * 255 / aMse);
  return `${rgbPsnr.toFixed(1)}/${aPsnr.toFixed(1)}dB`;
};

for (const q of qualities) {
  const outDir = path.join(OUT_ROOT, fighterId, `q${q}`);
  await mkdir(outDir, { recursive: true });
  let pngTotal = 0;
  let webpTotal = 0;
  const psnrs = [];
  const rows = [];
  for (const name of sheets) {
    const src = path.join(dir, name);
    const dst = path.join(outDir, name.replace(/\.png$/, '.webp'));
    await sharp(src).webp({ quality: q, effort: 5, smartSubsample: true }).toFile(dst);
    const pngSize = (await stat(src)).size;
    const webpSize = (await stat(dst)).size;
    pngTotal += pngSize;
    webpTotal += webpSize;
    // 回归解码对比（RGBA；PSNR = 可见区 RGB / 全图 alpha）
    const a = await sharp(src).raw().toBuffer();
    const b = await sharp(dst).raw().toBuffer();
    const p = psnrComposite(a, b);
    psnrs.push(p);
    rows.push(`${name}  ${(pngSize / 1048576).toFixed(2)}MB → ${(webpSize / 1048576).toFixed(2)}MB  PSNR(合成/A) ${p}`);
  }
  console.log(`—— quality ${q} ——`);
  console.log(rows.join('\n'));
  const rgbAvg = psnrs.reduce((s, p) => s + parseFloat(p.split('/')[0]), 0) / psnrs.length;
  console.log(
    `总计 ${(pngTotal / 1048576).toFixed(1)} MB → ${(webpTotal / 1048576).toFixed(1)} MB` +
      `（${((webpTotal / pngTotal) * 100).toFixed(1)}%）  平均可见区 RGB PSNR ${rgbAvg.toFixed(1)} dB\n`,
  );
}
