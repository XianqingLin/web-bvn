#!/usr/bin/env node
/**
 * tools/replay/verify-drift —— 哈希漂移归因工具（DESIGN §7）。
 *
 * replay 门禁报哈希不一致时，回答一个问题：漂移是「纯表示变更」还是「行为变更」？
 * 方法：对同一剧本，把当前工作区代码与 HEAD 的**全量状态逐 tick** dump 出来对比。
 * 全等 → 漂移是哈希表示层的（可重冻基线，契约 §硬规则 8）；不等 → 列出精确到
 * 字段路径的行为差异（禁止重冻）。
 *
 * 用法：
 *   node tools/replay/verify-drift.mjs <script.json>
 *
 * 前提：工作区有未提交改动（漂移调查发生的典型状态）。工具流程：
 *   1. pnpm build（保证 dist = 当前源码）→ dump 工作区状态；
 *   2. git stash push -u → pnpm build → dump HEAD 状态 → git stash pop → pnpm build；
 *   3. 逐 tick 对比 dump（stableStringify 全量状态），差异做结构化深diff。
 * 注意：暂存区改动会被 stash 并以未暂存形式恢复；dump 文件写系统临时目录。
 * 两次 dump 均以**子进程**运行（dump-states.mjs）：ESM import 缓存按进程生效，
 * 同进程先后 dump 会让 HEAD 沿用首次加载的 dist → 恒「零差异」假阴性
 * （修复批次 30 发现并修复）。
 * 退出码：0 零行为差异；1 存在行为差异；2 用法/流程错误。
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STASH_MSG = 'bvn-verify-drift';

function fail(msg) {
  console.error(`verify-drift: ${msg}`);
  process.exit(2);
}
function git(args) {
  return execSync(`git ${args}`, { encoding: 'utf8', cwd: process.cwd() }).trim();
}

const args = process.argv.slice(2);
const scriptPath = args.find((a) => !a.startsWith('--'));
if (!scriptPath) fail('缺少剧本路径。用法：node tools/replay/verify-drift.mjs <script.json>');
const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
if (!Array.isArray(script.program)) fail('剧本缺少 program 数组。');

const dirty = git('status --porcelain');
if (!dirty) fail('工作区干净（当前代码 == HEAD），无可对比差异。先复现漂移：改动代码后运行本工具。');

const DUMP_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'dump-states.mjs');
let dumpSeq = 0;

// —— dump：子进程跑剧本，逐 tick 记全量状态字符串（见文件头注释） ——
function dumpStates() {
  const outPath = join(tmpdir(), `bvn-verify-drift-dump-${process.pid}-${dumpSeq++}.json`);
  execSync(`node ${JSON.stringify(DUMP_SCRIPT)} ${JSON.stringify(scriptPath)} ${JSON.stringify(outPath)}`, {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  const parsed = JSON.parse(readFileSync(outPath, 'utf8'));
  rmSync(outPath);
  return { ticks: parsed.ticks, states: parsed.states };
}

let tmpDir = null;
let stashed = false;
let verdict = 2;
try {
  console.log('verify-drift: [1/3] build + dump 工作区…');
  execSync('pnpm build', { stdio: 'inherit' });
  const workDump = dumpStates();

  console.log('verify-drift: [2/3] stash → build + dump HEAD…');
  // 排除本工具自身（未跟踪的新文件也会被 -u 收进 stash，子进程就找不到了）
  git(
    `stash push -u -m ${STASH_MSG} -- . ":(exclude)tools/replay/verify-drift.mjs" ":(exclude)tools/replay/dump-states.mjs"`,
  );
  stashed = true;
  let headDump;
  try {
    execSync('pnpm build', { stdio: 'inherit' });
    headDump = dumpStates();
  } finally {
    // 无论 HEAD dump 成败都恢复工作区
    git('stash pop');
    stashed = false;
  }
  console.log('verify-drift: [3/3] build 恢复工作区 dist…');
  execSync('pnpm build', { stdio: 'ignore' });

  if (headDump.ticks !== workDump.ticks) {
    fail(`tick 数不同：HEAD ${headDump.ticks} vs 工作区 ${workDump.ticks}（剧本展开受代码影响？属行为差异）。`);
  }

  // —— 逐 tick 对比 + 结构化深 diff ——
  const diffTicks = [];
  let firstDiffDetail = null;
  for (let i = 0; i < workDump.ticks; i++) {
    if (workDump.states[i] === headDump.states[i]) continue;
    // 字符串不等 → 深 diff 判语义：空 = 仅结构/键序漂移（语义相等）
    const dd = deepDiff(
      JSON.parse(headDump.states[i]).state,
      JSON.parse(workDump.states[i]).state,
      '',
    );
    if (dd.length === 0) continue;
    diffTicks.push(i + 1);
    if (!firstDiffDetail) firstDiffDetail = dd;
  }

  tmpDir = mkdtempSync(join(tmpdir(), 'bvn-verify-drift-'));
  writeFileSync(join(tmpDir, 'work.json'), JSON.stringify(workDump));
  writeFileSync(join(tmpDir, 'head.json'), JSON.stringify(headDump));

  if (diffTicks.length === 0) {
    console.log(`verify-drift: 零行为差异——${workDump.ticks} tick 全量状态逐 tick 全等。`);
    console.log('  哈希漂移为纯表示变更（新增字段/坐标重锚定等），可按契约 §硬规则 8 重冻基线。');
    verdict = 0;
  } else {
    console.log(`verify-drift: 存在行为差异——${diffTicks.length}/${workDump.ticks} tick 不等（首个 tick ${diffTicks[0]}）。`);
    console.log('  首个差异 tick 的字段级 diff（HEAD → 工作区，最多 40 条）：');
    for (const d of firstDiffDetail) {
      console.log(`    ${d.path}: ${d.old} → ${d.new}`);
    }
    if (firstDiffDetail.length >= 40) console.log('    …（截断，完整 dump 见临时目录）');
    console.log(`  dump: ${tmpDir}`);
    console.log('  存在行为差异，禁止重冻基线——先修行为或确认改动有意（写进提交说明再重冻）。');
    verdict = 1;
  }
} catch (e) {
  fail(`流程失败：${e.message}`);
} finally {
  if (stashed) {
    console.error('verify-drift: 异常退出前尝试恢复 stash…');
    try { git('stash pop'); } catch { /* 让用户手动恢复 */ }
  }
  if (tmpDir && verdict === 0) rmSync(tmpDir, { recursive: true, force: true });
}
process.exit(verdict);

function trunc(v) {
  const s = JSON.stringify(v);
  if (s === undefined) return 'undefined';
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

function deepDiff(a, b, path, out = [], depth = 0) {
  if (out.length >= 40 || depth > 12) {
    if (out.length < 40) out.push({ path: path || '<root>', old: trunc(a), new: trunc(b) });
    return out;
  }
  if (a === b) return out;
  const isObj = (v) => v !== null && typeof v === 'object';
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) {
    out.push({ path: path || '<root>', old: trunc(a), new: trunc(b) });
    return out;
  }
  if (Array.isArray(a)) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) deepDiff(a[i], b[i], `${path}[${i}]`, out, depth + 1);
  } else {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) deepDiff(a[k], b[k], path ? `${path}.${k}` : k, out, depth + 1);
  }
  return out;
}
