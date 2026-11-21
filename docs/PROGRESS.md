# BVN Web —— 进度台账（PROGRESS）

> **只记未完成项**：剩余工作、遗留池与下一步。已完成的切片/批次不再登记——git 提交历史即完成台账（提交说明含做了什么/偏离登记/门禁结论）；机制规格归 [DESIGN.md](DESIGN.md) §3.5，硬规则见 [ARCHITECTURE.md](ARCHITECTURE.md)。
> 本文件结构：§一 当前位置 → §二 剩余工作 → §三 遗留池 → §四 下一步。开工新项前在 §二 登记；完工后从本文件删除对应条目（规格沉淀进 DESIGN）。

---

## 一、当前位置

- **阶段 4 体验完善**：🔄 余项见 §二.3 与 §三；
- **阶段 5 联机房间流**（2026-11-16 立项）：🔄 切片 34~37 已收尾，仅剩切片 38（§二.4）。

门禁速记（每次收尾全过才算完成）：`pnpm build` + 确定性单测 + `tools/replay` 9 剧本哈希（**重冻后逐剧本单独 --expect，不看汇总**——批次 19 教训）+ `pnpm batch:validate`（58 角色 + 37 辅助，基线 `tools/batch-validate/baseline.json`）。行为有意变更 → verify-drift 归因后重冻全部基线并在提交说明写明。

---

## 二、剩余工作

### 2.1 联机基础设施

- **真机体验验证**：按新流程（房间/匹配全链，含地图阶段与匹配）公网两端人工验收——对局可打完、哈希失步零发生。前置：切片 38 完成后执行。
- **延迟调优立项**：视云上结果——输入延迟帧自适应（现固定 INPUT_DELAY=3）、抖动缓冲；rollback 升级与否据此决策（接口已预留：tick 纯函数 / SimState 可序列化 / 输入只经 InputFrame）。

### 2.2 阶段 3 尾巴（低影响，不阻塞）

- suigetsu `isAttacking=true`（唯一读者 AI——街机模式已定案不做，此项单独处理）；
- 辅助残余静默 op：justHit（纯读）/ setTouchSide（语料无实例）——确定性静默，无行为差；
- batch:validate 基线形态角色仍是无 XFL 编译，与 app 装配不一致；纳入门禁需整体重冻并 verify-drift 归因。

### 2.3 阶段 4 体验完善（余项）

| # | 项 | 内容 | 备注 |
|---|---|---|---|
| 1 | 断线处理 | 对局中 peer-lost 后判负/重连（现为冻结等待）；对局前异常流已在 netplay-design §10 定案，随房间切片实现 | 帧同步无重连，重连归 rollback 决策 |
| 2 | 录像回放 | 输入序列 + 种子 + 数据版本戳的存储与播放 UI | 帧同步免费送，core 无需改 |
| 3 | 观战 | 只收不发输入的观战客户端 | net 层扩展 |

（块 4 rollback 并入 §2.1 延迟调优；块 6 街机模式 2026-11-21 定案不做——原版专属玩法，mission.xml 关卡 AI 不转译；块 5/7/8/9/10/11/12 已收官，余项入 §三。）

### 2.4 联机房间流 · 切片 38（阶段 5 最后一片）

平台接缝：身份凭证服务器侧验证 + 邀请深链进房 + 平台昵称/头像资料接入（netplay-design §11 对齐点收口；凭证未定前按结构子集 duck typing 留接缝；VS 横幅头像占位在此收口）。设计定案见 [netplay-design.md](netplay-design.md)（含协议词表扩展 §9、异常流 §10）。

固定属性：匹配默认**团队模式开启 + 无地图阶段**（2026-11-21 纯房码制收缩，见 §2.6）。异常流按 netplay-design §10 随对应切片实现（对局中掉线判负归 §2.3 块 1）。

### 2.5 回合流程多局制（2026-11-21 立项，插入切片 38 前）

**立项根因**：原版反编译源实证（GameCtrler.as:680-688/498-533/616-666、GameEndCtrler.as、GameRunDataVO.as、FightUI.as:288/296-405、ConfigVO.fightTime=60）——**原版 1v1 是三局两胜多局制**，DESIGN §3.5 团队回合流段"1v1 无 pending 恒终局（原版 nextFighter 无备选 → fightFinish）"系漏读（nextFighter 无备选只对 team 分支成立；single 分支 `p1Wins<2 && p2Wins<2 → buildNextRound(false)` 重开）——未登记偏离，本项归位。用户定案（2026-11-21）：恢复三局两胜、回合计时 60 秒跟原版（原版设置可调 20/40/60/99，port 先 SimConfig 常量）。

