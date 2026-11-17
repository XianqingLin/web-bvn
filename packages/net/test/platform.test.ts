/**
 * 平台联机适配器测试：内存假平台（rooms/relay 语义对齐 xiao-lin-game-shop
 * server/rooms.mjs + relay.mjs），验证 RelaySocket 对旧协议语义的合成与透传。
 *
 *  1. openPlatformSession create/join → joinRoom 兼容（welcome 本地合成）；
 *  2. 入房失败（房间不存在/已满）→ RoomJoinError；
 *  3. hello 凑齐 → start 本地合成（两个方向到达顺序都成立）；
 *  4. pick/input/hash 经 ch='game' payload 端到端透传；pick 早到（接管前）暂存补交；
 *  5. 对端断线 / 房间解散 → peer-lost（去重）；
 *  6. close() → leave + onclose（旧语义：断开即离开）；
 *  7. 端到端：两端经假平台对跑一段 lockstep，finalHash 与单机直跑一致。
 */
import { describe, expect, it } from 'vitest';
import { Btn, createDefaultConfig, ScriptedInputSource, Sim, type ButtonMask } from '@bvn/core';
import {
  joinRoom,
  lockstart,
  makeConfigHash,
  openPlatformSession,
  RelaySocket,
  RoomJoinError,
  sendPick,
  waitPeerPick,
  type PlatformRelayPlayer,
  type PlatformRelayRoom,
  type PlatformRoomsApi,
  type PlatformSdkLike,
} from '../src/index.js';

const CFG_HASH = makeConfigHash({
  seed: 1,
  stage: createDefaultConfig(1).stage,
  fighters: ['ichigo', 'ichigo'],
});

// ---------- 内存假平台 ----------

interface FakeMember {
  playerId: string;
  role: string;
  connected: boolean;
  socket: FakeRelay | null;
}

/** 单连接侧影：SDK RelayConnection 的假体。 */
class FakeRelay {
  status: 'connecting' | 'open' | 'closed' = 'open';
  reconnected = false;
  onDataCb: ((m: { payload: unknown; from: string }) => void) | null = null;
  onPeersCb: ((room: PlatformRelayRoom | null) => void) | null = null;
  onEventCb: ((e: { t: string } & Record<string, unknown>) => void) | null = null;
  onStatusCb: ((status: string, detail: unknown) => void) | null = null;
  left = false;
  closed = false;
  sent: { ch: string; payload: unknown }[] = [];

  constructor(
    private readonly server: FakePlatform,
    readonly you: { playerId: string; role: string },
    readonly roomId: string,
  ) {}

  get room(): PlatformRelayRoom | null {
    const room = this.server.rooms.get(this.roomId);
    if (!room) return null;
    return { players: room.map((m): PlatformRelayPlayer => ({ playerId: m.playerId, role: m.role, connected: m.connected })) };
  }

  onData(handler: (m: { payload: unknown; from: string }) => void): () => void {
    this.onDataCb = handler;
    return () => {};
  }
  onPeers(handler: (room: PlatformRelayRoom | null) => void): () => void {
    this.onPeersCb = handler;
    return () => {};
  }
  onEvent(handler: (e: { t: string } & Record<string, unknown>) => void): () => void {
    this.onEventCb = handler;
    return () => {};
  }
  onStatus(handler: (status: string, detail: unknown) => void): () => void {
    this.onStatusCb = handler;
    return () => {};
  }

  send(ch: string, payload: unknown): void {
    if (this.status !== 'open') throw new Error('not open');
    this.sent.push({ ch, payload });
    const peer = this.server.peerOf(this.you.playerId, this.roomId);
    if (peer?.socket?.onDataCb) peer.socket.onDataCb({ payload, from: this.you.playerId });
  }

  leave(): void {
    this.left = true;
    this.server.remove(this.you.playerId, this.roomId);
  }

  close(): void {
    this.closed = true;
  }

  /** 服务端视角：断开本连接（槽位保留，模拟网络断线）。 */
  drop(): void {
    this.status = 'closed';
    const member = this.server.memberOf(this.you.playerId, this.roomId);
    if (member) member.connected = false;
    this.server.broadcastPeers(this.roomId);
    this.onStatusCb?.('closed', { code: 1006, reason: 'abnormal' });
  }
}

