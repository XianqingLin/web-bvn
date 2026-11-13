/**
 * 音频子系统（切片 27）：WebAudio SE 池 + BGM 通道 + 语音消费。
 *
 * - 确定性纪律：core 只发 voice/sound/hit:connect 等表现事件；随机选音源、
 *   rate 门、防重叠判定全部在本层（app 层允许 Math.random）。
 * - 音源 = tools/sound-pack 产物：assets/audio/ + baked/audio.json（清单 + 命中音映射）。
 * - 触发语义对齐原版 SoundCtrler / FighterVoiceCtrler / EffectModel（映射烘焙进 audio.json）。
 * - 浏览器自动播放策略：首次用户手势（keydown/pointerdown）解锁 AudioContext。
 */
import type { Ctx, Subsystem } from './host.js';
import type { AudioManifest } from './data.js';
import { ASSETS, loadAudio } from './data.js';
import type { SimSnapshot } from '@bvn/core';

/** 受击语音绑定（原版 FighterVoiceCtrler.setVoice：kind → 音类候选集）。 */
export interface VoiceBinding {
  hurt: string[];
  hurtFly: string[];
  die: string[];
}

/** 语音音类 → 可播放 url 解析器（battle 场景按 fighter voices 清单绑定）。 */
export type VoiceResolver = (cls: string) => string | null;

/** 对局音频上下文：每个 fighter 槽位的语音绑定（battle enter 时装配）。 */
export interface BattleAudioBinding {
  fighters: { 1: { binding: VoiceBinding; resolve: VoiceResolver }; 2: { binding: VoiceBinding; resolve: VoiceResolver } };
}

/** 场景侧音频访问（未注册/未解锁时安全降级为 no-op 返回 null）。 */
export function audioOf(ctx: import('./host.js').Ctx): AudioSubsystem | null {
  return ctx.peek<AudioSubsystem>('audio') ?? null;
}

/** FighterPack.sounds → VoiceBinding（forms[formIndex].sounds 原样转接）。 */
export function voiceBindingOf(sounds: {
  hurtSounds?: string[];
  hurtFlySound?: string;
  dieSound?: string;
}): VoiceBinding {
  return {
    hurt: sounds.hurtSounds ?? [],
    hurtFly: [sounds.hurtFlySound ?? ''],
    die: [sounds.dieSound ?? ''],
  };
}

export class AudioSubsystem implements Subsystem {
  readonly id = 'audio';
  readonly deps: readonly string[] = [];

  private mf: AudioManifest | null = null;
  private ac: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private pending = new Map<string, Promise<AudioBuffer | null>>();
  private sfxGain: GainNode | null = null;
  private bgmGain: GainNode | null = null;
  private bgmSource: AudioBufferSourceNode | null = null;
  private bgmCurrent: string | null = null;
  /** 语音防重叠（原版 _channel.position < _curLength 跳过）：fighter 槽位 → 播完时刻 */
  private voiceUntil = new Map<string, number>();
  /** KO 在必杀演出窗口内 → snd_ko_bs（原版 FightUI bsKO） */
  private cutinOpen = false;

  async init(ctx: Ctx): Promise<void> {
    this.mf = await loadAudio(ctx);
    this.ac = new AudioContext();
    this.sfxGain = this.ac.createGain();
    this.sfxGain.connect(this.ac.destination);
    this.bgmGain = this.ac.createGain();
    this.bgmGain.connect(this.ac.destination);
    const unlock = () => void this.ac?.resume();
    window.addEventListener('keydown', unlock, { once: false });
    window.addEventListener('pointerdown', unlock, { once: false });
    // 解锁监听器与页面同生命周期（AppHost 不 dispose AudioSubsystem 场景流转外的宿主）
    // dev 诊断钩子（headless 冒烟用；只读）
    (window as unknown as { __bvnAudio?: () => unknown }).__bvnAudio = () => ({
      state: this.ac?.state ?? null,
      decoded: [...this.buffers.keys()],
      bgm: this.bgmCurrent,
    });
  }

