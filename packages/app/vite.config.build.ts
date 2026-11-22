import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// 与 vite.config.ts 同源：资产指纹清单的构建 ID（vite.config.build 里 root 不同，
// 单独再算一次；清单由 tools/asset-fingerprint 生成，build:dist 前置生成）。
let assetBuildId = 'nobuildid';
const mapPath = join(ROOT, 'packages/data/baked/asset-versions.json');
if (existsSync(mapPath)) {
  assetBuildId = createHash('sha1').update(readFileSync(mapPath)).digest('hex').slice(0, 8);
}

/**
 * 嵌入构建（平台 /g/bvn/ 用）：root = 本包（index.html 为入口），base = './'
 * （游戏页面从 /g/bvn/index.html 相对定位 bundle 与 packages/data 资源）。
 * dev 预览仍用 vite.config.ts（root = 仓库根）。
 */
export default defineConfig({
  base: './',
  define: {
    __ASSET_BUILD_ID__: JSON.stringify(assetBuildId),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
