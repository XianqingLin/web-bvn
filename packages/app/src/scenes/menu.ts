/**
 * 主菜单（切片 16 原版化）。
 *
 * 开场：stg_title 流帧（baked/ui.json title 段）——原版语义：帧 2..50 播完定格（帧脚本
 * addFrameScript(49,stop)），点击/任意键 → gotoAndPlay("menu")：帧 65..75 定格，按钮组
 * 同时入场。帧 PNG 注册：原版把 stg_title 以 (0,0) addChild 到 800×600 舞台，FFDec 导出
 * 画布原点 = 内容 bounds 左上 → 挂载位 = 舞台位 - stageOriginInFrame，并裁剪到舞台矩形
 * （原版窗口即舞台，越界内容不可见）。
 *
 * 按钮：mc_wzbtn 阶梯组（MenuStage/MenuBtnGroup/MenuBtn 规格）：组位 (470,100)（=
 * 板水平中心，原版 shape bounds -194..+194 实证）、xadd -40、项距 height+5；English
 * 标签，常态无板（bg 子件默认隐藏）、hover 长出橙板、
 * 开态/子项蓝板（中文小字挂板内，仅 hover/开态可见；见 MenuBtn 构造偏离登记）；
 * 子菜单子项/开态蓝板 scaleX 0.9/scaleY 0.75、项高 55；入场 scaleX 0.01→1 Back.easeOut 逐项 0.04s；
 * 键盘 ↑/↓/Enter/Backspace 导航。偏离：BitmapFontText/BitmapText → 系统字体 Text（切片 15 ②同）。
 *
 * 流帧播放：单帧解码 ~7MB 显存，全量常驻 ~630MB 不可行 → 常驻小窗口（预取 5 帧、
 * 释放身后帧）；磁盘 WebP 共 ~8.5MB（PNG 的 1/13）。
 *
 * 三层夹心（切片 46）：底板流（剔除嵌套 fx 的干净板）→ fx 叠加层（嵌套元件按 SWF
 * 放置语义运行时合成，嵌套播放头板帧同步推进、定格期照走）→ 顶板流（logo/白闪，
 * 色变换烘焙；原 5DPLAY 导流横幅栈已剔除——2026-11-24 决策，见 DESIGN §4/ui-pack 3b）。两板流同帧号锁步推进，顶板纹理未就绪时停帧等待（失败帧除外）。
 */
