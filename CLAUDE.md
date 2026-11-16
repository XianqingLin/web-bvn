# BVN Web

网页联机格斗游戏——死神vs火影（BVN）的 TS 重构版，确定性帧同步联机。

## 文档导航（按阅读顺序）

| 文档 | 作用 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | **引擎契约，写代码前必读**（硬规则、接口、事件表、门禁） |
| [docs/PROGRESS.md](docs/PROGRESS.md) | **进度台账**：开发顺序、各切片状态、遗留池与下一步 |
| [docs/DESIGN.md](docs/DESIGN.md) | 设计文档：分层、按系统的机制规格、决策理由与日期 |
| [docs/BVN-module-map.md](docs/BVN-module-map.md) | 原版 AS3 源码逆向结论（转译的参考规格书） |
| [docs/cloud-server.md](docs/cloud-server.md) | 云服务器部署手册（**本地文档，gitignore 不入库**；含服务器凭据指引，严禁提交） |

## 红线速记（细节以契约为准）

- core 是确定性孤岛：禁随机/时钟/超越函数/DOM/网络，状态收进单个 `SimState`；
- 逻辑 60Hz、动画判定 30Hz，计时只用帧常量；
- 输入只以 ButtonMask 位图进 sim；相机不进模拟（牵引边界代替）；
- 角色差异进 JSON 数据，不进引擎分支；
- 完工门禁：build 过、确定性单测过、`tools/replay` 哈希门禁过、`pnpm batch:validate` 基线门禁过。

## 项目定位

**重构，不是复刻。** 原版 AS3 源码是参考规格书；"原版怎么做"与"怎么做更好"冲突时选更好的，并在提交说明中写明偏离。

## 协作约定

- 浏览器类手工实验（带 flag 启动 Edge 目检/冒烟、CDP 连调、截图验证等）由用户人工执行，AI 不代跑——AI 执行不稳定；AI 只负责写好脚本并给出启动命令，由用户跑完回贴结果。
