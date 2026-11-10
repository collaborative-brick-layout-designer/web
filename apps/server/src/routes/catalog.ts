// Public module and parts catalogs, with optional moderation.
//
// - Both catalogs are off until a global admin turns them on (Admin ›
//   Settings); while off, every catalog route answers 404 catalog_off.
// - Sharing makes a COPY (catalog_item_versions): later edits to the
//   original change nothing until its owner shares an update.
// - Review: 'moderators' (each submission waits in the queue) or 'none'
//   (published straight away). Moderators and global admins approve,
//   decline and unpublish; every action is audit-logged.
// - "Add to my modules / my parts" copies the public version to the
//   caller (or a club they can add to) and counts a use.
//
// All bodies are JSON (the site's firewall only lets octet-stream through
// on the two snapshot routes).

import { coverMaxBytes } from '../images/covers.js';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { User } from '../db/schema.js';
import { requireUser } from '../auth/cookie.js';
import { isDemoUser } from '../demo/demoAccount.js';
import { getPlatformSettings } from '../auth/platformSettings.js';
import { checkGrowth, type Subject } from '../limits/limits.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { addPermission } from '../access/clubPermissions.js';
import { destinationOrg } from './owners.js';
import { type ClubRole } from '../access/clubRoles.js';
import { can } from '../access/clubPermissions.js';
import { recordVersion } from './modules.js';
import { collectionCounts, dropFromCollections, siteHeldCollection } from './collections.js';
import { nameFor, publicName } from '../utils/publicName.js';
import { creditLookup } from './credits.js';
import { coverQueue, coverState, itemCoverUrl } from './itemCovers.js';
import { catalogSummaries, publicVenue, publishedDoc, publishLayoutDoc, venuePicture, venueSummary } from './catalogDocs.js';
import { currentDocBytes } from './layouts.js';
import { MAX_THUMBNAIL_BYTES, reencode, THUMBNAIL_BODY_LIMIT } from '../images/thumbnails.js';
import { sniffCover } from '../images/covers.js';
import type { Venue } from '@cld/bbm';
import { perPerson } from '../utils/rateLimits.js';
import { stripImportSource } from '../utils/partXml.js';

/** What the catalog holds: modules and custom parts, and (when on) layouts and venues. */
export type Kind = 'module' | 'part' | 'layout' | 'venue';
export const CATALOG_KINDS: readonly Kind[] = ['module', 'part', 'layout', 'venue'];
// The desktop app (an API token) browses the catalog and adds from it:
// browsing needs layouts:read; adding a copy, layouts:write (a module) or
// parts:write (a part).
const TOKEN_READ = { apiToken: 'layouts:read' } as const;
const TOKEN_ADD = ['layouts:write', 'parts:write'] as const;
const MAX_TITLE = 80;
const MAX_DESCRIPTION = 1000;
const MAX_TAGS = 8;
const MAX_TAG = 24;
const MAX_REASON = 300;

/** A catalog item's owner, as a warning's subject. */
function ownerRef(i: { ownerUserId: string | null; ownerOrgId: string | null }): { kind: 'user' | 'org'; id: string } | null {
  return i.ownerOrgId ? { kind: 'org', id: i.ownerOrgId } : i.ownerUserId ? { kind: 'user', id: i.ownerUserId } : null;
}

export function canModerate(user: Pick<User, 'isGlobalAdmin' | 'isModerator'> | null | undefined): boolean {
  return !!user && (user.isGlobalAdmin || user.isModerator);
}

function isKind(v: unknown): v is Kind {
  return CATALOG_KINDS.includes(v as Kind);
}

export async function catalogOn(kind: Kind): Promise<boolean> {
  const s = await getPlatformSettings();
  if (kind === 'module') return s.moduleCatalogEnabled;
  if (kind === 'part') return s.partsCatalogEnabled;
  if (kind === 'layout') return s.layoutCatalogEnabled;
  return s.venueCatalogEnabled;
}

/** Lower-case, trimmed, unique tags; null when they're not acceptable. */
export function cleanTags(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string') return null;
    const v = t.trim().toLowerCase();
    if (!v) continue;
    if (v.length > MAX_TAG) return null;
    if (!out.includes(v)) out.push(v);
  }
  return out.length > MAX_TAGS ? null : out;
}

export function cleanText(raw: unknown, max: number): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (t.length > max) return undefined;
  return t || null;
}

/** The club role the user has in `orgId`, if any. */
export async function clubRole(userId: string, orgId: string): Promise<ClubRole | null> {
  const m = await db
    .select({ role: schema.orgMembers.role })
    .from(schema.orgMembers)
    .where(and(eq(schema.orgMembers.orgId, orgId), eq(schema.orgMembers.userId, userId)))
    .get();
  return m?.role ?? null;
}

/** Which of these clubs are trusted (they review what's published under their name). */
export async function trustedClubs(orgIds: readonly (string | null | undefined)[]): Promise<Set<string>> {
  const ids = [...new Set(orgIds.filter((x): x is string => !!x))];
  if (!ids.length) return new Set();
  const rows = await db.select({ id: schema.orgs.id }).from(schema.orgs).where(and(inArray(schema.orgs.id, ids), eq(schema.orgs.trusted, true)));
  return new Set(rows.map((r) => r.id));
}

/**
 * Who a takedown is held by: 'site' (only site moderators bring it back),
 * 'club' (the club's own reviewers may too), or null. One from before the
 * marker was kept counts as the site's.
 */
export function holdOf(x: { status: string; takenDownBy: 'site' | 'club' | null }): 'site' | 'club' | null {
  return x.takenDownBy ?? (x.status === 'unpublished' ? 'site' : null);
}

/** The hold a new takedown leaves: a site takedown stays the site's. */
export function nextHold(current: 'site' | 'club' | null, clubId: string | null): 'site' | 'club' {
  return current === 'site' || !clubId ? 'site' : 'club';
}

export async function isTrustedClub(orgId: string | null | undefined): Promise<boolean> {
  return !!orgId && (await trustedClubs([orgId])).has(orgId);
}

/** Whether `user` manages things owned by this person or club: the person themselves, or "send to the catalog" in the club. */
export async function manages(userId: string, owner: { ownerUserId: string | null; ownerOrgId: string | null }): Promise<boolean> {
  if (owner.ownerUserId) return owner.ownerUserId === userId;
  if (owner.ownerOrgId) return can(userId, owner.ownerOrgId, 'send_catalog');
  return false;
}

interface SourceSnapshot {
  ownerUserId: string | null;
  ownerOrgId: string | null;
  title: string;
  bytes: number;
  values: Partial<typeof schema.catalogItemVersions.$inferInsert>;
}

/** A layout's picture as the editor sends it with a share: PNG or WebP, re-encoded; null when absent, false when bad. */
async function readThumbnail(raw: unknown): Promise<Buffer | null | false> {
  if (raw === undefined || raw === null) return null;
  const t = raw as { mime?: unknown; data?: unknown };
  if ((t.mime !== 'image/png' && t.mime !== 'image/webp') || typeof t.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(t.data)) return false;
  const bytes = Buffer.from(t.data, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_THUMBNAIL_BYTES || sniffCover(bytes) !== t.mime) return false;
  return (await reencode(bytes)) ?? false;
}

