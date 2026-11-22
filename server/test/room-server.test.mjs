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
      const timer = setTimeout(() => {
        // 超时必须摘除 waiter：残留的死 waiter 会吞掉后续消息（切片 37 测试教训）
        const i = waiters.indexOf(deliver);
        if (i >= 0) waiters.splice(i, 1);
        rej(new Error('等待消息超时'));
      }, timeout);
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
  assert.match(welcome.room, /^\d{6}$/); // 6 位数字房码（2026-11-21 定案）
  const info = await c.expect('room-info');
  assert.deepEqual(info.players, [{ player: 1, name: '小明', ready: false }]);
  assert.equal(info.started, false);
  assert.deepEqual(info.settings, { team: false });
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
  host.send({ t: 'room-config', settings: { team: true } });
  await host.expect('room-info');
  const gInfo = await guest.expect('room-info');
  assert.equal(gInfo.settings.team, true);
  assert.deepEqual(gInfo.settings, { team: true }); // 其余键被忽略，快照仅 team

  // begin → 双方 start（第一段：进选人页）+ 各自的快照回声 + 权威种子广播
  host.send({ t: 'begin' });
  await host.expect('start');
  await host.expect('room-info');
  await guest.expect('start');
  const startedInfo = await guest.expect('room-info');
  assert.equal(startedInfo.started, true);
  const roll = await host.expect('seed');
  const gRoll = await guest.expect('seed');
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
  await host.expect('seed');
  await guest.expect('start');
  await guest.expect('room-info');
  await guest.expect('seed');
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
  await host.expect('seed');
  await guest.expect('start');
  await guest.expect('room-info');
  await guest.expect('seed');

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
  await host.expect('seed');
  await guest.expect('start');
  await guest.expect('room-info');
  await guest.expect('seed');

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
  await host.expect('seed');
  await guest.expect('start');
  await guest.expect('room-info');
  await guest.expect('seed');

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

// ---------- 切片 37：匹配队列 + 浏览列表 ----------

test('queue×2 → matched（同房/位次/固定 team/权威 seed）+ start，hello 收齐开跑', async () => {
  const port = await serverPort(proc);
  const a = client(port);
  await a.open;
  a.send({ t: 'queue', name: '甲' });
  const b = client(port);
  await b.open;
  b.send({ t: 'queue', name: '乙' });

  const ma = await a.expect('matched');
  const mb = await b.expect('matched');
  assert.equal(ma.room, mb.room);
  assert.equal(ma.player, 1);
  assert.equal(mb.player, 2);
  assert.equal(ma.team, true); // 匹配固定团队模式
  assert.ok(ma.seed >= 1 && ma.seed < 2 ** 31);
  assert.equal(mb.seed, ma.seed); // 同一颗权威种子
  assert.equal(ma.opponent.name, '乙');
  assert.equal(mb.opponent.name, '甲');

  // 免房间页：matched 后直接 start（开局段），hello 收齐再 start（开跑段）
  await a.expect('start');
  await b.expect('start');
  a.send({ t: 'hello', player: 1, configHash: 'x' });
  assert.equal((await b.next()).t, 'hello');
  b.send({ t: 'hello', player: 2, configHash: 'x' });
  assert.equal((await a.next()).t, 'hello');
  await a.expect('start');
  await b.expect('start');

  // 对局类透传照常
  a.send({ t: 'input', tick: 3, mask: 1 });
  assert.deepEqual(await b.expect('input'), { t: 'input', tick: 3, mask: 1 });

  // matched 房即已开局：第三者 join 被拒（复用 room-full）
  const probe = client(port);
  await probe.open;
  probe.send({ t: 'join', room: ma.room });
  assert.equal((await probe.expect('error')).code, 'room-full');
  await probe.closed();

  a.ws.close();
  b.ws.close();
});

test('queue team:false ×2 → matched team=false（单挑 1v1 模式可选）', async () => {
  const port = await serverPort(proc);
  const a = client(port);
  await a.open;
  a.send({ t: 'queue', name: '单挑甲', team: false });
  const b = client(port);
  await b.open;
  b.send({ t: 'queue', name: '单挑乙', team: false });

  const ma = await a.expect('matched');
  const mb = await b.expect('matched');
  assert.equal(ma.room, mb.room);
  assert.equal(ma.team, false);
  assert.equal(mb.team, false);
  await a.expect('start');
  await b.expect('start');
  a.ws.close();
  b.ws.close();
});

test('不同模式偏好不互配：1v1 与团队分池，各自等到同偏好对手', async () => {
  const port = await serverPort(proc);
  const solo = client(port);
  await solo.open;
  solo.send({ t: 'queue', name: '单挑', team: false });
  const team = client(port);
  await team.open;
  team.send({ t: 'queue', name: '团队' }); // 缺省 team=true

  // 异构偏好不凑对（120ms 内团队方不应收到 matched）
  await assert.rejects(team.next(120), /等待消息超时/);

  const solo2 = client(port);
  await solo2.open;
  solo2.send({ t: 'queue', name: '单挑2', team: false });
  const m1 = await solo.expect('matched');
  const m2 = await solo2.expect('matched');
  assert.equal(m1.room, m2.room);
  assert.equal(m1.team, false); // 团队方偏好不污染 1v1 池
  assert.equal(m2.team, false);
  solo.ws.close();
  solo2.ws.close();
  team.ws.close();
});

