import { advancePlayerInput, Btn, InputView, type InputFrame } from './input.js';
import { hashState, stableStringify } from './serialize.js';
import {
  createInitialState,
  PLAYFIELD_HALF_WIDTH,
  type FighterState,
  type SimConfig,
  type SimState,
  type StageState,
} from './state.js';
import {
  ActionState,
  currentBodyRect,
  rectsOverlap,
  worldRect,
  type FighterDef,
  type FrameTrigger,
} from './fighter/def.js';
import {
  advanceAnimation,
  attackAreasWorld,
  endAction,
  enterDead,
  enterHurt,
  onLanded,
  stepIntentsFor,
  walkSpeed,
} from './fighter/machine.js';
import { createBehaviorRegistry, type BehaviorContext, type BehaviorHandler } from './fighter/behaviors.js';

// 物理帧常量（原版 BaseGameSprite/GameLogic 语义 × SPEED_PLUS=0.5，即
// 原版自己的 60fps 手感基准——见 DESIGN §3.1；空间容差类常量不乘系数）
//   重力斜坡：原版 applayG(12)/setInAir 的 _g（px/帧@30fps）→ 60Hz 减半
//   穿台阈值：原版 vy ≥ 5*SPEED_PLUS；吸附带/平台容差是空间量，保持原值
const GRAVITY_START = 2;
const GRAVITY_STEP = 0.6;
const GRAVITY_CAP = 6;
const GROUND_SNAP_BAND = 12;
const FALL_LAND_SPEED = 2.5;
const LAND_TOLERANCE = 10;
/** 地面滑行摩擦（受击/倒地滑行衰减；POC 取义，原版按 HURT_DAMPING 结算） */
const GROUND_FRICTION = 0.9;

/**
 * 速度线性衰减（原版 KyoUtils.num_wake：正负双向逼近 0）。
 */
function wake(v: number, k: number): number {
  if (k <= 0 || v === 0) return v;
  if (v > 0) {
    v -= k;
    return v < 0 ? 0 : v;
  }
  v += k;
  return v > 0 ? 0 : v;
}

/**
 * 表现事件（契约 §表现事件表）。
 * 新增事件类型必须在 ARCHITECTURE.md 事件表同 commit 登记。
 */
export interface SimEvent {
  tick: number;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * 快照 = 渲染唯一输入、对拍唯一基准、联机失步检测载体（DESIGN §3.8）。
 * state 为深拷贝，渲染层不得回读 sim 内部状态。
 */
export interface SimSnapshot {
  tick: number;
  hash: string;
  state: SimState;
  events: SimEvent[];
}

/**
 * 确定性模拟核心。唯一入口：sim.tick(inputs) → SimSnapshot。
 *
 * tick 管线八步顺序即契约（DESIGN §3.2），不得重排：
 *   1. 输入处理     位图 → 缓冲器 → 各角色意图
 *   2. 意图决策     状态机读取意图，尝试触发动作
 *   3. 物理积分     速度/阻尼/重力 → 地形 → 牵引边界修正
 *   4. 推挤         角色间 body AABB 按 heavy 系数互推
 *   5. [动画帧]     推进动画、刷新判定区、击飞状态机、帧触发器
 *   6. [动画帧]     命中判定与结算（固定顺序 P1→P2→道具→辅助）
 *   7. 流程事件     死亡、回合计时、比分、能量回复
 *   8. 输出         快照 + 表现事件队列 + 状态哈希
 */
export class Sim {
  private state: SimState;
  /** 角色运行时定义注册表（静态配置，不进 SimState；快照恢复时重新注入） */
  private defs: Map<number, FighterDef>;
  /** def.triggers 按帧号预索引（注册表构造时建立） */
  private triggerIndex: Map<number, Map<number, FrameTrigger[]>>;
  /** behaviors 处理器注册表（契约硬规则 7） */
  private behaviors: Record<string, BehaviorHandler>;
  /** 本 tick 的输入视图（瞬态，不进 SimState），与 fighters 同序 */
  private views: InputView[] = [];
  private events: SimEvent[] = [];

  constructor(config: SimConfig) {
    this.state = createInitialState(config);
    this.defs = new Map();
    this.triggerIndex = new Map();
    for (const fc of config.fighters) {
      if (fc.def) {
        this.defs.set(fc.id, fc.def);
        this.triggerIndex.set(fc.id, indexTriggers(fc.def));
      }
    }
    this.behaviors = createBehaviorRegistry({ endAct: endAction });
  }

  /** 从序列化状态恢复（rollback 预留接口，DESIGN §6）。角色定义须重新注入。 */
  static fromState(state: SimState, defs?: Iterable<[number, FighterDef]>): Sim {
    const sim = Object.create(Sim.prototype) as Sim;
    sim.state = structuredClone(state);
    sim.views = [];
    sim.events = [];
    sim.defs = new Map(defs ?? []);
    sim.triggerIndex = new Map();
    for (const [id, def] of sim.defs) sim.triggerIndex.set(id, indexTriggers(def));
    sim.behaviors = createBehaviorRegistry({ endAct: endAction });
    return sim;
  }

