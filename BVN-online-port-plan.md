# 死神VS火影（BVN）网页版 + 在线多人联机 —— 项目立项与移植方案

> 本文档为项目立项书（路线、风险、阶段划分）。
> 撰写日期：2026-11-08。
>
> **项目文档导航**：写代码规范见 [ARCHITECTURE.md](ARCHITECTURE.md)（引擎契约）；架构设计见 [DESIGN.md](DESIGN.md)；原版逆向结论见 [BVN-module-map.md](BVN-module-map.md)；入口见 [CLAUDE.md](CLAUDE.md)。
>
> **当前进度**（2026-11-09）：阶段 0 ✅；阶段 1 切片 1（harness）✅；切片 2 ✅（提取 + 导出桥 + 转译入库，fighters-runtime 58 包 + assistants-runtime 37 包 + maps 15 包，115,279 判定区帧，与 XFL 交叉验证零漂移；遗留：orihime/yachiru 运行时 actions 为空 #1009，XFL 兜底）。**切片 3 ✅**——① 数据修复 ✅（dump 桥 floors bug 修复 + ingest 确定性加固）；② 地图接线 ✅（`compileMapStage` + core 多段地板化 + 原版重力斜坡模型）；③ 状态机动作切换 ✅（`core/fighter/{def,machine,behaviors}`：FighterActionState 子集 7 态最小闭环——站立/走/跳/砍/受击/击飞/倒地/死亡；动画标签驱动 `actLabel`+`animFrame` 30Hz 推进，循环标签回绕、收招 `endAction`；跳跃核对原版 `jump()`+`num_wake` 双向线性衰减 + `applayG` 上升段清零）；④ 判定区接线 ✅（`compileFighterRuntime`：runtime dump 几何 + XFL 形态数值/帧触发合并编译；`def.areas[animFrame]` 查表 → 脚底锚点 + 朝向镜像世界 AABB；命中 = atm ∩ bdmn，doHurt 子集结算——hitx×攻击者朝向/空中 hity 补偿/hurtType 0-1 分流/hurtTime ms→30Hz 帧+3 偏移/钢身/一击一目标/DEAD+ko）；⑤ behaviors 插件目录 ✅（op 注册表 + POC 词表子集：move 系/damping 系/setSteelBody/addQi/音效特效事件/endAct，未注册 op 确定性静默）；推挤 ✅（body AABB 按 heavy 比例分离）。新增 replay 剧本 ichigo-duel（真实 ichigo 定义对战，3 次命中 + 帧触发音效事件验证）。基线全部重固化（SimState 扩展字段致哈希全变，见 ADR-11/12 与 DESIGN §3.5 偏离清单）。门禁全过（build + 确定性单测 28+ + 三剧本哈希）。**切片 4 ✅**——① 图集管线定案并落地（ADR-13）：`tools/atlas-capture` AIR capture 桥逐标签镜像引擎驱动语义栅格化（关键发现：姿势美术在子剪辑自身时间轴，引擎 `renderChildren` 逐 tick 推进，单纯 gotoAndStop 截不到姿势；修复后唯一帧 11.5k→46k）+ 手写 AS3 PNG 编码 + 像素哈希去重；`tools/atlas-pack` shelf 装包 2048² sheet（58 角色 + 37 辅助 + 15 地图，166k 帧引用→46k 唯一帧）；② `packages/data` 图集类型与校验器（bvn/atlas@1、bvn/map-atlas@1）+ Node 加载器；③ `packages/render` BattleRenderer（快照插值渲染、朝向翻转绕 root 原点、`forms[formIndex].frames[animFrame-1]` 查表帧动画、相机指数平滑、HUD 血条/气条、hit:connect 闪红表现事件消费）；④ `packages/app` dev 预览页（键盘→ButtonMask→60Hz tick→快照喂渲染）。预览页视觉验证：地图三层、双角色站立动画、朝向镜像、HUD 全部正确渲染。遗留（后续切片）：相机 clamp 接 baked 地图边界、地图前景层遮挡关系（floor 层应在角色前）、HUD 文本、音效/特效消费。门禁全过（build + 确定性单测 28+ + 三剧本哈希）。**切片 5 ✅**——① core 动作补全 ✅：防御（按住 ↓，DEFENCE_ING；削血 5% + 能量损耗 min(50,power/5)；能量不足 → 破防 HURT_ING 42 tick + 额外削血 power/10；背刺 checkDefDirect；防御分支出手清单照原版 setDefenseAction 槽子集）、瞬步（能量 20 可透支 + 过载慢回，DASH_ING 不可被命中）、技/必杀（attack/skill/superSkill 槽位分流：砍技/招 N/必杀系，气门槛 100/300；SKILL_ING/BISHA_ING/BISHA_SUPER_ING）、能量系统（上限 100，普回/攻击/防御/过载四档回充率 + 24 tick 花费冷却）、连段槽（帧触发 setAttack 改写动作槽 + `_CHK` 相邻标签续播）、动作映射修正（切片 3 的 kj1→跳砍 系误读，定案 kjN→砍技N/tk→跳砍，见 module-map §6.2）；新增 ButtonMask 位 skill/superSkill/assist；② render/app 遗留清零 ✅：相机按舞台边界 clamp + 垂直锚地面、地图 floor 前景层遮挡（层序 bg/map<角色<floor<特效）、HUD 回合文本 Pixi Text、dev 页按键表更新（J攻击 K跳 L瞬步 U技 I必杀）+ 操作提示；③ 训练模式 ✅：`SimConfig.training`（P2 假人不输入、受击血保 1 不 KO、恒定回血、R 键重置）；④ 战斗机制单测 ✅（combat.test.ts 12 例：防御/背刺/破防/瞬步透支/技/必杀/连段槽/槽重填/训练模式）；新增 replay 剧本 ichigo-mechanics（防御/瞬步/技/必杀输入路径）。基线全部重固化（SimState 新增能量/槽位等字段 + 行为有意变更，偏离记录见 DESIGN §3.5）。门禁全过（build + 确定性单测 40 + 四剧本哈希）。**阶段 1 主线完成（单机对战闭环 + 训练模式）；遗留池：摔技（shN 需 moveTarget）、万解/瞬身步、空中瞬步/二段跳、ichigo 必杀飞行道具（fire 原语未实现）。切片 6（联机地基）✅——① `InputSource` 抽象 ✅（`core/inputSource` 接口 + `ScriptedInputSource` 剧本源；sim 零改动，replay 四剧本哈希不变即抽象零漂移的证明）；② `packages/net` ✅（ADR-14 lockstep 最小协议：welcome/hello/start/input/hash/peer-lost 词表；`Transport` 抽象 = loopbackPair 内存直连 + wsTransport 浏览器/node ws 双兼容；`LockstepClient` = 本地输入延迟 3 帧 + 按 tick 输入缓冲 + 60 tick 哈希失步检测 + hello 配置指纹互验）；③ `server/relay.mjs` 最小中继 ✅（分配位次、收齐 hello 广播 start、input/hash 纯透传——切片 7 房间服务器的种子形态）；④ 联调门禁 ✅（net 5 测试：loopback 双客户端 finalHash 相等且等于单机直跑、停步语义、失步检测、配置错配、真实 relay 进程 ws 端到端）；⑤ app dev 页 `?mode=net&role=p1|p2&port=` 双窗口联机入口（协议路径已被 e2e 覆盖，浏览器双窗口手感待人工验证）。修复 render test 脚本无测试文件致根 `pnpm test` 失败的遗留（--passWithNoTests）。门禁全过（build + 单测 78 + 四剧本哈希）。**切片 7（房间服务器）✅——`server/room-server.mjs`：4 位房间码 create/join 入房（错误码 room-not-found/room-full）、收齐 hello 广播 start、input/hash 按房间透传、断线 = 冻结等待 + peer-lost 通知（判负/重连归阶段 4）、无重连、房空即销毁（ADR-15）；`packages/net` 协议词表扩展入房消息 + `startSession` 会话助手（onWelcome 提前给 create 方房间码；注意：要等 start 才 resolve，create/join 须并发）；app `?mode=net&action=create|join&room=&port=`（role 参数只选键位，位次由服务器分配）+ 停步 5s 看门狗提示；切片 6 的单房间 relay.mjs 被 room-server.mjs 取代。门禁全过（build + 单测 80（net 7）+ 四剧本哈希）。房间服务器地址可配置（`?server=ws://host:port`，缺省 localhost 本机联调）——**联机目标定为云服务器公网部署**（2026-11-09 用户决策：跳过局域网联调台阶，云服务器 ≠ 局域网，是公网形态；局域网仅是立项书原定的联调中间步骤，非架构依赖）。部署要点：云上 `node room-server.mjs`（PORT 环境变量），客户端 `?server=ws://<云IP>:8787`；生产建议 nginx 反代 + wss（https 页面禁止 ws:// 明文连接）。真机云上体验待部署后人工验证。下一步：延迟体验调优视云上结果立项（输入延迟帧自适应、可选升级 rollback——归阶段 4）；主线转阶段 3 批量化。**

