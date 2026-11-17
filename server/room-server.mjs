#!/usr/bin/env node
/**
 * 房间服务器（切片 7 基础；切片 34 房间语义扩展；切片 37 匹配队列与浏览列表）。
 * 只做房间编排与输入中继，不跑模拟。
 *
 * 职责：
 *   1. create/join（带昵称）→ 分配位次入房，welcome + room-info 快照；
 *   2. 房间语义（服务器解析，快照经 room-info 广播；设计见 docs/netplay-design.md §9）：
 *      - room-config  房主改设置 → 合并后广播 room-info；
 *      - ready        客座准备切换 → 广播 room-info；
 *      - begin        房主请求开始 → 校验客座已准备 → 广播 start（进选人页），
 *                     hello 计数清零；未准备回非致命 error（guest-not-ready）；
 *   3. hello 收齐 → 广播 start（第二段：进对局；与 begin 的 start 两段语义）；
 *   4. UI 同步类（cursor/map-pick）与对局类（input/hash/pick）原样透传给对端；
 *   5. 权威种子（切片 36，netplay-design §8/§9）：begin 时生成随机种子并广播
 *      map-roll，两端共享——开箱抽取动画的定格结果与对局 sim seed 都由它解析；
 *   6. 匹配队列（切片 37，netplay-design §6/§9）：queue 入队，满 2 即配对——
 *      服务器开好房间并直接置为开局段（免房间页/准备门，匹配固定
 *      team=true + 随机地图），双方收 matched（含权威 seed）+ start；
 *      unqueue 退队；掉线自动出队；已配对的种子兼作 sim seed 进 configHash；
 *   7. 浏览列表（切片 37，netplay-design §5）：list-rooms 轮询 → room-list
 *      快照（公开房：房主昵称/团队标记/可加入状态），服务器不做主动推送；
 *   8. 断线清理（netplay-design.md §10）：
 *      - 未开局客座掉线 → 房间保留，房主收 peer-lost + room-info，可继续等待/邀请；
 *      - 房主掉线或已开局后任何一方掉线 → 房间解散（peer-lost，房码失效）；
 *      - 已开局房间拒绝 join（复用 room-full），无重连。
 *
 * 用法：PORT=8787 node room-server.mjs   （PORT=0 → 随机端口，打印到 stdout）
 */
import { randomInt } from 'node:crypto';
import { WebSocketServer } from 'ws';

const port = Number(process.env.PORT ?? 8787);

/** 房间码：4 位无易混字符（0/O/1/I/L 剔除） */
function newRoomCode(rooms) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += alphabet[randomInt(alphabet.length)];
    if (!rooms.has(c)) return c;
  }
}

/** 昵称清洗：trim + 截 20 字符，空回退"玩家N" */
function cleanName(raw, slot) {
  const s = typeof raw === 'string' ? raw.trim().slice(0, 20) : '';
  return s || `玩家${slot}`;
}

/**
 * 每连接状态（切片 37 由闭包变量改为记录对象：匹配配对要跨连接写槽位）。
 * @type {{
 *   ws: import('ws').WebSocket,
 *   room: ReturnType<typeof newRoom> | null,
 *   player: 0 | 1 | 2,
 *   queued: boolean,
 *   queueName: string,
 * }}
 */
// （类型仅为注释说明；运行时是普通对象）

/** @type {Map<string, {
 *   id: string,
 *   players: Map<number, import('ws').WebSocket>,
 *   names: Map<number, string>,
 *   ready: Map<number, boolean>,
 *   helloed: Set<number>,
 *   settings: {public: boolean, randomMap: boolean, team: boolean},
 *   started: boolean,
 *   dead: boolean,
 * }>} */
const rooms = new Map();

/** 匹配队列（FIFO，存每连接记录；满 2 即配对，切片 37）。 @type {object[]} */
const matchQueue = [];

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function peerOf(room, player) {
  return room.players.get(player === 1 ? 2 : 1) ?? null;
}

function roomInfoMsg(room) {
  return {
    t: 'room-info',
    room: room.id,
    started: room.started,
    settings: { ...room.settings },
    players: [1, 2]
      .filter((p) => room.players.has(p))
      .map((p) => ({
        player: p,
        name: room.names.get(p) ?? `玩家${p}`,
        ready: room.ready.get(p) ?? false,
      })),
  };
}

