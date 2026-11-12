/**
 * 辅助 XFL → AssistantPackage（bvn/assistant@1）离线提取。
 * 与角色的差异：无形态（单时间轴）、$assisterCtrler 目标、
 * 脚本含任意逻辑（链式调用/直接赋值）——rawScripts 兜底， behaviors 插件化见 ADR-6。
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import {
  validateAssistantPackage,
  type AssistantPackage,
  type RawFrameScript,
  type SymbolData,
  type TriggerArg,
  type ValidationResult,
} from '@bvn/data';
import {
  extractAssistTimelineCalls,
  extractAttackerCalls,
  extractBuffEffects,
  extractConsts,
  extractDefineActions,
  extractFunctionBodies,
  parseLoopTriggerBody,
  scriptResidue,
  stripComments,
  stripFunctionDefs,
  type AssistBuffEffects,
} from './asargs.js';
import { parseXflTimeline } from './xfl.js';

export interface ExtractAssistantOptions {
  xflDir: string;
  id: string;
}

export interface ExtractAssistantResult {
  pkg: AssistantPackage;
  validation: ValidationResult;
}

function listXmlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...listXmlFiles(p));
    else if (entry.endsWith('.xml')) out.push(p);
  }
  return out;
}

function hashSources(files: string[]): string {
  const h = createHash('sha1');
  for (const f of [...files].sort()) {
    h.update(f);
    h.update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex');
}

/** 把一条时间轴（各图层关键帧）汇成 SymbolData（辅助版，切片 12）。 */
function collectTimeline(
  layers: ReturnType<typeof parseXflTimeline>['layers'],
  into: SymbolData,
): void {
  for (const layer of layers) {
    for (const kf of layer) {
      if (kf.label) into.labels[kf.label] = { index: kf.index, duration: kf.duration };
      if (kf.script) {
        const { calls } = extractAssistTimelineCalls(kf.script);
        for (const call of calls) {
          into.triggers.push({
            frame: kf.index,
            target: call.target,
            op: call.op,
            args: call.args as TriggerArg[],
          });
        }
        if (scriptResidue(kf.script, { assist: true }) !== '') {
          into.rawScripts ??= [];
          into.rawScripts.push({ frame: kf.index, raw: kf.script });
        }
      }
    }
  }
  into.triggers.sort((a, b) => a.frame - b.frame);
  datafyCustomFuncs(into);
}

/**
 * addCustomFunc 数据化（切片 12）：注册帧的函数体可解析 →
 * 替换为 loopTrigger（cond+then，untilFrame = 同时间轴上其后最近的
 * removeCustomFunc 触发帧）；解析不了保留原触发（core 侧未注册 = 确定性静默）。
 */
