# BVN Web —— 设计文档

> 本文档回答"为什么这么做"；**"必须怎么做"以 [ARCHITECTURE.md](ARCHITECTURE.md)（引擎契约）为准**。
> 读者：项目决策者、需要理解设计背景的协作者。干活的 AI 只需读契约。
> 前置阅读：[BVN-online-port-plan.md](BVN-online-port-plan.md)（立项）、[BVN-module-map.md](BVN-module-map.md)（原版逆向）。
> 决策变更登记在 §10 ADR 表。

---

## 1. 设计原则

1. **确定性模拟核心（core）是唯一真理来源。** 同一输入序列 → 逐帧相同状态，可哈希校验。渲染、联机、回放、AI 都建立在"喂输入、读快照"一个接口上。
2. **数据驱动。** 61 个角色的差异压进 JSON，core 只有一套通用引擎。新增角色 = 新增数据。
3. **联机不侵入逻辑。** 帧同步只是"输入从网络来而不是键盘来"；单机、联机、回放、对拍共用同一份模拟代码。
4. **重构优于复刻。** 原版源码是参考规格书；行为对齐手感，结构自由重写（见 ADR-1）。
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

原版物理常量移植规则（切片 3 起生效）：原版反编译值一律 × `SPEED_PLUS=0.5`（时间性量：重力斜坡步长、穿台速度阈值等），空间容差类（吸附带、平台容差 ±10px）不乘系数。重力采用原版 `_g` 斜坡模型（离地预置初值、空中递增、封顶，上升段清零），不是线性 `v += g` 积分——这决定"重力坠落总能落在平台上、只有显式下落速度（击飞）才穿台"的原版手感。

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

### 3.3 输入系统：位图 + 可配置缓冲（ADR-3）

原版有经典/非经典两种输入模式，本质是同一件事的两个特例。统一为：**持续型行为**（移动/防御）直接读按住位图；**触发型行为**（攻击/跳/技能）过缓冲器，按下边沿后 `INPUT_BUFFER_FRAMES`（默认 6 帧 = 0.1s）内有效。缓冲窗口设 0 即退化为原版经典手感——一个常量取代模式概念。帧同步只传位图，缓冲是两端本地推导，协议与缓冲参数无关。缓冲器同时是将来指令技（↓→+攻击）的挂载点。

### 3.4 版边：牵引边界替代相机耦合（ADR-4）

原版"角色不能跑出镜头"使逻辑被迫读相机矩形。其实现捷径背后的设计意图是"两角色不能拉开超过一屏"，直接写成逻辑：

```
playfield = clamp(两角色中点 ± PLAYFIELD_HALF_WIDTH, 地图边界)
```

相机降为纯渲染。已知偏离：极端拉距时版边位置与原版可能有数像素差异——按重构定位接受；若对拍手感受损再复议（回退方案：相机进模拟）。

### 3.5 状态机

原版 `FighterMcCtrler`（~2200 行，逻辑与动画混合）是规格书不是抄写对象。移植版用显式状态表：`{ id, 动画, 结束条件, 可取消表, onEnter/onTick/onExit }`。状态码沿用原版枚举（`FighterActionState`）便于对照。受击/防御/钢身结算路径（module-map §5.6）是手感核心，对齐优先级最高。

切片 3 已落地最小闭环（`core/fighter/{def,machine,behaviors}.ts`）：

