// Recently deleted: a layout, module or venue its owner deletes goes here
// for 30 days (trash_items), then the privacy clean-up erases it. While it
// waits, the item is gone from its own table (so nothing else has to know
// about deleted rows); its rows are kept as gzipped JSON and put back on
// restore, under the same id.
//
//   layout: the layout (its history folded in), who it's shared with, and
//           its background picture
//   module: the module, its versions, who it's shared with
//   venue:  the venue
//
// Not kept: open invites and hand-over offers (they're re-sent), and a
// module's place in collections (curators were told it went).

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { clubAccessMap } from '../access/clubPermissions.js';
import { imagesDirFor } from '../workers/backup.js';
import { env } from '../env.js';

export const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type TrashKind = 'layout' | 'module' | 'venue';

type Row = Record<string, unknown>;

interface Payload {
  rows: Record<string, Row[]>;
  /** A layout's background picture: file name and bytes. */
  picture?: { name: string; data: string };
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
}

async function keep(d: Deleting, actorId: string, now: Date): Promise<string> {
  const payload: Payload = { rows: {} };
  for (const [t, rows] of Object.entries(d.rows)) payload.rows[t] = rows.map(datesOut);
  if (d.picture) payload.picture = { name: d.picture.name, data: d.picture.bytes.toString('base64') };
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
      rows: { layouts: [{ ...row, docSnapshot: Buffer.from(doc) }], layoutCollaborators: collaborators },
      ...(picture ? { picture } : {}),
    },
    actorId,
    now,
  );
}

export async function trashModule(moduleId: string, actorId: string, now = new Date()): Promise<string | null> {
  const row = await db.select().from(schema.modules).where(eq(schema.modules.id, moduleId)).get();
  if (!row) return null;
  const versions = await db.select().from(schema.moduleVersions).where(eq(schema.moduleVersions.moduleId, moduleId)).all();
  const collaborators = await db.select().from(schema.moduleCollaborators).where(eq(schema.moduleCollaborators.moduleId, moduleId)).all();
  return keep(
    {
      kind: 'module',
      itemId: moduleId,
      title: row.title,
      ownerUserId: row.ownerUserId,
      ownerOrgId: row.ownerOrgId,
      rows: { modules: [row], moduleVersions: versions, moduleCollaborators: collaborators },
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

export type RestoreResult = { ok: true; kind: TrashKind; itemId: string } | { ok: false; code: number; error: string };

/** Put it back, under its own id. */
export async function restoreFromTrash(userId: string, trashId: string): Promise<RestoreResult> {
  const row = await mine(userId, trashId);
  if (!row) return { ok: false, code: 404, error: 'not_found' };
  const payload = unpack(row.payload as Uint8Array);
  const table = row.kind === 'layout' ? schema.layouts : row.kind === 'module' ? schema.modules : schema.venueLibrary;
  // Its id was taken meanwhile (a copy restored twice can't be).
  if (await db.select({ id: table.id }).from(table).where(eq(table.id, row.itemId)).get()) return { ok: false, code: 409, error: 'already_restored' };
  // Collaborators who've since left the site are left out.
  const users = new Set((await db.select({ id: schema.users.id }).from(schema.users).all()).map((u) => u.id));
  const order: TableName[] = ['layouts', 'modules', 'venueLibrary', 'layoutCollaborators', 'moduleVersions', 'moduleCollaborators'];
  db.transaction((tx) => {
    for (const name of order) {
      const rows = payload.rows[name];
      if (!rows || rows.length === 0) continue;
      const kept = name.endsWith('Collaborators') ? rows.filter((r) => users.has(String(r.userId))) : rows;
      if (name === 'moduleVersions') for (const r of kept) if (r.authorId && !users.has(String(r.authorId))) r.authorId = null;
      if (kept.length === 0) continue;
      tx.insert(TABLES[name]).values(kept as never).run();
    }
    tx.delete(schema.trashItems).where(eq(schema.trashItems.id, row.id)).run();
  });
  if (payload.picture) {
    const dir = imagesDirFor(env.dbPath);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, payload.picture.name);
    if (!existsSync(path)) writeFileSync(path, Buffer.from(payload.picture.data, 'base64'));
  }
  return { ok: true, kind: row.kind, itemId: row.itemId };
}

/** Erase it now, before its 30 days are up. */
export async function deleteFromTrash(userId: string, trashId: string): Promise<boolean> {
  const row = await mine(userId, trashId);
  if (!row) return false;
  await db.delete(schema.trashItems).where(eq(schema.trashItems.id, row.id));
  return true;
}

/** The privacy clean-up: erase what has waited its 30 days. */
export async function purgeTrash(now = new Date()): Promise<number> {
  const gone = await db.delete(schema.trashItems).where(lt(schema.trashItems.purgeAt, now)).returning({ id: schema.trashItems.id, kind: schema.trashItems.kind, itemId: schema.trashItems.itemId });
  // A layout's picture, if the layout wasn't restored meanwhile.
  const dir = imagesDirFor(env.dbPath);
  if (existsSync(dir)) {
    for (const g of gone) {
      if (g.kind !== 'layout') continue;
      if (await db.select({ id: schema.layouts.id }).from(schema.layouts).where(eq(schema.layouts.id, g.itemId)).get()) continue;
      for (const f of readdirSync(dir)) if (f.startsWith(`${g.itemId}.`)) try { unlinkSync(join(dir, f)); } catch { /* gone */ }
    }
  }
  return gone.length;
}
