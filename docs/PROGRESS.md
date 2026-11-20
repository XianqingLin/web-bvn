# BVN Web —— 进度台账（PROGRESS）

> **唯一的进度记录**：开发顺序、各切片状态、遗留池与下一步。
> 切片收尾只改本文件；DESIGN 不再追加进度段。**与 DESIGN 的分工**：本文件记状态/遗留/指针；机制规格归 DESIGN §3.5；硬规则见 [ARCHITECTURE.md](ARCHITECTURE.md)。
> 本文件结构：§一 路线总览 → §二 切片明细表 → §三 已完成详情（摘要）→ §四 剩余工作规划 → §五 下一步。

---

## 一、路线总览

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 逆向梳理（模块地图） | ✅ |
| 1 | POC：单机对战闭环 + 训练模式 | ✅（切片 1~5） |
| 2 | 联机：lockstep + 房间服务器 | ✅（切片 6~7） |
| 3 | 批量化：全角色机制 + 验收门禁 | ✅ 主线（切片 8~12）；尾巴见 §4.2 |
| 4 | 体验完善：菜单流/原版化/实战修复等 | 🔄（余项见 §4.3） |
| 5 | 联机房间流：房间/匹配/联机选人/地图抽取 | 🔄（切片 34~38，设计已定案见 [netplay-design.md](netplay-design.md)，见 §4.4） |

门禁速记（每次收尾全过才算完成）：`pnpm build` + 确定性单测 + `tools/replay` 9 剧本哈希（**重冻后逐剧本单独 --expect，不看汇总**——批次 19 教训）+ `pnpm batch:validate`（58 角色 + 37 辅助，基线 `tools/batch-validate/baseline.json`）。行为有意变更 → verify-drift 归因后重冻全部基线并在提交说明写明。

---

## 二、切片明细

| 切片 | 内容 | 状态 | 详情 |
|---|---|---|---|
| 0 | 逆向梳理：BVN-module-map（183 文件 / 28k 行本体 / 61 角色 / 37 辅助 / 15 地图） | ✅ | [BVN-module-map.md](BVN-module-map.md) |
| 1 | harness：core 骨架 + 确定性单测 + `tools/replay` 哈希门禁 | ✅ | DESIGN §9 |
| 2 | 导出/数据管线：dump 桥 + runtime-ingest（58+37 包，115,279 判定区帧，与 XFL 交叉验证零漂移）+ 地图 JSON 15 份 | ✅ | DESIGN §9；orihime/yachiru actions 空 XFL 兜底（§4.5） |
| 3 | core 最小闭环：7 态状态机 + 判定区 + 命中结算 + 推挤 + 地图接线 + behaviors op 注册表 POC | ✅ | DESIGN §3.5 |
| 4 | 图集管线（AIR capture 桥逐帧栅格化）+ render BattleRenderer + app dev 预览页 | ✅ | DESIGN §4 |
| 5 | **阶段 1 收尾**：防御/瞬步/技/必杀/能量/连段槽 + 相机 clamp/floor 遮挡/HUD + 训练模式 | ✅ | DESIGN §3.5/§9 |
| 6 | 联机地基：`InputSource` 抽象 + lockstep + `packages/net` + ws e2e | ✅ | DESIGN §9.7 |
| 7 | **阶段 2 收尾**：`room-server.mjs` + `startSession` + app create/join 入口 | ✅ | DESIGN §9.8；云部署见 §4.1 |
| 8 | fire 飞行道具原语 + 行为 op 词表 Tier-1 | ✅ | DESIGN §3.5 |
| 9 | 目标系/摔技/独立道具/万解/AIR 槽/近战回气资源 | ✅ | DESIGN §3.5 |
| 10 | 逐区命中/跳跃家族/瞬身步家族/万解形态切换（词表 Tier-2 收尾） | ✅ | DESIGN §3.5 |
| 11 | 全角色批量化验收（`tools/batch-validate`）+ 条件触发器语义修复 | ✅ | DESIGN §3.5 |
| 12 | 辅助系统：fzqi/召唤流程 + Assister 实体 + buff 结算 + 门禁扩展；`teleport` 不移植（ADR） | ✅ | DESIGN §3.5 |
| 13 | 演出/数据审计收紧 A1~A6（辅助图集/地图层对位/bullet 接入/attacker 接线/道具寿命/辅助 addAttacker） | ✅ | §三 |
| 14 | 场景流转骨架：AppHost/SceneHost + 菜单/选人/战斗/结算 + 联机 pick 交换 + select-pack | ✅ | §三 |
| 15 | 选人页原版化：ui-pack 资产管线 + SetupScene 原版布局换肤 | ✅ | §三 |
| 16 | 菜单主页原版化：stg_title 90 帧流播 + wzbtn 阶梯按钮组 + MenuScene 重写 | ✅ | §三 |
| 21 | 阶段 3 尾巴·B1：byakuya 抓取链 + customFunc 单槽 + attacker 元件脚本分派 | ✅ | §三 |
| 22 | 阶段 3 尾巴·B2：必杀/万解切人插图——core 冻结锁 + bisha-pack 素材管线 | ✅ | §三 |
| 23 | 阶段 3 尾巴·B5：独立道具逐帧命中矩形（attacker 原点锚定 + 86 元件采集） | ✅ | §三 |
| 24 | 阶段 3 尾巴·B3：空中必杀 `kbs` attackId 映射补齐 | ✅ | §三 |
| 25 | 阶段 3 尾巴·B4：temari 风场 windField 数据化 + 弹速级派生 | ✅ | §三 |
| 26 | 阶段 4·块 7 前半：isSuper 相机聚焦 + bisha 光效 + 相机 autoZoom 收编 | ✅ | §三 |
| 27 | 阶段 4·块 7 后半：音效接线（sound-pack 五路音源 + AudioSubsystem + voice 事件） | ✅ | §三 |
| 28 | 阶段 4·块 7 余项：逐帧时间轴贴帧音（自研 SWF 标签解析 + handleTimelineFrames） | ✅ | §三 |
| 29 | 阶段 4·块 5 收官·菜单流打磨：Logo 演出 + 结算立绘/台词 + 格子动画 + UI 打磨池 | ✅ | §三 |
| 30 | 阶段 4·对局 HUD 原版化：fight.swf 27 元素烘焙 + FightHud 钉边组件 + 原版算法收编 | ✅ | §三 |
| 31 | 阶段 4·块 9·进战斗加载画面：loading-pack + LoadingScene + 装载分帧化 + BattleLoadout 交接 | ✅ | §三 |
| 32 | 阶段 4·intro：开局特写+语音演出（GameStartCtrler.start1v1 收编，Btn.back 元层键） | ✅ | §三；规格 DESIGN §3.5/§5 |
| 33 | 联机迁移平台中转（方案 A）：RelaySocket + openPlatformSession + 嵌入构建（⚠ 同日晚方案 A 作废，处置见 §4.4 切片 34） | ✅/作废 | §三 |
| 34 | 联机房间流：房间语义协议 + 房间页 + 方案 A 遗留处置 | ✅ | §三；§4.4 / [netplay-design.md](netplay-design.md) |
| 35 | 联机房间流：选人页双光标（cursor 同步/选中即锁/团队 3+1）+ 对局侧 3+1 装配（尾巴） | ✅ | §三；§4.4 |
| 36 | 联机房间流：地图阶段（房主选择 / 开箱抽取 + 服务器权威种子） | ✅ | §4.4 |
| 37 | 联机房间流：随机匹配队列 + 浏览房间 + VS 横幅 | ✅ | §4.4 |
| 38 | 联机房间流：平台接缝（身份凭证/邀请深链/资料接入） | ⬜ | §4.4 |
| 39 | 本地双人：主菜单 LOCAL PLAY 入口（1v1/团队子菜单）+ 选人页双键盘双光标 + 对局双键盘输入源 | ✅ | §三 |
| 41 | 场景链打磨：GameLoadingStage"绊"初始化封面 + 黑幕转场 transIn/transOut + 加载页双方已选面板 + 选人布局行 offset/悬浮板修正 | ✅ | §三 |
| 46 | 1v1 终局演出收编：KO 字样窗口 + 败方/胜方特写镜头 + KO/Winner/Perfect 字样 + 胜利星 + 结算流转收编进 sim（roundEnd 状态机泛化） | ✅ | §三 |

