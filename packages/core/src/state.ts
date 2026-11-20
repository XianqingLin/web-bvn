import { createPlayerInput, type PlayerInput } from './input.js';
import {
  defaultSlots,
  type AssisterCustomFunc,
  type AssisterDef,
  type FighterDef,
  type FighterSlots,
  type HitDef,
} from './fighter/def.js';

/** 逻辑坐标系 1000×600，y 向下（DESIGN §5，与原版一致）。 */
export const STAGE_WIDTH = 1000;
export const STAGE_HEIGHT = 600;

/**
 * 版边牵引半宽：版边 = 两角色中点 ± 该值，clamp 到地图边界。
 * 相机是纯渲染职责，不进模拟。
 */
export const PLAYFIELD_HALF_WIDTH = 500;

// —— 以下常量为骨架占位值，角色数据接线后由角色 JSON 驱动 ——
export const WALK_SPEED = 4;
export const DEFAULT_GROUND_Y = 500;
export const DEFAULT_HP = 1000;

/** 能量上限（原版 FighterMain.energyMax=100）。 */
export const ENERGY_MAX = 100;
/** 辅助气上限（原版 fzqiMax=100；满气才可召唤，召唤即清零）。 */
export const FZQI_MAX = 100;
/** 辅助气回充（原版 FUZHU_QU_ADD_PERFRAME=0.2，资源量不折算）。 */
export const FZQI_ADD_PERFRAME = 0.2;
/** buff 持续时长换算（原版 hold 秒 × FPS_GAME=60 tick）。 */
export const BUFF_HOLD_TICKS = 60;
/** 能量回充冷却 tick（原版 USE_ENERGY_CD(0.8s)×30 = 24，帧数类不折算）。 */
export const ENERGY_GAP_TICKS = 24;
/** 起始跳跃次数（原版 FighterMain.jumpTimes = 2：地面跳 + 空中跳各耗 1）。 */
export const JUMP_TIMES_START = 2;

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
  /** 主时间轴冻结（原版 stopRenderMainAnimate：target=mc 的 stop 帧触发置位——
   *  播放头停住、帧脚本不再触发，物理照常；换标签/开新动作（原版 goFrame
   *  isPlay=true）解冻。同名标签重设（行走每 tick 重设 走）不解冻） */
  mcHold: boolean;
  /** 当前攻击动作 id（攻击/技能/必杀状态期间非空） */
  attackId: string | null;
  /** 受击/倒地剩余帧（动画帧计数） */
  hurtTimer: number;
  /** 钢身（setSteelBody 触发；受击不掉血外的状态变化） */
  steelBody: boolean;
  /** 能量（瞬步/防御消耗；上限 100，原版 FighterMain.energy） */
  energy: number;
  /** 能量透支（原版 energyOverLoad：透支后慢回至 >30 解除） */
  energyOverload: boolean;
  /** 能量回充冷却（原版 USE_ENERGY_CD × 30 = 24 tick） */
  energyGap: number;
  /** 是否可被命中（瞬步/防御命中无敌窗；原版 isAllowBeHit） */
  isAllowBeHit: boolean;
  /** 防御命中后的无敌剩余 tick（原版 _beHitGap，DEFENSE_GAP_FRAME=4） */
  beHitGap: number;
  /** 动作槽（连段/技能/必杀当前可用动作；帧触发改写，endAction 重填） */
  slots: FighterSlots;
  /** 穿越版边/免推挤（原版 isCross：dash 期间为 true；落地/新动作清除） */
  isCross: boolean;
  /** 是否施加重力斜坡（原版 isApplyG：飞行系角色置 false） */
  applyG: boolean;
  /** 空中可行走（原版 airMove：起跳即置 true 可空中操控；脚本化位移/受击清除） */
  airMove: boolean;
  /** 重击倒地标记（原版 FighterMC._isHeavyDownAttack：击飞 hity>5 → 落地播重尘土） */
  hurtHeavy: boolean;
  /** 击飞三段式子状态（原版 FighterMC._hurtFlyState，切片 54）：0=无；
   *  1=飞行（落地+计数门满足进 2）；2=击飞_落（2 动画帧后分流：重击→倒地，
   *  轻击→弹起）；3=弹起空中（二次落地→倒地）。由 stepHurtFly 30Hz 推进 */
  hurtFlyStage: number;
  /** 击飞最短飞行门剩余动画帧（原版 _hurtFlyFrame：轻击 HURT_JUMP_FRAME=15，
   *  重击 0——计数未尽不进 击飞_落） */
  hurtFlyTimer: number;
  /** 击飞段动画帧计数（原版 _curFrameCount<2 门：击飞_落/击飞_弹 至少展示
   *  2 动画帧才允许下一跳转） */
  hurtFlyHold: number;
  /** 击飞段最低 y（原版 _hurtYMin：弹起速度 = 下落深度/25 夹 [3,8]） */
  hurtApexY: number;
  /** 击飞入射纵向速度（原版 _hity，原始速度空间：重击落地震屏公式用） */
  hurtHity: number;
  /** 空中动作触地续接标签（原版 setTouchFloor；触地或新动作清除） */
  touchFloor: string | null;
  /** 血量上限（hp 系 op / 训练回复的 clamp 基准；原版 hpMax） */
  hpMax: number;
  /** 剩余空中攻击次数（原版 _action.airHitTimes，跳起/触地时重置为 1） */
  airHitTimes: number;
  /** 自定义受击动作（setHurtAction；再受击时播此标签并保持 HURT_ACT_ING） */
  hurtAction: string | null;
  /** 最近命中本角色的攻击动作 id（justHit 系查询；idle/受击恢复清空） */
  lastHurtHitId: string | null;
  /** 最近被防御的攻击动作 id（justHit includeDefense 查询；同上清空） */
  lastDefHitId: string | null;
  /** 命中续接检查区名（setHitTarget；命中续接触发或新动作清除） */
  hitTargetChecker: string | null;
  /** 命中续接目标标签（setHitTarget 配对字段） */
  hitTarget: string | null;
  /** 抓取吸附参数（moveTarget；null = 无吸附。moveTarget(null)/endAct/再受击清除） */
  moveTarget: MoveTargetParam | null;
  /** 当前形态（SimConfig forms 数组下标；0 = 出场形态。doWanKai/switchForm 切换） */
  formIndex: number;
  /** 剩余跳跃次数（原版 _action.jumpTimes，FighterMain.jumpTimes=2 起始；
   *  起跳/空中跳消耗，空中 dash 共享此池） */
  jumpTimes: number;
  /** 起跳延迟剩余 tick（原版 JUMP_DELAY_FRAME=2 地面 / 1 空中；0 = 无待跳） */
  jumpDelay: number;
  /** 瞬身步剩余 tick（0.4s×60 = 24；>0 期间免伤+穿越+意图封锁，原版 _ghostStepIng） */
  ghostTicks: number;
  /** 瞬身步类型（原版 _ghostType：0 地面步 / 1 空中瞬跳 / 2 空中速降） */
  ghostType: number;
  /** 瞬身步连续冷却剩余 tick（原版 _isContinuousGhostStep 恢复计时，仅限地面步） */
  ghostCooldown: number;
  /**
   * 受击链聚合（原版 _currentHurts：HURT_ING/HURT_FLYING 期间每次 doHurt 累加，
   * 回站立 idle() 清空——port 收口在 recoverToNormal）。被动技能门判定消费：
   * damage>210 / 含必杀 / 含破防任一命中 → 不可触发。undefined = 无链
   * （JSON 序列化省略，零漂移）。
   */
  hurtChain?: { damage: number; bisha: boolean; breakDef: boolean } | undefined;
  /** 被动技能触发冷却（原版 _hurtBreakFrame=5 动画帧；>0 期间不可再触发。0 = 无，序列化省略） */
  hurtBreakCd?: number | undefined;
  /** 被动使用后的辅助召唤屏蔽（原版 _usedPassiveCdFrame=5 动画帧；0 = 无，序列化省略） */
  usedPassiveCd?: number | undefined;
  /** 替身残效剩余动画帧（原版 _replaceSkillFrame=30：α0.5 + 免伤；0 = 无，序列化省略） */
  replaceTicks?: number | undefined;
  /** 灵压爆发命中窗剩余动画帧（原版 _explodeHitFrame=10；8>tick>0 时命中区生效；0 = 无，序列化省略） */
  explodeHitTicks?: number | undefined;
  /** 爆发钢身残效剩余动画帧（原版 _explodeSteelFrame=60：每帧重申钢身，被击飞即清；0 = 无，序列化省略） */
  explodeSteelTicks?: number | undefined;
  /** 爆发命中区（原版 _explodeHitVO.currentArea，触发瞬间世界坐标定死不动；
   *  facing = 触发时朝向——击退方向基准随之定死，原版 hitx=15*direct 同语义） */
  explodeHit?: {
    x: number;
    y: number;
    w: number;
    h: number;
    facing: 1 | -1;
  } | undefined;
  /** 最近一次被命中的落地伤害（原版 hurtHit.getDamage()；替身回血量基准。0 = 无，序列化省略） */
  lastHurtDamage?: number | undefined;
  /**
   * comicType（0=死神 1=火影；从 FighterConfig 抄录）：被动技能分流判定
   * （comicType==1 → 替身，否则灵压爆发）+ team 换人气继承加成。
   * 缺省（含合成骨架/旧基线配置）= undefined，按死神侧（爆发）处理且序列化省略。
   */
  comicType?: number | undefined;
  /** 辅助气（原版 fzqi；满 100 可召唤辅助，召唤清零，+0.2/tick 回充） */
  fzqi: number;
  /** 辅助 id（SimConfig.assistants 注册表寻址；null = 无辅助。随状态快照走） */
  assistId: string | null;
  /** 增益 buff（原版 FighterBuffCtrler speedUp/attackUp/defenseUp；null = 未激活。
   *  holdTicks 计满移除；speedUp 为平加值，attackUp/defenseUp 为伤害乘区加值） */
  buffs: {
    speedUp: BuffState | null;
    attackUp: BuffState | null;
    defenseUp: BuffState | null;
  };
  input: PlayerInput;
}

