/**
 * 房间语义协议测试（切片 34）：每用例子进程起服（PORT=0 随机端口），
 * ws 客户端按消息队列逐条断言。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'room-server.mjs');

let proc;

beforeEach(async () => {
  proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: '0' } });
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) throw new Error(`room-server 异常退出 code=${code}`);
  });
});

afterEach(() => {
  proc.kill();
});

/** ws 客户端包装：入站消息进队列，next()/expect() 逐条取出。 */
function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const queue = [];
  const waiters = [];
  const closeWaiters = [];
  let closed = false;
  ws.on('message', (d) => {
    const msg = JSON.parse(String(d));
    if (waiters.length > 0) waiters.shift()(msg);
    else queue.push(msg);
  });
  ws.on('close', () => {
    closed = true;
    while (closeWaiters.length > 0) closeWaiters.shift()();
  });
  ws.on('error', () => {
    /* close 会跟着来 */
  });
  const next = (timeout = 2000) =>
    new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('等待消息超时')), timeout);
      const deliver = (msg) => {
        clearTimeout(timer);
        res(msg);
      };
      if (queue.length > 0) deliver(queue.shift());
      else waiters.push(deliver);
    });
  return {
    ws,
    open: new Promise((res, rej) => {
      ws.on('open', res);
      ws.on('error', rej);
    }),
    send: (o) => ws.send(JSON.stringify(o)),
    next,
    expect: async (t, timeout) => {
      const msg = await next(timeout);
      assert.equal(msg.t, t, `期望 ${t}，实际 ${JSON.stringify(msg)}`);
      return msg;
    },
    closed: () => new Promise((res) => (closed ? res() : closeWaiters.push(res))),
  };
}

/** 建好 1v1 房间并返回两端客户端与房间码（都停在 welcome+room-info 之后）。 */
async function setupRoom(port, { hostName = '房主', guestName = '客座' } = {}) {
  const host = client(port);
  await host.open;
  host.send({ t: 'create', name: hostName });
  const welcome = await host.expect('welcome');
  await host.expect('room-info');

  const guest = client(port);
  await guest.open;
  guest.send({ t: 'join', room: welcome.room, name: guestName });
  const gWelcome = await guest.expect('welcome');
  await guest.expect('room-info');
  await host.expect('room-info'); // 入房广播

  assert.equal(welcome.player, 1);
  assert.equal(gWelcome.player, 2);
  assert.equal(welcome.room, gWelcome.room);
  return { host, guest, room: welcome.room };
}

test('create：welcome + room-info（单人快照，默认设置）', async () => {
  const port = await serverPort(proc);
  const c = client(port);
  await c.open;
  c.send({ t: 'create', name: '小明' });
  const welcome = await c.expect('welcome');
  assert.equal(welcome.player, 1);
  assert.match(welcome.room, /^[A-Z2-9]{4}$/);
  const info = await c.expect('room-info');
  assert.deepEqual(info.players, [{ player: 1, name: '小明', ready: false }]);
  assert.equal(info.started, false);
  assert.deepEqual(info.settings, { public: false, randomMap: false, team: false });
  c.ws.close();
});

async function serverPort(p) {
  return new Promise((res, rej) => {
    const onData = (d) => {
      const m = String(d).match(/listening (\d+)/);
      if (m) {
        p.stdout.off('data', onData);
        res(Number(m[1]));
      }
    };
    p.stdout.on('data', onData);
    p.once('exit', () => rej(new Error('server exited')));
  });
}

test('join 不存在的房间 → error room-not-found 并关闭连接', async () => {
  const port = await serverPort(proc);
  const c = client(port);
  await c.open;
  c.send({ t: 'join', room: 'ZZZZ' });
  const err = await c.expect('error');
  assert.equal(err.code, 'room-not-found');
  await c.closed();
});

test('join 满员房间 → error room-full 并关闭连接', async () => {
  const port = await serverPort(proc);
  const { host, guest, room } = await setupRoom(port);
  const third = client(port);
  await third.open;
  third.send({ t: 'join', room });
  const err = await third.expect('error');
  assert.equal(err.code, 'room-full');
  await third.closed();
  host.ws.close();
  guest.ws.close();
});

