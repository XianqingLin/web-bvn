/**
 * Rollback 联机客户端（2026-11-22 立项，DESIGN §6 rollback 定案；GGPO 范式移植）。
 *
 * 与 LockstepClient 共用同一套 input/hash 协议与中继（服务器零改动），差别在调度：
 *  - 本地输入零延迟：tick N 用当下按住的位图，立即生效并上行（lockstep 的
 *    INPUT_DELAY 前瞻采样取消）；
 *  - 远端输入未到 → 预测推进（沿用最近收到的远端位图），画面**永不慢放**；
 *  - 远端真输入到达且与该 tick 预测不符 → 回滚到首个分歧 tick：恢复历史状态
 *    （Sim.fromState，core 预留接口）以修正输入重演至当前 tick，再推进新 tick。
 *    重演在下一步 step() 开跑前执行（WS 回调里不同步重入）；
 *  - 重演段快照事件剥除：预测期已放过的表现（音效/特效）不撤回不重放，
 *    避免双触发（GGPO 同款取舍，登记为已知 trade-off）；修正快照仍喂渲染层
 *    （位置/姿态由插值收敛纠正）；
 *  - 失步检测沿用：仅在"该 tick 双方输入全部为真实值"（无未决预测）时上行/
 *    比对哈希——预测纠正不产生假失步；迟到确认的槽位用逐 tick 保存的哈希补发；
 *  - 无硬预测上限（GGPO 语义：对端静默按空闲预测，永不死锁——lockstep 的
 *    双端停步互等在这里会变成死锁，不能照搬）；对端静默超时才冻结（见下）。
 *
 * sim 所有权归本类：回滚会整体重建 Sim 实例（Sim.fromState），调用方只消费
 * step() 返回的快照（现状 + 纠正段），不再直接持有 sim。
 */
import { Sim } from '@bvn/core';
import type { SimSnapshot, SimState, ButtonMask, FighterDef, AssisterDef } from '@bvn/core';
import type { NetMessage, PlayerSlot } from './protocol.js';
import type { Transport } from './transport.js';

/** 对端静默超时（ms）：无硬预测上限后，这是唯一"远端失联"兜底（冻结等待）。 */
export const PEER_SILENT_TIMEOUT_MS = 5000;
/** 哈希交换间隔 tick（0.5s 一次失步检测；lockstep 为 60，回滚侧收紧一倍）。 */
export const RB_HASH_STRIDE = 30;
/** 哈希/输入表保留窗口（tick）——远端哈希迟到路径的比对余量。 */
const HASH_KEEP_TICKS = 600;

export interface RollbackStep {
  /** 本 tick 快照（新推进的 tick，含表现事件；调用方正常消费） */
  snapshot: SimSnapshot;
  /**
   * 预测纠正段 [from..curTick) 的重演快照（事件已剥除，仅喂渲染层；
   * 这些 tick 已交付过一次，表现层不得重放其事件）。
   */
  corrections: SimSnapshot[];
  /** 本次回滚起始 tick（无回滚 = null；诊断/HUD 用） */
  rolledBackFrom: number | null;
}

export interface RollbackOptions {
  transport: Transport;
  /** 会话持有的 sim（所有权移交——回滚时整体重建实例） */
  sim: Sim;
  localPlayer: PlayerSlot;
  /** 配置指纹（makeConfigHash）；提供则开跑前互验 */
  configHash?: string | undefined;
  /** sim 构造时的训练开关（fromState 回传；net 对局恒 false，测试用） */
  training?: boolean | undefined;
  hashStride?: number | undefined;
  /** 对端静默超时（ms；缺省 PEER_SILENT_TIMEOUT_MS） */
  peerTimeoutMs?: number | undefined;
  onDesync?: ((tick: number, localHash: string, remoteHash: string) => void) | undefined;
  onPeerLost?: (() => void) | undefined;
  onConfigMismatch?: ((localHash: string, remoteHash: string) => void) | undefined;
  /** 每次回滚回调（诊断：起始 tick → 重演到的 tick） */
  onRollback?: ((from: number, to: number) => void) | undefined;
}

export class RollbackSession {
  private readonly transport: Transport;
  private readonly localPlayer: PlayerSlot;
  private readonly opts: RollbackOptions;
  private readonly stride: number;
  private readonly peerTimeoutMs: number;
  /** 回滚会整体重建实例——此处可变 */
  private sim: Sim;
  private readonly defs: [number, FighterDef][];
  private readonly assistants: Record<string, AssisterDef>;
  private readonly training: boolean;

  private started = false;
  private startWaiters: (() => void)[] = [];
  private peerHello: { player: PlayerSlot; configHash: string } | null = null;
  private peerLost = false;
  /** 致命错误（历史缺失等不可恢复状态）：冻结等待并提示 */
  private fatal: string | null = null;