/** 增益 buff 实例（原版 FighterBuffVO 子集）。 */
export interface BuffState {
  /** 加值（speed 平加；attack/defense 伤害乘区加值） */
  value: number;
  /** 剩余 tick（原版 hold 秒 × 60；重复施加刷新本值） */
  holdTicks: number;
}

/** 抓取吸附参数（原版 MoveTargetParamVO 子集，语料字段 followmc/speed）。 */
export interface MoveTargetParam {
  /** 命名子对象（吸附锚点 = 该判定区中心相对自身位置） */
  followmc: string | null;
  /** 吸附速度（px/tick，已 ×SPEED_PLUS；两轴为 0 时直接吸附） */
  speedX: number;
  speedY: number;
}

/**
 * 飞行道具（原版 Bullet 子集，module-map §5.7）。
 * 命中矩形 = 发射帧命名子对象判定区（fire 参数 mcName 对应 def.areas 项），
 * 尺寸固定、随速度平移；x 速度存局部空间（沿 facing），世界位移 = sx×SPEED_PLUS×facing。
 */
export interface BulletState {
  id: number;
  /** 发射者 fighter id（命中结算归属/气回充） */
  ownerId: number;
  /** 发射时朝向（x 局部速度沿此方向；命中击退方向也取它而非 owner 当前朝向） */
  facing: 1 | -1;
  /** 元件名（如 zh1atm；渲染/调试表现用，逻辑不消费） */
  name: string;
  /** 命中矩形（世界坐标） */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 局部空间速度（60Hz：位移 = s×SPEED_PLUS，加速 = add/tick，换算见 DESIGN §3.1） */
  sx: number;
  sy: number;
  /** 每 tick 加速度（原版 params.x.add×2×SPEED_PLUS = add/tick） */
  addX: number;
  addY: number;
  /** 局部空间速度钳制（朝向镜像后两方向语义一致：sx∈[minX,maxX]） */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** 剩余存在 tick（原版 params.hold 秒×FPS_GAME=60）；-1 = 永久 */
  holdTicks: number;
  /** 剩余命中次数（原版 params.hits）；-1 = 无限 */
  hitTimes: number;
  /** 道具对撞血量（原版 params.hp，缺省 100；被击 = 对方 hpMax 或攻击 power） */
  hp: number;
  /** 血量上限（对撞伤害基准 = 对方 hpMax） */
  hpMax: number;
  /** 命中定义（发射动作的 HitDef 拷贝） */
  hit: HitDef;
  /** 仍可命中（hits 耗尽/被摧毁/命中残留段后 false） */
  hitAble: boolean;
  /** 辅助发射（切片 12）：命中不回气（原版 Bullet `owner is FighterMain` 守卫不成立） */
  viaAssist: boolean;
  /** 元件时间轴总帧数（0 = 无动画数据，仅 hold/出界驱动；切片 13-A3） */
  animTotal: number;
  /** 当前动画帧（1 基，30Hz 推进，原版 Bullet.renderAnimate） */
  animFrame: number;
  /** 帧标签 → 起始帧（loop/remove/hit/hit_over/timeout/loop_start） */
  animLabels: Record<string, number>;
  /** 命中残留段（原版 _isHit）：停移动、播尽移除；despawn 时机即残留结束 */
  hitAnim: boolean;
}

