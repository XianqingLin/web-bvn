import { Btn, type InputView } from '../input.js';
import {
  PLAYFIELD_HALF_WIDTH,
  type FighterState,
  type StageState,
} from '../state.js';
import {
  ActionState,
  currentBodyRect,
  isAttackingState,
  SPEED_PLUS,
  worldRect,
} from '../fighter/def.js';
import {
  applyJumpLaunch,
  onLanded,
  stepGhost,
  walkSpeed,
} from '../fighter/machine.js';
import { slowDownScaleOf, stepToward, wake, type SimCtx } from './ctx.js';

// 物理帧常量（原版 BaseGameSprite/GameLogic 语义 × SPEED_PLUS=0.5，即
// 原版自己的 60fps 手感基准——见 DESIGN §3.1；空间容差类常量不乘系数）
//   重力斜坡：原版 applayG(12) 的 _g（原始空间）每帧 +G_ADD×SPEED_PLUS=0.6、
//   上限 12，位移 = _g×SPEED_PLUS → 60Hz 位移空间 = 步长 +0.3/tick、上限 6
//   （落到位移空间直接结算，不再乘系数——修复批次 19 修正：此前步长误减半成
//   0.6，下落加速比原版快 2 倍）；穿台阈值/吸附带/平台容差是空间量，保持原值
export const GRAVITY_START = 2;
export const GRAVITY_STEP = 0.3;
export const GRAVITY_CAP = 6;
const GROUND_SNAP_BAND = 12;
const FALL_LAND_SPEED = 2.5;
const LAND_TOLERANCE = 10;
/** 地面滑行摩擦（受击/倒地滑行衰减；POC 取义，原版按 HURT_DAMPING 结算） */
const GROUND_FRICTION = 0.9;

/**
 * 垂直落地判定，语义对照原版 GameLogic.isInAir（module-map §地图几何）。
 * 返回是否仍在空中（true 时调用方施加重力斜坡）：
 *   1. 上升（vy<0）不落地；
 *   2. 落到 groundY - GROUND_SNAP_BAND 之下 → 吸附主地面（优先于平台段）；
 *   3. 快速下落（vy ≥ FALL_LAND_SPEED）→ 穿过平台段（原版同规则：
 *      原版检查的是显式速度 _velocity.y，不含重力斜坡位移）；
 *   4. 其余情况：平台段 ±LAND_TOLERANCE 命中（x 在段内且 y 邻近）→ 吸附该平台。
 * 偏离原版：去掉 floor-contact 缓存——它只是性能优化，可观测行为不变
 * （缓存命中的条件与全量扫描等价）。
 */
export function resolveLanding(f: FighterState, stage: StageState): boolean {
  if (f.vy < 0) return true;
  if (f.y > stage.groundY - GROUND_SNAP_BAND) {
    f.y = stage.groundY;
    f.vy = 0;
    return false;
  }
  if (f.vy >= FALL_LAND_SPEED) return true;
  for (const fl of stage.floors) {
    if (
      f.x > fl.xFrom &&
      f.x < fl.xTo &&
      f.y > fl.y - LAND_TOLERANCE &&
      f.y < fl.y + LAND_TOLERANCE
    ) {
      f.y = fl.y;
      f.vy = 0;
      return false;
    }
  }
  return true;
}