  dispose(): void {
    void this.ac?.close();
    this.ac = null;
    this.buffers.clear();
    this.pending.clear();
    this.bgmSource = null;
    this.bgmCurrent = null;
    this.mf = null;
  }

  // ---------- SE / 语音 ----------

  private urlOf(kind: 'se' | 'swc' | 'fx' | 'bgm', name: string): string | null {
    const mf = this.mf;
    if (!mf) return null;
    if (kind === 'se') {
      if (name === 'hit1') return mf.se.hit1;
      if (name === 'hit2') return mf.se.hit2;
      return null;
    }
    return mf[kind][name] ?? null;
  }

  /** 懒解码（fetch → decodeAudioData；失败静默返回 null，不阻塞表现）。 */
  private async buffer(url: string): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(url);
    if (cached) return cached;
    const inflight = this.pending.get(url);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        const res = await fetch(`${ASSETS}/audio/${url}`);
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        const audio = await this.ac!.decodeAudioData(buf);
        this.buffers.set(url, audio);
        return audio;
      } catch {
        return null;
      } finally {
        this.pending.delete(url);
      }
    })();
    this.pending.set(url, p);
    return p;
  }

  /** 立即开火一发 SE（原版 SoundCtrler.playAssetSound/playSwcSound：无通道管理）。 */
  se(name: string, kind: 'se' | 'swc' | 'fx' = 'swc', vol = 1): void {
    const url = this.urlOf(kind, name);
    if (!url || !this.ac || this.ac.state !== 'running') return;
    void this.buffer(url).then((buf) => {
      if (!buf || !this.ac || !this.sfxGain) return;
      const src = this.ac.createBufferSource();
      src.buffer = buf;
      const g = this.ac.createGain();
      g.gain.value = vol;
      src.connect(g).connect(this.sfxGain);
      src.start();
    });
  }

  /** 语音类 → url（按 swf 基名查 voices 清单；battle 装配 resolver 用）。 */
  voiceUrl(swfId: string, cls: string): string | null {
    return this.mf?.voices[swfId]?.[cls] ?? null;
  }

  /** 受击语音（原版 FighterVoiceCtrler.playVoice：防重叠 + rate 门 + 随机选音）。 */
  voice(
    slot: string,
    binding: VoiceBinding,
    kind: keyof VoiceBinding,
    resolve: VoiceResolver,
    rate = 1,
  ): void {
    if (!this.ac || this.ac.state !== 'running') return;
    // rate 门（原版 Math.random() > rate → return）
    if (Math.random() > rate) return;
    // 防重叠：同一槽位语音未播完跳过
    const until = this.voiceUntil.get(slot);
    if (until !== undefined && this.ac.currentTime < until) return;
    const candidates = binding[kind].filter(Boolean);
    if (candidates.length === 0) return;
    const cls = candidates[Math.floor(Math.random() * candidates.length)]!;
    const url = resolve(cls);
    if (!url) return;
    void this.buffer(url).then((buf) => {
      if (!buf || !this.ac || !this.sfxGain) return;
      const src = this.ac.createBufferSource();
      src.buffer = buf;
      src.connect(this.sfxGain!);
      src.start();
      this.voiceUntil.set(slot, this.ac!.currentTime + buf.duration);
    });
  }

  // ---------- BGM（原版 SoundCtrler.BGM：同曲 no-op，异曲切换） ----------

  bgm(name: string | null): void {
    if (!this.ac || !this.mf) return;
    if (name === this.bgmCurrent) return;
    this.bgmCurrent = name;
    this.bgmSource?.stop();
    this.bgmSource = null;
    if (name === null) return;
    const url = this.mf.bgm[name];
    if (!url) return;
    void this.buffer(url).then((buf) => {
      if (!buf || !this.ac || !this.bgmGain) return;
      if (this.bgmCurrent !== name) return; // 切曲竞态：过期解码丢弃
      const src = this.ac.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(this.bgmGain);
      src.start();
      this.bgmSource = src;
    });
  }

  /** 对局 BGM（原版 playFightBGM：角色曲按 rate 概率，否则地图曲）。 */
  fightBgm(fighterId: string, mapId: string): void {
    const mf = this.mf;
    if (!mf) return;
    const charBgm = mf.fighterBgm[fighterId];
    if (charBgm && Math.random() * 100 <= charBgm.rate) {
      const id = Object.entries(mf.bgm).find(([, url]) => url === charBgm.url)?.[0];
      if (id) {
        this.bgm(id);
        return;
      }
    }
    const mapUrl = mf.mapBgm[mapId];
    if (mapUrl) {
      const id = Object.entries(mf.bgm).find(([, url]) => url === mapUrl)?.[0];
      if (id) {
        this.bgm(id);
        return;
      }
    }
    // 曲名不在 bgm 清单（char_*/stg_* 直接以 url 为键挂播放）
    this.bgmUrl(charBgm?.url ?? mapUrl ?? null);
  }

  private bgmUrl(url: string | null): void {
    if (!this.ac) return;
    const key = url === null ? null : `url:${url}`;
    if (key === this.bgmCurrent) return;
    this.bgmCurrent = key;
    this.bgmSource?.stop();
    this.bgmSource = null;
    if (!url) return;
    void this.buffer(url).then((buf) => {
      if (!buf || !this.ac || !this.bgmGain) return;
      if (this.bgmCurrent !== `url:${url}`) return;
      const src = this.ac.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(this.bgmGain);
      src.start();
      this.bgmSource = src;
    });
  }

  // ---------- sim 表现事件消费（battle 场景每 tick 转发） ----------

  handleSimEvents(events: SimSnapshot['events'], binding: BattleAudioBinding | null): void {
    const mf = this.mf;
    if (!mf) return;
    for (const ev of events) {
      switch (ev.type) {
        case 'sound': {
          const id = String(ev.payload['id']);
          if (id === 'step') {
            const steps = mf.se.step;
            this.se(steps[Math.floor(Math.random() * steps.length)]!, 'se');
          } else if (id === 'hit1' || id === 'hit2') {
            this.se(id, 'se');
          }
          break;
        }
        case 'effect': {
          const id = String(ev.payload['id']);
          const fx = mf.effectSound[id];
          if (fx) this.se(fx, 'fx');
          if (id === 'bisha' || id === 'wanKai') this.cutinOpen = true;
          if (id === 'endBisha' || id === 'endWanKai') this.cutinOpen = false;
          break;
        }
        case 'voice': {
          if (!binding) break;
          const fighter = ev.payload['fighter'];
          if (typeof fighter !== 'number' || (fighter !== 1 && fighter !== 2)) break;
          const kind = ev.payload['kind'];
          if (kind !== 'hurt' && kind !== 'hurtFly' && kind !== 'die') break;
          this.voice(
            String(fighter),
            binding.fighters[fighter].binding,
            kind,
            binding.fighters[fighter].resolve,
            kind === 'hurt' ? 0.5 : 1,
          );
          break;
        }
        case 'hit:connect': {
          // 命中音（原版 doHitEffect → EffectVO.sound；防御命中走 blocked 表）
          const blocked = ev.payload['blocked'] === true;
          const steel = ev.payload['steel'] === true;
          const hitType = String(ev.payload['hitType']);
          const name = blocked
            ? mf.hit.blocked[hitType]
            : steel
              ? mf.hit.steel
              : mf.hit.byType[hitType];
          if (name) this.se(name, 'fx');
          break;
        }
        case 'fighter:guardBreak': {
          this.se(mf.hit.guardBreak, 'fx');
          break;
        }
        case 'fighter:ko': {
          // KO 音（原版 FightUI：snd_over_hit → 500ms 后 snd_ko / 必杀窗口内 snd_ko_bs）
          const overHit = mf.swc.overHit;
          if (overHit) this.se(overHit, 'swc');
          const koName = this.cutinOpen ? mf.swc.koBs : mf.swc.ko;
          if (koName) window.setTimeout(() => this.se(koName, 'swc'), 500);
          break;
        }
      }
    }
  }
}