  serializeState(): string {
    return stableStringify(this.state);
  }

  static deserializeState(json: string): SimState {
    return JSON.parse(json) as SimState;
  }

  /** 角色定义注册表（rollback 恢复时回传 fromState 用）。 */
  getDefEntries(): [number, FighterDef][] {
    return [...this.defs.entries()];
  }

  tick(inputs: InputFrame): SimSnapshot {
    this.stepInputs(inputs); // 1. 输入处理
    this.stepIntents(); // 2. 意图决策
    this.stepPhysics(); // 3. 物理积分
    this.stepPush(); //    4. 推挤
    if (this.state.tick % 2 === 0) {
      this.stepAnimation(); // 5. [动画帧] 30Hz
      this.stepHitResolution(); // 6. [动画帧] 30Hz
    }
    this.stepMatchFlow(); // 7. 流程事件
    return this.stepOutput(); // 8. 输出
  }

  private emit(type: string, payload: Record<string, unknown>): void {
    this.events.push({ tick: this.state.tick, type, payload });
  }

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
  private resolveLanding(f: FighterState, stage: StageState): boolean {
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

  private defOf(f: FighterState): FighterDef | null {
    return this.defs.get(f.id) ?? null;
  }

  // 1. 输入处理：位图 → 缓冲器 → 输入视图
  private stepInputs(inputs: InputFrame): void {
    const masks = [inputs.p1, inputs.p2];
    this.views = this.state.fighters.map((f, i) =>
      advancePlayerInput(f.input, masks[i] ?? 0),
    );
  }

  // 2. 意图决策：状态机读取意图尝试触发动作（多实体按 id 升序）
  private stepIntents(): void {
    const { fighters } = this.state;
    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i]!;
      const def = this.defOf(f);
      // 朝向：仅可行动状态自动面向对手（攻击/受击锁定，原版 direct 语义）
      if (
        (f.actionState === ActionState.NORMAL ||
          f.actionState === ActionState.JUMP_ING) &&
        f.hp > 0
      ) {
        const other = fighters[i === 0 ? 1 : 0];
        if (other) f.facing = other.x >= f.x ? 1 : -1;
      }
      stepIntentsFor(f, def, this.views[i]!);
    }
  }

