/**
 * 选人场景（切片 14 骨架 → 切片 15 原版化换肤 → 切片 35 联机双光标）。
 *
 * 演出照原版 SelectFighterStage 规格：
 *  - 原版 800×600 舞台在 1000×600 逻辑屏横向居中（OX=100）；
 *  - 头像格：slt_item 60×60 框，50×50 头像垫底于框下，网格起点 (15,100)、
 *    列距 80、行距 = (600-50-100-10)/(行数-1)，offset 为原版像素微调；
 *  - 光标（P1 蓝/P2 粉）hover 跟随，PNG 原点 = 格子位 + (-18,-26)；
 *  - 已选展示框（大头像 245×62 + 名字）在底部两角，P2 内容容器镜像；团队模式随锁定
 *    逐次堆叠成 3 个框（旧框上移/缩小/变暗，原版 SelectedFighterGroup）；
 *  - 地图选择 = 原版轮盘：select_map 面板 + 左右箭头 + 缩略图 + kuang 框叠顶，
 *    点缩略图即确认（原版语义），random 项确认时解析；
 *  - 格子演出（切片 29 菜单流打磨，原版 SelectFighterStage.buildList/fadOutList/initMap）：
 *    入场 = 各格从舞台中心 scale 0→1 到落位，0.3s Back.easeOut，delay 随机 0..0.2s；
 *    退场 = 各格回中心 scale→0，0.2s，delay 随机 0..0.1s，0.3s 后换阶段；
 *    地图面板 = 中心 scale 0→1，0.3s Back.easeOut。
 *
 * 联机双光标（切片 35，规格 docs/netplay-design.md §7；solo 流不受影响）：
 *  - 复刻原版本地双人"双光标各自操作互不阻塞"，从同一台键盘搬到两台客户端：
 *    本端光标跟随本端鼠标 hover，变更即 cursor 广播（轻量覆盖消息）；
 *  - 选中即锁：点击即锁定、无反悔；随机项此刻解析成具体角色后按最终项同步；
 *    锁满本端份额后本端光标冻结、点击忽略；
 *  - 双方齐套本地推导推进（角色 → 援助 → 地图），判定输入一致结果一致；
 *  - 团队模式：每光标连续锁 3 名角色（selectTimesCount = 3）再进援助（1 名）；
 *    跨玩家同角色允许（镜像对决合法）；同一玩家自身 3 槽位不得重复（2026-11-22 对齐原版 isSelected）；
 *  - pick 覆盖式累计上行（3s 重发兜底幂等）；地图尾沿用最终 pick（map 仅 P1，
 *    P2 收到即移交加载页）；
 *  - 消息泵：socket.onmessage 常驻接管（cursor/pick/map-pick/seed/peer-lost 分派），
 *    断线按 netplay-design §10 提示后回主菜单。
 *
 * 地图阶段（切片 36 建；2026-11-21 收缩，规格 docs/netplay-design.md §8）：
 *  - 好友房（mapSelect=true）：仅房主选择页一种形态——房主轮盘可操作，每次切换
 *    map-pick 广播；客座只读面板实时跟随（轮盘同款渲染、无交互），房主确认走
 *    最终 pick.map（"？"随机项确认时由房主解析成具体 id）；
 *  - 匹配（mapSelect=false）：无地图阶段——援助选满直接进加载页，对局地图由
 *    权威 seed 按 maps[seed % n] 解析（matched 携带，两端同种子天然一致，
 *    兼作对局 sim seed 进 configHash）；开箱抽取动画随 randomMap 设置整体下线；
 *  - 默认选中项 = "？"随机场景（原版 map.xml random 首项实位，mapIndex 0）。
 *
 * 本地双人（切片 39；复刻原版 isVsPeople() 语义，同一台键盘搬回来）：
 *  - 双光标各自键盘驱动：P1 = WASD 移动 + J 确认；P2 = 方向键移动 + 小键盘 1 确认；
 *    互不阻塞；鼠标不参与选人（一台机器只有一个鼠标，留到地图轮盘共用）；
 *  - 复用联机双光标的状态结构（localLocked = P1 / peerLocked = P2）与锁定推进，
 *    仅去掉网络收发；地图阶段 = solo 鼠标轮盘 + P1 键盘（A/D 翻页、J 确认）；
 *  - 选中即锁无反悔（同联机）；随机项确认时解析；双方齐套本地推导推进。
 *
 * 骨架期限制（记录，切片 14 沿用）：
 *  - 原版 more= 形态切换未实现（数据保留，more= 项格框黄色提示）；
 */
import { Assets, Container, Graphics, Rectangle, Sprite, Text, Texture } from 'pixi.js';
import {
  sendCursor,
  sendMapPick,
  sendPick,
  type LockedPicks,
  type NetMessage,
  type PickInfo,
  type WsLike,
} from '@bvn/net';
import type { Scene, SceneCtx } from './scene.js';
import { audioOf } from '../audio.js';
import { tweenOf, tickTweens, clearTweens } from '../anim.js';
import { makeButton, makeLabel, makePanel, selectedFaceMask, UI_H, UI_W } from '../ui.js';
import {
  ASSETS,
  loadSelect,
  loadUi,
  uiFaceUrl,
  type SelectData,
  type SelectEntry,
  type UiData,
  type UiSelectData,
} from '../data.js';
import type { Flow, Pick } from '../flow.js';
import { OverlayFx } from './fx.js';
import { LoadingScene } from './loading.js';
import { MenuScene } from './menu.js';
import { NetScene } from './net.js';
import { transIn, clearTrans } from './trans.js';

/** 原版舞台 800×600 在 1000×600 逻辑屏中的横向偏移。 */
const STAGE_W = 800;
const OX = (UI_W - STAGE_W) / 2;

/** 展示框（大头像 + 名字）引用。root/baseY 供原版堆叠上移/缩小/变暗用。 */
interface BoxRefs {
  root: Container;
  baseY: number;
  face: Sprite;
  name: Text;
}

export class SetupScene implements Scene {
  readonly name = 'setup';

  private select: SelectData | null = null;
  private uiData: UiData | null = null;
  private phase: 'fighter' | 'assist' | 'map' | 'exchange' = 'fighter';
  private fighter: SelectEntry | null = null;
  private assist: SelectEntry | null = null;
  private mapId: string | null = null;
  /** 已完成地图选择（含选择"随机地图"；联机 P2 恒 false） */
  private mapChosen = false;
  private phaseRoot: Container | null = null;
  private status: Text | null = null;
  private ui: Container | null = null;
  private resendTimer = 0;
  /** 异步装料守卫（阶段切换后丢弃旧装料） */
  private loadToken = 0;
  /** 场景 ctx（地图点击确认推进流程用；enter 时注入） */
  private ctxRef: SceneCtx | null = null;
  /** 地图轮盘游标 */
  private mapIndex = 0;
  /** select 元件纹理（enter 预载） */
  private tex: Record<string, Texture> = {};
  /** 切片 45：旋涡叠加层（enter 建立常驻）；地图面板 fx（renderMaps 逐次建，随阶段销毁） */
  private vortexFx: OverlayFx | null = null;
  private mapFxPlayers: OverlayFx[] = [];
  /** 光标精灵（fighter/assist 阶段跟随 hover） */
  private cursor: Sprite | null = null;
  /** 对端光标精灵（联机双光标；solo 为 null） */
  private peerCursor: Sprite | null = null;
  /** 本端光标当前格子下标（变更检测，cursor 广播去重） */
  private hoverIdx: number | null = null;
  /** 对端光标当前格子下标（null = 尚未收到） */
  private peerCursorIdx: number | null = null;
  /** 每方已选展示框栈（原版 SelectedFighterGroup：锁定后旧框上移变暗、新框叠在下方；
   *  own = 本端，peer = 对端/本地 P2；solo 仅 own） */
  private boxOwn: BoxRefs[] = [];
  private boxPeer: BoxRefs[] = [];
  /** 当前阶段格子（演出退场动画用；含地图面板） */
  private animCells: { c: Container; x: number; y: number }[] = [];

  // —— 联机双光标状态（切片 35；solo 不用）——
  /** 本端累计锁定（按次序；fighter 段 / assist 段分列，随机项存解析后条目） */
  private localLocked: { fighters: SelectEntry[]; assists: SelectEntry[] } = {
    fighters: [],
    assists: [],
  };
  /** 对端累计锁定 id（联机 = pick 覆盖式快照；本地双人 = P2 锁定按次序） */
  private peerLocked: { fighters: string[]; assists: string[] } = { fighters: [], assists: [] };

