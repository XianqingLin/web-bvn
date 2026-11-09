import { advancePlayerInput, Btn, InputView, type InputFrame } from './input.js';
import { hashState, stableStringify } from './serialize.js';
import {
  createInitialState,
  PLAYFIELD_HALF_WIDTH,
  WALK_SPEED,
  type FighterState,
  type SimConfig,
  type SimState,
  type StageState,
} from './state.js';

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
  /** 本 tick 的输入视图（瞬态，不进 SimState），与 fighters 同序 */
  private views: InputView[] = [];
  private events: SimEvent[] = [];

  constructor(config: SimConfig) {
    this.state = createInitialState(config);
  }

  /** 从序列化状态恢复（rollback 预留接口，DESIGN §6）。 */
  static fromState(state: SimState): Sim {
    const sim = Object.create(Sim.prototype) as Sim;
    sim.state = structuredClone(state);
    sim.views = [];
    sim.events = [];
    return sim;
  }

  serializeState(): string {
    return stableStringify(this.state);
  }

  static deserializeState(json: string): SimState {
    return JSON.parse(json) as SimState;
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

  // 1. 输入处理：位图 → 缓冲器 → 输入视图
  private stepInputs(inputs: InputFrame): void {
    const masks = [inputs.p1, inputs.p2];
    this.views = this.state.fighters.map((f, i) =>
      advancePlayerInput(f.input, masks[i] ?? 0),
    );
  }

  // 2. 意图决策：状态机读取意图尝试触发动作（骨架：仅更新朝向；状态表见 DESIGN §3.5）
  private stepIntents(): void {
    const [a, b] = this.state.fighters;
    if (a && b) {
      a.facing = b.x >= a.x ? 1 : -1;
      b.facing = a.x >= b.x ? 1 : -1;
    }
  }

  // 3. 物理积分（行走 + 显式速度 + 重力斜坡 + 多段地板落地 + 牵引边界）
  private stepPhysics(): void {
    const { stage, fighters } = this.state;
    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i]!;
      const view = this.views[i]!;
      let dir = 0;
      if (view.held(Btn.left)) dir -= 1;
      if (view.held(Btn.right)) dir += 1;
      f.vx = dir * WALK_SPEED;
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
      } else {
        // 落地瞬间预置下次离地的初值（原版 setInAir(false) → _g=4）
        f.gRamp = GRAVITY_START;
      }
    }
    // 牵引边界（ADR-4）：版边 = 两角色中点 ± PLAYFIELD_HALF_WIDTH，clamp 到地图边界。
    // 相机不进模拟（契约硬规则 5）。
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

  // 4. 推挤（骨架占位：body AABB 按 heavy 系数互推，随判定区一起实现）
  private stepPush(): void {}

  // 5. [动画帧] 动画推进 / 判定区刷新 / 击飞状态机 / 帧触发器（骨架占位）
  private stepAnimation(): void {}

  // 6. [动画帧] 命中判定与结算（骨架占位；固定顺序 P1→P2→道具→辅助）
  private stepHitResolution(): void {}

  // 7. 流程事件：死亡、回合计时、比分、能量回复
  private stepMatchFlow(): void {
    if (this.state.tick === 0) {
      this.emit('round:start', { round: this.state.match.round });
    }
    for (const f of this.state.fighters) {
      if (f.hp <= 0) {
        this.emit('fighter:ko', { fighter: f.id });
      }
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