function broadcastRoomInfo(room) {
  for (const p of room.players.values()) send(p, roomInfoMsg(room));
}

/** 公开房间快照（浏览列表；started 房也列出但 joinable=false，§5 可加入/已满状态）。 */
function roomListMsg() {
  const list = [];
  for (const room of rooms.values()) {
    if (room.dead || !room.settings.public) continue;
    list.push({
      room: room.id,
      host: room.names.get(1) ?? '玩家1',
      team: room.settings.team,
      joinable: !room.started && room.players.size < 2,
      started: room.started,
    });
  }
  return { t: 'room-list', rooms: list };
}

/** 解散房间：通知剩余成员后销毁，房码失效（their ws 之后 close 不再处理）。 */
function dissolve(room) {
  room.dead = true;
  rooms.delete(room.id);
  for (const p of room.players.values()) send(p, { t: 'peer-lost' });
  room.players.clear();
}

/** 出队（掉线/unqueue/自行入房共用）。 */
function unqueue(conn) {
  if (!conn.queued) return;
  conn.queued = false;
  const i = matchQueue.indexOf(conn);
  if (i >= 0) matchQueue.splice(i, 1);
}

/**
 * 配对（切片 37）：出队两个存活连接 → 开房并直接置为开局段。
 * 匹配固定属性（netplay-design §6）：team=true + randomMap=true，不提供选项；
 * 免房间页/准备门（偏离登记：设计稿"matched 后走 create/join 等价路径"收敛为
 * 服务器直接装配——同一条连接、同一套房间机器，少两轮 ready/begin 往返）。
 */
function matchPair() {
  for (let i = matchQueue.length - 1; i >= 0; i--) {
    if (matchQueue[i].ws.readyState !== 1) {
      matchQueue[i].queued = false;
      matchQueue.splice(i, 1);
    }
  }
  while (matchQueue.length >= 2) {
    const a = matchQueue.shift();
    const b = matchQueue.shift();
    a.queued = false;
    b.queued = false;
    const room = {
      id: newRoomCode(rooms),
      players: new Map([
        [1, a.ws],
        [2, b.ws],
      ]),
      names: new Map([
        [1, a.queueName],
        [2, b.queueName],
      ]),
      ready: new Map(),
      helloed: new Set(),
      settings: { public: false, randomMap: true, team: true },
      started: true, // 出生即开局段：matched → start 直进选人页
      dead: false,
    };
    rooms.set(room.id, room);
    a.room = room;
    a.player = 1;
    b.room = room;
    b.player = 2;
    const seed = randomInt(1, 2 ** 31); // 权威种子：兼作 sim seed（切片 36 语义）
    const common = { t: 'matched', room: room.id, team: true, seed };
    send(a.ws, { ...common, player: 1, opponent: { name: b.queueName } });
    send(b.ws, { ...common, player: 2, opponent: { name: a.queueName } });
    for (const ws of room.players.values()) send(ws, { t: 'start' });
  }
}

const wss = new WebSocketServer({ port });

