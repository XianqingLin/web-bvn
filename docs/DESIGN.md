# BVN Web —— 设计文档

> 本文档回答"为什么这么做"；**"必须怎么做"以 [ARCHITECTURE.md](ARCHITECTURE.md)（引擎契约）为准**。
> 读者：项目决策者、需要理解设计背景的协作者。干活的 AI 只需读契约。
> 前置阅读：[BVN-module-map.md](BVN-module-map.md)（原版逆向）。
> 决策变更直接修改对应设计段，写明理由与日期（本仓不用 ADR 编号表）。
>
> **与 PROGRESS 的分工**：变动默认只改 PROGRESS（台账）；产生"要永远记住的规则/规格"才改本文档（**就地修改对应规格段，不追加日志**）；决策变更就地改对应段写明理由与日期。任何时刻不维护"待收紧"式欠账清单——欠的活记 PROGRESS §4.2。

---

## 1. 设计原则

1. **确定性模拟核心（core）是唯一真理来源。** 同一输入序列 → 逐帧相同状态，可哈希校验。渲染、联机、回放、AI 都建立在"喂输入、读快照"一个接口上。
2. **数据驱动。** 61 个角色的差异压进 JSON，core 只有一套通用引擎。新增角色 = 新增数据。
3. **联机不侵入逻辑。** 帧同步只是"输入从网络来而不是键盘来"；单机、联机、回放、对拍共用同一份模拟代码。
4. **重构优于复刻。** 原版源码是参考规格书；行为对齐手感，结构自由重写。
5. **对拍是脚手架。** 阶段 1 用它对齐手感，之后退为回归工具。

文档方法论（借鉴 Claude of Duty 的 AI 协作实践）：契约化硬规则、事件词表集中登记、门禁工具先行；高耦合的 core 单线程开发，天然独立的批量任务（角色转译等）才并行 fan-out。

## 2. 分层架构

```
app → render → core ← net      （依赖只许向下；data 被各层只读）
```

- **core**：确定性模拟，60Hz 固定 tick，纯 TS 无 DOM，可在 Node 运行（对拍/单测/服务端校验依赖此点）。
- **render**：PixiJS，只读快照 + 表现事件，插值渲染，相机纯渲染职责。
- **app**：场景、键位采集、音频；非确定性层。
- **data**：烘焙产物（角色/地图 JSON + 图集元数据），双来源：`tools/exporter` XFL 静态提取（bvn/fighter@1、bvn/assistant@1）+ `tools/runtime-ingest` 运行时 dump 转译（bvn/fighter-runtime@1 判定区几何、bvn/map@1 地图边界/出生点/地板；由 `tools/bridge` 注入原版 AIR 应用导出）。运行时数据兼作 XFL 提取的交叉验证证据（见 baked/runtime-ingest-report.json）。
- **net**：帧同步（阶段 2），对 core 单向依赖。

目录与子系统接口的规范性定义见契约；这里只记理由：core 独立成包并用 lint 切断向上依赖，是因为"逻辑/渲染解耦"靠自觉守不住（原版就是反面教材，逻辑层与显示列表深度耦合）。

## 3. core 详细设计

### 3.1 帧模型：60Hz 逻辑 + 30Hz 动画/判定

原版按画质在 30/60fps 间切换，且动画与判定独立按 30Hz 采样（module-map §3）。移植版固定 60Hz 逻辑帧（原版 60fps 模式，`SPEED_PLUS=0.5` 的手感基准），30fps 原版视为历史降速档不移植。一切计时帧化——原版大量"0.1 秒窗口"类常量是按帧率换算的隐性帧依赖，直接用帧常量表达更诚实也更稳定。

原版物理常量移植规则（切片 3 起生效）：原版反编译值一律 × `SPEED_PLUS=0.5`（时间性量：重力斜坡步长、穿台速度阈值等），空间容差类（吸附带、平台容差 ±10px）与帧数类（动画帧/延迟帧数）不折算；hurtTime 特例 = ms→30Hz 帧换算再叠加原版偏移（§3.5 命中与受击）。重力采用原版 `_g` 斜坡模型（离地预置初值、空中递增、封顶，上升段清零），不是线性 `v += g` 积分——这决定"重力坠落总能落在平台上、只有显式下落速度（击飞）才穿台"的原版手感。

### 3.2 tick 管线（顺序即契约）

