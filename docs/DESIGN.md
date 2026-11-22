# BVN Web —— 设计文档

> 本文档回答"为什么这么做"；**"必须怎么做"以 [ARCHITECTURE.md](ARCHITECTURE.md)（引擎契约）为准**。
> 读者：项目决策者、需要理解设计背景的协作者。干活的 AI 只需读契约。
> 前置阅读：[BVN-module-map.md](BVN-module-map.md)（原版逆向）。
> 决策变更直接修改对应设计段，写明理由与日期（本仓不用 ADR 编号表）。
>
> **与 PROGRESS 的分工**：变动默认只改 PROGRESS（台账）；产生"要永远记住的规则/规格"才改本文档（**就地修改对应规格段，不追加日志**）；决策变更就地改对应段写明理由与日期。任何时刻不维护"待收紧"式欠账清单——欠的活记 PROGRESS §二。

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
- **交叉验证豁免**（2026-11-20 定案）：orihime（角色 + 辅助双形态）与 yachiru（辅助）运行时 dump 抓不到 defineAction 数据（注入桥局限，实际不可解决），二者的 actions 缺少"运行时实证 vs XFL 提取"双保险，仅由 XFL 静态提取产出（判定区几何不受影响，xflDrift 仅 assister:orihime 一处 `atm1` 仅存于 XFL）。已知盲区收编：若 XFL 解析器恰在这两者语料上有解析 bug 无机制可发现，接受该残余风险。
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

**元层键 `Btn.back`**（intro 切片）：原版 `GameInputer.back(1)`（back/MENU just-down）的位图化，开局演出跳过等 meta 流程消费——**不进缓冲器**（原版无缓冲语义，且 `ALL_BUTTONS` 维度即 `PlayerInput.buffer` 维度，加位会漂全量状态哈希基线）；just-down 边沿照常推导，仅无缓冲窗口。

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
- **loop 触发点**（批次 22）：原版时间轴脚本 `loop(name)` 在播放头进入触发帧时执行 `goFrame` 无条件回卷，该 tick 显示的就是落点帧；移植版按落点帧在推进后消费 `target='mc' op='loop'` 触发（`loopRedirectTarget`），触发帧本身永不采样/显示。此前只靠 LOOP_LABELS 标签尾回卷 → 脚本循环点后的死区帧被照常播放（鸣人形态1 走 24 帧里后 10 帧定格）→ 实测行走滑步。数据审计：79 处 loop 触发无一与其它触发同帧、无一处于标签首帧；`flowTarget` 顺流门同步加 loop 重定向检查。loop/gotoAndPlay/gotoAndStop 三 op 合并 setLabelTo 的旧结论作废——loop 需无条件回卷语义，其余两 op 保留同名守卫。
- **stop 触发冻结**（批次 32）：原版三系控制器（mc/attacker/assister）的 `stop()` 语义一致 = `stopRenderMainAnimate`——播放头停住、帧脚本不再触发（脚本只在播放头进入时执行一次）、物理照常；`goFrame(isPlay=true)`（换标签/开新动作）解冻。移植版：FighterState `mcHold` 置位（`stop` 行为，target=mc 全量 150 处——胜利/失败 116、跳招 15、必杀/砍技等；此前误映射为清速度，那是 `stopMove`/`move(0,0)` 语义）；`advanceAnimation` 入口冻结门（不采样不推进，判定区钉冻结帧，停止帧本身被采样/显示一次）；解冻点 = 换标签（`setLabel`/`setLabelTo`，**同名重设不解冻**——行走待机门每 tick 重设 走/站立 不能冲掉冻结）+ 动作入口（startAttack/startSkill/startWanKai）+ 触地续接/落地（`onLanded`——跳招/必杀 stop 后空中定格、落地走 `_TF` 续接解冻）+ 换形态（`switchForm`）。偏离登记：冻结帧内原版 `renderChildren` 照跑（子元件继续动画），web 烘焙 PNG 为静态合成（既有烘焙局限的时长放大）。数据教训：baked 触发帧为 0-based 脚本索引（addFrameScript 参数），编译层 +1 转 1-based。
- **判定区**：`def.areas[animFrame]` 查表（运行时 dump 几何，脚底锚点、direct=1 局部坐标）→ 世界 AABB（朝向镜像）；命中 = 攻击方 atm ∩ 受击方 bdmn。攻击判定名 = `<actionId>atm`。
- **静态数据**：`FighterDef` 经 `SimConfig` 注入 Sim 注册表，**不进 SimState**；快照恢复经 `Sim.fromState(state, defs)` 回注（`getDefEntries()` 回传）。
- **动画映射**（动作 id ↔ 标签）：`kjN→砍技N`、`tk→跳砍`、`tz→跳招`、`shN→摔N`、`zhN→招N`、`bs→必杀`、`sbs→上必杀`、`cbs→超必杀`；gotoAndPlay/gotoAndStop/loop 三 op 合并为 setLabelTo 单实现（30Hz 采样下语义无差异）。

**命中与受击**

