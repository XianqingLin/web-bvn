import type {
  AttackerState,
  FighterState,
} from '../state.js';
import type {
  AreaRect,
  FrameTrigger,
  HitDef,
  TriggerCondition,
} from '../fighter/def.js';
import type {
  AttackerParams,
  AttackerSpawnSpec,
} from '../fighter/behaviors.js';
import type { AssistAttackerSpawnSpec } from '../fighter/assister.js';
import type { SimCtx } from './ctx.js';
import { slowDownScaleOf } from './ctx.js';
import { GRAVITY_CAP, GRAVITY_START, GRAVITY_STEP } from './physics.js';

/** 独立道具寿命占位（素材缺口：内层时间轴未导出，切片 10 收紧） */
/** 无元件时间轴（animTotal=0）时 attacker 的占位寿命回退（原版无此机制）。 */
const ATTACKER_LIFE_TICKS = 120;

/**
 * 独立道具内层时间轴推进（原版 FighterAttacker.renderAnimate，切片 21 收紧）：
 * 逐动画帧 nextFrame + 元件触发器分派（def.attackerScripts，target
 * attacker=道具控制 / effect=表现），stop → animHold 完全冻结（不推进/
 * 不分派/不播尽移除，gotoAndPlay 解除），removeSelf → 移除，
 * currentFrame == totalFrames-1 → removeSelf（off-by-one 原样保留）。
 * 跳转（外部 gotoAndPlay 或元件脚本）用 frameJumped 标志传递：下一动画步
 * 分派落点帧触发器且不推进（同帧 rewind 值比较不可辨）。
 * 已知边界：元件第 1 帧触发器不执行（生成 tick 直接推进到 2）——语料
 * attacker 元件脚本最早帧 3，无实例；endAct 为 no-op（isAttacking 标志
 * 唯一读者是 AI，port 无观察者）。
 */
export function stepAttackerAnim(ctx: SimCtx): void {
  const removed: number[] = [];
  for (const a of ctx.state.attackers) {
    if (a.animTotal <= 0) continue;
    if (a.animHold) continue;
    const jumped = a.frameJumped; // 外部跳转落点帧：本步分派不推进
    a.frameJumped = false;
    if (!jumped && a.animFrame < a.animTotal) a.animFrame += 1;
    const scripts =
      a.scriptAssistId !== null
        ? ctx.assisterDefs.get(a.scriptAssistId)?.attackerScripts?.[a.name]
        : undefined;
    if (scripts) {
      let removedSelf = false;
      for (const t of scripts.triggers) {
        if (t.frame !== a.animFrame) continue;
        if (dispatchAttackerScript(ctx, a, t)) {
          removedSelf = true;
          break;
        }
      }
      if (removedSelf) {
        removed.push(a.id);
        continue;
      }
    }
    if (a.animHold) continue; // 本步 stop()：定格
    if (!jumped && a.animFrame === a.animTotal - 1) removed.push(a.id);
  }
  if (removed.length > 0) removeAttackers(ctx, removed);
}

/**
 * attacker 元件脚本单条分派（切片 21）。返回 true = removeSelf。
 * 未注册 op 确定性静默（madara justHit miss 分支留 raw——内层 hitVO 未
 * 导出前无真值，见 attackerScripts 契约注）。
 */
function dispatchAttackerScript(ctx: SimCtx, a: AttackerState, t: FrameTrigger): boolean {
  if (t.target === 'attacker') {
    if (t.op === 'if') return dispatchAttackerCond(ctx, a, t);
    switch (t.op) {
      case 'stop':
        a.animHold = true;
        return false;
      case 'gotoAndPlay': {
        const arg = t.args[0];
        if (typeof arg === 'string') {
          const f = a.animLabels[arg];
          if (f === undefined) return false; // 标签缺失静默
          a.animFrame = f;
        } else if (typeof arg === 'number') {
          a.animFrame = arg;
        } else {
          return false;
        }
        a.animHold = false;
        a.frameJumped = true;
        return false;
      }
      case 'stopFollowTarget':
        a.followX = false;
        a.followY = false;
        return false;
      case 'removeSelf':
        return true;
      case 'endAct':
        return false;
      default:
        return false;
    }
  }
  // effect 表现系（原版 $attacker_ctrler.effect 转发；坐标取道具实体）
  switch (t.op) {
    case 'playSoundHit1':
      ctx.emit('sound', { id: 'hit1', x: a.x, y: a.y });
      return false;
    case 'playSoundHit2':
      ctx.emit('sound', { id: 'hit2', x: a.x, y: a.y });
      return false;
    case 'shine':
      ctx.emit('effect', { id: 'shine', x: a.x, y: a.y, params: { arg: t.args[0] } });
      return false;
    default:
      return false;
  }
}