test('房间全流程：ready → room-config → begin(start) → hello×2(start) → input 透传', async () => {
  const port = await serverPort(proc);
  const { host, guest } = await setupRoom(port, { hostName: 'host', guestName: 'guest' });

  // 客座准备 → 双方收到快照更新
  guest.send({ t: 'ready', ready: true });
  await guest.expect('room-info');
  const rInfo = await host.expect('room-info');
  assert.equal(rInfo.players.find((p) => p.player === 2).ready, true);

  // 房主改设置 → 双方收到快照（快照走 room-info，room-config 只上行）
  host.send({ t: 'room-config', settings: { team: true, randomMap: true } });
  await host.expect('room-info');
  const gInfo = await guest.expect('room-info');
  assert.equal(gInfo.settings.team, true);
  assert.equal(gInfo.settings.randomMap, true);
  assert.equal(gInfo.settings.public, false);

  // begin → 双方 start（第一段：进选人页）+ 各自的快照回声 + 权威种子广播（切片 36）
  host.send({ t: 'begin' });
  await host.expect('start');
  await host.expect('room-info');
  await guest.expect('start');
  const startedInfo = await guest.expect('room-info');
  assert.equal(startedInfo.started, true);
  const roll = await host.expect('map-roll');
  const gRoll = await guest.expect('map-roll');
  assert.equal(typeof roll.seed, 'number');
  assert.ok(roll.seed >= 1 && roll.seed < 2 ** 31);
  assert.equal(gRoll.seed, roll.seed); // 两端共享同一种子

  // hello 收齐 → 双方 start（第二段：开跑）；hello 双向透传互验
  host.send({ t: 'hello', player: 1, configHash: 'x' });
  assert.equal((await guest.next()).t, 'hello');
  guest.send({ t: 'hello', player: 2, configHash: 'x' });
  assert.equal((await host.next()).t, 'hello');
  await host.expect('start');
  await guest.expect('start');

  // input 透传不受影响
  host.send({ t: 'input', tick: 7, mask: 3 });
  const input = await guest.expect('input');
  assert.deepEqual(input, { t: 'input', tick: 7, mask: 3 });

  host.ws.close();
  guest.ws.close();
});

test('begin 时客座未准备 → 非致命 error guest-not-ready，连接保持可重试', async () => {
  const port = await serverPort(proc);
  const { host, guest } = await setupRoom(port);
  host.send({ t: 'begin' });
  const err = await host.expect('error');
  assert.equal(err.code, 'guest-not-ready');
  // 连接未关：准备后重试成功
  guest.send({ t: 'ready', ready: true });
  await guest.expect('room-info');
  await host.expect('room-info');
  host.send({ t: 'begin' });
  await host.expect('start');
  await host.expect('room-info');
  await host.expect('map-roll');
  await guest.expect('start');
  await guest.expect('room-info');
  await guest.expect('map-roll');
  host.ws.close();
  guest.ws.close();
});

test('客座越权（begin/room-config）被忽略', async () => {
  const port = await serverPort(proc);
  const { host, guest } = await setupRoom(port);
  guest.send({ t: 'begin' });
  guest.send({ t: 'room-config', settings: { team: true } });
  // 静默忽略：双方只收到入房时的两条 room-info，无新消息无 start
  guest.send({ t: 'ready', ready: true });
  await guest.expect('room-info');
  const info = await host.expect('room-info');
  assert.equal(info.settings.team, false); // 越权 room-config 未生效
  assert.equal(info.players.find((p) => p.player === 2).ready, true);
  host.ws.close();
  guest.ws.close();
});

test('未开局客座掉线：房间保留（peer-lost + room-info），房码可再次加入', async () => {
  const port = await serverPort(proc);
  const { host, guest, room } = await setupRoom(port);
  guest.ws.close();
  await host.expect('peer-lost');
  const info = await host.expect('room-info');
  assert.deepEqual(info.players.map((p) => p.player), [1]);

  const guest2 = client(port);
  await guest2.open;
  guest2.send({ t: 'join', room, name: '客座2' });
  await guest2.expect('welcome');
  const info2 = await host.expect('room-info');
  assert.deepEqual(
    info2.players.map((p) => [p.player, p.name]),
    [[1, '房主'], [2, '客座2']],
  );
  host.ws.close();
  guest2.ws.close();
});

