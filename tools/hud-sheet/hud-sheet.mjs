#!/usr/bin/env node
/**
 * hud-sheet —— HUD 帧集拼图（2026-11-23 战斗加载降请求，stream-sheet 同构方案）。
 *
 * 动机：HUD 帧集（ui/hud/*）仍逐帧 webp 装载（566 个请求，startko/winnerko 字样
 * 序列占 ~4.2MB/528 帧），且 FightHud.loadFrames 探测式分批（16/批）批间串行，
 * 慢链路（~250ms/往返）上把「正在加载资源」最后一段拖成秒级——请求次数主导，
 * 带宽是小头。方案与 stream-sheet 相同：统一画布帧集按网格拼进少量 sheet webp，
 * 清单（sheets/cell/cells）写回 baked JSON；render 侧复用 loadSheetFrames，
 * 输出 Texture[] 形状不变，消费端无感。
 *
 * 【verify 模式（缺省，零写入）】：枚举 baked hud.json elements，逐帧实测尺寸做
 * 统一画布校验，按 stream-sheet 同款货架布局（--max-sheet/--gutter）在内存中合成
 * sheet 并实测编码字节数，输出拼图收益预估。
 *
 * 【--pack 模式】：同布局真实落盘——每帧集目录写 sheet-N.webp（与逐帧 1.webp…
 * 并存，回退保留），清单 { path, sheets:{sheets,cell,cells} } 写回 baked hud.json
 * 对应 element（string 目录 → 对象），schema 升 bvn/hud@2。重跑幂等（sharp 编码
 * 确定）；逐帧文件被清理后本工具不能再独立重跑（须先 ui-pack/hud-pack 重产散图）。
 *
 * 用法：node tools/hud-sheet/hud-sheet.mjs [--pack] [--max-sheet 4096] [--gutter 2] [--rtt 250]
 */
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const MAX_SHEET = Number(opt('max-sheet', 4096));
const GUT = Number(opt('gutter', 2));
const RTT = Number(opt('rtt', 250)); // 慢链路单请求往返 ms，用于波次换算（粗估）
const PACK = args.includes('--pack');

const ROOT = resolve(import.meta.dirname, '../..');
const ASSETS = join(ROOT, 'packages', 'data', 'assets');
const BAKED = join(ROOT, 'packages', 'data', 'baked');

// 与 tools/webp-convert.mjs / stream-sheet 同参数（q85/effort5/smartSubsample，alpha 无损）
const WEBP_OPTS = { quality: 85, effort: 5, smartSubsample: true };

/** 枚举帧集目录实际帧（1.webp 起连续，缺失即止），逐帧实测尺寸与字节。 */
async function probeFrames(dir) {
  const frames = [];
  for (let i = 1; ; i++) {
    const p = join(ASSETS, dir, `${i}.webp`);
    if (!existsSync(p)) break;
    const m = await sharp(p).metadata();
    frames.push({ i, w: m.width, h: m.height, bytes: statSync(p).size });
  }
  if (frames.length === 0) throw new Error(`${dir}: 帧集目录为空（无 1.webp）`);
  return frames;
}

/**
 * 行优先货架布局（与 stream-sheet.mjs layout 同款）：返回
 * { sheets: [{ w, h, count }], cols }。sheet 宽高按用到的行列裁紧。
 */
function layout(frameCount, w, h) {
  const cols = Math.min(frameCount, Math.max(1, Math.floor((MAX_SHEET + GUT) / (w + GUT))));
  const rowsPerSheet = Math.max(1, Math.floor((MAX_SHEET + GUT) / (h + GUT)));
  const perSheet = cols * rowsPerSheet;
  const sheets = [];
  for (let start = 1; start <= frameCount; start += perSheet) {
    const count = Math.min(perSheet, frameCount - start + 1);
    const rows = Math.ceil(count / cols);
    sheets.push({
      w: cols * w + (cols - 1) * GUT,
      h: rows * h + (rows - 1) * GUT,
      count,
    });
  }
  return { sheets, cols };
}