wss.on('connection', (ws) => {
  /** 每连接记录（闭包内使用；跨连接访问仅发生在 matchPair 装配槽位处） */
  const conn = { ws, room: null, player: 0, queued: false, queueName: '' };

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const room = conn.room;
    const player = conn.player;
    switch (msg.t) {
      case 'create': {
        if (room) return;
        unqueue(conn); // 有了别的入房路径，不再参与匹配
        const id = newRoomCode(rooms);
        const r = {
          id,
          players: new Map([[1, ws]]),
          names: new Map([[1, cleanName(msg.name, 1)]]),
          ready: new Map(),
          helloed: new Set(),
          settings: { public: false, randomMap: false, team: false },
          started: false,
          dead: false,
        };
        rooms.set(id, r);
        conn.room = r;
        conn.player = 1;
        send(ws, { t: 'welcome', player: 1, room: id });
        broadcastRoomInfo(r);
        break;
      }
      case 'join': {
        if (room) return;
        unqueue(conn); // 有了别的入房路径，不再参与匹配
        const r = rooms.get(String(msg.room ?? '').trim().toUpperCase());
        if (!r) {
          send(ws, { t: 'error', code: 'room-not-found', message: `房间不存在：${msg.room}` });
          ws.close();
          return;
        }
        // 已开局房间拒绝加入：复用 room-full（netplay-design.md §10 定案）
        if (r.dead || r.started || r.players.size >= 2) {
          send(ws, { t: 'error', code: 'room-full', message: '房间已满或已开局' });
          ws.close();
          return;
        }
        r.players.set(2, ws);
        r.names.set(2, cleanName(msg.name, 2));
        conn.room = r;
        conn.player = 2;
        send(ws, { t: 'welcome', player: 2, room: r.id });
        broadcastRoomInfo(r);
        break;
      }
      case 'queue': {
        if (room || conn.queued) return; // 在房/已在队：忽略（幂等）
        conn.queued = true;
        conn.queueName = cleanName(msg.name, matchQueue.length + 1);
        matchQueue.push(conn);
        matchPair();
        break;
      }
      case 'unqueue': {
        unqueue(conn);
        break;
      }
      case 'list-rooms': {
        send(ws, roomListMsg());
        break;
      }
      case 'room-config': {
        if (!room || room.dead || player !== 1 || room.started) return;
        const s = msg.settings ?? {};
        for (const k of ['public', 'randomMap', 'team']) {
          if (typeof s[k] === 'boolean') room.settings[k] = s[k];
        }
        broadcastRoomInfo(room);
        break;
      }
      case 'ready': {
        if (!room || room.dead || player !== 2 || room.started) return;
        room.ready.set(2, msg.ready === true);
        broadcastRoomInfo(room);
        break;
      }
      case 'begin': {
        if (!room || room.dead || player !== 1 || room.started) return;
        if (!room.players.has(2) || !room.ready.get(2)) {
          // 非致命：不关连接，房主可等客座准备后重试
          send(ws, { t: 'error', code: 'guest-not-ready', message: '对方还未准备' });
          return;
        }
        room.started = true;
        room.helloed.clear(); // start 两段语义：begin 的 start 清零，hello 收齐再发第二次
        for (const p of room.players.values()) send(p, { t: 'start' });
        broadcastRoomInfo(room);
        // 权威种子（切片 36）：两端共享同一 seed——开箱抽取定格结果本地按
        // maps[seed % n] 解析（同 select 数据天然一致），并进 configHash 互验
        const seed = randomInt(1, 2 ** 31);
        for (const p of room.players.values()) send(p, { t: 'map-roll', seed });
        break;
      }
      case 'hello': {
        if (!room || room.dead) return;
        room.helloed.add(player);
        const peer = peerOf(room, player);
        if (peer) send(peer, msg); // 对端互验配置指纹
        if (room.helloed.size >= 2) {
          for (const p of room.players.values()) send(p, { t: 'start' });
        }
        break;
      }
      case 'input':
      case 'hash':
      case 'pick':
      case 'cursor':
      case 'map-pick': {
        if (!room || room.dead) return;
        const peer = peerOf(room, player);
        if (peer) send(peer, msg);
        break;
      }
      default:
        break; // welcome/error/start/room-info/map-roll/matched/room-list 由服务器产生，客户端发来的一律忽略
    }
  });

  ws.on('close', () => {
    unqueue(conn); // 排队中掉线：静默出队
    const room = conn.room;
    if (!room || room.dead) return;
    room.players.delete(conn.player);
    room.helloed.delete(conn.player);
    room.names.delete(conn.player);
    room.ready.delete(conn.player);
    // 已开局（begin/配对之后）任何一方掉线都解散；未开局只有房主掉线解散，
    // 客座掉线房间保留（房主收 peer-lost + room-info，可继续等待/邀请）
    if (conn.player === 1 || room.started) {
      dissolve(room);
      return;
    }
    for (const p of room.players.values()) send(p, { t: 'peer-lost' });
    if (room.players.size === 0) {
      rooms.delete(room.id);
      room.dead = true;
    } else {
      broadcastRoomInfo(room);
    }
  });

  ws.on('error', () => {
    /* close 会跟着来，交给 close 处理 */
  });
});

wss.on('listening', () => {
  console.log(`room-server listening ${wss.address().port}`);
});
