// Recently deleted: a layout, module or venue its owner deletes goes here
// for 30 days (trash_items), then the privacy clean-up erases it. While it
// waits, the item is gone from its own table (so nothing else has to know
// about deleted rows); its rows are kept as gzipped JSON and put back on
// restore, under the same id.
//
//   layout: the layout (its history folded in), who it's shared with, and
//           its background picture
//   module: the module, its versions, who it's shared with, and which
//           collections it was in (put back on restore; one that's gone
//           meanwhile is skipped, and the restore says so)
//   venue:  the venue
//
// Not kept: open invites and hand-over offers (they're re-sent), and a
// layout's public link (deleting says links stop working: a restored
// layout is private until it's shared again).
//
// Restoring is growth like any other: the owner's limits apply (the
// layout count, their space), and a collection that filled up meanwhile is
// skipped. Something made by an account that's been erased since comes back
// credited "Builder #…", the way the account's other things were left.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { clubAccessMap } from '../access/clubPermissions.js';
import { checkGrowth } from '../limits/limits.js';
import type { User } from '../db/schema.js';
import { imagesDirFor } from '../workers/backup.js';
import { env } from '../env.js';

export const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type TrashKind = 'layout' | 'module' | 'venue';

type Row = Record<string, unknown>;

/** A module's place in one collection when it was deleted. */
interface Membership {
  id: string;
  position: number;
  /** It was the collection's chosen cover. */
  wasCover: boolean;
}

interface Payload {
  rows: Record<string, Row[]>;
  /** A layout's background picture: file name and bytes. */
  picture?: { name: string; data: string };
  /** A module's collections (recorded before it left them). */
  collections?: Membership[];
}

// JSON with Buffers and Dates kept as such.
function pack(p: Payload): Buffer {
  const json = JSON.stringify(p, (_k, v: unknown) => {
    if (v && typeof v === 'object' && (v as { type?: string }).type === 'Buffer' && Array.isArray((v as { data?: unknown }).data)) {
      return { $b64: Buffer.from((v as { data: number[] }).data).toString('base64') };
    }
    return v;
  });
  return gzipSync(Buffer.from(json));
}

function unpack(bytes: Uint8Array): Payload {
  return JSON.parse(gunzipSync(bytes).toString('utf8'), (_k, v: unknown) => {
    if (v && typeof v === 'object' && typeof (v as { $b64?: unknown }).$b64 === 'string') return Buffer.from((v as { $b64: string }).$b64, 'base64');
    if (v && typeof v === 'object' && typeof (v as { $date?: unknown }).$date === 'number') return new Date((v as { $date: number }).$date);
    return v;
  }) as Payload;
}

/** Dates as {$date}, before JSON (JSON.stringify would make them strings). */
function datesOut(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[k] = v instanceof Date ? { $date: v.getTime() } : v;
  return out;
}

const TABLES = {
  layouts: schema.layouts,
  layoutCollaborators: schema.layoutCollaborators,
  modules: schema.modules,
  moduleVersions: schema.moduleVersions,
  moduleCollaborators: schema.moduleCollaborators,
  venueLibrary: schema.venueLibrary,
} as const;
type TableName = keyof typeof TABLES;

interface Deleting {
  kind: TrashKind;
  itemId: string;
  title: string;
  ownerUserId: string | null;
  ownerOrgId: string | null;
  rows: Partial<Record<TableName, Row[]>>;
  picture?: { name: string; bytes: Buffer };
  collections?: Membership[];
}

async function keep(d: Deleting, actorId: string, now: Date): Promise<string> {
  const payload: Payload = { rows: {} };
  for (const [t, rows] of Object.entries(d.rows)) payload.rows[t] = rows.map(datesOut);
  if (d.picture) payload.picture = { name: d.picture.name, data: d.picture.bytes.toString('base64') };
  if (d.collections?.length) payload.collections = d.collections;
  const bytes = pack(payload);
  const id = randomUUID();
  await db.insert(schema.trashItems).values({
    id,
    kind: d.kind,
    itemId: d.itemId,
    title: d.title,
    ownerUserId: d.ownerUserId,
    ownerOrgId: d.ownerOrgId,
    deletedBy: actorId,
    deletedAt: now,
    purgeAt: new Date(now.getTime() + TRASH_DAYS * DAY_MS),
    payload: bytes,
    bytes: bytes.length,
  });
  return id;
}

