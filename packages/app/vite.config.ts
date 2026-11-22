import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// 资产指纹清单的构建 ID（= 清单内容哈希；清单由 tools/asset-fingerprint 生成，
// predev / build:dist 前置生成）。缺失（未生成）时用占位——运行期拦截器仍工作，
// 仅清单 URL 无版本参数，回退无指纹行为。
let assetBuildId = 'nobuildid';
const mapPath = join(ROOT, 'packages/data/baked/asset-versions.json');
if (existsSync(mapPath)) {
  assetBuildId = createHash('sha1').update(readFileSync(mapPath)).digest('hex').slice(0, 8);
}

// dev 预览：root = 仓库根 —— /packages/data/{baked,assets} 下的 JSON/PNG
// 直接以静态文件形式可 fetch（仅 dev 用途；正式 app 资源管线在切片 5 定型）。
export default defineConfig({
  root: ROOT,
  define: {
    __ASSET_BUILD_ID__: JSON.stringify(assetBuildId),
  },
  server: {
    port: 5173,
    open: '/packages/app/preview.html',
    fs: { allow: [ROOT] },
  },
  // root=仓库根会让 dep scanner 扫全仓库 *.html（含 tools/_scratch 下的 Edge profile 垃圾），
  // 显式钉死扫描入口，只扫真正的预览页。
  optimizeDeps: {
    entries: ['packages/app/preview.html'],
  },
});
