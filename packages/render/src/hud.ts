/**
 * FightHud —— 对局 HUD（切片 30）：原版 FightUI/FightBar 装配的 web 移植。
 *
 * 规格 = fight.swf（XFL 工程 embed/fight）+ AS3 UI 类（FighterHpBar/QiBar/
 * EnergyBar/HitsUI/FightFaceGroup/MCNumber），布局常量烘焙在 baked/hud.json。
 *
 * 屏幕空间适配：HUD 以原版 800×600 舞台坐标布局，整体 scale = fitZoom；
 * 原版贴边的部件按边钉扎——左件钉视口左缘、右件钉右缘、计时板居中、
 * 气条钉底缘（与 bgFixed cover / cutinScreen 同款适配，宽屏不出现居中死边）。
 *
 * P2 镜像语义（XFL a=-1 容器 + AS3 setDirect 双翻）：整容器 scale.x=-1，
 * 其内含文字的件（气条段字/READY/能量标签）再 scale.x=-1 保持可读；
 * 连击不镜像（原版 HitsUI 无 setDirect，P1 数字左端锚定右长、P2 右缘锚定左长）。
 *
 * 已登记偏离（DESIGN §）：
 *   - 连击计数：原版 FighterEventCtrler.onHitTarget/onHurtResume/onHurtDown
 *     + GameLogic 逐目标计数，这里以 hit:connect 事件 + 目标 actionState
 *     近似（目标 NORMAL/HURT_DOWN/DEAD 即隐藏，~0.4s 淡出近似 fadout）；
 *   - fadin/fadout/update 入退场补间跳过（直接显隐）；
 *   - 能量标签 flash 用 alpha 闪烁近似（原版切 inner mc 帧，语义未收编）；
 *   - 辅助格红点可见性用 fzqi 满近似（原版 isCanHurtBreak，core 无此查询）；
 *   - 计时器恒显示 ∞（单局流程无时限）；
 *   - 宽屏血条延伸：原版 800 宽下血条外缘搭进计时板近缘 ~9px，逐元素钉边后
 *     该重叠随中线外移变成空隙 → 血条横向拉伸每侧补 (visW-800)/2（原版位形
 *     scale 恒 1；横线条纹理拉伸不可感知，与切人横幅/bgFixed 同款适配）。
 *
 * 遗留（未收编，登记 PROGRESS 遗留池）：startKOmc 结算段（KO/timeover/winner/
 * drawgame——回合结算流程未接）、win 胜利星（p1Wins/p2Wins 恒 0 不显示）、
 * scoremc、被动条 sp、回合数字 shape_007。开局段（start+fight）已收编（intro
 * 切片：core 冻结期快照驱动，intro.step===7 期间 30Hz 流帧）。
 */
import { Assets, Container, Graphics, Rectangle, Sprite, Texture } from 'pixi.js';
import { ActionState, type SimSnapshot } from '@bvn/core';

/** 原版舞台规格（HUD 布局设计空间） */
const STAGE_W = 800;
const STAGE_H = 600;
/** 能量条阈值（原版 EnergyBar render：rate < 0.3 闪烁） */
const ENERGY_FLASH_RATE = 0.3;
/** 连击隐藏淡出时长（ms；偏离：原版播 fadout 时间轴） */
const HITS_FADE_MS = 400;
/** 连击数字上限（MCNumber 无上限；显示池按 4 位封顶） */
const HITS_MAX_DIGITS = 4;
/** 原版 GameConfig.FPS_GAME（FighterHpBar redbar 延迟 1.5×FPS 帧） */
const FPS_GAME = 60;
/** 辅助脸尺寸（原版 getFighterFace 缺省 size 50×50） */
const ASSIST_FACE_SIZE = 50;

/** baked/hud.json（tools/ui-pack/hud-pack.mjs 产物，schema bvn/hud@1） */
export interface HudData {
  schema: string;
  /** 元素名 → assets 相对路径（文件 .png / 帧集为目录） */
  elements: Record<string, string>;
  hp: {
    /** hpbarmc 原点（XFL mc_040 静止帧） */
    origin: [number, number];
    bar: { p1: [number, number]; p2: [number, number]; size: [number, number]; decoPos: [number, number] };
    fillPos: [number, number];
    fillSize: [number, number];
    face: { p1: [number, number]; p2: [number, number]; size: [number, number] };
    energy: {
      p1: [number, number];
      p2: [number, number];
      bgPos: [number, number];
      fillPos: [number, number];
      fillAnchorX: number;
      labelPos: [number, number];
    };
    win: { p1: [number, number]; p2: [number, number]; w1: [number, number]; w2: [number, number] };
    time: { bgPos: [number, number]; infPos: [number, number] };
  };
  qi: {
    p1Origin: [number, number];
    p2Origin: [number, number];
    readyPos: [number, number];
    facePos: [number, number];
    fzbarPos: [number, number];
    fzFillPos: [number, number];
    fzTopPos: [number, number];
    fzDotPos: [number, number];
    fzSize: [number, number];
    fzFillSize: [number, number];
    barPos: [number, number];
    slotPos: [number, number];
    framePos: [number, number];
    segPos: [number, number];
    segSize: [number, number];
    ghostPos: [number, number];
    ghostAnchorX: number;
    txtPos: [number, number];
  };
  hits: {
    p1: [number, number];
    p2: [number, number];
    ctOffset: [number, number];
    labelPos: [number, number];
    labelInner: [number, number];
    digitWidth: number;
    digitRightX: number;
  };
  winAnim: { frames: number; bleach: [number, number]; naruto: [number, number]; fps: number };
  readyAnim: { frames: number; fps: number };
  /** 开局字样（startKOmc start+fight 段；canvasOrigin = PNG(0,0) 的 mc_043 局部
   *  坐标，pos = ui_fight 舞台摆放点——烘焙时已换算，见 hud-pack.mjs） */
  startKO: { frames: number; fps: number; canvasOrigin: [number, number]; pos: [number, number] };
}

