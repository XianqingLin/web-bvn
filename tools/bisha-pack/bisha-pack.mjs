#!/usr/bin/env node
/**
 * bisha-pack：切片 22 必杀切人插图资产管线（原版 effect.swf mc_016 "bisha_face_mc"
 * + 各角色 SWF 必杀立绘位图）。
 *
 * FFDec CLI 导出：
 *   1. effect.swf -export sprite → DefineSprite_633_bisha_face_mc 71 帧 PNG
 *      （画布 1066×209 = 内容 union bounds；PNG 只含背景横幅——立绘槽 mc_001 是
 *      guide 空容器，FFDec 帧不含立绘，运行时按槽位矩阵合成）→ sharp WebP q80
 *      → assets/bisha/mc/<n>.webp；
 *   2. 各角色 SWF（38 包，含 forms[].sounds.bishaFaces 映射者）-export image →
 *      按类名挑立绘（文件名 "<symbolId>_<类名>.png"）→ 剥前缀后按
 *      assets/bisha/faces/<pkgId>_<faceName>.png 落盘（faceName = 语料 bisha()
 *      第二参，如 "Ichigo_1"）。
 *
 * 画布原点（mc 空间 → PNG 像素换算）：PNG 像素 (0,0) = mc 空间 (-134,-12)。
 * 推导：mc_016 内容 union bounds = shape_009（图层3 背板 800×209，identity 摆放）
 * ∪ mc_017（图层1 照片横幅 800×184，tx=-1）∪（横幅内容起点 = 自身 bounds 原点
 * (0,0)：mc_017 内 5 张 picture 全部 a=2/d=2、无 tx/ty 摆在原点）。横幅照片带
 * 在帧 PNG 实测位于 (133,12)（子件相关性探针）→ 原点 = (-1-133, 0-12)。
 * 打包时断言画布尺寸 1066×209，规格漂移即报错。
 *
 * 立绘槽位（mc_016 图层4/5，DOMSymbolInstance "facemc1"/"facemc2"）：运动补间
 * 线性（无 acceleration 属性），插值模型 = 分解变换绕 transformationPoint：
 * 世界位 W_T = centerPoint3D（矩阵 tx/ty + scale×TP 反推逐帧一致），缩放 (a,d)
 * 线性过渡；颜色偏移（白闪 255→50→0）与 alphaMultiplier 同步插值。
 * 运行时摆放：face 纹理 254×180，anchor = TP/faceSize，position = W_T - canvasOrigin，
 * scale = (a, d)。
 *
 * 用法：node tools/bisha-pack/bisha-pack.mjs [--ffdec PATH] [--out-assets DIR] [--out-baked FILE]
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const ROOT = resolve(import.meta.dirname, '../..');
const FFDEC = resolve(opt('ffdec', 'C:/Program Files (x86)/FFDec/ffdec-cli.exe'));
const EFFECT_SWF = resolve(
  opt('effect-swf', 'OpenBleachVsNaruto/_release/extracted/swf_output/assets/effect.swf'),
);
const FIGHTER_DIR = resolve(
  opt('fighter-dir', 'OpenBleachVsNaruto/_release/extracted/swf_output/assets/fighter'),
);
const BAKED_FIGHTERS = resolve(opt('baked-fighters', 'packages/data/baked/fighters'));
const OUT_ASSETS = resolve(opt('out-assets', 'packages/data/assets/bisha'));
const OUT_BAKED = resolve(opt('out-baked', 'packages/data/baked/bisha.json'));
const SCRATCH = resolve(import.meta.dirname, '_scratch/bisha-pack');

// ---------- mc_016 "bisha_face_mc" 时间轴规格（swf_source/assets/effect/LIBRARY/mc/mc_016.xml） ----------
const MC = {
  spriteId: 633,
  className: 'bisha_face_mc',
  frames: 71, // 0-based 0..70；0-based 69 = "destory" 标签（全元素 alpha=0），70 = stop()（全空）
  fps: 30, // effect.swf frameRate
  canvasSize: [1066, 209], // FFDec 画布 = 内容 union bounds
  canvasOrigin: [-134, -12], // PNG (0,0) 对应的 mc 空间坐标（见文件头推导）
  /** 原版挂载位：BlackBackView.showFace mc.x=0, mc.y=100+100/zoom（zoom=1 → 200） */
  mcPos: [0, 200],
  /** BishaFaceEffectView：face bitmap 强制 254×180，加到 facemc 槽 (0,0) */
  faceSize: [254, 180],
  /** mc_001 transformationPoint（槽位矩阵缩放/摆位参考点） */
  faceAnchor: [84.45, 59.95],
  /** destory 标签帧（0-based；此后元素 alpha 全 0，运行时可提前收场） */
  destoryFrame: 69,
};

