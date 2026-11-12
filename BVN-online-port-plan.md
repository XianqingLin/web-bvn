# 死神VS火影（BVN）网页版 + 在线多人联机 —— 项目立项与移植方案

> 本文档为项目立项书（路线、风险、阶段划分）。
> 撰写日期：2026-11-08。
>
> **项目文档导航**：写代码规范见 [ARCHITECTURE.md](ARCHITECTURE.md)（引擎契约）；进度与下一步见 [PROGRESS.md](PROGRESS.md)（进度台账，唯一进度记录）；架构设计见 [DESIGN.md](DESIGN.md)；原版逆向结论见 [BVN-module-map.md](BVN-module-map.md)；入口见 [CLAUDE.md](CLAUDE.md)。
>
> **当前进度**（2026-11-12）：阶段 0~3 ✅（切片 1~12；云服务器已部署、wss 冒烟通过，真机验收待人工）；阶段 4 进行中（切片 14/15/16 + 修复批次 17~20 ✅）。各切片状态与剩余工作见 PROGRESS.md；切片实现细节与偏离记录见 DESIGN §3.5/§9 与 PROGRESS §三。
>
> **联机目标定为云服务器公网部署**（2026-11-09 用户决策：跳过局域网联调台阶——云服务器 ≠ 局域网，是公网形态；局域网仅是本立项书原定的联调中间步骤，非架构依赖）。部署要点：云上 `node room-server.mjs`（PORT 环境变量），客户端 `?server=ws://<云IP>:8787`；生产建议 nginx 反代 + wss（https 页面禁止 ws:// 明文连接）。真机云上体验待部署后人工验证，延迟体验调优视结果立项（输入延迟帧自适应、可选升级 rollback——归阶段 4）。

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
   - *（2026-11-11 ✅ 完成，含切片 8~12；实现细节与偏离记录见 DESIGN §3.5）*
5. **阶段 4：体验完善**
   - rollback、观战、录像回放（帧同步天然免费送录像回放——只需存输入序列）
   - 扩展项池（主线收尾后按需取用）：本地双人、街机模式、音效接线
   - *（进行中，2026-11-12：切片 14~16 + 修复批次 17~20 ✅；各切片状态以 PROGRESS.md 台账为准，本文件不记进度）*

## 七、新会话开工指引

```
1. 先读 CLAUDE.md 与 ARCHITECTURE.md（契约），进度与下一步看 PROGRESS.md（进度台账），
   设计背景按需读 DESIGN.md，原版逆向按需读 BVN-module-map.md。
2. 原版参考仓库已克隆在仓库根（只读，gitignore，构建产物禁止依赖）：
   OpenBleachVsNaruto/（移植底稿）、bvn-ai-public/（逆向参考）。
3. 当前任务：见 PROGRESS.md「五、下一步」（剩余工作规划在「四、剩余工作规划」）。
   行为有意变更须重冻 replay 基准与 tools/batch-validate/baseline.json。
```
