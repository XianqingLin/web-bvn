# BVN Web —— 进度台账（PROGRESS）

> **唯一的进度记录**：开发顺序、各切片状态、遗留池与下一步。
> 切片收尾只改本文件；立项书与 DESIGN 不再追加进度段。
> 设计细节与偏离记录见 [DESIGN.md](DESIGN.md) §3.5/§9；决策见 DESIGN §10 ADR；硬规则见 [ARCHITECTURE.md](ARCHITECTURE.md)。
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
| 4 | 图集管线（ADR-13：AIR capture 桥逐帧栅格化，166k 引用 → 46k 唯一帧）+ render BattleRenderer + app dev 预览页 | ✅ | DESIGN §4 |
| 5 | **阶段 1 收尾**：防御/瞬步/技/必杀/能量/连段槽 + 相机 clamp/floor 遮挡/HUD + 训练模式（单测 40，四剧本） | ✅ | DESIGN §3.5/§9 |
| 6 | 联机地基：`InputSource` 抽象 + `packages/net` lockstep（ADR-14）+ 最小中继 + ws e2e（单测 78） | ✅ | DESIGN §9.7 |
| 7 | **阶段 2 收尾**：房间服务器 `room-server.mjs`（ADR-15）+ `startSession` + app create/join 入口（单测 80，net 7） | ✅ | DESIGN §9.8；云部署要点见 §4.1 |
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

---

## 三、已完成详情（切片/批次日志）

> 切片 1~12 的实现细节与偏离记录在 [DESIGN.md](DESIGN.md) §3.5/§9，此处不重复；本节收切片 13 起的详情。

### 切片 13（A1~A3，✅ 2026-11-11）

- **13-A1 辅助图集 capture 补齐**（commit 42b4078）：capture 桥辅助路径改连续全时间轴扫描，37 辅助包全量栅格化；
- **13-A2 地图层装配对齐原版**（commit 6764029）：bottomOffset 下移 / bg 屏幕固定 cover / front 层 0.1 视差（镜像 MapMain.render）；
- **13-A3 bullet 精灵图集接入 + 命中残留收紧**（2026-11-11）：capture 桥新增 fire 采集（175 元件全命中，含 byakuya 辅助 atmmc 运行时挂载——fake 控制器补 AssisterCtrler API 后帧脚本可跑通）；atlas-pack fire 模式双路输出（`assets/fires/<ownerKind>/` 图集 bvn/fire-atlas@1 + `baked/fires/` 元数据 bvn/fire@1）；core Bullet 增 animTotal/animFrame/animLabels/hitAnim（30Hz stepBulletAnim 标签分派：loop/remove/hit_over/timeout/播尽 off-by-one quirk 原样保留；killBullet 命中残留段=停移动播尽移除）；render bullet 精灵替换色块（容器锚=RectUtils.apply 逆运算，scale.x=facing，无图集条目回退色块）。基线哈希不变（5 剧本无远程弹；新增 6 条生命周期单测覆盖）；
- **偏离记录**：bullet 命中矩形沿用 spawn 帧 atm 判定区（原版用元件帧1视觉 bounds；61% 元件两者一致，46 项大偏差为 atm 手调平衡数据如万解斩月 267×265，切换需改平衡+重冻基线，暂不切）；
- **13-A4 attacker 渲染接线**（2026-11-11）：render `updateAttackers` 按 bullet 同款精灵模式渲染独立道具——容器锚 = `el.main` 逆运算 + `scale.x = facing` 镜像、位置插值、缺图集条目回退色块（纯表现实体 hit=null 用青绿色区分）；图集复用 13-A3 fire 采集（`baked/fires/fighter/` 已含全部 attacker 元件，core/数据零改动）。验收：门禁全过且基线零漂移（纯渲染接线）+ Playwright 目检（setup 选 byakuya → 跳砍 → `tkmc` 黄斩击特效套中目标身位，与命中矩形/moveToTarget 语义一致）。
- **13-A5 attacker 寿命·动画收紧（轻层）**（2026-11-11）：对齐原版 `FighterAttacker.renderAnimate`——core 新增 `stepAttackerAnim`（30Hz 块，bullet 同节奏：生成 tick `animFrame` 已为 2），`AttackerState` 增 `animTotal/animFrame`；`addAttacker` 桥接 `def.fires` 元数据（与 fire 同款透传）。**寿命 = 播尽移除**（`animFrame === animTotal-1`，原版 off-by-one 原样保留；`FighterAttacker` 类无标签分派，纯推进不查标签——语料 32 个 attacker 元件全部多帧且无 loop，播尽移除全覆盖）；无时间轴（animTotal=0）回退 `holdTicks=120` 占位。render 按 `a.animFrame` 播帧（13-A4 静态首帧偏离关闭）。**验收**：核心单测 +2（30Hz 推进节奏/播尽移除、无 anim 回退 120 tick）、门禁全过且 replay 五基线 + batch-validate 零漂移（剧本不触发 attacker）；Playwright 目检 tkmc 动画中段扩散、~0.33s 播尽消失（旧版滞留 2s）。**剩余偏离**：逐帧命中矩形仍未导出（§4.2）。

