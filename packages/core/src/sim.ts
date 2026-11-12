import { advancePlayerInput, Btn, InputView, type InputFrame } from './input.js';
import { hashState, stableStringify } from './serialize.js';
import {
  createInitialState,
  DEFAULT_HP,
  ENERGY_GAP_TICKS,
  ENERGY_MAX,
  FZQI_ADD_PERFRAME,
  FZQI_MAX,
  PLAYFIELD_HALF_WIDTH,
  type AssisterState,
  type AttackerState,
  type BulletState,
  type FighterState,
  type SimConfig,
  type SimState,
  type StageState,
} from './state.js';
import {
  ActionState,
  currentBodyRect,
  isAttackingState,
  rectsOverlap,
  SPEED_PLUS,
  worldRect,
  type AssisterDef,
  type AreaRect,
  type FighterDef,
  type FrameTrigger,
  type HitDef,
} from './fighter/def.js';
import {
  attackRateOf,
  defaultAssisterBehaviors,
  defenseDamageScale,
  evaluateLoopCond,
  isAttributeHit,
  isPhysicalHit,
  tickBuffs,
  type AssisterContext,
  type AssisterHandler,
  type AssistBulletSpawnSpec,
  type AssistAttackerSpawnSpec,
} from './fighter/assister.js';
import {
  advanceAnimation,
  applyJumpLaunch,
  endAction,
  endActAction,
  enterDead,
  enterGuardBreak,
  enterHurt,
  defenseGapTicks,
  defenseHoldTicks,
  hitZonesWorld,
  onLanded,
  setLabel,
  stepGhost,
  stepIntentsFor,
  switchForm,
  walkSpeed,
} from './fighter/machine.js';
import {
  createBehaviorRegistry,
  evaluateTriggerCondition,
  type AttackerParams,
  type AttackerSpawnSpec,
  type BehaviorContext,
  type BehaviorHandler,
  type BulletSpawnSpec,
} from './fighter/behaviors.js';

// 物理帧常量（原版 BaseGameSprite/GameLogic 语义 × SPEED_PLUS=0.5，即
// 原版自己的 60fps 手感基准——见 DESIGN §3.1；空间容差类常量不乘系数）
//   重力斜坡：原版 applayG(12) 的 _g（原始空间）每帧 +G_ADD×SPEED_PLUS=0.6、
//   上限 12，位移 = _g×SPEED_PLUS → 60Hz 位移空间 = 步长 +0.3/tick、上限 6
//   （落到位移空间直接结算，不再乘系数——修复批次 19 修正：此前步长误减半成
//   0.6，下落加速比原版快 2 倍）；穿台阈值/吸附带/平台容差是空间量，保持原值
const GRAVITY_START = 2;
const GRAVITY_STEP = 0.3;
const GRAVITY_CAP = 6;
const GROUND_SNAP_BAND = 12;
const FALL_LAND_SPEED = 2.5;
const LAND_TOLERANCE = 10;
/** 地面滑行摩擦（受击/倒地滑行衰减；POC 取义，原版按 HURT_DAMPING 结算） */
const GROUND_FRICTION = 0.9;

// —— 能量（原版 GameConfig/FighterMain，速率 ×SPEED_PLUS=0.5，ADR-12） ——
// ENERGY_GAP_TICKS 从 state.js 导入（机器与 sim 共用）
const ENERGY_ADD_NORMAL = 1; // 2 × 0.5
const ENERGY_ADD_DEFENSE = 0.4; // 0.8 × 0.5
const ENERGY_ADD_ATTACKING = 0.55; // 1.1 × 0.5
const ENERGY_ADD_OVERLOAD = 0.3; // 0.6 × 0.5
/** 防御削血比例（原版 DEFENSE_LOSE_HP_RATE，比例量不折算） */
const DEFENSE_LOSE_HP_RATE = 0.05;
/** 防御命中击退衰减（原版 DEFENSE_DAMPING_X=1@30fps → 0.5/tick） */
const DEFENSE_DAMP_X = 0.5;
/** 训练模式血量回复（POC 取义） */
const TRAINING_REGEN = 2;

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
/** 站立自动面向对手的间隔（原版 renderAnimate：站立态计数 >5 即每 6 帧一次） */
const AUTO_FACE_INTERVAL = 6;
/** 独立道具寿命占位（素材缺口：内层时间轴未导出，切片 10 收紧） */
/** 无元件时间轴（animTotal=0）时 attacker 的占位寿命回退（原版无此机制）。 */
const ATTACKER_LIFE_TICKS = 120;

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

