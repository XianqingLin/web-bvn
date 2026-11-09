/**
 * 角色状态机（原版 FighterMcCtrler 的子集，module-map §5.2/§5.3）。
 *
 * 切片 5 覆盖：站立/行走/跳跃/砍击（含连段）/砍技/招/必杀/瞬步/防御/受击/击飞/倒地/死亡。
 * 输入组合语义与 renderFloorAction/renderAirAction 的检查顺序逐条对照原版
 * （FighterKeyCtrler：技=技能键±上/下；砍技N=攻击键±下/上；必杀=必杀键±下/上）。
 *
 * 明确偏离原版（逐条记录，DESIGN §3.5 偏离清单同步）：
 * - 无跳跃前摇（原版 JUMP_DELAY_FRAME=2）与二段跳/快速下落/空中瞬步（需 jumpTimes）；
 * - 摔技（catch1/2，sh1/sh2）未接线——需要投技目标逻辑（moveTarget），后续切片；
 * - 防御无刚防窗口区分（原版 _justDefenseFrame 0.1s），按住 ↓ 即防御态；
 * - 防御解除无 6 tick 延迟（原版 _defenseFrameDelay 计数），松开 ↓ 即进入 防御恢复；
 * - 万解/ghost step/移形换位/开场未接。
 */
import { Btn, type InputView } from '../input.js';
import { ENERGY_GAP_TICKS } from '../state.js';
import {
  ActionState,
  DOWN_FRAMES_FALLBACK,
  FALLBACK_JUMP_POWER,
  LOOP_LABELS,
  RISE_FRAMES_FALLBACK,
  SPEED_PLUS,
  actionIdForLabel,
  atmName,
  currentAreas,
  defaultSlots,
  isAttackingState,
  worldRect,
  type AreaRect,
  type FighterDef,
  type FighterSlots,
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
/** 原版 DEFENSE_DAMPING_X=1@30fps → 0.5/tick@60Hz（防御命中推挡衰减） */
export const DEFENSE_DAMP_X = 0.5;
/** 原版 HURT_Y_ADD_INAIR=3 / HURT_Y_ADD=6（空间量，不折算） */
const HURT_Y_ADD_INAIR = 3;
const HURT_Y_ADD = 6;
/** 原版 HURT_FRAME_OFFSET=3、下限 4（帧数，不折算） */
const HURT_HOLD_OFFSET = 3;
const HURT_HOLD_MIN = 4;
/** 瞬步能量消耗（原版 doDash：hasEnergy(20, true) 允许透支） */
export const DASH_ENERGY_COST = 20;
/** 空中必杀消耗（原版 bishaAIRQi=100；doBisha 不允许透支） */
const BISHA_AIR_QI = 100;
/** 防御命中无敌窗（原版 DEFENSE_GAP_FRAME=4 tick；击飞类 8） */
const DEFENSE_GAP_TICKS = 4;
const DEFENSE_GAP_DOWN_TICKS = 8;
/** 防御削韧（原版 DEFENSE_HOLD_FRAME：hurtTime/1000×FPS/5，夹 [5,10]；击飞类 10） */
const DEFENSE_HOLD_MIN = 5;
const DEFENSE_HOLD_MAX = 10;
const DEFENSE_HOLD_DOWN = 10;
/** 破防硬直（原版 BREAK_DEF_HOLD_FRAME=42） */
const BREAK_DEF_HOLD_TICKS = 42;
/** 破防击退下限/上限（原版 doBreakDefense：hitx 夹 [5,10]） */
const BREAK_DEF_PUSH_MIN = 5;
const BREAK_DEF_PUSH_MAX = 10;

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
  f.isAllowBeHit = true;
  f.beHitGap = 0;
  if (f.onGround) idleLabel(f, def);
  else setLabel(f, def, '跳中');
}

/**
 * 动作收招（原版 endAct 触发 / 标签播完）：
 * 空中回 JUMP_ING（跳中），地面回 NORMAL（站立）；
 * 清攻击态、恢复可被命中、按 def 重填动作槽（原版 setAllAct + checkFrame）。
 */
