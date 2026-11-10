/**
 * 辅助实体行为（切片 12）。
 *
 * AssisterCtrler op 注册表（原版 AssisterCtrler，module-map §6.x）：与角色
 * behaviors 同一模式——数据驱动分派，未注册 op 确定性静默。上下文三分：
 * self（辅助实体）/ owner（召唤者）/ fighterTarget（owner 的当前目标，
 * 双人模型 = 对方角色）。
 *
 * 有界支持（偏离记录）：endAct 在辅助语境为 no-op（辅助无动作槽，时间轴
 * 自由播放）；justHit/setHitTarget/addAttacker/setTouchSide 静默
 * （corpus 实例全部位于 attacker 系 rawScript，切片 13 范围）。
 */
import {
  rectsOverlap,
  SPEED_PLUS,
  worldRect,
  type AreaRect,
  type AssisterDef,
  type BehaviorArg,
  type FighterDef,
  type HitDef,
  type LoopTriggerCond,
} from './def.js';
import { enterDead } from './machine.js';
import { BUFF_HOLD_TICKS, type AssisterState, type FighterState, type StageState } from '../state.js';
import type { FireParams } from './behaviors.js';

/** 辅助行为上下文（瞬态，不进 SimState）。 */
export interface AssisterContext {
  self: AssisterState;
  def: AssisterDef;
  /** 召唤者（死亡中/已死亡仍可达——退场判定由 sim 处理） */
  owner: FighterState | null;
  ownerDef: FighterDef | null;
  /** 全体角色（id 升序；fighterTarget = owner 以外的角色） */
  fighters: readonly FighterState[];
  stage: StageState;
  emit(type: string, payload: Record<string, unknown>): void;
  /** fire 原语：辅助发射飞行道具（引擎桥；viaAssist = 命中不回气） */
  spawnAssistBullet(spec: AssistBulletSpawnSpec): void;
  /** finish 原语：辅助退场 */
  remove(): void;
}

/** 辅助 fire 规格（判定区/朝向取自辅助实体；命中归属 owner）。 */
export interface AssistBulletSpawnSpec {
  self: AssisterState;
  ownerId: number;
  name: string;
  /** 判定区（辅助 root 本地坐标，direct=1） */
  local: AreaRect;
  hit: HitDef;
  params: FireParams;
}

export type AssisterHandler = (ctx: AssisterContext, args: BehaviorArg[], target: string) => void;

function num(v: BehaviorArg | undefined, fallback = 0): number {
  return typeof v === 'number' ? v : fallback;
}

const QI_MAX = 300;

/** 辅助语境实体选择：fighter=owner / fighterTarget=对方 / 其余=self。 */
function entityOf(ctx: AssisterContext, target: string): FighterState | null {
  if (target === 'fighter') return ctx.owner;
  if (target === 'fighterTarget') {
    const o = ctx.owner;
    return ctx.fighters.find((f) => f.id !== o?.id) ?? null;
  }
  return null;
}

/**
 * 默认辅助注册表。target 分流：op 落在哪个控制器（assister/fighter/
 * fighterTarget/effect）语义不同；未注册 op 静默。
 */
