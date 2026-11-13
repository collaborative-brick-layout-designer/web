// The kept links (linker.ts) against a whole pass of linkBricks, move after
// move, on sheets made at random: the same links and active connections
// every time, while only the parts near the moved ones are gone through.

import { describe, expect, it } from 'vitest';
import type { Brick } from '@cld/model';
import { connectionPoints, linkBricks, makeCatalogLookup, type BrickLinks } from './connectivity.js';
import { createLinker } from './linker.js';
import type { Catalog, PartMetadata } from './types.js';

function makeMeta(partNumber: string, connections: { x: number; y: number; type: string; pref?: number }[]): PartMetadata {
  return {
    key: partNumber.toLowerCase(),
    partNumber,
    colorCode: '',
    kind: 'leaf',
    descriptions: {},
    author: '',
    sortingKey: '',
    spritePath: '',
    pxPerStud: 8,
    connections: connections.map((c) => ({ type: c.type, x: c.x, y: c.y, angle: 0, electricPlug: -1, ...(c.pref !== undefined ? { nextConnexionPreference: c.pref } : {}) })),
    subparts: [],
    canUngroup: true,
    hullPts: [],
  };
}

function makeBrick(id: string, partNumber: string, x: number, y: number, orientation = 0): Brick {
  return { id, displayArea: { x, y, width: 0, height: 0 }, myGroup: '', partNumber, orientation, activeConnectionPointIndex: 0, altitude: 0, connexions: [] };
}

const STRAIGHT = makeMeta('STRAIGHT', [
  { x: -4, y: 0, type: 'rail', pref: 1 },
  { x: 4, y: 0, type: 'rail', pref: 0 },
]);
const CROSS = makeMeta('CROSS', [
  { x: -4, y: 0, type: 'rail', pref: 2 },
  { x: 4, y: 0, type: 'rail', pref: 3 },
  { x: 0, y: -4, type: 'rail', pref: 0 },
  { x: 0, y: 4, type: 'road', pref: 1 },
]);
const PLATE = makeMeta('PLATE', [
  { x: 0, y: 0, type: '' },
  { x: 2, y: 0, type: 'road' },
]);
const catalog: Catalog = new Map([
  [STRAIGHT.key, STRAIGHT],
  [CROSS.key, CROSS],
  [PLATE.key, PLATE],
]);

let seed = 11;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
/** On a 4-stud grid (so ends meet), now and then a little off it. */
const spot = (span: number) => Math.round(rnd() * span) * 4 + (rnd() < 0.15 ? pick([0.3, -0.45, 0.5]) : 0);

function randomSheet(n: number, span: number): Brick[] {
  const out: Brick[] = [];
  for (let i = 0; i < n; i++) {
    const r = rnd();
    const b = makeBrick(`b${i}`, r < 0.6 ? 'STRAIGHT' : r < 0.85 ? 'CROSS' : r < 0.95 ? 'PLATE' : 'GONE', spot(span), spot(span), pick([0, 90, 180, 270]));
    b.myGroup = rnd() < 0.2 ? 'g' : '';
    b.activeConnectionPointIndex = Math.floor(rnd() * 3);
    const k = Math.floor(rnd() * 5);
    for (let c = 0; c < k; c++) b.connexions.push({ id: rnd() < 0.1 ? '' : `${b.id}:${c}`, linkedTo: '' });
    out.push(b);
  }
  for (const b of out) for (const c of b.connexions) if (rnd() < 0.3) c.linkedTo = pick(out).connexions[0]?.id ?? '';
  return out;
}

/** Each brick's links as a whole pass gives them (null: left as it is). */
function wholePass(bricks: readonly Brick[]): (BrickLinks | null)[] {
  return linkBricks(bricks, makeCatalogLookup(catalog)).links;
}

const linksOf = (b: Brick): BrickLinks => ({ connexions: b.connexions.map((c) => ({ id: c.id, linkedTo: c.linkedTo })), activeConnectionPointIndex: b.activeConnectionPointIndex });

/** The bricks with the links written to those whose links changed (new objects, as the doc's projection gives). */
function writeBack(bricks: Brick[], links: ReadonlyMap<number, BrickLinks | null>): Brick[] {
  return bricks.map((b, i) => {
    const got = links.get(i);
    if (!got) return b;
    const was = linksOf(b);
    if (JSON.stringify(was) === JSON.stringify(got)) return b;
    return { ...b, connexions: got.connexions.map((c) => ({ ...c })), activeConnectionPointIndex: got.activeConnectionPointIndex };
  });
}