- **逐区命中**：当前帧每个可解析 atm 区独立成命中——区名精确匹配 actions 优先，否则去 `atm` 后缀反查（原版 getHitVOByDisplayName）；多段动作各段独立结算；判定覆盖全部攻击态（isAttackingState）。**无跨帧去重**（修复批次 34 更正：原 `attackHit` 去重键 `区动作id:目标id` 系移植自创，原版 `checkHit` 每帧重扫、无去重；一帧一目标至多一命中 = `getHitObj` 首个相交，跨帧多段由受击 4 帧窗限频）。
- **受击分流**（原版 doHurt）：`hitx × 攻击者朝向`、空中 hity 补偿（HURT_Y_ADD_INAIR）；`hurtType==0` → HURT_ING（hurtTime ms→30Hz 帧换算 +3 偏移、下限 4），否则 HURT_FLYING（水平不衰减、按击退方向翻转朝向）；钢身（原版 doSteelHurt，修复批次 34 收编）：透支/必杀/摔命中 → 破钢走完整 doHurt，否则减伤 65%（STEEL_HURT_HP_PERCENT）+ 受击窗（击飞类 10 帧、其余 4 帧）+ 耗能（破防技全额/其余 40%，超钢未实现）+ 击退（setVec2）；受击窗统一 `HURT_GAP_FRAME=4` **渲染帧**（doHurt 开头，hurtAct 分支同样生效；批次 38 修正换算——原版 frameRate=30，60Hz tick ×2 = `HURT_GAP_TICKS=8`，同律 STEEL 8/20、DEFENSE 8/16；此前按 4 tick 递减窗口实长减半，位移攻击解冻后二段命中）；hp≤0 → 先完整 applyHurt 击退（enterHurt 在死亡分流之前——原版 `FighterMcCtrler.doHurt` 位移/击飞先于死亡判定；切片 48 偏离修正：此前致死分支提前返回导致 KO 尸体无击飞，阻塞终结慢镜头链）→ 死亡分流（修复批次 65）：击飞类（hurtType≠0）致死**不当场 DEAD**——原版 doHurt 致死只发 DIE + isAlive=false，代码继续 playHurtFly，尸体照走击飞三段式，`renderHurtFly` case 4 首查 isAlive 才转 DEAD（躺姿定格跳过起身）；非击飞致死同样不当场 DEAD（批次 66，2026-11-21）：原版 `renderHurtAnimate` 硬直计尽查 isAlive——空中重新 hurtFly 直落起飞、地面 playHurtDown 倒地段（击飞_弹 2 帧 → 击飞_倒 HURT_DOWN）→ case 4 DEAD 躺姿，die voice（playVoice(2,1)）在计尽转换点发出；正常 KO 败方不播「失败」标签（原版 doLose 仅街机 continue 界面调用）。破防致死偏离登记：原版 doBreakDefense 削血无 DIE 检查——0 血回站立可再被命中直至 DIE（回合由再次命中/timeover 收束），port 以 hp≤0 代 isAlive（命中判定 hp≤0 门）回站立将不可再命中 → 回合软锁，故破防致死同走硬直计尽收尾（有意偏离，2026-11-21）。`fighter:ko { fighter, bsKo }` 与回合终结时序不变（KO tick 照发）；飞尸不可再被打 = 命中判定 `tgt.hp<=0` 排除（原版语义同构）。
- **击飞三段式弹起**（切片 54，原版 `FighterMC.renderHurtFly` 1→2→3→4 子状态机）：HURT_FLYING/HURT_DOWN_TAN 期由 `stepHurtFly` 每动画帧推进（stepAnimation 内 advanceAnimation 之后调用，同原版 renderAnimate nextFrame 后时序）；子状态 5 字段进 SimState（`hurtFlyStage/hurtFlyTimer/hurtFlyHold/hurtApexY/hurtHity`）。①飞行：`hurtFlyTimer`（原版 `_hurtFlyFrame`）递减——轻击飞初值 `HURT_JUMP_FRAMES=15`、重击飞 0；同时跟踪最低 y（`hurtApexY`＝原版 `_hurtYMin`，弹起深度基准）；门尽且触地 → ②击飞_落（定格 + `hurtFlyHold` 独立计数 = 原版 `_curFrameCount`），展示 ≥2 动画帧后分流：**重击**（hity>HIT_DOWN_BY_HITY(5)）→ HURT_DOWN + 击飞_倒 定格 + 倒地计时 `HIT_DOWN_FRAME_HEAVY=30` + 震屏 (y−apexY)/25×(1+hity×0.1) 夹 [2,5] + hit_floor_heavy + hit_floor_yan；**轻击** → HURT_DOWN_TAN(24) + 击飞_弹 定格 + 二次起飞 vy=−(y−apexY)/25 夹 [3,8]×SPEED_PLUS + 震屏夹 [0.5,3]（弹速恒 ≥3 → 实际恒 3）+ hit_floor → ③弹起空中：展示 ≥2 帧且二次触地 → HURT_DOWN + 击飞_倒 + `HIT_DOWN_FRAMES=15` + hit_floor_low + 震屏 2（原版 shake(0,1)×2 折算）；④倒地定格计时走 advanceAnimation 的 mcHold 分支（原版 `_hurtDownFrame` 不受 `_renderMainAnimate` 冻结影响）：hp≤0 尸体在段首即转 DEAD 躺姿定格（enterDeadLying，见偏离登记①），计满 → 起身 → recoverToNormal。落地期（飞行门未满）以飞行姿势站地滑行等待（原版 renderFloorAction 被 isHurtFlying 拦截的等价门）；空中再吃击飞命中 → 子状态机整体重入 stage 1（原版 playHurtFly 重入 + goFrame 重置帧号）。落地尘土/震屏自 physics 落地点迁至子状态机转换点产出（原版 `hitFloor(type)`：0→hit_floor / 1→hit_floor_low / 2→hit_floor_heavy+hit_floor_yan），shake 参数已按原版 FighterEffectCtrler.shake 的 ×2 折算进事件。偏离登记（①经修复批次 65 更正，2026-11-20）：①击飞致死收编——击飞类（hurtType≠0）致死不再当场 DEAD，尸体照走本子状态机；原版 renderHurtFly case 1-3 无 isAlive 门、case 4（FighterMC.as:513）首查 isAlive 转 DEAD 躺姿定格跳过起身，port 以 advanceAnimation mcHold 分支 hp≤0 门 → enterDeadLying 收编；此前登记「KO 直死无弹起段——原版死亡即 DEAD 无 renderHurtFly 推进，行为一致」系误读源码（FFDec 导出 FighterMC.as 实证更正），行为缺陷 = 边缘 KO 尸体播「失败」定格直立末帧；②击飞_倒 阻尼已按原版收编（修复批次 60：重 HIT_FLOOR_DAMPING_X_HEAVY=4→2.0/tick、轻/弹起 HIT_FLOOR_DAMPING_X=2→1.0/tick，击飞_弹 弹起同时 setDamping 补设）；③`_curFrameCount<2` 门以 hurtFlyHold 独立计数等价实现（不共享动画流帧计数）。HURT_DOWN_TAN 渲染层三消费对齐原版（红条 delay / 连击保持 / 挂身特效收尾——specialEffectId 条目"移植版无该状态"偏离登记解除）。
- **回气**：近战命中攻击方 qi += min(power×0.16, 15)、受击方 min(power×0.085, 20)（被防御命中同样结算）；道具命中发射者 power×0.1、独立道具命中所有者 power×0.15；辅助判定区命中 owner qi +power×15%；必杀判定（actionId 含 "bs"）近战/道具不回气；近战回气只结算角色本人动作命中。
- **命中停顿与火花**（修复批次 35，原版 EffectCtrler 收编）：命中成立置 `SimState.freezeTicks`（hitstop，进哈希），下一 tick 起整局早退（输入采样照常推进——stepInputs 只推导边沿/缓冲无行为副作用，停顿期间按下的连段键进缓冲不丢；否则轻击 3 tick 停顿恰好吃掉连段窗口，批次 35 实测修正）。freeze 全表：轻击类（KAN=1/DA=2/MAGIC=4）50ms→3 tick、重型（3/5/6/7/8/9/11）400ms→24 tick、0/10 无；防御回退同表（0 除外）；钢身吸收 24、破防 500ms→30。火花钉点 = 命中区∩受击方身体区（bdmn）相交区中心，无身体区回退命中区中心；payload `sparkType` 为手防转换后值（HAND 防御 KAN→DA、KAN_HEAVY→DA_HEAVY，剑防不转——特效/音源都随转换后值）；payload 不进哈希，`freezeTicks` 进哈希（重冻双基线）。渲染层镜像 EffectCtrler：30fps 流帧火花 + randRotate、ADD 全屏 shine（15fps ×0.95）、双轴 shake（pow 直用 X、防御系转 Y 竖抖、破防横抖；命中系 VO 的 shake{pow:6} 为 doEffectVO 死代码不移植——只读 shake.x/y）。
- **specialEffectId 持续挂身特效**（切片 50，原版 `EffectCtrler.doSpecialEffect`/`SpecialEffectView`）：命中表 FIRE/ICE/ELECTRIC（hitType 7/8/9）**未防御**命中受击者时挂身持续特效 fire_ing/ice_ing/shock_ing（xg_fire_ing/xg_ice_ing/xg_dian_ing，hit-pack 烘焙 + FrameTag 解析 loop/finish 段位），同时打 targetColorOffset 色调（fire (255,25,−255)/ice (0,0,255)/shock (50,−75,255)，ColorMatrixFilter 加色近似）。挂身期 MC 原点钉受击者脚下逐帧跟随、timeline loop 段回跳循环（原版 EffectView 0/1 基错位语义原样保留）；目标回 NORMAL/HURT_DOWN/HURT_DOWN_TAN（切片 54 补收 HURT_DOWN_TAN=24，"移植版无该状态"偏离登记解除）→ gotoAndPlay("finish") + resumeColor（色调还原、位置自此冻结），收尾段播尽自移除。全链纯渲染层：触发由 `hit:connect` payload hitType 派生、收尾由快照 actionState 派生（切片 47 残影范式，不进 core 无哈希面）；单槽覆盖（后到覆盖前件——原版可叠多层且 resumeColor 先到先清，简化偏离登记）；目标快照缺席（团队 bench 下场）即刻移除；钢身/防御/破防路径无挂身（原版防御/钢身特效表无 specialEffectId）。
- **buff 视觉特效**（切片 51，原版 `FighterBuffCtrler.speedUp/attackUp/defenseUp` → `doEffectById("buff_effect_*")` + `doBuffEffect("buff_*")`，EffectModel.initBuffEffect 表）：三种 buff（speed/attack/defense，事件 kind speed/power/defense）施加时各发两件视觉——①施加点一次性火花 `buff_effect_speed|power|defense`（direct=1 原版缺省朝向，30fps 播尽自移除，刷新重复施加照播 = 刷新脉冲）；②持续挂身光环 `buff_speed|power|defense`（`BuffEffectView` loopPlay=true：**全时间轴** 30fps 循环——区别于 specialEffectId 件的 loop/finish 帧标签段，末缓存帧跳过回卷；MC 原点钉角色脚下逐帧跟随；direct = 施加时朝向钉死不随转向重镜像）。熄灭判定 = 渲染层快照 `buffs` 差分（原版 render 检出 buff.finished || !isAlive 移除；buff 计满/角色死亡/团队下场三路收敛，切片 47 残影范式不进 core）。偏离登记：原版重复施加叠加多个光环实例（共享 FighterBuffVO 使旧光环不随刷新移除——缺陷），port 每 fighter×kind 单实例去重，重复施加只补一次性脉冲。事件 `effect buffUp { fighter, kind }` 由 core applyBuff 发出（原版 doBuffEffect 每次调用都发）。
- **钢身发光**（切片 51，原版 `FighterMcCtrler.setSteelBody(v, isSuper)` → `FighterEffectCtrler.startGlow/endGlow`）：GlowFilter（color 1/blur 20×20/strength 2/quality 1/knockout）垫层，颜色 isSuper ? 黄 0xFFFF00（语料 `(true,true)` 18 处）: 白 0xFFFFFF。事件 `effect startGlow/endGlow { fighter, isSuper? }` 只携色；**开关态以快照 `steelBody` 差分为准**——endActAction 等 sim 静默清钢身不发事件，纯事件驱动会漏灭灯（角色死亡/下场差分兜底）。渲染折算 = 发光克隆精灵（原版 `BitmapFilterView` 每动画帧把角色显示对象经滤镜重绘成独立 knockout 位图垫在角色之下；port 以同纹理克隆 + pixi-filters GlowFilter 置角色层之下等价——本体像素与角色逐帧重合被盖住只露光环；parts 混合子层不克隆，近似偏离）；滤镜按色缓存复用。`setSteelBody` 第二参 isSuper 原版还驱动 super 钢身伤害减半（STEEL_SUPER_HURT_HP_PERCENT）与 AI 判定——port 钢身伤害单档（STEEL_HURT_HP_PERCENT），isSuper 仅视觉，sim 语义差随钢身批次一并归因。
- **持续震屏 startShake**（切片 52，原版 `FighterEffectCtrler.startShake` → `EffectCtrler.startShake`）：与 `shake`（pow 衰减一次性）语义分立的**保持项**——`_shakeHoldX/Y` 置位后渲染步进每帧 `stage.x/y = (hold + pow)×direct`（direct 逐帧翻转、pow 每 2 帧衰减 `_shakeLose` 的既有 60fps 语义不变，hold 叠加进同一合成）；`endShake` 清 hold + stage 位移即时回零（pow 衰减项存活）。hold 全局单槽（原版 EffectCtrler 每舞台单实例，后发 startShake 覆盖前发；语料 28 处主战调用全为 `[0, N]` powY∈{2..5}，辅助语料零实例）。清理三路：①显式 `endShake` 事件（语料 22 处）；②**渲染层快照差分近似**原版 FighterMcCtrler doAction/idle/doHurt 统一 endShake 自动清理——owner actionState 变化 / 死亡 / 快照缺席（残影切片 47 范式；辅助 owner 无 actionState 仅缺席清；语料 6 处未配对 endShake 靠此兜底）；③渲染层销毁。事件 `effect startShake { owner, ownerKind, x, y }` / `endShake`（无参、全局清）不改 sim 行为，behaviorHash 零漂移；渲染接线 = advanceShake 既有的 holdX/holdY 死字段启用。
- **受击被动——替身/灵压爆发**（切片 55，原版 `FighterMcCtrler.renderHurtBreak`/`isCanHurtBreak` + `FighterMain.replaceSkill/energyExplode`）：HURT_ING 硬直期轮询触发门：`hurtBreakCd≤0` + `energy≥50`（无透支）+ `qi≥100` + 最后一击非必杀（`hurtChain.bisha` 只看最后一击——原版 getLastHurtHitVO）+ 链内无破防（整链）+ 链伤害 ≤210（Σ power×powerRate，`hurtChain.damage` 口径 = 防御减伤前）+ 辅助键**按住**（电平非边沿）。消耗 `qi−100 + energy−100`（门 50 消耗 100 照搬——满能量恰好归零不透支）+ `hurtBreakCd=5` + `usedPassiveCd=5`（屏蔽辅助召唤同窗）。分流：`comicType==1`（火影）→ **替身**：瞬移目标旁 200px（moveToTarget 版边镜像 + 面向目标 + y 吸附）+ 回血 `lastHurtDamage`（clamp hpMax）+ 回站立 + `replaceTicks=30`（α0.5 + 免伤）；否则（死神）→ **灵压爆发**：定身 + 钢身 + 定点命中区（原版 Rectangle(−100,−200,200,210) 触发瞬间世界坐标定死）+ `explodeHitTicks=10`（t∈(0,8) 生效，==8 收招免伤，≤0 恢复可被命中）+ `explodeSteelTicks=60`（每帧重申钢身，被击飞即清）。爆发命中 = 伪命中：power 50 / hitType 5（MAGIC_HEAVY）/ hurtType 1（击飞）/ hitx=15×触发时朝向，`stepHitResolution` 顶部扫描在场爆发区∩存活可被命中者。**冻结语义进 sim**：`SimState.passiveFreeze { kind, ownerId, ticksLeft }`（替身 20 / 爆发 42，原版 FPS_GAME/3 与 0.7×FPS_GAME）——全场停走含施法者（原版 GameCtrler.pause **无 justRender 白名单**，区别于幽步/切人锁），tick 管线早退只递减倒计时，清除时 sim 补发 end 事件。残效计时在 stepAnimation（30Hz，原版 renderAnimate 同律）。触发轮询在 stepIntents（60Hz）——偏离：响应提前半动画帧（级联条件在相邻 tick 内不变）；触发即 consume 辅助键——偏离：防输入缓冲泄漏（受击期边沿若不清，恢复后 6 帧缓冲窗误召唤辅助）。事件：`replaceSkill`（瞬移前钉点）/`startEnergyExplode`（钉爆发点）+ 冻结清除时 `endReplaceSkill`/`endEnergyExplode`；渲染层 replaceSp2 按快照差分补放。偏离登记：原版按住辅助键触发无 UI 键名提示，被动可用提示 = QiBar 红点 sp（isCanHurtBreak，切片 57 收编进 hud）；爆发命中不发攻击方回气（viaEntity 路径，原版该命中攻击方=施法者本人亦无攻击回气——语义一致）。
- **防御**：按住 ↓（DEFENCE_ING），命中削血 5% + 能量损耗 min(50, power/5)（破防技 = 90% 上限）；能量不足 → 破防（HURT_ING 42 tick、额外削血 power/10、击退夹 [5,10]；削血致死走硬直计尽收尾——见受击分流破防致死偏离登记）；背刺照 checkDefDirect（受击方与攻击方同向 = 挡住）；防御分支允许出手清单照原版 setDefenseAction 槽子集（砍技1/招2/超必杀/瞬步）。
- **摔技/抓取**：地面动作分流允许 catch（attack/skill 缓冲 + 朝目标移动 + 身位间隙 <2px + |dy|<1）→ startSkill 进摔技标签；首帧 `moveTarget({followmc})` 吸附——目标以 `speed×SPEED_PLUS` 逼近锚点区中心×朝向（speed 缺省 0 = 直接吸附；原版锚点为 MC 注册点，取判定区中心等效）；攻击态结束由 sim 巡检释放（释放需恢复目标重力/回拉，状态机层做不了），释放恢复 applyG + HURT_FLYING 回拉 5px。
- **结算序**（规范化，替代原版 children 插入序，全部 id 升序）：fighter→fighter → 攻击 vs 道具 → 道具 vs 角色 → 道具对撞。

