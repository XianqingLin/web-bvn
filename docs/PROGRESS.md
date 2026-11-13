# BVN Web —— 进度台账（PROGRESS）

> **唯一的进度记录**：开发顺序、各切片状态、遗留池与下一步。
> 切片收尾只改本文件；DESIGN 不再追加进度段（立项书已于 2026-11-12 删除，外部参考仓库清单移入 module-map）。
> **与 DESIGN 的分工**：本文件记状态/遗留/指针；机制规格归 DESIGN §3.5。变动默认只改一处——状态变化改这里，规格变化就地改 DESIGN 对应段，不两边同时展开细节。
> 机制规格与语义见 [DESIGN.md](DESIGN.md) §3.5（按系统组织）；决策理由就地写在 DESIGN 对应设计段；硬规则见 [ARCHITECTURE.md](ARCHITECTURE.md)。
> 本文件结构：§一 路线总览 → §二 切片明细表 → §三 已完成详情（切片/批次日志）→ §四 剩余工作规划 → §五 下一步。

---

## 一、路线总览

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 逆向梳理（模块地图） | ✅ |
| 1 | POC：单机对战闭环 + 训练模式 | ✅（切片 1~5） |
| 2 | 联机：lockstep + 房间服务器 | ✅（切片 6~7；真机验收待做，见 §4.1） |
| 3 | 批量化：全角色机制 + 验收门禁 | ✅ 主线（切片 8~12）；尾巴见 §4.2 |
| 4 | 体验完善：菜单流/原版化/实战修复等 | 🔄（切片 14/15/16 + 修复批次 17/18 ✅；余断线/录像/观战/rollback/街机/音效/本地双人/加载画面，见 §4.3） |

门禁速记（每次收尾全过才算完成）：`pnpm build` + 确定性单测 + `tools/replay` 五剧本哈希（含 assist-duel）+ `pnpm batch:validate`（58 角色 + 37 辅助，基线 `tools/batch-validate/baseline.json`）。行为有意变更 → 重冻全部基线并在提交说明写明。

---

## 二、切片明细

