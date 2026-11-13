// Port of desktop CLD's `src/edit/Connectivity.cpp`.
//
// O(N) connectivity recompute via one-stud spatial buckets, with
// BlueBrick's linking rules (see rebuildConnectivity).
//
// Operates on @cld/model `BbmMap`. Mutates `Brick.connexions[i].linkedTo`
// in place, mirroring the desktop. Per-brick connection lists are grown
// or shrunk to match the catalog's connection count for that part —
// imported `.bbm` files routinely have stale or missing entries that the
// desktop also patches up on every recompute.

import { imageOffset } from './footprint.js';
import type { BbmMap, Brick, Layer, LayerBrick } from '@cld/model';
import type { Catalog, PartMetadata } from './types.js';

// BlueBrick's arePositionsEqual: within half a stud on each axis.
export const TOL_STUDS = 0.5;

export interface RebuildConnectivityResult {
  /** Number of (brick, connIndex) pairs that ended up linked. */
  linkedCount: number;
}

/** One brick's links as `linkBricks` works them out. */
export interface BrickLinks {
  /** The brick's connections, padded or trimmed to its part's count. */
  connexions: { id: string; linkedTo: string }[];
  activeConnectionPointIndex: number;
}

/**
 * Where a brick's connections are in the world, in studs: x then y for
 * each of its part's connections (`connectionPoints` works them out). A
 * caller that keeps bricks unchanged across runs can keep these too.
 */
export type ConnectionPointsOf = (brick: Brick, meta: PartMetadata) => ArrayLike<number>;

/**
 * Recompute every link from positions, per brick layer, the way desktop
 * Connectivity.cpp (BlueBrick's updateFullBrickConnectivity) does:
 *
 *   - bricks are walked in order, and each free connection links to the
 *     FIRST free connection of the same type (lowest index) at an equal
 *     position: within half a stud on each axis, measured from the
 *     brick's pivot (sprite centre);
 *   - links are never made across layers or within one brick;
 *   - a NEW link that lands on a brick's active connection hands the
 *     active one over (`onLinked`); a link that broke frees its
 *     connection, which becomes active if the active one is taken.
 *
 * Mutates `connexions[].linkedTo` and `activeConnectionPointIndex` in
 * place. Bricks whose part is unknown are left untouched.
 */
export function rebuildConnectivity(
  map: BbmMap,
  catalog: Catalog,
): RebuildConnectivityResult {
  const lookup = makeCatalogLookup(catalog);
  let linkedCount = 0;
  for (const layer of map.layers) {
    if (!isBrickLayer(layer)) continue;
    const { links, linkedCount: linked } = linkBricks(layer.bricks, lookup);
    linkedCount += linked;
    for (let bi = 0; bi < layer.bricks.length; bi++) {
      const got = links[bi];
      if (!got) continue;
      const brick = layer.bricks[bi]!;
      // In place, the connections it had kept as objects (as before).
      const conns = brick.connexions;
      for (let i = 0; i < got.connexions.length; i++) {
        const c = got.connexions[i]!;
        if (i < conns.length) {
          conns[i]!.id = c.id;
          conns[i]!.linkedTo = c.linkedTo;
        } else conns.push(c);
      }
      conns.length = got.connexions.length;
      brick.activeConnectionPointIndex = got.activeConnectionPointIndex;
    }
  }
  return { linkedCount };
}

/**
 * `rebuildConnectivity` for one layer's bricks, in their order, without
 * changing them: what each brick's connections and active connection
 * come out as (null for a brick whose part is unknown, left as it is).
 * `pointsOf` gives where a brick's connections are (default: worked out).
 * `linkedCount` is how many connections this linked.
 */
