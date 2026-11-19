/**
 * 结算立绘（切片 29 菜单流打磨）。
 *
 * 原版 WinnerStage/loading.swf winner_stg_mc（sprite 95，93 帧 @30fps）语义：
 *   - 播帧 1..92 定格（帧 92 帧脚本 stop()+COMPLETE；帧 93 "destory" 黑帧不烘焙）；
 *   - 帧 92 内含舞台视觉：WINNER 标题 / 三个黄色立绘格 f0(中央)/f1/f2(左右) /
 *     txtmc 台词气泡 / MORE GAMES·CONTINUE·EXIT 按钮板（视觉烘焙进帧 PNG，运行时只挂热区）；
 *   - 帧 92 后 txtmc.gotoAndPlay(2)：气泡长大（帧 2..10）→ 台词显示（SimHei 18 黑、居中、行距 5）；
 *   - 胜者立绘 = fighter.xml face/@win_cls（ui.faces 寻址）挂 f0，无立绘隐藏（原版 f0.visible=false）；
 *   - 音频：BGM(null) → playAssetSound('win') 一发 → 6.5s 后 BGM('winloop')；
 *   - 按钮：hover sndSelect / 点击 sndConfrim。
 *
 * 偏离（重构取舍，PROGRESS 登记）：
 *   - MORE GAMES（外部链接）与 scoremc 计分板不挂载（无分数系统/无外链需求）；
 *   - net 模式隐藏 CONTINUE（两端无法同步重开，回菜单各自退出）；
 *   - EXIT 略去原版二次确认对话框；
 *   - 单机训练模式不进结算页（训练语义不打断，维持对局浮层）。
 */
