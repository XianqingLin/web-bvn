# BVN Web —— 进度台账（PROGRESS）

> **唯一的进度记录**：开发顺序、各切片状态、遗留池与下一步。
> 切片收尾只改本文件；立项书与 DESIGN 不再追加进度段。
> 设计细节与偏离记录见 [DESIGN.md](DESIGN.md) §3.5/§9；决策见 §10 ADR；硬规则见 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 一、路线总览

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 逆向梳理（模块地图） | ✅ |
| 1 | POC：单机对战闭环 + 训练模式 | ✅（切片 1~5） |
| 2 | 联机：lockstep + 房间服务器 | ✅（切片 6~7；云上真机验证待做） |
| 3 | 批量化：全角色机制 + 验收门禁 | ✅ 主线（切片 8~11）；尾巴见遗留池 |
| 4 | 体验完善：rollback/观战/录像/菜单流等 | 🔄（切片 15 ✅；余断线/录像/观战/rollback/街机/音效/本地双人） |

门禁速记（每次收尾全过才算完成）：`pnpm build` + 确定性单测 + `tools/replay` 五剧本哈希（含 assist-duel）+ `pnpm batch:validate`（58 角色 + 37 辅助，基线 `tools/batch-validate/baseline.json`）。行为有意变更 → 重冻全部基线并在提交说明写明。

---

## 二、切片明细

| 切片 | 内容 | 状态 | 详情 |
|---|---|---|---|
| 0 | 逆向梳理：BVN-module-map（183 文件 / 28k 行本体 / 61 角色 / 37 辅助 / 15 地图） | ✅ | [BVN-module-map.md](BVN-module-map.md) |
| 1 | harness：core 骨架 + 确定性单测 + `tools/replay` 哈希门禁 | ✅ | DESIGN §9 |
| 2 | 导出/数据管线：dump 桥 + runtime-ingest；fighters-runtime 58 包 + assistants-runtime 37 包（115,279 判定区帧，与 XFL 交叉验证零漂移）+ 地图 JSON 15 份 | ✅ | 遗留：orihime/yachiru 运行时 actions 空，XFL 兜底 |
| 3 | core 最小闭环：7 态状态机 + 判定区 + 命中结算 + 推挤 + 地图接线 + behaviors op 注册表 POC | ✅ | DESIGN §3.5 |
| 4 | 图集管线（ADR-13：AIR capture 桥逐帧栅格化，166k 引用 → 46k 唯一帧）+ render BattleRenderer + app dev 预览页 | ✅ | DESIGN §4 |
| 5 | **阶段 1 收尾**：防御/瞬步/技/必杀/能量/连段槽 + 相机 clamp/floor 遮挡/HUD + 训练模式（单测 40，四剧本） | ✅ | DESIGN §3.5/§9 |
| 6 | 联机地基：`InputSource` 抽象 + `packages/net` lockstep（ADR-14）+ 最小中继 + ws e2e（单测 78） | ✅ | DESIGN §9.7 |
| 7 | **阶段 2 收尾**：房间服务器 `room-server.mjs`（ADR-15）+ `startSession` + app create/join 入口（单测 80，net 7） | ✅ | 云部署要点见立项书 §四.4 注 |
| 8 | fire 飞行道具原语 + 行为 op 词表 Tier-1 | ✅ | DESIGN §3.5 |
| 9 | 目标系/摔技/独立道具/万解/AIR 槽/近战回气资源 | ✅ | DESIGN §3.5 |
| 10 | 逐区命中/跳跃家族/瞬身步家族/万解形态切换（词表 Tier-2 收尾） | ✅ | DESIGN §3.5 |
| 11 | 全角色批量化验收（`tools/batch-validate`）+ 条件触发器（cond/then/else 重大语义修复） | ✅ | DESIGN §3.5 |
| 12 | 辅助系统：fzqi/召唤流程 + Assister 实体（时间轴/物理/op 词表/loop 触发器）+ buff 结算（speedUp/attackUp/defenseUp/buffEffects）+ 验收门禁扩展 | ✅ | DESIGN §3.5；`teleport` 不移植（ADR 记录） |
| 14 | 场景流转骨架：AppHost 子系统宿主 + SceneHost + 菜单/选人/战斗/结算场景 + 联机 pick 选人交换 + `tools/select-pack`（select.json 53 角色/40 辅助/15 地图） | ✅ | 下详（切片 13 中顺带关闭"联机辅助注入"） |
| 15 | 选人页原版化：`tools/ui-pack`（FFDec 按元件导出 face 266 张 + select 壳 9 元件 + 地图缩略图 16 张 → assets/ui/ + baked/ui.json）+ SetupScene 原版布局换肤 | ✅ | §3.3 切片 15 |