/**
 * 独立道具（原版 FighterAttacker，module-map §5.7；B5 逐帧命中矩形）。
 * 与 Bullet 的差异：位置由「相对 owner/target 的偏移」驱动（followTarget /
 * moveToTarget 模式）。位置语义 = 元件原点世界坐标（原版 _x/_y，mc 原点），
 * 命中矩形逐帧解析：fires[name].hits[帧] 命名子对象（元件局部 direct=1）
 * 沿朝向镜像后平移到原点；无命中区帧 = 该帧无判定（原版 findHitArea
 * 逐帧扫描语义）。x/y/w/h 保留生成帧内容矩形供物理夹取与渲染回退。
 * 寿命：有元件时间轴（animTotal>0）= 播尽移除（原版 renderAnimate 的
 * currentFrame == totalFrames-1 → removeSelf，off-by-one 原样保留，无标签
 * 分派——FighterAttacker 类无标签处理）；无时间轴 = holdTicks 占位回退。
 * 偏离（数据缺口回退）：fires 数据缺 org/hits 的元件（旧采集/歧义多库
 * 符号）→ 命中矩形/命中定义取生成帧占位并全程固定（切片 10 占位语义）。
 */
export interface AttackerState {
  id: number;
  /** 发射者 fighter id（命中结算归属/气回充） */
  ownerId: number;
  /** 朝向（偏移镜像基准；命中击退方向也取它） */
  facing: 1 | -1;
  /** 元件名（如 zh3mc；渲染/调试表现用） */
  name: string;
  /** 元件原点世界坐标（命中矩形 = 原点 + 逐帧命中区镜像平移） */
  x: number;
  y: number;
  /** 生成帧内容矩形尺寸（物理地面夹取/渲染回退色块用） */
  w: number;
  h: number;
  /** 回退命中矩形（元件局部 direct=1；仅 fires 缺逐帧数据时消费） */
  fbHit: { x: number; y: number; w: number; h: number };
  /** 原点相对 owner/target 的局部偏移（x 沿 facing 镜像） */
  offsetX: number;
  offsetY: number;
  /** followTarget 模式：每 tick 重定位到 target + offset（原版 followTargetX/Y） */
  followX: boolean;
  followY: boolean;
  /** 是否施加重力（原版 params.applyG；语料全显式 false = 悬停） */
  applyG: boolean;
  gRamp: number;
  /** 剩余存在 tick（仅无时间轴 animTotal=0 时的回退寿命，见偏离注） */
  holdTicks: number;
  /** 元件时间轴总帧数（0 = 无动画数据，寿命走 holdTicks 回退；切片 13-A5） */
  animTotal: number;
  /** 当前动画帧（1 基，30Hz 推进，原版 FighterAttacker.renderAnimate） */
  animFrame: number;
  /** 命中定义（生成帧动作 HitDef 拷贝；仅回退路径消费，逐帧数据优先；
   *  无动作表 = 纯表现实体） */
  hit: HitDef | null;
  /** 命中动作 id（回退路径气回充/必杀判定用；纯表现实体为 null） */
  hitId: string | null;
  /** 仍可命中（命中一次后 false——attacker 无多次命中语料） */
  hitAble: boolean;
  /** owner 为辅助（切片 13-A6）：命中回气仍归召唤者（原版 getOwnerFighter
   *  回溯），渲染图集走辅助侧 fire 包 */
  viaAssist: boolean;
  /** 完全冻结（切片 21，原版 FighterAttacker.stop：不推进/不 findHitArea/
   *  不自动移除；gotoAndPlay 解除） */
  animHold: boolean;
  /** 元件帧标签 → 落点帧（1 基；fires 元数据 ∪ def.attackerScripts 标签，
   *  空 = 元件无标签） */
  animLabels: Record<string, number>;
  /** 来源辅助 def id（viaAssist 时必设：fires 元数据/元件脚本/逐帧命中
   *  数据寻址；角色生成 = null。切片 21 仅脚本来源，B5 扩展） */
  scriptAssistId: string | null;
  /** 本动画帧发生过 gotoAndPlay 跳转（外部/元件脚本）：下一动画步分派落点帧
   *  触发器且不推进（同帧 rewind 用标志传递，值比较无法区分） */
  frameJumped: boolean;
}