  // —— 本地双人双键盘（切片 39）——
  /** 键盘导航列表（当前阶段格子按 row,col 排序；与渲染 entries 同源） */
  private navList: SelectEntry[] = [];  /** 光标下标（navList 序；P1/P2 各一份，0 = 首格） */
  private keyIdxP1 = 0;
  private keyIdxP2 = 0;
  /** 阶段 token：renderPhase 递增，navList 就绪时登记——两者相等才接受键盘输入
   *  （异步装料/过渡窗内 navList 尚为旧阶段数据） */
  private navToken = 0;
  private navListToken = -1;
  /** 地图轮盘缩略图（键盘翻页重绘用；null = 非地图阶段/未就绪） */
  private mapPicSprite: Sprite | null = null;
  private readonly onKeyLocal = (e: KeyboardEvent) => this.handleLocalKey(e);
  /** 连接已断（§10：提示后回主菜单，只触发一次） */
  private netDead = false;
  /** 已移交加载页（消息泵停止） */
  private done = false;
  /** 离场定时器（断线回菜单） */
  private readonly timers: number[] = [];

  constructor(
    private readonly flow: Flow,
    /** 联机 socket（net 场景交接；solo/local 省略） */
    private readonly socket: WsLike | null = null,
  ) {}

  async enter(ctx: SceneCtx): Promise<void> {
    this.ctxRef = ctx;
    clearTrans(); // 原版 SelectFighterStage.build → clearTrans：清残留黑幕（异常退场等）
    // 非 net 流（solo/local 直进）：清联机会话残留（地图阶段/种子归联机会话）
    if (this.flow.mode !== 'net') {
      this.flow.mapSelect = true;
      this.flow.mapSeed = null;
    }
    // 对局音频（切片 27）：选人页 BGM（原版 SelectFighterStage BGM(select)）
    audioOf(ctx.ctx)?.bgm('select');
    const ui = new Container();
    this.ui = ui;
    ctx.root.addChild(ui);

    this.select = await loadSelect(ctx.ctx);
    this.uiData = await loadUi(ctx.ctx);
    // 空连接兜底（solo 直进/数据缺失时仍有最小集）
    if (this.select.chars.length === 0) throw new Error('select.json 为空：先跑 tools/select-pack');

    // select 场景壳元件预载
    const el = this.uiData.select.elements;
    const pairs = await Promise.all(
      Object.entries(el).map(async ([k, url]) => [k, await Assets.load<Texture>(`${ASSETS}/${url}`)] as const),
    );
    this.tex = Object.fromEntries(pairs);

    // 原版背景（800×600 居中）。切片 45：旋涡（sprite 72 内嵌 71，105 帧循环）FFDec 冻结
    // 烘不进底板 → 干净底板只剩顶部横幅，旋涡叠加层垫在其下（原版 d1 bg < d3 横幅）；
    // 红通道烘焙期清零 = 放置 redAdd −255 精确等价
    if (this.uiData.select.vortex) {
      const v = this.uiData.select.vortex;
      this.vortexFx = new OverlayFx(v, () => ({
        x: OX + v.pos[0],
        y: v.pos[1],
        sx: v.scale[0],
        sy: v.scale[1],
        alpha: 1,
      }));
      this.vortexFx.preload();
      ui.addChild(this.vortexFx.ui);
    }
    const bg = new Sprite(this.tex.stg_select!);
    bg.position.set(OX, 0);
    ui.addChild(bg);

    const title = makeLabel(
      this.flow.mode === 'net' ? `选人（房间 ${this.flow.room}）` : '选人',
      { size: 24, bold: true },
    );
    title.position.set(OX + 12, 20);
    ui.addChild(title);

    const status = makeLabel('', { size: 15, color: 0xffd54f });
    status.position.set(OX + 14, 56);
    this.status = status;
    ui.addChild(status);

    // 返回主菜单 = 原版语义：无按钮，ESC 呼出确认框（GameInputer.back → GameUI.confirm
    // "BACK TITLE"；切片 41 移除自加的右上角按钮）
    window.addEventListener('keydown', this.onKeyBack);

    this.renderPhase(ctx);

    // 联机：接管 socket 消息泵（BufferedSocket 空窗期缓冲在接管时补交；
    // 数据装载完成后才接管，泵内 stageList 等依赖 select 数据）
    if (this.socket) {
      this.socket.onmessage = (ev) => this.onNetMessage(ev);
      this.socket.onclose = () => this.onNetDown();
    }

    // 本地双人：双键盘监听（双光标移动/确认；ESC/RESELECT 走全模式共用的 onKeyBack）
    if (this.flow.mode === 'local') {
      window.addEventListener('keydown', this.onKeyLocal);
    }

    // dev 直通：自动确认默认选人（ichigo/gaara/KonohaMura）
    if (this.flow.autoPick) this.autoConfirm(ctx);
  }

  /** dev 直通：免点击走完 选角色→选辅助→（地图）→开打。 */
  private autoConfirm(ctx: SceneCtx): void {
    if (this.flow.mode === 'net') return this.autoConfirmNet(ctx);
    if (this.flow.mode === 'local') return this.autoConfirmLocal(ctx);
    const byId = (list: SelectEntry[], id: string) => list.find((e) => e.id === id) ?? list[0]!;
    this.fighter = byId(this.select!.chars, 'ichigo');
    this.assist = byId(this.select!.assists, 'gaara');
    this.status!.text = `角色：${this.fighter.name}  辅助：${this.assist.name}`;
    this.mapId = 'KonohaMura';
    this.mapChosen = true;
    this.startSolo(ctx);
  }

  /** dev 直通（本地双人）：双方默认选人 → 默认地图开打。 */
  private autoConfirmLocal(ctx: SceneCtx): void {
    const need = this.flow.team ? 3 : 1;
    const ids = ['ichigo', 'naruto', 'sasuke'].slice(0, need);
    const byId = (list: SelectEntry[], id: string) => list.find((e) => e.id === id) ?? list[0]!;
    this.localLocked.fighters = ids.map((id) => byId(this.select!.chars, id));
    this.localLocked.assists = [byId(this.select!.assists, 'gaara')];
    this.peerLocked = {
      fighters: this.localLocked.fighters.map((e) => e.id),
      assists: this.localLocked.assists.map((e) => e.id),
    };
    this.mapId = 'KonohaMura';
    this.mapChosen = true;
    this.startLocal(ctx);
  }

  /** dev 直通（联机）：免点击走完累计锁定；好友房 P1 直接确认默认地图进交换等待，
   *  匹配路径（无地图阶段）两端直接收尾进加载页。 */
  private autoConfirmNet(ctx: SceneCtx): void {
    const need = this.flow.team ? 3 : 1;
    const ids = ['ichigo', 'naruto', 'sasuke'].slice(0, need);
    const byId = (list: SelectEntry[], id: string) => list.find((e) => e.id === id) ?? list[0]!;
    this.localLocked.fighters = ids.map((id) => byId(this.select!.chars, id));
    this.localLocked.assists = [byId(this.select!.assists, 'gaara')];
    // 对端快照先按本端镜像占位（真机对端 pick 到达后覆盖）
    this.peerLocked = {
      fighters: this.localLocked.fighters.map((e) => e.id),
      assists: this.localLocked.assists.map((e) => e.id),
    };
    this.commitPicks();
    if (!this.flow.mapSelect) {
      // 匹配路径（两端）：无地图阶段，权威 seed 本地解析后直接移交
      this.finishNetNoMap(ctx);
    } else if (this.flow.player === 1) {
      this.mapId = 'KonohaMura';
      this.mapChosen = true;
      this.netMapConfirmed(ctx);
    } else {
      // 好友房客座：地图阶段由消息泵驱动（map-pick 跟随房主切换）
      this.phase = 'map';
      this.renderPhase(ctx);
    }
  }

  private back(ctx: SceneCtx): void {
    const { switchTo } = ctx;
    if (this.flow.mode === 'net') {
      this.socket?.close();
      switchTo(new NetScene(this.flow));
    } else {
      switchTo(new MenuScene(this.flow));
    }
  }

  // ---------- 确认框（原版 GameUI.confirm 语义：模态遮罩 + 确认/取消；切片 41） ----------

  private confirmBox: Container | null = null;

  /** 原版 SelectFighterStage.render：back 键 = 对话框开着先关，否则弹 BACK TITLE 确认；
   *  P1 跳键 = RESELECT 确认重进选人（单机/本地；net 选中即锁无反悔，不提供）。 */
  private readonly onKeyBack = (e: KeyboardEvent) => this.handleKeyBack(e);

