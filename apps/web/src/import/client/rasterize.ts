// Drawing a mesh from above: the desktop's rasterizeMeshTopDown and
// baseLattice (src/import/mesh/MeshRasterize.cpp), step for step.
//   - The picture is whole studs: around the bottom layer's stud lattice
//     when the model has one (its studs then sit on the map's grid), else
//     the model's box padded to whole studs, centred.
//   - A supersampled z-buffer (highest y wins), opaque triangles first,
//     then the outlines (each sample depth tested), then see-through
//     triangles from the lowest up, blended over what's below.
//   - Shrunk by exactly the supersampling factor at the end (a box filter;
//     Qt's smooth scaling differs from it by a level or two at edges).
// Images are premultiplied ARGB, one number a pixel, as Qt's
// ARGB32_Premultiplied.

import type { Mesh } from './geom';

export interface Image {
  width: number;
  height: number;
  /** Premultiplied ARGB, (a << 24 | r << 16 | g << 8 | b) >>> 0. */
  px: Uint32Array;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Margins {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface RasterizeOptions {
  pxPerStud: number;
  studsPerLdu: number;
  marginPx: number;
  ssaa: number;
  wireframe: boolean;
}

export interface RasterizeResult {
  image: Image | null;
  /** The mesh's exact bounds, studs. */
  meshBoundsXZ: Rect;
  /** The picture's footprint in mesh stud coordinates (whole studs). */
  spriteStuds: Rect;
  snapMargin: Margins;
  baseOnGrid: boolean;
}

/** The desktop app's import settings: 32 px a stud, 4× supersampled, outlines on. */
export const IMPORT_RASTER: RasterizeOptions = { pxPerStud: 32, studsPerLdu: 1 / 20, marginPx: 0, ssaa: 4, wireframe: true };

const MAX_PIXELS = 128_000_000;
const MAX_SUPER_PIXELS = 16_000_000;
const SNAP_SLACK = 0.05;

/** QRectF |= : a null rect (no size) takes the other. */
function unite(a: Rect | null, b: Rect): Rect {
  if (!a || (a.width === 0 && a.height === 0)) return { ...b };
  if (b.width === 0 && b.height === 0) return a;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width);
  const y1 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** C's lround / std::round: half away from zero. */
const roundAway = (v: number) => (v < 0 ? -Math.round(-v) : Math.round(v));
/** Qt's qRound(double). */
export const qRound = (d: number) => (d >= 0 ? Math.floor(d + 0.5) : Math.ceil(d - 0.5));

export function baseLattice(mesh: Mesh, studsPerLdu = 1 / 20): Rect | null {
  const BAND = 4;
  const MIN_SHARE = 0.05;
  const WHOLE_SLACK = 0.06;
  const levels = new Map<number, { area: number; box: Rect | null }>();
  let bx0 = Infinity,
    bx1 = -Infinity,
    bz0 = Infinity,
    bz1 = -Infinity;
  const t = mesh.tri;
  const n = mesh.triColor.length;
  for (let i = 0; i < n; i++) {
    const o = i * 9;
    for (let v = 0; v < 3; v++) {
      const x = t[o + v * 3]!,
        z = t[o + v * 3 + 2]!;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (z < bz0) bz0 = z;
      if (z > bz1) bz1 = z;
    }
    const y = t[o + 1]!;
    if (Math.abs(t[o + 4]! - y) > 0.01 || Math.abs(t[o + 7]! - y) > 0.01) continue;
    const area = Math.abs((t[o + 3]! - t[o]!) * (t[o + 8]! - t[o + 2]!) - (t[o + 6]! - t[o]!) * (t[o + 5]! - t[o + 2]!)) / 2;
    if (area <= 0) continue;
    const x0 = Math.min(t[o]!, t[o + 3]!, t[o + 6]!),
      x1 = Math.max(t[o]!, t[o + 3]!, t[o + 6]!);
    const z0 = Math.min(t[o + 2]!, t[o + 5]!, t[o + 8]!),
      z1 = Math.max(t[o + 2]!, t[o + 5]!, t[o + 8]!);
    const key = roundAway(Math.floor(y));
    const l = levels.get(key) ?? { area: 0, box: null };
    l.area += area;
    l.box = unite(l.box, { x: x0 * studsPerLdu, y: z0 * studsPerLdu, width: (x1 - x0) * studsPerLdu, height: (z1 - z0) * studsPerLdu });
    levels.set(key, l);
  }
  const total = (bx1 - bx0) * (bz1 - bz0);
  if (!(total > 0)) return null;
  const keys = [...levels.keys()].sort((a, b) => a - b);
  for (let k = 0; k < keys.length; k++) {
    const it = levels.get(keys[k]!)!;
    if (it.area < MIN_SHARE * total) continue;
    let box: Rect | null = null;
    for (let j = k; j < keys.length && keys[j]! <= keys[k]! + BAND; j++) {
      const band = levels.get(keys[j]!)!;
      if (band.area >= (MIN_SHARE / 5) * total && band.box) box = unite(box, band.box);
    }
    const w = box?.width ?? 0;
    const h = box?.height ?? 0;
    const wr = roundAway(w);
    const hr = roundAway(h);
    if (wr < 1 || hr < 1 || Math.abs(w - wr) > WHOLE_SLACK || Math.abs(h - hr) > WHOLE_SLACK) return null;
    const cx = box!.x + w / 2;
    const cy = box!.y + h / 2;
    return { x: cx - wr / 2, y: cy - hr / 2, width: wr, height: hr };
  }
  return null;
}

/** QColor → premultiplied ARGB: (c × a + 127) / 255, integer. */
export function packPremul(r: number, g: number, b: number, a: number): number {
  if (a === 0) return 0;
  return (((a << 24) | ((((r * a + 127) / 255) | 0) << 16) | ((((g * a + 127) / 255) | 0) << 8) | (((b * a + 127) / 255) | 0)) >>> 0);
}

/** Premultiplied "over": top plus below dimmed by `keep` (255 − top's alpha). */
export function over(below: number, top: number, keep: number): number {
  let out = 0;
  for (let shift = 0; shift < 32; shift += 8) {
    const b = (below >>> shift) & 0xff;
    const t = (top >>> shift) & 0xff;
    out |= Math.min(255, t + (((b * keep + 127) / 255) | 0)) << shift;
  }
  return out >>> 0;
}

export function rasterizeMeshTopDown(mesh: Mesh, opt: RasterizeOptions = IMPORT_RASTER): RasterizeResult {
  const none: RasterizeResult = { image: null, meshBoundsXZ: { x: 0, y: 0, width: 0, height: 0 }, spriteStuds: { x: 0, y: 0, width: 0, height: 0 }, snapMargin: { left: 0, top: 0, right: 0, bottom: 0 }, baseOnGrid: false };
  const nTri = mesh.triColor.length;
  if (nTri === 0) return none;
  const T = mesh.tri;
  const s = opt.studsPerLdu;
  let xmin = Infinity,
    xmax = -Infinity,
    zmin = Infinity,
    zmax = -Infinity;
  for (let i = 0; i < nTri * 3; i++) {
    const xs = T[i * 3]! * s;
    const zs = T[i * 3 + 2]! * s;
    if (xs < xmin) xmin = xs;
    if (xs > xmax) xmax = xs;
    if (zs < zmin) zmin = zs;
    if (zs > zmax) zmax = zs;
  }
  const out: RasterizeResult = { ...none, meshBoundsXZ: { x: xmin, y: zmin, width: xmax - xmin, height: zmax - zmin } };

  const base = baseLattice(mesh, s);
  if (base) {
    const extra = (overhang: number) => Math.max(0, Math.ceil(overhang - SNAP_SLACK));
    const left = extra(base.x - xmin),
      right = extra(xmax - (base.x + base.width));
    const top = extra(base.y - zmin),
      bottom = extra(zmax - (base.y + base.height));
    out.snapMargin = { left, top, right, bottom };
    out.baseOnGrid = true;
    out.spriteStuds = { x: base.x - left, y: base.y - top, width: qRound(base.width) + left + right, height: qRound(base.height) + top + bottom };
  } else {
    const w = Math.max(1, Math.ceil(xmax - xmin - SNAP_SLACK));
    const h = Math.max(1, Math.ceil(zmax - zmin - SNAP_SLACK));
    const cx = xmin + (xmax - xmin) / 2;
    const cy = zmin + (zmax - zmin) / 2;
    out.spriteStuds = { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
  }
  const wPx = out.spriteStuds.width * opt.pxPerStud + 2 * opt.marginPx;
  const hPx = out.spriteStuds.height * opt.pxPerStud + 2 * opt.marginPx;
  if (!(wPx > 0 && hPx > 0) || wPx * hPx > MAX_PIXELS) return out;
  const wStud = qRound(out.spriteStuds.width);
  const hStud = qRound(out.spriteStuds.height);
  const canvasX0 = out.spriteStuds.x;
  const canvasZ0 = out.spriteStuds.y;

  const superSize = (k: number) => (wStud * opt.pxPerStud * k + 2 * opt.marginPx * k) * (hStud * opt.pxPerStud * k + 2 * opt.marginPx * k);
  let ssaa = Math.max(1, opt.ssaa);
  while (ssaa > 1 && superSize(ssaa) > MAX_SUPER_PIXELS) ssaa--;
  const spp = opt.pxPerStud * ssaa;
  const smargin = opt.marginPx * ssaa;
  const W = wStud * spp + 2 * smargin;
  const H = hStud * spp + 2 * smargin;

  const depth = new Float32Array(W * H).fill(-Infinity);
  const color = new Uint32Array(W * H);

  const shadeOf = mesh.shade;
  const rasterize = (i: number, blend: boolean) => {
    const o = i * 9;
    const px0 = (T[o]! * s - canvasX0) * spp + smargin,
      py0 = (T[o + 2]! * s - canvasZ0) * spp + smargin;
    const px1 = (T[o + 3]! * s - canvasX0) * spp + smargin,
      py1 = (T[o + 5]! * s - canvasZ0) * spp + smargin;
    const px2 = (T[o + 6]! * s - canvasX0) * spp + smargin,
      py2 = (T[o + 8]! * s - canvasZ0) * spp + smargin;
    const wy0 = T[o + 1]!,
      wy1 = T[o + 4]!,
      wy2 = T[o + 7]!;
    const xLo = Math.max(0, Math.floor(Math.min(px0, px1, px2)));
    const xHi = Math.min(W - 1, Math.ceil(Math.max(px0, px1, px2)));
    const yLo = Math.max(0, Math.floor(Math.min(py0, py1, py2)));
    const yHi = Math.min(H - 1, Math.ceil(Math.max(py0, py1, py2)));
    if (xLo > xHi || yLo > yHi) return;
    const dx10 = px1 - px0,
      dy10 = py1 - py0,
      dx20 = px2 - px0,
      dy20 = py2 - py0;
    const denom = dx10 * dy20 - dy10 * dx20;
    if (Math.abs(denom) < 1e-9) return;
    const inv = 1 / denom;
    const shade = shadeOf ? shadeOf[i]! : 1;
    const c = mesh.triColor[i]!;
    const alpha = c & 0xff;
    if (alpha === 0) return;
    const rr = Math.max(0, Math.min(255, roundAway(((c >>> 24) & 0xff) * shade)));
    const gg = Math.max(0, Math.min(255, roundAway(((c >>> 16) & 0xff) * shade)));
    const bb = Math.max(0, Math.min(255, roundAway(((c >>> 8) & 0xff) * shade)));
    const argb = packPremul(rr, gg, bb, alpha);
    if (argb === 0) return;
    const keep = 255 - alpha;
    for (let yy = yLo; yy <= yHi; yy++) {
      const dy = yy + 0.5 - py0;
      const row = yy * W;
      for (let xx = xLo; xx <= xHi; xx++) {
        const dx = xx + 0.5 - px0;
        const b1 = (dx * dy20 - dy * dx20) * inv;
        const b2 = (dy * dx10 - dx * dy10) * inv;
        const b0 = 1 - b1 - b2;
        if (b0 < -1e-7 || b1 < -1e-7 || b2 < -1e-7) continue;
        const d = Math.fround(b0 * wy0 + b1 * wy1 + b2 * wy2);
        const at = row + xx;
        if (d <= depth[at]!) continue;
        if (!blend) {
          depth[at] = d;
          color[at] = argb;
        } else color[at] = over(color[at]!, argb, keep);
      }
    }
  };
  const seeThrough: number[] = [];
  for (let i = 0; i < nTri; i++) {
    if ((mesh.triColor[i]! & 0xff) < 255) seeThrough.push(i);
    else rasterize(i, false);
  }

  if (opt.wireframe) {
    const halfWidth = Math.max(0.5, (Math.max(0.5, opt.pxPerStud / 32) * ssaa) / 2);
    const r2 = halfWidth * halfWidth;
    const tolerance = 1 + halfWidth / (spp * s);
    const E = mesh.edge;
    for (let k = 0; k < mesh.edgeColor.length; k++) {
      const ec = mesh.edgeColor[k]!;
      const argb = packPremul((ec >>> 24) & 0xff, (ec >>> 16) & 0xff, (ec >>> 8) & 0xff, 160);
      const keep = 255 - 160;
      const o = k * 6;
      const ax = (E[o]! * s - canvasX0) * spp + smargin,
        ay = (E[o + 2]! * s - canvasZ0) * spp + smargin;
      const bx = (E[o + 3]! * s - canvasX0) * spp + smargin,
        by = (E[o + 5]! * s - canvasZ0) * spp + smargin;
      const dx = bx - ax,
        dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-9) continue;
      const ya = E[o + 1]!,
        yb = E[o + 4]!;
      const plot = (xx: number, yy: number) => {
        if (xx < 0 || xx >= W || yy < 0 || yy >= H) return;
        const sx = xx + 0.5 - ax,
          sy = yy + 0.5 - ay;
        const t = Math.max(0, Math.min(1, (sx * dx + sy * dy) / len2));
        const ox = sx - t * dx,
          oy = sy - t * dy;
        if (ox * ox + oy * oy > r2) return;
        const at = yy * W + xx;
        if (depth[at]! - (ya + t * (yb - ya)) > tolerance) return;
        color[at] = over(color[at]!, argb, keep);
      };
      const alongX = Math.abs(dx) >= Math.abs(dy);
      const lo = alongX ? Math.min(ax, bx) : Math.min(ay, by);
      const hi = alongX ? Math.max(ax, bx) : Math.max(ay, by);
      const slope = alongX ? dy / dx : dx / dy;
      const across = halfWidth * Math.sqrt(1 + slope * slope);
      const limit = alongX ? W : H;
      const first = Math.max(0, Math.floor(lo - halfWidth));
      const last = Math.min(limit - 1, Math.ceil(hi + halfWidth));
      for (let i = first; i <= last; i++) {
        const along = Math.max(lo, Math.min(hi, i + 0.5));
        const centre = alongX ? ay + (along - ax) * slope : ax + (along - ay) * slope;
        const j0 = Math.floor(centre - across - 0.5);
        const j1 = Math.ceil(centre + across - 0.5);
        for (let j = j0; j <= j1; j++) {
          if (alongX) plot(i, j);
          else plot(j, i);
        }
      }
    }
  }
  const highest = (i: number) => Math.max(T[i * 9 + 1]!, T[i * 9 + 4]!, T[i * 9 + 7]!);
  const hs = new Map<number, number>(seeThrough.map((i) => [i, highest(i)]));
  seeThrough.sort((a, b) => hs.get(a)! - hs.get(b)!);
  for (const i of seeThrough) rasterize(i, true);

  const finalW = wStud * opt.pxPerStud + 2 * opt.marginPx;
  const finalH = hStud * opt.pxPerStud + 2 * opt.marginPx;
  out.image = ssaa > 1 ? boxDown({ width: W, height: H, px: color }, ssaa, finalW, finalH) : { width: W, height: H, px: color };
  return out;
}

/** Shrink by exactly `k` in each direction: each pixel the average of its k × k block. */
export function boxDown(img: Image, k: number, w: number, h: number): Image {
  const out = new Uint32Array(w * h);
  const n = k * k;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0,
        r = 0,
        g = 0,
        b = 0;
      for (let j = 0; j < k; j++) {
        const row = (y * k + j) * img.width + x * k;
        for (let i = 0; i < k; i++) {
          const p = img.px[row + i]!;
          a += p >>> 24;
          r += (p >>> 16) & 0xff;
          g += (p >>> 8) & 0xff;
          b += p & 0xff;
        }
      }
      out[y * w + x] = ((((a / n) | 0) << 24) | (((r / n) | 0) << 16) | (((g / n) | 0) << 8) | ((b / n) | 0)) >>> 0;
    }
  }
  return { width: w, height: h, px: out };
}

/** Straight (not premultiplied) RGBA bytes, as a PNG holds them (Qt's qUnpremultiply). */
export function toRgba(img: Image): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(img.width * img.height * 4);
  for (let i = 0; i < img.px.length; i++) {
    const p = img.px[i]!;
    const a = p >>> 24;
    const o = i * 4;
    if (a === 0) continue;
    out[o] = a === 255 ? (p >>> 16) & 0xff : Math.round((((p >>> 16) & 0xff) * 255) / a);
    out[o + 1] = a === 255 ? (p >>> 8) & 0xff : Math.round((((p >>> 8) & 0xff) * 255) / a);
    out[o + 2] = a === 255 ? p & 0xff : Math.round(((p & 0xff) * 255) / a);
    out[o + 3] = a;
  }
  return out;
}