- **13-A6 辅助 addAttacker + 命中续接（setHitTarget）+ rawScript 审计**（2026-11-11）：对齐原版 AssisterCtrler.addAttacker/setHitTarget——
  - **addAttacker 注册**：辅助生成独立道具 `AssisterState.viaAssist=true`（回气经原版 getOwnerFighter 回溯归召唤者、不走 viaAssist 抑制，与辅助弹不同；渲染图集走辅助侧 fire 包）；锚点=辅助实体，followTarget/axis 偏移与角色版同语义；hitVO 解析镜像 getHitVOByDisplayName（FighterHitModel.as:45 原名→去 atm 后缀；'atmmc' 原版也查空 → hit=null 纯表现占位，抓取伤害在内层逐帧 hitVO=重型层）；
  - **命中续接检查**：`AssisterState.hitTargetChecker/hitTargetAction`（setHitTarget 触发器注册）+ stepAssisterAnimation 每动画帧检查（原版 renderCheckTargetHit 语义：帧脚本后、播放头推进前；checker 区与目标身体相交 → gotoAndPlay(action)；不清除，窗口由判定区可见帧自然限定）；
  - **跳转落点修复（行为修正，基线重冻）**：stepAssisterAnimation 检测步内跳转（gotoAndPlay/gotoAndStop/loop/命中续接改写 animFrame）后不再 +1 推进——原版 AS3 gotoAndPlay 播放头落位、次 tick 才前进；修复前跳转后仍 +1，系统性吞掉标签首帧（byakuya CHK 落点 52 被推进成 53 滑进 CHK_False 段，addAttacker 永不触发）；落点帧触发器下一步照常执行；
  - **render**：updateAttackers 图集按 viaAssist 分流（assistSprites/fireLoadedAssister）；首帧空元件守卫修复（atmc 第 1 帧留空淡入 png=-1，按首帧判空误回退色块——改由 applyFireFrame 逐帧隐藏）；
  - **rawScript 审计（辅助残留 11 处全分类）**：byakuya [0] 动作样板（已提取）/ [49][51] 触发器已提取（残留 var judge/atmc 挂载）/ **[51][59] checkFunc 链未建模**（owner 死亡清道具、getTargetState==21 脱抓提前收道具——低影响偏离）/ [71] finish 残留；itachi [1] 动态伤害 `power = targetHpMax×0.008`；suigetsu [196] `isAttacking=true`（低影响）；temari [1]/[33]/[144] 风场系统（敌方弹速级 targetBulletSpeedLevel + targetSP.x 拉扯未建模；owner speedUp 已提取）；
  - 辅助未注册 op 收敛：~~setHitTarget/addAttacker~~ 已注册；残余静默 = justHit（纯读）/ setTouchSide（语料无实例）+ byakuya 专用 API addCustomFunc/removeCustomFunc/getMcCtrl（checkFunc 链载体，随其未建模静默）；
  - **验收**：核心单测 +3（`assist-attacker.test.ts`：CHK 续接跳转落点首帧触发/followTarget 吸附与播尽退场/未中走 CHK_False 无道具）；replay assist-duel 重冻（跳转落点修正，五剧本仅此一漂）+ batch-validate 重冻（11 辅助 finalHash 漂移 + nemu/shikamaru/shishio/yachiru 未注册 op 覆盖变化，均本切片预期行为变更，双跑确定性确认）；Playwright 目检：byakuya+byakuya solo → KeyO 召唤 → CHK 抓取 → atmc 黄色放射特效挂目标头上 ~0.5s 播尽移除（浏览器内 sim 状态轮询与 headless 探针逐项一致）。