/** HUD 单侧角色装配（app 按选人结果组装；slot 1/2） */
export interface HudFighterSpec {
  /** 血条大脸 URL（ui.faces[id+'_m']，102×64 与 face-bg 同画布 1:1；null = 缺脸只画框） */
  faceUrl: string | null;
  /** 气条辅助脸 URL（ui.faces[assistId]，原版 getFighterFace 50×50；null 同上） */
  assistFaceUrl: string | null;
  /** 能量标签帧（原版 InsTxt.setType(comicType)：0=死神→帧1 1=火影→帧2） */
  comicType: number;
}

/** HUD 资源清单（app 装配后挂 BattleAssetsSpec.hud） */
export interface HudSpec {
  data: HudData;
  fighters: { p1: HudFighterSpec; p2: HudFighterSpec };
}

/** 单侧 HUD 动态件句柄（build 顺序：hp → energy → qi → hits 逐块填充） */
interface SideHud {
  hp: {
    green: Sprite;
    red: Sprite;
    redScale: number;
    redMoving: boolean;
    delay: number;
    justHurtFly: boolean;
    prevRate: number;
  };
  energy: {
    bgMid: Sprite | null;
    bgMidW: number;
    bgRight: Sprite;
    bgRightX: number;
    fill: Sprite;
    fillW: number;
    fillStretch: number;
    label: Sprite;
    flashInt: number;
    flashFrame: number;
    overload: boolean;
  };
  qi: {
    segs: Sprite[];
    ghost: Sprite;
    txt: Sprite;
    fzMask: Graphics;
    fzMaskH: number;
    dot: Sprite;
    ready: Sprite;
    readyAcc: number;
    readyPlaying: boolean;
  };
  hits: { root: Container; row: Container; digits: Sprite[]; count: number; fading: boolean };
}

function emptySide(): SideHud {
  const noSprite = () => null as unknown as Sprite;
  return {
    hp: { green: noSprite(), red: noSprite(), redScale: 1, redMoving: false, delay: 0, justHurtFly: false, prevRate: 1 },
    energy: {
      bgMid: null,
      bgMidW: 0,
      bgRight: noSprite(),
      bgRightX: 0,
      fill: noSprite(),
      fillW: 124,
      fillStretch: 1,
      label: noSprite(),
      flashInt: 0,
      flashFrame: 1,
      overload: false,
    },
    qi: {
      segs: [],
      ghost: noSprite(),
      txt: noSprite(),
      fzMask: null as unknown as Graphics,
      fzMaskH: -1,
      dot: noSprite(),
      ready: noSprite(),
      readyAcc: 0,
      readyPlaying: false,
    },
    hits: { root: null as unknown as Container, row: null as unknown as Container, digits: [], count: 0, fading: false },
  };
}

export class FightHud {
  private readonly data: HudData;
  private readonly spec: HudSpec;
  private readonly root = new Container();
  private sides: { 1: SideHud; 2: SideHud } = { 1: emptySide(), 2: emptySide() };
  private tex = new Map<string, Texture>();
  private frames = new Map<string, Texture[]>();
  /** 钉扎组（design 坐标 + 模式；layout() 重摆） */
  private pinned: { c: Container; x: number; y: number; mx: PinX; my: PinY }[] = [];
  /** 血条单元（宽屏延伸拉伸；relayout 重设 scale.x，P2 为负值镜像） */
  private hpBars: { p1: Container; p2: Container } | null = null;
  /** 开局字样（startKOmc；intro 切片，updateStartKO 驱动） */
  private startKO: Sprite | null = null;
  private viewW = 1000;
  private viewH = 600;
  private fitZoom = 1;

  constructor(parent: Container, spec: HudSpec) {
    this.spec = spec;
    this.data = spec.data;
    parent.addChild(this.root);
  }

