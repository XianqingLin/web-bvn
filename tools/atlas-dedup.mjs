#!/usr/bin/env node
/**
 * tools/atlas-dedup —— 图集去重：形态派生角色引用基础角色 sheet（2026-11-17）。
 *
 * 背景：atlas-pack 按 id 导出，形态角色（naruto_sennin/sasuke_juin/ichigo_bankai 等）
 * 的 sheet 与基础角色逐字节相同（同一 swf 的同一 sprite 导出），只有 atlas.json 的
 * id 字段与 sheet 文件名前缀不同。原版 SWF 里形态共用同一份资源，我们却每 id 物理复制
 * 一份：fighters 219.6MB → 去重后 95.9MB（417 个重复文件，~124MB）。
 *
 * 动作（对 fighters/ 与 assistants/ 各跑一遍）：
 *   1. 按「atlas.json 归一化内容（id/文件名剥离）+ sheet 逐文件 MD5 序列」分组；
 *   2. 每组取字典序最小 id 为 canonical（naruto < naruto_fourTail < naruto_sennin，
 *      基础角色恒为无下划线前缀，天然胜出）；
 *   3. 非 canonical 的 atlas.json：sheets[].file 重写指向 canonical 的 sheet 文件
 *      （按索引一一对应；frames/forms 等其余内容不动，id 字段保留原值）；
 *   4. 删除非 canonical 的重复 sheet 文件（删前逐文件 MD5 复核）。
 * 帧按 pngId→sheet 索引引用（bvn/atlas@1），运行时只经 atlas.json 找 sheet 文件，
 * 重写文件名即完成共享，零代码改动。
 *
 * 幂等：重跑时重复 sheet 已不存在，atlas.json 已指向 canonical 文件，签名不变，全组 no-op。
 * 管线位置：任何 pack 工具重新产出资产后，统一执行 `pnpm assets:finalize`
 * （= webp-convert → atlas-dedup，顺序固定）；单步重跑用 `pnpm assets:dedup`。
 *
 * 用法：node tools/atlas-dedup.mjs [--dry-run]
 */
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ASSETS = path.join(ROOT, 'packages', 'data', 'assets');
const DIRS = ['fighters', 'assistants'];
const DRY = process.argv.includes('--dry-run');

const md5 = (file) => createHash('md5').update(readFileSync(file)).digest('hex');

for (const dirName of DIRS) {
  const dir = path.join(ASSETS, dirName);
  const files = new Set(readdirSync(dir));
  const atlasIds = [...files]
    .filter((f) => f.endsWith('.atlas.json'))
    .map((f) => f.replace(/\.atlas\.json$/, ''))
    .sort();

  // 分组：归一化 atlas 内容 + sheet 内容 MD5 序列
  const sigOf = (id) => {
    const atlas = JSON.parse(readFileSync(path.join(dir, `${id}.atlas.json`), 'utf8'));
    const norm = JSON.stringify({ ...atlas, id: '', sheets: atlas.sheets.map((s, i) => ({ i, w: s.w, h: s.h })) });
    const sheetHashes = atlas.sheets.map((s) => {
      const f = `${id}/${s.file}`;
      if (!files.has(s.file)) throw new Error(`${dirName}/${f}: atlas 引用的 sheet 不存在`);
      return md5(path.join(dir, s.file));
    });
    return { sig: `${norm}|${sheetHashes.join(',')}`, atlas, sheetHashes };
  };

  const groups = new Map();
  for (const id of atlasIds) {
    const { sig } = sigOf(id);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(id);
  }

  let savedBytes = 0;
  let deletedFiles = 0;
  let rewrittenJson = 0;
  const dupGroups = [...groups.values()].filter((g) => g.length > 1);
  for (const group of dupGroups) {
    const canonical = group[0]; // 字典序最小 = 基础角色
    const { atlas: canonAtlas, sheetHashes } = sigOf(canonical);
    console.log(`${dirName}: [${group.join(' == ')}] → ${canonical}`);
    for (const id of group) {
      if (id === canonical) continue;
      const { atlas } = sigOf(id);
      // 重写 sheet 文件名 → canonical 的（按索引对应，MD5 已证相同）
      let changed = false;
      atlas.sheets.forEach((s, i) => {
        const target = canonAtlas.sheets[i].file;
        if (s.file !== target) {
          s.file = target;
          changed = true;
        }
      });
      if (changed) {
        console.log(`  ${id}.atlas.json: sheets[].file → ${canonical}.sheet-*.webp`);
        if (!DRY) writeFileSync(path.join(dir, `${id}.atlas.json`), JSON.stringify(atlas));
        rewrittenJson++;
      }
      // 删除该 id 自己的 sheet 文件（删前 MD5 复核与 canonical 对应文件一致）
      for (const f of [...files]) {
        if (!f.startsWith(`${id}.sheet-`)) continue;
        const idx = Number(f.slice(id.length + 7).replace(/\.webp$/, ''));
        const counterpart = canonAtlas.sheets[idx]?.file;
        if (!counterpart || md5(path.join(dir, f)) !== md5(path.join(dir, counterpart))) {
          throw new Error(`${dirName}/${f}: 与 ${canonical} 对应 sheet 内容不一致，拒绝删除`);
        }
        const size = statSync(path.join(dir, f)).size;
        if (!DRY) unlinkSync(path.join(dir, f));
        files.delete(f);
        savedBytes += size;
        deletedFiles++;
      }
    }
  }

  const totalBytes = readdirSync(dir).reduce((a, f) => a + statSync(path.join(dir, f)).size, 0);
  console.log(
    `${dirName}: ${dupGroups.length} 组重复 | 删除 ${deletedFiles} 个 sheet（${(savedBytes / 1048576).toFixed(1)}MB）| 重写 ${rewrittenJson} 个 atlas.json | 现存 ${(totalBytes / 1048576).toFixed(1)}MB`,
  );
}