/**
 * attacker 元件条件触发分派（B5，madara miss 分支）：cond 成立执行 then，
 * 否则执行 else；分支体调用仍走元件脚本分派（gotoAndPlay 需经 frameJumped
 * 语义），removeSelf 短路同帧移除。
 */
function dispatchAttackerCond(ctx: SimCtx, a: AttackerState, t: FrameTrigger): boolean {
  const cond = t.cond;
  if (cond === undefined) return false;
  const branch = evaluateAttackerCondition(ctx, a, cond) ? t.then : t.else;
  if (!branch) return false;
  for (const c of branch) {
    const removed = dispatchAttackerScript(ctx, a, {
      frame: t.frame,
      target: c.target,
      op: c.op,
      args: c.args,
    });
    if (removed) return true;
  }
  return false;
}

/**
 * attacker 语境条件查询（B5）。justHit：原版 FighterAttackerCtrler.justHit
 * 委托 owner 控制器 → AssisterCtrler.isJustHit = 目标 hurtHit.id 比对；
 * port = 目标 lastHurtHitId（受击恢复清空，近战 justHit 同语义）。
 * 未知查询 op = false（确定性静默，同 fighter 侧 evaluateTriggerCondition）。
 */
function evaluateAttackerCondition(
  ctx: SimCtx,
  a: AttackerState,
  cond: TriggerCondition,
): boolean {
  if (cond.op === 'justHit') {
    const hitid = typeof cond.args[0] === 'string' ? cond.args[0] : null;
    const t = ctx.state.fighters.find((f) => f.id !== a.ownerId) ?? null;
    const v =
      t !== null &&
      hitid !== null &&
      (t.lastHurtHitId === hitid || (cond.args[1] === true && t.lastDefHitId === hitid));
    return cond.negate === true ? !v : v;
  }
  return false;
}

/**
 * 生成独立道具（behaviors.addAttacker 引擎桥；原版 FighterAttacker.init）。
 * 位置：元件原点锚定（B5），x 轴沿朝向镜像；moveToTarget 轴改以 target 为基准。
 * 偏离：fires 缺逐帧数据的元件回退占位矩形见 state.ts AttackerState 注；
 * range 轴语料未出现，不支持（确定性静默）。
 */
export function spawnAttacker(ctx: SimCtx, spec: AttackerSpawnSpec): void {
  const { owner, name, local, fbHit, hit, hitId, params } = spec;
  spawnAttackerEntity(ctx, {
    anchor: owner,
    ownerId: owner.id,
    targetOf: ctx.state.fighters.find((f) => f.id !== owner.id) ?? null,
    name,
    local,
    fbHit,
    hit,
    hitId,
    anim: spec.anim,
    params,
    viaAssist: false,
    scriptAssistId: null,
  });
}

/**
 * 辅助生成独立道具（assister.addAttacker 引擎桥；原版同 FighterAttacker，
 * owner = 辅助实体）：位置锚/朝向取辅助实体，命中回气归召唤者
 * （原版 getOwnerFighter 回溯），渲染图集/逐帧命中数据走辅助侧（viaAssist）。
 */
export function spawnAssistAttacker(ctx: SimCtx, spec: AssistAttackerSpawnSpec): void {
  const owner = ctx.state.fighters.find((f) => f.id === spec.ownerId) ?? null;
  // 来源辅助 def id（B5 起 viaAssist 必设：fires 元数据/元件脚本寻址）；
  // def.attackerScripts[name] 存在 → 标签并入 animLabels（fires 元数据
  // 同基同值，attackerScripts 优先）
  const def = ctx.assisterDefs.get(spec.self.assistId);
  const scripts = def?.attackerScripts?.[spec.name];
  spawnAttackerEntity(ctx, {
    anchor: spec.self,
    ownerId: spec.ownerId,
    targetOf:
      owner !== null ? ctx.state.fighters.find((f) => f.id !== owner.id) ?? null : null,
    name: spec.name,
    local: spec.local,
    fbHit: spec.fbHit,
    hit: spec.hit,
    hitId: spec.hitId,
    anim: spec.anim,
    params: spec.params,
    viaAssist: true,
    scriptAssistId: spec.self.assistId,
    ...(scripts !== undefined ? { scriptLabels: scripts.labels } : {}),
  });
}