```
sim.tick(inputs: InputFrame):
  1. 输入处理     位图 → 缓冲器 → 各角色意图
  2. 意图决策     状态机读取意图，尝试触发动作
  3. 物理积分     速度/阻尼/重力 → 地形 → 牵引边界修正
  4. 推挤        角色间 body AABB 按 heavy 系数互推
  5. [动画帧]    推进动画、刷新判定区、击飞状态机、帧触发器
  6. [动画帧]    命中判定与结算（固定顺序 P1→P2→道具→辅助）
  7. 流程事件     死亡、回合计时、比分、能量回复
  8. 输出        快照 + 表现事件队列 + 状态哈希
```

原版用 `Dictionary` 注册 ENTER_FRAME 回调、迭代顺序未定义——定序不是洁癖，是在消除一个真实的非确定性来源。

### 3.3 输入系统：位图 + 可配置缓冲

原版有经典/非经典两种输入模式，本质是同一件事的两个特例。统一为：**持续型行为**（移动/防御）直接读按住位图；**触发型行为**（攻击/跳/技能）过缓冲器，按下边沿后 `INPUT_BUFFER_FRAMES`（默认 6 帧 = 0.1s）内有效。缓冲窗口设 0 即退化为原版经典手感——一个常量取代模式概念。帧同步只传位图，缓冲是两端本地推导，协议与缓冲参数无关。缓冲器同时是将来指令技（↓→+攻击）的挂载点。

### 3.4 版边：牵引边界替代相机耦合

原版"角色不能跑出镜头"使逻辑被迫读相机矩形。其实现捷径背后的设计意图是"两角色不能拉开超过一屏"，直接写成逻辑：

```
playfield = clamp(两角色中点 ± PLAYFIELD_HALF_WIDTH, 地图边界)
```

相机降为纯渲染。已知偏离：极端拉距时版边位置与原版可能有数像素差异——按重构定位接受；若对拍手感受损再复议（回退方案：相机进模拟）。

### 3.5 状态机与战斗规格

> **本节是当前机制规格**（按系统组织，非历史叙事）：写代码/调数值前以此为准。逐切片的实现过程与偏离记录在 git 提交说明；规格变更就地修改本节，**不追加日志**。改动行为语义前另读本节末「机制语义备忘」。

原版 `FighterMcCtrler`（~2200 行，逻辑与动画混合）是规格书不是抄写对象。移植版用显式状态表：`{ id, 动画, 结束条件, 可取消表, onEnter/onTick/onExit }`。状态码沿用原版枚举 `FighterActionState`（全集见 `core/fighter/def.ts`）。受击/防御/钢身结算路径（module-map §5.6）是手感核心，对齐优先级最高。

**通用约定**

- **动画驱动**：`actLabel` + `animFrame`（内层时间轴绝对帧号，1 起，30Hz）。循环标签集合 `LOOP_LABELS`（站立/走/跳中/落）回绕播放；`advanceAnimation` = 先采样当前帧（帧触发器/判定区以此帧为准），再推进。
- **判定区**：`def.areas[animFrame]` 查表（运行时 dump 几何，脚底锚点、direct=1 局部坐标）→ 世界 AABB（朝向镜像）；命中 = 攻击方 atm ∩ 受击方 bdmn。攻击判定名 = `<actionId>atm`。
- **静态数据**：`FighterDef` 经 `SimConfig` 注入 Sim 注册表，**不进 SimState**；快照恢复经 `Sim.fromState(state, defs)` 回注（`getDefEntries()` 回传）。
- **动画映射**（动作 id ↔ 标签）：`kjN→砍技N`、`tk→跳砍`、`tz→跳招`、`shN→摔N`、`zhN→招N`、`bs→必杀`、`sbs→上必杀`、`cbs→超必杀`；gotoAndPlay/gotoAndStop/loop 三 op 合并为 setLabelTo 单实现（30Hz 采样下语义无差异）。

**命中与受击**

