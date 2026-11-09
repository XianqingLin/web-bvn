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
import type { AreaRect, BehaviorArg, FighterDef, FighterSlots, HitDef } from './def.js';
import { SPEED_PLUS, defaultSlots } from './def.js';
import type { FighterState, StageState } from '../state.js';

/** fire 参数（原版 Bullet 构造 params 子集，语料实际出现的字段）。 */
export interface FireParams {
  x?: number | FireAxis;
  y?: number | FireAxis;
  /** 存在时长（秒；-1 = 永久） */
  hold?: number;
  /** 命中次数（-1 = 无限） */
  hits?: number;
  /** 道具对撞血量 */
  hp?: number;
}

export interface FireAxis {
  start?: number;
  add?: number;
  max?: number;
  min?: number;
}

/** fire 原语交给引擎的发射规格（引擎换算世界坐标并入 SimState）。 */
export interface BulletSpawnSpec {
  owner: FighterState;
  /** 命名子对象（判定区名 + HitVO 显示名，原版 fire(mcName)） */
  name: string;
  /** 发射帧判定区（root 本地坐标，direct=1） */
  local: AreaRect;
  /** 命中定义（发射动作 HitDef） */
  hit: HitDef;
  params: FireParams;
}

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
  /** fire 原语：发射飞行道具（引擎桥接，sim 装配） */
  spawnBullet(spec: BulletSpawnSpec): void;
}

/**
 * target：触发器来源控制器（mc=动作控制 / fighter=战斗逻辑 / effect=表现）。
 * 同名 op 在不同控制器语义不同（dash@mc=突进速度，dash@effect=尘土特效），
 * 处理器按 target 分流；未注册 op 一律忽略（确定性静默）。
 */
export type BehaviorHandler = (
  ctx: BehaviorContext,
  args: BehaviorArg[],
  target: string,
) => void;

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
  // dash(v)：target 分流——mc=突进（原版 setVelocity(speed×v×direct)，v 缺省 3），
  // effect=瞬步尘土特效（原版 EffectCtrler.dash）
  dash(ctx, args, target) {
    if (target === 'effect') {
      ctx.emit('effect', { id: 'dash', x: ctx.f.x, y: ctx.f.y, params: {} });
      return;
    }
    const speedPlus = num(args[0], 3);
    ctx.f.vx = (ctx.def?.speed ?? 0) * speedPlus * SPEED_PLUS * ctx.f.facing;
    ctx.f.vy = 0;
    ctx.f.dampX = 0;
    ctx.f.dampY = 0;
    ctx.f.isCross = true;
    ctx.f.isAllowBeHit = false;
  },
  // dashStop(p)：瞬步收势（原版 dashStop：damping=|vx|×p，回 NORMAL + clearAction）
  dashStop(ctx, args) {
    const p = num(args[0], 0.5);
    ctx.f.dampX = Math.abs(ctx.f.vx) * p;
    ctx.f.isAllowBeHit = true;
    ctx.f.actionState = 0; // NORMAL
    ctx.f.attackId = null;
    ctx.f.isCross = false;
    ctx.f.airMove = false;
    ctx.f.touchFloor = null;
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

  // —— 表现系补充（原版 FighterEffectCtrler，全部纯表现，core 只发事件） ——
  // shadow(r,g,b)：残影开始
  shadow(ctx, args) {
    ctx.emit('effect', {
      id: 'shadow',
      x: ctx.f.x,
      y: ctx.f.y,
      params: { r: num(args[0]), g: num(args[1]), b: num(args[2]) },
    });
  },
  endShadow(ctx) {
    ctx.emit('effect', { id: 'endShadow', x: ctx.f.x, y: ctx.f.y, params: {} });
  },
  // bisha(isSuper, face)：必杀特写（全屏演出）
  bisha(ctx, args) {
    ctx.emit('effect', {
      id: 'bisha',
      x: ctx.f.x,
      y: ctx.f.y,
      params: { isSuper: args[0] === true, face: typeof args[1] === 'string' ? args[1] : null },
    });
  },
  endBisha(ctx) {
    ctx.emit('effect', { id: 'endBisha', x: ctx.f.x, y: ctx.f.y, params: {} });
  },
  // slowDown(t)：全局慢放 t 秒（纯演出节奏，不进逻辑）
  slowDown(ctx, args) {
    ctx.emit('effect', {
      id: 'slowDown',
      x: ctx.f.x,
      y: ctx.f.y,
      params: { time: num(args[0]) },
    });
  },
  // walk()：脚步声（原版 se_step1~3 随机 → 事件 id 统一 step，render 层选音源）
  walk(ctx) {
    ctx.emit('sound', { id: 'step', x: ctx.f.x, y: ctx.f.y });
  },
  // jump()：起跳尘土（effect 控制器版）
  jump(ctx) {
    ctx.emit('effect', { id: 'jump', x: ctx.f.x, y: ctx.f.y, params: {} });
  },
  // touchFloor()：触地尘土（effect 控制器版；mc 版 setTouchFloor 见状态开关区）
  touchFloor(ctx) {
    ctx.emit('effect', { id: 'touchFloor', x: ctx.f.x, y: ctx.f.y, params: {} });
  },

  // —— 状态开关（原版 FighterMcCtrler/FighterMain） ——
  // setCross(v)：穿越版边/免推挤（原版 isCross）
  setCross(ctx, args) {
    ctx.f.isCross = args[0] !== false;
  },
  // isApplyG(v)：重力开关（原版 _fighter.isApplyG；飞行系角色空中置 false）
  isApplyG(ctx, args) {
    ctx.f.applyG = args[0] !== false;
  },
  // setAirMove(v)：空中可行走（原版 _action.airMove）
  setAirMove(ctx, args) {
    ctx.f.airMove = args[0] !== false;
  },
  // setTouchFloor(label, breakAct)：空中动作触地续接标签（标签不存在 = 原版 checkFrame 静默）
  setTouchFloor(ctx, args) {
    const label = typeof args[0] === 'string' ? args[0] : '落地';
    if (ctx.def?.labels[label] !== undefined) {
      ctx.f.touchFloor = label;
    }
  },

  // —— 回位（原版 FighterMcCtrler.idle：endAct + 清状态 + 归 NORMAL + 转帧） ——
  // idle(frame?)：帧触发让时间轴主动回位（常用于落地/受击恢复后的自定义帧）
  idle(ctx, args) {
    const frame = typeof args[0] === 'string' ? args[0] : '站立';
    ctx.f.steelBody = false;
    ctx.f.applyG = true;
    ctx.f.isCross = false;
    ctx.f.airMove = false;
    ctx.f.touchFloor = null;
    ctx.f.actionState = 0; // NORMAL
    if (ctx.def && !ctx.f.onGround) {
      // 原版：空中回位走 fall()（跳中），不转目标帧
      ctx.f.vx = 0;
      ctx.f.actionState = 14; // JUMP_ING
      setLabelTo(ctx, '跳中');
      return;
    }
    ctx.f.vx = 0;
    ctx.f.vy = 0;
    ctx.f.attackId = null;
    // 原版：frame=站立 → setAllAct 重填槽；其余帧 clearAction 清空（播完经 endAct 重填）
    ctx.f.slots = frame === '站立' ? defaultSlots(ctx.def) : emptySlots(ctx.f.slots);
    setLabelTo(ctx, frame);
  },

  // —— 飞行道具（原版 FighterMcCtrler.fire → Bullet，module-map §5.7） ——
  // fire(mcName, params)：mcName = 命名子对象（判定区来源 + HitVO 显示名，
  // 原版 getHitVOByDisplayName 去掉 atm 后缀查动作表）；判定区或动作缺失 = 确定性静默
  fire(ctx, args) {
    const name = typeof args[0] === 'string' ? args[0] : null;
    if (name === null || !ctx.def) return;
    const local = (ctx.def.areas[ctx.f.animFrame] ?? []).find((a) => a.name === name);
    const actionId = name.replace('atm', '');
    const hit = ctx.def.actions[actionId] ?? ctx.def.actions[name];
    if (!local || !hit) return;
    ctx.spawnBullet({
      owner: ctx.f,
      name,
      local,
      hit,
      params: parseFireParams(args[1]),
    });
  },
};

