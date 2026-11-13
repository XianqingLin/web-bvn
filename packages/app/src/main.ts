/**
 * BVN Web 入口（切片 14 场景化）。
 *
 * 默认进 开场徽标（LogoScene）→ 主菜单（单机训练 / 联机对战全 UI 流）；
 * dev 直通参数保留（headless 驱动/快速调试用，跳过开场徽标）：
 *   ?mode=solo                          直接开训练对局（默认 ichigo/gaara/KonohaMura）
 *   ?mode=net&action=create|join&room=&server=&role=p2
 *                                       自动入房 → 选人页自动确认默认选人
 *   ?mode=winner                        直接进结算立绘（ichigo 胜演出冒烟用）
 */
import { Application } from 'pixi.js';
import { AppHost } from './host.js';
import { AudioSubsystem } from './audio.js';
import { SceneHost } from './scenes/scene.js';
import { LogoScene } from './scenes/logo.js';
import { MenuScene } from './scenes/menu.js';
import { NetScene } from './scenes/net.js';
import { SetupScene } from './scenes/setup.js';
import { BattleScene } from './scenes/battle.js';
import { WinnerScene } from './scenes/winner.js';
import { makeFlow } from './flow.js';

async function boot(): Promise<void> {
  const app = new Application();
  await app.init({ width: 1000, height: 600, background: 0x0a0a12, antialias: true });
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

  // —— 场景入口（dev 直通参数见文件头） ——
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode');
  if (!mode) {
    // 正式入口：开场徽标 → 主菜单（原版 LogoStage → MenuStage 流）
    scenes.switchTo(new LogoScene(makeFlow()));
    return;
  }
  // dev 直通：沿用旧 URL 语义
  const flow = makeFlow();
  flow.autoPick = true;
  flow.roleKeymapP2 = params.get('role') === 'p2';
  if (mode === 'solo') {
    flow.mode = 'solo';
    flow.localPick = { fighter: 'ichigo', assist: 'gaara' };
    flow.mapId = 'KonohaMura';
    scenes.switchTo(new BattleScene(flow, null));
  } else if (mode === 'setup') {
    // dev 直通：只开选人页（不自动确认；切片 15 目检/驱动用）
    flow.mode = 'solo';
    flow.autoPick = false;
    scenes.switchTo(new SetupScene(flow, null));
  } else if (mode === 'net') {
    flow.mode = 'net';
    const server = params.get('server');
    if (server) {
      flow.serverUrl = server;
      localStorage.setItem('bvn.server', server);
    }
    if (params.get('port')) {
      flow.serverUrl = `ws://localhost:${params.get('port')}`;
      localStorage.setItem('bvn.server', flow.serverUrl);
    }
    scenes.switchTo(new NetScene(flow, {
      action: params.get('action') === 'join' ? 'join' : 'create',
      room: params.get('room') ?? undefined,
    }));
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