- **逐区命中**：当前帧每个可解析 atm 区独立成命中——区名精确匹配 actions 优先，否则去 `atm` 后缀反查（原版 getHitVOByDisplayName）；多段动作各段独立结算，去重键 = `区动作id:目标id`；判定覆盖全部攻击态（isAttackingState）。
- **受击分流**（原版 doHurt）：`hitx × 攻击者朝向`、空中 hity 补偿（HURT_Y_ADD_INAIR）；`hurtType==0` → HURT_ING（hurtTime ms→30Hz 帧换算 +3 偏移、下限 4），否则 HURT_FLYING（水平不衰减、按击退方向翻转朝向）；钢身掉血不掉状态；一次攻击对一目标只结算一次（`attackHit`）；hp≤0 → DEAD + `fighter:ko`。
- **回气**：近战命中攻击方 qi += min(power×0.16, 15)、受击方 min(power×0.085, 20)（被防御命中同样结算）；道具命中发射者 power×0.1、独立道具命中所有者 power×0.15；辅助判定区命中 owner qi +power×15%；必杀判定（actionId 含 "bs"）近战/道具不回气；近战回气只结算角色本人动作命中。
- **防御**：按住 ↓（DEFENCE_ING），命中削血 5% + 能量损耗 min(50, power/5)（破防技 = 90% 上限）；能量不足 → 破防（HURT_ING 42 tick、额外削血 power/10、击退夹 [5,10]）；背刺照 checkDefDirect（受击方与攻击方同向 = 挡住）；防御分支允许出手清单照原版 setDefenseAction 槽子集（砍技1/招2/超必杀/瞬步）。
- **摔技/抓取**：地面动作分流允许 catch（attack/skill 缓冲 + 朝目标移动 + 身位间隙 <2px + |dy|<1）→ startSkill 进摔技标签；首帧 `moveTarget({followmc})` 吸附——目标以 `speed×SPEED_PLUS` 逼近锚点区中心×朝向（speed 缺省 0 = 直接吸附；原版锚点为 MC 注册点，取判定区中心等效）；攻击态结束由 sim 巡检释放（释放需恢复目标重力/回拉，状态机层做不了），释放恢复 applyG + HURT_FLYING 回拉 5px。
- **结算序**（规范化，替代原版 children 插入序，全部 id 升序）：fighter→fighter → 攻击 vs 道具 → 道具 vs 角色 → 道具对撞。

**资源**

- **能量**：上限 100；普回 1/tick、攻击中 0.55、防御 0.4、过载 0.3；花费后 24 tick 冷却（USE_ENERGY_CD）。
- **气**：必杀 100 / 上必杀 100 / 超必杀 300，不足不动。
- **fzqi**：上限 100、每帧无条件 +0.2；NORMAL/DEFENCE 态且满时 `assist` 位召唤。
- **hp**：`addHp`/`addHpPercent`/`addHpLosePercent` clamp hpMax（hp≤0 不回）；`loseHp` 自削血归零 → 死亡。

**移动、跳跃与物理**

- **行走**：vx = speed×0.5 直结（与原版 setVelocity→move×0.5 逐 tick 等价）；地面位移受标签门（见备忘），空中 airMove 不受限。
- **阻尼**：dampX/dampY 每 tick 双向线性逼近 0（原版 num_wake）；跳跃 vy = −jumpPower×0.5 + JUMP_DAMPING（30fps→60Hz ×SPEED_PLUS 折半），上升段重力清零。
- **重力斜坡**：原版 `_g` 模型（离地预置初值、空中递增、封顶），位移空间步长 +0.3/tick、上限 6——步长不再二次折算（批次 19 修正）。
- **跳跃家族**：jumpTimes = 2 起始（地面跳/空中跳各耗 1）；起跳延迟 JUMP_DELAY_FRAME 地面 2/空中 1（帧数不折算，置于物理积分后处理——首个上升位移出现在下一 tick；延迟结束才施加速并消耗 jumpTimes）；空中跳可取消空中攻击；`↓+跳` 快速下落 vy 2.5/tick 匀速（阻尼取 0——原版 damping 1 在 60Hz 首 tick 即跌破穿台阈值）、jumpTimes 清零、穿平台、触地续接 落地；快速下落前置于防御检查（原版净效果等价）。
- **瞬步**：能量 20 可透支（透支 → 过载 0.3/tick 慢回至 >30 解除）；DASH_ING 期间不可被命中，方向取按住的方向键。

**瞬身步家族**（dash+方向；统一成本气 60（不透支）+ 能量 80（可透支），24 tick 免伤 + isCross + 意图封锁）

- dash+↓ 地面步：位移 4/tick、标签 走，受连续冷却门 `ghostCooldown`（自然到期即时恢复、中断按剩余 tick 恢复——原版 `_isContinuousGhostStep`）；
- dash+↑ 空中瞬跳：vy −6 / dampY 0.05 / jumpTimes−1，结束恢复 damping(−vy/10) + airMove（顺序在回位之后，不被 endAction 清掉）；
- dash+↓（空中）速降：vy 7.5 触地即结束；
- 必杀/万解中不可发起；地面分支先于瞬步/跳判定；防御态经输入缓冲下一拍接瞬身步脱离。

**技、必杀与万解**

