// LDD's brick shapes: the desktop's readLDDGeom (src/import/ldd/
// LDDGeomReader.cpp) and LDDMeshBuilder::bake, with LDDMaterials' colors.
// A .g file ("10GB") holds float positions and normals, UVs maybe, and
// triangle indices; positions are in LDD units, 25 LDU each. Outlines are
// the creases of the top-facing faces (stud rims, tile edges), as the
// desktop draws them.

import { pack, type Mesh } from './geom';
import type { LDrawReadResult } from './ldrawReader';
import { scanXml, xmlInt } from './xmlScan';
import { shadeOf } from './bake';

const LDD_TO_LDU = 25;

export interface LddGeom {
  ok: boolean;
  error: string;
  /** Positions (LDU) and per-vertex normals, 9 numbers a triangle each. */
  tri: number[];
  normal: number[];
  /** 6 numbers an outline. */
  edge: number[];
}

export function readLDDGeom(bytes: Uint8Array): LddGeom {
  const r: LddGeom = { ok: false, error: '', tri: [], normal: [], edge: [] };
  if (bytes.length < 16) {
    r.error = `File too small to contain a .g header (${bytes.length} bytes)`;
    return r;
  }
  if (bytes[0] !== 0x31 || bytes[1] !== 0x30 || bytes[2] !== 0x47 || bytes[3] !== 0x42) {
    r.error = 'Not a .g file (magic mismatch)';
    return r;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vCount = view.getUint32(4, true);
  const iCount = view.getUint32(8, true);
  const options = view.getUint32(12, true);
  let off = 16;
  if (iCount % 3 !== 0) {
    r.error = `Index count not divisible by 3 (${iCount})`;
    return r;
  }
  const hasUVs = (options & 3) === 3;
  if (vCount * 24 > bytes.length - off) {
    r.error = `Truncated vertex data (${vCount} vertices)`;
    return r;
  }
  const pos = new Float64Array(vCount * 3);
  for (let i = 0; i < vCount * 3; i++) pos[i] = view.getFloat32(off + i * 4, true) * LDD_TO_LDU;
  off += vCount * 12;
  const nrm = new Float64Array(vCount * 3);
  for (let i = 0; i < vCount * 3; i++) nrm[i] = view.getFloat32(off + i * 4, true);
  off += vCount * 12;
  if (hasUVs) {
    if (off + vCount * 8 > bytes.length) {
      r.error = 'Truncated UVs';
      return r;
    }
    off += vCount * 8;
  }
  const triCount = iCount / 3;
  if (off + iCount * 4 > bytes.length) {
    r.error = 'Truncated index buffer';
    return r;
  }
  const faceIdx = new Uint32Array(iCount);
  const faceN = new Float64Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const ia = view.getUint32(off, true),
      ib = view.getUint32(off + 4, true),
      ic = view.getUint32(off + 8, true);
    off += 12;
    if (ia >= vCount || ib >= vCount || ic >= vCount) {
      r.error = `Index out of range at triangle ${t} (${ia},${ib},${ic} vs ${vCount})`;
      return r;
    }
    faceIdx[t * 3] = ia;
    faceIdx[t * 3 + 1] = ib;
    faceIdx[t * 3 + 2] = ic;
    for (const v of [ia, ib, ic]) r.tri.push(pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!);
    for (const v of [ia, ib, ic]) r.normal.push(nrm[v * 3]!, nrm[v * 3 + 1]!, nrm[v * 3 + 2]!);
    const e1x = pos[ib * 3]! - pos[ia * 3]!,
      e1y = pos[ib * 3 + 1]! - pos[ia * 3 + 1]!,
      e1z = pos[ib * 3 + 2]! - pos[ia * 3 + 2]!;
    const e2x = pos[ic * 3]! - pos[ia * 3]!,
      e2y = pos[ic * 3 + 1]! - pos[ia * 3 + 1]!,
      e2z = pos[ic * 3 + 2]! - pos[ia * 3 + 2]!;
    let fx = e1y * e2z - e1z * e2y,
      fy = e1z * e2x - e1x * e2z,
      fz = e1x * e2y - e1y * e2x;
    const len = Math.sqrt(fx * fx + fy * fy + fz * fz);
    if (len > 1e-9) {
      fx /= len;
      fy /= len;
      fz /= len;
    }
    faceN[t * 3] = fx;
    faceN[t * 3 + 1] = fy;
    faceN[t * 3 + 2] = fz;
  }
  // Edge → the faces sharing it.
  const faces = new Map<number, number[]>();
  const key = (a: number, b: number) => Math.max(a, b) * 4294967296 + Math.min(a, b);
  for (let t = 0; t < triCount; t++) {
    const a = faceIdx[t * 3]!,
      b = faceIdx[t * 3 + 1]!,
      c = faceIdx[t * 3 + 2]!;
    for (const k of [key(a, b), key(b, c), key(c, a)]) {
      const list = faces.get(k);
      if (list) list.push(t);
      else faces.set(k, [t]);
    }
  }
  for (const [k, adj] of faces) {
    if (!adj.some((f) => faceN[f * 3 + 1]! > 0.7)) continue;
    let keep = adj.length === 1 || adj.length >= 3;
    if (!keep) {
      const fa = adj[0]!,
        fb = adj[1]!;
      const dot = faceN[fa * 3]! * faceN[fb * 3]! + faceN[fa * 3 + 1]! * faceN[fb * 3 + 1]! + faceN[fa * 3 + 2]! * faceN[fb * 3 + 2]!;
      keep = dot < 0.906;
    }
    if (!keep) continue;
    const ia = k % 4294967296,
      ib = Math.floor(k / 4294967296);
    r.edge.push(pos[ia * 3]!, pos[ia * 3 + 1]!, pos[ia * 3 + 2]!, pos[ib * 3]!, pos[ib * 3 + 1]!, pos[ib * 3 + 2]!);
  }
  r.ok = true;
  return r;
}

