/**
 * 房间服的 Cloudflare Durable Object 宿主。
 *
 * 单个全局实例承载全部房间与匹配队列，语义等同原 Node 单进程服务器
 * （房间之间需要互看房码查重 + 共享匹配池，故不分房建 DO）。
 * 连接活跃时 DO 常驻内存；全部断线后可被 Cloudflare 回收，
 * 房间状态随之清空——与原服重启行为一致。
 */
import { createRoomServer } from '../room-logic.mjs';

/** Web Crypto 版 randomInt(min, max)，签名兼容 node:crypto.randomInt。 */
function webRandomInt(min, max) {
  if (max === undefined) {
    max = min;
    min = 0;
  }
  const range = max - min;
  if (range <= 0) throw new RangeError('randomInt: max 必须大于 min');
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return min + (buf[0] % range);
}

export class RoomServer {
  constructor(_state, _env) {
    this.logic = createRoomServer({ randomInt: webRandomInt });
  }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    const conn = this.logic.makeConn(server);

    server.addEventListener('message', (event) => {
      let msg;
      try {
        const raw = event.data;
        msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
      } catch {
        return;
      }
      this.logic.onMessage(conn, msg);
    });
    server.addEventListener('close', () => this.logic.onClose(conn));
    server.addEventListener('error', () => {
      /* close 会跟着来，交给 close 处理 */
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