interface FakeRoom {
  code: string;
  members: FakeMember[];
}

/** 房间 + 成员的内存服务端。 */
class FakePlatform {
  rooms = new Map<string, FakeRoom>();
  private nextId = 1;

  create(): { room: { id: string; code: string }; credential: string } {
    const id = `room-${this.nextId++}`;
    const code = String(100000 + this.nextId * 137).slice(0, 6);
    this.rooms.set(id, { code, members: [] });
    return { room: { id, code }, credential: `cred-${id}` };
  }

  join(code: string): { room: { id: string; code: string }; credential: string } {
    for (const [id, room] of this.rooms) {
      if (room.code !== code) continue;
      if (room.members.length >= 2) throw new Error('房间已满');
      return { room: { id, code }, credential: `cred-${id}` };
    }
    throw new Error('房间不存在或已解散');
  }

  connect(credential: string): FakeRelay {
    const roomId = credential.slice(5);
    const room = this.rooms.get(roomId);
    if (!room) throw new Error('房间不存在或已解散');
    const playerId = `p${this.nextId++}`;
    const role = room.members.length === 0 ? 'host' : 'guest';
    const socket = new FakeRelay(this, { playerId, role }, roomId);
    room.members.push({ playerId, role, connected: true, socket });
    this.broadcastPeers(roomId);
    return socket;
  }

  memberOf(playerId: string, roomId: string): FakeMember | undefined {
    return this.rooms.get(roomId)?.members.find((m) => m.playerId === playerId);
  }

  peerOf(playerId: string, roomId: string): FakeMember | undefined {
    return this.rooms.get(roomId)?.members.find((m) => m.playerId !== playerId);
  }

  remove(playerId: string, roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const idx = room.members.findIndex((m) => m.playerId === playerId);
    if (idx >= 0) room.members.splice(idx, 1);
    if (room.members.length === 0) this.rooms.delete(roomId);
    else this.broadcastPeers(roomId);
  }

  broadcastPeers(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const view: PlatformRelayRoom = {
      players: room.members.map((m) => ({ playerId: m.playerId, role: m.role, connected: m.connected })),
    };
    for (const m of room.members) m.socket?.onPeersCb?.(view);
  }

  roomClosed(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const m of room.members) m.socket?.onEventCb?.({ t: 'room-closed' });
    this.rooms.delete(roomId);
  }
}

function fakeSdk(server: FakePlatform): PlatformSdkLike {
  const rooms: PlatformRoomsApi = {
    create: async () => server.create(),
    join: async (code) => server.join(code),
    leave: async () => ({ closed: true }),
  };
  return { rooms, relay: { connect: async (credential) => server.connect(credential) } };
}

/** 开一对互通的平台会话（host + guest 同房）。 */
async function pair(): Promise<{ host: RelaySocket; guest: RelaySocket; server: FakePlatform; roomId: string }> {
  const server = new FakePlatform();
  const sdk = fakeSdk(server);
  const hostSession = await openPlatformSession(sdk, { action: 'create' });
  const guestSession = await openPlatformSession(sdk, { action: 'join', roomCode: hostSession.room });
  const roomId = Array.from(server.rooms.keys())[0];
  return { host: hostSession.socket, guest: guestSession.socket, server, roomId };
}

function collect(socket: RelaySocket): { t: string }[] {
  const seen: { t: string }[] = [];
  socket.onmessage = (ev) => seen.push(JSON.parse(String(ev.data)));
  return seen;
}

// ---------- 用例 ----------