### 切片 14——场景流转骨架（✅ 2026-11-11）

- **app 层基建**：`AppHost` 子系统宿主（events/assets/config/time + 拓扑 init，契约"app 层子系统接口"最小实现）；`SceneHost` 场景系统（1000×600 逻辑屏等比缩放居中，switchTo 异步流转）；`data.ts` baked 装载（assets 缓存）；`ui.ts` 基础控件（按钮/面板/DOM 输入）；`flow.ts` 对局流参数（mode/serverUrl/选人/地图）；
- **场景**：menu（单机/联机入口）→ setup（三段选人：角色→辅助→地图，数据驱动 `baked/select.json`）→ battle（自 main.ts 迁移；solo 训练 / net lockstep）→ KO 结算浮层（solo 可再来一局）；
- **联机选人交换**：protocol 新增 `pick` 消息（服务器像 input/hash 一样盲透传）；session.ts 拆 `joinRoom/sendPick/waitPeerPick/lockstart`（startSession 组合保留兼容）；pick 3s 重发兜底；地图以 P1 选择为准；双端异角色异辅助（render `fireAtlases` 改按出场者 atlasId 键控）；
- **tools/select-pack**：select.xml/fighter.xml/assistant.xml/map.xml → `baked/select.json`（schema bvn/select@1，53 角色/40 辅助/15 地图，含 offset/more/comicType）；
- **偏离记录**：① 联机禁用随机选人项（两端各自本地解析会选人分叉，需服务器裁决才可开）；② 原版 more= 形态切换未实现（数据已保留在 select.json）；③ 结算基于 `fighter:ko` 事件浮层，完整回合制（R1/R2 计分）归后续切片；④ 重开局仅 solo；
- **验收**：门禁全过（build / 137 测试 / replay 5 剧本 / batch:validate）；Playwright 驱动 菜单→选角色→选辅助→选地图→战斗 全链路截图验证（发现并修复 battle 迁移漏调 `renderer.onSnapshot`）；
- **UI 待打磨池**：格子长名溢出、DOM 输入样式、Logo 演出/选人动画。

### 切片 15——选人页原版化（✅ 2026-11-11）

- **tools/ui-pack**：FFDec CLI 按元件导出（主时间轴为空，`-export image`/`-export sprite`）→ `assets/ui/faces/`（266 张，导出名 `<symbolId>_<类名>.<ext>` 剥前缀还原类名）、`assets/ui/select/`（stg_select 背景 / slt_item 格框 / cursor_p1|p2 / selected_p1|p2 / select_map / select_map_kuang / select_map_txt 9 元件）、`assets/ui/maps/`（15 地图 + random 现成 PNG）；产出 `baked/ui.json`（schema bvn/ui@1：类名→文件映射 + 元件表 + 原版布局常量 + 注册点偏移）；
- **SetupScene 换肤（规格全部照原版 SelectFighterStage/SelecterItemUI/SelectedFighterGroup/MapSelectUI 反编译源）**：原版 800×600 舞台在 1000×600 逻辑屏居中（OX=100）；头像格 slt_item 60×60、50×50 头像垫底框叠加、起点 (15,100)、列距 80、行距 (600-50-100-10)/(行数-1)、offset 微调（select.json row/col/offset 即原版数据直接用）；光标 P1 蓝/P2 粉 hover 跟随（PNG 原点 = 格子位 + (-18,-26)）；已选展示框底部两角（大头像 245×62 + 名字，P2 内容容器镜像 scale.x=-1 原版摆法）；more= 项格框黄 tint（近似原版 GlowFilter）；地图选择 = 原版轮盘（select_map 面板 + 左右箭头热区 + 450×240 缩略图 + kuang 框叠顶 + 名牌，点缩略图即确认）；
- **app 接线**：data.ts `loadUi`/`uiFaceUrl`；main.ts dev 直通 `?mode=setup`（只开选人页目检用）；
- **偏离记录**：① 光标/kuang 用静态帧（原版 13 帧确认动画、kuang 60 帧流光未做）；② 名字/地图名用系统字体 Text 替代原版 BitmapText；③ 保留顶部"确认/上一步"按钮（原版无，底部被展示框占用上移至右上）；④ more= 形态切换交互未实现（黄框提示，切片 14 偏离沿用）；⑤ select_map PNG 画布原点 = bounds 左上（mc 原点在 PNG 内约 (78,0)），挂载时补偿；
- **不做**（留后续）：格子呼吸动画、血条头像接 HUD、胜利立绘接结算、title.swf 主菜单；
- **验收**：门禁全过（build / 137 测试 / replay 5 剧本 / batch:validate）；Playwright 驱动 选角色→选辅助→地图轮盘翻页→确认→战斗 全链路截图目检（光标/展示框/轮盘/背景均原版件）。

