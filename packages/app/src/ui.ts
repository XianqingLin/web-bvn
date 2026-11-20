/**
 * 极简 UI 组件（切片 14 骨架用；演出细节后补）。
 * 坐标系 = 1000×600 逻辑屏（UIHost 统一缩放）；中文用系统字体。
 */
import { Container, Graphics, Text } from 'pixi.js';

export const UI_W = 1000;
export const UI_H = 600;

/**
 * 已选面板大脸遮罩（selected_p1/p2.webp 外形实测，253×70）：框不是矩形——
 * 右上（P1）/ 左上（P2，纹理自带镜像内容）斜切造型，245×62 矩形大脸的角
 * 会从斜切口漏出去。多边形 = 框外接轮廓（含边框带无妨：框绘制在大脸之上，
 * 遮罩多含的部分被框像素覆盖）。
 */
export function selectedFaceMask(isP2: boolean): Graphics {
  const g = new Graphics();
  if (isP2) {
    g.poly([34, 3, 3, 29, 3, 67, 249, 67, 249, 3]).fill(0xffffff);
  } else {
    g.poly([3, 3, 219, 3, 249, 29, 249, 67, 3, 67]).fill(0xffffff);
  }
  return g;
}

export function makeLabel(
  text: string,
  opts: { size?: number; color?: number; bold?: boolean } = {},
): Text {
  return new Text(text, {
    fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
    fontSize: opts.size ?? 16,
    fill: opts.color ?? 0xd8dce6,
    fontWeight: opts.bold ? '700' : '400',
  });
}

export function makePanel(w: number, h: number, opts: { color?: number; alpha?: number } = {}): Graphics {
  const g = new Graphics();
  g.rect(0, 0, w, h).fill({ color: opts.color ?? 0x1a2030, alpha: opts.alpha ?? 0.92 });
  g.stroke({ width: 1, color: 0x3a4a66 }).rect(0.5, 0.5, w - 1, h - 1);
  return g;
}

/** 文字按钮：hover 提亮 + 点击回调；返回容器（可置 .disabled）。 */
export interface Button extends Container {
  disabled: boolean;
}

export function makeButton(
  label: string,
  onClick: () => void,
  opts: { w?: number; h?: number; size?: number; color?: number } = {},
): Button {
  const w = opts.w ?? 180;
  const h = opts.h ?? 44;
  const c = new Container() as Button;
  const bg = new Graphics();
  const draw = (fill: number) => {
    bg.clear();
    bg.rect(0, 0, w, h).fill({ color: fill, alpha: 0.95 });
    bg.stroke({ width: 1, color: 0x5a7aa6 }).rect(0.5, 0.5, w - 1, h - 1);
  };
  draw(opts.color ?? 0x24344e);
  const t = makeLabel(label, { size: opts.size ?? 18, color: 0xffffff });
  t.anchor.set(0.5);
  t.position.set(w / 2, h / 2);
  c.addChild(bg, t);
  c.eventMode = 'static';
  c.cursor = 'pointer';
  let disabled = false;
  Object.defineProperty(c, 'disabled', {
    get: () => disabled,
    set: (v: boolean) => {
      disabled = v;
      c.eventMode = v ? 'none' : 'static';
      c.cursor = v ? 'default' : 'pointer';
      t.alpha = v ? 0.4 : 1;
      bg.alpha = v ? 0.5 : 1;
    },
  });
  c.on('pointerover', () => !disabled && draw(0x34527e));
  c.on('pointerout', () => !disabled && draw(opts.color ?? 0x24344e));
  c.on('pointertap', () => !disabled && onClick());
  return c;
}

/**
 * DOM 文本输入浮层（联机页服务器地址/房间码用）。
 * Pixi 无内建输入框；用绝对定位 <input> 覆盖在画布上，带压暗遮罩 + 游戏风格描边
 * （切片 29 UI 打磨池：DOM 输入样式）。resolve 后整组移除。
 */
export function domInput(
  host: HTMLElement,
  placeholder: string,
  initial: string,
): { element: HTMLInputElement; done: Promise<string> } {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:absolute;inset:0;background:rgba(4,8,16,.55);z-index:19;';
  const el = document.createElement('input');
  el.type = 'text';
  el.placeholder = placeholder;
  el.value = initial;
  el.style.cssText =
    'position:absolute;left:50%;top:46%;transform:translate(-50%,-50%);width:340px;' +
    'padding:12px 16px;font:16px monospace;color:#e8ecf4;color-scheme:dark;text-align:center;' +
    'background:#0d1420;border:2px solid #5a7aa6;border-radius:8px;outline:none;z-index:20;' +
    'box-shadow:0 4px 24px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.05);' +
    'transition:border-color .15s;';
  el.addEventListener('focus', () => {
    el.style.borderColor = '#7ea0d4';
  });
  el.addEventListener('blur', () => {
    el.style.borderColor = '#5a7aa6';
  });
  wrap.appendChild(el);
  host.appendChild(wrap);
  el.focus();
  const done = new Promise<string>((res) => {
    // 完成守卫：wrap.remove() 会同步引发 blur，finish 被重入时不得再次
    // remove（Chrome 会对半分离节点抛 NotFoundError）或重复 res。
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      wrap.remove();
      res(el.value.trim());
    };
    el.addEventListener('keydown', (e) => {
      e.stopPropagation(); // 防止 WASD 等泄漏进键盘采集
      if (e.key === 'Enter' || e.key === 'Escape') finish();
    });
    el.addEventListener('blur', finish);
  });
  return { element: el, done };
}
