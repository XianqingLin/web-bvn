import { createPlayerInput } from '../input.js';
import {
  DEFAULT_HP,
  ENERGY_MAX,
  FZQI_ADD_PERFRAME,
  FZQI_MAX,
  JUMP_TIMES_START,
  type FighterState,
  type RoundEndState,
} from '../state.js';
import {
  ActionState,
  defaultSlots,
  isAttackingState,
} from '../fighter/def.js';
import { onLanded, recoverToNormal, sayIntro, setLabel } from '../fighter/machine.js';
import { tickBuffs } from '../fighter/assister.js';
import { wake, type SimCtx } from './ctx.js';
import { GRAVITY_CAP, GRAVITY_START, GRAVITY_STEP, resolveLanding } from './physics.js';

// —— 开局特写演出（intro 切片，原版 GameStartCtrler.start1v1；hold 秒 × FPS_GAME=60） ——
/** 特写 hold（原版 holdFrame 0.5s） */
const INTRO_FOCUS_TICKS = 30;
/** say→下一镜头 gap（原版 0.3s） */
const INTRO_SAY_GAP_TICKS = 18;
/** 演出收尾 resume hold（原版 0.1s）。偏离登记（2026-11-17）：6→30——原版 0.1s
 * 后字样即出，但移植版镜头 3.5→1 缓动需 ~0.5s（render updateCamera k=1-(1-1/5)^f），
 * 字样叠在拉镜过程上；30 tick（0.5s）让镜头基本回正再出字样。 */
const INTRO_RESUME_TICKS = 30;
/**
 * 开局字样时长（原版 startKOmc start 段）：gotoAndStop("start") 停 XFL index 9，
 * renderStartAndKO 每 30Hz 渲染帧手动 nextFrame，78 次进入 index 87（stop+COMPLETE
 * 帧脚本）→ 78 渲染帧 × 2 sim tick = 156。
 */
const INTRO_START_TICKS = 156;
/** Fight! 播报音 hold（startKOmc 资产帧 47 = SWF 帧 57，30Hz 贴帧音 × 2 sim tick） */
const INTRO_FIGHT_SOUND_HOLD = 92;
/**
 * Round 数字语音 hold（nummc=mc_041 声音层贴帧音，批次 68）：mc_043 帧脚本在
 * SWF 帧 27/28 两次 nummc.gotoAndPlay("r"+round)（第二次重置生效，恰为批次 67
 * 实证的弹入窗口起点 = 资产帧 18），音贴在 rN 段标签帧 +6（r4 段短 1 帧 +5，
 * SWF 帧位 16/33/50/66 与各段 stop@17/34/51/67 交叉实证）→ 资产帧 24（r1..r3）
 * /23（r4），hold =（资产帧−1）×2。r5 起走 start_final 段无数字槽无音。
 * 索引 = round−1。
 */
const INTRO_NUM_SOUND_HOLD = [46, 46, 46, 44] as const;
/** 字样段（step 7）：出场后不可跳（原版 _step<5 才可 skip） */
export const INTRO_STEP_START = 7;

// —— 回合结束演出（切片 36 团队 + 终局演出收编非训练通用；原版 GameEndCtrler） ——
/**
 * KO 字样窗口：原版 KO 后 GameCtrler.pause 500ms + KO 字样 47 帧 @30fps
 * （startKOmc ko 段，帧脚本 frame190 COMPLETE）。折算 30+94≈124，取 120（2s）。
 * 败方飞尸/慢镜头/showWinner 延迟在此窗口后由 tickRoundEnd 单独推进。
 */
export const WIN_TEXT_GATE_TICKS = 120;
/**
 * 终结慢镜头（原版 FightUI.renderEnd slowDown(2,0)）折算：败方仍击飞 →
 * 全场半速（位移/重力 ×0.5 = 原版 setSpeedPlus(SPEED_PLUS/rate)；动画 15Hz
 * = 原版 renderAnimateGap FPS_GAME/(FPS_ANIMATE/rate)-1）直到败方落地。
 */
export const SLOW_MOTION_SCALE = 0.5;
/** 慢镜头动画步进间隔（60Hz / 15Hz 动画帧 = 每 4 tick 一帧） */
export const SLOW_MOTION_ANIM_EVERY = 4;
/**
 * slowDown 全局慢放（切片 49，原版 FighterEffectCtrler.slowDown 固定 rate=1.5
 * → EffectCtrler.slowDown(1.5, t*1000)）：speedPlus = SPEED_PLUS_DEFAULT/1.5、
 * 时间轴步进间隔 ceil(FPS_GAME/(30/1.5)) = 3、时长 t×FPS_GAME 实时间。
 * 折算置位在 sim.setSlowDown；scale/animEvery 消费见 ctx.slowDownScaleOf。
 */
