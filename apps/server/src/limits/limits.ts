// Usage limits: what they are, where their values come from, how much a
// person or club has used, and the friendly refusal when growth would go
// past one.
//
// Value of a limit for a subject, first match wins:
//   1. an admin override for that person or club (limit_overrides)
//   2. the "smart" rules: no clubs before the email is verified, one club
//      in an account's first week, and club storage that grows with members
//   3. the global value an admin set in Admin › Settings (platform_settings.limits)
//   4. the LIMIT_* env var
//   5. the built-in default below — generous, so no existing club or
//      person is blocked when limits first switch on
//
// Only growth is ever refused: something already over a new limit stays,
// and reading and deleting always work.

import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { env } from '../env.js';
import { getPlatformSettings } from '../auth/platformSettings.js';
import type { User } from '../db/schema.js';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const DAY_MS = 24 * 60 * 60 * 1000;

export type LimitKey =
  | 'clubsPerUser'
  | 'newAccountClubs'
  | 'layoutsPerUser'
  | 'layoutsPerClub'
  | 'storagePerUser'
  | 'storagePerClub'
  | 'storagePerClubMember'
  | 'customPartsPerUser'
  | 'customPartsPerClub'
  | 'uploadBytes'
  | 'membersPerClub'
  | 'shareLinksPerUser'
  | 'shareLinksPerClub'
  | 'liveEditorsPerLayout'
  | 'requestsPerMinuteUser'
  | 'requestsPerMinuteToken';

export interface LimitInfo {
  key: LimitKey;
  label: string;
  /** One plain sentence for the settings page. */
  help: string;
  unit: 'count' | 'bytes' | 'per_minute';
  applies: 'user' | 'org' | 'both';
  builtIn: number;
  envVar: string;
}

export const LIMITS: readonly LimitInfo[] = [
  { key: 'clubsPerUser', label: 'Clubs a person can create', help: 'How many clubs one person may start. People must confirm their email first.', unit: 'count', applies: 'user', builtIn: 5, envVar: 'LIMIT_CLUBS_PER_USER' },
  { key: 'newAccountClubs', label: 'Clubs in an account’s first week', help: 'Lower cap for brand-new accounts, so a throwaway account can’t make many clubs.', unit: 'count', applies: 'user', builtIn: 1, envVar: 'LIMIT_NEW_ACCOUNT_CLUBS' },
  { key: 'layoutsPerUser', label: 'Layouts per person', help: 'Personal layouts one person may keep.', unit: 'count', applies: 'user', builtIn: 500, envVar: 'LIMIT_LAYOUTS_PER_USER' },
  { key: 'layoutsPerClub', label: 'Layouts per club', help: 'Layouts a club may keep.', unit: 'count', applies: 'org', builtIn: 2000, envVar: 'LIMIT_LAYOUTS_PER_CLUB' },
  { key: 'storagePerUser', label: 'Space per person', help: 'Layouts, custom parts, modules, venues, background pictures and collection covers one person owns.', unit: 'bytes', applies: 'user', builtIn: 2 * GB, envVar: 'LIMIT_STORAGE_PER_USER' },
  { key: 'storagePerClub', label: 'Space per club', help: 'The same, for everything a club owns.', unit: 'bytes', applies: 'org', builtIn: 10 * GB, envVar: 'LIMIT_STORAGE_PER_CLUB' },
  { key: 'storagePerClubMember', label: 'Extra club space per member', help: 'Clubs get this much more space for each member, so bigger clubs have more room.', unit: 'bytes', applies: 'org', builtIn: 256 * MB, envVar: 'LIMIT_STORAGE_PER_CLUB_MEMBER' },
  { key: 'customPartsPerUser', label: 'Custom parts per person', help: 'Parts one person may upload.', unit: 'count', applies: 'user', builtIn: 2000, envVar: 'LIMIT_CUSTOM_PARTS_PER_USER' },
  { key: 'customPartsPerClub', label: 'Custom parts per club', help: 'Parts a club may hold.', unit: 'count', applies: 'org', builtIn: 5000, envVar: 'LIMIT_CUSTOM_PARTS_PER_CLUB' },
  { key: 'uploadBytes', label: 'Largest single upload', help: 'The biggest one file (layout, picture or part) that can be sent at once.', unit: 'bytes', applies: 'both', builtIn: 50 * MB, envVar: 'LIMIT_UPLOAD_BYTES' },
  { key: 'membersPerClub', label: 'Members per club', help: 'People one club may have.', unit: 'count', applies: 'org', builtIn: 500, envVar: 'LIMIT_MEMBERS_PER_CLUB' },
  { key: 'shareLinksPerUser', label: 'Share links per person', help: 'Personal layouts shared with a public link at once.', unit: 'count', applies: 'user', builtIn: 200, envVar: 'LIMIT_SHARE_LINKS_PER_USER' },
  { key: 'shareLinksPerClub', label: 'Share links per club', help: 'Club layouts shared with a public link at once.', unit: 'count', applies: 'org', builtIn: 1000, envVar: 'LIMIT_SHARE_LINKS_PER_CLUB' },
  { key: 'liveEditorsPerLayout', label: 'People editing one layout at once', help: 'Live connections to one layout.', unit: 'count', applies: 'both', builtIn: 50, envVar: 'LIMIT_LIVE_EDITORS_PER_LAYOUT' },
  { key: 'requestsPerMinuteUser', label: 'Requests per minute (browser)', help: 'Requests one signed-in person may make in a minute from the web app.', unit: 'per_minute', applies: 'user', builtIn: 2400, envVar: 'LIMIT_REQUESTS_PER_MINUTE_USER' },
  { key: 'requestsPerMinuteToken', label: 'Requests per minute (desktop app)', help: 'Requests one desktop sign-in may make in a minute.', unit: 'per_minute', applies: 'user', builtIn: 2400, envVar: 'LIMIT_REQUESTS_PER_MINUTE_TOKEN' },
];

