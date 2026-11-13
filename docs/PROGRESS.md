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
| 4 | 体验完善：菜单流/原版化/实战修复等 | 🔄（切片 14/15/16/26/27/28/29/30/31 + 修复批次 17/18/21F/22/23/24/30 ✅；余断线/录像/观战/rollback/街机/本地双人，见 §4.3） |

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
| 27 | 阶段 4·块 7（后半·事件驱动半）：音效接线——`tools/sound-pack` 音源管线（bgm/se/swc/fx/语音 5 路）+ baked/audio.json 清单 + app AudioSubsystem（WebAudio SE 池/BGM 通道/语音防重叠）+ core `voice` 事件 + 场景 BGM/UI 音接线；余逐帧时间轴音（§4.3 块 7） | ✅ | §三·切片 27 |
| 28 | 阶段 4·块 7（余项）：逐帧时间轴贴帧音——`tools/sound-pack/frame-sounds.mjs` 自研 SWF 标签解析（StartSound 采集 + formIndex 对齐）+ baked/timeline-sounds.json（56 包 1816 事件）+ app handleTimelineFrames 帧进入触发（纯 app 层零哈希漂移）；嵌套元件音 99 处遗留（§4.3 块 7 遗留池） | ✅ | §三·切片 28 |
| 21F | 修复批次：形态角色（sasuke_juin 等 12 个可选）选入即 404——swf 基名数据化（select-pack 烘 fighter.xml `file url`）+ app 全链按基名取 XFL/fire/语音/贴帧音（图集仍按形态 id） | ✅ | §三·批次 21F |
| 22 | 修复批次（实战验收第二批·①）：行走滑步（loop 触发点收编，54/58 走标签）+ 防御解除"卡一下"（防御恢复冻结窗口=原版 goFrame(false)+delay idle）+ verify-drift 假阴性修复（dump 必须子进程）；MC 子元件走段家族（kenshin/ulquiorra/naruto form4）采集重跑遗留 | ✅ | §三·批次 22 |
| 23 | 修复批次（实战验收第二批·②）：切人插图两处修复——必杀横幅右缘黑区（原版横幅内容恰铺满 800×600 游戏区，移植版可见逻辑区 1000+ → 内容横向拉伸铺满 + 立绘槽位同比外推）+ 立绘定位多减 canvasOrigin（右偏 134/下偏 12、槽 2 出屏）；追补：相机 autoZoom 视口基准常量化（原版 GAME_SIZE 800×600，§4.3 块 11） | ✅ | §三·批次 23 |
| 29 | 阶段 4·块 5 收尾·菜单流打磨：Logo 开场演出（logo_movie 66 帧流播 + LogoScene）+ 结算立绘（内嵌 loading.swf winner_stg_mc 92 帧舞台 + 胜者立绘/台词气泡 + select-pack 升 @2 烘 win_cls/says）+ 选人格子入场/退场/地图面板动画（buildList/fadOutList/initMap 收编，tween 提取共享 anim.ts + FrameStream 泛化）+ UI 打磨池（长名钳制/DOM 输入样式） | ✅ | §三·切片 29 |
| 30 | 阶段 4·对局 HUD 原版化（用户目检发现占位 UI，立项收编）：fight.swf XFL 全 HUD 装配逆向（血条/大脸/能量条/计时板/气条/READY/辅助格/连击数）+ `tools/ui-pack/hud-pack.mjs` 27 元素烘焙（FFDec sprite 帧序 + shape SVG 光栅化）+ `baked/hud.json` + render FightHud 屏幕空间钉边组件 + app 接线（select `comicType`/`_m` 大脸/50×50 辅助脸）；原版血条红条延迟/能量溢出闪烁/气条 4 段+幽灵步/连击数算法逐条收编 | ✅ | §三·切片 30 |
| 31 | 阶段 4·块 9·进战斗加载画面：`tools/ui-pack/loading-pack.mjs` 烘焙（loading.swf loading_fight_mc 舞台画裁切 + 进度条槽/填充/美术字/spinner 30 帧）+ `baked/loading.json`（schema bvn/loading@1）+ app LoadingScene（原版 LoadingStage 装载队列语义：角色→辅助→场景→BGM 预解码→渲染纹理，msg+计数/条形 scaleX/spinner 30fps）+ 装载分帧化（步间让帧，不再整段卡主线程）+ renderer.load 分步进度回报 + renderer.prime() 首帧定位（修"进场黑边"）+ 装载期舞台层隐藏 + BattleScene 改装载产物交接（setup/winner/main 三处入口改经 LoadingScene） | ✅ | §三·切片 31 |

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

### 切片 27·块 7 后半（事件驱动半）——音效接线（✅ 2026-11-13）

音源从 embed SWF 全量提取 + 表现事件消费接线。逆向规格：原版 `SoundCtrler`（playAssetSound/playSwcSound/BGM 同曲 no-op）、`FighterVoiceCtrler`（防重叠 `_channel.position < _curLength` 跳过、rate 门 `Math.random() > rate` 跳过、随机选音）、`EffectModel` EffectVO.sound（命中音按 hitType 映射）、`FightUI` KO 双段音（snd_over_hit → 500ms 后 snd_ko；bsKO 必杀窗口内换 snd_ko_bs）、`playFightBGM`（角色曲按 rate% 概率否则地图曲）。

