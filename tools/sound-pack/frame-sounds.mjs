#!/usr/bin/env node
/**
 * frame-sounds：切片 28 逐帧时间轴贴帧音管线（sound-pack 第二步，独立运行）。
 *
 * 背景（逆向结论，侦察见切片 28 摘要）：
 *   - 角色/辅助 SWF 时间轴上的匿名音（无 SymbolClass，FFDec 导出名 `<chid>.mp3`）
 *     由 Flash 播放头"进入帧"时自动触发（StartSound 标签，语义 = 帧被显示时
 *     播放，含 gotoAndPlay 跳转落点帧；跳过的帧不触发）。
 *   - 角色：root 时间轴每根帧放一个实例名 `mc` 的形态元件（与 dump 桥
 *     initMc(this.mc)/getChildByName('mc') 同源），贴帧音在该形态元件时间轴上
 *     （formIndex = root 放置帧 - 1，与 fighters-runtime forms 对齐）。
 *   - 辅助：root 本身即动画时间轴（与 dump 桥单次 sweep 同源），贴帧音在 root 上。
 *   - 嵌套元件（zh2mc/hitmc 类演出件）时间轴音不采——需要 ghost 时间轴模拟，
 *     遗留池登记；流音全语料为空流头（零 SoundStreamBlock），忽略。
 * 寻址（修复批次 62 改 `<kind>/<id>`，schema @2）：fighter 与 assistant 基名
 * 有 16 处相同，裸 id 键在 packages/files/资产目录三处互相覆盖（同名 fighter
 * 时间轴音全丢）→ 按类型分命名空间；贴帧音采集含嵌套子元件有效音轨（递归
 * 并帧，Flash 放置语义），与 XFL 实证对齐。
 *
 * 步骤：FFDec -decompress（全语料 ZWS/LZMA）→ 自研 SWF 标签解析（与 FFDec
 * -swf2xml 交叉验证过）→ FFDec -export sound 拷贝匿名音 → baked/timeline-sounds.json。
 *
 * 用法：node tools/sound-pack/frame-sounds.mjs [--ffdec PATH] [--out-assets DIR]
 *        [--out-baked FILE]
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
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
const FIGHTER_DIR = resolve(opt('fighter-dir', `${GAME_ASSETS}/fighter`));
const OUT_ASSETS = resolve(opt('out-assets', 'packages/data/assets/audio'));
const OUT_BAKED = resolve(opt('out-baked', 'packages/data/baked/timeline-sounds.json'));
const SCRATCH = resolve(import.meta.dirname, '_scratch/frame-sounds');

function run(cmd, args_) {
  execFileSync(cmd, args_, { stdio: ['ignore', 'pipe', 'inherit'] });
}

// ==================== 最小 SWF 解析器 ====================
// 只解析：DefineSprite(39) / StartSound(15) / DefineSound(14) / ShowFrame(1) /
//         FrameLabel(43, 跳过) / root 级 PlaceObject2(26)。
// 其余标签整块跳过（标签流字节对齐、长度自含，跳过不影响后续解析；
// PlaceObject3/ClipActions 变长体不解析——本管线只消费 root 级 PlaceObject2）。

class Bits {
  constructor(buf, pos = 0) {
    this.buf = buf;
    this.pos = pos;
    this.bit = 0;
  }
  align() {
    if (this.bit !== 0) {
      this.pos++;
      this.bit = 0;
    }
  }
  u(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v << 1) | ((this.buf[this.pos] >> (7 - this.bit)) & 1);
      if (++this.bit === 8) {
        this.bit = 0;
        this.pos++;
      }
    }
    return v;
  }
  s(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.u(1);
    return n === 0 ? 0 : v >= (1 << (n - 1)) ? v - (1 << n) : v;
  }
  le16() {
    this.align();
    return this.u(8) | (this.u(8) << 8);
  }
  le32() {
    this.align();
    let v = 0;
    for (let i = 0; i < 4; i++) v |= this.u(8) << (8 * i);
    return v;
  }
}

function readRect(b) {
  const n = b.u(5);
  b.s(n);
  b.s(n);
  b.s(n);
  b.s(n);
  b.align();
}
function readMatrix(b) {
  if (b.u(1)) {
    const n = b.u(5);
    b.s(n);
    b.s(n);
  }
  if (b.u(1)) {
    const n = b.u(5);
    b.s(n);
    b.s(n);
  }
  const n = b.u(5);
  b.s(n);
  b.s(n);
  b.align();
}
function readCxform(b) {
  b.align();
  const hasAdd = b.u(1);
  const hasMul = b.u(1);
  const n = b.u(4);
  if (hasMul) for (let i = 0; i < 4; i++) b.s(n);
  if (hasAdd) for (let i = 0; i < 4; i++) b.s(n);
  b.align();
}
function readString(buf, pos) {
  let end = pos;
  while (buf[end] !== 0) end++;
  return { str: buf.subarray(pos, end).toString('utf8'), next: end + 1 };
}
/** SoundInfo（StartSound 第二字段）：SyncNoMultiple/SyncStop/In/Out/Loops/Envelope。 */
function readSoundInfo(b) {
  const info = {};
  b.u(2); // reserved
  info.noMultiple = b.u(1);
  info.syncStop = b.u(1);
  const hasEnv = b.u(1);
  const hasLoops = b.u(1);
  const hasOut = b.u(1);
  const hasIn = b.u(1);
  if (hasIn) b.le32();
  if (hasOut) b.le32();
  if (hasLoops) info.loops = b.le16();
  if (hasEnv) {
    // 音量包络（淡入淡出曲线）：移植版全音量播放，偏离登记
    const pts = b.u(8);
    for (let i = 0; i < pts; i++) {
      b.le32(); // Pos44
      b.le16(); // LeftLevel
      b.le16(); // RightLevel
    }
  }
  b.align();
  return info;
}

