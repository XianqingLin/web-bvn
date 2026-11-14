#!/usr/bin/env node
/**
 * hit-pack：修复批次 35 打击特效资产管线（effect.swf 19 个命中/防御/钢身火花元件）。
 *
 * 原版烘焙例程 = EffectVO.cacheBitmapData（EffectModel.as 表驱动）：
 *   逐帧 getBounds 裁剪、offsetX/Y = 帧 bounds 原点、空帧（宽/高<1）null、
 *   相邻同帧共享缓存、最后一帧不缓存（while currentFrame < totalFrames——
 *   EffectView._bitmapDatas.length = totalFrames-1，autoRemove 在末缓存帧移除）。
 * 本管线改用"统一画布"烘焙：FFDec -export sprite 的帧 PNG 天然 = 全帧 union
 * bounds 画布（逐帧同尺寸），运行时以容器钉原点、子件位 = union 原点一次性
 * 摆放——与逐帧 offset 数学等价（旋转/镜像经容器变换逐点吻合，见 renderer）。
 *
 * 画布原点推导（PNG (0,0) = 元件空间坐标）：SWF tag 自解析。DefineShape bounds
 * × DefineSprite 内 PlaceObject2/3 矩阵逐帧求并 → union rect（twips，20/px）；
 * origin = (floor(xMin/20), floor(yMin/20))。断言：FFDec PNG 尺寸 = ceil(xMax/20)
 * − floor(xMin/20)（±1px 容差），不符即 union 模型失效须人工归因。
 *
 * 效果参数表来源：EffectModel.as initHitEffect/initDefenseEffect/initSteelHitEffect
 * （freeze/shake/shine/blendMode/randRotate/followDirect 逐条对照，见 JSON 注释级
 * 字段与 core HITSPARK_FREEZE 常量）。忠实 quirk：命中特效 shake{pow} 是原版
 * doEffectVO 死代码（只读 shake.x/y）——移植不补 shake；防御特效 pow→y（竖抖）
 * 与 break_def 横抖由 render 消费。
 *
 * 用法：node tools/hit-pack/hit-pack.mjs [--ffdec PATH]
 */
import { execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
const OUT_ASSETS = resolve(opt('out-assets', 'packages/data/assets/hitspark'));
const OUT_BAKED = resolve(opt('out-baked', 'packages/data/baked/hitspark.json'));
const SCRATCH = resolve(import.meta.dirname, '_scratch/hit-pack');

// ---------- 命中火花规格（EffectModel.as 表 → className/spriteId/参数） ----------
// id：JSON 键名；className：effect.swf 内 AS2 导出名；shine 值逐条对照 EffectModel。
// freezeMs 仅作规格记录，core 侧常量 HITSPARK_FREEZE_* 为行为真值（进哈希）。
const HIT_EFFECTS = [
  { id: 'kan', className: 'XG_kan', type: 1, freezeMs: 50, blendMode: 'add', randRotate: true },
  { id: 'kanx', className: 'XG_kanx', type: 6, freezeMs: 400, blendMode: 'add', randRotate: true, shine: { color: 0xffffff, alpha: 0.2 } },
  { id: 'qdj', className: 'XG_qdj', type: 2, freezeMs: 50, blendMode: 'add', randRotate: true },
  { id: 'qdjx', className: 'XG_qdjx', type: 3, freezeMs: 400, blendMode: 'add', randRotate: true, shine: { color: 0xffffff, alpha: 0.2 } },
  { id: 'mfdj', className: 'XG_mfdj', type: 4, freezeMs: 50, blendMode: 'add', randRotate: true },
  { id: 'mfdjx', className: 'XG_mfdjx', type: 5, freezeMs: 400, blendMode: 'add', randRotate: true, shine: { color: 0xffffff, alpha: 0.2 } },
  { id: 'fire', className: 'XG_fire', type: 7, freezeMs: 400, blendMode: 'add', shine: { color: 0xffff67, alpha: 0.2 } },
  { id: 'ice', className: 'XG_ice', type: 8, freezeMs: 400, blendMode: 'add', shine: { color: 0xa3e5f5, alpha: 0.2 } },
  { id: 'leidian', className: 'XG_leidian', type: 9, freezeMs: 400, blendMode: 'hardlight', shine: { color: 0x8288d2, alpha: 0.2 } },
  { id: 'catch_hit', className: 'xg_catch_hit', type: 11, freezeMs: 400 },
];
const DEFENSE_EFFECTS = [
  { id: 'fykan', className: 'XG_fykan', type: 1, freezeMs: 50, blendMode: 'add', followDirect: true },
  { id: 'fykanx', className: 'XG_fykanx', type: 6, freezeMs: 400, blendMode: 'add', followDirect: true, shine: { color: 0xffffff, alpha: 0.1 } },
  { id: 'fyq', className: 'XG_fyq', type: 2, freezeMs: 50, blendMode: 'add', followDirect: true },
  { id: 'fyqx', className: 'XG_fyqx', type: 3, freezeMs: 400, blendMode: 'add', followDirect: true, shine: { color: 0xffffff, alpha: 0.1 } },
  { id: 'mffy', className: 'XG_mffy', type: 4, freezeMs: 50, blendMode: 'add', followDirect: true },
  { id: 'mffyx', className: 'XG_mffyx', type: 5, freezeMs: 400, blendMode: 'add', followDirect: true, shine: { color: 0xffffff, alpha: 0.15 } },
  { id: 'fire_fy', className: 'XG_fire_fy', type: 7, freezeMs: 400, blendMode: 'add', followDirect: true, shine: { color: 0xffff67, alpha: 0.2 } },
  { id: 'ice_fy', className: 'XG_ice_fy', type: 8, freezeMs: 400, blendMode: 'add', followDirect: true, shine: { color: 0xa3e5f5, alpha: 0.2 } },
  { id: 'dian_fy', className: 'XG_dian_fy', type: 9, freezeMs: 400, blendMode: 'add', followDirect: true, shine: { color: 0x8288d2, alpha: 0.2 } },
];
// 钢身命中（doSteelHitEffect）：kan 系→XG_kan、qdj 系→XG_qdj、其余→XG_mfdj，
// 参数统一 freeze 400 + shine 0.2 + randRotate（复用上面三条基础元件，JSON 只登记映射）。
const STEEL_MAP = { kan: ['kan', 'kanx'], qdj: ['qdj', 'qdjx'], mfdj: ['mfdj', 'mfdjx', 'fire', 'ice', 'leidian', 'catch_hit'] };
// 原版 getDefenseEffect 回退：命中类型无防御特效（0/10/11）→ defense_5（mffyx）
const DEFENSE_FALLBACK = 'mffyx';
// 防御 shake（doDefenseEffect：pow→y 竖抖）+ break_def（shake x 横抖）参数——render 消费
const DEFENSE_SHAKE = { pow: 6, time: 400 };
const BREAK_DEF = {
  id: 'mfdjx', // break_def = XG_mfdjx（同元件独立参数：freeze 500 + shake x6）
  freezeMs: 500,
  shake: { x: 6, time: 400 },
};

// ---------- SWF 解析（最小 tag 集：RECT/MATRIX/Shape bounds/Sprite/Place/Export） ----------
class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
    this.bit = 0;
  }
  align() {
    if (this.bit > 0) {
      this.bit = 0;
      this.pos++;
    }
  }
  u8() {
    this.align();
    return this.buf[this.pos++];
  }
  u16() {
    this.align();
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }
  u32() {
    this.align();
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.buf[this.pos];
      const b = (byte >> (7 - this.bit)) & 1;
      v = (v << 1) | b;
      this.bit++;
      if (this.bit === 8) {
        this.bit = 0;
        this.pos++;
      }
    }
    return v;
  }
  sbits(n) {
    if (n === 0) return 0;
    const v = this.bits(n);
    // 符号扩展
    return v >= 1 << (n - 1) ? v - (1 << n) : v;
  }
  rect() {
    this.align();
    const n = this.bits(5);
    const xMin = this.sbits(n), xMax = this.sbits(n), yMin = this.sbits(n), yMax = this.sbits(n);
    return { xMin, xMax, yMin, yMax };
  }
  matrix() {
    this.align();
    let a = 1, b = 0, c = 0, d = 1;
    if (this.bits(1)) {
      const n = this.bits(5); // NScaleBits
      a = this.sbits(n) / 65536;
      d = this.sbits(n) / 65536;
    }
    if (this.bits(1)) {
      const n = this.bits(5); // NRotateBits
      b = this.sbits(n) / 65536;
      c = this.sbits(n) / 65536;
    }
    const n = this.bits(5); // NTranslateBits
    // tx/ty 保持 twips（xformRect 全程 twips 空间，出口处统一 /20 转 px）
    const tx = this.sbits(n);
    const ty = this.sbits(n);
    this.align();
    return { a, b, c, d, tx, ty };
  }
  string() {
    this.align();
    const end = this.buf.indexOf(0, this.pos);
    const s = this.buf.toString('latin1', this.pos, end);
    this.pos = end + 1;
    return s;
  }
}