修复批次（17~24、21F、30~33、34~38、40 编号混用于切片序号，以 §三 为准）。

---

## 三、已完成详情（摘要）

> 做了什么/修了什么/留了什么，每条 ≤3 行；实现手法看 commit 说明与代码注释，机制规格看 [DESIGN.md](DESIGN.md) §3.5，切片划分理由看 DESIGN §9。

- **切片 13**（✅ 2026-11-11）战斗演出补齐 A1~A6：辅助图集/地图层对位/子弹图集与渲染接入/独立道具接入渲染与生命周期/辅助召唤吸附道具；顺带修步内跳转播放头吞帧 bug。审计 11 项定档，最大项 byakuya 抓取链 → 切片 21。commits 42b4078 / 6764029 / a000727..28b70f8 / 412a02d / b898d4c / a2ae411。
- **切片 14**（✅ 2026-11-11）场景流转骨架：菜单→选人→战斗→结算 + 联机 pick 选人交换 + `tools/select-pack`（53 角色/40 辅助/15 地图）。commit 3e57c26。遗留：more= 形态切换未实现、重开局仅 solo（net CONTINUE 隐藏）→ §4.5。
- **切片 15**（✅ 2026-11-11）选人页原版化：ui-pack 资产管线建立（FFDec 元件导出 → assets/ui/ + baked/ui.json）+ SetupScene 原版布局。commit 1fe5de9。偏离：光标静帧、系统字体、more= 黄框交互未实现。
- **切片 16**（✅ 2026-11-11）菜单主页原版化：stg_title 90 帧 WebP 流播（显存流播：常驻窗口+预取）+ wzbtn 阶梯按钮组 + 键盘导航。commit 1018f3a。偏离：系统字体、开场淡入加速、背景徽标保留（烙进原版美术）、BGM 归音效块。
- **批次 17**（✅ 2026-11-11）实战验收第一：相机垂直 clamp/endAct 语义（不动播放头）/持久阻尼/朝向分流/连段清槽/防御定格 6 项全修。前两者固化进 DESIGN §3.5。commit f9ce6c8。
- **批次 18**（✅ 2026-11-11）跳跃/动作永久锁死：jumpTimes/动作槽无恢复路径 → 落地与回待机补槽 + 标签维护门控；4000 局模糊测试零死锁。基线重冻。commit c35fa78。
- **批次 19**（✅ 2026-11-12）参数忠实性审计 + 重力修正：移动/跳跃/渲染逐项对照原版无误，唯一偏差 = 重力步长 0.6→0.3。教训固化规程：重冻后逐剧本单独 `--expect`。commit 5e5f753。
- **批次 20**（✅ 2026-11-12）落地滑步 + 必杀黑屏 + 上键打断：行走物理标签门 + labelLock 清锁；必杀 1 帧桩截断 → **时间轴顺流**（家族性修复）；缓冲 ↑ 打断修复。commit dc3efbb。
- **切片 21·B1**（✅ 2026-11-12）byakuya 抓取链完整落地 + 支撑机制（辅助 customFunc 单槽、attacker 元件脚本分派、辅助 loop 同标签 rewind 保活）。commit e395a87。
- **切片 22·B2**（✅ 2026-11-12）必杀/万解切人插图：core 冻结锁 cutinLock（锁主失联保护性解锁防软锁）+ `tools/bisha-pack`（71 帧横幅 + 92 立绘）+ render 黑幕/横幅/立绘。
- **切片 23·B5**（✅ 2026-11-12）独立道具逐帧命中矩形：attacker 元件原点锚定 + dump 桥扩展采集 86 元件（org/hits）+ `tools/b5-pack` 合并；顺带收编 madara miss 卫语句 / itachi 动态伤害。遗留：歧义 6 例抽样核对未做。
- **切片 24·B3**（✅ 2026-11-12）"空中必杀纯表现无判定"系误记（逐区解析不依赖 attackId），真缺口 = data 缺 `kbs` 映射，已补；全角色核实空中必杀链已通。
- **切片 25·B4**（✅ 2026-11-13）temari 风场：windField customFunc 数据化 + 弹速级派生求值（零新增状态字段）+ `buffSpeedUpByOwnerSpeed` 惯用语修复 + 导出器两模板。新增 temari-wind 剧本。
- **工具治理**（✅ 2026-11-12）双哈希 + 漂移归因：replay 改冻 `behaviorHash`（表示层改动免重冻）+ `tools/replay/verify-drift` 归因工具（dump 子进程化）；规格 DESIGN §3.8。
- **批次 21F**（✅ 2026-11-13）形态角色选入 404：select-pack 烘 swf 基名（形态角色 ≠ id）+ app 全链按基名取包；追补 startFrame 缺省形态对位（58 角色零例外）+ 万解切形态 rootFrame 寻址。遗留：基线无 XFL 编译差异 → §4.2；佐助防御模糊 → §4.5。
- **批次 22**（✅ 2026-11-13）走循环点 + 防御恢复冻结：loop 触发点收编（54/58 走标签）+ 防御恢复 = 原版冻结 2 tick 非播整段；verify-drift 假阴性修复。待定项：站立静态单帧忠实性 → §4.5。
- **批次 23**（✅ 2026-11-13）切人插图两处：横幅横向拉伸铺满 visW（原版内容恰 800 宽）+ 立绘 canvasOrigin 双减修正；追补 autoZoom 视口基准常量化（DESIGN_VIEW 800×600）。
- **批次 24**（✅ 2026-11-13）防御后攻击/防御永久失效：防御恢复转换点补 idle 回调重填槽（与批 18 同族缺陷的另一路径）。verify-drift 归因后重冻。
- **切片 29**（✅ 2026-11-13）菜单流打磨收官：Logo 演出（LogoScene）+ 结算立绘/台词气泡（WinnerScene）+ 格子入场退场动画（anim.ts/FrameStream 共享化）+ 长名钳制/DOM 输入样式。偏离：MORE GAMES/scoremc 不挂载、EXIT 无二次确认、net CONTINUE 隐藏。
- **切片 30**（✅ 2026-11-13）对局 HUD 原版化：fight.swf 27 元素烘焙（hud-pack：sprite 帧序 + shape SVG 光栅化）+ FightHud 屏幕空间钉边组件 + 红条延迟/气条 4 段+幽灵步/能量溢出闪烁/连击数算法逐条收编。余展示件 → §4.5。
- **切片 31**（✅ 2026-11-13）进战斗加载画面：loading-pack 烘焙 + LoadingScene（原版装载队列语义）+ 装载分帧化（步间让帧）+ `renderer.prime()` 首帧定位 + `BattleLoadout` 交接协议（setup/winner/main 三入口改经 LoadingScene）。
- **批次 32**（✅ 2026-11-13）stop 触发收编：五轮诊断证明采集桥无罪（素材本身静态，ghost 时间轴假设证伪），真缺口 = 引擎未消费 `stop`（target=mc 全量 150 处）→ `mcHold` 冻结门收编（解冻点：换标签/开新动作/触地续接/换形态）。教训：baked 触发帧 0-based 脚本索引。
- **批次 33**（✅ 2026-11-13）辅助头像黑块遮盖：hud-pack 误把 shape id 序当深度序，按 SWF PlaceObject 深度序重装配 + sprite mask 裁剪。方法论：shape id 序 ≠ 深度序，PNG 落位按 bounds 补回原点。
- **批次 34**（✅ 2026-11-14）多段命中收编："attacker 单次命中"错误前提拆除（原版靠受击 4 帧窗限频）+ 钢身 doSteelHurt 完整收编（破钢走完整 doHurt/减伤 65%/受击窗/耗能/击退）。方法论：拆限频门前先核实受击窗完整。sim 变更，双基线重冻。
- **批次 35**（✅ 2026-11-14）命中特效 + 命中停顿：hitstop `freezeTicks`（进哈希；freeze 早退 tick 照跑 stepInputs，否则吃连段窗口）+ hitspark 火花（hit-pack，钉点 = 判定区∩身体区中心）+ shake/shine 收编。遗留：EffectCtrler 未消费项 → §4.5。
- **批次 37**（✅ 2026-11-14）超必杀 blend 贴图：采集桥拆 `parts`（blend 子对象单独采）+ atlas 透传 + renderer 混合映射。注：pixi 8.22.0 高级混合打包缺陷当时未暴露，批次 40 修复后 hardlight 特效一并生效。
- **批次 38**（✅ 2026-11-14）受击无敌窗单位换算：原版 30fps 渲染帧 → 60Hz tick ×2 同律修正四处（HURT/STEEL/DEFENSE GAP）；顺带登记 GROUND_FRICTION 滑步差 → §4.5。sim 变更，双基线重冻。
- **HUD 能量条宽屏延伸**（✅ 2026-11-14）：bg 三段式切片（端盖 12px 固定防拉丝）+ fill 随 ext 拉长；3.6 对照检查结论一并登记（HP 数字 = 3.6 新特性按需立项）。
- **切片 32·intro**（✅ 2026-11-14）开局特写+语音演出：`Btn.back` 元层键（不进缓冲器）+ `SimState.intro` 缺省省略（零重冻）+ INTRO_ING 冻结语义（回气照跑）+ startKOmc 字样 + render camFocus。规格 DESIGN §3.5/§5。
- **批次 40**（✅ 2026-11-16）蓝染实测三连：① pixi 8.22.0 高级混合打包缺陷（补 `import 'pixi.js/advanced-blend-modes'` + `useBackBuffer: true`）；② 攻击起手清残速（NORMAL 起手清 vx/dampX，链段衔接与空中攻击不动）——sim 变更双基线重冻；③ shine 触发补消费。砍 3 位移不改（数据忠实，滑行修复后复测）。
- **切片 33**（✅ 2026-11-16，⚠ 同日晚方案 A 作废）联机迁移平台中转：RelaySocket 适配层（welcome/start 本地合成、peer-lost 差分、pick/input/hash 透传）+ openPlatformSession + app 接线 + 嵌入构建（prepare-dist、相对路径）+ net 18 单测。**方案 A 作废后迁移代码留存，处置归切片 34**（room-server.mjs 回归游戏自有定位）。顺手修复：waitPeerPick 丢 pick.map。
- **切片 34**（✅ 2026-11-17）房间语义协议 + 房间页 + 方案 A 遗留处置：① room-server.mjs 扩展（room-info 快照广播/room-config/ready/begin 校验准备门/掉线清理按 §10；start 两段语义：begin=进选人、hello 收齐=开跑）+ protocol.ts 词表（房间语义 4 条 + UI 同步占位 cursor/map-pick/map-roll）+ session.ts 房间助手 + server 11 单测（node --test 子进程起服）；② app：NetScene 回自有服务器路径（serverUrl localStorage 记忆 + BufferedSocket 包装）+ RoomScene 房间页（房主常备/开始门/三项设置/客座准备切换/房间码/邀请占位，room-info 快照驱动渲染）；③ 方案 A 处置：platform.ts + platform.test.ts 删除（回退），RelaySocket 的 pick 竞态兜底收编为 BufferedSocket（net 6 单测，含 2 条竞态回归自 platform.test 移植）。实现取舍：快照单一通道（room-config 仅上行，状态统一经 room-info）；房间默认设置 private+房主选图+单挑（设计稿未定案）。
- **切片 35**（✅ 2026-11-17）选人页双光标：① SetupScene 联机分支重构——本端光标跟随鼠标 hover（原版键盘驱动不移植，netplay-design §7 已注明），hover 变更即 cursor 广播（去重 + 安全发送）；对端光标以对侧纹理渲染、对端展示盒实时跟随其光标；② 选中即锁：点击即锁定无反悔，随机项此刻解析成具体角色后按最终项同步，锁满份额后本端光标冻结；双色锁定框（P1 蓝/P2 粉，本端内框/对端外框）；③ 双方齐套本地推导推进（角色 → 援助 → 地图），地图尾沿用最终 pick（map 仅 P1，P2 选满收到即进加载页，两端完整性守卫防误放行）；④ 团队模式 3 选 + 1 援助（selectTimesCount=3，同角色/自身重复允许），pick 改累计快照覆盖式上行（fighters[]/assists[] 按锁定次序，3s 重发幂等），flow 增 team/localTeamPick/peerTeamPick；⑤ 断线按 §10 提示后回主菜单（消息泵常驻接管 socket，移交加载页时脱钩）；随机项联机解禁（原禁用）。遗留：对局侧 3+1 装配未接（原版 GameRunFighterGroup/换人 ~250 行），团队累计选人暂以首名进 1v1 对局（→ 切片 35 尾巴已接）；地图阶段实时跟随/开箱抽取归切片 36。server 补 cursor/locked-pick 透传单测（12 条）。
- **切片 35 尾巴**（✅ 2026-11-17）对局侧团队 3+1 装配：① core——`SimConfig.teams { p1, p2 }`（出场序 id 表，构造器校验唯一且可寻址）→ `MatchState.teams` 槽位抄录（`TeamSlot` 含 x/y/comicType/assistId/formIndex/hp，换人只依赖 SimState、fromState 免重注入）+ 仅队首进 fighters（严格 2 活跃模型）+ `SimState.roundEnd` 状态机（KO 即置位——1v1 不置零漂移；等胜方收尾 isAllowWinState 门 → WIN_ING+胜利+血量恢复 0.33 → hold 180 计满；Btn.back 全程可跳）+ `rotateIn` 换人（pending 出队、全新满血 FighterState、气继承 lastLoserQi+同 comicType+100 封顶 300、双方回出生点、清场 despawn、beginIntro(入场方)）+ draw 同拍双 KO 改判与双侧轮换 + 终局 `match:over`+over 冻结；② render——roster 全员精灵按 fighter id 预载 id-swap（bench 不可见复用 + 入场即换免重绑图集）+ HUD teamFighters 大脸/能量标签按 id 寻址换脸；③ app——fighterId(side,i)=1,3,5/2,4,6 交错编号即 sim id，roster 全员 FighterConfig + teams 装配（solo/net 双路径），team 模式 fighter:ko 不切场景、match:over 后 600ms 进结算，ESC 演出期=跳过/演出外=返回菜单；configHash 增 teams 指纹（roster 序两端一致）。core 8 单测（装配/KO→换人/气继承同系加成/skip/败方耗尽/两轮打满/确定性/1v1 零漂移）。规格 DESIGN §3.5 团队回合流（偏离登记：固定 180 tick 演出+全程可跳、无计时器恢复常数 0.33、draw 双侧轮换以首个败方气计、入场方 focus 时序 ±18 tick）。
- **切片 39**（✅ 2026-11-17）本地双人：① 菜单——LOCAL PLAY 顶层项（原版单人/双人并列形态）+ 1v1/团队两子项；进选人页前重置 `flow.player=1`（防联机客座残留）；② 选人页——复刻原版 `isVsPeople()` 双光标语义搬回同一台键盘：P1 = WASD 移动 + J 确认，P2 = 方向键移动 + 小键盘 1 确认，互不阻塞；鼠标不参与选人（一台机器只有一个鼠标，地图轮盘共用）；复用联机双光标状态结构（localLocked = P1 / peerLocked = P2）与锁定推进（选中即锁/随机项确认时解析/双方齐套本地推导/团队 3+1），仅去网络收发；锁定逻辑抽 lockOwn/lockPeer 供联机与本地共用；导航表按 row,col 行主序 + 阶段 token 门禁（装料/过渡窗键盘输入忽略）；地图阶段 = solo 鼠标轮盘共用 + P1 键盘（A/D 翻页 J 确认，地图归 P1 定同联机房主）；③ 对局——`LocalKeyboardSource`（P1/P2 键位图同帧进 sim），P2 键位补齐为小键盘方案（Numpad1攻击 2跳 3瞬步 4技 5必杀 6辅助，e.code 物理键位 NumLock 无关），spawnSim(false) 真对局（intro + KO → 结算立绘，CONTINUE 本地可用重开）；④ dev 直通 `?mode=local2p`（选人页目检，不自动确认）。偏离登记：地图阶段 P2 无键盘操作权（鼠标共用可越权点击，沙发社交默认容忍）；SIM 无改动（9 剧本哈希 + batch 基线零漂移复跑确认）。
- **批次 41**（✅ 2026-11-17）本地双人实测三修：① 悬浮卡死——isApplyG:false 命中（白哉 tk 摔投/援助 atm1，全角色数据仅此二处）后 `recoverToNormal` 不复位 applyG → 空中受击计时恢复后重力门永久跳过悬浮卡死；修复 = recoverToNormal 恢复 `applyG=true`（原版 idle 链 setInAir 语义）；真实数据矩阵回归（byakuya 全招式 × 8 空中前置 → 落地回 idle）入 data/test/hurt-recovery.test.ts，core 另有合成回归；② 原版无惯性跳跃——起跳发射清 vx/dampX（原版 FighterMain.jump setVelocity(0,-jumpPower)；此前保留走跑 vx 致空中漂移 + 落地 labelLock 窗口无摩擦匀速滑行），批次 40"砍 3 位移"之滑行问题就此收口；③ 开场字样时机——INTRO_RESUME_TICKS 6→30（偏离登记：原版 0.1s 后字样即出，移植版镜头 3.5→1 缓动 ~0.5s，30 tick 让镜头回正再出字样）；另查明原版无 Round/Fight 播报语音（swc 资源仅有角色开场台词，移植版已播）。sim 变更，batch 基线 + ichigo-duel/intro-duel replay 基线重冻。
- **批次 42**（✅ 2026-11-17）空中硬直恢复落地滞留 跳中：空中被打（硬直）计时在空中走完 → `recoverToNormal` 空中分支回 NORMAL+跳中 → 落地时 `onLanded` 状态门只认 JUMP_ING、无人接管 → 滞留 跳中（循环标签，endAction 不可达）：浮空姿势定格 + 行走门（站立/走 标签族）失效；修复 = `onLanded` 增按空中姿势标签（起跳/跳中/落，isAirPose）识别空中恢复落地，同走落地恢复分支（槽/jumpTimes/airHitTimes 重填）。回归 2 条入 core hurt-recovery.test.ts。新行为仅命中新场景：9 剧本 replay 哈希 + batch 基线零漂移复跑确认（无需重冻）。
- **切片 45**（✅ 2026-11-19）选人页嵌套动画收编 + 主菜单嵌套动画尝试后回退：① **select 侧收编**——fx.ts 叠加层播放器（板帧驱动显隐/位姿，内部播放头独立走带；gotoAndPlay 跳板帧不复位播放头、移除即暂停、重新放置从帧 1；skip 只跳板帧播放头照走，原版语义）；ui-pack swf2xml 手术剔旋涡 71（sprite 72 内 105 帧循环，放置 redAdd −255 → 烘焙期红通道清零精确等价）与 select_map 内 93 扫光/96 箭头×2（d3 正/d5 镜像）/99 kuang → "干净底板"重导合成回原画布（alignCleanPlate：FFDec 画布随内容 union 缩小，静态区模板匹配对齐补齐）+ 嵌套元件帧序独立烘焙 assets/ui/select-fx/（位置模板匹配实测校准；kuang 落点交叉验证门禁：偏离静态 kuang 偏移 (92,19) 即抛错）；setup.ts 旋涡/地图面板接线；② **title 侧尝试后回退**——曾实施 title 嵌套叠加层（10 元件 title-fx + z 序双板 low(d1,d2)/high(d27..d40)），验证残差无法收敛，外科手术回退（menu.ts 双流/叠加层、ui-pack title 手术与烘焙段、data.ts title fx 类型、assets title-fx/title-high 全删；select 侧与 swf-nest.mjs 的 contentBounds 修复保留）。根因三条沉淀 → §4.5。ui.json schema bvn/ui@4；SIM 零改动：replay 9 剧本 + batch 基线零漂移复跑确认。
- **批次 44**（✅ 2026-11-19）六项实测修复（用户报告）：① **特效慢放**——`battle.update` 把 sim 剩余累积器（0~16.7ms 锯齿，均值≈半个 tick）当渲染 dt 传 `renderer.update`，违反其"dtMs=自上次调用以来的毫秒数"契约 → 特效/插值以约 0.5× 速度爬行且帧率越低越慢，lockstep 等待期累积器冲高又异常快进；修复 = 传真实帧时长（钳 100ms），渲染层调用改为无条件每帧。② **闪屏太亮**——`updateShines` 误用 ×0.95 指数衰减（~2.5s 淡出）vs 原版 ShineEffectView 线性 `_loseAlpha=renderGap+1=0.04`/15fps 步（~0.46s）；改线性衰减并补暗色 → darken 混合 + alpha×0.8 分支（原版 init 半亮度阈值 0x7fffff）。③ **主菜单动画循环**——（已回退）本批曾据"title.swf 二进制标签解析"把 menu 相位机改整窗循环，该核对结论错误：FFDec 脚本导出实证 stg_title 主时间轴有 `addFrameScript(49/74, stop)`（intro 播到 50 定格、menu 段 65..75 播到 75 定格），不循环；用户可见的"部分循环"来自嵌套 MovieClip（背景/人物/logo 等子元件默认持续循环），烘焙帧快照不含此动画 → 播完定格语义正确，menu.ts 已回退本批改动；嵌套动画维持切片 41 登记项。④ **选人页确认按钮移除**——点击角色/辅助格子即选中并推进（原版点格子即锁语义；联机/本地双人本就选中即锁），地图页点击本就自动推进，`mountConfirm` 全删；transitionPhase 期间防连点守卫。⑤ **空中机动**——原版起跳即 `airMove=true`（renderJumpAnimate → setAirAllAct），空中左右与地面同速直接位移、攻击中同样生效、不转向；移植版此前除飞行系外空中完全忽略水平输入。修复 = `applyJumpLaunch` 置 airMove + physics 行走门空中分支（airMove 且非 HURT_FLYING，不受地面标签门约束）；脚本化位移接管期关 airMove（原版 move() isInAir&&x≠0 语义；dash 偏离登记：原版空中瞬步期间两者叠加，移植版统一进 vx 后叠加不可行，取脚本优先）；新增 `hurtHeavy` 状态位。⑥ **击飞落地特效 + Round 字样居中**——落地尘土收编：hit-pack 扩烘焙 EffectModel.initEffects 通用 7 元件（jump/jump_air/touch_floor=luodi/hit_floor/hit_floor_low/hit_floor_heavy/hit_floor_yan 烟，blendMode 逐条对照）+ renderer 通用特效事件消费（effect id 命中烘焙表即走火花管线 + shake 事件 doShake 双形态）+ core 落地 emit（普通落地 touchFloor 原版控制器级无条件语义、击飞落地按 hurtHeavy=hity>5（HIT_DOWN_BY_HITY，原版 _isHeavyDownAttack）分 hit_floor / heavy+yan + shake(vecy 夹 [3,8])；被击飞落上层平台 = 原版同规则（NO_TOUCH_BAN_ON_VECY=5×SPEED_PLUS=2.5 穿透阈值，FALL_LAND_SPEED 已对齐），不改）；Round 字样 center 钉扎 + ROUND_CENTER_DELTA 39.5（组合包围盒 x199..522 中心 360.5，原版 800 宽内本身偏左 39.5px，宽屏 left 钉扎放大偏移——用户实测）。SIM 行为变更（空中机动 + hurtHeavy）：batch 基线 + replay 9 剧本重冻复验全过，core 163 单测过。