- **`tools/sound-pack/sound-pack.mjs`**：音源管线——FFDec `-export sound` 从 effect.swf（27 命名 fx）+ 75 个角色/辅助 SWF（命名语音类 34 包 83 音；匿名类不采）导出，bgm 21 / se 5 / swc 8 mp3 拷贝；fighter.xml/map.xml **按元素整体扫描**（无 bgm 的元素不会错绑下一元素的 bgm）；baked 语音引用校验（缺失即抛错）。产出 `packages/data/baked/audio.json`（schema `bvn/audio@1`）+ assets/audio 共 4.1MB。命中音映射：byType（1 snd_kan1 / 2 snd_hit2 / 3 snd_hit_heavy / 4 snd_hit2 / 5 snd_mfdjx / 6 snd_kan2 / 7 fire / 8 ice / 9 electric / 11 catch）、blocked 按 hitType 分表、steel snd_hit_steel、guardBreak snd_mfdjx；effectSound：jump/touchFloor/dash/bisha/bisha_super。
- **app `AudioSubsystem`**（`packages/app/src/audio.ts`）：WebAudio 懒解码（fetch→decodeAudioData 带 promise 缓存）、SE 池（sfxGain）/BGM 通道（bgmGain，loop，同曲 no-op + 切曲竞态丢弃）、语音防重叠（voiceUntil）+ rate 门 + 随机选音、KO 双段音（setTimeout 500ms；cutinOpen 窗口 = bisha/wanKai 至 endBisha/endWanKai）、首次手势解锁 AudioContext、`__bvnAudio` 诊断钩子。battle enter 装配 per-fighter 语音绑定（forms.sounds → VoiceBinding）；menu/setup 接 UI 音（hover menu1/select menu2/skipIntro menu5）+ BGM（op/select）。
- **core**：`voice` 事件（受击/死亡语音信号；随机选音与 rate 门在 app 层，事件不进哈希零漂移）+ hit:connect payload 补 `steel`（钢身命中音分流键）。偏离记录：① 原版死亡语音"击飞致死在 doHurt 即播、硬直致死在倒地硬直结束播"，移植版统一提前到 KO 时刻；② NetScene 无对局 BGM（原版 net 流程同样静音）；③ 形态切换语音重绑定未接（more= 变身暂未实现）。
- **门禁**：build / core 134 测试（新增 steel payload + voiceHurt/voiceDie 断言）/ replay 6 剧本 --expect 零漂移（voice 事件不进哈希证明成立）/ batch:validate 58+37 全过；headless Edge CDP 冒烟（`tools/_scratch/audio-smoke/`，gitignore）验证音频全链路：AudioContext running、BGM char_ichigo 播放中、走近+攻击后 decoded 含 bgm/se_hit1/24_snd_kan1/3_snd_hurt2——SE/命中音/语音真实解码播放，控制台零异常。

### 切片 28·块 7 余项——逐帧时间轴贴帧音（✅ 2026-11-13）

角色/辅助动画时间轴上的匿名音（StartSound 标签，无 SymbolClass）——攻击挥砍、必杀呐喊等"帧被显示即播"的音效。逆向规格：Flash 语义 = 播放头**进入帧**时触发（含 gotoAndPlay 跳转落点帧，跳过的帧不触发，冻结播放头不重触发）；角色 SWF root 每根帧放一个 `mc` 形态元件、贴帧音在其时间轴上（formIndex = `mc` 放置序，与 data 层 compileFighterForms 过滤空形态后对齐——注意**不是** root 帧-1）；辅助 SWF root 本身即动画时间轴（与 dump 桥语义同源）。

- **`tools/sound-pack/frame-sounds.mjs`**：自研最小 SWF 标签解析器（FWS 解压后标签流：ShowFrame/DefineSound/StartSound/PlaceObject2/DefineSprite，其余整块跳过；与 FFDec `-swf2xml` 交叉验证）+ FFDec `-export sound` 匿名音导出拷贝。SoundInfo 完整解析（SyncNoMultiple/SyncStop/In/Out/Loops/Envelope），**偏离：音量包络忽略**（移植版全音量）。产出 `packages/data/baked/timeline-sounds.json`（schema `bvn/timeline-sounds@1`，56 包 / 1816 事件 / 966 音 7.5MB）。
- **app 层接线**（`audio.ts` handleTimelineFrames）：每 tick 对比 sim 快照 animFrame 变化触发对应包帧音（首次 sighting 作静音基线，消散实体清 key）；战斗 enter 装配 TimelineAudioBinding（fighter id→swfId，assistId→swfId）。**纯 app 层，core 零改动 → 双哈希零漂移**（门禁全绿无需重冻）。
- **遗留池登记**：嵌套元件（zh2mc/hitmc 类演出件）时间轴音 99 处未采——需要 ghost 时间轴模拟内层播放头，价值低（hitmc 命中火花类），随需求另立项；流音全语料为空流头（零 SoundStreamBlock）确认可忽略；rukia sid 1 FFDec 导出失败剔除（唯一 1 例）。
- **冒烟**：headless Edge CDP 连击链（砍1→砍2→砍3@165 触发 `timeline/ichigo/143.mp3`）+ KeyO 辅助召唤（gaara root `timeline/gaara/27.mp3`）双路径实测通过。
- **教训**：baked 包结构漏 `{forms:}` 包装层导致查表恒 miss（根因排查靠页内诊断三步法：tlm 加载✓→lastFrames 走动✓→直接试播✓→只剩查表路径）；Node CDP 脚本易 UV 断言崩溃 → 写文件 + try/catch + process.exit(0)。

### 工具治理——双哈希 + 漂移归因工具（✅ 2026-11-12）

