// One decode of an incoming update, shared by the checks that read its
// structs (ws/gridGuard.ts, ws/mergeGuard.ts) before Yjs applies it.
//
// Y.decodeUpdate builds a struct object per item, which for a 1000-part
// paste is several thousand objects; the live handler used to do that once
// per check. The structs here are never integrated or changed, so the
// checks can share them.

import * as Y from 'yjs';

export type Struct = Y.Item | Y.GC | Y.Skip;
export type DeleteSet = ReturnType<typeof Y.decodeUpdate>['ds'];

export interface DecodedUpdate {
  structs: Struct[];
  ds: DeleteSet;
  /** The structs per client, sorted by clock (for findStruct). */
  byClient: Map<number, Struct[]>;
  /**
   * Two structs of one client cover the same clock (only a hand-made
   * update does that; Yjs then reads one of them, findStruct may return
   * the other). Checks that look items up by id treat such an update
   * the slow, exact way.
   */
  overlapping: boolean;
}

/**
 * Work the live checks have done, for the perf budget test
 * (routes/test/wsPerfBudget.test.ts): it counts work, not time, so it
 * holds on a busy CI runner.
 */
export const guardWork = {
  /** Updates decoded into structs (decodeIncoming). */
  decodes: 0,
  /** Copies of a room's document made to work out what an update leaves (gridGuard). */
  docCopies: 0,
  /** Bytes of the room's documents those copies held (gridGuard). */
  copyBytes: 0,
  /** Updates whose grid sizes were worked out from the keys they touch, without a copy (gridGuard). */
  gridExact: 0,
  /** Layers whose type and grid size that took reading (gridGuard): a few per update, whatever the layout's size. */
  gridLayersRead: 0,
  /** Updates that broke the lock on shared modules, which the server then put back (sharedGuard.ts repairShared). */
  sharedPutBack: 0,
};

/** The update's structs, or null when Yjs can't read it (Yjs then refuses it on its own). */
export function decodeIncoming(update: Uint8Array): DecodedUpdate | null {
  guardWork.decodes += 1;
  let decoded: { structs: Struct[]; ds: DeleteSet };
  try {
    decoded = Y.decodeUpdate(update) as { structs: Struct[]; ds: DeleteSet };
  } catch {
    return null;
  }
  const byClient = new Map<number, Struct[]>();
  for (const s of decoded.structs) {
    let list = byClient.get(s.id.client);
    if (!list) byClient.set(s.id.client, (list = []));
    list.push(s);
  }
  // Yjs writes each client's structs in clock order; sorting keeps the
  // binary search right for an update written some other way.
  let overlapping = false;
  for (const list of byClient.values()) {
    for (let i = 1; i < list.length; i++) {
      if (list[i]!.id.clock < list[i - 1]!.id.clock) {
        list.sort((a, b) => a.id.clock - b.id.clock);
        break;
      }
    }
    for (let i = 1; i < list.length && !overlapping; i++) {
      const prev = list[i - 1]!;
      if (list[i]!.id.clock < prev.id.clock + prev.length) overlapping = true;
    }
  }
  return { structs: decoded.structs, ds: decoded.ds, byClient, overlapping };
}

/** The struct of `list` (one client's, sorted by clock) that holds `clock`. */
export function findStruct(list: Struct[] | undefined, clock: number): Struct | null {
  if (!list) return null;
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = list[mid]!;
    if (clock < s.id.clock) hi = mid - 1;
    else if (clock >= s.id.clock + s.length) lo = mid + 1;
    else return s;
  }
  return null;
}