// 3. 物理积分（行走 + 显式速度/阻尼 + 重力斜坡 + 多段地板落地 + 牵引边界）
// slowDown 全局慢放（切片 49）：位移/重力增量 ×scale（原版 move() ×speedPlus、
// applayG 增量 ×GameConfig.SPEED_PLUS——KO 链折算范式同款）；阻尼衰减不缩。
// 行走速度所有权式置 vx 后消费侧缩放，输入位移同步减慢。
// onlyId（切片 53）：幽步冻结期只积分该角色（原版 GameCtrler.pause +
// EffectCtrler.justRender 白名单——仅瞬身者 sp.render() 速度积分照跑，
// 其余实体停走；prop/道具/辅助物理/抓吸全部冻结）。undefined = 常规全量。
export function stepPhysics(ctx: SimCtx, views: InputView[], onlyId?: number): void {
  const { stage, fighters } = ctx.state;
  const slowScale = slowDownScaleOf(ctx.state);
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i]!;
    if (onlyId !== undefined && f.id !== onlyId) continue;
    const view = views[i]!;
    const def = ctx.defOf(f);
    const wasAirborne = !f.onGround;
    // 瞬身步推进（原版 renderGhostStep；结束回位/恢复速度/发事件）
    stepGhost(f, def, (g) => {
      ctx.emit('effect', {
        id: 'endGhostStep',
        x: g.x,
        y: g.y,
        params: { owner: g.id, ownerKind: 'fighter' },
      });
    });
    // 行走：地面 NORMAL（原版 renderFloorAction）或空中 airMove（原版
    // renderAirAction → doAirMove：空中左右同移速直接位移，攻击中同样生效，
    // 不受标签门约束；脚本化位移/受击时 airMove 已被清除）；
    // 瞬身步期间速度由瞬身步驱动（原版画面冻结期不受输入）。
    // 地面行走仅在待机标签族（站立/走）且无标签锁时施加（修复批次 20）：
    // 原版移动由 moveLeft/moveRight 槽驱动（doMove→goFrame("走")），落地/
    // 收招等收尾标签期间槽已清空、输入不产生位移；移植版曾只按状态门，
    // 落地 labelLock 窗口内持续置 vx → 站立姿势原地滑步（实测批 20 之一）。
    // 偏离修正记录（2026-11-19）：此前空中（除飞行系）完全忽略水平输入——
    // 原版起跳即 airMove=true 可全程空中操控。
    if (
      (f.onGround || (f.airMove && f.hp > 0 && f.ghostTicks === 0)) &&
      (f.onGround
        ? f.actionState === ActionState.NORMAL &&
          f.hp > 0 &&
          f.ghostTicks === 0 &&
          (def === null ||
            f.actLabel === null || // 出生首帧未采样（advanceAnimation 首轮才置 站立）
            (f.labelLock <= 0 && (f.actLabel === '站立' || f.actLabel === '走')))
        : f.actionState !== ActionState.HURT_FLYING)
    ) {
      let dir = 0;
      if (view.held(Btn.left)) dir -= 1;
      if (view.held(Btn.right)) dir += 1;
      // speedUp buff（切片 12）：平加值随移速（原版 speed 属性 + buff 值）
      f.vx = dir * (walkSpeed(def) + (f.buffs.speedUp?.value ?? 0) * SPEED_PLUS);
      // 走路拥有水平速度所有权（切片 13 修复）：原版走路不经 _velocity
      //（renderFloorAction 直改 _x），dashStop 残留的 damping 只衰减冲刺残速、
      // 不会饿死走路；移植版统一进 vx 后必须在此清 dampX，否则瞬步收势
      // 的 dampX=|vx|×p 永不复位 → 落地后行走速度每帧被 wake 清零（角色冻结）。
      f.dampX = 0;
    } else if (
      f.onGround &&
      (f.actionState === ActionState.HURT_ING ||
        f.actionState === ActionState.HURT_DOWN ||
        f.actionState === ActionState.DEAD)
    ) {
      // 地面滑行摩擦（仅受击/倒地/死亡；瞬步/防御速度走自身衰减或置零）
      f.vx = wake(f.vx, GROUND_FRICTION);
    }
    // 速度线性衰减（原版 renderVelocity + KyoUtils.num_wake）
    f.vx = wake(f.vx, f.dampX);
    f.vy = wake(f.vy, f.dampY);
    f.x += f.vx * slowScale;
    f.y += f.vy * slowScale;
    const airborne = resolveLanding(f, stage);
    if (airborne) {
      // 重力斜坡（原版 applayG(12)：上升段清零；下落段每 tick 递增后施为位移；
      // isApplyG=false（飞行系）不施加重力）
      if (!f.applyG) {
        // 悬停：无重力位移
      } else if (f.vy < 0) {
        f.gRamp = 0;
      } else {
        f.gRamp = Math.min(f.gRamp + GRAVITY_STEP * slowScale, GRAVITY_CAP);
        f.y += f.gRamp * slowScale;
      }
      f.onGround = false;
    } else {
      // 落地瞬间预置下次离地的初值（原版 setInAir(false) → _g=4）
      f.gRamp = GRAVITY_START;
      if (wasAirborne) {
        onLanded(f, def);
        // 落地尘土（原版 FighterMcCtrler.touchFloor :1059 → effectCtrler.touchFloor
        // → XG_luodi，控制器级无条件触发）。击飞系落地尘土/震屏（hit_floor 系列）
        // 由 stepHurtFly 三段式子状态机在转换点发出（切片 54，原版 renderHurtFly）。
        // 事件 id 用 'touchFloor' 与时间轴 emit 同键，渲染层按 tick+id 去重防双播。
        if (
          f.actionState === ActionState.NORMAL ||
          f.actionState === ActionState.JUMP_ING
        ) {
          ctx.emit('effect', { id: 'touchFloor', x: f.x, y: f.y, params: {} });
        }
      }
      f.onGround = true;
    }
    // 起跳延迟（原版 renderJumpAnimate：延迟计满才施加跳跃速度并消耗
    // jumpTimes——放在积分后，首个上升位移出现在下一 tick）
    if (f.jumpDelay > 0) {
      f.jumpDelay -= 1;
      if (f.jumpDelay === 0) applyJumpLaunch(f, def);
    }
  }
  if (onlyId !== undefined) {
    // 幽步冻结：其余实体停走（原版未白名单者不 render），牵引边界仍对瞬身者
    // 施加（原版 justRender 后 GameLogic.fixGameSpritePosition 只修白名单者）
    clampPlayfield(ctx, onlyId);
    return;
  }
  // 飞行道具推进（原版 Bullet.render：每 tick 位移/加速/钳制/寿命/出界）
  ctx.stepBullets();
  // 独立道具推进（原版 FighterAttacker.render：follow 重定位/重力/寿命占位）
  ctx.stepAttackers();
  // 辅助实体推进（原版 BaseGameSprite 物理 × SPEED_PLUS + 重力斜坡；切片 12）
  ctx.stepAssisterPhysics();
  // 抓取吸附施加（原版 FighterMC.moveTarget：把目标吸向自身锚点）
  stepMoveTargets(ctx);
  // 牵引边界：版边 = 两角色中点 ± PLAYFIELD_HALF_WIDTH，clamp 到地图边界。
  // 相机不进模拟（契约硬规则 5）。
  clampPlayfield(ctx);
}

