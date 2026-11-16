#!/usr/bin/env node
/**
 * dist 后处理（vite build 之后跑）：
 *   - 拷贝 packages/data/baked（~14MB JSON）进 dist/packages/data/baked；
 *   - dist/packages/data/assets 建立指向真实资源目录（~848MB，不入库）的
 *     Windows junction / 符号链接——平台按 /g/bvn/packages/data/assets/… 静态
 *     供给游戏资源，无需拷贝。非 Windows 且无法建链时退化为整目录拷贝。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoDir = path.resolve(appDir, '../..');
const dist = path.join(appDir, 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('prepare-dist：先跑 vite build 再执行本脚本');
  process.exit(1);
}

const dataDist = path.join(dist, 'packages', 'data');
fs.mkdirSync(dataDist, { recursive: true });

fs.cpSync(path.join(repoDir, 'packages/data/baked'), path.join(dataDist, 'baked'), { recursive: true });
console.log('prepare-dist: baked 已拷贝 → dist/packages/data/baked');

const assetsSrc = path.join(repoDir, 'packages/data/assets');
const assetsLink = path.join(dataDist, 'assets');
fs.rmSync(assetsLink, { force: true, recursive: true });
if (process.platform === 'win32') {
  fs.symlinkSync(assetsSrc, assetsLink, 'junction');
} else {
  try {
    fs.symlinkSync(path.relative(dataDist, assetsSrc), assetsLink, 'dir');
  } catch {
    fs.cpSync(assetsSrc, assetsLink, { recursive: true });
    console.warn('prepare-dist: 无法建立符号链接，assets 已整目录拷贝（较慢）');
  }
}
console.log('prepare-dist: assets 已挂载 →', assetsLink);
