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
import type { AreaRect, BehaviorArg, FighterDef, FighterSlots, HitDef, TriggerCondition } from './def.js';
import { ActionState, SPEED_PLUS, defaultSlots } from './def.js';
import { enterDead, switchForm, HURT_DAMP_Y } from './machine.js';
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
  /** 元件时间轴元数据（baked fires 包；缺失 = 无动画生命周期，仅 hold/出界驱动） */
  anim?: { totalFrames: number; labels: Record<string, number> };
}

/** addAttacker 参数（原版 FighterAttacker 构造 params 语料字段）。 */
export interface AttackerAxisParams {
  moveToTarget?: boolean;
  followTarget?: boolean;
  offset?: number;
  range?: [number, number];
}

export interface AttackerParams {
  x?: number | AttackerAxisParams;
  y?: number | AttackerAxisParams;
  applyG?: boolean;
}

/** addAttacker 原语交给引擎的生成规格（引擎换算世界坐标并入 SimState）。 */
export interface AttackerSpawnSpec {
  owner: FighterState;
  /** 命名子对象（原版 addAttacker(mcName)） */
  name: string;
  /** 生成帧判定区（root 本地坐标，direct=1；位置/尺寸来源） */
  local: AreaRect;
  /** 命中定义（发射动作 HitDef；无动作表 = null 纯表现实体） */
  hit: HitDef | null;
  /** 命中动作 id（气回充/必杀判定用） */
  hitId: string | null;
  params: AttackerParams;
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
  /** addAttacker 原语：生成独立道具（引擎桥接，sim 装配） */
  spawnAttacker(spec: AttackerSpawnSpec): void;
  /** doWanKai/switchForm 桥：多形态注册表由 sim 持有（切失败 = 静默） */
  switchForm(f: FighterState, frame: number): void;
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
      ...(ctx.def.fires?.[name] ? { anim: ctx.def.fires[name] } : {}),
    });
  },

  // —— 标签跳转（原版 FighterMC gotoAndPlay/gotoAndStop/loop：纯时间轴跳转，
  // 不清状态不清速度；gotoAndStop 与 loop 语料语义等价，取同语义（偏离记录）） ——
  gotoAndPlay(ctx, args) {
    const label = typeof args[0] === 'string' ? args[0] : null;
    if (label !== null) setLabelTo(ctx, label);
  },
  gotoAndStop(ctx, args) {
    const label = typeof args[0] === 'string' ? args[0] : null;
    if (label !== null) setLabelTo(ctx, label);
  },
  loop(ctx, args) {
    const label = typeof args[0] === 'string' ? args[0] : null;
    if (label !== null) setLabelTo(ctx, label);
  },

  // —— 动作槽补充（原版 FighterAction setJump/setAirAllAct/setWankai 系） ——
  setJump(ctx, args) {
    setSlot(ctx, 'jump', args[0]);
  },
  setAttackAIR(ctx, args) {
    setSlot(ctx, 'attackAIR', args[0]);
  },
  setSkillAIR(ctx, args) {
    setSlot(ctx, 'skillAIR', args[0]);
  },
  setBishaAIR(ctx, args) {
    setSlot(ctx, 'bishaAIR', args[0]);
    if (typeof args[1] === 'number') ctx.f.slots.bishaAIRQi = args[1];
  },
  setCatch1(ctx, args) {
    setSlot(ctx, 'catch1', args[0]);
  },
  setCatch2(ctx, args) {
    setSlot(ctx, 'catch2', args[0]);
  },
  setWankai(ctx, args) {
    setSlot(ctx, 'wanKai', args[0]);
  },
  setWankaiW(ctx, args) {
    setSlot(ctx, 'wanKaiW', args[0]);
  },
  setWankaiS(ctx, args) {
    setSlot(ctx, 'wanKaiS', args[0]);
  },
  // setAllAct()：槽全重填（原版 FighterAction.setAllAct）
  setAllAct(ctx) {
    if (ctx.def) ctx.f.slots = defaultSlots(ctx.def);
  },

  // —— 目标系（原版 FighterMcCtrler moveTarget/moveToTarget/justHit 系；
  // target = 另一角色（双人模型）） ——
  // setHurtAction(label)：自定义受击动作（原版 FighterMC._hurtAction）。
  // 触发位置在攻击方动作时间轴（投技/连段携带受击方专用受击动画），语义 =
  // 「本次动作期间的命中：受击方播该标签而非进通用受击态」。标签属于受击方
  // def，存在性在 applyHit 消费时按受击方校验；动作结束（endAct）清除。
  setHurtAction(ctx, args) {
    const label = typeof args[0] === 'string' ? args[0] : null;
    // 只存标签：HURT_ACT_ING 是受击方在 applyHit 消费时才进的态，
    // 携带者自身不改动作状态（此前误设导致携带者卡在受击态无法行动）
    if (label !== null) {
      ctx.f.hurtAction = label;
    }
  },
  // setHitTarget(checker, action)：命中续接（每动画帧检查 checker 判定区
  // 与目标身体相交 → 切 action 标签并清除；sim.stepAnimation 消费）
  setHitTarget(ctx, args) {
    const checker = typeof args[0] === 'string' ? args[0] : null;
    const action = typeof args[1] === 'string' ? args[1] : null;
    if (checker !== null && action !== null) {
      ctx.f.hitTargetChecker = checker;
      ctx.f.hitTarget = action;
    }
  },
  // moveToTarget(x, y, setDirect=true)：瞬移到目标旁（原版 moveToTarget：
  // 目标贴左/右版边时反向镜像防穿帮；setDirect=false 不转身）
  moveToTarget(ctx, args) {
    const t = targetOf(ctx);
    if (t === null) return;
    const x = num(args[0]);
    const y = num(args[1]);
    if (args[0] !== null) {
      let fx = t.x + x * ctx.f.facing;
      if (x > 0) {
        if (t.x < x) fx = t.x + x;
        else if (t.x > ctx.stage.rightBound - x) fx = t.x - x;
      }
      ctx.f.x = fx;
    }
    if (args[1] !== null) ctx.f.y = t.y + y;
    if (args[2] !== false) ctx.f.facing = ctx.f.x < t.x ? 1 : -1;
  },
  // moveTarget({followmc, speed}) / moveTarget(null)：抓取吸附/释放。
  // speed 缺省 = 0（直接吸附）；释放时恢复目标重力，击飞中目标 y 回拉
  // （原版 moveTarget 释放分支）
  moveTarget(ctx, args) {
    const v = args[0];
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      releaseMoveTarget(ctx);
      return;
    }
    const p = v as { followmc?: BehaviorArg; speed?: BehaviorArg };
    let sx = 0;
    let sy = 0;
    if (typeof p.speed === 'number') {
      sx = p.speed * SPEED_PLUS;
      sy = p.speed * SPEED_PLUS;
    } else if (typeof p.speed === 'object' && p.speed !== null && !Array.isArray(p.speed)) {
      const sp = p.speed as { x?: BehaviorArg; y?: BehaviorArg };
      sx = num(sp.x) * SPEED_PLUS;
      sy = num(sp.y) * SPEED_PLUS;
    }
    ctx.f.moveTarget = {
      followmc: typeof p.followmc === 'string' ? p.followmc : null,
      speedX: sx,
      speedY: sy,
    };
  },
  // justHitToPlay(hitid, frame, noIdle=false, includeDefense=false)：目标最近
  // 被动作 hitid 命中（includeDefense 时含被防御）→ 跳 frame 续接；
  // 否则 noIdle 静默，回站立（原版 justHitToPlay 分支）
  justHitToPlay(ctx, args) {
    const hitid = typeof args[0] === 'string' ? args[0] : null;
    const frame = typeof args[1] === 'string' ? args[1] : null;
    if (hitid === null || frame === null) return;
    const t = targetOf(ctx);
    const matched =
      t !== null &&
      (t.lastHurtHitId === hitid || (args[3] === true && t.lastDefHitId === hitid));
    if (matched) {
      setLabelTo(ctx, frame);
    } else if (args[2] !== true) {
      defaultBehaviors.idle?.(ctx, ['站立'], 'mc');
    }
  },
  // setDirectToTarget()：转向目标；setDirectReverse()：转身
  setDirectToTarget(ctx) {
    const t = targetOf(ctx);
    if (t !== null) ctx.f.facing = ctx.f.x > t.x ? -1 : 1;
  },
  setDirectReverse(ctx) {
    ctx.f.facing = ctx.f.facing === 1 ? -1 : 1;
  },
  // setTargetVelocity(x,y)：目标置位移速度（沿自身朝向；×SPEED_PLUS）
  setTargetVelocity(ctx, args) {
    const t = targetOf(ctx);
    if (t === null) return;
    t.vx = num(args[0]) * SPEED_PLUS * ctx.f.facing;
    t.vy = num(args[1]) * SPEED_PLUS;
  },
  // hurtFly(x,y)：主动击飞（原版 playHurtFly(x*direct,y)：进入受击飞行态，
  // 位移沿自身朝向，x<0 = 后撤；标签缺失静默）
  hurtFly(ctx, args) {
    ctx.f.actionState = ActionState.HURT_FLYING;
    ctx.f.hurtTimer = 0;
    ctx.f.vx = num(args[0]) * SPEED_PLUS * ctx.f.facing;
    ctx.f.vy = num(args[1]) * SPEED_PLUS;
    ctx.f.dampX = 0;
    ctx.f.dampY = HURT_DAMP_Y;
    setLabelTo(ctx, '击飞');
  },

  // —— 血量系（原版 BaseGameSprite addHp/loseHp；hp≤0 死亡结算） ——
  addHp(ctx, args) {
    addHpRaw(ctx, num(args[0]));
  },
  addHpPercent(ctx, args) {
    addHpRaw(ctx, ctx.f.hpMax * num(args[0]));
  },
  addHpLosePercent(ctx, args) {
    addHpRaw(ctx, (ctx.f.hpMax - ctx.f.hp) * num(args[0]));
  },
  loseHp(ctx, args) {
    if (ctx.f.hp <= 0) return;
    ctx.f.hp = Math.max(0, ctx.f.hp - num(args[0]));
    if (ctx.f.hp <= 0) {
      enterDead(ctx.f, ctx.def);
      ctx.emit('fighter:ko', { fighter: ctx.f.id });
    }
  },

  // —— 万解（原版 EffectCtrler wanKai 演出 + FighterCtrler doWanKai 帧驱动） ——
  // startWanKai(face)：万解开场演出事件（effect 控制器消费；语料参数为特写
  // face 名，如 "Naruto_3"——非形态 id，render 层消费）
  startWanKai(ctx, args) {
    ctx.emit('effect', {
      id: 'wanKai',
      x: ctx.f.x,
      y: ctx.f.y,
      params: { face: typeof args[0] === 'string' ? args[0] : null },
    });
  },
  // endWanKai()：万解演出结束
  endWanKai(ctx) {
    ctx.emit('effect', { id: 'endWanKai', x: ctx.f.x, y: ctx.f.y, params: {} });
  },
  // doWanKai(frame)：万解形态切换（原版 FighterCtrler.doWanKai 真实语义：
  // frame=0/缺省 → 根时间轴 nextFrame = 下一形态；frame>0 → 绝对帧寻址形态）。
  // 切换后保持 WAN_KAI_ING 播新形态 开场，播完回 NORMAL（sim 桥接实现）
  doWanKai(ctx, args) {
    ctx.switchForm(ctx.f, num(args[0]));
  },
  // switchForm(frame)：形态切换通用原语（词表 Tier-2；语义同 doWanKai）。
  switchForm(ctx, args) {
    ctx.switchForm(ctx.f, num(args[0]));
  },

  // —— 独立道具（原版 FighterMcCtrler.addAttacker → FighterAttacker，
  // module-map §5.7；命名反查同 fire：去 atm 后缀查动作表；
  // 无动作表 = 纯表现实体。偏离：attacker 内层时间轴未导出，
  // 命中矩形/寿命为占位，切片 10 收紧） ——
  addAttacker(ctx, args) {
    const name = typeof args[0] === 'string' ? args[0] : null;
    if (name === null || !ctx.def) return;
    const local = (ctx.def.areas[ctx.f.animFrame] ?? []).find((a) => a.name === name);
    if (!local) return;
    // 原版命中判定来自道具自身内层时间轴（未导出）；用 owner actions 表兜底：
    // 依名字形态猜 actionId（'zh3mc'→'zh3'、'k1atm'→'k1'），都查不到 = 纯视觉道具
    const actionId = name.replace('atm', '').replace(/mc$/, '');
    const hit =
      ctx.def.actions[actionId] ??
      ctx.def.actions[name] ??
      ctx.def.actions[name.replace('atm', '')] ??
      ctx.def.actions[name.replace(/mc$/, '')] ??
      null;
    ctx.spawnAttacker({
      owner: ctx.f,
      name,
      local,
      hit,
      hitId: hit !== null ? actionId : null,
      params: parseAttackerParams(args[1]),
    });
  },
};

