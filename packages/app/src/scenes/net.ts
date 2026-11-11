/**
 * 联机房间场景（切片 14）：服务器地址（localStorage 记忆）+ 创建/加入房间。
 * 入房成功 → 选人场景（pick 交换在选人确认时进行）。
 */
import { Container, Text } from 'pixi.js';
import { joinRoom, type WsLike } from '@bvn/net';
import type { Scene, SceneCtx } from './scene.js';
import { domInput, makeButton, makeLabel, makePanel, UI_H, UI_W } from '../ui.js';
import type { Flow } from '../flow.js';
import { SetupScene } from './setup.js';
import { MenuScene } from './menu.js';

export class NetScene implements Scene {
  readonly name = 'net';

  private ui: Container | null = null;
  private status: Text | null = null;
  private serverText: Text | null = null;
  private socket: WebSocket | null = null;
  private ctx: SceneCtx | null = null;
  private closed = false;

  constructor(
    private readonly flow: Flow,
    /** dev 直通：enter 后自动以该参数连接（UI 入口不传） */
    private readonly auto: { action: 'create' | 'join'; room?: string | undefined } | null = null,
  ) {}

  enter(ctx: SceneCtx): void {
    this.ctx = ctx;
    const ui = new Container();
    this.ui = ui;
    ctx.root.addChild(ui);

    ui.addChild(makePanel(UI_W, UI_H, { color: 0x0a0e1a, alpha: 1 }));

    const title = makeLabel('联机对战', { size: 36, bold: true });
    title.anchor.set(0.5);
    title.position.set(UI_W / 2, 100);
    ui.addChild(title);

    const serverText = makeLabel(`服务器：${this.flow.serverUrl}（点击修改）`, {
      size: 15,
      color: 0x8fd0ff,
    });
    serverText.anchor.set(0.5);
    serverText.position.set(UI_W / 2, 170);
    serverText.eventMode = 'static';
    serverText.cursor = 'pointer';
    serverText.on('pointertap', () => void this.editServer());
    this.serverText = serverText;
    ui.addChild(serverText);

    const createBtn = makeButton('创建房间', () => void this.connect('create'));
    createBtn.position.set(UI_W / 2 - 210, 240);
    const joinBtn = makeButton('加入房间', () => void this.connect('join'));
    joinBtn.position.set(UI_W / 2 + 30, 240);
    ui.addChild(createBtn, joinBtn);

    const status = makeLabel('', { size: 16, color: 0xffd54f });
    status.anchor.set(0.5);
    status.position.set(UI_W / 2, 340);
    this.status = status;
    ui.addChild(status);

    const backBtn = makeButton('返回', () => this.back(), { w: 120 });
    backBtn.position.set(UI_W / 2 - 60, 520);
    ui.addChild(backBtn);

    if (this.auto) void this.connect(this.auto.action, this.auto.room);
  }

  private back(): void {
    this.closeSocket();
    this.ctx!.switchTo(new MenuScene(this.flow));
  }

  private closeSocket(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
  }

  private async editServer(): Promise<void> {
    const { domHost } = this.ctx!;
    const { done } = domInput(domHost, 'ws(s)://host:port', this.flow.serverUrl);
    const url = await done;
    if (!url) return;
    this.flow.serverUrl = url;
    localStorage.setItem('bvn.server', url);
    if (this.serverText) this.serverText.text = `服务器：${url}（点击修改）`;
  }

  private async connect(action: 'create' | 'join', roomOverride?: string): Promise<void> {
    const flow = this.flow;
    const status = this.status!;
    status.text = '连接服务器…';
    const socket = new WebSocket(flow.serverUrl);
    this.socket = socket;
    try {
      await new Promise<void>((res, rej) => {
        socket.addEventListener('open', () => res(), { once: true });
        socket.addEventListener('error', () => rej(new Error('无法连接房间服务器')), { once: true });
      });
    } catch (e) {
      status.text = (e as Error).message;
      return;
    }
    let roomCode = roomOverride ?? '';
    if (action === 'join' && !roomCode) {
      const { done } = domInput(this.ctx!.domHost, '4 位房间码', '');
      roomCode = await done;
      if (!roomCode) {
        status.text = '已取消';
        socket.close();
        return;
      }
    }
    try {
      const welcome = await joinRoom(socket as unknown as WsLike, action, roomCode || undefined);
      flow.player = welcome.player;
      flow.room = welcome.room;
      status.text = `房间 ${welcome.room} —— 你是 P${welcome.player}，进入选人…`;
    } catch (e) {
      status.text = `入房失败：${(e as Error).message}`;
      socket.close();
      return;
    }
    if (this.closed) return;
    // socket 交由选人/对局阶段接管
    this.ctx!.switchTo(new SetupScene(flow, socket as unknown as WsLike));
  }

  exit(): void {
    this.closeSocket();
    this.ui?.destroy({ children: true });
    this.ui = null;
  }

  update(): void {}
}
