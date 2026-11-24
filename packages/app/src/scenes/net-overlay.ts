/**
 * 菜单内联机浮层（DESIGN §6.4）：加入/匹配/房间在主菜单原地完成，统一走
 * 半透明暗底浮层（背景菜单动画不断），只有真正开局才切场景。
 *
 * NetOverlay = 浮层基座：open 期间以全屏暗底挡住下层指针事件，键盘由
 * MenuScene 路转入 handleKey（菜单导航停摆），close 回调恢复菜单。
 * JoinOverlay = 加入房码浮层：6 位房码画布格子 + 隐藏 <input inputmode=numeric>
 * 采集（移动端数字键盘 / 粘贴）；输满 6 位回车确认入房（不自动入房），Esc 收回，
 * 失败红字抖动。
 */
import { Container, Graphics, Text } from 'pixi.js';
import {
  BufferedSocket,
  sendBegin,
  sendQueue,
  sendReady,
  sendRoomConfig,
  sendUnqueue,
  type RoomMemberInfo,
  type RoomSettings,
  type WsLike,
} from '@bvn/net';
import type { SceneCtx } from './scene.js';
import { tweenOf } from '../anim.js';
import { makeButton, makeLabel, UI_H, UI_W, type Button } from '../ui.js';
import type { Flow } from '../flow.js';
import { displayName, enterRoom, openServerSocket, roomErrorText } from './net-common.js';
import { reportInviteContext } from '../invite-context.js';
import { SetupScene } from './setup.js';

/** 全屏暗底（半透明，菜单背景动画透出）。 */
const BACKDROP = { color: 0x040a14, alpha: 0.62 };

/** 房码长度与格子规格（单行居中）。 */
const CODE_LEN = 6;
const CELL_W = 56;
const CELL_H = 76;
const CELL_GAP = 14;
const CELL_RADIUS = 8;

/** 格子配色：常态 / 聚焦（下一待填格）/ 输满待确认 / 连接中冻结。 */
const CELL = {
  fill: 0x0d1420,
  fillActive: 0x142138,
  border: 0x3a4a66,
  borderActive: 0x7ea0d4,
  borderReady: 0x8fd0ff,
};

/** 错误红字抖动（衰减正弦；pivot 偏移渲染，不占布局）。 */
const SHAKE_MS = 480;
const SHAKE_AMP = 8;

export abstract class NetOverlay {
  readonly ui = new Container();
  protected readonly content = new Container();

  private openState = false;
  private onClosed: (() => void) | null = null;

  constructor() {
    const backdrop = new Graphics();
    backdrop.rect(0, 0, UI_W, UI_H).fill({ color: BACKDROP.color, alpha: BACKDROP.alpha });
    // 暗底吃掉指针事件：浮层开启期下层菜单按钮 hover/点击不可达
    backdrop.eventMode = 'static';
    this.ui.addChild(backdrop, this.content);
    this.ui.visible = false;
  }

  /** 打开浮层；收回落回 onClosed（MenuScene 借此恢复菜单导航）。 */
  open(onClosed: () => void): void {
    this.openState = true;
    this.onClosed = onClosed;
    this.ui.visible = true;
  }

  /** 键盘路由（浮层开启期由 MenuScene 转入；已聚焦 DOM 输入的按键不经此处）。 */
  abstract handleKey(e: KeyboardEvent): void;

  update(_dtMs: number): void {}

  /** 释放浮层外的资源（DOM 采集等）；场景 exit 时兜底调用。 */
  dispose(): void {}

  /** 浮层开启中（MenuScene 键盘路由判定用）。 */
  get isOpen(): boolean {
    return this.openState;
  }

  /** 收回浮层（子类先撤自己的 DOM 采集再调用）；onClosed 一次性触发。 */
  protected close(): void {
    if (!this.openState) return;
    this.openState = false;
    this.ui.visible = false;
    const cb = this.onClosed;
    this.onClosed = null;
    cb?.();
  }
}

export class JoinOverlay extends NetOverlay {
  /** 当前房码（纯数字，≤6 位；与隐藏 input.value 单向同步）。 */
  private digits = '';
  private connecting = false;
  private input: HTMLInputElement | null = null;

  private readonly cellG = new Graphics();
  private readonly cells: Text[] = [];
  private readonly status: Text;
  private readonly statusX = UI_W / 2;
  private shakeMs = 0;

