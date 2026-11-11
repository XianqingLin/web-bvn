/**
 * collect-fire-names —— 从 baked fighters/assistants JSON 提取 fire/addAttacker
 * 元件名清单，写入 capture 目录（~/Documents/bvn-atlas/fire-names.json），
 * 供 capture 桥的 fire 采集模式按名单定位命名子元件（切片 13-A3）。
 *
 * 名单格式：{ fighter: {<id>: [name...]}, assister: {<id>: [name...]} }
 * 同名元件可能在多个动作重复触发——去重即可。
 *
 * 用法：node dist/collect-fire-names.js [captureDir]
 */
import { existsSync, readdirSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const captureDir = resolve(
  process.argv[2] ?? join(homedir(), 'Documents', 'bvn-atlas'),
);

function collectNames(pkg) {
  const names = [];
  const seen = new Set();
  (function walk(o) {
    if (Array.isArray(o)) {
      for (const x of o) walk(x);
    } else if (o && typeof o === 'object') {
      if (
        (o.op === 'fire' || o.op === 'addAttacker') &&
        typeof o.args?.[0] === 'string' &&
        !seen.has(o.args[0])
      ) {
        seen.add(o.args[0]);
        names.push(o.args[0]);
      }
      for (const k in o) walk(o[k]);
    }
  })(pkg);
  return names;
}

const out = { fighter: {}, assister: {} };
for (const [kind, dir] of [
  ['fighter', 'fighters'],
  ['assister', 'assistants'],
]) {
  const abs = join(ROOT, 'packages/data/baked', dir);
  if (!existsSync(abs)) {
    console.error(`collect-fire-names: 缺目录 ${abs}`);
    process.exit(2);
  }
  for (const file of readdirSync(abs)) {
    if (!file.endsWith('.json')) continue;
    const id = file.replace(/\.json$/, '');
    const pkg = JSON.parse(readFileSync(join(abs, file), 'utf8'));
    const names = collectNames(pkg);
    if (names.length > 0) out[kind][id] = names;
  }
}

mkdirSync(captureDir, { recursive: true });
const outFile = join(captureDir, 'fire-names.json');
writeFileSync(outFile, JSON.stringify(out));
const nf = Object.keys(out.fighter).length;
const na = Object.keys(out.assister).length;
const total =
  Object.values(out.fighter).reduce((s, a) => s + a.length, 0) +
  Object.values(out.assister).reduce((s, a) => s + a.length, 0);
console.log(
  `collect-fire-names: fighters=${nf} assistants=${na} 元件名合计=${total} → ${outFile}`,
);
