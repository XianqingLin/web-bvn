/**
 * 角色运行时定义（core 自持结构类型）与动作状态码。
 *
 * FighterDef 是静态配置数据（与 SimConfig 同级注入），**不进 SimState**：
 * Sim 持有 id → def 注册表（静态数据不属于可变模拟状态，快照/恢复时
 * 由调用方重新注入，与 stage 走 SimConfig 的理由一致）。
 * 结构上兼容 @bvn/data compileFighterRuntime 的产出（FighterView）。
 */

/** 命中判定定义（原版 HitVO/defineAction 参数，module-map §5.6）。 */
export interface HitDef {
  power: number;
  /** 1砍/2打/3重打/4魔法轻/5魔法重/6重砍/7火/8冰/9电/10石化/11摔 */
  hitType: number;
  /** 击退水平速度（原版 px/帧@30fps 语境，core 按 ×SPEED_PLUS 换算） */
  hitx: number;
  /** 击飞上升速度（>0 触发击飞状态） */
  hity: number;
  /** 受击硬直（毫秒，原版 30fps 计时语境；core 按 ms→30Hz 帧换算） */
  hurtTime: number;
  hurtType: number;
  isBreakDef: boolean;
  /** 命中后受击方是否施加重力（原版 HitVO.isApplyG，抓取吸附系为 false） */
  isApplyG: boolean;
}

/** 帧标签 → 时间轴区间（30Hz 动画帧，index 0 起）。 */
export interface LabelRange {
  index: number;
  duration: number;
}

