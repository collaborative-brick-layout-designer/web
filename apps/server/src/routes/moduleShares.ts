// Sharing a module read-only (docs/shared-modules.md).
//
//   GET    /api/modules/:id/shares               who it's shared with, and where it's used (its owners)
//   POST   /api/modules/:id/club-shares          share with a club you're in  { orgSlug }
//                                                 (a club's module: with a partner club, or offered to any club)
//   DELETE /api/modules/:id/club-shares/:orgId   stop sharing with that club
//   DELETE /api/modules/:id/club-offers/:offerId take back an offer (or forget a declined one)
//   GET    /api/modules/:id/club-targets?q=      a club's module: its partners, and clubs to offer it to
//
// A club's module goes to another club only from its Admins or Managers
// (owners of the club's modules): straight away to a partner club, or as an
// offer that club's Admins or Managers accept or decline (routes/clubPartners.ts).
// Sharing with a person is an emailed invite (moduleInvites.ts) that adds
// a module_collaborators row; "can place it" is the viewer role there.
// Only a module's owner shares it; nobody it's shared with can pass it on.

import type { FastifyInstance } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { requireUser } from '../auth/cookie.js';
import { isDemoUser } from '../demo/demoAccount.js';
import { hasAtLeast, resolveResourceRole } from '../access/resolveResourceRole.js';
import { clubAccess } from '../access/clubPermissions.js';
import { clubSharesOf } from '../access/moduleShares.js';
import { moduleSharesChanged } from '../sharedModules/lifecycle.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { nameFor } from '../utils/publicName.js';
import { perPerson } from '../utils/rateLimits.js';
import { postPersonalNote } from './warnings.js';
import { clubMemberIds, notify, notifyClub, resolve } from '../notifications/notify.js';
import { publicName } from '../utils/publicName.js';
import { randomUUID } from 'node:crypto';
import { escapeLike } from '../utils/validate.js';
import { clubLogoUrls } from './clubLogos.js';
import { loadOrgBySlug } from './orgs.js';
import { slugFrom } from '../clubPartners/slug.js';
import {
  ASK_AGAIN_AFTER_MS,
  OPEN_MODULE_OFFERS_MAX,
  OPEN_OFFERS_PER_CLUB_MAX,
  arePartners,
  emailClubRunners,
  isLive,
  noteToClub,
  partnersOf,
} from '../clubPartners/partners.js';

/** A module can be shared with this many clubs. */
export const MAX_CLUB_SHARES = 50;

/**
 * Where a module is placed, for its owner: how many layouts, by club (named)
 * and by the people it's shared with (named: the owner chose them). Layouts
 * of anyone else are only counted. Never a layout's title.
 */
export async function usedIn(viewer: { id: string; isGlobalAdmin?: boolean | null }, moduleId: string): Promise<{
  layouts: number;
  clubs: { orgId: string; name: string; layouts: number }[];
  people: { userId: string; name: string; layouts: number }[];
  others: number;
}> {
  const rows = await db
    .select({
      ownerUserId: schema.layouts.ownerUserId,
      ownerOrgId: schema.layouts.ownerOrgId,
      n: sql<number>`count(DISTINCT ${schema.layoutSharedModules.layoutId})`.mapWith(Number),
    })
    .from(schema.layoutSharedModules)
    .innerJoin(schema.layouts, eq(schema.layouts.id, schema.layoutSharedModules.layoutId))
    .where(eq(schema.layoutSharedModules.moduleId, moduleId))
    .groupBy(schema.layouts.ownerUserId, schema.layouts.ownerOrgId)
    .all();
  const clubs: { orgId: string; name: string; layouts: number }[] = [];
  const people: { userId: string; name: string; layouts: number }[] = [];
  let others = 0;
  const sharedWith = new Set(
    (await db.select({ u: schema.moduleCollaborators.userId }).from(schema.moduleCollaborators).where(eq(schema.moduleCollaborators.moduleId, moduleId)).all()).map((r) => r.u),
  );
  const mod = await db.select({ ownerUserId: schema.modules.ownerUserId }).from(schema.modules).where(eq(schema.modules.id, moduleId)).get();
  if (mod?.ownerUserId) sharedWith.add(mod.ownerUserId);
  for (const r of rows) {
    if (r.ownerOrgId) {
      const org = await db.select({ name: schema.orgs.name }).from(schema.orgs).where(eq(schema.orgs.id, r.ownerOrgId)).get();
      clubs.push({ orgId: r.ownerOrgId, name: org?.name ?? '', layouts: r.n });
    } else if (r.ownerUserId && sharedWith.has(r.ownerUserId)) {
      const u = await db.select({ name: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, r.ownerUserId)).get();
      people.push({ userId: r.ownerUserId, name: nameFor(viewer as never, r.ownerUserId, u?.name ?? ''), layouts: r.n });
    } else {
      others += r.n;
    }
  }
  clubs.sort((a, b) => a.name.localeCompare(b.name));
  people.sort((a, b) => a.name.localeCompare(b.name));
  return { layouts: rows.reduce((n, r) => n + r.n, 0), clubs, people, others };
}