export interface MatchState {
  round: number;
  roundFrame: number;
  p1Wins: number;
  p2Wins: number;
  /** 团队模式 roster/换人状态（team 模式才有；undefined = 1v1，JSON 省略零漂移） */
  teams?: TeamsState | undefined;
}

/**
 * 辅助实体（原版 Assister 子集，切片 12）。
 * 单时间轴自由播放：出场帧（gotoAndPlay(2)）起每动画帧跑触发器/循环触发，
 * 播至时间轴末（原版 currentFrame == totalFrames-1 判定）或 owner 死亡即退场；
 * 无独立血量（受击不损）。物理与角色同族：位移 = 速度 × SPEED_PLUS、线性阻尼、
 * 重力斜坡（applyG 可关）。
 */
export interface AssisterState {
  id: number;
  /** 召唤者 fighter id */
  ownerId: number;
  /** 辅助定义 id（SimConfig.assistants 注册表寻址） */
  assistId: string;
  facing: 1 | -1;
  x: number;
  y: number;
  /** 显式速度（60Hz：位移 = v × SPEED_PLUS） */
  vx: number;
  vy: number;
  /** 速度线性衰减（原版 setDamping；每 tick 向 0 wake） */
  dampX: number;
  dampY: number;
  /** 重力斜坡（与角色同族：GRAVITY_START 起步递增封顶） */
  gRamp: number;
  /** 是否施加重力（setApplyG 开关） */
  applyG: boolean;
  onGround: boolean;
  /** 当前动画标签（渲染用；null = 未进入标签段） */
  actLabel: string | null;
  /** 当前动画帧（1 起，30Hz；出场帧 = 2，对应原版 gotoAndPlay(2)） */
  animFrame: number;
  /** 触地续接标签（setTouchFloor；落地消费一次） */
  touchFloor: string | null;
  /** 命中续接检查注册（setHitTarget，原版 renderCheckTargetHit；null = 未注册。
   *  checker 区与目标身体相交 → gotoAndPlay(action)；不清除——窗口由判定区
   *  可见帧自然限定，如 byakuya chkm@50 一帧窗口） */
  hitTargetChecker: string | null;
  hitTargetAction: string | null;
  /** 增益 buff 效果（def.buffEffects 拷贝；生效期 = 在场期间） */
  buffEffects: { attrResistance?: number; phyLifesteal?: number };
  /** customFunc 单槽（切片 21，原版 Assister._customFunc；add 占位即忽略）。
   *  kind 描述符进 sim 状态 = 快照/回滚自洽 */
  customFunc: AssisterCustomFunc | null;
  /** 本动画帧发生过 gotoAndPlay 跳转（含同帧 rewind）。原版 nextFrame 后
   *  回调 customFunc，同帧可再次跳转（byakuya loop 同帧 rewind 循环保活）——
   *  值比较无法区分「没跳」与「跳回同帧」，用标志传递 */
  frameJumped: boolean;
  /** 命中动作 id → 改写后命中力（itachi 动态伤害：生成帧脚本
   *  hitModel.getHitVO("atm1").power = targetHpMax × 0.008 的数据化；
   *  原版直接改写 hitVO 实例，port 按「辅助实例 → 动作 id」存覆写，
   *  其生成的 attacker 命中解析时消费） */
  hitPowerOverrides: Record<string, number>;
}

