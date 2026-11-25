// UI 特效 tween 化审计：解析 UI SWF 的 swf2xml，枚举所有多帧 sprite 并分类
// （TWEEN = 内容恒定只动矩阵/CXFORM，可单贴图 + 补间重表达；FRAME-ANIM = 逐帧换内容，
// 保留烘焙；MIXED = 兼有，需拆层）。纯文本分析零图像解码，与 ui.json 流清单对照。
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseSwfXml } from './swf-nest.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const SCRATCH = join(ROOT, 'tools/ui-pack/_scratch/ui-pack');
const ui = JSON.parse(readFileSync(join(ROOT, 'packages/data/baked/ui.json'), 'utf8'));

const f2 = (v) => (Math.abs(v) < 0.001 ? 0 : +v.toFixed(2));

const models = {};
for (const name of ['common', 'select', 'title', 'setting']) {
  models[name] = parseSwfXml(readFileSync(join(SCRATCH, `${name}.xml`), 'utf8'));
}
const isMultiFrame = (id) => {
  for (const m of Object.values(models)) {
    const s = m.sprites.get(id);
    if (s) return s.frameCount > 1;
  }
  return false;
};

function classify(sprite) {
  let contentChanges = 0; // (depth,charId) 集合变化次数
  let matrixMoves = 0; // 恒定内容上的矩阵变化
  let ctMoves = 0; // 恒定内容上的色变换/alpha 变化
  const nested = new Set(); // 引用的多帧子 sprite（嵌套动画）
  let prev = null;
  let prevSig = '';
  for (const row of sprite.frames) {
    const entries = Object.entries(row || {}).filter(([, p]) => p);
    const sig = entries.map(([d, p]) => `${d}:${p.charId}`).sort().join('|');
    if (sig !== prevSig) contentChanges++;
    prevSig = sig;
    for (const [d, p] of entries) {
      if (isMultiFrame(p.charId)) nested.add(p.charId);
      if (prev && prev[d] && prev[d].charId === p.charId) {
        if (
          f2(prev[d].x) !== f2(p.x) ||
          f2(prev[d].y) !== f2(p.y) ||
          f2(prev[d].sx) !== f2(p.sx) ||
          f2(prev[d].sy) !== f2(p.sy)
        ) {
          matrixMoves++;
        }
        const a0 = prev[d].alpha ?? 1;
        const a1 = p.alpha ?? 1;
        const c0 = prev[d].ct;
        const c1 = p.ct;
        if (a0 !== a1) ctMoves++;
        else if (c0 && c1 && (f2(c0.mr) !== f2(c1.mr) || f2(c0.ar) !== f2(c1.ar) || f2(c0.mg) !== f2(c1.mg) || f2(c0.ag) !== f2(c1.ag) || f2(c0.mb) !== f2(c1.mb) || f2(c0.ab) !== f2(c1.ab))) ctMoves++;
        else if (!c0 !== !c1) ctMoves++;
      }
    }
    prev = row;
  }
  return { contentChanges, matrixMoves, ctMoves, nested: [...nested] };
}

for (const [name, m] of Object.entries(models)) {
  const rows = [];
  for (const [id, s] of m.sprites) {
    if (s.frameCount <= 1) continue;
    const c = classify(s);
    const verdict =
      c.contentChanges <= 2 && (c.matrixMoves > 0 || c.ctMoves > 0)
        ? 'TWEEN'
        : c.contentChanges === 0
          ? 'STATIC?'
          : c.matrixMoves + c.ctMoves > 0
            ? 'MIXED'
            : 'FRAME-ANIM';
    rows.push({ id, frames: s.frameCount, ...c, verdict });
  }
  rows.sort((a, b) => b.frames - a.frames);
  console.log(`\n== ${name}.xml 多帧 sprite（${rows.length}）==`);
  for (const r of rows) {
    console.log(
      `  sprite ${r.id} ${r.frames}帧 [${r.verdict}] 内容变化×${r.contentChanges} 矩阵动×${r.matrixMoves} 色变×${r.ctMoves}${r.nested.length ? ` 嵌套多帧子件:[${r.nested.join(',')}]` : ''}`,
    );
  }
}

console.log('\n== ui.json 流帧清单 ==');
const streams = [
  ['select.vortex', ui.select.vortex],
  ...ui.select.mapFx.map((s, i) => [`select.mapFx[${i}]`, s]),
  ['title 底板', { dir: ui.title.dir, frames: ui.title.frames }],
  ['title 顶板', { dir: ui.title.topDir, frames: ui.title.frames }],
  ...Object.entries(ui.title.fx.elements).map(([k, v]) => [`title.fx/${k}`, v]),
];
for (const [name, s] of streams) {
  if (!s) continue;
  const uniq = s.map ? new Set(s.map).size : s.frames;
  console.log(
    `  ${name}: ${s.dir} ${s.frames}帧 唯一内容帧 ${uniq}${s.map ? '（已去重）' : ''}${s.sheets ? '（已拼图）' : ''}`,
  );
}
