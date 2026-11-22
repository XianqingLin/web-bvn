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
 *   - 辅助格红点 = 被动提示（切片 57 收编）：可见性按原版 isCanHurtBreak
 *     语义由快照派生（energy/qi/hurtChain/hurtBreakCd），不再用 fzqi 满近似；
 *   - 宽屏血条延伸：原版 800 宽下血条外缘搭进计时板近缘 ~9px，逐元素钉边后
 *     该重叠随中线外移变成空隙 → 血条横向拉伸每侧补 (visW-800)/2（原版位形
 *     scale 恒 1；横线条纹理拉伸不可感知，与切人横幅/bgFixed 同款适配）。
 *
 * 多局制渲染收编（PROGRESS §2.5 渲染块）：计时板数字（FightTimeUI time_txtmc，
 * gameTime 驱动、训练显 ∞）、start_final 段（round≥5 开局分支，go:fight 重定向
 * 复用 fight 段）、timeover/drawgame 结算段（timerOver 路径 + bannerTimeover/
 * bannerDraw 播报音沿 onBanner 回调）、胜利星逐局累积（WinUI w1/w2 双槽）。
 *
 * 遗留（未收编）：被动条 sp（登记 PROGRESS 遗留池）。scoremc 街机得分板随
 * 结算画面/街机模式定案不做一并出池（2026-11-21）。开局段（start+fight）已收编（intro 切片：core 冻结期快照驱动，
 * intro.step===7 期间 30Hz 流帧；Round 数字 = nummc 收编修正，批次 43——帧位图
 * 数字区烘焙擦除 + startko-num 合成帧按 min(round,5) 选组叠放）。
 */
import { Assets, Container, Graphics, Rectangle, Sprite, Texture } from 'pixi.js';
import { ActionState, type SimSnapshot } from '@bvn/core';

/** 原版舞台规格（HUD 布局设计空间） */
const STAGE_W = 800;
const STAGE_H = 600;
/** Round 字样水平居中偏移回退值（修复批次 44 实测；批次 62 起 baked 携带
 *  per-round delta——回退仅兼容旧 baked/hud.json） */
const ROUND_CENTER_DELTA_FALLBACK = 39.5;
/** 能量条阈值（原版 EnergyBar render：rate < 0.3 闪烁） */
const ENERGY_FLASH_RATE = 0.3;
/** 连击隐藏淡出时长（ms；偏离：原版播 fadout 时间轴） */
const HITS_FADE_MS = 400;
/** 连击数字上限（MCNumber 无上限；显示池按 4 位封顶） */
const HITS_MAX_DIGITS = 4;
/** 时间板数字上限（MCNumber bits=2 起步；自定义 fightTime>99 支持到 3 位） */
const TIME_NUM_MAX_DIGITS = 3;
/** 原版 GameConfig.FPS_GAME（FighterHpBar redbar 延迟 1.5×FPS 帧） */
const FPS_GAME = 60;
/** 辅助脸尺寸（原版 getFighterFace 缺省 size 50×50） */
const ASSIST_FACE_SIZE = 50;