/**
 * 抓取吸附每 tick 施加（原版 FighterMC.moveTarget）：把目标吸向自身锚点
 * （followmc 判定区中心，偏离：原版取子对象注册点，不可得）。
 * speed 为 0 直接吸附。吸附仅在攻击状态期间有效——攻击结束（endAct/受击/
 * 回位）即释放并恢复目标重力（原版 clearAction 清 moveTarget；machine 不清，
 * 由本巡检统一释放，见 machine.endAction 注）。
 */
function stepMoveTargets(ctx: SimCtx): void {
  const { fighters } = ctx.state;
  for (const g of fighters) {
    const p = g.moveTarget;
    if (p === null) continue;
    if (!isAttackingState(g.actionState)) {
      releaseGrab(ctx, g);
      continue;
    }
    const t = fighters.find((o) => o.id !== g.id) ?? null;
    if (t === null) continue;
    let ax = g.x;
    let ay = g.y;
    if (p.followmc !== null) {
      const def = ctx.defOf(g);
      const area = def
        ? (def.areas[g.animFrame] ?? []).find((r) => r.name === p.followmc)
        : null;
      if (area) {
        ax = g.x + (area.x + area.w / 2) * g.facing;
        ay = g.y + area.y + area.h / 2;
      }
    }
    t.x = stepToward(t.x, ax, p.speedX);
    t.y = stepToward(t.y, ay, p.speedY);
  }
}

