/**
 * 烘焙数据格式（DESIGN §4 / module-map §7.3）。
 * 本包是角色/地图并行转译的契约面：JSON schema + 校验器（DESIGN §7 验收闸门）。
 * 数据被各层只读；core 只消费通过校验的数据。
 */

/** 命中判定定义，与原版 defineAction 表逐字段对应（module-map §6.2）。 */
export interface ActionDef {
  power: number;
  hitType: number;
  hitx: number;
  hity: number;
  /**
   * 受击硬直。原值单位是毫秒（原版 30fps 计时语境），
   * 此处无损保留原值；core 导入时按帧常量换算（DESIGN §3.1 计时帧化）。
   */
  hurtTime: number;
  hurtType: number;
  isBreakDef: boolean;
}

/**
 * 触发参数。标识符引用（如声音/贴图变量名 bsface1、snd_die）无损编码为 { $ref }，
 * 由 core/render 在资源表中解析。
 */
export type TriggerArg =
  | number
  | string
  | boolean
  | null
  | TriggerArg[]
  | { [key: string]: TriggerArg }
  | { $ref: string };

/**
 * 帧触发（FrameTrigger，契约 §帧触发表）。
 * op 的规范词表见 ARCHITECTURE.md；导出器无损保留原版调用名，
 * op 词表的扩充 = 契约 + core 实现 + 本校验器三处同 commit。
 */
export interface TriggerDef {
  /** 符号时间轴内的帧号（0 起，30Hz 动画帧计数） */
  frame: number;
  /** 调用目标：mc=自身动作控制 / fighter=战斗逻辑 / effect=表现 / assister=辅助逻辑 */
  target: 'mc' | 'fighter' | 'effect' | 'assister';
  op: string;
  args: TriggerArg[];
}

/**
 * 结构化提取无法覆盖的帧脚本原文（如辅助的链式调用/任意赋值/形态切换状态变量）。
 * 保留目的：转译参考与 behaviors 插件目录（ADR-6）的输入。**不直接进引擎执行。**
 */
export interface RawFrameScript {
  frame: number;
  raw: string;
}

/** 帧标签 → 时间轴区间（30Hz 动画帧）。 */
export interface LabelRange {
  index: number;
  duration: number;
}

/** 一个动画符号（XFL symbol）的时间轴数据。 */
export interface SymbolData {
  labels: Record<string, LabelRange>;
  triggers: TriggerDef[];
  /** 含未识别语句的帧脚本原文（按 frame 升序） */
  rawScripts?: RawFrameScript[];
}

/** 每形态基础数值（$fighter_ctrler.speed / jumpPower / heavy 等赋值）。 */
export interface FormStats {
  speed?: number;
  jumpPower?: number;
  heavy?: number;
}

/** 声音/特写绑定（原样保留标识符引用）。 */
export interface SoundDefines {
  bishaFaces?: Record<string, string>;
  hurtSounds?: string[];
  hurtFlySound?: string;
  dieSound?: string;
}

/** 一个形态（根时间轴一帧的脚本 + 主符号绑定）。 */
export interface FormData {
  /** 根时间轴帧号（0 起），与 fighter.xml 的 startFrame 对应 */
  frame: number;
  /** fighter.xml 中映射到此帧的角色 ID（多形态角色如 ichigo 有多个） */
  fighterId?: string;
  /** 主动画符号（initMc 绑定的 mc 实例的符号名） */
  symbol: string | null;
  stats: FormStats;
  actions: Record<string, ActionDef>;
  sounds: SoundDefines;
  /** 含未识别语句时的帧脚本原文 */
  rawScript?: string;
}

/** 角色烘焙包：一个角色 SWF/XFL 的全部形态与动画符号。 */
export interface FighterPackage {
  schema: 'bvn/fighter@1';
  /** SWF 基名（fighter.xml 的 file url 去扩展名） */
  id: string;
  /** 来源版本戳（DESIGN §4：输出带源哈希） */
  source: {
    kind: 'xfl';
    path: string;
    /** 源文件内容哈希（sha1），重新导出时用于漂移检测 */
    hash: string;
  };
  forms: FormData[];
  /** 符号名（如 "元件/mc_0059"）→ 时间轴数据，只收含标签或触发的符号 */
  symbols: Record<string, SymbolData>;
}

/**
 * 辅助烘焙包（f_assistant）。辅助是单时间轴（无形态），
 * 脚本含任意逻辑（链式调用/直接赋值），rawScripts 占比天然高——
 * 数据化不了的部分走 behaviors 插件目录（ADR-6）。
 */
export interface AssistantPackage {
  schema: 'bvn/assistant@1';
  id: string;
  source: {
    kind: 'xfl';
    path: string;
    hash: string;
  };
  /** defineAction 表（汇总监助根时间轴全部帧脚本） */
  actions: Record<string, ActionDef>;
  /** 根时间轴（标签 + 触发 + rawScripts） */
  timeline: SymbolData;
  symbols: Record<string, SymbolData>;
}
