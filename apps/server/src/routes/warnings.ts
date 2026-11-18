// Warnings: formal notices about unacceptable activity.
//
//   POST /api/admin/warnings              site admin or moderator warns a person or a club
//   GET  /api/admin/warnings              the history for one person or club (admins, moderators)
//   POST /api/orgs/:slug/warnings         a club's admin or manager warns one of its members
//   GET  /api/orgs/:slug/warnings         the club's own warnings (its admins and managers)
//   GET  /api/notices                     the warnings I (or a club I run) received
//   POST /api/notices/:id/acknowledge     "I understand"
//   POST /api/notices/acknowledge-all     "Dismiss all": every unread note (never a warning)
//
// Who sees what:
//   - a site warning to a person: that person, site admins and moderators
//   - a site warning to a club: the club's members whose roles invite people
//     or manage members (and its Admins), site admins and moderators
//   - a club warning to a member: that member, the club's members whose
//     roles invite people or manage members (and its Admins), and site admins
//   - a club note (an author took back their thing): the members whose roles
//     delete club items (and its Admins)
// (access/clubNotices.ts: who hears about what, by permission.)
// Managers warn members only; admins warn members and managers. Nobody
// warns themselves. Everything is audit-logged and rate-limited; the next
// steps (read-only, limits) stay with site admins, on the same pages.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { requireUser } from '../auth/cookie.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { lesserRole, type ClubAccess } from '../access/clubPermissions.js';
import { clubAudience, clubsHearing, type ClubNotice } from '../access/clubNotices.js';
import { canModerate } from './catalog.js';
import { getMembership, loadOrgBySlug } from './orgs.js';
import { sendWarningEmail } from '../email/sendWarning.js';
import { publicName } from '../utils/publicName.js';
import { publish } from '../events/audience.js';
import { perPerson } from '../utils/rateLimits.js';

export const SEVERITIES = ['note', 'warning', 'final'] as const;
export type Severity = (typeof SEVERITIES)[number];
const MAX_REASON = 2000;
const MAX_LINK = 500;
/** Warnings one person may send in a minute (both kinds together). */
const RATE = perPerson(20, '1 minute');
// The desktop app (an API token, any layouts scope) shows your warnings and
// lets you acknowledge them, as the web's banner does.
const TOKEN_NOTICES = { apiToken: 'layouts:read' } as const;

type Input = { severity: Severity; reason: string; link: string | null };

/** The reason, severity and optional link, checked. A link must be a path on this site. */
export function parseWarningInput(body: unknown): Input | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const severity = b.severity;
  if (typeof severity !== 'string' || !(SEVERITIES as readonly string[]).includes(severity)) return { error: 'invalid_severity' };
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (reason.length < 3 || reason.length > MAX_REASON) return { error: 'invalid_reason' };
  let link: string | null = null;
  if (b.link !== undefined && b.link !== null && b.link !== '') {
    if (typeof b.link !== 'string') return { error: 'invalid_link' };
    const l = b.link.trim();
    // A path on this site only: no other sites, no `//host`, no `javascript:`.
    if (l.length > MAX_LINK || !l.startsWith('/') || l.startsWith('//') || /[\s\\]/.test(l)) return { error: 'invalid_link' };
    link = l;
  }
  return { severity: severity as Severity, reason, link };
}

/**
 * Which club notice a row to a club is: from the site team (a warning or
 * note to the club), or the club's own note about its things (postClubNote).
 */
function clubNoticeOf(w: Pick<schema.Warning, 'scope'>): ClubNotice {
  return w.scope === 'site' ? 'club_warning' : 'club_note';
}

/**
 * Who must see a warning: the person, or, for one to a club, the members
 * whose roles hear that kind of notice (access/clubNotices.ts), each once.
 */
export async function recipientsOf(w: Pick<schema.Warning, 'subjectUserId' | 'subjectOrgId' | 'scope'>): Promise<string[]> {
  if (w.subjectUserId) return [w.subjectUserId];
  if (!w.subjectOrgId) return [];
  return clubAudience(w.subjectOrgId, clubNoticeOf(w));
}

/** Who sees the club's Warnings list (for a club warning: they see what the club sent). */
export async function clubRunners(orgId: string): Promise<string[]> {
  return clubAudience(orgId, 'member_warning');
}

async function emailsOf(userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await db.select({ e: schema.users.email }).from(schema.users).where(inArray(schema.users.id, userIds)).all();
  return rows.map((r) => r.e);
}

interface WarningOut {
  id: string;
  scope: 'site' | 'club';
  severity: Severity;
  reason: string;
  link: string | null;
  createdAt: number;
  acknowledgedAt: number | null;
  issuedBy: { id: string; name: string } | null;
  club: { id: string; name: string; slug: string } | null;
  to: { kind: 'user'; id: string; name: string } | { kind: 'org'; id: string; name: string; slug: string };
}

