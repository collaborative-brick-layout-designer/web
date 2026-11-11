// Recently deleted (trash/trash.ts):
//   GET    /api/trash               → what you can restore: yours, and your clubs' where you may delete club items (each club item with the club's name and who deleted it)
//   POST   /api/trash/:id/restore   → put it back (a module: into its collections too; `collections` says which, and how many are gone)
//   DELETE /api/trash/:id           → erase it now (its background picture too), with an audit event

import type { FastifyInstance } from 'fastify';
import { inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { publicName } from '../utils/publicName.js';
import { requireUser } from '../auth/cookie.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { deleteFromTrash, listTrash, restoreFromTrash, TRASH_DAYS } from '../trash/trash.js';

export async function trashRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/trash', async (req) => {
    const user = requireUser(req);
    const items = await listTrash(user.id);
    // Whose a club's item is, and who deleted it (never an email: the public name).
    const orgIds = [...new Set(items.map((i) => i.ownerOrgId).filter((x): x is string => !!x))];
    const userIds = [...new Set(items.filter((i) => i.ownerOrgId && i.deletedBy && i.deletedBy !== user.id).map((i) => i.deletedBy!))];
    const clubs = new Map(orgIds.length ? (await db.select({ id: schema.orgs.id, name: schema.orgs.name }).from(schema.orgs).where(inArray(schema.orgs.id, orgIds)).all()).map((o) => [o.id, o.name]) : []);
    const people = new Map(
      userIds.length
        ? (await db.select({ id: schema.users.id, name: schema.users.displayName }).from(schema.users).where(inArray(schema.users.id, userIds)).all()).map((u) => [u.id, publicName(u.id, u.name)])
        : [],
    );
    return {
      days: TRASH_DAYS,
      items: items.map((i) => ({
        ...i,
        clubName: i.ownerOrgId ? (clubs.get(i.ownerOrgId) ?? null) : null,
        deletedByYou: i.deletedBy === user.id,
        deletedByName: i.deletedBy && i.deletedBy !== user.id ? (people.get(i.deletedBy) ?? null) : null,
      })),
    };
  });

  app.post<{ Params: { id: string } }>('/api/trash/:id/restore', async (req, reply) => {
    const user = requireUser(req);
    const r = await restoreFromTrash(user, req.params.id);
    // A limit's refusal carries its own sentence ("You have 500 layouts, the most allowed. …").
    if (!r.ok) return reply.code(r.code).send(r.body ?? { error: r.error });
    const payload = r.collections ? { collectionsBack: r.collections.back.map((c) => c.id), collectionsGone: r.collections.gone, collectionsFull: r.collections.full.map((c) => c.id) } : {};
    await writeAuditEvent(
      r.kind === 'layout'
        ? { layoutId: r.itemId, userId: user.id, eventType: 'restore_deleted', payload }
        : { resourceKind: r.kind, resourceId: r.itemId, userId: user.id, eventType: 'restore_deleted', payload },
    );
    return { ok: true, kind: r.kind, id: r.itemId, ...(r.collections ? { collections: r.collections } : {}) };
  });

  app.delete<{ Params: { id: string } }>('/api/trash/:id', async (req, reply) => {
    const user = requireUser(req);
    const gone = await deleteFromTrash(user.id, req.params.id);
    if (!gone) return reply.code(404).send({ error: 'not_found' });
    // The record that it was erased early, and by whom (the item itself is gone).
    await writeAuditEvent({ resourceKind: gone.kind, resourceId: gone.itemId, userId: user.id, eventType: 'delete_forever', payload: { title: gone.title, ...(gone.ownerOrgId ? { orgId: gone.ownerOrgId } : {}) } });
    return { ok: true };
  });
}
