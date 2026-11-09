// Organization endpoints (Phase 6).
//
// What a member may do comes from the roles they hold (access/clubPermissions.ts):
// each club starts with Admin, Manager, Member and Viewer and can make its
// own; a member's permissions are the union of their roles'. Routes ask a
// permission (`can`, or `getMembership(...).permissions`), never a role's
// name. Only the Admin role (`isAdmin`) changes the club's settings, hands
// it over or deletes it; it always has every permission, and a club always
// keeps one Admin.
//
// The creator of an org becomes its first admin.
//
// The demo account can't create, join or invite to clubs
// (demo/demoAccount.ts).

import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { checkGrowth } from '../limits/limits.js';
import { requireUser } from '../auth/cookie.js';
import { isDemoUser } from '../demo/demoAccount.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { sendInviteEmailCapped } from '../email/inviteEmailCap.js';
import { env } from '../env.js';
import { escapeLike, isValidEmail, normalizeEmail, trimmed } from '../utils/validate.js';
import { isClubRole, type ClubRole } from '../access/clubRoles.js';
import {
  adminCount,
  clubAccess,
  clubAccessMap,
  clubRoleList,
  ensureClubRoles,
  has,
  isClubPermission,
  normalizePermissions,
  setMemberRoles,
  lesserRole,
  type ClubAccess,
  type ClubPermission,
  type ClubRoleRow,
} from '../access/clubPermissions.js';
import { clubReviewCount } from './clubReview.js';
import { hears } from '../access/clubNotices.js';
import { nameFor, publicName } from '../utils/publicName.js';
import { requestClubDeletion, type CatalogChoice } from '../privacy/clubDeletion.js';
import { perPerson } from '../utils/rateLimits.js';
import { maskEmail } from '../utils/maskEmail.js';
import { notifyAccessChanged } from '../ws/liveAccess.js';
import { hidingLastActive, lastActiveBucket, type LastActive } from './preferences.js';
import { clubLogoUrls } from './clubLogos.js';

interface CreateOrgBody {
  name: string;
  /**
   * Optional. When omitted (or empty) the server auto-derives a slug
   * from `name` and disambiguates with a numeric suffix on collision.
   * Older clients still send a manual slug.
   */
  slug?: string;
}

/**
 * Slugify a name into a URL-safe identifier. Lowercase, replace any
 * non-alnum run with `-`, trim leading/trailing `-`, cap at 40 chars.
 * Falls back to `'org'` for names with no usable characters (CJK only,
 * empty, etc.) so the suffix-disambig loop has something to grow.
 */
function slugifyName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  return cleaned || 'org';
}

interface OrgMemberInviteBody {
  /**
   * Either an email (existing flow — works whether or not the address
   * has an account yet) OR a userId (the invite-autocomplete path, see
   * GET /api/orgs/:slug/user-search — that endpoint deliberately never
   * exposes an arbitrary user's email to the searching admin, so
   * picking a suggestion invites by id and the server resolves the
   * email itself). Exactly one of the two should be set; email wins if
   * both are present.
   */
  email?: string;
  userId?: string;
  role?: ClubRole;
  /** One of the club's roles by id (custom roles); wins over `role`. */
  roleId?: string;
  /** How long the invite lasts, 1 to 30 days (default 14). */
  expiresInDays?: number;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const ORG_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** An invite's lifetime: `expiresInDays` (1 to 30), else 14 days; null when out of range. */
function inviteTtlMs(days: unknown): number | null {
  if (days === undefined || days === null) return ORG_INVITE_TTL_MS;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 30) return null;
  return days * 24 * 60 * 60 * 1000;
}

