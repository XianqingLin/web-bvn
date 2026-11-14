/**
 * 角色 XFL → FighterPackage（bvn/fighter@1）离线提取。
 *
 * 本 pass 覆盖 module-map §6.2（根时间轴脚本：defineAction 表/数值/声音绑定）
 * 与 §6.3 的时间轴部分（帧标签 + 帧触发），不含几何判定区——
 * 判定区走运行时导出（方案 A），两者在 JSON 中合流。
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import {
  validateFighterPackage,
  type CondTriggerDef,
  type FighterPackage,
  type FormData,
  type SoundDefines,
  type SymbolData,
  type TriggerArg,
  type ValidationResult,
} from '@bvn/data';
import {
  extractDefineActions,
  extractNamedDefine,
  extractStatAssignments,
  parseFrameStatements,
  scriptResidue,
  type AsArg,
} from './asargs.js';
import { frameAt, parseXflTimeline } from './xfl.js';

export interface ExtractFighterOptions {
  /** XFL 工程目录（含 DOMDocument.xml 与 LIBRARY/） */
  xflDir: string;
  /** SWF 基名（如 "ichigo"），用于 id 与 fighter.xml 匹配 */
  id: string;
  /** 原版 fighter.xml 路径（可选）：提供时回填各形态的 fighterId */
  fighterXmlPath?: string;
}

export interface ExtractFighterResult {
  pkg: FighterPackage;
  validation: ValidationResult;
}

/** fighter.xml → (swf 基名, startFrame) → fighterId */
export function parseFighterXml(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  const re =
    /<fighter\s+id="([^"]+)"[^>]*>(?:(?!<\/fighter>).)*?<file\s+url="assets\/fighter\/([^"]+)\.swf"\s+startFrame="(\d+)"/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    map.set(`${m[2]}#${m[3]}`, m[1]!);
  }
  return map;
}

function refName(arg: AsArg | undefined): string | undefined {
  if (arg === undefined) return undefined;
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'object' && arg !== null && '$ref' in arg) return String(arg.$ref);
  return undefined;
}

const STAT_KEYS = ['speed', 'jumpPower', 'heavy', 'defenseType'] as const;

