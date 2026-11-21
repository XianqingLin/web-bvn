import {
  advancePlayerInput,
  Btn,
  type InputFrame,
  type InputView,
} from './input.js';
import { behaviorHash, hashState, stableStringify } from './serialize.js';
import {
  createInitialState,
  type CutinLockState,
  type FighterState,
  type RoundEndState,
  type SimConfig,
  type SimState,
} from './state.js';
import {
  isAttackingState,
  ActionState,
  type AssisterDef,
  type FighterDef,
  type FrameTrigger,
} from './fighter/def.js';
import { endActAction, setLabel, switchForm } from './fighter/machine.js';
import {
  createBehaviorRegistry,
  type BehaviorHandler,
} from './fighter/behaviors.js';
import { defaultAssisterBehaviors, type AssisterHandler } from './fighter/assister.js';
import {
  indexTriggers,
  slowDownAnimEveryOf,
  slowDownScaleOf,
  type SimCtx,
} from './sim/ctx.js';
import { stepIntents, stepAnimation } from './sim/anim.js';
import { releaseGrab, resolveLanding, stepPhysics, stepPush } from './sim/physics.js';
import { spawnBullet, spawnAssistBullet, spawnAttackerFireBullet, stepBullets, stepBulletAnim } from './sim/bullets.js';
import {
  removeAttackers,
  spawnAttacker,
  spawnAssistAttacker,
  stepAttackers,
  stepAttackerAnim,
} from './sim/attackers.js';
import { spawnAssister, stepAssisterAnimation, stepAssisterPhysics } from './sim/assisters.js';
import { stepHitResolution } from './sim/hit.js';
import {
  advanceRoundEnd,
  applyWinnerPose,
  endIntro,
  INTRO_STEP_START,
  isBishaOrWanKaiState,
  ROUND_END_TOTAL_TICKS,
  ROUND_END_TICKS,
  FPS_GAME,
  SLOW_DOWN_RATE,
  SLOW_FLIGHT_TICKS_GATE,
  SLOW_MOTION_ANIM_EVERY,
  SLOW_MOTION_SCALE,
  stepFighterFlow,
  stepIntroAdvance,
  stepMatchFlow,
  stepPassivePhysics,
  stepRoundTimer,
  WIN_DELAY_LONG_TICKS,
  WIN_DELAY_SHORT_TICKS,
  WIN_TEXT_GATE_TICKS,
} from './sim/flow.js';

