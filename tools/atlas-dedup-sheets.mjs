#!/usr/bin/env node
/**
 * tools/atlas-dedup-sheets —— 单 sheet 级去重（形态派生角色只重了部分 sheet 的情况）。
 *
 * 背景：atlas-dedup.mjs 只处理「整个 atlas 的 sheet 序列完全相同」（如 ichigo 全形态），
 * 但还有一类是「两个 atlas 只有部分 sheet 相同」（如 kenshin / kenshin_battousai 仅若干
 * sheet 字节相同，其余帧不同）。这类 atlas 整体签名不同，整 atlas 工具无法收，留存的
 * 重复 sheet 在 fighters 仍有 ~13.5MB、ui/hitspark 另有若干。
 *
 * 动作（同目录内、逐 sheet）：
 *   1. 遍历 fighters/、assistants/、fires/** 下所有 *.atlas.json，收集每条 sheets[].file
 *      的物理路径与 MD5（baseUrl = atlas 所在目录，file 为裸文件名）；
 *   2. 按「目录 + MD5」分组；每组取字典序最小文件名为 canonical；
 *   3. 非 canonical 的引用：重写 atlas.json 的 sheets[].file → canonical 文件名
 *      （sheets[] 其余字段 w/h 不动，frames/forms/fires 不动，id 不动）；
 *   4. 删除非 canonical 的物理 sheet（删前逐文件 MD5 复核与 canonical 一致）。
 *
 * 安全边界：只删除「被至少一个 atlas 引用」且「MD5 完全相同」的文件；孤儿文件不碰；
 * 不同目录的 sheet 不互换（baseUrl 不同）。零渲染代码改动——运行时只经 atlas.json 找 sheet。
 *
 * 幂等：重跑时重复 sheet 已不存在、引用已指向 canonical，全组 no-op。
 * 管线位置：与 atlas-dedup.mjs 同级，由 `pnpm assets:finalize` 统一调用（webp → 整atlas → 单sheet）。
 *
 * 用法：node tools/atlas-dedup-sheets.mjs [--dry-run]
 */
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ASSETS = path.join(ROOT, 'packages', 'data', 'assets');
const DIRS = ['fighters', 'assistants', 'fires'];
const DRY = process.argv.includes('--dry-run');

const md5 = (file) => createHash('md5').update(readFileSync(file)).digest('hex');

/** 递归收集目录下所有 *.atlas.json */
function atlasFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) atlasFiles(p, out);
    else if (e.name.endsWith('.atlas.json')) out.push(p);
  }
  return out;
}

let totalSaved = 0;
let totalDeleted = 0;
let totalRewritten = 0;

for (const dirName of DIRS) {
  const root = path.join(ASSETS, dirName);
  const atlases = atlasFiles(root);
  // 引用表：dir → md5 → [{ file, refs: [{atlas, idx}] }]
  const byDirMd5 = new Map();
  for (const atlas of atlases) {
    const json = JSON.parse(readFileSync(atlas, 'utf8'));
    if (!Array.isArray(json.sheets)) continue;
    const dir = path.dirname(atlas);
    json.sheets.forEach((s, idx) => {
      const fp = path.join(dir, s.file);
      if (!statSync(fp).isFile()) throw new Error(`${path.relative(ASSETS, atlas)}: sheet 不存在 ${s.file}`);
      const key = dir + '\0' + md5(fp);
      if (!byDirMd5.has(key)) byDirMd5.set(key, []);
      byDirMd5.get(key).push({ file: s.file, atlas, idx });
    });
  }

  let savedBytes = 0;
  let deletedFiles = 0;
  let rewrittenJson = 0;
  const groups = [...byDirMd5.entries()].filter(([, refs]) => {
    const files = new Set(refs.map((r) => r.file));
    return files.size > 1; // 该 MD5 在同一目录下对应多个物理文件
  });

  for (const [key, refs] of groups) {
    const dir = key.split('\0')[0];
    const files = [...new Set(refs.map((r) => r.file))].sort();
    const canonical = files[0];
    const canonicalMd5 = md5(path.join(dir, canonical));
    console.log(`${dirName}: [${files.join(' == ')}] → ${canonical}`);

    // 重写所有非 canonical 引用
    for (const r of refs) {
      if (r.file === canonical) continue;
      const json = JSON.parse(readFileSync(r.atlas, 'utf8'));
      if (json.sheets[r.idx].file === canonical) continue; // 已重写（幂等）
      json.sheets[r.idx].file = canonical;
      if (!DRY) writeFileSync(r.atlas, JSON.stringify(json));
      rewrittenJson++;
      console.log(`  ${path.basename(r.atlas)}: sheets[${r.idx}].file → ${canonical}`);
    }

    // 删除非 canonical 物理文件（删前 MD5 复核）
    for (const f of files) {
      if (f === canonical) continue;
      const fp = path.join(dir, f);
      try {
        if (md5(fp) !== canonicalMd5) {
          throw new Error(`${dirName}/${f}: 与 canonical 内容不一致，拒绝删除`);
        }
      } catch (e) {
        if (e.code === 'ENOENT') continue; // 已删（幂等）
        throw e;
      }
      const size = statSync(fp).size;
      if (!DRY) unlinkSync(fp);
      savedBytes += size;
      deletedFiles++;
    }
  }

  console.log(
    `${dirName}: ${groups.length} 组部分重复 | 删除 ${deletedFiles} 个 sheet（${(savedBytes / 1048576).toFixed(1)}MB）| 重写 ${rewrittenJson} 处引用`,
  );
  totalSaved += savedBytes;
  totalDeleted += deletedFiles;
  totalRewritten += rewrittenJson;
}

console.log(
  `合计: 删除 ${totalDeleted} 个 sheet（${(totalSaved / 1048576).toFixed(1)}MB）| 重写 ${totalRewritten} 处引用${DRY ? ' [DRY-RUN]' : ''}`,
);
