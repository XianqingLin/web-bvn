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
  /** 命中后受击方是否施加重力（原版 HitVO.isApplyG，抓取吸附系为 false；缺省 true） */
  isApplyG: boolean;
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
 * op 的规范词表见 docs/ARCHITECTURE.md；导出器无损保留原版调用名，
 * op 词表的扩充 = 契约 + core 实现 + 本校验器三处同 commit。
 */
export interface TriggerDef {
  /** 符号时间轴内的帧号（0 起，30Hz 动画帧计数） */
  frame: number;
  /**
   * 调用目标：mc=自身动作控制 / fighter=战斗逻辑（辅助语境=owner）/
   * effect=表现 / assister=辅助逻辑 / fighterTarget=owner 的当前目标
   */
  target: 'mc' | 'fighter' | 'effect' | 'assister' | 'fighterTarget' | 'attacker';
  op: string;
  args: TriggerArg[];
}

/**
 * 条件查询（原版帧脚本 `if($xx_ctrler.query(...)){...}else{...}` 的结构化形态，
 * 切片 11）。查询 op 语料集：justHit / targetInRange / getTargetState /
 * getSelf / getTargetSP（原版 FighterCtrler，均为纯读、无副作用）。
 */
export interface TriggerCondition {
  target: TriggerDef['target'];
  op: string;
  args: TriggerArg[];
  /** 原版 `!` 前缀取反 */
  negate?: boolean;
  /** 查询后取的属性链（如 `getSelf().isInAir` → ['isInAir']） */
  path?: string[];
  /** 属性值与字面量比较（缺省 = 真值判定，AS 语义：0/空 为假） */
  cmp?: { op: '==' | '!=' | '<' | '>' | '<=' | '>='; value: number | boolean };
}

/** 条件分支体内的简单调用（与 TriggerDef 同构，去掉 frame 与条件字段）。 */
export interface TriggerCall {
  target: TriggerDef['target'];
  op: string;
  args: TriggerArg[];
}

/** 条件触发：cond 成立执行 then，否则执行 else（切片 11）。 */
export interface CondTriggerDef {
  /** 符号时间轴内的帧号（0 起，与 TriggerDef 对齐） */
  frame: number;
  cond: TriggerCondition;
  then?: TriggerCall[];
  else?: TriggerCall[];
}

/**
 * 结构化提取无法覆盖的帧脚本原文（如辅助的链式调用/任意赋值/形态切换状态变量）。
 * 保留目的：转译参考与 behaviors 插件目录（DESIGN §3.6）的输入。**不直接进引擎执行。**
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
  /**
   * 条件触发（切片 11：if/else 帧脚本结构化）。
   * 条件不可解析的 if 语句不在此列——抑制分支体发射并整体保留 rawScript
   * （修复旧提取「两分支无条件都发」的语义 bug）。
   */
  condTriggers?: CondTriggerDef[];
  /**
   * 循环触发（切片 12：addCustomFunc 数据化）。注册帧起每动画帧评估
   * cond → then，至 untilFrame（removeCustomFunc 帧，独占）或时间轴末。
   * 函数体解析不了的保留 addCustomFunc 触发（core 未注册 = 确定性静默）。
   */
  loopTriggers?: LoopTriggerDef[];
  /** 含未识别语句的帧脚本原文（按 frame 升序） */
  rawScripts?: RawFrameScript[];
}

/** 循环触发条件（有界支持：orihime 治疗检测 / suigetsu owner 受击反应）；negate = 取反。 */
export type LoopTriggerCond =
  | { kind: 'checkHitOwner'; name: string; negate?: boolean }
  | { kind: 'actionStateIn'; values: number[]; negate?: boolean };