/**
 * 开局特写演出状态（intro 切片，原版 GameStartCtrler.start1v1/renderStart1v1
 * 状态机）。step：0 特写P1(hold 30) / 1 语音P1（等 开场 播完） / 2 gap(18) /
 * 3 特写P2(30) / 4 语音P2 / 5 gap(18) / 6 resume(6) / 7 字样(156)。
 * hold = 当前步已走 sim tick（原版 holdFrame 秒 × FPS_GAME=60；say 步不用）。
 * skip 仅 step<7 可用（原版 _step<5，字样出场前）。
 */
export interface IntroState {
  step: number;
  hold: number;
  /**
   * 团队换人开场跳侧（原版 GameStartCtrler.start1v1 的 introTeamId）：
   * 值 = 入场方（获得特写/开场的一侧），另一侧跳过 focus/say。1 = P1 入场
   * （step 0..2 后跳 6）；2 = P2 入场（step 从 3 起）；缺省 = 双方全量开场
   * （0..7）。仅 team 模式换人开场设置；缺省时 JSON 序列化省略（零漂移）。
   */
  skip?: 1 | 2 | undefined;
}

/**
 * 团队 roster 槽位（3+1 的 3 名出场序；原版 GameRunFighterGroup 的静态侧）。
 * 配置静态值在开局时抄进 MatchState.teams——换人入场（buildNextRound 后的
 * 新 FighterState 构造）只依赖 SimState，fromState 恢复无需重新注入配置。
 */
export interface TeamSlot {
  id: number;
  /** 出场出生点（原版 resetFight 的 map.p1pos/p2pos，roster 全员同点） */
  x: number;
  y?: number;
  /** comicType（0=死神 1=火影，select.json chars[].comicType）：换人气继承
   *  同系 +100 加成判定（原版 lastLoserData.comicType == data.comicType） */
  comicType?: number;
  /** 辅助 id（per-side 共享一名，原版 3 名成员共用 group 的 assist） */
  assistId: string | null;
  /** 出场形态（forms 数组下标，原版 fighter.xml startFrame 进场形态） */
  formIndex: number;
  /** 血量上限（= 出生 hp；换人入场 FighterState 的 hp/hpMax 基准） */
  hp: number;
}

/** 团队模式 roster/换人状态（原版 GameRunDataVO 两队 FighterGroup + pending）。 */
export interface TeamsState {
  /** 出场序 roster（队首 = 当前出战者；被换下者不回收——原版 removeCurrentFighter） */
  p1: TeamSlot[];
  p2: TeamSlot[];
  /** 待出场 id 队列（roster 出场序，与 pN[0] 不重合） */
  pending1: number[];
  pending2: number[];
}

/**
 * 回合结束演出（原版 GameEndCtrler.render 状态机的 port；非训练对局 KO 置位
 * ——team 换人 + 1v1 终局同一状态机，1v1 无备选直接终局）。step 语义（port 折算）：
 * KO 字样窗口（原版 GameCtrler.pause + KO 字样，折算 WIN_TEXT_GATE）→ 终结慢镜头
 * （原版 FightUI.renderEnd：败方仍击飞 → slowDown(2,0) 半速直到落地；落地后
 * showWinner 延迟，折算 winnerDelay）→ winApplied 前等胜方必杀/万解收尾
 * （原版 isAllowWinState 等待门）→ 落 WIN + 胜利 + 血量恢复（原版 case1，仅
 * team）→ 胜利动作 hold 计满换人/终局（原版 case2/3 + runNext）。
 */
