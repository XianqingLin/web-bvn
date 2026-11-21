#!/usr/bin/env node
/**
 * fire-script-pack — 角色侧 attacker 元件脚本提取（2026-11-21）。
 *
 * 背景：原版 addAttacker 元件的时间轴带 $attacker_ctrler.* 帧脚本
 * （move/damping/fire/setHitTarget/…，FighterAttackerCtrler 转发），驱动
 * 道具位移、续接跳转与元件内弹体。切片 21 只给辅助侧接了脚本通道；
 * 角色侧（pain 招1/招2 等 23 角色语料）从未提取——道具静止在生成点、
 * 续接/爆炸不触发。
 *
 * 本工具：扫 <XFL_ROOT>/<id>/ 的 元件/*.xml + DOMDocument.xml，把「实例名
 * = fire 元件名」的符号时间轴脚本提取为 triggers，合并进
 * packages/data/baked/fires/<ownerKind>/<id>.json（bvn/fire@1 追加可选
 * triggers 字段；帧号 XFL 0 基 → +1 转 1 基）。org/hits 等既有数据不动。
 *
 * 提取语义（与辅助侧 extractAttackerScripts 同约定，tools/exporter）：
 * - stripComments + stripFunctionDefs(setAttackerCtrler) 后逐帧提取
 *   $attacker_ctrler.op(...)（effect 链 → target 'effect'）；
 * - justHit 卫语句 → cond 触发器（dispatchAttackerCond 分派）；
 * - 含 if/var/for/while/return 的复杂脚本整帧跳过（确定性静默，审计打印）；
 * - 元件名定位：任意符号/DOMDocument 上 name=<fireName> 的实例 → 其
 *   libraryItemName 符号；多命中取首个含 attacker 脚本者。
 *
 * 用法：
 *   node tools/fire-script-pack/fire-script-pack.mjs            # 全量（缺 triggers 者）
 *   node tools/fire-script-pack/fire-script-pack.mjs pain       # 指定 id
 *   node tools/fire-script-pack/fire-script-pack.mjs --check    # 只报告不写
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseXflTimeline } from '../exporter/dist/xfl.js';
import {
  extractAttackerCalls,
  matchJustHitGuard,
  stripComments,
  stripFunctionDefs,
} from '../exporter/dist/asargs.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const XFL_ROOT = resolve(ROOT, 'OpenBleachVsNaruto/swf_source/f_fighter');
const BAKED = resolve(ROOT, 'packages/data/baked');
const CHECK_ONLY = process.argv.includes('--check');
const targets = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const FORCE = process.argv.includes('--force');

const KNOWN_OPS = new Set([
  'stop',
  'gotoAndPlay',
  'gotoAndStop',
  'stopFollowTarget',
  'removeSelf',
  'endAct',
  'move',
  'damping',
  'stopMove',
  'setTouchFloor',
  'setCrossMap',
  'moveToTarget',
  'setHitTarget',
  'fire',
  'shine',
  'playSoundHit1',
  'playSoundHit2',
  'walk',
  'dash',
  'shake',
  'slowDown',
]);

/** 符号 → {labels, scripts:[{frame(1起), raw}]}；同时收集全部实例名映射。 */
function scanSymbol(file, nameMap) {
  const tl = parseXflTimeline(readFileSync(file, 'utf8'));
  const labels = {};
  const scripts = [];
  for (const layer of tl.layers) {
    for (const kf of layer) {
      const frame = kf.index + 1; // XFL 0 基 → 1 基
      if (kf.label) labels[kf.label] = frame;
      if (kf.script) scripts.push({ frame, raw: kf.script });
      for (const inst of kf.symbolInstances) {
        if (inst.name && !nameMap.has(inst.name)) {
          nameMap.set(inst.name, { libraryItemName: inst.libraryItemName, via: relative(ROOT, file) });
        }
      }
    }
  }
  return { labels, scripts };
}

/** 元件脚本帧 → triggers（1 基帧号；复杂脚本整帧跳过）。 */
function extractTriggers(symbolScripts, symbolLabels, id, elemName, report) {
  const triggers = [];
  const sorted = [...symbolScripts].sort((a, b) => a.frame - b.frame);
  for (const s of sorted) {
    const stripped = stripComments(s.raw).trim();
    if (!stripped.includes('$attacker_ctrler')) continue;
    const body = stripFunctionDefs(stripped, /^setAttackerCtrler$/);
    const cleaned = body
      .replace(/var\s+\$attacker_ctrler:\*;?/g, '')
      .trim();
    if (cleaned === '') continue;
    const guard = matchJustHitGuard(cleaned);
    if (guard !== null) {
      triggers.push({
        frame: s.frame,
        target: 'attacker',
        op: 'if',
        args: [],
        cond: { target: 'attacker', op: 'justHit', args: [guard.hitId], negate: true },
        then: [],
        else: [{ target: 'attacker', op: 'gotoAndPlay', args: [guard.label] }],
      });
      continue;
    }
    if (/\bif\b|\bvar\b|\bfor\b|\bwhile\b|\breturn\b/.test(cleaned)) {
      report.skipped.push(`${id}:${elemName}@${s.frame}（复杂脚本）`);
      continue;
    }
    const calls = extractAttackerCalls(cleaned);
    if (calls.length === 0) continue;
    let unknown = false;
    for (const c of calls) {
      if (c.target === 'attacker' && !KNOWN_OPS.has(c.op)) {
        unknown = true;
        break;
      }
      if (c.target === 'effect' && !KNOWN_OPS.has(c.op)) {
        unknown = true;
        break;
      }
    }
    if (unknown) {
      report.skipped.push(`${id}:${elemName}@${s.frame}（未知 op）`);
      continue;
    }
    for (const c of calls) {
      triggers.push({ frame: s.frame, target: c.target, op: c.op, args: c.args });
    }
  }
  return triggers;
}

