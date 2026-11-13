// Links kept up to date move after move, looking only at the parts near the
// ones that changed: `linkBricks` (connectivity.ts) goes through every
// connection of the sheet each time (about 40 ms on 7,520 parts at 4x
// slowed CPU after each drag).
//
// The result is the same as `linkBricks` on the whole sheet, by these steps:
//
//  - Connections only ever link within half a stud of each other on each
//    axis. So the connections whose links can change are those in the same
//    cluster (connections within that tolerance of one another, chained) as
//    a changed part's connections, where they are now or where they were.
//    Everywhere else, the links come out as before: the same points, in the
//    same order, going through the same steps.
//  - Within those clusters the steps run as `linkBricks` runs them, in the
//    sheet's order. A part with connections both in and out of them also
//    has its active connection handed over (BlueBrick's onLinked) as in a
//    whole pass: there, its other connections are linked when the pass
//    reaches the first of each pair (`linkBricks` links a pair at its
//    lower connection), so they are linked at that same point here.
//  - Anything this can't follow cheaply (parts added, taken away or
//    reordered, a part whose part number or connection ids changed, two
//    connections with one id, more than a quarter of the sheet changed)
//    goes through a whole pass, as before.

import { bucketKey, cell, onLinked, paddedConnexions, TOL_STUDS, connectionPoints, type BrickLinks, type ConnectionPointsOf } from './connectivity.js';
import type { Brick } from '@cld/model';
import type { PartMetadata } from './types.js';

/** What `Linker.update` gives: each brick's links that may have changed, by its index in the sheet. */
export interface LinkerResult {
  /** Whether it went through every connection of the sheet. */
  whole: boolean;
  /** [index, links] for each brick looked at (null: its part is unknown, it's left as it is). */
  links: Array<[number, BrickLinks | null]>;
  /** How many connections were gone through. */
  looked: number;
}

/** One sheet's links, kept between passes. */
export interface Linker {
  /** The links of `bricks` (one sheet, in its order), working out again only what their changes since the last call can change. */
  update(bricks: readonly Brick[]): LinkerResult;
}

interface State {
  bricks: readonly Brick[];
  metas: (PartMetadata | undefined)[];
  /** Ids of the connections of parts the library doesn't know (links to them are kept). */
  unknown: Set<string>;
  /** Each brick's connection ids, padded to its part's count (empty for an unknown part). */
  ids: string[][];
  /** Each brick's linking connections (indices into the k lists below), in its connection order. */
  ks: number[][];
  // Per linking connection k, in the sheet's order (the order linkBricks goes through them):
  kb: number[];
  kc: number[];
  kx: number[];
  ky: number[];
  kcx: number[];
  kcy: number[];
  kt: string[];
  kid: string[];
  /** The connection k is linked to, or -1. */
  partner: number[];
  idToK: Map<string, number>;
  buckets: Map<number | string, number[]>;
  /** Two connections share an id: every pass is a whole one. */
  dup: boolean;
}

/** Past this share of the sheet changed or affected, a whole pass. */
const MAX_SHARE = 0.25;

