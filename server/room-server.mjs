#!/usr/bin/env node
/**
 * 房间服务器（切片 7 基础；切片 34 房间语义扩展）。只做房间编排与输入中继，不跑模拟。
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
 *   5. 断线清理（netplay-design.md §10）：
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

/** 解散房间：通知剩余成员后销毁，房码失效（their ws 之后 close 不再处理）。 */
function dissolve(room) {
  room.dead = true;
  rooms.delete(room.id);
  for (const p of room.players.values()) send(p, { t: 'peer-lost' });
  room.players.clear();
}

const wss = new WebSocketServer({ port });

wss.on('connection', (ws) => {
  let room = null;
  let player = 0;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (msg.t) {
      case 'create': {
        if (room) return;
        const id = newRoomCode(rooms);
        room = {
          id,
          players: new Map([[1, ws]]),
          names: new Map([[1, cleanName(msg.name, 1)]]),
          ready: new Map(),
          helloed: new Set(),
          settings: { public: false, randomMap: false, team: false },
          started: false,
          dead: false,
        };
        rooms.set(id, room);
        player = 1;
        send(ws, { t: 'welcome', player, room: id });
        broadcastRoomInfo(room);
        break;
      }
      case 'join': {
        if (room) return;
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
        room = r;
        player = 2;
        send(ws, { t: 'welcome', player, room: r.id });
        broadcastRoomInfo(r);
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
        break; // welcome/error/start/room-info/map-roll 由服务器产生，客户端发来的一律忽略
    }
  });

  ws.on('close', () => {
    if (!room || room.dead) return;
    room.players.delete(player);
    room.helloed.delete(player);
    room.names.delete(player);
    room.ready.delete(player);
    // 已开局（begin 之后）任何一方掉线都解散；未开局只有房主掉线解散，
    // 客座掉线房间保留（房主收 peer-lost + room-info，可继续等待/邀请）
    if (player === 1 || room.started) {
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
