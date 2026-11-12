/**
 * 战斗场景（切片 14）：选人结果 → sim 装配 + lockstep/训练对局 → KO 结算浮层。
 * 逻辑自 main.ts（切片 4/6/7 的 dev 页）迁移，双模式：
 *   solo = 训练模式（键盘源、R 重置、ESC 回菜单、KO 后可再来一局）；
 *   net  = lockstep（pick 交换后的双端异角色异辅助配置、KO 结算浮层）。
 */
import { Container, Graphics } from 'pixi.js';
import { Sim, Btn, type ButtonMask, type InputSource, type SimSnapshot } from '@bvn/core';
import {
  INPUT_DELAY,
  lockstart,
  makeConfigHash,
  type LockstepClient,
  type WsLike,
} from '@bvn/net';
import { BattleRenderer } from '@bvn/render';
import type { Scene, SceneCtx } from './scene.js';
import { makeButton, makeLabel, makePanel, UI_H, UI_W } from '../ui.js';
import {
  ASSETS,
  loadAssistPack,
  loadBisha,
  loadFighterPack,
  loadMapPack,
  type AssistPack,
  type FighterPack,
  type MapPack,
} from '../data.js';
import { picksOf, type Flow } from '../flow.js';

const TICK_MS = 1000 / 60;

// ---------- 键盘 → ButtonMask ----------
// J 攻击 K 跳 L 瞬步 U 技 I 必杀；P1 用 WASD，P2 用方向键（同机双窗口各用一套）
const KEYMAP_P1: Record<string, number> = {
  KeyW: Btn.up,
  KeyS: Btn.down,
  KeyA: Btn.left,
  KeyD: Btn.right,
  KeyJ: Btn.attack,
  KeyK: Btn.jump,
  KeyL: Btn.dash,
  KeyU: Btn.skill,
  KeyI: Btn.superSkill,
  KeyO: Btn.assist,
};
const KEYMAP_P2: Record<string, number> = {
  ArrowUp: Btn.up,
  ArrowDown: Btn.down,
  ArrowLeft: Btn.left,
  ArrowRight: Btn.right,
  Digit1: Btn.attack,
  Digit2: Btn.jump,
  Digit3: Btn.dash,
};

function maskFor(keys: Set<string>, map: Record<string, number>): ButtonMask {
  let m = 0;
  for (const k of keys) {
    const bit = map[k];
    if (bit !== undefined) m |= bit;
  }
  return m;
}

/** 本地键盘输入源（solo 模式）：恒即时返回当前按住位图。 */
class KeyboardSource implements InputSource {
  constructor(private readonly keys: Set<string>, private readonly map: Record<string, number>) {}
  frame(_tick: number): { p1: ButtonMask; p2: ButtonMask } {
    return { p1: maskFor(this.keys, this.map), p2: 0 };
  }
}

/** 一场对局的静态装配（enter 时一次装载，重开同包走 assets 缓存）。 */
interface BattleRig {
  map: MapPack;
  p1: FighterPack;
  p2: FighterPack;
  assists: Record<string, AssistPack>;
}

export class BattleScene implements Scene {
  readonly name = 'battle';

  private sim: Sim | null = null;
  private renderer: BattleRenderer | null = null;
  private keyboard: KeyboardSource | null = null;
  private netClient: LockstepClient | null = null;
  private netKeymap: Record<string, number> = KEYMAP_P1;
  private overlay: Container | null = null;
  private koSeen = false;
  private acc = 0;
  private last = 0;
  private simTick = 0;
  private stalledSince = -1;
  private peerLostFlag = false;
  private keys = new Set<string>();
  private ctx: SceneCtx | null = null;
  private rig: BattleRig | null = null;
  private cleanup: (() => void)[] = [];

  constructor(
    private readonly flow: Flow,
    /** 联机 socket（net；solo 为 null） */
    private readonly socket: WsLike | null,
  ) {}

