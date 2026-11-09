// Admin: usage limits and the abuse view. All routes are admin-only, and
// every change (global limits, an override, a suspension) is audited.
//
//   GET   /api/admin/limits                 global limits, where each value comes from
//   PATCH /api/admin/limits                 change global limits ({ key: number | null })
//   GET   /api/admin/abuse/users?sort=      top people, with flags
//   GET   /api/admin/abuse/clubs?sort=      top clubs, with flags
//   GET   /api/admin/users/:id/usage        one person: usage against limits, graphs, activity
//   GET   /api/admin/orgs/:id/usage         one club: the same
//   PUT   /api/admin/users/:id/limits       overrides and suspension for a person
//   PUT   /api/admin/orgs/:id/limits        overrides and suspension for a club

import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { db, schema } from '../db/index.js';
import { env } from '../env.js';
import { requireGlobalAdmin } from '../auth/cookie.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { getPlatformSettings, PLATFORM_SETTINGS_ID } from '../auth/platformSettings.js';
import {
  cleanLimits,
  enforcementSource,
  envDefaults,
  globalLimits,
  limitsEnforced,
  invalidateLimitCaches,
  isLimitKey,
  LIMITS,
  orgLimits,
  overrideFor,
  usageOf,
  userLimits,
  type EffectiveLimit,
  type LimitKey,
  type Usage,
} from '../limits/limits.js';
import { dayKey } from '../metrics/rollup.js';
import { usage as usageCounter } from '../metrics/usage.js';
import { liveConnectionsByLayout, liveConnectionsByUser } from './ws.js';
import { trimmed } from '../utils/validate.js';
import { notifyAccessChanged } from '../ws/liveAccess.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Something "far above the usual" is over this many times the median. */
export const FLAG_MULTIPLE = 10;
/** …and at least this big, so a quiet site doesn't flag a person with 3 layouts. */
const FLAG_FLOORS: Record<string, number> = {
  storageBytes: 50 * 1024 * 1024,
  layouts: 25,
  customParts: 50,
  uploads7d: 25,
  requests1d: 2000,
  refused7d: 50,
  shareViews7d: 500,
};
/** Flag when usage reaches this share of a limit. */
export const FLAG_NEAR_LIMIT = 0.8;

