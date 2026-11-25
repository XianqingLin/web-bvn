/**
 * 通用流帧播放器（TitleStream 泛化，切片 29 菜单流打磨：logo 演出复用）。
 * 单帧解码显存可观，解码纹理常驻小窗口 + 预取，同 menu.ts 播放语义：
 * 纹理就绪才推进播放头，身后帧 release。
 *
 * 两层缓存（2026-11-17：部署环境逐帧边播边下载供不上 30fps）：
 * 压缩帧全量预下载为 blob（总量 ~MB 级，网络层一次性吃完延迟），
 * 解码纹理按需从本地 blob 生成（几十 ms 级，走小窗常驻控显存）。
 * blob 层为跨实例共享缓存（2026-11-24 切片 46）：装载页预载 / 上一场景释放后，
 * 同目录新流零重取（回菜单即时开播）；lazy 流（叠加层小流）构造期不点火预取。
 */
import { ImageSource, Texture } from 'pixi.js';
import { loadSheetFrames, type StreamSheetSpec } from '@bvn/render';
import { ASSETS } from '../data.js';

export interface StreamSpec {
  /** assets/ 下帧目录（如 'ui/title'） */
  dir: string;
  /** 帧总数（PNG/WebP 序号 1..frames） */
  frames: number;
  /** 实际显示下界（缺省 1）：预下载/预取只覆盖 [from, to]，区间外帧不拉不存
   *  （2026-11-17：menu 帧流 1、76-90 从不显示却占 ~1.6MB，3Mbps 下 ≈4.5s） */
  from?: number;
  /** 实际显示上界（缺省 frames） */
  to?: number;
  /** 构造期不点火全量 blob 预下载（逐帧按需 ensure 拉取）。
   *  供叠加层类小流用：多条流构造期同时全量预取会打满 HTTP 连接池，
   *  把同场景紧随其后的其它请求（贴图/板首帧）压到队尾（切片 46 实测 4.4s）。 */
  lazy?: boolean;
  /** 帧去重映射（tools/stream-dedup 产物）：播放头槽位（1-based）→ 磁盘帧号。
   *  播放头时序语义不变（frames 仍为槽位总数），仅文件寻址经此映射；
   *  缺省恒等（无去重流 / 旧清单兼容）。 */
  map?: number[];
}

/** 跨实例共享 blob 缓存（URL → fetch promise）：装载页预载过 / 上一场景流释放后，
 *  同目录新流零重取（2026-11-24 切片 46：回菜单即时开播，blob 仅压缩字节 ~15MB 级）。 */
const blobCache = new Map<string, Promise<Blob | null>>();

/** 失败冷却（FrameStream/SheetFrameStream 共用）：冷却期内 failed(i)=true，过后重试。 */
const RETRY_COOLDOWN_MS = 2000;

export class FrameStream {
  /** 失败冷却：冷却期内 failed(i)=true（播放头"视为已过"防卡死），冷却过允许重试；
   *  累计失败达上限后永久视为失败（真坏帧不无限重试）。 */
  private static readonly RETRY_MAX = 5;
  /** 解码纹理（小窗常驻，release 逐出） */
  private readonly cache = new Map<number, Texture>();
  /** 解码中的纹理 */
  private readonly loading = new Map<number, Promise<Texture | null>>();
  private readonly failedAt = new Map<number, number>();
  private readonly failedCount = new Map<number, number>();
  private dead = false;

  constructor(private readonly info: StreamSpec) {
    // 全量预下载压缩帧：播放瓶颈在逐帧网络延迟（部署环境 ~150ms/帧，30fps 供不上），
    // 开播前把整条流 ~MB 级压缩体一次性吃下，之后解码走本地 blob 不再占连接。
    // 只拉实际显示区间 [from, to]（menu 帧流帧 1、76-90 从不显示）。
    // lazy 流跳过（叠加层类小流按播放进度 ensure 逐帧拉，防构造期请求风暴）。
    if (!info.lazy) {
      const from = info.from ?? 1;
      const to = info.to ?? info.frames;
      for (let i = from; i <= to; i++) this.blob(i);
    }
  }

  /** 触发 [i, i+ahead] 解码；返回 i 是否已可用。 */
  ensure(i: number, ahead = 5): boolean {
    const to = Math.min(i + ahead, this.info.to ?? this.info.frames);
    for (let k = Math.max(this.info.from ?? 1, i); k <= to; k++) this.load(k);
    return this.cache.has(i);
  }

  /** 近期失败帧（冷却期内或已达重试上限）——播放头"视为已过"用。 */
  failed(i: number): boolean {
    return this.failedCount.has(i)
      && (this.failedCount.get(i)! >= FrameStream.RETRY_MAX
        || Date.now() - this.failedAt.get(i)! < RETRY_COOLDOWN_MS);
  }

  /** 达到重试上限的永久失败帧——等待循环据此放弃（防永久卡死）。 */
  permanentlyFailed(i: number): boolean {
    return (this.failedCount.get(i) ?? 0) >= FrameStream.RETRY_MAX;
  }

  get(i: number): Texture | undefined {
    return this.cache.get(i);
  }

