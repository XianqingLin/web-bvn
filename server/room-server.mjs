#!/usr/bin/env node
/**
 * 房间服务器（Node 宿主，本地 dev / 回归测试用）。
 *
 * 协议实现在 room-logic.mjs（与 Cloudflare Durable Object 共用同一份）；
 * 本文件只负责用 Node 的 ws 库把它挂到 TCP 端口上。
 * 线上使用 server/cf/ 下的 Cloudflare Worker 版本。
 *
 * 用法：PORT=8787 node room-server.mjs   （PORT=0 → 随机端口，打印到 stdout）
 */
import { randomInt } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createRoomServer } from './room-logic.mjs';

const port = Number(process.env.PORT ?? 8787);
const logic = createRoomServer({ randomInt });

const wss = new WebSocketServer({ port });

wss.on('connection', (ws) => {
  const conn = logic.makeConn(ws);
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    logic.onMessage(conn, msg);
  });
  ws.on('close', () => logic.onClose(conn));
  ws.on('error', () => {
    /* close 会跟着来，交给 close 处理 */
  });
});

wss.on('listening', () => {
  console.log(`room-server listening ${wss.address().port}`);
});
