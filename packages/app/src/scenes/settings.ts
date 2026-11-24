/**
 * 游戏设置（设置面板切片 + 按键设置切片）——菜单内全屏浮层。
 *
 * 原版对位（参考规格）：SettingStage（主页）+ SetBtnGroup/SetBtn（行与焦点）+
 * SetCtrlBtnUI（P1/P2 KEY SET 二级页，SET ALL/SET DEFAULT/APPLY/CANCEL）+ SetBtnDialog（请按键框）。
 * - 底板 = 原版 stg_set_ui 单帧静态板（暗化标题版画背景 + OPTION 标题 + 一护立绘）。
 * - 行 = 文字 + 原版箭头：数值行 ◄►（txt_arrow_mc，next 镜像复用）；焦点 = 原版光标
 *   select_arrow_mc（挂行左侧）。
 * - 偏离登记：① 文字用系统字体（位图字体未收录，同 MenuBtn 登记）；② 呈现为菜单内全屏浮层，
 *   返回零成本（原版为独立整页舞台 goStage）；③ 音量即改即存，键位走 APPLY（二级页草稿）；
 *   ④ 焦点不用原版 SetBtnLine 的黄线与中文说明，仅保留光标；⑤ 键位冲突与 ESC 保留见 keymap.ts 文件头。
 */
import { Container, Graphics, Rectangle, Sprite, Text, Texture } from 'pixi.js';
import { makeLabel, UI_H, UI_W } from '../ui.js';
import type { SceneCtx } from './scene.js';
import { audioOf } from '../audio.js';
import { loadSettings, saveSettings, SETTINGS_CHANGED, type GameSettings } from '../settings.js';
import {
  bindKey,
  cloneBindings,
  isBindable,
  KEY_ACTIONS,
  KEY_DEFAULTS,
  keyLabel,
  RESERVED_CODE,
  type KeyAction,
  type KeyBindings,
  type KeyPlayer,
} from '../keymap.js';

/** 原版 800×600 舞台在 1000×600 逻辑屏内的横向偏移（与 MenuScene 同位）。 */
const OX = (UI_W - 800) / 2;
/** 列表区左缘（舞台坐标 x=120） */
const LIST_X = OX + 120;
/** 值列（相对行原点） */
const VALUE_X = 200;
const LABEL_SIZE = 22;

const YELLOW = 0xfded65;

interface Art {
  tex: Texture;
  /** 注册点在 PNG 内的位置（摆放时以注册点对齐，见 ui-pack 3e） */
  origin: [number, number];
}

export interface SettingsArt {
  plate: Art;
  txtArrow: Art;
  selectArrow: Art;
}

/** 注册点对齐：贴图左上 = 目标注册点 - origin（pivot 语义，scale -1 绕注册点镜像）。 */
function place(sprite: Sprite, art: Art, x: number, y: number): void {
  sprite.pivot.set(art.origin[0], art.origin[1]);
  sprite.position.set(x, y);
}

function volLabel(v: number): string {
  return `${Math.round(v * 100)}%`;
}

type VolumeKey = 'soundVolume' | 'bgmVolume';

interface RowSpec {
  en: string;
  /** 数值行（◄ 值 ►）；键位行只显示值不带箭头 */
  value?: boolean;
  arrows?: boolean;
}

/** 单行（原版 SetBtn）：标签 + 可选值/箭头。点击区域 = 文字（数值行含箭头）。 */
class SetRow {
  readonly ui = new Container();
  onHover: () => void = () => {};
  onPress: () => void = () => {};
  onAdjust: (delta: -1 | 1) => void = () => {};

  private readonly label: Text;
  private readonly value: Text | null;
  private readonly prev: Sprite | null = null;
  private readonly next: Sprite | null = null;
  private readonly arrowArt: Art | null;

