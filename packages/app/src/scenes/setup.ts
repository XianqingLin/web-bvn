/**
 * 选人场景（切片 14 骨架 → 切片 15 原版化换肤 → 切片 35 联机双光标）。
 *
 * 演出照原版 SelectFighterStage 规格：
 *  - 原版 800×600 舞台在 1000×600 逻辑屏横向居中（OX=100）；
 *  - 头像格：slt_item 60×60 框，50×50 头像垫底于框下，网格起点 (15,100)、
 *    列距 80、行距 = (600-50-100-10)/(行数-1)，offset 为原版像素微调；
 *  - 光标（P1 蓝/P2 粉）hover 跟随，PNG 原点 = 格子位 + (-18,-26)；
 *  - 已选展示框（大头像 245×62 + 名字）在底部两角，P2 内容容器镜像；
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
 *  - 双色框：双方锁定格各按位次色描边（P1 蓝/P2 粉，同格双锁内外框区分）；
 *  - 选中即锁：点击即锁定、无反悔；随机项此刻解析成具体角色后按最终项同步；
 *    锁满本端份额后本端光标冻结、点击忽略；
 *  - 双方齐套本地推导推进（角色 → 援助 → 地图），判定输入一致结果一致；
 *  - 团队模式：每光标连续锁 3 名角色（selectTimesCount = 3）再进援助（1 名）；
 *    同角色允许（镜像对决合法，自身重复亦允许）；
 *  - pick 覆盖式累计上行（3s 重发兜底幂等）；地图尾沿用最终 pick（map 仅 P1，
 *    P2 收到即移交加载页）；
 *  - 消息泵：socket.onmessage 常驻接管（cursor/pick/map-pick/map-roll/peer-lost 分派），
 *    断线按 netplay-design §10 提示后回主菜单。
 *
 * 地图阶段（切片 36，规格 docs/netplay-design.md §8）：
 *  - 房主选择（randomMap=false）：房主轮盘可操作，每次切换 map-pick 广播；
 *    客座只读面板实时跟随（轮盘同款渲染、无交互），房主确认走最终 pick.map；
 *  - 开箱抽取（randomMap=true）：两端播同一动画——CS:GO 式横向缩略图长条
 *    滚动减速定格，定格结果 = maps[seed % n]（服务器权威种子 map-roll 广播，
 *    begin 时到达；兼作对局 sim seed 进 configHash）；不可跳过/重抽，
 *    定格后两端各自独立进加载页（时长确定性一致，无需握手）；
 *  - 滚动演出 = easeInOutQuint 单段缓动（起步加速→高速→滑入停框近似规格分段），
 *    行程 ~3.4s + 定格高亮 0.8s；地图名随居中项实时更新，定格播确认音。
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
import { Assets, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
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
import { makeButton, makeLabel, UI_H, UI_W } from '../ui.js';
import { ASSETS, loadSelect, loadUi, uiFaceUrl, type SelectData, type SelectEntry, type UiData } from '../data.js';
import type { Flow, Pick } from '../flow.js';
import { LoadingScene } from './loading.js';

/** 原版舞台 800×600 在 1000×600 逻辑屏中的横向偏移。 */
const STAGE_W = 800;
const OX = (UI_W - STAGE_W) / 2;

/** P1/P2 位次色（原版 P1 蓝 / P2 粉光标同族色；规格层不锁死色值）。 */
const SIDE_COLORS: Record<1 | 2, number> = { 1: 0x2f9bff, 2: 0xff5fa2 };

/** 展示框（大头像 + 名字）引用。 */
interface BoxRefs {
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
  /** 光标精灵（fighter/assist 阶段跟随 hover） */
  private cursor: Sprite | null = null;
  /** 对端光标精灵（联机双光标；solo 为 null） */
  private peerCursor: Sprite | null = null;
  /** 本端光标当前格子下标（变更检测，cursor 广播去重） */
  private hoverIdx: number | null = null;
  /** 对端光标当前格子下标（null = 尚未收到） */
  private peerCursorIdx: number | null = null;
  /** 锁定框层（当前阶段双方锁定格，redrawLocks 重绘） */
  private lockLayer: Graphics | null = null;
  /** lockLayer 所属装料批次（阶段切换作废） */
  private lockToken = 0;
  /** 展示框引用：own = 本端；联机另有对端盒（solo 仅 own） */
  private boxOwn: BoxRefs | null = null;
  private boxPeer: BoxRefs | null = null;
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

