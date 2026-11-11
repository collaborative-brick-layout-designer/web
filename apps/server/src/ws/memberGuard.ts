// A module's parts, one key per part (@cld/ydoc moduleMembers.ts, doc
// shape 3): each part added to a module or taken out of it is a key
// `p:<n>:<moduleId>:<partId>` of the `sidecarItems` map, holding a number
// (the part is in the module) or `false` (it was taken out of the module's
// starting list). Both apps skip any other value when reading, so a bad one
// loses nothing; but whatever the server takes it stores and sends to
// everyone, so an update that writes one is refused like one the apps
// can't read (ws/updateGuard.ts):
//
//   - a `p:` key that doesn't name a module and a part the way a writer
//     makes it;
//   - a `p:` key holding anything but `false` or a finite number from 0 up
//     (a string, `true`, a negative number, a nested type, two values).
//
// A value the update itself deletes is never read, and is let through (an
// app deleting a key it wrote in the same step). Only the update's structs
// are read (decoded once, ws/decoded.ts), and a value's key is the one Yjs
// gives it: its own, else the key of the value it replaces.

import * as Y from 'yjs';
import { MEMBER_PREFIX, parseMemberKey, validMemberValue } from '@cld/ydoc';
import { decodeIncoming, findStruct, type DecodedUpdate } from './decoded.js';

const SIDECAR_ITEMS = 'sidecarItems';

/** Where a map value sits: the root map's name (null: not a root map, or unknown) and its key. */
interface Place {
  root: string | null;
  key: string | null;
}
const NOWHERE: Place = { root: null, key: null };

/**
 * Null when every module part key `update` writes is one the apps make;
 * else why not, for the log. `doc` is the room's document, or null for a
 * whole document on its own.
 */
export function memberKeyProblem(doc: Y.Doc | null, decoded: DecodedUpdate): string | null {
  const { structs, ds, byClient } = decoded;
  const known = (id: Y.ID): boolean => !!doc && id.clock < Y.getState(doc.store, id.client);
  const places = new Map<Y.Item, Place>();
  const placeOf = (start: Y.Item): Place => {
    const chain: Y.Item[] = [];
    const seen = new Set<Y.Item>();
    let item: Y.Item | null = start;
    let place = NOWHERE;
    while (item) {
      const memo = places.get(item);
      if (memo) {
        place = memo;
        break;
      }
      chain.push(item);
      seen.add(item);
      if (item.parentSub !== null) {
        place = { root: typeof item.parent === 'string' ? item.parent : null, key: item.parentSub };
        break;
      }
      // Its parent written without a key: a list item, not a map value.
      if (item.parent !== null) break;
      const ref: Y.ID | null = item.origin ?? item.rightOrigin;
      if (!ref) break;
      if (known(ref)) {
        try {
          const there = Y.getItem(doc!.store, ref);
          if (there instanceof Y.Item && there.parentSub !== null) {
            const parent = there.parent as Y.AbstractType<unknown> | null;
            const isItems = !!parent && parent._item === null && doc!.share.get(SIDECAR_ITEMS) === parent;
            place = { root: isItems ? SIDECAR_ITEMS : null, key: there.parentSub };
          }
        } catch {
          place = NOWHERE;
        }
        break;
      }
      const next = findStruct(byClient.get(ref.client), ref.clock);
      item = next instanceof Y.Item && !seen.has(next) ? next : null;
    }
    for (const c of chain) places.set(c, place);
    return place;
  };
  const deleted = (item: Y.Item): boolean => {
    const { client, clock } = item.id;
    const end = clock + item.length;
    // (Every clock of it: one left standing is read.)
    let covered = clock;
    const ranges = [...(ds.clients.get(client) ?? [])].sort((a, b) => a.clock - b.clock);
    for (const r of ranges) {
      if (r.clock > covered) break;
      covered = Math.max(covered, r.clock + r.len);
      if (covered >= end) return true;
    }
    return false;
  };
  for (const s of structs) {
    if (!(s instanceof Y.Item)) continue;
    const { root, key } = placeOf(s);
    if (root !== SIDECAR_ITEMS || key === null || !key.startsWith(MEMBER_PREFIX)) continue;
    const c = s.content;
    // Already deleted where it came from, or deleted by this update.
    if (c instanceof Y.ContentDeleted || deleted(s)) continue;
    if (!parseMemberKey(key)) return "it writes a module part key that names no module and part";
    if (!(c instanceof Y.ContentAny) || c.arr.length !== 1 || !validMemberValue(c.arr[0])) {
      return "it gives a module's part a value that is neither a place in the module nor 'taken out'";
    }
  }
  return null;
}

/** memberKeyProblem for a whole document on its own (a snapshot). Unreadable: the update guard refuses it. */
export function snapshotMemberKeyProblem(bytes: Uint8Array): string | null {
  const decoded = decodeIncoming(bytes);
  return decoded ? memberKeyProblem(null, decoded) : null;
}
