/**
 * lockstep + 房间协议（切片 6/7）。
 * 服务器解析连接编排（create/join/welcome/hello/start/error），
 * input/hash 原样透传给同房间对端，不解析。
 */
import { fnv1a, stableStringify, type ButtonMask } from '@bvn/core';

/** 玩家位次（= sim 里的 fighter id；create→1，join→2）。 */
export type PlayerSlot = 1 | 2;

export type NetMessage =
  /** 客户端 → 服务器：创建房间（成为 P1） */
  | { t: 'create' }
  /** 客户端 → 服务器：加入房间（成为 P2） */
  | { t: 'join'; room: string }
  /** 服务器 → 客户端：入房成功，分配位次与房间号 */
  | { t: 'welcome'; player: PlayerSlot; room: string }
  /** 服务器 → 客户端：入房失败（room-not-found / room-full），随后关闭连接 */
  | { t: 'error'; code: string; message?: string }
  /** 客户端 → 对端（经服务器透传）：本端配置指纹，两端互验防错配 */
  | { t: 'hello'; player: PlayerSlot; configHash: string }
  /** 客户端 → 对端（经服务器透传）：本端选人结果（切片 14，选人场景用）；
   *  map 仅 P1（create 方）携带，两端地图以 P1 选择为准 */
  | { t: 'pick'; player: PlayerSlot; fighter: string; assist: string; map?: string }
  /** 服务器 → 双方：两玩家就绪，同时开跑 */
  | { t: 'start' }
  /** 单端单 tick 输入位图（lockstep 唯一的高频消息） */
  | { t: 'input'; tick: number; mask: ButtonMask }
  /** 定期失步检测（每 HASH_STRIDE tick 一次状态哈希） */
  | { t: 'hash'; tick: number; hash: string }
  /** 服务器 → 存活方：对端断开（断线处理 = 冻结等待，判负归阶段 4） */
  | { t: 'peer-lost' };

/**
 * 对局配置指纹：seed + 舞台 + 角色标识（+ 辅助，切片 14 联机注入）。
 * 两端 hello 互验，不一致立刻报错而非跑到中途失步。
 */
export function makeConfigHash(info: {
  seed: number;
  stage: unknown;
  fighters: readonly unknown[];
  assists?: readonly unknown[];
}): string {
  return fnv1a(stableStringify(info));
}
