/**
 * 输入系统：位图 + 可配置缓冲（DESIGN §3.3 / ADR-3）。
 * 契约硬规则 4：输入只以 ButtonMask 位图进入 sim；
 * just-down 与缓冲由 core 从位图历史本地推导，不存在"键盘状态"旁路。
 */

/**
 * 抽象按键位图（对齐原版 GameInputer 抽象键，module-map §5.5）：
 * 左/右/上/下/攻击/跳/瞬步/技能/必杀/辅助。
 * 防御 = down（原版 FighterKeyCtrler.defense() 即 ↓ 按住）；
 * 技/必杀的实际招式由 ±上/下 修饰（zhao1-3 / bisha 系）。
 */
export const Btn = {
  up: 1 << 0,
  down: 1 << 1,
  left: 1 << 2,
  right: 1 << 3,
  attack: 1 << 4,
  jump: 1 << 5,
  dash: 1 << 6,
  /** 技能键（原版 skill：单独=招1，+下=招2，+上=招3） */
  skill: 1 << 7,
  /** 必杀键（原版 superSkill：单独=必杀 100 气，+下=超必杀 300 气） */
  superSkill: 1 << 8,
  /** 辅助键（阶段后续接线） */
  assist: 1 << 9,
} as const;

export type ButtonMask = number;

export const ALL_BUTTONS: readonly number[] = Object.values(Btn);

export interface InputFrame {
  readonly p1: ButtonMask;
  readonly p2: ButtonMask;
}

/**
 * 触发型行为按下边沿后的有效窗口（帧）。
 * 设为 0 即退化为原版经典手感（ADR-3：一个常量取代模式概念）。
 */
export const INPUT_BUFFER_FRAMES = 6;

/**
 * 单个玩家的输入推导状态。
 * 属于 SimState 的一部分，必须保持可序列化（纯数据，无函数）。
 */
export interface PlayerInput {
  /** 上一 tick 的位图，just-down 推导用 */
  prevMask: ButtonMask;
  /** 每个按键剩余的缓冲帧数（>0 表示按下边沿仍在窗口内），与 ALL_BUTTONS 同序 */
  buffer: number[];
}

export function createPlayerInput(): PlayerInput {
  return { prevMask: 0, buffer: ALL_BUTTONS.map(() => 0) };
}

/**
 * 每 tick 的输入视图（瞬态，不进 SimState）：
 * 持续型行为（移动/防御）读 held；触发型行为（攻击/跳/技能）读 buffered/justDown。
 * consume() 消费缓冲，保证一次按下边沿只触发一个动作。
 */
export class InputView {
  constructor(
    private readonly pi: PlayerInput,
    readonly mask: ButtonMask,
    readonly justDownMask: ButtonMask,
  ) {}

  held(bit: number): boolean {
    return (this.mask & bit) !== 0;
  }

  justDown(bit: number): boolean {
    return (this.justDownMask & bit) !== 0;
  }

  buffered(bit: number): boolean {
    const idx = ALL_BUTTONS.indexOf(bit);
    return idx >= 0 && this.pi.buffer[idx]! > 0;
  }

  consume(bit: number): void {
    const idx = ALL_BUTTONS.indexOf(bit);
    if (idx >= 0) this.pi.buffer[idx] = 0;
  }
}

/** 推进一个玩家的输入状态一 tick，返回本 tick 的输入视图。 */
export function advancePlayerInput(pi: PlayerInput, mask: ButtonMask): InputView {
  const justDownMask = mask & ~pi.prevMask;
  for (let i = 0; i < ALL_BUTTONS.length; i++) {
    const bit = ALL_BUTTONS[i]!;
    if ((justDownMask & bit) !== 0) {
      pi.buffer[i] = INPUT_BUFFER_FRAMES;
    } else if (pi.buffer[i]! > 0) {
      pi.buffer[i] = pi.buffer[i]! - 1;
    }
  }
  pi.prevMask = mask;
  return new InputView(pi, mask, justDownMask);
}
