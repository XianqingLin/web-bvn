/**
 * 场景间共享的对局流程状态（切片 14）。
 * 一个 Flow 贯穿 菜单→选人→战斗→结算 的单次流转；回菜单即废弃。
 */
export interface Pick {
  fighter: string;
  assist: string;
}

export interface Flow {
  /** solo = 单机训练；net = 联机 lockstep */
  mode: 'solo' | 'net';
  /** 房间服务器地址（联机；localStorage 记忆） */
  serverUrl: string;
  /** 联机位次（服务器分配；solo 恒 1） */
  player: 1 | 2;
  /** 房间码（联机） */
  room: string;
  /** 本端选人 */
  localPick: Pick | null;
  /** 对端选人（联机；对局装配以 p1Pick/p2Pick 为准） */
  peerPick: Pick | null;
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
    player: 1,
    room: '',
    localPick: null,
    peerPick: null,
    mapId: 'KonohaMura',
    roleKeymapP2: false,
    autoPick: false,
  };
}

/** 两端就位后的对局装配选人：slot = 联机位次（solo 双方同配）。 */
export function picksOf(flow: Flow): { p1: Pick; p2: Pick } {
  const local = flow.localPick ?? { fighter: 'ichigo', assist: 'gaara' };
  if (flow.mode === 'solo') return { p1: local, p2: local };
  const peer = flow.peerPick ?? local;
  return flow.player === 1 ? { p1: local, p2: peer } : { p1: peer, p2: local };
}