export async function orgRoutes(app: FastifyInstance): Promise<void> {
  // ---- list orgs the current user belongs to -----------------------------
  // The desktop reads this with its API token too, for Publish to Server's
  // owner picker (layouts:read: your own memberships).
  app.get('/api/orgs', { config: { apiToken: 'layouts:read' } }, async (req) => {
    const user = requireUser(req);
    const rows = await db
      .select({
        id: schema.orgs.id,
        name: schema.orgs.name,
        slug: schema.orgs.slug,
        createdAt: schema.orgs.createdAt,
        myRole: schema.orgMembers.role,
        trusted: schema.orgs.trusted,
        membersCanCreate: schema.orgs.membersCanCreate,
      })
      .from(schema.orgMembers)
      .innerJoin(schema.orgs, eq(schema.orgs.id, schema.orgMembers.orgId))
      .where(eq(schema.orgMembers.userId, user.id));

    const access = await clubAccessMap(user.id);
    const logos = await clubLogoUrls(rows);
    // The names of the roles I hold, in each club's order ("you are Viewer, Track crew").
    const heldIds = [...access.values()].flatMap((a) => a.roleIds);
    const roleRows = heldIds.length
      ? await db
          .select({ id: schema.clubRoles.id, name: schema.clubRoles.name, position: schema.clubRoles.position })
          .from(schema.clubRoles)
          .where(inArray(schema.clubRoles.id, heldIds))
          .orderBy(schema.clubRoles.position)
      : [];
    const roleNamesIn = (orgId: string) => {
      const ids = access.get(orgId)?.roleIds ?? [];
      return roleRows.filter((r) => ids.includes(r.id)).map((r) => r.name);
    };
    // Whoever reviews a trusted club's shares sees what waits in its queue.
    const reviews = new Map<string, number>();
    for (const r of rows) if (r.trusted && has(access.get(r.id), 'send_catalog')) reviews.set(r.id, await clubReviewCount(r.id));
    return {
      orgs: rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        createdAt: r.createdAt.getTime(),
        myRole: r.myRole,
        trusted: r.trusted,
        // May I save new things to it (layouts, modules, venues, parts)?
        // The same rule as destinationOrg (owners.ts), so "Save to" only
        // offers the clubs that will take it.
        canAdd: has(access.get(r.id), 'start_layouts'),
        // What my roles in it let me do (access/clubPermissions.ts).
        permissions: [...(access.get(r.id)?.permissions ?? [])],
        isAdmin: !!access.get(r.id)?.isAdmin,
        roleNames: roleNamesIn(r.id),
        logoUrl: logos.get(r.id) ?? null,
        ...(reviews.has(r.id) ? { pendingReviews: reviews.get(r.id) } : {}),
      })),
    };
  });

  // ---- create org ---------------------------------------------------------
  app.post<{ Body: CreateOrgBody }>('/api/orgs', async (req, reply) => {
    const user = requireUser(req);
    if (isDemoUser(user)) {
      return reply.code(403).send({ error: 'demo_account_cannot_create_org' });
    }
    const name = trimmed(req.body.name);
    const requestedSlug = trimmed(req.body.slug)?.toLowerCase();
    if (!name || name.length < 1 || name.length > 80) {
      return reply.code(400).send({ error: 'invalid_name' });
    }
    // Confirmed email first; a week-old account may start one club; then the limit.
    const refusal = await checkGrowth({ actor: user, owner: { kind: 'user', id: user.id }, add: { clubs: 1 } });
    if (refusal) return reply.code(refusal.status).send(refusal.body);

    // Resolve the final slug. If the caller passed one, validate it
    // and reject collisions explicitly so they see a clear error.
    // If they didn't, auto-derive from `name` and append a numeric
    // suffix until it's unique. This makes the UI a one-field form
    // (just "Name") in the common case.
    let slug: string;
    if (requestedSlug) {
      if (!SLUG_RE.test(requestedSlug)) {
        return reply.code(400).send({ error: 'invalid_slug' });
      }
      const collide = await db
        .select()
        .from(schema.orgs)
        .where(eq(schema.orgs.slug, requestedSlug))
        .get();
      if (collide) return reply.code(409).send({ error: 'slug_taken' });
      slug = requestedSlug;
    } else {
      const base = slugifyName(name).slice(0, 36); // leave room for `-99`
      slug = base;
      for (let n = 2; n < 100; n++) {
        const collide = await db
          .select()
          .from(schema.orgs)
          .where(eq(schema.orgs.slug, slug))
          .get();
        if (!collide) break;
        slug = `${base}-${n}`;
      }
    }

    const id = randomUUID();
    const now = new Date();
    await db.insert(schema.orgs).values({ id, name, slug, createdAt: now, createdBy: user.id });
    await db.insert(schema.orgMembers).values({
      orgId: id,
      userId: user.id,
      role: 'admin',
      joinedAt: now,
    });
    await ensureClubRoles(id);
    await writeAuditEvent({
      resourceKind: 'org',
      resourceId: id,
      userId: user.id,
      eventType: 'create',
      payload: { name, slug },
    });
    return reply.code(201).send({ id, name, slug });
  });

  // ---- get org by slug ----------------------------------------------------
  app.get<{ Params: { slug: string } }>('/api/orgs/:slug', async (req, reply) => {
    const user = requireUser(req);
    const org = await loadOrgBySlug(req.params.slug);
    if (!org) return reply.code(404).send({ error: 'not_found' });

    const myMembership = await getMembership(org.id, user.id);
    if (!myMembership) return reply.code(404).send({ error: 'not_found' });

    const counts = await db
      .select({ role: schema.orgMembers.role })
      .from(schema.orgMembers)
      .where(eq(schema.orgMembers.orgId, org.id));
    const perms = myMembership.permissions;
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      createdAt: org.createdAt.getTime(),
      myRole: myMembership.role,
      permissions: [...perms],
      isAdmin: myMembership.isAdmin,
      roleNames: (await clubRoleList(org.id)).filter((r) => myMembership.roleIds.includes(r.id)).map((r) => r.name),
      description: org.description ?? '',
      membersCanCreate: org.membersCanCreate,
      memberCount: counts.length,
      adminCount: await adminCount(org.id),
      joinPolicy: org.joinPolicy,
      trusted: org.trusted,
      listed: org.listed,
      logoUrl: (await clubLogoUrls([org])).get(org.id) ?? null,
      // Admins see how many people are waiting to be let in, and (a
      // trusted club) how many shares wait in its review queue.
      ...(hears(myMembership, 'join_request')
        ? {
            pendingRequests: (
              await db.select({ id: schema.orgJoinRequests.id }).from(schema.orgJoinRequests).where(eq(schema.orgJoinRequests.orgId, org.id))
            ).length,
          }
        : {}),
      ...(org.trusted && perms.has('send_catalog') ? { pendingReviews: await clubReviewCount(org.id) } : {}),
    };
  });

  // ---- club settings (admins) ---------------------------------------------
  // Name, address (slug), description, whether members may add layouts,
  // venues and modules to the club, who can join, and whether it is listed
  // in the Clubs directory.
  app.patch<{
    Params: { slug: string };
    Body: { name?: unknown; slug?: unknown; description?: unknown; membersCanCreate?: unknown; joinPolicy?: unknown; listed?: unknown };
  }>('/api/orgs/:slug', async (req, reply) => {
    const user = requireUser(req);
    const org = await loadOrgBySlug(req.params.slug);
    if (!org) return reply.code(404).send({ error: 'not_found' });
    const mine = await getMembership(org.id, user.id);
    if (!mine) return reply.code(404).send({ error: 'not_found' });
    if (!mine.isAdmin) return reply.code(403).send({ error: 'forbidden' });

    const body = req.body ?? {};
    const updates: Partial<typeof schema.orgs.$inferInsert> = {};
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 80) return reply.code(400).send({ error: 'invalid_name' });
      updates.name = name;
    }
    if (body.slug !== undefined) {
      const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '';
      if (!SLUG_RE.test(slug)) return reply.code(400).send({ error: 'invalid_slug' });
      if (slug !== org.slug) {
        const taken = await db.select({ id: schema.orgs.id }).from(schema.orgs).where(eq(schema.orgs.slug, slug)).get();
        if (taken) return reply.code(409).send({ error: 'slug_taken' });
        updates.slug = slug;
      }
    }
    if (body.description !== undefined) {
      if (typeof body.description !== 'string' || body.description.length > 500) {
        return reply.code(400).send({ error: 'invalid_description' });
      }
      updates.description = body.description.trim() || null;
    }
    if (body.membersCanCreate !== undefined) {
      if (typeof body.membersCanCreate !== 'boolean') return reply.code(400).send({ error: 'invalid_input' });
      updates.membersCanCreate = body.membersCanCreate;
    }
    if (body.joinPolicy !== undefined) {
      if (body.joinPolicy !== 'invite' && body.joinPolicy !== 'request' && body.joinPolicy !== 'open') {
        return reply.code(400).send({ error: 'invalid_join_policy' });
      }
      updates.joinPolicy = body.joinPolicy;
    }
    if (body.listed !== undefined) {
      if (typeof body.listed !== 'boolean') return reply.code(400).send({ error: 'invalid_input' });
      updates.listed = body.listed;
    }
    if (Object.keys(updates).length === 0) return reply.code(400).send({ error: 'no_updates' });

    await db.update(schema.orgs).set(updates).where(eq(schema.orgs.id, org.id));
    if (updates.membersCanCreate !== undefined) {
      // "Members can add things" is the Member role's two adding permissions.
      const member = (await clubRoleList(org.id)).find((r) => r.key === 'member');
      if (member) {
        const without = member.permissions.filter((p) => p !== 'start_layouts' && p !== 'edit_modules');
        const next = updates.membersCanCreate ? [...without, 'start_layouts', 'edit_modules'] : without;
        await db.update(schema.clubRoles).set({ permissions: JSON.stringify(next) }).where(eq(schema.clubRoles.id, member.id));
        await notifyClub(org.id);
      }
    }
    await writeAuditEvent({
      resourceKind: 'org',
      resourceId: org.id,
      userId: user.id,
      eventType: 'settings',
      payload: { ...updates },
    });
    return { ok: true, slug: updates.slug ?? org.slug, name: updates.name ?? org.name };
  });

  // ---- delete the club (admins, typed confirmation) -----------------------
  // It waits first (the Privacy setting's days), hidden, and its admins or
  // a site admin can restore it (privacy/clubDeletion.ts). The body says
  // what happens to its public catalog items and collections: 'hand' them
  // to a member (heirUserId, default the admin deleting it) or 'takedown'.
  app.delete<{ Params: { slug: string }; Body: { confirm?: unknown; catalog?: unknown; heirUserId?: unknown } }>('/api/orgs/:slug', async (req, reply) => {
    const user = requireUser(req);
    const org = await loadOrgBySlug(req.params.slug);
    if (!org) return reply.code(404).send({ error: 'not_found' });
    const mine = await getMembership(org.id, user.id);
    if (!mine) return reply.code(404).send({ error: 'not_found' });
    if (!mine.isAdmin) return reply.code(403).send({ error: 'forbidden' });
    const typed = typeof req.body?.confirm === 'string' ? req.body.confirm.trim().toLowerCase() : '';
    if (typed !== org.name.trim().toLowerCase()) return reply.code(400).send({ error: 'confirm_name_mismatch' });
    const choice = await catalogChoice(org.id, req.body?.catalog, req.body?.heirUserId, user.id);
    if ('error' in choice) return reply.code(400).send(choice);
    const { dueAt } = await requestClubDeletion(org, user, choice);
    return { ok: true, dueAt: dueAt.getTime() };
  });

  // ---- hand the club over --------------------------------------------------
  // An admin makes another member an admin and steps down to member in one
  // go, so the club is never left without an admin.
  app.post<{ Params: { slug: string }; Body: { userId?: unknown } }>(
    '/api/orgs/:slug/hand-over',
    async (req, reply) => {
      const user = requireUser(req);
      const org = await loadOrgBySlug(req.params.slug);
      if (!org) return reply.code(404).send({ error: 'not_found' });
      const mine = await getMembership(org.id, user.id);
      if (!mine) return reply.code(404).send({ error: 'not_found' });
      if (!mine.isAdmin) return reply.code(403).send({ error: 'forbidden' });
      const targetId = typeof req.body?.userId === 'string' ? req.body.userId : '';
      if (!targetId || targetId === user.id) return reply.code(400).send({ error: 'invalid_input' });
      const target = await getMembership(org.id, targetId);
      if (!target) return reply.code(404).send({ error: 'member_not_found' });

      // The new admin keeps their other roles; the old one keeps theirs but
      // Admin (and becomes a Member when that was all they held).
      const adminId = `${org.id}:admin`;
      await setMemberRoles(org.id, targetId, [...new Set([...target.roleIds, adminId])]);
      const left = mine.roleIds.filter((r) => r !== adminId);
      await setMemberRoles(org.id, user.id, left.length ? left : [`${org.id}:member`]);
      notifyAccessChanged({ userId: targetId });
      notifyAccessChanged({ userId: user.id });
      await writeAuditEvent({
        resourceKind: 'org',
        resourceId: org.id,
        userId: user.id,
        eventType: 'hand_over',
        payload: { toUserId: targetId, fromUserId: user.id },
      });
      return { ok: true };
    },
  );

  // ---- list members + pending invites -------------------------------------
  // The desktop reads this with its API token too (layouts:read), for its
  // read-only Members view: names, roles and last active, never addresses
  // or invites (those stay on the website, where members are managed).
  app.get<{ Params: { slug: string } }>(
    '/api/orgs/:slug/members',
    { config: { apiToken: 'layouts:read' } },
    async (req, reply) => {
      const user = requireUser(req);
      const org = await loadOrgBySlug(req.params.slug);
      if (!org) return reply.code(404).send({ error: 'not_found' });
      const myMembership = await getMembership(org.id, user.id);
      if (!myMembership) return reply.code(404).send({ error: 'not_found' });

      const members = await db
        .select({
          userId: schema.orgMembers.userId,
          role: schema.orgMembers.role,
          joinedAt: schema.orgMembers.joinedAt,
          email: schema.users.email,
          displayName: schema.users.displayName,
          avatarUrl: schema.users.avatarUrl,
          lastSeenAt: schema.users.lastSeenAt,
        })
        .from(schema.orgMembers)
        .innerJoin(schema.users, eq(schema.users.id, schema.orgMembers.userId))
        .where(eq(schema.orgMembers.orgId, org.id));

      // Only the people who invite see pending invites (the email list is
      // somewhat sensitive). Everyone else gets an empty array.
      const runsMembers = has(myMembership, 'invite') || has(myMembership, 'manage_members');
      const viaToken = !!req.apiToken;
      // Roughly when each was last active, for the people who run the club
      // (and each person about themselves), unless they turned it off
      // (Settings › Privacy). Never the exact time.
      const hiding = runsMembers || user.isGlobalAdmin ? await hidingLastActive(members.map((m) => m.userId)) : new Set<string>();
      const lastActiveOf = (m: { userId: string; lastSeenAt: Date | null }): LastActive | null => {
        if (m.userId === user.id) return 'today'; // looking at it now
        if (!(runsMembers || user.isGlobalAdmin) || hiding.has(m.userId)) return null;
        return lastActiveBucket(m.lastSeenAt);
      };
      const held = await db
        .select({ userId: schema.memberRoles.userId, roleId: schema.memberRoles.roleId })
        .from(schema.memberRoles)
        .where(eq(schema.memberRoles.orgId, org.id));
      const rolesOf = (userId: string, legacy: ClubRole): string[] => {
        const ids = held.filter((h) => h.userId === userId).map((h) => h.roleId);
        return ids.length ? ids : [`${org.id}:${legacy}`];
      };
      const invites =
        runsMembers && !viaToken
          ? await db
              .select()
              .from(schema.orgInvites)
              .where(eq(schema.orgInvites.orgId, org.id))
              .then((rs) => rs.filter((i) => i.acceptedAt === null))
          : [];

      return {
        roles: await rolesWithCounts(org.id),
        members: members.map((m) => ({
          userId: m.userId,
          role: m.role,
          roleIds: rolesOf(m.userId, m.role),
          joinedAt: m.joinedAt.getTime(),
          // Members' addresses are for the people who run the club (and the
          // person themselves); everyone else sees only names.
          email: !viaToken && (runsMembers || m.userId === user.id || user.isGlobalAdmin) ? m.email : '',
          displayName: nameFor(user, m.userId, m.displayName),
          avatarUrl: m.avatarUrl,
          lastActive: lastActiveOf(m),
        })),
        invites: invites.map((i) => ({
          id: i.id,
          // An invite can be sent to a person picked by name, so the club's
          // managers see only a masked address.
          invitedEmail: user.isGlobalAdmin ? i.invitedEmail : maskEmail(i.invitedEmail),
          role: i.role,
          roleId: i.roleId ?? `${org.id}:${i.role}`,
          expiresAt: i.expiresAt.getTime(),
          // Admins only see invites at all; the link lets them send it themselves.
          inviteUrl: `${env.publicUrl}/org-invite/${i.token}`,
        })),
      };
    },
  );

  // ---- invite member ------------------------------------------------------
  app.post<{ Params: { slug: string }; Body: OrgMemberInviteBody }>(
    '/api/orgs/:slug/invites',
    { config: { rateLimit: perPerson(20, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      if (isDemoUser(user)) {
        return reply.code(403).send({ error: 'demo_account_cannot_invite' });
      }
      const org = await loadOrgBySlug(req.params.slug);
      if (!org) return reply.code(404).send({ error: 'not_found' });
      const myMembership = await getMembership(org.id, user.id);
      if (!myMembership) return reply.code(404).send({ error: 'not_found' });
      if (!has(myMembership, 'invite') && !has(myMembership, 'manage_members')) {
        return reply.code(403).send({ error: 'forbidden', permission: 'invite' });
      }

      // A built-in role by name (`role`), or any of the club's roles by id (`roleId`).
      const roles = await clubRoleList(org.id);
      const chosen =
        typeof req.body.roleId === 'string'
          ? roles.find((r) => r.id === req.body.roleId)
          : isClubRole(req.body.role)
            ? roles.find((r) => r.key === req.body.role)
            : undefined;
      if (!chosen) {
        return reply.code(400).send({ error: 'invalid_role' });
      }
      const role: ClubRole = chosen.key === 'admin' || chosen.key === 'manager' ? chosen.key : 'member';
      // Without "manage members and roles", people invite only to roles with less than their own.
      if (!mayGiveRole(myMembership, chosen)) {
        return reply.code(403).send({ error: 'only_admins_set_roles' });
      }
      const refusal = await checkGrowth({ actor: user, owner: { kind: 'org', id: org.id }, add: { members: 1 } });
      if (refusal) return reply.code(refusal.status).send(refusal.body);

      let email: string;
      let existingUser: typeof schema.users.$inferSelect | undefined;
      if (req.body.email) {
        if (!isValidEmail(req.body.email)) {
          return reply.code(400).send({ error: 'invalid_email' });
        }
        email = normalizeEmail(req.body.email);
        existingUser = await db
          .select()
          .from(schema.users)
          .where(sql`lower(${schema.users.email}) = ${email}`)
          .get();
      } else if (req.body.userId) {
        // The autocomplete path — resolve the email server-side so the
        // client (and the searching admin) never needs to see it.
        existingUser = await db.select().from(schema.users).where(eq(schema.users.id, req.body.userId)).get();
        if (!existingUser) return reply.code(404).send({ error: 'not_found' });
        email = existingUser.email;
      } else {
        return reply.code(400).send({ error: 'invalid_input' });
      }

      // Reject if the recipient is already a member.
      if (existingUser) {
        const m = await getMembership(org.id, existingUser.id);
        if (m) return reply.code(409).send({ error: 'already_member' });
      }

      const ttl = inviteTtlMs(req.body.expiresInDays);
      if (ttl === null) return reply.code(400).send({ error: 'invalid_expiry' });
      const token = randomBytes(24).toString('hex');
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + ttl);
      await db.insert(schema.orgInvites).values({
        id,
        orgId: org.id,
        invitedEmail: email,
        invitedBy: user.id,
        role,
        roleId: chosen.id,
        token,
        expiresAt,
        acceptedAt: null,
      });

      const inviteUrl = `${env.publicUrl}/org-invite/${token}`;
      const mail = await sendInviteEmailCapped(user, {
        to: email,
        inviteUrl,
        inviterName: publicName(user.id, user.displayName),
        what: 'club',
        name: org.name,
      });

      await writeAuditEvent({
        resourceKind: 'org',
        resourceId: org.id,
        userId: user.id,
        eventType: 'share',
        payload: { invitedEmail: email, role, roleId: chosen.id, roleName: chosen.name, inviteId: id },
      });

      return {
        id,
        token,
        inviteUrl,
        ...mail,
        expiresAt: expiresAt.getTime(),
      };
    },
  );

  // ---- search users to invite ---------------------------------------------
  // Org-admin-only (NOT the platform-wide /api/admin/users search — that
  // endpoint exposes isGlobalAdmin/isDemoAccount/emailVerified/storage
  // stats for every account and would be a privilege escalation if
  // reachable by a mere org admin). Lets the invite form autocomplete
  // against real accounts instead of the admin blind-typing an email
  // and only finding out it's wrong after submitting. Deliberately
  // narrow: short results, minimal fields (never a bare email match —
  // only id/displayName/avatarUrl, plus the org-membership status so
  // the UI can grey out people who are already members), a minimum
  // query length, and a low rate limit. It finds only people the searcher
  // already works with (a club or a layout in common, peopleIWorkWith):
  // anyone else, by name or by exact email, gets the same empty answer
  // from the same query whether or not they have an account, and is
  // invited by email (a link) instead.
  app.get<{ Params: { slug: string }; Querystring: { q?: string } }>(
    '/api/orgs/:slug/user-search',
    { config: { rateLimit: perPerson(20, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      const org = await loadOrgBySlug(req.params.slug);
      if (!org) return reply.code(404).send({ error: 'not_found' });
      const myMembership = await getMembership(org.id, user.id);
      if (!myMembership) return reply.code(404).send({ error: 'not_found' });
      if (!has(myMembership, 'invite') && !has(myMembership, 'manage_members')) {
        return reply.code(403).send({ error: 'forbidden', permission: 'invite' });
      }

      const needle = (req.query.q ?? '').trim();
      if (needle.length < 2) return { users: [] };
      const safe = `%${escapeLike(needle)}%`;

      const matches = await db
        .select({ id: schema.users.id, displayName: schema.users.displayName, avatarUrl: schema.users.avatarUrl })
        .from(schema.users)
        .where(
          and(
            ne(schema.users.id, user.id),
            sql`${schema.users.id} IN ${peopleIWorkWith(user.id)}`,
            or(
              // A name that is an email address is never a substring match:
              // that would make this an email search after all.
              and(sql`${schema.users.displayName} LIKE ${safe} ESCAPE '\\'`, sql`instr(${schema.users.displayName}, '@') = 0`),
              // Exact email match only (not a substring LIKE) — lets an
              // admin invite-by-pasting-the-exact-email still work
              // without turning this into an email substring search.
              sql`lower(${schema.users.email}) = ${normalizeEmail(needle)}`,
            ),
          ),
        )
        .limit(10);

      const memberIds = matches.length > 0
        ? new Set(
            (
              await db
                .select({ userId: schema.orgMembers.userId })
                .from(schema.orgMembers)
                .where(and(eq(schema.orgMembers.orgId, org.id), inArray(schema.orgMembers.userId, matches.map((m) => m.id))))
            ).map((r) => r.userId),
          )
        : new Set<string>();

      return {
        users: matches.map((m) => ({ ...m, displayName: nameFor(user, m.id, m.displayName), alreadyMember: memberIds.has(m.id) })),
      };
    },
  );

  // ---- revoke invite ------------------------------------------------------
  app.delete<{ Params: { slug: string; inviteId: string } }>(
    '/api/orgs/:slug/invites/:inviteId',
    async (req, reply) => {
      const user = requireUser(req);
      const org = await loadOrgBySlug(req.params.slug);
      if (!org) return reply.code(404).send({ error: 'not_found' });
      const myMembership = await getMembership(org.id, user.id);
      if (!myMembership) return reply.code(404).send({ error: 'not_found' });
      if (!has(myMembership, 'invite') && !has(myMembership, 'manage_members')) {
        return reply.code(403).send({ error: 'forbidden', permission: 'invite' });
      }
      // People who only invite look after invites to roles with less than theirs.
      const target = await db
        .select({ role: schema.orgInvites.role, roleId: schema.orgInvites.roleId })
        .from(schema.orgInvites)
        .where(and(eq(schema.orgInvites.id, req.params.inviteId), eq(schema.orgInvites.orgId, org.id)))
        .get();
      if (target && !mayGiveRole(myMembership, await inviteRole(org.id, target))) {
        return reply.code(403).send({ error: 'only_admins_set_roles' });
      }
      await db
        .delete(schema.orgInvites)
        .where(
          and(
            eq(schema.orgInvites.id, req.params.inviteId),
            eq(schema.orgInvites.orgId, org.id),
          ),
        );
      return { ok: true };
    },
  );

  // ---- resend an invite ------------------------------------------------------
  // Sends the same link again and gives it a fresh expiry.
  app.post<{ Params: { slug: string; inviteId: string }; Body: { expiresInDays?: unknown } }>(
    '/api/orgs/:slug/invites/:inviteId/resend',
    { config: { rateLimit: perPerson(20, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      const org = await loadOrgBySlug(req.params.slug);
      if (!org) return reply.code(404).send({ error: 'not_found' });
      const mine = await getMembership(org.id, user.id);
      if (!mine) return reply.code(404).send({ error: 'not_found' });
      if (!has(mine, 'invite') && !has(mine, 'manage_members')) return reply.code(403).send({ error: 'forbidden', permission: 'invite' });
      const invite = await db
        .select()
        .from(schema.orgInvites)
        .where(and(eq(schema.orgInvites.id, req.params.inviteId), eq(schema.orgInvites.orgId, org.id)))
        .get();
      if (!invite || invite.acceptedAt !== null) return reply.code(404).send({ error: 'not_found' });
      if (!mayGiveRole(mine, await inviteRole(org.id, invite))) return reply.code(403).send({ error: 'only_admins_set_roles' });
      const ttl = inviteTtlMs(req.body?.expiresInDays);
      if (ttl === null) return reply.code(400).send({ error: 'invalid_expiry' });
      const expiresAt = new Date(Date.now() + ttl);
      await db.update(schema.orgInvites).set({ expiresAt }).where(eq(schema.orgInvites.id, invite.id));
      const inviteUrl = `${env.publicUrl}/org-invite/${invite.token}`;
      const mail = await sendInviteEmailCapped(user, { to: invite.invitedEmail, inviteUrl, inviterName: publicName(user.id, user.displayName), what: 'club', name: org.name });
      return { ok: true, inviteUrl, ...mail, expiresAt: expiresAt.getTime() };
    },
  );

  // ---- change member role -------------------------------------------------
  // Old clients send one built-in `role`: the member then holds that one
  // instead of their built-in role(s), keeping any custom ones. New
  // clients send `roleIds`, every role the member holds.
  app.patch<{
    Params: { slug: string; userId: string };
    Body: { role?: unknown; roleIds?: unknown };
  }>('/api/orgs/:slug/members/:userId', async (req, reply) => {
    const user = requireUser(req);
    const org = await loadOrgBySlug(req.params.slug);
    if (!org) return reply.code(404).send({ error: 'not_found' });
    const myMembership = await getMembership(org.id, user.id);
    if (!myMembership) return reply.code(404).send({ error: 'not_found' });
    if (!has(myMembership, 'manage_members')) {
      return reply.code(403).send({ error: 'forbidden', permission: 'manage_members' });
    }

    const targetMembership = await getMembership(org.id, req.params.userId);
    if (!targetMembership) return reply.code(404).send({ error: 'member_not_found' });

    const roles = await clubRoleList(org.id);
    let next: string[];
    if (req.body?.roleIds !== undefined) {
      const ids = req.body.roleIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > roles.length || !ids.every((id) => typeof id === 'string' && roles.some((r) => r.id === id))) {
        return reply.code(400).send({ error: 'invalid_role', message: 'Pick at least one of the club’s roles.' });
      }
      next = [...new Set(ids as string[])];
    } else {
      const newRole = req.body?.role;
      if (!isClubRole(newRole)) {
        return reply.code(400).send({ error: 'invalid_role' });
      }
      const builtinIds = new Set(roles.filter((r) => r.key).map((r) => r.id));
      next = [...targetMembership.roleIds.filter((id) => !builtinIds.has(id)), `${org.id}:${newRole}`];
    }
    // Only an Admin gives or takes the Admin role.
    const adminId = `${org.id}:admin`;
    const hadAdmin = targetMembership.isAdmin;
    const getsAdmin = next.includes(adminId);
    if (hadAdmin !== getsAdmin && !myMembership.isAdmin) {
      return reply.code(403).send({ error: 'only_admins_set_roles' });
    }
    // Someone who isn't an Admin can't change their own roles, nor give or
    // take a role that has more than they have themselves.
    if (!myMembership.isAdmin) {
      if (req.params.userId === user.id) return reply.code(403).send({ error: 'only_admins_set_roles', message: 'Ask a club admin to change your own roles.' });
      const changed = [...next.filter((id) => !targetMembership.roleIds.includes(id)), ...targetMembership.roleIds.filter((id) => !next.includes(id))];
      const tooMuch = changed.some((id) => (roles.find((r) => r.id === id)?.permissions ?? []).some((p) => !myMembership.permissions.has(p)));
      if (tooMuch) return reply.code(403).send({ error: 'only_admins_set_roles', message: 'You can give or take only roles that have no more than your own.' });
    }
    // A club always keeps an admin.
    if (hadAdmin && !getsAdmin && (await adminCount(org.id)) <= 1) {
      return reply.code(409).send({ error: 'last_admin', message: 'A club needs at least one Admin. Make someone else an Admin first.' });
    }

    const before = targetMembership.roleIds.length ? targetMembership.roleIds : [`${org.id}:${targetMembership.role}`];
    await setMemberRoles(org.id, req.params.userId, next);
    const after = await getMembership(org.id, req.params.userId);
    const nameOf = (id: string) => roles.find((r) => r.id === id)?.name ?? 'a role';
    const added = next.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !next.includes(id));
    if (req.body?.roleIds === undefined) {
      await writeAuditEvent({
        resourceKind: 'org',
        resourceId: org.id,
        userId: user.id,
        eventType: 'role_change',
        payload: { targetUserId: req.params.userId, fromRole: targetMembership.role, toRole: after?.role ?? 'member' },
      });
    }
    for (const id of added) {
      await writeAuditEvent({ resourceKind: 'org', resourceId: org.id, userId: user.id, eventType: 'role_assign', payload: { targetUserId: req.params.userId, roleId: id, roleName: nameOf(id) } });
    }
    for (const id of removed) {
      await writeAuditEvent({ resourceKind: 'org', resourceId: org.id, userId: user.id, eventType: 'role_unassign', payload: { targetUserId: req.params.userId, roleId: id, roleName: nameOf(id) } });
    }
    // Open layouts and modules follow at once (read only, or editable again).
    notifyAccessChanged({ userId: req.params.userId });

    return { ok: true, roleIds: next, role: after?.role ?? 'member' };
  });

  // ---- club roles ------------------------------------------------------------
  // Everyone in the club sees its roles (what each lets people do); only
  // its Admins make, change and delete them. The Admin role always has
  // every permission and can't be changed; the four built-in roles can't be
  // deleted (old clients and invites name them), but all but Admin can be
  // renamed and re-ticked.
  app.get<{ Params: { slug: string } }>('/api/orgs/:slug/roles', async (req, reply) => {
    const user = requireUser(req);
    const org = await loadOrgBySlug(req.params.slug);
    if (!org) return reply.code(404).send({ error: 'not_found' });
    const mine = await getMembership(org.id, user.id);
    if (!mine) return reply.code(404).send({ error: 'not_found' });
    return { roles: await rolesWithCounts(org.id), mine: mine.roleIds, permissions: [...mine.permissions], isAdmin: mine.isAdmin };
  });

  app.post<{ Params: { slug: string }; Body: { name?: unknown; permissions?: unknown } }>(
    '/api/orgs/:slug/roles',
    { config: { rateLimit: perPerson(30, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      const org = await loadOrgBySlug(req.params.slug);
      if (!org) return reply.code(404).send({ error: 'not_found' });
      const mine = await getMembership(org.id, user.id);
      if (!mine) return reply.code(404).send({ error: 'not_found' });
      if (!mine.isAdmin) return reply.code(403).send({ error: 'only_admins_edit_roles', message: 'Only club admins make and change roles.' });
      const roles = await clubRoleList(org.id);
      if (roles.length >= MAX_ROLES) return reply.code(409).send({ error: 'too_many_roles', message: `A club can have up to ${MAX_ROLES} roles.` });
      const name = roleName(req.body?.name);
      if (!name) return reply.code(400).send({ error: 'invalid_name', message: 'Give the role a name (up to 40 letters).' });
      if (roles.some((r) => r.name.toLowerCase() === name.toLowerCase())) return reply.code(409).send({ error: 'role_name_taken', message: 'The club already has a role with that name.' });
      const perms = rolePermissions(req.body?.permissions);
      if (!perms) return reply.code(400).send({ error: 'invalid_permissions' });
      const id = randomUUID();
      await db.insert(schema.clubRoles).values({
        id,
        orgId: org.id,
        key: null,
        name,
        permissions: JSON.stringify(perms),
        position: Math.max(0, ...roles.map((r) => r.position)) + 1,
        createdAt: new Date(),
      });
      await writeAuditEvent({ resourceKind: 'org', resourceId: org.id, userId: user.id, eventType: 'role_create', payload: { roleId: id, roleName: name, permissions: perms } });
      return reply.code(201).send({ id, name, permissions: perms });
    },
  );

  app.patch<{ Params: { slug: string; roleId: string }; Body: { name?: unknown; permissions?: unknown } }>(
    '/api/orgs/:slug/roles/:roleId',
    async (req, reply) => {
      const user = requireUser(req);
      const org = await loadOrgBySlug(req.params.slug);
      if (!org) return reply.code(404).send({ error: 'not_found' });
      const mine = await getMembership(org.id, user.id);
      if (!mine) return reply.code(404).send({ error: 'not_found' });
      if (!mine.isAdmin) return reply.code(403).send({ error: 'only_admins_edit_roles', message: 'Only club admins make and change roles.' });
      const roles = await clubRoleList(org.id);
      const role = roles.find((r) => r.id === req.params.roleId);
      if (!role) return reply.code(404).send({ error: 'role_not_found' });
      if (role.key === 'admin') return reply.code(409).send({ error: 'admin_role_fixed', message: 'The Admin role always has every permission, so it can’t be changed.' });
      const updates: { name?: string; permissions?: string } = {};
      const before = { name: role.name, permissions: role.permissions };
      if (req.body?.name !== undefined) {
        const name = roleName(req.body.name);
        if (!name) return reply.code(400).send({ error: 'invalid_name', message: 'Give the role a name (up to 40 letters).' });
        if (roles.some((r) => r.id !== role.id && r.name.toLowerCase() === name.toLowerCase())) return reply.code(409).send({ error: 'role_name_taken', message: 'The club already has a role with that name.' });
        updates.name = name;
      }
      let perms: ClubPermission[] | null = null;
      if (req.body?.permissions !== undefined) {
        perms = rolePermissions(req.body.permissions);
        if (!perms) return reply.code(400).send({ error: 'invalid_permissions' });
        updates.permissions = JSON.stringify(perms);
      }
      if (!Object.keys(updates).length) return reply.code(400).send({ error: 'no_updates' });
      await db.update(schema.clubRoles).set(updates).where(eq(schema.clubRoles.id, role.id));
      // The built-in Member role's two adding permissions are the club's
      // "members can add things" switch; keep the two in step.
      if (role.key === 'member' && perms) {
        const adds = perms.includes('start_layouts') && perms.includes('edit_modules');
        if (adds !== org.membersCanCreate) await db.update(schema.orgs).set({ membersCanCreate: adds }).where(eq(schema.orgs.id, org.id));
      }
      await writeAuditEvent({
        resourceKind: 'org',
        resourceId: org.id,
        userId: user.id,
        eventType: 'role_edit',
        payload: { roleId: role.id, roleName: updates.name ?? role.name, ...(updates.name ? { fromName: before.name } : {}), ...(perms ? { added: perms.filter((p) => !before.permissions.includes(p)), removed: before.permissions.filter((p) => !perms.includes(p)) } : {}) },
      });
      if (perms) await notifyRoleHolders(org.id, role.id);
      return { ok: true };
    },
  );

  app.delete<{ Params: { slug: string; roleId: string } }>('/api/orgs/:slug/roles/:roleId', async (req, reply) => {
    const user = requireUser(req);
    const org = await loadOrgBySlug(req.params.slug);
    if (!org) return reply.code(404).send({ error: 'not_found' });
    const mine = await getMembership(org.id, user.id);
    if (!mine) return reply.code(404).send({ error: 'not_found' });
    if (!mine.isAdmin) return reply.code(403).send({ error: 'only_admins_edit_roles', message: 'Only club admins make and change roles.' });
    const role = (await rolesWithCounts(org.id)).find((r) => r.id === req.params.roleId);
    if (!role) return reply.code(404).send({ error: 'role_not_found' });
    if (role.key) return reply.code(409).send({ error: 'builtin_role', message: `${role.name} is one of the club’s starting roles, so it can’t be deleted. You can rename it or change what it allows.` });
    if (role.memberCount > 0) {
      return reply.code(409).send({ error: 'role_in_use', message: `${role.memberCount === 1 ? 'One member has' : `${role.memberCount} members have`} this role. Take it from them first.` });
    }
    // Pending invites to it give the Member role instead.
    await db.update(schema.orgInvites).set({ roleId: null, role: 'member' }).where(and(eq(schema.orgInvites.orgId, org.id), eq(schema.orgInvites.roleId, role.id)));
    await db.delete(schema.clubRoles).where(eq(schema.clubRoles.id, role.id));
    await writeAuditEvent({ resourceKind: 'org', resourceId: org.id, userId: user.id, eventType: 'role_delete', payload: { roleId: role.id, roleName: role.name } });
    return { ok: true };
  });

  // ---- remove member ------------------------------------------------------
  app.delete<{ Params: { slug: string; userId: string } }>(
    '/api/orgs/:slug/members/:userId',
    async (req, reply) => {
      const user = requireUser(req);
      const org = await loadOrgBySlug(req.params.slug);
      if (!org) return reply.code(404).send({ error: 'not_found' });
      const myMembership = await getMembership(org.id, user.id);
      if (!myMembership) return reply.code(404).send({ error: 'not_found' });

      const isSelf = req.params.userId === user.id;
      const target = await getMembership(org.id, req.params.userId);
      // "Manage members and roles" removes anyone but an Admin (only an
      // Admin takes the Admin role, so only an Admin removes one); "invite
      // people" removes only people with less than you (a Manager removes
      // Members, as before).
      const mayRemove =
        isSelf ||
        myMembership.isAdmin ||
        (has(myMembership, 'manage_members') && !target?.isAdmin) ||
        (has(myMembership, 'invite') && !!target && !target.isAdmin && lesserRole(target.permissions, myMembership.permissions));
      if (!mayRemove) {
        return reply.code(403).send({ error: 'forbidden' });
      }

      // Last-admin guard same as above.
      if (target?.isAdmin) {
        if ((await adminCount(org.id)) <= 1) {
          return reply.code(409).send({ error: 'last_admin' });
        }
      }

      await db
        .delete(schema.orgMembers)
        .where(
          and(
            eq(schema.orgMembers.orgId, org.id),
            eq(schema.orgMembers.userId, req.params.userId),
          ),
        );
      notifyAccessChanged({ userId: req.params.userId });
      await writeAuditEvent({
        resourceKind: 'org',
        resourceId: org.id,
        userId: user.id,
        eventType: 'unshare',
        payload: { targetUserId: req.params.userId, selfRemoved: isSelf },
      });
      return { ok: true };
    },
  );

  // ---- list org-owned layouts ---------------------------------------------
  app.get<{ Params: { slug: string } }>(
    '/api/orgs/:slug/layouts',
    async (req, reply) => {
      const user = requireUser(req);
      const org = await loadOrgBySlug(req.params.slug);
      if (!org) return reply.code(404).send({ error: 'not_found' });
      const myMembership = await getMembership(org.id, user.id);
      if (!myMembership) return reply.code(404).send({ error: 'not_found' });

      const rows = await db
        .select({
          id: schema.layouts.id,
          title: schema.layouts.title,
          ownerUserId: schema.layouts.ownerUserId,
          ownerOrgId: schema.layouts.ownerOrgId,
          createdAt: schema.layouts.createdAt,
          updatedAt: schema.layouts.updatedAt,
          expiresAt: schema.layouts.expiresAt,
          docVersion: schema.layouts.docVersion,
          // Metadata only — don't load the doc blobs to list titles.
          hasSidecar: sql<number>`${schema.layouts.sidecarSnapshot} IS NOT NULL`,
        })
        .from(schema.layouts)
        .where(eq(schema.layouts.ownerOrgId, org.id));
      return {
        layouts: rows.map((l) => ({
          id: l.id,
          title: l.title,
          ownerUserId: l.ownerUserId,
          ownerOrgId: l.ownerOrgId,
          createdAt: l.createdAt.getTime(),
          updatedAt: l.updatedAt.getTime(),
          expiresAt: l.expiresAt?.getTime() ?? null,
          docVersion: l.docVersion,
          hasSidecar: Boolean(l.hasSidecar),
        })),
      };
    },
  );

  // -----------------------------------------------------------------
  // Per-org part library management (org admin only)
  // -----------------------------------------------------------------

  // GET /api/orgs/:slug/part-libraries
  // Returns all installed libraries with the org's enabled/disabled status.
  app.get<{ Params: { slug: string } }>(
    '/api/orgs/:slug/part-libraries',
    async (req, reply) => {
      const me = requireUser(req);
      const org = await loadOrgBySlug(req.params.slug);
      if (!org) return reply.code(404).send({ error: 'not_found' });
      const membership = await getMembership(org.id, me.id);
      if (!membership) return reply.code(403).send({ error: 'not_member' });

      // All installed libraries.
      const all = await db.select().from(schema.partLibraries).orderBy(schema.partLibraries.name);
      // This org's explicit overrides.
      const overrides = await db
        .select()
        .from(schema.orgPartLibraries)
        .where(eq(schema.orgPartLibraries.orgId, org.id));
      const overrideMap = new Map(overrides.map((o) => [o.libraryId, o.enabled]));

      return {
        libraries: all.map((lib) => {
          const explicit = overrideMap.get(lib.id);
          // Locked libraries are always enabled regardless of any override.
          const enabled = lib.locked ? true : (explicit !== undefined ? explicit : lib.defaultEnabled);
          return {
            id: lib.id,
            name: lib.name,
            slug: lib.slug,
            partCount: lib.partCount,
            defaultEnabled: lib.defaultEnabled,
            locked: lib.locked,
            enabled,
            explicitOverride: !lib.locked && explicit !== undefined,
          };
        }),
        isAdmin: membership.isAdmin,
      };
    },
  );

  // PUT /api/orgs/:slug/part-libraries/:libraryId
  // Org admin enables or disables a library for the org.
  app.put<{
    Params: { slug: string; libraryId: string };
    Body: { enabled: boolean };
  }>(
    '/api/orgs/:slug/part-libraries/:libraryId',
    async (req, reply) => {
      const me = requireUser(req);
      const org = await loadOrgBySlug(req.params.slug);
      if (!org) return reply.code(404).send({ error: 'not_found' });
      const membership = await getMembership(org.id, me.id);
      if (!membership || !membership.isAdmin) {
        return reply.code(403).send({ error: 'not_org_admin' });
      }

      const lib = await db
        .select({ id: schema.partLibraries.id, defaultEnabled: schema.partLibraries.defaultEnabled, locked: schema.partLibraries.locked })
        .from(schema.partLibraries)
        .where(eq(schema.partLibraries.id, req.params.libraryId))
        .get();
      if (!lib) return reply.code(404).send({ error: 'library_not_found' });
      if (lib.locked) return reply.code(403).send({ error: 'library_locked' });

      const enabled = Boolean(req.body.enabled);
      const now = new Date();

      // Upsert the override row.
      const existing = await db
        .select()
        .from(schema.orgPartLibraries)
        .where(
          and(
            eq(schema.orgPartLibraries.orgId, org.id),
            eq(schema.orgPartLibraries.libraryId, lib.id),
          ),
        )
        .get();

      if (existing) {
        await db
          .update(schema.orgPartLibraries)
          .set({ enabled, updatedAt: now })
          .where(
            and(
              eq(schema.orgPartLibraries.orgId, org.id),
              eq(schema.orgPartLibraries.libraryId, lib.id),
            ),
          );
      } else {
        await db.insert(schema.orgPartLibraries).values({
          orgId: org.id,
          libraryId: lib.id,
          enabled,
          updatedAt: now,
        });
      }

      await writeAuditEvent({
        resourceKind: 'org',
        resourceId: org.id,
        userId: me.id,
        eventType: 'org_part_library_toggle',
        payload: { libraryId: lib.id, enabled, orgSlug: org.slug },
      });
      return { ok: true };
    },
  );

  // DELETE /api/orgs/:slug/part-libraries/:libraryId
  // Removes the explicit override — library reverts to its defaultEnabled state.
  app.delete<{ Params: { slug: string; libraryId: string } }>(
    '/api/orgs/:slug/part-libraries/:libraryId',
    async (req, reply) => {
      const me = requireUser(req);
      const org = await loadOrgBySlug(req.params.slug);
      if (!org) return reply.code(404).send({ error: 'not_found' });
      const membership = await getMembership(org.id, me.id);
      if (!membership || !membership.isAdmin) {
        return reply.code(403).send({ error: 'not_org_admin' });
      }
      const lib = await db
        .select({ locked: schema.partLibraries.locked })
        .from(schema.partLibraries)
        .where(eq(schema.partLibraries.id, req.params.libraryId))
        .get();
      if (!lib) return reply.code(404).send({ error: 'library_not_found' });
      if (lib.locked) return reply.code(403).send({ error: 'library_locked' });
      await db
        .delete(schema.orgPartLibraries)
        .where(
          and(
            eq(schema.orgPartLibraries.orgId, org.id),
            eq(schema.orgPartLibraries.libraryId, req.params.libraryId),
          ),
        );
      return { ok: true };
    },
  );

}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function loadOrgBySlug(slug: string): Promise<typeof schema.orgs.$inferSelect | null> {
  const row = await db
    .select()
    .from(schema.orgs)
    .where(eq(schema.orgs.slug, slug))
    .get();
  return row ?? null;
}

const MAX_ROLES = 30;

function roleName(v: unknown): string | null {
  const name = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  return name && name.length <= 40 ? name : null;
}

function rolePermissions(v: unknown): ClubPermission[] | null {
  if (!Array.isArray(v) || !v.every(isClubPermission)) return null;
  return normalizePermissions(v);
}

/** The club's roles, each with how many members hold it. */
export async function rolesWithCounts(orgId: string): Promise<(ClubRoleRow & { memberCount: number })[]> {
  const roles = await clubRoleList(orgId);
  const members = await db.select({ userId: schema.orgMembers.userId, role: schema.orgMembers.role }).from(schema.orgMembers).where(eq(schema.orgMembers.orgId, orgId));
  const held = await db.select({ userId: schema.memberRoles.userId, roleId: schema.memberRoles.roleId }).from(schema.memberRoles).where(eq(schema.memberRoles.orgId, orgId));
  const withRows = new Set(held.map((h) => h.userId));
  return roles.map((r) => ({
    ...r,
    memberCount:
      held.filter((h) => h.roleId === r.id).length + (r.key ? members.filter((m) => !withRows.has(m.userId) && m.role === r.key).length : 0),
  }));
}

/** Open live connections of everyone holding the role check their access again at once. */
async function notifyRoleHolders(orgId: string, roleId: string): Promise<void> {
  const role = (await clubRoleList(orgId)).find((r) => r.id === roleId);
  const held = await db.select({ userId: schema.memberRoles.userId }).from(schema.memberRoles).where(eq(schema.memberRoles.roleId, roleId));
  const ids = new Set(held.map((h) => h.userId));
  if (role?.key) {
    // Members with no role rows yet hold their built-in role.
    const bare = await db.select({ userId: schema.orgMembers.userId, role: schema.orgMembers.role }).from(schema.orgMembers).where(eq(schema.orgMembers.orgId, orgId));
    const withRows = new Set((await db.select({ userId: schema.memberRoles.userId }).from(schema.memberRoles).where(eq(schema.memberRoles.orgId, orgId))).map((r) => r.userId));
    for (const m of bare) if (!withRows.has(m.userId) && m.role === role.key) ids.add(m.userId);
  }
  for (const userId of ids) notifyAccessChanged({ userId });
}

/** Every member's open live connections check their access again. */
async function notifyClub(orgId: string): Promise<void> {
  const rows = await db.select({ userId: schema.orgMembers.userId }).from(schema.orgMembers).where(eq(schema.orgMembers.orgId, orgId));
  for (const r of rows) notifyAccessChanged({ userId: r.userId });
}

/** Who `userId` is in the club (their roles and permissions), or null. */
export async function getMembership(orgId: string, userId: string): Promise<ClubAccess | null> {
  return clubAccess(userId, orgId);
}

/**
 * The ids of the people `userId` already works with, as a subquery: anyone
 * in a club with them, and anyone on a layout they can open (theirs, one
 * of their clubs', or one shared with them), owner or collaborator.
 */
function peopleIWorkWith(userId: string) {
  const myLayouts = sql`(
    SELECT id FROM layouts WHERE owner_user_id = ${userId}
      OR owner_org_id IN (SELECT org_id FROM org_members WHERE user_id = ${userId})
    UNION SELECT layout_id FROM layout_collaborators WHERE user_id = ${userId}
  )`;
  return sql`(
    SELECT other.user_id FROM org_members mine JOIN org_members other ON other.org_id = mine.org_id WHERE mine.user_id = ${userId}
    UNION SELECT user_id FROM layout_collaborators WHERE layout_id IN ${myLayouts}
    UNION SELECT owner_user_id FROM layouts WHERE owner_user_id IS NOT NULL AND id IN ${myLayouts}
  )`;
}

/**
 * Whether `actor` may invite someone to, or give, `role`: an Admin any
 * role; with "manage members and roles", roles with no more than the
 * actor's own (as changing a member's roles allows), never Admin; with
 * only "invite people", roles with strictly less than the actor's own.
 */
export function mayGiveRole(actor: ClubAccess, role: ClubRoleRow | undefined): boolean {
  if (!role) return false;
  if (actor.isAdmin) return true;
  if (role.key === 'admin') return false;
  if (actor.permissions.has('manage_members')) return role.permissions.every((p) => actor.permissions.has(p));
  return actor.permissions.has('invite') && lesserRole(new Set(role.permissions), actor.permissions);
}

/** The club role a pending invite gives. */
export async function inviteRole(orgId: string, invite: { role: ClubRole; roleId: string | null }): Promise<ClubRoleRow | undefined> {
  const roles = await clubRoleList(orgId);
  return roles.find((r) => r.id === invite.roleId) ?? roles.find((r) => r.key === invite.role);
}

/**
 * The public catalog choice when deleting a club: 'hand' (the default) to
 * a current member (the person deleting it unless they pick someone), or
 * 'takedown'.
 */
export async function catalogChoice(
  orgId: string,
  rawChoice: unknown,
  rawHeir: unknown,
  fallbackHeir: string | null,
): Promise<{ catalog: CatalogChoice; heirUserId: string | null } | { error: string; message: string }> {
  const catalog = rawChoice === undefined || rawChoice === null ? 'hand' : rawChoice;
  if (catalog !== 'hand' && catalog !== 'takedown') return { error: 'invalid_input', message: 'Choose to hand the public items to a member, or take them down.' };
  if (catalog === 'takedown') return { catalog, heirUserId: null };
  const heir = typeof rawHeir === 'string' && rawHeir ? rawHeir : fallbackHeir;
  if (heir && (await getMembership(orgId, heir))) return { catalog, heirUserId: heir };
  if (heir === fallbackHeir && !rawHeir) {
    // A site admin deleting a club they're not in: its longest-standing admin.
    const admin = await db
      .select({ u: schema.orgMembers.userId })
      .from(schema.orgMembers)
      .where(and(eq(schema.orgMembers.orgId, orgId), eq(schema.orgMembers.role, 'admin')))
      .orderBy(schema.orgMembers.joinedAt)
      .get();
    return { catalog, heirUserId: admin?.u ?? null };
  }
  return { error: 'heir_not_member', message: 'Pick someone who is in the club to look after its public items.' };
}