哈希门禁的漂移调查（证明"纯表示变更"）在切片 9/13/23 反复消耗手工流程，治理如下（DESIGN §3.8 双哈希）：
- **replay 门禁改冻行为哈希**：`SimSnapshot` 新增 `behaviorHash` = `behaviorView`（剥除 `fighters[].input` 与实体 `name` 表现字段，denylist 设计漏登记只会多漂不漏报）+ 空容器省略序列化（null/`{}`/`[]` 不进哈希）——新增"恒空"记录字段/坐标重锚定等表示层改动不再漂移基线。全状态 `hash` 原样保留（联机失步/对拍/batch:validate 用）。5 剧本基线重冻，重冻前以"新 core 全状态哈希与旧基线逐字节一致"证明零行为差异。
- **`tools/replay/verify-drift.mjs`**：漂移归因自动化——stash→build→dump HEAD→pop，工作区 vs HEAD 全量状态逐 tick 深diff，全等 = 可重冻、不等 = 字段级行为差异报告。`replay.mjs` 剧本展开/Sim 构造抽到 `run-script.mjs` 共用。
- batch:validate 基线原样通过（全状态哈希未动）。

### 修复批次 21F——形态角色选入 404（✅ 2026-11-13）

实测选 sasuke_juin 即 `fetch baked/fighters/sasuke_juin.json → 404`。根因：选人池 53 个 id 中 12 个是**形态角色**（sasuke_juin/ogihci/ichigo_bankai…），原版 fighter.xml 里它们与基础角色**共用同一 swf**（`<file url>` + startFrame 区分形态），而 `baked/fighters`（XFL 包）、`baked/fires/fighter`、audio voices、timeline-sounds 全部只按 **swf 基名**烘焙（38 基名）；app 的 loadFighterPack 却一律按角色 id 取包 → 形态角色全 404（XFL/fire/语音/贴帧音四路全断，triggers 恒空）。

修复（数据驱动，不进引擎分支）：
- **`tools/select-pack`**：解析 fighter.xml `<file url="assets/fighter/X.swf">` → 每个选人条目烘 `swf` 基名字段（形态角色 ≠ id，如 ogihci → ichigo；辅助各用自己 swf 不需换算），select.json 重烘。
- **app**（`data.ts`/`battle.ts`）：`loadFighterPack(id, swf)` —— runtime/图集按形态 id，XFL（改 jsonOptional）/fire 按基名；语音 voiceUrl、贴帧音 TimelineAudioBinding、fire 图集寻址值全部换用 `pack.swf`；FighterPack 增 `swf` 字段。核心对照：`sasuke_juin` 装配后 triggers 0 → 182、fires 挂上，sim 冒烟连招正常。

- **遗留 ①（默认形态对位）**：~~形态角色的缺省形态取"第一个含动画形态"，与原版 fighter.xml `startFrame` 不完全对位~~ → **实测证实（2026-11-13 用户验收：咒怨佐助/一尾鸣人以原形态进场），同批追补修复**：select-pack 烘 `startFrame`（fighter.xml），core `FighterConfig.formIndex` 初始形态支持，app 按 startFrame 取进场形态。**58 角色实证零例外：缺省形态 = 含动画形态中第 startFrame 个（rootFrame = startFrame+1，基础角色恒 1）**。
- **顺带修复（万解切形态渲染差一位）**：formIndex 有两套下标空间——sim forms 数组是过滤空根帧后的紧凑数组、render 图集 forms 是含空根帧的全数组，`fighter:form` 事件下标直接喂图集恒差一位（切形态显示回上一形态）。core 事件补发 `rootFrame`（绝对帧寻址），render 优先按 rootFrame 换算图集下标（缺省回退旧下标行为）。基础角色 formIndex 恒 0 起步 → 双哈希零漂移，门禁全绿未重冻。
- **遗留 ②（门禁覆盖差）**：batch:validate 基线里形态角色仍是**无 XFL** 编译（58 角色基线含 20 个 runtime 形态角色），与本批后 app 装配（挂基名 XFL）不一致；基线反映门禁自身管线暂不改，日后若把 XFL 兜底纳入门禁需整体重冻并 verify-drift 归因。
- **用户验收新发现 → 遗留池登记**：① 鸣人 W+J（砍技2）影分身出现但不动——~~fire 元件采集系统性静态化，采集管线需 ghost 时间轴式递归步进 + 重跑 capture 桥~~ → **批次 32 证伪并结案**：probe 逐帧质询证明 kj2mc/cbsmc/sbsmc/kj1mc 等是**真静态素材**（36 帧全同 = 静态贴图 + 静态 Shape，引擎靠变换矩阵驱动位移），采集忠实无需重采（详见 §4.3 块 10）；② 佐助防御时人物模糊——待复测定位（疑点：相机 autoZoom 近身放大至 2.5× 位图上采样变糊，全角色共有，原版矢量渲染无损）。

### 修复批次 22——走循环点 + 防御恢复冻结（实战验收第二批·①，✅ 2026-11-13）

实测 5 问题中的 1（防御解除"卡一下"）与 5（行走滑步）收编。逆向定案（推翻此前"采集桥嵌套失真"的假设）：