- **切片 36**（✅ 2026-11-17）地图阶段：① 服务器——begin 广播 start/room-info 后追加 map-roll { seed }（权威种子，randomInt(1,2³¹)；不区分 randomMap 设置恒发）；② flow 增 randomMap（room-info 快照随 team 同步）与 mapSeed（map-roll 到达写入；solo/local enter 时清残留）；③ 选人页地图阶段分流——**房主选择**：房主轮盘每次切换 map-pick 广播（随机项广播键 'random'，确认仍走 pick.map 房主侧解析），客座渲染同款只读轮盘实时跟随；**开箱抽取**：两端播同一动画（缩略图长条 = 地图序列×3，行程 easeInOutQuint ~3.4s + 定格高亮 0.8s ≈ 4.2s，偏离登记：单段缓动近似规格分段），定格 = maps[|seed|%n]，不可跳过/重抽，定格后两端各自独立进加载页（时长确定性一致，无需握手）；④ 种子进 configHash——battle spawnSim 与 hello 指纹改用 flow.mapSeed ?? 1（net 端双端一致；solo/local 恒 1，replay/batch 基线不动）。server 12 单测（map-roll 同种子断言 + map-pick 透传）。规格：netplay-design §8 实现定案段。
- **切片 37**（✅ 2026-11-17）匹配队列 + 浏览房间 + VS 横幅：① 服务器——per-连接状态由闭包变量改记录对象（配对需跨连接写槽位）；queue 入队满 2 即配对（FIFO 序定 P1/P2）、unqueue/掉线/自行入房出队；**配对即开局**（偏离登记：原定"matched 后走 create/join 等价路径"收敛为服务器直接开房置开局段——双方同一条连接收 matched+start，免房间页/准备门，少两轮 ready/begin 往返）；matched { room, player, team:true, seed, opponent:{name} }（seed 即权威抽取种子兼 sim seed，匹配路径无独立 map-roll）；list-rooms 轮询 → room-list { room, host, team, joinable, started }（公开房快照，started 区分已满/已开局）；② app——net-common.ts 抽提服务器地址行/建连/昵称助手（NetScene 收敛为创建+房码加入页）；MatchScene（随机匹配页：待机 → 匹配中按钮 + 红 ✕ 滑出一次点击取消 → VS 横幅（buildVsBanner 导出复用，头像暂以位次色块占位——平台头像归切片 38）→ 横幅满 2.5s 且 start 到达移交选人页；断线/对端掉线 → "连接失败，正在重新匹配" 1.2s 自动重连重排，横幅期 ✕ 仍可取消）；BrowseScene（浏览房间页：2.5s 轮询 + 行点击加入，加入失败恢复泵轮询，错误码原样提示）；菜单 NET PLAY 子菜单 4 项（创建/浏览/随机匹配/加入房间——房码入口保留作私人房与切片 38 邀请深链兜底）；dev 直通 ?mode=match / ?mode=browse。③ server 18 单测（配对种子/位次/固定 team、退队与掉线出队、列表过滤、在房 queue 忽略；测试助手修复：next 超时残留死 waiter 吞后续消息）。SIM 零改动：replay 9 剧本 + batch 基线零漂移复跑确认。规格：netplay-design §6/§9 实现定案段。
- **部署性能排查 + 图集去重**（✅ 2026-11-17）：① 排查——"从平台进游戏主菜单卡成几帧"根因 = 部署服出口带宽 ~3Mbps（实测单流持续 380KB/s 稳定、与并发连接数无关；标题流显示范围 6.5MB ÷ 380KB/s ≈ 17s vs 动画 1.6s），此前客户端侧预取/停帧/双缓存修复均绕不开带宽墙；顺带量得对局资产（单角色均 3.8MB/大体型 12.2MB）3Mbps 下加载 25-75s，归平台/带宽议题（升带宽 or 场景级预载，待定）。② 图集去重——形态派生角色（naruto_sennin/ichigo_bankai 等 11 组）sheet 与基础角色逐字节相同（同一 swf 同一 sprite 导出），仅 atlas.json 的 id 与文件名前缀不同：新增幂等工具 `tools/atlas-dedup.mjs`（atlas-pack/webp-convert 重产出后重跑），重写 20 个 atlas.json 的 sheets[].file 指向基础角色文件并删除 417 个重复 sheet，fighters 219.6→95.9MB、assets 全树 ~259→~135MB，零代码改动（bvn/atlas@1 帧按 pngId→sheet 索引引用）；顺带可变形角色对局加载减半。③ FrameStream 增显示区间 spec.from/to：预下载/预取只覆盖实际显示帧（menu 帧流 1、76-90 从不显示 ~1.6MB 不再拉；logo 跳帧 1）。assets 不入库，服务器需按更新流程重传 fighters 目录。门禁：build / 单测 / replay 9 剧本 / batch 基线全过（SIM 零改动零漂移）。
- **切片 41**（✅ 2026-11-19）场景链打磨（对照原版截图差异收口）：① 菜单悬浮板——MenuBtn 常态不再挂板（烘焙缺陷修正：mc_wzbtn 常态帧导出把原版 `ui.bg.visible=false` 隐藏的 bg 子件烙进去了，wzbtn.png 与 wzbtn_bg1.png 逐字节相同实证），hover 长出橙板、开态/子项蓝板，子项 scale (0.9,0.75)；② select-pack 行 offset——parseRoster 支持自闭合空位 `<item/>`（char_list 尾部两行）+ flatten 合成行 offset（原版 newListByXML 克隆行 offset 给全行条目再叠加条目 offset），select.json 重生成（aizen/kenshin/madara/obito/随机项 7 处修正，bvn/select@2 不变）；③ 黑幕转场——trans.ts（transIn/transOut/clearTrans，overlay 挂 pixi.stage 跨场景存活、ticker 驱动；偏离登记：原版 trans_mc 逐帧 alpha → 连续补间，fadin 430ms/fadout 370ms 实证）接线 setup.gotoLoading/startSolo/startLocal/winner.onContinue → loading.enter(transOut)/gotoBattle(transIn) → battle.enter(transOut)，选人 enter clearTrans（原版 StageCtrler.clearTrans 语义）；④ GameLoadingStage"绊"初始化封面——loading-pack 扩烘 cover_bgimg(位图64 crop 800×600)+seltwzmc 角标 4 帧（schema bvn/loading@2），GameLoadingScene（bar 组件抽 bar.ts 共享；步骤 = 配置 json 预载 + logo/title 流帧头 fetch 预热；定场 400ms → LogoScene），main.ts 正式入口改经 GameLoadingScene；⑤ 加载页双方已选面板——LoadingScene.mountPanels（原版 SelectIndexUI/SelectedFighterUI 规格：fighter 面板按位次纵排 gy=100、辅助面板 p1(-30,325)/p2(45,325)、面板 253×70 + 大脸 245×62 @(4.75,4.75)（p2 镜像 origin 248.6）+ seltwz 角标帧 1..3 位次/帧 4 assist）。顺带修正：bar.txt 右缘此前少加 bar.pos.x 17px（抽 bar.ts 时归位）、菜单按钮坐标语义（shape 10 bounds -194..+194 实证原版 mc_wzbtn 原点 = 板水平中心，此前整按钮右移 194px 出舞台右缘）；⑥ 选人页右上角两个自加按钮移除，改原版语义：ESC → BACK TITLE 确认框返回主菜单（GameUI.confirm 收编：模态遮罩 + 确认/取消，再按 ESC 关框）、P1 跳键 K → RESELECT 确认重进选人（原版 GameInputer.jump(P1) → goSelect；仅单机/本地，net 选中即锁无反悔不提供）。遗留：菜单/选人页背景嵌套动画（§4.5）。
- **切片 46**（✅ 2026-11-20）1v1 终局演出收编（原版 KO → 败方特写 → 胜方特写 + Winner/Perfect 字样）：① core——roundEnd 状态机自 team 泛化为非训练对局通用（1v1 KO 即置位 → KO 字样窗口 WIN_TEXT_GATE_TICKS=120（原版 pause 500ms + KO 字样 47 帧 + 败方飞尸；慢动作省略偏离登记）→ isAllowWinState 门收编为 hold 门 → WIN_ING + perfect（hp≥hpMax 回血前判定，原版 showWinner $perfect）+ 血量恢复仅 team（原版 case1 isTeamMode 门，偏离登记）→ hold 120+180 计满 → 1v1 finishMatch（draw 双 KO = winner 0 胜场不计，原版 drawGame 重启不建模偏离登记；app 层 checkKo/KO 1.2s 延迟收编删除）+ 置位同拍 shine/shake 表现事件（原版 FightUI.playKO）；② render——updateRoundEnd 特写镜头（winApplied 前聚焦败方/之后聚焦胜方，cameraFocusOne zoom 3.5 同款；平局不聚焦）+ FightHud updateEndKO 全快照驱动（KO 字样 47 帧 hold-30 起播 / winner 字样 winApplied 起播 1..29、perfect 续播至 56 定格 / 胜利星仅 1v1 bleach/naruto 段按胜方 comicType；drawgame 字样未收编偏离登记）；③ hud-pack——startko-ko（sprite 228 XFL 144..190，playKO2 y=0 → (13,103)）+ winnerko（sprite 221 嵌套 winnermc 独立时间轴 1..56，mc_042_44.as 帧脚本实证 frame29/frame56 stop+COMPLETE，父时间轴停 210 等待 → 必须独立烘焙独立驱动；$winnerX=30|546/$winnerY=90 → (30|546,120)）双元件扩烘，hud.json schema bvn/hud@1 增 endKO 段（旧 baked 缺省不挂载向后兼容）；④ app——battle.checkKo 简化（solo 训练浮层保留；local/net 归 match:over 统一路径），WinnerScene winner 0|1|2（平局无立绘无台词，原版 f0.visible=false 语义）。SIM 行为变更（1v1 KO 起置位 roundEnd + KO 窗口内 WIN 延后）：replay 9 剧本 + batch 基线零漂移复跑确认（剧本均未走到回合结束），core 164 单测过（team.test 3 条节拍扩窗 + 1v1 终局收编/训练不置位 2 条新增）。

