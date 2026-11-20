// Rolling stock rosters (trains design 2.6): engines and cars kept on an
// account or a club, "kinda like modules" (Aaron, 2026-11-19): a club's
// roster is changed by those who may edit its modules, and layouts keep
// copies of the records they use (libraryId, libraryVersion), so a file
// still works on its own; "Update from roster" compares versions.
//
//   GET    /api/rolling-stock?owner=all|me|<club slug>   list (records included)
//   POST   /api/rolling-stock    { record, orgSlug? }     save a new one
//   PATCH  /api/rolling-stock/:id { record }              change it (version + 1)
//   DELETE /api/rolling-stock/:id                         delete it
//
// The desktop app reaches these with an API token: layouts:read to list,
// layouts:write to save, change and delete (as it does modules).

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { requireUser } from '../auth/cookie.js';
import { addPermission, clubAccess, clubAccessMap, has } from '../access/clubPermissions.js';
import { destinationOrg, matchesOwner, ownerLookup, resolveOwnerFilter } from './owners.js';
import { checkGrowth } from '../limits/limits.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';

const TOKEN_READ = { apiToken: 'layouts:read' } as const;
const TOKEN_WRITE = { apiToken: 'layouts:write' } as const;

/** The most one record may hold (a car with a long note is well under a KB). */
export const MAX_STOCK_BYTES = 64 * 1024;
const MAX_TEXT = 200;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A record fit to keep, or why not. Its id, library link and owner id are the server's to set. */
export function stockProblem(v: unknown): string | null {
  if (!isObj(v)) return 'record must be an object';
  if (JSON.stringify(v).length > MAX_STOCK_BYTES) return 'record_too_large';
  for (const k of ['number', 'name', 'type', 'owner', 'notes'] as const) {
    if (v[k] !== undefined && typeof v[k] !== 'string') return `${k} must be text`;
    if (typeof v[k] === 'string' && (v[k] as string).length > (k === 'notes' ? 4000 : MAX_TEXT)) return `${k} is too long`;
  }
  const len = v.length;
  if (typeof len !== 'number' || !Number.isFinite(len) || len <= 0 || len > 2000) return 'length must be a number of studs (1 to 2000)';
  if (v.trucks !== undefined) {
    if (!Array.isArray(v.trucks) || v.trucks.length > 16) return 'trucks must be a short list';
    for (const t of v.trucks) if (!isObj(t) || typeof t.at !== 'number' || !Number.isFinite(t.at)) return 'each truck needs a number `at`';
  }
  if (v.tags !== undefined && (!Array.isArray(v.tags) || v.tags.length > 50 || v.tags.some((t) => typeof t !== 'string' || t.length > 60))) return 'tags must be a short list of words';
  return null;
}

/** The record as kept: without the server's own fields (they're added on the way out). */
function cleanRecord(v: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, libraryId: _lib, libraryVersion: _ver, ...rest } = v;
  return rest;
}

async function canRead(row: { ownerUserId: string | null; ownerOrgId: string | null }, userId: string): Promise<boolean> {
  if (row.ownerUserId === userId) return true;
  if (!row.ownerOrgId) return false;
  return (await clubAccess(userId, row.ownerOrgId)) !== null;
}

async function canManage(row: { ownerUserId: string | null; ownerOrgId: string | null }, userId: string): Promise<boolean> {
  if (row.ownerUserId) return row.ownerUserId === userId;
  if (row.ownerOrgId) return has(await clubAccess(userId, row.ownerOrgId), 'edit_modules');
  return false;
}

function shape(row: schema.RollingStockEntry, canManageIt: boolean) {
  const record = JSON.parse(row.data) as Record<string, unknown>;
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    ownerUserId: row.ownerUserId,
    ownerOrgId: row.ownerOrgId,
    version: row.version,
    updatedAt: row.updatedAt.getTime(),
    canManage: canManageIt,
    // What a layout keeps: the record, linked back to this entry.
    record: { ...record, libraryId: row.id, libraryVersion: row.version },
  };
}

