import type {
  ActionDef,
  AssistantPackage,
  FighterPackage,
  MapPackage,
  RuntimeFighterPackage,
  RuntimeFrameAreas,
  SymbolData,
  TriggerArg,
  TriggerDef,
} from './types.js';

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

const ACTION_FIELDS: readonly (keyof ActionDef)[] = [
  'power',
  'hitType',
  'hitx',
  'hity',
  'hurtTime',
  'hurtType',
  'isBreakDef',
];

function isInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n);
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function validateAction(id: string, a: ActionDef, out: ValidationResult): void {
  for (const f of ACTION_FIELDS) {
    if (!(f in a)) out.errors.push(`action "${id}": 缺字段 ${f}`);
  }
  for (const f of ['power', 'hitx', 'hity', 'hurtTime'] as const) {
    if (!isFiniteNumber(a[f])) out.errors.push(`action "${id}": ${f} 必须是有限数值`);
  }
  if (!isInt(a.hitType) || a.hitType < 0) {
    out.errors.push(`action "${id}": hitType 必须是非负整数`);
  }
  if (!isInt(a.hurtType) || a.hurtType < 0) {
    out.errors.push(`action "${id}": hurtType 必须是非负整数`);
  }
  if (typeof a.isBreakDef !== 'boolean') {
    out.errors.push(`action "${id}": isBreakDef 必须是布尔值`);
  }
  if (isInt(a.hitType) && a.hitType > 20) {
    out.warnings.push(`action "${id}": hitType=${a.hitType} 超出原版已见范围(0..11)，确认是否有意`);
  }
}

function validateArg(ctx: string, arg: TriggerArg, out: ValidationResult): void {
  if (arg === null || typeof arg === 'number' || typeof arg === 'string' || typeof arg === 'boolean') {
    return;
  }
  if (Array.isArray(arg)) {
    arg.forEach((v, i) => validateArg(`${ctx}[${i}]`, v, out));
    return;
  }
  if (typeof arg === 'object') {
    const keys = Object.keys(arg);
    if (keys.length === 1 && keys[0] === '$ref') {
      const ref = (arg as { $ref: unknown }).$ref;
      if (typeof ref !== 'string' || ref.length === 0) {
        out.errors.push(`${ctx}: $ref 必须是非空字符串`);
      }
      return;
    }
    for (const [k, v] of Object.entries(arg)) {
      validateArg(`${ctx}.${k}`, v as TriggerArg, out);
    }
    return;
  }
  out.errors.push(`${ctx}: 非法参数类型 ${typeof arg}`);
}

function validateTrigger(symbol: string, t: TriggerDef, out: ValidationResult): void {
  const ctx = `symbol "${symbol}" trigger@frame${t.frame} ${t.op}`;
  if (!isInt(t.frame) || t.frame < 0) out.errors.push(`${ctx}: frame 必须是非负整数`);
  if (!['mc', 'fighter', 'effect', 'assister'].includes(t.target)) {
    out.errors.push(`${ctx}: target 必须是 mc|fighter|effect|assister`);
  }
  if (!/^[a-zA-Z_$][\w$]*$/.test(t.op)) out.errors.push(`${ctx}: op 非法 "${t.op}"`);
  if (!Array.isArray(t.args)) {
    out.errors.push(`${ctx}: args 必须是数组`);
  } else {
    t.args.forEach((a, i) => validateArg(`${ctx}.args[${i}]`, a, out));
  }
}

function validateSymbol(name: string, s: SymbolData, out: ValidationResult): void {
  let lastEnd = -1;
  const sorted = Object.entries(s.labels).sort((a, b) => a[1].index - b[1].index);
  for (const [label, r] of sorted) {
    if (!isInt(r.index) || r.index < 0 || !isInt(r.duration) || r.duration <= 0) {
      out.errors.push(`symbol "${name}" label "${label}": index/duration 非法`);
      continue;
    }
    if (r.index < lastEnd) {
      out.warnings.push(`symbol "${name}" label "${label}": 与前一标签区间重叠`);
    }
    lastEnd = r.index + r.duration;
  }
  for (const t of s.triggers) validateTrigger(name, t, out);
  // 引用完整性：loop/gotoAndPlay 的标签参数必须存在于本符号标签表
  const labelNames = new Set(Object.keys(s.labels));
  for (const t of s.triggers) {
    if ((t.op === 'loop' || t.op === 'gotoAndPlay') && typeof t.args[0] === 'string') {
      if (!labelNames.has(t.args[0])) {
        out.warnings.push(
          `symbol "${name}" trigger@frame${t.frame}: ${t.op}("${t.args[0]}") 引用了不存在的标签`,
        );
      }
    }
  }
}

/**
 * 校验角色烘焙包（DESIGN §7 数据校验器 = 并行转译的验收闸门）。
 * errors 非空即不通过；warnings 是有意识偏离的记录点。
 */
