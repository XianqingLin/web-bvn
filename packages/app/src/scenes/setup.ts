/**
 * 选人场景（切片 14 骨架 → 切片 15 原版化换肤）。
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
 * 骨架期限制（记录，切片 14 沿用）：
 *  - 随机项（random*）仅单机可用——联机两端各自本地解析会选人分叉；
 *  - 原版 more= 形态切换未实现（数据保留，more= 项格框黄色提示）；
 *  - 选人结果交换靠服务器 pick 透传 + 3s 重发（对端未确认前补发）。
 */
import { Assets, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { sendPick, waitPeerPick, type PickInfo, type WsLike } from '@bvn/net';
import type { Scene, SceneCtx } from './scene.js';
import { audioOf } from '../audio.js';
import { tweenOf, tickTweens, clearTweens } from '../anim.js';
import { makeButton, makeLabel, UI_H, UI_W } from '../ui.js';
import { loadSelect, loadUi, uiFaceUrl, type SelectData, type SelectEntry, type UiData } from '../data.js';
import type { Flow, Pick } from '../flow.js';
import { LoadingScene } from './loading.js';

/** 原版舞台 800×600 在 1000×600 逻辑屏中的横向偏移。 */
const STAGE_W = 800;
const OX = (UI_W - STAGE_W) / 2;

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
  /** 已选展示框上的大头像/名字（换选时替换） */
  private bigFace: Sprite | null = null;
  private bigName: Text | null = null;
  /** 当前阶段格子（演出退场动画用；含地图面板） */
  private animCells: { c: Container; x: number; y: number }[] = [];

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
      Object.entries(el).map(async ([k, url]) => [k, await Assets.load<Texture>(`/packages/data/assets/${url}`)] as const),
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

    // dev 直通：自动确认默认选人（ichigo/gaara/KonohaMura）
    if (this.flow.autoPick) this.autoConfirm(ctx);
  }

  /** dev 直通：免点击走完 选角色→选辅助→（地图）→开打。 */
  private autoConfirm(ctx: SceneCtx): void {
    const byId = (list: SelectEntry[], id: string) => list.find((e) => e.id === id) ?? list[0]!;
    this.fighter = byId(this.select!.chars, 'ichigo');
    this.assist = byId(this.select!.assists, 'gaara');
    this.status!.text = `角色：${this.fighter.name}  辅助：${this.assist.name}`;
    if (this.flow.mode === 'solo') {
      this.mapId = 'KonohaMura';
      this.mapChosen = true;
      this.startSolo(ctx);
    } else if (this.flow.player === 1) {
      this.mapId = 'KonohaMura';
      this.mapChosen = true;
      this.beginExchange(ctx);
    } else {
      this.beginExchange(ctx);
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

  private phaseTitle(): string {
    return this.phase === 'fighter' ? '选择角色' : this.phase === 'assist' ? '选择辅助' : '选择地图';
  }

  private renderPhase(ctx: SceneCtx): void {
    this.loadToken++;
    this.cursor = null;
    this.bigFace = null;
    this.bigName = null;
    clearTweens(); // 旧阶段格子的退场补间随 phaseRoot 销毁一并作废
    this.phaseRoot?.destroy({ children: true });
    const root = new Container();
    this.phaseRoot = root;
    this.ui!.addChild(root);

    if (this.status) this.status.text = '';

    // 确认按钮：顶部右侧（底部两角让位原版展示框）
    if (this.phase === 'fighter' || this.phase === 'assist' || this.phase === 'map') {
      const confirmLabel =
        this.phase === 'map'
          ? this.flow.mode === 'net'
            ? '锁定并等待对手'
            : '开始对局'
          : this.phase === 'fighter'
            ? '确认角色'
            : '确认辅助';
      this.mountConfirm(root, confirmLabel, () => this.onConfirm(ctx));
      if (this.phase !== 'fighter') {
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
        this.fighter = e;
        this.status!.text = `角色：${e.name}`;
      });
    } else if (this.phase === 'assist') {
      this.renderGrid(root, this.select!.assists, (e) => {
        this.assist = e;
        this.status!.text = `辅助：${e.name}`;
      });
    } else if (this.phase === 'map') {
      this.renderMaps(root);
    } else {
      // exchange：联机交换中（状态显示在 status）
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
      if (this.flow.mode === 'solo' || this.flow.player === 1) {
        this.phase = 'map';
        this.transitionPhase(ctx, () => this.renderPhase(ctx));
      } else {
        this.transitionPhase(ctx, () => this.beginExchange(ctx));
      }
    } else if (this.phase === 'map') {
      if (!this.mapChosen) {
        this.status!.text = '请先选择地图';
        return;
      }
      if (this.flow.mode === 'net') this.transitionPhase(ctx, () => this.beginExchange(ctx));
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
    onPick: (e: SelectEntry) => void,
  ): void {
    const ui = this.uiData!;
    const token = ++this.loadToken;
    const player = this.flow.player === 2 ? 'p2' : 'p1';
    const disableRandom = this.flow.mode === 'net';

    // 头像纹理批量预载后挂格子（丢失头像类兜底 = 无头像的空格框）
    void Promise.all(
      entries.map(async (e) => {
        const url = uiFaceUrl(ui, e.id, '');
        return [e, url ? await Assets.load<Texture>(url) : null] as const;
      }),
    ).then((loaded) => {
      if (token !== this.loadToken) return; // 阶段已切换

      // 光标（P1 蓝 / P2 粉），PNG 原点 = 格子位 + cursorOffset
      const cursor = new Sprite(this.tex[`cursor_${player}`]!);
      cursor.visible = false;
      this.cursor = cursor;

      let first: [number, number] | null = null;
      this.animCells = [];
      for (const [e, faceTex] of loaded) {
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

        const isRandom = e.comicType < 0;
        if (isRandom && disableRandom) {
          cell.alpha = 0.35;
        } else {
          if (e.more) frame.tint = 0xffee55; // 原版 more= 项黄光提示（形态切换未实现）
          cell.eventMode = 'static';
          cell.cursor = 'pointer';
          cell.on('pointerover', () => {
            // 原版 doHover：光标跟随悬停 + select 音
            cursor.position.set(x + ui.select.cursorOffset[0], y + ui.select.cursorOffset[1]);
            cursor.visible = true;
            audioOf(this.ctxRef?.ctx!)?.se('menu1', 'swc');
          });
          cell.on('pointertap', () => {
            cursor.position.set(x + ui.select.cursorOffset[0], y + ui.select.cursorOffset[1]);
            cursor.visible = true;
            audioOf(this.ctxRef?.ctx!)?.se('menu2', 'swc'); // 原版 sndConfrim
            onPick(e);
            this.refreshBigFace();
          });
        }
        if (!first && !(isRandom && disableRandom)) first = [x, y];
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
        // 展示框最后挂（原版 group 在格子之后 addChild，压在末行格子之上）
        this.mountSelectedBox(root);
        this.refreshBigFace();
      }, 500);
    });
  }

  // ---------- 已选展示框（原版 SelectedFighterGroup 规格） ----------

  /** 底部展示框：大头像 245×62 + 名字；P2 内容容器镜像（原版 selected_item_p2_mc）。 */
  private mountSelectedBox(root: Container): void {
    const ui = this.uiData!;
    const isP2 = this.flow.player === 2;
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
    this.bigFace = face;
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
    this.bigName = name;
    box.addChild(name);
    root.addChild(box);
  }

  /** 换选后刷新展示框大头像/名字（当前阶段对应列表）。 */
  private refreshBigFace(): void {
    const entry = this.phase === 'fighter' ? this.fighter : this.assist;
    if (!this.bigFace || !this.bigName) return;
    if (!entry) return;
    this.bigName.text = entry.name;
    // 长名钳制（切片 14 UI 打磨池）：名字区 233px，超出按比例缩字
    this.bigName.scale.set(Math.min(1, 233 / Math.max(this.bigName.width, 1)));
    const url = uiFaceUrl(this.uiData!, entry.id, '_b');
    if (!url) return;
    const token = this.loadToken;
    void Assets.load<Texture>(url).then((t) => {
      if (token !== this.loadToken) return;
      this.bigFace!.texture = t;
      this.bigFace!.width = 245;
      this.bigFace!.height = 62;
    });
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

  /** 选定当前轮盘地图并推进确认流程（随机项 mapId=null，resolvePick 解析）。 */
  private confirmMap(e: { id: string | null; name: string }): void {
    audioOf(this.ctxRef?.ctx!)?.se('menu2', 'swc'); // 原版 sndConfrim
    this.mapId = e.id;
    this.mapChosen = true;
    this.status!.text = `地图：${e.name}`;
    this.onConfirm(this.ctxRef!);
  }

  private showMapPic(pic: Sprite, entries: { id: string | null; name: string }[]): void {
    const e = entries[this.mapIndex]!;
    const url = `/packages/data/assets/${this.uiData!.maps.dir}/${e.id ?? 'random'}.png`;
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

  /** 确认时的最终选人（随机项仅 solo——联机已禁用）。 */
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
    // 随机地图（仅本端负责地图时解析：solo / 联机 P1）
    const picksMap = this.flow.mode === 'solo' || this.flow.player === 1;
    let mapId: string | null = null;
    if (picksMap && this.mapChosen) {
      mapId = this.mapId ?? rand(this.select!.maps).id;
    }
    return { pick: { fighter: fighter.id, assist: assist.id }, mapId };
  }

  private startSolo(ctx: SceneCtx): void {
    const { pick, mapId } = this.resolvePick();
    this.flow.localPick = pick;
    this.flow.mapId = mapId!;
    ctx.switchTo(new LoadingScene(this.flow, null));
  }

  /** 联机：发本端 pick（3s 重发）+ 等对端 pick → 双方就位开打。 */
  private beginExchange(ctx: SceneCtx): void {
    const { pick, mapId } = this.resolvePick();
    this.flow.localPick = pick;
    this.phase = 'exchange';
    this.renderPhase(ctx);
    const socket = this.socket!;
    const isP1 = this.flow.player === 1;
    this.sendCurrentPick();
    this.status!.text = '等待对手确认选人…';
    void waitPeerPick(socket).then((peer) => {
      this.flow.peerPick = { fighter: peer.fighter, assist: peer.assist };
      // 地图以 P1 选择为准
      const p1Map = isP1 ? mapId! : peer.map;
      if (p1Map) this.flow.mapId = p1Map;
      ctx.switchTo(new LoadingScene(this.flow, socket));
    });
  }

  /** 本端 pick 消息（首发 + 3s 重发共用）。 */
  private sendCurrentPick(): void {
    const p = this.flow.localPick!;
    const isP1 = this.flow.player === 1;
    sendPick(this.socket!, this.flow.player, {
      fighter: p.fighter,
      assist: p.assist,
      ...(isP1 ? { map: this.mapId! } : {}),
    });
  }

  update(dtMs: number): void {
    tickTweens(dtMs);
    // pick 重发（对端未就绪时服务器会丢弃透传，需补发）
    if (this.phase === 'exchange' && this.socket) {
      this.resendTimer += dtMs;
      if (this.resendTimer >= 3000) {
        this.resendTimer = 0;
        this.sendCurrentPick();
      }
    }
  }

  exit(): void {
    this.destroyedFlag = true;
    this.loadToken++;
    this.ctxRef = null;
    clearTweens();
    this.phaseRoot?.destroy({ children: true });
    this.ui?.destroy({ children: true });
    this.ui = null;
  }
}