  private handleKeyBack(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (this.done || this.destroyedFlag || !this.ctxRef) return;
    if (e.code === 'Escape') {
      e.preventDefault();
      if (this.confirmBox) return this.closeConfirm();
      this.showConfirm('BACK TITLE', '返回到主菜单？', () => this.back(this.ctxRef!));
    } else if (e.code === 'KeyK' && this.flow.mode !== 'net' && !this.confirmBox) {
      // 原版 GameInputer.jump(P1) → RESELECT（K = P1 跳键，同 battle KEYMAP_P1）
      this.showConfirm('RESELECT', '重新选择？', () => {
        const ctx = this.ctxRef;
        if (ctx) ctx.switchTo(new SetupScene(this.flow));
      });
    }
  }

  private showConfirm(title: string, text: string, onYes: () => void): void {
    if (this.confirmBox || !this.ui) return;
    const box = new Container();
    const mask = new Graphics();
    mask.rect(0, 0, UI_W, UI_H).fill({ color: 0x000000, alpha: 0.55 });
    mask.eventMode = 'static'; // 模态：阻断下层点击
    box.addChild(mask);
    const panel = makePanel(360, 150);
    panel.position.set(UI_W / 2 - 180, UI_H / 2 - 100);
    box.addChild(panel);
    const t = makeLabel(title, { size: 18, bold: true, color: 0xffd54f });
    t.position.set(UI_W / 2 - t.width / 2, UI_H / 2 - 75);
    const msg = makeLabel(text, { size: 16 });
    msg.position.set(UI_W / 2 - msg.width / 2, UI_H / 2 - 40);
    const yes = makeButton('确认', () => {
      this.closeConfirm();
      onYes();
    }, { w: 110, h: 36, size: 15 });
    yes.position.set(UI_W / 2 - 125, UI_H / 2 + 15);
    const no = makeButton('取消', () => this.closeConfirm(), { w: 110, h: 36, size: 15 });
    no.position.set(UI_W / 2 + 15, UI_H / 2 + 15);
    box.addChild(t, msg, yes, no);
    this.ui.addChild(box);
    this.confirmBox = box;
  }

  private closeConfirm(): void {
    this.confirmBox?.destroy({ children: true });
    this.confirmBox = null;
  }

  // ---------- 阶段渲染 ----------

  private renderPhase(ctx: SceneCtx): void {
    this.loadToken++;
    this.navToken++;
    this.mapPicSprite = null;
    this.cursor = null;
    this.peerCursor = null;
    this.peerCursorIdx = null;
    this.boxOwn = [];
    this.boxPeer = [];
    clearTweens(); // 旧阶段格子的退场补间随 phaseRoot 销毁一并作废
    this.phaseRoot?.destroy({ children: true });
    this.clearMapFx(); // 地图 fx 是 phaseRoot 子节点：随容器销毁后不可再留在 update 表
    const root = new Container();
    this.phaseRoot = root;
    this.ui!.addChild(root);

    if (this.status) this.status.text = '';
    const net = this.flow.mode === 'net';

    // 点击即选中（原版语义：点格子即锁定推进，无确认按钮）。

    if (this.phase === 'fighter') {
      this.renderGrid(root, this.select!.chars, (e) => {
        if (net) this.lockEntry(ctx, e);
        else {
          this.fighter = e;
          this.status!.text = `角色：${e.name}`;
          this.onConfirm(ctx); // 点击即选中并进入辅助选择
        }
      });
    } else if (this.phase === 'assist') {
      this.renderGrid(root, this.select!.assists, (e) => {
        if (net) this.lockEntry(ctx, e);
        else {
          this.assist = e;
          this.status!.text = `辅助：${e.name}`;
          this.onConfirm(ctx); // 点击即选中并进入地图选择
        }
      });
    } else if (this.phase === 'map') {
      if (net && this.flow.player === 2) {
        // 客座只读（好友房）：map-pick 广播实时跟随房主切换
        this.renderMaps(root, { interactive: false });
        if (this.status) this.status.text = '等待房主选择地图…';
      } else {
        this.renderMaps(root, { interactive: true });
        if (net) {
          // 房主（切片 36）：进图阶段即广播当前项（客座初始对齐），此后每次切换随发
          this.sendMapPickSafe(this.currentMapKey());
        }
      }
    } else {
      // exchange：联机交换等待（本端最终 pick 已上行，等对端确认）
      if (net && this.status) this.status.text = '等待对手就绪…';
    }
  }

  private onConfirm(ctx: SceneCtx): void {
    if (this.transitioning) return; // 阶段切换演出中忽略点击（防连点二次推进）
    if (this.phase === 'fighter') {
      if (!this.fighter) {
        this.status!.text = '请先选择角色';
        return;
      }
      this.phase = 'assist';
      this.transitionPhase(ctx, () => this.renderPhase(ctx));
    } else if (this.phase === 'assist') {
      if (!this.assist) {
        this.status!.text = '请先选择辅助';
        return;
      }
      this.phase = 'map';
      this.transitionPhase(ctx, () => this.renderPhase(ctx));
    } else if (this.phase === 'map') {
      if (!this.mapChosen) {
        this.status!.text = '请先选择地图';
        return;
      }
      if (this.flow.mode === 'net') this.netMapConfirmed(ctx);
      else if (this.flow.mode === 'local') this.transitionPhase(ctx, () => this.startLocal(ctx));
      else this.transitionPhase(ctx, () => this.startSolo(ctx));
    }
  }

  /** 阶段切换演出（原版 fadOutList）：格子回舞台中心 scale→0，0.3s 后换阶段。 */
  private transitionPhase(ctx: SceneCtx, next: () => void): void {
    const quadOut = (k: number) => k * (2 - k);
    for (const { c } of this.animCells) {
      tweenOf(c, { x: OX + 370, y: 270, 'scale.x': 0, 'scale.y': 0 }, 200, {
        ease: quadOut,
        delayMs: Math.random() * 100,
      });
    }
    this.animCells = [];
    this.loadToken++; // 作废在途异步装料（退场中的格子不再挂新纹理）
    this.transitioning = true;
    window.setTimeout(() => {
      if (this.ctxRef === ctx && !this.destroyedFlag) {
        this.transitioning = false;
        next();
      }
    }, 300);
  }

  private destroyedFlag = false;
  private transitioning = false;

  // ---------- 头像网格（原版布局） ----------

  /** 原版布局坐标：startX = x+left + gapX*col（gapX 由 HCount 推导），行距同理。 */
  private cellPos(e: SelectEntry, list: SelectEntry[]): [number, number] {
    const L = this.uiData!.select.layout;
    const hCount = Math.max(...list.map((x) => x.col)) + 1;
    const vCount = Math.max(...list.map((x) => x.row)) + 1;
    const gapX = (L.stage[0] - L.unit[0] - L.gridPadding.left - L.gridPadding.right) / (hCount - 1);
    const gapY = (L.stage[1] - L.unit[1] - L.gridPadding.top - L.gridPadding.bottom) / (vCount - 1);
    const [dx, dy] = (e.offset ?? '0,0').split(',').map(Number);
    return [
      OX + L.gridOrigin[0] + gapX * e.col + (dx || 0),
      L.gridOrigin[1] + gapY * e.row + (dy || 0),
    ];
  }