/** 向目标点步进一步（吸附速度换算后值；speed≤0 直接吸附）。 */
function stepToward(v: number, target: number, speed: number): number {
  if (speed <= 0 || v === target) return target;
  const d = target - v;
  return d > 0 ? v + Math.min(d, speed) : v + Math.max(d, -speed);
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
  /** 多形态定义注册表（fighter id → 形态数组，静态配置不进 SimState；
   *  快照恢复时重新注入。forms[formIndex] 为当前形态）。 */
  private formsById: Map<number, FighterDef[]>;
  /** def.triggers 按帧号预索引：fighter id → formIndex → 帧 → 触发列表 */
  private triggerIndex: Map<number, Map<number, Map<number, FrameTrigger[]>>>;
  /** 辅助定义注册表（assistId → def，静态配置不进 SimState） */
  private assisterDefs: Map<string, AssisterDef>;
  /** 辅助 def.triggers 按帧号预索引：assistId → 帧 → 触发列表 */
  private assisterTriggerIndex: Map<string, Map<number, FrameTrigger[]>>;
  /** behaviors 处理器注册表（契约硬规则 7） */
  private behaviors: Record<string, BehaviorHandler>;
  /** 辅助 behaviors 处理器注册表（切片 12） */
  private assisterBehaviors: Record<string, AssisterHandler>;
  /** 本 tick 的输入视图（瞬态，不进 SimState），与 fighters 同序 */
  private views: InputView[] = [];
  private events: SimEvent[] = [];
  /** 训练模式（SimConfig.training）：假人不 KO、血量恒定回复。 */
  private training: boolean;

  constructor(config: SimConfig) {
    this.state = createInitialState(config);
    this.training = config.training ?? false;
    this.formsById = new Map();
    this.triggerIndex = new Map();
    for (const fc of config.fighters) {
      const forms = fc.forms ?? (fc.def ? [fc.def] : []);
      if (forms.length > 0) {
        this.formsById.set(fc.id, forms);
        this.triggerIndex.set(
          fc.id,
          new Map(forms.map((d, i) => [i, indexTriggers(d)])),
        );
      }
    }
    this.assisterDefs = new Map(Object.entries(config.assistants ?? {}));
    this.assisterTriggerIndex = new Map(
      [...this.assisterDefs].map(([id, d]) => [id, indexTriggers(d)]),
    );
    this.behaviors = createBehaviorRegistry({
      endAct: endActAction,
      releaseGrab: (f) => this.releaseGrab(f),
      spawnBullet: (spec) => this.spawnBullet(spec),
      spawnAttacker: (spec) => this.spawnAttacker(spec),
      switchForm: (f, frame) => this.doSwitchForm(f, frame),
    });
    this.assisterBehaviors = defaultAssisterBehaviors;
  }

  /** 从序列化状态恢复（rollback 预留接口，DESIGN §6）。角色定义须重新注入；
   *  SimConfig 的非状态开关（training）与辅助定义注册表经 opts 回传。
   *  defs 为 getDefEntries() 的回传（同一 id 可有多形态条目，按注册顺序归组）。 */
  static fromState(
    state: SimState,
    defs?: Iterable<[number, FighterDef]>,
    opts?: { training?: boolean; assistants?: Record<string, AssisterDef> },
  ): Sim {
    const sim = Object.create(Sim.prototype) as Sim;
    sim.state = structuredClone(state);
    sim.views = [];
    sim.events = [];
    sim.training = opts?.training ?? false;
    sim.formsById = new Map();
    sim.triggerIndex = new Map();
    sim.assisterDefs = new Map(Object.entries(opts?.assistants ?? {}));
    sim.assisterTriggerIndex = new Map(
      [...sim.assisterDefs].map(([id, d]) => [id, indexTriggers(d)]),
    );
    if (defs) {
      for (const [id, def] of defs) {
        const forms = sim.formsById.get(id);
        if (forms) forms.push(def);
        else sim.formsById.set(id, [def]);
      }
      for (const [id, forms] of sim.formsById) {
        sim.triggerIndex.set(
          id,
          new Map(forms.map((d, i) => [i, indexTriggers(d)])),
        );
      }
    }
    sim.behaviors = createBehaviorRegistry({
      endAct: endActAction,
      releaseGrab: (f) => sim.releaseGrab(f),
      spawnBullet: (spec) => sim.spawnBullet(spec),
      spawnAttacker: (spec) => sim.spawnAttacker(spec),
      switchForm: (f, frame) => sim.doSwitchForm(f, frame),
    });
    sim.assisterBehaviors = defaultAssisterBehaviors;
    return sim;
  }

  serializeState(): string {
    return stableStringify(this.state);
  }

  static deserializeState(json: string): SimState {
    return JSON.parse(json) as SimState;
  }

  /** 角色定义注册表（rollback 恢复时回传 fromState 用）。
   *  多形态角色每个形态一条目（同 id 多条，按形态序）。 */
  getDefEntries(): [number, FighterDef][] {
    const out: [number, FighterDef][] = [];
    for (const [id, forms] of this.formsById) {
      for (const d of forms) out.push([id, d]);
    }
    return out;
  }

  /** 辅助定义注册表（rollback 恢复时回传 fromState 用）。 */
  getAssisterDefs(): Record<string, AssisterDef> {
    return Object.fromEntries(this.assisterDefs);
  }

  /** 当前生效形态定义（FighterState.formIndex 寻址；越界回退首形态）。 */
  private defOf(f: FighterState): FighterDef | null {
    const forms = this.formsById.get(f.id);
    if (!forms || forms.length === 0) return null;
    return forms[Math.min(f.formIndex, forms.length - 1)] ?? null;
  }

  /** doWanKai/switchForm 桥：形态切换 + 表现事件（render 换图集形态用）。
   *  切换后保持 WAN_KAI_ING，由新形态 开场 播完经 endAction 回位。 */
  private doSwitchForm(f: FighterState, frame: number): void {
    const forms = this.formsById.get(f.id);
    if (!forms) return;
    const next = switchForm(f, forms, frame);
    if (next) {
      this.emit('fighter:form', { fighter: f.id, form: next.formIndex });
    }
  }

  tick(inputs: InputFrame): SimSnapshot {
    this.stepInputs(inputs); // 1. 输入处理
    this.stepIntents(); // 2. 意图决策
    this.stepPhysics(); // 3. 物理积分
    this.stepPush(); //    4. 推挤
    if (this.state.tick % 2 === 0) {
      this.stepAnimation(); // 5. [动画帧] 30Hz
      this.stepHitResolution(); // 6. [动画帧] 30Hz
      this.stepBulletAnim(); //    [动画帧] 30Hz（原版 Bullet.renderAnimate）
      this.stepAttackerAnim(); // [动画帧] 30Hz（原版 FighterAttacker.renderAnimate）
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
      const view = this.views[i]!;
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
          if (other && this.state.tick % AUTO_FACE_INTERVAL === 0) {
            f.facing = other.x >= f.x ? 1 : -1;
          }
        } else if (f.actLabel === '走') {
          if (view.held(Btn.left)) f.facing = -1;
          else if (view.held(Btn.right)) f.facing = 1;
        }
      } else if (f.actionState === ActionState.DEFENCE_ING) {
        const def = this.defOf(f);
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
      stepIntentsFor(f, def, view, other, other !== null ? this.defOf(other) : null);
      // 辅助召唤（原版 FighterMcCtrler.renderAssist）：NORMAL/DEFENCE +
      // 辅助键 + fzqi 满 → fzqi 清零并召唤。偏离记录：被动辅助冷却
      // （isUsedPassiveCdIng）依赖未建模的被动辅助语料，不实现。
      if (
        view.justDown(Btn.assist) &&
        (f.actionState === ActionState.NORMAL ||
          f.actionState === ActionState.DEFENCE_ING) &&
        f.hp > 0 &&
        f.fzqi >= FZQI_MAX &&
        !this.state.assisters.some((a) => a.ownerId === f.id)
      ) {
        view.consume(Btn.assist);
        this.spawnAssister(f);
      }
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
      // 瞬身步推进（原版 renderGhostStep；结束回位/恢复速度/发事件）
      stepGhost(f, def, (g) => {
        this.emit('effect', { id: 'endGhostStep', x: g.x, y: g.y, params: {} });
      });
      // 行走：NORMAL 且在地面（原版 renderFloorAction）；airMove（飞行系）空中也可；
      // 瞬身步期间速度由瞬身步驱动（原版画面冻结期不受输入）。
      // 地面行走仅在待机标签族（站立/走）且无标签锁时施加（修复批次 20）：
      // 原版移动由 moveLeft/moveRight 槽驱动（doMove→goFrame("走")），落地/
      // 收招等收尾标签期间槽已清空、输入不产生位移；移植版曾只按状态门，
      // 落地 labelLock 窗口内持续置 vx → 站立姿势原地滑步（实测批 20 之一）。
      // airMove（飞行系空中）不受标签门约束。
      if (
        f.actionState === ActionState.NORMAL &&
        (f.onGround || f.airMove) &&
        f.hp > 0 &&
        f.ghostTicks === 0 &&
        (!f.onGround ||
          def === null ||
          f.actLabel === null || // 出生首帧未采样（advanceAnimation 首轮才置 站立）
          (f.labelLock <= 0 && (f.actLabel === '站立' || f.actLabel === '走')))
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
      f.x += f.vx;
      f.y += f.vy;
      const airborne = this.resolveLanding(f, stage);
      if (airborne) {
        // 重力斜坡（原版 applayG(12)：上升段清零；下落段每 tick 递增后施为位移；
        // isApplyG=false（飞行系）不施加重力）
        if (!f.applyG) {
          // 悬停：无重力位移
        } else if (f.vy < 0) {
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
      // 起跳延迟（原版 renderJumpAnimate：延迟计满才施加跳跃速度并消耗
      // jumpTimes——放在积分后，首个上升位移出现在下一 tick）
      if (f.jumpDelay > 0) {
        f.jumpDelay -= 1;
        if (f.jumpDelay === 0) applyJumpLaunch(f, def);
      }
    }
    // 飞行道具推进（原版 Bullet.render：每 tick 位移/加速/钳制/寿命/出界）
    this.stepBullets();
    // 独立道具推进（原版 FighterAttacker.render：follow 重定位/重力/寿命占位）
    this.stepAttackers();
    // 辅助实体推进（原版 BaseGameSprite 物理 × SPEED_PLUS + 重力斜坡；切片 12）
    this.stepAssisterPhysics();
    // 抓取吸附施加（原版 FighterMC.moveTarget：把目标吸向自身锚点）
    this.stepMoveTargets();
    // 牵引边界（ADR-4）：版边 = 两角色中点 ± PLAYFIELD_HALF_WIDTH，clamp 到地图边界。
    // 相机不进模拟（契约硬规则 5）。
    this.clampPlayfield();
  }

  /** 飞行道具每 tick 推进（原版 Bullet.render；speedLevel 命中减速原版未接，略）。 */
  private stepBullets(): void {
    const { stage, bullets } = this.state;
    const removed: number[] = [];
    for (const b of bullets) {
      // 命中残留段（原版 _isHit → render 早退）：停移动，仅时间轴推进
      if (b.hitAnim) continue;
      // 位移（局部空间速度；x 沿发射朝向）+ 加速（add×2×SPEED_PLUS = add/tick）
      b.x += b.sx * SPEED_PLUS * b.facing;
      b.y += b.sy * SPEED_PLUS;
      b.sx += b.addX;
      b.sy += b.addY;
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
    if (removed.length > 0) this.removeBullets(removed);
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
  private stepBulletAnim(): void {
    const { bullets } = this.state;
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
    if (removed.length > 0) this.removeBullets(removed);
  }

  /**
   * 独立道具内层时间轴推进（原版 FighterAttacker.renderAnimate）：逐动画帧
   * nextFrame，currentFrame == totalFrames-1 → removeSelf（off-by-one 原样
   * 保留）。与 Bullet 不同：类内无标签分派（loop/remove 等是 Bullet 专属
   * 语义），故纯推进不查标签——语料 32 个 attacker 元件全部多帧且无 loop
   * 标签，播尽移除全覆盖。发射 tick 在 stepHitResolution 先于本步（同
   * bullet 节奏）：生成帧 animFrame 已为 2。
   */
  private stepAttackerAnim(): void {
    const { attackers } = this.state;
    const removed: number[] = [];
    for (const a of attackers) {
      if (a.animTotal <= 0) continue;
      if (a.animFrame < a.animTotal) a.animFrame += 1;
      if (a.animFrame === a.animTotal - 1) removed.push(a.id);
    }
    if (removed.length > 0) this.removeAttackers(removed);
  }

  /**
   * 飞行道具死亡（原版 Bullet.doHit）：停命中，有元件时间轴则进入残留段
   * （跳 hit 标签段；无标签原地停住播尽），entity:despawn 延后到播尽——
   * 命中残留演出随 despawn 收紧（切片 13-A3）。无动画数据时保持旧行为
   * （立即移除）。
   */
  private killBullet(b: BulletState): void {
    b.hitAble = false;
    if (b.animTotal <= 0) {
      this.despawnBullet(b.id);
      return;
    }
    b.hitAnim = true;
    const hitFrame = b.animLabels['hit'];
    if (hitFrame !== undefined) b.animFrame = hitFrame;
  }

  /** 发射（behaviors.fire 引擎桥）：判定区换算世界坐标 + 参数换算入 SimState。 */
  private spawnBullet(spec: BulletSpawnSpec): void {
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
      id: this.state.nextEntityId,
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
    };    this.state.nextEntityId += 1;
    this.state.bullets.push(bullet);
    this.state.bullets.sort((a, b) => a.id - b.id);
    this.emit('entity:spawn', { kind: 'bullet', id: bullet.id, name: bullet.name, owner: owner.id });
  }

  private removeBullets(ids: number[]): void {
    const set = new Set(ids);
    this.state.bullets = this.state.bullets.filter((b) => {
      if (set.has(b.id)) {
        this.emit('entity:despawn', { kind: 'bullet', id: b.id });
        return false;
      }
      return true;
    });
  }

  /**
   * 生成独立道具（behaviors.addAttacker 引擎桥；原版 FighterAttacker.init）。
   * 位置：x 轴沿朝向镜像；moveToTarget 轴改以 target 为基准。
   * 偏离：命中矩形占位见 state.ts AttackerState 注；range 轴语料未出现，不支持（确定性静默）。
   */
  private spawnAttacker(spec: AttackerSpawnSpec): void {
    const { owner, name, local, hit, hitId, params } = spec;
    this.spawnAttackerEntity({
      anchor: owner,
      ownerId: owner.id,
      targetOf: this.state.fighters.find((f) => f.id !== owner.id) ?? null,
      name,
      local,
      hit,
      hitId,
      anim: spec.anim,
      params,
      viaAssist: false,
    });
  }

  /**
   * 辅助生成独立道具（assister.addAttacker 引擎桥；原版同 FighterAttacker，
   * owner = 辅助实体）：位置锚/朝向取辅助实体，命中回气归召唤者
   * （原版 getOwnerFighter 回溯），渲染图集走辅助侧（viaAssist）。
   */
  private spawnAssistAttacker(spec: AssistAttackerSpawnSpec): void {
    const owner = this.state.fighters.find((f) => f.id === spec.ownerId) ?? null;
    this.spawnAttackerEntity({
      anchor: spec.self,
      ownerId: spec.ownerId,
      targetOf:
        owner !== null ? this.state.fighters.find((f) => f.id !== owner.id) ?? null : null,
      name: spec.name,
      local: spec.local,
      hit: spec.hit,
      hitId: spec.hitId,
      anim: spec.anim,
      params: spec.params,
      viaAssist: true,
    });
  }

  private spawnAttackerEntity(args: {
    anchor: { x: number; y: number; facing: 1 | -1 };
    ownerId: number;
    targetOf: FighterState | null;
    name: string;
    local: AreaRect;
    hit: HitDef | null;
    hitId: string | null;
    anim?: { totalFrames: number; labels: Record<string, number> } | undefined;
    params: AttackerParams;
    viaAssist: boolean;
  }): void {
    const { anchor, ownerId, targetOf: t, name, local, hit, hitId, anim, params, viaAssist } = args;
    const centerX = local.x + local.w / 2;
    const centerY = local.y + local.h / 2;
    const axisX = typeof params.x === 'object' && params.x !== null ? params.x : null;
    const axisY = typeof params.y === 'object' && params.y !== null ? params.y : null;
    const startX = typeof params.x === 'number' ? params.x + centerX : axisX?.offset ?? centerX;
    const startY = typeof params.y === 'number' ? params.y + centerY : axisY?.offset ?? centerY;
    let cx = anchor.x + startX * anchor.facing;
    let cy = anchor.y + startY;
    if (axisX?.moveToTarget === true && t !== null) cx = t.x + startX * anchor.facing;
    if (axisY?.moveToTarget === true && t !== null) cy = t.y + startY;
    const attacker: AttackerState = {
      id: this.state.nextEntityId,
      ownerId,
      facing: anchor.facing,
      name,
      x: cx - local.w / 2,
      y: cy - local.h / 2,
      w: local.w,
      h: local.h,
      offsetX: startX,
      offsetY: startY,
      followX: axisX?.followTarget === true,
      followY: axisY?.followTarget === true,
      applyG: params.applyG === true,
      gRamp: 0,
      holdTicks: ATTACKER_LIFE_TICKS,
      animTotal: anim?.totalFrames ?? 0,
      animFrame: 1,
      hit: hit !== null ? { ...hit } : null,
      hitId,
      hitAble: true,
      viaAssist,
    };
    this.state.nextEntityId += 1;
    this.state.attackers.push(attacker);
    this.state.attackers.sort((a, b) => a.id - b.id);
    this.emit('entity:spawn', { kind: 'attacker', id: attacker.id, name: attacker.name, owner: ownerId });
  }

  /** 独立道具每 tick 推进：follow 轴重定位 / 重力 / 回退寿命（动画推进在 stepAttackerAnim）。 */
  private stepAttackers(): void {
    const { stage, fighters, attackers } = this.state;
    const removed: number[] = [];
    for (const a of attackers) {
      const t = fighters.find((f) => f.id !== a.ownerId) ?? null;
      // followTarget：中心重定位到 target + 局部偏移（x 沿道具朝向镜像）；
      // 非 follow 轴生成后固定（原版 attacker 是绝对定位实体）
      if (a.followX && t !== null) a.x = t.x + a.offsetX * a.facing - a.w / 2;
      if (a.followY && t !== null) a.y = t.y + a.offsetY - a.h / 2;
      if (a.applyG) {
        const bottom = a.y + a.h;
        if (bottom >= stage.groundY) {
          a.y = stage.groundY - a.h;
          a.gRamp = GRAVITY_START;
        } else {
          a.gRamp = Math.min(a.gRamp + GRAVITY_STEP, GRAVITY_CAP);
          a.y += a.gRamp;
        }
      }
      // 寿命：有元件时间轴由 stepAttackerAnim 播尽移除；无时间轴走占位回退
      if (a.animTotal <= 0 && --a.holdTicks <= 0) removed.push(a.id);
    }
    if (removed.length > 0) this.removeAttackers(removed);
  }

  private removeAttackers(ids: number[]): void {
    const set = new Set(ids);
    this.state.attackers = this.state.attackers.filter((a) => {
      if (set.has(a.id)) {
        this.emit('entity:despawn', { kind: 'attacker', id: a.id });
        return false;
      }
      return true;
    });
  }

  // —— 辅助实体（切片 12，原版 Assister） ——

  /** 召唤（原版 FighterMcCtrler.renderAssist → FighterEventCtrler.addAssister）：
   *  出生点 = owner.x − 30×direct（身后），y 同 owner；fzqi 已由调用方清零。 */
  private spawnAssister(owner: FighterState): void {
    const assistId = this.assistIdOf(owner);
    const def = assistId !== null ? this.assisterDefs.get(assistId) : undefined;
    if (assistId === null || !def) return;
    owner.fzqi = 0;
    const assister: AssisterState = {
      id: this.state.nextEntityId,
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
      attackHit: [],
      hitTargetChecker: null,
      hitTargetAction: null,
      buffEffects: def.buffEffects !== undefined ? { ...def.buffEffects } : {},
    };
    this.state.nextEntityId += 1;
    this.state.assisters.push(assister);
    this.state.assisters.sort((a, b) => a.id - b.id);
    this.emit('entity:spawn', {
      kind: 'assister',
      id: assister.id,
      name: assistId,
      owner: owner.id,
    });
  }

  private assistIdOf(f: FighterState): string | null {
    return f.assistId;
  }

  /** 辅助每 tick 物理（原版 renderVelocity/applayG；位移 = 速度，速度已是 60Hz 值）。 */
  private stepAssisterPhysics(): void {
    const { stage, assisters } = this.state;
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
          const def = this.assisterDefs.get(s.assistId);
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

  /** 辅助 30Hz 推进：帧触发器 + 循环触发 + 动画推进 + 退场判定。 */
  private stepAssisterAnimation(): void {
    const { fighters, stage, assisters } = this.state;
    const removed: number[] = [];
    for (const s of assisters) {
      if (removed.includes(s.id)) continue;
      const def = this.assisterDefs.get(s.assistId);
      if (!def) continue;
      const owner = fighters.find((f) => f.id === s.ownerId) ?? null;
      // owner 死亡 → 辅助退场（原版 renderAnimate finish 分支）
      if (owner === null || owner.hp <= 0) {
        removed.push(s.id);
        continue;
      }
      const ctx: AssisterContext = {
        self: s,
        def,
        owner,
        ownerDef: this.defOf(owner),
        fighters,
        stage,
        emit: (type, payload) => this.emit(type, payload),
        spawnAssistBullet: (spec) => this.spawnAssistBullet(spec),
        spawnAssistAttacker: (spec) => this.spawnAssistAttacker(spec),
        remove: () => {
          if (!removed.includes(s.id)) removed.push(s.id);
        },
      };
      // 帧触发器（同帧按注册顺序；触发器后同帧可能被 gotoAndPlay 改写帧号）
      // 跳转检测：gotoAndPlay/命中续接改写 animFrame 后本步不再推进
      //（原版 AS3 gotoAndPlay 播放头落在目标帧、次 tick 才前进——落点帧
      // 的触发器下一步照常执行；此前实现跳转后仍 +1，系统性吞掉标签
      // 首帧（byakuya CHK 落点 52 被推进成 53 滑进 CHK_False 段））
      const frameBefore = s.animFrame;
      const byFrame = this.assisterTriggerIndex.get(s.assistId);
      const list = byFrame?.get(s.animFrame);
      if (list) {
        for (const t of list) {
          const h = this.assisterBehaviors[t.op];
          if (h) h(ctx, t.args, t.target);
        }
      }
      // 循环触发（注册帧起每动画帧，至 untilFrame 独占；条件不成立静默）
      for (const lt of def.loopTriggers) {
        if (s.animFrame < lt.frame) continue;
        if (lt.untilFrame !== null && s.animFrame >= lt.untilFrame) continue;
        if (!evaluateLoopCond(lt.cond, ctx)) continue;
        for (const c of lt.then) {
          const h = this.assisterBehaviors[c.op];
          if (h) h(ctx, c.args, c.target);
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
        const tgtDef = tgt !== null ? this.defOf(tgt) : null;
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
      if (s.animFrame !== frameBefore) continue; // 本步发生过跳转：不推进
      s.animFrame += 1;
      // actLabel 同步（标签数少，线性扫描；渲染寻帧用）
      for (const [label, r] of Object.entries(def.labels)) {
        if (s.animFrame > r.index && s.animFrame <= r.index + r.duration) {
          s.actLabel = label;
          break;
        }
      }
    }
    if (removed.length > 0) this.removeAssisters(removed);
  }

  private removeAssisters(ids: number[]): void {
    const set = new Set(ids);
    this.state.assisters = this.state.assisters.filter((a) => {
      if (set.has(a.id)) {
        this.emit('entity:despawn', { kind: 'assister', id: a.id });
        return false;
      }
      return true;
    });
  }

  /** 辅助 fire 桥（原版 Bullet 构造，owner is FighterMain 不成立 → 命中不回气）。 */
  private spawnAssistBullet(spec: AssistBulletSpawnSpec): void {
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
      id: this.state.nextEntityId,
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
    this.state.nextEntityId += 1;
    this.state.bullets.push(bullet);
    this.state.bullets.sort((a, b) => a.id - b.id);
    this.emit('entity:spawn', { kind: 'bullet', id: bullet.id, name: bullet.name, owner: ownerId });
  }

  /** 某 fighter 当前在场的辅助（buff 结算查询；最多一个）。 */
  private assisterOf(fighterId: number): AssisterState | null {
    return this.state.assisters.find((a) => a.ownerId === fighterId) ?? null;
  }

  /**
   * 抓取吸附每 tick 施加（原版 FighterMC.moveTarget）：把目标吸向自身锚点
   * （followmc 判定区中心，偏离：原版取子对象注册点，不可得）。
   * speed 为 0 直接吸附。吸附仅在攻击状态期间有效——攻击结束（endAct/受击/
   * 回位）即释放并恢复目标重力（原版 clearAction 清 moveTarget；machine 不清，
   * 由本巡检统一释放，见 machine.endAction 注）。
   */
  private stepMoveTargets(): void {
    const { fighters } = this.state;
    for (const g of fighters) {
      const p = g.moveTarget;
      if (p === null) continue;
      if (!isAttackingState(g.actionState)) {
        this.releaseGrab(g);
        continue;
      }
      const t = fighters.find((o) => o.id !== g.id) ?? null;
      if (t === null) continue;
      let ax = g.x;
      let ay = g.y;
      if (p.followmc !== null) {
        const def = this.defOf(g);
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
  private releaseGrab(g: FighterState): void {
    g.moveTarget = null;
    const t = this.state.fighters.find((o) => o.id !== g.id) ?? null;
    if (t !== null) {
      t.applyG = true;
      if (t.actionState === ActionState.HURT_FLYING) t.y -= 5;
    }
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
      // 帧触发器（behaviors 注册表分派；同帧触发按注册顺序执行；
      // 索引按当前形态寻址——形态切换后即用新形态时间轴）
      const byFrame = this.triggerIndex.get(f.id)?.get(f.formIndex);
      advanceAnimation(f, def, (frame) => {
        const list = byFrame?.get(frame);
        if (!list) return;
        const ctx: BehaviorContext = {
          f,
          def,
          fighters,
          stage,
          emit: (type, payload) => this.emit(type, payload),
          spawnBullet: (spec) => this.spawnBullet(spec),
          spawnAttacker: (spec) => this.spawnAttacker(spec),
          switchForm: (g, frameNum) => this.doSwitchForm(g, frameNum),
        };
        for (const t of list) {
          if (t.cond) {
            // 条件触发（切片 11）：cond 求值 → then/else 分支体内调用依次分派
            const branch = evaluateTriggerCondition(t.cond, ctx) ? t.then : t.else;
            for (const c of branch ?? []) {
              const h = this.behaviors[c.op];
              if (h) h(ctx, c.args, c.target);
            }
            continue;
          }
          const handler = this.behaviors[t.op];
          if (handler) handler(ctx, t.args, t.target);
        }
      });
      // 命中续接检查（原版 FighterMcCtrler：checker 判定区与目标身体相交
      // → 切续接标签并清除；每动画帧检查，触发器之后）
      if (f.hitTargetChecker !== null && f.hitTarget !== null) {
        const t = fighters.find((o) => o.id !== f.id) ?? null;
        const tDef = t !== null ? this.defOf(t) : null;
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
    this.stepAssisterAnimation();
  }

  // 6. [动画帧] 命中判定与结算。
  // 固定顺序（本引擎 canonical，替代原版 children 插入序；两端一致即确定）：
  //   角色→角色（P1→P2）→ 角色攻击→道具 → 道具→角色 → 道具→道具（均按 id 升序）
  //   → 辅助→角色（切片 12 追加尾部）
  private stepHitResolution(): void {
    const { fighters, bullets } = this.state;
    for (const atk of fighters) {
      const atkDef = this.defOf(atk);
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
        const tgtDef = this.defOf(tgt);
        const bodyLocal = tgtDef
          ? currentBodyRect({ animFrame: tgt.animFrame, def: tgtDef })
          : null;
        if (!bodyLocal) continue;
        const body = worldRect(tgt, bodyLocal);
        for (const { rect: hitArea, zone } of zones) {
          // 一击一目标按（区动作 id, 目标）去重——同动作不同段可分别命中
          const dedupKey = `${zone.hitId}:${tgt.id}`;
          if (atk.attackHit.includes(dedupKey)) continue;
          if (!rectsOverlap(hitArea, body)) continue;
          atk.attackHit.push(dedupKey);
          this.applyHit(atk.id, atk.facing, atk.x, tgt, tgtDef, zone.hit, hitArea, zone.hitId, atk);
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
        if (b.hp <= 0) this.killBullet(b);
      }
    }
    // 道具 → 角色 / 道具 → 道具（2 人模型：ownerId 不同即敌对）
    for (const b of bullets) {
      if (!this.state.bullets.includes(b) || !b.hitAble) continue;
      const bRect = { x: b.x, y: b.y, w: b.w, h: b.h };
      const owner = this.state.fighters.find((f) => f.id === b.ownerId) ?? null;
      let consumed = false;
      for (const tgt of fighters) {
        if (tgt.id === b.ownerId) continue;
        if (tgt.hp <= 0 || tgt.actionState === ActionState.DEAD || !tgt.isAllowBeHit) continue;
        const tgtDef = this.defOf(tgt);
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
        this.applyHit(
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
          this.killBullet(b);
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
        if (b.hp <= 0) this.killBullet(b);
        if (other.hp <= 0) this.killBullet(other);
        if (!this.state.bullets.includes(b)) break;
      }
    }
    // 独立道具 → 角色（原版 FighterAttacker 命中：非必杀所有者回气 power×0.15；
    // 单次命中即失效——attacker 无多次命中语料）
    for (const a of this.state.attackers) {
      if (!a.hitAble || a.hit === null) continue;
      const rect = { x: a.x, y: a.y, w: a.w, h: a.h };
      const owner = this.state.fighters.find((f) => f.id === a.ownerId) ?? null;
      for (const tgt of fighters) {
        if (tgt.id === a.ownerId) continue;
        if (tgt.hp <= 0 || tgt.actionState === ActionState.DEAD || !tgt.isAllowBeHit) continue;
        const tgtDef = this.defOf(tgt);
        const bodyLocal = tgtDef
          ? currentBodyRect({ animFrame: tgt.animFrame, def: tgtDef })
          : null;
        if (!bodyLocal) continue;
        if (!rectsOverlap(rect, worldRect(tgt, bodyLocal))) continue;
        if (owner !== null && !isBishaAction(a.hitId ?? '')) {
          owner.qi = Math.min(300, owner.qi + a.hit.power * ATTACKER_QI_RATE);
        }
        this.applyHit(
          a.ownerId,
          a.facing,
          a.x + a.w / 2,
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
    // 目标受击结算；一区一目标一次去重）
    for (const s of this.state.assisters) {
      const def = this.assisterDefs.get(s.assistId);
      const owner = this.state.fighters.find((f) => f.id === s.ownerId) ?? null;
      if (!def || owner === null) continue;
      for (const area of def.areas[s.animFrame] ?? []) {
        const hit = def.actions[area.name] ?? null;
        if (hit === null) continue; // 无动作表的区 = 纯表现
        const rect = worldRect(s, area);
        for (const tgt of fighters) {
          if (tgt.id === s.ownerId) continue;
          if (tgt.hp <= 0 || tgt.actionState === ActionState.DEAD || !tgt.isAllowBeHit) continue;
          const dedupKey = `${area.name}:${tgt.id}`;
          if (s.attackHit.includes(dedupKey)) continue;
          const tgtDef = this.defOf(tgt);
          const bodyLocal = tgtDef
            ? currentBodyRect({ animFrame: tgt.animFrame, def: tgtDef })
            : null;
          if (!bodyLocal) continue;
          if (!rectsOverlap(rect, worldRect(tgt, bodyLocal))) continue;
          s.attackHit.push(dedupKey);
          // 辅助命中回气（原版 Assister.hit：addQi(power×0.15)，无必杀排除）
          owner.qi = Math.min(300, owner.qi + hit.power * ASSISTER_QI_RATE);
          this.applyHit(
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

  /** 道具命中消散（原版 doHit：_hitAble=false → 播 hit 段 → remove；此处置即时消散，偏离已记录）。 */
  private despawnBullet(id: number): void {
    this.removeBullets([id]);
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
  private applyHit(
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
    const blocking =
      target.actionState === ActionState.DEFENCE_ING &&
      !(hit.hitType === 11 && hit.isBreakDef) &&
      !this.checkDefDirect(target, attackerX, attackerFacing);
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
    const atkFighter = this.state.fighters.find((f) => f.id === attackerId) ?? null;
    let dmg = hit.power * (atkFighter !== null ? attackRateOf(atkFighter) : 1);
    const tgtAssister = this.assisterOf(target.id);
    if (
      tgtAssister !== null &&
      isAttributeHit(hit.hitType) &&
      tgtAssister.buffEffects.attrResistance !== undefined
    ) {
      dmg *= 1 - tgtAssister.buffEffects.attrResistance;
    }
    dmg *= defenseDamageScale(target);
    const chip = blocking ? dmg * DEFENSE_LOSE_HP_RATE : dmg;
    // 攻方辅助物吸血（原版 phyLifesteal，结算后按实伤回复；物理非必杀命中）
    if (
      atkFighter !== null &&
      !blocking &&
      isPhysicalHit(hit.hitType) &&
      hitId !== null &&
      !isBishaAction(hitId)
    ) {
      const atkAssister = this.assisterOf(attackerId);
      if (atkAssister !== null && atkAssister.buffEffects.phyLifesteal !== undefined) {
        atkFighter.hp = Math.min(
          atkFighter.hpMax,
          atkFighter.hp + chip * atkAssister.buffEffects.phyLifesteal,
        );
      }
    }
    const nextHp = Math.max(0, target.hp - chip);
    // 训练模式：假人不 KO（血最低保留 1）
    target.hp = this.training && nextHp <= 0 ? 1 : nextHp;
    this.emit('hit:connect', {
      attacker: attackerId,
      target: target.id,
      hitType: hit.hitType,
      power: hit.power,
      blocked: blocking,
      x: hitArea.x + hitArea.w / 2,
      y: hitArea.y + hitArea.h / 2,
    });
    if (target.hp <= 0) {
      enterDead(target, targetDef);
      this.emit('fighter:ko', { fighter: target.id });
      return;
    }
    if (blocking) {
      // 被防御：justHitToPlay(includeDefense) 查询基准（原版 lastDefHitId 语义）
      target.lastDefHitId = hitId;
      // 防御损耗能量：破防技 = 90% 上限，否则 min(50, power/5)（原版 doDefenseHit）
      const drain = hit.isBreakDef
        ? Math.round(ENERGY_MAX * 0.9)
        : Math.min(50, Math.floor(hit.power / 5));
      this.emit('fighter:guard', { fighter: target.id });
      if (target.energy < drain) {
        // 破防：额外削血 power/10（原版 doBreakDefense）
        target.hp -= hit.power / 10;
        if (target.hp <= 0) {
          target.hp = 0;
          enterDead(target, targetDef);
          this.emit('fighter:ko', { fighter: target.id });
          return;
        }
        target.energy = 0;
        target.energyOverload = true;
        target.energyGap = ENERGY_GAP_TICKS;
        enterGuardBreak(target, targetDef, hit, attackerFacing);
        this.emit('fighter:guardBreak', { fighter: target.id });
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
    if (target.steelBody) return; // 钢身：掉血但无受击状态变化（原版 doSteelHurt 子集）
    // 自定义受击动作（原版 doHurt → playHurtAct）：攻击方动作携带（setHurtAction
    // 触发在攻击方时间轴，投技携带受击方专用受击动画）优先，受击方自设兜底；
    // 标签按受击方 def 校验存在性，缺失 = 通用受击态
    const hurtLabel = attacker?.hurtAction ?? target.hurtAction;
    if (hurtLabel !== null && targetDef?.labels[hurtLabel] !== undefined) {
      target.hurtAction = null;
      target.lastHurtHitId = hitId;
      target.qi = Math.min(300, target.qi + Math.min(hit.power * HURT_QI_RATE, QI_ADD_HURT_MAX));
      target.actionState = ActionState.HURT_ACT_ING;
      setLabel(target, targetDef, hurtLabel);
      return;
    }
    target.lastHurtHitId = hitId;
    // 受击回气（原版 FighterMain.doQiAdd：power×0.085 封顶 20）
    target.qi = Math.min(300, target.qi + Math.min(hit.power * HURT_QI_RATE, QI_ADD_HURT_MAX));
    enterHurt(target, targetDef, hit, attackerFacing, !target.onGround);
  }

  /** 背刺判定（原版 checkDefDirect）：防御者背对攻击来源 → 防御无效。 */
  private checkDefDirect(
    defender: FighterState,
    attackerX: number,
    attackerFacing: 1 | -1,
  ): boolean {
    if (defender.x < attackerX - 5) return defender.facing < 0 && attackerFacing < 0;
    if (defender.x > attackerX + 5) return defender.facing > 0 && attackerFacing > 0;
    return false;
  }

  // 7. 流程事件：能量回充 / 无敌窗计时 / 训练回复 / 回合计时
  private stepMatchFlow(): void {
    if (this.state.tick === 0) {
      this.emit('round:start', { round: this.state.match.round });
    }
    const { fighters } = this.state;
    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i]!;
      // 防御命中无敌窗（原版 renderBeHitGap：计满恢复可被命中）
      if (f.beHitGap > 0) {
        f.beHitGap -= 1;
        if (f.beHitGap === 0 && f.actionState !== ActionState.DASH_ING) {
          f.isAllowBeHit = true;
        }
      }
      // 能量回充（原版 renderEnergy：速率 ×SPEED_PLUS，ADR-12）
      if (f.energyGap > 0) {
        f.energyGap -= 1;
      } else if (f.energy < ENERGY_MAX) {
        if (f.energyOverload) {
          f.energy = Math.min(ENERGY_MAX, f.energy + ENERGY_ADD_OVERLOAD);
          if (f.energy > 30) f.energyOverload = false;
        } else if (f.actionState === ActionState.DEFENCE_ING) {
          f.energy += ENERGY_ADD_DEFENSE;
        } else if (isAttackingState(f.actionState)) {
          f.energy += ENERGY_ADD_ATTACKING;
        } else {
          f.energy += ENERGY_ADD_NORMAL;
        }
        if (f.energy > ENERGY_MAX) f.energy = ENERGY_MAX;
      }
      // 训练模式：血量恒定回复（2/tick，瞬回 MAX 的 1/15 秒级体感）
      if (this.training && f.hp > 0 && f.hp < DEFAULT_HP) {
        f.hp = Math.min(DEFAULT_HP, f.hp + TRAINING_REGEN);
      }
      // 辅助气回充（原版 FUZHU_QU_ADD_PERFRAME，无条件；满值封顶）
      if (f.fzqi < FZQI_MAX) {
        f.fzqi = Math.min(FZQI_MAX, f.fzqi + FZQI_ADD_PERFRAME);
      }
      // 增益 buff 计时（原版 FighterBuffVO render 递减；计满移除恢复基础值）
      tickBuffs(f);
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

/** def.triggers → 帧 → 触发列表（保持注册顺序；角色/辅助定义通用）。 */
function indexTriggers(def: { triggers: FrameTrigger[] }): Map<number, FrameTrigger[]> {
  const map = new Map<number, FrameTrigger[]>();
  for (const t of def.triggers) {
    const list = map.get(t.frame);
    if (list) list.push(t);
    else map.set(t.frame, [t]);
  }
  return map;
}

/** 原版 HitVO.isBisha：动作 id 含 bs/sbs/cbs/kbs（子串 bs 覆盖全部）。 */
function isBishaAction(actionId: string): boolean {
  return actionId.includes('bs');
}