// 立绘槽关键帧（0-based 帧 → [W_Tx, W_Ty, a(scaleX), d(scaleY), rOff, gOff, bOff, alphaMul]）。
// W_T = centerPoint3D（= 矩阵 scale×TP + tx/ty，逐帧核对一致）；无颜色项 = 0 偏移。
const FACEMC1_KF = [
  [0, [-49.5, 60, 1, 0.0825347900390625, 255, 254, 255, 1]],
  [3, [63.5, 59.95, 1, 1, 255, 255, 255, 1]],
  [6, [66.35, 59.95, 1, 1, 50, 50, 50, 1]],
  [59, [82.5, 59.95, 1, 1, 0, 0, 0, 1]],
  [69, [82.5, 59.95, 1, 1, 0, 0, 0, 0]],
];
const FACEMC2_KF = [
  [0, [847.4, 60, -1, 0.0825347900390625, 255, 254, 255, 1]],
  [3, [734.4, 59, -1, 1, 255, 255, 255, 1]],
  [6, [731.55, 59, -1, 1, 50, 50, 50, 1]],
  [59, [715.4, 59, -1, 1, 0, 0, 0, 1]],
  [69, [715.4, 59, -1, 1, 0, 0, 0, 0]],
];

/** 关键帧序列 → 逐帧数组（线性补间；末关键帧后 = null，元素移除）。 */
function bakeSlots(kfs) {
  const out = new Array(MC.frames).fill(null);
  for (let k = 0; k < kfs.length; k++) {
    const [f0, v0] = kfs[k];
    out[f0] = v0;
    if (k + 1 < kfs.length) {
      const [f1, v1] = kfs[k + 1];
      for (let f = f0 + 1; f < f1; f++) {
        const t = (f - f0) / (f1 - f0);
        out[f] = v0.map((a, i) => a + (v1[i] - a) * t);
      }
    }
  }
  return out;
}

function run(cmd, args_) {
  console.log(`$ ${cmd} ${args_.join(' ')}`);
  execFileSync(cmd, args_, { stdio: ['ignore', 'pipe', 'inherit'] });
}

// ---------- 1. 收集 baked fighters 的 bishaFaces（name→class，逐形态合并） ----------
const faceMap = {}; // pkgId → { faceName → faceClass }
for (const f of readdirSync(BAKED_FIGHTERS)) {
  if (!f.endsWith('.json')) continue;
  const pkg = JSON.parse(readFileSync(join(BAKED_FIGHTERS, f), 'utf8'));
  const set = {};
  for (const form of pkg.forms ?? []) {
    for (const [name, cls] of Object.entries((form.sounds ?? {}).bishaFaces ?? {})) {
      set[name] = cls;
    }
  }
  if (Object.keys(set).length > 0) faceMap[pkg.id] = set;
}
const pkgCount = Object.keys(faceMap).length;
const faceCount = Object.values(faceMap).reduce((n, m) => n + Object.keys(m).length, 0);

// ---------- 2. FFDec 导出 ----------
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
if (!existsSync(FFDEC)) throw new Error(`FFDec CLI 不存在：${FFDEC}`);
run(FFDEC, ['-export', 'sprite', join(SCRATCH, 'effect'), EFFECT_SWF]);

