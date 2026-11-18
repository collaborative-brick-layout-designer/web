// Notifications (docs/notifications.md): who gets one, the list and its
// filters, read and unread, Accept and Decline through the existing routes
// (and "someone else already answered"), warnings' per-person "I
// understand" with the old /api/notices contract, desktop tokens, removed
// members, erasure and the 180-day clean-up.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, issueToken, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { registerApiRoutes } from '../all.js';
import { registerChangeHints } from '../../events/routeHints.js';
import { purgeRetention } from '../../privacy/retention.js';
import { eraseUser } from '../../privacy/accountDeletion.js';
import { notify } from '../../notifications/notify.js';
import { NOTIFICATION_TYPES } from '../../notifications/types.js';
import { ACT_TICKET_HEADER } from '../../notifications/actTicket.js';

type Who = { cookie: string; id: string };
type Item = { id: string; type: string; title: string; body: string; readAt: number | null; doneAt: number | null; outcome: string | null; outcomeBy: { name: string; you: boolean } | null; actions: string[]; subject: { kind: string; id: string } | null; club: { slug: string } | null };
type List = { notifications: Item[]; nextCursor: string | null; unread: number; waiting: number; warnings: number };

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cookie);
  await app.register(fastifyMultipart);
  app.addHook('preHandler', attachUser);
  registerChangeHints(app);
  await registerApiRoutes(app);
  return app;
}

