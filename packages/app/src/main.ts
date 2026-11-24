/**
 * BVN Web 入口。
 *
 * 默认进 游戏初始化封面（GameLoadingScene，原版"绊"页）→ 开场徽标 → 主菜单（单机训练 /
 * 联机对战全 UI 流）；
 * ?server= 房间服务器地址覆盖（会话级强制，禁用随机匹配；正式入口与 dev 直通均生效）；
 * dev 直通参数保留（headless 驱动/快速调试用，跳过开场徽标）：
 *   ?mode=solo                          直接开训练对局（默认 ichigo/gaara/KonohaMura；
 *                                       &intro=1 附带开局特写演出，intro 冒烟用）
 *   ?mode=net&action=create|join&room=   落主菜单自动执行：创建/凭码加入（房间浮层）
 *                                       → 选人页自动确认
 *   ?mode=match                          落主菜单自动随机匹配（双窗口联调用）
 *   ?mode=local2p                       本地双人选人页（双键盘双光标目检用，不自动确认）
 */
import { Application } from 'pixi.js';
import { connectGameDock } from '@gamedock/game-sdk';
import { installAssetVersioning } from './asset-versioning.js';
import { AppHost } from './host.js';
import { AudioSubsystem } from './audio.js';
import { SceneHost } from './scenes/scene.js';
import { GameLoadingScene } from './scenes/game-loading.js';
import { MenuScene } from './scenes/menu.js';
import { SetupScene } from './scenes/setup.js';
import { LoadingScene } from './scenes/loading.js';
import { makeFlow } from './flow.js';
import { readInviteJoin } from './invite-context.js';
import { resolveJoinNode, selectNode } from './nodes.js';


async function boot(): Promise<void> {
  // 资产 URL 指纹化拦截器（须先于一切资产请求与 AppHost 构造，见模块头注释）
  installAssetVersioning();
  const app = new Application();
  // useBackBuffer：blendRequired 过滤器（高级混合 darken/lighten/hard-light…）需要
  // back buffer 读背景内容；缺省 false 时 FilterSystem 静默跳过这些过滤器。
  await app.init({ width: 1000, height: 600, background: 0x0a0a12, antialias: true, useBackBuffer: true });
  const host = document.getElementById('stage');
  if (!host) throw new Error('#stage 缺失');
  host.appendChild(app.canvas);
  app.canvas.style.display = 'block';
  app.canvas.style.width = '100%';
  app.canvas.style.height = '100%';

  // CSS 尺寸决定可见画面,renderer.resolution 决定实际渲染像素。
  // 场景仍使用 1000×600 逻辑坐标,避免大窗口只是把低分辨率画布拉伸发虚。
  const resizeRenderer = () => {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width <= 0 || height <= 0) return;
    const resolution = Math.min(window.devicePixelRatio || 1, 2);
    if (
      app.renderer.screen.width === width &&
      app.renderer.screen.height === height &&
      app.renderer.resolution === resolution
    ) {
      return;
    }
    app.renderer.resize(width, height, resolution);
  };
  resizeRenderer();
  const resizeObserver = new ResizeObserver(resizeRenderer);
  resizeObserver.observe(host);
  // 屏幕 DPR 变化不一定改变宿主 CSS 尺寸,窗口 resize 时再核对一次。
  window.addEventListener('resize', resizeRenderer);

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
  flow.dock = await connectGameDock();
  // 上报舞台尺寸：平台运行页据此信箱式收紧 iframe，消除固定比例周围的空白（standalone 为 no-op）
  flow.dock.reportViewport(1000, 600);

  // —— 场景入口（dev 直通参数见文件头） ——
  const params = new URLSearchParams(location.search);
  // ?server= 覆盖房间服务器地址（会话级强制，禁用随机匹配；联机入口统一消费此值）
  const serverParam = params.get('server');
  if (serverParam) {
    flow.serverUrl = serverParam;
    flow.serverForced = true;
  }
  const mode = params.get('mode');
  if (!mode) {
    // 正式入口：后台异步择优节点（与封面动画并行，不阻塞；?server= 强制指定优先）。
    // 深链 `?room=&node=`（DESIGN §6.2）与 hello join 均语义等价"指定房间 + 节点"：
    // 前者只登记 flow.pendingDeepLink（目标节点 ≠ 当前时由主菜单确认框锁定切换），
    // 后者沿用静默锁定切换 + 房码暂存 flow.pendingInviteRoom（主菜单自动加入；
    // 邀请票模型落地后收口为邀请卡）。
    const inviteJoin = readInviteJoin(flow.dock);
    const joinRoomCode = params.get('room');
    const joinNode = params.get('node');
    void (async () => {
      if (joinRoomCode && joinNode) {
        flow.pendingDeepLink = { room: joinRoomCode, node: joinNode };
        await selectNode(flow);
        return;
      }
      if (inviteJoin) {
        await resolveJoinNode(flow, inviteJoin.room, inviteJoin.node);
        flow.pendingInviteRoom = inviteJoin.room;
        return;
      }
      await selectNode(flow);
    })();
    // 游戏初始化封面（原版 GameLoadingStage"绊"）→ 开场徽标 → 主菜单
    scenes.switchTo(new GameLoadingScene(flow));
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
    // dev 直通：主菜单就绪后自动执行（创建/凭码加入）
    scenes.switchTo(new MenuScene(flow, {
      action: params.get('action') === 'join' ? 'join' : 'create',
      room: params.get('room') || undefined,
    }));
  } else if (mode === 'match') {
    // dev 直通：主菜单就绪后自动进入随机匹配（双窗口联调用）
    scenes.switchTo(new MenuScene(flow, { action: 'match' }));
  } else {
    scenes.switchTo(new MenuScene(flow));
  }
}

void boot();
