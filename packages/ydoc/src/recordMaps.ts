// The maps a layout keeps its records in (places, routes, rolling stock,
// trains, switch settings, waybills, jobs), made once, when its room opens.
//
// Each is a Y.Map at its own key of `meta`, and an app makes it with the
// first record. Two people adding the first one at the same moment each
// made the map, and Yjs keeps one value per key: the other's record was
// lost. A room that has the (empty) maps before anyone joins leaves
// nothing to make, for any build of either app, and Undo of a first
// record takes back that record only.
//
// The map is always the same struct (a fixed client, clock 0), so making it
// twice, on two copies of a layout or again after a restart, makes one. The
// client is lower than any app's, so a map someone made before the room had
// one still wins over the empty one.
//
// Not the budget: an empty one means something (a budget with no rows).

import * as Y from 'yjs';

/** The maps, and the client each is written by (never change or reuse one). */
export const RECORD_MAPS: ReadonlyArray<readonly [key: string, client: number]> = [
  ['places', 1],
  ['routes', 2],
  ['rollingStock', 3],
  ['trains', 4],
  ['switchStates', 5],
  ['waybills', 6],
  ['opsJobs', 7],
];

/** An older web build that imported a file kept them in `meta.cache`: the first write moves those over, as before. */
function inCache(cache: unknown, key: string): boolean {
  if (cache === null || typeof cache !== 'object') return false;
  const c = cache as Record<string, unknown>;
  if (key !== 'places' && key !== 'waybills' && key !== 'opsJobs') return c[key] !== undefined;
  const name = key === 'places' ? 'layoutPlaces' : key;
  const extras = c.extras as Record<string, unknown> | null | undefined;
  return c[name] !== undefined || (!!extras && typeof extras === 'object' && extras[name] !== undefined);
}

/** Make the maps a seeded doc doesn't have. Makes no change when it has them. Returns true when it changed anything. */
export function ensureRecordMaps(doc: Y.Doc, origin?: unknown): boolean {
  const meta = doc.getMap('meta');
  if (meta.get('version') === undefined) return false;
  const cache = meta.get('cache');
  const had = new Map(Y.decodeStateVector(Y.encodeStateVector(doc)));
  const updates: Uint8Array[] = [];
  for (const [key, client] of RECORD_MAPS) {
    // (A key that was there and is gone stays gone: the fixed map would lose to it.)
    if ((meta as unknown as { _map: Map<string, unknown> })._map.has(key) || had.has(client) || inCache(cache, key)) continue;
    const one = new Y.Doc();
    one.clientID = client;
    one.getMap('meta').set(key, new Y.Map());
    updates.push(Y.encodeStateAsUpdate(one));
    one.destroy();
  }
  if (updates.length === 0) return false;
  Y.applyUpdate(doc, Y.mergeUpdates(updates), origin);
  return true;
}
