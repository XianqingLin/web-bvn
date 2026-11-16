import { defineConfig } from 'vite';

/**
 * 嵌入构建（平台 /g/bvn/ 用）：root = 本包（index.html 为入口），base = './'
 * （游戏页面从 /g/bvn/index.html 相对定位 bundle 与 packages/data 资源）。
 * dev 预览仍用 vite.config.ts（root = 仓库根）。
 */
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