  constructor(spec: RowSpec, arrowArt: Art | null) {
    this.arrowArt = arrowArt;
    this.label = makeLabel(spec.en, { size: LABEL_SIZE, color: 0xffffff, bold: true });
    this.value = spec.value ? makeLabel('', { size: LABEL_SIZE, color: YELLOW, bold: true }) : null;

    this.ui.addChild(this.label);
    if (this.value) this.ui.addChild(this.value);

    if (spec.arrows && arrowArt) {
      this.prev = new Sprite(arrowArt.tex);
      this.next = new Sprite(arrowArt.tex);
      this.next.scale.x = -1;
      for (const [arrow, delta] of [
        [this.prev, -1],
        [this.next, 1],
      ] as const) {
        arrow.eventMode = 'static';
        arrow.cursor = 'pointer';
        arrow.on('pointertap', (e) => {
          e.stopPropagation();
          this.onAdjust(delta);
        });
        this.ui.addChild(arrow);
      }
    }

    this.ui.eventMode = 'static';
    this.ui.cursor = 'pointer';
    this.ui.on('pointerover', () => this.onHover());
    this.ui.on('pointertap', () => this.onPress());
    this.layout();
  }

  setValue(text: string): void {
    if (!this.value) return;
    this.value.text = text;
    this.layout();
  }

  private layout(): void {
    let right = this.label.width;
    if (this.value && this.prev && this.next && this.arrowArt) {
      // 原版 SetBtn.updateOption：prev 在值列前，值居其后，next 再右（镜像）
      place(this.prev, this.arrowArt, VALUE_X, 15);
      this.value.position.set(VALUE_X + 18, 0);
      place(this.next, this.arrowArt, this.value.x + this.value.width + 18, 15);
      right = this.next.x + this.next.width;
    } else if (this.value) {
      this.value.position.set(VALUE_X, 0);
      right = VALUE_X + this.value.width;
    }
    // 点击区 = 文字所在范围（数值行延伸到箭头末端），不向右空白延伸；
    // 用 hitArea 限定行容器命中，不用透明 Graphics（Pixi v8 对 alpha 0 填充的命中不可靠）
    this.ui.hitArea = new Rectangle(-6, -4, right + 12, 36);
  }
}

/** 一页列表（原版 SetBtnGroup）：行布局 + 焦点光标。 */
class ListPage {
  readonly ui = new Container();
  private focus = 0;
  private readonly cursor: Sprite;
  private readonly ys: number[];
  private readonly cursorArt: Art;

  constructor(
    readonly rows: SetRow[],
    ys: number[],
    cursorArt: Art,
  ) {
    this.ys = ys;
    this.cursorArt = cursorArt;
    rows.forEach((r, i) => {
      r.ui.position.set(0, ys[i]!);
      this.ui.addChild(r.ui);
    });
    this.cursor = new Sprite(cursorArt.tex);
    this.ui.addChild(this.cursor);
    this.apply();
  }

  get focusIndex(): number {
    return this.focus;
  }

  get current(): SetRow {
    return this.rows[this.focus]!;
  }

  /** 焦点移动（循环）；返回是否真正变化（调用方据此播移焦音）。 */
  moveTo(index: number): boolean {
    const n = this.rows.length;
    const next = ((index % n) + n) % n;
    if (next === this.focus) return false;
    this.focus = next;
    this.apply();
    return true;
  }

  private apply(): void {
    place(this.cursor, this.cursorArt, -10, this.ys[this.focus]! + 15);
  }
}

export class SettingsOverlay {
  readonly ui = new Container();

  private settings: GameSettings;
  /** 键位二级页草稿（APPLY 才写入 settings） */
  private draft: KeyBindings = cloneBindings(KEY_DEFAULTS);
  private page: 'main' | 'keys' = 'main';
  private keyPlayer: KeyPlayer = 'p1';
  /** 逐键捕获：queue 为待绑定动作（SET ALL 为全部，单项为一个） */
  private capture: { player: KeyPlayer; queue: KeyAction[]; total: number } | null = null;

