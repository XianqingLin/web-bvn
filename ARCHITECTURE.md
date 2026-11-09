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
   - `tools/replay` 回归剧本哈希不变（若改动有意改变行为，必须在提交说明中写明并更新基准）。

## 目录结构

```
packages/
  core/     确定性模拟（唯一入口：sim.tick(inputs) → SimSnapshot）
  data/     JSON schema、加载器、校验器（烘焙产物，只读）
  render/   PixiJS 渲染：消费快照与表现事件，插值，相机，HUD
  app/      场景流转、键位采集、音频、 subsystem 宿主
server/     Node 房间服务器（阶段 2）
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
| `hit:connect` | `{ attacker, target, hitType, power, blocked, x, y }` | 命中成立（blocked = 被防御，削血 5%） |
| `fighter:guard` / `fighter:guardBreak` | `{ fighter }` | 防御成功 / 破防 |
| `fighter:ko` | `{ fighter }` | 击倒 |
| `entity:spawn` / `entity:despawn` | `{ kind, id }` | 飞行道具/独立道具/辅助 |
| `round:start` / `round:end` | `{ round, winner? }` | 回合流程 |
| `sound` | `{ id, x, y }` | 音效（渲染层消费，可随机选音源） |
| `effect` | `{ id, x, y, params }` | 特效（震动/闪光/钢身等） |

每个事件带 `tick` 号；渲染层自行处理去重与插值，不得回读 sim 内部状态——**快照 + 事件队列是 render 的唯一输入**。

## 帧触发原语表（FrameTrigger）

角色 JSON 的 `triggers` 只允许使用以下原语；扩充原语类型 = 改本表 + core 实现（`core/fighter/behaviors.ts` 注册表）+ data 校验器，三处同 commit：

- 移动类（速度值 ×SPEED_PLUS，ADR-12）：`move`、`movePercent`、`moveOnce`、`dash`、`stop`/`stopMove`、`damping`/`dampingPercent`
- 状态/资源：`setSteelBody`、`addQi`、`endAct`（收招）
- 动作槽改写（连段/技/必杀；endAction 后重填默认）：`setAttack`、`setSkill1`、`setSkill2`、`setZhao1`、`setZhao2`、`setZhao3`、`setBisha(label?, qi?)`、`setBishaUP`、`setBishaSUPER`、`setDash`
- 表现原语（core 只发事件）：`playSoundHit1`、`playSoundHit2`、`shine`、`startShake`、`shake`、`endShake`
- 已登记未实现（注册表未注册 → 确定性静默，接入时同 commit 补实现）：`fire`（飞行道具）、`addAttacker`、`switchForm`、`teleport`、`summon`、`sound`、`effect`（后两者以 playSoundHit*/shine/shake 代替）

## 并行开发纪律

- **core 由单一负责人顺序开发**（状态机/物理/判定高耦合，并行必互相破坏）。
- 可并行 fan-out 的任务：角色/辅助/地图数据转译、素材导出、对拍剧本制作——它们之间零依赖，契约 = JSON schema + 数据校验器。
- 子 Agent 开工时 brief 必须附：本文件全文 + 任务相关的 schema 定义 + 验收门禁。
