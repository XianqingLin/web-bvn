/**
 * 辅助实体行为（切片 12）。
 *
 * AssisterCtrler op 注册表（原版 AssisterCtrler，module-map §6.x）：与角色
 * behaviors 同一模式——数据驱动分派，未注册 op 确定性静默。上下文三分：
 * self（辅助实体）/ owner（召唤者）/ fighterTarget（owner 的当前目标，
 * 双人模型 = 对方角色）。
 *
 * 有界支持（偏离记录）：endAct 在辅助语境为 no-op（辅助无动作槽，时间轴
 * 自由播放）；justHit（纯读）/setTouchSide（版边吸附，语料无实例）静默。
 * setHitTarget（切片 13-A6）：命中续接检查在 stepAssisterAnimation 每动画
 * 帧执行（原版 renderCheckTargetHit 语义）。
 */
import {
  ActionState,
  rectsOverlap,
  SPEED_PLUS,
  worldRect,
  type AreaRect,
  type AssisterCustomFunc,
  type AssisterDef,
  type BehaviorArg,
  type FighterDef,
  type HitDef,
  type LoopTriggerCond,
} from './def.js';
import { enterDead } from './machine.js';
import {
  BUFF_HOLD_TICKS,
  type AssisterState,
  type AttackerState,
  type FighterState,
  type StageState,
} from '../state.js';
import {
  parseAttackerParams,
  resolveAttackerSpawn,
  type AttackerParams,
  type FireParams,
} from './behaviors.js';

/** 辅助行为上下文（瞬态，不进 SimState）。 */
export interface AssisterContext {
  self: AssisterState;
  def: AssisterDef;
  /** 召唤者（死亡中/已死亡仍可达——退场判定由 sim 处理） */
  owner: FighterState | null;
  ownerDef: FighterDef | null;
  /** 召唤者当前目标的 def（heavy/speed 等 def 数值采样；owner 空时 null） */
  ownerTargetDef: FighterDef | null;
  /** 全体角色（id 升序；fighterTarget = owner 以外的角色） */
  fighters: readonly FighterState[];
  stage: StageState;
  emit(type: string, payload: Record<string, unknown>): void;
  /** fire 原语：辅助发射飞行道具（引擎桥；viaAssist = 命中不回气） */
  spawnAssistBullet(spec: AssistBulletSpawnSpec): void;
  /** addAttacker 原语：辅助生成独立道具（引擎桥；owner=辅助实体，回气归召唤者） */
  spawnAssistAttacker(spec: AssistAttackerSpawnSpec): void;
  /** finish 原语：辅助退场 */
  remove(): void;
  /** 特写冻结锁桥（切片 22）：kind = 置锁类型，null = 解锁（owner = ctx.self 实体） */
  setCutin(kind: 'bisha' | 'wanKai' | null): void;
  /** slowDown 全局慢放桥（切片 49）：t = 时长秒（rate 固定 1.5，sim 折算置位） */
  setSlowDown(t: number): void;
  // —— attacker 桥（切片 21：customFunc 操作本辅助挂载的道具；
  //    范围 = viaAssist 且 ownerId === owner.id（每 fighter 至多一辅助 → 无歧义），
  //    name 匹配元件名） ——
  getAttacker(name: string): AttackerState | null;
  /** gotoAndPlay：跳标签落点帧（animLabels 寻址，缺失静默）+ 解除定格 */
  gotoAndPlayAttacker(name: string, label: string): void;
  /** stopFollowTarget：解除吸附 */
  stopFollowAttacker(name: string): void;
  /** removeSelf：立即移除 */
  removeAttacker(name: string): void;
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
  /** 元件时间轴元数据（baked fires 包；缺失 = 无动画生命周期） */
  anim?: { totalFrames: number; labels: Record<string, number> };
}