/** fire 参数解析（语料字段：x/y 的 number|{start,add,max,min}、hold、hits、hp）。 */
function parseFireParams(v: BehaviorArg | undefined): FireParams {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as FireParams) : {};
}

/** 带缺省静默的标签切换（与 machine.setLabel 同语义，此处避免循环依赖内联）。 */
function setLabelTo(ctx: BehaviorContext, name: string): void {
  const range = ctx.def?.labels[name];
  if (!range) return;
  if (ctx.f.actLabel !== name) {
    ctx.f.actLabel = name;
    ctx.f.animFrame = range.index + 1;
  }
}

/** 槽全清（原版 _action.clearAction；保留数值槽字段形状）。 */
function emptySlots(s: FighterSlots): FighterSlots {
  return {
    attack: null,
    skill1: null,
    skill2: null,
    zhao1: null,
    zhao2: null,
    zhao3: null,
    bisha: null,
    bishaQi: s.bishaQi,
    bishaUp: null,
    bishaUpQi: s.bishaUpQi,
    bishaSuper: null,
    bishaSuperQi: s.bishaSuperQi,
    dash: null,
  };
}

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
 * 行为注册表装配：defaultBehaviors + 需要引擎回调的桥接项
 * （endAct / fire 的 spawnBullet）。返回新对象，不污染默认表。
 */
export function createBehaviorRegistry(engine: {
  endAct(f: FighterState, def: FighterDef | null): void;
  spawnBullet(spec: BulletSpawnSpec): void;
}): Record<string, BehaviorHandler> {
  return {
    ...defaultBehaviors,
    // endAct：动作收招（原版 MC 时间轴通知 ctrler 动作结束）
    endAct(ctx) {
      engine.endAct(ctx.f, ctx.def);
    },
  };
}
