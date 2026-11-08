# BVN Web

网页联机格斗游戏——死神vs火影（BVN）的 TS 重构版，确定性帧同步联机。

## 文档导航（按阅读顺序）

| 文档 | 作用 |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | **引擎契约，写代码前必读**（硬规则、接口、事件表、门禁） |
| [DESIGN.md](DESIGN.md) | 设计文档：分层、core 详细设计、决策记录（ADR） |
| [BVN-module-map.md](BVN-module-map.md) | 原版 AS3 源码逆向结论（转译的参考规格书） |
| [BVN-online-port-plan.md](BVN-online-port-plan.md) | 立项书：路线、风险、阶段划分 |

## 红线速记（细节以契约为准）

- core 是确定性孤岛：禁随机/时钟/超越函数/DOM/网络，状态收进单个 `SimState`；
- 逻辑 60Hz、动画判定 30Hz，计时只用帧常量；
- 输入只以 ButtonMask 位图进 sim；相机不进模拟（牵引边界代替）；
- 角色差异进 JSON 数据，不进引擎分支；
- 完工门禁：build 过、确定性单测过、`tools/replay` 哈希门禁过。

## 项目定位

**重构，不是复刻。** 原版 AS3 源码是参考规格书；"原版怎么做"与"怎么做更好"冲突时选更好的，并在提交说明中写明偏离。
