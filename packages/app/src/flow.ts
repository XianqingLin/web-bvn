/**
 * 场景间共享的对局流程状态（切片 14；切片 34 回归自有 room-server 路径）。
 * 一个 Flow 贯穿 菜单→房间→选人→战斗→结算 的单次流转；回菜单即废弃。
 */
import type { XlpSdk } from '@xlp/game-sdk';

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
  /** 房间服务器地址（联机；localStorage 记忆） */
  serverUrl: string;
  /** 本端显示昵称（房间页/VS 横幅；平台昵称，standalone 回退"玩家N"） */
  name: string;
  /** 平台 SDK（boot 时 connectXlp；standalone 时联机走自有服务器，账号信息仅作显示） */
  xlp: XlpSdk | null;
  /** 联机位次（服务器分配：create→1 / join→2；solo 恒 1） */
  player: 1 | 2;
  /** 房间码（联机；自有服务器 4 位码） */
  room: string;
  /** 本端选人 */
  localPick: Pick | null;
  /** 对端选人（联机；对局装配以 p1Pick/p2Pick 为准） */
  peerPick: Pick | null;
  /** 团队模式（房间设置 team；匹配固定开启）——选人页 3 选 + 1 援助节奏 */
  team: boolean;
  /** 团队模式累计选人（单挑不填；切片 36 对局侧 3+1 装配消费） */
  localTeamPick: TeamPicks | null;
  peerTeamPick: TeamPicks | null;
  /** 地图（联机以 P1 选择为准） */
  mapId: string;
  /** dev 双窗口：本端用 P2 键位（方向键），避免同机两套键盘互抢 */
  roleKeymapP2: boolean;
  /** dev 直通模式（URL 参数进入，选人页自动确认默认项） */
  autoPick: boolean;
}

export function makeFlow(): Flow {
  return {
    mode: 'solo',
    serverUrl: localStorage.getItem('bvn.server') ?? 'ws://localhost:8787',
    name: '',
    xlp: null,
    player: 1,
    room: '',
    localPick: null,
    peerPick: null,
    team: false,
    localTeamPick: null,
    peerTeamPick: null,
    mapId: 'KonohaMura',
    roleKeymapP2: false,
    autoPick: false,
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
