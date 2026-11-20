// An imported part's outline, for picking it and its selection outline:
// the desktop's traceOutlineStuds (src/parts/PartsLibrary.cpp). Quarter-stud
// cells are "in" when any pixel shows (alpha ≥ 32); their boundary is traced
// into rings (studs, around the sprite's centre) and each ring simplified
// (Douglas-Peucker, a third of a stud). Qt traces the region with
// QPainterPath::simplified, which may start a ring elsewhere or keep a
// different point on a staircase: the rings cover the same cells.

import type { Image } from './rasterize';

type Pt = { x: number; y: number };

function simplifyRun(ring: Pt[], a: number, b: number, tol: number, keep: boolean[]): void {
  if (b <= a + 1) return;
  const p = ring[a]!,
    q = ring[b]!;
  const len = Math.hypot(q.x - p.x, q.y - p.y);
  let worst = -1;
  let at = -1;
  for (let i = a + 1; i < b; i++) {
    const r = ring[i]!;
    const d = len < 1e-9 ? Math.hypot(r.x - p.x, r.y - p.y) : Math.abs((q.x - p.x) * (p.y - r.y) - (p.x - r.x) * (q.y - p.y)) / len;
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  if (worst > tol) {
    keep[at] = true;
    simplifyRun(ring, a, at, tol, keep);
    simplifyRun(ring, at, b, tol, keep);
  }
}

/** The desktop's simplifyRing. */
export function simplifyRing(input: Pt[], tol: number): Pt[] {
  const ring = [...input];
  if (ring.length > 1 && ring[0]!.x === ring[ring.length - 1]!.x && ring[0]!.y === ring[ring.length - 1]!.y) ring.pop();
  if (ring.length < 4) return ring;
  let far = 0;
  let best = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i]!.x - ring[0]!.x, ring[i]!.y - ring[0]!.y);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const closed = [...ring, ring[0]!];
  const keep = new Array<boolean>(closed.length).fill(false);
  keep[0] = keep[far] = keep[closed.length - 1] = true;
  simplifyRun(closed, 0, far, tol, keep);
  simplifyRun(closed, far, closed.length - 1, tol, keep);
  const out: Pt[] = [];
  for (let i = 0; i + 1 < closed.length; i++) if (keep[i]) out.push(closed[i]!);
  return out;
}

/** The boundary of the "in" cells as rings of cell corners, clockwise (y down), corners only. */
export function traceCells(on: Uint8Array, cw: number, ch: number): Pt[][] {
  const cell = (x: number, y: number) => x >= 0 && y >= 0 && x < cw && y < ch && on[y * cw + x] === 1;
  // Directed edges between corners, the inside on their right (y down): top
  // edges run east, right edges south, bottom edges west, left edges north.
  const next = new Map<number, number[]>();
  const W = cw + 1;
  const id = (x: number, y: number) => y * W + x;
  const add = (ax: number, ay: number, bx: number, by: number) => {
    const k = id(ax, ay);
    const list = next.get(k);
    if (list) list.push(id(bx, by));
    else next.set(k, [id(bx, by)]);
  };
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (!cell(x, y)) continue;
      if (!cell(x, y - 1)) add(x, y, x + 1, y);
      if (!cell(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!cell(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!cell(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  const rings: Pt[][] = [];
  // Start each ring at its top-left corner: scan corners top to bottom, left to right.
  const starts = [...next.keys()].sort((a, b) => a - b);
  for (const s of starts) {
    while (next.get(s)?.length) {
      const pts: Pt[] = [];
      let cur = s;
      let prevDir = -1;
      for (;;) {
        const outs = next.get(cur);
        if (!outs?.length) break;
        // Where two rings touch at a corner, turn right (keep each region on its own).
        let pick = 0;
        if (outs.length > 1 && prevDir >= 0) {
          const cx = cur % W,
            cy = Math.floor(cur / W);
          const dirOf = (to: number) => {
            const dx = (to % W) - cx,
              dy = Math.floor(to / W) - cy;
            return dx > 0 ? 0 : dy > 0 ? 1 : dx < 0 ? 2 : 3;
          };
          const right = (prevDir + 1) % 4;
          const k = outs.findIndex((o) => dirOf(o) === right);
          if (k >= 0) pick = k;
        }
        const to = outs.splice(pick, 1)[0]!;
        const cx = cur % W,
          cy = Math.floor(cur / W);
        const dx = (to % W) - cx,
          dy = Math.floor(to / W) - cy;
        const dir = dx > 0 ? 0 : dy > 0 ? 1 : dx < 0 ? 2 : 3;
        if (dir !== prevDir) pts.push({ x: cx, y: cy });
        prevDir = dir;
        cur = to;
        if (cur === s) break;
      }
      // The start may be mid-way along a straight side: drop it then.
      if (pts.length > 2) {
        const a = pts[pts.length - 1]!,
          b = pts[0]!,
          c = pts[1]!;
        if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) pts.shift();
      }
      if (pts.length >= 3) rings.push(pts);
    }
  }
  return rings;
}

export function traceOutlineStuds(sprite: Image | null, pxPerStud: number): Pt[][] {
  if (!sprite || pxPerStud <= 0) return [];
  const cell = Math.max(1, Math.round(pxPerStud / 4));
  const cw = Math.ceil(sprite.width / cell);
  const ch = Math.ceil(sprite.height / cell);
  const on = new Uint8Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let hit = 0;
      for (let y = cy * cell; y < Math.min(sprite.height, (cy + 1) * cell) && !hit; y++) {
        for (let x = cx * cell; x < Math.min(sprite.width, (cx + 1) * cell); x++) {
          if (sprite.px[y * sprite.width + x]! >>> 24 >= 32) {
            hit = 1;
            break;
          }
        }
      }
      on[cy * cw + cx] = hit;
    }
  }
  const toStuds = cell / pxPerStud;
  const out: Pt[][] = [];
  for (const ring of traceCells(on, cw, ch)) {
    const studs = ring.map((p) => ({ x: p.x * toStuds - sprite.width / (2 * pxPerStud), y: p.y * toStuds - sprite.height / (2 * pxPerStud) }));
    const simple = simplifyRing(studs, 0.35);
    if (simple.length >= 3) out.push(simple);
  }
  return out;
}