function readTag(buf, pos) {
  const v = buf[pos] | (buf[pos + 1] << 8);
  const code = v >> 6;
  if ((v & 0x3f) !== 0x3f) return [code, v & 0x3f, pos + 2];
  const len = buf.readUInt32LE(pos + 2);
  return [code, len, pos + 6];
}

/**
 * 解析标签流。返回 { frames, places, startSounds, defSounds, sprites }；
 * sprites[id] = { frameCount, frames, startSounds }（仅直接子标签，嵌套不计入父）。
 */
function parseTags(buf, pos, end, out) {
  while (pos < end) {
    const [code, len, next] = readTag(buf, pos);
    const body = buf.subarray(next, next + len);
    switch (code) {
      case 0: // End
        return;
      case 1: // ShowFrame
        out.frames++;
        break;
      case 14: { // DefineSound
        const id = body.readUInt16LE(0);
        out.defSounds.add(id);
        break;
      }
      case 15: { // StartSound
        const sid = body.readUInt16LE(0);
        const info = readSoundInfo(new Bits(body, 2));
        out.startSounds.push({ frame: out.frames + 1, sid, ...info });
        break;
      }
      case 26: { // PlaceObject2（root 级才解析内容）
        const b = new Bits(body, 0);
        const hasClipActions = b.u(1);
        const hasClipDepth = b.u(1);
        const hasName = b.u(1);
        const hasRatio = b.u(1);
        const hasColor = b.u(1);
        const hasMatrix = b.u(1);
        const hasChar = b.u(1);
        b.u(1); // Move
        const p = { depth: b.le16() };
        if (hasChar) p.charId = b.le16();
        if (hasMatrix) readMatrix(b);
        if (hasColor) readCxform(b);
        if (hasRatio) p.ratio = b.le16();
        if (hasName) {
          b.align();
          const s = readString(b.buf, b.pos);
          p.name = s.str;
          b.pos = s.next;
        }
        if (hasClipDepth) b.le16();
        if (hasClipActions) throw new Error('root PlaceObject2 带 ClipActions，解析器未支持');
        out.places.push({ frame: out.frames + 1, ...p });
        break;
      }
      case 39: { // DefineSprite：CharId UI16 + FrameCount UI16 + 子标签流
        const id = body.readUInt16LE(0);
        const frameCount = body.readUInt16LE(2);
        const sub = { frames: 0, places: [], startSounds: [], defSounds: new Set() };
        parseTags(body, 4, body.length, sub);
        out.sprites[id] = {
          frameCount,
          frames: sub.frames,
          startSounds: sub.startSounds,
          places: sub.places,
        };
        for (const sid of sub.defSounds) out.defSounds.add(sid);
        break;
      }
      default:
        break; // 其余整块跳过
    }
    pos = next + len;
  }
}

