#!/usr/bin/env node
/**
 * stream-sheet —— hitspark/bisha 流帧拼图（2026-11-22 战斗加载降请求）。
 *
 * 动机：逐帧 webp（hitspark 647 + bisha mc 71 + bisha effects 34 ≈ 842 个请求）
 * 在部署环境（跨境 ~250ms/请求）把战斗加载 7/7"正在加载资源"拖成分钟级——请求
 * 次数主导成本，带宽是小头。本工具把"统一画布"流帧（hit-pack/bisha-pack 烘焙
 * 语义：全帧 union bounds，同流全部帧等尺寸）按网格拼进少量 sheet webp，清单
 * （sheets/cell/cells）写回 baked JSON；render 侧按 sheet 装载、按 cells 建
 * 帧纹理（Texture.frame quad），消费端 Texture[] 形状不变。
 *
 * 前提（不满足即 fail loud）：
 *  - 每流全部帧实测同尺寸（统一画布）；磁盘帧文件数 == baked frames 声明；
 *  - 单帧 ≤ --max-sheet。
 *
 * 布局：行优先货架。cols = min(frames, floor((max+g)/(w+g)))；每 sheet 行数
 * rows = floor((max+g)/(h+g))，帧填满一张再开新张；sheet 实际宽高按用到的
 * 行列裁紧（不放大到 max——解码显存 = sheet 面积×4B，必须贴内容）。gutter
 * 2px 防 q85 色度子采样跨格渗色。
 *
 * 兼容：逐帧 webp 起初保留（旧客户端按帧拉取）；2026-11-22 发版即时清理（用户确认
 * 跳过 sync-games 的 7 天保留期）——本工具此后**不能再独立重跑**，须先 hit-pack /
 * bisha-pack 重新产出逐帧，再跑本工具与 assets:finalize。
 *
 * 幂等：重跑产出字节相同（sharp 编码确定）；清单覆盖写。
 *
 * 用法：node tools/stream-sheet/stream-sheet.mjs [--max-sheet 4096] [--gutter 2] [--dry-run]
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const DRY = args.includes('--dry-run');
const MAX_SHEET = Number(opt('max-sheet', 4096));
const GUT = Number(opt('gutter', 2));

const ROOT = resolve(import.meta.dirname, '../..');
const ASSETS = join(ROOT, 'packages', 'data', 'assets');
const BAKED = join(ROOT, 'packages', 'data', 'baked');

/** 连续帧号列表 1..n（无去重流的 packStream 入参）。 */
const range = (n) => Array.from({ length: n }, (_, k) => k + 1);

// 与 tools/webp-convert.mjs 同参数（q85/effort5/smartSubsample，alpha 无损）
const WEBP_OPTS = { quality: 85, effort: 5, smartSubsample: true };

/** 实测某流全部帧尺寸（统一画布校验 + 超限校验），返回 [w, h]。帧列表显式传入（去重后非连续）。 */
async function frameSize(dir, frameList) {
  let size = null;
  for (const i of frameList) {
    const m = await sharp(join(ASSETS, dir, `${i}.webp`)).metadata();
    if (!size) {
      size = [m.width, m.height];
      if (size[0] > MAX_SHEET || size[1] > MAX_SHEET) {
        throw new Error(`${dir}: 帧 ${i} ${size[0]}x${size[1]} 超过 --max-sheet ${MAX_SHEET}`);
      }
    } else if (size[0] !== m.width || size[1] !== m.height) {
      throw new Error(
        `${dir}: 帧 ${i} 尺寸 ${m.width}x${m.height} ≠ 帧 ${frameList[0]} ${size[0]}x${size[1]}（非统一画布，拼图前提失效）`,
      );
    }
  }
  return size;
}

/**
 * 行优先货架布局：返回 [{ w, h, frames: [帧号(1-based)] }]，frames 顺序即单元格
 * 摆放顺序（行内从左到右、逐行向下）。
 */
function layout(frames, w, h) {
  const cols = Math.min(frames, Math.max(1, Math.floor((MAX_SHEET + GUT) / (w + GUT))));
  const rowsPerSheet = Math.max(1, Math.floor((MAX_SHEET + GUT) / (h + GUT)));
  const perSheet = cols * rowsPerSheet;
  const sheets = [];
  for (let start = 1; start <= frames; start += perSheet) {
    const count = Math.min(perSheet, frames - start + 1);
    const rows = Math.ceil(count / cols);
    sheets.push({
      w: cols * w + (cols - 1) * GUT,
      h: rows * h + (rows - 1) * GUT,
      frames: Array.from({ length: count }, (_, k) => start + k),
    });
  }
  return { sheets, cols };
}

