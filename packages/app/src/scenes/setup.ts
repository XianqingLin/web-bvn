/**
 * 选人场景（切片 14 骨架）：角色网格 → 辅助网格 → 地图（联机 P1 专属）→
 * 确认 → 联机 pick 交换 → 战斗场景。
 *
 * 骨架期限制（记录）：
 *  - 随机项（random*）仅单机可用——联机两端各自本地解析会选人分叉；
 *  - 原版 more= 形态切换未实现（数据保留在 select.json）；
 *  - 选人结果交换靠服务器 pick 透传 + 3s 重发（对端未确认前补发）。
 */
import { Container, Graphics, Text } from 'pixi.js';
import { sendPick, waitPeerPick, type PickInfo, type WsLike } from '@bvn/net';
import type { Scene, SceneCtx } from './scene.js';
import { makeButton, makeLabel, makePanel, UI_H, UI_W } from '../ui.js';
import { loadSelect, type SelectData, type SelectEntry } from '../data.js';
import type { Flow, Pick } from '../flow.js';
import { BattleScene } from './battle.js';

const X0 = 36;
const Y0 = 96;
const CELL_W = 88;
const CELL_H = 38;
const GAP = 6;

export class SetupScene implements Scene {
  readonly name = 'setup';

  private select: SelectData | null = null;
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

  constructor(
    private readonly flow: Flow,
    /** 联机 socket（net 场景交接；solo 省略） */
    private readonly socket: WsLike | null = null,
  ) {}

