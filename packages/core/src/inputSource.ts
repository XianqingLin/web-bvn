/**
 * 输入源抽象（切片 6 / DESIGN §9.7）：本地键盘、剧本回放、网络 lockstep
 * 统一实现此接口喂 sim——"输入从哪来"对 sim 不可见（契约硬规则 4：
 * 进入 sim 的只有 ButtonMask 位图）。本文件只是类型与纯逻辑实现，无 I/O。
 */
import type { ButtonMask, InputFrame } from './input.js';

export interface InputSource {
  /**
   * 返回 tick 帧的双人输入。
   * 返回 null 表示输入尚未就绪（网络源在等远端包）——调用方本帧不推进 sim，
   * 画面自然停步等待（lockstep 的减速语义）。
   * 本地源（键盘/剧本）恒即时返回。
   */
  frame(tick: number): InputFrame | null;
}

/** 剧本段（与 tools/replay 剧本 program 同构）。 */
export interface InputSegment {
  frames: number;
  p1?: ButtonMask;
  p2?: ButtonMask;
}

/** 剧本回放源：逐段展开为逐帧位图；越界回 0 位图（静止收尾）。 */
export class ScriptedInputSource implements InputSource {
  private readonly frames: InputFrame[];

  constructor(program: readonly InputSegment[]) {
    const frames: InputFrame[] = [];
    for (const seg of program) {
      for (let i = 0; i < (seg.frames ?? 0); i++) {
        frames.push({ p1: seg.p1 ?? 0, p2: seg.p2 ?? 0 });
      }
    }
    this.frames = frames;
  }

  frame(tick: number): InputFrame {
    return this.frames[tick] ?? { p1: 0, p2: 0 };
  }
}