export function median(values: readonly number[]): number {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (v.length === 0) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

export interface AbuseRow {
  id: string;
  name: string;
  email?: string;
  createdAt: number;
  suspended: boolean;
  storageBytes: number;
  layouts: number;
  customParts: number;
  modules: number;
  rooms: number;
  /** Catalog submissions (each shared version), and they count in space used. */
  submissions: number;
  shareLinks: number;
  members?: number;
  uploads1d: number;
  uploads7d: number;
  uploadsPrev7d: number;
  requests1d: number;
  requestsPrev1d: number;
  refused7d: number;
  shareViews7d: number;
  live: number;
  flags: string[];
}

type Bucket = Omit<AbuseRow, 'id' | 'name' | 'email' | 'createdAt' | 'suspended' | 'flags' | 'members'>;

function emptyBucket(): Bucket {
  return {
    storageBytes: 0, layouts: 0, customParts: 0, modules: 0, rooms: 0, submissions: 0, shareLinks: 0,
    uploads1d: 0, uploads7d: 0, uploadsPrev7d: 0, requests1d: 0, requestsPrev1d: 0, refused7d: 0, shareViews7d: 0, live: 0,
  };
}

/** Gather per-owner numbers for every person or every club in a handful of GROUP BY queries. */
function collect(kind: 'user' | 'org', now: number): Map<string, Bucket> {
  const isUser = kind === 'user';
  const out = new Map<string, Bucket>();
  const get = (id: string | null) => {
    if (!id) return null;
    let b = out.get(id);
    if (!b) {
      b = emptyBucket();
      out.set(id, b);
    }
    return b;
  };
  const lCol = isUser ? schema.layouts.ownerUserId : schema.layouts.ownerOrgId;
  for (const r of db
    .select({
      id: lCol,
      n: sql<number>`count(*)`.mapWith(Number),
      bytes: sql<number>`coalesce(sum(length(${schema.layouts.docSnapshot}) + coalesce(length(${schema.layouts.sidecarSnapshot}), 0)), 0)`.mapWith(Number),
      shared: sql<number>`sum(${schema.layouts.publicShareToken} is not null)`.mapWith(Number),
    })
    .from(schema.layouts)
    .where(isNotNull(lCol))
    .groupBy(lCol)
    .all()) {
    const b = get(r.id);
    if (!b) continue;
    b.layouts = r.n;
    b.storageBytes += r.bytes;
    b.shareLinks = r.shared;
  }
  const pCol = isUser ? schema.customParts.ownerUserId : schema.customParts.ownerOrgId;
  for (const r of db
    .select({ id: pCol, n: sql<number>`count(*)`.mapWith(Number), bytes: sql<number>`coalesce(sum(length(${schema.customParts.xmlBlob}) + length(${schema.customParts.spriteBlob})), 0)`.mapWith(Number) })
    .from(schema.customParts)
    .where(isNotNull(pCol))
    .groupBy(pCol)
    .all()) {
    const b = get(r.id);
    if (!b) continue;
    b.customParts = r.n;
    b.storageBytes += r.bytes;
  }
  const mCol = isUser ? schema.modules.ownerUserId : schema.modules.ownerOrgId;
  for (const r of db
    .select({ id: mCol, n: sql<number>`count(*)`.mapWith(Number), bytes: sql<number>`coalesce(sum(length(${schema.modules.docSnapshot}) + coalesce(length(${schema.modules.sidecarSnapshot}), 0) + coalesce(length(${schema.modules.thumbnail}), 0) + coalesce((SELECT sum(length(v.doc_snapshot) + coalesce(length(v.thumbnail), 0)) FROM module_versions v WHERE v.module_id = "modules"."id"), 0)), 0)`.mapWith(Number) })
    .from(schema.modules)
    .where(isNotNull(mCol))
    .groupBy(mCol)
    .all()) {
    const b = get(r.id);
    if (!b) continue;
    b.modules = r.n;
    b.storageBytes += r.bytes;
  }
  const vCol = isUser ? schema.venueLibrary.ownerUserId : schema.venueLibrary.ownerOrgId;
  for (const r of db
    .select({ id: vCol, n: sql<number>`count(*)`.mapWith(Number), bytes: sql<number>`coalesce(sum(length(${schema.venueLibrary.data})), 0)`.mapWith(Number) })
    .from(schema.venueLibrary)
    .where(isNotNull(vCol))
    .groupBy(vCol)
    .all()) {
    const b = get(r.id);
    if (!b) continue;
    b.rooms = r.n;
    b.storageBytes += r.bytes;
  }
  // What they've shared to the public catalogs.
  const cCol = isUser ? schema.catalogItems.ownerUserId : schema.catalogItems.ownerOrgId;
  for (const r of db
    .select({
      id: cCol,
      n: sql<number>`count(*)`.mapWith(Number),
      bytes: sql<number>`coalesce(sum(coalesce(length(${schema.catalogItemVersions.docSnapshot}), 0) + coalesce(length(${schema.catalogItemVersions.xmlBlob}), 0) + coalesce(length(${schema.catalogItemVersions.spriteBlob}), 0) + coalesce(length(${schema.catalogItemVersions.thumbnail}), 0)), 0)`.mapWith(Number),
    })
    .from(schema.catalogItemVersions)
    .innerJoin(schema.catalogItems, eq(schema.catalogItems.id, schema.catalogItemVersions.itemId))
    .where(isNotNull(cCol))
    .groupBy(cCol)
    .all()) {
    const b = get(r.id);
    if (!b) continue;
    b.submissions = r.n;
    b.storageBytes += r.bytes;
  }
  // Background pictures, by their layout's owner.
  try {
    const dir = join(dirname(env.dbPath), 'bgimages');
    const sizes = new Map<string, number>();
    for (const n of readdirSync(dir)) {
      try {
        sizes.set(n.replace(/\.[a-z0-9]+$/i, ''), statSync(join(dir, n)).size);
      } catch {
        /* gone */
      }
    }
    if (sizes.size > 0) {
      for (const l of db.select({ id: schema.layouts.id, owner: lCol }).from(schema.layouts).where(isNotNull(lCol)).all()) {
        const s = sizes.get(l.id);
        if (s) {
          const b = get(l.owner);
          if (b) b.storageBytes += s;
        }
      }
    }
  } catch {
    /* no pictures yet */
  }
  // Daily counters.
  const today = dayKey(now);
  const yesterday = dayKey(now - DAY_MS);
  const weekStart = dayKey(now - 6 * DAY_MS);
  const prevStart = dayKey(now - 13 * DAY_MS);
  for (const r of db
    .select({ id: schema.usageDaily.subjectId, day: schema.usageDaily.day, metric: schema.usageDaily.metric, value: schema.usageDaily.value })
    .from(schema.usageDaily)
    .where(and(eq(schema.usageDaily.subjectKind, kind), gte(schema.usageDaily.day, prevStart)))
    .all()) {
    const b = get(r.id);
    if (!b) continue;
    const inWeek = r.day >= weekStart;
    if (r.metric === 'uploads') {
      if (inWeek) b.uploads7d += r.value;
      else b.uploadsPrev7d += r.value;
      if (r.day === today) b.uploads1d += r.value;
    } else if (r.metric === 'requests') {
      if (r.day === today) b.requests1d += r.value;
      if (r.day === yesterday) b.requestsPrev1d += r.value;
    } else if (r.metric === 'refused' && inWeek) b.refused7d += r.value;
    else if (r.metric === 'share_views' && inWeek) b.shareViews7d += r.value;
  }
  if (isUser) {
    for (const [id, n] of liveConnectionsByUser()) {
      const b = get(id);
      if (b) b.live = n;
    }
  } else {
    const byLayout = liveConnectionsByLayout();
    if (byLayout.size > 0) {
      for (const l of db
        .select({ id: schema.layouts.id, org: schema.layouts.ownerOrgId })
        .from(schema.layouts)
        .where(inArray(schema.layouts.id, [...byLayout.keys()]))
        .all()) {
        const b = get(l.org);
        if (b) b.live += byLayout.get(l.id) ?? 0;
      }
    }
  }
  return out;
}

const LIMITED: { field: keyof Bucket; user: LimitKey; org: LimitKey }[] = [
  { field: 'storageBytes', user: 'storagePerUser', org: 'storagePerClub' },
  { field: 'layouts', user: 'layoutsPerUser', org: 'layoutsPerClub' },
  { field: 'customParts', user: 'customPartsPerUser', org: 'customPartsPerClub' },
  { field: 'shareLinks', user: 'shareLinksPerUser', org: 'shareLinksPerClub' },
];

const FLAG_LABELS: Record<string, string> = {
  storageBytes: 'space',
  layouts: 'layouts',
  customParts: 'custom parts',
  uploads7d: 'uploads',
  requests1d: 'requests',
  refused7d: 'refused requests',
  shareViews7d: 'share views',
};

/** Flags: far above the median of others, or near a limit. */
export function flagRows(
  rows: (Bucket & { limits: Partial<Record<keyof Bucket, number>> })[],
): string[][] {
  const medians: Record<string, number> = {};
  for (const f of Object.keys(FLAG_FLOORS)) medians[f] = median(rows.map((r) => r[f as keyof Bucket] as number));
  return rows.map((r) => {
    const flags: string[] = [];
    for (const [f, floor] of Object.entries(FLAG_FLOORS)) {
      const v = r[f as keyof Bucket] as number;
      const m = medians[f]!;
      if (v >= floor && m > 0 && v > FLAG_MULTIPLE * m) flags.push(`${FLAG_LABELS[f]} ${Math.round(v / m)}× usual`);
    }
    for (const [f, max] of Object.entries(r.limits)) {
      const v = r[f as keyof Bucket] as number;
      if (max !== undefined && max > 0 && v >= FLAG_NEAR_LIMIT * max) flags.push(`${FLAG_LABELS[f]} at ${Math.round((v / max) * 100)}% of limit`);
    }
    return flags;
  });
}

const SORTS = new Set([
  'storageBytes', 'layouts', 'customParts', 'modules', 'rooms', 'shareLinks', 'uploads1d', 'uploads7d',
  'requests1d', 'refused7d', 'shareViews7d', 'live', 'members',
]);

function limitRows(limits: Record<LimitKey, EffectiveLimit>, kind: 'user' | 'org', used: Usage, inviteEmailsToday = 0) {
  const usedFor: Partial<Record<LimitKey, number>> =
    kind === 'user'
      ? { clubsPerUser: used.clubsCreated, layoutsPerUser: used.layouts, storagePerUser: used.storageBytes, customPartsPerUser: used.customParts, shareLinksPerUser: used.shareLinks, inviteEmailsPerDay: inviteEmailsToday }
      : { layoutsPerClub: used.layouts, storagePerClub: used.storageBytes, customPartsPerClub: used.customParts, membersPerClub: used.members, shareLinksPerClub: used.shareLinks };
  return LIMITS.filter((l) => l.applies === kind || l.applies === 'both').map((l) => ({
    key: l.key,
    label: l.label,
    help: l.help,
    unit: l.unit,
    value: limits[l.key].value,
    source: limits[l.key].source,
    reason: limits[l.key].reason ?? null,
    used: usedFor[l.key] ?? null,
  }));
}

function series(kind: 'user' | 'org', id: string, now: number) {
  const days = Array.from({ length: 30 }, (_, i) => dayKey(now - (29 - i) * DAY_MS));
  const idx = new Map(days.map((d, i) => [d, i]));
  const metrics = ['requests', 'refused', 'uploads', 'upload_bytes', 'share_views'] as const;
  const out = Object.fromEntries(metrics.map((m) => [m, new Array<number>(30).fill(0)])) as Record<(typeof metrics)[number], number[]>;
  for (const r of db
    .select()
    .from(schema.usageDaily)
    .where(and(eq(schema.usageDaily.subjectKind, kind), eq(schema.usageDaily.subjectId, id), gte(schema.usageDaily.day, days[0]!)))
    .all()) {
    const i = idx.get(r.day);
    if (i !== undefined && r.metric in out) out[r.metric as (typeof metrics)[number]][i] = r.value;
  }
  return { days: days.map((d) => Date.parse(`${d}T00:00:00Z`)), ...out };
}

function overrideRow(kind: 'user' | 'org', id: string) {
  const row = db
    .select()
    .from(schema.limitOverrides)
    .where(and(eq(schema.limitOverrides.subjectKind, kind), eq(schema.limitOverrides.subjectId, id)))
    .get();
  return {
    limits: row ? cleanLimits(JSON.parse(row.limits)) : {},
    suspended: row?.suspended ?? false,
    reason: row?.suspendedReason ?? null,
    updatedAt: row ? row.updatedAt.getTime() : null,
  };
}

function activityFor(where: ReturnType<typeof or>) {
  return db
    .select({
      id: schema.auditEvents.id,
      at: schema.auditEvents.createdAt,
      eventType: schema.auditEvents.eventType,
      resourceKind: schema.auditEvents.resourceKind,
      layoutId: schema.auditEvents.layoutId,
      payload: schema.auditEvents.payload,
      actor: schema.users.displayName,
    })
    .from(schema.auditEvents)
    .leftJoin(schema.users, eq(schema.users.id, schema.auditEvents.userId))
    .where(where)
    .orderBy(desc(schema.auditEvents.createdAt))
    .limit(40)
    .all()
    .map((e) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(e.payload) as Record<string, unknown>;
      } catch {
        /* keep empty */
      }
      const name = (payload.title ?? payload.name ?? payload.partNumber ?? payload.targetEmail ?? null) as string | null;
      return { id: e.id, at: e.at.getTime(), eventType: e.eventType, kind: e.resourceKind ?? (e.layoutId ? 'layout' : null), actor: e.actor, name };
    });
}

