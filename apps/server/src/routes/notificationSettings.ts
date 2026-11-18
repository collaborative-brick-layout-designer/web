// Settings › Notifications, and "Stop these emails" (docs/notifications.md).
//
//   GET  /api/me/notification-settings          everything, resolved
//   PUT  /api/me/notification-settings          { settings: {...some keys} } merged onto what's stored
//   GET  /api/notifications/unsubscribe?t=      what the link would stop (changes nothing; the page asks first)
//   POST /api/notifications/unsubscribe?t=      stop it: RFC 8058 one-click from a mail app, or the page's button
//
// The unsubscribe routes need no sign-in: the signed token names the
// account and what to stop, and can only turn email off.

import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { requireUser } from '../auth/cookie.js';
import { emailConfigured } from '../email/transporter.js';
import { perPerson } from '../utils/rateLimits.js';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_TYPES, type NotificationType, type NotificationTypeInfo } from '../notifications/types.js';
import { loadStored, parseSettings, resolve, saveStored, type StoredSettings } from '../notifications/settings.js';
import { readUnsubscribeToken, type UnsubscribeScope } from '../notifications/unsubscribe.js';
import { hintNotifications } from '../notifications/notify.js';
import '../notifications/delivery.js';

const READ = { apiToken: ['layouts:read', 'layouts:write', 'account:prefs'] } as const;
const WRITE = { apiToken: 'account:prefs' } as const;

/** Everything Settings › Notifications shows, for one person. */
export async function settingsView(userId: string) {
  const stored = await loadStored(userId);
  const r = resolve(stored);
  const memberships = await db
    .select({ id: schema.orgs.id, name: schema.orgs.name, slug: schema.orgs.slug })
    .from(schema.orgMembers)
    .innerJoin(schema.orgs, eq(schema.orgs.id, schema.orgMembers.orgId))
    .where(eq(schema.orgMembers.userId, userId))
    .all();
  return {
    categories: [...NOTIFICATION_CATEGORIES],
    types: (Object.entries(NOTIFICATION_TYPES) as [NotificationType, NotificationTypeInfo][]).map(([type, info]) => ({
      type,
      category: info.category,
      label: info.label,
      waits: info.waits,
      appLocked: !!info.appLocked,
      emailApart: info.emailApart ?? null,
      ...r.types[type],
    })),
    quiet: r.quiet,
    timeZone: r.timeZoneSet ? r.timeZone : null,
    dailyAt: r.dailyAt,
    weeklyDay: r.weeklyDay,
    pauseEmail: r.pauseEmail,
    pausePush: r.pausePush,
    clubs: memberships
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((o) => ({ ...o, ...(r.clubs[o.id] ?? { mute: false, email: true, push: true }) })),
    emailAvailable: await emailConfigured(),
    // Browser push arrives in Web C.
    pushAvailable: false,
  };
}

/**
 * Types turned off in the app, and muted clubs, leave the lists and the
 * count at once; turned back on, what they held comes back.
 */
export async function rehide(userId: string, stored: StoredSettings): Promise<void> {
  const r = resolve(stored);
  const n = schema.notifications;
  const off = (Object.keys(r.types) as NotificationType[]).filter((t) => !r.types[t].app);
  const muted = Object.entries(r.clubs).filter(([, c]) => c.mute).map(([id]) => id);
  const locked = (Object.keys(NOTIFICATION_TYPES) as NotificationType[]).filter((t) => (NOTIFICATION_TYPES[t] as NotificationTypeInfo).appLocked);
  db.transaction((tx) => {
    tx.update(n).set({ hidden: false }).where(and(eq(n.userId, userId), eq(n.hidden, true))).run();
    if (off.length) tx.update(n).set({ hidden: true }).where(and(eq(n.userId, userId), inArray(n.type, off))).run();
    if (muted.length) tx.update(n).set({ hidden: true }).where(and(eq(n.userId, userId), inArray(n.clubOrgId, muted), notInArray(n.type, locked))).run();
  });
}

