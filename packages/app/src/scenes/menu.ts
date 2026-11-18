/**
 * 主菜单（切片 16 原版化）。
 *
 * 开场：stg_title 流帧（baked/ui.json title 段）——原版语义：帧 2..50 播完定格（帧脚本
 * addFrameScript(49,stop)），点击/任意键 → gotoAndPlay("menu")：帧 65..75 定格，按钮组
 * 同时入场。帧 PNG 注册：原版把 stg_title 以 (0,0) addChild 到 800×600 舞台，FFDec 导出
 * 画布原点 = 内容 bounds 左上 → 挂载位 = 舞台位 - stageOriginInFrame，并裁剪到舞台矩形
 * （原版窗口即舞台，越界内容不可见）。
 *
 * 按钮：mc_wzbtn 阶梯组（MenuStage/MenuBtnGroup/MenuBtn 规格）：组位 (470,100)、
 * xadd -40、项距 height+5；English 标签 + hover 橙板（中文小字挂板内，仅 hover/开态可见）；
 * 子菜单子项/开态蓝板 scaleX 0.9/scaleY 0.75、项高 55；入场 scaleX 0.01→1 Back.easeOut 逐项 0.04s；
 * 键盘 ↑/↓/Enter/Backspace 导航。偏离：BitmapFontText/BitmapText → 系统字体 Text（切片 15 ②同）。
 *
 * 流帧播放：单帧解码 ~7MB 显存，全量常驻 ~630MB 不可行 → 常驻小窗口（预取 5 帧、
 * 释放身后帧）；磁盘 WebP 共 ~8.5MB（PNG 的 1/13）。
 */