/** LDD's material colors (Materials.xml): MatID → RGBA, alpha 255 when unsaid. */
export function readMaterials(text: string | null): Map<number, number> {
  const out = new Map<number, number>();
  if (!text) return out;
  const clamp = (v: number | null) => Math.max(0, Math.min(255, v ?? 0));
  for (const t of scanXml(text).tags) {
    if (t.kind === 'end' || t.name !== 'Material') continue;
    const id = xmlInt(t.attrs.get('MatID'));
    if (id === null) continue;
    const alpha = t.attrs.has('Alpha') ? clamp(xmlInt(t.attrs.get('Alpha'))) : 255;
    out.set(id, pack(clamp(xmlInt(t.attrs.get('Red'))), clamp(xmlInt(t.attrs.get('Green'))), clamp(xmlInt(t.attrs.get('Blue'))), alpha));
  }
  return out;
}

export interface LddBaked {
  mesh: Mesh;
  errors: string[];
  rendered: number;
  skipped: number;
}

/** "<designID>.<material>.dat" → the design ID. */
function designIdOf(filename: string): string {
  let s = filename;
  if (s.toLowerCase().endsWith('.dat')) s = s.slice(0, -4);
  const dot = s.indexOf('.');
  return dot > 0 ? s.slice(0, dot) : s;
}

export function lddDesignIds(read: LDrawReadResult): string[] {
  return [...new Set(read.parts.map((p) => designIdOf(p.filename)))];
}

const GREY = pack(220, 220, 220, 255);
const EDGE = pack(40, 40, 40, 220);

/** Every brick from LDD's own shapes, placed and painted (the desktop's LDDMeshBuilder::bake). */
export function bakeLdd(read: LDrawReadResult, shapes: Map<string, Uint8Array | null>, materials: Map<number, number>): LddBaked {
  const out: LddBaked = { mesh: { tri: new Float64Array(), triColor: new Uint32Array(), edge: new Float64Array(), edgeColor: new Uint32Array(), shade: new Float64Array() }, errors: [], rendered: 0, skipped: 0 };
  const tri: number[] = [];
  const triColor: number[] = [];
  const shade: number[] = [];
  const edge: number[] = [];
  const parsed = new Map<string, LddGeom>();
  for (const ref of read.parts) {
    const id = designIdOf(ref.filename);
    const bytes = shapes.get(id);
    if (!bytes || bytes.length === 0) {
      out.errors.push(`missing .g for designID ${id}`);
      out.skipped++;
      continue;
    }
    let g = parsed.get(id);
    if (!g) {
      g = readLDDGeom(bytes);
      parsed.set(id, g);
    }
    if (!g.ok) {
      out.errors.push(`bad .g for ${id}: ${g.error}`);
      out.skipped++;
      continue;
    }
    const color = materials.get(ref.colorCode) ?? GREY;
    const m = ref.m;
    const place = (x: number, y: number, z: number) => [m[0]! * x + m[1]! * y + m[2]! * z + ref.x, m[3]! * x + m[4]! * y + m[5]! * z + ref.y, m[6]! * x + m[7]! * y + m[8]! * z + ref.z];
    for (let i = 0; i < g.tri.length; i += 9) {
      let nx = 0,
        ny = 0,
        nz = 0;
      for (let v = 0; v < 3; v++) {
        const p = place(g.tri[i + v * 3]!, g.tri[i + v * 3 + 1]!, g.tri[i + v * 3 + 2]!);
        tri.push(p[0]!, p[1]!, p[2]!);
        const a = g.normal[i + v * 3]!,
          b = g.normal[i + v * 3 + 1]!,
          c = g.normal[i + v * 3 + 2]!;
        nx += m[0]! * a + m[1]! * b + m[2]! * c;
        ny += m[3]! * a + m[4]! * b + m[5]! * c;
        nz += m[6]! * a + m[7]! * b + m[8]! * c;
      }
      shade.push(shadeOf(nx, ny, nz));
      triColor.push(color);
    }
    for (let i = 0; i < g.edge.length; i += 3) edge.push(...place(g.edge[i]!, g.edge[i + 1]!, g.edge[i + 2]!));
    out.rendered++;
  }
  out.mesh = {
    tri: Float64Array.from(tri),
    triColor: Uint32Array.from(triColor),
    shade: Float64Array.from(shade),
    edge: Float64Array.from(edge),
    edgeColor: new Uint32Array(edge.length / 6).fill(EDGE),
  };
  return out;
}
