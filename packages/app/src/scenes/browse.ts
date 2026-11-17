/**
 * 浏览房间页（切片 37，规格 docs/netplay-design.md §5）。
 *
 * 列表内容：公开房间——房主昵称、团队模式标记、可加入/已满/已开局状态；
 * 点击可加入行 → join 入房（客座位）→ 房间页。满员/已开局/房主刚解散时
 * 行不可点，仍给出明确错误提示（room-full / room-not-found 既有错误码复用）。
 * 刷新：进入页面拉取 + 定时轮询（服务器不做主动推送，量级不需要）。
 * 不做房间名/密码——私人房的隐私靠"不出现在列表"达成（房码加入走菜单入口）。
 */
import { Container, Text } from 'pixi.js';
import {
  BufferedSocket,
  joinRoom,
  sendListRooms,
  type RoomListEntry,
  type WsLike,
} from '@bvn/net';
import type { Scene, SceneCtx } from './scene.js';
import { makeButton, makeLabel, makePanel, UI_H, UI_W } from '../ui.js';
import type { Flow } from '../flow.js';
import { RoomScene } from './room.js';
import { MenuScene } from './menu.js';
import { displayName, makeServerLabel, openServerSocket } from './net-common.js';

/** 轮询间隔（设计 §5：进入页面拉取 + 定时轮询）。 */
const POLL_MS = 2500;

export class BrowseScene implements Scene {
  readonly name = 'browse';

  private ui: Container | null = null;
  private listBody: Container | null = null;
  private status: Text | null = null;
  private ctx: SceneCtx | null = null;
  private socket: BufferedSocket | null = null;
  private rooms: RoomListEntry[] = [];
  /** 已发起 join（停轮询，等 welcome/error）；成功后移交房间页 */
  private joining = false;
  /** 已移交房间页（exit 不得关 socket） */
  private handedOver = false;
  private destroyed = false;
  private readonly timers: number[] = [];

  constructor(private readonly flow: Flow) {}

  enter(ctx: SceneCtx): void {
    this.ctx = ctx;
    const ui = new Container();
    this.ui = ui;
    ctx.root.addChild(ui);

    ui.addChild(makePanel(UI_W, UI_H, { color: 0x0a0e1a, alpha: 1 }));

    const title = makeLabel('浏览房间', { size: 36, bold: true });
    title.anchor.set(0.5);
    title.position.set(UI_W / 2, 100);
    ui.addChild(title);

    const accountText = makeLabel(this.flow.xlp?.user ? `账号：${this.flow.xlp.user.username}` : '', {
      size: 15,
      color: 0x8fd0ff,
    });
    accountText.anchor.set(0.5);
    accountText.position.set(UI_W / 2, 170);
    ui.addChild(accountText);

    ui.addChild(makeServerLabel(this.flow, ctx.domHost)).position.set(UI_W / 2, 140);

    const status = makeLabel('', { size: 16, color: 0xffd54f });
    status.anchor.set(0.5);
    status.position.set(UI_W / 2, 470);
    this.status = status;
    ui.addChild(status);

    const refreshBtn = makeButton('刷新', () => this.poll());
    refreshBtn.position.set(UI_W / 2 - 210, 520);
    ui.addChild(refreshBtn);

    const backBtn = makeButton('返回', () => this.ctx!.switchTo(new MenuScene(this.flow)), { w: 120 });
    backBtn.position.set(UI_W / 2 + 90, 520);
    ui.addChild(backBtn);

    this.listBody = new Container();
    ui.addChild(this.listBody);
    this.renderList();

    void this.openAndPoll();
  }

  exit(): void {
    this.destroyed = true;
    for (const id of this.timers) window.clearInterval(id);
    this.timers.length = 0;
    if (this.socket && !this.handedOver) {
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.close();
    }
    this.socket = null;
    this.ui?.destroy({ children: true });
    this.ui = null;
  }

  update(): void {}

  // ---------- 连接与轮询 ----------

