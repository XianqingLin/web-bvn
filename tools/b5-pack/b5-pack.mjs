#!/usr/bin/env node
/**
 * b5-pack —— 逐帧命中矩形合并（B5，切片 23）。
 *
 * 输入：dump 桥（tools/bridge）产出的 char_<kind>_<id>.json（forms[].attackerMcs：
 * addAttacker 元件的 org + 逐帧命名子对象命中区，元件局部 direct=1）。
 * 输出：把 org/hits 合并进 baked fires 包（baked/fires/<kind>/<id>.json，
 * schema bvn/fire@1 的可选字段，data validate.ts 已支持）。
 *
 * 消歧：同名元件跨形态多处摆放（kakashi zh2mc 等 6 例）→ 各形态记录全等
 * 则直接合并；不等则取「该形态 triggers 含 addAttacker(名)」的记录
 * （xfl 包 forms[].symbol → symbols[key].triggers，按 rootFrame === form.frame
 * 对应）。仍无法唯一 → 报错退出。
 *
 * 用法：node tools/b5-pack/b5-pack.mjs [--dump <dir>] [--dry-run]
 * dump 目录缺省 ~/Documents/bvn-dump（dump 桥写盘处）。
 *
 * ⚠️ baked fires 包现有 totalFrames/labels 来自 capture 桥（atlas-pack 重跑
 * 会覆写 org/hits）——重跑 atlas-pack 后必须重跑本工具。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const dryRun = args.includes('--dry-run');
const dumpDir = resolve(flag('--dump') ?? join(homedir(), 'Documents', 'bvn-dump'));
const BAKED = resolve(ROOT, 'packages/data/baked');

const stats = { merged: 0, skippedNoFires: [], skippedNoName: [], disambiguated: [], errors: [] };

// dump forms[].attackerMcs 按 rootFrame 收集：name → [{ rootFrame, rec }]
function collectChar(kind, id) {
  const file = join(dumpDir, `char_${kind}_${id}.json`);
  if (!existsSync(file)) return null;
  const dump = JSON.parse(readFileSync(file, 'utf8'));
  const out = new Map(); // name -> [{ rootFrame, rec }]
  for (const form of dump.forms ?? []) {
    for (const [name, rec] of Object.entries(form.attackerMcs ?? {})) {
      if (!out.has(name)) out.set(name, []);
      out.get(name).push({ rootFrame: form.rootFrame, rec });
    }
  }
  return out;
}

// xfl 包：哪些 form 的 triggers 含 addAttacker(name) → rootFrame 集合
function formsWithAttacker(pkg, name) {
  const frames = new Set();
  for (const form of pkg.forms ?? []) {
    const sym = pkg.symbols?.[form.symbol];
    const trig = sym?.triggers ?? form.triggers ?? [];
    const has = trig.some(
      (t) =>
        t.op === 'addAttacker' ||
        (Array.isArray(t.then) && t.then.some((c) => c.op === 'addAttacker')) ||
        (Array.isArray(t.else) && t.else.some((c) => c.op === 'addAttacker')),
    );
    if (has && typeof form.frame === 'number') frames.add(form.frame);
  }
  // 触发器可能带 addAttacker 于条件体内——放宽：直接文本匹配兜底
  if (frames.size === 0) {
    for (const form of pkg.forms ?? []) {
      const sym = pkg.symbols?.[form.symbol];
      if (sym && JSON.stringify(sym.triggers ?? []).includes(`"addAttacker"`) &&
          JSON.stringify(sym.triggers ?? []).includes(`"${name}"`)) {
        if (typeof form.frame === 'number') frames.add(form.frame);
      }
    }
  }
  return frames;
}

function pickRecord(entries, wantedFrames, label) {
  const uniq = new Map();
  for (const { rec } of entries) {
    const key = JSON.stringify(rec);
    if (!uniq.has(key)) uniq.set(key, rec);
  }
  if (uniq.size === 1) return [...uniq.values()][0];
  for (const { rootFrame, rec } of entries) {
    if (wantedFrames.has(rootFrame)) {
      stats.disambiguated.push(`${label}（rootFrame ${rootFrame}）`);
      return rec;
    }
  }
  stats.errors.push(`${label}：${uniq.size} 份不同记录且无一来自 addAttacker 所在形态`);
  return null;
}

for (const [kind, dirName] of [['fighter', 'fighters'], ['assister', 'assistants']]) {
  const bakedDir = join(BAKED, dirName);
  for (const file of readdirSync(bakedDir)) {
    if (!file.endsWith('.json')) continue;
    const id = file.replace(/\.json$/, '');
    const charMcs = collectChar(kind, id);
    if (charMcs === null || charMcs.size === 0) continue;
    const firesFile = join(BAKED, 'fires', kind, `${id}.json`);
    if (!existsSync(firesFile)) {
      stats.skippedNoFires.push(`${kind}/${id}（无 fires 包）`);
      continue;
    }
    const firesPkg = JSON.parse(readFileSync(firesFile, 'utf8'));
    let changed = false;
    for (const [name, entries] of charMcs) {
      if (firesPkg.fires[name] === undefined) {
        stats.skippedNoName.push(`${kind}/${id}:${name}（fires 包无此元件）`);
        continue;
      }
      const wantedFrames = formsWithAttacker(
        JSON.parse(readFileSync(join(bakedDir, file), 'utf8')),
        name,
      );
      const rec = pickRecord(entries, wantedFrames, `${kind}/${id}:${name}`);
      if (rec === null) continue;
      const cur = firesPkg.fires[name];
      const next = {
        ...cur,
        ...(rec.org !== undefined ? { org: rec.org } : {}),
        ...(rec.hits !== undefined && Object.keys(rec.hits).length > 0 ? { hits: rec.hits } : {}),
      };
      if (JSON.stringify(next) !== JSON.stringify(cur)) {
        firesPkg.fires[name] = next;
        changed = true;
        stats.merged++;
      }
    }
    if (changed && !dryRun) {
      writeFileSync(firesFile, JSON.stringify(firesPkg, null, 2) + '\n');
    }
  }
}

console.log(`b5-pack: 合并 ${stats.merged} 项 org/hits${dryRun ? '（dry-run 未写盘）' : ''}`);
if (stats.disambiguated.length) console.log('消歧：\n  ' + stats.disambiguated.join('\n  '));
if (stats.skippedNoFires.length) console.log('跳过（无 fires 包）：\n  ' + stats.skippedNoFires.join('\n  '));
if (stats.skippedNoName.length) console.log('跳过（fires 包无元件）：\n  ' + stats.skippedNoName.join('\n  '));
if (stats.errors.length) {
  console.error('错误：\n  ' + stats.errors.join('\n  '));
  process.exit(1);
}