interface LimitsBody {
  limits?: Record<string, number | null>;
  suspended?: boolean;
  reason?: string | null;
}

/** Validate a { key: number | null } patch. Returns the error code, or null. */
function badPatch(patch: unknown): string | null {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'invalid_limits';
  for (const [k, v] of Object.entries(patch)) {
    if (!isLimitKey(k)) return 'unknown_limit';
    if (v !== null && !(typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER)) return 'invalid_limit_value';
  }
  return null;
}

export async function adminLimitsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/limits', async (req) => {
    requireGlobalAdmin(req);
    invalidateLimitCaches();
    const { stored, values } = await globalLimits();
    const defaults = envDefaults();
    return {
      // Whether limits refuse anything now, the admin's switch, and whether
      // the server's LIMITS_ENFORCE overrides that switch.
      enforced: await limitsEnforced(),
      enforcedSetting: (await getPlatformSettings()).limitsEnforced,
      enforcementSource: enforcementSource(),
      limits: LIMITS.map((l) => ({
        key: l.key,
        label: l.label,
        help: l.help,
        unit: l.unit,
        applies: l.applies,
        value: values[l.key],
        default: defaults[l.key],
        builtIn: l.builtIn,
        envVar: l.envVar,
        fromEnv: process.env[l.envVar] !== undefined && defaults[l.key] !== l.builtIn,
        changedHere: stored[l.key] !== undefined,
      })),
    };
  });

  app.patch<{ Body: Record<string, number | null> }>('/api/admin/limits', async (req, reply) => {
    const me = requireGlobalAdmin(req);
    const err = badPatch(req.body);
    if (err) return reply.code(400).send({ error: err });
    const settings = await getPlatformSettings();
    const before = cleanLimits(settings.limits ? JSON.parse(settings.limits) : null);
    const after: Record<string, number> = { ...before };
    for (const [k, v] of Object.entries(req.body)) {
      if (v === null) delete after[k];
      else after[k] = v;
    }
    await db
      .update(schema.platformSettings)
      .set({ limits: JSON.stringify(after), updatedAt: new Date(), updatedBy: me.id })
      .where(eq(schema.platformSettings.id, PLATFORM_SETTINGS_ID));
    invalidateLimitCaches();
    await writeAuditEvent({
      resourceKind: 'platform_settings',
      resourceId: PLATFORM_SETTINGS_ID,
      userId: me.id,
      eventType: 'admin_limits_patch',
      payload: { before, after },
    });
    return { ok: true };
  });

  async function abuseList(kind: 'user' | 'org', sortRaw: string | undefined, limitRaw: string | undefined) {
    const now = Date.now();
    const sort = sortRaw && SORTS.has(sortRaw) ? sortRaw : 'storageBytes';
    const limit = Math.min(200, Math.max(1, parseInt(limitRaw ?? '50', 10) || 50));
    const buckets = collect(kind, now);
    const people =
      kind === 'user'
        ? db.select({ id: schema.users.id, name: schema.users.displayName, email: schema.users.email, createdAt: schema.users.createdAt, emailVerified: schema.users.emailVerified }).from(schema.users).all()
        : [];
    const clubs =
      kind === 'org'
        ? db
            .select({
              id: schema.orgs.id,
              name: schema.orgs.name,
              createdAt: schema.orgs.createdAt,
              members: sql<number>`(select count(*) from org_members m where m.org_id = "orgs"."id")`.mapWith(Number),
            })
            .from(schema.orgs)
            .all()
        : [];
    const { values } = await globalLimits(now);
    const subjects = kind === 'user' ? people : clubs;
    const rows = subjects.map((s) => {
      const b = buckets.get(s.id) ?? emptyBucket();
      const ov = overrideFor(kind, s.id, now);
      const limits: Partial<Record<keyof Bucket, number>> = {};
      for (const l of LIMITED) {
        const key = kind === 'user' ? l.user : l.org;
        let max = ov.limits[key] ?? values[key];
        if (kind === 'org' && l.field === 'storageBytes' && ov.limits.storagePerClub === undefined) {
          max += values.storagePerClubMember * ((s as { members: number }).members ?? 0);
        }
        limits[l.field] = max;
      }
      return { s, b, ov, limits };
    });
    const flags = flagRows(rows.map((r) => ({ ...r.b, limits: r.limits })));
    const out: AbuseRow[] = rows.map((r, i) => ({
      id: r.s.id,
      name: r.s.name,
      ...('email' in r.s ? { email: r.s.email } : {}),
      ...('members' in r.s ? { members: r.s.members } : {}),
      createdAt: r.s.createdAt.getTime(),
      suspended: r.ov.suspended,
      ...r.b,
      flags: flags[i]!,
    }));
    out.sort(
      (a, z) =>
        ((z[sort as keyof AbuseRow] as number) ?? 0) - ((a[sort as keyof AbuseRow] as number) ?? 0) ||
        z.flags.length - a.flags.length ||
        a.name.localeCompare(z.name),
    );
    return {
      sort,
      total: out.length,
      flagged: out.filter((r) => r.flags.length > 0).length,
      medians: Object.fromEntries(Object.keys(FLAG_FLOORS).map((f) => [f, median(out.map((r) => r[f as keyof AbuseRow] as number))])),
      rows: out.slice(0, limit),
    };
  }

  app.get<{ Querystring: { sort?: string; limit?: string } }>('/api/admin/abuse/users', async (req) => {
    requireGlobalAdmin(req);
    usageCounter.flush();
    return abuseList('user', req.query.sort, req.query.limit);
  });

  app.get<{ Querystring: { sort?: string; limit?: string } }>('/api/admin/abuse/clubs', async (req) => {
    requireGlobalAdmin(req);
    usageCounter.flush();
    return abuseList('org', req.query.sort, req.query.limit);
  });

  app.get<{ Params: { id: string } }>('/api/admin/users/:id/usage', async (req, reply) => {
    requireGlobalAdmin(req);
    usageCounter.flush();
    const user = db.select().from(schema.users).where(eq(schema.users.id, req.params.id)).get();
    if (!user) return reply.code(404).send({ error: 'not_found' });
    const now = Date.now();
    invalidateLimitCaches();
    const used = usageOf({ kind: 'user', id: user.id });
    return {
      subject: { kind: 'user', id: user.id, name: user.displayName, email: user.email, createdAt: user.createdAt.getTime(), emailVerified: user.emailVerified },
      usage: used,
      limits: limitRows(await userLimits(user, now), 'user', used, usageCounter.today('user', user.id, 'invite_emails', now)),
      override: overrideRow('user', user.id),
      series: series('user', user.id, now),
      activity: activityFor(or(eq(schema.auditEvents.userId, user.id), and(eq(schema.auditEvents.resourceKind, 'user'), eq(schema.auditEvents.resourceId, user.id)))),
    };
  });

  app.get<{ Params: { id: string } }>('/api/admin/orgs/:id/usage', async (req, reply) => {
    requireGlobalAdmin(req);
    usageCounter.flush();
    const org = db.select().from(schema.orgs).where(eq(schema.orgs.id, req.params.id)).get();
    if (!org) return reply.code(404).send({ error: 'not_found' });
    const now = Date.now();
    invalidateLimitCaches();
    const used = usageOf({ kind: 'org', id: org.id });
    const layoutIds = db.select({ id: schema.layouts.id }).from(schema.layouts).where(eq(schema.layouts.ownerOrgId, org.id)).limit(500).all().map((l) => l.id);
    const where = layoutIds.length
      ? or(and(eq(schema.auditEvents.resourceKind, 'org'), eq(schema.auditEvents.resourceId, org.id)), inArray(schema.auditEvents.layoutId, layoutIds))
      : or(and(eq(schema.auditEvents.resourceKind, 'org'), eq(schema.auditEvents.resourceId, org.id)));
    return {
      subject: { kind: 'org', id: org.id, name: org.name, slug: org.slug, createdAt: org.createdAt.getTime() },
      usage: used,
      limits: limitRows(await orgLimits(org.id, used.members, now), 'org', used),
      override: overrideRow('org', org.id),
      series: series('org', org.id, now),
      activity: activityFor(where),
    };
  });

  async function putLimits(kind: 'user' | 'org', id: string, body: LimitsBody, adminId: string) {
    const current = overrideRow(kind, id);
    const next: Record<string, number> = { ...current.limits };
    if (body.limits !== undefined) {
      for (const [k, v] of Object.entries(body.limits)) {
        if (v === null) delete next[k];
        else next[k] = v;
      }
    }
    const suspended = typeof body.suspended === 'boolean' ? body.suspended : current.suspended;
    const reason = suspended ? (body.reason === undefined ? current.reason : trimmed(body.reason)?.slice(0, 500) || null) : null;
    const now = new Date();
    db.insert(schema.limitOverrides)
      .values({ subjectKind: kind, subjectId: id, limits: JSON.stringify(next), suspended, suspendedReason: reason, updatedAt: now, updatedBy: adminId })
      .onConflictDoUpdate({
        target: [schema.limitOverrides.subjectKind, schema.limitOverrides.subjectId],
        set: { limits: JSON.stringify(next), suspended, suspendedReason: reason, updatedAt: now, updatedBy: adminId },
      })
      .run();
    invalidateLimitCaches();
    // Open live connections see a suspension (or its end) at once.
    if (suspended !== current.suspended) notifyAccessChanged({ all: true });
    if (JSON.stringify(next) !== JSON.stringify(current.limits)) {
      await writeAuditEvent({ resourceKind: kind, resourceId: id, userId: adminId, eventType: 'admin_limits_override', payload: { before: current.limits, after: next } });
    }
    if (suspended !== current.suspended) {
      await writeAuditEvent({
        resourceKind: kind,
        resourceId: id,
        userId: adminId,
        eventType: suspended ? 'admin_suspend' : 'admin_unsuspend',
        payload: { reason },
      });
    }
    return { ok: true, limits: next, suspended, reason };
  }

  function checkBody(body: LimitsBody | undefined): string | null {
    if (!body || typeof body !== 'object') return 'invalid_input';
    if (body.limits !== undefined) {
      const e = badPatch(body.limits);
      if (e) return e;
    }
    if (body.suspended !== undefined && typeof body.suspended !== 'boolean') return 'invalid_input';
    if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') return 'invalid_input';
    return null;
  }

  app.put<{ Params: { id: string }; Body: LimitsBody }>('/api/admin/users/:id/limits', async (req, reply) => {
    const me = requireGlobalAdmin(req);
    const err = checkBody(req.body);
    if (err) return reply.code(400).send({ error: err });
    const user = db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, req.params.id)).get();
    if (!user) return reply.code(404).send({ error: 'not_found' });
    if (user.id === me.id && req.body.suspended === true) return reply.code(400).send({ error: 'cannot_suspend_self' });
    return putLimits('user', user.id, req.body, me.id);
  });

  app.put<{ Params: { id: string }; Body: LimitsBody }>('/api/admin/orgs/:id/limits', async (req, reply) => {
    const me = requireGlobalAdmin(req);
    const err = checkBody(req.body);
    if (err) return reply.code(400).send({ error: err });
    const org = db.select({ id: schema.orgs.id }).from(schema.orgs).where(eq(schema.orgs.id, req.params.id)).get();
    if (!org) return reply.code(404).send({ error: 'not_found' });
    return putLimits('org', org.id, req.body, me.id);
  });
}