/** Rows with the names the pages show. `withIssuer`: who sent it (staff and club runners only). */
async function describe(rows: schema.Warning[], withIssuer: boolean): Promise<WarningOut[]> {
  const userIds = [...new Set(rows.flatMap((r) => [r.subjectUserId, withIssuer ? r.issuedBy : null]).filter((x): x is string => !!x))];
  const orgIds = [...new Set(rows.flatMap((r) => [r.subjectOrgId, r.clubOrgId]).filter((x): x is string => !!x))];
  const users = userIds.length
    ? new Map((await db.select({ id: schema.users.id, n: schema.users.displayName }).from(schema.users).where(inArray(schema.users.id, userIds)).all()).map((u) => [u.id, publicName(u.id, u.n)]))
    : new Map<string, string>();
  const orgs = orgIds.length
    ? new Map((await db.select({ id: schema.orgs.id, n: schema.orgs.name, s: schema.orgs.slug }).from(schema.orgs).where(inArray(schema.orgs.id, orgIds)).all()).map((o) => [o.id, o]))
    : new Map<string, { id: string; n: string; s: string }>();
  return rows.map((r) => {
    const club = r.clubOrgId ? orgs.get(r.clubOrgId) : undefined;
    const org = r.subjectOrgId ? orgs.get(r.subjectOrgId) : undefined;
    return {
      id: r.id,
      scope: r.scope,
      severity: r.severity,
      reason: r.reason,
      link: r.link,
      createdAt: r.createdAt.getTime(),
      acknowledgedAt: r.acknowledgedAt ? r.acknowledgedAt.getTime() : null,
      issuedBy: withIssuer && r.issuedBy ? { id: r.issuedBy, name: users.get(r.issuedBy) ?? '' } : null,
      club: club ? { id: club.id, name: club.n, slug: club.s } : null,
      to: org
        ? { kind: 'org' as const, id: org.id, name: org.n, slug: org.s }
        : { kind: 'user' as const, id: r.subjectUserId ?? '', name: users.get(r.subjectUserId ?? '') ?? '' },
    };
  });
}

async function issue(args: {
  scope: 'site' | 'club';
  clubOrgId: string | null;
  subject: { kind: 'user' | 'org'; id: string };
  input: Input;
  issuer: { id: string; displayName: string };
  fromName: string;
}): Promise<schema.Warning> {
  const row: schema.Warning = {
    id: randomUUID(),
    scope: args.scope,
    clubOrgId: args.clubOrgId,
    subjectUserId: args.subject.kind === 'user' ? args.subject.id : null,
    subjectOrgId: args.subject.kind === 'org' ? args.subject.id : null,
    severity: args.input.severity,
    reason: args.input.reason,
    link: args.input.link,
    issuedBy: args.issuer.id,
    createdAt: new Date(),
    acknowledgedAt: null,
    acknowledgedBy: null,
  };
  await db.insert(schema.warnings).values(row);
  await writeAuditEvent({
    resourceKind: args.subject.kind,
    resourceId: args.subject.id,
    userId: args.issuer.id,
    eventType: args.scope === 'site' ? 'warn' : 'club_warn',
    payload: { warningId: row.id, severity: row.severity, reason: row.reason, link: row.link, ...(args.clubOrgId ? { clubOrgId: args.clubOrgId } : {}) },
  });
  // Email too, when the site can send it. Never fails the warning.
  try {
    const to = await emailsOf(await recipientsOf(row));
    for (const addr of to) await sendWarningEmail({ to: addr, severity: row.severity, reason: row.reason, fromName: args.fromName });
  } catch {
    // No SMTP or it failed: the notice in the app is what counts.
  }
  return row;
}

/**
 * A note to the members who look after a club's things (delete club items,
 * and its Admins) about something that happened to
 * the club's things (an author took back a module, say). It shows with
 * their notices, to read and acknowledge; it's not a warning to anyone,
 * so no email. The caller audit-logs what happened.
 */
export async function postClubNote(orgId: string, actorId: string | null, reason: string, link: string | null): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.warnings).values({
    id,
    scope: 'club',
    clubOrgId: orgId,
    subjectUserId: null,
    subjectOrgId: orgId,
    severity: 'note',
    reason: reason.slice(0, MAX_REASON),
    link: link && link.length <= MAX_LINK ? link : null,
    issuedBy: actorId,
    createdAt: new Date(),
    acknowledgedAt: null,
    acknowledgedBy: null,
  });
  return id;
}

/**
 * A note to one person (their data download is ready, their account was
 * kept, their club is being deleted). It shows with their notices, to
 * read and acknowledge, and arrives live; it's not a warning, and the
 * caller sends any email itself. `clubOrgId` makes it "From ‹club›";
 * otherwise it is from the site. Returns its id.
 */
