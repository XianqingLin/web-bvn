#!/usr/bin/env node
/**
 * sound-pack：切片 27 音效资产管线。
 *
 * 音源盘点（逆向结论见切片 27 摘要）：
 *   1. _release/extracted/.../assets/bgm/*.mp3   → assets/audio/bgm/（21 首：场景/角色专属 BGM）
 *   2. 同 assets/sound/*.mp3                     → assets/audio/se/（se_hit1/2 + se_step1~3 通用 SE）
 *   3. swf_source/embed/_sounds/LIBRARY/*.mp3    → assets/audio/swc/（主 SWF swc 音：菜单/KO/gameover）
 *   4. effect.swf -export sound                  → assets/audio/fx/<类名>.mp3（28 个命名音类，
 *                                                  EffectVO.sound 命中/光效音：snd_kan1/snd_bs/...）
 *   5. fighter/*.swf + fighter/assistant/*.swf   → assets/audio/voices/<swfId>/<类名>.mp3
 *                                                  （角色/辅助语音：snd_hurt1~3/snd_die 等命名类；
 *                                                  匿名 chid 音 = 时间轴贴帧音，另立切片不采）
 *   6. FighterTester.swf 内嵌 fight.swf 匿名音   → assets/audio/banner/（startKOmc 声音层
 *                                                  播报音：bannerRound/bannerFight/...，批次 62）
 *   产出 baked/audio.json（schema bvn/audio@1）：SE/swc/fx/banner/bgm 清单 + fighter.xml/map.xml
 *   BGM 配置 + 命中音映射（原版 EffectModel addHitEffect/addDefenseEffect/steel 烘焙）
 *   + effect 事件 → fx 音映射 + 语音类绑定（voices）。
 *
 * 用法：node tools/sound-pack/sound-pack.mjs [--ffdec PATH] [--out-assets DIR] [--out-baked FILE]
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const ROOT = resolve(import.meta.dirname, '../..');
const FFDEC = resolve(opt('ffdec', 'C:/Program Files (x86)/FFDec/ffdec-cli.exe'));
const GAME_ASSETS = resolve(
  opt('game-assets', 'OpenBleachVsNaruto/_release/extracted/swf_output/assets'),
);
const SWC_DIR = resolve(opt('swc-dir', 'OpenBleachVsNaruto/swf_source/embed/_sounds/LIBRARY'));
const FIGHTER_DIR = resolve(opt('fighter-dir', `${GAME_ASSETS}/fighter`));
const EFFECT_SWF = resolve(opt('effect-swf', `${GAME_ASSETS}/effect.swf`));
const FIGHTER_TESTER_SWF = resolve(
  opt('fighter-tester-swf', `${GAME_ASSETS}/../FighterTester.swf`),
);
const FIGHTER_XML = resolve(opt('fighter-xml', `${GAME_ASSETS}/config/fighter.xml`));
const MAP_XML = resolve(opt('map-xml', `${GAME_ASSETS}/config/map.xml`));
const BAKED_FIGHTERS = resolve(ROOT, 'packages/data/baked/fighters');
const BAKED_ASSISTANTS = resolve(ROOT, 'packages/data/baked/assistants');
const OUT_ASSETS = resolve(opt('out-assets', 'packages/data/assets/audio'));
const OUT_BAKED = resolve(opt('out-baked', 'packages/data/baked/audio.json'));
const SCRATCH = resolve(import.meta.dirname, '_scratch/sound-pack');

function run(cmd, args_) {
  console.log(`$ ${cmd} ${args_.join(' ')}`);
  execFileSync(cmd, args_, { stdio: ['ignore', 'pipe', 'inherit'] });
}

/** FFDec sound 导出文件名 "<chid>_<类名>.<ext>"（匿名 = "<chid>.<ext>"，"-1.wav" = 流头）。 */
const namedSound = (f) => {
  const m = /^-?\d+_(.+)\.(mp3|wav)$/i.exec(f);
  return m ? { cls: m[1], ext: m[2].toLowerCase() } : null;
};

// ---------- 1. 静态 mp3 拷贝（bgm / se / swc） ----------

const copyMp3s = (srcDir, destName) => {
  const dest = join(OUT_ASSETS, destName);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const files = readdirSync(srcDir).filter((f) => f.toLowerCase().endsWith('.mp3'));
  if (files.length === 0) throw new Error(`音源目录无 mp3：${srcDir}`);
  for (const f of files) cpSync(join(srcDir, f), join(dest, f));
  return files.map((f) => `${destName}/${f}`);
};

