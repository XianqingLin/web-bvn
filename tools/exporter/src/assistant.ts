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
  extractBuffEffects,
  extractConsts,
  extractDefineActions,
  extractFunctionBodies,
  parseLoopTriggerBody,
  scriptResidue,
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
  };

  return { pkg, validation: validateAssistantPackage(pkg) };
}
