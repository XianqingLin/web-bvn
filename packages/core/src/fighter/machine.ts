/**
 * 角色状态机（原版 FighterMcCtrler 的最小闭环子集，module-map §5.2）。
 *
 * 覆盖：站立/行走/跳跃/攻击/受击/击飞/倒地/死亡。
 * 明确偏离原版（POC 简化，逐条记录）：
 * - 无跳跃前摇（原版 JUMP_DELAY_FRAME=2）与二段跳/快速下落；
 * - 砍击无连段（attack 键固定 k1/跳砍，原版按连击窗口接 k2/k3）；
 * - 击飞无弹地（击飞_弹）与受身，落地直接倒地→起身；
 * - 无防御（DEFENCE_ING）、瞬步（DASH_ING）、必杀状态；
 * - hurtTime 为 0 的必杀级判定（bs/tz）照常进 HURT_FLYING。
 */
import { Btn, type InputView } from '../input.js';
import {
  ActionState,
  DOWN_FRAMES_FALLBACK,
  FALLBACK_JUMP_POWER,
  LOOP_LABELS,
  RISE_FRAMES_FALLBACK,
  SPEED_PLUS,
  atmName,
  currentAreas,
  worldRect,
  type AreaRect,
  type FighterDef,
  type HitDef,
} from './def.js';
import type { FighterState } from '../state.js';

// —— 原版常量导入换算（DESIGN §3.1：速度/衰减类 ×SPEED_PLUS=0.5，帧数类不折算） ——
/** 原版 JUMP_DAMPING=0.5@30fps → 0.25/tick@60Hz */
export const JUMP_DAMPING = 0.25;
/** 原版 HURT_DAMPING_X=0.1@30fps → 0.05/tick@60Hz */
export const HURT_DAMP_X = 0.05;
/** 原版 HURT_DAMPING_Y=0.5@30fps → 0.25/tick@60Hz */
export const HURT_DAMP_Y = 0.25;
/** 原版 HURT_FLY_DAMPING_X=0：击飞期间水平不衰减（落地/撞击才结算） */
export const HURT_FLY_DAMP_X = 0;
/** 原版 HURT_Y_ADD_INAIR=3 / HURT_Y_ADD=6（空间量，不折算） */
const HURT_Y_ADD_INAIR = 3;
const HURT_Y_ADD = 6;
/** 原版 HURT_FRAME_OFFSET=3、下限 4（帧数，不折算） */
const HURT_HOLD_OFFSET = 3;
const HURT_HOLD_MIN = 4;

/** 跳跃速度（缺省兜底 = FALLBACK_JUMP_POWER × SPEED_PLUS）。 */
export function jumpVelocity(def: FighterDef | null): number {
  return -(def ? def.jumpPower : FALLBACK_JUMP_POWER) * SPEED_PLUS;
}

/** 行走速度（×SPEED_PLUS；缺省兜底 = FALLBACK_SPEED，与切片 2 基准一致）。 */
export function walkSpeed(def: FighterDef | null): number {
  return def ? def.speed * SPEED_PLUS : 4;
}

/** 设置动作标签（缺标签则忽略；同标签不重置帧号）。 */
export function setLabel(
  f: FighterState,
  def: FighterDef | null,
  name: string,
): void {
  const range = def?.labels[name];
  if (!range) return;
  if (f.actLabel !== name) {
    f.actLabel = name;
    f.animFrame = range.index + 1;
  }
}

/** 站立待机标签（有 def 才维护）。 */
function idleLabel(f: FighterState, def: FighterDef | null): void {
  if (def && f.actLabel !== '站立' && f.actLabel !== '落地') setLabel(f, def, '站立');
}

/** 回到普通状态（受击/倒地计时结束）。 */
export function recoverToNormal(f: FighterState, def: FighterDef | null): void {
  f.actionState = ActionState.NORMAL;
  f.hurtTimer = 0;
  f.attackId = null;
  if (f.onGround) idleLabel(f, def);
  else setLabel(f, def, '跳中');
}

/**
 * 动作收招（原版 endAct 触发 / 标签播完）：
 * 空中回 JUMP_ING（跳中），地面回 NORMAL（站立）。
 */
export function endAction(f: FighterState, def: FighterDef | null): void {
  if (f.actionState === ActionState.ATTACK_ING) f.attackId = null;
  if (f.onGround) {
    if (f.actionState === ActionState.ATTACK_ING || f.actionState === ActionState.JUMP_ING) {
      f.actionState = ActionState.NORMAL;
    }
    idleLabel(f, def);
  } else if (
    f.actionState === ActionState.ATTACK_ING ||
    f.actionState === ActionState.JUMP_ING ||
    f.actionState === ActionState.NORMAL
  ) {
    f.actionState = ActionState.JUMP_ING;
    setLabel(f, def, '跳中');
  }
}

