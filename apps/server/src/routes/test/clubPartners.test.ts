// Partner clubs and one-off module offers (docs/shared-modules.md, section 11;
// routes/clubPartners.ts, routes/moduleShares.ts, clubPartners/partners.ts):
// asking, accepting, declining and taking back; partners sharing modules
// both ways with no accept per module; a module offered one off, accepted
// or declined; ending a partnership (its modules stop, one-off shares stay);
// a club deleted; who may do each; what a club that isn't listed shows.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type * as Y from 'yjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultLayoutDoc, encodeDoc } from '@cld/ydoc';
import { attachUser } from '../../auth/cookie.js';
import { registerApiRoutes } from '../all.js';
import { closeAll } from '../../events/hub.js';
import { invalidateLimitCaches } from '../../limits/limits.js';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { docHub } from '../../ws/docHub.js';
import { forgetLayout, syncLayoutSharedModules } from '../../sharedModules/placed.js';
import { eraseClub } from '../../privacy/clubDeletion.js';
import { collectOrgData, collectUserData } from '../../privacy/collect.js';
import { contents, place, type Part } from '../../test/sharedWorld.js';
import { ASK_AGAIN_AFTER_MS } from '../../clubPartners/partners.js';

type Who = { cookie: string; id: string };
const V1: Part[] = [{ pn: 'a.1', x: 0, y: 0 }, { pn: 'b.1', x: 4, y: 0 }];