function datafyCustomFuncs(into: SymbolData): void {
  const removeFrames = into.triggers
    .filter((t) => t.op === 'removeCustomFunc')
    .map((t) => t.frame)
    .sort((a, b) => a - b);
  const kept: typeof into.triggers = [];
  const loops: NonNullable<SymbolData['loopTriggers']> = [];
  // 函数体已完整数据化的原文条目（循环结束后统一移除——期间后续触发器
  // 仍需在 rawScripts 里找函数体定义）
  const consumedRaws = new Set<RawFrameScript>();
  for (const t of into.triggers) {
    if (t.op !== 'addCustomFunc') {
      kept.push(t);
      continue;
    }
    const ref = t.args[0];
    const name =
      ref !== null && typeof ref === 'object' && !Array.isArray(ref) && '$ref' in ref
        ? String(ref.$ref)
        : null;
    const raw = (into.rawScripts ?? []).find((r) => r.frame === t.frame);
    if (name === null || raw === undefined) {
      kept.push(t);
      continue;
    }
    // 函数体可在同帧或更早帧的脚本里定义——合并该帧全部原文查找
    const scriptAt = (into.rawScripts ?? [])
      .filter((r) => r.frame <= t.frame)
      .map((r) => r.raw)
      .join('\n');
    const body = extractFunctionBodies(scriptAt).get(name);
    if (body === undefined) {
      kept.push(t);
      continue;
    }
    const parsed = parseLoopTriggerBody(body, extractConsts(scriptAt));
    if (parsed === null) {
      // 通用解析失败 → 尝试已知函数模板识别（切片 21：byakuya 抓取链）。
      // 命中则把 addCustomFunc 触发器参数改写为语义描述符（core 按 kind 解释）；
      // 未命中保持原触发（core 侧未注册 = 确定性静默）。
      const attacker = resolveAttackerName(into);
      if (attacker !== null) {
        const desc = matchKnownCustomFunc(scriptAt, name, attacker);
        if (desc !== null) {
          kept.push({ ...t, args: [desc] as unknown as typeof t.args });
          continue;
        }
      }
      kept.push(t);
      continue;
    }
    const until = removeFrames.find((f) => f > t.frame) ?? null;
    loops.push({
      frame: t.frame,
      untilFrame: until,
      cond: parsed.cond,
      then: parsed.then.map((c) => ({
        target: c.target,
        op: c.op,
        args: c.args as TriggerArg[],
      })),
    });
    // 该帧原文剥去函数体与 const 声明后无残余 → 原文条目已无信息量，移除
    const defStripped = stripFunctionDefs(raw.raw, new RegExp(`^${name}$`));
    const noConsts = defStripped.replace(
      /const\s+\w+\s*:\s*(?:Number|Array|int|uint|String|\*)\s*=\s*[^;\n]+;?/g,
      '',
    );
    if (scriptResidue(noConsts, { assist: true }) === '') consumedRaws.add(raw);
  }
  into.triggers = kept;
  if (consumedRaws.size > 0) {
    const rest = (into.rawScripts ?? []).filter((r) => !consumedRaws.has(r));
    if (rest.length > 0) into.rawScripts = rest;
    else delete into.rawScripts;
  }
  if (loops.length > 0) into.loopTriggers = loops;
}

/**
 * 时间轴上唯一的 addAttacker 元件名（切片 21 绑名规则：多值/无名 → null）。
 * 语料 6 个含 attacker 元件脚本的辅助全部单名（atmmc）。
 */
function resolveAttackerName(into: SymbolData): string | null {
  const names = into.triggers
    .filter((t) => t.op === 'addAttacker' && typeof t.args[0] === 'string')
    .map((t) => t.args[0] as string);
  return names.length === 1 ? names[0]! : null;
}

/**
 * 已知 customFunc 函数模板识别（切片 21，byakuya 抓取链——语料唯一用户）：
 *  - ownerDeadClearAttacker：owner 死亡 → 停吸附 + 移除 attacker + 注销
 *    （checkFunc：`getOwner().isAlive || !attackerCtrler` 卫语句 + stopFollowTarget
 *    + removeSelf + removeCustomFunc）
 *  - attackerEndOnTargetLeave：目标离开指定 actionState → attacker 跳收尾标签
 *    + 自注销 + 注册 next（checkFunc1；next 须可识别为 finishWhenAttackerGone，
 *    半链不建模）
 *  - finishWhenAttackerGone：attacker 消失 → 注销 + finish（checkFunc2）
 * 识别按 op 特征组合（不绑变量名），模板外一律返回 null（宁可静默不误建模）。
 */
