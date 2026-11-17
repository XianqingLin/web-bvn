/**
 * 随机匹配页（切片 37，规格 docs/netplay-design.md §6）。
 *
 * 交互定案：点击"随机匹配"→ 按钮文字变"匹配中"，红色 ✕ 从按钮右侧滑出
 * （一次点击、零二级交互）；✕ 随时可点 = 退队回待机态。
 * 匹配成功 → VS 横幅：屏幕中央左右双方 + 昵称，中间"VS"，配"已找到对手"文案。
 * 展示下限 2.5s，上限以建连就绪为准——服务器在配对时已开好房间并广播 start
 * （免房间页/准备门），start 到达且横幅满 2.5s 即切入选人页。
 * 建连失败（断线/对端掉线）→ "连接失败，正在重新匹配"，自动回匹配中继续排队。
 *
 * 匹配固定属性（不提供选项）：团队模式开启 + 强制随机地图（服务器侧强制）。
 * 偏离登记：VS 横幅"头像"暂以位次色块占位（P1 蓝/P2 粉，同选人页 SIDE_COLORS
 * 色族）——平台头像资料接入归切片 38；横幅构建函数导出复用（对局前 VS 预告）。
 */
import { Container, Graphics, Text } from 'pixi.js';
import {
  BufferedSocket,
  sendQueue,
  sendUnqueue,
  type WsLike,
} from '@bvn/net';
import type { Scene, SceneCtx } from './scene.js';
import { tweenOf, tickTweens } from '../anim.js';
import { makeButton, makeLabel, makePanel, UI_H, UI_W, type Button } from '../ui.js';
import type { Flow } from '../flow.js';
import { SetupScene } from './setup.js';
import { MenuScene } from './menu.js';
import { displayName, makeServerLabel, openServerSocket } from './net-common.js';

/** 横幅展示下限（netplay-design §6：约 2.5s；上限以建连就绪为准）。 */
const BANNER_MIN_MS = 2500;
/** 建连失败自动重排的间隔。 */
const RETRY_DELAY_MS = 1200;

/** P1/P2 位次色（与选人页双色框同族：P1 蓝 / P2 粉）。 */
const SIDE_COLORS: Record<1 | 2, number> = { 1: 0x2f9bff, 2: 0xff5fa2 };

