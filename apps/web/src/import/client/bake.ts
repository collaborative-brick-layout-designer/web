// A whole model as one mesh: the desktop's bakeMeshFromLDraw (src/import/
// ldraw/LDrawMeshBuilder.cpp). Each reference's part mesh is placed by the
// reference's transform, with a flat face normal for the lighting; the
// model's own triangles and quads (color 16 drawn as 7) follow; then the
// whole mesh turns 180° about X (y and z negated) from LDraw's -Y-up frame
// into the rasterizer's +Y-up one. The lighting factor each triangle gets
// (the rasterizer's ambient 0.85 + diffuse 0.15 from straight above) is
// worked out here, since only the normal's y counts.

import { fromLine, pack, type Mesh } from './geom';
import type { LDrawReadResult } from './ldrawReader';
import type { MeshLoader } from './meshLoader';
import type { Palette } from './palette';

export interface BakedModel {
  mesh: Mesh;
  errors: string[];
  resolvedRefs: number;
  unresolvedRefs: number;
}

const AMBIENT = 0.85;
const DIFFUSE = 0.15;

/** The rasterizer's shade for a triangle whose (summed) normal is (nx, ny, nz). */
export function shadeOf(nx: number, ny: number, nz: number): number {
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len <= 1e-6) return 1;
  return Math.min(1, AMBIENT + DIFFUSE * Math.max(0, ny / len));
}

export function bakeMeshFromLDraw(src: LDrawReadResult, loader: MeshLoader, palette: Palette, onPart?: (i: number, n: number) => void): BakedModel {
  const meshes: (Mesh | null)[] = [];
  let tris = 0;
  let edges = 0;
  for (let i = 0; i < src.parts.length; i++) {
    const ref = src.parts[i]!;
    let mesh = loader.loadPart(ref.filename, ref.colorCode);
    if (mesh && mesh.triColor.length === 0) mesh = null;
    if (mesh) {
      tris += mesh.triColor.length;
      edges += mesh.edgeColor.length;
    }
    meshes.push(mesh);
    onPart?.(i + 1, src.parts.length);
  }
  let primTris = 0;
  for (const p of src.primitives) primTris += p.kind === 3 ? 1 : p.kind === 4 ? 2 : 0;
  const total = tris + primTris;
  const out: Mesh = {
    tri: new Float64Array(total * 9),
    triColor: new Uint32Array(total),
    edge: new Float64Array(edges * 6),
    edgeColor: new Uint32Array(edges),
    shade: new Float64Array(total),
  };
  let t = 0;
  let e = 0;
  let resolvedRefs = 0;
  let unresolvedRefs = 0;
  for (let i = 0; i < src.parts.length; i++) {
    const mesh = meshes[i];
    if (!mesh) {
      unresolvedRefs++;
      continue;
    }
    resolvedRefs++;
    const ref = src.parts[i]!;
    const m = fromLine(ref.x, ref.y, ref.z, ref.m);
    const p = mesh.tri;
    for (let k = 0; k < mesh.triColor.length; k++) {
      const o = t * 9;
      for (let v = 0; v < 3; v++) {
        const x = p[k * 9 + v * 3]!,
          y = p[k * 9 + v * 3 + 1]!,
          z = p[k * 9 + v * 3 + 2]!;
        // Into the mesh frame as it's placed: y and z negated.
        out.tri[o + v * 3] = m[0]! * x + m[1]! * y + m[2]! * z + m[3]!;
        out.tri[o + v * 3 + 1] = -(m[4]! * x + m[5]! * y + m[6]! * z + m[7]!);
        out.tri[o + v * 3 + 2] = -(m[8]! * x + m[9]! * y + m[10]! * z + m[11]!);
      }
      // The face normal from the placed (LDraw-frame) vertices, then into the mesh frame.
      const ax = out.tri[o]!,
        ay = -out.tri[o + 1]!,
        az = -out.tri[o + 2]!;
      const e1x = out.tri[o + 3]! - ax,
        e1y = -out.tri[o + 4]! - ay,
        e1z = -out.tri[o + 5]! - az;
      const e2x = out.tri[o + 6]! - ax,
        e2y = -out.tri[o + 7]! - ay,
        e2z = -out.tri[o + 8]! - az;
      const fx = e1y * e2z - e1z * e2y;
      const fy = e1z * e2x - e1x * e2z;
      const fz = e1x * e2y - e1y * e2x;
      // The three vertex normals are the same: their sum is 3 × the face normal.
      out.shade![t] = shadeOf(3 * fx, -3 * fy, -3 * fz);
      out.triColor[t] = mesh.triColor[k]!;
      t++;
    }
    const q = mesh.edge;
    for (let k = 0; k < mesh.edgeColor.length; k++) {
      const o = e * 6;
      for (let v = 0; v < 2; v++) {
        const x = q[k * 6 + v * 3]!,
          y = q[k * 6 + v * 3 + 1]!,
          z = q[k * 6 + v * 3 + 2]!;
        out.edge[o + v * 3] = m[0]! * x + m[1]! * y + m[2]! * z + m[3]!;
        out.edge[o + v * 3 + 1] = -(m[4]! * x + m[5]! * y + m[6]! * z + m[7]!);
        out.edge[o + v * 3 + 2] = -(m[8]! * x + m[9]! * y + m[10]! * z + m[11]!);
      }
      out.edgeColor[e] = mesh.edgeColor[k]!;
      e++;
    }
  }
  // The model's own geometry, unlit (its normals are zero).
  for (const prim of src.primitives) {
    if (prim.kind !== 3 && prim.kind !== 4) continue;
    const c = palette.color(prim.colorCode === 16 ? 7 : prim.colorCode);
    const packed = pack(c.r, c.g, c.b, c.a);
    const order = prim.kind === 3 ? [[0, 1, 2]] : [[0, 1, 2], [0, 2, 3]];
    for (const idx of order) {
      const o = t * 9;
      for (let v = 0; v < 3; v++) {
        const p = prim.v[idx[v]!]!;
        out.tri[o + v * 3] = p[0];
        out.tri[o + v * 3 + 1] = -p[1];
        out.tri[o + v * 3 + 2] = -p[2];
      }
      out.shade![t] = 1;
      out.triColor[t] = packed;
      t++;
    }
  }
  return { mesh: out, errors: [...loader.errors], resolvedRefs, unresolvedRefs };
}