### 切片 16——菜单主页原版化（✅ 2026-11-11）

- **tools/ui-pack 扩展**：title.swf `-export sprite` 导出 stg_title（sprite 64）90 帧 → sharp WebP q80 → `assets/ui/title/<n>.webp`（~8.4MB，原 PNG 115MB 的 1/13；sharp 为根 devDependency）；common_ui.swf 导出 mc_wzbtn（388×75 按钮板）+ wzimg_bgimg 帧 1/2（hover 橙板/开态蓝板）→ `assets/ui/menu/`；ui.json 增 `title`/`menu` 段（帧参数 + 布局常量，schema 仍 bvn/ui@1 加性扩展）；
- **关键逆向**：title.swf 主时间轴为空，动画在 stg_title 类内；帧脚本 `addFrameScript(49/74, stop)`——intro 播帧 2..50 定格等点击，`gotoAndPlay("menu")`（帧标签=帧 65）播到帧 75 定格；帧 51-64/76-90 运行时不可见（资产保留）；帧 PNG 画布内舞台 (0,0) 位于 (859,100)（自写时间轴 union-bounds 计算得 2350×748，与 FFDec 画布 2351×749 对上）；按钮组挂 stg_title 内 identity 占位 btnct → 舞台 (470,100)，MenuBtnGroup xadd -40 / 项距 height+5 / childMode 项高 55；
- **MenuScene 重写**：800×600 舞台区裁剪挂载（帧 PNG 挂 `舞台-(859,100)`）；流帧播放 = fetch→createImageBitmap→ImageSource 手工管显存（单帧解码 ~7MB，全量常驻 ~630MB 不可行 → 常驻窗 ~9 帧 + 预取身前 4 帧 + 释放身后帧；**纹理就绪才推进帧**，否则释放窗口会销毁显示中的纹理）；点击/任意键跳过（500ms 后启用；跳过期间 'skipping' 相位暂停推进/释放，防加载竞态；热区跳过后让位按钮组）；按钮组：SINGLE PLAY/单机训练 + NET PLAY/联机对战（子菜单 CREATE/JOIN ROOM 直连 NetScene auto create/join）；hover 橙板 + 中文小字（挂板内，仅 hover/开态可见，原版如此）、开态/子项蓝板 scaleX0.9/scaleY0.75、fadIn scaleX 0.01→1 Back.easeOut 逐项 0.04s、400ms 后可操作；键盘 ↑/↓/Enter/Esc 导航；版本字右下角（黑色 18px，原版样式）；
- **偏离记录**：① BitmapFontText/BitmapText → 系统字体 Text（切片 15 ② 同类）；② 原版 select 动画 alpha -1→1 Elastic 1s → 0.35s 快速淡入；③ 背景帧内的三个下载/论坛徽标**保留**（立项时拟去除，实际为烙进原版帧的美术内容，逐帧修补代价大且保留更忠实——与立项方案偏离，登记于此）；④ 原版 BGM（op 音源）未接（音效块后续）；
- **验收**：门禁全过（build / 137 测试 / replay 5 剧本 / batch:validate）；Playwright 目检 开场动画→定格→点击跳过→按钮组入场→子菜单展开→选人→战斗 全链路截图。

