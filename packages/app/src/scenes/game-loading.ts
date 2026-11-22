/**
 * 游戏初始化加载页（原版 GameLoadingStage；启动后第一个场景，切片 41）。
 *
 * 演出 = 原版 loading_cover_mc（"绊"封面）：cover_bgimg（804×604 取左上 800×600 舞台区）
 * + 同款 loadingbar_mc @(18,526.4)（bar 组件复用 loading.json bar 段，见 bar.ts）。
 *
 * 装载语义照原版 loadGame（预载 资源→配置→基础资源）；web 端等价 = 启动期把后续
 * 场景要用的首批资产预取好再进 Logo：
 *  - 配置：ui.json / select.json / audio.json（ctx.assets 缓存，后续场景免等）；
 *  - 主菜单动画全量预载（2026-11-22 由"头几帧预热"升级）：logo + title 全部显示帧
 *    先行下完再进 Logo。原先只预热头 3 帧、进菜单后 FrameStream 边播边下载，首访
 *    部署环境（跨境低带宽）供不上 30fps，菜单动画停帧追下载——等待不可理解；挪进
 *    加载页后等待集中且有进度条，播放期只走本地 HTTP 缓存不再占网络。
 *
 * 偏离登记：原版步数由资源清单展开（swf 逐个计数）、消息 `游戏初始化：正在加载xx
 * (n/total)`；此处 2 步（配置 / 主菜单动画预载），计数语义改为步内细进度
 * （预载步 = 帧数计数，进度条按步权重推进）；预取失败不阻塞（FrameStream 自带
 * 失败重试与跳帧语义）。
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
      // 步权重 = 进度条占比：配置秒级；主菜单动画 ~8.5MB/139 帧，首访占大头。
      // fine = 步内细进度（done/count），计数语义替代原版 (n/total) 步计数。
      const steps: {
        msg: string;
        share: number;
        run: (fine: (done: number, count: number) => void) => Promise<void>;
      }[] = [
        {
          msg: '游戏初始化：正在加载配置',
          share: 0.05,
          run: async () => {
            // ctx.assets 缓存：后续场景（Logo/菜单/选人）同 url 免等
            await loadUi(ctx.ctx);
            await loadSelect(ctx.ctx);
            await loadAudio(ctx.ctx);
          },
        },
        {
          msg: '游戏初始化：正在加载主菜单动画',
          share: 0.95,
          run: async (fine) => {
            // logo/title 流帧全量预载；区间与各场景 FrameStream 消费区间一致
            // （logo [from..frames] / title [introFrom..menuStop]，76-90 从不显示不拉）。
            // fetch 走 HTTP 缓存，Logo/菜单 FrameStream 首拉全部命中本地缓存不占网络。
            const uiData = await loadUi(ctx.ctx); // 命中缓存
            const frames: string[] = [];
            for (let i = uiData.logo.from; i <= uiData.logo.frames; i++) {
              frames.push(`${ASSETS}/${uiData.logo.dir}/${i}.webp`);
            }
            for (let i = uiData.title.introFrom; i <= uiData.title.menuStop; i++) {
              frames.push(`${ASSETS}/${uiData.title.dir}/${i}.webp`);
            }
            // 并发受限逐帧下载 + 逐帧回报：进度条持续走动（与 render loadTextures 同构）
            let done = 0;
            let next = 0;
            const runners = Array.from(
              { length: Math.min(8, frames.length) },
              async () => {
                for (;;) {
                  const i = next++;
                  if (this.destroyed || i >= frames.length) return;
                  try {
                    await fetch(frames[i]!);
                  } catch {
                    // 预取失败不阻塞启动（FrameStream 自带失败重试与跳帧语义）
                  }
                  done++;
                  fine(done, frames.length);
                }
              },
            );
            await Promise.all(runners);
          },
        },
      ];
      const total = steps.reduce((s, x) => s + x.share, 0);
      let base = 0;
      for (const step of steps) {
        if (this.destroyed) return;
        this.barRef!.msg.text = step.msg;
        await step.run((done, count) => {
          if (this.destroyed) return;
          this.barRef!.msg.text = `${step.msg}(${done}/${count})`;
          this.target = (base + step.share * (done / count)) / total;
        });
        if (this.destroyed) return;
        base += step.share;
        this.target = base / total;
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
