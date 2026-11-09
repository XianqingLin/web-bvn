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

/** 帧触发（帧号 1 起，与 areas 的 frame 对齐）。 */
export interface FrameTrigger {
  frame: number;
  /** mc=自身动作控制 / fighter=战斗逻辑 / effect=表现 / assister=辅助逻辑 */
  target: string;
  op: string;
  args: BehaviorArg[];
}

/** 角色运行时定义（一个形态的完整战斗数据）。 */
export interface FighterDef {
  id: string;
  formIndex: number;
  /** 形态数值（原版原始值；core 使用时按 ×SPEED_PLUS 换算） */
  speed: number;
  jumpPower: number;
  heavy: number;
  actions: Record<string, HitDef>;
  labels: Record<string, LabelRange>;
  /** 动画帧（1 起，30Hz）→ 判定区 */
  areas: Record<number, AreaRect[]>;
  totalFrames: number;
  triggers: FrameTrigger[];
  /** 已验证存在的攻击动作 id → 动画标签（缺失 = 动作不可用） */
  attackLabels: Record<string, string>;
}

/**
 * 动作状态码（原版 FighterActionState，module-map §5.2）。
 * POC 子集：普通/攻击/跳跃/受击/击飞/倒地/死亡。
 * 防御(20)、瞬步(15)、必杀(12/13)、万解(50) 等后续切片接入。
 */
export const ActionState = {
  /** 普通（站立/行走/落地恢复） */
  NORMAL: 0,
  ATTACK_ING: 10,
  JUMP_ING: 14,
  HURT_ING: 21,
  HURT_FLYING: 22,
  HURT_DOWN: 23,
  DEAD: 30,
} as const;

/** 循环播放的动作标签（其余标签播完即结束动作）。 */
export const LOOP_LABELS: ReadonlySet<string> = new Set(['站立', '走', '跳中', '落']);

/** SPEED_PLUS：原版速度类反编译值换算系数（GameConfig.SPEED_PLUS=30/FPS_GAME=0.5）。 */
export const SPEED_PLUS = 0.5;

/** HURT_DOWN 两段恢复的兜底帧数（标签缺失时用）。 */
export const DOWN_FRAMES_FALLBACK = 12;
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