  /** 装载纹理并搭静态树（renderer.load 内 await）。 */
  async load(baseUrl: string): Promise<void> {
    for (const [name, path] of Object.entries(this.data.elements)) {
      if (path.endsWith('.png')) {
        this.tex.set(name, await Assets.load<Texture>(`${baseUrl}/${path}`));
      } else {
        this.frames.set(name, await this.loadFrames(`${baseUrl}/${path}`));
      }
    }
    this.build();
  }

  /** 帧集目录：1.png 起连续装载，缺失即止。 */
  private async loadFrames(url: string): Promise<Texture[]> {
    const out: Texture[] = [];
    for (let i = 1; ; i++) {
      try {
        out.push(await Assets.load<Texture>(`${url}/${i}.png`));
      } catch {
        break;
      }
    }
    return out;
  }

  private el(name: string): Texture {
    const t = this.tex.get(name);
    if (!t) throw new Error(`hud: 缺元素纹理 ${name}`);
    return t;
  }

  /** 帧集第 i 帧（0 基）。 */
  private frame(name: string, i: number): Texture | null {
    return this.frames.get(name)?.[i] ?? null;
  }

  private sprite(name: string): Sprite {
    return new Sprite(this.el(name));
  }

  /** 帧集 sprite（首帧起显）。 */
  private frameSprite(name: string, i = 0): Sprite {
    const t = this.frame(name, i);
    if (!t) throw new Error(`hud: 缺帧集纹理 ${name}[${i}]`);
    return new Sprite(t);
  }

  // ---------- 静态树搭建 ----------

  private build(): void {
    const d = this.data;
    const o = d.hp.origin;
    const [s1, s2] = [this.sides[1], this.sides[2]];

    // —— 血条侧件（mc_033 等价物；P2 容器镜像）——
    const bar1 = this.buildHpBar(s1);
    const bar2 = this.buildHpBar(s2);
    bar2.scale.x = -1;
    this.hpBars = { p1: bar1, p2: bar2 };
    // —— 大脸（mc_035 等价物；P2 镜像 = 原版 face2 a=-1，setDirect 为空操作）——
    const face1 = this.buildFace(this.spec.fighters.p1.faceUrl);
    const face2 = this.buildFace(this.spec.fighters.p2.faceUrl);
    face2.scale.x = -1;
    // —— 能量条（mc_032 等价物；P2 容器镜像 + 标签双翻）——
    const en1 = this.buildEnergy(s1, this.spec.fighters.p1.comicType, 1);
    const en2 = this.buildEnergy(s2, this.spec.fighters.p2.comicType, -1);
    en2.scale.x = -1;
    // —— 计时板（mc_038；单局恒显 ∞）——
    const time = new Container();
    const timeBg = this.sprite('time-bg');
    timeBg.position.set(d.hp.time.bgPos[0], d.hp.time.bgPos[1]);
    const inf = this.sprite('time-inf');
    inf.position.set(d.hp.time.infPos[0], d.hp.time.infPos[1]);
    time.addChild(timeBg, inf);
    // —— 气条侧件（mc_026 等价物；P2 容器镜像 + 段字/READY 双翻）——
    const qi1 = this.buildQi(s1, 1);
    const qi2 = this.buildQi(s2, -1);
    qi2.scale.x = -1;
    // —— 连击（不镜像；P1 左端锚定 / P2 右缘锚定）——
    const hits1 = this.buildHits(s1, 1);
    const hits2 = this.buildHits(s2, -1);

    // 钉扎装配（design 坐标 = hpbarmc 原点 + 各件偏移）
    const add = (c: Container, ax: number, ay: number, mx: PinX, my: PinY): void => {
      this.root.addChild(c);
      this.pinned.push({ c, x: ax, y: ay, mx, my });
    };
    add(face1, o[0] + d.hp.face.p1[0], o[1] + d.hp.face.p1[1], 'left', 'top');
    add(face2, o[0] + d.hp.face.p2[0], o[1] + d.hp.face.p2[1], 'right', 'top');
    add(bar1, o[0] + d.hp.bar.p1[0], o[1] + d.hp.bar.p1[1], 'left', 'top');
    add(bar2, o[0] + d.hp.bar.p2[0], o[1] + d.hp.bar.p2[1], 'right', 'top');
    add(en1, o[0] + d.hp.energy.p1[0], o[1] + d.hp.energy.p1[1], 'left', 'top');
    add(en2, o[0] + d.hp.energy.p2[0], o[1] + d.hp.energy.p2[1], 'right', 'top');
    add(time, o[0], o[1], 'center', 'top');
    add(qi1, d.qi.p1Origin[0], d.qi.p1Origin[1], 'left', 'bottom');
    add(qi2, d.qi.p2Origin[0], d.qi.p2Origin[1], 'right', 'bottom');
    add(hits1, d.hits.p1[0], d.hits.p1[1], 'left', 'top');
    add(hits2, d.hits.p2[0], d.hits.p2[1], 'right', 'top');

    // —— 开局字样（startKOmc start+fight 段；intro 切片）——
    // PNG(0,0) = mc_043 画布原点 (13,103)，烘焙时已换算成 ui_fight 舞台摆放点
    //（startKOmc@(0,0) + showStart y=-50 + 原点 → (13,53)）。原版 showStart
    // gotoAndStop("start") 显首帧，renderStartAndKO 手动 nextFrame 流帧。
    if (this.frames.has('startko')) {
      const ko = this.frameSprite('startko', 0);
      ko.visible = false;
      this.root.addChild(ko);
      this.pinned.push({ c: ko, x: d.startKO.pos[0], y: d.startKO.pos[1], mx: 'left', my: 'top' });
      this.startKO = ko;
    }

    this.relayout();
  }