/** A layout's background picture on disk, if it has one. */
function pictureOf(layoutId: string): { name: string; bytes: Buffer } | undefined {
  const dir = imagesDirFor(env.dbPath);
  if (!existsSync(dir)) return undefined;
  const name = readdirSync(dir).find((f) => f.startsWith(`${layoutId}.`));
  return name ? { name, bytes: readFileSync(join(dir, name)) } : undefined;
}

/**
 * Keep a layout in Recently deleted (call before deleting it). `doc` is its
 * current document, live edits folded in.
 */
export async function trashLayout(layoutId: string, doc: Uint8Array, actorId: string, now = new Date()): Promise<string | null> {
  const row = await db.select().from(schema.layouts).where(eq(schema.layouts.id, layoutId)).get();
  if (!row) return null;
  const collaborators = await db.select().from(schema.layoutCollaborators).where(eq(schema.layoutCollaborators.layoutId, layoutId)).all();
  const picture = pictureOf(layoutId);
  return keep(
    {
      kind: 'layout',
      itemId: layoutId,
      title: row.title,
      ownerUserId: row.ownerUserId,
      ownerOrgId: row.ownerOrgId,
      // Its public link isn't kept.
      rows: { layouts: [{ ...row, publicShareToken: null, docSnapshot: Buffer.from(doc) }], layoutCollaborators: collaborators },
      ...(picture ? { picture } : {}),
    },
    actorId,
    now,
  );
}

/**
 * Keep a module in Recently deleted (call before deleting it, and before
 * it's taken out of its collections, so they can be put back).
 */
export async function trashModule(moduleId: string, actorId: string, now = new Date()): Promise<string | null> {
  const row = await db.select().from(schema.modules).where(eq(schema.modules.id, moduleId)).get();
  if (!row) return null;
  const versions = await db.select().from(schema.moduleVersions).where(eq(schema.moduleVersions.moduleId, moduleId)).all();
  const collaborators = await db.select().from(schema.moduleCollaborators).where(eq(schema.moduleCollaborators.moduleId, moduleId)).all();
  const collections = (
    await db
      .select({ id: schema.catalogCollectionModules.collectionId, position: schema.catalogCollectionModules.position, cover: schema.catalogCollections.coverModuleId })
      .from(schema.catalogCollectionModules)
      .innerJoin(schema.catalogCollections, eq(schema.catalogCollections.id, schema.catalogCollectionModules.collectionId))
      .where(eq(schema.catalogCollectionModules.moduleId, moduleId))
      .all()
  ).map((c) => ({ id: c.id, position: c.position, wasCover: c.cover === moduleId }));
  return keep(
    {
      kind: 'module',
      itemId: moduleId,
      title: row.title,
      ownerUserId: row.ownerUserId,
      ownerOrgId: row.ownerOrgId,
      rows: { modules: [row], moduleVersions: versions, moduleCollaborators: collaborators },
      collections,
    },
    actorId,
    now,
  );
}

export async function trashVenue(venueId: string, actorId: string, now = new Date()): Promise<string | null> {
  const row = await db.select().from(schema.venueLibrary).where(eq(schema.venueLibrary.id, venueId)).get();
  if (!row) return null;
  return keep(
    { kind: 'venue', itemId: venueId, title: row.name, ownerUserId: row.ownerUserId, ownerOrgId: row.ownerOrgId, rows: { venueLibrary: [row] } },
    actorId,
    now,
  );
}

export interface TrashEntry {
  id: string;
  kind: TrashKind;
  itemId: string;
  title: string;
  ownerUserId: string | null;
  ownerOrgId: string | null;
  deletedAt: number;
  purgeAt: number;
  deletedBy: string | null;
}

/** The clubs where someone may restore (and delete for good): those where they may delete club items. */
async function trashClubs(userId: string): Promise<string[]> {
  const access = await clubAccessMap(userId);
  return [...access.entries()].filter(([, a]) => a.permissions.has('delete_items')).map(([id]) => id);
}

/** What someone can see in Recently deleted: their own things, and their clubs' where they may delete. */
export async function listTrash(userId: string): Promise<TrashEntry[]> {
  const clubs = await trashClubs(userId);
  const rows = await db
    .select({
      id: schema.trashItems.id,
      kind: schema.trashItems.kind,
      itemId: schema.trashItems.itemId,
      title: schema.trashItems.title,
      ownerUserId: schema.trashItems.ownerUserId,
      ownerOrgId: schema.trashItems.ownerOrgId,
      deletedAt: schema.trashItems.deletedAt,
      purgeAt: schema.trashItems.purgeAt,
      deletedBy: schema.trashItems.deletedBy,
    })
    .from(schema.trashItems)
    .where(
      or(
        and(eq(schema.trashItems.ownerUserId, userId), isNull(schema.trashItems.ownerOrgId)),
        clubs.length > 0 ? inArray(schema.trashItems.ownerOrgId, clubs) : undefined,
      ),
    )
    .all();
  return rows
    .map((r) => ({ ...r, deletedAt: r.deletedAt.getTime(), purgeAt: r.purgeAt.getTime() }))
    .sort((a, b) => b.deletedAt - a.deletedAt);
}

