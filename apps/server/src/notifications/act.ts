// Accept and Decline, right in a notification
// (POST /api/notifications/:id/act {action}). Each answer runs the
// existing route for it (the club page's approve, the invite page's
// accept…), in-process with a one-time ticket for the caller's own
// account (actTicket.ts), so the checks are exactly the same. Declining an
// invite or a layout hand-over, which had no route before, is done here
// with the accept route's own ownership check (it's yours: the address it
// was sent to is your account's), and only removes the invite.
//
// When someone else already answered (another of the club's runners, or
// the person took their request back), the notification says so and the
// answer is not an error.

import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { sameEmail } from '../utils/validate.js';
import { ACT_TICKET_HEADER, issueActTicket } from './actTicket.js';
import { nameOf, notify, resolve, type Outcome } from './notify.js';
import type { User } from '../db/schema.js';

export type ActAnswer = 'accept' | 'decline';

export type ActResult =
  | { status: 200; body: { ok: true; outcome: Outcome; already?: boolean; result?: unknown } }
  | { status: number; body: Record<string, unknown> };

/** Route answers that mean "this was already answered, or is gone". */
const ALREADY = new Set([
  'request_not_found',
  'offer_not_found',
  'offer_gone',
  'invite_not_found',
  'invite_already_accepted',
  'invite_expired',
  'invite_no_longer_valid',
  'invite_revoked',
  'transfer_not_found',
  'transfer_already_accepted',
  'transfer_expired',
  'transfer_stale',
  'already_member',
]);

type Target = { method: 'POST'; url: string } | { decline: () => Promise<ActResult> } | null;

async function clubSlug(orgId: string | null): Promise<string | null> {
  if (!orgId) return null;
  const o = await db.select({ slug: schema.orgs.slug }).from(schema.orgs).where(eq(schema.orgs.id, orgId)).get();
  return o?.slug ?? null;
}

const enc = encodeURIComponent;

/** The invites and hand-overs answered by their link's token. */
const TOKEN_KINDS = {
  org_invite: { table: schema.orgInvites, email: 'invitedEmail', from: 'invitedBy', path: '/api/org-invites/' },
  layout_invite: { table: schema.layoutInvites, email: 'invitedEmail', from: 'invitedBy', path: '/api/invites/' },
  module_invite: { table: schema.moduleInvites, email: 'invitedEmail', from: 'invitedBy', path: '/api/module-invites/' },
  part_invite: { table: schema.customPartInvites, email: 'invitedEmail', from: 'invitedBy', path: '/api/part-invites/' },
  layout_transfer: { table: schema.layoutTransfers, email: 'recipientEmail', from: 'initiatedBy', path: '/api/transfers/' },
} as const;
type TokenKind = keyof typeof TOKEN_KINDS;

type TokenRow = { id: string; token: string; acceptedAt: Date | null; expiresAt: Date; email: string; from: string | null; layoutId: string | null };

async function tokenRow(kind: TokenKind, id: string): Promise<TokenRow | null> {
  const k = TOKEN_KINDS[kind];
  // Each table has id, token, accepted_at, expires_at and its address column.
  const t = k.table as unknown as typeof schema.layoutInvites;
  const row = (await db.select().from(t).where(eq(t.id, id)).get()) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    token: row.token as string,
    acceptedAt: (row.acceptedAt as Date | null) ?? null,
    expiresAt: row.expiresAt as Date,
    email: row[k.email] as string,
    from: (row[k.from] as string | null) ?? null,
    layoutId: (row.layoutId as string | undefined) ?? null,
  };
}

