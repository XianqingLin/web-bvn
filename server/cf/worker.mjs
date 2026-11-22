/**
 * BVN 房间服 Worker 入口（Cloudflare）。
 *
 * 游戏自有联机服务器，与 gamedock 平台层无关——平台只提供用户信息与邀请，
 * 不感知房间/匹配/输入中继。所有请求转给单个全局 Durable Object 实例，
 * 由它维护房间表与匹配队列（语义等同原 Node 单进程房间服）。
 */
export { RoomServer } from './room-do.mjs';

export default {
  async fetch(request, env) {
    const id = env.ROOM.idFromName('global');
    return env.ROOM.get(id).fetch(request);
  },
};
