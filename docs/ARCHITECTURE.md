# BVN Web —— 引擎契约（ENGINE CONTRACT）

**任何 AI 或人类协作者写代码前必须读完本文件。它是唯一的协调机制。**
设计理由与决策背景见 [DESIGN.md](DESIGN.md)；本文档只规定"必须怎么做"，不解释"为什么"。
契约条款如需修改，必须在本文件显式修订，不允许在代码里静默偏离。

目标：把死神vs火影（BVN）重构为网页联机格斗游戏。TypeScript + PixiJS，确定性帧同步。
关键事实：**这是重构，不是复刻**——行为对齐原版手感，结构自由重写。

---

## 硬规则（违反即 bug，review 逐条检查）

1. **core 是确定性孤岛。** `packages/core` 内禁止：
   - `Math.random()`（用 `core/rng.ts` 注入种子）、真实时钟（`Date.now`/`performance.now`）；
   - `Math.sin/cos/tan/sqrt/atan2/exp/log`、非整数次 `pow`（需要时在 `core/math/` 建查找表）；
   - 依赖对象/Map 迭代顺序做逻辑判断（显式按 ID 升序遍历）；
   - 任何 I/O、DOM、PixiJS、网络 API；
   - 游离的可变全局状态（全部状态收进单个 `SimState`，可整体快照/恢复）。
   允许：IEEE754 双精度四则运算、`Math.abs/floor/ceil/round/min/max`、位运算。
2. **帧模型固定。** 逻辑 60Hz，动画/判定 30Hz（每 2 tick 一个动画帧）。一切计时用帧计数常量，core 内禁止出现"秒"。
3. **tick 管线顺序固定**，见 [DESIGN.md](DESIGN.md) §3.2，不得重排；多实体同帧更新按实体 ID 升序。
4. **输入只以 `ButtonMask` 位图进入 sim。** just-down、缓冲（默认 6 帧）由 core 从位图历史本地推导。不存在"键盘状态"旁路。
5. **相机不进模拟。** 版边 = 两角色中点 ± `PLAYFIELD_HALF_WIDTH`（clamp 到地图边界）。core 读相机状态即 bug。
6. **依赖方向只允许向下**：`app → render → core ← net`；`data` 被各层只读。core 不 import 上层任何东西（lint `no-restricted-imports` 强制）。core 必须能直接在 Node 运行。
7. **角色差异进数据，不进引擎。** 新角色的动作/判定/帧触发写在 JSON；效果原语不够用时扩充 §帧触发表 的原语类型，不为单个角色在通用引擎里加分支。确实数据化不了的机制收进 `core/fighter/behaviors/` 插件目录。
8. **完工门禁（自检通过才算完成）**：
   - `pnpm build` 通过；
   - 确定性单测通过（同一输入序列跑两遍，逐帧哈希相等）；
   - `tools/replay` 回归剧本**行为哈希**不变（快照 `behaviorHash`，DESIGN §3.8 双哈希；若改动有意改变行为，必须在提交说明中写明并更新基准）；
   - `pnpm batch:validate` 通过（58 角色 + 37 辅助，基线 `tools/batch-validate/baseline.json`；行为有意变更 → 重冻基线并写明）。

   重冻纪律：门禁报哈希不一致时先跑 `node tools/replay/verify-drift.mjs <剧本>` 归因——全量状态逐 tick 全等（纯表示变更）才允许重冻；有行为差异禁止重冻。

## 目录结构

```
packages/
  core/     确定性模拟（唯一入口：sim.tick(inputs) → SimSnapshot）
  data/     JSON schema、加载器、校验器（烘焙产物，只读）
  render/   PixiJS 渲染：消费快照与表现事件，插值，相机，HUD
  app/      场景流转、键位采集、音频、 subsystem 宿主
  net/      lockstep 联机客户端：协议词表 / 传输抽象 / 输入延迟与失步检测（阶段 2）
server/     Node 房间服务器（创建/加入房间、输入中继、断线冻结等待；阶段 2）
tools/      exporter（SWF→JSON/spritesheet）、replay（哈希门禁）、capture
OpenBleachVsNaruto/  bvn-ai-public/   原版参考仓库（仓库根，只读，gitignore；
                    构建产物禁止依赖，BVN-module-map.md 的链接以此为准）
```

## app 层子系统接口

core 是纯函数式模拟，**不适用**本接口；本接口只约束 app/render 内的子系统（场景、音频、HUD、特效等）：

```ts
class MySubsystem {
  static id = 'my';            // 唯一，其他子系统经此访问
  static deps = ['render'];    // 必须先初始化的子系统 id
  async init(ctx) {}           // 构建资源
  update(dt, ctx) {}           // 每渲染帧
  dispose() {}                 // 释放资源
}
```

- 子系统之间**禁止互相 import**，运行时 `ctx.get('id')` 获取。
- `ctx` 提供：`events`、`assets`、`config`、`time`、`get/has/peek`。
- 逻辑热路径避免每帧分配（预分配复用）；2D 项目不做硬性零分配要求，但 tick 内明显可复用的临时对象要复用。