---

## 四、剩余工作规划

> 本节只收未完成项。排期可按实际开工调整，调整时改本节。

### 4.1 联机基础设施

- **云服务器部署** ✅（2026-11-11）：Node 22 + systemd `bvn-room.service` + nginx 443 wss 反代（自签证书）。服务器信息见本地 `docs/cloud-server.md`（gitignore 不入库）。room-server.mjs 回归自有定位后直接复用。
- **真机体验验证**：挂到联机房间流切片（§4.4）完成后，按新流程（房间/匹配全链）公网两端人工验收——对局可打完、哈希失步零发生。
- **延迟调优立项**：视云上结果——输入延迟帧自适应（现固定 INPUT_DELAY=3）、抖动缓冲；rollback 升级与否据此决策（接口已预留：tick 纯函数 / SimState 可序列化 / 输入只经 InputFrame）。

### 4.2 阶段 3 尾巴（低影响，不阻塞）

- suigetsu `isAttacking=true`（唯一读者 AI，随街机模式 AI 转译一并处理）；
- 辅助残余静默 op：justHit（纯读）/ setTouchSide（语料无实例）——确定性静默，无行为差；
- batch:validate 基线形态角色仍是无 XFL 编译（21F 遗留②），与 app 装配不一致；纳入门禁需整体重冻并 verify-drift 归因。

