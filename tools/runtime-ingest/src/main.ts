/**
 * 运行时 dump → packages/data/baked 转译器（切片 2 收尾）。
 *
 * 输入：tools/bridge dump 产物（raw JSON，来自原版 AIR 运行时）
 *   char_fighter_<id>.json / char_assister_<id>.json / map_<id>.json / manifest.json
 *
 * 输出：
 *   packages/data/baked/fighters-runtime/<id>.json   （bvn/fighter-runtime@1，紧凑序列化）
 *   packages/data/baked/assistants-runtime/<id>.json （同 schema，kind=assister）
 *   packages/data/baked/maps/<id>.json               （bvn/map@1，pretty）
 *   packages/data/baked/runtime-ingest-report.json   （交叉验证报告：与 XFL 静态提取的动作漂移）
 *
 * 用法：node dist/main.js [dumpDir]
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ActionDef,
  AreaRect,
  LabelRange,
  MapPackage,
  RuntimeFighterPackage,
  RuntimeFormGeometry,
  RuntimeFrameAreas,
} from '@bvn/data';
import {
  validateAssistantPackage,
  validateFighterPackage,
  validateMapPackage,
  validateRuntimeFighterPackage,
} from '@bvn/data';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BAKED = resolve(ROOT, 'packages/data/baked');
const DUMP_DIR = resolve(
  ROOT,
  process.argv[2] ?? 'OpenBleachVsNaruto/_release/work/dump-json',
);

interface DumpChar {
  kind: string;
  id: string;
  name: string;
  fileUrl: string;
  comicType: number;
  startFrame: number;
  bgm: string;
  rootTotalFrames: number;
  forms: DumpCharForm[];
  actions: Record<string, Record<string, unknown>>;
  actionOrder: string[];
  bishaFaces: string[];
}

interface DumpCharForm {
  rootFrame: number;
  actionsRegistered: string[];
  rootLabel?: string;
  rootFrameLabel?: string;
  rootMovedTo?: number;
  err?: string;
  inner: {
    totalFrames: number;
    frames: {
      frame: number;
      label?: string;
      sceneLabel?: string;
      areas: { name: string; x: number; y: number; w: number; h: number }[];
      err?: string;
      movedTo?: number;
    }[];
    aiRanges?: { frame2?: { name: string; x: number; y: number; w: number; h: number }[]; err?: string };
  } | null;
}

interface DumpMap {
  kind: string;
  id: string;
  name: string;
  fileUrl: string;
  bgm: string;
  gameSize: { x: number; y: number };
  bottomOffset: number;
  left: number;
  right: number;
  bottom: number;
  playerBottom: number;
  mapBottomDistance: number;
  p1pos: { x: number; y: number } | null;
  p2pos: { x: number; y: number } | null;
  floors?: { name: string; xFrom: number; xTo: number; y: number }[];
  mapSize?: { w: number; h: number };
}

const ACTION_FIELDS = ['power', 'hitType', 'hitx', 'hity', 'hurtTime', 'hurtType', 'isBreakDef', 'isApplyG'] as const;

const r2 = (v: number): number => Math.round(v * 100) / 100;

function sha1(data: string | Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/**
 * dump 原文键序不确定（AS3 for-in 顺序随环境波动），
 * source.hash 必须对 canonical（排序键）形式计算，
 * 否则每次重 dump 全部 baked 的 hash 字段都会漂移。
 */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * 深度排序记录型对象的键（数组保持顺序——数组是语义顺序：
 * forms 帧序 / frames 帧号升序 / actionOrder 注册序 / floors 显示序）。
 * dump 原文的 for-in 键序随环境波动，不排序则每次重 dump 输出文件全漂移。
 */
function sortRecordKeys<T>(v: T): T {
  if (Array.isArray(v)) return v.map(sortRecordKeys) as unknown as T;
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortRecordKeys((v as Record<string, unknown>)[k]);
    }
    return out as unknown as T;
  }
  return v;
}

function serializePkg(pkg: unknown, indent?: number): string {
  return JSON.stringify(sortRecordKeys(pkg), null, indent);
}

function readDump<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(DUMP_DIR, file), 'utf8')) as T;
}

