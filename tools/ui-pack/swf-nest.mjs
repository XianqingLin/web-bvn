/**
 * swf-nest：FFDec swf2xml 产物解析 + 嵌套动画元件元数据提取 + XML 手术。
 *
 * 背景（切片 45 实证，见 PROGRESS）：
 *   - FFDec `-export sprite` 的帧 PNG 会把嵌套 MovieClip **冻结**在其当前内部帧——
 *     主时间轴定格期间持续循环的嵌套动画（主菜单气泡/选人页旋涡等）烘不进去，
 *     需"干净底板（剔除嵌套元件）+ 运行时叠加层"两件套；
 *   - xml2swf 往返逐像素无损（实测 sprite 64 全帧 diff=0），故用 XML 手术剔除放置；
 *   - FFDec XML matrix 的 scaleX/scaleY 写**浮点**（如 "1.25"），个别场景写定点
 *     （65536=1）——按 |v|>10 归一化兼容两种格式；translate 单位 twips（/20 = px）；
 *   - 颜色变换子元素名 `<colorTransform>`（CXFORMWITHALPHA：alphaMultTerm 8.8 定点 /256，
 *     add 项为整数；mult 缺省 = 256）。
 */

/**
 * 解析 swf2xml 全文。
 * @returns {{
 *   sprites: Map<number, {frameCount:number, frames:Array<Object|null>[]}>,
 *   shapes: Map<number, {minX:number,minY:number,maxX:number,maxY:number}>,
 *   bitmaps: Map<number, [number, number]>,
 *   frameRate: number,
 * }}
 * sprites.frames[i] = 帧 i+1 的 depth → 放置表；placement = null（移除）或
 * { charId:number, x,y (px), sx,sy, alpha (0..1|null=1), ct? (CXFORMWITHALPHA 的 RGB
 *   mult/add，0..1；仅在该帧带色变换 item 时写入，move-only 更新随放置延续) }。
 * 显示列表跨帧持久：move-only 事件合并进原放置（不可变替换），快照即当时状态。
 */
