/**
 * 挂身持续特效（自 renderer.ts 拆出，纯搬移）：
 *   - ShadowFx：残影（切片 47，原版 ShadowEffectView）；
 *   - SpecialFx：specialEffectId 持续挂身特效（切片 50，原版 SpecialEffectView）；
 *   - BuffAuraFx：buff 持续挂身光环（切片 51，原版 BuffEffectView）；
 *   - GlowFx：钢身发光克隆（切片 51，原版 GlowFilter/BitmapFilterView）。
 * 共同特征：状态挂在角色 id 上，靠快照差分巡检收尾（不经 core）。
 */
import { Container, Sprite, Texture } from 'pixi.js';
import { GlowFilter } from 'pixi-filters';
import { ActionState, type SimSnapshot } from '@bvn/core';
import { colorOffsetFilterOf, type FxCtx } from '../fx-ctx.js';
import type { FighterSprite } from '../types.js';

export class ShadowFx {
  /** 残影（切片 47，原版 ShadowEffectView）：key = `${ownerKind}:${id}`；
   *  r/g/b 为原版 ColorTransform 加色偏移（非 0 时挂 ColorMatrixFilter 近似）。
   *  停止条件 = endShadow 事件 / 角色快照 actionState 变化（原版 doAction/idle/
   *  doHurt 统一 endShadow 的渲染层近似——激活态不进 core，纯表现）。 */
  private states = new Map<string, { r: number; g: number; b: number }>();
  /** 残影快照序列（30Hz 步进：每 2 步拍一帧，alpha 0.8 起步每步 -0.1，≤0 移除） */
  private ghosts: { root: Container; alpha: number }[] = [];
  private accMs = 0;
  private step = 0;

  constructor(private ctx: FxCtx) {}

  /** 残影开始（切片 47，原版 FighterEffectCtrler.shadow → ShadowEffectView：
   *  每特效帧截图留影，r/g/b = ColorTransform 加色偏移）。 */
  start(key: string, st: { r: number; g: number; b: number }): void {
    this.states.set(key, st);
  }

  stop(key: string): void {
    this.states.delete(key);
  }

  /** 无 owner 旧事件兜底：全停 */
  stopAll(): void {
    this.states.clear();
  }

  /** 残影自动清除（切片 47）：原版 FighterMcCtrler.doAction/idle/doHurt 统一
   *  endShadow——渲染层近似 = 角色 actionState 变化即停（先清后消费事件，
   *  同拍「清 + 重开」顺序与原版一致）。辅助无 actionState，仅靠显式 endShadow。 */
  prescan(snap: SimSnapshot, prev: SimSnapshot): void {
    for (const f of snap.state.fighters) {
      const p = prev.state.fighters.find((x) => x.id === f.id);
      if (p && p.actionState !== f.actionState) {
        this.states.delete(`fighter:${f.id}`);
      }
    }
  }

