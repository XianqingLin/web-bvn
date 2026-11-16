/**
 * 联机房间场景（切片 14；联机迁移：走小林游戏铺平台）。
 * 创建/加入 6 位房间码房间（平台 rooms API）→ 入房成功 → 选人场景
 * （pick 交换与对局经平台中转的 RelaySocket，旧协议语义不变）。
 * 未在平台内运行（standalone）时提示需登录平台。
 */
import { Container, Text } from 'pixi.js';
import { openPlatformSession, type WsLike } from '@bvn/net';
import type { Scene, SceneCtx } from './scene.js';
import { domInput, makeButton, makeLabel, makePanel, UI_H, UI_W } from '../ui.js';
import type { Flow } from '../flow.js';
import { SetupScene } from './setup.js';
import { MenuScene } from './menu.js';

export class NetScene implements Scene {
  readonly name = 'net';

  private ui: Container | null = null;
  private status: Text | null = null;
  private accountText: Text | null = null;
  private socket: WsLike | null = null;
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
    const accountText = makeLabel(
      xlp?.user ? `账号：${xlp.user.username}` : '未登录 —— 联机需要在小林游戏铺平台内运行',
      { size: 15, color: xlp?.user ? 0x8fd0ff : 0xffb0b0 },
    );
    accountText.anchor.set(0.5);
    accountText.position.set(UI_W / 2, 170);
    this.accountText = accountText;
    ui.addChild(accountText);

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

  private async connect(action: 'create' | 'join', roomOverride?: string): Promise<void> {
    const flow = this.flow;
    const status = this.status!;
    if (!flow.xlp || flow.xlp.standalone || !flow.xlp.user) {
      status.text = '联机需要在小林游戏铺平台内运行并登录';
      return;
    }
    let roomCode = roomOverride ?? '';
    if (action === 'join' && !roomCode) {
      const { done } = domInput(this.ctx!.domHost, '6 位房间码', '');
      roomCode = await done;
      if (!roomCode) {
        status.text = '已取消';
        return;
      }
    }
    status.text = action === 'create' ? '创建房间…' : '加入房间…';
    try {
      const session = await openPlatformSession(flow.xlp, {
        action,
        roomCode: roomCode || undefined,
      });
      flow.player = session.player;
      flow.room = session.room;
      status.text = `房间 ${session.room} —— 你是 P${session.player}，进入选人…`;
      if (this.closed) {
        session.socket.close();
        return;
      }
      // socket 所有权移交选人/对局阶段：清空本场景引用，switchTo 触发的
      // exit()/closeSocket() 不得关闭它（否则 host 刚建房就 leave 解散房间）。
      this.socket = null;
      this.ctx!.switchTo(new SetupScene(flow, session.socket));
    } catch (e) {
      status.text = `入房失败：${(e as Error).message}`;
    }
  }

  exit(): void {
    this.closeSocket();
    this.ui?.destroy({ children: true });
    this.ui = null;
  }

  update(): void {}
}