import { Assets, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { Scene, SceneCtx } from './scene.js';
import { audioOf } from '../audio.js';
import { makeLabel, UI_H, UI_W } from '../ui.js';
import { tickTweens, tweenOf, clearTweens } from '../anim.js';
import type { Flow } from '../flow.js';
import { ASSETS, loadUi, type UiData } from '../data.js';
import { FrameStream } from './stream.js';
import { SetupScene } from './setup.js';
import { NetScene } from './net.js';
import { BrowseScene } from './browse.js';
import { MatchScene } from './match.js';

/** 原版 MainGame.VERSION 同位常量（仓库无版本管线，发布时更新）。 */
const VERSION = 'BVN Web v0.0.0';

/** 原版 800×600 舞台在 1000×600 逻辑屏内的横向偏移。 */
const OX = (UI_W - 800) / 2;

// ---------- 菜单项定义与按钮（MenuBtn 原版语义） ----------

interface MenuEntry {
  en: string;
  cn: string;
  children?: MenuEntry[];
  action?: () => void;
}

class MenuBtn {
  readonly ui = new Container();
  /** 布局项高（原版 MenuBtn.height：常态 75，childMode 55）。 */
  height: number;
  index = 0;
  children: MenuBtn[] | null = null;
  private isOpen = false;
  private readonly bg: Sprite;
  private readonly label: Text;
  private readonly texBg1: Texture;
  private readonly texBg2: Texture;

  constructor(
    readonly entry: MenuEntry,
    menu: UiData['menu'],
    tex: { btn: Texture; bg1: Texture; bg2: Texture },
    isChild: boolean,
    onHover: (b: MenuBtn) => void,
    onSelect: (b: MenuBtn) => void,
  ) {
    this.height = menu.btnHeight;
    this.texBg1 = tex.bg1;
    this.texBg2 = tex.bg2;
    this.ui.addChild(new Sprite(tex.btn));

    // bg 子件（原版 wzimg_bgimg 帧 1=橙 / 帧 2=蓝）：hover 橙板（bg1）/ 开态·子项蓝板（bg2），
    // 挂 (0,-5)，中文小字挂板内 (10,45)（bg 隐藏时中文不可见，原版如此）
    this.bg = new Sprite(isChild ? tex.bg2 : tex.bg1);
    this.bg.position.set(menu.bgOffset[0], menu.bgOffset[1]);
    if (isChild) {
      this.height = menu.childHeight;
      this.bg.scale.set(0.9, 0.75); // childMode：ui.bg.scaleX 0.9 / scaleY 0.75
    } else {
      this.bg.visible = false;
    }
    const cnText = makeLabel(entry.cn, { size: 18, color: 0xffffff });
    cnText.position.set(menu.cnTextPos[0], menu.cnTextPos[1]);
    this.bg.addChild(cnText);

    // English 标签：原版 BitmapFontText 居中（x=-w/2）；系统字体近似，锚点居中
    this.label = makeLabel(entry.en, { size: 24, color: 0xffffff, bold: true });
    this.label.anchor.set(0.5, 0);
    this.label.position.set(388 / 2, 10);
    if (isChild) this.label.scale.set(0.75);

    this.ui.addChild(this.bg, this.label);
    this.ui.eventMode = 'static';
    this.ui.cursor = 'pointer';
    this.ui.on('pointerover', () => onHover(this));
    this.ui.on('pointertap', () => onSelect(this));
  }

  hover(): void {
    if (this.isOpen || this.bg.visible) return;
    this.bg.visible = true;
    this.bg.scale.set(0.01, 1);
    tweenOf(this.bg, { 'scale.x': 1 }, 200);
  }

  normal(): void {
    if (this.isOpen) return;
    this.bg.visible = false;
  }

  openChild(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.bg.texture = this.texBg2; // 原版 ui.bg.gotoAndStop(2)：开态蓝板（帧 2）
  }

  closeChild(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.bg.texture = this.texBg1; // 原版 ui.bg.gotoAndStop(1)：回到 hover 橙板（帧 1）
  }

  /** 原版 select：alpha -1→1 Elastic 1s 后回调；近似为快速淡入 0.35s。 */
  select(back: () => void): void {
    this.ui.alpha = 0.1;
    tweenOf(this.ui, { alpha: 1 }, 350, { ease: (k) => k, done: back });
  }
}

// ---------- 场景 ----------

export class MenuScene implements Scene {
  readonly name = 'menu';

  private uiData: UiData | null = null;
  private stream: FrameStream | null = null;
  private frameSprite: Sprite | null = null;
  private phase: 'intro' | 'skipping' | 'menu-anim' | 'menu' = 'intro';
  private frame = 0;
  private acc = 0;
  private skipEnabled = false;
  private destroyed = false;

  private menuGroup: Container | null = null;
  private btns: MenuBtn[] = [];
  private childOpen: MenuBtn | null = null;
  private menuEnabled = false;
  private navIndex = 0;

  private readonly onKey = (e: KeyboardEvent) => this.handleKey(e);
  private readonly timers: number[] = [];
  private switchTo: ((s: Scene) => void) | null = null;
  private ctx: SceneCtx | null = null;
  private hoveredBtn: MenuBtn | null = null;

  constructor(private readonly flow: Flow) {}

  async enter(ctx: SceneCtx): Promise<void> {
    const root = ctx.root;
    this.switchTo = ctx.switchTo;
    this.ctx = ctx;

    // 对局音频（切片 27）：主页 BGM（原版 MenuStage BGM(op)）
    audioOf(ctx.ctx)?.bgm('op');

    // 黑底（帧 PNG 未就绪时）
    const bg = new Graphics();
    bg.rect(0, 0, UI_W, UI_H).fill({ color: 0x000000 });
    root.addChild(bg);

    this.uiData = await loadUi(ctx.ctx);
    const title = this.uiData.title;

    // 原版：stg_title (0,0) 挂 800×600 舞台 → 帧 PNG 挂 舞台-stageOriginInFrame，裁剪到舞台矩形
    const clip = new Container();
    const mask = new Graphics();
    mask.rect(OX, 0, 800, 600).fill({ color: 0xffffff });
    clip.mask = mask;
    root.addChild(mask, clip);
    const frameSprite = new Sprite();
    frameSprite.position.set(OX - title.stageOriginInFrame[0], -title.stageOriginInFrame[1]);
    clip.addChild(frameSprite);
    this.frameSprite = frameSprite;

    // 菜单按钮组（原版：intro 期间即构建，showBtns 时挂入并入场）
    const btnTex = {
      btn: await Assets.load<Texture>(`${ASSETS}/${this.uiData.menu.elements.wzbtn}`),
      bg1: await Assets.load<Texture>(`${ASSETS}/${this.uiData.menu.elements.wzbtn_bg1}`),
      bg2: await Assets.load<Texture>(`${ASSETS}/${this.uiData.menu.elements.wzbtn_bg2}`),
    };
    const group = new Container();
    group.position.set(OX + this.uiData.menu.groupPos[0], this.uiData.menu.groupPos[1]);
    group.visible = false;
    this.menuGroup = group;
    root.addChild(group);
    this.buildMenuGroup(btnTex);

    // 版本字（原版 afterBuild：右下角内缩，黑色 18px）
    const version = makeLabel(VERSION, { size: 18, color: 0x000000 });
    version.position.set(OX + 800 - this.uiData.menu.versionPad[0] - version.width, UI_H - this.uiData.menu.versionPad[1] - version.height);
    root.addChild(version);

    // 流帧：预取头几帧后开播
    this.stream = new FrameStream({ dir: title.dir, frames: title.frames, from: title.introFrom, to: title.menuStop });
    this.stream.ensure(title.introFrom, 5);
    await this.waitFrames(title.introFrom, 4);
    if (this.destroyed) return;
    frameSprite.texture = this.stream.get(title.introFrom) ?? Texture.WHITE;
    this.frame = title.introFrom;
    this.acc = 0;
    this.phase = 'intro';
    group.visible = false;

    // 点击跳过（原版 500ms 后启用；点击区 = 舞台矩形）
    this.timers.push(
      window.setTimeout(() => {
        if (!this.destroyed) this.skipEnabled = true;
      }, 500),
    );
    const hit = new Graphics();
    hit.rect(OX, 0, 800, 600).fill({ color: 0xffffff, alpha: 0 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointertap', () => {
      this.skipIntro();
      // 跳过后热区让位给按钮组（否则挡住全部指针事件）
      hit.eventMode = 'none';
      hit.cursor = 'default';
    });
    root.addChild(hit);

    window.addEventListener('keydown', this.onKey);
  }

  update(dtMs: number): void {
    tickTweens(dtMs);
    if (!this.stream || !this.frameSprite || !this.uiData) return;
    const t = this.uiData.title;
    if (this.phase === 'intro' || this.phase === 'menu-anim') {
      this.acc += dtMs;
      const from = this.phase === 'intro' ? t.introFrom : t.menuFrame;
      const stop = this.phase === 'intro' ? t.introStop : t.menuStop;
      const f = Math.min(stop, from + Math.floor((this.acc * t.fps) / 1000));
      if (f !== this.frame) {
        const tex = this.stream.get(f);
        if (tex) {
          // 纹理就绪才推进（sprite 始终显示 this.frame 的纹理，release 窗口才是安全的）
          this.frame = f;
          this.frameSprite.texture = tex;
        } else if (this.stream.failed(f)) {
          this.frame = f; // 失败帧视为已过（保持上一帧画面；与 logo/winner 场景同语义，防卡死）
        } else {
          // 停帧等待：回退本次累积，播放头冻结在 frame+1。若放任 acc 累积，
          // f 会冲到 stop，ensure(f,4) 预取的远端帧落在 release 常驻窗之外
          // （加载完即销毁→重取风暴→连接池饿死 frame+1 → 永久停帧；高延迟部署必现）
          this.acc -= dtMs;
          this.stream.ensure(this.frame + 1, 4);
        }
      }
      // menu 段播完定格（intro 段定格仍留在 'intro' 等点击，原版帧脚本 stop 语义）
      if (this.phase === 'menu-anim' && this.frame >= stop) this.phase = 'menu';
      // 常驻窗口：身后 2 帧、身前 6 帧
      this.stream.release((i) => i >= this.frame - 2 && i <= this.frame + 6);
      this.stream.ensure(this.frame + 1, 4); // 持续预取身前帧
    }
  }

  exit(): void {
    this.destroyed = true;
    window.removeEventListener('keydown', this.onKey);
    for (const id of this.timers) window.clearTimeout(id);
    clearTweens();
    this.stream?.dispose();
    this.stream = null;
  }

  // ---------- 流程 ----------

  private async skipIntro(): Promise<void> {
    if (!this.skipEnabled || !this.uiData || this.phase !== 'intro') return;
    this.skipEnabled = false;
    this.phase = 'skipping'; // 等待 menu 帧加载期间暂停推进/释放
    const t = this.uiData.title;
    await this.waitFrames(t.menuFrame, 5);
    if (this.destroyed) return;
    this.acc = 0;
    this.frame = t.menuFrame;
    const tex = this.stream?.get(t.menuFrame);
    if (tex && this.frameSprite) this.frameSprite.texture = tex;
    this.phase = 'menu-anim';
    // 按钮组入场（原版 showBtns：btnGroup 挂入 + fadIn(0.2, 0.04)，400ms 后可操作）
    const group = this.menuGroup;
    if (group) {
      audioOf(this.ctx?.ctx!)?.se('menu5', 'swc'); // 原版 showBtns 音
      group.visible = true;
      this.btns.forEach((b, i) => {
        b.ui.scale.set(0.01, 1);
        tweenOf(b.ui, { 'scale.x': 1 }, 200, { delayMs: i * 40 });
      });
      this.timers.push(
        window.setTimeout(() => {
          if (!this.destroyed) this.menuEnabled = true;
        }, 400),
      );
    }
  }

  private async waitFrames(first: number, ahead: number): Promise<void> {
    // 轮询等待首帧纹理可用（load 完成即 resolve）
    for (;;) {
      if (this.stream?.ensure(first, ahead)) {
        const tex = this.stream.get(first);
        if (tex) return;
      }
      // 首帧达重试上限仍失败：放弃等待（enter 处有 Texture.WHITE 回退），防永久卡死
      if (this.destroyed || this.stream?.permanentlyFailed(first)) return;
      await new Promise((r) => window.setTimeout(r, 50));
    }
  }

  // ---------- 按钮组（MenuBtnGroup 语义） ----------

  private buildMenuGroup(tex: { btn: Texture; bg1: Texture; bg2: Texture }): void {
    const menu = this.uiData!.menu;
    const defs: MenuEntry[] = [
      {
        en: 'SINGLE PLAY',
        cn: '单机训练',
        action: () => {
          this.flow.mode = 'solo';
          this.flow.player = 1;
          this.flow.team = false;
          this.switchTo?.(new SetupScene(this.flow));
        },
      },
      {
        en: 'LOCAL PLAY',
        cn: '本地双人',
        children: [
          {
            en: '1 VS 1',
            cn: '单挑 1v1',
            action: () => {
              this.flow.mode = 'local';
              this.flow.player = 1; // 本地双人恒以 P1 视角装配（防联机客座残留）
              this.flow.team = false;
              this.switchTo?.(new SetupScene(this.flow));
            },
          },
          {
            en: 'TEAM MATCH',
            cn: '团队模式',
            action: () => {
              this.flow.mode = 'local';
              this.flow.player = 1;
              this.flow.team = true;
              this.switchTo?.(new SetupScene(this.flow));
            },
          },
        ],
      },
      {
        en: 'NET PLAY',
        cn: '联机对战',
        children: [
          {
            en: 'CREATE ROOM',
            cn: '创建房间',
            action: () => {
              this.flow.mode = 'net';
              this.switchTo?.(new NetScene(this.flow, { action: 'create' }));
            },
          },
          {
            en: 'BROWSE ROOMS',
            cn: '浏览房间',
            action: () => {
              this.flow.mode = 'net';
              this.switchTo?.(new BrowseScene(this.flow));
            },
          },
          {
            en: 'QUICK MATCH',
            cn: '随机匹配',
            action: () => {
              this.flow.mode = 'net';
              this.switchTo?.(new MatchScene(this.flow));
            },
          },
          {
            en: 'JOIN ROOM',
            cn: '加入房间',
            action: () => {
              this.flow.mode = 'net';
              this.switchTo?.(new NetScene(this.flow, { action: 'join' }));
            },
          },
        ],
      },
    ];
    const make = (o: MenuEntry, isChild: boolean): MenuBtn => {
      const b = new MenuBtn(
        o,
        menu,
        tex,
        isChild,
        (x) => this.hoverBtn(x),
        (x) => this.selectBtn(x),
      );
      if (!isChild) {
        b.index = this.btns.length;
        this.btns.push(b);
      }
      if (o.children) {
        b.children = o.children.map((c, j) => {
          const cb = make(c, true);
          cb.index = j;
          return cb;
        });
      }
      return b;
    };
    for (const o of defs) make(o, false);
    this.layout(false);
    for (const b of this.btns) this.menuGroup!.addChild(b.ui);
    this.hoverBtn(this.btns[0]!);
  }

  private layout(animate: boolean): void {
    const menu = this.uiData!.menu;
    let lx = 0;
    let ly = 0;
    const place = (b: MenuBtn, isChildNew: boolean, childIdx: number) => {
      if (animate) tweenOf(b.ui, { x: lx, y: ly }, 200, { ease: (k) => k });
      else b.ui.position.set(lx, ly);
      if (isChildNew) {
        // 原版 setBtns：子项入场 scaleX 0.01→1 Back.easeOut 逐项 0.04s
        b.ui.scale.set(0.01, 1);
        tweenOf(b.ui, { 'scale.x': 1 }, 200, { delayMs: childIdx * 40 });
      }
      ly += b.height + menu.yadd;
      lx += menu.xadd;
    };
    for (const b of this.btns) {
      place(b, false, 0);
      if (this.childOpen === b && b.children) {
        b.children.forEach((cb, j) => place(cb, !cb.ui.parent, j));
      }
    }
  }

  private hoverBtn(btn: MenuBtn): void {
    const list = this.currentList();
    const idx = list.indexOf(btn);
    if (idx >= 0) this.navIndex = idx;
    // 原版 MenuBtn.hover：bg 未显示才播 select 音（变更沿触发）
    if (this.hoveredBtn !== btn) audioOf(this.ctx?.ctx!)?.se('menu1', 'swc');
    this.hoveredBtn = btn;
    for (const b of this.btns) (b === btn ? b.hover() : b.normal());
    if (this.childOpen) {
      for (const cb of this.childOpen.children!) (cb === btn ? cb.hover() : cb.normal());
    }
  }

  private selectBtn(btn: MenuBtn): void {
    if (!this.menuEnabled) return;
    // 原版 MenuBtn.select：确认音（含展开子菜单）
    audioOf(this.ctx?.ctx!)?.se('menu2', 'swc');
    if (btn.children) {
      this.toggleChildren(btn);
      return;
    }
    this.menuEnabled = false;
    btn.select(() => btn.entry.action?.());
  }

  private toggleChildren(btn: MenuBtn): void {
    if (this.childOpen) {
      const same = btn === this.childOpen;
      if (!same) this.childOpen.normal();
      if (same) {
        this.closeChildren();
        return;
      }
      this.closeChildren();
    }
    this.childOpen = btn;
    btn.openChild();
    this.layout(true);
    for (const cb of btn.children!) {
      if (!cb.ui.parent) this.menuGroup!.addChild(cb.ui);
    }
    this.hoverBtn(btn.children![0]!);
  }

  private closeChildren(): void {
    const btn = this.childOpen;
    if (!btn) return;
    for (const cb of btn.children!) cb.ui.removeFromParent();
    btn.closeChild();
    this.childOpen = null;
    this.layout(true);
  }

  private currentList(): MenuBtn[] {
    return this.childOpen ? this.childOpen.children! : this.btns;
  }

  private handleKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const k = e.key;
    if (this.phase === 'intro') {
      // 原版 GameInputer.anyKey：任意键跳过
      this.skipIntro();
      return;
    }
    if (!this.menuEnabled) return;
    const list = this.currentList();
    if (k === 'ArrowUp' || k === 'w' || k === 'W') {
      e.preventDefault();
      this.navIndex = (this.navIndex - 1 + list.length) % list.length;
      this.hoverBtn(list[this.navIndex]!);
    } else if (k === 'ArrowDown' || k === 's' || k === 'S') {
      e.preventDefault();
      this.navIndex = (this.navIndex + 1) % list.length;
      this.hoverBtn(list[this.navIndex]!);
    } else if (k === 'Enter' || k === ' ' || k === 'j' || k === 'J') {
      e.preventDefault();
      this.selectBtn(list[this.navIndex]!);
    } else if (k === 'Escape' || k === 'Backspace') {
      if (this.childOpen) {
        this.navIndex = this.btns.indexOf(this.childOpen);
        this.closeChildren();
      }
    }
  }
}