  private mainPage!: ListPage;
  private keysPage!: ListPage;
  private keyRows: SetRow[] = [];
  private keysTitle!: Text;
  private captureBox!: Container;
  private captureTitle!: Text;
  private captureHint!: Text;
  private volumeRows: { key: VolumeKey; row: SetRow }[] = [];

  private openState = false;
  private onClosed: (() => void) | null = null;

  constructor(
    private readonly ctx: SceneCtx,
    /** 原版底板与箭头（ui-pack 3e；menu enter 时预载） */
    private readonly art: SettingsArt,
  ) {
    this.settings = loadSettings();
    this.draft = cloneBindings(this.settings.keys);
    this.build();
    this.ui.visible = false;
  }

  /** 打开浮层（菜单侧负责停用自己的键盘导航）。 */
  open(onClosed: () => void): void {
    this.openState = true;
    this.onClosed = onClosed;
    this.draft = cloneBindings(this.settings.keys);
    this.page = 'main';
    this.capture = null;
    this.syncMain();
    this.syncCapture();
    this.showPage();
    this.ui.visible = true;
  }

  close(sound = true): void {
    if (!this.openState) return;
    this.openState = false;
    this.capture = null;
    this.ui.visible = false;
    if (sound) this.sfx('menu2');
    this.onClosed?.();
    this.onClosed = null;
  }

  get isOpen(): boolean {
    return this.openState;
  }

  /** 键盘路由（MenuScene 在浮层打开时把按键转进来）。 */
  handleKey(e: KeyboardEvent): void {
    if (this.capture) {
      // 请按键对话框：下一个可绑定键即写入草稿；ESC 取消（SET ALL 整段中止）
      e.preventDefault();
      if (e.code === RESERVED_CODE) {
        this.capture = null;
        this.syncCapture();
        return;
      }
      if (!isBindable(e.code)) return;
      const cap = this.capture;
      const action = cap.queue.shift()!;
      this.draft = bindKey(this.draft, cap.player, action, e.code);
      if (cap.queue.length === 0) this.capture = null;
      this.syncKeys();
      this.syncCapture();
      this.sfx('menu1');
      return;
    }

    const k = e.key;
    const list = this.page === 'main' ? this.mainPage : this.keysPage;
    if (k === 'ArrowUp' || k === 'w' || k === 'W') {
      e.preventDefault();
      this.moveFocus(list, -1);
    } else if (k === 'ArrowDown' || k === 's' || k === 'S') {
      e.preventDefault();
      this.moveFocus(list, 1);
    } else if (k === 'ArrowLeft' || k === 'a' || k === 'A') {
      e.preventDefault();
      if (this.page === 'main') this.adjustFocused(list, -1);
    } else if (k === 'ArrowRight' || k === 'd' || k === 'D') {
      e.preventDefault();
      if (this.page === 'main') this.adjustFocused(list, 1);
    } else if (k === 'Enter' || k === ' ' || k === 'j' || k === 'J') {
      e.preventDefault();
      list.current.onPress();
    } else if (k === 'Escape' || k === 'Backspace') {
      e.preventDefault();
      if (this.page === 'keys') this.backToMain();
      else this.close();
    }
  }

  // ---------- 内部 ----------

  private sfx(name: 'menu1' | 'menu2'): void {
    audioOf(this.ctx.ctx)?.se(name, 'swc');
  }

  private build(): void {
    // 全屏不透明黑底（原版整页舞台语义；挡住下层菜单按钮的指针事件）
    const backdrop = new Graphics();
    backdrop.rect(0, 0, UI_W, UI_H).fill({ color: 0x000000 });
    backdrop.eventMode = 'static';
    this.ui.addChild(backdrop);

    // 原版底板：stg_set_ui 挂 舞台-stageOriginInFrame，裁剪到 800×600 舞台矩形。
    // mask 必须进显示列表（与 menu.ts 同法）：脱离场景树的 mask 世界变换是单位阵，
    // 几何会落到画布像素空间而非本场景逻辑坐标——UIHost 缩放 ≠1 时裁剪位错位
    //（实测 1.056 倍下 OPTION 标题被裁半）。
    const clip = new Container();
    const mask = new Graphics();
    mask.rect(OX, 0, 800, 600).fill({ color: 0xffffff });
    this.ui.addChild(mask, clip);
    clip.mask = mask;
    const plateSprite = new Sprite(this.art.plate.tex);
    plateSprite.position.set(OX - this.art.plate.origin[0], -this.art.plate.origin[1]);
    clip.addChild(plateSprite);

    this.buildMain();
    this.buildKeys();

    this.captureBox = this.buildCaptureBox();
    this.ui.addChild(this.captureBox);
  }