describe('openPlatformSession', () => {
  it('create → host 位次 P1，joinRoom 兼容（welcome 本地合成）', async () => {
    const server = new FakePlatform();
    const session = await openPlatformSession(fakeSdk(server), { action: 'create' });
    expect(session.player).toBe(1);
    expect(session.room).toMatch(/^\d{6}$/);
    const welcome = await joinRoom(session.socket, 'create');
    expect(welcome.player).toBe(1);
    expect(welcome.room).toBe(session.room);
  });

  it('join → guest 位次 P2，双方同房', async () => {
    const { host, guest, server, roomId } = await pair();
    void host;
    const welcome = await joinRoom(guest, 'join', server.rooms.get(roomId)!.code);
    expect(welcome.player).toBe(2);
    expect(welcome.room).toBe(server.rooms.get(roomId)!.code);
    expect(server.rooms.get(roomId)!.members).toHaveLength(2);
  });

  it('join 不存在的房间 → RoomJoinError', async () => {
    const server = new FakePlatform();
    await expect(openPlatformSession(fakeSdk(server), { action: 'join', roomCode: '999999' })).rejects.toThrow(
      RoomJoinError,
    );
  });

  it('join 已满的房间 → RoomJoinError', async () => {
    const server = new FakePlatform();
    const sdk = fakeSdk(server);
    const first = await openPlatformSession(sdk, { action: 'create' });
    await openPlatformSession(sdk, { action: 'join', roomCode: first.room });
    await expect(openPlatformSession(sdk, { action: 'join', roomCode: first.room })).rejects.toThrow(
      RoomJoinError,
    );
  });
});

describe('RelaySocket 协议合成', () => {
  it('双方 hello 凑齐 → start（各自方向独立合成）', async () => {
    const { host, guest } = await pair();
    const hostSeen = collect(host);
    const guestSeen = collect(guest);
    host.send(JSON.stringify({ t: 'hello', player: 1, configHash: 'A' }));
    expect(hostSeen.some((m) => m.t === 'start')).toBe(false);
    guest.send(JSON.stringify({ t: 'hello', player: 2, configHash: 'A' }));
    expect(hostSeen.some((m) => m.t === 'start')).toBe(true);
    expect(guestSeen.some((m) => m.t === 'start')).toBe(true);
  });

  it('对端 hello 早到（接管前无人监听）→ 排队，接管后按序补交 hello+start', async () => {
    const { host, guest } = await pair();
    guest.send(JSON.stringify({ t: 'hello', player: 2, configHash: 'A' }));
    const seen = collect(host);
    host.send(JSON.stringify({ t: 'hello', player: 1, configHash: 'A' }));
    const ts = seen.map((m) => m.t);
    expect(ts).toContain('welcome');
    expect(ts.indexOf('hello')).toBeLessThan(ts.indexOf('start'));
  });

  it('pick/input/hash 经 payload 端到端透传', async () => {
    const { host, guest } = await pair();
    const guestSeen = collect(guest);
    sendPick(host, 1, { fighter: 'ichigo', assist: 'gaara', map: 'KonohaMura' });
    host.send(JSON.stringify({ t: 'input', tick: 7, mask: Btn.attack }));
    host.send(JSON.stringify({ t: 'hash', tick: 60, hash: 'abc' }));
    const ts = guestSeen.map((m) => m.t);
    expect(ts).toContain('pick');
    expect(ts).toContain('input');
    expect(ts).toContain('hash');
    const pick = guestSeen.find((m) => m.t === 'pick') as { map?: string };
    expect(pick.map).toBe('KonohaMura');
  });

  it('对端断线 → peer-lost 一次（去重）；房间解散事件不重复报', async () => {
    const { host, guest, server, roomId } = await pair();
    const hostSeen = collect(host);
    const guestRelay = (guest as unknown as { relay: FakeRelay }).relay;
    void guest;
    guestRelay.drop();
    expect(hostSeen.filter((m) => m.t === 'peer-lost')).toHaveLength(1);
    server.roomClosed(roomId);
    expect(hostSeen.filter((m) => m.t === 'peer-lost')).toHaveLength(1);
  });

  it('close() → relay.leave + onclose；对端视图更新为 peer-lost', async () => {
    const { host, guest, server, roomId } = await pair();
    const guestSeen = collect(guest);
    let closed = false;
    host.onclose = () => {
      closed = true;
    };
    host.close();
    expect(closed).toBe(true);
    expect((host as unknown as { relay: FakeRelay }).relay.left).toBe(true);
    expect(guestSeen.some((m) => m.t === 'peer-lost')).toBe(true);
    expect(server.rooms.get(roomId)!.members).toHaveLength(1);
  });
});