async function declineByToken(kind: TokenKind, n: schema.Notification, user: User): Promise<ActResult> {
  const row = await tokenRow(kind, n.subjectId ?? '');
  if (!row || row.acceptedAt || row.expiresAt.getTime() < Date.now()) return { status: 404, body: { error: 'invite_not_found' } };
  // Only the person it was sent to may turn it down (the accept route's check).
  if (!sameEmail(row.email, user.email)) return { status: 403, body: { error: 'email_mismatch' } };
  const t = TOKEN_KINDS[kind].table as unknown as typeof schema.layoutInvites;
  const gone = await db.delete(t).where(and(eq(t.id, row.id), isNull(t.acceptedAt))).returning({ id: t.id });
  if (gone.length === 0) return { status: 404, body: { error: 'invite_not_found' } };
  await writeAuditEvent({ resourceKind: 'user', resourceId: user.id, userId: user.id, eventType: kind === 'layout_transfer' ? 'transfer_decline' : 'invite_decline', payload: { kind, id: row.id } });
  if (kind === 'layout_transfer' && row.from) {
    const layout = row.layoutId ? await db.select({ title: schema.layouts.title }).from(schema.layouts).where(eq(schema.layouts.id, row.layoutId)).get() : undefined;
    await notify({
      type: 'sharing.transfer_declined',
      to: [row.from],
      actor: user.id,
      subject: { kind: 'layout', id: row.layoutId ?? row.id },
      title: `${await nameOf(user.id)} declined your layout${layout ? ` “${layout.title}”` : ''}`,
      body: 'It stays yours.',
      link: row.layoutId ? `/editor/${row.layoutId}` : null,
    });
  }
  return { status: 200, body: { ok: true, outcome: 'declined' } };
}

async function targetFor(n: schema.Notification, answer: ActAnswer, user: User): Promise<Target> {
  const id = n.subjectId ?? '';
  switch (n.subjectKind) {
    case 'join_request': {
      const slug = await clubSlug(n.clubOrgId);
      return slug ? { method: 'POST', url: `/api/orgs/${enc(slug)}/join-requests/${enc(id)}/${answer === 'accept' ? 'approve' : 'decline'}` } : null;
    }
    case 'partner_request': {
      const slug = await clubSlug(n.clubOrgId);
      return slug ? { method: 'POST', url: `/api/orgs/${enc(slug)}/partner-requests/${enc(id)}/${answer}` } : null;
    }
    case 'module_offer': {
      const slug = await clubSlug(n.clubOrgId);
      return slug ? { method: 'POST', url: `/api/orgs/${enc(slug)}/module-offers/${enc(id)}/${answer}` } : null;
    }
    case 'org_invite':
    case 'layout_invite':
    case 'module_invite':
    case 'part_invite':
    case 'layout_transfer': {
      const kind = n.subjectKind as TokenKind;
      if (answer === 'decline') return { decline: () => declineByToken(kind, n, user) };
      const row = await tokenRow(kind, id);
      if (!row) return null;
      return { method: 'POST', url: `${TOKEN_KINDS[kind].path}${enc(row.token)}` };
    }
    default:
      return null;
  }
}

/** Run one answer. The caller has checked the notification is the user's own. */
export async function act(app: FastifyInstance, n: schema.Notification, answer: ActAnswer, user: User): Promise<ActResult> {
  if (n.doneAt) return { status: 200, body: { ok: true, outcome: (n.outcome as Outcome | null) ?? 'gone', already: true } };
  const target = await targetFor(n, answer, user);
  const subject = { kind: n.subjectKind ?? '', id: n.subjectId ?? '' };
  if (!target) {
    await resolve(subject, 'gone', null);
    return { status: 200, body: { ok: true, outcome: 'gone', already: true } };
  }
  let res: ActResult;
  if ('decline' in target) {
    res = await target.decline();
  } else {
    const out = await app.inject({ method: target.method, url: target.url, headers: { [ACT_TICKET_HEADER]: issueActTicket(user.id), 'content-type': 'application/json' }, payload: '{}' });
    let body: Record<string, unknown>;
    try {
      body = out.body ? (JSON.parse(out.body) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    res = out.statusCode < 300 ? { status: 200, body: { ok: true, outcome: answer === 'accept' ? 'accepted' : 'declined', result: body } } : { status: out.statusCode, body };
  }
  if (res.status === 200) {
    // The routes close the notifications they answer; this covers the rest.
    await resolve(subject, (res.body as { outcome: Outcome }).outcome, user.id);
    return res;
  }
  const e = (res.body as Record<string, unknown>).error;
  const err = typeof e === 'string' ? e : '';
  if (ALREADY.has(err)) {
    const now = await db.select().from(schema.notifications).where(eq(schema.notifications.id, n.id)).get();
    if (!now?.doneAt) await resolve(subject, 'gone', null);
    const after = await db.select().from(schema.notifications).where(eq(schema.notifications.id, n.id)).get();
    return { status: 200, body: { ok: true, outcome: (after?.outcome as Outcome | null) ?? 'gone', already: true } };
  }
  return res;
}