/** 判定区矩形（角色 root 本地坐标，direct=1 朝右；原点=脚底锚点）。 */
export interface AreaRect {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 行为参数（与 data 的 TriggerArg 同构；core 不 import data）。 */
export type BehaviorArg =
  | number
  | string
  | boolean
  | null
  | BehaviorArg[]
  | { [key: string]: BehaviorArg }
  | { $ref: string };

/**
 * 条件查询（原版帧脚本 if($xx_ctrler.query()){...}else{...}，切片 11）。
 * 查询 op 语料集：justHit / targetInRange / getTargetState / getSelf /
 * getTargetSP（原版 FighterCtrler，纯读无副作用）。
 */
export interface TriggerCondition {
  target: string;
  op: string;
  args: BehaviorArg[];
  /** 原版 `!` 前缀取反 */
  negate?: boolean;
  /** 查询后取的属性链（如 getSelf().isInAir → ['isInAir']） */
  path?: string[];
  /** 属性值与字面量比较（缺省 = 真值判定，AS 语义：0/空 为假） */
  cmp?: { op: '==' | '!=' | '<' | '>' | '<=' | '>='; value: number | boolean };
}

/** 条件分支体内的简单调用。 */
export interface TriggerBranchCall {
  target: string;
  op: string;
  args: BehaviorArg[];
}

/** 帧触发（帧号 1 起，与 areas 的 frame 对齐）。 */
export interface FrameTrigger {
  frame: number;
  /** mc=自身动作控制 / fighter=战斗逻辑 / effect=表现 / assister=辅助逻辑 */
  target: string;
  op: string;
  args: BehaviorArg[];
  /** 条件触发（op='if'）：cond 成立执行 then，否则执行 else */
  cond?: TriggerCondition;
  then?: TriggerBranchCall[];
  else?: TriggerBranchCall[];
}

/** 角色运行时定义（一个形态的完整战斗数据）。 */
export interface FighterDef {
  id: string;
  formIndex: number;
  /** 根时间轴帧号（1 起，data 层产出）——doWanKai(frame) 绝对帧跳转寻址；缺省不参与寻址 */
  rootFrame?: number;
  /** 形态数值（原版原始值；core 使用时按 ×SPEED_PLUS 换算） */
  speed: number;
  jumpPower: number;
  heavy: number;
  /** 防御类型（修复批次 35：0=剑 SWOARD 缺省 / 1=手 HAND——防御特效 KAN→DA 映射依据） */
  defenseType?: number;
  actions: Record<string, HitDef>;
  labels: Record<string, LabelRange>;
  /** 动画帧（1 起，30Hz）→ 判定区 */
  areas: Record<number, AreaRect[]>;
  totalFrames: number;
  triggers: FrameTrigger[];
  /** 已验证存在的攻击动作 id → 动画标签（缺失 = 动作不可用） */
  attackLabels: Record<string, string>;
  /**
   * 角色侧 attacker 元件脚本（2026-11-21，原版 $attacker_ctrler.*）：
   * addAttacker 元件名 → {labels, triggers}；stepAttackerAnim 对角色生成的
   * 道具逐帧分派（与切片 21 辅助侧同机制，fires[name].triggers 编译来源）。
   */
  attackerScripts?: Record<
    string,
    { labels: Record<string, number>; triggers: FrameTrigger[] }
  >;
  /** fire 元件时间轴元数据（baked fires 包注入；缺元件 = 该 fire 无动画生命周期） */
  fires?: Record<string, FireTimelineDef>;
}

/**
 * fire / attacker 元件时间轴元数据（bvn/fire@1 FireTimeline 的 core 镜像；
 * B5 起 addAttacker 元件含 org（生成锚定基准）+ hits（逐帧命中区，帧号 1 基，
 * 矩形为元件局部 direct=1 空间，名字由消费端按动作表精确 → 去 atm 解析）。
 * fire 弹体不消费 org/hits（弹体命中矩形仍是 main 锚）。
 */
export interface FireTimelineDef {
  totalFrames: number;
  labels: Record<string, number>;
  /** 元件原点在 owner 根时间轴坐标系的摆放位（direct=1；B5 生成锚定） */
  org?: { x: number; y: number };
  /** 逐帧命中区（键 = 1 基帧号字符串；缺帧 = 该帧无判定；B5） */
  hits?: Record<string, { name: string; x: number; y: number; w: number; h: number }[]>;
  /**
   * 元件帧脚本（角色侧 attacker 元件，2026-11-21；原版 $attacker_ctrler.*）：
   * 帧号 1 基、target ∈ {attacker, effect}；compileFighterRuntime 收编进
   * FighterDef.attackerScripts（辅助侧走 AssistantPackage 原字段，切片 21）。
   */
  triggers?: FrameTrigger[];
}

/**
 * 循环触发条件（切片 12，addCustomFunc 数据化；negate = 取反）。
 * checkHitOwner：assister 命名判定区与 owner 身体相交；
 * actionStateIn：owner.actionState ∈ 值集。
 */
export type LoopTriggerCond =
  | { kind: 'checkHitOwner'; name: string; negate?: boolean }
  | { kind: 'actionStateIn'; values: number[]; negate?: boolean };

/** 循环触发（注册帧起每动画帧评估 cond → then，至 untilFrame 独占或时间轴末）。 */
export interface LoopTriggerDef {
  frame: number;
  untilFrame: number | null;
  cond: LoopTriggerCond | null;
  then: TriggerBranchCall[];
}

/** 辅助运行时定义（data 层 compileAssistant 产出；单时间轴无形态）。 */
export interface AssisterDef {
  id: string;
  /**
   * comicType（0=死神 1=火影，select.json assists[].comicType）：出场特效
   * 分流（原版 EffectCtrler.assisterEffect：1 → fz_naruto，否则 fz_bleach）。
   * 缺省 = 死神侧。
   */
  comicType?: number;
  /** 动作表（assister 版动作 id 即命中区名，如 atm1） */
  actions: Record<string, HitDef>;
  labels: Record<string, LabelRange>;
  /** 动画帧（1 起，30Hz）→ 判定区 */
  areas: Record<number, AreaRect[]>;
  totalFrames: number;
  triggers: FrameTrigger[];
  loopTriggers: LoopTriggerDef[];
  /** 增益 buff（生效期 = 辅助在场期间；orihime 受击减免 / yachiru 物吸血） */
  buffEffects?: { attrResistance?: number; phyLifesteal?: number };
  /** fire 元件时间轴元数据（baked fires 包注入；缺元件 = 该 fire 无动画生命周期） */
  fires?: Record<string, FireTimelineDef>;
  /**
   * attacker 元件脚本（切片 21）：addAttacker 名 → 元件时间轴。
   * labels 1 基（'end' → 跳转落点帧）；triggers 帧号 1 起（与 animFrame 同基，
   * compileAssistant 已 +1），target ∈ {attacker, effect}。stepAttackerAnim
   * 逐帧分派（仅 viaAssist 道具）。语料：byakuya/gaara/itachi/madara/
   * rangiku/sai/shikamaru（stop/gotoAndPlay/stopFollowTarget/removeSelf/
   * shine/playSoundHit2/endAct；B5 起 madara justHit miss 分支走 cond 触发器：
   * justHit 查询 = 目标 lastHurtHitId 比对，attacker 语境复用近战语义）。
   */
  attackerScripts?: Record<
    string,
    { labels: Record<string, number>; triggers: FrameTrigger[] }
  >;
}

/**
 * 辅助 customFunc（切片 21，原版 Assister._customFunc 单槽函数的数据化）。
 * 原版 addCustomFunc 占位即忽略（单函数寄存器）；语料仅 byakuya 抓取链
 * 三函数 + temari 风场（B4），导出器识别为闭集 kind 描述符。
 */
export type AssisterCustomFunc =
  | { kind: 'ownerDeadClearAttacker'; attacker: string }
  | {
      kind: 'attackerEndOnTargetLeave';
      attacker: string;
      /** 目标 actionState 门（byakuya 21 = HURT_ING：被抓保持期） */
      state: number;
      /** 目标离开门态后 attacker 跳转的收尾标签（原版 gotoAndPlay("end")） */
      endLabel: string;
      /** 链下一环（语料恒 'finishWhenAttackerGone'） */
      next: 'finishWhenAttackerGone' | null;
    }
  | { kind: 'finishWhenAttackerGone'; attacker: string }
  | {
      /** 风场（B4，temari）：注册期采样目标 heavy/speed（LEVEL 表按数据层
       *  desc.levels 折算，见 assister.ts addCustomFunc）与自身朝向。 */
      kind: 'windField';
      /** 弹速级（LEVEL[min(heavy, len)-1]；0 = 无效降级，语料 heavy∈[1,5] 不可达） */
      level: number;
      /** 目标每动画帧拉扯位移（原版 targetSpeed × level，×SPEED_PLUS 消费） */
      finalSpeed: number;
      /** 注册时自身朝向（原版闭包捕获 selfDirect，注册后不随转向变化） */
      direct: 1 | -1;
    };

/**
 * 动作状态码（原版 FighterActionState，module-map §5.2）。
 * 切片 5 子集：+技能(11)/必杀(12/13)/瞬步(15)/防御(20)。
 * 切片 9：+受击动作(16 setHurtAction)/万解(50)；FREEZE(40)/换人系未接
 * （endAct 语义取 NORMAL 回位，偏离已记录）。
 */
export const ActionState = {
  /** 普通（站立/行走/落地恢复） */
  NORMAL: 0,
  ATTACK_ING: 10,
  SKILL_ING: 11,
  BISHA_ING: 12,
  BISHA_SUPER_ING: 13,
  JUMP_ING: 14,
  DASH_ING: 15,
  /** 受击动作中（setHurtAction；再受击播 hurtAction 而非受击态） */
  HURT_ACT_ING: 16,
  DEFENCE_ING: 20,
  HURT_ING: 21,
  HURT_FLYING: 22,
  HURT_DOWN: 23,
  /** 弹起中（原版 FighterActionState.HURT_DOWN_TAN=24：轻击飞落地弹起的
   *  二次起飞段，切片 54；重击不弹直接倒地） */
  HURT_DOWN_TAN: 24,
  DEAD: 30,
  /** 万解中（开场演出 + doWanKai 帧驱动；形态切换后续切片） */
  WAN_KAI_ING: 50,
  /** 开场语音动作中（原版 FighterMcCtrler.sayIntro actionState=60；
   *  开局特写演出的 say 步等待门，intro 切片） */
  INTRO_ING: 60,
  /** 胜利动作中（原版 FighterActionState.WIN_ING=61；团队回合结束演出期
   *  胜方 goFrame("胜利") + win()；仅 team 模式回合结束置位） */
  WIN_ING: 61,
} as const;

/** 循环播放的动作标签（其余标签播完即结束动作）。
 * 偏离修正记录：'防御' 曾在此集合（按住期间循环重播、观感抽搐）——原版
 * 防御不循环，goFrame("防御", true, 3) 抬手段播 3 帧后时间轴定格，由
 * advanceAnimation 的防御定格分支实现。 */
export const LOOP_LABELS: ReadonlySet<string> = new Set(['站立', '走', '跳中', '落']);

/** 原版 FighterActionState.isAttacking：能量回充/状态门用。 */
export function isAttackingState(v: number): boolean {
  return (
    v === ActionState.ATTACK_ING ||
    v === ActionState.SKILL_ING ||
    v === ActionState.BISHA_ING ||
    v === ActionState.BISHA_SUPER_ING
  );
}

/**
 * 动作槽（原版 FighterAction，module-map §5.3）：当前可触发动作 id → 动画标签。
 * 空槽 = 动作不可用。槽内容可被角色帧触发改写（setAttack("砍2") 即连段），
 * endAction 时按 def 标签存在性重填默认值（原版 setAllAct + checkFrame）。
 * 存的是「动画标签」，命中结算经 attackLabels 反查动作 id。
 */
export interface FighterSlots {
  attack: string | null;
  skill1: string | null;
  skill2: string | null;
  zhao1: string | null;
  zhao2: string | null;
  zhao3: string | null;
  /** 摔技槽（catch1=攻击键+朝目标移动；catch2=技能键+朝目标移动） */
  catch1: string | null;
  catch2: string | null;
  bisha: string | null;
  bishaQi: number;
  bishaUp: string | null;
  bishaUpQi: number;
  bishaSuper: string | null;
  bishaSuperQi: number;
  dash: string | null;
  /** 空中槽（原版 setAirAllAct：跳起时填充） */
  attackAIR: string | null;
  skillAIR: string | null;
  bishaAIR: string | null;
  bishaAIRQi: number;
  /** 跳跃标签覆盖（原版 setJump；null = 默认 起跳） */
  jump: string | null;
  /** 万解槽（原版 setWankai：标签存在才填） */
  wanKai: string | null;
  wanKaiW: string | null;
  wanKaiS: string | null;
}

/** 动作槽默认值（原版 FighterAction 字段缺省 + setAllAct 默认帧名）。 */
export function defaultSlots(def: FighterDef | null): FighterSlots {
  const has = (name: string): boolean => def?.labels[name] !== undefined;
  return {
    attack: has('砍1') ? '砍1' : null,
    skill1: has('砍技1') ? '砍技1' : null,
    skill2: has('砍技2') ? '砍技2' : null,
    zhao1: has('招1') ? '招1' : null,
    zhao2: has('招2') ? '招2' : null,
    zhao3: has('招3') ? '招3' : null,
    catch1: has('摔1') ? '摔1' : null,
    catch2: has('摔2') ? '摔2' : null,
    bisha: has('必杀') ? '必杀' : null,
    bishaQi: 100,
    bishaUp: has('上必杀') ? '上必杀' : null,
    bishaUpQi: 100,
    bishaSuper: has('超必杀') ? '超必杀' : null,
    bishaSuperQi: 300,
    dash: has('瞬步') ? '瞬步' : null,
    attackAIR: has('跳砍') ? '跳砍' : null,
    skillAIR: has('跳招') ? '跳招' : null,
    bishaAIR: has('空中必杀') ? '空中必杀' : null,
    bishaAIRQi: 100,
    // 原版 setAllAct 默认 jump='跳'（全体有此标签）；移植版跳跃动画沿用
    // 切片 3 的 起跳/跳中/落 映射，仅 setJump 显式覆盖时改用自定义标签（偏离记录）
    jump: null,
    wanKai: has('万解') ? '万解' : null,
    wanKaiW: has('万解W') ? '万解W' : null,
    wanKaiS: has('万解S') ? '万解S' : null,
  };
}

/** 槽全清（原版 FighterAction.clearAction；保留数值槽字段形状）。
 * 原版每次 doAction 发起动作都会先清槽——动作播放中再按攻击键不重启动作，
 * 连段只能经 setAttack 帧触发重填槽后派生；重填回默认在 endAction（setAllAct）。 */
export function emptySlots(s: FighterSlots): FighterSlots {
  return {
    attack: null,
    skill1: null,
    skill2: null,
    zhao1: null,
    zhao2: null,
    zhao3: null,
    catch1: null,
    catch2: null,
    bisha: null,
    bishaQi: s.bishaQi,
    bishaUp: null,
    bishaUpQi: s.bishaUpQi,
    bishaSuper: null,
    bishaSuperQi: s.bishaSuperQi,
    dash: null,
    attackAIR: null,
    skillAIR: null,
    bishaAIR: null,
    bishaAIRQi: s.bishaAIRQi,
    jump: null,
    wanKai: null,
    wanKaiW: null,
    wanKaiS: null,
  };
}

/** 标签 → 动作 id（attackLabels 反查；连段槽存标签，命中结算要动作 id）。 */
export function actionIdForLabel(def: FighterDef | null, label: string): string | null {
  if (!def) return null;
  for (const [id, l] of Object.entries(def.attackLabels)) {
    if (l === label) return id;
  }
  return null;
}

/** SPEED_PLUS：原版速度类反编译值换算系数（GameConfig.SPEED_PLUS=30/FPS_GAME=0.5）。 */
export const SPEED_PLUS = 0.5;

export const RISE_FRAMES_FALLBACK = 9;

/** 角色数据缺失时的物理兜底值（合成骨架角色）。 */
export const FALLBACK_SPEED = 4;
export const FALLBACK_JUMP_POWER = 15;

/** 取角色当前动画帧的判定区（无 def 或空帧 → 空数组）。 */
export function currentAreas(f: {
  animFrame: number;
  def?: FighterDef | null;
}): AreaRect[] {
  return f.def?.areas[f.animFrame] ?? [];
}

/** 当前受击体矩形（root 本地坐标）；无则 null。 */
export function currentBodyRect(f: {
  animFrame: number;
  def?: FighterDef | null;
}): AreaRect | null {
  return currentAreas(f).find((a) => a.name === 'bdmn') ?? null;
}

/** 世界矩形换算：root 本地坐标 + 脚底锚点 + 朝向镜像（角色不旋转，纯 AABB）。 */
export function worldRect(
  f: { x: number; y: number; facing: 1 | -1 },
  r: AreaRect,
): { x: number; y: number; w: number; h: number } {
  return {
    x: f.facing === 1 ? f.x + r.x : f.x - r.x - r.w,
    y: f.y + r.y,
    w: r.w,
    h: r.h,
  };
}

/** AABB 相交。 */
export function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return (
    a.x < b.x + b.w &&
    b.x < a.x + a.w &&
    a.y < b.y + b.h &&
    b.y < a.y + a.h
  );
}

/** 动作 id 的命中判定矩形名（dump 命名约定：`<actionId>atm`）。 */
export function atmName(actionId: string): string {
  return `${actionId}atm`;
}
