import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// dev 预览：root = 仓库根 —— /packages/data/{baked,assets} 下的 JSON/PNG
// 直接以静态文件形式可 fetch（仅 dev 用途；正式 app 资源管线在切片 5 定型）。
export default defineConfig({
  root: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  server: {
    port: 5173,
    open: '/packages/app/preview.html',
    fs: { allow: [resolve(dirname(fileURLToPath(import.meta.url)), '../..')] },
  },
});