/** 标签区间推导：带标签帧（1 起）→ [index(0 起), duration（至下一标签前）]。 */
function deriveLabels(
  labeledFrames: { frame: number; label: string }[],
  totalFrames: number,
): Record<string, LabelRange> {
  const out: Record<string, LabelRange> = {};
  for (let i = 0; i < labeledFrames.length; i++) {
    const { frame, label } = labeledFrames[i]!;
    const next = labeledFrames[i + 1]?.frame ?? totalFrames + 1;
    const duration = next - frame;
    if (label in out) {
      // 同名标签重复（原版时间轴允许）：保留首个，后续记入报告
      continue;
    }
    out[label] = { index: frame - 1, duration };
  }
  return out;
}

function normalizeAction(raw: Record<string, unknown>): { def: ActionDef; extraKeys: string[] } {
  const def: ActionDef = {
    power: Number(raw.power ?? 0),
    hitType: Number(raw.hitType ?? 0),
    hitx: Number(raw.hitx ?? 0),
    hity: Number(raw.hity ?? 0),
    hurtTime: Number(raw.hurtTime ?? 0),
    hurtType: Number(raw.hurtType ?? 0),
    isBreakDef: Boolean(raw.isBreakDef),
    isApplyG: raw.isApplyG !== false,
  };
  const extraKeys = Object.keys(raw).filter((k) => !ACTION_FIELDS.includes(k as never));
  return { def, extraKeys };
}

function convertChar(dump: DumpChar, file: string): RuntimeFighterPackage {
  const kind = dump.kind === 'assister' ? 'assister' : 'fighter';
  const forms: RuntimeFormGeometry[] = [];
  for (const form of dump.forms) {
    const inner = form.inner;
    if (!inner) {
      forms.push({
        rootFrame: form.rootFrame,
        actionsRegistered: form.actionsRegistered ?? [],
        totalFrames: 0,
        labels: {},
        frames: [],
        ...(form.err !== undefined ? { err: form.err } : {}),
      });
      continue;
    }
    const labeledFrames: { frame: number; label: string }[] = [];
    const areaFrames: RuntimeFrameAreas[] = [];
    for (const fr of inner.frames) {
      if (fr.label) labeledFrames.push({ frame: fr.frame, label: fr.label });
      if (fr.areas.length > 0) {
        const areas: AreaRect[] = fr.areas.map((a) => ({
          name: a.name,
          x: r2(a.x),
          y: r2(a.y),
          w: r2(a.w),
          h: r2(a.h),
        }));
        areaFrames.push({
          frame: fr.frame,
          ...(fr.label !== undefined ? { label: fr.label } : {}),
          areas,
          ...(fr.err !== undefined ? { err: fr.err } : {}),
        });
      }
    }
    const geo: RuntimeFormGeometry = {
      rootFrame: form.rootFrame,
      actionsRegistered: form.actionsRegistered ?? [],
      totalFrames: inner.totalFrames,
      labels: deriveLabels(labeledFrames, inner.totalFrames),
      frames: areaFrames,
      ...(form.err !== undefined ? { err: form.err } : {}),
    };
    if (inner.aiRanges?.frame2) {
      geo.aiRanges = inner.aiRanges.frame2.map((a) => ({
        name: a.name,
        x: r2(a.x),
        y: r2(a.y),
        w: r2(a.w),
        h: r2(a.h),
      }));
    }
    if (inner.aiRanges?.err) geo.aiRangesErr = inner.aiRanges.err;
    forms.push(geo);
  }

  const actions: Record<string, ActionDef> = {};
  for (const [aid, vo] of Object.entries(dump.actions ?? {})) {
    actions[aid] = normalizeAction(vo).def;
  }

  return {
    schema: 'bvn/fighter-runtime@1',
    id: dump.id,
    source: { kind: 'runtime-dump', path: `dump-json/${file}`, hash: sha1(canonicalJson(dump)) },
    kind,
    rootTotalFrames: dump.rootTotalFrames,
    forms,
    actions,
    actionOrder: dump.actionOrder ?? [],
    bishaFaces: dump.bishaFaces ?? [],
  };
}

