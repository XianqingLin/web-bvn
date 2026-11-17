import {
  ENERGY_GAP_TICKS,
  ENERGY_MAX,
  type AssisterState,
  type AttackerState,
  type FighterState,
} from '../state.js';
import {
  ActionState,
  currentBodyRect,
  isAttackingState,
  rectsOverlap,
  SPEED_PLUS,
  worldRect,
  type FighterDef,
  type HitDef,
} from '../fighter/def.js';
import {
  attackRateOf,
  defenseDamageScale,
  isAttributeHit,
  isPhysicalHit,
} from '../fighter/assister.js';
import {
  defenseGapTicks,
  defenseHoldTicks,
  enterDead,
  enterGuardBreak,
  enterHurt,
  hitZonesWorld,
  HURT_GAP_TICKS,
  setLabel,
} from '../fighter/machine.js';
import {
  attackerLocalRect,
  isBishaAction,
  resolveAttackerActionId,
  type SimCtx,
} from './ctx.js';
import { killBullet } from './bullets.js';
import { maybeBeginRoundEnd } from './flow.js';

// —— 命中结算常量（原版 GameConfig/FighterMain 系；比例量不折算） ——
/** 防御削血比例（原版 DEFENSE_LOSE_HP_RATE，比例量不折算） */
const DEFENSE_LOSE_HP_RATE = 0.05;
/** 钢身减伤比例（原版 STEEL_HURT_HP_PERCENT，比例量不折算） */
const STEEL_HURT_HP_PERCENT = 0.65;
/**
 * 打击特效停顿（修复批次 35；EffectModel freeze ms × FPS_GAME/1000 → tick）。
 * 轻击系（KAN/DA/MAGIC，命中与防御特效同值）50ms=3 tick；重型/属性/摔
 * （KAN_HEAVY/DA_HEAVY/MAGIC_HEAVY/FIRE/ICE/ELECTRIC/CATCH）与钢身系 400ms=24；
 * 破防 doBreakDefense 叠加 break_def 特效（freeze 500ms 后调用覆盖前值）=30。
 * 命中 type 0/10（NONE/STONE）无 hit_ 表项 → 不出特效不冻（原版 getHitEffect
 * 无回退）；防御走 getDefenseEffect 回退 defense_5 → STONE 按重型档。
 */
const HITSPARK_FREEZE_LIGHT_TICKS = 3;
const HITSPARK_FREEZE_HEAVY_TICKS = 24;
const BREAK_DEF_FREEZE_TICKS = 30;
function isHeavySparkType(hitType: number): boolean {
  return (
    hitType === 3 || hitType === 5 || hitType === 6 ||
    hitType === 7 || hitType === 8 || hitType === 9 || hitType === 11
  );
}
function hitFreezeTicks(hitType: number): number {
  if (hitType === 0 || hitType === 10) return 0;
  return isHeavySparkType(hitType) ? HITSPARK_FREEZE_HEAVY_TICKS : HITSPARK_FREEZE_LIGHT_TICKS;
}
/** 防御特效 freeze（doDefenseEffect：getDefenseEffect 缺失表项回退 defense_5） */
function defenseFreezeTicks(hitType: number): number {
  if (hitType === 0) return 0;
  return isHeavySparkType(hitType) ? HITSPARK_FREEZE_HEAVY_TICKS : HITSPARK_FREEZE_LIGHT_TICKS;
}
/** 钢身耗能比例（原版 doSteelHurt useEnergy 其余系 0.4；超钢 0.2 未实现——无超钢字段） */
const STEEL_ENERGY_RATE = 0.4;
/** 钢身受击无敌窗（原版 STEEL_HURT_GAP_FRAME=4；击飞类 STEEL_HURT_DOWN_GAP_FRAME=10；
 *  30fps 渲染帧 → 60Hz tick ×2，修复批次 38 与 HURT_GAP_TICKS 同律） */
const STEEL_HURT_GAP_TICKS = 8;
const STEEL_HURT_DOWN_GAP_TICKS = 20;
/** 防御命中击退衰减（原版 DEFENSE_DAMPING_X=1@30fps → 0.5/tick） */
const DEFENSE_DAMP_X = 0.5;