export function parseSwfXml(xml) {
  const evRe =
    /<item ([^>]*?)(\/?)>|<\/item>|<matrix ([^>]*?)>|<colorTransform ([^>]*?)>|<shapeBounds ([^>]*?)>|<value>([^<]*)<\/value>/g;
  const attr = (s, k) => {
    const m = s.match(new RegExp(`${k}="([^"]*)"`));
    return m ? m[1] : null;
  };
  /** FFDec matrix scale：浮点直读，定点（65536 基）归一化。 */
  const scaleOf = (s) => {
    const v = parseFloat(s);
    return Math.abs(v) > 10 ? v / 65536 : v;
  };

  const model = { sprites: new Map(), shapes: new Map(), bitmaps: new Map(), frameRate: 30 };
  const stack = []; // {sprite} | {sp,pendingDepth} | null
  const topSprite = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i]?.sprite) return stack[i].sprite;
    return null;
  };
  const fr = xml.match(/frameRate="([\d.]+)"/);
  if (fr) model.frameRate = parseFloat(fr[1]);

  let m;
  while ((m = evRe.exec(xml))) {
    const [, itemAttrs, selfClose, matrixAttrs, ctAttrs, boundsAttrs] = m;

    if (m[0] === '</item>') {
      stack.pop();
      continue;
    }
    if (boundsAttrs !== undefined) {
      // shapeBounds 挂在 DefineShape*Tag 内：栈顶是其 item 占位（带 shapeId）
      const top = stack[stack.length - 1];
      if (top?.shapeId != null) {
        model.shapes.set(top.shapeId, {
          minX: +(attr(boundsAttrs, 'Xmin') || 0) / 20,
          minY: +(attr(boundsAttrs, 'Ymin') || 0) / 20,
          maxX: +(attr(boundsAttrs, 'Xmax') || 0) / 20,
          maxY: +(attr(boundsAttrs, 'Ymax') || 0) / 20,
        });
      }
      continue;
    }
    if (matrixAttrs !== undefined || ctAttrs !== undefined) {
      const top = stack[stack.length - 1];
      if (top?.sp && top.pendingDepth !== undefined) {
        const prev = top.sp.state[top.pendingDepth];
        if (prev) {
          const next = { ...prev };
          if (matrixAttrs !== undefined) {
            next.x = +(attr(matrixAttrs, 'translateX') || 0) / 20;
            next.y = +(attr(matrixAttrs, 'translateY') || 0) / 20;
            if (attr(matrixAttrs, 'hasScale') === 'true') {
              next.sx = scaleOf(attr(matrixAttrs, 'scaleX') || '1');
              next.sy = scaleOf(attr(matrixAttrs, 'scaleY') || '1');
            }
          }
          if (ctAttrs !== undefined) {
            const mult = attr(ctAttrs, 'alphaMultTerm');
            next.alpha = mult == null ? null : +mult / 256;
            // RGB mult/add（mult 8.8 定点 /256，add 整数 /255；hasMult/AddTerms=false = 恒等段）。
            // logo 显影类 CXFORM 渐变（灰度互补）由此读出；仅 alpha 关心的消费方可忽略。
            const hasM = attr(ctAttrs, 'hasMultTerms') === 'true';
            const hasA = attr(ctAttrs, 'hasAddTerms') === 'true';
            next.ct = {
              mr: hasM ? +(attr(ctAttrs, 'redMultTerm') || 256) / 256 : 1,
              mg: hasM ? +(attr(ctAttrs, 'greenMultTerm') || 256) / 256 : 1,
              mb: hasM ? +(attr(ctAttrs, 'blueMultTerm') || 256) / 256 : 1,
              ar: hasA ? +(attr(ctAttrs, 'redAddTerm') || 0) / 255 : 0,
              ag: hasA ? +(attr(ctAttrs, 'greenAddTerm') || 0) / 255 : 0,
              ab: hasA ? +(attr(ctAttrs, 'blueAddTerm') || 0) / 255 : 0,
            };
          }
          top.sp.state[top.pendingDepth] = next;
        }
      }
      continue;
    }
    if (itemAttrs === undefined) continue;
    const type = attr(itemAttrs, 'type') || '?';
    const closed = selfClose === '/';

    if (type === 'DefineSpriteTag') {
      const sprite = {
        id: +attr(itemAttrs, 'spriteId'),
        frameCount: +attr(itemAttrs, 'frameCount'),
        frames: [],
        state: {}, // 持久显示列表：depth → placement|null（跨帧延续）
      };
      model.sprites.set(sprite.id, sprite);
      stack.push({ sprite });
      if (closed) stack.pop();
      continue;
    }
    if (type === 'ShowFrameTag') {
      const t = topSprite();
      if (t) t.frames.push({ ...t.state }); // 快照（placement 不可变，替换式更新）
      continue;
    }
    if (type.startsWith('PlaceObject')) {
      const t = topSprite();
      if (t) {
        const d = attr(itemAttrs, 'depth');
        const hasChar = attr(itemAttrs, 'placeFlagHasCharacter') === 'true';
        const prev = t.state[d];
        if (hasChar) {
          t.state[d] = {
            charId: +attr(itemAttrs, 'characterId'),
            x: 0,
            y: 0,
            sx: 1,
            sy: 1,
            alpha: null,
          };
        } else if (prev) {
          // move-only：沿用原元件，仅更新矩阵/色变换——不可变替换，保住旧快照
          t.state[d] = { ...prev };
        }
        if (!closed) stack.push({ sp: t, pendingDepth: d });
      } else if (!closed) {
        stack.push({ sp: null, pendingDepth: undefined });
      }
      continue;
    }
    if (type === 'RemoveObject2Tag') {
      const t = topSprite();
      if (t) t.state[attr(itemAttrs, 'depth')] = null;
      continue;
    }
    if (type?.startsWith('DefineBits') || type === 'DefineBitsJPEG3Tag' || type === 'DefineBitsLossless2Tag') {
      const w = attr(itemAttrs, 'bitmapWidth');
      if (w) model.bitmaps.set(+attr(itemAttrs, 'characterID'), [+w, +(attr(itemAttrs, 'bitmapHeight') || 0)]);
    }
    if (type?.startsWith('DefineShape')) {
      // DefineShape*Tag：占位并带 shapeId 供 shapeBounds 归属
      stack.push({ shapeId: attr(itemAttrs, 'shapeId') ? +attr(itemAttrs, 'shapeId') : null });
      if (closed) stack.pop();
      continue;
    }
    if (!closed) stack.push(null); // 普通非自闭合 item 占位（DoABC 等）
  }
  return model;
}