function spawnAttackerEntity(
  ctx: SimCtx,
  args: {
    anchor: { x: number; y: number; facing: 1 | -1 };
    ownerId: number;
    targetOf: FighterState | null;
    name: string;
    local: AreaRect;
    fbHit: { x: number; y: number; w: number; h: number };
    hit: HitDef | null;
    hitId: string | null;
    anim?: { totalFrames: number; labels: Record<string, number> } | undefined;
    params: AttackerParams;
    viaAssist: boolean;
    /** 来源辅助 def id（viaAssist 时必设：fires 元数据/元件脚本寻址；
     *  切片 21 仅脚本来源，B5 扩展；null = 角色生成） */
    scriptAssistId: string | null;
    /** 元件脚本标签（def.attackerScripts[name].labels；并入 animLabels） */
    scriptLabels?: Record<string, number>;
  },
): void {
  const { anchor, ownerId, targetOf: t, name, local, fbHit, hit, hitId, anim, params, viaAssist } = args;
  // 元件原点（root 空间 direct=1）= 生成帧判定区 − 回退矩形偏移；
  // 原版 _mcOrgPoint = (mainmc.x, mainmc.y)（实例摆放在父时间轴的位置）
  const orgX = local.x - fbHit.x;
  const orgY = local.y - fbHit.y;
  const axisX = typeof params.x === 'object' && params.x !== null ? params.x : null;
  const axisY = typeof params.y === 'object' && params.y !== null ? params.y : null;
  // 原版 _startX：number → params.x + _mcOrgPoint.x；轴对象 → offset；
  // 缺省 → _mcOrgPoint（FighterAttacker.as:36-96）
  const startX = typeof params.x === 'number' ? params.x + orgX : axisX?.offset ?? orgX;
  const startY = typeof params.y === 'number' ? params.y + orgY : axisY?.offset ?? orgY;
  let cx = anchor.x + startX * anchor.facing;
  let cy = anchor.y + startY;
  if (axisX?.moveToTarget === true && t !== null) cx = t.x + startX * anchor.facing;
  if (axisY?.moveToTarget === true && t !== null) cy = t.y + startY;
  const attacker: AttackerState = {
    id: ctx.state.nextEntityId,
    ownerId,
    facing: anchor.facing,
    name,
    x: cx,
    y: cy,
    w: local.w,
    h: local.h,
    fbHit,
    offsetX: startX,
    offsetY: startY,
    followX: axisX?.followTarget === true,
    followY: axisY?.followTarget === true,
    applyG: params.applyG === true,
    gRamp: 0,
    holdTicks: ATTACKER_LIFE_TICKS,
    animTotal: anim?.totalFrames ?? 0,
    animFrame: 1,
    hit: hit !== null ? { ...hit } : null,
    hitId,
    hitAble: true,
    viaAssist,
    animHold: false,
    animLabels: { ...(anim?.labels ?? {}), ...(args.scriptLabels ?? {}) },
    scriptAssistId: args.scriptAssistId,
    frameJumped: false,
  };
  ctx.state.nextEntityId += 1;
  ctx.state.attackers.push(attacker);
  ctx.state.attackers.sort((a, b) => a.id - b.id);
  ctx.emit('entity:spawn', { kind: 'attacker', id: attacker.id, name: attacker.name, owner: ownerId });
}

/** 独立道具每 tick 推进：follow 轴重定位 / 重力 / 回退寿命（动画推进在 stepAttackerAnim）。
 *  slowDown 全局慢放（切片 49）：重力增量/消费位移 ×scale（原版 FighterAttacker
 *  继承 BaseGameSprite speedPlus 语义）；scale 供回合结束演出期终结慢镜头折算。 */
export function stepAttackers(ctx: SimCtx, scale = 1): void {
  const { stage, fighters, attackers } = ctx.state;
  const slowScale = slowDownScaleOf(ctx.state) * scale;
  const removed: number[] = [];
  for (const a of attackers) {
    const t = fighters.find((f) => f.id !== a.ownerId) ?? null;
    // followTarget：原点重定位到 target + 局部偏移（x 沿道具朝向镜像）；
    // 非 follow 轴生成后固定（原版 attacker 是绝对定位实体）
    if (a.followX && t !== null) a.x = t.x + a.offsetX * a.facing;
    if (a.followY && t !== null) a.y = t.y + a.offsetY;
    if (a.applyG) {
      // 底边 = 原点 + 回退矩形底（B5 原点锚定；回退 org=中心时与旧
      // a.y + a.h 中心语义等价）
      const bottom = a.y + a.fbHit.y + a.fbHit.h;
      if (bottom >= stage.groundY) {
        a.y = stage.groundY - (a.fbHit.y + a.fbHit.h);
        a.gRamp = GRAVITY_START;
      } else {
        a.gRamp = Math.min(a.gRamp + GRAVITY_STEP * slowScale, GRAVITY_CAP);
        a.y += a.gRamp * slowScale;
      }
    }
    // 寿命：有元件时间轴由 stepAttackerAnim 播尽移除；无时间轴走占位回退
    if (a.animTotal <= 0 && --a.holdTicks <= 0) removed.push(a.id);
  }
  if (removed.length > 0) removeAttackers(ctx, removed);
}

export function removeAttackers(ctx: SimCtx, ids: number[]): void {
  const set = new Set(ids);
  ctx.state.attackers = ctx.state.attackers.filter((a) => {
    if (set.has(a.id)) {
      ctx.emit('entity:despawn', { kind: 'attacker', id: a.id });
      return false;
    }
    return true;
  });
}