export const defaultAssisterBehaviors: Record<string, AssisterHandler> = {
  // —— self 移动（原版 AssisterCtrler.move 系；速度类 ×SPEED_PLUS） ——
  move(ctx, args) {
    ctx.self.vx = num(args[0]) * SPEED_PLUS * ctx.self.facing;
    ctx.self.vy = num(args[1]) * SPEED_PLUS;
  },
  moveOnce(ctx, args) {
    ctx.self.x += num(args[0]) * SPEED_PLUS * ctx.self.facing;
    ctx.self.y += num(args[1]) * SPEED_PLUS;
  },
  stop(ctx) {
    ctx.self.vx = 0;
    ctx.self.vy = 0;
  },
  stopMove(ctx) {
    ctx.self.vx = 0;
    ctx.self.vy = 0;
  },
  // setDamping(x,y)：线性阻尼（POC 取义 ×SPEED_PLUS，与位移折算一致）
  damping(ctx, args) {
    ctx.self.dampX = num(args[0]) * SPEED_PLUS;
    ctx.self.dampY = num(args[1]) * SPEED_PLUS;
  },
  // setApplyG(v)：重力开关
  setApplyG(ctx, args) {
    ctx.self.applyG = args[0] !== false;
  },
  // setTouchFloor(label)：触地续接标签（落地消费一次；标签缺失静默）
  setTouchFloor(ctx, args) {
    const label = typeof args[0] === 'string' ? args[0] : null;
    if (label !== null && ctx.def.labels[label] !== undefined) {
      ctx.self.touchFloor = label;
    }
  },
  // setDirectToTarget()：面向 owner 的目标
  setDirectToTarget(ctx) {
    const t = entityOf(ctx, 'fighterTarget');
    if (t !== null) ctx.self.facing = t.x >= ctx.self.x ? 1 : -1;
  },
  // moveToTarget(x, y, setDirect=true)：瞬移到目标旁（语义同 fighter 版）
  moveToTarget(ctx, args) {
    const t = entityOf(ctx, 'fighterTarget');
    if (t === null) return;
    const x = num(args[0]);
    const y = num(args[1]);
    if (args[0] !== null) {
      let fx = t.x + x * ctx.self.facing;
      if (x > 0) {
        if (t.x < x) fx = t.x + x;
        else if (t.x > ctx.stage.rightBound - x) fx = t.x - x;
      }
      ctx.self.x = fx;
    }
    if (args[1] !== null) ctx.self.y = t.y + y;
    if (args[2] !== false) ctx.self.facing = ctx.self.x < t.x ? 1 : -1;
  },

  // —— 时间轴（原版 gotoAndPlay/gotoAndStop/loop：纯跳转，标签缺失静默） ——
  gotoAndPlay(ctx, args) {
    jumpTo(ctx, args);
  },
  gotoAndStop(ctx, args) {
    jumpTo(ctx, args);
  },
  loop(ctx, args) {
    jumpTo(ctx, args);
  },

  // —— 退场（原版 AssisterCtrler.finish：演出 + removeSelf） ——
  finish(ctx) {
    ctx.remove();
  },

  // —— fire（原版 AssisterCtrler.fire → Bullet；辅助发射的弹不回气，
  //     原版 Bullet.as `owner is FighterMain` 守卫不成立——viaAssist 语义） ——
  fire(ctx, args, target) {
    if (target !== 'assister' || ctx.owner === null) return;
    const name = typeof args[0] === 'string' ? args[0] : null;
    if (name === null) return;
    const local = (ctx.def.areas[ctx.self.animFrame] ?? []).find((a) => a.name === name);
    const actionId = name.replace('atm', '');
    const hit = ctx.def.actions[actionId] ?? ctx.def.actions[name];
    if (!local || !hit) return;
    ctx.spawnAssistBullet({
      self: ctx.self,
      ownerId: ctx.owner.id,
      name,
      local,
      hit,
      params: parseFireParams(args[1]),
    });
  },

  // —— owner 系（target='fighter'；血量/气/buff） ——
  addHp(ctx, args, target) {
    const f = entityOf(ctx, target);
    if (f === null || f.hp <= 0) return;
    f.hp = Math.min(f.hpMax, f.hp + num(args[0]));
  },
  addQi(ctx, args, target) {
    const f = entityOf(ctx, target);
    if (f === null) return;
    f.qi = Math.min(QI_MAX, f.qi + num(args[0]));
  },
  loseHp(ctx, args, target) {
    const f = entityOf(ctx, target);
    if (f === null || f.hp <= 0) return;
    f.hp = Math.max(0, f.hp - num(args[0]));
    if (f.hp <= 0) {
      enterDead(f, ctx.owner !== null && f.id === ctx.owner.id ? ctx.ownerDef : null);
      ctx.emit('fighter:ko', { fighter: f.id });
    }
  },
  addHpLosePercent(ctx, args, target) {
    const f = entityOf(ctx, target);
    if (f === null || f.hp <= 0) return;
    f.hp = Math.min(f.hpMax, f.hp + (f.hpMax - f.hp) * num(args[0]));
  },
  // buff 三连（原版 FighterBuffCtrler speedUp/attackUp/defenseUp；hold 秒 × 60 tick，
  // 重复施加刷新剩余时长）
  buffSpeedUp(ctx, args, target) {
    applyBuff(ctx, target, 'speedUp', num(args[0]), num(args[1]));
  },
  buffAttackUp(ctx, args, target) {
    applyBuff(ctx, target, 'attackUp', num(args[0]), num(args[1]));
  },
  buffDefenseUp(ctx, args, target) {
    applyBuff(ctx, target, 'defenseUp', num(args[0]), num(args[1]));
  },

  // —— 动作控制 no-op（辅助无动作槽/无状态机；时间轴自由播放。偏离记录：
  //     原版 AssisterCtrler.endAct 的动作收招语义在辅助语境无可观测效果） ——
  endAct() {},

  // —— 有界静默（corpus 实例全在 attacker 系 rawScript，切片 13 范围） ——
  // justHit（纯读）/ setHitTarget（byakuya attacker 续接）/ addAttacker /
  // setTouchSide（版边吸附，corpus 无实例）

  // —— 表现系（原版 AssisterCtrler.effect 转发 EffectCtrler；core 只发事件，
  //     事件 id 与角色 behaviors 同表，坐标取辅助实体位置） ——
  playSoundHit1(ctx) {
    ctx.emit('sound', { id: 'hit1', x: ctx.self.x, y: ctx.self.y });
  },
  playSoundHit2(ctx) {
    ctx.emit('sound', { id: 'hit2', x: ctx.self.x, y: ctx.self.y });
  },
  walk(ctx) {
    ctx.emit('sound', { id: 'step', x: ctx.self.x, y: ctx.self.y });
  },
  shine(ctx, args) {
    ctx.emit('effect', { id: 'shine', x: ctx.self.x, y: ctx.self.y, params: { arg: args[0] } });
  },
  shadow(ctx, args) {
    ctx.emit('effect', {
      id: 'shadow',
      x: ctx.self.x,
      y: ctx.self.y,
      params: { r: num(args[0]), g: num(args[1]), b: num(args[2]) },
    });
  },
  endShadow(ctx) {
    ctx.emit('effect', { id: 'endShadow', x: ctx.self.x, y: ctx.self.y, params: {} });
  },
  bisha(ctx, args) {
    ctx.emit('effect', {
      id: 'bisha',
      x: ctx.self.x,
      y: ctx.self.y,
      params: { isSuper: args[0] === true, face: typeof args[1] === 'string' ? args[1] : null },
    });
  },
  endBisha(ctx) {
    ctx.emit('effect', { id: 'endBisha', x: ctx.self.x, y: ctx.self.y, params: {} });
  },
  startShake(ctx, args) {
    ctx.emit('effect', { id: 'shake', x: ctx.self.x, y: ctx.self.y, params: { arg: args[0] } });
  },
  shake(ctx, args) {
    ctx.emit('effect', { id: 'shake', x: ctx.self.x, y: ctx.self.y, params: { arg: args[0] } });
  },
  endShake(ctx) {
    ctx.emit('effect', { id: 'endShake', x: ctx.self.x, y: ctx.self.y, params: {} });
  },
  slowDown(ctx, args) {
    ctx.emit('effect', { id: 'slowDown', x: ctx.self.x, y: ctx.self.y, params: { time: num(args[0]) } });
  },
  dash(ctx, args, target) {
    if (target === 'effect') {
      ctx.emit('effect', { id: 'dash', x: ctx.self.x, y: ctx.self.y, params: {} });
    }
  },
  jump(ctx) {
    ctx.emit('effect', { id: 'jump', x: ctx.self.x, y: ctx.self.y, params: {} });
  },
  touchFloor(ctx) {
    ctx.emit('effect', { id: 'touchFloor', x: ctx.self.x, y: ctx.self.y, params: {} });
  },
};