/** 矩阵变换 rect 四角取包络（twips）。 */
function xformRect(r, m) {
  const xs = [r.xMin, r.xMax], ys = [r.yMin, r.yMax];
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const x of xs)
    for (const y of ys) {
      const px = m.a * x + m.c * y + m.tx;
      const py = m.b * x + m.d * y + m.ty;
      if (px < xMin) xMin = px;
      if (px > xMax) xMax = px;
      if (py < yMin) yMin = py;
      if (py > yMax) yMax = py;
    }
  return { xMin, xMax, yMin, yMax };
}

function unionRect(list) {
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const r of list) {
    if (!r) continue;
    if (r.xMin < xMin) xMin = r.xMin;
    if (r.xMax > xMax) xMax = r.xMax;
    if (r.yMin < yMin) yMin = r.yMin;
    if (r.yMax > yMax) yMax = r.yMax;
  }
  return list.length ? { xMin, xMax, yMin, yMax } : null;
}

/** 解析 SWF：shape bounds 表 + sprite 逐帧并集 + 导出名映射。 */
function parseSwf(file) {
  const raw = readFileSync(file);
  const sig = raw.toString('latin1', 0, 3);
  const body = sig === 'CWS' ? inflateSync(raw.subarray(8)) : raw.subarray(8);
  const r = new Reader(body);
  r.rect(); // stage
  r.u16(); // frame rate
  r.u16(); // frame count

  const shapes = new Map(); // charId → rect（twips）
  const sprites = new Map(); // spriteId → { frames: number }
  const exports = new Map(); // name → charId
  // 先扫一遍收集 DefineSprite 的 tag 区间与 shape bounds（sprite 内容在第二遍解析）
  const spriteSpans = new Map(); // spriteId → body Reader 参数 [startPos, endPos]
  const tags = [];
  while (r.pos < body.length) {
    const codeLen = r.u16();
    const code = codeLen >> 6;
    let len = codeLen & 0x3f;
    if (len === 0x3f) len = r.u32();
    const start = r.pos;
    tags.push([code, start, len]);
    r.pos = start + len;
  }
  for (const [code, start, len] of tags) {
    if (code === 2 || code === 22 || code === 32 || code === 83) {
      const sr = new Reader(body);
      sr.pos = start;
      const id = sr.u16();
      shapes.set(id, sr.rect());
    } else if (code === 39) {
      const sr = new Reader(body);
      sr.pos = start;
      const id = sr.u16();
      const frameCount = sr.u16();
      sprites.set(id, { frameCount, start: sr.pos, end: start + len });
    } else if (code === 56) {
      const er = new Reader(body);
      er.pos = start;
      const count = er.u16();
      for (let i = 0; i < count; i++) exports.set(er.string(), er.u16());
    } else if (code === 76) {
      const er = new Reader(body);
      er.pos = start;
      const count = er.u16();
      for (let i = 0; i < count; i++) {
        const tagId = er.u16();
        exports.set(er.string(), tagId);
      }
    }
    // SymbolClass 对 = (charId u16, name 字符串)
  }
  // 第二遍：逐 sprite 逐帧模拟（子 MC 播放头随父帧推进、循环——FFDec -export
  // sprite 的渲染语义；用嵌套全帧并集会过度近似，已证）→ 每帧 union bounds
  const DEBUG = process.env.HITPACK_DEBUG === '1';
  const perFrameCache = new Map(); // spriteId → rect[]（每帧 union，twips）
  function charFrameRect(charId, frameIdx, seen) {
    if (shapes.has(charId)) return shapes.get(charId);
    const pf = spritePerFrames(charId, seen);
    if (!pf || pf.length === 0) return null;
    return pf[frameIdx % pf.length];
  }
  function spriteUnion(id, seen = new Set()) {
    return unionRect(spritePerFrames(id, seen));
  }
  function charStaticRect(id, seen) {
    if (shapes.has(id)) return shapes.get(id);
    if (sprites.has(id)) return spriteUnion(id, seen);
    return null; // 位图/文字/声音等：特效火花元件不依赖
  }
  function spritePerFrames(id, seen = new Set()) {
    if (perFrameCache.has(id)) return perFrameCache.get(id);
    if (seen.has(id)) return null; // 循环防御
    seen.add(id);
    const sp = sprites.get(id);
    if (!sp) return null;
    const sr = new Reader(body);
    sr.pos = sp.start;
    const display = new Map(); // depth → {charId, m, placedFrameIdx, cr}
    const perFrame = [];
    let frameIdx = 0;
    while (sr.pos < sp.end) {
      const codeLen = sr.u16();
      const code = codeLen >> 6;
      let len = codeLen & 0x3f;
      if (len === 0x3f) len = sr.u32();
      const start = sr.pos;
      const tr = new Reader(body);
      tr.pos = start;
      if (DEBUG) console.log(`  [sprite ${id}] f${frameIdx} tag ${code} len ${len}`);
      if (code === 4) {
        // PlaceObject：charId, depth, matrix
        const charId = tr.u16();
        const depth = tr.u16();
        const m = tr.matrix();
        const cr = charStaticRect(charId, seen);
        if (DEBUG) console.log(`    place ${charId} d${depth} m=${JSON.stringify(m)} cr=${JSON.stringify(cr)}`);
        if (cr) display.set(depth, { charId, m, placedFrameIdx: frameIdx, cr });
      } else if (code === 26 || code === 70) {
        // PO2 flags: bit0=Move bit1=HasChar bit2=HasMatrix bit3=HasColorXform...
        // PO3 flags1: bit0=HasClipActions bit1=HasClipDepth bit2=HasName bit3=HasColorXform
        //   bit4=HasRatio bit5=HasFilterList bit6=HasChar bit7=HasMatrix（特效元件
        //   语料无 ClassName 字段；若后续断言失败须查 PO3 可选 ClassName 字段）
        const flags = tr.u8();
        const isPO3 = code === 70;
        const hasChar = isPO3 ? flags & 0x40 : flags & 0x02;
        const hasMatrix = isPO3 ? flags & 0x80 : flags & 0x04;
        const move = (flags & 0x01) !== 0;
        if (isPO3) tr.u8(); // flags2（保留位，特效元件无位图缓存标记）
        const depth = tr.u16();
        const prev = display.get(depth);
        if (hasChar) {
          const charId = tr.u16();
          const cr0 = charStaticRect(charId, seen);
          if (hasMatrix) {
            const m = tr.matrix();
            if (DEBUG) console.log(`    place ${charId} d${depth} m=${JSON.stringify(m)} cr=${JSON.stringify(cr0)}`);
            if (cr0) display.set(depth, { charId, m, placedFrameIdx: frameIdx, cr: cr0 });
            else display.delete(depth);
          } else if (prev) {
            // 换内容保留既有矩阵（原版显示列表语义）
            display.set(depth, { charId, m: prev.m, placedFrameIdx: frameIdx, cr: prev.cr });
          } else display.delete(depth);
        } else if (move && hasMatrix && prev) {
          // 仅改矩阵
          const m = tr.matrix();
          display.set(depth, { ...prev, m });
        }
      } else if (code === 28) {
        display.delete(tr.u16());
      } else if (code === 1) {
        // ShowFrame → 快照本帧包络（子 MC 播放头 = 帧 − 摆放帧，模子帧数）
        const rects = [];
        for (const e of display.values()) {
          const fr = charFrameRect(e.charId, frameIdx - e.placedFrameIdx, seen);
          if (fr) {
            const xr = xformRect(fr, e.m);
            if (DEBUG) console.log(`    entry char=${e.charId} f=${frameIdx - e.placedFrameIdx} fr=${JSON.stringify(fr)} -> ${JSON.stringify(xr)}`);
            rects.push(xr);
          }
        }
        const u = unionRect(rects);
        if (DEBUG) console.log(`  [sprite ${id}] f${frameIdx} union=${JSON.stringify(u)}`);
        perFrame.push(u);
        frameIdx++;
      }
      sr.pos = start + len;
    }
    if (perFrame.length === 0) {
      const rects = [];
      for (const e of display.values()) {
        const fr = charFrameRect(e.charId, 0, seen);
        if (fr) rects.push(xformRect(fr, e.m));
      }
      perFrame.push(unionRect(rects));
    }
    perFrameCache.set(id, perFrame);
    return perFrame;
  }
  return { shapes, sprites, exports, spritePerFrames, spriteUnion };
}

