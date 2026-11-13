#!/usr/bin/env node
/**
 * select-pack：原版 select.xml / fighter.xml / assistant.xml / map.xml → baked/select.json。
 *
 * 选人界面布局与角色元数据的烘焙管线（切片 14）：
 *   - char_list / assist_list 的网格布局（行列 + offset + more 形态切换目标）；
 *   - fighter.xml / assistant.xml 的中文名与 comic_type（0=死神 1=火影，随机池用）；
 *   - fighter.xml 的胜者立绘类（face/win_cls）与台词（says/say_item，`|` 换行）
 *     —— 结算立绘演出用（切片 29 菜单流打磨；辅助无此数据，置 null/[]）；
 *   - map.xml 的地图中文名（random 项由 UI 自己处理，不烘进来）。
 * 输出 schema bvn/select@2；纯文本解析（源 XML 均为机器生成的单行文档）。
 *
 * 用法：node tools/select-pack/select-pack.mjs [--xfl-root DIR] [--out FILE]
 *   缺省 --xfl-root OpenBleachVsNaruto/swf_output --out packages/data/baked/select.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const XFL_ROOT = resolve(opt('xfl-root', 'OpenBleachVsNaruto/swf_output'));
const OUT = resolve(opt('out', 'packages/data/baked/select.json'));

/** 极简 XML 属性/元素提取（机器生成文档，格式固定；容错非贪婪）。 */
function parseRoster(xml) {
  const rows = [];
  const rowRe = /<row([^>]*)>(.*?)<\/row>/g;
  let m;
  while ((m = rowRe.exec(xml))) {
    const rowOffset = /offset="([^"]*)"/.exec(m[1])?.[1] ?? null;
    const items = [];
    const itemRe = /<item([^>]*)>([^<]*)<\/item>/g;
    let im;
    while ((im = itemRe.exec(m[2]))) {
      const off = /offset="([^"]*)"/.exec(im[1])?.[1] ?? null;
      const more = /more="([^"]*)"/.exec(im[1])?.[1] ?? null;
      const id = im[2].trim() || null; // 空位
      items.push({ id, offset: off, more });
    }
    rows.push({ offset: rowOffset, items });
  }
  return rows;
}

/** fighter.xml / assistant.xml → id → { name, comicType }。 */
function parseNames(xml) {
  const map = new Map();
  const re = /<fighter id="([^"]*)" name="([^"]*)" comic_type="(\d+)"/g;
  let m;
  while ((m = re.exec(xml))) map.set(m[1], { name: m[2], comicType: Number(m[3]) });
  return map;
}

/**
 * fighter.xml → id → { swf 基名, startFrame }（`<file url="assets/fighter/X.swf" startFrame="N">`）。
 * 形态角色（sasuke_juin 等）与基础角色共用同一 swf，startFrame 指定进场形态
 * （实证 58 角色零例外：缺省形态 = 含动画形态中第 startFrame 个）；
 * XFL 包 / fire 包 / 语音 / 贴帧音均按 swf 基名索引，app 取包时按此换算。
 */
function parseSwfBase(xml) {
  const map = new Map();
  const re = /<fighter id="([^"]*)"[^>]*><file url="assets\/fighter\/([^"/]+)\.swf"(?: startFrame="(\d+)")?/g;
  let m;
  while ((m = re.exec(xml))) map.set(m[1], { swf: m[2], startFrame: Number(m[3] ?? 1) });
  return map;
}

function parseMaps(xml) {
  const maps = [];
  const re = /<map id="([^"]*)" name="([^"]*)"/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1] === 'random') continue; // 随机项 UI 自理
    maps.push({ id: m[1], name: m[2] });
  }
  return maps;
}

/**
 * fighter.xml → id → { win 立绘类, says 台词列表 }（结算立绘用，切片 29）。
 * win = face/@win_cls（ui.json faces 按类名寻址；可指向其他形态的立绘类，
 * 如 ichigo_vizored → ichigo_vizored_half_w）；缺 win_cls = 无立绘（原版隐藏立绘格）。
 * says = say_item 文本列表（`|` 为换行分隔，由 UI 转换）。
 */
function parseWinnerMeta(xml) {
  const map = new Map();
  const re = /<fighter id="([^"]*)"[^>]*>((?:(?!<\/fighter>)[\s\S])*)<\/fighter>/g;
  let m;
  while ((m = re.exec(xml))) {
    const win = /win_cls="([^"]*)"/.exec(m[2])?.[1] ?? null;
    const says = [...m[2].matchAll(/<say_item>([^<]*)<\/say_item>/g)].map((x) => x[1]);
    map.set(m[1], { win, says });
  }
  return map;
}

const selectXml = readFileSync(resolve(XFL_ROOT, 'assets/config/select.xml'), 'utf8');
const fighterXml = readFileSync(resolve(XFL_ROOT, 'assets/config/fighter.xml'), 'utf8');
const assistantXml = readFileSync(resolve(XFL_ROOT, 'assets/config/assistant.xml'), 'utf8');
const mapXml = readFileSync(resolve(XFL_ROOT, 'assets/config/map.xml'), 'utf8');

const fighterNames = parseNames(fighterXml);
const assistantNames = parseNames(assistantXml);

/** 随机池项（原版无对应 fighter 元素；comicType 限随机范围，-1 = 全池）。 */
const RANDOM_META = new Map([
  ['random', { name: '随机', comicType: -1 }],
  ['random_bleach', { name: '随机(死神)', comicType: 0 }],
  ['random_naruto', { name: '随机(火影)', comicType: 1 }],
]);

/** char_list / assist_list 行展开为平铺条目（row/col 保留布局，offset 保留像素偏移）。 */
function flatten(listRows, names, kind, swfMap, winnerMeta) {
  const out = [];
  listRows.forEach((row, r) => {
    row.items.forEach((item, c) => {
      if (!item.id) return; // 空位
      const meta = names.get(item.id) ?? RANDOM_META.get(item.id);
      if (!meta) throw new Error(`${kind} 条目 ${item.id} 在 name 配置中缺失`);
      const wm = winnerMeta?.get(item.id);
      out.push({
        id: item.id,
        name: meta.name,
        comicType: meta.comicType,
        row: r,
        col: c,
        offset: item.offset,
        more: item.more,
        /** 共用 swf 基名（fighter.xml file url；形态角色 ≠ id，随机项 null） */
        swf: swfMap?.get(item.id)?.swf ?? null,
        /** 原版进场形态帧（fighter.xml startFrame；缺省 1 = 首含动画形态） */
        startFrame: swfMap?.get(item.id)?.startFrame ?? 1,
        /** 胜者立绘类（fighter.xml face/@win_cls；随机/辅助/无立绘 null） */
        win: wm?.win ?? null,
        /** 台词（fighter.xml says/say_item，`|` 换行；随机/辅助 []） */
        says: wm?.says ?? [],
      });
    });
  });
  return out;
}

const winnerMeta = parseWinnerMeta(fighterXml);
const doc = {
  schema: 'bvn/select@2',
  chars: flatten(
    parseRoster(/<char_list>(.*?)<\/char_list>/.exec(selectXml)[1]),
    fighterNames,
    'char',
    parseSwfBase(fighterXml),
    winnerMeta,
  ),
  assists: flatten(parseRoster(/<assist_list>(.*?)<\/assist_list>/.exec(selectXml)[1]), assistantNames, 'assist'),
  maps: parseMaps(mapXml),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(doc));
console.log(
  `select-pack: ${doc.chars.length} 角色 / ${doc.assists.length} 辅助 / ${doc.maps.length} 地图 → ${OUT}`,
);