/** 合成全部 sheet（PACK 时落盘 dir/sheet-N.webp，否则内存实测），返回每 sheet 字节数。 */
async function compose(dir, frames, layouted, w, h) {
  const out = [];
  let f = 0; // frames 下标
  for (const s of layouted.sheets) {
    const comps = [];
    for (let k = 0; k < s.count; k++, f++) {
      comps.push({
        input: await sharp(join(ASSETS, dir, `${frames[f].i}.webp`)).png().toBuffer(),
        left: (k % layouted.cols) * (w + GUT),
        top: Math.floor(k / layouted.cols) * (h + GUT),
      });
    }
    if (PACK) {
      const file = `sheet-${out.length}.webp`;
      await sharp({
        create: { width: s.w, height: s.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .composite(comps)
        .webp(WEBP_OPTS)
        .toFile(join(ASSETS, dir, file));
      out.push(statSync(join(ASSETS, dir, file)).size);
    } else {
      const { data } = await sharp({
        create: { width: s.w, height: s.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .composite(comps)
        .webp(WEBP_OPTS)
        .toBuffer({ resolveWithObject: true });
      out.push(data.byteLength);
    }
  }
  return out;
}

const KB = (n) => (n / 1024).toFixed(0).padStart(6);

async function main() {
  const hudPath = join(BAKED, 'hud.json');
  const hud = JSON.parse(readFileSync(hudPath, 'utf8'));
  const singles = [];
  const sets = [];
  for (const [name, el] of Object.entries(hud.elements)) {
    // 幂等重跑：已 pack 的 element 是对象，取其 path 作为帧集目录
    const path = typeof el === 'string' ? el : el.path;
    if (typeof el === 'string' && el.endsWith('.webp')) {
      const p = join(ASSETS, path);
      const m = await sharp(p).metadata();
      singles.push({ name, path, w: m.width, h: m.height, bytes: statSync(p).size });
    } else {
      const frames = await probeFrames(path);
      const [w, h] = [frames[0].w, frames[0].h];
      for (const f of frames) {
        if (f.w !== w || f.h !== h) {
          throw new Error(
            `${path}: 帧 ${f.i} ${f.w}x${f.h} ≠ 帧 1 ${w}x${h}（非统一画布，拼图前提失效）`,
          );
        }
        if (w > MAX_SHEET || h > MAX_SHEET) {
          throw new Error(`${path}: 帧 1 ${w}x${h} 超过 --max-sheet ${MAX_SHEET}`);
        }
      }
      sets.push({ name, path, frames, w, h });
    }
  }

  // —— 帧集拼图（PACK：落盘 + 清单写回 hud.json；否则内存实测预估） —— //
  let totalFrames = 0;
  let totalFrameBytes = 0;
  let totalSheets = 0;
  let totalSheetBytes = 0;
  let maxWavesNow = 0; // 现在：逐元素 Promise.all，墙钟 ≈ 波次最多的元素
  console.log('== 帧集（统一画布校验通过 → 拼图） ==');
  for (const s of sets) {
    const layouted = layout(s.frames.length, s.w, s.h);
    const sheetBytes = await compose(s.path, s.frames, layouted, s.w, s.h);
    const frameBytes = s.frames.reduce((a, f) => a + f.bytes, 0);
    const sheets = layouted.sheets.length;
    const wavesNow = Math.ceil(s.frames.length / 16); // loadFrames 探测式分批（批间串行）
    maxWavesNow = Math.max(maxWavesNow, wavesNow);
    totalFrames += s.frames.length;
    totalFrameBytes += frameBytes;
    totalSheets += sheets;
    totalSheetBytes += sheetBytes.reduce((a, b) => a + b, 0);
    console.log(
      `${s.name}: ${s.frames.length} 帧 ${s.w}x${s.h} ${KB(frameBytes)}KB → ${sheets} sheet ` +
        `${KB(sheetBytes.reduce((a, b) => a + b, 0))}KB（现在 ${wavesNow} 波次探测）`,
    );
    if (sheets > 1) {
      for (const [k, sb] of sheetBytes.entries()) {
        console.log(`  sheet-${k}: ${layouted.sheets[k].w}x${layouted.sheets[k].h} ${KB(sb)}KB`);
      }
    }
    if (PACK) {
      // 清单写回：string 目录 → { path, sheets }（render StreamSheetSpec 形状，
      // cells 0-based 帧 → [sheetIdx, x, y]，宽高 = cell）
      const cells = [];
      let fi = 0;
      for (let si = 0; si < sheets; si++) {
        const spec = layouted.sheets[si];
        for (let k = 0; k < spec.count; k++, fi++) {
          cells.push([si, (k % layouted.cols) * (s.w + GUT), Math.floor(k / layouted.cols) * (s.h + GUT)]);
        }
      }
      hud.elements[s.name] = {
        path: s.path,
        sheets: {
          sheets: Array.from({ length: sheets }, (_, si) => `sheet-${si}.webp`),
          cell: [s.w, s.h],
          cells,
        },
      };
    }
  }
  if (PACK) {
    // schema 升版（结构变更：帧集拼图清单；旧字段全保留，逐帧回退路径仍有效）
    if (hud.schema === 'bvn/hud@1') hud.schema = 'bvn/hud@2';
    writeFileSync(hudPath, JSON.stringify(hud));
    console.log(`清单已写回 ${hudPath}（schema bvn/hud@2，逐帧回退保留）`);
  }

  // —— root 单图现状 —— //
  const singleBytes = singles.reduce((a, f) => a + f.bytes, 0);
  console.log('== root 单图 ==');
  for (const s of singles) {
    console.log(`${s.name}: ${s.w}x${s.h} ${KB(s.bytes)}KB`);
  }

  // —— 收益汇总 —— //
  const requestsNow = singles.length + totalFrames; // 逐帧 + 404 探测浪费另计（近似下限）
  const requestsPacked = singles.length + totalSheets; // 单图保持逐张（异构尺寸，网格拼图不适用）
  console.log('== 汇总 ==');
  console.log(`帧集: ${sets.length} 元素 / ${totalFrames} 帧 ${KB(totalFrameBytes)}KB → ${totalSheets} sheet ${KB(totalSheetBytes)}KB`);
  console.log(`单图: ${singles.length} 张 ${KB(singleBytes)}KB（保持逐张）`);
  console.log(`请求数: ${requestsNow} → ${requestsPacked}（未计现在每帧集最后一批的 404 探测浪费）`);
  console.log(`慢链路墙钟粗估 @${RTT}ms/往返: 现在 ≈ max(${maxWavesNow} 波次)×RTT ≈ ${(maxWavesNow * RTT / 1000).toFixed(2)}s（HUD 段, 条形冻结）`);
  console.log(`                    拼图后 ≈ ${Math.ceil(totalSheets / 6)} 波次（runPool 6）×RTT ≈ ${(Math.ceil(totalSheets / 6) * RTT / 1000).toFixed(2)}s`);
  console.log(PACK ? 'pack 完成。' : 'verify 完成：零写入。--pack 落盘并写回清单。');
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