### 4.3 阶段 4 体验完善（余项）

| # | 项 | 内容 | 备注 |
|---|---|---|---|
| 1 | 断线处理 | 对局中 peer-lost 后判负/重连（现为冻结等待）；对局前异常流已在 netplay-design §10 定案，随房间切片实现 | 帧同步无重连，重连归 rollback 决策 |
| 2 | 录像回放 | 输入序列 + 种子 + 数据版本戳的存储与播放 UI | 帧同步免费送，core 无需改 |
| 3 | 观战 | 只收不发输入的观战客户端 | net 层扩展 |
| 6 | 街机模式 | mission.xml 关卡数据 + FighterAICtrler 转译（~700 行，种子随机） | AI 是 PvP 路径外唯一大块逻辑 |
| 8 | 本地双人 | ✅（2026-11-17 切片 39）：LOCAL PLAY 菜单入口（1v1/团队）+ 选人页双键盘双光标 + 对局双键盘输入源 | 原版 isVsPeople 语义收编 |

（块 4 rollback 并入 §4.1 延迟调优；块 5/7/9/10/11/12 已收官，余项入 §4.5。）

### 4.4 联机房间流（阶段 5，2026-11-16 立项）

设计定案见 [netplay-design.md](netplay-design.md)（含协议词表扩展 §9、异常流 §10、平台对齐点 §11）。

