/**
 * 切片 4 dev 预览页：sim 60Hz + render 插值渲染。
 *
 * 装配（与 tools/replay 同一接线，浏览器侧 fetch 版）：
 *   baked runtime + XFL JSON → compileFighterRuntime → SimConfig；
 *   baked map JSON → compileMapStage；图集 JSON → render.load()。
 * 键盘 → ButtonMask → sim.tick；快照喂 BattleRenderer。
 */
import { Application } from 'pixi.js';
import { Sim, Btn, type ButtonMask } from '@bvn/core';
import { compileFighterRuntime, compileMapStage } from '@bvn/data';
import { BattleRenderer } from '@bvn/render';

const BAKED = '/packages/data/baked';
const ASSETS = '/packages/data/assets';

const FIGHTER_ID = 'ichigo';
const MAP_ID = 'KonohaMura';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

// ---------- 键盘 → ButtonMask ----------
// P1：WASD 移动 / S 防御（按住↓），J 攻击 K 跳 L 瞬步 U 技 I 必杀
const KEYMAP: Record<string, number> = {
  KeyW: Btn.up,
  KeyS: Btn.down,
  KeyA: Btn.left,
  KeyD: Btn.right,
  KeyJ: Btn.attack,
  KeyK: Btn.jump,
  KeyL: Btn.dash,
  KeyU: Btn.skill,
  KeyI: Btn.superSkill,
  ArrowUp: Btn.up,
  ArrowDown: Btn.down,
  ArrowLeft: Btn.left,
  ArrowRight: Btn.right,
  Digit1: Btn.attack,
  Digit2: Btn.jump,
  Digit3: Btn.dash,
};
const keys = new Set<string>();
const p1Keys = new Set(Object.keys(KEYMAP).slice(0, 9));
function maskFor(ids: Set<string>): ButtonMask {
  let m = 0;
  for (const k of keys) if (ids.has(k)) m |= KEYMAP[k]!;
  return m;
}
window.addEventListener('keydown', (e) => keys.add(e.code));
window.addEventListener('keyup', (e) => keys.delete(e.code));

// ---------- 装配 ----------
async function boot(): Promise<void> {
  const app = new Application();
  await app.init({ width: 1000, height: 600, background: 0x0a0a12, antialias: true });
  const host = document.getElementById('stage');
  if (!host) throw new Error('#stage 缺失');
  host.appendChild(app.canvas);
  app.canvas.style.width = '100%';
  app.canvas.style.height = '100%';

  // 数据装配（与 replay.mjs 一致）
  const runtime = await fetchJson<import('@bvn/data').RuntimeFighterPackage>(
    `${BAKED}/fighters-runtime/${FIGHTER_ID}.json`,
  );
  const xfl = await fetchJson<import('@bvn/data').FighterPackage>(`${BAKED}/fighters/${FIGHTER_ID}.json`);
  const def = compileFighterRuntime(runtime, xfl);
  const mapPkg = await fetchJson<import('@bvn/data').MapPackage>(`${BAKED}/maps/${MAP_ID}.json`);
  const { stage, p1Spawn, p2Spawn } = compileMapStage(mapPkg);

  const makeSim = (): Sim =>
    new Sim({
      seed: 1,
      stage,
      // 训练模式：P2 假人（不输入），血量恒定回复不 KO，R 键重置
      training: true,
      fighters: [
        { id: 1, x: p1Spawn?.x ?? 300, y: p1Spawn?.y ?? stage.groundY, def },
        { id: 2, x: p2Spawn?.x ?? 700, y: p2Spawn?.y ?? stage.groundY, def },
      ],
    });
  let sim = makeSim();

  // 渲染装配
  const renderer = new BattleRenderer(app);
  await renderer.load({
    baseUrl: ASSETS,
    fighters: [
      { slot: 1, atlasId: FIGHTER_ID, formIndex: def.formIndex },
      { slot: 2, atlasId: FIGHTER_ID, formIndex: def.formIndex },
    ],
    mapAtlasId: MAP_ID,
  });

  // 主循环：固定 60Hz tick（accumulate）+ 每渲染帧 update
  renderer.setHint('A/D 移动  W跳  S防御  J攻击  L瞬步  U技  I必杀  R重置');
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR') sim = makeSim();
  });

  const TICK_MS = 1000 / 60;
  let acc = 0;
  let last = performance.now();
  app.ticker.add(() => {
    const now = performance.now();
    acc += Math.min(now - last, 100);
    last = now;
    let stepped = false;
    while (acc >= TICK_MS) {
      const snap = sim.tick({ p1: maskFor(p1Keys), p2: 0 });
      renderer.onSnapshot(snap);
      acc -= TICK_MS;
      stepped = true;
    }
    if (stepped || acc > 0) renderer.update(acc);
  });
}

void boot();
