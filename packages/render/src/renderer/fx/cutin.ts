/**
 * 冻结演出系（自 renderer.ts 拆出，纯搬移）：
 *   - CutinFx：必杀/万解切人演出（切片 22/26，原版 BlackBackView/
 *     BishaFaceEffectView）+ 幽步/受击被动黑幕与地图显隐仲裁；
 *   - KobgFx：KO 背景层（KO 终结演出链，原版 BGEffect）——与切人共享
 *     地图显隐，update 顺序固定 = 切人先、kobg 后（锁态优先）；
 *   - PassiveFx：受击被动演出锚点（切片 55，替身/灵压爆发），
 *     差分补放火花经构造注入的 SparkFx。
 */
import { Sprite } from 'pixi.js';
import type { Texture } from 'pixi.js';
import type { SimSnapshot } from '@bvn/core';
import { LOGICAL_H, LOGICAL_W, type BishaMcData } from '../types.js';
import type { FxCtx } from '../fx-ctx.js';
import type { CameraRig } from '../camera.js';
import type { SparkFx } from './particles.js';

export class CutinFx {
  /** 当前演出：事件捕获（face/owner/槽位），锁清除即收场。
   *  mcPosY = 原版 BlackBackView.showBishaFace 的 `mc.y = 100 + 100/zoom`
   * （zoom = 演出开始时相机目标缩放因子；切片 22 为常数 200，切片 26 补上联动）。 */
  private cutin: {
    active: boolean;
    faceName: string | null;
    faceTex: Texture | null;
    slot: 1 | 2;
    mcPosY: number;
    accMs: number;
    frame: number;
  } = { active: false, faceName: null, faceTex: null, slot: 1, mcPosY: 200, accMs: 0, frame: 0 };
  /** 黑幕重画缓存（视口尺寸变化才重建） */
  private blackW = 0;
  private blackH = 0;

  constructor(
    private ctx: FxCtx,
    private cam: CameraRig,
  ) {}

  /** bisha/startWanKai 事件 → 演出状态（原版 showFace：faceId = 施法者在目标右侧 ? 2 : 1）。 */
  begin(snap: SimSnapshot, payload: Record<string, unknown>, isSuper: boolean): void {
    const params = (payload['params'] ?? {}) as Record<string, unknown>;
    const face = typeof params['face'] === 'string' ? params['face'] : null;
    const owner = params['owner'];
    const ownerKind = params['ownerKind'];
    // 施法者 x：角色 = fighters[id]；辅助 = assisters[id]
    let casterX: number | null = null;
    let atlasId: string | null = null;
    if (ownerKind === 'fighter' && typeof owner === 'number') {
      const f = snap.state.fighters.find((x) => x.id === owner);
      casterX = f?.x ?? null;
      atlasId = this.ctx.fighterAtlasById.get(owner) ?? null;
    } else if (ownerKind === 'assister' && typeof owner === 'number') {
      const a = snap.state.assisters.find((x) => x.id === owner);
      casterX = a?.x ?? null;
      atlasId = this.ctx.assisterAtlasByOwner.get(a?.ownerId ?? -1) ?? null;
    }
    if (casterX === null) return;
    // 目标 = 对面角色（双人对局 fighters[0/1]；辅助侧切人取对面角色位）
    const target = snap.state.fighters.find((f) => f.id !== owner) ?? snap.state.fighters[0];
    const slot: 1 | 2 = target && casterX > target.x ? 2 : 1;
    // 立绘同横幅守卫：仅主战（原版 target is FighterMain）
    const faceTex =
      ownerKind === 'fighter' && face && atlasId
        ? (this.ctx.assets.bishaFaceTex.get(`${atlasId}:${face}`) ?? null)
        : null;
    // 横幅 y 联动（原版 showBishaFace：100 + 100/zoom，zoom = 演出开始时的相机目标因子）
    const mcPosY = 100 + 100 / this.cam.zoomTarget;
    this.cutin = { active: true, faceName: face, faceTex, slot, mcPosY, accMs: 0, frame: 0 };
    const mcSx = this.scaleX(this.ctx.assets.bishaMc!);
    this.ctx.cutinBand.scale.set(mcSx, 1);
    this.ctx.cutinBand.position.set(
      this.ctx.assets.bishaMc!.canvasOrigin[0] * mcSx,
      mcPosY + this.ctx.assets.bishaMc!.canvasOrigin[1],
    );
  }