/** 解压 SWF 到指定路径（ZWS/LZMA 需 python lzma——Node 无内置；FWS 直接拷贝）。
 *  SWF LZMA 布局：8字节头 + 5字节 props，其后 8 字节是 LZMA 数据流（非 size 字段）——
 *  以未知 size(全 FF) 喂 FORMAT_ALONE 解码器。 */
function extractSwf(file, out) {
  const raw = readFileSync(file);
  const sig = raw.toString('latin1', 0, 3);
  if (sig === 'FWS') {
    writeFileSync(out, raw);
    return;
  }
  if (sig !== 'ZWS') throw new Error(`不支持的 SWF 压缩签名：${sig}`);
  const script = [
    'import lzma,sys',
    'raw=open(sys.argv[1],"rb").read()',
    'd=lzma.LZMADecompressor(format=lzma.FORMAT_ALONE)',
    'out=d.decompress(raw[12:17]+b"\\xff"*8+raw[17:])',
    'open(sys.argv[2],"wb").write(b"FWS"+raw[3:8]+out)',
  ].join(';');
  execFileSync('python', ['-I', '-c', script, file, out], { stdio: ['ignore', 'pipe', 'inherit'] });
}

function run(cmd, args_) {
  console.log(`$ ${cmd} ${args_.join(' ')}`);
  execFileSync(cmd, args_, { stdio: ['ignore', 'pipe', 'inherit'] });
}