- **状态子集**：NORMAL / ATTACK_ING / JUMP_ING / HURT_ING / HURT_FLYING / HURT_DOWN / DEAD。攻击/受击锁定朝向与行动；受击计时结束后回 NORMAL。
- **动画驱动**：`actLabel` + `animFrame`（内层时间轴绝对帧号，1 起，30Hz）。循环标签集合（站立/走/跳中/落）回绕播放，其余标签播完走 `endAction`（空中回 JUMP_ING，地面回 NORMAL）。`advanceAnimation` 语义为"先采样当前帧（帧触发器/判定区以此帧为准），再推进"。
- **判定区接线**：`def.areas[animFrame]` 查表（baked 运行时 dump 几何，脚底锚点、direct=1 局部坐标）→ 世界 AABB（朝向镜像）。攻击判定名 = `<actionId>atm`；命中 = 攻击方 atm ∩ 受击方 bdmn（AABB 相交）。
- **命中结算**（原版 doHurt 子集）：`hitx × 攻击者朝向`、空中 hity 补偿（HURT_Y_ADD_INAIR）、`hurtType==0` → HURT_ING（hurtTime ms→30Hz 帧换算 +3 偏移、下限 4）、否则 HURT_FLYING（水平不衰减，按击退方向翻转朝向）；钢身掉血不掉状态；一次攻击对一目标只结算一次（`attackHit`）；hp≤0 → DEAD + `fighter:ko`。
- **速度衰减**：`dampX/dampY` 每 tick 双向线性逼近 0（原版 `KyoUtils.num_wake`）；跳跃 `vy=-jumpPower×0.5` + JUMP_DAMPING，上升段重力清零（原版 `applayG` 语义已核对）。
- **POC 明确偏离**（后续切片收紧）：砍击无连段（attack 固定 k1/跳砍 kj1，映射表 kN→砍N）；无防御/瞬步/必杀/万解状态；无二段跳/快速下落；击飞无弹地/受身；`FighterActionState` 其余状态码待接。

切片 5 补全防御/瞬步/技/必杀最小集（照原版 `FighterKeyCtrler`/`doDefenseHit`/`doBreakDefense` 语义）：

- **防御**：按住 ↓（`DEFENCE_ING`），命中削血 5% + 能量损耗 min(50, power/5)（破防技 = 90% 上限）；能量不足 → 破防（HURT_ING 42 tick、额外削血 power/10、击退夹 [5,10]）。背刺判定照原版 checkDefDirect（受击方与攻击方同向 = 挡住，背对 = 硬直）。防御分支允许出手清单照原版 setDefenseAction 槽子集（砍技1/招2/超必杀/瞬步）。
- **瞬步**：能量 20 可透支（透支 → 过载 0.3/tick 慢回至 >30 解除）；DASH_ING 期间不可被命中，方向取按住的 ←/→。
- **技/必杀**：attack/±↓/↑ 组合由槽位分流（skill1/zhao1 等槽）；必杀耗气 100（上/超 100/300），气不足不动。SKILL_ING / BISHA_ING / BISHA_SUPER_ING 照 `FighterActionState` 枚举。
- **能量系统**：上限 100，普回 1/tick、攻击中 0.55、防御 0.4、过载 0.3；花费后 24 tick 冷却（原版 USE_ENERGY_CD）。
- **连段槽**：帧触发 `setAttack("砍2")` 改写动作槽（对照 ichigo 砍1@134→砍2），同一时间轴内再按攻击接续；`_CHK` 相邻标签自动续播（招2→招2_CHK 等）。attack 槽重填默认于 endAction。
- **动画映射修正**（切片 3 映射错误此片纠正）：`kjN→砍技N`、`tk→跳砍`、`tz→跳招`、`shN→摔N`、`zhN→招N`、`bs→必杀`、`sbs→上必杀`、`cbs→超必杀`（见 module-map §动作标签）。
- **本片新偏离**（记录待收紧）：防御硬直无专用动画窗（原版 isDefenseHiting）；防御退出即时（原版 ~6 tick 延迟）；摔技未接（shN 需 moveTarget/抓取）；万解/瞬身步/空中瞬步/二段跳未做。

切片 8 补飞行道具 `fire` 原语 + 行为 op 词表 Tier-1（module-map §5.7，原版 `Bullet.as`/`FighterMcCtrler.fire`）：

- **Bullet 语义**：速度存发射朝向的局部系（world 位移 = sx×SPEED_PLUS×facing）；addSpeed 净加速度/tick（原版 add×2 预乘）；maxSpeed/minSpeed 局部系 clamp（两朝向一致）；holdFrame = 秒×60；hitTimes=-1 无限；hp/hpMax 道具对撞互扣（hp -= 对方 hpMax）；必杀判定（actionId 含 "bs"）命中不回气。
- **fire(mcName)**：发射帧上名为 mcName 的判定区 = 道具固定命中框；HitDef 去 atm 后缀查动作表；判定区/动作缺失 = 确定性静默。
- **本片新偏离**（记录待收紧）：道具命中/超时即消散并发 `entity:despawn`（原版命中后残留命中演出子 MC——bullet 精灵图集未导出，render 暂以占位色块 + 事件表现，图集管线接入后收紧）；角色攻击摧毁道具不回气（原版 Bullet.beHit 亦无回气，取义一致但结算序规范化为 fighter→fighter → 攻击 vs 道具 → 道具 vs 角色 → 道具对撞，全部 id 升序，替代原版 children 插入序）；`dash` 语义纠正为原版 setVelocity（speed×v×SPEED_PLUS，v 缺省 3，穿越/免受击），切片 5 旧取义废弃。
- **待补（切片 9 资源系统）**：近战命中不回气——原版命中回气 power×0.1（受击方亦回气），当前仅道具命中回气；replay 剧本因此无法自然攒气验证必杀弹道（合成 def 单测覆盖 fire 全路径）。→ **切片 9 已补**，见下。