- **槽位分流**：attack/±↓/↑ 组合由槽位路由（skill1/skill2/zhao1-3/bisha 系/catch 系/dash）；SKILL_ING / BISHA_ING / BISHA_SUPER_ING 照原版枚举。
- **连段**：动作发起即清空全部动作槽（原版 doAction→clearAction），播放中再按攻击键不重启动作、时间轴不复位；连段 = 帧触发 `setAttack("砍2")` 重填槽后派生；槽重填默认于 endAction。空中槽 attackAIR/skillAIR/bishaAIR（airHitTimes 递减耗尽不再触发）；`setJump(label)` 覆写跳跃标签。
- **万解**：qi ≥ 300 时 攻击+跳 组合（W→S→普通 优先级，缓冲按下/按住混合——对原版按住电平判定的手感取向偏离）→ 扣 300 气 → WAN_KAI_ING 50 tick 演出（免伤）→ 效果事件 wanKai/endWanKai；`startWanKai` 参数为必杀 FACE 名（语料全体 doWanKai 无参）。
- **万解形态切换**：`doWanKai(frame)`/`switchForm(frame)` = 根时间轴切换（0 = 下一形态，>0 按 `def.rootFrame` 寻址）——切 `formIndex`（`SimConfig.fighters[].forms` 多形态注册表，data 层 `compileFighterForms` 编译）+ 槽重填 + 播新形态 开场 + `fighter:form` 事件驱动 render 换图集；单形态静默不切。
- **切人冻结锁**（切片 22，原版 `EffectCtrler.bisha`/`wanKai`）：`bisha`/`startWanKai`（事件 id `wanKai`）置 `SimState.cutinLock { kind: 'fighter'|'assister', id, type: 'bisha'|'wanKai' }`，`endBisha`/`endWanKai` 清除。原版语义 = `GameCtrler.pause()` 全场逻辑冻结 + 黑幕 + 特写立绘，施法者画面由 render 驱动继续播（帧脚本照常触发——`endBisha` 即在冻结期到来）；移植版等价 = 锁置位后下一 tick 起全场停走（输入/意图/物理/推挤/命中/计时/道具/其他实体动画），仅锁主时间轴 30Hz 推进。锁主失联保护（收招回 NORMAL/死亡/辅助退场 → 保护性解锁）：原版语料缺 end 系 = 永久黑屏软锁，web 端选解锁兜底（有意识偏离）。

**飞行道具与独立道具**

- **Bullet**：速度存发射朝向的局部系（world 位移 = sx×SPEED_PLUS×facing）；addSpeed = 净加速度/tick（原版 add×2 预乘）；maxSpeed/minSpeed 局部系 clamp（两朝向一致）；holdFrame = 秒×60；hitTimes = −1 无限；hp/hpMax 道具对撞互扣（hp −= 对方 hpMax）。命中矩形 = 发射帧命名判定区（原版为元件帧 1 视觉 bounds，逐帧矩形未导出——§4.2）。30Hz 生命周期标签分派（loop/remove/hit_over/timeout）；命中残留（killBullet）= 停移动播尽移除。
- **fire(mcName)**：发射帧上名为 mcName 的判定区 = 道具固定命中框；HitDef 去 atm 后缀查动作表；判定区/动作缺失 = 确定性静默。
- **独立道具 addAttacker**（B5 逐帧命中矩形，2026-11-12）：实体位置 = **元件原点**世界坐标（原版 `_mcOrgPoint`，fires[name].org = 实例在父时间轴的摆放位，direct=1；x/y/w/h 字段保留生成帧内容尺寸供物理夹取/渲染回退）。命中矩形**逐帧解析**（原版 `FighterAttacker.findHitArea`）：`fires[name].hits[帧]` 命名子对象（元件局部 direct=1）沿朝向镜像平移到原点（RectUtils 镜像），名按 owner 动作表精确 → 去首个 "atm" 解析 HitVO（`getHitVOByDisplayName` 镜像），无命中区帧 = 该帧无判定，未解析名 = 纯表现；数据源：viaAssist → 辅助 def fires，角色 → 当前形态 def fires。缺 org/hits 的元件（旧采集/歧义多库符号）回退生成帧占位矩形全程固定（切片 10 占位语义，世界矩形与中心语义等价）。轴 params `x`/`y`（followTarget 每 tick 跟随 / moveToTarget 出场到位 / offset；follow 轴 y = 目标原点 + offset）；`applyG`（底边 = 原点 + fbHit 底）；单次命中即失效（语料无多次命中实例）；寿命 = 播尽移除（`animTotal−1` off-by-one 原样保留；无时间轴回退 holdTicks 120）。viaAssist（辅助召唤）道具回气归召唤者、命中不回气。逐帧数据管线 = dump 桥（`tools/bridge`，帧脚本 fake 控制器吸收后逐帧 getBounds）+ `tools/b5-pack` 合并进 baked fires 包（同名跨形态多记录 → 取 addAttacker 所在形态）。
- **目标系 op**（语义细则见契约原语表）：setHitTarget/moveToTarget（版边镜像防穿帮）/justHitToPlay/setHurtAction（携带：触发在攻击方时间轴，本次动作命中 → 受击方播专用受击动画；标签属受击方 def，applyHit 消费时校验存在性）/hurtFly（主动击飞）/setDirectToTarget/setDirectReverse/setTargetVelocity。