const LIMIT_BY_KEY = new Map(LIMITS.map((l) => [l.key, l]));

export function isLimitKey(k: string): k is LimitKey {
  return LIMIT_BY_KEY.has(k as LimitKey);
}

export type LimitValues = Record<LimitKey, number>;

/** Built-in defaults overlaid with LIMIT_* env vars (bad values ignored). */
export function envDefaults(source: NodeJS.ProcessEnv = process.env): LimitValues {
  const out = {} as LimitValues;
  for (const l of LIMITS) {
    const raw = source[l.envVar];
    const n = raw === undefined ? NaN : Number(raw);
    out[l.key] = Number.isInteger(n) && n >= 0 ? n : l.builtIn;
  }
  return out;
}

/** Keep only known keys with whole, non-negative values. */
export function cleanLimits(raw: unknown): Partial<LimitValues> {
  const out: Partial<LimitValues> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (isLimitKey(k) && typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER) out[k] = v;
  }
  return out;
}

function parseJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cached settings and overrides. Both are tiny; refreshed on change and at
// most every 30 seconds otherwise (another process may have changed them).
// ---------------------------------------------------------------------------

const CACHE_MS = 30_000;
let globalCache: { at: number; stored: Partial<LimitValues>; values: LimitValues; enforced: boolean } | null = null;
let overrideCache: { at: number; rows: Map<string, { limits: Partial<LimitValues>; suspended: boolean; reason: string | null }> } | null = null;

export function invalidateLimitCaches(): void {
  globalCache = null;
  overrideCache = null;
}

/** The global limits: env/built-in defaults with the admin's stored values on top. */
export async function globalLimits(now: number = Date.now()): Promise<{ stored: Partial<LimitValues>; values: LimitValues }> {
  if (globalCache && now - globalCache.at < CACHE_MS) return globalCache;
  const settings = await getPlatformSettings();
  const stored = cleanLimits(parseJson(settings.limits));
  globalCache = { at: now, stored, values: { ...envDefaults(), ...stored }, enforced: settings.limitsEnforced };
  return globalCache;
}

/** Where "are limits enforced?" comes from: the admin's switch, or the server's LIMITS_ENFORCE forcing it. */
export type EnforcementSource = 'setting' | 'forced-on' | 'forced-off';

export function enforcementSource(): EnforcementSource {
  return env.limitsEnforceForced === 'on' ? 'forced-on' : env.limitsEnforceForced === 'off' ? 'forced-off' : 'setting';
}

