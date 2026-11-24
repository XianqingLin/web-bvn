/**
 * 场景间共享的对局流程状态（切片 14；切片 34 回归自有 room-server 路径）。
 * 一个 Flow 贯穿 菜单→房间→选人→战斗→结算 的单次流转；回菜单即废弃。
 */
import type { GameDockSdk } from '@gamedock/game-sdk';

export interface Pick {
  fighter: string;
  assist: string;
}

/** 团队模式累计选人（按锁定次序；切片 35 选人页产出）。 */
export interface TeamPicks {
  fighters: string[];
  assists: string[];
}

export interface Flow {
  /** solo = 单机训练；local = 本地双人（P1/P2 同机键盘）；net = 联机 lockstep */
  mode: 'solo' | 'local' | 'net';
  /** 房间服务器地址（联机；节点择优结果写这里；?server= 强制时 = 参数值） */
  serverUrl: string;
  /** 服务器地址为 ?server= 强制指定（本会话生效；强制通道禁用随机匹配，
   *  DESIGN §6.2——不可信服能伪造对端输入/改种子） */
  serverForced: boolean;
  /** 当前节点选择结果（DESIGN §6.2；UI 显示与诊断用） */
  nodeInfo?: { nodeId: string; reason: string; rttP50?: number };
  /** 本端显示昵称（房间页/VS 横幅；平台昵称，standalone 回退"玩家N"） */
  name: string;
  /** 平台 SDK（boot 时 connectGameDock；standalone 时联机走自有服务器，账号信息仅作显示） */
  dock: GameDockSdk | null;
  /** 联机位次（服务器分配：create→1 / join→2；solo 恒 1） */
  player: 1 | 2;
  /** 房间码（联机；自有服务器 6 位数字码） */
  room: string;
  /** 本端选人 */  localPick: Pick | null;
  /** 对端选人（联机；对局装配以 p1Pick/p2Pick 为准） */
  peerPick: Pick | null;
  /** 团队模式（房间设置 team / 匹配由服务器裁定并回执）——选人页 3 选 + 1 援助节奏 */
  team: boolean;
  /** 匹配模式偏好（true 团队 3+1 / false 单挑 1v1）——仅入队时上行；
   *  本端偏好不直接决定对局，权威值以 matched.team 回执为准 */
  matchTeam: boolean;
  /** 是否走地图选择阶段（2026-11-21 定案）：好友房/本地 = true（原版选择页，
   *  房主定图，默认"？"随机项）；匹配 = false（援助选完直接进加载页，
   *  对局地图由 mapSeed 按 maps[seed % n] 解析） */
  mapSelect: boolean;
  /** 服务器权威种子（begin 广播 seed / matched 携带）——对局 sim seed
   *  （进 configHash 互验）；匹配模式兼作地图抽取种子。solo/local 恒 null（sim seed 用 1） */
  mapSeed: number | null;
  /** 团队模式累计选人（单挑不填；切片 36 对局侧 3+1 装配消费） */
  localTeamPick: TeamPicks | null;
  peerTeamPick: TeamPicks | null;
  /** 地图（联机以 P1 选择为准） */
  mapId: string;
  /** dev 双窗口：本端用 P2 键位（方向键），避免同机两套键盘互抢 */
  roleKeymapP2: boolean;
  /** dev 直通模式（URL 参数进入，选人页自动确认默认项） */
  autoPick: boolean;
  /** 平台邀请深链待入房房码（platform-seam §4：hello join 参数；主菜单消费并
   *  自动加入（落主菜单 → 自动意图），随后清空。URL `?room=&node=` 深链不走此字段） */
  pendingInviteRoom: string | null;
  /** 深链跨节点加入意图（URL `?room=&node=`；主菜单确认后锁定切换并加入，
   *  DESIGN §6.2。pendingInviteRoom 走 hello join，两条深链互斥） */
  pendingDeepLink: { room: string; node: string } | null;
}

export function makeFlow(): Flow {
  return {
    mode: 'solo',
    // 服务器地址优先级：?server= 参数（本会话强制，serverForced=true）>
    // 构建期默认（.env.production，正式构建烘入云服务器）> dev 本地默认。
    // 手填记忆（localStorage bvn.server）随服务器地址编辑行下线废弃。
    serverUrl: import.meta.env.VITE_ROOM_SERVER ?? 'ws://localhost:8787',
    serverForced: false,
    name: '',
    dock: null,
    player: 1,
    room: '',
    localPick: null,
    peerPick: null,
    team: false,
    matchTeam: true,
    mapSelect: true,
    mapSeed: null,
    localTeamPick: null,
    peerTeamPick: null,
    mapId: 'KonohaMura',
    roleKeymapP2: false,
    autoPick: false,
    pendingInviteRoom: null,
    pendingDeepLink: null,
  };
}


/** 两端就位后的对局装配选人：slot = 联机位次（solo 双方同配；local P1=P2 视角本端/对方）。 */
export function picksOf(flow: Flow): { p1: Pick; p2: Pick } {
  const local = flow.localPick ?? { fighter: 'ichigo', assist: 'gaara' };
  if (flow.mode === 'solo') return { p1: local, p2: local };
  const peer = flow.peerPick ?? local;
  return flow.player === 1 ? { p1: local, p2: peer } : { p1: peer, p2: local };
}

/**
 * 团队模式对局装配（切片 36）：两侧累计选人按锁定次序组成 roster（≤3 名），
 * 辅助取各侧首名（原版 3 名成员共用 group 一名 assist；选人页后续累积的
 * assists[1..] 暂忽略——产品语义待定，登记偏离）。缺省回退 = 首名 1v1 配置。
 */
export function teamPicksOf(flow: Flow): {
  p1: { fighters: string[]; assist: string };
  p2: { fighters: string[]; assist: string };
} {
  const local: TeamPicks = flow.localTeamPick ?? {
    fighters: [picksOf(flow).p1.fighter],
    assists: [picksOf(flow).p1.assist],
  };
  const peer: TeamPicks = flow.mode === 'solo'
    ? local
    : (flow.peerTeamPick ?? local);
  const p1 = flow.player === 1 ? local : peer;
  const p2 = flow.player === 1 ? peer : local;
  return {
    p1: {
      fighters: p1.fighters.length > 0 ? p1.fighters : ['ichigo'],
      assist: p1.assists[0] ?? 'gaara',
    },
    p2: {
      fighters: p2.fighters.length > 0 ? p2.fighters : ['ichigo'],
      assist: p2.assists[0] ?? 'gaara',
    },
  };
}
