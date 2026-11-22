#!/usr/bin/env node
/**
 * 房间服务器（切片 7 基础；切片 34 房间语义扩展；切片 37 匹配队列；
 * 2026-11-21 纯房码制——浏览列表下线、房间一律私人、6 位数字房码）。
 * 只做房间编排与输入中继，不跑模拟。
 *
 * 职责：
 *   1. create/join（带昵称）→ 分配位次入房，welcome + room-info 快照；
 *      加入只凭 6 位数字房码（或平台邀请深链携带房码），无公开房间列表；
 *   2. 房间语义（服务器解析，快照经 room-info 广播；设计见 docs/netplay-design.md §9）：
 *      - room-config  房主改设置（仅 team）→ 合并后广播 room-info；
 *      - ready        客座准备切换 → 广播 room-info；
 *      - begin        房主请求开始 → 校验客座已准备 → 广播 start（进选人页），
 *                     hello 计数清零；未准备回非致命 error（guest-not-ready）；
 *   3. hello 收齐 → 广播 start（第二段：进对局；与 begin 的 start 两段语义）；
 *   4. UI 同步类（cursor/map-pick）与对局类（input/hash/pick）原样透传给对端；
 *   5. 权威种子（netplay-design §8/§9）：begin 时生成随机种子并广播 seed——
 *      对局 sim seed 都由它来（进 configHash）；对局地图按 maps[seed % n] 解析；
 *   6. 匹配队列（切片 37，netplay-design §6/§9）：queue 入队，同模式偏好满 2 即配对——
 *      服务器开好房间并直接置为开局段（免房间页/准备门，team 由 queue.team 偏好裁定、
 *      无地图阶段），双方收 matched（含权威 seed + team）+ start；
 *      unqueue 退队；掉线自动出队；已配对的种子兼作 sim seed 进 configHash；
 *   7. 断线清理（netplay-design.md §10）：
 *      - 未开局客座掉线 → 房间保留，房主收 peer-lost + room-info，可继续等待/邀请；
 *      - 房主掉线或已开局后任何一方掉线 → 房间解散（peer-lost，房码失效）；
 *      - 已开局房间拒绝 join（复用 room-full），无重连。
 *
 * 用法：PORT=8787 node room-server.mjs   （PORT=0 → 随机端口，打印到 stdout）
 */
import { randomInt } from 'node:crypto';
import { WebSocketServer } from 'ws';

const port = Number(process.env.PORT ?? 8787);

/**
 * 房间码：6 位数字（2026-11-21 定案：不重复、便于口播/手输）。
 * 唯一性 = 现存房间查重 + 近期已解散房码冷却（防止迟到者凭旧码误入他人新房）；
 * 冷却池按 FIFO 上限裁剪，防长期运行无界增长。
 */
const RETIRED_CAP = 512;
const retiredCodes = new Set();
const retiredOrder = [];

function newRoomCode(rooms) {
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += String(randomInt(10));
    if (!rooms.has(c) && !retiredCodes.has(c)) return c;
  }
}

/** 房码退场（解散/清空）：进冷却池，近期不复用。 */
function retireRoomCode(code) {
  if (retiredCodes.has(code)) return;
  retiredCodes.add(code);
  retiredOrder.push(code);
  while (retiredOrder.length > RETIRED_CAP) {
    retiredCodes.delete(retiredOrder.shift());
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
 *   settings: {team: boolean},
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

/** 公开房间列表已下线（2026-11-21 纯房码制）：list-rooms/room-list 消息移除。 */

/** 解散房间：通知剩余成员后销毁，房码失效并进冷却池（their ws 之后 close 不再处理）。 */
function dissolve(room) {
  room.dead = true;
  rooms.delete(room.id);
  retireRoomCode(room.id);
  for (const p of room.players.values()) send(p, { t: 'peer-lost' });
  room.players.clear();
}

/** 出队（掉线/unqueue/自行入房共用）。 */
function unqueue(conn) {
  if (!conn.queued) return;
  conn.queued = false;
  conn.queueTeam = true;
  const i = matchQueue.indexOf(conn);
  if (i >= 0) matchQueue.splice(i, 1);
}

/**
 * 配对（切片 37）：出队两个**同模式偏好**的存活连接 → 开房并直接置为开局段。
 * 模式偏好（2026-11-22）：queue.team 决定，true=团队 3+1 / false=单挑 1v1，
 * 缺省 true 兼容旧客户端；不同偏好分池不互配，避免两端 flow.team 分歧导致
 * configHash 不同（teams 键有无）而失步。无地图阶段（援助选完直接进加载页，
 * 对局地图由权威 seed 按 maps[seed % n] 解析）；
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
    // 同偏好配对：队首找第一个 team 相同的连接，没有则等待（不跨模式凑对）
    let partner = -1;
    for (let i = 1; i < matchQueue.length; i++) {
      if (matchQueue[i].queueTeam === matchQueue[0].queueTeam) {
        partner = i;
        break;
      }
    }
    if (partner < 0) break;
    const a = matchQueue.shift();
    const b = matchQueue.splice(partner - 1, 1)[0]; // shift 后其下标前移一位
    a.queued = false;
    b.queued = false;
    const team = a.queueTeam;
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
      settings: { team },
      started: true, // 出生即开局段：matched → start 直进选人页
      dead: false,
    };
    rooms.set(room.id, room);
    a.room = room;
    a.player = 1;
    b.room = room;
    b.player = 2;
    const seed = randomInt(1, 2 ** 31); // 权威种子：兼作 sim seed（切片 36 语义）
    const common = { t: 'matched', room: room.id, team, seed };
    send(a.ws, { ...common, player: 1, opponent: { name: b.queueName } });
    send(b.ws, { ...common, player: 2, opponent: { name: a.queueName } });
    for (const ws of room.players.values()) send(ws, { t: 'start' });
  }
}

const wss = new WebSocketServer({ port });

wss.on('connection', (ws) => {
  /** 每连接记录（闭包内使用；跨连接访问仅发生在 matchPair 装配槽位处） */
  const conn = { ws, room: null, player: 0, queued: false, queueName: '', queueTeam: true };

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
          settings: { team: false },
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
        conn.queueTeam = typeof msg.team === 'boolean' ? msg.team : true; // 缺省兼容旧客户端
        conn.queueName = cleanName(msg.name, matchQueue.length + 1);
        matchQueue.push(conn);
        matchPair();
        break;
      }
      case 'unqueue': {
        unqueue(conn);
        break;
      }
      case 'room-config': {
        if (!room || room.dead || player !== 1 || room.started) return;
        const s = msg.settings ?? {};
        // 纯房码制仅剩 team 一项（2026-11-21：public/randomMap 随浏览列表与地图
        // 勾选下线）；未知键一律忽略，防客户端伪造键污染快照
        if (typeof s.team === 'boolean') room.settings.team = s.team;
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
        // 权威种子：两端共享同一 seed——对局 sim seed（进 configHash 互验）；
        // 对局地图由选人页房主定（含"？"随机项），非 seed 抽取
        const seed = randomInt(1, 2 ** 31);
        for (const p of room.players.values()) send(p, { t: 'seed', seed });
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
        break; // welcome/error/start/room-info/seed/matched 由服务器产生，客户端发来的一律忽略
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
      retireRoomCode(room.id); // 空房销毁：房码进冷却池，近期不复用
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