- **行走滑步 = 引擎未消费 loop 触发点**，采集无辜。原版走段动画由时间轴脚本 `loop("走")` 在触发帧无条件回卷（`FighterMcCtrler.loop → goFrame`，goFrame 恒 `gotoAndStop`+renderChildren），鸣人形态1 走 24 帧里真循环只有前 14 帧（7 姿 ×2），后 10 帧是永不显示的死区。移植版 behaviors.loop 走 setLabelTo（同名不跳）→ 死区帧照常播放（后半 12 帧定格同一 png）→ 平移感。图集烘焙逐帧核对：前半 2 帧一换姿 + 死区定格，**采集本身忠实**（graphic 实例子元件由 gotoAndStop 自动同步）。
- **修复**：`advanceAnimation` 推进后按落点帧消费 `target='mc' op='loop'` 触发（`loopRedirectTarget`，回卷落点 = 该 tick 显示帧，帧脚本在 nextFrame 期间执行的同款语义）；`flowTarget` 顺流门加 loop 检查。数据审计：79 处 loop 触发（54 走 + 25 跳招/超必杀/空中必杀链）无一与其它触发同帧、无一处于标签首帧。批次 19 教训落实：逐剧本单独跑 --expect。
- **防御解除 = 原版冻结两帧不是播完整段**：原版 `renderDefenseAnimate → goFrame("防御恢复",false,{call:idle,delay:1})`——播放头钉首帧（12 帧素材不播放）、两 tick 后 idle 回站立。移植版放完整段（labelLock=duration）= 用户看到的"卡一下"。修复：labelLock=3（T0/T1 冻结 + T2 转站立）。6 tick `_defenseFrameDelay` 解除延迟维持 POC 偏离（响应性优先）。
- **顺带发现（未改，待定项）**：原版站立 = `idle("站立") → goFrame("站立",false)` 静态单帧，移植版站立循环播放 9 帧——全角色可见的忠实性偏差，改不改待用户定（影响 body 判定框时序 + 全量基线）。
- **verify-drift 假阴性修复（门禁工具缺陷）**：两次 dump 原在同进程运行，ESM import 缓存使 HEAD dump 沿用首次加载的 dist → 恒报"零行为差异"（本批实测：手动对比 tick 33 有真差异，工具报零）。修复：dump 抽到子进程 `dump-states.mjs`；stash 加 pathspec 排除工具自身（未跟踪新文件会被 -u 收进 stash）。批次 19 的"verify-drift 归因"规程此前对代码改动完全失效，重冻结论需按新工具复核。
- **门禁**：core 134 测试全过；replay 6 剧本单独跑（ichigo-mechanics 有意漂移，verify-drift 归因 = walk 循环点 animFrame 26→10，重冻）；batch:validate 20 角色基线漂移重冻（走循环/防御恢复全角色路径）。
- **遗留 → §4.3**：~~MC 子元件走段家族——采集桥子元件推进失效需修复重采~~ → **批次 32 证伪并收编**：采集忠实、素材本身静态（stop 冻结走段），引擎侧收编 `stop` 触发（mcHold），详见 §4.3 块 10。

### 修复批次 23——切人插图两处修复（实战验收第二批·②，✅ 2026-11-13）

批次 29 实测问题 4（必杀横幅两个独立缺陷）收编，逆向定案 + renderer 修复（纯表现层，core 零改动）：

- **横幅右缘黑区（原"待对照原版挂载"定案）**：原版 `BlackBackView`（盖 GAME_SIZE 800×600）挂 scrollRect(0,0,800,600) 的 root、`_bishaFace.mc` x=0/y=100+100/zoom；横幅内容经页面内解码逐帧实测 = PNG (133,12)..(933,196) ≈ mc 空间 [0,800]——**恰铺满原版 800 游戏区**（1066 画布为两侧对称透明出血，canvasOrigin −134 即出血宽）。移植版可见逻辑区 = viewW/fitZoom（1000+，随纵横比），800 宽内容怎么摆都盖不满 → 修复 = 内容**横向拉伸铺满 visW**（速度线横幅拉伸不可感知，与 bgFixed cover 同款适配）+ 立绘槽位 wx 同比外推保持"贴 band 两端"构图。附带修正 DESIGN 两处规格误记（"PNG 画布=内容 union bounds"不成立；逻辑坐标 1000×600 对应的是 SWF 舞台，游戏内容区 800×600）。
- **立绘定位多减 canvasOrigin**：槽位 wx/wy 即 mc 空间的 W_T，屏幕位应为 `mc 原点 + W_T`；旧代码 `mcPos + W_T − canvasOrigin` 把 canvasOrigin 多减一次 → 整体右偏 134/下偏 12、槽 2 立绘被推出屏右缘。已修（canvasOrigin 只用于 band PNG 定位）。
- **门禁**：build / core 134 / replay 6 剧本 --expect 零漂移 / batch:validate 58+37 全过（render-only 双哈希零漂移符合预期）；headless Edge CDP 冒烟（1920 视口施放必杀 + 分段截图 + 像素扫描两缘）实测横幅铺满全宽无黑区、立绘贴左端，控制台零新增异常。
- **冒烟脚本**：`tools/_scratch/cutin-smoke/`（gitignore）。
- **追补（§4.3 块 11）**：相机 autoZoom 视口基准常量化——原版 `GameCamera` 用 `_screenSize`=GAME_SIZE **800×600 常量**，移植版此前误用实际可见区 viewW/fitZoom（16:9 下 1066×600，宽屏 zx 偏大 → zoom 偏大、贴身推近过狠）。修复 = zoom 公式改 800×600 设计视口常量（`DESIGN_VIEW_W/H`），渲染可见区仍随纵横比铺满、仅 zoom 数值节奏对齐原版。纯渲染层，replay 6 剧本 + batch:validate 零漂移；cutin 冒烟回归（camFocus 3.5 聚焦 + 解锁恢复 autoZoom）正常。

### 修复批次 24——防御后攻击/防御永久失效（实战验收第三批·①，✅ 2026-11-13）

实测问题：按一次 ↓ 防御、松开回站立后，再按 ↓ 无法再进入防御（普攻同样失效）。