  /** 切人 mc 横向布局因子（批次 29）：横幅内容宽 = 1066 画布减去两侧对称透明出血
   *  |canvasOrigin.x| ≈ 798px，在原版恰好铺满 800×600 游戏区（原版 mc 挂
   *  scrollRect(0,0,800,600) 的 root、mc.x=0，BlackBackView 实测）。
   *  移植版可见逻辑区 = viewW/fitZoom（1000+，随纵横比），800 宽内容不可能盖满
   *  → 内容横向拉伸铺满 visW（速度线横幅，横向拉伸不可感知；与 bgFixed cover 同款
   *  适配），立绘槽位 wx 同比例外推，保持"贴 band 两端"的原版构图。 */
  scaleX(mc: BishaMcData): number {
    const visW = this.ctx.viewW / Math.min(this.ctx.viewW / LOGICAL_W, this.ctx.viewH / LOGICAL_H);
    return visW / Math.max(mc.canvasSize[0] + 2 * mc.canvasOrigin[0], 1);
  }

  /**
   * 切人演出帧推进（切片 22，原版 BlackBackView/BishaFaceEffectView 语义）：
   *   - 黑幕：SimState.cutinLock ≠ null 期间全屏覆盖（屏幕空间）；
   *   - 地图：原版 getMap().setVisible(false) → map/front 层隐藏；
   *   - 横幅+立绘：bisha_face_mc gotoAndPlay(2)（0-based 帧 1 起，30fps），
   *     播到 destory（全透明）/stop（空帧）自然消失；黑幕保持到 endBisha 解锁
      *     （语料缺 end 系时 = 黑幕挂到保护性解锁，原版为软锁，web 端有解锁兜底）。
   */
  update(next: SimSnapshot, dtMs: number): void {
    const lock = next.state.cutinLock;
    const mc = this.ctx.assets.bishaMc;
    const cutinActive = lock !== null && mc !== null;
    // 幽步黑幕（切片 53，原版 EffectCtrler.ghostStep：_blackBack.fadIn +
    // getMap().setVisible(false)——快照 ghostTicks 差分驱动，与切人锁同层
    // 视觉、无横幅/立绘；幽步期不可能与切人锁并存，黑幕条件取并集）。
    // 受击被动演出黑幕（切片 55，原版 replaceSkill/energyExplode 同款
    // _blackBack + 地图隐藏；快照 passiveFreeze 差分驱动，无横幅/立绘）
    const ghostLock = next.state.fighters.some((f) => f.ghostTicks > 0);
    const passiveLock = next.state.passiveFreeze != null;
    const blackActive = cutinActive || ghostLock || passiveLock;
    this.ctx.blackLayer.visible = blackActive;
    if (blackActive) {
      // 黑幕盖满当前视口（屏幕空间；resize 后重画）
      if (this.blackW !== this.ctx.viewW || this.blackH !== this.ctx.viewH) {
        this.blackW = this.ctx.viewW;
        this.blackH = this.ctx.viewH;
        this.ctx.blackLayer.clear().rect(0, 0, this.ctx.viewW, this.ctx.viewH).fill(0x000000);
      }
    }
    // 相机聚焦收场（原版 endBisha/endWanKai → cameraResume：双焦点 + autoZoom 接管）
    if (lock === null) this.cam.focus = null;
    // 地图隐藏（原版 getMap().setVisible(false)；front 系同属地图视觉层）
    this.ctx.mapLayer.visible = !blackActive;
    this.ctx.mapFrontFixLayer.visible = !blackActive;
    this.ctx.mapFrontLayer.visible = !blackActive;
    // 横幅/立绘 = 屏幕空间（scale = fitZoom：800×600 舞台规格 → 视口像素，
    // 不随相机平移/缩放——切片 26 移出 world）
    this.ctx.cutinScreen.visible = cutinActive;
    this.ctx.cutinScreen.scale.set(Math.min(this.ctx.viewW / LOGICAL_W, this.ctx.viewH / LOGICAL_H));
    this.ctx.cutinLayer.visible = cutinActive;
    if (!cutinActive) {
      // 解锁（endBisha/endWanKai/保护性解锁）：演出收场，等待下次事件
      this.cutin.active = false;
      return;
    }
    // 锁存在但无演出信息（如联机中途入局错过事件）：只显示黑幕（+主战横幅）
    if (!this.cutin.active) {
      this.cutin = {
        active: true,
        faceName: null,
        faceTex: null,
        slot: 1,
        mcPosY: 100 + 100 / this.cam.zoomTarget,
        accMs: 0,
        frame: 0,
      };
      const mcSx = this.scaleX(mc);
      this.ctx.cutinBand.scale.set(mcSx, 1);
      this.ctx.cutinBand.position.set(
        mc.canvasOrigin[0] * mcSx,
        this.cutin.mcPosY + mc.canvasOrigin[1],
      );
    }
    const c = this.cutin;
    c.accMs += dtMs;
    c.frame = Math.min(1 + Math.floor(c.accMs / (1000 / mc.fps)), mc.frames - 1);
    // 横幅流帧（0-based 帧 f ↔ 文件 f+1；帧 0 为 gotoAndPlay(2) 前的白屏态，不显示）。
    // 横幅/立绘仅主战（修复批次 42：原版 EffectCtrler.bisha 的
    // `face && target is FighterMain` 守卫——showFace→showBishaFace（蓝条）只对
    // FighterMain 调用；辅助施放 bisha 只有黑幕+位置光效，辅助侧此前误挂横幅）
    const bandTex = lock.kind === 'fighter' ? this.ctx.assets.bishaBandTex[c.frame] : undefined;
    if (bandTex) {
      this.ctx.cutinBand.visible = true;
      this.ctx.cutinBand.texture = bandTex;
    } else this.ctx.cutinBand.visible = false;
    // 立绘槽位（原版 showFace 把 254×180 face 加进 facemc{slot}）
    const slotArr = mc.slots[`facemc${c.slot}`];
    const s = slotArr?.[c.frame] ?? null;
    const tex = c.faceTex;
    if (!s || !tex) {
      this.ctx.cutinFace.visible = false;
      this.ctx.cutinFaceFlash.visible = false;
      return;
    }
    // 锚 = transformationPoint（缩放绕点）；槽位 wx/wy 即 mc 空间的 W_T →
    // 屏幕位 x = wx × 内容拉伸因子（band 铺满 visW，槽位同比例外推保持贴端构图）、
    // y = mcPosY + wy。canvasOrigin 只用于 band PNG 定位，不参与立绘定位
    //（多减一次 = 整体右偏 134/下偏 12，槽 2 被推出屏右缘——批次 29 修复）
    const [wx = 0, wy = 0, sx = 1, sy = 1, ro = 0, go = 0, bo = 0, al = 1] = s;
    const mcSx = this.scaleX(mc);
    this.ctx.cutinFace.visible = true;
    this.ctx.cutinFace.texture = tex;
    this.ctx.cutinFace.anchor.set(mc.faceAnchor[0] / mc.faceSize[0], mc.faceAnchor[1] / mc.faceSize[1]);
    this.ctx.cutinFace.position.set(wx * mcSx, c.mcPosY + wy);
    this.ctx.cutinFace.scale.set((sx * mc.faceSize[0]) / tex.width, (sy * mc.faceSize[1]) / tex.height);
    this.ctx.cutinFace.alpha = al;
    // 白闪近似：原版 color offset (255→50→0) = 加色白化 → 白 tint 同变换叠加
    const flash = Math.max(ro, go, bo);
    this.ctx.cutinFaceFlash.visible = flash > 0 && al > 0;
    if (this.ctx.cutinFaceFlash.visible) {
      this.ctx.cutinFaceFlash.texture = tex;
      this.ctx.cutinFaceFlash.anchor.set(this.ctx.cutinFace.anchor.x, this.ctx.cutinFace.anchor.y);
      this.ctx.cutinFaceFlash.position.copyFrom(this.ctx.cutinFace.position);
      this.ctx.cutinFaceFlash.scale.copyFrom(this.ctx.cutinFace.scale);
      this.ctx.cutinFaceFlash.alpha = Math.min(flash / 255, 1) * al;
    }
  }
}