export function validateFighterPackage(pkg: FighterPackage): ValidationResult {
  const out: ValidationResult = { errors: [], warnings: [] };

  if (pkg.schema !== 'bvn/fighter@1') {
    out.errors.push(`schema 必须是 "bvn/fighter@1"，收到 "${pkg.schema}"`);
  }
  if (!pkg.id) out.errors.push('缺 id');
  if (!pkg.source || pkg.source.kind !== 'xfl' || !pkg.source.hash) {
    out.errors.push('缺 source 版本戳（kind/path/hash）');
  }
  if (!Array.isArray(pkg.forms) || pkg.forms.length === 0) {
    out.errors.push('forms 不能为空');
  }

  const seenFrames = new Set<number>();
  for (const form of pkg.forms ?? []) {
    if (!isInt(form.frame) || form.frame < 0) {
      out.errors.push(`form: frame 非法 (${form.frame})`);
      continue;
    }
    if (seenFrames.has(form.frame)) out.errors.push(`form@frame${form.frame}: frame 重复`);
    seenFrames.add(form.frame);

    const actionIds = Object.keys(form.actions ?? {});
    if (actionIds.length === 0) {
      out.warnings.push(`form@frame${form.frame}: 无 defineAction 数据`);
    }
    for (const [aid, a] of Object.entries(form.actions ?? {})) {
      validateAction(`form@frame${form.frame}:${aid}`, a, out);
    }
    if (form.symbol !== null && !(form.symbol in (pkg.symbols ?? {}))) {
      out.errors.push(`form@frame${form.frame}: 主符号 "${form.symbol}" 不在 symbols 表中`);
    }
  }

  for (const [name, sym] of Object.entries(pkg.symbols ?? {})) {
    validateSymbol(name, sym, out);
  }

  return out;
}

/** 校验辅助烘焙包。 */
export function validateAssistantPackage(pkg: AssistantPackage): ValidationResult {
  const out: ValidationResult = { errors: [], warnings: [] };

  if (pkg.schema !== 'bvn/assistant@1') {
    out.errors.push(`schema 必须是 "bvn/assistant@1"，收到 "${pkg.schema}"`);
  }
  if (!pkg.id) out.errors.push('缺 id');
  if (!pkg.source || pkg.source.kind !== 'xfl' || !pkg.source.hash) {
    out.errors.push('缺 source 版本戳（kind/path/hash）');
  }

  for (const [aid, a] of Object.entries(pkg.actions ?? {})) {
    validateAction(aid, a, out);
  }
  if (pkg.timeline) {
    validateSymbol('(root)', pkg.timeline, out);
  } else {
    out.errors.push('缺根时间轴 timeline');
  }
  for (const [name, sym] of Object.entries(pkg.symbols ?? {})) {
    validateSymbol(name, sym, out);
  }

  return out;
}

/* ---------------------------------------------------------------------
 * 运行时导出包校验（bvn/fighter-runtime@1 / bvn/map@1）
 * ------------------------------------------------------------------- */

/** 非法区域名：Flash 自动实例名（dump 侧已滤，防御性保留） */
const INSTANCE_NAME_RE = /^instance\d+/;

function validateAreaRect(ctx: string, a: { name: unknown; x: unknown; y: unknown; w: unknown; h: unknown }, out: ValidationResult): void {
  if (typeof a.name !== 'string' || a.name.length === 0 || INSTANCE_NAME_RE.test(a.name)) {
    out.errors.push(`${ctx}: 区域名非法 "${a.name}"`);
  }
  for (const f of ['x', 'y', 'w', 'h'] as const) {
    if (!isFiniteNumber(a[f])) out.errors.push(`${ctx}: ${f} 必须是有限数值`);
  }
  if (isFiniteNumber(a.w) && a.w < 0) out.warnings.push(`${ctx}: w<0`);
  if (isFiniteNumber(a.h) && a.h < 0) out.warnings.push(`${ctx}: h<0`);
}