/** The trash row someone may act on, or null (not theirs: 404). */
async function mine(userId: string, trashId: string) {
  const row = await db.select().from(schema.trashItems).where(eq(schema.trashItems.id, trashId)).get();
  if (!row) return null;
  if (row.ownerOrgId) return (await trashClubs(userId)).includes(row.ownerOrgId) ? row : null;
  return row.ownerUserId === userId ? row : null;
}

/** A restored module's collections: those it's back in, and how many it was in that are gone since. */
export interface CollectionsBack {
  back: { id: string; title: string }[];
  gone: number;
  /** Collections that filled up meanwhile: it isn't back in these. */
  full: { id: string; title: string }[];
}

export type RestoreResult =
  | { ok: true; kind: TrashKind; itemId: string; collections?: CollectionsBack }
  | { ok: false; code: number; error: string; body?: Record<string, unknown> };

// Match routes/collections.ts (MAX_NOTE, MAX_COLLECTION_ITEMS); not
// imported, to keep the trash free of the routes (trash.test.ts checks
// they agree).
const MAX_CURATOR_NOTE = 1500;
export const TRASH_MAX_COLLECTION_ITEMS = 60;

/**
 * Put a restored module back into the collections it was in, in its old
 * place; a collection deleted meanwhile is skipped and counted. Its
 * curators were told it left, so they're told it's back.
 */
function restoreMemberships(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], moduleId: string, title: string, kept: Membership[]): CollectionsBack {
  const out: CollectionsBack = { back: [], gone: 0, full: [] };
  const line = `“${title}” was restored from Recently deleted, so it's back in this collection.`;
  for (const m of kept) {
    const c = tx.select().from(schema.catalogCollections).where(eq(schema.catalogCollections.id, m.id)).get();
    if (!c) {
      out.gone += 1;
      continue;
    }
    // It filled up while this was away: it stays as it is.
    const members = tx.select({ id: schema.catalogCollectionModules.moduleId }).from(schema.catalogCollectionModules).where(eq(schema.catalogCollectionModules.collectionId, c.id)).all();
    if (members.length >= TRASH_MAX_COLLECTION_ITEMS && !members.some((m2) => m2.id === moduleId)) {
      out.full.push({ id: c.id, title: c.title });
      continue;
    }
    tx.insert(schema.catalogCollectionModules).values({ collectionId: c.id, moduleId, position: m.position }).onConflictDoNothing().run();
    tx.update(schema.catalogCollections)
      .set({
        curatorNote: (c.curatorNote ? `${c.curatorNote}\n${line}` : line).slice(-MAX_CURATOR_NOTE),
        coverModuleId: m.wasCover && !c.coverModuleId ? moduleId : c.coverModuleId,
        updatedAt: new Date(),
      })
      .where(eq(schema.catalogCollections.id, c.id))
      .run();
    out.back.push({ id: c.id, title: c.title });
  }
  return out;
}

/** The bytes a kept row holds (its blobs and long text), for the owner's space. */
function rowBytes(row: Row): number {
  let n = 0;
  for (const v of Object.values(row)) {
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) n += v.length;
  }
  return n;
}

