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
// Cars and trains (carsGuard.ts) are checked along with them, on the same copy.
//
// A value the update itself deletes is never read, and is let through.
// Only the update's structs are read, and an update that writes nothing of
// the kind costs one pass over them. What can't be told from them alone
// (changes the room holds back that may land with it, two structs for one
// id) is worked out on a copy of the layout, against the sender's copy
// budget (ws/pacing.ts), like the grid guard, and only when places may be
// in it.

import * as Y from 'yjs';
import { PLACE_LIMITS, placeSize, validPlace, validPlaces } from '@cld/bbm';
import { PLACES_KEY, readSidecarCache } from '@cld/ydoc';
import { CARS_KEYS, carsProblem, docCarsProblems } from './carsGuard.js';
import { decodeIncoming, guardWork, type DecodedUpdate } from './decoded.js';
import { pathsOf } from './mapPaths.js';
import { pendingMayLand } from './pending.js';

/** More than the apps make (two people may each add the last ones at once). */
export const MAX_LAYOUT_PLACES = 2 * PLACE_LIMITS.places;

/** One place as a layout's document may hold it: two people may each add to it at once. */
export const MAX_LIVE_PLACE_SIZE = 2 * PLACE_LIMITS.size;

/** placesProblem's answer when the update needs a copy and `mayCopy` says no: slow the sender down. */
export const PLACES_COPY_BUDGET_SPENT = 'it needs a copy of the layout to check its places, and its sender has used up their copies for now';

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
 * document on its own. `update` is its bytes, and `mayCopy`, when given,
 * is asked before working it out on a copy of the room's document; no
 * gives PLACES_COPY_BUDGET_SPENT.
 */
export function placesProblem(doc: Y.Doc | null, decoded: DecodedUpdate, update: Uint8Array, mayCopy?: () => boolean): string | null {
  if ((decoded.overlapping || pendingMayLand(doc, decoded)) && mayHoldPlaces(doc, update)) {
    if (mayCopy && !mayCopy()) return PLACES_COPY_BUDGET_SPENT;
    return placesProblemOnCopy(doc, update);
  }
  const { structs } = decoded;
  const badCars = carsProblem(doc, decoded);
  if (badCars !== null) return badCars;
  // Cheap first: does the update say anything a place could be in?
  const holdsPlaces = !!(doc?.share.get('meta') as unknown as { _map?: Map<string, Y.Item> } | undefined)?._map?.has(PLACES_KEY);
  const suspect = structs.some((s) => s instanceof Y.Item && (s.parentSub === PLACES_KEY || (s.content instanceof Y.ContentAny && s.content.arr.some((v) => listsOf(v).length > 0))));
  if (!holdsPlaces && !suspect) return null;

  const { pathOf, deleted } = pathsOf(doc, decoded);
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
  /** How much each place's fields take, as written here. */
  const sizes = new Map<string, number>();
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
      sizes.set(id!, (sizes.get(id!) ?? 0) + field!.length + 3 + placeSize(c.arr[0]));
      continue;
    }
  }
  const now = livePlaces(doc);
  for (const [id, size] of sizes) {
    const had = now?.get(id);
    if (size + (had instanceof Y.Map ? placeSize(had.toJSON()) : 0) > MAX_LIVE_PLACE_SIZE) return 'it makes a place too big';
  }
  if (added.size > 0) {
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

/** The layout's own places in a document as it is, or null when it has no map of them. */
function livePlaces(doc: Y.Doc | null): Y.Map<unknown> | null {
  const meta = doc?.share.get('meta') as unknown as { _map?: Map<string, Y.Item> } | undefined;
  const item = meta?._map?.get(PLACES_KEY);
  return item && !item.deleted && item.content instanceof Y.ContentType && item.content.type instanceof Y.Map ? (item.content.type as Y.Map<unknown>) : null;
}

const PLACES_TEXT = [PLACES_KEY, 'layoutPlaces', ...CARS_KEYS];
const names = (bytes: Uint8Array | null | undefined): boolean => {
  if (!bytes) return false;
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return PLACES_TEXT.some((t) => b.includes(t));
};

/** Whether the room, what it holds back or the update has places, cars or trains at all (their names are in the bytes). False: certainly not. */
function mayHoldPlaces(doc: Y.Doc | null, update: Uint8Array): boolean {
  if (livePlaces(doc) || names(update) || names(doc?.store.pendingStructs?.update)) return true;
  const meta = doc?.share.get('meta') as unknown as { _map?: Map<string, Y.Item> } | undefined;
  return [PLACES_KEY, ...CARS_KEYS].some((k) => !!meta?._map?.has(k));
}

/** Everything about places outside the limits in a document as it is, each as a text of its own. */
export function docPlacesProblems(doc: Y.Doc): Set<string> {
  const out = new Set<string>();
  const meta = doc.getMap('meta');
  const live = meta.get(PLACES_KEY);
  if (live !== undefined) {
    if (!(live instanceof Y.Map)) out.add('it makes the layout’s places something other than a map');
    else {
      if (live.size > MAX_LAYOUT_PLACES) out.add(`it would leave the layout with more than ${MAX_LAYOUT_PLACES} places`);
      for (const [id, v] of live.entries()) {
        if (!(v instanceof Y.Map) || id.length > PLACE_LIMITS.id) {
          out.add(`it writes a place that isn’t one (${id.slice(0, PLACE_LIMITS.id)})`);
          continue;
        }
        for (const [field, value] of v.entries()) if (!validPlaceField(field, value)) out.add(`it gives a place a value outside its limits (${id}.${field.slice(0, PLACE_LIMITS.kind)})`);
        if (placeSize(v.toJSON()) > MAX_LIVE_PLACE_SIZE) out.add(`it makes a place too big (${id})`);
      }
    }
  }
  const values = [meta.get('cache'), ...doc.getMap('sidecarItems').values()];
  for (const v of values) {
    if (v instanceof Y.AbstractType) continue;
    for (const list of listsOf(v)) if (!validPlaces(list)) out.add(`it gives a module places outside their limits ${JSON.stringify(list)}`);
  }
  return out;
}

/** placesProblem worked out on a copy of the room's document (exact for any update; costs the layout's size). */
export function placesProblemOnCopy(doc: Y.Doc | null, update: Uint8Array): string | null {
  guardWork.docCopies += 1;
  const after = new Y.Doc();
  try {
    const before = doc ? new Set([...docPlacesProblems(doc), ...docCarsProblems(doc)]) : new Set<string>();
    if (doc) {
      const state = Y.encodeStateAsUpdate(doc);
      guardWork.copyBytes += state.length;
      Y.applyUpdate(after, state);
    }
    try {
      Y.applyUpdate(after, update);
    } catch {
      // Yjs throws part-way through some hand-made updates and keeps what
      // it applied before (the room would too): that is what is checked.
    }
    let now: Set<string>;
    try {
      now = new Set([...docPlacesProblems(after), ...docCarsProblems(after)]);
    } catch {
      return 'it makes the layout’s places or cars unreadable';
    }
    for (const p of now) if (!before.has(p)) return p.slice(0, 160);
    return null;
  } catch {
    return null; // the room's own document can't be copied: nothing to compare
  } finally {
    after.destroy();
  }
}

/** placesProblem for a whole document on its own (a snapshot). Unreadable: the update guard refuses it. */
export function snapshotPlacesProblem(bytes: Uint8Array): string | null {
  const decoded = decodeIncoming(bytes);
  return decoded ? placesProblem(null, decoded, bytes) : null;
}
