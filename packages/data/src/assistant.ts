/**
 * 辅助烘焙包 → core 消费的辅助定义（编译纯函数，无 I/O）。
 *
 * 与 compileFighterRuntime 同一模式（core 不 import data，数据经 SimConfig 注入）：
 * - 动画几何（labels/areas/totalFrames）：runtime dump（assister 单形态，root 即时间轴）；
 * - 动作表/触发器/循环触发/增益 buff：XFL 静态包 root 时间轴；
 * - 帧号 0 起 → 1 起（与角色触发器同规则，与 areas 的 frame 对齐）。
 * - 符号级（symbols）数据不编译：辅助符号时间轴全部是 attacker 系
 *   （$attacker_ctrler），归切片 13。
 */
import type {
  ActionDef,
  AreaRect,
  AssistantPackage,
  LabelRange,
  LoopTriggerDef,
  RuntimeFighterPackage,
  TriggerDef,
} from './types.js';

/** core 消费的辅助运行时定义（与 @bvn/core AssisterDef 结构一致）。 */
export interface AssisterView {
  id: string;
  /** 动作表（原版 defineAction，assister 版名字即命中区名，如 atm1） */
  actions: Record<string, ActionDef>;
  /** 帧标签 → 区间（index 0 起，30Hz） */
  labels: Record<string, LabelRange>;
  /** 动画帧（1 起，30Hz）→ 判定区（root 本地坐标，direct=1 朝右） */
  areas: Record<number, AreaRect[]>;
  totalFrames: number;
  /** 帧触发（帧号已换算为 1 起） */
  triggers: TriggerDef[];
  /** 循环触发（frame/untilFrame 已换算为 1 起；untilFrame 独占语义保持） */
  loopTriggers: LoopTriggerDef[];
  /** 增益 buff（切片 12：orihime attrResistance / yachiru phyLifesteal） */
  buffEffects?: { attrResistance?: number; phyLifesteal?: number };
  /** fire 元件时间轴元数据（baked fires 包注入，切片 13-A3；缺元件 = 无动画生命周期） */
  fires?: Record<string, { totalFrames: number; labels: Record<string, number> }>;
  /**
   * attacker 元件脚本（切片 21）：addAttacker 名 → 元件时间轴。
   * labels 1 基；triggers 帧号已 +1（1 起，与 animFrame 同基）；
   * target ∈ {attacker, effect}。core stepAttackerAnim 逐帧分派。
   */
  attackerScripts?: Record<
    string,
    { labels: Record<string, number>; triggers: TriggerDef[] }
  >;
}

export function compileAssistant(
  xfl: AssistantPackage,
  runtime: RuntimeFighterPackage,
  fires?: AssisterView['fires'],
): AssisterView {
  const form = runtime.forms[0];
  if (!form || form.totalFrames === 0) {
    throw new Error(`${runtime.id}: 辅助 runtime 包无动画几何`);
  }

  const areas: Record<number, AreaRect[]> = {};
  for (const fr of form.frames) {
    if (fr.areas.length > 0) areas[fr.frame] = fr.areas;
  }

  return {
    id: xfl.id,
    actions: xfl.actions,
    labels:
      Object.keys(form.labels).length > 0 ? form.labels : xfl.timeline.labels,
    areas,
    totalFrames: form.totalFrames,
    triggers: xfl.timeline.triggers.map((t) => ({ ...t, frame: t.frame + 1 })),
    loopTriggers: (xfl.timeline.loopTriggers ?? []).map((t) => ({
      ...t,
      frame: t.frame + 1,
      untilFrame: t.untilFrame === null ? null : t.untilFrame + 1,
    })),
    ...(xfl.buffEffects !== undefined ? { buffEffects: xfl.buffEffects } : {}),
    ...(fires ? { fires } : {}),
    ...(xfl.attackerScripts !== undefined
      ? {
          attackerScripts: Object.fromEntries(
            Object.entries(xfl.attackerScripts).map(([name, s]) => [
              name,
              {
                labels: s.labels,
                triggers: s.triggers.map((t) => ({ ...t, frame: t.frame + 1 })),
              },
            ]),
          ),
        }
      : {}),
  };
}