describe('kept links', () => {
  it('come out as a whole pass does, move after move, going through only the parts near the moves', () => {
    for (let round = 0; round < 30; round++) {
      const n = 120 + Math.floor(rnd() * 200);
      const span = Math.round(Math.sqrt(n) * 1.5);
      let bricks = randomSheet(n, span);
      const linker = createLinker(makeCatalogLookup(catalog), connectionPoints);
      let looked = 0;
      let incremental = 0;
      let all = 0;
      for (let step = 0; step < 40; step++) {
        const want = wholePass(bricks);
        const r = linker.update(bricks);
        const got = new Map(r.links);
        // Every brick: the links the kept pass gives, else its own (unchanged).
        bricks.forEach((b, i) => {
          const w = want[i];
          if (!w) {
            expect(got.get(i) ?? null, `round ${round} step ${step} brick ${i}`).toBeNull();
            return;
          }
          expect(got.get(i) ?? linksOf(b), `round ${round} step ${step} brick ${b.id}`).toEqual(w);
        });
        if (!r.whole) {
          looked += r.looked;
          incremental++;
        } else all = r.looked;
        bricks = writeBack(bricks, got);
        // The next change: a few parts moved or turned (sometimes back
        // onto a joint), or nothing; now and then a whole-pass change.
        const what = rnd();
        if (what < 0.04) {
          bricks = [...bricks].reverse();
        } else if (what < 0.07) {
          bricks = [...bricks, makeBrick(`n${round}-${step}`, 'STRAIGHT', spot(span), spot(span))];
        } else if (what < 0.9) {
          bricks = [...bricks];
          const moves = 1 + Math.floor(rnd() * 3);
          for (let m = 0; m < moves; m++) {
            const i = Math.floor(rnd() * bricks.length);
            const b = bricks[i]!;
            const other = pick(bricks);
            const onto = rnd() < 0.4;
            bricks[i] = {
              ...b,
              displayArea: { ...b.displayArea, x: onto ? other.displayArea.x + pick([-8, 8, 0]) : spot(span), y: onto ? other.displayArea.y + pick([-8, 8, 0]) : spot(span) },
              orientation: rnd() < 0.3 ? pick([0, 90, 180, 270]) : b.orientation,
            };
          }
        }
      }
      // After the first, the passes went through a small part of the sheet's connections.
      expect(incremental).toBeGreaterThan(20);
      expect(looked / incremental).toBeLessThan(all / 5);
    }
  });

  it('a move far from everything goes through only its own connections', () => {
    const bricks: Brick[] = [];
    for (let i = 0; i < 400; i++) bricks.push(makeBrick(`s${i}`, 'STRAIGHT', (i % 20) * 8, Math.floor(i / 20) * 8));
    const linker = createLinker(makeCatalogLookup(catalog), connectionPoints);
    const first = linker.update(bricks);
    expect(first.whole).toBe(true);
    let now = writeBack(bricks, new Map(first.links));
    // The links written are new objects: the next pass looks at them and their neighbors only.
    linker.update(now);
    now = [...now];
    now[0] = { ...now[0]!, displayArea: { ...now[0]!.displayArea, x: 5000, y: 5000 } };
    const r = linker.update(now);
    expect(r.whole).toBe(false);
    // Its two ends where they are, and the two ends it was joined to.
    expect(r.looked).toBeLessThanOrEqual(4);
    expect(new Map(r.links).get(0)!.connexions.every((c) => c.linkedTo === '')).toBe(true);
  });

  it('goes through the whole sheet when two connections share an id', () => {
    const a = makeBrick('a', 'STRAIGHT', 0, 0);
    a.connexions = [{ id: 'x', linkedTo: '' }, { id: 'y', linkedTo: '' }];
    const b = makeBrick('b', 'STRAIGHT', 8, 0);
    b.connexions = [{ id: 'x', linkedTo: '' }, { id: 'z', linkedTo: '' }];
    const linker = createLinker(makeCatalogLookup(catalog), connectionPoints);
    linker.update([a, b]);
    expect(linker.update([a, { ...b, displayArea: { ...b.displayArea, x: 16 } }]).whole).toBe(true);
  });
});
