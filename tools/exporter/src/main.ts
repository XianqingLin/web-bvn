/**
 * tools/exporter —— 原版素材 → 烘焙 JSON（DESIGN §4）。
 *
 * 用法：
 *   exporter fighter <xflDir> --id <swf基名> --out <file> [--fighter-xml <path>]
 *   exporter assistant <xflDir> --id <swf基名> --out <file>
 *   exporter batch --xfl-root <swf_source目录> --out-dir <dir> [--fighter-xml <path>]
 *
 * 校验失败（errors 非空）退出码 1；用法/IO 错误退出码 2。
 * batch 逐项容错：单项失败不中断，最后统一报告。
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ValidationResult } from '@bvn/data';
import { extractAssistant } from './assistant.js';
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

function report(id: string, validation: ValidationResult): boolean {
  for (const w of validation.warnings) console.warn(`warning[${id}]: ${w}`);
  if (validation.errors.length > 0) {
    for (const e of validation.errors) console.error(`error[${id}]: ${e}`);
    return false;
  }
  return true;
}

function writePkg(out: string, pkg: unknown): void {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(pkg, null, 2) + '\n');
}

function runFighter(xflDir: string, id: string, out: string, fighterXml?: string): boolean {
  const { pkg, validation } = extractFighter({
    xflDir,
    id,
    ...(fighterXml !== undefined ? { fighterXmlPath: fighterXml } : {}),
  });
  if (!report(id, validation)) return false;
  writePkg(out, pkg);
  console.log(
    `exporter: fighter ${id} → ${out}（forms=${pkg.forms.length}，` +
      `symbols=${Object.keys(pkg.symbols).length}，source=${pkg.source.hash.slice(0, 12)}）`,
  );
  return true;
}

function runAssistant(xflDir: string, id: string, out: string): boolean {
  const { pkg, validation } = extractAssistant({ xflDir, id });
  if (!report(id, validation)) return false;
  writePkg(out, pkg);
  console.log(
    `exporter: assistant ${id} → ${out}（actions=${Object.keys(pkg.actions).length}，` +
      `symbols=${Object.keys(pkg.symbols).length}，source=${pkg.source.hash.slice(0, 12)}）`,
  );
  return true;
}

const [command, target] = positional;

if (command === 'fighter') {
  if (!target) fail('fighter 命令缺 <xflDir>');
  if (typeof flags['id'] !== 'string') fail('缺 --id');
  if (typeof flags['out'] !== 'string') fail('缺 --out');
  const fx = flags['fighter-xml'];
  const ok = runFighter(target, flags['id'], flags['out'], typeof fx === 'string' ? fx : undefined);
  process.exit(ok ? 0 : 1);
} else if (command === 'assistant') {
  if (!target) fail('assistant 命令缺 <xflDir>');
  if (typeof flags['id'] !== 'string') fail('缺 --id');
  if (typeof flags['out'] !== 'string') fail('缺 --out');
  const ok = runAssistant(target, flags['id'], flags['out']);
  process.exit(ok ? 0 : 1);
} else if (command === 'batch') {
  const xflRoot = flags['xfl-root'];
  const outDir = flags['out-dir'];
  if (typeof xflRoot !== 'string') fail('缺 --xfl-root');
  if (typeof outDir !== 'string') fail('缺 --out-dir');
  const fx = flags['fighter-xml'];

  let failed = 0;
  for (const dir of readdirSync(join(xflRoot, 'f_fighter')).sort()) {
    try {
      if (!runFighter(join(xflRoot, 'f_fighter', dir), dir, join(outDir, 'fighters', `${dir}.json`), typeof fx === 'string' ? fx : undefined)) failed++;
    } catch (e) {
      console.error(`error[${dir}]: ${(e as Error).message}`);
      failed++;
    }
  }
  for (const dir of readdirSync(join(xflRoot, 'f_assistant')).sort()) {
    try {
      if (!runAssistant(join(xflRoot, 'f_assistant', dir), dir, join(outDir, 'assistants', `${dir}.json`))) failed++;
    } catch (e) {
      console.error(`error[${dir}]: ${(e as Error).message}`);
      failed++;
    }
  }
  if (failed > 0) {
    console.error(`exporter: batch 完成，${failed} 项失败。`);
    process.exit(1);
  }
  console.log('exporter: batch 全部通过。');
} else {
  fail('未知命令。用法见文件头注释。');
}