/**
 * 元件内容 bounds（px，注册点坐标系）。sprite 递归（平移+缩放，本项目无旋转），
 * shape 用 shapeBounds，位图用像素尺寸。
 * seen = 当前递归路径（防循环）；逐帧重复引用同一子元件是常态，必须传路径副本
 * 而非共享集合（切片 45 实证：共享集合会把多帧 union 误折叠成首帧）。
 */
export function contentBounds(model, charId, seen = new Set()) {
  if (seen.has(charId)) return null; // 循环防护（仅沿当前路径）
  seen = new Set(seen);
  seen.add(charId);
  const sprite = model.sprites.get(charId);
  if (sprite) {
    let out = null;
    const union = (b) => {
      if (!b) return;
      out = out
        ? { minX: Math.min(out.minX, b.minX), minY: Math.min(out.minY, b.minY), maxX: Math.max(out.maxX, b.maxX), maxY: Math.max(out.maxY, b.maxY) }
        : b;
    };
    for (const row of sprite.frames) {
      if (!row) continue;
      for (const p of Object.values(row)) {
        if (!p?.charId) continue;
        const cb = contentBounds(model, p.charId, seen);
        if (!cb) continue;
        union({
          minX: p.x + p.sx * cb.minX,
          minY: p.y + p.sy * cb.minY,
          maxX: p.x + p.sx * cb.maxX,
          maxY: p.y + p.sy * cb.maxY,
        });
      }
    }
    return out;
  }
  const shape = model.shapes.get(charId);
  if (shape) return shape;
  const bmp = model.bitmaps.get(charId);
  if (bmp) return { minX: 0, minY: 0, maxX: bmp[0], maxY: bmp[1] };
  return null;
}

/**
 * 根 sprite 上指定 charId 的逐帧放置状态（含 move-only 矩阵/色变换更新）。
 * @returns Array<{depth, charId, from, to, keys:Array<{from,to,x,y,sx,sy,alpha}>}>
 * from/to 为 1 起帧号、闭区间；keys 为压缩后的常量段（帧窗内逐帧取值）。
 */
export function placementSegments(model, rootId, charIds) {
  const root = model.sprites.get(rootId);
  if (!root) throw new Error(`sprite ${rootId} 不存在`);
  const track = new Set(charIds);
  const depths = new Set();
  for (const row of root.frames) for (const d of Object.keys(row || {})) depths.add(+d);
  const segs = [];
  for (const dep of depths) {
    let cur = null;
    for (let f = 0; f < root.frames.length; f++) {
      const p = (root.frames[f] || {})[dep];
      const tracked = p != null && p.charId != null && track.has(p.charId);
      if (tracked) {
        if (!cur || cur.charId !== p.charId) {
          if (cur) {
            cur.to = f; // 段被同深度另一元件顶替：最后可见 1 起帧 = f（与移除分支同语义）
            segs.push(cur);
          }
          cur = { depth: dep, charId: p.charId, from: f + 1, to: root.frames.length, _rows: [] };
        }
        cur._rows.push({ f: f + 1, x: p.x, y: p.y, sx: p.sx, sy: p.sy, alpha: p.alpha });
      } else if (cur) {
        cur.to = f; // 本帧（1 起）起不再显示：最后可见 1 起帧 = f
        segs.push(cur);
        cur = null;
      }
    }
    if (cur) segs.push(cur);
  }
  for (const seg of segs) {
    seg.keys = [];
    let last = null;
    for (const r of seg._rows) {
      const sig = `${r.x}|${r.y}|${r.sx}|${r.sy}|${r.alpha ?? 1}`;
      if (sig !== last?._sig) {
        last = { from: r.f, to: r.f, x: r.x, y: r.y, sx: r.sx, sy: r.sy, alpha: r.alpha ?? 1, _sig: sig };
        seg.keys.push(last);
      } else {
        last.to = r.f;
      }
    }
    delete seg._rows;
  }
  segs.sort((a, b) => a.from - b.from || a.depth - b.depth);
  return segs;
}