  // 3. 物理积分（行走 + 显式速度/阻尼 + 重力斜坡 + 多段地板落地 + 牵引边界）
  private stepPhysics(): void {
    const { stage, fighters } = this.state;
    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i]!;
      const view = this.views[i]!;
      const def = this.defOf(f);
      const wasAirborne = !f.onGround;
      // 行走：仅 NORMAL 且在地面（原版 renderFloorAction）；其余状态保留惯性
      if (f.actionState === ActionState.NORMAL && f.onGround && f.hp > 0) {
        let dir = 0;
        if (view.held(Btn.left)) dir -= 1;
        if (view.held(Btn.right)) dir += 1;
        f.vx = dir * walkSpeed(def);
      } else if (f.onGround && f.actionState !== ActionState.JUMP_ING) {
        // 地面滑行摩擦（受击/倒地/死亡滑行）
        f.vx = wake(f.vx, GROUND_FRICTION);
      }
      // 速度线性衰减（原版 renderVelocity + KyoUtils.num_wake）
      f.vx = wake(f.vx, f.dampX);
      f.vy = wake(f.vy, f.dampY);
      f.x += f.vx;
      f.y += f.vy;
      const airborne = this.resolveLanding(f, stage);
      if (airborne) {
        // 重力斜坡（原版 applayG(12)：上升段清零；下落段每 tick 递增后施为位移）
        if (f.vy < 0) {
          f.gRamp = 0;
        } else {
          f.gRamp = Math.min(f.gRamp + GRAVITY_STEP, GRAVITY_CAP);
          f.y += f.gRamp;
        }
        f.onGround = false;
      } else {
        // 落地瞬间预置下次离地的初值（原版 setInAir(false) → _g=4）
        f.gRamp = GRAVITY_START;
        if (wasAirborne) onLanded(f, def);
        f.onGround = true;
      }
    }
    // 牵引边界（ADR-4）：版边 = 两角色中点 ± PLAYFIELD_HALF_WIDTH，clamp 到地图边界。
    // 相机不进模拟（契约硬规则 5）。
    this.clampPlayfield();
  }

  private clampPlayfield(): void {
    const { stage, fighters } = this.state;
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
        f.x = Math.min(Math.max(f.x, left), right);
      }
    }
  }

  // 4. 推挤：body AABB 重叠时按 heavy 系数互推（原版 checkBodyHit 最小子集）
  private stepPush(): void {
    const { stage, fighters } = this.state;
    if (fighters.length !== 2) return;
    const [a, b] = fighters as [FighterState, FighterState];
    const defA = this.defOf(a);
    const defB = this.defOf(b);
    if (!defA || !defB) return;
    if (
      a.hp <= 0 ||
      b.hp <= 0 ||
      a.actionState === ActionState.HURT_FLYING ||
      b.actionState === ActionState.HURT_FLYING
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

  // 5. [动画帧] 动画推进 / 判定区刷新 / 帧触发器（判定区在命中判定时按帧查询）
  private stepAnimation(): void {
    const { fighters, stage } = this.state;
    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i]!;
      const def = this.defOf(f);
      if (!def) {
        advanceAnimation(f, null);
        continue;
      }
      // 帧触发器（behaviors 注册表分派；同帧触发按注册顺序执行）
      const byFrame = this.triggerIndex.get(f.id);
      advanceAnimation(f, def, (frame) => {
        const list = byFrame?.get(frame);
        if (!list) return;
        const ctx: BehaviorContext = {
          f,
          def,
          fighters,
          stage,
          emit: (type, payload) => this.emit(type, payload),
        };
        for (const t of list) {
          const handler = this.behaviors[t.op];
          if (handler) handler(ctx, t.args);
        }
      });
    }
  }

  // 6. [动画帧] 命中判定与结算（固定顺序 P1→P2；道具/辅助后续切片接入）
  private stepHitResolution(): void {
    const { fighters } = this.state;
    for (const atk of fighters) {
      const atkDef = this.defOf(atk);
      if (atk.actionState !== ActionState.ATTACK_ING || !atkDef) continue;
      const hit = atkDef.actions[atk.attackId!];
      if (!hit) continue;
      const areas = attackAreasWorld(atk, atkDef);
      if (areas.length === 0) continue;
      for (const tgt of fighters) {
        if (tgt.id === atk.id) continue;
        if (tgt.hp <= 0 || tgt.actionState === ActionState.DEAD) continue;
        if (atk.attackHit.includes(tgt.id)) continue;
        const tgtDef = this.defOf(tgt);
        const bodyLocal = tgtDef
          ? currentBodyRect({ animFrame: tgt.animFrame, def: tgtDef })
          : null;
        if (!bodyLocal) continue;
        const body = worldRect(tgt, bodyLocal);
        const hitArea = areas.find((r) => rectsOverlap(r, body));
        if (!hitArea) continue;
        atk.attackHit.push(tgt.id);
        this.applyHit(atk, tgt, tgtDef, hit, hitArea);
      }
    }
  }

  /** 命中结算（原版 beHit/doHurt 最小子集：扣血 → 死亡/钢身/受击）。 */
  private applyHit(
    attacker: FighterState,
    target: FighterState,
    targetDef: FighterDef | null,
    hit: { power: number; hitType: number; hitx: number; hity: number; hurtTime: number; hurtType: number; isBreakDef: boolean },
    hitArea: { x: number; y: number; w: number; h: number },
  ): void {
    target.hp = Math.max(0, target.hp - hit.power);
    this.emit('hit:connect', {
      attacker: attacker.id,
      target: target.id,
      hitType: hit.hitType,
      power: hit.power,
      x: hitArea.x + hitArea.w / 2,
      y: hitArea.y + hitArea.h / 2,
    });
    if (target.hp <= 0) {
      enterDead(target, targetDef);
      this.emit('fighter:ko', { fighter: target.id });
      return;
    }
    if (target.steelBody) return; // 钢身：掉血但无受击状态变化（原版 doSteelHurt 子集）
    enterHurt(target, targetDef, hit, attacker.facing, !target.onGround);
  }

  // 7. 流程事件：回合计时（死亡/比分随回合流程后续切片接入）
  private stepMatchFlow(): void {
    if (this.state.tick === 0) {
      this.emit('round:start', { round: this.state.match.round });
    }
    this.state.match.roundFrame += 1;
  }

  // 8. 输出：快照 + 表现事件队列 + 状态哈希
  private stepOutput(): SimSnapshot {
    const snapshot: SimSnapshot = {
      tick: this.state.tick,
      hash: hashState(this.state),
      state: structuredClone(this.state),
      events: this.events,
    };
    this.events = [];
    this.state.tick += 1;
    return snapshot;
  }
}

/** def.triggers → 帧 → 触发列表（保持注册顺序）。 */
function indexTriggers(def: FighterDef): Map<number, FrameTrigger[]> {
  const map = new Map<number, FrameTrigger[]>();
  for (const t of def.triggers) {
    const list = map.get(t.frame);
    if (list) list.push(t);
    else map.set(t.frame, [t]);
  }
  return map;
}
