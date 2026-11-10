/**
 * BattleRenderer —— 战斗画面渲染（DESIGN §5）。
 *
 * 唯一输入 = SimSnapshot（契约）：位置在相邻两快照间线性插值，
 * 动画帧/朝向取最新快照；相机纯渲染（ADR-4）；HUD 读快照；
 * 表现事件按 tick 去重消费（不回读 sim 内部状态）。
 */
import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { SimSnapshot } from '@bvn/core';
import type { FighterAtlas, MapAtlas } from '@bvn/data';
import { frameTexture, loadFighterAtlas, loadMapAtlas, type LoadedFighterAtlas, type LoadedMapAtlas } from './atlas.js';

const TICK_MS = 1000 / 60;
const LOGICAL_W = 1000;
const LOGICAL_H = 600;

/** 战斗资源清单（app 装配后传入） */
export interface BattleAssetsSpec {
  /** 素材基 URL（图集 JSON 与 sheet PNG 同目录） */
  baseUrl: string;
  /** 战斗出场角色：slot = SimState.fighters 里的 fighter id；
   *  formIndex = FighterDef.formIndex（对应图集 forms 数组下标） */
  fighters: { slot: number; atlasId: string; kind?: 'fighter' | 'assister'; formIndex?: number }[];
  /** 辅助（切片 12）：ownerId = 召唤者 fighter id；atlasId = 辅助包 id */
  assisters?: { ownerId: number; atlasId: string }[];
  mapAtlasId: string;
  mapAtlasJson?: MapAtlas;
  fighterAtlasJson?: Record<string, FighterAtlas>;
}

interface FighterSprite {
  root: Container;
  body: Sprite;
  atlasId: string;
  loaded: LoadedFighterAtlas | null;
  /** 图集 forms 下标（= FighterDef.formIndex） */
  formIndex: number;
  /** 已应用的内层帧 pngId（避免每渲染帧换纹理） */
  appliedPng: number;
  appliedFacing: number;
}

export class BattleRenderer {
  private world: Container;
  private mapLayer: Container;
  /** 前景层（地图 floor 图层：绘制在角色脚前，原版 BVN 层序） */
  private mapFrontLayer: Container;
  private fighterLayer: Container;
  private bulletLayer: Container;
  private bulletGfx: Graphics;
  private fxLayer: Container;
  private hudLayer: Container;
  private sprites = new Map<number, FighterSprite>();
  /** 辅助精灵（切片 12）：key = 召唤者 fighter id（同主同时至多一个辅助） */
  private assistSprites = new Map<number, FighterSprite>();
  private mapLoaded: LoadedMapAtlas | null = null;
  private roundText: Text | null = null;
  private hintText: Text | null = null;

  private prev: SimSnapshot | null = null;
  private next: SimSnapshot | null = null;
  private accMs = 0;
  private lastEventsTick = new Map<string, number>();

  /** 相机（逻辑坐标）：中心点，指数平滑 */
  private camX = LOGICAL_W / 2;
  private camY = LOGICAL_H / 2;
  private zoom = 1;
  /** 世界容器宽（屏幕像素）：缩放 = worldW / LOGICAL_W */
  private viewW = LOGICAL_W;
  private viewH = LOGICAL_H;

  constructor(private app: Application) {
    this.world = new Container();
    this.mapLayer = new Container();
    this.mapFrontLayer = new Container();
    this.fighterLayer = new Container();
    this.bulletLayer = new Container();
    this.bulletGfx = new Graphics();
    this.fxLayer = new Container();
    this.hudLayer = new Container();
    this.bulletLayer.addChild(this.bulletGfx);
    // 层序：bg/map < 角色 < 飞行道具 < 前景 floor < 特效
    this.world.addChild(
      this.mapLayer,
      this.fighterLayer,
      this.bulletLayer,
      this.mapFrontLayer,
      this.fxLayer,
    );
    app.stage.addChild(this.world, this.hudLayer);
    this.onResize();
    app.renderer.on('resize', this.onResize, this);
  }

  private onResize(): void {
    this.viewW = this.app.renderer.width;
    this.viewH = this.app.renderer.height;
  }