/**
 * Whether usage limits refuse anything right now. Off means use is still
 * counted and shown, but nothing is refused (no limit_reached, no 429).
 * Read-only (a suspension) doesn't depend on it: it always holds. Read live: the admin's switch takes effect at
 * once (its change clears the cache), no restart.
 */
export async function limitsEnforced(now: number = Date.now()): Promise<boolean> {
  const source = enforcementSource();
  if (source !== 'setting') return source === 'forced-on';
  if (!globalCache || now - globalCache.at >= CACHE_MS) await globalLimits(now);
  return globalCache!.enforced;
}

function overrideKey(kind: 'user' | 'org', id: string): string {
  return `${kind}:${id}`;
}

function loadOverrides(now: number) {
  if (overrideCache && now - overrideCache.at < CACHE_MS) return overrideCache.rows;
  const rows = new Map<string, { limits: Partial<LimitValues>; suspended: boolean; reason: string | null }>();
  for (const r of db.select().from(schema.limitOverrides).all()) {
    rows.set(overrideKey(r.subjectKind, r.subjectId), {
      limits: cleanLimits(parseJson(r.limits)),
      suspended: r.suspended,
      reason: r.suspendedReason,
    });
  }
  overrideCache = { at: now, rows };
  return rows;
}

export function overrideFor(kind: 'user' | 'org', id: string, now: number = Date.now()) {
  return loadOverrides(now).get(overrideKey(kind, id)) ?? { limits: {}, suspended: false, reason: null };
}

export function isSuspended(kind: 'user' | 'org', id: string): boolean {
  return overrideFor(kind, id).suspended;
}

// ---------------------------------------------------------------------------
// Effective limits
// ---------------------------------------------------------------------------

export type LimitSource = 'default' | 'smart' | 'override';

export interface EffectiveLimit {
  value: number;
  source: LimitSource;
  /** Why a smart rule applies, for the admin page. */
  reason?: string;
}

/** Every limit as it applies to one person. */
export async function userLimits(user: Pick<User, 'id' | 'emailVerified' | 'createdAt'>, now: number = Date.now()): Promise<Record<LimitKey, EffectiveLimit>> {
  const { values } = await globalLimits(now);
  const ov = overrideFor('user', user.id, now).limits;
  const out = {} as Record<LimitKey, EffectiveLimit>;
  for (const l of LIMITS) out[l.key] = { value: values[l.key], source: 'default' };
  if (!user.emailVerified) {
    out.clubsPerUser = { value: 0, source: 'smart', reason: 'Email not confirmed yet' };
  } else if (now - user.createdAt.getTime() < 7 * DAY_MS) {
    out.clubsPerUser = { value: Math.min(values.clubsPerUser, values.newAccountClubs), source: 'smart', reason: 'Account is less than a week old' };
  }
  for (const [k, v] of Object.entries(ov) as [LimitKey, number][]) out[k] = { value: v, source: 'override' };
  return out;
}