export const FPS_GAME = 60;
export const SLOW_DOWN_RATE = 1.5;
/**
 * 慢镜头时长 → showWinner 延迟折算门（原版 getTimer-_flyTimer < 2000ms：
 * 飞尸实时长 <2s → 延迟 2s 否则 1s；每慢 tick = 2 实 tick → 60 tick 判定）。
 */
export const SLOW_FLIGHT_TICKS_GATE = 60;
/** showWinner 延迟（原版 _showWinnerDelay 2*FPS_GAME / 1*FPS_GAME） */
export const WIN_DELAY_LONG_TICKS = 120;
export const WIN_DELAY_SHORT_TICKS = 60;
/**
 * 胜利动作 hold（原版胜利姿势 3s × FPS_GAME=60），自 winApplied 起算；
 * 换人/终局推进 = winAppliedHold + 本值（平局无 winApplied，恒
 * WIN_TEXT_GATE_TICKS + ROUND_END_TICKS）。原版的 transIn 转场不建模——
 * port 全程可跳（原版仅 step2 可跳，偏离记录）。
 */
export const ROUND_END_TICKS = 180;
/** 演出总时长（KO 字样窗口 + 胜利动作；换人/终局推进与 skip 基准）。 */
export const ROUND_END_TOTAL_TICKS = WIN_TEXT_GATE_TICKS + ROUND_END_TICKS;
/**
 * 胜方回合间血量回复基数（原版 GameEndCtrler.renderEND case1：addPercent =
 * 0.165 × (timeRate + 1)，timeRate = gameTime/gameTimeMax 剩余回合时间比，
 * gameTime == -1 时 1——多局制切片归位，此前固定 0.33 偏离登记撤销）。
 */
export const WIN_RECOVER_BASE = 0.165;

// —— 能量（原版 GameConfig/FighterMain，速率 ×SPEED_PLUS=0.5） ——
const ENERGY_ADD_NORMAL = 1; // 2 × 0.5
const ENERGY_ADD_DEFENSE = 0.4; // 0.8 × 0.5
const ENERGY_ADD_ATTACKING = 0.55; // 1.1 × 0.5
const ENERGY_ADD_OVERLOAD = 0.3; // 0.6 × 0.5
/** 训练模式血量回复（POC 取义） */
const TRAINING_REGEN = 2;

/** 必杀施法态（原版 FighterActionState.isBishaIng——不含万解）。 */
export function isBishaIngState(v: number): boolean {
  return v === ActionState.BISHA_ING || v === ActionState.BISHA_SUPER_ING;
}

/** 必杀/万解施法态（原版 FighterActionState.allowGhostStep 的排除集）。 */
export function isBishaOrWanKaiState(v: number): boolean {
  return (
    v === ActionState.BISHA_ING ||
    v === ActionState.BISHA_SUPER_ING ||
    v === ActionState.WAN_KAI_ING
  );
}

/**
 * 换人开场（原版 doBuildNextRound → start1v1(p1, p2, loseTeam)）：introTeamId
 * = 入场方（败方侧）——入场方获得特写/开场，胜方跳过（skip 语义见 IntroState）；
 * 平局全量开场。BGM 按入场方切换（原版 playFightBGM(pN.data.id)）
 * 由 app 消费 fighter:enter 事件完成。
 */
function beginIntro(ctx: SimCtx, skipSide: 0 | 1 | 2): void {
  ctx.state.intro =
    skipSide === 2
      ? { step: 3, hold: 0, skip: 2 }
      : skipSide === 1
        ? { step: 0, hold: 0, skip: 1 }
        : { step: 0, hold: 0 };
}

/** 演出结束/跳过收尾（原版 skip/startNextRound 的双方 idle()）：
 *  INTRO_ING 残留保护性清除（防软锁，批次 18 教训）+ 双方回位。 */
export function endIntro(ctx: SimCtx): void {
  for (const f of ctx.state.fighters) {
    const def = ctx.defOf(f);
    if (f.actionState === ActionState.INTRO_ING) f.actionState = ActionState.NORMAL;
    recoverToNormal(f, def);
  }
  // 字段卸下（undefined；JSON 序列化省略——见 SimState.intro 注）
  ctx.state.intro = undefined;
}

/** 开局演出状态机步进（原版 renderStart1v1 case 0-6 + showStart）。
 *  say 步不占 hold：等 开场 播完（actionState 离开 INTRO_ING 或离开
 *  开场 标签——endAct/idle/播尽 endAction 任一路径）。 */