## 表现事件表（canonical events）

core 通过快照附带的事件队列向 render/app 发表现信号。**新增事件必须在本表同 commit 登记**：

| event | payload | 说明 |
|---|---|---|
| `hit:connect` | `{ attacker, target, hitType, power, blocked, steel, x, y }` | 命中成立（blocked = 被防御，削血 5%；steel = 命中钢身，命中音改钢身音） |
| `voice` | `{ fighter, kind }` | 受击语音信号（kind `hurt`=重击硬直 / `hurtFly`=击飞 / `die`=死亡；随机选音源与 rate 门在渲染层，音源按角色 forms.sounds 绑定） |
| `fighter:guard` / `fighter:guardBreak` | `{ fighter }` | 防御成功 / 破防 |
| `fighter:form` | `{ fighter, form }` | 万解/通用形态切换（切片 10；render 换图集 forms 下标） |
| `fighter:ko` | `{ fighter }` | 击倒 |
| `entity:spawn` / `entity:despawn` | `{ kind, id, name?, owner? }` | 飞行道具 / 独立道具（kind `attacker`，切片 9）/ 辅助 |
| `round:start` / `round:end` | `{ round, winner? }` | 回合流程 |
| `sound` | `{ id, x, y }` | 音效（渲染层消费，可随机选音源） |
| `effect` | `{ id, x, y, params }` | 特效（震动/闪光/钢身等） |
| `effect`（id `bisha`/`endBisha`） | `params { isSuper, face, owner, ownerKind }` | 必杀切人演出（切片 22）：`bisha` 置 `SimState.cutinLock`（全场冻结，仅施法者时间轴 30Hz 推进），`endBisha` 解锁；render 消费 = 黑幕 + 横幅流帧 + 立绘（`bisha.json`） |
| `effect`（id `wanKai`/`endWanKai`） | `params { face, owner, ownerKind }` | 万解开场演出（切片 22）：冻结/解锁/演出机制同上，`cutinLock.type = 'wanKai'` |

每个事件带 `tick` 号；渲染层自行处理去重与插值，不得回读 sim 内部状态——**快照 + 事件队列是 render 的唯一输入**。

## 帧触发原语表（FrameTrigger）

角色 JSON 的 `triggers` 只允许使用以下原语；扩充原语类型 = 改本表 + core 实现（`core/fighter/behaviors.ts` 注册表）+ data 校验器，三处同 commit：