/** 起跳（原版 FighterMain.jump：vy=-jumpPower，damping=JUMP_DAMPING）。 */
export function startJump(f: FighterState, def: FighterDef | null): void {
  f.actionState = ActionState.JUMP_ING;
  f.vy = jumpVelocity(def);
  f.dampY = JUMP_DAMPING;
  f.onGround = false;
  setLabel(f, def, '起跳');
}

/** 发起攻击（原版 doAttack：切 ATTACK_ING 并按动作名寻帧）。标签缺失 = 动作不可用。 */
export function startAttack(
  f: FighterState,
  def: FighterDef | null,
  actionId: string,
): boolean {
  const label = def?.attackLabels[actionId];
  const range = label !== undefined ? def?.labels[label] : undefined;
  if (!def || label === undefined || !range) return false;
  f.actionState = ActionState.ATTACK_ING;
  f.attackId = actionId;
  f.attackHit = [];
  f.actLabel = label;
  f.animFrame = range.index + 1;
  f.labelLock = 0;
  return true;
}

/** 地面攻击键 → 砍1（POC：无连段）。 */
export function groundAttackId(def: FighterDef | null): string | null {
  return def && def.attackLabels['k1'] !== undefined ? 'k1' : null;
}

/** 空中攻击键 → 跳砍（POC：kj1）。 */
export function airAttackId(def: FighterDef | null): string | null {
  return def && def.attackLabels['kj1'] !== undefined ? 'kj1' : null;
}

/**
 * 意图决策（每 tick，管线第 2 步调用；朝向由 sim 统一处理）。
 * 仅 NORMAL/JUMP_ING 可行动；ATTACK/HURT 状态锁定。
 */
export function stepIntentsFor(
  f: FighterState,
  def: FighterDef | null,
  view: InputView,
): void {
  if (
    f.actionState === ActionState.DEAD ||
    f.actionState === ActionState.HURT_ING ||
    f.actionState === ActionState.HURT_FLYING ||
    f.actionState === ActionState.HURT_DOWN ||
    f.actionState === ActionState.ATTACK_ING
  ) {
    return;
  }
  // 行走标签（物理仍由 sim 每 tick 施加）
  if (f.actionState === ActionState.NORMAL && f.onGround && f.labelLock <= 0) {
    const moving = view.held(Btn.left) || view.held(Btn.right);
    if (def) setLabel(f, def, moving ? '走' : '站立');
  }
  // 跳跃（地面）
  if (f.onGround && (view.buffered(Btn.up) || view.buffered(Btn.jump))) {
    view.consume(Btn.up);
    view.consume(Btn.jump);
    startJump(f, def);
    return;
  }
  // 攻击（地面/空中）
  if (view.buffered(Btn.attack)) {
    const id = f.onGround ? groundAttackId(def) : airAttackId(def);
    view.consume(Btn.attack);
    if (id !== null) startAttack(f, def, id);
  }
}

/** 空中标签维护（上升段过半切 落 等；POC 简化：仅下落切 落）。 */
function maintainAirLabel(f: FighterState, def: FighterDef | null): void {
  if (f.actionState === ActionState.JUMP_ING && f.vy > 0) {
    if (f.actLabel === '起跳' || f.actLabel === '跳中' || f.actLabel === null) {
      setLabel(f, def, '落');
    }
  }
}

/** 倒地起身段的帧数（def 标签缺失时兜底）。 */
function riseFrames(def: FighterDef | null): number {
  return def?.labels['起身']?.duration ?? RISE_FRAMES_FALLBACK;
}

/**
 * 动画帧推进（30Hz，管线第 5 步；无 def 角色只走状态计时）。
 *
 * 语义：f.animFrame 是「当前采样帧」——每次调用先对当前帧触发
 * onFrame 回调（帧触发器/判定区都以此帧为准），再推进到下一帧。
 * 标签切换（含循环回绕）总是落到新标签首帧，下一调用采样之。
 */
