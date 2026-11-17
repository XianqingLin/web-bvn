/**
 * 平台联机适配器（联机迁移）：小林游戏铺平台中转 → bvn 房间协议（protocol.ts）。
 *
 * 平台是唯一权威（方案 A）：房间生命周期走 xlp.rooms（6 位房间码 + HMAC 凭证），
 * 游戏数据走 xlp.relay 的通用字节管道——bvn 协议消息原样作 ch='game' 的 JSON
 * payload，平台不解析内容。旧 room-server 的服务器语义在此本地合成：
 *   - create/join            → rooms.create/join 完成，welcome 由本端排队合成
 *   - hello 凑齐 → start 广播 → 双方 hello 各自确认后本地合成（重赛重放兼容：
 *     每轮 hello 交换各产生一次 start，与旧服务器"每次 hello 都检查"语义一致）
 *   - 对端断线/离开/房间解散  → peer-lost（冻结等待；去重，一次对局只报一次）
 *   - pick                    → 原样透传；onmessage 未接管期间到达的暂存、接管时补交
 *     （选人 UI 阶段的竞态兜底：对端收到本端 pick 即停发重发，不能只靠 3s 重发）
 *   - input/hash              → 原样透传（平台管道）
 *   - close()                → relay.leave()（旧语义：断开即离开；host 离开解散房间）
 *
 * 对端重连不做对局恢复：lockstep 双方 tick 状态无法对接（旧服务器同样无重连），
 * 重连后的新鲜客户端只会让本端停步冻结，由看门狗提示、玩家手动退出。
 *
 * 本文件只依赖 @xlp/game-sdk 的结构子集（duck typing），不引入包依赖——
 * app 层传入真实 SDK 对象即可。
 */
import type { NetMessage, PlayerSlot } from './protocol.js';
import { RoomJoinError } from './session.js';
import type { WsLike } from './transport.js';

/** 中转数据通道：bvn 全部协议消息走这一个通道。 */
export const GAME_CHANNEL = 'game';

// ---------- 平台 SDK 的结构子集（与 @xlp/game-sdk 对齐，避免包依赖） ----------

export interface PlatformRoomResult {
  room: { id: string; code: string };
  credential: string;
}

export interface PlatformRoomsApi {
  create(options?: { maxPlayers?: number }): Promise<PlatformRoomResult>;
  join(code: string): Promise<PlatformRoomResult>;
  leave(roomId: string): Promise<unknown>;
}

export interface PlatformRelayPlayer {
  playerId: string;
  role: string;
  connected: boolean;
}

export interface PlatformRelayRoom {
  players: PlatformRelayPlayer[];
}

export interface PlatformRelay {
  readonly status: 'connecting' | 'open' | 'closed';
  readonly you: { playerId: string; role: string } | null;
  readonly room: PlatformRelayRoom | null;
  readonly reconnected: boolean;
  onData(handler: (message: { payload: unknown; from: string }) => void): () => void;
  onPeers(handler: (room: PlatformRelayRoom | null) => void): () => void;
  onEvent(handler: (event: { t: string } & Record<string, unknown>) => void): () => void;
  onStatus(handler: (status: string, detail: unknown) => void): () => void;
  send(ch: string, payload: unknown): void;
  leave(): void;
  close(): void;
}

export interface PlatformSdkLike {
  rooms: PlatformRoomsApi;
  relay: { connect(credential: string): Promise<PlatformRelay> };
}

// ---------- 会话开启 ----------

export interface PlatformSessionOptions {
  action: 'create' | 'join';
  /** join 时的 6 位房间码 */
  roomCode?: string | undefined;
  /** 中转握手超时毫秒数（代理丢 upgrade 会永久挂起，必须显式超时） */
  connectTimeoutMs?: number | undefined;
}

export interface PlatformSession {
  /** 旧协议形状的套接字：直接喂给 joinRoom/sendPick/lockstart 等既有流程 */
  socket: RelaySocket;
  /** 平台角色映射的位次：host → P1，guest → P2 */
  player: PlayerSlot;
  /** 平台 6 位房间码 */
  room: string;
}

function toJoinError(err: unknown): RoomJoinError {
  const message = err instanceof Error ? err.message : String(err);
  const text = String(message);
  let code = 'join-failed';
  if (text.includes('不存在')) code = 'room-not-found';
  else if (text.includes('已满')) code = 'room-full';
  else if (text.includes('6 位')) code = 'bad-room-code';
  return new RoomJoinError(code, message);
}

/**
 * 开平台联机会话：建房/加入 → 凭证连中转 → 构造 RelaySocket。
 * resolve 后即等价于旧流程"WebSocket 已 open 且收到 welcome"。
 */
export async function openPlatformSession(
  sdk: PlatformSdkLike,
  opts: PlatformSessionOptions,
): Promise<PlatformSession> {
  const timeoutMs = opts.connectTimeoutMs ?? 10_000;
  let joined: PlatformRoomResult;
  try {
    joined =
      opts.action === 'join'
        ? await sdk.rooms.join((opts.roomCode ?? '').trim())
        : await sdk.rooms.create({ maxPlayers: 2 });
  } catch (err) {
    throw toJoinError(err);
  }
  const player: PlayerSlot = opts.action === 'join' ? 2 : 1;
  let relay: PlatformRelay;
  try {
    relay = await Promise.race([
      sdk.relay.connect(joined.credential),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('连接联机中转超时，请稍后重试')), timeoutMs),
      ),
    ]);
  } catch (err) {
    // 中转失败但房间已建：主动退出，避免留下空房。
    try {
      await sdk.rooms.leave(joined.room.id);
    } catch {
      /* 房间可能已被服务端回收 */
    }
    throw err;
  }
  return { socket: new RelaySocket(relay, player, joined.room.code), player, room: joined.room.code };
}

