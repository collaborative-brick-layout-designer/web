// Putting a layout in shape when it opens: shared modules, and their parts,
// that hold values no app writes (@cld/ydoc repairSidecarShape, ws/sharedGuard.ts
// healSharedParts). Nothing is changed unless the layout as it is could be
// kept in its history first, whatever its settings; it is logged and
// audited by ids and counts. The dry run (ops/sharedRepairDryRun.ts) asks
// planHeal too, so it counts what opening would do.

import * as Y from 'yjs';
import { eq } from 'drizzle-orm';
import { sharedModulesIn } from '@cld/modules';
import { readSidecarCache, repairSidecarShape, sidecarShapeProblems } from '@cld/ydoc';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { db, schema } from '../db/index.js';
import { healSharedParts, needsHeal, sharedPartProblems } from '../ws/sharedGuard.js';
import { examinePlaces, writePlaces } from './ownerPlaces.js';
import { keepFirst } from './repair.js';

export interface HealCounts {
  /** Sidecar values that aren't plain ones; second entries with a shared module's id. */
  nested: number;
  second: number;
  /** Shared parts' fields that aren't plain values; entries that aren't parts; sheets that aren't sheets. */
  fields: number;
  entries: number;
  sheets: number;
  /** Shared modules whose places are made their owners' (looked at only when the sidecar was out of shape). */
  places: number;
}

const ORIGIN = 'cld-heal';

/** What opening the layout would change, and the step that does it; null: nothing. */
export async function planHeal(
  layoutId: string,
  owner: { ownerUserId: string | null; ownerOrgId: string | null },
  doc: Y.Doc,
): Promise<{ counts: HealCounts; apply: (doc: Y.Doc) => void } | null> {
  if (!needsHeal(doc)) return null;
  // Worked out on a copy: what is under a value that can't be read shows once it is put right.
  const work = new Y.Doc();
  try {
    Y.applyUpdate(work, Y.encodeStateAsUpdate(doc));
    const shape = sidecarShapeProblems(work);
    const sidecar = repairSidecarShape(work, ORIGIN);
    const parts = sharedPartProblems(work);
    healSharedParts(work, ORIGIN);
    const ids = new Set(sidecar ? sharedModulesIn(readSidecarCache(work)).map((p) => p.placedId) : []);
    const places = ids.size > 0 ? (await examinePlaces(layoutId, owner, work, ids))() : new Map<string, never[]>();
    return {
      counts: { ...shape, ...parts, places: places.size },
      apply: (d) =>
        d.transact(() => {
          repairSidecarShape(d, ORIGIN);
          healSharedParts(d, ORIGIN);
          writePlaces(d, places, ORIGIN);
        }, ORIGIN),
    };
  } finally {
    work.destroy();
  }
}

/** Before anyone joins a layout that opens: put it in shape. Never keeps it from opening. Returns the step to run once the room stores its changes, or null. */
export async function healOnOpen(layoutId: string, doc: Y.Doc): Promise<(() => void) | null> {
  try {
    if (!needsHeal(doc)) return null;
    const layout = await db.select({ ownerUserId: schema.layouts.ownerUserId, ownerOrgId: schema.layouts.ownerOrgId }).from(schema.layouts).where(eq(schema.layouts.id, layoutId)).get();
    const plan = layout ? await planHeal(layoutId, layout, doc) : null;
    if (!plan) return null;
    const kept = await keepFirst(layoutId, Y.encodeStateAsUpdate(doc));
    if (kept === null) {
      console.warn("[sharedModules] layout %s isn't put in shape: it couldn't be kept first", layoutId);
      return null;
    }
    return () => {
      try {
        plan.apply(doc);
      } catch (err) {
        console.error("[sharedModules] couldn't put layout %s in shape:", layoutId, err);
        return;
      }
      console.log('[sharedModules] put layout %s in shape on opening: %s; the layout before is version %s', layoutId, JSON.stringify(plan.counts), kept.id);
      writeAuditEvent({ layoutId, userId: null, eventType: 'shared_module_repair', payload: { ...plan.counts, safety: kept.id } }).catch((err: unknown) => console.error('[sharedModules] could not write the audit event', err));
    };
  } catch (err) {
    console.error("[sharedModules] couldn't put layout %s in shape on opening:", layoutId, err);
    return null;
  }
}
