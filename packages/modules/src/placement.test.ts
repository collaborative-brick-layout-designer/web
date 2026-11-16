// The placement math against the vectors the desktop also passes
// (fixtures/contracts/shared-module-placement.json), and what must hold
// between its pieces: moving or turning a placed module and updating its
// placement the same way land a version on the same spot.
//
// BLD_WRITE_CONTRACTS=1 writes the vectors' `expect` again from this code.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RectangleF } from '@cld/model';
import {
  alignToPlaced,
  areaForPivot,
  droppedPlacement,
  matchesVersion,
  movedPlacement,
  partsInPlace,
  pivotOf,
  placePoint,
  placeVersion,
  readPlacement,
  resolvePlacement,
  rotated,
  turnedPlacement,
  type ModuleBatch,
  type PartGeom,
  type PartLookup,
  type Placement,
} from './index.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/contracts/shared-module-placement.json');

type Brick = { partNumber: string; displayArea: RectangleF; orientation: number };
interface Vectors {
  about: string;
  tolerance: number;
  parts: Record<string, PartGeom>;
  place: { name: string; bricks: Brick[]; placement: Placement; expect: Brick[] }[];
  move: { placement: Placement; dx: number; dy: number; expect: Placement }[];
  turn: { placement: Placement; degrees: number; about: { x: number; y: number }; expect: Placement }[];
  drop: { drop: Parameters<typeof droppedPlacement>[0]; expect: Placement }[];
  align: { name: string; version: Brick[]; placed: Brick[]; expect: { degrees: number; x: number; y: number; matched: number } }[];
  matches: { name: string; version: Brick[]; placed: Brick[]; placement?: Placement; expect: boolean }[];
  resolve: { name: string; version: Brick[]; placed: Brick[]; kept: Placement | null; expect: Placement }[];
}

const vectors = JSON.parse(readFileSync(FILE, 'utf8')) as Vectors;
const partOf: PartLookup = (n) => vectors.parts[n.toLowerCase()];
const batch = (bricks: Brick[], layerName = 'Track'): ModuleBatch[] => [{ layerName, bricks }];
const flat = (b: ModuleBatch[]): Brick[] => b.flatMap((x) => x.bricks.map((k) => ({ partNumber: k.partNumber, displayArea: k.displayArea, orientation: k.orientation ?? 0 })));
const round = <T>(v: T): T => JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === 'number' ? Math.round(x * 1e6) / 1e6 : x))) as T;

function close(got: unknown, want: unknown, path = ''): void {
  if (typeof want === 'number') {
    expect(typeof got, path).toBe('number');
    expect(Math.abs((got as number) - want), `${path}: ${String(got)} vs ${want}`).toBeLessThanOrEqual(vectors.tolerance);
  } else if (Array.isArray(want)) {
    expect(Array.isArray(got) && got.length, path).toBe(want.length);
    want.forEach((w, i) => close((got as unknown[])[i], w, `${path}[${i}]`));
  } else if (want && typeof want === 'object') {
    for (const [k, w] of Object.entries(want)) close((got as Record<string, unknown>)[k], w, `${path}.${k}`);
  } else {
    expect(got, path).toEqual(want);
  }
}

/** Angles a hair apart across 0/360 are the same turn. */
function closePlacement(got: Placement, want: Placement, path: string): void {
  const d = Math.abs(got.degrees - want.degrees);
  expect(Math.min(d, 360 - d), `${path}.degrees`).toBeLessThanOrEqual(vectors.tolerance);
  close({ x: got.x, y: got.y }, { x: want.x, y: want.y }, path);
}

describe('shared-module-placement.json', () => {
  if (process.env.BLD_WRITE_CONTRACTS === '1') {
    it('writes the vectors', () => {
      for (const c of vectors.place) c.expect = round(flat(placeVersion(batch(c.bricks), c.placement, partOf)));
      for (const c of vectors.move) c.expect = round(movedPlacement(c.placement, c.dx, c.dy));
      for (const c of vectors.turn) c.expect = round(turnedPlacement(c.placement, c.degrees, c.about));
      for (const c of vectors.drop) c.expect = round(droppedPlacement(c.drop));
      for (const c of vectors.align) c.expect = round(alignToPlaced(batch(c.version), c.placed, partOf));
      for (const c of vectors.matches) c.expect = matchesVersion(batch(c.version), c.placed, partOf, c.placement ?? null);
      for (const c of vectors.resolve) c.expect = round(resolvePlacement(batch(c.version), c.placed, c.kept, partOf));
      writeFileSync(FILE, `${JSON.stringify(vectors, null, 2)}\n`);
    });
    return;
  }

  it('places a version: each part turned about its pivot, its box from its footprint', () => {
    expect(vectors.place.length).toBeGreaterThan(3);
    for (const c of vectors.place) close(flat(placeVersion(batch(c.bricks), c.placement, partOf)), c.expect, `place ${c.name}`);
  });

  it('updates a placement when the module is moved, turned or dropped', () => {
    for (const [i, c] of vectors.move.entries()) closePlacement(movedPlacement(c.placement, c.dx, c.dy), c.expect, `move ${i}`);
    for (const [i, c] of vectors.turn.entries()) closePlacement(turnedPlacement(c.placement, c.degrees, c.about), c.expect, `turn ${i}`);
    for (const [i, c] of vectors.drop.entries()) closePlacement(droppedPlacement(c.drop), c.expect, `drop ${i}`);
  });

  it('finds the placement from the parts', () => {
    for (const c of vectors.align) {
      const got = alignToPlaced(batch(c.version), c.placed, partOf);
      closePlacement(got, c.expect, `align ${c.name}`);
      expect(got.matched, c.name).toBe(c.expect.matched);
    }
  });

  it('tells a changed module from an unchanged one', () => {
    for (const c of vectors.matches) expect(matchesVersion(batch(c.version), c.placed, partOf, c.placement ?? null), c.name).toBe(c.expect);
  });

  it('keeps the placement the sidecar has while it fits the parts, and works it out when it does not', () => {
    for (const c of vectors.resolve) closePlacement(resolvePlacement(batch(c.version), c.placed, c.kept, partOf), c.expect, `resolve ${c.name}`);
  });
});

