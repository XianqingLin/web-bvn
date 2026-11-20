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
import { indexTriggers, type SimCtx } from './sim/ctx.js';
import { stepIntents, stepAnimation } from './sim/anim.js';
import { releaseGrab, resolveLanding, stepPhysics, stepPush } from './sim/physics.js';
import { spawnBullet, spawnAssistBullet, stepBullets, stepBulletAnim } from './sim/bullets.js';
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
  endIntro,
  INTRO_STEP_START,
  isBishaOrWanKaiState,
  ROUND_END_TOTAL_TICKS,
  stepFighterFlow,
  stepIntroAdvance,
  stepMatchFlow,
  stepPassivePhysics,
  WIN_RECOVER_LOST_RATE,
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
      releaseGrab: (f) => releaseGrab(ctx, f),
      spawnBullet: (spec) => spawnBullet(ctx, spec),
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

  private emit(type: string, payload: Record<string, unknown>): void {
    this.events.push({ tick: this.state.tick, type, payload });
  }

  tick(inputs: InputFrame): SimSnapshot {
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
    } else {
      this.stepInputs(inputs); // 1. 输入处理
      stepIntents(this.ctx, this.views); // 2. 意图决策
      stepPhysics(this.ctx, this.views); // 3. 物理积分
      stepPush(this.ctx); //    4. 推挤
      if (this.state.tick % 2 === 0) {
        stepAnimation(this.ctx); // 5. [动画帧] 30Hz
        stepHitResolution(this.ctx); // 6. [动画帧] 30Hz
        stepBulletAnim(this.ctx); //    [动画帧] 30Hz（原版 Bullet.renderAnimate）
        stepAttackerAnim(this.ctx); // [动画帧] 30Hz（原版 FighterAttacker.renderAnimate）
      }
      stepMatchFlow(this.ctx); // 7. 流程事件
    }
    return this.stepOutput(); // 8. 输出
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
    if (this.state.tick % 2 === 0) {
      stepAnimation(this.ctx, lock);
    }
  }

  /** 正常管线重入（锁主失联解锁 tick 复用；与 tick() 主路径同序）。 */
  private tickFallback(inputs: InputFrame): void {
    this.stepInputs(inputs);
    stepIntents(this.ctx, this.views);
    stepPhysics(this.ctx, this.views);
    stepPush(this.ctx);
    if (this.state.tick % 2 === 0) {
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
   * 回合结束演出 tick（原版 GameEndCtrler.render 步进）：输入采样照常（批次 35
   * 教训）、回气/buff 照跑、角色时间轴 30Hz 推进（败方死亡动画/胜方胜利动作）、
   * 被动物理（胜方空中自然落地——原版 actionEnable=false 只封输入，物理照常）；
   * 意图/命中/推挤/道具/计时停走。hold 计满 → 换人或终局。
   */
  private tickRoundEnd(inputs: InputFrame): void {
    const re = this.state.roundEnd!;
    this.stepInputs(inputs);
    if (!re.over) {
      // 跳过（原版 GameEndCtrler.skip 仅 step2 可跳；port 全程可跳，偏离记录）
      if (this.views.some((v) => v.justDown(Btn.back))) re.hold = ROUND_END_TOTAL_TICKS - 1;
      // 胜方胜利动作（原版 case1：KO 字样窗口 WIN_TEXT_GATE 过后等必杀/万解收尾
      // ——isAllowWinState 等待门收编为 hold 门；perfect = 满血判定（原版
      // FightUI.showWinner $perfect，WIN 回血前取样）；血量恢复仅 team
      // （原版 case1 isTeamMode 门，1v1 无恢复））
      const winner = this.state.fighters.find((f) => f.id === re.winnerId) ?? null;
      if (
        !re.draw &&
        winner !== null &&
        winner.hp > 0 &&
        !re.winApplied &&
        re.hold >= WIN_TEXT_GATE_TICKS &&
        !isBishaOrWanKaiState(winner.actionState)
      ) {
        re.winApplied = true;
        re.perfect = winner.hp >= winner.hpMax;
        winner.actionState = ActionState.WIN_ING;
        setLabel(winner, this.defOf(winner), '胜利');
        if (this.state.match.teams != null) {
          winner.hp = Math.min(
            winner.hpMax,
            winner.hp + (winner.hpMax - winner.hp) * WIN_RECOVER_LOST_RATE,
          );
        }
      }
    }
    // 回气/buff 照跑（原版冻结期 renderAnimate 无条件）
    for (const f of this.state.fighters) stepFighterFlow(this.ctx, f);
    // 被动物理（无输入位移；道具/辅助/推挤/抓取停走——清场前冻结）
    for (const f of this.state.fighters) stepPassivePhysics(this.ctx, f);
    // 角色时间轴 30Hz 推进（胜利/死亡动画；帧触发器照常——胜利标签的
    // 贴帧音/收招触发在此到来）
    if (this.state.tick % 2 === 0) stepAnimation(this.ctx);
    if (re.over) return; // 终局已发，冻结待 app 切结算
    re.hold += 1;
    if (re.hold >= ROUND_END_TOTAL_TICKS) advanceRoundEnd(this.ctx, re);
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
