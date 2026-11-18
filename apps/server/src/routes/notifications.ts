// Notifications: the bell, the panel, the /notifications page and the
// desktop app all read these (docs/notifications.md is the contract).
//
//   GET  /api/notifications?unread=1&type=&category=&q=&cursor=&limit=
//   GET  /api/notifications/count
//   GET  /api/notifications/types
//   POST /api/notifications/:id/read
//   POST /api/notifications/:id/unread
//   POST /api/notifications/read-all          { ids?: string[] }
//   POST /api/notifications/:id/acknowledge   warnings: "I understand"
//   POST /api/notifications/:id/act           { action: 'accept' | 'decline' }
//
// Everyone sees only their own rows, and a club's rows only while they are
// in the club (needs_membership). Desktop tokens may read and mark read
// with any layouts scope, and answer with layouts:write.

import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { requireUser } from '../auth/cookie.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { escapeLike } from '../utils/validate.js';
import { publicName } from '../utils/publicName.js';
import { perPerson } from '../utils/rateLimits.js';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_TYPES, isNotificationType, typeInfo, type NotificationCategory } from '../notifications/types.js';
import { act } from '../notifications/act.js';
import { hintNotifications } from '../notifications/notify.js';

const READ = { apiToken: ['layouts:read', 'layouts:write'] } as const;
const WRITE = { apiToken: 'layouts:write' } as const;
const PAGE = 30;
const PAGE_MAX = 100;
const BULK_MAX = 500;

/** The clubs `userId` is in now. */
async function myClubs(userId: string): Promise<string[]> {
  return (await db.select({ o: schema.orgMembers.orgId }).from(schema.orgMembers).where(eq(schema.orgMembers.userId, userId)).all()).map((r) => r.o);
}

/** The rows `userId` may see: their own, and a club's only while they are in it. */
export async function visibleTo(userId: string): Promise<SQL> {
  const clubs = await myClubs(userId);
  const n = schema.notifications;
  return and(
    eq(n.userId, userId),
    clubs.length ? or(eq(n.needsMembership, false), inArray(n.clubOrgId, clubs)) : eq(n.needsMembership, false),
  )!;
}

export interface NotificationOut {
  id: string;
  type: string;
  category: NotificationCategory | null;
  title: string;
  body: string;
  link: string | null;
  createdAt: number;
  readAt: number | null;
  doneAt: number | null;
  outcome: string | null;
  outcomeBy: { id: string; name: string; you: boolean } | null;
  club: { id: string; name: string; slug: string } | null;
  actor: { id: string; name: string } | null;
  subject: { kind: string; id: string } | null;
  groupKey: string | null;
  actions: ('accept' | 'decline' | 'acknowledge')[];
}

export async function describeNotifications(rows: schema.Notification[], viewerId: string): Promise<NotificationOut[]> {
  const userIds = [...new Set(rows.flatMap((r) => [r.actorUserId, r.outcomeBy]).filter((x): x is string => !!x))];
  const orgIds = [...new Set(rows.map((r) => r.clubOrgId).filter((x): x is string => !!x))];
  const users = userIds.length
    ? new Map((await db.select({ id: schema.users.id, n: schema.users.displayName }).from(schema.users).where(inArray(schema.users.id, userIds)).all()).map((u) => [u.id, publicName(u.id, u.n)]))
    : new Map<string, string>();
  const orgs = orgIds.length
    ? new Map((await db.select({ id: schema.orgs.id, name: schema.orgs.name, slug: schema.orgs.slug }).from(schema.orgs).where(inArray(schema.orgs.id, orgIds)).all()).map((o) => [o.id, o]))
    : new Map<string, { id: string; name: string; slug: string }>();
  return rows.map((r) => {
    const info = typeInfo(r.type);
    const actions: NotificationOut['actions'] = r.doneAt ? [] : info?.action === 'accept-decline' ? ['accept', 'decline'] : info?.action === 'acknowledge' ? ['acknowledge'] : [];
    return {
      id: r.id,
      type: r.type,
      category: info?.category ?? null,
      title: r.title,
      body: r.body,
      link: r.link,
      createdAt: r.createdAt.getTime(),
      readAt: r.readAt ? r.readAt.getTime() : null,
      doneAt: r.doneAt ? r.doneAt.getTime() : null,
      outcome: r.outcome,
      outcomeBy: r.outcomeBy ? { id: r.outcomeBy, name: users.get(r.outcomeBy) ?? '', you: r.outcomeBy === viewerId } : null,
      club: r.clubOrgId ? (orgs.get(r.clubOrgId) ?? null) : null,
      actor: r.actorUserId && users.has(r.actorUserId) ? { id: r.actorUserId, name: users.get(r.actorUserId)! } : null,
      subject: r.subjectKind && r.subjectId ? { kind: r.subjectKind, id: r.subjectId } : null,
      groupKey: r.groupKey,
      actions,
    };
  });
}

/** "<createdAt>.<id>": the last row of the page before. */
function parseCursor(raw: unknown): { at: Date; id: string } | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{1,15})\.([A-Za-z0-9-]{1,64})$/.exec(raw);
  return m ? { at: new Date(Number(m[1])), id: m[2]! } : null;
}