function validateRuntimeForm(ctx: string, f: RuntimeFighterPackage['forms'][number], out: ValidationResult): void {
  if (!isInt(f.rootFrame) || f.rootFrame < 1) out.errors.push(`${ctx}: rootFrame 必须是正整数`);
  if (!isInt(f.totalFrames) || f.totalFrames < 0) out.errors.push(`${ctx}: totalFrames 必须是非负整数`);
  if (
    f.totalFrames === 0 &&
    ((f.frames ?? []).length > 0 || Object.keys(f.labels ?? {}).length > 0)
  ) {
    out.errors.push(`${ctx}: totalFrames=0（占位形态）时不得含几何数据`);
  }
  if (!Array.isArray(f.actionsRegistered)) out.errors.push(`${ctx}: actionsRegistered 必须是数组`);
  if (!Array.isArray(f.frames)) out.errors.push(`${ctx}: frames 必须是数组`);
  else {
    let lastFrame = 0;
    for (const fr of f.frames as RuntimeFrameAreas[]) {
      if (!isInt(fr.frame) || fr.frame < 1 || fr.frame > f.totalFrames) {
        out.errors.push(`${ctx}: 帧号越界 ${fr.frame} (1..${f.totalFrames})`);
        continue;
      }
      if (fr.frame <= lastFrame) out.errors.push(`${ctx}: frames 未按帧号升序 @${fr.frame}`);
      lastFrame = fr.frame;
      if (!Array.isArray(fr.areas)) out.errors.push(`${ctx}: areas 必须是数组`);
      else fr.areas.forEach((a, i) => validateAreaRect(`${ctx}@frame${fr.frame}[${i}]`, a, out));
    }
  }
  const sorted = Object.entries(f.labels ?? {}).sort((a, b) => a[1].index - b[1].index);
  for (const [label, r] of sorted) {
    if (!isInt(r.index) || r.index < 0 || !isInt(r.duration) || r.duration <= 0) {
      out.errors.push(`${ctx}: label "${label}" index/duration 非法`);
      continue;
    }
    if (r.index + r.duration > f.totalFrames) {
      out.warnings.push(`${ctx}: label "${label}" 区间超出 totalFrames`);
    }
  }
  if (f.aiRanges) f.aiRanges.forEach((a, i) => validateAreaRect(`${ctx}.aiRanges[${i}]`, a, out));
}

/** 校验运行时角色/辅助烘焙包。 */
export function validateRuntimeFighterPackage(pkg: RuntimeFighterPackage): ValidationResult {
  const out: ValidationResult = { errors: [], warnings: [] };

  if (pkg.schema !== 'bvn/fighter-runtime@1') {
    out.errors.push(`schema 必须是 "bvn/fighter-runtime@1"，收到 "${pkg.schema}"`);
  }
  if (!pkg.id) out.errors.push('缺 id');
  if (!pkg.source || pkg.source.kind !== 'runtime-dump' || !pkg.source.hash) {
    out.errors.push('缺 source 版本戳（kind/path/hash）');
  }
  if (pkg.kind !== 'fighter' && pkg.kind !== 'assister') {
    out.errors.push(`kind 必须是 fighter|assister，收到 "${pkg.kind}"`);
  }
  if (!Array.isArray(pkg.forms) || pkg.forms.length === 0) {
    out.errors.push('forms 不能为空');
  } else {
    if (pkg.kind === 'assister' && pkg.forms.length > 1) {
      out.errors.push('assister 是单形态包');
    }
    pkg.forms.forEach((f, i) => validateRuntimeForm(`form[${i}]`, f, out));
  }

  for (const [aid, a] of Object.entries(pkg.actions ?? {})) {
    validateAction(`action "${aid}"`, a, out);
  }
  if (Object.keys(pkg.actions ?? {}).length === 0) {
    out.warnings.push('无 defineAction 数据（对照 XFL 静态提取确认覆盖）');
  }
  if (!Array.isArray(pkg.actionOrder)) out.errors.push('actionOrder 必须是数组');
  if (!Array.isArray(pkg.bishaFaces)) out.errors.push('bishaFaces 必须是数组');

  return out;
}

/** 校验地图烘焙包。 */
export function validateMapPackage(pkg: MapPackage): ValidationResult {
  const out: ValidationResult = { errors: [], warnings: [] };

  if (pkg.schema !== 'bvn/map@1') {
    out.errors.push(`schema 必须是 "bvn/map@1"，收到 "${pkg.schema}"`);
  }
  if (!pkg.id) out.errors.push('缺 id');
  if (!pkg.name) out.errors.push('缺 name');
  if (!pkg.source || pkg.source.kind !== 'runtime-dump' || !pkg.source.hash) {
    out.errors.push('缺 source 版本戳（kind/path/hash）');
  }
  for (const f of ['left', 'right', 'bottom', 'playerBottom'] as const) {
    if (!isFiniteNumber(pkg[f])) out.errors.push(`${f} 必须是有限数值`);
  }
  if (isFiniteNumber(pkg.left) && isFiniteNumber(pkg.right) && pkg.right <= pkg.left) {
    out.errors.push('right 必须大于 left');
  }
  if (isFiniteNumber(pkg.playerBottom) && isFiniteNumber(pkg.bottom) && pkg.playerBottom > pkg.bottom) {
    out.warnings.push('playerBottom 低于 bottom（引擎语义：越小越低）');
  }
  if (!Array.isArray(pkg.floors)) out.errors.push('floors 必须是数组');
  else {
    pkg.floors.forEach((fl, i) => {
      if (!isFiniteNumber(fl.xFrom) || !isFiniteNumber(fl.xTo) || !isFiniteNumber(fl.y)) {
        out.errors.push(`floors[${i}]: 非有限数值`);
      }
      if (isFiniteNumber(fl.xFrom) && isFiniteNumber(fl.xTo) && fl.xTo < fl.xFrom) {
        out.warnings.push(`floors[${i}]: xTo < xFrom`);
      }
    });
  }
  return out;
}