export async function moduleShareRoutes(app: FastifyInstance): Promise<void> {
  // ---- who it's shared with, and where it's used ---------------------------
  app.get<{ Params: { id: string } }>('/api/modules/:id/shares', { config: { apiToken: 'layouts:read' } }, async (req, reply) => {
    const user = requireUser(req);
    const { role } = await resolveResourceRole(user.id, 'module', req.params.id);
    if (role === null) return reply.code(404).send({ error: 'not_found' });
    if (!hasAtLeast(role, 'owner')) return reply.code(403).send({ error: 'forbidden' });
    const mod = await db
      .select({ ownerUserId: schema.modules.ownerUserId, ownerOrgId: schema.modules.ownerOrgId, latestVersion: schema.modules.latestVersion })
      .from(schema.modules)
      .where(eq(schema.modules.id, req.params.id))
      .get();
    if (!mod) return reply.code(404).send({ error: 'not_found' });
    const people = await db
      .select({
        userId: schema.moduleCollaborators.userId,
        role: schema.moduleCollaborators.role,
        addedAt: schema.moduleCollaborators.addedAt,
        email: schema.users.email,
        displayName: schema.users.displayName,
      })
      .from(schema.moduleCollaborators)
      .innerJoin(schema.users, eq(schema.users.id, schema.moduleCollaborators.userId))
      .where(eq(schema.moduleCollaborators.moduleId, req.params.id))
      .all();
    const invites = await db
      .select()
      .from(schema.moduleInvites)
      .where(and(eq(schema.moduleInvites.moduleId, req.params.id), isNull(schema.moduleInvites.acceptedAt)))
      .all();
    const clubs = await clubSharesOf(req.params.id);
    // A club's module: the partner clubs it can go to, and its offers.
    const fromClub = mod.ownerOrgId ? await clubToClub(req.params.id, mod.ownerOrgId, user.id) : null;
    // A person's module: the clubs they're in.
    const mine = mod.ownerOrgId
      ? []
      : await db
          .select({ orgId: schema.orgs.id, name: schema.orgs.name, slug: schema.orgs.slug })
          .from(schema.orgMembers)
          .innerJoin(schema.orgs, eq(schema.orgs.id, schema.orgMembers.orgId))
          .where(eq(schema.orgMembers.userId, user.id))
          .orderBy(schema.orgs.name)
          .all();
    return {
      latestVersion: mod.latestVersion,
      /** A person's module goes to the clubs they're in (false for a club's module, as older apps expect). */
      canShareWithClubs: !mod.ownerOrgId,
      /** A club's module goes to its partner clubs, or is offered to any other club. */
      canShareWithOtherClubs: !!mod.ownerOrgId,
      /** A club's module: the club, its partners still to share with, and its offers (pending or declined). */
      ...(fromClub ?? {}),
      people: people.map((p) => ({
        userId: p.userId,
        role: p.role,
        addedAt: p.addedAt.getTime(),
        email: p.email,
        displayName: nameFor(user, p.userId, p.displayName),
      })),
      invites: invites.map((i) => ({ id: i.id, invitedEmail: i.invitedEmail, role: i.role, expiresAt: i.expiresAt.getTime() })),
      clubs: clubs.map((c) => ({ orgId: c.orgId, name: c.name, slug: c.slug, createdAt: c.createdAt.getTime(), via: c.via ?? null })),
      myClubs: mine,
      usedIn: await usedIn(user, req.params.id),
    };
  });

  // ---- share with a club -----------------------------------------------------
  app.post<{ Params: { id: string }; Body: { orgSlug?: unknown } }>(
    '/api/modules/:id/club-shares',
    { config: { apiToken: 'layouts:write', rateLimit: perPerson(30, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      if (isDemoUser(user)) return reply.code(403).send({ error: 'demo_account_cannot_share' });
      const { role } = await resolveResourceRole(user.id, 'module', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });
      if (!hasAtLeast(role, 'owner')) return reply.code(403).send({ error: 'forbidden' });
      const mod = await db
        .select({ ownerOrgId: schema.modules.ownerOrgId, title: schema.modules.title })
        .from(schema.modules)
        .where(eq(schema.modules.id, req.params.id))
        .get();
      if (!mod) return reply.code(404).send({ error: 'not_found' });
      // A club's own module: to a partner club straight away, or offered to any other club.
      if (mod.ownerOrgId) return shareClubModule(req.params.id, mod.ownerOrgId, mod.title, slugFrom(req.body?.orgSlug), user, reply);
      const slug = typeof req.body?.orgSlug === 'string' ? req.body.orgSlug.trim().toLowerCase() : '';
      if (!slug) return reply.code(400).send({ error: 'invalid_club' });
      const org = await db.select({ id: schema.orgs.id, name: schema.orgs.name, slug: schema.orgs.slug }).from(schema.orgs).where(eq(schema.orgs.slug, slug)).get();
      // A club the caller isn't in is not found, as everywhere else.
      if (!org || !(await clubAccess(user.id, org.id))) return reply.code(404).send({ error: 'org_not_found' });
      const have = await clubSharesOf(req.params.id);
      if (have.some((c) => c.orgId === org.id)) return { ok: true, orgId: org.id, name: org.name, slug: org.slug, already: true };
      if (have.length >= MAX_CLUB_SHARES) return reply.code(400).send({ error: 'too_many_club_shares', limit: MAX_CLUB_SHARES });
      await db
        .insert(schema.moduleClubShares)
        .values({ moduleId: req.params.id, orgId: org.id, sharedBy: user.id, createdAt: new Date() })
        .onConflictDoNothing();
      await moduleSharesChanged(req.params.id);
      await writeAuditEvent({
        resourceKind: 'module',
        resourceId: req.params.id,
        userId: user.id,
        eventType: 'share',
        payload: { club: org.id, readOnly: true },
      });
      await notify({
        type: 'sharing.module_shared',
        to: await clubMemberIds(org.id),
        actor: user.id,
        club: org.id,
        needsMembership: true,
        subject: { kind: 'module', id: req.params.id },
        title: `${publicName(user.id, user.displayName)} shared the module “${mod.title}” with ${org.name}`,
        body: 'You can place it in the club’s layouts, and you get its updates.',
        link: `/orgs/${org.slug}`,
        groupKey: `shared:${org.id}`,
      });
      return reply.code(201).send({ ok: true, orgId: org.id, name: org.name, slug: org.slug });
    },
  );

  // ---- stop sharing with a club ----------------------------------------------
  app.delete<{ Params: { id: string; orgId: string } }>(
    '/api/modules/:id/club-shares/:orgId',
    { config: { apiToken: 'layouts:write' } },
    async (req, reply) => {
      const user = requireUser(req);
      const { role } = await resolveResourceRole(user.id, 'module', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });
      // The module's owner stops it; so can the club it's shared with: its admins and
      // managers (whoever may delete the club's items) take it off the club's list.
      const isOwner = hasAtLeast(role, 'owner');
      const access = isOwner ? null : await clubAccess(user.id, req.params.orgId);
      const forClub = !!access && (access.isAdmin || access.permissions.has('delete_items'));
      if (!isOwner && !forClub) return reply.code(403).send({ error: 'forbidden' });
      const mod = await db
        .select({ title: schema.modules.title, ownerUserId: schema.modules.ownerUserId, ownerOrgId: schema.modules.ownerOrgId })
        .from(schema.modules)
        .where(eq(schema.modules.id, req.params.id))
        .get();
      const club = await db.select({ name: schema.orgs.name, slug: schema.orgs.slug }).from(schema.orgs).where(eq(schema.orgs.id, req.params.orgId)).get();
      const gone = await db
        .delete(schema.moduleClubShares)
        .where(and(eq(schema.moduleClubShares.moduleId, req.params.id), eq(schema.moduleClubShares.orgId, req.params.orgId)))
        .run();
      if (gone.changes === 0) return reply.code(404).send({ error: 'not_shared' });
      await moduleSharesChanged(req.params.id);
      await writeAuditEvent({
        resourceKind: 'module',
        resourceId: req.params.id,
        userId: user.id,
        eventType: 'unshare',
        payload: { club: req.params.orgId, ...(isOwner ? {} : { byClub: true }) },
      });
      // Stopped by its owner: the club's members who look after its things hear it.
      if (isOwner && club && mod) {
        await notifyClub(req.params.orgId, 'club_note', {
          type: 'sharing.module_unshared',
          actor: user.id,
          subject: { kind: 'module', id: req.params.id },
          title: `The module “${mod.title}” is no longer shared with ${club.name}`,
          body: 'Copies already placed in the club’s layouts stay as they are, marked “No longer shared”, and get no more updates.',
          link: `/orgs/${club.slug}`,
        });
      }
      // Taken off by the club: a club's module's own club is told, through its Admins and Managers.
      if (!isOwner && mod?.ownerOrgId && club) {
        const owning = await db.select({ slug: schema.orgs.slug }).from(schema.orgs).where(eq(schema.orgs.id, mod.ownerOrgId)).get();
        await noteToClub(
          mod.ownerOrgId,
          user.id,
          `${club.name} took your club’s module “${mod.title}” off its shared modules. Copies already placed in its layouts stay as they are and get no more updates. You can share it with the club again.`,
          owning ? `/orgs/${owning.slug}?tab=partners` : null,
          { type: 'sharing.module_unshared', title: `${club.name} took “${mod.title}” off its shared modules` },
        );
      }
      // Taken off by the club: its owner is told (a note in the app). Copies already placed stay, at their version.
      if (!isOwner && mod?.ownerUserId && mod.ownerUserId !== user.id && club) {
        await postPersonalNote(
          mod.ownerUserId,
          `${club.name} took your module “${mod.title}” off the club’s shared modules. Copies already placed in its layouts stay as they are and get no more updates. You can share it with the club again.`,
          `/orgs/${club.slug}`,
          { clubOrgId: req.params.orgId, issuedBy: user.id, kind: { type: 'sharing.module_unshared', title: `${club.name} took “${mod.title}” off its shared modules` } },
        );
      }
      return { ok: true };
    },
  );

  // ---- take back an offer (or forget a declined one) -------------------------
  app.delete<{ Params: { id: string; offerId: string } }>(
    '/api/modules/:id/club-offers/:offerId',
    { config: { apiToken: 'layouts:write', rateLimit: perPerson(30, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      const { role } = await resolveResourceRole(user.id, 'module', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });
      if (!hasAtLeast(role, 'owner')) return reply.code(403).send({ error: 'forbidden' });
      const gone = await db
        .delete(schema.moduleClubOffers)
        .where(and(eq(schema.moduleClubOffers.id, req.params.offerId), eq(schema.moduleClubOffers.moduleId, req.params.id)))
        .returning()
        .all();
      if (gone.length === 0) return reply.code(404).send({ error: 'offer_not_found' });
      await resolve({ kind: 'module_offer', id: gone[0]!.id }, 'withdrawn', user.id);
      if (gone[0]!.state === 'pending') {
        await writeAuditEvent({
          resourceKind: 'org',
          resourceId: gone[0]!.fromOrgId,
          userId: user.id,
          eventType: 'module_offer_withdraw',
          payload: { module: req.params.id, to: gone[0]!.toOrgId },
        });
      }
      return { ok: true, toOrgId: gone[0]!.toOrgId };
    },
  );

  // ---- a club's module: its partners, and clubs to offer it to ------------------
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>(
    '/api/modules/:id/club-targets',
    { config: { apiToken: 'layouts:read', rateLimit: perPerson(60, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      const { role } = await resolveResourceRole(user.id, 'module', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });
      if (!hasAtLeast(role, 'owner')) return reply.code(403).send({ error: 'forbidden' });
      const mod = await db.select({ ownerOrgId: schema.modules.ownerOrgId }).from(schema.modules).where(eq(schema.modules.id, req.params.id)).get();
      if (!mod?.ownerOrgId) return reply.code(400).send({ error: 'not_a_club_module' });
      const partnerIds = new Set((await partnersOf(mod.ownerOrgId)).map((p) => p.org.id));
      const shared = new Set((await clubSharesOf(req.params.id)).map((c) => c.orgId));
      const offers = new Map(
        (await db.select().from(schema.moduleClubOffers).where(eq(schema.moduleClubOffers.moduleId, req.params.id)).all()).map((o) => [o.toOrgId, o.state]),
      );
      // Listed clubs only (the Clubs directory); a club that isn't listed is reached by its link.
      const needle = (req.query.q ?? '').trim().slice(0, 80);
      const found = needle
        ? await db
            .select()
            .from(schema.orgs)
            .where(
              and(
                eq(schema.orgs.listed, true),
                isNull(schema.orgs.deletionRequestedAt),
                sql`(${schema.orgs.name} LIKE ${`%${escapeLike(needle)}%`} ESCAPE '\\' OR ${schema.orgs.slug} LIKE ${`%${escapeLike(needle)}%`} ESCAPE '\\')`,
              ),
            )
            .orderBy(sql`lower(${schema.orgs.name})`)
            .limit(20)
            .all()
        : [];
      const clubs = found.filter((o) => o.id !== mod.ownerOrgId);
      const logos = await clubLogoUrls(clubs);
      return {
        clubs: clubs.map((o) => ({
          orgId: o.id,
          name: o.name,
          slug: o.slug,
          logoUrl: logos.get(o.id) ?? null,
          partner: partnerIds.has(o.id),
          shared: shared.has(o.id),
          offer: offers.get(o.id) ?? null,
        })),
      };
    },
  );
}

/** A club's module in its Share dialog: the club, its partners still to share with, and its offers. */
async function clubToClub(moduleId: string, ownerOrgId: string, viewerId: string) {
  const owning = await db.select({ id: schema.orgs.id, name: schema.orgs.name, slug: schema.orgs.slug }).from(schema.orgs).where(eq(schema.orgs.id, ownerOrgId)).get();
  const partners = (await partnersOf(ownerOrgId)).map((p) => p.org);
  const offers = await db
    .select({ offer: schema.moduleClubOffers, org: schema.orgs })
    .from(schema.moduleClubOffers)
    .innerJoin(schema.orgs, eq(schema.orgs.id, schema.moduleClubOffers.toOrgId))
    .where(eq(schema.moduleClubOffers.moduleId, moduleId))
    .orderBy(schema.moduleClubOffers.createdAt)
    .all();
  const logos = await clubLogoUrls([...partners, ...offers.map((o) => o.org)]);
  const offersOut = [];
  for (const { offer, org } of offers) {
    if (!isLive(org)) continue;
    // A club that isn't listed is named only once it's a partner (or the viewer is in it).
    const named = org.listed || partners.some((p) => p.id === org.id) || !!(await clubAccess(viewerId, org.id));
    offersOut.push({
      id: offer.id,
      club: named ? { orgId: org.id, name: org.name, slug: org.slug, logoUrl: logos.get(org.id) ?? null } : { orgId: null, name: null, slug: org.slug, logoUrl: null },
      state: offer.state as 'pending' | 'declined',
      createdAt: offer.createdAt.getTime(),
      askAgainAt: offer.state === 'declined' && offer.decidedAt ? offer.decidedAt.getTime() + ASK_AGAIN_AFTER_MS : null,
    });
  }
  return {
    club: owning ?? null,
    partners: partners.map((o) => ({ orgId: o.id, name: o.name, slug: o.slug, logoUrl: logos.get(o.id) ?? null })),
    offers: offersOut,
  };
}

type Replyish = { code: (n: number) => { send: (b: unknown) => unknown } };

/**
 * Share a club's module with another club: straight away with a partner,
 * otherwise as an offer its Admins or Managers accept or decline.
 */
async function shareClubModule(
  moduleId: string,
  ownerOrgId: string,
  title: string,
  slug: string,
  user: { id: string; displayName: string | null },
  reply: Replyish,
) {
  if (!slug) return reply.code(400).send({ error: 'invalid_club' });
  const org = await loadOrgBySlug(slug);
  if (!org || !isLive(org)) return reply.code(404).send({ error: 'org_not_found' });
  if (org.id === ownerOrgId) return reply.code(400).send({ error: 'same_club' });
  const from = await db.select().from(schema.orgs).where(eq(schema.orgs.id, ownerOrgId)).get();
  if (!from) return reply.code(404).send({ error: 'not_found' });
  const partner = await arePartners(ownerOrgId, org.id);
  const named = org.listed || partner || !!(await clubAccess(user.id, org.id));
  const shown = named ? { orgId: org.id, name: org.name, slug: org.slug } : { orgId: null, name: null, slug: org.slug };
  const have = await clubSharesOf(moduleId);
  if (have.some((c) => c.orgId === org.id)) return { ok: true, status: 'shared' as const, ...shown, already: true };
  if (have.length >= MAX_CLUB_SHARES) return reply.code(400).send({ error: 'too_many_club_shares', limit: MAX_CLUB_SHARES });
  if (partner) {
    db.transaction((tx) => {
      tx.insert(schema.moduleClubShares)
        .values({ moduleId, orgId: org.id, sharedBy: user.id, createdAt: new Date(), via: 'partner', fromOrgId: ownerOrgId })
        .onConflictDoNothing()
        .run();
      // An offer to a club that became a partner meanwhile is answered by this.
      tx.delete(schema.moduleClubOffers).where(and(eq(schema.moduleClubOffers.moduleId, moduleId), eq(schema.moduleClubOffers.toOrgId, org.id))).run();
    });
    await moduleSharesChanged(moduleId);
    await writeAuditEvent({ resourceKind: 'module', resourceId: moduleId, userId: user.id, eventType: 'share', payload: { club: org.id, readOnly: true, via: 'partner' } });
    await notify({
      type: 'sharing.module_shared',
      to: await clubMemberIds(org.id),
      actor: user.id,
      club: org.id,
      needsMembership: true,
      subject: { kind: 'module', id: moduleId },
      title: `${from.name} shared the module “${title}” with ${org.name}`,
      body: 'Your partner club shared it. You can place it in the club’s layouts, and you get its updates.',
      link: `/orgs/${org.slug}`,
      groupKey: `shared:${org.id}`,
    });
    return reply.code(201).send({ ok: true, status: 'shared' as const, ...shown, via: 'partner' });
  }
  // An offer: one per club, sent again only a day after a decline; a few at a time.
  const existing = await db
    .select()
    .from(schema.moduleClubOffers)
    .where(and(eq(schema.moduleClubOffers.moduleId, moduleId), eq(schema.moduleClubOffers.toOrgId, org.id)))
    .get();
  if (existing?.state === 'pending') return { ok: true, status: 'offered' as const, offerId: existing.id, ...shown, already: true };
  const now = new Date();
  if (existing?.state === 'declined' && existing.decidedAt && now.getTime() - existing.decidedAt.getTime() < ASK_AGAIN_AFTER_MS) {
    return reply.code(429).send({
      error: 'declined_recently',
      askAgainAt: existing.decidedAt.getTime() + ASK_AGAIN_AFTER_MS,
      message: 'That club declined this module. You can offer it again a day after it declined.',
    });
  }
  const waiting = await db
    .select({ to: schema.moduleClubOffers.toOrgId })
    .from(schema.moduleClubOffers)
    .where(and(eq(schema.moduleClubOffers.fromOrgId, ownerOrgId), eq(schema.moduleClubOffers.state, 'pending')))
    .all();
  if (waiting.length >= OPEN_MODULE_OFFERS_MAX || waiting.filter((w) => w.to === org.id).length >= OPEN_OFFERS_PER_CLUB_MAX) {
    return reply.code(429).send({
      error: 'too_many_offers',
      message: 'Your club has many module offers waiting for an answer already. Take some back, or wait for an answer.',
    });
  }
  const id = existing?.id ?? randomUUID();
  if (existing) {
    await db
      .update(schema.moduleClubOffers)
      .set({ state: 'pending', offeredBy: user.id, fromOrgId: ownerOrgId, createdAt: now, decidedAt: null, decidedBy: null })
      .where(eq(schema.moduleClubOffers.id, existing.id));
  } else {
    await db.insert(schema.moduleClubOffers).values({ id, moduleId, fromOrgId: ownerOrgId, toOrgId: org.id, offeredBy: user.id, state: 'pending', createdAt: now });
  }
  await writeAuditEvent({ resourceKind: 'org', resourceId: ownerOrgId, userId: user.id, eventType: 'module_offer', payload: { module: moduleId, to: org.id } });
  await writeAuditEvent({ resourceKind: 'org', resourceId: org.id, userId: user.id, eventType: 'module_offer', payload: { module: moduleId, from: ownerOrgId } });
  await notifyClub(org.id, 'club_note', {
    type: 'club.offer_received',
    actor: user.id,
    subject: { kind: 'module_offer', id },
    title: `${from.name} wants to share “${title}” with ${org.name}`,
    body: 'If your club accepts, its members can place the module in the club’s layouts and get its updates. They can’t change its parts.',
    link: `/orgs/${org.slug}?tab=partners`,
  });
  void emailClubRunners(org, user.id, `${from.name} wants to share “${title}” with ${org.name}`, [
    `${from.name} wants to share its module “${title}” with ${org.name}.`,
    'If your club accepts, its members can place the module in the club’s layouts and get its updates. They can’t change its parts.',
    'Your club’s Admins and Managers can accept or decline it on the club’s Partners page.',
  ]);
  return reply.code(202).send({ ok: true, status: 'offered' as const, offerId: id, ...shown });
}