/**
 * VS 横幅（导出复用：匹配成功画面与将来的对局前预告共用）。
 * 左右色块 + 昵称 + 中央 VS + 顶部文案；返回容器（调用方自行挂载/销毁）。
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

export class MatchScene implements Scene {
  readonly name = 'match';

  private ui: Container | null = null;
  /** 动态层：待机按钮组 / 横幅按状态重建 */
  private body: Container | null = null;
  private status: Text | null = null;
  private ctx: SceneCtx | null = null;
  private socket: WsLike | null = null;
  private linkClosed = false;
  /** 重试定时器在途（error+close 连锁只排一次） */
  private retrying = false;
  /** false = 待机；true = 匹配中/横幅中 */
  private matching = false;
  /** 横幅期状态（matched 已到） */
  private banner: { left: string; right: string } | null = null;
  private bannerMs = 0;
  /** start 已到（建连就绪），只等横幅下限 */
  private startReady = false;
  /** 已移交选人页（exit 不得关 socket、消息泵停止） */
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

    const title = makeLabel('随机匹配', { size: 36, bold: true });
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

    ui.addChild(makeServerLabel(this.flow, ctx.domHost)).position.set(UI_W / 2, 140);

    const status = makeLabel('', { size: 16, color: 0xffd54f });
    status.anchor.set(0.5);
    status.position.set(UI_W / 2, 480);
    this.status = status;
    ui.addChild(status);

    const backBtn = makeButton('返回', () => this.back(), { w: 120 });
    backBtn.position.set(UI_W / 2 - 60, 530);
    ui.addChild(backBtn);

    this.body = new Container();
    ui.addChild(this.body);
    this.renderIdle();
  }

  exit(): void {
    this.destroyed = true;
    for (const id of this.timers) window.clearTimeout(id);
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

  update(dtMs: number): void {
    tickTweens(dtMs);
    if (this.banner && !this.handedOver) {
      this.bannerMs += dtMs;
      // 横幅下限已满且建连就绪（start 已到）→ 切选人页
      if (this.startReady && this.bannerMs >= BANNER_MIN_MS) this.enterSetup();
    }
  }

  // ---------- 状态渲染 ----------

  private renderIdle(): void {
    const body = this.body;
    if (!body) return;
    body.removeChildren().forEach((c) => c.destroy({ children: true }));
    const btn = makeButton('随机匹配', () => void this.startMatching(), { w: 220, h: 56 });
    btn.position.set(UI_W / 2 - 110, 300);
    body.addChild(btn);
  }

  /** 匹配中：按钮文字变"匹配中"（禁点），红 ✕ 从右侧滑出（紧挨，一次点击取消）。 */
  private renderMatching(): void {
    const body = this.body;
    if (!body) return;
    body.removeChildren().forEach((c) => c.destroy({ children: true }));
    const btn = makeButton('匹配中', () => {}, { w: 220, h: 56, color: 0x24344e });
    btn.disabled = true;
    btn.position.set(UI_W / 2 - 110, 300);
    body.addChild(btn);
    const cancel = makeButton('✕', () => this.cancel(), { w: 44, h: 44, size: 20, color: 0x5e2222 });
    cancel.position.set(UI_W / 2 + 124, 306);
    cancel.scale.set(0.2, 1);
    body.addChild(cancel);
    // 滑出感：入场快速展开（Design §6 定案"滑出"的近似）
    tweenOf(cancel, { 'scale.x': 1 }, 160, { ease: (k) => k });
  }

  /** 横幅期：VS 画面 + 底部 ✕（横幅期也可取消）。 */
  private renderBanner(): void {
    const body = this.body;
    if (!body || !this.banner) return;
    body.removeChildren().forEach((c) => c.destroy({ children: true }));
    body.addChild(buildVsBanner(this.banner.left, this.banner.right));
    const cancel = makeButton('✕', () => this.cancel(), { w: 44, h: 44, size: 20, color: 0x5e2222 });
    cancel.position.set(UI_W / 2 - 22, 440);
    body.addChild(cancel);
  }

  // ---------- 流程 ----------

  /** 待机 → 匹配中：建连 + 入队。 */
  private async startMatching(): Promise<void> {
    if (this.matching || this.handedOver) return;
    this.matching = true;
    this.retrying = false;
    this.banner = null;
    this.startReady = false;
    this.bannerMs = 0;
    this.renderMatching();
    if (this.status) this.status.text = '';
    if (!(await this.connectAndQueue())) this.failAndRequeue();
  }

  /** 建连 + 入队（复用于首次与失败重排）。resolve = 队列已入。 */
  private async connectAndQueue(): Promise<boolean> {
    const flow = this.flow;
    let ws: WebSocket;
    try {
      ws = await openServerSocket(flow.serverUrl);
    } catch {
      if (this.status) this.status.text = '无法连接服务器，正在重试…';
      return false;
    }
    if (this.destroyed || !this.matching || this.handedOver) {
      ws.close();
      return false;
    }
    const socket = new BufferedSocket(ws as unknown as WsLike);
    this.socket = socket;
    this.linkClosed = false;
    socket.onmessage = (ev) => this.onMessage(ev);
    socket.onclose = () => this.onLinkClosed();
    sendQueue(socket, displayName(flow) || undefined);
    return true;
  }

  /** 失败（netplay-design §6）：提示后自动回匹配中继续排队，用户可 ✕。 */
  private failAndRequeue(): void {
    if (!this.matching || this.destroyed || this.handedOver) return;
    if (this.retrying) return; // error + close 连锁触发只排一次重试
    this.retrying = true;
    this.closeSocket();
    this.banner = null;
    this.renderMatching();
    if (this.status) this.status.text = '连接失败，正在重新匹配';
    this.timers.push(
      window.setTimeout(() => {
        this.retrying = false;
        if (!this.matching || this.destroyed || this.handedOver) return;
        if (this.status) this.status.text = '';
        void (async () => {
          if (!(await this.connectAndQueue())) this.failAndRequeue();
        })();
      }, RETRY_DELAY_MS),
    );
  }

  /** ✕ 取消：退队 + 断开，回待机态（一次点击、零二级交互）。 */
  private cancel(): void {
    if (!this.matching) return;
    this.matching = false;
    this.banner = null;
    this.startReady = false;
    if (this.socket) {
      if (!this.linkClosed) sendUnqueue(this.socket);
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
    for (const id of this.timers.splice(0)) window.clearTimeout(id);
    if (this.status) this.status.text = '';
    this.renderIdle();
  }

  private back(): void {
    if (this.matching && this.socket && !this.linkClosed) sendUnqueue(this.socket);
    this.ctx!.switchTo(new MenuScene(this.flow));
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
        if (!this.matching || this.banner) return;
        const flow = this.flow;
        flow.mode = 'net';
        flow.player = msg.player === 2 ? 2 : 1;
        flow.room = String(msg.room ?? '');
        const name = displayName(flow);
        flow.name = name || `玩家${flow.player}`;
        // 匹配固定属性 + 权威种子（matched 直接携带，无 map-roll 消息）
        flow.team = msg.team === true;
        flow.randomMap = true;
        flow.mapSeed = typeof msg.seed === 'number' ? msg.seed : null;
        const opponent = (msg.opponent as { name?: string } | undefined)?.name ?? '对手';
        this.banner = flow.player === 1
          ? { left: flow.name, right: opponent }
          : { left: opponent, right: flow.name };
        this.bannerMs = 0;
        this.renderBanner();
        break;
      }
      case 'start':
        // 配对房开局段 start（进入选人页）；hello 收齐的第二段由对局层消费
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

  private onLinkClosed(): void {
    if (this.handedOver) return;
    this.linkClosed = true;
    this.failAndRequeue();
  }

  /** 建连就绪 → 移交选人页（与 RoomScene.enterSetup 同款交接）。 */
  private enterSetup(): void {
    const socket = this.socket;
    if (!socket || this.handedOver) return;
    this.handedOver = true;
    this.matching = false;
    socket.onmessage = null;
    socket.onclose = null;
    this.socket = null;
    this.ctx!.switchTo(new SetupScene(this.flow, socket));
  }
}
