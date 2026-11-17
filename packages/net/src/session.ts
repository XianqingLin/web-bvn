/**
 * 会话助手（切片 7；切片 14 拆段支持选人流程；切片 35 双光标上行）。
 *
 * 联机生命周期与 socket 的 onmessage 单槽对应，按阶段接管：
 *   joinRoom      create/join → welcome（入房）
 *   sendReady/sendRoomConfig/sendBegin   房间语义上行（切片 34 房间页用）
 *   sendCursor/sendPick    选人页双光标上行（光标变更即广播；累计锁定覆盖式重发，
 *                          接收侧由场景自管消息泵——SetupScene 常驻 onmessage 分派）
 *   lockstart     LockstepClient 接管（自动发 hello 互验）→ 等 start 广播
 * startSession = 三段一步到位（无选人流程的兼容入口）。
 */
import type { LockedPicks, PlayerSlot, RoomSettings } from './protocol.js';
import { LockstepClient, type LockstepOptions } from './lockstep.js';
import { wsTransport, type WsLike } from './transport.js';

/** 本端选人结果（切片 14；切片 35 扩展）：fighter = 角色包 id；assist = 辅助包 id；
 *  map 仅 P1 携带（两端地图以 P1 选择为准）；
 *  locked = 选人页累计锁定快照（覆盖语义，选中即锁逐次上行）。 */
export interface PickInfo {
  fighter: string;
  assist: string;
  map?: string | undefined;
  locked?: LockedPicks | undefined;
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

// ---------- 匹配与浏览客户端助手（切片 37） ----------

/** 加入匹配队列（服务器两两配对 → matched + start；在房/已排队时忽略）。 */
export function sendQueue(socket: WsLike, name?: string): void {
  socket.send(JSON.stringify({ t: 'queue', name }));
}

/** 退出匹配队列。 */
export function sendUnqueue(socket: WsLike): void {
  socket.send(JSON.stringify({ t: 'unqueue' }));
}

/** 请求公开房间列表（浏览页轮询）。 */
export function sendListRooms(socket: WsLike): void {
  socket.send(JSON.stringify({ t: 'list-rooms' }));
}

/** 发送本端选人结果（服务器透传给对端）。累计锁定与最终结果共用本消息。 */
export function sendPick(socket: WsLike, player: PlayerSlot, pick: PickInfo): void {
  socket.send(JSON.stringify({ t: 'pick', player, ...pick }));
}

/** 选人/援助阶段光标位置上行（切片 35：变更即广播，服务器透传给对端；
 *  新位置覆盖旧位置，不依赖可靠有序通道）。 */
export function sendCursor(
  socket: WsLike,
  player: PlayerSlot,
  stage: 'fighter' | 'assist',
  idx: number,
): void {
  socket.send(JSON.stringify({ t: 'cursor', player, stage, idx }));
}

/** 房主：地图轮盘切换/确认上行（切片 36；服务器透传给对端，客座只读实时跟随）。
 *  map = 地图 id；轮盘随机项传 'random'（确认时由房主解析成具体 id 走最终 pick）。 */
export function sendMapPick(socket: WsLike, player: PlayerSlot, map: string): void {
  socket.send(JSON.stringify({ t: 'map-pick', player, map }));
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