export function createLinker(lookup: (partNumber: string) => PartMetadata | undefined, pointsOf: ConnectionPointsOf = connectionPoints): Linker {
  let st: State | null = null;

  function whole(bricks: readonly Brick[]): LinkerResult {
    const n = bricks.length;
    const s: State = {
      bricks,
      metas: new Array(n),
      unknown: new Set(),
      ids: new Array(n),
      ks: new Array(n),
      kb: [],
      kc: [],
      kx: [],
      ky: [],
      kcx: [],
      kcy: [],
      kt: [],
      kid: [],
      partner: [],
      idToK: new Map(),
      buckets: new Map(),
      dup: false,
    };
    for (let bi = 0; bi < n; bi++) {
      const b = bricks[bi]!;
      const meta = lookup(b.partNumber);
      s.metas[bi] = meta;
      if (!meta) for (const c of b.connexions) if (c.id) s.unknown.add(c.id);
    }
    const seen = new Set<string>();
    const padded: ({ id: string; linkedTo: string }[] | null)[] = new Array(n);
    let fresh = 0;
    for (let bi = 0; bi < n; bi++) {
      const b = bricks[bi]!;
      const meta = s.metas[bi];
      s.ks[bi] = [];
      if (!meta) {
        s.ids[bi] = b.connexions.map((c) => c.id);
        padded[bi] = null;
        for (const c of b.connexions) {
          if (!c.id) continue;
          if (seen.has(c.id)) s.dup = true;
          seen.add(c.id);
        }
        continue;
      }
      const conns = paddedConnexions(b, meta);
      padded[bi] = conns;
      let points: ArrayLike<number> | null = null;
      for (let i = 0; i < meta.connections.length; i++) {
        const cp = conns[i]!;
        // As linkBricks names them.
        if (!cp.id) cp.id = `${b.id}_c${fresh++}`;
        if (seen.has(cp.id)) s.dup = true;
        seen.add(cp.id);
        if (cp.linkedTo && s.unknown.has(cp.linkedTo)) continue;
        const c = meta.connections[i]!;
        if (c.type === '') continue;
        points ??= pointsOf(b, meta);
        const k = s.kb.length;
        s.kb.push(bi);
        s.kc.push(i);
        s.kx.push(points[2 * i]!);
        s.ky.push(points[2 * i + 1]!);
        s.kcx.push(cell(points[2 * i]!));
        s.kcy.push(cell(points[2 * i + 1]!));
        s.kt.push(c.type);
        s.kid.push(cp.id);
        s.partner.push(-1);
        s.ks[bi]!.push(k);
        s.idToK.set(cp.id, k);
        addTo(s, k);
      }
      s.ids[bi] = conns.map((c) => c.id);
    }
    st = s;
    const all: number[] = new Array(s.kb.length);
    for (let k = 0; k < all.length; k++) all[k] = k;
    const touched: number[] = new Array(n);
    for (let bi = 0; bi < n; bi++) touched[bi] = bi;
    return { whole: true, links: solve(s, all, touched, padded), looked: all.length };
  }

  return {
    update(bricks) {
      const s = st;
      if (!s || s.dup || bricks.length !== s.bricks.length) return whole(bricks);
      const n = bricks.length;
      const changed: number[] = [];
      for (let bi = 0; bi < n; bi++) {
        if (bricks[bi] === s.bricks[bi]) continue;
        changed.push(bi);
        if (changed.length > MAX_SHARE * n + 8) return whole(bricks);
      }
      if (changed.length === 0) {
        s.bricks = bricks;
        return { whole: false, links: [], looked: 0 };
      }
      // Each changed brick: the same part and connections, only moved or turned (or its links changed).
      const padded = new Map<number, { id: string; linkedTo: string }[]>();
      for (const bi of changed) {
        const nb = bricks[bi]!;
        const ob = s.bricks[bi]!;
        if (nb.id !== ob.id) return whole(bricks);
        const meta = lookup(nb.partNumber);
        if (meta !== s.metas[bi]) return whole(bricks);
        const ids = s.ids[bi]!;
        if (!meta) {
          if (nb.connexions.length !== ids.length || nb.connexions.some((c, i) => c.id !== ids[i])) return whole(bricks);
          continue;
        }
        const conns = paddedConnexions(nb, meta);
        if (conns.length !== ids.length || conns.some((c, i) => !c.id || c.id !== ids[i])) return whole(bricks);
        // The same connections link: none newly linked to (or freed from) an unknown part's.
        const ks = s.ks[bi]!;
        let j = 0;
        for (let i = 0; i < meta.connections.length; i++) {
          const cp = conns[i]!;
          if (cp.linkedTo && s.unknown.has(cp.linkedTo)) continue;
          if (meta.connections[i]!.type === '') continue;
          if (j >= ks.length || s.kc[ks[j]!] !== i) return whole(bricks);
          j++;
        }
        if (j !== ks.length) return whole(bricks);
        padded.set(bi, conns);
      }

      // The connections near where the changed ones were, then the changed ones moved to where they are.
      const seeds: number[] = [];
      for (const bi of changed) for (const k of s.ks[bi]!) near(s, s.kx[k]!, s.ky[k]!, s.kcx[k]!, s.kcy[k]!, seeds);
      for (const bi of changed) {
        const ks = s.ks[bi]!;
        if (ks.length === 0) continue;
        const points = pointsOf(bricks[bi]!, s.metas[bi]!);
        for (const k of ks) {
          const i = s.kc[k]!;
          takeFrom(s, k);
          s.kx[k] = points[2 * i]!;
          s.ky[k] = points[2 * i + 1]!;
          s.kcx[k] = cell(s.kx[k]!);
          s.kcy[k] = cell(s.ky[k]!);
          addTo(s, k);
          seeds.push(k);
        }
      }
      // Their clusters: everything within the tolerance of them, chained.
      const inA = new Set<number>();
      const queue: number[] = [];
      for (const k of seeds) {
        if (inA.has(k)) continue;
        inA.add(k);
        queue.push(k);
      }
      const found: number[] = [];
      while (queue.length > 0) {
        const k = queue.pop()!;
        found.length = 0;
        near(s, s.kx[k]!, s.ky[k]!, s.kcx[k]!, s.kcy[k]!, found);
        for (const j of found) {
          if (inA.has(j)) continue;
          inA.add(j);
          queue.push(j);
        }
        if (inA.size > MAX_SHARE * s.kb.length + 64) return whole(bricks);
      }
      const A = [...inA].sort((a, b) => a - b);
      const touchedSet = new Set<number>(changed);
      for (const k of A) touchedSet.add(s.kb[k]!);
      const touched = [...touchedSet].sort((a, b) => a - b);
      const pads: ({ id: string; linkedTo: string }[] | null)[] = [];
      for (const bi of touched) {
        const meta = s.metas[bi];
        let conns = meta ? padded.get(bi) : null;
        if (meta && !conns) {
          // An unchanged brick near them: its ids as named last time (one
          // left without an id was named by the whole pass, and not written yet).
          conns = paddedConnexions(bricks[bi]!, meta);
          const ids = s.ids[bi]!;
          if (conns.some((c, i) => c.id !== ids[i])) return whole(bricks);
        }
        pads.push(conns ?? null);
      }
      s.bricks = bricks;
      const padByIndex: ({ id: string; linkedTo: string }[] | null)[] = new Array(n);
      touched.forEach((bi, i) => (padByIndex[bi] = pads[i]!));
      return { whole: false, links: solve(s, A, touched, padByIndex), looked: A.length };
    },
  };
}