export async function rollingStockRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { owner?: string } }>('/api/rolling-stock', { config: TOKEN_READ }, async (req, reply) => {
    const user = requireUser(req);
    const filter = await resolveOwnerFilter(user.id, req.query?.owner);
    if (!filter) return reply.code(404).send({ error: 'org_not_found' });
    const personal = await db.select().from(schema.rollingStock).where(eq(schema.rollingStock.ownerUserId, user.id));
    const clubs = await db
      .select({ s: schema.rollingStock })
      .from(schema.orgMembers)
      .innerJoin(schema.rollingStock, eq(schema.rollingStock.ownerOrgId, schema.orgMembers.orgId))
      .where(eq(schema.orgMembers.userId, user.id));
    const access = await clubAccessMap(user.id);
    const all = [
      ...personal.map((r) => shape(r, true)),
      ...clubs.map(({ s }) => shape(s, has(access.get(s.ownerOrgId ?? ''), 'edit_modules'))),
    ];
    const seen = new Set<string>();
    const shown = all.filter((r) => !seen.has(r.id) && (seen.add(r.id), true)).filter((r) => matchesOwner(r, filter, user.id));
    const ownerOf = await ownerLookup(shown);
    shown.sort((a, b) => a.number.localeCompare(b.number) || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
    return { stock: shown.map((r) => ({ ...r, owner: ownerOf(r) })) };
  });

  app.post<{ Body: { record?: unknown; orgSlug?: string } }>('/api/rolling-stock', { config: TOKEN_WRITE }, async (req, reply) => {
    const user = requireUser(req);
    const record = req.body?.record;
    const bad = stockProblem(record);
    if (bad) return reply.code(bad === 'record_too_large' ? 413 : 400).send({ error: bad });
    const dest = await destinationOrg(user.id, req.body?.orgSlug, addPermission('module'));
    if (!dest.ok) return reply.code(dest.code).send({ error: dest.error, permission: dest.permission });
    const data = JSON.stringify(cleanRecord(record as Record<string, unknown>));
    const refusal = await checkGrowth({
      actor: user,
      owner: dest.orgId ? { kind: 'org', id: dest.orgId } : { kind: 'user', id: user.id },
      add: { bytes: data.length },
    });
    if (refusal) return reply.code(refusal.status).send(refusal.body);
    const now = new Date();
    const r = record as Record<string, unknown>;
    const row = {
      id: randomUUID(),
      ownerUserId: dest.orgId ? null : user.id,
      ownerOrgId: dest.orgId,
      number: String(r.number ?? ''),
      name: String(r.name ?? ''),
      data,
      version: 1,
      createdBy: user.id,
      copiedFromId: typeof r.libraryId === 'string' ? r.libraryId : null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(schema.rollingStock).values(row);
    return reply.code(201).send(shape({ ...row, modelPartId: null }, true));
  });

  app.patch<{ Params: { id: string }; Body: { record?: unknown } }>('/api/rolling-stock/:id', { config: TOKEN_WRITE }, async (req, reply) => {
    const user = requireUser(req);
    const row = await db.select().from(schema.rollingStock).where(eq(schema.rollingStock.id, req.params.id)).get();
    if (!row || !(await canRead(row, user.id))) return reply.code(404).send({ error: 'not_found' });
    if (!(await canManage(row, user.id))) return reply.code(403).send({ error: 'forbidden', permission: 'edit_modules' });
    const record = req.body?.record;
    const bad = stockProblem(record);
    if (bad) return reply.code(bad === 'record_too_large' ? 413 : 400).send({ error: bad });
    const r = record as Record<string, unknown>;
    const data = JSON.stringify(cleanRecord(r));
    const updates = { number: String(r.number ?? ''), name: String(r.name ?? ''), data, version: row.version + 1, updatedAt: new Date() };
    await db.update(schema.rollingStock).set(updates).where(eq(schema.rollingStock.id, row.id));
    return shape({ ...row, ...updates }, true);
  });

  app.delete<{ Params: { id: string } }>('/api/rolling-stock/:id', { config: TOKEN_WRITE }, async (req, reply) => {
    const user = requireUser(req);
    const row = await db.select().from(schema.rollingStock).where(eq(schema.rollingStock.id, req.params.id)).get();
    if (!row || !(await canRead(row, user.id))) return reply.code(404).send({ error: 'not_found' });
    if (!(await canManage(row, user.id))) return reply.code(403).send({ error: 'forbidden', permission: 'edit_modules' });
    await db.delete(schema.rollingStock).where(eq(schema.rollingStock.id, row.id));
    if (row.ownerOrgId) {
      await writeAuditEvent({
        resourceKind: 'rolling_stock',
        resourceId: row.id,
        userId: user.id,
        eventType: 'delete',
        payload: { number: row.number, name: row.name, ownerOrgId: row.ownerOrgId },
      });
    }
    return { ok: true };
  });
}
