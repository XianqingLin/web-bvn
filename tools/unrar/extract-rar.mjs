#!/usr/bin/env node
/**
 * 一次性工具：解 swf_output.rar（系统无 7-Zip/unrar 时用）。
 * 用法：node tools/unrar/extract-rar.mjs <rar路径> <输出目录>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createExtractorFromData } from 'node-unrar-js';

const [rarPath, outDir] = process.argv.slice(2);
if (!rarPath || !outDir) {
  console.error('用法：node tools/unrar/extract-rar.mjs <rar路径> <输出目录>');
  process.exit(2);
}

const data = readFileSync(rarPath);
const extractor = await createExtractorFromData({ data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
const list = extractor.getFileList();
const headers = [...list.fileHeaders];
console.log(`rar 内 ${headers.length} 个条目`);

let written = 0;
for (const h of headers) {
  if (h.flags.directory) continue;
  const extracted = extractor.extract({ files: [h.name] });
  const files = [...extracted.files];
  const f = files[0];
  if (!f || !f.extraction) continue;
  const dest = join(outDir, h.name);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(f.extraction));
  written++;
}
console.log(`已解压 ${written} 个文件 → ${outDir}`);