  private renderGrid(
    root: Container,
    entries: SelectEntry[],
    onTap: (e: SelectEntry) => void,
  ): void {
    const ui = this.uiData!;
    const token = ++this.loadToken;
    const net = this.flow.mode === 'net';
    const local2p = this.flow.mode === 'local';
    const dual = net || local2p;
    const ownSide: 1 | 2 = this.flow.player === 2 ? 2 : 1;
    const peerSide: 1 | 2 = ownSide === 1 ? 2 : 1;
    const player = ownSide === 2 ? 'p2' : 'p1';

    // 键盘导航列表（本地双人）：按 row,col 行主序排序；光标下标复位
    // P1 默认首格（原版 moveSlt(_p1Slt,0,0) = 一护）；P2 默认网格 (col9,row0)
    // （原版 moveSlt(_p2Slt,9,0)：角色段 = 鸣人、援助段 = 该网格项；缺格回退首格）
    this.navList = [...entries].sort((a, b) => a.row - b.row || a.col - b.col);
    this.keyIdxP1 = 0;
    this.keyIdxP2 = Math.max(0, this.navList.findIndex((e) => e.row === 0 && e.col === 9));
    this.navListToken = this.navToken;

    // 头像纹理批量预载后挂格子（丢失头像类兜底 = 无头像的空格框）
    void Promise.all(
      entries.map(async (e) => {
        const url = uiFaceUrl(ui, e.id, '');
        return [e, url ? await Assets.load<Texture>(url) : null] as const;
      }),
    ).then((loaded) => {
      if (token !== this.loadToken) return; // 阶段已切换

      // 光标（P1 蓝 / P2 粉），PNG 原点 = 格子位 + cursorOffset；
      // 联机双光标：对端光标以对侧纹理渲染，各自独立移动互不阻塞
      const cursor = new Sprite(this.tex[`cursor_${player}`]!);
      cursor.visible = false;
      this.cursor = cursor;
      this.hoverIdx = null;
      this.peerCursor = null;
      if (dual) {
        const peerCursor = new Sprite(this.tex[peerSide === 2 ? 'cursor_p2' : 'cursor_p1']!);
        peerCursor.visible = false;
        this.peerCursor = peerCursor;
        this.peerCursorIdx = null;
      }

      let first: [number, number] | null = null;
      this.animCells = [];
      for (const [idx, [e, faceTex]] of loaded.entries()) {
        const [x, y] = this.cellPos(e, entries);
        const cell = new Container();
        cell.position.set(x, y);
        // 原版层级：头像 (0,0) 垫底，slt_item 框叠加
        if (faceTex) {
          const face = new Sprite(faceTex);
          face.width = 50;
          face.height = 50;
          cell.addChild(face);
        }
        const frame = new Sprite(this.tex.slt_item!);
        cell.addChild(frame);

        if (e.more) frame.tint = 0xffee55; // 原版 more= 项黄光提示（形态切换未实现）
        cell.eventMode = 'static';
        cell.cursor = 'pointer';
        cell.on('pointerover', () => {
          if (local2p) {
            // 本地双人鼠标（修复批次 61）：先控 P1，P1 份额锁满后转控 P2；
            // 落到键盘同款通道（keyIdx + placeKeyCursor + 展示盒跟随），与键盘并行
            const side = this.stageComplete(true) ? 2 : 1;
            if (this.stageComplete(side === 1)) return; // 该侧锁满后鼠标无效
            const navIdx = this.navList.indexOf(e);
            const cur = side === 1 ? this.keyIdxP1 : this.keyIdxP2;
            if (navIdx < 0 || cur === navIdx) return;
            if (side === 1) this.keyIdxP1 = navIdx;
            else this.keyIdxP2 = navIdx;
            this.placeKeyCursor(side);
            audioOf(this.ctxRef?.ctx!)?.se('menu1', 'swc'); // 原版 doHover select 音
            this.refreshActive(side, e);
            return;
          }
          // 原版 doHover：光标跟随悬停 + select 音；
          // 联机：锁满本端份额后光标冻结，hover 变更即 cursor 广播
          if (net && this.stageComplete(true)) return;
          cursor.position.set(x + ui.select.cursorOffset[0], y + ui.select.cursorOffset[1]);
          cursor.visible = true;
          if (net && this.hoverIdx !== idx) {
            this.hoverIdx = idx;
            this.sendCursorSafe(this.phase === 'assist' ? 'assist' : 'fighter', idx);
          }
          // 本端盒实时跟随悬停（原版 SelectedFighterGroup 语义；单机同样预览）
          this.refreshActive(ownSide, e);
          audioOf(this.ctxRef?.ctx!)?.se('menu1', 'swc');
        });
        cell.on('pointertap', () => {
          if (net) {
            if (!this.stageComplete(true)) onTap(e); // 选中即锁；锁满后忽略
            return;
          }
          if (local2p) {
            // 本地双人鼠标锁定（修复批次 61）：鼠标归属侧点击即锁，走键盘同款
            // lockOwn/lockPeer（含确认音/展示盒/锁定框/推进），锁满侧忽略
            const side = this.stageComplete(true) ? 2 : 1;
            if (this.stageComplete(side === 1)) return;
            const navIdx = this.navList.indexOf(e);
            if (navIdx >= 0) {
              if (side === 1) this.keyIdxP1 = navIdx;
              else this.keyIdxP2 = navIdx;
              this.placeKeyCursor(side);
            }
            if (side === 1) this.lockOwn(this.ctxRef!, e);
            else this.lockPeer(this.ctxRef!, e);
            return;
          }
          cursor.position.set(x + ui.select.cursorOffset[0], y + ui.select.cursorOffset[1]);
          cursor.visible = true;
          audioOf(this.ctxRef?.ctx!)?.se('menu2', 'swc'); // 原版 sndConfrim
          onTap(e);
          this.refreshActive(1, this.phase === 'fighter' ? this.fighter : this.assist);
        });
        if (!first) first = [x, y];
        root.addChild(cell);
        this.animCells.push({ c: cell, x, y });
      }

      // 入场演出（原版 buildList：各格从舞台中心 scale 0→1 落位，0.3s Back.easeOut，
      // delay = 随机 0..0.2s）
      for (const { c, x, y } of this.animCells) {
        c.position.set(OX + 400 - 30, 300 - 30);
        c.scale.set(0, 0);
        tweenOf(c, { x, y, 'scale.x': 1, 'scale.y': 1 }, 300, { delayMs: Math.random() * 200 });
      }

      // 光标与展示框延后入场（原版 initSelecter：setTimeout(_tweenTime=500) 后挂入）
      const tokenAt = token;
      window.setTimeout(() => {
        if (tokenAt !== this.loadToken || this.destroyedFlag) return;
        // 初始光标停在第一个可选格（本地双人：双光标都停首格）
        if (local2p) {
          this.placeKeyCursor(1);
          this.placeKeyCursor(2);
        } else if (first) {
          cursor.position.set(first[0] + ui.select.cursorOffset[0], first[1] + ui.select.cursorOffset[1]);
          cursor.visible = true;
        }
        root.addChild(cursor);
        if (this.peerCursor) root.addChild(this.peerCursor);
        // 展示框最后挂（原版 group 在格子之后 addChild，压在末行格子之上）
        this.boxOwn = [this.mountBox(root, ownSide)];
        if (dual) this.boxPeer = [this.mountBox(root, peerSide)];
        // 盒内容恢复：双光标恢复阶段内整条已选堆叠；单机显示当前阶段已选
        if (dual) {
          // 本地双人：先让栈顶预览初始键盘光标所在格（首格）
          if (local2p) {
            this.refreshActive(1, this.navEntry(1));
            this.refreshActive(2, this.navEntry(2));
          }
          this.syncBoxStack(ownSide, this.localStageLocks());
          this.syncBoxStack(peerSide, this.entriesOf(this.peerStageLocks()));
          this.updateNetStatus();
        } else {
          // 单机：显示已选；未选时跟随初始光标所在格（首格）预览
          const cur = this.phase === 'fighter' ? this.fighter : this.assist;
          this.refreshActive(1, cur ?? this.stageList()[0] ?? null);
          this.styleStack(this.boxOwn);
        }
      }, 500);
    });
  }

  // ---------- 已选展示框（原版 SelectedFighterGroup 规格） ----------

  /** 底部展示框：大头像 245×62 + 名字；side 2 内容容器镜像（原版 selected_item_p2_mc）。 */
  private mountBox(root: Container, side: 1 | 2): BoxRefs {
    const ui = this.uiData!;
    const isP2 = side === 2;
    const [bx, by] = isP2 ? ui.select.selectedPos.p2 : ui.select.selectedPos.p1;
    const box = new Container();
    // 原版新框从下方 50px 滑入（SelectedFighterGroup.addFighter）；styleStack 收到位
    box.position.set(OX + bx, by + 50);

    // ct 容器：P1 (4.75,4.75)；P2 镜像原点 (248.6,4.75) scale.x=-1（原版摆法）；
    // 头像垫底、框叠加（原版框 shape depth 6 > ct depth 1）
    const ct = new Container();
    const [cx, cy] = isP2 ? ui.select.faceBigP2Origin : ui.select.faceBigOffset;
    ct.position.set(cx, cy);
    if (isP2) ct.scale.x = -1;
    const face = new Sprite(Texture.EMPTY);
    face.width = 245;
    face.height = 62;
    ct.addChild(face);
    box.addChild(ct);
    // 斜切框遮罩：矩形大脸角部不得从框的斜切口漏出（框外形见 selectedFaceMask）
    const mask = selectedFaceMask(isP2);
    box.addChild(mask);
    ct.mask = mask;
    box.addChild(new Sprite(this.tex[isP2 ? 'selected_p2' : 'selected_p1']!));

    // 名字：P1 右对齐（右缘 x≈243）/ P2 左对齐 x=10；y = 高-25
    const name = new Text('', {
      fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
      fontSize: 14,
      fill: 0xffffff,
      stroke: { color: 0x000000, width: 2 },
    });
    if (isP2) {
      name.position.set(10, 45);
    } else {
      name.anchor.set(1, 0);
      name.position.set(243, 45);
    }
    box.addChild(name);
    root.addChild(box);
    return { root: box, baseY: by, face, name };
  }

