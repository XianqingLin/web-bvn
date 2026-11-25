/**
 * loadingbar_mc 组件重建（原版 loading.swf sprite 61；loading_fight_mc 与
 * loading_cover_mc 同款，切片 41 从 LoadingScene 抽出共享）。
 *
 * 规格（tools/ui-pack/loading-pack 实证）：槽 764×15 + 填充 760×5（scaleX 0..1）
 * + "加载中"美术字 + 转圈 spinner + 右对齐动态消息文本（原版 bar.txt，
 * 14px 青 #00daf8，右缘钉进度条右端 761.95）。
 * spinner 偏离登记：原版 30 帧@30fps 逐帧 → 单贴图绕画布中心连续旋转
 * （每秒一圈顺时针；帧 1→2 相关性实测 +12°/帧，30×12° = 360°，逐 tick 等价）。
 */
import { Assets, Container, Sprite, Text, Texture } from 'pixi.js';
import { ASSETS, type LoadingData } from '../data.js';

export interface LoadingBar {
  /** bar 容器（已定位到摆放位；原版 loadingbar_mc） */
  bar: Container;
  /** 填充条（update 驱动 fill.scale.x = 进度 0..1） */
  fill: Sprite;
  /** 消息文本（原版 bar.txt：右对齐，`消息(n/总数)`） */
  msg: Text;
  /** 转圈 spinner（update 驱动绕中心连续旋转；锚点已居中到旋转中心） */
  spin: Sprite;
  /** 每秒旋转圈数（原版 30 帧@30fps = 1） */
  spinTurnsPerSec: number;
}

/** 装配 bar 组件；(x, y) = bar 摆放位（800×600 舞台坐标，调用方自行加 OX）。 */
export async function buildLoadingBar(data: LoadingData, x: number, y: number): Promise<LoadingBar> {
  const bar = new Container();
  bar.position.set(x, y);

  const part = async (url: string, size: [number, number], pos: [number, number]): Promise<Sprite> => {
    const sp = new Sprite(await Assets.load<Texture>(`${ASSETS}/${url}`));
    sp.width = size[0];
    sp.height = size[1];
    sp.position.set(pos[0], pos[1]);
    return sp;
  };

  bar.addChild(await part(data.bar.track.url, data.bar.track.size, data.bar.track.pos));
  const fill = await part(data.bar.fill.url, data.bar.fill.size, data.bar.fill.pos);
  bar.addChild(fill);
  bar.addChild(await part(data.bar.label.url, data.bar.label.size, data.bar.label.pos));

  // spinner：单贴图，锚点钉到画布旋转中心（原版画布 (10,10)，组内落位 pos + center）
  const spin = new Sprite(await Assets.load<Texture>(`${ASSETS}/${data.bar.spin.url}`));
  spin.width = data.bar.spin.size[0];
  spin.height = data.bar.spin.size[1];
  spin.anchor.set(0.5, 0.5);
  spin.position.set(data.bar.spin.pos[0] + data.bar.spin.center[0], data.bar.spin.pos[1] + data.bar.spin.center[1]);
  bar.addChild(spin);

  // 动态消息文本（原版 bar.txt：bar 内 (352.1,18.3) 右对齐，右缘 = bar 空间 761.95）
  const msg = new Text('', {
    fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
    fontSize: data.bar.txt.size,
    fill: data.bar.txt.color,
  });
  msg.anchor.set(1, 0.5);
  msg.position.set(data.bar.txt.rightEdge, data.bar.txt.centerY);
  bar.addChild(msg);

  return { bar, fill, msg, spin, spinTurnsPerSec: data.bar.spin.turnsPerSec };
}

/** bar 动画推进（spinner 连续旋转 + 进度平滑逼近；LoadingScene/GameLoadingScene 共用）。 */
export function tickLoadingBar(
  bar: LoadingBar | null,
  dtMs: number,
  target: number,
  state: { shown: number },
): number {
  if (!bar) return state.shown;
  // spinner 连续旋转（原版 30 帧@30fps 帧循环的等价 transform：每秒一圈顺时针）
  bar.spin.rotation += (dtMs / 1000) * Math.PI * 2 * bar.spinTurnsPerSec;
  // 进度条平滑逼近（原版直设 scaleX；分步装载下插值让条形连续走动）
  state.shown += (target - state.shown) * Math.min(1, dtMs / 120);
  bar.fill.scale.x = Math.max(0, Math.min(1, state.shown));
  return state.shown;
}