/** What gets shared: a copy of the module, custom part, layout or venue as it is now. */
async function snapshotSource(kind: Kind, sourceId: string, thumbnail: Buffer | null = null): Promise<SourceSnapshot | null> {
  if (kind === 'layout') {
    const l = await db.select().from(schema.layouts).where(eq(schema.layouts.id, sourceId)).get();
    if (!l) return null;
    const pub = publishLayoutDoc(await currentDocBytes(l.id, l.docSnapshot as Uint8Array), (l.sidecarSnapshot as Uint8Array | null) ?? null);
    if (!pub) return null;
    return {
      ownerUserId: l.ownerUserId,
      ownerOrgId: l.ownerOrgId,
      title: l.title,
      bytes: pub.doc.length + (thumbnail?.length ?? 0),
      values: { docSnapshot: pub.doc, thumbnail, thumbnailMime: thumbnail ? 'image/webp' : null, summary: JSON.stringify(pub.summary) },
    };
  }
  if (kind === 'venue') {
    const r = await db.select().from(schema.venueLibrary).where(eq(schema.venueLibrary.id, sourceId)).get();
    if (!r) return null;
    let venue: Venue;
    try {
      venue = publicVenue(JSON.parse(r.data) as Venue);
    } catch {
      return null;
    }
    const doc = Buffer.from(JSON.stringify(venue), 'utf8');
    const pic = await venuePicture(venue);
    return {
      ownerUserId: r.ownerUserId,
      ownerOrgId: r.ownerOrgId,
      title: r.name,
      bytes: doc.length + (pic?.length ?? 0),
      values: { docSnapshot: doc, thumbnail: pic, thumbnailMime: pic ? 'image/webp' : null, summary: JSON.stringify(venueSummary(venue)) },
    };
  }
  if (kind === 'module') {
    const m = await db.select().from(schema.modules).where(eq(schema.modules.id, sourceId)).get();
    if (!m) return null;
    const doc = Buffer.from(m.docSnapshot as Uint8Array);
    const thumb = m.thumbnail ? Buffer.from(m.thumbnail as Uint8Array) : null;
    return {
      ownerUserId: m.ownerUserId,
      ownerOrgId: m.ownerOrgId,
      title: m.title,
      bytes: doc.length + (thumb?.length ?? 0),
      values: { docSnapshot: doc, thumbnail: thumb, thumbnailMime: thumb ? m.thumbnailMime : null },
    };
  }
  const p = await db.select().from(schema.customParts).where(eq(schema.customParts.id, sourceId)).get();
  if (!p || p.isGlobal) return null;
  // Never publish a path left by an older desktop's upload.
  const xml = stripImportSource(Buffer.from(p.xmlBlob as Uint8Array));
  const sprite = Buffer.from(p.spriteBlob as Uint8Array);
  return {
    ownerUserId: p.ownerUserId,
    ownerOrgId: p.ownerOrgId,
    title: p.displayName,
    bytes: xml.length + sprite.length,
    values: { partNumber: p.partNumber, category: p.category, xmlBlob: xml, spriteBlob: sprite, spriteMime: p.spriteMime },
  };
}

/**
 * Who shared it, for the catalog: the person's name, or for a club's
 * item, its author and the club ("Sam · in ArkLUG"). The author is the
 * catalog item's source module or part's author, read through the same
 * rules as every other credit (routes/credits.ts): a deleted account
 * reads "Builder #…", someone who left the club "a former member".
 */
export async function ownerNames(
  items: readonly { ownerUserId: string | null; ownerOrgId: string | null; kind?: Kind; sourceId?: string }[],
) {
  const userIds = [...new Set(items.map((i) => i.ownerUserId).filter((x): x is string => !!x))];
  const orgIds = [...new Set(items.map((i) => i.ownerOrgId).filter((x): x is string => !!x))];
  const users = userIds.length
    ? await db.select({ id: schema.users.id, name: schema.users.displayName }).from(schema.users).where(inArray(schema.users.id, userIds))
    : [];
  const orgs = orgIds.length
    ? await db.select({ id: schema.orgs.id, name: schema.orgs.name }).from(schema.orgs).where(inArray(schema.orgs.id, orgIds))
    : [];
  const u = new Map(users.map((x) => [x.id, publicName(x.id, x.name)]));
  const o = new Map(orgs.map((x) => [x.id, x.name]));
  // A club's items: who made the module or part it was shared from.
  const authorBy = new Map<string, string>();
  for (const kind of CATALOG_KINDS) {
    const club = items.filter((i) => i.ownerOrgId && i.kind === kind && i.sourceId);
    if (!club.length) continue;
    const credits = await creditLookup(
      kind === 'part' ? 'custom-part' : kind,
      club.map((i) => i.sourceId!),
      '',
    );
    for (const i of club) {
      const by = credits(i.sourceId!)?.by;
      if (by) authorBy.set(`${kind}:${i.sourceId}`, by);
    }
  }
  return (i: { ownerUserId: string | null; ownerOrgId: string | null; kind?: Kind; sourceId?: string }) => {
    if (!i.ownerOrgId) return u.get(i.ownerUserId ?? '') ?? 'Someone';
    const club = o.get(i.ownerOrgId) ?? 'A club';
    const author = i.kind && i.sourceId ? authorBy.get(`${i.kind}:${i.sourceId}`) : undefined;
    return author ? `${author} · in ${club}` : club;
  };
}

/** An item a site moderator took down (or one taken down before who did was kept), in SQL. */
export const siteHeldItem = sql`(coalesce(${schema.catalogItems.takenDownBy}, CASE WHEN ${schema.catalogItems.status} = 'unpublished' THEN 'site' END, '') = 'site')`;

/**
 * A waiting version's text, as the queue shows it: what was sent with it,
 * and (for an update whose text changes) what the public sees now.
 */
export function sentText(r: {
  title: string;
  description: string;
  tags: string;
  sentTitle: string | null;
  sentDescription: string | null;
  sentTags: string | null;
  publicVersion: number;
}) {
  const proposed = { title: r.sentTitle ?? r.title, description: r.sentDescription ?? r.description, tags: parseTags(r.sentTags ?? r.tags) };
  const current = { title: r.title, description: r.description, tags: parseTags(r.tags) };
  const changed = proposed.title !== current.title || proposed.description !== current.description || proposed.tags.join(',') !== current.tags.join(',');
  return { ...proposed, /** What's public now, when this update changes the text. */ current: r.publicVersion > 0 && changed ? current : null };
}

function parseTags(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The versions among `pairs` that have a picture (a module's, layout's or
 * venue's thumbnail, a part's sprite), as `<itemId>:<version>`. Lists give
 * a preview address only for these: asking for a picture that isn't there
 * is a 404, and a page of them is a burst a firewall bans (README,
 * "Operations: the 4xx profile").
 */
export async function picturedVersions(pairs: readonly { id: string; version: number }[]): Promise<Set<string>> {
  const out = new Set<string>();
  const ids = [...new Set(pairs.filter((p) => p.version > 0).map((p) => p.id))];
  const v = schema.catalogItemVersions;
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db
      .select({ itemId: v.itemId, version: v.version })
      .from(v)
      .where(and(inArray(v.itemId, ids.slice(i, i + 500)), or(isNotNull(v.thumbnail), isNotNull(v.spriteBlob))));
    for (const r of rows) out.add(`${r.itemId}:${r.version}`);
  }
  return out;
}

/** A version's picture address, or '' when it has none (the card draws a blank). */
export function previewUrlOf(itemId: string, version: number, pictured: ReadonlySet<string>): string {
  return pictured.has(`${itemId}:${version}`) ? `/api/catalog/items/${itemId}/preview?v=${version}` : '';
}

/** `pictured`: from picturedVersions, for the items' public versions. */
export function itemOut(i: typeof schema.catalogItems.$inferSelect, by: string, pictured: ReadonlySet<string>) {
  const preview = previewUrlOf(i.id, i.publicVersion, pictured);
  return {
    id: i.id,
    kind: i.kind,
    title: i.title,
    description: i.description,
    tags: parseTags(i.tags),
    by,
    uses: i.uses,
    version: i.publicVersion,
    updatedAt: i.updatedAt.getTime(),
    previewUrl: preview,
    /** The card's picture: one its owner uploaded (cropped to the card), else the drawn one ('' for none). */
    coverUrl: i.coverImageId ? itemCoverUrl(i.id, i.coverImageId) : preview,
    customCover: !!i.coverImageId,
  };
}

/** Anyone may browse when the setting allows; otherwise only people signed in. */
export async function mayBrowse(req: FastifyRequest): Promise<boolean> {
  if (req.user) return true;
  return (await getPlatformSettings()).catalogAnonymousBrowse;
}

type CopyResult = { ok: true; id: string; version: number } | { ok: false; code: number; body: unknown };

/**
 * Copy a public catalog item's public version to `user`, or to the club
 * `orgId`, and count a use. The caller checked the item is public and the
 * destination is one the user may add to.
 */