export class KobgFx {
  /** KO 背景层状态（KO 终结演出链，原版 EffectView holdFrame 语义：帧序列
   *  播尽回卷，hold 帧计满移除并恢复地图）。null = 未激活。单槽。 */
  private fx: { body: Sprite; texs: Texture[]; accMs: number; holdMs: number } | null = null;

  constructor(private ctx: FxCtx) {}

  /** KO 背景层（KO 终结演出链，原版 BGEffect→EffectView）：MC 原点钉世界
   *  (leftBound,0) + union bounds 偏移（kobg 画布 800×600 origin (0,0)），随相机
   *  变换；地图显隐由 update 每帧接管（在切人演出之后，锁态优先）。
   *  mapW = 版宽——修复批次 63：原版地图即 800 宽画布全覆盖，移植版地图更宽
   *  时右缘露 200px 底图断层 → 横向拉伸铺满版宽（黑底拉伸不可感知）。 */
  spawn(holdFrames: number, leftBound: number, mapW: number): void {
    const eff = this.ctx.assets.hitspark?.effects['kobg'];
    const texs = this.ctx.assets.sparkTex.get('kobg');
    if (!eff || !texs || texs.length === 0) return;
    // 复发保护（原版 BGEffect 重复调用叠加多层——port 单槽覆盖）
    if (this.fx) {
      this.fx.body.destroy();
      this.fx = null;
    }
    const body = new Sprite(texs[0]!);
    body.position.set(leftBound + eff.origin[0], eff.origin[1]);
    body.scale.x = mapW / eff.canvas[0];
    this.ctx.kobgLayer.addChild(body);
    this.ctx.kobgLayer.visible = true;
    this.fx = { body, texs, accMs: 0, holdMs: holdFrames * (1000 / 30) };
  }