const bgmFiles = copyMp3s(join(GAME_ASSETS, 'bgm'), 'bgm');
const seFiles = copyMp3s(join(GAME_ASSETS, 'sound'), 'se');
const swcFiles = copyMp3s(SWC_DIR, 'swc');
console.log(
  `sound-pack: bgm ${bgmFiles.length} / se ${seFiles.length} / swc ${swcFiles.length} 首`,
);

// ---------- 2. FFDec 导出（effect.swf + 角色/辅助 SWF 命名音类） ----------

rmSync(SCRATCH, { recursive: true, force: true });
rmSync(join(OUT_ASSETS, 'voices'), { recursive: true, force: true }); // 旧寻址残留清理
mkdirSync(SCRATCH, { recursive: true });
if (!existsSync(FFDEC)) throw new Error(`FFDec CLI 不存在：${FFDEC}`);

const exportNamedSounds = (swfPath, scratchName) => {
  const out = join(SCRATCH, scratchName);
  run(FFDEC, ['-export', 'sound', out, swfPath]);
  // 全无声 SWF：FFDec 不建输出目录
  if (!existsSync(out)) return {};
  const map = {};
  for (const f of readdirSync(out)) {
    const named = namedSound(f);
    if (named) map[named.cls] = f;
  }
  return map;
};

// effect.swf：28 个命名音类（EffectVO.sound 命中/光效音）
run(FFDEC, ['-export', 'sound', join(SCRATCH, 'fx'), EFFECT_SWF]);
const fxDir = join(OUT_ASSETS, 'fx');
rmSync(fxDir, { recursive: true, force: true });
mkdirSync(fxDir, { recursive: true });
const fx = {};
for (const f of readdirSync(join(SCRATCH, 'fx'))) {
  const named = namedSound(f);
  if (!named) continue;
  cpSync(join(SCRATCH, 'fx', f), join(fxDir, f));
  fx[named.cls] = `fx/${f}`;
}
console.log(`sound-pack: effect.swf 命名音 ${Object.keys(fx).length}`);

// 角色/辅助 SWF：命名音类（snd_hurt*/snd_die 语音等），按 swf 基名归档。
// 寻址 = `<kind>/<id>`（修复批次 62）：fighter 与 assistant 基名 16 处相同
// （byakuya/gaara/...），旧裸 id 键的 voices 清单与 voices/<id> 资产目录互相
// 覆盖——同名 fighter 语音整包丢失/错拿辅助录音。
const swfDirs = [
  { dir: FIGHTER_DIR, kind: 'fighter' },
  { dir: join(FIGHTER_DIR, 'assistant'), kind: 'assister' },
];
const voices = {};
let voiceCount = 0;
for (const { dir, kind } of swfDirs) {
  if (!existsSync(dir)) throw new Error(`音源目录缺失：${dir}`);
  for (const f of readdirSync(dir)) {
    if (!f.toLowerCase().endsWith('.swf')) continue;
    const id = f.replace(/\.swf$/i, '');
    const named = exportNamedSounds(join(dir, f), `v_${id}`);
    if (Object.keys(named).length === 0) continue;
    const dest = join(OUT_ASSETS, 'voices', kind, id);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    const vk = `${kind}/${id}`;
    voices[vk] = {};
    for (const [cls, file] of Object.entries(named)) {
      cpSync(join(SCRATCH, `v_${id}`, file), join(dest, file));
      voices[vk][cls] = `voices/${kind}/${id}/${file}`;
      voiceCount++;
    }
  }
}
console.log(`sound-pack: 语音 swf ${Object.keys(voices).length} 包 / ${voiceCount} 音`);

/** 开场字样播报音（2.5 段填充；逻辑名 → assets/audio 相对路径） */
let banner = {};

