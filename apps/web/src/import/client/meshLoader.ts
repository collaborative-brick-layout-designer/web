// A part's geometry: the desktop's LDrawMeshLoader (src/import/ldraw/
// LDrawMeshLoader.cpp). A .dat's lines are parsed once; a part is baked
// once per color by walking its sub-file references with their transforms
// and colors (16 = the parent's color, 24 = the edge color, here palette
// code 0). Triangles (quads split 0-1-2 / 0-2-3) and type-2 edges; type-5
// lines are left out. Part meshes are in the part's own LDraw coordinates.

import { fromLine, identity, MeshBuilder, multiply, pack, type Mat4, type Mesh } from './geom';
import type { LDrawFiles } from './library';
import { qtDouble } from './ldrawReader';
import { qtInt, type Palette } from './palette';

interface ParsedDat {
  subrefs: { color: number; transform: Mat4; child: string }[];
  /** 9 numbers a triangle, part-local. */
  tris: number[];
  triColors: number[];
  /** 6 numbers an edge. */
  edges: number[];
  edgeColors: number[];
}

function doubles(toks: string[], i: number, n: number): number[] | null {
  if (i + n > toks.length) return null;
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const v = qtDouble(toks[i + k]!);
    if (v === null) return null;
    out.push(v);
  }
  return out;
}

/** How deep sub-files may nest before the model is refused (the desktop has no limit, and crashes). */
export const MAX_SUBFILE_DEPTH = 64;

export class SubfileLoop extends Error {
  constructor() {
    super('This model’s parts refer to each other without end.');
  }
}

export class MeshLoader {
  private readonly parsed = new Map<string, ParsedDat>();
  private readonly baked = new Map<string, Mesh>();
  readonly errors: string[] = [];

  constructor(
    private readonly files: LDrawFiles,
    private readonly palette: Palette,
  ) {}

  private parse(name: string): ParsedDat | null {
    const key = name.trim().toLowerCase().replace(/\\/g, '/');
    const hit = this.parsed.get(key);
    if (hit) return hit;
    const text = this.files.get(name);
    if (text == null) return null;
    const d: ParsedDat = { subrefs: [], tris: [], triColors: [], edges: [], edgeColors: [] };
    for (const line of text.split(/\r?\n/)) {
      const toks = line.split(/\s+/).filter(Boolean);
      if (toks.length === 0) continue;
      const type = qtInt(toks[0]!);
      if (type === null) continue;
      if (type === 1) {
        if (toks.length < 15) continue;
        const color = qtInt(toks[1]!);
        if (color === null) continue;
        const v = doubles(toks, 2, 12);
        if (!v) continue;
        d.subrefs.push({ color, transform: fromLine(v[0]!, v[1]!, v[2]!, v.slice(3)), child: toks.slice(14).join(' ').trim() });
      } else if (type === 3) {
        if (toks.length < 11) continue;
        const color = qtInt(toks[1]!);
        if (color === null) continue;
        const v = doubles(toks, 2, 9);
        if (!v) continue;
        d.tris.push(...v);
        d.triColors.push(color);
      } else if (type === 4) {
        if (toks.length < 14) continue;
        const color = qtInt(toks[1]!);
        if (color === null) continue;
        const v = doubles(toks, 2, 12);
        if (!v) continue;
        d.tris.push(v[0]!, v[1]!, v[2]!, v[3]!, v[4]!, v[5]!, v[6]!, v[7]!, v[8]!);
        d.tris.push(v[0]!, v[1]!, v[2]!, v[6]!, v[7]!, v[8]!, v[9]!, v[10]!, v[11]!);
        d.triColors.push(color, color);
      } else if (type === 2) {
        if (toks.length < 8) continue;
        const color = qtInt(toks[1]!);
        if (color === null) continue;
        const v = doubles(toks, 2, 6);
        if (!v) continue;
        d.edges.push(...v);
        d.edgeColors.push(color);
      }
    }
    this.parsed.set(key, d);
    return d;
  }

  private appendBaked(out: MeshBuilder, dat: ParsedDat, m: Mat4, parentColor: number, depth: number): void {
    if (depth > MAX_SUBFILE_DEPTH) throw new SubfileLoop();
    const colors = new Map<number, number>();
    const resolve = (code: number) => {
      let c = colors.get(code);
      if (c === undefined) {
        const rgba = code === 16 ? this.palette.color(parentColor === 16 ? 7 : parentColor) : code === 24 ? this.palette.color(0) : this.palette.color(code);
        c = pack(rgba.r, rgba.g, rgba.b, rgba.a);
        colors.set(code, c);
      }
      return c;
    };
    const t = dat.tris;
    for (let i = 0, ti = 0; i < t.length; i += 3, ti++) {
      const x = t[i]!,
        y = t[i + 1]!,
        z = t[i + 2]!;
      out.tri.push(m[0]! * x + m[1]! * y + m[2]! * z + m[3]!, m[4]! * x + m[5]! * y + m[6]! * z + m[7]!, m[8]! * x + m[9]! * y + m[10]! * z + m[11]!);
      if (ti % 3 === 2) out.triColor.push(resolve(dat.triColors[(ti - 2) / 3]!));
    }
    const e = dat.edges;
    for (let i = 0; i < e.length; i += 3) {
      const x = e[i]!,
        y = e[i + 1]!,
        z = e[i + 2]!;
      out.edge.push(m[0]! * x + m[1]! * y + m[2]! * z + m[3]!, m[4]! * x + m[5]! * y + m[6]! * z + m[7]!, m[8]! * x + m[9]! * y + m[10]! * z + m[11]!);
    }
    for (const c of dat.edgeColors) out.edgeColor.push(resolve(c));
    for (const ref of dat.subrefs) {
      if (!this.files.has(ref.child)) {
        this.errors.push(`Unresolved subfile ${ref.child}`);
        continue;
      }
      const child = this.parse(ref.child);
      if (!child) continue;
      const inherited = ref.color === 16 ? parentColor : ref.color;
      this.appendBaked(out, child, multiply(m, ref.transform), inherited, depth + 1);
    }
  }

  /** A part's mesh in its own coordinates, or null when the library hasn't got it. */
  loadPart(datRef: string, topColor = 16): Mesh | null {
    if (!this.files.has(datRef)) {
      this.errors.push(`Unresolved part ${datRef}`);
      return null;
    }
    const cacheKey = `${datRef.trim().toLowerCase().replace(/\\/g, '/')}|${topColor}`;
    const hit = this.baked.get(cacheKey);
    if (hit) return hit;
    const dat = this.parse(datRef);
    if (!dat) return null;
    const b = new MeshBuilder();
    this.appendBaked(b, dat, identity(), topColor, 0);
    const mesh = b.build();
    this.baked.set(cacheKey, mesh);
    return mesh;
  }
}