- **根因**：`doDefense` 清槽（attack=null 等）后无人重填。退出路径 `exitDefense → 防御恢复冻结 2 tick → T2 setLabel("站立")` 直转——站立是循环标签（endAction 不可达）且时间轴无 idle 触发 → 槽永久为空 → 防御门（`slots.attack !== null`）与普攻门恒失败。与批 18 受击恢复"不重填槽→攻击/防御永久失效"同类缺陷，当时只修了受击路径。
- **修复**：`advanceAnimation` 防御恢复转换分支补原版语义——T2 转站立 = 原版 `goFrame("防御恢复",false,{call:idle,delay:1})` 的 idle 回调（`idle("站立") → setAllAct 重填槽 + jumpTimes/airHitTimes 恢复`）。重填放在转换点而非 `exitDefense`（对齐原版 idle 回调时序，冻结窗口内不提前可防御）。
- **归因**：verify-drift 双剧本归因（defense-reentry 自制剧本 + ichigo-mechanics）——首个差异 tick = 防御恢复→站立转换点，字段级差异仅槽位 null→默认值，无其他行为分叉 → 有意漂移。
- **门禁**：build / core 135 测试（新增防御重入回归用例）/ replay 6 剧本（ichigo-mechanics 有意漂移重冻）/ batch:validate 58 角色 + 37 辅助（18 角色漂移重冻）全过。

### 切片 29——菜单流打磨收尾（✅ 2026-11-13）

§4.3 块 5 余项（Logo 演出/格子动画/结算立绘/开场徽标去除-可选）+ 切片 14 UI 打磨池（长名溢出/DOM 输入样式）全部收编，块 5 收官。
- **Logo 开场演出**：ui-pack 扩展（common_ui sprite 26 logo_movie 66 帧 WebP）+ LogoScene（原版 LogoStage 语义：gotoAndPlay(2) 播到帧 66 帧脚本 COMPLETE → 进主菜单；无音频无跳过，原版如此，全程 ~2.1s）。正式入口 boot → LogoScene → MenuScene；dev 直通参数（?mode=…）跳过开场（原语义不变）。
- **结算立绘**：ui-pack 扩展（FighterTester.swf binaryData 内嵌 loading.swf → winner_stg_mc 帧 1..92（帧 93 "destory" 黑帧不烘焙）+ txtmc 气泡帧 2..10；stageOriginInFrame [740,207.5] 像素实测——union bounds 反推 316/208 与导出画布 2013×1168 不符，画布含离台入场元素，以像素配准为准）+ select-pack 升 `bvn/select@2`（face/@win_cls + say_item 台词烘焙，50/53 角色）+ WinnerScene（帧 92 定格 + 胜者立绘 300×250 挂 f0（无立绘隐藏，原版 f0.visible=false）+ 气泡长大 + 台词 `|`→换行 SimHei 18 黑居中 + CONTINUE/EXIT 透明热区（视觉烘焙在帧 PNG 内）+ 音频链 BGM(null)→win 一发→6.5s→winloop）。net KO 1.2s 演出后进结算；训练模式维持对局浮层（训练语义不打断）。
- **格子动画**：tween 助手从 menu.ts 提取共享 anim.ts + TitleStream 泛化为 FrameStream（scenes/stream.ts，dispose 可保留显示帧防渲染崩溃）；buildList 入场（各格舞台中心 scale 0→1 Back.easeOut 0.3s + 随机 delay 0..0.2s）/ fadOutList 退场（回中心 scale→0 0.2s + 随机 delay 0.1s，0.3s 后换阶段）/ initMap 地图面板中心入场收编；光标与展示框延后 500ms 入场（原版 initSelecter setTimeout(_tweenTime)）。
- **UI 打磨池**：展示框长名按比例缩字（233px 名字区上限）；domInput 压暗遮罩 + 游戏风格描边/聚焦态。
- **偏离登记**：开场徽标去除（可选项）**决定保留**——徽标烙进原版帧美术（同切片 16 结论，去除代价大且保留更忠实）；结算页 MORE GAMES（外链）与 scoremc 计分板不挂载（无外链需求/无分数系统）；EXIT 略去二次确认对话框；net 模式 CONTINUE 隐藏（两端无法同步重开，只留 EXIT 回菜单）。
- **门禁**：build / core 135 / replay 6 剧本 --expect 零漂移（纯 app 层零哈希影响）/ batch:validate 58+37 全过；headless Edge CDP 冒烟（logo 帧播放→菜单流转 / 格子聚心→铺开像素探针 / winner 立绘+台词探针 / solo 回归 sim tick=386）+ 关键帧截图目检全过，控制台零异常。

### 切片 30——对局 HUD 原版化（✅ 2026-11-13）