  constructor(
    private readonly ctx: SceneCtx,
    private readonly flow: Flow,
    /** 入房成功回调：socket 移交（菜单接手到房间浮层） */
    private readonly onJoined: (socket: BufferedSocket) => void,
  ) {
    super();

    const title = makeLabel('加入房间', { size: 30, bold: true });
    title.anchor.set(0.5);
    title.position.set(UI_W / 2, 150);
    this.content.addChild(title);

    const rowStartX = (UI_W - (CODE_LEN * CELL_W + (CODE_LEN - 1) * CELL_GAP)) / 2;
    const row = new Container();
    row.position.set(rowStartX, 236);
    row.eventMode = 'static';
    row.cursor = 'text';
    row.on('pointertap', () => this.input?.focus());
    row.addChild(this.cellG);
    for (let i = 0; i < CODE_LEN; i++) {
      const t = makeLabel('', { size: 40, color: 0xffffff, bold: true });
      t.anchor.set(0.5);
      t.position.set(i * (CELL_W + CELL_GAP) + CELL_W / 2, CELL_H / 2);
      this.cells.push(t);
      row.addChild(t);
    }
    this.content.addChild(row);

    const hint = makeLabel('输入 6 位数字房码，回车入房', { size: 14, color: 0x7a86a0 });
    hint.anchor.set(0.5);
    hint.position.set(UI_W / 2, 348);
    this.content.addChild(hint);

    this.status = makeLabel('', { size: 16, color: 0xffd54f });
    this.status.anchor.set(0.5);
    this.status.position.set(this.statusX, 392);
    this.content.addChild(this.status);

    this.syncCells();
  }

  open(onClosed: () => void): void {
    super.open(onClosed);
    this.digits = '';
    this.connecting = false;
    this.shakeMs = 0;
    this.status.text = '';
    this.status.style.fill = 0xffd54f;
    this.syncCells();
    this.mountInput();
  }

  handleKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.retract();
      return;
    }
    if (this.connecting) return;
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      if (this.digits.length < CODE_LEN) {
        this.digits += e.key;
        this.syncCells();
        this.input?.focus();
      }
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      if (this.digits.length > 0) {
        this.digits = this.digits.slice(0, -1);
        this.syncCells();
        this.input?.focus();
      }
    } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'j' || e.key === 'J') {
      e.preventDefault();
      this.confirm();
    }
  }

  update(dtMs: number): void {
    if (this.shakeMs <= 0) return;
    this.shakeMs = Math.max(0, this.shakeMs - dtMs);
    const k = this.shakeMs / SHAKE_MS; // 1 → 0 衰减
    this.status.x = this.statusX + Math.sin(k * Math.PI * 5) * SHAKE_AMP * k;
    if (this.shakeMs === 0) this.status.x = this.statusX;
  }

  dispose(): void {
    this.teardownInput();
  }

  /** dev 直通：预填房码并直接确认入房（UI 入口不调）。 */
  autoFill(room: string): void {
    const digits = room.replace(/\D/g, '').slice(0, CODE_LEN);
    if (digits.length < CODE_LEN) return;
    this.digits = digits;
    this.syncCells();
    this.confirm();
  }

  // ---------- 房码采集 ----------

  /** 隐藏采集输入：视觉隐藏但仍可聚焦（移动端唤起数字键盘），格子只是显示层。 */
  private mountInput(): void {
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.maxLength = CODE_LEN;
    input.style.cssText =
      'position:absolute;left:50%;top:46%;transform:translate(-50%,-50%);width:2px;height:2px;' +
      'opacity:0;font-size:16px;border:0;padding:0;margin:0;background:transparent;' +
      'color:transparent;caret-color:transparent;outline:none;z-index:18;';
    input.addEventListener('input', () => {
      const v = input.value.replace(/\D/g, '').slice(0, CODE_LEN);
      if (v !== input.value) input.value = v;
      this.digits = v;
      this.syncCells();
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // 不泄漏进菜单键盘采集
      if (e.key === 'Enter') {
        e.preventDefault();
        this.confirm();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.retract();
      }
    });
    input.addEventListener('blur', () => {
      // 点击画布等导致的失焦拉回；撤下的 input 已置空，不再拉
      if (this.input) window.setTimeout(() => this.input?.focus(), 0);
    });
    this.ctx.domHost.appendChild(input);
    this.input = input;
    input.focus();
  }

  private teardownInput(): void {
    const el = this.input;
    this.input = null;
    el?.remove();
  }

  // ---------- 格子与状态 ----------

  /** 重绘格子边框 + 同步数字 + 回写 input.value（编程式改动不触发 input 事件）。 */
  private syncCells(): void {
    const g = this.cellG;
    g.clear();
    const active = this.connecting ? -1 : Math.min(this.digits.length, CODE_LEN - 1);
    const ready = !this.connecting && this.digits.length >= CODE_LEN;
    for (let i = 0; i < CODE_LEN; i++) {
      const x = i * (CELL_W + CELL_GAP);
      const border = this.connecting
        ? CELL.border
        : ready
          ? CELL.borderReady
          : i === active
            ? CELL.borderActive
            : CELL.border;
      g.roundRect(x, 0, CELL_W, CELL_H, CELL_RADIUS)
        .fill({ color: i === active ? CELL.fillActive : CELL.fill, alpha: 0.94 })
        .stroke({ width: 2, color: border });
      this.cells[i]!.text = this.digits[i] ?? '';
    }
    if (this.input && this.input.value !== this.digits) this.input.value = this.digits;
  }

  /** 上屏状态文字（颜色随语义；错误另起抖动）。 */
  private setStatus(text: string, color: number): void {
    this.status.text = text;
    this.status.style.fill = color;
  }

  private fail(text: string): void {
    this.setStatus(text, 0xff5f5f);
    this.shakeMs = SHAKE_MS;
  }

  // ---------- 流程 ----------

  /** Esc 收回：撤下 DOM 采集并回落菜单；连接中不显式断开，完成回调按浮层状态收尾。 */
  private retract(): void {
    this.teardownInput();
    this.close();
  }

  /** 回车确认：6 位齐才入房（不自动入房）；连接期冻结编辑。 */
  private confirm(): void {
    if (this.connecting) return;
    if (this.digits.length < CODE_LEN) {
      this.fail('请输满 6 位房码');
      return;
    }
    this.connecting = true;
    this.setStatus('连接服务器…', 0xffd54f);
    this.syncCells();
    void enterRoom(this.flow, 'join', this.digits).then(
      ({ socket }) => {
        // 连接期间浮层已被收回：不入房，收掉连接
        if (!this.isOpen) {
          socket.close();
          return;
        }
        this.teardownInput();
        // 上报平台邀请上下文：本端已处于可被邀请加入的房间（platform-seam §4）
        reportInviteContext(this.flow, { room: this.flow.room, node: this.flow.nodeInfo?.nodeId ?? '' });
        this.close();
        this.onJoined(socket);
      },
      (e: unknown) => {
        if (!this.isOpen) return;
        this.connecting = false;
        this.syncCells();
        this.fail(roomErrorText(e));
      },
    );
  }
}