### 修复批次 17——实战验收修复（✅ 2026-11-11）

> 玩家实测暴露五个真 bug + 两个体验项（加载无进度条、进场黑边），本批修五个核心 bug；加载画面与 bg 首帧定位留后续（见 §4.3 块 9）。

- **① 相机垂直 clamp（背景错乱根因）**：曾用 `groundY`（≈570）做垂直锚，视口底边探到 y≈870、越出地图内容范围（baked 地图 line_bottom 归一化 600），露出 bg 全景图的地图区以下部分（楼群/树林/土墙）——即截图里"舞台下方又一段背景"。改为 `cy ∈ [halfH, bottomY-halfH]`（renderer.ts），对齐原版 GameCamera fixBorder 的 scrollRect 夹死语义；
- **② endAct 原版语义（佐助远攻飞天根因）**：原版 endAct（FighterMcCtrler.as:449）只 clearAction + 置 FREEZE，**不动播放头**；移植版曾接成 endAction（立即换标签回位），招式 endAct 之后的帧触发永远采样不到——佐助招1 序列 `movePercent@378 → endAct@383 → dampingPercent@384 → idle@389`，阻尼触发器被跳过 → vy 恒负 → 重力只对 vy≥0 施加 → 永久上飘。新增 `machine.endActAction`（清槽/清标志/关钢身/释放抓取，不换标签不回位），标签播尽或后续 idle 触发收尾；`releaseGrab` 经引擎回调接线（抓取释放带重力恢复）。**波及**：所有"endAct 后还有帧触发"的招式（佐助招1/招3/超必杀收尾/跳招等）；
- **③ damping 持久阻尼**：behaviors 的 `damping/dampingPercent` 曾错误实现为一次性 `vx×(1-k)` 且不写 damp 字段；改回原版 setDamping 语义（安装持久阻尼，物理步 num_wake 每 tick 线性衰减），30fps→60Hz 按 ×SPEED_PLUS 减半换算（与 JUMP_DAMPING 同约定）；`move/movePercent/stop/stopMove` 补 setVelocity 附带的清阻尼语义；
- **④ 朝向按状态分流**：曾 NORMAL 态（含行走）每帧强制面向对手；对齐原版——站立待机每 6 帧自动面向（tick 取模）、行走朝向 = 方向键（可背对移动）、跳跃保持起跳朝向、防御方向键转向并重播抬手段（sim.ts）；
- **⑤ 连段修复**：startAttack/startSkill 接原版 doAction 的 clearAction（清空全部动作槽）——动作播放中再按攻击键不重启动作、时间轴不复位，连段只能经 setAttack 帧触发重填槽后派生（一护：砍1@帧135 重填 → 派生砍2）；删除"槽空直接重启 k1"的切片 3 兜底；攻击发起改为成功才消费输入缓冲；
- **⑥ 防御定格**：`防御` 移出 LOOP_LABELS（曾 6 帧动画每 0.2s 循环重播、观感抽搐），advanceAnimation 增防御定格分支——抬手段播 3 帧（原版 goFrame("防御",true,3)）后停住，转向重播由朝向分支驱动；
- **基线**：行为有意变更，replay 5 剧本与 batch:validate 基线已重新固化；`fighter.test.ts` endAct 用例改为断言新语义（收招不换播放头）；
- **验收**：门禁全过（build / 137 测试 / replay 5 剧本 / batch:validate 58 角色+37 辅助）；行为验证脚本确认 连段派生/佐助落地/防御定格/行走转向 四项。

### 修复批次 18——跳跃/动作永久锁死修复（✅ 2026-11-11）

> 玩家实测（佐助）：① 跳两次后无法再跳；② 冲刺两次后无法跳跃且无法攻击。根因是同族：状态恢复路径缺失导致资源（jumpTimes/动作槽）永久归零。

