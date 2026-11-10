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
  target: 'mc' | 'fighter' | 'effect' | 'assister';
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
 */
export function scriptResidue(script: string): string {
  let s = script;
  s = s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  s = s.replace(
    /(?:parent\.)?\$(?:mc_ctrler|fighter_ctrler|effect_ctrler|assisterCtrler)\.\w+\s*\([^;{}]*\)\s*;?/g,
    '',
  );
  s = s.replace(/\bdefine\w+\s*\([^;{}]*\)\s*;?/g, '');
  s = s.replace(/\$\w+\.\w+\s*=\s*-?[\d.]+\s*;?/g, '');
  s = s.replace(/if\s*\(\s*!\s*\$\w+\s*\)\s*return\s*;?/g, '');
  s = s.replace(/\bstop\(\s*\)\s*;?/g, '').replace(/\breturn\s*;?/g, '');
  return s.replace(/\s+/g, ' ').trim();
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
};
