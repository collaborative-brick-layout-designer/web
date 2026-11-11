// Platform-admin endpoints — every route is gated by `requireGlobalAdmin`
// and writes an audit_event for any mutation. Read-only endpoints don't
// audit (would balloon the table for what's effectively just listing).
//
// Routes are intentionally namespaced at /api/admin/* so a reverse proxy
// can apply tighter rate limits / IP allowlists per deployment.

import { COVER_MAX_CEILING, COVER_MAX_FLOOR, coverMaxBytes } from '../images/covers.js';
import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdir, rm, readdir } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { db, schema } from '../db/index.js';
import { requireGlobalAdmin } from '../auth/cookie.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { invalidateAllSessions } from '../auth/session.js';
import { revokeAllApiTokens } from '../auth/apiTokens.js';
import { DESKTOP_MINIMUM, compareVersions, resetDesktopPolicy, resolvePolicy } from '../compat.js';
import { parsePartXml } from '@cld/parts-catalog';
import { xmlForSprite } from './customParts.js';
import { invalidatePartsCache } from './parts.js';
import { getPlatformSettings, mergeSmtpConfig, PLATFORM_SETTINGS_ID } from '../auth/platformSettings.js';
import { invalidateLimitCaches } from '../limits/limits.js';
import { invalidateTransporter } from '../email/transporter.js';
import { layoutStatsByOrg, layoutStatsByUser, layoutStatsForSingleUser, sizeByLayoutId } from './adminLayoutStats.js';
import { escapeLike, trimmed } from '../utils/validate.js';
import { docHub } from '../ws/docHub.js';
import { safeFetch } from '../utils/safeFetch.js';
import { env } from '../env.js';
import { backgroundJobs } from '../workers/jobs.js';
import { EraseRefused, eraseUser } from '../privacy/accountDeletion.js';
import { NOTICE_MAX, privacyContact, validContact } from '../privacy/page.js';
import { readPlan, requestClubDeletion } from '../privacy/clubDeletion.js';
import { catalogChoice } from './orgs.js';
import { invalidatePrivacyCache, mergePrivacyPatch, privacySettingStates } from '../privacy/settings.js';
import { invalidateSignInCache, mergeSignInPatch, signInSettingStates } from '../auth/signInSettings.js';
import { DEMO_RESET_CHOICES, DEMO_SPACE_MINUTES_CHOICES, demoStatus, ensureDemoUser, isDemoUser, liveDemoSpaces, notDemoSpace, signOutDemo, type DemoResetEvery } from '../demo/demoAccount.js';
import { deleteAllDemoSpaces, demoItemCount, runDemoReset } from '../demo/reset.js';
import { perPerson } from '../utils/rateLimits.js';

function safeParse(json: string): unknown {
  try { return JSON.parse(json); } catch { return { _raw: json }; }
}

interface UserListQuery {
  q?: string;
  limit?: string;
  offset?: string;
}

interface OrgListQuery {
  q?: string;
  limit?: string;
  offset?: string;
}