export async function postPersonalNote(
  userId: string,
  reason: string,
  link: string | null,
  opts: { clubOrgId?: string | null; issuedBy?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.warnings).values({
    id,
    scope: opts.clubOrgId ? 'club' : 'site',
    clubOrgId: opts.clubOrgId ?? null,
    subjectUserId: userId,
    subjectOrgId: null,
    severity: 'note',
    reason: reason.slice(0, MAX_REASON),
    link: link && link.length <= MAX_LINK ? link : null,
    issuedBy: opts.issuedBy ?? null,
    createdAt: new Date(),
    acknowledgedAt: null,
    acknowledgedBy: null,
  });
  void publish({ kind: 'warning', id, action: 'create' }, { ownerless: true, users: [userId] });
  return id;
}

export async function warningRoutes(app: FastifyInstance): Promise<void> {
  // ---- site warnings ------------------------------------------------------
  app.post('/api/admin/warnings', { config: { rateLimit: RATE } }, async (req, reply) => {
    const user = requireUser(req);
    if (!canModerate(user)) return reply.code(403).send({ error: 'forbidden' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const kind = b.subjectKind;
    const id = typeof b.subjectId === 'string' ? b.subjectId : '';
    if ((kind !== 'user' && kind !== 'org') || !id) return reply.code(400).send({ error: 'invalid_subject' });
    const input = parseWarningInput(b);
    if ('error' in input) return reply.code(400).send(input);
    if (kind === 'user') {
      if (id === user.id) return reply.code(400).send({ error: 'cannot_warn_yourself' });
      const exists = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, id)).get();
      if (!exists) return reply.code(404).send({ error: 'not_found' });
    } else {
      const exists = await db.select({ id: schema.orgs.id }).from(schema.orgs).where(eq(schema.orgs.id, id)).get();
      if (!exists) return reply.code(404).send({ error: 'not_found' });
    }
    const row = await issue({ scope: 'site', clubOrgId: null, subject: { kind, id }, input, issuer: user, fromName: 'the site team' });
    return reply.code(201).send({ id: row.id });
  });

  app.get<{ Querystring: { subjectKind?: string; subjectId?: string } }>('/api/admin/warnings', async (req, reply) => {
    const user = requireUser(req);
    if (!canModerate(user)) return reply.code(403).send({ error: 'forbidden' });
    const { subjectKind, subjectId } = req.query;
    if ((subjectKind !== 'user' && subjectKind !== 'org') || !subjectId) return reply.code(400).send({ error: 'invalid_subject' });
    // Moderators see site warnings; admins also see clubs' own warnings.
    const siteOnly = !user.isGlobalAdmin;
    const about =
      subjectKind === 'user'
        ? eq(schema.warnings.subjectUserId, subjectId)
        : or(eq(schema.warnings.subjectOrgId, subjectId), eq(schema.warnings.clubOrgId, subjectId));
    const rows = await db
      .select()
      .from(schema.warnings)
      .where(siteOnly ? and(about, eq(schema.warnings.scope, 'site')) : about)
      .orderBy(desc(schema.warnings.createdAt))
      .all();
    return { warnings: await describe(rows, true) };
  });

  // ---- club warnings ------------------------------------------------------
  app.post<{ Params: { slug: string } }>('/api/orgs/:slug/warnings', { config: { rateLimit: RATE } }, async (req, reply) => {
    const user = requireUser(req);
    const org = await loadOrgBySlug(req.params.slug);
    if (!org) return reply.code(404).send({ error: 'not_found' });
    const mine = await getMembership(org.id, user.id);
    if (!mine) return reply.code(404).send({ error: 'not_found' });
    if (!mine.permissions.has('invite') && !mine.permissions.has('manage_members')) return reply.code(403).send({ error: 'forbidden', permission: 'invite' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const target = typeof b.userId === 'string' ? b.userId : '';
    if (!target) return reply.code(400).send({ error: 'invalid_subject' });
    if (target === user.id) return reply.code(400).send({ error: 'cannot_warn_yourself' });
    const theirs = await getMembership(org.id, target);
    if (!theirs) return reply.code(404).send({ error: 'not_a_member' });
    if (!mayWarn(mine, theirs)) {
      return reply.code(403).send({
        error: 'forbidden',
        message: theirs.isAdmin ? "Nobody in the club can warn an admin." : 'You can warn only people whose roles give them less than yours.',
      });
    }
    const input = parseWarningInput(b);
    if ('error' in input) return reply.code(400).send(input);
    const row = await issue({ scope: 'club', clubOrgId: org.id, subject: { kind: 'user', id: target }, input, issuer: user, fromName: org.name });
    return reply.code(201).send({ id: row.id });
  });

  app.get<{ Params: { slug: string } }>('/api/orgs/:slug/warnings', async (req, reply) => {
    const user = requireUser(req);
    const org = await loadOrgBySlug(req.params.slug);
    if (!org) return reply.code(404).send({ error: 'not_found' });
    const mine = await getMembership(org.id, user.id);
    if (!mine) return reply.code(404).send({ error: 'not_found' });
    if (!mine.permissions.has('invite') && !mine.permissions.has('manage_members')) return reply.code(403).send({ error: 'forbidden', permission: 'invite' });
    const rows = await db
      .select()
      .from(schema.warnings)
      .where(and(eq(schema.warnings.scope, 'club'), eq(schema.warnings.clubOrgId, org.id)))
      .orderBy(desc(schema.warnings.createdAt))
      .all();
    return { warnings: await describe(rows, true) };
  });

  // ---- what I received ----------------------------------------------------
  app.get('/api/notices', { config: TOKEN_NOTICES }, async (req) => {
    const user = requireUser(req);
    // Who sent it stays with the site team or the club's runners.
    return { notices: await describe(await noticesFor(user.id), false) };
  });

  // "Dismiss all": the notes (club deleted or restored, a download ready…)
  // go at once. Warnings are never dismissed this way: each needs its own
  // "I understand".
  app.post('/api/notices/acknowledge-all', { config: { ...TOKEN_NOTICES, rateLimit: perPerson(10, '1 minute') } }, async (req) => {
    const user = requireUser(req);
    const rows = (await noticesFor(user.id)).filter((r) => r.severity === 'note' && !r.acknowledgedAt);
    if (rows.length === 0) return { ok: true, acknowledged: [] as string[] };
    const now = new Date();
    const ids = rows.map((r) => r.id);
    await db
      .update(schema.warnings)
      .set({ acknowledgedAt: now, acknowledgedBy: user.id })
      .where(and(inArray(schema.warnings.id, ids), isNull(schema.warnings.acknowledgedAt), eq(schema.warnings.severity, 'note')));
    await writeAuditEvent({
      resourceKind: 'user',
      resourceId: user.id,
      userId: user.id,
      eventType: 'warn_ack_all',
      payload: { warningIds: ids },
    });
    return { ok: true, acknowledged: ids };
  });

  app.post<{ Params: { id: string } }>('/api/notices/:id/acknowledge', { config: TOKEN_NOTICES }, async (req, reply) => {
    const user = requireUser(req);
    const row = await db.select().from(schema.warnings).where(eq(schema.warnings.id, req.params.id)).get();
    if (!row || !(await recipientsOf(row)).includes(user.id)) return reply.code(404).send({ error: 'not_found' });
    if (row.acknowledgedAt) return { ok: true, acknowledgedAt: row.acknowledgedAt.getTime() };
    const now = new Date();
    await db
      .update(schema.warnings)
      .set({ acknowledgedAt: now, acknowledgedBy: user.id })
      .where(and(eq(schema.warnings.id, row.id), isNull(schema.warnings.acknowledgedAt)));
    await writeAuditEvent({
      resourceKind: row.subjectOrgId ? 'org' : 'user',
      resourceId: row.subjectOrgId ?? row.subjectUserId ?? user.id,
      userId: user.id,
      eventType: 'warn_ack',
      payload: { warningId: row.id },
    });
    return { ok: true, acknowledgedAt: now.getTime() };
  });
}

/** What I received: my own, and those to a club where my roles hear them (newest first). */
async function noticesFor(userId: string) {
  // The same rule as recipientsOf, from my side: site warnings to a club
  // where I run its people, and the club's notes where I look after its things.
  const warned = await clubsHearing(userId, 'club_warning');
  const noted = await clubsHearing(userId, 'club_note');
  return db
    .select()
    .from(schema.warnings)
    .where(
      or(
        eq(schema.warnings.subjectUserId, userId),
        warned.length ? and(inArray(schema.warnings.subjectOrgId, warned), eq(schema.warnings.scope, 'site')) : undefined,
        noted.length ? and(inArray(schema.warnings.subjectOrgId, noted), eq(schema.warnings.scope, 'club')) : undefined,
      ),
    )
    .orderBy(desc(schema.warnings.createdAt))
    .limit(200)
    .all();
}

/**
 * Nobody warns an admin from inside the club; "manage members and roles"
 * warns anyone else; "invite people" warns people with less than you (a
 * Manager warns Members, an Admin warns Managers, as before).
 */
export function mayWarn(by: ClubAccess, target: ClubAccess): boolean {
  if (target.isAdmin) return false;
  if (by.permissions.has('manage_members')) return true;
  return by.permissions.has('invite') && lesserRole(target.permissions, by.permissions);
}
