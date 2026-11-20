import { Btn, type InputView } from '../input.js';
import { FZQI_MAX, type CutinLockState } from '../state.js';
import { ActionState, currentBodyRect, rectsOverlap, worldRect } from '../fighter/def.js';
import { advanceAnimation, setLabel, stepIntentsFor } from '../fighter/machine.js';
import { evaluateTriggerCondition, type BehaviorContext } from '../fighter/behaviors.js';
import type { SimCtx } from './ctx.js';

/** 站立自动面向对手的间隔（原版 renderAnimate：站立态计数 >5 即每 6 帧一次） */
const AUTO_FACE_INTERVAL = 6;

// 2. 意图决策：状态机读取意图尝试触发动作（多实体按 id 升序）
export function stepIntents(ctx: SimCtx, views: InputView[]): void {
  const { fighters } = ctx.state;
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i]!;
    const def = ctx.defOf(f);
    const view = views[i]!;
    // 朝向按状态分流（原版语义）：
    //   站立待机：自动面向对手（原版 renderAnimate 仅 currentFrameName=="站立"
    //     时计数，>5 帧 setDirectToTarget → 每 6 帧一次；用 tick 取模等价实现）
    //   行走：方向键决定（原版 renderMoving：moveLEFT→direct=-1，
    //     moveRIGHT→direct=1），可背对对手移动，停下回站立后自动转回
    //   跳跃：保持起跳时朝向（原版 doJump 不改 direct）
    //   防御：方向键决定（原版 renderDefense），转向时重播抬手段
    if (f.actionState === ActionState.NORMAL && f.hp > 0) {
      const other = fighters[i === 0 ? 1 : 0];
      if (f.actLabel === '站立') {
        if (other && ctx.state.tick % AUTO_FACE_INTERVAL === 0) {
          f.facing = other.x >= f.x ? 1 : -1;
        }
      } else if (f.actLabel === '走') {
        if (view.held(Btn.left)) f.facing = -1;
        else if (view.held(Btn.right)) f.facing = 1;
      }
    } else if (f.actionState === ActionState.DEFENCE_ING) {
      const def = ctx.defOf(f);
      const dir = view.held(Btn.left) ? -1 : view.held(Btn.right) ? 1 : 0;
      if (dir !== 0 && f.facing !== dir) {
        f.facing = dir as 1 | -1;
        // 原版 renderDefense 转向分支：setDefenseAction 重播抬手
        //（goFrame("防御", true, 3)——从首帧重放，定格逻辑见 advanceAnimation）
        const range = def?.labels['防御'];
        if (range) f.animFrame = range.index + 1;
      }
    }
    // 摔技目标判定需要对手状态（allowCatch）；双人模型取另一角色
    const other = fighters[i === 0 ? 1 : 0] ?? null;
    stepIntentsFor(f, def, view, other, other !== null ? ctx.defOf(other) : null);
    // 辅助召唤（原版 FighterMcCtrler.renderAssist）：NORMAL/DEFENCE +
    // 辅助键 + fzqi 满 → fzqi 清零并召唤。偏离记录：被动辅助冷却
    // （isUsedPassiveCdIng）依赖未建模的被动辅助语料，不实现。
    if (
      view.justDown(Btn.assist) &&
      (f.actionState === ActionState.NORMAL ||
        f.actionState === ActionState.DEFENCE_ING) &&
      f.hp > 0 &&
      f.fzqi >= FZQI_MAX &&
      !ctx.state.assisters.some((a) => a.ownerId === f.id)
    ) {
      view.consume(Btn.assist);
      ctx.spawnAssister(f);
    }
  }
}

// 5. [动画帧] 动画推进 / 判定区刷新 / 帧触发器（判定区在命中判定时按帧查询）。
// cutinLock（切片 22）：特写冻结期只推进锁主的时间轴。
export function stepAnimation(ctx: SimCtx, cutinLock?: CutinLockState): void {
  const { fighters, stage } = ctx.state;
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i]!;
    if (cutinLock && !(cutinLock.kind === 'fighter' && cutinLock.id === f.id)) continue;
    const def = ctx.defOf(f);
    if (!def) {
      advanceAnimation(f, null);
      continue;
    }
    // 帧触发器（behaviors 注册表分派；同帧触发按注册顺序执行；
    // 索引按当前形态寻址——形态切换后即用新形态时间轴）
    const byFrame = ctx.triggerIndex.get(f.id)?.get(f.formIndex);
    advanceAnimation(f, def, (frame) => {
      const list = byFrame?.get(frame);
      if (!list) return;
      const ctx2: BehaviorContext = {
        f,
        def,
        fighters,
        stage,
        emit: (type, payload) => ctx.emit(type, payload),
        spawnBullet: (spec) => ctx.spawnBullet(spec),
        spawnAttacker: (spec) => ctx.spawnAttacker(spec),
        switchForm: (g, frameNum) => ctx.doSwitchForm(g, frameNum),
        setCutin: (kind) => ctx.setCutin('fighter', f.id, kind),
        setSlowDown: (t) => ctx.setSlowDown(t),
      };
      for (const t of list) {
        if (t.cond) {
          // 条件触发（切片 11）：cond 求值 → then/else 分支体内调用依次分派
          const branch = evaluateTriggerCondition(t.cond, ctx2) ? t.then : t.else;
          for (const c of branch ?? []) {
            const h = ctx.behaviors[c.op];
            if (h) h(ctx2, c.args, c.target);
          }
          continue;
        }
        const handler = ctx.behaviors[t.op];
        if (handler) handler(ctx2, t.args, t.target);
      }
    });
    // 命中续接检查（原版 FighterMcCtrler：checker 判定区与目标身体相交
    // → 切续接标签并清除；每动画帧检查，触发器之后）
    if (f.hitTargetChecker !== null && f.hitTarget !== null) {
      const t = fighters.find((o) => o.id !== f.id) ?? null;
      const tDef = t !== null ? ctx.defOf(t) : null;
      const area = (def.areas[f.animFrame] ?? []).find(
        (a) => a.name === f.hitTargetChecker,
      );
      const bodyLocal =
        t !== null && tDef !== null
          ? currentBodyRect({ animFrame: t.animFrame, def: tDef })
          : null;
      if (
        area !== undefined &&
        t !== null &&
        bodyLocal !== null &&
        rectsOverlap(worldRect(f, area), worldRect(t, bodyLocal))
      ) {
        setLabel(f, def, f.hitTarget);
        f.hitTargetChecker = null;
        f.hitTarget = null;
      }
    }
  }
  // 辅助实体推进（30Hz：帧触发器/循环触发/退场判定；切片 12）
  // 特写冻结（切片 22）：cutinLock 锁主为辅助时只推进锁主
  ctx.stepAssisterAnimation(cutinLock);
}