**资源**

- **能量**：上限 100；普回 1/tick、攻击中 0.55、防御 0.4、过载 0.3；花费后 24 tick 冷却（USE_ENERGY_CD）。
- **气**：必杀 100 / 上必杀 100 / 超必杀 300，不足不动。
- **fzqi**：上限 100、每帧无条件 +0.2；NORMAL/DEFENCE 态且满时 `assist` 位召唤。
- **hp**：`addHp`/`addHpPercent`/`addHpLosePercent` clamp hpMax（hp≤0 不回）；`loseHp` 自削血归零 → 死亡。

**移动、跳跃与物理**

- **行走**：vx = speed×0.5 直结（与原版 setVelocity→move×0.5 逐 tick 等价）；地面位移受标签门（见备忘），空中 airMove 不受限（实测批次 59 修正 2026-11-20：endAction 曾无条件清 airMove——起跳标签播尽（~5 动画帧）即失去空中操控；原版 起跳→跳中 是 renderJumpAnimate 的纯 goFrame("跳中") 转换（FighterMcCtrler.as:1351），不经过 clearAction，airMove 贯穿整个滞空；修正 = endAction 仅地面清 airMove，空中清由起手路径承担（startAttack/startSkill = 原版 doAction→clearAction、doHurt、脚本化 move 触发））。
- **阻尼**：dampX/dampY 每 tick 双向线性逼近 0（原版 num_wake）；跳跃 vy = −jumpPower×0.5 + JUMP_DAMPING（30fps→60Hz ×SPEED_PLUS 折半），上升段重力清零。受击/倒地/死亡滑行不做额外地面摩擦（修复批次 60，2026-11-20 原版实证）：原版滑行衰减只来自命中/倒地起手 setDamping（doHurt=HURT_DAMPING_X 0.1、破防同、倒地 HIT_FLOOR_DAMPING_X 2/重 4，60Hz 减量作用于 30fps 单位速度 → 移植版 ×0.5 = 0.05/1.0/2.0 每 tick）——移植版曾叠加 POC 自创 GROUND_FRICTION=0.9，受击滑步距离比原版短约 10 倍、击飞_弹 弹起漏设阻尼（0 vs 1.0），均已删/补。
- **重力斜坡**：原版 `_g` 模型（离地预置初值、空中递增、封顶），位移空间步长 +0.3/tick、上限 6——步长不再二次折算（批次 19 修正）。
- **跳跃家族**：jumpTimes = 2 起始（地面跳/空中跳各耗 1）；起跳延迟 JUMP_DELAY_FRAME 地面 2/空中 1（帧数不折算，置于物理积分后处理——首个上升位移出现在下一 tick；延迟结束才施加速并消耗 jumpTimes）；空中跳可取消空中攻击；起跳发射清 vx/dampX（原版 `FighterMain.jump()` = `setVelocity(0, -jumpPower)` 无惯性跳跃；偏离修正 2026-11-17：曾保留走跑 vx 致空中漂移 + 落地滑行）；`↓+跳` 快速下落 vy 2.5/tick 匀速（阻尼取 0——原版 damping 1 在 60Hz 首 tick 即跌破穿台阈值）、jumpTimes 清零、穿平台、触地续接 落地；快速下落前置于防御检查（原版净效果等价；修复批次 64 2026-11-20：防御态发起须走 DEFENCE_ING 早退块内分支——批次 61 曾只放宽后置分支状态门，被早退块遮蔽不可达，先按 ↓ 进防御再按跳无法下平台；发起时按原版 _action.clear() 语义回 NORMAL 待机姿势，槽位由落地 endAction 恢复）。
- **瞬步**：能量 20 可透支（透支 → 过载 0.3/tick 慢回至 >30 解除）；DASH_ING 期间不可被命中，方向取按住的方向键。
- **起跳/落地尘土**（切片 56，原版 `FighterMcCtrler.renderJumpAnimate`/`render`→`touchFloor`）：①起跳尘土在跳跃延迟计满的发射 tick 按起跳前是否在地面分流——地面跳 `jump`（XG_jump）/空中二段跳 `jump_air`（XG_jump_air，ADD 加色混合），音效同 snd_jump（原表 EffectVO.sound 同源）；②落地尘土**状态门**（原版非无条件）：`renderHurt` 短路拦截 HURT 系 + `touchFloor` 的 `isAlive` 守卫 → HURT_ING/DEAD 落地无尘土，HURT_FLYING 走击飞子状态机转换点 hit_floor 系列（切片 54）；可发尘土两类——跳跃/坠落落地（原版 `_isFalling` 兜底 "落地" 标签，port 按 NORMAL/JUMP_ING 白名单）与触地续接（`setTouchFloor` 预约标签存在且非 HURT_ING/DEAD，空中攻击落地同样触发——预约标签存在即视为 act 非空）。事件 id 用 `touchFloor` 与时间轴 emit 同键，渲染层按 tick+id 去重防双播。纯表现事件不进 SimState，零哈希面。

**瞬身步家族**（dash+方向；统一成本气 60（不透支）+ 能量 80（可透支），24 tick 免伤 + isCross + 意图封锁）

- dash+↓ 地面步：位移 4/tick、标签 走，受连续冷却门 `ghostCooldown`（自然到期即时恢复、中断按剩余 tick 恢复——原版 `_isContinuousGhostStep`）；
- dash+↑ 空中瞬跳：vy −6 / dampY 0.05 / jumpTimes−1，结束恢复 damping(−vy/10) + airMove（顺序在回位之后，不被 endAction 清掉）；
- dash+↓（空中）速降：vy 7.5 触地即结束；
- 必杀/万解中不可发起；地面分支先于瞬步/跳判定；防御态经输入缓冲下一拍接瞬身步脱离。
- **幽步演出/冻结**（切片 53，原版 `EffectCtrler.ghostStep` → `GameCtrler.pause` + `justRender` 白名单 + `shadow(0,0,255)`）：三类瞬身步均全场冻结——tick 幽步冻结分支（切片 22 冻结范式同款）：全场停走（输入/意图/推挤/命中/道具/计时/回气），仅瞬身者物理积分（`stepPhysics` `onlyId` 过滤 + 牵引边界单边 clamp，原版 `fixGameSpritePosition` 只修白名单者）+ 时间轴 30Hz 推进（原版 justRenderAnimate；走标签帧照常触发）。事件链：`startGhostStep`（意图层 ghostTicks 0→>0 差分发出）→ 渲染层蓝残影（复用切片 47 机制，色偏移 0/0/255）+ 黑幕/地图隐藏（updateCutin 按快照 ghostTicks 差分，无横幅立绘）+ app 层 snd_ghost_jump；幽步期走标签帧 walk op 分流发 `ghost_step` 蓝色拖尾火花（XG_ghost_step，ADD 混合，effectSound snd_ghost_step——原版 `FighterEffectCtrler.walk` `_inGhostStep` 分支）；`endGhostStep` 停残影。地面步全程 NORMAL，残影 actionState 差分自动清理不触发——依赖显式事件收尾（黑幕由快照差分自动收）。

**技、必杀与万解**

