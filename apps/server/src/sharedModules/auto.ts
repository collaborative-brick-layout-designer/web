// "Updates from shared modules: Automatically" (docs/shared-modules.md,
// phase 2). A layout set to `auto` gets each new version of the shared
// modules it places as soon as their owner saves it: in a room that is
// open (everyone in it sees the change, with the usual "is now version N"
// notice) and in one nobody has open (the server opens the stored
// document, applies, and stores it again).
//
// Each update is the same idempotent step as Update (apply.ts), so a save
// arriving while someone presses Update puts the version in once. Overlaps
// never stop it; the apps mark them afterwards. Each update is written to
// the layout's audit log, which "Updated while you were away" reads
// (visits.ts), and the layout's people get a `shared-module-updated` hint.

import { and, eq, lt } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { ownerOfResource, publish } from '../events/audience.js';
import { partGeometry } from '../routes/parts.js';
import { applyVersion } from './apply.js';
import { stateFor } from './placed.js';
import { AUTO_UPDATE_EVENT, type AutoUpdatePayload } from './visits.js';

interface Logger {
  log: { warn: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void };
}

/** One after another: two saves in a row can't race each other into a room. */
let queue: Promise<void> = Promise.resolve();

/**
 * Module `moduleId` has a new version: put it in every `auto` layout that
 * places it and still follows it. Runs after the request that saved it
 * (never slows the save or fails it).
 */
export function updateAutomatically(app: Logger, moduleId: string): void {
  queue = queue
    .then(() => run(app, moduleId))
    .catch((err: unknown) => {
      console.error("[sharedModules] couldn't put a module's new version in its layouts: %s", moduleId, err);
    });
}

/**
 * Layout `layoutId` was just set to `auto`: the new versions it was
 * waiting on go in now, as they would have when their owners saved them.
 */
export function catchUpAutomatically(app: Logger, layoutId: string): void {
  queue = queue
    .then(async () => {
      const ids = await db
        .selectDistinct({ moduleId: schema.layoutSharedModules.moduleId })
        .from(schema.layoutSharedModules)
        .where(and(eq(schema.layoutSharedModules.layoutId, layoutId), eq(schema.layoutSharedModules.state, 'shared')))
        .all();
      for (const { moduleId } of ids) await run(app, moduleId, layoutId);
    })
    .catch((err: unknown) => {
      console.error("[sharedModules] couldn't bring a layout's shared modules up to date: %s", layoutId, err);
    });
}

/** Resolves once every automatic update asked for so far is done (tests, shutdown). */
export function automaticUpdatesSettled(): Promise<void> {
  return queue;
}

async function run(app: Logger, moduleId: string, onlyLayout?: string): Promise<void> {
  const lib = await db
    .select({ latestVersion: schema.modules.latestVersion, ownerUserId: schema.modules.ownerUserId, ownerOrgId: schema.modules.ownerOrgId })
    .from(schema.modules)
    .where(eq(schema.modules.id, moduleId))
    .get();
  if (!lib || lib.latestVersion < 1) return;
  const rows = await db
    .select({
      layoutId: schema.layoutSharedModules.layoutId,
      placedId: schema.layoutSharedModules.placedId,
      ownerUserId: schema.layouts.ownerUserId,
      ownerOrgId: schema.layouts.ownerOrgId,
    })
    .from(schema.layoutSharedModules)
    .innerJoin(schema.layouts, eq(schema.layouts.id, schema.layoutSharedModules.layoutId))
    .where(
      and(
        eq(schema.layoutSharedModules.moduleId, moduleId),
        eq(schema.layoutSharedModules.state, 'shared'),
        eq(schema.layouts.sharedModuleUpdates, 'auto'),
        lt(schema.layoutSharedModules.version, lib.latestVersion),
        ...(onlyLayout ? [eq(schema.layoutSharedModules.layoutId, onlyLayout)] : []),
      ),
    )
    .all();
  const byLayout = new Map<string, typeof rows>();
  for (const r of rows) byLayout.set(r.layoutId, [...(byLayout.get(r.layoutId) ?? []), r]);
  for (const [layoutId, placed] of byLayout) {
    const owner = { ownerUserId: placed[0]!.ownerUserId, ownerOrgId: placed[0]!.ownerOrgId };
    // Still shared with this layout's owner (the table is kept up to date, but a share may have stopped a moment ago).
    if ((await stateFor(owner, moduleId)) !== 'shared') continue;
    let changed = 0;
    try {
      const partOf = await partGeometry(app, { userIds: [lib.ownerUserId, owner.ownerUserId], orgIds: [lib.ownerOrgId, owner.ownerOrgId] });
      for (const p of placed) {
        const r = await applyVersion(layoutId, p.placedId, moduleId, lib.latestVersion, partOf);
        if (!r.ok || !r.changed) continue;
        changed += 1;
        const payload: AutoUpdatePayload = { sharedModule: moduleId, placedId: p.placedId, from: r.from, version: r.version, parts: r.parts };
        await writeAuditEvent({ layoutId, userId: null, eventType: AUTO_UPDATE_EVENT, payload: { ...payload } });
      }
    } catch (err) {
      app.log.error({ err, layoutId, moduleId }, "couldn't update a shared module automatically");
    }
    if (changed > 0) {
      const now = await ownerOfResource('layout', layoutId);
      await publish({ kind: 'layout', ...(now?.owner ? { owner: now.owner } : {}), id: layoutId, action: 'shared-module-updated' });
    }
  }
}