  /** 下一个待推进 tick（= 已完成 tick 数） */
  private curTick = 0;
  /** 历史状态：键 k = tick k 开跑前的状态（k=0 为初始状态）。重演会覆盖。 */
  private readonly history = new Map<number, SimState>();
  /** 本端真实输入（不可变）：tick → 位图 */
  private readonly localInputs = new Map<number, ButtonMask>();
  /** 远端真实输入：tick → 位图 */
  private readonly remoteInputs = new Map<number, ButtonMask>();
  /** 已按预测推进、未被真输入确认的 tick → 当时采用的预测位图 */
  private readonly predicted = new Map<number, ButtonMask>();
  /** 最近收到的远端真实位图（预测 = 沿用它） */
  private lastRemoteMask: ButtonMask = 0;
  /** 最近收到远端真实输入的 tick 与墙钟（静默超时用） */
  private lastRemoteTick = -1;
  private lastRemoteMs = 0;

  /** 每 tick 状态哈希（键 = tick，值 = 该 tick 开跑前状态的哈希 = 完成了 tick-1） */
  private readonly ownHashes = new Map<number, string>();
  private readonly remoteHashes = new Map<number, string>();
  private readonly hashSent = new Set<number>();
  private readonly hashCompared = new Set<number>();
  /** 待回滚的最早分歧 tick（WS 回调标记，step() 开跑前消费） */
  private pendingRollback: number | null = null;

  /** 诊断：累计回滚次数 / 最近一次回滚起始 tick */
  rollbackCount = 0;
  lastRollbackFrom: number | null = null;

