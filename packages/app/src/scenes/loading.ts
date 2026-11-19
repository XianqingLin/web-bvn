/**
 * 进战斗加载画面（切片 31，§4.3 块 9；原版 LoadingStage 语义）。
 *
 * 演出照原版 LoadingStage/loading_fight_mc 规格（tools/ui-pack/loading-pack 烘焙）：
 *  - 800×600 舞台画（"Get ready for the next battle!" + VS 纹章）在 1000×600 逻辑屏居中；
 *  - 进度条：槽 764×15 + 填充 760×5（scaleX 0..1）+ "加载中"美术字 + 30 帧转圈 spinner；
 *  - 消息文本 = 原版 bar.txt（右对齐 14px 青 #00daf8），`消息(n/总数)`；
 *  - 双方已选面板（原版 SelectIndexUI._sltUI 语义，切片 41）：fighter 面板按位次纵排
 *    （p1 组 (70,85) / p2 组 (480,85)，间距 100）、辅助面板 p1 (-30,325) / p2 (45,325)；
 *    面板 = selected_p1/p2（253×70）+ 大脸 245×62 @(4.75,4.75)（p2 内容镜像 origin
 *    248.6）+ seltwz 角标（帧 1..3 = 位次 / 帧 4 = assist；p1 (-8,-5)、p2 fighter 右缘
 *    对齐 252-w、p2 assist x=176）。
 *  - 进出场黑幕：切场景前 transIn 合拢、进场 transOut 打开（原版 StateCtrler.transIn/
 *    transOut，见 trans.ts）。
 *
 * 装载队列照原版 build() 语义（msg + 计数）：
 *  角色×2 → 辅助（去重）→ 场景 → BGM 预解码 → 渲染纹理（web 端增列，原版并入
 *  GameLoader.loadFighter 的 swf/atlas 一步；此处 renderer.load 分步回报进度）。
 * 每步之间让出一帧（分帧化：装载不再整段卡死主线程，进度条/spinner 持续走动）。
 *
 * 与原版的偏离（登记）：
 *  - 原版 setTimeout(loadNext, 1000) 起步延帧与 loadFin 后 1s 定场，起步延帧对
 *    本地资源纯增延迟，省去；定场保留（600ms，让进度条走满可读）；
 *  - 原版 loadProcess 为单文件下载进度，此处为分步计数进度（fetch 无字节级回调）；
 *  - 原版加载页可呼出确认框返回主菜单，此处 ESC 直接返回（无确认 UI）。
 */
import { Assets, Container, Sprite, Text, Texture } from 'pixi.js';
import { BattleRenderer } from '@bvn/render';
import type { WsLike } from '@bvn/net';
import type { Scene, SceneCtx } from './scene.js';
import { SceneHost } from './scene.js';
import { makeButton, UI_W } from '../ui.js';
import { audioOf } from '../audio.js';
import {
  ASSETS,
  loadAssistPack,
  loadBisha,
  loadFighterPack,
  loadHud,
  loadHitspark,
  loadLoading,
  loadMapPack,
  loadSelect,
  loadUi,
  uiFaceUrl,
  type AssistPack,
  type BishaData,
  type FighterPack,
  type LoadingData,
  type MapPack,
  type UiData,
} from '../data.js';
import { picksOf, teamPicksOf, type Flow } from '../flow.js';
import { BattleScene, fighterId, type BattleLoadout, type RosterEntry } from './battle.js';
import { clearTrans, transIn, transOut } from './trans.js';
import { buildLoadingBar, tickLoadingBar, type LoadingBar } from './bar.js';

/** 原版舞台 800×600 在 1000×600 逻辑屏中的横向偏移。 */
const STAGE_W = 800;
const OX = (UI_W - STAGE_W) / 2;

/** 加载页双方面板布局（原版 SelectIndexUI/SelectIndexUIGroup SHOW_MODE=0 实证）。 */
const PANEL = {
  /** 组摆放位（stage 坐标） */
  groupPos: { p1: [70, 85] as [number, number], p2: [480, 85] as [number, number] },
  /** fighter 面板纵向间距（gy=100；fighterOffset (0,0)） */
  fighterGapY: 100,
  /** 辅助面板位（fzx/fzy） */
  assistPos: { p1: [-30, 325] as [number, number], p2: [45, 325] as [number, number] },
  /** 角标位（SelectedFighterUI.setFighterIndex/setAssister） */
  badge: { p1: [-8, -5] as [number, number], p2FighterRight: 252, p2AssistX: 176, y: -5 },
};