  private buildHpBar(side: SideHud): Container {
    const d = this.data;
    const g = new Container();
    const slot = this.sprite('hp-slot');
    const deco = this.sprite('hp-deco');
    deco.position.set(d.hp.bar.decoPos[0], d.hp.bar.decoPos[1]);
    // 填充锚右（内容 x[-260,0]，scaleX = hp/hpMax 从右端缩）；
    // redbar 位图 picture_062 在 mc_004 内 ty=1 → 纵向 +1
    const red = this.sprite('hp-red');
    red.anchor.set(1, 0);
    red.position.set(d.hp.fillPos[0], d.hp.fillPos[1] + 1);
    const green = this.sprite('hp-fill');
    green.anchor.set(1, 0);
    green.position.set(d.hp.fillPos[0], d.hp.fillPos[1]);
    g.addChild(slot, deco, red, green);
    side.hp = { green, red, redScale: 1, redMoving: false, delay: 0, justHurtFly: false, prevRate: 1 };
    return g;
  }

  private buildFace(faceUrl: string | null): Container {
    // mc_034（hpbar_facemc）SWF 深度序（XFL 图层自上而下：图层4 picture_090 →
    // 图层3 mask → 被动条 sp → 图层2 ct 脸槽 → 图层1 黑底矩形）：
    // 黑底 + 脸槽被六边形 mask 裁剪，picture_090 框在顶层不被裁（内部为半透明
    // 玻璃暗罩，脸透出变暗）。曾把框垫底 → 被整幅 102×64 脸图盖住（缺框）。
    // 落位：mc_035 face 实例 tx 0.15（+切片 30 实测 ty 校正 1）；mask 多边形 =
    // XFL edges twips/20：(99.4,47.8)(84.05,62.1)(14.1,62.1)(-0.15,50.65)
    // (-0.15,3.85)(70,3.85)(99.4,27.75)；黑底矩形 SolidColor 缺省黑，边 x[-0.95,
    // 103.6] y[0.85,63.1]。
    const g = new Container();
    const mc = new Container();
    mc.position.set(0.15, 1);
    const inner = new Container(); // 被裁内容组（黑底 + 脸）
    const bgRect = new Graphics();
    bgRect.rect(-0.95, 0.85, 104.55, 62.25).fill(0x000000);
    inner.addChild(bgRect);
    if (faceUrl) {
      const sp = new Sprite(Texture.EMPTY);
      sp.position.set(0, 0);
      Assets.load<Texture>(faceUrl).then((t) => {
        if (sp.destroyed) return;
        sp.texture = t; // _m 图恰为 102×64，与 picture_090 同画布 1:1
      });
      inner.addChild(sp);
    }
    const mask = new Graphics();
    mask
      .poly([99.4, 47.8, 84.05, 62.1, 14.1, 62.1, -0.15, 50.65, -0.15, 3.85, 70, 3.85, 99.4, 27.75])
      .fill(0xffffff);
    const frame = this.sprite('face-bg'); // picture_090 框（顶层半透明罩）
    mc.addChild(inner, mask, frame);
    inner.mask = mask;
    g.addChild(mc);
    return g;
  }

  private buildEnergy(side: SideHud, comicType: number, direct: 1 | -1): Container {
    const d = this.data;
    const g = new Container();
    // bg 三段式（宽屏延伸切片）：左斜盖 0-12 / 纯槽中段 12-128 / 右端块 128-140，
    // 常规位形拼合与整图等价；ext>0 时中段拉伸、端盖原样平移
    const CAP = 12;
    const bgTex = this.el('energy-bg');
    const bw = bgTex.width;
    const mkSlice = (x: number, w: number): Sprite => {
      const sp = new Sprite(new Texture({ source: bgTex.source, frame: new Rectangle(x, 0, w, bgTex.height) }));
      sp.position.set(d.hp.energy.bgPos[0] + x, d.hp.energy.bgPos[1]);
      return sp;
    };
    const bgLeft = mkSlice(0, CAP);
    const bgMid = mkSlice(CAP, bw - CAP * 2);
    const bgRight = mkSlice(bw - CAP, CAP);
    const fill = this.frameSprite('energy-fill');
    fill.anchor.set(d.hp.energy.fillAnchorX, 0);
    fill.position.set(d.hp.energy.fillPos[0], d.hp.energy.fillPos[1]);
    // 标签帧 = comicType+1（0 基下标 = comicType）；P2 双翻（镜像容器内再翻）
    const label = this.frameSprite('energy-label', comicType);
    label.position.set(d.hp.energy.labelPos[0], d.hp.energy.labelPos[1]);
    if (direct === -1) label.scale.x = -1;
    g.addChild(bgLeft, bgMid, bgRight, fill, label);
    side.energy = {
      bgMid,
      bgMidW: bw - CAP * 2,
      bgRight,
      bgRightX: d.hp.energy.bgPos[0] + bw - CAP,
      fill,
      fillW: fill.texture.width,
      fillStretch: 1,
      label,
      flashInt: 0,
      flashFrame: 1,
      overload: false,
    };
    return g;
  }

