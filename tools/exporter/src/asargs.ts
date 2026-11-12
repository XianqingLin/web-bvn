/**
 * AS3 时间轴脚本的调用/参数提取器（无损优先）。
 *
 * 只解析字面量：数字/字符串/布尔/null/数组/对象字面量；
 * 标识符（如 bsface1、snd_die）编码为 { $ref }；
 * 其余表达式原样保留为 { $expr }，绝不求值、不丢弃。
 */

export type AsArg =
  | number
  | string
  | boolean
  | null
  | AsArg[]
  | { [key: string]: AsArg }
  | { $ref: string }
  | { $expr: string };

export class AsParseError extends Error {}

/** 找与 s[openIdx] 处的开括号匹配的闭括号位置（尊重字符串）。 */
export function matchBracket(s: string, openIdx: number): number {
  const open = s[openIdx];
  const close = open === '(' ? ')' : open === '{' ? '}' : open === '[' ? ']' : undefined;
  if (!close) throw new AsParseError(`matchBracket: 位置 ${openIdx} 不是开括号`);
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new AsParseError(`matchBracket: 位置 ${openIdx} 的括号未闭合`);
}

/** 顶层分隔符切分（忽略字符串与嵌套括号内的分隔符）。 */
export function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === sep && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

function unquote(t: string): string {
  const q = t[0]!;
  const inner = t.slice(1, t.lastIndexOf(q));
  return inner.replace(/\\(["'\\])/g, '$1');
}

export function parseArg(raw: string): AsArg {
  const t = raw.trim();
  if (t === '') throw new AsParseError('parseArg: 空参数');
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === 'undefined' || t === 'NaN') return null;
  if (/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
  if (t[0] === '"' || t[0] === "'") return unquote(t);
  if (t[0] === '{') {
    if (!t.endsWith('}')) throw new AsParseError(`parseArg: 对象字面量未闭合: ${t}`);
    return parseObjectLiteral(t);
  }
  if (t[0] === '[') {
    if (!t.endsWith(']')) throw new AsParseError(`parseArg: 数组字面量未闭合: ${t}`);
    const inner = t.slice(1, -1).trim();
    return inner === '' ? [] : splitTopLevel(inner, ',').map(parseArg);
  }
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(t)) return { $ref: t };
  return { $expr: t };
}

/** 解析 {k:v, "k2":v2} 对象字面量（键可为裸标识符或字符串）。 */
export function parseObjectLiteral(t: string): Record<string, AsArg> {
  const inner = t.slice(1, -1).trim();
  const out: Record<string, AsArg> = {};
  if (inner === '') return out;
  for (const part of splitTopLevel(inner, ',')) {
    const kv = splitTopLevel(part, ':');
    if (kv.length !== 2) throw new AsParseError(`parseObjectLiteral: 非法键值对 "${part}"`);
    let key = kv[0]!.trim();
    if (key[0] === '"' || key[0] === "'") key = unquote(key);
    out[key] = parseArg(kv[1]!);
  }
  return out;
}

export interface CtrlerCall {
  target: 'mc' | 'fighter' | 'effect' | 'assister' | 'fighterTarget' | 'attacker';
  op: string;
  args: AsArg[];
}

/** 提取 (parent.)$xx_ctrler.op(...) 简单调用（不含链式调用——链式部分会留在残余里）。 */
export function extractCtrlerCalls(script: string): CtrlerCall[] {
  const re = /(?:parent\.)?\$(mc_ctrler|fighter_ctrler|effect_ctrler|assisterCtrler)\.(\w+)\s*\(/g;
  const calls: CtrlerCall[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    const openIdx = re.lastIndex - 1;
    const closeIdx = matchBracket(script, openIdx);
    const argsRaw = script.slice(openIdx + 1, closeIdx).trim();
    calls.push({
      target: CTRLER_TARGET[m[1]!]!,
      op: m[2]!,
      args: argsRaw === '' ? [] : splitTopLevel(argsRaw, ',').map(parseArg),
    });
    re.lastIndex = closeIdx + 1;
  }
  return calls;
}

/** 提取 defineAction("id", {...}) 表。 */
export function extractDefineActions(script: string): { id: string; data: Record<string, AsArg> }[] {
  const re = /defineAction\(\s*(["'])([^"']*)\1\s*,\s*\{/g;
  const out: { id: string; data: Record<string, AsArg> }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    const openIdx = re.lastIndex - 1;
    const closeIdx = matchBracket(script, openIdx);
    out.push({ id: m[2]!, data: parseObjectLiteral(script.slice(openIdx, closeIdx + 1)) });
    re.lastIndex = closeIdx + 1;
  }
  return out;
}

/** 提取 $fighter_ctrler.xxx = <数值> 赋值（速度/跳跃力/体格等）。 */
export function extractStatAssignments(script: string): Record<string, number> {
  const re = /\$fighter_ctrler\.(\w+)\s*=\s*(-?[\d.]+)/g;
  const out: Record<string, number> = {};
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    out[m[1]!] = Number(m[2]);
  }
  return out;
}

/**
 * 计算脚本的"未识别残余"：剥掉注释、简单 ctrler 调用、defineXxx、
 * 数值赋值、空转语句后剩下的内容。非空 ⇒ 该帧脚本需保留原文（raw）。
 * 宁可误留（保留原文是安全方向），不可误丢。
 *
 * opts.assist：辅助脚本加剥已知样板（setAssistCtrler/setAttackerCtrler/
 * defineActions/defineBuffEffects 函数体——内容已被专用提取器消费；
 * ctrler 变量声明；链式调用/赋值）。角色路径不传，字节不变。
 */
export function scriptResidue(script: string, opts?: { assist?: boolean }): string {
  let s = script;
  s = s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (opts?.assist) {
    // 已知样板函数体（括号平衡剥离）
    s = stripFunctionDefs(s, /^(setAssistCtrler|setAttackerCtrler|defineActions|defineBuffEffects)$/);
    s = s.replace(/var\s+\$assisterCtrler:\*;?/g, '').replace(/var\s+\$attacker_ctrler:\*;?/g, '');
    s = s.replace(/var\s+defineAction:Function;?/g, '');
    // 链式调用/赋值/基础调用：与 extractAssistTimelineCalls 同一套括号平衡区间
    // （旧正则 [^;{}]* 剥不掉带对象字面量参数的调用，如 fire 的选项对象）
    s = stripRanges(s, extractAssistTimelineCalls(s).chainRanges);
    s = s.replace(/\$assisterCtrler\.getSelf\(\)\.buffEffects\s*=\s*\w+\s*;?/g, '');
    // const 声明（值已被 extractConsts 消费，折叠进 {$ref} 参数；孤立声明无行为）
    s = s.replace(/const\s+\w+\s*:\s*(?:Number|Array|int|uint|String|\*)\s*=\s*[^;\n]+;?/g, '');
    // import 语句（纯声明；只作用于辅助路径，角色路径字节不变）
    s = s.replace(/^import\s+[^\n]*;\s*$/gm, '');
  }
  s = s.replace(
    /(?:parent\.)?\$(?:mc_ctrler|fighter_ctrler|effect_ctrler|assisterCtrler)\.\w+\s*\([^;{}]*\)\s*;?/g,
    '',
  );
  s = s.replace(/\bdefine\w+\s*\([^;{}]*\)\s*;?/g, '');
  s = s.replace(/\$\w+\.\w+\s*=\s*-?[\d.]+\s*;?/g, '');
  s = s.replace(/if\s*\(\s*!\s*\$\w+\s*\)\s*return\s*;?/g, '');
  s = s.replace(/\bstop\(\s*\)\s*;?/g, '').replace(/\breturn\s*;?/g, '');
  if (opts?.assist) s = s.replace(/;/g, ''); // 区间剥离留下孤立分号（标签字符串无分号用例）
  return s.replace(/\s+/g, ' ').trim();
}

/** 剥掉指定名的 function NAME(...):void{...} 定义（括号平衡；返回类型标注可选）。 */
export function stripFunctionDefs(s: string, names: RegExp): string {
  const re = /function\s+(\w+)\s*\([^)]*\)\s*(?::\s*[\w*]+\s*)?\{/g;
  let m: RegExpExecArray | null;
  let out = s;
  const ranges: Array<[number, number]> = [];
  while ((m = re.exec(s)) !== null) {
    if (!names.test(m[1]!)) continue;
    try {
      const close = matchBracket(s, re.lastIndex - 1);
      ranges.push([m.index, close + 1]);
    } catch {
      /* 留给残余 */
    }
  }
  const sorted = [...ranges].sort((a, b) => b[0] - a[0]);
  for (const [st, e] of sorted) out = out.slice(0, st) + out.slice(e);
  return out;
}

/** 提取 defineBishaFace / defineHurtSound / defineHurtFlySound / defineDieSound。 */
export function extractNamedDefine(script: string): { op: string; args: AsArg[] }[] {
  const re = /(defineBishaFace|defineHurtSound|defineHurtFlySound|defineDieSound)\s*\(/g;
  const out: { op: string; args: AsArg[] }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    const openIdx = re.lastIndex - 1;
    const closeIdx = matchBracket(script, openIdx);
    const argsRaw = script.slice(openIdx + 1, closeIdx).trim();
    out.push({
      op: m[1]!,
      args: argsRaw === '' ? [] : splitTopLevel(argsRaw, ',').map(parseArg),
    });
    re.lastIndex = closeIdx + 1;
  }
  return out;
}

// —— 辅助脚本链式调用/赋值提取（切片 12） ——

/** 辅助时间轴提取结果：合并后的调用列表 + 链式区间（用于残余剥离）。 */
export interface AssistTimelineCalls {
  calls: CtrlerCall[];
  /** 链式调用覆盖的 [start, end) 区间（scriptResidue 剥离用） */
  chainRanges: Array<[number, number]>;
}

/** buff 控制器 op → 注册表 op 名前缀（attackUp → buffAttackUp）。 */
const BUFF_OPS = new Set(['speedUp', 'attackUp', 'defenseUp']);

/**
 * 辅助时间轴调用提取：基础调用 + 链式调用合并。
 *  - `$assisterCtrler.effect.op(...)` → {target:'effect'}（原版 AssisterCtrler.effect 转发）
 *  - `$assisterCtrler.getOwner()[.getBuffCtrl()].op(...)` → {target:'fighter'}
 *    （owner 链；getBuffCtrl 链的 op 改名 buffXxx）
 *  - `$assisterCtrler.getTarget().qi -= N` → {target:'fighterTarget', op:'addQi', [-N]}
 * 裸 getOwner/getSelf/getTarget 调用（链头伪触发，原版纯读无副作用）一律丢弃。
 */
export function extractAssistTimelineCalls(scriptRaw: string): AssistTimelineCalls {
  // 先剥掉全部函数定义：函数体内的调用属于循环触发内部逻辑
  // （addCustomFunc 数据化），不是时间轴帧触发——否则同帧双重提取
  // （suigetsu 案例：gotoAndPlay("attack") 既进 loopTrigger.then 又成帧触发）
  const script = stripFunctionDefs(scriptRaw, /.*/);
  const chainRanges: Array<[number, number]> = [];
  const calls: CtrlerCall[] = [];

  const parseArgsAt = (openIdx: number): AsArg[] => {
    const closeIdx = matchBracket(script, openIdx);
    const argsRaw = script.slice(openIdx + 1, closeIdx).trim();
    return argsRaw === '' ? [] : splitTopLevel(argsRaw, ',').map(parseArg);
  };

  // 1. effect 链：$assisterCtrler.effect.op(...)
  const effectRe = /\$assisterCtrler\.effect\.(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = effectRe.exec(script)) !== null) {
    const openIdx = effectRe.lastIndex - 1;
    try {
      const end = matchBracket(script, openIdx);
      calls.push({ target: 'effect', op: m[1]!, args: parseArgsAt(openIdx) });
      chainRanges.push([m.index, end + 1]);
    } catch {
      /* 括号不闭合 → 留给残余 */
    }
  }

  // 2. owner/self/target 链（中段允许 getBuffCtrl/getCtrler 零参访问器）。
  //    getOwner/getSelf → target 'fighter'（辅助语境 = owner）；getTarget →
  //    'fighterTarget'（owner 的当前目标，与 kon qi 扣减同语义）。
  const ownerRe =
    /\$assisterCtrler\.(getOwner|getSelf|getTarget)\(\)(?:\.(?:getBuffCtrl|getCtrler)\(\))*\.(\w+)\s*\(/g;
  while ((m = ownerRe.exec(script)) !== null) {
    const openIdx = ownerRe.lastIndex - 1;
    const isBuff = m[0]!.includes('getBuffCtrl');
    let op = m[2]!;
    if (isBuff && BUFF_OPS.has(op)) op = `buff${op[0]!.toUpperCase()}${op.slice(1)}`;
    const target = m[1] === 'getTarget' ? 'fighterTarget' : 'fighter';
    try {
      const end = matchBracket(script, openIdx);
      calls.push({ target, op, args: parseArgsAt(openIdx) });
      chainRanges.push([m.index, end + 1]);
    } catch {
      /* 留给残余 */
    }
  }

  // 3. 目标气扣减赋值：$assisterCtrler.getTarget().qi -= N（kon）
  const targetQiRe = /\$assisterCtrler\.getTarget\(\)\.qi\s*-=\s*(-?[\d.]+)/g;
  while ((m = targetQiRe.exec(script)) !== null) {
    calls.push({ target: 'fighterTarget', op: 'addQi', args: [-Number(m[1])] });
    chainRanges.push([m.index, m.index + m[0].length]);
  }

  // 4. 基础调用（剔除链头伪触发：裸 getOwner/getSelf/getTarget + 已被链覆盖者）
  const inChain = (idx: number): boolean =>
    chainRanges.some(([s, e]) => idx >= s && idx < e);
  const baseRe = /(?:parent\.)?\$(mc_ctrler|fighter_ctrler|effect_ctrler|assisterCtrler)\.(\w+)\s*\(/g;
  while ((m = baseRe.exec(script)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    if (inChain(m.index)) continue;
    if (
      m[1] === 'assisterCtrler' &&
      (m[2] === 'getOwner' || m[2] === 'getSelf' || m[2] === 'getTarget')
    ) {
      chainRanges.push([m.index, openIdx + 1]);
      continue;
    }
    try {
      const end = matchBracket(script, openIdx);
      calls.push({
        target: CTRLER_TARGET[m[1]!]!,
        op: m[2]!,
        args: parseArgsAt(openIdx),
      });
      chainRanges.push([m.index, end + 1]);
    } catch {
      /* 留给残余 */
    }
  }

  return { calls, chainRanges };
}

/** 辅助增益 buff（原版 getSelf().buffEffects = {...}；白名单字段）。 */
export interface AssistBuffEffects {
  attrResistance?: number;
  phyLifesteal?: number;
}

/**
 * 提取 buffEffects 赋值（orihime attrResistance / yachiru phyLifesteal）。
 * 识别 `$assisterCtrler.getSelf().buffEffects = ...` + 同脚本
 * `var buffEffects:Object = {...}` 字面量；只收白名单数值字段。
 */
export function extractBuffEffects(script: string): AssistBuffEffects | null {
  if (!/\$assisterCtrler\.getSelf\(\)\.buffEffects\s*=/.test(script)) return null;
  const m = /buffEffects:Object\s*=\s*\{/.exec(script);
  if (!m) return null;
  try {
    const closeIdx = matchBracket(script, m.index + m[0].length - 1);
    const obj = parseObjectLiteral(script.slice(m.index + m[0].length - 1, closeIdx + 1));
    const out: AssistBuffEffects = {};
    for (const key of ['attrResistance', 'phyLifesteal'] as const) {
      const v = obj[key];
      if (typeof v === 'number') out[key] = v;
    }
    return out;
  } catch {
    return null;
  }
}

// —— 循环触发器（addCustomFunc 数据化，切片 12） ——

/** 支持的循环触发条件（有界支持，切片 12；negate = 取反）。 */
export type LoopCond =
  | { kind: 'checkHitOwner'; name: string; negate?: boolean }
  | { kind: 'actionStateIn'; values: number[]; negate?: boolean };

/** 自定义函数体解析结果。 */
export interface LoopTriggerBody {
  cond: LoopCond | null;
  then: CtrlerCall[];
}

/** 收集脚本内 const 常量（数值/数值数组）。 */
export function extractConsts(script: string): Record<string, number | number[]> {
  const out: Record<string, number | number[]> = {};
  const numRe = /(?:const|var)\s+(\w+):Number\s*=\s*(-?[\d.]+)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = numRe.exec(script)) !== null) out[m[1]!] = Number(m[2]);
  const arrRe = /(?:const|var)\s+(\w+):Array\s*=\s*\[([^\]]*)\]\s*;/g;
  while ((m = arrRe.exec(script)) !== null) {
    const parts = m[2]!.split(',').map((s) => s.trim());
    if (parts.every((p) => /^-?[\d.]+$/.test(p))) out[m[1]!] = parts.map(Number);
  }
  return out;
}

/** 提取脚本内 function NAME(...):void{...} 函数体（括号平衡）。 */
export function extractFunctionBodies(script: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /function\s+(\w+)\s*\([^)]*\)\s*:\s*void\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    try {
      const close = matchBracket(script, re.lastIndex - 1);
      out.set(m[1]!, script.slice(re.lastIndex, close));
    } catch {
      /* 留给残余 */
    }
  }
  return out;
}

/**
 * 解析自定义函数体为循环触发（有界支持，切片 12）：
 *  - 前导局部绑定 `var x:int = $assisterCtrler.getOwner().actionState;`
 *  - 卫语句 `if(!COND){return;}`（COND = checkHitOwner / actionState∈数组）
 *  - 其余为 assister/fighter 调用（经 extractAssistTimelineCalls）
 *  - 数值参数经 const 折叠（{$ref:X} → 常量值）
 * 解析不了返回 null（调用侧保留 rawScript + 抑制发射）。
 */
export function parseLoopTriggerBody(
  bodyRaw: string,
  consts: Record<string, number | number[]>,
): LoopTriggerBody | null {
  let rest = stripComments(bodyRaw).trim();
  let cond: LoopCond | null = null;

  // 前导局部绑定：owner 状态读取 / owner 控制器（tsunate 形态）
  const bindings = new Map<string, 'ownerActionState' | 'ownerCtrler'>();
  for (;;) {
    const bindState = /^var\s+(\w+):int\s*=\s*\$assisterCtrler\.getOwner\(\)\.actionState\s*;\s*/.exec(rest);
    if (bindState) {
      bindings.set(bindState[1]!, 'ownerActionState');
      rest = rest.slice(bindState[0].length).trim();
      continue;
    }
    const bindCtrl = /^var\s+(\w+):\*\s*=\s*\$assisterCtrler\.getOwner\(\)\.getCtrler\(\)\s*;\s*/.exec(rest);
    if (bindCtrl) {
      bindings.set(bindCtrl[1]!, 'ownerCtrler');
      rest = rest.slice(bindCtrl[0].length).trim();
      continue;
    }
    break;
  }

  // 卫语句：if(COND){return;}——`!` 前缀可选；循环 cond = 卫语句条件的否定
  // （卫语句成立即退出 → 继续执行/每帧重评的条件是卫语句条件不成立）
  const guard = /^if\s*\(\s*(!?)\s*(.+?)\s*\)\s*\{\s*return\s*;\s*\}/.exec(rest);
  if (guard) {
    const not = guard[1] === '!';
    const c = guard[2]!.trim();
    const hit = /^\$assisterCtrler\.checkHitOwner\(\s*(["'])([^"']*)\1\s*\)$/.exec(c);
    if (hit) {
      // !X 卫语句 → cond = X；裸 X 卫语句 → cond = !X
      cond = { kind: 'checkHitOwner', name: hit[2]!, ...(not ? {} : { negate: true }) };
    } else {
      // actionState∈数组：X.indexOf(arg) == -1（arg = 绑定名或内联链）
      const inArr = /^(\w+)\.indexOf\((\w+)\)\s*==\s*-1$/.exec(c);
      const inlineArr = /^(\w+)\.indexOf\(\$assisterCtrler\.getOwner\(\)\.actionState\)\s*==\s*-1$/.exec(c);
      const arrName = inArr
        ? bindings.get(inArr[2]!) === 'ownerActionState'
          ? inArr[1]!
          : null
        : inlineArr
          ? inlineArr[1]!
          : null;
      if (arrName === null) return null;
      const arr = consts[arrName];
      if (!Array.isArray(arr)) return null;
      // !(...==-1) 卫语句 → cond = 不在数组
      cond = { kind: 'actionStateIn', values: arr, ...(not ? { negate: true } : {}) };
    }
    rest = rest.slice(guard[0].length).trim();
  } else if (/^if\s*\(/.test(rest)) {
    // 其余 if 形态不支持
    return null;
  }

  // 剩余语句全部须为可提取调用
  const { calls, chainRanges } = extractAssistTimelineCalls(rest);
  // owner 控制器绑定的调用：name.op(args); → owner 链语义（tsunate 形态）
  const boundCalls: CtrlerCall[] = [];
  const boundRanges: Array<[number, number]> = [];
  for (const [name, kind] of bindings) {
    if (kind !== 'ownerCtrler') continue;
    const re = new RegExp(`${name}\\.(\\w+)\\s*\\(`, 'g');
    let bm: RegExpExecArray | null;
    while ((bm = re.exec(rest)) !== null) {
      const openIdx = bm.index + bm[0].length - 1;
      try {
        const end = matchBracket(rest, openIdx);
        const argsRaw = rest.slice(openIdx + 1, end).trim();
        boundCalls.push({
          target: 'fighter',
          op: bm[1]!,
          args: argsRaw === '' ? [] : splitTopLevel(argsRaw, ',').map(parseArg),
        });
        boundRanges.push([bm.index, end + 1]);
      } catch {
        return null;
      }
    }
  }
  let residue = rest;
  // 剥掉已提取区间 + 空转语句后应无剩余
  residue = stripRanges(residue, [...chainRanges, ...boundRanges]);
  residue = residue
    .replace(/(?:const|var)\s+\w+:(?:Number|Array)\s*=\s*[^;]+;\s*/g, '')
    .replace(/var\s+\w+:\w+\s*=\s*\$assisterCtrler\.getOwner\(\)\.[\w()]+\s*;\s*/g, '')
    .replace(/[\s;]+/g, '');
  if (residue !== '') return null;

  // const 折叠：{$ref:X} → 数值/数组常量
  const fold = (v: AsArg): AsArg => {
    if (v && typeof v === 'object' && '$ref' in v) {
      const c = consts[(v as { $ref: string }).$ref];
      if (typeof c === 'number' || Array.isArray(c)) return c;
    }
    return v;
  };
  return {
    cond,
    then: [...calls, ...boundCalls].map((c) => ({ ...c, args: c.args.map(fold) })),
  };
}

/** 按区间剥离文本（按起点降序从后往前删，前置位置不受影响）。 */
function stripRanges(s: string, ranges: Array<[number, number]>): string {
  let out = s;
  const sorted = [...ranges].sort((a, b) => b[0] - a[0]);
  for (const [st, e] of sorted) {
    out = out.slice(0, st) + out.slice(e);
  }
  return out;
}

// —— 帧脚本语句级解析（切片 11：if/else 条件触发） ——

/** 条件查询（TriggerCondition 的导出器侧形态）。 */
export interface CondQuery {
  target: CtrlerCall['target'];
  op: string;
  args: AsArg[];
  negate?: boolean;
  path?: string[];
  cmp?: { op: '==' | '!=' | '<' | '>' | '<=' | '>='; value: number | boolean };
}

/** 条件触发（CondTriggerDef 的导出器侧形态）。 */
export interface CondStatement {
  cond: CondQuery;
  then?: CtrlerCall[];
  else?: CtrlerCall[];
}

/** 帧脚本语句解析结果。 */
export type FrameStatement =
  | { kind: 'call'; call: CtrlerCall }
  | { kind: 'cond'; stmt: CondStatement; residue: string | null }
  | { kind: 'unparsed'; text: string };

/** 条件查询 op 白名单（与 core 求值器/数据校验器三处同 commit）。 */
const CONDITION_OPS = new Set(['justHit', 'targetInRange', 'getTargetState', 'getSelf', 'getTargetSP']);

/** 剥注释（行注释 + 块注释；字符串内容不动）。 */
export function stripComments(s: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < s.length) {
    const c = s[i]!;
    if (quote) {
      out += c;
      if (c === '\\' && i + 1 < s.length) {
        out += s[i + 1]!;
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 跳过空白读一个标识符；返回 [name, nextIndex]，无标识符返回 null。 */
function readIdent(s: string, i: number): [string, number] | null {
  const m = /^[ \t\r\n]*([A-Za-z_$][\w$]*)/.exec(s.slice(i));
  if (!m) return null;
  return [m[1]!, i + m[0].length];
}

/** 解析 if 条件表达式为查询；不可识别返回 null。 */
function parseCondQuery(raw: string): CondQuery | null {
  let s = raw.trim();
  // 整体括号包裹 → 逐层剥壳
  for (;;) {
    if (s.startsWith('(') && s.endsWith(')')) {
      let ok = false;
      try {
        ok = matchBracket(s, 0) === s.length - 1;
      } catch {
        ok = false;
      }
      if (ok) {
        s = s.slice(1, -1).trim();
        continue;
      }
    }
    break;
  }
  let negate = false;
  if (s.startsWith('!')) {
    negate = true;
    s = s.slice(1).trim();
  }
  const call = /^(?:parent\.)?\$(mc_ctrler|fighter_ctrler|effect_ctrler)\.(\w+)\s*\(/.exec(s);
  if (!call) return null;
  const openIdx = s.indexOf('(', call[0].length - 1);
  let closeIdx: number;
  try {
    closeIdx = matchBracket(s, openIdx);
  } catch {
    return null;
  }
  const argsRaw = s.slice(openIdx + 1, closeIdx).trim();
  let rest = s.slice(closeIdx + 1).trim();
  const query: CondQuery = {
    target: CTRLER_TARGET[call[1]!]!,
    op: call[2]!,
    args: argsRaw === '' ? [] : splitTopLevel(argsRaw, ',').map(parseArg),
  };
  if (!CONDITION_OPS.has(query.op)) return null;
  if (query.target !== 'fighter') return null;
  // 属性链：.prop(.prop)*（如 getSelf().isInAir）
  if (rest.startsWith('.')) {
    const m = /^\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/.exec(rest);
    if (!m) return null;
    query.path = m[1]!.split('.');
    rest = rest.slice(m[0].length).trim();
  }
  // 比较：== != < > <= >= 字面量
  if (rest !== '') {
    const cmp = /^(==|!=|<=|>=|<|>)\s*(-?[\d.]+|true|false)\s*$/.exec(rest);
    if (!cmp) return null;
    const value = cmp[2] === 'true' ? true : cmp[2] === 'false' ? false : Number(cmp[2]);
    query.cmp = { op: cmp[1] as '==' | '!=' | '<' | '>' | '<=' | '>=', value };
  }
  if (negate) query.negate = true;
  return query;
}

/**
 * 帧脚本 → 语句列表（if/else 条件 + 简单 ctrler 调用）。
 * var 声明 / stop / return 等无行为语句忽略；
 * 无法识别的语句原样进 unparsed。解析永不抛错（非法输入 = unparsed）。
 */
export function parseFrameStatements(scriptRaw: string): FrameStatement[] {
  const script = stripComments(scriptRaw);
  const out: FrameStatement[] = [];

  /** 语句分类：简单调用 / 空转（null = 忽略）/ 其他（unparsed）。 */
  const classifySimple = (text: string): FrameStatement | null => {
    if (text === '' || text === ';') return null;
    if (/^(?:var|const|let)\b/.test(text)) return null;
    if (/^return\b/.test(text)) return null;
    const body = text.replace(/;\s*$/, '').trim();
    if (/^stop\s*\(\s*\)$/.test(body)) return null;
    const call = /^(?:parent\.)?\$(mc_ctrler|fighter_ctrler|effect_ctrler)\.(\w+)\s*\(/.exec(body);
    if (call && body.endsWith(')')) {
      const openIdx = body.indexOf('(', call[0].length - 1);
      try {
        const closeIdx = matchBracket(body, openIdx);
        if (closeIdx === body.length - 1) {
          const argsRaw = body.slice(openIdx + 1, closeIdx).trim();
          return {
            kind: 'call',
            call: {
              target: CTRLER_TARGET[call[1]!]!,
              op: call[2]!,
              args: argsRaw === '' ? [] : splitTopLevel(argsRaw, ',').map(parseArg),
            },
          };
        }
      } catch {
        /* fallthrough → unparsed */
      }
    }
    return { kind: 'unparsed', text };
  };

  /** 读到语句结尾（';' 或深度 0 的 '}'），返回 [endIndex, text]。 */
  const readToEnd = (start: number): [number, string] => {
    let depth = 0;
    let quote: string | null = null;
    for (let j = start; j < script.length; j++) {
      const c = script[j]!;
      if (quote) {
        if (c === '\\') j++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') depth--;
      else if (c === ';' && depth === 0) {
        return [j + 1, script.slice(start, j + 1)];
      }
      if (depth < 0 || (depth === 0 && c === '}' && j > start)) {
        // 无分号结尾的语句（块边界处）
        return [j, script.slice(start, j)];
      }
    }
    return [script.length, script.slice(start)];
  };

  /** 解析块文本为调用列表；含任何非调用语句 → clean=false。 */
  const parseBody = (text: string): { calls: CtrlerCall[]; clean: boolean } => {
    const stmts = parseFrameStatements(text);
    const calls: CtrlerCall[] = [];
    let clean = true;
    for (const st of stmts) {
      if (st.kind === 'call') calls.push(st.call);
      else clean = false;
    }
    return { calls, clean };
  };

  let i = 0;
  while (i < script.length) {
    if (/\s/.test(script[i]!)) {
      i++;
      continue;
    }
    if (script[i] === '}') {
      // 游离闭括号（所属块已被整体消费）→ 跳过
      i++;
      continue;
    }
    const id = readIdent(script, i);
    if (id && id[0] === 'if') {
      const stmtStart = i;
      let j = id[1] + /^[ \t\r\n]*/.exec(script.slice(id[1]))![0].length;
      if (script[j] !== '(') {
        const [end, text] = readToEnd(i);
        const st = classifySimple(text);
        if (st) out.push(st);
        i = end;
        continue;
      }
      let condExpr = '';
      let k: number;
      try {
        const close = matchBracket(script, j);
        condExpr = script.slice(j + 1, close);
        k = close + 1;
      } catch {
        const [end, text] = readToEnd(i);
        const st = classifySimple(text);
        if (st) out.push(st);
        i = end;
        continue;
      }
      let thenCalls: CtrlerCall[] | undefined;
      let elseCalls: CtrlerCall[] | undefined;
      let clean = true;
      k += /^[ \t\r\n]*/.exec(script.slice(k))![0].length;
      // then（花括号块或单语句）
      if (script[k] === '{') {
        try {
          const close = matchBracket(script, k);
          const body = parseBody(script.slice(k + 1, close));
          thenCalls = body.calls;
          clean = clean && body.clean;
          k = close + 1;
        } catch {
          clean = false;
          k = script.length;
        }
      } else {
        const [end, text] = readToEnd(k);
        const st = classifySimple(text);
        if (st?.kind === 'call') thenCalls = [st.call];
        else if (st !== null) clean = false;
        k = end;
      }
      // else（可选；else-if 链按不支持处理 → clean=false）
      const k2 = k + /^[ \t\r\n]*/.exec(script.slice(k))![0].length;
      const elseId = readIdent(script, k2);
      if (elseId && elseId[0] === 'else') {
        let m = elseId[1] + /^[ \t\r\n]*/.exec(script.slice(elseId[1]))![0].length;
        if (script[m] === '{') {
          try {
            const close = matchBracket(script, m);
            const body = parseBody(script.slice(m + 1, close));
            elseCalls = body.calls;
            clean = clean && body.clean;
            k = close + 1;
          } catch {
            clean = false;
            k = script.length;
          }
        } else {
          const [end, text] = readToEnd(m);
          const st = classifySimple(text);
          if (st?.kind === 'call') elseCalls = [st.call];
          else clean = false;
          k = end;
        }
      } else {
        k = k2;
      }
      const cond = parseCondQuery(condExpr);
      const hasCalls = (thenCalls?.length ?? 0) + (elseCalls?.length ?? 0) > 0;
      if (cond !== null) {
        const stmt: CondStatement = { cond };
        if (thenCalls !== undefined) stmt.then = thenCalls;
        if (elseCalls !== undefined) stmt.else = elseCalls;
        out.push({
          kind: 'cond',
          stmt,
          residue: clean ? null : script.slice(stmtStart, k),
        });
      } else if (hasCalls) {
        // 条件不可识别（跨帧变量/非查询）但分支有调用 → 整体保留原文，
        // 抑制分支体发射（修复旧提取「两分支无条件都发」）
        out.push({ kind: 'unparsed', text: script.slice(stmtStart, k) });
      }
      // 无调用的未知条件（守卫 if 等）→ 忽略
      i = k;
      continue;
    }
    const [end, text] = readToEnd(i);
    const st = classifySimple(text);
    if (st) out.push(st);
    i = end;
  }
  return out;
}

/** ctrler 变量名 → 规范 target（辅助用 $assisterCtrler 驼峰命名）。 */
const CTRLER_TARGET: Record<string, CtrlerCall['target']> = {
  mc_ctrler: 'mc',
  fighter_ctrler: 'fighter',
  effect_ctrler: 'effect',
  assisterCtrler: 'assister',
  attacker_ctrler: 'attacker',
};

/**
 * attacker 元件脚本调用提取（切片 21）：$attacker_ctrler.op(...) 简单调用于
 * 独立道具内层时间轴（FighterAttackerCtrler 转发）。effect 链 → target 'effect'；
 * 其余（stop/stopFollowTarget/gotoAndPlay/removeSelf/endAct/…）→ target 'attacker'。
 * 条件语句/带状态脚本由调用方先行排除（宁可不提取，保留 rawScript 审计）。
 */
export function extractAttackerCalls(script: string): CtrlerCall[] {
  const calls: CtrlerCall[] = [];
  // effect 链：$attacker_ctrler.effect.op(...)
  const effectRe = /\$attacker_ctrler\.effect\.(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = effectRe.exec(script)) !== null) {
    const openIdx = effectRe.lastIndex - 1;
    try {
      const end = matchBracket(script, openIdx);
      const argsRaw = script.slice(openIdx + 1, end).trim();
      calls.push({ target: 'effect', op: m[1]!, args: argsRaw === '' ? [] : splitTopLevel(argsRaw, ',').map(parseArg) });
    } catch {
      /* 括号不闭合 → 留给残余 */
    }
  }
  // 基础调用（负向环视排除 effect 链）
  const baseRe = /\$attacker_ctrler\.(?!effect\.)(\w+)\s*\(/g;
  while ((m = baseRe.exec(script)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    try {
      const end = matchBracket(script, openIdx);
      const argsRaw = script.slice(openIdx + 1, end).trim();
      calls.push({ target: 'attacker', op: m[1]!, args: argsRaw === '' ? [] : splitTopLevel(argsRaw, ',').map(parseArg) });
    } catch {
      /* 括号不闭合 → 留给残余 */
    }
  }
  return calls;
}

/**
 * attacker 元件卫语句识别（B5，madara miss 分支）：
 *   if(!$attacker_ctrler.justHit("x")){ $attacker_ctrler.gotoAndPlay("y"); }
 * → cond 触发器（justHit 取反 → else 分支 gotoAndPlay）。整条语句匹配
 * （stripComments + trim 后），带多余语句/else 分支不匹配（留 raw 审计）。
 */
export function matchJustHitGuard(script: string): { hitId: string; label: string } | null {
  const m = /^if\s*\(\s*!\s*\$attacker_ctrler\.justHit\(\s*"(\w+)"\s*\)\s*\)\s*\{\s*\$attacker_ctrler\.gotoAndPlay\(\s*"(\w+)"\s*\)\s*;?\s*\}\s*;?$/.exec(
    script,
  );
  return m ? { hitId: m[1]!, label: m[2]! } : null;
}

/**
 * hitModel 命中力改写识别（B5，itachi 动态伤害；assister 生成帧脚本）：
 *   const RATE:Number = 0.008;
 *   var <v>:* = $assisterCtrler.hitModel.getHitVO("<id>");
 *   var targetHpMax:Number = $assisterCtrler.getOwner()...getTargetSP().hpMax;
 *   <v>.power = targetHpMax * RATE;
 * → 触发器 setHitPowerByTargetHpMax(id, rate)。乘式逐因子求值：
 * targetHpMax（×1）× 数值字面量 × const 数值；其余因子（变量/表达式）不匹配。
 */
export function extractHitPowerSet(
  script: string,
): { hitId: string; rate: number; stripped: string } | null {
  const vm = /\bvar\s+(\w+)\s*:\s*\*\s*=\s*\$assisterCtrler\.hitModel\.getHitVO\(\s*"(\w+)"\s*\)\s*;/.exec(
    script,
  );
  if (!vm) return null;
  const varName = vm[1]!;
  const am = new RegExp(`${varName}\\.power\\s*=\\s*([^;\\n]+)\\s*;`).exec(script);
  if (!am) return null;
  const expr = am[1]!;
  let sawFactor = false;
  let rate = 1;
  for (const rawFactor of expr.split('*')) {
    const f = rawFactor.trim();
    if (/^targetHpMax$/i.test(f)) {
      sawFactor = true;
      continue;
    }
    if (/^-?(\d+\.?\d*|\.\d+)$/.test(f)) {
      rate *= Number(f);
      sawFactor = true;
      continue;
    }
    return null; // 未知因子（变量/表达式）→ 不匹配
  }
  if (!sawFactor) return null;
  // 剥除已数据化语句：var 声明、赋值、本脚本 const 数值声明（extractConsts 同源）
  let stripped = script
    .replace(vm[0], '')
    .replace(am[0], '')
    .replace(/(?:const|var)\s+(\w+):Number\s*=\s*(-?[\d.]+)\s*;/g, (full, nm: string) =>
      expr.includes(nm) ? '' : full,
    );
  stripped = stripped.replace(/var\s+targetHpMax:Number\s*=[^;]*;\s*/g, '');
  return { hitId: vm[2]!, rate, stripped };
}
