#!/usr/bin/env node
/**
 * tools/batch-validate —— 全角色批量化验收（切片 11 门禁；切片 12 扩辅助）。
 *
 * 对全部 58 个角色 runtime 包：
 *   1. 编译冒烟   compileFighterForms（runtime dump 几何 + 基座 XFL 数值/触发）；
 *   2. op 覆盖率  各形态帧触发 op 与 core behaviors 注册表求差——未注册 op
 *                 即「确定性静默」的语义缺口，按角色/次数列出；
 *   3. 逐角色对战冒烟：真实定义自对战（同 def 双方）在真实地图上跑固定
 *                 输入剧本（砍/技/招/跳/空中/瞬步/必杀系/防御/万解全路径），
 *                 两次运行哈希必须一致（隐性非确定性检测）+
 *                 中途快照/恢复续跑哈希必须一致（序列化路径覆盖）；
 *   4. 基线固化   --out 写报告，--expect 对比基线（哈希/覆盖门禁）。
 *
 * 对全部 37 个辅助包（切片 12）：编译冒烟（compileAssistant）+ op 覆盖率
 * （timeline 触发 ∪ loopTrigger.then vs assister 注册表）+ 召唤自对战冒烟
 * （双辅助同场 + 快照/恢复）。
 *
 * 用法：
 *   node tools/batch-validate/batch-validate.mjs [--frames N] [--out r.json]
 *   node tools/batch-validate/batch-validate.mjs --expect r-baseline.json
 *
 * 退出码：0 全过；1 验收失败；2 用法/IO 错误。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Sim,
  Btn,
  defaultBehaviors,
  defaultAssisterBehaviors,
  createBehaviorRegistry,
} from '@bvn/core';
import {
  compileFighterForms,
  compileAssistant,
  compileMapStage,
} from '@bvn/data';
import {
  loadAssistantPackage,
  loadFighterPackage,
  loadMapPackage,
  loadRuntimeFighterPackage,
} from '@bvn/data/node';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BAKED_DIR = resolve(ROOT, 'packages/data/baked');

function fail(msg) {
  console.error(`batch-validate: ${msg}`);
  process.exit(2);
}

// ---- 参数 ----
const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    flags[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
  }
}
const FRAMES = Number(flags.frames ?? 700);
const SMOKE_MAP = 'Forest'; // 真实地图（含多段地板/平台，覆盖平台/落地路径）
const SMOKE_HP = 100000; // 防提前 KO 中断动作路径

// ---- 已注册 op 集合（defaultBehaviors + 引擎桥接项） ----
const registeredOps = new Set([
  ...Object.keys(defaultBehaviors),
  ...Object.keys(
    createBehaviorRegistry({
      endAct: () => {},
      spawnBullet: () => {},
      spawnAttacker: () => {},
      switchForm: () => {},
    }),
  ),
]);

// ---- 输入剧本（固定分段展开；P2 镜像 + 延迟错开） ----
// 分段：[frames, mask]；mask 为 Btn 位组合，覆盖全部动作槽路径。
const R = Btn.right, L = Btn.left, UP = Btn.up, DOWN = Btn.down;
const AT = Btn.attack, JP = Btn.jump, DA = Btn.dash, SK = Btn.skill, BS = Btn.superSkill;
function p1Program() {
  return [
    [40, R],
    [2, AT], [10, 0], [2, AT], [10, 0], [2, AT], [16, 0], // 砍连段
    [2, SK], [18, 0], // 招1
    [2, SK | UP], [18, 0], // 招3（上+技）
    [2, SK | DOWN], [18, 0], // 招2（下+技）
    [2, JP], [8, 0], [2, AT], [45, 0], // 跳 + 跳砍
    [2, DA], [30, 0], // 瞬步
    [2, BS], [55, 0], // 必杀
    [2, BS | DOWN], [55, 0], // 超必杀
    [2, BS | UP], [55, 0], // 上必杀
    [2, AT], [16, 0], // 贴身再砍（摔技入口）
    [30, DOWN], // 防御
    [2, AT | JP], [10, JP], [70, 0], // 万解（攻击+跳）
    [60, 0], // 收尾
  ];
}
function expand(program, mirror) {
  const out = [];
  for (const [n, mask] of program) {
    let m = mask;
    if (mirror) {
      if (m & R) m = (m & ~R) | L;
      else if (m & L) m = (m & ~L) | R;
      if (m & UP) m = (m & ~UP) | DOWN;
      else if (m & DOWN) m = (m & ~DOWN) | UP;
    }
    for (let i = 0; i < n; i++) out.push(m);
  }
  return out;
}
const P1_MASKS = expand(p1Program(), false);
const P2_MASKS = expand(p1Program(), true);

// ---- 逐角色验收 ----
const STAGE = compileMapStage(loadMapPackage(BAKED_DIR, SMOKE_MAP));

// fighterId → XFL 基座包（形态变体 id 的触发器在基座包 symbols 里）
const xflByFighterId = new Map();
for (const f of readdirSync(resolve(BAKED_DIR, 'fighters'))) {
  if (!f.endsWith('.json')) continue;
  const pkgId = f.slice(0, -5);
  const pkg = loadFighterPackage(BAKED_DIR, pkgId);
  for (const form of pkg.forms) {
    if (form.fighterId && !xflByFighterId.has(form.fighterId)) {
      xflByFighterId.set(form.fighterId, { pkgId, pkg });
    }
  }
}

const runtimeIds = readdirSync(resolve(BAKED_DIR, 'fighters-runtime'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5))
  .sort();

function buildConfig(id, forms) {
  const spawn = (i) => {
    const s = i === 0 ? STAGE.p1Spawn : STAGE.p2Spawn;
    return s ?? { x: i === 0 ? 300 : 700, y: STAGE.stage.groundY };
  };
  return {
    seed: 1,
    stage: STAGE.stage,
    fighters: [
      { id: 1, x: spawn(0).x, y: spawn(0).y, hp: SMOKE_HP, qi: 300, def: forms[0], forms },
      { id: 2, x: spawn(1).x, y: spawn(1).y, hp: SMOKE_HP, qi: 300, def: forms[0], forms },
    ],
  };
}

function runFighter(id) {
  const runtime = loadRuntimeFighterPackage(BAKED_DIR, id, 'fighters-runtime');
  const base = xflByFighterId.get(id);
  const xfl = base ? base.pkg : undefined;
  const forms = compileFighterForms(runtime, xfl);

  // op 覆盖率（各形态触发器 ∪ vs 注册表）
  const opUse = new Map(); // `${op}@${target}` -> count
  let rawScripts = 0;
  for (const form of forms) {
    for (const t of form.triggers) {
      if (t.op === 'if') continue; // 条件触发（cond 求值后分派 then/else，不经注册表）
      const k = `${t.op}@${t.target}`;
      opUse.set(k, (opUse.get(k) ?? 0) + 1);
    }
    if (base) {
      const sym = base.pkg.forms.find((f) => f.frame === form.rootFrame - 1)?.symbol;
      if (sym) rawScripts += base.pkg.symbols[sym]?.rawScripts?.length ?? 0;
    }
  }
  const unregistered = [...opUse.entries()]
    .filter(([k]) => !registeredOps.has(k.split('@')[0]))
    .map(([k, count]) => ({ op: k.split('@')[0], target: k.split('@')[1], count }))
    .sort((a, b) => b.count - a.count);

  // 对战冒烟：两次运行哈希一致 + 快照恢复续跑哈希一致
  const config = buildConfig(id, forms);
  const inputs = (i) => ({
    p1: P1_MASKS[Math.min(i, P1_MASKS.length - 1)] ?? 0,
    p2: P2_MASKS[Math.min(i, P2_MASKS.length - 1)] ?? 0,
  });
  const SNAP_AT = Math.min(400, FRAMES - 10);

  const run = () => {
    const sim = new Sim(config);
    const defEntries = sim.getDefEntries();
    let resumed = null;
    let resumeInputs = null;
    let hash = '';
    for (let i = 0; i < FRAMES; i++) {
      if (i === SNAP_AT) {
        // 快照/恢复对照：序列化 → 续跑到底；再从快照恢复独立续跑
        const json = sim.serializeState();
        const alt = Sim.fromState(Sim.deserializeState(json), defEntries, { training: config.training });
        let altHash = '';
        for (let j = i; j < FRAMES; j++) {
          altHash = alt.tick(inputs(j)).hash;
        }
        resumed = altHash;
        resumeInputs = FRAMES - i;
      }
      hash = sim.tick(inputs(i)).hash;
    }
    return { hash, resumed, resumeInputs };
  };

  const a = run();
  const b = run();

  return {
    id,
    forms: forms.length,
    xflBase: base ? base.pkgId : null,
    triggerOps: opUse.size,
    unregisteredOps: unregistered,
    rawScripts,
    smoke: {
      ok: a.hash === b.hash && a.hash === a.resumed,
      finalHash: a.hash,
      resumeHash: a.resumed,
      resumeFrames: a.resumeInputs,
      rerunHash: b.hash,
    },
  };
}

const results = [];
const failures = [];
for (const id of runtimeIds) {
  let r;
  try {
    r = runFighter(id);
  } catch (e) {
    r = { id, error: String(e?.stack ?? e).split('\n').slice(0, 4).join(' | ') };
    failures.push(`${id}: ${r.error}`);
  }
  results.push(r);
  if (r.error) {
    console.error(`✗ ${id} — ${r.error}`);
  } else if (!r.smoke.ok) {
    failures.push(
      `${id}: 哈希不一致（run=${r.smoke.finalHash} rerun=${r.smoke.rerunHash} resume=${r.smoke.resumeHash}）`,
    );
    console.error(`✗ ${id} — 哈希不一致`);
  } else {
    const un = r.unregisteredOps.map((u) => `${u.op}(${u.target})×${u.count}`).join(', ') || '无';
    console.log(`✓ ${id} — forms=${r.forms} ops=${r.triggerOps} 未注册: ${un}`);
  }
}

// ---- 逐辅助验收（切片 12） ----
const registeredAssistOps = new Set(Object.keys(defaultAssisterBehaviors));

const assistantIds = readdirSync(resolve(BAKED_DIR, 'assistants'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5))
  .sort();

// 召唤冒烟宿主：第一个角色（真实定义，提供物理/受击面/目标语义）
const hostRuntime = loadRuntimeFighterPackage(BAKED_DIR, runtimeIds[0], 'fighters-runtime');
const hostBase = xflByFighterId.get(runtimeIds[0]);
const hostForms = compileFighterForms(hostRuntime, hostBase ? hostBase.pkg : undefined);

// 召唤剧本：开局召唤（fzqi 初始即满）+ 贴身砍（覆盖 checkHitOwner 循环触发路径）
const AS = Btn.assist;
const assistProgram = [[2, AS], [2, AT], [10, 0], [2, AT], [10, 0], [2, AT], [574, 0]];
const A1_MASKS = expand(assistProgram, false);
const A2_MASKS = expand(assistProgram, true);

function runAssistant(id) {
  const xfl = loadAssistantPackage(BAKED_DIR, id);
  const runtime = loadRuntimeFighterPackage(BAKED_DIR, id, 'assistants-runtime');
  const def = compileAssistant(xfl, runtime);

  // op 覆盖率（timeline 触发 ∪ loopTrigger.then vs assister 注册表）
  const opUse = new Map();
  for (const t of def.triggers) {
    const k = `${t.op}@${t.target}`;
    opUse.set(k, (opUse.get(k) ?? 0) + 1);
  }
  for (const lt of def.loopTriggers) {
    for (const c of lt.then) {
      const k = `${c.op}@${c.target}`;
      opUse.set(k, (opUse.get(k) ?? 0) + 1);
    }
  }
  const unregistered = [...opUse.entries()]
    .filter(([k]) => !registeredAssistOps.has(k.split('@')[0]))
    .map(([k, count]) => ({ op: k.split('@')[0], target: k.split('@')[1], count }))
    .sort((a, b) => b.count - a.count);

  // 召唤自对战冒烟：双辅助同场（真实角色宿主）+ 哈希一致 + 快照恢复
  const config = {
    seed: 1,
    stage: STAGE.stage,
    fighters: [
      {
        id: 1, x: 300, y: STAGE.stage.groundY, hp: SMOKE_HP, qi: 300,
        def: hostForms[0], forms: hostForms, assistId: id,
      },
      {
        id: 2, x: 700, y: STAGE.stage.groundY, hp: SMOKE_HP, qi: 300,
        def: hostForms[0], forms: hostForms, assistId: id,
      },
    ],
    assistants: { [id]: def },
  };
  const inputs = (i) => ({
    p1: A1_MASKS[Math.min(i, A1_MASKS.length - 1)] ?? 0,
    p2: A2_MASKS[Math.min(i, A2_MASKS.length - 1)] ?? 0,
  });
  const SNAP_AT = Math.min(400, FRAMES - 10);

  const run = () => {
    const sim = new Sim(config);
    const defEntries = sim.getDefEntries();
    let resumed = null;
    let resumeInputs = 0;
    let hash = '';
    for (let i = 0; i < FRAMES; i++) {
      if (i === SNAP_AT) {
        const json = sim.serializeState();
        const alt = Sim.fromState(Sim.deserializeState(json), defEntries, {
          assistants: sim.getAssisterDefs(),
        });
        let altHash = '';
        for (let j = i; j < FRAMES; j++) {
          altHash = alt.tick(inputs(j)).hash;
        }
        resumed = altHash;
        resumeInputs = FRAMES - i;
      }
      hash = sim.tick(inputs(i)).hash;
    }
    return { hash, resumed, resumeInputs };
  };
  const a = run();
  const b = run();

  return {
    id,
    triggers: def.triggers.length,
    loopTriggers: def.loopTriggers.length,
    rawScripts: xfl.timeline.rawScripts?.length ?? 0,
    buffEffects: def.buffEffects ? Object.keys(def.buffEffects) : [],
    unregisteredOps: unregistered,
    smoke: {
      ok: a.hash === b.hash && a.hash === a.resumed,
      finalHash: a.hash,
      resumeHash: a.resumed,
      resumeFrames: a.resumeInputs,
      rerunHash: b.hash,
    },
  };
}

const assistResults = [];
const assistFailures = [];
for (const id of assistantIds) {
  let r;
  try {
    r = runAssistant(id);
  } catch (e) {
    r = { id, error: String(e?.stack ?? e).split('\n').slice(0, 4).join(' | ') };
    assistFailures.push(`${id}: ${r.error}`);
  }
  assistResults.push(r);
  if (r.error) {
    console.error(`✗ assist ${id} — ${r.error}`);
  } else if (!r.smoke.ok) {
    assistFailures.push(
      `${id}: 哈希不一致（run=${r.smoke.finalHash} rerun=${r.smoke.rerunHash} resume=${r.smoke.resumeHash}）`,
    );
    console.error(`✗ assist ${id} — 哈希不一致`);
  } else {
    const un = r.unregisteredOps.map((u) => `${u.op}(${u.target})×${u.count}`).join(', ') || '无';
    console.log(
      `✓ assist ${id} — trig=${r.triggers} loop=${r.loopTriggers} raw=${r.rawScripts} 未注册: ${un}`,
    );
  }
}

// ---- 汇总 ----
const okResults = results.filter((r) => !r.error);
const opAggregate = new Map();
for (const r of okResults) {
  for (const u of r.unregisteredOps) {
    const k = `${u.op}@${u.target}`;
    const e = opAggregate.get(k) ?? { op: u.op, target: u.target, instances: 0, fighters: [] };
    e.instances += u.count;
    e.fighters.push(r.id);
    opAggregate.set(k, e);
  }
}
const okAssistResults = assistResults.filter((r) => !r.error);
const assistOpAggregate = new Map();
for (const r of okAssistResults) {
  for (const u of r.unregisteredOps) {
    const k = `${u.op}@${u.target}`;
    const e = assistOpAggregate.get(k) ?? { op: u.op, target: u.target, instances: 0, assistants: [] };
    e.instances += u.count;
    e.assistants.push(r.id);
    assistOpAggregate.set(k, e);
  }
}
const summary = {
  generatedAt: new Date().toISOString(),
  fighters: runtimeIds.length,
  framesPerFighter: FRAMES,
  map: SMOKE_MAP,
  compileFailures: results.filter((r) => r.error).map((r) => r.id),
  smokeFailures: okResults.filter((r) => !r.smoke.ok).map((r) => r.id),
  unregisteredOpAggregate: [...opAggregate.values()]
    .sort((a, b) => b.instances - a.instances)
    .map((e) => ({ ...e, fighters: e.fighters.sort() })),
  results: okResults,
  assistants: assistantIds.length,
  assistantCompileFailures: assistResults.filter((r) => r.error).map((r) => r.id),
  assistantSmokeFailures: okAssistResults.filter((r) => !r.smoke.ok).map((r) => r.id),
  assistantUnregisteredOpAggregate: [...assistOpAggregate.values()]
    .sort((a, b) => b.instances - a.instances)
    .map((e) => ({ ...e, assistants: e.assistants.sort() })),
  assistantResults: okAssistResults,
};

if (flags.out) {
  mkdirSync(dirname(flags.out), { recursive: true });
  writeFileSync(flags.out, JSON.stringify(summary, null, 2) + '\n');
  console.log(`batch-validate: 报告已写入 ${flags.out}`);
}

if (flags.expect) {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(flags.expect, 'utf8'));
  } catch (e) {
    fail(`读基线失败：${e.message}`);
  }
  const mismatches = [];
  const baseById = new Map(baseline.results.map((r) => [r.id, r]));
  for (const r of okResults) {
    const b = baseById.get(r.id);
    if (!b) mismatches.push(`${r.id}: 基线缺角色`);
    else if (b.smoke.finalHash !== r.smoke.finalHash) {
      mismatches.push(`${r.id}: finalHash 变化（基线 ${b.smoke.finalHash} vs 本次 ${r.smoke.finalHash}）`);
    } else {
      const uB = JSON.stringify(b.unregisteredOps);
      const uN = JSON.stringify(r.unregisteredOps);
      if (uB !== uN) mismatches.push(`${r.id}: 未注册 op 覆盖变化`);
    }
  }
  if (mismatches.length > 0) {
    console.error('batch-validate: 基线门禁失败');
    for (const m of mismatches) console.error(`  ${m}`);
    console.error('若本次改动有意改变行为，请在提交说明中写明并更新基线。');
    process.exit(1);
  }

  // 辅助基线对比（切片 12）
  const baseAssistById = new Map((baseline.assistantResults ?? []).map((r) => [r.id, r]));
  const assistMismatches = [];
  for (const r of okAssistResults) {
    const b = baseAssistById.get(r.id);
    if (!b) assistMismatches.push(`${r.id}: 基线缺辅助`);
    else if (b.smoke.finalHash !== r.smoke.finalHash) {
      assistMismatches.push(
        `${r.id}: finalHash 变化（基线 ${b.smoke.finalHash} vs 本次 ${r.smoke.finalHash}）`,
      );
    } else {
      const uB = JSON.stringify(b.unregisteredOps);
      const uN = JSON.stringify(r.unregisteredOps);
      if (uB !== uN) assistMismatches.push(`${r.id}: 未注册 op 覆盖变化`);
    }
  }
  if (assistMismatches.length > 0) {
    console.error('batch-validate: 辅助基线门禁失败');
    for (const m of assistMismatches) console.error(`  ${m}`);
    process.exit(1);
  }
  console.log(
    `batch-validate: 基线门禁通过（${okResults.length} 角色 + ${okAssistResults.length} 辅助）`,
  );
}

console.log(
  `\n汇总：${runtimeIds.length} 角色 + ${assistantIds.length} 辅助，` +
    `编译失败 ${summary.compileFailures.length + summary.assistantCompileFailures.length}，` +
    `冒烟失败 ${summary.smokeFailures.length + summary.assistantSmokeFailures.length}，` +
    `验收失败 ${failures.length + assistFailures.length}`,
);
if (failures.length > 0 || assistFailures.length > 0) process.exit(1);
