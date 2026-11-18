/**
 * 联机页共享助手（切片 37）：服务器地址行 + 建连，供 NetScene / MatchScene /
 * BrowseScene 三个联机入口复用（NetScene 原有逻辑抽提）。
 */
import { Text } from 'pixi.js';
import { domInput, makeLabel } from '../ui.js';
import type { Flow } from '../flow.js';

/** 连接房间服务器（open 前的异常/close/error 统一转 rejection）。 */
export function openServerSocket(serverUrl: string): Promise<WebSocket> {
  return new Promise((res, rej) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(serverUrl);
    } catch (e) {
      rej(e);
      return;
    }
    ws.onopen = () => {
      ws.onclose = null;
      ws.onerror = null;
      res(ws);
    };
    ws.onclose = () => rej(new Error('closed'));
    ws.onerror = () => rej(new Error('error'));
  });
}

/**
 * 服务器地址行（点击修改，localStorage 记忆；NetScene 切片 34 交互抽提）。
 * domHost = DOM 浮层宿主（SceneCtx.domHost）。
 */
export function makeServerLabel(flow: Flow, domHost: HTMLElement): Text {
  const label = makeLabel(`服务器：${flow.serverUrl}（点击修改）`, {
    size: 15,
    color: 0x8fd0ff,
  });
  label.anchor.set(0.5);
  label.eventMode = 'static';
  label.cursor = 'pointer';
  label.on('pointertap', () => {
    void (async () => {
      const { done } = domInput(domHost, 'ws(s)://host:port', flow.serverUrl);
      const url = await done;
      if (!url) return;
      flow.serverUrl = url;
      localStorage.setItem('bvn.server', url);
      label.text = `服务器：${url}（点击修改）`;
    })();
  });
  return label;
}

/** 本端显示昵称（平台资料 duck typing；standalone 回退空串由服务器清洗）。 */
export function displayName(flow: Flow): string {
  return flow.dock?.user?.username ?? '';
}
