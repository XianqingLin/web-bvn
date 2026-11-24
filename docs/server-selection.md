# BVN Web —— 节点选择设计稿（server-selection）

> 定房间服的**多节点部署与客户端择优**：节点清单下发、自动测速择优（2026-11-22 二次决策取消玩家手动切换）、节点即上下文、跨节点加入、安全边界。
> 引擎契约见 [ARCHITECTURE.md](ARCHITECTURE.md)；对局期协议/sim 语义**零改动**（沿用 rollback，DESIGN §6）。
> 定案日：2026-11-22（与用户逐条确认）。决策变更就地修改对应段并写明日期。

---

## 0. 实测依据（立项根因）

用户实测：连 CF 节点对局时 rollback 吞输入，"任何行为都被回滚"。探针实证（`probe-nodes.mjs`，375 tick 固定剧本、两端 60fps 节奏，用后即删；结论入 PROGRESS §2.1）：

| 指标 | 国内节点 | CF 节点 |
|---|---|---|
| 连接 RTT | 95~111ms | 804~1155ms |
| 回滚次数 | 24 | 18 |
| **回滚窗口均值 / 最大** | **2 / 2 tick** | **27 / 53 tick** |

结论：**毁手感的不是回滚次数，是每次回滚重演的帧数**。CF 每次纠 2~53 tick，攻击表现被整段吞掉；国内只纠 2 帧几乎无感。故"迁国内节点"方向成立。多节点并存（而非一刀切）保留外服玩家与降级能力，定为最终形态。

---

## 1. 术语与边界

- **节点** = 一个房间服部署实例。当前两个：`cn` 国内节点（旧 BCC）、`cf` 外服节点（Cloudflare Durable Object）。不用"国服/外服"措辞——两节点跑同一份 `room-logic.mjs`，仅是部署位置不同，玩家池可重叠。
- **节点是全局会话上下文**：先选节点，再建房/匹配/加入；房间属于节点，不是节点属于房间。
- **边界**：gamedock 平台（账号/邀请/静态）完全不动。本稿只覆盖游戏自有房间服与客户端入口。对局期 `input/hash/hello/start` 等协议零改动。

---

## 2. 节点清单（配置）

客户端烘一份种子清单做冷启动兜底；运行时拉 `bvn-room` CF Worker 的 `GET /manifest` 拿权威清单（**gamedock 平台不改**）。

```jsonc
// GET /manifest（bvn-room CF Worker；CORS: *；其余请求照旧转 DO）
{
  "version": 1,
  "autoSelectEnabled": true,   // 一键紧急回滚：false → 全员退回 matchNode
  "matchNode": "cn",           // 随机匹配固定服（池不割裂）
  "nodes": [
    { "id": "cn", "name": "国内节点", "url": "wss://120.48.185.202/bvn-ws", "enabled": true },
    { "id": "cf", "name": "外服节点", "url": "wss://bvn.gamedock.cn", "enabled": true }
  ]
}
```

- 清单可自由编辑（增删/启停），**改 manifest 不发版**；客户端拉不到时回落内置种子。
- ~~前置（2026-11-22）：国内节点自签证书浏览器 wss 拒连~~ → **已解决（2026-11-22，工作区 `docs/SERVER-OPS.md` §二证书段）**：换 LE IP 地址证书（shortlived profile，6 天寿命自动续期），`wss://120.48.185.202/bvn-ws` 浏览器零例外直接信任，E2E 已验收。
- 接线点：`packages/app/.env.production` 烘种子清单；manifest URL 烘进客户端。

---

## 3. 选择机制（默认自动；2026-11-22 决策变更：取消玩家手动切换）

> **2026-11-22（二次决策，同日）**：玩家侧不做手动切换 UI——节点只由后台自动择优 +
> 跨节点加入锁定（§4）决定。偏好状态机的 `manual` 语义**保留**但不再有玩家入口，
> 仅服务跨节点加入的目标锁定。

存**意图**不存 URL：`{ mode: 'auto' | 'manual', manualId?, lastResult?: {nodeId, rttP50, jitter, at} }`，持久化。优先级链（高→低）：

```
?server= 参数（强制，跳过测速）
  > localStorage('bvn.server') 手填（强制，跳过测速）
  > 偏好 mode（auto=择优 / manual=锁定节点）
  > matchNode
  > 种子首项
```

- **auto**：缓存（TTL 30min）未过期用 `lastResult`；过期并行重测所有 enabled 节点，评分 `score = rttP50 + λ·(rttP95−rttP50) + 负载惩罚`，选最低分。λ 与负载权重实现时定，先取 λ=1。
- **manual（内部）**：锁定节点跳过择优，但仍测速显示延迟（Menu 左下角状态块）；锁定节点探测不可用 → 自动落到可用节点，保留 manual 意图，节点恢复后切回。
- **全部不可用** → 回退 `matchNode` 或明确报错，绝不卡死。
- **强制指定**（`?server=` / 手填）为最高优先级且跳过测速——保留现有高级路径语义。

---

## 4. 节点即上下文（建房/匹配/加入）