// ---------- 随机匹配浮层 ----------

/** P1/P2 位次色（与选人页双色框同族：P1 蓝 / P2 粉）。 */
const SIDE_COLORS: Record<1 | 2, number> = { 1: 0x2f9bff, 2: 0xff5fa2 };

/** 横幅展示下限（上限以建连就绪为准）。 */
const BANNER_MIN_MS = 2500;
/** 建连失败自动重排的间隔。 */
const RETRY_DELAY_MS = 1200;

/**
 * VS 横幅：左右色块 + 昵称 + 中央 VS + 顶部文案；返回容器（调用方自行挂载/销毁）。
 * 偏离登记：「头像」暂以位次色块占位（同选人页色族）——平台头像资料接入后收口。
 */
export function buildVsBanner(leftName: string, rightName: string, caption = '已找到对手'): Container {
  const root = new Container();

  const cap = makeLabel(caption, { size: 20, color: 0xffd54f, bold: true });
  cap.anchor.set(0.5);
  cap.position.set(UI_W / 2, 180);
  root.addChild(cap);

  const side = (name: string, color: number, x: number) => {
    const box = new Container();
    const g = new Graphics();
    g.rect(0, 0, 280, 170).fill({ color, alpha: 0.25 });
    g.stroke({ width: 2, color }).rect(1, 1, 278, 168);
    box.addChild(g);
    const face = makeLabel('?', { size: 64, color, bold: true });
    face.anchor.set(0.5);
    face.position.set(140, 62);
    box.addChild(face);
    const t = makeLabel(name, { size: 22, color: 0xffffff, bold: true });
    t.anchor.set(0.5, 0);
    t.position.set(140, 108);
    box.addChild(t);
    box.position.set(x, 230);
    return box;
  };
  root.addChild(side(leftName, SIDE_COLORS[1], UI_W / 2 - 340));
  root.addChild(side(rightName, SIDE_COLORS[2], UI_W / 2 + 60));

  const vs = makeLabel('VS', { size: 64, color: 0xffffff, bold: true });
  vs.anchor.set(0.5);
  vs.position.set(UI_W / 2, 315);
  root.addChild(vs);

  return root;
}