**条件触发器**（原版 `if($xx_ctrler.query()){...}else{...}`）

- 导出器语句级解析（简单调用体）：条件可解析 → `FrameTrigger.cond/then/else`（`evaluateTriggerCondition` 求值后分派，分支体调用仍走原语表）；不可解析条件含调用 → 整段抑制 + rawScript 残留；纯卫语句丢弃。早期"拉平为无条件双分支全执行"是真实行为 bug，已修复。
- 查询 op（原版 FighterCtrler 对齐）：`justHit(hitId, includeDefense?)`（lastHurtHitId / lastDefHitId）、`targetInRange(rx, ry?)`（朝向相对 x 窗 + y 差窗）、`getTargetState`、`getSelf`、`getTargetSP`（属性链 + cmp）；属性走 `fighterProp` 白名单（`isInAir = !onGround`、hp/qi/energy/x/y/actionState 等，speed/jumpPower/heavy 读 def）。未知查询 op = false、未知属性读 null（AS 真值 = false）——确定性静默。

**辅助系统**（AssisterCtrler 转译）

- **召唤流程**：NORMAL/DEFENCE 态且 fzqi 满时 `assist` 位召唤（单主单辅助）；出生点 `owner.x − 30×direct`；时间轴从 animFrame=2 起播（原版 gotoAndPlay(2)）；`summon` op 不注册（全语料零实例，召唤由输入意图驱动）。
- **实体**：free-running 时间轴（无状态机/动作槽）；物理 = 速度终值单位 + wake 阻尼 + 重力 ramp（2 起、步进 0.3、上限 6），仅 groundY 落地；`setTouchFloor` 落地消费一次续接标签；退场 = 时间轴末或主亡（主亡判定在 customFunc 之后，见备忘）。
- **op 词表** `defaultAssisterBehaviors`：target 三分 `self`/`fighter`(owner)/`fighterTarget`(对方)；未注册静默（残余仅 justHit（纯读）/setTouchSide（语料无实例））。**loop 触发器**：注册帧起每动画帧求值 cond（checkHitOwner 辅助判定区∩owner bdmn / actionStateIn）至 untilFrame（排他）；导出器守卫语义 `if(!X)return` → cond=X、`if(X)return` → cond=¬X。
- **buff**：speedUp 平加 walkSpeed（×SPEED_PLUS）/ attackUp 伤害乘区 attackRate=1+value（回气仍按 raw power）/ defenseUp `dr=clamp(2−value, 0.1, 1)`；hold×60 tick，重复施加刷新。辅助包 `buffEffects`：orihime attrResistance 0.2（属性受击先减）、yachiru phyLifesteal 0.35（物理命中吸血）。
- **customFunc / attacker 元件脚本**：语义见契约原语表与下方备忘。
- 快照恢复 `Sim.fromState` 须回传 `getAssisterDefs()`（assists 注册表不进 defEntries）。

**机制语义备忘（切片 13 起固化；改动这些语义前先读，出处 commit 见 PROGRESS §三）**：