  /** 刷新展示框大头像/名字（长名钳制：名字区 233px，超出按比例缩字）。 */
  private refreshBox(box: BoxRefs | null, entry: SelectEntry | null): void {
    if (!box || !entry) return;
    box.name.text = entry.name;
    box.name.scale.set(Math.min(1, 233 / Math.max(box.name.width, 1)));
    const url = uiFaceUrl(this.uiData!, entry.id, '_b');
    if (!url) return;
    const token = this.loadToken;
    void Assets.load<Texture>(url).then((t) => {
      if (token !== this.loadToken) return;
      box.face.texture = t;
      box.face.width = 245;
      box.face.height = 62;
    });
  }

  /** 展示框固定左右布局：P1 左下 / P2 右下（原版 selected_item_p1/p2_mc），
   *  不随本端位次翻转——两客户端看到的 P1 框都在左、P2 框都在右。 */
  private ownBoxSide(): 1 | 2 {
    return this.flow.player === 2 ? 2 : 1;
  }

  private peerBoxSide(): 1 | 2 {
    return this.ownBoxSide() === 1 ? 2 : 1;
  }

  /** 栈顶（最新/预览）框。 */
  private activeBox(side: 1 | 2): BoxRefs | null {
    const arr = side === 1 ? this.boxOwn : this.boxPeer;
    return arr[arr.length - 1] ?? null;
  }

  /** 预览：只改栈顶内容，不动堆叠（原版 SelectedFighterGroup.updateFighter）。 */
  private refreshActive(side: 1 | 2, entry: SelectEntry | null): void {
    this.refreshBox(this.activeBox(side), entry);
  }

  /** id 表 → 当前阶段条目（peerLocked 存 id；缺失项跳过）。 */
  private entriesOf(ids: readonly string[]): SelectEntry[] {
    const pool = this.stageList();
    return ids.map((id) => pool.find((x) => x.id === id)).filter((x): x is SelectEntry => !!x);
  }

  /** 原版 SelectedFighterGroup.addFighter 堆叠样式：旧框逐层上移 20px、缩小、变暗，
   *  最新框保持原位全亮。偏移照原版：addy=20-(N-2)*3, alpha=0.7-(N-2)*0.3, scale=0.85-(N-2)*0.15。 */
  private styleStack(arr: readonly BoxRefs[]): void {
    const n = arr.length;
    const addy = 20 - (n - 2) * 3;
    let y = -(n - 1) * 20;
    let alpha = 0.7 - (n - 2) * 0.3;
    let scale = 0.85 - (n - 2) * 0.15;
    for (let i = 0; i < n - 1; i++) {
      const b = arr[i]!;
      tweenOf(b.root, { y: b.baseY + y, alpha, 'scale.x': scale, 'scale.y': scale }, 100);
      y += addy;
      alpha += 0.3;
      scale += 0.15;
    }
    const top = arr[n - 1];
    if (top) {
      tweenOf(top.root, { y: top.baseY, alpha: 1, 'scale.x': 1, 'scale.y': 1 }, 100, { delayMs: 50 });
    }
  }

  /** 同步整条已选框栈（锁定/阶段重建/对端快照后调用）；无已选时保留一个空预览框。 */
  private syncBoxStack(side: 1 | 2, entries: readonly SelectEntry[]): void {
    const arr = side === 1 ? this.boxOwn : this.boxPeer;
    const show = entries.slice(0, this.requiredLocks());
    while (arr.length < Math.max(1, show.length)) {
      const parent = arr[arr.length - 1]?.root.parent;
      if (!parent) break;
      arr.push(this.mountBox(parent as Container, side));
    }
    while (arr.length > Math.max(1, show.length) && arr.length > 1) {
      arr.pop()!.root.destroy({ children: true });
    }
    show.forEach((e, i) => this.refreshBox(arr[i] ?? null, e));
    this.styleStack(arr);
  }

  // ---------- 联机双光标（切片 35；规格 docs/netplay-design.md §7） ----------

  private stageList(): SelectEntry[] {
    return this.phase === 'assist' ? this.select!.assists : this.select!.chars;
  }

  private localStageLocks(): SelectEntry[] {
    return this.phase === 'assist' ? this.localLocked.assists : this.localLocked.fighters;
  }

  private peerStageLocks(): string[] {
    return this.phase === 'assist' ? this.peerLocked.assists : this.peerLocked.fighters;
  }

  /** 当前阶段需锁定数（团队 3 选角色 + 1 辅助；单挑 1+1；原版 selectTimesCount）。 */
  private requiredLocks(): number {
    return this.phase === 'assist' ? 1 : this.flow.team ? 3 : 1;
  }

  /** 阶段锁定是否齐套。own=true 本端、false 对端。 */
  private stageComplete(own: boolean): boolean {
    const n = own ? this.localStageLocks().length : this.peerStageLocks().length;
    return n >= this.requiredLocks();
  }

  /** 整个选人流程（角色段 + 辅助段）是否锁满。交换/地图尾的放行守卫用——
   *  不依赖 phase 推导（phase 在过渡窗内可能滞后于对端进度）。 */
  private fullyLocked(own: boolean): boolean {
    const needF = this.flow.team ? 3 : 1;
    const l = own ? this.localLocked : this.peerLocked;
    return l.fighters.length >= needF && l.assists.length >= 1;
  }

  /** 联机上行（连接失效时静默丢弃，不打断 UI；残余由 3s 重发兜底）。 */
  private sendPickSafe(info: PickInfo): void {
    if (!this.socket || this.socket.readyState !== 1 || this.netDead) return;
    try {
      sendPick(this.socket, this.flow.player, info);
    } catch {
      /* 连接正在关闭 */
    }
  }

  private sendCursorSafe(stage: 'fighter' | 'assist', idx: number): void {
    if (!this.socket || this.socket.readyState !== 1 || this.netDead) return;
    try {
      sendCursor(this.socket, this.flow.player, stage, idx);
    } catch {
      /* 连接正在关闭 */
    }
  }

  /** 房主轮盘当前项的广播键（地图 id；随机项 'random'，确认时才解析）。 */
  private currentMapKey(): string {
    const e = this.mapEntries()[this.mapIndex];
    return e?.id ?? 'random';
  }

  /** 房主地图切换上行（切片 36：服务器透传给对端，客座只读跟随）。 */
  private sendMapPickSafe(map: string): void {
    if (!this.socket || this.socket.readyState !== 1 || this.netDead) return;
    try {
      sendMapPick(this.socket, this.flow.player, map);
    } catch {
      /* 连接正在关闭 */
    }
  }

  /** 本端锁定（选中即锁，无反悔）：随机项此刻解析成具体角色后按最终项同步/同步上行。 */
  private lockEntry(ctx: SceneCtx, e: SelectEntry): void {
    if (this.netDead || this.done) return;
    this.lockOwn(ctx, e);
    this.sendPickSafe(this.pickInfo());
  }

  /** 本端锁定核心（联机 + 本地双人 P1 共用）。 */
  private lockOwn(ctx: SceneCtx, e: SelectEntry): void {
    const list = this.phase === 'assist' ? this.localLocked.assists : this.localLocked.fighters;
    const resolved = this.resolveNetEntry(e, this.stageList(), list.map((x) => x.id));
    // 2026-11-22 对齐原版 SelectFighterStage.doSelect / SelecterItemUI.isSelected：
    // 只查本方已选——P1/P2 镜像同角色合法，但本方 3 槽位不得重复锁同一角色。
    if (list.some((x) => x.id === resolved.id)) {
      if (this.status) this.status.text = '该角色本方已选择，请换一个';
      return;
    }
    list.push(resolved);
    audioOf(this.ctxRef?.ctx!)?.se('menu2', 'swc'); // 原版 sndConfrim
    this.syncBoxStack(this.ownBoxSide(), list);
    this.updateNetStatus();
    this.checkAdvance(ctx);
  }

  /** 对方/P2 锁定（本地双人；联机对端走消息泵 onPeerPick）。 */
  private lockPeer(ctx: SceneCtx, e: SelectEntry): void {
    const list = this.peerStageLocks();
    const resolved = this.resolveNetEntry(e, this.stageList(), list);
    if (list.includes(resolved.id)) {
      if (this.status) this.status.text = '该角色 P2 已选择，请换一个';
      return;
    }
    list.push(resolved.id);
    audioOf(this.ctxRef?.ctx!)?.se('menu2', 'swc'); // 原版 sndConfrim
    this.syncBoxStack(2, this.entriesOf(list));
    this.updateNetStatus();
    this.checkAdvance(ctx);
  }

