/**
 * 平台好友邀请接缝（platform-seam §4，切片 38 落地；2026-11-23）。
 *
 * 双向都是 postMessage 窄通道（sdk.send / hello join），平台只透传、不解析参数：
 * - 上报：进入可被邀请加入的房间时 `game:invite-context` 携带 { room, node }，
 *   回到菜单（房间已从玩家视角离开）时上报 null 清空。平台把最新值随好友邀请透传。
 * - 消费：经平台邀请打开游戏时，hello 的 join 字段携带 { room, node }。
 *   消费方 = 邀请票（invite-ticket.ts）：存票（接收窗口同时接管忙锁）→ 持锁
 *   窗口到主菜单后自动兑票入房（DESIGN §6.4）；本模块只负责 hello 参数的形状识别。
 */
import type { GameDockSdk } from '@gamedock/game-sdk';
import type { Flow } from './flow.js';

/** 上报当前邀请上下文；standalone（未在平台内运行）时 sdk.send 为 no-op。 */
export function reportInviteContext(flow: Flow, params: Record<string, unknown> | null): void {
  flow.dock?.send({ t: 'game:invite-context', params });
}

/**
 * 读取 hello 的邀请加入参数：bvn 侧只认 { room, node } 两个非空字符串字段，
 * 形状不符一律按无邀请处理（平台只透传，形状由游戏自证）。
 */
export function readInviteJoin(dock: GameDockSdk | null): { room: string; node: string } | null {
  const join = dock?.join;
  if (!join || typeof join !== 'object') return null;
  const room = (join as { room?: unknown }).room;
  const node = (join as { node?: unknown }).node;
  if (typeof room !== 'string' || !room || typeof node !== 'string' || !node) return null;
  return { room, node };
}