describe('partner clubs and module offers', () => {
  let app: FastifyInstance;
  const open: string[] = [];
  beforeAll(async () => {
    app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
    await app.register(cookie);
    await app.register(fastifyMultipart);
    app.addHook('preHandler', attachUser);
    await registerApiRoutes(app);
    await app.ready();
  });
  afterAll(async () => {
    closeAll();
    await app.close();
  });
  beforeEach(async () => {
    await docHub.closeMany(open.splice(0));
    resetDb();
    forgetLayout();
    invalidateLimitCaches();
  });

  const call = (who: Who | null, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: who ? { cookie: who.cookie } : {}, ...(payload ? { payload } : {}) });
  async function club(admin: Who, name: string, opts: { listed?: boolean; managers?: Who[]; members?: Who[] } = {}) {
    const { id, slug } = (await call(admin, 'POST', '/api/orgs', { name })).json() as { id: string; slug: string };
    await db.update(schema.orgs).set({ listed: opts.listed ?? true }).where(eq(schema.orgs.id, id));
    for (const m of opts.managers ?? []) await db.insert(schema.orgMembers).values({ orgId: id, userId: m.id, role: 'manager', joinedAt: new Date() });
    for (const m of opts.members ?? []) await db.insert(schema.orgMembers).values({ orgId: id, userId: m.id, role: 'member', joinedAt: new Date() });
    return { id, slug, name };
  }
  async function clubModule(who: Who, orgSlug: string, title: string): Promise<string> {
    const id = ((await call(who, 'POST', '/api/modules', { title, orgSlug })).json() as { id: string }).id;
    const r = await app.inject({ method: 'PUT', url: `/api/modules/${id}/snapshot`, headers: { cookie: who.cookie, 'content-type': 'application/octet-stream' }, payload: contents(V1) });
    expect(r.statusCode).toBe(200);
    return id;
  }
  async function layout(owner: { ownerUserId?: string; ownerOrgId?: string }, createdBy: string, build: (doc: Y.Doc) => void): Promise<string> {
    const id = randomUUID();
    const doc = createDefaultLayoutDoc();
    build(doc);
    const now = new Date();
    await db.insert(schema.layouts).values({ id, title: 'Show plan', ...owner, createdBy, createdAt: now, updatedAt: now, docSnapshot: Buffer.from(encodeDoc(doc)) });
    await syncLayoutSharedModules(id, doc);
    doc.destroy();
    open.push(id);
    return id;
  }
  const placedState = async (layoutId: string) =>
    (await db.select().from(schema.layoutSharedModules).where(eq(schema.layoutSharedModules.layoutId, layoutId)).all()).map((r) => r.state);
  type Partners = {
    canManage: boolean;
    canEnd: boolean;
    partners: { id: string; name: string; modulesIn: number; modulesOut: number }[];
    requestsIn?: { id: string; club: { name: string } }[];
    requestsOut?: { id: string; club: { name: string | null; slug: string }; state: string }[];
    offersIn?: { id: string; module: { id: string; title: string }; from: { name: string } }[];
  };
  const partners = async (who: Who, slug: string) => (await call(who, 'GET', `/api/orgs/${slug}/partners`)).json() as Partners;
  const notes = async (orgId: string) => (await db.select().from(schema.warnings).where(eq(schema.warnings.subjectOrgId, orgId)).all()).map((w) => w.reason);

  /** Train Club (Tina admin, Max manager, Pat member) and Riverside LUG (Rita admin, Mo manager, Lou member). */
  async function world() {
    const tina = await loginAs(app, 'tina@example.com');
    const max = await loginAs(app, 'max@example.com');
    const pat = await loginAs(app, 'pat@example.com');
    const rita = await loginAs(app, 'rita@example.com');
    const mo = await loginAs(app, 'mo@example.com');
    const lou = await loginAs(app, 'lou@example.com');
    const eve = await loginAs(app, 'eve@example.com');
    const train = await club(tina, 'Train Club', { managers: [max], members: [pat] });
    const lug = await club(rita, 'Riverside LUG', { managers: [mo], members: [lou] });
    return { tina, max, pat, rita, mo, lou, eve, train, lug };
  }
  async function partnered() {
    const w = await world();
    const asked = await call(w.max, 'POST', `/api/orgs/${w.train.slug}/partners`, { slug: w.lug.slug });
    expect(asked.statusCode).toBe(201);
    const id = (asked.json() as { id: string }).id;
    expect((await call(w.mo, 'POST', `/api/orgs/${w.lug.slug}/partner-requests/${id}/accept`)).statusCode).toBe(200);
    return w;
  }

  it('a request is sent, seen by the other club’s Admins and Managers, and accepted', async () => {
    const w = await world();
    const asked = await call(w.max, 'POST', `/api/orgs/${w.train.slug}/partners`, { slug: `https://example.org/orgs/${w.lug.slug}` });
    expect(asked.statusCode).toBe(201);
    expect(asked.json()).toMatchObject({ status: 'requested', club: { name: 'Riverside LUG' } });
    // Asking again changes nothing.
    expect((await call(w.tina, 'POST', `/api/orgs/${w.train.slug}/partners`, { slug: w.lug.slug })).json()).toMatchObject({ status: 'requested', already: true });
    const theirs = await partners(w.mo, w.lug.slug);
    expect(theirs.requestsIn).toEqual([expect.objectContaining({ club: expect.objectContaining({ name: 'Train Club', slug: w.train.slug }) })]);
    expect((await partners(w.tina, w.train.slug)).requestsOut).toEqual([expect.objectContaining({ state: 'pending', club: expect.objectContaining({ name: 'Riverside LUG' }) })]);
    // The Clubs badge: one waits for Riverside LUG's Admins and Managers, none for its members.
    expect((await call(w.rita, 'GET', '/api/club-requests/count')).json()).toEqual({ count: 1, clubs: [{ slug: w.lug.slug, name: 'Riverside LUG', count: 1 }] });
    expect((await call(w.lou, 'GET', '/api/club-requests/count')).json()).toEqual({ count: 0, clubs: [] });
    expect((await call(w.rita, 'GET', `/api/orgs/${w.lug.slug}`)).json()).toMatchObject({ pendingPartners: 1 });
    expect((await call(w.lou, 'GET', `/api/orgs/${w.lug.slug}`)).json()).not.toHaveProperty('pendingPartners');
    const id = theirs.requestsIn![0]!.id;
    expect((await call(w.mo, 'POST', `/api/orgs/${w.lug.slug}/partner-requests/${id}/accept`)).json()).toMatchObject({ status: 'partners' });
    for (const [who, slug, other] of [[w.pat, w.train.slug, 'Riverside LUG'], [w.lou, w.lug.slug, 'Train Club']] as const) {
      const p = await partners(who, slug);
      expect(p.partners.map((x) => x.name)).toEqual([other]);
      // Plain members see the partners, not the requests.
      expect(p).not.toHaveProperty('requestsIn');
      expect(p.canManage).toBe(false);
    }
    expect(await notes(w.train.id)).toEqual([expect.stringContaining('Riverside LUG accepted your club’s partner request')]);
  });

  it('offers still waiting when the clubs become partners turn into partner shares, both ways, and the receiving Admins and Managers are told', async () => {
    const w = await world();
    const crane = await clubModule(w.tina, w.train.slug, 'Harbor crane');
    const ferry = await clubModule(w.rita, w.lug.slug, 'Ferry dock');
    expect((await call(w.max, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: w.lug.slug })).statusCode).toBe(202);
    expect((await call(w.mo, 'POST', `/api/modules/${ferry}/club-shares`, { orgSlug: w.train.slug })).statusCode).toBe(202);
    expect((await partners(w.mo, w.lug.slug)).offersIn).toHaveLength(1);
    // Not shared yet.
    expect(((await call(w.lou, 'GET', '/api/modules?owner=shared')).json() as { modules: unknown[] }).modules).toEqual([]);
    const asked = await call(w.max, 'POST', `/api/orgs/${w.train.slug}/partners`, { slug: w.lug.slug });
    const id = (asked.json() as { id: string }).id;
    expect((await call(w.mo, 'POST', `/api/orgs/${w.lug.slug}/partner-requests/${id}/accept`)).statusCode).toBe(200);
    // No offer waits any more, and both modules are shared as partner shares.
    expect((await partners(w.mo, w.lug.slug)).offersIn).toEqual([]);
    expect((await partners(w.tina, w.train.slug)).offersIn).toEqual([]);
    expect(await db.select().from(schema.moduleClubOffers).all()).toEqual([]);
    expect((await call(w.max, 'GET', `/api/modules/${crane}/shares`)).json()).toMatchObject({ offers: [], clubs: [expect.objectContaining({ name: 'Riverside LUG', via: 'partner' })] });
    expect((await call(w.mo, 'GET', `/api/modules/${ferry}/shares`)).json()).toMatchObject({ offers: [], clubs: [expect.objectContaining({ name: 'Train Club', via: 'partner' })] });
    expect(((await call(w.lou, 'GET', '/api/modules?owner=shared')).json() as { modules: { id: string }[] }).modules.map((m) => m.id)).toEqual([crane]);
    expect(((await call(w.pat, 'GET', '/api/modules?owner=shared')).json() as { modules: { id: string }[] }).modules.map((m) => m.id)).toEqual([ferry]);
    // Each receiving club's Admins and Managers are told.
    expect(await notes(w.lug.id)).toEqual([expect.stringContaining('Harbor crane')]);
    expect((await notes(w.train.id)).filter((t) => t.includes('Ferry dock'))).toHaveLength(1);
    // Ending the partnership stops them like any partner share.
    expect((await call(w.tina, 'DELETE', `/api/orgs/${w.train.slug}/partners/${w.lug.id}`)).statusCode).toBe(200);
    expect(((await call(w.lou, 'GET', '/api/modules?owner=shared')).json() as { modules: unknown[] }).modules).toEqual([]);
  });

  it('asking a club that already asked you makes you partners', async () => {
    const w = await world();
    await call(w.max, 'POST', `/api/orgs/${w.train.slug}/partners`, { slug: w.lug.slug });
    expect((await call(w.rita, 'POST', `/api/orgs/${w.lug.slug}/partners`, { slug: w.train.slug })).json()).toMatchObject({ status: 'partners' });
    expect((await partners(w.tina, w.train.slug)).partners.map((p) => p.name)).toEqual(['Riverside LUG']);
  });

  it('a request can be declined, taken back, and sent again a day after a decline', async () => {
    const w = await world();
    const id = ((await call(w.tina, 'POST', `/api/orgs/${w.train.slug}/partners`, { slug: w.lug.slug })).json() as { id: string }).id;
    expect((await call(w.rita, 'POST', `/api/orgs/${w.lug.slug}/partner-requests/${id}/decline`)).json()).toMatchObject({ status: 'declined' });
    expect((await partners(w.tina, w.train.slug)).requestsOut).toEqual([expect.objectContaining({ state: 'declined' })]);
    expect((await partners(w.rita, w.lug.slug)).requestsIn).toEqual([]);
    const again = await call(w.tina, 'POST', `/api/orgs/${w.train.slug}/partners`, { slug: w.lug.slug });
    expect(again.statusCode).toBe(429);
    expect(again.json()).toMatchObject({ error: 'declined_recently' });
    await db.update(schema.clubPartnerRequests).set({ decidedAt: new Date(Date.now() - ASK_AGAIN_AFTER_MS - 1000) }).where(eq(schema.clubPartnerRequests.id, id));
    expect((await call(w.tina, 'POST', `/api/orgs/${w.train.slug}/partners`, { slug: w.lug.slug })).statusCode).toBe(201);
    expect((await partners(w.rita, w.lug.slug)).requestsIn).toHaveLength(1);
    // Taken back: gone for both.
    expect((await call(w.max, 'DELETE', `/api/orgs/${w.train.slug}/partner-requests/${id}`)).statusCode).toBe(200);
    expect((await partners(w.rita, w.lug.slug)).requestsIn).toEqual([]);
    expect((await partners(w.tina, w.train.slug)).requestsOut).toEqual([]);
    // The asked club can't take it back, and can't answer one that's gone.
    expect((await call(w.rita, 'POST', `/api/orgs/${w.lug.slug}/partner-requests/${id}/accept`)).statusCode).toBe(404);
  });

  it('only Admins and Managers ask, answer and share; only Admins end it; outsiders see nothing', async () => {
    const w = await world();
    expect((await call(w.pat, 'POST', `/api/orgs/${w.train.slug}/partners`, { slug: w.lug.slug })).statusCode).toBe(403);
    expect((await call(w.eve, 'POST', `/api/orgs/${w.train.slug}/partners`, { slug: w.lug.slug })).statusCode).toBe(404);
    const id = ((await call(w.max, 'POST', `/api/orgs/${w.train.slug}/partners`, { slug: w.lug.slug })).json() as { id: string }).id;
    expect((await call(w.lou, 'POST', `/api/orgs/${w.lug.slug}/partner-requests/${id}/accept`)).statusCode).toBe(403);
    expect((await call(w.eve, 'POST', `/api/orgs/${w.lug.slug}/partner-requests/${id}/accept`)).statusCode).toBe(404);
    // The asking club can't accept its own request through the other club's address.
    expect((await call(w.tina, 'POST', `/api/orgs/${w.lug.slug}/partner-requests/${id}/accept`)).statusCode).toBe(404);
    expect((await call(w.pat, 'DELETE', `/api/orgs/${w.train.slug}/partner-requests/${id}`)).statusCode).toBe(403);
    expect((await call(w.mo, 'POST', `/api/orgs/${w.lug.slug}/partner-requests/${id}/accept`)).statusCode).toBe(200);
    // A plain member can't share the club's module; nor can a member of the partner club.
    const crane = await clubModule(w.tina, w.train.slug, 'Harbor crane');
    expect((await call(w.pat, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: w.lug.slug })).statusCode).toBe(403);
    expect((await call(w.rita, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: w.lug.slug })).statusCode).toBe(404);
    // A Manager can't end the partnership; a plain member neither; an Admin can.
    expect((await call(w.max, 'DELETE', `/api/orgs/${w.train.slug}/partners/${w.lug.id}`)).statusCode).toBe(403);
    expect((await call(w.pat, 'DELETE', `/api/orgs/${w.train.slug}/partners/${w.lug.id}`)).statusCode).toBe(403);
    expect((await call(w.eve, 'GET', `/api/orgs/${w.train.slug}/partners`)).statusCode).toBe(404);
    expect((await call(w.rita, 'DELETE', `/api/orgs/${w.lug.slug}/partners/${w.train.id}`)).statusCode).toBe(200);
  });

  it('partners share modules both ways with no accept per module, only in the receiving club’s layouts', async () => {
    const w = await partnered();
    const crane = await clubModule(w.tina, w.train.slug, 'Harbor crane');
    const mill = await clubModule(w.rita, w.lug.slug, 'Water mill');
    // The partner is offered in the Share dialog.
    expect((await call(w.max, 'GET', `/api/modules/${crane}/shares`)).json()).toMatchObject({
      canShareWithClubs: false,
      canShareWithOtherClubs: true,
      club: { name: 'Train Club' },
      partners: [expect.objectContaining({ name: 'Riverside LUG' })],
      myClubs: [],
    });
    const shared = await call(w.max, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: w.lug.slug });
    expect(shared.statusCode).toBe(201);
    expect(shared.json()).toMatchObject({ status: 'shared', via: 'partner' });
    expect((await call(w.mo, 'POST', `/api/modules/${mill}/club-shares`, { orgSlug: w.train.slug })).statusCode).toBe(201);
    // Each club's members have the other's module, under its club.
    const lous = (await call(w.lou, 'GET', '/api/modules?owner=shared')).json() as { modules: { id: string; owner: { kind: string; name: string } }[] };
    expect(lous.modules).toEqual([expect.objectContaining({ id: crane, owner: expect.objectContaining({ kind: 'org', name: 'Train Club' }) })]);
    const pats = (await call(w.pat, 'GET', '/api/modules?owner=shared')).json() as { modules: { id: string }[] };
    expect(pats.modules.map((m) => m.id)).toEqual([mill]);
    // No re-sharing: Riverside LUG can't pass Train Club's module on.
    expect((await call(w.rita, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: w.train.slug })).statusCode).toBe(403);
    // Placed in Riverside LUG's layout it follows; in Lou's own layout it doesn't (D4).
    const show = await layout({ ownerOrgId: w.lug.id }, w.lou.id, (d) => place(d, { placedId: 'p1', moduleId: crane, version: 1, bytes: contents(V1), placement: { degrees: 0, x: 0, y: 0 } }));
    const own = await layout({ ownerUserId: w.lou.id }, w.lou.id, (d) => place(d, { placedId: 'p1', moduleId: crane, version: 1, bytes: contents(V1), placement: { degrees: 0, x: 0, y: 0 } }));
    expect(await placedState(show)).toEqual(['shared']);
    expect(await placedState(own)).toEqual(['unshared']);
    // The sender sees counts and club names only.
    const shares = (await call(w.tina, 'GET', `/api/modules/${crane}/shares`)).json() as { usedIn: unknown; clubs: unknown[] };
    expect(shares.usedIn).toMatchObject({ layouts: 2, clubs: [{ name: 'Riverside LUG', layouts: 1 }], others: 1 });
    expect(JSON.stringify(shares)).not.toContain('Show plan');
    expect(shares.clubs).toEqual([expect.objectContaining({ name: 'Riverside LUG', via: 'partner' })]);
    expect((await partners(w.pat, w.train.slug)).partners[0]).toMatchObject({ modulesIn: 1, modulesOut: 1 });
  });

  it('a module offered one off waits for the other club’s answer: decline, offer again, accept', async () => {
    const w = await world();
    const crane = await clubModule(w.tina, w.train.slug, 'Harbor crane');
    // Found by search (listed clubs only).
    const targets = (await call(w.max, 'GET', `/api/modules/${crane}/club-targets?q=river`)).json() as { clubs: { slug: string; partner: boolean; offer: string | null }[] };
    expect(targets.clubs).toEqual([expect.objectContaining({ slug: w.lug.slug, partner: false, offer: null })]);
    const offered = await call(w.max, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: w.lug.slug });
    expect(offered.statusCode).toBe(202);
    const offerId = (offered.json() as { offerId: string }).offerId;
    expect(offered.json()).toMatchObject({ status: 'offered', name: 'Riverside LUG' });
    // Not shared yet: the club's members don't have it.
    expect(((await call(w.lou, 'GET', '/api/modules?owner=shared')).json() as { modules: unknown[] }).modules).toEqual([]);
    expect((await call(w.max, 'GET', `/api/modules/${crane}/shares`)).json()).toMatchObject({ offers: [expect.objectContaining({ id: offerId, state: 'pending' })] });
    // Its Admins and Managers see it; its members and outsiders don't.
    expect((await partners(w.mo, w.lug.slug)).offersIn).toEqual([expect.objectContaining({ id: offerId, module: expect.objectContaining({ title: 'Harbor crane' }), from: expect.objectContaining({ name: 'Train Club' }) })]);
    expect(await partners(w.lou, w.lug.slug)).not.toHaveProperty('offersIn');
    expect((await call(w.eve, 'GET', `/api/orgs/${w.lug.slug}/partners`)).statusCode).toBe(404);
    expect((await call(w.lou, 'POST', `/api/orgs/${w.lug.slug}/module-offers/${offerId}/accept`)).statusCode).toBe(403);
    expect((await call(w.eve, 'POST', `/api/orgs/${w.lug.slug}/module-offers/${offerId}/accept`)).statusCode).toBe(404);
    // Declined, then offered again too soon, then a day later.
    expect((await call(w.rita, 'POST', `/api/orgs/${w.lug.slug}/module-offers/${offerId}/decline`)).json()).toMatchObject({ status: 'declined' });
    expect((await call(w.max, 'GET', `/api/modules/${crane}/shares`)).json()).toMatchObject({ offers: [expect.objectContaining({ state: 'declined' })] });
    expect((await call(w.max, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: w.lug.slug })).statusCode).toBe(429);
    await db.update(schema.moduleClubOffers).set({ decidedAt: new Date(Date.now() - ASK_AGAIN_AFTER_MS - 1000) }).where(eq(schema.moduleClubOffers.id, offerId));
    expect((await call(w.max, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: w.lug.slug })).statusCode).toBe(202);
    expect((await call(w.mo, 'POST', `/api/orgs/${w.lug.slug}/module-offers/${offerId}/accept`)).json()).toMatchObject({ status: 'shared', moduleId: crane });
    expect(((await call(w.lou, 'GET', '/api/modules?owner=shared')).json() as { modules: { id: string }[] }).modules.map((m) => m.id)).toEqual([crane]);
    expect((await call(w.max, 'GET', `/api/modules/${crane}/shares`)).json()).toMatchObject({ offers: [], clubs: [expect.objectContaining({ name: 'Riverside LUG', via: 'offer' })] });
    expect(await notes(w.train.id)).toEqual([expect.stringContaining('Riverside LUG accepted your club’s module “Harbor crane”')]);
  });

  it('an offer can be taken back by the club that sent it', async () => {
    const w = await world();
    const crane = await clubModule(w.tina, w.train.slug, 'Harbor crane');
    const offerId = ((await call(w.max, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: w.lug.slug })).json() as { offerId: string }).offerId;
    expect((await call(w.pat, 'DELETE', `/api/modules/${crane}/club-offers/${offerId}`)).statusCode).toBe(403);
    expect((await call(w.tina, 'DELETE', `/api/modules/${crane}/club-offers/${offerId}`)).statusCode).toBe(200);
    expect((await partners(w.mo, w.lug.slug)).offersIn).toEqual([]);
    expect((await call(w.mo, 'POST', `/api/orgs/${w.lug.slug}/module-offers/${offerId}/accept`)).statusCode).toBe(404);
  });

  it('ending a partnership stops its modules both ways; one-off shares stay; the other club is told', async () => {
    const w = await partnered();
    const crane = await clubModule(w.tina, w.train.slug, 'Harbor crane');
    const mill = await clubModule(w.rita, w.lug.slug, 'Water mill');
    const tower = await clubModule(w.tina, w.train.slug, 'Signal tower');
    await call(w.max, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: w.lug.slug });
    await call(w.mo, 'POST', `/api/modules/${mill}/club-shares`, { orgSlug: w.train.slug });
    // A one-off share, accepted before the clubs became partners: it stays.
    await call(w.rita, 'DELETE', `/api/orgs/${w.lug.slug}/partners/${w.train.id}`);
    const offerId = ((await call(w.max, 'POST', `/api/modules/${tower}/club-shares`, { orgSlug: w.lug.slug })).json() as { offerId: string }).offerId;
    await call(w.mo, 'POST', `/api/orgs/${w.lug.slug}/module-offers/${offerId}/accept`);
    // Partners again; the crane and mill go again.
    const again = ((await call(w.max, 'POST', `/api/orgs/${w.train.slug}/partners`, { slug: w.lug.slug })).json() as { id: string }).id;
    await call(w.mo, 'POST', `/api/orgs/${w.lug.slug}/partner-requests/${again}/accept`);
    expect((await call(w.max, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: w.lug.slug })).statusCode).toBe(201);
    expect((await call(w.mo, 'POST', `/api/modules/${mill}/club-shares`, { orgSlug: w.train.slug })).statusCode).toBe(201);
    const lugShow = await layout({ ownerOrgId: w.lug.id }, w.lou.id, (d) => {
      place(d, { placedId: 'crane', moduleId: crane, version: 1, bytes: contents(V1), placement: { degrees: 0, x: 0, y: 0 } });
      place(d, { placedId: 'tower', moduleId: tower, version: 1, bytes: contents(V1), placement: { degrees: 0, x: 50, y: 0 } });
    });
    const trainShow = await layout({ ownerOrgId: w.train.id }, w.pat.id, (d) => place(d, { placedId: 'mill', moduleId: mill, version: 1, bytes: contents(V1), placement: { degrees: 0, x: 0, y: 0 } }));
    expect(await placedState(lugShow)).toEqual(['shared', 'shared']);
    const ended = await call(w.tina, 'DELETE', `/api/orgs/${w.train.slug}/partners/${w.lug.id}`);
    expect(ended.json()).toMatchObject({ ok: true, stopped: 2 });
    const states = Object.fromEntries((await db.select().from(schema.layoutSharedModules).all()).map((r) => [r.placedId, r.state]));
    expect(states).toEqual({ crane: 'unshared', tower: 'shared', mill: 'unshared' });
    // The copies stay in the layouts.
    expect(await placedState(trainShow)).toEqual(['unshared']);
    expect((await partners(w.rita, w.lug.slug)).partners).toEqual([]);
    expect(await notes(w.lug.id)).toContainEqual(expect.stringContaining('Train Club ended its partnership with Riverside LUG. 1 module your club shared with them and 1 module Train Club shared with you stopped.'));
    // And Lou's library: the tower only.
    expect(((await call(w.lou, 'GET', '/api/modules?owner=shared')).json() as { modules: { id: string }[] }).modules.map((m) => m.id)).toEqual([tower]);
  });

  it('a club deleted: its partnerships end, its modules’ copies are marked deleted, its partners are told', async () => {
    const w = await partnered();
    const crane = await clubModule(w.tina, w.train.slug, 'Harbor crane');
    await call(w.max, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: w.lug.slug });
    const third = await club(w.eve, 'Hill Club');
    const offerId = ((await call(w.max, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: third.slug })).json() as { offerId: string }).offerId;
    const show = await layout({ ownerOrgId: w.lug.id }, w.lou.id, (d) => place(d, { placedId: 'crane', moduleId: crane, version: 1, bytes: contents(V1), placement: { degrees: 0, x: 0, y: 0 } }));
    await eraseClub(w.train.id, w.tina.id, 'self');
    expect(await placedState(show)).toEqual(['gone']);
    expect(await db.select().from(schema.clubPartners).all()).toEqual([]);
    expect(await db.select().from(schema.moduleClubOffers).where(eq(schema.moduleClubOffers.id, offerId)).all()).toEqual([]);
    expect(await notes(w.lug.id)).toContainEqual(expect.stringContaining('Train Club was deleted, so your clubs are no longer partners'));
  });

  it('a club that isn’t listed is reached by its link, and named only once it accepts', async () => {
    const w = await world();
    const hidden = await club(w.eve, 'Secret Society', { listed: false });
    // Not in the search.
    const crane = await clubModule(w.tina, w.train.slug, 'Harbor crane');
    expect(((await call(w.max, 'GET', `/api/modules/${crane}/club-targets?q=secret`)).json() as { clubs: unknown[] }).clubs).toEqual([]);
    const asked = await call(w.max, 'POST', `/api/orgs/${w.train.slug}/partners`, { slug: `/orgs/${hidden.slug}` });
    expect(asked.statusCode).toBe(201);
    expect(asked.json()).toMatchObject({ club: { id: null, name: null, slug: hidden.slug } });
    expect(JSON.stringify((await call(w.max, 'GET', `/api/orgs/${w.train.slug}/partners`)).json())).not.toContain('Secret Society');
    const offered = await call(w.max, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: hidden.slug });
    expect(offered.json()).toMatchObject({ status: 'offered', name: null });
    expect(JSON.stringify((await call(w.max, 'GET', `/api/modules/${crane}/shares`)).json())).not.toContain('Secret Society');
    // A slug nobody has answers as the club's own link does.
    expect((await call(w.max, 'POST', `/api/orgs/${w.train.slug}/partners`, { slug: 'no-such-club' })).statusCode).toBe(404);
    // The hidden club sees who asked (Train Club chose to ask); accepting names it to Train Club.
    const req = (await partners(w.eve, hidden.slug)).requestsIn![0]!;
    expect(req.club.name).toBe('Train Club');
    await call(w.eve, 'POST', `/api/orgs/${hidden.slug}/partner-requests/${req.id}/accept`);
    expect((await partners(w.max, w.train.slug)).partners.map((p) => p.name)).toEqual(['Secret Society']);
  });

  it('the privacy downloads hold partnerships and offers', async () => {
    const w = await partnered();
    const crane = await clubModule(w.tina, w.train.slug, 'Harbor crane');
    const third = await club(w.eve, 'Hill Club');
    await call(w.max, 'POST', `/api/modules/${crane}/club-shares`, { orgSlug: third.slug });
    const org = Object.fromEntries((await collectOrgData(w.train.id)).map((s) => [s.name, s.rows.length]));
    expect(org).toMatchObject({ 'partner-clubs': 1, 'module-offers': 1 });
    const max = Object.fromEntries((await collectUserData(w.max.id)).map((s) => [s.name, s.rows.length]));
    expect(max).toMatchObject({ 'club-partner-requests': 0, 'club-module-offers': 1 });
    const mo = Object.fromEntries((await collectUserData(w.mo.id)).map((s) => [s.name, s.rows.length]));
    expect(mo).toMatchObject({ 'club-partnerships-you-accepted': 1 });
  });
});
