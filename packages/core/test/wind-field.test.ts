import { describe, expect, it } from 'vitest';
import {
  Btn,
  Sim,
  SPEED_PLUS,
  stepAssisterCustomFunc,
  type AssisterContext,
  type AssisterCustomFunc,
  type AssisterDef,
  type AssisterState,
  type FighterDef,
  type FighterState,
  type SimConfig,
  type SimSnapshot,
  type StageState,
} from '../src/index.js';

/**
 * 切片 24·B4 机制测试：temari 风场（windField customFunc）。
 *
 * 原版语义（f_assistant/temari DOMDocument.xml 逆向）：
 *  - 注册帧采样 targetHeavy → LEVEL[min(heavy,len)-1]、finalSpeed = targetSpeed × level、
 *    selfDirect（闭包捕获，注册后不随转向变化）；
 *  - 每动画帧：敌方弹 sp.speedLevel = level × direct（同向 -level 加速 / 逆风 level 减速），
 *    目标非 HURT_DOWN(23) 时 targetSP.x += finalSpeed × selfDirect；
 *  - 注册帧 owner speedUp(ownerSpeed × 0.25, 6)；
 *  - removeCustomFunc 帧全部停止。
 *
 * 移植模型：弹速级为派生值（stepBullets 按在场风场辅助实时求值，不进 SimState）；
 * 拉扯/owner buff 为触发器 op 直写。合成辅助时间轴（帧号 1 基）：f2 注册风场 +
 * buffSpeedUpByOwnerSpeed(0.25, 6)，可选 fN removeCustomFunc，totalFrames 40 播尽退场。
 */

const HIT = {
  power: 10,
  hitType: 1,
  hitx: 3,
  hity: 0,
  hurtTime: 300,
  hurtType: 0,
  isBreakDef: false,
  isApplyG: true,
};

/** 弹速发射参数（sx=5 → 每 tick 位移 5×SPEED_PLUS=2.5 基准）。 */
const FIRE_PARAMS = { x: 5, hold: 60, hits: 1 };

function makeFighterDef(opts: { fire?: boolean; heavy?: number; speed?: number } = {}): FighterDef {
  const fire = opts.fire !== false;
  const labels: FighterDef['labels'] = {
    站立: { index: 0, duration: 9 },
    走: { index: 9, duration: 24 },
    被打: { index: 71, duration: 8 },
    招1: { index: 180, duration: 30 },
  };
  const areas: FighterDef['areas'] = {};
  for (let fr = 1; fr <= 220; fr++) {
    const list: FighterDef['areas'][number] = [{ name: 'bdmn', x: -10, y: -40, w: 20, h: 40 }];
    if (fr === 185 || fr === 186) list.push({ name: 'zh1atm', x: 10, y: -40, w: 30, h: 30 });
    areas[fr] = list;
  }
  return {
    id: 'test-f',
    formIndex: 0,
    speed: opts.speed ?? 6,
    jumpPower: 15,
    heavy: opts.heavy ?? 3,
    actions: { zh1: { ...HIT } },
    labels,
    areas,
    totalFrames: 220,
    triggers: fire
      ? [{ frame: 185, target: 'mc', op: 'fire', args: ['zh1atm', FIRE_PARAMS] }]
      : [],
    attackLabels: { zh1: '招1' },
  };
}

function makeWindAssistDef(opts: { removeFrame?: number } = {}): AssisterDef {
  const triggers: AssisterDef['triggers'] = [
    {
      frame: 2,
      target: 'assister',
      op: 'addCustomFunc',
      args: [{ kind: 'windField', levels: [0.8, 0.65, 0.5] }],
    },
    { frame: 2, target: 'fighter', op: 'buffSpeedUpByOwnerSpeed', args: [0.25, 6] },
  ];
  if (opts.removeFrame !== undefined) {
    triggers.push({ frame: opts.removeFrame, target: 'assister', op: 'removeCustomFunc', args: [] });
  }
  return {
    id: 't-wind',
    actions: {},
    labels: {},
    areas: {},
    totalFrames: 40,
    triggers,
    loopTriggers: [],
  };
}