/** 合成并写出全部 sheet，返回 [{ file, sheetIdx, cells: [x, y][] }]。frameList 为升序唯一帧号。 */
async function compose(dir, layouted, w, h, frameList) {
  const out = [];
  for (let s = 0; s < layouted.sheets.length; s++) {
    const spec = layouted.sheets[s];
    const file = `sheet-${s}.webp`;
    const cells = [];
    const comps = [];
    for (let k = 0; k < spec.frames.length; k++) {
      const c = k % layouted.cols;
      const r = Math.floor(k / layouted.cols);
      const x = c * (w + GUT);
      const y = r * (h + GUT);
      cells.push([x, y]);
      const buf = await sharp(join(ASSETS, dir, `${frameList[spec.frames[k] - 1]}.webp`)).png().toBuffer();
      comps.push({ input: buf, left: x, top: y });
    }
    if (!DRY) {
      await sharp({
        create: { width: spec.w, height: spec.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .composite(comps)
        .webp(WEBP_OPTS)
        .toFile(join(ASSETS, dir, file));
    }
    out.push({ file, sheetIdx: s, cells });
  }
  return out;
}

/** 单流拼图：校验 → 布局 → 合成 → 清单，返回 { sheets, cell, cells }（render StreamSheetSpec 形状）。
 *  frameList = 升序唯一帧号（无去重时即 1..frames 连续）；cells[i] 对应 frameList[i]。 */
async function packStream(label, dir, frameList) {
  const [w, h] = await frameSize(dir, frameList);
  const layouted = layout(frameList.length, w, h);
  const composed = await compose(dir, layouted, w, h, frameList);
  let bytes = 0;
  if (!DRY) {
    for (const c of composed) bytes += statSync(join(ASSETS, dir, c.file)).size;
  }
  console.log(
    `${label}: ${frameList.length} 帧 ${w}x${h} → ${composed.length} sheet` +
      (DRY ? '' : `（${(bytes / 1024).toFixed(0)}KB）`),
  );
  return {
    sheets: composed.map((c) => c.file),
    cell: [w, h],
    cells: composed.flatMap((c) => c.cells.map(([x, y]) => [c.sheetIdx, x, y])),
  };
}

/**
 * --ui 模式（2026-11-25）：主菜单 title fx 叠加层拼图。ui-pack 逐帧烘出
 * ui/title-fx/<char>/*.webp（444 文件，启动预热 444 请求 + 播放期逐帧解码/上传
 * churn），此处按同款货架拼成 sheet 并把清单写进 ui.json title.fx.elements
 * （schema 升 @9；逐帧文件保留，旧客户端/无清单回退仍走逐帧）。
 * 链式纪律与 hitspark/bisha 相同：须在 ui-pack 产出散图之后运行。
 * 帧去重（stream-dedup）在其前：el.map 存在时只拼唯一帧（cells 按升序唯一帧
 * 排列，运行时按槽位→帧号→cell 名次寻址）。
 */
async function uiMode() {
  const path = join(BAKED, 'ui.json');
  const ui = JSON.parse(readFileSync(path, 'utf8'));
  for (const [char, el] of Object.entries(ui.title.fx.elements)) {
    // 帧去重感知（2026-11-25 stream-dedup 产物）：el.map 存在时磁盘只剩唯一帧，
    // 只拼 map 引用的唯一帧（升序），运行时 SheetFrameStream 按槽位→帧号→cell 序号寻址
    const list = el.map
      ? [...new Set(el.map)].sort((a, b) => a - b)
      : Array.from({ length: el.frames }, (_, k) => k + 1);
    el.sheets = await packStream(`ui/title-fx/${char}`, el.dir, list);
  }
  if (ui.schema === 'bvn/ui@9') ui.schema = 'bvn/ui@10';
  if (!DRY) writeFileSync(path, JSON.stringify(ui));
}

async function main() {
  if (args.includes('--ui')) {
    await uiMode();
    console.log(DRY ? 'dry-run 完成（未写文件）' : '完成');
    return;
  }
  const hitsparkPath = join(BAKED, 'hitspark.json');
  const bishaPath = join(BAKED, 'bisha.json');
  const hitspark = JSON.parse(readFileSync(hitsparkPath, 'utf8'));
  const bisha = JSON.parse(readFileSync(bishaPath, 'utf8'));

  for (const [id, e] of Object.entries(hitspark.effects)) {
    e.sheets = await packStream(`hitspark/${id}`, e.dir, range(e.frames));
  }
  bisha.mc.sheets = await packStream('bisha/mc', bisha.mc.dir, range(bisha.mc.frames));
  for (const [id, e] of Object.entries(bisha.effects)) {
    e.sheets = await packStream(`bisha/${id}`, e.dir, range(e.frames));
  }

  // schema 升版（结构变更：流帧拼图清单；旧字段全保留，逐帧回退路径仍有效）
  if (hitspark.schema === 'bvn/hitspark@1') hitspark.schema = 'bvn/hitspark@2';
  if (bisha.schema === 'bvn/bisha@2') bisha.schema = 'bvn/bisha@3';

  if (!DRY) {
    // 保持既有文件风格：hitspark 缩进 2 格、bisha 压缩
    writeFileSync(hitsparkPath, JSON.stringify(hitspark, null, 2) + '\n');
    writeFileSync(bishaPath, JSON.stringify(bisha));
  }
  console.log(DRY ? 'dry-run 完成（未写文件）' : '完成');
}

await main();