- **槽位分流**：attack/±↓/↑ 组合由槽位路由（skill1/skill2/zhao1-3/bisha 系/catch 系/dash）；SKILL_ING / BISHA_ING / BISHA_SUPER_ING 照原版枚举。
- **连段**：动作发起即清空全部动作槽（原版 doAction→clearAction），播放中再按攻击键不重启动作、时间轴不复位；连段 = 帧触发 `setAttack("砍2")` 重填槽后派生；槽重填默认于 endAction。空中槽 attackAIR/skillAIR/bishaAIR（airHitTimes 递减耗尽不再触发）；`setJump(label)` 覆写跳跃标签。
- **万解**：qi ≥ 300 时 攻击+跳 组合（W→S→普通 优先级，缓冲按下/按住混合——对原版按住电平判定的手感取向偏离）→ 扣 300 气 → WAN_KAI_ING 50 tick 演出（免伤）→ 效果事件 wanKai/endWanKai；`startWanKai` 参数为必杀 FACE 名（语料全体 doWanKai 无参）。
- **万解形态切换**：`doWanKai(frame)`/`switchForm(frame)` = 根时间轴切换（0 = 下一形态，>0 按 `def.rootFrame` 寻址）——切 `formIndex`（`SimConfig.fighters[].forms` 多形态注册表，data 层 `compileFighterForms` 编译）+ 槽重填 + 播新形态 开场 + `fighter:form` 事件驱动 render 换图集；单形态静默不切。
- **切人冻结锁**（切片 22，原版 `EffectCtrler.bisha`/`wanKai`）：`bisha`/`startWanKai`（事件 id `wanKai`）置 `SimState.cutinLock { kind: 'fighter'|'assister', id, type: 'bisha'|'wanKai' }`，`endBisha`/`endWanKai` 清除。原版语义 = `GameCtrler.pause()` 全场逻辑冻结 + 黑幕 + 特写立绘，施法者画面由 render 驱动继续播（帧脚本照常触发——`endBisha` 即在冻结期到来）；移植版等价 = 锁置位后下一 tick 起全场停走（输入/意图/物理/推挤/命中/计时/道具/其他实体动画），仅锁主时间轴 30Hz 推进。锁主失联保护（收招回 NORMAL/死亡/辅助退场 → 保护性解锁）：原版语料缺 end 系 = 永久黑屏软锁，web 端选解锁兜底（有意识偏离）。
- **slowDown 全局慢放**（切片 49，原版 `FighterEffectCtrler.slowDown(t)` → `EffectCtrler.slowDown(1.5, t*1000)`，角色/辅助语料 86 处）：置 `SimState.slowDown { ticksLeft: t×60, scale: 1/1.5, animEvery: 3 }`——影响逻辑速度，进 sim 折算（KO 链范式，定夺 2026-11-20）。原版三重语义折算：①位移/重力消费侧 ×scale（原版 `GameCtrler.slow(1.5)` → 全体 sprite `setSpeedPlus(SPEED_PLUS_DEFAULT/1.5)`：角色/弹（位移+addSpeed 加速）/独立道具/辅助同律；阻尼衰减不缩，KO 链同款）；②时间轴步进降频 20Hz（原版 `_renderAnimateGap = ceil(FPS_GAME/(30/rate))−1`：角色/弹/独立道具时间轴与命中判定 checkHit 同门——推挤 checkBodyHit 每渲染帧照跑、不受门控）；③计时器每 tick 递减（原版 `EffectCtrler.renderSlowDown` 每渲染帧无条件——冻结/特写/演出期照减，实时间语义）。终结慢镜头 `roundEnd.slow` 与全局 slowDown 并存时折算相乘（原版两条 speedPlus 通道同态叠加）。重复触发重置计时（原版 `GameCtrler.slow` 重入同语义）；rate 固定 1.5（原版 FighterEffectCtrler 硬编码；KO 链 rate 2 走 roundEnd.slow 独立通道）。渲染层相机牵引同步 ×scale（原版 `camera.tweenSpd = 2.5×rate`）。
- **开局特写演出**（intro 切片，原版 `GameStartCtrler.start1v1`/`renderStart1v1`）：`SimConfig.intro`（缺省 false = 原版 TRAINING(40) 无开场语义；replay/batch 零漂移）→ `SimState.intro?: IntroState { step, hold }`（无演出 = 字段缺省 undefined，JSON 序列化省略——全量/行为双哈希零漂移）。状态机（hold 单位 = sim tick，原版 holdFrame 秒 × FPS_GAME=60）：0 特写P1(30) → 1 语音P1（`sayIntro` = `actionState=INTRO_ING(60)` + 播 开场 标签；等 `actionState` 离开 INTRO_ING **或**离开 开场 标签——endAct（移植版补：INTRO_ING 期 endAct 回 NORMAL，对齐原版置 FREEZE(40)≠60 的放行效果）/idle/播尽 endAction 任一路径）→ 2 gap(18) → 3 特写P2(30) → 4 语音P2 → 5 gap(18) → 6 resume(30，偏离登记 2026-11-17：原版 0.1s，移植版镜头 3.5→1 缓动 ~0.5s，30 tick 让镜头回正再出字样) → 7 字样(156 = startKOmc start 段 78 次 30Hz nextFrame ×2) → 结束。冻结语义 = 原版 `actionEnable=false`：输入采样照常（批次 35 教训）、角色时间轴 30Hz 推进、能量/辅助气/buff 回充照跑（`stepFighterFlow` 与 `stepMatchFlow` 共享 = 原版 renderAnimate 无条件语义）；物理/推挤/命中/回合计时（`roundFrame`）停走（原版 renderGameTime 被门控）。skip = `Btn.back` just-down（原版 `renderPause` 的 `GameInputer.back(1)`），仅 step<7 可跳（原版 `_step<5` 字样出场前）；skip tick 即恢复正常管线 + 双方 `recoverToNormal`（原版 idle()）。偏离登记：缺 开场 标签的角色跳过 say 步（原版此情形软锁，web 端选择不锁死）。

**团队回合流**（切片 35 尾巴，原版 `GameRunFighterGroup`/`GameCtrler.doBuildNextRound`/`nextFighter`/`GameEndCtrler`/`GameStage.resetFight`；`SimConfig.teams` 存在时启用；切片 46 起状态机泛化为非训练对局通用——team 换人与 1v1 同一 `roundEnd` 状态机，训练模式不置位；多局制切片 2026-11-21 修正：原版 1v1 为三局两胜多局制，见回合计时与多局制段）：

- **roster 装配**：出场序 roster（p1 → id 1,3,5、p2 → id 2,4,6 交错编号）抄进 `MatchState.teams`（`TeamSlot { id, x, y?, comicType?, assistId, formIndex, hp }`——静态值开局抄录，换人只依赖 SimState，fromState 无需重新注入配置）；sim 是严格 2 活跃角色模型，仅各队队首进 `SimState.fighters`，其余为 bench（`pending1/pending2` 待出场队列）。
- **KO 即置位**：非训练对局 KO（含破防致死）当拍置 `SimState.roundEnd { winnerSide, winnerId, loserId, loserQi, loserComicType, draw, winApplied, perfect, hold, over }`（1v1 同置位；训练模式不置位——切片 29 训练语义不打断）；同拍双 KO 按命中结算序先行者建 roundEnd、后死者若为该 roundEnd 的 winnerId 则改判 `draw`（原版同拍双亡重启语义的 port 折算）。败方 `loserQi` = KO 时气量——KO 命中不吃受击回气（applyHit 在 hp≤0 提前返回），攻击方命中回气照常。置位同拍发表现事件：`round:end` + `hit_end` 打点（钉败方 KO 时刻位置）+ shine 白闪（0xFFFFFF/α0.5）+ shake(5,0,1.5) 屏震 + `fighter:ko { bsKo }`（原版 `FightUI.playKO`；平局省略 hit_end/shine；必杀中 KO——任一方 BISHA_ING/BISHA_SUPER_ING，胜方侧发 `kobg { hold:2 }` 地图隐藏背景层）。置位同时清 `cutinLock`（修复批次 63：必杀黑幕/横幅不得悬空盖过败方特写；偏离记录——原版黑幕待锁主 endBisha 才 fadOut 与 KO 演出并行，移植版 KO 序列优先，锁主时间轴仍由 tickRoundEnd stepAnimation 照常收尾）。
- **roundEnd 状态机**（60Hz，`tickRoundEnd`）：置位当拍起，先过 **KO 字样窗口** `WIN_TEXT_GATE_TICKS=120`（原版 `GameCtrler.pause` 500ms + KO 字样 47 帧 @30fps）——窗口内**全场停走**（修复批次 63，原版 `_isRenderGame=false` 门控 checkRenderAnimate/renderGameSprite：被动物理/角色时间轴/回气 buff/道具全冻，尸体定格于 KO 姿态；KO 字样/特效/相机为表现层实时间照常推进；偏离修正——此前窗口期照常步进，与原版 pause 语义不符）；过窗后进入**终结慢镜头**（切片 48，原版 `FightUI.renderEnd` slowDown(2,0)）：败方击飞中（`!onGround || vy<0`——原版按 actionState 22/30 分流，doHurt 击飞类先置 22 再 DIE，被击飞致死者 resume 时即 HURT_FLYING；移植版 enterDead 覆写为 DEAD，以物理等价判定）则 `roundEnd.slow=true`——位移/重力 ×`SLOW_MOTION_SCALE=0.5`（阻尼 wake 不缩放）、动画/弹体/独立道具时间轴每 `SLOW_MOTION_ANIM_EVERY=4` tick 推进（≈原版 setAnimateFPS 15fps）、相机推进 ×0.5，`slowTicks` 计拍；败方落地检出 → slow=false + `winnerDelay = slowTicks<SLOW_FLIGHT_TICKS_GATE=60 ? 120 : 60`（原版 `_showWinnerDelay` 2s/1s：慢飞实时 <2000ms ⟺ slowTicks<60，每慢 tick = 2 实 tick；开局即落地无飞行直接 120）。**延迟互斥门**（修复批次 63）：原版 `_showWinnerDelay` 分支先行——延迟一经开跑，尸体 HURT_DOWN_TAN 弹起不再回慢镜头/重置延迟（原版弹起期 delay 分支吞帧，state 22 检查不再到达）；过窗后回气/buff 照跑（原版 renderAnimate 无条件）+ 被动物理 + 飞行道具/独立道具位移与动画走完（命中判定停走——原版 `setAllowLoseHP(false)` 折算）；`winnerDelay` 计满且胜方非必杀/万解演出（BISHA_ING/BISHA_SUPER_ING/WAN_KAI_ING，原版 `isAllowWinState` 等待门；攻击/技能不阻挡）→ 落 `WIN_ING` + 胜利 label + `perfect` 标记（`hp≥hpMax`，原版 `FightUI.showWinner $perfect`，回血前判定，驱动 winner 字样 Perfect 段）+ 血量恢复 `(hpMax−hp)×0.33`（**仅 team**——原版 case1 `isTeamMode` 门；回血率 0.165×(timeRate+1)，多局制切片归位），当拍记 `winAppliedHold`；推进门 = `hold − winAppliedHold ≥ ROUND_END_TICKS=180`（180 = 原版胜利 pose 3s × FPS_GAME）→ 换人/终局——切片 48 修正：此前统一 `hold≥ROUND_END_TOTAL_TICKS` 门在慢镜头拉长 timeline 时会于 winApplied 前提前推进（现在 draw 仍走 `hold≥300` 门）。`Btn.back`（元层键）任一时刻 just-down 即计满跳过（原版 transIn 不建模、skip 仅特定步的偏离登记；切片 48：skip 时无视必杀门强制应用胜利 pose 并把 `winAppliedHold` 钉在字样窗 120——避免 skip 后等不到 isAllowWinState 软锁，下一拍即推进）。
- **换人**（原版 `doBuildNextRound`+`nextFighter` 净效果）：`rotateIn` 从 pending 队列取下一名，构造**全新满血 FighterState**（hp/hpMax 取 `TeamSlot.hp` = 出生 hp）替换被 KO 者——原版 resetFight 双方满血回位 + 胜方 lastWinnerHp 回填的净效果 = 胜方保持恢复后 hp、入场者满血；双方回各自出生点（原版 resetFight 用 map spawn）、速度清零落地。气继承：`qi = min(300, loserQi + (同 comicType ? 100 : 0))`（原版 lastLoserQi + 同系 +100）。平局（draw）：双侧轮换（气均以首个败方计），任一侧 pending 耗尽按胜方侧判终局（原版平局以尸体重启——不建模，偏离登记）。换人后 `round++`/`roundFrame=0` + 清场（在场弹/独立道具/辅助 `entity:despawn` + cutinLock 清除，原版重开清场的等价收口）+ `beginIntro(loserSide)`（入场方获得特写/语音，skip=1/2 语义复用 intro 状态机）+ 发 `round:start`；入场发 `fighter:enter { fighter, side }`（render 按 fighter id 寻址 roster 精灵 id-swap 免重绑图集）。
- **终局**：败方侧 pending 耗尽 → `finishMatch(winnerSide)`：发 `match:over { winner }` + `roundEnd.over` 冻结（继续 tick 全停）——app 层消费后回选人页（原版 VS 系 fightFinish 语义；原版街机模式专属结算页 WinnerStage 不移植，2026-11-21 定案整块移除——local 回选人可重选重开，net 关 socket 回菜单）。胜场逐局计（多局制切片归位：原版 doGameEnd 置位时 `p1Wins++/p2Wins++`，平局不计）；终局拍 round 仍推进（原版 runNext 的 `nextRound()` 先行）。
- **回合计时与多局制**（多局制切片 2026-11-21，原版 `GameCtrler.renderGameTime`/`timeover`/`drawGame`/`runNext`；偏离归位——此前 1v1"KO 即终局/双 KO 判和局"系漏读原版 runNext single 分支 `p1Wins<2 && p2Wins<2 → buildNextRound(false)`）：
  - **计时**：`MatchState.gameTime/gameTimeMax`（秒，SimConfig.fightTime 缺省 60 = 原版 ConfigVO.fightTime；训练 -1 无时限）。每 62 tick 减 1（原版 renderGameTime 挂 30Hz renderAnimate 内独立计数器 31 次调用）——仅正常管线走此步（冻结/intro/演出/特写/幽步期停走，与原版 `actionEnable && !_startCtrler && !_endCtrler` 门控同构）。偏离登记：递减相位 `roundFrame % 62 === 0`（原版计数器不随回合重置）；slowDown 期计时照走（原版随动画帧同门降频，挂身慢放累计秒级可忽略）。
  - **timeover**：gameTime 归零 → `roundEnd { timerOver: true }` 置位（原版 `timeover()`：actionEnable=false + hp 比较）——hp 高者胜（胜场逐局计）、相等平局。复用 KO 演出状态机但无 KO 表现链（原版 playTimeOver 无 hit_end/白闪/kobg/屏震）、无终结慢镜头（败方活人无飞尸）、showWinner 延迟恒 1s（原版 timeoverBack）、无字样窗冻结（原版无 pause，仅封输入）。渲染播 timeover/drawgame 字样（timerOver 分流）。偏离登记（多局制切片 2026-11-21）：① timeover 平局的 team 换人气不继承——原版用上一局残留 lastLoserData 的 stale 语义，不建模；② 非平局 winner 字样起播锚 = `winAppliedHold`（timerOver 路径 hold 120 门 + 延迟 60 = 180；原版 timeover 段计满 hold 88 + 1s 延迟 ≈ 148 起播，0.5s 内偏差，不为对齐而动 core 计时）。
  - **平局重开**：1v1 平局（双 KO / timeover hp 相等）不计胜场、演出计满恒重开该轮（原版 drawGame → runNext single 分支）。team 平局维持既有双换人/耗尽判定语义。
  - **1v1 三局两胜**：KO/timeover 置位即逐局计胜；演出计满 → wins<2 双方 → `restartRound1v1`（原版 buildNextRound(false) 净效果：双方满血回出生点 + idle + 气保留 + gameTime 重置满 + intro 直入字样步——原版 startNextRound 无特写仅 startKOmc 字样重播，bannerRound/bannerFight 音照发）→ round++；wins≥2 → `finishMatch`。render 胜利星按逐局累积 wins 显示（原版 FightUI.showWins）。
  - **胜方回血归位**：team 模式恢复率 `0.165×(timeRate+1)`，timeRate = gameTime/gameTimeMax（原版 GameEndCtrler.renderEND case1；无时限 timeRate=1 → 0.33 与旧值同构）。1v1 无回血（isTeamMode 门，重开满血使然）。
