// Club-wide notices go by permission, not by the fixed Admin and Manager
// roles (access/clubNotices.ts). One club, with:
//   ann  Admin (hears everything)
//   ben  Manager, whose role the club changed so it no longer invites people
//   cy   "Door crew": invites people only
//   dee  "Keepers": deletes club items only
//   eve  Manager + Door crew + Keepers (several roles that qualify: one notice)
//   fay  Member
// Each notice type: who gets it, and nobody twice.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Notification emails (notifications/delivery.ts), with a site that can send them.
const mail = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; items: { title: string; body: string; link: string | null }[] }> }));
vi.mock('../../email/sendNotification.js', async (orig) => ({
  ...(await orig<typeof import('../../email/sendNotification.js')>()),
  sendNotificationEmail: vi.fn(async (a: (typeof mail.sent)[number]) => {
    mail.sent.push(a);
    return true;
  }),
}));
vi.mock('../../email/transporter.js', async (orig) => ({
  ...(await orig<typeof import('../../email/transporter.js')>()),
  emailConfigured: vi.fn(async () => true),
}));

import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { registerApiRoutes } from '../all.js';
import { closeAll } from '../../events/hub.js';
import { clubRunners, postClubNote, recipientsOf } from '../warnings.js';
import { CLUB_NOTICE_PERMISSIONS, clubAudience, clubsHearing } from '../../access/clubNotices.js';
import { sendDue } from '../../notifications/delivery.js';

type Who = { cookie: string; id: string; email: string };