function buildSounds(defines: { op: string; args: AsArg[] }[]): SoundDefines {
  const sounds: SoundDefines = {};
  for (const d of defines) {
    switch (d.op) {
      case 'defineBishaFace': {
        const key = refName(d.args[0]);
        const val = refName(d.args[1]);
        if (key && val) {
          sounds.bishaFaces ??= {};
          sounds.bishaFaces[key] = val;
        }
        break;
      }
      case 'defineHurtSound':
        sounds.hurtSounds = d.args.map(refName).filter((v): v is string => v !== undefined);
        break;
      case 'defineHurtFlySound': {
        const v = refName(d.args[0]);
        if (v) sounds.hurtFlySound = v;
        break;
      }
      case 'defineDieSound': {
        const v = refName(d.args[0]);
        if (v) sounds.dieSound = v;
        break;
      }
    }
  }
  return sounds;
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

export function extractFighter(opts: ExtractFighterOptions): ExtractFighterResult {
  const docPath = join(opts.xflDir, 'DOMDocument.xml');
  const docXml = readFileSync(docPath, 'utf8');
  const root = parseXflTimeline(docXml);

  const fighterIds = opts.fighterXmlPath
    ? parseFighterXml(readFileSync(opts.fighterXmlPath, 'utf8'))
    : new Map<string, string>();

  // 根时间轴：帧号 → 脚本（任意图层）；帧号 → 主 mc 实例的符号名
  const frameScripts = new Map<number, string>();
  const frameSymbols = new Map<number, string>();
  for (const layer of root.layers) {
    for (const kf of layer) {
      if (kf.script) frameScripts.set(kf.index, kf.script);
      const mc = kf.symbolInstances.find((si) => si.name === 'mc');
      if (mc) {
        for (let i = kf.index; i < kf.index + kf.duration; i++) {
          frameSymbols.set(i, mc.libraryItemName);
        }
      }
    }
  }

  // 形态：根时间轴第 1 帧起，每帧脚本 = 一个形态定义（第 0 帧是 initFighter）
  const forms: FormData[] = [];
  for (const [frame, script] of [...frameScripts.entries()].sort((a, b) => a[0] - b[0])) {
    if (frame === 0) continue;

    const actions: FormData['actions'] = {};
    for (const da of extractDefineActions(script)) {
      actions[da.id] = {
        power: Number(da.data['power'] ?? 0),
        hitType: Number(da.data['hitType'] ?? 0),
        hitx: Number(da.data['hitx'] ?? 0),
        hity: Number(da.data['hity'] ?? 0),
        hurtTime: Number(da.data['hurtTime'] ?? 0),
        hurtType: Number(da.data['hurtType'] ?? 0),
        isBreakDef: da.data['isBreakDef'] === true,
        // 抓取吸附系 defineAction 显式 isApplyG=false；缺省 true（原版 HitVO）
        isApplyG: da.data['isApplyG'] !== false,
      };
    }

    const statAssigns = extractStatAssignments(script);
    const stats: FormData['stats'] = {};
    for (const k of STAT_KEYS) {
      const v = statAssigns[k];
      if (v !== undefined) stats[k] = v;
    }

    const form: FormData = {
      frame,
      symbol: frameSymbols.get(frame) ?? null,
      stats,
      actions,
      sounds: buildSounds(extractNamedDefine(script)),
    };
    // 含未识别语句（形态切换状态变量等自定义逻辑）→ 保留原文
    if (scriptResidue(script) !== '') form.rawScript = script;
    const fid = fighterIds.get(`${opts.id}#${frame}`);
    if (fid) form.fighterId = fid;
    forms.push(form);
  }

  // 符号时间轴：帧标签 + 帧触发（语句级解析：简单调用 + if/else 条件触发）
  const libDir = join(opts.xflDir, 'LIBRARY');
  const symbolFiles = listXmlFiles(libDir);
  const symbols: Record<string, SymbolData> = {};
  for (const file of symbolFiles) {
    const key = relative(libDir, file).replace(/\\/g, '/').replace(/\.xml$/, '');
    const tl = parseXflTimeline(readFileSync(file, 'utf8'));
    const data: SymbolData = { labels: {}, triggers: [] };
    for (const layer of tl.layers) {
      for (const kf of layer) {
        if (kf.label) data.labels[kf.label] = { index: kf.index, duration: kf.duration };
        if (kf.script) {
          const residues: string[] = [];
          for (const st of parseFrameStatements(kf.script)) {
            if (st.kind === 'call') {
              data.triggers.push({
                frame: kf.index,
                target: st.call.target,
                op: st.call.op,
                args: st.call.args as TriggerArg[],
              });
            } else if (st.kind === 'cond') {
              data.condTriggers ??= [];
              const ct: CondTriggerDef = {
                frame: kf.index,
                cond: st.stmt.cond as unknown as CondTriggerDef['cond'],
              };
              if (st.stmt.then !== undefined) {
                ct.then = st.stmt.then.map((c) => ({
                  target: c.target,
                  op: c.op,
                  args: c.args as TriggerArg[],
                }));
              }
              if (st.stmt.else !== undefined) {
                ct.else = st.stmt.else.map((c) => ({
                  target: c.target,
                  op: c.op,
                  args: c.args as TriggerArg[],
                }));
              }
              data.condTriggers.push(ct);
              if (st.residue !== null) residues.push(st.residue);
            } else {
              residues.push(st.text);
            }
          }
          if (residues.map((r) => r.replace(/\s+/g, '')).join('').trim() !== '') {
            data.rawScripts ??= [];
            data.rawScripts.push({ frame: kf.index, raw: kf.script });
          }
        }
      }
    }
    data.triggers.sort((a, b) => a.frame - b.frame);
    data.condTriggers?.sort((a, b) => a.frame - b.frame);
    if (
      Object.keys(data.labels).length > 0 ||
      data.triggers.length > 0 ||
      (data.rawScripts !== undefined && data.rawScripts.length > 0)
    ) {
      symbols[key] = data;
    }
  }

  const pkg: FighterPackage = {
    schema: 'bvn/fighter@1',
    id: opts.id,
    source: {
      kind: 'xfl',
      path: basename(opts.xflDir),
      hash: hashSources([docPath, ...symbolFiles]),
    },
    forms,
    symbols,
  };

  return { pkg, validation: validateFighterPackage(pkg) };
}