| 切片 | 内容 | 状态 | 详情 |
|---|---|---|---|
| 0 | 逆向梳理：BVN-module-map（183 文件 / 28k 行本体 / 61 角色 / 37 辅助 / 15 地图） | ✅ | [BVN-module-map.md](BVN-module-map.md) |
| 1 | harness：core 骨架 + 确定性单测 + `tools/replay` 哈希门禁 | ✅ | DESIGN §9 |
| 2 | 导出/数据管线：dump 桥 + runtime-ingest；fighters-runtime 58 包 + assistants-runtime 37 包（115,279 判定区帧，与 XFL 交叉验证零漂移）+ 地图 JSON 15 份 | ✅ | DESIGN §9；遗留：orihime/yachiru 运行时 actions 空，XFL 兜底 |
| 3 | core 最小闭环：7 态状态机 + 判定区 + 命中结算 + 推挤 + 地图接线 + behaviors op 注册表 POC | ✅ | DESIGN §3.5 |
| 4 | 图集管线（AIR capture 桥逐帧栅格化，166k 引用 → 46k 唯一帧）+ render BattleRenderer + app dev 预览页 | ✅ | DESIGN §4 |
| 5 | **阶段 1 收尾**：防御/瞬步/技/必杀/能量/连段槽 + 相机 clamp/floor 遮挡/HUD + 训练模式（单测 40，四剧本） | ✅ | DESIGN §3.5/§9 |
| 6 | 联机地基：`InputSource` 抽象 + `packages/net` lockstep+ 最小中继 + ws e2e（单测 78） | ✅ | DESIGN §9.7 |
| 7 | **阶段 2 收尾**：房间服务器 `room-server.mjs`+ `startSession` + app create/join 入口（单测 80，net 7） | ✅ | DESIGN §9.8；云部署要点见 §4.1 |
| 8 | fire 飞行道具原语 + 行为 op 词表 Tier-1 | ✅ | DESIGN §3.5 |
| 9 | 目标系/摔技/独立道具/万解/AIR 槽/近战回气资源 | ✅ | DESIGN §3.5 |
| 10 | 逐区命中/跳跃家族/瞬身步家族/万解形态切换（词表 Tier-2 收尾） | ✅ | DESIGN §3.5 |
| 11 | 全角色批量化验收（`tools/batch-validate`）+ 条件触发器（cond/then/else 重大语义修复） | ✅ | DESIGN §3.5 |
| 12 | 辅助系统：fzqi/召唤流程 + Assister 实体（时间轴/物理/op 词表/loop 触发器）+ buff 结算（speedUp/attackUp/defenseUp/buffEffects）+ 验收门禁扩展 | ✅ | DESIGN §3.5；`teleport` 不移植（ADR 记录） |
| 13 | 演出/数据审计收紧：A1 辅助图集 capture 补齐 / A2 地图层装配对齐原版 / A3 bullet 精灵图集接入 + 命中残留收紧 / A4 attacker 渲染接线 / A5 attacker 寿命·动画收紧（轻层） / A6 辅助 addAttacker + 命中续接 + rawScript 审计 | ✅ A1~A6 | §三·切片 13；余项见 §4.2 |
| 14 | 场景流转骨架：AppHost 子系统宿主 + SceneHost + 菜单/选人/战斗/结算场景 + 联机 pick 选人交换 + `tools/select-pack`（select.json 53 角色/40 辅助/15 地图） | ✅ | §三·切片 14；顺带关闭"联机辅助注入" |
| 15 | 选人页原版化：`tools/ui-pack`（FFDec 按元件导出 face 266 张 + select 壳 9 元件 + 地图缩略图 16 张 → assets/ui/ + baked/ui.json）+ SetupScene 原版布局换肤 | ✅ | §三·切片 15 |
| 16 | 菜单主页原版化：ui-pack 扩展（stg_title 90 帧 WebP 流帧 + mc_wzbtn 按钮件）+ MenuScene 原版化重写（开场动画/跳过 + wzbtn 阶梯按钮组 + 键盘导航） | ✅ | §三·切片 16 |
| 17 | 实战验收修复批次：相机垂直 clamp 对齐 fixBorder + endAct 原版语义（不动播放头）+ damping 持久阻尼 + 朝向按状态分流 + 连段清槽 + 防御定格 | ✅ | §三·批次 17 |
| 18 | 实战验收修复批次：跳跃/动作永久锁死（jumpTimes 无恢复路径 + 循环标签吞 endAction 补槽）+ 走/立标签维护门控 + idleLabel 落地回归 + 落地补槽 | ✅ | §三·批次 18 |
| 19 | 修复批次：重力斜坡换算偏差（下落加速比原版快 2 倍）+ 移动/跳跃参数忠实性全面审计（结论：逐字照搬、换算等价） | ✅ | §三·批次 19 |
| 20 | 实战验收修复批次：落地滑步（行走物理标签门 + labelLock 清锁）+ 必杀 1 帧桩截断（时间轴顺流，全角色家族性）+ 上+必杀/上+技被跳覆盖（意图分支待机态门）+ 防御接管速度 | ✅ | §三·批次 20 |
| 21 | 阶段 3 尾巴·B1：byakuya 抓取链 customFunc 三函数数据化 + attacker 元件脚本分派 + finishIfNoAttacker 守卫 + 辅助 loop 同标签 rewind 保活 | ✅ | §三·切片 21；余项见 §4.2 |
| 22 | 阶段 3 尾巴·B2：必杀/万解切人插图——core 冻结锁（cutinLock 全场停走/锁主 30Hz/保护性解锁）+ `tools/bisha-pack` 素材管线（71 帧横幅 + 92 张立绘）+ render 黑幕/横幅/立绘接线 | ✅ | §三·切片 22 |
| 23 | 阶段 3 尾巴·B5：独立道具逐帧命中矩形——attacker 原点锚定语义 + fires org/hits 逐帧命中数据（dump 桥扩展采集 86 元件 + `tools/b5-pack` 合并）+ madara justHit 卫语句 cond 触发器 + itachi 动态伤害 setHitPowerByTargetHpMax | ✅ | §三·切片 23 |
| 24 | 阶段 3 尾巴·B3：空中必杀 attackId——data 层补 `kbs→空中必杀` 动作 id 映射（批次 20 遗留）；顺带核实空中必杀判定/演出/道具链全角色已通，修正"纯表现无判定"误记 | ✅ | §三·切片 24 |
| 25 | 阶段 3 尾巴·B4：temari 风场——windField customFunc 数据化（LEVEL 表采样/拉扯/HURT_DOWN 门）+ 派生弹速级（stepBullets 实时求值不进 SimState）+ `buffSpeedUpByOwnerSpeed`（expr 跨期不可求值修正）+ 导出器特征识别两模板 | ✅ | §三·切片 25 |
| 26 | 阶段 4·块 7（前半）：isSuper 必杀相机聚焦 + bisha/bisha_super 光效 + 相机自适应缩放（原版 GameCamera autoZoom 收编）——bisha-pack 步骤 3b 光效导出 + render 效果逐帧播放器 + camFocus/zoomTarget 相机模型 + 横幅/立绘迁屏幕空间层（修正切片 22 world 内偏差） | ✅ | §三·切片 26 |

