/**
 * 随机匹配原位态：「随机匹配」子项按钮原位翻转变身成匹配位（不走浮层）——
 * 板面 = 匹配中秒表，点击匹配位 / Esc 退队；配对成功切全屏 VS 横幅揭示
 * （横幅下限 2.5s + start 就绪即切选人页，横幅期仍可退队）。
 * 仅团队 3+1 队列（2026-11-24 定案：1v1 匹配下线，单挑走建房/好友房）；
 * 对局是否团队以服务器 matched.team 回执为准，本端不再上行模式偏好。
 * 失败自动重排（error/peer-lost/断链同语义）；切选人页时 socket 消息泵移交。
 */
import { Container, Graphics } from 'pixi.js';
import { BufferedSocket, sendQueue, sendUnqueue, type WsLike } from '@bvn/net';
import type { SceneCtx } from './scene.js';
import { makeButton, makeLabel, UI_H, UI_W } from '../ui.js';
import type { Flow } from '../flow.js';
import { displayName, openServerSocket } from './net-common.js';
import { SetupScene } from './setup.js';
import type { MenuBtn } from './menu.js';

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
function buildVsBanner(leftName: string, rightName: string, caption = '已找到对手'): Container {
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

export class QuickMatch {
  /** 全屏揭示层（横幅期挂内容；匹配中不显示） */
  readonly ui = new Container();

  private state: 'matching' | 'banner' = 'matching';

  private socket: WsLike | null = null;
  /** 底层连接已断（退队不再上行，仅等待重连重排） */
  private linkClosed = false;
  /** 重试定时器在途（error + close 连锁只排一次） */
  private retrying = false;
  /** 匹配中秒表与横幅期状态 */
  private matchingMs = 0;
  private banner: { left: string; right: string } | null = null;
  private bannerMs = 0;
  private startReady = false;
  /** 已移交选人页（dispose/退队不得关 socket） */
  private handedOver = false;
  private destroyed = false;
  /** 重试提示（板面优先显示；空 = 秒表） */
  private statusText = '';
  private readonly timers: number[] = [];

  constructor(
    private readonly ctx: SceneCtx,
    private readonly flow: Flow,
    private readonly btn: MenuBtn,
    layer: Container,
    /** 用户退队（✕ 点击；Esc 由 MenuScene 直调 cancel） */
    private readonly onCancel: () => void,
  ) {
    layer.addChild(this.ui);
    void this.connectAndQueue().then((queued) => {
      if (!queued) this.failAndRequeue();
    });
  }

  update(dtMs: number): void {
    if (this.destroyed) return;
    if (this.state === 'matching') {
      this.matchingMs += dtMs;
      // 板面：重试提示优先，否则秒表（setLabel 同值守卫，逐秒才真重写）
      this.btn.setLabel(this.statusText || `匹配中 ${clockText(this.matchingMs)}`);
    } else if (this.state === 'banner' && this.banner && !this.handedOver) {
      this.bannerMs += dtMs;
      // 横幅下限已满且建连就绪（start 已到）→ 切选人页
      if (this.startReady && this.bannerMs >= BANNER_MIN_MS) this.enterSetup();
    }
  }

  /** 用户退队（✕ / Esc / 点击匹配位）：上行退队 + 断开 + 撤揭示层。 */
  cancel(): void {
    this.teardown(true);
  }

  /** 场景退场兜底：撤定时器；已移交选人页的连接不关（选人页接管消息泵）。 */
  dispose(): void {
    if (this.handedOver) {
      for (const id of this.timers.splice(0)) window.clearTimeout(id);
      this.timers.length = 0;
      return;
    }
    this.teardown(false);
  }

  private teardown(sendUnqueueMsg: boolean): void {
    for (const id of this.timers.splice(0)) window.clearTimeout(id);
    this.timers.length = 0;
    this.retrying = false;
    if (this.socket) {
      if (sendUnqueueMsg && !this.linkClosed) sendUnqueue(this.socket);
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
    this.linkClosed = false;
    this.destroyed = true;
    this.ui.destroy({ children: true });
  }

  // ---------- 流程 ----------

  /** 建连 + 入队（复用于首次与失败重排）。resolve = 队列已入。 */
  private async connectAndQueue(): Promise<boolean> {
    let ws: WebSocket;
    try {
      ws = await openServerSocket(this.flow.serverUrl);
    } catch {
      if (!this.destroyed) this.statusText = '无法连接服务器';
      return false;
    }
    if (this.destroyed || this.handedOver) {
      ws.close();
      return false;
    }
    const socket = new BufferedSocket(ws as unknown as WsLike);
    this.socket = socket;
    this.linkClosed = false;
    socket.onmessage = (ev) => this.onMessage(ev);
    socket.onclose = () => this.onLinkClosed();
    // 仅团队 3+1 队列（1v1 匹配下线；对局模式以 matched.team 回执为准）
    sendQueue(socket, displayName(this.flow) || undefined, true);
    return true;
  }

  /** 失败：提示后自动回匹配中继续排队，用户可 ✕/Esc。 */
  private failAndRequeue(): void {
    if (this.state !== 'matching' || this.destroyed || this.handedOver) return;
    if (this.retrying) return; // error + close 连锁触发只排一次重试
    this.retrying = true;
    this.closeSocket();
    this.statusText = '连接失败，正在重新匹配';
    this.timers.push(
      window.setTimeout(() => {
        this.retrying = false;
        if (this.state !== 'matching' || this.destroyed || this.handedOver) return;
        this.statusText = '';
        void this.connectAndQueue().then((queued) => {
          if (!queued) this.failAndRequeue();
        });
      }, RETRY_DELAY_MS),
    );
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
    if (this.handedOver || this.destroyed) return;
    this.linkClosed = true;
    this.failAndRequeue();
  }

  // ---------- 消息泵（matching/banner 期接管 socket） ----------

  private onMessage(ev: { data: unknown }): void {
    if (this.handedOver || this.destroyed) return;
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
        this.statusText = '';
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

  /** 横幅期：全屏暗底 + VS 画面 + 底部 ✕（横幅期也可退队）。 */
  private renderBanner(): void {
    this.state = 'banner';
    this.ui.visible = true;
    // 暗底吃掉指针事件：横幅期下层菜单按钮 hover/点击不可达
    const backdrop = new Graphics();
    backdrop.rect(0, 0, UI_W, UI_H).fill({ color: 0x040a14, alpha: 0.62 });
    backdrop.eventMode = 'static';
    this.ui.addChild(backdrop);
    if (this.banner) this.ui.addChild(buildVsBanner(this.banner.left, this.banner.right));
    const cancel = makeButton('✕', () => this.onCancel(), { w: 44, h: 44, size: 20, color: 0x5e2222 });
    cancel.position.set(UI_W / 2 - 22, 440);
    this.ui.addChild(cancel);
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
