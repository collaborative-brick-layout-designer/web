// Every club route × every club permission. Each route under
// /api/orgs/:slug has an entry here naming the permission(s) that open it
// (any one of them), or 'admin' (only the Admin role), or 'member' (anyone
// in the club), or 'anyone' (signed-in people outside it too). A new club
// route without an entry fails the first test.
//
// For each entry, on the probe world (test/probeWorld.ts) with the club
// trusted (so its review routes answer):
//   - a member whose only role gives just that permission is let through
//     (anything but a 403);
//   - a member whose role gives every permission except those is refused
//     with a 403 (for 'admin': a role with every permission that isn't
//     Admin is refused).
// Plus the routes that add things to a club from outside /api/orgs.

import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachUser } from '../auth/cookie.js';
import { registerApiRoutes } from '../routes/all.js';
import { closeAll } from '../events/hub.js';
import { db, loginAs, schema } from '../test/helpers.js';
import { concreteUrl, seedProbeWorld, type ProbeWorld } from '../test/probeWorld.js';
import { CLUB_PERMISSIONS, ensureClubRoles, setMemberRoles, type ClubPermission } from '../access/clubPermissions.js';

type Need = ClubPermission[] | 'admin' | 'member' | 'anyone';

/** The permission-to-route mapping (also listed in the PR). */
export const CLUB_ROUTE_PERMISSIONS: Record<string, Need> = {
  'GET /api/orgs/:slug': 'member',
  'PATCH /api/orgs/:slug': 'admin',
  'DELETE /api/orgs/:slug': 'admin',
  'PUT /api/orgs/:slug/logo': 'admin',
  'DELETE /api/orgs/:slug/logo': 'admin',
  'GET /api/orgs/:slug/logo': 'anyone',
  'POST /api/orgs/:slug/hand-over': 'admin',
  'GET /api/orgs/:slug/members': 'member',
  'POST /api/orgs/:slug/invites': ['invite', 'manage_members'],
  'GET /api/orgs/:slug/user-search': ['invite', 'manage_members'],
  'DELETE /api/orgs/:slug/invites/:inviteId': ['invite', 'manage_members'],
  'POST /api/orgs/:slug/invites/:inviteId/resend': ['invite', 'manage_members'],
  'PATCH /api/orgs/:slug/members/:userId': ['manage_members'],
  'DELETE /api/orgs/:slug/members/:userId': ['invite', 'manage_members'],
  'GET /api/orgs/:slug/roles': 'member',
  'POST /api/orgs/:slug/roles': 'admin',
  'PATCH /api/orgs/:slug/roles/:roleId': 'admin',
  'DELETE /api/orgs/:slug/roles/:roleId': 'admin',
  'GET /api/orgs/:slug/layouts': 'member',
  'GET /api/orgs/:slug/part-libraries': 'member',
  'PUT /api/orgs/:slug/part-libraries/:libraryId': 'admin',
  'DELETE /api/orgs/:slug/part-libraries/:libraryId': 'admin',
  'GET /api/orgs/:slug/summary': 'anyone',
  'POST /api/orgs/:slug/join': 'anyone',
  'DELETE /api/orgs/:slug/join': 'anyone',
  'GET /api/orgs/:slug/join-requests': ['invite', 'manage_members'],
  'POST /api/orgs/:slug/join-requests/:id/approve': ['invite', 'manage_members'],
  'POST /api/orgs/:slug/join-requests/:id/decline': ['invite', 'manage_members'],
  // Partner clubs and module offers: Admins and Managers (whoever looks after the club's things).
  'GET /api/orgs/:slug/partners': 'member',
  'POST /api/orgs/:slug/partners': ['delete_items'],
  'DELETE /api/orgs/:slug/partners/:orgId': 'admin',
  'DELETE /api/orgs/:slug/partner-requests/:id': ['delete_items'],
  'POST /api/orgs/:slug/partner-requests/:id/accept': ['delete_items'],
  'POST /api/orgs/:slug/partner-requests/:id/decline': ['delete_items'],
  'POST /api/orgs/:slug/module-offers/:id/accept': ['delete_items'],
  'POST /api/orgs/:slug/module-offers/:id/decline': ['delete_items'],
  'GET /api/orgs/:slug/review': ['send_catalog'],
  'POST /api/orgs/:slug/review/versions/:id/approve': ['send_catalog'],
  'POST /api/orgs/:slug/review/versions/:id/decline': ['send_catalog'],
  'POST /api/orgs/:slug/review/items/:id/cover/approve': ['send_catalog'],
  'POST /api/orgs/:slug/review/items/:id/cover/decline': ['send_catalog'],
  'POST /api/orgs/:slug/review/items/:id/unpublish': ['send_catalog'],
  'POST /api/orgs/:slug/review/collections/:id/approve': ['send_catalog'],
  'POST /api/orgs/:slug/review/collections/:id/decline': ['send_catalog'],
  'POST /api/orgs/:slug/review/collections/:id/unpublish': ['send_catalog'],
  'GET /api/orgs/:slug/audit': ['invite', 'manage_members'],
  'POST /api/orgs/:slug/warnings': ['invite', 'manage_members'],
  'GET /api/orgs/:slug/warnings': ['invite', 'manage_members'],
  'GET /api/orgs/:slug/deletion': 'admin',
  'GET /api/orgs/:slug/exports': ['export_data'],
  'POST /api/orgs/:slug/exports': ['export_data'],
  'POST /api/orgs/:slug/move-all': 'admin',
  'POST /api/orgs/:slug/restore': 'admin',
};

