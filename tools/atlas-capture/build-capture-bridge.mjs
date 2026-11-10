#!/usr/bin/env node
/**
 * 构建 BVN capture 桥 SWF（图集栅格化导出）。
 *
 * 范式同 tools/bridge/build-dump-bridge.mjs：改反编译的 FighterTester.as，
 * 再用 FFDec -replace 注回 SWF。注入内容 = tools/atlas-capture/inject-capture.as3。
 *
 * 用法：
 *   node tools/atlas-capture/build-capture-bridge.mjs --dry-run   # 只产出注入后的 .as
 *   node tools/atlas-capture/build-capture-bridge.mjs             # 生成 + FFDec 产出桥 SWF
 *
 * 产物：
 *   work/patched-capture/FighterTester.capture.as
 *   work/FighterTester.capture.swf   ← 用它替换 FighterTester.exe 旁边那份运行
 *
 * ⚠️ 运行桥 SWF 会启动 AIR 游戏窗口并自动遍历采集，跑完自动退出。
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORK = resolve(ROOT, "OpenBleachVsNaruto/_release/work");
const SRC_AS = resolve(WORK, "decompiled-main/scripts/FighterTester.as");
const PATCHED_DIR = resolve(WORK, "patched-capture");
const PATCHED_AS = resolve(PATCHED_DIR, "FighterTester.capture.as");
const METHODS_AS = resolve(ROOT, "tools/atlas-capture/inject-capture.as3");
const SWF_IN = resolve(
  ROOT,
  "OpenBleachVsNaruto/_release/extracted/swf_output/FighterTester.swf",
);
const SWF_OUT = resolve(WORK, "FighterTester.capture.swf");
const FFDEC = "C:\\Program Files (x86)\\FFDec\\ffdec-cli.exe";
const SCRIPT_NAME = "FighterTester";

const dryRun = process.argv.includes("--dry-run");

const src = readFileSync(SRC_AS, "utf8").replace(/\r\n/g, "\n");
const methods = readFileSync(METHODS_AS, "utf8");

if (!methods.includes("startBvnCapture")) {
  throw new Error("注入片段缺 startBvnCapture");
}

function patchSource() {
  if (src.includes("startBvnCapture")) {
    throw new Error("反编译源码已含 capture 桥代码 —— 重新导出后再注入");
  }

  // 1) import 块：插在最后一个 import 之后
  const IMPORT_ADD = `\
      import flash.desktop.NativeApplication;
      import flash.display.BitmapData;
      import flash.display.DisplayObject;
      import flash.display.Loader;
      import flash.display.MovieClip;
      import flash.display.Sprite;
      import flash.events.Event;
      import flash.events.UncaughtErrorEvent;
      import flash.filesystem.File;
      import flash.filesystem.FileMode;
      import flash.filesystem.FileStream;
      import flash.geom.Matrix;
      import flash.geom.Rectangle;
      import flash.media.SoundMixer;
      import flash.media.SoundTransform;
      import flash.system.ApplicationDomain;
      import flash.system.LoaderContext;
      import flash.utils.ByteArray;
      import flash.utils.Endian;
      import net.play5d.game.obvn.map.MapMain;
      import net.play5d.game.obvn.model.AssisterModel;
      import net.play5d.game.obvn.model.FighterModel;
      import net.play5d.game.obvn.model.MapModel;
`;
  const lines = src.split("\n");
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith("import ")) lastImport = i;
  }
  if (lastImport < 0) throw new Error("找不到 import 行");
  // 原文件已有的 import 不重复（Event/Rectangle 已在）
  const existing = new Set(
    lines.filter((l) => l.trim().startsWith("import ")).map((l) => l.trim()),
  );
  const adds = IMPORT_ADD.split("\n").filter(
    (l) => l.trim().startsWith("import ") && !existing.has(l.trim()),
  );
  lines.splice(lastImport + 1, 0, adds.join("\n"));
  let out = lines.join("\n");

  // 2) initBackHandler 末尾加诊断日志 + try/catch 包裹 startBvnCapture()
  const marker = "private function initBackHandler() : void\n      {\n         buildTestUI();";
  if (!out.includes(marker)) {
    throw new Error("找不到 initBackHandler 开头，无法注入调用点");
  }
  const injected = `${marker}
         capBootLog("initBackHandler");
         try
         {
            startBvnCapture();
         }
         catch(e:Error)
         {
            capBootLog("startBvnCapture ERR: " + e.message + " :: " + e.getStackTrace());
         }`;
  out = out.replace(marker, injected);

  // 3) 方法块追加到类尾（文件尾两个 }：倒数第二是类，最后一个是包）
  const stripped = out.trimEnd();
  if (!stripped.endsWith("}")) throw new Error("文件不以 } 结尾，结构不符预期");
  const body = stripped.slice(0, -1).trimEnd();
  if (!body.endsWith("}")) throw new Error("剥掉包括号后结构不符预期");
  const idx = body.lastIndexOf("}");
  out = body.slice(0, idx) + "\n" + methods + "\n" + body.slice(idx) + "\n}\n";
  return out;
}

const patched = patchSource();
mkdirSync(PATCHED_DIR, { recursive: true });
writeFileSync(PATCHED_AS, patched, "utf8");
console.log(`[capture] 注入后的源码 -> ${PATCHED_AS}（+${patched.length - src.length} 字节）`);

if (dryRun) {
  console.log("[capture] --dry-run，不动 SWF");
  process.exit(0);
}

console.log("[capture] 调 FFDec -replace ...");
try {
  const stdout = execFileSync(
    FFDEC,
    ["-replace", SWF_IN, SWF_OUT, SCRIPT_NAME, PATCHED_AS],
    { timeout: 300_000, encoding: "utf8" },
  );
  console.log(stdout.slice(-500));
} catch (e) {
  console.error("[capture] FFDec 失败");
  if (e.stdout) console.error(String(e.stdout).slice(-2000));
  if (e.stderr) console.error(String(e.stderr).slice(-2000));
  process.exit(1);
}
console.log(`[capture] ✅ 产出 ${SWF_OUT}`);
console.log(`
[capture] 下一步（⚠️ 会启动 AIR 游戏窗口，运行前需用户确认）：
  1. 把 ${SWF_OUT} 复制到 _release/extracted/swf_output/ 目录（备份原 FighterTester.swf）
  2. 运行 FighterTester.exe —— 自动遍历采集，写 ~/Documents/bvn-atlas/，跑完自动退出
  3. 还原原版 FighterTester.swf
`);
