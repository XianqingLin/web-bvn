/**
 * 运行时角色包 → core 消费的角色定义（编译纯函数，无 I/O）。
 *
 * 结构兼容 @bvn/core 的 FighterDef（core 自持类型，本包产出纯数据对象），
 * 与 compileMapStage 同一模式：core 不 import data，数据经 SimConfig 注入。
 *
 * 数据源策略：
 * - 动画几何（labels/areas/totalFrames）：runtime dump（引擎 getBounds 真实值）；
 * - 形态数值（speed/jumpPower/heavy）与形态动作表：XFL 静态包按形态合并，
 *   runtime dump 的 actions 是全形态合并表（后注册覆盖），不能按形态取；
 * - 帧触发：只存在于 XFL 静态符号时间轴（runtime dump 无触发），
 *   帧号 0 起 → 换算为 1 起，与 areas 的 frame 对齐。
 * - XFL 形态匹配：XFL form.frame 为 0 起根帧号，runtime form.rootFrame 为 1 起，
 *   即 xflForm.frame === runtimeForm.rootFrame - 1。
 */
import type {
  ActionDef,
  AreaRect,
  FighterPackage,
  LabelRange,
  RuntimeFighterPackage,
  TriggerDef,
} from './types.js';

/** core 消费的角色运行时定义（与 @bvn/core FighterDef 结构一致）。 */
export interface FighterView {
  /** SWF 基名 */
  id: string;
  /** 使用的形态下标（runtime.forms 下标） */
  formIndex: number;
  /** 形态数值（已含原版原始值；core 导入时按 ×SPEED_PLUS 换算） */
  speed: number;
  jumpPower: number;
  heavy: number;
  /** 本形态动作表（HitVO，原版 defineAction 参数） */
  actions: Record<string, ActionDef>;
  /** 帧标签 → 区间（index 0 起，30Hz） */
  labels: Record<string, LabelRange>;
  /** 动画帧（1 起，30Hz）→ 判定区（root 本地坐标，direct=1 朝右） */
  areas: Record<number, AreaRect[]>;
  totalFrames: number;
  /** 帧触发（帧号已换算为 1 起，与 areas 对齐） */
  triggers: TriggerDef[];
  /**
   * 已验证存在的攻击动作 id → 动画标签（原版 checkFrame 语义：
   * 映射缺失 = 该角色没有此动作帧，动作不可用）。
   */
  attackLabels: Record<string, string>;
}

/** 形态数值缺省值（XFL 包缺形态脚本时兜底；ichigo 初形态实测值）。 */
const DEFAULT_STATS = { speed: 6, jumpPower: 15, heavy: 3 };

/**
 * POC 动作 → 动画标签映射（原版 FighterMcCtrler 的 setAttack 帧名约定）。
 * 覆盖通用砍击族：kN→砍N、kjN→跳砍/跳招、tk/tz→摔1/摔2。
 * 技/必杀族的帧名各角色可自定义（setSkill、setBisha 系触发），留给 behaviors 接线。
 */
function deriveAttackLabel(
  actionId: string,
  labels: Record<string, LabelRange>,
): string | null {
  const m = /^k(\d+)$/.exec(actionId);
  if (m) return labels[`砍${m[1]}`] !== undefined ? `砍${m[1]}` : null;
  if (/^kj\d+$/.test(actionId)) {
    if (labels['跳砍'] !== undefined) return '跳砍';
    if (labels['跳招'] !== undefined) return '跳招';
    return null;
  }
  if (actionId === 'tk') return labels['摔1'] !== undefined ? '摔1' : null;
  if (actionId === 'tz') return labels['摔2'] !== undefined ? '摔2' : null;
  return null;
}

/**
 * 编译 runtime 包为 core 角色定义。
 * @param runtime 运行时 dump 包（必需：几何/动作数据源）
 * @param xfl     XFL 静态包（可选：形态数值/形态动作/帧触发）
 * @param formIndex 指定形态；缺省取第一个有动画数据的形态
 */
export function compileFighterRuntime(
  runtime: RuntimeFighterPackage,
  xfl?: FighterPackage,
  formIndex?: number,
): FighterView {
  const idx = formIndex ?? runtime.forms.findIndex((f) => f.totalFrames > 0);
  const form = runtime.forms[idx];
  if (!form || form.totalFrames === 0) {
    throw new Error(`${runtime.id}: 没有含动画数据的形态（formIndex=${idx}）`);
  }
  // XFL 形态匹配（0 起 ↔ 1 起差一）：rootFrame-1 对应 XFL form.frame
  const xflForm =
    xfl?.forms.find((f) => f.frame === form.rootFrame - 1) ?? undefined;

  const stats = { ...DEFAULT_STATS, ...(xflForm?.stats ?? {}) };

  // 形态动作表：runtime 全局表按本形态注册序取样（防跨形态覆盖），
  // XFL 形态表覆盖（按形态精确；字段与 runtime 已零漂移交叉验证）。
  const actions: Record<string, ActionDef> = {};
  for (const id of form.actionsRegistered) {
    const def = runtime.actions[id];
    if (def) actions[id] = def;
  }
  if (xflForm) Object.assign(actions, xflForm.actions);

  // 帧触发：XFL 符号时间轴，帧号 0 起 → 1 起
  const symbol = xflForm?.symbol ? xfl?.symbols[xflForm.symbol] : undefined;
  const triggers: TriggerDef[] = symbol
    ? symbol.triggers.map((t) => ({ ...t, frame: t.frame + 1 }))
    : [];

  const areas: Record<number, AreaRect[]> = {};
  for (const fr of form.frames) {
    if (fr.areas.length > 0) areas[fr.frame] = fr.areas;
  }

  const attackLabels: Record<string, string> = {};
  for (const id of Object.keys(actions)) {
    const label = deriveAttackLabel(id, form.labels);
    if (label !== null) attackLabels[id] = label;
  }

  return {
    id: runtime.id,
    formIndex: idx,
    ...stats,
    actions,
    labels: form.labels,
    areas,
    totalFrames: form.totalFrames,
    triggers,
    attackLabels,
  };
}
