import { createPlayerInput, type PlayerInput } from './input.js';
import type { FighterDef } from './fighter/def.js';

/** 逻辑坐标系 1000×600，y 向下（DESIGN §5，与原版一致）。 */
export const STAGE_WIDTH = 1000;
export const STAGE_HEIGHT = 600;

/**
 * 版边牵引半宽（ADR-4）：版边 = 两角色中点 ± 该值，clamp 到地图边界。
 * 相机是纯渲染职责，不进模拟。
 */
export const PLAYFIELD_HALF_WIDTH = 500;

// —— 以下常量为骨架占位值，角色数据接线后由角色 JSON 驱动 ——
export const WALK_SPEED = 4;
export const DEFAULT_GROUND_Y = 500;
export const DEFAULT_HP = 1000;

/** 可站立平台段（原版 FloorVO：x ∈ [xFrom, xTo]，站面高度 y，y 向下）。 */
export interface FloorSpan {
  xFrom: number;
  xTo: number;
  y: number;
}

/** 地图静态几何（每场战斗不变，但仍属 SimState 以支持整体快照/恢复）。 */
export interface StageState {
  leftBound: number;
  rightBound: number;
  /** 主地面（原版 line_player_bottom，落地判定的兜底吸附面） */
  groundY: number;
  /** 死亡线（原版 line_bottom；出界判定用它，死亡流程接线前仅记录） */
  bottomY: number;
  /** 可站立平台段（主地面以外的悬空平台），按 xFrom 升序 */
  floors: FloorSpan[];
}

export interface FighterState {
  id: number;
  x: number;
  y: number;
  /** 显式水平速度（行走/击退/击飞；行走时每 tick 由输入重置） */
  vx: number;
  /** 显式垂直速度（跳跃/击飞；重力不计入此值——见 gRamp） */
  vy: number;
  /** 速度线性衰减（原版 _damping：每 tick 向 0 衰减 vx/vy；跳跃/受击时设置） */
  dampX: number;
  dampY: number;
  /** 重力位移斜坡（原版 BaseGameSprite._g：离地 GRAVITY_START 起，空中递增至封顶） */
  gRamp: number;
  facing: 1 | -1;
  hp: number;
  /** 气（原版 qi，上限 300；必杀资源） */
  qi: number;
  /** 状态机状态码（core/fighter/def.ts ActionState，原版 FighterActionState 子集） */
  actionState: number;
  /** 是否在地面（物理落地判定结果；跳跃/击飞状态转移用） */
  onGround: boolean;
  /** 当前动画标签（内层时间轴；null = 未接角色数据） */
  actLabel: string | null;
  /** 当前动画帧（内层时间轴绝对帧号，1 起，30Hz） */
  animFrame: number;
  /** 标签锁定剩余帧（动画帧）：>0 时普通行动不覆盖标签（如 落地 恢复） */
  labelLock: number;
  /** 当前攻击动作 id（ATTACK_ING 期间非空） */
  attackId: string | null;
  /** 本次攻击已命中过的目标 id（一击一目标规则） */
  attackHit: number[];
  /** 受击/倒地剩余帧（动画帧计数） */
  hurtTimer: number;
  /** 钢身（setSteelBody 触发；受击不掉血外的状态变化） */
  steelBody: boolean;
  input: PlayerInput;
}

export interface MatchState {
  round: number;
  roundFrame: number;
  p1Wins: number;
  p2Wins: number;
}

/**
 * 全部模拟状态收进单个 SimState（契约硬规则 1），
 * 可整体快照/恢复，为 rollback 预留（DESIGN §3.8）。
 */
export interface SimState {
  tick: number;
  rngState: number;
  stage: StageState;
  /** 始终按 id 升序（契约硬规则 3：多实体同帧更新定序遍历）。 */
  fighters: FighterState[];
  match: MatchState;
}

export interface FighterConfig {
  id: number;
  x: number;
  /** 出生高度（缺省 = stage.groundY；地图出生点在平台上时由配置方传入） */
  y?: number;
  hp?: number;
  /** 角色运行时定义（缺省 = 合成骨架角色：无判定区/动作，仅物理） */
  def?: FighterDef;
}

export interface SimConfig {
  seed: number;
  stage: StageState;
  fighters: FighterConfig[];
}

/** 骨架默认配置：P1/P2 在空地图两侧对峙（合成舞台，与真实地图数据无关）。 */
export function createDefaultConfig(seed: number): SimConfig {
  return {
    seed,
    stage: {
      leftBound: 0,
      rightBound: STAGE_WIDTH,
      groundY: DEFAULT_GROUND_Y,
      bottomY: STAGE_HEIGHT,
      floors: [],
    },
    fighters: [
      { id: 1, x: 300 },
      { id: 2, x: 700 },
    ],
  };
}

export function createInitialState(config: SimConfig): SimState {
  const fighters: FighterState[] = [...config.fighters]
    .sort((a, b) => a.id - b.id)
    .map((fc, i) => ({
      id: fc.id,
      x: fc.x,
      y: fc.y ?? config.stage.groundY,
      vx: 0,
      vy: 0,
      dampX: 0,
      dampY: 0,
      // 站立状态下的 gRamp 即离地初值（原版 setInAir(false) → _g=4，60Hz 折半 = 2）
      gRamp: 2,
      facing: (i === 0 ? 1 : -1) as 1 | -1,
      hp: fc.hp ?? DEFAULT_HP,
      qi: 0,
      actionState: 0,
      onGround: true,
      actLabel: null,
      animFrame: 0,
      labelLock: 0,
      attackId: null,
      attackHit: [],
      hurtTimer: 0,
      steelBody: false,
      input: createPlayerInput(),
    }));
  return {
    tick: 0,
    rngState: config.seed >>> 0,
    stage: { ...config.stage },
    fighters,
    match: { round: 1, roundFrame: 0, p1Wins: 0, p2Wins: 0 },
  };
}