export interface RoundEndState {
  /** 本轮胜方（1/2） */
  winnerSide: 1 | 2;
  winnerId: number;
  loserId: number;
  /** KO 时败方气量（换人气继承基准，原版 lastLoserQi；1v1 无换人仍抄录） */
  loserQi: number;
  /** KO 时败方 comicType（同系加成判定，原版 lastLoserData.comicType） */
  loserComicType: number;
  /** 平局（同 tick 双 KO / 胜方亦死；原版 isDrawGame → 双方换人） */
  draw: boolean;
  /** 胜方 WIN 状态已落（false = 仍在等 KO 字样窗口/慢镜头/showWinner 延迟/必杀万解收尾） */
  winApplied: boolean;
  /** winApplied 时刻的 hold（胜利动作 hold 与换人/终局推进的基准；false 时恒 0） */
  winAppliedHold: number;
  /** 胜方满血（原版 FightUI.showWinner $perfect = hp>=hpMax，WIN 回血前判定；
   *  驱动 winnermc Perfect 段） */
  perfect: boolean;
  /** KO 起已走演出 tick（winApplied 门 = WIN_TEXT_GATE_TICKS；换人/终局 =
   *  winAppliedHold + ROUND_END_TICKS，平局恒 WIN_TEXT_GATE_TICKS + ROUND_END_TICKS） */
  hold: number;
  /** 终结慢镜头激活（原版 FightUI.renderEnd slowDown(2,0)：败方仍击飞 →
   *  全场半速——位移/重力 ×0.5、动画 15Hz——直到败方落地） */
  slow: boolean;
  /** 慢镜头累计 tick（落地时刻的值折算 showWinner 延迟：原版飞尸实时长
   *  <2000ms → 2s 否则 1s；每慢 tick = 2 实 tick → <60 判定） */
  slowTicks: number;
  /** showWinner 延迟（原版 _showWinnerDelay：败方 DEAD 后 2s/1s 再出胜利
   *  姿势；null = 未置——KO 字样窗口内/慢镜头中/平局不置） */
  winnerDelay: number | null;
  /** true = 胜方侧无人可换（1v1 恒终局），match:over 已发，冻结待 app 切结算 */
  over: boolean;
}

/**
 * slowDown 全局慢放（切片 49，原版 EffectCtrler.slowDown(rate, time)；角色/辅助
 * 语料 slowDown(t) 经 FighterEffectCtrler.slowDown 固定 rate=1.5 →
 * EffectCtrler.slowDown(1.5, t*1000)）。原版三重语义：GameCtrler.slow(1.5) →
 * 全体 sprite speedPlus = SPEED_PLUS_DEFAULT/1.5（位移/重力消费侧 ×2/3）+
 * camera.tweenSpd = 2.5×1.5（渲染层折算）；时间轴步进间隔
 * ceil(FPS_GAME/(30/1.5)) = 3（角色/道具/命中判定 60→20Hz）；计时器
 * time×FPS_GAME 每渲染帧递减（EffectCtrler.render 无条件——冻结/特写/
 * 演出期照减，实时间语义）。进 sim（KO 链折算范式，DESIGN §3.5）：
 * 折算 scale 存态，步进间隔在 tick 管线门控。重复触发重置计时
 * （原版 GameCtrler.slow 重入同语义）。
 */
export interface SlowDownState {
  /** 剩余 tick（实时间秒 ×FPS_GAME=60；冻结/特写/演出期照减） */
  ticksLeft: number;
  /** 位移/重力折算 scale（原版 speedPlus = SPEED_PLUS_DEFAULT/rate → 1/rate） */
  scale: number;
  /** 时间轴步进间隔（原版 _renderAnimateGap+1 = ceil(FPS_GAME/(30/rate))） */
  animEvery: number;
}

/**
 * 特写冻结锁（切片 22，原版 EffectCtrler.bisha/wanKai 的 GameCtrler.pause 语义）：
 * 必杀/万解切人演出期间全场冻结（对手/道具/计时/回气全部停走），仅锁主的时间轴
 * 推进（原版施法者画面 render 驱动继续播、帧脚本照常触发——endBisha/endWanKai
 * 即在此期间到来）。锁由 bisha/wanKai 行为 op 置位、endBisha/endWanKai 清除；
 * 锁主脱战（角色回待机/死亡、辅助退场）时保护性清除（防软锁，修复批次 18 教训）。
 */
