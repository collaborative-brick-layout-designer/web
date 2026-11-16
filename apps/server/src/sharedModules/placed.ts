// Where shared (read-only) modules are placed (docs/shared-modules.md):
// the layout_shared_modules table, kept from the layouts' documents.
//
// A layout's document says which of its modules are shared (`shared` in
// the module's sidecar value, @cld/modules shared.ts), which library module
// each follows, and at which version. The table repeats that per layout so
// the server can answer, without opening documents: which layouts place a
// module (its owner's "Used in", who hears about a new version), and
// whether each placed copy still gets updates:
//
//   shared    the module is still shared with the layout's owner
//   unshared  it exists, but isn't shared with the layout's owner (any more)
//   gone      it was deleted (restoring it from Recently deleted brings it back)
//
// The rows are worked out again whenever the server stores the layout, and
// their state whenever a share, a module or a layout's owner changes. They
// can always be rebuilt from the documents.

import { and, eq, inArray } from 'drizzle-orm';
import type * as Y from 'yjs';
import { decodeDoc, readSidecarCache } from '@cld/ydoc';
import { sharedModulesIn, type SharedPlaced } from '@cld/modules';
import { db, schema } from '../db/index.js';

export type SharedState = 'shared' | 'unshared' | 'gone';

interface Owner {
  ownerUserId: string | null;
  ownerOrgId: string | null;
}

/** The shared placed modules of a layout's document. */
export function sharedInDoc(doc: Y.Doc): SharedPlaced[] {
  return sharedModulesIn(readSidecarCache(doc));
}

/**
 * Whether a placed copy of `moduleId` in a layout of `owner` still follows
 * its module: the module is the layout owner's own (a person's, or the same
 * club's), or it is shared with that owner (in person, for a person's
 * layout; with the club, for a club's). Shared with a member only doesn't
 * count for the club's layouts, and shared with a club doesn't count for
 * its members' own layouts: the module's owner decides where it goes.
 */
export async function stateFor(owner: Owner, moduleId: string): Promise<SharedState> {
  const mod = await db
    .select({ ownerUserId: schema.modules.ownerUserId, ownerOrgId: schema.modules.ownerOrgId })
    .from(schema.modules)
    .where(eq(schema.modules.id, moduleId))
    .get();
  if (!mod) return 'gone';
  if (owner.ownerOrgId) {
    if (mod.ownerOrgId === owner.ownerOrgId) return 'shared';
    const share = await db
      .select({ orgId: schema.moduleClubShares.orgId })
      .from(schema.moduleClubShares)
      .where(and(eq(schema.moduleClubShares.moduleId, moduleId), eq(schema.moduleClubShares.orgId, owner.ownerOrgId)))
      .get();
    return share ? 'shared' : 'unshared';
  }
  if (!owner.ownerUserId) return 'unshared';
  if (mod.ownerUserId === owner.ownerUserId) return 'shared';
  const share = await db
    .select({ userId: schema.moduleCollaborators.userId })
    .from(schema.moduleCollaborators)
    .where(and(eq(schema.moduleCollaborators.moduleId, moduleId), eq(schema.moduleCollaborators.userId, owner.ownerUserId)))
    .get();
  return share ? 'shared' : 'unshared';
}

/** Layouts known to place no shared module, so storing them costs no query (a restart forgets, and asks once). */
const knownEmpty = new Set<string>();

/**
 * Make the layout's rows match its document. Cheap for a layout without
 * shared modules: nothing is read or written once that is known.
 */
export async function syncLayoutSharedModules(layoutId: string, doc: Y.Doc): Promise<void> {
  const placed = sharedInDoc(doc);
  if (placed.length === 0 && knownEmpty.has(layoutId)) return;
  const layout = await db
    .select({ ownerUserId: schema.layouts.ownerUserId, ownerOrgId: schema.layouts.ownerOrgId })
    .from(schema.layouts)
    .where(eq(schema.layouts.id, layoutId))
    .get();
  if (!layout) {
    knownEmpty.delete(layoutId);
    return;
  }
  const had = await db.select().from(schema.layoutSharedModules).where(eq(schema.layoutSharedModules.layoutId, layoutId)).all();
  if (placed.length === 0 && had.length === 0) {
    knownEmpty.add(layoutId);
    return;
  }
  knownEmpty.delete(layoutId);
  const now = new Date();
  const states = new Map<string, SharedState>();
  for (const p of placed) if (!states.has(p.moduleId)) states.set(p.moduleId, await stateFor(layout, p.moduleId));
  const hadById = new Map(had.map((r) => [r.placedId, r]));
  db.transaction((tx) => {
    const keep = new Set(placed.map((p) => p.placedId));
    for (const r of had) {
      if (keep.has(r.placedId)) continue;
      tx.delete(schema.layoutSharedModules)
        .where(and(eq(schema.layoutSharedModules.layoutId, layoutId), eq(schema.layoutSharedModules.placedId, r.placedId)))
        .run();
    }
    for (const p of placed) {
      const state = states.get(p.moduleId)!;
      const version = p.version ?? 0;
      const was = hadById.get(p.placedId);
      if (was && was.moduleId === p.moduleId && was.version === version && was.state === state) continue;
      tx.insert(schema.layoutSharedModules)
        .values({ layoutId, placedId: p.placedId, moduleId: p.moduleId, version, state, updatedAt: now })
        .onConflictDoUpdate({
          target: [schema.layoutSharedModules.layoutId, schema.layoutSharedModules.placedId],
          set: { moduleId: p.moduleId, version, state, updatedAt: now },
        })
        .run();
    }
  });
}