---

## 三、剩余工作规划（未完成部分）

> 本节与切片明细表同粒度：已完成见 §二，未完成的执行规划见本节。排期可按实际开工时调整，调整时改本表。

### 3.1 联机收尾线（阶段 2 的真机验收条件）

| 项 | 内容 | 验收 |
|---|---|---|
| 云服务器部署 | ✅（2026-11-11）：Node 22 + `/opt/bvn/` + systemd `bvn-room.service`（PORT=8787，开机自启）+ nginx 443 wss 反代（自签证书，真实证书待域名接入）。服务器信息与部署现状见本地 `docs/cloud-server.md`（gitignore，不入库；密钥为仓库根 `cloud-server-key.pem`） | wss 冒烟全流程通过（create/join/start/input 中继/peer-lost）；relaport 站点回归 200 零 ERROR |
| 真机体验验证 | 公网两端完整对局人工验收（两端浏览器先访问 `https://120.48.185.202/` 接受自签证书例外；入口 `?mode=net&action=create&server=wss://120.48.185.202/`） | 对局可打完；哈希失步零发生 |
| 延迟调优立项 | 视云上结果：输入延迟帧自适应（现为固定 INPUT_DELAY=3）、抖动缓冲 | 云上手感不可接受时才立项；rollback 升级与否据此决策（接口已预留：tick 纯函数 / SimState 可序列化 / 输入只经 InputFrame） |

### 3.2 阶段 3 尾巴（纯增量特性，不阻塞阶段 4 立项）

**切片 13——演出/数据审计收紧**：

- ✅ **13-A1 辅助图集 capture 补齐**（commit 42b4078）：capture 桥辅助路径改连续全时间轴扫描，37 辅助包全量栅格化；
- ✅ **13-A2 地图层装配对齐原版**（commit 6764029）：bottomOffset 下移 / bg 屏幕固定 cover / front 层 0.1 视差（镜像 MapMain.render）；
- ✅ **13-A3 bullet 精灵图集接入 + 命中残留收紧**（2026-11-11）：capture 桥新增 fire 采集（175 元件全命中，含 byakuya 辅助 atmmc 运行时挂载——fake 控制器补 AssisterCtrler API 后帧脚本可跑通）；atlas-pack fire 模式双路输出（`assets/fires/<ownerKind>/` 图集 bvn/fire-atlas@1 + `baked/fires/` 元数据 bvn/fire@1）；core Bullet 增 animTotal/animFrame/animLabels/hitAnim（30Hz stepBulletAnim 标签分派：loop/remove/hit_over/timeout/播尽 off-by-one quirk 原样保留；killBullet 命中残留段=停移动播尽移除）；render bullet 精灵替换色块（容器锚=RectUtils.apply 逆运算，scale.x=facing，无图集条目回退色块）。**偏离记录**：bullet 命中矩形沿用 spawn 帧 atm 判定区（原版用元件帧1视觉 bounds；61% 元件两者一致，46 项大偏差为 atm 手调平衡数据如万解斩月 267×265，切换需改平衡+重冻基线，暂不切）。基线哈希不变（5 剧本无远程弹；新增 6 条生命周期单测覆盖）；
- 独立道具寿命/矩形占位占位收紧（原版由道具内层时间轴驱动，未导出）；独立道具（attackers）渲染端未接线（快照有数据、画面不可见；元件名清单已随 13-A3 fire 采集覆盖）；
- rawScript 抑制段逐条审计（角色 224 处已审 4 处 gaara `getAttacker`，行为无差；辅助残留 11 处：byakuya×6/itachi hitModel/suigetsu isAttacking/temari 弹速×3）；
- 辅助未注册 op（切片 12 遗留，全在 attacker 系）：getTargetSP/setHitTarget/addAttacker/justHit/setTouchSide/removeCustomFunc/addCustomFunc(temari)，均确定性静默；
- ~~联机模式辅助注入（app net 分支需两端配置指纹同步）~~ ✅（随切片 14 关闭：pick 交换把双端选人带进 configHash，assisters 按选人装配）；
- 验收：门禁全过；行为变更则重冻全部基线。

