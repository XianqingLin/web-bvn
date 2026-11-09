/**
 * 会话助手（切片 7）：入房 + lockstart 客户端装配一步到位。
 * 流程：socket 已 OPEN → 发 create/join → 等 welcome/error →
 * LockstepClient 接管消息（自动发 hello 互验）→ 等 start 广播。
 */
import type { PlayerSlot } from './protocol.js';
import { LockstepClient, type LockstepOptions } from './lockstep.js';
import { wsTransport, type WsLike } from './transport.js';

export interface SessionOptions {
  /** create = 开新房（P1）；join = 加入指定房（P2） */
  action: 'create' | 'join';
  /** join 时必填的房间码 */
  room?: string | undefined;
  /** 透传给 LockstepClient（hello 指纹互验等） */
  configHash?: string | undefined;
  inputDelay?: number | undefined;
  hashStride?: number | undefined;
  /** 入房成功即回调（create 方可先拿到房间码展示，不必等对手） */
  onWelcome?: ((player: PlayerSlot, room: string) => void) | undefined;
  onDesync?: LockstepOptions['onDesync'];
  onPeerLost?: LockstepOptions['onPeerLost'];
  onConfigMismatch?: LockstepOptions['onConfigMismatch'];
}

export interface Session {
  client: LockstepClient;
  /** 服务器分配的位次（= fighter id） */
  player: PlayerSlot;
  room: string;
}

export class RoomJoinError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function startSession(socket: WsLike, opts: SessionOptions): Promise<Session> {
  if (opts.action === 'join' && !opts.room) {
    throw new Error('startSession：join 需要 room');
  }
  const welcome = await new Promise<{ player: PlayerSlot; room: string }>((res, rej) => {
    socket.onmessage = (ev) => {
      let msg: { t?: string; player?: PlayerSlot; room?: string; code?: string; message?: string };
      try {
        msg = JSON.parse(
          typeof ev.data === 'string' ? ev.data : (ev.data as { toString(): string }).toString(),
        );
      } catch {
        return;
      }
      if (msg.t === 'welcome') res({ player: msg.player!, room: msg.room! });
      else if (msg.t === 'error') rej(new RoomJoinError(msg.code!, msg.message ?? msg.code!));
    };
    socket.send(JSON.stringify(opts.action === 'create' ? { t: 'create' } : { t: 'join', room: opts.room }));
  });
  opts.onWelcome?.(welcome.player, welcome.room);
  const client = new LockstepClient({
    transport: wsTransport(socket),
    localPlayer: welcome.player,
    configHash: opts.configHash,
    inputDelay: opts.inputDelay,
    hashStride: opts.hashStride,
    onDesync: opts.onDesync,
    onPeerLost: opts.onPeerLost,
    onConfigMismatch: opts.onConfigMismatch,
  });
  await client.waitStarted();
  return { client, player: welcome.player, room: welcome.room };
}