export function advanceAnimation(
  f: FighterState,
  def: FighterDef | null,
  onFrame?: (frame: number) => void,
): void {
  if (f.labelLock > 0) f.labelLock -= 1;
  if (!def) {
    if (
      f.actionState === ActionState.HURT_ING ||
      f.actionState === ActionState.HURT_DOWN
    ) {
      f.hurtTimer -= 1;
      if (f.hurtTimer <= 0) recoverToNormal(f, def);
    }
    return;
  }
  maintainAirLabel(f, def);
  const range0 = f.actLabel !== null ? def.labels[f.actLabel] : undefined;
  if (!range0) setLabel(f, def, '站立');
  // 1. 采样当前帧
  onFrame?.(f.animFrame);
  // 2. 状态计时（按采样帧计数）
  if (
    f.actionState === ActionState.HURT_ING ||
    f.actionState === ActionState.HURT_DOWN
  ) {
    if (f.actionState === ActionState.HURT_DOWN && f.hurtTimer === riseFrames(def)) {
      setLabel(f, def, '起身');
    }
    f.hurtTimer -= 1;
    if (f.hurtTimer <= 0) recoverToNormal(f, def);
  }
  // 3. 推进
  const label = f.actLabel;
  const range = label !== null ? def.labels[label] : undefined;
  if (range) {
    f.animFrame += 1;
    if (f.animFrame > range.index + range.duration) {
      if (LOOP_LABELS.has(label!)) f.animFrame = range.index + 1;
      else endAction(f, def);
    }
  }
}

/**
 * 落地状态转移（物理判定落地后调用；vy 已清零）。
 * 击飞落地 → 倒地（击飞_倒 → 起身 → NORMAL）；跳跃落地 → 落地恢复。
 */
export function onLanded(f: FighterState, def: FighterDef | null): void {
  if (f.actionState === ActionState.HURT_FLYING) {
    f.actionState = ActionState.HURT_DOWN;
    const down = def?.labels['击飞_倒']?.duration ?? DOWN_FRAMES_FALLBACK;
    f.hurtTimer = down + riseFrames(def);
    setLabel(f, def, '击飞_倒');
    f.dampX = HURT_DAMP_X;
    return;
  }
  if (f.actionState === ActionState.JUMP_ING) {
    f.actionState = ActionState.NORMAL;
    f.dampY = 0;
    const land = def?.labels['落地'];
    if (land) {
      f.actLabel = '落地';
      f.animFrame = land.index + 1;
      f.labelLock = land.duration;
    }
    return;
  }
}

/**
 * 受击进入（原版 doHurt 最小子集）。hp/死亡结算由调用方处理。
 * @param attackerFacing 攻击者朝向（原版 hitx *= owner.direct）
 * @returns 'fly' 击飞 | 'stagger' 硬直
 */
export function enterHurt(
  f: FighterState,
  def: FighterDef | null,
  hit: HitDef,
  attackerFacing: 1 | -1,
  airborne: boolean,
): 'fly' | 'stagger' {
  let hitx = hit.hitx * attackerFacing;
  let hity = hit.hity;
  if (airborne && hity <= 0) hity -= HURT_Y_ADD_INAIR;
  else if (!airborne && hity < 0) hity -= HURT_Y_ADD;

  f.attackId = null;
  f.labelLock = 0;
  f.vx = hitx * SPEED_PLUS;
  f.vy = hity * SPEED_PLUS;
  f.dampY = HURT_DAMP_Y;

  if (hit.hurtType !== 0) {
    // 击飞（原版 playHurtFly：按击退方向翻转朝向；水平不衰减）
    f.actionState = ActionState.HURT_FLYING;
    f.hurtTimer = 0;
    f.dampX = HURT_FLY_DAMP_X;
    if (hitx !== 0) f.facing = hitx > 0 ? -1 : 1;
    setLabel(f, def, '击飞');
    return 'fly';
  }
  f.actionState = ActionState.HURT_ING;
  // 原版：round(hurtTime/1000*30)+OFFSET，下限 4（动画帧）
  const hold = Math.round((hit.hurtTime * 30) / 1000) + HURT_HOLD_OFFSET;
  f.hurtTimer = Math.max(HURT_HOLD_MIN, hold);
  f.dampX = HURT_DAMP_X;
  setLabel(f, def, '被打');
  return 'stagger';
}

/** 死亡进入。 */
export function enterDead(f: FighterState, def: FighterDef | null): void {
  f.actionState = ActionState.DEAD;
  f.attackId = null;
  f.hurtTimer = 0;
  setLabel(f, def, '失败');
}

/** 当前攻击动作的命中矩形（世界坐标）；非攻击状态/无动作 → 空。 */
export function currentAttackAreas(f: FighterState, def: FighterDef | null): AreaRect[] {
  if (f.actionState !== ActionState.ATTACK_ING || f.attackId === null || !def) return [];
  const id = f.attackId;
  return currentAreas({ animFrame: f.animFrame, def }).filter(
    (a) => a.name === atmName(id) || a.name === id,
  );
}

/** 攻击矩形 → 世界坐标（含朝向镜像）。 */
export function attackAreasWorld(
  f: FighterState,
  def: FighterDef | null,
): { x: number; y: number; w: number; h: number }[] {
  return currentAttackAreas(f, def).map((r) => worldRect(f, r));
}