- **① jumpTimes 无恢复路径（根因一）**：原版 jumpTimes 只在 `touchFloor()` 与 `idle("站立")`（setAllAct 路径）恢复，移植版只在 `createInitialState` 赋值一次 → 双跳/空瞬/快速下落耗尽后永久锁跳。补三处恢复：`onLanded` 全分支（受击落地除外，击飞系由起身恢复）、`recoverToNormal` 落地恢复、behaviors idle（frame==='站立'）；
- **② 走/立标签维护吞掉 endAction 补槽（根因二，攻击锁死）**：精确追踪发现链条为——招1 清槽 → 跳 → 落地（槽仍空）→ 瞬步打断 落地 → dashStop@44 提前回 NORMAL 但 瞬步 时间轴残留帧（含 idle@47 = setAllAct 补槽）未播 → 走/立标签维护把标签切到 走/站立（循环标签，永远到不了 endAction）→ idle@47 与标签播尽两条补槽路径全部落空 → 槽永久空 → 攻击/防御永久不可用。修复：标签维护门控为仅当 `NORMAL && labelLock<=0 && 标签∈{站立,走}` 才切换（对齐原版 doMove 的槽位门控语义）；
- **③ 落地补槽**：JUMP_ING 落地分支补 `slots = defaultSlots`（原版 touchFloor → clearAction + setAttack(delay 1) 重填默认槽）；`recoverToNormal` 落地恢复同样补槽（空中招被打断后恢复到站立循环的锁死路径）；
- **④ idleLabel 潜伏 bug**：落地 曾被无条件排除在 →站立 转换外，落地 播尽后 endAction 触发但标签永停（此前被 ② 的维护掩盖）——改为仅当 落地 仍在播放期（animFrame ≤ index+duration）才保持；
- **⑤ 偏离记录**：空中攻击/空中技/空中必杀成功时置 `jumpTimes = 0`（对齐原版 doAirAttack/doAirSkill/doAirBisha）——本批次前空中动作不扣跳数；port 的 setLabel 不重启同标签播放头（原版 goFrame 会重启 → port 双击瞬步第二次被吸掉、原版则复位重播）——既有偏离，登记不改；
- **验证**：97 core 单测全过 + 6 个真实佐助剧本场景（双跳/空瞬后跳/空瞬后攻/空攻后空瞬拒/招1+跳+冲刺+攻/快落后跳）+ 4000 局模糊测试（真实按下边沿探针，零死锁）；replay 5 剧本与 batch:validate 基线已重冻（行为有意变更）；add 冒烟零失败。

### 修复批次 19——重力斜坡换算偏差 + 移动/跳跃参数忠实性审计（✅ 2026-11-12）

> 起因：玩家感觉"移动速度和跳跃参数调得有点大"。对整条换算链做了逐项源码审计。

- **审计结论（参数忠实性）**：① speed/jumpPower/heavy 为导出器逐字提取（ichigo baked 与原版形态脚本逐形态逐值一致）；② 行走（原版 setVelocity→move×0.5 = 3px/tick ↔ 本版 vx=speed×0.5 直结）与跳跃起跳（原版原始空间 -15+阻尼 0.5 ↔ 本版折半空间 -7.5+阻尼 0.25）逐 tick 等价；③ 渲染 zoom=1 无缩放失真。"手感偏快"不是参数问题——原版本身就是这个数值。
- **发现并修正一处真实偏差——重力斜坡**：原版 applayG(12) 中 `_g` 在原始空间每帧 +G_ADD×SPEED_PLUS=0.6、上限 12，位移 = `_g×0.5` → 60Hz 位移空间应为**步长 +0.3/tick、14 tick 到满速 6**；本版误将步长也减半成 0.6（位移直接结算、未再乘系数，注释自相矛盾）→ 下落加速期快 2 倍、到满速仅 7 tick（全程下落约快 13%）。修复：`GRAVITY_STEP` 0.6→0.3（GRAVITY_START=2/CAP=6 本就正确）；角色/独立道具/辅助三处物理共用常量，一并生效。
- **验证**：build + 全部单测过；replay 5 剧本哈希零漂移（剧本不触及长下落段）；batch:validate 基线因跳跃下落轨迹变化重冻（行为有意变更，偏离已在 sim.ts 注释写明）。