### 3.2b 切片 14——场景流转骨架（已完成，2026-11-11）

- **app 层基建**：`AppHost` 子系统宿主（events/assets/config/time + 拓扑 init，契约"app 层子系统接口"最小实现）；`SceneHost` 场景系统（1000×600 逻辑屏等比缩放居中，switchTo 异步流转）；`data.ts` baked 装载（assets 缓存）；`ui.ts` 基础控件（按钮/面板/DOM 输入）；`flow.ts` 对局流参数（mode/serverUrl/选人/地图）；
- **场景**：menu（单机/联机入口）→ setup（三段选人：角色→辅助→地图，数据驱动 `baked/select.json`）→ battle（自 main.ts 迁移；solo 训练 / net lockstep）→ KO 结算浮层（solo 可再来一局）；
- **联机选人交换**：protocol 新增 `pick` 消息（服务器像 input/hash 一样盲透传）；session.ts 拆 `joinRoom/sendPick/waitPeerPick/lockstart`（startSession 组合保留兼容）；pick 3s 重发兜底；地图以 P1 选择为准；双端异角色异辅助（render `fireAtlases` 改按出场者 atlasId 键控）；
- **tools/select-pack**：select.xml/fighter.xml/assistant.xml/map.xml → `baked/select.json`（schema bvn/select@1，53 角色/40 辅助/15 地图，含 offset/more/comicType）；
- **偏离记录**：① 联机禁用随机选人项（两端各自本地解析会选人分叉，需服务器裁决才可开）；② 原版 more= 形态切换未实现（数据已保留在 select.json）；③ 结算基于 `fighter:ko` 事件浮层，完整回合制（R1/R2 计分）归后续切片；④ 重开局仅 solo；
- **UI 待打磨池**：格子长名溢出、DOM 输入样式、Logo 演出/选人动画；
- **验收**：门禁全过（build / 137 测试 / replay 5 剧本 / batch:validate）；Playwright 驱动 菜单→选角色→选辅助→选地图→战斗 全链路截图验证（发现并修复 battle 迁移漏调 `renderer.onSnapshot`）。

### 3.3 阶段 4 体验完善（粒度先按块，开工前细化成切片）

**切片 15——选人页原版化（✅ 完成，2026-11-11）**：