/** baked/hud.json（tools/ui-pack/hud-pack.mjs 产物，schema bvn/hud@1） */
export interface HudData {
  schema: string;
  /** 元素名 → assets 相对路径（文件 .webp / 帧集为目录） */
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
    time: {
      bgPos: [number, number];
      infPos: [number, number];
      /** 时间数字（time_txtmc/MCNumber，多局制收编）：局部 (-22,-15)、逐位步进
       *  20px、两位零填充；旧 baked 缺省 = 恒显 ∞ */
      numPos?: [number, number];
      numDigitW?: number;
    };
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
   *  坐标，pos = ui_fight 舞台摆放点——烘焙时已换算，见 hud-pack.mjs）。
   *  num = Round 数字合成帧（nummc 收编修正，批次 43）：原版 nummc 由帧脚本
   *  gotoAndPlay("r"+$round) 控制显示当前回合数字，帧导出无法执行脚本 → 帧位图
   *  的数字区已烘焙擦除，数字帧独立合成（startko-num/<组×帧数+帧内序>），运行时
   *  按 min(round,5) 选组叠放（pos = 数字画布相对 pos 的偏移）。 */
  startKO: {
    frames: number;
    fps: number;
    canvasOrigin: [number, number];
    pos: [number, number];
    /** Round 词居中 delta（center 钉扎下 PNG 原点 x = pos + delta；批次 62 烘焙，
     *  旧 baked 缺省回退 39.5） */
    centerDelta?: number;
    /** 逐帧居中 delta（下标 = 资产帧-1；批次 62 烘焙。词段/Fight! 段实测；
     *  数字窗口内为词 delta 占位，运行时按回合以 num.centerDeltas 覆盖） */
    frameDeltas?: number[];
    num?: {
      pos: [number, number];
      from: number;
      to: number;
      digits: number;
      frames: number;
      /** per-round 组合居中 delta（回合 1..digits；批次 62 烘焙，缺省退 centerDelta） */
      centerDeltas?: number[];
    };
    /** start_final 段（round≥5 开局分支，多局制收编）：45 帧独立烘焙
     *  （startko-final），段内 go:fight 由运行时重定向复用 startko fight 段
     *  （资产帧 46..79）→ 总帧数与 start 段等长；centerDelta = 稳态固定值
     *  （逐字弹入期不逐帧居中）。旧 baked 缺省 = 恒用 start 段。 */
    final?: { frames: number; centerDelta?: number };
  };
  /** 结算字样（回合结算流程收编）：ko = startKOmc KO 段；winner = 嵌套 winnermc
   *  独立时间轴（perfectFrom = Perfect 段起始资产帧，非 perfect 定格于其前帧）。
   *  旧 baked 缺省 = 不挂载（向后兼容）。 */
  endKO?: {
    ko: { frames: number; fps: number; pos: [number, number] };
    winner: { frames: number; perfectFrom: number; posP1: [number, number]; posP2: [number, number] };
    /** timeover/drawgame 结算段（多局制收编；与 ko 段同画布同摆位）：
     *  timerOver 置位即播 timeover，平局续播 drawgame（定格段尾至重开），
     *  非平局被 winner 字样替换。旧 baked 缺省 = 不挂载。 */
    timeover?: { frames: number; fps: number; pos: [number, number] };
    drawgame?: { frames: number; fps: number; pos: [number, number] };
  };
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
  /**
   * 结算段播报音回调（多局制收编）：HUD 检测 timeover/drawgame 字样段显示
   * 沿时调用（原版 mc_043 声音层贴帧音 sound_009/bannerTimeover、
   * sound_008/bannerDraw）；core 不持渲染常量（drawgame 段起点 = timeover
   * 段帧数×2 的表现换算）故不走 sim sound 事件，由渲染沿驱动。双端快照
   * 一致 → 同拍触发（音频非 sim 状态，不影响确定性）。
   */
  onBanner?: (id: 'bannerTimeover' | 'bannerDraw') => void;
  fighters: { p1: HudFighterSpec; p2: HudFighterSpec };
  /**
   * 团队 roster 大脸/能量标签（切片 36）：fighter id → 装配（roster 全员）；
   * 缺省 = 1v1 静态消费 fighters.p1/p2。存在时 update 按快照 match.teams
   * 解析各侧出战者，切脸/能量标签帧随之切换（faces 预载免异步闪白）。
   */
  teamFighters?: Record<number, HudFighterSpec> | undefined;
}