切片 9 补目标系/摔技/独立道具/万解/AIR 槽/近战回气资源（module-map §5.3/§5.7，原版 `FighterMcCtrler` moveTarget 系/`FighterAttacker.as`/`EffectCtrler` wanKai/`FighterAction` AIR 槽/`FighterMain.doQiAdd`）：

- **回气资源**：近战命中攻击方 qi += min(power×0.16, 15)、受击方 qi += min(power×0.085, 20)（被防御的命中同样结算——偏离：原版结算点在命中监听层）；道具命中发射者 power×0.1、独立道具命中所有者 power×0.15；必杀判定（actionId 含 "bs"）近战/道具不回气。近战回气只结算角色本人动作命中（`viaEntity` 区分独立道具——attacker 参数仅用于投技 hurtAction 携带）。
- **摔技/抓取**：地面动作分流允许 catch（allowCatch：attack/skill 缓冲 + 朝目标移动 + 身位间隙 <2px + |dy|<1）→ startSkill 进摔技标签；首帧 `moveTarget({followmc})` 吸附——目标以 `speed×SPEED_PLUS` 逼近锚点区中心×朝向（speed 缺省 0 = 直接吸附）；攻击态结束由 sim 巡检释放（machine.endAction 不再清 moveTarget——释放需恢复目标重力/击飞回拉，状态机层做不了），释放时目标 applyG 恢复 + HURT_FLYING 回拉 5px。
- **目标系 op**：`setHitTarget(checker, label)`（每动画帧检查 checker 区 ∩ 目标身体 → 切续接标签）、`moveToTarget(x, y, setDirect?)`（瞬移到目标旁，目标贴版边时镜像防穿帮）、`justHitToPlay`（最近命中 id 即续接）、`setHurtAction(label)`（携带语义：触发在攻击方时间轴，本次动作命中 → 受击方播专用受击动画而非通用受击态；标签属受击方 def，applyHit 消费时校验存在性；只存标签不改自身状态）、`hurtFly`（主动击飞 HURT_FLYING + 击飞标签）、`setDirectToTarget`/`setDirectReverse`/`setTargetVelocity`。
- **独立道具 addAttacker(mcName, params?)**：生成帧上同名判定区 = 命中框；轴 params `x`/`y`（`{followTarget|moveToTarget, offset, range?}`——followTarget 每 tick 跟随目标，moveToTarget 出场移动到位，非 follow 轴固定）、`applyG`；命中 HitDef 依元件名反查 owner actions（`'zh3mc'→'zh3'`、`'k1atm'→'k1'`，查不到 = 纯视觉道具）；单次命中即失效（hitAble=false）；寿命 120 tick 占位；followTarget 轴的 y = 目标中心 + offset（非锚点）。
- **万解**：qi ≥ 300 时 攻击+跳 组合（缓冲按下/按住混合；W→S→普通 优先级）→ 扣 300 气 → WAN_KAI_ING 50 tick 演出（isAllowBeHit=false）→ 效果事件 `wanKai`/`endWanKai`（render 消费演出）；`doWanKai(frame)` 帧跳转驱动已就位。
- **AIR 槽**：空中 attack/skill/superSkill 按槽（attackAIR/skillAIR/bishaAIR，bishaAIR 同耗气规则）分流到跳砍/跳招/空中必杀；airHitTimes 递减，耗尽不再触发；jump 槽默认"起跳"，`setJump(label)` 可覆写。
- **资源 op**：`addHp`/`addHpPercent`/`addHpLosePercent`（clamp hpMax，hp≤0 不回）、`loseHp`（自削血，归零 → 死亡 + ko）。
- **命中结算修正**：近战命中判定从仅 `ATTACK_ING` 放宽到全部攻击态（isAttackingState）——此前近战必杀/摔技命中永不结算（切片 5 起的既有 bug，本片接入 BISHA_ING 近战时暴露）。
- **本片新偏离**（记录待收紧）：gotoAndPlay/gotoAndStop/loop 三 op 合并为 setLabelTo 单实现（跳转语义在 30Hz 采样模型下无差异，语料出现分立名仅是原 API 对齐）；万解输入取缓冲按下/按住混合而非原版按住电平判定（手感取向，见 ADR-1）；万解形态切换（`doWanKai` 后续接万解形态 def，多形态注册）归切片 10；独立道具寿命/矩形为占位（原版生命周期由道具内层时间轴驱动，未导出）；moveTarget 锚点 = 判定区中心×朝向（原版为 MC 注册点）；独立道具单次命中（语料无多次命中实例）；`setCatch1/setCatch2` 槽已登记（摔2 分流待接）。