describe('placement', () => {
  const version = vectors.place[0]!.bricks;
  const at: Placement = { degrees: 37.5, x: 120.5, y: -48 };

  it('moving the placed parts and moving the placement agree', () => {
    const moved = flat(placeVersion(batch(version), at, partOf)).map((b) => ({ ...b, displayArea: { ...b.displayArea, x: b.displayArea.x + 12.25, y: b.displayArea.y - 3.5 } }));
    close(flat(placeVersion(batch(version), movedPlacement(at, 12.25, -3.5), partOf)), moved, 'moved');
  });

  it('turning the placed parts about a point and turning the placement agree', () => {
    const about = { x: 40, y: 12 };
    const turned = flat(placeVersion(batch(version), at, partOf)).map((b) => {
      const part = partOf(b.partNumber);
      const p = pivotOf(b, part);
      const r = rotated({ x: p.x - about.x, y: p.y - about.y }, 90);
      const orientation = b.orientation + 90;
      return { ...b, orientation: ((orientation % 360) + 360) % 360, displayArea: areaForPivot(part, orientation, { x: about.x + r.x, y: about.y + r.y }, b.displayArea) };
    });
    close(flat(placeVersion(batch(version), turnedPlacement(at, 90, about), partOf)), turned, 'turned');
  });

  it('a drop with a snap turn is the same placement as moving then turning', () => {
    const turn = { degrees: 22.5, pivotX: 14, pivotY: -6, toX: 31, toY: 8 };
    const dropped = droppedPlacement({ dx: 5, dy: 7, turn });
    const p = placePoint(dropped, { x: 3, y: 4 });
    const r = rotated({ x: 3 + 5 - turn.pivotX, y: 4 + 7 - turn.pivotY }, turn.degrees);
    expect(p.x).toBeCloseTo(turn.toX + r.x, 9);
    expect(p.y).toBeCloseTo(turn.toY + r.y, 9);
    expect(droppedPlacement({ dx: 5, dy: 7 })).toEqual({ degrees: 0, x: 5, y: 7 });
  });

  it('a placed version is found again, and is the version', () => {
    for (const degrees of [0, 90, 180, 270, 45, 12.3]) {
      const p: Placement = { degrees, x: 100.0123, y: 50.0371 };
      const placed = flat(placeVersion(batch(version), p, partOf));
      const found = alignToPlaced(batch(version), placed, partOf);
      closePlacement(found, p, `found ${degrees}`);
      expect(found.matched).toBe(version.length);
      expect(partsInPlace(batch(version), placed, p, partOf)).toBe(version.length);
      expect(matchesVersion(batch(version), placed, partOf, p)).toBe(true);
      expect(matchesVersion(batch(version), placed, partOf)).toBe(true);
      expect(matchesVersion(batch(version), placed.slice(1), partOf, p)).toBe(false);
    }
  });

  it('reads a placement from a sidecar value, and nothing else', () => {
    expect(readPlacement({ degrees: 90, x: 1, y: 2, sheets: { Track: 'l1', Bad: 7, Empty: '' } })).toEqual({ degrees: 90, x: 1, y: 2, sheets: { Track: 'l1' } });
    expect(readPlacement({ degrees: 90, x: 1, y: 2 })).toEqual({ degrees: 90, x: 1, y: 2 });
    for (const bad of [null, undefined, 'x', 7, [], {}, { degrees: '90', x: 1, y: 2 }, { degrees: 90, x: Infinity, y: 2 }, { degrees: Number.NaN, x: 1, y: 2 }]) {
      expect(readPlacement(bad)).toBeNull();
    }
  });
});
