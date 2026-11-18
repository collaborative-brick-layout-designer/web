// Admin › Privacy requests: a log of the requests that arrive by email or
// letter, with their due dates, and one-click answers. Site admins only;
// every change is audit-logged and kept in the request's own history.
//
//   GET    /api/admin/privacy/requests                  open ones first (?status=all for every one)
//   GET    /api/admin/privacy/summary                   counts for the badges (overdue, due soon) and nudges
//   POST   /api/admin/privacy/requests                  log one
//   GET    /api/admin/privacy/requests/:id              one, with its history and the account's state
//   PATCH  /api/admin/privacy/requests/:id              status, due date, type, who; or add a note
//   POST   /api/admin/privacy/requests/:id/export       build the person's data download (the admin downloads it)
//   POST   /api/admin/privacy/requests/:id/erase        erase the account now (typed confirmation)
//   POST   /api/admin/privacy/requests/:id/restrict     freeze (or unfreeze) the account and what it owns
//
// And for everyone:
//   GET    /api/privacy                                 the privacy notice and contact (/privacy page)

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray, lte, notInArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { PrivacyRequest } from '../db/schema.js';
import { requireGlobalAdmin } from '../auth/cookie.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { notifyCredentialRevoked } from '../auth/revocation.js';
import { getPlatformSettings } from '../auth/platformSettings.js';
import { publish } from '../events/audience.js';
import { describeExport, listExports, startExport } from '../privacy/exports.js';
import { EraseRefused, eraseUser, erasedLabel } from '../privacy/accountDeletion.js';
import { privacySettings } from '../privacy/settings.js';
import { privacyContact } from '../privacy/page.js';
import { postPersonalNote } from './warnings.js';
import { perPerson } from '../utils/rateLimits.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** "Due soon": within this many days. */
export const DUE_SOON_DAYS = 7;
const TYPES = ['access', 'erasure', 'rectification', 'restriction', 'objection', 'other'] as const;
const VIA = ['email', 'letter', 'in_person', 'other'] as const;
const STATUSES = ['open', 'waiting', 'done', 'refused'] as const;
const CLOSED: readonly PrivacyRequest['status'][] = ['done', 'refused'];
const MAX_TEXT = 2000;

type Body = Record<string, unknown>;
const str = (v: unknown, max = MAX_TEXT): string | null => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null);

async function addEvent(requestId: string, by: string | null, kind: string, text = ''): Promise<void> {
  await db.insert(schema.privacyRequestEvents).values({ id: randomUUID(), requestId, at: new Date(), by, kind, text: text.slice(0, MAX_TEXT) });
}

/** Overdue / due soon, for one open request. */
export function dueState(r: Pick<PrivacyRequest, 'status' | 'dueAt'>, now = Date.now()): 'closed' | 'overdue' | 'soon' | 'ok' {
  if (CLOSED.includes(r.status)) return 'closed';
  const left = r.dueAt.getTime() - now;
  if (left < 0) return 'overdue';
  return left <= DUE_SOON_DAYS * DAY_MS ? 'soon' : 'ok';
}

/** Counts for the Admin menu badge and the dashboard. */
export async function privacySummary(now = Date.now()) {
  const open = await db
    .select({ status: schema.privacyRequests.status, dueAt: schema.privacyRequests.dueAt })
    .from(schema.privacyRequests)
    .where(notInArray(schema.privacyRequests.status, [...CLOSED]))
    .all();
  const settings = await getPlatformSettings();
  return {
    open: open.length,
    overdue: open.filter((r) => dueState(r, now) === 'overdue').length,
    dueSoon: open.filter((r) => dueState(r, now) === 'soon').length,
    /** Nudges while these are empty. */
    noticeMissing: !settings.privacyNotice?.trim(),
    contactMissing: !(await privacyContact()).value,
  };
}

async function subjectOf(r: PrivacyRequest) {
  if (!r.subjectUserId) return null;
  const u = await db.select().from(schema.users).where(eq(schema.users.id, r.subjectUserId)).get();
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    restrictedAt: u.restrictedAt?.getTime() ?? null,
    deletionDueAt: u.deletionDueAt?.getTime() ?? null,
    isGlobalAdmin: u.isGlobalAdmin,
  };
}

