// The preview's choices applied to the part itself: the desktop's
// rotatePart, alignPart and finishPreview (src/ui/ImportPipeline.cpp), on
// the picture too. A turn moves whole pixels; a nudge moves whole pixels
// at 32 px a stud (a sixteenth of a stud is 2 px); "Bounding box" may move
// it by part of a pixel, drawn with bilinear filtering as Qt's smooth
// drawImage does.

import { remainder } from './connections';
import type { PreparedPart } from './prepare';
import { qRound, type Image } from './rasterize';

const SLACK = 0.05;

/** Quarter turns clockwise (y down), as QImage::transformed(rotate(90 × n)). */
export function rotateImage(img: Image, turns: number): Image {
  const t = ((turns % 4) + 4) % 4;
  if (t === 0) return img;
  const { width: w, height: h, px } = img;
  const W = t % 2 ? h : w;
  const H = t % 2 ? w : h;
  const out = new Uint32Array(W * H);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number, ny: number;
      if (t === 1) {
        nx = h - 1 - y;
        ny = x;
      } else if (t === 2) {
        nx = w - 1 - x;
        ny = h - 1 - y;
      } else {
        nx = y;
        ny = w - 1 - x;
      }
      out[ny * W + nx] = px[y * w + x]!;
    }
  }
  return { width: W, height: H, px: out };
}

export function rotatePart(part: PreparedPart, quarterTurns: number): PreparedPart {
  const turns = ((quarterTurns % 4) + 4) % 4;
  if (turns === 0 || !part.sprite) return part;
  const out: PreparedPart = { ...part, sprite: rotateImage(part.sprite, turns) };
  let c = { ...part.contentStuds };
  for (let i = 0; i < turns; i++) {
    const h = i % 2 === 0 ? part.heightStuds : part.widthStuds;
    c = { x: h - (c.y + c.height), y: c.x, width: c.height, height: c.width };
  }
  out.contentStuds = c;
  if (turns % 2) [out.widthStuds, out.heightStuds] = [part.heightStuds, part.widthStuds];
  let m = { ...part.snapMargin };
  for (let i = 0; i < turns; i++) m = { left: m.bottom, top: m.left, right: m.top, bottom: m.right };
  out.snapMargin = m;
  out.connections = part.connections.map((cn) => {
    let { x, y } = cn;
    for (let i = 0; i < turns; i++) [x, y] = [-y, x];
    return { ...cn, x, y, angle: remainder(cn.angle + 90 * turns, 360) };
  });
  out.droppedConnections = part.droppedConnections.map((p) => {
    let { x, y } = p;
    for (let i = 0; i < turns; i++) [x, y] = [-y, x];
    return { x, y };
  });
  out.quarterTurns = (part.quarterTurns + turns) % 4;
  return out;
}

/** `src` drawn into a w × h picture at (ox, oy) pixels, bilinear (Qt's smooth drawImage). */
export function drawShifted(src: Image, w: number, h: number, ox: number, oy: number): Image {
  const out = new Uint32Array(w * h);
  const ix = Math.round(ox);
  const iy = Math.round(oy);
  if (Math.abs(ox - ix) < 1e-9 && Math.abs(oy - iy) < 1e-9) {
    for (let y = 0; y < src.height; y++) {
      const dy = y + iy;
      if (dy < 0 || dy >= h) continue;
      for (let x = 0; x < src.width; x++) {
        const dx = x + ix;
        if (dx >= 0 && dx < w) out[dy * w + dx] = src.px[y * src.width + x]!;
      }
    }
    return { width: w, height: h, px: out };
  }
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= src.width || y >= src.height ? 0 : src.px[y * src.width + x]!);
  for (let y = 0; y < h; y++) {
    const sy = y - oy;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = x - ox;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const p00 = at(x0, y0),
        p10 = at(x0 + 1, y0),
        p01 = at(x0, y0 + 1),
        p11 = at(x0 + 1, y0 + 1);
      if ((p00 | p10 | p01 | p11) === 0) continue;
      let v = 0;
      for (let s = 0; s < 32; s += 8) {
        const c = (p: number) => (p >>> s) & 0xff;
        const top = c(p00) * (1 - fx) + c(p10) * fx;
        const bottom = c(p01) * (1 - fx) + c(p11) * fx;
        v |= Math.round(top * (1 - fy) + bottom * fy) << s;
      }
      out[y * w + x] = v >>> 0;
    }
  }
  return { width: w, height: h, px: out };
}