/** Every limit as it applies to one club (storage grows with members). */
export async function orgLimits(orgId: string, members: number, now: number = Date.now()): Promise<Record<LimitKey, EffectiveLimit>> {
  const { values } = await globalLimits(now);
  const ov = overrideFor('org', orgId, now).limits;
  const out = {} as Record<LimitKey, EffectiveLimit>;
  for (const l of LIMITS) out[l.key] = { value: values[l.key], source: 'default' };
  const bonus = values.storagePerClubMember * members;
  if (bonus > 0) {
    out.storagePerClub = { value: values.storagePerClub + bonus, source: 'smart', reason: `Includes ${members} member${members === 1 ? '' : 's'} × extra space` };
  }
  for (const [k, v] of Object.entries(ov) as [LimitKey, number][]) out[k] = { value: v, source: 'override' };
  return out;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface Subject {
  kind: 'user' | 'org';
  id: string;
}

export interface Usage {
  layouts: number;
  customParts: number;
  modules: number;
  rooms: number;
  shareLinks: number;
  members: number;
  clubsCreated: number;
  storageBytes: number;
}

function bgImageBytes(layoutIds: readonly string[]): number {
  if (layoutIds.length === 0) return 0;
  const dir = join(dirname(env.dbPath), 'bgimages');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const want = new Set(layoutIds);
  let total = 0;
  for (const n of names) {
    const id = n.replace(/\.[a-z0-9]+$/i, '');
    if (!want.has(id)) continue;
    try {
      total += statSync(join(dir, n)).size;
    } catch {
      /* gone */
    }
  }
  return total;
}

/** What a person or club has used right now. */
export function usageOf(subject: Subject): Usage {
  const isUser = subject.kind === 'user';
  const lCol = isUser ? schema.layouts.ownerUserId : schema.layouts.ownerOrgId;
  const pCol = isUser ? schema.customParts.ownerUserId : schema.customParts.ownerOrgId;
  const mCol = isUser ? schema.modules.ownerUserId : schema.modules.ownerOrgId;
  const vCol = isUser ? schema.venueLibrary.ownerUserId : schema.venueLibrary.ownerOrgId;
  const layouts = db
    .select({
      id: schema.layouts.id,
      bytes: sql<number>`length(${schema.layouts.docSnapshot}) + coalesce(length(${schema.layouts.sidecarSnapshot}), 0)`.mapWith(Number),
      shared: sql<number>`${schema.layouts.publicShareToken} is not null`.mapWith(Number),
    })
    .from(schema.layouts)
    .where(eq(lCol, subject.id))
    .all();
  const ids = layouts.map((l) => l.id);
  const pending = ids.length
    ? db
        .select({ n: sql<number>`coalesce(sum(length(${schema.layoutUpdates.updateBytes})), 0)`.mapWith(Number) })
        .from(schema.layoutUpdates)
        .where(inArray(schema.layoutUpdates.layoutId, ids))
        .get()?.n ?? 0
    : 0;
  const parts = db
    .select({ n: count(), bytes: sql<number>`coalesce(sum(length(${schema.customParts.xmlBlob}) + length(${schema.customParts.spriteBlob})), 0)`.mapWith(Number) })
    .from(schema.customParts)
    .where(eq(pCol, subject.id))
    .get();
  const mods = db
    .select({ n: count(), bytes: sql<number>`coalesce(sum(length(${schema.modules.docSnapshot}) + coalesce(length(${schema.modules.sidecarSnapshot}), 0) + coalesce(length(${schema.modules.thumbnail}), 0) + coalesce((SELECT sum(length(v.doc_snapshot) + coalesce(length(v.thumbnail), 0)) FROM module_versions v WHERE v.module_id = "modules"."id"), 0)), 0)`.mapWith(Number) })
    .from(schema.modules)
    .where(eq(mCol, subject.id))
    .get();
  // What they've shared to the public catalogs (each version is a copy).
  const cCol = isUser ? schema.catalogItems.ownerUserId : schema.catalogItems.ownerOrgId;
  const shared = db
    .select({
      bytes: sql<number>`coalesce(sum(coalesce(length(${schema.catalogItemVersions.docSnapshot}), 0) + coalesce(length(${schema.catalogItemVersions.xmlBlob}), 0) + coalesce(length(${schema.catalogItemVersions.spriteBlob}), 0) + coalesce(length(${schema.catalogItemVersions.thumbnail}), 0)), 0)`.mapWith(Number),
    })
    .from(schema.catalogItemVersions)
    .innerJoin(schema.catalogItems, eq(schema.catalogItems.id, schema.catalogItemVersions.itemId))
    .where(eq(cCol, subject.id))
    .get();
  const rooms = db
    .select({ n: count(), bytes: sql<number>`coalesce(sum(length(${schema.venueLibrary.data})), 0)`.mapWith(Number) })
    .from(schema.venueLibrary)
    .where(eq(vCol, subject.id))
    .get();
  // Collections' uploaded covers: a person's own collections, or the club's.
  const covers = db
    .select({ bytes: sql<number>`coalesce(sum(length(${schema.catalogCollectionCovers.image}) + length(${schema.catalogCollectionCovers.small})), 0)`.mapWith(Number) })
    .from(schema.catalogCollectionCovers)
    .innerJoin(schema.catalogCollections, eq(schema.catalogCollections.id, schema.catalogCollectionCovers.collectionId))
    .where(isUser ? and(eq(schema.catalogCollections.ownerUserId, subject.id), isNull(schema.catalogCollections.orgId)) : eq(schema.catalogCollections.orgId, subject.id))
    .get();
  // Catalog items' uploaded pictures: what they (or the club) shared.
  const itemCovers = db
    .select({ bytes: sql<number>`coalesce(sum(length(${schema.catalogItemCovers.image}) + length(${schema.catalogItemCovers.small})), 0)`.mapWith(Number) })
    .from(schema.catalogItemCovers)
    .innerJoin(schema.catalogItems, eq(schema.catalogItems.id, schema.catalogItemCovers.itemId))
    .where(eq(cCol, subject.id))
    .get();
  const members = isUser
    ? 0
    : db.select({ n: count() }).from(schema.orgMembers).where(eq(schema.orgMembers.orgId, subject.id)).get()?.n ?? 0;
  const clubsCreated = isUser
    ? db.select({ n: count() }).from(schema.orgs).where(eq(schema.orgs.createdBy, subject.id)).get()?.n ?? 0
    : 0;
  return {
    layouts: layouts.length,
    customParts: parts?.n ?? 0,
    modules: mods?.n ?? 0,
    rooms: rooms?.n ?? 0,
    shareLinks: layouts.reduce((a, l) => a + (l.shared ? 1 : 0), 0),
    members,
    clubsCreated,
    storageBytes:
      layouts.reduce((a, l) => a + l.bytes, 0) + pending + (parts?.bytes ?? 0) + (mods?.bytes ?? 0) + (shared?.bytes ?? 0) + (rooms?.bytes ?? 0) + (covers?.bytes ?? 0) + (itemCovers?.bytes ?? 0) + bgImageBytes(ids),
  };
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export function formatSize(bytes: number): string {
  if (bytes >= GB) return `${Math.round((bytes / GB) * 10) / 10} GB`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export interface Refusal {
  status: 403 | 413;
  body: {
    error: 'limit_reached' | 'suspended' | 'verify_email_first';
    /** The limit that applies (limit_reached only). */
    limit?: LimitKey;
    scope?: 'user' | 'org';
    used?: number;
    max?: number;
    /** Ready to show to a person. */
    message: string;
  };
}

function reached(limit: LimitKey, scope: 'user' | 'org', used: number, max: number, message: string, status: 403 | 413 = 403): Refusal {
  return { status, body: { error: 'limit_reached', limit, scope, used, max, message } };
}

const ASK = 'Ask the site admin if you need more.';

/** "1 layout", "3 layouts". */
export function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

export interface Growth {
  layouts?: number;
  customParts?: number;
  /** Bytes this change adds (only positive growth is checked). */
  bytes?: number;
  shareLinks?: number;
  members?: number;
  clubs?: number;
}

/**
 * Would this change take `owner` past a limit? `actor` is the signed-in
 * person making it (a suspended person can't add anything anywhere).
 * Returns null when it may go ahead.
 */
export async function checkGrowth(opts: {
  actor: User;
  owner: Subject;
  add?: Growth;
  /** Size of a single uploaded file or body. */
  uploadBytes?: number;
}): Promise<Refusal | null> {
  const { actor, owner } = opts;
  const add = opts.add ?? {};
  // Read-only comes first and holds whether or not limits are enforced.
  const actorOv = overrideFor('user', actor.id);
  if (actorOv.suspended) {
    return { status: 403, body: { error: 'suspended', message: 'Your account is read-only for now. Ask the site admin why.' } };
  }
  if (owner.kind === 'org' && isSuspended('org', owner.id)) {
    return { status: 403, body: { error: 'suspended', message: 'This club is read-only for now. Ask the site admin why.' } };
  }
  if (owner.kind === 'user' && owner.id !== actor.id && isSuspended('user', owner.id)) {
    return { status: 403, body: { error: 'suspended', message: 'That account is read-only for now.' } };
  }
  if (!(await limitsEnforced())) return null; // counted and shown, never refused

  if (add.clubs) {
    if (!actor.emailVerified) {
      return { status: 403, body: { error: 'verify_email_first', message: 'Please confirm your email address before starting a club.' } };
    }
  }

  const isOrg = owner.kind === 'org';
  const usage = usageOf(owner);
  let limits: Record<LimitKey, EffectiveLimit>;
  if (isOrg) limits = await orgLimits(owner.id, usage.members);
  else {
    const ownerUser = owner.id === actor.id ? actor : db.select().from(schema.users).where(eq(schema.users.id, owner.id)).get();
    limits = await userLimits(ownerUser ?? actor);
  }
  const who = isOrg ? 'Your club' : 'You';
  const has = isOrg ? 'has' : 'have';

  if (opts.uploadBytes !== undefined) {
    const max = limits.uploadBytes.value;
    if (opts.uploadBytes > max) {
      return reached('uploadBytes', owner.kind, opts.uploadBytes, max, `That file is ${formatSize(opts.uploadBytes)}; the most you can send at once is ${formatSize(max)}.`, 413);
    }
  }
  if (add.clubs && add.clubs > 0) {
    const l = limits.clubsPerUser;
    if (usage.clubsCreated + add.clubs > l.value) {
      const msg =
        l.source === 'smart' && l.value > 0
          ? `New accounts can start ${l.value} club${l.value === 1 ? '' : 's'} in their first week. Try again in a few days.`
          : `You have started ${plural(usage.clubsCreated, 'club')}, the most you can. ${ASK}`;
      return reached('clubsPerUser', 'user', usage.clubsCreated, l.value, msg);
    }
  }
  if (add.layouts && add.layouts > 0) {
    const key: LimitKey = isOrg ? 'layoutsPerClub' : 'layoutsPerUser';
    const max = limits[key].value;
    if (usage.layouts + add.layouts > max) {
      return reached(key, owner.kind, usage.layouts, max, `${who} ${has} ${plural(usage.layouts, 'layout')}, the most allowed. Delete one you don’t need, or ask the site admin for more.`);
    }
  }
  if (add.customParts && add.customParts > 0) {
    const key: LimitKey = isOrg ? 'customPartsPerClub' : 'customPartsPerUser';
    const max = limits[key].value;
    if (usage.customParts + add.customParts > max) {
      return reached(key, owner.kind, usage.customParts, max, `${who} ${has} ${plural(usage.customParts, 'custom part')}, the most allowed. ${ASK}`);
    }
  }
  if (add.shareLinks && add.shareLinks > 0) {
    const key: LimitKey = isOrg ? 'shareLinksPerClub' : 'shareLinksPerUser';
    const max = limits[key].value;
    if (usage.shareLinks + add.shareLinks > max) {
      return reached(key, owner.kind, usage.shareLinks, max, `${who} ${has} ${plural(usage.shareLinks, 'share link')} on, the most allowed. Turn one off first.`);
    }
  }
  if (add.members && add.members > 0 && isOrg) {
    const max = limits.membersPerClub.value;
    if (usage.members + add.members > max) {
      return reached('membersPerClub', 'org', usage.members, max, `This club has ${plural(usage.members, 'member')}, the most allowed. Ask the site admin for more room.`);
    }
  }
  if (add.bytes && add.bytes > 0) {
    const key: LimitKey = isOrg ? 'storagePerClub' : 'storagePerUser';
    const max = limits[key].value;
    if (usage.storageBytes + add.bytes > max) {
      const msg = isOrg
        ? `Your club has used its ${formatSize(max)}. Ask the site admin for more room.`
        : `You have used your ${formatSize(max)} of space. Delete something you don’t need, or ask the site admin for more room.`;
      return reached(key, owner.kind, usage.storageBytes, max, msg);
    }
  }
  return null;
}

/** Owner subject of a layout/part/module/venue row. */
export function ownerOf(row: { ownerUserId: string | null; ownerOrgId: string | null }): Subject | null {
  if (row.ownerOrgId) return { kind: 'org', id: row.ownerOrgId };
  if (row.ownerUserId) return { kind: 'user', id: row.ownerUserId };
  return null;
}

/** The request body's declared size, for the single-upload limit. */
export function declaredBytes(headers: Record<string, string | string[] | undefined>): number {
  const n = Number(headers['content-length']);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