/** 解压后 SWF → 解析结果（跳过 header/RECT/frame rate）。 */
function parseSwf(swfPath) {
  const raw = readFileSync(swfPath);
  const sig = raw.subarray(0, 3).toString('latin1');
  if (sig !== 'FWS') throw new Error(`期望 FWS（需先 FFDec decompress）：${sig} @ ${swfPath}`);
  const body = raw.subarray(8);
  const b = new Bits(body, 0);
  readRect(b);
  b.align();
  const out = { frames: 0, places: [], startSounds: [], defSounds: new Set(), sprites: {} };
  parseTags(body, b.pos + 4, body.length, out);
  return out;
}

// ==================== 有效音轨（Flash 嵌套语义） ====================

/**
 * 递归有效音轨：sprite 时间轴上实际会响的 StartSound（修复批次 62）。
 * Flash 语义：子元件被放置即随父播放头 1:1 前进，其贴帧音并入父帧号
 * = 放置帧 + 子帧 - 1。直连音（ichigo 系）+ 嵌套音（byakuya 系：声音在
 * root mc 下的 AImain/mc 包装层内，XFL 实证 mc_028/mc_069 声音层）统一收敛。
 * 返回 { [frame]: [{sid, loops?}] }；memo 防重、栈防环。
 */
function effectiveSounds(charId, sprites, memo, stack = new Set()) {
  if (memo.has(charId)) return memo.get(charId);
  const sp = sprites[charId];
  const out = {};
  if (sp) {
    if (stack.has(charId)) return out; // 循环放置防御（正常语料不出现）
    stack.add(charId);
    const push = (frame, item) => {
      if (frame >= 1) (out[frame] ??= []).push(item);
    };
    for (const ss of sp.startSounds) {
      push(ss.frame, ss.loops > 1 ? { sid: ss.sid, loops: ss.loops } : { sid: ss.sid });
    }
    for (const p of sp.places) {
      if (p.charId == null || !sprites[p.charId]) continue;
      const sub = effectiveSounds(p.charId, sprites, memo, stack);
      for (const [f, items] of Object.entries(sub)) {
        for (const it of items) push(p.frame + Number(f) - 1, it);
      }
    }
    stack.delete(charId);
  }
  memo.set(charId, out);
  return out;
}

// ==================== 主流程 ====================

if (!existsSync(FFDEC)) throw new Error(`FFDec CLI 不存在：${FFDEC}`);
rmSync(SCRATCH, { recursive: true, force: true });
rmSync(join(OUT_ASSETS, 'timeline'), { recursive: true, force: true }); // 旧寻址残留清理
mkdirSync(SCRATCH, { recursive: true });

const swfDirs = [
  { dir: FIGHTER_DIR, kind: 'fighter' },
  { dir: join(FIGHTER_DIR, 'assistant'), kind: 'assister' },
];
const packages = {};
const files = {};
let soundCount = 0;

