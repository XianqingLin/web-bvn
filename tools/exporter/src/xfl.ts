/**
 * XFL（Flash CC 未编译工程格式）结构解析。
 * 输入：DOMDocument.xml（根时间轴）或 LIBRARY/**.xml（符号时间轴）。
 * 输出：统一的关键帧列表（含帧标签、帧脚本 CDATA、符号实例）。
 */
import { XMLParser } from 'fast-xml-parser';

export interface XflSymbolInstance {
  /** 实例名（如 "mc"）；可能缺省 */
  name?: string;
  /** 库元件名（如 "元件/mc_0059"） */
  libraryItemName: string;
}

export interface XflFrame {
  index: number;
  /** 关键帧时长（帧格数）；缺省按 1 计 */
  duration: number;
  /** 帧标签（labelType="name" 时有效） */
  label?: string;
  /** 帧脚本（CDATA 原文） */
  script?: string;
  symbolInstances: XflSymbolInstance[];
}

export interface XflTimelineData {
  /** 全部图层的帧，按 index 升序合并（同一 index 可能出现在多个图层） */
  layers: XflFrame[][];
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

interface RawNode {
  [key: string]: unknown;
}

function attr(node: RawNode, name: string): string | undefined {
  const v = node[`@_${name}`];
  return typeof v === 'string' ? v : undefined;
}

function extractCdata(actionscript: RawNode | undefined): string | undefined {
  if (!actionscript) return undefined;
  const script = actionscript['script'] as RawNode | string | undefined;
  if (script === undefined) return undefined;
  if (typeof script === 'string') return script;
  const cdata = script['#cdata'];
  if (typeof cdata === 'string') return cdata;
  if (typeof script['#text'] === 'string') return script['#text'] as string;
  return undefined;
}

function parseFrame(node: RawNode): XflFrame {
  const elements = node['elements'] as RawNode | undefined;
  const symbolInstances: XflSymbolInstance[] = asArray(
    elements?.['DOMSymbolInstance'] as RawNode | RawNode[] | undefined,
  ).map((si) => {
    const name = attr(si, 'name');
    const inst: XflSymbolInstance = { libraryItemName: attr(si, 'libraryItemName') ?? '' };
    if (name !== undefined) inst.name = name;
    return inst;
  });

  const frame: XflFrame = {
    index: Number(attr(node, 'index') ?? '0'),
    duration: Number(attr(node, 'duration') ?? '1'),
    symbolInstances,
  };
  const label = attr(node, 'name');
  if (label !== undefined && attr(node, 'labelType') === 'name') frame.label = label;
  const script = extractCdata(node['Actionscript'] as RawNode | undefined);
  if (script !== undefined) frame.script = script;
  return frame;
}

/** 解析 DOMDocument.xml 或符号 XML，返回全部图层的时间轴。 */
export function parseXflTimeline(xml: string): XflTimelineData {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    cdataPropName: '#cdata',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
  });
  const doc = parser.parse(xml) as RawNode;
  const root = (doc['DOMDocument'] ?? doc['DOMSymbolItem']) as RawNode | undefined;
  if (!root) throw new Error('parseXflTimeline: 不是 DOMDocument/DOMSymbolItem');
  // DOMDocument 用 <timelines>（复数），DOMSymbolItem 用 <timeline>（单数）
  const timelinesRaw = (root['timelines'] ?? root['timeline']) as RawNode | RawNode[] | undefined;
  const timelines = asArray(timelinesRaw).flatMap((t) =>
    asArray((t as RawNode)['DOMTimeline'] as RawNode | RawNode[] | undefined),
  );
  // 符号文件只有一个 timeline；文档取第一个（场景 1）
  const timeline = timelines[0];
  if (!timeline) return { layers: [] };
  const layers = asArray(timeline['layers'] as RawNode | RawNode[] | undefined).flatMap((l) =>
    asArray((l as RawNode)['DOMLayer'] as RawNode | RawNode[] | undefined),
  );
  return {
    layers: layers.map((layer) => {
      const frames = asArray(layer['frames'] as RawNode | RawNode[] | undefined).flatMap((f) =>
        asArray((f as RawNode)['DOMFrame'] as RawNode | RawNode[] | undefined),
      );
      return frames.map(parseFrame).sort((a, b) => a.index - b.index);
    }),
  };
}

/** 在图层关键帧表上按跨度 [index, index+duration) 查覆盖 frameIdx 的帧。 */
export function frameAt(frames: XflFrame[], frameIdx: number): XflFrame | undefined {
  return frames.find((f) => frameIdx >= f.index && frameIdx < f.index + f.duration);
}
