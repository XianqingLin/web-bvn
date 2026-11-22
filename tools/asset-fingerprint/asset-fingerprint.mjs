#!/usr/bin/env node
/**
 * asset-fingerprint —— 资产内容指纹清单（2026-11-22 第③项：非哈希资产内容寻址）。
 *
 * 动机：assets/baked 下的文件名不含内容指纹（naruto.sheet-40.webp / bisha.json），
 * 服务端只敢给 max-age=86400——内容没变也要每天全量重拉。指纹化后 URL 变为
 * `<原路径>?v=<8 位内容哈希>`：内容变 → URL 变（缓存自动失效），URL 不变 → 内容
 * 永不变 → 服务端可下发 immutable（gamedock game-assets 侧按 ?v= 识别）。
 *
 * 为什么用查询参数而不是改文件名：文件与 R2 对象零改名零迁移，旧客户端（不带
 * ?v= 的 URL）完全兼容，sync-games 差分上传逻辑不变；缓存语义等价（URL 唯一性
 * 即缓存键唯一性）。
 *
 * 清单范围：packages/data/assets/**（webp/mp3/json）+ packages/data/baked/**
 * （JSON）。清单本身（asset-versions.json）排除，其新鲜度由 vite define 注入的
 * __ASSET_BUILD_ID__（= 清单内容哈希）承担——每次资产变动 → 清单变 → buildId 变
 * → 清单 URL 变 → 永远拉到新清单，清单自身也可 immutable 缓存。
 *
 * 运行期接线：app/src/asset-versioning.ts 拦截 fetch 与 pixi Assets.load，对
 * /packages/data/ 下 URL 追加 ?v=<哈希>（清单未就绪先等待，绝不裸拉）。
 *
 * 幂等：内容不变 → 清单字节不变 → buildId 不变。生成物不入库（assets 树本身
 * gitignore，清单随资产再生；.gitignore 已加）。
 *
 * 用法：node tools/asset-fingerprint.mjs [--quiet]
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';

const QUIET = process.argv.includes('--quiet');
const ROOT = resolve(import.meta.dirname, '../..');
const PACKAGES = join(ROOT, 'packages', 'data');
const MAP_PATH = join(PACKAGES, 'baked', 'asset-versions.json');
const SELF_NAME = 'asset-versions.json';

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(join(dir, e.name), out);
    else out.push(join(dir, e.name));
  }
  return out;
}

const files = [
  ...walk(join(PACKAGES, 'assets')),
  ...walk(join(PACKAGES, 'baked')),
].filter((p) => !p.endsWith(SELF_NAME));

const map = {};
for (const f of files) {
  // 键 = assets/... 或 baked/...（data 树内相对路径，'/' 分隔）
  const rel = f.slice(PACKAGES.length + 1).split(sep).join('/');
  const h = createHash('sha1').update(readFileSync(f)).digest('hex').slice(0, 8);
  map[rel] = h;
}

const body = JSON.stringify(map);
const buildId = createHash('sha1').update(body).digest('hex').slice(0, 8);
writeFileSync(MAP_PATH, body);

if (!QUIET) {
  const totalMB = files.reduce((s, f) => s + statSync(f).size, 0) / 1024 / 1024;
  console.log(
    `asset-fingerprint: ${files.length} 文件 (${totalMB.toFixed(0)}MB) → 清单 ${(body.length / 1024).toFixed(0)}KB，buildId=${buildId}`,
  );
}