---

## 三、已完成详情（切片/批次摘要）

> 本节是**人话摘要 + commit 指针**：做了什么、修了什么、留了什么。实现手法看对应 commit 说明与代码注释；机制规格与固化语义看 [DESIGN.md](DESIGN.md) §3.5（按系统组织 + 机制语义备忘）；切片划分理由（阶段 1~2）见 DESIGN §9。

### 切片 13——战斗演出补齐（A1~A6，✅ 2026-11-11）

战斗画面里"原版有、我们没有"的表现全部补齐：辅助图集（A1）、地图层对位（A2）、子弹有了图和动画（A3，fire 采集 175 元件）、独立道具接入渲染——此前完全隐形（A4）、道具有了生命周期（A5，播完即消失）、辅助可召唤吸附道具（A6 前半）。A6 顺带修了一个系统性 bug：步内跳转后播放头多走一帧，吞掉落点首帧（byakuya 抓取因此永远不触发）。commits 42b4078 / 6764029 / a000727..28b70f8 / 412a02d / b898d4c / a2ae411。
- **审计产出**：辅助残留原版脚本 11 处全部分级定档，最大偏离项 byakuya 抓取链转给切片 21，其余留 §4.2。

### 切片 14——场景流转骨架（✅ 2026-11-11）

菜单 → 选人（角色/辅助/地图）→ 战斗 → 结算的场景系统跑通；联机两端选人可交换（pick 消息盲透传）。commit 3e57c26。
- **偏离**：联机禁随机选人（两端会选岔）、more= 形态切换未实现、结算浮层非完整回合制、重开局仅 solo。
- **UI 待打磨池**：格子长名溢出、DOM 输入样式、Logo 演出/选人动画。

### 切片 15——选人页原版化（✅ 2026-11-11）

建立 ui-pack 资产管线（FFDec 按元件导出 → `assets/ui/` + `baked/ui.json`），选人页用原版资产 + 原版布局规格重做。commit 1fe5de9。
- **偏离**：光标/框用静帧、文字用系统字体、保留顶部确认/上一步按钮、more= 黄框提示（交互未实现）。

### 切片 16——菜单主页原版化（✅ 2026-11-11）

主页用原版 stg_title 90 帧动画流播（WebP 帧序列 + 显存流播：常驻窗口 + 预取，不全量常驻）+ 原版阶梯按钮组（含键盘导航）。commit 1018f3a。
- **偏离**：文字用系统字体；开场淡入加速；背景帧内三枚徽标保留（烙进原版美术，去除代价大且保留更忠实）；BGM 未接（归音效块）。

### 修复批次 17——实战验收第一批（✅ 2026-11-11）

玩家实测暴露五个真 bug，全修（commit f9ce6c8）：① 相机垂直越界露背景；② endAct 语义接错导致佐助远攻永久飞天；③ 阻尼被实现成一次性乘法；④ 朝向规则不对齐原版；⑤ 连段无法派生；⑥ 防御动画循环抽搐。
- **影响深远的两条语义修正**：endAct 不动播放头、damping 是持久阻尼——已固化进 DESIGN §3.5 备忘。