describe('club notices go by permission', () => {
  let app: FastifyInstance;
  let ann: Who, ben: Who, cy: Who, dee: Who, eve: Who, fay: Who, gus: Who, site: Who;
  let orgId: string;
  const sorted = (ids: string[]) => [...ids].sort();

  const as = (who: Who, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, headers: { cookie: who.cookie }, ...(payload ? { payload } : {}) });
  const login = async (email: string): Promise<Who> => ({ ...(await loginAs(app, email)), email });

  beforeEach(async () => {
    resetDb();
    mail.sent.length = 0;
    app = Fastify({ logger: false });
    await app.register(cookie);
    app.addHook('preHandler', attachUser);
    await registerApiRoutes(app);
    ann = await login('ann@x.com');
    ben = await login('ben@x.com');
    cy = await login('cy@x.com');
    dee = await login('dee@x.com');
    eve = await login('eve@x.com');
    fay = await login('fay@x.com');
    gus = await login('gus@x.com');
    site = await login('site@x.com');
    await db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.id, site.id));
    const made = await as(ann, 'POST', '/api/orgs', { name: 'Rail Club' });
    expect(made.statusCode, made.body).toBe(201);
    orgId = made.json().id as string;
    await as(ann, 'PATCH', '/api/orgs/rail-club', { joinPolicy: 'request', listed: true });
    for (const u of [ben, cy, dee, eve, fay]) await db.insert(schema.orgMembers).values({ orgId, userId: u.id, role: 'member', joinedAt: new Date() });
    const role = async (name: string, permissions: string[]) => {
      const res = await as(ann, 'POST', '/api/orgs/rail-club/roles', { name, permissions });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().id as string;
    };
    const door = await role('Door crew', ['invite']);
    const keepers = await role('Keepers', ['delete_items']);
    // The club's Manager role no longer invites people.
    const manager = (await as(ann, 'GET', '/api/orgs/rail-club/roles')).json().roles.find((r: { key: string }) => r.key === 'manager');
    const stripped = await as(ann, 'PATCH', `/api/orgs/rail-club/roles/${orgId}:manager`, {
      permissions: (manager.permissions as string[]).filter((p) => p !== 'invite' && p !== 'delete_items'),
    });
    expect(stripped.statusCode, stripped.body).toBe(200);
    const give = async (who: Who, roleIds: string[]) => expect((await as(ann, 'PATCH', `/api/orgs/rail-club/members/${who.id}`, { roleIds })).statusCode).toBe(200);
    await give(ben, [`${orgId}:manager`]);
    await give(cy, [door]);
    await give(dee, [keepers]);
    await give(eve, [`${orgId}:manager`, door, keepers]);
  });

  afterEach(async () => {
    closeAll();
    await app.close();
  });

  it('maps each notice to its permissions', () => {
    expect(CLUB_NOTICE_PERMISSIONS).toEqual({
      join_request: ['invite', 'manage_members'],
      club_warning: ['invite', 'manage_members'],
      member_warning: ['invite', 'manage_members'],
      club_note: ['delete_items'],
    });
  });

  it('a request to join emails the people whose roles let people in, each once', async () => {
    const asked = await as(gus, 'POST', '/api/orgs/rail-club/join', { message: 'I build bridges' });
    expect(asked.json()).toMatchObject({ status: 'requested' });
    await sendDue();
    await vi.waitFor(() => expect(mail.sent).toHaveLength(3));
    expect(sorted(mail.sent.map((m) => m.to))).toEqual(sorted([ann.email, cy.email, eve.email]));
    const one = mail.sent[0]!;
    expect(one.subject).toBe('gus asked to join Rail Club');
    expect(one.items[0]).toEqual({ title: 'gus asked to join Rail Club', body: 'Their note: “I build bridges”', link: '/orgs/rail-club/admin?tab=people' });
    // Asking again sends nothing more.
    await as(gus, 'POST', '/api/orgs/rail-club/join', {});
    await sendDue();
    await new Promise((r) => setTimeout(r, 50));
    expect(mail.sent).toHaveLength(3);
  });

  it('the join badge counts for the same people', async () => {
    await as(gus, 'POST', '/api/orgs/rail-club/join', {});
    const count = async (who: Who) => (await as(who, 'GET', '/api/join-requests/count')).json().count as number;
    expect(await count(ann)).toBe(1);
    expect(await count(cy)).toBe(1);
    expect(await count(eve)).toBe(1);
    expect(await count(ben)).toBe(0);
    expect(await count(dee)).toBe(0);
    expect(await count(fay)).toBe(0);
    expect((await as(cy, 'GET', '/api/orgs/rail-club')).json().pendingRequests).toBe(1);
    expect((await as(ben, 'GET', '/api/orgs/rail-club')).json().pendingRequests).toBeUndefined();
  });

  it('someone who turned off the join-request emails gets none, and can turn them back on', async () => {
    const off = await as(cy, 'PUT', '/api/me/preferences', { prefs: { emailJoinRequests: false } });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().prefs.emailJoinRequests).toBe(false);
    expect((await as(fay, 'GET', '/api/me/preferences')).json().prefs.emailJoinRequests).toBe(true);
    expect((await as(cy, 'PUT', '/api/me/preferences', { prefs: { emailJoinRequests: 'no' } })).statusCode).toBe(400);
    // The old switch (desktop 2.1.8 and older) is now the notification setting for those types.
    const settings = (await as(cy, 'GET', '/api/me/notification-settings')).json() as { types: { type: string; email: string }[] };
    expect(settings.types.filter((t) => ['club.join_request', 'club.partner_request', 'club.offer_received'].includes(t.type)).map((t) => t.email)).toEqual(['off', 'off', 'off']);
    await as(gus, 'POST', '/api/orgs/rail-club/join', {});
    await sendDue();
    await vi.waitFor(() => expect(mail.sent).toHaveLength(2));
    expect(sorted(mail.sent.map((m) => m.to))).toEqual(sorted([ann.email, eve.email]));
    // On again.
    await as(cy, 'PUT', '/api/me/preferences', { prefs: { emailJoinRequests: true } });
    expect(((await as(cy, 'GET', '/api/me/notification-settings')).json() as { types: { type: string; email: string }[] }).types.find((t) => t.type === 'club.join_request')!.email).toBe('now');
  });

  it('a site warning to the club reaches the people who run its members, with one email each', async () => {
    const sent = await as(site, 'POST', '/api/admin/warnings', { subjectKind: 'org', subjectId: orgId, severity: 'warning', reason: 'Your club is over its storage limit' });
    expect(sent.statusCode, sent.body).toBe(201);
    const id = sent.json().id as string;
    await sendDue();
    expect(sorted(mail.sent.map((m) => m.to))).toEqual(sorted([ann.email, cy.email, eve.email]));
    const sees = async (who: Who) => ((await as(who, 'GET', '/api/notices')).json().notices as Array<{ id: string }>).some((n) => n.id === id);
    expect(await sees(ann)).toBe(true);
    expect(await sees(cy)).toBe(true);
    expect(await sees(eve)).toBe(true);
    expect(await sees(ben)).toBe(false);
    expect(await sees(dee)).toBe(false);
    expect(await sees(fay)).toBe(false);
    // Eve's three roles: still one notice.
    expect(((await as(eve, 'GET', '/api/notices')).json().notices as Array<{ id: string }>).filter((n) => n.id === id)).toHaveLength(1);
    // Only the people who got it say they understand it.
    expect((await as(ben, 'POST', `/api/notices/${id}/acknowledge`)).statusCode).toBe(404);
    expect((await as(cy, 'POST', `/api/notices/${id}/acknowledge`)).statusCode).toBe(200);
  });

  it('a note about the club’s things reaches whoever looks after them, not who invites', async () => {
    const id = await postClubNote(orgId, fay.id, 'Fay took back the module “Bridge” they made.', null);
    const sees = async (who: Who) => ((await as(who, 'GET', '/api/notices')).json().notices as Array<{ id: string }>).some((n) => n.id === id);
    expect(await sees(ann)).toBe(true);
    expect(await sees(dee)).toBe(true);
    expect(await sees(eve)).toBe(true);
    expect(await sees(cy)).toBe(false);
    expect(await sees(ben)).toBe(false);
    expect(await sees(fay)).toBe(false);
    const row = (await db.select().from(schema.warnings).where(eq(schema.warnings.id, id)).get())!;
    expect(sorted(await recipientsOf(row))).toEqual(sorted([ann.id, dee.id, eve.id]));
  });

  it('a club warning to a member reaches the people who see the club’s warnings', async () => {
    expect(sorted(await clubRunners(orgId))).toEqual(sorted([ann.id, cy.id, eve.id]));
    const sent = await as(ann, 'POST', '/api/orgs/rail-club/warnings', { userId: fay.id, severity: 'warning', reason: 'Please tidy the yard' });
    expect(sent.statusCode, sent.body).toBe(201);
    // Fay gets it; the copy for the club is its Warnings list, which Ben can't open.
    await sendDue();
    expect(mail.sent.map((m) => m.to)).toEqual([fay.email]);
    expect((await as(ben, 'GET', '/api/orgs/rail-club/warnings')).statusCode).toBe(403);
    expect((await as(eve, 'GET', '/api/orgs/rail-club/warnings')).json().warnings).toHaveLength(1);
  });

  it('the Admin role hears everything, even when it holds nothing else', async () => {
    for (const notice of ['join_request', 'club_warning', 'member_warning', 'club_note'] as const) {
      expect(await clubAudience(orgId, notice)).toContain(ann.id);
      expect(await clubsHearing(ann.id, notice)).toEqual([orgId]);
      expect(await clubsHearing(fay.id, notice)).toEqual([]);
    }
  });
});