- **创建房间**只在当前节点创建；**随机匹配**只在当前节点池内配对。切节点 = 换玩家池，UI 需让玩家知道（Menu 左下角状态块显示当前节点名/延迟，2026-11-22 起无切换面板）。
- **房码/邀请深链带节点标识**：深链参数 `?room=<code>&node=<id>`。平台邀请只透传参数（gamedock 不改），参数一次设计到位。
- **跨节点加入**：客户端发现目标 `node` ≠ 当前节点 → 提示"该房间在 XX 节点，是否切换后加入？"→ 确认则切 `flow.serverUrl` + 加入；取消则留当前节点。
- 6 位房码在不同节点会撞车 → 房码必须绑定 nodeId 才有全局意义（深链层承担）。

---

## 5. 测速协议（ping/pong）

- `NetMessage` 加两个类型（packages/net）：`{ t:'ping', id }` / `{ t:'pong', id, queue }`。
- `room-logic.mjs` switch 加 `case 'ping'` 回 pong（带 `matchQueue.length` 做负载软加权）——**CF DO 与 Node 老服共用，改一处两边生效**。
- 测速流程：并行对 enabled 节点建探测连接 → 多轮 ping（间隔 ~100ms，取 p50/p95）→ 超时（~1.5s）或无 pong 剔除 → 探测连接用完即关。
- 不用 WS 握手耗时当 RTT（含 TCP+TLS+upgrade 噪声），应用层 ping 多轮采样抗抖动。

---

## 6. 接线面（已确认）

- 唯一出口 `flow.serverUrl`（`flow.ts`）；择优结果写进去，`net-common.ts` 的 `openServerSocket` 与对局/rollback 逻辑**零改动**。
- `main.ts:81` 的 `?server=` 覆盖逻辑保留（最高优先级）。
- `MenuScene` 左下角状态块三行（所属节点 + 实时延迟 + 版本号，左对齐、13px 统一字号、双色同族：节点浅蓝 `0x8fd0ff` / 版本降饱和蓝 `0x6ea0cd`；`startNodeMonitor` 周期探测刷新；纯展示，2026-11-22 取消点击切换面板；2026-11-24 版本字并入——版本缩为仅 "v X.X.X" 并自右下角黑 18px 改至此，自觉偏离原版布局）。
- `onRollback` 诊断已在 `battle.ts` 接入（console + `__bvnNet()`）；节点选择埋点复用之。

---

## 7. 安全边界

- **匹配只认官方节点**（manifest 内 enabled 项）；任意 URL 手填（高级路径）**禁用随机匹配**——房间服持有种子/匹配裁定/输入中转，不可信服能伪造对端输入/改种子。`configHash` 互验挡错配但挡不住恶意服主动伪造。
- 自动切换只在 enabled 官方节点间进行。

---

## 8. 观测与灰度

- 埋点：选中节点、RTT/抖动、切换原因（auto/manual/降级）、回滚次数（复用 `rollbackCount`）、匹配耗时、失败候选。HUD 显示当前节点 + 延迟。
- 灰度：`manifest.version` / `autoSelectEnabled` 控总开关（false → 全员退回 matchNode，紧急回滚不发版）；节点级 `enabled` 控单节点上下线。`rollout` 百分比留接口，第一版可不实现。

---

## 9. 第一版不做（明确边界）

- 跨区公平代理（双方 RTT 联合最优）——好友房"建房者节点说了算"，匹配走 matchNode，跨国对战物理限制不解决；
- 节点间房间迁移（房间无状态，断线即散，无需迁移）；
- WebRTC P2P 直连（终局方案，非当前）；
- 任意服公共匹配（安全红线）；
- rollout 百分比灰度（接口预留，暂不实现）。

---

## 10. 落地顺序与状态（2026-11-22）

1. ✅ **服务器侧**：`NetMessage` 加 ping/pong 类型（`packages/net/src/protocol.ts`）→ `room-logic.mjs` 加 ping case（回 pong 带 `matchQueue.length`）→ CF Worker 加 `GET /manifest`（CORS `*`）。server 单测 +1（21 全过）。
2. ✅ **客户端测速/择优**：纯决策逻辑在 `packages/net/src/node-select.ts`（`score`/`decide`，12 单测）；`packages/app/src/nodes.ts` 做清单加载 / 并行 ping 测速 / 偏好状态机 / 降级 / DOM 切换面板；`main.ts` 启动后台择优，结果写 `flow.serverUrl`。
3. ✅ **UI 与深链**：Menu 左下角节点状态块（两行：节点 + 延迟，`startNodeMonitor` 约 10s 周期探测刷新 RTT；2026-11-22 由右上单行标签升级为左下双行实时块，同日决策取消手动切换、状态块改纯展示）；跨节点加入 `resolveJoinNode`（深链 `?room=&node=`）。
4. ✅ **门禁全过**：`pnpm build`（app+net）+ server 单测 21 + net 单测 30 + replay 9 剧本零漂移 + batch 基线（58+37）——对局协议零改动，预期零漂移已验证。

**待办（未实现，见 §9 边界）**：①rollout 百分比灰度（接口预留）。~~②切片 38 平台邀请深链落地时把 `node=` 参数接进邀请链接~~ → **已落地（2026-11-23，切片 38 邀请部分）**：hello `join` 参数消费 + 入房上报 `game:invite-context {room, node}`（见 `packages/app/src/invite-context.ts`，契约见工作区 `../docs/platform-seam.md` §4）。（~~国内节点真证书~~已解决 2026-11-22 LE IP 证书；~~节点切换面板目检~~已随 2026-11-22 二次决策取消手动切换而移除。）

