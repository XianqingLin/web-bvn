/**
 * 帧应用与占位绘制（自 renderer.ts 拆出，纯搬移）：
 * 角色/fire 元件的内层动画帧换纹理 + 混合模式子层 + 命中矩形色块回退。
 * 全部为无状态自由函数。
 */
import { Sprite, Texture } from 'pixi.js';
import type { Container, Graphics } from 'pixi.js';
import type { AtlasFramePart } from '@bvn/data';
import { frameTexture, type LoadedFireAtlas, type LoadedFighterAtlas } from '../atlas.js';
import { pixiBlendMode, type BulletSprite, type FighterSprite } from './types.js';

/** 色块回退（bullet 切片 8 / attacker 切片 13-A4 占位表现）：命中矩形 + 朝向尖端。 */
export function drawPropBlock(
  g: Graphics,
  facing: 1 | -1,
  w: number,
  h: number,
  hitType: number | null,
  ix: number,
  iy: number,
): void {
  // 颜色按 hitType 粗分（1-3 近战系红 / 4-6 魔法系紫 / 7-10 属性系橙 / 摔白；
  // null = 纯表现实体，青绿色）
  const color =
    hitType === null
      ? 0x44ddaa
      : hitType <= 3
        ? 0xff5544
        : hitType <= 6
          ? 0xcc66ff
          : hitType <= 10
            ? 0xffaa33
            : 0xffffff;
  g.rect(ix, iy, w, h).fill({ color, alpha: 0.85 });
  // 尖端：朝 facing 方向的小三角指示
  const tipX = facing === 1 ? ix + w : ix;
  g.moveTo(tipX, iy + h / 2 - 5).lineTo(tipX + facing * 8, iy + h / 2).lineTo(tipX, iy + h / 2 + 5).fill({ color, alpha: 0.85 });
}

/**
 * 混合模式子层（批次 37/70）：采集桥把 blendMode 元件拆出整帧合成，png 保存
 * "混合前源内容"（透明底采集 = 源不变），此处按 blend 值对场景混合。
 * 角色帧与 fire 帧共用本逻辑（后者此前漏接 = 弹幕黑底残留）。
 */
export function applyBlendParts(
  root: Container,
  arr: Sprite[],
  parts: AtlasFramePart[] | undefined,
  loaded: LoadedFighterAtlas | LoadedFireAtlas,
): void {
  if (!parts || parts.length === 0) {
    for (const s of arr) s.visible = false;
    return;
  }
  while (arr.length < parts.length) {
    const s = new Sprite(Texture.WHITE);
    s.visible = false;
    root.addChild(s);
    arr.push(s);
  }
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i]!;
    const part = parts[i];
    if (!part || part.png < 0) {
      s.visible = false;
      continue;
    }
    const ptex = frameTexture(loaded, part.png);
    if (!ptex) {
      s.visible = false;
      continue;
    }
    s.visible = true;
    s.texture = ptex;
    s.position.set(part.x ?? 0, part.y ?? 0);
    s.blendMode = pixiBlendMode(part.blend);
  }
}

/** 应用 fire 元件帧：查图集 fires[name].frames[animFrame-1]。 */
export function applyFireFrame(
  sp: BulletSprite,
  loaded: LoadedFireAtlas,
  name: string,
  animFrame: number,
): void {
  const el = loaded.atlas.fires[name];
  // 发射点实例 blendMode（批次 70）：原版 screen/add/lighten 等对场景消黑，
  // 采集隔离丢掉这层后黑底被烤进 base——渲染层补回来。每次都设（廉价），
  // 避免同 id 复用时残留上一次的混合模式。
  sp.body.blendMode = pixiBlendMode(el?.blend ?? 'normal');
  if (sp.appliedFrame === animFrame) return;
  sp.appliedFrame = animFrame;
  const frame = el?.frames[animFrame - 1];
  if (!frame || frame.png < 0) {
    sp.body.visible = false;
    applyBlendParts(sp.root, sp.parts, frame?.parts, loaded);
    return;
  }
  const tex = frameTexture(loaded, frame.png);
  if (!tex) {
    sp.body.visible = false;
    applyBlendParts(sp.root, sp.parts, frame.parts, loaded);
    return;
  }
  sp.body.visible = true;
  sp.body.texture = tex;
  // frame.x/y = 内容相对元件原点偏移（容器已按 facing 镜像）
  sp.body.position.set(frame.x ?? 0, frame.y ?? 0);
  applyBlendParts(sp.root, sp.parts, frame.parts, loaded);
}

/** 应用内层动画帧：查图集 form.frames[animFrame-1]。 */
export function applyFrame(sp: FighterSprite, animFrame: number): void {
  if (!sp.loaded) return;
  if (sp.appliedPng === animFrame) return;
  sp.appliedPng = animFrame;
  if (animFrame <= 0) {
    sp.body.visible = false;
    hideParts(sp);
    return;
  }
  const form = sp.loaded.atlas.forms[sp.formIndex];
  const frame = form?.frames[animFrame - 1];
  if (!frame || frame.png < 0) {
    sp.body.visible = false;
    hideParts(sp);
    if (!frame || !frame.parts?.length) return;
  } else {
    const tex = frameTexture(sp.loaded, frame.png);
    if (!tex) {
      sp.body.visible = false;
      hideParts(sp);
      return;
    }
    sp.body.visible = true;
    sp.body.texture = tex;
    // frame.x/y = 内容相对 root 原点偏移（root 原点 = 角色坐标，翻转绕原点）
    sp.body.position.set(frame.x ?? 0, frame.y ?? 0);
  }
  applyBlendParts(sp.root, sp.parts, frame.parts, sp.loaded);
}

export function hideParts(sp: FighterSprite): void {
  for (const s of sp.parts) s.visible = false;
}