/** 循环触发定义（frame/untilFrame 为符号时间轴 0 起帧号）。 */
export interface LoopTriggerDef {
  frame: number;
  /** 失效帧（removeCustomFunc 注册帧；null = 至时间轴末） */
  untilFrame: number | null;
  cond: LoopTriggerCond | null;
  then: TriggerCall[];
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
 * 数据化不了的部分走 behaviors 插件目录。
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
  /** 根时间轴（标签 + 触发 + 循环触发 + rawScripts） */
  timeline: SymbolData;
  symbols: Record<string, SymbolData>;
  /** 增益 buff（切片 12：getSelf().buffEffects 赋值提取；仅 orihime/yachiru） */
  buffEffects?: { attrResistance?: number; phyLifesteal?: number };
  /**
   * attacker 元件脚本（切片 21）：addAttacker 名 → 元件时间轴（绑名规则 =
   * 时间轴唯一 addAttacker 名 ↔ 唯一含 $attacker_ctrler 脚本的符号）。
   * labels 1 基（与 fire 元数据同基）；triggers 帧号 0 基（compileAssistant
   * 统一 +1，与 timeline.triggers 同规则）；target ∈ {attacker, effect}。
   * B5：卫语句惯用语 if(!justHit("x")){gotoAndPlay("y")} 提取为 op='if'
   * 条件触发器（cond/then/else 随附，core dispatchAttackerCond 分派）；
   * 其余条件语句脚本仍不提取（留 raw 审计）。
   */
  attackerScripts?: Record<
    string,
    { labels: Record<string, number>; triggers: TriggerDef[] }
  >;
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
  /** 视觉层整体下移量（原版 initlize：gameSize.y - 原始 line_bottom.y；渲染装配用） */
  bottomOffset: number;
  /** 出生点（缺省 = 地图未标注，引擎回退默认摆位） */
  p1pos: { x: number; y: number } | null;
  p2pos: { x: number; y: number } | null;
  floors: MapFloor[];
  /** 前景层宽度（相机牵引边界参考） */
  mapSize?: { w: number; h: number };
}

/**
 * fire / attacker 元件时间轴元数据（切片 13-A3）。
 *
 * fire(mcName)/addAttacker(mcName) 的命名子元件自带时间轴，原版由
 * Bullet.renderAnimate（30Hz）推进，帧标签驱动生命周期：
 * loop→回跳 loop_start（无则 1）；remove/播尽→移除；hit_over→停止命中；
 * 命中→跳 hit 段播残留；寿命到期有 timeout 标签→跳 timeout 续播。
 * sim 只消费 totalFrames + labels（确定性生命周期）；png 帧在图集
 * （assets，渲染侧），不进烘焙包。
 *
 * B5（逐帧命中矩形）：addAttacker 元件追加 org + hits——原版
 * FighterAttacker.findHitArea 逐帧扫元件命名子对象，getBounds(元件)
 * 解析 HitVO（名字精确匹配动作表，否则去首个 "atm" 再查；无命中区帧
 * = 该帧无判定）。org = 元件原点在 owner 根时间轴坐标系的摆放位
 * （direct=1，生成锚定基准）。fire 弹体不消费这两项（弹体命中矩形
 * 仍是 main 锚），多出无害。
 */
export interface FireHitAreaDef {
  /** 命名子对象实例名（消费端按 owner 动作表精确 → 去 atm 解析） */
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FireTimeline {
  /** 元件自身时间轴总帧数 */
  totalFrames: number;
  /** 帧标签名 → 起始帧（1 基） */
  labels: Record<string, number>;
  /** 元件原点在 owner 根时间轴坐标系的摆放位（direct=1；B5 生成锚定） */
  org?: { x: number; y: number };
  /** 逐帧命中区（键 = 1 基帧号字符串；缺帧 = 该帧无判定；B5） */
  hits?: Record<string, FireHitAreaDef[]>;
}

/** fire 元件元数据包（baked/fires/<ownerKind>/<id>.json，schema bvn/fire@1）。 */
export interface FirePackage {
  schema: 'bvn/fire@1';
  kind: 'fire';
  /** fighter=角色 / assister=辅助（id 可能同名，如 byakuya 双栖） */
  ownerKind: 'fighter' | 'assister';
  id: string;
  /** 元件名 → 时间轴元数据；采集未找到的元件不出现（消费端确定性静默） */
  fires: Record<string, FireTimeline>;
}
