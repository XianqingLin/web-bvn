/**
 * 开场徽标演出（切片 29 菜单流打磨）。
 * 原版 LogoStage：common_ui logo_movie（sprite 26，66 帧 @30fps 画布=舞台 800×600），
 * gotoAndPlay(2) 播到帧 66 帧脚本 stop()+COMPLETE → 进主菜单（无音频、无跳过——原版如此，
 * 全程 ~2.1s）。本场景为主菜单前的固定开场。
 *
 * Tier 2 tween 化（DESIGN §4.8，2026-11-25 目检通过收编）：原版 logo_movie 实为白底 +
 * logo 图形逐帧 CXFORM 白↔本色互补渐变（mult+add ≡ 1，alpha 恒 1，无 blend mode），
 * 互补渐变作用于压平合成帧与白底上 alpha 淡入淡出逐像素同式 → 运行时恒等定格帧单贴图
 * （白底合成）+ alpha 关键帧补间；白底 Graphics 承接原版 d1 白矩形（末帧空台为白底，
 * 旧逐帧流烘焙为透明曾闪黑一帧，本实现回归原版语义）。
 */
import { Assets, Graphics, Sprite, Texture } from 'pixi.js';
import type { Scene, SceneCtx } from './scene.js';
import { ASSETS, loadUi, type UiData } from '../data.js';
import { MenuScene } from './menu.js';
import type { Flow } from '../flow.js';

/** 原版 800×600 舞台在 1000×600 逻辑屏内的横向偏移。 */
const OX = (1000 - 800) / 2;

/** 关键帧线性插值：keys = [帧号(1 起), alpha] 升序。 */
const alphaAt = (keys: [number, number][], f: number): number => {
  const first = keys[0];
  if (!first) return 1;
  if (f <= first[0]) return first[1];
  for (let i = 1; i < keys.length; i++) {
    const k0 = keys[i - 1]!;
    const k1 = keys[i]!;
    if (f <= k1[0]) {
      return k1[0] === k0[0] ? k1[1] : k0[1] + ((k1[1] - k0[1]) * (f - k0[0])) / (k1[0] - k0[0]);
    }
  }
  return keys[keys.length - 1]![1];
};

export class LogoScene implements Scene {
  readonly name = 'logo';

  private sprite: Sprite | null = null;
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

    // 白底 = 原版 d1 白矩形铺满舞台；贴图 = 恒等定格帧压平合成（game-loading 已预载）
    const white = new Graphics();
    white.rect(OX, 0, 800, 600).fill({ color: 0xffffff });
    ctx.root.addChild(white);
    const sprite = new Sprite(await Assets.load<Texture>(`${ASSETS}/${logo.tween.texture}`));
    sprite.position.set(OX - logo.stageOriginInFrame[0], -logo.stageOriginInFrame[1]);
    this.sprite = sprite;
    ctx.root.addChild(sprite);
    this.frame = logo.from;
    this.acc = 0;
  }

  update(dtMs: number): void {
    if (!this.uiData || !this.sprite || this.destroyed) return;
    const logo = this.uiData.logo;
    this.acc += dtMs;
    // 播放头单调推进（单贴图无逐帧加载，无停帧等待），alpha 按关键帧插值
    this.frame = Math.min(logo.stop, logo.from + Math.floor((this.acc * logo.fps) / 1000));
    this.sprite.alpha = alphaAt(logo.tween.keys, this.frame);
    if (this.frame >= logo.stop) {
      // 帧脚本 stop()+COMPLETE → 进主菜单
      this.destroyed = true;
      if (this.ctx) this.ctx.switchTo(new MenuScene(this.flow));
    }
  }

  exit(): void {
    this.destroyed = true;
  }
}
