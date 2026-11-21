/**
 * CameraRig —— 相机（自 renderer.ts 拆出，纯搬移）：
 * 双焦点 autoZoom / 单焦点特写 / 缓动牵引 / 舞台边界 clamp / front 层视差 /
 * 屏幕空间 bg cover。相机不进模拟：纯渲染变换。
 */
import type { Container } from 'pixi.js';
import type { SimSnapshot } from '@bvn/core';
import { DESIGN_VIEW_H, DESIGN_VIEW_W, LOGICAL_H, LOGICAL_W } from './types.js';
import type { FxCtx } from './fx-ctx.js';

export class CameraRig {
  /** 相机（逻辑坐标）：中心点 + 缩放因子（原版 GameCamera 语义：
   *  factor = 原版 zoom，1 = 满屏逻辑区；有效缩放 = fitZoom × factor）。
   *  缓动 = 原版 ease：逐帧 delta/5（tweenSpd = CAMERA_TWEEN_SPD/SPEED_PLUS_DEFAULT） */
  private camX = LOGICAL_W / 2;
  private camY = LOGICAL_H / 2;
  private zoomFactor = 1;
  /** 演出期目标缩放（公开：切人 mcPosY 联动 100 + 100/zoom 读取，原版
   *  BlackBackView.showBishaFace 语义） */
  zoomTarget = 1;
  /** 相机聚焦（切片 26，原版 GameStage.cameraFocusOne/cameraResume）：super 必杀/
   *  万解聚焦施法者，cutinLock 清除即恢复双焦点（null = 双焦点，autoZoom 接管）；
   *  intro/回合结束特写同款复用（写方 = 编排器/切人演出，读方 = update）。 */
  focus: { kind: 'fighter' | 'assister'; id: number } | null = null;

  constructor(
    private ctx: FxCtx,
    private world: Container,
    private bgFixed: Container,
  ) {}

  /**
   * 相机（切片 26 对齐原版 GameCamera；批次 23 追补 autoZoom 视口基准）：
   *   - 双焦点（常态）：中心 = 双方中点；自适应缩放 = 原版 renderTwo autoZoom
   *     `zoom = min(screenW/distX, screenH/distY)×0.8` clamp [1, 2.5]
   *     （autoZoomMin/Max = initCamera 真值）——双方拉开拉远镜头、贴身推近。
   *     视口基准 = 原版 `_screenSize` = GAME_SIZE **800×600 常量**（批次 23 追补：
   *     此前误用实际可见区 viewW/fitZoom——宽屏下 1066 使 zx 偏大 → zoom 偏大、
   *     贴身推近过狠；渲染可见区仍随纵横比铺满，仅 zoom 数值节奏对齐原版）；
   *   - 单焦点（super 必杀/万解，原版 cameraFocusOne）：聚焦施法者 + zoom 3.5
   *     （autoZoom 仅双焦点生效），cutinLock 清除由切人演出恢复双焦点；
   *   - 缓动 = 原版 ease：逐帧 delta/5（tweenSpd = CAMERA_TWEEN_SPD/SPEED_PLUS_DEFAULT
   *     = 5），位置 snap 0.5 世界 px、缩放 snap 0.5/800；按 dt 折算帧衰减；
   *   - clamp 保持批次 17 语义：平滑值按当前有效 zoom 夹取（原版夹目标值，
   *     此处防缩放过渡期越界露底，保守偏离）。
   */
  update(snap: SimSnapshot, dtMs: number): void {
    const fs = snap.state.fighters;
    if (fs.length === 0) return;
    const fitZoom = Math.min(this.ctx.viewW / LOGICAL_W, this.ctx.viewH / LOGICAL_H);

    let tx: number;
    let ty: number;
    let zoomT: number;
    const focus = this.focus;
    if (focus) {
      const caster =
        focus.kind === 'fighter'
          ? fs.find((f) => f.id === focus.id)
          : snap.state.assisters.find((a) => a.id === focus.id);
      tx = caster?.x ?? this.camX;
      ty = caster?.y ?? this.camY;
      zoomT = 3.5;
    } else {
      tx = fs.reduce((s, f) => s + f.x, 0) / fs.length;
      ty = fs.reduce((s, f) => s + f.y, 0) / fs.length;
      zoomT = this.zoomTarget;
      if (fs.length >= 2) {
        const distX = Math.abs(fs[0]!.x - fs[1]!.x);
        const distY = Math.abs(fs[0]!.y - fs[1]!.y);
        const zx = distX > 0 ? DESIGN_VIEW_W / distX : Infinity;
        const zy = distY > 0 ? DESIGN_VIEW_H / distY : Infinity;
        zoomT = Math.min(Math.max(Math.min(zx, zy) * 0.8, 1), 2.5);
      }
    }

    // 缓动（原版 ease(current, target, snap)：delta ≥ snap 时 current += delta/tweenSpd）；
    // 终结慢镜头/slowDown 全局慢放相机牵引同步减速（原版 GameCtrler.slow →
    // camera.tweenSpd = 2.5×rate，折算 ×1/rate；两通道并存相乘）
    const camFrames =
      Math.min(dtMs / (1000 / 60), 4) *
      (snap.state.roundEnd?.slow === true ? 0.5 : 1) *
      (snap.state.slowDown?.scale ?? 1);
    const k = 1 - Math.pow(1 - 1 / 5, camFrames);
    this.camX = Math.abs(tx - this.camX) < 0.5 ? tx : this.camX + (tx - this.camX) * k;
    this.camY = Math.abs(ty - this.camY) < 0.5 ? ty : this.camY + (ty - this.camY) * k;
    this.zoomTarget = zoomT;
    this.zoomFactor =
      Math.abs(zoomT - this.zoomFactor) < 0.5 / 800
        ? zoomT
        : this.zoomFactor + (zoomT - this.zoomFactor) * k;

    const zoom = fitZoom * this.zoomFactor;
    // 相机不进模拟：纯渲染变换。按快照舞台边界 clamp（版边牵引的渲染面）。
    const st = snap.state.stage;
    const halfW = this.ctx.viewW / zoom / 2;
    const halfH = this.ctx.viewH / zoom / 2;
    const loX = st.leftBound + halfW;
    const hiX = st.rightBound - halfW;
    const cx = loX > hiX ? (st.leftBound + st.rightBound) / 2 : Math.min(Math.max(this.camX, loX), hiX);
    // 垂直：视口不得越出地图显示边界（原版 GameCamera fixBorder：setY 把
    // scrollRect.y 夹死在 [_fbR.y, _fbR.height]）。地图内容底边 = bottomY
    //（baked 地图 line_bottom 归一化 600），顶边 = 0；zoom=1 时视口恰为
    // 整张地图，任何情况下不露出 bg 全景的地图区以下部分。
    const loY = halfH;
    const hiY = st.bottomY - halfH;
    const cy = loY > hiY ? st.bottomY / 2 : Math.min(Math.max(this.camY, loY), hiY);
    this.applyTransform(cx, cy, zoom);
    // front 层视差（镜像原版 MapMain.render，scrollRect 语义换算为本相机）：
    //   front.x = defaultX - 0.1·camLeft（camLeft = 视口左缘世界 x）
    //   front.y = defaultY + max(0, (bottom - camTop)·0.1)
    // front 在屏幕上比世界移动更快（近景语义）；front_fix 无视差、随地图固定。
    const camLeft = cx - halfW;
    const camTop = cy - halfH;
    this.ctx.mapFrontLayer.position.set(
      this.ctx.mapView.frontBaseX - camLeft * 0.1,
      this.ctx.mapView.frontBaseY + Math.max(0, (this.ctx.mapView.bottom - camTop) * 0.1),
    );
  }