function makeConfig(
  opts: { removeFrame?: number; p2Heavy?: number; p1Fire?: boolean; p2Fire?: boolean } = {},
): SimConfig {
  return {
    seed: 1,
    stage: { leftBound: 0, rightBound: 1000, groundY: 500, bottomY: 600, floors: [] },
    fighters: [
      { id: 1, x: 300, def: makeFighterDef({ fire: opts.p1Fire }), assistId: 't-wind' },
      { id: 2, x: 700, def: makeFighterDef({ fire: opts.p2Fire, heavy: opts.p2Heavy }) },
    ],
    assistants: { 't-wind': makeWindAssistDef({ removeFrame: opts.removeFrame }) },
  };
}

function runTicks(sim: Sim, ticks: number, input: (i: number) => number = () => 0): SimSnapshot[] {
  const out: SimSnapshot[] = [];
  for (let i = 0; i < ticks; i++) out.push(sim.tick({ p1: input(i), p2: 0 }));
  return out;
}

/** 召唤 p1 辅助并跑到 windField 注册（customFunc 非空），返回该快照。 */
function summonUntilActive(sim: Sim, maxTicks = 40): SimSnapshot {
  sim.tick({ p1: Btn.assist, p2: 0 });
  sim.tick({ p1: Btn.assist, p2: 0 });
  for (let i = 0; i < maxTicks; i++) {
    const s = sim.tick({ p1: 0, p2: 0 });
    if ((s.state.assisters[0]?.customFunc ?? null) !== null) return s;
  }
  throw new Error('windField 未注册');
}

/** 发射 p2 一枚弹并跑到弹体出现，返回该快照。 */
function fireUntilBullet(sim: Sim, maxTicks = 80): SimSnapshot {
  sim.tick({ p1: 0, p2: Btn.skill });
  sim.tick({ p1: 0, p2: Btn.skill });
  for (let i = 0; i < maxTicks; i++) {
    const s = sim.tick({ p1: 0, p2: 0 });
    if (s.state.bullets.length > 0) return s;
  }
  throw new Error('弹体未生成');
}