/**
 * XML 手术：从指定 sprite 的时间轴上剔除目标放置段（按"段窗口"删，保留全部
 * RemoveObject2——同深度底层元件靠原有移除事件正常退场，不会漏出来）。
 * @param {string} xml
 * @param {number} spriteId
 * @param {Array<{depth:number, charId?:number, from:number, to:number}>} specs
 *   from/to 为 1 起帧号闭区间（placementSegments 的 seg.from/seg.to）；窗口内的
 *   move-only 事件一并删除；带 characterId 的放置事件全窗匹配删除。
 *   charId 缺省 = 该 depth 窗口内**所有**放置（含带元件者）全删（顶板"只留高层"手术用）。
 * @returns {string} 清理后的 xml 文本
 */
export function removePlacements(xml, spriteId, specs) {
  const evRe = /<item ([^>]*?)(\/?)>|<\/item>/g;
  const attr = (s, k) => {
    const m = s.match(new RegExp(`${k}="([^"]*)"`));
    return m ? m[1] : null;
  };
  // 第一遍：定位目标 sprite 块 + 其内待删 item 的 [start,end) 区间
  const ranges = [];
  const stack = []; // {spriteId, frame} | null
  let m;
  while ((m = evRe.exec(xml))) {
    const [full, itemAttrs, selfClose] = m;
    if (full === '</item>') {
      stack.pop();
      continue;
    }
    const type = attr(itemAttrs, 'type') || '?';
    const closed = selfClose === '/';
    const cur = stack.length ? stack[stack.length - 1] : null;
    if (type === 'DefineSpriteTag') {
      const sid = +attr(itemAttrs, 'spriteId');
      stack.push({ spriteId: sid, frame: 0 });
      if (closed) stack.pop();
      continue;
    }
    if (cur?.spriteId === spriteId) {
      if (type === 'ShowFrameTag') {
        cur.frame++;
      } else if (type.startsWith('PlaceObject')) {
        const depth = attr(itemAttrs, 'depth');
        const hasChar = attr(itemAttrs, 'placeFlagHasCharacter') === 'true';
        const hit = hasChar
          ? specs.find(
              (s) =>
                s.depth === +depth &&
                (s.charId !== undefined
                  ? s.charId === +attr(itemAttrs, 'characterId')
                  : cur.frame + 1 >= s.from && cur.frame + 1 <= s.to),
            )
          : specs.find((s) => s.depth === +depth && cur.frame + 1 >= s.from && cur.frame + 1 <= s.to);
        if (hit) {
          const start = m.index;
          const end = closed ? start + full.length : findItemEnd(xml, m.index);
          ranges.push([start, end]);
        }
      }
    }
    if (!closed) stack.push(null); // 普通非自闭合 item 占位
  }
  // 第二遍：倒序切除
  let out = xml;
  for (let i = ranges.length - 1; i >= 0; i--) {
    out = out.slice(0, ranges[i][0]) + out.slice(ranges[i][1]);
  }
  return out;
}

/** <item ...> 的平衡结束位置（含自闭合）。 */
function findItemEnd(xml, start) {
  const openEnd = xml.indexOf('>', start);
  if (xml[openEnd - 1] === '/') return openEnd + 1;
  let depth = 1;
  let i = openEnd + 1;
  while (i < xml.length) {
    const open = xml.indexOf('<item ', i);
    let close = xml.indexOf('</item>', i);
    if (close < 0) throw new Error('XML item 未闭合');
    if (open >= 0 && open < close) {
      const oe = xml.indexOf('>', open);
      if (xml[oe - 1] !== '/') depth++;
      i = oe + 1;
    } else {
      depth--;
      i = close + 7;
      if (depth === 0) return i;
    }
  }
  throw new Error('XML item 未闭合（扫描越界）');
}