describe('notifications', () => {
  let app: FastifyInstance;
  let admin: Who;
  let manager: Who;
  let member: Who;
  let asker: Who;
  let orgId: string;

  const call = (who: Who, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: { cookie: who.cookie }, ...(payload ? { payload } : {}) });
  const list = async (who: Who, q = ''): Promise<List> => (await call(who, 'GET', `/api/notifications${q}`)).json() as List;
  const ofType = async (who: Who, type: string) => (await list(who)).notifications.filter((n) => n.type === type);

  beforeEach(async () => {
    resetDb();
    app = await buildApp();
    admin = await loginAs(app, 'admin@example.com');
    manager = await loginAs(app, 'manager@example.com');
    member = await loginAs(app, 'member@example.com');
    asker = await loginAs(app, 'asker@example.com');
    const res = await call(admin, 'POST', '/api/orgs', { name: 'ArkLUG', slug: 'arklug' });
    orgId = (res.json() as { id: string }).id;
    await db.insert(schema.orgMembers).values({ orgId, userId: manager.id, role: 'manager', joinedAt: new Date() });
    await db.insert(schema.orgMembers).values({ orgId, userId: member.id, role: 'member', joinedAt: new Date() });
    expect((await call(admin, 'PATCH', '/api/orgs/arklug', { joinPolicy: 'request', listed: true })).statusCode).toBe(200);
  });
  afterEach(async () => {
    await app.close();
  });

  it('a request to join reaches whoever answers them, not plain members, and counts as waiting', async () => {
    expect((await call(asker, 'POST', '/api/orgs/arklug/join', { message: 'Hi!' })).statusCode).toBe(200);
    for (const who of [admin, manager]) {
      const l = await list(who);
      expect(l.notifications).toHaveLength(1);
      expect(l.notifications[0]).toMatchObject({ type: 'club.join_request', body: 'Their note: “Hi!”', actions: ['accept', 'decline'], readAt: null });
      expect(l.notifications[0]!.title).toMatch(/asked to join ArkLUG/);
      expect(l).toMatchObject({ unread: 1, waiting: 1, warnings: 0 });
      expect((await call(who, 'GET', '/api/notifications/count')).json()).toEqual({ unread: 1, waiting: 1, warnings: 0 });
    }
    expect((await list(member)).notifications).toHaveLength(0);
    expect((await list(asker)).notifications).toHaveLength(0);
  });

  it('Accept in the notification runs the club page’s approve; the other runner then sees who answered', async () => {
    await call(asker, 'POST', '/api/orgs/arklug/join');
    const [n] = await ofType(admin, 'club.join_request');
    const res = await call(admin, 'POST', `/api/notifications/${n!.id}/act`, { action: 'accept' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, outcome: 'accepted', notification: { doneAt: expect.any(Number), readAt: expect.any(Number), outcome: 'accepted', actions: [] } });
    expect(await db.select().from(schema.orgMembers).where(and(eq(schema.orgMembers.orgId, orgId), eq(schema.orgMembers.userId, asker.id))).get()).toBeTruthy();
    // The same audit row as the club page writes.
    expect(await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'join_approve')).all()).toHaveLength(1);

    const [theirs] = await ofType(manager, 'club.join_request');
    expect(theirs).toMatchObject({ outcome: 'accepted', outcomeBy: { you: false, name: 'admin' }, actions: [], readAt: null });
    // Answering it too is not an error: it says what happened.
    const again = await call(manager, 'POST', `/api/notifications/${theirs!.id}/act`, { action: 'decline' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ ok: true, already: true, outcome: 'accepted' });
    // The person who asked hears.
    expect(await ofType(asker, 'club.join_approved')).toHaveLength(1);
  });

  it('answering on the club page closes the notifications too, and Decline tells the person', async () => {
    await call(asker, 'POST', '/api/orgs/arklug/join');
    const req = await db.select().from(schema.orgJoinRequests).get();
    expect((await call(manager, 'POST', `/api/orgs/arklug/join-requests/${req!.id}/decline`)).statusCode).toBe(200);
    const [mine] = await ofType(manager, 'club.join_request');
    expect(mine).toMatchObject({ outcome: 'declined', outcomeBy: { you: true }, readAt: expect.any(Number) });
    expect((await ofType(admin, 'club.join_request'))[0]).toMatchObject({ outcome: 'declined', outcomeBy: { you: false } });
    const [told] = await ofType(asker, 'club.join_declined');
    expect(told!.title).toBe('ArkLUG declined your request to join');
    // Who declined is not named to them.
    expect(JSON.stringify(told)).not.toMatch(/manager/);
  });

  it('taking a request back closes it for the club', async () => {
    await call(asker, 'POST', '/api/orgs/arklug/join');
    await call(asker, 'DELETE', '/api/orgs/arklug/join');
    expect((await ofType(admin, 'club.join_request'))[0]).toMatchObject({ outcome: 'withdrawn', actions: [] });
    expect((await list(admin)).waiting).toBe(0);
  });

  it('the act goes through the route’s own checks: a runner who lost the permission is refused', async () => {
    await call(asker, 'POST', '/api/orgs/arklug/join');
    const [n] = await ofType(manager, 'club.join_request');
    // Demoted to a plain member: still in the club, so still sees it, but may not answer.
    await call(admin, 'PATCH', `/api/orgs/arklug/members/${manager.id}`, { role: 'member' });
    const res = await call(manager, 'POST', `/api/notifications/${n!.id}/act`, { action: 'accept' });
    expect(res.statusCode).toBe(403);
    expect(await db.select().from(schema.orgMembers).where(and(eq(schema.orgMembers.orgId, orgId), eq(schema.orgMembers.userId, asker.id))).get()).toBeFalsy();
  });

  it('a removed member stops seeing the club’s notifications, and hears they were removed', async () => {
    await call(asker, 'POST', '/api/orgs/arklug/join');
    expect((await list(manager)).notifications).toHaveLength(1);
    expect((await call(admin, 'DELETE', `/api/orgs/arklug/members/${manager.id}`)).statusCode).toBe(200);
    const l = await list(manager);
    expect(l.notifications.map((n) => n.type)).toEqual(['club.removed']);
    const [gone] = (await db.select().from(schema.notifications).where(and(eq(schema.notifications.userId, manager.id), eq(schema.notifications.type, 'club.join_request'))).all());
    expect((await call(manager, 'POST', `/api/notifications/${gone!.id}/read`)).statusCode).toBe(404);
    expect((await call(manager, 'POST', `/api/notifications/${gone!.id}/act`, { action: 'accept' })).statusCode).toBe(404);
  });

  it('nobody reads, marks or answers someone else’s', async () => {
    await call(asker, 'POST', '/api/orgs/arklug/join');
    const [n] = await ofType(admin, 'club.join_request');
    for (const path of ['read', 'unread', 'acknowledge']) expect((await call(member, 'POST', `/api/notifications/${n!.id}/${path}`)).statusCode).toBe(404);
    expect((await call(member, 'POST', `/api/notifications/${n!.id}/act`, { action: 'accept' })).statusCode).toBe(404);
    const r = await call(member, 'POST', '/api/notifications/read-all', { ids: [n!.id] });
    expect(r.json()).toMatchObject({ read: 0 });
    expect((await list(admin)).unread).toBe(1);
  });

  it('a forged answer ticket gets nowhere', async () => {
    await call(asker, 'POST', '/api/orgs/arklug/join');
    const req = await db.select().from(schema.orgJoinRequests).get();
    const res = await app.inject({ method: 'POST', url: `/api/orgs/arklug/join-requests/${req!.id}/approve`, headers: { [ACT_TICKET_HEADER]: 'a'.repeat(43) } });
    expect(res.statusCode).toBe(401);
    expect(await db.select().from(schema.orgJoinRequests).get()).toBeTruthy();
  });

  it('read, unread, read-all (all or some), filters, search and pages', async () => {
    for (let i = 0; i < 5; i++) {
      await notify({ type: 'account.export_ready', to: [member.id], title: `Download ${i}`, body: i === 3 ? 'the special one' : 'ready', at: new Date(Date.now() - (10 - i) * 1000) });
    }
    await notify({ type: 'club.role_changed', to: [member.id], club: orgId, needsMembership: true, title: 'Roles', body: 'You now have Manager.' });
    let l = await list(member);
    expect(l.unread).toBe(6);
    const first = l.notifications[0]!;
    expect(first.title).toBe('Roles');
    expect((await call(member, 'POST', `/api/notifications/${first.id}/read`)).json()).toMatchObject({ ok: true, readAt: expect.any(Number) });
    expect((await list(member, '?unread=1')).notifications).toHaveLength(5);
    expect((await call(member, 'POST', `/api/notifications/${first.id}/unread`)).json()).toEqual({ ok: true, readAt: null });
    expect((await list(member, '?type=club.role_changed')).notifications).toHaveLength(1);
    expect((await list(member, '?category=account')).notifications).toHaveLength(5);
    expect((await list(member, '?q=special')).notifications.map((n) => n.title)).toEqual(['Download 3']);
    expect((await call(member, 'GET', '/api/notifications?type=nope')).statusCode).toBe(400);
    expect((await call(member, 'GET', '/api/notifications?cursor=bad')).statusCode).toBe(400);
    // Pages of two, newest first, with nothing missed or repeated.
    const seen: string[] = [];
    let cursor: string | null = '';
    while (cursor !== null) {
      const page: List = await list(member, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...page.notifications.map((n) => n.title));
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(['Roles', 'Download 4', 'Download 3', 'Download 2', 'Download 1', 'Download 0']);
    // Some, then all.
    l = await list(member);
    expect((await call(member, 'POST', '/api/notifications/read-all', { ids: [l.notifications[1]!.id, l.notifications[2]!.id] })).json()).toEqual({ ok: true, read: 2 });
    expect((await list(member)).unread).toBe(4);
    expect((await call(member, 'POST', '/api/notifications/read-all', { ids: 'x' })).statusCode).toBe(400);
    expect((await call(member, 'POST', '/api/notifications/read-all')).json()).toEqual({ ok: true, read: 4 });
    expect((await list(member)).unread).toBe(0);
  });

  it('lists every type with its category, for filters and settings', async () => {
    const t = (await call(member, 'GET', '/api/notifications/types')).json() as { categories: string[]; types: { type: string; category: string }[] };
    expect(t.categories).toEqual(['moderation', 'clubs', 'sharing', 'shared_modules', 'account']);
    expect(t.types.map((x) => x.type)).toEqual(Object.keys(NOTIFICATION_TYPES));
  });

  describe('desktop tokens', () => {
    it('read, count and mark read with a layouts token; answering needs layouts:write', async () => {
      await call(asker, 'POST', '/api/orgs/arklug/join');
      const read = await issueToken(app, admin.cookie, 'layouts:read');
      const auth = { authorization: `Bearer ${read}` };
      const l = (await app.inject({ method: 'GET', url: '/api/notifications', headers: auth })).json() as List;
      expect(l.notifications).toHaveLength(1);
      expect((await app.inject({ method: 'GET', url: '/api/notifications/count', headers: auth })).json()).toMatchObject({ unread: 1 });
      expect((await app.inject({ method: 'POST', url: `/api/notifications/${l.notifications[0]!.id}/read`, headers: auth })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: `/api/notifications/${l.notifications[0]!.id}/act`, headers: auth, payload: { action: 'accept' } })).statusCode).toBe(403);
      const write = await issueToken(app, admin.cookie, 'layouts:write');
      const res = await app.inject({ method: 'POST', url: `/api/notifications/${l.notifications[0]!.id}/act`, headers: { authorization: `Bearer ${write}` }, payload: { action: 'accept' } });
      expect(res.statusCode).toBe(200);
      expect(await db.select().from(schema.orgMembers).where(and(eq(schema.orgMembers.orgId, orgId), eq(schema.orgMembers.userId, asker.id))).get()).toBeTruthy();
      // A parts-only token gets nothing here.
      const parts = await issueToken(app, admin.cookie, 'parts:read');
      expect((await app.inject({ method: 'GET', url: '/api/notifications', headers: { authorization: `Bearer ${parts}` } })).statusCode).toBe(403);
    });
  });

  describe('invites and hand-overs', () => {
    it('a layout invite to an account reaches it; Accept adds them, Decline removes the invite', async () => {
      const lay = (await call(admin, 'POST', '/api/layouts', { title: 'Yard' })).json() as { id: string };
      expect((await call(admin, 'POST', `/api/layouts/${lay.id}/invites`, { email: 'member@example.com', role: 'editor' })).statusCode).toBe(200);
      const [n] = await ofType(member, 'sharing.layout_invite');
      expect(n).toMatchObject({ title: 'admin invited you to the layout “Yard”', actions: ['accept', 'decline'] });
      // The token stays out of it.
      const tok = (await db.select().from(schema.layoutInvites).get())!.token;
      expect(JSON.stringify(await list(member))).not.toContain(tok);
      expect((await call(member, 'POST', `/api/notifications/${n!.id}/act`, { action: 'accept' })).json()).toMatchObject({ ok: true, outcome: 'accepted' });
      expect(await db.select().from(schema.layoutCollaborators).where(eq(schema.layoutCollaborators.userId, member.id)).get()).toMatchObject({ role: 'editor' });

      // Another invite, declined.
      expect((await call(admin, 'POST', `/api/layouts/${lay.id}/invites`, { email: 'asker@example.com', role: 'viewer' })).statusCode).toBe(200);
      const [m] = await ofType(asker, 'sharing.layout_invite');
      expect((await call(asker, 'POST', `/api/notifications/${m!.id}/act`, { action: 'decline' })).json()).toMatchObject({ ok: true, outcome: 'declined' });
      expect(await db.select().from(schema.layoutInvites).where(eq(schema.layoutInvites.invitedEmail, 'asker@example.com')).get()).toBeFalsy();
      expect(await db.select().from(schema.layoutCollaborators).where(eq(schema.layoutCollaborators.userId, asker.id)).get()).toBeFalsy();
    });

    it('an invite to an address nobody has proven makes no notification', async () => {
      const lay = (await call(admin, 'POST', '/api/layouts', { title: 'Yard' })).json() as { id: string };
      await db.update(schema.users).set({ emailVerified: false, emailProvenAt: null }).where(eq(schema.users.id, member.id));
      await db.update(schema.platformSettings).set({ requireEmailVerification: true });
      await call(admin, 'POST', `/api/layouts/${lay.id}/invites`, { email: 'member@example.com', role: 'viewer' });
      expect(await db.select().from(schema.notifications).where(eq(schema.notifications.userId, member.id)).all()).toHaveLength(0);
    });

    it('a layout offered to someone: Decline keeps it with its owner and tells them', async () => {
      const lay = (await call(admin, 'POST', '/api/layouts', { title: 'Depot' })).json() as { id: string };
      expect((await call(admin, 'POST', `/api/layouts/${lay.id}/transfer`, { recipientEmail: 'member@example.com' })).statusCode).toBe(200);
      const [n] = await ofType(member, 'sharing.transfer_offered');
      expect(n!.title).toMatch(/wants to give you the layout “Depot”/);
      expect((await call(member, 'POST', `/api/notifications/${n!.id}/act`, { action: 'decline' })).statusCode).toBe(200);
      expect((await db.select().from(schema.layouts).where(eq(schema.layouts.id, lay.id)).get())!.ownerUserId).toBe(admin.id);
      expect((await ofType(admin, 'sharing.transfer_declined'))[0]!.title).toMatch(/declined your layout “Depot”/);
    });

    it('a layout offered and accepted changes hands and tells the giver', async () => {
      const lay = (await call(admin, 'POST', '/api/layouts', { title: 'Depot' })).json() as { id: string };
      await call(admin, 'POST', `/api/layouts/${lay.id}/transfer`, { recipientEmail: 'member@example.com' });
      const [n] = await ofType(member, 'sharing.transfer_offered');
      expect((await call(member, 'POST', `/api/notifications/${n!.id}/act`, { action: 'accept' })).statusCode).toBe(200);
      expect((await db.select().from(schema.layouts).where(eq(schema.layouts.id, lay.id)).get())!.ownerUserId).toBe(member.id);
      expect(await ofType(admin, 'sharing.transfer_accepted')).toHaveLength(1);
    });

    it('a club invite to an account can be accepted in the notification', async () => {
      expect((await call(admin, 'POST', '/api/orgs/arklug/invites', { email: 'asker@example.com', role: 'member' })).statusCode).toBe(200);
      const [n] = await ofType(asker, 'club.invite');
      expect(n!.title).toBe('admin invited you to join ArkLUG');
      expect((await call(asker, 'POST', `/api/notifications/${n!.id}/act`, { action: 'accept' })).statusCode).toBe(200);
      expect(await db.select().from(schema.orgMembers).where(and(eq(schema.orgMembers.orgId, orgId), eq(schema.orgMembers.userId, asker.id))).get()).toBeTruthy();
    });
  });

  describe('warnings', () => {
    beforeEach(async () => {
      await db.update(schema.users).set({ isModerator: true }).where(eq(schema.users.id, admin.id));
    });

    it('a warning to a person waits for their own I understand, and the old notices say the same', async () => {
      expect((await call(admin, 'POST', '/api/admin/warnings', { subjectKind: 'user', subjectId: member.id, severity: 'warning', reason: 'Please stop' })).statusCode).toBe(201);
      const l = await list(member);
      expect(l.warnings).toBe(1);
      const [n] = l.notifications;
      expect(n).toMatchObject({ type: 'moderation.warning', title: 'Warning from the site team', body: 'Please stop', actions: ['acknowledge'] });
      // Read is not "I understand".
      await call(member, 'POST', '/api/notifications/read-all');
      expect((await list(member)).warnings).toBe(1);
      expect((await call(member, 'POST', `/api/notifications/${n!.id}/act`, { action: 'accept' })).statusCode).toBe(400);
      expect((await call(member, 'POST', `/api/notifications/${n!.id}/acknowledge`)).json()).toMatchObject({ ok: true, acknowledgedAt: expect.any(Number) });
      expect((await list(member)).warnings).toBe(0);
      const old = (await call(member, 'GET', '/api/notices')).json() as { notices: { id: string; acknowledgedAt: number | null }[] };
      expect(old.notices[0]!.acknowledgedAt).toEqual(expect.any(Number));
      // The admin history keeps when it was acknowledged.
      expect((await db.select().from(schema.warnings).get())!.acknowledgedBy).toBe(member.id);
    });

    it('a warning to a club: each runner acknowledges for themselves; the old route does too', async () => {
      const mod = await loginAs(app, 'mod@example.com');
      await db.update(schema.users).set({ isModerator: true }).where(eq(schema.users.id, mod.id));
      expect((await call(mod, 'POST', '/api/admin/warnings', { subjectKind: 'org', subjectId: orgId, severity: 'final', reason: 'Spam' })).statusCode).toBe(201);
      for (const who of [admin, manager]) expect((await ofType(who, 'moderation.final_warning'))[0]!.title).toBe('Final warning from the site team to your club ArkLUG');
      expect(await ofType(member, 'moderation.final_warning')).toHaveLength(0);
      const w = (await db.select().from(schema.warnings).get())!;
      // The old route (desktop 2.1.8) acknowledges for the admin only.
      expect((await call(admin, 'POST', `/api/notices/${w.id}/acknowledge`)).statusCode).toBe(200);
      expect((await list(admin)).warnings).toBe(0);
      expect((await list(manager)).warnings).toBe(1);
      const theirs = (await call(manager, 'GET', '/api/notices')).json() as { notices: { id: string; acknowledgedAt: number | null }[] };
      expect(theirs.notices.find((x) => x.id === w.id)!.acknowledgedAt).toBeNull();
    });

    it('reading a note is all it asks: the sender’s history shows it acknowledged', async () => {
      await call(admin, 'POST', '/api/admin/warnings', { subjectKind: 'user', subjectId: member.id, severity: 'note', reason: 'FYI' });
      const [n] = await ofType(member, 'moderation.note');
      expect(n!.actions).toEqual([]);
      await call(member, 'POST', `/api/notifications/${n!.id}/read`);
      expect((await db.select().from(schema.warnings).get())!.acknowledgedBy).toBe(member.id);
      expect((await ofType(member, 'moderation.note'))[0]).toMatchObject({ outcome: 'acknowledged' });
    });

    it('GET /api/notices keeps its shape (desktop 2.1.8 and older)', async () => {
      await call(admin, 'POST', '/api/admin/warnings', { subjectKind: 'user', subjectId: member.id, severity: 'note', reason: 'Just so you know', link: '/editor/x' });
      const body = (await call(member, 'GET', '/api/notices')).json() as { notices: Record<string, unknown>[] };
      expect(Object.keys(body)).toEqual(['notices']);
      expect(Object.keys(body.notices[0]!).sort()).toEqual(['acknowledgedAt', 'club', 'createdAt', 'id', 'issuedBy', 'link', 'reason', 'scope', 'severity', 'to'].sort());
      expect(body.notices[0]).toMatchObject({ severity: 'note', reason: 'Just so you know', link: '/editor/x', scope: 'site', issuedBy: null, club: null, acknowledgedAt: null, to: { kind: 'user', id: member.id } });
      expect((await call(member, 'POST', '/api/notices/acknowledge-all')).json()).toMatchObject({ ok: true, acknowledged: [body.notices[0]!.id] });
      expect((await list(member)).notifications[0]).toMatchObject({ type: 'moderation.note', doneAt: expect.any(Number) });
    });
  });

  it('erasing an account takes its notifications and the ones naming it', async () => {
    await call(asker, 'POST', '/api/orgs/arklug/join');
    await notify({ type: 'account.export_ready', to: [asker.id], title: 'Ready' });
    expect(await db.select().from(schema.notifications).where(eq(schema.notifications.actorUserId, asker.id)).all()).toHaveLength(2);
    await eraseUser(asker.id, 'self', null);
    expect(await db.select().from(schema.notifications).where(eq(schema.notifications.userId, asker.id)).all()).toHaveLength(0);
    expect(await db.select().from(schema.notifications).where(eq(schema.notifications.actorUserId, asker.id)).all()).toHaveLength(0);
  });

  it('the clean-up clears notifications read over 180 days ago, never unread ones or warnings', async () => {
    const old = new Date(Date.now() - 181 * 86_400_000);
    const recent = new Date(Date.now() - 10 * 86_400_000);
    const mk = async (type: keyof typeof NOTIFICATION_TYPES, readAt: Date | null) => {
      const [r] = await notify({ type, to: [member.id], title: type });
      if (readAt) await db.update(schema.notifications).set({ readAt }).where(eq(schema.notifications.id, r!.id));
      return r!.id;
    };
    const oldRead = await mk('account.export_ready', old);
    const recentRead = await mk('account.export_ready', recent);
    const unread = await mk('account.export_ready', null);
    const oldWarning = await mk('moderation.warning', old);
    const res = await purgeRetention();
    expect(res.notifications).toBe(1);
    const left = (await db.select({ id: schema.notifications.id }).from(schema.notifications).all()).map((r) => r.id);
    expect(left).not.toContain(oldRead);
    expect(left).toEqual(expect.arrayContaining([recentRead, unread, oldWarning]));
  });
});