  /** KO 背景层帧推进（30fps 循环播帧，hold 计满移除；地图显隐接管，锁态优先）。 */
  update(next: SimSnapshot, dtMs: number): void {
    const k = this.fx;
    if (!k) return;
    k.accMs += dtMs;
    const f = Math.floor(k.accMs / (1000 / 30));
    if (f < k.holdMs / (1000 / 30)) {
      // EffectView holdFrame 语义：帧序列播尽回卷（holdFrame != -1 循环播放）
      k.body.texture = k.texs[f % k.texs.length]!;
      // 原版 BGEffect getMap().setVisible(false)：地图视觉层（含 front 系）
      this.ctx.mapLayer.visible = false;
      this.ctx.mapFrontFixLayer.visible = false;
      this.ctx.mapFrontLayer.visible = false;
      return;
    }
    k.body.destroy();
    this.ctx.kobgLayer.visible = false;
    this.fx = null;
    // 移除回洞（原版 addRemoveBack → getMap().setVisible(true)）：切人锁激活时
    // 交还切人演出接管（黑幕期地图本就隐藏）
    if (next.state.cutinLock === null) {
      this.ctx.mapLayer.visible = true;
      this.ctx.mapFrontFixLayer.visible = true;
      this.ctx.mapFrontLayer.visible = true;
    }
  }
}

export class PassiveFx {
  /**
   * 受击被动演出锚点（切片 55，原版 EffectCtrler _replaceSkillPos/_explodeEffectPos
   * + 帧计数）：sim 事件登记落点/计时基准，update 差分补放 replaceSp2、
   * passiveFreeze 消失时清锚（黑幕/地图恢复走切人演出快照差分）。
   */
  private state: {
    kind: 'replace' | 'explode';
    ownerId: number;
    x: number;
    y: number;
    ticksLeft: number;
    fired: boolean;
  } | null = null;

  constructor(private sparks: SparkFx) {}

  begin(kind: 'replace' | 'explode', ownerId: number, x: number, y: number, ticksLeft: number): void {
    this.state = { kind, ownerId, x, y, ticksLeft, fired: false };
  }

  /** 锚点读取（编排器补放首段火花用；无锚 = null/0） */
  get kind(): 'replace' | 'explode' | null {
    return this.state?.kind ?? null;
  }

  get x(): number {
    return this.state?.x ?? 0;
  }

  get y(): number {
    return this.state?.y ?? 0;
  }

  /** 被动演出差分推进（切片 55）：replaceSp2 = 触发后第一演出帧同点补放
   *（原版 renderReplaceSkill frame==1）；explodeSp2 由 endEnergyExplode 事件补放。 */
  update(next: SimSnapshot): void {
    if (this.state === null) return;
    const pf = next.state.passiveFreeze;
    if (pf == null) {
      this.state = null;
      return;
    }
    if (
      this.state.kind === 'replace' &&
      !this.state.fired &&
      pf.ticksLeft < this.state.ticksLeft
    ) {
      this.state.fired = true;
      this.sparks.spawnById('replaceSp2', this.state.x, this.state.y, 1);
    }
  }
}