  private buildMain(): void {
    const volume = (en: string, key: VolumeKey): SetRow => {
      const row = new SetRow({ en, value: true, arrows: true }, this.art.txtArrow);
      row.onAdjust = (d) => this.adjustVolume(key, d);
      this.volumeRows.push({ key, row });
      return row;
    };
    const nav = (en: string, go: () => void): SetRow => {
      const row = new SetRow({ en }, this.art.txtArrow);
      row.onPress = () => {
        this.sfx('menu2');
        go();
      };
      return row;
    };

    const rows = [
      volume('SOUND', 'soundVolume'),
      volume('BGM', 'bgmVolume'),
      nav('P1 KEY SET', () => this.openKeys('p1')),
      nav('P2 KEY SET', () => this.openKeys('p2')),
      nav('BACK', () => this.close()),
    ];
    this.mainPage = new ListPage(
      rows,
      rows.map((_, i) => 130 + i * 64),
      this.art.selectArrow,
    );
    this.mainPage.ui.position.set(LIST_X, 0);
    rows.forEach((row, i) => this.bindHover(this.mainPage, row, i));
    this.ui.addChild(this.mainPage.ui);
  }

  private buildKeys(): void {
    this.keysTitle = makeLabel('', { size: 26, color: YELLOW, bold: true });
    this.keysTitle.position.set(0, 64);

    this.keyRows = KEY_ACTIONS.map((a) => {
      const row = new SetRow({ en: a.en, value: true }, this.art.txtArrow);
      row.onPress = () => this.startCapture([a.id]);
      return row;
    });
    const all = new SetRow({ en: 'SET ALL' }, this.art.txtArrow);
    all.onPress = () => this.startCapture(KEY_ACTIONS.map((a) => a.id));
    const def = new SetRow({ en: 'SET DEFAULT' }, this.art.txtArrow);
    def.onPress = () => {
      this.draft[this.keyPlayer] = { ...KEY_DEFAULTS[this.keyPlayer] };
      this.syncKeys();
      this.sfx('menu2');
    };
    const apply = new SetRow({ en: 'APPLY' }, this.art.txtArrow);
    apply.onPress = () => this.applyKeys();
    const cancel = new SetRow({ en: 'CANCEL' }, this.art.txtArrow);
    cancel.onPress = () => this.backToMain();

    const rows = [...this.keyRows, all, def, apply, cancel];
    // 动作 10 行等距，操作组前留一段间距（原版 SetBtnGroup 分组节奏）
    const ys = rows.map((_, i) => 110 + i * 32 + (i >= KEY_ACTIONS.length ? 20 : 0));
    this.keysPage = new ListPage(rows, ys, this.art.selectArrow);
    this.keysPage.ui.position.set(LIST_X, 0);
    this.keysPage.ui.addChild(this.keysTitle);
    rows.forEach((row, i) => this.bindHover(this.keysPage, row, i));
    this.ui.addChild(this.keysPage.ui);
  }