/** 秒表文本（匹配中 MM:SS）。 */
function clockText(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 随机匹配浮层：待机（模式偏好 + 开始）→ 匹配中（秒表 + ✕ 滑出）→
 * VS 横幅（下限 2.5s + start 就绪即切选人页）。失败自动重排，Esc/✕ 退队回待机。
 * 模式偏好仅待机可切（上行 queue.team，权威值以 matched.team 回执为准）。
 */
export class MatchOverlay extends NetOverlay {
  private state: 'idle' | 'matching' | 'banner' = 'idle';

  private readonly body = new Container();
  private readonly status: Text;
  private readonly statusX = UI_W / 2;

  private socket: WsLike | null = null;
  /** 底层连接已断（退队不再上行，仅等待重连重排） */
  private linkClosed = false;
  /** 重试定时器在途（error + close 连锁只排一次） */
  private retrying = false;
  /** 匹配中秒表与横幅期状态 */
  private matchingMs = 0;
  private matchingLabel: Text | null = null;
  private banner: { left: string; right: string } | null = null;
  private bannerMs = 0;
  private startReady = false;
  /** 已移交选人页（dispose 不得关 socket） */
  private handedOver = false;
  private readonly timers: number[] = [];

  constructor(
    private readonly ctx: SceneCtx,
    private readonly flow: Flow,
  ) {
    super();
    this.content.addChild(this.body);
    this.status = makeLabel('', { size: 16, color: 0xffd54f });
    this.status.anchor.set(0.5);
    this.status.position.set(this.statusX, 500);
    this.content.addChild(this.status);
  }

  open(onClosed: () => void): void {
    super.open(onClosed);
    this.toIdle();
  }

  handleKey(e: KeyboardEvent): void {
    const k = e.key;
    if (k === 'Escape') {
      e.preventDefault();
      if (this.state === 'idle') this.retract();
      else this.cancel();
      return;
    }
    if (this.state === 'idle') {
      if (k === 'Enter' || k === ' ' || k === 'j' || k === 'J') {
        e.preventDefault();
        this.startMatching();
      } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
        e.preventDefault();
        this.flow.matchTeam = !this.flow.matchTeam;
        this.renderIdle();
      }
    }
  }

  update(dtMs: number): void {
    if (this.state === 'matching') {
      this.matchingMs += dtMs;
      const label = this.matchingLabel;
      if (label) {
        const text = `匹配中 ${clockText(this.matchingMs)}`;
        if (label.text !== text) label.text = text;
      }
    } else if (this.state === 'banner' && this.banner && !this.handedOver) {
      this.bannerMs += dtMs;
      // 横幅下限已满且建连就绪（start 已到）→ 切选人页
      if (this.startReady && this.bannerMs >= BANNER_MIN_MS) this.enterSetup();
    }
  }

  dispose(): void {
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.length = 0;
    if (this.socket && !this.handedOver) {
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.close();
    }
    this.socket = null;
  }

  /** dev 直通：打开后直接开始匹配（UI 入口不调）。 */
  autoStart(): void {
    if (this.state === 'idle') this.startMatching();
  }

  /** Esc 收回（仅待机态；连接在途的收尾同 JoinOverlay：完成回调按浮层状态处理）。 */
  private retract(): void {
    this.close();
  }

  // ---------- 状态渲染（body 按状态重建） ----------

  private clearBody(): void {
    this.body.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.matchingLabel = null;
  }

  private toIdle(): void {
    this.state = 'idle';
    this.banner = null;
    this.startReady = false;
    this.bannerMs = 0;
    this.matchingMs = 0;
    this.clearBody();
    this.renderIdle();
  }

  private renderIdle(): void {
    const modeBtn = makeButton(
      this.flow.matchTeam ? '模式：团队 3+1（点击切 1v1）' : '模式：单挑 1v1（点击切团队 3+1）',
      () => {
        this.flow.matchTeam = !this.flow.matchTeam;
        this.renderIdle();
      },
      { w: 320, h: 44, size: 16 },
    );
    modeBtn.position.set(UI_W / 2 - 160, 240);
    this.body.addChild(modeBtn);
    const btn = makeButton('随机匹配', () => this.startMatching(), { w: 220, h: 56 });
    btn.position.set(UI_W / 2 - 110, 310);
    this.body.addChild(btn);
    const hint = makeLabel('回车开始匹配 · ←/→ 切换模式 · Esc 收回', { size: 14, color: 0x7a86a0 });
    hint.anchor.set(0.5);
    hint.position.set(UI_W / 2, 420);
    this.body.addChild(hint);
  }

  /** 匹配中：秒表大字 + 红 ✕ 从右侧滑出（紧挨，一次点击取消）。 */
  private renderMatching(): void {
    this.clearBody();
    this.state = 'matching';
    const label = makeLabel(`匹配中 ${clockText(this.matchingMs)}`, { size: 32, color: 0xffffff, bold: true });
    label.anchor.set(0.5);
    label.position.set(UI_W / 2, 280);
    this.matchingLabel = label;
    this.body.addChild(label);
    const cancel = makeButton('✕', () => this.cancel(), { w: 44, h: 44, size: 20, color: 0x5e2222 });
    cancel.position.set(UI_W / 2 + 124, 258);
    cancel.scale.set(0.2, 1);
    this.body.addChild(cancel);
    tweenOf(cancel, { 'scale.x': 1 }, 160, { ease: (k) => k });
    const hint = makeLabel('Esc 退队', { size: 14, color: 0x7a86a0 });
    hint.anchor.set(0.5);
    hint.position.set(UI_W / 2, 420);
    this.body.addChild(hint);
  }

  /** 横幅期：VS 画面 + 底部 ✕（横幅期也可退队）。 */
  private renderBanner(): void {
    this.clearBody();
    this.state = 'banner';
    if (this.banner) this.body.addChild(buildVsBanner(this.banner.left, this.banner.right));
    const cancel = makeButton('✕', () => this.cancel(), { w: 44, h: 44, size: 20, color: 0x5e2222 });
    cancel.position.set(UI_W / 2 - 22, 440);
    this.body.addChild(cancel);
  }

  // ---------- 流程 ----------

  /** 待机 → 匹配中：建连 + 入队。 */
  private startMatching(): void {
    if (this.state !== 'idle') return;
    this.banner = null;
    this.startReady = false;
    this.bannerMs = 0;
    this.matchingMs = 0;
    this.status.text = '';
    this.renderMatching();
    void this.connectAndQueue().then((queued) => {
      if (!queued) this.failAndRequeue();
    });
  }

  /** 建连 + 入队（复用于首次与失败重排）。resolve = 队列已入。 */
  private async connectAndQueue(): Promise<boolean> {
    let ws: WebSocket;
    try {
      ws = await openServerSocket(this.flow.serverUrl);
    } catch {
      if (this.isOpen) this.setStatus('无法连接服务器，正在重试…', 0xffd54f);
      return false;
    }
    if (!this.isOpen || this.state !== 'matching' || this.handedOver) {
      ws.close();
      return false;
    }
    const socket = new BufferedSocket(ws as unknown as WsLike);
    this.socket = socket;
    this.linkClosed = false;
    socket.onmessage = (ev) => this.onMessage(ev);
    socket.onclose = () => this.onLinkClosed();
    sendQueue(socket, displayName(this.flow) || undefined, this.flow.matchTeam);
    return true;
  }

  /** 失败：提示后自动回匹配中继续排队，用户可 ✕/Esc。 */
  private failAndRequeue(): void {
    if (this.state !== 'matching' || !this.isOpen || this.handedOver) return;
    if (this.retrying) return; // error + close 连锁触发只排一次重试
    this.retrying = true;
    this.closeSocket();
    this.banner = null;
    this.renderMatching();
    this.setStatus('连接失败，正在重新匹配', 0xffd54f);
    this.timers.push(
      window.setTimeout(() => {
        this.retrying = false;
        if (this.state !== 'matching' || !this.isOpen || this.handedOver) return;
        this.setStatus('', 0xffd54f);
        void this.connectAndQueue().then((queued) => {
          if (!queued) this.failAndRequeue();
        });
      }, RETRY_DELAY_MS),
    );
  }

  /** ✕/Esc 退队：上行退队 + 断开，回待机态（一次点击、零二级交互）。 */
  private cancel(): void {
    if (this.state === 'idle') return;
    for (const id of this.timers.splice(0)) window.clearTimeout(id);
    this.retrying = false;
    if (this.socket) {
      if (!this.linkClosed) sendUnqueue(this.socket);
      this.closeSocket();
    }
    this.setStatus('', 0xffd54f);
    this.toIdle();
  }

  private closeSocket(): void {
    if (this.socket) {
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
    this.linkClosed = false;
  }

  private onLinkClosed(): void {
    if (this.handedOver) return;
    this.linkClosed = true;
    this.failAndRequeue();
  }

  /** 上屏状态文字。 */
  private setStatus(text: string, color: number): void {
    this.status.text = text;
    this.status.style.fill = color;
  }

  // ---------- 消息泵（matching/banner 期接管 socket） ----------

  private onMessage(ev: { data: unknown }): void {
    if (this.handedOver) return;
    let msg: { t?: string; [k: string]: unknown };
    try {
      const text = typeof ev.data === 'string' ? ev.data : (ev.data as { toString(): string }).toString();
      msg = JSON.parse(text);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'matched': {
        if (this.state !== 'matching' || this.banner) return;
        const flow = this.flow;
        flow.mode = 'net';
        flow.player = msg.player === 2 ? 2 : 1;
        flow.room = String(msg.room ?? '');
        const name = displayName(flow);
        flow.name = name || `玩家${flow.player}`;
        // 服务器裁定的模式 + 权威种子（无地图阶段，地图由 seed 解析）
        flow.team = msg.team === true;
        flow.mapSelect = false;
        flow.mapSeed = typeof msg.seed === 'number' ? msg.seed : null;
        const opponent = (msg.opponent as { name?: string } | undefined)?.name ?? '对手';
        this.banner = flow.player === 1
          ? { left: flow.name, right: opponent }
          : { left: opponent, right: flow.name };
        this.bannerMs = 0;
        this.setStatus('', 0xffd54f);
        this.renderBanner();
        break;
      }
      case 'start':
        // 配对房开局段 start（进选人页）；hello 收齐的第二段由对局层消费
        this.startReady = true;
        break;
      case 'error':
      case 'peer-lost':
        this.failAndRequeue();
        break;
      default:
        break;
    }
  }

  /** 建连就绪 → 移交选人页（socket 消息泵脱钩，lockstart 在战斗装配时接管）。 */
  private enterSetup(): void {
    const socket = this.socket;
    if (!socket || this.handedOver) return;
    this.handedOver = true;
    socket.onmessage = null;
    socket.onclose = null;
    this.socket = null;
    this.ctx.switchTo(new SetupScene(this.flow, socket));
  }
}

// ---------- 房间浮层 ----------

/** 房间快照（服务器权威；本端只上行 room-config/ready，不本地乐观翻转）。 */
interface RoomSnapshot {
  started: boolean;
  settings: RoomSettings;
  players: RoomMemberInfo[];
}

/** 静态房码行（6 格展示；复制入口旁挂）。 */
function buildCodeRow(code: string): Container {
  const row = new Container();
  const g = new Graphics();
  row.addChild(g);
  for (let i = 0; i < CODE_LEN; i++) {
    const x = i * (CELL_W + CELL_GAP);
    g.roundRect(x, 0, CELL_W, CELL_H, CELL_RADIUS)
      .fill({ color: CELL.fill, alpha: 0.94 })
      .stroke({ width: 2, color: CELL.borderReady });
    const t = makeLabel(code[i] ?? '', { size: 40, color: 0xffffff, bold: true });
    t.anchor.set(0.5);
    t.position.set(x + CELL_W / 2, CELL_H / 2);
    row.addChild(t);
  }
  return row;
}

/**
 * 房间浮层：房码 6 格 + 复制；席位卡 / 模式（房主可改、客座只读）/ 开始·准备 /
 * 离开。room-info 快照驱动重建；异常流：客座掉线房主继续等待，房主掉线客座
 * 提示后自动收回，断线禁操作；start → 移交选人页（真正开局才切场景）。
 */
export class RoomOverlay extends NetOverlay {
  private readonly body = new Container();
  private readonly status: Text;
  private readonly statusX = UI_W / 2;

  private socket: WsLike | null = null;
  private snapshot: RoomSnapshot | null = null;
  /** 已移交选人页（leave/dispose 不得关 socket） */
  private handedOver = false;
  /** 底层连接已断（禁操作，仅展示状态） */
  private linkClosed = false;
  /** create 建连握手期（房间快照未就绪） */
  private connecting = false;
  private readonly timers: number[] = [];

  constructor(
    private readonly ctx: SceneCtx,
    private readonly flow: Flow,
  ) {
    super();
    this.content.addChild(this.body);
    this.status = makeLabel('', { size: 15, color: 0xffd54f });
    this.status.anchor.set(0.5);
    this.status.position.set(this.statusX, 224);
    this.content.addChild(this.status);
  }

  /** 创建房间：浮层内建连 + create 握手，welcome 后进入房间。 */
  openAsCreate(onClosed: () => void): void {
    this.open(onClosed);
    this.startConnecting();
  }

  /** 已入房（加入路径）：socket 交接直接进房间，快照到达即渲染。 */
  openWithSocket(socket: WsLike, onClosed: () => void): void {
    this.open(onClosed);
    this.attach(socket);
    this.renderRoom();
  }

  handleKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.leave();
      return;
    }
    if (this.connecting || !this.snapshot || this.handedOver) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'j' || e.key === 'J') {
      e.preventDefault();
      const guest = this.snapshot.players.find((p) => p.player === 2);
      if (this.flow.player === 1) {
        if (guest?.ready === true && !this.linkClosed) sendBegin(this.socket!);
      } else if (!this.linkClosed) {
        sendReady(this.socket!, guest?.ready !== true);
      }
    }
  }

  dispose(): void {
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.length = 0;
    if (this.socket && !this.handedOver) {
      this.socket.onclose = null;
      this.socket.close();
    }
    this.socket = null;
  }

  // ---------- 建连与交接 ----------

  private startConnecting(): void {
    this.connecting = true;
    this.setStatus('', 0xffd54f);
    this.renderConnecting();
    void enterRoom(this.flow, 'create').then(
      ({ socket }) => {
        if (!this.isOpen) {
          socket.close();
          return;
        }
        this.connecting = false;
        // 上报平台邀请上下文：本端已处于可被邀请加入的房间（platform-seam §4）
        reportInviteContext(this.flow, { room: this.flow.room, node: this.flow.nodeInfo?.nodeId ?? '' });
        this.attach(socket);
        this.renderRoom();
      },
      (e: unknown) => {
        if (!this.isOpen) return;
        this.connecting = false;
        this.renderConnectError(roomErrorText(e));
      },
    );
  }

  private attach(socket: WsLike): void {
    this.socket = socket;
    this.linkClosed = false;
    socket.onmessage = (ev) => this.onMessage(ev);
    socket.onclose = () => this.onLinkClosed();
  }

  // ---------- 消息泵 ----------

  private onMessage(ev: { data: unknown }): void {
    let msg: { t?: string; code?: string; [k: string]: unknown };
    try {
      const text = typeof ev.data === 'string' ? ev.data : (ev.data as { toString(): string }).toString();
      msg = JSON.parse(text);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'room-info': {
        const snapshot: RoomSnapshot = {
          started: msg.started === true,
          settings: msg.settings as RoomSettings,
          players: msg.players as RoomMemberInfo[],
        };
        this.snapshot = snapshot;
        // 团队模式随快照同步（选人页 3+1 节奏依据）；好友房走地图选择阶段（房主定图）
        this.flow.team = snapshot.settings.team === true;
        this.flow.mapSelect = true;
        this.renderRoom();
        break;
      }
      case 'error':
        if (msg.code === 'guest-not-ready') this.setStatus('对方还未准备', 0xffd54f);
        break;
      case 'peer-lost':
        this.onPeerLost();
        break;
      case 'start':
        this.enterSetup();
        break;
      default:
        break;
    }
  }

  private onPeerLost(): void {
    if (this.flow.player === 1) {
      // 未开局客座掉线：房间保留，可继续等待/邀请（服务器已清客座槽位）
      this.setStatus('对方已离开，等待新玩家加入…', 0xffd54f);
      return;
    }
    // 房主掉线即解散：提示后自动收回浮层
    this.setStatus('房主已离开，房间解散', 0xff5f5f);
    this.timers.push(
      window.setTimeout(() => {
        if (this.isOpen) this.leave();
      }, 1200),
    );
  }

  private onLinkClosed(): void {
    if (this.handedOver) return;
    this.linkClosed = true;
    this.setStatus('与服务器断开连接', 0xff5f5f);
    this.renderRoom();
  }

  /** start 广播 → 移交选人页（阶段推进由服务器裁决）。 */
  private enterSetup(): void {
    const socket = this.socket;
    if (!socket || this.handedOver) return;
    this.handedOver = true;
    socket.onmessage = null;
    socket.onclose = null;
    this.socket = null;
    this.ctx.switchTo(new SetupScene(this.flow, socket));
  }

  /** 离开：断开即房间从玩家视角散去，清平台邀请上下文并收回浮层。 */
  private leave(): void {
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.length = 0;
    if (this.socket && !this.handedOver) {
      this.socket.onclose = null;
      this.socket.close();
    }
    this.socket = null;
    reportInviteContext(this.flow, null);
    this.close();
  }

  // ---------- 渲染 ----------

  private setStatus(text: string, color: number): void {
    this.status.text = text;
    this.status.style.fill = color;
  }

  private clearBody(): void {
    this.body.removeChildren().forEach((c) => c.destroy({ children: true }));
  }

  private renderConnecting(): void {
    this.clearBody();
    const label = makeLabel('连接服务器…', { size: 24, color: 0xffd54f });
    label.anchor.set(0.5);
    label.position.set(UI_W / 2, 300);
    this.body.addChild(label);
    const hint = makeLabel('Esc 收回', { size: 14, color: 0x7a86a0 });
    hint.anchor.set(0.5);
    hint.position.set(UI_W / 2, 350);
    this.body.addChild(hint);
  }

  /** 建连失败：红字 + 重试（Esc 收回）。 */
  private renderConnectError(text: string): void {
    this.clearBody();
    this.setStatus(text, 0xff5f5f);
    const retry = makeButton('重试', () => {
      this.setStatus('', 0xffd54f);
      this.startConnecting();
    }, { w: 140, h: 44 });
    retry.position.set(UI_W / 2 - 70, 320);
    this.body.addChild(retry);
    const hint = makeLabel('Esc 收回', { size: 14, color: 0x7a86a0 });
    hint.anchor.set(0.5);
    hint.position.set(UI_W / 2, 390);
    this.body.addChild(hint);
  }

  /** 房间态：room-info 快照驱动整体重建。 */
  private renderRoom(): void {
    this.clearBody();
    const state = this.snapshot;
    if (!state) {
      const waiting = makeLabel('等待房间快照…', { size: 20, color: 0xffd54f });
      waiting.anchor.set(0.5);
      waiting.position.set(UI_W / 2, 300);
      this.body.addChild(waiting);
      return;
    }

    const host = state.players.find((p) => p.player === 1);
    const guest = state.players.find((p) => p.player === 2);
    const isHost = this.flow.player === 1;
    const guestReady = guest?.ready === true;

    // 房码 6 格 + 复制
    const rowW = CODE_LEN * CELL_W + (CODE_LEN - 1) * CELL_GAP;
    const row = buildCodeRow(this.flow.room);
    row.position.set((UI_W - rowW) / 2, 132);
    this.body.addChild(row);
    const copyBtn = makeButton('复制', () => {
      void navigator.clipboard.writeText(this.flow.room).then(
        () => this.setStatus('房码已复制', 0x8fd0ff),
        () => this.setStatus('复制失败（浏览器未授权剪贴板）', 0xff5f5f),
      );
    }, { w: 76, h: 40, size: 16 });
    copyBtn.position.set((UI_W + rowW) / 2 + 16, 150);
    this.body.addChild(copyBtn);

    // 席位卡
    const card = (x: number, accent: number, head: string, lines: string[]) => {
      const c = new Container();
      const g = new Graphics();
      g.roundRect(0, 0, 300, 128, 10)
        .fill({ color: 0x0d1420, alpha: 0.85 })
        .stroke({ width: 2, color: accent });
      c.addChild(g);
      const h = makeLabel(head, { size: 18, color: accent, bold: true });
      h.position.set(20, 18);
      c.addChild(h);
      lines.forEach((ln, i) => {
        const t = makeLabel(ln, { size: 18, color: 0xd8dce6 });
        t.position.set(20, 58 + i * 30);
        c.addChild(t);
      });
      c.position.set(x, 248);
      return c;
    };
    this.body.addChild(card(180, 0xffd0a0, 'P1 · 房主（常备）', [host?.name ?? '—']));
    this.body.addChild(
      guest
        ? card(520, 0xa0d8ff, 'P2 · 客座', [guest.name, guestReady ? '已准备' : '等待中'])
        : card(520, 0xa0d8ff, 'P2 · 空位', ['等待玩家加入', '（房码 / 平台邀请）']),
    );

    // 模式：房主可改（点击上行 room-config，room-info 回声驱动翻转），客座只读
    const modeText = state.settings.team ? '团队 3+1' : '单挑 1v1';
    const modeLabel = makeLabel('模式', { size: 18, color: 0x7a86a0 });
    modeLabel.anchor.set(1, 0);
    modeLabel.position.set(UI_W / 2 - 110, 412);
    this.body.addChild(modeLabel);
    if (isHost && !this.linkClosed) {
      const modeBtn = makeButton(modeText, () => {
        sendRoomConfig(this.socket!, { team: !state.settings.team });
      }, { w: 200, h: 40, size: 16 });
      modeBtn.position.set(UI_W / 2 - 90, 404);
      this.body.addChild(modeBtn);
    } else {
      const modeValue = makeLabel(modeText, { size: 18, color: 0xd8dce6 });
      modeValue.position.set(UI_W / 2 - 90, 412);
      this.body.addChild(modeValue);
    }

    // 操作：房主开始（客座已准备才可点）/ 客座准备切换
    if (isHost) {
      const beginBtn = makeButton('开始对战', () => sendBegin(this.socket!), { w: 220, h: 52 });
      beginBtn.position.set(UI_W / 2 - 110, 458);
      beginBtn.disabled = !guest || !guestReady || this.linkClosed;
      this.body.addChild(beginBtn);
    } else {
      const readyBtn = makeButton(guestReady ? '取消准备' : '准备', () => {
        sendReady(this.socket!, !guestReady);
      }, { w: 220, h: 52, color: guestReady ? 0x4e3424 : 0x244e2e });
      readyBtn.position.set(UI_W / 2 - 110, 458);
      readyBtn.disabled = this.linkClosed;
      this.body.addChild(readyBtn);
    }

    const leaveBtn = makeButton('离开', () => this.leave(), { w: 120, h: 38 });
    leaveBtn.position.set(UI_W / 2 - 60, 526);
    this.body.addChild(leaveBtn);

    const hint = makeLabel('Esc 离开 · 回车 = 开始 / 准备', { size: 13, color: 0x5a6a85 });
    hint.anchor.set(0.5);
    hint.position.set(UI_W / 2, 578);
    this.body.addChild(hint);

    // 已开局但本端还停在房间页（理论上不发生：start 立即移交）；快照清掉过期提示
    if (guestReady && this.status.text === '对方还未准备') this.setStatus('', 0xffd54f);
  }
}