  private async openAndPoll(): Promise<void> {
    let ws: WebSocket;
    try {
      ws = await openServerSocket(this.flow.serverUrl);
    } catch {
      if (this.status) this.status.text = '无法连接服务器（检查地址与服务器是否在线）';
      return;
    }
    if (this.destroyed) {
      ws.close();
      return;
    }
    const socket = new BufferedSocket(ws as unknown as WsLike);
    this.socket = socket;
    socket.onmessage = (ev) => this.onMessage(ev);
    socket.onclose = () => {
      if (this.handedOver) return;
      if (this.status) this.status.text = '与服务器断开连接';
      this.rooms = [];
      this.renderList();
    };
    this.poll();
    this.timers.push(window.setInterval(() => this.poll(), POLL_MS));
  }

  private poll(): void {
    if (!this.socket || this.joining || this.handedOver) return;
    sendListRooms(this.socket);
  }

  // ---------- 消息泵 ----------

  private onMessage(ev: { data: unknown }): void {
    let msg: { t?: string; [k: string]: unknown };
    try {
      const text = typeof ev.data === 'string' ? ev.data : (ev.data as { toString(): string }).toString();
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.t === 'room-list') {
      this.rooms = (msg.rooms as RoomListEntry[]) ?? [];
      this.renderList();
    }
  }

  // ---------- 加入 ----------

  /** 点击房间行 → join。失败提示后恢复轮询（socket 仍可用）。 */
  private async joinRoom(entry: RoomListEntry): Promise<void> {
    const socket = this.socket;
    if (!socket || this.joining || this.handedOver) return;
    this.joining = true;
    if (this.status) this.status.text = '加入中…';
    try {
      const name = displayName(this.flow);
      const joined = await joinRoom(socket, 'join', entry.room, undefined, name || undefined);
      this.flow.mode = 'net';
      this.flow.player = joined.player;
      this.flow.room = joined.room;
      this.flow.name = name || `玩家${joined.player}`;
      // socket 所有权移交房间页：清引用，switchTo 触发的 exit() 不得关闭它
      this.handedOver = true;
      this.socket = null;
      if (this.status) this.status.text = '';
      this.ctx!.switchTo(new RoomScene(this.flow, socket));
      return;
    } catch (e) {
      // 满员/已开局/房主刚解散：明确错误提示（设计 §5），socket 仍可用
      if (this.status) this.status.text = `加入失败：${(e as Error).message}`;
    } finally {
      this.joining = false;
    }
    // joinRoom 失败会清 socket.onmessage（joinRoom 内部），恢复本页泵
    if (this.socket) this.socket.onmessage = (ev) => this.onMessage(ev);
    this.poll();
  }

  // ---------- 渲染 ----------

  private renderList(): void {
    const body = this.listBody;
    if (!body) return;
    body.removeChildren().forEach((c) => c.destroy({ children: true }));

    if (this.rooms.length === 0) {
      const empty = makeLabel(this.socket ? '暂无公开房间' : '未连接服务器', {
        size: 18,
        color: 0x7a86a0,
      });
      empty.anchor.set(0.5);
      empty.position.set(UI_W / 2, 320);
      body.addChild(empty);
      return;
    }

    // 表头
    const head = makeLabel('房主        模式        状态', { size: 14, color: 0x7a86a0 });
    head.position.set(300, 210);
    body.addChild(head);

    this.rooms.slice(0, 6).forEach((entry, i) => {
      const row = new Container();
      row.position.set(300, 238 + i * 34);
      const stateText = entry.joinable ? '可加入' : entry.started ? '已开局' : '已满';
      const label = makeLabel(
        `${entry.host}　　${entry.team ? '团队 3+1' : '单挑 1v1'}　　${stateText}`,
        { size: 18, color: entry.joinable ? 0xa0d8ff : 0x5a6478 },
      );
      row.addChild(label);
      if (entry.joinable) {
        row.eventMode = 'static';
        row.cursor = 'pointer';
        row.on('pointerover', () => {
          label.style.fill = 0xffffff;
          label.style.fontWeight = '700';
        });
        row.on('pointerout', () => {
          label.style.fill = 0xa0d8ff;
          label.style.fontWeight = '400';
        });
        row.on('pointertap', () => void this.joinRoom(entry));
      }
      body.addChild(row);
    });
    if (this.rooms.length > 6) {
      const more = makeLabel(`…共 ${this.rooms.length} 间`, { size: 14, color: 0x7a86a0 });
      more.position.set(300, 238 + 6 * 34);
      body.addChild(more);
    }
  }
}
