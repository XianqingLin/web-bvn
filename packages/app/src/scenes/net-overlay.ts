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
import type { SceneCtx } from './scene.js';
import { makeLabel, UI_H, UI_W } from '../ui.js';
import type { Flow } from '../flow.js';
import { enterRoom, roomErrorText } from './net-common.js';
import { reportInviteContext } from '../invite-context.js';
import { RoomScene } from './room.js';

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
        this.ctx.switchTo(new RoomScene(this.flow, socket));
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
