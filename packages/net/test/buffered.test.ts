/**
 * BufferedSocket 单测（切片 34）：真实 ws 的缓冲包装。
 * 1. onmessage 空窗期消息缓冲、接管补交保序；
 * 2. pick 早到只留最新（选人竞态回归，自 platform.test.ts 收编）；
 * 3. 接管后直达；close 透传 onclose。
 */
import { describe, expect, it } from 'vitest';
import { BufferedSocket } from '../src/buffered.js';
import type { WsLike } from '../src/transport.js';

/** 内存 WsLike 桩：测试代码直接驱动其入站事件。 */
function fakeInner(): WsLike & { emit(text: string): void; closeIt(): void } {
  let onmessage: ((ev: { data: unknown }) => void) | null = null;
  let onclose: (() => void) | null = null;
  return {
    send: () => {},
    close: () => onclose?.(),
    readyState: 1,
    onopen: null,
    get onmessage() {
      return onmessage;
    },
    set onmessage(h) {
      onmessage = h;
    },
    get onclose() {
      return onclose;
    },
    set onclose(h) {
      onclose = h;
    },
    emit(text: string) {
      onmessage?.({ data: text });
    },
    closeIt() {
      onclose?.();
    },
  };
}

/** 收集接管后到达的消息。 */
function collect(socket: BufferedSocket): { t?: string; [k: string]: unknown }[] {
  const got: { t?: string; [k: string]: unknown }[] = [];
  socket.onmessage = (ev) => got.push(JSON.parse(String(ev.data)));
  return got;
}

const pickOf = (fighter: string) => JSON.stringify({ t: 'pick', player: 1, fighter, assist: 'a' });

describe('BufferedSocket', () => {
  it('空窗期普通消息缓冲，接管时按序补交', () => {
    const inner = fakeInner();
    const socket = new BufferedSocket(inner);
    inner.emit(JSON.stringify({ t: 'welcome', player: 1, room: 'ABCD' }));
    inner.emit(JSON.stringify({ t: 'room-info', room: 'ABCD', started: false, settings: {}, players: [] }));
    const got = collect(socket);
    expect(got.map((m) => m.t)).toEqual(['welcome', 'room-info']);
  });

  it('pick 早到（接管前）→ 暂存，接管时补交（选人竞态回归）', () => {
    const inner = fakeInner();
    const socket = new BufferedSocket(inner);
    inner.emit(pickOf('ichigo'));
    const got = collect(socket);
    expect(got).toEqual([{ t: 'pick', player: 1, fighter: 'ichigo', assist: 'a' }]);
  });

  it('接管前多条 pick 到达 → 只补交最新一条', () => {
    const inner = fakeInner();
    const socket = new BufferedSocket(inner);
    inner.emit(pickOf('ichigo'));
    inner.emit(pickOf('naruto'));
    const got = collect(socket);
    expect(got).toEqual([{ t: 'pick', player: 1, fighter: 'naruto', assist: 'a' }]);
  });

  it('接管后消息直达，不再缓冲', () => {
    const inner = fakeInner();
    const socket = new BufferedSocket(inner);
    const got = collect(socket);
    inner.emit(pickOf('ichigo'));
    expect(got).toEqual([{ t: 'pick', player: 1, fighter: 'ichigo', assist: 'a' }]);
  });

  it('出站 send 直通底层；底层 close → readyState=3 + onclose', () => {
    const inner = fakeInner();
    const socket = new BufferedSocket(inner);
    const sent: string[] = [];
    inner.send = (t) => sent.push(t);
    socket.send(JSON.stringify({ t: 'begin' }));
    expect(sent).toEqual([JSON.stringify({ t: 'begin' })]);
    let closed = false;
    socket.onclose = () => (closed = true);
    inner.closeIt();
    expect(closed).toBe(true);
    expect(socket.readyState).toBe(3);
  });

  it('非 JSON 帧忽略（心跳等扩展不炸管道）', () => {
    const inner = fakeInner();
    const socket = new BufferedSocket(inner);
    inner.emit('ping');
    expect(collect(socket)).toEqual([]);
  });
});
