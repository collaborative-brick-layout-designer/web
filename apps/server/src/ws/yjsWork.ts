// How much work Yjs does to apply an update, worked out from its structs
// before anything else reads it. Most of applying is linear in the
// update's size, but two parts aren't:
//   - each range of the delete set walks every struct it covers, so the
//     same range listed many times costs the struct count again each time;
//   - a range that starts or ends inside a struct, and an insert placed
//     after or before a clock inside one, splits that struct, copying the
//     part after the split (a struct of many values split many times is
//     quadratic).
// Neither app writes updates like that (a delete set is sorted and merged,
// and a struct is split once where an edit lands), so an update past
// MAX_UPDATE_WORK is refused like one the apps can't read, and what each
// person's updates cost is limited (workBudget, ws/pacing.ts). Waiting
// changes that may land with the update count too (ws/pending.ts).

import * as Y from 'yjs';
import { decodeIncoming, type DecodedUpdate, type DeleteSet, type Struct } from './decoded.js';
import { pendingMayLand, trimPending } from './pending.js';

/** The most work one update may take, in structs walked plus values copied (about 50 ms). */
export const MAX_UPDATE_WORK = 4_000_000;

/** Index of the struct of `list` (sorted by clock) holding `clock`, or -1. */
function indexOf(list: readonly Struct[], clock: number): number {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = list[mid]!;
    if (clock < s.id.clock) hi = mid - 1;
    else if (clock >= s.id.clock + s.length) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** The struct lists an update lands on: the room's, then the update's own. */
interface Lists {
  doc: Y.Doc | null;
  update: Map<number, Struct[]>;
}

function listsOf(l: Lists, client: number): (readonly Struct[])[] {
  const out: (readonly Struct[])[] = [];
  const d = l.doc?.store.clients.get(client);
  if (d) out.push(d as Struct[]);
  const u = l.update.get(client);
  if (u) out.push(u);
  return out;
}

/** Whether two structs of `list` (sorted by clock) cover the same clock. */
const overlapsSeen = new WeakMap<readonly Struct[], boolean>();
function overlaps(list: readonly Struct[]): boolean {
  let seen = overlapsSeen.get(list);
  if (seen === undefined) {
    seen = false;
    for (let i = 1; i < list.length && !seen; i++) {
      const prev = list[i - 1]!;
      if (list[i]!.id.clock < prev.id.clock + prev.length) seen = true;
    }
    overlapsSeen.set(list, seen);
  }
  return seen;
}

/**
 * Work of a delete range on structs that overlap (a hand-made update with
 * two blocks of one client). Which of them Yjs keeps isn't known here, so
 * count every one the range touches, and the whole of each one it splits:
 * the document Yjs ends up with then never costs more than this said.
 */
function overlappingRangeWork(list: readonly Struct[], from: number, to: number): number {
  let work = 0;
  for (const s of list) {
    const start = s.id.clock;
    const stop = start + s.length;
    if (stop <= from || start >= to) continue;
    work += 1;
    if (start < from || stop > to) work += s.length;
  }
  return work;
}

/** Work of one delete range on the structs it lands on. */
function rangeWork(l: Lists, client: number, clock: number, len: number): number {
  let work = 1;
  const end = clock + len;
  for (const list of listsOf(l, client)) {
    if (list.length === 0) continue;
    // A room's own structs never overlap; only an update's can.
    if (list === l.update.get(client) && overlaps(list)) {
      work += overlappingRangeWork(list, clock, end);
      continue;
    }
    const first = list[0]!.id.clock;
    const last = list[list.length - 1]!;
    const from = Math.max(clock, first);
    const to = Math.min(end, last.id.clock + last.length);
    if (from >= to) continue;
    const i = indexOf(list, from);
    const j = indexOf(list, to - 1);
    if (i < 0 || j < 0) {
      // A gap: as if it walked them all, and what it splits at either end.
      const a = i < 0 ? undefined : list[i]!;
      const b = j < 0 ? undefined : list[j]!;
      work += list.length;
      if (a && a.id.clock < from) work += a.length;
      if (b && b.id.clock + b.length > to) work += b.length;
      continue;
    }
    work += j - i + 1;
    const a = list[i]!;
    const b = list[j]!;
    if (a.id.clock < from) work += a.length;
    if (b.id.clock + b.length > to) work += b.length;
  }
  return work;
}

function deleteSetWork(l: Lists, ds: DeleteSet): number {
  let work = 0;
  for (const [client, ranges] of ds.clients) for (const r of ranges) work += rangeWork(l, client, r.clock, r.len);
  return work;
}

/** Work of splitting the struct holding `id` so that `id` ends a piece (`after`) or starts one. */
function splitWork(l: Lists, id: Y.ID, after: boolean): number {
  for (const list of listsOf(l, id.client)) {
    const i = indexOf(list, id.clock);
    if (i < 0) continue;
    const s = list[i]!;
    const splits = after ? id.clock !== s.id.clock + s.length - 1 : id.clock !== s.id.clock;
    return splits ? s.length : 0;
  }
  return 0;
}

function structsWork(l: Lists, structs: readonly Struct[]): number {
  let work = 0;
  for (const s of structs) {
    if (!(s instanceof Y.Item)) continue;
    if (s.origin) work += splitWork(l, s.origin, true);
    if (s.rightOrigin) work += splitWork(l, s.rightOrigin, false);
  }
  return work;
}

/** Waiting changes read once per record (Yjs replaces the record when it changes). */
const decodedPending = new WeakMap<Uint8Array, ReturnType<typeof Y.decodeUpdateV2> | null>();
function decodePending(bytes: Uint8Array): ReturnType<typeof Y.decodeUpdateV2> | null {
  if (!decodedPending.has(bytes)) {
    try {
      decodedPending.set(bytes, Y.decodeUpdateV2(bytes));
    } catch {
      decodedPending.set(bytes, null);
    }
  }
  return decodedPending.get(bytes)!;
}

/** The work Yjs does to apply `update` to `doc` (null: a whole document on its own). */
export function yjsWork(doc: Y.Doc | null, update: DecodedUpdate): number {
  return ownWork(doc, update) + waitingWork(doc, update);
}

/** The part of it that is the update's own. */
export function ownWork(doc: Y.Doc | null, update: DecodedUpdate): number {
  const l: Lists = { doc, update: update.byClient };
  return structsWork(l, update.structs) + deleteSetWork(l, update.ds);
}

/** The part that is changes waiting in `doc` that may land with it. */
function waitingWork(doc: Y.Doc | null, update: DecodedUpdate): number {
  const l: Lists = { doc, update: update.byClient };
  let work = 0;
  if (doc && pendingMayLand(doc, update)) {
    const ps = doc.store.pendingStructs ? decodePending(doc.store.pendingStructs.update) : null;
    if (ps) work += structsWork(l, ps.structs) + deleteSetWork(l, ps.ds);
    const pds = doc.store.pendingDs ? decodePending(doc.store.pendingDs) : null;
    if (pds) work += deleteSetWork(l, pds.ds);
  }
  return work;
}

/** Why an update is refused for its work, or null. */
export function checkUpdateWork(doc: Y.Doc | null, update: DecodedUpdate): string | null {
  const work = yjsWork(doc, update);
  return work > MAX_UPDATE_WORK ? `applying it would take ${work} steps, more than ${MAX_UPDATE_WORK}` : null;
}

/**
 * The most work one stored update may take when a layout is read back from
 * its update log (several live updates are stored as one): past it, the
 * entry is skipped and logged instead of applied.
 */
export const MAX_STORED_UPDATE_WORK = 16 * MAX_UPDATE_WORK;

/**
 * Apply a stored update (the update log) to `doc`, unless it would take
 * more than MAX_STORED_UPDATE_WORK; false when it was skipped or Yjs
 * couldn't apply it. `where` names the layout for the log.
 */
export function applyStoredUpdate(doc: Y.Doc, bytes: Uint8Array, where: string): boolean {
  const decoded = decodeIncoming(bytes);
  if (decoded) {
    const work = yjsWork(doc, decoded);
    if (work > MAX_STORED_UPDATE_WORK) {
      console.warn(`[yjsWork] ${where}: skipped a stored update of ${bytes.length} bytes that would take ${work} steps to apply`);
      return false;
    }
  }
  try {
    Y.applyUpdate(doc, bytes);
    trimPending(doc);
    return true;
  } catch {
    return false; // corrupt: the snapshot is the source of truth
  }
}

/** Why a whole document uploaded on its own (a snapshot) is refused for its work, or null. */
export function snapshotWork(bytes: Uint8Array): string | null {
  const decoded = decodeIncoming(bytes);
  return decoded ? checkUpdateWork(null, decoded) : null;
}