/** Adding things to the club from the item routes: the body names the club. */
const ADDS: { key: string; need: ClubPermission[]; payload: (w: ProbeWorld) => Record<string, unknown>; url?: (w: ProbeWorld) => string }[] = [
  { key: 'POST /api/layouts', need: ['start_layouts'], payload: () => ({ title: 'Club yard', orgSlug: 'olive-club' }) },
  { key: 'POST /api/modules', need: ['edit_modules'], payload: () => ({ title: 'Club module', orgSlug: 'olive-club' }) },
  { key: 'POST /api/venues', need: ['start_layouts', 'manage_venues'], payload: () => ({ name: 'Club hall', orgSlug: 'olive-club', data: { name: 'Club hall', enabled: true, edges: [], obstacles: [] } }) },
  { key: 'POST /api/layouts/:id/copy', need: ['start_layouts'], payload: () => ({ orgSlug: 'olive-club' }), url: (w) => `/api/layouts/${w.ids.clubLayout}/copy` },
];

// Refused: 403; a route about a club being deleted answers 404 to everyone
// while it isn't, so for 'admin' routes a 404 counts as refused too.
const isRefusal = (status: number) => status === 403;
const isAdminRefusal = (status: number) => status === 403 || status === 404;

describe('club permissions × club routes', () => {
  let app: FastifyInstance;
  let w: ProbeWorld;
  let tester: { cookie: string; id: string };
  let weak: { id: string };
  const routes: { key: string; method: string; url: string }[] = [];

  beforeAll(async () => {
    app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
    await app.register(cookie);
    await app.register(fastifyMultipart);
    app.addHook('preHandler', attachUser);
    app.addHook('onRoute', (r) => {
      for (const m of Array.isArray(r.method) ? r.method : [r.method]) if (m !== 'HEAD') routes.push({ key: `${m} ${r.url}`, method: m, url: r.url });
    });
    await registerApiRoutes(app);
    await app.ready();
    w = await seedProbeWorld(app);
    const club = w.ids.club!;
    await db.update(schema.orgs).set({ trusted: true }).where(eq(schema.orgs.id, club));
    tester = await loginAs(app, 'tess@example.com');
    const weakling = await loginAs(app, 'weak@example.com');
    weak = weakling;
    const now = new Date();
    await db.insert(schema.orgMembers).values({ orgId: club, userId: tester.id, role: 'member', joinedAt: now });
    await db.insert(schema.orgMembers).values({ orgId: club, userId: weak.id, role: 'member', joinedAt: now });
    await ensureClubRoles(club);
    await setMemberRoles(club, weak.id, [`${club}:viewer`]);
    // The pending invite gives the Viewer role, so "invite people" alone may handle it.
    await db.update(schema.orgInvites).set({ roleId: `${club}:viewer` }).where(eq(schema.orgInvites.id, w.ids.orgInvite!));
    const clubLayout = randomUUID();
    await db.insert(schema.layouts).values({ id: clubLayout, title: 'Club yard', ownerOrgId: club, createdBy: w.olive.id, createdAt: now, updatedAt: now, docSnapshot: (await db.select().from(schema.layouts).where(eq(schema.layouts.id, w.ids.layout!)).get())!.docSnapshot });
    w.ids.clubLayout = clubLayout;
  });
  afterAll(async () => {
    closeAll();
    await app.close();
  });

  /** Gives the tester exactly one custom role with these permissions (or the Admin role). */
  async function holding(perms: ClubPermission[] | 'admin') {
    const club = w.ids.club!;
    if (perms === 'admin') return setMemberRoles(club, tester.id, [`${club}:admin`]);
    const id = randomUUID();
    await db.insert(schema.clubRoles).values({ id, orgId: club, key: null, name: `Probe ${id.slice(0, 6)}`, permissions: JSON.stringify(perms), position: 99, createdAt: new Date() });
    await setMemberRoles(club, tester.id, [id]);
  }

  async function call(key: string, url: string, payload?: Record<string, unknown>) {
    const method = key.split(' ')[0]!;
    const sendsBody = method !== 'GET' && method !== 'DELETE';
    return app.inject({ method: method as 'GET', url, headers: { cookie: tester.cookie }, ...(sendsBody ? { payload: payload ?? {} } : {}) } as InjectOptions & { method: 'GET' });
  }

  const urlOf = (r: { url: string }) => {
    const u = concreteUrl(r.url, w);
    // Remove or warn the Viewer-only member, not the club's admin.
    return r.url.endsWith('/members/:userId') ? u.replace(w.olive.id, weak.id) : u;
  };

  it('every club route has a permission (a new club route needs its entry)', () => {
    const club = routes.filter((r) => r.url.startsWith('/api/orgs/:slug'));
    expect(club.length).toBeGreaterThan(30);
    expect(club.map((r) => r.key).filter((k) => !(k in CLUB_ROUTE_PERMISSIONS))).toEqual([]);
    expect(Object.keys(CLUB_ROUTE_PERMISSIONS).filter((k) => !club.some((r) => r.key === k))).toEqual([]);
  });

  it('a role with just the permission is let through; one with everything else is refused', async () => {
    const wrong: string[] = [];
    for (const r of routes.filter((x) => x.key in CLUB_ROUTE_PERMISSIONS)) {
      const need = CLUB_ROUTE_PERMISSIONS[r.key]!;
      if (need === 'member' || need === 'anyone') {
        await holding(['view_items']);
        const res = await call(r.key, urlOf(r));
        if (isRefusal(res.statusCode)) wrong.push(`${r.key}: a viewer got ${res.statusCode}`);
        continue;
      }
      if (need === 'admin') {
        await holding([...CLUB_PERMISSIONS]);
        const res = await call(r.key, urlOf(r));
        if (!isAdminRefusal(res.statusCode)) wrong.push(`${r.key}: every permission but not Admin got ${res.statusCode}`);
        await holding('admin');
        const ok = await call(r.key, urlOf(r));
        if (isRefusal(ok.statusCode)) wrong.push(`${r.key}: Admin got ${ok.statusCode} ${ok.body.slice(0, 80)}`);
        continue;
      }
      await holding(CLUB_PERMISSIONS.filter((p) => !need.includes(p)));
      const refused = await call(r.key, urlOf(r));
      if (!isRefusal(refused.statusCode)) wrong.push(`${r.key}: without ${need.join('/')} got ${refused.statusCode}`);
      await holding(['view_items', need[0]!]);
      const ok = await call(r.key, urlOf(r));
      if (isRefusal(ok.statusCode)) wrong.push(`${r.key}: with ${need[0]} got ${ok.statusCode} ${ok.body.slice(0, 80)}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it('adding to the club from the item routes asks the adding permission, and says which', async () => {
    const wrong: string[] = [];
    for (const a of ADDS) {
      const url = a.url ? a.url(w) : a.key.split(' ')[1]!;
      await holding(CLUB_PERMISSIONS.filter((p) => !a.need.includes(p)));
      const refused = await call(a.key, url, a.payload(w));
      if (refused.statusCode !== 403 || refused.json().permission !== a.need[0]) wrong.push(`${a.key}: without ${a.need.join('/')} got ${refused.statusCode} ${refused.body.slice(0, 80)}`);
      await holding(['view_items', a.need[0]!]);
      const ok = await call(a.key, url, a.payload(w));
      if (ok.statusCode >= 300) wrong.push(`${a.key}: with ${a.need[0]} got ${ok.statusCode} ${ok.body.slice(0, 80)}`);
    }
    expect(wrong).toEqual([]);
  });
});
