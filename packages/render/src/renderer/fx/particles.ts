/**
 * 一次性特效管线（自 renderer.ts 拆出，纯搬移）：
 *   - ShineFx：全屏色闪（原版 ShineEffectView）；
 *   - McEffectFx：必杀光效 mc 流帧（切片 26，原版 EffectView）；
 *   - SparkFx：命中/防御火花与通用控制器特效（修复批次 35，
 *     原版 EffectCtrler 分流），挂载/震屏等派生调用经构造注入的兄弟模块。
 * 共同特征：生成即忘，30fps/15fps 播尽自移除。
 */
import { Container, Sprite, Texture } from 'pixi.js';
import type { FxCtx } from '../fx-ctx.js';
import type { ShakeFx } from './shake.js';
import type { SpecialFx } from './attached.js';

/** 全屏闪（原版 shine(color, alpha) → ShineEffectView：亮色 ADD / 暗色 DARKEN
 *  且 alpha×0.8，色块覆盖 gameStage）。 */
export class ShineFx {
  /** 全屏闪（原版 ShineEffectView：ADD 色块，15fps 衰减 5%，≤5% 移除） */
  private shines: { sp: Sprite; alpha: number; accMs: number }[] = [];

  constructor(private ctx: FxCtx) {}

  spawn(color: number, alpha: number): void {
    const sp = new Sprite(Texture.WHITE);
    sp.width = this.ctx.viewW;
    sp.height = this.ctx.viewH;
    sp.tint = color;
    if (color > 0x7fffff) {
      sp.blendMode = 'add';
    } else {
      sp.blendMode = 'darken';
      alpha *= 0.8;
    }
    sp.alpha = alpha;
    this.ctx.shineLayer.addChild(sp);
    this.shines.push({ sp, alpha, accMs: 0 });
  }

  /** 闪衰减（原版 ShineEffectView：FPS_GAME 60 / FPS_SHINE 15 → renderGap=3，
   *  每步线性 _loseAlpha=renderGap+1=0.04（100 刻度），alpha ≤0.05 移除，约 0.46s 淡出）。
   *  修正（2026-11-19）：此前误用 ×0.95 指数衰减（约 2.5s 淡出）——亮屏滞留远超原版。 */
  update(dtMs: number): void {
    const STEP_MS = 1000 / 15;
    for (const s of this.shines) {
      s.accMs += dtMs;
      while (s.accMs >= STEP_MS) {
        s.accMs -= STEP_MS;
        s.alpha -= 0.04;
      }
      s.sp.alpha = Math.max(s.alpha, 0);
    }
    const done = this.shines.filter((s) => s.alpha <= 0.05);
    for (const s of done) {
      this.ctx.shineLayer.removeChild(s.sp);
      s.sp.destroy();
    }
    if (done.length > 0) this.shines = this.shines.filter((s) => !done.includes(s));
  }
}

/** mc 流帧特效（切片 26，原版 EffectView）：加色混合，30fps 播尽自移除；
 *  direct 恒 1（doEffectById 缺省参，XG_bs/XG_cbs 不镜像）。 */
export class McEffectFx {
  /** 在播 mc 特效视图（原版 EffectView：direct 恒 1、加色混合、30fps 播尽自移除） */
  private effects: {
    root: Container;
    body: Sprite;
    texs: Texture[];
    fps: number;
    accMs: number;
    frame: number;
  }[] = [];

  constructor(private ctx: FxCtx) {}

  spawn(id: string, x: number, y: number): void {
    const spec = this.ctx.assets.bishaEffects[id];
    const texs = this.ctx.assets.effectTex.get(id);
    if (!spec || !texs || texs.length === 0) return;
    const root = new Container();
    const body = new Sprite(texs[0]);
    body.blendMode = 'add';
    root.addChild(body);
    root.position.set(x + spec.origin[0], y + spec.origin[1]);
    this.ctx.fxLayer.addChild(root);
    this.effects.push({ root, body, texs, fps: spec.fps, accMs: 0, frame: 0 });
  }

