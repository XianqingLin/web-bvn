import { Btn, type InputView } from '../input.js';
import {
  ActionState,
  worldRect,
  type FighterDef,
  type HitDef,
} from '../fighter/def.js';
import { recoverToNormal, spendEnergy } from '../fighter/machine.js';
import type { FighterState } from '../state.js';
import { type SimCtx } from './ctx.js';

// —— 受击被动：替身 replaceSkill（comicType==1）/ 灵压爆发 energyExplode（切片 55） ——
//
// 原版语义（FighterMcCtrler.renderHurtBreak / isCanHurtBreak + FighterMain）：
//   触发门（每动画帧在 HURT_ING 硬直期间轮询）：
//     _hurtBreakFrame>0 挡重入；hasEnergy(50)（无透支）；qi>=100；
//     最后一击非必杀（getLastHurtHitVO().isBisha）；链内无破防（hurtBreakHit）；
//     链伤害 <=210（currentHurtDamage）；辅助键按住（specailSkill）。
//   消耗：useQi(100) + useEnergy(100)（门是 50 但消耗 100——照搬，常态透支）+
//     _hurtBreakFrame=5 + _usedPassiveCdFrame=5（屏蔽辅助召唤）。
//   分流：comicType==1 → replaceSkill；否则 energyExplode。
//
// 演出冻结（EffectCtrler.replaceSkill/energyExplode → GameCtrler.pause）：全场
//   停走（无 justRender 白名单，施法者时间轴也冻结），倒计时按实时间递减——
//   port 进 SimState.passiveFreeze，tick 管线早退（同 freezeTicks 范式），
//   渲染层按快照差分驱动黑幕/地图隐藏/演出特效。

/** 替身演出冻结（原版 _replaceSkillFrameHold = FPS_GAME/3 = 20 渲染帧） */
export const PASSIVE_REPLACE_FREEZE_TICKS = 20;
/** 爆发演出冻结（原版 _explodeSkillFrame = 0.7×FPS_GAME = 42 渲染帧） */
export const PASSIVE_EXPLODE_FREEZE_TICKS = 42;
/** 替身残效（原版 HURT_SKILL_FRAME_NARUTO=30 动画帧：α0.5 + 免伤） */
const REPLACE_SKILL_TICKS = 30;
/** 爆发命中窗（原版 _explodeHitFrame=10；<8 且 >0 时命中区生效） */
const EXPLODE_HIT_TICKS = 10;
/** 爆发钢身残效（原版 HURT_SKILL_FRAME_BLEACH=60 动画帧） */
const EXPLODE_STEEL_TICKS = 60;
/** 被动触发冷却（原版 _hurtBreakFrame=5 动画帧） */
const HURT_BREAK_CD_TICKS = 5;
/** 被动后辅助召唤屏蔽（原版 _usedPassiveCdFrame=5 动画帧） */
const USED_PASSIVE_CD_TICKS = 5;
/** 替身瞬移距离（原版 moveToTarget(200, 0)） */
const REPLACE_MOVE_X = 200;
/** 爆发命中区（原版 new Rectangle(-100,-200,200,210) → getCurrentRect 定死） */
const EXPLODE_AREA = { name: 'explode', x: -100, y: -200, w: 200, h: 210 };
/** 爆发命中定义（原版 HitVO() 缺省 + power=50/hitx=15/hitType=5/hurtType=1） */
export const EXPLODE_HIT_DEF: HitDef = {
  power: 50,
  hitx: 15,
  hity: 0,
  hitType: 5, // MAGIC_HEAVY
  hurtTime: 300,
  hurtType: 1,
  isBreakDef: false,
  isApplyG: true,
};

/**
 * 被动触发轮询（管线第 2 步 stepIntents 逐角色调用；原版 renderHurt →
 * renderHurtBreak 每动画帧——port 提前到 60Hz 意图层轮询，偏离记录：
 * 级联条件在相邻 tick 内不变，仅响应提前半动画帧）。
 */
export function stepHurtBreak(
  ctx: SimCtx,
  f: FighterState,
  def: FighterDef | null,
  view: InputView,
  other: FighterState | null,
): void {
  if (f.actionState !== ActionState.HURT_ING || f.hp <= 0) return;
  if ((f.hurtBreakCd ?? 0) > 0) return;
  // 原版 hasEnergy(50)（无透支参数）+ qi>=100；消耗 100（常态透支，照搬）
  if (f.energy < 50 || f.qi < 100) return;
  const chain = f.hurtChain;
  // 原版 isCanHurtBreak：bisha 只看最后一击；breakDef/伤害看整链
  if (chain !== undefined && (chain.bisha || chain.breakDef || chain.damage > 210)) {
    return;
  }
  // 原版 specailSkill() = 辅助键按住（非边沿）
  if (!view.held(Btn.assist)) return;
  // port 偏离：consume 边沿防输入缓冲泄漏——justDown+缓冲语义下，受击期
  // 按辅助触发的边沿若不清，恢复后 6 帧缓冲窗内会误召唤辅助
  view.consume(Btn.assist);
  f.qi -= 100;
  spendEnergy(f, 100);
  f.hurtBreakCd = HURT_BREAK_CD_TICKS;
  f.usedPassiveCd = USED_PASSIVE_CD_TICKS;
  if (f.comicType === 1) replaceSkill(ctx, f, def, other);
  else energyExplode(ctx, f);
}