// ---------- RelaySocket：平台中转 → 旧协议 WsLike ----------

/** 中转事件给出的成员视图与本端角色，推出对手位。 */
function peerOf(view: PlatformRelayRoom | null, you: { playerId: string } | null): PlatformRelayPlayer | null {
  if (!view || !you) return null;
  return view.players.find((p) => p.playerId !== you.playerId) ?? null;
}

export class RelaySocket implements WsLike {
  /** WebSocket readyState 语义：1 = OPEN，3 = CLOSED */
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  private messageHandler: ((ev: { data: unknown }) => void) | null = null;

  /** onmessage 挂上前的入站消息（welcome 等），挂上后按序补交。 */
  private readonly pending: NetMessage[] = [];
  /** onmessage 未接管期间收到的最新 peer pick（见 onGamePayload 的竞态兜底）。 */
  private pendingPick: NetMessage | null = null;
  private selfHello = false;
  private peerHello = false;
  private peerLostSent = false;

  constructor(
    private readonly relay: PlatformRelay,
    /** 本端位次（host→1 / guest→2），仅用于合成 welcome */
    private readonly player: PlayerSlot,
    private readonly room: string,
  ) {
    relay.onData(({ payload }) => this.onGamePayload(payload));
    relay.onPeers((view) => this.onPeers(view));
    relay.onEvent((event) => {
      if (event.t === 'room-closed') this.sendPeerLost();
    });
    relay.onStatus((status) => {
      if (status === 'closed') this.markClosed(false);
    });
    // 入房回执：旧服务器 create/join → welcome；此处本地合成，排队交付。
    this.pending.push({ t: 'welcome', player: this.player, room: this.room });
  }

  /** joinRoom/sendPick/waitPeerPick/lockstart 均按此属性接管消息。 */
  get onmessage(): ((ev: { data: unknown }) => void) | null {
    return this.messageHandler;
  }
  set onmessage(handler: ((ev: { data: unknown }) => void) | null) {
    this.messageHandler = handler;
    if (handler) {
      this.flushPending();
      if (this.pendingPick) {
        const pick = this.pendingPick;
        this.pendingPick = null;
        this.deliver(pick);
      }
    }
  }

  send(text: string): void {
    if (this.readyState !== 1) return;
    let msg: NetMessage;
    try {
      msg = JSON.parse(text) as NetMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    if (msg.t === 'create' || msg.t === 'join') {
      // 入房已在 openPlatformSession 完成：吞掉，welcome 由 pending 兜底。
      return;
    }
    if (msg.t === 'hello') {
      this.selfHello = true;
    }
    try {
      this.relay.send(GAME_CHANNEL, msg);
    } catch {
      return; // 连接未就绪/已关闭：与旧 ws.send 静默失败同语义
    }
    if (msg.t === 'hello') this.maybeStart();
  }

  /** 旧语义：断开即离开房间（host 离开 → 解散，对端收到 peer-lost）。 */
  close(): void {
    if (this.readyState === 3) return;
    this.markClosed(true);
  }

  // ---------- 内部 ----------

  private markClosed(bySelf: boolean): void {
    this.readyState = 3;
    if (bySelf) {
      try {
        this.relay.leave();
      } catch {
        /* 已断线时 leave 可能失败，忽略 */
      }
    }
    try {
      this.relay.close();
    } catch {
      /* 幂等 */
    }
    this.onclose?.();
  }

  private flushPending(): void {
    if (!this.messageHandler || this.readyState === 3) return;
    while (this.pending.length > 0) {
      const msg = this.pending.shift()!;
      this.deliver(msg);
    }
  }

  private deliver(msg: NetMessage): void {
    if (!this.messageHandler || this.readyState === 3) return;
    this.messageHandler({ data: JSON.stringify(msg) });
  }

  private onGamePayload(payload: unknown): void {
    if (this.readyState === 3) return;
    const msg = payload as NetMessage | null;
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    if (msg.t === 'hello') {
      this.peerHello = true;
      this.deliver(msg);
      this.maybeStart();
      return;
    }
    if (msg.t === 'pick' && !this.messageHandler) {
      // 选人交换竞态兜底：app 在选人 UI 阶段（fighter/assist/map）不接管 onmessage，
      // 此时到达的对端 pick 会被 deliver 丢弃；而对端一收到本端 pick 就停止 3s
      // 重发——双方快速先后选完时互相等不到对方 pick（真机首验死锁）。暂存最新
      // 一条（重发覆盖），waitPeerPick 接管 onmessage 时补交。
      this.pendingPick = msg;
      return;
    }
    this.deliver(msg);
  }

  /** 双方 hello 凑齐 → 本地合成 start（不锁存：重赛每轮 hello 重放一次）。 */
  private maybeStart(): void {
    if (this.selfHello && this.peerHello) this.deliver({ t: 'start' });
  }

  private sendPeerLost(): void {
    if (this.peerLostSent || this.readyState === 3) return;
    this.peerLostSent = true;
    this.deliver({ t: 'peer-lost' });
  }

  /** onPeers 差分：对端断线或槽位消失 → peer-lost（去重）。对端重连不再通知。 */
  private onPeers(view: PlatformRelayRoom | null): void {
    if (this.readyState === 3) return;
    const peer = peerOf(view, this.relay.you);
    if (!peer || !peer.connected) this.sendPeerLost();
  }
}