import { Assets, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { Scene, SceneCtx } from './scene.js';
import { audioOf } from '../audio.js';
import { makeLabel, UI_H, UI_W } from '../ui.js';
import { nodeStatusLines, startNodeMonitor, loadManifest, resolveJoinNode, SEED_MANIFEST } from '../nodes.js';
import { reportInviteContext } from '../invite-context.js';

import { tickTweens, tweenOf, clearTweens } from '../anim.js';
import type { Flow } from '../flow.js';
import { ASSETS, loadUi, type UiData } from '../data.js';
import { FrameStream } from './stream.js';
import { TitleFxLayer } from './title-fx.js';
import { SetupScene } from './setup.js';
import { SettingsOverlay } from './settings.js';
import { MatchOverlay, RoomOverlay, ConfirmOverlay, type NetOverlay } from './net-overlay.js';
import { CodeCapture } from './code-capture.js';
import { enterRoom, roomErrorText } from './net-common.js';

/** 原版 MainGame.VERSION 同位常量（仅版本号；仓库无版本管线，发布时更新）。 */
const VERSION = 'v0.0.0';

/** 原版 800×600 舞台在 1000×600 逻辑屏内的横向偏移。 */
const OX = (UI_W - 800) / 2;

/** 会话级标记：主菜单开场是否已完整走过（回菜单不重播，刷新页面重置）。 */
let menuIntroPlayed = false;

// ---------- 菜单项定义与按钮（MenuBtn 原版语义） ----------

interface MenuEntry {
  en: string;
  cn: string;
  children?: MenuEntry[];
  action?: () => void;
  /** 置灰禁用（不可选；键盘导航跳过） */
  disabled?: boolean;
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
    tex: { bg1: Texture; bg2: Texture },
    isChild: boolean,
    onHover: (b: MenuBtn) => void,
    onSelect: (b: MenuBtn) => void,
  ) {
    this.height = menu.btnHeight;
    this.texBg1 = tex.bg1;
    this.texBg2 = tex.bg2;

    // 偏离登记（烘焙缺陷修正）：mc_wzbtn 常态帧导出把隐藏的 bg 子件烙了进去（与
    // wzbtn_bg1 逐字节相同），原版常态按钮只有 English 标签（MenuBtn 构造
    // ui.bg.visible=false），板子全靠 hover 长出——不挂常态板精灵。
    // bg 子件（原版 wzimg_bgimg 帧 1=橙 / 帧 2=蓝）：hover 橙板（bg1）/ 开态·子项蓝板
    //（bg2），挂 (0,-5)，中文小字挂板内 (10,45)（bg 隐藏时中文不可见，原版如此）。
    // 坐标语义修正（shape 10 bounds Xmin=-3880/Xmax=3880 实证）：原版 mc_wzbtn 原点 =
    // 板水平中心（-194..+194），FFDec 导出画布原点 = 内容 bounds 左上 → anchor 0.5
    // 把板中心钉回按钮原点（此前整按钮右移 194px、板出 800 舞台右缘）
    this.bg = new Sprite(isChild ? tex.bg2 : tex.bg1);
    this.bg.anchor.set(0.5, 0);
    this.bg.position.set(menu.bgOffset[0], menu.bgOffset[1]);
    this.bg.visible = false;
    if (isChild) {
      this.height = menu.childHeight;
      this.bg.scale.set(0.9, 0.75); // childMode：ui.bg.scaleX 0.9 / scaleY 0.75
    }
    const cnText = makeLabel(entry.cn, { size: 18, color: 0xffffff });
    cnText.position.set(menu.cnTextPos[0], menu.cnTextPos[1]);
    this.bg.addChild(cnText);

    // English 标签：原版 BitmapFontText 居中于按钮原点（x=-w/2）；系统字体近似，锚点居中
    this.label = makeLabel(entry.en, { size: 24, color: 0xffffff, bold: true });
    this.label.anchor.set(0.5, 0);
    this.label.position.set(0, 10);
    if (isChild) this.label.scale.set(0.75);

    this.ui.addChild(this.bg, this.label);
    this.ui.eventMode = 'static';
    this.ui.cursor = 'pointer';
    this.ui.on('pointerover', () => onHover(this));
    this.ui.on('pointertap', () => onSelect(this));
  }

  hover(): void {
    if (this.disabled || this.isOpen || this.bg.visible) return;
    this.bg.visible = true;
    this.bg.scale.set(0.01, 1);
    tweenOf(this.bg, { 'scale.x': 1 }, 200);
  }

  /** 置灰禁用：半透明、无 hover 板、不可选。 */
  private disabledFlag = false;
  get disabled(): boolean {
    return this.disabledFlag;
  }
  set disabled(v: boolean) {
    this.disabledFlag = v;
    this.ui.alpha = v ? 0.45 : 1;
    this.ui.cursor = v ? 'default' : 'pointer';
    if (v) this.normal();
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

  /** 按钮文字改写（「加入房间」原位变身：板面即输入位）；dim = 占位提示降饱和。 */
  setLabel(text: string, dim = false): void {
    this.label.text = text;
    this.label.alpha = dim ? 0.45 : 1;
  }

  /** 输入位光标锚点：板面文字末端（变身输入位的闪烁竖条定位用）。 */
  caretAnchor(): { x: number; y: number } {
    return { x: this.label.x + this.label.width / 2 + 5, y: this.label.y - 2 };
  }
}

// ---------- 场景 ----------

export class MenuScene implements Scene {
  readonly name = 'menu';

  private uiData: UiData | null = null;
  private streams: FrameStream[] = [];
  private frameSprite: Sprite | null = null;
  private topSprite: Sprite | null = null;
  private fxLayer: TitleFxLayer | null = null;
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
  /** 设置面板：菜单内全屏浮层，打开期间接管键盘/指针 */
  private settingsOverlay: SettingsOverlay | null = null;
  private settingsOpen = false;
  /** 联机浮层组（匹配/房间/确认框）：菜单内半透明暗底浮层，开启期接管键盘 */
  private readonly netOverlays: NetOverlay[] = [];
  private matchOverlay: MatchOverlay | null = null;
  private roomOverlay: RoomOverlay | null = null;
  private confirmOverlay: ConfirmOverlay | null = null;
  /**
   * 「加入房间」原位变身（不走浮层）：子项按钮翻转变身成输入位——板面显示
   * 房码、隐藏 input 采集，>6 位静默忽略；错误一律走确认框弹窗。
   */
  private joinState: 'off' | 'input' | 'connecting' = 'off';
  private joinSeq = 0;
  private joinDigits = '';
  private joinBtn: MenuBtn | null = null;
  /** 输入位闪烁光标（文字 caret；挂按钮内，随文字末端重定位） */
  private joinCaret: Graphics | null = null;
  private joinCaretAcc = 0;
  private joinCapture: CodeCapture | null = null;
  private joinPrefill: string | null = null;
  /** 当前开启的联机浮层（同一时刻至多一个；键盘路由与开启互斥判定用） */
  private get netOverlay(): NetOverlay | null {
    return this.netOverlays.find((o) => o.isOpen) ?? null;
  }
  /** dev 直通意图（URL 参数进入：菜单就绪后自动执行，见 runAutoIntent） */
  private auto: { action: 'create' | 'join' | 'match'; room?: string | undefined } | null;
  /** 菜单就绪后待执行的意图（跨节点加入确认流程挂在 enableMenu 之后） */
  private pendingIntent: (() => void) | null = null;

  private readonly onKey = (e: KeyboardEvent) => this.handleKey(e);
  private readonly timers: number[] = [];
  private switchTo: ((s: Scene) => void) | null = null;
  private ctx: SceneCtx | null = null;
  private hoveredBtn: MenuBtn | null = null;
  private nodeTitle: Text | null = null;
  private nodeLatency: Text | null = null;
  private nodeManifest = SEED_MANIFEST;
  private nodeRefreshAcc = 0;
  private stopNodeMonitor: (() => void) | null = null;

  constructor(private readonly flow: Flow, auto: { action: 'create' | 'join' | 'match'; room?: string | undefined } | null = null) {
    this.auto = auto;
  }

  async enter(ctx: SceneCtx): Promise<void> {
    const root = ctx.root;
    this.switchTo = ctx.switchTo;
    this.ctx = ctx;

    // 平台邀请深链：待入房房码转为自动意图（落主菜单后自动加入）
    const inviteRoom = this.flow.pendingInviteRoom;
    if (inviteRoom) {
      this.flow.pendingInviteRoom = null;
      this.auto = { action: 'join', room: inviteRoom };
    }
    // 深链跨节点加入：菜单就绪后确认/锁定切换（DESIGN §6.2）
    const deepLink = this.flow.pendingDeepLink;
    if (deepLink) {
      this.flow.pendingDeepLink = null;
      this.pendingIntent = () => void this.processDeepLink(deepLink);
    }

    // 回到主菜单 = 房间已从玩家视角离开：清空平台邀请上下文（platform-seam §4）。
    // 房间页/选人页/对局各退出路径最终都会回到这里,此处统一清一次。
    reportInviteContext(this.flow, null);

    // 对局音频（切片 27）：主页 BGM（原版 MenuStage BGM(op)）
    audioOf(ctx.ctx)?.bgm('op');


    // 黑底（帧 PNG 未就绪时）
    const bg = new Graphics();
    bg.rect(0, 0, UI_W, UI_H).fill({ color: 0x000000 });
    root.addChild(bg);

    this.uiData = await loadUi(ctx.ctx);
    const t = this.uiData.title;

    // 时序纪律（2026-11-24，黑屏空窗治理）：贴图请求最先发（此刻连接池空闲），
    // 双板流其次（blob 预取与 UI 构建并行）；节点字/版本字在双板首帧就绪后才挂
    // （此前它们先于板纹理出现——黑屏期"节点比菜单动画先显示"）。
    const btnTex = {
      bg1: await Assets.load<Texture>(`${ASSETS}/${this.uiData.menu.elements.wzbtn_bg1}`),
      bg2: await Assets.load<Texture>(`${ASSETS}/${this.uiData.menu.elements.wzbtn_bg2}`),
    };

    // 原版：stg_title (0,0) 挂 800×600 舞台 → 帧 PNG 挂 舞台-stageOriginInFrame，裁剪到舞台矩形
    // 三层夹心（切片 46）：底板 → fx 叠加层 → 顶板，同屏同帧号。
    const clip = new Container();
    const mask = new Graphics();
    mask.rect(OX, 0, 800, 600).fill({ color: 0xffffff });
    clip.mask = mask;
    root.addChild(mask, clip);
    const platePos = [OX - t.stageOriginInFrame[0], -t.stageOriginInFrame[1]] as const;
    const frameSprite = new Sprite();
    frameSprite.position.set(platePos[0], platePos[1]);
    clip.addChild(frameSprite);
    this.frameSprite = frameSprite;
    // fx 层：keys 为 stg_title 局部（= 舞台）坐标，挂位自带 OX；裁剪进同一 mask
    this.fxLayer = new TitleFxLayer(t.fx.elements, t.fx.instances, [OX, 0]);
    clip.addChild(this.fxLayer.ui);
    this.fxLayer.preload();
    const topSprite = new Sprite();
    topSprite.position.set(OX - t.topStageOriginInFrame[0], -t.topStageOriginInFrame[1]);
    clip.addChild(topSprite);
    this.topSprite = topSprite;

    // 菜单按钮组（原版：intro 期间即构建，showBtns 时挂入并入场；skip 前不可见）
    const group = new Container();
    group.position.set(OX + this.uiData.menu.groupPos[0], this.uiData.menu.groupPos[1]);
    group.visible = false;
    this.menuGroup = group;
    root.addChild(group);
    this.buildMenuGroup(btnTex);

    // 流帧：底/顶双板同帧号锁步，预取头几帧后开播
    this.streams = [
      new FrameStream({ dir: t.dir, frames: t.frames, from: t.introFrom, to: t.menuStop }),
      new FrameStream({ dir: t.topDir, frames: t.frames, from: t.introFrom, to: t.menuStop }),
    ];
    for (const s of this.streams) s.ensure(t.introFrom, 5);
    await this.waitPlates(t.introFrom, 4);
    if (this.destroyed) return;
    this.applyPlates(t.introFrom);
    this.frame = t.introFrom;
    this.acc = 0;
    this.phase = 'intro';
    group.visible = false;

    // 版本字 + 节点状态块（DESIGN §6.2）：左下角三行左对齐，13px 统一字号
    //（2026-11-24 决策：版本缩为仅 "v X.X.X" 并与节点块并址左下；双色同族不割裂——
    //  节点两行浅蓝 0x8fd0ff，版本同族降饱和 0x6ea0cd。原版版本字在右下角黑色 18px，
    //  此处布局为自觉偏离，颜色随底色可读性定）。
    // 纯展示（2026-11-22 决策变更：取消玩家手动切换，无节点面板入口）。
    // 后台 selectNode 可能尚未完成，初始显示"检测中"；update 里低频刷新文本，
    // startNodeMonitor 周期探测写回最新 RTT。
    // 时序：双板首帧就绪后才构建（否则黑屏期先于菜单动画显示，2026-11-24）。
    const nodeLines = nodeStatusLines(this.flow, this.nodeManifest);
    const nodeTitle = makeLabel(nodeLines.title, { size: 13, color: 0x8fd0ff });
    const nodeLatency = makeLabel(nodeLines.latency, { size: 13, color: 0x8fd0ff });
    const version = makeLabel(VERSION, { size: 15, color: 0x6ea0cd, bold: true });
    const infoX = OX + 12;
    nodeTitle.position.set(infoX, UI_H - 66);
    nodeLatency.position.set(infoX, UI_H - 48);
    version.position.set(infoX, UI_H - 30);
    root.addChild(version, nodeTitle, nodeLatency);
    this.nodeTitle = nodeTitle;
    this.nodeLatency = nodeLatency;
    this.stopNodeMonitor = startNodeMonitor(this.flow, () => this.refreshNodeText());
    void loadManifest().then((m) => {
      if (this.destroyed) return;
      this.nodeManifest = m;
      this.refreshNodeText();
    });

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

    // 设置面板浮层：置于最顶层，打开时挡住下层菜单按钮的指针事件；
    // 原版底板（stg_set_ui）在此预载（Assets 缓存，回菜单零成本）
    const sd = this.uiData.setting;
    const art = async (file: string, origin: [number, number]) => ({
      tex: await Assets.load<Texture>(`${ASSETS}/${file}`),
      origin,
    });
    this.settingsOverlay = new SettingsOverlay(ctx, {
      plate: await art(`${sd.dir}/1.webp`, sd.stageOriginInFrame),
      txtArrow: await art(sd.arrows.txt_arrow.file, sd.arrows.txt_arrow.origin),
      selectArrow: await art(sd.arrows.select_arrow.file, sd.arrows.select_arrow.origin),
    });
    root.addChild(this.settingsOverlay.ui);

    // 联机浮层组（最顶层；半透明暗底，背景菜单动画透出不断）
    this.matchOverlay = new MatchOverlay(ctx, this.flow);
    this.roomOverlay = new RoomOverlay(ctx, this.flow);
    this.confirmOverlay = new ConfirmOverlay();
    this.netOverlays.push(this.matchOverlay, this.roomOverlay, this.confirmOverlay);
    for (const o of this.netOverlays) root.addChild(o.ui);

    window.addEventListener('keydown', this.onKey);

    // 会话内回到主菜单不重播开场（对局/选人/房间返回路径）；dev 自动意图同此
    if (menuIntroPlayed || this.auto) {
      this.skipEnabled = true;
      void this.skipIntro();
    }
  }

  update(dtMs: number): void {
    tickTweens(dtMs);
    for (const o of this.netOverlays) o.update(dtMs);
    // 输入位光标闪烁（约 2Hz 方波；连接态隐藏由 confirmJoin 置位）
    if (this.joinState === 'input' && this.joinCaret) {
      this.joinCaretAcc += dtMs;
      this.joinCaret.visible = Math.floor(this.joinCaretAcc / 480) % 2 === 0;
    }
    // 节点状态块低频刷新文本（选择完成/监控探测/切节点后由这里上屏）
    this.nodeRefreshAcc += dtMs;
    if (this.nodeRefreshAcc >= 500) {
      this.nodeRefreshAcc = 0;
      this.refreshNodeText();
    }
    if (!this.streams.length || !this.frameSprite || !this.uiData) return;
    const t = this.uiData.title;
    let plateAdvanced = false;
    let plateDelta = 0;
    if (this.phase === 'intro' || this.phase === 'menu-anim') {
      this.acc += dtMs;
      const from = this.phase === 'intro' ? t.introFrom : t.menuFrame;
      const stop = this.phase === 'intro' ? t.introStop : t.menuStop;
      const f = Math.min(stop, from + Math.floor((this.acc * t.fps) / 1000));
      if (f !== this.frame) {
        const btex = this.streams[0]!.get(f);
        const ttex = this.streams[1]!.get(f);
        // 双板纹理齐才推进（顶板失败帧视为已过，与底板同语义防卡死）
        if (btex && (ttex || this.streams[1]!.failed(f))) {
          // 纹理就绪才推进（sprite 始终显示 this.frame 的纹理，release 窗口才是安全的）
          plateDelta = f - this.frame;
          this.frame = f;
          this.frameSprite.texture = btex;
          if (ttex) this.topSprite!.texture = ttex;
          plateAdvanced = true;
        } else if (this.streams[0]!.failed(f)) {
          this.frame = f; // 失败帧视为已过（保持上一帧画面；与 logo 场景同语义，防卡死）
        } else {
          // 停帧等待：回退本次累积，播放头冻结在 frame+1。若放任 acc 累积，
          // f 会冲到 stop，ensure(f,4) 预取的远端帧落在 release 常驻窗之外
          // （加载完即销毁→重取风暴→连接池饿死 frame+1 → 永久停帧；高延迟部署必现）
          this.acc -= dtMs;
          for (const s of this.streams) s.ensure(this.frame + 1, 4);
        }
      }
      // menu 段播完定格（intro 段定格仍留在 'intro' 等点击，原版帧脚本 stop 语义）
      if (this.phase === 'menu-anim' && this.frame >= stop) this.phase = 'menu';
      // 常驻窗口：身后 2 帧、身前 6 帧
      for (const s of this.streams) {
        s.release((i) => i >= this.frame - 2 && i <= this.frame + 6);
        s.ensure(this.frame + 1, 4); // 持续预取身前帧
      }
    }
    // fx 叠加层**全 phase** 推进：板推进时按板帧同步走；定格（intro/menu）/跳过等待
    // 期板帧不动 → 按墙时走（原版嵌套 clip 一经放置持续走带，menu 态循环正是本切片目标）
    this.fxLayer?.update(this.frame, dtMs, plateAdvanced, plateDelta);
  }

  exit(): void {
    this.destroyed = true;
    this.joinCapture?.dispose();
    this.joinCapture = null;
    for (const o of this.netOverlays) o.dispose();
    this.netOverlays.length = 0;
    this.stopNodeMonitor?.();
    this.stopNodeMonitor = null;
    window.removeEventListener('keydown', this.onKey);
    for (const id of this.timers) window.clearTimeout(id);
    clearTweens();
    for (const s of this.streams) s.dispose();
    this.streams = [];
    this.fxLayer?.dispose();
    this.fxLayer = null;
  }

  // ---------- 流程 ----------

  /** 节点状态块文本刷新（nodeStatusLines → 两行 Text，变化才写）。 */
  private refreshNodeText(): void {
    if (!this.nodeTitle || !this.nodeLatency) return;
    const lines = nodeStatusLines(this.flow, this.nodeManifest);
    if (this.nodeTitle.text !== lines.title) this.nodeTitle.text = lines.title;
    if (this.nodeLatency.text !== lines.latency) this.nodeLatency.text = lines.latency;
  }

  private async skipIntro(): Promise<void> {
    if (!this.skipEnabled || !this.uiData || this.phase !== 'intro') return;
    this.skipEnabled = false;
    this.phase = 'skipping'; // 等待 menu 帧加载期间暂停推进/释放
    const t = this.uiData.title;
    await this.waitPlates(t.menuFrame, 5);
    if (this.destroyed) return;
    this.acc = 0;
    this.frame = t.menuFrame;
    this.applyPlates(t.menuFrame);
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
          if (!this.destroyed) this.enableMenu();
        }, 400),
      );
    }
  }

  private async waitPlates(first: number, ahead: number): Promise<void> {
    // 轮询等待双板首帧纹理可用（load 完成即 resolve）
    for (;;) {
      let ready = true;
      for (const s of this.streams) {
        s.ensure(first, ahead);
        if (!s.get(first) && !s.permanentlyFailed(first)) ready = false;
      }
      // 首帧达重试上限仍失败：放弃等待（enter 处有 Texture.WHITE 回退），防永久卡死
      if (this.destroyed || ready) return;
      await new Promise((r) => window.setTimeout(r, 50));
    }
  }

  /** 双板纹理应用（进入/跳段落时；纹理未就绪的板保留上一画面）。 */
  private applyPlates(f: number): void {
    const btex = this.streams[0]?.get(f);
    const ttex = this.streams[1]?.get(f);
    if (btex && this.frameSprite) this.frameSprite.texture = btex;
    if (ttex && this.topSprite) this.topSprite.texture = ttex;
  }

  // ---------- 按钮组（MenuBtnGroup 语义） ----------

  private buildMenuGroup(tex: { bg1: Texture; bg2: Texture }): void {
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
            action: () => this.openCreate(),
          },
          {
            en: 'JOIN ROOM',
            cn: '加入房间',
            action: () => this.startJoinInput(),
          },
          {
            en: 'QUICK MATCH',
            cn: '随机匹配',
            // 强制服务器（?server=/手填）禁随机匹配：不可信服能伪造对端输入/改种子
            disabled: this.flow.serverForced,
            action: () => this.openMatch(),
          },
        ],
      },
      {
        en: 'SETTING',
        cn: '游戏设置',
        action: () => this.openSettings(),
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
          cb.disabled = c.disabled === true;
          if (c.en === 'JOIN ROOM') this.joinBtn = cb;
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
    if (!this.menuEnabled || btn.disabled) return;
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
    const list = this.childOpen ? this.childOpen.children! : this.btns;
    // 置灰项不可导航（悬停/回车均跳过）
    return list.filter((b) => !b.disabled);
  }

  // ---------- 设置面板 ----------

  private openSettings(): void {
    if (this.settingsOpen || !this.settingsOverlay) return;
    this.settingsOpen = true;
    // selectBtn 已置 menuEnabled=false；关闭浮层时恢复菜单导航
    this.settingsOverlay.open(() => {
      this.settingsOpen = false;
      this.menuEnabled = true;
    });
  }

  /** 随机匹配浮层：同上。 */
  private openMatch(): void {
    if (!this.matchOverlay || this.netOverlay) return;
    this.flow.mode = 'net';
    this.matchOverlay.open(() => {
      this.menuEnabled = true;
    });
  }

  /** 创建房间：房间浮层内直连（浮层间至多一个开启）。 */
  private openCreate(): void {
    if (!this.roomOverlay || this.netOverlay) return;
    this.flow.mode = 'net';
    this.roomOverlay.openAsCreate(() => {
      this.menuEnabled = true;
    });
  }

  /** dev 直通意图：菜单就绪（键盘可操作）后自动执行一次。 */
  private runAutoIntent(): void {
    const a = this.auto;
    if (!a) return;
    this.auto = null;
    if (a.action === 'match') {
      this.openMatch();
      this.matchOverlay?.autoStart();
    } else if (a.action === 'join') {
      this.startJoinInput(a.room);
    } else {
      this.openCreate();
    }
  }

  /** 菜单就绪统一入口（开场跳过动画后 400ms）：置可操作并消费自动意图。 */
  private enableMenu(): void {
    this.menuEnabled = true;
    // 开场已消费（会话内回菜单不再重播）
    menuIntroPlayed = true;
    this.runAutoIntent();
    const intent = this.pendingIntent;
    this.pendingIntent = null;
    intent?.();
  }

  // ---------- 跨节点加入（DESIGN §6.2） ----------

  /**
   * 深链 `?room=&node=`：目标节点不可用 → 提示框（不得静默回退当前节点误报
   * 房不存在）；与当前节点一致 → 直接自动加入；不同 → 确认框，确认后锁定
   * 切换（resolveJoinNode 写 manual 意图）再自动加入，取消则留在菜单。
   */
  private async processDeepLink(intent: { room: string; node: string }): Promise<void> {
    const manifest = await loadManifest();
    const target = manifest.nodes.find((n) => n.id === intent.node && n.enabled);
    const current = manifest.nodes.find((n) => n.url === this.flow.serverUrl);
    if (target && current && current.id === target.id) {
      this.startJoinInput(intent.room);
      return;
    }
    if (!target) {
      this.confirmOverlay?.openConfirm(
        '节点不可用',
        `该房间所在节点「${intent.node}」不可用，无法加入`,
        null,
        () => {
          this.menuEnabled = true;
        },
      );
      return;
    }
    this.confirmOverlay?.openConfirm(
      '跨节点加入',
      `该房间在「${target.name}」节点，切换节点并加入？`,
      () => {
        void resolveJoinNode(this.flow, intent.room, intent.node).then(() => {
          this.startJoinInput(intent.room);
        });
      },
      () => {
        this.menuEnabled = true;
      },
    );
  }

  // ---------- 「加入房间」原位变身（无浮层：子项按钮即输入位） ----------

  /** 点击子项：翻转变身成输入位（板面显示房码），冻结菜单其余按钮。 */
  private startJoinInput(prefill?: string): void {
    if (this.joinState !== 'off' || this.netOverlay || !this.joinBtn) return;
    this.flow.mode = 'net';
    this.joinState = 'input';
    this.menuEnabled = false;
    this.joinPrefill = prefill ?? null;
    this.freezeMenu(this.joinBtn, true);
    const btn = this.joinBtn;
    // 翻转变身：scale.x 压扁 → 换内容（板面变输入位）→ 展开
    tweenOf(btn.ui, { 'scale.x': 0.06 }, 140, {
      ease: (k) => k,
      done: () => {
        if (this.joinState === 'off') return;
        this.syncJoinDigits('');
        this.joinCaret = new Graphics();
        this.joinCaret.rect(0, 0, 3, 24).fill({ color: 0xffffff });
        this.joinCaret.visible = false;
        btn.ui.addChild(this.joinCaret);
        this.positionJoinCaret();
        this.remountJoinCapture();
        tweenOf(btn.ui, { 'scale.x': 1 }, 140, {
          ease: (k) => k,
          done: () => {
            const p = this.joinPrefill;
            if (p !== null) {
              this.joinPrefill = null;
              if (this.joinCapture) this.joinCapture.digits = p;
              this.confirmJoin();
            }
          },
        });
      },
    });
  }

  /** 键盘路由到输入位（采集输入失焦/未聚焦时的兜底路径）。 */
  private routeJoinKey(e: KeyboardEvent): void {
    const cap = this.joinCapture;
    if (!cap) return;
    const k = e.key;
    if (k === 'Escape') {
      e.preventDefault();
      this.cancelJoin();
    } else if (/^[0-9]$/.test(k)) {
      e.preventDefault();
      if (this.joinDigits.length < 6) cap.digits = this.joinDigits + k;
      cap.focus();
    } else if (k === 'Backspace') {
      e.preventDefault();
      if (this.joinDigits.length > 0) cap.digits = this.joinDigits.slice(0, -1);
      cap.focus();
    } else if (k === 'Enter' || k === ' ' || k === 'j' || k === 'J') {
      e.preventDefault();
      this.confirmJoin();
    }
  }

  /** 板面文本同步（空态 = 占位提示）+ 光标重定位到文字末端。 */
  private syncJoinDigits(d: string): void {
    this.joinDigits = d;
    this.joinBtn?.setLabel(d.length > 0 ? d : 'ROOM CODE', d.length === 0);
    this.positionJoinCaret();
  }

  /** 光标钉在板面文字末端（随 Text 宽度重算）。 */
  private positionJoinCaret(): void {
    const caret = this.joinCaret;
    if (!caret || !this.joinBtn) return;
    const a = this.joinBtn.caretAnchor();
    caret.position.set(a.x, a.y);
  }

  /** 回车确认：输满 6 位才入房；位数不足与失败都走弹窗（不上按钮）。 */
  private confirmJoin(): void {
    if (this.joinState !== 'input') return;
    const room = this.joinDigits;
    if (room.length < 6) {
      this.openJoinErrorPopup('请输满 6 位房码');
      return;
    }
    this.joinState = 'connecting';
    this.joinCapture?.dispose();
    this.joinCapture = null;
    this.joinBtn?.setLabel('JOINING…');
    if (this.joinCaret) this.joinCaret.visible = false;
    const seq = ++this.joinSeq;
    void enterRoom(this.flow, 'join', room).then(
      ({ socket }) => {
        if (seq !== this.joinSeq) {
          // 连接期间已收回/取消：不入房，收掉连接
          socket.close();
          return;
        }
        this.cleanupJoinInput();
        // 上报平台邀请上下文：本端已处于可被邀请加入的房间（platform-seam §4）
        reportInviteContext(this.flow, { room: this.flow.room, node: this.flow.nodeInfo?.nodeId ?? '' });
        this.roomOverlay?.openWithSocket(socket, () => {
          this.menuEnabled = true;
        });
      },
      (e: unknown) => {
        if (seq !== this.joinSeq) return;
        this.joinState = 'input';
        this.openJoinErrorPopup(roomErrorText(e));
      },
    );
  }

  /** 模态错误弹窗：撤下采集输入（弹窗键盘独占），关闭后回输入态重新聚焦。 */
  private openJoinErrorPopup(text: string): void {
    this.joinCapture?.dispose();
    this.joinCapture = null;
    this.confirmOverlay?.openConfirm('无法加入', text, null, () => {
      if (this.joinState !== 'input') {
        this.menuEnabled = true;
        return;
      }
      this.remountJoinCapture();
    });
  }

  private remountJoinCapture(): void {
    this.joinCapture = new CodeCapture(
      this.ctx!.domHost,
      (d) => this.syncJoinDigits(d),
      () => this.confirmJoin(),
      () => this.cancelJoin(),
    );
    this.joinCapture.mount();
    this.joinCapture.digits = this.joinDigits; // 回显板上已输数字
  }

  /** Esc 收回（输入态）：变回按钮，恢复菜单。 */
  private cancelJoin(): void {
    if (this.joinState !== 'input') return;
    this.joinState = 'off';
    this.cleanupJoinInput();
    this.menuEnabled = true;
  }

  /** Esc（连接态）：作废在途连接，回输入态保留已输房码。 */
  private cancelConnecting(): void {
    if (this.joinState !== 'connecting') return;
    this.joinSeq++; // 在途完成回调作废
    this.joinState = 'input';
    this.remountJoinCapture();
  }

  /** 变身态清理：拆采集、还原按钮文本/光标/其余按钮。 */
  private cleanupJoinInput(): void {
    this.joinSeq++;
    this.joinCapture?.dispose();
    this.joinCapture = null;
    this.joinDigits = '';
    this.joinBtn?.setLabel(this.joinBtn.entry.en);
    this.joinCaret?.destroy();
    this.joinCaret = null;
    this.freezeMenu(this.joinBtn, false);
  }

  /** 菜单其余按钮冻结/解冻（变身输入位期间防多点开、防 hover 抢板）。 */
  private freezeMenu(except: MenuBtn | null, frozen: boolean): void {
    const apply = (b: MenuBtn): void => {
      if (b === except) return;
      b.ui.alpha = frozen ? 0.45 : b.disabled ? 0.45 : 1;
      b.ui.eventMode = frozen ? 'none' : 'static';
      b.ui.cursor = frozen ? 'default' : 'pointer';
      if (frozen) b.normal();
    };
    for (const b of this.btns) {
      apply(b);
      for (const cb of b.children ?? []) apply(cb);
    }
  }

  private handleKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const k = e.key;
    if (this.phase === 'intro') {
      // 原版 GameInputer.anyKey：任意键跳过
      this.skipIntro();
      return;
    }
    if (this.settingsOpen) {
      // 浮层打开期间键盘由设置面板接管
      this.settingsOverlay?.handleKey(e);
      return;
    }
    if (this.netOverlay) {
      // 浮层打开期间键盘由联机浮层接管
      this.netOverlay.handleKey(e);
      return;
    }
    if (this.joinState === 'input') {
      // 变身输入位接管键盘（采集输入有焦点时经 capture 自身监听，此处为兜底）
      this.routeJoinKey(e);
      return;
    }
    if (this.joinState === 'connecting') {
      // 连接期仅 Esc 可收（作废在途连接，回输入态）
      if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelConnecting();
      }
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