- **core**：MatchState + gameTime/gameTimeMax（秒，每 30 tick 减 1，原版 renderGameTime；训练/无时限 -1）/1v1 出生点；RoundEndState + timerOver；wins 逐局计（原版 doGameEnd 置位时 ++，自 finishMatch 移出）；1v1 演出毕 wins<2 → 重开该轮（原版 resetFight 双方满血回位 + startNextRound 无特写字样，port intro 直入字样步）else fightFinish；平局不计胜场恒重开（原版 drawGame）；timeover：gameTime 归零 → hp 高者胜/hp 相等 drawGame（原版 timeover）；team 换人路径 gameTime 重置（原版 nextRound）；胜方回血率归位 `0.165×(timeRate+1)`（原版 GameEndCtrler.renderEND case1，timeRate = gameTime/gameTimeMax，无时限=1）。✅ 2026-11-21 完成（commit e66440e）。
- **渲染收编** ✅ 2026-11-21 完成：计时板数字（FightTimeUI time_txtmc=sprite 250 / MCNumber 两位零填充逐位 20px，gameTime 驱动、训练显 ∞）；start_final 段（round≥5 开局分支，FightUI.as:288；XFL 0 基 94..138 独立烘焙 45 帧 + renderStartAndKO go:fight 标签 gotoAndStop("fight") 重定向语义 → 运行时复用 startko fight 段，总帧数 79 与 start 路径等长；居中 delta = 稳态固定值——逐字弹入期不逐帧居中，原版原地弹出语义；段内无数字槽——原版 r5 nummc 段死代码佐证）；timeover/drawgame 结算段（段尾帧脚本 stop+COMPLETE 实证定帧数 44/43，timerOver 置位即时起播 timeover、平局续播 drawgame 定格段尾至重开、非平局被 winner 字样替换——原版 playTimeOver/playDrawGame/showWinner）；胜利星逐局累积（WinUI.show wins→槽位语义：team1 w1→w2 / team2 镜像反序，点亮沿 = winApplied 落位起播 in_bleach/in_naruto 定格段尾，wins 回退全灭）；bannerFinal = core intro hold 0 按 round≥5 分流（原版声音层贴帧 sound_006）；bannerTimeover/bannerDraw = HUD 显示沿 onBanner 回调（core 不持表现段帧数常量，双端快照一致同拍触发）。
- **门禁**：core 侧 commit e66440e（行为有意变更 → replay 9 剧本重冻 + batch 重冻，已过）；渲染收编零状态变更 → replay 9 剧本零漂移 + batch 基线复验过（2026-11-21）。
- **偏离登记**（本项内定案）：①计时递减相位 roundFrame % 62 === 0（原版 renderGameTime 挂 30Hz renderAnimate 内独立计数器 31 次减 1，fightTime=60 ≈ 62 真实秒；原版计数器不随回合重置；slowDown 期 port 计时照走、原版随动画帧同门降频——挂身慢放累计秒级可忽略）；②timeover 平局 team 换人气无继承（原版用上一局残留 lastLoserData，stale 语义不建模）；③双侧 roster 耗尽且平局的边角按胜方侧判定（维持既有偏离）；④timerOver 非平局 winner 字样起播锚 = winAppliedHold（hold 120 门 + 延迟 60 = 180），原版 timeover 段计满（hold 88）+ 1s 延迟 ≈ 148 起播——0.5s 内偏差，避免为对齐而动 core 计时；⑤start_final 居中 delta 稳态固定（原版逐字弹入原地语义，逐帧居中会抖动）。

### 2.6 联机产品形态收缩：纯房码制 + 地图阶段简化（2026-11-21 定案，已实现）

