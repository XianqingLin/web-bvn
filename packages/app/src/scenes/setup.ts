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
 *    P2 收到即移交加载页；开箱抽取/实时跟随归切片 36）；
 *  - 消息泵：socket.onmessage 常驻接管（cursor/pick/peer-lost 分派），
 *    断线按 netplay-design §10 提示后回主菜单。
 *
 * 骨架期限制（记录，切片 14 沿用）：
 *  - 原版 more= 形态切换未实现（数据保留，more= 项格框黄色提示）；
 */
import { Assets, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import {
  sendCursor,
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
  /** 对端累计锁定 id（pick 覆盖式快照） */
  private peerLocked: { fighters: string[]; assists: string[] } = { fighters: [], assists: [] };
  /** 连接已断（§10：提示后回主菜单，只触发一次） */
  private netDead = false;
  /** 已移交加载页（消息泵停止） */
  private done = false;
  /** 离场定时器（断线回菜单） */
  private readonly timers: number[] = [];

  constructor(
    private readonly flow: Flow,
    /** 联机 socket（net 场景交接；solo 省略） */
    private readonly socket: WsLike | null = null,
  ) {}

  async enter(ctx: SceneCtx): Promise<void> {
    this.ctxRef = ctx;
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

    // dev 直通：自动确认默认选人（ichigo/gaara/KonohaMura）
    if (this.flow.autoPick) this.autoConfirm(ctx);
  }

  /** dev 直通：免点击走完 选角色→选辅助→（地图）→开打。 */
  private autoConfirm(ctx: SceneCtx): void {
    if (this.flow.mode === 'net') return this.autoConfirmNet(ctx);
    const byId = (list: SelectEntry[], id: string) => list.find((e) => e.id === id) ?? list[0]!;
    this.fighter = byId(this.select!.chars, 'ichigo');
    this.assist = byId(this.select!.assists, 'gaara');
    this.status!.text = `角色：${this.fighter.name}  辅助：${this.assist.name}`;
    this.mapId = 'KonohaMura';
    this.mapChosen = true;
    this.startSolo(ctx);
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
    if (this.flow.player === 1) {
      this.mapId = 'KonohaMura';
      this.mapChosen = true;
      this.netMapConfirmed(ctx);
    } else {
      this.phase = 'map'; // 客座地图等待：真机对端 map pick 经消息泵到达后移交加载页
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

    // 确认按钮：顶部右侧（底部两角让位原版展示框）。
    // 联机 fighter/assist 选中即锁无确认；地图仅房主可确认（客座只读等待）。
    if (this.phase === 'fighter' || this.phase === 'assist' || this.phase === 'map') {
      const mapHost = !net || this.flow.player === 1;
      if ((this.phase === 'map' && mapHost) || (!net && this.phase !== 'map')) {
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
      if (this.phase !== 'fighter' && !net) {
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
      if (net && this.flow.player === 2) {
        // 客座无操作权（房主选择路径）；实时跟随房主切换归切片 36（map-pick 广播）
        if (this.status) this.status.text = '等待房主选择地图…';
      } else {
        this.renderMaps(root);
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
    const ownSide: 1 | 2 = this.flow.player === 2 ? 2 : 1;
    const peerSide: 1 | 2 = ownSide === 1 ? 2 : 1;
    const player = ownSide === 2 ? 'p2' : 'p1';

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
      if (net) {
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
        // 初始光标停在第一个可选格
        if (first) {
          cursor.position.set(first[0] + ui.select.cursorOffset[0], first[1] + ui.select.cursorOffset[1]);
          cursor.visible = true;
        }
        root.addChild(cursor);
        if (this.peerCursor) root.addChild(this.peerCursor);
        // 锁定框层（联机双色框）
        if (net) {
          const lockLayer = new Graphics();
          root.addChild(lockLayer);
          this.lockLayer = lockLayer;
          this.lockToken = token;
          this.redrawLocks();
        }
        // 展示框最后挂（原版 group 在格子之后 addChild，压在末行格子之上）
        this.boxOwn = this.mountBox(root, ownSide);
        if (net) this.boxPeer = this.mountBox(root, peerSide);
        // 盒内容恢复：单机显示当前阶段已选；联机恢复阶段内最近锁定/对端锁定
        if (net) {
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

  /** 联机锁定（选中即锁，无反悔）：随机项此刻解析成具体角色后按最终项同步。 */
  private lockEntry(ctx: SceneCtx, e: SelectEntry): void {
    if (this.netDead || this.done) return;
    const resolved = this.resolveNetEntry(e, this.stageList());
    const list = this.phase === 'assist' ? this.localLocked.assists : this.localLocked.fighters;
    list.push(resolved);
    audioOf(this.ctxRef?.ctx!)?.se('menu2', 'swc'); // 原版 sndConfrim
    this.refreshBox(this.boxOwn, resolved);
    this.redrawLocks();
    this.updateNetStatus();
    this.sendPickSafe(this.pickInfo());
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

  /** 联机阶段状态行：本端进度 + 对端进度。 */
  private updateNetStatus(): void {
    if (!this.status || (this.phase !== 'fighter' && this.phase !== 'assist')) return;
    const need = this.requiredLocks();
    const l = Math.min(this.localStageLocks().length, need);
    const p = Math.min(this.peerStageLocks().length, need);
    const what = this.phase === 'fighter' ? '角色' : '辅助';
    this.status.text =
      l < need
        ? `选择${what}：已锁定 ${l}/${need}`
        : p < need
          ? `等待对方选择${what}（${p}/${need}）`
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
      { id: null, name: '随机地图' }, // 原版 random 项（random.png）
    ];
  }

  private renderMaps(root: Container): void {
    const ui = this.uiData!;
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
    pic.eventMode = 'static';
    pic.cursor = 'pointer';
    panel.addChild(pic);
    const kuang = new Sprite(this.tex.select_map_kuang!);
    kuang.position.set(...ui.select.mapKuangOffset);
    panel.addChild(kuang);

    // 点缩略图即确认（原版 kuang 语义；随机项确认时解析）
    pic.on('pointertap', () => this.confirmMap(entries[this.mapIndex]!));

    // 左右箭头热区（透明命中区，PNG 坐标）
    const mkHit = (x: number, dir: -1 | 1) => {
      const hit = new Container();
      hit.position.set(x, 105);
      hit.eventMode = 'static';
      hit.cursor = 'pointer';
      const g = new Graphics();
      g.rect(0, 0, 55, 65).fill({ alpha: 0 });
      hit.addChild(g);
      hit.on('pointertap', () => {
        this.mapIndex = (this.mapIndex + dir + entries.length) % entries.length;
        audioOf(this.ctxRef?.ctx!)?.se('menu1', 'swc'); // 原版地图轮盘翻页音
        this.showMapPic(pic, entries);
      });
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
    const url = `${ASSETS}/${this.uiData!.maps.dir}/${e.id ?? 'random'}.png`;
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
    ctx.switchTo(new LoadingScene(this.flow, null));
  }

  update(dtMs: number): void {
    tickTweens(dtMs);
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
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.length = 0;
    clearTweens();
    this.phaseRoot?.destroy({ children: true });
    this.ui?.destroy({ children: true });
    this.ui = null;
  }
}
