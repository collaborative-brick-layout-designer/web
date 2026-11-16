// Sharing a module read-only (docs/shared-modules.md).
//
//   GET    /api/modules/:id/shares               who it's shared with, and where it's used (its owners)
//   POST   /api/modules/:id/club-shares          share with a club you're in  { orgSlug }
//   DELETE /api/modules/:id/club-shares/:orgId   stop sharing with that club
//
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
    // The clubs it could be shared with: the caller's own (a club's module isn't shared on to another club).
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
      /** False for a club's module: its members already see it, and it can't be shared on to another club. */
      canShareWithClubs: !mod.ownerOrgId,
      people: people.map((p) => ({
        userId: p.userId,
        role: p.role,
        addedAt: p.addedAt.getTime(),
        email: p.email,
        displayName: nameFor(user, p.userId, p.displayName),
      })),
      invites: invites.map((i) => ({ id: i.id, invitedEmail: i.invitedEmail, role: i.role, expiresAt: i.expiresAt.getTime() })),
      clubs: clubs.map((c) => ({ orgId: c.orgId, name: c.name, slug: c.slug, createdAt: c.createdAt.getTime() })),
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
      // A club's own module is already its members'; sharing it on to another club isn't offered.
      if (mod.ownerOrgId) return reply.code(400).send({ error: 'club_module_not_shareable' });
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
        .select({ title: schema.modules.title, ownerUserId: schema.modules.ownerUserId })
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
      // Taken off by the club: its owner is told (a note in the app). Copies already placed stay, at their version.
      if (!isOwner && mod?.ownerUserId && mod.ownerUserId !== user.id && club) {
        await postPersonalNote(
          mod.ownerUserId,
          `${club.name} took your module “${mod.title}” off the club’s shared modules. Copies already placed in its layouts stay as they are and get no more updates. You can share it with the club again.`,
          `/orgs/${club.slug}`,
          { clubOrgId: req.params.orgId, issuedBy: user.id },
        );
      }
      return { ok: true };
    },
  );
}