export function endAction(f: FighterState, def: FighterDef | null): void {
  if (isAttackingState(f.actionState) || f.actionState === ActionState.DASH_ING) {
    f.attackId = null;
  }
  if (f.actionState !== ActionState.DEFENCE_ING) {
    f.isAllowBeHit = true;
  }
  f.slots = defaultSlots(def);
  // 原版 _action.clearAction()：动作边界清除 per-action 标志
  f.isCross = false;
  f.airMove = false;
  f.touchFloor = null;
  if (f.onGround) {
    if (f.actionState !== ActionState.HURT_ING && f.actionState !== ActionState.HURT_DOWN) {
      f.actionState = ActionState.NORMAL;
    }
    idleLabel(f, def);
  } else if (
    isAttackingState(f.actionState) ||
    f.actionState === ActionState.JUMP_ING ||
    f.actionState === ActionState.DASH_ING ||
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

/** 发起攻击（原版 doAttack：切攻击态并按动作名寻帧）。标签缺失 = 动作不可用。 */
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
  // 原版 clearAction：新动作清除 per-action 标志
  f.isCross = false;
  f.airMove = false;
  f.touchFloor = null;
  return true;
}

/** 槽动作（存标签）→ 发起攻击（attackLabels 反查动作 id 供命中结算）。 */
function startAttackByLabel(
  f: FighterState,
  def: FighterDef | null,
  label: string,
): boolean {
  const id = actionIdForLabel(def, label);
  if (id === null) return false;
  return startAttack(f, def, id);
}

/** 地面攻击键 → 砍1（槽 attack；连段由帧触发 setAttack 改写槽实现）。 */
function groundAttackId(def: FighterDef | null): string | null {
  return def && def.attackLabels['k1'] !== undefined ? 'k1' : null;
}

/** 空中攻击键 → 跳砍（tk；原版 attackAIR 默认帧名）。 */
function airAttackId(def: FighterDef | null): string | null {
  return def && def.attackLabels['tk'] !== undefined ? 'tk' : null;
}

// —— 防御 / 瞬步 / 技 / 必杀 ——

/** 进入防御（原版 doDefense：dampingPercent(1,1) 停住 + 防御 label 循环）。 */
function doDefense(f: FighterState, def: FighterDef | null): void {
  f.actionState = ActionState.DEFENCE_ING;
  f.vx = 0;
  f.vy = 0;
  f.attackId = null;
  // 原版 setDefenseAction：清槽后仅保留 砍技1/招2/超必杀 可从防御发起
  const s = defaultSlots(def);
  f.slots = {
    ...s,
    attack: null,
    skill2: null,
    zhao1: null,
    zhao3: null,
    bisha: null,
    bishaUp: null,
    dash: null,
  };
  setLabel(f, def, '防御');
}

/** 退出防御（原版 renderDefenseAnimate → 防御恢复 → idle；POC 无 6 tick 延迟）。 */
function exitDefense(f: FighterState, def: FighterDef | null): void {
  f.actionState = ActionState.NORMAL;
  const land = def?.labels['防御恢复'];
  if (land) {
    f.actLabel = '防御恢复';
    f.animFrame = land.index + 1;
    f.labelLock = land.duration;
  }
}

/**
 * 瞬步（原版 doDash：能量 20 可透支；按住方向决定瞬步朝向；
 * DASH_ING 期间不可被命中；位移来自角色帧触发 dash/movePercent 系）。
 */
function doDash(f: FighterState, def: FighterDef | null): void {
  if (!canSpendEnergy(f, DASH_ENERGY_COST, true)) return;
  spendEnergy(f, DASH_ENERGY_COST);
  if (f.onGround) {
    f.vy = 0;
    f.actionState = ActionState.DASH_ING;
    f.isAllowBeHit = false;
    f.attackId = null;
    setLabel(f, def, '瞬步');
  }
  // 空中瞬步需 jumpTimes（二段跳），本切片不接——保持跳跃惯性
}

/** 必杀/技能入口（原版 doSkill/doBisha：SKILL_ING 无消耗；必杀扣气）。 */
function startSkill(
  f: FighterState,
  def: FighterDef | null,
  label: string,
  qiCost: number,
  superLevel: boolean,
): boolean {
  if (qiCost > 0 && f.qi < qiCost) return false;
  const id = actionIdForLabel(def, label);
  const range = def?.labels[label];
  if (!range) return false;
  if (qiCost > 0) f.qi -= qiCost;
  f.actionState = superLevel ? ActionState.BISHA_SUPER_ING : ActionState.BISHA_ING;
  if (qiCost === 0) f.actionState = ActionState.SKILL_ING;
  f.attackId = id; // 可为 null（标签存在但无动作表 → 有动画无判定）
  f.attackHit = [];
  f.actLabel = label;
  f.animFrame = range.index + 1;
  f.labelLock = 0;
  // 原版 clearAction：新动作清除 per-action 标志
  f.isCross = false;
  f.airMove = false;
  f.touchFloor = null;
  return true;
}

// —— 能量（原版 FighterMain.hasEnergy/useEnergy；回充在 sim 步骤 7） ——

function canSpendEnergy(f: FighterState, v: number, allowOverflow: boolean): boolean {
  if (f.energy >= v) return true;
  return allowOverflow && !f.energyOverload;
}

function spendEnergy(f: FighterState, v: number): void {
  f.energy -= v;
  f.energyGap = ENERGY_GAP_TICKS;
  if (f.energy < 0) {
    f.energy = 0;
    f.energyOverload = true;
  }
}

/**
 * 意图决策（每 tick，管线第 2 步调用）。
 * 地面动作检查顺序照抄原版 renderFloorAction（后触发覆盖先触发，实际由
 * 修饰键互斥保证单触发）：必杀系 → 砍技/招 → 攻击 → 防御 → 瞬步 → 跳。
 * 空中照 renderAirAction：跳砍/跳招/空中必杀。
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
    f.actionState === ActionState.HURT_DOWN
  ) {
    return;
  }

  const down = view.held(Btn.down);
  const up = view.held(Btn.up);

  // —— 防御态：原版 setDefenseAction 清槽后仅留 砍技1/招2/超必杀；松 ↓ 退出 ——
  if (f.actionState === ActionState.DEFENCE_ING) {
    if (!down) {
      exitDefense(f, def);
      return;
    }
    if (view.buffered(Btn.attack) && f.slots.skill1 !== null) {
      view.consume(Btn.attack);
      startAttackByLabel(f, def, f.slots.skill1);
    } else if (view.buffered(Btn.skill) && f.slots.zhao2 !== null) {
      view.consume(Btn.skill);
      startSkill(f, def, f.slots.zhao2, 0, false);
    } else if (view.buffered(Btn.superSkill) && f.slots.bishaSuper !== null) {
      view.consume(Btn.superSkill);
      startSkill(f, def, f.slots.bishaSuper, f.slots.bishaSuperQi, true);
    } else if (view.buffered(Btn.dash)) {
      view.consume(Btn.dash);
      doDash(f, def);
    }
    return;
  }

  if (f.onGround) {
    // 必杀系（superSkill ± 上/下；原版 bishaSUPER/bishaUP/bisha 顺序）
    if (view.buffered(Btn.superSkill)) {
      if (down && f.slots.bishaSuper !== null) {
        view.consume(Btn.superSkill);
        startSkill(f, def, f.slots.bishaSuper, f.slots.bishaSuperQi, true);
      } else if (up && f.slots.bishaUp !== null) {
        view.consume(Btn.superSkill);
        startSkill(f, def, f.slots.bishaUp, f.slots.bishaUpQi, false);
      } else if (!up && !down && f.slots.bisha !== null) {
        view.consume(Btn.superSkill);
        startSkill(f, def, f.slots.bisha, f.slots.bishaQi, false);
      }
    }
    // 攻击系（attack ± 上/下；原版 skill2/skill1/attack 顺序）
    if (view.buffered(Btn.attack)) {
      if (up && f.slots.skill2 !== null) {
        view.consume(Btn.attack);
        startAttackByLabel(f, def, f.slots.skill2);
      } else if (down && f.slots.skill1 !== null) {
        view.consume(Btn.attack);
        startAttackByLabel(f, def, f.slots.skill1);
      } else if (!up && !down && !view.held(Btn.jump) && f.slots.attack !== null) {
        view.consume(Btn.attack);
        startAttackByLabel(f, def, f.slots.attack);
      } else if (!up && !down && !view.held(Btn.jump)) {
        // 槽为空但 k1 直接可用（def 无槽接线时的兜底，与切片 3 行为兼容）
        const id = groundAttackId(def);
        view.consume(Btn.attack);
        if (id !== null) startAttack(f, def, id);
      }
    }
    // 技系（skill ± 上/下；原版 zhao3/zhao2/zhao1 顺序）
    if (view.buffered(Btn.skill)) {
      if (up && f.slots.zhao3 !== null) {
        view.consume(Btn.skill);
        startSkill(f, def, f.slots.zhao3, 0, false);
      } else if (down && f.slots.zhao2 !== null) {
        view.consume(Btn.skill);
        startSkill(f, def, f.slots.zhao2, 0, false);
      } else if (!up && !down && f.slots.zhao1 !== null) {
        view.consume(Btn.skill);
        startSkill(f, def, f.slots.zhao1, 0, false);
      }
    }
    // 防御（原版 defense() = down 按住；attack 优先级更高，上面已分流）
    if (down && f.actionState !== ActionState.ATTACK_ING && f.slots.attack !== null) {
      doDefense(f, def);
      return;
    }
    // 行走标签（物理仍由 sim 每 tick 施加）
    if (f.actionState === ActionState.NORMAL && f.labelLock <= 0) {
      const moving = view.held(Btn.left) || view.held(Btn.right);
      if (def) setLabel(f, def, moving ? '走' : '站立');
    }
    // 瞬步（原版在防御检查之后）
    if (view.buffered(Btn.dash)) {
      view.consume(Btn.dash);
      doDash(f, def);
      if (f.actionState === ActionState.DASH_ING) return;
    }
    // 跳跃（原版在移动之后）
    if (view.buffered(Btn.up) || view.buffered(Btn.jump)) {
      view.consume(Btn.up);
      view.consume(Btn.jump);
      startJump(f, def);
      return;
    }
  } else {
    // 空中（原版 renderAirAction）：跳砍/跳招/空中必杀
    if (view.buffered(Btn.attack)) {
      const id = airAttackId(def);
      view.consume(Btn.attack);
      if (id !== null) startAttack(f, def, id);
    }
    if (view.buffered(Btn.skill)) {
      view.consume(Btn.skill);
      const s = f.slots;
      const label = up ? s.zhao3 : down ? s.zhao2 : s.zhao1;
      if (label) startSkill(f, def, label, 0, false);
    }
    if (view.buffered(Btn.superSkill)) {
      view.consume(Btn.superSkill);
      if (f.qi >= BISHA_AIR_QI) startSkill(f, def, '必杀', BISHA_AIR_QI, false);
    }
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
 *
 * `_CHK` 续接（切片 5）：原版 MC 时间轴连续播放，招2 播完自然滑入
 * 招2_CHK（zh2atm 判定区在 _CHK 段）。规则：标签播尽且存在
 * `<label>_CHK` 且帧号连续（chk.index == cur.index+cur.duration）→ 续播。
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
      else {
        const chkName = `${label}_CHK`;
        const chk = def.labels[chkName];
        if (chk && chk.index === range.index + range.duration) {
          f.actLabel = chkName;
          f.animFrame = chk.index + 1;
        } else {
          endAction(f, def);
        }
      }
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
  // 触地续接（原版 touchFloor()：setTouchFloor 预约的标签在触地时接管，
  // 普通跳跃落地同样消费；受击落地除外）
  if (f.touchFloor !== null && f.actionState !== ActionState.DEAD) {
    const tf = def?.labels[f.touchFloor];
    if (tf) {
      f.actLabel = f.touchFloor;
      f.animFrame = tf.index + 1;
      f.labelLock = 0;
      f.touchFloor = null;
      return;
    }
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
 * 受击进入（原版 doHurt 子集）。hp/死亡结算由调用方处理。
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
  f.isCross = false;
  f.airMove = false;
  f.touchFloor = null;
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

/** 破防（原版 doBreakDefense：削血 1/10、强制 HURT_ING、击退夹 [5,10]）。 */
export function enterGuardBreak(
  f: FighterState,
  def: FighterDef | null,
  hit: HitDef,
  attackerFacing: 1 | -1,
): void {
  let hitx = hit.hitx;
  if (hitx < BREAK_DEF_PUSH_MIN) hitx = BREAK_DEF_PUSH_MIN;
  if (hitx > BREAK_DEF_PUSH_MAX) hitx = BREAK_DEF_PUSH_MAX;
  f.actionState = ActionState.HURT_ING;
  f.hurtTimer = BREAK_DEF_HOLD_TICKS;
  f.attackId = null;
  f.isAllowBeHit = false; // 原版 doBreakDefense 置不可命中，硬直结束后恢复
  f.beHitGap = 0;
  f.vx = hitx * attackerFacing * SPEED_PLUS;
  f.dampX = HURT_DAMP_X;
  setLabel(f, def, '被打');
}

/** 防御命中硬直窗（原版 doDefenseHit：hurtTime/1000×FPS/5 夹 [5,10]；击飞类固定 10）。 */
export function defenseHoldTicks(hit: HitDef): number {
  if (hit.hurtType !== 0) return DEFENSE_HOLD_DOWN;
  const t = ((hit.hurtTime / 1000) * 60) / 5;
  return Math.min(DEFENSE_HOLD_MAX, Math.max(DEFENSE_HOLD_MIN, Math.round(t)));
}

/** 防御命中无敌窗 tick 数（击飞类更长，原版 DEFENSE_GAP_FRAME_DOWN）。 */
export function defenseGapTicks(hit: HitDef): number {
  return hit.hurtType !== 0 ? DEFENSE_GAP_DOWN_TICKS : DEFENSE_GAP_TICKS;
}

/** 死亡进入。 */
export function enterDead(f: FighterState, def: FighterDef | null): void {
  f.actionState = ActionState.DEAD;
  f.attackId = null;
  f.hurtTimer = 0;
  f.isAllowBeHit = true;
  f.beHitGap = 0;
  setLabel(f, def, '失败');
}

/** 当前攻击动作的命中矩形（世界坐标）；非攻击状态/无动作 → 空。 */
export function currentAttackAreas(f: FighterState, def: FighterDef | null): AreaRect[] {
  if (!isAttackingState(f.actionState) || f.attackId === null || !def) return [];
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

/** 动作槽类型再导出（sim 装配用）。 */
export type { FighterSlots };