// ---------- 确认框浮层 ----------

/** 两键确认框（onConfirm = null 时为单键提示框）。 */
export class ConfirmOverlay extends NetOverlay {
  private readonly titleText: Text;
  private readonly bodyText: Text;
  private readonly confirmBtn: Button;
  private readonly cancelBtn: Button;
  private onConfirm: (() => void) | null = null;

  constructor() {
    super();

    const box = new Container();
    const bg = new Graphics();
    bg.roundRect(UI_W / 2 - 250, 210, 500, 170, 10)
      .fill({ color: 0x000000, alpha: 0.9 })
      .stroke({ width: 1, color: 0xfded65 });
    box.addChild(bg);
    this.titleText = makeLabel('', { size: 22, color: 0xffffff, bold: true });
    this.titleText.anchor.set(0.5, 0);
    this.titleText.position.set(UI_W / 2, 236);
    this.bodyText = makeLabel('', { size: 17, color: 0xd8dce6 });
    this.bodyText.anchor.set(0.5, 0);
    this.bodyText.position.set(UI_W / 2, 274);
    box.addChild(this.titleText, this.bodyText);
    this.content.addChild(box);

    this.confirmBtn = makeButton('确认', () => this.accept(), { w: 160, h: 44 });
    this.confirmBtn.position.set(UI_W / 2 - 190, 316);
    this.cancelBtn = makeButton('取消', () => this.close(), { w: 160, h: 44, color: 0x3a3040 });
    this.cancelBtn.position.set(UI_W / 2 + 30, 316);
    this.content.addChild(this.confirmBtn, this.cancelBtn);
  }

  /** 打开确认框；onConfirm = null → 单键提示（「确认」即关闭）。 */
  openConfirm(title: string, text: string, onConfirm: (() => void) | null, onClosed: () => void): void {
    this.onConfirm = onConfirm;
    const single = onConfirm === null;
    this.titleText.text = title;
    this.bodyText.text = text;
    this.confirmBtn.label = single ? '确定' : '确认';
    this.cancelBtn.visible = !single;
    super.open(onClosed);
  }

  handleKey(e: KeyboardEvent): void {
    const k = e.key;
    if (k === 'Escape' || k === 'Backspace') {
      e.preventDefault();
      this.close();
    } else if (k === 'Enter' || k === ' ' || k === 'j' || k === 'J') {
      e.preventDefault();
      this.accept();
    }
  }

  private accept(): void {
    const cb = this.onConfirm;
    this.close();
    cb?.();
  }
}