- **时间轴顺流**（批次 20）：非循环攻击标签播尽且 ①仍处攻击态 ②段尾无重定向触发（idle/setLabelTo）③下一标签帧号连续且非循环 → 滑入续播（原版标签边界不停车）；必杀 1 帧桩（必杀→空中必杀、招1_SP→招1 等）靠此播放。
- **endAct** 只清槽置 FREEZE，**不动播放头**（批次 17）；收尾由标签播尽或后续 idle 触发。
- **damping = 持久阻尼**：安装后每 tick 线性衰减，非一次性乘法；move 系附带清阻尼（批次 17）。
- **行走物理标签门**：地面位移需 `actLabel∈{站立,走} && labelLock<=0`；idle 触发清 labelLock（批次 20）。
- **防御定格**：抬手段播 3 帧后停住；`防御` 不在 LOOP_LABELS（批次 17）。
- **资源恢复**：落地与回待机都要补槽（defaultSlots）并恢复 jumpTimes，否则永久锁死（批次 18）；空中动作成功置 jumpTimes=0（对齐原版）。
- **重力斜坡**：位移空间步长 +0.3/tick（GRAVITY_STEP）、上限 6——步长不再二次减半（批次 19 修正）。
- **辅助 gotoAndPlay 无同标签守卫**：loop 靠同标签 rewind 保活（切片 21）；**步内跳转落点不再 +1 推进**，落点帧触发器下一步照常执行（13-A6 修复）。
- **customFunc 单槽**（占位即忽略）；辅助 owner 死亡退场判定在 customFunc 之后（checkFunc 先清 attacker 再退场，切片 21）。
- **播尽移除 at totalFrames−1**（bullet/attacker/辅助一致，原版 off-by-one 原样保留）；attacker stop = animHold 完全冻结（不推进/不分派/不回收，孤儿永驻，原版同语义）；元件第 1 帧触发器不执行。

### 3.6 角色数据与帧触发器

原版角色的玩法差异藏在 XFL 时间轴脚本里（`defineAction`/`fire`/`addAttacker`/形态切换，module-map §6.2）。移植版表达为 JSON 数据 + 帧触发原语（原语表见契约，扩充原语需契约/core/校验器三处同改）。38 角色脚本全部保留转译；数据化不了的复杂机制收进 `core/fighter/behaviors/` 插件目录，不污染通用引擎。

### 3.7 确定性

核心战斗路径本就不用随机，数值只有四则运算，IEEE754 双精度跨端一致（module-map §9）——确定性可行且不需要定点数。剩余隐患（迭代顺序、相机耦合、帧率常量、sortOn 稳定性）全部用契约硬规则第 1/3/5 条消除。具体禁令清单见契约 §硬规则 1。

### 3.8 快照与哈希

每个 tick 输出 `SimSnapshot`（fighters/bullets/attackers/assisters/match/rngState + 确定性序列化哈希）。快照是渲染唯一输入、对拍唯一基准、联机失步检测载体。`SimState` 可整体序列化/恢复，为 rollback（阶段 4）预留。

**双哈希**（2026-11-12，治理"表示漂移反复触发重冻调查"的成本）：

- `hash`（全状态哈希）：整个 SimState 规范序列化（键排序、IEEE754 规范字符串）的 FNV-1a。联机失步检测、对拍、快照恢复、batch:validate 双跑基准用它——任何表示变化都漂移，这正是失步检测想要的。
- `behaviorHash`（行为哈希）：`behaviorView` 剥除表现/输入派生字段（denylist：`fighters[].input`、bullets/attackers 的 `name`）+ 空容器省略序列化（null/`{}`/`[]` 不进哈希，值非空即参与）。**tools/replay 门禁只冻这个**——新增"恒空"记录字段、坐标重锚定等表示层改动不再漂移基线；行为变了必然漂移（denylist 设计，漏登记只会多漂不漏报）。
- 登记纪律：新 SimState 字段默认进两个哈希；纯表现/输入派生字段入 `behaviorView` 剥除表须同 commit 更新 `serialize.ts` 注释与本节。
- 漂移仍发生时的归因：`tools/replay/verify-drift.mjs <script>` 自动对比 当前工作区 vs HEAD 的全量状态逐 tick dump（stash→build→dump→pop），全等 = 纯表示变更（可重冻），不等 = 输出字段级行为差异（禁止重冻）。

## 4. 数据与素材管线