  /**
   * 残影步进（切片 47，原版 ShadowEffectView.render 30Hz）：
   *   - 拍照：每 2 个特效帧拍一帧（_addBpGap=1 → addBpFrame++ > 1），快照 = 角色
   *     精灵当前帧（body 贴图 + 帧位 + 朝向缩放；blendMode 子层 parts 不拍——
   *     残影语料均为本体动作，近似成立）；
   *   - 衰减：每步 alpha −0.1（_alphaLose），起步 0.8（_alphaStart）→ 存活 8 步
   *     ≈ 267ms，与原版同步；≤0 移除。
   * 加色偏移（ColorTransform redOffset/greenOffset/blueOffset）用 ColorMatrixFilter
   * 第 5 列加法近似，同色共享一个滤镜实例。
   */
  update(dtMs: number, next: SimSnapshot): void {
    this.accMs += dtMs;
    const steps = Math.min(Math.floor(this.accMs / (1000 / 30)), 4);
    if (steps <= 0) return;
    this.accMs -= steps * (1000 / 30);
    this.step += steps;
    // 衰减存量残影
    const dead: number[] = [];
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const gh = this.ghosts[i]!;
      gh.alpha -= 0.1 * steps;
      gh.root.alpha = Math.max(gh.alpha, 0);
      if (gh.alpha <= 0) dead.push(i);
    }
    for (const i of dead) {
      const gh = this.ghosts[i]!;
      this.ctx.shadowLayer.removeChild(gh.root);
      gh.root.destroy({ children: true });
    }
    if (dead.length > 0) this.ghosts = this.ghosts.filter((_, i) => !dead.includes(i));
    // 拍照（每 2 特效帧）
    if (this.step % 2 === 0) {
      for (const [key, st] of this.states) {
        const sp = this.targetOf(key, next);
        if (!sp || !sp.root.visible || !sp.body.visible) continue;
        const root = new Container();
        const body = new Sprite(sp.body.texture);
        body.position.set(sp.body.x, sp.body.y);
        root.addChild(body);
        root.position.set(sp.root.x, sp.root.y);
        root.scale.set(sp.root.scale.x, sp.root.scale.y);
        root.alpha = 0.8;
        const filter = colorOffsetFilterOf(this.ctx, st);
        if (filter) {
          root.filters = [filter];
          filter.enabled = true;
        }
        this.ctx.shadowLayer.addChild(root);
        this.ghosts.push({ root, alpha: 0.8 });
        // 拍照卡上限（原版存活 ~4 张；卡帧堆积防御）
        while (this.ghosts.length > 24) {
          const old = this.ghosts.shift()!;
          this.ctx.shadowLayer.removeChild(old.root);
          old.root.destroy({ children: true });
        }
      }
    }
    // 辅助退场清理（快照缺席即停残影）
    for (const key of this.states.keys()) {
      if (key.startsWith('assister:') && !this.targetOf(key, next)) {
        this.states.delete(key);
      }
    }
  }

  /** 残影 key → 目标精灵（fighter:<id> / assister:<assisterId>）。 */
  private targetOf(key: string, next: SimSnapshot): FighterSprite | null {
    const colon = key.indexOf(':');
    const kind = key.slice(0, colon);
    const id = Number(key.slice(colon + 1));
    if (kind === 'fighter') return this.ctx.sprites.get(id) ?? null;
    const a = next.state.assisters.find((x) => x.id === id);
    return a ? (this.ctx.assistSprites.get(a.ownerId) ?? null) : null;
  }

  dispose(): void {
    for (const gh of this.ghosts) gh.root.destroy({ children: true });
    this.ghosts = [];
    this.states.clear();
  }
}

export class SpecialFx {
  /** 持续挂身特效（原版 SpecialEffectView）：key = 受击者 fighter id。单槽，
   *  后到覆盖（原版可叠多层且 resumeColor 先到先清——简化偏离登记）。
   *  触发/收尾判定全在渲染层（快照 actionState 派生，切片 47 残影范式，不进
   *  core）；finishing 后位置冻结（原版 _finished 停 setPos）、动画播尽自移除。
   *  frame = 0-based 缓存帧号；labels 为 1-based 帧号 → 标签（loop/finish 回跳
   *  与跳转沿用原版 EffectView 0/1 基错位语义：gotoAndPlay 标签帧号直接当
   *  缓存下标，loop 检查用 0-based 下标查 1-based 键表）。 */
  private fx = new Map<
    number,
    {
      root: Container;
      body: Sprite;
      texs: Texture[];
      /** label → 1-based 帧（finish 跳段查表） */
      labels: Record<string, number>;
      /** 1-based 帧 → label（loop 回跳查表，烘焙 labels 的逆转） */
      frameLabels: Record<number, string>;
      frame: number;
      accMs: number;
      finishing: boolean;
    }
  >();

  constructor(private ctx: FxCtx) {}

  /**
   * 持续挂身特效（原版 doSpecialEffect → SpecialEffectView.start）：
   * MC 原点钉受击者脚下（后续每帧跟随），ADD 混合，30fps 循环段播放；
   * 同时打 targetColorOffset 色调（原版 setTarget → changeColor）。
   */
  attach(fighterId: number, mcId: string): void {
    const eff = this.ctx.assets.hitspark?.effects[mcId];
    const texs = this.ctx.assets.sparkTex.get(mcId);
    const sp = this.ctx.sprites.get(fighterId);
    if (!eff || !texs || texs.length === 0 || !sp) return;
    this.remove(fighterId); // 单槽覆盖（偏离登记：原版可叠多层）
    const root = new Container();
    const body = new Sprite(texs[0]!);
    body.blendMode = 'add';
    root.addChild(body);
    body.position.set(eff.origin[0], eff.origin[1]);
    this.ctx.fxLayer.addChild(root);
    const frameLabels: Record<number, string> = {};
    for (const [label, fr] of Object.entries(eff.labels ?? {})) frameLabels[fr] = label;
    this.fx.set(fighterId, {
      root,
      body,
      texs,
      labels: eff.labels ?? {},
      frameLabels,
      frame: 0,
      accMs: 0,
      finishing: false,
    });
    const [r = 0, g = 0, b = 0] = eff.colorOffset ?? [];
    const filter = colorOffsetFilterOf(this.ctx, { r, g, b });
    sp.root.filters = filter ? [filter] : [];
  }

