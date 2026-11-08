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
  target: 'mc' | 'fighter' | 'effect';
  op: string;
  args: AsArg[];
}

/** 提取 (parent.)$xx_ctrler.op(...) 调用。 */
export function extractCtrlerCalls(script: string): CtrlerCall[] {
  const re = /(?:parent\.)?\$(mc|fighter|effect)_ctrler\.(\w+)\s*\(/g;
  const calls: CtrlerCall[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    const openIdx = re.lastIndex - 1;
    const closeIdx = matchBracket(script, openIdx);
    const argsRaw = script.slice(openIdx + 1, closeIdx).trim();
    calls.push({
      target: m[1] as CtrlerCall['target'],
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
