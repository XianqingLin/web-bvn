import { describe, expect, it } from 'vitest';
import { Sim, enterHurt, ActionState, type FighterDef, type HitDef, type SimState } from '../../core/src/index.js';
// 注意：core 以源码相对路径引入（data 包无 @bvn/core 依赖）
import { createInitialState } from '../../core/src/state.js';
import { compileFighterForms } from '../src/fighter.js';
import { loadFighterPackage, loadRuntimeFighterPackage } from '../src/load.node.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** 真实数据受击恢复矩阵回归（2026-11-17 悬浮卡死修复）：
 *  攻击方全招式 × 受击方 8 种空中前置状态 → 600 tick 内必须落地回 idle。
 *  修复前唯一卡死组合：byakuya tk（全角色唯一 isApplyG:false 摔投）× air_hurt。 */

const BAKED = resolve(dirname(fileURLToPath(import.meta.url)), '../baked');

function realDef(id: string): FighterDef[] {
  const runtime = loadRuntimeFighterPackage(BAKED, id, 'fighters-runtime');
  const xfl = loadFighterPackage(BAKED, id);
  return compileFighterForms(runtime, xfl) as unknown as FighterDef[];
}

function makeState(byakuya: FighterDef, ichigo: FighterDef): SimState {
  return createInitialState({
    seed: 1,
    stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
    fighters: [
      { id: 1, x: 300, hp: 100000, def: byakuya },
      { id: 2, x: 700, hp: 100000, def: ichigo },
    ],
  } as never);
}

const AIR_PRESTATES: Record<string, (f: SimState['fighters'][number]) => void> = {
  air_normal: (f) => { f.y = 400; f.onGround = false; f.vy = 0; },
  air_rising: (f) => { f.y = 450; f.onGround = false; f.actionState = ActionState.JUMP_ING; f.vy = -7.5; f.dampY = 0.25; f.actLabel = '跳中'; },
  air_falling: (f) => { f.y = 380; f.onGround = false; f.actionState = ActionState.JUMP_ING; f.vy = 1; f.dampY = 0.25; f.actLabel = '落'; },
  air_jumpedelay: (f) => { f.y = 500; f.onGround = true; f.actionState = ActionState.JUMP_ING; f.jumpDelay = 3; f.actLabel = '起跳'; },
  air_attack: (f) => { f.y = 400; f.onGround = false; f.actionState = ActionState.ATTACK_ING; f.vy = 1; f.attackId = 'k1'; f.actLabel = '砍1'; },
  air_dash: (f) => { f.y = 420; f.onGround = false; f.actionState = ActionState.DASH_ING; f.isAllowBeHit = false; f.applyG = false; f.vy = 0; f.actLabel = '瞬步'; },
  air_hurt: (f) => { f.y = 400; f.onGround = false; f.actionState = ActionState.HURT_ING; f.vy = 0.5; f.dampY = 0.25; f.actLabel = '被打'; },
  air_fly: (f) => { f.y = 400; f.onGround = false; f.actionState = ActionState.HURT_FLYING; f.vy = -3; f.dampY = 0.25; f.actLabel = '击飞'; },
};

describe('真实数据受击恢复矩阵：byakuya 全招式 × ichigo 空中前置状态', () => {
  it('所有组合 600 tick 内落地回 idle（无悬浮卡死）', () => {
    const byakuya = realDef('byakuya')[0]!;
    const ichigoForms = realDef('ichigo');
    const ichigo = ichigoForms[1] ?? ichigoForms[0]!;
    const actions = Object.entries(byakuya.actions) as [string, HitDef][];
    const failures: string[] = [];
    for (const [actionId, hit] of actions) {
      for (const [pre, setup] of Object.entries(AIR_PRESTATES)) {
        const state = makeState(byakuya, ichigo);
        const f2 = state.fighters[1]!;
        setup(f2);
        enterHurt(f2, ichigo, hit, -1, !f2.onGround);
        const sim = Sim.fromState(state, [[1, byakuya], [2, ichigo]]);
        const zero = { p1: 0, p2: 0 };
        let ok = false;
        for (let i = 0; i < 600; i++) {
          const f = sim.tick(zero).state.fighters[1]!;
          if (f.onGround && f.actionState === ActionState.NORMAL) { ok = true; break; }
        }
        if (!ok) failures.push(`${actionId} × ${pre}`);
      }
    }
    expect(failures, `悬浮卡死组合:\n${failures.join('\n')}`).toHaveLength(0);
  });
});
