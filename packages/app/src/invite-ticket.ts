/**
 * 邀请票生命周期与跨窗口忙锁（DESIGN §6.4）。
 *
 * 票 = 平台好友邀请的加入参数 { room, node }（hello join 透传，platform-seam §4）。
 * 接受邀请 = 打开游戏落主菜单后自动兑票入房——游戏内无邀请 UI，忙态约束由构造
 * 达成（兑票只发生在主菜单可操作态，战斗/匹配/加载天然走不到）。生命周期拍板：
 * - 票只留最新：新票无条件覆盖旧票（单键存储）；
 * - 票 TTL 过期即清、兑换即清、兑换失败一律销票（含连接失败——让发起方重新邀请）；
 * - 票锁定节点在 manifest 下线时提示"节点不可用"，不得静默回退当前节点误报房
 *   不存在（兑票方 MenuScene 负责，本模块只管存取与忙锁）。
 *
 * 跨窗口忙判定：同源 localStorage 心跳锁——每个游戏窗口持续续写带时间戳的锁，
 * 超时（LOCK_STALE_MS）视为持锁窗口已死。兑票权 = 持锁权：锁空/失效/本端持有的
 * 窗口到达主菜单后自动兑票；非持锁窗口不兑票（票留在存储里）。hello join 的接收
 * 窗口写票同时接管忙锁（takeOverWindowLock）——它承载用户刚点的「接受」意图，
 * 总是取得兑票权；原持锁窗口只失去票的处置权（心跳见外部活锁自动停写，对局照常，
 * 回到主菜单时票已被兑走即无事）。变更通知走消费方轮询（菜单 update 低频读票），
 * 不需要 BroadcastChannel 推送。
 */

/** 票：房间码 + 锁定节点 + 签发时刻（TTL 基准）。 */
export interface InviteTicket {
  room: string;
  node: string;
  at: number;
}

/**
 * 票有效期。房间码进冷却池近期不复用，过期票兑了也会 room-not-found——
 * 不展示（超过时长的邀请视为失效，让发起方重新邀请）。
 */
export const INVITE_TTL_MS = 10 * 60 * 1000;

const TICKET_KEY = 'bvn.inviteTicket';
const LOCK_KEY = 'bvn.windowLock';
/** 锁超时：心跳 1s，连续 4 个周期未续写视为持锁窗口已死。 */
const LOCK_STALE_MS = 4000;
const HEARTBEAT_MS = 1000;

/** 存储不可用（隐私模式等）时的会话内回退；存储正常时恒 null。 */
let memoryTicket: InviteTicket | null = null;

function parseTicket(raw: string | null): InviteTicket | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const t = v as { room?: unknown; node?: unknown; at?: unknown };
  if (typeof t.room !== 'string' || !t.room) return null;
  if (typeof t.node !== 'string' || !t.node) return null;
  if (typeof t.at !== 'number' || !Number.isFinite(t.at)) return null;
  return { room: t.room, node: t.node, at: t.at };
}

/** 存票（票只留最新：无条件覆盖）。 */
export function storeTicket(room: string, node: string): void {
  const t: InviteTicket = { room, node, at: Date.now() };
  memoryTicket = null;
  try {
    localStorage.setItem(TICKET_KEY, JSON.stringify(t));
  } catch {
    memoryTicket = t;
  }
}

/**
 * 读票；过期即清（TTL 拍板）。同源多窗口共享存储，以存储为准——
 * 其他窗口写入的新票这里原样读到（只留最新）。
 */
export function readTicket(): InviteTicket | null {
  let t: InviteTicket | null;
  try {
    t = parseTicket(localStorage.getItem(TICKET_KEY));
  } catch {
    t = memoryTicket;
  }
  if (!t) return null;
  if (Date.now() - t.at > INVITE_TTL_MS) {
    clearTicket();
    return null;
  }
  return t;
}

/** 销票（兑换即清 / 兑换失败销票，共用此出口）。 */
export function clearTicket(): void {
  memoryTicket = null;
  try {
    localStorage.removeItem(TICKET_KEY);
  } catch {
    /* 存储不可用时清内存回退即可 */
  }
}

// ---------- 跨窗口忙锁 ----------

interface WindowLock {
  id: string;
  ts: number;
}

function readLock(): WindowLock | null {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { id?: unknown; ts?: unknown };
    if (typeof v.id !== 'string' || typeof v.ts !== 'number') return null;
    return { id: v.id, ts: v.ts };
  } catch {
    return null;
  }
}

function writeLock(id: string): void {
  try {
    localStorage.setItem(LOCK_KEY, JSON.stringify({ id, ts: Date.now() }));
  } catch {
    /* 锁写不进去时 isWindowHolder 恒真（锁空语义），单窗口可用性不受影响 */
  }
}

let myWindowId: string | null = null;

/**
 * 本端是否持锁（兑票权所在）：锁空 / 锁已失效 / 本端持有 → 是。
 * 心跳未启动（测试环境、异常路径）退化为本端持有。
 */
export function isWindowHolder(): boolean {
  if (myWindowId === null) return true;
  const l = readLock();
  return !l || l.id === myWindowId || Date.now() - l.ts > LOCK_STALE_MS;
}

/**
 * 启动窗口心跳（boot 调一次，伴随整个页面生命周期——战斗/菜单期间都要维持
 * 持锁证据，页面关闭自然停止）。规则：锁空/失效/本端持有 → 续写本端；
 * 他窗活锁 → 不动（本端为非展示面，他窗死后锁过期，心跳自动接管）。
 */
export function startWindowHeartbeat(): void {
  if (myWindowId !== null) return;
  const uuid = typeof crypto.randomUUID === 'function' ? crypto.randomUUID.bind(crypto) : null;
  const id = uuid ? uuid() : `${Date.now()}-${Math.random()}`;
  myWindowId = id;
  const tick = (): void => {
    const l = readLock();
    if (!l || l.id === id || Date.now() - l.ts > LOCK_STALE_MS) writeLock(id);
  };
  tick();
  window.setInterval(tick, HEARTBEAT_MS);
}

/**
 * 强制接管忙锁（hello join 的接收窗口写票时调用）：即使锁被存活窗口持有也改写为
 * 本端——接收窗口承载用户刚点的「接受」意图，总是取得兑票权。原持锁窗口此后只
 * 失去票的处置权（其心跳见外部活锁自动停写，在对局中不受任何影响）。
 */
export function takeOverWindowLock(): void {
  if (myWindowId === null) return;
  writeLock(myWindowId);
}