  /** 持续挂身特效收尾判定（原版 SpecialEffectView.render）：目标回
   *  NORMAL/HURT_DOWN/HURT_DOWN_TAN（弹起态同原版 24，切片 54 补齐）
   *  → 转 finish 段 + resumeColor；目标快照缺席（团队 bench 下场）→ 即刻移除。
   *  先清后消费事件：同拍「收尾 + 重挂」顺序与原版一致。 */
  prescan(snap: SimSnapshot): void {
    for (const [fid, fx] of this.fx) {
      const f = snap.state.fighters.find((x) => x.id === fid);
      if (!f) {
        this.remove(fid);
      } else if (
        !fx.finishing &&
        (f.actionState === ActionState.NORMAL ||
          f.actionState === ActionState.HURT_DOWN ||
          f.actionState === ActionState.HURT_DOWN_TAN)
      ) {
        this.finish(fid);
      }
    }
  }

  /**
   * 挂身特效帧推进（原版 EffectCtrler.render 60fps 跟随 + renderAnimate 30fps
   * 帧进的合成）：未收尾时容器钉目标精灵当前位置（插值后）；帧进镜像
   * EffectView.renderAnimate——播到末缓存帧（autoRemove，末帧不缓存）自移除，
   * loop 标签回跳帧 2（gotoAndPlay(1) 错位语义原样保留），收尾段播尽自然清除。
   */
  update(dtMs: number, next: SimSnapshot): void {
    for (const [fid, fx] of this.fx) {
      if (!fx.finishing) {
        const f = next.state.fighters.find((x) => x.id === fid);
        const sp = f !== undefined ? this.ctx.sprites.get(fid) : undefined;
        if (f !== undefined && sp !== undefined) fx.root.position.set(sp.root.x, sp.root.y);
      }
      fx.accMs += dtMs;
      const steps = Math.floor(fx.accMs / (1000 / 30));
      if (steps <= 0) continue;
      fx.accMs -= steps * (1000 / 30);
      for (let i = 0; i < steps; i++) {
        if (fx.frame >= fx.texs.length - 1) {
          this.remove(fid);
          break;
        }
        if (fx.frameLabels[fx.frame] === 'loop') fx.frame = 1;
        fx.body.texture = fx.texs[fx.frame]!;
        fx.frame++;
      }
    }
  }

  /** 收尾转段（原版 render 检出 NORMAL/HURT_DOWN → gotoAndPlay("finish") +
   *  resumeColor）：播放头按原版 0/1 基错位语义跳标签帧号，位置自此冻结。 */
  private finish(fighterId: number): void {
    const fx = this.fx.get(fighterId);
    if (!fx || fx.finishing) return;
    fx.finishing = true;
    const fin = fx.labels['finish'];
    if (fin !== undefined) fx.frame = fin;
    const sp = this.ctx.sprites.get(fighterId);
    if (sp) sp.root.filters = [];
  }

  /** 移除挂身特效（重复挂载替换 / 目标下场 / 播尽自移除共用；色调一并还原）。 */
  private remove(fighterId: number): void {
    const fx = this.fx.get(fighterId);
    if (!fx) return;
    this.ctx.fxLayer.removeChild(fx.root);
    fx.root.destroy({ children: true });
    this.fx.delete(fighterId);
    const sp = this.ctx.sprites.get(fighterId);
    if (sp) sp.root.filters = [];
  }

  dispose(): void {
    for (const [fid] of this.fx) this.remove(fid);
  }
}