function jumpTo(ctx: AssisterContext, args: BehaviorArg[]): void {
  const label = typeof args[0] === 'string' ? args[0] : null;
  const range = label !== null ? ctx.def.labels[label] : undefined;
  if (label === null || !range) return;
  if (ctx.self.actLabel !== label) {
    ctx.self.actLabel = label;
    ctx.self.animFrame = range.index + 1;
  }
}

function applyBuff(
  ctx: AssisterContext,
  target: string,
  kind: 'speedUp' | 'attackUp' | 'defenseUp',
  value: number,
  hold: number,
): void {
  const f = entityOf(ctx, target);
  if (f === null) return;
  f.buffs[kind] = { value, holdTicks: Math.max(1, Math.round(hold * BUFF_HOLD_TICKS)) };
}

function parseFireParams(v: BehaviorArg | undefined): FireParams {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as FireParams) : {};
}

// —— 循环触发求值（切片 12；纯读、确定性） ——

/** 循环触发条件求值（cond null = 每帧执行；未知 kind = false）。 */
export function evaluateLoopCond(
  cond: LoopTriggerCond | null,
  ctx: AssisterContext,
): boolean {
  if (cond === null) return true;
  if (cond.kind === 'checkHitOwner') {
    const owner = ctx.owner;
    const area = (ctx.def.areas[ctx.self.animFrame] ?? []).find(
      (a) => a.name === cond.name,
    );
    const body =
      owner !== null && ctx.ownerDef !== null
        ? (ctx.ownerDef.areas[owner.animFrame] ?? []).find((a) => a.name === 'bdmn') ?? null
        : null;
    if (!area || owner === null || body === null) return false;
    return rectsOverlap(worldRect(ctx.self, area), worldRect(owner, body));
  }
  if (cond.kind === 'actionStateIn') {
    const v = ctx.owner?.actionState;
    return v !== undefined && cond.values.includes(v);
  }
  return false;
}

// —— buff 结算辅助（applyHit 伤害乘区消费） ——

/** 攻击伤害乘区（原版 attackRate：1 + attackUp 加值）。 */
export function attackRateOf(f: FighterState): number {
  return 1 + (f.buffs.attackUp?.value ?? 0);
}

/** 防御伤害乘区（原版 loseHp：dr = clamp(2 − defenseRate, 0.1, 1)）。 */
export function defenseDamageScale(f: FighterState): number {
  const dr = 2 - (f.buffs.defenseUp?.value ?? 0);
  return Math.min(1, Math.max(0.1, dr));
}

/** buff 每 tick 计时（原版 FighterBuffVO render 递减；计满移除）。 */
export function tickBuffs(f: FighterState): void {
  for (const key of ['speedUp', 'attackUp', 'defenseUp'] as const) {
    const b = f.buffs[key];
    if (b !== null && --b.holdTicks <= 0) f.buffs[key] = null;
  }
}

/** 命中类型分类：物理（砍打系）= {1,6,2,3}；属性 = {7,8,9,10}（原版 HitType）。 */
export function isPhysicalHit(hitType: number): boolean {
  return hitType === 1 || hitType === 6 || hitType === 2 || hitType === 3;
}
export function isAttributeHit(hitType: number): boolean {
  return hitType >= 7 && hitType <= 10;
}
