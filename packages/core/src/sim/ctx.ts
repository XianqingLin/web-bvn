import type {
  CutinLockState,
  FighterState,
  SimState,
  StageState,
} from '../state.js';
import type {
  AssisterDef,
  FighterDef,
  FrameTrigger,
} from '../fighter/def.js';
import type {
  AttackerSpawnSpec,
  BehaviorHandler,
  BulletSpawnSpec,
} from '../fighter/behaviors.js';
import type {
  AssistAttackerSpawnSpec,
  AssisterHandler,
  AssistBulletSpawnSpec,
} from '../fighter/assister.js';

/**
 * sim 子模块共享上下文（sim.ts 拆分的桥接层，2026-11-17 结构重构）。
 *
 * Sim 类仍是唯一状态所有者（SimState / 定义注册表 / 事件队列 / views），
 * 以只读视图 + 桥接闭包暴露给各子系统模块（physics/flow/bullets/attackers/
 * assisters/hit/anim）。子系统函数均为接收 ctx 的纯函数（与 fighter/behaviors
 * 同形态）；跨子系统调用经 ctx 桥接（如 stepPhysics → stepBullets），模块间
 * 不互相 import（例外：flow → physics 纯函数常量、hit → flow 的
 * maybeBeginRoundEnd、hit → bullets 的 killBullet——均无环）。
 * 本层不引入任何随机/时钟/DOM（契约硬规则），不改变 tick 管线顺序。
 */
export interface SimCtx {
  /** 全部模拟状态（唯一可变根；Sim 不重assign该引用，模块只改其字段） */
  readonly state: SimState;
  /** 训练模式（SimConfig.training）：假人不 KO、血量恒定回复 */
  readonly training: boolean;
  /** behaviors 处理器注册表（契约硬规则 7） */
  readonly behaviors: Record<string, BehaviorHandler>;
  /** 辅助 behaviors 处理器注册表（切片 12） */
  readonly assisterBehaviors: Record<string, AssisterHandler>;
  /** 辅助定义注册表（assistId → def，静态配置不进 SimState） */
  readonly assisterDefs: Map<string, AssisterDef>;
  /** 辅助 def.triggers 按帧号预索引：assistId → 帧 → 触发列表 */
  readonly assisterTriggerIndex: Map<string, Map<number, FrameTrigger[]>>;
  /** def.triggers 按帧号预索引：fighter id → formIndex → 帧 → 触发列表 */
  readonly triggerIndex: Map<number, Map<number, Map<number, FrameTrigger[]>>>;
  emit(type: string, payload: Record<string, unknown>): void;
  /** 当前生效形态定义（FighterState.formIndex 寻址；越界回退首形态） */
  defOf(f: FighterState): FighterDef | null;
  /** 按 id + 形态下标取 def（rotateIn 用；FighterState 尚未构造） */
  defById(id: number, formIndex: number): FighterDef | null;
  /** 召唤者当前目标的 def（辅助语境 fighterTarget；owner 空/无目标 = null） */
  ownerTargetDefOf(owner: FighterState | null): FighterDef | null;
  /** doWanKai/switchForm 桥：形态切换 + fighter:form 表现事件 */
  doSwitchForm(f: FighterState, frame: number): void;
  /** 特写冻结锁置位/清除（behaviors 桥；bisha/wanKai 置锁，end 系清除） */
  setCutin(
    ownerKind: 'fighter' | 'assister',
    id: number,
    kind: 'bisha' | 'wanKai' | null,
  ): void;
  /** slowDown 全局慢放置位（behaviors/assister 桥；t = 时长秒，rate 固定 1.5） */
  setSlowDown(t: number): void;
  /** 释放抓取（behaviors 引擎桥；physics.stepMoveTargets 同函数） */
  releaseGrab(f: FighterState): void;
  /** 发射飞行道具（behaviors.fire 引擎桥） */
  spawnBullet(spec: BulletSpawnSpec): void;
  /** 辅助 fire 桥（切片 12） */
  spawnAssistBullet(spec: AssistBulletSpawnSpec): void;
  /** 生成独立道具（behaviors.addAttacker 引擎桥） */
  spawnAttacker(spec: AttackerSpawnSpec): void;
  /** 辅助生成独立道具（assister.addAttacker 引擎桥） */
  spawnAssistAttacker(spec: AssistAttackerSpawnSpec): void;
  /** 召唤辅助（stepIntents 辅助键） */
  spawnAssister(owner: FighterState): void;
  /** 移除独立道具（辅助 removeAttacker 桥） */
  removeAttackers(ids: number[]): void;
  /** 辅助 30Hz 推进（anim.stepAnimation 尾部追加） */
  stepAssisterAnimation(cutinLock?: CutinLockState): void;
  /** 飞行道具每 tick 推进（physics.stepPhysics 内追加） */
  stepBullets(): void;
  /** 独立道具每 tick 推进（physics.stepPhysics 内追加） */
  stepAttackers(): void;
  /** 辅助每 tick 物理（physics.stepPhysics 内追加） */
  stepAssisterPhysics(): void;
  /** 垂直落地判定（flow.stepPassivePhysics 复用 physics 纯函数） */
  resolveLanding(f: FighterState, stage: StageState): boolean;
}

