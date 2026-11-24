/**
 * 设置面板（设置面板切片，2026-11-24）——菜单内全屏浮层。
 *
 * 原版对位：SettingStage + SetBtnGroup + SetBtn（参考规格）：
 * - 竖排设置项列表：英文标签（位图字体 → 系统字体 Text 偏离，同 MenuBtn 登记）+
 *   ◄ 当前值 ► 左右箭头切档；焦点 = 黄色下划线（0xFDED65）+ 行内中文说明小字
 *   （原版 SetBtnLine 双语标注语义）。
 * - 键鼠双通道：↑↓ 移焦点、←→ 切档、Esc/Backspace 返回；hover 即移焦点、
 *   点箭头切档；切档/移焦播 menu1 选择音、返回播 menu2 确认音（原版 sndSelect/sndConfrim）。
 * - 呈现偏离登记：原版为独立整页舞台（goStage，返回即重走标题动画），网页端改为
 *   菜单场景内全屏浮层——视觉等价整页，实现层保留菜单状态、返回零成本；
 *   右侧一护立绘位暂以纯色压暗替代（原版 setting.swf 立绘资产未收录，登记）。
 * - 音量项语义偏离（即改即存，无 APPLY 按钮）见 settings.ts 文件头。
 *
 * 本期只收音效/BGM 两项（按键映射/画质等原版其余项未实现，面板结构预留扩展位，
 * 进度见 PROGRESS.md）。
 */
import { Container, Graphics, Text } from 'pixi.js';
import { makeLabel, makeButton, UI_H, UI_W, type Button } from '../ui.js';
import type { SceneCtx } from './scene.js';
import { audioOf } from '../audio.js';
import {
  loadSettings,
  saveSettings,
  SETTINGS_CHANGED,
  type GameSettings,
} from '../settings.js';

/** 原版 800×600 舞台在 1000×600 逻辑屏内的横向偏移（与 MenuScene 同位）。 */
const OX = (UI_W - 800) / 2;

/** 音量档位文本（0~1 → "60%"）。 */
function volLabel(v: number): string {
  return `${Math.round(v * 100)}%`;
}

interface VolumeRowDef {
  /** GameSettings 键 */
  key: 'soundVolume' | 'bgmVolume';
  en: string;
  cn: string;
}

const ROW_DEFS: VolumeRowDef[] = [
  { key: 'soundVolume', en: 'SOUND', cn: '游戏音效' },
  { key: 'bgmVolume', en: 'BGM', cn: '背景音乐' },
];

/** 单个音量行（原版 SetBtn 三段式 ◄ 值 ► + 焦点黄线/中文说明）。 */
class VolumeRow {
  readonly ui = new Container();
  private readonly valueText: Text;
  private readonly focusLine: Graphics;
  private readonly cnText: Text;

  constructor(def: VolumeRowDef, getVol: () => number) {
    const label = makeLabel(def.en, { size: 24, color: 0xffffff, bold: true });
    this.ui.addChild(label);

    // 焦点：底部 1px 黄线（0xFDED65）+ 中文说明小字（SetBtnLine 语义）
    this.focusLine = new Graphics();
    this.cnText = makeLabel(def.cn, { size: 15, color: 0xfded65 });

    // ◄ 值 ►（原版 txt_arrow_mc + 选项位图字体 → 系统字体偏离）
    const prev = makeLabel('◄', { size: 18, color: 0x8fd0ff });
    const next = makeLabel('►', { size: 18, color: 0x8fd0ff });
    this.valueText = makeLabel(volLabel(getVol()), { size: 22, color: 0xfded65, bold: true });
    const layout = () => {
      // 原版 updateOption：prev 在标签右 50px，值居其后 10px，next 再右 10px
      prev.position.set(label.width + 50, 6);
      this.valueText.position.set(prev.x + prev.width + 14, 2);
      next.position.set(this.valueText.x + this.valueText.width + 14, 6);
      this.focusLine
        .clear()
        .moveTo(0, 32)
        .lineTo(Math.max(next.x + next.width, 200), 32)
        .stroke({ width: 1, color: 0xfded65 });
      this.cnText.position.set(0, 38);
    };
    layout();
    this.focusLine.visible = false;
    this.cnText.visible = false;
    this.ui.addChild(this.focusLine, this.cnText, prev, this.valueText, next);

    // 左右箭头点击切档（原版 prevArrow/nextArrow 点击区语义）；整行 hover = 移焦点
    const tapArrow = (el: Text, delta: -1 | 1) => {
      // 命中区太小，垫一块透明热区（点箭头附近也算）
      const pad = new Graphics();
      pad.rect(-10, -8, el.width + 20, el.height + 16).fill({ alpha: 0 });
      pad.eventMode = 'static';
      pad.cursor = 'pointer';
      pad.position.copyFrom(el.position);
      pad.on('pointertap', (e) => {
        e.stopPropagation();
        this.onAdjust?.(delta);
      });
      this.ui.addChild(pad);
    };
    tapArrow(prev, -1);
    tapArrow(next, 1);
    this.ui.eventMode = 'static';
    this.ui.on('pointerover', () => this.onHover?.());
  }

  private onHover: (() => void) | null = null;
  private onAdjust: ((delta: -1 | 1) => void) | null = null;

  /** 由面板装配回调（构造后再注入，避免构造参数爆炸）。 */
  bind(hooks: { hover: () => void; adjust: (delta: -1 | 1) => void }): void {
    this.onHover = hooks.hover;
    this.onAdjust = hooks.adjust;
  }

  refresh(v: number): void {
    this.valueText.text = volLabel(v);
  }

