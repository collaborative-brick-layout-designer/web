// Recently deleted (trash/trash.ts):
//   GET    /api/trash               → what you can restore: yours, and your clubs' where you may delete club items
//   POST   /api/trash/:id/restore   → put it back (a module: into its collections too; `collections` says which, and how many are gone)
//   DELETE /api/trash/:id           → erase it now (its background picture too), with an audit event

import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/cookie.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { deleteFromTrash, listTrash, restoreFromTrash, TRASH_DAYS } from '../trash/trash.js';

export async function trashRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/trash', async (req) => {
    const user = requireUser(req);
    return { days: TRASH_DAYS, items: await listTrash(user.id) };
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
