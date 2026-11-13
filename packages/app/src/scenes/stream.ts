/**
 * 通用流帧播放器（TitleStream 泛化，切片 29 菜单流打磨：logo/winner 演出复用）。
 * 单帧解码显存可观（winner 帧 2013×1168 ~9MB），常驻小窗口 + 预取，同 menu.ts 播放语义：
 * 纹理就绪才推进播放头，身后帧 release。
 */
import { ImageSource, Texture } from 'pixi.js';
import { ASSETS } from '../data.js';

export interface StreamSpec {
  /** assets/ 下帧目录（如 'ui/winner'） */
  dir: string;
  /** 帧总数（PNG/WebP 序号 1..frames） */
  frames: number;
}

export class FrameStream {
  private readonly cache = new Map<number, Texture>();
  private readonly loading = new Map<number, Promise<Texture | null>>();
  private readonly failedFrames = new Set<number>();
  private dead = false;

  constructor(private readonly info: StreamSpec) {}

  /** 触发 [i, i+ahead] 加载；返回 i 是否已可用。 */
  ensure(i: number, ahead = 5): boolean {
    const to = Math.min(i + ahead, this.info.frames);
    for (let k = Math.max(1, i); k <= to; k++) this.load(k);
    return this.cache.has(i);
  }

  /** 加载失败帧（不重试，播放停在该帧前一位并保持背景）。 */
  failed(i: number): boolean {
    return this.failedFrames.has(i);
  }

  get(i: number): Texture | undefined {
    return this.cache.get(i);
  }

  /** 释放窗口外帧（全分辨率解码帧 ~9MB 显存，常驻窗必须小）。 */
  release(keep: (i: number) => boolean): void {
    for (const [i, tex] of this.cache) {
      if (!keep(i) && !this.loading.has(i)) {
        tex.destroy(true);
        this.cache.delete(i);
      }
    }
  }

  dispose(keep?: (i: number) => boolean): void {
    this.dead = true;
    for (const [i, tex] of this.cache) {
      if (!keep || !keep(i)) tex.destroy(true);
      else this.cache.delete(i); // 保留显示中纹理的所有权（调用方接管销毁）
    }
    if (!keep) this.cache.clear();
  }

  private load(i: number): Promise<Texture | null> {
    if (this.failedFrames.has(i)) return Promise.resolve(null);
    let p = this.loading.get(i);
    if (!p) {
      p = fetch(`${ASSETS}/${this.info.dir}/${i}.webp`)
        .then((r) => {
          if (!r.ok) throw new Error(`${r.status}`);
          return r.blob();
        })
        .then((b) => createImageBitmap(b))
        .then((bmp) => {
          if (this.dead) {
            bmp.close();
            return null;
          }
          const tex = new Texture({ source: new ImageSource({ resource: bmp }) });
          this.cache.set(i, tex);
          return tex;
        })
        .catch(() => {
          this.failedFrames.add(i);
          return null;
        })
        .finally(() => this.loading.delete(i));
      this.loading.set(i, p);
    }
    return p;
  }
}
