/**
 * 联机连接页（切片 34）：服务器地址（localStorage 记忆）+ 创建/加入房间。
 * 入房成功 → 房间页（RoomScene）；pick 交换与对局沿用既有链路。
 * 方案 A 作废后回归游戏自有 room-server 路径（standalone 可玩，平台账号仅作昵称显示）。
 */
import { Container, Text } from 'pixi.js';
import { BufferedSocket, joinRoom, type WsLike } from '@bvn/net';
import type { Scene, SceneCtx } from './scene.js';
import { domInput, makeButton, makeLabel, makePanel, UI_H, UI_W } from '../ui.js';
import type { Flow } from '../flow.js';
import { RoomScene } from './room.js';
import { MenuScene } from './menu.js';

export class NetScene implements Scene {
  readonly name = 'net';

  private ui: Container | null = null;
  private status: Text | null = null;
  private serverText: Text | null = null;
  private socket: BufferedSocket | null = null;
  private ctx: SceneCtx | null = null;
  private closed = false;

  constructor(
    private readonly flow: Flow,
    /** dev 直通：enter 后自动以该参数入房（UI 入口不传） */
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

    const xlp = this.flow.xlp;
    const accountText = makeLabel(xlp?.user ? `账号：${xlp.user.username}` : '', {
      size: 15,
      color: 0x8fd0ff,
    });
    accountText.anchor.set(0.5);
    accountText.position.set(UI_W / 2, 170);
    ui.addChild(accountText);

    const serverText = makeLabel(`服务器：${this.flow.serverUrl}（点击修改）`, {
      size: 15,
      color: 0x8fd0ff,
    });
    serverText.anchor.set(0.5);
    serverText.position.set(UI_W / 2, 140);
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
    const { done } = domInput(this.ctx!.domHost, 'ws(s)://host:port', this.flow.serverUrl);
    const url = await done;
    if (!url) return;
    this.flow.serverUrl = url;
    localStorage.setItem('bvn.server', url);
    if (this.serverText) this.serverText.text = `服务器：${url}（点击修改）`;
  }

  private openSocket(): Promise<WebSocket> {
    return new Promise((res, rej) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.flow.serverUrl);
      } catch (e) {
        rej(e);
        return;
      }
      ws.onopen = () => {
        ws.onclose = null;
        ws.onerror = null;
        res(ws);
      };
      ws.onclose = () => rej(new Error('closed'));
      ws.onerror = () => rej(new Error('error'));
    });
  }

  private async connect(action: 'create' | 'join', roomOverride?: string): Promise<void> {
    const flow = this.flow;
    const status = this.status!;
    let room = roomOverride ?? '';
    if (action === 'join' && !room) {
      const { done } = domInput(this.ctx!.domHost, '4 位房间码', '');
      room = await done;
      if (!room) {
        status.text = '已取消';
        return;
      }
    }
    status.text = '连接服务器…';
    let ws: WebSocket;
    try {
      ws = await this.openSocket();
    } catch {
      status.text = '无法连接服务器（检查地址与服务器是否在线）';
      return;
    }
    if (this.closed) {
      ws.close();
      return;
    }
    const socket = new BufferedSocket(ws as unknown as WsLike);
    this.socket = socket;
    try {
      // 昵称取平台资料（duck typing）；standalone 回退"玩家N"（服务器侧清洗）
      const name = flow.xlp?.user?.username ?? '';
      const joined = await joinRoom(socket, action, room || undefined, undefined, name || undefined);
      flow.player = joined.player;
      flow.room = joined.room;
      flow.name = name || `玩家${joined.player}`;
    } catch (e) {
      status.text = `入房失败：${(e as Error).message}`;
      socket.close();
      this.socket = null;
      return;
    }
    if (this.closed) {
      socket.close();
      this.socket = null;
      return;
    }
    // socket 所有权移交房间页：清空本场景引用，switchTo 触发的 exit() 不得关闭它
    this.socket = null;
    status.text = '';
    this.ctx!.switchTo(new RoomScene(flow, socket));
  }

  exit(): void {
    this.closeSocket();
    this.ui?.destroy({ children: true });
    this.ui = null;
  }

  update(): void {}
}
