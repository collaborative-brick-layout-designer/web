// The parts' geometry the shared-module guard measures moves with
// (ws/sharedGuard.ts rigidMoveProblem), per layout.
//
// The guard runs on every update and can't wait for the database, so the
// geometry is read ahead: when a room with shared modules opens, and again
// when the server stores one (a module may have been placed since), then
// kept for a while. Until it is in, the guard measures by the parts' boxes
// and lets a turned part with no known geometry off by its size: never a
// wrong refusal, only a looser check for a moment.

import { eq, inArray } from 'drizzle-orm';
import type * as Y from 'yjs';
import type { PartLookup } from '@cld/modules';
import { db, schema } from '../db/index.js';
import { partGeometry } from '../routes/parts.js';
import { sharedInDoc } from '../sharedModules/placed.js';

/** How long a layout's geometry is kept before it is read again (custom parts may have been added). */
const KEEP_MS = 10 * 60_000;
/** At most this many layouts' geometry is kept. */
const MAX_LAYOUTS = 500;

const logger = {
  log: {
    warn: (obj: object, msg?: string) => console.warn('[shared geometry]', msg ?? '', obj),
    error: (obj: object, msg?: string) => console.error('[shared geometry]', msg ?? '', obj),
  },
};

interface Entry {
  lookup: PartLookup | null;
  at: number;
  loading: Promise<void> | null;
}

const cache = new Map<string, Entry>();

/** The layout's parts' geometry, when it has been read; undefined until then. */
export function sharedPartLookup(layoutId: string): PartLookup | undefined {
  return cache.get(layoutId)?.lookup ?? undefined;
}

/** Forget every layout's geometry (tests). */
export function forgetSharedGeometry(): void {
  cache.clear();
}

/** Keep `lookup` as the layout's geometry (a step that already read it, such as an update put in). */
export function rememberSharedGeometry(layoutId: string, lookup: PartLookup, now = Date.now()): void {
  trim();
  cache.set(layoutId, { lookup, at: now, loading: null });
}

function trim(): void {
  if (cache.size < MAX_LAYOUTS) return;
  const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, Math.ceil(MAX_LAYOUTS / 5));
  for (const [id] of oldest) cache.delete(id);
}

/**
 * Read the layout's geometry ahead, when its document places shared
 * modules and what is kept is missing or old. Returns when it is in (or
 * couldn't be read: the guard then goes on measuring by boxes).
 */
export async function warmSharedGeometry(layoutId: string, doc: Y.Doc, now = Date.now()): Promise<void> {
  const placed = sharedInDoc(doc);
  if (placed.length === 0) return;
  const had = cache.get(layoutId);
  if (had?.loading) return had.loading;
  if (had?.lookup && now - had.at < KEEP_MS) return;
  const entry: Entry = { lookup: had?.lookup ?? null, at: had?.at ?? 0, loading: null };
  entry.loading = (async () => {
    try {
      const layout = await db
        .select({ ownerUserId: schema.layouts.ownerUserId, ownerOrgId: schema.layouts.ownerOrgId })
        .from(schema.layouts)
        .where(eq(schema.layouts.id, layoutId))
        .get();
      if (!layout) return;
      const ids = [...new Set(placed.map((p) => p.moduleId))];
      const owners = await db
        .select({ ownerUserId: schema.modules.ownerUserId, ownerOrgId: schema.modules.ownerOrgId })
        .from(schema.modules)
        .where(inArray(schema.modules.id, ids));
      const lookup = await partGeometry(logger, {
        userIds: [layout.ownerUserId, ...owners.map((o) => o.ownerUserId)],
        orgIds: [layout.ownerOrgId, ...owners.map((o) => o.ownerOrgId)],
      });
      entry.lookup = lookup;
      entry.at = Date.now();
    } catch (err) {
      console.error(`[shared geometry] could not read the parts of layout ${layoutId}: ${String(err)}`);
    } finally {
      entry.loading = null;
    }
  })();
  trim();
  cache.set(layoutId, entry);
  return entry.loading;
}
