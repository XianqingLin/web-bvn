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

- suigetsu `isAttacking=true`（唯一读者 AI，随街机模式 AI 转译一并处理）；
- 辅助残余静默 op：justHit（纯读）/ setTouchSide（语料无实例）——确定性静默，无行为差；
- batch:validate 基线形态角色仍是无 XFL 编译，与 app 装配不一致；纳入门禁需整体重冻并 verify-drift 归因。

### 2.3 阶段 4 体验完善（余项）

| # | 项 | 内容 | 备注 |
|---|---|---|---|
| 1 | 断线处理 | 对局中 peer-lost 后判负/重连（现为冻结等待）；对局前异常流已在 netplay-design §10 定案，随房间切片实现 | 帧同步无重连，重连归 rollback 决策 |
| 2 | 录像回放 | 输入序列 + 种子 + 数据版本戳的存储与播放 UI | 帧同步免费送，core 无需改 |
| 3 | 观战 | 只收不发输入的观战客户端 | net 层扩展 |
| 6 | 街机模式 | mission.xml 关卡数据 + FighterAICtrler 转译（~700 行，种子随机） | AI 是 PvP 路径外唯一大块逻辑 |

（块 4 rollback 并入 §2.1 延迟调优；块 5/7/8/9/10/11/12 已收官，余项入 §三。）

### 2.4 联机房间流 · 切片 38（阶段 5 最后一片）

平台接缝：身份凭证服务器侧验证 + 邀请深链进房 + 平台昵称/头像资料接入（netplay-design §11 对齐点收口；凭证未定前按结构子集 duck typing 留接缝；VS 横幅头像占位在此收口）。设计定案见 [netplay-design.md](netplay-design.md)（含协议词表扩展 §9、异常流 §10）。

固定属性：匹配默认**团队模式开启 + 强制随机地图**。异常流按 netplay-design §10 随对应切片实现（对局中掉线判负归 §2.3 块 1）。

---

## 三、遗留池（低价值/待定，按需立项）

- **特效收编（2026-11-20 全面盘点，原版引擎层 EffectModel 53 id + 逐角色语料 38 主战/37 辅助全量对照）**——已完成：残影 shadow 系（切片 47）、瞬步尘土 dash/dash_air（切片 47）、KO 终结演出链（切片 48：hit_end/kobg/shine/shake + 终结慢镜头）、slowDown 全局慢放（切片 49：进 sim 折算定夺，规格见 DESIGN §3.5；batch 基线 8 角色漂移归因后重冻）、specialEffectId 持续挂身特效（切片 50：fire/ice/shock_ing 挂身 + targetColorOffset 色调，纯渲染层，规格见 DESIGN §3.5）、buff 视觉特效 6 项 + 钢身发光（切片 51：buff_effect_* 火花 + buff_* 挂身光环 + startGlow/endGlow 发光克隆，规格见 DESIGN §3.5）、startShake 持续震屏（切片 52：hold 保持项 + 快照差分自动清理，规格见 DESIGN §3.5）、轻击飞三段式弹起（切片 54：击飞_落→击飞_弹→二次落地 hit_floor_low + HURT_DOWN_TAN 状态，规格见 DESIGN §3.5）、受击被动替身/灵压爆发 + 辅助出场（切片 55：replaceSkill/energyExplode 机制 + 冻结演出 + fz_bleach/fz_naruto，规格见 DESIGN §3.5）、起跳尘土 jump/jump_air 分流 + 落地尘土状态门 + bullet 触底 shake（切片 56，规格见 DESIGN §3.5）、收尾小项（切片 57：hitspark 纹理缺失静默告警 + 受击被动可用提示 = QiBar 红点按 isCanHurtBreak 收编）。剩余按观感收益排序：
  - 豁免：kenshin 必杀特写立绘（2026-11-20 深查定案——非单纯引用错配：语料 9 处 `bisha(true,"Kenshin_1")` 与注册键 bsface1/bsface2 双向对不上，且 kenshin.swf 无 bsface1 类（SymbolClass 全表实证）、FFDec 全量位图导出亦无任何人物立绘——原版作者从未制作该立绘，无资产可接线，移植版与原版等效。除非自制立绘补缺，否则维持豁免）；
  - 普硬直/破防致死收尾演出（2026-11-20 批次 65 调查副产物，低观感收益）：原版 doHurt hurtType==0 致死为 HURT_ING 硬直，`renderHurtAnimate` 计尽查 isAlive——空中重新 hurtFly 起飞、地面 playHurtDown 倒地段 → case 4 DEAD 躺姿；破防致死（doBreakDefense 削血）原版不即时 DIE。port 均当场 DEAD +「失败」标签（fighter.test 已按现状锁定）；
- 嵌套元件时间轴音 99 处（zh2mc/hitmc 演出件，需 ghost 时间轴，低价值）；
- 佐助防御时人物模糊待复测（疑 autoZoom 近身上采样变糊，全角色共有）；
- more= 形态切换未实现（含黄框交互）；重开局仅 solo（net CONTINUE 隐藏）；
- HUD 展示件：scoremc 计分板 / shape_007 回合指示（均无对应语义；被动条 sp = QiBar 红点已有语义，切片 57 收编）；timeover/drawgame 结算字样（timeover 需回合计时器先行，drawgame 需多局制先行；对应播报音 bannerTimeover/bannerDraw 已烘焙，随渲染收编接线）；startKOmc start_final 段（round≥5 用，现恒以 start 段 + 数字封顶 5 替代；决胜播报音 bannerFinal 已烘焙，随段收编接线）；3.6 版血条 HP 数字（纯显示层增强）；
- 菜单/选人页背景嵌套动画——主菜单 title 侧运行时叠加层路线已证伪暂缓（select 侧旋涡/地图面板 fx 已收编，元件独立、无遮挡污染，路线可行）。title 重立项前提：换参考基准——FFDec 脚本导出复刻嵌套时间轴语义（**时间轴语义以 ffdec -export script 实证为准，二进制解析/模板匹配类核对已两次证伪**）或嵌套区域整段视频化，叠加层模板匹配路线不再走。证伪根因三条：① FFDec 帧导出把嵌套 MovieClip 冻结在未知内部帧，"原板"作为校准基准不可信；② 叠加层落点依赖模板匹配，被上层元件覆盖污染 + 画面平滑自相似产生假匹配；③ z 序正确性需拆双板，复杂度与残差不成比例。

---

## 四、下一步（按优先级）

1. **切片 38**（§2.4）——平台接缝：身份凭证服务器侧验证 + 邀请深链进房 + 平台昵称/头像资料接入；
2. 切片 38 完成后 **真机体验验证**（§2.1）按房间/匹配全链公网验收；
3. 阶段 4 余块（断线判负/录像/观战/街机）按 §2.3 顺序推进，开工前在本文件登记细化内容。