interface LayoutListQuery {
  q?: string;
  limit?: string;
  offset?: string;
  ownerUserId?: string;
  ownerOrgId?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(raw: string | undefined): number {
  const n = raw ? parseInt(raw, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, n);
}

function clampOffset(raw: string | undefined): number {
  const n = raw ? parseInt(raw, 10) : 0;
  // Past what SQLite holds (a 64-bit integer) it refused the query with a 500.
  return Number.isFinite(n) && n >= 0 ? Math.min(n, Number.MAX_SAFE_INTEGER) : 0;
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // -----------------------------------------------------------------
  // Users
  // -----------------------------------------------------------------
  app.get<{ Querystring: UserListQuery }>('/api/admin/users', async (req) => {
    requireGlobalAdmin(req);
    const limit = clampLimit(req.query.limit);
    const offset = clampOffset(req.query.offset);
    const needle = (req.query.q ?? '').trim();
    const safe = `%${escapeLike(needle)}%`;
    // Visitors' demo spaces are throwaway and many: Settings › Demo counts them instead.
    const where = and(
      notDemoSpace(),
      needle
        ? or(
            sql`${schema.users.email} LIKE ${safe} ESCAPE '\\'`,
            sql`${schema.users.displayName} LIKE ${safe} ESCAPE '\\'`,
          )
        : undefined,
    );
    const rows = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        displayName: schema.users.displayName,
        avatarUrl: schema.users.avatarUrl,
        isDemoAccount: schema.users.isDemoAccount,
        isGlobalAdmin: schema.users.isGlobalAdmin,
        isModerator: schema.users.isModerator,
        emailVerified: schema.users.emailVerified,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .where(where)
      .orderBy(desc(schema.users.createdAt))
      .limit(limit)
      .offset(offset);

    const totalRow = await db
      .select({ n: count() })
      .from(schema.users)
      .where(where)
      .get();
    // Bounded to this page's ids — see adminLayoutStats.ts's header
    // comment for why this doesn't scan the whole layouts table.
    const layoutStats = await layoutStatsByUser(rows.map((r) => r.id));
    return {
      users: rows.map((r) => ({
        ...r,
        layoutCount: layoutStats.get(r.id)?.layoutCount ?? 0,
        layoutSizeBytes: layoutStats.get(r.id)?.sizeBytes ?? 0,
      })),
      total: totalRow?.n ?? 0,
      limit,
      offset,
    };
  });

  app.get<{ Params: { id: string } }>('/api/admin/users/:id', async (req, reply) => {
    requireGlobalAdmin(req);
    const user = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, req.params.id))
      .get();
    if (!user) return reply.code(404).send({ error: 'not_found' });

    // Counts: orgs the user belongs to, custom parts, modules, sessions.
    // Layout count + size come from adminLayoutStats (folds in
    // layout_updates too — see its header comment).
    const [orgCount, partCount, moduleCount, sessionCount, layoutStats, orgMemberships, layouts] = await Promise.all([
      db.select({ n: count() }).from(schema.orgMembers).where(eq(schema.orgMembers.userId, user.id)).get(),
      db.select({ n: count() }).from(schema.customParts).where(eq(schema.customParts.ownerUserId, user.id)).get(),
      db.select({ n: count() }).from(schema.modules).where(eq(schema.modules.ownerUserId, user.id)).get(),
      db.select({ n: count() }).from(schema.sessions).where(eq(schema.sessions.userId, user.id)).get(),
      layoutStatsForSingleUser(user.id),
      db
        .select({ orgId: schema.orgs.id, name: schema.orgs.name, slug: schema.orgs.slug, role: schema.orgMembers.role })
        .from(schema.orgMembers)
        .innerJoin(schema.orgs, eq(schema.orgs.id, schema.orgMembers.orgId))
        .where(eq(schema.orgMembers.userId, user.id)),
      db
        .select({ id: schema.layouts.id, title: schema.layouts.title, updatedAt: schema.layouts.updatedAt })
        .from(schema.layouts)
        .where(eq(schema.layouts.ownerUserId, user.id))
        .orderBy(desc(schema.layouts.updatedAt)),
    ]);
    const sizeByLayout = await sizeByLayoutId(layouts.map((l) => l.id));

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        isDemoAccount: user.isDemoAccount,
        isGlobalAdmin: user.isGlobalAdmin,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt,
      },
      stats: {
        orgs: orgCount?.n ?? 0,
        layouts: layoutStats.layoutCount,
        layoutSizeBytes: layoutStats.sizeBytes,
        customParts: partCount?.n ?? 0,
        modules: moduleCount?.n ?? 0,
        activeSessions: sessionCount?.n ?? 0,
      },
      orgMemberships,
      layouts: layouts.map((l) => ({ ...l, sizeBytes: sizeByLayout.get(l.id) ?? 0 })),
    };
  });

  app.patch<{ Params: { id: string }; Body: { isGlobalAdmin?: boolean; isModerator?: boolean } }>(
    '/api/admin/users/:id',
    async (req, reply) => {
      const me = requireGlobalAdmin(req);
      const target = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, req.params.id))
        .get();
      if (!target) return reply.code(404).send({ error: 'not_found' });

      // Don't let an admin demote themselves — would lock them out.
      // Other admins are still around to do it; this just prevents
      // accidental self-lockout.
      const patch: Partial<typeof schema.users.$inferInsert> = {};
      if (typeof req.body.isGlobalAdmin === 'boolean') {
        if (target.id === me.id && !req.body.isGlobalAdmin) {
          return reply.code(400).send({ error: 'cannot_demote_self' });
        }
        patch.isGlobalAdmin = req.body.isGlobalAdmin;
      }
      // Moderator: reviews the public catalogs, and nothing else.
      if (typeof req.body.isModerator === 'boolean') {
        patch.isModerator = req.body.isModerator;
      }
      // Anyone can sign in as the demo account: it never gets powers.
      if (isDemoUser(target) && (patch.isGlobalAdmin || patch.isModerator)) {
        return reply.code(400).send({ error: 'demo_account' });
      }
      if (Object.keys(patch).length === 0) {
        return reply.code(400).send({ error: 'empty_patch' });
      }
      await db.update(schema.users).set(patch).where(eq(schema.users.id, target.id));
      await writeAuditEvent({
        resourceKind: 'user',
        resourceId: target.id,
        userId: me.id,
        eventType: 'admin_user_patch',
        payload: { patch, targetEmail: target.email },
      });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/admin/users/:id', async (req, reply) => {
    const me = requireGlobalAdmin(req);
    if (req.params.id === me.id) {
      return reply.code(400).send({ error: 'cannot_delete_self' });
    }
    const target = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, req.params.id))
      .get();
    if (!target) return reply.code(404).send({ error: 'not_found' });
    // Erased for good, the same as a person's own deletion after its wait:
    // what they own alone goes, club things stay credited "Builder #…", the
    // audit log keeps what happened without who (privacy/accountDeletion.ts).
    try {
      const done = await eraseUser(target.id, 'admin', me.id);
      await writeAuditEvent({
        resourceKind: 'user',
        resourceId: target.id,
        userId: me.id,
        eventType: 'admin_user_delete',
        payload: { ref: done?.ref ?? null },
      });
    } catch (err) {
      if (err instanceof EraseRefused) return reply.code(409).send({ error: err.message });
      throw err;
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>(
    '/api/admin/users/:id/sessions/revoke-all',
    async (req, reply) => {
      const me = requireGlobalAdmin(req);
      const target = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, req.params.id))
        .get();
      if (!target) return reply.code(404).send({ error: 'not_found' });
      await invalidateAllSessions(target.id);
      // Desktop sign-ins are sessions too, as far as the user is
      // concerned: "revoke all" signs out every device.
      const tokensRevoked = await revokeAllApiTokens(target.id);
      await writeAuditEvent({
        resourceKind: 'user',
        resourceId: target.id,
        userId: me.id,
        eventType: 'admin_revoke_sessions',
        payload: { targetEmail: target.email, tokensRevoked },
      });
      return { ok: true };
    },
  );

  // -----------------------------------------------------------------
  // Organizations
  // -----------------------------------------------------------------
  app.get<{ Querystring: OrgListQuery }>('/api/admin/orgs', async (req) => {
    requireGlobalAdmin(req);
    const limit = clampLimit(req.query.limit);
    const offset = clampOffset(req.query.offset);
    const needle = (req.query.q ?? '').trim();
    const safe = `%${escapeLike(needle)}%`;
    const where = needle
      ? or(
          sql`${schema.orgs.name} LIKE ${safe} ESCAPE '\\'`,
          sql`${schema.orgs.slug} LIKE ${safe} ESCAPE '\\'`,
        )
      : undefined;
    const rows = await db
      .select({
        id: schema.orgs.id,
        name: schema.orgs.name,
        slug: schema.orgs.slug,
        createdAt: schema.orgs.createdAt,
        deletionDueAt: schema.orgs.deletionDueAt,
        deletionPlan: schema.orgs.deletionPlan,
      })
      .from(schema.orgs)
      .where(where)
      .orderBy(desc(schema.orgs.createdAt))
      .limit(limit)
      .offset(offset);
    const totalRow = await db
      .select({ n: count() })
      .from(schema.orgs)
      .where(where)
      .get();
    // Fold member-counts + layout stats into the rows. Both bounded to
    // this page's org ids — see the member-count fix below and
    // adminLayoutStats.ts's header comment. (The member-count query
    // used to be unbounded — a full-table GROUP BY on every page load
    // regardless of `ids` — fixed here to match the new layout query.)
    const ids = rows.map((r) => r.id);
    const [memberCounts, layoutStats] = await Promise.all([
      ids.length > 0
        ? db
            .select({ orgId: schema.orgMembers.orgId, n: count() })
            .from(schema.orgMembers)
            .where(inArray(schema.orgMembers.orgId, ids))
            .groupBy(schema.orgMembers.orgId)
        : Promise.resolve([]),
      layoutStatsByOrg(ids),
    ]);
    const byId = new Map(memberCounts.map((r) => [r.orgId, r.n]));
    return {
      orgs: rows.map(({ deletionPlan: _plan, ...r }) => ({
        ...r,
        // Waiting to be deleted (hidden; Restore or Erase now). Its members are set aside meanwhile.
        deletionDueAt: r.deletionDueAt?.getTime() ?? null,
        memberCount: byId.get(r.id) ?? (r.deletionDueAt ? (readPlan({ deletionPlan: _plan })?.members.length ?? 0) : 0),
        layoutCount: layoutStats.get(r.id)?.layoutCount ?? 0,
        layoutSizeBytes: layoutStats.get(r.id)?.sizeBytes ?? 0,
      })),
      total: totalRow?.n ?? 0,
      limit,
      offset,
    };
  });

  app.get<{ Params: { id: string } }>('/api/admin/orgs/:id', async (req, reply) => {
    requireGlobalAdmin(req);
    const org = await db.select().from(schema.orgs).where(eq(schema.orgs.id, req.params.id)).get();
    if (!org) return reply.code(404).send({ error: 'not_found' });

    const [members, layouts, layoutStats] = await Promise.all([
      db
        .select({
          userId: schema.users.id,
          email: schema.users.email,
          displayName: schema.users.displayName,
          role: schema.orgMembers.role,
          joinedAt: schema.orgMembers.joinedAt,
        })
        .from(schema.orgMembers)
        .innerJoin(schema.users, eq(schema.users.id, schema.orgMembers.userId))
        .where(eq(schema.orgMembers.orgId, org.id)),
      db
        .select({ id: schema.layouts.id, title: schema.layouts.title, updatedAt: schema.layouts.updatedAt })
        .from(schema.layouts)
        .where(eq(schema.layouts.ownerOrgId, org.id))
        .orderBy(desc(schema.layouts.updatedAt)),
      layoutStatsByOrg([org.id]),
    ]);
    const sizeByLayout = await sizeByLayoutId(layouts.map((l) => l.id));
    const stats = layoutStats.get(org.id) ?? { layoutCount: 0, sizeBytes: 0 };

    return {
      org: { id: org.id, name: org.name, slug: org.slug, createdAt: org.createdAt, trusted: org.trusted, trustedAt: org.trustedAt?.getTime() ?? null },
      stats: { members: members.length, layouts: stats.layoutCount, layoutSizeBytes: stats.sizeBytes },
      members,
      layouts: layouts.map((l) => ({ ...l, sizeBytes: sizeByLayout.get(l.id) ?? 0 })),
    };
  });

  // Deleting a club waits first, hidden, like a club admin's delete
  // (privacy/clubDeletion.ts); "Erase now" (/api/admin/orgs/:id/erase)
  // skips the wait. Public catalog items go to the club's longest admin
  // unless the body says otherwise.
  app.delete<{ Params: { id: string }; Body: { catalog?: unknown; heirUserId?: unknown } }>('/api/admin/orgs/:id', async (req, reply) => {
    const me = requireGlobalAdmin(req);
    const target = await db.select().from(schema.orgs).where(eq(schema.orgs.id, req.params.id)).get();
    if (!target) return reply.code(404).send({ error: 'not_found' });
    if (target.deletionDueAt) return { ok: true, dueAt: target.deletionDueAt.getTime() };
    const choice = await catalogChoice(target.id, req.body?.catalog, req.body?.heirUserId, null);
    if ('error' in choice) return reply.code(400).send(choice);
    const { dueAt } = await requestClubDeletion(target, me, choice);
    await writeAuditEvent({
      resourceKind: 'org',
      resourceId: target.id,
      userId: me.id,
      eventType: 'admin_org_delete',
      payload: { name: target.name, slug: target.slug, dueAt: dueAt.getTime() },
    });
    return { ok: true, dueAt: dueAt.getTime() };
  });

  // -----------------------------------------------------------------
  // Layouts
  // -----------------------------------------------------------------
  app.get<{ Querystring: LayoutListQuery }>('/api/admin/layouts', async (req) => {
    requireGlobalAdmin(req);
    const limit = clampLimit(req.query.limit);
    const offset = clampOffset(req.query.offset);
    const needle = (req.query.q ?? '').trim();
    const filters = [];
    if (needle) {
      const safe = `%${escapeLike(needle)}%`;
      filters.push(sql`${schema.layouts.title} LIKE ${safe} ESCAPE '\\'`);
    }
    if (req.query.ownerUserId) filters.push(eq(schema.layouts.ownerUserId, req.query.ownerUserId));
    if (req.query.ownerOrgId) filters.push(eq(schema.layouts.ownerOrgId, req.query.ownerOrgId));
    const where = filters.length > 0 ? and(...filters) : undefined;

    const rows = await db
      .select({
        id: schema.layouts.id,
        title: schema.layouts.title,
        ownerUserId: schema.layouts.ownerUserId,
        ownerOrgId: schema.layouts.ownerOrgId,
        ownerUserEmail: schema.users.email,
        ownerOrgName: schema.orgs.name,
        createdBy: schema.layouts.createdBy,
        createdAt: schema.layouts.createdAt,
        updatedAt: schema.layouts.updatedAt,
        expiresAt: schema.layouts.expiresAt,
        docVersion: schema.layouts.docVersion,
      })
      .from(schema.layouts)
      .leftJoin(schema.users, eq(schema.users.id, schema.layouts.ownerUserId))
      .leftJoin(schema.orgs, eq(schema.orgs.id, schema.layouts.ownerOrgId))
      .where(where)
      .orderBy(desc(schema.layouts.updatedAt))
      .limit(limit)
      .offset(offset);
    const totalRow = await db
      .select({ n: count() })
      .from(schema.layouts)
      .where(where)
      .get();
    const sizeByLayout = await sizeByLayoutId(rows.map((r) => r.id));
    return {
      layouts: rows.map((r) => ({ ...r, sizeBytes: sizeByLayout.get(r.id) ?? 0 })),
      total: totalRow?.n ?? 0,
      limit,
      offset,
    };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/layouts/:id', async (req, reply) => {
    const me = requireGlobalAdmin(req);
    const target = await db
      .select({ id: schema.layouts.id, title: schema.layouts.title })
      .from(schema.layouts)
      .where(eq(schema.layouts.id, req.params.id))
      .get();
    if (!target) return reply.code(404).send({ error: 'not_found' });
    await db.delete(schema.layouts).where(eq(schema.layouts.id, target.id));
    await docHub.close(target.id);
    await writeAuditEvent({
      layoutId: target.id,
      userId: me.id,
      eventType: 'admin_layout_delete',
      payload: { title: target.title },
    });
    return { ok: true };
  });

  // -----------------------------------------------------------------
  // Global parts library (admin-managed, visible to all users)
  // -----------------------------------------------------------------

  // A page at a time (`limit`, `offset`), searchable by number or name; `total` counts every match.
  app.get<{ Querystring: { q?: string; limit?: string; offset?: string } }>('/api/admin/global-parts', async (req) => {
    requireGlobalAdmin(req);
    const limit = clampLimit(req.query.limit);
    const offset = clampOffset(req.query.offset);
    const needle = (req.query.q ?? '').trim();
    const safe = `%${escapeLike(needle)}%`;
    const where = and(
      eq(schema.customParts.isGlobal, true),
      needle
        ? or(sql`${schema.customParts.partNumber} LIKE ${safe} ESCAPE '\\'`, sql`${schema.customParts.displayName} LIKE ${safe} ESCAPE '\\'`)
        : undefined,
    );
    const total = (await db.select({ n: count() }).from(schema.customParts).where(where).get())?.n ?? 0;
    const rows = await db
      .select({
        id: schema.customParts.id,
        partNumber: schema.customParts.partNumber,
        displayName: schema.customParts.displayName,
        category: schema.customParts.category,
        spriteMime: schema.customParts.spriteMime,
        createdAt: schema.customParts.createdAt,
      })
      .from(schema.customParts)
      .where(where)
      .orderBy(schema.customParts.category, schema.customParts.displayName, schema.customParts.id)
      .limit(limit)
      .offset(offset);
    return { parts: rows, total, limit, offset };
  });

  interface GlobalPartBody {
    partNumber: string;
    displayName: string;
    category?: string;
    /** Base64-encoded XML payload — same format as /api/custom-parts. */
    xmlBase64: string;
    /** Base64-encoded sprite (gif or png). */
    spriteBase64: string;
    spriteMime: 'image/gif' | 'image/png';
  }

  app.post<{ Body: GlobalPartBody }>('/api/admin/global-parts', async (req, reply) => {
    const me = requireGlobalAdmin(req);
    const body = req.body ?? ({} as GlobalPartBody);
    const partNumber = trimmed(body.partNumber);
    const displayName = trimmed(body.displayName);
    const category = trimmed(body.category) || 'Custom';
    if (!partNumber || !displayName) return reply.code(400).send({ error: 'invalid_input' });
    if (body.spriteMime !== 'image/gif' && body.spriteMime !== 'image/png') {
      return reply.code(400).send({ error: 'invalid_sprite_mime' });
    }
    let xmlBlob: Buffer;
    let spriteBlob: Buffer;
    try {
      xmlBlob = Buffer.from(body.xmlBase64, 'base64');
      spriteBlob = Buffer.from(body.spriteBase64, 'base64');
    } catch {
      return reply.code(400).send({ error: 'invalid_base64' });
    }
    if (xmlBlob.length === 0 || spriteBlob.length === 0) {
      return reply.code(400).send({ error: 'empty_payload' });
    }
    xmlBlob = xmlForSprite(xmlBlob, body.spriteMime);
    try {
      parsePartXml(xmlBlob.toString('utf8'), { partNumber, colorCode: '', spritePath: '' });
    } catch {
      return reply.code(400).send({ error: 'invalid_part_xml' });
    }
    const id = randomUUID();
    const now = new Date();
    await db.insert(schema.customParts).values({
      id,
      partNumber,
      displayName,
      category,
      isGlobal: true,
      ownerUserId: null,
      ownerOrgId: null,
      createdBy: me.id,
      xmlBlob,
      spriteBlob,
      spriteMime: body.spriteMime,
      createdAt: now,
      updatedAt: now,
    });
    await writeAuditEvent({
      resourceKind: 'custom_part',
      resourceId: id,
      userId: me.id,
      eventType: 'admin_global_part_create',
      payload: { partId: id, partNumber, displayName, category },
    });
    return reply.code(201).send({ id });
  });

  app.delete<{ Params: { id: string } }>('/api/admin/global-parts/:id', async (req, reply) => {
    const me = requireGlobalAdmin(req);
    const part = await db
      .select({ id: schema.customParts.id, partNumber: schema.customParts.partNumber, isGlobal: schema.customParts.isGlobal })
      .from(schema.customParts)
      .where(eq(schema.customParts.id, req.params.id))
      .get();
    if (!part) return reply.code(404).send({ error: 'not_found' });
    if (!part.isGlobal) return reply.code(403).send({ error: 'not a global part' });
    await db.delete(schema.customParts).where(eq(schema.customParts.id, part.id));
    await writeAuditEvent({
      resourceKind: 'custom_part',
      resourceId: part.id,
      userId: me.id,
      eventType: 'admin_global_part_delete',
      payload: { partId: part.id, partNumber: part.partNumber },
    });
    return { ok: true };
  });

  // -----------------------------------------------------------------
  // Global audit log (all events, newest first, paginated)
  // -----------------------------------------------------------------
  // `layout`: one layout's whole history, also once it's deleted.
  app.get<{ Querystring: { q?: string; limit?: string; offset?: string; layout?: string } }>(
    '/api/admin/audit',
    async (req) => {
      requireGlobalAdmin(req);
      const limit = clampLimit(req.query.limit);
      const offset = clampOffset(req.query.offset);
      const only = typeof req.query.layout === 'string' && req.query.layout ? eq(schema.auditEvents.layoutId, req.query.layout) : undefined;
      const rows = await db
        .select()
        .from(schema.auditEvents)
        .where(only)
        .orderBy(desc(schema.auditEvents.createdAt))
        .limit(limit)
        .offset(offset);
      const totalRow = await db.select({ n: count() }).from(schema.auditEvents).where(only).get();
      const userIds = [...new Set(rows.map((r) => r.userId).filter((id): id is string => id !== null))];
      const userRows = userIds.length > 0
        ? await db
            .select({ id: schema.users.id, displayName: schema.users.displayName, email: schema.users.email })
            .from(schema.users)
            .where(inArray(schema.users.id, userIds))
        : [];
      const names = new Map(userRows.map((u) => [u.id, u.displayName || u.email]));
      return {
        events: rows.map((r) => ({
          id: r.id,
          layoutId: r.layoutId,
          resourceKind: r.resourceKind,
          resourceId: r.resourceId,
          userId: r.userId,
          userName: r.userId ? (names.get(r.userId) ?? null) : r.actorLabel,
          eventType: r.eventType,
          payload: safeParse(r.payload),
          createdAt: r.createdAt.getTime(),
        })),
        total: totalRow?.n ?? 0,
        limit,
        offset,
      };
    },
  );

  // Admin › Audit log › Deleted layouts: each layout deleted by its owner
  // or a site admin, by the title its delete event recorded, newest first.
  // Its earlier history stays readable through /api/admin/audit?layout=.
  app.get<{ Querystring: { limit?: string; offset?: string } }>('/api/admin/deleted-layouts', async (req) => {
    requireGlobalAdmin(req);
    const limit = clampLimit(req.query.limit);
    const offset = clampOffset(req.query.offset);
    const deletes = and(
      inArray(schema.auditEvents.eventType, ['layout_delete', 'admin_layout_delete']),
      isNotNull(schema.auditEvents.layoutId),
      // Gone for good (a layout that came back isn't listed).
      sql`not exists (select 1 from ${schema.layouts} where ${schema.layouts.id} = ${schema.auditEvents.layoutId})`,
    );
    const rows = await db.select().from(schema.auditEvents).where(deletes).orderBy(desc(schema.auditEvents.createdAt)).limit(limit).offset(offset);
    const totalRow = await db.select({ n: count() }).from(schema.auditEvents).where(deletes).get();
    const userIds = [...new Set(rows.map((r) => r.userId).filter((id): id is string => id !== null))];
    const users = userIds.length > 0 ? await db.select({ id: schema.users.id, displayName: schema.users.displayName, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, userIds)) : [];
    const names = new Map(users.map((u) => [u.id, u.displayName || u.email]));
    const counts = new Map<string, number>();
    const ids = rows.map((r) => r.layoutId!);
    if (ids.length > 0) {
      for (const c of await db.select({ id: schema.auditEvents.layoutId, n: count() }).from(schema.auditEvents).where(inArray(schema.auditEvents.layoutId, ids)).groupBy(schema.auditEvents.layoutId)) counts.set(c.id!, c.n);
    }
    return {
      layouts: rows.map((r) => {
        const p = (safeParse(r.payload) ?? {}) as { title?: unknown; owner?: unknown; clubName?: unknown };
        return {
          layoutId: r.layoutId!,
          title: typeof p.title === 'string' ? p.title : null,
          deletedAt: r.createdAt.getTime(),
          deletedBy: r.userId ? (names.get(r.userId) ?? null) : r.actorLabel,
          by: r.eventType === 'admin_layout_delete' ? 'admin' : 'owner',
          club: typeof p.clubName === 'string' ? p.clubName : null,
          events: counts.get(r.layoutId!) ?? 0,
        };
      }),
      total: totalRow?.n ?? 0,
      limit,
      offset,
    };
  });

  // -----------------------------------------------------------------
  // Part Libraries — installable named sets of parts.
  // Admin installs from zip URL or upload; orgs opt-in/out per library.
  // -----------------------------------------------------------------

  app.get('/api/admin/part-libraries', async (req) => {
    requireGlobalAdmin(req);
    const { env } = await import('../env.js');
    const rows = await db
      .select()
      .from(schema.partLibraries)
      .orderBy(schema.partLibraries.name);
    return { libraries: rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      sourceUrl: r.sourceUrl,
      partCount: r.partCount,
      defaultEnabled: r.defaultEnabled,
      locked: r.locked,
      installedAt: r.installedAt instanceof Date ? r.installedAt.getTime() : r.installedAt,
      updatedAt: r.updatedAt instanceof Date ? r.updatedAt.getTime() : r.updatedAt,
      diskPath: r.slug === 'bluebrickparts' ? env.partsDir : join(env.partsDir, 'libraries', r.slug),
    })),
    // How many parts sit in PARTS_DIR itself (not its libraries/ folder), so
    // the page only offers "Register on-disk library" when there is one.
    onDiskBaseParts: await countBaseXmls(resolve(env.partsDir)).catch(() => 0),
    };
  });

  interface InstallLibraryBody {
    name: string;
    slug: string;
    /** Remote zip URL to fetch; mutually exclusive with zipBase64. */
    sourceUrl?: string;
    /** Base64-encoded zip; used when admin uploads a local file. */
    zipBase64?: string;
    defaultEnabled?: boolean;
  }

  // Install a new part library. The zip is extracted into
  // `${PARTS_DIR}/libraries/${slug}/` so the bundled parts scanner picks
  // them up. We count XMLs found and store the count in the DB row.
  app.post<{ Body: InstallLibraryBody }>( // codeql[js/missing-rate-limiting]
    '/api/admin/part-libraries',
    { config: { rateLimit: perPerson(10, '1 minute') } },
    async (req, reply) => {
    const me = requireGlobalAdmin(req);
    const body = req.body ?? ({} as InstallLibraryBody);
    const name = trimmed(body.name);
    const slugRaw = trimmed(body.slug)?.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!name || !slugRaw) return reply.code(400).send({ error: 'name and slug required' });
    const slug = /^([a-z0-9-]+)$/.exec(slugRaw)?.[1];
    if (!slug) return reply.code(400).send({ error: 'invalid_slug' });

    // Slug must be unique.
    const existing = await db
      .select({ id: schema.partLibraries.id })
      .from(schema.partLibraries)
      .where(eq(schema.partLibraries.slug, slug))
      .get();
    if (existing) return reply.code(409).send({ error: 'slug_conflict' });

    // Resolve library directory.
    const { env } = await import('../env.js');
    const libDir = resolve(join(env.partsDir, 'libraries', slug));
    await mkdir(libDir, { recursive: true });

    let partCount = 0;
    let fetchErr: string | null = null;

    if (body.zipBase64) {
      // Decode + extract zip from upload.
      try {
        const zipBuf = Buffer.from(body.zipBase64, 'base64');
        await extractZip(zipBuf, libDir);
        partCount = await countXmls(libDir);
      } catch (e) {
        fetchErr = e instanceof Error ? e.message : 'zip extraction failed';
      }
    } else if (typeof body.sourceUrl === 'string' && body.sourceUrl) {
      // Validate URL before touching the filesystem.
      try { new URL(body.sourceUrl.trim()); } catch {
        await rm(libDir, { recursive: true, force: true });
        return reply.code(400).send({ error: 'invalid sourceUrl' });
      }
      try {
        const res = await safeFetch(body.sourceUrl.trim(), { signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 100 * 1024 * 1024) throw new Error('Archive exceeds 100 MB limit');
        await extractZip(buf, libDir);
        partCount = await countXmls(libDir);
      } catch (e) {
        fetchErr = e instanceof Error ? e.message : 'download failed';
      }
    }

    if (fetchErr) {
      // Clean up empty dir.
      await rm(libDir, { recursive: true, force: true });
      return reply.code(422).send({ error: fetchErr });
    }

    const id = randomUUID();
    const now = new Date();
    await db.insert(schema.partLibraries).values({
      id,
      name,
      slug,
      sourceUrl: body.sourceUrl ?? null,
      partCount,
      defaultEnabled: body.defaultEnabled ?? false,
      installedAt: now,
      updatedAt: now,
    });
    await writeAuditEvent({
      resourceKind: 'part_library',
      resourceId: id,
      userId: me.id,
      eventType: 'admin_part_library_install',
      payload: { name, slug, partCount, sourceUrl: body.sourceUrl ?? null },
    });
    // The new library's parts are in the catalog from the next request on.
    invalidatePartsCache();
    return reply.code(201).send({ id, slug, partCount });
  });

  // Search BlueBrick download-center sources for available packages.
  // Acts as a server-side proxy so the browser doesn't hit CORS.
  // `source` can be 'official', 'nonlego', or any https:// URL.
  app.get<{ Querystring: { source?: string } }>( // codeql[js/missing-rate-limiting]
    '/api/admin/part-libraries/search',
    { config: { rateLimit: perPerson(10, '1 minute') } },
    async (req, reply) => {
      requireGlobalAdmin(req);
      const source = (req.query.source ?? '').trim();

      let indexUrl: string;
      if (source === 'official') {
        indexUrl = 'https://bluebrick.lswproject.com/download/package/';
      } else if (source === 'nonlego') {
        indexUrl = 'https://bluebrick.lswproject.com/download/packageOther/';
      } else if (source.startsWith('https://')) {
        indexUrl = source.endsWith('/') ? source : source + '/';
      } else {
        return reply.code(400).send({ error: 'invalid source' });
      }

      let html: string;
      try {
        const res = await safeFetch(indexUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (compatible; Collaborative Brick Layout Designer/1.0; +https://github.com/collaborative-brick-layout-designer/web)',
          },
          signal: AbortSignal.timeout(20_000),
          maxBytes: 1024 * 1024,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.arrayBuffer();
        if (raw.byteLength > 1024 * 1024) throw new Error('Index page exceeds 1 MB');
        html = Buffer.from(raw).toString('utf8');
      } catch (e) {
        return reply.code(502).send({
          error: e instanceof Error ? e.message : 'fetch failed',
        });
      }

      // Same regex as the desktop DownloadCenterDialog:
      // <a href="...zip">Name.zip</a>
      const rx = /<a href="[^"]+\.zip">([^<]+\.zip)<\/a>/gi;
      const packages: Array<{ name: string; version: string; fileName: string; sourceUrl: string }> =
        [];
      let m: RegExpExecArray | null;
      while ((m = rx.exec(html)) !== null) {
        const fileName = m[1]!;
        const stem = fileName.slice(0, -4); // strip ".zip"
        let name = stem;
        let version = '';
        const dot = stem.indexOf('.');
        if (dot > 0) {
          name = stem.slice(0, dot);
          version = stem.slice(dot + 1);
        }
        packages.push({ name, version, fileName, sourceUrl: indexUrl + fileName });
      }

      return { packages, indexUrl };
    },
  );

  // Register the bundled parts library (already on disk at PARTS_DIR) as a
  // part_library row — no extraction needed, just a DB record so orgs can
  // see and enable it.
  app.post('/api/admin/part-libraries/install-base', async (req, reply) => {
    const me = requireGlobalAdmin(req);

    const existing = await db
      .select({ id: schema.partLibraries.id })
      .from(schema.partLibraries)
      .where(eq(schema.partLibraries.slug, 'bluebrickparts'))
      .get();
    if (existing) return reply.code(409).send({ error: 'already_installed' });

    const { env } = await import('../env.js');
    let partCount: number;
    try {
      partCount = await countBaseXmls(resolve(env.partsDir));
    } catch {
      // No base library on disk was a bare 500.
      return reply.code(409).send({ error: 'parts_dir_missing', message: 'The server has no base parts library folder (PARTS_DIR) to register.' });
    }
    // An empty folder would register a locked library with no parts, which
    // also hides "Get the parts library", so every layout shows missing parts.
    if (partCount === 0) {
      return reply.code(409).send({ error: 'parts_dir_empty', message: 'There are no parts on the server yet. Use "Get the parts library" instead.' });
    }

    const id = randomUUID();
    const now = new Date();
    await db.insert(schema.partLibraries).values({
      id,
      name: 'BlueBrickParts (base library)',
      slug: 'bluebrickparts',
      sourceUrl: 'https://github.com/Lswbanban/BlueBrickParts',
      partCount,
      defaultEnabled: true,
      locked: true,
      installedAt: now,
      updatedAt: now,
    });
    await writeAuditEvent({
      resourceKind: 'part_library',
      resourceId: id,
      userId: me.id,
      eventType: 'admin_part_library_install',
      payload: { name: 'BlueBrickParts (base library)', slug: 'bluebrickparts', partCount },
    });
    invalidatePartsCache();
    return reply.code(201).send({ id, slug: 'bluebrickparts', partCount });
  });

  // Download a package from a known BlueBrick source URL and install it.
  // Mirrors desktop DownloadCenterDialog::downloadAndInstall.
  interface DownloadLibraryBody {
    name: string;
    slug: string;
    sourceUrl: string;
    defaultEnabled?: boolean;
  }

  app.post<{ Body: DownloadLibraryBody }>( // codeql[js/missing-rate-limiting]
    '/api/admin/part-libraries/download',
    // Site admins only. Installing every Download Center pack at once is
    // about 20 in a row; 10 a minute stopped at the 11th.
    { config: { rateLimit: perPerson(60, '1 minute') } },
    async (req, reply) => {
      const me = requireGlobalAdmin(req);
      const body = req.body ?? ({} as DownloadLibraryBody);
      const name = trimmed(body.name);
      const slugRaw = trimmed(body.slug)?.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const sourceUrl = trimmed(body.sourceUrl);

      if (!name || !slugRaw || !sourceUrl) {
        return reply.code(400).send({ error: 'name, slug and sourceUrl required' });
      }
      const dlSlug = /^([a-z0-9-]+)$/.exec(slugRaw)?.[1];
      if (!dlSlug) return reply.code(400).send({ error: 'invalid_slug' });
      // Validate URL shape before any DB/filesystem work.
      try { new URL(sourceUrl); } catch {
        return reply.code(400).send({ error: 'invalid sourceUrl' });
      }
      // Only allow bluebrick.lswproject.com or user-confirmed custom URLs.
      // The slug-conflict check acts as an idempotency guard.
      const existing = await db
        .select({ id: schema.partLibraries.id })
        .from(schema.partLibraries)
        .where(eq(schema.partLibraries.slug, dlSlug))
        .get();
      if (existing) return reply.code(409).send({ error: 'slug_conflict' });

      const { env } = await import('../env.js');
      const libDir = resolve(join(env.partsDir, 'libraries', dlSlug));
      await mkdir(libDir, { recursive: true });

      try {
        const res = await safeFetch(sourceUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (compatible; Collaborative Brick Layout Designer/1.0; +https://github.com/collaborative-brick-layout-designer/web)',
          },
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 100 * 1024 * 1024) throw new Error('Archive exceeds 100 MB limit');
        await extractZip(buf, libDir);
      } catch (e) {
        await rm(libDir, { recursive: true, force: true });
        return reply.code(422).send({ error: e instanceof Error ? e.message : 'download failed' });
      }

      const partCount = await countXmls(libDir);
      const id = randomUUID();
      const now = new Date();
      await db.insert(schema.partLibraries).values({
        id,
        name,
        slug: dlSlug,
        sourceUrl: sourceUrl,
        partCount,
        defaultEnabled: body.defaultEnabled ?? false,
        installedAt: now,
        updatedAt: now,
      });
      await writeAuditEvent({
        resourceKind: 'part_library',
        resourceId: id,
        userId: me.id,
        eventType: 'admin_part_library_install',
        payload: { name, slug: dlSlug, partCount, sourceUrl: sourceUrl },
      });
      invalidatePartsCache();
      return reply.code(201).send({ id, slug: dlSlug, partCount });
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { defaultEnabled?: boolean; name?: string; locked?: boolean };
  }>('/api/admin/part-libraries/:id', async (req, reply) => {
    const me = requireGlobalAdmin(req);
    const lib = await db
      .select()
      .from(schema.partLibraries)
      .where(eq(schema.partLibraries.id, req.params.id))
      .get();
    if (!lib) return reply.code(404).send({ error: 'not_found' });
    const patch: Partial<typeof schema.partLibraries.$inferInsert> = { updatedAt: new Date() };
    if (typeof req.body.defaultEnabled === 'boolean') patch.defaultEnabled = req.body.defaultEnabled;
    if (typeof req.body.name === 'string' && req.body.name.trim()) patch.name = req.body.name.trim();
    if (typeof req.body.locked === 'boolean') patch.locked = req.body.locked;
    await db.update(schema.partLibraries).set(patch).where(eq(schema.partLibraries.id, lib.id));
    await writeAuditEvent({
      resourceKind: 'part_library',
      resourceId: lib.id,
      userId: me.id,
      eventType: 'admin_part_library_patch',
      payload: { patch },
    });
    return { ok: true };
  });

  // POST /api/admin/part-libraries/:id/update
  // Re-fetch from sourceUrl and replace directory contents in-place.
  app.post<{ Params: { id: string } }>( // codeql[js/missing-rate-limiting]
    '/api/admin/part-libraries/:id/update',
    { config: { rateLimit: perPerson(10, '1 minute') } },
    async (req, reply) => {
      const me = requireGlobalAdmin(req);
      const lib = await db
        .select()
        .from(schema.partLibraries)
        .where(eq(schema.partLibraries.id, req.params.id))
        .get();
      if (!lib) return reply.code(404).send({ error: 'not_found' });
      if (!lib.sourceUrl) return reply.code(400).send({ error: 'no_source_url' });
      const safeSlug = /^([a-z0-9-]+)$/.exec(lib.slug)?.[1];
      if (!safeSlug) return reply.code(500).send({ error: 'corrupt_slug' });
      const { env } = await import('../env.js');
      const libDir = resolve(join(env.partsDir, 'libraries', safeSlug));

      // Download into a temp sibling dir, swap on success.
      const tmpDir = libDir + '.tmp_update';
      await rm(tmpDir, { recursive: true, force: true });
      await mkdir(tmpDir, { recursive: true });

      try {
        const res = await safeFetch(lib.sourceUrl, { signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 100 * 1024 * 1024) throw new Error('Archive exceeds 100 MB limit');
        await extractZip(buf, tmpDir);
      } catch (e) {
        await rm(tmpDir, { recursive: true, force: true });
        return reply.code(422).send({ error: e instanceof Error ? e.message : 'download failed' });
      }

      // Swap: remove old dir, rename tmp into place.
      await rm(libDir, { recursive: true, force: true });
      const { rename } = await import('node:fs/promises');
      await rename(tmpDir, libDir);

      const partCount = await countXmls(libDir);
      const now = new Date();
      await db
        .update(schema.partLibraries)
        .set({ partCount, updatedAt: now })
        .where(eq(schema.partLibraries.id, lib.id));

      invalidatePartsCache();

      await writeAuditEvent({
        resourceKind: 'part_library',
        resourceId: lib.id,
        userId: me.id,
        eventType: 'admin_part_library_update',
        payload: { name: lib.name, slug: lib.slug, partCount, sourceUrl: lib.sourceUrl },
      });
      return { ok: true, partCount };
    },
  );

  app.delete<{ Params: { id: string } }>( // codeql[js/missing-rate-limiting]
    '/api/admin/part-libraries/:id',
    { config: { rateLimit: perPerson(10, '1 minute') } },
    async (req, reply) => {
    const me = requireGlobalAdmin(req);
    const lib = await db
      .select()
      .from(schema.partLibraries)
      .where(eq(schema.partLibraries.id, req.params.id))
      .get();
    if (!lib) return reply.code(404).send({ error: 'not_found' });
    const delSlug = /^([a-z0-9-]+)$/.exec(lib.slug)?.[1];
    if (!delSlug) return reply.code(500).send({ error: 'corrupt_slug' });

    // Remove the library directory from disk.
    const { env } = await import('../env.js');
    const libDir = resolve(join(env.partsDir, 'libraries', delSlug));
    await rm(libDir, { recursive: true, force: true });

    await db.delete(schema.partLibraries).where(eq(schema.partLibraries.id, lib.id));
    await writeAuditEvent({
      resourceKind: 'part_library',
      resourceId: lib.id,
      userId: me.id,
      eventType: 'admin_part_library_delete',
      payload: { name: lib.name, slug: lib.slug },
    });
    invalidatePartsCache();
    return { ok: true };
  });

  // -----------------------------------------------------------------
  // Reload parts library — drops the in-process catalog cache so the
  // next `/api/parts/catalog` request triggers a fresh rescan of all
  // directories. Port of Tools → Reload Parts Library.
  // -----------------------------------------------------------------
  app.post('/api/admin/reload-parts', async (req) => {
    requireGlobalAdmin(req);
    invalidatePartsCache();
    return { ok: true };
  });

  // -----------------------------------------------------------------
  // Aggregate stats — one cheap call so the dashboard can render.
  // -----------------------------------------------------------------
  app.get('/api/admin/stats', async (req) => {
    requireGlobalAdmin(req);
    const [usersRow, orgsRow, layoutsRow, partsRow, modulesRow, adminRow, sessionsRow] = await Promise.all([
      db.select({ n: count() }).from(schema.users).where(notDemoSpace()).get(),
      db.select({ n: count() }).from(schema.orgs).get(),
      db.select({ n: count() }).from(schema.layouts).get(),
      db.select({ n: count() }).from(schema.customParts).get(),
      db.select({ n: count() }).from(schema.modules).get(),
      db
        .select({ n: count() })
        .from(schema.users)
        .where(eq(schema.users.isGlobalAdmin, true))
        .get(),
      db
        .select({ n: count() })
        .from(schema.sessions)
        .where(sql`${schema.sessions.expiresAt} > ${Date.now()}`)
        .get(),
    ]);
    return {
      users: usersRow?.n ?? 0,
      globalAdmins: adminRow?.n ?? 0,
      orgs: orgsRow?.n ?? 0,
      layouts: layoutsRow?.n ?? 0,
      customParts: partsRow?.n ?? 0,
      modules: modulesRow?.n ?? 0,
      activeSessions: sessionsRow?.n ?? 0,
    };
  });

  // -----------------------------------------------------------------
  // Platform settings — email verification requirement + SMTP config.
  // Singleton row; see auth/platformSettings.ts for the get-or-create
  // and DB-over-env merge logic.
  // -----------------------------------------------------------------
  app.get('/api/admin/settings', async (req) => {
    requireGlobalAdmin(req);
    const settings = await getPlatformSettings();
    const resolvedSmtp = mergeSmtpConfig(settings);
    return {
      requireEmailVerification: settings.requireEmailVerification,
      smtp: {
        // The DB fields as stored, MINUS the password — never send a
        // secret to the client once it's saved. smtpPassSet lets the
        // UI show "•••• (set)" without round-tripping the value.
        host: settings.smtpHost,
        port: settings.smtpPort,
        user: settings.smtpUser,
        from: settings.smtpFrom,
        passSet: !!settings.smtpPass,
        // What's actually active right now, for display — lets the UI
        // show "using .env" vs "using database config" and warn when
        // neither is configured (verification links will only be
        // logged, not emailed).
        source: resolvedSmtp?.source ?? null,
        active: resolvedSmtp !== null,
      },
      // "Oldest desktop allowed": what the admin set (null = the code's
      // own), what's in force, and the floor it can't go below.
      desktop: {
        minimumSet: settings.minDesktopVersion,
        ...resolvePolicy(settings.minDesktopVersion),
        codeMinimum: DESKTOP_MINIMUM,
      },
      // Public catalogs (off until turned on) and their review step.
      catalog: {
        modules: settings.moduleCatalogEnabled,
        parts: settings.partsCatalogEnabled,
        layouts: settings.layoutCatalogEnabled,
        venues: settings.venueCatalogEnabled,
        review: settings.catalogReview,
        anonymousBrowse: settings.catalogAnonymousBrowse,
        // The biggest collection cover upload (an env var may force it).
        coverMaxBytes: await coverMaxBytes(),
      },
      // Background jobs: switches here, unless the server's env var
      // forces one (forcedBy names it).
      jobs: await backgroundJobs(),
      // The demo account: on or off, how often it resets, when it last
      // did and how many things it has now.
      demo: { ...demoStatus(settings), items: await demoItemCount(), maxSpaces: settings.demoMaxSpaces, liveSpaces: await liveDemoSpaces() },
      // Privacy: data downloads (and, later, deleting accounts and keeping
      // records), each with where its value comes from.
      privacy: {
        settings: await privacySettingStates(),
        notice: settings.privacyNotice ?? '',
        contact: await privacyContact(),
      },
      // Sign-in: how long a web or desktop sign-in lasts unused, and the
      // longest it can last (hours or 'never'), each with where its value
      // comes from. Demo sign-ins end at each reset (24 hours at most).
      // publicUrl: the site address, so the page can show the callback
      // addresses a GitHub or Google sign-in app must be given.
      signIn: { settings: await signInSettingStates(), publicUrl: env.publicUrl },
      // The server's own settings that can't be changed from this page,
      // with why: secrets, things read once at start, the deployment's own
      // paths and ports, and the first admin (needed before there is a DB).
      serverSetup: serverSetup(),
      updatedAt: settings.updatedAt.getTime(),
    };
  });

  app.patch<{
    Body: {
      requireEmailVerification?: boolean;
      smtpHost?: string | null;
      smtpPort?: number | null;
      smtpUser?: string | null;
      smtpPass?: string | null;
      smtpFrom?: string | null;
      minDesktopVersion?: string | null;
      moduleCatalogEnabled?: boolean;
      limitsEnforced?: boolean;
      partsCatalogEnabled?: boolean;
      layoutCatalogEnabled?: boolean;
      venueCatalogEnabled?: boolean;
      catalogReview?: string;
      catalogAnonymousBrowse?: boolean;
      backupsEnabled?: boolean;
      dailyCompactionEnabled?: boolean;
      demoEnabled?: boolean;
      demoResetEvery?: string;
      demoMaxSpaces?: unknown;
      demoSpaceMinutes?: unknown;
      collectionCoverMaxBytes?: number;
      /** Admin › Settings › Privacy: key -> number, or null for the default (privacy/settings.ts). */
      privacy?: Record<string, number | null>;
      /** The privacy page: a notice (markdown) and a contact (email or web address); "" clears. */
      privacyNotice?: string | null;
      privacyContact?: string | null;
      /** Admin › Settings › Sign-in: key -> hours (or 'never' for a longest), or null for the default (auth/signInSettings.ts). */
      signIn?: Record<string, number | 'never' | null>;
    };
  }>('/api/admin/settings', async (req, reply) => {
    const me = requireGlobalAdmin(req);
    const body = req.body ?? {};
    const patch: Partial<typeof schema.platformSettings.$inferInsert> = {};

    if (typeof body.requireEmailVerification === 'boolean') {
      patch.requireEmailVerification = body.requireEmailVerification;
    }
    // Absent field = leave unchanged; null OR "" = clear it (drop back
    // to env.smtp, or to "unconfigured" for smtpHost/smtpFrom) — an
    // empty string is normalised to null so smtpHost stays either a
    // real value or null, never "", which mergeSmtpConfig would
    // otherwise treat as falsy anyway but is worth keeping clean in
    // the DB. smtpPass is the one field where "" vs omitted actually
    // differ in meaning — see below.
    if ('smtpHost' in body) patch.smtpHost = body.smtpHost || null;
    if ('smtpPort' in body) {
      if (body.smtpPort !== null && (!Number.isInteger(body.smtpPort) || body.smtpPort < 1 || body.smtpPort > 65535)) {
        return reply.code(400).send({ error: 'invalid_smtp_port' });
      }
      patch.smtpPort = body.smtpPort;
    }
    if ('smtpUser' in body) patch.smtpUser = body.smtpUser || null;
    if ('smtpFrom' in body) patch.smtpFrom = body.smtpFrom || null;
    if ('smtpPass' in body) {
      // Client sends "" to explicitly clear a saved password; omits
      // the field entirely to leave whatever's saved untouched. A
      // non-empty value replaces it. This mirrors the GET response
      // never echoing the real password back, so the form can't
      // "round-trip" a masked placeholder into a real clear.
      patch.smtpPass = body.smtpPass === '' ? null : body.smtpPass;
    }

    if ('minDesktopVersion' in body) {
      // null or "" = back to the code's own minimum.
      const v = typeof body.minDesktopVersion === 'string' ? body.minDesktopVersion.trim().replace(/^[vV]/, '') : '';
      if (v && (v.length > 32 || compareVersions(v, DESKTOP_MINIMUM) === null)) {
        return reply.code(400).send({ error: 'invalid_desktop_version' });
      }
      patch.minDesktopVersion = v || null;
    }
    if (typeof body.moduleCatalogEnabled === 'boolean') patch.moduleCatalogEnabled = body.moduleCatalogEnabled;
    if (typeof body.limitsEnforced === 'boolean') patch.limitsEnforced = body.limitsEnforced;
    if (typeof body.partsCatalogEnabled === 'boolean') patch.partsCatalogEnabled = body.partsCatalogEnabled;
    if (typeof body.layoutCatalogEnabled === 'boolean') patch.layoutCatalogEnabled = body.layoutCatalogEnabled;
    if (typeof body.venueCatalogEnabled === 'boolean') patch.venueCatalogEnabled = body.venueCatalogEnabled;
    if (typeof body.catalogAnonymousBrowse === 'boolean') patch.catalogAnonymousBrowse = body.catalogAnonymousBrowse;
    if (typeof body.backupsEnabled === 'boolean') patch.backupsEnabled = body.backupsEnabled;
    if (typeof body.dailyCompactionEnabled === 'boolean') patch.dailyCompactionEnabled = body.dailyCompactionEnabled;
    if (typeof body.demoEnabled === 'boolean') patch.demoEnabled = body.demoEnabled;
    if ('demoMaxSpaces' in body) {
      const n = body.demoMaxSpaces;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 10_000) return reply.code(400).send({ error: 'invalid_input' });
      patch.demoMaxSpaces = n;
    }
    if ('demoSpaceMinutes' in body) {
      const n = body.demoSpaceMinutes;
      if (typeof n !== 'number' || !DEMO_SPACE_MINUTES_CHOICES.includes(n)) return reply.code(400).send({ error: 'invalid_input' });
      patch.demoSpaceMinutes = n;
    }
    if ('demoResetEvery' in body) {
      if (!DEMO_RESET_CHOICES.includes(body.demoResetEvery as DemoResetEvery)) return reply.code(400).send({ error: 'invalid_input' });
      patch.demoResetEvery = body.demoResetEvery as DemoResetEvery;
    }
    if ('collectionCoverMaxBytes' in body) {
      const n = body.collectionCoverMaxBytes;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < COVER_MAX_FLOOR || n > COVER_MAX_CEILING) return reply.code(400).send({ error: 'invalid_input' });
      patch.collectionCoverMaxBytes = n;
    }
    if ('privacy' in body) {
      const merged = mergePrivacyPatch((await getPlatformSettings()).privacy, body.privacy);
      if ('error' in merged) return reply.code(400).send({ error: 'invalid_input', detail: merged.error });
      patch.privacy = merged.json;
    }
    if ('signIn' in body) {
      const merged = mergeSignInPatch((await getPlatformSettings()).signIn, body.signIn);
      if ('error' in merged) {
        // The longest below the idle window gets its own sentence.
        if (merged.error.startsWith('sign_in_max_below_idle')) {
          return reply.code(400).send({
            error: 'sign_in_max_below_idle',
            detail: merged.error,
            message: 'The longest a sign-in can last can’t be shorter than the time it lasts unused.',
          });
        }
        return reply.code(400).send({ error: 'invalid_input', detail: merged.error });
      }
      patch.signIn = merged.json;
    }
    if ('privacyNotice' in body) {
      const v = body.privacyNotice;
      if (v !== null && (typeof v !== 'string' || v.length > NOTICE_MAX)) return reply.code(400).send({ error: 'invalid_input' });
      patch.privacyNotice = v && v.trim() ? v : null;
    }
    if ('privacyContact' in body) {
      const v = typeof body.privacyContact === 'string' ? body.privacyContact.trim() : body.privacyContact;
      if (v !== null && v !== '' && (typeof v !== 'string' || !validContact(v))) {
        return reply.code(400).send({ error: 'invalid_contact', message: 'Use an email address or a web address (https://…).' });
      }
      patch.privacyContact = v || null;
    }
    if ('catalogReview' in body) {
      if (body.catalogReview !== 'moderators' && body.catalogReview !== 'none') return reply.code(400).send({ error: 'invalid_input' });
      patch.catalogReview = body.catalogReview;
    }

    if (Object.keys(patch).length === 0) {
      return reply.code(400).send({ error: 'empty_patch' });
    }

    const before = await getPlatformSettings(); // ensure the row exists before UPDATE
    await db
      .update(schema.platformSettings)
      .set({ ...patch, updatedAt: new Date(), updatedBy: me.id })
      .where(eq(schema.platformSettings.id, PLATFORM_SETTINGS_ID));
    invalidateTransporter();
    resetDesktopPolicy();
    invalidateLimitCaches(); // the limits switch takes effect at once
    invalidatePrivacyCache();
    // Applies to every sign-in at its next check; nobody is signed out now.
    invalidateSignInCache();
    // Turning the demo on makes (or re-enables) its account with fresh
    // samples; turning it off signs every visitor out.
    if (patch.demoEnabled === true && !before.demoEnabled) {
      await ensureDemoUser();
      await runDemoReset();
    } else if (patch.demoEnabled === false && before.demoEnabled) {
      await signOutDemo();
      // Every visitor's space goes with the demo.
      await deleteAllDemoSpaces('demo_off');
    }

    await writeAuditEvent({
      resourceKind: 'platform_settings',
      resourceId: PLATFORM_SETTINGS_ID,
      userId: me.id,
      eventType: 'admin_settings_patch',
      // Never audit the password value itself.
      payload: {
        patch: {
          ...patch,
          smtpPass: patch.smtpPass !== undefined ? '(redacted)' : undefined,
          // The notice can be long: the log says it changed, not what it says.
          privacyNotice: patch.privacyNotice !== undefined ? '(changed)' : undefined,
        },
      },
    });
    return { ok: true };
  });

  // -----------------------------------------------------------------
  // Demo account › "Reset now": wipe its things and put the samples
  // back, the same as the timer does. JSON, no body (or `{}`).
  // -----------------------------------------------------------------
  app.post('/api/admin/demo/reset', { config: { rateLimit: perPerson(10, '1 minute') } }, async (req, reply) => {
    const me = requireGlobalAdmin(req);
    if (!(await getPlatformSettings()).demoEnabled) return reply.code(409).send({ error: 'demo_off' });
    const result = await runDemoReset();
    await writeAuditEvent({
      resourceKind: 'platform_settings',
      resourceId: PLATFORM_SETTINGS_ID,
      userId: me.id,
      eventType: 'admin_demo_reset',
      payload: result,
    });
    return { ok: true, ...result };
  });
}