### 修复批次 20——落地滑步 + 必杀桩帧截断 + 上修饰键覆盖（✅ 2026-11-12）

> 玩家实测两 bug：① 跳跃落地后移动平移（站立姿势滑步，一会儿才恢复）；② 佩恩大招什么都看不见。

- **① 落地滑步（双因）**：`onLanded` 置 `labelLock=落地全长`（防行走维护劫持收尾标签），但落地内 `idle@帧N` 触发提前切 站立 后锁仍在 → 行走标签维护被压制数十 tick；同时 sim 行走物理只按状态门（NORMAL）施加 vx，落地/收尾窗口内持续位移。修复：sim 行走物理加「地面时需 `actLabel∈{站立,走} && labelLock<=0`」标签门（原版移动由 moveLeft/moveRight 槽驱动、收尾期槽已清空，不可能位移；airMove 空中不受限）；behaviors.idle 触发时清 `labelLock`（时间轴主动回位 = 收尾结束）；
- **② 必杀桩帧截断（佩恩大招看不见的根因，全角色家族性）**：原版 MC 时间轴在标签边界**不停车**，佩恩的 必杀 是 1 帧桩（真演出在紧随其后的 空中必杀 段：切人插图 Pain_1@894 + 演出 + endAct@943 + idle@946 收尾）；移植版「标签播尽即 endAction」把桩帧截断。全角色扫描确认家族模式：必杀→空中必杀桩（白哉/一护系/黑崎/冬狮郎/佩恩…）、上必杀→上必杀_1、佐助 招1_SP→招1 等 SP/QK 桩全部中招。修复：advanceAnimation 增**时间轴顺流**——非循环攻击标签播尽且 ①攻击态（isAttackingState，排除 起身→开场/胜利→失败 状态相邻误链）②结束标签范围内无重定向触发（idle/setLabelTo，真实数据每个动作段尾都有收尾脚本）③下一标签帧号连续且非循环（防滑入循环标签永锁）→ 滑入续播（不改 actionState/attackId/槽位，命中按帧判定不受影响）；
- **③ 上+必杀/上+技被跳覆盖（连带修复，全角色）**：发起必杀/技成功后，缓冲的 ↑ 在下一 tick 触发 startJump 覆盖动作（扣气了但大招没放出来，attackId 泄漏）。原版靠 doAction→clearAction 清空含 jump 在内的槽位挡住；移植版 jump 槽 null=缺省 起跳 无法作门——给地面 跳/快速下落/瞬身步/瞬步 意图分支补待机态门（NORMAL），攻击/技/必杀分支保持槽位门（连段 setAttack 重填路径不受影响）；
- **④ 防御接管速度**：doDefense/exitDefense 显式清 dampX/dampY（行走的 dampX=0 所有权只在待机标签窗口生效，防御冻结期/防御恢复 labelLock 窗口内不再有行走分支兜底）；
- **偏离记录**：dashStop 残速按 damping 自然衰减（原行走分支在 NORMAL 即时清零 vx——原版 dashStop 置 damping 本为平滑衰减收势，新行为更忠实，dash 滑行略长）；出生首帧 actLabel=null 时行走放行（advanceAnimation 首轮才置 站立，保持首 tick 可动）；落地窗口 immobilize 约 2-6 tick（idle@帧N 提前解锁）；
- **基线重冻（行为有意变更）**：ichigo-mechanics（dash 残速衰减路径）；ichigo-duel tick 179（**批次 19 遗留**：重力斜坡改变跳跃轨迹、批次 19 提交说明"replay 零漂移"结论有误——该剧本含跳跃必漂移，本次核对发现 tick 179 瞬态分叉后 finalHash 自愈一致）；batch:validate 58 角色+37 辅助全量重冻；core 三个 fixture（fighter/combat/slice9）补真实数据同构的标签尾 endAct+idle 收尾脚本（fixture 简化布局原无收尾脚本，顺流会串播相邻标签）；
- **验证**：headless 复现全转绿（佩恩 超必杀/普通必杀/上必杀、落地行走、白哉普通必杀）；build + core 102 单测 + replay 5 剧本 + batch:validate 门禁全过；
- **遗留（转入 §4.2）**：bisha 切人插图 effect 事件（id 'bisha'/endBisha）未在 app/render 消费——必杀判定与动画已正常，切图演出缺位；空中必杀 attackId=null（无动作 id 映射到 空中必杀 标签，纯表现无判定）。

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