// ---------- 1. SWF 解压 + 解析 → 元件 union bounds ----------
mkdirSync(SCRATCH, { recursive: true });
const RAW_SWF = join(SCRATCH, 'effect_fws.swf');
extractSwf(EFFECT_SWF, RAW_SWF);
const swf = parseSwf(RAW_SWF);
const ALL = [...HIT_EFFECTS, ...DEFENSE_EFFECTS];
const geometry = {}; // className → { spriteId, frames, canvas, origin }
for (const eff of ALL) {
  const spriteId = swf.exports.get(eff.className);
  if (spriteId === undefined) throw new Error(`effect.swf 缺导出名 ${eff.className}`);
  const rect = swf.spriteUnion(spriteId);
  if (!rect) throw new Error(`${eff.className}（sprite ${spriteId}）union bounds 为空`);
  const ox = Math.floor(rect.xMin / 20);
  const oy = Math.floor(rect.yMin / 20);
  const w = Math.ceil(rect.xMax / 20) - ox;
  const h = Math.ceil(rect.yMax / 20) - oy;
  geometry[eff.className] = {
    spriteId,
    frames: swf.sprites.get(spriteId).frameCount,
    canvas: [w, h],
    origin: [ox, oy],
    pxRect: { xMin: ox, yMin: oy, w, h }, // 断言基准（JSON 不写）
  };
  console.log(`${eff.className}: sprite=${spriteId} frames=${geometry[eff.className].frames} canvas=${w}x${h} origin=(${ox},${oy})`);
}