切片 10 补逐区命中/跳跃家族/瞬身步家族/万解形态切换（module-map §5.2/§5.3，原版 `FighterMC.getCurrentHitSprite` + `HitModel.getHitVOByDisplayName`、`FighterMcCtrler` doJump/doAirJump/doJumpDown/doGhostStep 系、`FighterCtrler.doWanKai`）：

- **逐区命中结算**：命中判定从「动作单 atm 区」改为「当前帧每个可解析 atm 区独立成命中」——区名精确匹配 actions 优先，否则去 `atm` 后缀反查（原版 getHitVOByDisplayName）。多段动作（摔1 时间轴内 sh1atm 抓取段 + sh12atm 摔地段）由此各段独立结算；去重键从动作 id 升级为 `区动作id:目标id`（`attackHit: string[]`，同动作不同段可分别命中）。
- **跳跃家族**：`jumpTimes = 2` 起始（地面跳/空中跳各耗 1）；起跳延迟（原版 JUMP_DELAY_FRAME 2 地面 / 1 空中，帧数不折算）——延迟结束才施加跳跃速度并消耗 jumpTimes（applyJumpLaunch）；空中跳（二段跳，可取消空中攻击）走 jump 缓冲；`↓+跳` 快速下落（doJumpDown：vy 2.5/tick、jumpTimes 清零、穿平台、触地续接 落地）。
- **瞬身步家族**：dash+↓ 地面步 / dash+↑ 空中瞬跳 / dash+↓(空中) 速降——统一成本气 60（不透支）+ 能量 80（可透支），24 tick（0.4s）免伤 + isCross + 意图封锁；地面步位移 4/tick、标签 走，受连续冷却门（`ghostCooldown`，自然到期 0 = 即时恢复，中断按剩余 tick 恢复——原版 `_isContinuousGhostStep` 语义）；空中瞬跳 vy -6/dampY 0.05/jumpTimes-1，结束恢复 damping(-vy/10) + airMove（顺序在回位之后，不被 endAction 清掉）；速降 vy 7.5 触地即结束。必杀/万解中不可发起（allowGhostStep）；地面分支瞬身步先于瞬步/跳，防御态经缓冲下一拍接瞬身步脱离。
- **万解形态切换**：`doWanKai`/`switchForm(frame)` 真实语义 = 根时间轴切换（frame=0 下一形态，>0 按 `def.rootFrame` 寻址）——切 `FighterState.formIndex`（`SimConfig.fighters[].forms` 多形态注册表，data 层 `compileFighterForms` 编译全部含动画形态），槽按新形态重填，播新形态 开场 演出后回 NORMAL；`fighter:form` 事件驱动 render 换图集形态。单形态（语料缺）静默不切。`startWanKai` 参数确证为必杀 FACE 名而非形态 id（语料 corpus 全体 doWanKai 无参）。
- **词表 Tier-2 收尾**：`switchForm` 注册为通用形态切换原语（语义同 doWanKai）；`teleport`（移形换位=换人）/`summon`（辅助召唤）原版引擎与语料均无实例，归辅助系统切片实现（已核对全语料）。
- **本片新偏离**（记录待收紧）：快速下落阻尼取 0（匀速 2.5/tick）——原版 damping 1 在 60Hz 语境首 tick 即跌破穿平台阈值 FALL_LAND_SPEED，穿平台语义不保；快速下落前置于防御检查（原版 doJumpDown 代码序在 defense 后但 `_action.clear()` 覆盖防御态，净效果等价）；防御态发起后接瞬身步延迟一拍（经输入缓冲，原版同 tick 不提前 return）；起跳延迟置于物理积分后处理（首个上升位移出现在下一 tick）；空中攻击下修 dampY 语义不变沿用切片 9。replay 四基准全部重冻（跳跃延迟 + 逐区结算均改变哈希，见提交说明）。