function convertMap(dump: DumpMap, file: string): MapPackage {
  return {
    schema: 'bvn/map@1',
    id: dump.id,
    name: dump.name,
    source: { kind: 'runtime-dump', path: `dump-json/${file}`, hash: sha1(canonicalJson(dump)) },
    bgm: dump.bgm ?? '',
    fileUrl: dump.fileUrl ?? '',
    gameSize: { x: dump.gameSize.x, y: dump.gameSize.y },
    left: dump.left,
    right: dump.right,
    bottom: dump.bottom,
    playerBottom: dump.playerBottom,
    // 原版 MapMain.initlize 的视觉层整体下移量（= gameSize.y - 原始 line_bottom.y），
    // 渲染端装配地图视觉层用（切片 13-A2 补录）
    bottomOffset: dump.bottomOffset,
    p1pos: dump.p1pos ? { x: r2(dump.p1pos.x), y: r2(dump.p1pos.y) } : null,
    p2pos: dump.p2pos ? { x: r2(dump.p2pos.x), y: r2(dump.p2pos.y) } : null,
    floors: (dump.floors ?? []).map((f) => ({
      name: f.name,
      xFrom: r2(f.xFrom),
      xTo: r2(f.xTo),
      y: r2(f.y),
    })),
    ...(dump.mapSize ? { mapSize: dump.mapSize } : {}),
  };
}

/** 与 XFL 静态提取的交叉验证：动作集合 + 字段值漂移。 */
function crossCheckXfl(
  pkg: RuntimeFighterPackage,
  xflActions: Record<string, ActionDef> | undefined,
): Record<string, unknown> | null {
  if (!xflActions) return null;
  const rtIds = new Set(Object.keys(pkg.actions));
  const xflIds = new Set(Object.keys(xflActions));
  const fieldDrift: Record<string, string[]> = {};
  for (const aid of rtIds) {
    if (!xflIds.has(aid)) continue;
    const a = pkg.actions[aid]!;
    const b = xflActions[aid]!;
    const drift = ACTION_FIELDS.filter((f) => a[f] !== b[f]);
    if (drift.length > 0) fieldDrift[aid] = [...drift];
  }
  return {
    onlyInRuntime: [...rtIds].filter((x) => !xflIds.has(x)),
    onlyInXfl: [...xflIds].filter((x) => !rtIds.has(x)),
    fieldDrift,
  };
}

