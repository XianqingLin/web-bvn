/**
 * 菜单内联机浮层（DESIGN §6.4）：房间在主菜单浮层内完成——半透明暗底挡住
 * 下层指针事件（背景菜单动画不断），只有真正开局才切场景。「加入房间」
 * 「随机匹配」不走浮层——子项按钮原位翻转变身（见 menu.ts / quick-match.ts），
 * 错误提示走本模块的确认框弹窗。
 *
 * NetOverlay = 浮层基座：open 期间以全屏暗底挡住下层指针事件，键盘由
 * MenuScene 路转入 handleKey（菜单导航停摆），close 回调恢复菜单。
 */
import { Container, Graphics, Text } from 'pixi.js';
import {
  sendBegin,
  sendReady,
  sendRoomConfig,
  type RoomMemberInfo,
  type RoomSettings,
  type WsLike,
} from '@bvn/net';
import type { SceneCtx } from './scene.js';
import { makeButton, makeLabel, makePanel, UI_H, UI_W, type Button } from '../ui.js';
import type { Flow } from '../flow.js';
import { enterRoom, roomErrorText } from './net-common.js';
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

/** 两键确认框（onConfirm = null 时为单键提示框）；面板样式与游戏内弹窗同款。 */
export class ConfirmOverlay extends NetOverlay {
  private readonly titleText: Text;
  private readonly bodyText: Text;
  private readonly confirmBtn: Button;
  private readonly cancelBtn: Button;
  private onConfirm: (() => void) | null = null;

  constructor() {
    super();

    // 游戏内弹窗同款面板（makePanel 深底描边），标题黄字 + 正文居中
    const panel = makePanel(400, 170);
    panel.position.set(UI_W / 2 - 200, UI_H / 2 - 110);
    this.content.addChild(panel);
    this.titleText = makeLabel('', { size: 18, bold: true, color: 0xffd54f });
    this.titleText.anchor.set(0.5, 0);
    this.titleText.position.set(UI_W / 2, UI_H / 2 - 88);
    this.bodyText = makeLabel('', { size: 16 });
    this.bodyText.anchor.set(0.5, 0);
    this.bodyText.position.set(UI_W / 2, UI_H / 2 - 52);
    this.content.addChild(this.titleText, this.bodyText);

    this.confirmBtn = makeButton('确认', () => this.accept(), { w: 110, h: 36, size: 15 });
    this.cancelBtn = makeButton('取消', () => this.close(), { w: 110, h: 36, size: 15, color: 0x3a3040 });
    this.content.addChild(this.confirmBtn, this.cancelBtn);
  }

  /** 打开确认框；onConfirm = null → 单键提示（按钮居中）。 */
  openConfirm(title: string, text: string, onConfirm: (() => void) | null, onClosed: () => void): void {
    this.onConfirm = onConfirm;
    const single = onConfirm === null;
    this.titleText.text = title;
    this.bodyText.text = text;
    this.confirmBtn.setLabel(single ? '确定' : '确认');
    // 单键 = 居中；双键 = 左右分列（与选人页确认框同布局）
    this.confirmBtn.position.set(single ? UI_W / 2 - 55 : UI_W / 2 - 125, UI_H / 2 + 15);
    this.cancelBtn.visible = !single;
    this.cancelBtn.position.set(UI_W / 2 + 15, UI_H / 2 + 15);
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