  /** 相机变换应用（update 尾段共用；屏幕空间 bg cover 不随相机平移）。 */
  private applyTransform(cx: number, cy: number, zoom: number): void {
    this.world.scale.set(zoom);
    this.world.position.set(this.ctx.viewW / 2 - cx * zoom, this.ctx.viewH / 2 - cy * zoom);
    // bg：随视口缩放、不随相机平移（原版 bgLayer 挂 stage，scrollRect 之外）；
    // cover 铺满可见逻辑区并居中（可见区 = viewW/zoom × viewH/zoom）
    this.bgFixed.scale.set(zoom);
    if (this.ctx.mapView.bgSprite && this.ctx.mapView.bgSize.w > 0) {
      const bw = this.ctx.viewW / zoom;
      const bh = this.ctx.viewH / zoom;
      const bk = Math.max(bw / this.ctx.mapView.bgSize.w, bh / this.ctx.mapView.bgSize.h);
      this.ctx.mapView.bgSprite.scale.set(bk);
      this.ctx.mapView.bgSprite.position.set(
        (bw - this.ctx.mapView.bgSize.w * bk) / 2,
        (bh - this.ctx.mapView.bgSize.h * bk) / 2,
      );
    }
  }

  /** 首帧定位（块 9）：装载完成、首快照前按默认相机（逻辑屏中心，zoom=1 基准）摆好
   *  world/bg。首个真实快照到达后 update 即接管（舞台边界未知，按默认 0..LOGICAL 夹取）。 */
  prime(): void {
    const fitZoom = Math.min(this.ctx.viewW / LOGICAL_W, this.ctx.viewH / LOGICAL_H);
    const zoom = fitZoom * this.zoomFactor;
    const halfW = this.ctx.viewW / zoom / 2;
    const halfH = this.ctx.viewH / zoom / 2;
    const loX = halfW;
    const hiX = LOGICAL_W - halfW;
    const cx = loX > hiX ? LOGICAL_W / 2 : Math.min(Math.max(LOGICAL_W / 2, loX), hiX);
    const loY = halfH;
    const hiY = LOGICAL_H - halfH;
    const cy = loY > hiY ? LOGICAL_H / 2 : Math.min(Math.max(LOGICAL_H / 2, loY), hiY);
    this.applyTransform(cx, cy, zoom);
  }
}
