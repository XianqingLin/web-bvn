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

/* =====================================================================
 * 运行时导出（bvn/fighter-runtime@1 / bvn/map@1）
 *
 * 来源：tools/bridge 注入原版 AIR 应用自动 dump（tools/bridge/inject-methods.as3）。
 * 只有运行时才拿得到的数据：命名判定区逐帧几何（引擎 getBounds 的真实值，
 * XFL 静态解析无法可靠复现矩阵叠加）、AImain AI 活动范围、地图边界/出生点/地板。
 * 坐标系：root 本地坐标、direct=1（朝右）、x/y 为矩形左上角——
 * 与引擎 FighterMC.findHitArea/findBodyArea 的 getBounds(_fighterDisplay) 参照系一致。
 * ===================================================================== */

/** 判定区矩形（root 本地坐标，direct=1 朝右）。 */
export interface AreaRect {
  /** 命名子节点名：bdmn=受击体区 / atmN=命中区 / AImain 子节点=AI 范围 */
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 内层主动画时间轴一帧的判定区（30Hz；只收含判定区的帧，空帧隐式为无判定）。 */
export interface RuntimeFrameAreas {
  /** 帧号（1 起，与原版时间轴一致） */
  frame: number;
  /** 帧标签（若有；引擎 goFrame 按标签寻帧） */
  label?: string;
  areas: AreaRect[];
  /** dump 时帧脚本异常（该帧数据可能不完整） */
  err?: string;
}

/** 一个形态的内层动画时间轴几何（角色）或 root 时间轴几何（辅助，单形态）。 */
export interface RuntimeFormGeometry {
  /** 根时间轴帧号（1 起；辅助恒为 1） */
  rootFrame: number;
  /** 本形态帧脚本注册的 action id（懒注册顺序，佐证 defineAction 归属形态） */
  actionsRegistered: string[];
  totalFrames: number;
  /** 标签 → 区间（index 0 起；由带标签帧与相邻标签推导，duration 含至下一标签前） */
  labels: Record<string, LabelRange>;
  frames: RuntimeFrameAreas[];
  /** AImain 子节点（AI 出招/移动范围，引擎 initHitRange 读取后即移除） */
  aiRanges?: AreaRect[];
  aiRangesErr?: string;
  /** dump 时形态级异常（帧脚本抛错，该形态数据可能不完整） */
  err?: string;
}

/**
 * 运行时角色/辅助烘焙包。
 * actions 为运行时 HitVO 表（原版 defineAction 参数逐字段对应），
 * 兼作 XFL 静态提取（bvn/fighter@1）的交叉验证证据——字段漂移见
 * baked/runtime-ingest-report.json。
 */
export interface RuntimeFighterPackage {
  schema: 'bvn/fighter-runtime@1';
  id: string;
  source: {
    kind: 'runtime-dump';
    path: string;
    hash: string;
  };
  /** fighter=角色（多形态） / assister=辅助（单形态，root 即动画时间轴） */
  kind: 'fighter' | 'assister';
  rootTotalFrames: number;
  forms: RuntimeFormGeometry[];
  actions: Record<string, ActionDef>;
  /** defineAction 注册顺序（重复注册 = 覆盖，与引擎 _hitObj 行为一致） */
  actionOrder: string[];
  /** bishaFaces 绑定名（万解特写） */
  bishaFaces: string[];
}

/** 地图地板段（引擎 FloorVO：[xFrom,xTo] 高度 y，可站立/可落击）。 */
export interface MapFloor {
  name: string;
  xFrom: number;
  xTo: number;
  y: number;
}

/** 地图烘焙包（引擎 MapMain.initlize 的计算结果）。 */
export interface MapPackage {
  schema: 'bvn/map@1';
  id: string;
  name: string;
  source: {
    kind: 'runtime-dump';
    path: string;
    hash: string;
  };
  bgm: string;
  fileUrl: string;
  gameSize: { x: number; y: number };
  /** 版边（归一后坐标：bottom = gameSize.y） */
  left: number;
  right: number;
  bottom: number;
  /** 玩家可站底线（低于 bottom 的死亡线语义见 module-map） */
  playerBottom: number;
  /** 出生点（缺省 = 地图未标注，引擎回退默认摆位） */
  p1pos: { x: number; y: number } | null;
  p2pos: { x: number; y: number } | null;
  floors: MapFloor[];
  /** 前景层宽度（相机牵引边界参考） */
  mapSize?: { w: number; h: number };
}
