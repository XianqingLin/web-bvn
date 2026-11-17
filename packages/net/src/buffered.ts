/**
 * 缓冲套接字（切片 34）：自有房间服务器 WebSocket 的 WsLike 包装。
 *
 * onmessage 空窗期（场景交接间隙）到达的入站消息缓冲，接管时补交：
 *   - 普通消息排队（上限内），接管时按序补交；
 *   - pick 仅保留最新（重发覆盖），接管时最后补交——选人交换竞态兜底：
 *     对端一收到本端 pick 即停发 3s 重发，若对端 pick 早到被丢会互相等死
 *     （真机首验死锁；方案 A 时代 RelaySocket 已有同款兜底，迁移收编于此）。
 *
 * 出站 send 与 close 直通底层；底层 close → readyState=3 + onclose。
 * 用法：连接建立后立即包一层，后续 joinRoom/RoomScene/SetupScene/lockstart
 * 全生命周期共用这一个 WsLike。
 */
import type { NetMessage } from './protocol.js';
import type { WsLike } from './transport.js';

/** 空窗期普通消息缓冲上限（防异常洪泛；正常流程远用不到）。 */
const MAX_PENDING = 32;

export class BufferedSocket implements WsLike {
  /** 1 = OPEN，3 = CLOSED（底层 close 事件后置 3） */
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  private handler: ((ev: { data: unknown }) => void) | null = null;
  private readonly pending: NetMessage[] = [];
  private pendingPick: NetMessage | null = null;

  constructor(private readonly inner: WsLike) {
    inner.onopen = () => this.onopen?.();
    inner.onmessage = (ev) => this.onInnerMessage(ev);
    inner.onclose = () => {
      this.readyState = 3;
      this.onclose?.();
    };
  }

  /** joinRoom/RoomScene/SetupScene/waitPeerPick 均按此属性接管消息。 */
  get onmessage(): ((ev: { data: unknown }) => void) | null {
    return this.handler;
  }
  set onmessage(handler: ((ev: { data: unknown }) => void) | null) {
    this.handler = handler;
    if (handler) {
      while (this.pending.length > 0) this.deliver(this.pending.shift()!);
      if (this.pendingPick) {
        const pick = this.pendingPick;
        this.pendingPick = null;
        this.deliver(pick);
      }
    }
  }

  send(text: string): void {
    this.inner.send(text);
  }

  close(): void {
    this.inner.close();
  }

  private onInnerMessage(ev: { data: unknown }): void {
    if (this.readyState === 3) return;
    let msg: NetMessage;
    try {
      const text = typeof ev.data === 'string' ? ev.data : (ev.data as { toString(): string }).toString();
      msg = JSON.parse(text) as NetMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    if (!this.handler) {
      if (msg.t === 'pick') {
        this.pendingPick = msg; // 重发覆盖，只留最新
        return;
      }
      if (this.pending.length < MAX_PENDING) this.pending.push(msg);
      return;
    }
    this.deliver(msg);
  }

  private deliver(msg: NetMessage): void {
    if (!this.handler || this.readyState === 3) return;
    this.handler({ data: JSON.stringify(msg) });
  }
}