function addTo(s: State, k: number): void {
  const key = bucketKey(s.kcx[k]!, s.kcy[k]!);
  const arr = s.buckets.get(key);
  if (arr) arr.push(k);
  else s.buckets.set(key, [k]);
}

function takeFrom(s: State, k: number): void {
  const key = bucketKey(s.kcx[k]!, s.kcy[k]!);
  const arr = s.buckets.get(key);
  if (!arr) return;
  const i = arr.indexOf(k);
  if (i >= 0) arr.splice(i, 1);
  if (arr.length === 0) s.buckets.delete(key);
}

/** The connections within the tolerance of (x, y) (in cell cx, cy), onto `out`. */
function near(s: State, x: number, y: number, cx: number, cy: number, out: number[]): void {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const arr = s.buckets.get(bucketKey(cx + dx, cy + dy));
      if (!arr) continue;
      for (const j of arr) if (Math.abs(x - s.kx[j]!) < TOL_STUDS && Math.abs(y - s.ky[j]!) < TOL_STUDS) out.push(j);
    }
  }
}

/**
 * linkBricks's steps for the connections `A` (sorted, a union of whole
 * clusters), on the bricks `touched` (sorted: every brick with a
 * connection in A, and the changed ones), whose padded connections are in
 * `padded` by brick index. Records the partners found; gives each touched
 * brick's links.
 */
