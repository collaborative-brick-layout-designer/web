// The importer's geometry: the desktop's geom::Mesh (src/geom/Mesh.h) as
// flat arrays, since a big model is millions of triangles. Units are LDU.
// Matrices are row-major 3×4 (the last row is always 0 0 0 1).

/** Row-major 3×4: [a b c tx, d e f ty, g h i tz]. */
export type Mat4 = Float64Array;

export function identity(): Mat4 {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
}

/** An LDraw type-1 line's numbers: the translation, then a..i row-major. */
export function fromLine(x: number, y: number, z: number, m: readonly number[]): Mat4 {
  return new Float64Array([m[0]!, m[1]!, m[2]!, x, m[3]!, m[4]!, m[5]!, y, m[6]!, m[7]!, m[8]!, z]);
}

/** a × b (the desktop's 4×4 product with the implicit last rows). */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const r = new Float64Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[i * 4 + k]! * b[k * 4 + j]!;
      if (j === 3) s += a[i * 4 + 3]!;
      r[i * 4 + j] = s;
    }
  }
  return r;
}

/** RGBA packed as (r << 24 | g << 16 | b << 8 | a) >>> 0, not premultiplied. */
export type Packed = number;

export function pack(r: number, g: number, b: number, a: number): Packed {
  return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

/**
 * Triangles and edges. `tri` holds 9 numbers a triangle (3 vertices), `edge`
 * 6 an edge; `triColor` / `edgeColor` one packed color each. `shade` (model
 * meshes only) is the lighting factor the rasterizer applies to a triangle.
 */
export interface Mesh {
  tri: Float64Array;
  triColor: Uint32Array;
  edge: Float64Array;
  edgeColor: Uint32Array;
  shade?: Float64Array;
}

/** A mesh made bit by bit (a part's, while it's baked). */
export class MeshBuilder {
  tri: number[] = [];
  triColor: number[] = [];
  edge: number[] = [];
  edgeColor: number[] = [];

  get triCount(): number {
    return this.triColor.length;
  }

  build(): Mesh {
    return { tri: Float64Array.from(this.tri), triColor: Uint32Array.from(this.triColor), edge: Float64Array.from(this.edge), edgeColor: Uint32Array.from(this.edgeColor) };
  }
}
