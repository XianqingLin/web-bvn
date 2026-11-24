/**
 * 键位映射（按键设置切片，2026-11-25）：动作 ↔ 物理键（KeyboardEvent.code）。
 *
 * - 原版对位：KeyConfigVO（P1/P2 各一套，10 个动作）+ SetCtrlBtnUI（SET ALL / SET DEFAULT /
 *   APPLY / CANCEL）。偏离登记：
 *   ① 动作表 = 我们的 11 键语义中的 10 个可改动作（ESC 固定返回，不可改）；辅助键（O / Numpad6）
 *      计入可改，对位原版 SPECIAL 项的位置；
 *   ② 冲突策略：绑定到已被占用的键时与占用方**交换**（原版未明确），保证全局每键唯一；
 *   ③ 按 e.code（物理键）绑定，显示名由 keyLabel 转换。
 * - 键位只影响输入层（键 → ButtonMask 位图），sim 不感知，确定性不受影响。
 */
import { Btn } from '@bvn/core';

export type KeyPlayer = 'p1' | 'p2';

export type KeyAction =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'attack'
  | 'jump'
  | 'dash'
  | 'skill'
  | 'superSkill'
  | 'assist';

export const KEY_PLAYERS: readonly KeyPlayer[] = ['p1', 'p2'];

/** 动作表（顺序 = 设置页行序；btn = sim 位图位）。 */
export const KEY_ACTIONS: ReadonlyArray<{ id: KeyAction; en: string; cn: string; btn: number }> = [
  { id: 'up', en: 'UP', cn: '上', btn: Btn.up },
  { id: 'down', en: 'DOWN', cn: '下', btn: Btn.down },
  { id: 'left', en: 'LEFT', cn: '左', btn: Btn.left },
  { id: 'right', en: 'RIGHT', cn: '右', btn: Btn.right },
  { id: 'attack', en: 'ATTACK', cn: '攻击', btn: Btn.attack },
  { id: 'jump', en: 'JUMP', cn: '跳跃', btn: Btn.jump },
  { id: 'dash', en: 'DASH', cn: '瞬步', btn: Btn.dash },
  { id: 'skill', en: 'SKILL', cn: '技能', btn: Btn.skill },
  { id: 'superSkill', en: 'SUPER', cn: '大招', btn: Btn.superSkill },
  { id: 'assist', en: 'ASSIST', cn: '辅助', btn: Btn.assist },
];

export type KeyBindings = Record<KeyPlayer, Record<KeyAction, string>>;

/** 保留键：不可绑定（ESC 返回/跳过演出）。 */
export const RESERVED_CODE = 'Escape';

/** 默认键位（与改键前的硬编码表一致：P1 WASD+JKLUIO，P2 方向键+小键盘 1–6）。 */
export const KEY_DEFAULTS: Readonly<KeyBindings> = {
  p1: {
    up: 'KeyW',
    down: 'KeyS',
    left: 'KeyA',
    right: 'KeyD',
    attack: 'KeyJ',
    jump: 'KeyK',
    dash: 'KeyL',
    skill: 'KeyU',
    superSkill: 'KeyI',
    assist: 'KeyO',
  },
  p2: {
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    attack: 'Numpad1',
    jump: 'Numpad2',
    dash: 'Numpad3',
    skill: 'Numpad4',
    superSkill: 'Numpad5',
    assist: 'Numpad6',
  },
};

export function cloneBindings(b: Readonly<KeyBindings>): KeyBindings {
  return {
    p1: { ...b.p1 },
    p2: { ...b.p2 },
  };
}

/** 绑定：该键已被占用则与占用方交换；返回新副本（不改入参）。 */
export function bindKey(b: Readonly<KeyBindings>, player: KeyPlayer, action: KeyAction, code: string): KeyBindings {
  const next = cloneBindings(b);
  const old = next[player][action];
  if (old === code) return next;
  for (const p of KEY_PLAYERS) {
    for (const a of KEY_ACTIONS) {
      if (next[p][a.id] === code) next[p][a.id] = old;
    }
  }
  next[player][action] = code;
  return next;
}

export function isBindable(code: string): boolean {
  return code.length > 0 && code !== RESERVED_CODE;
}

/** 键 → ButtonMask 位映射表（battle 输入源用）；P1 额外挂 ESC → back。 */
export function keymapOf(b: Readonly<KeyBindings>, player: KeyPlayer): Record<string, number> {
  const m: Record<string, number> = {};
  for (const a of KEY_ACTIONS) m[b[player][a.id]] = a.btn;
  if (player === 'p1') m[RESERVED_CODE] = Btn.back;
  return m;
}

const NAMES: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: 'SPACE',
  Enter: 'ENTER',
  Backspace: 'BKSP',
  Tab: 'TAB',
  ShiftLeft: 'L-SHIFT',
  ShiftRight: 'R-SHIFT',
  ControlLeft: 'L-CTRL',
  ControlRight: 'R-CTRL',
  AltLeft: 'L-ALT',
  AltRight: 'R-ALT',
  NumpadEnter: 'NUM ENTER',
  NumpadAdd: 'NUM +',
  NumpadSubtract: 'NUM -',
  NumpadMultiply: 'NUM *',
  NumpadDivide: 'NUM /',
  NumpadDecimal: 'NUM .',
};

/** 物理键 code → 显示名（KeyW → W，Numpad1 → NUM 1）。 */
export function keyLabel(code: string): string {
  if (NAMES[code]) return NAMES[code]!;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `NUM ${code.slice(6)}`;
  return code;
}

/** 存档校验：结构完整、值为可绑定字符串、全局唯一，否则整组回落默认。 */
export function parseBindings(raw: unknown): KeyBindings {
  const fallback = cloneBindings(KEY_DEFAULTS);
  if (!raw || typeof raw !== 'object') return fallback;
  const r = raw as Partial<Record<KeyPlayer, Partial<Record<KeyAction, unknown>>>>;
  const out = cloneBindings(KEY_DEFAULTS);
  const seen = new Set<string>();
  for (const p of KEY_PLAYERS) {
    for (const a of KEY_ACTIONS) {
      const v = r[p]?.[a.id];
      if (typeof v !== 'string' || !isBindable(v) || seen.has(v)) return fallback;
      seen.add(v);
      out[p][a.id] = v;
    }
  }
  return out;
}