/**
 * The same from the layout as it is stored, for a layout that was just
 * made (uploaded, copied, taken from the catalog, restored): a file may
 * already hold shared modules. Never fails the request that made it.
 */
export async function syncStoredLayout(layoutId: string): Promise<void> {
  let doc: Y.Doc | null = null;
  try {
    const row = await db.select({ docSnapshot: schema.layouts.docSnapshot }).from(schema.layouts).where(eq(schema.layouts.id, layoutId)).get();
    if (!row) return;
    doc = decodeDoc(row.docSnapshot as Uint8Array);
    knownEmpty.delete(layoutId);
    await syncLayoutSharedModules(layoutId, doc);
  } catch (err) {
    console.error(`[sharedModules] couldn't read which shared modules layout ${layoutId} places`, err);
  } finally {
    doc?.destroy();
  }
}

/** Forget what is known about a layout (it was deleted, or tests reset the database). */
export function forgetLayout(layoutId?: string): void {
  if (layoutId === undefined) knownEmpty.clear();
  else knownEmpty.delete(layoutId);
}

async function refreshRows(rows: { layoutId: string; placedId: string; moduleId: string; state: string }[]): Promise<string[]> {
  const changed = new Set<string>();
  const owners = new Map<string, Owner | null>();
  const memo = new Map<string, SharedState>();
  for (const r of rows) {
    if (!owners.has(r.layoutId)) {
      owners.set(
        r.layoutId,
        (await db
          .select({ ownerUserId: schema.layouts.ownerUserId, ownerOrgId: schema.layouts.ownerOrgId })
          .from(schema.layouts)
          .where(eq(schema.layouts.id, r.layoutId))
          .get()) ?? null,
      );
    }
    const owner = owners.get(r.layoutId);
    if (!owner) continue;
    const key = `${owner.ownerUserId ?? ''}|${owner.ownerOrgId ?? ''}|${r.moduleId}`;
    let state = memo.get(key);
    if (!state) memo.set(key, (state = await stateFor(owner, r.moduleId)));
    if (state === r.state) continue;
    await db
      .update(schema.layoutSharedModules)
      .set({ state, updatedAt: new Date() })
      .where(and(eq(schema.layoutSharedModules.layoutId, r.layoutId), eq(schema.layoutSharedModules.placedId, r.placedId)));
    changed.add(r.layoutId);
  }
  return [...changed];
}

/**
 * A module's shares changed, or it was deleted, restored or handed over:
 * work out again whether each placed copy still follows it. Returns the
 * layouts whose rows changed.
 */
export async function refreshStatesForModule(moduleId: string): Promise<string[]> {
  return refreshRows(await db.select().from(schema.layoutSharedModules).where(eq(schema.layoutSharedModules.moduleId, moduleId)).all());
}

/** A layout changed owner: work out again which of its shared modules still follow theirs. */
export async function refreshStatesForLayout(layoutId: string): Promise<string[]> {
  return refreshRows(await db.select().from(schema.layoutSharedModules).where(eq(schema.layoutSharedModules.layoutId, layoutId)).all());
}

/** The layouts that place `moduleId` (any state). */
export async function layoutsPlacing(moduleId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ layoutId: schema.layoutSharedModules.layoutId })
    .from(schema.layoutSharedModules)
    .where(eq(schema.layoutSharedModules.moduleId, moduleId))
    .all();
  return rows.map((r) => r.layoutId);
}

/**
 * Everyone who can open a layout that places `moduleId` and still follows
 * it: they hear when it has a new version (events/audience.ts).
 */
export async function peopleWithPlacedCopies(moduleId: string): Promise<string[]> {
  const layouts = await db
    .selectDistinct({ id: schema.layouts.id, ownerUserId: schema.layouts.ownerUserId, ownerOrgId: schema.layouts.ownerOrgId })
    .from(schema.layoutSharedModules)
    .innerJoin(schema.layouts, eq(schema.layouts.id, schema.layoutSharedModules.layoutId))
    .where(and(eq(schema.layoutSharedModules.moduleId, moduleId), eq(schema.layoutSharedModules.state, 'shared')))
    .all();
  if (layouts.length === 0) return [];
  const out = new Set<string>();
  const orgIds = new Set<string>();
  for (const l of layouts) {
    if (l.ownerUserId) out.add(l.ownerUserId);
    if (l.ownerOrgId) orgIds.add(l.ownerOrgId);
  }
  if (orgIds.size > 0) {
    const members = await db.select({ u: schema.orgMembers.userId }).from(schema.orgMembers).where(inArray(schema.orgMembers.orgId, [...orgIds])).all();
    for (const m of members) out.add(m.u);
  }
  const ids = layouts.map((l) => l.id);
  for (let i = 0; i < ids.length; i += 400) {
    const collab = await db
      .select({ u: schema.layoutCollaborators.userId })
      .from(schema.layoutCollaborators)
      .where(inArray(schema.layoutCollaborators.layoutId, ids.slice(i, i + 400)))
      .all();
    for (const c of collab) out.add(c.u);
  }
  return [...out];
}
