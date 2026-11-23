/**
 * 公用资产后台预热（2026-11-23 战斗加载"最后一步"结构性减负）。
 *
 * 动机：hitspark（~3.5MB）+ bisha 横幅/光效（~1MB）+ HUD（~3.8MB）是每局固定
 * 公用税——与选谁/选什么图无关，此前全压在战斗加载最后一步"正在加载资源"现拉，
 * 跨境慢链路（53~240KB/s）上数分钟级。预热把它们挪到菜单/选人期的天然空闲窗口。
 *
 * 形态 = 字节预热（只 fetch 进 HTTP 缓存，不解码不建纹理）：
 *  - 战斗装载流程零改动：renderer.load 照旧，命中磁盘缓存后仅剩本地解码；
 *  - 显存零提前占用（HUD 全量解码驻留 ~340MB GPU 像素，真纹理预热需压缩纹理
 *    支撑，见 DESIGN §4——本模块刻意不做）；
 *  - 预热未完成即开打无妨：战斗装载兜底，未命中的部分照常下载；
 *  - URL 与战斗装载逐字一致（同 ASSETS 前缀 + 资产指纹拦截器统一追加 ?v=），
 *    缓存键必然命中。
 *
 * 清单来源 = baked hud/hitspark/bisha 三包（拼图 sheet 优先；无清单旧包按
 * frames 数逐帧枚举；HUD 无清单目录帧数不可枚举——探测即 404 浪费，跳过由
 * 战斗装载兜底）。bisha 立绘（faces）按对局角色取，不预热。
 *
 * 单例幂等：一个会话只跑一次；失败静默计数（战斗装载兜底重拉）。
 */
import { ASSETS, loadBisha, loadHitspark, loadHud } from './data.js';
import type { Ctx } from './host.js';

export interface WarmProgress {
  done: number;
  total: number;
  failed: number;
  finished: boolean;
}

let state: WarmProgress | null = null;

/** 启动预热（幂等；不 await——后台跑，进度走 warmProgress()）。 */
export function warmCommonAssets(ctx: Ctx): void {
  if (state) return;
  state = { done: 0, total: 0, failed: 0, finished: false };
  void run(ctx).catch(() => {
    // 清单读取失败等：整体静默，战斗装载兜底
    state!.finished = true;
  });
}

/** 当前进度（未启动 = null；只读快照，选人页小字轮询用）。 */
export function warmProgress(): Readonly<WarmProgress> | null {
  return state;
}

async function run(ctx: Ctx): Promise<void> {
  const urls: string[] = [];

  // —— HUD：拼图 sheet + root 单图（无清单目录跳过） ——
  const hud = await loadHud(ctx);
  for (const el of Object.values(hud.elements)) {
    if (typeof el === 'string') {
      if (el.endsWith('.webp')) urls.push(`${ASSETS}/${el}`);
    } else {
      for (const s of el.sheets.sheets) urls.push(`${ASSETS}/${el.path}/${s}`);
    }
  }

  // —— hitspark：拼图 sheet 优先，无清单按 frames 逐帧枚举（1.webp 连续） ——
  const hitspark = await loadHitspark(ctx);
  for (const eff of Object.values(hitspark.effects)) {
    if (eff.sheets) {
      for (const s of eff.sheets.sheets) urls.push(`${ASSETS}/${eff.dir}/${s}`);
    } else {
      for (let i = 1; i <= eff.frames; i++) urls.push(`${ASSETS}/${eff.dir}/${i}.webp`);
    }
  }

  // —— bisha：横幅 mc + 必杀光效（立绘 faces 按对局角色取，不预热） ——
  const bisha = await loadBisha(ctx);
  const mcLike = [bisha.mc, bisha.effects.bisha, bisha.effects.bisha_super];
  for (const m of mcLike) {
    if (m.sheets) {
      for (const s of m.sheets.sheets) urls.push(`${ASSETS}/${m.dir}/${s}`);
    } else {
      for (let i = 1; i <= m.frames; i++) urls.push(`${ASSETS}/${m.dir}/${i}.webp`);
    }
  }

  state!.total = urls.length;
  // 低并发：预热与用户交互共存，不挤占前台请求；?v= immutable，逐个进缓存
  const CONC = 6;
  let next = 0;
  const runners = Array.from({ length: Math.min(CONC, urls.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= urls.length) return;
      try {
        await fetch(urls[i]!);
      } catch {
        state!.failed++; // 单请求失败静默：战斗装载兜底重拉
      }
      state!.done++;
    }
  });
  await Promise.all(runners);
  state!.finished = true;
}
