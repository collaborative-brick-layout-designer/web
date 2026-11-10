// Admin dashboard data: graphs over time, breakdowns, health and a short
// "needs attention" list. Everything is admin-only (requireGlobalAdmin)
// and read-only, and every query is bounded — by a date range on an
// indexed timestamp, by a LIMIT, or by the size of a small table.
//
//   GET /api/admin/stats/series?range=7d|30d|90d|12m   graphs
//   GET /api/admin/insights/usage?range=               people and clients
//   GET /api/admin/insights/content?range=             layouts and parts
//   GET /api/admin/insights/people?range=              accounts and clubs
//   GET /api/admin/insights/health?range=              errors, disk, backups
//   GET /api/admin/insights/alerts                     needs attention
//
// Where the database keeps no history (active people, requests, errors)
// the numbers come from the daily rollup (metrics/rollup.ts), and each
// response says since when it has been collecting.

import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { existsSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as Y from 'yjs';
import { db, schema } from '../db/index.js';
import { env } from '../env.js';
import { backgroundJobs } from '../workers/jobs.js';
import { compactionSkipped } from '../workers/compactionReport.js';
import { getPlatformSettings } from '../auth/platformSettings.js';
import { demoItemCount } from '../demo/reset.js';
import { requireGlobalAdmin } from '../auth/cookie.js';
import { dayKey, databaseBytes, flushRollup, rollup, startOfDay } from '../metrics/rollup.js';
import { liveStats } from './ws.js';
import { appVersion } from './version.js';
import { bundledPartKeys } from './parts.js';
import { currentDocBytes } from './layouts.js';
import { type DesktopPolicy, desktopPolicy, desktopStanding, resolvePolicy } from '../compat.js';
import { perPerson } from '../utils/rateLimits.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The outer row's club id inside a correlated subquery. Drizzle prints
 * `schema.orgs.id` unqualified (`"id"`), which inside `from layouts l`
 * silently means `l.id` — so spell the table out.
 */
const ORG_ID = sql.raw('"orgs"."id"');

export type RangeId = '7d' | '30d' | '90d' | '12m';

export interface RangeSpec {
  id: RangeId;
  /** Inclusive start, exclusive end (both UTC midnights). */
  start: number;
  end: number;
  bucket: 'day' | 'week';
  bucketMs: number;
  buckets: number;
}

/** The time window and bucket size for a range id. Unknown ids fall back to 30 days. */
export function rangeSpec(raw: string | undefined, now: number = Date.now()): RangeSpec {
  const id: RangeId = raw === '7d' || raw === '90d' || raw === '12m' ? raw : '30d';
  const end = startOfDay(now) + DAY_MS;
  if (id === '12m') {
    const buckets = 52;
    return { id, start: end - buckets * 7 * DAY_MS, end, bucket: 'week', bucketMs: 7 * DAY_MS, buckets };
  }
  const days = id === '7d' ? 7 : id === '90d' ? 90 : 30;
  return { id, start: end - days * DAY_MS, end, bucket: 'day', bucketMs: DAY_MS, buckets: days };
}

type Agg = 'sum' | 'avg' | 'last' | 'max';

/** Count rows of `table` per bucket by a timestamp column, inside the range. */
function bucketCreated(
  table: typeof schema.users | typeof schema.layouts | typeof schema.customParts | typeof schema.modules,
  r: RangeSpec,
): number[] {
  const col = table.createdAt;
  const rows = db
    .select({
      // Bound numbers arrive as REAL in better-sqlite3: cast so the
      // division buckets instead of returning a fraction.
      b: sql<number>`cast((${col} - ${r.start}) / ${r.bucketMs} as integer)`.mapWith(Number),
      n: count(),
    })
    .from(table)
    .where(and(gte(col, new Date(r.start)), lt(col, new Date(r.end))))
    .groupBy(sql`1`)
    .all();
  const out = new Array<number>(r.buckets).fill(0);
  for (const row of rows) if (row.b >= 0 && row.b < r.buckets) out[row.b] = row.n;
  return out;
}

/** Daily rollup values for a metric (summed over keys, or one key) bucketed into the range. */
export function bucketRollup(metric: string, r: RangeSpec, agg: Agg, key?: string): number[] {
  const where = [
    eq(schema.dailyStats.metric, metric),
    gte(schema.dailyStats.day, dayKey(r.start)),
    lt(schema.dailyStats.day, dayKey(r.end)),
  ];
  if (key !== undefined) where.push(eq(schema.dailyStats.key, key));
  const rows = db
    .select({ day: schema.dailyStats.day, value: sql<number>`sum(${schema.dailyStats.value})`.mapWith(Number) })
    .from(schema.dailyStats)
    .where(and(...where))
    .groupBy(schema.dailyStats.day)
    .orderBy(schema.dailyStats.day)
    .all();
  const sums = new Array<number>(r.buckets).fill(0);
  const seen = new Array<number>(r.buckets).fill(0);
  for (const row of rows) {
    const b = Math.floor((Date.parse(`${row.day}T00:00:00Z`) - r.start) / r.bucketMs);
    if (b < 0 || b >= r.buckets) continue;
    if (agg === 'max') sums[b] = Math.max(sums[b]!, row.value);
    else if (agg === 'last') sums[b] = row.value; // rows come in day order
    else sums[b] = sums[b]! + row.value; // sum, and avg's running total
    seen[b] = seen[b]! + 1;
  }
  if (agg === 'avg') return sums.map((v, i) => (seen[i]! > 0 ? Math.round(v / seen[i]!) : 0));
  return sums;
}

/** Sum of a rollup metric per key inside the range, biggest first. */
function rollupByKey(metric: string, r: RangeSpec, limit = 20): { key: string; value: number }[] {
  return db
    .select({ key: schema.dailyStats.key, value: sql<number>`sum(${schema.dailyStats.value})`.mapWith(Number) })
    .from(schema.dailyStats)
    .where(
      and(
        eq(schema.dailyStats.metric, metric),
        gte(schema.dailyStats.day, dayKey(r.start)),
        lt(schema.dailyStats.day, dayKey(r.end)),
      ),
    )
    .groupBy(schema.dailyStats.key)
    .orderBy(desc(sql`2`))
    .limit(limit)
    .all();
}

function rollupTotal(metric: string, r: RangeSpec): number {
  return bucketRollup(metric, r, 'sum').reduce((a, b) => a + b, 0);
}

/** The first day each rollup metric was recorded (null = not yet). */
export function collectingSince(): Record<string, string | null> {
  const rows = db
    .select({ metric: schema.dailyStats.metric, first: sql<string>`min(${schema.dailyStats.day})` })
    .from(schema.dailyStats)
    .groupBy(schema.dailyStats.metric)
    .all();
  return Object.fromEntries(rows.map((r) => [r.metric, r.first]));
}

function bucketLabels(r: RangeSpec): number[] {
  return Array.from({ length: r.buckets }, (_, i) => r.start + i * r.bucketMs);
}

function countWhere(table: SQLiteTable, where?: SQL): number {
  return db.select({ n: count() }).from(table).where(where).get()?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Disk helpers — cached, since walking the parts tree is not free.
// ---------------------------------------------------------------------------

function dirBytes(dir: string, budget = { files: 200_000 }): number {
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (budget.files-- <= 0) break;
    const p = join(dir, e.name);
    if (e.isDirectory()) total += dirBytes(p, budget);
    else if (e.isFile()) {
      try {
        total += statSync(p).size;
      } catch {
        /* gone */
      }
    }
  }
  return total;
}

let partsBytesCache: { at: number; bytes: number } | null = null;
function partsBytes(now: number): number {
  if (partsBytesCache && now - partsBytesCache.at < 60 * 60 * 1000) return partsBytesCache.bytes;
  const bytes = existsSync(env.partsDir) ? dirBytes(env.partsDir) : 0;
  partsBytesCache = { at: now, bytes };
  return bytes;
}

export interface BackupFile {
  name: string;
  bytes: number;
  at: number;
}

/** The backup worker's snapshots, newest first. */
export function listBackups(dir: string = env.backupsDir): BackupFile[] {
  if (!existsSync(dir)) return [];
  const out: BackupFile[] = [];
  for (const name of readdirSync(dir)) {
    if (!/^cbld-\d{4}-\d{2}-\d{2}\.sqlite\.gz$/.test(name)) continue;
    try {
      const st = statSync(join(dir, name));
      out.push({ name, bytes: st.size, at: st.mtimeMs });
    } catch {
      /* gone */
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

function diskUse(path: string): { totalBytes: number; freeBytes: number; usedPct: number } | null {
  try {
    const s = statfsSync(path);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    if (total <= 0) return null;
    return { totalBytes: total, freeBytes: free, usedPct: Math.round(((total - free) / total) * 1000) / 10 };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Content scan — which parts are placed, and which no library knows.
// Decodes layouts one at a time, capped, and cached for an hour.
// ---------------------------------------------------------------------------

const SCAN_MAX_LAYOUTS = 2000;
const SCAN_TTL_MS = 60 * 60 * 1000;

export interface PartUse {
  partNumber: string;
  placements: number;
  layouts: number;
}

export interface ContentScan {
  at: number;
  scanned: number;
  total: number;
  partCountByLayout: Map<string, number>;
  topParts: PartUse[];
  missingParts: PartUse[];
}

let scanCache: ContentScan | null = null;

/** Count bricks per part number in one layout doc. */
export function partsInDoc(bytes: Uint8Array): Map<string, number> {
  const doc = new Y.Doc();
  const out = new Map<string, number>();
  try {
    if (bytes.length > 0) Y.applyUpdate(doc, bytes);
    const layerData = doc.getMap<Y.Map<unknown>>('layerData');
    for (const layer of layerData.values()) {
      if (!(layer instanceof Y.Map)) continue;
      const bricks = layer.get('bricks');
      if (!(bricks instanceof Y.Array)) continue;
      for (const b of bricks.toArray()) {
        if (!(b instanceof Y.Map)) continue;
        const pn = b.get('partNumber');
        if (typeof pn === 'string' && pn) out.set(pn, (out.get(pn) ?? 0) + 1);
      }
    }
  } catch {
    /* unreadable doc — counts what it got */
  } finally {
    doc.destroy();
  }
  return out;
}

export async function scanContent(
  logger: Parameters<typeof bundledPartKeys>[0],
  now: number = Date.now(),
  force = false,
): Promise<ContentScan> {
  if (!force && scanCache && now - scanCache.at < SCAN_TTL_MS) return scanCache;
  const known = await bundledPartKeys(logger);
  for (const p of db.select({ pn: schema.customParts.partNumber }).from(schema.customParts).all()) {
    known.add(p.pn.toLowerCase());
  }
  const total = countWhere(schema.layouts);
  const ids = db
    .select({ id: schema.layouts.id })
    .from(schema.layouts)
    .orderBy(desc(schema.layouts.updatedAt))
    .limit(SCAN_MAX_LAYOUTS)
    .all();
  const placements = new Map<string, PartUse>();
  const partCountByLayout = new Map<string, number>();
  for (const { id } of ids) {
    const row = db
      .select({ snapshot: schema.layouts.docSnapshot })
      .from(schema.layouts)
      .where(eq(schema.layouts.id, id))
      .get();
    if (!row) continue;
    const parts = partsInDoc(await currentDocBytes(id, row.snapshot as Uint8Array));
    let n = 0;
    for (const [pn, c] of parts) {
      n += c;
      const use = placements.get(pn) ?? { partNumber: pn, placements: 0, layouts: 0 };
      use.placements += c;
      use.layouts += 1;
      placements.set(pn, use);
    }
    partCountByLayout.set(id, n);
  }
  const all = [...placements.values()].sort((a, b) => b.placements - a.placements || a.partNumber.localeCompare(b.partNumber));
  scanCache = {
    at: now,
    scanned: ids.length,
    total,
    partCountByLayout,
    topParts: all.slice(0, 25),
    missingParts: all.filter((p) => !known.has(p.partNumber.toLowerCase())).slice(0, 50),
  };
  return scanCache;
}

/** Drop the cached content scan (tests). */
export function resetContentScan(): void {
  scanCache = null;
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export interface Alert {
  level: 'warn' | 'info';
  id: string;
  text: string;
}

/** Compare dotted versions numerically ("1.10.0" > "1.9.2"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function computeAlerts(now: number = Date.now(), policy: DesktopPolicy = resolvePolicy(null), backupsOn = true): Alert[] {
  const alerts: Alert[] = [];
  if (backupsOn) {
    const last = listBackups()[0];
    if (!last) alerts.push({ level: 'warn', id: 'backup-none', text: 'No backups found in the backups folder.' });
    else if (now - last.at > 2 * DAY_MS) {
      const days = Math.floor((now - last.at) / DAY_MS);
      alerts.push({ level: 'warn', id: 'backup-old', text: `The newest backup is ${days} days old.` });
    }
  }
  const skipped = compactionSkipped();
  if (skipped.length > 0) {
    alerts.push({
      level: 'warn',
      id: 'compaction-skipped',
      text: `The nightly clean-up skipped ${skipped.length === 1 ? '1 layout' : `${skipped.length} layouts`} whose saved copy can't be read (${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? ', …' : ''}). The server log has the details.`,
    });
  }
  const disk = diskUse(dirname(resolve(env.dbPath)));
  if (disk && disk.usedPct > 80) {
    alerts.push({ level: 'warn', id: 'disk-full', text: `The data disk is ${disk.usedPct}% full.` });
  }
  const week = rangeSpec('7d', now);
  const errors = bucketRollup('errors_5xx', week, 'sum');
  const today = errors[errors.length - 1] ?? 0;
  const prior = errors.slice(0, -1);
  const avg = prior.reduce((a, b) => a + b, 0) / Math.max(1, prior.length);
  if (today >= 10 && today > 3 * avg) {
    alerts.push({ level: 'warn', id: 'error-spike', text: `${today} server errors today, against about ${Math.round(avg)} a day before.` });
  }
  const todayOnly: RangeSpec = { ...week, start: week.end - DAY_MS, buckets: 1 };
  for (const r of rollupByKey('refused', todayOnly, 3)) {
    if (r.value >= 50) {
      alerts.push({ level: 'warn', id: `refused:${r.key}`, text: `${r.value} refused requests today on ${r.key}.` });
    }
  }
  // People seen today on a desktop app this server turns away, or asks
  // to update (compat.ts).
  const required: string[] = [];
  const suggested: string[] = [];
  let mustUpdate = 0;
  let shouldUpdate = 0;
  for (const v of rollupByKey('desktop_version', todayOnly, 50)) {
    if (v.value <= 0) continue;
    const standing = desktopStanding(v.key, policy.minimum, policy.recommended);
    if (standing === 'updateRequired') {
      required.push(v.key);
      mustUpdate += v.value;
    } else if (standing === 'updateSuggested') {
      suggested.push(v.key);
      shouldUpdate += v.value;
    }
  }
  const people = (n: number) => (n === 1 ? '1 person' : `${n} people`);
  if (mustUpdate > 0) {
    alerts.push({
      level: 'warn',
      id: 'desktop-update-required',
      text: `${people(mustUpdate)} tried a desktop app too old for this server today (${required.join(', ')}). They need version ${policy.minimum} or newer.`,
    });
  }
  if (shouldUpdate > 0) {
    alerts.push({
      level: 'info',
      id: 'desktop-update-suggested',
      text: `${people(shouldUpdate)} used an older desktop app today (${suggested.join(', ')}). Version ${policy.recommended} is recommended.`,
    });
  }
  return alerts;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

interface RangeQuery {
  range?: string;
  refresh?: string;
}

async function demoInsight(): Promise<{ enabled: boolean; lastResetAt: number | null; items: number }> {
  const s = await getPlatformSettings();
  return { enabled: s.demoEnabled, lastResetAt: s.demoLastResetAt?.getTime() ?? null, items: await demoItemCount() };
}

export async function adminInsightsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: RangeQuery }>('/api/admin/stats/series', async (req) => {
    requireGlobalAdmin(req);
    // Make "today" current before reading it back.
    flushRollup();
    const r = rangeSpec(req.query.range);
    return {
      range: r.id,
      bucket: r.bucket,
      buckets: bucketLabels(r),
      series: {
        newUsers: bucketCreated(schema.users, r),
        activeUsers: bucketRollup('dau', r, 'avg'),
        wau: bucketRollup('wau', r, 'last'),
        mau: bucketRollup('mau', r, 'last'),
        layoutsCreated: bucketCreated(schema.layouts, r),
        layoutsEdited: bucketRollup('layouts_edited', r, 'sum'),
        liveSessions: bucketRollup('live_sessions', r, 'sum'),
        livePeak: bucketRollup('live_peak', r, 'max'),
        customParts: bucketCreated(schema.customParts, r),
        modules: bucketCreated(schema.modules, r),
        requests: bucketRollup('requests', r, 'sum'),
        errors5xx: bucketRollup('errors_5xx', r, 'sum'),
        slow: bucketRollup('slow', r, 'sum'),
        refused: bucketRollup('refused', r, 'sum'),
        shareViews: bucketRollup('share_views', r, 'sum'),
        dbBytes: bucketRollup('db_bytes', r, 'last'),
      },
      collectingSince: collectingSince(),
    };
  });

  app.get<{ Querystring: RangeQuery }>('/api/admin/insights/usage', async (req) => {
    requireGlobalAdmin(req);
    flushRollup();
    const now = Date.now();
    const r = rangeSpec(req.query.range, now);
    const seenSince = (ms: number) => countWhere(schema.users, gte(schema.users.lastSeenAt, new Date(ms)));
    const dayStart = startOfDay(now);
    const weekAgo = rangeSpec('7d', now - 7 * DAY_MS);
    const lastOf = (metric: string) => bucketRollup(metric, { ...weekAgo, start: weekAgo.end - DAY_MS, buckets: 1 }, 'last')[0] ?? 0;
    const active = rollupTotal('dau', r);
    const fresh = rollupTotal('dau_new', r);
    const sessionMs = rollupTotal('live_session_ms', r);
    const sessionsEnded = rollupTotal('live_sessions_ended', r);
    return {
      range: r.id,
      now: {
        dau: seenSince(dayStart),
        wau: seenSince(now - 7 * DAY_MS),
        mau: seenSince(now - 30 * DAY_MS),
      },
      weekAgo: { dau: lastOf('dau'), wau: lastOf('wau'), mau: lastOf('mau') },
      newVsReturning: { newPersonDays: fresh, returningPersonDays: Math.max(0, active - fresh) },
      avgLiveSessionMinutes: sessionsEnded > 0 ? Math.round(sessionMs / sessionsEnded / 6000) / 10 : null,
      liveSessions: rollupTotal('live_sessions', r),
      clients: rollupByKey('client', r),
      desktopVersions: rollupByKey('desktop_version', r),
      // So the chart can mark versions that must or should update.
      desktopPolicy: await desktopPolicy(),
      devices: rollupByKey('device', r),
      display: rollupByKey('display', r),
      shareViews: rollupTotal('share_views', r),
      exports: rollupByKey('exports', r),
      collectingSince: collectingSince(),
    };
  });

  app.get<{ Querystring: RangeQuery }>('/api/admin/insights/content', async (req) => {
    requireGlobalAdmin(req);
    const now = Date.now();
    const r = rangeSpec(req.query.range, now);
    const scan = await scanContent(app, now, req.query.refresh === '1');
    const sizeExpr = sql<number>`length(${schema.layouts.docSnapshot}) + coalesce(length(${schema.layouts.sidecarSnapshot}), 0)`.mapWith(Number);
    const totals = db
      .select({ n: count(), bytes: sql<number>`coalesce(sum(length(${schema.layouts.docSnapshot}) + coalesce(length(${schema.layouts.sidecarSnapshot}), 0)), 0)`.mapWith(Number) })
      .from(schema.layouts)
      .get();
    const partTotals = db
      .select({ n: count(), bytes: sql<number>`coalesce(sum(length(${schema.customParts.xmlBlob}) + length(${schema.customParts.spriteBlob})), 0)`.mapWith(Number) })
      .from(schema.customParts)
      .get();
    const largest = db
      .select({
        id: schema.layouts.id,
        title: schema.layouts.title,
        ownerOrgName: schema.orgs.name,
        bytes: sizeExpr,
        updatedAt: schema.layouts.updatedAt,
      })
      .from(schema.layouts)
      .leftJoin(schema.orgs, eq(schema.orgs.id, schema.layouts.ownerOrgId))
      .orderBy(desc(sizeExpr))
      .limit(10)
      .all();
    const staleCutoff = new Date(now - 90 * DAY_MS);
    const lastTouched = sql`coalesce(${schema.layouts.lastOpenedAt}, ${schema.layouts.updatedAt})`;
    const staleWhere = lt(lastTouched, staleCutoff.getTime());
    const stale = db
      .select({
        id: schema.layouts.id,
        title: schema.layouts.title,
        ownerOrgName: schema.orgs.name,
        lastTouched: sql<number>`${lastTouched}`.mapWith(Number),
        bytes: sizeExpr,
      })
      .from(schema.layouts)
      .leftJoin(schema.orgs, eq(schema.orgs.id, schema.layouts.ownerOrgId))
      .where(staleWhere)
      .orderBy(lastTouched)
      .limit(20)
      .all();
    const byOrg = db
      .select({
        orgId: schema.orgs.id,
        name: schema.orgs.name,
        slug: schema.orgs.slug,
        layouts: sql<number>`(select count(*) from layouts l where l.owner_org_id = ${ORG_ID})`.mapWith(Number),
        bytes: sql<number>`(select coalesce(sum(length(l.doc_snapshot) + coalesce(length(l.sidecar_snapshot), 0)), 0) from layouts l where l.owner_org_id = ${ORG_ID})`.mapWith(Number),
        rooms: sql<number>`(select count(*) from venue_library v where v.owner_org_id = ${ORG_ID})`.mapWith(Number),
        modules: sql<number>`(select count(*) from modules m where m.owner_org_id = ${ORG_ID})`.mapWith(Number),
        customParts: sql<number>`(select count(*) from custom_parts c where c.owner_org_id = ${ORG_ID})`.mapWith(Number),
      })
      .from(schema.orgs)
      .orderBy(desc(sql`4`))
      .limit(50)
      .all();
    const personal = db
      .select({ n: count(), bytes: sql<number>`coalesce(sum(length(${schema.layouts.docSnapshot}) + coalesce(length(${schema.layouts.sidecarSnapshot}), 0)), 0)`.mapWith(Number) })
      .from(schema.layouts)
      .where(isNotNull(schema.layouts.ownerUserId))
      .get();
    // Most active layouts: rollup edit counts in range, then titles.
    const active = rollupByKey('layout_edits', r, 10);
    const titles = active.length
      ? db
          .select({ id: schema.layouts.id, title: schema.layouts.title, ownerOrgName: schema.orgs.name })
          .from(schema.layouts)
          .leftJoin(schema.orgs, eq(schema.orgs.id, schema.layouts.ownerOrgId))
          .where(inArray(schema.layouts.id, active.map((a) => a.key)))
          .all()
      : [];
    const titleById = new Map(titles.map((t) => [t.id, t]));
    return {
      range: r.id,
      totals: {
        layouts: totals?.n ?? 0,
        layoutBytes: totals?.bytes ?? 0,
        customParts: partTotals?.n ?? 0,
        customPartBytes: partTotals?.bytes ?? 0,
        modules: countWhere(schema.modules),
        rooms: countWhere(schema.venueLibrary),
        staleLayouts: countWhere(schema.layouts, staleWhere),
      },
      largestLayouts: largest.map((l) => ({
        ...l,
        updatedAt: l.updatedAt.getTime(),
        parts: scan.partCountByLayout.get(l.id) ?? null,
      })),
      staleLayouts: stale,
      byOwner: { personal: { layouts: personal?.n ?? 0, bytes: personal?.bytes ?? 0 }, clubs: byOrg },
      mostActiveLayouts: active
        .filter((a) => titleById.has(a.key))
        .map((a) => ({ id: a.key, title: titleById.get(a.key)!.title, ownerOrgName: titleById.get(a.key)!.ownerOrgName, edits: a.value })),
      topParts: scan.topParts,
      missingParts: scan.missingParts,
      scan: { at: scan.at, scanned: scan.scanned, total: scan.total },
      // There is no review step for custom part uploads; null says so.
      reviewQueue: null,
    };
  });

  app.get<{ Querystring: RangeQuery }>('/api/admin/insights/people', async (req) => {
    requireGlobalAdmin(req);
    const now = Date.now();
    const r = rangeSpec(req.query.range, now);
    const providers = db
      .select({ provider: schema.oauthAccounts.provider, n: sql<number>`count(distinct ${schema.oauthAccounts.userId})`.mapWith(Number) })
      .from(schema.oauthAccounts)
      .groupBy(schema.oauthAccounts.provider)
      .all();
    const password = countWhere(schema.users, isNotNull(schema.users.passwordHash));
    const nowDate = new Date(now);
    const pendingOrgInvites = countWhere(
      schema.orgInvites,
      and(isNull(schema.orgInvites.acceptedAt), gte(schema.orgInvites.expiresAt, nowDate)),
    );
    const pendingLayoutInvites = countWhere(
      schema.layoutInvites,
      and(isNull(schema.layoutInvites.acceptedAt), gte(schema.layoutInvites.expiresAt, nowDate)),
    );
    const pendingTransfers =
      countWhere(schema.layoutTransfers, and(isNull(schema.layoutTransfers.acceptedAt), gte(schema.layoutTransfers.expiresAt, nowDate))) +
      countWhere(schema.moduleTransfers, and(isNull(schema.moduleTransfers.acceptedAt), gte(schema.moduleTransfers.expiresAt, nowDate)));
    const dormantCutoff = now - 182 * DAY_MS;
    const dormant = countWhere(
      schema.users,
      sql`coalesce(${schema.users.lastSeenAt}, ${schema.users.createdAt}) < ${dormantCutoff}`,
    );
    // Club activity in range: rollup edit counts of their layouts.
    const edits = rollupByKey('layout_edits', r, 5000);
    const editOwners = edits.length
      ? db
          .select({ id: schema.layouts.id, orgId: schema.layouts.ownerOrgId })
          .from(schema.layouts)
          .where(and(inArray(schema.layouts.id, edits.map((e) => e.key)), isNotNull(schema.layouts.ownerOrgId)))
          .all()
      : [];
    const orgOf = new Map(editOwners.map((e) => [e.id, e.orgId!]));
    const editsByOrg = new Map<string, number>();
    for (const e of edits) {
      const org = orgOf.get(e.key);
      if (org) editsByOrg.set(org, (editsByOrg.get(org) ?? 0) + e.value);
    }
    const clubs = db
      .select({
        id: schema.orgs.id,
        name: schema.orgs.name,
        slug: schema.orgs.slug,
        createdAt: schema.orgs.createdAt,
        members: sql<number>`(select count(*) from org_members m where m.org_id = ${ORG_ID})`.mapWith(Number),
        layouts: sql<number>`(select count(*) from layouts l where l.owner_org_id = ${ORG_ID})`.mapWith(Number),
        lastChange: sql<number | null>`(select max(l.updated_at) from layouts l where l.owner_org_id = ${ORG_ID})`,
      })
      .from(schema.orgs)
      .orderBy(desc(sql`5`))
      .limit(50)
      .all();
    return {
      range: r.id,
      totals: {
        users: countWhere(schema.users),
        clubs: countWhere(schema.orgs),
        unverified: countWhere(schema.users, eq(schema.users.emailVerified, false)),
        dormant6m: dormant,
        admins: countWhere(schema.users, eq(schema.users.isGlobalAdmin, true)),
      },
      // The demo account (Admin › Settings): on or off, last reset, and
      // how many things it has now.
      demo: await demoInsight(),
      signInMethods: [
        ...providers.map((p) => ({ method: p.provider, users: p.n })),
        { method: 'password', users: password },
      ].sort((a, b) => b.users - a.users),
      pending: { clubInvites: pendingOrgInvites, layoutInvites: pendingLayoutInvites, transfers: pendingTransfers },
      clubs: clubs
        .map((c) => ({
          ...c,
          createdAt: c.createdAt.getTime(),
          lastChange: c.lastChange === null ? null : Number(c.lastChange),
          editsInRange: editsByOrg.get(c.id) ?? 0,
        }))
        .sort((a, b) => b.editsInRange - a.editsInRange || b.members - a.members),
      collectingSince: collectingSince(),
    };
  });

  app.get<{ Querystring: RangeQuery }>('/api/admin/insights/health', async (req) => {
    requireGlobalAdmin(req);
    flushRollup();
    const now = Date.now();
    const r = rangeSpec(req.query.range, now);
    const requests = rollupTotal('requests', r);
    const errors = rollupTotal('errors_5xx', r);
    const backups = listBackups();
    const dbBytes = databaseBytes();
    const dbSeries = bucketRollup('db_bytes', r, 'last').filter((v) => v > 0);
    return {
      range: r.id,
      version: appVersion(),
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: now - Math.round(process.uptime() * 1000),
      live: liveStats(),
      requests: {
        total: requests,
        errors5xx: errors,
        errorRatePct: requests > 0 ? Math.round((errors / requests) * 10000) / 100 : 0,
        slow: rollupTotal('slow', r),
        slowThresholdMs: 1000,
        errorRoutes: rollupByKey('errors_5xx_route', r, 10),
        slowRoutes: rollupByKey('slow_route', r, 10),
        refusedRoutes: rollupByKey('refused', r, 20),
      },
      disk: {
        databaseBytes: dbBytes,
        databaseGrowthBytes: dbSeries.length > 1 ? dbBytes - dbSeries[0]! : null,
        partsBytes: partsBytes(now),
        backupsBytes: backups.reduce((a, b) => a + b.bytes, 0),
        volume: diskUse(dirname(resolve(env.dbPath))),
      },
      parts: {
        libraries: countWhere(schema.partLibraries),
        libraryParts: (db.select({ n: sql<number>`coalesce(sum(${schema.partLibraries.partCount}), 0)`.mapWith(Number) }).from(schema.partLibraries).get()?.n) ?? 0,
        customParts: countWhere(schema.customParts),
      },
      backups: {
        enabled: (await backgroundJobs()).backups.value,
        lastAt: backups[0]?.at ?? null,
        files: backups.slice(0, 30),
      },
      collectingSince: collectingSince(),
    };
  });

  app.get('/api/admin/insights/alerts', async (req) => {
    requireGlobalAdmin(req);
    flushRollup();
    return { alerts: computeAlerts(Date.now(), await desktopPolicy(), (await backgroundJobs()).backups.value) };
  });

  // Signed-in web clients say once per load whether they run as an
  // installed app or in a browser tab. Counted per person per day,
  // aggregate only.
  // codeql[js/missing-rate-limiting] - rate limited via Fastify config.rateLimit
  app.post<{ Body: { display?: unknown } }>(
    '/api/metrics/client',
    // Per person (else per address): a club on one show Wi-Fi shares an
    // address, and refusing their beacons raised "refused requests" alerts.
    // The page sends it at most once a day per browser now; 60 still
    // leaves room for several browsers on one account.
    { config: { rateLimit: perPerson(60, '1 minute') } },
    async (req, reply) => {
      const user = req.user;
      const display = req.body?.display;
      if (user && (display === 'standalone' || display === 'browser')) {
        rollup.distinct('display', display, user.id);
        return reply.code(204).send();
      }
      // Not counted (signed out or a bad value): the page asks again later.
      return reply.code(202).send();
    },
  );
}
