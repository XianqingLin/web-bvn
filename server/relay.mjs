#!/usr/bin/env node
/**
 * 最小输入中继（切片 6 种子形态，切片 7 长成房间服务器）。
 *
 * 职责只有连接编排，不跑模拟：
 *   1. 按连接顺序分配 p1/p2，发 welcome；
 *   2. 收齐双方 hello（配置指纹）→ 广播 start；
 *   3. 之后 input/hash 原样透传给对端（不解析）；
 *   4. 一方断开 → 通知存活方 peer-lost。
 *
 * 用法：PORT=8787 node relay.mjs   （PORT=0 → 随机端口，实际端口打印到 stdout）
 */
import { WebSocketServer } from 'ws';

const port = Number(process.env.PORT ?? 8787);
const wss = new WebSocketServer({ port });

/** 单房间（切片 6 只需镜像联调；多房间归切片 7） */
let clients = /** @type {import('ws').WebSocket[]} */ ([]);
const helloed = new Set();

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(msg) {
  for (const c of clients) send(c, msg);
}

wss.on('connection', (ws) => {
  if (clients.length >= 2) {
    ws.close(4000, 'room full');
    return;
  }
  const player = clients.length === 0 ? 1 : 2;
  clients.push(ws);
  send(ws, { t: 'welcome', player });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // 非 JSON 帧忽略
    }
    switch (msg.t) {
      case 'hello': {
        helloed.add(player);
        const peer = clients[player === 1 ? 1 : 0];
        if (peer && peer !== ws) send(peer, msg); // 透传给对端互验
        if (helloed.size === 2) broadcast({ t: 'start' });
        break;
      }
      case 'input':
      case 'hash': {
        const peer = clients[player === 1 ? 1 : 0];
        if (peer && peer !== ws) send(peer, msg);
        break;
      }
      default:
        break; // welcome/start 由中继产生，客户端发来的一律忽略
    }
  });

  ws.on('close', () => {
    clients = clients.filter((c) => c !== ws);
    helloed.delete(player);
    for (const c of clients) send(c, { t: 'peer-lost' });
  });
});

wss.on('listening', () => {
  console.log(`relay listening ${wss.address().port}`);
});
