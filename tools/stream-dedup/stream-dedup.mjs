#!/usr/bin/env node
/**
 * stream-dedup —— 流帧去重（2026-11-25 UI 资产 Tier 1 治理）。
 *
 * 动机：FFDec 逐帧烘焙把 Flash 补间/停帧原样固化为位图序列——logo 66 帧里 47 帧
 * 像素级完全相同（20 帧淡入 + 46 帧定格），select-fx/71 的 30fps 流实为 10fps 内容
 * （周期-3 冗余），title 90 帧里 60+ 帧静止。重复帧白占下载字节（UI 流 ~34MB）。
 * （logo 已 tween 化收编——单贴图 + 补间，见 ui-pack 3f——不再流经本工具。）
 *
 * 语义：**播放头槽位不变**。ui.json 各流帧规格新增可选 `map: [u1, u2, …]`
 * （播放头槽位 1-based → 磁盘帧号，指向该槽位像素内容的首次出现帧），
 * `frames` 仍为槽位总数——循环时长/时序逐 tick 等价，仅文件数与请求/字节下降。
 * 运行时 FrameStream/SheetFrameStream 按 map 寻址（缺省恒等映射，旧清单兼容）。
 *
 * 算法：逐槽位解码帧（raw RGBA），与最近 KEEP_REPS 个"代表帧"缓冲精确比对
 * （Buffer.equals，含尺寸校验）；相同 → 映射到该代表帧，不同 → 自成新代表。
 * 代表缓冲只留最近 N 个：静态段/短周期（本库全部实测形态）全覆盖；超长周期
 * 回环（尾帧==首帧）不保证收敛，属可接受损失（≤1 帧）。
 *
 * 幂等与链式纪律：ui-pack 重跑会还原重复帧 → 本工具须在其后重新执行；`map`
 * 已存在时跳过（不重入——重复帧文件已删，槽位扫描无输入）。产出后 title-fx
 * 需重跑 stream-sheet --ui 重建 sheet（cells 只含唯一帧）。
 * 崩溃安全：两阶段——先全量扫描写 ui.json，后统一删文件；中断只残留未引用
 * 文件（无害），不会出现清单指向已删帧。
 *
 * 用法：node tools/stream-dedup/stream-dedup.mjs [--keep-reps 16] [--dry-run]
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const DRY = args.includes('--dry-run');
const KEEP_REPS = Number(opt('keep-reps', 16));

const ROOT = resolve(import.meta.dirname, '../..');
const ASSETS = join(ROOT, 'packages', 'data', 'assets');
const uiPath = join(ROOT, 'packages', 'data', 'baked', 'ui.json');

/** 解码帧为 raw RGBA（含 alpha 统一），返回 { buf, w, h }。 */
async function decode(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { buf: data, w: info.width, h: info.height };
}

/** Windows 下杀软/索引器瞬时锁文件 → EBUSY，退避重试。 */
async function unlinkRetry(file, tries = 5) {
  for (let k = 1; ; k++) {
    try {
      unlinkSync(file);
      return;
    } catch (e) {
      if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
      if (k >= tries) throw e;
      await new Promise((r) => setTimeout(r, 100 * k));
    }
  }
}

/**
 * 单流去重扫描：返回 { map, deletable }（无可去重帧时 null）。
 * 代表帧缓冲 LRU（最近 KEEP_REPS 个）：新帧先比旧代表（先入者胜，取首次出现）。
 * 只算不删——删除统一在 ui.json 写盘后执行（崩溃安全：先有 map 后删文件，
 * 中断残留的未引用文件无害，重跑恒等收敛）。
 */
async function dedupStream(label, dir, frames) {
  const reps = []; // { frame, img }，时间序
  const map = new Array(frames).fill(0);
  for (let i = 1; i <= frames; i++) {
    const file = join(ASSETS, dir, `${i}.webp`);
    if (!existsSync(file)) throw new Error(`${label}: 帧 ${i} 文件缺失（须在 ui-pack/webp-convert 之后运行）`);
    const img = await decode(file);
    let hit = 0;
    for (let k = reps.length - 1; k >= 0; k--) {
      const r = reps[k];
      if (r.img.w === img.w && r.img.h === img.h && r.img.buf.equals(img.buf)) {
        hit = r.frame;
        break;
      }
    }
    if (hit) {
      map[i - 1] = hit;
    } else {
      map[i - 1] = i;
      reps.push({ frame: i, img });
      if (reps.length > KEEP_REPS) reps.shift();
    }
  }
  const unique = new Set(map);
  if (unique.size === frames) return null;
  const deletable = [];
  for (let i = 1; i <= frames; i++) if (!unique.has(i)) deletable.push(i);
  console.log(`${label}: ${frames} 槽位 → ${unique.size} 唯一帧（待删 ${deletable.length} 文件）`);
  return { map, deletable };
}

const ui = JSON.parse(readFileSync(uiPath, 'utf8'));
if (ui.schema !== 'bvn/ui@10') throw new Error(`ui.json schema=${ui.schema}，期望 bvn/ui@10`);

let changed = false;
/** 待删文件 [dir, frameNo][]，ui.json 写盘后统一执行。 */
const pendingDeletes = [];

// select：旋涡 + 地图面板 fx（OverlayFx → FrameStream；同 dir 多实例共享同一 map）
{
  const seen = new Map();
  for (const spec of [ui.select.vortex, ...ui.select.mapFx]) {
    if (!spec || spec.frames <= 1 || spec.tween || spec.map) continue;
    if (seen.has(spec.dir)) {
      spec.map = seen.get(spec.dir);
      continue;
    }
    const r = await dedupStream(spec.dir, spec.dir, spec.frames);
    if (r) {
      spec.map = r.map;
      seen.set(spec.dir, r.map);
      pendingDeletes.push([spec.dir, r.deletable]);
      changed = true;
    }
  }
}

// title：底/顶双板（各自目录独立去重）
if (!ui.title.map) {
  const r = await dedupStream(ui.title.dir, ui.title.dir, ui.title.frames);
  if (r) {
    ui.title.map = r.map;
    pendingDeletes.push([ui.title.dir, r.deletable]);
    changed = true;
  }
}
if (!ui.title.topMap) {
  const r = await dedupStream(ui.title.topDir, ui.title.topDir, ui.title.frames);
  if (r) {
    ui.title.topMap = r.map;
    pendingDeletes.push([ui.title.topDir, r.deletable]);
    changed = true;
  }
}

// title.fx.elements：fx 叠加层（sheet 重建交给 stream-sheet --ui）
for (const [char, el] of Object.entries(ui.title.fx.elements)) {
  if (el.map || el.frames <= 1 || el.tween) continue;
  const r = await dedupStream(el.dir, el.dir, el.frames);
  if (r) {
    el.map = r.map;
    pendingDeletes.push([el.dir, r.deletable]);
    changed = true;
  }
}

if (!changed) {
  console.log('所有流均无重复帧（或 map 已存在），nothing to do');
  process.exit(0);
}

ui.schema = 'bvn/ui@10';

// 先写清单后删文件：中断只残留未引用文件（无害），不会出现清单指向已删帧
if (!DRY) {
  writeFileSync(uiPath, JSON.stringify(ui));
  for (const [dir, nums] of pendingDeletes) {
    for (const n of nums) await unlinkRetry(join(ASSETS, dir, `${n}.webp`));
  }
}
console.log(DRY ? 'dry-run 完成（未写文件）' : `完成（schema → ${ui.schema}）；title-fx 请重跑 stream-sheet --ui 重建 sheet`);