function main(): void {
  if (!existsSync(DUMP_DIR)) {
    console.error(`[ingest] dump 目录不存在: ${DUMP_DIR}`);
    process.exit(1);
  }
  const files = readdirSync(DUMP_DIR).filter((f) => f.endsWith('.json') && f !== 'manifest.json');
  const charFiles = files.filter((f) => f.startsWith('char_'));
  const mapFiles = files.filter((f) => f.startsWith('map_'));

  // XFL 静态提取数据（交叉验证基准）
  const xflFighters: Record<string, Record<string, ActionDef>> = {};
  const xflAssistants: Record<string, Record<string, ActionDef>> = {};
  const fightersDir = resolve(BAKED, 'fighters');
  const assistantsDir = resolve(BAKED, 'assistants');
  for (const f of existsSync(fightersDir) ? readdirSync(fightersDir) : []) {
    const pkg = JSON.parse(readFileSync(resolve(fightersDir, f), 'utf8'));
    xflFighters[pkg.id] = Object.fromEntries(
      (pkg.forms ?? []).flatMap((fm: { actions: Record<string, ActionDef> }) =>
        Object.entries(fm.actions).map(([k, v]) => [k, v] as const),
      ),
    );
  }
  for (const f of existsSync(assistantsDir) ? readdirSync(assistantsDir) : []) {
    const pkg = JSON.parse(readFileSync(resolve(assistantsDir, f), 'utf8'));
    xflAssistants[pkg.id] = pkg.actions ?? {};
  }

  const report: {
    generatedAt: string;
    dumpDir: string;
    counts: { fighters: number; assistants: number; maps: number; areaFrames: number };
    validation: { id: string; errors: string[]; warnings: string[] }[];
    xflDrift: Record<string, unknown>;
    extraActionKeys: Record<string, string[]>;
    notes: string[];
  } = {
    generatedAt: new Date().toISOString(),
    dumpDir: DUMP_DIR,
    counts: { fighters: 0, assistants: 0, maps: 0, areaFrames: 0 },
    validation: [],
    xflDrift: {},
    extraActionKeys: {},
    notes: [],
  };

  const outDirs = [
    resolve(BAKED, 'fighters-runtime'),
    resolve(BAKED, 'assistants-runtime'),
    resolve(BAKED, 'maps'),
  ];
  for (const d of outDirs) mkdirSync(d, { recursive: true });

  let failures = 0;

  for (const file of charFiles) {
    const data = readDump<DumpChar>(file);
    const pkg = convertChar(data, file);
    const res = validateRuntimeFighterPackage(pkg);
    report.validation.push({ id: pkg.id, errors: res.errors, warnings: res.warnings });
    if (res.errors.length > 0) failures++;
    const dir = pkg.kind === 'assister' ? 'assistants-runtime' : 'fighters-runtime';
    writeFileSync(
      resolve(BAKED, dir, `${pkg.id}.json`),
      serializePkg(pkg),
      'utf8',
    );
    if (pkg.kind === 'assister') {
      report.counts.assistants++;
    } else {
      report.counts.fighters++;
    }
    report.counts.areaFrames += pkg.forms.reduce((n, f) => n + f.frames.length, 0);

    const xfl =
      pkg.kind === 'assister'
        ? xflAssistants[pkg.id]
        : xflFighters[pkg.id];
    const drift = crossCheckXfl(pkg, xfl);
    if (drift) report.xflDrift[`${pkg.kind}:${pkg.id}`] = drift;

    // extra action keys 汇总（进报告，不进包）
    for (const [aid, vo] of Object.entries(data.actions ?? {})) {
      const extras = Object.keys(vo).filter((k) => !ACTION_FIELDS.includes(k as never));
      if (extras.length > 0) {
        report.extraActionKeys[`${pkg.kind}:${pkg.id}:${aid}`] = extras;
      }
    }
    if (data.forms.some((f) => f.err)) {
      report.notes.push(`${pkg.kind}:${pkg.id}: 部分 form 帧脚本异常（见包内 err 字段）`);
    }
  }

  for (const file of mapFiles) {
    const data = readDump<DumpMap>(file);
    const pkg = convertMap(data, file);
    const res = validateMapPackage(pkg);
    report.validation.push({ id: pkg.id, errors: res.errors, warnings: res.warnings });
    if (res.errors.length > 0) failures++;
    writeFileSync(resolve(BAKED, 'maps', `${pkg.id}.json`), serializePkg(pkg, 2), 'utf8');
    report.counts.maps++;
  }

  // XFL 包自身校验（回归确认：本工具跑过不破坏既有闸门）
  for (const f of existsSync(fightersDir) ? readdirSync(fightersDir) : []) {
    const pkg = JSON.parse(readFileSync(resolve(fightersDir, f), 'utf8'));
    const res = validateFighterPackage(pkg);
    if (res.errors.length > 0) failures++;
    report.validation.push({ id: `xfl-fighter:${pkg.id}`, errors: res.errors, warnings: res.warnings });
  }
  for (const f of existsSync(assistantsDir) ? readdirSync(assistantsDir) : []) {
    const pkg = JSON.parse(readFileSync(resolve(assistantsDir, f), 'utf8'));
    const res = validateAssistantPackage(pkg);
    if (res.errors.length > 0) failures++;
    report.validation.push({ id: `xfl-assistant:${pkg.id}`, errors: res.errors, warnings: res.warnings });
  }

  writeFileSync(
    resolve(BAKED, 'runtime-ingest-report.json'),
    JSON.stringify(report, null, 2),
    'utf8',
  );

  console.log(`[ingest] fighters=${report.counts.fighters} assistants=${report.counts.assistants} maps=${report.counts.maps} areaFrames=${report.counts.areaFrames}`);
  const withErr = report.validation.filter((v) => v.errors.length > 0);
  if (withErr.length > 0 || failures > 0) {
    console.error(`[ingest] ❌ 校验失败 ${failures} 项:`);
    for (const v of withErr.slice(0, 20)) console.error(`  ${v.id}: ${v.errors.slice(0, 5).join('; ')}`);
    process.exit(1);
  }
  const warnCount = report.validation.reduce((n, v) => n + v.warnings.length, 0);
  console.log(`[ingest] ✅ 全部通过校验（warnings ${warnCount} 条，见 runtime-ingest-report.json）`);
}

main();
