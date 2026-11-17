/**
 * lockstep + 房间协议（切片 6/7 基础；切片 34 房间语义扩展）。
 * 服务器解析连接编排与房间语义（create/join/welcome/room-info/room-config/
 * ready/begin/hello/start/error），UI 同步类（cursor/map-pick）与对局类
 * （input/hash/pick）原样透传给同房间对端，不解析。
 *
 * 匹配队列词表（queue/unqueue/matched/list-rooms/room-list）归切片 37，届时补充。
 */
import { fnv1a, stableStringify, type ButtonMask } from '@bvn/core';

/** 玩家位次（= sim 里的 fighter id；create→1，join→2）。 */
export type PlayerSlot = 1 | 2;

/**
 * 选人页累计锁定快照（切片 35）：按锁定次序的 id 列表。
 * 覆盖语义——对端只保留最新一条（与 cursor 同待遇，不依赖可靠有序通道，
 * 3s 重发兜底幂等）。
 */
export interface LockedPicks {
  /** 角色段（团队 ≤3 / 单挑 ≤1） */
  fighters: string[];
  /** 辅助段（≤1） */
  assists: string[];
}

// ---------- 房间语义（切片 34；服务器解析，快照经 room-info 广播） ----------

/** 房间设置（房主可改；room-info 携带完整快照，变更实时广播）。 */
export interface RoomSettings {
  /** 公开房间进浏览列表（切片 37）；私人只能房码/邀请进入 */
  public: boolean;
  /** true = 开箱抽取（切片 36）；false = 房主选择 */
  randomMap: boolean;
  /** true = 团队 3+1；false = 单挑 1v1 */
  team: boolean;
}

/** room-info 的成员条目。 */
export interface RoomMemberInfo {
  player: PlayerSlot;
  /** 显示昵称（平台昵称；standalone 回退"玩家N"） */
  name: string;
  /** 准备状态（房主常备视为 true，不在快照里单独表达） */
  ready: boolean;
}

export type NetMessage =
  /** 客户端 → 服务器：创建房间（成为 P1）。name = 显示昵称 */
  | { t: 'create'; name?: string }
  /** 客户端 → 服务器：加入房间（成为 P2）。已开局房间拒绝（复用 room-full） */
  | { t: 'join'; room: string; name?: string }
  /** 服务器 → 客户端：入房成功，分配位次与房间号 */
  | { t: 'welcome'; player: PlayerSlot; room: string }
  /** 服务器 → 客户端：入房失败（room-not-found / room-full），随后关闭连接；
   *  也用于非致命反馈（begin 时客座未准备 → guest-not-ready），此时不关连接 */
  | { t: 'error'; code: string; message?: string }
  /** 房主 → 服务器：设置变更（合并进快照后广播 room-info） */
  | { t: 'room-config'; settings: Partial<RoomSettings> }
  /** 服务器 → 房内成员：房间快照（成员昵称/准备状态/设置/开局标记）。
   *  入房即发、成员与设置变更即发 */
  | { t: 'room-info'; room: string; started: boolean; settings: RoomSettings; players: RoomMemberInfo[] }
  /** 客座 → 服务器：准备状态切换（房主常备无此消息） */
  | { t: 'ready'; ready: boolean }
  /** 房主 → 服务器：请求开始；服务器校验客座已准备 → 双方广播 start（进选人页） */
  | { t: 'begin' }
  /** 客户端 → 对端（经服务器透传）：本端配置指纹，两端互验防错配 */
  | { t: 'hello'; player: PlayerSlot; configHash: string }
  /** 客户端 → 对端（经服务器透传）：选人页累计锁定（切片 35，选中即锁逐次上行）
   *  或最终选人结果（fighter/assist/map 语义，切片 14 地图尾仍沿用：map 仅 P1 携带）。
   *  带 locked 时 fighter/assist = 首名锁定项（冗余便于日志与旧读者）。 */
  | { t: 'pick'; player: PlayerSlot; fighter: string; assist: string; map?: string; locked?: LockedPicks }
  /** 服务器 → 双方：阶段推进广播（两段语义：begin 后 = 进选人页；hello 收齐后 = 开跑） */
  | { t: 'start' }
  /** 单端单 tick 输入位图（lockstep 唯一的高频消息） */
  | { t: 'input'; tick: number; mask: ButtonMask }
  /** 定期失步检测（每 HASH_STRIDE tick 一次状态哈希） */
  | { t: 'hash'; tick: number; hash: string }
  /** 服务器 → 存活方：对端断开（断线处理 = 冻结等待，判负归阶段 4） */
  | { t: 'peer-lost' }
  // ---------- UI 同步（透传给对端；切片 35/36 使用） ----------
  /** 选人/援助阶段光标位置（变更即广播，轻量消息） */
  | { t: 'cursor'; player: PlayerSlot; stage: 'fighter' | 'assist'; idx: number }
  /** 房主切换/确认地图（切片 36，客座只读实时跟随） */
  | { t: 'map-pick'; player: PlayerSlot; map: string }
  /** 开箱抽取种子（切片 36；服务器权威生成广播，收到才开始播动画） */
  | { t: 'map-roll'; seed: number };

/**
 * 对局配置指纹：seed + 舞台 + 角色标识（+ 辅助，切片 14 联机注入；
 * + 团队 roster，切片 36 团队联机注入——roster id 表，两端装配序一致）。
 * 两端 hello 互验，不一致立刻报错而非跑到中途失步。
 */
export function makeConfigHash(info: {
  seed: number;
  stage: unknown;
  fighters: readonly unknown[];
  assists?: readonly unknown[];
  teams?: unknown;
}): string {
  return fnv1a(stableStringify(info));
}
