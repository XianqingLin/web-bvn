/**
 * 房间页（切片 34）：入房后的等待/设置/开始门。
 *
 * 房主：常备（无准备按钮）+ 开始按钮（客座已准备才可点）+ 三项设置
 * （公开/随机地图/团队，客座只读实时跟随）；客座：准备/取消准备切换按钮。
 * 状态机：socket.onmessage 常驻接管，room-info 快照驱动渲染（服务器权威，
 * 本端只上行 room-config/ready，不本地乐观翻转）；start → 移交选人页。
 * 异常流按 netplay-design §10：客座掉线房主继续等待；房主掉线客座回菜单。
 * 邀请好友为占位（切片 38 平台接缝）。
 */
import { Container, Text } from 'pixi.js';
import {
  sendBegin,
  sendReady,
  sendRoomConfig,
  type RoomMemberInfo,
  type RoomSettings,
  type WsLike,
} from '@bvn/net';
import type { Scene, SceneCtx } from './scene.js';
import { makeButton, makeLabel, makePanel, UI_H, UI_W, type Button } from '../ui.js';
import type { Flow } from '../flow.js';
import { SetupScene } from './setup.js';
import { MenuScene } from './menu.js';

interface RoomState {
  started: boolean;
  settings: RoomSettings;
  players: RoomMemberInfo[];
}

export class RoomScene implements Scene {
  readonly name = 'room';

  private ui: Container | null = null;
  private status: Text | null = null;
  private body: Container | null = null;
  private state: RoomState | null = null;
  private ctx: SceneCtx | null = null;
  private socket: WsLike | null;
  /** 已移交选人页（exit 不得关闭 socket） */
  private handedOver = false;
  /** 底层连接已断（禁用操作，仅展示状态） */
  private linkClosed = false;
  private readonly timers: number[] = [];

  constructor(
    private readonly flow: Flow,
    socket: WsLike,
  ) {
    this.socket = socket;
  }

  enter(ctx: SceneCtx): void {
    this.ctx = ctx;
    const ui = new Container();
    this.ui = ui;
    ctx.root.addChild(ui);

    ui.addChild(makePanel(UI_W, UI_H, { color: 0x0a0e1a, alpha: 1 }));

    const title = makeLabel('房间对战', { size: 36, bold: true });
    title.anchor.set(0.5);
    title.position.set(UI_W / 2, 80);
    ui.addChild(title);

    const codeLabel = makeLabel('房间码', { size: 14, color: 0x7a86a0 });
    codeLabel.anchor.set(0.5);
    codeLabel.position.set(UI_W / 2, 128);
    ui.addChild(codeLabel);

    const code = makeLabel(this.flow.room, { size: 44, bold: true, color: 0x8fd0ff });
    code.anchor.set(0.5);
    code.position.set(UI_W / 2, 170);
    ui.addChild(code);

    const status = makeLabel('', { size: 16, color: 0xffd54f });
    status.anchor.set(0.5);
    status.position.set(UI_W / 2, 222);
    this.status = status;
    ui.addChild(status);

    // 动态区（成员/设置/操作按钮）：room-info 快照驱动整体重建
    this.body = new Container();
    ui.addChild(this.body);

    const backBtn = makeButton('返回', () => this.leave(), { w: 120 });
    backBtn.position.set(80, 520);
    ui.addChild(backBtn);

    const socket = this.socket;
    if (!socket) return;
    socket.onmessage = (ev) => this.onMessage(ev);
    socket.onclose = () => this.onLinkClosed();
  }

  exit(): void {
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.length = 0;
    if (this.socket && !this.handedOver) {
      this.socket.onclose = null;
      // 旧语义：断开即离开（房主离开 → 房间解散；未开局客座离开 → 房间保留）
      this.socket.close();
    }
    this.socket = null;
    this.ui?.destroy({ children: true });
    this.ui = null;
  }

  update(): void {}

  // ---------- 消息泵 ----------

  private onMessage(ev: { data: unknown }): void {
    let msg: { t?: string; [k: string]: unknown };
    try {
      const text = typeof ev.data === 'string' ? ev.data : (ev.data as { toString(): string }).toString();
      msg = JSON.parse(text);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'room-info':
        this.state = {
          started: msg.started === true,
          settings: msg.settings as RoomSettings,
          players: msg.players as RoomMemberInfo[],
        };
        // 团队模式随快照同步（选人页 3+1 节奏依据；切片 35）
        this.flow.team = (msg.settings as RoomSettings).team === true;
        this.render();
        break;
      case 'error':
        if (msg.code === 'guest-not-ready') this.flash('对方还未准备');
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
      this.flash('对方已离开，等待新玩家加入…');
      return;
    }
    // 房主掉线即解散：提示后回主菜单
    this.flash('房主已离开，房间解散');
    this.timers.push(
      window.setTimeout(() => {
        if (this.ctx) this.ctx.switchTo(new MenuScene(this.flow));
      }, 1200),
    );
  }

