/**
 * 游戏设置（设置面板切片，2026-11-24）：原版 ConfigVO 的 soundVolume/bgmVolume 对位。
 *
 * - localStorage `bvn.settings` 持久化；缺项/损坏回落默认值并 clamp 到 [0,1]。
 * - 偏离原版登记（原 ConfigVO 默认 1.0、六档 0/10/30/50/70/100）：
 *   ① 默认值 0.3（产品决策，2026-11-24 定 0.6，2026-11-25 改为 0.3）；
 *   ② 档位改为 0~100% 每 10% 一档、循环切档（11 档，容纳默认 60% 档位；
 *      循环语义同原版 SetBtn.prev/nextOption）；
 *   ③ 生效语义：音量属低风险项，即改即存；键位走 APPLY 语义（二级页内草稿，
 *      APPLY 才落盘，见 scenes/settings.ts 与 keymap.ts）。
 * - 变更传播：写 `ctx.events` 的 SETTINGS_CHANGED（子系统互不 import 契约，
 *   AudioSubsystem 订阅并应用到 sfx/bgm 双总线 GainNode）。
 */
import { cloneBindings, KEY_DEFAULTS, parseBindings, type KeyBindings } from './keymap.js';

export interface GameSettings {
  /** 音效总音量（0~1；sfx 总线，覆盖 SE/语音/贴帧音/UI 音） */
  soundVolume: number;
  /** 背景音乐总音量（0~1；bgm 总线） */
  bgmVolume: number;
  /** 键位（P1/P2 各 10 个动作 → e.code；见 keymap.ts） */
  keys: KeyBindings;
}

export const SETTINGS_DEFAULTS: Readonly<Omit<GameSettings, 'keys'>> = {
  soundVolume: 0.3,
  bgmVolume: 0.3,
};

const STORE_KEY = 'bvn.settings';

/** 设置变更事件类型（ctx.events 广播；payload = GameSettings）。 */
export const SETTINGS_CHANGED = 'settings:changed';

function clamp01(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return NaN;
  return Math.min(1, Math.max(0, v));
}

export function loadSettings(): GameSettings {
  const s: GameSettings = { ...SETTINGS_DEFAULTS, keys: cloneBindings(KEY_DEFAULTS) };
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Partial<GameSettings>;
    const sound = clamp01(raw.soundVolume);
    const bgm = clamp01(raw.bgmVolume);
    if (!Number.isNaN(sound)) s.soundVolume = sound;
    if (!Number.isNaN(bgm)) s.bgmVolume = bgm;
    s.keys = parseBindings(raw.keys);
  } catch {
    // 存档损坏 → 全默认
  }
  return s;
}

export function saveSettings(s: GameSettings): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(s));
}