`FighterDef` 是静态配置：经 `SimConfig` 注入 Sim 注册表，**不进 SimState**（ADR-11）；快照恢复经 `Sim.fromState(state, defs)` 回注（`getDefEntries()` 回传）。

### 3.6 角色数据与帧触发器

原版角色的玩法差异藏在 XFL 时间轴脚本里（`defineAction`/`fire`/`addAttacker`/形态切换，module-map §6.2）。移植版表达为 JSON 数据 + 帧触发原语（原语表见契约，扩充原语需契约/core/校验器三处同改）。38 角色脚本全部保留转译（ADR-6）；数据化不了的复杂机制收进 `core/fighter/behaviors/` 插件目录，不污染通用引擎。

### 3.7 确定性

核心战斗路径本就不用随机，数值只有四则运算，IEEE754 双精度跨端一致（module-map §9）——确定性可行且不需要定点数（ADR-8）。剩余隐患（迭代顺序、相机耦合、帧率常量、sortOn 稳定性）全部用契约硬规则第 1/3/5 条消除。具体禁令清单见契约 §硬规则 1。

### 3.8 快照与哈希

每个 tick 输出 `SimSnapshot`（ fighters/bullets/attackers/assisters/match/rngState + 确定性序列化哈希）。快照是渲染唯一输入、对拍唯一基准、联机失步检测载体。`SimState` 可整体序列化/恢复，为 rollback（阶段 4）预留。

## 4. 数据与素材管线

- **导出**：FFDec 反编译主 SWF + 注入导出脚本（ADR-5，参考 bvn-ai-public 的状态桥），运行时遍历 dump 帧标签、`getBounds` 判定几何、`defineAction` 表、帧触发点、地图边界/地板/出生点。输出带源 SWF 哈希版本戳。
- **图集**（ADR-13，切片 4 定案）：原版角色/辅助图形是矢量符号（XFL 库几乎无位图），必须运行时栅格化——`tools/atlas-capture`（AIR capture 桥，范式同 dump 桥）。**关键语义**：姿势美术画在内层子剪辑自身的时间轴里，引擎每 tick 手动驱动（`FighterMC.renderAnimate`：主时间轴 `nextFrame()` + `renderChildren()` 把每个姿势子剪辑推进 1 格）——单纯 `gotoAndStop(f)` 子剪辑停在初始帧截不到姿势。capture 逐标签镜像引擎时序（`gotoAndStop(标签起始)` → 推进子剪辑 → 截图 → `nextFrame`+推进 → 截图），输出帧号 = 绝对内层帧（与 core `animFrame` 一致）→ `BitmapData.draw(root)` → 手写 PNG 编码（SWF ver17 无 `BitmapData.encode`）→ **像素哈希去重**（166k 帧引用 → 46k 唯一帧）；`tools/atlas-pack`（Node + pngjs）shelf 装包 2048² sheet，排序固定可复现。锚点契约：每帧记内容相对**角色 root 原点**的 bounds 偏移——原版 `BaseGameSprite` 直接 `_mainMc.x=_x; scaleX=direct`，即角色坐标 = root 局部原点、翻转绕原点，render 端 `translate(x,y) → scaleX(direct) → draw(bounds 偏移)` 复现。地图背景走同一 capture 桥（逐子图层 PNG + 偏移）。产物 `packages/data/assets/`（gitignore，管线可再生）。
- **配置**：原版 fighter/select/map/mission XML → JSON。

## 5. 渲染层

PixiJS v8；逻辑坐标 1000×600（y 向下）与原版一致，渲染层负责屏幕适配。渲染帧率与逻辑解耦：位置在最近两个快照间线性插值，动画帧/朝向取最新。相机平滑跟随 + 缩放自由实现。HUD 读快照绘制；音效/特效消费表现事件队列（事件带 tick 号，自行去重）。

## 6. 联机层（阶段 2，接口现已冻结）

