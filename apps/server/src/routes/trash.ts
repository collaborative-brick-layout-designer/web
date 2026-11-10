// Recently deleted (trash/trash.ts):
//   GET    /api/trash               → what you can restore: yours, and your clubs' where you may delete club items
//   POST   /api/trash/:id/restore   → put it back
//   DELETE /api/trash/:id           → erase it now

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
    const r = await restoreFromTrash(user.id, req.params.id);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    await writeAuditEvent(
      r.kind === 'layout'
        ? { layoutId: r.itemId, userId: user.id, eventType: 'restore_deleted', payload: {} }
        : { resourceKind: r.kind, resourceId: r.itemId, userId: user.id, eventType: 'restore_deleted', payload: {} },
    );
    return { ok: true, kind: r.kind, id: r.itemId };
  });

  app.delete<{ Params: { id: string } }>('/api/trash/:id', async (req, reply) => {
    const user = requireUser(req);
    if (!(await deleteFromTrash(user.id, req.params.id))) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