  async enter(ctx: SceneCtx): Promise<void> {
    const ui = new Container();
    this.ui = ui;
    ctx.root.addChild(ui);
    ui.addChild(makePanel(UI_W, UI_H, { color: 0x0a0e1a, alpha: 1 }));

    this.select = await loadSelect(ctx.ctx);
    // 空连接兜底（solo 直进/数据缺失时仍有最小集）
    if (this.select.chars.length === 0) throw new Error('select.json 为空：先跑 tools/select-pack');

    const title = makeLabel(this.flow.mode === 'net' ? `选人（房间 ${this.flow.room}）` : '选人', {
      size: 28,
      bold: true,
    });
    title.position.set(X0, 28);
    ui.addChild(title);

    const status = makeLabel('', { size: 15, color: 0xffd54f });
    status.position.set(X0, 66);
    this.status = status;
    ui.addChild(status);

    const backBtn = makeButton('返回', () => this.back(ctx), { w: 90, h: 34, size: 14 });
    backBtn.position.set(UI_W - 120, 28);
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

  private renderPhase(ctx: SceneCtx): void {
    this.phaseRoot?.destroy({ children: true });
    const root = new Container();
    this.phaseRoot = root;
    this.ui!.addChild(root);

    const step = (n: number, label: string, active: boolean) => {
      return makeLabel(`〔${n}〕${label}`, {
        size: 14,
        color: active ? 0xffffff : 0x55607a,
        bold: active,
      });
    };
    const steps = new Container();
    let sx = X0;
    const labels: [number, string, boolean][] = [
      [1, '选角色', this.phase === 'fighter'],
      [2, '选辅助', this.phase === 'assist'],
      [3, '选地图', this.phase === 'map'],
    ];
    for (const [n, label, active] of labels) {
      const t = step(n, label, active);
      t.position.set(sx, UI_H - 118);
      sx += 130;
      steps.addChild(t);
    }
    root.addChild(steps);

    if (this.phase === 'fighter') {
      this.renderGrid(root, this.select!.chars, (e) => {
        this.fighter = e;
        this.status!.text = `角色：${e.name}`;
      }, this.flow.mode === 'net');
      this.mountConfirm(root, '确认角色', () => {
        this.phase = 'assist';
        this.renderPhase(ctx);
      });
    } else if (this.phase === 'assist') {
      this.renderGrid(root, this.select!.assists, (e) => {
        this.assist = e;
        this.status!.text = `辅助：${e.name}`;
      }, this.flow.mode === 'net');
      const backBtn = makeButton('上一步', () => {
        this.phase = 'fighter';
        this.renderPhase(ctx);
      }, { w: 90, h: 34, size: 14 });
      backBtn.position.set(UI_W - 220, UI_H - 52);
      root.addChild(backBtn);
      this.mountConfirm(root, '确认辅助', () => {
        if (this.flow.mode === 'solo') {
          this.phase = 'map';
          this.renderPhase(ctx);
        } else {
          // 联机：P1 先选地图（P2 直接交换）
          if (this.flow.player === 1) {
            this.phase = 'map';
            this.renderPhase(ctx);
          } else {
            this.beginExchange(ctx);
          }
        }
      });
    } else if (this.phase === 'map') {
      this.renderMaps(root, ctx);
      const backBtn = makeButton('上一步', () => {
        this.phase = 'assist';
        this.renderPhase(ctx);
      }, { w: 90, h: 34, size: 14 });
      backBtn.position.set(UI_W - 220, UI_H - 52);
      root.addChild(backBtn);
      this.mountConfirm(root, this.flow.mode === 'net' ? '锁定并等待对手' : '开始对局', () => {
        if (this.flow.mode === 'net') this.beginExchange(ctx);
        else this.startSolo(ctx);
      });
    } else {
      // exchange：联机交换中（状态显示在 status）
    }
  }

  private mountConfirm(root: Container, label: string, onClick: () => void): void {
    const btn = makeButton(label, () => {
      if (!this.ready()) {
        this.status!.text = '请先完成本步选择';
        return;
      }
      onClick();
    }, { w: 150 });
    btn.position.set(UI_W - 170, UI_H - 56);
    root.addChild(btn);
  }

  /** 当前阶段的完成校验（确认按钮按步放行）。 */
  private ready(): boolean {
    if (this.phase === 'fighter') return this.fighter !== null;
    if (this.phase === 'assist') return this.assist !== null;
    if (this.phase === 'map') return this.mapChosen;
    return true;
  }

  // ---------- 网格 ----------

  private renderGrid(
    root: Container,
    entries: SelectEntry[],
    onPick: (e: SelectEntry) => void,
    disableRandom: boolean,
  ): void {
    let selectedGfx: Graphics | null = null;
    for (const e of entries) {
      const cell = new Container();
      const [dx, dy] = (e.offset ?? '0,0').split(',').map(Number);
      cell.position.set(X0 + e.col * (CELL_W + GAP) + (dx || 0), Y0 + e.row * (CELL_H + GAP) + (dy || 0));
      const bg = new Graphics();
      bg.rect(0, 0, CELL_W, CELL_H).fill({ color: 0x1c2a44, alpha: 0.95 });
      bg.stroke({ width: 1, color: 0x3a4a66 }).rect(0.5, 0.5, CELL_W - 1, CELL_H - 1);
      const t = makeLabel(e.name, { size: 13 });
      t.anchor.set(0.5);
      t.position.set(CELL_W / 2, CELL_H / 2);
      cell.addChild(bg, t);
      const isRandom = e.comicType < 0;
      if (isRandom && disableRandom) {
        bg.alpha = 0.35;
        t.alpha = 0.5;
      } else {
        cell.eventMode = 'static';
        cell.cursor = 'pointer';
        cell.on('pointerover', () => bg.fill({ color: 0x2a3c5e, alpha: 0.95 }));
        cell.on('pointerout', () => bg.fill({ color: 0x1c2a44, alpha: 0.95 }));
        cell.on('pointertap', () => {
          if (selectedGfx) selectedGfx.visible = false;
          selectedGfx = cell.getChildByName('hl') as Graphics;
          if (selectedGfx) selectedGfx.visible = true;
          onPick(e);
        });
        const hl = new Graphics();
        hl.name = 'hl';
        hl.rect(0, 0, CELL_W, CELL_H).stroke({ width: 2, color: 0xffd54f });
        hl.visible = false;
        cell.addChild(hl);
      }
      root.addChild(cell);
    }
  }

  private renderMaps(root: Container, _ctx: SceneCtx): void {
    // 5 列 × 3 行地图按钮 + 随机
    const entries: { id: string | null; name: string }[] = [
      ...this.select!.maps.map((m) => ({ id: m.id as string | null, name: m.name })),
      { id: null, name: '随机地图' },
    ];
    const cols = 5;
    const w = 168;
    const h = 46;
    let selectedGfx: Graphics | null = null;
    entries.forEach((e, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cell = new Container();
      cell.position.set(X0 + col * (w + GAP), Y0 + row * (h + GAP));
      const bg = new Graphics();
      bg.rect(0, 0, w, h).fill({ color: 0x1c2a44, alpha: 0.95 });
      bg.stroke({ width: 1, color: 0x3a4a66 }).rect(0.5, 0.5, w - 1, h - 1);
      const t = makeLabel(e.name, { size: 15 });
      t.anchor.set(0.5);
      t.position.set(w / 2, h / 2);
      cell.addChild(bg, t);
      cell.eventMode = 'static';
      cell.cursor = 'pointer';
      cell.on('pointertap', () => {
        this.mapId = e.id;
        this.mapChosen = true;
        if (selectedGfx) selectedGfx.visible = false;
        selectedGfx = cell.getChildByName('hl') as Graphics;
        if (selectedGfx) selectedGfx.visible = true;
        this.status!.text = `地图：${e.name}`;
      });
      const hl = new Graphics();
      hl.name = 'hl';
      hl.rect(0, 0, w, h).stroke({ width: 2, color: 0xffd54f });
      hl.visible = false;
      cell.addChild(hl);
      root.addChild(cell);
    });
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
    ctx.switchTo(new BattleScene(this.flow, null));
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
      ctx.switchTo(new BattleScene(this.flow, socket));
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
    this.phaseRoot?.destroy({ children: true });
    this.ui?.destroy({ children: true });
    this.ui = null;
  }
}