export function stepIntroAdvance(ctx: SimCtx): void {
  const intro = ctx.state.intro;
  if (intro == null) return;
  const f1 = ctx.state.fighters[0]!;
  const f2 = ctx.state.fighters[1] ?? null;
  // 团队换人跳侧（原版 renderStart1v1 introTeamId==1 分支）：P1 入场（skip=1）
  // 的 say 段播完后直入 resume，P2 的 focus/say/gap 全部跳过
  const advance = (): void => {
    intro.step += 1;
    if (intro.step === 2 && intro.skip === 1) intro.step = 6;
  };
  if (intro.step === 1 || intro.step === 4) {
    const f = intro.step === 1 ? f1 : f2;
    if (f !== null && f.actionState === ActionState.INTRO_ING && f.actLabel === '开场') {
      return; // 仍在播
    }
    advance();
    return;
  }
  if (intro.step === INTRO_STEP_START) {
    // 开场字样播报音（修复批次 62，原版 startKOmc 声音层贴帧音）：资产帧 1
    // （= SWF 帧 11，hold 0）回合播报 sound_007 / 资产帧 47（= SWF 帧 57，
    // hold 92）Fight! sound_005。round≥5 用 start_final 段（FightUI.as:288
    // round<5 分支）→ 决胜播报 sound_006/bannerFinal（多局制收编；原版该音
    // 起于段内帧 2，取 hold 0 与 bannerRound 同款近似）。结算段 TimeOver/
    // DrawGame 音为渲染沿驱动（HUD onBanner——core 不持表现段帧数常量）。
    if (intro.hold === 0)
      ctx.emit('sound', { id: ctx.state.match.round >= 5 ? 'bannerFinal' : 'bannerRound' });
    else if (intro.hold === INTRO_FIGHT_SOUND_HOLD) ctx.emit('sound', { id: 'bannerFight' });
    // Round 数字语音（批次 68，nummc 声音层贴帧音）：round 1..4 各报 One/Two/
    // Three/Four（bannerNum1..4）；round≥5 start_final 段无数字语音
    const round = ctx.state.match.round;
    if (round >= 1 && round <= 4 && intro.hold === INTRO_NUM_SOUND_HOLD[round - 1])
      ctx.emit('sound', { id: `bannerNum${round}` });
    intro.hold += 1;
    if (intro.hold >= INTRO_START_TICKS) endIntro(ctx);
    return;
  }
  if (intro.hold < introHoldTicks(intro.step)) {
    intro.hold += 1;
    return;
  }
  // 步进 + say 步进入副作用（缺 开场 标签 = 跳过该步——原版此情形软锁，偏离）
  intro.hold = 0;
  advance();
  if (intro.step === 1 || intro.step === 4) {
    const f = intro.step === 1 ? f1 : f2;
    if (f === null || !sayIntro(f, ctx.defOf(f))) advance();
  }
}

/** 各步 hold 时长（say 步 0 = 纯等待）。 */
function introHoldTicks(step: number): number {
  if (step === 0 || step === 3) return INTRO_FOCUS_TICKS;
  if (step === 2 || step === 5) return INTRO_SAY_GAP_TICKS;
  if (step === 6) return INTRO_RESUME_TICKS;
  return 0;
}

// —— 团队回合结束/换人（切片 36，原版 GameCtrler.startNextTeamFight/nextFighter
//    + GameEndCtrler + GameStage.resetFight + GameStartCtrler.start1v1） ——

/**
 * KO → 回合结束演出置位（原版 doGameEnd → GameEndCtrler.initlize；非训练对局
 * 通用——team 换人 + 1v1 同一状态机，1v1 的结束判定自 app 层 checkKo 收编
 * 进 sim；多局制切片：置位即逐局计胜）。演出已置位不重复置位；胜方同 tick
 * 亦死（双 KO）→ draw（原版 isDrawGame）。
 * 同拍表现事件（原版 FightUI.playKO）：hit_end 打点特效 + 白闪 α0.5 + 屏震；
 * 必杀中 KO → kobg 背景层（原版 bsKO → BGEffect("kobg", 2)——地图隐藏，
 * hold 2×30 帧，移除时恢复）；平局（原版 playKO(null)）无 hit_end/白闪。
 */
