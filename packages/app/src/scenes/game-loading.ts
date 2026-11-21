/**
 * 游戏初始化加载页（原版 GameLoadingStage；启动后第一个场景，切片 41）。
 *
 * 演出 = 原版 loading_cover_mc（"绊"封面）：cover_bgimg（804×604 取左上 800×600 舞台区）
 * + 同款 loadingbar_mc @(18,526.4)（bar 组件复用 loading.json bar 段，见 bar.ts）。
 *
 * 装载语义照原版 loadGame（预载 资源→配置→基础资源，消息 `游戏初始化：正在加载xx
 * (n/total)`）；web 端等价 = 启动期把后续场景要用的首批资产预取好再进 Logo：
 *  - 配置：ui.json / select.json / audio.json（ctx.assets 缓存，后续场景免等）；
 *  - 流帧头：logo / title 开头几帧（fetch 预热 HTTP 缓存，Logo/菜单 FrameStream 复用）。
 *
 * 偏离登记：原版步数由资源清单展开（swf 逐个计数）；此处固定 2 步（配置 / 流帧头），
 * 预取失败不阻塞（FrameStream 自带失败重试与跳帧语义）。
 */
import { Assets, Container, Sprite, Texture } from 'pixi.js';
import type { Scene, SceneCtx } from './scene.js';
import { ASSETS, loadAudio, loadLoading, loadSelect, loadUi } from '../data.js';
import { buildLoadingBar, tickLoadingBar, type LoadingBar } from './bar.js';
import { LogoScene } from './logo.js';
import { UI_W } from '../ui.js';
import type { Flow } from '../flow.js';

/** 原版舞台 800×600 在 1000×600 逻辑屏中的横向偏移。 */
const STAGE_W = 800;
const OX = (UI_W - STAGE_W) / 2;

/** 装载完成后的定场时长（原版 loadGameBack 立即 goStage；此处留 400ms 让条走满可读）。 */
const FINISH_HOLD_MS = 400;

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export class GameLoadingScene implements Scene {
  readonly name = 'game-loading';

  private destroyed = false;
  private ui: Container | null = null;
  private barRef: LoadingBar | null = null;
  private barState = { shown: 0, spinAcc: 0, spinFrame: -1 };
  private target = 0;
  private finishedAt = -1;
  private ctxRef: SceneCtx | null = null;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly flow: Flow) {}

  async enter(ctx: SceneCtx): Promise<void> {
    this.ctxRef = ctx;
    const ui = new Container();
    this.ui = ui;
    ctx.root.addChild(ui);

    const data = await loadLoading(ctx.ctx);

    // "绊"封面（原版 loading_cover_mc = cover_bgimg 左上 800×600 舞台区）
    const cover = new Sprite(await Assets.load<Texture>(`${ASSETS}/${data.cover.url}`));
    cover.position.set(OX, 0);
    ui.addChild(cover);

    // 进度条（同款 loadingbar_mc @(18,526.4)；组件复用 bar 段规格）
    const built = await buildLoadingBar(data, OX + data.cover.barPos[0], data.cover.barPos[1]);
    ui.addChild(built.bar);
    this.barRef = built;

    void this.runSteps(ctx);
  }

  // ---------- 装载步骤（原版 loadGame 语义：配置 → 基础资源） ----------

  private async runSteps(ctx: SceneCtx): Promise<void> {
    try {
      const steps: { msg: string; run: () => Promise<void> }[] = [
        {
          msg: '游戏初始化：正在加载配置',
          run: async () => {
            // ctx.assets 缓存：后续场景（Logo/菜单/选人）同 url 免等
            await loadUi(ctx.ctx);
            await loadSelect(ctx.ctx);
            await loadAudio(ctx.ctx);
          },
        },
        {
          msg: '游戏初始化：正在加载游戏资源',
          run: async () => {
            // 流帧头预热：Logo 开场（from 起 3 帧）+ title 开场（introFrom 起 3 帧）；
            // fetch 走 HTTP 缓存，FrameStream 首次拉取命中本地缓存不阻塞播放头
            const uiData = await loadUi(ctx.ctx); // 命中缓存
            const heads: string[] = [];
            for (let i = uiData.logo.from; i < uiData.logo.from + 3; i++) {
              heads.push(`${ASSETS}/${uiData.logo.dir}/${i}.webp`);
            }
            for (let i = uiData.title.introFrom; i < uiData.title.introFrom + 3; i++) {
              heads.push(`${ASSETS}/${uiData.title.dir}/${i}.webp`);
            }
            await Promise.all(
              heads.map(async (url) => {
                try {
                  await fetch(url);
                } catch {
                  // 预取失败不阻塞启动（FrameStream 自带失败跳帧语义）
                }
              }),
            );
          },
        },
      ];
      const total = steps.length;
      for (let i = 0; i < total; i++) {
        if (this.destroyed) return;
        this.barRef!.msg.text = `${steps[i]!.msg}(${i + 1}/${total})`;
        await steps[i]!.run();
        if (this.destroyed) return;
        this.target = (i + 1) / total;
        await nextFrame();
      }
      if (this.destroyed) return;
      this.finishedAt = performance.now();
    } catch (err) {
      if (this.destroyed) return;
      // 启动预载失败：照原版 继续（后续场景各自装载兜底），仅提示
      this.barRef!.msg.text = `初始化异常：${err instanceof Error ? err.message : String(err)}`;
      this.finishedAt = performance.now();
    }
  }

  update(dtMs: number): void {
    if (this.destroyed) return;
    tickLoadingBar(this.barRef, dtMs, this.target, this.barState);
    // 定场后 → 开场徽标（原版 loadGameBack → goStage(LogoStage)）
    if (this.finishedAt >= 0 && performance.now() - this.finishedAt >= FINISH_HOLD_MS) {
      this.finishedAt = -1; // 防重入（switchTo 异步 enter 期间 update 已停，双保险）
      if (this.ctxRef) this.ctxRef.switchTo(new LogoScene(this.flow));
    }
  }

  exit(): void {
    this.destroyed = true;
    this.ui?.destroy({ children: true });
    this.ui = null;
    this.barRef = null;
    this.ctxRef = null;
  }
}
