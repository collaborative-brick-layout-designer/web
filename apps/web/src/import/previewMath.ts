// The import preview's geometry: the desktop's rotatePart and alignPart
// (src/ui/ImportPipeline.cpp) on the part's numbers, so the preview shows
// the size, grid and connection points the server's converter will make.
// Only the numbers: the picture is the one the converter drew, turned and
// moved over the grid here; the part itself is always made by the converter.

import type { ImportConnection } from './importApi';

export type Align = '' | 'bottom' | 'box';

export interface PreviewPart {
  widthStuds: number;
  heightStuds: number;
  contentStuds: { x: number; y: number; width: number; height: number };
  baseOnGrid: boolean;
  connections: ImportConnection[];
}

export interface PreviewFrame {
  widthStuds: number;
  heightStuds: number;
  /** Where the turned picture's top-left goes in the frame, in studs. */
  imageAt: { x: number; y: number };
  /** The turned picture's size in studs. */
  imageStuds: { width: number; height: number };
  /** Connection points relative to the frame's centre (studs, y down). */
  connections: ImportConnection[];
}

/** C's std::remainder: the quotient rounded half to even. */
function remainder(x: number, y: number): number {
  const q = x / y;
  let n = Math.round(q);
  if (Math.abs(q - Math.trunc(q)) === 0.5 && n % 2 !== 0) n -= 1;
  return x - y * n;
}

/** rotatePart: clockwise quarter turns. */
export function rotated(p: PreviewPart, quarterTurns: number): PreviewPart {
  const turns = ((quarterTurns % 4) + 4) % 4;
  let content = { ...p.contentStuds };
  let w = p.widthStuds;
  let h = p.heightStuds;
  for (let i = 0; i < turns; i++) {
    const hh = i % 2 === 0 ? p.heightStuds : p.widthStuds;
    content = { x: hh - (content.y + content.height), y: content.x, width: content.height, height: content.width };
  }
  if (turns % 2) [w, h] = [h, w];
  const connections = p.connections.map((c) => {
    let { x, y } = c;
    for (let i = 0; i < turns; i++) [x, y] = [-y, x];
    return { ...c, x, y, angle: remainder(c.angle + 90 * turns, 360) };
  });
  return { widthStuds: w, heightStuds: h, contentStuds: content, baseOnGrid: p.baseOnGrid, connections };
}

/** alignPart, then where the turned picture sits in the new frame. */
export function aligned(p: PreviewPart, align: Align, nudge: { x: number; y: number }): PreviewFrame {
  const slack = 0.05;
  const base: PreviewFrame = {
    widthStuds: p.widthStuds,
    heightStuds: p.heightStuds,
    imageAt: { x: 0, y: 0 },
    imageStuds: { width: p.widthStuds, height: p.heightStuds },
    connections: p.connections,
  };
  const c = p.contentStuds;
  if (p.widthStuds <= 0 || p.heightStuds <= 0 || c.width <= 0 || c.height <= 0) return base;
  let sx = 0;
  let sy = 0;
  if (align === 'box' || (align === 'bottom' && !p.baseOnGrid)) {
    sx = (Math.max(1, Math.ceil(c.width - slack)) - c.width) / 2 - c.x;
    sy = (Math.max(1, Math.ceil(c.height - slack)) - c.height) / 2 - c.y;
  }
  sx += nudge.x;
  sy += nudge.y;
  if (sx === 0 && sy === 0) return base;
  const cx = c.x + sx;
  const cy = c.y + sy;
  const ox = Math.floor(cx + slack);
  const oy = Math.floor(cy + slack);
  const w = Math.max(1, Math.ceil(cx + c.width - slack) - ox);
  const h = Math.max(1, Math.ceil(cy + c.height - slack) - oy);
  const dx = p.widthStuds / 2 + sx - (ox + w / 2);
  const dy = p.heightStuds / 2 + sy - (oy + h / 2);
  return {
    widthStuds: w,
    heightStuds: h,
    imageAt: { x: sx - ox, y: sy - oy },
    imageStuds: { width: p.widthStuds, height: p.heightStuds },
    connections: p.connections.map((k) => ({ ...k, x: k.x + dx, y: k.y + dy })),
  };
}

/** The desktop's names for BlueBrickParts' connection types. */
export function connectionTypeName(type: string): string {
  const names = ['', 'Rail', 'Road', 'Monorail', 'Monorail (short curve)'];
  const n = Number(type);
  return Number.isInteger(n) && n > 0 && n < names.length ? names[n]! : `Type ${type}`;
}
