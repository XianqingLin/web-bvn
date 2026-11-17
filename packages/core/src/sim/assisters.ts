import type {
  AssisterState,
  CutinLockState,
  FighterState,
} from '../state.js';
import { currentBodyRect, rectsOverlap, worldRect } from '../fighter/def.js';
import {
  evaluateLoopCond,
  stepAssisterCustomFunc,
  type AssisterContext,
} from '../fighter/assister.js';
import { wake, type SimCtx } from './ctx.js';
import { GRAVITY_CAP, GRAVITY_START, GRAVITY_STEP } from './physics.js';

// —— 辅助实体（切片 12，原版 Assister） ——

/** 召唤（原版 FighterMcCtrler.renderAssist → FighterEventCtrler.addAssister）：
 *  出生点 = owner.x − 30×direct（身后），y 同 owner；fzqi 已由调用方清零。 */
export function spawnAssister(ctx: SimCtx, owner: FighterState): void {
  const assistId = owner.assistId;
  const def = assistId !== null ? ctx.assisterDefs.get(assistId) : undefined;
  if (assistId === null || !def) return;
  owner.fzqi = 0;
  const assister: AssisterState = {
    id: ctx.state.nextEntityId,
    ownerId: owner.id,
    assistId,
    facing: owner.facing,
    x: owner.x - 30 * owner.facing,
    y: owner.y,
    vx: 0,
    vy: 0,
    dampX: 0,
    dampY: 0,
    gRamp: GRAVITY_START,
    applyG: true,
    onGround: true,
    actLabel: null,
    // 出场帧 = 原版 goFight gotoAndPlay(2)（1 起；0 帧脚本是 stop() 样板）
    animFrame: 2,
    touchFloor: null,
    hitTargetChecker: null,
    hitTargetAction: null,
    buffEffects: def.buffEffects !== undefined ? { ...def.buffEffects } : {},
    customFunc: null,
    frameJumped: false,
    hitPowerOverrides: {},
  };
  ctx.state.nextEntityId += 1;
  ctx.state.assisters.push(assister);
  ctx.state.assisters.sort((a, b) => a.id - b.id);
  ctx.emit('entity:spawn', {
    kind: 'assister',
    id: assister.id,
    name: assistId,
    owner: owner.id,
  });
  // 生成帧脚本（原版帧 1 脚本在实例化时执行一次，随后才 gotoAndPlay(2)；
  // port 出场帧 = 2，帧 1 触发器在此补跑——itachi 动态伤害等生成期副作用）
  const spawnCtx: AssisterContext = {
    self: assister,
    def,
    owner,
    ownerDef: ctx.defOf(owner),
    ownerTargetDef: ctx.ownerTargetDefOf(owner),
    fighters: ctx.state.fighters,
    stage: ctx.state.stage,
    emit: (type, payload) => ctx.emit(type, payload),
    spawnAssistBullet: (spec) => ctx.spawnAssistBullet(spec),
    spawnAssistAttacker: (spec) => ctx.spawnAssistAttacker(spec),
    remove: () => {},
    setCutin: (kind) => ctx.setCutin('assister', assister.id, kind),
    getAttacker: () => null,
    gotoAndPlayAttacker: () => {},
    stopFollowAttacker: () => {},
    removeAttacker: () => {},
  };
  const spawnList = ctx.assisterTriggerIndex.get(assistId)?.get(1);
  if (spawnList) {
    for (const t of spawnList) {
      const h = ctx.assisterBehaviors[t.op];
      if (h) h(spawnCtx, t.args, t.target);
    }
  }
}

