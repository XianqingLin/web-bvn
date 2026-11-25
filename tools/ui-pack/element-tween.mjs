/**
 * element-tween：叠加层元件内部时间轴的补间参数提取（Tier 2，DESIGN §4.8）。
 *
 * 适用形态（全断言，不满足即抛错回逐帧流）：元件（ui-pack 3a-bis mapFx / 3b title fx）
 * 内部时间轴 = **单一深度、单一内容子件（本 SWF 内单帧 shape/bitmap）**，逐帧仅
 * 改放置矩阵与 CXFORM——即「单贴图 + 内部摆动 + 色变换」可程序化重表达。
 *
 * Flash 时间轴语义：move-only 放置 = 从本帧起取新值直到下次变更（**无插值**），
 * 故 keys 为常量段。cxform 语义：rgb' = mr·rgb + ar（0..1），Pixi 端 ColorMatrixFilter 直映。
 *
 * 输出坐标约定：
 *   - 贴图源帧 = 首个恒等 CT 帧（texFrame），帧 PNG 裁剪（crop 为该帧画布像素框）；
 *   - keys 相对贴图源帧：dx,dy = 内容 TL（放置位 + 内容 bounds 偏移，含内部缩放）
 *     − 源帧内容 TL；
 *   - origin 由调用方结合 union 原点换算（title：origin = crop.tl + 元件 union 原点
 *     （元件局部系）；select：origin = 内容 TL 画布坐标（画布系））——统一语义
 *     「贴图 TL 在外层 Sprite 本地系」，运行时 childPos(f) = origin + keys(f)。
 */
import { contentBounds, placementSegments } from './swf-nest.mjs';

const f4 = (v) => +v.toFixed(4);
const eq = (a, b) => Math.abs(a - b) < 1 / 128;

/**
 * @param model parseSwfXml 产物（须为该元件所在 SWF 自己的模型）
 * @param spriteId 元件 id
 * @param {{pad?: number}} opts crop 外扩像素（防边缘抗锯齿裁切）
 * @returns {{frames:number, contentChar:number, keys:number[][], ctKeys:number[][],
 *            crop:[number,number,number,number]}} crop = [x,y,w,h] 画布像素（帧 1 PNG 内）
 */
