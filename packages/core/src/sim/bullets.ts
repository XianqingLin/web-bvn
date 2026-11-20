import { SPEED_PLUS, worldRect } from '../fighter/def.js';
import type { BulletState } from '../state.js';
import type { BulletSpawnSpec } from '../fighter/behaviors.js';
import type { AssistBulletSpawnSpec } from '../fighter/assister.js';
import { slowDownScaleOf, type SimCtx } from './ctx.js';

/**
 * 飞行道具每 tick 推进（原版 Bullet.render）。
 * 风场弹速级（B4 temari）：原版 fuutonFunc 每动画帧对所有敌方弹写
 * sp.speedLevel = level × direct（direct = sp.direct==selfDirect ? -1:1，
 * 即同向 -level 加速、逆风 level 减速），位移乘 (1−speedLevel)。
 * 移植为**派生值**：步进时按在场风场辅助求值，不逐弹存储——多辅助同场
 * 按 id 序后者覆盖（= 原版单槽函数的寄存器覆写序）；偏离记录：风场期间
 * 生成的弹体即刻受风（原版 ≤2 动画帧延迟），辅助提前退场（owner 死亡）
 * 时弹体立即恢复常速（原版最后一次覆写值泄漏至弹体消失——视为原版缺陷
 * 修正，见 DESIGN §3.5 风场段）。
 */
export function stepBullets(ctx: SimCtx): void {
  const { stage, bullets, assisters } = ctx.state;
  // slowDown 全局慢放（切片 49）：弹位移/加速 ×scale（原版 Bullet 位移与
  // addSpeed 增量均 ×_speedPlus；寿命 holdTicks 每帧递减不缩）
  const slowScale = slowDownScaleOf(ctx.state);
  const removed: number[] = [];
  for (const b of bullets) {
    // 命中残留段（原版 _isHit → render 早退）：停移动，仅时间轴推进
    if (b.hitAnim) continue;
    // 风场弹速级求值（同队跳过 = 原版 isSelfTeam 守卫；2P 模型 team id = fighter id）
    let speedLevel = 0;
    for (const a of assisters) {
      const cf = a.customFunc;
      if (cf === null || cf.kind !== 'windField') continue;
      if (b.ownerId === a.ownerId) continue;
      speedLevel = cf.level * (b.facing === cf.direct ? -1 : 1);
    }
    // 位移（局部空间速度；x 沿发射朝向，乘风场弹速级系数）+ 加速（add×2×SPEED_PLUS = add/tick）
    b.x += b.sx * SPEED_PLUS * b.facing * (1 - speedLevel) * slowScale;
    b.y += b.sy * SPEED_PLUS * slowScale;
    b.sx += b.addX * slowScale;
    b.sy += b.addY * slowScale;
    // 局部空间钳制（朝向镜像后两方向语义一致：sx∈[minX,maxX]，见 state.ts 注）
    if (b.sx > b.maxX) b.sx = b.maxX;
    if (b.sx < b.minX) b.sx = b.minX;
    if (b.sy > b.maxY) b.sy = b.maxY;
    if (b.sy < b.minY) b.sy = b.minY;
    // 寿命（原版 holdFrame 递减至 0 → 有 timeout 标签跳 timeout 段续播至
    // 时间轴播尽移除，无标签立即移除；_isTimeout 后不再递减）
    if (b.holdTicks >= 0 && --b.holdTicks <= 0) {
      const timeoutFrame = b.animLabels['timeout'];
      if (b.animTotal > 0 && timeoutFrame !== undefined) {
        b.animFrame = timeoutFrame;
        b.holdTicks = -1;
        continue;
      }
      removed.push(b.id);
      continue;
    }
    // 出界（原版 GameLogic.isOutRange：边界 ±20；bullet allowCrossMapXY 可越界飞行）
    if (
      b.x > stage.rightBound + 20 ||
      b.x < stage.leftBound - 20 ||
      b.y > stage.bottomY + 20
    ) {
      removed.push(b.id);
    }
  }
  if (removed.length > 0) removeBullets(ctx, removed);
}

/**
 * 飞行道具动画推进（原版 Bullet.renderAnimate，30Hz；切片 13-A3）。
 *
 * 原版语义：mc.nextFrame() 后按 currentLabel（≤当前帧的最近标签）分派——
 * loop→回跳 loop_start（无则帧 1）；remove→移除；hit_over→停止命中；
 * 其余：currentFrame == totalFrames-1 → 移除（原版 off-by-one 原样保留，
 * 1 帧元件永不自动移除）。命中残留段（hitAnim）继续推进至播尽——
 * entity:despawn 时机即残留结束（渲染层随之收尾）。
 */
export function stepBulletAnim(ctx: SimCtx): void {
  const { bullets } = ctx.state;
  const removed: number[] = [];
  for (const b of bullets) {
    if (b.animTotal <= 0) continue;
    // 推进（到尾停住：原版 nextFrame 在末帧滞留，播尽判定见下）
    if (b.animFrame < b.animTotal) b.animFrame += 1;
    // currentLabel = 起始帧 ≤ 当前帧的最近标签
    let label: string | null = null;
    let labelFrame = 0;
    for (const [name, start] of Object.entries(b.animLabels)) {
      if (start <= b.animFrame && start >= labelFrame) {
        // 同帧多标签按字典序稳定取（同帧多标签语料不存在；确定性优先）
        if (start === labelFrame && (label === null || name < label)) continue;
        label = name;
        labelFrame = start;
      }
    }
    switch (label) {
      case 'loop':
        b.animFrame = b.animLabels['loop_start'] ?? 1;
        break;
      case 'remove':
        removed.push(b.id);
        break;
      case 'hit_over':
        b.hitAble = false;
        break;
      default:
        // 原版：currentFrame == totalFrames - 1 → removeSelf
        if (b.animFrame === b.animTotal - 1) removed.push(b.id);
        break;
    }
  }
  if (removed.length > 0) removeBullets(ctx, removed);
}

