# BVN Web

网页联机格斗游戏——死神vs火影（BVN）的 TS 重构版，确定性帧同步联机。

## 文档导航（按阅读顺序）

| 文档 | 作用 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | **引擎契约，写代码前必读**（硬规则、接口、事件表、门禁） |
| [docs/PROGRESS.md](docs/PROGRESS.md) | **进度台账**：只记未完成项；已完成内容看 git 历史 |
| [docs/DESIGN.md](docs/DESIGN.md) | 设计文档：分层、按系统的机制规格、决策理由与日期 |
| [docs/BVN-module-map.md](docs/BVN-module-map.md) | 原版 AS3 源码逆向结论（转译的参考规格书） |
| [SERVER-OPS.md](../docs/SERVER-OPS.md) | BCC / CF 基础设施操作手册（**工作区 docs/ 本地文档，不入任何仓库**，与 SSH 私钥 `../docs/cloud-server-key.pem` 同放；连接方式/服务清单/证书/发布流程/红线，严禁提交） |

## 红线速记（细节以契约为准）

- core 是确定性孤岛：禁随机/时钟/超越函数/DOM/网络，状态收进单个 `SimState`；
- 逻辑 60Hz、动画判定 30Hz，计时只用帧常量；
- 输入只以 ButtonMask 位图进 sim；相机不进模拟（牵引边界代替）；
- 角色差异进 JSON 数据，不进引擎分支；
- 完工门禁：build 过、确定性单测过、`tools/replay` 哈希门禁过、`pnpm batch:validate` 基线门禁过；
- 资产管线收尾：任何 pack 工具重跑后必须执行 `pnpm assets:finalize`（webp-convert → dedup-stream → atlas-dedup → atlas-dedup-sheets，顺序固定），漏跑会让重复 sheet 重新膨胀约 120MB；ui-pack 重跑后还须先 `tools/stream-sheet --ui` 前置 `assets:dedup-stream`（去重映射先于拼图）；`packages/data/assets/` 不入库，删除帧文件不可用 git 恢复（权威源：ui-pack 从 `tools/ui-pack/_scratch` 的 FFDec 导出重烘，或线上 R2 回拉）。

## 项目定位

**重构，不是复刻。** 原版 AS3 源码是参考规格书；"原版怎么做"与"怎么做更好"冲突时选更好的，并在提交说明中写明偏离。

## 协作约定

- **AI 优先自助**：除"效果好不好看/手感对不对"这类必须人眼或真人判断的环节（特效、动画、视觉目检、对战手感等）交由用户外，其余验证——启动 dev/带 flag 的浏览器、CDP 连调、抓 console 与日志、截图、跑脚本、SSH 只读检查、构建与各项门禁——AI 能做的就自己做，不再只写命令等用户代跑。交给用户时须给出明确命令与观察/判断要点，用户回贴结果后 AI 继续。

## 注释纪律
- 注释只服务于理解代码本身——写机制、意图、约束与坑，不写协作过程。切片编号、“以下是XX切片的内容”这类进度/归属标记一律不进代码（归属看 git 历史，进度看 PROGRESS.md，“为什么”看 DESIGN.md）。文件头的“原版对位/偏离登记”是行为规格的一部分，保留；但同样只描述机制与偏离内容，不带切片号与日期流水。