import { Assets, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { Scene, SceneCtx } from './scene.js';
import { audioOf } from '../audio.js';
import { makeLabel, UI_H, UI_W } from '../ui.js';
import { ASSETS, loadSelect, loadUi, type SelectEntry, type UiData } from '../data.js';
import { picksOf, type Flow } from '../flow.js';
import { FrameStream } from './stream.js';
import type { WsLike } from '@bvn/net';
import { transIn } from './trans.js';

/** 原版 800×600 舞台在 1000×600 逻辑屏内的横向偏移。 */
const OX = (UI_W - 800) / 2;

/** 按钮/台词热区规格（原版舞台坐标，帧 PNG 像素实测 −stageOriginInFrame 反推）。 */
const ZONES = {
  /** CONTINUE 按钮（ch94 内 x 298..485） */
  cont: [298, 519, 195, 72],
  /** EXIT 按钮（ch94 内 x 704..765；命中区按可点性放宽） */
  exit: [695, 519, 90, 72],
} as const;

export class WinnerScene implements Scene {
  readonly name = 'winner';

  private stream: FrameStream | null = null;
  private bubbleStream: FrameStream | null = null;
  private bubbleSprite: Sprite | null = null;
  private frameSprite: Sprite | null = null;
  private uiData: UiData | null = null;
  private frame = 0;
  private acc = 0;
  private bubbleAcc = 0;
  private bubbleFrame = 0;
  private stopped = false;
  private bubbleDone = false;
  private destroyed = false;
  private ctx: SceneCtx | null = null;
  private select: SelectEntry[] | null = null;
  private controls: Container | null = null;
  private readonly timers: number[] = [];
  private readonly onKey = (e: KeyboardEvent) => this.handleKey(e);

  constructor(
    private readonly flow: Flow,
    /** 胜者位次（1/2） */
    private readonly winner: 1 | 2,
    /** 联机 socket（EXIT 时关闭；dev 为 null） */
    private readonly socket: WsLike | null,
  ) {}

  async enter(ctx: SceneCtx): Promise<void> {
    this.ctx = ctx;
    const audio = audioOf(ctx.ctx);
    audio?.bgm(null); // 原版 WinnerStage.build BGM(null)
    audio?.se('win', 'bgm'); // playAssetSound('win')：bgm 资源走 SE 通道一发
    this.timers.push(
      window.setTimeout(() => {
        if (!this.destroyed) audio?.bgm('winloop');
      }, 6500),
    );

    // 黑底（帧 PNG 未就绪时 / 舞台外区域）
    const bg = new Graphics();
    bg.rect(0, 0, UI_W, UI_H).fill({ color: 0x000000 });
    ctx.root.addChild(bg);

    const [uiData, select] = await Promise.all([loadUi(ctx.ctx), loadSelect(ctx.ctx)]);
    this.uiData = uiData;
    this.select = select.chars;
    const w = uiData.winner;

    // 帧 PNG 挂载：舞台位 - stageOriginInFrame（winner mc 空间 = 舞台空间）
    const frameSprite = new Sprite();
    frameSprite.position.set(OX - w.stageOriginInFrame[0], -w.stageOriginInFrame[1]);
    this.frameSprite = frameSprite;
    ctx.root.addChild(frameSprite);

    this.stream = new FrameStream({ dir: w.dir, frames: w.frames });
    this.stream.ensure(1, 5);
    // 等首帧就绪再开播
    for (;;) {
      if (this.stream.ensure(1, 3)) {
        const tex = this.stream.get(1);
        if (tex) {
          frameSprite.texture = tex;
          break;
        }
      }
      if (this.destroyed) return;
      await new Promise((r) => window.setTimeout(r, 50));
    }
    this.frame = 1;
    this.acc = 0;

    // 键盘：Enter=CONTINUE / Esc=EXIT
    window.addEventListener('keydown', this.onKey);
    ctx.root.once('destroyed', () => window.removeEventListener('keydown', this.onKey));
  }

  update(dtMs: number): void {
    if (!this.stream || !this.frameSprite || !this.uiData || this.destroyed) return;
    const w = this.uiData.winner;

    if (!this.stopped) {
      // 主时间轴：播 1..92 定格
      this.acc += dtMs;
      const f = Math.min(w.stop, 1 + Math.floor((this.acc * w.fps) / 1000));
      if (f !== this.frame) {
        const tex = this.stream.get(f);
        if (tex) {
          this.frame = f;
          this.frameSprite.texture = tex;
        } else if (this.stream.failed(f)) {
          this.frame = f; // 失败帧视为已过
        } else {
          this.stream.ensure(f, 4);
        }
      }
      if (this.frame >= w.stop) {
        this.stopped = true;
        this.onStopped();
      }
      // 常驻窗口
      this.stream.release((i) => i >= this.frame - 2 && i <= this.frame + 6);
      this.stream.ensure(this.frame + 1, 4);
      return;
    }

    // 气泡长大动画（txtmc.gotoAndPlay(2) 语义：帧 2..10 后台词）
    if (!this.bubbleDone && this.bubbleStream && this.bubbleSprite) {
      const b = this.uiData.winner.bubble;
      this.bubbleAcc += dtMs;
      const f = Math.min(b.stop, b.from + Math.floor((this.bubbleAcc * b.fps) / 1000));
      if (f !== this.bubbleFrame) {
        const tex = this.bubbleStream.get(f);
        if (tex) {
          this.bubbleFrame = f;
          this.bubbleSprite.texture = tex;
        }
        this.bubbleStream.ensure(f + 1, 3);
      }
      if (this.bubbleFrame >= b.stop) {
        this.bubbleDone = true;
        // 气泡定格在末帧：显示中纹理保留（不随 dispose 摧毁，否则渲染崩溃）
        const shown = this.bubbleFrame;
        this.bubbleStream.dispose((i) => i === shown);
        this.bubbleStream = null;
        this.showSay();
      }
    }
  }

  /** 帧 92 定格后的装配：立绘 / 气泡 / 按钮。 */
  private onStopped(): void {
    const ctx = this.ctx!;
    const w = this.uiData!.winner;
    const audio = audioOf(ctx.ctx);

    // —— 胜者立绘（f0 300×250 @(0,0)；无立绘隐藏，原版 f0.visible=false） ——
    const entry = this.winnerEntry();
    void (async () => {
      if (!entry?.win) return;
      const file = this.uiData!.faces[entry.win];
      if (!file) return;
      const tex = await Assets.load<Texture>(`${ASSETS}/ui/faces/${file}`);
      if (this.destroyed) return;
      const face = new Sprite(tex);
      face.width = 300;
      face.height = 250;
      const [fx, fy] = w.placements.f0;
      face.position.set(OX + fx, fy);
      this.ctx!.root.addChild(face);
    })();

    // —— 台词气泡长大动画（txtmc 位置，画布原点 (0,0)） ——
    const b = w.bubble;
    const bubbleSprite = new Sprite();
    const [tx, ty] = w.placements.txtmc;
    bubbleSprite.position.set(OX + tx, ty);
    this.bubbleSprite = bubbleSprite;
    ctx.root.addChild(bubbleSprite);
    this.bubbleStream = new FrameStream({ dir: b.dir, frames: b.stop });
    this.bubbleStream.ensure(b.from, 3);
    this.bubbleFrame = b.from;
    this.bubbleAcc = 0;

    // —— 按钮热区（视觉烘焙在帧 PNG 内；hover/click 音效原版语义） ——
    const controls = new Container();
    this.controls = controls;
    ctx.root.addChild(controls);
    const netHideCont = this.flow.mode === 'net';
    if (!netHideCont) this.mountZone(controls, ZONES.cont, () => this.onContinue());
    this.mountZone(controls, ZONES.exit, () => this.onExit());

    // net 模式提示（CONTINUE 不可用的说明）
    if (netHideCont) {
      const hint = makeLabel('对局结束——按 ESC 或点击 EXIT 返回菜单', { size: 14, color: 0x7a86a0 });
      hint.anchor.set(0.5, 0);
      hint.position.set(OX + ZONES.cont[0] + ZONES.cont[2] / 2, ZONES.cont[1] + 20);
      controls.addChild(hint);
    }
    void audio;
  }

  /** 台词：says 随机一条，`|` → 换行，SimHei 18 黑居中（原版 setText 语义）。 */
  private showSay(): void {
    const entry = this.winnerEntry();
    if (!entry || entry.says.length === 0 || !this.uiData) return;
    const say = entry.says[Math.floor(Math.random() * entry.says.length)]!;
    const w = this.uiData.winner;
    const [tx, ty] = w.placements.txtmc;
    const text = new Text(say.replaceAll('|', '\n'), {
      fontFamily: '"SimHei", "Microsoft YaHei", sans-serif',
      fontSize: 18,
      fill: 0x000000,
      align: 'center',
      lineHeight: 23, // 原版 leading 5 + 18px
      breakWords: true,
      wordWrapWidth: 548,
    });
    // 原版 txt.y = 10 + (90 - txt.height) / 2（文字区 548×90 起 (33,10)）
    text.position.set(OX + tx + 33 + (548 - text.width) / 2, ty + 10 + (90 - text.height) / 2);
    this.ctx!.root.addChild(text);
  }

  /** 透明热区（hover 音 menu1 / 点击音 menu2，原版 sndSelect/sndConfrim）。 */
  private mountZone(parent: Container, [x, y, wd, ht]: readonly [number, number, number, number], onClick: () => void): void {
    const hit = new Graphics();
    hit.rect(x, y, wd, ht).fill({ alpha: 0 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerover', () => audioOf(this.ctx?.ctx!)?.se('menu1', 'swc'));
    hit.on('pointertap', () => {
      audioOf(this.ctx?.ctx!)?.se('menu2', 'swc');
      onClick();
    });
    parent.addChild(hit);
  }

  /** 胜者 select 元数据（select.json chars；随机项在战斗前已解析为具体角色 id）。 */
  private winnerEntry(): SelectEntry | null {
    const { p1, p2 } = picksOf(this.flow);
    const fighterId = this.winner === 1 ? p1.fighter : p2.fighter;
    return this.select?.find((c) => c.id === fighterId) ?? null;
  }

  private onContinue(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // net 不显示 CONTINUE（onStopped 已隐藏）；dev/solo 重开同一 flow（经加载画面重装载）
    void import('./loading.js').then(({ LoadingScene }) => {
      if (this.ctx) transIn(this.ctx, () => this.ctx!.switchTo(new LoadingScene(this.flow, this.socket)));
    });
  }

  private onExit(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.socket?.close();
    void import('./menu.js').then(({ MenuScene }) => {
      if (this.ctx) this.ctx.switchTo(new MenuScene(this.flow));
    });
  }

  private handleKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (!this.stopped) return; // 播放期不响应（原版 COMPLETE 后才有按钮）
    if (e.key === 'Enter') {
      e.preventDefault();
      if (this.flow.mode !== 'net') this.onContinue();
    } else if (e.key === 'Escape' || e.key === 'Backspace') {
      e.preventDefault();
      this.onExit();
    }
  }

  exit(): void {
    this.destroyed = true;
    for (const id of this.timers) window.clearTimeout(id);
    window.removeEventListener('keydown', this.onKey);
    this.stream?.dispose();
    this.stream = null;
    this.bubbleStream?.dispose();
    this.bubbleStream = null;
  }
}