export function maybeBeginRoundEnd(ctx: SimCtx, loser: FighterState): void {
  if (ctx.training || ctx.state.roundEnd != null) return;
  const teams = ctx.state.match.teams;
  const loserSide: 1 | 2 = teams
    ? teams.p1.some((s) => s.id === loser.id)
      ? 1
      : 2
    : loser.id === 1
      ? 1
      : 2;
  const winnerSide: 1 | 2 = loserSide === 1 ? 2 : 1;
  const winner = ctx.state.fighters.find((f) => f.id !== loser.id) ?? null;
  const loserSlot = teams
    ? (loserSide === 1 ? teams.p1 : teams.p2).find((s) => s.id === loser.id)
    : undefined;
  const draw = winner !== null && winner.hp <= 0;
  // 胜场逐局计（多局制切片归位，原版 doGameEnd 置位时 p1Wins++/p2Wins++——
  // 此前自 finishMatch 计一次的偏离撤销；平局不计，原版 drawGame 不走 doGameEnd）
  if (!draw) {
    if (winnerSide === 1) ctx.state.match.p1Wins += 1;
    else ctx.state.match.p2Wins += 1;
  }
  // 切人锁随 KO 收编（修复批次 63）：KO 演出接管（原版 playKO pause + KO 字样
  // → koBack resume），必杀黑幕/横幅不得悬空盖过败方特写。偏离记录：原版黑幕
  // 待锁主 endBisha 才 fadOut（与 KO 演出并行展示），移植版 KO 序列优先——锁主
  // 时间轴仍由 tickRoundEnd 的 stepAnimation 照常推进收尾（endBisha 触发无害）。
  ctx.state.cutinLock = null;
  ctx.state.roundEnd = {
    winnerSide,
    winnerId: winner?.id ?? -1,
    loserId: loser.id,
    loserQi: loser.qi,
    loserComicType: loserSlot?.comicType ?? -1,
    draw,
    winApplied: false,
    winAppliedHold: 0,
    perfect: false,
    hold: 0,
    slow: false,
    slowTicks: 0,
    winnerDelay: null,
    over: false,
  };
  ctx.emit('round:end', { round: ctx.state.match.round, winner: winnerSide });
  if (!draw) {
    ctx.emit('effect', { id: 'hit_end', x: loser.x, y: loser.y });
    // 原版 EffectCtrler.shine(0xFFFFFF, 0.5)——KO 白闪 α 与角色时间轴 shine（0.3）不同
    ctx.emit('effect', { id: 'shine', params: { color: 0xffffff, alpha: 0.5 } });
  }
  if (ctx.state.fighters.some((f) => isBishaIngState(f.actionState))) {
    ctx.emit('effect', { id: 'kobg', params: { hold: 2 } });
  }
  ctx.emit('effect', { id: 'shake', params: { x: 5, y: 0, time: 1.5 } });
}

/**
 * timeover 置位（多局制切片，原版 GameCtrler.timeover）：回合计时归零 →
 * actionEnable=false + hp 比较——高者 gameEnd（胜场逐局计）、相等 drawGame。
 * roundEnd 置位复用 KO 状态机（timerOver=true 分流表现/时间轴），无 KO 表现链
 * （原版 playTimeOver 无 hit_end/白闪/kobg/屏震）。败方未死：loserId = hp 低者。
 * 防御性卫语句：演出态已置位不重复置位（与 maybeBeginRoundEnd 同门）。
 */
function beginTimerOver(ctx: SimCtx): void {
  if (ctx.state.roundEnd != null) return;
  const [f1, f2] = ctx.state.fighters;
  const winnerSide: 1 | 2 = (f1?.hp ?? 0) >= (f2?.hp ?? 0) ? 1 : 2;
  const loserSide: 1 | 2 = winnerSide === 1 ? 2 : 1;
  const winner = winnerSide === 1 ? f1 : f2;
  const loser = winnerSide === 1 ? f2 : f1;
  const teams = ctx.state.match.teams;
  const loserSlot = teams
    ? (loserSide === 1 ? teams.p1 : teams.p2).find((s) => s.id === loser?.id)
    : undefined;
  const draw = (f1?.hp ?? 0) === (f2?.hp ?? 0);
  // 胜场逐局计（原版 timeover → gameEnd(winner, loser) → doGameEnd wins++）
  if (!draw) {
    if (winnerSide === 1) ctx.state.match.p1Wins += 1;
    else ctx.state.match.p2Wins += 1;
  }
  ctx.state.roundEnd = {
    winnerSide,
    winnerId: winner?.id ?? -1,
    loserId: loser?.id ?? -1,
    loserQi: loser?.qi ?? 0,
    loserComicType: loserSlot?.comicType ?? -1,
    draw,
    timerOver: true,
    winApplied: false,
    winAppliedHold: 0,
    perfect: false,
    hold: 0,
    slow: false,
    slowTicks: 0,
    winnerDelay: null,
    over: false,
  };
  ctx.emit('round:end', { round: ctx.state.match.round, winner: winnerSide });
}