  /** mc 特效帧推进（30fps）+ 播尽移除。 */
  update(dtMs: number): void {
    for (const e of this.effects) {
      e.accMs += dtMs;
      const f = Math.floor(e.accMs / (1000 / e.fps));
      if (f >= e.texs.length) continue;
      if (f !== e.frame) {
        e.frame = f;
        e.body.texture = e.texs[f]!;
      }
    }
    const done = this.effects.filter((e) => Math.floor(e.accMs / (1000 / e.fps)) >= e.texs.length);
    for (const e of done) {
      this.ctx.fxLayer.removeChild(e.root);
      e.root.destroy({ children: true });
    }
    if (done.length > 0) this.effects = this.effects.filter((e) => !done.includes(e));
  }

  dispose(): void {
    for (const e of this.effects) e.root.destroy({ children: true });
    this.effects = [];
  }
}

export class SparkFx {
  /** 命中火花（修复批次 35）：baked 表 + 预载纹理经 FxCtx.assets 现读；
   *  火花视图（30fps 播尽自移除） */
  private sparkFx: { root: Container; body: Sprite; texs: Texture[]; accMs: number; frame: number }[] =
    [];
  /** 已告警特效 id（spawnById 缺件告警去重；load 重建时清空重警） */
  private warned = new Set<string>();

  constructor(
    private ctx: FxCtx,
    private deps: { special: SpecialFx; shines: ShineFx; shake: ShakeFx },
  ) {}

  /**
   * 命中火花（修复批次 35，镜像原版 EffectCtrler 分流；随机项全部在渲染层，
   * 不触碰 sim 确定性）：钢身族随机择一 → 破防横抖 → 防御竖抖 → 普通命中。
   * 原版 quirk 保留：命中系 VO 的 shake{pow:6} 是 doEffectVO 死代码（只读
   * shake.x/y），命中火花不抖；仅防御（pow→y）与破防（x）抖。
   */
  spawnHitSpark(p: Record<string, unknown>): void {
    const hk = this.ctx.assets.hitspark;
    if (!hk) return;
    const sparkType = Number(p['sparkType'] ?? p['hitType'] ?? 0);
    const x = Number(p['x'] ?? 0);
    const y = Number(p['y'] ?? 0);
    const direct = Number(p['direct'] ?? 1) >= 0 ? 1 : -1;
    let id: string | null = null;
    let shake: { x?: number; y?: number; time?: number } | null = null;
    if (p['steel'] === true) {
      // 钢身族（doSteelHitEffect：KAN/KAN_HEAVY→kan、DA/DA_HEAVY→qdj、其余→mfdj；
      // 族内随机择一，hitType 0 无钢身特效）
      const fam =
        sparkType === 1 || sparkType === 6
          ? 'kan'
          : sparkType === 2 || sparkType === 3
            ? 'qdj'
            : 'mfdj';
      const list = hk.steel[fam] ?? [];
      id = sparkType !== 0 && list.length > 0 ? list[Math.floor(Math.random() * list.length)]! : null;
    } else if (p['breakDef'] === true) {
      id = hk.breakDef.id;
      shake = hk.breakDef.shake;
    } else if (p['blocked'] === true) {
      // 防御表回退 defense_5（原版 getDefenseEffect 缺表项；core freeze 表同源）
      id = hk.defense.byType[String(sparkType)] ?? hk.defense.fallback;
      if (id) shake = { y: hk.shake.defense.pow, time: hk.shake.defense.time };
    } else {
      // 普通命中表：type 0/10 无表项 = 无特效不抖（原版 getHitEffect 无回退）
      id = hk.hit.byType[String(sparkType)] ?? null;
      // specialEffectId 持续挂身特效（原版 doEffectVO：effect.specialEffectId &&
      // target is FighterMain → doSpecialEffect 挂受击者持续）：仅未防御路径，
      // 按 hitType 直查（防御转换 sparkType 不参与，防御/钢身表无 specialEffectId）
      const target = p['target'];
      const sid =
        typeof target === 'number' ? hk.special?.byType[String(p['hitType'] ?? sparkType)] : undefined;
      if (typeof target === 'number' && sid !== undefined) this.deps.special.attach(target, sid);
    }
    // id = null（type 0/10 无特效）静默；id 有值但表项缺失 → spawnById
    // 内部告警（不短路——切片 57 诊断链路），shine/shake 仍按表项存在才派生。
    if (id !== null) this.spawnById(id, x, y, direct);
    const eff = id !== null ? hk.effects[id] : null;
    if (eff?.shine) this.deps.shines.spawn(eff.shine.color, eff.shine.alpha);
    if (shake) this.deps.shake.doShake(shake.x ?? 0, shake.y ?? 0, shake.time ?? 0);
  }

