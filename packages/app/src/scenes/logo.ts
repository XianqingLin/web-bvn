/**
 * 开场徽标演出（切片 29 菜单流打磨）。
 * 原版 LogoStage：common_ui logo_movie（sprite 26，66 帧 @30fps 画布=舞台 800×600），
 * gotoAndPlay(2) 播到帧 66 帧脚本 stop()+COMPLETE → 进主菜单（无音频、无跳过——原版如此，
 * 全程 ~2.1s）。本场景为主菜单前的固定开场。
 */
import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { Scene, SceneCtx } from './scene.js';
import { loadUi, type UiData } from '../data.js';
import { FrameStream } from './stream.js';
import type { Flow } from '../flow.js';

/** 原版 800×600 舞台在 1000×600 逻辑屏内的横向偏移。 */
const OX = (1000 - 800) / 2;

export class LogoScene implements Scene {
  readonly name = 'logo';

  private stream: FrameStream | null = null;
  private frameSprite: Sprite | null = null;
  private uiData: UiData | null = null;
  private frame = 0;
  private acc = 0;
  private destroyed = false;
  private ctx: SceneCtx | null = null;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly flow: Flow) {}

  async enter(ctx: SceneCtx): Promise<void> {
    this.ctx = ctx;
    const bg = new Graphics();
    bg.rect(0, 0, 1000, 600).fill({ color: 0x000000 });
    ctx.root.addChild(bg);

    this.uiData = await loadUi(ctx.ctx);
    const logo = this.uiData.logo;

    // 画布 = 舞台大小：挂载位 = 舞台位 - stageOriginInFrame（同 menu.ts title 语义）
    const sprite = new Sprite();
    sprite.position.set(OX - logo.stageOriginInFrame[0], -logo.stageOriginInFrame[1]);
    this.frameSprite = sprite;
    ctx.root.addChild(sprite);

    this.stream = new FrameStream({ dir: logo.dir, frames: logo.frames });
    this.stream.ensure(logo.from, 5);
    // 等首帧就绪再开播（黑底期间）
    for (;;) {
      if (this.stream.ensure(logo.from, 3)) {
        const tex = this.stream.get(logo.from);
        if (tex) {
          this.frameSprite.texture = tex;
          break;
        }
      }
      if (this.destroyed) return;
      await new Promise((r) => window.setTimeout(r, 50));
    }
    this.frame = logo.from;
    this.acc = 0;
  }

  update(dtMs: number): void {
    if (!this.stream || !this.frameSprite || !this.uiData || this.destroyed) return;
    const logo = this.uiData.logo;
    this.acc += dtMs;
    const f = Math.min(logo.stop, logo.from + Math.floor((this.acc * logo.fps) / 1000));
    if (f !== this.frame) {
      const tex = this.stream.get(f);
      if (tex) {
        this.frame = f;
        this.frameSprite.texture = tex;
      } else if (this.stream.failed(f)) {
        this.frame = f; // 失败帧视为已过（保持上一帧画面，防卡死）
      } else {
        this.stream.ensure(f, 4);
      }
    }
    if (this.frame >= logo.stop) {
      // 帧脚本 stop()+COMPLETE → 进主菜单
      this.destroyed = true;
      void import('./menu.js').then(({ MenuScene }) => {
        if (this.ctx) this.ctx.switchTo(new MenuScene(this.flow));
      });
      return;
    }
    // 常驻窗口：身后 2 帧、身前 6 帧
    this.stream.release((i) => i >= this.frame - 2 && i <= this.frame + 6);
    this.stream.ensure(this.frame + 1, 4);
  }

  exit(): void {
    this.destroyed = true;
    this.stream?.dispose();
    this.stream = null;
  }
}
