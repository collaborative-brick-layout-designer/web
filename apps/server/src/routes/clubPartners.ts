// Partner clubs, and module offers a club answers (docs/shared-modules.md, section 11;
// the rules are in clubPartners/partners.ts).
//
//   GET    /api/orgs/:slug/partners                          partners (members); requests and offers (Admins and Managers)
//   POST   /api/orgs/:slug/partners                          ask a club to be partners  { slug }
//   DELETE /api/orgs/:slug/partners/:orgId                   end a partnership (Admins)
//   DELETE /api/orgs/:slug/partner-requests/:id              take back a request the club sent
//   POST   /api/orgs/:slug/partner-requests/:id/accept       (Admins and Managers of the club asked)
//   POST   /api/orgs/:slug/partner-requests/:id/decline      (Admins and Managers of the club asked)
//   POST   /api/orgs/:slug/module-offers/:id/accept          a module offered to the club
//   POST   /api/orgs/:slug/module-offers/:id/decline
//   GET    /api/club-requests/count                          what waits in the clubs you look after
//
// Another club is found by its address (slug), from the Clubs directory or a
// pasted link. A club that isn't listed shows nothing more to people outside
// it than its link does (GET /api/orgs/:slug answers 404 for it): a request
// to it is sent, but its name and logo aren't shown to the club asking until
// it accepts.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { requireUser } from '../auth/cookie.js';
import { isDemoUser } from '../demo/demoAccount.js';
import { clubAccess, clubAccessMap } from '../access/clubPermissions.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { perPerson } from '../utils/rateLimits.js';
import { clubLogoUrls } from './clubLogos.js';
import { loadOrgBySlug } from './orgs.js';
import { moduleSharesChanged } from '../sharedModules/lifecycle.js';
import { slugFrom } from '../clubPartners/slug.js';
import {
  ASK_AGAIN_AFTER_MS,
  OPEN_PARTNER_REQUESTS_MAX,
  arePartners,
  emailClubRunners,
  endPartnership,
  isLive,
  noteToClub,
  pairOf,
  partnersOf,
  settleOffersBetween,
  runsPartners,
  waitingFor,
} from '../clubPartners/partners.js';

type Org = typeof schema.orgs.$inferSelect;
type Reply = { code: (n: number) => { send: (b: unknown) => unknown } };

/** Whether the club `org` may be named to a member of `viewerOrgId`: listed, a partner, or the viewer is in it. */
async function nameable(org: Org, viewerId: string, viewerOrgId: string): Promise<boolean> {
  if (org.listed) return true;
  if (await clubAccess(viewerId, org.id)) return true;
  return arePartners(org.id, viewerOrgId);
}

/** The club, for one of its members; with whether they run its partners. Otherwise the reply has been sent. */
async function asMember(slug: string, userId: string, reply: Reply) {
  const org = await loadOrgBySlug(slug);
  const access = org ? await clubAccess(userId, org.id) : null;
  if (!org || !access || !isLive(org)) {
    reply.code(404).send({ error: 'not_found' });
    return null;
  }
  return { org, access };
}

/** The club, for its Admins and Managers; otherwise the reply has been sent. */
async function asRunner(slug: string, userId: string, reply: Reply) {
  const got = await asMember(slug, userId, reply);
  if (!got) return null;
  if (!runsPartners(got.access)) {
    reply.code(403).send({ error: 'forbidden', permission: 'delete_items' });
    return null;
  }
  return got;
}

const pub = (o: Org, logos: Map<string, string>) => ({ id: o.id, name: o.name, slug: o.slug, logoUrl: logos.get(o.id) ?? null });