- 独立道具逐帧命中矩形（原版由道具内层时间轴逐帧驱动，未导出——现取发射帧命名子对象判定区/零矩形占位，atmc 抓取伤害的内层 hitVO（atm1，power=50）同源待导；需 capture/dump 桥新导出管线，待语料审计后决策）；
- 辅助 rawScript 审计确认的未建模项（13-A6 定级，低影响偏离）：byakuya checkFunc 链（owner 死亡清道具 / 目标 getTargetState==21 脱抓提前收道具）；itachi 动态伤害 `power = targetHpMax×0.008`；suigetsu `isAttacking=true`；temari 风场系统（敌方弹速级 targetBulletSpeedLevel + targetSP.x 拉扯；owner speedUp 已提取）；
- 辅助残余静默 op：justHit（纯读）/ setTouchSide（语料无实例）——确定性静默，无行为差；
- 必杀切人插图 effect 事件（id 'bisha'/endBisha，批次 20 发现）未在 app/render 消费——sim 侧已发事件，必杀判定与动画正常，切图演出缺位；
- 空中必杀 attackId=null（无动作 id 映射到 空中必杀 标签）——时间轴顺流已能播放该段，纯表现无判定；
- 验收：门禁全过；行为变更则重冻对应基线。

### 4.3 阶段 4 体验完善（粒度先按块，开工前细化成切片）

| # | 块 | 内容 | 备注 |
|---|---|---|---|
| 1 | 断线处理 | peer-lost 后判负/重连（现为冻结等待） | ADR-15 预留 |
| 2 | 录像回放 | 输入序列 + 种子 + 数据版本戳的存储与播放 UI | 帧同步免费送，core 无需改 |
| 3 | 观战 | 只收不发输入的观战客户端 | net 层扩展 |
| 4 | rollback | 可选；视云上延迟体验决策 | 架构接口已预留（DESIGN §6） |
| 5 | 菜单流打磨 | ✅ 骨架（切片 14）；✅ 选人页原版化（切片 15）；✅ 菜单主页原版化（切片 16）；余 Logo 演出/格子动画/结算立绘/开场徽标去除（可选）+ 切片 14 UI 待打磨池（格子长名溢出/DOM 输入样式） | app 层场景系统 |
| 6 | 街机模式 | mission.xml 关卡数据 + AI（FighterAICtrler 转译，~700 行，种子随机） | AI 是 PvP 路径外的唯一大块逻辑 |
| 7 | 音效/特效接线 | 音源从 embed SWF 提取 + 表现事件消费完善（事件队列已留好）；effect.swf 已定位 | 音效随机选音源在渲染层做，不进 sim |
| 8 | 本地双人 | 第二本地输入源 | 扩展项池，主线收尾后最后做 |
| 9 | 进战斗加载画面 | LoadingScene 进度条（原版 GameLoadingStage/LoadingStage 语义）+ 装载分帧化（现同步串行卡主线程）+ bg cover 首帧定位（修"进场黑边"） | 原版场景链：选人 → Loading → GameStage |

---

## 五、下一步（按优先级）

1. **真机体验验证**（§4.1）——云服务器已部署（wss 冒烟通过）+ 切片 14/15/16 菜单/联机/选人 UI 已通，公网两端完整对局人工验收条件已齐（入口 `?mode=net&action=create&server=wss://120.48.185.202/`，页面上点选即可）；
2. **阶段 3 尾巴**（§4.2，低影响偏离池：逐帧命中矩形 / checkFunc 链 / itachi 动态伤害 / temari 风场）——或按用户指示切换其他块；
3. 阶段 4 各块按 §4.3 表顺序推进，每块开工前细化为切片并登记进 §二 明细表。
