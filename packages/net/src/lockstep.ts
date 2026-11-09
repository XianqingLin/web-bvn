/**
 * Lockstep 客户端（DESIGN §6 / §9.7 / ADR-14）：
 * 只交换输入不同步状态——每端本地模拟全部逻辑。
 *  - 本地输入延迟 INPUT_DELAY 帧：采样后延迟生效，掩盖网络抖动；
 *  - frame(tick) 等齐本端与远端输入才放行；等不到返回 null，
 *    调用方本帧停步——网络慢时画面自然减速（lockstep 语义）；
 *  - 每 HASH_STRIDE tick 交换状态哈希，不一致回调 onDesync；
 *  - hello 互验配置指纹，错配在开跑前报错。
 * sim 零改动：本类实现 core 的 InputSource。
 */
import type { ButtonMask, InputFrame, InputSource } from '@bvn/core';
import type { NetMessage, PlayerSlot } from './protocol.js';
import type { Transport } from './transport.js';

/** 本地输入延迟帧（DESIGN §6：2~3 帧，取 3）。 */
export const INPUT_DELAY = 3;
/** 哈希交换间隔 tick（1 秒一次失步检测）。 */
export const HASH_STRIDE = 60;
/** 输入/哈希表保留窗口（tick）——过期条目定期清理防泄漏。 */
const KEEP_TICKS = 240;

export interface LockstepOptions {
  transport: Transport;
  /** 本端玩家位（= fighter id） */
  localPlayer: PlayerSlot;
  /** 配置指纹（makeConfigHash）；提供则开跑前互验 */
  configHash?: string;
  inputDelay?: number;
  hashStride?: number;
  onDesync?: (tick: number, localHash: string, remoteHash: string) => void;
  onPeerLost?: () => void;
  onConfigMismatch?: (localHash: string, remoteHash: string) => void;
}

export class LockstepClient implements InputSource {
  private readonly transport: Transport;
  private readonly localPlayer: PlayerSlot;
  private readonly delay: number;
  private readonly stride: number;
  private readonly opts: LockstepOptions;

  private started = false;
  private startWaiters: (() => void)[] = [];
  /** 已对端的配置指纹（收到对端 hello 后记录） */
  private peerHello: { player: PlayerSlot; configHash: string } | null = null;

  /** 下一个待采样的本端输入生效 tick */
  private nextSampleTick = 0;
  /** 本端输入：生效 tick → 位图（延迟帧的本金） */
  private readonly local = new Map<number, ButtonMask>();
  /** 远端输入：生效 tick → 位图 */
  private readonly remote = new Map<number, ButtonMask>();
  /** 失步检测：tick → { 本端, 远端 } 哈希，双到齐即比对 */
  private readonly ownHash = new Map<number, string>();
  private readonly remoteHash = new Map<number, string>();
  private lastCompletedTick = -1;

  constructor(opts: LockstepOptions) {
    this.opts = opts;
    this.transport = opts.transport;
    this.localPlayer = opts.localPlayer;
    this.delay = opts.inputDelay ?? INPUT_DELAY;
    this.stride = opts.hashStride ?? HASH_STRIDE;
    this.transport.onMessage((msg) => this.handle(msg));
    this.transport.onClose(() => this.opts.onPeerLost?.());
    if (opts.configHash !== undefined) {
      this.transport.send({ t: 'hello', player: this.localPlayer, configHash: opts.configHash });
    }
  }

  /** 无中继场景（同进程 / 测试）直接开跑；中继场景由 start 消息触发。 */
  begin(): void {
    this.setStarted();
  }

  /** 等待开跑信号（中继场景：两人凑齐后的 start 广播）。 */
  waitStarted(): Promise<void> {
    if (this.started) return Promise.resolve();
    return new Promise((res) => this.startWaiters.push(res));
  }

  /**
   * 开跑时预填 [0, inputDelay) 的本端输入（延迟帧窗口的开局本金，
   * 否则前 delay tick 永远等不到本地输入）。
   */
  prime(mask: ButtonMask): void {
    for (let t = 0; t < this.delay; t++) this.sample(t, mask);
  }

  /**
   * 每完成一个 sim tick 调用一次：为 tick+delay 采样本地输入并上行。
   * 采样点 = sim tick 而非渲染帧——输入位图与生效 tick 一一对应。
   */
  poll(mask: ButtonMask): void {
    if (!this.started) return;
    this.sample(this.nextSampleTick, mask);
  }

  /** sim tick 结束后上报哈希；与远端哈希在 tick 汇合处比对。 */
  afterTick(tick: number, hash: string): void {
    this.lastCompletedTick = tick;
    if ((tick + 1) % this.stride === 0) {
      const at = tick + 1;
      this.ownHash.set(at, hash);
      this.transport.send({ t: 'hash', tick: at, hash });
      this.compare(at, hash);
      this.prune(at);
    }
  }

  frame(tick: number): InputFrame | null {
    const l = this.local.get(tick);
    const r = this.remote.get(tick);
    if (l === undefined || r === undefined) return null;
    return this.localPlayer === 1 ? { p1: l, p2: r } : { p1: r, p2: l };
  }

  private sample(tick: number, mask: ButtonMask): void {
    if (tick !== this.nextSampleTick) return; // 顺序保护：只按序采样
    this.local.set(tick, mask);
    this.transport.send({ t: 'input', tick, mask });
    this.nextSampleTick = tick + 1;
  }

  private compare(tick: number, own: string): void {
    const remote = this.remoteHash.get(tick);
    if (remote !== undefined && remote !== own) {
      this.opts.onDesync?.(tick, own, remote);
    }
  }

  private prune(tick: number): void {
    const min = tick - KEEP_TICKS;
    for (const k of this.local.keys()) if (k < min) this.local.delete(k);
    for (const k of this.remote.keys()) if (k < min) this.remote.delete(k);
    for (const k of this.ownHash.keys()) if (k < min) this.ownHash.delete(k);
    for (const k of this.remoteHash.keys()) if (k < min) this.remoteHash.delete(k);
  }

  private setStarted(): void {
    if (this.started) return;
    this.started = true;
    for (const res of this.startWaiters) res();
    this.startWaiters = [];
  }

  private handle(msg: NetMessage): void {
    switch (msg.t) {
      case 'hello': {
        this.peerHello = { player: msg.player, configHash: msg.configHash };
        if (
          this.opts.configHash !== undefined &&
          msg.configHash !== this.opts.configHash
        ) {
          this.opts.onConfigMismatch?.(this.opts.configHash, msg.configHash);
        }
        break;
      }
      case 'start':
        this.setStarted();
        break;
      case 'input':
        this.remote.set(msg.tick, msg.mask);
        break;
      case 'hash':
        this.remoteHash.set(msg.tick, msg.hash);
        {
          const own = this.ownHash.get(msg.tick);
          if (own !== undefined) this.compare(msg.tick, own);
        }
        break;
      case 'peer-lost':
        this.opts.onPeerLost?.();
        break;
    }
  }
}
