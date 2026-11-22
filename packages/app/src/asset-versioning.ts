/**
 * 资产 URL 指纹化（2026-11-22 第③项：非哈希资产内容寻址）。
 *
 * 机制：构建期 tools/asset-fingerprint 产出 baked/asset-versions.json
 * （路径 → 8 位内容哈希），本模块在 boot 最先安装两个拦截器——
 *  - window.fetch：凡 /packages/data/ 下的 URL 追加 ?v=<文件哈希>；
 *  - pixi Assets.load：同上（render/app 全部纹理装载共用此入口）。
 * 全仓资产获取只经这两个原语（AssetCache/FrameStream/音频/render fetchJson
 * 与 loadTextures 走 fetch；24 处 Assets.load 走 pixi 单例），站点零改动全覆盖。
 *
 * 语义：内容变 → URL 变（缓存自动失效）；URL 不变 → 内容永不变 → gamedock 对
 * 带 ?v= 的请求下发 immutable（服务端配套改动见 gamedock server/game-assets）。
 * 旧客户端不带 ?v=，服务端维持 max-age=86400——兼容双轨。
 *
 * 新鲜度链条：清单自身 URL 带 ?v=__ASSET_BUILD_ID__（vite define = 清单内容
 * 哈希）→ 资产任何变动 → 清单变 → buildId 变 → 清单 URL 变 → 永拉新清单且
 * 清单亦可 immutable 缓存。清单缺失/失败 → 全部回退无指纹 URL（= 现状行为）。
 *
 * 一致性：拦截器对指纹 URL 在清单就绪前一律等待（绝不裸拉）——避免启动早期
 * 几个请求绕过指纹被按天缓存，发布后拿一天旧数据。清单 fetch 自身走原生
 * fetch 且带 buildId，无循环依赖。
 */
import { Assets } from 'pixi.js';

/** vite define 注入（vite.config.ts：清单内容哈希）。 */
declare const __ASSET_BUILD_ID__: string;

/** 识别资产 URL 的路径标记（dev '/packages/data/…'；prod './packages/data/…' 同样命中）。 */
const MARK = '/packages/data/';
/** 清单自身路径（拦截器放行，防循环）。 */
const MAP_PATH = 'baked/asset-versions.json';

let mapReady: Promise<Record<string, string>> | null = null;
let versions: Record<string, string> | null = null;

function loadMap(): Promise<Record<string, string>> {
  if (!mapReady) {
    mapReady = fetch(`${import.meta.env.BASE_URL}packages/data/${MAP_PATH}?v=${__ASSET_BUILD_ID__}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((m) => {
        versions = m as Record<string, string>;
        return versions;
      })
      .catch(() => {
        versions = {};
        return versions;
      });
  }
  return mapReady;
}

/** `/packages/data/` 后的清单键：'assets/…' | 'baked/…'；非资产 URL 返回 null。 */
function mapKey(url: string): string | null {
  const i = url.indexOf(MARK);
  if (i < 0) return null;
  const key = url.slice(i + MARK.length);
  if (key.startsWith(MAP_PATH)) return null; // 清单自身放行
  return key.split(/[?#]/)[0] ?? null;
}

/** 追加内容指纹；未收录（含清单未就绪/失败）原样返回。 */
function versioned(url: string): string {
  const key = mapKey(url);
  const v = key ? versions?.[key] : undefined;
  if (!v) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${v}`;
}

/**
 * 安装拦截器（boot 首行调用；幂等）。必须在任何资产请求与 AppHost 构造
 * （AssetCache 构造时 bind 当前 fetch）之前执行。
 */
export function installAssetVersioning(): void {
  if ((globalThis as { __assetVersioning?: boolean }).__assetVersioning) return;
  (globalThis as { __assetVersioning?: boolean }).__assetVersioning = true;

  // —— fetch ——
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : null;
    if (url === null || mapKey(url) === null) return nativeFetch(input, init);
    return loadMap().then(() => nativeFetch(versioned(url), init));
  };

  // —— pixi Assets.load（字符串 / 字符串数组两种仓内用法；其余原样透传） ——
  // bind 必须：Assets.load 是实例方法，摘下来直调 this=undefined（pixi load 内部
  // 读 this._initialized 直接崩——首版实证）。
  const assetsLoad = Assets.load.bind(Assets) as unknown as (
    source: string | string[],
    onProgress?: (p: number) => void,
  ) => Promise<unknown>;
  Assets.load = ((
    source: string | string[],
    onProgress?: (p: number) => void,
  ): Promise<unknown> => {
    if (typeof source === 'string') {
      if (mapKey(source) === null) return assetsLoad(source, onProgress);
      return loadMap().then(() => assetsLoad(versioned(source), onProgress));
    }
    if (Array.isArray(source) && source.every((s) => typeof s === 'string')) {
      const needs = source.some((s) => mapKey(s as string) !== null);
      if (!needs) return assetsLoad(source as unknown as string, onProgress);
      return loadMap().then(() =>
        assetsLoad(source.map((s) => versioned(s as string)) as unknown as string, onProgress),
      );
    }
    return assetsLoad(source as unknown as string, onProgress);
  }) as typeof Assets.load;
}