- **导出**：FFDec 反编译主 SWF + 注入导出脚本（参考 bvn-ai-public 的状态桥），运行时遍历 dump 帧标签、`getBounds` 判定几何、`defineAction` 表、帧触发点、地图边界/地板/出生点。输出带源 SWF 哈希版本戳。
- **图集**（切片 4 定案）：原版角色/辅助图形是矢量符号（XFL 库几乎无位图），必须运行时栅格化——`tools/atlas-capture`（AIR capture 桥，范式同 dump 桥）。**关键语义**：姿势美术画在内层子剪辑自身的时间轴里，引擎每 tick 手动驱动（`FighterMC.renderAnimate`：主时间轴 `nextFrame()` + `renderChildren()` 把每个姿势子剪辑推进 1 格）——单纯 `gotoAndStop(f)` 子剪辑停在初始帧截不到姿势。capture 逐标签镜像引擎时序（`gotoAndStop(标签起始)` → 推进子剪辑 → 截图 → `nextFrame`+推进 → 截图），输出帧号 = 绝对内层帧（与 core `animFrame` 一致）→ `BitmapData.draw(root)` → 手写 PNG 编码（SWF ver17 无 `BitmapData.encode`）→ **像素哈希去重**（166k 帧引用 → 46k 唯一帧）；`tools/atlas-pack`（Node + pngjs）shelf 装包 2048² sheet，排序固定可复现。锚点契约：每帧记内容相对**角色 root 原点**的 bounds 偏移——原版 `BaseGameSprite` 直接 `_mainMc.x=_x; scaleX=direct`，即角色坐标 = root 局部原点、翻转绕原点，render 端 `translate(x,y) → scaleX(direct) → draw(bounds 偏移)` 复现。地图背景走同一 capture 桥（逐子图层 PNG + 偏移）。产物 `packages/data/assets/`（gitignore，管线可再生）。
- **配置**：原版 fighter/select/map/mission XML → JSON。
- **切人插图管线**（`tools/bisha-pack`，切片 22）：effect.swf `-export sprite` → `bisha_face_mc`（DefineSprite_633）71 帧 WebP + 各角色 SWF `-export image` 按类名挑必杀立绘位图（映射源 = baked fighters `forms[].sounds.bishaFaces`）→ `assets/bisha/`；槽位矩阵/画布原点等规格烘焙进 `baked/bisha.json`（schema `bvn/bisha@1`）。画布原点推导：PNG 画布 = 内容 union bounds，mc 空间原点 (−134,−12) 由 mc_017 照片带（自身 bounds 原点 (0,0)：5 张 picture 全部 a=2/d=2 原点摆放）在帧画布上的实测位 (133,12) 反推；打包时断言画布 1066×209，规格漂移即报错。

## 5. 渲染层

PixiJS v8；逻辑坐标 1000×600（y 向下）与原版一致，渲染层负责屏幕适配。渲染帧率与逻辑解耦：位置在最近两个快照间线性插值，动画帧/朝向取最新。相机平滑跟随 + 缩放自由实现。HUD 读快照绘制；音效/特效消费表现事件队列（事件带 tick 号，自行去重）。

**切人插图**（切片 22）：黑幕 = 屏幕空间层（bgFixed 与 world 之间），`SimState.cutinLock ≠ null` 期间盖满视口；横幅+立绘 = world 内 mapLayer 与 fighterLayer 之间的容器（角色仍在黑幕之上，原版层序）。横幅 = `bisha_face_mc` 71 帧流帧（30fps，0-based 帧 1 起播，destory/stop 帧自然消失），立绘按逐帧槽位矩阵合成（`bisha.json` slots：W_T/缩放绕 transformationPoint 线性补间烘焙）；faceId = 施法者在目标右侧 ? 右槽(镜像) : 左槽（原版 showFace）。白闪（原版 color offset 255→50→0）以白色加色叠层近似（偏离记录）。地图/map front 层锁定期隐藏；isSuper 相机聚焦与 bisha_super 光效未做（归特效块）。

## 6. 联机层（阶段 2，接口现已冻结）

Node + WebSocket 房间服务器，只做输入中继与房间管理，不跑模拟。每帧上行自己的 `ButtonMask`，下行全员 `(tick, ButtonMask)`；lockstep 调度 + 2~3 帧本地输入延迟掩盖抖动；定期交换快照哈希检测失步。回放 = 输入序列 + 种子 + 数据版本戳，帧同步天然免费。

架构上为 rollback 预留的三个接口（core 已按此设计）：tick 纯函数式推进、`SimState` 可序列化、输入只经 `InputFrame` 进入。

## 7. 验证体系（harness 先行）

借鉴 Claude of Duty"工具链比游戏更值钱"的经验，**门禁工具与 core 骨架同期交付**，不事后补：

| 工具 | 作用 | 对应物 |
|---|---|---|
| 确定性单测 | 同一输入序列跑两遍，逐帧哈希相等 | —— |
| `tools/replay` | 输入剧本回放 + 行为哈希门禁（提交前必跑；§3.8 双哈希） | 它的 imagediff.mjs，但我们比对的是逻辑状态，更强更便宜 |
| `tools/replay/verify-drift` | 哈希漂移归因：工作区 vs HEAD 全量状态逐 tick diff | ——（重冻调查的手工流程工具化） |
| 对拍 | 原版桥接快照 vs 本地模拟逐帧比对 | 阶段 1 手感对齐用 |
| 数据校验器 | JSON schema + 引用完整性 | 角色并行转译的验收闸门 |

对拍容差初始：位移 ±0.5px、数值与状态码相等。允许按模块豁免，但必须逐条记录原因——接受有意识的偏离，不接受无意识的漂移。