/** 辅助每 tick 物理（原版 renderVelocity/applayG；位移 = 速度，速度已是 60Hz 值）。 */
export function stepAssisterPhysics(ctx: SimCtx): void {
  const { stage, assisters } = ctx.state;
  for (const s of assisters) {
    s.vx = wake(s.vx, s.dampX);
    s.vy = wake(s.vy, s.dampY);
    s.x += s.vx;
    s.y += s.vy;
    if (s.y >= stage.groundY) {
      s.y = stage.groundY;
      s.vy = 0;
      s.gRamp = GRAVITY_START;
      if (!s.onGround && s.touchFloor !== null) {
        // 触地续接（原版 setTouchFloor 消费）
        const def = ctx.assisterDefs.get(s.assistId);
        const range = def?.labels[s.touchFloor];
        if (def && range) {
          s.actLabel = s.touchFloor;
          s.animFrame = range.index + 1;
        }
        s.touchFloor = null;
      }
      s.onGround = true;
    } else {
      if (s.applyG) {
        if (s.vy < 0) {
          s.gRamp = 0;
        } else {
          s.gRamp = Math.min(s.gRamp + GRAVITY_STEP, GRAVITY_CAP);
          s.y += s.gRamp;
        }
      }
      s.onGround = false;
    }
  }
}

/** 辅助 30Hz 推进：帧触发器 + 循环触发 + 动画推进 + 退场判定。
 *  cutinLock（切片 22）：特写冻结期只推进锁主（辅助侧切人演出）。 */
