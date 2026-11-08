import { createPlayerInput, type PlayerInput } from './input.js';

/** 逻辑坐标系 1000×600，y 向下（DESIGN §5，与原版一致）。 */
export const STAGE_WIDTH = 1000;
export const STAGE_HEIGHT = 600;

/**
 * 版边牵引半宽（ADR-4）：版边 = 两角色中点 ± 该值，clamp 到地图边界。
 * 相机是纯渲染职责，不进模拟。
 */
export const PLAYFIELD_HALF_WIDTH = 500;

// —— 以下常量为骨架占位值，exporter 就绪后由角色/地图 JSON 数据驱动 ——
export const GRAVITY_PER_TICK = 0.5;
export const WALK_SPEED = 4;
export const DEFAULT_FLOOR_Y = 500;
export const DEFAULT_HP = 1000;

export interface FighterState {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  hp: number;
  /** 状态机状态码，沿用原版 FighterActionState 枚举（DESIGN §3.5）。骨架阶段仅 0=站立。 */
  actionState: number;
  input: PlayerInput;
}

export interface MatchState {
  round: number;
  roundFrame: number;
  p1Wins: number;
  p2Wins: number;
}

/** 地图静态几何（每场战斗不变，但仍属 SimState 以支持整体快照/恢复）。 */
export interface StageState {
  leftBound: number;
  rightBound: number;
  floorY: number;
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
  hp?: number;
}

export interface SimConfig {
  seed: number;
  stage: StageState;
  fighters: FighterConfig[];
}

/** 骨架默认配置：P1/P2 在空地图两侧对峙。 */
export function createDefaultConfig(seed: number): SimConfig {
  return {
    seed,
    stage: { leftBound: 0, rightBound: STAGE_WIDTH, floorY: DEFAULT_FLOOR_Y },
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
      y: config.stage.floorY,
      vx: 0,
      vy: 0,
      facing: (i === 0 ? 1 : -1) as 1 | -1,
      hp: fc.hp ?? DEFAULT_HP,
      actionState: 0,
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