  constructor(opts: RollbackOptions) {
    this.opts = opts;
    this.transport = opts.transport;
    this.localPlayer = opts.localPlayer;
    this.sim = opts.sim;
    this.defs = opts.sim.getDefEntries();
    this.assistants = opts.sim.getAssisterDefs();
    this.training = opts.training ?? false;
    this.stride = opts.hashStride ?? RB_HASH_STRIDE;
    this.peerTimeoutMs = opts.peerTimeoutMs ?? PEER_SILENT_TIMEOUT_MS;
    this.lastRemoteMs = performance.now();
    // 回滚锚点：tick 0 的开跑前状态（此后每 tick 完成时补 history[tick+1]）
    this.history.set(0, Sim.deserializeState(this.sim.serializeState()));
    this.transport.onMessage((msg) => this.handle(msg));
    this.transport.onClose(() => this.declarePeerLost());
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
   * 推进一个 tick。localMask = 当下按住的位图（零延迟立即生效）。
   * 返回 null = 未开跑 / 对端失联 / 致命错误——调用方本帧停步（冻结语义）。
   * 正常对局中恒非 null（预测兜底，无 lockstep 式减速）。
   */
  step(localMask: ButtonMask): RollbackStep | null {
    if (!this.started || this.peerLost || this.fatal !== null) return null;
    // 对端静默超时（无硬预测上限的对偶兜底：连接未断但数据停了）
    if (this.curTick > 0 && performance.now() - this.lastRemoteMs > this.peerTimeoutMs) {
      this.declarePeerLost();
      return null;
    }

    const corrections: SimSnapshot[] = [];
    let rolledBackFrom: number | null = null;

    // 0. 消费待回滚冲突：恢复分歧前状态，以修正输入重演至当前 tick
    if (this.pendingRollback !== null) {
      const from = this.pendingRollback;
      const pre = this.history.get(from);
      if (pre === undefined) {
        // 防御（理论不可达：回滚目标 ≥ 最早未确认 tick，历史保留窗覆盖）：
        // 不可静默——宁可冻结报错也不在错误时间线上继续跑
        this.fatal = `rollback 历史缺失（tick ${from}）`;
        this.pendingRollback = null;
        return null;
      }
      rolledBackFrom = from;
      this.rollbackCount += 1;
      this.lastRollbackFrom = from;
      this.sim = Sim.fromState(pre, this.defs, {
        training: this.training,
        assistants: this.assistants,
      });
      // 重演段全部重算：已推进 tick 的预测记录先清空（重演中按需重标）
      for (const t of [...this.predicted.keys()]) {
        if (t >= from) this.predicted.delete(t);
      }
      for (let t = from; t < this.curTick; t++) {
        // 重演：本地输入取已存真实值（不可变）；远端真实优先、缺席重预测。
        // 不重发本端输入（已上行过，位图不可变）。
        const snap = this.runTick(t, this.localInputs.get(t)!, false);
        corrections.push({ ...snap, events: [] }); // 表现事件剥除（不重放）
      }
      this.pendingRollback = null;
      this.opts.onRollback?.(from, this.curTick);
    }

    // 1. 推进新 tick（本地输入即时采样即上行；远端缺席 → 预测）
    const snap = this.runTick(this.curTick, localMask, true);
    this.curTick += 1;
    this.prune();
    return { snapshot: snap, corrections, rolledBackFrom };
  }

  /**
   * 跑一个 tick 并登记状态。send = 是否采样上行（正常推进 true；重演 false——
   * 本端输入不可变，已上行过）。
   */
  private runTick(tick: number, localMask: ButtonMask, send: boolean): SimSnapshot {
    if (send) {
      this.localInputs.set(tick, localMask);
      this.transport.send({ t: 'input', tick, mask: localMask });
    }
    let remoteMask = this.remoteInputs.get(tick);
    if (remoteMask === undefined) {
      remoteMask = this.lastRemoteMask; // 预测：沿用最近已知远端位图
      this.predicted.set(tick, remoteMask);
    }
    const snap = this.sim.tick(
      this.localPlayer === 1
        ? { p1: localMask, p2: remoteMask }
        : { p1: remoteMask, p2: localMask },
    );
    // snap.state = tick 完成后的状态 = tick+1 的开跑前状态；hash 同理。
    // 注意 state.tick 是自增前值（= 完成的 tick 号），而历史键语义是"开跑前"——
    // 存入时把 tick 修正为 tick+1，否则 fromState 恢复后重演的 tick 编号错一位。
    this.history.set(snap.tick + 1, { ...snap.state, tick: snap.tick + 1 });
    this.ownHashes.set(snap.tick + 1, snap.hash);
    this.maybeEmitHashes();
    return snap;
  }

  /** 最早未确认 tick（其 -1 及之前全部输入为真实值，状态已终局化）。 */
  private get confirmedUpTo(): number {
    let min = this.curTick;
    for (const t of this.predicted.keys()) if (t < min) min = t;
    return min - 1;
  }

  /**
   * 择机上行哈希：槽位 at（= 完成了 tick at-1 的状态哈希）仅在
   * at-1 ≤ confirmedUpTo（无未决预测）时发送——预测纠正不产生假失步；
   * 迟到确认的槽位由逐 tick 保存的 ownHashes 补发。
   */
  private maybeEmitHashes(): void {
    const limit = Math.min(this.confirmedUpTo + 1, this.curTick);
    for (let at = this.stride; at <= limit; at += this.stride) {
      const own = this.ownHashes.get(at);
      if (own === undefined) continue;
      if (this.hashSent.has(at)) continue;
      this.hashSent.add(at);
      this.transport.send({ t: 'hash', tick: at, hash: own });
      this.compare(at, own);
    }
  }

  private compare(at: number, own: string): void {
    const remote = this.remoteHashes.get(at);
    if (remote !== undefined && !this.hashCompared.has(at)) {
      this.hashCompared.add(at);
      if (remote !== own) this.opts.onDesync?.(at, own, remote);
    }
  }

  /** 保留窗清理：历史/输入只保回滚可能触及的范围（最早未确认 tick 起）。 */
  private prune(): void {
    let minState = this.curTick;
    for (const t of this.predicted.keys()) if (t < minState) minState = t;
    for (const k of this.history.keys()) if (k < minState) this.history.delete(k);
    for (const k of this.localInputs.keys()) if (k < minState) this.localInputs.delete(k);
    for (const k of this.remoteInputs.keys()) if (k < minState) this.remoteInputs.delete(k);
    const minHash = this.curTick - HASH_KEEP_TICKS;
    for (const k of this.ownHashes.keys()) if (k < minHash) this.ownHashes.delete(k);
    for (const k of this.remoteHashes.keys()) if (k < minHash) this.remoteHashes.delete(k);
    for (const k of this.hashSent) if (k < minHash) this.hashSent.delete(k);
    for (const k of this.hashCompared) if (k < minHash) this.hashCompared.delete(k);
  }

  private declarePeerLost(): void {
    if (this.peerLost) return;
    this.peerLost = true;
    this.opts.onPeerLost?.();
  }

  private setStarted(): void {
    if (this.started) return;
    this.started = true;
    this.lastRemoteMs = performance.now();
    for (const res of this.startWaiters) res();
    this.startWaiters = [];
  }

  private handle(msg: NetMessage): void {
    switch (msg.t) {
      case 'hello': {
        this.peerHello = { player: msg.player, configHash: msg.configHash };
        if (this.opts.configHash !== undefined && msg.configHash !== this.opts.configHash) {
          this.opts.onConfigMismatch?.(this.opts.configHash, msg.configHash);
        }
        break;
      }
      case 'start':
        this.setStarted();
        break;
      case 'input': {
        const t = msg.tick;
        if (this.remoteInputs.has(t)) break; // 幂等（重复投递防御）
        this.remoteInputs.set(t, msg.mask);
        this.lastRemoteMask = msg.mask;
        this.lastRemoteTick = t;
        this.lastRemoteMs = performance.now();
        // 已按预测推进过的 tick：真输入与预测不符 → 标记回滚（最早分歧优先；
        // 延迟到下一步 step() 开跑前执行，WS 回调里不同步重入重演）
        const used = this.predicted.get(t);
        if (used !== undefined) {
          this.predicted.delete(t);
          if (used !== msg.mask) {
            this.pendingRollback =
              this.pendingRollback === null ? t : Math.min(this.pendingRollback, t);
          }
        }
        this.maybeEmitHashes();
        break;
      }
      case 'hash': {
        this.remoteHashes.set(msg.tick, msg.hash);
        {
          const own = this.ownHashes.get(msg.tick);
          if (own !== undefined) this.compare(msg.tick, own);
        }
        break;
      }
      case 'peer-lost':
        this.declarePeerLost();
        break;
    }
  }
}
