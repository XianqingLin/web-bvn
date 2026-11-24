/**
 * 联机入口共享助手：建连入房与失败文案，供联机菜单浮层复用。
 */
import { BufferedSocket, joinRoom, RoomJoinError, type WsLike } from '@bvn/net';
import type { Flow } from '../flow.js';

/** 连接房间服务器（open 前的异常/close/error 统一转 rejection）。 */
export function openServerSocket(serverUrl: string): Promise<WebSocket> {
  return new Promise((res, rej) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(serverUrl);
    } catch (e) {
      rej(e);
      return;
    }
    ws.onopen = () => {
      ws.onclose = null;
      ws.onerror = null;
      res(ws);
    };
    ws.onclose = () => rej(new Error('closed'));
    ws.onerror = () => rej(new Error('error'));
  });
}

/**
 * 建连并入房（create/join 共用流程）：开 WebSocket → BufferedSocket 包装 →
 * joinRoom 握手，成功后回填 flow.player / room / name。resolve = 入房成功，
 * socket 所有权移交调用方（后续 close / 场景移交由调用方负责）；
 * reject = 建连失败（Error）或入房被拒（RoomJoinError，code = 服务器错误码）。
 * 等待期连接断开会走 onclose 拒绝（joinRoom 不监听 onclose，此处补出口防悬挂）。
 */
export async function enterRoom(
  flow: Flow,
  action: 'create' | 'join',
  room?: string,
): Promise<{ socket: BufferedSocket; player: 1 | 2; room: string }> {
  const ws = await openServerSocket(flow.serverUrl);
  const socket = new BufferedSocket(ws as unknown as WsLike);
  const closed = new Promise<never>((_, rej) => {
    socket.onclose = () => rej(new RoomJoinError('closed', '连接已断开'));
  });
  try {
    // 昵称取平台资料（duck typing）；standalone 回退"玩家N"（服务器侧清洗）
    const name = displayName(flow);
    const joined = await Promise.race([
      joinRoom(socket, action, room || undefined, undefined, name || undefined),
      closed,
    ]);
    flow.player = joined.player;
    flow.room = joined.room;
    flow.name = name || `玩家${joined.player}`;
    return { socket, player: joined.player, room: joined.room };
  } catch (e) {
    socket.close();
    throw e;
  } finally {
    socket.onclose = null;
  }
}

/** 入房失败的用户可读文案（区分建连失败与服务器拒绝；UI 直接上屏）。 */
export function roomErrorText(e: unknown): string {
  if (e instanceof RoomJoinError) {
    if (e.code === 'room-not-found') return '房间不存在（核对房码）';
    if (e.code === 'room-full') return '房间已满或已开局';
    if (e.code === 'closed') return '连接已断开';
    return `入房失败：${e.message}`;
  }
  return '无法连接服务器（检查地址与服务器是否在线）';
}

/** 本端显示昵称（平台资料 duck typing；standalone 回退空串由服务器清洗）。 */
export function displayName(flow: Flow): string {
  return flow.dock?.user?.username ?? '';
}
