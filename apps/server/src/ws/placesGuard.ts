// Places (Live Ops design 2.1, @cld/bbm places.ts) as a layout's document
// holds them: the layout's own at `meta.places` (a Y.Map of id -> a Y.Map
// of fields), a module's in its sidecar value (`sidecarItems` `m:<id>`
// `places`, and again in `meta.cache`'s modules). Both apps put what they
// read within the limits (PLACE_LIMITS), so a bad one loses nothing there;
// but whatever the server takes it stores and sends to everyone, so an
// update that writes a place outside the limits is refused like one the
// apps can't read (ws/updateGuard.ts):
//
//   - `meta.places` as anything but a map, an entry that isn't a map, a
//     field that isn't what a place holds, or more than MAX_LAYOUT_PLACES;
//   - a module's `places` (or a sidecar's `layoutPlaces`) that aren't
//     within the limits, unless the layout already held them so.
//
// A value the update itself deletes is never read, and is let through.
// Only the update's structs are read, and an update that writes nothing of
// the kind costs one pass over them.

import * as Y from 'yjs';
import { PLACE_LIMITS, validPlace, validPlaces } from '@cld/bbm';
import { PLACES_KEY, readSidecarCache } from '@cld/ydoc';
import { decodeIncoming, findStruct, type DecodedUpdate } from './decoded.js';

/** More than the apps make (two people may each add the last ones at once). */
export const MAX_LAYOUT_PLACES = 2 * PLACE_LIMITS.places;

/** Where a map value sits: the names from its root map down ([root, key, key...]); null when it isn't a map value, or can't be told. */
type Path = readonly string[] | null;

/** A whole, valid place but for the fields a test replaces. */
const BLANK = { id: 'x', name: '', kind: 'industry', spots: [], accepts: [], ships: [], tags: [], notes: '' };

/** Whether `value` may be field `field` of a place. */
export function validPlaceField(field: string, value: unknown): boolean {
  if (field.length > PLACE_LIMITS.kind) return false;
  if (value instanceof Y.AbstractType) return false;
  return validPlace({ ...BLANK, [field]: value });
}

/**
 * Null when every place `update` writes is within the limits; else why
 * not, for the log. `doc` is the room's document, or null for a whole
 * document on its own.
 */
export function placesProblem(doc: Y.Doc | null, decoded: DecodedUpdate): string | null {
  const { structs, ds, byClient } = decoded;
  // Cheap first: does the update say anything a place could be in?
  const holdsPlaces = !!(doc?.share.get('meta') as unknown as { _map?: Map<string, Y.Item> } | undefined)?._map?.has(PLACES_KEY);
  const suspect = structs.some((s) => s instanceof Y.Item && (s.parentSub === PLACES_KEY || (s.content instanceof Y.ContentAny && s.content.arr.some((v) => listsOf(v).length > 0))));
  if (!holdsPlaces && !suspect) return null;

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
  /** The places the layout held before, as text, read only when a bad one turns up. */
  let before: Set<string> | null = null;
  const heldBefore = (v: unknown): boolean => {
    if (!before) {
      before = new Set();
      const cache = doc ? readSidecarCache(doc) : null;
      before.add(JSON.stringify(cache?.layoutPlaces));
      for (const m of Array.isArray(cache?.modules) ? (cache.modules as Record<string, unknown>[]) : []) before.add(JSON.stringify(m?.places));
    }
    return before.has(JSON.stringify(v));
  };
  const badList = (v: unknown): boolean => v !== undefined && !validPlaces(v) && !heldBefore(v);

  const added = new Set<string>();
  for (const s of structs) {
    if (!(s instanceof Y.Item)) continue;
    const c = s.content;
    if (c instanceof Y.ContentDeleted) continue;
    // A sidecar value, wherever it is going (one of two edits arriving out
    // of order can't be placed yet): nothing else has these fields.
    if (c instanceof Y.ContentAny && c.arr.some((v) => listsOf(v).some(badList)) && !deleted(s)) return 'it gives a module places outside their limits';
    const path = pathOf(s);
    if (!path) continue;
    const [root, key, id, field] = path;
    if (root === 'meta' && key === PLACES_KEY) {
      if (deleted(s)) continue;
      if (path.length === 2) {
        if (!(c instanceof Y.ContentType) || !(c.type instanceof Y.Map)) return 'it makes the layout’s places something other than a map';
        continue;
      }
      if (path.length === 3) {
        if (!(c instanceof Y.ContentType) || !(c.type instanceof Y.Map) || id!.length > PLACE_LIMITS.id) return 'it writes a place that isn’t one';
        added.add(id!);
        continue;
      }
      if (path.length > 4 || !(c instanceof Y.ContentAny) || c.arr.length !== 1 || !validPlaceField(field!, c.arr[0])) return 'it gives a place a value outside its limits';
      continue;
    }
  }
  if (added.size > 0) {
    const meta = doc?.share.get('meta') as unknown as { _map?: Map<string, Y.Item> } | undefined;
    const item = meta?._map?.get(PLACES_KEY);
    const now = item && !item.deleted && item.content instanceof Y.ContentType && item.content.type instanceof Y.Map ? (item.content.type as Y.Map<unknown>) : null;
    let total = added.size;
    if (now) for (const k of now.keys()) if (!added.has(k)) total++;
    if (total > MAX_LAYOUT_PLACES) return `it would leave the layout with more than ${MAX_LAYOUT_PLACES} places`;
  }
  return null;
}

/** The lists of places a plain value holds: a module's own value (`places`), or a whole sidecar's (its modules', `layoutPlaces`). */
function listsOf(v: unknown): unknown[] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
  const o = v as Record<string, unknown>;
  const out: unknown[] = [];
  if (Array.isArray(o.members) && o.places !== undefined) out.push(o.places);
  if (o.layoutPlaces !== undefined) out.push(o.layoutPlaces);
  for (const m of Array.isArray(o.modules) ? (o.modules as unknown[]) : []) {
    if (m && typeof m === 'object' && (m as { places?: unknown }).places !== undefined) out.push((m as { places: unknown }).places);
  }
  return out;
}

/** placesProblem for a whole document on its own (a snapshot). Unreadable: the update guard refuses it. */
export function snapshotPlacesProblem(bytes: Uint8Array): string | null {
  const decoded = decodeIncoming(bytes);
  return decoded ? placesProblem(null, decoded) : null;
}