/**
 * 回合计时步进（多局制切片，原版 GameCtrler.renderGameTime：挂在 renderAnimate
 * ——30Hz 动画帧——内，独立计数器每 31 次调用 gameTime--，归零 → timeover；
 * fightTime=60 ≈ 62 真实秒）。折算 = 每 62 tick 减 1（31 动画帧 × 2 tick）。
 * 门控 = 原版 `actionEnable && !_startCtrler && !_endCtrler`——port 由调用点
 * 保证（stepMatchFlow 仅正常管线/tickIntro skip 收尾调用；冻结/演出/特写/幽步
 * 分支不调）。偏离登记：递减相位 roundFrame % 62 === 0（原版独立计数器不随
 * 回合重置，相位对局内恒定）；slowDown 期计时照走（原版 renderAnimate 同门
 * 降频计时变慢——挂身慢放累计对局内秒级，影响可忽略）。
 */
export function stepRoundTimer(ctx: SimCtx): void {
  const m = ctx.state.match;
  if (m.gameTimeMax === -1) return;
  if (m.roundFrame % 62 !== 0) return;
  m.gameTime -= 1;
  if (m.gameTime <= 0) beginTimerOver(ctx);
}

/**
 * 演出期被动物理（stepPhysics 的无输入子集：速度衰减/重力/落地；原版 KO 后
 * actionEnable=false 只封输入位移，物理照常——胜方空中自然落地、尸体沉降）。
 * 不含行走/瞬身步/道具/推挤/抓取/牵引边界（演出期冻结，清场前无意义）。
 * @param scale 终结慢镜头半速（原版 GameCtrler.slow(2) → speedPlus 减半）：
 *   位移/重力增量 ×scale；阻尼衰减（wake）不缩——原版 damping 乘法作用于
 *   速度本体，随 speedPlus 缩放的是消费侧位移。
 */
export function stepPassivePhysics(ctx: SimCtx, f: FighterState, scale = 1): void {
  const wasAirborne = !f.onGround;
  f.vx = wake(f.vx, f.dampX);
  f.vy = wake(f.vy, f.dampY);
  f.x += f.vx * scale;
  f.y += f.vy * scale;
  // 版边钳制（修复批次 63，原版 GameLogic.fixGameSpritePosition：map.left+10/
  // right-10 对全体精灵生效——KO 飞尸/尸体同样受钳）。此前无钳，飞尸滑出版边、
  // 相机钳在版内拍空气——地图边缘 KO"拍空气"根因之一。
  f.x = Math.min(
    Math.max(f.x, ctx.state.stage.leftBound + 10),
    ctx.state.stage.rightBound - 10,
  );
  const airborne = resolveLanding(f, ctx.state.stage);
  if (airborne) {
    if (f.applyG && f.vy >= 0) {
      f.gRamp = Math.min(f.gRamp + GRAVITY_STEP * scale, GRAVITY_CAP);
      f.y += f.gRamp * scale;
    } else if (f.vy < 0) {
      f.gRamp = 0;
    }
    f.onGround = false;
  } else {
    f.gRamp = GRAVITY_START;
    if (wasAirborne) onLanded(f, ctx.defOf(f));
    f.onGround = true;
  }
}

/**
 * 1v1 回合重开（多局制切片，原版 buildNextRound(false) 净效果：GameStage.resetFight
 * 双方满血回出生点 + idle + startNextRound() 无特写——仅 startKOmc 字样重播，
 * 气保留（原版 FighterMain 实例不动）、gameTime 重置满（原版 nextRound））。
 */
function restartRound1v1(ctx: SimCtx): void {
  const m = ctx.state.match;
  ctx.state.fighters.forEach((f, i) => {
    const isP1 = i === 0;
    f.x = isP1 ? m.p1SpawnX : m.p2SpawnX;
    f.y = (isP1 ? m.p1SpawnY : m.p2SpawnY) ?? ctx.state.stage.groundY;
    f.facing = isP1 ? 1 : -1;
    f.vx = 0;
    f.vy = 0;
    f.dampX = 0;
    f.dampY = 0;
    f.gRamp = GRAVITY_START;
    f.onGround = true;
    // 满血（原版 GameLogic.resetFighterHp）
    f.hp = f.hpMax;
    // idle（原版 resetFight .idle()）：WIN_ING/受击残留清位
    if (f.actionState === ActionState.INTRO_ING) f.actionState = ActionState.NORMAL;
    recoverToNormal(f, ctx.defOf(f));
  });
  ctx.state.roundEnd = undefined;
  m.round += 1;
  m.roundFrame = 0;
  m.gameTime = m.gameTimeMax;
  clearField(ctx);
  // 字样重播（原版 startNextRound → showStart，无特写/语音）：intro 直入字样步
  //（step 7 不可跳，bannerRound/bannerFight 音由 stepIntroAdvance 驱动）
  ctx.state.intro = { step: INTRO_STEP_START, hold: 0 };
  ctx.emit('round:start', { round: m.round });
}