### 修复批次 18——跳跃/动作永久锁死（✅ 2026-11-11）

玩家实测（佐助）：跳两次后锁跳、冲刺后锁攻击。同族根因：跳跃次数/动作槽耗尽后没有恢复路径（commit c35fa78）。
- **修复**：落地与回待机都补槽并恢复 jumpTimes；标签维护加门控（仅待机态且无锁时切标签）。4000 局模糊测试零死锁；行为变更，基线重冻。

### 修复批次 19——参数忠实性审计 + 重力修正（✅ 2026-11-12）

起因是玩家觉得"移速和跳跃调大了"。逐项对照原版源码审计结论：速度/跳跃/渲染全部没问题，**原版就是这个数值**；唯一真实偏差是下落重力步长写成 0.6（应为 0.3），已修（commit 5e5f753）。
- **教训**：当时声称"replay 零漂移"有误——含跳跃的剧本必漂移，批次 20 核对时发现。规程改为：**重冻后每个剧本单独跑 --expect，不看汇总。**

### 修复批次 20——落地滑步 + 必杀黑屏 + 上键打断（✅ 2026-11-12）

玩家实测两 bug（commit dc3efbb）：① 跳跃落地后滑步——行走物理缺标签门 + labelLock 未清；② 佩恩大招什么都看不见——必杀标签是 1 帧桩，真演出在下一个标签，"播尽即收招"把它截断了。全角色扫描确认是家族性问题（必杀→空中必杀、招1_SP→招1…），修复方案是**时间轴顺流**（播尽后满足三个条件就滑入下一标签继续播）。顺带修了缓冲的 ↑ 键打断必杀的 bug。
- **遗留转 §4.2**：必杀切人插图演出缺位（B2）；空中必杀无判定（B3）。

### 切片 21·B1——byakuya 抓取链（✅ 2026-11-12）

阶段 3 尾巴最大一笔：白哉抓取链完整落地——命中后召唤吸附道具，目标脱抓后道具播收尾段、播尽辅助退场，owner 死亡时先清道具再退场（commit e395a87）。
- **支撑机制**：辅助 customFunc 单槽（三 checkFunc 数据化）；attacker 元件脚本分派（stop 定格/gotoAndPlay/removeSelf/表现事件）；辅助 loop 同标签 rewind 保活（修复此前 loop 型辅助被"走到时间轴末自动退场"误伤）。
- **跳过项（有前置）**：itachi 动态伤害、madara miss 分支（等 B5 逐帧命中矩形）；suigetsu isAttacking（等 AI 转译）；temari 风场（B4）。

### 切片 22·B2——必杀/万解切人插图（✅ 2026-11-12）

原版 `EffectCtrler.bisha` = `GameCtrler.pause()` 全场冻结 + 黑幕 + 特写立绘，施法者画面 render 驱动继续播（帧脚本照常触发，`endBisha` 在冻结期到来）。移植版三段落地：
- **core 冻结锁**：`SimState.cutinLock { kind, id, type }` 由 `bisha`/`startWanKai` 置位、`endBisha`/`endWanKai` 清除；锁置位后下一 tick 起全场停走（输入/物理/推挤/命中/计时/道具/其他动画），仅锁主时间轴 30Hz 推进；锁主失联（收招/死亡/辅助退场）保护性解锁（防软锁，批次 18 教训——原版缺 end 系语料 = 永久黑屏软锁，有意识偏离）。事件 payload 补 `owner/ownerKind`（render 寻址立绘）。
- **素材管线**（`tools/bisha-pack`）：`bisha_face_mc`（effect.swf mc_016）71 帧流帧 + 38 包 92 张必杀立绘（kenshin 死映射跳过 → 黑幕切人）→ `baked/bisha.json`（槽位矩阵/画布原点烘焙，画布 1066×209 断言）。
- **render/app 接线**：黑幕屏幕空间层（bgFixed 与 world 之间）+ 横幅/立绘容器（mapLayer 与 fighterLayer 之间，角色在黑幕之上=原版层序）；faceId = 施法者相对目标 x（原版 showFace）；白闪以白色加色叠层近似（偏离记录）；地图层锁定期隐藏；事件去重键补 payload id（此前同 tick 两个 effect 事件会互吞）。
- **门禁**：core 112 测试（新增 cutin.test.ts 6 项）；replay 5 剧本 + batch:validate 基线重冻（冻结锁改真实语料时间线，预期内）。