  async enter(ctx: SceneCtx): Promise<void> {
    this.ctx = ctx;
    const { p1, p2 } = picksOf(this.flow);

    // —— 数据装配（assets 缓存，重开同包零开销） ——
    const [p1Pack, p2Pack] = await Promise.all([
      loadFighterPack(ctx.ctx, p1.fighter),
      loadFighterPack(ctx.ctx, p2.fighter),
    ]);
    const assistList = await Promise.all(
      [...new Set([p1.assist, p2.assist])].map((id) => loadAssistPack(ctx.ctx, id)),
    );
    const assists: Record<string, AssistPack> = {};
    for (const a of assistList) assists[a.id] = a;
    const map = await loadMapPack(ctx.ctx, this.flow.mapId);
    this.rig = { map, p1: p1Pack, p2: p2Pack, assists };
    const bisha = await loadBisha(ctx.ctx);

    // —— 渲染装配 ——
    const renderer = new BattleRenderer(ctx.pixi);
    this.renderer = renderer;
    await renderer.load({
      baseUrl: ASSETS,
      fighters: [
        { slot: 1, atlasId: p1Pack.id, formIndex: p1Pack.def.formIndex },
        { slot: 2, atlasId: p2Pack.id, formIndex: p2Pack.def.formIndex },
      ],
      assisters: [
        { ownerId: 1, atlasId: p1.assist },
        { ownerId: 2, atlasId: p2.assist },
      ],
      mapAtlasId: map.id,
      mapBottomOffset: map.pkg.bottomOffset,
      mapBottom: map.pkg.bottom,
      fireAtlases: {
        fighter: Object.fromEntries(
          [p1Pack, p2Pack].filter((p) => p.hasFires).map((p) => [p.id, p.id]),
        ),
        assister: Object.fromEntries(assistList.filter((a) => a.hasFires).map((a) => [a.id, a.id])),
      },
      bisha: { mc: bisha.mc, faces: bisha.faces },
    });

    // —— 键盘 ——
    const onKeyDown = (e: KeyboardEvent) => {
      this.keys.add(e.code);
      if (e.code === 'Escape') this.leave();
    };
    const onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    this.cleanup.push(() => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    });