用户定案（2026-11-21，规格见 netplay-design §3/§4/§5/§6/§8 当日改段）：① 浏览房间下线，房间一律私人，主菜单"浏览房间"改"加入房间"（6 位数字房码，服务器生成 + 查重 + 解散冷却池近期不复用）；加入 = 房码或平台邀请（切片 38 深链落同一入口）。② 地图阶段收缩：好友房保留房主选择页（默认选中项 = "？"随机场景，原版 map_config random 首项实位归位），房间页"随机地图"勾选删除（随机性归"？"项）；匹配模式无地图阶段（援助选完直接进加载页，地图 = `maps[|seed| % n]`，matched 权威种子兼作抽取与 sim seed）；开箱抽取动画与 `map-roll` 消息整体下线（更名 `seed`，仅种子载体）。协议收缩：`RoomSettings` 仅剩 `team`，`list-rooms/room-list` 删除。门禁：build + 单测（服务器 18 + net 13）+ replay 9 剧本零漂移 + batch 基线复验全过（2026-11-21）。

---

## 三、遗留池（低价值/待定，按需立项）

- **特效收编残余**（2026-11-20 全面盘点——原版引擎层 EffectModel 53 id + 逐角色语料 38 主战/37 辅助全量对照——后余项，已完成切片见 git 历史与 DESIGN §3.5；按观感收益排序）：
  - atlas-pack 全量重跑副作用（2026-11-21 实证）：会把 `baked/fires/*.json` 的 `org`/`hits`（runtime-ingest 产出的火系命中框，sim 确定性数据）覆盖成仅 totalFrames+labels 的版本——baked/fires 不属 atlas-pack 产物边界，重打包后须 `git checkout -- packages/data/baked/fires/` 还原；收口方向 = packFire 读 existing baked 合并保留或拆出独立 bake 步；
  - 豁免：kenshin 必杀特写立绘（2026-11-20 深查定案——非单纯引用错配：语料 9 处 `bisha(true,"Kenshin_1")` 与注册键 bsface1/bsface2 双向对不上，且 kenshin.swf 无 bsface1 类（SymbolClass 全表实证）、FFDec 全量位图导出亦无任何人物立绘——原版作者从未制作该立绘，无资产可接线，移植版与原版等效。除非自制立绘补缺，否则维持豁免）；
  - ~~角色侧 attacker 元件脚本·视觉缺口~~（2026-11-21 收官：采集桥两段式定位改「命中即采」修僵尸引用 + wanted 元件下钻补嵌套弹体后，fire 全量 41 包重采——177/177 元件全内容、0 missing；旧桥僵尸污染造成的 120 个假"全静态"清零，余 12 个 tf=1 单帧弹体与 1 个隐形判定载体（obito zh3mc，仅 atm 标记无自绘美术）均忠实原版；道具本体淡入淡出/混合类逐帧动画随批次 37 parts 机制一并收编）。
- 嵌套元件时间轴音 99 处（zh2mc/hitmc 演出件，需 ghost 时间轴，低价值）；
- 佐助防御时人物模糊待复测（疑 autoZoom 近身上采样变糊，全角色共有）；
- more= 形态切换未实现（含黄框交互）；终局流转已定案（2026-11-21 结算画面整块移除）：solo 对局浮层"再来一局"、local 回选人页、net 关 socket 回菜单（无跨端原地重开）；
- HUD 展示件：被动条 sp（未收编）；3.6 版血条 HP 数字（纯显示层增强）；
- 菜单/选人页背景嵌套动画——主菜单 title 侧运行时叠加层路线已证伪暂缓（select 侧旋涡/地图面板 fx 已收编，元件独立、无遮挡污染，路线可行）。title 重立项前提：换参考基准——FFDec 脚本导出复刻嵌套时间轴语义（**时间轴语义以 ffdec -export script 实证为准，二进制解析/模板匹配类核对已两次证伪**）或嵌套区域整段视频化，叠加层模板匹配路线不再走。证伪根因三条：① FFDec 帧导出把嵌套 MovieClip 冻结在未知内部帧，"原板"作为校准基准不可信；② 叠加层落点依赖模板匹配，被上层元件覆盖污染 + 画面平滑自相似产生假匹配；③ z 序正确性需拆双板，复杂度与残差不成比例。

---

## 四、下一步（按优先级）

1. **切片 38**（§2.4）——平台接缝：身份凭证服务器侧验证 + 邀请深链进房 + 平台昵称/头像资料接入；
2. 切片 38 完成后 **真机体验验证**（§2.1）按房间/匹配全链公网验收；
3. 阶段 4 余块（断线判负/录像/观战）按 §2.3 顺序推进，开工前在本文件登记细化内容。
