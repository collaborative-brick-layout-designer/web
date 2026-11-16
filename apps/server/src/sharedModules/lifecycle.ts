// What follows when a module's sharing, or the module itself, changes
// (docs/shared-modules.md, "When something changes"): the custom parts
// that come along with its shares are worked out again, and so is whether
// each placed copy still follows it. Placed copies always stay in their
// layouts; only their state changes ("No longer shared", "Deleted by its
// owner"), and with the owner's account erased, the lock comes off.

import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { syncModuleShareParts } from '../access/moduleShares.js';
import { fallbackName } from '../utils/publicName.js';
import { onAccessChanged } from '../ws/liveAccess.js';
import { detachModule } from './apply.js';
import { refreshStatesForLayout, refreshStatesForModule } from './placed.js';

/** A module was saved, shared, unshared, handed over, deleted or restored. */
export async function moduleSharesChanged(moduleId: string): Promise<void> {
  await syncModuleShareParts(moduleId);
  await refreshStatesForModule(moduleId);
}

/** The placed copies of every module `userId` owns alone, in other people's and clubs' layouts. */
export async function placedCopiesOfModulesOf(userId: string): Promise<{ layoutId: string; placedId: string }[]> {
  return db
    .select({ layoutId: schema.layoutSharedModules.layoutId, placedId: schema.layoutSharedModules.placedId })
    .from(schema.layoutSharedModules)
    .innerJoin(schema.modules, eq(schema.modules.id, schema.layoutSharedModules.moduleId))
    .where(eq(schema.modules.ownerUserId, userId))
    .all();
}

/**
 * The account of a module's owner was erased: nobody is left whose design
 * the lock protects, so each placed copy becomes an ordinary module,
 * credited "Builder #…" like the other things the account left behind.
 * Call after the account is gone, with the copies read before
 * (`placedCopiesOfModulesOf`). Layouts that went with the account are
 * skipped. Returns how many were unlocked.
 */
export async function unlockPlacedCopies(copies: readonly { layoutId: string; placedId: string }[], erasedUserId: string): Promise<number> {
  let n = 0;
  for (const c of copies) {
    try {
      const layout = await db.select({ id: schema.layouts.id }).from(schema.layouts).where(eq(schema.layouts.id, c.layoutId)).get();
      if (!layout) continue;
      const r = await detachModule(c.layoutId, c.placedId, { by: fallbackName(erasedUserId), forget: true });
      if (r.ok && r.changed) n += 1;
    } catch (err) {
      console.error(`[sharedModules] couldn't unlock ${c.placedId} in layout ${c.layoutId}`, err);
    }
  }
  return n;
}

let listening = false;

/** A layout that changes owner: which of its shared modules still follow theirs is worked out again. Call once. */
export function followLayoutOwners(): void {
  if (listening) return;
  listening = true;
  onAccessChanged((c) => {
    if (!('layoutId' in c)) return;
    void refreshStatesForLayout(c.layoutId).catch((err: unknown) => console.error(`[sharedModules] couldn't refresh layout ${c.layoutId}`, err));
  });
}