function matchKnownCustomFunc(
  corpus: string,
  funcName: string,
  attacker: string,
): Record<string, unknown> | null {
  const bodies = extractFunctionBodies(stripComments(corpus));
  const body = bodies.get(funcName);
  if (body === undefined) return null;
  const flat = stripComments(body).replace(/\s+/g, ' ');
  const isFinishWhenGone =
    /if\s*\(\s*\w+\s*\)\s*\{\s*return\s*;\s*\}/.test(flat) &&
    /\.removeCustomFunc\(\)/.test(flat) &&
    /\.finish\(\)/.test(flat) &&
    !/gotoAndPlay/.test(flat) &&
    !/getTargetState/.test(flat) &&
    !/isAlive/.test(flat);
  if (isFinishWhenGone) {
    return { kind: 'finishWhenAttackerGone', attacker };
  }
  const isOwnerDeadClear =
    /getOwner\(\)\.isAlive/.test(flat) &&
    /\.stopFollowTarget\(\)/.test(flat) &&
    /\.removeSelf\(\)/.test(flat) &&
    /\.removeCustomFunc\(\)/.test(flat) &&
    !/gotoAndPlay/.test(flat) &&
    !/getTargetState/.test(flat);
  if (isOwnerDeadClear) {
    return { kind: 'ownerDeadClearAttacker', attacker };
  }
  const stateMatch = /getTargetState\(\)[\s\S]{0,120}?==\s*(\d+)/.exec(flat);
  const endLabelMatch = /\.gotoAndPlay\(\s*(["'])([^"']+)\1\s*\)/.exec(flat);
  const nextMatch = /\.addCustomFunc\(\s*(\w+)\s*\)/.exec(flat);
  if (stateMatch && endLabelMatch && nextMatch) {
    const nextBody = bodies.get(nextMatch[1]!);
    if (nextBody === undefined) return null;
    const nextFlat = stripComments(nextBody).replace(/\s+/g, ' ');
    const nextIsFinish =
      /if\s*\(\s*\w+\s*\)\s*\{\s*return\s*;\s*\}/.test(nextFlat) &&
      /\.removeCustomFunc\(\)/.test(nextFlat) &&
      /\.finish\(\)/.test(nextFlat) &&
      !/getTargetState/.test(nextFlat) &&
      !/isAlive/.test(nextFlat);
    if (!nextIsFinish) return null;
    return {
      kind: 'attackerEndOnTargetLeave',
      attacker,
      state: Number(stateMatch[1]!),
      endLabel: endLabelMatch[2]!,
      next: 'finishWhenAttackerGone',
    };
  }
  return null;
}

/**
 * finish 守卫惯用语改写（切片 21）：`if (!judge) { $assisterCtrler.finish(); }`
 * → finishIfNoAttacker(attacker)。judge 系布尔仅在挂载 attacker 的路径上置位
 * （frame 51 `judge = true` 与 addAttacker 同路径），故守卫 ≡「attacker 不存在
 * 才 finish」——抓取路径辅助靠 loop 标签循环保活，非抓取路径照常退场。
 * 帧号匹配限定（守卫脚本的帧上恰好有一个 finish 触发器）；多 attacker 名
 * （绑名失败）不改写。
 */
function rewriteFinishGuard(into: SymbolData, attacker: string | null): void {
  if (attacker === null) return;
  const frames = new Set<number>();
  for (const r of into.rawScripts ?? []) {
    const s = stripComments(r.raw).replace(/\s+/g, '');
    if (/if\(!\w+\)\{\$assisterCtrler\.finish\(\);?\}/.test(s)) frames.add(r.frame);
  }
  if (frames.size === 0) return;
  into.triggers = into.triggers.map((t) =>
    t.op === 'finish' && frames.has(t.frame)
      ? { ...t, op: 'finishIfNoAttacker', args: [attacker] }
      : t,
  );
}

/**
 * attacker 元件脚本提取（切片 21）：绑名规则 = 时间轴唯一 addAttacker 名 ↔
 * 唯一含 $attacker_ctrler 脚本的符号（语料 6 辅助全部无歧义）。输出
 * labels（0 基 → 1 基，与 fire 元数据同基）+ 纯调用触发器（帧号 0 基，
 * compileAssistant 统一 +1）；含条件/带状态语句的脚本整条不提取
 * （madara justHit miss 分支——attacker 内层 hitVO 未导出前无真值，留 raw）。
 */
function extractAttackerScripts(
  timeline: SymbolData,
  symbols: Record<string, SymbolData>,
): AssistantPackage['attackerScripts'] {
  const attacker = resolveAttackerName(timeline);
  if (attacker === null) return undefined;
  const cands = Object.entries(symbols).filter(([, sym]) =>
    (sym.rawScripts ?? []).some((r) => r.raw.includes('$attacker_ctrler')),
  );
  if (cands.length !== 1) return undefined;
  const [, sym] = cands[0]!;
  const labels: Record<string, number> = {};
  for (const [l, r] of Object.entries(sym.labels)) labels[l] = r.index + 1;
  const triggers: NonNullable<AssistantPackage['attackerScripts']>[string]['triggers'] = [];
  for (const r of sym.rawScripts ?? []) {
    const stripped = stripComments(r.raw);
    if (/\bif\b|\bvar\b|\bfor\b|\bwhile\b|\breturn\b/.test(stripped)) continue;
    for (const c of extractAttackerCalls(stripped)) {
      triggers.push({ frame: r.frame, target: c.target, op: c.op, args: c.args });
    }
  }
  if (triggers.length === 0 && Object.keys(labels).length === 0) return undefined;
  return { [attacker]: { labels, triggers } };
}

export function extractAssistant(opts: ExtractAssistantOptions): ExtractAssistantResult {
  const docPath = join(opts.xflDir, 'DOMDocument.xml');
  const root = parseXflTimeline(readFileSync(docPath, 'utf8'));

  // defineAction 表：汇总根时间轴全部帧脚本（kon 在第 0 帧的 defineActions() 函数体内）
  const actions: AssistantPackage['actions'] = {};
  let buffEffects: AssistBuffEffects | undefined;
  const timeline: SymbolData = { labels: {}, triggers: [] };
  collectTimeline(root.layers, timeline);
  for (const layer of root.layers) {
    for (const kf of layer) {
      if (!kf.script) continue;
      for (const da of extractDefineActions(kf.script)) {
        actions[da.id] = {
          power: Number(da.data['power'] ?? 0),
          hitType: Number(da.data['hitType'] ?? 0),
          hitx: Number(da.data['hitx'] ?? 0),
          hity: Number(da.data['hity'] ?? 0),
          hurtTime: Number(da.data['hurtTime'] ?? 0),
          hurtType: Number(da.data['hurtType'] ?? 0),
          isBreakDef: da.data['isBreakDef'] === true,
          isApplyG: da.data['isApplyG'] !== false,
        };
      }
      const buff = extractBuffEffects(kf.script);
      if (buff !== null) buffEffects = { ...buffEffects, ...buff };
    }
  }

  const libDir = join(opts.xflDir, 'LIBRARY');
  const symbolFiles = listXmlFiles(libDir);
  const symbols: Record<string, SymbolData> = {};
  for (const file of symbolFiles) {
    const key = relative(libDir, file).replace(/\\/g, '/').replace(/\.xml$/, '');
    const tl = parseXflTimeline(readFileSync(file, 'utf8'));
    const data: SymbolData = { labels: {}, triggers: [] };
    collectTimeline(tl.layers, data);
    if (
      Object.keys(data.labels).length > 0 ||
      data.triggers.length > 0 ||
      (data.rawScripts !== undefined && data.rawScripts.length > 0)
    ) {
      symbols[key] = data;
    }
  }

  // 切片 21：finish 守卫惯用语改写 + attacker 元件脚本提取
  rewriteFinishGuard(timeline, resolveAttackerName(timeline));
  const attackerScripts = extractAttackerScripts(timeline, symbols);

  const pkg: AssistantPackage = {
    schema: 'bvn/assistant@1',
    id: opts.id,
    source: {
      kind: 'xfl',
      path: basename(opts.xflDir),
      hash: hashSources([docPath, ...symbolFiles]),
    },
    actions,
    timeline,
    symbols,
    ...(buffEffects !== undefined ? { buffEffects } : {}),
    ...(attackerScripts !== undefined ? { attackerScripts } : {}),
  };

  return { pkg, validation: validateAssistantPackage(pkg) };
}