  private buildQi(side: SideHud, direct: 1 | -1): Container {
    const d = this.data;
    const g = new Container();

    // —— barmc（mc_022）：槽体 + 三段气 + ghost + 段字 ——
    const bar = new Container();
    bar.position.set(d.qi.barPos[0], d.qi.barPos[1]);
    const slot = this.sprite('qi-slot');
    slot.position.set(d.qi.slotPos[0], d.qi.slotPos[1]);
    bar.addChild(slot);
    // 分段容器（mc_020）：bar1..4 同位叠放；ghost 为其子件（mc_020 局部落位）
    const segsC = new Container();
    segsC.position.set(d.qi.segPos[0], d.qi.segPos[1]);
    const segs = ['qi-seg-1', 'qi-seg-2', 'qi-seg-3', 'qi-seg-4'].map((n) => {
      const s = this.sprite(n);
      segsC.addChild(s);
      return s;
    });
    const ghost = this.frameSprite('qi-ghost');
    ghost.anchor.set(d.qi.ghostAnchorX, 0);
    ghost.position.set(d.qi.ghostPos[0], d.qi.ghostPos[1]);
    segsC.addChild(ghost);
    bar.addChild(segsC);
    // 段字（帧 = int(v)+1；P2 双翻）
    const txt = this.frameSprite('qi-txt');
    txt.position.set(d.qi.txtPos[0], d.qi.txtPos[1]);
    if (direct === -1) txt.scale.x = -1;
    bar.addChild(txt);
    // 顶层装饰框（picture_063 / shape 86，191×23，mc_022 最上层）：XFL 重建源图层标
    // visible=false 系 FFDec 导出伪影，编译 SWF sprite 87 渲染 191×24 含此框（曾漏烘 = 缺框）
    const qiFrame = this.sprite('qi-frame');
    qiFrame.position.set(d.qi.framePos[0], d.qi.framePos[1]);
    bar.addChild(qiFrame);
    g.addChild(bar);

    // —— fzqibar（mc_023）：底板 + 底部向上填充（scrollRect 语义）+ 顶层 + 红点 ——
    const fz = new Container();
    fz.position.set(d.qi.fzbarPos[0], d.qi.fzbarPos[1]);
    const fzBg = this.sprite('fz-bg');
    fz.addChild(fzBg);
    // 填充：原版 barmc.scaleY=-1、y=height、scrollRect.height=v*height
    // → 图像上下翻转、底部锚定、按 v 裁剪（fzClip + Graphics mask 复刻）
    const fzClip = new Container();
    fzClip.position.set(d.qi.fzFillPos[0], d.qi.fzFillPos[1]);
    const fzFill = this.sprite('fz-fill');
    fzFill.scale.y = -1;
    fzFill.y = d.qi.fzFillSize[1];
    fzClip.addChild(fzFill);
    const fzMask = new Graphics();
    fz.addChild(fzMask);
    fzClip.mask = fzMask;
    const fzTop = this.sprite('fz-top');
    fzTop.position.set(d.qi.fzTopPos[0], d.qi.fzTopPos[1]);
    const dot = this.sprite('fz-dot');
    dot.position.set(d.qi.fzDotPos[0], d.qi.fzDotPos[1]);
    dot.visible = false;
    fz.addChild(fzClip, fzTop, dot);
    g.addChild(fz);

    // —— facemc（mc_025）：SWF 深度序 = 黑底(shape 100) → 裁剪(shape 101) →
    // ct 脸槽（QiBar.setFighter 加 50×50 脸，被 101 裁剪）→ 六边形框(shape 103)。
    // 修复批次 33：曾按 shape id 大小误判层级（103 垫底/100 盖顶）→ 黑块遮住头像；
    // 落位按各 shape bounds（PNG 画布已裁到 bounds，需补回 Xmin/Ymin）：
    // 100 Xmin 11tw=0.55px/Ymin 0 → (0.55,0)；101 Xmin 10tw=0.5px/Ymin 20tw=1px →
    // (0.5,1)；103 Xmin 0/Ymin 20tw=1px → (0,1)。
    const face = new Container();
    face.position.set(d.qi.facePos[0], d.qi.facePos[1]);
    const shade = this.sprite('face-assist-shade');
    shade.position.set(0.55, 0);
    face.addChild(shade);
    const faceSlot = new Container();
    const faceUrl = this.spec.fighters[direct === 1 ? 'p1' : 'p2'].assistFaceUrl;
    if (faceUrl) {
      const sp = new Sprite(Texture.EMPTY);
      Assets.load<Texture>(faceUrl).then((t) => {
        if (sp.destroyed) return;
        sp.texture = t;
        sp.width = ASSIST_FACE_SIZE;
        sp.height = ASSIST_FACE_SIZE;
      });
      faceSlot.addChild(sp);
    }
    const faceMask = this.sprite('face-assist-mask');
    faceMask.position.set(0.5, 1);
    face.addChild(faceSlot, faceMask);
    faceSlot.mask = faceMask;
    const frame = this.sprite('face-assist-frame');
    frame.position.set(0, 1);
    face.addChild(frame);
    g.addChild(face);

    // —— readymc（mc_014）：READY 20 帧 @30fps 循环；P2 双翻 ——
    const readyC = new Container();
    readyC.position.set(d.qi.readyPos[0], d.qi.readyPos[1]);
    const ready = this.frameSprite('ready-anim');
    if (direct === -1) ready.scale.x = -1;
    readyC.addChild(ready);
    g.addChild(readyC);

    side.qi = { segs, ghost, txt, fzMask, fzMaskH: -1, dot, ready, readyAcc: 0, readyPlaying: false };
    return g;
  }