export function stepAssisterAnimation(ctx: SimCtx, cutinLock?: CutinLockState): void {
  const { fighters, stage, assisters } = ctx.state;
  const removed: number[] = [];
  for (const s of assisters) {
    if (removed.includes(s.id)) continue;
    if (cutinLock && !(cutinLock.kind === 'assister' && cutinLock.id === s.id)) continue;
    const def = ctx.assisterDefs.get(s.assistId);
    if (!def) continue;
    const owner = fighters.find((f) => f.id === s.ownerId) ?? null;
    // owner 死亡退场判定移至 customFunc 步进之后（切片 21：原版 renderAnimate
    // 的退场判定在 _customFunc 之后——死亡 tick checkFunc 先清 attacker 再退场）
    const ctx2: AssisterContext = {
      self: s,
      def,
      owner,
      ownerDef: owner !== null ? ctx.defOf(owner) : null,
      ownerTargetDef: ctx.ownerTargetDefOf(owner),
      fighters,
      stage,
      emit: (type, payload) => ctx.emit(type, payload),
      spawnAssistBullet: (spec) => ctx.spawnAssistBullet(spec),
      spawnAssistAttacker: (spec) => ctx.spawnAssistAttacker(spec),
      remove: () => {
        if (!removed.includes(s.id)) removed.push(s.id);
      },
      setCutin: (kind) => ctx.setCutin('assister', s.id, kind),
      // attacker 桥（切片 21）：范围 = viaAssist 且 ownerId === 召唤者
      //（每 fighter 至多一辅助在场 → 无歧义），name 匹配元件名
      getAttacker: (name) =>
        ctx.state.attackers.find(
          (a) => a.viaAssist && a.ownerId === s.ownerId && a.name === name,
        ) ?? null,
      gotoAndPlayAttacker: (name, label) => {
        const a = ctx2.getAttacker(name);
        if (a === null) return;
        const frame = a.animLabels[label];
        if (frame === undefined) return; // 标签缺失静默
        a.animFrame = frame;
        a.animHold = false;
        a.frameJumped = true;
      },
      stopFollowAttacker: (name) => {
        const a = ctx2.getAttacker(name);
        if (a === null) return;
        a.followX = false;
        a.followY = false;
      },
      removeAttacker: (name) => {
        const a = ctx2.getAttacker(name);
        if (a === null) return;
        ctx.removeAttackers([a.id]);
      },
    };
    // 帧触发器（同帧按注册顺序；触发器后同帧可能被 gotoAndPlay 改写帧号）
    // 跳转检测：gotoAndPlay/命中续接改写 animFrame 后本步不再推进
    //（原版 AS3 gotoAndPlay 播放头落在目标帧、次 tick 才前进——落点帧
    // 的触发器下一步照常执行；此前实现跳转后仍 +1，系统性吞掉标签
    // 首帧（byakuya CHK 落点 52 被推进成 53 滑进 CHK_False 段））
    const frameBefore = s.animFrame;
    const byFrame = ctx.assisterTriggerIndex.get(s.assistId);
    const list = byFrame?.get(s.animFrame);
    if (list) {
      for (const t of list) {
        const h = ctx.assisterBehaviors[t.op];
        if (h) h(ctx2, t.args, t.target);
      }
    }
    // 循环触发（注册帧起每动画帧，至 untilFrame 独占；条件不成立静默）
    for (const lt of def.loopTriggers) {
      if (s.animFrame < lt.frame) continue;
      if (lt.untilFrame !== null && s.animFrame >= lt.untilFrame) continue;
      if (!evaluateLoopCond(lt.cond, ctx2)) continue;
      for (const c of lt.then) {
        const h = ctx.assisterBehaviors[c.op];
        if (h) h(ctx2, c.args, c.target);
      }
    }
    if (removed.includes(s.id)) continue; // finish/gotoAndStop 触发退场
    // 命中续接检查（原版 AssisterCtrler.renderCheckTargetHit：帧脚本后、
    // 播放头推进前；checker 区与目标身体相交 → gotoAndPlay(action)）。
    // checker 不清除——窗口由判定区可见帧自然限定（byakuya chkm@50 一帧
    // 窗口，命中跳 CHK 段即挂载 atmmc 道具；未中则 51 帧默认分支
    // gotoAndPlay(CHK_False)）。
    if (s.hitTargetChecker !== null) {
      const area = (def.areas[s.animFrame] ?? []).find(
        (a) => a.name === s.hitTargetChecker,
      );
      const tgt = owner !== null ? fighters.find((f) => f.id !== owner.id) ?? null : null;
      const tgtDef = tgt !== null ? ctx.defOf(tgt) : null;
      const body =
        tgt !== null && tgtDef !== null
          ? currentBodyRect({ animFrame: tgt.animFrame, def: tgtDef })
          : null;
      if (area && tgt && body && rectsOverlap(worldRect(s, area), worldRect(tgt, body))) {
        const range =
          s.hitTargetAction !== null ? def.labels[s.hitTargetAction] : undefined;
        if (range && s.hitTargetAction !== null && s.actLabel !== s.hitTargetAction) {
          s.actLabel = s.hitTargetAction;
          s.animFrame = range.index + 1;
        }
      }
    }
    // 时间轴末退场（原版 renderAnimate：currentFrame == totalFrames-1 → finish）
    if (s.animFrame >= def.totalFrames - 1) {
      removed.push(s.id);
      continue;
    }
    // customFunc 步进（原版 mc.nextFrame 后回调 _customFunc；每动画帧）
    stepAssisterCustomFunc(ctx2);
    if (removed.includes(s.id)) continue; // checkFunc2 finish
    if (s.animFrame !== frameBefore) continue; // 本步发生过跳转：不推进
    s.animFrame += 1;
    // actLabel 同步（标签数少，线性扫描；渲染寻帧用）
    for (const [label, r] of Object.entries(def.labels)) {
      if (s.animFrame > r.index && s.animFrame <= r.index + r.duration) {
        s.actLabel = label;
        break;
      }
    }
    // owner 死亡退场（原版 finish 判定 || !owner.isAlive；customFunc 已先行清 attacker）
    if (owner === null || owner.hp <= 0) removed.push(s.id);
  }
  if (removed.length > 0) removeAssisters(ctx, removed);
}

function removeAssisters(ctx: SimCtx, ids: number[]): void {
  const set = new Set(ids);
  ctx.state.assisters = ctx.state.assisters.filter((a) => {
    if (set.has(a.id)) {
      ctx.emit('entity:despawn', { kind: 'assister', id: a.id });
      return false;
    }
    return true;
  });
}