    if (this.flow.mode === 'solo') {
      this.enterSolo();
    } else {
      await this.enterNet(map);
    }
    this.last = performance.now();
  }

  private enterSolo(): void {
    this.keyboard = new KeyboardSource(this.keys, KEYMAP_P1);
    this.renderer!.setHint(
      'A/D 移动  W跳  S防御  J攻击  L瞬步  U技  I必杀  O召唤辅助  R重置  ESC返回菜单',
    );
    const onR = (e: KeyboardEvent) => {
      if (e.code === 'KeyR') this.resetSolo();
    };
    window.addEventListener('keydown', onR);
    this.cleanup.push(() => window.removeEventListener('keydown', onR));
    this.spawnSim(true);
  }

  private resetSolo(): void {
    this.hideOverlay();
    this.koSeen = false;
    this.spawnSim(true);
  }

  /** sim 装配：选人 → 双角色 + 双辅助注册表（solo 双方同配）。 */
  private spawnSim(training: boolean): void {
    const rig = this.rig!;
    const { p1, p2 } = picksOf(this.flow);
    const st = rig.map.stage;
    this.sim = new Sim({
      seed: 1,
      stage: st,
      training,
      fighters: [
        {
          id: 1,
          x: rig.map.p1Spawn?.x ?? 300,
          y: rig.map.p1Spawn?.y ?? st.groundY,
          def: rig.p1.def,
          forms: rig.p1.forms,
          assistId: p1.assist,
        },
        {
          id: 2,
          x: rig.map.p2Spawn?.x ?? 700,
          y: rig.map.p2Spawn?.y ?? st.groundY,
          def: rig.p2.def,
          forms: rig.p2.forms,
          assistId: p2.assist,
        },
      ],
      assistants: Object.fromEntries(Object.entries(rig.assists).map(([id, a]) => [id, a.def])),
    });
    this.simTick = 0;
  }

  private async enterNet(map: MapPack): Promise<void> {
    const flow = this.flow;
    this.spawnSim(false);
    this.netKeymap = flow.roleKeymapP2 ? KEYMAP_P2 : KEYMAP_P1;
    this.renderer!.setHint(
      `房间 ${flow.room} —— 你是 P${flow.player}（延迟 ${INPUT_DELAY} 帧）  ESC返回菜单`,
    );

    const configHash = makeConfigHash({
      seed: 1,
      stage: map.stage,
      fighters: [picksOf(flow).p1.fighter, picksOf(flow).p2.fighter],
      assists: [picksOf(flow).p1.assist, picksOf(flow).p2.assist],
    });

    const { client } = await lockstart(this.socket as unknown as WsLike, flow.player, {
      room: flow.room,
      configHash,
      onDesync: (tick, a, b) => this.renderer!.setHint(`失步！tick ${tick}（${a} vs ${b}）`),
      onPeerLost: () => {
        this.peerLostFlag = true;
        this.renderer!.setHint('对端断开——冻结等待（对手回到房间可继续）');
      },
      onConfigMismatch: () => this.renderer!.setHint('配置不一致：两端选人/地图必须相同'),
    });
    this.netClient = client;
    client.prime(maskFor(this.keys, this.netKeymap));
  }

  update(dtMs: number): void {
    if (!this.sim || !this.renderer) return;
    const now = performance.now();
    this.acc += Math.min(now - this.last, 100);
    this.last = now;
    let stepped = false;
    while (this.acc >= TICK_MS) {
      let snap: SimSnapshot;
      if (this.netClient) {
        const f = this.netClient.frame(this.simTick);
        if (!f) break; // 远端输入未到：本帧停步等待（lockstep 减速语义）
        snap = this.sim.tick(f);
        this.netClient.afterTick(snap.tick, snap.hash);
        this.netClient.poll(maskFor(this.keys, this.netKeymap));
      } else {
        const f = this.keyboard!.frame(this.simTick);
        if (!f) break; // 键盘源恒非 null，类型完备性保护
        snap = this.sim.tick(f);
      }
      this.renderer.onSnapshot(snap);
      this.simTick++;
      this.acc -= TICK_MS;
      stepped = true;
      this.checkKo(snap.events);
    }
    // 停步看门狗（net）：>5s 无进展提示可能断线（冻结等待，判负归阶段 4）
    if (this.netClient && !this.peerLostFlag) {
      if (!stepped && this.simTick > 0) {
        if (this.stalledSince < 0) this.stalledSince = now;
        else if (now - this.stalledSince > 5000)
          this.renderer.setHint('等待对手输入…（对手可能卡顿或已断线）');
      } else {
        if (this.stalledSince >= 0)
          this.renderer.setHint(
            `房间 ${this.flow.room} —— 你是 P${this.flow.player}（延迟 ${INPUT_DELAY} 帧）  ESC返回菜单`,
          );
        this.stalledSince = -1;
      }
    }
    if (stepped || this.acc > 0) this.renderer.update(this.acc);
  }

  /** KO 表现事件 → 结算浮层（每局一次；训练模式回血不会 KO）。 */
  private checkKo(events: SimSnapshot['events']): void {
    if (this.koSeen) return;
    for (const ev of events) {
      if (ev.type !== 'fighter:ko') continue;
      const fighter = ev.payload['fighter'];
      if (typeof fighter !== 'number') continue;
      this.koSeen = true;
      this.showResult(fighter === 1 ? 2 : 1);
      break;
    }
  }

  // ---------- 结算浮层 ----------

  private showResult(winner: 1 | 2): void {
    const ctx = this.ctx!;
    const overlay = new Container();
    this.overlay = overlay;
    ctx.root.addChild(overlay);

    // 半透明遮罩（吞点击 + 压暗战场）
    const dim = new Graphics();
    dim.rect(0, 0, UI_W, UI_H).fill({ color: 0x000000, alpha: 0.45 });
    dim.eventMode = 'static';
    overlay.addChild(dim);

    const panel = makePanel(420, 240, { color: 0x101828 });
    panel.position.set((UI_W - 420) / 2, (UI_H - 240) / 2);
    overlay.addChild(panel);

    const title = makeLabel(`P${winner} 胜`, { size: 40, color: 0xffd54f, bold: true });
    title.anchor.set(0.5);
    title.position.set(UI_W / 2, (UI_H - 240) / 2 + 60);
    overlay.addChild(title);

    const sub = makeLabel(this.flow.mode === 'solo' ? '训练模式 KO' : '对局结束', {
      size: 14,
      color: 0x7a86a0,
    });
    sub.anchor.set(0.5);
    sub.position.set(UI_W / 2, (UI_H - 240) / 2 + 96);
    overlay.addChild(sub);

    const y = (UI_H - 240) / 2 + 130;
    if (this.flow.mode === 'solo') {
      const again = makeButton('再来一局', () => this.resetSolo());
      again.position.set(UI_W / 2 - 170, y);
      overlay.addChild(again);
    }
    const menuBtn = makeButton('返回菜单', () => this.leave());
    menuBtn.position.set(this.flow.mode === 'solo' ? UI_W / 2 + 20 : UI_W / 2 - 90, y);
    overlay.addChild(menuBtn);
  }

  private hideOverlay(): void {
    this.overlay?.destroy({ children: true });
    this.overlay = null;
  }

  private leave(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.socket?.close();
    void import('./menu.js').then(({ MenuScene }) => ctx.switchTo(new MenuScene(this.flow)));
  }

  exit(): void {
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    this.renderer?.destroy();
    this.renderer = null;
    this.overlay?.destroy({ children: true });
    this.overlay = null;
    this.sim = null;
    this.netClient = null;
  }
}