// ---------------------------------------------------------------------------
// Zip extraction helper — uses the built-in DecompressionStream (Node 18+).
// Falls back to iterating a simple stored-zip by walking entries. For a more
// robust solution production deployments can swap in `unzipper`; this avoids
// an extra dependency for now.
// ---------------------------------------------------------------------------

/**
 * Detect a single common top-level directory in a list of entry names.
 * GitHub archives always wrap everything in e.g. "RepoName-main/" — we
 * strip that so the contents land directly in destDir.
 */
export function detectTopLevelPrefix(names: string[]): string {
  if (names.length === 0) return '';
  const segments = names[0]?.split('/') ?? [];
  const first = (segments[0] ?? '') + '/';
  if (!first || first === '/') return '';
  if (names.every((n) => n.startsWith(first))) return first;
  return '';
}

export async function extractZip(buf: Buffer, destDir: string): Promise<void> {
  const { writeFile: wf, mkdir: mk } = await import('node:fs/promises');
  const { join: j, dirname } = await import('node:path');
  const { inflateRawSync } = await import('node:zlib');

  const MAX_ENTRY_SIZE = 200 * 1024 * 1024; // 200 MB per file
  const MAX_TOTAL_SIZE = 500 * 1024 * 1024; // 500 MB total uncompressed
  let totalUncomp = 0;

  function safeDestPath(base: string, entryName: string): string {
    const dest = j(base, entryName);
    // Prevent ZIP slip — resolved path must stay inside destDir.
    if (!dest.startsWith(base + '/') && dest !== base) {
      throw new Error(`ZIP slip attempt: ${entryName}`);
    }
    return dest;
  }

  // Minimal local-file-entry parser (stored + deflate). Collect all names
  // first to detect the common top-level prefix, then extract.
  interface RawEntry { name: string; method: number; compSize: number; uncompSize: number; dataOff: number }
  const rawEntries: RawEntry[] = [];
  let off = 0;
  function u16() { const v = buf.readUInt16LE(off); off += 2; return v; }
  function u32() { const v = buf.readUInt32LE(off); off += 4; return v; }
  function skip(n: number) { off += n; }
  function read(n: number) { const v = buf.subarray(off, off + n); off += n; return v; }

  while (off + 4 <= buf.length) {
    if (buf.readUInt32LE(off) !== 0x04034b50) break;
    off += 4;
    skip(2); // version needed
    skip(2); // flags
    const method = u16();
    skip(2 + 2 + 4); // mod time, mod date, crc
    const compSize = u32();
    const uncompSize = u32();
    const nameLen = u16();
    const extraLen = u16();
    const name = read(nameLen).toString('utf8');
    skip(extraLen);
    const dataOff = off;
    skip(compSize);
    rawEntries.push({ name, method, compSize, uncompSize, dataOff });
  }

  const prefix = detectTopLevelPrefix(rawEntries.map((e) => e.name));

  for (const entry of rawEntries) {
    if (entry.name.endsWith('/')) continue;
    const stripped = prefix ? entry.name.slice(prefix.length) : entry.name;
    if (!stripped) continue;
    if (entry.uncompSize > MAX_ENTRY_SIZE) throw new Error(`entry too large: ${entry.name}`);
    if (totalUncomp + entry.uncompSize > MAX_TOTAL_SIZE) {
      throw new Error('zip bomb: total uncompressed size exceeds limit');
    }
    const dest = safeDestPath(destDir, stripped);
    await mk(dirname(dest), { recursive: true });
    const compData = buf.subarray(entry.dataOff, entry.dataOff + entry.compSize);
    let data: Uint8Array;
    if (entry.method === 0) {
      data = new Uint8Array(compData);
    } else if (entry.method === 8) {
      // Never inflate past what the header declared (itself capped
      // above): a small entry claiming 1 KB can otherwise expand to
      // gigabytes in memory before the size check below ever runs.
      const limit = Math.max(1, Math.min(entry.uncompSize, MAX_ENTRY_SIZE, MAX_TOTAL_SIZE - totalUncomp));
      try {
        data = new Uint8Array(inflateRawSync(new Uint8Array(compData), { maxOutputLength: limit }));
      } catch (e) {
        if (e instanceof RangeError) {
          throw new Error(`zip bomb: ${entry.name} inflates beyond its declared size`, { cause: e });
        }
        throw e;
      }
    } else {
      throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
    }
    if (data.length !== entry.uncompSize) throw new Error(`size mismatch for ${entry.name}`);
    totalUncomp += data.length;
    if (totalUncomp > MAX_TOTAL_SIZE) throw new Error('zip bomb: total uncompressed size exceeds limit');
    await wf(dest, data);
  }
}