/** Turn email off for `scope` (a type, or all of it). */
export async function stopEmails(userId: string, scope: UnsubscribeScope): Promise<void> {
  const current = (await loadStored(userId)) ?? { v: 1 };
  const change: Partial<StoredSettings> = scope === 'all' ? { pauseEmail: true } : { types: { [scope]: { email: 'off' } } };
  const next = parseSettings(change, current);
  if ('ok' in next) await saveStored(userId, next.ok);
}

/** "Requests to join a club you run" (and the others the old switch covered): the old Settings › Email switch. */
export const OLD_SWITCH_TYPES = ['club.join_request', 'club.partner_request', 'club.offer_received'] as const;

export async function notificationSettingsRoutes(app: FastifyInstance): Promise<void> {
  // RFC 8058: mail apps POST `List-Unsubscribe=One-Click` as a form.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 }, (_req, body, done) => done(null, { form: body }));

  app.get('/api/me/notification-settings', { config: READ }, async (req) => settingsView(requireUser(req).id));

  app.put<{ Body: { settings?: unknown } | undefined }>(
    '/api/me/notification-settings',
    { config: { ...WRITE, rateLimit: perPerson(60, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      const body = req.body;
      if (typeof body !== 'object' || body === null || !('settings' in body)) return reply.code(400).send({ error: 'settings is required' });
      const current = (await loadStored(user.id)) ?? { v: 1 };
      const next = parseSettings(body.settings, current);
      if ('error' in next) return reply.code(400).send({ error: 'invalid_settings', message: next.error });
      // Clubs: only ones the person is in.
      if (next.ok.clubs) {
        const ids = Object.keys(next.ok.clubs);
        const mine = ids.length
          ? new Set((await db.select({ o: schema.orgMembers.orgId }).from(schema.orgMembers).where(eq(schema.orgMembers.userId, user.id)).all()).map((r) => r.o))
          : new Set<string>();
        for (const id of ids) if (!mine.has(id) && !(current.clubs && id in current.clubs)) return reply.code(400).send({ error: 'invalid_settings', message: 'clubs names a club you are not in' });
      }
      await saveStored(user.id, next.ok);
      await rehide(user.id, next.ok);
      hintNotifications([user.id], 'update:settings');
      return settingsView(user.id);
    },
  );

  const scopeWords = (s: UnsubscribeScope) => (s === 'all' ? 'all notification emails' : `emails about “${(NOTIFICATION_TYPES[s] as NotificationTypeInfo).label}”`);

  app.get<{ Querystring: { t?: string } }>('/api/notifications/unsubscribe', { config: { rateLimit: perPerson(30, '1 minute') } }, async (req, reply) => {
    const got = readUnsubscribeToken(req.query.t);
    if (!got) return reply.code(404).send({ error: 'invalid_link', message: 'This link doesn’t work. You can change your emails in Settings › Notifications.' });
    return { ok: true, scope: got.scope, what: scopeWords(got.scope) };
  });

  app.post<{ Querystring: { t?: string }; Body: { t?: unknown; form?: string } | undefined }>(
    '/api/notifications/unsubscribe',
    { config: { rateLimit: perPerson(30, '1 minute') } },
    async (req, reply) => {
      const token = req.query.t ?? (typeof req.body?.t === 'string' ? req.body.t : undefined);
      const got = readUnsubscribeToken(token);
      if (!got) return reply.code(404).send({ error: 'invalid_link', message: 'This link doesn’t work. You can change your emails in Settings › Notifications.' });
      const exists = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, got.userId)).get();
      if (!exists) return reply.code(404).send({ error: 'invalid_link' });
      await stopEmails(got.userId, got.scope);
      hintNotifications([got.userId], 'update:settings');
      return { ok: true, scope: got.scope, what: scopeWords(got.scope) };
    },
  );
}
