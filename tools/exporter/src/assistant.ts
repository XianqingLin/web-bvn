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
  type SymbolData,
  type TriggerArg,
  type ValidationResult,
} from '@bvn/data';
import {
  extractCtrlerCalls,
  extractDefineActions,
  scriptResidue,
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

/** 把一条时间轴（各图层关键帧）汇成 SymbolData。 */
function collectTimeline(
  layers: ReturnType<typeof parseXflTimeline>['layers'],
  into: SymbolData,
): void {
  for (const layer of layers) {
    for (const kf of layer) {
      if (kf.label) into.labels[kf.label] = { index: kf.index, duration: kf.duration };
      if (kf.script) {
        for (const call of extractCtrlerCalls(kf.script)) {
          into.triggers.push({
            frame: kf.index,
            target: call.target,
            op: call.op,
            args: call.args as TriggerArg[],
          });
        }
        if (scriptResidue(kf.script) !== '') {
          into.rawScripts ??= [];
          into.rawScripts.push({ frame: kf.index, raw: kf.script });
        }
      }
    }
  }
  into.triggers.sort((a, b) => a.frame - b.frame);
}

export function extractAssistant(opts: ExtractAssistantOptions): ExtractAssistantResult {
  const docPath = join(opts.xflDir, 'DOMDocument.xml');
  const root = parseXflTimeline(readFileSync(docPath, 'utf8'));

  // defineAction 表：汇总根时间轴全部帧脚本（kon 在第 0 帧的 defineActions() 函数体内）
  const actions: AssistantPackage['actions'] = {};
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
  };

  return { pkg, validation: validateAssistantPackage(pkg) };
}