  /** 加载战斗素材（app await）。 */
  async load(spec: BattleAssetsSpec): Promise<void> {
    const atlasFor = async (atlasId: string, kind: 'fighter' | 'assister'): Promise<FighterAtlas> => {
      if (spec.fighterAtlasJson?.[atlasId]) return spec.fighterAtlasJson[atlasId]!;
      const url = `${spec.baseUrl}/${kind === 'assister' ? 'assistants' : 'fighters'}/${atlasId}.atlas.json`;
      return (await this.fetchJson(url)) as FighterAtlas;
    };

    const mapAtlas: MapAtlas =
      spec.mapAtlasJson ??
      ((await this.fetchJson(`${spec.baseUrl}/maps/${spec.mapAtlasId}.atlas.json`)) as MapAtlas);
    // atlas JSON 内 file 为裸文件名，sheet PNG 与 atlas JSON 同目录（assets/<kind>/）
    this.mapLoaded = await loadMapAtlas(`${spec.baseUrl}/maps`, mapAtlas);
    this.buildMap();

    for (const f of spec.fighters) {
      const kind = f.kind ?? 'fighter';
      const atlas = await atlasFor(f.atlasId, kind);
      const loaded = await loadFighterAtlas(`${spec.baseUrl}/${kind === 'assister' ? 'assistants' : 'fighters'}`, atlas);
      this.sprites.set(f.slot, this.makeSprite(f.atlasId, loaded, f.formIndex ?? 0));
    }

    for (const a of spec.assisters ?? []) {
      const atlas = await atlasFor(a.atlasId, 'assister');
      const loaded = await loadFighterAtlas(`${spec.baseUrl}/assistants`, atlas);
      this.assistSprites.set(a.ownerId, this.makeSprite(a.atlasId, loaded, 0));
    }
  }