### 切片 23·B5——独立道具逐帧命中矩形（✅ 2026-11-12）

原版 `FighterAttacker.findHitArea` 逐帧扫元件命名子对象（`getBounds(元件)`）解析 hitVO——此前道具命中矩形是发射帧占位。切片 23 把整条链补齐（commit 待填）：
- **core 语义升级**：attacker 位置从"命中矩形左上角"改为**元件原点**世界坐标（原版 `_mcOrgPoint`）；`fires[name].org/hits` 存在 → 命中检查逐帧解析（命中区名按 owner 动作表精确 → 去 atm 解析；无命中区帧 = 无判定）；缺数据回退生成帧占位（世界矩形与旧中心语义等价——切片 9 测试即此断言的更新）。顺带修 applyG 地面夹取未跟上原点锚定的 bug（assist-duel 漂移排查中发现）。
- **采集管线**：dump 桥（tools/bridge/inject-methods.as3）扩展 attacker 元件采集——语料名单从 baked 数据生成注入（86 名），逐帧 `getBounds(元件)` + org + fake `setAttackerCtrler` 吸收内层帧脚本（byakuya atmc 为运行时挂载，需补 AssisterCtrler no-op 才能挂上，同 capture 桥教训）；`tools/b5-pack` 合并进 baked fires 包（86 项，6 例同名跨形态消歧取 addAttacker 所在形态）。XFL 静态审计先行（`tools/b5-pack/audit-corpus.mjs`，86 语料 79 唯一解析/7 歧义）。
- **顺带收编**（同前置"内层 hitVO 可消费"）：madara miss 分支——导出器 `matchJustHitGuard` 提取卫语句为 `if` cond 触发器，core `dispatchAttackerCond` 分派（justHit = 目标 lastHurtHitId 比对）；itachi 动态伤害——导出器 `extractHitPowerSet` 识别 `hitVO.power = targetHpMax × rate` 为 `setHitPowerByTargetHpMax` op，覆写存辅助实例、其生成的 attacker 命中解析时消费。
- **render 接线**：attacker 精灵改元件原点锚（scale.x 翻转同角色 root 模式），回退色块画 fbHit 矩形。
- **门禁**：core 114 测试（新增 B5 逐帧命中 2 项）；replay 4 剧本零漂移、assist-duel 基线重冻（`hitPowerOverrides` 空槽 + 原点坐标进序列化——**零行为差异**已用全量 state 逐 tick 对比证明）；batch:validate 基线门禁原样通过（其基线不含这些字段）。
- **遗留**：逐帧命中行为变更无 replay 剧本覆盖（5 剧本无语料角色）；byakuya 抓取伤害 atm1（power=50）等真实判定待实战验收；歧义 6 例的正确性抽样核对未做。

### 切片 24·B3——空中必杀 attackId（✅ 2026-11-12）

