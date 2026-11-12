# BVN 逻辑层模块地图（阶段 0 产出）

> 对象：OpenBleachVsNaruto（开放·死神vs火影 3.4 归档版，GPL-3.0）
> 方法：逐文件阅读 `swf_source` 全部游戏本体源码 + 抽样核对角色/辅助/地图 XFL + 交叉验证 `bvn-ai-public` 的逆向成果
> 日期：2026-11-08
> 用途：阶段 1（POC 移植）的设计输入；标注 **已核实 / 推断** 两类结论

### 外部参考仓库（原立项书清单的存留部分，2026-11-12 移入）

- [OpenBleachVsNaruto](https://github.com/5DPLAY-Game-Studio/OpenBleachVsNaruto) —— 3.4 归档版全量源码（**移植底稿**；已克隆在仓库根，gitignore 只读）
- [BleachVsNaruto_TagAssets](https://github.com/5DPLAY-Game-Studio/BleachVsNaruto_TagAssets) —— 官方素材库（素材提取用）
- [BleachVsNaruto_FlashSrc](https://github.com/5DPLAY-Game-Studio/BleachVsNaruto_FlashSrc) —— FLA/XFL Flash 源文件（帧动画/素材）
- [BleachVsNaruto](https://github.com/5DPLAY-Game-Studio/BleachVsNaruto) —— 主线 3.7 Alpha（持续变动，仅参考，不做基底）
- [bvn-ai-public](https://github.com/lcx03876-hue/bvn-ai-public) —— BVN 游戏内状态桥逆向（已克隆在仓库根；本文档多处交叉验证来源）
- [assets_lib](https://github.com/qxyk99/assets_lib) —— 社区整理素材库（备用）

---

## 0. 一页速览：给转译者的 12 条结论

1. **逻辑帧率不是 24/30 的固定值**：默认画质 LOW 为 30fps，中画质及以上为 60fps；动画/命中判定独立按 30fps 采样。移植时应固定 60Hz 逻辑帧、30Hz 动画帧，把原版 30fps 视为同构的降速档。
2. **物理与判定节奏不同**：位移/重力/推挤每逻辑帧执行；命中判定、动画推进、受伤击飞状态机只在“动画帧”执行（60fps 模式下每 2 帧一次）。
3. **逻辑层与显示层没有边界**：`FighterMain` 同时持有数值状态和 `MovieClip`；碰撞区来自 SWF 帧内命名子对象的 `getBounds()`。这是移植最大难点。
4. **角色动作数据不在引擎源码里**：藏在每个角色 XFL 的根时间轴脚本中（38 个角色工程、61 个可用角色 ID、约 18.7 万字节脚本、每个角色 20~156 条 `defineAction`）。辅助还有 37 个工程、约 3.8 万字节。
5. **判定区是逐帧烘焙的轴对齐矩形**（AABB），角色本身不旋转；可在离线阶段烘焙成 JSON，运行时只做矩形相交。
6. **输入是轮询式抽象按键**，带 0.1 秒 just-down 延迟窗口；默认经典模式（`keyInputMode=1`）。帧同步只需同步每帧的“按键按住位图”。
7. **逻辑依赖相机**：版边位置修复读取相机缩放/屏幕矩形（[`GameLogic.fixGameSpritePosition`](OpenBleachVsNaruto/swf_source/#FighterTester/src/net/play5d/game/obvn/ctrler/GameLogic.as#L253)）。~~相机必须进确定性模拟~~——移植时被 ADR-4 推翻：改用牵引边界表达同一设计意图，相机降为纯渲染（见 DESIGN §3.4）。
8. **核心战斗几乎不依赖随机**：`Math.random` 只出现在 AI、音效、UI；PvP 帧同步路径干净。
9. **还有大量非确定性隐患**：`Dictionary` 迭代顺序、`getTimer`（UI）、帧率相关的计时常量、`sortOn` 稳定性。
10. **编译产物不在仓库**：人物/辅助/地图 SWF 在 Release 的 `swf_output.rar`（58 MB，tag `RELEASE_20261031`）；仓库内有可用的 XFL 源。
11. **角色时间轴里还有玩法脚本**（发射道具、召唤、形态切换、音效触发），属于逻辑，不能当纯素材。
12. **粗估分层比例**：游戏本体约 2.8 万行；约 55~60% 可转译进逻辑层，40~45% 必须重写为渲染/UI 层。

---

## 1. 代码库盘点

### 1.1 规模（已核实）

| 项 | 数值 |
|---|---|
| `swf_source` 下 `.as` 文件 | 183 个 |
| 主程序 `#FighterTester/src` | 28,143 行 |
| 引擎/第三方 `#FighterTester/libs` | 4,097 行（29 个文件） |
| 人物工程 `f_fighter` | 38 个（含形态/变体，同一 SWF 多形态） |
| 可用人物 ID（`fighter.xml`） | 61 个 |
| 辅助工程 `f_assistant` | 37 个；可用辅助 ID 40 个 |
| 地图工程 `map` | 15 个；配置条目 16 个（含 random） |
| 角色根时间轴嵌入脚本 | 187,361 字节 |
| 辅助嵌入脚本 | 约 38,000 字节 |
| 地图嵌入脚本 | 0（地图纯显示/碰撞几何） |

### 1.2 目录职责

```
swf_source/
├─ #FighterTester/          主程序（AS3 工程 + 引擎库）
│  ├─ src/net/play5d/game/obvn/   游戏本体（本文分析对象）
│  └─ libs/                 5DPLAY KyoLib（显示/加载/输入/工具） + greensock
├─ f_fighter/<角色>/        角色 XFL（LIBRARY/元件/*.xml 动画符号 + 时间轴脚本）
├─ f_assistant/<辅助>/      辅助 XFL
├─ map/<地图>/              地图 XFL
├─ embed/                   UI/音效嵌入 SWF 源
├─ assets/                  部分素材 XFL（特效、头像）
└─ swf_output/assets/config/运行时 XML 配置（fighter/map/select/mission/assistant）
```

---

## 2. 启动与场景流（已核实）

```
FighterTester (main class, SWF 30fps, 1000×600)
  └─ MainGame.initlize()
      ├─ ResUtils 初始化
      ├─ GameRender.initlize(stage)         // 注册 ENTER_FRAME
      ├─ GameInputer.initlize(stage)        // 注册键盘监听
      ├─ GameData.I.loadData()               // 读存档配置
      ├─ ConfigVO.applyConfig()              // 决定 FPS / 画质
      ├─ KyoStageCtrler
      └─ GameLoadingStage → 菜单
```

场景链：`Logo → Menu → SelectFighter → Loading → GameStage → Winner/GameOver`。
所有场景继承 `Sprite` 实现 `IStage`，由 `KyoStageCtrler` 切换。
进入战斗：`MainGame.goGame()` 创建 `GameStage`，调用 `GameCtrler.I.startGame()`，并把帧率设为 `GameConfig.FPS_GAME`。

**注意**：菜单/UI 场景固定 30fps；战斗帧率跟随画质配置。

---

## 3. 帧循环与时序（本项目的核心事实）

### 3.1 单一 ENTER_FRAME 驱动一切

`GameRender` 是一个全局回调注册表（[GameRender.as](OpenBleachVsNaruto/swf_source/#FighterTester/src/net/play5d/game/obvn/ctrler/GameRender.as#L62)）：

- `GameRender.add(func, owner)` 把多个模块的 render 函数注册到同一个 `ENTER_FRAME`。
- 回调按 `Dictionary` 迭代顺序执行——**AS3 未规定该顺序**，这是移植时必须显式定序的地方。
- 主要注册者：`GameInputer.render`、`GameCtrler.render`、UI/特效/精灵的 `renderSelf`。

战斗期间每个 `ENTER_FRAME` 的调用链（已核实）：

```
stage ENTER_FRAME
└─ GameRender.render()
   ├─ GameInputer.render()                    // just-down 计时器递减
   ├─ GameCtrler.render()                     // 战斗主循环
   │  ├─ renderPause()
   │  ├─ EffectCtrler.render()                // 纯视觉
   │  ├─ gameStage.render()                   // 相机、地图视觉、战斗 UI
   │  ├─ checkRenderAnimate()                 // 每 N 帧触发一次“动画帧”
   │  │  └─ renderAnimate()                   // 标记动画帧 + 倒计时
   │  └─ GameMainLogicCtrler.render()
   │     ├─ for each game sprite:
   │     │   ├─ GameLogic.fixGameSpritePosition()   // 相机/版边约束（依赖相机）
   │     │   ├─ GameLogic.isInAir() + applyG()      // 地形/重力
   │     │   ├─ sp.render()                         // 速度积分、延迟回调
   │     │   └─ [动画帧] sp.renderAnimate()         // MC nextFrame、击飞状态机
   │     ├─ checkBodyHit(A,B)                        // 每帧：角色间推挤
   │     └─ [动画帧] checkHit(A,B)                   // 命中判定
   └─ 其他 UI/特效回调
```

### 3.2 三套“帧率”

| 常量 | 值 | 作用 |
|---|---|---|
| `GameConfig.FPS_GAME` | 30 或 60（画质决定） | 逻辑/物理 tick 频率 |
| `GameConfig.FPS_ANIMATE` | 固定 30 | 动画推进、命中判定频率 |
| `GameConfig.FPS_UI` / `FPS_SHINE_EFFECT` | 30 / 15~60 | 纯 UI/特效 |
| `SPEED_PLUS_DEFAULT` | `30 / FPS_GAME`（60fps→0.5，30fps→1） | 所有位移/重力的速度缩放 |

`GameCtrler.initlize()`：`_renderAnimateGap = ceil(FPS_GAME / FPS_ANIMATE) - 1`
- 30fps：gap=0 → 每个 tick 都是动画帧
- 60fps：gap=1 → 每 2 tick 一个动画帧

**结论**：原版在 30fps 下“物理=动画=判定=30Hz”；在 60fps 下“物理=60Hz，动画/判定=30Hz”。移植建议统一为 60Hz 逻辑 + 30Hz 动画，用 `SPEED_PLUS` 归一到原版数值。

### 3.3 计时相关的隐性帧依赖

- 输入 just-down 延迟：`JUST_DOWN_DELAY = 0.1 * MainGame.getFPS()`（[GameInputer.as](OpenBleachVsNaruto/swf_source/#FighterTester/src/net/play5d/game/obvn/input/GameInputer.as#L19)）
- 防御刚键窗口：`_justDefenseFrame = 0.1 * FPS_GAME`
- 回合倒计时：每 31 次“动画帧”减 1 秒（[GameCtrler.renderGameTime](OpenBleachVsNaruto/swf_source/#FighterTester/src/net/play5d/game/obvn/ctrler/game_ctrler/GameCtrler.as#L570)）；训练模式无限
- 能量冷却：`USE_ENERGY_CD * ENERGY_ADD_OVER_LOAD_RESUME` 帧

这些都要在移植时改成显式的“帧计数常量”，不能沿用按秒计算。

---

## 4. 三层分类（逻辑 / 渲染 / 资源）

### 4.1 逻辑层（可转译，必须与渲染解耦）

| 模块 | 文件 | 行数 | 说明 |
|---|---|---|---|
| 全局配置 | `data/GameConfig.as` | ~120 | 物理/判定/战斗常量、速度缩放 |
| 全局逻辑 | `ctrler/GameLogic.as` | 365 | 地形触及、版边修复、命中分数、死亡判定 |
| 战斗主逻辑 | `ctrler/game_ctrler/GameMainLogicCtrler.as` | 357 | 每帧推进、重力、推挤、命中检测 |
| 战斗流程 | `ctrler/game_ctrler/GameCtrler.as` 等 5 个 | ~700 | 开局/回合/结束/训练/暂停/时间 |
| 人物状态 | `fighter/FighterMain.as` | 608 | HP/气/能量/状态码/目标选择 |
| 行动状态机 | `fighter/ctrler/FighterMcCtrler.as` | ~2,200 | 地面/空中/防御/受伤/瞬步/万解等 |
| 行动槽 | `fighter/FighterAction.as` | 128 | 当前可用招式映射 |
| 攻击模型 | `fighter/model/FighterHitModel.as` | 72 | HitVO 注册表 |
| 判定数据 | `fighter/vo/HitVO.as`, `data/HitType.as`, `data/FighterActionState.as`, `data/FighterHitRange.as` | ~250 | 攻击属性、状态码、判定名 |
| 队伍/回合数据 | `data/GameRunFighterGroup.as`, `vo/GameRunDataVO.as`, `data/TeamVO/TeamMap` | ~250 | 选人/换人/比分 |
| 输入决策 | `input/GameInputer.as`, `input/GameKeyInput.as`, `fighter/ctrler/FighterKeyCtrler.as` | ~470 | 抽象按键 → 动作意图 |
| 派生战斗对象 | `fighter/Bullet.as`, `fighter/FighterAttacker.as`, `fighter/Assister.as` | ~1,200 | 飞行道具/独立道具/辅助 |
| 地图几何 | `map/MapMain.as`, `map/vo/MapVO.as` | 390 | 边界/地板/出生点（显示部分剥离） |
| AI | `fighter/ctrler/ai/*.as` | ~700 | 单人/观战用；PvP 不需要但可保留 |

### 4.2 渲染层（重写，不转译）

| 模块 | 文件 | 说明 |
|---|---|---|
| 全局渲染调度 | `ctrler/GameRender.as` | 改为固定顺序 tick 调度器（不是纯渲染，但需重写） |
| 人物显示 | `fighter/FighterMC.as` | MC 帧推进、帧标签、区域缓存、击飞动画 |
| 人物显示控制器 | `fighter/ctrler/FighterMcCtrler` 中的动画分支 | 与状态机混合，需拆分 |
| 基础精灵显示 | `fighter/BaseGameSprite.as` 中的 DisplayObject 部分 | 位置/朝向/音量/层序 |
| 镜头 | `ctrler/GameCamera.as` | 跟随/缩放（但其状态必须可被逻辑读取） |
| 地图显示 | `map/MapMain.as` 的 layer/render 部分 | bg/map/front/front_fix/地板 |
| 特效 | `ctrler/EffectCtrler.as`（28 KB）+ `views/effects/*` | 震动、闪光、钢身、受击特效 |
| 战斗 UI | `ui/fight/*.as` | HP/气/能量/连击/计时/头像 |
| 菜单/选人/结算 | `stage/*.as` + `ui/*.as` | 除选人规则外基本重写 |
| 音效 | `ctrler/SoundCtrler.as`, `fighter/ctrler/FighterVoice*.as` | 随机语音、音效触发 |
| Kyo 显示库 | `libs/net/play5d/kyo/display/*` | BitmapFont/按钮等 |
| greensock | `libs/com/greensock/*` | 补间，可换自研 |

### 4.3 资源/加载层（重写）

`ctrler/AssetLoader.as`、`AssetManager.as`、`GameLoader.as`、`utils/BitmapAssetLoader.as`、`utils/ResUtils.as`、`model/*Model.as`、`vo/FighterVO` 等：负责 XML 配置与 SWF 素材加载。移植后替换为“JSON 配置 + spritesheet/atlas 加载”。

### 4.4 混合层（必须拆分，不能整体转译）

| 类 | 逻辑部分 | 显示部分 |
|---|---|---|
| `FighterMain` | HP/气/能量/状态/目标/受击累积 | `_mainMc`、颜色、帧跳转 |
| `BaseGameSprite` | 速度/阻尼/重力/朝向/层序计算 | `MovieClip` 位置、音量 |
| `FighterMcCtrler` | 状态机、招式触发、受击结算 | `_mc.goFrame()`、动画帧推进、特效触发 |
| `FighterCtrler` | 判定区计算（可数据化） | 通过 `FighterMC` 取 `getBounds` |
| `MapMain` | 左右/底边/地板/出生点 | 图层、视差、遮挡透明 |
| `FighterAttacker/Assister/Bullet` | 速度/碰撞/生命周期 | MovieClip 动画 |
| `GameCamera` | 位置/缩放数值（影响逻辑） | 显示变换 |

---

## 5. 核心类详解

### 5.1 `FighterMain`：角色状态容器

关键字段（[FighterMain.as](OpenBleachVsNaruto/swf_source/#FighterTester/src/net/play5d/game/obvn/fighter/FighterMain.as#L24)）：

| 字段 | 含义 |
|---|---|
| `hp / hpMax` | 血量；`hpMax = customHpMax` 或 `FIGHTER_HP_MAX(1000) * config.fighterHP * missionRate`。配置倍率为 1 时是 1000；测试台/街机常见 2000 或更高，**不要按常量 1000 假设运行时血量** |
| `qi / qiMax` | 气（必杀资源），上限 300 |
| `energy / energyMax` | 钢身/闪避能量，上限 100，有超载机制 |
| `fzqi / fzqiMax` | 辅助召唤资源，上限 100，每帧回复 |
| `speed`, `jumpPower`, `heavy` | 移动/跳/重量（推挤系数） |
| `actionState` | 状态码（见 5.2） |
| `direct`, `scale` | 朝向（±1）、缩放 |
| `isAlive`, `isAllowBeHit`, `isInAir`, `isTouchBottom`, `isSteelBody`, `isSuperSteelBody` | 战斗开关 |
| `lastHitVO`, `hurtHit`, `defenseHit` | 最近命中/受击信息（招式联动用） |
| `targetTeams` | 敌对队伍；`getCurrentTarget()` 选最近/优先级目标 |
| `jumpTimes`, `airHitTimes` | 剩余跳跃/空中攻击次数 |

### 5.2 动作状态码（`FighterActionState`）

`NORMAL=0, ATTACK_ING=10, SKILL_ING=11, BISHA_ING=12, BISHA_SUPER_ING=13, JUMP_ING=14, DASH_ING=15, HURT_ACT_ING=16, DEFENCE_ING=20, HURT_ING=21, HURT_FLYING=22, HURT_DOWN=23, HURT_DOWN_TAN=24, DEAD=30, FREEZE=40, WAN_KAI_ING=50, KAI_CHANG=60, WIN=61, LOSE=62`

`FighterMcCtrler` 是真正的大状态机（~2,200 行），按类别：
- 地面行动：走、防、跳、落、瞬步、砍/技/招/摔/必杀、万解
- 空中行动：跳砍/跳招/空中必杀/空中瞬步/受身
- 受击：钢身减伤、防御、破防、击飞（4 个子状态）、倒地、起身、受身
- 特殊：瞬步残影（ghost step）、移形换位（换人）、目标投技、贴地动作
- 动画驱动：`_mc.goFrame(动作名)`；角色时间轴在特定帧回调 `$mc_ctrler.fire()/addAttacker()` 等

### 5.3 `FighterAction`：每帧可用的动作槽

`idle("站立")` 时由 `setAllAct()` 重新填充：走/防/跳/落/瞬步/砍/技1/技2/招1~3/摔1~2/必杀/上必杀/超必杀/万解。角色可通过 `setJump("自定义帧名")` 覆盖默认帧名；`checkFrame()` 保证该角色确实有该帧。

### 5.4 `FighterMC`：MC 包装与区域缓存

- 帧推进：`_mc.nextFrame()`，每“动画帧”一次
- 命名子对象约定（详见 §7.2）：`bdmn` 受击体、`atm<id>` / `<id>` 攻击判定、`AImain` 招式范围、`line_*` 地图边界
- `findBodyArea()/findHitArea()` 按当前帧缓存 `getBounds()` 结果
- 击飞子状态机 `renderHurtFly()`（1→2→3→4）
- 帧标签缺失时记录 `_undefinedFrames`，只警告不失败

### 5.5 输入链

```
KeyboardEvent → KeyBoarder → GameKeyInput (_downKeys 码表)
                     ↓ 轮询
GameInputer (P1/P2/MENU 输入组；just-down 1=首次按下，2=0.1s 延迟窗口)
                     ↓
IFighterActionCtrler（接口）
   ├─ FighterKeyCtrler   （人类，抽象按键 → 意图）
   └─ FighterAICtrler    （AI，直接产生意图）
                     ↓ 轮询
FighterMcCtrler.renderFloorAction()/renderAirAction()  // 每 tick 读取意图
```

默认键位（`ConfigVO.setDefaultConfig`）：
- P1：W/S/A/D + J/K/L/U/I/O
- P2：方向键 + Num1~Num6
- 菜单：W/S/A/D + J/K/L/U/I/O

抽象按键：左/右/上/下/攻击/跳/瞬步/技能/必杀/辅助/万解（万解=攻击+跳）。

经典模式（默认 `keyInputMode=1`）：`FighterKeyCtrler._justDown = 0`，即“按住”判定；非经典模式使用 `_justDown=2` 的 0.1s 窗口。移植时两种模式都应支持，帧同步记录**每帧按住位图**即可（just-down 由本地状态机推导）。

### 5.6 命中判定与结算（重点）

`GameMainLogicCtrler.renderMainLogic()`：

1. 每 tick：`checkBodyHit(A,B)`——按 `heavy` 计算推挤分量，处理版边卡住情况。
2. 动画帧：`checkHit(A,B)`：
   - 取 A/B 的 `getCurrentHits()`；排除 `isAllowBeHit=false` 的一方
   - `getHitObj(hits, body)` 遍历攻击判定矩形，与对方 body 矩形求交
   - 命中后：`B.beHit(hitVO, overlapRect)` + `A.hit(hitVO, B)`
   - `A.hit` → `FighterEventDispatcher` 触发 `HIT_TARGET`（连击计数/计分/换人逻辑）
   - `B.beHit` → `FighterMcCtrler.beHit`：
     ```
     钢身？ → doSteelHurt（减伤/耗能量/破防判定）
     防御中？ → 抓取/真实伤害 → doHurt；方向正确 → doHurt；否则 doDefenseHit
     其他 → doHurt（扣血、击飞、受击事件、QI 回复、辅助增益结算）
     ```

攻击数据 `HitVO` 字段：`power, hitType, hitx, hity, hurtTime, hurtType, isBreakDef, isReal, checkDirect, currentArea`。
`hitType`：1砍 / 2打 / 3重打 / 4魔法轻 / 5魔法重 / 6重砍 / 7火 / 8冰 / 9电 / 10石化 / 11摔。
`hurtTime` 决定硬直（帧），`hitx/hity` 决定击退速度与击飞高度。

判定区来源（[FighterCtrler.getCurrentHits](OpenBleachVsNaruto/swf_source/#FighterTester/src/net/play5d/game/obvn/fighter/ctrler/FighterCtrler.as#L326)）：
`FighterMC.getCurrentHitArea()` → 当前 MC 帧中名字匹配 HitVO id 的子对象 → `getBounds(角色显示容器)` → `RectUtils.cached()` 按朝向/坐标变换为场地矩形。

**判定区是角色局部坐标的 AABB，随帧变化；不是矢量碰撞。** 这使移植可完全数据化。

### 5.7 派生战斗对象

| 类 | 玩法职责 | 数据来源 |
|---|---|---|
| `Bullet` | 飞行道具：速度/加速度/上下限/命中后减速/时长/循环帧/命中次数 | 角色帧脚本 `$mc_ctrler.fire(mcName, params)` |
| `FighterAttacker` | 独立道具：跟随目标/移动/判定区/生命周期 | `$mc_ctrler.addAttacker()` |
| `Assister` | 辅助：出场/攻击/增益 buff（属性抗性/吸血） | 辅助 SWF 的 `setAssistCtrler` + 辅助时间轴脚本 |

三者在 `GameMainLogicCtrler` 中与人物同构参与推进与命中检测。

### 5.8 地图

`MapMain.initlize()` 从地图 MC 的命名子对象读取：`line_left/line_right/line_bottom/line_player_bottom`（边界）、`p1/p2`（出生点）、`map/front/front_fix/bg`（显示层）、`floor` 子对象列表（可站立平台，生成 `FloorVO{xFrom,xTo,y}`）。
`GameLogic.isInAir()` 用地板列表做垂直落地检测；`fixGameSpritePosition()` 用地图边界+镜头矩形限制 X。

---

## 6. 角色/辅助数据藏在哪里（移植关键）

### 6.1 配置 XML（运行时读取）

| 文件 | 内容 |
|---|---|
| `assets/config/fighter.xml` | 61 个人物 ID：`comic_type`（死神/火影）、`file url`（角色 SWF）、`startFrame`（形态帧）、头像类、台词、BGM |
| `assets/config/assistant.xml` | 40 个辅助 ID |
| `assets/config/select.xml` | 选人界面布局（行列、偏移、`more=` 形态切换） |
| `assets/config/map.xml` | 16 个地图 ID + 显示名 |
| `assets/config/mission.xml` | 街机模式关卡（AI 等级、血量倍率、出招率） |

**同一角色 SWF 承载多个形态**：`startFrame=1..7` 对应根时间轴的形态帧（例如一护：普通/卍解/半虚/虚化/零段…）。`FighterMain.initlize()` 执行 `_mainMc.gotoAndStop(data.startFrame + 1)`。

### 6.2 角色时间轴脚本（容易被忽略的逻辑）

每个角色 XFL 的 `DOMDocument.xml` 根时间轴包含：
- 第 0 帧：`initFighter(param)`，接收 `fighter_ctrler / mc_ctrler / effect_ctrler`
- 后续帧：`defineAction(id, {power, hitType, hitx, hity, hurtTime, hurtType, isBreakDef})`
- `defineBishaFace / defineHurtSound / defineHurtFlySound / defineDieSound`
- 速度/重量/防御类型/特殊帧覆盖（`$fighter_ctrler.setJump(...)`、`setBisha(...)` 等）
- 角色自定义玩法逻辑（形态切换、飞行道具、召唤、连招状态变量）
- 动画符号内特定帧的 `$mc_ctrler.*` 调用（发射道具、特效、音效、传送等）

示例（ichigo）：
```actionscript
defineAction("k1",{power:40,hitType:1,hitx:3,hity:0,hurtTime:300,hurtType:0,isBreakDef:false});
defineAction("cbs",{power:450,hitType:5,hitx:40,hity:0,hurtTime:0,hurtType:1,isBreakDef:false});
$fighter_ctrler.defineBishaFace("Ichigo_1", bsface1);
```

**动作 id → 动画标签映射**（切片 5 核对原版 `FighterKeyCtrler` 按键分流后定案；切片 3 的 kj1→跳砍 系误读，已纠正）：
`kN→砍N`、`kjN→砍技N`（下+攻击 / 上+攻击的技）、`zhN→招N`（skill 键系）、`tk→跳砍`（空中攻击）、`tz→跳招`、`shN→摔N`、`bs→必杀`、`sbs→上必杀`、`cbs→超必杀`。

**结论**：这些脚本属于“角色逻辑”，必须转译，不能只当素材。38 个角色 + 37 个辅助都要做，但体格小（单角色 3~19 KB）。

### 6.3 动画符号内的几何

`LIBRARY/元件/mc_*.xml`：
- `DOMFrame name="站立"/"砍1"/"击飞"... labelType="name"`：动画帧标签（ichigo 约 314 个标签条目）
- 元素实例名：`bdmn`（受击体）、`atm*` 或 HitVO id（攻击判定）、`AImain`（招式范围容器）
- 形状坐标 + 变换矩阵（`getBounds` 的数据源）

---

## 7. 素材与资产管线

### 7.1 现状

- 角色/辅助/地图的**编译后 SWF 不在仓库**；`swf_output/assets/fighter` 只有空目录。
- Release `RELEASE_20261031` 的 `swf_output.rar`（58 MB）是完整可运行包，是 SWF 素材来源。
- 仓库内 XFL 是 Flash CC 2015 格式，可解析但需要自己实现几何烘焙。
- 工具链（Flash Builder 4.7 / Flash Professional CC 2015）已不可得。

### 7.2 建议的资产提取方案（两阶段）

**方案 A（推荐）：运行时导出器**
仿照 `bvn-ai-public` 的做法：用 FFDec 反编译/注入主 SWF，增加一个“素材导出”脚本：
- 遍历 `FighterModel` 全部角色，对每个形态根帧、每个动画标签、每一帧：
  - dump 帧标签、帧序号、MC 子对象名、`getBounds`（bdmn/atm/id/AImain）
  - dump `HitVO` 全表、动作槽、声音触发帧
- 遍历地图 dump 边界线/出生点/floor/层结构
- 输出 JSON + spritesheet 元数据
优点：直接使用 Flash 的 `getBounds` 语义，零几何误差；不需要构建 XFL。bvn-ai-public 已验证 FFDec 可重编译 SWF。

**方案 B（离线解析）**：解析 XFL 的 `<DOMShape>` 边列表，自己算包围盒。几何误差与矩阵/描边处理需要对齐，风险较高，只适合作为交叉校验。

### 7.3 目标素材格式（建议）

```
assets/
├─ fighters/<id>.json       # 形态、帧标签→帧号、帧时长、动作定义、判定表、触发帧
├─ fighters/<id>.png/.atlas # 动画帧图集
├─ assistants/<id>.json/.atlas
├─ maps/<id>.json           # 边界/出生点/地板/层视差参数
├─ maps/<id>.png
├─ config/*.json            # 选人/关卡/键位
└─ audio/...
```

---

## 8. 移植映射建议

> **本节已被正式架构设计取代**：目录结构、接口定义、帧循环、对齐策略以 [DESIGN.md](DESIGN.md) 与 [ARCHITECTURE.md](ARCHITECTURE.md) 为准。本节仅保留历史记录价值，不再维护。其中"InputFrame 位图""CharacterDef 数据化""快照哈希对拍"等思路已全部吸收进正式架构。

---

## 9. 确定性审计

| # | 隐患 | 证据 | 影响 | 应对 |
|---|---|---|---|---|
| 1 | `Dictionary` 迭代顺序不定 | [GameRender.render](OpenBleachVsNaruto/swf_source/#FighterTester/src/net/play5d/game/obvn/ctrler/GameRender.as#L62) | 回调顺序影响逻辑（输入→战斗→UI） | 显式注册顺序/阶段化 tick |
| 2 | 逻辑读取相机状态 | [GameLogic.fixGameSpritePosition](OpenBleachVsNaruto/swf_source/#FighterTester/src/net/play5d/game/obvn/ctrler/GameLogic.as#L253) | 版边位置依赖相机缩放/矩形 | 相机纳入模拟，或移除该耦合 |
| 3 | `getTimer()` | `FightUI`, `ShineEffectView` | 仅 UI/视觉 | 渲染层可用；逻辑层禁用 |
| 4 | `Math.random()` | AI、`SoundCtrler`、`FighterVoiceCtrler`、特效 | AI/音效随机不影响 PvP 战斗 | PvP 路径不调用；AI 用种子随机 |
| 5 | 帧率相关常量 | just-down/防御窗口/回合计时 | 不同 fps 行为不同 | 固定 tick + 帧常量 |
| 6 | `sortOn("order", 16)` 目标选择 | `FighterMain.getCurrentTarget` | 排序稳定性未定义 | 显式稳定排序 + 固定 tiebreak |
| 7 | `getBounds()` 几何 | `FighterMC` 区域缓存 | 依赖显示矩阵与 SWF 数据 | 烘焙成 JSON，运行时无几何查询 |
| 8 | 动画帧触发玩法事件 | 角色时间轴 `$mc_ctrler.*` | 漏掉则招式失效 | 提取为 `triggers` 数据表 |
| 9 | 浮点超越函数 | 未发现用于核心逻辑（`Math.abs` 除外） | 风险低 | 禁止新增 sin/cos/sqrt 到逻辑 |
| 10 | 音效触发与回滚 | 动画帧/受击触发 | rollback 重放会重复播放 | 阶段 3 再做去重策略 |

**好消息**：核心战斗路径没有 `Math.random`，数值仅用四则运算（`KyoUtils.num_wake` 是纯加减），跨端 IEEE754 一致，帧同步的数学基础是干净的。

---

## 10. 阶段 1 建议切片（已取代）

> 本节的切片方案已被正式设计取代（有重排：本地双人移出主线、训练模式保留等）。
> 实际切片划分与完成状态见 [DESIGN.md](DESIGN.md) §9 与 [PROGRESS.md](PROGRESS.md)。本节仅存历史记录于 git 历史。

---

## 11. 待确认问题（全部已决策，本节关闭）

| 问题 | 决策 | 出处 |
|---|---|---|
| 手感基准 | 60fps 模式（60Hz 逻辑 + 30Hz 动画） | DESIGN §3.1 / ADR-2 |
| 素材导出方式 | FFDec 注入导出器 | DESIGN §4 / ADR-5 |
| 角色脚本转译比例 | 38 角色脚本全部保留 | ADR-6 |
| 输入模式 | 废弃双模式，统一"按住位图 + 可配置缓冲窗口"（默认 6 帧） | DESIGN §3.3 / ADR-3 |
| 相机是否进模拟 | 都不选：牵引边界，相机纯渲染化 | DESIGN §3.4 / ADR-4 |

---

## 附录 A：核心文件索引

| 关注点 | 文件 |
|---|---|
| 入口/测试台 | [FighterTester.as](OpenBleachVsNaruto/swf_source/#FighterTester/src/FighterTester.as) |
| 初始化/场景流 | [MainGame.as](OpenBleachVsNaruto/swf_source/#FighterTester/src/net/play5d/game/obvn/MainGame.as) |
| 帧调度 | [GameRender.as](OpenBleachVsNaruto/swf_source/#FighterTester/src/net/play5d/game/obvn/ctrler/GameRender.as) |
| 战斗主循环 | [GameCtrler.as](OpenBleachVsNaruto/swf_source/#FighterTester/src/net/play5d/game/obvn/ctrler/game_ctrler/GameCtrler.as), [GameMainLogicCtrler.as](OpenBleachVsNaruto/swf_source/#FighterTester/src/net/play5d/game/obvn/ctrler/game_ctrler/GameMainLogicCtrler.as) |
| 物理/地形 | [BaseGameSprite.as](OpenBleachVsNaruto/swf_source/#FighterTester/src/net/play5d/game/obvn/fighter/BaseGameSprite.as), [GameLogic.as](OpenBleachVsNaruto/swf_source/#FighterTester/src/net/play5d/game/obvn/ctrler/GameLogic.as), [MapMain.as](OpenBleachVsNaruto/swf_source/#FighterTester/src/net/play5d/game/obvn/map/MapMain.as) |
| 状态机 | [FighterMcCtrler.as](OpenBleachVsNaruto/swf_source/#FighterTester/src/net/play5d/game/obvn/fighter/ctrler/FighterMcCtrler.as) |
| 角色状态 | [FighterMain.as](OpenBleachVsNaruto/swf_source/#FighterTester/src/net/play5d/game/obvn/fighter/FighterMain.as) |
| 动画/判定区 | [FighterMC.as](OpenBleachVsNaruto/swf_source/#FighterTester/src/net/play5d/game/obvn/fighter/FighterMC.as), [FighterCtrler.as](OpenBleachVsNaruto/swf_source/#FighterTester/src/net/play5d/game/obvn/fighter/ctrler/FighterCtrler.as) |
| 输入 | [GameInputer.as](OpenBleachVsNaruto/swf_source/#FighterTester/src/net/play5d/game/obvn/input/GameInputer.as), [GameKeyInput.as](OpenBleachVsNaruto/swf_source/#FighterTester/src/net/play5d/game/obvn/input/GameKeyInput.as), [FighterKeyCtrler.as](OpenBleachVsNaruto/swf_source/#FighterTester/src/net/play5d/game/obvn/fighter/ctrler/FighterKeyCtrler.as) |
| 角色数据 | `swf_output/assets/config/fighter.xml`; `swf_source/f_fighter/<角色>/DOMDocument.xml` |
| 逆向参考 | `bvn-ai-public/docs/ARCHITECTURE.md`、`bridge/*.as`（字段语义与运行时数值） |