export function extractElementTween(model, spriteId, opts = {}) {
  const pad = opts.pad ?? 2;
  const sprite = model.sprites.get(spriteId);
  if (!sprite) throw new Error(`element-tween：sprite ${spriteId} 不存在`);
  const frames = sprite.frameCount;

  // 唯一内容子件断言：全部帧全部深度同一 charId、无移除空窗
  const depths = new Set();
  const chars = new Set();
  for (const row of sprite.frames) {
    const es = Object.entries(row || {}).filter(([, p]) => p);
    if (es.length !== 1) throw new Error(`element-tween：sprite ${spriteId} 深度数 ${es.length} ≠ 1（多内容层不适用）`);
    depths.add(es[0][0]);
    chars.add(es[0][1].charId);
  }
  if (depths.size !== 1 || chars.size !== 1) {
    throw new Error(`element-tween：sprite ${spriteId} 内容不恒定（depth ${depths.size} / char ${chars.size}）`);
  }
  const contentChar = [...chars][0];
  if (model.sprites.has(contentChar)) {
    throw new Error(`element-tween：sprite ${spriteId} 内容子件 ${contentChar} 是 sprite（可能多帧/嵌套）——不适用`);
  }
  const cb = contentBounds(model, contentChar);
  if (!cb) throw new Error(`element-tween：内容子件 ${contentChar} 无 bounds`);

  // 帧放置段（placementSegments：常量段压缩，绝对坐标）
  const segs = placementSegments(model, spriteId, [contentChar]);
  if (segs.length !== 1 || segs[0].from !== 1 || segs[0].to !== frames) {
    throw new Error(`element-tween：sprite ${spriteId} 放置段异常（${JSON.stringify(segs.map((s) => [s.from, s.to]))}）`);
  }
  const seg = segs[0];
  if (!seg.keys.length) throw new Error(`element-tween：sprite ${spriteId} 无放置 keys`);

  // 贴图源帧 = 首个恒等色变换帧（CT 全非恒等则无干净源，不适用）
  const depthKey = [...depths][0];
  const ctAt = (f) => sprite.frames[f - 1]?.[depthKey]?.ct ?? null;
  const identityAt = (f) => {
    const ct = ctAt(f);
    return !ct || (eq(ct.mr, 1) && eq(ct.mg, 1) && eq(ct.mb, 1) && eq(ct.ar, 0) && eq(ct.ag, 0) && eq(ct.ab, 0));
  };
  const texFrame = Array.from({ length: frames }, (_, i) => i + 1).find(identityAt);
  if (!texFrame) throw new Error(`element-tween：sprite ${spriteId} 全程非恒等色变换——无干净贴图源`);

  // 内部缩放容差断言：贴图只 raster 了源帧一个尺度；±2% 内的重渲染不可感知（软光斑
  // 亚像素级弹性），超出（如 40 的 0.27→1.71 扩散绽放）上采样会糊，保留帧流
  const sRef = seg.keys.find((k) => texFrame >= k.from && texFrame <= k.to);
  for (const k of seg.keys) {
    for (const [a, b] of [[k.sx, sRef.sx], [k.sy, sRef.sy]]) {
      if (Math.abs(a / b - 1) > 0.02) {
        throw new Error(`element-tween：sprite ${spriteId} 内部缩放变化超容差（${f4(sRef.sx)}→${f4(k.sx)}）——单贴图上采样会糊，保留帧流`);
      }
    }
  }

  // 内容 TL（元件局部，含内部缩放对 bounds 偏移的作用）→ 相对贴图源帧压缩
  const tl = seg.keys.map((k) => ({
    from: k.from,
    to: k.to,
    x: k.x + k.sx * cb.minX,
    y: k.y + k.sy * cb.minY,
    sx: k.sx,
    sy: k.sy,
    alpha: k.alpha,
  }));
  const ref = tl.find((k) => texFrame >= k.from && texFrame <= k.to);
  if (!ref) throw new Error(`element-tween：sprite ${spriteId} 放置段未覆盖贴图源帧 ${texFrame}`);
  const x0 = ref.x;
  const y0 = ref.y;
  const keys = tl.map((k) => [k.from, k.to, f4(k.x - x0), f4(k.y - y0), f4(k.sx), f4(k.sy), f4(k.alpha)]);

  // CXFORM RGB 段压缩（alpha 已在 keys；恒等段不记）
  const ctKeys = [];
  let cur = null;
  for (let f = 1; f <= frames; f++) {
    const ct = ctAt(f);
    const identity = !ct || (eq(ct.mr, 1) && eq(ct.mg, 1) && eq(ct.mb, 1) && eq(ct.ar, 0) && eq(ct.ag, 0) && eq(ct.ab, 0));
    const t = identity ? null : [f2(ct.mr), f2(ct.ar), f2(ct.mg), f2(ct.ag), f2(ct.mb), f2(ct.ab)];
    const sig = t ? t.join(',') : '';
    if (cur && cur.sig === sig) cur.to = f;
    else {
      if (cur && cur.sig) ctKeys.push([cur.from, cur.to, ...cur.t]);
      cur = { from: f, to: f, sig, t };
    }
  }
  if (cur && cur.sig) ctKeys.push([cur.from, cur.to, ...cur.t]);

  // 裁剪框：帧 1 画布内内容 bounds（画布原点 = union TL 由调用方给出时换算，这里输出
  // 元件局部 → 调用方减 union 原点取整）
  const cropLocal = [
    Math.floor(x0 - pad),
    Math.floor(y0 - pad),
    Math.ceil(cb.maxX - cb.minX + pad * 2 + (x0 - Math.floor(x0))),
    Math.ceil(cb.maxY - cb.minY + pad * 2 + (y0 - Math.floor(y0))),
  ];
  return {
    frames,
    contentChar,
    keys,
    ctKeys,
    cropLocal,
    contentTLFrame1: [x0, y0],
    /** 贴图源帧（首个恒等 CT 帧；crop/contentTLFrame1 均以它为基准） */
    texFrame,
    /** 绝对内容 TL 常量段（调用方换算 union/贴图锚点用）：[from,to,tlx,tly,sx,sy,alpha] */
    absKeys: tl.map((k) => [k.from, k.to, f4(k.x), f4(k.y), f4(k.sx), f4(k.sy), f4(k.alpha)]),
  };
}

const f2 = (v) => +v.toFixed(4);
