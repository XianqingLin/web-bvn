/**
 * logo-tween：logo_movie（common_ui.swf sprite 26）补间化参数提取（Tier 2，DESIGN §4.8）。
 *
 * 原版结构（swf2xml 实证）：
 *   - d1 = 白矩形（charId 17）缩放铺满 800×600 舞台，帧 1..65 常驻、帧 66 移除；
 *   - d2 = logo 图形（charId 19），逐帧 CXFORM 白↔本色**灰度互补**线性渐变
 *     （mult+add ≡ 1，alpha 恒 1，无 blend mode）：帧 1 纯白剪影 → 帧 20 本色 →
 *     定格 → 帧尾渐回纯白剪影。
 * 等价性：互补渐变作用在压平合成帧上与「白底上 alpha 淡入淡出」逐像素同式
 *   （cxform(p) = m·p + a ≡ α·p + (1−α)·255，α = m/256），故运行时用
 *   单张恒等定格帧贴图 + 白底 + alpha 关键帧补间忠实还原——本模块导出
 *   关键帧（[帧号, alpha] 线性插值）与贴图源帧号，全部从 CXFORM 程序化导出。
 */

import { parseSwfXml } from './swf-nest.mjs';

/** 关键帧线性拟合容差（1/128 ≈ 两档 1/256 量化误差，容忍定点取整的 13/14 交替步进）。 */
const EPS = 1 / 128;

/**
 * 从 swf2xml 提取 logo 补间参数。
 * @param {string} xml FFDec swf2xml 全文
 * @param {{spriteId:number, frames:number, logoChar:number, bgChar:number}} spec
 * @returns {{keys:[number,number][], texFrame:number}}
 *   keys = [帧号(1 起), alpha] 线性插值关键帧；texFrame = 恒等定格帧（α=1 首帧），
 *   贴图须从该帧压平合成（FFDec 帧 PNG）烘焙。
 */
export function extractLogoTween(xml, spec) {
  const model = parseSwfXml(xml);
  const sprite = model.sprites.get(spec.spriteId);
  if (!sprite) throw new Error(`logo-tween：sprite ${spec.spriteId} 不存在`);
  if (sprite.frames.length !== spec.frames) {
    throw new Error(`logo-tween：帧数变化 ${sprite.frames.length} ≠ ${spec.frames}（规格须同步更新）`);
  }
  // 白底前提：帧 1..N-1 d1 白矩形常驻（末帧整体移除 = 空台，白底语义由运行时白矩形承接）
  for (let i = 0; i < spec.frames - 1; i++) {
    const bg = sprite.frames[i]?.[1];
    if (!bg || bg.charId !== spec.bgChar) {
      throw new Error(`logo-tween：帧 ${i + 1} 缺白底（d1 charId ${bg?.charId} ≠ ${spec.bgChar}）——白底等价前提不成立`);
    }
  }
  const alphas = sprite.frames.map((row, i) => {
    const p = row?.[2] ?? null; // d2 = logo 图形
    if (!p) return 0; // 移除 → 运行时白底承接，等价 α=0
    if (p.charId !== spec.logoChar) {
      throw new Error(`logo-tween：帧 ${i + 1} d2 元件变化（${p.charId} ≠ ${spec.logoChar}）`);
    }
    if (!p.ct) return 1; // 无色变换 = 恒等
    if (Math.abs(p.ct.mr - p.ct.mg) > EPS || Math.abs(p.ct.mr - p.ct.mb) > EPS) {
      throw new Error(`logo-tween：帧 ${i + 1} 色变换非灰度（mr ${p.ct.mr} / mg ${p.ct.mg} / mb ${p.ct.mb}）——单贴图 alpha 补间不适用`);
    }
    if (Math.abs(p.ct.mr + p.ct.ar - 1) > EPS) {
      throw new Error(`logo-tween：帧 ${i + 1} 色变换非互补（mr ${p.ct.mr} + ar ${p.ct.ar} ≠ 1）——白底等价前提不成立`);
    }
    return p.ct.mr;
  });
  // 关键帧压缩：逐段恒定斜率（含 0）合并为端点；末帧恒收尾
  const keys = [[1, alphas[0]]];
  let seg = 1; // 当前段起点（1 起帧号）
  for (let f = 2; f <= alphas.length; f++) {
    const d = alphas[f - 1] - alphas[f - 2];
    const d0 = alphas[seg] - alphas[seg - 1];
    if (Math.abs(d - d0) > EPS || f === alphas.length) {
      const end = Math.abs(d - d0) > EPS ? f - 1 : f;
      if (keys[keys.length - 1][0] !== end) keys.push([end, round4(alphas[end - 1])]);
      seg = f;
    }
  }
  if (keys[keys.length - 1][0] !== alphas.length) keys.push([alphas.length, round4(alphas[alphas.length - 1])]);
  const texFrame = alphas.findIndex((a) => a === 1) + 1;
  if (texFrame <= 0) throw new Error('logo-tween：无恒等帧（α=1），无贴图源');
  return { keys, texFrame };
}

const round4 = (v) => +v.toFixed(4);