async function wire(r: PrivacyRequest, now = Date.now()) {
  return {
    id: r.id,
    type: r.type,
    subjectUserId: r.subjectUserId,
    subjectText: r.subjectText,
    subject: await subjectOf(r),
    receivedVia: r.receivedVia,
    receivedAt: r.receivedAt.getTime(),
    dueAt: r.dueAt.getTime(),
    due: dueState(r, now),
    status: r.status,
    notes: r.notes,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
    closedAt: r.closedAt?.getTime() ?? null,
  };
}

async function load(id: string): Promise<PrivacyRequest | null> {
  return (await db.select().from(schema.privacyRequests).where(eq(schema.privacyRequests.id, id)).get()) ?? null;
}

async function touch(id: string): Promise<void> {
  await db.update(schema.privacyRequests).set({ updatedAt: new Date() }).where(eq(schema.privacyRequests.id, id));
  void publish({ kind: 'admin', action: 'update:privacy' }, { ownerless: true });
}

async function audit(adminId: string, r: PrivacyRequest, action: string, extra: Record<string, unknown> = {}): Promise<void> {
  await writeAuditEvent({
    resourceKind: 'user',
    resourceId: r.subjectUserId ?? `request:${r.id}`,
    userId: adminId,
    eventType: 'privacy_request',
    payload: { requestId: r.id, type: r.type, action, ...extra },
  });
}

/** Freeze or unfreeze an account (restriction): read only, and what it owns alone too. */
export async function setRestricted(userId: string, restricted: boolean): Promise<void> {
  await db.update(schema.users).set({ restrictedAt: restricted ? new Date() : null }).where(eq(schema.users.id, userId));
  // Open editors drop, so nothing keeps writing; they reconnect read only.
  if (restricted) notifyCredentialRevoked({ userId, reason: 'account_restricted' });
}