for (const { dir, kind } of swfDirs) {
  if (!existsSync(dir)) throw new Error(`音源目录缺失：${dir}`);
  for (const f of readdirSync(dir)) {
    if (!f.toLowerCase().endsWith('.swf')) continue;
    const id = f.replace(/\.swf$/i, '');

    // 1) 解压（全语料 ZWS/LZMA；FWS 直接用）
    const dec = join(SCRATCH, `${id}.swf`);
    cpSync(join(dir, f), dec);
    const sig3 = readFileSync(dec).subarray(0, 3).toString('latin1');
    if (sig3 !== 'FWS') {
      const raw = join(SCRATCH, `${id}.raw.swf`);
      run(FFDEC, ['-decompress', dec, raw]);
      cpSync(raw, dec);
    }

    // 2) 解析 + 采集
    const swf = parseSwf(dec);
    const entry = {};
    // 有效音轨 memo 按 SWF 独立（sprite charId 只在单 SWF 内唯一，跨包共享
    // memo 会串包——首版教训：orochimaru/renji 被前包同 id sprite 污染清空）
    const effMemo = new Map();

    if (kind === 'fighter') {
      // 角色：root 每根帧的 'mc' 放置 → 形态元件。formIndex 对齐 data 层编译
      // 规则（compileFighterForms 过滤 totalFrames==0 的空形态后按下标）：
      // SWF 侧 = root 帧 'mc' 放置的序（无放置的根帧 = 空形态，编译层跳过）
      const mcPlacements = swf.places
        .filter((p) => p.name === 'mc' && p.charId != null)
        .sort((a, b) => a.frame - b.frame);
      for (const [formIndex, p] of mcPlacements.entries()) {
        const sprite = swf.sprites[p.charId];
        if (!sprite) throw new Error(`${id}: root f${p.frame} 'mc' → sprite ${p.charId} 不存在`);
        // 有效音轨（修复批次 62）：直连 + 嵌套子元件贴帧音并入形态时间轴帧号
        const eff = effectiveSounds(p.charId, swf.sprites, effMemo);
        const sounds = {};
        for (const [frame, items] of Object.entries(eff)) {
          for (const it of items) {
            // 无 DefineSound 的 StartSound（嵌套链偶见，grimmjow sid79 实证）= 原
            // 版哑引用（Flash 播放头照样过帧但无声），剔除不报警致命——下游
            // "无导出文件"校验（步骤 4）兜底同类问题
            if (!swf.defSounds.has(it.sid)) continue;
            (sounds[frame] ??= []).push(it);
          }
        }
        if (Object.keys(sounds).length > 0) entry[formIndex] = sounds;
      }
    } else {
      // 辅助：root 即动画时间轴
      if (swf.startSounds.length > 0) {
        const sounds = {};
        for (const ss of swf.startSounds) {
          if (!swf.defSounds.has(ss.sid)) throw new Error(`${id}: StartSound sid ${ss.sid} 无 DefineSound`);
          (sounds[ss.frame] ??= []).push(
            ss.loops > 1 ? { sid: ss.sid, loops: ss.loops } : { sid: ss.sid },
          );
        }
        entry.root = sounds;
      }
    }

    // 3) 匿名音导出拷贝（FFDec 命名 `<chid>.mp3`；`-1.wav` = 空流头跳过）。
    // 寻址 = `<kind>/<id>`（修复批次 62）：fighter 与 assistant 基名有 16 处
    // 相同（byakuya/gaara/...），旧裸 id 键在 packages/files/timeline/<id> 三处
    // 互相覆盖——同名角色时间轴音全丢 + 同 chid 文件串包
    const ns = `${kind}/${id}`;
    const expDir = join(SCRATCH, `exp_${id}`);
    run(FFDEC, ['-export', 'sound', expDir, dec]);
    let copied = 0;
    if (existsSync(expDir)) {
      for (const sf of readdirSync(expDir)) {
        const m = /^(\d+)\.(mp3|wav)$/i.exec(sf);
        if (!m) continue;
        const destDir = join(OUT_ASSETS, 'timeline', kind, id);
        mkdirSync(destDir, { recursive: true });
        cpSync(join(expDir, sf), join(destDir, sf));
        files[`${ns}/${m[1]}`] = `timeline/${kind}/${id}/${sf}`;
        copied++;
      }
    }

    // 4) 校验：引用的 sid 必须有导出文件（FFDec 导出失败的音报警并剔除）
    let dropped = 0;
    for (const key of Object.keys(entry)) {
      const sounds = entry[key];
      for (const frame of Object.keys(sounds)) {
        sounds[frame] = sounds[frame].filter((s) => {
          if (files[`${ns}/${s.sid}`]) return true;
          console.warn(`frame-sounds: ${ns} 帧${frame} sid ${s.sid} 无导出文件（剔除）`);
          dropped++;
          return false;
        });
        if (sounds[frame].length === 0) delete sounds[frame];
      }
      if (Object.keys(sounds).length === 0) delete entry[key];
    }

    if (Object.keys(entry).length > 0) {
      packages[ns] = kind === 'fighter' ? { forms: entry } : entry;
      const total = Object.values(entry).reduce(
        (a, s) => a + Object.values(s).reduce((x, l) => x + l.length, 0),
        0,
      );
      soundCount += total;
      console.log(
        `frame-sounds: ${ns} frames 音轨 ${total} 事件 / 匿名音 ${copied} 个${
          dropped ? ` / 剔除 ${dropped}` : ''
        }`,
      );
    }
  }
}

const doc = {
  schema: 'bvn/timeline-sounds@2',
  /** `<kind>/<swfId>` → 角色：{ [formIndex]: { [frame]: [{sid, loops?}] } }；辅助：{ root: {...} } */
  packages,
  /** `<kind>/<swfId>/<sid>` → 音频 url（assets/audio 相对路径） */
  files,
};
mkdirSync(resolve(OUT_BAKED, '..'), { recursive: true });
writeFileSync(OUT_BAKED, JSON.stringify(doc));
console.log(
  `frame-sounds: 完成 → ${OUT_BAKED}（${Object.keys(packages).length} 包 / ${soundCount} 事件 / ${
    Object.keys(files).length
  } 匿名音）`,
);