/** 替身（原版 FighterMain.replaceSkill）：瞬移目标旁 + 回血 + 回站立 + 残效免伤。 */
function replaceSkill(
  ctx: SimCtx,
  f: FighterState,
  def: FighterDef | null,
  other: FighterState | null,
): void {
  // 演出事件：预瞬移点（EffectCtrler.replaceSkill 存 target.x/y 后才 moveToTarget）
  ctx.emit('effect', { id: 'replaceSkill', x: f.x, y: f.y, params: { owner: f.id } });
  if (other !== null) {
    // 原版 moveToTarget(200, 0)：目标旁 200px + 版边镜像防穿帮，y 吸附目标，
    // 面向目标（setDirectToTarget 同义）
    let fx = other.x + REPLACE_MOVE_X * f.facing;
    if (other.x < REPLACE_MOVE_X) fx = other.x + REPLACE_MOVE_X;
    else if (other.x > ctx.state.stage.rightBound - REPLACE_MOVE_X) {
      fx = other.x - REPLACE_MOVE_X;
    }
    f.x = fx;
    f.y = other.y;
    f.facing = f.x < other.x ? 1 : -1;
  }
  // 回血（原版 addHp(hurtHit.getDamage())：最近一击 power×powerRate，clamp hpMax）
  if ((f.lastHurtDamage ?? 0) > 0) {
    f.hp = Math.min(f.hpMax, f.hp + f.lastHurtDamage!);
  }
  f.vx = 0;
  f.vy = 0;
  // 原版 idle()：回站立 + setAllAct + clearHurtHits（recoverToNormal 同收口）
  recoverToNormal(f, def);
  f.isAllowBeHit = false;
  f.replaceTicks = REPLACE_SKILL_TICKS;
  ctx.state.passiveFreeze = {
    kind: 'replace',
    ownerId: f.id,
    ticksLeft: PASSIVE_REPLACE_FREEZE_TICKS,
  };
}

/** 灵压爆发（原版 FighterMain.energyExplode）：定身 + 钢身 + 定点命中窗。 */
function energyExplode(ctx: SimCtx, f: FighterState): void {
  f.vx = 0;
  f.vy = 0;
  // 演出事件：原版 EffectCtrler.energyExplode（黑幕/地图隐藏 + explodeSp）
  ctx.emit('effect', { id: 'startEnergyExplode', x: f.x, y: f.y, params: { owner: f.id } });
  f.steelBody = true;
  // 命中区触发瞬间世界坐标定死（原版 getCurrentRect 缓存，不动随人；
  // 击退方向基准 = 触发时朝向，原版 hitx=15*direct 同语义）
  f.explodeHit = { ...worldRect(f, EXPLODE_AREA), facing: f.facing };
  f.explodeHitTicks = EXPLODE_HIT_TICKS;
  f.explodeSteelTicks = EXPLODE_STEEL_TICKS;
  f.isAllowBeHit = false;
  ctx.state.passiveFreeze = {
    kind: 'explode',
    ownerId: f.id,
    ticksLeft: PASSIVE_EXPLODE_FREEZE_TICKS,
  };
}

/**
 * 被动残效计时（管线第 5 步 stepAnimation 逐角色调用，30Hz——原版
 * FighterMain.renderAnimate 帧计数同律）。
 * 偏离记录：原版 isAllowBeHit=false 期间命中排除由 getCurrentHits/checkHit
 * 隐式保证；port 由 stepHitResolution 的 isAllowBeHit 门消费，语义一致。
 */
export function stepPassiveTimers(f: FighterState, def: FighterDef | null): void {
  // 爆发命中窗（原版 _explodeHitFrame：==8 → idle()+免伤；<=0 → VO=null+恢复）
  if (f.explodeHitTicks !== undefined && f.explodeHitTicks > 0) {
    f.explodeHitTicks -= 1;
    if (f.explodeHitTicks === 8) {
      recoverToNormal(f, def); // 原版 idle()
      f.isAllowBeHit = false;
    }
    if (f.explodeHitTicks <= 0) {
      f.explodeHitTicks = undefined;
      f.explodeHit = undefined;
      f.isAllowBeHit = true;
    }
  }
  if (f.usedPassiveCd !== undefined) {
    f.usedPassiveCd -= 1;
    if (f.usedPassiveCd <= 0) f.usedPassiveCd = undefined;
  }
  // 爆发钢身残效（原版 _explodeSteelFrame：每帧重申钢身；被击飞即清）
  if (f.explodeSteelTicks !== undefined && f.explodeSteelTicks > 0) {
    f.explodeSteelTicks -= 1;
    f.steelBody = true; // 原版 setSteelBody(true, true) 每帧重申
    if (
      f.actionState === ActionState.HURT_FLYING ||
      f.actionState === ActionState.HURT_DOWN ||
      f.actionState === ActionState.HURT_DOWN_TAN
    ) {
      f.explodeSteelTicks = 0;
    }
    if (f.explodeSteelTicks <= 0) {
      f.explodeSteelTicks = undefined;
      f.steelBody = false;
    }
  }
  // 替身残效（原版 _replaceSkillFrame：α0.5 + 免伤；到期恢复）——alpha 消费
  // 在渲染层（replaceTicks>0 → α0.5），此处只管免伤与计时
  if (f.replaceTicks !== undefined && f.replaceTicks > 0) {
    f.replaceTicks -= 1;
    f.isAllowBeHit = false;
    if (f.replaceTicks <= 0) {
      f.replaceTicks = undefined;
      f.isAllowBeHit = true;
    }
  }
  if (f.hurtBreakCd !== undefined) {
    f.hurtBreakCd -= 1;
    if (f.hurtBreakCd <= 0) f.hurtBreakCd = undefined;
  }
}
