/**
 * 角色状态机（原版 FighterMcCtrler 的子集，module-map §5.2/§5.3）。
 *
 * 切片 5 覆盖：站立/行走/跳跃/砍击（含连段）/砍技/招/必杀/瞬步/防御/受击/击飞/倒地/死亡。
 * 输入组合语义与 renderFloorAction/renderAirAction 的检查顺序逐条对照原版
 * （FighterKeyCtrler：技=技能键±上/下；砍技N=攻击键±下/上；必杀=必杀键±下/上）。
 *
 * 明确偏离原版（逐条记录，DESIGN §3.5 偏离清单同步）：
 * - 摔技（catch1/2，sh1/sh2）已接线（切片 9：allowCatch 邻接门 + moveTarget 吸附）；
 * - 防御无刚防窗口区分（原版 _justDefenseFrame 0.1s），按住 ↓ 即防御态；
 * - 防御解除无 6 tick 延迟（原版 _defenseFrameDelay 计数），松开 ↓ 即进入 防御恢复；
 * - 移形换位（换人）/开场演出流程未接（辅助系统切片）。
 * 切片 10 补：瞬身步家族（地面步/空中瞬跳/速降/空中瞬步）、二段跳（jumpTimes
 * + 起跳延迟）、快速下落、万解形态切换（doWanKai → 根时间轴翻页）。
 */
import { Btn, type InputView } from '../input.js';
import { ENERGY_GAP_TICKS, JUMP_TIMES_START } from '../state.js';
import {
  ActionState,
  DOWN_FRAMES_FALLBACK,
  FALLBACK_JUMP_POWER,
  LOOP_LABELS,
  RISE_FRAMES_FALLBACK,
  SPEED_PLUS,
  actionIdForLabel,
  currentAreas,
  currentBodyRect,
  defaultSlots,
  emptySlots,
  isAttackingState,
  worldRect,
  type AreaRect,
  type FighterDef,
  type FighterSlots,
  type HitDef,
  type LabelRange,
} from './def.js';
import type { FighterState } from '../state.js';

// —— 原版常量导入换算（DESIGN §3.1：速度/衰减类 ×SPEED_PLUS=0.5，帧数类不折算） ——
/** 防御抬手段定格帧数（原版 goFrame("防御", true, 3) 的第三参） */
export const DEFENSE_FREEZE_FRAMES = 3;
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
/** 万解气耗（原版 doWanKaiAction：useQi(300) 不允许透支） */
export const WAN_KAI_QI = 300;
/** 受击无敌窗（原版 HURT_GAP_FRAME=4，30fps 渲染帧；60Hz tick ×2=8。
 *  修复批次 38：此前按原值 4 tick 递减（60Hz），窗口实长仅原版一半——
 *  位移攻击（砍 3）攻击框 3 动画帧持续相交时解冻后二段命中） */
export const HURT_GAP_TICKS = 8;
/** 万解槽缺失时的兜底标签（原版 checkDoWankai attackingAct 参数） */
const WAN_KAI_FALLBACK = { plain: '万解', up: '万解W', down: '万解S' } as const;
/** 防御命中无敌窗（原版 DEFENSE_GAP_FRAME=4 渲染帧；击飞类 8；tick ×2） */
const DEFENSE_GAP_TICKS = 8;
const DEFENSE_GAP_DOWN_TICKS = 16;
/** 防御削韧（原版 DEFENSE_HOLD_FRAME：hurtTime/1000×FPS/5，夹 [5,10]；击飞类 10） */
const DEFENSE_HOLD_MIN = 5;
const DEFENSE_HOLD_MAX = 10;
const DEFENSE_HOLD_DOWN = 10;
/** 破防硬直（原版 BREAK_DEF_HOLD_FRAME=42） */
const BREAK_DEF_HOLD_TICKS = 42;
/** 破防击退下限/上限（原版 doBreakDefense：hitx 夹 [5,10]） */
const BREAK_DEF_PUSH_MIN = 5;
const BREAK_DEF_PUSH_MAX = 10;

// —— 跳跃 / 瞬身步家族（原版 FighterMcCtrler doJump 系/doGhost 系，切片 10） ——
/** 起跳延迟（原版 JUMP_DELAY_FRAME=2 地面 / JUMP_DELAY_FRAME_AIR=1 空中；帧数不折算） */
export const JUMP_DELAY_GROUND = 2;
export const JUMP_DELAY_AIR = 1;
/** 空中瞬步能量消耗（原版 doDashAir：hasEnergy(30, true) 允许透支） */
export const AIR_DASH_ENERGY_COST = 30;
/** 瞬身步气耗（原版 startGhostStep：qi < 60 拒绝，不可透支） */
export const GHOST_QI_COST = 60;
/** 瞬身步能量消耗（原版 hasEnergy(80, true) 允许透支） */
export const GHOST_ENERGY_COST = 80;
/** 瞬身步时长（原版 30fps × 0.4s = 12 帧 → 60Hz 24 tick） */
export const GHOST_TICKS = 24;
/** 瞬身步类型（原版 _ghostType：0 地面步 / 1 空中瞬跳 / 2 空中速降） */
export const GHOST_GROUND = 0;
export const GHOST_AIR_JUMP = 1;
export const GHOST_AIR_FALL = 2;
/** 地面瞬身步位移（原版 move(8,0)@30fps → 4/tick @60Hz） */
const GHOST_MOVE_X = 8;
/** 空中瞬跳纵向速度（原版 move(0,-12) → -6/tick；damping(0,0.1) → 0.05/tick） */
const GHOST_JUMP_Y = -12;
const GHOST_JUMP_DAMP = 0.05;
/** 空中速降纵向速度（原版 move(0,15) → 7.5/tick，无阻尼） */
const GHOST_FALL_Y = 15;
/** 快速下落（原版 doJumpDown：setVecY(5)→2.5/tick、setDamping(0,1)、jumpTimes 清零）。
 *  偏离：阻尼取 0（匀速 2.5/tick）而非 0.5——60Hz 下衰减使 vy 首 tick 即跌破
 *  穿平台阈值 FALL_LAND_SPEED(2.5)，快速下落会被平台吸附带拉回、无法穿落；
 *  原版 30fps 语境 vy=5 起步衰减 1，前数帧都在阈值上方，语义等价于穿落。 */
const FAST_FALL_VY = 5 * SPEED_PLUS;
const FAST_FALL_DAMP = 0;

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
    // 原版 goFrame(isPlay=true)：换标签重置 _renderMainAnimate=true 解冻。
    // 同名重设是 no-op——行走待机门每 tick 重设 走/站立 不能冲掉 stop 冻结
    f.mcHold = false;
  }
}