async function countXmls(dir: string, skipTopLevel?: string): Promise<number> {
  let n = 0;
  async function walk(d: string) {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (d === dir && e.name === skipTopLevel) continue;
        await walk(full);
      }
      else if (extname(e.name).toLowerCase() === '.xml') n++;
    }
  }
  await walk(dir);
  return n;
}

/** Parts in the base library at PARTS_DIR, leaving out installed libraries. */
function countBaseXmls(partsDir: string): Promise<number> {
  return countXmls(partsDir, 'libraries');
}

/**
 * Called once at server startup. Scans PARTS_DIR/libraries/ for directories
 * that exist on disk but are not yet registered in part_libraries, and
 * auto-registers them. This makes the container survive a DB wipe while the
 * parts volume is retained — on the next boot the libraries reappear.
 */
export async function syncLibrariesFromDisk(partsDir: string, logger?: { info: (msg: string) => void }): Promise<void> {
  const { existsSync } = await import('node:fs');
  const libsDir = join(partsDir, 'libraries');
  if (!existsSync(libsDir)) return;

  // Read the directory as a plain string-name listing (no withFileTypes) —
  // newer @types/node made `readdir(..., { withFileTypes: true })`'s return
  // type depend on the encoding overload TS happens to pick, which doesn't
  // always match what's actually returned at runtime. `isDirectory()` below
  // becomes a real fs.statSync check instead of trusting a Dirent flag.
  let names: string[];
  try {
    names = await readdir(libsDir);
  } catch {
    return;
  }
  const { statSync } = await import('node:fs');
  const entries = names
    .map((name) => ({ name, isDirectory: () => {
      try {
        return statSync(join(libsDir, name)).isDirectory();
      } catch {
        return false;
      }
    } }));

  const existing = await db.select({ slug: schema.partLibraries.slug }).from(schema.partLibraries);
  const registeredSlugs = new Set(existing.map((r) => r.slug));

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    if (registeredSlugs.has(slug)) continue;

    const libDir = join(libsDir, slug);
    let partCount: number;
    try {
      partCount = await countXmls(libDir);
    } catch {
      continue;
    }
    if (partCount === 0) continue;

    const id = randomUUID();
    const now = new Date();
    await db.insert(schema.partLibraries).values({
      id,
      name: slug,
      slug,
      sourceUrl: null,
      partCount,
      defaultEnabled: false,
      locked: false,
      installedAt: now,
      updatedAt: now,
    });
    logger?.info(`auto-registered library from disk: ${slug} (${partCount} parts)`);
  }
}