export async function copyItemTo(user: User, item: typeof schema.catalogItems.$inferSelect, orgId: string | null): Promise<CopyResult> {
  const v = await db
    .select()
    .from(schema.catalogItemVersions)
    .where(and(eq(schema.catalogItemVersions.itemId, item.id), eq(schema.catalogItemVersions.version, item.publicVersion)))
    .get();
  if (!v) return { ok: false, code: 404, body: { error: 'not_found' } };
  const dest = { orgId };
  const owner: Subject = dest.orgId ? { kind: 'org', id: dest.orgId } : { kind: 'user', id: user.id };
  const now = new Date();
  const id = randomUUID();
  if (item.kind === 'layout') {
    const doc = publishedDoc(v.docSnapshot as Uint8Array);
    const refusal = await checkGrowth({ actor: user, owner, add: { layouts: 1, bytes: doc.length } });
    if (refusal) return { ok: false, code: refusal.status, body: refusal.body };
    await db.insert(schema.layouts).values({
      id,
      title: item.title,
      ownerUserId: dest.orgId ? null : user.id,
      ownerOrgId: dest.orgId,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
      docSnapshot: doc,
      docVersion: 0,
      sidecarSnapshot: null,
      copiedFromId: item.sourceId,
    });
  } else if (item.kind === 'venue') {
    const data = Buffer.from(v.docSnapshot as Uint8Array).toString('utf8');
    const refusal = await checkGrowth({ actor: user, owner, add: { bytes: data.length } });
    if (refusal) return { ok: false, code: refusal.status, body: refusal.body };
    await db.insert(schema.venueLibrary).values({
      id,
      ownerUserId: dest.orgId ? null : user.id,
      ownerOrgId: dest.orgId,
      name: item.title,
      data,
      createdBy: user.id,
      copiedFromId: item.sourceId,
      createdAt: now,
    });
  } else if (item.kind === 'module') {
    const doc = Buffer.from(v.docSnapshot as Uint8Array);
    const thumb = v.thumbnail ? Buffer.from(v.thumbnail as Uint8Array) : null;
    const refusal = await checkGrowth({ actor: user, owner, add: { bytes: doc.length + (thumb?.length ?? 0) } });
    if (refusal) return { ok: false, code: refusal.status, body: refusal.body };
    await db.insert(schema.modules).values({
      id,
      title: item.title,
      ownerUserId: dest.orgId ? null : user.id,
      ownerOrgId: dest.orgId,
      createdBy: user.id,
      docSnapshot: doc,
      docVersion: 0,
      sidecarSnapshot: null,
      thumbnail: thumb,
      thumbnailMime: thumb ? (v.thumbnailMime as 'image/png' | 'image/webp') : null,
      thumbnailAt: thumb ? now : null,
      copiedFromId: item.sourceId,
      createdAt: now,
      updatedAt: now,
    });
    await recordVersion(id, doc, user.id, `From the catalog (version ${v.version})`, thumb, thumb ? (v.thumbnailMime as 'image/png' | 'image/webp') : null);
  } else {
    const partNumber = v.partNumber ?? '';
    const taken = await db
      .select({ id: schema.customParts.id })
      .from(schema.customParts)
      .where(
        and(
          eq(schema.customParts.partNumber, partNumber),
          dest.orgId ? eq(schema.customParts.ownerOrgId, dest.orgId) : eq(schema.customParts.ownerUserId, user.id),
        ),
      )
      .get();
    if (taken) return { ok: false, code: 409, body: { error: 'part_number_taken' } };
    const xml = stripImportSource(Buffer.from(v.xmlBlob as Uint8Array));
    const sprite = Buffer.from(v.spriteBlob as Uint8Array);
    const refusal = await checkGrowth({ actor: user, owner, add: { customParts: 1, bytes: xml.length + sprite.length } });
    if (refusal) return { ok: false, code: refusal.status, body: refusal.body };
    await db.insert(schema.customParts).values({
      id,
      partNumber,
      displayName: item.title,
      category: v.category ?? 'Custom',
      ownerUserId: dest.orgId ? null : user.id,
      ownerOrgId: dest.orgId,
      createdBy: user.id,
      xmlBlob: xml,
      spriteBlob: sprite,
      spriteMime: (v.spriteMime ?? 'image/png') as 'image/gif' | 'image/png',
      copiedFromId: item.sourceId,
      createdAt: now,
      updatedAt: now,
    });
  }
  await db.insert(schema.catalogCopies).values({ itemId: item.id, copyId: id, version: v.version, userId: user.id, createdAt: now });
  await db.update(schema.catalogItems).set({ uses: sql`${schema.catalogItems.uses} + 1` }).where(eq(schema.catalogItems.id, item.id));
  await writeAuditEvent({
    resourceKind: 'catalog_item',
    resourceId: item.id,
    userId: user.id,
    eventType: 'catalog_add',
    payload: { copyId: id, version: v.version, owner },
  });
  return { ok: true, id, version: v.version };
}

/**
 * Share a module or custom part to the catalog (or a new version of one
 * already there): the share route, and a module going into a public
 * collection. The caller must manage the thing.
 */
export async function submitToCatalog(
  user: User,
  kind: Kind,
  sourceId: string,
  b: { title?: unknown; description?: unknown; tags?: unknown; note?: unknown; thumbnail?: unknown },
): Promise<{ ok: boolean; code: number; body: unknown }> {
  const fail = (code: number, body: unknown) => ({ ok: false, code, body });
  if (isDemoUser(user)) return fail(403, { error: 'demo_account_cannot_submit' });
  if (!(await catalogOn(kind))) return fail(404, { error: 'catalog_off' });
  // A layout's picture comes with it (the editor draws it); the others have their own.
  const thumbnail = kind === 'layout' ? await readThumbnail(b.thumbnail) : null;
  if (thumbnail === false) return fail(400, { error: 'invalid_thumbnail' });
  const src = await snapshotSource(kind, sourceId, thumbnail);
  if (!src) return fail(404, { error: 'not_found' });
  // A club's things: "send to the catalog" shares them; in a trusted club,
  // every member may too (for the club's own review).
  const role = src.ownerOrgId ? await clubRole(user.id, src.ownerOrgId) : null;
  const trusted = await isTrustedClub(src.ownerOrgId);
  const sends = !!src.ownerOrgId && !!role && (await can(user.id, src.ownerOrgId, 'send_catalog'));
  const mayShare = src.ownerOrgId ? sends || (trusted && !!role) : src.ownerUserId === user.id;
  if (!mayShare) return fail(403, { error: 'forbidden', permission: 'send_catalog' });
  const title = cleanText(b.title ?? src.title, MAX_TITLE);
  const description = cleanText(b.description, MAX_DESCRIPTION);
  const note = cleanText(b.note, MAX_REASON);
  const tags = cleanTags(b.tags);
  if (!title || description === undefined || note === undefined || !tags) return fail(400, { error: 'invalid_input' });
  const owner: Subject = src.ownerOrgId ? { kind: 'org', id: src.ownerOrgId } : { kind: 'user', id: src.ownerUserId ?? user.id };
  const refusal = await checkGrowth({ actor: user, owner, add: { bytes: src.bytes }, uploadBytes: src.bytes });
  if (refusal) return fail(refusal.status, refusal.body);

  const review = (await getPlatformSettings()).catalogReview;
  const now = new Date();
  // An item already shared from this source by the same owner gets a new
  // version; one the source's earlier owner shared stays theirs.
  let item = await db
    .select()
    .from(schema.catalogItems)
    .where(
      and(
        eq(schema.catalogItems.kind, kind),
        eq(schema.catalogItems.sourceId, sourceId),
        src.ownerOrgId ? eq(schema.catalogItems.ownerOrgId, src.ownerOrgId) : and(eq(schema.catalogItems.ownerUserId, src.ownerUserId ?? ''), isNull(schema.catalogItems.ownerOrgId)),
      ),
    )
    .get();
  if (!item) {
    const id = randomUUID();
    await db.insert(schema.catalogItems).values({
      id,
      kind: kind,
      sourceId: sourceId,
      ownerUserId: src.ownerUserId,
      ownerOrgId: src.ownerOrgId,
      title,
      description: description ?? '',
      tags: JSON.stringify(tags),
      status: 'in_review',
      createdAt: now,
      updatedAt: now,
    });
    item = (await db.select().from(schema.catalogItems).where(eq(schema.catalogItems.id, id)).get())!;
  }
  const last = await db
    .select({ v: sql<number>`coalesce(max(${schema.catalogItemVersions.version}), 0)`.mapWith(Number) })
    .from(schema.catalogItemVersions)
    .where(eq(schema.catalogItemVersions.itemId, item.id))
    .get();
  const version = (last?.v ?? 0) + 1;
  // Review off, or a trusted club's admin or manager: public at once. An
  // item a moderator took down only comes back through review: a site
  // moderator's takedown through the site's, a club's through the club's
  // own (its admins and managers bring it back) or the site's.
  const hold = holdOf(item);
  const clubReviewer = trusted && sends;
  const straight = hold === 'site' ? false : hold === 'club' ? clubReviewer : review === 'none' || clubReviewer;
  // An update without a new description or tags keeps the ones it has.
  const text = {
    title,
    description: b.description === undefined ? item.description : (description ?? ''),
    tags: b.tags === undefined ? item.tags : JSON.stringify(tags),
  };
  await db.insert(schema.catalogItemVersions).values({
    id: randomUUID(),
    itemId: item.id,
    version,
    status: straight ? 'public' : 'in_review',
    submittedBy: user.id,
    note,
    createdAt: now,
    ...src.values,
    // The text goes with the version: the item's own (what the public sees)
    // changes when this version is approved.
    ...text,
  });
  // Earlier versions still waiting are replaced by this one.
  await db
    .update(schema.catalogItemVersions)
    .set({ status: 'declined', reason: 'Replaced by a newer submission', decidedAt: now })
    .where(
      and(
        eq(schema.catalogItemVersions.itemId, item.id),
        eq(schema.catalogItemVersions.status, 'in_review'),
        sql`${schema.catalogItemVersions.version} < ${version}`,
      ),
    );
  const live = item.status === 'public' && item.publicVersion > 0;
  await db
    .update(schema.catalogItems)
    .set({
      // Straight away, or nothing approved yet: the text is the item's now.
      // Otherwise the approved text stays until this version is approved.
      ...(straight || item.publicVersion === 0 ? text : {}),
      // Straight away: this version is public now. In review: a public
      // item stays public (on its old version) while the update waits.
      status: straight || live ? 'public' : 'in_review',
      publicVersion: straight ? version : item.publicVersion,
      // A takedown brought back stays back; one waiting for review is kept.
      takenDownBy: straight ? null : hold,
      reason: null,
      updatedAt: now,
    })
    .where(eq(schema.catalogItems.id, item.id));
  await writeAuditEvent({
    resourceKind: 'catalog_item',
    resourceId: item.id,
    userId: user.id,
    eventType: 'catalog_submit',
    payload: { kind, sourceId, version, title, straight, ...(trusted ? { clubReview: !straight } : {}) },
  });
  return { ok: true, code: 201, body: { id: item.id, version, status: straight ? 'public' : 'in_review' } };
}