export class BuffAuraFx {
  /** buff 持续挂身光环（切片 51，原版 doBuffEffect → BuffEffectView）：
   *  key = `${fighterId}:${kind}`（kind speed/power/defense）。单实例去重
   *  （偏离登记：原版重复施加叠加多个光环实例——共享 FighterBuffVO 使旧光环
   *  不随刷新移除，视觉叠积视为缺陷）；熄灭判定 = 渲染层快照 buffs 差分
   *  （原版 render 检出 buff.finished || !isAlive 移除）。loopPlay 全时间轴
   *  30fps 循环（末缓存帧跳过，同 EffectView._bitmapDatas 语义），每帧跟随
   *  角色位置；direct = 施加时角色朝向（原版 start 钉死，不随转向重镜像）。 */
  private auras = new Map<
    string,
    {
      fighterId: number;
      /** SimState.buffs 键（speed→speedUp 等，熄灭差分查表） */
      buffKey: 'speedUp' | 'attackUp' | 'defenseUp';
      root: Container;
      body: Sprite;
      texs: Texture[];
      frame: number;
      accMs: number;
    }
  >();

  constructor(private ctx: FxCtx) {}

  /** buff 光环挂身（切片 51，原版 doBuffEffect → BuffEffectView.start）：
   *  MC 原点钉角色脚下（后续每帧跟随），ADD 混合，direct = 施加时朝向。 */
  attach(fighterId: number, kind: 'speed' | 'power' | 'defense', snap: SimSnapshot): void {
    const mcId = `buff_${kind}`;
    const eff = this.ctx.assets.hitspark?.effects[mcId];
    const texs = this.ctx.assets.sparkTex.get(mcId);
    const sp = this.ctx.sprites.get(fighterId);
    if (!eff || !texs || texs.length === 0 || !sp) return;
    const key = `${fighterId}:${kind}`;
    this.remove(key); // 单实例去重（偏离登记：原版可叠加重复光环）
    const root = new Container();
    const body = new Sprite(texs[0]!);
    body.blendMode = 'add';
    root.addChild(body);
    body.position.set(eff.origin[0], eff.origin[1]);
    const f = snap.state.fighters.find((x) => x.id === fighterId);
    root.scale.x = f && f.facing < 0 ? -1 : 1;
    this.ctx.fxLayer.addChild(root);
    this.auras.set(key, {
      fighterId,
      buffKey: kind === 'speed' ? 'speedUp' : kind === 'power' ? 'attackUp' : 'defenseUp',
      root,
      body,
      texs,
      frame: 0,
      accMs: 0,
    });
  }

  /** buff 光环熄灭巡检（切片 51，原版 BuffEffectView.render：buff.finished ||
   *  !isAlive 移除）：buff 计满熄灭 / 角色死亡 / 团队下场（快照缺席）→ 移除。 */
  prescan(snap: SimSnapshot): void {
    for (const [key, aura] of this.auras) {
      const f = snap.state.fighters.find((x) => x.id === aura.fighterId);
      if (f === undefined || f.hp <= 0 || f.buffs[aura.buffKey] === null) {
        this.remove(key);
      }
    }
  }

  /** buff 光环帧推进（原版 EffectCtrler.render 60fps 跟随 + renderAnimate 30fps
   *  帧进合成）：容器钉角色当前位置；loopPlay 语义 = 播到末缓存帧回卷
   *  （EffectView.renderAnimate：_curFrame == length−1 → 0，末帧不显示）。 */
  update(dtMs: number): void {
    for (const aura of this.auras.values()) {
      const sp = this.ctx.sprites.get(aura.fighterId);
      if (sp) aura.root.position.set(sp.root.x, sp.root.y);
      aura.accMs += dtMs;
      const steps = Math.floor(aura.accMs / (1000 / 30));
      if (steps <= 0) continue;
      aura.accMs -= steps * (1000 / 30);
      for (let i = 0; i < steps; i++) {
        if (aura.frame >= aura.texs.length - 1) aura.frame = 0;
        aura.body.texture = aura.texs[aura.frame]!;
        aura.frame++;
      }
    }
  }

  /** 移除 buff 光环（重复施加去重 / 快照巡检熄灭共用）。 */
  private remove(key: string): void {
    const aura = this.auras.get(key);
    if (!aura) return;
    this.ctx.fxLayer.removeChild(aura.root);
    aura.root.destroy({ children: true });
    this.auras.delete(key);
  }