const WARNING_TYPES = ['moderation.warning', 'moderation.final_warning'];
const WAITING_TYPES = Object.entries(NOTIFICATION_TYPES)
  .filter(([, v]) => 'action' in v && v.action === 'accept-decline')
  .map(([k]) => k);

export async function notificationCounts(userId: string): Promise<{ unread: number; waiting: number; warnings: number }> {
  const n = schema.notifications;
  const mine = await visibleTo(userId);
  const [unread, waiting, warnings] = await Promise.all([
    db.select({ c: count() }).from(n).where(and(mine, isNull(n.readAt))).get(),
    db.select({ c: count() }).from(n).where(and(mine, isNull(n.doneAt), inArray(n.type, WAITING_TYPES))).get(),
    db.select({ c: count() }).from(n).where(and(mine, isNull(n.doneAt), inArray(n.type, WARNING_TYPES))).get(),
  ]);
  return { unread: unread?.c ?? 0, waiting: waiting?.c ?? 0, warnings: warnings?.c ?? 0 };
}

async function mineById(userId: string, id: string): Promise<schema.Notification | null> {
  const n = schema.notifications;
  return (await db.select().from(n).where(and(eq(n.id, id), await visibleTo(userId))).get()) ?? null;
}

/**
 * "I understand", for one person: their row is done. The warning's own
 * acknowledged_at (the admin pages' history) keeps the first time anyone
 * acknowledged it.
 */
export async function acknowledgeWarningFor(userId: string, warningId: string, at = new Date()): Promise<void> {
  const n = schema.notifications;
  db.update(n)
    .set({ doneAt: at, outcome: 'acknowledged', outcomeBy: userId })
    .where(and(eq(n.userId, userId), eq(n.subjectKind, 'warning'), eq(n.subjectId, warningId), isNull(n.doneAt)))
    .run();
  db.update(n)
    .set({ readAt: at })
    .where(and(eq(n.userId, userId), eq(n.subjectKind, 'warning'), eq(n.subjectId, warningId), isNull(n.readAt)))
    .run();
  hintNotifications([userId]);
}

/**
 * Reading a note (a warnings row with severity 'note': from the site team,
 * a club, or about the club's things) is all it asks for: it's
 * acknowledged too, for the admin pages' history and older desktop apps.
 */