// ---------- 2. FFDec 导出 + 画布断言 + webp ----------
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
if (!existsSync(FFDEC)) throw new Error(`FFDec CLI 不存在：${FFDEC}`);
run(FFDEC, ['-export', 'sprite', join(SCRATCH, 'effect'), EFFECT_SWF]);

const bakedEffects = {};
rmSync(OUT_ASSETS, { recursive: true, force: true });
for (const eff of ALL) {
  const g = geometry[eff.className];
  const dirs = readdirSync(join(SCRATCH, 'effect'));
  const spriteDir = dirs.find((d) => d === `DefineSprite_${g.spriteId}` || d.startsWith(`DefineSprite_${g.spriteId}_`));
  if (!spriteDir) throw new Error(`FFDec 导出缺 sprite ${g.spriteId}（${eff.className}）`);
  const pngs = readdirSync(join(SCRATCH, 'effect', spriteDir)).filter((f) => f.endsWith('.png'));
  if (pngs.length !== g.frames) {
    throw new Error(`${eff.className} FFDec 帧数 ${pngs.length} ≠ SWF frameCount ${g.frames}`);
  }
  // 画布断言（union bounds 契约；origin 推导依赖）
  {
    const b = readFileSync(join(SCRATCH, 'effect', spriteDir, '1.png'));
    const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
    if (Math.abs(w - g.pxRect.w) > 1 || Math.abs(h - g.pxRect.h) > 1) {
      throw new Error(
        `${eff.className} FFDec 画布 ${w}x${h} ≠ union bounds ${g.pxRect.w}x${g.pxRect.h}（origin 模型失效须归因）`,
      );
    }
  }
  // 原版 cacheBitmapData 不缓存最后一帧 → 渲染帧数 = totalFrames-1
  const frames = g.frames - 1;
  if (frames < 1) throw new Error(`${eff.className} 帧数异常：${g.frames}`);
  const outDir = join(OUT_ASSETS, eff.id);
  mkdirSync(outDir, { recursive: true });
  for (let i = 1; i <= frames; i++) {
    await sharp(join(SCRATCH, 'effect', spriteDir, `${i}.png`)).webp({ quality: 80 }).toFile(join(outDir, `${i}.webp`));
  }
  bakedEffects[eff.id] = {
    dir: `hitspark/${eff.id}`,
    frames,
    canvas: g.canvas,
    origin: g.origin,
    ...(eff.blendMode ? { blendMode: eff.blendMode } : {}),
    ...(eff.randRotate ? { randRotate: true } : {}),
    ...(eff.followDirect ? { followDirect: true } : {}),
    ...(eff.shine ? { shine: eff.shine } : {}),
    freezeMs: eff.freezeMs,
  };
  console.log(`${eff.className} → ${eff.id}: ${frames} 帧烘焙完成`);
}

// ---------- 3. baked JSON（schema bvn/hitspark@1） ----------
const byType = (list) => Object.fromEntries(list.map((e) => [e.type, e.id]));
const baked = {
  schema: 'bvn/hitspark@1',
  /** className/id/参数 = EffectModel.as 表；freezeMs 为原版毫秒规格（core 常量为行为真值） */
  effects: bakedEffects,
  /** hitType → 命中火花 id（原版 getHitEffect "hit_"+type；type 0/10 无特效不冻） */
  hit: { byType: byType(HIT_EFFECTS) },
  /** sparkType → 防御火花 id（原版 getDefenseEffect "defense_"+type；缺失回退 mffyx） */
  defense: { byType: byType(DEFENSE_EFFECTS), fallback: DEFENSE_FALLBACK },
  /** 钢身命中映射（doSteelHitEffect：kan 系/qdj 系/其余三档） */
  steel: STEEL_MAP,
  /** 防御竖抖 / 破防横抖 + 破防特效（原版 doDefenseEffect pow→y 与 doEffectById("break_def")） */
  shake: { defense: DEFENSE_SHAKE },
  breakDef: BREAK_DEF,
};
writeFileSync(OUT_BAKED, JSON.stringify(baked, null, 2) + '\n');
console.log(`baked → ${OUT_BAKED}（${ALL.length} 元件）`);
