/**
 * tools/exporter —— 原版素材 → 烘焙 JSON（DESIGN §4）。
 *
 * 用法：
 *   node tools/exporter/dist/main.js fighter <xflDir> --id <swf基名> --out <file> [--fighter-xml <path>]
 *
 * 校验失败（errors 非空）退出码 1；用法/IO 错误退出码 2。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { extractFighter } from './fighter.js';

function fail(msg: string): never {
  console.error(`exporter: ${msg}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const positional: string[] = [];
const flags: Record<string, string | true> = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const val = args[i + 1] && !args[i + 1]!.startsWith('--') ? args[++i]! : true;
    flags[key] = val;
  } else {
    positional.push(a);
  }
}

const [command, target] = positional;
if (command !== 'fighter' || !target) {
  fail('用法：exporter fighter <xflDir> --id <swf基名> --out <file> [--fighter-xml <path>]');
}
if (typeof flags['id'] !== 'string') fail('缺 --id');
if (typeof flags['out'] !== 'string') fail('缺 --out');

const fighterXml = flags['fighter-xml'];
const { pkg, validation } = extractFighter({
  xflDir: target,
  id: flags['id'],
  ...(typeof fighterXml === 'string' ? { fighterXmlPath: fighterXml } : {}),
});

for (const w of validation.warnings) console.warn(`warning: ${w}`);
if (validation.errors.length > 0) {
  for (const e of validation.errors) console.error(`error: ${e}`);
  console.error(`exporter: 校验失败（${validation.errors.length} 个 error），不写出。`);
  process.exit(1);
}

mkdirSync(dirname(flags['out']), { recursive: true });
writeFileSync(flags['out'], JSON.stringify(pkg, null, 2) + '\n');
console.log(
  `exporter: ${pkg.id} → ${flags['out']}（forms=${pkg.forms.length}，` +
    `symbols=${Object.keys(pkg.symbols).length}，source=${pkg.source.hash.slice(0, 12)}）`,
);