| 切片 | 内容 | 状态 |
|---|---|---|
| 34 | 房间语义协议 + 房间页：room-server.mjs 扩展（room-info/ready/room-config/begin/掉线清理）+ NetMessage 词表扩展 + app RoomScene（房主常备/客座准备切换/开始门/公开-随机地图-团队三项设置/房间码/邀请操作占位）+ **方案 A 遗留处置**（NetScene 回自有服务器路径，platform.ts 回退或改造为凭证接缝） | ✅（2026-11-17） |
| 35 | 联机选人页：SetupScene 双光标（cursor 消息同步/双色框/选中即锁/双方齐套本地推导推进/团队模式 3 选 + 1 援助/同角色允许）+ pick 按次序累计语义 + **对局侧 3+1 装配（尾巴）**：sim teams 装配/回合结束换人/终局流转 + render roster id-swap + HUD 换脸 | ✅（2026-11-17） |
| 36 | 地图阶段：房主选择（map-pick 实时广播、客座只读）+ 开箱抽取（map-roll 服务器权威种子、~4s 动画、不可跳过/重抽、种子进 configHash） | ✅（2026-11-17） |
| 37 | 匹配与浏览：服务器匹配队列（queue/unqueue/matched）+ 公开房间列表轮询（list-rooms/room-list）+ app 匹配 UI（"匹配中" + 红 ✕ 取消）+ 浏览房间页 + VS 横幅（下限 2.5s、上限以建连就绪为准） | ✅（2026-11-17） |
| 38 | 平台接缝：身份凭证服务器侧验证 + 邀请深链进房 + 平台昵称/头像资料接入（netplay-design §11 对齐点收口；凭证未定前按结构子集 duck typing 留接缝） | ⬜ |