export function alignPart(part: PreparedPart, align: '' | 'bottom' | 'box', nudge: { x: number; y: number }): PreparedPart {
  const out: PreparedPart = { ...part, align, nudgeStuds: nudge };
  const c = part.contentStuds;
  if (!part.sprite || part.widthStuds <= 0 || part.heightStuds <= 0 || c.width <= 0 || c.height <= 0) return out;
  let sx = 0,
    sy = 0;
  if (align === 'box' || (align === 'bottom' && !part.baseOnGrid)) {
    sx = (Math.max(1, Math.ceil(c.width - SLACK)) - c.width) / 2 - c.x;
    sy = (Math.max(1, Math.ceil(c.height - SLACK)) - c.height) / 2 - c.y;
  }
  sx += nudge.x;
  sy += nudge.y;
  if (sx === 0 && sy === 0) return out;
  const content = { x: c.x + sx, y: c.y + sy, width: c.width, height: c.height };
  const ox = Math.floor(content.x + SLACK);
  const oy = Math.floor(content.y + SLACK);
  out.widthStuds = Math.max(1, Math.ceil(content.x + content.width - SLACK) - ox);
  out.heightStuds = Math.max(1, Math.ceil(content.y + content.height - SLACK) - oy);
  const px = part.sprite.width / part.widthStuds;
  out.sprite = drawShifted(part.sprite, qRound(out.widthStuds * px), qRound(out.heightStuds * px), (sx - ox) * px, (sy - oy) * px);
  out.contentStuds = { ...content, x: content.x - ox, y: content.y - oy };
  const dx = part.widthStuds / 2 + sx - (ox + out.widthStuds / 2);
  const dy = part.heightStuds / 2 + sy - (oy + out.heightStuds / 2);
  out.connections = part.connections.map((k) => ({ ...k, x: k.x + dx, y: k.y + dy }));
  out.droppedConnections = part.droppedConnections.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  out.alignShift = { x: part.alignShift.x + dx, y: part.alignShift.y + dy };
  const m = part.snapMargin;
  if (m.left || m.top || m.right || m.bottom) {
    const bx = m.left + sx - ox;
    const by = m.top + sy - oy;
    const bw = part.widthStuds - m.left - m.right;
    const bh = part.heightStuds - m.top - m.bottom;
    out.snapMargin = {
      left: Math.max(0, Math.floor(bx + SLACK)),
      top: Math.max(0, Math.floor(by + SLACK)),
      right: Math.max(0, Math.floor(out.widthStuds - (bx + bw) + SLACK)),
      bottom: Math.max(0, Math.floor(out.heightStuds - (by + bh) + SLACK)),
    };
  }
  return out;
}

/** The designer's link, made a web link (the desktop's finishPreview). */
export function webLink(designer: string, url: string): string {
  const u = url.trim();
  if (!designer.trim()) return '';
  if (u && !/^https?:\/\//i.test(u)) return `https://${u}`;
  return u;
}

/** finishPreview: the kept connection points, the dropped ones remembered. */
export function finishPreview(shown: PreparedPart, drop: ReadonlySet<number>): PreparedPart {
  const out: PreparedPart = { ...shown, connections: [], droppedConnections: [...shown.droppedConnections] };
  shown.connections.forEach((c, i) => {
    if (drop.has(i)) out.droppedConnections.push({ x: c.x, y: c.y });
    else out.connections.push(c);
  });
  return out;
}