用户目检发现对局内血条/气条仍是切片 5 的 PixiJS Graphics 占位件，立项收编 fight.swf 全 HUD（血条/大脸/能量条/计时板/气条/READY/辅助格/连击数）。
- **烘焙**：`tools/ui-pack/hud-pack.mjs`（FFDec sprite 帧序导出动件 + shape SVG 光栅化静件——JPEG3 直导 Alpha 损坏，同切片 15 技法）→ `packages/data/baked/hud.json`（27 元素：schema 含各件原版装配坐标/锚点/镜像标记/XFL 逆向坐标）；静件血条槽内 deco/红/绿填充按 mc_033 内部位移 (263.95,4.35)、内容 x[-260,0] 右锚语义定锚。
- **render FightHud**（`packages/render/src/hud.ts`，屏幕空间层）：设计空间 800×600、`fitZoom=min(viewW/1000,viewH/600)`，**逐元素钉边**——血条/大脸按左/右视口边钉、计时板居中、气条/READY/辅助格钉底、P2 侧容器 scale.x=-1 镜像（文字件双翻转保持可读、hits 不镜像）；XFL a=-1 与钉边数学对位逐件核验。
- **原版算法逐条收编**（AS3 FighterHpBar/QiBar/InsFzBar/EnergyBar/ActionState 语义）：绿条 scaleX=rate 直挂；**红条延迟**——HURT_ING/HURT_FLYING 置 delay=100、HURT_DOWN 首帧 90+justHurtFly 递减、差值 lerp（0.1/0.02 两档）+ 新伤害瞬间 snap；**气条** v=qi/100 clamp 3、4 段亮法 + 幽灵步标识（v<1 显、帧随 0.6 阈值）+ 段数 txt；**fzqi 条** scrollRect 底锚翻转揭示（Pixi Graphics mask 复刻 scale.y=-1）；**能量条** scaleX=energy/100 + 溢出满帧粘滞 + rate<0.3 每 3 渲染帧闪烁；**连击数** hit:connect 事件计数、>1 才显示、目标回位/倒地隐藏（位图数字左起 35px 步进）。
- **app 接线**：`loadHud`（baked/hud.json）+ 大脸 = select id+'_m'（102×64，getFighterFaceBar 语义）+ 辅助脸 = 辅助 id 50×50（getFighterFace 缺省尺寸语义）+ 能量标签帧 = comicType（0=死神 SPIRITUAL / 1=火影）。
- **偏离登记**：① 连击计数 = render 侧按 hit:connect + 目标 actionState 近似（原版 FighterEventCtrler.addHits 精确链不进 sim）；② fadin/fadout 进出场 tween 跳过，改 ~0.4s alpha 渐显；③ 能量条闪烁 = alpha 闪烁近似原版 fill 帧 1/2 交替；④ fzqi 满点闪烁点 = fzqi==满 近似原版 isCanHurtBreak；⑤ 计时恒 ∞（无回合时限语义）。
- **遗留池（§4.3 块 12 登记）**：startKOmc 开场 KO 字样、win 胜场星（p1Wins/p2Wins 恒 0）、scoremc 计分板、被动条 sp、picture_063 顶部装饰、shape_007 圆底数字"2"（回合指示）——均为无对应语义的展示件，按需另立项。
- **门禁**：build / core 186 / replay 6 剧本零漂移（纯 render+app 层零哈希影响）/ batch:validate 58+37 全过；有头 Edge Playwright 目检（初始态/近身连击/瞬步耗能）全过——qi 命中回气 25.6、瞬步能量 100→72→63、"3 HITS" 连击计数显示实证。headless rAF 节流致 sim 仅 ~3 tick/s，战斗态目检须有头驱动（`keyboard.press` 边沿陷阱同前：down/up 显式按住 60ms+）。

### 切片 31——进战斗加载画面（✅ 2026-11-13）

§4.3 块 9 收官（原版场景链 选人 → Loading → GameStage 的最后一段）。
- **烘焙**：`tools/ui-pack/loading-pack.mjs`（FFDec binaryData 提取 loading.swf → sprite/shape 导出 + sharp 光栅化）→ `packages/data/assets/ui/loading/`（bg.webp 800×600 舞台画裁切——sprite 47 导出画 1400×1050、舞台原点 (316,208)、stage (0,0) 处裁 800×600；track/fill/label 三张 shape PNG + spinner 30 帧 20×20）+ `baked/loading.json`（schema `bvn/loading@1`：bg/bar 各件原版装配坐标——bar 容器 @(17,555.1)、fill 填充锚左 scaleX、txt 右缘 761.95/14px 青 #00daf8）。
- **app LoadingScene**（`scenes/loading.ts`，原版 LoadingStage 语义）：装载队列照 build() 顺序——角色×2 → 辅助（去重）→ 场景 → BGM 预解码（新 `AudioSubsystem.preloadFightBgm`，原版 SoundCtrler.loadFightBGM 语义）→ 渲染纹理；消息 = `消息(n/总数)` 右对齐青色，进度 = fill scaleX（分步计数下插值逼近连续走动），spinner 30fps 循环，BGM('loading')。装载完成定场 600ms 后 `switchTo(BattleScene)`。
- **装载分帧化**：装载步间 `requestAnimationFrame` 让帧 + `renderer.load` 分步 onProgress（map→每角色/辅助/fire 图集→必杀逐帧→光效逐帧→大脸→hud 各计一步）——装载不再整段卡死主线程，进度条/spinner 持续走动。
- **renderer 首帧定位**：新 `prime()`（fitZoom×zoomFactor 相机摆位 + bgFixed cover + hud.layout）修换场景首帧 world@原点/bg 未 cover 的"进场黑边"；新 `setStageVisible()` 装载期隐藏世界/HUD 层（渲染层直挂 pixi.stage 晚于 uiRoot，创建后重提 uiRoot 到顶）。
- **交接协议**：`BattleLoadout { rig, renderer }`——LoadingScene 创建/装载/prime/隐藏 BattleRenderer 后移交 BattleScene（enter 只装配零装载、setStageVisible(true)；exit 销毁；未交接时归 LoadingScene 销毁）。三处入口改经 LoadingScene：setup（solo/net）、winner（再战）、main（dev ?mode=solo）。
- **偏离登记**：① 原版 `setTimeout(loadNext,1000)` 起步延帧对本地资源纯增延迟，省去；定场保留但 1000→600ms；② 原版 loadProcess 为单文件下载字节进度，web fetch 无字节回调，改分步计数进度；③ 原版加载页 ESC 呼出确认框返回主菜单，此处 ESC 直接返回；④ 渲染纹理装载原版并入 loadFighter 一步，此处单列分步回报进度。
- **门禁**：build / core 186 / replay 7 剧本 `--expect` 零漂移（sim 未触碰，免重冻）/ batch:validate 58+37 全过；headless Edge CDP 冒烟（loading 画面渲染 → 进战斗 `__bvnSim` 置位，控制台零异常）+ 截图目检（VS 舞台画/条形/转圈/右对齐青色消息、战斗首帧无黑边）全过。