export function linkBricks(
  bricks: readonly Brick[],
  lookup: (partNumber: string) => PartMetadata | undefined,
  pointsOf: ConnectionPointsOf = connectionPoints,
): { links: (BrickLinks | null)[]; linkedCount: number } {
  const out: (BrickLinks | null)[] = new Array(bricks.length);
  const metas: (PartMetadata | undefined)[] = new Array(bricks.length);
  // connection id -> previous partner connection id
  const previous = new Map<string, string>();
  // Every connection that can link, as parallel lists: its brick (index
  // into `bricks`), its index on that brick, where it is and its type.
  const allBrick: number[] = [];
  const allConn: number[] = [];
  const allX: number[] = [];
  const allY: number[] = [];
  const allType: string[] = [];
  let fresh = 0;
  let linkedCount = 0;
  // The connections of parts this library doesn't know: their points
  // can't be placed, so a link to one is kept as the file has it (it
  // was dropped, so opening a layout without that library changed it).
  const unknown = new Set<string>();
  for (let bi = 0; bi < bricks.length; bi++) {
    const brick = bricks[bi]!;
    const meta = lookup(brick.partNumber);
    metas[bi] = meta;
    if (!meta) for (const c of brick.connexions) if (c.id) unknown.add(c.id);
  }
  for (let bi = 0; bi < bricks.length; bi++) {
    const brick = bricks[bi]!;
    const meta = metas[bi];
    if (!meta) {
      out[bi] = null;
      continue;
    }
    const connexions = paddedConnexions(brick, meta);
    out[bi] = { connexions, activeConnectionPointIndex: brick.activeConnectionPointIndex };
    let points: ArrayLike<number> | null = null;
    for (let i = 0; i < meta.connections.length; i++) {
      const cp = connexions[i]!;
      // <LinkedTo> names the partner's connection, so every connection needs an id.
      if (!cp.id) cp.id = `${brick.id}_c${fresh++}`;
      if (cp.linkedTo && unknown.has(cp.linkedTo)) continue;
      if (cp.linkedTo) previous.set(cp.id, cp.linkedTo);
      cp.linkedTo = '';
      const c = meta.connections[i]!;
      if (c.type === '') continue;
      points ??= pointsOf(brick, meta);
      allBrick.push(bi);
      allConn.push(i);
      allX.push(points[2 * i]!);
      allY.push(points[2 * i + 1]!);
      allType.push(c.type);
    }
  }
  const linkOf = (k: number) => out[allBrick[k]!]!.connexions[allConn[k]!]!;

  // One-stud buckets; the 3 x 3 block around a point covers the tolerance.
  const buckets = new Map<number | string, number[]>();
  const n = allBrick.length;
  const cellX: number[] = new Array(n);
  const cellY: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    cellX[i] = cell(allX[i]!);
    cellY[i] = cell(allY[i]!);
    const key = bucketKey(cellX[i]!, cellY[i]!);
    const arr = buckets.get(key);
    if (arr) arr.push(i);
    else buckets.set(key, [i]);
  }

  for (let i = 0; i < n; i++) {
    const ca = linkOf(i);
    if (ca.linkedTo !== '') continue;
    const ax = cellX[i]!;
    const ay = cellY[i]!;
    const aBrick = allBrick[i]!;
    const aType = allType[i]!;
    const x = allX[i]!;
    const y = allY[i]!;
    let bestJ = -1;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const near = buckets.get(bucketKey(ax + dx, ay + dy));
        if (!near) continue;
        for (const j of near) {
          if (j === i || (bestJ >= 0 && j >= bestJ)) continue;
          if (aBrick === allBrick[j] || aType !== allType[j]) continue;
          if (linkOf(j).linkedTo !== '') continue;
          if (Math.abs(x - allX[j]!) >= TOL_STUDS || Math.abs(y - allY[j]!) >= TOL_STUDS) continue;
          bestJ = j;
        }
      }
    }
    if (bestJ < 0) continue;
    const cb = linkOf(bestJ);
    const bBrick = allBrick[bestJ]!;
    // BlueBrick sets the two links one after the other and hands the
    // active connection over BEFORE storing each link (so the connection
    // being linked still counts as free). Only new links hand over.
    const isNew = previous.get(ca.id) !== cb.id;
    if (isNew) onLinked(out[aBrick]!, bricks[aBrick]!.myGroup, allConn[i]!, metas[aBrick]!);
    ca.linkedTo = cb.id;
    if (isNew) onLinked(out[bBrick]!, bricks[bBrick]!.myGroup, allConn[bestJ]!, metas[bBrick]!);
    cb.linkedTo = ca.id;
    linkedCount += 2;
  }

  // A link that broke frees its connection; if the brick's active
  // connection is taken, the freed one becomes active.
  for (let k = 0; k < n; k++) {
    const cp = linkOf(k);
    if (!previous.has(cp.id) || cp.linkedTo !== '') continue;
    const w = out[allBrick[k]!]!;
    const active = w.activeConnectionPointIndex;
    if (active >= 0 && active < w.connexions.length && w.connexions[active]!.linkedTo !== '') {
      w.activeConnectionPointIndex = allConn[k]!;
    }
  }
  return { links: out, linkedCount };
}

/**
 * Where a brick's connections are in the world, in studs (x then y for
 * each of its part's connections): rotated around the brick's pivot, its
 * sprite centre — displayArea centre + imageOffset, non-zero for parts
 * with a <hull> (BrickPlacement connectionWorld).
 */
