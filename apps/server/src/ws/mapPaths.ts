// Where the map values an update writes sit (its names from a root map
// down), read from its structs and the room's document: for the guards of
// records kept one Y.Map each (placesGuard.ts, carsGuard.ts). Exact but for
// what is waiting for other changes, or two structs for one id: those are
// worked out on a copy of the layout.

import * as Y from 'yjs';
import { findStruct, type DecodedUpdate } from './decoded.js';

/** Where a map value sits: the names from its root map down ([root, key, key...]); null when it isn't a map value, or can't be told. */
export type Path = readonly string[] | null;

/** Where `decoded`'s items go in `doc` (null: a document of its own), and which of them it deletes itself. */
export function pathsOf(doc: Y.Doc | null, decoded: DecodedUpdate): { pathOf: (item: Y.Item) => Path; deleted: (item: Y.Item) => boolean } {
  const { ds, byClient } = decoded;
  const known = (id: Y.ID): boolean => !!doc && id.clock < Y.getState(doc.store, id.client);
  const paths = new Map<Y.Item, Path>();
  /** The path of an item that is in the room already. */
  const inRoom = (item: Y.Item): Path => {
    const out: string[] = [];
    let at: Y.Item | null = item;
    for (let depth = 0; at && depth < 8; depth++) {
      if (at.parentSub === null) return null;
      out.unshift(at.parentSub);
      const parent = at.parent as Y.AbstractType<unknown> | null;
      if (!parent) return null;
      if (parent._item === null) {
        for (const [name, t] of doc!.share) if (t === parent) return [name, ...out];
        return null;
      }
      at = parent._item;
    }
    return null;
  };
  const itemAt = (id: Y.ID): Y.Item | null => {
    if (known(id)) {
      try {
        const there = Y.getItem(doc!.store, id);
        return there instanceof Y.Item ? there : null;
      } catch {
        return null;
      }
    }
    const there = findStruct(byClient.get(id.client), id.clock);
    return there instanceof Y.Item ? there : null;
  };
  const pathOf = (start: Y.Item, depth = 0): Path => {
    // Deeper than any place is (a hand-made update may nest without end).
    if (depth > 6) return null;
    // The chain of neighbours, then of parents, to one whose place is known.
    const memo = paths.get(start);
    if (memo !== undefined) return memo;
    const chain: Y.Item[] = [];
    const seen = new Set<Y.Item>();
    let at: Y.Item | null = start;
    let path: Path = null;
    while (at && !seen.has(at)) {
      const had = paths.get(at);
      if (had !== undefined) {
        path = had;
        break;
      }
      seen.add(at);
      chain.push(at);
      if (typeof at.parent === 'string') {
        path = at.parentSub === null ? null : [at.parent, at.parentSub];
        break;
      }
      if (at.parent !== null) {
        if (at.parentSub === null) break;
        const id = at.parent as unknown as Y.ID;
        const holder = itemAt(id);
        if (!holder) break;
        const up: Path = known(id) ? inRoom(holder) : seen.has(holder) ? null : pathOf(holder, depth + 1);
        path = up && up.length < 5 ? [...up, at.parentSub] : null;
        break;
      }
      const ref: Y.ID | null = at.origin ?? at.rightOrigin;
      if (!ref) break;
      if (known(ref)) {
        const there = itemAt(ref);
        path = there ? inRoom(there) : null;
        break;
      }
      at = itemAt(ref);
    }
    // (Neighbours in one map share its key: Yjs gives an item its neighbour's.)
    for (const c of chain) paths.set(c, path);
    return path;
  };
  const deleted = (item: Y.Item): boolean => {
    const end = item.id.clock + item.length;
    let covered = item.id.clock;
    const ranges = [...(ds.clients.get(item.id.client) ?? [])].sort((a, b) => a.clock - b.clock);
    for (const r of ranges) {
      if (r.clock > covered) break;
      covered = Math.max(covered, r.clock + r.len);
      if (covered >= end) return true;
    }
    return false;
  };
  return { pathOf: (item) => pathOf(item), deleted };
}