Node + WebSocket 房间服务器，只做输入中继与房间管理，不跑模拟。每帧上行自己的 `ButtonMask`，下行全员 `(tick, ButtonMask)`；lockstep 调度 + 2~3 帧本地输入延迟掩盖抖动；定期交换快照哈希检测失步。回放 = 输入序列 + 种子 + 数据版本戳，帧同步天然免费。

架构上为 rollback 预留的三个接口（core 已按此设计）：tick 纯函数式推进、`SimState` 可序列化、输入只经 `InputFrame` 进入。

## 7. 验证体系（harness 先行）

借鉴 Claude of Duty"工具链比游戏更值钱"的经验，**门禁工具与 core 骨架同期交付**，不事后补：

| 工具 | 作用 | 对应物 |
|---|---|---|
| 确定性单测 | 同一输入序列跑两遍，逐帧哈希相等 | —— |
| `tools/replay` | 输入剧本回放 + 哈希门禁（提交前必跑） | 它的 imagediff.mjs，但我们比对的是逻辑状态，更强更便宜 |
| 对拍 | 原版桥接快照 vs 本地模拟逐帧比对 | 阶段 1 手感对齐用 |
| 数据校验器 | JSON schema + 引用完整性 | 角色并行转译的验收闸门 |

对拍容差初始：位移 ±0.5px、数值与状态码相等。允许按模块豁免，但必须逐条记录原因——接受有意识的偏离，不接受无意识的漂移。

## 8. 技术选型

TypeScript（strict）+ Vite + pnpm workspace；PixiJS v8；Node + `ws`（与客户端共享 core 包与类型）；Vitest（core 在 Node 环境测）；GPL-3.0（OpenBVN 转译传染性要求）。不用定点数。

## 9. 阶段 1 切片（POC）

> 2026-11-09 重排：本地双人/训练模式移出主线，进扩展项池（见立项书 §六）；阶段 1 以
> "单机对战闭环验收"收尾，随后直接进入阶段 2 联机。理由：lockstep 联机天然给出双方
> 输入，本地双人是最后才被需要的能力；联机是项目核心目标，尽早打通端到端。

1. **harness** ✅（切片 1）：`packages/core` 骨架 + 确定性单测 + `tools/replay` 门禁；
2. `tools/exporter` ✅（切片 2）：导出 ichigo + kon + 1 张地图的 JSON/图集；
3. core ✅（切片 3 最小闭环 + 切片 5 补全）：7 态动作机 + 判定区 + 命中结算 + 推挤；切片 5 补防御/瞬步/技/必杀最小集 + 能量系统 + 连段槽（见 §3.5），达到"能打一场完整对局"；
4. render ✅（切片 4 + 切片 5 清遗留）：帧动画、地图层、相机、基础 HUD；切片 5 补相机 clamp 接舞台边界、floor 前景层遮挡、HUD 回合文本；
5. app ✅（切片 4 + 切片 5 训练模式）：dev 预览页（键盘 → ButtonMask → tick → 渲染）；训练模式 = P2 假人（输入恒空）+ 无限血 + R 键重置；
6. **切片 5 = 阶段 1 收尾** ✅：确定性单测 40 过、replay 门禁四剧本（含新增 ichigo-mechanics）过。遗留池（不阻塞阶段 2）：摔技/万解/空中瞬步/二段跳/必杀飞行道具（fire 原语）；
7. **切片 6 = 联机地基** ✅：`InputSource` 抽象（本地键盘 / replay / 网络统一喂 sim，sim 本身零改动）+ lockstep 客户端（输入延迟帧、帧号对齐、输入缓冲）+ 同机双客户端经本地服务器镜像联调。落地（ADR-14）：`core/inputSource` 接口 + `ScriptedInputSource`（剧本回放源，tools/replay 剧本同构）；`packages/net`——协议词表（welcome/hello/start/input/hash/peer-lost）、`Transport` 抽象（`loopbackPair` 内存直连 + `wsTransport` 浏览器/node ws 双兼容）、`LockstepClient`（本地输入延迟 INPUT_DELAY=3 帧、按 tick 输入缓冲、每 HASH_STRIDE=60 tick 交换状态哈希检测失步、hello 配置指纹互验）；`server/relay.mjs` 最小中继（分配位次、收齐 hello 广播 start、input/hash 纯透传）。联调门禁：双客户端 loopback 对跑剧本 finalHash 相等且等于单机直跑（抽象零漂移）+ 停步语义 + 失步检测 + 真实 relay 进程 ws 端到端；app dev 页 `?mode=net&role=p1|p2` 双窗口联机入口。
8. **切片 7 = 房间服务器** ✅：Node.js WebSocket 房间（创建/加入、输入中继、断线最小处理：超时判负或冻结等待），局域网两机联调。落地（ADR-15）：`server/room-server.mjs`——4 位房间码（无易混字符）、create/join 入房（错误码 room-not-found/room-full）、收齐 hello 广播 start、input/hash 按房间透传、断线通知 peer-lost 后冻结等待（判负归阶段 4）、无重连；`packages/net` 协议词表扩展 create/join/welcome/error + `startSession` 会话助手（入房 + LockstepClient 装配一步到位，onWelcome 提前给 create 方房间码）；app `?mode=net&action=create|join&room=&port=` + 停步 5s 看门狗提示。注意 startSession 语义：要等 start 广播才 resolve——create/join 必须并发。门禁：net 7 测试（房间 e2e 对跑剧本哈希 = 单机直跑、room-not-found、room-full + 切片 6 全部回归）。
9. 公网联调与延迟体验调优视切片 7 结果立项（输入延迟帧自适应、可选升级 rollback——归阶段 4）。

