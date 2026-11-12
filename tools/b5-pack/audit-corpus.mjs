/**
 * B5 语料审计（临时脚本，不入库）：从 baked 数据枚举 addAttacker 语料，
 * 经 XFL 解析每个 attacker 元件的内层时间轴——逐帧命名子对象 + 帧脚本，
 * 按 owner 动作表（精确 / 去 atm 前缀，镜像 getHitVOByDisplayName）解析。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const ROOT = 'c:/Users/29437/Desktop/Projects/web-bvn';
const SWF_SRC = join(ROOT, 'OpenBleachVsNaruto/swf_source');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  cdataPropName: '#cdata',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function parseSymbol(xml) {
  const doc = parser.parse(xml);
  const root = doc['DOMDocument'] ?? doc['DOMSymbolItem'];
  const tlRaw = root['timelines'] ?? root['timeline'];
  const timelines = asArray(tlRaw);
  const tls = [];
  for (const t of timelines) {
    for (const domTl of asArray(t['DOMTimeline'])) {
      const layers = asArray(domTl['layers']).flatMap((l) => asArray(l['DOMLayer']));
      tls.push(
        layers.map((layer) => {
          const frames = asArray(layer['frames']).flatMap((f) => asArray(f['DOMFrame']));
          return frames.map((f) => ({
            index: Number(f['@_index'] ?? 0),
            duration: Number(f['@_duration'] ?? 1),
            label: f['@_labelType'] === 'name' ? f['@_name'] : undefined,
            script:
              f['Actionscript']?.['script']?.['#cdata'] ??
              (typeof f['Actionscript']?.['script'] === 'string'
                ? f['Actionscript']['script']
                : undefined),
            instances: asArray(f['elements']?.['DOMSymbolInstance']).map((si) => ({
              name: si['@_name'],
              lib: si['@_libraryItemName'],
            })),
          }));
        }),
      );
    }
  }
  return tls; // 每个 timeline 一组图层
}

function resolveLib(libDir, libName) {
  // libraryItemName 如 "元件/mc_011" → LIBRARY/元件/mc_011.xml
  return join(libDir, libName.replace(/\//g, '/') + '.xml');
}

/** 在一组图层的帧表上展开 index→覆盖帧的实例/标签/脚本 */
function expandLayers(layers) {
  const perFrame = new Map(); // frame -> {instances:[], script, label}
  for (const frames of layers) {
    for (const kf of frames) {
      for (let i = kf.index; i < kf.index + kf.duration; i++) {
        const rec = perFrame.get(i) ?? { instances: [], scripts: [], labels: [] };
        for (const inst of kf.instances) rec.instances.push(inst);
        if (kf.script) rec.scripts.push(kf.script);
        if (kf.label) rec.labels.push(kf.label);
        perFrame.set(i, rec);
      }
    }
  }
  return perFrame;
}

function collectAddAttacker(pkg) {
  const out = [];
  (function walk(o) {
    if (Array.isArray(o)) {
      for (const x of o) walk(x);
    } else if (o && typeof o === 'object') {
      if (o.op === 'addAttacker' && typeof o.args?.[0] === 'string') {
        out.push({ name: o.args[0], args: o.args[1] ?? null });
      }
      for (const k in o) walk(o[k]);
    }
  })(pkg);
  return out;
}

/** owner 动作 id 全集（fighter：全部 forms 合并；assister：actions） */
function ownerActionIds(pkg, kind) {
  const ids = new Set();
  if (kind === 'fighter') {
    for (const f of pkg.forms ?? []) for (const id of Object.keys(f.actions ?? {})) ids.add(id);
  } else {
    for (const id of Object.keys(pkg.actions ?? {})) ids.add(id);
  }
  return ids;
}

function resolveName(name, ids) {
  if (ids.has(name)) return { name, via: 'exact' };
  if (name.includes('atm')) {
    const stripped = name.replace('atm', '');
    if (ids.has(stripped)) return { name, via: `strip→${stripped}` };
  }
  return null;
}