  /**
   * 按烘焙 id 生成火花/尘土特效（命中分流与通用控制器特效共用管线）。
   * 纹理/表项缺失 = 静默告警（console.warn 每个 id 只警一次防逐帧刷屏），
   * 不中断演出管线——烘焙缺件不炸对局，目检期靠告警定位。
   */
  spawnById(id: string, x: number, y: number, direct: 1 | -1 = 1): void {
    const eff = this.ctx.assets.hitspark?.effects[id];
    if (!eff) {
      this.warnOnce(id, 'hitspark 表缺特效定义');
      return;
    }
    const texs = this.ctx.assets.sparkTex.get(id);
    if (!texs || texs.length === 0) {
      this.warnOnce(id, 'hitspark 纹理缺失');
      return;
    }
    const root = new Container();
    const body = new Sprite(texs[0]!);
    if (eff.blendMode === 'add') body.blendMode = 'add';
    else if (eff.blendMode === 'hardlight') body.blendMode = 'hard-light';
    else if (eff.blendMode === 'lighten') body.blendMode = 'lighten';
    root.addChild(body);
    // EffectView.start（切片 47 对齐原语义）：MC 原点钉命中点；非旋转件
    // display.scaleX = direct、display.x = orgX + offsetX×direct——父容器镜像
    // 自动翻转子位偏移（offset×direct 数学等价），randRotate 件 direct 恒 1。
    root.position.set(x, y);
    body.position.set(eff.origin[0], eff.origin[1]);
    if (eff.randRotate) root.rotation = Math.random() * Math.PI * 2;
    else root.scale.x = direct;
    this.ctx.fxLayer.addChild(root);
    this.sparkFx.push({ root, body, texs, accMs: 0, frame: 0 });
  }

  /** load 重建火花资源时清空告警记录（重新各警一次）。 */
  resetWarnings(): void {
    this.warned.clear();
  }

  private warnOnce(id: string, why: string): void {
    if (this.warned.has(id)) return;
    this.warned.add(id);
    console.warn(`[render] spawnSparkById: ${why} "${id}"（特效跳过）`);
  }

  /** 火花帧推进（30fps 播尽自移除，同 mc 流帧管线）。 */
  update(dtMs: number): void {
    for (const e of this.sparkFx) {
      e.accMs += dtMs;
      const f = Math.floor(e.accMs / (1000 / 30));
      if (f < e.texs.length && f !== e.frame) {
        e.frame = f;
        e.body.texture = e.texs[f]!;
      }
    }
    const done = this.sparkFx.filter((e) => Math.floor(e.accMs / (1000 / 30)) >= e.texs.length);
    for (const e of done) {
      this.ctx.fxLayer.removeChild(e.root);
      e.root.destroy({ children: true });
    }
    if (done.length > 0) this.sparkFx = this.sparkFx.filter((e) => !done.includes(e));
  }
}