  private async fetchJson(url: string): Promise<unknown> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`render: 资源 JSON 加载失败 ${url} (${res.status})`);
    return res.json();
  }

  private buildMap(): void {
    this.mapLayer.removeChildren();
    this.mapFrontLayer.removeChildren();
    const loaded = this.mapLoaded;
    if (!loaded) return;
    loaded.atlas.layers.forEach((ly, i) => {
      const tex = loaded.textures[i];
      if (!tex) return;
      const sp = new Sprite(tex);
      // 图层 display 原点偏移 + 内容 bounds 偏移（均相对地图 root）
      sp.position.set(ly.x + ly.bx, ly.y + ly.by);
      // floor 层 = 脚前前景（角色走在地面图后面，原版 BVN 层序）
      if (ly.name === 'floor') this.mapFrontLayer.addChild(sp);
      else this.mapLayer.addChild(sp);
    });
  }

  private makeSprite(atlasId: string, loaded: LoadedFighterAtlas, formIndex: number): FighterSprite {
    const root = new Container();
    const body = new Sprite(Texture.WHITE);
    body.visible = false;
    root.addChild(body);
    this.fighterLayer.addChild(root);
    return { root, body, atlasId, loaded, formIndex, appliedPng: -1, appliedFacing: 0 };
  }

  /** sim tick 后由 app 调：滚动快照窗口，消费表现事件。 */
  onSnapshot(snap: SimSnapshot): void {
    this.prev = this.next;
    this.next = snap;
    if (!this.prev) this.prev = snap;
    this.accMs = 0;
    this.consumeEvents(snap);
  }

  private consumeEvents(snap: SimSnapshot): void {
    for (const ev of snap.events) {
      const key = `${ev.tick}:${ev.type}`;
      const last = this.lastEventsTick.get(key);
      if (last === ev.tick) continue; // 去重
      this.lastEventsTick.set(key, ev.tick);
      if (ev.type === 'hit:connect') {
        // 最小表现：受击者闪红
        const target = ev.payload['target'];
        const sp = typeof target === 'number' ? this.sprites.get(target) : undefined;
        if (sp) {
          sp.body.tint = 0xff4444;
          setTimeout(() => {
            sp.body.tint = 0xffffff;
          }, 90);
        }
      } else if (ev.type === 'fighter:form') {
        // 万解形态切换：切图集 forms 下标，强制重应用贴图
        const fighter = ev.payload['fighter'];
        const form = ev.payload['form'];
        if (typeof fighter !== 'number' || typeof form !== 'number') continue;
        const sp = this.sprites.get(fighter);
        if (sp && form !== sp.formIndex) {
          sp.formIndex = form;
          sp.appliedPng = -1;
        }
      }
      // sound/effect/round:* 等事件切片 4 不实现（音效明确不做）
    }
  }

  /** 每渲染帧调用：插值推进。dtMs 自上次调用以来的毫秒数。 */
  update(dtMs: number): void {
    if (!this.next) return;
    this.accMs = Math.min(this.accMs + dtMs, TICK_MS);
    const alpha = this.accMs / TICK_MS;
    const prev = this.prev!;
    const next = this.next;

    // —— 战斗体：位置插值，朝向/动画帧取最新 ——
    for (const f of next.state.fighters) {
      const sp = this.sprites.get(f.id);
      if (!sp) continue;
      const p = prev.state.fighters.find((x) => x.id === f.id) ?? f;
      const ix = p.x + (f.x - p.x) * alpha;
      const iy = p.y + (f.y - p.y) * alpha;

      sp.root.position.set(ix, iy);
      if (sp.appliedFacing !== f.facing) {
        sp.root.scale.x = f.facing;
        sp.appliedFacing = f.facing;
      }
      // 内层帧 = 最新快照
      this.applyFrame(sp, f.actLabel !== null ? f.animFrame : 0);
    }

    this.updateBullets(prev, next, alpha);
    this.updateAssisters(prev, next, alpha);
    this.updateCamera(next);
    this.updateHud(next);
  }

  /** 辅助实体（切片 12）：位置插值 + 时间轴帧，退场隐藏。 */
  private updateAssisters(
    prev: SimSnapshot,
    next: SimSnapshot,
    alpha: number,
  ): void {
    for (const [ownerId, sp] of this.assistSprites) {
      const a = next.state.assisters.find((x) => x.ownerId === ownerId);
      if (!a) {
        sp.root.visible = false;
        sp.appliedPng = -1;
        continue;
      }
      sp.root.visible = true;
      const p = prev.state.assisters.find((x) => x.ownerId === ownerId) ?? a;
      const ix = p.x + (a.x - p.x) * alpha;
      const iy = p.y + (a.y - p.y) * alpha;
      sp.root.position.set(ix, iy);
      if (sp.appliedFacing !== a.facing) {
        sp.root.scale.x = a.facing;
        sp.appliedFacing = a.facing;
      }
      this.applyFrame(sp, a.actLabel !== null ? a.animFrame : 0);
    }
  }

  /**
   * 飞行道具（切片 8 占位表现）：命中矩形色块 + 按发射朝向的尖端。
   * bullet 精灵图集（fire 元件自身时间轴）待后续切片接入图集管线。
   */
  private updateBullets(
    prev: SimSnapshot,
    next: SimSnapshot,
    alpha: number,
  ): void {
    const g = this.bulletGfx;
    g.clear();
    for (const b of next.state.bullets) {
      const p = prev.state.bullets.find((x) => x.id === b.id) ?? b;
      const ix = p.x + (b.x - p.x) * alpha;
      const iy = p.y + (b.y - p.y) * alpha;
      // 颜色按 hitType 粗分（1-3 近战系红 / 4-6 魔法系紫 / 7-10 属性系橙 / 摔白）
      const hitType = b.hit.hitType;
      const color =
        hitType <= 3 ? 0xff5544 : hitType <= 6 ? 0xcc66ff : hitType <= 10 ? 0xffaa33 : 0xffffff;
      g.rect(ix, iy, b.w, b.h).fill({ color, alpha: 0.85 });
      // 尖端：朝 facing 方向的小三角指示
      const tipX = b.facing === 1 ? ix + b.w : ix;
      g.moveTo(tipX, iy + b.h / 2 - 5).lineTo(tipX + b.facing * 8, iy + b.h / 2).lineTo(tipX, iy + b.h / 2 + 5).fill({ color, alpha: 0.85 });
    }
  }

  /** 应用内层动画帧：查图集 form.frames[animFrame-1]。 */
  private applyFrame(sp: FighterSprite, animFrame: number): void {
    if (!sp.loaded) return;
    if (sp.appliedPng === animFrame) return;
    sp.appliedPng = animFrame;
    if (animFrame <= 0) {
      sp.body.visible = false;
      return;
    }
    const form = sp.loaded.atlas.forms[sp.formIndex];
    const frame = form?.frames[animFrame - 1];
    if (!frame || frame.png < 0) {
      sp.body.visible = false;
      return;
    }
    const tex = frameTexture(sp.loaded, frame.png);
    if (!tex) {
      sp.body.visible = false;
      return;
    }
    sp.body.visible = true;
    sp.body.texture = tex;
    // frame.x/y = 内容相对 root 原点偏移（root 原点 = 角色坐标，翻转绕原点）
    sp.body.position.set(frame.x ?? 0, frame.y ?? 0);
  }

  private updateCamera(snap: SimSnapshot): void {
    const fs = snap.state.fighters;
    if (fs.length === 0) return;
    const midX = fs.reduce((s, f) => s + f.x, 0) / fs.length;
    const midY = fs.reduce((s, f) => s + f.y, 0) / fs.length;
    // 指数平滑（帧率无关）
    const k = 1 - Math.exp(-8 * (1 / 60));
    this.camX += (midX - this.camX) * k;
    this.camY += (midY - this.camY) * k;
    this.zoom = Math.min(this.viewW / LOGICAL_W, this.viewH / LOGICAL_H);

    // 相机不进模拟（ADR-4）：纯渲染变换。按快照舞台边界 clamp（版边牵引的渲染面）。
    const st = snap.state.stage;
    const halfW = this.viewW / this.zoom / 2;
    const halfH = this.viewH / this.zoom / 2;
    const loX = st.leftBound + halfW;
    const hiX = st.rightBound - halfW;
    const cx = loX > hiX ? (st.leftBound + st.rightBound) / 2 : Math.min(Math.max(this.camX, loX), hiX);
    // 垂直：地面附近为锚，跳起最多上移 260（避免脱离地图）
    const cy = Math.min(Math.max(this.camY, st.groundY - 260), st.groundY);
    this.world.scale.set(this.zoom);
    this.world.position.set(this.viewW / 2 - cx * this.zoom, this.viewH / 2 - cy * this.zoom);
  }

  private hudGfx: Graphics | null = null;

  private updateHud(snap: SimSnapshot): void {
    if (!this.hudGfx) {
      this.hudGfx = new Graphics();
      this.hudLayer.addChild(this.hudGfx);
    }
    const g = this.hudGfx;
    g.clear();
    // 屏幕空间固定 HUD：血条 + 气 + 回合计数
    const pad = 24;
    const barW = 340;
    const fs = snap.state.fighters;
    fs.forEach((f, idx) => {
      const left = idx === 0;
      const x0 = left ? pad : this.viewW - pad - barW;
      const y0 = pad + idx * 44;
      const hpRatio = Math.max(0, f.hp / 1000);
      const qiRatio = Math.min(1, f.qi / 300);
      // 底
      g.rect(x0, y0, barW, 14).fill(0x000000, 0.45);
      g.rect(x0 + 2, y0 + 2, (barW - 4) * hpRatio, 10).fill(left ? 0x4fc3f7 : 0xff7043, 1);
      g.rect(x0, y0 + 18, barW * 0.6, 6).fill(0x000000, 0.45);
      g.rect(x0 + 1, y0 + 19, (barW * 0.6 - 2) * qiRatio, 4).fill(0xffd54f, 1);
    });
    const m = snap.state.match;
    g.rect(this.viewW / 2 - 60, pad, 120, 26).fill(0x000000, 0.5);
    if (!this.roundText) {
      this.roundText = new Text('', { fontFamily: 'monospace', fontSize: 18, fill: 0xffffff });
      this.roundText.anchor.set(0.5);
      this.roundText.position.set(this.viewW / 2, pad + 13);
      this.hudLayer.addChild(this.roundText);
    }
    this.roundText.text = `R${m.round}  ${m.p1Wins} - ${m.p2Wins}`;
    this.roundText.visible = true;
  }

  /** 装配方（app）可选：屏幕底部按键提示。 */
  setHint(text: string): void {
    if (!this.hintText) {
      this.hintText = new Text('', { fontFamily: 'monospace', fontSize: 13, fill: 0x9aa0b0 });
      this.hintText.anchor.set(0.5, 1);
      this.hintText.position.set(this.viewW / 2, this.viewH - 8);
      this.hudLayer.addChild(this.hintText);
    }
    this.hintText.text = text;
  }
}