/** 演出计满分流：1v1 三局两胜推进或 team 换人/终局（原版 GameCtrler.runNext）。 */
export function advanceRoundEnd(ctx: SimCtx, re: RoundEndState): void {
  const m = ctx.state.match;
  const teams = m.teams;
  if (!teams) {
    // 1v1 三局两胜（多局制切片归位，原版 runNext isSingleMode 分支：
    // p1Wins<2 && p2Wins<2 → buildNextRound(false) 重开该轮，否则 fightFinish；
    // 胜场已于置位时逐局计。平局不计胜场（原版 drawGame 不走 doGameEnd）→
    // 恒重开——此前"KO 即终局/双 KO 判和局"系漏读原版 single 分支，偏离撤销）
    if (re.draw || (m.p1Wins < 2 && m.p2Wins < 2)) {
      restartRound1v1(ctx);
      return;
    }
    finishMatch(ctx, re.winnerSide);
    return;
  }
  if (re.draw) {
    // 平局（原版 startNextTeamFight drawGame 分支）：双侧均有备 → 双方换人
    // 全量开场；一侧耗尽 → 该侧判负终局；双侧耗尽 → 按胜方侧判定（原版该
    // 边角以尸体重启回合，视为缺陷修正，偏离记录）。timeover 平局时败方
    // 未死——按在场者（而非死者）定位换入位（原版 getNextFighter 不看死亡）；
    // 气继承对 timeover 平局不建模（原版残留 lastLoserData stale 语义，偏离）
    const cur1 = ctx.state.fighters.find((f) => teams.p1.some((s) => s.id === f.id))?.id;
    const cur2 = ctx.state.fighters.find((f) => teams.p2.some((s) => s.id === f.id))?.id;
    const has1 = cur1 !== undefined && teams.pending1.length > 0;
    const has2 = cur2 !== undefined && teams.pending2.length > 0;
    if (!has1 || !has2) {
      finishMatch(ctx, has1 ? 1 : 2);
      return;
    }
    // 气继承：双侧都以记录的败方气量为基准（原版 draw 分支 lastLoserData
    // 指向首个败者，偏离记录：后死者气量丢弃；KO 平局才有基准）
    rotateIn(ctx, 1, cur1!, re.loserQi, re.loserComicType);
    rotateIn(ctx, 2, cur2!, re.loserQi, re.loserComicType);
    repositionRound(ctx);
    ctx.state.roundEnd = undefined;
    m.round += 1;
    m.roundFrame = 0;
    m.gameTime = m.gameTimeMax;
    clearField(ctx);
    beginIntro(ctx, 0);
    ctx.emit('round:start', { round: m.round });
    return;
  }
  const loserSide: 1 | 2 = teams.p1.some((s) => s.id === re.loserId) ? 1 : 2;
  const pending = loserSide === 1 ? teams.pending1 : teams.pending2;
  if (pending.length === 0) {
    // 败方无备可选 → 终局（原版 nextFighter 返回 false → fightFinish；
    // timeover 败方活人同样被换下判定覆盖——原版 nextFighter 不看死亡）
    finishMatch(ctx, re.winnerSide);
    return;
  }
  rotateIn(ctx, loserSide, re.loserId, re.loserQi, re.loserComicType);
  repositionRound(ctx);
  ctx.state.roundEnd = undefined;
  m.round += 1;
  m.roundFrame = 0;
  m.gameTime = m.gameTimeMax;
  clearField(ctx);
  // 换人开场：入场方 = 败方侧（原版 introTeamId = loseTeam），获得特写/开场
  beginIntro(ctx, loserSide);
  ctx.emit('round:start', { round: m.round });
}

/**
 * 胜利姿势落位（原版 GameEndCtrler.renderEND case1：winner.win() + perfect
 * 取样（WIN 回血前）+ team 血量回复）。winAppliedHold = 落位时刻 hold——
 * 胜利动作 hold 与换人/终局推进自此起算（tickRoundEnd 的 skip 路径同样经此）。
 */