- **终局演出表现**（切片 46，原版 `FightUI.playKO`/`showWinner`/`showWins` + `GameCtrler` 相机）：render 消费 `roundEnd`——winApplied 前特写败方（KO 飞尸）、之后特写胜方（WIN 姿势），`cameraFocusOne` zoom 3.5 同款；平局不聚焦。HUD 结算字样全快照驱动：KO 字样 47 帧（置位 0.5s 后起播，原版 playKO2 setTimeout）、winner 字样（winApplied 起播 1..29 帧，perfect 续播至 56 定格；平局不播，改播 drawgame 字样段——多局制渲染收编 2026-11-21，见下节 start_final 段与结算字样段）、胜利星（仅 1v1，原版 `showWins isSingleMode` 门，bleach/naruto 段按胜方 comicType）。切片 48 终结演出链收编：`hit_end` 走通用火花路径（xg_hitover 钉 KO 位）、`kobg` 专层（world 最底层、激活期隐藏 map/mapFront 系，hold×30 帧 30fps 循环、移除时恢复——`cutinLock` 活跃时不恢复交由切人管线；修复批次 63：kobg 横向拉伸铺满版宽——原版地图即 800 宽画布全覆盖，移植版地图更宽时右缘露底图断层）、HUD winner 字样基准改 `winAppliedHold`（慢镜头可变延迟下原固定门失效）、`fighter:ko { bsKo }` 音频分流 snd_ko/snd_ko_bs（500ms 延迟 + snd_over_hit 立即）。演出期败方版边钳制（修复批次 63，原版 `GameLogic.fixGameSpritePosition` map.left+10/right-10 对全体精灵生效——飞尸/尸体同样受钳；此前无钳，滑出版边致相机钳在版内拍空气）。
- **HUD/渲染装配**：roster 全员精灵/贴帧音/语音绑定按 fighter id 预载（app `fighterId(side, index)` 交错编号即 sim id）；HUD `teamFighters` 大脸/能量标签按 id 寻址换脸。

**飞行道具与独立道具**

- **Bullet**：速度存发射朝向的局部系（world 位移 = sx×SPEED_PLUS×facing×(1−speedLevel)，speedLevel = 风场弹速级派生值，见辅助系统风场段，常态 0）；addSpeed = 净加速度/tick（原版 add×2 预乘）；maxSpeed/minSpeed 局部系 clamp（两朝向一致）；holdFrame = 秒×60；hitTimes = −1 无限；hp/hpMax 道具对撞互扣（hp −= 对方 hpMax）。命中矩形 = 发射帧命名判定区（原版为元件帧 1 视觉 bounds，逐帧矩形未导出——PROGRESS §2.2）。30Hz 生命周期标签分派（loop/remove/hit_over/timeout）；命中残留（killBullet）= 停移动播尽移除。**触底**（切片 56，原版 `Bullet.render` → `GameLogic.isTouchBottomFloor`）：`y > groundY` → `hit(_hitVO, null)`（target=null：仅消耗 hitTimes，耗尽进命中残留；无回气/速度分支）+ `EffectCtrler.shake(0,1,200)` 轻震屏，且 `return` 跳过出界判定——hitTimes=−1 的触底弹持续下沉（每 tick 重触底重震），仅寿命可收走。
- **fire(mcName)**：发射帧上名为 mcName 的判定区 = 道具固定命中框；HitDef 去 atm 后缀查动作表；判定区/动作缺失 = 确定性静默。
- **独立道具 addAttacker**（B5 逐帧命中矩形，2026-11-12）：实体位置 = **元件原点**世界坐标（原版 `_mcOrgPoint`，fires[name].org = 实例在父时间轴的摆放位，direct=1；x/y/w/h 字段保留生成帧内容尺寸供物理夹取/渲染回退）。命中矩形**逐帧解析**（原版 `FighterAttacker.findHitArea`）：`fires[name].hits[帧]` 命名子对象（元件局部 direct=1）沿朝向镜像平移到原点（RectUtils 镜像），名按 owner 动作表精确 → 去首个 "atm" 解析 HitVO（`getHitVOByDisplayName` 镜像），无命中区帧 = 该帧无判定，未解析名 = 纯表现；数据源：viaAssist → 辅助 def fires，角色 → 当前形态 def fires。缺 org/hits 的元件（旧采集/歧义多库符号）回退生成帧占位矩形全程固定（切片 10 占位语义，世界矩形与中心语义等价）。轴 params `x`/`y`（followTarget 每 tick 跟随 / moveToTarget 出场到位 / offset；follow 轴 y = 目标原点 + offset）；`applyG`（底边 = 原点 + fbHit 底）；**不因命中失效**（修复批次 34 更正：原登记"单次命中即失效——语料无多次命中实例"已被语料证伪——17 角色存在 ≥10 帧连续同判定窗，原版 `FighterAttacker.hit` 无失效字段，多段命中靠受击方 `HURT_GAP_FRAME=4` 帧无敌窗限频；每帧至多一命中 = `checkHit→getHitObj` 首个相交。仅"缺逐帧数据的回退占位路径"保留单次命中门——移植自创近似不受原版逐帧语义背书）；寿命 = 播尽移除（`animTotal−1` off-by-one 原样保留；无时间轴回退 holdTicks 120）。viaAssist（辅助召唤）道具回气归召唤者、命中不回气。逐帧数据管线 = dump 桥（`tools/bridge`，帧脚本 fake 控制器吸收后逐帧 getBounds）+ `tools/b5-pack` 合并进 baked fires 包（同名跨形态多记录 → 取 addAttacker 所在形态）。
- **角色侧 attacker 元件脚本**（2026-11-21，原版 `$attacker_ctrler.*`）：addAttacker 元件时间轴的帧脚本驱动道具——原版 FighterAttacker 继承 BaseGameSprite（速度×speedPlus 位移 + num_wake 阻尼 + 触地续接 `_touchFloor` 门 + `renderCheckTargetHit` 命中续接巡检）+ FighterAttackerCtrler 转发 op（move/damping/stopMove/setTouchFloor/setCrossMap/moveToTarget/setHitTarget/fire/gotoAndPlay/gotoAndStop/stop/stopFollowTarget/removeSelf/endAct + effect.shine/playSoundHit1/2/dash/walk/shake/slowDown）。移植：fires[name].triggers（XFL 元件脚本提取，`tools/fire-script-pack`，帧号 0 基 +1）→ `FighterDef.attackerScripts` → `stepAttackerAnim` 逐帧分派（角色生成与 viaAssist 道具同机制，切片 21 复用）；`stepAttackers` 每 tick 消费速度/阻尼/触地续接/命中巡检（checker 区 = 当前帧命中数据，与目标 body 相交 → gotoAndPlay(action 标签)）。attacker 语境 `fire(mcName, params)` = 元件内再发射弹体（原版 `FighterAttackerCtrler.fire` → FIRE_BULLET → new Bullet(childMc, params)）：弹位置 = 当前帧命名子对象命中区镜像到原点，params 语义同 behaviors.fire（x/y 轴对象、hold 秒、hits 次），owner 沿道具 owner（命中回气归 owner fighter，原版 hv.owner=_attacker → FighterAttacker.hit）。典型语料：pain 招1（zh1mc 后撤 + 3 连弹幕 fire zh1atm/zh13atm {x:18,hold:1,hits:1}）、招2（zh2mc 飞行弹 move(15,0) + setHitTarget('zh20atm','hit') 接触即 gotoAndPlay('hit') 二段突进爆炸）。提取缺口：复杂脚本（if/var 等非卫语句）整帧跳过审计——语料 7 帧（gaara bsmc、kakashi cbsmc、juggo zh22mc、obito zh3mc），确定性静默。
- **目标系 op**（语义细则见契约原语表）：setHitTarget/moveToTarget（版边镜像防穿帮）/justHitToPlay/setHurtAction（携带：触发在攻击方时间轴，本次动作命中 → 受击方播专用受击动画；标签属受击方 def，applyHit 消费时校验存在性）/hurtFly（主动击飞）/setDirectToTarget/setDirectReverse/setTargetVelocity。

**条件触发器**（原版 `if($xx_ctrler.query()){...}else{...}`）