  setFocus(on: boolean): void {
    this.focusLine.visible = on;
    this.cnText.visible = on;
  }
}

export class SettingsOverlay {
  readonly ui = new Container();

  private settings: GameSettings;
  private rows: VolumeRow[] = [];
  private focusIndex = 0;
  private openState = false;
  private onClosed: (() => void) | null = null;

  constructor(private readonly ctx: SceneCtx) {
    this.settings = loadSettings();
    this.build();
    this.ui.visible = false;
  }

  /** 打开浮层（菜单侧负责停用自己的键盘导航）。 */
  open(onClosed: () => void): void {
    this.openState = true;
    this.onClosed = onClosed;
    this.focusIndex = 0;
    this.syncFocus();
    this.ui.visible = true;
  }

  close(sound = true): void {
    if (!this.openState) return;
    this.openState = false;
    this.ui.visible = false;
    if (sound) audioOf(this.ctx.ctx)?.se('menu2', 'swc');
    this.onClosed?.();
    this.onClosed = null;
  }

  get isOpen(): boolean {
    return this.openState;
  }

  /** 键盘路由（MenuScene 在浮层打开时把按键转进来）。 */
  handleKey(e: KeyboardEvent): void {
    const k = e.key;
    if (k === 'ArrowUp' || k === 'w' || k === 'W') {
      e.preventDefault();
      this.moveFocus(-1);
    } else if (k === 'ArrowDown' || k === 's' || k === 'S') {
      e.preventDefault();
      this.moveFocus(1);
    } else if (k === 'ArrowLeft' || k === 'a' || k === 'A') {
      e.preventDefault();
      this.adjust(-1);
    } else if (k === 'ArrowRight' || k === 'd' || k === 'D') {
      e.preventDefault();
      this.adjust(1);
    } else if (k === 'Escape' || k === 'Backspace') {
      e.preventDefault();
      this.close();
    }
  }

  // ---------- 内部 ----------

  private build(): void {
    // 全屏压暗背板（原版整页舞台语义；挡住下层菜单按钮的指针事件）
    const backdrop = new Graphics();
    backdrop.rect(0, 0, UI_W, UI_H).fill({ color: 0x04080f, alpha: 0.92 });
    backdrop.eventMode = 'static';
    backdrop.on('pointertap', () => {
      // 点空处不关闭（与原版整页一致，返回走按钮/Esc）
    });
    this.ui.addChild(backdrop);

    // 标题（原版无标题文字，仅页面构成；此处为网页端导航补强，登记偏离）
    const title = makeLabel('SETTING', { size: 34, color: 0xffffff, bold: true });
    title.position.set(OX + 120, 64);
    const titleCn = makeLabel('游戏设置', { size: 16, color: 0x8fd0ff });
    titleCn.position.set(OX + 122, 106);
    this.ui.addChild(title, titleCn);

    // 音量行（原版 startY=30/gap=70 列表节奏；此处给焦点说明行留白取 96）
    const startY = 170;
    const gap = 96;
    ROW_DEFS.forEach((def, i) => {
      const row = new VolumeRow(def, () => this.settings[def.key]);
      row.bind({
        hover: () => this.setFocus(ROW_DEFS.indexOf(def)),
        adjust: (delta) => {
          this.setFocus(ROW_DEFS.indexOf(def));
          this.adjust(delta);
        },
      });
      row.ui.position.set(OX + 120, startY + gap * i);
      this.ui.addChild(row.ui);
      this.rows.push(row);
    });
    this.syncValues();
    this.syncFocus();

    // 返回按钮（原版主设置页 APPLY 位 → 网页端即改即存，返回即退；偏离见 settings.ts）
    const back: Button = makeButton('返回 BACK', () => this.close(), { w: 200 });
    back.position.set(OX + 120, startY + gap * this.rows.length + 30);
    this.ui.addChild(back);

    // 操作提示（网页端补强；原版键位提示在 HOW TO PLAY，不属本页）
    const hint = makeLabel('↑↓ 选择　←→ 调节　Esc 返回', { size: 13, color: 0x6ea0cd });
    hint.position.set(OX + 122, UI_H - 36);
    this.ui.addChild(hint);
  }

  private setFocus(index: number): void {
    const n = this.rows.length;
    const next = (index + n) % n;
    if (next === this.focusIndex) return;
    audioOf(this.ctx.ctx)?.se('menu1', 'swc');
    this.focusIndex = next;
    this.syncFocus();
  }

  private moveFocus(delta: -1 | 1): void {
    this.setFocus(this.focusIndex + delta);
  }

  private adjust(delta: -1 | 1): void {
    const def = ROW_DEFS[this.focusIndex];
    if (!def) return;
    // 0~100% 十进档、循环切档（原版 SetBtn.prev/nextOption 语义：越界回绕）；
    // 整数步进后单次除法，避免 0.1 加法累积出 0.7000000000000001 存档
    const cur = Math.round(this.settings[def.key] * 10);
    const steped = (cur + delta + 11) % 11;
    const next = steped / 10;
    this.settings[def.key] = next;
    this.syncValues();
    // 即改即存 + 事件广播（AudioSubsystem 订阅应用到总线，改档即试听）
    saveSettings(this.settings);
    this.ctx.ctx.events.emit(SETTINGS_CHANGED, { ...this.settings });
    audioOf(this.ctx.ctx)?.se('menu1', 'swc');
  }

  private syncValues(): void {
    ROW_DEFS.forEach((def, i) => this.rows[i]?.refresh(this.settings[def.key]));
  }

  private syncFocus(): void {
    this.rows.forEach((r, i) => r.setFocus(i === this.focusIndex));
  }
}
