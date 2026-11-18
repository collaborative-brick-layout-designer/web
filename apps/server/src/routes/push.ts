// Pop-ups in the browser (Web Push; notifications/push.ts, docs/notifications.md).
//
//   GET    /api/push/key                 the site's public VAPID key, and whether push is on
//   GET    /api/push/subscriptions       my browsers that get pop-ups
//   POST   /api/push/subscriptions       { endpoint, keys: { p256dh, auth }, name? }   this browser
//   DELETE /api/push/subscriptions/:id   stop pop-ups to one of them
//
// Only the browser's own sign-in may add one; the desktop app shows its
// own system notifications instead (it doesn't use these).

import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { requireUser } from '../auth/cookie.js';
import { deviceName } from '../auth/session.js';
import { perPerson } from '../utils/rateLimits.js';
import { pushAvailable, pushSetting, saveSubscription, vapidKeys } from '../notifications/push.js';

export async function pushRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/push/key', async (req) => {
    requireUser(req);
    const on = (await pushSetting()).value;
    const keys = on ? await vapidKeys() : null;
    // The public key only: the private one never leaves the server.
    return { enabled: on && !!keys, publicKey: keys?.publicKey ?? null };
  });

  app.get('/api/push/subscriptions', async (req) => {
    const user = requireUser(req);
    const p = schema.pushSubscriptions;
    const rows = await db.select({ id: p.id, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt, endpoint: p.endpoint }).from(p).where(eq(p.userId, user.id)).orderBy(desc(p.createdAt)).all();
    return {
      subscriptions: rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.createdAt.getTime(),
        lastUsedAt: r.lastUsedAt ? r.lastUsedAt.getTime() : null,
        // Which push service, so the browser can tell whether it's this one (never the full address).
        service: new URL(r.endpoint).hostname,
      })),
    };
  });

  app.post<{ Body: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; name?: unknown } | undefined }>(
    '/api/push/subscriptions',
    { config: { rateLimit: perPerson(20, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      if (!(await pushAvailable())) return reply.code(409).send({ error: 'push_off', message: 'Pop-up notifications are turned off on this site.' });
      const b = req.body ?? {};
      const got = await saveSubscription(user.id, { endpoint: b.endpoint, keys: b.keys ?? {}, name: b.name }, deviceName(req.headers['user-agent']) ?? 'A browser');
      if ('error' in got) {
        const message = got.error === 'unknown_push_service' ? 'This browser’s push service isn’t one this site sends to.' : 'That isn’t a browser push subscription.';
        return reply.code(got.status).send({ error: got.error, message });
      }
      return reply.code(201).send({ id: got.id });
    },
  );

  app.delete<{ Params: { id: string } }>('/api/push/subscriptions/:id', async (req, reply) => {
    const user = requireUser(req);
    const p = schema.pushSubscriptions;
    const gone = await db.delete(p).where(and(eq(p.id, req.params.id), eq(p.userId, user.id))).returning({ id: p.id });
    if (gone.length === 0) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
