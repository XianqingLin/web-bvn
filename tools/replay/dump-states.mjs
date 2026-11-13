#!/usr/bin/env node
/**
 * tools/replay/dump-states —— 剧本逐 tick 全量状态 dump（verify-drift 子进程用）。
 *
 * 必须以独立进程运行：ESM import 缓存按进程生效，verify-drift 曾在同一进程内
 * 先后 dump 工作区/HEAD 两次 → 第二次用的仍是首次加载的 dist → HEAD dump
 * 恒等于工作区 dump → 恒报「零行为差异」（假阴性，修复批次 30 修复）。
 *
 * 用法：node tools/replay/dump-states.mjs <script.json> <out.json>
 * 输出：JSON 数组，每项 = stableStringify({ tick, state })。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createReplaySim, expandFrames } from './run-script.mjs';
import { stableStringify } from '@bvn/core';

const [scriptPath, outPath] = process.argv.slice(2);
if (!scriptPath || !outPath) {
  console.error('dump-states: 用法：node tools/replay/dump-states.mjs <script.json> <out.json>');
  process.exit(2);
}
const script = JSON.parse(readFileSync(resolve(process.cwd(), scriptPath), 'utf8'));
const frames = expandFrames(script);
if (frames.length === 0) {
  console.error('dump-states: 剧本展开后为空。');
  process.exit(2);
}
const sim = createReplaySim(script);
const states = [];
for (const f of frames) {
  const snap = sim.tick(f);
  states.push(stableStringify({ tick: snap.tick, state: snap.state }));
}
writeFileSync(resolve(process.cwd(), outPath), JSON.stringify({ ticks: frames.length, states }));
console.log(`dump-states: ${states.length} ticks → ${outPath}`);
