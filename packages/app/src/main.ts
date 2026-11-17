/**
 * BVN Web 入口（切片 14 场景化；切片 34 联机回归自有 room-server 路径）。
 *
 * 默认进 开场徽标（LogoScene）→ 主菜单（单机训练 / 联机对战全 UI 流）；
 * dev 直通参数保留（headless 驱动/快速调试用，跳过开场徽标）：
 *   ?mode=solo                          直接开训练对局（默认 ichigo/gaara/KonohaMura；
 *                                       &intro=1 附带开局特写演出，intro 冒烟用）
 *   ?mode=net&action=create|join&room=   自动入房（4 位房间码）→ 房间页 → 选人页自动确认
 *   ?mode=match                          随机匹配页（自动排队；双窗口联调切片 37 用）
 *   ?mode=browse                         浏览房间页（列表轮询目检用）
 *   ?mode=local2p                       本地双人选人页（双键盘双光标目检用，不自动确认）
 *   ?mode=winner                        直接进结算立绘（ichigo 胜演出冒烟用）
 */
import { Application } from 'pixi.js';
import { connectXlp } from '@xlp/game-sdk';
import { AppHost } from './host.js';
import { AudioSubsystem } from './audio.js';
import { SceneHost } from './scenes/scene.js';
import { LogoScene } from './scenes/logo.js';
import { MenuScene } from './scenes/menu.js';
import { NetScene } from './scenes/net.js';
import { BrowseScene } from './scenes/browse.js';
import { MatchScene } from './scenes/match.js';
import { SetupScene } from './scenes/setup.js';
import { LoadingScene } from './scenes/loading.js';
import { WinnerScene } from './scenes/winner.js';
import { makeFlow } from './flow.js';

async function boot(): Promise<void> {
  const app = new Application();
  // useBackBuffer：blendRequired 过滤器（高级混合 darken/lighten/hard-light…）需要
  // back buffer 读背景内容；缺省 false 时 FilterSystem 静默跳过这些过滤器。
  await app.init({ width: 1000, height: 600, background: 0x0a0a12, antialias: true, useBackBuffer: true });
  const host = document.getElementById('stage');
  if (!host) throw new Error('#stage 缺失');
  host.appendChild(app.canvas);
  app.canvas.style.width = '100%';
  app.canvas.style.height = '100%';

  const appHost = new AppHost();
  const scenes = new SceneHost(app);
  appHost.use(new AudioSubsystem());
  appHost.use(scenes);
  await appHost.init();
  scenes.setDomHost(host);

  // 主循环：子系统（场景）每渲染帧推进
  app.ticker.add(() => appHost.update(app.ticker.deltaMS));

  // 平台握手（不在平台内运行时进 standalone；联机走自有服务器，平台账号仅作昵称显示）
  const flow = makeFlow();
  flow.xlp = await connectXlp();

  // —— 场景入口（dev 直通参数见文件头） ——
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode');
  if (!mode) {
    // 正式入口：开场徽标 → 主菜单（原版 LogoStage → MenuStage 流）
    scenes.switchTo(new LogoScene(flow));
    return;
  }
  // dev 直通：沿用旧 URL 语义
  flow.autoPick = true;
  flow.roleKeymapP2 = params.get('role') === 'p2';
  if (mode === 'solo') {
    flow.mode = 'solo';
    // dev 直通参数：?fighter=&assist=&map= 覆盖默认选人（冒烟/目检用）
    flow.localPick = {
      fighter: params.get('fighter') ?? 'ichigo',
      assist: params.get('assist') ?? 'gaara',
    };
    flow.mapId = params.get('map') ?? 'KonohaMura';
    scenes.switchTo(new LoadingScene(flow, null));
  } else if (mode === 'setup') {
    // dev 直通：只开选人页（不自动确认；切片 15 目检/驱动用）
    flow.mode = 'solo';
    flow.autoPick = false;
    scenes.switchTo(new SetupScene(flow, null));
  } else if (mode === 'local2p') {
    // dev 直通：本地双人选人页（不自动确认；双键盘双光标目检用）
    flow.mode = 'local';
    flow.autoPick = false;
    scenes.switchTo(new SetupScene(flow, null));
  } else if (mode === 'net') {
    flow.mode = 'net';
    scenes.switchTo(new NetScene(flow, {
      action: params.get('action') === 'join' ? 'join' : 'create',
      room: params.get('room') ?? undefined,
    }));
  } else if (mode === 'match') {
    // dev 直通：随机匹配页（自动排队目检/双窗口联调用）
    flow.mode = 'net';
    scenes.switchTo(new MatchScene(flow));
  } else if (mode === 'browse') {
    // dev 直通：浏览房间页（列表轮询目检用）
    flow.mode = 'net';
    scenes.switchTo(new BrowseScene(flow));
  } else if (mode === 'winner') {
    // dev 直通：结算立绘演出（ichigo 胜；CONTINUE 可重开训练局）
    flow.mode = 'solo';
    flow.localPick = { fighter: 'ichigo', assist: 'gaara' };
    flow.mapId = 'KonohaMura';
    scenes.switchTo(new WinnerScene(flow, 1, null));
  } else {
    scenes.switchTo(new MenuScene(flow));
  }
}

void boot();