const summary = [];
for (const [kind, bakedDir, xflRoot] of [
  ['fighter', 'packages/data/baked/fighters', 'f_fighter'],
  ['assister', 'packages/data/baked/assistants', 'f_assistant'],
]) {
  const dir = join(ROOT, bakedDir);
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const pkg = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const id = file.replace(/\.json$/, '');
    const ops = collectAddAttacker(pkg);
    if (ops.length === 0) continue;
    const xflDir = join(SWF_SRC, xflRoot, id);
    if (!existsSync(xflDir)) {
      summary.push({ kind, id, err: '无 XFL' });
      continue;
    }
    const libDir = join(xflDir, 'LIBRARY');
    const ids = ownerActionIds(pkg, kind);
    // 全库符号缓存：libPath → parsed timelines
    const namesWanted = [...new Set(ops.map((o) => o.name))];
    // 1) 定位 mcName 实例所在符号（扫全部符号时间轴；assister 的实例可能直接在 root 上）
    const symbolCache = new Map();
    const findInstance = (mcName) => {
      const hits = [];
      const scanLayers = (layers, where) => {
        for (const frames of layers) {
          for (const kf of frames) {
            for (const inst of kf.instances) {
              if (inst.name === mcName) hits.push(inst.lib);
            }
          }
        }
      };
      // root
      try {
        const docTls = parseSymbol(readFileSync(join(xflDir, 'DOMDocument.xml'), 'utf8'));
        for (const tl of docTls) scanLayers(tl, '<root>');
      } catch {}
      const libXmls = [];
      (function walkDir(d) {
        for (const f of readdirSync(d)) {
          const p = join(d, f);
          try {
            if (statSync(p).isDirectory()) walkDir(p);
            else if (f.endsWith('.xml')) libXmls.push(p);
          } catch {}
        }
      })(libDir);
      for (const p of libXmls) {
        const rel = p.slice(libDir.length + 1).replace(/\\/g, '/').replace(/\.xml$/, '');
        const key = rel;
        let tls = symbolCache.get(key);
        if (tls === undefined) {
          try {
            tls = parseSymbol(readFileSync(p, 'utf8'));
          } catch {
            tls = [];
          }
          symbolCache.set(key, tls);
        }
        for (const tl of tls) scanLayers(tl, key);
      }
      return [...new Set(hits)];
    };
    for (const name of namesWanted) {
      const where = findInstance(name);
      const rec = { kind, id, mc: name, foundIn: where, frames: [] };
      if (where.length !== 1) {
        rec.err = where.length === 0 ? '实例未找到' : '多处命中';
        summary.push(rec);
        continue;
      }
      const symKey = where[0];
      const tls =
        symKey === '<root>'
          ? parseSymbol(readFileSync(join(xflDir, 'DOMDocument.xml'), 'utf8'))
          : symbolCache.get(symKey) ??
            parseSymbol(readFileSync(resolveLib(libDir, symKey), 'utf8'));
      // 多 timeline 罕见；取合并展开
      const perFrame = new Map();
      for (const tl of tls) {
        for (const [f, rec2] of expandLayers(tl)) {
          const cur = perFrame.get(f) ?? { instances: [], scripts: [], labels: [] };
          cur.instances.push(...rec2.instances);
          cur.scripts.push(...rec2.scripts);
          cur.labels.push(...rec2.labels);
          perFrame.set(f, cur);
        }
      }
      const totalFrames = Math.max(...perFrame.keys()) + 1;
      for (let f = 1; f <= totalFrames; f++) {
        const fr = perFrame.get(f);
        if (!fr) continue;
        const named = fr.instances.filter((i) => i.name && !/^instance/.test(i.name));
        const hits = named
          .map((i) => ({ ...resolveName(i.name, ids), lib: i.lib }))
          .filter((x) => x.name !== undefined && x.via);
        const entry = { frame: f };
        if (named.length) entry.named = named.map((i) => i.name);
        if (hits.length) entry.hits = hits;
        if (fr.labels.length) entry.labels = fr.labels;
        if (fr.scripts.length) entry.script = fr.scripts.join('\n');
        if (entry.named || entry.script || entry.labels) rec.frames.push(entry);
      }
      summary.push(rec);
    }
  }
}
console.log(JSON.stringify(summary, null, 1));