async function notesRead(userId: string, rows: Pick<schema.Notification, 'subjectKind' | 'subjectId'>[], at: Date): Promise<void> {
  const ids = rows.filter((r) => r.subjectKind === 'warning' && r.subjectId).map((r) => r.subjectId!);
  if (ids.length === 0) return;
  const notes = (await db.select({ id: schema.warnings.id }).from(schema.warnings).where(and(inArray(schema.warnings.id, ids), eq(schema.warnings.severity, 'note'))).all()).map((w) => w.id);
  if (notes.length === 0) return;
  const n = schema.notifications;
  db.update(n).set({ doneAt: at, outcome: 'acknowledged', outcomeBy: userId }).where(and(eq(n.userId, userId), eq(n.subjectKind, 'warning'), inArray(n.subjectId, notes), isNull(n.doneAt))).run();
  db.update(schema.warnings).set({ acknowledgedAt: at, acknowledgedBy: userId }).where(and(inArray(schema.warnings.id, notes), isNull(schema.warnings.acknowledgedAt))).run();
}

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { unread?: string; type?: string; category?: string; q?: string; cursor?: string; limit?: string } }>(
    '/api/notifications',
    { config: READ },
    async (req, reply) => {
      const user = requireUser(req);
      const n = schema.notifications;
      const q = req.query;
      const where: (SQL | undefined)[] = [await visibleTo(user.id)];
      if (q.unread === '1' || q.unread === 'true') where.push(isNull(n.readAt));
      if (q.type) {
        const types = q.type.split(',').filter(Boolean);
        if (types.length > 50 || !types.every(isNotificationType)) return reply.code(400).send({ error: 'invalid_type' });
        where.push(inArray(n.type, types));
      }
      if (q.category) {
        if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(q.category)) return reply.code(400).send({ error: 'invalid_category' });
        where.push(inArray(n.type, Object.entries(NOTIFICATION_TYPES).filter(([, v]) => v.category === q.category).map(([k]) => k)));
      }
      const needle = (q.q ?? '').trim().slice(0, 100);
      if (needle) {
        const safe = `%${escapeLike(needle)}%`;
        where.push(or(sql`${n.title} LIKE ${safe} ESCAPE '\\'`, sql`${n.body} LIKE ${safe} ESCAPE '\\'`));
      }
      if (q.cursor !== undefined) {
        const c = parseCursor(q.cursor);
        if (!c) return reply.code(400).send({ error: 'invalid_cursor' });
        where.push(or(lt(n.createdAt, c.at), and(eq(n.createdAt, c.at), lt(n.id, c.id))));
      }
      const limit = Math.min(PAGE_MAX, Math.max(1, Number.parseInt(q.limit ?? '', 10) || PAGE));
      const rows = await db
        .select()
        .from(n)
        .where(and(...where))
        .orderBy(desc(n.createdAt), desc(n.id))
        .limit(limit + 1)
        .all();
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        notifications: await describeNotifications(page, user.id),
        nextCursor: rows.length > limit && last ? `${last.createdAt.getTime()}.${last.id}` : null,
        ...(await notificationCounts(user.id)),
      };
    },
  );

  app.get('/api/notifications/count', { config: READ }, async (req) => notificationCounts(requireUser(req).id));

  app.get('/api/notifications/types', { config: READ }, async (req) => {
    requireUser(req);
    return {
      categories: [...NOTIFICATION_CATEGORIES],
      types: Object.entries(NOTIFICATION_TYPES).map(([type, v]) => ({ type, category: v.category, label: v.label, waits: v.waits, action: 'action' in v ? v.action : null })),
    };
  });

  for (const which of ['read', 'unread'] as const) {
    app.post<{ Params: { id: string } }>(`/api/notifications/:id/${which}`, { config: { ...READ, rateLimit: perPerson(240, '1 minute') } }, async (req, reply) => {
      const user = requireUser(req);
      const row = await mineById(user.id, req.params.id);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const readAt = which === 'read' ? (row.readAt ?? new Date()) : null;
      db.update(schema.notifications).set({ readAt }).where(eq(schema.notifications.id, row.id)).run();
      if (readAt) await notesRead(user.id, [row], readAt);
      return { ok: true, readAt: readAt ? readAt.getTime() : null };
    });
  }

  app.post<{ Body: { ids?: unknown } }>('/api/notifications/read-all', { config: { ...READ, rateLimit: perPerson(30, '1 minute') } }, async (req, reply) => {
    const user = requireUser(req);
    const n = schema.notifications;
    const raw = req.body?.ids;
    let only: string[] | null = null;
    if (raw !== undefined && raw !== null) {
      if (!Array.isArray(raw) || raw.length > BULK_MAX || !raw.every((x) => typeof x === 'string' && x.length <= 64)) return reply.code(400).send({ error: 'invalid_ids' });
      only = raw as string[];
      if (only.length === 0) return { ok: true, read: 0 };
    }
    const at = new Date();
    const which = and(await visibleTo(user.id), isNull(n.readAt), only ? inArray(n.id, only) : undefined);
    const rows = await db.select({ subjectKind: n.subjectKind, subjectId: n.subjectId }).from(n).where(which).all();
    const done = db.update(n).set({ readAt: at }).where(which).run();
    await notesRead(user.id, rows, at);
    return { ok: true, read: done.changes };
  });

  app.post<{ Params: { id: string } }>('/api/notifications/:id/acknowledge', { config: { ...READ, rateLimit: perPerson(60, '1 minute') } }, async (req, reply) => {
    const user = requireUser(req);
    const row = await mineById(user.id, req.params.id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.subjectKind !== 'warning' || !row.subjectId) return reply.code(400).send({ error: 'not_a_warning' });
    if (row.doneAt) return { ok: true, acknowledgedAt: row.doneAt.getTime() };
    const now = new Date();
    await acknowledgeWarningFor(user.id, row.subjectId, now);
    const w = await db.select().from(schema.warnings).where(eq(schema.warnings.id, row.subjectId)).get();
    if (w && !w.acknowledgedAt) {
      db.update(schema.warnings).set({ acknowledgedAt: now, acknowledgedBy: user.id }).where(and(eq(schema.warnings.id, w.id), isNull(schema.warnings.acknowledgedAt))).run();
    }
    if (w) {
      await writeAuditEvent({
        resourceKind: w.subjectOrgId ? 'org' : 'user',
        resourceId: w.subjectOrgId ?? w.subjectUserId ?? user.id,
        userId: user.id,
        eventType: 'warn_ack',
        payload: { warningId: w.id },
      });
    }
    return { ok: true, acknowledgedAt: now.getTime() };
  });

  app.post<{ Params: { id: string }; Body: { action?: unknown } }>('/api/notifications/:id/act', { config: { ...WRITE, rateLimit: perPerson(60, '1 minute') } }, async (req, reply) => {
    const user = requireUser(req);
    const row = await mineById(user.id, req.params.id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const answer = req.body?.action;
    if (answer !== 'accept' && answer !== 'decline') return reply.code(400).send({ error: 'invalid_action' });
    if (typeInfo(row.type)?.action !== 'accept-decline') return reply.code(400).send({ error: 'no_answer_here' });
    const res = await act(app, row, answer, user);
    if (res.status !== 200) return reply.code(res.status).send(res.body);
    const after = await db.select().from(schema.notifications).where(eq(schema.notifications.id, row.id)).get();
    if (after && !after.readAt) db.update(schema.notifications).set({ readAt: new Date() }).where(eq(schema.notifications.id, row.id)).run();
    const fresh = await db.select().from(schema.notifications).where(eq(schema.notifications.id, row.id)).get();
    return { ...res.body, notification: fresh ? (await describeNotifications([fresh], user.id))[0] : null };
  });
}