阶段 1 明确不做：本地双人、rollback、第二个可操作角色、完整菜单流、街机模式、音效（事件队列留好）。本地双人进扩展项池，最后做。

## 10. 决策记录（ADR）

| # | 决策 | 日期 |
|---|---|---|
| 1 | 重构定位：行为对齐而非逐帧复刻，允许有意识偏离原版 | 2026-11-08 |
| 2 | 60Hz 逻辑帧 + 30Hz 动画/判定帧 | 2026-11-08 |
| 3 | 输入统一为位图 + 可配置缓冲窗口，废弃双模式 | 2026-11-08 |
| 4 | 版边用牵引边界，相机纯渲染化 | 2026-11-08 |
| 5 | 素材用 FFDec 运行时导出器 | 2026-11-08 |
| 6 | 38 角色自定义脚本全部保留，尽量数据化 | 2026-11-08 |
| 7 | 联机 lockstep 先行，架构为 rollback 留口 | 2026-11-08 |
| 8 | 双精度浮点，不引入定点数 | 2026-11-08 |
| 9 | 文档分层：契约（ARCHITECTURE.md）与设计文档分离，CLAUDE.md 做入口 | 2026-11-08 |
| 10 | harness 先行：replay 哈希门禁与 core 骨架同期交付；core 单线程开发，批量任务才 fan-out | 2026-11-08 |
| 11 | 角色定义（FighterDef）为静态配置：SimConfig 注入注册表、不进 SimState，快照恢复时回注（states 小、快照便宜） | 2026-11-09 |
| 12 | 原版常量换算细则定案：速度/衰减类 ×SPEED_PLUS(0.5)，帧数类（hurtTime 折算后的动画帧、HURT_FRAME_OFFSET）与空间类不折算；hurtTime 按 ms→30Hz 帧换算再叠加原版偏移 | 2026-11-09 |
| 13 | 图集管线：AIR runtime capture 桥逐帧栅格化（矢量符号必须运行时渲染）+ 像素哈希去重 + Node shelf 打包；锚点 = 内容相对角色 root 原点 bounds；地图走同桥逐子图层截取 | 2026-11-09 |
| 14 | lockstep 最小协议：消息词表 welcome/hello/start/input/hash/peer-lost；本地输入延迟 INPUT_DELAY=3 帧（采样槽 = 完成 tick 数 + delay）；失步检测 = 每 HASH_STRIDE=60 tick 交换状态哈希；hello 携带配置指纹（seed+舞台+角色标识）开跑前互验；中继只做连接编排，input/hash 纯透传（切片 7 房间服务器以词表为底稿） | 2026-11-09 |
| 15 | 房间协议扩展：入房词表 create/join/welcome(room)/error(room-not-found\|room-full)；位次由服务器分配（create→P1，join→P2）；断线处理 = 冻结等待 + peer-lost 提示（判负/重连归阶段 4）；房间码 4 位无易混字符，房空即销毁 | 2026-11-09 |

推翻旧决策：标 ~~删除线~~ 并追加新行写明替代方案与日期。