- 导出器语句级解析（简单调用体）：条件可解析 → `FrameTrigger.cond/then/else`（`evaluateTriggerCondition` 求值后分派，分支体调用仍走原语表）；不可解析条件含调用 → 整段抑制 + rawScript 残留；纯卫语句丢弃。早期"拉平为无条件双分支全执行"是真实行为 bug，已修复。
- 查询 op（原版 FighterCtrler 对齐）：`justHit(hitId, includeDefense?)`（lastHurtHitId / lastDefHitId）、`targetInRange(rx, ry?)`（朝向相对 x 窗 + y 差窗）、`getTargetState`、`getSelf`、`getTargetSP`（属性链 + cmp）；属性走 `fighterProp` 白名单（`isInAir = !onGround`、hp/qi/energy/x/y/actionState 等，speed/jumpPower/heavy 读 def）。未知查询 op = false、未知属性读 null（AS 真值 = false）——确定性静默。

**辅助系统**（AssisterCtrler 转译）

- **召唤流程**：NORMAL/DEFENCE 态且 fzqi 满时 `assist` 位召唤（单主单辅助）；出生点 `owner.x − 30×direct`；时间轴从 animFrame=2 起播（原版 gotoAndPlay(2)）；`summon` op 不注册（全语料零实例，召唤由输入意图驱动）。出场特效 `fz_bleach`/`fz_naruto` 按辅助 comicType 分流（切片 55，select.json assists 传入）；被动触发后 `usedPassiveCd>0` 同窗屏蔽召唤（原版 isUsedPassiveCdIng）。
- **实体**：free-running 时间轴（无状态机/动作槽）；物理 = 速度终值单位 + wake 阻尼 + 重力 ramp（2 起、步进 0.3、上限 6），仅 groundY 落地；`setTouchFloor` 落地消费一次续接标签；退场 = 时间轴末或主亡（主亡判定在 customFunc 之后，见备忘）。
- **op 词表** `defaultAssisterBehaviors`：target 三分 `self`/`fighter`(owner)/`fighterTarget`(对方)；未注册静默（残余仅 justHit（纯读）/setTouchSide（语料无实例））。**loop 触发器**：注册帧起每动画帧求值 cond（checkHitOwner 辅助判定区∩owner bdmn / actionStateIn）至 untilFrame（排他）；导出器守卫语义 `if(!X)return` → cond=X、`if(X)return` → cond=¬X。
- **buff**：speedUp 平加 walkSpeed（×SPEED_PLUS）/ attackUp 伤害乘区 attackRate=1+value（回气仍按 raw power）/ defenseUp `dr=clamp(2−value, 0.1, 1)`；hold×60 tick，重复施加刷新。辅助包 `buffEffects`：orihime attrResistance 0.2（属性受击先减）、yachiru phyLifesteal 0.35（物理命中吸血）。`buffSpeedUpByOwnerSpeed(rate, hold)`：原版 `var ownerSpeed = getOwner().speed; speedUp(ownerSpeed × rate, hold)` 惯用语的数据化（expr 跨期不可求值）；值 = 召唤者 def 基速 × rate。
- **风场**（B4 temari windField）：注册帧采样（原版帧 2 采样、帧 34 注册——采样窗口含必杀切人冻结不可区分，port 统一取注册帧）目标 def 基速/heavy：`level = LEVEL[min(heavy, len)−1]`、`finalSpeed = 基速 × level`、`direct` = 注册时朝向（闭包捕获，不随转向变化）。每动画帧：目标非 HURT_DOWN(23) 时 `x += finalSpeed × direct × SPEED_PLUS`。弹速级为**派生值**：`stepBullets` 按在场风场辅助实时求值 `speedLevel = level × (弹朝向==direct ? −1 : 1)`（仅敌方弹，同队跳过 = 原版 isSelfTeam；多辅助同场 id 序后者覆盖 = 原版单槽覆写序），不进 SimState。偏离记录：①风场期间生成的弹即刻受风（原版经 fuutonFunc 覆写 ≤2 动画帧延迟）；②辅助提前退场（主亡）弹立即恢复常速（原版最后覆写值泄漏至弹消失——视为缺陷修正）；③目标速度取 def 基速（原版读可能含既有 buff 的 `.speed` 属性）；④heavy<1 防御性降级 level=0（语料 heavy∈[1,5] 不可达）。
- **customFunc / attacker 元件脚本**：语义见契约原语表与下方备忘。
- 快照恢复 `Sim.fromState` 须回传 `getAssisterDefs()`（assists 注册表不进 defEntries）。

**机制语义备忘（切片 13 起固化；改动这些语义前先读，出处 commit 见 git 历史）**：

- **时间轴顺流**（批次 20）：非循环攻击标签播尽且 ①仍处攻击态 ②段尾无重定向触发（idle/setLabelTo）③下一标签帧号连续且非循环 → 滑入续播（原版标签边界不停车）；必杀 1 帧桩（必杀→空中必杀、招1_SP→招1 等）靠此播放。
- **endAct** 只清槽置 FREEZE，**不动播放头**（批次 17）；收尾由标签播尽或后续 idle 触发。
- **damping = 持久阻尼**：安装后每 tick 线性衰减，非一次性乘法；move 系附带清阻尼（批次 17）。
- **行走物理标签门**：地面位移需 `actLabel∈{站立,走} && labelLock<=0`；idle 触发清 labelLock（批次 20）。
- **防御定格**：抬手段播 3 帧后停住；`防御` 不在 LOOP_LABELS（批次 17）。
- **防御恢复冻结窗口**（批次 22）：原版解除防御 = `goFrame("防御恢复",false,{call:idle,delay:1})`——isPlay=false 播放头钉首帧不推进，goFrameDelay 两 tick 后 idle 回站立（原版站立本身是 goFrame("站立",false) 静态单帧）。移植版 labelLock=3：T0/T1 冻结显示首帧、T2 转 站立。此前放完整段 防御恢复（labelLock=duration）→ 实测"卡一下"才回站立。偏离保留：解除前 6 tick `_defenseFrameDelay` 计数仍按 POC 约定省略（响应性优先）；站立 9 帧循环保留（2026-11-20 用户定案，有意偏离——原版 goFrame("站立",false) 静态单帧，但 SWF 素材本有约 9 帧待机动画未被播放，移植版播原版自有素材）。
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
- 漂移仍发生时的归因：`tools/replay/verify-drift.mjs <script>` 自动对比 当前工作区 vs HEAD 的全量状态逐 tick dump（stash→build→dump→pop），全等 = 纯表示变更（可重冻），不等 = 输出字段级行为差异（禁止重冻）。**两次 dump 必须子进程运行**（`dump-states.mjs`）：同进程 ESM import 缓存会让 HEAD dump 沿用首次加载的 dist → 恒「零差异」假阴性（批次 22 发现修复——此前该工具只对数据改动有效，对代码改动结构性失效）。

## 4. 数据与素材管线

- **导出**：FFDec 反编译主 SWF + 注入导出脚本（参考 bvn-ai-public 的状态桥），运行时遍历 dump 帧标签、`getBounds` 判定几何、`defineAction` 表、帧触发点、地图边界/地板/出生点。输出带源 SWF 哈希版本戳。
- **图集**（切片 4 定案）：原版角色/辅助图形是矢量符号（XFL 库几乎无位图），必须运行时栅格化——`tools/atlas-capture`（AIR capture 桥，范式同 dump 桥）。**关键语义**：姿势美术画在内层子剪辑自身的时间轴里，引擎每 tick 手动驱动（`FighterMC.renderAnimate`：主时间轴 `nextFrame()` + `renderChildren()` 把每个姿势子剪辑推进 1 格）——单纯 `gotoAndStop(f)` 子剪辑停在初始帧截不到姿势。capture 逐标签镜像引擎时序（`gotoAndStop(标签起始)` → 推进子剪辑 → 截图 → `nextFrame`+推进 → 截图），输出帧号 = 绝对内层帧（与 core `animFrame` 一致）→ `BitmapData.draw(root)` → 手写 PNG 编码（SWF ver17 无 `BitmapData.encode`）→ **像素哈希去重**（166k 帧引用 → 46k 唯一帧）；`tools/atlas-pack`（Node + pngjs）shelf 装包 2048² sheet，排序固定可复现。锚点契约：每帧记内容相对**角色 root 原点**的 bounds 偏移——原版 `BaseGameSprite` 直接 `_mainMc.x=_x; scaleX=direct`，即角色坐标 = root 局部原点、翻转绕原点，render 端 `translate(x,y) → scaleX(direct) → draw(bounds 偏移)` 复现。地图背景走同一 capture 桥（逐子图层 PNG + 偏移）。产物 `packages/data/assets/`（gitignore，管线可再生）。
- **配置**：原版 fighter/select/map/mission XML → JSON。
- **切人插图管线**（`tools/bisha-pack`，切片 22 / 26）：effect.swf `-export sprite` → `bisha_face_mc`（DefineSprite_633）71 帧 WebP + 各角色 SWF `-export image` 按类名挑必杀立绘位图（映射源 = baked fighters `forms[].sounds.bishaFaces`）→ `assets/bisha/`；切片 26 补步骤 3b：XG_bs/XG_cbs 17 帧光效逐帧 WebP（断言画布尺寸，cbs=bs×1.2 比例验证锚定假设）；槽位矩阵/画布原点/光效规格烘焙进 `baked/bisha.json`（schema `bvn/bisha@3`，2026-11-22 随流帧拼图升版）。画布原点推导：mc 空间原点 (−134,−12) 由 mc_017 照片带（自身 bounds 原点 (0,0)：5 张 picture 全部 a=2/d=2 原点摆放）在帧画布上的实测位 (133,12) 反推；打包时断言画布 1066×209，规格漂移即报错。（批次 29 实测修正：导出画布并非内容 union bounds——内容实际占 PNG (133,12)..(933,196) ≈ mc 空间 [0,800]，两侧各 ~133px 对称透明出血，canvasOrigin 即出血宽；横幅内容恰为原版 800×600 游戏区宽。）
- **流帧拼图**（`tools/stream-sheet`，2026-11-22 战斗加载降请求）：部署环境（跨境 ~250ms/请求）逐帧 webp（hitspark 647 + bisha mc 71 + bisha effects 34）把加载 7/7 拖成分钟级——请求次数主导成本。前提 = 统一画布流帧（hit-pack/bisha-pack 烘焙语义：全帧 union bounds，同流帧等尺寸，工具逐帧实测校验）：按行优先货架拼进少量 sheet webp（q85 同 webp-convert 参数，gutter 2px 防色度跨格渗色，sheet 尺寸贴内容不放大——解码显存 = sheet 面积×4B），清单（sheets/cell/cells）写回 baked JSON（hitspark `bvn/hitspark@2` / bisha `bvn/bisha@3`）。842 请求 → 50 sheet。render `loadSheetFrames` 按 sheet 装载、逐帧建 cell quad 纹理（`Texture.frame`，共享源；消费端 `Texture[]` 形状不变、销毁路径无纹理级 destroy 已核实），无清单旧包走逐帧回退。逐帧 webp 保留不删：生产已发布客户端仍按帧拉取，待新版上线缓存过期后清理。

