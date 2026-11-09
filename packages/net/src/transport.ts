/**
 * 传输抽象：协议消息如何到达对端。
 * 实现体不解读消息内容（Loopback 直投 / Ws 转发），编排在 LockstepClient。
 */
import type { NetMessage } from './protocol.js';

export interface Transport {
  send(msg: NetMessage): void;
  onMessage(cb: (msg: NetMessage) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

/**
 * 内存直连对（测试 / 同进程联调）：send 即同步送达对端，顺序保持。
 * 同步送达在测试里是确定性的（消息按 send 顺序被对端处理）。
 */
class LoopbackTransport implements Transport {
  private cb: ((msg: NetMessage) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private closed = false;

  constructor(private readonly peer: LoopbackTransport) {}

  send(msg: NetMessage): void {
    if (!this.closed && !this.peer.closed) this.peer.cb?.(msg);
  }

  onMessage(cb: (msg: NetMessage) => void): void {
    this.cb = cb;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.peer.closeCb?.();
  }
}

export function loopbackPair(): [Transport, Transport] {
  const a = new LoopbackTransport(null as unknown as LoopbackTransport);
  const b = new LoopbackTransport(a);
  (a as unknown as { peer: LoopbackTransport }).peer = b;
  return [a, b];
}

/**
 * ws 形状套接字：浏览器原生 WebSocket 与 node `ws` 客户端都满足
 * send(string) + on* 事件位，此处只做 JSON 编解码适配。
 */
export interface WsLike {
  send(data: string): void;
  close(): void;
  /** 1 = OPEN（浏览器与 node ws 通用）；缺省视为常开（测试桩） */
  readonly readyState?: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
}

function asText(data: unknown): string {
  if (typeof data === 'string') return data;
  // node ws 收到 Buffer（有 toString）；ArrayBuffer 走 TextDecoder
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return (data as { toString(): string }).toString();
}

export function wsTransport(socket: WsLike): Transport {
  return {
    send(msg) {
      if (socket.readyState === undefined || socket.readyState === 1) {
        socket.send(JSON.stringify(msg));
      }
    },
    onMessage(cb) {
      socket.onmessage = (ev) => {
        try {
          cb(JSON.parse(asText(ev.data)) as NetMessage);
        } catch {
          // 非 JSON 帧忽略（中继可能扩展心跳等）
        }
      };
    },
    onClose(cb) {
      socket.onclose = () => cb();
    },
    close() {
      socket.close();
    },
  };
}