### 修复批次 32——stop 触发收编（§4.3 块 10 收官，✅ 2026-11-13）

§4.3 块 10"MC 子元件采集修复"按登记要求先实验定位机制，结论**推翻登记前提**并顺带收编引擎缺口：

- **采集桥无罪（五轮诊断 AIR 运行定案）**：capture-only.txt 扩展 `diag:`（子元件播放头逐帧追踪）与 `probe:`（单独 gotoAndStop(k)+渲染+双哈希质询）过滤器。diag 证明 kenshin 走段子元件 instance519 在 `capAdvanceChildren` 驱动下正常推进（cf 1→2→3→4→1，无重实例化、无拦截）；probe 决定性证据 = 该子元件 4 帧 hash 全同（素材本身静态，49×36），对照组 instance516（站立 12 帧）hash 逐帧变化证明换帧美术采集正常。`capAdvanceChildren` 与原版 `FighterMC.renderChildren` 逐行一致。
- **fire 元件静态化证伪**：kj2mc = 36 帧全同（静态跑姿 + 单个静态 Shape——引擎靠变换矩阵移动它）；cbsmc/sbsmc/k4mc/zh2atm 等同族真静态；kbsmc（18 帧 uniq）/zh1atm（3 帧 uniq）实际有动画且已正确采集。批次 21F"ghost 时间轴递归步进"假设作废，无需重采任何包。
- **走段真相**：58 走标签 = 54 个 loop 触发（批次 22/30 已收编）+ 4 个 stop 触发（kenshin mc_030/mc_056、ulquiorra mc_059、naruto mc_0134[form4]）——原版语义 = 播到 stop 帧冻结滑行（动画前缀 + 定格），素材与机制均忠实。
- **引擎缺口收编**：全量普查 `stop`(target=mc) 150 处（胜利/失败各 58、跳招 15、必杀/砍技家族等）——原版三系控制器（FighterMcCtrler/FighterAttackerCtrler/AssisterCtrler）的 `stop()` 语义完全一致 = `stopRenderMainAnimate`（只冻结主时间轴，物理照常），帧脚本只在播放头进入时执行一次，`goFrame(isPlay=true)` 换标签解冻。收编实现：FighterState 新增 `mcHold`；`stop` 行为从误映射"清速度"（那是 `stopMove`/`move(0,0)` 语义）改为置 `mcHold`；`advanceAnimation` 冻结门（不采样不推进，判定区钉冻结帧）；解冻点 = `setLabel`/`setLabelTo`（换标签，同名重设不冲掉冻结——行走门每 tick 重设 走 不能解冻）+ startAttack/startSkill/startWanKai/onLanded(触地续接·落地)/switchForm。attacker 侧 stop→animHold 语义本已正确，辅助侧零 stop 触发。
- **触发帧空间教训**：baked 触发帧是 0-based 脚本索引（addFrameScript 参数），编译层 +1 转 1-based——kenshin stop baked@19 = 原版 frame20 脚本 = 1-based 帧 20，引擎在 animFrame 20 冻结为忠实行为。
- **偏离登记**：stop 冻结后原版 `renderChildren` 每 tick 照跑（子元件在冻结帧内继续动画），web 烘焙 PNG 为静态合成——属全引擎既有烘焙局限的时长放大，不处理。naruto mc_0134 走段原版 2.5 步后滑行、web 曾全标签循环（观感更好但非忠实），按用户决定忠实优先收编。
- **门禁**：core 135 测试全过；verify-drift 六剧本剔除 mcHold 后零真实差异（结构性字段新增）；batch 冒烟探针 4/58 角色（kenshin/ulquiorra 族）真实触发且冻结跨度有界（攻击即解冻）；新增 replay 剧本 `kenshin-stopwalk`（走停/松键解冻/攻击解冻/二次冻结四覆盖，探针验证 t30 冻结@走f20）+ 7 剧本全部重冻基线；batch:validate 58+37 重冻后全过。

### 修复批次 33——辅助头像黑块遮盖（✅ 2026-11-13）

用户验收发现辅助头像被黑色遮盖。根因：切片 30 hud-pack 误把 mc_025 facemc 的 SWF 深度序判反——按 shape id 大小认定 103（六边形框）为底、100（黑底）为顶，实际 SWF 深度序 = 黑底 shape 100（depth1）→ 裁剪 shape 101（clipDepth 5）→ ct 脸槽（QiBar 加 50×50 脸，被 101 裁剪）→ 六边形框 shape 103（depth6 顶层）。修复：hud-pack 三件改名为 face-assist-shade/mask/frame 重出资产（落位按各 shape bounds 补回 Xmin/Ymin：100→(0.55,0)、101→(0.5,1)、103→(0,1)）；hud.ts 按 SWF 深度序重装配，脸槽以 PIXI sprite mask（faceSlot.mask = faceMask）实现 shape 101 裁剪。sim 零触碰，门禁免重冻。