/**
 * Approve or decline a waiting version: site moderators (any), or a trusted
 * club's admins and managers (`clubId`: only the club's own items).
 */
export async function decideVersion(user: User, versionId: string, approve: boolean, rawReason: unknown, clubId: string | null = null) {
  const v = await db.select().from(schema.catalogItemVersions).where(eq(schema.catalogItemVersions.id, versionId)).get();
  if (!v || v.status !== 'in_review') return { code: 404 as const, body: { error: 'not_found' } };
  const reason = cleanText(rawReason, MAX_REASON);
  if (reason === undefined) return { code: 400 as const, body: { error: 'invalid_input' } };
  const item = (await db.select().from(schema.catalogItems).where(eq(schema.catalogItems.id, v.itemId)).get())!;
  // A club decides its own items, except one a site moderator took down.
  if (clubId && (item.ownerOrgId !== clubId || holdOf(item) === 'site')) return { code: 404 as const, body: { error: 'not_found' } };
  const now = new Date();
  await db
    .update(schema.catalogItemVersions)
    .set({ status: approve ? 'public' : 'declined', reason, decidedBy: user.id, decidedAt: now })
    .where(eq(schema.catalogItemVersions.id, v.id));
  if (approve) {
    await db
      .update(schema.catalogItems)
      .set({
        status: 'public',
        publicVersion: v.version,
        // The text sent with this version becomes the public text.
        ...(v.title !== null ? { title: v.title } : {}),
        ...(v.description !== null ? { description: v.description } : {}),
        ...(v.tags !== null ? { tags: v.tags } : {}),
        takenDownBy: null,
        reason: null,
        updatedAt: now,
      })
      .where(eq(schema.catalogItems.id, item.id));
  } else if (item.publicVersion === 0) {
    // A first submission declined: the item says why. (A declined update
    // leaves the public version as it is.)
    await db.update(schema.catalogItems).set({ status: 'declined', reason, updatedAt: now }).where(eq(schema.catalogItems.id, item.id));
  } else if (item.status === 'in_review') {
    // Asked to come back after a takedown (or a withdrawal), and declined:
    // it stays out of the catalog.
    await db
      .update(schema.catalogItems)
      .set({ status: holdOf(item) ? 'unpublished' : 'declined', reason, updatedAt: now })
      .where(eq(schema.catalogItems.id, item.id));
  }
  await writeAuditEvent({
    resourceKind: 'catalog_item',
    resourceId: item.id,
    userId: user.id,
    eventType: approve ? 'catalog_approve' : 'catalog_decline',
    payload: { version: v.version, reason, ...(clubId ? { byClub: clubId } : {}) },
  });
  return { code: 200 as const, body: { ok: true } };
}