/**
 * 飞行道具死亡（原版 Bullet.doHit）：停命中，有元件时间轴则进入残留段
 * （跳 hit 标签段；无标签原地停住播尽），entity:despawn 延后到播尽——
 * 命中残留演出随 despawn 收紧（切片 13-A3）。无动画数据时保持旧行为
 * （立即移除）。
 */
export function killBullet(ctx: SimCtx, b: BulletState): void {
  b.hitAble = false;
  if (b.animTotal <= 0) {
    removeBullets(ctx, [b.id]);
    return;
  }
  b.hitAnim = true;
  const hitFrame = b.animLabels['hit'];
  if (hitFrame !== undefined) b.animFrame = hitFrame;
}

/** 发射（behaviors.fire 引擎桥）：判定区换算世界坐标 + 参数换算入 SimState。 */
export function spawnBullet(ctx: SimCtx, spec: BulletSpawnSpec): void {
  const { owner, name, local, hit, params } = spec;
  const world = worldRect(owner, local);
  const axis = (v: number | { start?: number; add?: number; max?: number; min?: number } | undefined) => {
    if (typeof v === 'number') return { start: v, add: 0, max: 999, min: -999 };
    return {
      start: v?.start ?? 0,
      add: v?.add ?? 0,
      max: v?.max ?? 999,
      min: v?.min ?? -999,
    };
  };
  const ax = axis(params.x);
  const ay = axis(params.y);
  const hold = params.hold === undefined ? -1 : params.hold === -1 ? -1 : Math.round(params.hold * 60);
  const bullet: BulletState = {
    id: ctx.state.nextEntityId,
    ownerId: owner.id,
    facing: owner.facing,
    name,
    x: world.x,
    y: world.y,
    w: world.w,
    h: world.h,
    sx: ax.start,
    sy: ay.start,
    addX: ax.add,
    addY: ay.add,
    minX: ax.min,
    maxX: ax.max,
    minY: ay.min,
    maxY: ay.max,
    holdTicks: hold,
    hitTimes: params.hits ?? -1,
    hp: params.hp ?? 100,
    hpMax: params.hp ?? 100,
    hit: { ...hit },
    hitAble: true,
    viaAssist: false,
    animTotal: spec.anim?.totalFrames ?? 0,
    animFrame: 1,
    animLabels: spec.anim ? { ...spec.anim.labels } : {},
    hitAnim: false,
  };
  ctx.state.nextEntityId += 1;
  ctx.state.bullets.push(bullet);
  ctx.state.bullets.sort((a, b) => a.id - b.id);
  ctx.emit('entity:spawn', { kind: 'bullet', id: bullet.id, name: bullet.name, owner: owner.id });
}

/** 辅助 fire 桥（原版 Bullet 构造，owner is FighterMain 不成立 → 命中不回气）。 */
export function spawnAssistBullet(ctx: SimCtx, spec: AssistBulletSpawnSpec): void {
  const { self, ownerId, name, local, hit, params } = spec;
  const world = worldRect(self, local);
  const axis = (v: number | { start?: number; add?: number; max?: number; min?: number } | undefined) => {
    if (typeof v === 'number') return { start: v, add: 0, max: 999, min: -999 };
    return {
      start: v?.start ?? 0,
      add: v?.add ?? 0,
      max: v?.max ?? 999,
      min: v?.min ?? -999,
    };
  };
  const ax = axis(params.x);
  const ay = axis(params.y);
  const hold = params.hold === undefined ? -1 : params.hold === -1 ? -1 : Math.round(params.hold * 60);
  const bullet: BulletState = {
    id: ctx.state.nextEntityId,
    ownerId,
    facing: self.facing,
    name,
    x: world.x,
    y: world.y,
    w: world.w,
    h: world.h,
    sx: ax.start,
    sy: ay.start,
    addX: ax.add,
    addY: ay.add,
    minX: ax.min,
    maxX: ax.max,
    minY: ay.min,
    maxY: ay.max,
    holdTicks: hold,
    hitTimes: params.hits ?? -1,
    hp: params.hp ?? 100,
    hpMax: params.hp ?? 100,
    hit: { ...hit },
    hitAble: true,
    viaAssist: true,
    animTotal: spec.anim?.totalFrames ?? 0,
    animFrame: 1,
    animLabels: spec.anim ? { ...spec.anim.labels } : {},
    hitAnim: false,
  };
  ctx.state.nextEntityId += 1;
  ctx.state.bullets.push(bullet);
  ctx.state.bullets.sort((a, b) => a.id - b.id);
  ctx.emit('entity:spawn', { kind: 'bullet', id: bullet.id, name: bullet.name, owner: ownerId });
}

function removeBullets(ctx: SimCtx, ids: number[]): void {
  const set = new Set(ids);
  ctx.state.bullets = ctx.state.bullets.filter((b) => {
    if (set.has(b.id)) {
      ctx.emit('entity:despawn', { kind: 'bullet', id: b.id });
      return false;
    }
    return true;
  });
}