  // —— 地图开箱抽取（切片 36；randomMap=true 的联机地图阶段）——
  /** 滚动动画状态（update 驱动；null = 非 roll 模式/未起播/已定格） */
  private rollAnim: {
    strip: Container;
    label: Text;
    dist: number;
    startX: number;
    startAt: number;
    travelMs: number;
    holdMs: number;
    stride: number;
    cellW: number;
    /** 定格地图（select.maps 目标项；两端由同一 seed 解析，天然一致） */
    target: { id: string; name: string };
    /** 地图序列（strip 内按 index % maps.length 取名） */
    maps: { id: string; name: string }[];
    finished: boolean;
  } | null = null;
  /** 已进地图阶段但 map-roll 种子在途（到达后起播；正常在选人期已到，防御用） */
  private rollPending = false;

  constructor(
    private readonly flow: Flow,
    /** 联机 socket（net 场景交接；solo/local 省略） */
    private readonly socket: WsLike | null = null,
  ) {}

  async enter(ctx: SceneCtx): Promise<void> {
    this.ctxRef = ctx;
    // 非 net 流（solo/local 直进）：清联机会话残留（地图模式/种子归联机会话）
    if (this.flow.mode !== 'net') {
      this.flow.randomMap = false;
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

    // 原版背景（800×600 居中）
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

    const backBtn = makeButton('返回', () => this.back(ctx), { w: 90, h: 34, size: 14 });
    backBtn.position.set(UI_W - 120, 20);
    ui.addChild(backBtn);

    this.renderPhase(ctx);

    // 联机：接管 socket 消息泵（BufferedSocket 空窗期缓冲在接管时补交；
    // 数据装载完成后才接管，泵内 stageList 等依赖 select 数据）
    if (this.socket) {
      this.socket.onmessage = (ev) => this.onNetMessage(ev);
      this.socket.onclose = () => this.onNetDown();
    }

    // 本地双人：双键盘监听（双光标移动/确认 + ESC 返回菜单）
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

  /** dev 直通（联机）：免点击走完累计锁定；P1 直接确认默认地图进交换等待。 */
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
    if (this.flow.player === 1 && !this.flow.randomMap) {
      this.mapId = 'KonohaMura';
      this.mapChosen = true;
      this.netMapConfirmed(ctx);
    } else {
      // 客座（房主选择路径）与开箱抽取（randomMap，两端）：地图阶段由消息泵驱动
      // （map-pick 跟随 / map-roll 种子起播，泵接管时机早于本调用，种子已就位）
      this.phase = 'map';
      this.renderPhase(ctx);
    }
  }

  private back(ctx: SceneCtx): void {
    const { switchTo } = ctx;
    if (this.flow.mode === 'net') {
      this.socket?.close();
      void import('./net.js').then(({ NetScene }) => switchTo(new NetScene(this.flow)));
    } else {
      void import('./menu.js').then(({ MenuScene }) => switchTo(new MenuScene(this.flow)));
    }
  }

  // ---------- 阶段渲染 ----------

  private renderPhase(ctx: SceneCtx): void {
    this.loadToken++;
    this.navToken++;
    this.mapPicSprite = null;
    this.cursor = null;
    this.peerCursor = null;
    this.peerCursorIdx = null;
    this.lockLayer = null;
    this.boxOwn = null;
    this.boxPeer = null;
    clearTweens(); // 旧阶段格子的退场补间随 phaseRoot 销毁一并作废
    this.phaseRoot?.destroy({ children: true });
    const root = new Container();
    this.phaseRoot = root;
    this.ui!.addChild(root);

    if (this.status) this.status.text = '';
    const net = this.flow.mode === 'net';
    const local2p = this.flow.mode === 'local';

    // 确认按钮：顶部右侧（底部两角让位原版展示框）。
    // 联机/本地双人 fighter/assist 选中即锁无确认；地图仅房主可确认（客座只读等待）。
    if (this.phase === 'fighter' || this.phase === 'assist' || this.phase === 'map') {
      const mapHost = !net || this.flow.player === 1;
      const rollMode = this.phase === 'map' && net && this.flow.randomMap; // 开箱抽取自动推进，无确认按钮
      if ((this.phase === 'map' && mapHost && !rollMode) || (!net && !local2p && this.phase !== 'map')) {
        const confirmLabel =
          this.phase === 'map'
            ? net
              ? '锁定并等待对手'
              : '开始对局'
            : this.phase === 'fighter'
              ? '确认角色'
              : '确认辅助';
        this.mountConfirm(root, confirmLabel, () => this.onConfirm(ctx));
      }
      if (this.phase !== 'fighter' && !net && !local2p) {
        // 上一步仅单机（联机选中即锁无反悔，不提供）
        const backBtn = makeButton('上一步', () => {
          this.phase = this.phase === 'map' ? 'assist' : 'fighter';
          this.transitionPhase(ctx, () => this.renderPhase(ctx));
        }, { w: 90, h: 34, size: 14 });
        backBtn.position.set(UI_W - 220, 20);
        root.addChild(backBtn);
      }
    }

    if (this.phase === 'fighter') {
      this.renderGrid(root, this.select!.chars, (e) => {
        if (net) this.lockEntry(ctx, e);
        else {
          this.fighter = e;
          this.status!.text = `角色：${e.name}`;
        }
      });
    } else if (this.phase === 'assist') {
      this.renderGrid(root, this.select!.assists, (e) => {
        if (net) this.lockEntry(ctx, e);
        else {
          this.assist = e;
          this.status!.text = `辅助：${e.name}`;
        }
      });
    } else if (this.phase === 'map') {
      if (net && this.flow.randomMap) {
        // 开箱抽取（切片 36）：两端播同一动画，定格结果由服务器种子本地解析，不可跳过
        this.renderMapRoll();
      } else if (net && this.flow.player === 2) {
        // 客座只读（房主选择路径）：map-pick 广播实时跟随房主切换
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
    window.setTimeout(() => {
      if (this.ctxRef === ctx && !this.destroyedFlag) next();
    }, 300);
  }

  private destroyedFlag = false;

  private mountConfirm(root: Container, label: string, onClick: () => void): void {
    const btn = makeButton(label, onClick, { w: 150, h: 34, size: 15 });
    btn.position.set(UI_W - 170, 62);
    root.addChild(btn);
  }

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

    // 键盘导航列表（本地双人）：按 row,col 行主序排序；光标下标复位到首格
    this.navList = [...entries].sort((a, b) => a.row - b.row || a.col - b.col);
    this.keyIdxP1 = 0;
    this.keyIdxP2 = 0;
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
          if (local2p) return; // 本地双人：鼠标不参与选人（双键盘驱动，见切片 39）
          // 原版 doHover：光标跟随悬停 + select 音；
          // 联机：锁满本端份额后光标冻结，hover 变更即 cursor 广播
          if (net && this.stageComplete(true)) return;
          cursor.position.set(x + ui.select.cursorOffset[0], y + ui.select.cursorOffset[1]);
          cursor.visible = true;
          if (net) {
            if (this.hoverIdx !== idx) {
              this.hoverIdx = idx;
              this.sendCursorSafe(this.phase === 'assist' ? 'assist' : 'fighter', idx);
            }
            this.refreshBox(this.boxOwn, e); // 本端盒实时跟随悬停（原版 SelectedFighterGroup 语义）
          }
          audioOf(this.ctxRef?.ctx!)?.se('menu1', 'swc');
        });
        cell.on('pointertap', () => {
          if (net) {
            if (!this.stageComplete(true)) onTap(e); // 选中即锁；锁满后忽略
            return;
          }
          if (local2p) return; // 本地双人：锁定走键盘确认键
          cursor.position.set(x + ui.select.cursorOffset[0], y + ui.select.cursorOffset[1]);
          cursor.visible = true;
          audioOf(this.ctxRef?.ctx!)?.se('menu2', 'swc'); // 原版 sndConfrim
          onTap(e);
          this.refreshBox(this.boxOwn, this.phase === 'fighter' ? this.fighter : this.assist);
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
        // 锁定框层（联机/本地双人双色框）
        if (dual) {
          const lockLayer = new Graphics();
          root.addChild(lockLayer);
          this.lockLayer = lockLayer;
          this.lockToken = token;
          this.redrawLocks();
        }
        // 展示框最后挂（原版 group 在格子之后 addChild，压在末行格子之上）
        this.boxOwn = this.mountBox(root, ownSide);
        if (dual) this.boxPeer = this.mountBox(root, peerSide);
        // 盒内容恢复：单机显示当前阶段已选；双光标恢复阶段内最近锁定/对方锁定
        if (dual) {
          const locked = this.localStageLocks();
          if (locked.length > 0) this.refreshBox(this.boxOwn, locked[locked.length - 1]!);
          const peerIds = this.peerStageLocks();
          const lastPeer = peerIds[peerIds.length - 1];
          if (lastPeer !== undefined) {
            const pe = this.stageList().find((x) => x.id === lastPeer);
            if (pe) this.refreshBox(this.boxPeer, pe);
          }
          this.updateNetStatus();
        } else {
          this.refreshBox(this.boxOwn, this.phase === 'fighter' ? this.fighter : this.assist);
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
    box.position.set(OX + bx, by);

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
    return { face, name };
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
    const resolved = this.resolveNetEntry(e, this.stageList());
    const list = this.phase === 'assist' ? this.localLocked.assists : this.localLocked.fighters;
    list.push(resolved);
    audioOf(this.ctxRef?.ctx!)?.se('menu2', 'swc'); // 原版 sndConfrim
    this.refreshBox(this.boxOwn, resolved);
    this.redrawLocks();
    this.updateNetStatus();
    this.checkAdvance(ctx);
  }

  /** 对方/P2 锁定（本地双人；联机对端走消息泵 onPeerPick）。 */
  private lockPeer(ctx: SceneCtx, e: SelectEntry): void {
    const resolved = this.resolveNetEntry(e, this.stageList());
    this.peerStageLocks().push(resolved.id);
    audioOf(this.ctxRef?.ctx!)?.se('menu2', 'swc'); // 原版 sndConfrim
    this.refreshBox(this.boxPeer, resolved);
    this.redrawLocks();
    this.updateNetStatus();
    this.checkAdvance(ctx);
  }

  /** 联机随机项此刻解析（结果以最终角色为准同步；原版 resolve 语义沿用）。 */
  private resolveNetEntry(e: SelectEntry, pool: SelectEntry[]): SelectEntry {
    if (e.comicType >= 0) return e;
    const candidates = pool.filter(
      (x) => !x.id.startsWith('random') && (e.comicType < 0 || x.comicType === e.comicType),
    );
    return candidates[Math.floor(Math.random() * candidates.length)] ?? e;
  }

  /** 重绘当前阶段锁定框（本端内框 / 对端外框，各按位次色；同格双锁可分辨）。 */
  private redrawLocks(): void {
    const g = this.lockLayer;
    if (!g || this.lockToken !== this.loadToken) return;
    g.clear();
    const list = this.stageList();
    const ownColor = SIDE_COLORS[this.flow.player === 2 ? 2 : 1];
    const peerColor = SIDE_COLORS[this.flow.player === 2 ? 1 : 2];
    for (const e of this.localStageLocks()) {
      const [x, y] = this.cellPos(e, list);
      g.rect(x - 2, y - 2, 64, 64).stroke({ width: 3, color: ownColor, alpha: 0.9 });
    }
    for (const id of this.peerStageLocks()) {
      const e = list.find((x) => x.id === id);
      if (!e) continue;
      const [x, y] = this.cellPos(e, list);
      g.rect(x - 6, y - 6, 72, 72).stroke({ width: 2, color: peerColor, alpha: 0.9 });
    }
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

  /** 双方齐套 → 本地推导推进下一阶段（判定输入一致结果一致，无需服务器裁决）。 */
  private checkAdvance(ctx: SceneCtx): void {
    if (this.phase !== 'fighter' && this.phase !== 'assist') return;
    if (!this.stageComplete(true) || !this.stageComplete(false)) return;
    this.phase = this.phase === 'fighter' ? 'assist' : 'map';
    this.hoverIdx = null;
    this.transitionPhase(ctx, () => this.renderPhase(ctx));
  }

  // ---------- 本地双人双键盘（切片 39；原版 isVsPeople 语义搬回同一台键盘） ----------

  /** 双键盘分派：fighter/assist 阶段 = 双光标移动/确认；map 阶段 = 鼠标轮盘共用 + P1 键盘。 */
  private handleLocalKey(e: KeyboardEvent): void {
    if (this.done || this.destroyedFlag || !this.ctxRef) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.code === 'Escape') {
      e.preventDefault();
      this.back(this.ctxRef);
      return;
    }
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

  /** 键盘光标移动：同行/同列内步进，行/列边界钳制；移动音 + 展示盒跟随。 */
  private moveCursor(side: 1 | 2, dx: number, dy: number): void {
    const list = this.navList;
    if (list.length === 0) return;
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
    this.refreshBox(side === 1 ? this.boxOwn : this.boxPeer, next.e);
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
      case 'map-roll':
        this.onMapRoll(msg);
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
    this.refreshBox(this.boxPeer, e); // 对端盒实时跟随其光标
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
      this.redrawLocks();
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

  /** 房主轮盘切换跟随（切片 36，房主选择路径；客座只读，phase 须为 map 且非 roll 模式）。 */
  private onPeerMapPick(msg: Extract<NetMessage, { t: 'map-pick' }>): void {
    if (this.flow.mode !== 'net' || this.done || msg.player === this.flow.player) return;
    if (this.flow.randomMap || this.phase !== 'map' || !this.mapPicSprite) return;
    const entries = this.mapEntries();
    const idx = entries.findIndex((e) => (e.id ?? 'random') === msg.map);
    if (idx < 0) return;
    this.mapIndex = idx;
    this.showMapPic(this.mapPicSprite, entries);
    if (this.status) this.status.text = `房主浏览：${entries[idx]!.name}（等待确认）`;
  }

  /** 服务器权威种子（切片 36，begin 时广播）：到达即记录；roll 模式地图阶段
   *  已进入且种子在途时据此起播（正常在选人期已随缓冲补交到达，防御用）。 */
  private onMapRoll(msg: Extract<NetMessage, { t: 'map-roll' }>): void {
    this.flow.mapSeed = msg.seed;
    if (this.rollPending && this.phase === 'map' && !this.done && !this.netDead) {
      this.rollPending = false;
      void this.startMapRoll(msg.seed);
    }
  }

  /** 对端盒显示对端当前阶段最近锁定项（覆盖快照最后一条）。 */
  private refreshPeerBoxLocked(): void {
    const ids = this.peerStageLocks();
    const last = ids[ids.length - 1];
    if (last === undefined) return;
    const e = this.stageList().find((x) => x.id === last);
    if (e) this.refreshBox(this.boxPeer, e);
  }

  /** 连接断开（netplay-design §10：选人中掉线 → 提示后双方回主菜单）。 */
  private onNetDown(): void {
    if (this.netDead || this.done) return;
    this.netDead = true;
    if (this.status) this.status.text = '连接已断开';
    this.timers.push(
      window.setTimeout(() => {
        if (this.ctxRef && !this.destroyedFlag) {
          void import('./menu.js').then(({ MenuScene }) => this.ctxRef!.switchTo(new MenuScene(this.flow)));
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
    ctx.switchTo(new LoadingScene(this.flow, this.socket));
  }

  // ---------- 地图轮盘（原版 MapSelectUI 规格） ----------

  private mapEntries(): { id: string | null; name: string }[] {
    return [
      ...this.select!.maps.map((m) => ({ id: m.id as string | null, name: m.name })),
      { id: null, name: '随机地图' }, // 原版 random 项（random.webp）
    ];
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

    const entries = this.mapEntries();
    this.mapIndex = ((this.mapIndex % entries.length) + entries.length) % entries.length;

    // 缩略图（450×240，与 ct 区同尺寸）+ kuang 叠顶（原版 kuang 在缩略图之上）
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
    const kuang = new Sprite(this.tex.select_map_kuang!);
    kuang.position.set(...ui.select.mapKuangOffset);
    panel.addChild(kuang);

    // 点缩略图即确认（原版 kuang 语义；随机项确认时解析）。客座只读无此交互
    if (interactive) pic.on('pointertap', () => this.confirmMap(entries[this.mapIndex]!));

    // 左右箭头热区（透明命中区，PNG 坐标）；联机房主切换后 map-pick 广播
    const mkHit = (x: number, dir: -1 | 1) => {
      const hit = new Container();
      hit.position.set(x, 105);
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
    mkHit(5, -1); // 左箭头（PNG x≈18..57）
    mkHit(577, 1); // 右箭头（PNG x≈585..625）

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

  // ---------- 地图开箱抽取（切片 36，netplay-design §8） ----------

  /** 开箱抽取入口（两端同款）：种子未到先挂等待态，到即起播。 */
  private renderMapRoll(): void {
    if (this.flow.mapSeed == null) {
      this.rollPending = true; // map-roll 到达后 onMapRoll 起播
      if (this.status) this.status.text = '等待地图种子…';
      return;
    }
    void this.startMapRoll(this.flow.mapSeed);
  }

  /** 起播：预载全部缩略图 → 组长条（地图序列重复 3 遍，定格实例取中段）→
   *  update 按 easeInOutQuint 推进行程，定格高亮 holdMs 后两端各自进加载页。 */
  private async startMapRoll(seed: number): Promise<void> {
    const maps = this.select!.maps;
    const token = this.loadToken;
    const target = maps[Math.abs(Math.trunc(seed)) % maps.length]!;
    if (this.status) this.status.text = '地图抽取中…';
    // 缩略图全量预载（两端同 select 数据 → 同图集，动画后帧一致）
    const texs = await Promise.all(
      maps.map((m) => Assets.load<Texture>(`${ASSETS}/${this.uiData!.maps.dir}/${m.id}.webp`)),
    );
    if (this.destroyedFlag || token !== this.loadToken || this.phase !== 'map') return;

    const CELL_W = 300;
    const CELL_H = 160;
    const STRIDE = CELL_W + 24;
    const CY = 300;
    const CX = OX + STAGE_W / 2;
    const targetCell = maps.length + Math.abs(Math.trunc(seed)) % maps.length; // 中段实例

    // 裁剪：长条只露舞台区（滚出舞台外的格子不可见）
    const mask = new Graphics();
    mask.rect(OX, CY - 130, STAGE_W, 260).fill({ color: 0xffffff });
    const strip = new Container();
    strip.mask = mask;
    for (let i = 0; i < maps.length * 3; i++) {
      const k = i % maps.length;
      const sp = new Sprite(texs[k]!);
      sp.width = CELL_W;
      sp.height = CELL_H;
      sp.position.set(i * STRIDE, 0);
      strip.addChild(sp);
    }
    strip.position.set(0, CY - CELL_H / 2);
    this.phaseRoot!.addChild(mask, strip);

    // 中央高亮框 + 居中项名牌（复用地图轮盘名牌位）
    const frame = new Graphics();
    frame
      .rect(CX - CELL_W / 2 - 6, CY - CELL_H / 2 - 6, CELL_W + 12, CELL_H + 12)
      .stroke({ width: 4, color: 0xffd54f, alpha: 0.95 });
    this.phaseRoot!.addChild(frame);
    const [tx, ty] = this.uiData!.select.mapTextPos;
    const label = new Text('', {
      fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
      fontSize: 14,
      fill: 0xffffff,
      stroke: { color: 0x000000, width: 2 },
    });
    label.anchor.set(0.5, 0);
    label.position.set(OX + tx + 183 / 2, ty + 6);
    this.phaseRoot!.addChild(label);

    this.rollAnim = {
      strip,
      label,
      // 起步第 1 格居中 → 定格目标格居中（行程穿过整圈 + 目标位，~4.4k px）
      startX: CX - CELL_W / 2 - STRIDE,
      dist: -(targetCell - 1) * STRIDE,
      startAt: performance.now(),
      travelMs: 3400,
      holdMs: 800,
      stride: STRIDE,
      cellW: CELL_W,
      target,
      maps,
      finished: false,
    };
  }

  /** 缓动：easeInOutQuint——起步加速、中段高速、长尾滑入停框（规格 §8 分段的
   *  单段近似；登记偏离：分段边界不逐一复刻，总时长 ~4.2s 吻合"约 4 秒"）。 */
  private static readonly quintInOut = (u: number): number =>
    u < 0.5 ? 16 * u ** 5 : 1 - (-2 * u + 2) ** 5 / 2;

  /** 滚动推进（update 调用）：行程结束定格，holdMs 计满播确认音并移交加载页。 */
  private tickRoll(now: number): void {
    const r = this.rollAnim;
    if (!r || r.finished) return;
    const cx = OX + STAGE_W / 2;
    const t = now - r.startAt;
    if (t <= r.travelMs) {
      const u = Math.max(0, Math.min(1, t / r.travelMs));
      const x = r.startX + r.dist * SetupScene.quintInOut(u);
      r.strip.x = x;
      // 名牌随居中项更新（strip 内 index → maps 序取模）
      const i = Math.round((cx - r.cellW / 2 - x) / r.stride);
      const m = r.maps[((i % r.maps.length) + r.maps.length) % r.maps.length];
      r.label.text = m?.name ?? '';
    } else {
      r.strip.x = r.startX + r.dist; // 定格：目标格居中
      r.label.text = r.target.name;
    }
    if (t >= r.travelMs + r.holdMs) {
      r.finished = true;
      audioOf(this.ctxRef?.ctx!)?.se('menu2', 'swc'); // 原版 sndConfrim（定格确认音）
      if (this.status) this.status.text = `地图：${r.target.name}`;
      this.flow.mapId = r.target.id;
      this.gotoLoading(); // 两端时长确定性一致，各自独立移交（无需握手）
    }
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
    ctx.switchTo(new LoadingScene(this.flow, null));
  }

  /** 本地双人开打（地图确认后）：P1/P2 累计锁定写入 flow → 加载页（装配复用 net 双方异配路径）。 */
  private startLocal(ctx: SceneCtx): void {
    const maps = this.select!.maps;
    this.flow.mapId = this.mapId ?? maps[Math.floor(Math.random() * maps.length)]!.id;
    this.commitPicks();
    ctx.switchTo(new LoadingScene(this.flow, null));
  }

  update(dtMs: number): void {
    tickTweens(dtMs);
    // 开箱抽取滚动推进（切片 36；定格后移交加载页，本场景 done 退出）
    this.tickRoll(performance.now());
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
    this.rollAnim = null;
    this.rollPending = false;
    window.removeEventListener('keydown', this.onKeyLocal);
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.length = 0;
    clearTweens();
    this.phaseRoot?.destroy({ children: true });
    this.ui?.destroy({ children: true });
    this.ui = null;
  }
}
