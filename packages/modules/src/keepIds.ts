// Updates that keep the ids of unchanged parts (docs/shared-modules.md,
// phase 3): putting another version of a library module in place of a
// placed module's parts changes only the parts that differ, and keeps
// the rest (their ids, and their history in the layout) as they are.
//
// The rule, the same in the server (replace.ts updateModuleParts) and the
// desktop (edit/SharedModuleKeep.cpp), with shared vectors in
// fixtures/contracts/shared-module-keep.json:
//
// 1. Match. Go through the new version's parts in its order (batch by
//    batch, part by part), each already placed where it goes and with the
//    sheet it goes on. Each takes the first of the module's parts now on
//    the map (sheets in layer order, each bottom to top) not taken yet
//    that is the same part: on that sheet, the same part number (any
//    case), the same height, its pivot within 0.1 studs and its turn
//    within 0.5° (as matchesVersion counts a part in place).
// 2. Order. On each sheet, the matched parts must already be in the
//    version's order, bottom to top. Of those that aren't, the most that
//    can stay do (the longest run in order, the same as assignZ keeps);
//    the others count as not matched.
// 3. Sets. A matched part's sets (its group, the group above that, ...)
//    must be the version part's, one for one. When any pair disagrees, no
//    part is matched: the whole module is put in again, as before this.
// 4. Change. A part not matched goes; a version part not matched comes in,
//    new, in its sets (the sets of matched parts it shares, else new
//    copies). Each new part goes just above the module part before it in
//    the version's order on its sheet, else just below the next one, else
//    on top of the sheet. So the module's parts on each sheet end in the
//    version's order. Matched parts aren't touched at all.

import type { Group, RectangleF } from '@cld/model';
import { pivotOf, type PartLookup } from './geometry.js';
import { norm360 } from './placement.js';
import { groupChain } from './replace.js';
import type { BatchBrick } from './batches.js';

/** Within this a part is where the version puts it (studs, degrees), as partsInPlace counts it. */
export const KEEP_SHIFT = 0.1;
export const KEEP_TURN = 0.5;

/** One part on a sheet, as the plan needs it. */
export interface SheetPart {
  id: string;
  partNumber: string;
  displayArea: RectangleF;
  orientation: number;
  altitude: number;
  myGroup: string;
}

/** A parts sheet: its parts bottom to top, and its sets. */
export interface PlanSheet {
  id: string;
  parts: SheetPart[];
  groups: Group[];
}

/** One batch of the new version, already placed, with the sheet it goes on. */
export interface PlanBatch {
  sheetId: string;
  bricks: BatchBrick[];
  groups?: Group[];
}

/** A version part by its place in the batches: "b.i". */
export const versionKey = (batch: number, index: number): string => `${batch}.${index}`;

export interface KeepPlan {
  /** Version part key → the id of the part on the map it is (matched). */
  kept: Map<string, string>;
  /** The module's parts that go (not matched), by id. */
  removed: string[];
  /** Version parts that come in new, by key, in the version's order. */
  added: string[];
  /** For each new part: where it goes, as an index into its sheet's final order, bottom to top. */
  sheets: Map<string, string[]>;
  /** A version set ("b/<its id>") → the set on the map it is (shared with matched parts). */
  groupMap: Map<string, string>;
  /** Each new part's sets, innermost first: the id of a set on the map, or "new:b/<version set id>" for a copy made for it. */
  newGroups: Map<string, string[]>;
}

const turnApart = (a: number, b: number): number => {
  const d = Math.abs(norm360(a) - norm360(b));
  return Math.min(d, 360 - d);
};

/** The indexes of the longest strictly increasing run of `seq` (the same picks as assignZ). */
export function longestRun(seq: readonly number[]): Set<number> {
  const tails: number[] = [];
  const prev = new Array<number>(seq.length).fill(-1);
  seq.forEach((v, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]!]! < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  });
  const keep = new Set<number>();
  for (let k = tails.length ? tails[tails.length - 1]! : -1; k >= 0; k = prev[k]!) keep.add(k);
  return keep;
}

/**
 * Which of a placed module's parts (`members`, on `sheets`) stay when
 * `next` (the new version, placed) goes in, and where the new ones go.
 * Each sheet's final order is its parts bottom to top: the ids of the
 * parts that stay on it (the module's and every other part), and "new:b.i"
 * for each version part that comes in.
 */