  private buildHits(side: SideHud, direct: 1 | -1): Container {
    const d = this.data;
    const g = new Container();
    // HITS 字（mc_017 落位）
    const label = this.sprite('hits-label');
    label.position.set(d.hits.labelPos[0], d.hits.labelPos[1]);
    g.addChild(label);
    // 数字行（ct 落位）：P1 行左端固定右长 / P2 行右缘锚定左长（原版 xoffset 公式：
    // mc.x = org ± (width-45) 与 _txtmc.x = -width+45 抵消后的等效静态位）
    const row = new Container();
    const digits: Sprite[] = [];
    for (let i = 0; i < HITS_MAX_DIGITS; i++) {
      const s = new Sprite(Texture.EMPTY);
      s.anchor.set(0, 0);
      s.position.set(i * d.hits.digitWidth, 0);
      row.addChild(s);
      digits.push(s);
    }
    row.position.set(
      direct === 1 ? d.hits.ctOffset[0] : d.hits.digitRightX + d.hits.ctOffset[0],
      d.hits.ctOffset[1],
    );
    g.addChild(row);
    g.visible = false;
    side.hits = { root: g, row, digits, count: 0, fading: false };
    return g;
  }

  // ---------- 布局 ----------

  /** 视口变化重摆（renderer 每帧调；内部短路）。 */
  layout(viewW: number, viewH: number, fitZoom: number): void {
    if (this.viewW === viewW && this.viewH === viewH && this.fitZoom === fitZoom) return;
    this.viewW = viewW;
    this.viewH = viewH;
    this.fitZoom = fitZoom;
    this.relayout();
  }

  private relayout(): void {
    this.root.scale.set(this.fitZoom);
    const visW = this.viewW / this.fitZoom;
    const visH = this.viewH / this.fitZoom;
    // 血条延伸（宽屏适配，偏离记录）：原版 800 宽下血条外缘恰搭进计时板近缘
    // ~9px（P1 右缘 371.35 / 计时板左缘 362.5）；逐元素钉边后计时板随中线外移，
    // 与血条间出现空隙 → 血条横向拉伸补齐，每侧伸长 (visW-800)/2——原版位形下
    // scale 恒 1，重叠量原样保留（槽/装饰/填充为横向线条纹理，拉伸不可感知，
    // 与切人横幅拉伸 / bgFixed cover 同款适配）
    const k = 1 + (visW - STAGE_W) / 2 / this.data.hp.bar.size[0];
    if (this.hpBars) {
      this.hpBars.p1.scale.x = k;
      this.hpBars.p2.scale.x = -k;
    }
    // 能量条延伸（同血条）：原版 800 宽下 energy 右缘（374.95）搭进计时板左缘
    // （362.5）12.45px；宽屏下计时板随中线外移而能量条钉在脸侧 → 空隙。
    // bg 三段式（端盖固定、纯槽中段拉伸——bg 有斜盖/端块，整段拉伸会拉丝）；
    // fill 为纯条纹理随 ext 拉长（充电满时仍铺满全槽）。P2 容器镜像下局部 +x
    // 恒指向屏心，两侧同一公式；原版位形 ext=0 不动
    const ext = (visW - STAGE_W) / 2;
    for (const s of [this.sides[1], this.sides[2]]) {
      const en = s.energy;
      if (!en.bgMid) continue;
      en.bgMid.scale.x = (en.bgMidW + ext) / en.bgMidW;
      en.bgRight.position.x = en.bgRightX + ext;
      en.fill.position.x = this.data.hp.energy.fillPos[0] + ext;
      en.fillStretch = (en.fillW + ext) / en.fillW;
    }
    for (const p of this.pinned) {
      const x =
        p.mx === 'left' ? p.x : p.mx === 'right' ? visW - (STAGE_W - p.x) : visW / 2 + (p.x - STAGE_W / 2);
      const y =
        p.my === 'top' ? p.y : p.my === 'bottom' ? visH - (STAGE_H - p.y) : visH / 2 + (p.y - STAGE_H / 2);
      p.c.position.set(x, y);
    }
  }