## 5. 渲染层

PixiJS v8；逻辑坐标 1000×600（y 向下）与原版 FighterTester SWF 舞台一致（**注意**：原版游戏内容区 GAME_SIZE=800×600、root scrollRect(0,0,800,600)——移植版视野比原版宽 25%，依赖内容区尺寸的演出层须按可见逻辑区适配，见切人插图段），渲染层负责屏幕适配。渲染帧率与逻辑解耦：位置在最近两个快照间线性插值，动画帧/朝向取最新。相机平滑跟随 + 缩放自由实现。HUD 读快照绘制；音效/特效消费表现事件队列（事件带 tick 号，自行去重）。

**装载与首帧**（切片 31）：`load(spec, onProgress)` 分步计数回报进度（装载队列由 LoadingScene 驱动、步间让帧）；`prime()` = 首帧相机摆位（fitZoom×zoomFactor + clamp + bgFixed cover + hud.layout），修换场景首帧"进场黑边"；`setStageVisible()` 供装载期隐藏世界/HUD 层（渲染层直挂 pixi.stage，创建方负责重提 uiRoot）。渲染器所有权沿 `BattleLoadout` 交接：LoadingScene 装载 → BattleScene 使用/销毁。

**逐帧时间轴贴帧音**（切片 28；批次 62 修）：角色/辅助 SWF 时间轴上的匿名 StartSound 音（挥砍/呐喊等）——Flash 语义 = 播放头**进入帧**时触发（含 gotoAndPlay 跳转落点帧；跳过的帧不触发；冻结播放头不重触发）。采集管线 `tools/sound-pack/frame-sounds.mjs`（自研最小 SWF 标签解析 + FFDec `-export sound`；formIndex = root `mc` 放置序，与 compileFighterForms 过滤空形态后对齐）→ `baked/timeline-sounds.json`（schema `bvn/timeline-sounds@2`）。批次 62 两修：① **嵌套有效音轨**——形态 sprite 下嵌套子元件（AImain/mc 包装层）的贴帧音按 Flash 放置语义并入父帧号（放置帧 + 子帧 − 1，递归 + memo），直连（ichigo 系）与嵌套（byakuya 系）统一收敛，此前 9 包嵌套音全漏（naruto/pain 等开场呐喊缺失根因）；② **寻址改 `<kind>/<id>`**——fighter 与 assistant 基名 16 处相同（byakuya/gaara/...），旧裸 id 键在 packages/files/`timeline/<id>` 资产目录三处互相覆盖，同名 fighter 时间轴音整包丢失。播放接线纯 app 层：`handleTimelineFrames` 每 tick 对比快照 animFrame 变化触发，首次 sighting 作静音基线——core 零改动、双哈希零漂移。偏离：音量包络（Envelope）忽略，全音量播放；嵌套演出件时间轴音（99 处）遗留池。

**切人插图**（切片 22 / 26 / 批次 29）：黑幕 + 横幅 + 立绘 = 屏幕空间层（`cutinScreen`，bgFixed 与 world 之间；切片 26 修正切片 22 的偏差——横幅原在 world 内会随聚焦相机漂移，原版 BlackBackView 挂 stage/scrollRect 之外，本应屏幕空间），`SimState.cutinLock ≠ null` 期间盖满视口并按 `min(viewW/1000, viewH/600)` 等比缩放。横幅 = `bisha_face_mc` 71 帧流帧（30fps，0-based 帧 1 起播，destory/stop 帧自然消失），y = `100 + 100/zoomTarget`（原版 showBishaFace：zoom 取演出开始时的相机目标因子，showFace 在 cameraFocusOne 之前调用）；**横幅内容宽**（画布 1066 减两侧对称透明出血 |canvasOrigin.x|≈798）在原版恰好铺满 800×600 游戏区（原版 GAME_SIZE=800、root scrollRect(0,0,800,600)、BlackBackView mc.x=0——实际内容边界经页面内解码逐帧实测），移植版可见逻辑区 = viewW/fitZoom（1000+，随纵横比）→ 内容**横向拉伸铺满 visW**、立绘槽位 wx 同比外推保持"贴 band 两端"构图（批次 29 修复右缘黑区；速度线横幅拉伸不可感知，与 bgFixed cover 同款适配，偏离记录）；立绘按逐帧槽位矩阵合成（`bisha.json` slots：W_T/缩放绕 transformationPoint 线性补间烘焙），屏幕位 = `(wx×内容拉伸因子, mcPosY+wy)`——canvasOrigin 只用于 band PNG 定位，不参与立绘定位（此前误减一次 = 整体右偏 134/下偏 12、槽 2 推出屏右缘，批次 29 修复）；faceId = 施法者在目标右侧 ? 右槽(镜像) : 左槽（原版 showFace）。白闪（原版 color offset 255→50→0）以白色加色叠层近似（偏离记录）。地图/map front 层锁定期隐藏。**横幅/立绘仅主战**（批次 42 修复）：原版 EffectCtrler.bisha 的 `face && target is FighterMain` 守卫——辅助施放 bisha 演出只有黑幕 + 位置光效，不显示横幅与立绘。

**必杀光效**（切片 26，原版 `EffectCtrler.bisha` doEffectById 分支）：`bisha`（isSuper=false）/ `bisha_super`（isSuper=true；wanKai 恒 super）= XG_bs/XG_cbs 17 帧逐帧序列（bisha-pack 步骤 3b 导出，30fps 加色混合，画布原点 (−123.05,−101.9)/(−147.85,−122.31)，cbs=bs×1.2 精确吻合交叉验证锚定假设），锚在事件 payload (x, y−50) 播尽自移除（原版 EffectView 逐帧播完 remove）。

**相机聚焦与自适应缩放**（切片 26，原版 GameCamera autoZoom；批次 23 追补视口基准）：`bisha`/`wanKai` 事件 isSuper=true → `camFocus` 置施法者（zoomTarget=3.5），`endBisha`/`endWanKai`（cutinLock 解锁）→ 恢复双焦点 autoZoom；autoZoom = `min(设计视宽W/distX, 设计视高H/distY)×0.8` clamp [1, 2.5]（dist=0 → Infinity），视口基准 = 原版 `_screenSize` = GAME_SIZE **800×600 常量**（批次 23 追补：此前误用实际可见区 viewW/fitZoom——宽屏 1066 使 zx 偏大 → zoom 偏大、贴身推近过狠；渲染可见区仍随纵横比铺满，仅 zoom 数值节奏对齐原版）。缓动 = 每帧 `delta/5`（tweenSpd 2.5 ÷ SPEED_PLUS 0.5），位置 snap 0.5 世界px、缩放 snap 0.5/800。保守偏离：clamp 夹在平滑后的当前有效缩放值上（原版夹目标值）——视觉差异仅出现在版边附近数像素级，按重构定位接受。

**开局特写相机与字样**（intro 切片，原版 GameStartCtrler.preRenderStart/renderStart1v1 + FightUI.showStart/renderStartAndKO）：快照驱动零新事件——`updateIntro` 在 updateCutin 之后覆写 `camFocus`（step 0-2 聚焦 P1、3-5 聚焦 P2，zoom 3.5 与必杀特写同款；step ≥6 双焦点 autoZoom 接管；updateCutin 无锁时先清 camFocus，intro 随后覆写，故每帧重设）。字样 = FightHud `startko` 帧集（hud-pack 烘焙 startKOmc=sprite 228 的 start+fight 段 79 帧，663×466 画布；PNG(0,0) = mc 画布原点 (13,103)，像素取证解出——帧 36-53 静态 scale-1 nummc 实例 + 6098px 数字 blob 恒等；摆放 = ui_fight.startKOmc@(0,0) + showStart y=-50 → 舞台 (13,53)），`intro.step===7` 期间按 `floor(hold/2)` 30Hz 流帧（快照驱动，与 core 字样步进严格同步），intro 结束/跳过即隐藏（原版 COMPLETE → clearStartAndKO）。**Round 数字**（批次 43，nummc 收编修正）：原版嵌套 nummc（mc_041）由 mc_043 帧脚本 `nummc.gotoAndPlay("r"+$round)` 控制（FightUI.showStart 设 `startKOmc.$round`），数字 1..5 = 静态位图（swf id 182/185/188/191/194，锚 mc_041 (10,2) → 字样画布 (441,340) 模板匹配实测）+ 实例 scaleY 弹入（批次 67 像素取证修正批次 43 的"遮罩揭示"误判：nummc 实例是 motion tween——d 0.127→1.361 过冲→1.0、底锚、加速度 -100，数字位图本身静态；XFL 关键帧 + SWF 逐帧像素质量比双实证吻合。揭示窗口 = 字样资产帧 18-27，稳定 28-45；词右缘 x431 与数字区 x≥433 无缝隔离）。此前"数字已烘进帧位图"的实现错在 FFDec 帧导出不执行时间轴脚本——原始嵌套时间轴被烘死（数字 1 于 18-43、数字 2 于 44-45），回合 ≥2 显示错轮数字、回合 1 末尾还闪数字 2。修正 = 烘焙期字样帧数字区擦除 + 数字位图独立导出（`image:png_gif_jpeg_alpha` 分离 alpha 避 JPEG3 噪点）逐帧合成，运行时 `updateStartKO` 按 `min(round,5)` 选组叠放（`startko-num` 140 帧 = 5 数字 × 28 窗口帧）。偏离登记（2026-11-19，批次 67 重写①）：① 揭示帧按原版 scaleY 弹入曲线（0.127→1.361 过冲→1.0，底锚；曲线由原版 SWF 帧像素质量比实测并做形状断言防漂移）对稳定字样做底锚双线性行重采样烘焙——批次 43 的逐帧 alpha 遮罩复原（`a_k/max(a_stable,200)`）实为对 scaleY 缩放的误读，非单调 alpha 产生"空→半透→闪跳全显"的闪变，已废弃；稳定帧（窗口帧 11-28/数字）直拷与旧产物逐字节一致，运行时零改动；原判"揭示瞬间加色闪光"实为过冲帧缩放软边缘，无独立闪光层；② 原版 round≥5 用 start_final 段——已随多局制渲染收编（见下）→ 数字按 min(round,4) 封顶（start_final 段无数字槽，仅 round≤4 才走 start 段路径）。**居中 delta 分段烘焙**（批次 62）：原版字样组合在 800 宽内本身偏左 39.5px，批次 44 以固定 delta 对齐中线——但词-only 段（资产帧 ~10-17，bbox 中心 307.5）与 Fight! 段（46-79，中心 ~407）在同 delta 下分别偏左 40px/偏右 59px（用户实测"不居中"根因）。改分段居中（重构取向，偏离记录）：`frameDeltas` 逐帧实测（词段/Fight! 段），数字窗口 18-45 运行时按回合查 `num.centerDeltas`（词+数字组合 bbox，数字宽度逐回合自适应；数字位图运行时合成故烘焙帧已擦除数字区），intro 帧变化时改钉扎 x 重摆。**开场播报音**（批次 62）：startKOmc 声音层贴帧音（内嵌 fight.swf 匿名音，dumpSWF 实证 StartSound 帧 11=回合播报 sound_007/帧 57=Fight! sound_005/帧 96=决胜 sound_006/帧 221=TimeOver/帧 267=DrawGame）→ sound-pack banner 段（assets/audio/banner/）；core intro step 7 按贴帧音 hold（帧 11→hold 0、帧 57→hold 92）发 `sound` 事件 `bannerRound`/`bannerFight`，audio 侧 banner 清单播放（确定性事件，不入状态哈希）；bannerFinal（帧 96=决胜音 sound_006）由 core intro 字样步 hold 0 按 `round≥5` 分流发 `bannerFinal`（原版 start_final 路径无 nummc 数字槽——r5 nummc 段死代码佐证）。**Round 数字语音**（批次 68，2026-11-21）：nummc（mc_041，sprite 196）声音层每段贴帧音 One/Two/Three/Four（StartSound SWF 帧 16/33/50/66，与 addFrameScript stop@17/34/51/67 交叉实证；r5 段无音）→ sound-pack banner 段 `bannerNum1..4`；触发锚 = mc_043 帧脚本第二次 `nummc.gotoAndPlay("r"+round)`（SWF 帧 28 = 资产帧 18，恰为批次 67 弹入窗口起点，首次调用被其重置）+ 段内偏移（r1..r3 标签+6 / r4 段短 1 帧标签+5）→ 资产帧 24/23 → hold 46/44（round 1..4 各报其号；round≥5 start_final 段无数字语音）。

