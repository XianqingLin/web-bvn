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
import type { BattleRenderer } from '@bvn/render';
import type { Scene, SceneCtx } from './scene.js';
import { makeButton, makeLabel, makePanel, UI_H, UI_W } from '../ui.js';
import type { AssistPack, FighterPack, MapPack } from '../data.js';
import {
  audioOf,
  voiceBindingOf,
  type AudioSubsystem,
  type BattleAudioBinding,
  type TimelineAudioBinding,
} from '../audio.js';
import type { Flow } from '../flow.js';
import { transOut } from './trans.js';

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
  Escape: Btn.back,
};
// 本地双人 P2 完整键位（切片 39）：方向键移动 + 小键盘 1攻击 2跳 3瞬步 4技 5必杀 6辅助。
// e.code 是物理键位，NumLock 开关不影响；与 P1 的 WASD/JKLUIO 物理不冲键。
const KEYMAP_P2: Record<string, number> = {
  ArrowUp: Btn.up,
  ArrowDown: Btn.down,
  ArrowLeft: Btn.left,
  ArrowRight: Btn.right,
  Numpad1: Btn.attack,
  Numpad2: Btn.jump,
  Numpad3: Btn.dash,
  Numpad4: Btn.skill,
  Numpad5: Btn.superSkill,
  Numpad6: Btn.assist,
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

/** 本地双人键盘源（切片 39）：P1/P2 两套键位图同时进 sim。 */
class LocalKeyboardSource implements InputSource {
  constructor(private readonly keys: Set<string>) {}
  frame(_tick: number): { p1: ButtonMask; p2: ButtonMask } {
    return { p1: maskFor(this.keys, KEYMAP_P1), p2: maskFor(this.keys, KEYMAP_P2) };
  }
}

/** roster 成员（team 模式 3+1 的 3 名；1v1 单名）。comicType 进 sim 配置
 *  （换人气继承同系加成判定）与 HUD 能量标签。 */
export interface RosterEntry {
  pack: FighterPack;
  comicType: number;
}

/**
 * fighter id 分配（切片 36）：p1 roster → 1,3,5；p2 roster → 2,4,6（出场序）。
 * 首名 = 开局出战者（id 1/2），其余为 bench（sim 内换人替换 FighterState）。
 */
export function fighterId(side: 1 | 2, index: number): number {
  return side === 1 ? 1 + index * 2 : 2 + index * 2;
}

/** 一场对局的静态装配（切片 31：LoadingScene 分帧装载产物，进战斗零装载）。 */
interface BattleRig {
  map: MapPack;
  /** 出场序 roster（team 模式 ≤3 名；1v1 单名） */
  p1: RosterEntry[];
  p2: RosterEntry[];
  /** per-side 辅助 id（team 模式 3 名成员共用；原版 group 一名 assist） */
  p1Assist: string;
  p2Assist: string;
  assists: Record<string, AssistPack>;
}

/** 装载产物交接（LoadingScene → BattleScene；renderer 已 load + prime）。 */
export interface BattleLoadout {
  rig: BattleRig;
  renderer: BattleRenderer;
}

export class BattleScene implements Scene {
  readonly name = 'battle';

  private sim: Sim | null = null;
  private renderer: BattleRenderer | null = null;
  private keyboard: KeyboardSource | LocalKeyboardSource | null = null;
  private netClient: LockstepClient | null = null;
  private netKeymap: Record<string, number> = KEYMAP_P1;
  private overlay: Container | null = null;
  private koSeen = false;
  private acc = 0;
  private last = 0;
  private simTick = 0;
  /** 开局演出活跃（最新快照 intro ≠ null；ESC 跳过/返回菜单分流） */
  private introActive = false;
  /** 团队回合结束演出活跃（最新快照 roundEnd ≠ null；ESC 不返回菜单） */
  private roundEndActive = false;
  /** 团队 match:over 已消费（每局一次终局流转） */
  private matchOverSeen = false;
  private stalledSince = -1;
  private peerLostFlag = false;
  private keys = new Set<string>();
  private dead = false;
  private ctx: SceneCtx | null = null;
  private audio: AudioSubsystem | null = null;
  private audioBinding: BattleAudioBinding | null = null;
  private timelineBinding: TimelineAudioBinding | null = null;
  private cleanup: (() => void)[] = [];

  constructor(
    private readonly flow: Flow,
    /** 联机 socket（net；solo 为 null） */
    private readonly socket: WsLike | null,
    /** 装载产物（切片 31：LoadingScene 分帧装载 + renderer load/prime） */
    private readonly loadout: BattleLoadout,
  ) {}

  async enter(ctx: SceneCtx): Promise<void> {
    this.ctx = ctx;
    const rig = this.loadout.rig;
    const map = rig.map;
    // 渲染器由 LoadingScene 装载并 prime（块 9）：进场零装载、首帧无黑边
    this.renderer = this.loadout.renderer;
    this.renderer.setStageVisible(true);

    // —— 音频装配（切片 27）：语音绑定 + 对局 BGM（原版 GameStartCtrler playFightBGM 语义） ——
    const audio = audioOf(ctx.ctx);
    this.audio = audio;
    if (audio) {
      const mkSlot = (pack: FighterPack) => ({
        binding: voiceBindingOf(pack.sounds),
        resolve: (cls: string) => audio.voiceUrl(pack.swf, cls),
      });
      this.audioBinding = {
        fighters: Object.fromEntries(
          [...rig.p1.map((e, i) => [fighterId(1, i), mkSlot(e.pack)]),
           ...rig.p2.map((e, i) => [fighterId(2, i), mkSlot(e.pack)])],
        ),
      };
      // 贴帧音绑定（切片 28）：swf 基名寻址（形态角色共用基础包）；辅助缺包 = 无音安全跳过
      this.timelineBinding = {
        fighters: Object.fromEntries(
          [...rig.p1.map((e, i) => [fighterId(1, i), e.pack.swf]),
           ...rig.p2.map((e, i) => [fighterId(2, i), e.pack.swf])],
        ),
        assists: Object.fromEntries(
          Object.keys(rig.assists).map((id) => [id, id]),
        ),
      };
      audio.fightBgm(rig.p1[0]!.pack.id, this.flow.mapId);
    }

    // —— 键盘 ——
    // ESC 双语义：开局演出/团队回合结束演出期间 = 跳过演出（Btn.back 进 sim
    // 位图，lockstep 同步）；演出外 = 返回菜单。introActive/roundEndActive
    // 由快照驱动（update 循环刷新）。
    const onKeyDown = (e: KeyboardEvent) => {
      this.keys.add(e.code);
      if (e.code === 'Escape' && !this.introActive && !this.roundEndActive) this.leave();
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
    } else if (this.flow.mode === 'local') {
      this.enterLocal();
    } else {
      await this.enterNet(map);
    }
    this.last = performance.now();

    // 原版 GameStartCtrler.transOut：加载页合拢的黑幕在此打开（战斗开场演出起）
    transOut(ctx);
  }

  private enterSolo(): void {
    this.keyboard = new KeyboardSource(this.keys, KEYMAP_P1);
    // dev 诊断钩子（headless 冒烟驱动用；只读引用，不影响 sim 确定性）
    (window as unknown as { __bvnSim?: () => Sim | null }).__bvnSim = () => this.sim;
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

  /** 本地双人（切片 39）：真对局（intro 演出 + KO 结算流转），P1/P2 键盘源双路进 sim。 */
  private enterLocal(): void {
    this.keyboard = new LocalKeyboardSource(this.keys);
    this.spawnSim(false);
    this.renderer!.setHint(
      'P1  WASD移动 J攻击 K跳 L瞬步 U技 I必杀 O辅助 | P2  方向键移动 小键盘1攻击 2跳 3瞬步 4技 5必杀 6辅助 | ESC返回菜单',
    );
  }

  /** sim 装配：rig roster → 全员 FighterConfig（team ≤3+≤3 / 1v1 各一名）+
   *  双辅助注册表（solo 双方同配）。team 模式加 teams roster（出场序）——
   *  换人/终局流转在 sim 内确定性推进（切片 36）。
   *  intro：非训练模式带开局特写演出（原版 TRAINING 无开场语义，intro 切片）。 */
  private spawnSim(training: boolean): void {
    const rig = this.loadout.rig;
    const st = rig.map.stage;
    const fcOf = (side: 1 | 2, i: number) => {
      const e = (side === 1 ? rig.p1 : rig.p2)[i]!;
      const spawn =
        side === 1
          ? { x: rig.map.p1Spawn?.x ?? 300, y: rig.map.p1Spawn?.y ?? st.groundY }
          : { x: rig.map.p2Spawn?.x ?? 700, y: rig.map.p2Spawn?.y ?? st.groundY };
      return {
        id: fighterId(side, i),
        ...spawn,
        def: e.pack.def,
        forms: e.pack.forms,
        formIndex: e.pack.forms.indexOf(e.pack.def),
        assistId: side === 1 ? rig.p1Assist : rig.p2Assist,
        comicType: e.comicType,
      };
    };
    const p1Fcs = rig.p1.map((_, i) => fcOf(1, i));
    const p2Fcs = rig.p2.map((_, i) => fcOf(2, i));
    this.sim = new Sim({
      // 服务器权威种子（切片 36 map-roll 广播；net 双端一致，进 configHash）；
      // solo/local 无种子恒 1（replay/batch 基线锚点）
      seed: this.flow.mapSeed ?? 1,
      stage: st,
      training,
      // intro：非训练模式带开局特写演出（原版 TRAINING 无开场语义，intro 切片）；
      // dev 直通 &intro=1 训练局也带演出（冒烟/目检用，正式入口不传）
      intro: !training || new URLSearchParams(location.search).has('intro'),
      fighters: [...p1Fcs, ...p2Fcs],
      // teams 缺省不落键（1v1 零漂移；sim 侧换人/终局以 teams 存在性为门）
      ...(this.flow.team
        ? { teams: { p1: p1Fcs.map((f) => f.id), p2: p2Fcs.map((f) => f.id) } }
        : {}),
      assistants: Object.fromEntries(Object.entries(rig.assists).map(([id, a]) => [id, a.def])),
    });
    this.simTick = 0;
  }

  private async enterNet(map: MapPack): Promise<void> {
    const flow = this.flow;
    const rig = this.loadout.rig;
    this.spawnSim(false);
    this.netKeymap = flow.roleKeymapP2 ? KEYMAP_P2 : KEYMAP_P1;
    this.renderer!.setHint(
      `房间 ${flow.room} —— 你是 P${flow.player}（延迟 ${INPUT_DELAY} 帧）  ESC返回菜单`,
    );

    const configHash = makeConfigHash({
      seed: flow.mapSeed ?? 1,
      stage: map.stage,
      fighters: [
        ...rig.p1.map((e) => e.pack.id),
        ...rig.p2.map((e) => e.pack.id),
      ],
      assists: [rig.p1Assist, rig.p2Assist],
      // 团队 roster 指纹（出场序 id 表；两端由同一 flow 装配，序一致）
      ...(flow.team
        ? {
            teams: {
              p1: rig.p1.map((_, i) => fighterId(1, i)),
              p2: rig.p2.map((_, i) => fighterId(2, i)),
            },
          }
        : {}),
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

  update(_dtMs: number): void {
    if (!this.sim || !this.renderer) return;
    const now = performance.now();
    const frameDt = Math.min(now - this.last, 100); // 本次渲染真实帧时长（钳 100ms 防切后台跳变）
    this.acc += frameDt;
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
      this.introActive = snap.state.intro != null;
      this.roundEndActive = snap.state.roundEnd != null;
      this.audio?.handleSimEvents(snap.events, this.audioBinding);
      this.audio?.handleTimelineFrames(snap, this.timelineBinding);
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
    // 渲染层喂真实帧时长（契约：dtMs = 自上次调用以来的毫秒数）。
    // 此前传 sim 剩余累积器（0~16.7ms 锯齿，均值≈半个 tick）→ 特效/插值以约 0.5×
    // 速度爬行且帧率越低越慢；lockstep 等待时累积器又冲高 → 特效快进。
    this.renderer.update(frameDt);
  }

  /**
   * KO/终局表现事件 → 结算流转（训练模式回血 sim 门控不 KO）。
   * 1v1：KO 演出 1.2s 后进结算立绘（原版 KO → WinnerStage 语义）；
   * 团队：fighter:ko 不切场景（sim 内部走回合结束/换人，切片 36），
   * 终局 match:over 事件后 600ms 进结算立绘（原版 fightFinish 终局流转）；
   * solo（训练模式）：维持对局浮层——训练语义不打断练习（切片 29 偏离登记）。
   */
  private checkKo(events: SimSnapshot['events']): void {
    if (this.flow.team) {
      this.checkMatchOver(events);
      return;
    }
    if (this.koSeen) return;
    for (const ev of events) {
      if (ev.type !== 'fighter:ko') continue;
      const fighter = ev.payload['fighter'];
      if (typeof fighter !== 'number') continue;
      this.koSeen = true;
      const winner = fighter === 1 ? 2 : 1;
      if (this.flow.mode === 'solo') {
        this.showResult(winner);
      } else {
        window.setTimeout(() => {
          if (this.dead) return;
          void import('./winner.js').then(({ WinnerScene }) => {
            this.ctx?.switchTo(new WinnerScene(this.flow, winner, this.socket));
          });
        }, 1200);
      }
      break;
    }
  }

  /** 团队终局事件（原版 fightFinish → WinnerStage）：match:over → 结算立绘。 */
  private checkMatchOver(events: SimSnapshot['events']): void {
    if (this.matchOverSeen) return;
    for (const ev of events) {
      if (ev.type !== 'match:over') continue;
      const winner = ev.payload['winner'];
      if (typeof winner !== 'number') continue;
      this.matchOverSeen = true;
      window.setTimeout(() => {
        if (this.dead) return;
        void import('./winner.js').then(({ WinnerScene }) => {
          this.ctx?.switchTo(new WinnerScene(this.flow, winner as 1 | 2, this.socket));
        });
      }, 600);
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
    this.dead = true;
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
