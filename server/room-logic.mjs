/**
 * 房间服核心逻辑（与宿主平台无关）。
 *
 * 2026-11-22 从 room-server.mjs 抽出：同一份协议实现同时供
 *  - Node 老服（server/room-server.mjs，本地 dev / 回归测试）
 *  - Cloudflare Worker + Durable Object（server/cf/，线上）
 * 使用，避免两套实现的行为漂移。协议与语义完全沿用原版：
 * 纯房码制（6 位数字）、房间语义、匹配队列、权威种子、断线清理。
 *
 * 宿主只需注入 randomInt(min, max)（Node: node:crypto.randomInt；
 * Workers: Web Crypto），并把 WebSocket 风格的连接交给 makeConn /
 * onMessage / onClose。连接对象需满足 send(string) + readyState===1=OPEN，
 * Node ws 与 Workers WebSocket 都符合。
 */

const RETIRED_CAP = 512;

export function createRoomServer({ randomInt }) {
  const rooms = new Map();
  const matchQueue = [];
  const retiredCodes = new Set();
  const retiredOrder = [];

  function newRoomCode() {
    for (;;) {
      let c = '';
      for (let i = 0; i < 6; i += 1) c += String(randomInt(10));
      if (!rooms.has(c) && !retiredCodes.has(c)) return c;
    }
  }

  function retireRoomCode(code) {
    if (retiredCodes.has(code)) return;
    retiredCodes.add(code);
    retiredOrder.push(code);
    while (retiredOrder.length > RETIRED_CAP) {
      retiredCodes.delete(retiredOrder.shift());
    }
  }

  function cleanName(raw, slot) {
    const s = typeof raw === 'string' ? raw.trim().slice(0, 20) : '';
    return s || `玩家${slot}`;
  }

  function send(ws, msg) {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    } catch {
      /* 连接已关闭：忽略（close 事件会接管后续清理） */
    }
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

  function dissolve(room) {
    room.dead = true;
    rooms.delete(room.id);
    retireRoomCode(room.id);
    for (const p of room.players.values()) send(p, { t: 'peer-lost' });
    room.players.clear();
  }

  function unqueue(conn) {
    if (!conn.queued) return;
    conn.queued = false;
    conn.queueTeam = true;
    const i = matchQueue.indexOf(conn);
    if (i >= 0) matchQueue.splice(i, 1);
  }

  function matchPair() {
    for (let i = matchQueue.length - 1; i >= 0; i -= 1) {
      if (matchQueue[i].ws.readyState !== 1) {
        matchQueue[i].queued = false;
        matchQueue.splice(i, 1);
      }
    }
    while (matchQueue.length >= 2) {
      let partner = -1;
      for (let i = 1; i < matchQueue.length; i += 1) {
        if (matchQueue[i].queueTeam === matchQueue[0].queueTeam) {
          partner = i;
          break;
        }
      }
      if (partner < 0) break;
      const a = matchQueue.shift();
      const b = matchQueue.splice(partner - 1, 1)[0];
      a.queued = false;
      b.queued = false;
      const team = a.queueTeam;
      const room = {
        id: newRoomCode(),
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
        started: true,
        dead: false,
      };
      rooms.set(room.id, room);
      a.room = room;
      a.player = 1;
      b.room = room;
      b.player = 2;
      const seed = randomInt(1, 2 ** 31);
      const common = { t: 'matched', room: room.id, team, seed };
      send(a.ws, { ...common, player: 1, opponent: { name: b.queueName } });
      send(b.ws, { ...common, player: 2, opponent: { name: a.queueName } });
      for (const ws of room.players.values()) send(ws, { t: 'start' });
    }
  }

  function makeConn(ws) {
    return { ws, room: null, player: 0, queued: false, queueName: '', queueTeam: true };
  }

  function onMessage(conn, msg) {
    const { ws } = conn;
    const room = conn.room;
    const player = conn.player;
    if (!msg || typeof msg !== 'object') return;

    switch (msg.t) {
      case 'ping': {
        // 纯只读健康探测：不入房、不排队、不触发任何房间语义，不依赖房间状态。
        // queue = 当前匹配队列长度，供客户端择优选 nodes 时软加权负载。
        send(ws, { t: 'pong', id: msg.id, queue: matchQueue.length });
        break;
      }
      case 'create': {
        if (room) return;
        unqueue(conn);
        const id = newRoomCode();
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
        unqueue(conn);
        const r = rooms.get(String(msg.room ?? '').trim().toUpperCase());
        if (!r) {
          send(ws, { t: 'error', code: 'room-not-found', message: `房间不存在：${msg.room}` });
          ws.close();
          return;
        }
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
        if (room || conn.queued) return;
        conn.queued = true;
        conn.queueTeam = typeof msg.team === 'boolean' ? msg.team : true;
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
          send(ws, { t: 'error', code: 'guest-not-ready', message: '对方还未准备' });
          return;
        }
        room.started = true;
        room.helloed.clear();
        for (const p of room.players.values()) send(p, { t: 'start' });
        broadcastRoomInfo(room);
        const seed = randomInt(1, 2 ** 31);
        for (const p of room.players.values()) send(p, { t: 'seed', seed });
        break;
      }
      case 'hello': {
        if (!room || room.dead) return;
        room.helloed.add(player);
        const peer = peerOf(room, player);
        if (peer) send(peer, msg);
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
        break;
    }
  }

  function onClose(conn) {
    unqueue(conn);
    const room = conn.room;
    if (!room || room.dead) return;
    room.players.delete(conn.player);
    room.helloed.delete(conn.player);
    room.names.delete(conn.player);
    room.ready.delete(conn.player);
    if (conn.player === 1 || room.started) {
      dissolve(room);
      return;
    }
    for (const p of room.players.values()) send(p, { t: 'peer-lost' });
    if (room.players.size === 0) {
      rooms.delete(room.id);
      room.dead = true;
      retireRoomCode(room.id);
    } else {
      broadcastRoomInfo(room);
    }
  }

  return { makeConn, onMessage, onClose };
}