/** 胜利星槽位动画态（updateWinStars 推进） */
interface WinStarState {
  /** 已点亮（wins 达槽且 winApplied 落位起播；wins 回退复位） */
  activated: boolean;
  /** 段动画播放中（dtMs 推进，播尽定格段尾） */
  playing: boolean;
  /** 段内帧游标（浮点 30fps 步进） */
  f: number;
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
  /** 开局字样钉扎项引用（updateStartKO 按回合改 x 重摆——修复批次 62
   *  per-round 居中 delta：数字宽度逐回合不同，固定 delta 不居中） */
  private startKOPin: { c: Container; x: number; y: number; mx: PinX; my: PinY } | null = null;
  private startKONumPin: { c: Container; x: number; y: number; mx: PinX; my: PinY } | null = null;
  /** 当前生效居中 delta（回合变化检测） */
  private startKODelta: number | null = null;
  /** 开局字样 Round 数字（nummc 收编修正，批次 43；updateStartKO 驱动） */
  private startKONum: Sprite | null = null;
  /** 时间板 ∞ / 数字件（updateTime 驱动；多局制收编） */
  private timeInfSp: Sprite | null = null;
  private timeNumSp: Sprite[] | null = null;
  /** 结算字样（回合结算流程收编；updateEndKO 驱动，全快照驱动免渲染态）：
   *  KO 字样单件 + winner 字样双侧件（按胜方侧显隐）+ timeover/drawgame 段
   *  单件（timerOver 路径，多局制收编）+ 胜利星双侧双槽件（w1/w2，仅 1v1） */
  private endKOSp: Sprite | null = null;
  private winnerSp: { 1: Sprite | null; 2: Sprite | null } = { 1: null, 2: null };
  private timeoverSp: Sprite | null = null;
  private drawgameSp: Sprite | null = null;
  /** 胜利星（多局制逐局累积）：[w1, w2] 槽位件 + 槽位动画态。原版 WinUI：
   *  wins=1 → team1 播 w1 / team2 播 w2（P2 a=-1 镜像）；wins=2 → 另一槽；
   *  播尽定格段尾（槽位件独立时间轴）→ 逐局累积可见。 */
  private winStarSp: { 1: Sprite[]; 2: Sprite[] } = { 1: [], 2: [] };
  private winStarAnim: { 1: WinStarState[]; 2: WinStarState[] } = { 1: [], 2: [] };
  /** roundEnd 出现沿检测（换人/新回合 roundEnd 卸下后复位显隐） */
  private endRoundSeen = false;
  /** timeover 播报音沿（每 roundEnd 实例一次；roundEnd 卸下复位） */
  private timeoverBannerFired = false;
  /** 团队换人（切片 36）：双侧大脸/能量标签可换件 + roster 脸纹理缓存 */
  private faceSp: { 1: Sprite | null; 2: Sprite | null } = { 1: null, 2: null };
  private energyLabelSp: { 1: Sprite | null; 2: Sprite | null } = { 1: null, 2: null };
  private teamFaceTex = new Map<number, Texture>();
  private activeFace: { 1: number | null; 2: number | null } = { 1: null, 2: null };
  /** fighter id → 所属侧（团队换人后 onHit 归侧；1v1 恒空） */
  private sideOf = new Map<number, 1 | 2>();
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
    // 元素纹理并发装载（原串行 await：帧集多的 HUD 要数十次往返才搭完静态树）
    await Promise.all(
      Object.entries(this.data.elements).map(async ([name, path]) => {
        if (path.endsWith('.webp')) {
          this.tex.set(name, await Assets.load<Texture>(`${baseUrl}/${path}`));
        } else {
          this.frames.set(name, await this.loadFrames(`${baseUrl}/${path}`));
        }
      }),
    );
    // 团队 roster 大脸预载（切片 36）：换人切脸同步换纹理，免异步闪白
    if (this.spec.teamFighters) {
      await Promise.all(
        Object.entries(this.spec.teamFighters).map(async ([id, f]) => {
          if (!f.faceUrl) return;
          this.teamFaceTex.set(Number(id), await Assets.load<Texture>(f.faceUrl));
        }),
      );
    }
    this.build();
  }

  /** 帧集目录：1.webp 起连续装载，缺失即止。按批并发（每批 8 张），语义不变但往返从 N 降到 N/8。 */
  private async loadFrames(url: string): Promise<Texture[]> {
    const out: Texture[] = [];
    const BATCH = 8;
    for (let start = 1; ; start += BATCH) {
      const results = await Promise.all(
        Array.from({ length: BATCH }, (_, k) =>
          Assets.load<Texture>(`${url}/${start + k}.webp`).catch(() => null),
        ),
      );
      let stopped = false;
      for (const tex of results) {
        if (!tex) {
          stopped = true;
          break;
        }
        out.push(tex);
      }
      if (stopped) break;
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
    const face1 = this.buildFace(this.spec.fighters.p1.faceUrl, 1);
    const face2 = this.buildFace(this.spec.fighters.p2.faceUrl, 2);
    face2.scale.x = -1;
    // —— 能量条（mc_032 等价物；P2 容器镜像 + 标签双翻）——
    const en1 = this.buildEnergy(s1, 1, this.spec.fighters.p1.comicType, 1);
    const en2 = this.buildEnergy(s2, 2, this.spec.fighters.p2.comicType, -1);
    en2.scale.x = -1;
    // —— 计时板（mc_038；FightTimeUI：gameTimeMax==-1 显 ∞，否则数字）——
    const time = new Container();
    const timeBg = this.sprite('time-bg');
    timeBg.position.set(d.hp.time.bgPos[0], d.hp.time.bgPos[1]);
    const inf = this.sprite('time-inf');
    inf.position.set(d.hp.time.infPos[0], d.hp.time.infPos[1]);
    time.addChild(timeBg, inf);
    this.timeInfSp = inf;
    // 时间数字（time_txtmc/MCNumber 多局制收编）：两位零填充、逐位步进
    // numDigitW；MCNumber.createNum gotoAndStop(1+digit) → 帧 N = 数字 N-1
    if (this.frames.has('time-num') && d.hp.time.numPos) {
      const dw = d.hp.time.numDigitW ?? 20;
      this.timeNumSp = [];
      for (let i = 0; i < TIME_NUM_MAX_DIGITS; i++) {
        const sp = new Sprite(Texture.EMPTY);
        sp.position.set(d.hp.time.numPos[0] + i * dw, d.hp.time.numPos[1]);
        sp.visible = false;
        time.addChild(sp);
        this.timeNumSp.push(sp);
      }
    }
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
      // center 钉扎 + 居中 delta（批次 44 固定值 → 批次 62 per-round 烘焙，
      // updateStartKO 按回合查表改 x）
      this.startKOPin = {
        c: ko,
        x: d.startKO.pos[0] + (d.startKO.centerDelta ?? ROUND_CENTER_DELTA_FALLBACK),
        y: d.startKO.pos[1],
        mx: 'center',
        my: 'top',
      };
      this.pinned.push(this.startKOPin);
      this.startKO = ko;
      // Round 数字（nummc 收编修正）：帧位图数字区已烘焙擦除，此件按
      // min(round,5) 选组叠放（updateStartKO 驱动，与字样同窗口显隐）
      if (d.startKO.num && this.frames.has('startko-num')) {
        const num = new Sprite(Texture.EMPTY);
        num.visible = false;
        this.root.addChild(num);
        this.startKONumPin = {
          c: num,
          x:
            d.startKO.pos[0] +
            d.startKO.num.pos[0] +
            (d.startKO.centerDelta ?? ROUND_CENTER_DELTA_FALLBACK),
          y: d.startKO.pos[1] + d.startKO.num.pos[1],
          mx: 'center',
          my: 'top',
        };
        this.pinned.push(this.startKONumPin);
        this.startKONum = num;
      }
    }

    // —— 结算字样（回合结算流程收编）——
    // KO 段（startko-ko，startKOmc ko 段独立烘焙）：playKO2 y=0 → 画布原点落
    // ui_fight (13,103)。center 钉扎保持原版 800 舞台内的设计偏移（K.O. 字样
    // 中心 413 = 中线 +13，与 start 段的 Round 组合 delta 修正无关）。
    if (this.frames.has('startko-ko') && d.endKO) {
      const ko = new Sprite(Texture.EMPTY);
      ko.visible = false;
      this.root.addChild(ko);
      this.pinned.push({
        c: ko,
        x: d.endKO.ko.pos[0],
        y: d.endKO.ko.pos[1],
        mx: 'center',
        my: 'top',
      });
      this.endKOSp = ko;
    }
    // winner 字样（winnerko = 嵌套 winnermc 独立时间轴）：$winnerX=30|546 按胜
    // 方侧 + $winnerY=90 + showWinner startKOmc.y=30 → 原点 (30|546,120)。
    // P1 钉左 / P2 钉右（原版舞台绝对坐标随钉边语义）。PNG(0,0) = sprite 原点
    //（烘焙假设，目检项）。
    if (this.frames.has('winnerko') && d.endKO) {
      for (const side of [1, 2] as const) {
        const sp = new Sprite(Texture.EMPTY);
        sp.visible = false;
        this.root.addChild(sp);
        const pos = side === 1 ? d.endKO.winner.posP1 : d.endKO.winner.posP2;
        this.pinned.push({
          c: sp,
          x: pos[0],
          y: pos[1],
          mx: side === 1 ? 'left' : 'right',
          my: 'top',
        });
        this.winnerSp[side] = sp;
      }
    }
    // timeover/drawgame 结算段（多局制收编）：与 KO 段同画布同摆位
    //（playTimeOver y=0 语义），timerOver 路径按段序显隐
    if (d.endKO?.timeover && this.frames.has('startko-timeover')) {
      const sp = new Sprite(Texture.EMPTY);
      sp.visible = false;
      this.root.addChild(sp);
      this.pinned.push({
        c: sp,
        x: d.endKO.timeover.pos[0],
        y: d.endKO.timeover.pos[1],
        mx: 'center',
        my: 'top',
      });
      this.timeoverSp = sp;
    }
    if (d.endKO?.drawgame && this.frames.has('startko-drawgame')) {
      const sp = new Sprite(Texture.EMPTY);
      sp.visible = false;
      this.root.addChild(sp);
      this.pinned.push({
        c: sp,
        x: d.endKO.drawgame.pos[0],
        y: d.endKO.drawgame.pos[1],
        mx: 'center',
        my: 'top',
      });
      this.drawgameSp = sp;
    }
    // 胜利星双槽（多局制逐局累积，原版 WinUI）：w1/w2 槽位件各侧各一
    //（P2 a=-1 镜像 → 槽位偏移翻 x）；绝对位 = hpbarmc 原点 + 容器 + 槽位。
    // 原版 team1 wins=1 播 w1 / wins=2 播 w2，team2 反序（镜像下视觉同侧递进）
    if (this.frames.has('win')) {
      const w = d.hp.win;
      for (const side of [1, 2] as const) {
        const base = side === 1 ? w.p1 : w.p2;
        const sign = side === 1 ? 1 : -1;
        for (const off of [w.w1, w.w2]) {
          const sp = new Sprite(Texture.EMPTY);
          sp.visible = false;
          this.root.addChild(sp);
          this.pinned.push({
            c: sp,
            x: o[0] + base[0] + sign * off[0],
            y: o[1] + base[1] + off[1],
            mx: side === 1 ? 'left' : 'right',
            my: 'top',
          });
          this.winStarSp[side].push(sp);
          this.winStarAnim[side].push({ activated: false, playing: false, f: 0 });
        }
      }
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

  private buildFace(faceUrl: string | null, side: 1 | 2): Container {
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
      this.faceSp[side] = sp; // 团队换人切脸件（applyActiveFace 换纹理）
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

  private buildEnergy(side: SideHud, sideNum: 1 | 2, comicType: number, direct: 1 | -1): Container {
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
    this.energyLabelSp[sideNum] = label; // 团队换人切标签件（applyActiveFace 换帧）
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
    // 深度序（fight.swf sprite 98 编译实证）：shape89 → sp 红点(dpt2) →
    // barmc 填充(dpt4) → shape97 顶框——红点垫在填充之下，fzqi 满格时被盖
    //（原版语义：召唤可用 READY 与被动提示互斥呈现）
    fz.addChild(dot, fzClip, fzTop);
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

  /**
   * hit:connect 桥（renderer 事件消费调用）。attacker = fighter id（1/2 或
   * 团队换人后的 roster id——sideOf 映射归侧，update 按快照刷新）。
   */
  onHit(attacker: number): void {
    const side =
      attacker === 1 ? 1 : attacker === 2 ? 2 : (this.sideOf.get(attacker) ?? null);
    if (side === null) return;
    const s = this.sides[side];
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
    const teams = snap.state.match.teams;
    let f1: (typeof fs)[number] | undefined;
    let f2: (typeof fs)[number] | undefined;
    if (teams != null && this.spec.teamFighters) {
      // 团队换人（切片 36）：按快照 roster 解析各侧出战者；连击归侧映射 +
      // 出战者切换时换大脸/能量标签帧
      this.sideOf.clear();
      for (const s of teams.p1) this.sideOf.set(s.id, 1);
      for (const s of teams.p2) this.sideOf.set(s.id, 2);
      f1 = fs.find((f) => teams.p1.some((s) => s.id === f.id));
      f2 = fs.find((f) => teams.p2.some((s) => s.id === f.id));
      this.applyActiveFace(1, f1?.id ?? null);
      this.applyActiveFace(2, f2?.id ?? null);
    } else {
      f1 = fs.find((f) => f.id === 1);
      f2 = fs.find((f) => f.id === 2);
    }
    if (f1) this.updateSide(this.sides[1]!, f1, f2 ?? f1, dtMs);
    if (f2) this.updateSide(this.sides[2]!, f2, f1 ?? f2, dtMs);
    this.updateTime(snap);
    this.updateStartKO(snap);
    this.updateEndKO(snap);
    this.updateWinStars(snap, dtMs);
  }

  /** 时间板（FightTimeUI 语义）：gameTimeMax==-1 显 ∞ 隐数字；否则反向，
   *  两位零填充秒数（gameTime 归零即 timeover 置位，显示钳 0）。 */
  private updateTime(snap: SimSnapshot): void {
    if (!this.timeNumSp) return;
    const m = snap.state.match;
    const timed = m.gameTimeMax !== -1;
    if (this.timeInfSp) this.timeInfSp.visible = !timed;
    if (!timed) {
      for (const sp of this.timeNumSp) sp.visible = false;
      return;
    }
    const str = String(Math.max(0, m.gameTime)).padStart(2, '0');
    for (let i = 0; i < this.timeNumSp.length; i++) {
      const sp = this.timeNumSp[i]!;
      if (i < str.length) {
        sp.texture = this.frame('time-num', Number(str[i])) ?? sp.texture;
        sp.visible = true;
      } else {
        sp.visible = false;
      }
    }
  }

  /** 出战者切换：换大脸纹理 + 能量标签帧（团队 roster 预载纹理同步切换）。 */
  private applyActiveFace(side: 1 | 2, id: number | null): void {
    if (id === null || this.activeFace[side] === id) return;
    const spec = this.spec.teamFighters?.[id];
    if (!spec) return;
    this.activeFace[side] = id;
    const face = this.faceSp[side];
    if (face) face.texture = this.teamFaceTex.get(id) ?? Texture.EMPTY;
    const label = this.energyLabelSp[side];
    if (label) label.texture = this.frame('energy-label', spec.comicType) ?? label.texture;
  }

  /** 开局字样（intro 切片，原版 FightUI.showStart/renderStartAndKO）：
   *  intro step 7 期间快照驱动流帧（hold 每 2 sim tick 一帧 = 30Hz）；intro
   *  结束/跳过 = clearStartAndKO 隐藏（原版 COMPLETE → clearStartAndKO）。
   *  Round 数字（nummc 收编修正，批次 43）：原版 mc_043 帧脚本
   *  nummc.gotoAndPlay("r"+$round)（FightUI.showStart 设 $round）→ 按
   *  min(round,5) 选合成帧组，与字样帧同窗口显隐。
   *  居中 delta（修复批次 62）：分段烘焙——词段/Fight! 段逐帧查 frameDeltas，
   *  数字窗口（词+数字组合，数字宽度逐回合不同）查 num.centerDeltas；回合/
   *  帧变化时改钉扎 x 重摆。旧 baked 无表回退固定 centerDelta。 */
  private updateStartKO(snap: SimSnapshot): void {
    const sp = this.startKO;
    if (!sp) return;
    const intro = snap.state.intro;
    if (intro == null || intro.step !== 7) {
      sp.visible = false;
      if (this.startKONum) this.startKONum.visible = false;
      return;
    }
    sp.visible = true;
    const d = this.data.startKO;
    const numSpec = d.num;
    const f = Math.floor(intro.hold / 2);
    // start_final 路径（round≥5，原版 showStart gotoAndStop("start_final")）：
    // final 段 45 帧独立驱动；renderStartAndKO 到 go:fight 标签时 gotoAndStop
    // ("fight") 重定向 → 复用 startko fight 段（资产帧 46..79，总帧数 79 与
    // start 路径等长，INTRO_START_TICKS 不变）。居中 = 稳态固定 delta（逐字
    // 弹入期不逐帧居中）；无数字槽（原版 r5 nummc 段死代码佐证）。
    const finalSpec = d.final;
    if (finalSpec != null && snap.state.match.round >= 5) {
      const delta = finalSpec.centerDelta ?? d.centerDelta ?? ROUND_CENTER_DELTA_FALLBACK;
      if (delta !== this.startKODelta) {
        this.startKODelta = delta;
        if (this.startKOPin) this.startKOPin.x = d.pos[0] + delta;
        if (this.startKONumPin && numSpec) {
          this.startKONumPin.x = d.pos[0] + numSpec.pos[0] + delta;
        }
        this.relayout();
      }
      sp.texture =
        f < finalSpec.frames
          ? (this.frame('startko-final', f) ?? sp.texture)
          : (this.frame('startko', Math.min(f, d.frames - 1)) ?? sp.texture);
      if (this.startKONum) this.startKONum.visible = false;
      return;
    }
    const assetFrame = f + 1;
    const round = Math.min(Math.max(snap.state.match.round, 1), numSpec?.digits ?? 1);
    const fallback = d.centerDelta ?? ROUND_CENTER_DELTA_FALLBACK;
    // 数字窗口 = 词+数字组合居中（per-round）；其余帧逐帧 bbox 居中（词-only
    // 段与 Fight! 段组合中心不同，固定 delta 下都偏）
    const inNumWindow = numSpec != null && assetFrame >= numSpec.from && assetFrame <= numSpec.to;
    const delta = inNumWindow
      ? (numSpec?.centerDeltas?.[round - 1] ?? fallback)
      : (d.frameDeltas?.[f] ?? fallback);
    if (delta !== this.startKODelta) {
      this.startKODelta = delta;
      if (this.startKOPin) this.startKOPin.x = d.pos[0] + delta;
      if (this.startKONumPin && numSpec) {
        this.startKONumPin.x = d.pos[0] + numSpec.pos[0] + delta;
      }
      this.relayout();
    }
    sp.texture = this.frame('startko', Math.min(f, d.frames - 1)) ?? sp.texture;
    const num = this.startKONum;
    const spec = numSpec;
    if (!num || !spec) return;
    // 窗口外（字样首段空白/Fight! 段）隐藏
    if (!inNumWindow) {
      num.visible = false;
      return;
    }
    num.texture =
      this.frame('startko-num', (round - 1) * spec.frames + (assetFrame - spec.from)) ??
      num.texture;
    num.visible = true;
  }

  /**
   * 结算字样（回合结算流程收编，原版 FightUI.playKO/playTimeOver/playDrawGame/
   * showWinner + WinUI）：全快照驱动（roundEnd.hold 为 sim tick 计数，30Hz
   * 帧率 = 每 2 tick 一帧）：
   *   - KO 字样：置位 0.5s 后播（原版 playKO2 setTimeout 500ms，KO 音效同步）
   *     47 帧播尽即隐（末帧空黑语义）；timerOver 不播（原版 showEnd 分流
   *     playTimeOver——无 playKO 延迟/表现链）；
   *   - timeover 字样（timerOver 路径，多局制收编）：置位即时起播 44 帧定格
     段尾（原版 playTimeOver gotoAndStop("timeover")——段尾脚本 stop 等
     COMPLETE）；显示沿经 onBanner 回调发 bannerTimeover（原版声音层贴帧音
     sound_009 段首）；
   *   - drawgame 字样（平局续播）：timeover 段计满（44 帧×2 tick）后续播 43
     帧定格段尾至重开（原版 timeoverBack → playDrawGame）；续播沿发
     bannerDraw（sound_008）；
   *   - winner 字样：winApplied 起播 winnermc 1..29（perfect 续播至 56）定格
     （原版帧脚本 frame29/frame56 stop+COMPLETE）；平局不播（原版
     renderDrawGame 无 showWinner）；timerOver 非平局起播时替换 timeover 字样
     （原版 showWinner gotoAndStop("winner") 覆写）。
   */
  private updateEndKO(snap: SimSnapshot): void {
    const re = snap.state.roundEnd;
    if (re == null) {
      if (this.endRoundSeen) {
        // 换人/新回合：复位显隐（下一 KO 重播）。胜利星不在此复位——
        // 逐局累积（updateWinStars 按 wins 收敛，新对局 wins 回退全灭）
        this.endRoundSeen = false;
        this.timeoverBannerFired = false;
        if (this.endKOSp) this.endKOSp.visible = false;
        if (this.timeoverSp) this.timeoverSp.visible = false;
        if (this.drawgameSp) this.drawgameSp.visible = false;
        for (const side of [1, 2] as const) {
          const w = this.winnerSp[side];
          if (w) w.visible = false;
        }
      }
      return;
    }
    this.endRoundSeen = true;
    const d = this.data.endKO;
    // —— KO 字样（30 tick 延迟 + 每 2 sim tick 一帧；timerOver 不播）——
    if (this.endKOSp && d && !re.timerOver) {
      const f = Math.floor((re.hold - 30) / 2);
      if (f >= 0 && f < d.ko.frames) {
        this.endKOSp.texture = this.frame('startko-ko', f) ?? this.endKOSp.texture;
        this.endKOSp.visible = true;
      } else {
        this.endKOSp.visible = false;
      }
    } else if (this.endKOSp) {
      this.endKOSp.visible = false;
    }
    // —— timeover/drawgame 字样（timerOver 路径，原版 playTimeOver/playDrawGame）——
    const drawStart = (d?.timeover?.frames ?? 0) * 2; // 30Hz 帧 → sim tick
    if (this.timeoverSp && d?.timeover && re.timerOver) {
      const f = Math.floor(re.hold / 2);
      if (re.draw) {
        // 平局：timeover 段计满 → drawgame 段续播定格段尾（重开前恒显）
        if (this.drawgameSp && d.drawgame && re.hold >= drawStart) {
          this.timeoverSp.visible = false;
          if (!this.drawgameSp.visible) this.spec.onBanner?.('bannerDraw');
          this.drawgameSp.visible = true;
          const g = Math.floor((re.hold - drawStart) / 2);
          this.drawgameSp.texture =
            this.frame('startko-drawgame', Math.min(g, d.drawgame.frames - 1)) ??
            this.drawgameSp.texture;
        } else {
          this.timeoverSp.visible = true;
          this.timeoverSp.texture =
            this.frame('startko-timeover', Math.min(f, d.timeover.frames - 1)) ??
            this.timeoverSp.texture;
          if (this.drawgameSp) this.drawgameSp.visible = false;
        }
      } else {
        // 非平局：winApplied 起 winner 字样替换（原版 showWinner 覆写段）
        if (re.winApplied) {
          this.timeoverSp.visible = false;
        } else {
          this.timeoverSp.visible = true;
          this.timeoverSp.texture =
            this.frame('startko-timeover', Math.min(f, d.timeover.frames - 1)) ??
            this.timeoverSp.texture;
        }
        if (this.drawgameSp) this.drawgameSp.visible = false;
      }
    } else {
      if (this.timeoverSp) this.timeoverSp.visible = false;
      if (this.drawgameSp) this.drawgameSp.visible = false;
    }
    // timeover 置位显示沿（原版 playTimeOver 即时起播 → sound_009 段首）
    if (this.timeoverSp && re.timerOver && !this.timeoverBannerFired) {
      this.timeoverBannerFired = true;
      this.spec.onBanner?.('bannerTimeover');
    }
    // —— winner 字样（winApplied 起播；draw 不播）——
    const wSp = re.winnerSide === 1 ? this.winnerSp[1] : this.winnerSp[2];
    for (const side of [1, 2] as const) {
      const sp = this.winnerSp[side];
      if (sp && sp !== wSp) sp.visible = false;
    }
    if (wSp && d && re.winApplied && !re.draw) {
      // 起播锚 = winAppliedHold（终结慢镜头/showWinner 延迟后可变，不再恒
      // WIN_TEXT_GATE——KO 终结演出链）
      const f = Math.floor((re.hold - re.winAppliedHold) / 2);
      const max = re.perfect ? d.winner.frames : d.winner.perfectFrom - 1;
      if (f >= 0) {
        wSp.texture = this.frame('winnerko', Math.min(f, max - 1)) ?? wSp.texture;
        wSp.visible = true;
      } else {
        wSp.visible = false;
      }
    } else if (wSp) {
      wSp.visible = false;
    }
  }

  /**
   * 胜利星逐局累积（多局制收编，原版 FightUI.showWins isSingleMode 门 +
   * WinUI.show）：wins≥k 点亮槽 k（team1: w1→w2，team2 镜像反序——build 已按
   * 侧换算绝对位）；点亮沿 = winApplied 落位（原版 showWins 于 showWinner 同
   * 拍）起播 in_bleach/in_naruto 段（按本侧 comicType）定格段尾；槽位件独立
   * 时间轴 → 先行槽保持定格，逐局累积。wins 回退（新对局）全灭复位。
   */
  private updateWinStars(snap: SimSnapshot, dtMs: number): void {
    if (!this.frames.has('win')) return;
    const teams = snap.state.match.teams;
    const re = snap.state.roundEnd;
    const fps = this.data.winAnim.fps;
    for (const side of [1, 2] as const) {
      // 仅 1v1（原版 isSingleMode 门）
      const wins = teams == null ? (side === 1 ? snap.state.match.p1Wins : snap.state.match.p2Wins) : 0;
      const stars = this.winStarSp[side];
      const anims = this.winStarAnim[side];
      // 1v1 装配 comicType（原版按胜方 FighterVO；1v1 恒 side 装配）
      const ct = side === 1 ? this.spec.fighters.p1.comicType : this.spec.fighters.p2.comicType;
      const seg = ct === 1 ? ([30, 40] as const) : ([10, 29] as const);
      const segLen = seg[1] - seg[0] + 1;
      for (let k = 0; k < stars.length; k++) {
        const sp = stars[k]!;
        const st = anims[k]!;
        if (wins < k + 1) {
          if (sp.visible || st.activated) {
            sp.visible = false;
            sp.texture = Texture.EMPTY;
            st.activated = false;
            st.playing = false;
            st.f = 0;
          }
          continue;
        }
        if (!st.activated) {
          if (re != null && re.winApplied && !re.draw && re.winnerSide === side) {
            // 点亮沿：起播（原版 showWins gotoAndPlay）
            st.activated = true;
            st.playing = true;
            st.f = 0;
          } else if (re == null) {
            // 兜底：快照链上无 winApplied 窗口（HUD 中途挂载等）→ 静态点亮
            st.activated = true;
            st.playing = false;
            st.f = segLen - 1;
          } else {
            continue; // 演出未落位，槽位待点亮
          }
        }
        if (st.playing) {
          st.f += dtMs / (1000 / fps);
          if (st.f >= segLen) {
            st.playing = false;
            st.f = segLen - 1;
          }
        }
        sp.texture =
          this.frame('win', seg[0] - 1 + Math.floor(Math.min(st.f, segLen - 1))) ?? sp.texture;
        sp.visible = true;
      }
    }
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
      case ActionState.HURT_DOWN_TAN:
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
    // 红点 = 被动提示（切片 57 收编，原版 QiBar.render _spMc.visible =
    // isCanHurtBreak——FighterMcCtrler: 非冷却 + energy≥50 + qi≥100 +
    // 最后一击非必杀 + 链内无破防 + 链伤害 ≤210；不查 HURT_ING/辅助键，
    // 与 core stepHurtBreak 触发门的差异是原版语义）。快照派生，不进 core。
    // READY = fzqi 满（召唤可用提示，原版 _fzReadyMc 门）；20 帧 @30fps 循环
    const fzFull = fv >= 1;
    const chain = f.hurtChain;
    qi.dot.visible =
      (f.hurtBreakCd ?? 0) <= 0 &&
      f.energy >= 50 &&
      f.qi >= 100 &&
      !(chain !== undefined && (chain.bisha || chain.breakDef || chain.damage > 210));
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
    // 弹起中（HURT_DOWN_TAN）无 HURT_DOWN 事件，连击保持（原版一致）
    const targetHurt =
      target.actionState === ActionState.HURT_ACT_ING ||
      target.actionState === ActionState.HURT_ING ||
      target.actionState === ActionState.HURT_FLYING ||
      target.actionState === ActionState.HURT_DOWN_TAN;
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
    this.startKOPin = null;
    this.startKONumPin = null;
    this.startKODelta = null;
    this.timeInfSp = null;
    this.timeNumSp = null;
    this.endKOSp = null;
    this.winnerSp = { 1: null, 2: null };
    this.timeoverSp = null;
    this.drawgameSp = null;
    this.winStarSp = { 1: [], 2: [] };
    this.winStarAnim = { 1: [], 2: [] };
  }
}

type PinX = 'left' | 'right' | 'center';
type PinY = 'top' | 'bottom' | 'center';