/**
 * 表现事件（契约 §表现事件表）。
 * 新增事件类型必须在 docs/ARCHITECTURE.md 事件表同 commit 登记。
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
  /** 全状态哈希（含表示字段；联机失步检测/对拍/快照恢复基准） */
  hash: string;
  /** 行为哈希（剥除表现/输入字段 + 空容器省略；tools/replay 回归门禁基准，
   *  表示层重构不漂移——见 serialize.ts behaviorView 剥除表与 DESIGN §3.8） */
  behaviorHash: string;
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
 *
 * 2026-11-17 结构重构：子系统实现拆入 sim/ 子模块（physics/flow/bullets/
 * attackers/assisters/hit/anim，均以 SimCtx 只读视图 + 桥接闭包为参数的
 * 纯函数）；本类保留状态所有权、定义注册表与 tick 管线编排，逐行搬运
 * 子系统代码、不改任何执行顺序——纯结构重构，哈希与行为零漂移。
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
  /** 子模块共享上下文（只读视图 + 桥接闭包；见 sim/ctx.ts 注） */
  private ctx: SimCtx;

  constructor(config: SimConfig) {
    this.state = createInitialState(config);
    this.training = config.training ?? false;
    if (config.teams) {
      // roster 校验（装配错误尽早炸）：id 必须唯一且都能在 config.fighters 寻址
      const known = new Set(config.fighters.map((fc) => fc.id));
      const roster = [...config.teams.p1, ...config.teams.p2];
      if (
        roster.length !== new Set(roster).size ||
        roster.some((id) => !known.has(id))
      ) {
        throw new Error('SimConfig.teams roster must reference unique config.fighters ids');
      }
    }
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
    this.ctx = this.buildCtx();
    this.behaviors = createBehaviorRegistry({
      endAct: endActAction,
      releaseGrab: (f) => this.ctx.releaseGrab(f),
      spawnBullet: (spec) => this.ctx.spawnBullet(spec),
      spawnAttacker: (spec) => this.ctx.spawnAttacker(spec),
      switchForm: (f, frame) => this.doSwitchForm(f, frame),
      setCutin: (f, kind) => this.setCutin('fighter', f.id, kind),
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
    sim.ctx = sim.buildCtx();
    sim.behaviors = createBehaviorRegistry({
      endAct: endActAction,
      releaseGrab: (f) => sim.ctx.releaseGrab(f),
      spawnBullet: (spec) => sim.ctx.spawnBullet(spec),
      spawnAttacker: (spec) => sim.ctx.spawnAttacker(spec),
      switchForm: (f, frame) => sim.doSwitchForm(f, frame),
      setCutin: (f, kind) => sim.setCutin('fighter', f.id, kind),
    });
    sim.assisterBehaviors = defaultAssisterBehaviors;
    return sim;
  }

  /** 子模块共享上下文装配（只读视图经 getter 惰性取字段，装配顺序无关）。 */
  private buildCtx(): SimCtx {
    const self = this;
    const ctx: SimCtx = {
      get state() {
        return self.state;
      },
      get training() {
        return self.training;
      },
      get behaviors() {
        return self.behaviors;
      },
      get assisterBehaviors() {
        return self.assisterBehaviors;
      },
      get assisterDefs() {
        return self.assisterDefs;
      },
      get assisterTriggerIndex() {
        return self.assisterTriggerIndex;
      },
      get triggerIndex() {
        return self.triggerIndex;
      },
      emit: (type, payload) => self.emit(type, payload),
      defOf: (f) => self.defOf(f),
      defById: (id, formIndex) => self.defById(id, formIndex),
      ownerTargetDefOf: (owner) => self.ownerTargetDefOf(owner),
      doSwitchForm: (f, frame) => self.doSwitchForm(f, frame),
      setCutin: (kind, id, k) => self.setCutin(kind, id, k),
      setSlowDown: (t) => self.setSlowDown(t),
      releaseGrab: (f) => releaseGrab(ctx, f),
      spawnBullet: (spec) => spawnBullet(ctx, spec),
      spawnAttackerFireBullet: (spec) => spawnAttackerFireBullet(ctx, spec),
      spawnAssistBullet: (spec) => spawnAssistBullet(ctx, spec),
      spawnAttacker: (spec) => spawnAttacker(ctx, spec),
      spawnAssistAttacker: (spec) => spawnAssistAttacker(ctx, spec),
      spawnAssister: (owner) => spawnAssister(ctx, owner),
      removeAttackers: (ids) => removeAttackers(ctx, ids),
      stepAssisterAnimation: (cutinLock) => stepAssisterAnimation(ctx, cutinLock),
      stepBullets: () => stepBullets(ctx),
      stepAttackers: () => stepAttackers(ctx),
      stepAssisterPhysics: () => stepAssisterPhysics(ctx),
      resolveLanding: (f, stage) => resolveLanding(f, stage),
    };
    return ctx;
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

  /** 召唤者当前目标的 def（辅助语境 fighterTarget；owner 空/无目标 = null）。 */
  private ownerTargetDefOf(owner: FighterState | null): FighterDef | null {
    if (owner === null) return null;
    const t = this.state.fighters.find((f) => f.id !== owner.id) ?? null;
    return t !== null ? this.defOf(t) : null;
  }

  /** 按 id + 形态下标取 def（rotateIn 用；FighterState 尚未构造）。 */
  private defById(id: number, formIndex: number): FighterDef | null {
    const forms = this.formsById.get(id);
    if (!forms || forms.length === 0) return null;
    return forms[Math.min(formIndex, forms.length - 1)] ?? null;
  }

  /** doWanKai/switchForm 桥：形态切换 + 表现事件（render 换图集形态用）。
   *  切换后保持 WAN_KAI_ING，由新形态 开场 播完经 endAction 回位。
   *  事件带 rootFrame（绝对帧寻址）：sim forms 数组是过滤空根帧后的紧凑数组、
   *  formIndex 是其下标；render 图集 forms 是含空根帧的全数组，两者差一位——
   *  render 按 rootFrame 换算，避免切形态显示回上一形态（21F 顺带修复）。 */
  private doSwitchForm(f: FighterState, frame: number): void {
    const forms = this.formsById.get(f.id);
    if (!forms) return;
    const next = switchForm(f, forms, frame);
    if (next) {
      this.emit('fighter:form', {
        fighter: f.id,
        form: next.formIndex,
        rootFrame: next.rootFrame,
      });
    }
  }

  /** 特写冻结锁置位/清除（behaviors 桥；bisha/wanKai 置锁，end 系清除）。 */
  private setCutin(
    ownerKind: 'fighter' | 'assister',
    id: number,
    kind: 'bisha' | 'wanKai' | null,
  ): void {
    this.state.cutinLock = kind === null ? null : { kind: ownerKind, id, type: kind };
  }

  /**
   * slowDown 全局慢放置位（behaviors/assister 桥，切片 49）：角色语料固定
   * rate=1.5（原版 FighterEffectCtrler.slowDown → EffectCtrler.slowDown(1.5,
   * t*1000)；KO 链的 rate 2 走 roundEnd.slow 独立通道）。折算范式见
   * DESIGN §3.5；重复触发重置计时（原版 GameCtrler.slow 重入同语义）。
   */
  private setSlowDown(t: number): void {
    this.state.slowDown = {
      ticksLeft: Math.round(t * FPS_GAME),
      scale: 1 / SLOW_DOWN_RATE,
      animEvery: Math.ceil(FPS_GAME / (30 / SLOW_DOWN_RATE)),
    };
  }

  private emit(type: string, payload: Record<string, unknown>): void {
    this.events.push({ tick: this.state.tick, type, payload });
  }

  tick(inputs: InputFrame): SimSnapshot {
    // slowDown 全局慢放计时（切片 49，原版 EffectCtrler.renderSlowDown 每渲染帧
    // 递减——EffectCtrler.render 在冻结/特写/演出期照跑，实时间语义）
    if (this.state.slowDown != null) {
      this.state.slowDown.ticksLeft -= 1;
      if (this.state.slowDown.ticksLeft <= 0) this.state.slowDown = undefined;
    }
    if (this.state.passiveFreeze != null) {
      // 受击被动演出冻结（切片 55，原版 EffectCtrler.replaceSkill/energyExplode
      // → GameCtrler.pause，无 justRender 白名单）：全场停走，仅演出倒计时按
      // 实时间递减（原版 EffectCtrler.render 在 pause 期照跑）。置于
      // freezeTicks 之前：命中停顿与演出冻结同为 pause 语义，演出倒计时在
      // 打击停顿期照减（原版 EffectCtrler.render 与 freeze 并行）。渲染层按
      // 快照差分驱动黑幕/地图隐藏/演出特效。输入采样照常推进（批次 35 教训）。
      const pf = this.state.passiveFreeze;
      pf.ticksLeft -= 1;
      const ownerGone = !this.state.fighters.some((f) => f.id === pf.ownerId);
      if (pf.ticksLeft <= 0 || ownerGone) {
        this.state.passiveFreeze = undefined;
        // 演出收尾事件（渲染层据此恢复地图/黑幕淡出；explode 另在收尾帧
        // 补放 explodeSp2，原版 endEnergyExplode 同帧 resume+特效）
        this.emit('effect', {
          id: pf.kind === 'replace' ? 'endReplaceSkill' : 'endEnergyExplode',
          x: 0,
          y: 0,
          params: { owner: pf.ownerId },
        });
      }
      this.stepInputs(inputs);
      return this.stepOutput();
    }
    if (this.state.freezeTicks > 0) {
      // 打击停顿（修复批次 35，原版 EffectCtrler.freeze → GameCtrler.pause）：整局
      // 停走一 tick；特效/闪屏/抖动在渲染层自行推进，不受停顿影响。倒计时期间
      // 快照状态不变（tick 号仍递增，渲染层按同一状态插值）。
      // 输入采样照常推进（stepInputs 只推导边沿/缓冲，无行为副作用）：停顿期间
      // 按下的边沿进缓冲不丢，解除停顿后的首个决策 tick 照常派生连段——否则
      // 轻击 3 tick 停顿正好吃掉连段按键窗口，连招手感断裂（批次 35 实测修正）。
      this.state.freezeTicks -= 1;
      this.stepInputs(inputs);
      return this.stepOutput();
    }
    if (this.state.roundEnd != null) {
      // 团队回合结束演出（切片 36，原版 GameEndCtrler.render + actionEnable=false）：
      // 败方死亡动画/胜方胜利动作播完 → 换人或终局；物理/推挤/命中/计时停走。
      this.tickRoundEnd(inputs);
      return this.stepOutput();
    }
    if (this.state.intro != null) {
      // 开局特写演出（intro 切片，原版 actionEnable=false 冻结语义）：输入/物理/
      // 推挤/命中/回合计时停走，角色时间轴 30Hz 推进 + 能量/辅助气回充照跑
      // （原版 renderAnimate 无条件），say 步等 开场 播完；skip 经 Btn.back 位图。
      this.tickIntro(inputs);
    } else if (this.state.cutinLock !== null) {
      // 特写冻结（切片 22，原版 GameCtrler.pause 语义）：仅锁主时间轴推进，
      // 输入/物理/推挤/命中/计时/回气全部停走；endBisha/endWanKai（锁主时间轴
      // 帧触发）解锁后下一 tick 恢复正常管线。
      this.tickCutinLock(inputs);
    } else if (this.state.fighters.some((f) => f.ghostTicks > 0)) {
      // 幽步冻结（切片 53，原版 EffectCtrler.ghostStep → GameCtrler.pause +
      // justRender 白名单）：全场停走，仅瞬身者物理积分 + 时间轴 30Hz 推进
      //（白名单 sp.render()/renderAnimate()）。冻结由 ghostTicks 驱动、
      // stepGhost 归零自然解除；意图封锁已由 machine 决策门保证。
      this.tickGhostFreeze();
    } else {
      this.stepInputs(inputs); // 1. 输入处理
      stepIntents(this.ctx, this.views); // 2. 意图决策
      stepPhysics(this.ctx, this.views); // 3. 物理积分（slowDown 期位移/重力折算——函数内自取）
      stepPush(this.ctx); //    4. 推挤（原版 checkBodyHit 每渲染帧，不受慢放门控）
      if (this.state.tick % slowDownAnimEveryOf(this.state) === 0) {
        // 5/6. [动画帧] 30Hz（slowDown 期按 animEvery 降频——原版
        // checkRenderAnimate 的 _renderAnimateGap 门控，checkHit 同门）
        stepAnimation(this.ctx);
        stepHitResolution(this.ctx);
        stepBulletAnim(this.ctx); //    [动画帧]（原版 Bullet.renderAnimate）
        stepAttackerAnim(this.ctx); // [动画帧]（原版 FighterAttacker.renderAnimate）
      }
      stepMatchFlow(this.ctx); // 7. 流程事件
    }
    return this.stepOutput(); // 8. 输出
  }

  /**
   * 幽步冻结 tick（切片 53）：仅瞬身者推进——物理积分（含 stepGhost 计时/
   * 位移/回位与结束事件，原版白名单 sp.render() 速度积分照跑）+ 时间轴
   * 30Hz（原版 justRenderAnimate；走标签帧触发 ghost_step 蓝色拖尾特效）。
   * 输入/推挤/命中/道具/计时/回气停走（原版 render() 早退 + renderGameTime
   * 冻结）。瞬身者免伤不会死，死亡保护兜底走正常管线。
   */
  private tickGhostFreeze(): void {
    const ghost = this.state.fighters.find((f) => f.ghostTicks > 0);
    if (!ghost || ghost.hp <= 0) {
      // 保护性兜底（理论上不可达：免伤期不受击）：本 tick 恢复正常管线
      stepPhysics(this.ctx, this.views);
      if (this.state.tick % slowDownAnimEveryOf(this.state) === 0) stepAnimation(this.ctx);
      return;
    }
    stepPhysics(this.ctx, this.views, ghost.id);
    if (this.state.tick % slowDownAnimEveryOf(this.state) === 0) {
      stepAnimation(this.ctx, { kind: 'fighter', id: ghost.id });
    }
  }

  /**
   * 特写冻结 tick（切片 22）：仅锁主（bisha/wanKai 施法者，角色或辅助）的
   * 动画时间轴按 30Hz 推进——原版施法者画面由 render 驱动继续播、帧脚本照常
   * 触发（endBisha/endWanKai 即在冻结期间到来）；其余全部停走。
   * 锁主失联保护（防软锁，批次 18 教训）：角色回待机/死亡（技能收尾但语料
   * 缺 endBisha 触发）、辅助退场 → 保护性解锁，本 tick 恢复正常管线。
   */
  private tickCutinLock(inputs: InputFrame): void {
    const lock = this.state.cutinLock!;
    if (lock.kind === 'assister') {
      if (!this.state.assisters.some((a) => a.id === lock.id)) {
        this.state.cutinLock = null;
      }
    } else {
      const f = this.state.fighters.find((x) => x.id === lock.id);
      if (
        !f ||
        f.hp <= 0 ||
        (!isAttackingState(f.actionState) && f.actionState !== ActionState.WAN_KAI_ING)
      ) {
        this.state.cutinLock = null;
      }
    }
    if (this.state.cutinLock === null) {
      // 已解锁（锁主失联保护性清除）：本 tick 走正常管线（真实输入）
      this.tickFallback(inputs);
      return;
    }
    if (this.state.tick % slowDownAnimEveryOf(this.state) === 0) {
      // 锁主时间轴门控随 slowDown 降频（原版锁主画面经 EffectCtrler
      // isRenderAnimate 推进，同一 _renderAnimateGap 门）
      stepAnimation(this.ctx, lock);
    }
  }

  /** 正常管线重入（锁主失联解锁 tick 复用；与 tick() 主路径同序）。 */
  private tickFallback(inputs: InputFrame): void {
    this.stepInputs(inputs);
    stepIntents(this.ctx, this.views);
    stepPhysics(this.ctx, this.views);
    stepPush(this.ctx);
    if (this.state.tick % slowDownAnimEveryOf(this.state) === 0) {
      stepAnimation(this.ctx);
      stepHitResolution(this.ctx);
      stepBulletAnim(this.ctx);
      stepAttackerAnim(this.ctx);
    }
    stepMatchFlow(this.ctx);
  }

  /**
   * 开局特写 tick（intro 切片，原版 GameCtrler actionEnable=false 冻结 +
   * GameStartCtrler.renderStart1v1 状态机）：输入采样照常（批次 35 教训）、
   * 回气照跑（原版冻结期 renderAnimate 无条件）、角色时间轴 30Hz 推进；
   * 物理/推挤/命中/回合计时停走（原版 renderGameTime 被 actionEnable 门控）。
   */
  private tickIntro(inputs: InputFrame): void {
    if (this.state.tick === 0) {
      this.emit('round:start', { round: this.state.match.round });
    }
    this.stepInputs(inputs);
    const intro = this.state.intro!;
    // 跳过（原版 GameCtrler.renderPause 的 GameInputer.back(1)：back/MENU
    // just-down；字样出场前才可跳——skip 即恢复 actionEnable 正常管线）。
    // 经输入位图进 sim，lockstep 两端同步跳。训练模式无 intro 不走此路径。
    if (intro.step < INTRO_STEP_START && this.views.some((v) => v.justDown(Btn.back))) {
      endIntro(this.ctx);
    }
    if (this.state.intro == null) {
      // skip tick：恢复正常管线（与本 tick 的 tick() 主路径同序）
      stepIntents(this.ctx, this.views);
      stepPhysics(this.ctx, this.views);
      stepPush(this.ctx);
      if (this.state.tick % 2 === 0) {
        stepAnimation(this.ctx);
        stepHitResolution(this.ctx);
        stepBulletAnim(this.ctx);
        stepAttackerAnim(this.ctx);
      }
      this.state.match.roundFrame += 1;
      // 回合计时补步（多局制切片，原版 skip tick 恢复 actionEnable → 计时跑）
      stepRoundTimer(this.ctx);
      return;
    }
    // 回气照跑（原版冻结期 renderAnimate 无条件：能量/辅助气回充、buff 计时）
    for (const f of this.state.fighters) stepFighterFlow(this.ctx, f);
    // 角色时间轴 30Hz 推进（原版 renderAnimate 无条件；开场 的语音贴帧音/
    // 收招/回位触发在此到来）
    if (this.state.tick % 2 === 0) {
      stepAnimation(this.ctx);
    }
    stepIntroAdvance(this.ctx);
  }

  /**
   * 回合结束演出 tick（原版 GameEndCtrler.render 步进 + FightUI.renderEnd）：
   * 输入采样照常（批次 35 教训）。KO 字样窗口（WIN_TEXT_GATE）内全场停走
   * （修复批次 63，原版 playKO GameCtrler.pause → koBack resume）——尸体定格
   * 于 KO 姿态；窗口后：回气/buff 照跑、角色时间轴 30Hz 推进（败方死亡动画/
   * 胜方胜利动作）、被动物理（胜方空中自然落地——原版 actionEnable=false 只封
   * 输入，物理照常）、飞行道具/独立道具位移与动画走完（命中判定停走）；意图/
   * 命中/推挤/计时停走。败方仍击飞 → 终结慢镜头半速（原版 renderEnd
   * slowDown(2,0)）直到落地 → showWinner 延迟（原版 _showWinnerDelay 2s/1s）→
   * 胜利姿势（原版 case1 isAllowWinState 等待门收编）；hold 计满 → 换人或终局。
   */
  private tickRoundEnd(inputs: InputFrame): void {
    const re = this.state.roundEnd!;
    this.stepInputs(inputs);
    if (!re.over) {
      // 跳过（原版 GameEndCtrler.skip 仅 step2 可跳；port 全程可跳，偏离记录）：
      // 慢镜头/延迟即时清掉，胜利姿势立即落位（跳过等待门——原版 skip 只在
      // 胜利 hold 段可达，此处等价于跳到段尾），推进锚回字样窗口下 tick 收尾
      if (this.views.some((v) => v.justDown(Btn.back))) {
        re.slow = false;
        re.winnerDelay = null;
        const skipWinner = this.state.fighters.find((f) => f.id === re.winnerId) ?? null;
        if (!re.draw && !re.winApplied && skipWinner !== null) {
          applyWinnerPose(this.ctx, re, skipWinner);
          re.winAppliedHold = WIN_TEXT_GATE_TICKS;
        }
        re.hold = ROUND_END_TOTAL_TICKS - 1;
      } else {
        const winner = this.state.fighters.find((f) => f.id === re.winnerId) ?? null;
        const loser = this.state.fighters.find((f) => f.id === re.loserId) ?? null;
        if (
          !re.draw &&
          !re.winApplied &&
          winner !== null &&
          re.hold >= WIN_TEXT_GATE_TICKS
        ) {
          // 终结慢镜头/showWinner 延迟（原版 FightUI.renderEnd：败方仍击飞 →
          // slowDown(2,0) 半速直到落地；DEAD 后 _showWinnerDelay 2s/1s；
          // 平局不播 showWinner——原版 renderDrawGame 无此段）。
          // timeover 路径（多局制切片，原版 playTimeOver → timeoverBack）：
          // 字样播完 _showWinnerDelay 恒 1s——败方活人无飞尸，无终结慢镜头。
          // 延迟互斥门（修复批次 63）：原版 _showWinnerDelay 分支先行——延迟
          // 一经开跑，尸体 HURT_DOWN_TAN 弹起不再回慢镜头/重置延迟（否则弹起
          // 期延迟清零重计，WIN 落位拍带 slow 且时序漂移）
          if (re.slow) {
            if (loser === null || loser.onGround) {
              re.slow = false;
              re.winnerDelay =
                re.slowTicks < SLOW_FLIGHT_TICKS_GATE
                  ? WIN_DELAY_LONG_TICKS
                  : WIN_DELAY_SHORT_TICKS;
            }
          } else if (re.winnerDelay === null && re.timerOver === true) {
            re.winnerDelay = WIN_DELAY_SHORT_TICKS;
          } else if (
            re.winnerDelay === null &&
            loser !== null &&
            // 击飞判定 = 空中或带待发射垂直速度（修复批次 65 后：击飞致死者
            // 与原版同构——resume 时即 HURT_FLYING/HURT_DOWN_TAN，倒地转 DEAD；
            // 保留物理等价判定以覆盖非击飞致死残留位移等边缘）
            (!loser.onGround || loser.vy < 0)
          ) {
            re.slow = true;
            re.slowTicks = 0;
          } else if (re.winnerDelay === null) {
            re.winnerDelay = WIN_DELAY_LONG_TICKS;
          }
          if (re.winnerDelay !== null && re.winnerDelay > 0) re.winnerDelay -= 1;
          // 胜利动作（原版 case1：KO 字样窗口 + 延迟过后等必杀/万解收尾
          // ——isAllowWinState 等待门；perfect = 满血判定（原版
          // FightUI.showWinner $perfect，WIN 回血前取样）；血量恢复仅 team
          // （原版 case1 isTeamMode 门，1v1 无恢复））
          if (
            re.winnerDelay === 0 &&
            winner.hp > 0 &&
            !isBishaOrWanKaiState(winner.actionState)
          ) {
            applyWinnerPose(this.ctx, re, winner);
          }
        }
      }
    }
    // KO 字样窗口冻结（修复批次 63，原版 playKO GameCtrler.pause → koBack
    // resume——_isRenderGame=false 门控 checkRenderAnimate/renderGameSprite）：
    // 窗口内全场停走——被动物理/角色时间轴/回气 buff/道具全冻（尸体定格于
    // KO 姿态；KO 字样与特效为表现层实时间，照常推进）；窗口后解冻，败方
    // 击飞 → 终结慢镜头看倒地（原版 koBack 后 renderEnd slowDown(2,0)）。
    // timeover 路径无冻结窗（原版 playTimeOver 无 GameCtrler.pause——仅
    // actionEnable=false 封输入，物理/时间轴照常）。
    const windowFrozen =
      !re.over && re.timerOver !== true && re.hold < WIN_TEXT_GATE_TICKS;
    if (!windowFrozen) {
      // 回气/buff 照跑（原版 renderAnimate 无条件）——KO 字样窗口期除外
      //（原版 pause 期 _isRenderGame=false 停走，偏离修正）
      for (const f of this.state.fighters) stepFighterFlow(this.ctx, f);
      // 被动物理（无输入位移；终结慢镜头全场半速——原版 GameCtrler.slow
      // setSpeedPlus(SPEED_PLUS/rate)；KO 演出期角色 slowDown 仍在计时的场合
      // 折算相乘（原版两条 speedPlus 通道同态叠加）；推挤/抓取/辅助停走
      // ——清场前冻结；飞行道具/独立道具位移与寿命照走（原版 resume 后
      // renderGameSprite 照跑），命中判定停走（setAllowLoseHP(false) 折算））
      const slowScale =
        (re.slow ? SLOW_MOTION_SCALE : 1) * slowDownScaleOf(this.state);
      for (const f of this.state.fighters) stepPassivePhysics(this.ctx, f, slowScale);
      stepBullets(this.ctx, slowScale);
      stepAttackers(this.ctx, slowScale);
      // 角色时间轴推进（胜利/死亡动画；帧触发器照常——胜利标签的贴帧音/收招
      // 触发在此到来。慢镜头 15Hz：原版 renderAnimateGap FPS_GAME/(FPS_ANIMATE/rate)-1；
      // 无终结慢镜头时角色 slowDown 仍生效 → animEvery 门控同主管线）
      if (re.slow) {
        re.slowTicks += 1;
        if (re.slowTicks % SLOW_MOTION_ANIM_EVERY === 0) {
          stepAnimation(this.ctx);
          stepBulletAnim(this.ctx);
          stepAttackerAnim(this.ctx);
        }
      } else if (this.state.tick % slowDownAnimEveryOf(this.state) === 0) {
        stepAnimation(this.ctx);
        stepBulletAnim(this.ctx);
        stepAttackerAnim(this.ctx);
      }
    }
    if (re.over) return; // 终局已发，冻结待 app 切结算
    re.hold += 1;
    // 换人/终局推进（原版 case3 经 finishBack——finishBack 在 showWinner 才回调，
    // 胜利动作自 winApplied 起算；慢镜头/延迟/必杀收尾等待期不推进）。
    // 平局无 winApplied（原版 renderDrawGame 无 showWinner），恒 ROUND_END_TOTAL。
    if (re.draw) {
      if (re.hold >= ROUND_END_TOTAL_TICKS) advanceRoundEnd(this.ctx, re);
    } else if (re.winApplied && re.hold - re.winAppliedHold >= ROUND_END_TICKS) {
      advanceRoundEnd(this.ctx, re);
    }
  }

  // 1. 输入处理：位图 → 缓冲器 → 输入视图
  private stepInputs(inputs: InputFrame): void {
    const masks = [inputs.p1, inputs.p2];
    this.views = this.state.fighters.map((f, i) =>
      advancePlayerInput(f.input, masks[i] ?? 0),
    );
  }

  // 8. 输出：快照 + 表现事件队列 + 状态哈希
  private stepOutput(): SimSnapshot {
    const snapshot: SimSnapshot = {
      tick: this.state.tick,
      hash: hashState(this.state),
      behaviorHash: behaviorHash(this.state),
      state: structuredClone(this.state),
      events: this.events,
    };
    this.events = [];
    this.state.tick += 1;
    return snapshot;
  }
}