// —— 气回充（原版 FighterMain doQiAdd 系；qi 是资源量，速率不折算） ——
/** 近战命中回气：非必杀 power×0.16，封顶 15（原版 QI_ADD_HIT_MAX） */
const HIT_QI_RATE = 0.16;
const QI_ADD_HIT_MAX = 15;
/** 受击回气：power×0.085，封顶 20（原版 QI_ADD_HURT_MAX） */
const HURT_QI_RATE = 0.085;
const QI_ADD_HURT_MAX = 20;
/** 飞行道具命中回气：发射者 power×0.1 */
const BULLET_QI_RATE = 0.1;
/** 独立道具命中回气：所有者 power×0.15 */
const ATTACKER_QI_RATE = 0.15;
/** 辅助命中回气：召唤者 power×0.15（原版 Assister.hit） */
const ASSISTER_QI_RATE = 0.15;

/** 某 fighter 当前在场的辅助（buff 结算查询；最多一个）。 */
function assisterOf(ctx: SimCtx, fighterId: number): AssisterState | null {
  return ctx.state.assisters.find((a) => a.ownerId === fighterId) ?? null;
}

// 6. [动画帧] 命中判定与结算。
// 固定顺序（本引擎 canonical，替代原版 children 插入序；两端一致即确定）：
//   角色→角色（P1→P2）→ 角色攻击→道具 → 道具→角色 → 道具→道具（均按 id 升序）
//   → 辅助→角色（切片 12 追加尾部）
export function stepHitResolution(ctx: SimCtx): void {
  const { fighters, bullets } = ctx.state;
  for (const atk of fighters) {
    const atkDef = ctx.defOf(atk);
    // 必杀/技/砍技同属攻击结算（原版 isAttacking：命中监听不区分攻击层级；
    // 此前只认 ATTACK_ING 导致近战必杀永不命中——切片 9 修复）
    if (!isAttackingState(atk.actionState) || !atkDef) continue;
    // 逐区解析（切片 10：原版 getCurrentHitSprite + getHitVOByDisplayName——
    // 每帧每个可解析 atm 区独立成命中，多段动作如 摔1 的 sh12atm 二段生效）
    const zones = hitZonesWorld(atk, atkDef);
    if (zones.length === 0) continue;
    for (const tgt of fighters) {
      if (tgt.id === atk.id) continue;
      if (tgt.hp <= 0 || tgt.actionState === ActionState.DEAD) continue;
      // 原版 checkHit：isAllowBeHit=false 一侧整体排除（瞬步/防御无敌窗）
      if (!tgt.isAllowBeHit) continue;
      const tgtDef = ctx.defOf(tgt);
      const bodyLocal = tgtDef
        ? currentBodyRect({ animFrame: tgt.animFrame, def: tgtDef })
        : null;
      if (!bodyLocal) continue;
      const body = worldRect(tgt, bodyLocal);
      for (const { rect: hitArea, zone } of zones) {
        // 修复批次 34：拆除跨帧去重门（原版 checkHit 每帧重扫、无跨帧去重，
        // 多段近战靠受击 4 帧无敌窗限频；一帧一目标至多一命中由下面 break 保证）
        if (!rectsOverlap(hitArea, body)) continue;
        applyHit(ctx, atk.id, atk.facing, atk.x, tgt, tgtDef, zone.hit, hitArea, zone.hitId, atk);
        break;
      }
    }
    // 角色攻击 vs 敌方道具（原版 Bullet.beHit：hp -= power；摧毁不回气——简化偏离；
    // 死亡走 killBullet 进残留段，切片 13-A3）
    for (const b of bullets) {
      if (!b.hitAble || b.ownerId === atk.id) continue;
      const bRect = { x: b.x, y: b.y, w: b.w, h: b.h };
      const zone = zones.find((z) => rectsOverlap(z.rect, bRect));
      if (!zone) continue;
      b.hp -= zone.zone.hit.power;
      if (b.hp <= 0) killBullet(ctx, b);
    }
  }
  // 道具 → 角色 / 道具 → 道具（2 人模型：ownerId 不同即敌对）
  for (const b of bullets) {
    if (!ctx.state.bullets.includes(b) || !b.hitAble) continue;
    const bRect = { x: b.x, y: b.y, w: b.w, h: b.h };
    const owner = ctx.state.fighters.find((f) => f.id === b.ownerId) ?? null;
    let consumed = false;
    for (const tgt of fighters) {
      if (tgt.id === b.ownerId) continue;
      if (tgt.hp <= 0 || tgt.actionState === ActionState.DEAD || !tgt.isAllowBeHit) continue;
      const tgtDef = ctx.defOf(tgt);
      const bodyLocal = tgtDef
        ? currentBodyRect({ animFrame: tgt.animFrame, def: tgtDef })
        : null;
      if (!bodyLocal) continue;
      if (!rectsOverlap(bRect, worldRect(tgt, bodyLocal))) continue;
      // 原版 Bullet.hit：非必杀命中 → 发射者回气 power×0.1（qi 上限 300）；
      // 辅助发射的弹不回气（viaAssist，原版 `owner is FighterMain` 守卫）
      if (owner && !b.viaAssist && !isBishaAction(b.name.replace('atm', ''))) {
        owner.qi = Math.min(300, owner.qi + b.hit.power * BULLET_QI_RATE);
      }
      applyHit(
        ctx,
        b.ownerId,
        b.facing,
        b.x + b.w / 2,
        tgt,
        tgtDef,
        b.hit,
        bRect,
        b.name.replace('atm', ''),
        // 弹体命中非近战：不结算近战回气（调用侧已按 BULLET_QI_RATE），
        // 也不消费发射者 hurtAction（那是投技/近战动作的携带语义）
        null,
      );
      // 原版 hitTimes：每次命中递减，耗尽 → doHit（停止命中，播残留段至
      // 时间轴播尽移除——切片 13-A3 起 entity:despawn 即残留结束）
      if (b.hitTimes > 0 && --b.hitTimes <= 0) {
        killBullet(ctx, b);
        consumed = true;
        break;
      }
    }
    if (consumed) continue;
    // 道具对撞（原版 Bullet.beHit：hp -= 对方 hpMax；双灭同帧按 id 序结算）
    for (const other of bullets) {
      if (other.id === b.id || !other.hitAble) continue;
      if (other.ownerId === b.ownerId) continue;
      const oRect = { x: other.x, y: other.y, w: other.w, h: other.h };
      if (!rectsOverlap(bRect, oRect)) continue;
      b.hp -= other.hpMax;
      other.hp -= b.hpMax;
      if (b.hp <= 0) killBullet(ctx, b);
      if (other.hp <= 0) killBullet(ctx, other);
      if (!ctx.state.bullets.includes(b)) break;
    }
  }
  // 独立道具 → 角色（原版 FighterAttacker 命中：findHitArea 逐帧扫描命名
  // 子对象 → getHitVOByDisplayName 解析（精确 → 去首个 atm），RectUtils 镜像
  // 平移到原点；无命中区帧 = 无判定；非必杀所有者回气 power×0.15；逐帧路径
  // 不因命中失效——多段命中靠受击 4 帧无敌窗限频（修复批次 34）。
  // fires 缺逐帧数据的元件回退生成帧占位矩形 + 生成动作全程固定——state.ts
  // 偏离注；回退路径保留单次命中门（移植自创近似不受原版逐帧语义背书））
  for (const a of ctx.state.attackers) {
    if (!a.hitAble) continue;
    const owner = ctx.state.fighters.find((f) => f.id === a.ownerId) ?? null;
    // 命中数据源：viaAssist → 辅助 def fires；角色生成 → owner 当前形态 fires
    const tl =
      a.viaAssist && a.scriptAssistId !== null
        ? ctx.assisterDefs.get(a.scriptAssistId)?.fires?.[a.name]
        : owner !== null
          ? ctx.defOf(owner)?.fires?.[a.name]
          : undefined;
    const frameAreas = tl?.hits?.[String(a.animFrame)];
    if (frameAreas !== undefined) {
      // 逐帧路径：动作表 = viaAssist → 辅助 def；角色 → owner 当前形态 def
      //（偏离：原版 hitModel 跨形态累积注册，port 用单一动作表；
      // 语料 attacker 命中区名基本同形态，形态切换中命中罕见）
      const actions =
        a.viaAssist && a.scriptAssistId !== null
          ? ctx.assisterDefs.get(a.scriptAssistId)?.actions
          : owner !== null
            ? ctx.defOf(owner)?.actions
            : undefined;
      if (actions === undefined) continue;
      // 命中力覆写（itachi 动态伤害：assister 生成时按 target hpMax 改写
      // hitVO.power——原版 hitModel.getHitVO 直接改写实例）
      const powerOverride =
        a.viaAssist && a.scriptAssistId !== null
          ? ctx.state.assisters.find(
              (s) => s.assistId === a.scriptAssistId && s.ownerId === a.ownerId,
            )?.hitPowerOverrides
          : undefined;
      attackerFrameHit(ctx, a, frameAreas, actions, powerOverride, owner, fighters);
    }
    if (a.hit === null) continue;
    // 回退路径：生成帧占位矩形（元件局部 fbHit 镜像平移到原点）全程固定
    const rect = attackerLocalRect(a, a.fbHit);
    for (const tgt of fighters) {
      if (tgt.id === a.ownerId) continue;
      if (tgt.hp <= 0 || tgt.actionState === ActionState.DEAD || !tgt.isAllowBeHit) continue;
      const tgtDef = ctx.defOf(tgt);
      const bodyLocal = tgtDef
        ? currentBodyRect({ animFrame: tgt.animFrame, def: tgtDef })
        : null;
      if (!bodyLocal) continue;
      if (!rectsOverlap(rect, worldRect(tgt, bodyLocal))) continue;
      if (owner !== null && !isBishaAction(a.hitId ?? '')) {
        owner.qi = Math.min(300, owner.qi + a.hit.power * ATTACKER_QI_RATE);
      }
      applyHit(
        ctx,
        a.ownerId,
        a.facing,
        rect.x + rect.w / 2,
        tgt,
        tgtDef,
        a.hit,
        rect,
        a.hitId,
        owner,
        true, // viaEntity：回气已在调用侧按 ATTACKER_QI_RATE 结算，跳过近战分支
      );
      a.hitAble = false;
      break;
    }
  }
  // 辅助 → 角色（切片 12，原版 Assister.hit：命中 → owner 回气 power×0.15 +
  // 目标受击结算；一帧一目标至多一命中（原版 checkHit→getHitObj 首个相交），
  // 跨帧多段靠受击 4 帧无敌窗限频——修复批次 34 拆除跨帧去重门）
  for (const s of ctx.state.assisters) {
    const def = ctx.assisterDefs.get(s.assistId);
    const owner = ctx.state.fighters.find((f) => f.id === s.ownerId) ?? null;
    if (!def || owner === null) continue;
    const hitTargets = new Set<number>();
    for (const area of def.areas[s.animFrame] ?? []) {
      const hit = def.actions[area.name] ?? null;
      if (hit === null) continue; // 无动作表的区 = 纯表现
      const rect = worldRect(s, area);
      for (const tgt of fighters) {
        if (tgt.id === s.ownerId) continue;
        if (tgt.hp <= 0 || tgt.actionState === ActionState.DEAD || !tgt.isAllowBeHit) continue;
        if (hitTargets.has(tgt.id)) continue;
        const tgtDef = ctx.defOf(tgt);
        const bodyLocal = tgtDef
          ? currentBodyRect({ animFrame: tgt.animFrame, def: tgtDef })
          : null;
        if (!bodyLocal) continue;
        if (!rectsOverlap(rect, worldRect(tgt, bodyLocal))) continue;
        hitTargets.add(tgt.id);
        // 辅助命中回气（原版 Assister.hit：addQi(power×0.15)，无必杀排除）
        owner.qi = Math.min(300, owner.qi + hit.power * ASSISTER_QI_RATE);
        applyHit(
          ctx,
          s.ownerId,
          s.facing,
          s.x,
          tgt,
          tgtDef,
          hit,
          rect,
          area.name,
          null,
          true, // viaEntity：回气已按 ASSISTER_QI_RATE 在调用侧结算
        );
        break;
      }
    }
  }
}