// ---------- 3. mc_016 71 帧 → assets/bisha/mc/<n>.webp ----------
const mcDir = join(OUT_ASSETS, 'mc');
rmSync(mcDir, { recursive: true, force: true });
mkdirSync(mcDir, { recursive: true });
{
  const spriteDir = readdirSync(join(SCRATCH, 'effect')).find(
    (d) => d === `DefineSprite_${MC.spriteId}` || d.startsWith(`DefineSprite_${MC.spriteId}_`),
  );
  if (!spriteDir) throw new Error(`effect.swf 未找到 sprite ${MC.spriteId}（${MC.className}）`);
  const frames = readdirSync(join(SCRATCH, 'effect', spriteDir)).filter((f) => f.endsWith('.png'));
  if (frames.length !== MC.frames) {
    throw new Error(`bisha_face_mc 帧数变化：${frames.length} ≠ ${MC.frames}（规格须同步更新）`);
  }
  // 断言画布尺寸（union bounds 契约；canvasOrigin 推导依赖它）
  {
    const b = readFileSync(join(SCRATCH, 'effect', spriteDir, '10.png'));
    const w = b.readUInt32BE(16);
    const h = b.readUInt32BE(20);
    if (w !== MC.canvasSize[0] || h !== MC.canvasSize[1]) {
      throw new Error(`bisha_face_mc 画布 ${w}×${h} ≠ 规格 ${MC.canvasSize.join('×')}（canvasOrigin 须重推）`);
    }
  }
  for (let i = 1; i <= MC.frames; i++) {
    await sharp(join(SCRATCH, 'effect', spriteDir, `${i}.png`)).webp({ quality: 80 }).toFile(join(mcDir, `${i}.webp`));
  }
}

// ---------- 4. 立绘 → assets/bisha/faces/<pkgId>_<faceName>.png ----------
const facesDir = join(OUT_ASSETS, 'faces');
rmSync(facesDir, { recursive: true, force: true });
mkdirSync(facesDir, { recursive: true });
const bakedFaces = {}; // pkgId → { faceName → 'bisha/faces/....png' }
for (const [pkgId, names] of Object.entries(faceMap)) {
  const swf = join(FIGHTER_DIR, `${pkgId}.swf`);
  if (!existsSync(swf)) throw new Error(`角色 SWF 缺失：${swf}`);
  const outDir = join(SCRATCH, 'face', pkgId);
  run(FFDEC, ['-export', 'image', outDir, swf]);
  const files = readdirSync(outDir);
  bakedFaces[pkgId] = {};
  for (const [name, cls] of Object.entries(names)) {
    const hit = files.find((f) => f.endsWith(`_${cls}.png`));
    if (!hit) {
      // 语料映射存在但 SWF 无此位图类（如 kenshin 的 {"bsface1":"bsface1"} 死映射）：
      // 原版运行时同样取不到 Class → 黑幕切人无立绘。跳过并告警。
      console.warn(`warn: ${pkgId}.swf 无立绘位图 ${cls}（${name}），黑幕切人无立绘`);
      continue;
    }
    const file = `${pkgId}_${name}.png`;
    cpSync(join(outDir, hit), join(facesDir, file));
    bakedFaces[pkgId][name] = `bisha/faces/${file}`;
  }
}

// ---------- 5. baked/bisha.json ----------
const doc = {
  schema: 'bvn/bisha@1',
  mc: {
    dir: 'bisha/mc',
    frames: MC.frames,
    fps: MC.fps,
    destoryFrame: MC.destoryFrame,
    canvasOrigin: MC.canvasOrigin,
    canvasSize: MC.canvasSize,
    mcPos: MC.mcPos,
    faceSize: MC.faceSize,
    faceAnchor: MC.faceAnchor,
    /** 逐帧槽位（0-based 帧 → [W_Tx, W_Ty, scaleX, scaleY, rOff, gOff, bOff, alphaMul] | null）。
     *  运行时：anchor = faceAnchor/faceSize、position = (W_Tx,W_Ty) - canvasOrigin、scale = (scaleX,scaleY)。 */
    slots: { facemc1: bakeSlots(FACEMC1_KF), facemc2: bakeSlots(FACEMC2_KF) },
  },
  /** pkgId → faceName → 立绘文件（语料 bisha(face) 第二参 → 纹理） */
  faces: bakedFaces,
};

mkdirSync(dirname(OUT_BAKED), { recursive: true });
writeFileSync(OUT_BAKED, JSON.stringify(doc));
console.log(
  `bisha-pack: mc ${MC.frames} 帧 / faces ${faceCount} 张（${pkgCount} 包）→ ${OUT_ASSETS} + ${OUT_BAKED}`,
);
