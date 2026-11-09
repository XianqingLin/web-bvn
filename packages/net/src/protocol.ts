/**
 * lockstep 最小协议（切片 6 / ADR-14）。
 * 中继只解析 welcome/hello/start（连接编排），input/hash 原样透传不解析——
 * 切片 7 房间服务器长出来时此表是消息词表的底稿。
 */
import { fnv1a, stableStringify, type ButtonMask } from '@bvn/core';

/** 玩家位次（= sim 里的 fighter id）。 */
export type PlayerSlot = 1 | 2;

export type NetMessage =
  /** 中继 → 客户端：连接建立，分配位次 */
  | { t: 'welcome'; player: PlayerSlot }
  /** 客户端 → 对端（经中继透传）：本端配置指纹，两端互验防错配 */
  | { t: 'hello'; player: PlayerSlot; configHash: string }
  /** 中继 → 双方：两玩家就绪，同时开跑 */
  | { t: 'start' }
  /** 单端单 tick 输入位图（lockstep 唯一的高频消息） */
  | { t: 'input'; tick: number; mask: ButtonMask }
  /** 定期失步检测（每 HASH_STRIDE tick 一次状态哈希） */
  | { t: 'hash'; tick: number; hash: string }
  /** 中继 → 存活方：对端断开 */
  | { t: 'peer-lost' };

/**
 * 对局配置指纹：seed + 舞台 + 角色标识。两端 hello 互验，
 * 不一致立刻报错而非跑到中途失步。
 */
export function makeConfigHash(info: {
  seed: number;
  stage: unknown;
  fighters: readonly unknown[];
}): string {
  return fnv1a(stableStringify(info));
}