export function planKeep(sheets: readonly PlanSheet[], members: ReadonlySet<string>, next: readonly PlanBatch[], partOf: PartLookup): KeepPlan {
  // The module's parts now, in the order they're looked at.
  type Here = { part: SheetPart; sheet: string; at: number; pivot: { x: number; y: number }; o: number };
  const here: Here[] = [];
  const groupsOf = new Map<string, Group[]>();
  for (const s of sheets) {
    groupsOf.set(s.id, s.groups);
    s.parts.forEach((part, at) => {
      if (!members.has(part.id)) return;
      here.push({ part, sheet: s.id, at, pivot: pivotOf({ displayArea: part.displayArea, orientation: part.orientation }, partOf(part.partNumber)), o: norm360(part.orientation) });
    });
  }
  // 1. Match.
  type Pair = { key: string; batch: number; index: number; sheet: string; there: Here };
  let pairs: Pair[] = [];
  const used = new Set<Here>();
  next.forEach((batch, b) => {
    batch.bricks.forEach((brick, i) => {
      const o = norm360(brick.orientation ?? 0);
      const p = pivotOf({ displayArea: brick.displayArea, orientation: brick.orientation ?? 0 }, partOf(brick.partNumber));
      const pn = brick.partNumber.toLowerCase();
      const alt = brick.altitude ?? 0;
      const there = here.find(
        (h) =>
          !used.has(h) &&
          h.sheet === batch.sheetId &&
          h.part.partNumber.toLowerCase() === pn &&
          Math.abs((h.part.altitude ?? 0) - alt) < 1e-6 &&
          Math.hypot(h.pivot.x - p.x, h.pivot.y - p.y) < KEEP_SHIFT &&
          turnApart(h.o, o) < KEEP_TURN,
      );
      if (!there) return;
      used.add(there);
      pairs.push({ key: versionKey(b, i), batch: b, index: i, sheet: batch.sheetId, there });
    });
  });
  // 2. Order, sheet by sheet.
  const inOrder = new Set<Pair>();
  for (const s of sheets) {
    const onSheet = pairs.filter((p) => p.sheet === s.id);
    const run = longestRun(onSheet.map((p) => p.there.at));
    onSheet.forEach((p, i) => {
      if (run.has(i)) inOrder.add(p);
    });
  }
  pairs = pairs.filter((p) => inOrder.has(p));
  // 3. Sets, one for one.
  const groupMap = new Map<string, string>();
  const back = new Map<string, string>();
  let setsAgree = true;
  for (const p of pairs) {
    const mine = groupChain(groupsOf.get(p.sheet), p.there.part.myGroup || undefined).map((g) => g.id);
    const theirs = groupChain(next[p.batch]!.groups, next[p.batch]!.bricks[p.index]!.myGroup || undefined).map((g) => g.id);
    if (mine.length !== theirs.length) {
      setsAgree = false;
      break;
    }
    for (let k = 0; k < mine.length && setsAgree; k++) {
      const v = `${p.batch}/${theirs[k]!}`;
      const was = groupMap.get(v);
      const wasBack = back.get(mine[k]!);
      if ((was !== undefined && was !== mine[k]) || (wasBack !== undefined && wasBack !== v)) setsAgree = false;
      groupMap.set(v, mine[k]!);
      back.set(mine[k]!, v);
    }
    if (!setsAgree) break;
  }
  if (!setsAgree) {
    pairs = [];
    groupMap.clear();
  }
  // 4. Change.
  const kept = new Map(pairs.map((p) => [p.key, p.there.part.id] as const));
  const keptIds = new Set(kept.values());
  const removed = here.filter((h) => !keptIds.has(h.part.id)).map((h) => h.part.id);
  const gone = new Set(removed);
  const added: string[] = [];
  const order = new Map<string, string[]>();
  for (const s of sheets) order.set(s.id, s.parts.map((p) => p.id).filter((id) => !gone.has(id)));
  // The version's parts per sheet, in its order: each kept one's id, or the new one's token.
  const bySheet = new Map<string, string[]>();
  next.forEach((batch, b) => {
    batch.bricks.forEach((_, i) => {
      const key = versionKey(b, i);
      const id = kept.get(key);
      if (id === undefined) added.push(key);
      const list = bySheet.get(batch.sheetId) ?? [];
      list.push(id ?? `new:${key}`);
      bySheet.set(batch.sheetId, list);
    });
  });
  for (const [sheetId, want] of bySheet) {
    const list = order.get(sheetId);
    if (!list) continue;
    want.forEach((token, i) => {
      if (!token.startsWith('new:')) return;
      // Just above the module part before it in the version's order, else just below the next kept one, else on top.
      let at = -1;
      for (let k = i - 1; k >= 0 && at < 0; k--) {
        const j = list.indexOf(want[k]!);
        if (j >= 0) at = j + 1;
      }
      if (at < 0) {
        for (let k = i + 1; k < want.length && at < 0; k++) {
          if (want[k]!.startsWith('new:')) continue;
          const j = list.indexOf(want[k]!);
          if (j >= 0) at = j;
        }
      }
      if (at < 0) at = list.length;
      list.splice(at, 0, token);
    });
  }
  const newGroups = new Map<string, string[]>();
  for (const key of added) {
    const [b, i] = key.split('.').map(Number) as [number, number];
    const chain = groupChain(next[b]!.groups, next[b]!.bricks[i]!.myGroup || undefined);
    newGroups.set(
      key,
      chain.map((g) => groupMap.get(`${b}/${g.id}`) ?? `new:${b}/${g.id}`),
    );
  }
  return { kept, removed, added, sheets: order, groupMap, newGroups };
}
