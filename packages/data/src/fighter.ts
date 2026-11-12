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
  FireTimeline,
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
  /** 根时间轴帧号（1 起）——万解 doWanKai(frame) 绝对帧跳转的形态寻址基准 */
  rootFrame: number;
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
  /** fire 元件时间轴元数据（baked fires 包注入，切片 13-A3；缺元件 = 无动画生命周期；
   *  B5 起 addAttacker 元件含 org/hits 逐帧命中数据） */
  fires?: Record<string, FireTimeline>;
}

/** 形态数值缺省值（XFL 包缺形态脚本时兜底；ichigo 初形态实测值）。 */
const DEFAULT_STATS = { speed: 6, jumpPower: 15, heavy: 3 };

/**
 * 动作 id → 动画标签映射（切片 5 按判定区实证修正，原版 FighterMcCtrler
 * setAttack/setSkill/setBisha 系默认帧名约定，module-map §5.3）：
 *   kN→砍N；kjN→砍技N（攻击取消技，非跳砍——kj1atm 判定区实证在砍技1 段）；
 *   tk/tz→跳砍/跳招（空中攻击/技能）；zhN→招N；shN→摔N；
 *   bs→必杀、sbs→上必杀、cbs→超必杀、kbs→空中必杀（B3；原版 HitVO.isBisha
 *   含 kbs 分支 + FighterAILogic airBisha 引用 + FighterHitRange.BISHA_AIR
 *   = "kbsmian"，语料 18 角色主 id kbs + kbs1~4 分段动作——分段 id 只经
 *   判定区名解析，同 bs1/sbs1 惯例不进本映射）。
 * 标签不存在 = 该动作不可用（原版 checkFrame 语义）。
 */
function deriveAttackLabel(
  actionId: string,
  labels: Record<string, LabelRange>,
): string | null {
  const m = /^k(\d+)$/.exec(actionId);
  if (m) return labels[`砍${m[1]}`] !== undefined ? `砍${m[1]}` : null;
  const kj = /^kj(\d+)$/.exec(actionId);
  if (kj) return labels[`砍技${kj[1]}`] !== undefined ? `砍技${kj[1]}` : null;
  const zh = /^zh(\d+)$/.exec(actionId);
  if (zh) return labels[`招${zh[1]}`] !== undefined ? `招${zh[1]}` : null;
  const sh = /^sh(\d+)$/.exec(actionId);
  if (sh) return labels[`摔${sh[1]}`] !== undefined ? `摔${sh[1]}` : null;
  if (actionId === 'tk') return labels['跳砍'] !== undefined ? '跳砍' : null;
  if (actionId === 'tz') return labels['跳招'] !== undefined ? '跳招' : null;
  if (actionId === 'bs') return labels['必杀'] !== undefined ? '必杀' : null;
  if (actionId === 'sbs') return labels['上必杀'] !== undefined ? '上必杀' : null;
  if (actionId === 'cbs') return labels['超必杀'] !== undefined ? '超必杀' : null;
  if (actionId === 'kbs') return labels['空中必杀'] !== undefined ? '空中必杀' : null;
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
  fires?: FighterView['fires'],
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

  // 帧触发：XFL 符号时间轴，帧号 0 起 → 1 起。
  // 条件触发（切片 11）并入同列表：op='if' 由 core 分派器识别求值
  const symbol = xflForm?.symbol ? xfl?.symbols[xflForm.symbol] : undefined;
  const triggers: TriggerDef[] = symbol
    ? symbol.triggers.map((t) => ({ ...t, frame: t.frame + 1 }))
    : [];
  if (symbol?.condTriggers) {
    for (const t of symbol.condTriggers) {
      // 条件触发映射为 op='if' 条目（cond/then/else 随附；core 按此分派）
      triggers.push({ ...t, frame: t.frame + 1, target: 'mc', op: 'if', args: [] } as TriggerDef);
    }
    triggers.sort((a, b) => a.frame - b.frame);
  }

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
    rootFrame: form.rootFrame,
    ...stats,
    actions,
    labels: form.labels,
    areas,
    totalFrames: form.totalFrames,
    triggers,
    attackLabels,
    ...(fires ? { fires } : {}),
  };
}

/**
 * 编译 runtime 包的**全部**可动画形态为 core 角色定义（切片 10 多形态注册：
 * 万解 doWanKai() 根时间轴翻页切换形态）。只收含动画数据的形态，
 * 按 runtime.forms 顺序排列——下标 0 = 缺省出场形态（与 compileFighterRuntime
 * 的单形态选择一致）。缺 XFL 时触发器为空（与单形态行为一致）。
 */
export function compileFighterForms(
  runtime: RuntimeFighterPackage,
  xfl?: FighterPackage,
  fires?: FighterView['fires'],
): FighterView[] {
  const out: FighterView[] = [];
  for (let i = 0; i < runtime.forms.length; i++) {
    if (runtime.forms[i]!.totalFrames === 0) continue;
    out.push(compileFighterRuntime(runtime, xfl, i, fires));
  }
  if (out.length === 0) {
    throw new Error(`${runtime.id}: 没有含动画数据的形态`);
  }
  return out;
}