批次 20 遗留的"空中必杀 attackId=null（无动作 id 映射到 空中必杀 标签）"收编。核查结论先行：**"纯表现无判定"是当时的误记**——命中结算自切片 10 起按帧逐区解析（区名精确 → 去 atm 反查动作表），不依赖 attackId；实测 aizen 空中必杀 kbsatm→kbs 命中成立（power 200）、切人插图/顺流播放均正常。真正缺口是 data 层 `deriveAttackLabel` 缺 `kbs→空中必杀` 映射，空中必杀发起后 attackId 恒 null：
- **修复**：`packages/data/src/fighter.ts` 映射表补 `kbs`（原版实证：`HitVO.isBisha` 含 kbs 分支、`FighterAILogic` airBisha 用 "kbs"、`FighterHitRange.BISHA_AIR="kbsmian"`；语料 18 角色主 id kbs + kbs1~4 分段动作——分段 id 同 bs1 惯例只经判定区名解析，不进映射）。修复后空中必杀发起 attackId='kbs'，与 bs/sbs/cbs 对齐，为 §4.3 块 6 AI 转译（FighterAILogic 按 kbs 引用）备好词表。
- **全角色核实**（25 形态有 空中必杀 段）：近战系 kbs(N)atm 全部可解析；道具系 byakuya/deidara/naruto root5 走 addAttacker、ichigo/madara 走 fire；抓取系 toushirou 走 setHitTarget；grimmjow/kimimaro/sakura/naruto root6 段内无判定区无道具——与原版 SWF 逐帧 dump 一致（纯位移/演出段，非缺数据）。
- **已知边界（维持现状）**：原版 setAirAllAct 无条件填 bishaAIR 槽（无 checkFrame），无该标签的角色空中按必杀 = 原版 goFrame 未定义行为；移植版槽按标签存在性填写（defaultSlots 既有偏离，按钮无效但不扣气不黑屏）。
- **门禁**：data 17 测试（新增 kbs 映射 1 项）；core 126 / replay 5 剧本 / batch:validate 全过零漂移（基线剧本不含空中必杀输入）。

### 切片 25·B4——temari 风场（✅ 2026-11-13）

13-A6 审计最后一个未建模项收编。逆向规格（f_assistant/temari DOMDocument.xml）：帧 2 `level = LEVEL[int(min(targetHeavy,5))−1]`（LEVEL=[0.8,0.65,0.5,0.35,0.2]）、`finalSpeed = targetSpeed × level`；帧 34 注册 fuutonFunc——每渲染帧对所有敌方弹 `sp.speedLevel = level × direct`（direct = 弹朝向==自身朝向 ? −1 : 1）、目标非 HURT_DOWN(23) 时 `targetSP.x += finalSpeed × selfDirect`、一次性 owner `speedUp(ownerSpeed × 0.25, 6)`；帧 145 注销并把弹速级复位。
- **core**：`AssisterCustomFunc` 增 `windField` kind（注册帧采样 levels 折算 level/finalSpeed/direct，采样帧偏离见 DESIGN §3.5）；`stepAssisterCustomFunc` 拉扯分支（30Hz ×SPEED_PLUS）；弹速级为**派生值**——`stepBullets` 按在场风场辅助实时求值（仅敌方弹、id 序后者覆盖 = 原版单槽覆写序），零新增状态字段 → 除 temari 外全语料零漂移。
- **`buffSpeedUpByOwnerSpeed(rate, hold)`**：核查发现"owner speedUp 已提取"是误记——temari 该触发首参是 `{$expr: "ownerSpeed * 0.25"}`，core `num()` 求值 0（静默 no-op）。惯用语数据化：值 = 召唤者 def 基速 × rate。
- **导出器**：`matchOwnerSpeedBuff`（var 捕获 owner speed + speedUp(var×R, H)）+ `matchWindFieldCustomFunc`（getTargetState==23 门 + targetSP.x 拉扯 + 唯一弹速级特征函数 + 唯一数值数组常量；特征组合不绑名，模板外 null）——temari.json 重导出仅两个预期触发改写，rawScripts 不变。
- **门禁**：core 134 测试（新增 wind-field 8 项：弹速级减速/加速/同队免疫/heavy 采样/拉扯/HURT_DOWN 门/注销恢复/buff）；replay 5 剧本 + 新增 temari-wind 剧本（双方召唤 temari 对拉，基线已冻）全过；batch:validate 仅 temari 冒烟 finalHash 变化（85fe355b→c7dc05de，风场生效的预期行为变化，基线已更新）。

### 切片 26·块 7 前半——必杀相机聚焦 + 光效 + 相机自适应缩放（✅ 2026-11-13）

