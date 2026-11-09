/**
 * behaviors 插件目录（契约硬规则 7 / ADR-6）。
 *
 * 角色 JSON 的帧触发（FrameTrigger）在本注册表按 op 分派；数据化不了的
 * 角色机制在此实现为确定性处理器，**不进通用引擎分支**。
 *
 * POC 子集说明：op 语义以原版 FighterMcCtrler/FighterMC 为准，当前按
 * 最小闭环取语义（标注「POC 取义」处为近似，接入原版逐条核对后收紧）；
 * 未注册 op 一律忽略（确定性静默）。
 * 词表扩充 = 契约 §帧触发表 + 本注册表 + data 校验器三处同 commit。
 */
import type { BehaviorArg, FighterDef, FighterSlots } from './def.js';
import { SPEED_PLUS } from './def.js';
import type { FighterState, StageState } from '../state.js';

/** 行为处理器上下文（瞬态，不进 SimState）。 */
export interface BehaviorContext {
  f: FighterState;
  /** 该角色的运行时定义（注册表查得，与 FighterState 分离） */
  def: FighterDef | null;
  /** 全体角色（id 升序；只读用途） */
  fighters: readonly FighterState[];
  stage: StageState;
  /** 发表现现事件（sound/effect 等，契约 §表现事件表） */
  emit(type: string, payload: Record<string, unknown>): void;
}

export type BehaviorHandler = (ctx: BehaviorContext, args: BehaviorArg[]) => void;

const QI_MAX = 300;

function num(v: BehaviorArg | undefined, fallback = 0): number {
  return typeof v === 'number' ? v : fallback;
}

/**
 * 默认注册表。语义来源标注于注释。
 */