  private onLinkClosed(): void {
    if (this.handedOver) return;
    this.linkClosed = true;
    this.flash('与服务器断开连接');
    this.render();
  }

  /** start 广播 → 移交 socket 给选人页（阶段推进由服务器裁决）。 */
  private enterSetup(): void {
    const socket = this.socket;
    if (!socket) return;
    this.handedOver = true;
    socket.onmessage = null;
    socket.onclose = null;
    this.socket = null;
    this.ctx!.switchTo(new SetupScene(this.flow, socket));
  }

  private leave(): void {
    this.ctx!.switchTo(new MenuScene(this.flow));
  }

  private flash(text: string): void {
    if (this.status) this.status.text = text;
  }

  // ---------- 渲染（room-info 快照重建动态区） ----------

  private render(): void {
    const body = this.body;
    const state = this.state;
    if (!body || !state) return;
    body.removeChildren().forEach((c) => c.destroy({ children: true }));

    const host = state.players.find((p) => p.player === 1);
    const guest = state.players.find((p) => p.player === 2);
    const isHost = this.flow.player === 1;
    const guestReady = guest?.ready === true;

    // 成员行
    const rows: string[] = [
      `P1  ${host?.name ?? '—'}   房主·常备`,
      guest
        ? `P2  ${guest.name}   ${guestReady ? '已准备' : '等待中'}`
        : 'P2  空位 —— 等待玩家加入（房码 / 邀请）',
    ];
    rows.forEach((text, i) => {
      const row = makeLabel(text, { size: 18, color: i === 0 ? 0xffd0a0 : 0xa0d8ff });
      row.anchor.set(0.5);
      row.position.set(UI_W / 2, 272 + i * 38);
      body.addChild(row);
    });

    // 设置区：房主可改（点击上行 room-config，room-info 回声驱动翻转），客座只读
    const settings: { label: string; value: string; key: keyof RoomSettings }[] = [
      { label: '公开房间', value: state.settings.public ? '公开' : '私人', key: 'public' },
      { label: '地图', value: state.settings.randomMap ? '随机抽取' : '房主选择', key: 'randomMap' },
      { label: '模式', value: state.settings.team ? '团队 3+1' : '单挑 1v1', key: 'team' },
    ];
    settings.forEach((s, i) => {
      const label = makeLabel(s.label, { size: 18, color: 0x7a86a0 });
      label.position.set(330, 362 + i * 44);
      body.addChild(label);
      if (isHost && !this.linkClosed) {
        const btn = makeButton(s.value, () => {
          sendRoomConfig(this.socket!, { [s.key]: !state.settings[s.key] });
        }, { w: 150, h: 34, size: 16 });
        btn.position.set(480, 356 + i * 44);
        body.addChild(btn);
      } else {
        const value = makeLabel(s.value, { size: 18, color: 0xd8dce6 });
        value.position.set(480, 362 + i * 44);
        body.addChild(value);
      }
    });

    // 操作按钮
    const inviteBtn = makeButton('邀请好友', () => this.flash('邀请功能待平台接入（切片 38）'), { w: 160 });
    inviteBtn.position.set(330, 516);
    inviteBtn.disabled = this.linkClosed;
    body.addChild(inviteBtn);

    if (isHost) {
      const beginBtn = makeButton('开始对战', () => sendBegin(this.socket!), { w: 200 });
      beginBtn.position.set(560, 516);
      beginBtn.disabled = !guest || !guestReady || this.linkClosed;
      body.addChild(beginBtn);
    } else {
      const readyBtn = makeButton(guestReady ? '取消准备' : '准备', () => {
        sendReady(this.socket!, !guestReady);
      }, { w: 200, color: guestReady ? 0x4e3424 : 0x244e2e });
      readyBtn.position.set(560, 516);
      readyBtn.disabled = this.linkClosed;
      body.addChild(readyBtn);
    }

    // 已开局但本端还停在房间页（理论上不发生：start 立即移交）；快照清掉过期提示
    if (guestReady && this.status?.text === '对方还未准备') this.flash('');
  }
}
