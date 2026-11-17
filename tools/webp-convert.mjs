#!/usr/bin/env node
/**
 * assets 全量 PNG → WebP（q85）转换。任何 pack 工具（atlas/bisha/hit/ui/sound 等）
 * 重新产出 PNG 后都要重跑本脚本，保证 assets 树只有 WebP。
 *
 * 动作：
 *   1. 递归转换 packages/data/assets 下所有 .png → .webp（q85/effort5/smartSubsample），
 *      转换成功后删除原 PNG；
 *   2. 重写 assets 下所有 JSON（atlas.json 等）内的 .png → .webp 文件名；
 *   3. 重写 baked 下含 .png 文件名的清单 JSON（bisha/hud/loading/ui）。
 *    （代码中硬编码的 .png 扩展名已同步改为 .webp，见 hud.ts/loading.ts/setup.ts）
 *
 * 实验依据（tools/webp-experiment.mjs，ichigo 26 张 sheet）：
 *   q85 = 32.5% 体积，合成 PSNR 40.3dB，alpha 无损。
 *
 * 用法：node tools/webp-convert.mjs [--dry-run]
 */
import { readdir, stat, rename, unlink, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ASSETS = path.join(ROOT, 'packages', 'data', 'assets');
const BAKED = path.join(ROOT, 'packages', 'data', 'baked');
const DRY = process.argv.includes('--dry-run');
const CONCURRENCY = 8;

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

/** 把文本中的 .png 文件名统一改为 .webp */
const swap = (text) => text.replace(/\.png/g, '.webp');

async function convertImage(src) {
  const dst = src.replace(/\.png$/, '.webp');
  if (DRY) return [src, dst, 0, 0];
  await sharp(src).webp({ quality: 85, effort: 5, smartSubsample: true }).toFile(dst);
  const [pngSize, webpSize] = await Promise.all([
    stat(src).then((s) => s.size),
    stat(dst).then((s) => s.size),
  ]);
  await unlink(src);
  return [src, dst, pngSize, webpSize];
}

const files = await walk(ASSETS);
const pngs = files.filter((f) => f.endsWith('.png'));
const jsons = files.filter((f) => f.endsWith('.json'));
console.log(`assets: ${pngs.length} 张 PNG、${jsons.length} 个 JSON${DRY ? '（dry-run）' : ''}`);

// 1. 图片转换（并发池）
let pngTotal = 0;
let webpTotal = 0;
let done = 0;
let idx = 0;
async function worker() {
  while (idx < pngs.length) {
    const [src, , ps, ws] = await convertImage(pngs[idx++]);
    pngTotal += ps;
    webpTotal += ws;
    done++;
    if (done % 200 === 0) console.log(`  ${done}/${pngs.length}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
if (pngTotal > 0) {
  console.log(
    `图片: ${(pngTotal / 1048576).toFixed(1)} MB → ${(webpTotal / 1048576).toFixed(1)} MB` +
      `（${((webpTotal / pngTotal) * 100).toFixed(1)}%）`,
  );
}

// 2. assets JSON 内文件名重写
let jsonHit = 0;
for (const j of jsons) {
  const text = await readFile(j, 'utf8');
  if (!text.includes('.png')) continue;
  jsonHit++;
  if (!DRY) await writeFile(j, swap(text), 'utf8');
}
console.log(`assets JSON 含 .png 引用已重写: ${jsonHit} 个`);

// 3. baked 清单 JSON 重写
const bakedJsons = (await readdir(BAKED)).filter((f) => f.endsWith('.json'));
for (const j of bakedJsons) {
  const p = path.join(BAKED, j);
  const text = await readFile(p, 'utf8');
  if (!text.includes('.png')) continue;
  if (!DRY) await writeFile(p, swap(text), 'utf8');
  console.log(`baked 重写: ${j}`);
}
console.log('完成');