/** 装载完成后的定场时长（原版 loadFin → setTimeout 1000ms → finish）。 */
const FINISH_HOLD_MS = 600;

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export class LoadingScene implements Scene {
  readonly name = 'loading';

  private destroyed = false;
  /** 装载完成（定场计时开始） */
  private loadedAt = -1;
  /** 已发起进战斗转场（防 update 每帧重入） */
  private finishing = false;
  private failed = false;
  private ui: Container | null = null;
  /** 进度条组件（bar.ts 装配；fill/msg/spin 由 update 驱动） */
  private barRef: LoadingBar | null = null;
  private barState = { shown: 0, spinAcc: 0, spinFrame: -1 };
  private msg: Text | null = null;
  /** 进度：target = 队列推进即设；shown = update 平滑逼近（条形补间） */
  private target = 0;
  private total = 1;
  private ctxRef: SceneCtx | null = null;
  private loadout: BattleLoadout | null = null;
  /** 本场景创建的渲染器（交接给 BattleScene 前归本场景所有，失败/退出须销毁） */
  private renderer: BattleRenderer | null = null;
  private cleanup: (() => void)[] = [];

  constructor(
    private readonly flow: Flow,
    /** 联机 socket（net；solo 为 null） */
    private readonly socket: WsLike | null,
  ) {}

  async enter(ctx: SceneCtx): Promise<void> {
    this.ctxRef = ctx;
    const audio = audioOf(ctx.ctx);
    audio?.bgm('loading'); // 原版 SoundCtrler.BGM(AssetManager getSound('loading'))

    const ui = new Container();
    this.ui = ui;
    ctx.root.addChild(ui);
    const data = await loadLoading(ctx.ctx);

    // 原版 800×600 舞台画居中
    const bg = new Sprite(await Assets.load<Texture>(`${ASSETS}/${data.bg.url}`));
    bg.position.set(OX, 0);
    ui.addChild(bg);

    // 进度条组（bar 容器 = 原版 loadingbar_mc 摆放位；组件规格见 bar.ts）
    const built = await buildLoadingBar(data, OX + data.bar.pos[0], data.bar.pos[1]);
    ui.addChild(built.bar);
    this.barRef = built;
    this.msg = built.msg;

    // ESC 返回菜单（原版 LoadingStage.render 的 BACK TITLE；无确认框，偏离登记）
    const onEsc = (e: KeyboardEvent) => {
      if (e.code === 'Escape') this.leave();
    };
    window.addEventListener('keydown', onEsc);
    this.cleanup.push(() => window.removeEventListener('keydown', onEsc));

    // enter 即返回（SceneHost 解锁 update）；装载队列后台分帧推进
    void this.runQueue(ctx, data);

    // 原版 afterBuild → transOut：黑幕打开露出加载画面
    transOut(ctx);
  }

  // ---------- 双方已选面板（原版 SelectIndexUI._sltUI / SelectedFighterUI 规格） ----------

  /** 挂双方 roster 面板：fighter 按位次纵排（含大脸+角标）+ 辅助面板。 */
  private async mountPanels(
    ui: Container,
    data: LoadingData,
    uiData: UiData,
    picks: {
      p1: { fighters: string[]; assist: string };
      p2: { fighters: string[]; assist: string };
    },
  ): Promise<void> {
    const [panelP1, panelP2] = await Promise.all([
      Assets.load<Texture>(`${ASSETS}/${uiData.select.elements.selected_p1}`),
      Assets.load<Texture>(`${ASSETS}/${uiData.select.elements.selected_p2}`),
    ]);
    const badgeTex: Texture[] = [];
    for (let i = 1; i <= data.seltwz.frames; i++) {
      badgeTex.push(await Assets.load<Texture>(`${ASSETS}/${data.seltwz.dir}/${i}.webp`));
    }

    const mountSide = (side: 1 | 2): void => {
      const isP2 = side === 2;
      const [gx, gy] = isP2 ? PANEL.groupPos.p2 : PANEL.groupPos.p1;
      const group = new Container();
      group.position.set(OX + gx, gy);
      ui.addChild(group);
      const pick = isP2 ? picks.p2 : picks.p1;

      const mountPanel = (id: string, isAssist: boolean, index: number): void => {
        const c = new Container();
        if (isAssist) {
          const [ax, ay] = isP2 ? PANEL.assistPos.p2 : PANEL.assistPos.p1;
          c.position.set(ax, ay);
        } else {
          c.position.set(0, index * PANEL.fighterGapY); // fighterOffset (0,0)
        }
        group.addChild(c);

        // 面板底（原版 selected_item_p1/p2_mc 253×70；p2 纹理自带镜像内容）
        c.addChild(new Sprite(isP2 ? panelP2 : panelP1));

        // 大脸 245×62 @(4.75,4.75)（辅助同用大脸，同 setup 展示框 refreshBox）；
        // p2 内容镜像（origin 248.6，scaleX=-1）
        const faceUrl = uiFaceUrl(uiData, id, '_b');
        if (faceUrl) {
          const ct = new Container();
          const [cx, cy] = isP2 ? uiData.select.faceBigP2Origin : uiData.select.faceBigOffset;
          ct.position.set(cx, cy);
          if (isP2) ct.scale.x = -1;
          const face = new Sprite(Texture.EMPTY);
          face.width = 245;
          face.height = 62;
          ct.addChild(face);
          c.addChild(ct);
          void Assets.load<Texture>(faceUrl).then((t) => {
            face.texture = t;
            face.width = 245;
            face.height = 62;
          });
        }

        // 角标（seltwzmc：帧 1..3 位次 / 帧 4 assist）
        const badge = new Sprite(badgeTex[isAssist ? 3 : index]!);
        if (isP2) {
          badge.position.set(isAssist ? PANEL.badge.p2AssistX : PANEL.badge.p2FighterRight - badge.width, PANEL.badge.y);
        } else {
          badge.position.set(PANEL.badge.p1[0], PANEL.badge.y);
        }
        c.addChild(badge);
      };

      pick.fighters.forEach((id, i) => mountPanel(id, false, i));
      mountPanel(pick.assist, true, 0);
    };

    mountSide(1);
    mountSide(2);
  }

  // ---------- 装载队列（原版 LoadingStage.build 语义） ----------

  private async runQueue(ctx: SceneCtx, data: LoadingData): Promise<void> {
    try {
      // 团队模式（切片 36）：累计选人按锁定次序组 roster（≤3 名/侧，per-side
      // 辅助取首名）；1v1 单名回退（picksOf）
      const sidePicks = this.flow.team
        ? teamPicksOf(this.flow)
        : (() => {
            const { p1, p2 } = picksOf(this.flow);
            return {
              p1: { fighters: [p1.fighter], assist: p1.assist },
              p2: { fighters: [p2.fighter], assist: p2.assist },
              };
          })();
      const select = await loadSelect(ctx.ctx);
      const uiData = await loadUi(ctx.ctx);
      // 双方已选面板（原版 construct 挂 _sltUI；面板纹理/角标装载后先挂，装载期间可见）
      if (!this.destroyed) await this.mountPanels(this.ui!, data, uiData, sidePicks);
      const entryOf = (id: string) => select.chars.find((c) => c.id === id);
      const nameOf = (id: string) => entryOf(id)?.name ?? id;
      const swfOf = (id: string) => entryOf(id)?.swf ?? id;
      const startOf = (id: string) => entryOf(id)?.startFrame ?? 1;
      const assistNameOf = (id: string) => select.assists.find((c) => c.id === id)?.name ?? id;
      const mapName = select.maps.find((m) => m.id === this.flow.mapId)?.name ?? this.flow.mapId;

      // 角色包按 id 缓存：同一 id 可在 roster 内/跨侧重复选（两个 fighter id
      // 共享同一 FighterPack；def/forms 只读共享安全）
      const packCache = new Map<string, FighterPack>();
      const uniqueFighterIds = [...new Set([...sidePicks.p1.fighters, ...sidePicks.p2.fighters])];
      const assistList: AssistPack[] = [];
      let map: MapPack | null = null;
      let bisha: BishaData | null = null;
      let hitspark: import('@bvn/render').HitsparkBaked | null = null;
      let hud: import('@bvn/render').HudData | null = null;

      const queue: { msg: string; run: () => Promise<void> }[] = [
        ...uniqueFighterIds.map((id) => ({
          msg: `正在加载角色：${nameOf(id)}`,
          run: async () => {
            packCache.set(id, await loadFighterPack(ctx.ctx, id, swfOf(id), startOf(id)));
          },
        })),
        ...[...new Set([sidePicks.p1.assist, sidePicks.p2.assist])].map((id) => ({
          msg: `正在加载辅助角色：${assistNameOf(id)}`,
          run: async () => {
            assistList.push(await loadAssistPack(ctx.ctx, id));
          },
        })),
        {
          msg: `正在加载场景：${mapName}`,
          run: async () => {
            map = await loadMapPack(ctx.ctx, this.flow.mapId);
          },
        },
        {
          // 原版 SoundCtrler.loadFightBGM：加载页预解码战斗曲（KO 重开/进图不卡解码）
          msg: '正在加载BGM',
          run: async () => {
            await audioOf(ctx.ctx)?.preloadFightBgm(sidePicks.p1.fighters[0]!, this.flow.mapId);
            bisha = await loadBisha(ctx.ctx);
            hitspark = await loadHitspark(ctx.ctx);
            hud = await loadHud(ctx.ctx);
          },
        },
      ];
      this.total = queue.length + 1; // + 渲染纹理步
      let cur = 0;
      for (const item of queue) {
        if (this.destroyed) return;
        cur++;
        this.setItem(item.msg, cur);
        await item.run();
        if (this.destroyed) return;
        this.target = cur / this.total;
        await nextFrame(); // 分帧：装载步间让出一帧，进度条/spinner 持续走动
      }

      // —— 渲染装配（原版并入 GameLoader.loadFighter 的纹理步；此处单列分步回报） ——
      if (this.destroyed) return;
      cur++;
      this.setItem('正在加载资源', cur);
      const renderer = new BattleRenderer(ctx.pixi);
      renderer.setStageVisible(false); // 装载期隐藏世界/HUD 隐藏层（加载画面之下不露地图）
      this.renderer = renderer;
      // 渲染层直挂 pixi.stage（晚于 uiRoot）→ 重提 uiRoot 到顶，加载画面不被盖住
      const host = ctx.ctx.peek<SceneHost>('scenes');
      if (host) ctx.pixi.stage.addChild(host.uiRoot);
      const mkRoster = (ids: string[]): RosterEntry[] =>
        ids.map((id) => ({
          pack: packCache.get(id)!,
          comicType: entryOf(id)?.comicType ?? 0,
        }));
      const rig = {
        map: map!,
        p1: mkRoster(sidePicks.p1.fighters),
        p2: mkRoster(sidePicks.p2.fighters),
        p1Assist: sidePicks.p1.assist,
        p2Assist: sidePicks.p2.assist,
        assists: Object.fromEntries(assistList.map((a) => [a.id, a])),
      };
      const hudFace = (id: string, assistId: string) => ({
        faceUrl: uiFaceUrl(uiData, id, '_m'),
        assistFaceUrl: uiFaceUrl(uiData, assistId, ''),
        comicType: entryOf(id)?.comicType ?? 0,
      });
      await renderer.load(
        {
          baseUrl: ASSETS,
          // roster 全员精灵（team bench 预载；id-swap：入场即换无需重绑图集）
          fighters: [
            ...rig.p1.map((e, i) => ({
              slot: fighterId(1, i),
              atlasId: e.pack.id,
              formIndex: e.pack.def.formIndex,
            })),
            ...rig.p2.map((e, i) => ({
              slot: fighterId(2, i),
              atlasId: e.pack.id,
              formIndex: e.pack.def.formIndex,
            })),
          ],
          assisters: [
            { ownerId: 1, atlasId: rig.p1Assist },
            { ownerId: 2, atlasId: rig.p2Assist },
          ],
          mapAtlasId: rig.map.id,
          mapBottomOffset: rig.map.pkg.bottomOffset,
          mapBottom: rig.map.pkg.bottom,
          fireAtlases: {
            // 键 = 出场者 atlasId（render 侧按精灵 atlasId 查），值 = fire 图集 id（swf 基名）
            fighter: Object.fromEntries(
              [...rig.p1, ...rig.p2]
                .filter((e) => e.pack.hasFires)
                .map((e) => [e.pack.id, e.pack.swf]),
            ),
            assister: Object.fromEntries(
              assistList.filter((a) => a.hasFires).map((a) => [a.id, a.id]),
            ),
          },
          bisha: { mc: bisha!.mc, faces: bisha!.faces, effects: bisha!.effects },
          hitspark: { baked: hitspark! },
          hud: {
            data: hud!,
            // 血条大脸 = select id+'_m'（102×64）；辅助脸 = 辅助 id 50×50 网格脸
            //（原版 getFighterFace 缺省 size）；能量标签帧 = comicType（0=死神 1=火影）
            fighters: {
              p1: hudFace(sidePicks.p1.fighters[0]!, sidePicks.p1.assist),
              p2: hudFace(sidePicks.p2.fighters[0]!, sidePicks.p2.assist),
            },
            // 团队 roster 大脸/能量标签（按 fighter id 寻址；换人切换消费）
            ...(this.flow.team
              ? {
                  teamFighters: Object.fromEntries(
                    [
                      ...rig.p1.map((e, i) => [
                        fighterId(1, i),
                        hudFace(e.pack.id, sidePicks.p1.assist),
                      ]),
                      ...rig.p2.map((e, i) => [
                        fighterId(2, i),
                        hudFace(e.pack.id, sidePicks.p2.assist),
                      ]),
                    ],
                  ),
                }
              : {}),
          },
        },
        (p) => {
          this.target = (cur - 1 + p) / this.total;
        },
      );
      if (this.destroyed) {
        return;
      }
      renderer.prime(); // 首帧定位：修换场景首帧 world@原点 / bg 未 cover 的"进场黑边"
      this.loadout = { rig, renderer };
      this.renderer = null; // 所有权移交
      this.target = 1;
      this.loadedAt = performance.now(); // update 定场 FINISH_HOLD_MS 后进战斗
    } catch (err) {
      if (this.destroyed) return;
      this.failed = true;
      this.msg!.text = `加载失败：${err instanceof Error ? err.message : String(err)}`;
      const btn = makeButton('返回菜单', () => this.leave());
      btn.position.set(UI_W / 2 - 90, 500);
      this.ui!.addChild(btn);
    }
  }

  private setItem(msg: string, cur: number): void {
    // 原版 updateMsg：`消息(cur/total)`
    this.msg!.text = `${msg}(${cur}/${this.total})`;
  }

  // ---------- 流转 ----------

  private gotoBattle(): void {
    const ctx = this.ctxRef;
    const loadout = this.loadout;
    if (!ctx || !loadout) return;
    if (this.finishing) return; // 防重入（update 定场后每帧会再触发）
    this.finishing = true;
    // 原版 gotoGame → transIn：黑幕合拢后进战斗（开场演出阶段 transOut 打开）
    transIn(ctx, () => {
      if (this.destroyed) {
        clearTrans(); // 转场中被 ESC 打断：撤黑幕
        return;
      }
      this.destroyed = true; // 防重入（battle enter 为异步，switching 门禁期间 update 已停）
      ctx.switchTo(new BattleScene(this.flow, this.socket, loadout));
    });
  }

  private leave(): void {
    const ctx = this.ctxRef;
    if (!ctx || this.destroyed) return;
    this.destroyed = true;
    clearTrans(); // 转场中被 ESC 打断：撤黑幕（原版 StageCtrler.clearTrans 语义）
    this.socket?.close();
    audioOf(ctx.ctx)?.bgm(null); // 原版 LoadingStage.destory BGM(null)
    void import('./menu.js').then(({ MenuScene }) => ctx.switchTo(new MenuScene(this.flow)));
  }

  update(dtMs: number): void {
    if (this.destroyed) return;
    // spinner 帧循环 + 进度条平滑逼近（bar.ts 共享驱动）
    tickLoadingBar(this.barRef, dtMs, this.target, this.barState);
    // 原版 loadFin 定场后 finish() → goGame
    if (this.loadedAt >= 0 && !this.failed) {
      if (performance.now() - this.loadedAt >= FINISH_HOLD_MS) this.gotoBattle();
    }
  }

  exit(): void {
    this.destroyed = true;
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    // 未交接的渲染器（失败/ESC 中途退出）归本场景销毁
    this.renderer?.destroy();
    this.renderer = null;
    this.ui?.destroy({ children: true });
    this.ui = null;
    this.barRef = null;
    this.msg = null;
    this.ctxRef = null;
  }
}