/** Why a server setting can't be changed from Admin › Settings. */
type SetupWhy = 'secret' | 'restart' | 'deploy' | 'bootstrap';

export interface ServerSetupRow {
  name: string;
  value: string;
  /** The env var(s) to change it with. */
  env: string;
  why: SetupWhy;
}

/** The server's env-only settings, as Admin › Settings shows them (never a secret's value). */
export function serverSetup(): ServerSetupRow[] {
  const onOff = (b: boolean) => (b ? 'On' : 'Off');
  const setUp = (b: boolean) => (b ? 'Set up' : 'Not set up');
  return [
    { name: 'Password sign-in', value: onOff(env.enablePasswordAuth), env: 'ENABLE_PASSWORD_AUTH', why: 'restart' },
    { name: 'Google sign-in', value: setUp(!!env.google), env: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET', why: 'secret' },
    { name: 'GitHub sign-in', value: setUp(!!env.github), env: 'GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET', why: 'secret' },
    { name: 'Single sign-on (OIDC)', value: setUp(!!env.oidc), env: 'OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET', why: 'secret' },
    { name: 'Site address', value: env.publicUrl, env: 'PUBLIC_URL', why: 'deploy' },
    { name: 'Secure cookies', value: onOff(env.cookieSecure), env: 'COOKIE_SECURE', why: 'deploy' },
    { name: 'Behind a proxy', value: env.trustProxy === false ? 'No' : env.trustProxy === true ? 'Yes' : String(env.trustProxy), env: 'TRUST_PROXY', why: 'deploy' },
    { name: 'Parts folder', value: env.partsDir, env: 'PARTS_DIR', why: 'deploy' },
    { name: 'Backups folder', value: env.backupsDir, env: 'BACKUPS_DIR', why: 'deploy' },
    { name: 'Database file', value: env.dbPath, env: 'DB_PATH', why: 'deploy' },
    { name: 'Port', value: String(env.port), env: 'HTTP_PORT', why: 'deploy' },
    { name: 'First admin', value: setUp(!!env.bootstrapAdminEmail), env: 'BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD', why: 'bootstrap' },
  ];
}