  dispose(): void {
    for (const key of [...this.auras.keys()]) this.remove(key);
  }
}

export class GlowFx {
  /** 钢身发光（切片 51，原版 FighterMcCtrler.setSteelBody → startGlow/endGlow）：
   *  colors = startGlow 事件最近颜色（isSuper ? 0xFFFF00 : 0xFFFFFF）；
   *  开关态 = 快照 steelBody 差分（endActAction 等 sim 静默清钢身不发事件，
   *  纯事件驱动会漏灭灯）。实现 = 发光克隆精灵（原版 BitmapFilterView：每帧
   *  把角色显示对象经滤镜重绘成独立 knockout 位图垫在角色之下——port 以
   *  同纹理克隆 + GlowFilter 置角色层之下等价，本体像素被角色覆盖只露光环；
   *  parts 混合子层不克隆，近似偏离）。 */
  private colors = new Map<number, number>();
  private fx = new Map<number, { root: Container; body: Sprite }>();
  private filterCache = new Map<number, GlowFilter>();

  constructor(private ctx: FxCtx) {}

  /** 钢身发光颜色（切片 51，原版 setSteelBody → startGlow/endGlow）：
   *  事件只携色（isSuper → 黄 0xFFFF00，原版 FighterMcCtrler setSteelBody
   *  isSuper 分支），开关态由快照 steelBody 差分巡检统一处理。 */
  setColor(fighter: number, color: number): void {
    this.colors.set(fighter, color);
  }

  clearColor(fighter: number): void {
    this.colors.delete(fighter);
  }

  /** 钢身发光开关巡检（切片 51）：开关态以快照 steelBody 为准（sim 静默清钢身
   *  不发事件），颜色取 startGlow 事件最近值；快照缺席（下场）清灯。 */
  prescan(snap: SimSnapshot): void {
    for (const f of snap.state.fighters) {
      this.apply(f.id, f.steelBody ? (this.colors.get(f.id) ?? 0xffffff) : null);
    }
    for (const fid of [...this.fx.keys()]) {
      if (!snap.state.fighters.some((x) => x.id === fid)) this.apply(fid, null);
    }
  }

  /** 钢身发光开关（切片 51）：克隆精灵垫 shadowLayer（角色层之下——本体像素与
   *  角色逐帧重合被盖住，仅露 GlowFilter 光环，等价原版 BitmapFilterView knockout
   *  独立位图）；color null = 熄灭。滤镜按色缓存复用。 */
  private apply(fighterId: number, color: number | null): void {
    const cur = this.fx.get(fighterId);
    if (color === null) {
      if (cur === undefined) return;
      cur.root.destroy({ children: true });
      this.fx.delete(fighterId);
      return;
    }
    if (cur !== undefined) {
      const filter = cur.body.filters?.[0] as GlowFilter | undefined;
      if (filter && filter.color === color) return;
      cur.root.destroy({ children: true });
      this.fx.delete(fighterId);
    }
    const root = new Container();
    const body = new Sprite(Texture.WHITE);
    body.visible = false;
    root.addChild(body);
    let filter = this.filterCache.get(color);
    if (!filter) {
      // 原版 GlowFilter(color, 1, blur 20×20, strength 2, quality 1, knockout)
      filter = new GlowFilter({
        distance: 20,
        outerStrength: 2,
        innerStrength: 0,
        color,
        quality: 1,
      });
      this.filterCache.set(color, filter);
    }
    body.filters = [filter];
    this.ctx.shadowLayer.addChild(root);
    this.fx.set(fighterId, { root, body });
  }

  /** 钢身发光克隆帧同步（每渲染帧）：位置/朝向/纹理/帧位镜像角色精灵当前态。 */
  update(): void {
    for (const [fid, g] of this.fx) {
      const sp = this.ctx.sprites.get(fid);
      if (!sp) continue;
      g.root.position.set(sp.root.x, sp.root.y);
      g.root.scale.set(sp.root.scale.x, sp.root.scale.y);
      g.body.visible = sp.body.visible;
      if (sp.body.visible) {
        g.body.texture = sp.body.texture;
        g.body.position.set(sp.body.x, sp.body.y);
      }
    }
  }

  dispose(): void {
    for (const [fid] of this.fx) this.apply(fid, null);
    this.colors.clear();
    this.filterCache.clear();
  }
}
