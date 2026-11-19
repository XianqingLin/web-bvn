/**
 * 场景系统（切片 14）：Logo→菜单→选人→战斗→结算 的流转骨架。
 *
 * SceneHost 是一个子系统（契约接口）：持有 1000×600 逻辑屏的 UI 根容器
 * （随画布等比缩放居中），场景在 enter/exit 挂载/卸载自己的显示对象。
 */
import { Application, Container } from 'pixi.js';
import type { Ctx, Subsystem } from '../host.js';
import { UI_H, UI_W } from '../ui.js';

export interface Scene {
  readonly name: string;
  /** 进入场景（挂显示对象、装事件）；exit 保证被调前生效 */
  enter(ctx: SceneCtx): void | Promise<void>;
  /** 离开场景（卸显示对象、拆事件） */
  exit(): void;
  /** 每渲染帧（可选） */
  update?(dtMs: number): void;
}

/** 场景可用环境：ctx = 子系统 ctx；root = 本场景显示根；switchTo = 流转。 */
export interface SceneCtx {
  readonly ctx: Ctx;
  /** pixi Application（战斗场景自建渲染器用） */
  readonly pixi: Application;
  readonly root: Container;
  /** 切到下一场景（旧场景 exit → 新场景 enter；支持异步 enter） */
  switchTo(scene: Scene): void;
  /** 画布 DOM 宿主（DOM 浮层用） */
  readonly domHost: HTMLElement;
}

export class SceneHost implements Subsystem {
  readonly id = 'scenes';
  readonly deps: readonly string[] = [];
  readonly uiRoot = new Container();

  private current: Scene | null = null;
  private switching = false;
  private ctx: Ctx | null = null;
  private domHost: HTMLElement | null = null;

  constructor(private readonly app: Application) {
    app.stage.addChild(this.uiRoot);
    this.onResize();
    app.renderer.on('resize', this.onResize, this);
  }

  private onResize(): void {
    // screen 是 CSS 逻辑尺寸;renderer.width/height 是乘过 DPR 的物理像素。
    const { width, height } = this.app.renderer.screen;
    const zoom = Math.min(width / UI_W, height / UI_H);
    this.uiRoot.scale.set(zoom);
    this.uiRoot.position.set((width - UI_W * zoom) / 2, (height - UI_H * zoom) / 2);
  }

  init(ctx: Ctx): void {
    this.ctx = ctx;
  }

  /** DOM 宿主注入（boot 时；vite 预览页为 #stage）。 */
  setDomHost(el: HTMLElement): void {
    this.domHost = el;
  }

  switchTo(scene: Scene): void {
    if (!this.ctx) throw new Error('SceneHost：init 前不得切场景');
    if (this.switching) throw new Error('SceneHost：场景切换中（enter 为异步时不得连环切）');
    this.switching = true;
    const old = this.current;
    this.current = scene;
    const run = async () => {
      old?.exit();
      if (old) {
        const r = sceneRoots.get(old);
        if (r) {
          this.uiRoot.removeChild(r);
          r.destroy({ children: true });
          sceneRoots.delete(old);
        }
      }
      const root = new Container();
      root.name = `scene:${scene.name}`;
      sceneRoots.set(scene, root);
      this.uiRoot.addChild(root);
      await scene.enter({
        ctx: this.ctx!,
        pixi: this.app,
        root,
        switchTo: (s) => this.switchTo(s),
        domHost: this.domHost ?? document.body,
      });
      this.switching = false;
    };
    void run();
  }

  update(dtMs: number): void {
    // 异步 enter 期间场景尚未装配完成；尤其 Logo 不能提前累计播放时间，
    // 否则首帧加载较慢时会先触发下一场景，撞上 switching 保护。
    if (!this.switching) this.current?.update?.(dtMs);
  }

  dispose(): void {
    this.current?.exit();
    this.current = null;
    sceneRoots.clear();
    this.app.renderer.off('resize', this.onResize, this);
    this.app.stage.removeChild(this.uiRoot);
  }
}

/** 场景 → 显示根（SceneHost 私有簿记；exit 后由 host 移除销毁）。 */
const sceneRoots = new Map<Scene, Container>();