function processFighter(id, report) {
  const bakedPath = join(BAKED, 'fires/fighter', `${id}.json`);
  if (!existsSync(bakedPath)) {
    report.noBaked.push(id);
    return;
  }
  const pkg = JSON.parse(readFileSync(bakedPath, 'utf8'));
  const elemNames = Object.keys(pkg.fires ?? {});
  if (elemNames.length === 0) {
    report.noBaked.push(`${id}（fires 空）`);
    return;
  }
  const xflDir = join(XFL_ROOT, id);
  const libDir = join(xflDir, 'LIBRARY');
  if (!existsSync(libDir)) {
    report.noXfl.push(id);
    return;
  }
  // 1. 全符号扫描（实例名 → 库元件 + 各符号 labels/scripts）
  const nameMap = new Map();
  const symbols = new Map();
  const docFile = join(xflDir, 'DOMDocument.xml');
  if (existsSync(docFile)) {
    symbols.set('::doc::', scanSymbol(docFile, nameMap));
  }
  for (const f of readdirSync(libDir, { recursive: true })) {
    if (typeof f !== 'string' || !f.endsWith('.xml')) continue;
    // 键 = 库元件名（libraryItemName 语义，如 "元件/mc_012"）
    const key = relative(libDir, join(libDir, f)).replace(/\\/g, '/').replace(/\.xml$/, '');
    symbols.set(key, scanSymbol(join(libDir, f), nameMap));
  }
  // 2. 逐元件：实例名 → 符号 → 提取 triggers（含 labels 一致性核对）
  let touched = 0;
  for (const elemName of elemNames) {
    const tl = pkg.fires[elemName];
    if (tl.triggers !== undefined && !FORCE) continue;
    const hit = nameMap.get(elemName);
    if (!hit || !hit.libraryItemName) {
      report.missing.push(`${id}:${elemName}`);
      continue;
    }
    const symKey = hit.libraryItemName;
    const sym = symbols.get(symKey);
    if (!sym) {
      report.missing.push(`${id}:${elemName}（符号 ${symKey} 缺失）`);
      continue;
    }
    const triggers = extractTriggers(sym.scripts, sym.labels, id, elemName, report);
    if (triggers.length === 0) continue;
    // capture labels 与 XFL labels 交叉核对（漂移 = 采集/导出基线错位）
    for (const [lab, frame] of Object.entries(sym.labels)) {
      const baked = tl.labels[lab];
      if (baked === undefined) {
        report.labelDrift.push(`${id}:${elemName}.${lab} XFL=${frame} baked=缺失`);
      } else if (baked !== frame) {
        report.labelDrift.push(`${id}:${elemName}.${lab} XFL=${frame} baked=${baked}`);
      }
    }
    if (!CHECK_ONLY) tl.triggers = triggers;
    touched += 1;
    report.extracted.push(`${id}:${elemName}(${triggers.length})`);
  }
  if (touched > 0 && !CHECK_ONLY) {
    writeFileSync(bakedPath, JSON.stringify(pkg, null, 2) + '\n');
  }
  report.done.push(`${id}(${touched})`);
}

const report = {
  done: [],
  extracted: [],
  skipped: [],
  missing: [],
  noXfl: [],
  noBaked: [],
  labelDrift: [],
};

const ids = targets.length > 0 ? targets : readdirSync(join(BAKED, 'fires/fighter'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

for (const id of ids) processFighter(id, report);

console.log(`提取完成：${report.done.join(' ') || '无'}`);
console.log(`带脚本元件：\n  ${report.extracted.join('\n  ') || '无'}`);
if (report.skipped.length) console.log(`整帧跳过：\n  ${report.skipped.join('\n  ')}`);
if (report.missing.length) console.log(`未定位实例：\n  ${report.missing.join('\n  ')}`);
if (report.noXfl.length) console.log(`无 XFL：${report.noXfl.join(' ')}`);
if (report.noBaked.length) console.log(`无 baked fires：${report.noBaked.join(' ')}`);
if (report.labelDrift.length) console.log(`labels 漂移：\n  ${report.labelDrift.join('\n  ')}`);