  /** 联机随机项此刻解析（结果以最终角色为准同步；原版 resolve 语义沿用）。
   *  exclude = 本方已锁 id——原版 checkRandom 同样排除本方已选角色。 */
  private resolveNetEntry(e: SelectEntry, pool: SelectEntry[], exclude: readonly string[] = []): SelectEntry {
    if (e.comicType >= 0) return e;
    const candidates = pool.filter(
      (x) =>
        !x.id.startsWith('random') &&
        !exclude.includes(x.id) &&
        (e.comicType < 0 || x.comicType === e.comicType),
    );
    return candidates[Math.floor(Math.random() * candidates.length)] ?? e;
  }

  /** 阶段状态行：本端进度 + 对方进度（联机"对方" = 对端；本地双人 = P2）。 */
  private updateNetStatus(): void {
    if (!this.status || (this.phase !== 'fighter' && this.phase !== 'assist')) return;
    const need = this.requiredLocks();
    const l = Math.min(this.localStageLocks().length, need);
    const p = Math.min(this.peerStageLocks().length, need);
    const what = this.phase === 'fighter' ? '角色' : '辅助';
    const peerLabel = this.flow.mode === 'net' ? '对方' : 'P2';
    this.status.text =
      l < need
        ? `选择${what}：已锁定 ${l}/${need}`
        : p < need
          ? `等待${peerLabel}选择${what}（${p}/${need}）`
          : '';
  }

  /** 双方齐套 → 本地推导推进下一阶段（判定输入一致结果一致，无需服务器裁决）。
   *  匹配路径（mapSelect=false）援助齐套后无地图阶段，直接收尾进加载页。 */
  private checkAdvance(ctx: SceneCtx): void {
    if (this.phase !== 'fighter' && this.phase !== 'assist') return;
    if (!this.stageComplete(true) || !this.stageComplete(false)) return;
    if (this.flow.mode === 'net' && this.phase === 'assist' && !this.flow.mapSelect) {
      this.finishNetNoMap(ctx);
      return;
    }
    this.phase = this.phase === 'fighter' ? 'assist' : 'map';
    this.hoverIdx = null;
    this.transitionPhase(ctx, () => this.renderPhase(ctx));
  }

  /** 匹配路径收尾（两端对称、各自独立，无需握手——同原开箱"无需握手"语义）：
   *  对局地图由权威 seed 按 maps[seed % n] 解析（两端同种子 → 同图 → configHash
   *  一致），最终 pick 随地图上行（对端在途时由 3s 重发兜底/接收侧守卫消化）。 */
  private finishNetNoMap(ctx: SceneCtx): void {
    if (this.done || this.netDead) return;
    const maps = this.select!.maps;
    const seed = this.flow.mapSeed ?? 1;
    this.commitPicks();
    this.flow.mapId = maps[Math.abs(Math.trunc(seed)) % maps.length]!.id;
    this.sendFinalPick();
    this.gotoLoading();
  }

  // ---------- 本地双人双键盘（切片 39；原版 isVsPeople 语义搬回同一台键盘） ----------

  /** 双键盘分派：fighter/assist 阶段 = 双光标移动/确认；map 阶段 = 鼠标轮盘共用 + P1 键盘。 */
  private handleLocalKey(e: KeyboardEvent): void {
    if (this.done || this.destroyedFlag || !this.ctxRef) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (this.phase === 'fighter' || this.phase === 'assist') {
      if (this.navListToken !== this.navToken) return; // 装料/过渡窗：导航表未就绪
      // P1：WASD 移动 + J 确认；P2：方向键移动 + 小键盘 1 确认（互不阻塞；
      // 各自锁满份额后确认键忽略，同联机"锁满冻结"语义）
      switch (e.code) {
        case 'KeyW': e.preventDefault(); this.moveCursor(1, 0, -1); return;
        case 'KeyS': e.preventDefault(); this.moveCursor(1, 0, 1); return;
        case 'KeyA': e.preventDefault(); this.moveCursor(1, -1, 0); return;
        case 'KeyD': e.preventDefault(); this.moveCursor(1, 1, 0); return;
        case 'KeyJ':
          e.preventDefault();
          if (!this.stageComplete(true)) this.lockOwn(this.ctxRef, this.navEntry(1));
          return;
        case 'ArrowUp': e.preventDefault(); this.moveCursor(2, 0, -1); return;
        case 'ArrowDown': e.preventDefault(); this.moveCursor(2, 0, 1); return;
        case 'ArrowLeft': e.preventDefault(); this.moveCursor(2, -1, 0); return;
        case 'ArrowRight': e.preventDefault(); this.moveCursor(2, 1, 0); return;
        case 'Numpad1':
          e.preventDefault();
          if (!this.stageComplete(false)) this.lockPeer(this.ctxRef, this.navEntry(2));
          return;
      }
    } else if (this.phase === 'map') {
      // 地图阶段：鼠标轮盘共用；P1 键盘 A/D 翻页、J 确认（地图归 P1 定，同联机房主）
      if (!this.mapPicSprite) return;
      const n = this.mapEntries().length;
      if (e.code === 'KeyA' || e.code === 'KeyW') {
        e.preventDefault();
        this.mapIndex = (this.mapIndex - 1 + n) % n;
        audioOf(this.ctxRef.ctx)?.se('menu1', 'swc'); // 原版地图轮盘翻页音
        this.showMapPic(this.mapPicSprite, this.mapEntries());
      } else if (e.code === 'KeyD' || e.code === 'KeyS') {
        e.preventDefault();
        this.mapIndex = (this.mapIndex + 1) % n;
        audioOf(this.ctxRef.ctx)?.se('menu1', 'swc');
        this.showMapPic(this.mapPicSprite, this.mapEntries());
      } else if (e.code === 'KeyJ') {
        e.preventDefault();
        this.confirmMap(this.mapEntries()[this.mapIndex]!);
      }
    }
  }

  /** 键盘光标当前指向的格子。 */
  private navEntry(side: 1 | 2): SelectEntry {
    const idx = side === 1 ? this.keyIdxP1 : this.keyIdxP2;
    return this.navList[idx] ?? this.stageList()[0]!;
  }