export function connectionPoints(brick: Brick, meta: PartMetadata): number[] {
  const off = imageOffset(meta, brick.orientation);
  const cx = brick.displayArea.x + brick.displayArea.width / 2 + off.x;
  const cy = brick.displayArea.y + brick.displayArea.height / 2 + off.y;
  const theta = (brick.orientation * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const out: number[] = new Array(meta.connections.length * 2);
  for (let i = 0; i < meta.connections.length; i++) {
    const c = meta.connections[i]!;
    // Rotation matches the desktop's `rotatePoint`: +y rotates "forward" at
    // 0°, i.e. world coordinates are (x*cos − y*sin, x*sin + y*cos).
    out[2 * i] = cx + (c.x * cos - c.y * sin);
    out[2 * i + 1] = cy + (c.x * sin + c.y * cos);
  }
  return out;
}

/**
 * BlueBrick's ConnectionPoint.ConnectionLink setter, when a link is made:
 * if it lands on the brick's active connection, the active one moves to
 * that connection's <nextConnexionPreference> (default 0), or failing that
 * to the next free connection (wrapping; unchanged if none is free).
 */
export function onLinked(brick: BrickLinks, myGroup: string, connIndex: number, meta: PartMetadata): void {
  if (brick.activeConnectionPointIndex !== connIndex) return;
  const n = brick.connexions.length;
  const preferred = meta.connections[connIndex]?.nextConnexionPreference ?? 0;
  const active = Math.min(Math.max(preferred, 0), n - 1);
  brick.activeConnectionPointIndex = active;
  // For a brick in a group BlueBrick moves the group's active connection
  // instead of looking for the brick's next free one.
  if (myGroup) return;
  if (brick.connexions[active]!.linkedTo === '') return;
  for (let step = 1; step < n; step++) {
    const candidate = (active + step) % n;
    if (brick.connexions[candidate]!.linkedTo === '') {
      brick.activeConnectionPointIndex = candidate;
      return;
    }
  }
}

/** Bucket cell, clamped so a corrupt position can't overflow. */
export function cell(v: number): number {
  if (!(v > -1e9)) return -1e9;
  if (!(v < 1e9)) return 1e9;
  return Math.floor(v);
}

function isBrickLayer(layer: Layer): layer is LayerBrick {
  return layer.type === 'brick';
}

function catalogLookup(catalog: Catalog, partNumber: string): PartMetadata | undefined {
  // The catalog key is `<partNumber>.<colorCode>` lowercased. The .bbm
  // stores partNumber WITHOUT a color code embedded, so we try the bare
  // lookup first, then any matching color variant.
  const lower = partNumber.toLowerCase();
  if (catalog.has(lower)) return catalog.get(lower);
  // Find any entry whose partNumber matches (color variant fallback).
  for (const entry of catalog.values()) {
    if (entry.partNumber.toLowerCase() === lower) return entry;
  }
  return undefined;
}

/**
 * Memoised `catalogLookup` for one recompute. The color-variant fallback
 * is an O(catalog) scan; without the memo every brick whose part isn't
 * keyed directly paid that scan again (hits AND misses are cached).
 */
export function makeCatalogLookup(catalog: Catalog): (partNumber: string) => PartMetadata | undefined {
  const memo = new Map<string, PartMetadata | undefined>();
  let renamed: Map<string, PartMetadata> | undefined;
  return (partNumber) => {
    if (memo.has(partNumber)) return memo.get(partNumber);
    let meta = catalogLookup(catalog, partNumber);
    if (!meta) {
      // An old part number resolves to the part that replaced it.
      renamed ??= oldNameIndex(catalog);
      meta = renamed.get(partNumber.toLowerCase());
    }
    memo.set(partNumber, meta);
    return meta;
  };
}

/** Lower-cased old part number → the part that lists it in `<OldNameList>`. */
function oldNameIndex(catalog: Catalog): Map<string, PartMetadata> {
  const out = new Map<string, PartMetadata>();
  for (const meta of catalog.values()) {
    for (const old of meta.oldNames ?? []) {
      const k = old.toLowerCase();
      if (!out.has(k)) out.set(k, meta);
    }
  }
  return out;
}


/**
 * A copy of `brick.connexions` grown or shrunk to the catalog's count for
 * that part. Extras get an empty linkedTo + a fresh id derived from the
 * brick id. Excess entries are dropped — the desktop trims the same way.
 */
export function paddedConnexions(brick: Brick, meta: PartMetadata): { id: string; linkedTo: string }[] {
  const target = meta.connections.length;
  const out: { id: string; linkedTo: string }[] = [];
  for (let i = 0; i < brick.connexions.length && i < target; i++) {
    const c = brick.connexions[i]!;
    out.push({ id: c.id, linkedTo: c.linkedTo });
  }
  for (let counter = out.length; out.length < target; counter++) out.push({ id: `${brick.id}_${counter}`, linkedTo: '' });
  return out;
}

/**
 * A bucket's key: a number for any cell a layout really has (within 2^24
 * studs, about 131 km, of the origin), a string past that.
 */
const KEY_SPAN = 1 << 24;
export function bucketKey(bx: number, by: number): number | string {
  if (bx > -KEY_SPAN && bx < KEY_SPAN && by > -KEY_SPAN && by < KEY_SPAN) return (bx + KEY_SPAN) * 2 * KEY_SPAN + (by + KEY_SPAN);
  return `${bx},${by}`;
}
