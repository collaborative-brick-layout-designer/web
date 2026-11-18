// Shared modules (docs/shared-modules.md): a new version of a module waits
// in the layouts set to "Ask first", and is put in at once in those set to
// "Automatically". The people who could press Update hear about it, one
// notification per layout, kept up to date while unread.

import { and, eq, inArray, lt, ne } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { clubMembersAccess } from '../access/clubPermissions.js';
import { notifyGrouped } from './notify.js';

/** Who could put a version in: the layout's owner, its editors, and a club's members who edit its layouts. */
async function layoutUpdaters(layout: { id: string; ownerUserId: string | null; ownerOrgId: string | null }): Promise<string[]> {
  const out = new Set<string>();
  if (layout.ownerUserId) out.add(layout.ownerUserId);
  if (layout.ownerOrgId) {
    for (const [u, a] of await clubMembersAccess(layout.ownerOrgId)) if (a.isAdmin || a.permissions.has('edit_layouts')) out.add(u);
  }
  const collab = await db
    .select({ u: schema.layoutCollaborators.userId })
    .from(schema.layoutCollaborators)
    .where(and(eq(schema.layoutCollaborators.layoutId, layout.id), inArray(schema.layoutCollaborators.role, ['editor', 'owner'])))
    .all();
  for (const c of collab) out.add(c.u);
  return [...out];
}

/** Module `moduleId` has a new version: tell the "Ask first" layouts' people that it waits. */
export async function notifyUpdateWaiting(moduleId: string, actorId: string | null): Promise<void> {
  const mod = await db.select({ title: schema.modules.title, latestVersion: schema.modules.latestVersion }).from(schema.modules).where(eq(schema.modules.id, moduleId)).get();
  if (!mod || mod.latestVersion < 1) return;
  const layouts = await db
    .selectDistinct({ id: schema.layouts.id, title: schema.layouts.title, ownerUserId: schema.layouts.ownerUserId, ownerOrgId: schema.layouts.ownerOrgId })
    .from(schema.layoutSharedModules)
    .innerJoin(schema.layouts, eq(schema.layouts.id, schema.layoutSharedModules.layoutId))
    .where(
      and(
        eq(schema.layoutSharedModules.moduleId, moduleId),
        eq(schema.layoutSharedModules.state, 'shared'),
        ne(schema.layouts.sharedModuleUpdates, 'auto'),
        lt(schema.layoutSharedModules.version, mod.latestVersion),
      ),
    )
    .all();
  for (const l of layouts) {
    await notifyGrouped({
      type: 'shared_modules.update_waiting',
      to: await layoutUpdaters(l),
      actor: actorId,
      club: l.ownerOrgId,
      needsMembership: !!l.ownerOrgId,
      subject: { kind: 'layout', id: l.id },
      title: `An update waits in “${l.title}”`,
      body: `“${mod.title}” has a new version (${mod.latestVersion}). Open the layout and press Update when you’re ready.`,
      link: `/editor/${l.id}`,
      groupKey: `updates:${l.id}`,
    });
  }
}

/** A layout set to "Automatically" just got the new version of `moduleTitle`. */
export async function notifyUpdatedAutomatically(layoutId: string, moduleTitle: string, version: number): Promise<void> {
  const l = await db.select({ id: schema.layouts.id, title: schema.layouts.title, ownerUserId: schema.layouts.ownerUserId, ownerOrgId: schema.layouts.ownerOrgId }).from(schema.layouts).where(eq(schema.layouts.id, layoutId)).get();
  if (!l) return;
  await notifyGrouped({
    type: 'shared_modules.updated',
    to: await layoutUpdaters(l),
    club: l.ownerOrgId,
    needsMembership: !!l.ownerOrgId,
    subject: { kind: 'layout', id: l.id },
    title: `“${l.title}” got a shared module’s update`,
    body: `“${moduleTitle}” is now at version ${version}, put in automatically.`,
    link: `/editor/${l.id}`,
    groupKey: `auto-updates:${l.id}`,
  });
}
