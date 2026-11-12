import type {
  ActionDef,
  AssistantPackage,
  FighterPackage,
  LoopTriggerDef,
  FirePackage,
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

/** 触发目标白名单（切片 12 + fighterTarget：辅助语境 owner 的当前目标）。 */
const TRIGGER_TARGETS = ['mc', 'fighter', 'effect', 'assister', 'fighterTarget'];

function validateTrigger(symbol: string, t: TriggerDef, out: ValidationResult): void {
  const ctx = `symbol "${symbol}" trigger@frame${t.frame} ${t.op}`;
  if (!isInt(t.frame) || t.frame < 0) out.errors.push(`${ctx}: frame 必须是非负整数`);
  if (!TRIGGER_TARGETS.includes(t.target)) {
    out.errors.push(`${ctx}: target 必须是 ${TRIGGER_TARGETS.join('|')}`);
  }
  if (!/^[a-zA-Z_$][\w$]*$/.test(t.op)) out.errors.push(`${ctx}: op 非法 "${t.op}"`);
  if (!Array.isArray(t.args)) {
    out.errors.push(`${ctx}: args 必须是数组`);
  } else {
    t.args.forEach((a, i) => validateArg(`${ctx}.args[${i}]`, a, out));
  }
}

/** 条件查询 op 白名单（切片 11；扩充 = 契约 + core 求值器 + 本校验器同 commit）。 */
const CONDITION_OPS = new Set(['justHit', 'targetInRange', 'getTargetState', 'getSelf', 'getTargetSP']);
const CMP_OPS = new Set(['==', '!=', '<', '>', '<=', '>=']);

function validateCall(symbol: string, where: string, c: { target: string; op: string; args: unknown[] }, out: ValidationResult): void {
  const ctx = `symbol "${symbol}" ${where} ${c.op}`;
  if (!TRIGGER_TARGETS.includes(c.target)) {
    out.errors.push(`${ctx}: target 必须是 ${TRIGGER_TARGETS.join('|')}`);
  }
  if (!/^[a-zA-Z_$][\w$]*$/.test(c.op)) out.errors.push(`${ctx}: op 非法 "${c.op}"`);
  if (!Array.isArray(c.args)) {
    out.errors.push(`${ctx}: args 必须是数组`);
  } else {
    c.args.forEach((a, i) => validateArg(`${ctx}.args[${i}]`, a as TriggerArg, out));
  }
}

function validateCondTrigger(symbol: string, t: { frame: unknown; cond: { target: string; op: string; args: unknown[]; negate?: unknown; path?: unknown; cmp?: unknown }; then?: unknown[]; else?: unknown[] }, out: ValidationResult): void {
  const ctx = `symbol "${symbol}" condTrigger@frame${String(t.frame)}`;
  if (!isInt(t.frame as number) || (t.frame as number) < 0) {
    out.errors.push(`${ctx}: frame 必须是非负整数`);
  }
  const cond = t.cond;
  if (!cond || typeof cond !== 'object') {
    out.errors.push(`${ctx}: 缺少 cond`);
    return;
  }
  validateCall(symbol, 'cond', cond, out);
  if (!CONDITION_OPS.has(cond.op)) {
    out.errors.push(`${ctx}: 条件查询 op 不在词表 "${cond.op}"`);
  }
  if (cond.negate !== undefined && typeof cond.negate !== 'boolean') {
    out.errors.push(`${ctx}: negate 必须是布尔`);
  }
  if (cond.path !== undefined) {
    if (
      !Array.isArray(cond.path) ||
      cond.path.length === 0 ||
      !cond.path.every((p) => typeof p === 'string')
    ) {
      out.errors.push(`${ctx}: path 必须是非空字符串数组`);
    }
  }
  if (cond.cmp !== undefined) {
    const cmp = cond.cmp as { op?: unknown; value?: unknown };
    if (!cmp.op || !CMP_OPS.has(String(cmp.op))) {
      out.errors.push(`${ctx}: cmp.op 非法 "${String(cmp.op)}"`);
    }
    if (typeof cmp.value !== 'number' && typeof cmp.value !== 'boolean') {
      out.errors.push(`${ctx}: cmp.value 必须是数值/布尔`);
    }
  }
  for (const [key, list] of [['then', t.then], ['else', t.else]] as const) {
    if (list !== undefined) {
      if (!Array.isArray(list)) {
        out.errors.push(`${ctx}: ${key} 必须是数组`);
        continue;
      }
      list.forEach((c, i) =>
        validateCall(symbol, `${key}[${i}]`, c as { target: string; op: string; args: unknown[] }, out),
      );
    }
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
  for (const t of s.condTriggers ?? []) validateCondTrigger(name, t, out);
  for (const t of s.loopTriggers ?? []) validateLoopTrigger(name, t, out);
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
  if (pkg.buffEffects !== undefined) {
    const be = pkg.buffEffects;
    for (const key of ['attrResistance', 'phyLifesteal'] as const) {
      const v = be[key];
      if (v !== undefined && (!isFiniteNumber(v) || v < 0 || v > 1)) {
        out.errors.push(`buffEffects.${key} 必须是 [0,1] 数值`);
      }
    }
  }

  return out;
}

/** 校验循环触发（切片 12）。 */
function validateLoopTrigger(name: string, t: LoopTriggerDef, out: ValidationResult): void {
  const ctx = `symbol "${name}" loopTrigger@frame${t.frame}`;
  if (!isInt(t.frame) || t.frame < 0) out.errors.push(`${ctx}: frame 必须是非负整数`);
  if (t.untilFrame !== null && (!isInt(t.untilFrame) || t.untilFrame <= t.frame)) {
    out.errors.push(`${ctx}: untilFrame 必须为 null 或大于 frame`);
  }
  if (t.cond !== null) {
    if (t.cond.kind === 'checkHitOwner') {
      if (typeof t.cond.name !== 'string' || t.cond.name === '') {
        out.errors.push(`${ctx}: checkHitOwner.name 非法`);
      }
      if (t.cond.negate !== undefined && typeof t.cond.negate !== 'boolean') {
        out.errors.push(`${ctx}: negate 必须是布尔`);
      }
    } else if (t.cond.kind === 'actionStateIn') {
      if (!Array.isArray(t.cond.values) || t.cond.values.length === 0 ||
          !t.cond.values.every((v) => isInt(v))) {
        out.errors.push(`${ctx}: actionStateIn.values 必须是非空整数数组`);
      }
      if (t.cond.negate !== undefined && typeof t.cond.negate !== 'boolean') {
        out.errors.push(`${ctx}: negate 必须是布尔`);
      }
    } else {
      out.errors.push(`${ctx}: cond.kind 非法`);
    }
  }
  t.then.forEach((c, i) => validateCall(name, `loopTrigger@frame${t.frame}.then[${i}]`, c, out));
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
  for (const f of ['left', 'right', 'bottom', 'playerBottom', 'bottomOffset'] as const) {
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

/** fire 元件元数据包校验（bvn/fire@1；sim 消费 totalFrames/labels 做生命周期）。 */
export function validateFirePackage(pkg: FirePackage): ValidationResult {
  const out: ValidationResult = { errors: [], warnings: [] };

  if (pkg.schema !== 'bvn/fire@1') {
    out.errors.push(`schema 必须是 "bvn/fire@1"，收到 "${pkg.schema}"`);
  }
  if (pkg.kind !== 'fire') out.errors.push('kind 必须是 "fire"');
  if (pkg.ownerKind !== 'fighter' && pkg.ownerKind !== 'assister') {
    out.errors.push(`ownerKind 必须是 fighter|assister，收到 "${pkg.ownerKind}"`);
  }
  if (!pkg.id) out.errors.push('缺 id');
  if (!pkg.fires || typeof pkg.fires !== 'object') {
    out.errors.push('缺 fires 表');
    return out;
  }
  for (const [name, tl] of Object.entries(pkg.fires)) {
    if (!Number.isInteger(tl.totalFrames) || tl.totalFrames < 1) {
      out.errors.push(`fires[${name}]: totalFrames 必须是 ≥1 的整数`);
    }
    if (!tl.labels || typeof tl.labels !== 'object') {
      out.errors.push(`fires[${name}]: 缺 labels 表`);
      continue;
    }
    for (const [lab, frame] of Object.entries(tl.labels)) {
      if (!Number.isInteger(frame) || frame < 1) {
        out.errors.push(`fires[${name}].labels[${lab}]: 帧号必须是 ≥1 的整数`);
      } else if (Number.isInteger(tl.totalFrames) && frame > tl.totalFrames) {
        out.warnings.push(`fires[${name}].labels[${lab}]: 帧号 ${frame} 超出 totalFrames ${tl.totalFrames}`);
      }
    }
    // B5：org / hits 可选（旧包缺省 = 消费端回退生成帧占位矩形）
    if (tl.org !== undefined) {
      if (
        typeof tl.org.x !== 'number' ||
        typeof tl.org.y !== 'number' ||
        !Number.isFinite(tl.org.x) ||
        !Number.isFinite(tl.org.y)
      ) {
        out.errors.push(`fires[${name}].org: 必须是有限数值 {x,y}`);
      }
    }
    if (tl.hits !== undefined) {
      if (typeof tl.hits !== 'object' || tl.hits === null) {
        out.errors.push(`fires[${name}].hits: 必须是帧表对象`);
      } else {
        for (const [fs, areas] of Object.entries(tl.hits)) {
          const frame = Number(fs);
          if (!Number.isInteger(frame) || frame < 1) {
            out.errors.push(`fires[${name}].hits[${fs}]: 帧号必须是 ≥1 的整数`);
            continue;
          }
          if (Number.isInteger(tl.totalFrames) && frame > tl.totalFrames) {
            out.warnings.push(`fires[${name}].hits[${fs}]: 帧号超出 totalFrames ${tl.totalFrames}`);
          }
          if (!Array.isArray(areas)) {
            out.errors.push(`fires[${name}].hits[${fs}]: 必须是命中区数组`);
            continue;
          }
          for (const [i, ar] of areas.entries()) {
            if (
              typeof ar?.name !== 'string' ||
              ![ar.x, ar.y, ar.w, ar.h].every((v) => typeof v === 'number' && Number.isFinite(v))
            ) {
              out.errors.push(`fires[${name}].hits[${fs}][${i}]: 缺 name 或矩形字段非有限数值`);
            }
          }
        }
      }
    }
  }
  return out;
}