- 移动类（速度值 ×SPEED_PLUS，换算见 DESIGN §3.1）：`move`、`movePercent`、`moveOnce`、`dash`、`stop`/`stopMove`、`damping`/`dampingPercent`
- 状态/资源：`setSteelBody`、`addQi`、`endAct`（收招）、`setCross`、`isApplyG`、`setAirMove`、`setTouchFloor(label)`、`idle(frame?)`（主动回位）
- 瞬步系（target 分流：mc=动作控制，effect=表现事件）：`dash`、`dashStop(p)`；纯表现：`shadow`/`endShadow`、`bisha`/`endBisha`（切片 22：置/清 `SimState.cutinLock` 冻结锁）、`slowDown(t)`、`walk`、`jump`、`touchFloor`
- 动作槽改写（连段/技/必杀；endAction 后重填默认）：`setAttack`、`setSkill1`、`setSkill2`、`setZhao1`、`setZhao2`、`setZhao3`、`setBisha(label?, qi?)`、`setBishaUP`、`setBishaSUPER`、`setDash`
- 表现原语（core 只发事件）：`playSoundHit1`、`playSoundHit2`、`shine`、`startShake`、`shake`、`endShake`
- 飞行道具：`fire(mcName, params?)`（切片 8；params 语料字段 x/y/hold/hits/hp，见 DESIGN §3.5）
- 独立道具：`addAttacker(mcName, params?)`（切片 9；mcName 为当前帧同名判定区；params 轴对象 `x`/`y`（`{followTarget|moveToTarget, offset, range?}`）、`applyG`；命中 actionId 依元件名反查 owner actions，查不到 = 纯视觉道具；单次命中即失效；寿命 = 播尽移除（切片 13-A5，`animTotal−1` off-by-one 原版 quirk 原样保留；无时间轴回退 holdTicks 120 占位））
- 目标系（摔技/抓取/贴身连段；target = 另一角色）：`setHitTarget(checker, label)`（checker 判定区与目标身体相交 → 切 label）、`moveToTarget(x, y, setDirect?)`（瞬移到目标旁，版边镜像防穿帮）、`moveTarget({followmc, speed} | null)`（抓取吸附锚点区中心 / 释放恢复重力，动作结束由 sim 巡检释放）、`justHitToPlay(hitid, label, ...)`（最近命中即续接）、`setHurtAction(label)`（携带：本次动作命中 → 受击方播专用受击动画；标签属受击方 def，applyHit 消费时校验）、`setDirectToTarget`/`setDirectReverse`/`setTargetVelocity`、`hurtFly(x, y, ...)`（主动击飞）
- 标签跳转：`gotoAndPlay`/`gotoAndStop`/`loop`（= setLabelTo）
- 动作槽（切片 9 扩充）：`setAllAct`（整套重填 defaultSlots）、`setJump(label)`、空中槽 `setAttackAIR`/`setSkillAIR`/`setBishaAIR(qi?)`、摔技槽 `setCatch1`/`setCatch2`、万解槽 `setWankai`/`setWankaiW`/`setWankaiS`
- 资源：`addHp`/`addHpPercent`/`addHpLosePercent`（clamp hpMax；hp≤0 不回）、`loseHp`（自削血，归零 → 死亡）
- 万解演出：`startWanKai`（target: effect → effect 事件 id `wanKai`；切片 22：置 `cutinLock`）、`endWanKai`（effect 事件 `endWanKai`；解锁）、`doWanKai(frame)`（万解形态切换：0 = 下一形态，>0 按 `def.rootFrame` 寻址根时间轴——切片 10 真实语义）
- 形态切换：`switchForm(frame)`（切片 10 实现注册，语义同 doWanKai；切 `FighterState.formIndex` + 重填槽 + 播新形态 开场 + 发 `fighter:form` 事件，单形态静默）
- 条件触发（切片 11）：`if` 不是注册表 op——`FrameTrigger.cond/then/else`，`evaluateTriggerCondition` 求值后分派分支体（分支体内调用仍走本表原语）。查询 op：`justHit(hitId, includeDefense?)`、`targetInRange(rx, ry?)`、`getTargetState`、`getSelf`、`getTargetSP`（属性链 + cmp；属性白名单见 `fighterProp`）。未知查询 op 求值 = false（确定性静默）；分支体调用未注册同静默。全角色批量化验收门禁 `pnpm batch:validate`（58 角色编译/op 覆盖/冒烟双跑哈希/快照恢复，基线 `tools/batch-validate/baseline.json`）。
- 已登记未实现（注册表未注册 → 确定性静默，接入时同 commit 补实现）：`teleport`、`summon`（切片 10 全语料核对：原版引擎与语料均无实例——teleport=移形换位换人、summon=辅助召唤，归辅助系统切片）、`sound`、`effect`（后两者以 playSoundHit*/shine/shake 代替）
- 辅助 customFunc 系（切片 21，target='assister'）：`addCustomFunc(desc)`（单槽，占位即忽略；desc 为 AssisterCustomFunc 闭集 kind）、`removeCustomFunc`、`finishIfNoAttacker(attackerName)`（attacker 不在场 → finish）、`setHitPowerByTargetHpMax(id, rate)`（B5：itachi 动态伤害——生成帧脚本 hitModel.getHitVO(id).power = 目标 hpMax × rate 的数据化；覆写存辅助实例，其生成的 attacker 逐帧命中解析时消费）
- 辅助 owner 系 buff（B4，target='fighter'）：`buffSpeedUpByOwnerSpeed(rate, hold)`——原版 `var ownerSpeed = getOwner().speed; speedUp(ownerSpeed × rate, hold)` 惯用语的数据化（expr 首参跨期不可求值，此前静默 0 值）；值 = 召唤者 def 基速 × rate，存原值消费 ×SPEED_PLUS
- 风场（B4 temari，windField desc）：注册帧采样目标 heavy/speed（`LEVEL[min(heavy, len)-1]`、`finalSpeed = 目标基速 × level`）与自身朝向（闭包捕获不随转向变化）；步进每动画帧拉扯目标（HURT_DOWN=23 卫语句不拉）；弹速级为**派生值**——`stepBullets` 按在场风场辅助实时求值 `speedLevel = level × (弹朝向==direct ? -1 : 1)`，位移乘 `(1−speedLevel)`，仅作用敌方弹（同队跳过），不进 SimState（多辅助同场 id 序后者覆盖 = 原版单槽覆写序）
- attacker 元件脚本（切片 21，target='attacker'，数据进 `AssisterDef.attackerScripts`，仅 viaAssist 道具分派）：`stop`（= animHold 定格冻结）、`gotoAndPlay(label|frame)`（解除定格）、`stopFollowTarget`、`removeSelf`（返回移除标记，同帧不再推进）；`endAct` 元件语境 no-op；B5 起 `if` 条件触发器分派（`dispatchAttackerCond`：cond 成立走 then 否则 else，分支体调用仍走元件脚本原语；查询 op 仅 `justHit`——madara miss 分支卫语句 `if(!justHit("x")){gotoAndPlay("y")}` 由导出器提取为 cond 触发器）

## 并行开发纪律

- **core 由单一负责人顺序开发**（状态机/物理/判定高耦合，并行必互相破坏）。
- 可并行 fan-out 的任务：角色/辅助/地图数据转译、素材导出、对拍剧本制作——它们之间零依赖，契约 = JSON schema + 数据校验器。
- 子 Agent 开工时 brief 必须附：本文件全文 + 任务相关的 schema 定义 + 验收门禁。