/** 辅助 addAttacker 规格（位置锚 = 辅助实体；回气归属 ownerId=召唤者）。 */
export interface AssistAttackerSpawnSpec {
  self: AssisterState;
  ownerId: number;
  name: string;
  /** 判定区（辅助 root 本地坐标，direct=1；尺寸/回退矩形来源） */
  local: AreaRect;
  /** 回退命中矩形（元件局部 direct=1；fires 缺逐帧数据时全程固定消费） */
  fbHit: { x: number; y: number; w: number; h: number };
  hit: HitDef | null;
  hitId: string | null;
  /** 元件时间轴元数据（baked fires 包；缺失 = holdTicks 占位寿命） */
  anim?: { totalFrames: number; labels: Record<string, number> };
  params: AttackerParams;
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
      ...(ctx.def.fires?.[name] ? { anim: ctx.def.fires[name] } : {}),
    });
  },

  // —— addAttacker（原版 AssisterCtrler.addAttacker → FighterAttacker，
  //     owner = 辅助实体：位置锚/朝向取辅助；命中回气经 getOwnerFighter
  //     回溯归召唤者 power×0.15——非 viaAssist 守卫，与辅助弹不同）。
  //     判定区：原版经 getChildByName（含运行时挂载的元件，如 byakuya
  //     atmc），authoring 判定区缺失时回退零矩形。B5：fires[name].org/hits
  //     存在 → 原点锚定 + 命中检查逐帧解析（抓取伤害 atm1 power=50 即
  //     内层逐帧 hitVO）；缺数据回退走 resolveAttackerSpawn 占位语义 ——
  addAttacker(ctx, args, target) {
    if (target !== 'assister' || ctx.owner === null) return;
    const name = typeof args[0] === 'string' ? args[0] : null;
    if (name === null) return;
    const local =
      (ctx.def.areas[ctx.self.animFrame] ?? []).find((a) => a.name === name) ?? {
        name,
        x: 0,
        y: 0,
        w: 0,
        h: 0,
      };
    const spawn = resolveAttackerSpawn(ctx.def.fires, ctx.def.actions, name, local);
    ctx.spawnAssistAttacker({
      self: ctx.self,
      ownerId: ctx.owner.id,
      name,
      local,
      ...spawn,
      ...(ctx.def.fires?.[name] ? { anim: ctx.def.fires[name] } : {}),
      params: parseAttackerParams(args[1]),
    });
  },

  // —— setHitPowerByTargetHpMax（itachi 动态伤害，B5）：生成帧脚本
  //     hitModel.getHitVO(id).power = getTargetSP().hpMax × rate 的数据化。
  //     原版直接改写 hitVO 实例（作用域 = 本辅助实例的 hitModel），port 把
  //     覆写存辅助实例状态，其生成的 attacker 命中解析时消费 ——
  setHitPowerByTargetHpMax(ctx, args, target) {
    if (target !== 'assister' || ctx.owner === null) return;
    const id = typeof args[0] === 'string' ? args[0] : null;
    const rate = typeof args[1] === 'number' ? args[1] : null;
    if (id === null || rate === null) return;
    const t = ctx.fighters.find((f) => f.id !== ctx.owner!.id) ?? null;
    if (t === null) return;
    ctx.self.hitPowerOverrides[id] = t.hpMax * rate;
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
  // buffSpeedUpByOwnerSpeed（B4 temari 风场）：原版
  // `var ownerSpeed = getOwner().speed; getBuffCtrl().speedUp(ownerSpeed × rate, hold)`
  // 的数据化——值 = 召唤者 def 基速 × rate（存原值，消费时 ×SPEED_PLUS）。
  // 偏离记录：原版读的 .speed 属性可能含既有 speed buff 加值（激活帧采样），
  // 语料窗口不可区分，port 取 def 基速。
  buffSpeedUpByOwnerSpeed(ctx, args, target) {
    const ownerDef = ctx.ownerDef;
    if (ownerDef === null) return;
    applyBuff(ctx, target, 'speedUp', ownerDef.speed * num(args[0]), num(args[1]));
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

  // —— setHitTarget（原版 AssisterCtrler.setHitTarget：注册续接检查，
  //     检查本体在 stepAssisterAnimation 每动画帧执行） ——
  setHitTarget(ctx, args) {
    const checker = typeof args[0] === 'string' ? args[0] : null;
    const action = typeof args[1] === 'string' ? args[1] : null;
    if (checker !== null && action !== null) {
      ctx.self.hitTargetChecker = checker;
      ctx.self.hitTargetAction = action;
    }
  },

  // —— customFunc 单槽（切片 21，原版 AssisterCtrler.addCustomFunc/
  //     removeCustomFunc：单函数寄存器，占用即忽略） ——
  addCustomFunc(ctx, args) {
    if (ctx.self.customFunc !== null) return;
    const desc = parseCustomFuncDesc(ctx, args[0]);
    if (desc !== null) ctx.self.customFunc = desc;
  },
  removeCustomFunc(ctx) {
    ctx.self.customFunc = null;
  },

  // —— finishIfNoAttacker（切片 21）：`if (!judge) finish()` 守卫惯用语的
  //     语义化改写——judge 系布尔仅在挂载 attacker 的路径置位，守卫 ≡
  //     「该辅助未挂载 attacker 才 finish」；抓取路径辅助靠 loop 循环保活 ——
  finishIfNoAttacker(ctx, args) {
    const name = typeof args[0] === 'string' ? args[0] : null;
    if (name === null || ctx.getAttacker(name) === null) ctx.remove();
  },

  // —— 有界静默（corpus 实例全在 attacker 系 rawScript，切片 13 审计范围） ——
  // justHit（纯读）/ setTouchSide（版边吸附，corpus 无实例）

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
      params: {
        r: num(args[0]),
        g: num(args[1]),
        b: num(args[2]),
        owner: ctx.self.id,
        ownerKind: 'assister',
      },
    });
  },
  endShadow(ctx) {
    ctx.emit('effect', {
      id: 'endShadow',
      x: ctx.self.x,
      y: ctx.self.y,
      params: { owner: ctx.self.id, ownerKind: 'assister' },
    });
  },
  bisha(ctx, args) {
    ctx.emit('effect', {
      id: 'bisha',
      x: ctx.self.x,
      y: ctx.self.y,
      params: {
        isSuper: args[0] === true,
        face: typeof args[1] === 'string' ? args[1] : null,
        owner: ctx.self.id,
        ownerKind: 'assister',
      },
    });
    ctx.setCutin('bisha');
  },
  endBisha(ctx) {
    ctx.emit('effect', { id: 'endBisha', x: ctx.self.x, y: ctx.self.y, params: {} });
    ctx.setCutin(null);
  },
  // startShake：持续震屏（切片 52，语义同 behaviors.startShake；原版辅助语料
  // 无实例，op 表保留与主战一致的转发）。
  startShake(ctx, args) {
    ctx.emit('effect', {
      id: 'startShake',
      x: ctx.self.x,
      y: ctx.self.y,
      params: { owner: ctx.self.id, ownerKind: 'assister', x: num(args[0]), y: num(args[1], 3) },
    });
  },
  shake(ctx, args) {
    ctx.emit('effect', { id: 'shake', x: ctx.self.x, y: ctx.self.y, params: { arg: args[0] } });
  },
  endShake(ctx) {
    ctx.emit('effect', { id: 'endShake', x: ctx.self.x, y: ctx.self.y, params: {} });
  },
  slowDown(ctx, args) {
    // slowDown(t)：全局慢放 t 秒（切片 49，语义同 behaviors.slowDown——进 sim 折算）
    const t = num(args[0]);
    if (t > 0) ctx.setSlowDown(t);
  },
  dash(ctx, args, target) {
    if (target === 'effect') {
      // 原版 FighterEffectCtrler.dash :98-105：isInAir 分流 dash_air/dash
      ctx.emit('effect', {
        id: ctx.self.onGround ? 'dash' : 'dash_air',
        x: ctx.self.x,
        y: ctx.self.y,
        params: { direct: ctx.self.facing },
      });
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
  // 无同标签守卫：原版 gotoAndPlay 忠实 rewind（byakuya 抓取路径 loop 标签
  // 循环回跳保活——actLabel 同段时照跳）
  ctx.self.actLabel = label;
  ctx.self.animFrame = range.index + 1;
}

/**
 * customFunc 描述符窄化（导出器闭集 kind；未知/畸形 = null → 触发器静默）。
 * windField 在注册帧采样目标数值（B4）：LEVEL 折算 index = int(min(heavy, len))−1
 * （原版 `int(targetHeavy>5 ? 5:targetHeavy)-1`，len 即数据层表长）；heavy<1
 * 语料不可达（corpus heavy∈[1,5]），防御性降级 level=0。
 */
function parseCustomFuncDesc(ctx: AssisterContext, v: BehaviorArg | undefined): AssisterCustomFunc | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const kind = (v as { kind?: unknown }).kind;
  if (kind === 'windField') {
    const levels = (v as { levels?: unknown }).levels;
    if (
      !Array.isArray(levels) ||
      levels.length === 0 ||
      !levels.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      return null;
    }
    const owner = ctx.owner;
    const tDef = ctx.ownerTargetDef;
    if (owner === null || tDef === null) return null;
    const idx = Math.trunc(Math.min(tDef.heavy, levels.length)) - 1;
    const level = idx >= 0 ? ((levels[idx] as number) ?? 0) : 0;
    return {
      kind,
      level,
      finalSpeed: tDef.speed * level,
      direct: ctx.self.facing,
    };
  }
  const attacker = (v as { attacker?: unknown }).attacker;
  if (typeof attacker !== 'string') return null;
  if (kind === 'ownerDeadClearAttacker' || kind === 'finishWhenAttackerGone') {
    return { kind, attacker };
  }
  if (kind === 'attackerEndOnTargetLeave') {
    const state = (v as { state?: unknown }).state;
    const endLabel = (v as { endLabel?: unknown }).endLabel;
    const next = (v as { next?: unknown }).next;
    if (typeof state !== 'number' || typeof endLabel !== 'string') return null;
    if (next !== 'finishWhenAttackerGone' && next !== null) return null;
    return { kind, attacker, state, endLabel, next };
  }
  return null;
}