/** 释放抓取（原版 moveTarget 清除分支：恢复目标重力，击飞中 y 回拉）。 */
export function releaseGrab(ctx: SimCtx, g: FighterState): void {
  g.moveTarget = null;
  const t = ctx.state.fighters.find((o) => o.id !== g.id) ?? null;
  if (t !== null) {
    t.applyG = true;
    if (t.actionState === ActionState.HURT_FLYING) t.y -= 5;
  }
}

function clampPlayfield(ctx: SimCtx, onlyId?: number): void {
  const { stage, fighters } = ctx.state;
  if (fighters.length === 2) {
    const [a, b] = fighters as [FighterState, FighterState];
    const mid = (a.x + b.x) / 2;
    let left = mid - PLAYFIELD_HALF_WIDTH;
    let right = mid + PLAYFIELD_HALF_WIDTH;
    if (left < stage.leftBound) {
      right += stage.leftBound - left;
      left = stage.leftBound;
    }
    if (right > stage.rightBound) {
      left -= right - stage.rightBound;
      right = stage.rightBound;
    }
    left = Math.max(left, stage.leftBound);
    right = Math.min(right, stage.rightBound);
    for (const f of fighters) {
      if (onlyId !== undefined && f.id !== onlyId) continue;
      f.x = Math.min(Math.max(f.x, left), right);
    }
  }
}

// 4. 推挤：body AABB 重叠时按 heavy 系数互推（原版 checkBodyHit 最小子集）
export function stepPush(ctx: SimCtx): void {
  const { stage, fighters } = ctx.state;
  if (fighters.length !== 2) return;
  const [a, b] = fighters as [FighterState, FighterState];
  const defA = ctx.defOf(a);
  const defB = ctx.defOf(b);
  if (!defA || !defB) return;
  if (
    a.hp <= 0 ||
    b.hp <= 0 ||
    a.actionState === ActionState.HURT_FLYING ||
    b.actionState === ActionState.HURT_FLYING ||
    a.isCross ||
    b.isCross // 原版 checkBodyHit：穿越态（瞬步）不参与推挤
  ) {
    return;
  }
  const bodyA = currentBodyRect({ animFrame: a.animFrame, def: defA });
  const bodyB = currentBodyRect({ animFrame: b.animFrame, def: defB });
  if (!bodyA || !bodyB) return;
  const ra = worldRect(a, bodyA);
  const rb = worldRect(b, bodyB);
  const overlapX =
    Math.min(ra.x + ra.w, rb.x + rb.w) - Math.max(ra.x, rb.x);
  const overlapY =
    Math.min(ra.y + ra.h, rb.y + rb.h) - Math.max(ra.y, rb.y);
  if (overlapX <= 0 || overlapY <= 0) return;
  const total = defA.heavy + defB.heavy;
  const shareA = defB.heavy / total; // 越重挪得越少
  const shareB = defA.heavy / total;
  if (a.x <= b.x) {
    a.x -= overlapX * shareA;
    b.x += overlapX * shareB;
  } else {
    a.x += overlapX * shareA;
    b.x -= overlapX * shareB;
  }
  // 推挤后仍受地图边界约束（原版版边卡住由对方承担全部位移，POC 简化为 clamp）
  for (const f of [a, b]) {
    f.x = Math.min(Math.max(f.x, stage.leftBound), stage.rightBound);
  }
}