/** fire 参数解析（语料字段：x/y 的 number|{start,add,max,min}、hold、hits、hp）。 */
function parseFireParams(v: BehaviorArg | undefined): FireParams {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as FireParams) : {};
}

/** addAttacker 参数解析（语料字段：x/y 的 number|轴对象、applyG）。 */
function parseAttackerParams(v: BehaviorArg | undefined): AttackerParams {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as AttackerParams) : {};
}

/** 目标：另一角色（双人模型； fighters 按 id 升序）。 */
function targetOf(ctx: BehaviorContext): FighterState | null {
  for (const o of ctx.fighters) {
    if (o.id !== ctx.f.id) return o;
  }
  return null;
}

/** 回血（hp≤0 不回复；clamp 到 hpMax，原版 BaseGameSprite.addHp）。 */
function addHpRaw(ctx: BehaviorContext, v: number): void {
  if (ctx.f.hp <= 0) return;
  ctx.f.hp = Math.min(ctx.f.hpMax, ctx.f.hp + v);
}

/** 释放抓取吸附（原版 moveTarget(null)：恢复目标重力，击飞中 y 回拉）。 */
function releaseMoveTarget(ctx: BehaviorContext): void {
  if (ctx.f.moveTarget === null) return;
  const t = targetOf(ctx);
  if (t !== null) {
    t.applyG = true;
    if (t.actionState === ActionState.HURT_FLYING) t.y -= 5;
  }
  ctx.f.moveTarget = null;
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

// —— 条件查询求值（切片 11：if/else 帧触发；语义 = 原版 FighterCtrler 查询方法） ——

/** getSelf()/getTargetSP() 的属性链读取白名单（未知属性 = null，真值判定为假）。 */
function fighterProp(f: FighterState, def: FighterDef | null, prop: string | undefined): number | boolean | null {
  switch (prop) {
    case 'isInAir':
      return !f.onGround;
    case 'onGround':
      return f.onGround;
    case 'actionState':
      return f.actionState;
    case 'hp':
      return f.hp;
    case 'hpMax':
      return f.hpMax;
    case 'qi':
      return f.qi;
    case 'energy':
      return f.energy;
    case 'x':
      return f.x;
    case 'y':
      return f.y;
    case 'speed':
      return def?.speed ?? null;
    case 'jumpPower':
      return def?.jumpPower ?? null;
    case 'heavy':
      return def?.heavy ?? null;
    default:
      return null;
  }
}

const CONDITION_QUERIES: Record<
  string,
  (cond: TriggerCondition, ctx: BehaviorContext) => number | boolean | null
> = {
  // justHit(hitId, includeDefense?)：目标最近被动作 hitId 命中（含防御命中可选）
  justHit: (cond, ctx) => {
    const hitid = typeof cond.args[0] === 'string' ? cond.args[0] : null;
    const t = targetOf(ctx);
    if (hitid === null || t === null) return false;
    return t.lastHurtHitId === hitid || (cond.args[1] === true && t.lastDefHitId === hitid);
  },
  // targetInRange([minX,maxX], [minY,maxY]?)：前向距离窗（x 沿自身朝向，y = 目标-自身）
  targetInRange: (cond, ctx) => {
    const t = targetOf(ctx);
    if (t === null) return false;
    const xDis = ctx.f.facing > 0 ? t.x - ctx.f.x : ctx.f.x - t.x;
    const yDis = t.y - ctx.f.y;
    const rx = Array.isArray(cond.args[0]) ? cond.args[0] : null;
    const ry = Array.isArray(cond.args[1]) ? cond.args[1] : null;
    const inR = (d: number, r: BehaviorArg[] | null): boolean =>
      r === null ? true : num(r[0]) <= d && d <= num(r[1]);
    return inR(xDis, rx) && inR(yDis, ry);
  },
  // getTargetState()：目标 actionState（常与 cmp 比较）
  getTargetState: (_cond, ctx) => targetOf(ctx)?.actionState ?? 0,
  // getSelf().prop / getTargetSP().prop：属性链读取
  getSelf: (cond, ctx) => fighterProp(ctx.f, ctx.def, cond.path?.[0]),
  getTargetSP: (cond, ctx) => {
    const t = targetOf(ctx);
    return t !== null ? fighterProp(t, ctx.def, cond.path?.[0]) : null;
  },
};

/** 数值/布尔比较（cmp 缺省 = AS 真值判定）。 */
function applyCompare(v: number | boolean | null, cond: TriggerCondition): boolean {
  if (cond.cmp) {
    const n = typeof v === 'boolean' ? (v ? 1 : 0) : v === null ? Number.NaN : v;
    const w = typeof cond.cmp.value === 'boolean' ? (cond.cmp.value ? 1 : 0) : cond.cmp.value;
    switch (cond.cmp.op) {
      case '==':
        return n === w;
      case '!=':
        return n !== w;
      case '<':
        return n < w;
      case '>':
        return n > w;
      case '<=':
        return n <= w;
      case '>=':
        return n >= w;
    }
  }
  // AS 真值：0/NaN/null/false 为假
  return v !== null && v !== false && !(typeof v === 'number' && v === 0);
}

/** 条件触发求值（纯读、确定性；未知查询 op = false）。 */
export function evaluateTriggerCondition(cond: TriggerCondition, ctx: BehaviorContext): boolean {
  const query = CONDITION_QUERIES[cond.op];
  let v: number | boolean | null = false;
  if (query) v = query(cond, ctx);
  let result = applyCompare(v, cond);
  if (cond.negate) result = !result;
  return result;
}

/**
 * 行为注册表装配：defaultBehaviors + 需要引擎回调的桥接项
 * （endAct / fire 的 spawnBullet / doWanKai 的 switchForm）。
 * 返回新对象，不污染默认表。
 */
export function createBehaviorRegistry(engine: {
  endAct(f: FighterState, def: FighterDef | null): void;
  spawnBullet(spec: BulletSpawnSpec): void;
  spawnAttacker(spec: AttackerSpawnSpec): void;
  switchForm(f: FighterState, frame: number): void;
}): Record<string, BehaviorHandler> {
  return {
    ...defaultBehaviors,
    // endAct：动作收招（原版 MC 时间轴通知 ctrler 动作结束）
    endAct(ctx) {
      engine.endAct(ctx.f, ctx.def);
    },
  };
}