固定属性：匹配默认**团队模式开启 + 强制随机地图**。异常流按 netplay-design §10 随对应切片实现（对局中掉线判负归 §4.3 块 1）。

### 4.5 遗留池（低价值/待定，按需立项）

- EffectCtrler 未消费特效：specialEffectId 持续类 / hit_end / startShake / buff 系（批次 35 登记；hit_floor 系已于批次 44 消费）；
- effect 表未消费 id：shadow 残影 / slowDown（批次 40 登记；shake 走尘 / jump / touchFloor 尘土已于批次 44 消费）；
- 嵌套元件时间轴音 99 处（zh2mc/hitmc 演出件，需 ghost 时间轴，低价值，切片 28 登记）；
- GROUND_FRICTION（subtractive 0.9）vs 原版 setDamping(0.1)——受击滑步距离差 10 倍以上（批次 38 登记，单独批次）；
- 原版站立 = 静态单帧 vs 移植版 9 帧循环——忠实性待用户定（批次 22 登记）；
- 佐助防御时人物模糊待复测（疑 autoZoom 近身上采样变糊，全角色共有，21F 登记）；
- 切片 2：orihime/yachiru 运行时 actions 空，XFL 兜底；
- 切片 14/15：more= 形态切换未实现（含黄框交互）；重开局仅 solo（net CONTINUE 隐藏）；
- HUD 展示件：scoremc 计分板 / 被动条 sp / shape_007 回合指示（均无对应语义）；timeover/drawgame 结算字样（KO/winner/perfect/胜利星已于切片 46 收编；timeover 需回合计时器先行，drawgame 需多局制先行）；startKOmc start_final 段（round≥5 用，批次 43 恒以 start 段 + 数字封顶 5 替代）；3.6 版血条 HP 数字（纯显示层增强）；
- 主菜单 title 嵌套动画（切片 41 登记；切片 45 尝试运行时叠加层后回退，暂缓）——根因三条：① FFDec 帧导出把嵌套 MovieClip 冻结在未知内部帧，"原板"作为叠加层校准的参考基准本身不可信（圆点冻结在空帧=不可见，叠加层无从对照）；② 叠加层落点依赖模板匹配，被上层元件覆盖污染（圆点叠在鸣人上）+ 画面平滑自相似（光层）产生假匹配，网格扫描/解析式等替代方案残差仍无法收敛；③ z 序正确性需拆双板（静态内容 d1..d40 与 fx d3..d25 交错），复杂度与残差不成比例。重立项前提：换参考基准——FFDec 脚本导出复刻嵌套时间轴语义（时间轴语义以 ffdec -export script 实证为准，二进制解析/模板匹配类核对已两次证伪）或嵌套区域整段视频化，叠加层模板匹配路线证伪不再走。select 侧旋涡/地图面板 fx 已在切片 45 收编（元件独立、无遮挡污染，路线可行）。

---

## 五、下一步（按优先级）

1. **联机房间流切片 38**（§4.4）——平台接缝：身份凭证服务器侧验证 + 邀请深链进房 + 平台昵称/头像资料接入（VS 横幅头像占位在此收口）；
2. 切片 34~38 完成后 **真机体验验证**（§4.1）按新流程（房间/匹配全链，含切片 36 地图阶段与切片 37 匹配）公网验收；
3. 阶段 4 余块（断线判负/录像/观战/街机）按 §4.3 顺序推进，开工前细化登记 §二。