/** Take an item out of the catalog at once: a site moderator, or (`clubId`) a trusted club's admin or manager. */
export async function unpublishItem(user: User, itemId: string, rawReason: unknown, clubId: string | null = null) {
  const reason = cleanText(rawReason, MAX_REASON);
  if (reason === undefined) return { code: 400, body: { error: 'invalid_input' } };
  const item = await db.select().from(schema.catalogItems).where(eq(schema.catalogItems.id, itemId)).get();
  if (!item || (clubId && item.ownerOrgId !== clubId)) return { code: 404, body: { error: 'not_found' } };
  // A site moderator's takedown only a site moderator undoes; a club's,
  // the club's reviewers (or a site moderator).
  await db
    .update(schema.catalogItems)
    .set({ status: 'unpublished', takenDownBy: nextHold(holdOf(item), clubId), reason, updatedAt: new Date() })
    .where(eq(schema.catalogItems.id, item.id));
  await writeAuditEvent({ resourceKind: 'catalog_item', resourceId: item.id, userId: user.id, eventType: 'catalog_unpublish', payload: { reason, ...(clubId ? { byClub: clubId } : {}) } });
  await dropFromCollections(item, clubId ? 'unpublished by the club' : 'unpublished by a moderator', user.id);
  return { code: 200, body: { ok: true } };
}

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  // ---- what's on (no sign-in needed) --------------------------------------
  app.get('/api/catalog/settings', { config: TOKEN_READ }, async (req) => {
    const s = await getPlatformSettings();
    return {
      modules: s.moduleCatalogEnabled,
      parts: s.partsCatalogEnabled,
      layouts: s.layoutCatalogEnabled,
      venues: s.venueCatalogEnabled,
      review: s.catalogReview,
      anonymousBrowse: s.catalogAnonymousBrowse,
      canModerate: canModerate(req.user),
      /** The biggest picture a curator can upload as a collection's cover. */
      coverMaxBytes: (await coverMaxBytes()).value,
    };
  });

  // ---- browse --------------------------------------------------------------
  // `kind=all` lists every catalog that's on (the Catalog page's search
  // and tags). `limit` and `offset` page through it; `nextOffset` is where
  // the next page starts, null at the end. Without `limit`: the first 200,
  // as before (the desktop app's lists).
  app.get<{ Querystring: { kind?: string; q?: string; tag?: string; sort?: string; limit?: string; offset?: string } }>(
    '/api/catalog/items',
    { config: TOKEN_READ },
    async (req, reply) => {
      const kind = req.query.kind ?? 'module';
      let kinds: Kind[];
      if (kind === 'all') {
        kinds = [];
        for (const k of CATALOG_KINDS) if (await catalogOn(k)) kinds.push(k);
        if (!kinds.length) return reply.code(404).send({ error: 'catalog_off' });
      } else {
        if (!isKind(kind) || !(await catalogOn(kind))) return reply.code(404).send({ error: 'catalog_off' });
        kinds = [kind];
      }
      if (!(await mayBrowse(req))) return reply.code(401).send({ error: 'unauthorized' });
      const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query.limit)) || 200));
      const offset = Math.min(1_000_000, Math.max(0, Math.floor(Number(req.query.offset)) || 0));
      const q = (req.query.q ?? '').trim().toLowerCase().slice(0, 80);
      const tag = (req.query.tag ?? '').trim().toLowerCase().slice(0, MAX_TAG);
      const conds = [inArray(schema.catalogItems.kind, kinds), eq(schema.catalogItems.status, 'public'), sql`${schema.catalogItems.publicVersion} > 0`];
      if (q) {
        const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        conds.push(
          or(
            sql`lower(${schema.catalogItems.title}) LIKE ${like} ESCAPE '\\'`,
            sql`lower(${schema.catalogItems.description}) LIKE ${like} ESCAPE '\\'`,
            sql`lower(${schema.catalogItems.tags}) LIKE ${like} ESCAPE '\\'`,
          )!,
        );
      }
      if (tag) conds.push(sql`EXISTS (SELECT 1 FROM json_each(${schema.catalogItems.tags}) WHERE value = ${tag})`);
      const rows = await db
        .select()
        .from(schema.catalogItems)
        .where(and(...conds))
        .orderBy(
          ...(req.query.sort === 'popular' ? [desc(schema.catalogItems.uses)] : []),
          desc(schema.catalogItems.updatedAt),
          desc(schema.catalogItems.id),
        )
        .limit(limit + 1)
        .offset(offset);
      const more = rows.length > limit;
      if (more) rows.length = limit;
      const name = await ownerNames(rows);
      const trusted = await trustedClubs(rows.map((r) => r.ownerOrgId));
      const sums = await catalogSummaries(rows);
      const pictured = await picturedVersions(rows.map((r) => ({ id: r.id, version: r.publicVersion })));
      return {
        items: rows.map((r) => ({ ...itemOut(r, name(r), pictured), trustedClub: !!r.ownerOrgId && trusted.has(r.ownerOrgId), summary: sums.get(r.id) ?? null })),
        nextOffset: more ? offset + limit : null,
      };
    },
  );

  app.get<{ Params: { id: string } }>('/api/catalog/items/:id', { config: TOKEN_READ }, async (req, reply) => {
    const item = await db.select().from(schema.catalogItems).where(eq(schema.catalogItems.id, req.params.id)).get();
    if (!item || !(await catalogOn(item.kind))) return reply.code(404).send({ error: 'not_found' });
    const mine = req.user ? (await manages(req.user.id, item)) || canModerate(req.user) : false;
    if (!mine && (item.status !== 'public' || item.publicVersion === 0)) return reply.code(404).send({ error: 'not_found' });
    if (!(await mayBrowse(req))) return reply.code(401).send({ error: 'unauthorized' });
    const versions = await db
      .select({
        version: schema.catalogItemVersions.version,
        status: schema.catalogItemVersions.status,
        note: schema.catalogItemVersions.note,
        reason: schema.catalogItemVersions.reason,
        createdAt: schema.catalogItemVersions.createdAt,
      })
      .from(schema.catalogItemVersions)
      .where(eq(schema.catalogItemVersions.itemId, item.id))
      .orderBy(desc(schema.catalogItemVersions.version));
    const name = await ownerNames([item]);
    const club = item.ownerOrgId ? await db.select({ slug: schema.orgs.slug, name: schema.orgs.name }).from(schema.orgs).where(eq(schema.orgs.id, item.ownerOrgId)).get() : null;
    const pictured = await picturedVersions([{ id: item.id, version: item.publicVersion }]);
    return {
      item: {
        ...itemOut(item, name(item), pictured),
        status: item.status,
        reason: mine ? item.reason : null,
        trustedClub: await isTrustedClub(item.ownerOrgId),
        summary: (await catalogSummaries([item])).get(item.id) ?? null,
        /** The club it's shared under, for "in ‹club›" with a link. */
        club: club ? { slug: club.slug, name: club.name } : null,
        /** The full-size picture (the public page). */
        coverLargeUrl: item.coverImageId ? itemCoverUrl(item.id, item.coverImageId, false) : previewUrlOf(item.id, item.publicVersion, pictured),
      },
      versions: versions
        .filter((v) => mine || v.status === 'public')
        .map((v) => ({ ...v, reason: mine ? v.reason : null, createdAt: v.createdAt.getTime() })),
    };
  });

  // A version's picture: a module's thumbnail, or a part's sprite.
  app.get<{ Params: { id: string }; Querystring: { v?: string } }>('/api/catalog/items/:id/preview', { config: TOKEN_READ }, async (req, reply) => {
    const item = await db.select().from(schema.catalogItems).where(eq(schema.catalogItems.id, req.params.id)).get();
    if (!item) return reply.code(404).send({ error: 'not_found' });
    const n = req.query.v ? Number(req.query.v) : item.publicVersion;
    const mine = req.user ? (await manages(req.user.id, item)) || canModerate(req.user) : false;
    // Its owners and the moderators see it with that catalog off too (their
    // lists still show it: a picture they can't load would only be a 404).
    const isPublic = item.status === 'public' && n === item.publicVersion && n > 0 && (await catalogOn(item.kind));
    if (!isPublic && !mine) return reply.code(404).send({ error: 'not_found' });
    if (!(await mayBrowse(req))) return reply.code(401).send({ error: 'unauthorized' });
    const v = await db
      .select()
      .from(schema.catalogItemVersions)
      .where(and(eq(schema.catalogItemVersions.itemId, item.id), eq(schema.catalogItemVersions.version, n)))
      .get();
    const bytes = item.kind === 'part' ? v?.spriteBlob : v?.thumbnail;
    const mime = item.kind === 'part' ? v?.spriteMime : v?.thumbnailMime;
    if (!bytes || !mime) return reply.code(404).send({ error: 'no_preview' });
    reply.header('Cache-Control', 'public, max-age=86400');
    reply.header('Content-Type', mime);
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(Buffer.from(bytes as Uint8Array));
  });

  // ---- share (submit, or submit an update) --------------------------------
  app.post<{
    Body: { kind?: unknown; sourceId?: unknown; title?: unknown; description?: unknown; tags?: unknown; note?: unknown; thumbnail?: unknown };
  }>(
    '/api/catalog/submissions',
    // codeql[js/missing-rate-limiting] - rate limited via Fastify config.rateLimit
    // Ten shares an hour per person (counted after sign-in is read), not per
    // address: a whole club sharing from one venue's network isn't one person.
    // A layout brings its picture (base64 JSON), hence the bigger body.
    // The desktop app shares too (its "Share to the catalog…"), with layouts:write or parts:write.
    { bodyLimit: THUMBNAIL_BODY_LIMIT, config: { rateLimit: perPerson(10, '1 hour'), apiToken: TOKEN_ADD } },
    async (req, reply) => {
      const user = requireUser(req);
      const b = req.body ?? {};
      if (!isKind(b.kind) || typeof b.sourceId !== 'string') return reply.code(400).send({ error: 'invalid_input' });
      const r = await submitToCatalog(user, b.kind, b.sourceId, b);
      return reply.code(r.code).send(r.body);
    },
  );

  // The caller's shared items (their own, and their clubs'), for the status badges.
  app.get('/api/catalog/mine', { config: TOKEN_READ }, async (req) => {
    const user = requireUser(req);
    const clubs = await db
      .select({ orgId: schema.orgMembers.orgId })
      .from(schema.orgMembers)
      .where(eq(schema.orgMembers.userId, user.id));
    const orgIds = clubs.map((c) => c.orgId);
    const rows = await db
      .select()
      .from(schema.catalogItems)
      .where(
        orgIds.length
          ? or(eq(schema.catalogItems.ownerUserId, user.id), inArray(schema.catalogItems.ownerOrgId, orgIds))
          : eq(schema.catalogItems.ownerUserId, user.id),
      );
    const ids = rows.map((r) => r.id);
    const pending = ids.length
      ? await db
          .select({
            itemId: schema.catalogItemVersions.itemId,
            version: schema.catalogItemVersions.version,
            title: schema.catalogItemVersions.title,
            description: schema.catalogItemVersions.description,
            tags: schema.catalogItemVersions.tags,
          })
          .from(schema.catalogItemVersions)
          .where(and(inArray(schema.catalogItemVersions.itemId, ids), eq(schema.catalogItemVersions.status, 'in_review')))
      : [];
    const waiting = new Map(pending.map((p) => [p.itemId, p.version]));
    const waitingText = new Map(pending.map((p) => [p.itemId, p]));
    const inCollections = await collectionCounts(ids);
    // The drawn picture: the public version's, else the one waiting.
    const drawnVersion = (r: (typeof rows)[number]) => r.publicVersion || (waiting.get(r.id) ?? 0);
    const pictured = await picturedVersions(rows.map((r) => ({ id: r.id, version: drawnVersion(r) })));
    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        sourceId: r.sourceId,
        title: r.title,
        status: r.status,
        reason: r.reason,
        version: r.publicVersion,
        pendingVersion: waiting.get(r.id) ?? null,
        /** The text sent with the version waiting, shown to the public once it's approved. */
        pendingText: (() => {
          const p = waitingText.get(r.id);
          return p ? { title: p.title ?? r.title, description: p.description ?? r.description, tags: parseTags(p.tags ?? r.tags) } : null;
        })(),
        /** Its drawn picture (the public version's, else the one waiting); '' when it has none. */
        drawnUrl: previewUrlOf(r.id, drawnVersion(r), pictured),
        /** How many public collections it's in. */
        collections: inCollections.get(r.id) ?? 0,
        /** Its uploaded picture, one waiting for review, and why the last was declined. */
        ...coverState(r),
      })),
    };
  });

  app.post<{ Params: { id: string } }>('/api/catalog/items/:id/withdraw', async (req, reply) => {
    const user = requireUser(req);
    const item = await db.select().from(schema.catalogItems).where(eq(schema.catalogItems.id, req.params.id)).get();
    if (!item) return reply.code(404).send({ error: 'not_found' });
    if (!(await manages(user.id, item))) return reply.code(403).send({ error: 'forbidden' });
    const now = new Date();
    // A takedown is remembered through a withdrawal.
    await db.update(schema.catalogItems).set({ status: 'withdrawn', takenDownBy: holdOf(item), updatedAt: now }).where(eq(schema.catalogItems.id, item.id));
    await db
      .update(schema.catalogItemVersions)
      .set({ status: 'declined', reason: 'Withdrawn', decidedAt: now })
      .where(and(eq(schema.catalogItemVersions.itemId, item.id), eq(schema.catalogItemVersions.status, 'in_review')));
    await writeAuditEvent({ resourceKind: 'catalog_item', resourceId: item.id, userId: user.id, eventType: 'catalog_withdraw', payload: {} });
    await dropFromCollections(item, 'withdrawn by its owner', user.id);
    return { ok: true };
  });

  // ---- add to my modules / my parts ---------------------------------------
  app.post<{ Params: { id: string }; Body: { orgSlug?: unknown } }>(
    '/api/catalog/items/:id/add',
    // codeql[js/missing-rate-limiting] - rate limited via Fastify config.rateLimit
    { config: { rateLimit: perPerson(60, '1 minute'), apiToken: TOKEN_ADD } },
    async (req, reply) => {
      const user = requireUser(req);
      const item = await db.select().from(schema.catalogItems).where(eq(schema.catalogItems.id, req.params.id)).get();
      if (!item || item.status !== 'public' || item.publicVersion === 0 || !(await catalogOn(item.kind))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const dest = await destinationOrg(user.id, req.body?.orgSlug, addPermission(item.kind === 'part' ? 'custom_part' : item.kind));
      if (!dest.ok) return reply.code(dest.code).send({ error: dest.error, permission: dest.permission });
      const r = await copyItemTo(user, item, dest.orgId);
      if (!r.ok) return reply.code(r.code).send(r.body);
      return reply.code(201).send({ kind: item.kind, id: r.id, version: r.version });
    },
  );

  // The caller's copies with a newer public version ("Update available").
  app.get('/api/catalog/copies', { config: TOKEN_READ }, async (req) => {
    const user = requireUser(req);
    const rows = await db
      .select({
        copyId: schema.catalogCopies.copyId,
        version: schema.catalogCopies.version,
        itemId: schema.catalogItems.id,
        kind: schema.catalogItems.kind,
        publicVersion: schema.catalogItems.publicVersion,
        status: schema.catalogItems.status,
      })
      .from(schema.catalogCopies)
      .innerJoin(schema.catalogItems, eq(schema.catalogItems.id, schema.catalogCopies.itemId))
      .where(eq(schema.catalogCopies.userId, user.id));
    return {
      copies: rows.map((r) => ({
        copyId: r.copyId,
        itemId: r.itemId,
        kind: r.kind,
        version: r.version,
        latest: r.publicVersion,
        // Layouts and venues are copies to change freely: no "Get the new version".
        updateAvailable: (r.kind === 'module' || r.kind === 'part') && r.status === 'public' && r.publicVersion > r.version,
      })),
    };
  });

  // "Get the new version": the copy's contents become the public version.
  // Never automatic; the copy keeps its name, owner and history.
  app.post<{ Params: { copyId: string } }>('/api/catalog/copies/:copyId/update', async (req, reply) => {
    const user = requireUser(req);
    const copy = await db.select().from(schema.catalogCopies).where(eq(schema.catalogCopies.copyId, req.params.copyId)).get();
    if (!copy) return reply.code(404).send({ error: 'not_found' });
    const item = await db.select().from(schema.catalogItems).where(eq(schema.catalogItems.id, copy.itemId)).get();
    if (!item || item.status !== 'public' || item.publicVersion <= copy.version || (item.kind !== 'module' && item.kind !== 'part')) {
      return reply.code(409).send({ error: 'no_update' });
    }
    const v = await db
      .select()
      .from(schema.catalogItemVersions)
      .where(and(eq(schema.catalogItemVersions.itemId, item.id), eq(schema.catalogItemVersions.version, item.publicVersion)))
      .get();
    if (!v) return reply.code(404).send({ error: 'not_found' });
    const now = new Date();
    if (item.kind === 'module') {
      const m = await db.select().from(schema.modules).where(eq(schema.modules.id, copy.copyId)).get();
      if (!m || !(await manages(user.id, m))) return reply.code(404).send({ error: 'not_found' });
      const doc = Buffer.from(v.docSnapshot as Uint8Array);
      const thumb = v.thumbnail ? Buffer.from(v.thumbnail as Uint8Array) : null;
      const mime = thumb ? (v.thumbnailMime as 'image/png' | 'image/webp') : null;
      await db
        .update(schema.modules)
        .set({ docSnapshot: doc, docVersion: m.docVersion + 1, thumbnail: thumb, thumbnailMime: mime, thumbnailAt: thumb ? now : null, updatedAt: now })
        .where(eq(schema.modules.id, m.id));
      await recordVersion(m.id, doc, user.id, `From the catalog (version ${v.version})`, thumb, mime);
    } else {
      const p = await db.select().from(schema.customParts).where(eq(schema.customParts.id, copy.copyId)).get();
      if (!p || !(await manages(user.id, p))) return reply.code(404).send({ error: 'not_found' });
      await db
        .update(schema.customParts)
        .set({
          xmlBlob: stripImportSource(Buffer.from(v.xmlBlob as Uint8Array)),
          spriteBlob: Buffer.from(v.spriteBlob as Uint8Array),
          spriteMime: (v.spriteMime ?? p.spriteMime) as 'image/gif' | 'image/png',
          updatedAt: now,
        })
        .where(eq(schema.customParts.id, p.id));
    }
    await db
      .update(schema.catalogCopies)
      .set({ version: v.version })
      .where(and(eq(schema.catalogCopies.itemId, item.id), eq(schema.catalogCopies.copyId, copy.copyId)));
    return { ok: true, version: v.version };
  });

  // ---- moderation (moderators and global admins) --------------------------
  const requireModerator = (req: FastifyRequest): User => {
    const user = requireUser(req);
    if (!canModerate(user)) {
      const err = new Error('forbidden');
      (err as Error & { statusCode?: number }).statusCode = 403;
      throw err;
    }
    return user;
  };

  app.get<{ Querystring: { status?: string } }>('/api/moderation/items', async (req) => {
    const viewer = requireModerator(req);
    // The queue (versions waiting), and the items in the catalogs.
    const queue = await db
      .select({
        versionId: schema.catalogItemVersions.id,
        version: schema.catalogItemVersions.version,
        note: schema.catalogItemVersions.note,
        createdAt: schema.catalogItemVersions.createdAt,
        itemId: schema.catalogItems.id,
        kind: schema.catalogItems.kind,
        title: schema.catalogItems.title,
        description: schema.catalogItems.description,
        tags: schema.catalogItems.tags,
        sentTitle: schema.catalogItemVersions.title,
        sentDescription: schema.catalogItemVersions.description,
        sentTags: schema.catalogItemVersions.tags,
        itemStatus: schema.catalogItems.status,
        takenDownBy: schema.catalogItems.takenDownBy,
        publicVersion: schema.catalogItems.publicVersion,
        coverImageId: schema.catalogItems.coverImageId,
        submitterId: schema.users.id,
        submitterName: schema.users.displayName,
        submitterEmail: schema.users.email,
        ownerUserId: schema.catalogItems.ownerUserId,
        ownerOrgId: schema.catalogItems.ownerOrgId,
      })
      .from(schema.catalogItemVersions)
      .innerJoin(schema.catalogItems, eq(schema.catalogItems.id, schema.catalogItemVersions.itemId))
      .leftJoin(schema.users, eq(schema.users.id, schema.catalogItemVersions.submittedBy))
      .where(eq(schema.catalogItemVersions.status, 'in_review'))
      .orderBy(schema.catalogItemVersions.createdAt);
    const items = await db
      .select()
      .from(schema.catalogItems)
      .where(inArray(schema.catalogItems.status, ['public', 'unpublished']))
      .orderBy(desc(schema.catalogItems.updatedAt))
      .limit(500);
    const name = await ownerNames([...queue, ...items]);
    // A trusted club reviews what's published under its name: those wait in
    // its own queue (moderators can still see them, and act on them).
    const trusted = await trustedClubs([...queue, ...items].map((q) => q.ownerOrgId));
    const pictured = await picturedVersions([...queue.map((q) => ({ id: q.itemId, version: q.version })), ...items.map((i) => ({ id: i.id, version: i.publicVersion }))]);
    const entry = (q: (typeof queue)[number]) => ({
        versionId: q.versionId,
        itemId: q.itemId,
        kind: q.kind,
        ...sentText(q),
        version: q.version,
        isUpdate: q.publicVersion > 0,
        note: q.note,
        by: name(q),
        // Who sent it: their name for moderators, and their address only for
        // site admins (email addresses are never shown to other people).
        submitter: q.submitterId
          ? {
              name: nameFor(viewer, q.submitterId, q.submitterName),
              ...(viewer.isGlobalAdmin && q.submitterEmail ? { email: q.submitterEmail } : {}),
            }
          : null,
        createdAt: q.createdAt.getTime(),
        previewUrl: previewUrlOf(q.itemId, q.version, pictured),
        /** Its uploaded picture, when it has one (reviewed with it). */
        coverUrl: q.coverImageId ? itemCoverUrl(q.itemId, q.coverImageId) : null,
        // Whom a moderator would warn about it.
        owner: ownerRef(q),
        trustedClub: !!q.ownerOrgId && trusted.has(q.ownerOrgId),
      });
    const covers = await coverQueue();
    // A club's item a site moderator took down waits in the site's queue.
    const inClub = (q: (typeof queue)[number]) => !!q.ownerOrgId && trusted.has(q.ownerOrgId) && holdOf({ status: q.itemStatus, takenDownBy: q.takenDownBy }) !== 'site';
    return {
      /** New pictures for public items, waiting for review: what shows now beside the new one. */
      covers: covers.filter((c) => !c.trustedClub),
      trustedCovers: covers.filter((c) => c.trustedClub),
      queue: queue.filter((q) => !inClub(q)).map(entry),
      /** Waiting in trusted clubs' own queues. */
      trustedQueue: queue.filter(inClub).map(entry),
      items: items.map((i) => ({ ...itemOut(i, name(i), pictured), status: i.status, reason: i.reason, owner: ownerRef(i), trustedClub: !!i.ownerOrgId && trusted.has(i.ownerOrgId) })),
    };
  });

  // ---- moderation at scale: one list a page at a time ----------------------
  // `view`: 'waiting' (versions to review), 'trusted' (waiting in trusted
  // clubs' own queues), 'public' or 'unpublished' (items). Filters: kind,
  // q (title, description, tags, reason), from/to (ms; when sent or last
  // changed), sort ('oldest' or 'newest'). `limit` (≤ 100) and `offset`
  // page through it; `total` counts every match.
  const trustedOrg = sql`EXISTS (SELECT 1 FROM orgs o WHERE o.id = ${schema.catalogItems.ownerOrgId} AND o.trusted = 1)`;
  // Versions a trusted club reviews: its own, except an item a site moderator took down.
  const clubReviews = sql`(${trustedOrg} AND NOT ${siteHeldItem})`;
  app.get<{ Querystring: { view?: string; kind?: string; q?: string; from?: string; to?: string; sort?: string; limit?: string; offset?: string } }>(
    '/api/moderation/catalog',
    async (req, reply) => {
      const viewer = requireModerator(req);
      const view = req.query.view ?? 'waiting';
      if (!['waiting', 'trusted', 'public', 'unpublished'].includes(view)) return reply.code(400).send({ error: 'invalid_input' });
      const kind = req.query.kind;
      if (kind && !isKind(kind)) return reply.code(400).send({ error: 'invalid_input' });
      const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit)) || 50));
      const offset = Math.min(1_000_000, Math.max(0, Math.floor(Number(req.query.offset)) || 0));
      const q = (req.query.q ?? '').trim().toLowerCase().slice(0, 80);
      const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const text = like
        ? or(
            sql`lower(${schema.catalogItems.title}) LIKE ${like} ESCAPE '\\'`,
            sql`lower(${schema.catalogItems.description}) LIKE ${like} ESCAPE '\\'`,
            sql`lower(${schema.catalogItems.tags}) LIKE ${like} ESCAPE '\\'`,
            sql`lower(coalesce(${schema.catalogItems.reason}, '')) LIKE ${like} ESCAPE '\\'`,
          )
        : undefined;
      const from = Number(req.query.from) || 0;
      const to = Number(req.query.to) || 0;
      const oldest = view === 'waiting' || view === 'trusted' ? req.query.sort !== 'newest' : req.query.sort === 'oldest';
      if (view === 'waiting' || view === 'trusted') {
        const at = schema.catalogItemVersions.createdAt;
        const where = and(
          eq(schema.catalogItemVersions.status, 'in_review'),
          view === 'trusted' ? clubReviews : sql`NOT ${clubReviews}`,
          kind ? eq(schema.catalogItems.kind, kind as Kind) : undefined,
          text,
          from ? sql`${at} >= ${from}` : undefined,
          to ? sql`${at} <= ${to}` : undefined,
        );
        const total = (
          await db
            .select({ n: sql<number>`count(*)` })
            .from(schema.catalogItemVersions)
            .innerJoin(schema.catalogItems, eq(schema.catalogItems.id, schema.catalogItemVersions.itemId))
            .where(where)
            .get()
        )?.n ?? 0;
        const rows = await db
          .select({
            versionId: schema.catalogItemVersions.id,
            version: schema.catalogItemVersions.version,
            note: schema.catalogItemVersions.note,
            createdAt: at,
            itemId: schema.catalogItems.id,
            kind: schema.catalogItems.kind,
            title: schema.catalogItems.title,
            description: schema.catalogItems.description,
            tags: schema.catalogItems.tags,
            sentTitle: schema.catalogItemVersions.title,
            sentDescription: schema.catalogItemVersions.description,
            sentTags: schema.catalogItemVersions.tags,
            publicVersion: schema.catalogItems.publicVersion,
            coverImageId: schema.catalogItems.coverImageId,
            submitterId: schema.users.id,
            submitterName: schema.users.displayName,
            submitterEmail: schema.users.email,
            ownerUserId: schema.catalogItems.ownerUserId,
            ownerOrgId: schema.catalogItems.ownerOrgId,
          })
          .from(schema.catalogItemVersions)
          .innerJoin(schema.catalogItems, eq(schema.catalogItems.id, schema.catalogItemVersions.itemId))
          .leftJoin(schema.users, eq(schema.users.id, schema.catalogItemVersions.submittedBy))
          .where(where)
          .orderBy(oldest ? asc(at) : desc(at), asc(schema.catalogItemVersions.id))
          .limit(limit)
          .offset(offset);
        const name = await ownerNames(rows);
        const pictured = await picturedVersions(rows.map((r) => ({ id: r.itemId, version: r.version })));
        return {
          total,
          nextOffset: offset + rows.length < total ? offset + rows.length : null,
          rows: rows.map((r) => ({
            versionId: r.versionId,
            itemId: r.itemId,
            kind: r.kind,
            ...sentText(r),
            version: r.version,
            isUpdate: r.publicVersion > 0,
            note: r.note,
            by: name(r),
            submitter: r.submitterId
              ? { name: nameFor(viewer, r.submitterId, r.submitterName), ...(viewer.isGlobalAdmin && r.submitterEmail ? { email: r.submitterEmail } : {}) }
              : null,
            createdAt: r.createdAt.getTime(),
            previewUrl: previewUrlOf(r.itemId, r.version, pictured),
            coverUrl: r.coverImageId ? itemCoverUrl(r.itemId, r.coverImageId) : null,
            owner: ownerRef(r),
            trustedClub: view === 'trusted',
          })),
        };
      }
      const at = schema.catalogItems.updatedAt;
      const where = and(
        eq(schema.catalogItems.status, view as 'public' | 'unpublished'),
        kind ? eq(schema.catalogItems.kind, kind as Kind) : undefined,
        text,
        from ? sql`${at} >= ${from}` : undefined,
        to ? sql`${at} <= ${to}` : undefined,
      );
      const total = (await db.select({ n: sql<number>`count(*)` }).from(schema.catalogItems).where(where).get())?.n ?? 0;
      const rows = await db
        .select()
        .from(schema.catalogItems)
        .where(where)
        .orderBy(oldest ? asc(at) : desc(at), asc(schema.catalogItems.id))
        .limit(limit)
        .offset(offset);
      const name = await ownerNames(rows);
      const trusted = await trustedClubs(rows.map((r) => r.ownerOrgId));
      const pictured = await picturedVersions(rows.map((i) => ({ id: i.id, version: i.publicVersion })));
      return {
        total,
        nextOffset: offset + rows.length < total ? offset + rows.length : null,
        rows: rows.map((i) => ({
          ...itemOut(i, name(i), pictured),
          status: i.status,
          reason: i.reason,
          updatedAt: i.updatedAt.getTime(),
          owner: ownerRef(i),
          trustedClub: !!i.ownerOrgId && trusted.has(i.ownerOrgId),
        })),
      };
    },
  );

  // New pictures waiting, without the lists of items (Moderation › To review).
  app.get('/api/moderation/covers', async (req) => {
    requireModerator(req);
    const covers = await coverQueue();
    return { covers: covers.filter((c) => !c.trustedClub), trustedCovers: covers.filter((c) => c.trustedClub) };
  });

  // How many are in each list: the tab badges and the menu's count.
  app.get('/api/moderation/counts', async (req) => {
    requireModerator(req);
    const waitingRows = await db
      .select({ trusted: sql<number>`${clubReviews}`, n: sql<number>`count(*)` })
      .from(schema.catalogItemVersions)
      .innerJoin(schema.catalogItems, eq(schema.catalogItems.id, schema.catalogItemVersions.itemId))
      .where(eq(schema.catalogItemVersions.status, 'in_review'))
      .groupBy(sql`1`);
    const byStatus = await db
      .select({ status: schema.catalogItems.status, n: sql<number>`count(*)` })
      .from(schema.catalogItems)
      .where(inArray(schema.catalogItems.status, ['public', 'unpublished']))
      .groupBy(schema.catalogItems.status);
    const covers = await db
      .select({ trusted: sql<number>`${trustedOrg}`, n: sql<number>`count(*)` })
      .from(schema.catalogItems)
      .where(isNotNull(schema.catalogItems.pendingCoverImageId))
      .groupBy(sql`1`);
    const collections = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.catalogCollections)
      .where(
        and(
          eq(schema.catalogCollections.audience, 'everyone'),
          or(eq(schema.catalogCollections.status, 'in_review'), and(eq(schema.catalogCollections.status, 'public'), isNotNull(schema.catalogCollections.pending))),
          // Not in a trusted club's own queue (one a site moderator took down is the site's).
          or(sql`NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = ${schema.catalogCollections.orgId} AND o.trusted = 1)`, siteHeldCollection),
        ),
      )
      .get();
    const pick = (rows: { trusted: number; n: number }[], t: boolean) => rows.find((r) => !!r.trusted === t)?.n ?? 0;
    return {
      waiting: pick(waitingRows, false),
      trusted: pick(waitingRows, true),
      covers: pick(covers, false),
      trustedCovers: pick(covers, true),
      public: byStatus.find((r) => r.status === 'public')?.n ?? 0,
      unpublished: byStatus.find((r) => r.status === 'unpublished')?.n ?? 0,
      /** Collections waiting (not trusted clubs' own). */
      collections: collections?.n ?? 0,
    };
  });

  // Several at once: approve or decline waiting versions, or unpublish
  // items. Each is done (and audited) on its own, as if one by one.
  app.post<{ Body: { action?: unknown; ids?: unknown; reason?: unknown } }>(
    '/api/moderation/bulk',
    // codeql[js/missing-rate-limiting] - rate limited via Fastify config.rateLimit
    { config: { rateLimit: perPerson(60, '1 minute') } },
    async (req, reply) => {
      const user = requireModerator(req);
      const { action, ids, reason } = req.body ?? {};
      if (action !== 'approve' && action !== 'decline' && action !== 'unpublish') return reply.code(400).send({ error: 'invalid_input' });
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !ids.every((i) => typeof i === 'string' && i.length <= 64)) {
        return reply.code(400).send({ error: 'invalid_input' });
      }
      let done = 0;
      const failed: { id: string; error: string }[] = [];
      for (const id of new Set(ids as string[])) {
        const r = action === 'unpublish' ? await unpublishItem(user, id, reason) : await decideVersion(user, id, action === 'approve', reason);
        if (r.code === 200) done++;
        else failed.push({ id, error: (r.body as { error?: string }).error ?? 'failed' });
      }
      return { done, failed };
    },
  );

  const decide = (req: FastifyRequest<{ Params: { versionId: string }; Body: { reason?: unknown } }>, approve: boolean) =>
    decideVersion(requireModerator(req), req.params.versionId, approve, req.body?.reason);
  app.post<{ Params: { versionId: string }; Body: { reason?: unknown } }>('/api/moderation/versions/:versionId/approve', async (req, reply) => {
    const r = await decide(req, true);
    return reply.code(r.code).send(r.body);
  });
  app.post<{ Params: { versionId: string }; Body: { reason?: unknown } }>('/api/moderation/versions/:versionId/decline', async (req, reply) => {
    const r = await decide(req, false);
    return reply.code(r.code).send(r.body);
  });

  // Take an item out of the catalog at once. Copies already in people's
  // layouts keep working: they're copies.
  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>('/api/moderation/items/:id/unpublish', async (req, reply) => {
    const r = await unpublishItem(requireModerator(req), req.params.id, req.body?.reason);
    return reply.code(r.code).send(r.body);
  });

  // Put an unpublished item back in the catalog, on the version it had.
  // Only site moderators: owners and clubs ask by sharing it again.
  app.post<{ Params: { id: string } }>('/api/moderation/items/:id/restore', async (req, reply) => {
    const user = requireModerator(req);
    const item = await db.select().from(schema.catalogItems).where(eq(schema.catalogItems.id, req.params.id)).get();
    if (!item) return reply.code(404).send({ error: 'not_found' });
    if (item.status !== 'unpublished' || item.publicVersion === 0) return reply.code(409).send({ error: 'not_unpublished' });
    await db
      .update(schema.catalogItems)
      .set({ status: 'public', takenDownBy: null, reason: null, updatedAt: new Date() })
      .where(eq(schema.catalogItems.id, item.id));
    await writeAuditEvent({ resourceKind: 'catalog_item', resourceId: item.id, userId: user.id, eventType: 'catalog_restore', payload: { version: item.publicVersion } });
    return { ok: true };
  });
}