  // ---------- 动态更新 ----------

  /** hit:connect 桥（renderer 事件消费调用）。attacker = fighter id 1/2。 */
  onHit(attacker: number): void {
    if (attacker !== 1 && attacker !== 2) return;
    const s = this.sides[attacker === 1 ? 1 : 2];
    s.hits.count++;
    // 原版 addHits：hits > 1 才显示（首击不弹连击数）
    if (s.hits.count >= 2) this.showHits(s);
  }

  private showHits(s: SideHud): void {
    const d = this.data.hits;
    const num = Math.min(s.hits.count, 10 ** HITS_MAX_DIGITS - 1);
    const str = String(num);
    const n = Math.min(str.length, HITS_MAX_DIGITS);
    for (let i = 0; i < HITS_MAX_DIGITS; i++) {
      const sp = s.hits.digits[i]!;
      if (i < n) {
        sp.texture = this.frame('num', Number(str[i])) ?? sp.texture;
        sp.visible = true;
      } else {
        sp.visible = false;
      }
    }
    // P2 右缘锚：行容器随位数左移（原版 _txtmc.x = -_txtmc.width + digitRightX）
    const digitW = this.tex.get('num')?.width ?? 47;
    const w = (n - 1) * d.digitWidth + digitW;
    if (s === this.sides[2]) s.hits.row.x = d.digitRightX + d.ctOffset[0] - w;
    s.hits.root.alpha = 1;
    s.hits.root.visible = true;
    s.hits.fading = false;
  }

  /** 每渲染帧更新（原版 60Hz render 语义；dtMs 供 READY 动画/淡出推进）。 */
  update(snap: SimSnapshot, dtMs: number): void {
    const fs = snap.state.fighters;
    const f1 = fs.find((f) => f.id === 1);
    const f2 = fs.find((f) => f.id === 2);
    if (f1) this.updateSide(this.sides[1]!, f1, f2 ?? f1, dtMs);
    if (f2) this.updateSide(this.sides[2]!, f2, f1 ?? f2, dtMs);
    this.updateStartKO(snap);
  }

  /** 开局字样（intro 切片，原版 FightUI.showStart/renderStartAndKO）：
   *  intro step 7 期间快照驱动流帧（hold 每 2 sim tick 一帧 = 30Hz）；intro
   *  结束/跳过 = clearStartAndKO 隐藏（原版 COMPLETE → clearStartAndKO）。 */
  private updateStartKO(snap: SimSnapshot): void {
    const sp = this.startKO;
    if (!sp) return;
    const intro = snap.state.intro;
    if (intro == null || intro.step !== 7) {
      sp.visible = false;
      return;
    }
    sp.visible = true;
    sp.texture =
      this.frame('startko', Math.min(Math.floor(intro.hold / 2), this.data.startKO.frames - 1)) ??
      sp.texture;
  }