export interface CutinLockState {
  /** 锁主实体类别（fighter id 与 assister 实体 id 同空间，必须区分） */
  kind: 'fighter' | 'assister';
  /** 锁主 id（fighter 配置 id 或辅助实体 id） */
  id: number;
  /** 演出类型（bisha = 必杀切人 / wanKai = 万解开场） */
  type: 'bisha' | 'wanKai';
}

/**
 * 受击被动演出冻结（切片 55，原版 EffectCtrler.replaceSkill/energyExplode 的
 * GameCtrler.pause 语义）：替身/灵压爆发演出期间全场冻结——角色/道具/辅助
 * 时间轴全部停走（无 justRenderAnimate 白名单，与 bisha/wanKai 不同，施法者
 * 自身也冻结），仅倒计时按实时间递减。渲染层按本字段差分驱动黑幕/地图隐藏/
 * 演出特效（replaceSp@预瞬移点 → replaceSp2@落点 / explodeSp → explodeSp2）。
 */
export interface PassiveFreezeState {
  /** 演出类型（replace = 替身 20 tick / explode = 灵压爆发 42 tick） */
  kind: 'replace' | 'explode';
  /** 施法者 fighter id（渲染层特效定位 + 保护性清除判定） */
  ownerId: number;
  /** 剩余冻结 tick（原版 _replaceSkillFrameHold=FPS_GAME/3 / _explodeSkillFrame=0.7×FPS_GAME） */
  ticksLeft: number;
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
  /** 飞行道具（含独立道具后续形态），按 id 升序 */
  bullets: BulletState[];
  /** 独立道具（原版 FighterAttacker，addAttacker 原语），按 id 升序 */
  attackers: AttackerState[];
  /** 辅助实体（原版 Assister；每 fighter 至多一个在场，按 id 升序） */
  assisters: AssisterState[];
  /** 实体 id 分配计数器（bullets/后续 attacker/assister 共用） */
  nextEntityId: number;
  match: MatchState;
  /** 开局特写演出（intro 切片；无演出/已结束/已跳过 = undefined）。
   *  undefined 被 JSON 序列化省略（stableStringify/pruneEmpty）——
   *  全量哈希与行为哈希零漂移，既有 replay/batch 基线不受影响 */
  intro?: IntroState | undefined;
  /**
   * 团队回合结束/换人演出（team 模式 KO 置位；换人完成/终局后卸下。
   * undefined 被 JSON 序列化省略——1v1 全量哈希零漂移，见 SimState.intro 注）
   */
  roundEnd?: RoundEndState | undefined;
  /** slowDown 全局慢放（undefined = 常速；JSON 序列化省略——无触发即零漂移） */
  slowDown?: SlowDownState | undefined;
  /** 受击被动演出冻结（替身/灵压爆发；undefined = 无，JSON 序列化省略零漂移） */
  passiveFreeze?: PassiveFreezeState | undefined;
  /** 特写冻结锁（null = 无演出冻结） */
  cutinLock: CutinLockState | null;
  /** 打击停顿（hitstop，修复批次 35）：>0 时整局停走（原版 EffectCtrler.freeze →
   *  GameCtrler.pause 语义；倒计时等价于原版独立 render 帧递减）。 */
  freezeTicks: number;
}

export interface FighterConfig {
  id: number;
  x: number;
  /** 出生高度（缺省 = stage.groundY；地图出生点在平台上时由配置方传入） */
  y?: number;
  hp?: number;
  /** 出生气量（缺省 0；满气起点用于测试/验收剧本驱动必杀路径） */
  qi?: number;
  /** 角色运行时定义（缺省 = 合成骨架角色：无判定区/动作，仅物理） */
  def?: FighterDef;
  /**
   * 多形态定义表（切片 10 万解形态切换；按形态顺序排列——含动画形态、
   * 过滤空根帧后的数组，下标即 FighterState.formIndex 寻址空间）。
   * 缺省 = 单形态 [def]。切换（doWanKai/switchForm）只改 FighterState.formIndex。
   */
  forms?: FighterDef[];
  /**
   * 初始形态（forms 数组寻址，缺省 0 = 首形态）。形态角色按原版 fighter.xml
   * startFrame 进场（批次 21F：缺省形态 = 含动画形态中第 startFrame 个），
   * 基础角色 startFrame=1 恒等缺省。 */
  formIndex?: number;
  /** 辅助 id（SimConfig.assistants 注册表寻址；缺省 = 无辅助） */
  assistId?: string;
  /**
   * comicType（0=死神 1=火影，select.json chars[].comicType；缺省 = 无加成）。
   * 仅 team 模式换人气继承加成判定消费（原版 lastLoserData.comicType 比较）。
   */
  comicType?: number;
}