## 8. 技术选型

TypeScript（strict）+ Vite + pnpm workspace；PixiJS v8；Node + `ws`（与客户端共享 core 包与类型）；Vitest（core 在 Node 环境测）；GPL-3.0（OpenBVN 转译传染性要求）。不用定点数。

## 9. 切片划分与重排理由（阶段 1~2）

> 各切片完成状态以 [PROGRESS.md](PROGRESS.md)（进度台账）为准，本节保留切片划分与重排理由。
>
> 2026-11-09 重排：本地双人/训练模式移出主线，进扩展项池（见立项书 §六）；阶段 1 以
> "单机对战闭环验收"收尾，随后直接进入阶段 2 联机。理由：lockstep 联机天然给出双方
> 输入，本地双人是最后才被需要的能力；联机是项目核心目标，尽早打通端到端。

1. **harness** ✅（切片 1）：`packages/core` 骨架 + 确定性单测 + `tools/replay` 门禁；
2. `tools/exporter` ✅（切片 2）：导出 ichigo + kon + 1 张地图的 JSON/图集；
3. core ✅（切片 3 最小闭环 + 切片 5 补全）：7 态动作机 + 判定区 + 命中结算 + 推挤；切片 5 补防御/瞬步/技/必杀最小集 + 能量系统 + 连段槽（见 §3.5），达到"能打一场完整对局"；
4. render ✅（切片 4 + 切片 5 清遗留）：帧动画、地图层、相机、基础 HUD；切片 5 补相机 clamp 接舞台边界、floor 前景层遮挡、HUD 回合文本；
5. app ✅（切片 4 + 切片 5 训练模式）：dev 预览页（键盘 → ButtonMask → tick → 渲染）；训练模式 = P2 假人（输入恒空）+ 无限血 + R 键重置；
6. **切片 5 = 阶段 1 收尾** ✅：确定性单测 40 过、replay 门禁四剧本（含新增 ichigo-mechanics）过。遗留池（不阻塞阶段 2）：摔技/万解/空中瞬步/二段跳/必杀飞行道具（fire 原语）；
7. **切片 6 = 联机地基** ✅：`InputSource` 抽象（本地键盘 / replay / 网络统一喂 sim，sim 本身零改动）+ lockstep 客户端（输入延迟帧、帧号对齐、输入缓冲）+ 同机双客户端经本地服务器镜像联调。落地：`core/inputSource` 接口 + `ScriptedInputSource`（剧本回放源，tools/replay 剧本同构）；`packages/net`——协议词表（welcome/hello/start/input/hash/peer-lost）、`Transport` 抽象（`loopbackPair` 内存直连 + `wsTransport` 浏览器/node ws 双兼容）、`LockstepClient`（本地输入延迟 INPUT_DELAY=3 帧、按 tick 输入缓冲、每 HASH_STRIDE=60 tick 交换状态哈希检测失步、hello 配置指纹互验）；`server/relay.mjs` 最小中继（分配位次、收齐 hello 广播 start、input/hash 纯透传）。联调门禁：双客户端 loopback 对跑剧本 finalHash 相等且等于单机直跑（抽象零漂移）+ 停步语义 + 失步检测 + 真实 relay 进程 ws 端到端；app dev 页 `?mode=net&role=p1|p2` 双窗口联机入口。
8. **切片 7 = 房间服务器** ✅：Node.js WebSocket 房间（创建/加入、输入中继、断线最小处理：超时判负或冻结等待），局域网两机联调。落地：`server/room-server.mjs`——4 位房间码（无易混字符）、create/join 入房（错误码 room-not-found/room-full）、收齐 hello 广播 start、input/hash 按房间透传、断线通知 peer-lost 后冻结等待（判负归阶段 4）、无重连；`packages/net` 协议词表扩展 create/join/welcome/error + `startSession` 会话助手（入房 + LockstepClient 装配一步到位，onWelcome 提前给 create 方房间码）；app `?mode=net&action=create|join&room=&port=` + 停步 5s 看门狗提示。注意 startSession 语义：要等 start 广播才 resolve——create/join 必须并发。门禁：net 7 测试（房间 e2e 对跑剧本哈希 = 单机直跑、room-not-found、room-full + 切片 6 全部回归）。
9. 公网联调与延迟体验调优视切片 7 结果立项（输入延迟帧自适应、可选升级 rollback——归阶段 4）。

阶段 1 明确不做：本地双人、rollback、第二个可操作角色、完整菜单流、街机模式、音效（事件队列留好）。本地双人进扩展项池，最后做。