export function applyWinnerPose(ctx: SimCtx, re: RoundEndState, winner: FighterState): void {
  re.winApplied = true;
  re.winAppliedHold = re.hold;
  re.perfect = winner.hp >= winner.hpMax;
  winner.actionState = ActionState.WIN_ING;
  setLabel(winner, ctx.defOf(winner), '胜利');
  if (ctx.state.match.teams != null) {
    // 回血率 = 0.165 × (timeRate + 1)（多局制切片归位，原版
    // GameEndCtrler.renderEND case1；timeRate = 剩余回合时间比，无时限 = 1）
    const m = ctx.state.match;
    const timeRate = m.gameTimeMax === -1 ? 1 : m.gameTime / m.gameTimeMax;
    const rate = WIN_RECOVER_BASE * (timeRate + 1);
    winner.hp = Math.min(winner.hpMax, winner.hp + (winner.hpMax - winner.hp) * rate);
  }
}

/**
 * 终局（原版 fightFinish）：match:over 表现事件 + 冻结待 app 切结算。
 * 演出态保留（over=true），tickRoundEnd 继续跑动画直至场景切换。
 * 胜场已在置位时逐局计（原版 doGameEnd）。round 仍推进（原版 runNext 的
 * nextRound() 先行——终局判定在 round++ 之后）。
 */
function finishMatch(ctx: SimCtx, winner: 1 | 2): void {
  const re = ctx.state.roundEnd!;
  re.over = true;
  ctx.state.match.round += 1;
  ctx.emit('match:over', { winner });
}

/**
 * 换人入场（原版 GameCtrler.nextFighter + FighterMain 新实例）：败方位替换为
 * roster 下一名。气量继承（原版 lastLoserQi + 同 comicType +100，封顶 300）；
 * 能量/辅助气/动作槽全部新起（原版新 FighterMain 实例语义）。
 */
function rotateIn(
  ctx: SimCtx,
  side: 1 | 2,
  deadId: number,
  qiCarry: number,
  qiComicType: number,
): number {
  const teams = ctx.state.match.teams!;
  const pending = side === 1 ? teams.pending1 : teams.pending2;
  const slots = side === 1 ? teams.p1 : teams.p2;
  const nextId = pending.shift()!;
  const slot = slots.find((s) => s.id === nextId)!;
  const idx = ctx.state.fighters.findIndex((f) => f.id === deadId);
  const def = ctx.defById(slot.id, slot.formIndex);
  // 血量取槽位抄录值（TeamSlot.hp = 出生 hp，原版 nextFighter 新建
  // FighterMain 用 config hp；随状态走，fromState 恢复无需重新注入配置）
  const cfgHp = slot.hp;
  ctx.state.fighters[idx] = {
    id: slot.id,
    x: slot.x,
    y: slot.y ?? ctx.state.stage.groundY,
    vx: 0,
    vy: 0,
    dampX: 0,
    dampY: 0,
    gRamp: GRAVITY_START,
    facing: side === 1 ? 1 : -1,
    hp: cfgHp,
    qi: Math.min(
      300,
      qiCarry + (slot.comicType !== undefined && slot.comicType === qiComicType ? 100 : 0),
    ),
    actionState: 0,
    onGround: true,
    actLabel: null,
    animFrame: 0,
    labelLock: 0,
    mcHold: false,
    attackId: null,
    hurtTimer: 0,
    steelBody: false,
    energy: ENERGY_MAX,
    energyOverload: false,
    energyGap: 0,
    isAllowBeHit: true,
    beHitGap: 0,
    isCross: false,
    applyG: true,
    airMove: false,
    hurtHeavy: false,
    hurtFlyStage: 0,
    hurtFlyTimer: 0,
    hurtFlyHold: 0,
    hurtApexY: 0,
    hurtHity: 0,
    touchFloor: null,
    hpMax: cfgHp,
    airHitTimes: 1,
    hurtAction: null,
    lastHurtHitId: null,
    lastDefHitId: null,
    hitTargetChecker: null,
    hitTarget: null,
    moveTarget: null,
    formIndex: slot.formIndex,
    jumpTimes: JUMP_TIMES_START,
    jumpDelay: 0,
    ghostTicks: 0,
    ghostType: 0,
    ghostCooldown: 0,
    fzqi: FZQI_MAX,
    assistId: slot.assistId,
    buffs: { speedUp: null, attackUp: null, defenseUp: null },
    slots: defaultSlots(def),
    input: createPlayerInput(),
  };
  ctx.emit('fighter:enter', { fighter: slot.id, side });
  return slot.id;
}