PROGRESS §4.3 块 7 的切片 22 遗留项收编，顺带收编原版 `GameCamera.renderTwo` autoZoom。逆向规格：`EffectCtrler.bisha(target, isSuper, face)`——isSuper → `cameraFocusOne`（单焦点 + zoom 3.5）+ `doEffectById("bisha_super")`，否则 `doEffectById("bisha")`；wanKai 无条件 super；`endBisha`/`endWanKai` → `cameraResume`（双焦点 autoZoom 接管，zoom 缓动回落）。autoZoom = `min(视宽/distX, 视高/distY)×0.8` clamp [1,2.5]，缓动每帧 delta/5（tweenSpd 2.5÷SPEED_PLUS 0.5）。
- **bisha-pack 步骤 3b**：XG_bs（sprite 568 / mc_020，画布 244×210）/ XG_cbs（sprite 567 / mc_021，293×252）17 帧逐帧 WebP；断言画布尺寸，cbs=bs×1.2 精确吻合验证"外层矩阵 + shape 位图锚"origin 推导（(−123.05,−101.9)/(−147.85,−122.31)）。baked schema 升 `bvn/bisha@2`（新增 `effects`）。
- **render**：`spawnMcEffect` 逐帧播放器（30fps、加色混合、锚事件 (x, y−50)、播尽自移除 = 原版 EffectView）；相机改 `zoomFactor/zoomTarget` 模型——camFocus（施法者/辅助，assister 从快照找）→ zoomT 3.5，双焦点 → autoZoom；缓动 `k = 1−(1−1/5)^min(dtMs/16.67, 4)`，位置 snap 0.5 世界px、缩放 snap 0.5/800；横幅 y = `100 + 100/zoomTarget`（原版 showBishaFace 用演出开始时的相机目标因子）。
- **层序修正（切片 22 偏差）**：横幅/立绘从 world 迁入屏幕空间 `cutinScreen` 层（原版 BlackBackView 挂 stage、scrollRect 之外）——聚焦相机会放大 world 内横幅造成漂移。
- **core 零改动**：bisha 事件 payload 早已带 isSuper/owner/ownerKind（切片 9/12 埋好），纯表现层 + baked 数据 → 门禁零漂移符合预期。
- **门禁**：build / core 134 / replay 6 剧本 --expect 零漂移 / batch:validate（58 角色 + 37 辅助）全过；headless Edge 冒烟（CDP 诊断钩子读 qi + 攒气施放）目检两轮施放：黑幕/横幅/立绘/光效/3.5 倍聚焦/解锁回落全部到位，控制台零异常。

### 工具治理——双哈希 + 漂移归因工具（✅ 2026-11-12）

哈希门禁的漂移调查（证明"纯表示变更"）在切片 9/13/23 反复消耗手工流程，治理如下（DESIGN §3.8 双哈希）：
- **replay 门禁改冻行为哈希**：`SimSnapshot` 新增 `behaviorHash` = `behaviorView`（剥除 `fighters[].input` 与实体 `name` 表现字段，denylist 设计漏登记只会多漂不漏报）+ 空容器省略序列化（null/`{}`/`[]` 不进哈希）——新增"恒空"记录字段/坐标重锚定等表示层改动不再漂移基线。全状态 `hash` 原样保留（联机失步/对拍/batch:validate 用）。5 剧本基线重冻，重冻前以"新 core 全状态哈希与旧基线逐字节一致"证明零行为差异。
- **`tools/replay/verify-drift.mjs`**：漂移归因自动化——stash→build→dump HEAD→pop，工作区 vs HEAD 全量状态逐 tick 深diff，全等 = 可重冻、不等 = 字段级行为差异报告。`replay.mjs` 剧本展开/Sim 构造抽到 `run-script.mjs` 共用。
- batch:validate 基线原样通过（全状态哈希未动）。

---

## 四、剩余工作规划（未完成部分）

> 本节只收未完成项；已完成内容见 §二/§三。排期可按实际开工时调整，调整时改本节。

### 4.1 联机收尾线（阶段 2 的真机验收条件）

