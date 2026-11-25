// A shared module's places are its owner's (docs/shared-modules.md): when a
// shared module comes into a layout (placed, or removed and put back), its
// places are made what the version it follows has, on the parts it has
// here (its newest version's, when that one isn't kept). Only while it is
// still shared with the layout's owner; a module made the layout's own keeps its places.

import { desc, eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { modulePlaces, renamePlaceBricks, updatedPlaces, withPlaces, type Place } from '@cld/bbm';
import { batchPlaces, norm360, pivotOf, placeVersion, resolvePlacement, sharedModulesIn, type ModuleBatch, type PartLookup, type SharedPlaced } from '@cld/modules';
import { makeId, readSidecarCache, writeSidecarCache } from '@cld/ydoc';
import { db, schema } from '../db/index.js';
import { docHub } from '../ws/docHub.js';
import { sharedPartLookup, warmSharedGeometry } from '../ws/sharedGeometry.js';
import { SERVER_ORIGIN, batchesOrNull, versionBytes } from './apply.js';
import { stateFor } from './placed.js';

const SAME_PLACE = 0.1;
const SAME_TURN = 0.5;

/** The version's places on the parts placed copy `p` has in `doc`, or null when its parts can't be read. */
export function placesHere(doc: Y.Doc, p: SharedPlaced, batches: readonly ModuleBatch[], partOf: PartLookup): Place[] | null {
  const places = batchPlaces(batches);
  if (places.length === 0) return [];
  const members = new Set(p.members);
  const here: { id: string; partNumber: string; displayArea: { x: number; y: number; width: number; height: number }; orientation: number }[] = [];
  for (const layer of doc.getMap<unknown>('layerData').values()) {
    const bricks = layer instanceof Y.Map ? layer.get('bricks') : undefined;
    if (!(bricks instanceof Y.Array)) continue;
    for (const b of bricks) {
      const id = b instanceof Y.Map ? (b.get('id') as unknown) : undefined;
      if (typeof id !== 'string' || !members.has(id)) continue;
      const a = (b as Y.Map<unknown>).get('displayArea') as { x: number; y: number; width: number; height: number } | undefined;
      const o = (b as Y.Map<unknown>).get('orientation') ?? 0;
      if (!a || ![a.x, a.y, a.width, a.height, o].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
      here.push({ id, partNumber: String((b as Y.Map<unknown>).get('partNumber') ?? ''), displayArea: { x: a.x, y: a.y, width: a.width, height: a.height }, orientation: o as number });
    }
  }
  if (here.length === 0) return null;
  const placement = resolvePlacement(batches, here, p.placement, partOf);
  const source = batches.flatMap((b) => b.bricks);
  const placed = placeVersion(batches, placement, partOf).flatMap((b) => b.bricks);
  const centers = here.map((h) => pivotOf({ displayArea: h.displayArea, orientation: h.orientation }, partOf(h.partNumber)));
  const to = new Map<string, string>();
  const used = new Set<number>();
  placed.forEach((w, i) => {
    const id = source[i]?.id;
    if (id === undefined) return;
    const at = pivotOf({ displayArea: w.displayArea, orientation: w.orientation ?? 0 }, partOf(w.partNumber));
    const k = here.findIndex((h, j) => {
      const turn = Math.abs(norm360(h.orientation) - norm360(w.orientation ?? 0));
      return !used.has(j) && h.partNumber.toLowerCase() === w.partNumber.toLowerCase() && Math.hypot(centers[j]!.x - at.x, centers[j]!.y - at.y) < SAME_PLACE && Math.min(turn, 360 - turn) < SAME_TURN;
    });
    if (k < 0) return;
    used.add(k);
    to.set(id, here[k]!.id);
  });
  return renamePlaceBricks(places, (id) => to.get(id) ?? null);
}

/** The module's newest kept version, for a copy at one that isn't kept (or known). */
async function newestBytes(moduleId: string): Promise<Uint8Array | null> {
  const v = schema.moduleVersions;
  const row = await db.select({ docSnapshot: v.docSnapshot }).from(v).where(eq(v.moduleId, moduleId)).orderBy(desc(v.version)).limit(1).get();
  return row ? (row.docSnapshot as Uint8Array) : null;
}

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

/** Make the places of placed copies `ids` of the layout's shared modules their owners'. True when any changed. */
export async function ownersPlaces(layoutId: string, ids: ReadonlySet<string>): Promise<boolean> {
  const layout = await db.select({ ownerUserId: schema.layouts.ownerUserId, ownerOrgId: schema.layouts.ownerOrgId }).from(schema.layouts).where(eq(schema.layouts.id, layoutId)).get();
  if (!layout) return false;
  const session = await docHub.getOrCreate(layoutId);
  const { doc } = session;
  const asked = sharedModulesIn(readSidecarCache(doc)).filter((p) => ids.has(p.placedId));
  const versions = new Map<string, ModuleBatch[]>();
  const key = (p: SharedPlaced) => `${p.moduleId}|${p.version}`;
  for (const p of asked) {
    if (versions.has(key(p)) || (await stateFor(layout, p.moduleId)) !== 'shared') continue;
    const batches = (p.version !== null ? batchesOrNull(await versionBytes(p.moduleId, p.version)) : null) ?? batchesOrNull(await newestBytes(p.moduleId));
    if (batches) versions.set(key(p), batches);
  }
  if (versions.size > 0) await warmSharedGeometry(layoutId, doc);
  const partOf = sharedPartLookup(layoutId) ?? (() => undefined);
  // (Nothing is awaited from here: what is read is what is written over.)
  const cache = readSidecarCache(doc) ?? {};
  const list = Array.isArray(cache.modules) ? (cache.modules as { id: string }[]) : [];
  const now = new Map(sharedModulesIn(cache).map((p) => [p.placedId, p]));
  let changed = false;
  const modules = session.closed
    ? list
    : list.map((m) => {
        const p = ids.has(m.id) ? now.get(m.id) : undefined;
        const batches = p && versions.get(key(p));
        const want = batches ? placesHere(doc, p, batches, partOf) : null;
        if (!want) return m;
        const own = modulePlaces(m);
        const next = updatedPlaces(own, want, makeId);
        if (stable(own) === stable(next) && (own.length > 0 || !('places' in m))) return m;
        changed = true;
        return withPlaces(m, next);
      });
  if (changed) {
    doc.transact(() => writeSidecarCache(doc, { ...cache, modules }), SERVER_ORIGIN);
    await session.flushBatch();
  }
  await docHub.settle(session);
  return changed;
}