describe('切片 24·B4：temari 风场', () => {
  it('敌弹减速（逆风 level）；同队弹不受风（原版 isSelfTeam 守卫）', () => {
    // 双方均带 fire 触发：p1 弹（同队）恒 2.5/tick；p2 弹逆风 speedLevel=0.5
    const sim = new Sim(makeConfig({ p1Fire: true, p2Fire: true }));
    summonUntilActive(sim);
    sim.tick({ p1: Btn.skill, p2: Btn.skill });
    sim.tick({ p1: Btn.skill, p2: Btn.skill });
    let both: SimSnapshot | null = null;
    for (let i = 0; i < 80; i++) {
      const s = sim.tick({ p1: 0, p2: 0 });
      if (s.state.bullets.length === 2) {
        both = s;
        break;
      }
    }
    expect(both).not.toBeNull();
    const b1 = both!.state.bullets.find((b) => b.ownerId === 1)!;
    const b2 = both!.state.bullets.find((b) => b.ownerId === 2)!;
    expect(b1.facing).toBe(1);
    expect(b2.facing).toBe(-1);
    const [x1, x2] = [b1.x, b2.x];
    sim.tick({ p1: 0, p2: 0 });
    const after = sim.tick({ p1: 0, p2: 0 });
    // p1 弹（风场 owner 同队跳过）：5×0.5=2.5/tick → 2 tick +5
    expect(after.state.bullets.find((b) => b.id === b1.id)!.x - x1).toBeCloseTo(5, 6);
    // p2 弹（逆风）：5×0.5×(1-0.5)=1.25/tick → 2 tick -2.5
    expect(after.state.bullets.find((b) => b.id === b2.id)!.x - x2).toBeCloseTo(-2.5, 6);
  });

  it('敌弹同向（facing==direct）加速：speedLevel=-level', () => {
    // p2 转身向右走（facing 翻为 1）后发弹——弹向与风场 direct 同向 → 加速
    const sim = new Sim(makeConfig({ p2Fire: true }));
    summonUntilActive(sim);
    for (let i = 0; i < 4; i++) sim.tick({ p1: 0, p2: Btn.right });
    sim.tick({ p1: 0, p2: Btn.skill });
    sim.tick({ p1: 0, p2: Btn.skill });
    let spawn: SimSnapshot | null = null;
    for (let i = 0; i < 80; i++) {
      const s = sim.tick({ p1: 0, p2: 0 });
      if (s.state.bullets.length > 0) {
        spawn = s;
        break;
      }
    }
    expect(spawn).not.toBeNull();
    const b = spawn!.state.bullets[0]!;
    expect(b.facing).toBe(1);
    const x0 = b.x;
    sim.tick({ p1: 0, p2: 0 });
    const after = sim.tick({ p1: 0, p2: 0 });
    // 5×0.5×(1-(-0.5))=3.75/tick → 2 tick +7.5
    expect(after.state.bullets[0]!.x - x0).toBeCloseTo(7.5, 6);
  });

  it('heavy 采样：LEVEL[min(heavy,len)-1]（heavy=1 → level 0.8，减速更强）', () => {
    const sim = new Sim(makeConfig({ p2Heavy: 1 }));
    summonUntilActive(sim);
    const spawn = fireUntilBullet(sim);
    const b = spawn.state.bullets[0]!;
    expect(b.ownerId).toBe(2);
    const x0 = b.x;
    sim.tick({ p1: 0, p2: 0 });
    const after = sim.tick({ p1: 0, p2: 0 });
    // 5×0.5×(1-0.8)=0.5/tick → 2 tick -1
    expect(after.state.bullets[0]!.x - x0).toBeCloseTo(-1, 6);
  });

  it('风场拉扯：目标每动画帧 +finalSpeed×direct×SPEED_PLUS，召唤者免疫', () => {
    const sim = new Sim(makeConfig());
    const active = summonUntilActive(sim);
    const [p1x0, p2x0] = [active.state.fighters[0]!.x, active.state.fighters[1]!.x];
    // 20 tick = 10 动画帧 × 3×1×0.5 = +15（注册当步的拉扯已含于 active 快照）
    const last = runTicks(sim, 20).at(-1)!;
    const p1 = last.state.fighters[0]!;
    const p2 = last.state.fighters[1]!;
    expect(p2.x - p2x0).toBeCloseTo(15, 6);
    expect(p1.x).toBe(p1x0); // 只有 owner 的目标被拉扯
  });

  it('buffSpeedUpByOwnerSpeed：owner 基速 × rate 存原值，消费时 ×SPEED_PLUS', () => {
    const sim = new Sim(makeConfig());
    const active = summonUntilActive(sim);
    const buff = active.state.fighters[0]!.buffs.speedUp;
    expect(buff).not.toBeNull();
    expect(buff!.value).toBeCloseTo(6 * 0.25, 6); // ownerDef.speed × rate（原值存储）
    expect(buff!.holdTicks).toBeGreaterThan(300); // 6×60=360 起，注册后逐 tick 递减
    expect(active.state.fighters[1]!.buffs.speedUp).toBeNull(); // 仅 owner
  });

  it('removeCustomFunc 后拉扯停止、弹体恢复常速；辅助退场后风场不再作用', () => {
    const sim = new Sim(makeConfig({ removeFrame: 14 }));
    summonUntilActive(sim);
    // 拉扯中：6 tick = 3 动画帧 = +4.5
    const pulled = runTicks(sim, 6).at(-1)!;
    const p2x0 = pulled.state.fighters[1]!.x;
    const afterPull = runTicks(sim, 6).at(-1)!;
    expect(afterPull.state.fighters[1]!.x - p2x0).toBeCloseTo(4.5, 6);
    // 等注销（辅助仍在场，totalFrames 40 未到）
    let released: SimSnapshot | null = null;
    for (let i = 0; i < 60; i++) {
      const s = sim.tick({ p1: 0, p2: 0 });
      if (s.state.assisters[0] !== undefined && s.state.assisters[0]!.customFunc === null) {
        released = s;
        break;
      }
    }
    expect(released).not.toBeNull();
    expect(released!.state.assisters).toHaveLength(1);
    // 拉扯停止：站立 vx=0 → x 不再变化
    const stopped = runTicks(sim, 8).at(-1)!;
    expect(stopped.state.fighters[1]!.x).toBe(released!.state.fighters[1]!.x);
    // 弹体恢复常速：5×0.5=2.5/tick（speedLevel 派生值随手注销归零）
    const spawn = fireUntilBullet(sim);
    const bx0 = spawn.state.bullets[0]!.x;
    sim.tick({ p1: 0, p2: 0 });
    const mid = sim.tick({ p1: 0, p2: 0 });
    expect(mid.state.bullets[0]!.x - bx0).toBeCloseTo(-5, 6);
    // 辅助播尽退场后：同枚弹仍常速
    let last: SimSnapshot | null = null;
    let gone = false;
    for (let i = 0; i < 120 && !gone; i++) {
      last = sim.tick({ p1: 0, p2: 0 });
      gone = last.state.assisters.length === 0;
    }
    expect(gone).toBe(true);
    const bLate0 = last!.state.bullets[0]!.x;
    sim.tick({ p1: 0, p2: 0 });
    const late = sim.tick({ p1: 0, p2: 0 });
    expect(late.state.bullets[0]!.x - bLate0).toBeCloseTo(-5, 6);
  });

  describe('windField 拉扯门（单元：stepAssisterCustomFunc）', () => {
    const WIND: AssisterCustomFunc = { kind: 'windField', level: 0.5, finalSpeed: 3, direct: 1 };

    function makeCtx(direct: 1 | -1, targetState: number): { ctx: AssisterContext; target: FighterState } {
      const owner = { id: 1, x: 300 } as unknown as FighterState;
      const target = { id: 2, x: 700, actionState: targetState } as unknown as FighterState;
      const self = {
        id: 100,
        ownerId: 1,
        facing: direct,
        customFunc: { ...WIND, direct },
      } as unknown as AssisterState;
      const ctx: AssisterContext = {
        self,
        def: makeWindAssistDef(),
        owner,
        ownerDef: null,
        ownerTargetDef: null,
        fighters: [owner, target],
        stage: {
          leftBound: 0,
          rightBound: 1000,
          groundY: 500,
          bottomY: 600,
          floors: [],
        } as unknown as StageState,
        emit: () => {},
        spawnAssistBullet: () => {},
        spawnAssistAttacker: () => {},
        remove: () => {},
        setCutin: () => {},
        getAttacker: () => null,
        gotoAndPlayAttacker: () => {},
        stopFollowAttacker: () => {},
        removeAttacker: () => {},
      };
      return { ctx, target };
    }

    it('HURT_DOWN(23) 卫语句：倒地目标不拉扯（原版 getTargetState()==23 return）', () => {
      const { ctx, target } = makeCtx(1, 23);
      stepAssisterCustomFunc(ctx);
      expect(target.x).toBe(700);
    });

    it('非倒地：每步 +finalSpeed×direct×SPEED_PLUS；direct=-1 反向', () => {
      const a = makeCtx(1, 0);
      stepAssisterCustomFunc(a.ctx);
      expect(a.target.x).toBeCloseTo(700 + 3 * 1 * SPEED_PLUS, 10);
      const b = makeCtx(-1, 0);
      stepAssisterCustomFunc(b.ctx);
      expect(b.target.x).toBeCloseTo(700 + 3 * -1 * SPEED_PLUS, 10);
    });
  });
});