| 项 | 内容 | 验收 |
|---|---|---|
| 云服务器部署 | ✅（2026-11-11）：Node 22 + `/opt/bvn/` + systemd `bvn-room.service`（PORT=8787，开机自启）+ nginx 443 wss 反代（自签证书，真实证书待域名接入）。服务器信息与部署现状见本地 `docs/cloud-server.md`（gitignore，不入库；密钥为仓库根 `cloud-server-key.pem`） | wss 冒烟全流程通过（create/join/start/input 中继/peer-lost）；relaport 站点回归 200 零 ERROR |
| 真机体验验证 | 公网两端完整对局人工验收（两端浏览器先访问 `https://120.48.185.202/` 接受自签证书例外；入口 `?mode=net&action=create&server=wss://120.48.185.202/`） | 对局可打完；哈希失步零发生 |
| 延迟调优立项 | 视云上结果：输入延迟帧自适应（现为固定 INPUT_DELAY=3）、抖动缓冲 | 云上手感不可接受时才立项；rollback 升级与否据此决策（接口已预留：tick 纯函数 / SimState 可序列化 / 输入只经 InputFrame） |

### 4.2 阶段 3 尾巴（切片 13 余项，纯增量特性，不阻塞阶段 4 推进）

- 辅助 rawScript 审计确认的未建模项（13-A6 定级，低影响偏离）：suigetsu `isAttacking=true`（唯一读者 AI，随 §4.3 块 6 一并处理）；
- 辅助残余静默 op：justHit（纯读）/ setTouchSide（语料无实例）——确定性静默，无行为差；
- 验收：门禁全过；行为变更则重冻对应基线。

### 4.3 阶段 4 体验完善（粒度先按块，开工前细化成切片）

| # | 块 | 内容 | 备注 |
|---|---|---|---|
| 1 | 断线处理 | peer-lost 后判负/重连（现为冻结等待） | 断线冻结等待升级为判负/重连 |
| 2 | 录像回放 | 输入序列 + 种子 + 数据版本戳的存储与播放 UI | 帧同步免费送，core 无需改 |
| 3 | 观战 | 只收不发输入的观战客户端 | net 层扩展 |
| 4 | rollback | 可选；视云上延迟体验决策 | 架构接口已预留（DESIGN §6） |
| 5 | 菜单流打磨 | ✅ 骨架（切片 14）；✅ 选人页原版化（切片 15）；✅ 菜单主页原版化（切片 16）；余 Logo 演出/格子动画/结算立绘/开场徽标去除（可选）+ 切片 14 UI 待打磨池（格子长名溢出/DOM 输入样式） | app 层场景系统 |
| 6 | 街机模式 | mission.xml 关卡数据 + AI（FighterAICtrler 转译，~700 行，种子随机） | AI 是 PvP 路径外的唯一大块逻辑 |
| 7 | 音效/特效接线 | ✅ 前半（切片 26）：isSuper 必杀相机聚焦 + bisha/bisha_super 光效 + 相机自适应缩放（autoZoom 收编）；余音效：音源从 embed SWF 提取 + 表现事件消费完善（事件队列已留好；effect.swf 已定位） | 音效随机选音源在渲染层做，不进 sim |
| 8 | 本地双人 | 第二本地输入源 | 扩展项池，主线收尾后最后做 |
| 9 | 进战斗加载画面 | LoadingScene 进度条（原版 GameLoadingStage/LoadingStage 语义）+ 装载分帧化（现同步串行卡主线程）+ bg cover 首帧定位（修"进场黑边"） | 原版场景链：选人 → Loading → GameStage |

---

## 五、下一步（按优先级）

1. **真机体验验证**（§4.1）——云服务器已部署（wss 冒烟通过）+ 切片 14/15/16 菜单/联机/选人 UI 已通，公网两端完整对局人工验收条件已齐（入口 `?mode=net&action=create&server=wss://120.48.185.202/`，页面上点选即可）；
2. **阶段 3 尾巴已收编完毕**（切片 21 收编 B1、切片 22 收编 B2、切片 23 收编 B5、切片 24 收编 B3、切片 25 收编 B4；余项仅 suigetsu isAttacking——唯一读者 AI，随 §4.3 块 6 一并处理）；
3. 阶段 4 各块按 §4.3 表顺序推进，每块开工前细化为切片并登记进 §二 明细表。