/**
 * B5 逐帧命中路径（原版 FighterAttacker.getCurrentHits → hit 结算）：
 * 当前帧命中区逐区解析动作（区序 = 元件子对象序），矩形与目标身体相交
 * → 回气 + applyHit。每帧最多一命中（原版 checkHit→getHitObj 首个相交）；
 * 多段命中靠受击方 HURT_GAP_FRAME=4 帧无敌窗限频（修复批次 34：拆除
 * "单次命中即失效"门——该门源于"语料无多次命中实例"误判，已被 17 角色
 * ≥10 帧连续命中窗语料证伪，原版 FighterAttacker.hit 无失效字段）。
 * 返回是否有命中成立。
 */
function attackerFrameHit(
  ctx: SimCtx,
  a: AttackerState,
  areas: { name: string; x: number; y: number; w: number; h: number }[],
  actions: Record<string, HitDef>,
  powerOverride: Record<string, number> | undefined,
  owner: FighterState | null,
  fighters: FighterState[],
): boolean {
  for (const area of areas) {
    const actionId = resolveAttackerActionId(area.name, actions);
    if (actionId === null) continue; // 无动作表的区 = 纯表现
    const base = actions[actionId]!;
    // 命中力覆写（itachi 动态伤害：power = target.hpMax × rate）
    const hit: HitDef =
      powerOverride?.[actionId] !== undefined
        ? { ...base, power: powerOverride[actionId]! }
        : base;
    const rect = attackerLocalRect(a, area);
    for (const tgt of fighters) {
      if (tgt.id === a.ownerId) continue;
      if (tgt.hp <= 0 || tgt.actionState === ActionState.DEAD || !tgt.isAllowBeHit) continue;
      const tgtDef = ctx.defOf(tgt);
      const bodyLocal = tgtDef
        ? currentBodyRect({ animFrame: tgt.animFrame, def: tgtDef })
        : null;
      if (!bodyLocal) continue;
      if (!rectsOverlap(rect, worldRect(tgt, bodyLocal))) continue;
      if (owner !== null && !isBishaAction(actionId)) {
        owner.qi = Math.min(300, owner.qi + hit.power * ATTACKER_QI_RATE);
      }
      applyHit(
        ctx,
        a.ownerId,
        a.facing,
        rect.x + rect.w / 2,
        tgt,
        tgtDef,
        hit,
        rect,
        actionId,
        owner,
        true, // viaEntity：回气已在调用侧按 ATTACKER_QI_RATE 结算，跳过近战分支
      );
      return true;
    }
  }
  return false;
}