/** 站立待机标签（有 def 才维护）。
 * 落地 仅在播放中保护（刚落地不被覆盖）；播尽（endAction 在末帧调用）
 * 必须回 站立——偏离修正记录：曾无条件排除 落地，播尽后永远停在
 * 落地（循环外标签，animFrame 越界推进），行走标签维护曾以劫持方式
 * 掩盖此缺陷。 */
function idleLabel(f: FighterState, def: FighterDef | null): void {
  if (!def || f.actLabel === '站立') return;
  if (f.actLabel === '落地') {
    const r = def.labels['落地'];
    if (r && f.animFrame <= r.index + r.duration) return;
  }
  setLabel(f, def, '站立');
}

/** 回到普通状态（受击/倒地计时结束）。
 * 原版受击恢复回 站立 时 setAllAct 重填槽 + 恢复跳跃/空中攻击次数
 *（FighterMcCtrler idle("站立")：_action.jumpTimes = _fighter.jumpTimes 常量）。
 * 偏离修正记录：曾不重填槽——空中攻击/技被命中打断后槽保持清空，受击恢复
 * 回 站立（循环标签，endAction 不可达）→ 攻击/防御永久失效。 */
export function recoverToNormal(f: FighterState, def: FighterDef | null): void {
  f.actionState = ActionState.NORMAL;
  f.hurtTimer = 0;
  f.attackId = null;
  f.isAllowBeHit = true;
  f.beHitGap = 0;
  f.lastHurtHitId = null;
  f.lastDefHitId = null;
  if (f.onGround) {
    f.slots = defaultSlots(def);
    f.jumpTimes = JUMP_TIMES_START;
    f.airHitTimes = 1;
    idleLabel(f, def);
  } else {
    setLabel(f, def, '跳中');
  }
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
  // 原版 _action.clearAction()：动作边界清除 per-action 标志；
  // 重力恢复（原版 idle 链 setInAir/isApplyG=true——空中瞬步 applyG=false 在此复位）
  f.applyG = true;
  f.isCross = false;
  f.airMove = false;
  f.touchFloor = null;
  f.hurtAction = null;
  f.hitTarget = null;
  f.hitTargetChecker = null;
  // 抓取吸附不在此清除：moveTarget 的释放需恢复目标重力/击飞回拉（目标侧
  // 状态），由 sim.stepMoveTargets 的吸附活性巡检统一处理（攻击态结束即释放）
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

/**
 * 动作收招·原版语义（原版 endAct，FighterMcCtrler.as:449-457）：
 * 只清槽 + 清 per-action 标志 + 钢身关闭 + 释放抓取，**不动播放头、不换标签、
 * 不回位**——时间轴继续走到后续帧触发（如佐助招1：endAct@383 →
 * dampingPercent@384 → idle@389）或标签播尽（advanceAnimation 的 endAction
 * 常规路径）才收尾。
 *
 * 偏离修正记录：曾直接复用 endAction（回位/换标签）——招式 endAct 之后还有
 * 帧触发时，换标签跳走会让它们永远采样不到（佐助招1 阻尼失效 → 永久上飘）。
 * 原版此时置 FREEZE(40)（未接入），移植版以保持当前攻击态 + attackId 清空
 * 等价：意图门不再重入（槽已清）、判定不再结算（无 attackId）、能量门多开
 * 数帧（与原版 FREEZE 的差异，偏离记录）。
 */
export function endActAction(f: FighterState, def: FighterDef | null): void {
  f.attackId = null;
  f.slots = emptySlots(f.slots);
  f.steelBody = false;
  f.isCross = false;
  f.airMove = false;
  f.touchFloor = null;
  f.hurtAction = null;
  f.hitTarget = null;
  f.hitTargetChecker = null;
  // 开场语音门（intro 切片，原版 endAct 置 FREEZE(40)≠60 使 GameStartCtrler
  // 的等待通过）：INTRO_ING 期间的 endAct = 开场收招信号，回 NORMAL。
  // 其余状态保持现状（原版语义：endAct 不动播放头/不改攻击态）。
  if (f.actionState === ActionState.INTRO_ING) f.actionState = ActionState.NORMAL;
  void def;
}

/**
 * 开场语音动作（原版 FighterMcCtrler.sayIntro，intro 切片）：
 * 置 INTRO_ING 门 + 播 开场 标签；等待门由 intro 步进消费（actionState 离开
 * INTRO_ING 或离开 开场 标签 = 播完——endAct/idle/播尽 endAction 任一路径）。
 * @returns false = 缺 开场 标签，调用方跳过该步（原版此情形软锁，有意识偏离）
 */
export function sayIntro(f: FighterState, def: FighterDef | null): boolean {
  const range = def?.labels['开场'];
  if (!range) return false;
  f.actionState = ActionState.INTRO_ING;
  setLabel(f, def, '开场');
  return true;
}

/**
 * 起跳预约（原版 doJump：切 JUMP_ING + 起跳标签 + JUMP_DELAY_FRAME 延迟；
 * 延迟结束时才施加速度并消耗 jumpTimes——见 applyJumpLaunch）。
 * 二段跳门（原版 doJump：jumpTimes<=0 拒绝）：jumpTimes 耗尽不可跳。
 */
export function startJump(f: FighterState, def: FighterDef | null): boolean {
  if (f.jumpTimes <= 0) return false;
  f.actionState = ActionState.JUMP_ING;
  f.jumpDelay = JUMP_DELAY_GROUND;
  f.airHitTimes = 1;
  setLabel(f, def, f.slots.jump ?? '起跳');
  return true;
}

/** 空中跳（原版 doAirJump：延迟 1 帧后跳，消耗 jumpTimes；可取消空中攻击）。 */
export function startAirJump(f: FighterState, def: FighterDef | null): boolean {
  if (f.jumpTimes <= 0) return false;
  f.actionState = ActionState.JUMP_ING;
  f.jumpDelay = JUMP_DELAY_AIR;
  f.attackId = null;
  f.isCross = false;
  f.touchFloor = null;
  setLabel(f, def, f.slots.jump ?? '起跳');
  return true;
}

/** 起跳延迟结束（每 tick 由 sim 调用）：施加跳跃速度 + 消耗 jumpTimes。
 * 返回 true = 本 tick 离地。 */
export function applyJumpLaunch(f: FighterState, def: FighterDef | null): boolean {
  f.jumpDelay = 0;
  f.vy = jumpVelocity(def);
  f.dampY = JUMP_DAMPING;
  f.onGround = false;
  f.jumpTimes -= 1;
  return true;
}

/** 快速下落（原版 doJumpDown：↓+跳，jumpTimes 清零、穿平台下坠、触地续接 落地。
 * 原版 jumpDown 槽缺省为 null → 标签不变）。 */
export function startFastFall(f: FighterState, def: FighterDef | null): void {
  f.jumpTimes = 0;
  f.vy = FAST_FALL_VY;
  f.dampY = FAST_FALL_DAMP;
  f.attackId = null;
  f.isCross = false;
  void def;
  f.touchFloor = def?.labels['落地'] !== undefined ? '落地' : null;
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
  // 行走残速清理（修复批次 40）：原版行走 = 逐帧直接改 _x（BaseGameSprite.move），
  // 无速度概念，攻击起手天然静止；移植版行走并入 vx（插值渲染需要），起手须显式清。
  // 仅 NORMAL（站立/走）起手清：链段衔接（ATTACK_ING 内 setAttack → 砍3 惯性进砍4）
  // 与空中攻击（保留 vy 落势）不在其列。
  const wasNormal = f.actionState === ActionState.NORMAL;
  f.actionState = ActionState.ATTACK_ING;
  if (wasNormal) {
    f.vx = 0;
    f.dampX = 0;
  }
  f.attackId = actionId;
  f.actLabel = label;
  f.animFrame = range.index + 1;
  f.labelLock = 0;
  f.mcHold = false; // 原版 doAction → goFrame：开新动作解冻 stop 冻结
  // 原版 clearAction：新动作清除 per-action 标志
  f.isCross = false;
  f.airMove = false;
  f.touchFloor = null;
  f.hurtAction = null;
  f.hitTarget = null;
  f.hitTargetChecker = null;
  // 原版 doAction 先 _action.clearAction() 清空全部动作槽：动作播放中槽为空，
  // 再按攻击键不会重启动作（时间轴不被复位），连段只能等 setAttack 帧触发
  // 重填槽后派生。偏离修正记录：曾不清槽 + 兜底直接重启 k1，导致连按 J
  // 永远重复第一击、连段触发帧永远不可达。
  f.slots = emptySlots(f.slots);
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

/** 万解兜底判定（原版 checkDoWankai：槽缺失时允许 防御中 / 砍1 前 2 帧取消）。 */
function wanKaiFallbackLabel(
  f: FighterState,
  def: FighterDef | null,
  attackingAct: string,
): string | null {
  if (f.actLabel === '防御') return attackingAct;
  if (f.attackId === 'k1') {
    const range = def?.labels['砍1'];
    if (range && f.animFrame < range.index + 2) return attackingAct;
  }
  return null;
}

/** 万解候选标签（原版 checkDoWankai(action, attackingAct)）。 */
function checkWanKai(
  f: FighterState,
  def: FighterDef | null,
  slot: string | null,
  attackingAct: string,
): string | null {
  if (slot) return slot;
  return wanKaiFallbackLabel(f, def, attackingAct);
}

// —— 防御 / 瞬步 / 技 / 必杀 ——

/**
 * 进入防御（原版 doDefense → setDefenseAction → goFrame("防御", true, 3)）：
 * 停住 + 清槽仅留 防御中可发起的动作；动画播 3 帧后定格（advanceAnimation）。
 */
function doDefense(f: FighterState, def: FighterDef | null): void {
  f.actionState = ActionState.DEFENCE_ING;
  f.vx = 0;
  f.vy = 0;
  // 防御接管速度（修复批次 20）：行走的 dampX=0 所有权只在待机标签窗口生效，
  // 瞬步残速的 dampX 在防御冻结期不会衰减路径，须显式清零
  f.dampX = 0;
  f.dampY = 0;
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

/** 退出防御（原版 renderDefenseAnimate → goFrame("防御恢复",false,{call:idle,
 *  delay:1})：isPlay=false 播放头钉首帧，goFrameDelay 两 tick 后 idle 回站立）。
 *  labelLock=3 = T0/T1 两个冻结 tick + T2 转 站立（推进侧按 actLabel 分支处理）。
 *  偏离记录：解除前的 6 tick _defenseFrameDelay 计数仍按 POC 约定省略
 *  （响应性优先，有意偏离）；原版 站立 为 goFrame("站立",false) 静态单帧，
 *  移植版站立循环播放（待定项，见 docs/DESIGN）。 */
function exitDefense(f: FighterState, def: FighterDef | null): void {
  f.actionState = ActionState.NORMAL;
  // 防御恢复窗口内行走门不生效（labelLock + 非待机标签），残速阻尼在此清零
  f.vx = 0;
  f.dampX = 0;
  const land = def?.labels['防御恢复'];
  if (land) {
    f.actLabel = '防御恢复';
    f.animFrame = land.index + 1;
    f.labelLock = 3;
  }
}

/**
 * 瞬步（原版 doDash：能量 20 可透支；按住方向决定瞬步朝向；
 * DASH_ING 期间不可被命中；位移来自角色帧触发 dash/movePercent 系。
 * 空中瞬步 = doDashAir（jumpTimes≥1 + 能量 30 可透支，消耗 jumpTimes，
 * 免重力），原版 renderAirAction 分支）。
 */
function doDash(f: FighterState, def: FighterDef | null): void {
  if (f.onGround) {
    if (!canSpendEnergy(f, DASH_ENERGY_COST, true)) return;
    spendEnergy(f, DASH_ENERGY_COST);
    f.vy = 0;
    f.actionState = ActionState.DASH_ING;
    f.isAllowBeHit = false;
    f.attackId = null;
    setLabel(f, def, '瞬步');
    return;
  }
  // 空中瞬步（原版 doDashAir：jumpTimes < 1 拒绝）
  if (f.jumpTimes < 1) return;
  if (!canSpendEnergy(f, AIR_DASH_ENERGY_COST, true)) return;
  spendEnergy(f, AIR_DASH_ENERGY_COST);
  const label = f.slots.dash ?? '瞬步';
  const range = def?.labels[label];
  if (!range) return; // 原版 doAction 缺帧静默（能量照扣，与原版一致）
  f.actionState = ActionState.DASH_ING;
  f.isAllowBeHit = false;
  f.applyG = false;
  f.jumpTimes = 0;
  f.attackId = null;
  f.isCross = false;
  setLabel(f, def, label);
}

/**
 * 瞬身步（原版 startGhostStep/doGhostStep 系）：气 60（不可透支）+ 能量 80
 * （可透支）；面向目标；0.4s 免伤 + 穿越版边/免推挤；结束回位（endAction）
 * 并进入连续冷却（仅地面步受冷却门，原版 _isContinuousGhostStep）。
 * 类型：0 地面步（前向位移，走标签）/ 1 空中瞬跳（上向位移，jumpTimes-1，
 * 结束恢复剩余速度 + airMove）/ 2 空中速降（下向位移，触地即结束）。
 * 返回 false = 资源不足（不消费）。
 */
export function startGhostStep(
  f: FighterState,
  def: FighterDef | null,
  type: number,
  targetFacing: 1 | -1 | null,
): boolean {
  if (f.qi < GHOST_QI_COST) return false;
  if (!canSpendEnergy(f, GHOST_ENERGY_COST, true)) return false;
  f.qi -= GHOST_QI_COST;
  spendEnergy(f, GHOST_ENERGY_COST);
  if (targetFacing !== null) f.facing = targetFacing;
  f.ghostTicks = GHOST_TICKS;
  f.ghostType = type;
  f.isAllowBeHit = false;
  f.isCross = true;
  f.attackId = null;
  if (type === GHOST_GROUND) {
    f.actionState = ActionState.NORMAL;
    f.vy = 0;
    f.vx = GHOST_MOVE_X * SPEED_PLUS * f.facing;
    f.dampX = 0;
    f.dampY = 0;
    setLabel(f, def, '走');
  } else if (type === GHOST_AIR_JUMP) {
    f.actionState = ActionState.JUMP_ING;
    f.vx = 0;
    f.vy = GHOST_JUMP_Y * SPEED_PLUS;
    f.dampY = GHOST_JUMP_DAMP;
    f.jumpTimes -= 1;
    setLabel(f, def, '跳中');
  } else {
    f.actionState = ActionState.JUMP_ING;
    f.vx = 0;
    f.vy = GHOST_FALL_Y * SPEED_PLUS;
    f.dampY = 0;
    setLabel(f, def, '落');
  }
  return true;
}

/**
 * 瞬身步每 tick 推进（60Hz，sim 物理步调用；原版 renderGhostStep）。
 * 计时结束 / 空中速降触地 → 回位（endAction：恢复可命中/槽/重力/airMove）
 * + 结束表现事件 + 连续冷却（剩余 tick 数，仅地面步消费）。
 * @param endCb 结束回调（sim 内发 endGhostStep 事件）
 */
export function stepGhost(
  f: FighterState,
  def: FighterDef | null,
  endCb?: (f: FighterState) => void,
): void {
  if (f.ghostTicks <= 0) return;
  f.ghostTicks -= 1;
  const floorEnd = f.ghostType === GHOST_AIR_FALL && f.onGround;
  if (f.ghostTicks > 0 && !floorEnd) return;
  f.ghostCooldown = f.ghostTicks; // 原版 endGhostStep：剩余帧数即恢复延迟
  f.ghostTicks = 0;
  const wasAirJump = f.ghostType === GHOST_AIR_JUMP;
  f.ghostType = 0;
  endCb?.(f);
  endAction(f, def);
  if (wasAirJump) {
    // 原版 ghostType 1 结束：endGhostStep(idle) 之后再 setDamping(0,-vy/10)
    //（向上减速续飘）+ setAirMove(true)——顺序在回位之后，不被其清掉
    f.dampY = Math.abs(f.vy) * 0.05;
    f.airMove = true;
  }
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
  // 行走残速清理（同 startAttack，修复批次 40）
  const wasNormal = f.actionState === ActionState.NORMAL;
  f.actionState = superLevel ? ActionState.BISHA_SUPER_ING : ActionState.BISHA_ING;
  if (qiCost === 0) f.actionState = ActionState.SKILL_ING;
  if (wasNormal) {
    f.vx = 0;
    f.dampX = 0;
  }
  f.attackId = id; // 可为 null（标签存在但无动作表 → 有动画无判定）
  f.actLabel = label;
  f.animFrame = range.index + 1;
  f.labelLock = 0;
  f.mcHold = false; // 原版 doAction → goFrame：开新动作解冻 stop 冻结
  // 原版 clearAction：新动作清除 per-action 标志（同 startAttack，含清槽）
  f.isCross = false;
  f.airMove = false;
  f.touchFloor = null;
  f.hurtAction = null;
  f.hitTarget = null;
  f.hitTargetChecker = null;
  f.slots = emptySlots(f.slots);
  return true;
}

/** 万解进入（原版 doWanKaiAction：useQi(300) + WAN_KAI_ING + 不可命中）。 */
export function startWanKai(f: FighterState, def: FighterDef | null, label: string | null): boolean {
  const range = label !== null ? def?.labels[label] : undefined;
  if (!def || label === null || !range) return false;
  if (f.qi < WAN_KAI_QI) return false;
  f.qi -= WAN_KAI_QI;
  // 行走残速清理（同 startAttack，修复批次 40）
  const wasNormal = f.actionState === ActionState.NORMAL;
  f.actionState = ActionState.WAN_KAI_ING;
  if (wasNormal) {
    f.vx = 0;
    f.dampX = 0;
  }
  f.attackId = null;
  f.actLabel = label;
  f.animFrame = range.index + 1;
  f.labelLock = 0;
  f.mcHold = false; // 原版 doAction → goFrame：开新动作解冻 stop 冻结
  f.isAllowBeHit = false;
  // 原版 doAction + doWanKaiAction 的状态清理
  f.isCross = false;
  f.airMove = false;
  f.touchFloor = null;
  f.hurtAction = null;
  f.hitTarget = null;
  f.hitTargetChecker = null;
  return true;
}

/**
 * 万解形态切换（切片 10，原版 FighterCtrler.doWanKai(frame) 真实语义：
 * frame=0 → 根时间轴 nextFrame（下一形态）；frame>0 → 根时间轴绝对帧
 * gotoAndStop(frame)。切形态后 initMc 以 _doingWankai 复位：保持
 * WAN_KAI_ING，播新形态 开场 标签，播完经 endAction 回 NORMAL 并恢复可命中。
 * @param frame 0/缺省 = 下一形态；>0 = 按 def.rootFrame 寻址（无匹配 = 静默）
 * @returns 是否切换成功
 */
export function switchForm(
  f: FighterState,
  forms: readonly (FighterDef | null)[],
  frame: number,
): FighterDef | null {
  let next: FighterDef | null = null;
  if (frame <= 0) {
    next = forms[f.formIndex + 1] ?? null;
  } else {
    next = forms.find((d) => d !== null && d.rootFrame === frame) ?? null;
  }
  if (!next) return null;
  f.formIndex = forms.indexOf(next);
  f.slots = defaultSlots(next);
  f.attackId = null;
  f.isCross = false;
  f.airMove = false;
  f.touchFloor = null;
  f.hurtAction = null;
  f.hitTarget = null;
  f.hitTargetChecker = null;
  const opening = next.labels['开场'];
  if (opening) {
    f.actLabel = '开场';
    f.animFrame = opening.index + 1;
    f.mcHold = false; // 原版 initMc/goFrame：换形态重置时间轴解冻
  } else {
    // 无 开场 标签（合成 def/缺帧）：直接回位（原版假设全体有 开场）
    endAction(f, next);
  }
  return next;
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
 * 抓取判定（原版 allowCatch 子集）：目标活着且非受击硬直、双方 body 贴身
 * （间距 < 2px、|dy| < 1px）、自身面向目标。原版的下一帧位置预判依赖渲染
 * 顺序（isCheckedRender），移植版省略（2px 容差内影响极小，偏离记录）。
 */
export function allowCatch(
  f: FighterState,
  other: FighterState | null,
  def: FighterDef | null,
  otherDef: FighterDef | null,
): boolean {
  if (!other || other.hp <= 0 || other.actionState === ActionState.HURT_ING) {
    return false;
  }
  const selfBody = def ? currentBodyRect({ animFrame: f.animFrame, def }) : null;
  const tgtBody = otherDef ? currentBodyRect({ animFrame: other.animFrame, def: otherDef }) : null;
  if (!selfBody || !tgtBody) return false;
  const sb = worldRect(f, selfBody);
  const tb = worldRect(other, tgtBody);
  let disX: number;
  if (sb.x < tb.x) {
    if (f.facing < 0) return false;
    disX = tb.x - (sb.x + sb.w);
  } else {
    if (f.facing > 0) return false;
    disX = sb.x - (tb.x + tb.w);
  }
  const disY = Math.abs(f.y - other.y);
  return disX < 2 && disY < 1;
}

/**
 * 意图决策（每 tick，管线第 2 步调用）。
 * 检查顺序照原版 render()：万解（先于一切）→ 地面 renderFloorAction
 * （摔技 → 必杀系 → 砍技/招 → 攻击 → 防御 → 瞬身步 → 瞬步 → 跳/快速下落）→
 * 空中 renderAirAction（跳砍/跳招/空中必杀 → 二段跳 → 瞬身步/空中瞬步）。
 * 偏离：瞬身步在地面分支先于瞬步/跳检查（原版在末尾——我们分支提前 return，
 * 就近插入；语义差仅在同 tick 多输入边沿的取舍）；防御当 tick 发起后不接瞬身步；
 * 快速下落前置于防御（原版 doJumpDown 在 defense 之后但 _action.clear() 覆盖
 * 防御态——净效果等价，见地面分支注）。
 */
export function stepIntentsFor(
  f: FighterState,
  def: FighterDef | null,
  view: InputView,
  other: FighterState | null = null,
  otherDef: FighterDef | null = null,
): void {
  if (
    f.actionState === ActionState.DEAD ||
    f.actionState === ActionState.HURT_ING ||
    f.actionState === ActionState.HURT_FLYING ||
    f.actionState === ActionState.HURT_DOWN ||
    f.actionState === ActionState.HURT_ACT_ING ||
    f.actionState === ActionState.WAN_KAI_ING ||
    f.ghostTicks > 0 // 瞬身步期间意图封锁（原版 renderAnimate 提前返回）
  ) {
    return;
  }

  /** 面向目标（原版 startGhostStep 前的 setDirectToTarget；无目标保持朝向） */
  const faceTarget = (): 1 | -1 | null =>
    other !== null ? (f.x > other.x ? -1 : 1) : null;
  /** 瞬身步可用态（原版 allowGhostStep：必杀/万解除外；受击系已在上面拦掉） */
  const ghostUsable =
    f.actionState !== ActionState.BISHA_ING &&
    f.actionState !== ActionState.BISHA_SUPER_ING;
  /** 地面瞬身步额外受连续冷却门（原版 _isContinuousGhostStep 仅 doGhostStep 检查） */
  const ghostReady = ghostUsable && f.ghostCooldown <= 0;

  const down = view.held(Btn.down);
  const up = view.held(Btn.up);

  // —— 万解（原版 renderWanKaiCtrl：W→S→无修饰；attack+jump 同时按住；
  //     原版按住级检测，移植版过攻击/跳缓冲器（触发型统一） ——
  const wankaiPress =
    (view.buffered(Btn.attack) && view.held(Btn.jump)) ||
    (view.buffered(Btn.jump) && view.held(Btn.attack));
  if (wankaiPress) {
    const want = up
      ? checkWanKai(f, def, f.slots.wanKaiW, WAN_KAI_FALLBACK.up)
      : down
        ? checkWanKai(f, def, f.slots.wanKaiS, WAN_KAI_FALLBACK.down)
        : checkWanKai(f, def, f.slots.wanKai, WAN_KAI_FALLBACK.plain);
    if (want !== null && startWanKai(f, def, want)) {
      view.consume(Btn.attack);
      view.consume(Btn.jump);
      return;
    }
  }

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
    } else if (view.buffered(Btn.dash) && ghostReady) {
      // 防御中瞬身步脱离（原版防御分支不 return，末尾 ghost 检查可达）
      view.consume(Btn.dash);
      startGhostStep(f, def, GHOST_GROUND, faceTarget());
      return;
    }
    return;
  }

  if (f.onGround) {
    // 摔技（原版 renderFloorAction 首位：朝目标方向移动 + 攻击/技能键，
    // allowCatch 贴身判定；catch1=攻击键 catch2=技能键 → SKILL_ING）
    const movingTowardTarget =
      (f.facing === 1 && view.held(Btn.right)) || (f.facing === -1 && view.held(Btn.left));
    if (movingTowardTarget && allowCatch(f, other, def, otherDef)) {
      if (view.buffered(Btn.attack) && f.slots.catch1 !== null) {
        view.consume(Btn.attack);
        startSkill(f, def, f.slots.catch1, 0, false); // 原版 doCatch：SKILL_ING
        return;
      }
      if (view.buffered(Btn.skill) && f.slots.catch2 !== null) {
        view.consume(Btn.skill);
        startSkill(f, def, f.slots.catch2, 0, false);
        return;
      }
    }
    // 必杀系（superSkill ± 上/下；原版 bishaSUPER/bishaUP/bisha 顺序）。
    // 发起成功即返回（修复批次 20）：原版 doAction 内 clearAction 清空全部
    // 槽位（含 jump），后续 renderFloorAction 分支自然失效；移植版槽语义在
    // startSkill 内等价实现，但意图派发不返回会让缓冲的 ↑ 顺势触发
    // startJump 覆盖刚发起的必杀（上+必杀 = 起跳扣气，原版无此行为）。
    if (view.buffered(Btn.superSkill)) {
      if (down && f.slots.bishaSuper !== null) {
        view.consume(Btn.superSkill);
        if (startSkill(f, def, f.slots.bishaSuper, f.slots.bishaSuperQi, true)) return;
      } else if (up && f.slots.bishaUp !== null) {
        view.consume(Btn.superSkill);
        if (startSkill(f, def, f.slots.bishaUp, f.slots.bishaUpQi, false)) return;
      } else if (!up && !down && f.slots.bisha !== null) {
        view.consume(Btn.superSkill);
        if (startSkill(f, def, f.slots.bisha, f.slots.bishaQi, false)) return;
      }
    }
    // 攻击系（attack ± 上/下；原版 skill2/skill1/attack 顺序）。
    // 发起成功才消费缓冲：槽为空（动作播放中，原版 clearAction 语义）时不
    // 重启动作，缓冲留给 setAttack 帧触发重填槽后的连段派生。
    // 发起成功即返回（同必杀系：防止后续 技/跳 意图同 tick 覆盖）。
    if (view.buffered(Btn.attack)) {
      if (up && f.slots.skill2 !== null) {
        if (startAttackByLabel(f, def, f.slots.skill2)) {
          view.consume(Btn.attack);
          return;
        }
      } else if (down && f.slots.skill1 !== null) {
        if (startAttackByLabel(f, def, f.slots.skill1)) {
          view.consume(Btn.attack);
          return;
        }
      } else if (!up && !down && !view.held(Btn.jump) && f.slots.attack !== null) {
        if (startAttackByLabel(f, def, f.slots.attack)) {
          view.consume(Btn.attack);
          return;
        }
      }
    }
    // 技系（skill ± 上/下；原版 zhao3/zhao2/zhao1 顺序；发起成功即返回）
    if (view.buffered(Btn.skill)) {
      if (up && f.slots.zhao3 !== null) {
        view.consume(Btn.skill);
        if (startSkill(f, def, f.slots.zhao3, 0, false)) return;
      } else if (down && f.slots.zhao2 !== null) {
        view.consume(Btn.skill);
        if (startSkill(f, def, f.slots.zhao2, 0, false)) return;
      } else if (!up && !down && f.slots.zhao1 !== null) {
        view.consume(Btn.skill);
        if (startSkill(f, def, f.slots.zhao1, 0, false)) return;
      }
    }
    // 快速下落（原版 doJumpDown：↓+跳。原版代码序在 defense 之后但 doJumpDown
    // 以 _action.clear() 覆盖防御态——净效果 = 快速下落优先，故前置检查）。
    // 仅待机态可发起（修复批次 20：原版 jumpDown 槽被 clearAction 清空，
    // 动作播放中不可快速下落——否则缓冲的 ↓+跳 会覆盖进行中的动作）。
    if (down && view.buffered(Btn.jump) && f.actionState === ActionState.NORMAL) {
      view.consume(Btn.up);
      view.consume(Btn.jump);
      startFastFall(f, def);
      return;
    }
    // 防御（原版 defense() = down 按住；attack 优先级更高，上面已分流）
    if (down && f.actionState !== ActionState.ATTACK_ING && f.slots.attack !== null) {
      doDefense(f, def);
      return;
    }
    // 瞬身步（原版 doGhostStep：dash+↓，气 60+能量 80；先于瞬步/跳）。
    // 仅待机态可发起（修复批次 20：原版 ghost 槽被 clearAction 清空，动作中不可瞬身）
    if (view.buffered(Btn.dash) && down && ghostReady && f.actionState === ActionState.NORMAL) {
      view.consume(Btn.dash);
      if (startGhostStep(f, def, GHOST_GROUND, faceTarget())) return;
    }
    // 行走标签（物理仍由 sim 每 tick 施加）。
    // 偏离修正记录：曾无条件维护标签——dashStop 提前回 NORMAL 后瞬步时间轴
    // 还剩数帧（含 idle@帧N = setAllAct 重填槽），此时标签被劫持为 站立/走
    //（循环标签，播尽 endAction 不可达）→ 跳过 idle 与 endAction → 槽永久
    // 为空 → 攻击/防御永久失效。原版走/站立切换由 moveLeft/moveRight 槽驱动
    //（doMove：槽被 clearAction 清空的收尾窗口不处理移动输入），净语义 =
    // 只在标签已处于待机族（站立/走）时维护；动作收尾标签让时间轴自己走完。
    if (
      f.actionState === ActionState.NORMAL &&
      f.labelLock <= 0 &&
      (f.actLabel === '站立' || f.actLabel === '走')
    ) {
      const moving = view.held(Btn.left) || view.held(Btn.right);
      if (def) setLabel(f, def, moving ? '走' : '站立');
    }
    // 瞬步（原版在防御检查之后；dash() 门含 !down——↓ 按住时归瞬身步/防御）。
    // 仅待机态可发起（修复批次 20：原版 dash 槽被 clearAction 清空，动作中不可瞬步）
    if (view.buffered(Btn.dash) && !down && f.actionState === ActionState.NORMAL) {
      view.consume(Btn.dash);
      doDash(f, def);
      if ((f.actionState as number) === ActionState.DASH_ING) return;
    }
    // 跳跃（原版在移动之后；原版以 _action.jump 槽为门——槽被 clearAction
    // 清空后动作播放中不可跳。移植版 jump 槽 null=缺省 起跳，无法作门，
    // 以待机态门等价：否则缓冲的 ↑ 会在发起必杀/技的下一 tick 覆盖动作）
    if (
      (view.buffered(Btn.up) || view.buffered(Btn.jump)) &&
      f.actionState === ActionState.NORMAL
    ) {
      view.consume(Btn.up);
      view.consume(Btn.jump);
      startJump(f, def);
      return;
    }
  } else {
    // 空中（原版 renderAirAction：attackAIR/skillAIR/bishaAIR 槽，airHitTimes 门；
    // 门语义 = 有动作在身或剩余次数>0；动作消耗次数，跳起/触地重置）
    const canAirAct = f.airHitTimes > 0 || isAttackingState(f.actionState);
    if (view.buffered(Btn.attack)) {
      view.consume(Btn.attack);
      if (canAirAct && f.slots.attackAIR !== null) {
        f.airHitTimes -= 1;
        f.dampY += 1.5; // 原版 doAirAttack：addDamping(0,3)@30fps → 1.5/tick
        f.jumpTimes = 0; // 原版 doAirAttack：空中动作后不可再空中瞬步/跳
        startAttackByLabel(f, def, f.slots.attackAIR);
      }
    }
    if (view.buffered(Btn.skill)) {
      view.consume(Btn.skill);
      if (canAirAct && f.slots.skillAIR !== null) {
        const ok = startSkill(f, def, f.slots.skillAIR, 0, false);
        if (ok) {
          f.airHitTimes = 0; // 原版 doAirSkill：动作成立即耗尽
          f.jumpTimes = 0;
        }
      }
    }
    if (view.buffered(Btn.superSkill)) {
      view.consume(Btn.superSkill);
      if (
        canAirAct &&
        f.slots.bishaAIR !== null &&
        f.qi >= f.slots.bishaAIRQi &&
        startSkill(f, def, f.slots.bishaAIR, f.slots.bishaAIRQi, false)
      ) {
        f.airHitTimes = 0;
        f.jumpTimes = 0;
      }
    }
    // 二段跳（原版 doAirJump：jump justDown && !attack，jumpTimes 门，可取消空中攻击）
    if (view.buffered(Btn.jump) && !view.held(Btn.attack)) {
      view.consume(Btn.up);
      view.consume(Btn.jump);
      startAirJump(f, def);
      return;
    }
    // 瞬身步（空中：dash+↑ 瞬跳 / dash+↓ 速降）与空中瞬步（dash 无修饰）
    if (view.buffered(Btn.dash)) {
      view.consume(Btn.dash);
      const upHeld = view.held(Btn.up);
      const downHeld = view.held(Btn.down);
      if (upHeld && ghostUsable && startGhostStep(f, def, GHOST_AIR_JUMP, faceTarget())) {
        return;
      }
      if (downHeld && ghostUsable && startGhostStep(f, def, GHOST_AIR_FALL, faceTarget())) {
        return;
      }
      doDash(f, def); // 空中瞬步（原版 doDashAir；jumpTimes/能量门在内部）
      return;
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
 * loop 触发点查表（修复批次 30）：帧号恰好落在 target='mc' op='loop' 触发帧上
 * → 返回目标标签名（goFrame 无条件回卷语义）。数据侧审计（58 角色全量）：
 * 79 处 loop 触发无一与其它触发同帧、无一处于任何标签首帧 → 落点帧消费即可，
 * behaviors.loop 的采样分派路径实际不可达（触发帧永不采样）。
 */
function loopRedirectTarget(def: FighterDef, frame: number): string | null {
  for (const t of def.triggers) {
    if (t.target === 'mc' && t.op === 'loop' && t.frame === frame) {
      const name = t.args[0];
      if (typeof name === 'string' && def.labels[name]) return name;
    }
  }
  return null;
}

/**
 * 时间轴顺流目标（修复批次 20）：非循环攻击标签播尽时，若下一标签帧号连续
 * 且本标签范围内没有重定向触发（idle/setLabelTo），返回下一标签——原版 MC
 * 时间轴连续播放的自然结果。状态门：仅攻击态（isAttackingState）参与，
 * 站立/落地/起身/胜利/开场等状态标签的相邻关系（起身→开场、胜利→失败）
 * 不是动作续接，不滑入。防御定格到不了标签末尾，天然排除。
 */
function flowTarget(
  f: FighterState,
  def: FighterDef,
  label: string,
  range: LabelRange,
): [string, LabelRange] | null {
  if (!isAttackingState(f.actionState)) return null;
  const end = range.index + range.duration;
  for (const t of def.triggers) {
    if (
      t.target === 'mc' &&
      (t.op === 'idle' || t.op === 'setLabelTo' || t.op === 'loop') &&
      t.frame > range.index &&
      t.frame <= end
    ) {
      return null; // 时间轴脚本会在此前重定向，不应自然播尽
    }
  }
  for (const [name, r] of Object.entries(def.labels)) {
    if (r.index === end && !LOOP_LABELS.has(name)) return [name, r];
  }
  return null;
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
  // stop 冻结（原版 renderAnimate 的 _renderMainAnimate=false，修复批次 32）：
  // 播放头停住——不推进、帧脚本不重复触发（原版帧脚本只在播放头进入时执行
  // 一次），判定区钉在冻结帧；物理/状态计时照常。解冻见 setLabel（换标签）
  // 与各动作入口（原版 doAction → goFrame）。
  if (f.mcHold) return;
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
  let looped = false;
  // 本 tick 采样刚消费了 stop 触发（mcHold 置位）——播放头钉在冻结帧，
  // 与原版一致：stop 帧本身被采样/显示，下一 tick 起由入口处的 mcHold 门接管
  if (f.mcHold) return;
  if (range) {
    // 防御恢复冻结窗口（修复批次 30）：原版 goFrame("防御恢复",false,...,{call:idle,
    // delay:1})——isPlay=false 播放头钉在首帧不推进，goFrameDelay 两个动画 tick 后
    // 回调 idle → 站立。labelLock=3：T0/T1 两个冻结 tick 显示首帧，T2 转 站立。
    // POC 曾放完整段 防御恢复（labelLock=duration）→ 实测"卡一下"才回站立。
    if (label === '防御恢复') {
      if (f.labelLock > 0) return;
      // 转 站立 = 原版 goFrame delay 计满的 idle("站立") 回调：setAllAct 重填槽
      // + 恢复跳跃/空中攻击次数（修复批次 31：doDefense 清槽后无人重填——
      // 防御恢复→站立 走 setLabel 直转，站立为循环标签 endAction 不可达，
      // 槽永久为空 → 再按 ↓ 无法防御/普攻失效，与批 18 受击恢复同类缺陷）
      f.slots = defaultSlots(def);
      f.jumpTimes = JUMP_TIMES_START;
      f.airHitTimes = 1;
      setLabel(f, def, '站立');
      return;
    }
    // 防御定格（原版 goFrame("防御", true, 3) + FighterMC.renderAnimate：
    // 手动推进 3 帧后 _renderMainAnimate=false，时间轴停住，按住多久都静止；
    // 转向重播由 sim 的防御朝向分支重置 animFrame 实现）。防御不进 LOOP——
    // 冻结帧不会到达标签末尾，常规"播尽即 endAction"路径对防御不可达。
    if (
      label === '防御' &&
      f.actionState === ActionState.DEFENCE_ING &&
      f.animFrame >= range.index + DEFENSE_FREEZE_FRAMES
    ) {
      f.animFrame = range.index + Math.min(DEFENSE_FREEZE_FRAMES, range.duration);
    } else {
      f.animFrame += 1;
      // loop 触发点收编（修复批次 30）：原版时间轴脚本 loop(name) 在播放头进入
      // 触发帧时执行（FighterMcCtrler.loop → goFrame 无条件回卷），本 tick 显示的
      // 就是回卷落点帧（帧脚本在 nextFrame 期间执行，findBodyArea 用回卷后的帧）。
      // 移植版曾只靠 LOOP_LABELS 标签尾回卷 + behaviors.loop 走 setLabelTo
      // （同名不跳）→ 脚本循环点之后的死区帧被照常播放（鸣人形态1 走 24 帧里
      // 后 10 帧定格同一 png）→ 实测行走滑步。此处按落点帧消费 loop 触发；
      // 触发帧本身永不采样/显示（与原版一致：死区帧内容不被使用）。
      const loopTo = loopRedirectTarget(def, f.animFrame);
      if (loopTo !== null) {
        f.actLabel = loopTo;
        f.animFrame = def.labels[loopTo]!.index + 1;
        looped = true;
      }
    }
    // loop 重定向后不再做标签尾解析（落点帧属于目标标签，旧 range 已失效）
    if (!looped && f.animFrame > range.index + range.duration) {
      if (LOOP_LABELS.has(label!)) f.animFrame = range.index + 1;
      else {
        const chkName = `${label}_CHK`;
        const chk = def.labels[chkName];
        if (chk && chk.index === range.index + range.duration) {
          f.actLabel = chkName;
          f.animFrame = chk.index + 1;
        } else {
          // 时间轴顺流（修复批次 20）：原版 MC 时间轴在标签边界不停车，
          // 必杀(1帧桩)→空中必杀、上必杀→上必杀_1、招X_SP→招X 等共享段
          // 靠连续播放串联；曾以「播尽即 endAction」截断 → 佩恩等角色的
          // 地面必杀/上必杀只播桩帧就消失。顺流门（全部满足，否则回位）：
          // ① 攻击态（isAttackingState）——站立/落地/起身/胜利等状态标签不
          //   参与（起身→开场、胜利→失败 相邻误链）；跳跃族由 maintainAirLabel
          //   管辖；防御定格到不了标签末尾；
          // ② 结束标签范围内无重定向触发（idle/setLabelTo，target=mc）——
          //   靠时间轴脚本收尾的标签（如各角色 落地 内 idle@帧N）不滑入；
          // ③ 下一标签存在、帧号连续且非循环——滑入循环标签会让 endAction
          //   永不可达（卡死，参照批 18 教训）。
          // 顺流不改 actionState/attackId/槽位——攻击动作仍在进行，后续标签
          // 内的 endAct/idle 触发照常收招/回位。
          const flowed = flowTarget(f, def, label!, range);
          if (flowed) {
            f.actLabel = flowed[0];
            f.animFrame = flowed[1].index + 1;
          } else {
            endAction(f, def);
          }
        }
      }
    }
  }
}

/**
 * 落地状态转移（物理判定落地后调用；vy 已清零）。
 * 击飞落地 → 倒地（击飞_倒 → 起身 → NORMAL）；跳跃落地 → 落地恢复。
 * 跳跃次数落地即恢复（原版 touchFloor()：_action.jumpTimes = _fighter.jumpTimes
 * 常量重填；受击落地由 recoverToNormal 恢复）。偏离修正记录：曾只在初始
 * 状态置 JUMP_TIMES_START——双跳/空中瞬步/快速下落耗尽后落地永不恢复，
 * 角色永久无法起跳。
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
  // 非受击落地：跳跃次数一律重填（任何空中路径耗尽后落地都可再跳）
  f.jumpTimes = JUMP_TIMES_START;
  // 触地续接（原版 touchFloor()：setTouchFloor 预约的标签在触地时接管，
  // 普通跳跃落地同样消费；受击落地除外）
  if (f.touchFloor !== null && f.actionState !== ActionState.DEAD) {
    const tf = def?.labels[f.touchFloor];
    if (tf) {
      f.actLabel = f.touchFloor;
      f.animFrame = tf.index + 1;
      f.labelLock = 0;
      f.mcHold = false; // 原版 touchFloor() → goFrame：触地续接解冻 stop 冻结
      f.touchFloor = null;
      f.airHitTimes = 1; // 原版 touchFloor：空中攻击次数重置
      return;
    }
  }
  if (f.actionState === ActionState.JUMP_ING) {
    f.actionState = ActionState.NORMAL;
    f.dampY = 0;
    f.airHitTimes = 1;
    // 原版 touchFloor("落地") → doAction：clearAction 后 setAttack(delay 1)
    // 重填默认槽——上一动作（如空中攻击）清掉的槽在落地时恢复
    f.slots = defaultSlots(def);
    const land = def?.labels['落地'];
    if (land) {
      f.actLabel = '落地';
      f.animFrame = land.index + 1;
      f.labelLock = land.duration;
      f.mcHold = false; // 原版 touchFloor("落地") → goFrame：落地换标签解冻
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

  // 原版 doHurt：受击无敌窗（HURT_GAP_FRAME）+ 命中定义的重力开关（抓取吸附系 false）
  f.beHitGap = HURT_GAP_TICKS;
  f.isAllowBeHit = false;
  f.applyG = hit.isApplyG !== false; // 容错缺省（手写 def 兼容）

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

/**
 * 当前帧的命中区逐区解析（切片 10，原版 FighterMC.getCurrentHitSprite +
 * HitModel.getHitVOByDisplayName 语义）：每帧所有可解析出 HitDef 的判定区
 * 各自成为一个命中（区名精确匹配动作表，否则去 atm 后缀匹配）——多段动作
 * （如 摔1 时间轴内 sh1atm 抓取段 + sh12atm 摔地段）由此各段独立结算。
 * 非攻击状态 → 空。返回区（本地）+ 命中定义 + 解析出的动作 id。
 */
export interface HitZone {
  area: AreaRect;
  hit: HitDef;
  hitId: string;
}

export function currentHitZones(f: FighterState, def: FighterDef | null): HitZone[] {
  if (!isAttackingState(f.actionState) || !def) return [];
  const zones: HitZone[] = [];
  for (const area of currentAreas({ animFrame: f.animFrame, def })) {
    const hit = resolveZoneHit(def, area.name);
    if (hit) zones.push({ area, hit: hit.hit, hitId: hit.id });
  }
  return zones;
}

/** 原版 getHitVOByDisplayName：动作表精确名优先，否则去 atm 后缀查。 */
function resolveZoneHit(
  def: FighterDef,
  name: string,
): { hit: HitDef; id: string } | null {
  const exact = def.actions[name];
  if (exact) return { hit: exact, id: name };
  if (name.includes('atm')) {
    const id = name.replace('atm', '');
    const hit = def.actions[id];
    if (hit) return { hit, id };
  }
  return null;
}

/** 命中区 → 世界坐标（含朝向镜像）。 */
export function hitZonesWorld(
  f: FighterState,
  def: FighterDef | null,
): { rect: { x: number; y: number; w: number; h: number }; zone: HitZone }[] {
  return currentHitZones(f, def).map((zone) => ({
    rect: worldRect(f, zone.area),
    zone,
  }));
}

/** 动作槽类型再导出（sim 装配用）。 */
export type { FighterSlots };
