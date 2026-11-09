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
const TOL_STUDS = 0.5;

interface WorldConnection {
  brick: Brick;
  meta: PartMetadata;
  /** Index into `brick.connexions`. */
  connIndex: number;
  /** World-space coordinates in studs. */
  x: number;
  y: number;
  type: string;
}

export interface RebuildConnectivityResult {
  /** Number of (brick, connIndex) pairs that ended up linked. */
  linkedCount: number;
}

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

    // connection id -> previous partner connection id
    const previous = new Map<string, string>();
    const all: WorldConnection[] = [];
    let fresh = 0;
    // The connections of parts this library doesn't know: their points
    // can't be placed, so a link to one is kept as the file has it (it
    // was dropped, so opening a layout without that library changed it).
    const unknown = new Set<string>();
    for (const brick of layer.bricks)
      if (!lookup(brick.partNumber)) for (const c of brick.connexions) if (c.id) unknown.add(c.id);
    for (const brick of layer.bricks) {
      const meta = lookup(brick.partNumber);
      if (!meta) continue;
      padConnexions(brick, meta);
      for (let i = 0; i < meta.connections.length; i++) {
        const cp = brick.connexions[i]!;
        // <LinkedTo> names the partner's connection, so every connection needs an id.
        if (!cp.id) cp.id = `${brick.id}_c${fresh++}`;
        if (cp.linkedTo && unknown.has(cp.linkedTo)) continue;
        if (cp.linkedTo) previous.set(cp.id, cp.linkedTo);
        cp.linkedTo = '';
        const c = meta.connections[i]!;
        if (c.type === '') continue;
        const [x, y] = transformLocal(c.x, c.y, brick, meta);
        all.push({ brick, meta, connIndex: i, x, y, type: c.type });
      }
    }

    // One-stud buckets; the 3 x 3 block around a point covers the tolerance.
    const buckets = new Map<string, number[]>();
    for (let i = 0; i < all.length; i++) {
      const key = bucketKey(cell(all[i]!.x), cell(all[i]!.y));
      const arr = buckets.get(key);
      if (arr) arr.push(i);
      else buckets.set(key, [i]);
    }

    for (let i = 0; i < all.length; i++) {
      const a = all[i]!;
      if (a.brick.connexions[a.connIndex]!.linkedTo !== '') continue;
      const ax = cell(a.x);
      const ay = cell(a.y);
      let bestJ = -1;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const j of buckets.get(bucketKey(ax + dx, ay + dy)) ?? []) {
            if (j === i || (bestJ >= 0 && j >= bestJ)) continue;
            const b = all[j]!;
            if (a.brick === b.brick || a.type !== b.type) continue;
            if (b.brick.connexions[b.connIndex]!.linkedTo !== '') continue;
            if (Math.abs(a.x - b.x) >= TOL_STUDS || Math.abs(a.y - b.y) >= TOL_STUDS) continue;
            bestJ = j;
          }
        }
      }
      if (bestJ < 0) continue;
      const b = all[bestJ]!;
      const ca = a.brick.connexions[a.connIndex]!;
      const cb = b.brick.connexions[b.connIndex]!;
      // BlueBrick sets the two links one after the other and hands the
      // active connection over BEFORE storing each link (so the connection
      // being linked still counts as free). Only new links hand over.
      const isNew = previous.get(ca.id) !== cb.id;
      if (isNew) onLinked(a.brick, a.connIndex, a.meta);
      ca.linkedTo = cb.id;
      if (isNew) onLinked(b.brick, b.connIndex, b.meta);
      cb.linkedTo = ca.id;
      linkedCount += 2;
    }

    // A link that broke frees its connection; if the brick's active
    // connection is taken, the freed one becomes active.
    for (const wc of all) {
      const cp = wc.brick.connexions[wc.connIndex]!;
      if (!previous.has(cp.id) || cp.linkedTo !== '') continue;
      const active = wc.brick.activeConnectionPointIndex;
      if (active >= 0 && active < wc.brick.connexions.length && wc.brick.connexions[active]!.linkedTo !== '') {
        wc.brick.activeConnectionPointIndex = wc.connIndex;
      }
    }
  }
  return { linkedCount };
}

/**
 * BlueBrick's ConnectionPoint.ConnectionLink setter, when a link is made:
 * if it lands on the brick's active connection, the active one moves to
 * that connection's <nextConnexionPreference> (default 0), or failing that
 * to the next free connection (wrapping; unchanged if none is free).
 */
function onLinked(brick: Brick, connIndex: number, meta: PartMetadata): void {
  if (brick.activeConnectionPointIndex !== connIndex) return;
  const n = brick.connexions.length;
  const preferred = meta.connections[connIndex]?.nextConnexionPreference ?? 0;
  const active = Math.min(Math.max(preferred, 0), n - 1);
  brick.activeConnectionPointIndex = active;
  // For a brick in a group BlueBrick moves the group's active connection
  // instead of looking for the brick's next free one.
  if (brick.myGroup) return;
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
function cell(v: number): number {
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
 * Grow or shrink `brick.connexions` to match the catalog's count for that
 * part. Extras get appended with empty linkedTo + a fresh id derived from
 * the brick id. Excess entries are dropped — the desktop trims the same way.
 */
function padConnexions(brick: Brick, meta: PartMetadata): void {
  const target = meta.connections.length;
  if (brick.connexions.length < target) {
    let counter = brick.connexions.length;
    while (brick.connexions.length < target) {
      brick.connexions.push({ id: `${brick.id}_${counter}`, linkedTo: '' });
      counter += 1;
    }
  } else if (brick.connexions.length > target) {
    brick.connexions.length = target;
  }
}

/**
 * World position of a local connection point: rotated around the brick's
 * pivot, its sprite centre — displayArea centre + imageOffset, non-zero
 * for parts with a <hull> (BrickPlacement connectionWorld).
 */
function transformLocal(localX: number, localY: number, brick: Brick, meta: PartMetadata | undefined): [number, number] {
  const off = meta ? imageOffset(meta, brick.orientation) : { x: 0, y: 0 };
  const cx = brick.displayArea.x + brick.displayArea.width / 2 + off.x;
  const cy = brick.displayArea.y + brick.displayArea.height / 2 + off.y;
  const theta = (brick.orientation * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  // Rotation matches the desktop's `rotatePoint`: +y rotates "forward" at
  // 0°, i.e. world coordinates are (x*cos − y*sin, x*sin + y*cos).
  const rx = localX * cos - localY * sin;
  const ry = localX * sin + localY * cos;
  return [cx + rx, cy + ry];
}


function bucketKey(bx: number, by: number): string {
  return `${bx},${by}`;
}