// ---------- 2.5 开场字样播报音（banner，修复批次 62） ----------
//
// 来源 = Fight UI 内嵌 SWF（hud-pack 同源：FighterTester.swf binaryData → fight.swf）
// 的 startKOmc（sprite 228）声音层贴帧音——匿名 DefineSound（无 SymbolClass），
// 主 SWF / LIBRARY 语料都没有。dumpSWF 实证 StartSound 序（帧 = SWF sprite 1 基帧号）：
//   帧 11  sound_007 (cid 177) = 回合播报（start 段开场）
//   帧 57  sound_005 (cid 199) = Fight!（fight 段）
//   帧 96  sound_006 (cid 206) = 决胜回合播报（start_final 段，渲染侧未收编，烘焙备用）
//   帧 221 sound_009 (cid 224) = TimeOver（结算段）
//   帧 267 sound_008 (cid 227) = DrawGame（结算段）
// chid 映射硬编码（资产 git 版本化；导出数 ≠ 5 即报警断言，防止静默漂移）。
const BANNER_CHID = {
  177: 'bannerRound',
  199: 'bannerFight',
  206: 'bannerFinal',
  224: 'bannerTimeover',
  227: 'bannerDraw',
};
{
  const src = join(SCRATCH, 'banner_src');
  run(FFDEC, ['-export', 'binaryData', src, FIGHTER_TESTER_SWF]);
  const bin = readdirSync(src).find((f) => f.includes('fight_swf') && f.endsWith('.bin'));
  if (!bin) throw new Error('FighterTester.swf 未找到内嵌 fight.swf binaryData');
  const fightSwf = join(SCRATCH, 'banner_fight.swf');
  cpSync(join(src, bin), fightSwf); // 复制去 `$`（FFDec CLI 对 $ 路径报用法错误）
  const sndDir = join(SCRATCH, 'banner_snd');
  run(FFDEC, ['-export', 'sound', sndDir, fightSwf]);
  const bannerDir = join(OUT_ASSETS, 'banner');
  rmSync(bannerDir, { recursive: true, force: true });
  mkdirSync(bannerDir, { recursive: true });
  banner = {};
  for (const [chid, name] of Object.entries(BANNER_CHID)) {
    const file = readdirSync(sndDir).find((f) => new RegExp(`^${chid}\\.(mp3|wav)$`, 'i').exec(f));
    if (!file) throw new Error(`sound-pack: banner 音 ${name}（cid ${chid}）导出缺失`);
    cpSync(join(sndDir, file), join(bannerDir, `${name}.mp3`));
    banner[name] = `banner/${name}.mp3`;
  }
  console.log(`sound-pack: banner 播报音 ${Object.keys(banner).length} 个`);
}

// ---------- 3. BGM 配置（fighter.xml / map.xml） ----------

// fighter.xml：<fighter id="..">…<bgm url="assets/bgm/char_x.mp3" rate="70"/>…</fighter>
// map.xml：<map id="..">…<bgm url="assets/bgm/stg_x.mp3"/>…（random 无 bgm）
// 按元素整体扫描（非贪婪跨元素会把无 bgm 元素错绑到下一个元素的 bgm）
const scanElements = (xml, tag) => {
  const out = [];
  const re = new RegExp(`<${tag} id="([^"]+)"[\\s\\S]*?(?=<${tag} id="|</\\w+_config>)`, 'g');
  for (const m of xml.matchAll(re)) out.push(m);
  return out;
};
const fighterBgm = {};
for (const m of scanElements(readFileSync(FIGHTER_XML, 'utf8'), 'fighter')) {
  const bgm = /<bgm url="([^"]+)" rate="([^"]+)"/.exec(m[0]);
  if (bgm) fighterBgm[m[1]] = { url: `bgm/${bgm[1].split('/').pop()}`, rate: Number(bgm[2]) };
}
const mapBgm = {};
for (const m of scanElements(readFileSync(MAP_XML, 'utf8'), 'map')) {
  const bgm = /<bgm url="([^"]+)"/.exec(m[0]);
  if (bgm) mapBgm[m[1]] = `bgm/${bgm[1].split('/').pop()}`;
}
console.log(`sound-pack: fighterBgm ${Object.keys(fighterBgm).length} / mapBgm ${Object.keys(mapBgm).length}`);

// ---------- 4. 语音引用校验（baked sounds 引用 → voices 必须可解析） ----------

const missing = [];
for (const [dir, kind] of [
  [BAKED_FIGHTERS, 'fighter'],
  [BAKED_ASSISTANTS, 'assister'],
]) {
  for (const f of readdirSync(dir)) {
    const pkg = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const pkgId = pkg.id;
    for (const form of pkg.forms ?? []) {
      const s = form.sounds ?? {};
      for (const ref of [...(s.hurtSounds ?? []), s.hurtFlySound, s.dieSound]) {
        if (!ref || ref === 'null') continue;
        if (!voices[`${kind}/${pkgId}`]?.[ref]) missing.push(`${pkgId}:${ref}`);
      }
    }
  }
}
if (missing.length > 0) {
  throw new Error(`sound-pack: baked 语音引用无音源（swf 无该命名类）：\n  ${[...new Set(missing)].join('\n  ')}`);
}

// ---------- 5. baked/audio.json ----------