  /** 释放窗口外解码帧（全分辨率解码帧 ~9MB 显存，常驻窗必须小）；blob 常驻不逐出。 */
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
    // blob 走跨实例共享缓存，不在此清（共享条目对后续场景仍然零重取）
  }

  private load(i: number): Promise<Texture | null> {
    // 已缓存直接复用：ensure 每 tick 都会覆盖预取窗口，不查缓存会对已缓存帧
    // 发起重复解码（小窗语义下还会与 release 互相踩：刚解码完即被逐出再解码）。
    const cached = this.cache.get(i);
    if (cached) return Promise.resolve(cached);
    if (this.failed(i)) return Promise.resolve(null);
    let p = this.loading.get(i);
    if (!p) {
      p = this.blob(i)
        .then((b) => {
          if (!b) throw new Error('blob unavailable');
          return createImageBitmap(b);
        })
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
          // 瞬时失败（网络抖动/连接被掐）只进冷却，冷却后 ensure 再触及时重试
          if (!this.dead) {
            this.failedAt.set(i, Date.now());
            this.failedCount.set(i, (this.failedCount.get(i) ?? 0) + 1);
          }
          return null;
        })
        .finally(() => this.loading.delete(i));
      this.loading.set(i, p);
    }
    return p;
  }

  private blob(i: number): Promise<Blob | null> {
    // 槽位 → 磁盘帧号（stream-dedup 去重映射；恒等映射时同值）
    const f = this.info.map ? this.info.map[i - 1]! : i;
    const url = `${ASSETS}/${this.info.dir}/${f}.webp`;
    let p = blobCache.get(url);
    if (!p) {
      p = fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`${r.status}`);
          return r.blob();
        })
        .catch(() => {
          // 失败即移除缓存项（冷却后可重试）；失败计数在解码层统一记，
          // 避免 blob→解码双路径重复累计提前耗尽重试次数
          if (blobCache.get(url) === p) blobCache.delete(url);
          return null;
        });
      blobCache.set(url, p);
    }
    return p;
  }
}

/**
 * 拼图流帧源（StreamSheetSpec 清单；render loadSheetFrames 同构消费）。
 * 对比 FrameStream 的大图逐帧churn（blob→ImageBitmap 解码→整帧 GPU 上传→
 * release 销毁），sheet 纹理由 Assets 一次性装载常驻，逐帧 = sheet 上 cell
 * 尺寸的 quad（Texture.frame）——**零逐帧解码、零逐帧上传、零逐帧销毁**；
 * 小 sheet 总显存 ≈ 各帧像素和，全量常驻可行（title-fx 10 sheet ≈ 86MB 像素）。
 * 表面与 FrameStream 对齐（ensure/get/failed/release/dispose），消费端可互换。
 * 整流一次装载：失败进 RETRY_COOLDOWN_MS 冷却，ensure 逐 tick 被触碰天然重试。
 */
export class SheetFrameStream {
  private textures: Texture[] | null = null;
  private loading = false;
  private failedAt = 0;
  private dead = false;
  /** 槽位（1-based）→ cell 序号：map 指向磁盘帧号，sheet cells 按升序唯一帧
   *  排列（stream-sheet 产出保证），序号 = 唯一帧列表中的名次；恒等映射时 null。 */
  private readonly cellOfSlot: number[] | null;

  constructor(
    private readonly info: { dir: string; frames: number; sheets: StreamSheetSpec; map?: number[] },
  ) {
    if (info.map) {
      const uniq = [...new Set(info.map)].sort((a, b) => a - b);
      this.cellOfSlot = info.map.map((f) => uniq.indexOf(f));
    } else {
      this.cellOfSlot = null;
    }
  }

  ensure(_i: number, _ahead = 5): boolean {
    if (this.textures || this.dead) return this.textures !== null;
    if (!this.loading && Date.now() - this.failedAt >= RETRY_COOLDOWN_MS) {
      this.loading = true;
      // cells 数 = 唯一帧数（去重后 < frames）；槽位寻址在 get 里经 cellOfSlot
      void loadSheetFrames(ASSETS, this.info.dir, this.info.sheets, this.info.sheets.cells.length)
        .then((t) => {
          this.textures = t;
        })
        .catch(() => {
          this.failedAt = Date.now();
        })
        .finally(() => {
          this.loading = false;
        });
    }
    return this.textures !== null;
  }

  get(i: number): Texture | undefined {
    const c = this.cellOfSlot ? this.cellOfSlot[i - 1]! : i - 1;
    return this.textures?.[c];
  }

  /** 装载失败冷却期内为 true（调用方停止逐 tick ensure 风暴）；冷却过自然重试。 */
  failed(_i: number): boolean {
    return this.failedAt !== 0 && Date.now() - this.failedAt < RETRY_COOLDOWN_MS;
  }

  /** quad 纹理只共享 sheet 源（毫瓦级成本），逐出无收益；blob 式小窗不适用。 */
  release(_keep: (i: number) => boolean): void {}

  /** sheet 源归 Assets 缓存管理（同其余 Assets 贴图），此处只停自身重试。 */
  dispose(): void {
    this.dead = true;
    this.textures = null;
  }
}