/** Put it back, under its own id. */
export async function restoreFromTrash(user: User, trashId: string): Promise<RestoreResult> {
  const userId = user.id;
  const row = await mine(userId, trashId);
  if (!row) return { ok: false, code: 404, error: 'not_found' };
  const payload = unpack(row.payload as Uint8Array);
  const table = row.kind === 'layout' ? schema.layouts : row.kind === 'module' ? schema.modules : schema.venueLibrary;
  // Its id was taken meanwhile (a copy restored twice can't be).
  if (await db.select({ id: table.id }).from(table).where(eq(table.id, row.itemId)).get()) return { ok: false, code: 409, error: 'already_restored' };
  const order: TableName[] = ['layouts', 'modules', 'venueLibrary', 'layoutCollaborators', 'moduleVersions', 'moduleCollaborators'];
  // Coming back is growth: the owner's limits apply, as for anything new.
  const main = payload.rows[row.kind === 'layout' ? 'layouts' : row.kind === 'module' ? 'modules' : 'venueLibrary'] ?? [];
  const bytes =
    order.reduce((n, name) => n + (payload.rows[name] ?? []).reduce((m, r) => m + rowBytes(r), 0), 0) +
    (payload.picture ? Buffer.byteLength(payload.picture.data, 'base64') : 0);
  const owner = row.ownerOrgId ? ({ kind: 'org', id: row.ownerOrgId } as const) : ({ kind: 'user', id: row.ownerUserId ?? userId } as const);
  const refusal = await checkGrowth({ actor: user, owner, add: { ...(row.kind === 'layout' ? { layouts: main.length } : {}), bytes } });
  if (refusal) return { ok: false, code: refusal.status, error: refusal.body.error, body: refusal.body as unknown as Record<string, unknown> };
  // People who've since left the site: collaborators are left out, and
  // what they made is credited "Builder #…". Only the ids in these rows are looked up.
  const named = new Set<string>();
  for (const name of order) {
    for (const r of payload.rows[name] ?? []) {
      for (const col of ['userId', 'authorId', 'createdBy'] as const) if (typeof r[col] === 'string') named.add(r[col]);
    }
  }
  const users = new Set(
    named.size ? (await db.select({ id: schema.users.id }).from(schema.users).where(inArray(schema.users.id, [...named])).all()).map((u) => u.id) : [],
  );
  let collections: CollectionsBack | undefined;
  db.transaction((tx) => {
    for (const name of order) {
      const rows = payload.rows[name];
      if (!rows || rows.length === 0) continue;
      const kept = name.endsWith('Collaborators') ? rows.filter((r) => users.has(String(r.userId))) : rows;
      if (name === 'moduleVersions') for (const r of kept) if (r.authorId && !users.has(String(r.authorId))) r.authorId = null;
      if (name === 'layouts' || name === 'modules') {
        for (const r of kept) {
          // Its maker's account was erased while it waited: whoever restores
          // it stands in, and the credit keeps the old id (as account deletion does).
          if (typeof r.createdBy === 'string' && !users.has(r.createdBy)) {
            r.deletedAuthorId ??= r.createdBy;
            r.createdBy = userId;
          }
          // Kept before public links were left out: it comes back private.
          if (name === 'layouts') r.publicShareToken = null;
        }
      }
      if (kept.length === 0) continue;
      tx.insert(TABLES[name]).values(kept as never).run();
    }
    if (row.kind === 'module' && payload.collections?.length) collections = restoreMemberships(tx, row.itemId, row.title, payload.collections);
    tx.delete(schema.trashItems).where(eq(schema.trashItems.id, row.id)).run();
  });
  if (payload.picture) {
    const dir = imagesDirFor(env.dbPath);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, payload.picture.name);
    if (!existsSync(path)) writeFileSync(path, Buffer.from(payload.picture.data, 'base64'));
  }
  return { ok: true, kind: row.kind, itemId: row.itemId, ...(collections ? { collections } : {}) };
}

/** A deleted layout's background picture goes from disk, unless the layout is back. */
async function removePictureOf(layoutId: string): Promise<void> {
  const dir = imagesDirFor(env.dbPath);
  if (!existsSync(dir)) return;
  if (await db.select({ id: schema.layouts.id }).from(schema.layouts).where(eq(schema.layouts.id, layoutId)).get()) return;
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(`${layoutId}.`)) continue;
    try {
      unlinkSync(join(dir, f));
    } catch {
      /* gone */
    }
  }
}

/** Erase it now, before its 30 days are up. */
export async function deleteFromTrash(userId: string, trashId: string): Promise<{ kind: TrashKind; itemId: string; title: string; ownerOrgId: string | null } | null> {
  const row = await mine(userId, trashId);
  if (!row) return null;
  await db.delete(schema.trashItems).where(eq(schema.trashItems.id, row.id));
  if (row.kind === 'layout') await removePictureOf(row.itemId);
  return { kind: row.kind, itemId: row.itemId, title: row.title, ownerOrgId: row.ownerOrgId };
}

/** The privacy clean-up: erase what has waited its 30 days. */
export async function purgeTrash(now = new Date()): Promise<number> {
  const gone = await db.delete(schema.trashItems).where(lt(schema.trashItems.purgeAt, now)).returning({ id: schema.trashItems.id, kind: schema.trashItems.kind, itemId: schema.trashItems.itemId });
  // A layout's picture, if the layout wasn't restored meanwhile.
  for (const g of gone) if (g.kind === 'layout') await removePictureOf(g.itemId);
  return gone.length;
}
