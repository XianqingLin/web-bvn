#!/usr/bin/env node
/**
 * tools/replay —— 输入剧本回放 + 哈希门禁（DESIGN §7 / ADR-10）。
 *
 * 剧本格式（JSON）：
 *   { "name": "...", "seed": 1,
 *     "program": [ { "frames": 60, "p1": 8, "p2": 4 }, ... ] }
 *   program 逐段展开为每 tick 的 ButtonMask 位图（位定义见 packages/core/src/input.ts）。
 *
 * 用法：
 *   node tools/replay/replay.mjs <script.json> [--stride N] [--out result.json]
 *   node tools/replay/replay.mjs <script.json> [--stride N] --expect baseline.json
 *
 * 退出码：0 一致/仅运行；1 哈希不一致（门禁失败）；2 用法/IO 错误。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createDefaultConfig, Sim } from '@bvn/core';

function fail(msg) {
  console.error(`replay: ${msg}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const positional = [];
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
    flags[key] = val;
  } else {
    positional.push(args[i]);
  }
}

const scriptPath = positional[0];
if (!scriptPath) fail('缺少剧本路径。用法见文件头注释。');

let script;
try {
  script = JSON.parse(readFileSync(scriptPath, 'utf8'));
} catch (e) {
  fail(`读剧本失败：${e.message}`);
}
if (!Array.isArray(script.program)) fail('剧本缺少 program 数组。');

// 展开剧本
const frames = [];
for (const seg of script.program) {
  const n = seg.frames ?? 0;
  for (let i = 0; i < n; i++) frames.push({ p1: seg.p1 ?? 0, p2: seg.p2 ?? 0 });
}
if (frames.length === 0) fail('剧本展开后为空。');

const stride = Number(flags.stride ?? 60);
const sim = new Sim(createDefaultConfig(script.seed ?? 1));
const checkpoints = [];
let lastHash = '';
for (let i = 0; i < frames.length; i++) {
  const snap = sim.tick(frames[i]);
  lastHash = snap.hash;
  if ((i + 1) % stride === 0) checkpoints.push({ tick: snap.tick, hash: snap.hash });
}
const result = {
  name: script.name ?? scriptPath,
  seed: script.seed ?? 1,
  ticks: frames.length,
  stride,
  checkpoints,
  finalHash: lastHash,
};

if (flags.out) {
  mkdirSync(dirname(flags.out), { recursive: true });
  writeFileSync(flags.out, JSON.stringify(result, null, 2) + '\n');
  console.log(`replay: 基准已写入 ${flags.out}（${result.ticks} ticks, finalHash=${result.finalHash}）`);
}

if (flags.expect) {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(flags.expect, 'utf8'));
  } catch (e) {
    fail(`读基准失败：${e.message}`);
  }
  const mismatches = [];
  if (baseline.ticks !== result.ticks) {
    mismatches.push(`ticks 不同：基准 ${baseline.ticks} vs 本次 ${result.ticks}`);
  }
  const baseMap = new Map(baseline.checkpoints.map((c) => [c.tick, c.hash]));
  for (const c of result.checkpoints) {
    const b = baseMap.get(c.tick);
    if (b !== undefined && b !== c.hash) {
      mismatches.push(`tick ${c.tick}：基准 ${b} vs 本次 ${c.hash}`);
    }
  }
  if (baseline.finalHash !== result.finalHash) {
    mismatches.push(`finalHash：基准 ${baseline.finalHash} vs 本次 ${result.finalHash}`);
  }
  if (mismatches.length > 0) {
    console.error(`replay: 哈希门禁失败（${result.name}）`);
    for (const m of mismatches) console.error(`  ${m}`);
    console.error('若本次改动有意改变行为，请在提交说明中写明并更新基准（契约 §硬规则 8）。');
    process.exit(1);
  }
  console.log(`replay: 哈希门禁通过（${result.name}，${result.ticks} ticks）`);
}

if (!flags.out && !flags.expect) {
  console.log(JSON.stringify(result, null, 2));
}