function solve(s: State, A: readonly number[], touched: readonly number[], padded: readonly ({ id: string; linkedTo: string }[] | null)[]): Array<[number, BrickLinks | null]> {
  const out: Array<[number, BrickLinks | null]> = [];
  const w = new Map<number, BrickLinks>();
  const inA = new Set(A);
  // connection id -> its link before this pass
  const previous = new Map<string, string>();
  // The linking connections out of A on the touched bricks: linked to the
  // same partner as before, at the step of the pair's lower connection.
  const events: number[] = [];
  for (const bi of touched) {
    const conns = padded[bi];
    const meta = s.metas[bi];
    if (!conns || !meta) {
      out.push([bi, null]);
      continue;
    }
    const links: BrickLinks = { connexions: conns, activeConnectionPointIndex: s.bricks[bi]!.activeConnectionPointIndex };
    w.set(bi, links);
    out.push([bi, links]);
    for (let i = 0; i < meta.connections.length; i++) {
      const cp = conns[i]!;
      if (cp.linkedTo && s.unknown.has(cp.linkedTo)) continue;
      if (cp.linkedTo) previous.set(cp.id, cp.linkedTo);
      cp.linkedTo = '';
    }
    for (const k of s.ks[bi]!) if (!inA.has(k) && s.partner[k]! >= 0) events.push(k);
  }
  const at = (k: number) => Math.min(k, s.partner[k]!);
  events.sort((a, b) => at(a) - at(b));
  const linkOf = (k: number) => w.get(s.kb[k]!)!.connexions[s.kc[k]!]!;
  let e = 0;
  const upTo = (t: number) => {
    while (e < events.length && at(events[e]!) < t) {
      const k = events[e++]!;
      linkOf(k).linkedTo = s.kid[s.partner[k]!]!;
    }
  };

  for (const i of A) {
    upTo(i);
    const ca = linkOf(i);
    if (ca.linkedTo !== '') continue;
    const ax = s.kcx[i]!;
    const ay = s.kcy[i]!;
    const aBrick = s.kb[i]!;
    const aType = s.kt[i]!;
    const x = s.kx[i]!;
    const y = s.ky[i]!;
    let bestJ = -1;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const near = s.buckets.get(bucketKey(ax + dx, ay + dy));
        if (!near) continue;
        for (const j of near) {
          if (j === i || (bestJ >= 0 && j >= bestJ)) continue;
          if (aBrick === s.kb[j] || aType !== s.kt[j]) continue;
          if (Math.abs(x - s.kx[j]!) >= TOL_STUDS || Math.abs(y - s.ky[j]!) >= TOL_STUDS) continue;
          // (Within the tolerance of one in A: in A.)
          if (linkOf(j).linkedTo !== '') continue;
          bestJ = j;
        }
      }
    }
    if (bestJ < 0) continue;
    const cb = linkOf(bestJ);
    const bBrick = s.kb[bestJ]!;
    const isNew = previous.get(ca.id) !== cb.id;
    if (isNew) onLinked(w.get(aBrick)!, s.bricks[aBrick]!.myGroup, s.kc[i]!, s.metas[aBrick]!);
    ca.linkedTo = cb.id;
    if (isNew) onLinked(w.get(bBrick)!, s.bricks[bBrick]!.myGroup, s.kc[bestJ]!, s.metas[bBrick]!);
    cb.linkedTo = ca.id;
  }
  upTo(Infinity);

  // A link that broke frees its connection; if the brick's active
  // connection is taken, the freed one becomes active.
  for (const k of A) {
    const cp = linkOf(k);
    if (!previous.has(cp.id) || cp.linkedTo !== '') continue;
    const links = w.get(s.kb[k]!)!;
    const active = links.activeConnectionPointIndex;
    if (active >= 0 && active < links.connexions.length && links.connexions[active]!.linkedTo !== '') links.activeConnectionPointIndex = s.kc[k]!;
  }
  for (const k of A) s.partner[k] = s.idToK.get(linkOf(k).linkedTo) ?? -1;
  return out;
}
