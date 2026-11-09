import type { MapPackage } from './types.js';

/**
 * core 消费的舞台几何（与 @bvn/core 的 StageState 结构一致；
 * core 自持类型，本包产出结构兼容的纯数据对象）。
 */
export interface StageView {
  leftBound: number;
  rightBound: number;
  /** 主地面（原版 line_player_bottom，isInAir 的兜底吸附面） */
  groundY: number;
  /** 死亡线（原版 line_bottom；出界判定用它） */
  bottomY: number;
  /** 可站立平台段（主地面以外的悬空平台），按 xFrom 升序 */
  floors: { xFrom: number; xTo: number; y: number }[];
}

export interface StageCompileResult {
  stage: StageView;
  /** 出生点（地图未标注时为 null，由调用方决定回退摆位） */
  p1Spawn: { x: number; y: number } | null;
  p2Spawn: { x: number; y: number } | null;
}

/**
 * MapPackage → core 舞台几何。
 * 纯函数（无 I/O），坐标沿用 dump 的归一后系（bottom = gameSize.y）。
 * 偏离原版记录：floors 按 xFrom 升序重排——原版按显示列表序遍历，
 * 命中多条平台时取先遍历者；数据侧先定序，core 端则天然按确定顺序处理。
 */
export function compileMapStage(pkg: MapPackage): StageCompileResult {
  const floors = [...pkg.floors]
    .sort((a, b) => a.xFrom - b.xFrom || a.y - b.y)
    .map((f) => ({ xFrom: f.xFrom, xTo: f.xTo, y: f.y }));
  return {
    stage: {
      leftBound: pkg.left,
      rightBound: pkg.right,
      groundY: pkg.playerBottom,
      bottomY: pkg.bottom,
      floors,
    },
    p1Spawn: pkg.p1pos ? { ...pkg.p1pos } : null,
    p2Spawn: pkg.p2pos ? { ...pkg.p2pos } : null,
  };
}