export const defaultBehaviors: Record<string, BehaviorHandler> = {
  // —— 自身移动（原版 FighterMC/FighterMcCtrler move 系，速度类 ×SPEED_PLUS） ——
  // move(x,y)：置位移速度（含朝向），POC 取义为触发时瞬时设定
  move(ctx, args) {
    ctx.f.vx = num(args[0]) * SPEED_PLUS * ctx.f.facing;
    ctx.f.vy = num(args[1]) * SPEED_PLUS;
  },
  // movePercent(px,py)：按自身移速比例的推动（招式位移常用）
  movePercent(ctx, args) {
    const speed = (ctx.def?.speed ?? 0) * SPEED_PLUS;
    ctx.f.vx = speed * num(args[0]) * ctx.f.facing;
    ctx.f.vy = speed * num(args[1]);
  },
  // moveOnce(dx,dy)：瞬移式位移（瞬步/突进类，POC 取义为一次位移）
  moveOnce(ctx, args) {
    ctx.f.x += num(args[0]) * SPEED_PLUS * ctx.f.facing;
    ctx.f.y += num(args[1]) * SPEED_PLUS;
  },
  // dash(v)：突进速度
  dash(ctx, args) {
    ctx.f.vx = num(args[0]) * SPEED_PLUS * ctx.f.facing;
  },
  // stop / stopMove：清空位移速度
  stop(ctx) {
    ctx.f.vx = 0;
    ctx.f.vy = 0;
  },
  stopMove(ctx) {
    ctx.f.vx = 0;
    ctx.f.vy = 0;
  },
  // damping(x,y)：速度衰减（POC 取义：速度 ×(1-k)；原版 num_wake 为线性逼近）
  damping(ctx, args) {
    ctx.f.vx *= 1 - num(args[0]);
    ctx.f.vy *= 1 - num(args[1]);
  },
  dampingPercent(ctx, args) {
    ctx.f.vx *= 1 - num(args[0]);
    ctx.f.vy *= 1 - num(args[1]);
  },

  // —— 状态标记 ——
  // setSteelBody(v)：钢身开关（受击结算消费：掉血但无受击状态变化）
  setSteelBody(ctx, args) {
    ctx.f.steelBody = args[0] !== false;
  },

  // —— 资源 ——
  // addQi(n)：气回复（原版 qi 上限 300）
  addQi(ctx, args) {
    ctx.f.qi = Math.min(QI_MAX, ctx.f.qi + num(args[0]));
  },

  // —— 动作槽（原版 FighterAction 槽改写；连段 = 时间轴第 N 帧 setAttack("砍2")） ——
  // setAttack(label?)：改写攻击槽（可选参数 = 指定标签，缺省恢复默认）
  setAttack(ctx, args) {
    setSlot(ctx, 'attack', args[0]);
  },
  setSkill1(ctx, args) {
    setSlot(ctx, 'skill1', args[0]);
  },
  setSkill2(ctx, args) {
    setSlot(ctx, 'skill2', args[0]);
  },
  setZhao1(ctx, args) {
    setSlot(ctx, 'zhao1', args[0]);
  },
  setZhao2(ctx, args) {
    setSlot(ctx, 'zhao2', args[0]);
  },
  setZhao3(ctx, args) {
    setSlot(ctx, 'zhao3', args[0]);
  },
  // setBisha(label?, qi?)：必杀槽 + 可选气耗覆盖
  setBisha(ctx, args) {
    setSlot(ctx, 'bisha', args[0]);
    if (typeof args[1] === 'number') ctx.f.slots.bishaQi = args[1];
  },
  setBishaUP(ctx, args) {
    setSlot(ctx, 'bishaUp', args[0]);
    if (typeof args[1] === 'number') ctx.f.slots.bishaUpQi = args[1];
  },
  setBishaSUPER(ctx, args) {
    setSlot(ctx, 'bishaSuper', args[0]);
    if (typeof args[1] === 'number') ctx.f.slots.bishaSuperQi = args[1];
  },
  // setDash(label?)：瞬步标签覆盖
  setDash(ctx, args) {
    setSlot(ctx, 'dash', args[0]);
  },

  // —— 表现原语（core 只发事件，render 消费；音效 id 沿用原版语义命名） ——
  playSoundHit1(ctx) {
    ctx.emit('sound', { id: 'hit1', x: ctx.f.x, y: ctx.f.y });
  },
  playSoundHit2(ctx) {
    ctx.emit('sound', { id: 'hit2', x: ctx.f.x, y: ctx.f.y });
  },
  shine(ctx, args) {
    ctx.emit('effect', { id: 'shine', x: ctx.f.x, y: ctx.f.y, params: firstArg(args) });
  },
  startShake(ctx, args) {
    ctx.emit('effect', { id: 'shake', x: ctx.f.x, y: ctx.f.y, params: firstArg(args) });
  },
  shake(ctx, args) {
    ctx.emit('effect', { id: 'shake', x: ctx.f.x, y: ctx.f.y, params: firstArg(args) });
  },
  endShake(ctx) {
    ctx.emit('effect', { id: 'endShake', x: ctx.f.x, y: ctx.f.y, params: {} });
  },
};

function firstArg(args: BehaviorArg[]): Record<string, unknown> {
  return args.length > 0 ? { arg: args[0] } : {};
}

/** 存动画标签的动作槽键（bishaQi 等数值槽除外）。 */
type LabelSlotKey = {
  [K in keyof FighterSlots]: FighterSlots[K] extends string | null ? K : never;
}[keyof FighterSlots];

/** 动作槽改写（args[0] 缺省 = 清空；只接受该角色存在的标签）。 */
function setSlot(
  ctx: BehaviorContext,
  key: LabelSlotKey,
  value: BehaviorArg | undefined,
): void {
  const label = typeof value === 'string' ? value : null;
  if (label !== null && ctx.def?.labels[label] !== undefined) {
    ctx.f.slots[key] = label;
  } else {
    ctx.f.slots[key] = null;
  }
}

/**
 * 行为注册表装配：defaultBehaviors + 需要状态机回调的引擎桥接项
 * （endAct 等）。返回新对象，不污染默认表。
 */
export function createBehaviorRegistry(engine: {
  endAct(f: FighterState, def: FighterDef | null): void;
}): Record<string, BehaviorHandler> {
  return {
    ...defaultBehaviors,
    // endAct：动作收招（原版 MC 时间轴通知 ctrler 动作结束）
    endAct(ctx) {
      engine.endAct(ctx.f, ctx.def);
    },
  };
}