---

## 一、结论速览

| 决策点 | 结论 |
|---|---|
| 源码参考基底 | **OpenBleachVsNaruto（3.4 归档版）**，不用主线 3.7（Alpha、持续变动，是移动靶） |
| 技术路线 | **不在 AS3/Flash 栈上改造**，将游戏逻辑移植为 TypeScript（纯数据逻辑层），渲染用 PixiJS |
| 联机方案 | **确定性帧同步（lockstep，后续可升级 rollback/GGPO 式）**，WebSocket 传输，只同步输入不同步状态 |
| 素材来源 | 官方 BleachVsNaruto_TagAssets / 社区 assets_lib，SWF→spritesheet 工具化导出 |
| 第一步 | AI 梳理 OpenBVN 的"逻辑层模块地图"（区分逻辑 / 渲染 / 资源三层） |

## 二、GitHub 仓库清单（已核实存在）

### 官方组织：[5DPLAY-Game-Studio](https://github.com/5DPLAY-Game-Studio)

| 仓库 | 用途 | 对本项目的价值 |
|---|---|---|
| [OpenBleachVsNaruto](https://github.com/5DPLAY-Game-Studio/OpenBleachVsNaruto) | **3.4 调试版全量源码，已归档（不再更新）**，GPL-3.0 | ★★★ 移植底稿（静止、内容完整） |
| [BleachVsNaruto](https://github.com/5DPLAY-Game-Studio/BleachVsNaruto) | 主线 3.7，Alpha，仍在活跃开发 | ★☆☆ 仅作参考，不做基底 |
| [BleachVsNaruto_TagAssets](https://github.com/5DPLAY-Game-Studio/BleachVsNaruto_TagAssets) | 官方素材库 | ★★★ 素材提取 |
| [BleachVsNaruto_FlashSrc](https://github.com/5DPLAY-Game-Studio/BleachVsNaruto_FlashSrc) | FLA/XFL Flash 源文件 | ★★☆ 素材/帧动画提取 |
| [BleachVsNaruto_FlexSDK](https://github.com/5DPLAY-Game-Studio/BleachVsNaruto_FlexSDK) | 编译用 Flex SDK 配置 | ★☆☆（我们不编译 AS3） |
| LIB_KyoLib / LIB_Other / CLIB_Shared | 引擎类库 | ★★☆ 转译时参考 |

### 社区参考项目

- [lcx03876-hue/bvn-ai-public](https://github.com/lcx03876-hue/bvn-ai-public) —— 给 BVN 做游戏 AI：**注入 ActionScript 状态桥**读取游戏内部状态 + 模仿学习/强化学习。它对 BVN 内部结构（状态、输入、帧循环）的逆向成果对本项目极有价值。★★★
- [qiulinfan/bleach-vs-naruto-pocket](https://github.com/qiulinfan/bleach-vs-naruto-pocket) —— Lua 口袋版移植（GPL-3.0，素材从官方仓库转换），展示了"脱离 Flash 复刻逻辑"的可行先例。★★
- [wuxiongbin123/Bleach-VS-Naruto-by-olcPixelGameEngine](https://github.com/wuxiongbin123/Bleach-VS-Naruto-by-olcPixelGameEngine) —— C++ 仿制。★
- [1q2w3e4rrr-coder/pvp-Pixel-Fighting](https://github.com/1q2w3e4rrr-coder/pvp-Pixel-Fighting) —— Godot 复现尝试。★
- [Brx86/BVN2.6](https://github.com/Brx86/BVN2.6) —— 可网页运行的 2.6 打包。★

## 三、为什么不能在 AS3/Flash 栈上直接做（重要，防止走回头路）

1. **浏览器已不运行 Flash**。网页跑 SWF 只能靠 Ruffle（WASM 模拟器），BVN 重度 AS3，Ruffle 的 AS3 兼容性不完整。
2. **Ruffle 沙盒没有网络**。AS3 的 `flash.net.Socket` 在 Ruffle 中基本未实现——在 SWF 内部写联机逻辑是死路。
3. **AS3 工具链已死**。OpenBVN 构建要求 Flash Builder 4.7 + Adobe Flash Professional CC 2015（已停售），AI 改完代码无法自动构建验证。

## 四、推荐架构

```
OpenBVN 3.4 源码 (AS3)
        │  AI 逐文件转译（AS3 与 TS 同源 ECMAScript，转译准确率高）
        ▼
TypeScript 逻辑层（纯数据、无渲染、固定时间步长、确定性）
        │
        ├──▶ 渲染层：PixiJS（spritesheet + 帧动画数据 JSON）
        └──▶ 联机层：WebSocket 帧同步
                 │  （每端本地模拟全部逻辑，只交换输入；后续可升级 rollback 掩盖延迟）
                 ▼
             Node.js 房间服务器（匹配、房间、输入中继）
```

### 联机方案要点

- BVN 本身是 `ENTER_FRAME` 固定帧率驱动的格斗游戏，天然适合**确定性帧同步**：同步内容只有每帧的按键输入（几个字节）。
- 帧同步的前提是两端每帧算出**完全一致**的结果，因此逻辑层必须满足：
  - **禁止** `Math.random()` → 换成自实现种子随机（如 PCG/xorshift）；
  - **禁止** `Math.sin/cos/sqrt` 等超越函数直接进逻辑（跨引擎结果可能不同）→ 用查找表或定点数；JS 纯算术（+ - * /）是 IEEE 754 双精度，跨端一致，可放心用；
  - 固定逻辑帧率（BVN 原版帧率需从源码确认，Flash 游戏常见 24/30fps），渲染帧率与逻辑帧率解耦（插值）。
- 传输：先用 WebSocket（TCP，简单可靠）；若延迟体验差，再考虑 geckos.io（UDP over WebRTC）或 rollback（输入延迟 2~3 帧 + 预测回滚）。

### 素材管线

1. 从 FLA/SWF 导出位图与动作序列 → spritesheet + 帧元数据（JSON：帧号、锚点、hitbox、音效触发帧）。
2. 官方 TagAssets 仓库与社区 [assets_lib](https://github.com/qxyk99/assets_lib) 有现成整理。
3. OpenBVN 源码里 `f_fighter`（人物逻辑）、`map`（地图）、`assets`/`embed`（素材源文件）是主要输入。

## 五、关键风险

| 风险 | 应对 |
|---|---|
| AS3 逻辑与 Flash 显示列表深度耦合 | 转译时强制分层：逻辑层不得引用任何 DisplayObject；先转译纯逻辑类，渲染类重写而非转译 |
| 确定性被隐性破坏（如依赖 AS3 的 `Number` 精度行为、`Vector` 遍历顺序） | headless 单测：同一输入序列跑 N 帧，比对两份实现的逐帧状态哈希 |
| 素材提取工作量 | 先用 1 人物 + 1 地图打通全链路，再批量化 |
| GPL-3.0 传染性 | 项目需同样 GPL-3.0 开源；素材版权归 5DPLAY，仅限非商业同人用途 |
| 联机延迟体验 | 先 lockstep 跑通；格斗游戏最终形态是 rollback，架构上把"输入产生"与"状态推进"解耦留好接口 |

## 六、推进路线图

1. **阶段 0：逆向梳理**（新会话从这开始）
   - Clone OpenBleachVsNaruto，重点读 `swf_source/#FighterTester`（主程序工程）
   - 让 AI 产出《模块地图》文档：逻辑层 / 渲染层 / 资源层分类，标注核心类、帧循环入口、输入处理、角色数据结构
   - 确认原版逻辑帧率、输入映射
2. **阶段 1：POC（单机）**
   - Vite + TypeScript + PixiJS 骨架
   - 转译：游戏主循环 + 1 个角色 + 1 张地图
   - core 动作补全 + render/app 体验收尾 + 对拍验收（切片 5 收尾）
   - *（2026-11-09 调整：原"本地双人可玩"移出阶段 1 进扩展项池最后做；训练模式保留，以 P2 假人形式进切片 5；阶段 1 以单机对战闭环验收收尾，直接进入联机）*
3. **阶段 2：联机**
   - 帧同步框架（同机镜像两个客户端进程联调 → 局域网 → 公网）
   - Node.js 房间服务器：创建/加入房间、输入中继、断线处理
4. **阶段 3：批量化**
   - AI 批量转译全部角色/地图，逐个用"状态哈希对拍"验证与 AS3 行为一致
   - 素材批量导出管线
   - *（2026-11-09 进度：数据转译/图集已在阶段 1 前置完成——58 角色/37 辅助/15 地图运行时包 + 46k 唯一帧图集；当前切片 8 已落地 fire 飞行道具 + 行为 op 词表 Tier-1，见 DESIGN §3.5；切片 9 待做：目标系 op（摔技/抓取）、独立道具 addAttacker、万解、近战回气资源系统）*
5. **阶段 4：体验完善**
   - rollback、观战、录像回放（帧同步天然免费送录像回放——只需存输入序列）
   - 扩展项池（主线收尾后按需取用）：本地双人、完整菜单流、街机模式、音效接线

## 七、新会话开工指引

```
1. 先读 CLAUDE.md 与 ARCHITECTURE.md（契约），再按任务需要读
   DESIGN.md（设计）与 BVN-module-map.md（原版逆向）。
2. 原版参考仓库已克隆在仓库根（只读，gitignore，构建产物禁止依赖）：
   OpenBleachVsNaruto/（移植底稿）、bvn-ai-public/（逆向参考）。
3. 当前任务：阶段 3 批量化（切片 8 已完，切片 9 起按 DESIGN §3.5 待补清单推进），
   阶段 1/2 已收尾（单机对战闭环 + lockstep/房间服务器）。
```