describe('端到端 lockstep（经假平台管道）', () => {
  // 与 lockstep.test.ts 同构的程序段
  const PROGRAM = [
    { frames: 20, p1: Btn.right, p2: 0 },
    { frames: 10, p1: Btn.right | Btn.attack, p2: Btn.jump },
    { frames: 15, p1: 0, p2: Btn.down | Btn.attack },
  ] as const;
  const TOTAL_TICKS = PROGRAM.reduce((n, s) => n + s.frames, 0);
  const scripted = () => new ScriptedInputSource(PROGRAM);

  function direct(): string {
    const sim = new Sim(createDefaultConfig(1));
    const src = scripted();
    let hash = '';
    for (let t = 0; t < TOTAL_TICKS; t++) hash = sim.tick(src.frame(t)).hash;
    return hash;
  }

  it('两端经平台中转对跑剧本：finalHash 等于单机直跑', async () => {
    const { host, guest } = await pair();
    // lockstart 内部发 hello 并等 start（start 由适配器在双方 hello 凑齐时合成）；
    // 两端必须并发启动：串行 await 会死锁（host 等 guest 的 hello，guest 还没发）
    const hostStart = lockstart(host, 1, { configHash: CFG_HASH });
    const guestStart = lockstart(guest, 2, { configHash: CFG_HASH });
    const a = await hostStart;
    const b = await guestStart;
    const srcA = scripted();
    const srcB = scripted();
    const pa = (t: number): ButtonMask => srcA.frame(t).p1;
    const pb = (t: number): ButtonMask => srcB.frame(t).p2;
    // 与 app 主循环同构：预填延迟窗口 → frame → tick → afterTick → poll
    for (let k = 0; k < 3; k++) {
      a.client.poll(pa(k));
      b.client.poll(pb(k));
    }
    const simA = new Sim(createDefaultConfig(1));
    const simB = new Sim(createDefaultConfig(1));
    let hashA = '';
    let hashB = '';
    for (let t = 0; t < TOTAL_TICKS; t++) {
      const fa = a.client.frame(t);
      const fb = b.client.frame(t);
      if (!fa || !fb) throw new Error(`tick ${t} 输入未就绪（同线程同步送达，不应停步）`);
      const sa = simA.tick(fa);
      a.client.afterTick(sa.tick, sa.hash);
      a.client.poll(pa(t + 3));
      hashA = sa.hash;
      const sb = simB.tick(fb);
      b.client.afterTick(sb.tick, sb.hash);
      b.client.poll(pb(t + 3));
      hashB = sb.hash;
    }
    expect(hashA).toBe(hashB);
    expect(hashA).toBe(direct());
  }, 15_000);

  it('waitPeerPick 透传 map 字段（P1 地图选择到达 P2）', async () => {
    const { host, guest } = await pair();
    // 先挂监听再发送：正常路径，pick 直达
    const pending = waitPeerPick(guest);
    sendPick(host, 1, { fighter: 'ichigo', assist: 'gaara', map: 'HuecoMundo' });
    const peer = await pending;
    expect(peer.map).toBe('HuecoMundo');
  });

  it('pick 早到（接管前）→ 暂存，waitPeerPick 接管时补交（选人竞态回归）', async () => {
    const { host, guest } = await pair();
    // host 先进交换页发 pick，guest 还在选人 UI（onmessage 空）——
    // 真机死锁场景：host 收到 guest 的 pick 后停止重发，guest 必须靠暂存补交
    sendPick(host, 1, { fighter: 'ichigo', assist: 'gaara', map: 'KonohaMura' });
    const peer = await waitPeerPick(guest);
    expect(peer.fighter).toBe('ichigo');
    expect(peer.assist).toBe('gaara');
    expect(peer.map).toBe('KonohaMura');
  });

  it('接管前多条 pick 到达 → 只补交最新一条', async () => {
    const { host, guest } = await pair();
    sendPick(host, 1, { fighter: 'ichigo', assist: 'gaara' });
    sendPick(host, 1, { fighter: 'naruto', assist: 'sakura' });
    const peer = await waitPeerPick(guest);
    expect(peer.fighter).toBe('naruto');
    expect(peer.assist).toBe('sakura');
  });
});