  /** f = 本侧角色；target = 对面角色（连击隐藏按目标状态判定）。 */
  private updateSide(s: SideHud, f: SimSnapshot['state']['fighters'][number], target: SimSnapshot['state']['fighters'][number], dtMs: number): void {
    // —— 血条（原版 FighterHpBar.render）——
    const rate = Math.max(0, f.hp / f.hpMax);
    const hp = s.hp;
    if (hp.redMoving && rate !== hp.prevRate) {
      hp.red.scale.x = hp.prevRate;
      hp.redMoving = false;
    }
    hp.prevRate = rate;
    hp.green.scale.x = rate;
    switch (f.actionState) {
      case ActionState.HURT_ING:
      case ActionState.HURT_FLYING:
        hp.delay = 100;
        break;
      case ActionState.HURT_DOWN:
        if (hp.delay > 0) {
          if (!hp.justHurtFly) {
            hp.delay = 1.5 * FPS_GAME;
            hp.justHurtFly = true;
            break;
          }
          if (hp.delay > 0) hp.delay--;
          break;
        }
        break;
      default:
        hp.delay = 0;
        hp.justHurtFly = false;
    }
    if (hp.delay <= 0) {
      const diffRed = rate - hp.redScale;
      const addRateRed = diffRed < 0 ? 0.1 : 0.02;
      if (Math.abs(diffRed) < 0.01) {
        hp.redScale = rate;
        hp.redMoving = false;
      } else {
        hp.redScale += diffRed * addRateRed;
        hp.redMoving = true;
      }
      hp.red.scale.x = hp.redScale;
    }

    // —— 能量条（原版 EnergyBar.render；energyMax = 100）——
    const en = s.energy;
    const eRate = Math.max(0, f.energy / 100);
    en.fill.scale.x = eRate * en.fillStretch;
    if (f.energyOverload) {
      if (!en.overload) {
        en.overload = true;
        en.fill.texture = this.frame('energy-fill', 1) ?? en.fill.texture;
      }
      en.label.alpha = 1; // 原版标签 overLoad 切 inner 帧（未收编，登记偏离）
    } else {
      if (en.overload) {
        en.overload = false;
        en.fill.texture = this.frame('energy-fill', 0) ?? en.fill.texture;
      }
      if (eRate < ENERGY_FLASH_RATE) {
        if (++en.flashInt > 2) {
          en.flashInt = 0;
          en.flashFrame = en.flashFrame === 1 ? 2 : 1;
          en.fill.texture = this.frame('energy-fill', en.flashFrame - 1) ?? en.fill.texture;
          en.label.alpha = en.flashFrame === 1 ? 1 : 0.4; // 偏离：alpha 闪烁近似
        }
      } else if (en.label.alpha !== 1) {
        en.flashInt = 0;
        en.flashFrame = 1;
        en.label.alpha = 1;
      }
    }

    // —— 气条（原版 QiBar.render / InsBar.setProcess / InsFzBar）——
    const qi = s.qi;
    const v = Math.min(f.qi / 100, 3);
    qi.segs[0]!.visible = v > 0;
    qi.segs[1]!.visible = v > 1;
    qi.segs[2]!.visible = v > 2;
    qi.segs[3]!.visible = v >= 3;
    if (v > 2) {
      qi.segs[0]!.scale.x = 1;
      qi.segs[1]!.scale.x = 1;
      qi.segs[2]!.scale.x = v - 2;
    } else if (v > 1) {
      qi.segs[0]!.scale.x = 1;
      qi.segs[1]!.scale.x = v - 1;
    } else {
      qi.segs[0]!.scale.x = v;
    }
    qi.ghost.visible = v < 1;
    if (qi.ghost.visible) {
      qi.ghost.texture = this.frame('qi-ghost', v > 0.6 ? 1 : 0) ?? qi.ghost.texture;
    }
    qi.txt.texture = this.frame('qi-txt', Math.min(Math.floor(v) + 1, 3)) ?? qi.txt.texture;
    // 辅助格：底部向上填充（mask 底部锚定带高 = fv×45）
    const fv = Math.max(0, Math.min(1, f.fzqi / 100));
    const maskH = fv * this.data.qi.fzFillSize[1];
    if (Math.abs(maskH - qi.fzMaskH) > 0.001) {
      qi.fzMaskH = maskH;
      const h = this.data.qi.fzFillSize[1];
      qi.fzMask
        .clear()
        .rect(this.data.qi.fzFillPos[0], this.data.qi.fzFillPos[1] + h - maskH, this.data.qi.fzFillSize[0], maskH)
        .fill(0xffffff);
    }
    // 红点/READY：fzqi 满（偏离：原版 isCanHurtBreak）；READY 20 帧 @30fps 循环
    const fzFull = fv >= 1;
    qi.dot.visible = fzFull;
    if (qi.ready.visible !== fzFull) {
      qi.ready.visible = fzFull;
      qi.readyPlaying = fzFull;
      if (!fzFull) {
        qi.ready.texture = this.frame('ready-anim', 0) ?? qi.ready.texture;
        qi.readyAcc = 0;
      }
    }
    if (qi.readyPlaying) {
      qi.readyAcc += dtMs;
      const frames = this.frames.get('ready-anim')?.length ?? this.data.readyAnim.frames;
      qi.ready.texture =
        this.frame('ready-anim', Math.floor(qi.readyAcc / (1000 / this.data.readyAnim.fps)) % frames) ??
        qi.ready.texture;
    }

    // —— 连击隐藏（原版 onHurtResume/onHurtDown：目标恢复/倒地即清）——
    const targetHurt =
      target.actionState === ActionState.HURT_ACT_ING ||
      target.actionState === ActionState.HURT_ING ||
      target.actionState === ActionState.HURT_FLYING;
    if (s.hits.count > 0 && !targetHurt) {
      s.hits.count = 0;
      if (s.hits.root.visible && !s.hits.fading) s.hits.fading = true;
    }
    if (s.hits.fading) {
      s.hits.root.alpha = Math.max(0, s.hits.root.alpha - dtMs / HITS_FADE_MS);
      if (s.hits.root.alpha <= 0) {
        s.hits.root.visible = false;
        s.hits.fading = false;
      }
    }
  }

  /** 场景退出清理（同 renderer.destroy 语义：从父层摘除并销毁整树）。 */
  destroy(): void {
    this.root.removeFromParent();
    this.root.destroy({ children: true });
    this.sides = { 1: emptySide(), 2: emptySide() };
    this.tex.clear();
    this.frames.clear();
    this.pinned = [];
    this.hpBars = null;
  }
}

type PinX = 'left' | 'right' | 'center';
type PinY = 'top' | 'bottom' | 'center';