  private buildCaptureBox(): Container {
    // 原版 SetBtnDialog（key_set_dialog_mc）语义：居中提示框，按键即关
    const box = new Container();
    const bg = new Graphics();
    bg.rect(OX + 170, 215, 460, 130).fill({ color: 0x000000, alpha: 0.9 });
    bg.rect(OX + 170, 215, 460, 130).stroke({ width: 1, color: YELLOW });
    box.addChild(bg);
    this.captureTitle = makeLabel('', { size: 22, color: 0xffffff, bold: true });
    this.captureTitle.anchor.set(0.5, 0);
    this.captureTitle.position.set(UI_W / 2, 245);
    this.captureHint = makeLabel('ESC 取消', { size: 15, color: YELLOW });
    this.captureHint.anchor.set(0.5, 0);
    this.captureHint.position.set(UI_W / 2, 296);
    box.addChild(this.captureTitle, this.captureHint);
    box.eventMode = 'static';
    box.visible = false;
    return box;
  }

  /** 行 hover 移焦点（播移焦音）；点击走行自身 onPress。 */
  private bindHover(list: ListPage, row: SetRow, index: number): void {
    row.onHover = () => {
      if (this.capture) return;
      if (list.moveTo(index)) this.sfx('menu1');
    };
  }

  private moveFocus(list: ListPage, delta: -1 | 1): void {
    if (list.moveTo(list.focusIndex + delta)) this.sfx('menu1');
  }

  private adjustFocused(list: ListPage, delta: -1 | 1): void {
    const row = list.current;
    const hit = this.volumeRows.find((v) => v.row === row);
    if (hit) this.adjustVolume(hit.key, delta);
  }

  private adjustVolume(key: VolumeKey, delta: -1 | 1): void {
    // 0~100% 十进档、循环切档（原版 SetBtn.prev/nextOption 语义：越界回绕）；
    // 整数步进后单次除法，避免 0.1 加法累积出 0.7000000000000001 存档
    const cur = Math.round(this.settings[key] * 10);
    this.settings[key] = ((cur + delta + 11) % 11) / 10;
    saveSettings(this.settings);
    this.ctx.ctx.events.emit(SETTINGS_CHANGED, { ...this.settings });
    this.syncMain();
    this.sfx('menu1');
  }

  private openKeys(player: KeyPlayer): void {
    this.keyPlayer = player;
    this.draft = cloneBindings(this.settings.keys);
    this.page = 'keys';
    this.keysPage.moveTo(0);
    this.syncKeys();
    this.showPage();
  }

  private backToMain(): void {
    this.capture = null;
    this.page = 'main';
    this.syncCapture();
    this.showPage();
    this.sfx('menu2');
  }

  private applyKeys(): void {
    this.settings.keys = cloneBindings(this.draft);
    saveSettings(this.settings);
    this.ctx.ctx.events.emit(SETTINGS_CHANGED, { ...this.settings });
    this.backToMain();
  }

  private startCapture(actions: KeyAction[]): void {
    this.capture = { player: this.keyPlayer, queue: [...actions], total: actions.length };
    this.syncCapture();
    this.sfx('menu2');
  }

  private showPage(): void {
    this.mainPage.ui.visible = this.page === 'main';
    this.keysPage.ui.visible = this.page === 'keys';
  }

  private syncMain(): void {
    for (const { key, row } of this.volumeRows) row.setValue(volLabel(this.settings[key]));
  }

  private syncKeys(): void {
    this.keysTitle.text = `${this.keyPlayer.toUpperCase()} KEY SET　玩家${this.keyPlayer === 'p1' ? '1' : '2'} 按键设置`;
    KEY_ACTIONS.forEach((a, i) => this.keyRows[i]!.setValue(keyLabel(this.draft[this.keyPlayer][a.id])));
  }

  private syncCapture(): void {
    const cap = this.capture;
    this.captureBox.visible = cap !== null;
    if (!cap) return;
    const done = cap.total - cap.queue.length;
    const action = KEY_ACTIONS.find((a) => a.id === cap.queue[0])!;
    this.captureTitle.text =
      cap.total > 1
        ? `请按下 ${action.en}（${action.cn}）对应的键　${done + 1} / ${cap.total}`
        : `请按下 ${action.en}（${action.cn}）对应的键`;
  }
}