/**
 * customFunc 步进（切片 21，原版 Assister.renderAnimate：mc.nextFrame 后
 * 回调 _customFunc）。byakuya 抓取链三函数为语料的忠实转写（rawScript 原文）：
 *  - checkFunc → ownerDeadClearAttacker：`getOwner().isAlive || !attackerCtrler`
 *    卫语句 → stopFollowTarget + removeSelf + removeCustomFunc；
 *  - checkFunc1 → attackerEndOnTargetLeave：targetState == state 即返回；
 *    `if (attackerCtrler) gotoAndPlay(end)`（gotoAndPlay 受守卫，注销/注册不受）；
 *  - checkFunc2 → finishWhenAttackerGone：attacker 存在即返回；否则注销 + finish。
 * 原版 refreshAttackerCtrler 每次调用重取引用 → port 每步实时 getAttacker。
 */
export function stepAssisterCustomFunc(ctx: AssisterContext): void {
  const cf = ctx.self.customFunc;
  if (cf === null) return;
  if (cf.kind === 'windField') {
    // 风场拉扯（B4 temari，原版 fuutonFunc 的 targetSP.x += finalSpeed × selfDirect）：
    // 目标倒地（HURT_DOWN=23，原版 getTargetState()==23 卫语句）不拉扯；每动画帧
    // 位移 = finalSpeed × 注册朝向 × SPEED_PLUS（30Hz 帧率换算，与 moveOnce 同标定）。
    // 弹速级部分（setTargetBulletSpeedLevel）不在此步进——为派生值，stepBullets
    // 步进弹体时按在场风场辅助实时求值（不逐弹存储，避免新增状态字段）。
    const owner = ctx.owner;
    if (owner === null) return;
    const t = ctx.fighters.find((f) => f.id !== owner.id) ?? null;
    if (t === null || t.actionState === ActionState.HURT_DOWN) return;
    t.x += cf.finalSpeed * cf.direct * SPEED_PLUS;
    return;
  }
  if (cf.kind === 'ownerDeadClearAttacker') {
    const owner = ctx.owner;
    if (owner !== null && owner.hp > 0) return;
    if (ctx.getAttacker(cf.attacker) === null) return;
    ctx.stopFollowAttacker(cf.attacker);
    ctx.removeAttacker(cf.attacker);
    ctx.self.customFunc = null;
    return;
  }
  if (cf.kind === 'attackerEndOnTargetLeave') {
    const owner = ctx.owner;
    if (owner === null) return;
    const t = ctx.fighters.find((f) => f.id !== owner.id) ?? null;
    if (t !== null && t.actionState === cf.state) return;
    if (ctx.getAttacker(cf.attacker) !== null) {
      ctx.gotoAndPlayAttacker(cf.attacker, cf.endLabel);
    }
    ctx.self.customFunc =
      cf.next !== null ? { kind: cf.next, attacker: cf.attacker } : null;
    return;
  }
  // finishWhenAttackerGone
  if (ctx.getAttacker(cf.attacker) !== null) return;
  ctx.self.customFunc = null;
  ctx.remove();
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
  // buff 视觉（切片 51，原版 FighterBuffCtrler speedUp/attackUp/defenseUp →
  // doEffectById("buff_effect_*") + doBuffEffect("buff_*")）：施加点 = 角色脚下
  //（direct=1 原版缺省朝向）。重复施加原版每次都发（含刷新）——port 照发
  //（渲染层光环单实例去重，一次性火花照播 = 刷新脉冲，偏离登记见渲染层）。
  ctx.emit('effect', {
    id: 'buffUp',
    x: f.x,
    y: f.y,
    params: {
      fighter: f.id,
      kind: kind === 'speedUp' ? 'speed' : kind === 'attackUp' ? 'power' : 'defense',
    },
  });
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