export interface SimConfig {
  seed: number;
  stage: StageState;
  fighters: FighterConfig[];
  /** 辅助定义注册表（静态数据不进 SimState，fromState 恢复时重注入；
   *  键 = AssisterDef.id，经 FighterConfig.assistId 寻址） */
  assistants?: Record<string, AssisterDef>;
  /**
   * 训练模式：命中方与受击方血量恒定回复（不 KO）、计时冻结。
   * 冻结/回复在 stepMatchFlow 内确定性执行，进哈希，两端一致。
   */
  training?: boolean;
  /**
   * 开局特写演出（intro 切片，原版 GameStartCtrler.start1v1；训练模式无开场
   * = 原版 TRAINING(40) 直接 actionEnable=true 语义）。缺省 false——replay/
   * batch 基线配置不传，intro 恒 null 零漂移。
   */
  intro?: boolean;
  /**
   * 团队模式 roster（3+1 的 3 名出场序，per side；缺省 = 1v1）。存在时：
   * config.fighters 须含全部 roster id（可含 3+1 之外的多余项——忽略），
   * 只有各队队首进入 SimState.fighters，其余进 MatchState.teams 槽位；
   * 换人/终局流转在 sim 内确定性推进（切片 36）。
   */
  teams?: { p1: number[]; p2: number[] };
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
  // team 模式：roster 槽位抄进 MatchState（出场序），仅各队队首进 fighters
  //（sim 是严格的 2 活跃角色模型；待出场者由换人流程构造全新 FighterState）
  const teams: TeamsState | undefined = config.teams
    ? (() => {
        const byId = new Map(config.fighters.map((fc) => [fc.id, fc]));
        const slotOf = (id: number): TeamSlot => {
          const fc = byId.get(id);
          if (!fc) throw new Error(`teams roster id ${id} missing from config.fighters`);
          return {
            id: fc.id,
            x: fc.x,
            ...(fc.y !== undefined ? { y: fc.y } : {}),
            ...(fc.comicType !== undefined ? { comicType: fc.comicType } : {}),
            assistId: fc.assistId ?? null,
            formIndex: fc.formIndex ?? 0,
            hp: fc.hp ?? DEFAULT_HP,
          };
        };
        return {
          p1: config.teams.p1.map(slotOf),
          p2: config.teams.p2.map(slotOf),
          pending1: config.teams.p1.slice(1),
          pending2: config.teams.p2.slice(1),
        };
      })()
    : undefined;
  const activeIds = config.teams
    ? new Set([config.teams.p1[0]!, config.teams.p2[0]!])
    : null;
  const fighters: FighterState[] = [...config.fighters]
    .filter((fc) => activeIds === null || activeIds.has(fc.id))
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
      qi: fc.qi ?? 0,
      actionState: 0,
      onGround: true,
      actLabel: null,
      animFrame: 0,
      labelLock: 0,
      mcHold: false,
      attackId: null,
      hurtTimer: 0,
      steelBody: false,
      energy: ENERGY_MAX,
      energyOverload: false,
      energyGap: 0,
      isAllowBeHit: true,
      beHitGap: 0,
      isCross: false,
      applyG: true,
      airMove: false,
      hurtHeavy: false,
      hurtFlyStage: 0,
      hurtFlyTimer: 0,
      hurtFlyHold: 0,
      hurtApexY: 0,
      hurtHity: 0,
      touchFloor: null,
      hpMax: fc.hp ?? DEFAULT_HP,
      airHitTimes: 1,
      hurtAction: null,
      lastHurtHitId: null,
      lastDefHitId: null,
      hitTargetChecker: null,
      hitTarget: null,
      moveTarget: null,
      formIndex: fc.formIndex ?? 0,
      jumpTimes: JUMP_TIMES_START,
      jumpDelay: 0,
      ghostTicks: 0,
      ghostType: 0,
      ghostCooldown: 0,
      // 被动技能字段（hurtChain/被动冷却/残效）缺省不落键（undefined 零漂移）；
      // comicType 仅在配置提供时抄录（旧基线配置无此键 → 零漂移）
      ...(fc.comicType !== undefined ? { comicType: fc.comicType } : {}),
      fzqi: FZQI_MAX,
      assistId: fc.assistId ?? null,
      buffs: { speedUp: null, attackUp: null, defenseUp: null },
      slots: defaultSlots(fc.def ?? null),
      input: createPlayerInput(),
    }));
  return {
    tick: 0,
    rngState: config.seed >>> 0,
    stage: { ...config.stage },
    fighters,
    bullets: [],
    attackers: [],
    assisters: [],
    nextEntityId: 1,
    match: {
      round: 1,
      roundFrame: 0,
      p1Wins: 0,
      p2Wins: 0,
      // teams 缺省不落键——1v1 全量哈希零漂移（见 SimState.intro 注）
      ...(teams !== undefined ? { teams } : {}),
    },
    // intro 缺省时字段不落键（undefined）——全量状态哈希零漂移（见 SimState 注）
    ...(config.intro === true ? { intro: { step: 0, hold: 0 } as IntroState } : {}),
    cutinLock: null,
    freezeTicks: 0,
  };
}