/** def.triggers → 帧 → 触发列表（保持注册顺序；角色/辅助定义通用）。 */
export function indexTriggers(
  def: { triggers: FrameTrigger[] },
): Map<number, FrameTrigger[]> {
  const map = new Map<number, FrameTrigger[]>();
  for (const t of def.triggers) {
    const list = map.get(t.frame);
    if (list) list.push(t);
    else map.set(t.frame, [t]);
  }
  return map;
}

/**
 * 速度线性衰减（原版 KyoUtils.num_wake：正负双向逼近 0）。
 */
export function wake(v: number, k: number): number {
  if (k <= 0 || v === 0) return v;
  if (v > 0) {
    v -= k;
    return v < 0 ? 0 : v;
  }
  v += k;
  return v > 0 ? 0 : v;
}

/**
 * slowDown 全局慢放折算 scale（切片 49；sim.ts setSlowDown 置位，undefined =
 * 常速 1）。消费侧位移/重力 ×scale（原版 speedPlus = SPEED_PLUS_DEFAULT/rate）；
 * 阻尼衰减不缩（KO 链折算范式同款——见 flow.stepPassivePhysics 注）。
 */
export function slowDownScaleOf(state: SimState): number {
  return state.slowDown?.scale ?? 1;
}

/** 时间轴步进间隔（常态 2 = 30Hz；slowDown 期 animEvery = 3，20Hz）。 */
export function slowDownAnimEveryOf(state: SimState): number {
  return state.slowDown?.animEvery ?? 2;
}

/** 向目标点步进一步（吸附速度换算后值；speed≤0 直接吸附）。 */
export function stepToward(v: number, target: number, speed: number): number {
  if (speed <= 0 || v === target) return target;
  const d = target - v;
  return d > 0 ? v + Math.min(d, speed) : v + Math.max(d, -speed);
}

/** 原版 HitVO.isBisha：动作 id 含 bs/sbs/cbs/kbs（子串 bs 覆盖全部）。 */
export function isBishaAction(actionId: string): boolean {
  return actionId.includes('bs');
}

/** 元件局部矩形 → 世界矩形（原版 RectUtils.cached：原点锚定 + direct 镜像）。 */
export function attackerLocalRect(
  a: { x: number; y: number; facing: 1 | -1 },
  r: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  return {
    x: a.x + (a.facing === 1 ? r.x : -r.x - r.w),
    y: a.y + r.y,
    w: r.w,
    h: r.h,
  };
}

/**
 * 命中区名 → 动作 id（原版 FighterHitModel.getHitVOByDisplayName：
 * 精确 id 先查；名字含 "atm" 再查去首个 atm 的结果；都查不到 = null）。
 */
export function resolveAttackerActionId(
  name: string,
  actions: Record<string, unknown>,
): string | null {
  if (actions[name] !== undefined) return name;
  if (name.includes('atm')) {
    const stripped = name.replace('atm', '');
    if (actions[stripped] !== undefined) return stripped;
  }
  return null;
}