test('房主掉线：房间解散（客座收 peer-lost），房码失效', async () => {
  const port = await serverPort(proc);
  const { host, guest, room } = await setupRoom(port);
  host.ws.close();
  await guest.expect('peer-lost');
  const probe = client(port);
  await probe.open;
  probe.send({ t: 'join', room });
  const err = await probe.expect('error');
  assert.equal(err.code, 'room-not-found');
  await probe.closed();
  guest.ws.close();
});

test('已开局后客座掉线：房间解散（不保留空局）', async () => {
  const port = await serverPort(proc);
  const { host, guest, room } = await setupRoom(port);
  guest.send({ t: 'ready', ready: true });
  await guest.expect('room-info');
  await host.expect('room-info');
  host.send({ t: 'begin' });
  await host.expect('start');
  await host.expect('room-info');
  await host.expect('map-roll');
  await guest.expect('start');
  await guest.expect('room-info');
  await guest.expect('map-roll');

  guest.ws.close();
  await host.expect('peer-lost');
  const probe = client(port);
  await probe.open;
  probe.send({ t: 'join', room });
  const err = await probe.expect('error');
  assert.equal(err.code, 'room-not-found');
  await probe.closed();
  host.ws.close();
});

test('已开局房间拒绝 join → room-full', async () => {
  const port = await serverPort(proc);
  const { host, guest, room } = await setupRoom(port);
  guest.send({ t: 'ready', ready: true });
  await guest.expect('room-info');
  await host.expect('room-info');
  host.send({ t: 'begin' });
  await host.expect('start');
  await host.expect('room-info');
  await host.expect('map-roll');
  await guest.expect('start');
  await guest.expect('room-info');
  await guest.expect('map-roll');

  const probe = client(port);
  await probe.open;
  probe.send({ t: 'join', room });
  const err = await probe.expect('error');
  assert.equal(err.code, 'room-full');
  await probe.closed();
  host.ws.close();
  guest.ws.close();
});

test('选人页透传：cursor/map-pick 变更即广播 + 带累计锁定的 pick 原样转发（切片 35/36）', async () => {
  const port = await serverPort(proc);
  const { host, guest } = await setupRoom(port);
  guest.send({ t: 'ready', ready: true });
  await guest.expect('room-info');
  await host.expect('room-info');
  host.send({ t: 'begin' });
  await host.expect('start');
  await host.expect('room-info');
  await host.expect('map-roll');
  await guest.expect('start');
  await guest.expect('room-info');
  await guest.expect('map-roll');

  // 光标消息透传（服务器不解析 UI 同步类）
  host.send({ t: 'cursor', player: 1, stage: 'fighter', idx: 5 });
  assert.deepEqual(await guest.expect('cursor'), { t: 'cursor', player: 1, stage: 'fighter', idx: 5 });

  // 房主轮盘切换透传（切片 36：客座只读实时跟随）
  host.send({ t: 'map-pick', player: 1, map: 'KonohaMura' });
  assert.deepEqual(await guest.expect('map-pick'), { t: 'map-pick', player: 1, map: 'KonohaMura' });

  // 累计锁定 pick 透传：locked 字段原样保留，locked 缺省的最终 pick 同样透传
  host.send({
    t: 'pick',
    player: 1,
    fighter: 'ichigo',
    assist: 'gaara',
    locked: { fighters: ['ichigo', 'naruto'], assists: [] },
  });
  const pick = await guest.expect('pick');
  assert.deepEqual(pick.locked, { fighters: ['ichigo', 'naruto'], assists: [] });

  host.ws.close();
  guest.ws.close();
});

test('昵称清洗：trim + 截断 + 空回退', async () => {
  const port = await serverPort(proc);
  const { host, guest } = await setupRoom(port, { hostName: '  ', guestName: 'a'.repeat(30) });
  host.send({ t: 'ready', ready: true }); // 触发一次快照
  guest.send({ t: 'ready', ready: true });
  const info = await host.expect('room-info');
  const names = Object.fromEntries(info.players.map((p) => [p.player, p.name]));
  assert.equal(names[1], '玩家1');
  assert.equal(names[2], 'a'.repeat(20));
  host.ws.close();
  guest.ws.close();
});
