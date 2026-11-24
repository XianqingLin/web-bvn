/**
 * 联机连接页（旧入口，待联机浮层收编）：服务器地址（localStorage 记忆）+
 * 创建/加入房间（6 位数字房码）；入房成功 → 房间页（RoomScene）。
 * 房间一律私人，加入只凭房码；平台邀请深链携带房码落进同一入口。
 */
import { Container, Text } from 'pixi.js';
import type { Scene, SceneCtx } from './scene.js';
import { domInput, makeButton, makeLabel, makePanel, UI_H, UI_W } from '../ui.js';
import type { Flow } from '../flow.js';
import { RoomScene } from './room.js';
import { MenuScene } from './menu.js';
import { enterRoom, makeServerLabel, roomErrorText } from './net-common.js';
import { reportInviteContext } from '../invite-context.js';


export class NetScene implements Scene {
  readonly name = 'net';

  private ui: Container | null = null;
  private status: Text | null = null;
  private ctx: SceneCtx | null = null;
  /** 置位后不再入房（返回/exit 竞态守卫；在途连接由完成回调按此收尾） */
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

    const dock = this.flow.dock;
    const accountText = makeLabel(dock?.user ? `账号：${dock.user.username}` : '', {
      size: 15,
      color: 0x8fd0ff,
    });
    accountText.anchor.set(0.5);
    accountText.position.set(UI_W / 2, 170);
    ui.addChild(accountText);

    ui.addChild(makeServerLabel(this.flow, ctx.domHost)).position.set(UI_W / 2, 140);

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
    this.closed = true;
    this.ctx!.switchTo(new MenuScene(this.flow));
  }

  private async connect(action: 'create' | 'join', roomOverride?: string): Promise<void> {
    const status = this.status!;
    let room = roomOverride ?? '';
    if (action === 'join' && !room) {
      const { done } = domInput(this.ctx!.domHost, '6 位数字房码', '');
      room = await done;
      if (!room) {
        status.text = '已取消';
        return;
      }
    }
    status.text = '连接服务器…';
    try {
      const { socket } = await enterRoom(this.flow, action, room || undefined);
      // 等待期间本场景已关闭：不入房，收掉连接
      if (this.closed) {
        socket.close();
        return;
      }
      // socket 所有权移交房间页
      status.text = '';
      // 上报平台邀请上下文（platform-seam §4）：房间码 + 当前节点，平台原样随邀请透传
      reportInviteContext(this.flow, { room: this.flow.room, node: this.flow.nodeInfo?.nodeId ?? '' });
      this.ctx!.switchTo(new RoomScene(this.flow, socket));
    } catch (e) {
      if (this.closed) return;
      status.text = roomErrorText(e);
    }
  }


  exit(): void {
    this.closed = true;
    this.ui?.destroy({ children: true });
    this.ui = null;
  }

  update(): void {}
}