test('matched 房一方掉线 → 对方 peer-lost（开局段即解散）', async () => {
  const port = await serverPort(proc);
  const a = client(port);
  await a.open;
  a.send({ t: 'queue', name: '甲' });
  const b = client(port);
  await b.open;
  b.send({ t: 'queue', name: '乙' });
  await a.expect('matched');
  await b.expect('matched');
  await a.expect('start');
  await b.expect('start');

  b.ws.close();
  const lost = await a.expect('peer-lost');
  assert.equal(lost.t, 'peer-lost');
  a.ws.close();
});

test('unqueue 退队：不配对，重新排队后可配对', async () => {
  const port = await serverPort(proc);
  const noMatch = async (c) => {
    await assert.rejects(() => c.next(150), /超时/);
  };
  const a = client(port);
  await a.open;
  a.send({ t: 'queue', name: '甲' });
  await noMatch(a); // 独自排队不配对

  a.send({ t: 'unqueue' });
  await new Promise((r) => setTimeout(r, 50));

  // 退队后有人入队也不会拉回甲
  const c = client(port);
  await c.open;
  c.send({ t: 'queue', name: '丙' });
  await noMatch(c);

  // 甲重新排队 → 立即与丙配对
  a.send({ t: 'queue', name: '甲' });
  const ma = await a.expect('matched');
  const mc = await c.expect('matched');
  assert.equal(ma.opponent.name, '丙');
  assert.equal(ma.player, 2); // 丙先入队 → 丙 P1 / 甲 P2（FIFO 配对序）
  assert.equal(mc.player, 1);
  await a.expect('start');
  await c.expect('start');
  a.ws.close();
  c.ws.close();
});

test('排队中掉线：静默出队，其余人可继续配对', async () => {
  const port = await serverPort(proc);
  const a = client(port);
  await a.open;
  a.send({ t: 'queue', name: '甲' });
  const b = client(port);
  await b.open;
  b.send({ t: 'queue', name: '乙' });
  await a.expect('matched'); // 先正常配对一次，验证队列干净
  await b.expect('matched');
  await a.expect('start');
  await b.expect('start');
  a.ws.close();
  b.ws.close();

  // 排队后掉线，不阻塞后续配对
  const c = client(port);
  await c.open;
  c.send({ t: 'queue', name: '丙' });
  c.ws.close();
  await new Promise((r) => setTimeout(r, 50));

  const d = client(port);
  await d.open;
  d.send({ t: 'queue', name: '丁' });
  const e = client(port);
  await e.open;
  e.send({ t: 'queue', name: '戊' });
  const md = await d.expect('matched');
  await e.expect('matched');
  assert.equal(md.opponent.name, '戊');
  d.ws.close();
  e.ws.close();
});

test('房码冷却：解散后的房码近期不复用（新房间拿到不同码）', async () => {
  const port = await serverPort(proc);
  const host = client(port);
  await host.open;
  host.send({ t: 'create', name: '房主' });
  const first = await host.expect('welcome');
  host.ws.close();

  // 解散后立即再建房：不得复用刚退役的房码（防迟到者凭旧码误入他人新房）
  const host2 = client(port);
  await host2.open;
  host2.send({ t: 'create', name: '房主2' });
  const second = await host2.expect('welcome');
  assert.notEqual(second.room, first.room);
  host2.ws.close();
});

test('在房时 queue 被忽略；create/join 会出队', async () => {
  const port = await serverPort(proc);
  // 已在房的连接 queue → 不进队列
  const host = client(port);
  await host.open;
  host.send({ t: 'create', name: '房主' });
  await host.expect('welcome');
  await host.expect('room-info');
  host.send({ t: 'queue', name: '房主' });
  const other = client(port);
  await other.open;
  other.send({ t: 'queue', name: '乙' });
  await new Promise((r) => setTimeout(r, 50));
  // 房主在房未配对；乙独占队列等下一个
  const third = client(port);
  await third.open;
  third.send({ t: 'queue', name: '丙' });
  const mo = await other.expect('matched');
  assert.equal(mo.opponent.name, '丙');
  other.ws.close();
  third.ws.close();

  // 排队后 create → 出队（乙若仍在队会配给后续，这里直接验证 create 成功即可）
  const q = client(port);
  await q.open;
  q.send({ t: 'queue', name: '丁' });
  await new Promise((r) => setTimeout(r, 20));
  q.send({ t: 'create', name: '丁' });
  const w = await q.expect('welcome');
  assert.match(w.room, /^\d{6}$/);
  q.ws.close();
  host.ws.close();
});
