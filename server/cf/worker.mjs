/**
 * BVN 房间服 Worker 入口（Cloudflare）。
 *
 * 游戏自有联机服务器，与 gamedock 平台层无关——平台只提供用户信息与邀请，
 * 不感知房间/匹配/输入中继。所有请求转给单个全局 Durable Object 实例，
 * 由它维护房间表与匹配队列（语义等同原 Node 单进程房间服）。
 */

/**
 * 节点清单（多节点选择）。游戏页面在 gamedock.cn，跨域 GET /manifest 拉取。
 * 先作为可编辑常量内联；后续可外置到 env / config。
 */
const MANIFEST = {
  version: 1,
  autoSelectEnabled: true,
  matchNode: 'cn',
  nodes: [
    { id: 'cn', name: '国内节点', url: 'wss://120.48.185.202/bvn-ws', enabled: true },
    { id: 'cf', name: '外服节点', url: 'wss://bvn.gamedock.cn', enabled: true },
  ],
};

export { RoomServer } from './room-do.mjs';

export default {
  async fetch(request, env) {
    // manifest 由 Worker 直接应答（含 CORS），不转给 Durable Object。
    if (request.method === 'GET' && new URL(request.url).pathname === '/manifest') {
      return new Response(JSON.stringify(MANIFEST), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
    const id = env.ROOM.idFromName('global');
    return env.ROOM.get(id).fetch(request);
  },
};