  /** 键盘光标移动：同行/同列内步进，行/列边界钳制；移动音 + 展示盒跟随。
   *  该侧份额锁满后光标冻结（原版锁定即固化、选器 disabled；确认键已有同款守卫）。 */
  private moveCursor(side: 1 | 2, dx: number, dy: number): void {
    const list = this.navList;
    if (list.length === 0) return;
    if (this.stageComplete(side === 1)) return;
    const cur = side === 1 ? this.keyIdxP1 : this.keyIdxP2;
    const from = list[cur]!;
    const pool = list
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => (dx !== 0 ? e.row === from.row : e.col === from.col))
      .sort((a, b) => (dx !== 0 ? a.e.col - b.e.col : a.e.row - b.e.row));
    const at = pool.findIndex(({ i }) => i === cur);
    const next = pool[Math.max(0, Math.min(pool.length - 1, at + (dx || dy)))];
    if (!next || next.i === cur) return;
    if (side === 1) this.keyIdxP1 = next.i;
    else this.keyIdxP2 = next.i;
    this.placeKeyCursor(side);
    audioOf(this.ctxRef?.ctx!)?.se('menu1', 'swc'); // 原版 doHover select 音
    this.refreshActive(side, next.e);
  }

  /** 键盘光标落位（navList 下标 → 格子坐标）。 */
  private placeKeyCursor(side: 1 | 2): void {
    const cur = side === 1 ? this.cursor : this.peerCursor;
    if (!cur || !this.uiData) return;
    const e = this.navEntry(side);
    const [x, y] = this.cellPos(e, this.stageList());
    cur.position.set(x + this.uiData.select.cursorOffset[0], y + this.uiData.select.cursorOffset[1]);
    cur.visible = true;
  }

  /** 累计锁定写入 flow：首名进 localPick/peerPick 供既有对局装配；团队另存全序。 */
  private commitPicks(): void {
    const f = this.flow;
    const toPick = (l: { fighters: SelectEntry[]; assists: SelectEntry[] }): Pick => ({
      fighter: l.fighters[0]?.id ?? '',
      assist: l.assists[0]?.id ?? '',
    });
    f.localPick = toPick(this.localLocked);
    f.peerPick = {
      fighter: this.peerLocked.fighters[0] ?? '',
      assist: this.peerLocked.assists[0] ?? '',
    };
    if (f.team) {
      f.localTeamPick = {
        fighters: this.localLocked.fighters.map((e) => e.id),
        assists: this.localLocked.assists.map((e) => e.id),
      };
      f.peerTeamPick = {
        fighters: [...this.peerLocked.fighters],
        assists: [...this.peerLocked.assists],
      };
    }
  }

  /** 本端累计锁定快照（覆盖语义；3s 重发共用）。 */
  private pickInfo(): PickInfo {
    const locked: LockedPicks = {
      fighters: this.localLocked.fighters.map((e) => e.id),
      assists: this.localLocked.assists.map((e) => e.id),
    };
    return { fighter: locked.fighters[0] ?? '', assist: locked.assists[0] ?? '', locked };
  }

  private sendCumulative(): void {
    this.sendPickSafe(this.pickInfo());
  }

  /** P1 确认地图后的最终消息（map 仅 P1 携带；P2 收到即移交加载页）。 */
  private sendFinalPick(): void {
    this.sendPickSafe({ ...this.pickInfo(), map: this.flow.mapId });
  }

  /** P1：地图确认（随机项此刻解析）→ 最终 pick 上行 → 交换等待对端确认。 */
  private netMapConfirmed(ctx: SceneCtx): void {
    const maps = this.select!.maps;
    const mapId = this.mapId ?? maps[Math.floor(Math.random() * maps.length)]!.id;
    this.commitPicks();
    this.flow.mapId = mapId;
    this.sendFinalPick();
    this.phase = 'exchange';
    this.transitionPhase(ctx, () => this.renderPhase(ctx));
  }

  // ---------- 联机消息泵（socket.onmessage 常驻接管；阶段切换不清） ----------

  private onNetMessage(ev: { data: unknown }): void {
    if (this.done) return;
    let msg: NetMessage;
    try {
      const text = typeof ev.data === 'string' ? ev.data : (ev.data as { toString(): string }).toString();
      msg = JSON.parse(text) as NetMessage;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'cursor':
        this.onPeerCursor(msg);
        break;
      case 'pick':
        this.onPeerPick(msg);
        break;
      case 'map-pick':
        this.onPeerMapPick(msg);
        break;
      case 'seed':
        // 服务器权威种子（begin 广播）：记下即用——对局 sim seed 进 configHash；
        // 匹配路径无此消息（seed 随 matched 携带）
        this.flow.mapSeed = msg.seed;
        break;
      case 'peer-lost':
        this.onNetDown();
        break;
      case 'error':
        if (this.status) this.status.text = msg.message ?? '';
        break;
      default:
        break; // start（hello 收齐）由对局层消费；welcome/room-info 不应出现在选人期
    }
  }

  private onPeerCursor(msg: Extract<NetMessage, { t: 'cursor' }>): void {
    if (this.flow.mode !== 'net' || !this.peerCursor || this.done) return;
    if (msg.stage !== this.phase) return; // 过渡期对端旧阶段光标丢弃（下次消息自校正）
    if (this.phase !== 'fighter' && this.phase !== 'assist') return;
    const list = this.stageList();
    const e = list[msg.idx];
    if (!e) return;
    this.peerCursorIdx = msg.idx;
    const [x, y] = this.cellPos(e, list);
    this.peerCursor.position.set(
      x + this.uiData!.select.cursorOffset[0],
      y + this.uiData!.select.cursorOffset[1],
    );
    this.peerCursor.visible = true;
    this.refreshActive(this.peerBoxSide(), e); // 对端盒栈顶实时跟随其光标
  }

  private onPeerPick(msg: Extract<NetMessage, { t: 'pick' }>): void {
    if (this.flow.mode !== 'net' || this.done || msg.player === this.flow.player) return;
    const ctx = this.ctxRef;
    if (!ctx) return;
    if (msg.locked) {
      // 覆盖式快照：对端最新累计锁定（3s 重发下幂等）
      this.peerLocked = {
        fighters: [...msg.locked.fighters],
        assists: [...msg.locked.assists],
      };
      this.commitPicks();
      this.updateNetStatus();
      this.refreshPeerBoxLocked();
      if (this.phase === 'exchange') {
        // 对端确认收到本端最终 pick（"对端收到即停发"约定的接收侧）；
        // 完整性守卫：对端角色+辅助确实锁满才放行（防对端选人途中的累计快照误触发）
        if (this.fullyLocked(false)) this.gotoLoading();
        return;
      }
      this.checkAdvance(ctx);
    }
    // P1 已锁地图（房主选择路径；开箱抽取归切片 36）：客座选满后收到即移交加载页
    //（完整性守卫：dev 直通混合手动操作时，本端未选满不因对端 map 提前跳走）
    if (msg.map && this.flow.player === 2 && this.fullyLocked(true)) {
      this.flow.mapId = msg.map;
      this.sendPickSafe(this.pickInfo()); // 回执：对端收到即停发
      this.gotoLoading();
    }
  }

  /** 房主轮盘切换跟随（切片 36，好友房路径；客座只读，phase 须为 map）。 */
  private onPeerMapPick(msg: Extract<NetMessage, { t: 'map-pick' }>): void {
    if (this.flow.mode !== 'net' || this.done || msg.player === this.flow.player) return;
    if (this.phase !== 'map' || !this.mapPicSprite) return;
    const entries = this.mapEntries();
    const idx = entries.findIndex((e) => (e.id ?? 'random') === msg.map);
    if (idx < 0) return;
    this.mapIndex = idx;
    this.showMapPic(this.mapPicSprite, entries);
    if (this.status) this.status.text = `房主浏览：${entries[idx]!.name}（等待确认）`;
  }

  /** 对端盒同步对端当前阶段累计锁定（覆盖快照；3s 重发幂等由 syncBoxStack 保证）。 */
  private refreshPeerBoxLocked(): void {
    this.syncBoxStack(this.peerBoxSide(), this.entriesOf(this.peerStageLocks()));
  }

  /** 连接断开（netplay-design §10：选人中掉线 → 提示后双方回主菜单）。 */
  private onNetDown(): void {
    if (this.netDead || this.done) return;
    this.netDead = true;
    if (this.status) this.status.text = '连接已断开';
    this.timers.push(
      window.setTimeout(() => {
        if (this.ctxRef && !this.destroyedFlag) {
          this.ctxRef.switchTo(new MenuScene(this.flow));
        }
      }, 1200),
    );
  }

  /** 选人完成 → 移交加载页（socket 消息泵脱钩，lockstart 在战斗装配时接管）。 */
  private gotoLoading(): void {
    const ctx = this.ctxRef;
    if (!ctx || this.done) return;
    this.done = true;
    this.commitPicks();
    if (this.socket) {
      this.socket.onmessage = null; // 空窗期消息由 BufferedSocket 缓冲，lockstart 接管时补交
      this.socket.onclose = null;
    }
    // 原版 SelectFighterStage.goLoadGame → transIn：黑幕合拢后进加载页
    transIn(ctx, () => ctx.switchTo(new LoadingScene(this.flow, this.socket)));
  }

  // ---------- 地图轮盘（原版 MapSelectUI 规格） ----------

  /** 地图轮盘条目。"？"随机场景 = 首项（原版 map_config random 实证首位，
   *  默认 mapIndex 0 即落在它上；2026-11-21 定案 + 原位归位），缩略图 random.webp。 */
  private mapEntries(): { id: string | null; name: string }[] {
    return [
      { id: null, name: '随机场景' }, // 原版 random 项（random.webp）
      ...this.select!.maps.map((m) => ({ id: m.id as string | null, name: m.name })),
    ];
  }

  /** 清空地图面板 fx 玩家表（Sprite 随宿主容器销毁，仅流资源需显式 dispose）。 */
  private clearMapFx(): void {
    for (const fx of this.mapFxPlayers) fx.dispose();
    this.mapFxPlayers = [];
  }

  private renderMaps(root: Container, opts: { interactive?: boolean } = {}): void {
    const ui = this.uiData!;
    const net = this.flow.mode === 'net';
    const interactive = opts.interactive !== false;
    const [px, py] = ui.select.mapPanelPos;
    // select_map PNG 画布原点 = 元件 bounds 左上（mc 原点在 PNG 内约 (78,0)）；
    // 面板挂载 x = 原版 mc.x(157) - PNG 内原点偏移(78)
    const panel = new Container();
    panel.position.set(OX + px - 78, py);
    const bg = new Sprite(this.tex.select_map!);
    panel.addChild(bg);

    // 切片 45：面板 fx 叠加层（干净底板只剩静态板 76；原版 sprite 100 深度序
    // d1 扫光 93 → d3/d5 箭头 96×2（d5 镜像）< d7 静态板 → d9 kuang 99 盖缩略图上）
    this.clearMapFx();
    const mkFx = (spec: UiSelectData['mapFx'][number]) => {
      const fx = new OverlayFx(spec, () => ({
        x: spec.pos[0],
        y: spec.pos[1],
        sx: spec.scale[0],
        sy: spec.scale[1],
        alpha: 1,
      }));
      fx.preload();
      this.mapFxPlayers.push(fx);
      return fx.ui;
    };
    for (const spec of ui.select.mapFx.filter((f) => f.char !== 99)) panel.addChild(mkFx(spec));

    const entries = this.mapEntries();
    this.mapIndex = ((this.mapIndex % entries.length) + entries.length) % entries.length;

    // 缩略图（450×240，与 ct 区同尺寸）
    const pic = new Sprite(Texture.EMPTY);
    pic.width = 450;
    pic.height = 240;
    pic.position.set(...ui.select.mapPicOffset);
    if (interactive) {
      pic.eventMode = 'static';
      pic.cursor = 'pointer';
    }
    panel.addChild(pic);
    this.mapPicSprite = pic; // 键盘翻页/对端跟随重绘用（renderPhase 清空）
    if (ui.select.mapFx.length > 0) {
      // 动画 kuang（99，60 帧循环）盖缩略图之上（原版 d9；静态 kuang 元件已由叠加层取代）
      for (const spec of ui.select.mapFx.filter((f) => f.char === 99)) panel.addChild(mkFx(spec));
    } else {
      // 兜底（无 fx 元数据的旧 ui.json）：静态 kuang 叠顶
      const kuang = new Sprite(this.tex.select_map_kuang!);
      kuang.position.set(...ui.select.mapKuangOffset);
      panel.addChild(kuang);
    }

    // 点缩略图即确认（原版 kuang 语义；随机项确认时解析）。客座只读无此交互
    if (interactive) pic.on('pointertap', () => this.confirmMap(entries[this.mapIndex]!));

    // 左右箭头热区（透明命中区，对齐 96 箭头 fx 实际覆盖域外扩 5px）。注意 fx 的
    // 原点语义：spec.pos 是元件原点位（右 584 / 左 57），OverlayFx 的 Sprite 锚点
    // (0,0)，左箭头 scale -1 绕原点翻转 → 实际画在 0..57（贴面板左缘，与右箭头
    // 584..641 关于 321 对称）——热区按视觉覆盖域算，不按原点位（此前按绕中心
    // 镜像假设给 52..119，热区落在箭头右侧空白上，左箭头点不中）；空 Container
    // 无 hitArea 不参与命中，故显式给矩形。联机房主切换后 map-pick 广播
    const mkHit = (x: number, dir: -1 | 1) => {
      const hit = new Container();
      hit.position.set(x, 113);
      hit.hitArea = new Rectangle(0, 0, 67, 60);
      if (interactive) {
        hit.eventMode = 'static';
        hit.cursor = 'pointer';
        hit.on('pointertap', () => {
          this.mapIndex = (this.mapIndex + dir + entries.length) % entries.length;
          audioOf(this.ctxRef?.ctx!)?.se('menu1', 'swc'); // 原版地图轮盘翻页音
          this.showMapPic(pic, entries);
          if (net) this.sendMapPickSafe(this.currentMapKey());
        });
      }
      panel.addChild(hit);
    };
    mkHit(-5, -1); // 左箭头（视觉域 0..57，外扩 5px）
    mkHit(579, 1); // 右箭头（视觉域 584..641，外扩 5px）

    // 名牌 + 地图名（原版 select_map_txt_mc：舞台坐标 (308.5,533)，居中）
    const [tx, ty] = ui.select.mapTextPos;
    const name = new Text('', {
      fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
      fontSize: 14,
      fill: 0xffffff,
      stroke: { color: 0x000000, width: 2 },
    });
    name.anchor.set(0.5, 0);
    name.position.set(OX + tx + 183 / 2, ty + 6);
    root.addChild(name);
    this.mapNameLabel = name;

    root.addChild(panel);
    // 入场演出（原版 initMap：面板从舞台中心 scale 0→1，0.3s Back.easeOut）
    this.animCells = [];
    this.animCells.push({ c: panel, x: OX + px - 78, y: py });
    panel.position.set(OX + 400 - 321, 300 - 143);
    panel.scale.set(0, 0);
    tweenOf(panel, { x: OX + px - 78, y: py, 'scale.x': 1, 'scale.y': 1 }, 300);
    this.showMapPic(pic, entries);
  }

  private mapNameLabel: Text | null = null;

  /** 选定当前轮盘地图并推进确认流程（随机项 mapId=null，确认时解析）。 */
  private confirmMap(e: { id: string | null; name: string }): void {
    audioOf(this.ctxRef?.ctx!)?.se('menu2', 'swc'); // 原版 sndConfrim
    this.mapId = e.id;
    this.mapChosen = true;
    this.status!.text = `地图：${e.name}`;
    this.onConfirm(this.ctxRef!);
  }

  private showMapPic(pic: Sprite, entries: { id: string | null; name: string }[]): void {
    const e = entries[this.mapIndex]!;
    const url = `${ASSETS}/${this.uiData!.maps.dir}/${e.id ?? 'random'}.webp`;
    const token = this.loadToken;
    void Assets.load<Texture>(url).then((t) => {
      if (token !== this.loadToken) return;
      pic.texture = t;
      pic.width = 450;
      pic.height = 240;
    });
    if (this.mapNameLabel) this.mapNameLabel.text = e.name;
  }

  // ---------- 交换与开打 ----------

  /** 单机确认时的最终选人（随机项此时解析；联机在锁定时已解析）。 */
  private resolvePick(): { pick: Pick; mapId: string | null } {
    const rand = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;
    const resolveEntry = (e: SelectEntry | null, pool: SelectEntry[]): SelectEntry => {
      if (e && e.comicType >= 0) return e;
      const filter = e?.comicType ?? -1;
      const candidates = pool.filter(
        (x) => !x.id.startsWith('random') && (filter < 0 || x.comicType === filter),
      );
      return rand(candidates);
    };
    const fighter = resolveEntry(this.fighter, this.select!.chars);
    const assist = resolveEntry(this.assist, this.select!.assists);
    const mapId = this.mapChosen ? (this.mapId ?? rand(this.select!.maps).id) : null;
    return { pick: { fighter: fighter.id, assist: assist.id }, mapId };
  }

  private startSolo(ctx: SceneCtx): void {
    const { pick, mapId } = this.resolvePick();
    this.flow.localPick = pick;
    this.flow.mapId = mapId!;
    transIn(ctx, () => ctx.switchTo(new LoadingScene(this.flow, null)));
  }

  /** 本地双人开打（地图确认后）：P1/P2 累计锁定写入 flow → 加载页（装配复用 net 双方异配路径）。 */
  private startLocal(ctx: SceneCtx): void {
    const maps = this.select!.maps;
    this.flow.mapId = this.mapId ?? maps[Math.floor(Math.random() * maps.length)]!.id;
    this.commitPicks();
    transIn(ctx, () => ctx.switchTo(new LoadingScene(this.flow, null)));
  }

  update(dtMs: number): void {
    tickTweens(dtMs);
    // 嵌套动画叠加层走带（切片 45；板帧恒 0——选人页无板帧驱动，常显循环）
    this.vortexFx?.update(0, dtMs);
    for (const fx of this.mapFxPlayers) fx.update(0, dtMs);
    // 联机 3s 重发兜底（覆盖语义幂等；对端收齐后进下一阶段，残余重发无害）：
    // 选人阶段（含地图等待）重发累计锁定，交换中重发最终 pick（含地图）
    if (this.flow.mode === 'net' && this.socket && !this.done && !this.netDead) {
      this.resendTimer += dtMs;
      if (this.resendTimer >= 3000) {
        this.resendTimer = 0;
        if (this.phase === 'exchange') this.sendFinalPick();
        else this.sendCumulative();
      }
    }
  }

  exit(): void {
    this.destroyedFlag = true;
    this.loadToken++;
    this.ctxRef = null;
    this.vortexFx?.dispose();
    this.vortexFx = null;
    this.clearMapFx();
    window.removeEventListener('keydown', this.onKeyBack);
    window.removeEventListener('keydown', this.onKeyLocal);
    this.confirmBox = null; // 随 ui 树销毁
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.length = 0;
    clearTweens();
    this.phaseRoot?.destroy({ children: true });
    this.ui?.destroy({ children: true });
    this.ui = null;
  }
}
