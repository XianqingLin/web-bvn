#!/usr/bin/env node
/**
 * 构建 BVN dump 桥 SWF。
 *
 * 范式沿用 bvn-ai-public/build_bridge.py：改反编译的 FighterTester.as，
 * 再用 FFDec -replace 注回 SWF。只改文档类一个脚本，避免"新增类"的麻烦。
 *
 * 注入内容 = tools/bridge/inject-methods.as3（dump 桥方法块）
 *
 * 用法：
 *   node tools/bridge/build-dump-bridge.mjs --dry-run   # 只产出注入后的 .as
 *   node tools/bridge/build-dump-bridge.mjs             # 生成 + FFDec 产出桥 SWF
 *
 * 产物：
 *   work/patched/FighterTester.bridge.as
 *   work/FighterTester.dump.swf      ← 用它替换 FighterTester.exe 旁边那份运行
 *
 * ⚠️ 运行桥 SWF 会启动 AIR 游戏窗口并自动遍历 dump，跑完自动退出。
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORK = resolve(ROOT, "OpenBleachVsNaruto/_release/work");
const SRC_AS = resolve(WORK, "decompiled-main/scripts/FighterTester.as");
const PATCHED_DIR = resolve(WORK, "patched");
const PATCHED_AS = resolve(PATCHED_DIR, "FighterTester.bridge.as");
const METHODS_AS = resolve(ROOT, "tools/bridge/inject-methods.as3");
const SWF_IN = resolve(
  ROOT,
  "OpenBleachVsNaruto/_release/extracted/swf_output/FighterTester.swf",
);
const SWF_OUT = resolve(WORK, "FighterTester.dump.swf");
const FFDEC = "C:\\Program Files (x86)\\FFDec\\ffdec-cli.exe";
const SCRIPT_NAME = "FighterTester";

const dryRun = process.argv.includes("--dry-run");

const src = readFileSync(SRC_AS, "utf8").replace(/\r\n/g, "\n");
const methods = readFileSync(METHODS_AS, "utf8");

if (src.includes("startBvnDump") && !src.includes("BVN dump 桥结束")) {
  // initBackHandler 里的调用注入过了但方法块没有 —— 半成品，报错重做
  if (!methods.includes("startBvnDump")) throw new Error("注入片段缺 startBvnDump");
}

function patchSource() {
  if (src.includes("bvnDumpOne")) {
    throw new Error("反编译源码已含 dump 桥代码 —— 重新导出后再注入");
  }

  // B5：addAttacker 语料（_b5Wanted）——从 baked fighters/assistants 包
  // 提取（与 collect-fire-names 同一 walk），角色按 forms 合并去重。
  // dump 桥只采集名单内元件，避免误伤姿势美术等有内层时间轴的命名件。
  const b5Wanted = { fighter: {}, assister: {} };
  const walkAddAttacker = (o, names) => {
    if (Array.isArray(o)) {
      for (const x of o) walkAddAttacker(x, names);
    } else if (o && typeof o === "object") {
      if (o.op === "addAttacker" && typeof o.args?.[0] === "string") {
        names.add(o.args[0]);
      }
      for (const k in o) walkAddAttacker(o[k], names);
    }
  };
  for (const [kind, dir] of [
    ["fighter", "fighters"],
    ["assister", "assistants"],
  ]) {
    const bakedDir = resolve(ROOT, "packages/data/baked", dir);
    let files = [];
    try {
      files = readdirSync(bakedDir).filter((f) => f.endsWith(".json"));
    } catch {
      throw new Error(`baked/${dir} 目录不可读 —— 先跑 export:all`);
    }
    for (const file of files) {
      const pkg = JSON.parse(readFileSync(join(bakedDir, file), "utf8"));
      const names = new Set();
      walkAddAttacker(pkg, names);
      if (names.size > 0) {
        b5Wanted[kind][file.replace(/\.json$/, "")] = [...names];
      }
    }
  }
  const b5Count = Object.values(b5Wanted.fighter).flat().length +
    Object.values(b5Wanted.assister).flat().length;
  console.log(
    `[bridge] B5 语料：fighter ${Object.keys(b5Wanted.fighter).length} 角色 / ` +
      `assister ${Object.keys(b5Wanted.assister).length} 辅助，` +
      `元件名 ${b5Count} 个`,
  );

  // 1) import 块：插在最后一个 import 之后
  const IMPORT_ADD = `\
      import flash.desktop.NativeApplication;
      import flash.display.DisplayObject;
      import flash.display.Loader;
      import flash.display.MovieClip;
      import flash.events.Event;
      import flash.events.UncaughtErrorEvent;
      import flash.filesystem.File;
      import flash.filesystem.FileMode;
      import flash.filesystem.FileStream;
      import flash.geom.Rectangle;
      import flash.system.ApplicationDomain;
      import flash.system.LoaderContext;
      import flash.utils.ByteArray;
      import net.play5d.game.obvn.map.MapMain;
      import net.play5d.game.obvn.model.AssisterModel;
      import net.play5d.game.obvn.model.FighterModel;
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

  // 2) initBackHandler 末尾加诊断日志 + try/catch 包裹 startBvnDump()
  const marker = "private function initBackHandler() : void\n      {\n         buildTestUI();";
  if (!out.includes(marker)) {
    throw new Error("找不到 initBackHandler 开头，无法注入调用点");
  }
  const injected = `${marker}
         bvnBootLog("initBackHandler");
         try
         {
            startBvnDump();
         }
         catch(e:Error)
         {
            bvnBootLog("startBvnDump ERR: " + e.message + " :: " + e.getStackTrace());
         }`;
  out = out.replace(marker, injected);

  // 3) 方法块追加到类尾（文件尾两个 }：倒数第二是类，最后一个是包）
  const stripped = out.trimEnd();
  if (!stripped.endsWith("}")) throw new Error("文件不以 } 结尾，结构不符预期");
  const body = stripped.slice(0, -1).trimEnd();
  if (!body.endsWith("}")) throw new Error("剥掉包括号后结构不符预期");
  const idx = body.lastIndexOf("}");
  out =
    body.slice(0, idx) +
    "\n" +
    methods.replace("__B5_WANTED_JSON__", JSON.stringify(b5Wanted)) +
    "\n" +
    body.slice(idx) +
    "\n}\n";
  return out;
}

const patched = patchSource();
mkdirSync(PATCHED_DIR, { recursive: true });
writeFileSync(PATCHED_AS, patched, "utf8");
console.log(`[bridge] 注入后的源码 -> ${PATCHED_AS}（+${patched.length - src.length} 字节）`);

if (dryRun) {
  console.log("[bridge] --dry-run，不动 SWF");
  process.exit(0);
}

console.log("[bridge] 调 FFDec -replace ...");
try {
  const stdout = execFileSync(
    FFDEC,
    ["-replace", SWF_IN, SWF_OUT, SCRIPT_NAME, PATCHED_AS],
    { timeout: 300_000, encoding: "utf8" },
  );
  console.log(stdout.slice(-500));
} catch (e) {
  console.error("[bridge] FFDec 失败");
  if (e.stdout) console.error(String(e.stdout).slice(-2000));
  if (e.stderr) console.error(String(e.stderr).slice(-2000));
  process.exit(1);
}
console.log(`[bridge] ✅ 产出 ${SWF_OUT}`);
console.log(`
[bridge] 下一步（⚠️ 会启动 AIR 游戏窗口，运行前需用户确认）：
  1. 把 ${SWF_OUT} 复制到 swf_output 目录（备份原 FighterTester.swf）
  2. 运行 FighterTester.exe —— 自动遍历 dump，写 ~/Documents/bvn-dump/，跑完自动退出
  3. 还原原版 FighterTester.swf
`);