/**
 * 命中结算（原版 beHit 分流：钢身 → 防御 → doHurt）。
 * 防御分支照 doDefenseHit：削血 5% → 能量不足则破防（doBreakDefense）→
 * 否则能量损耗 + 短暂无敌 + 击退（无防御硬直动画窗，POC 偏离已记录）。
 * @param attackerId 攻击来源 id（角色或道具）
 * @param attackerFacing 击退方向基准（角色=当前朝向；道具=发射时朝向）
 * @param attackerX 攻击来源位置（背刺判定；道具=道具矩形中心）
 * @param hitId 攻击动作 id（justHitToPlay 查询/必杀判定；道具/attacker = 元件名反查）
 * @param attacker 攻击方 fighter（近战回气 + hurtAction 携带；弹体命中传 null）
 * @param viaEntity 是否独立道具命中（回气调用侧已结算，跳过近战分支）
 */
export function applyHit(
  ctx: SimCtx,
  attackerId: number,
  attackerFacing: 1 | -1,
  attackerX: number,
  target: FighterState,
  targetDef: FighterDef | null,
  hit: HitDef,
  hitArea: { x: number; y: number; w: number; h: number },
  hitId: string | null = null,
  attacker: FighterState | null = null,
  viaEntity = false,
): void {
  // 钢身破格（原版 doSteelHurt：透支/必杀/摔命中 → 破钢走完整 doHurt）；
  // 钢身优先于防御结算（原版 beHit 先查 isSteelBody）
  const steelAbsorb =
    target.steelBody &&
    !target.energyOverload &&
    !isBishaAction(hitId ?? '') &&
    hit.hitType !== 11;
  const blocking =
    !steelAbsorb &&
    target.actionState === ActionState.DEFENCE_ING &&
    !(hit.hitType === 11 && hit.isBreakDef) &&
    !checkDefDirect(target, attackerX, attackerFacing);
  // 攻击方近战回气（原版 FighterMain.doQiAdd：非必杀 power×0.16 封顶 15；
  // 被防御的命中同样结算——偏离记录：原版结算点在命中监听层）。
  // 仅角色本人的动作命中结算（viaEntity 排除独立道具/弹体——各自调用侧
  // 已按专属费率结算，attacker 仅用于投技 hurtAction 携带）
  if (attacker !== null && hitId !== null && !viaEntity && !isBishaAction(hitId)) {
    attacker.qi = Math.min(
      300,
      attacker.qi + Math.min(hit.power * HIT_QI_RATE, QI_ADD_HIT_MAX),
    );
  }
  // 伤害乘区（切片 12，原版 FighterBuffCtrler/FighterBuffVO）：
  //   攻方 attackRate = 1 + attackUp 加值（hitModel.setPowerRate）；
  //   守方辅助 buffEffects.attrResistance（属性命中，结算前）；
  //   守方 dr = clamp(2 − defenseRate, 0.1, 1)（loseHp 语义）。
  // 气/吸血等资源结算仍用原始 power（原版语义：powerRate 只进伤害）。
  const atkFighter = ctx.state.fighters.find((f) => f.id === attackerId) ?? null;
  let dmg = hit.power * (atkFighter !== null ? attackRateOf(atkFighter) : 1);
  const tgtAssister = assisterOf(ctx, target.id);
  if (
    tgtAssister !== null &&
    isAttributeHit(hit.hitType) &&
    tgtAssister.buffEffects.attrResistance !== undefined
  ) {
    dmg *= 1 - tgtAssister.buffEffects.attrResistance;
  }
  dmg *= defenseDamageScale(target);
  const chip = steelAbsorb
    ? dmg * STEEL_HURT_HP_PERCENT
    : blocking
      ? dmg * DEFENSE_LOSE_HP_RATE
      : dmg;
  // 攻方辅助物吸血（原版 phyLifesteal，结算后按实伤回复；物理非必杀命中）
  if (
    atkFighter !== null &&
    !blocking &&
    isPhysicalHit(hit.hitType) &&
    hitId !== null &&
    !isBishaAction(hitId)
  ) {
    const atkAssister = assisterOf(ctx, attackerId);
    if (atkAssister !== null && atkAssister.buffEffects.phyLifesteal !== undefined) {
      atkFighter.hp = Math.min(
        atkFighter.hpMax,
        atkFighter.hp + chip * atkAssister.buffEffects.phyLifesteal,
      );
    }
  }
  const nextHp = Math.max(0, target.hp - chip);
  // 训练模式：假人不 KO（血最低保留 1）
  target.hp = ctx.training && nextHp <= 0 ? 1 : nextHp;
  // 命中特效钉点（原版 getHitObj→writeOverlap：特效钉 hitRect∩身体区相交区
  // 中心；防御/钢身同点。身体区缺失 = 回退命中区中心）
  let sparkX = hitArea.x + hitArea.w / 2;
  let sparkY = hitArea.y + hitArea.h / 2;
  if (targetDef) {
    const bodyLocal = currentBodyRect({ animFrame: target.animFrame, def: targetDef });
    if (bodyLocal) {
      const b = worldRect(target, bodyLocal);
      const x0 = Math.max(hitArea.x, b.x);
      const x1 = Math.min(hitArea.x + hitArea.w, b.x + b.w);
      const y0 = Math.max(hitArea.y, b.y);
      const y1 = Math.min(hitArea.y + hitArea.h, b.y + b.h);
      sparkX = (x0 + x1) / 2;
      sparkY = (y0 + y1) / 2;
    }
  }
  // 防御损耗能量：破防技 = 90% 上限，否则 min(50, power/5)（原版 doDefenseHit；
  // 上提复用——freeze 表与破防判定共用）
  const drain = hit.isBreakDef
    ? Math.round(ENERGY_MAX * 0.9)
    : Math.min(50, Math.floor(hit.power / 5));
  const willBreakDef = blocking && target.energy < drain;
  // 特效类型（原版 doEffectVO 的 type 参数）：防御命中按防御者 defenseType
  // 转换（doDefenseEffect HAND 分支：KAN→DA、KAN_HEAVY→DA_HEAVY；剑防不转）；
  // 普通命中/钢身 = 原始 hitType
  const sparkType =
    blocking && (targetDef?.defenseType ?? 0) === 1
      ? hit.hitType === 1
        ? 2
        : hit.hitType === 6
          ? 3
          : hit.hitType
      : hit.hitType;
  ctx.emit('hit:connect', {
    attacker: attackerId,
    target: target.id,
    hitType: hit.hitType,
    sparkType,
    power: hit.power,
    blocked: blocking,
    // 钢身**吸收**标志（doSteelHurt 实际走到才有钢身特效/音效；钢身+必杀穿透
    // 时 steelBody 仍为 true 但走普通 doHurt——消费者按此分流）
    steel: steelAbsorb,
    breakDef: willBreakDef,
    direct: attackerFacing,
    x: sparkX,
    y: sparkY,
  });
  // 打击停顿（原版 EffectCtrler.freeze → GameCtrler.pause 整局停走）：
  // 破防 500ms > 钢身 400ms > 防御/命中按特效表；KO 同样先冻再死（原版
  // freeze 与 beHit 并行，死亡动画在停顿后播）
  if (steelAbsorb) {
    ctx.state.freezeTicks = HITSPARK_FREEZE_HEAVY_TICKS;
  } else if (willBreakDef) {
    ctx.state.freezeTicks = BREAK_DEF_FREEZE_TICKS;
  } else if (blocking) {
    ctx.state.freezeTicks = defenseFreezeTicks(sparkType);
  } else {
    ctx.state.freezeTicks = hitFreezeTicks(hit.hitType);
  }
  if (target.hp <= 0) {
    enterDead(target, targetDef);
    // 死亡语音（原版 DIE voice：击飞致死在 doHurt 即播、硬直致死在倒地硬直结束播；
    // 移植版统一提前到 KO 时刻——偏离记录）
    ctx.emit('voice', { fighter: target.id, kind: 'die' });
    ctx.emit('fighter:ko', { fighter: target.id });
    // 团队回合结束（切片 36）：同 tick 胜方亦死（多命中结算序）→ 转平局
    if (
      ctx.state.roundEnd != null &&
      ctx.state.roundEnd.winnerId === target.id
    ) {
      ctx.state.roundEnd.draw = true;
    } else {
      maybeBeginRoundEnd(ctx, target);
    }
    return;
  }
  if (blocking) {
    // 被防御：justHitToPlay(includeDefense) 查询基准（原版 lastDefHitId 语义）
    target.lastDefHitId = hitId;
    // 防御损耗能量：drain 已上提（freeze 表与破防判定共用）
    ctx.emit('fighter:guard', { fighter: target.id });
    if (target.energy < drain) {
      // 破防：额外削血 power/10（原版 doBreakDefense）
      target.hp -= hit.power / 10;
      if (target.hp <= 0) {
        target.hp = 0;
        enterDead(target, targetDef);
        ctx.emit('fighter:ko', { fighter: target.id });
        // 团队回合结束（切片 36）：同 tick 胜方亦死（多命中结算序）→ 转平局
        if (
          ctx.state.roundEnd != null &&
          ctx.state.roundEnd.winnerId === target.id
        ) {
          ctx.state.roundEnd.draw = true;
        } else {
          maybeBeginRoundEnd(ctx, target);
        }
        return;
      }
      target.energy = 0;
      target.energyOverload = true;
      target.energyGap = ENERGY_GAP_TICKS;
      enterGuardBreak(target, targetDef, hit, attackerFacing);
      ctx.emit('fighter:guardBreak', { fighter: target.id });
      return;
    }
    target.energy -= drain;
    target.energyGap = ENERGY_GAP_TICKS;
    target.beHitGap = defenseGapTicks(hit);
    target.isAllowBeHit = false;
    target.vx = hit.hitx * attackerFacing * SPEED_PLUS;
    target.dampX = DEFENSE_DAMP_X;
    void defenseHoldTicks(hit);
    return;
  }
  if (steelAbsorb) {
    // 钢身受击（原版 doSteelHurt 收编，修复批次 34）：受击无敌窗（击飞类 10 帧、
    // 其余 4 帧，限多段命中频率）+ 钢身耗能（原版 useEnergy：破防技全额、其余
    // 40%；超钢 20% 未实现——无超钢字段）；减伤 65% 已在上方 chip 乘区结算
    target.beHitGap = hit.hurtType !== 0 ? STEEL_HURT_DOWN_GAP_TICKS : STEEL_HURT_GAP_TICKS;
    target.isAllowBeHit = false;
    target.energy -= hit.isBreakDef ? dmg : dmg * STEEL_ENERGY_RATE;
    target.energyGap = ENERGY_GAP_TICKS;
    if (target.energy < 0) {
      target.energy = 0;
      target.energyOverload = true;
    }
    // 击退（原版 doSteelHurt 尾部 setVec2：速度 hitx/hity、阻尼 |hitx|×0.1×
    // SPEED_PLUS×6=×3（_velocity2 通道 renderVelocity 叠加位移）；破防技 ×2；
    // 移植版速度/damp 空间 = 原版 ×0.5 → damp = |hitx|×0.1×3×0.5）
    const kbMul = hit.isBreakDef ? 2 : 1;
    target.vx = hit.hitx * attackerFacing * SPEED_PLUS * kbMul;
    target.vy = hit.hity * SPEED_PLUS * kbMul;
    target.dampX = Math.abs(hit.hitx) * 0.15 * kbMul;
    target.dampY = Math.abs(hit.hity) * 0.15 * kbMul;
    return;
  }
  // 自定义受击动作（原版 doHurt → playHurtAct）：攻击方动作携带（setHurtAction
  // 触发在攻击方时间轴，投技携带受击方专用受击动画）优先，受击方自设兜底；
  // 标签按受击方 def 校验存在性，缺失 = 通用受击态
  const hurtLabel = attacker?.hurtAction ?? target.hurtAction;
  if (hurtLabel !== null && targetDef?.labels[hurtLabel] !== undefined) {
    target.hurtAction = null;
    target.lastHurtHitId = hitId;
    target.qi = Math.min(300, target.qi + Math.min(hit.power * HURT_QI_RATE, QI_ADD_HURT_MAX));
    // 受击无敌窗（原版 doHurt 开头统一设 HURT_GAP_FRAME=4，hurtAct 分支同样
    // 生效——修复批次 34 补设；缺它则投技受击动画期间逐帧重复扣血）
    target.beHitGap = HURT_GAP_TICKS;
    target.isAllowBeHit = false;
    target.actionState = ActionState.HURT_ACT_ING;
    setLabel(target, targetDef, hurtLabel);
    return;
  }
  target.lastHurtHitId = hitId;
  // 受击回气（原版 FighterMain.doQiAdd：power×0.085 封顶 20）
  target.qi = Math.min(300, target.qi + Math.min(hit.power * HURT_QI_RATE, QI_ADD_HURT_MAX));
  const hurtResult = enterHurt(target, targetDef, hit, attackerFacing, !target.onGround);
  // 受击语音（原版 doHurt：硬直 + 重击类型 → HURT voice（rate 0.5 由渲染层掷）、
  // 击飞 → HURT_FLY；isHeavy 类型集 = KAN/KAN_HEAVY/DA/DA_HEAVY = isPhysicalHit 同集）
  if (hurtResult === 'fly') {
    ctx.emit('voice', { fighter: target.id, kind: 'hurtFly' });
  } else if (isPhysicalHit(hit.hitType)) {
    ctx.emit('voice', { fighter: target.id, kind: 'hurt' });
  }
}

/** 背刺判定（原版 checkDefDirect）：防御者背对攻击来源 → 防御无效。 */
function checkDefDirect(
  defender: FighterState,
  attackerX: number,
  attackerFacing: 1 | -1,
): boolean {
  if (defender.x < attackerX - 5) return defender.facing < 0 && attackerFacing < 0;
  if (defender.x > attackerX + 5) return defender.facing > 0 && attackerFacing > 0;
  return false;
}