- **方法论**：FFDec shape SVG 画布裁到 shape bounds，PNG 落位必须按 bounds (Xmin,Ymin)（twips÷20）补回原点；shape id 序 ≠ 深度序，层级以 SWF PlaceObject 深度/clipDepth 为准。
- **门禁**：build 过；replay 4 剧本抽检 + batch:validate 58+37 全过（fires 工作区曾出现一批来历不明且剥掉 hits 的退化改动，已证实与基线无关并还原，见批次 32 段后注）；headless Edge CDP 冒烟截图目检——两侧头像立绘在六边形框内正常显示、裁剪正确。

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
| 5 | 菜单流打磨 | ✅ 收官：骨架（切片 14）+ 选人页原版化（切片 15）+ 菜单主页原版化（切片 16）+ Logo 演出/格子动画/结算立绘/UI 打磨池（切片 29）；开场徽标去除（可选项）决定保留（烙进原版帧美术） | app 层场景系统 |
| 6 | 街机模式 | mission.xml 关卡数据 + AI（FighterAICtrler 转译，~700 行，种子随机） | AI 是 PvP 路径外的唯一大块逻辑 |
| 7 | 音效/特效接线 | ✅ 前半（切片 26）：isSuper 必杀相机聚焦 + bisha/bisha_super 光效 + 相机自适应缩放（autoZoom 收编）；✅ 后半·事件驱动（切片 27）：音源五路提取（bgm/se/swc/fx/语音）+ baked/audio.json + AudioSubsystem（SE/BGM/语音防重叠/KO 双段音）+ voice 事件；✅ 余项·时间轴贴帧音（切片 28）：frame-sounds SWF 解析管线 + baked/timeline-sounds.json + handleTimelineFrames 帧进入触发。块 7 收官；遗留池：嵌套元件时间轴音 99 处（zh2mc/hitmc 演出件，需 ghost 时间轴，低价值按需立项） | 音效随机选音源在 app 层做，不进 sim |
| 8 | 本地双人 | 第二本地输入源 | 扩展项池，主线收尾后最后做 |
| 9 | 进战斗加载画面 | ✅ 收官（切片 31）：LoadingScene 原版 loading_fight_mc 演出 + 装载队列分帧化 + renderer.load 分步进度 + prime() 首帧定位（修"进场黑边"）+ BattleLoadout 交接 | 原版场景链：选人 → Loading → GameStage |
| 10 | MC 子元件采集修复 | ✅ 收官（批次 32，结论推翻登记前提）：五轮诊断 AIR 运行（diag 子元件播放头追踪 + probe 逐帧质询）证明 `capAdvanceChildren` 忠实可用——kenshin 走段子元件 4 帧同图（素材本身静态）、fire 元件 kj2mc/cbsmc 类 36 帧全同（静态贴图由引擎变换驱动）；批次 21F"ghost 时间轴递归步进"假设证伪，**无需重采任何包**。走段静止真相：58 走标签 54 个 loop 触发（已收编）、4 个 stop 触发（kenshin×2/ulquiorra/naruto form4）原版语义 = 播到 stop 帧冻结滑行。真正缺口 = 引擎未消费 `stop`（target=mc，全量 150 处：胜利/失败 116、跳招 15、必杀/砍技等）——本块一并收编：fighter `mcHold` 冻结门（stop 置位 / 换标签·开新动作·触地续接·换形态解冻；同名标签重设不冲掉冻结），`stop` 行为从误映射"清速度"（那是 stopMove）改为冻结主时间轴（原版三系控制器 stop() 均只冻结）。verify-drift 归因：6 剧本剔除 mcHold 后零真实差异；batch 冒烟 4/58 角色（kenshin/ulquiorra 族）真实触发且行为有界；新增 kenshin-stopwalk 剧本 + 全部基线重冻（sim 行为变更，非登记时预期的零漂移） | 批次 22 登记；批次 32 收编；冻结帧内子元件动画（原版 renderChildren 照跑）烘焙为静态合成，属全引擎既有 PNG 烘焙局限的时长放大，登记不处理 |
| 11 | 相机 autoZoom 视口基准 | ✅（批次 23 追补）：zoom 公式改用原版 GAME_SIZE 800×600 设计视口常量（`DESIGN_VIEW_W/H`），渲染可见区仍随纵横比铺满；逻辑基线 1000 维持不动（菜单用 1000 舞台坐标，16:9 下基线无视觉差异） | 批次 23 追补收编；render 层，sim 零哈希漂移 |
| 12 | 对局 HUD 余项 | 主 HUD 已原版化（切片 30）；余展示件：startKOmc 开场 KO 字样 / win 胜场星（p1Wins/p2Wins 恒 0）/ scoremc 计分板 / 被动条 sp / picture_063 顶部装饰 / shape_007 圆底数字（回合指示）——均无对应语义，按需另立项 | 切片 30 遗留池；render+数据层 |

---

## 五、下一步（按优先级）

1. **真机体验验证**（§4.1）——云服务器已部署（wss 冒烟通过）+ 切片 14/15/16 菜单/联机/选人 UI 已通，公网两端完整对局人工验收条件已齐（入口 `?mode=net&action=create&server=wss://120.48.185.202/`，页面上点选即可）；
2. **阶段 3 尾巴已收编完毕**（切片 21 收编 B1、切片 22 收编 B2、切片 23 收编 B5、切片 24 收编 B3、切片 25 收编 B4；余项仅 suigetsu isAttacking——唯一读者 AI，随 §4.3 块 6 一并处理）；
3. **§4.3 块 7（音效/特效）已收官**（切片 26/27/28）；阶段 4 余块按 §4.3 表顺序推进（下一块：断线处理 / 街机模式，开工前细化为切片并登记进 §二 明细表）。