export async function clubPartnerRoutes(app: FastifyInstance): Promise<void> {
  // ---- the club's partners, requests and offers ----------------------------------
  app.get<{ Params: { slug: string } }>('/api/orgs/:slug/partners', async (req, reply) => {
    const user = requireUser(req);
    const got = await asMember(req.params.slug, user.id, reply);
    if (!got) return reply;
    const { org, access } = got;
    const partners = await partnersOf(org.id);
    const runs = runsPartners(access);
    // How many modules go each way, per partner (counts only).
    const shares = await db
      .select({ orgId: schema.moduleClubShares.orgId, fromOrgId: schema.moduleClubShares.fromOrgId })
      .from(schema.moduleClubShares)
      .where(and(eq(schema.moduleClubShares.via, 'partner'), or(eq(schema.moduleClubShares.orgId, org.id), eq(schema.moduleClubShares.fromOrgId, org.id))))
      .all();
    const out: Record<string, unknown> = {};
    let others: Org[] = partners.map((p) => p.org);
    let requestsIn: (typeof schema.clubPartnerRequests.$inferSelect)[] = [];
    let requestsOut: (typeof schema.clubPartnerRequests.$inferSelect)[] = [];
    let offersIn: { offer: typeof schema.moduleClubOffers.$inferSelect; title: string; latestVersion: number }[] = [];
    if (runs) {
      requestsIn = await db
        .select()
        .from(schema.clubPartnerRequests)
        .where(and(eq(schema.clubPartnerRequests.toOrgId, org.id), eq(schema.clubPartnerRequests.state, 'pending')))
        .orderBy(schema.clubPartnerRequests.createdAt)
        .all();
      requestsOut = await db
        .select()
        .from(schema.clubPartnerRequests)
        .where(eq(schema.clubPartnerRequests.fromOrgId, org.id))
        .orderBy(schema.clubPartnerRequests.createdAt)
        .all();
      offersIn = (
        await db
          .select({ offer: schema.moduleClubOffers, title: schema.modules.title, latestVersion: schema.modules.latestVersion })
          .from(schema.moduleClubOffers)
          .innerJoin(schema.modules, eq(schema.modules.id, schema.moduleClubOffers.moduleId))
          .where(and(eq(schema.moduleClubOffers.toOrgId, org.id), eq(schema.moduleClubOffers.state, 'pending')))
          .orderBy(schema.moduleClubOffers.createdAt)
          .all()
      ).map((r) => ({ offer: r.offer, title: r.title, latestVersion: r.latestVersion ?? 0 }));
      const ids = [...new Set([...requestsIn.map((r) => r.fromOrgId), ...requestsOut.map((r) => r.toOrgId), ...offersIn.map((o) => o.offer.fromOrgId)])];
      if (ids.length) others = [...others, ...(await db.select().from(schema.orgs).where(inArray(schema.orgs.id, ids)).all())];
    }
    const byId = new Map(others.map((o) => [o.id, o]));
    const logos = await clubLogoUrls(others);
    out.partners = partners.map((p) => ({
      ...pub(p.org, logos),
      since: p.since.getTime(),
      modulesIn: shares.filter((s) => s.orgId === org.id && s.fromOrgId === p.org.id).length,
      modulesOut: shares.filter((s) => s.fromOrgId === org.id && s.orgId === p.org.id).length,
    }));
    out.canManage = runs;
    out.canEnd = access.isAdmin;
    if (runs) {
      // Requests and offers from clubs being deleted don't wait for an answer.
      out.requestsIn = requestsIn
        .filter((r) => isLive(byId.get(r.fromOrgId)))
        .map((r) => ({ id: r.id, club: pub(byId.get(r.fromOrgId)!, logos), createdAt: r.createdAt.getTime() }));
      const outRows = [];
      for (const r of requestsOut) {
        const o = byId.get(r.toOrgId);
        if (!isLive(o)) continue;
        const named = await nameable(o!, user.id, org.id);
        outRows.push({
          id: r.id,
          club: named ? pub(o!, logos) : { id: null, name: null, slug: o!.slug, logoUrl: null },
          state: r.state,
          createdAt: r.createdAt.getTime(),
          decidedAt: r.decidedAt?.getTime() ?? null,
          askAgainAt: r.state === 'declined' && r.decidedAt ? r.decidedAt.getTime() + ASK_AGAIN_AFTER_MS : null,
        });
      }
      out.requestsOut = outRows;
      out.offersIn = offersIn
        .filter((o) => isLive(byId.get(o.offer.fromOrgId)))
        .map((o) => ({
          id: o.offer.id,
          module: { id: o.offer.moduleId, title: o.title, latestVersion: o.latestVersion },
          from: pub(byId.get(o.offer.fromOrgId)!, logos),
          partner: partners.some((p) => p.org.id === o.offer.fromOrgId),
          createdAt: o.offer.createdAt.getTime(),
        }));
    }
    return out;
  });

  // ---- ask a club to be partners -------------------------------------------------
  app.post<{ Params: { slug: string }; Body: { slug?: unknown } }>(
    '/api/orgs/:slug/partners',
    { config: { rateLimit: perPerson(10, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      if (isDemoUser(user)) return reply.code(403).send({ error: 'demo_account_cannot_share' });
      const got = await asRunner(req.params.slug, user.id, reply);
      if (!got) return reply;
      const { org } = got;
      const otherSlug = slugFrom(req.body?.slug);
      if (!otherSlug) return reply.code(400).send({ error: 'invalid_club' });
      const other = await loadOrgBySlug(otherSlug);
      // Unknown, or being deleted: not found, as its link says.
      if (!other || !isLive(other)) return reply.code(404).send({ error: 'org_not_found' });
      if (other.id === org.id) return reply.code(400).send({ error: 'same_club' });
      const named = await nameable(other, user.id, org.id);
      const shown = named ? { id: other.id, name: other.name, slug: other.slug } : { id: null, name: null, slug: other.slug };
      if (await arePartners(org.id, other.id)) return { status: 'partners' as const, club: shown, already: true };
      // They asked us already: this answers it.
      const theirs = await db
        .select()
        .from(schema.clubPartnerRequests)
        .where(and(eq(schema.clubPartnerRequests.fromOrgId, other.id), eq(schema.clubPartnerRequests.toOrgId, org.id), eq(schema.clubPartnerRequests.state, 'pending')))
        .get();
      if (theirs) {
        await becomePartners(theirs, org, other, user.id);
        return { status: 'partners' as const, club: { id: other.id, name: other.name, slug: other.slug } };
      }
      const mine = await db
        .select()
        .from(schema.clubPartnerRequests)
        .where(and(eq(schema.clubPartnerRequests.fromOrgId, org.id), eq(schema.clubPartnerRequests.toOrgId, other.id)))
        .get();
      if (mine?.state === 'pending') return { status: 'requested' as const, id: mine.id, club: shown, already: true };
      const now = new Date();
      if (mine?.state === 'declined' && mine.decidedAt && now.getTime() - mine.decidedAt.getTime() < ASK_AGAIN_AFTER_MS) {
        return reply.code(429).send({
          error: 'declined_recently',
          askAgainAt: mine.decidedAt.getTime() + ASK_AGAIN_AFTER_MS,
          message: 'That club declined your request. You can ask again a day after it declined.',
        });
      }
      const waiting = await db
        .select({ id: schema.clubPartnerRequests.id })
        .from(schema.clubPartnerRequests)
        .where(and(eq(schema.clubPartnerRequests.fromOrgId, org.id), eq(schema.clubPartnerRequests.state, 'pending')))
        .all();
      if (waiting.length >= OPEN_PARTNER_REQUESTS_MAX) {
        return reply.code(429).send({
          error: 'too_many_requests',
          message: `Your club is waiting to hear from ${OPEN_PARTNER_REQUESTS_MAX} clubs already. Take some requests back, or wait for an answer.`,
        });
      }
      const id = mine?.id ?? randomUUID();
      if (mine) {
        await db
          .update(schema.clubPartnerRequests)
          .set({ state: 'pending', requestedBy: user.id, createdAt: now, decidedAt: null, decidedBy: null })
          .where(eq(schema.clubPartnerRequests.id, mine.id));
      } else {
        await db.insert(schema.clubPartnerRequests).values({ id, fromOrgId: org.id, toOrgId: other.id, requestedBy: user.id, state: 'pending', createdAt: now });
      }
      await writeAuditEvent({ resourceKind: 'org', resourceId: org.id, userId: user.id, eventType: 'partner_request', payload: { to: other.id } });
      await writeAuditEvent({ resourceKind: 'org', resourceId: other.id, userId: user.id, eventType: 'partner_request', payload: { from: org.id } });
      void emailClubRunners(other, user.id, `${org.name} asked to be partners with ${other.name}`, [
        `${org.name} asked to be partner clubs with ${other.name}.`,
        'Partner clubs can share their modules with each other, read-only, with no need to accept each one. Each module is still picked.',
        'Your club’s Admins and Managers can accept or decline it on the club’s Partners page.',
      ]);
      return reply.code(201).send({ status: 'requested' as const, id, club: shown });
    },
  );

  // ---- take back a request ---------------------------------------------------------
  app.delete<{ Params: { slug: string; id: string } }>(
    '/api/orgs/:slug/partner-requests/:id',
    { config: { rateLimit: perPerson(30, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      const got = await asRunner(req.params.slug, user.id, reply);
      if (!got) return reply;
      const gone = await db
        .delete(schema.clubPartnerRequests)
        .where(and(eq(schema.clubPartnerRequests.id, req.params.id), eq(schema.clubPartnerRequests.fromOrgId, got.org.id)))
        .returning()
        .all();
      if (gone.length === 0) return reply.code(404).send({ error: 'request_not_found' });
      if (gone[0]!.state === 'pending') {
        await writeAuditEvent({ resourceKind: 'org', resourceId: got.org.id, userId: user.id, eventType: 'partner_withdraw', payload: { to: gone[0]!.toOrgId } });
      }
      return { ok: true, toOrgId: gone[0]!.toOrgId };
    },
  );

  // ---- accept or decline a request ----------------------------------------------------
  for (const answer of ['accept', 'decline'] as const) {
    app.post<{ Params: { slug: string; id: string } }>(
      `/api/orgs/:slug/partner-requests/:id/${answer}`,
      { config: { rateLimit: perPerson(60, '1 minute') } },
      async (req, reply) => {
        const user = requireUser(req);
        const got = await asRunner(req.params.slug, user.id, reply);
        if (!got) return reply;
        const { org } = got;
        const request = await db
          .select()
          .from(schema.clubPartnerRequests)
          .where(and(eq(schema.clubPartnerRequests.id, req.params.id), eq(schema.clubPartnerRequests.toOrgId, org.id), eq(schema.clubPartnerRequests.state, 'pending')))
          .get();
        if (!request) return reply.code(404).send({ error: 'request_not_found' });
        const from = await db.select().from(schema.orgs).where(eq(schema.orgs.id, request.fromOrgId)).get();
        if (!from || !isLive(from)) return reply.code(404).send({ error: 'request_not_found' });
        if (answer === 'accept') {
          if (isDemoUser(user)) return reply.code(403).send({ error: 'demo_account_cannot_share' });
          await becomePartners(request, org, from, user.id);
          return { ok: true, status: 'partners' as const, fromOrgId: from.id };
        }
        await db
          .update(schema.clubPartnerRequests)
          .set({ state: 'declined', decidedAt: new Date(), decidedBy: user.id })
          .where(eq(schema.clubPartnerRequests.id, request.id));
        await writeAuditEvent({ resourceKind: 'org', resourceId: org.id, userId: user.id, eventType: 'partner_decline', payload: { from: from.id } });
        await writeAuditEvent({ resourceKind: 'org', resourceId: from.id, userId: user.id, eventType: 'partner_decline', payload: { to: org.id } });
        return { ok: true, status: 'declined' as const, fromOrgId: from.id };
      },
    );
  }

  // ---- end a partnership (Admins) ------------------------------------------------------
  app.delete<{ Params: { slug: string; orgId: string } }>(
    '/api/orgs/:slug/partners/:orgId',
    { config: { rateLimit: perPerson(30, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      const got = await asMember(req.params.slug, user.id, reply);
      if (!got) return reply;
      const { org, access } = got;
      if (!access.isAdmin) return reply.code(403).send({ error: 'forbidden', permission: 'admin' });
      if (!(await arePartners(org.id, req.params.orgId))) return reply.code(404).send({ error: 'not_partners' });
      const other = await db.select().from(schema.orgs).where(eq(schema.orgs.id, req.params.orgId)).get();
      const stopped = await endPartnership(org.id, req.params.orgId);
      const theirs = stopped.filter((s) => s.orgId === req.params.orgId).length;
      const ours = stopped.length - theirs;
      await writeAuditEvent({ resourceKind: 'org', resourceId: org.id, userId: user.id, eventType: 'partner_end', payload: { with: req.params.orgId, stopped: stopped.length } });
      if (other) {
        await writeAuditEvent({ resourceKind: 'org', resourceId: other.id, userId: user.id, eventType: 'partner_end', payload: { with: org.id, stopped: stopped.length } });
        await noteToClub(
          other.id,
          user.id,
          `${org.name} ended its partnership with ${other.name}. ${stoppedWords(ours, theirs, org.name)} Modules shared one off and accepted stay shared.`,
          `/orgs/${other.slug}?tab=partners`,
        );
      }
      return { ok: true, stopped: stopped.length, orgId: req.params.orgId };
    },
  );

  // ---- accept or decline a module offered to the club ---------------------------------
  for (const answer of ['accept', 'decline'] as const) {
    app.post<{ Params: { slug: string; id: string } }>(
      `/api/orgs/:slug/module-offers/:id/${answer}`,
      { config: { rateLimit: perPerson(60, '1 minute') } },
      async (req, reply) => {
        const user = requireUser(req);
        const got = await asRunner(req.params.slug, user.id, reply);
        if (!got) return reply;
        const { org } = got;
        const offer = await db
          .select()
          .from(schema.moduleClubOffers)
          .where(and(eq(schema.moduleClubOffers.id, req.params.id), eq(schema.moduleClubOffers.toOrgId, org.id), eq(schema.moduleClubOffers.state, 'pending')))
          .get();
        if (!offer) return reply.code(404).send({ error: 'offer_not_found' });
        const mod = await db
          .select({ title: schema.modules.title, ownerOrgId: schema.modules.ownerOrgId })
          .from(schema.modules)
          .where(eq(schema.modules.id, offer.moduleId))
          .get();
        const from = await db.select().from(schema.orgs).where(eq(schema.orgs.id, offer.fromOrgId)).get();
        // The module left the club that offered it (handed to someone else), or that club is going: the offer is over.
        if (!mod || mod.ownerOrgId !== offer.fromOrgId || !from || !isLive(from)) {
          await db.delete(schema.moduleClubOffers).where(eq(schema.moduleClubOffers.id, offer.id));
          return reply.code(410).send({ error: 'offer_gone' });
        }
        if (answer === 'accept') {
          if (isDemoUser(user)) return reply.code(403).send({ error: 'demo_account_cannot_share' });
          db.transaction((tx) => {
            tx.insert(schema.moduleClubShares)
              .values({ moduleId: offer.moduleId, orgId: org.id, sharedBy: offer.offeredBy, createdAt: new Date(), via: 'offer', fromOrgId: offer.fromOrgId })
              .onConflictDoNothing()
              .run();
            tx.delete(schema.moduleClubOffers).where(eq(schema.moduleClubOffers.id, offer.id)).run();
          });
          await moduleSharesChanged(offer.moduleId);
          await writeAuditEvent({ resourceKind: 'org', resourceId: org.id, userId: user.id, eventType: 'module_offer_accept', payload: { module: offer.moduleId, from: from.id } });
          await writeAuditEvent({ resourceKind: 'module', resourceId: offer.moduleId, userId: user.id, eventType: 'share', payload: { club: org.id, readOnly: true, via: 'offer' } });
          await noteToClub(
            from.id,
            user.id,
            `${org.name} accepted your club’s module “${mod.title}”. Its members can place it in the club’s layouts, and they get your updates.`,
            `/orgs/${from.slug}?tab=partners`,
          );
          return { ok: true, status: 'shared' as const, moduleId: offer.moduleId, fromOrgId: from.id };
        }
        await db
          .update(schema.moduleClubOffers)
          .set({ state: 'declined', decidedAt: new Date(), decidedBy: user.id })
          .where(eq(schema.moduleClubOffers.id, offer.id));
        await writeAuditEvent({ resourceKind: 'org', resourceId: org.id, userId: user.id, eventType: 'module_offer_decline', payload: { module: offer.moduleId, from: from.id } });
        await writeAuditEvent({ resourceKind: 'org', resourceId: from.id, userId: user.id, eventType: 'module_offer_decline', payload: { module: offer.moduleId, to: org.id } });
        return { ok: true, status: 'declined' as const, moduleId: offer.moduleId, fromOrgId: from.id };
      },
    );
  }

  // ---- what waits, in the clubs you look after (the Clubs badge; the desktop's pointer) ---
  app.get('/api/club-requests/count', { config: { apiToken: 'layouts:read' } }, async (req) => {
    const user = requireUser(req);
    const runs = [...(await clubAccessMap(user.id)).values()].filter((a) => runsPartners(a)).map((a) => a.orgId);
    if (runs.length === 0) return { count: 0, clubs: [] };
    const waiting = await waitingFor(runs);
    const ids = [...waiting.keys()];
    const orgs = ids.length ? await db.select({ id: schema.orgs.id, slug: schema.orgs.slug, name: schema.orgs.name }).from(schema.orgs).where(inArray(schema.orgs.id, ids)).all() : [];
    const clubs = orgs.map((o) => ({ slug: o.slug, name: o.name, count: waiting.get(o.id) ?? 0 })).sort((a, b) => a.name.localeCompare(b.name));
    return { count: clubs.reduce((t, c) => t + c.count, 0), clubs };
  });
}

/** "2 of your modules and 1 of theirs stopped…": what ending a partnership stopped, as the other club reads it. */
function stoppedWords(ours: number, theirs: number, name: string): string {
  if (ours + theirs === 0) return 'No modules were shared through it.';
  const n = (k: number, what: string) => `${k} ${k === 1 ? 'module' : 'modules'} ${what}`;
  const parts = [...(theirs ? [n(theirs, 'your club shared with them')] : []), ...(ours ? [n(ours, `${name} shared with you`)] : [])];
  return `${parts.join(' and ')} stopped. Copies already placed stay as they are, marked “No longer shared”.`;
}

/** Accept a request: the clubs are partners, the request goes (and any the other way). */
async function becomePartners(request: typeof schema.clubPartnerRequests.$inferSelect, answering: Org, asking: Org, userId: string): Promise<void> {
  const k = pairOf(answering.id, asking.id);
  db.transaction((tx) => {
    tx.insert(schema.clubPartners).values({ ...k, requestedByOrg: request.fromOrgId, acceptedBy: userId, createdAt: new Date() }).onConflictDoNothing().run();
    tx.delete(schema.clubPartnerRequests)
      .where(
        or(
          and(eq(schema.clubPartnerRequests.fromOrgId, answering.id), eq(schema.clubPartnerRequests.toOrgId, asking.id)),
          and(eq(schema.clubPartnerRequests.fromOrgId, asking.id), eq(schema.clubPartnerRequests.toOrgId, answering.id)),
        ),
      )
      .run();
  });
  await writeAuditEvent({ resourceKind: 'org', resourceId: answering.id, userId, eventType: 'partner_accept', payload: { with: asking.id } });
  await writeAuditEvent({ resourceKind: 'org', resourceId: asking.id, userId, eventType: 'partner_accept', payload: { with: answering.id } });
  await noteToClub(
    asking.id,
    userId,
    `${answering.name} accepted your club’s partner request. Your clubs can now share modules with each other, with no need to accept each one.`,
    `/orgs/${asking.slug}?tab=partners`,
  );
  // Offers still waiting between them are partner shares now, both ways.
  await settleOffersBetween(answering.id, asking.id, userId);
}