export async function privacyAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { status?: string } }>('/api/admin/privacy/requests', async (req) => {
    requireGlobalAdmin(req);
    const all = req.query.status === 'all';
    const rows = await db
      .select()
      .from(schema.privacyRequests)
      .where(all ? undefined : notInArray(schema.privacyRequests.status, [...CLOSED]))
      .orderBy(all ? desc(schema.privacyRequests.receivedAt) : asc(schema.privacyRequests.dueAt))
      .limit(500)
      .all();
    const now = Date.now();
    return { requests: await Promise.all(rows.map((r) => wire(r, now))), summary: await privacySummary(now) };
  });

  app.get('/api/admin/privacy/summary', async (req) => {
    requireGlobalAdmin(req);
    return privacySummary();
  });

  app.post('/api/admin/privacy/requests', { config: { rateLimit: perPerson(30, '1 minute') } }, async (req, reply) => {
    const admin = requireGlobalAdmin(req);
    const b = (req.body ?? {}) as Body;
    const type = oneOf(b.type, TYPES);
    const via = oneOf(b.receivedVia ?? 'email', VIA);
    if (!type || !via) return reply.code(400).send({ error: 'invalid_input' });
    const subjectUserId = typeof b.subjectUserId === 'string' && b.subjectUserId ? b.subjectUserId : null;
    const subjectText = str(b.subjectText, 300);
    if (!subjectUserId && !subjectText) return reply.code(400).send({ error: 'subject_required', message: 'Pick the account, or say who asked.' });
    if (subjectUserId && !(await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, subjectUserId)).get())) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const now = new Date();
    const receivedAt = typeof b.receivedAt === 'number' && Number.isFinite(b.receivedAt) && b.receivedAt <= now.getTime() + DAY_MS ? new Date(b.receivedAt) : now;
    const { requestDueDays } = await privacySettings();
    const row: PrivacyRequest = {
      id: randomUUID(),
      type,
      subjectUserId,
      subjectText,
      receivedVia: via,
      receivedAt,
      dueAt: new Date(receivedAt.getTime() + requestDueDays * DAY_MS),
      status: 'open',
      notes: str(b.notes) ?? '',
      createdBy: admin.id,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    await db.insert(schema.privacyRequests).values(row);
    await addEvent(row.id, admin.id, 'logged', `Logged a ${type} request received by ${via.replace('_', ' ')}.`);
    await audit(admin.id, row, 'log');
    void publish({ kind: 'admin', action: 'create:privacy' }, { ownerless: true });
    return reply.code(201).send({ request: await wire(row) });
  });

  app.get<{ Params: { id: string } }>('/api/admin/privacy/requests/:id', async (req, reply) => {
    const admin = requireGlobalAdmin(req);
    const r = await load(req.params.id);
    if (!r) return reply.code(404).send({ error: 'not_found' });
    const events = await db
      .select({ e: schema.privacyRequestEvents, name: schema.users.displayName })
      .from(schema.privacyRequestEvents)
      .leftJoin(schema.users, eq(schema.users.id, schema.privacyRequestEvents.by))
      .where(eq(schema.privacyRequestEvents.requestId, r.id))
      .orderBy(asc(schema.privacyRequestEvents.at))
      .all();
    return {
      request: await wire(r),
      history: events.map(({ e, name }) => ({ id: e.id, at: e.at.getTime(), by: name ?? null, kind: e.kind, text: e.text })),
      // Downloads this admin made for the request's person (only they can download them).
      exports: r.subjectUserId ? await listExports(admin.id, { kind: 'user', id: r.subjectUserId }) : [],
    };
  });

  app.patch<{ Params: { id: string } }>('/api/admin/privacy/requests/:id', async (req, reply) => {
    const admin = requireGlobalAdmin(req);
    const r = await load(req.params.id);
    if (!r) return reply.code(404).send({ error: 'not_found' });
    const b = (req.body ?? {}) as Body;
    const patch: Partial<PrivacyRequest> = {};
    const lines: string[] = [];
    if (b.status !== undefined) {
      const status = oneOf(b.status, STATUSES);
      if (!status) return reply.code(400).send({ error: 'invalid_input' });
      if (status !== r.status) {
        patch.status = status;
        patch.closedAt = CLOSED.includes(status) ? new Date() : null;
        lines.push(`Status: ${r.status} → ${status}.`);
      }
    }
    if (b.type !== undefined) {
      const type = oneOf(b.type, TYPES);
      if (!type) return reply.code(400).send({ error: 'invalid_input' });
      if (type !== r.type) {
        patch.type = type;
        lines.push(`Type: ${r.type} → ${type}.`);
      }
    }
    if (b.dueAt !== undefined) {
      if (typeof b.dueAt !== 'number' || !Number.isFinite(b.dueAt)) return reply.code(400).send({ error: 'invalid_input' });
      patch.dueAt = new Date(b.dueAt);
      lines.push(`Due date moved to ${patch.dueAt.toISOString().slice(0, 10)}.`);
    }
    if (b.subjectText !== undefined) {
      patch.subjectText = str(b.subjectText, 300);
      lines.push('Who asked: changed.');
    }
    if (b.notes !== undefined) {
      if (typeof b.notes !== 'string' || b.notes.length > MAX_TEXT) return reply.code(400).send({ error: 'invalid_input' });
      patch.notes = b.notes;
    }
    const note = str(b.addNote);
    if (!Object.keys(patch).length && !note) return reply.code(400).send({ error: 'empty_patch' });
    if (Object.keys(patch).length) await db.update(schema.privacyRequests).set(patch).where(eq(schema.privacyRequests.id, r.id));
    for (const line of lines) await addEvent(r.id, admin.id, line.startsWith('Status') ? 'status' : 'edit', line);
    if (note) await addEvent(r.id, admin.id, 'note', note);
    await audit(admin.id, r, 'update', { changed: Object.keys(patch), note: !!note });
    await touch(r.id);
    return { request: await wire((await load(r.id))!) };
  });

  app.post<{ Params: { id: string } }>('/api/admin/privacy/requests/:id/export', { config: { rateLimit: perPerson(10, '1 minute') } }, async (req, reply) => {
    const admin = requireGlobalAdmin(req);
    const r = await load(req.params.id);
    if (!r) return reply.code(404).send({ error: 'not_found' });
    if (!r.subjectUserId) return reply.code(409).send({ error: 'no_account', message: 'This request has no account to export.' });
    // Admins answering a request aren't held to the once-a-day limit.
    const row = await startExport({ subject: { kind: 'user', id: r.subjectUserId }, requestedBy: admin.id, reason: 'admin' });
    await addEvent(r.id, admin.id, 'export', 'Started their data download.');
    await writeAuditEvent({ resourceKind: 'user', resourceId: r.subjectUserId, userId: admin.id, eventType: 'data_export', payload: { exportId: row.id, reason: 'admin', requestId: r.id } });
    await touch(r.id);
    return reply.code(202).send({ export: describeExport(row) });
  });

  app.post<{ Params: { id: string } }>('/api/admin/privacy/requests/:id/erase', { config: { rateLimit: perPerson(10, '1 minute') } }, async (req, reply) => {
    const admin = requireGlobalAdmin(req);
    const r = await load(req.params.id);
    if (!r) return reply.code(404).send({ error: 'not_found' });
    if (!r.subjectUserId) return reply.code(409).send({ error: 'no_account', message: 'This request has no account to erase.' });
    const target = await db.select().from(schema.users).where(eq(schema.users.id, r.subjectUserId)).get();
    if (!target) return reply.code(404).send({ error: 'not_found' });
    const typed = typeof (req.body as Body | undefined)?.confirm === 'string' ? ((req.body as Body).confirm as string).trim().toLowerCase() : '';
    if (typed !== target.email.toLowerCase()) {
      return reply.code(400).send({ error: 'confirm_mismatch', message: 'Type the account’s email address exactly to erase it.' });
    }
    if (target.id === admin.id) return reply.code(400).send({ error: 'cannot_delete_self' });
    let ref: string;
    try {
      ref = (await eraseUser(target.id, 'request', admin.id))?.ref ?? erasedLabel(target.id);
    } catch (err) {
      if (err instanceof EraseRefused) {
        return reply.code(409).send({ error: err.message, message: err.message === 'last_site_admin' ? 'The last site admin can’t be erased.' : 'This account can’t be erased.' });
      }
      throw err;
    }
    // The request keeps a pseudonym, not the person.
    await db.update(schema.privacyRequests).set({ subjectText: ref, updatedAt: new Date() }).where(eq(schema.privacyRequests.id, r.id));
    await addEvent(r.id, admin.id, 'erase', `Erased the account now (it shows as ${ref}).`);
    await audit(admin.id, { ...r, subjectUserId: null }, 'erase', { ref });
    await touch(r.id);
    return { ok: true, ref };
  });

  app.post<{ Params: { id: string } }>('/api/admin/privacy/requests/:id/restrict', async (req, reply) => {
    const admin = requireGlobalAdmin(req);
    const r = await load(req.params.id);
    if (!r) return reply.code(404).send({ error: 'not_found' });
    if (!r.subjectUserId) return reply.code(409).send({ error: 'no_account', message: 'This request has no account to restrict.' });
    const restricted = (req.body as Body | undefined)?.restricted;
    if (typeof restricted !== 'boolean') return reply.code(400).send({ error: 'invalid_input' });
    if (r.subjectUserId === admin.id) return reply.code(400).send({ error: 'cannot_restrict_self' });
    // They stay signed in: restriction makes the account read only, it doesn't sign anyone out.
    await setRestricted(r.subjectUserId, restricted);
    await postPersonalNote(
      r.subjectUserId,
      restricted
        ? 'Your account is on hold (read only) while a privacy request is looked at. You can still see and download your things. Ask the site admin if you have questions.'
        : 'Your account is no longer on hold. You can change things again.',
      '/privacy',
      { kind: restricted ? { type: 'account.restriction_placed', title: 'Your account is on hold' } : { type: 'account.restriction_lifted', title: 'Your account is no longer on hold' } },
    );
    await addEvent(r.id, admin.id, restricted ? 'restrict' : 'unrestrict', restricted ? 'Restricted the account: read only, with what it owns.' : 'Lifted the restriction.');
    await audit(admin.id, r, restricted ? 'restrict' : 'unrestrict');
    void publish({ kind: 'me', owner: { kind: 'user', id: r.subjectUserId }, action: 'update:restricted' });
    await touch(r.id);
    return { ok: true, restricted };
  });

  // ---- the privacy page (everyone) ------------------------------------------
  app.get('/api/privacy', { config: { rateLimit: perPerson(60, '1 minute') } }, async () => {
    const s = await getPlatformSettings();
    const contact = await privacyContact();
    return { notice: s.privacyNotice?.trim() ? s.privacyNotice : null, contact: contact.value };
  });
}

/** Closed requests past the records setting (the privacy clean-up). */
export async function purgeClosedRequests(now = new Date()): Promise<number> {
  const { recordsKeepDays } = await privacySettings(now.getTime());
  const cutoff = new Date(now.getTime() - recordsKeepDays * DAY_MS);
  const old = await db
    .select({ id: schema.privacyRequests.id })
    .from(schema.privacyRequests)
    .where(and(inArray(schema.privacyRequests.status, [...CLOSED]), lte(schema.privacyRequests.closedAt, cutoff)))
    .all();
  if (old.length) await db.delete(schema.privacyRequests).where(inArray(schema.privacyRequests.id, old.map((o) => o.id)));
  return old.length;
}