// 命中音映射（原版 EffectModel.addHitEffect / addDefenseEffect / steel_hit_*，键 = hitType）：
// 砍 1→snd_kan1 重砍 6→snd_kan2；打 2→snd_hit2 重打 3→snd_hit_heavy；
// 魔法 4→snd_hit2 重魔法 5→snd_mfdjx；火 7/冰 8/雷 9；摔 11→snd_hit_cache；石化 10 无音。
const HIT_SOUND = {
  byType: { 1: 'snd_kan1', 2: 'snd_hit2', 3: 'snd_hit_heavy', 4: 'snd_hit2', 5: 'snd_mfdjx', 6: 'snd_kan2', 7: 'snd_hit_fire', 8: 'snd_hit_ice', 9: 'snd_hit_dian', 11: 'snd_hit_cache' },
  // 被防御（addDefenseEffect）：砍系 fykan、打系 def、魔法/属性系 defx
  blocked: { 1: 'snd_fykan', 2: 'snd_def', 3: 'snd_defx', 4: 'snd_def', 5: 'snd_defx', 6: 'snd_fykanx', 7: 'snd_defx', 8: 'snd_defx', 9: 'snd_defx' },
  steel: 'snd_hit_steel',
  guardBreak: 'snd_mfdjx', // 原版 break_def 效果音（XG_mfdjx）
};
// effect 事件 → fx 音（原版 EffectVO.sound：jump/touch_floor/dash/ghost_step/bisha/bisha_super）
const EFFECT_SOUND = {
  jump: 'snd_jump',
  jump_air: 'snd_jump', // 空中起跳尘土（原表 EffectVO.sound 与 jump 同源 snd_jump）
  touchFloor: 'snd_luodi',
  dash: 'snd_dash_air',
  ghost_step: 'snd_ghost_step', // 幽步蓝色拖尾（切片 53，EffectVO.sound snd_ghost_step）
  bisha: 'snd_bs',
  bisha_super: 'snd_cbs',
  // 受击被动演出（切片 55；键 = core effect 事件 id，音源 = 原表 EffectVO.sound）
  replaceSkill: 'snd_fz', // replaceSp（原表 snd_fz；replaceSp2 无音）
  startEnergyExplode: 'snd_baoqi1', // explodeSp（原表 snd_baoqi1）
  endEnergyExplode: 'snd_baoqi', // explodeSp2（原表 snd_baoqi）
  fz_bleach: 'snd_dash', // 辅助出场（原表 EffectVO.sound）
  fz_naruto: 'snd_fz',
};

const doc = {
  schema: 'bvn/audio@1',
  /** 通用 SE：hit1/2 = playSoundHit1/2（攻击挥砍 whoosh）；step = 走路脚步（渲染层随机选一） */
  se: { hit1: 'se/se_hit1.mp3', hit2: 'se/se_hit2.mp3', step: ['se/se_step1.mp3', 'se/se_step2.mp3', 'se/se_step3.mp3'] },
  /** 主 SWF swc 音（swf_source/embed/_sounds）：逻辑名 → 文件 */
  swc: {
    menu1: 'swc/snd_menu1.mp3',
    menu2: 'swc/snd_menu2.mp3',
    menu5: 'swc/snd_menu5.mp3',
    ko: 'swc/snd_ko.mp3',
    koBs: 'swc/snd_ko_bs.mp3',
    gameover: 'swc/snd_gameover.mp3',
    ghostJump: 'swc/snd_ghost_jump.mp3',
    overHit: 'swc/snd_over_hit.mp3',
  },
  fx,
  /** 开场/结算字样播报音（startKOmc 声音层，修复批次 62；core intro step 7 发
   *  bannerRound/bannerFight sound 事件，audio 侧按此清单播放） */
  banner,
  /** 场景 BGM（preload.xml 预载集 + 胜利曲） */
  bgm: {
    op: 'bgm/op.mp3',
    select: 'bgm/select.mp3',
    loading: 'bgm/loading.mp3',
    back: 'bgm/back.mp3',
    congratulation: 'bgm/congratulation.mp3',
    win: 'bgm/win.mp3',
    winloop: 'bgm/winloop.mp3',
    continue: 'bgm/continue.mp3',
  },
  /** fighter.xml 角色专属 BGM（rate = 播角色曲的百分概率，否则落地图曲） */
  fighterBgm,
  mapBgm,
  hit: HIT_SOUND,
  effectSound: EFFECT_SOUND,
  voices,
};

writeFileSync(OUT_BAKED, JSON.stringify(doc));
console.log(`sound-pack: 完成 → ${OUT_BAKED}`);
