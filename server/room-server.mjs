#!/usr/bin/env node
/**
 * 房间服务器（切片 7，ADR-14/15）。只做房间编排与输入中继，不跑模拟。
 *
 * 职责：
 *   1. create → 开新房分配 4 位房间码（P1）；join <code> → 入房（P2）；
 *      失败回 error（room-not-found / room-full）并关闭连接；
 *   2. 收齐双方 hello（配置指纹）→ 广播 start；
 *   3. input/hash/pick 透传给同房间对端（不解析；pick = 切片 14 选人结果交换）；
 *   4. 断线最小处理：通知存活方 peer-lost（冻结等待，判负归阶段 4）；
 *      无重连。房空即销毁。
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

/** @type {Map<string, {id: string, players: Map<number, import('ws').WebSocket>, helloed: Set<number>}>} */
const rooms = new Map();

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function peerOf(room, player) {
  return room.players.get(player === 1 ? 2 : 1) ?? null;
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
        room = { id, players: new Map([[1, ws]]), helloed: new Set() };
        rooms.set(id, room);
        player = 1;
        send(ws, { t: 'welcome', player, room: id });
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
        if (r.players.size >= 2) {
          send(ws, { t: 'error', code: 'room-full', message: '房间已满' });
          ws.close();
          return;
        }
        r.players.set(2, ws);
        room = r;
        player = 2;
        send(ws, { t: 'welcome', player, room: r.id });
        break;
      }
      case 'hello': {
        if (!room) return;
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
      case 'pick': {
        if (!room) return;
        const peer = peerOf(room, player);
        if (peer) send(peer, msg);
        break;
      }
      default:
        break; // welcome/error/start 由服务器产生，客户端发来的一律忽略
    }
  });

  ws.on('close', () => {
    if (!room) return;
    room.players.delete(player);
    room.helloed.delete(player);
    for (const p of room.players.values()) send(p, { t: 'peer-lost' });
    if (room.players.size === 0) rooms.delete(room.id);
  });

  ws.on('error', () => {
    /* close 会跟着来，交给 close 处理 */
  });
});

wss.on('listening', () => {
  console.log(`room-server listening ${wss.address().port}`);
});
