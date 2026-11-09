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

1. **harness**：`packages/core` 骨架 + 确定性单测 + `tools/replay` 门禁；
2. `tools/exporter`：导出 ichigo + kon + 1 张地图的 JSON/图集；
3. core：tick 管线全覆盖（走/跳/砍/技/必杀/受击/防御/击飞/落地/推挤/牵引边界）；
4. render：帧动画、地图层、相机、基础 HUD；
5. app：本地双人 + 训练模式（无限血/时间）；
6. 验收：确定性单测过、replay 门禁过、ichigo 基础动作链对拍在容差内。

明确不做：联机、rollback、第二个角色、完整菜单流、街机模式、音效（事件队列留好）。

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

推翻旧决策：标 ~~删除线~~ 并追加新行写明替代方案与日期。