**start_final 段与结算字样段**（多局制渲染收编 2026-11-21，原版 FightUI.as:288 / renderStartAndKO go 标签重定向 + playTimeOver/playDrawGame/showWinner）：① **start_final** = mc_043 XFL 0 基 94..138 独立烘焙 45 帧（`startko-final`），运行时 round≥5 分支换用——`go:fight` 标签（帧 139）`gotoAndStop("fight")` 重定向语义 → f≥45 切回 `startko` fight 段复用，总 79 帧与 start 路径等长（core INTRO_START_TICKS 不变）；居中 delta 取稳态帧实测**固定值 −21**——段内逐字弹入 bbox 中心阶梯跳变（196→114.5→−21），逐帧居中会抖，偏离登记 ⑤（原版原地弹出语义）。② **结算段**：`startko-timeover` 44 帧 / `startko-drawgame` 43 帧（段尾帧脚本 stop+COMPLETE 实证定帧数，摆放 ui_fight.endKO@(13,103)）；timerOver 置位即时起播 timeover（原版 playTimeOver 无延迟无 KO 表现链），非平局在 winner 字样起播时被替换（原版 showWinner 覆写同画布）、平局续播 drawgame 定格段尾至重开（原版 playDrawGame）；KO 字样段在 timerOver 时封禁（原版 timeover 无 hit_end 链）。③ **结算音**：bannerTimeover（帧 221）/ bannerDraw（帧 267）= HUD 字样段**显示沿** `onBanner` 回调触发——core 不持表现段帧数常量，音随快照显示沿双端同拍触发、不入状态哈希（bannerFinal 走 core 事件如上）。

**对局 HUD**（切片 30，原版 fight.swf FightStage HUD 全装配；批次 36 追补）：屏幕空间层（`FightHud`，相机变换之外），设计空间 800×600 按 `fitZoom=min(viewW/1000,viewH/600)` 等比，**逐元素钉边**——P1 血条/大脸钉左视口边、P2 钉右（原版 root scrollRect 800 宽，宽屏下两角分离）、计时板居中、气条/READY/辅助格钉底；**宽屏血条延伸**（批次 36 偏离登记）：原版 800 宽下血条外缘恰搭进计时板近缘 ~9px，逐元素钉边后计时板随中线外移、与血条间出现空隙 → 血条单元横向拉伸每侧补 (visW−800)/2，原版位形 scale 恒 1、重叠量原样保留（槽/装饰/填充为横向线条纹理，拉伸不可感知，与切人横幅拉伸 / bgFixed cover 同款适配）；**宽屏能量条延伸**（批次 37 附）：同款空隙（原版 energy 右缘搭进计时板左缘 ~12px）→ bg 三段式切片（端盖 12px 固定、纯槽中段拉伸——bg 有斜盖/端块，整段拉伸拉丝）+ fill 纯条纹理随 ext 拉长，原版位形 ext=0 不动；P2 侧容器 scale.x=-1 镜像（XFL a=-1 同值），镜像内文字件（气段数/READY/能量标签）双翻转保持可读、连击数不镜像。数据 = `baked/hud.json`（ui-pack fight XFL 逆向：各件装配坐标/锚点/帧序）+ select `comicType`（能量标签帧，0=死神 SPIRITUAL/1=火影）+ 大脸 = select id+'_m'（102×64，getFighterFaceBar）+ 辅助脸 = 辅助 id 50×50（getFighterFace 缺省）。原版算法逐条收编：**红条延迟**（HURT_ING/HURT_FLYING delay=100、HURT_DOWN 首帧 90+justHurtFly 递减、lerp 0.1/0.02 两档 + 新伤害 snap，|diff|<0.01 snap）；**气条** v=qi/100 clamp 3，bar1~4 按 v>0/1/2/3 亮、ghost 幽灵步标识 v<1 显（帧随 0.6 阈值）、段数 txt 帧 int(v)+1；**fzqi 条** 原版 scrollRect+scaleY=-1 底锚翻转揭示（Pixi mask 复刻）；**能量条** scaleX=energy/100、溢出满帧粘滞、rate<0.3 每 3 渲染帧闪烁；**连击数** hit:connect 计数、>1 显示、位图数字左起 35px 步进。偏离登记：连击链 render 侧近似（hit:connect+actionState）；fadin/fadout tween 跳过改 alpha 渐显；能量闪烁 alpha 近似；fz 满点闪烁 fzqi==满 近似 isCanHurtBreak；计时板数字随多局制渲染收编（gameTime 驱动 MCNumber 两位零填充逐位 20px @(-22,-15)，训练 -1 显 ∞）。遗留：被动条 sp（PROGRESS §三）。气条顶层装饰框 picture_063 已收编（批次 36）：XFL 重建源图层标 `visible="false"` 系 FFDec 导出伪影，编译 SWF qbar_barmc(sprite 87) 渲染 191×24 实证其显示——以 shape 86 光栅化烘 `qi-frame` (191×23) 置 mc_022 最上层 @(0,-0.45)。

## 6. 联机层

联机是**游戏自己的事**：游戏自有房间服务器（Node + WebSocket），只做输入中继与房间管理，不跑模拟。每帧上行自己的 `ButtonMask`，下行全员 `(tick, ButtonMask)`；定期交换快照哈希检测失步。回放 = 输入序列 + 种子 + 数据版本戳，帧同步天然免费。2026-11-16 定案：平台不做联机（方案 A 平台中转作废），平台只提供好友邀请深链与身份凭证，游戏以平台用户 ID 为账号主键（零账号逻辑）。

**2026-11-22 定案：对局调度从 lockstep 切换到 rollback（GGPO 范式）**，协议与服务器零改动（input/hash 透传复用）。决策背景：房间服迁移 Cloudflare Workers 后，国内玩家到边缘 RTT 150~300ms，lockstep 的 `INPUT_DELAY=3`（50ms 预算）盖不住，模拟稳态速率 ≈ `60 × 50ms ÷ 单程时延` ≈ 20~35 tick/s——表现为"平滑的慢放"（用户实测十几帧体感）。机制（实现在 `packages/net/src/rollback.ts`）：

- **本地输入零延迟**：tick N 用当下按住的位图，立即生效并上行（lockstep 的 INPUT_DELAY 前瞻采样取消）；
- **远端输入未到 → 预测推进**（沿用最近收到的远端位图），模拟永不慢放；无硬预测上限（GGPO 同款——双端停步互等在 rollback 下是死锁，不可照搬 lockstep 语义），对端静默超时（5s）才冻结等待；
- **预测错误 → 回滚**：真输入到达且与该 tick 预测不符 → 恢复历史状态（`Sim.fromState`，core 预留接口）以修正输入重演至当前 tick；重演在下一步 `step()` 开跑前执行（WS 回调里不同步重入）；
- **表现层取舍（登记为已知 trade-off）**：重演段快照事件剥除——预测期已放过的音效/特效不撤回不重放（GGPO 同款）；修正快照仍喂渲染层，位置/姿态由插值收敛纠正；
- **失步检测沿用**：仅在"该 tick 双方输入全部为真实值"（无未决预测）时上行/比对哈希——预测纠正不产生假失步；迟到确认的槽位用逐 tick 保存的哈希补发；
- 测试门禁：`packages/net/test/rollback.test.ts`——近零延迟/单程 6 tick 延迟收敛到单机直跑、纠正段事件恒空、tick 交付恰一次、种子失步检测、对端静默超时冻结、真实 relay 进程端到端收敛。

架构上为 rollback 预留的三个接口（core 已按此设计）：tick 纯函数式推进、`SimState` 可序列化、输入只经 `InputFrame` 进入。LockstepClient 保留（测试与回退实现），app 对局路径已切 RollbackSession（`battle.ts`）。

房间/匹配/联机选人/地图抽取等产品形态与协议扩展的完整设计见 [netplay-design.md](netplay-design.md)。

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

## 9. 切片划分与重排理由（阶段 1~2，方法论存留）

> 阶段 1~2 各切片（1~7 已全部完成）的落地细节与完成记录在 git 提交历史；本节只保留对后续立项仍有价值的划分方法论与持久接线备忘。
>
> 2026-11-09 重排：本地双人/训练模式移出主线，进扩展项池；阶段 1 以"单机对战闭环验收"收尾，随后直接进入阶段 2 联机。理由：lockstep 联机天然给出双方输入，本地双人是最后才被需要的能力；联机是项目核心目标，尽早打通端到端。

切片序列方法论：harness（core 骨架 + 确定性单测 + replay 门禁）→ exporter → core 最小闭环 → render/app dev 页 → 联机地基（`InputSource`/`Transport`/`LockstepClient`/relay）→ 房间服务器。次序原则：门禁工具与 core 骨架同期先行（§7），联机地基先于功能扩张；公网联调与延迟调优按实测结果立项（延迟调优已以 rollback 落地，§6）。

持久接线备忘（仅记录于此）：

- `packages/net` 的 `startSession` 语义：要等 start 广播才 resolve——create/join 必须并发调用；
- app dev 联机入口：`?mode=net&role=p1|p2` 双窗口对跑；`?mode=net&action=create|join&room=&port=` 建房/加入 + 停步 5s 看门狗提示；
- 服务器错误码 `room-not-found` / `room-full` 沿用至今（netplay-design §5）。

阶段 1 当时明确不做：本地双人、rollback、第二个可操作角色、完整菜单流、街机模式、音效（事件队列留好）。本地双人进扩展项池，最后做。**街机模式 2026-11-21 定案永不做**（原版专属玩法：mission.xml 关卡 AI/FighterAICtrler 不转译，结算页 WinnerStage 已整块移除）。

