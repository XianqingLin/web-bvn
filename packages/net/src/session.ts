/**
 * 会话助手（切片 7；切片 14 拆段支持选人流程）。
 *
 * 联机生命周期与 socket 的 onmessage 单槽对应，按阶段接管：
 *   joinRoom      create/join → welcome（入房）
 *   sendReady/sendRoomConfig/sendBegin   房间语义上行（切片 34 房间页用）
 *   sendPick/waitPeerPick   选人结果交换（服务器透传 pick）
 *   lockstart     LockstepClient 接管（自动发 hello 互验）→ 等 start 广播
 * startSession = 三段一步到位（无选人流程的兼容入口）。
 */
import type { PlayerSlot, RoomSettings } from './protocol.js';
import { LockstepClient, type LockstepOptions } from './lockstep.js';
import { wsTransport, type WsLike } from './transport.js';

/** 本端选人结果（切片 14）：fighter = 角色包 id；assist = 辅助包 id；
 *  map 仅 P1 携带（两端地图以 P1 选择为准）。 */
export interface PickInfo {
  fighter: string;
  assist: string;
  map?: string | undefined;
}

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
  /** 显示昵称（进 room-info 快照） */
  name?: string | undefined;
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

/** 入房：create → 开新房（P1）；join → 凭码入房（P2）。resolve = 收到 welcome。
 *  name = 显示昵称（平台昵称；服务器进 room-info 快照）。 */
export async function joinRoom(
  socket: WsLike,
  action: 'create' | 'join',
  room?: string | undefined,
  onWelcome?: ((player: PlayerSlot, room: string) => void) | undefined,
  name?: string | undefined,
): Promise<{ player: PlayerSlot; room: string }> {
  if (action === 'join' && !room) {
    throw new Error('joinRoom：join 需要 room');
  }
  return new Promise<{ player: PlayerSlot; room: string }>((res, rej) => {
    socket.onmessage = (ev) => {
      let msg: { t?: string; player?: PlayerSlot; room?: string; code?: string; message?: string };
      try {
        msg = JSON.parse(
          typeof ev.data === 'string' ? ev.data : (ev.data as { toString(): string }).toString(),
        );
      } catch {
        return;
      }
      if (msg.t === 'welcome') {
        socket.onmessage = null;
        onWelcome?.(msg.player!, msg.room!);
        res({ player: msg.player!, room: msg.room! });
      } else if (msg.t === 'error') {
        socket.onmessage = null;
        rej(new RoomJoinError(msg.code!, msg.message ?? msg.code!));
      }
    };
    socket.send(JSON.stringify(action === 'create' ? { t: 'create', name } : { t: 'join', room, name }));
  });
}

// ---------- 房间语义客户端助手（切片 34，房间页用） ----------

/** 客座：准备状态切换（服务器更新快照后广播 room-info）。 */
export function sendReady(socket: WsLike, ready: boolean): void {
  socket.send(JSON.stringify({ t: 'ready', ready }));
}

/** 房主：设置变更（服务器合并进快照后广播 room-info）。 */
export function sendRoomConfig(socket: WsLike, settings: Partial<RoomSettings>): void {
  socket.send(JSON.stringify({ t: 'room-config', settings }));
}

/** 房主：请求开始（服务器校验客座已准备 → 双方广播 start 进选人页；
 *  未准备回非致命 error guest-not-ready）。 */
export function sendBegin(socket: WsLike): void {
  socket.send(JSON.stringify({ t: 'begin' }));
}

/** 发送本端选人结果（服务器透传给对端）。 */
export function sendPick(socket: WsLike, player: PlayerSlot, pick: PickInfo): void {
  socket.send(JSON.stringify({ t: 'pick', player, ...pick }));
}

/** 等对端选人结果。resolve 后清空 onmessage，交还下一阶段接管。 */
export function waitPeerPick(socket: WsLike, timeoutMs = 120_000): Promise<PickInfo> {
  return new Promise<PickInfo>((res, rej) => {
    const timer = setTimeout(() => {
      socket.onmessage = null;
      rej(new Error('waitPeerPick：等待对端选人超时'));
    }, timeoutMs);
    socket.onmessage = (ev) => {
      let msg: { t?: string; player?: PlayerSlot; fighter?: string; assist?: string; map?: string };
      try {
        msg = JSON.parse(
          typeof ev.data === 'string' ? ev.data : (ev.data as { toString(): string }).toString(),
        );
      } catch {
        return;
      }
      if (msg.t === 'pick') {
        clearTimeout(timer);
        socket.onmessage = null;
        res({ fighter: msg.fighter!, assist: msg.assist!, map: msg.map });
      }
    };
  });
}

/** lockstep 装配：LockstepClient（有 configHash 则发 hello 互验）→ 等 start 广播。 */
export async function lockstart(
  socket: WsLike,
  player: PlayerSlot,
  opts: {
    room?: string | undefined;
    configHash?: string | undefined;
    inputDelay?: number | undefined;
    hashStride?: number | undefined;
    onDesync?: LockstepOptions['onDesync'];
    onPeerLost?: LockstepOptions['onPeerLost'];
    onConfigMismatch?: LockstepOptions['onConfigMismatch'];
  } = {},
): Promise<Session> {
  const client = new LockstepClient({
    transport: wsTransport(socket),
    localPlayer: player,
    configHash: opts.configHash,
    inputDelay: opts.inputDelay,
    hashStride: opts.hashStride,
    onDesync: opts.onDesync,
    onPeerLost: opts.onPeerLost,
    onConfigMismatch: opts.onConfigMismatch,
  });
  await client.waitStarted();
  return { client, player, room: opts.room ?? '' };
}

export async function startSession(socket: WsLike, opts: SessionOptions): Promise<Session> {
  const { player, room } = await joinRoom(socket, opts.action, opts.room, opts.onWelcome, opts.name);
  return lockstart(socket, player, { ...opts, room });
}