- **tools/ui-pack**：FFDec CLI 按元件导出（主时间轴为空，`-export image`/`-export sprite`）→ `assets/ui/faces/`（266 张，导出名 `<symbolId>_<类名>.<ext>` 剥前缀还原类名）、`assets/ui/select/`（stg_select 背景 / slt_item 格框 / cursor_p1|p2 / selected_p1|p2 / select_map / select_map_kuang / select_map_txt 9 元件）、`assets/ui/maps/`（15 地图 + random 现成 PNG）；产出 `baked/ui.json`（schema bvn/ui@1：类名→文件映射 + 元件表 + 原版布局常量 + 注册点偏移）；
- **SetupScene 换肤（规格全部照原版 SelectFighterStage/SelecterItemUI/SelectedFighterGroup/MapSelectUI 反编译源）**：原版 800×600 舞台在 1000×600 逻辑屏居中（OX=100）；头像格 slt_item 60×60、50×50 头像垫底框叠加、起点 (15,100)、列距 80、行距 (600-50-100-10)/(行数-1)、offset 微调（select.json row/col/offset 即原版数据直接用）；光标 P1 蓝/P2 粉 hover 跟随（PNG 原点 = 格子位 + (-18,-26)）；已选展示框底部两角（大头像 245×62 + 名字，P2 内容容器镜像 scale.x=-1 原版摆法）；more= 项格框黄 tint（近似原版 GlowFilter）；地图选择 = 原版轮盘（select_map 面板 + 左右箭头热区 + 450×240 缩略图 + kuang 框叠顶 + 名牌，点缩略图即确认）；
- **app 接线**：data.ts `loadUi`/`uiFaceUrl`；main.ts dev 直通 `?mode=setup`（只开选人页目检用）；
- **偏离记录**：① 光标/kuang 用静态帧（原版 13 帧确认动画、kuang 60 帧流光未做）；② 名字/地图名用系统字体 Text 替代原版 BitmapText；③ 保留顶部"确认/上一步"按钮（原版无，底部被展示框占用上移至右上）；④ more= 形态切换交互未实现（黄框提示，切片 14 偏离沿用）；⑤ select_map PNG 画布原点 = bounds 左上（mc 原点在 PNG 内约 (78,0)），挂载时补偿；
- **不做**（留后续）：格子呼吸动画、血条头像接 HUD、胜利立绘接结算、title.swf 主菜单；
- **验收**：门禁全过（build / 137 测试 / replay 5 剧本 / batch:validate）；Playwright 驱动 选角色→选辅助→地图轮盘翻页→确认→战斗 全链路截图目检（光标/展示框/轮盘/背景均原版件）。

| # | 块 | 内容 | 备注 |
|---|---|---|---|
| 1 | 断线处理 | peer-lost 后判负/重连（现为冻结等待） | ADR-15 预留 |
| 2 | 录像回放 | 输入序列 + 种子 + 数据版本戳的存储与播放 UI | 帧同步免费送，core 无需改 |
| 3 | 观战 | 只收不发输入的观战客户端 | net 层扩展 |
| 4 | rollback | 可选；视云上延迟体验决策 | 架构接口已预留（DESIGN §6） |
| 5 | 菜单流 | ✅ 骨架已由切片 14 完成；✅ 选人页原版化（切片 15）；余 Logo 演出/格子动画/结算立绘打磨 | app 层场景系统 |
| 6 | 街机模式 | mission.xml 关卡数据 + AI（FighterAICtrler 转译，~700 行，种子随机） | AI 是 PvP 路径外的唯一大块逻辑 |
| 7 | 音效/特效接线 | 音源从 embed SWF 提取 + 表现事件消费完善（事件队列已留好）；effect.swf 已定位 | 音效随机选音源在渲染层做，不进 sim |
| 8 | 本地双人 | 第二本地输入源 | 扩展项池，主线收尾后最后做 |

---

## 四、下一步（按优先级）

1. **真机体验验证**（§3.1）——云服务器已部署（wss 冒烟通过）+ 切片 14/15 菜单/联机/选人 UI 已通，公网两端完整对局人工验收条件已齐（入口 `?mode=net&action=create&server=wss://120.48.185.202/`，页面上点选即可）；
2. **切片 13 演出/审计收紧**（§3.2 余项）——或按用户指示切换其他块；
3. 阶段 4 各块按上表顺序推进，每块开工前细化为切片并登记进 §二 明细表。
