#!/usr/bin/env node
/**
 * 把 fire 元件"发射点实例"的 Flash blendMode 写进现有 fire 图集（批次 70）。
 *
 * 背景：采集桥隔离采集 fire 元件时只拿到元件自身内容，丢失角色时间轴上
 * addAttacker/fire 调用所在实例的 blendMode（screen/add/lighten/multiply…）。
 * 黑底图源因此被烤成不透明黑块。原版靠实例混合对场景消黑。渲染层现已按
 * fires[name].blend 补回混合，本脚本负责在没有重采的情况下把该字段补齐
 * （重采后采集桥会直接写出，脚本可重复执行、幂等）。
 *
 * 用法：node tools/atlas-capture/patch-fire-blend.mjs [--dry-run]
 * 数据源：OpenBleachVsNaruto/swf_source/f_fighter|f_assistant/<id>/LIBRARY/元件/*.xml
 * 目标：packages/data/assets/fires/<fighter|assister>/<id>.atlas.json
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const XFL_ROOT = join(ROOT, 'OpenBleachVsNaruto/swf_source');
const ASSETS = join(ROOT, 'packages/data/assets/fires');
const dryRun = process.argv.includes('--dry-run');

const groups = [
  { xfl: join(XFL_ROOT, 'f_fighter'), kind: 'fighter' },
  { xfl: join(XFL_ROOT, 'f_assistant'), kind: 'assister' },
];

/** 扫描 XFL 符号 XML，提取 <DOMSymbolInstance name="X" blendMode="Y">。 */
function scanBlends(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const id of readdirSync(dir)) {
    const lib = join(dir, id, 'LIBRARY', '元件');
    if (!existsSync(lib)) continue;
    const map = {};
    const conflicts = new Set();
    for (const file of readdirSync(lib).filter((f) => f.endsWith('.xml'))) {
      const xml = readFileSync(join(lib, file), 'utf8');
      const re = /<DOMSymbolInstance\b[^>]*>/g;
      let m;
      while ((m = re.exec(xml))) {
        const tag = m[0];
        const nameM = /\bname="([^"]+)"/.exec(tag);
        const blendM = /\bblendMode="([^"]+)"/.exec(tag);
        if (!nameM || !blendM) continue;
        const name = nameM[1];
        const blend = blendM[1];
        if (blend === 'normal') continue;
        if (map[name] !== undefined && map[name] !== blend) conflicts.add(name);
        map[name] = blend;
      }
    }
    for (const c of conflicts) delete map[c]; // 同名多混合 = 语义不定，留待重采
    if (Object.keys(map).length) out[id] = map;
  }
  return out;
}

let patched = 0;
let elements = 0;
const report = [];
for (const g of groups) {
  const blends = scanBlends(g.xfl);
  const dir = join(ASSETS, g.kind);
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.atlas.json'))) {
    const id = file.replace('.atlas.json', '');
    const map = blends[id];
    if (!map) continue;
    const path = join(dir, file);
    const atlas = JSON.parse(readFileSync(path, 'utf8'));
    let changed = false;
    for (const [name, el] of Object.entries(atlas.fires ?? {})) {
      const blend = map[name];
      // 重采后图集自带采集桥记录的 blend（运行时实例真值）——XFL 静态扫描
      // 可能命中同名但未被采集的那个实例，一律不覆盖已有值。
      if (blend && el.blend === undefined) {
        el.blend = blend;
        elements++;
        changed = true;
        report.push(`${g.kind}/${id} ${name} = ${blend}`);
      }
    }
    if (changed && !dryRun) {
      writeFileSync(path, JSON.stringify(atlas));
      patched++;
    }
  }
}
console.log(`fire blend 补齐：${elements} 元件 / ${patched} 图集${dryRun ? '（dry-run，未写盘）' : ''}`);
for (const line of report) console.log('  ' + line);