/**
 * 回合重定位（原版 GameStage.resetFight）：双方回出生点、面向对手。胜方血量
 * 保持——原版 resetFighterHp 双方满血 + lastWinnerHp 回填的净效果即胜方持有
 * 恢复后血量、入场者满血（rotateIn 已按满血构造）。
 */
function repositionRound(ctx: SimCtx): void {
  const teams = ctx.state.match.teams!;
  for (const f of ctx.state.fighters) {
    const isP1 = teams.p1.some((s) => s.id === f.id);
    const slot = (isP1 ? teams.p1 : teams.p2).find((s) => s.id === f.id)!;
    f.x = slot.x;
    f.y = slot.y ?? ctx.state.stage.groundY;
    f.facing = isP1 ? 1 : -1;
    f.vx = 0;
    f.vy = 0;
    f.dampX = 0;
    f.dampY = 0;
    f.gRamp = GRAVITY_START;
    f.onGround = true;
  }
}

/** 回合清场（原版 resetFight 重建舞台的实体侧）：道具/辅助/冻结锁清除，
 *  despawn 事件照发（渲染层精灵对齐快照）。 */
function clearField(ctx: SimCtx): void {
  for (const b of ctx.state.bullets) {
    ctx.emit('entity:despawn', { kind: 'bullet', id: b.id });
  }
  for (const a of ctx.state.attackers) {
    ctx.emit('entity:despawn', { kind: 'attacker', id: a.id });
  }
  for (const a of ctx.state.assisters) {
    ctx.emit('entity:despawn', { kind: 'assister', id: a.id });
  }
  ctx.state.bullets = [];
  ctx.state.attackers = [];
  ctx.state.assisters = [];
  ctx.state.cutinLock = null;
}

// 7. 流程事件：能量回充 / 无敌窗计时 / 训练回复 / 回合计时
export function stepMatchFlow(ctx: SimCtx): void {
  if (ctx.state.tick === 0) {
    ctx.emit('round:start', { round: ctx.state.match.round });
  }
  for (const f of ctx.state.fighters) stepFighterFlow(ctx, f);
  ctx.state.match.roundFrame += 1;
  // 回合计时（多局制切片，原版 renderGameTime：仅正常管线走此步——冻结/
  // intro/演出/特写/幽步期停走，与原版 actionEnable 门控同构）
  stepRoundTimer(ctx);
}

/** 单角色流程步（stepMatchFlow/tickIntro 共享；intro 冻结期照跑 =
 *  原版 renderAnimate 无条件 renderEnergy/renderFzQi 语义）。 */
export function stepFighterFlow(ctx: SimCtx, f: FighterState): void {
  // 防御命中无敌窗（原版 renderBeHitGap：计满恢复可被命中）
  if (f.beHitGap > 0) {
    f.beHitGap -= 1;
    if (f.beHitGap === 0 && f.actionState !== ActionState.DASH_ING) {
      f.isAllowBeHit = true;
    }
  }
  // 能量回充（原版 renderEnergy：速率 ×SPEED_PLUS）
  if (f.energyGap > 0) {
    f.energyGap -= 1;
  } else if (f.energy < ENERGY_MAX) {
    if (f.energyOverload) {
      f.energy = Math.min(ENERGY_MAX, f.energy + ENERGY_ADD_OVERLOAD);
      if (f.energy > 30) f.energyOverload = false;
    } else if (f.actionState === ActionState.DEFENCE_ING) {
      f.energy += ENERGY_ADD_DEFENSE;
    } else if (isAttackingState(f.actionState)) {
      f.energy += ENERGY_ADD_ATTACKING;
    } else {
      f.energy += ENERGY_ADD_NORMAL;
    }
    if (f.energy > ENERGY_MAX) f.energy = ENERGY_MAX;
  }
  // 训练模式：血量恒定回复（2/tick，瞬回 MAX 的 1/15 秒级体感）
  if (ctx.training && f.hp > 0 && f.hp < DEFAULT_HP) {
    f.hp = Math.min(DEFAULT_HP, f.hp + TRAINING_REGEN);
  }
  // 辅助气回充（原版 FUZHU_QU_ADD_PERFRAME，无条件；满值封顶）
  if (f.fzqi < FZQI_MAX) {
    f.fzqi = Math.min(FZQI_MAX, f.fzqi + FZQI_ADD_PERFRAME);
  }
  // 增益 buff 计时（原版 FighterBuffVO render 递减；计满移除恢复基础值）
  tickBuffs(f);
}
