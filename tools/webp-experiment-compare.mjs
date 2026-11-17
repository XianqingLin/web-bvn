#!/usr/bin/env node
/**
 * 生成 WebP 目检对比页：挑 PSNR 最低的几张 sheet，自动定位内容密集区，
 * 裁 600×600 放大 2×（nearest），并排 PNG | q75 | q85，写 tools/_scratch/webp-experiment/index.html。
 * 用法：node tools/webp-experiment-compare.mjs [fighterId]（默认 ichigo，需先跑过主实验脚本）
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const EXP = path.join(ROOT, 'tools', '_scratch', 'webp-experiment');
const fighterId = process.argv[2] ?? 'ichigo';

const dir = path.join(ROOT, 'packages', 'data', 'assets', 'fighters');
const sheets = (await readdir(dir)).filter((f) => f.startsWith(`${fighterId}.sheet-`) && f.endsWith('.png')).sort();
const pick = ['ichigo.sheet-22.png', 'ichigo.sheet-13.png', 'ichigo.sheet-18.png', 'ichigo.sheet-21.png']
  .filter((n) => sheets.includes(n));
const SIZES = [75, 85];

await mkdir(path.join(EXP, 'crops'), { recursive: true });

/** 找内容密集区：把 alpha 降采样统计到 16×16 网格，取最重的格子中心 */
async function cropCenter(src) {
  const { data, info } = await sharp(src).resize(16, 16, { fit: 'fill' }).extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  let best = 0;
  let bx = 8;
  let by = 8;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const w = data[y * 16 + x];
      if (w > best) {
        best = w;
        bx = x;
        by = y;
      }
    }
  }
  const cw = info.width / 16;
  const ch = info.height / 16;
  const cx = Math.round((bx + 0.5) * cw);
  const cy = Math.round((by + 0.5) * ch);
  return {
    left: Math.max(0, Math.min(2048 - 600, cx - 300)),
    top: Math.max(0, Math.min(2048 - 600, cy - 300)),
    width: 600,
    height: 600,
  };
}

const blocks = [];
for (const name of pick) {
  const stem = name.replace(/\.png$/, '');
  const src = path.join(dir, name);
  const region = await cropCenter(src);
  const tags = ['png'];
  await sharp(src).extract(region).resize(1200, 1200, { kernel: 'nearest' }).png().toFile(path.join(EXP, 'crops', `${stem}-png.png`));
  for (const q of SIZES) {
    const webp = path.join(EXP, fighterId, `q${q}`, `${stem}.webp`);
    await sharp(webp).extract(region).resize(1200, 1200, { kernel: 'nearest' }).png().toFile(path.join(EXP, 'crops', `${stem}-q${q}.png`));
    tags.push(`q${q}`);
  }
  const row = tags.map((t) =>
    `<figure><img src="crops/${stem}-${t}.png"><figcaption>${t}</figcaption></figure>`,
  ).join('\n');
  blocks.push(`<h2>${name}（放大 2×）</h2><div class="row">${row}</div>`);
}

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${fighterId} WebP 目检</title>
<style>
  body { background: #1a1a2e; color: #eee; font-family: monospace; margin: 24px; }
  h1, h2 { font-weight: normal; }
  .row { display: flex; gap: 16px; flex-wrap: wrap; }
  figure { margin: 0; }
  img { width: 480px; height: 480px; image-rendering: pixelated; outline: 1px solid #444; }
  figcaption { color: #aaa; padding: 4px 0; }
</style></head><body>
<h1>${fighterId} WebP 对比（左起：原 PNG | q75（26.7%体积） | q85（32.5%体积））</h1>
${blocks.join('\n')}
</body></html>`;

await writeFile(path.join(EXP, 'index.html'), html, 'utf8');
console.log(`已生成: ${path.join(EXP, 'index.html')}`);
console.log('用浏览器打开即可目检（深色底，模拟游戏背景）');
