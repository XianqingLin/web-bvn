import { advancePlayerInput, Btn, InputView, type InputFrame } from './input.js';
import { hashState, stableStringify } from './serialize.js';
import {
  createInitialState,
  GRAVITY_PER_TICK,
  PLAYFIELD_HALF_WIDTH,
  WALK_SPEED,
  type FighterState,
  type SimConfig,
  type SimState,
} from './state.js';

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

  // 3. 物理积分（骨架：行走 + 重力 + 地板 + 牵引边界）
  private stepPhysics(): void {
    const { stage, fighters } = this.state;
    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i]!;
      const view = this.views[i]!;
      let dir = 0;
      if (view.held(Btn.left)) dir -= 1;
      if (view.held(Btn.right)) dir += 1;
      f.vx = dir * WALK_SPEED;
      f.vy += GRAVITY_PER_TICK;
      f.x += f.vx;
      f.y += f.vy;
      if (f.y >= stage.floorY) {
        f.y = stage.floorY;
        f.vy = 0;
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
