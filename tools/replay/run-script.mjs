/**
 * tools/replay/run-script.mjs —— replay 剧本展开 + Sim 构造（replay.mjs /
 * verify-drift.mjs 共用，避免两处维护剧本语义）。
 *
 * 剧本格式见 replay.mjs 文件头注释。
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultConfig, Sim } from '@bvn/core';
import { compileAssistant, compileFighterForms, compileMapStage } from '@bvn/data';
import {
  loadAssistantPackage,
  loadFighterPackage,
  loadFirePackage,
  loadMapPackage,
  loadRuntimeFighterPackage,
} from '@bvn/data/node';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const BAKED_DIR = resolve(ROOT, 'packages/data/baked');

/** program 逐段展开为每 tick 的 ButtonMask 输入帧。 */
export function expandFrames(script) {
  const frames = [];
  for (const seg of script.program) {
    const n = seg.frames ?? 0;
    for (let i = 0; i < n; i++) frames.push({ p1: seg.p1 ?? 0, p2: seg.p2 ?? 0 });
  }
  return frames;
}

function buildFighterDefs(script) {
  const list = Array.isArray(script.fighters) ? script.fighters : [];
  const assistants = {};
  const defs = list.map((f) => {
    const runtime = loadRuntimeFighterPackage(BAKED_DIR, f.pkg, 'fighters-runtime');
    const xfl = loadFighterPackage(BAKED_DIR, f.pkg);
    // fire 元数据（切片 13-A3）：可选——缺包 = 该角色 bullet 无动画生命周期
    let fires = null;
    try {
      fires = loadFirePackage(BAKED_DIR, 'fighter', f.pkg).fires;
    } catch {
      /* 无 fire 包 */
    }
    // 多形态（切片 10）：编译全部含动画的形态；[0] 作为 def（与单形态兼容）
    const forms = compileFighterForms(runtime, xfl, fires ?? undefined);
    if (f.assist) {
      const axfl = loadAssistantPackage(BAKED_DIR, f.assist);
      const art = loadRuntimeFighterPackage(BAKED_DIR, f.assist, 'assistants-runtime');
      let afires = null;
      try {
        afires = loadFirePackage(BAKED_DIR, 'assister', f.assist).fires;
      } catch {
        /* 无 fire 包 */
      }
      assistants[f.assist] = compileAssistant(axfl, art, afires ?? undefined);
    }
    return { def: forms[0], forms, assistId: f.assist ?? null };
  });
  return { defs, assistants };
}

/** 按剧本构造 Sim（map 缺省 = 合成空场；fighters/assist 注入同 replay.mjs）。 */
export function createReplaySim(script) {
  const seed = script.seed ?? 1;
  const { defs, assistants } = buildFighterDefs(script);
  const hasAssist = Object.keys(assistants).length > 0;
  if (!script.map) {
    const cfg = createDefaultConfig(seed);
    defs.forEach((d, i) => {
      if (cfg.fighters[i]) {
        cfg.fighters[i].def = d.def;
        cfg.fighters[i].forms = d.forms;
        if (d.assistId) cfg.fighters[i].assistId = d.assistId;
      }
    });
    if (hasAssist) cfg.assistants = assistants;
    return new Sim(cfg);
  }
  const { stage, p1Spawn, p2Spawn } = compileMapStage(loadMapPackage(BAKED_DIR, script.map));
  const groundY = stage.groundY;
  const fallbackSpawn = (i) => (i === 0 ? { x: 300, y: groundY } : { x: 700, y: groundY });
  const s1 = p1Spawn ?? fallbackSpawn(0);
  const s2 = p2Spawn ?? fallbackSpawn(1);
  return new Sim({
    seed,
    stage,
    fighters: [
      {
        id: 1, x: s1.x, y: s1.y,
        ...(defs[0] ? { def: defs[0].def, forms: defs[0].forms } : {}),
        ...(defs[0]?.assistId ? { assistId: defs[0].assistId } : {}),
      },
      {
        id: 2, x: s2.x, y: s2.y,
        ...(defs[1] ? { def: defs[1].def, forms: defs[1].forms } : {}),
        ...(defs[1]?.assistId ? { assistId: defs[1].assistId } : {}),
      },
    ],
    ...(hasAssist ? { assistants } : {}),
  });
}
