// Saved modules (Phase 6.5).
//
// First-class shareable assets that mirror desktop CLD's `Module`. Stored
// as a Y.Doc snapshot (same persistence story as layouts). For v1
// modules are NOT realtime-collaborative — there's no WS endpoint for
// them, just a snapshot REST. Editing happens in the modules editor
// (planned post-Phase-7) or programmatically via the API.
//
// Sharing tiers: owner / editor / viewer; org ownership available;
// explicit collaborators via `module_collaborators`. The
// `resolveResourceRole` helper handles the kind dispatch.

import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DEMO_USER_ID } from '../demo/demoAccount.js';
import { db, schema } from '../db/index.js';
import { checkGrowth, type Subject } from '../limits/limits.js';
import { requireUser } from '../auth/cookie.js';
import { hasAtLeast, resolveResourceRole, type Role } from '../access/resolveResourceRole.js';
import { createDefaultLayoutDoc, encodeDoc } from '@cld/ydoc';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { destinationOrg, matchesOwner, ownerLookup, resolveOwnerFilter } from './owners.js';
import { clampTitle, titleTooLong, trimmed } from '../utils/validate.js';
import { addPermission, clubAccessMap, clubThingAccess } from '../access/clubPermissions.js';
import { HEAD_BYTES, imageSide, MAX_THUMBNAIL_BYTES, reencode, smallCopy, THUMBNAIL_BODY_LIMIT } from '../images/thumbnails.js';
import { dropModuleFromCollections } from './collections.js';
import { canModerate } from './catalog.js';
import type { User } from '../db/schema.js';
import { emailsVisible, nameFor } from '../utils/publicName.js';
import { creditLookup, withCredits } from './credits.js';
import { checkUpdate } from '../ws/updateGuard.js';
import { checkGridSizes } from '../ws/gridGuard.js';
import { snapshotBackgroundProblem } from '../ws/backgroundGuard.js';
import { snapshotWork } from '../ws/yjsWork.js';

type ModuleRow = typeof schema.modules.$inferSelect;

/**
 * Copy module `src` to `user`, or to the club `destOrgId`, remembering what
 * it was copied from. The caller checked the user may open `src` and add to
 * the destination.
 */
export async function copyModuleTo(
  user: User,
  src: ModuleRow,
  destOrgId: string | null,
  title: string,
): Promise<{ ok: true; id: string } | { ok: false; status: number; body: unknown }> {
  const copyOwner: Subject = destOrgId ? { kind: 'org', id: destOrgId } : { kind: 'user', id: user.id };
  const copyBytes = (src.docSnapshot as Uint8Array).length + ((src.sidecarSnapshot as Uint8Array | null)?.length ?? 0);
  const refusal = await checkGrowth({ actor: user, owner: copyOwner, add: { bytes: copyBytes } });
  if (refusal) return { ok: false, status: refusal.status, body: refusal.body };
  const id = randomUUID();
  const now = new Date();
  await db.insert(schema.modules).values({
    id,
    title,
    ownerUserId: destOrgId ? null : user.id,
    ownerOrgId: destOrgId,
    createdBy: user.id,
    docSnapshot: src.docSnapshot,
    docVersion: 0,
    sidecarSnapshot: src.sidecarSnapshot,
    copiedFromId: src.id,
    createdAt: now,
    updatedAt: now,
  });
  await writeAuditEvent({
    resourceKind: 'module',
    resourceId: id,
    userId: user.id,
    eventType: 'create',
    payload: { title, copiedFrom: src.id, owner: destOrgId ? { kind: 'org', id: destOrgId } : { kind: 'user', id: user.id } },
  });
  return { ok: true, id };
}

// The desktop app (an API token) lists, inserts, saves and republishes
// modules: reading needs layouts:read, changing one layouts:write.
const TOKEN_READ = { apiToken: 'layouts:read' } as const;
const TOKEN_WRITE = { apiToken: 'layouts:write' } as const;

interface CreateModuleBody {
  title?: string;
  /** When set, the module is org-owned. Caller must be a member. */
  orgSlug?: string;
}

/** Whether a module is in any collection (a moderator may see its picture). */
async function inACollection(moduleId: string): Promise<boolean> {
  const hit = await db
    .select({ id: schema.catalogCollectionModules.collectionId })
    .from(schema.catalogCollectionModules)
    .where(eq(schema.catalogCollectionModules.moduleId, moduleId))
    .limit(1)
    .get();
  return !!hit;
}

export async function moduleRoutes(app: FastifyInstance): Promise<void> {
  // The snapshot endpoints accept binary octet-stream bodies (same path
  // as the layouts snapshot). Register the parser if it's not already
  // present (layoutRoutes registers it too — first-wins).
  if (!app.hasContentTypeParser('application/octet-stream')) {
    app.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: 50 * 1024 * 1024 },
      (_req, body, done) => done(null, body),
    );
  }

  // ---- list modules the user can see -------------------------------------
  app.get<{ Querystring: { owner?: string } }>('/api/modules', { config: TOKEN_READ }, async (req, reply) => {
    const user = requireUser(req);
    // ?owner=all|me|<club slug>: a club the caller isn't in is not found.
    const filter = await resolveOwnerFilter(user.id, req.query?.owner);
    if (!filter) return reply.code(404).send({ error: 'org_not_found' });
    // Metadata columns only — never the doc blobs.
    const personal = await db
      .select(moduleListColumns)
      .from(schema.modules)
      .where(eq(schema.modules.ownerUserId, user.id));
    const orgOwned = await db
      .select({ module: moduleListColumns })
      .from(schema.orgMembers)
      .innerJoin(
        schema.modules,
        eq(schema.modules.ownerOrgId, schema.orgMembers.orgId),
      )
      .innerJoin(schema.orgs, eq(schema.orgs.id, schema.orgMembers.orgId))
      .where(eq(schema.orgMembers.userId, user.id));
    const shared = await db
      .select({ module: moduleListColumns, role: schema.moduleCollaborators.role })
      .from(schema.moduleCollaborators)
      .innerJoin(
        schema.modules,
        eq(schema.modules.id, schema.moduleCollaborators.moduleId),
      )
      .where(eq(schema.moduleCollaborators.userId, user.id));

    const seen = new Set<string>();
    const all: (ReturnType<typeof toListItem> & { role: Role })[] = [];
    for (const m of personal) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      all.push({ ...toListItem(m), role: 'owner' });
    }
    const access = await clubAccessMap(user.id);
    for (const { module } of orgOwned) {
      if (seen.has(module.id)) continue;
      seen.add(module.id);
      const a = access.get(module.ownerOrgId ?? '');
      all.push({ ...toListItem(module), role: a ? clubThingAccess(a, 'module') : 'viewer' });
    }
    for (const { module, role } of shared) {
      const i = all.findIndex((m) => m.id === module.id);
      // A share can give a club member more than the club does.
      if (i >= 0 && hasAtLeast(role, all[i]!.role) && role !== all[i]!.role) all[i] = { ...all[i]!, role };
      if (seen.has(module.id)) continue;
      seen.add(module.id);
      all.push({ ...toListItem(module), role });
    }
    const shown = all.filter((m) => matchesOwner(m, filter, user.id));
    const ownerOf = await ownerLookup(shown);
    return { modules: await withCredits('module', shown.map((m) => ({ ...m, owner: ownerOf(m) })), user.id) };
  });

  // ---- get one module ---------------------------------------------------
  app.get<{ Params: { id: string } }>('/api/modules/:id', { config: TOKEN_READ }, async (req, reply) => {
    const user = requireUser(req);
    const { role } = await resolveResourceRole(user.id, 'module', req.params.id);
    if (role === null) return reply.code(404).send({ error: 'not_found' });
    const module = await db
      .select(moduleListColumns)
      .from(schema.modules)
      .where(eq(schema.modules.id, req.params.id))
      .get();
    if (!module) return reply.code(404).send({ error: 'not_found' });
    const credit = (await creditLookup('module', [module.id], user.id))(module.id);
    // One of the demo's samples, opened by a demo visitor: their own copy of it (the editor goes there).
    const demoCopy =
      user.isDemoAccount && module.ownerUserId === DEMO_USER_ID && user.id !== DEMO_USER_ID
        ? await db
            .select({ id: schema.modules.id })
            .from(schema.modules)
            .where(and(eq(schema.modules.ownerUserId, user.id), eq(schema.modules.copiedFromId, module.id)))
            .get()
        : undefined;
    return { module: { ...toListItem(module), credit }, role, ...(demoCopy ? { demoCopyId: demoCopy.id } : {}) };
  });

  // ---- create -----------------------------------------------------------
  app.post<{ Body: CreateModuleBody }>('/api/modules', { config: TOKEN_WRITE }, async (req, reply) => {
    const user = requireUser(req);
    const body = req.body ?? {};
    if (titleTooLong(trimmed(body.title))) return reply.code(400).send({ error: 'invalid_title' });
    const title = trimmed(body.title) || 'Untitled Module';

    const dest = await destinationOrg(user.id, body.orgSlug, addPermission('module'));
    if (!dest.ok) return reply.code(dest.code).send({ error: dest.error, permission: dest.permission });
    const ownerUserId: string | null = dest.orgId ? null : user.id;
    const ownerOrgId: string | null = dest.orgId;

    const id = randomUUID();
    const now = new Date();
    // Seed a fresh layout's doc (grid + one empty brick layer), so the
    // module editor opens ready for parts. The snapshot PUT saves edits.
    const doc = createDefaultLayoutDoc();
    const docBytes = encodeDoc(doc);
    const owner: Subject = ownerOrgId ? { kind: 'org', id: ownerOrgId } : { kind: 'user', id: user.id };
    const refusal = await checkGrowth({ actor: user, owner, add: { bytes: docBytes.length } });
    if (refusal) return reply.code(refusal.status).send(refusal.body);

    await db.insert(schema.modules).values({
      id,
      title,
      ownerUserId,
      ownerOrgId,
      createdBy: user.id,
      docSnapshot: Buffer.from(docBytes),
      docVersion: 0,
      sidecarSnapshot: null,
      createdAt: now,
      updatedAt: now,
    });
    await writeAuditEvent({
      resourceKind: 'module',
      resourceId: id,
      userId: user.id,
      eventType: 'create',
      payload: { title, owner: ownerOrgId ? { kind: 'org', id: ownerOrgId } : { kind: 'user', id: user.id } },
    });
    return reply.code(201).send({ id, title });
  });

  // ---- copy to yourself or a club ----------------------------------------
  // Anyone who can open a module can copy it, into their own modules or a
  // club they're in (moving uses the transfer route).
  app.post<{ Params: { id: string }; Body: { orgSlug?: string; title?: string } }>(
    '/api/modules/:id/copy',
    { config: TOKEN_WRITE }, 
    async (req, reply) => {
      const user = requireUser(req);
      const { role } = await resolveResourceRole(user.id, 'module', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });
      const src = await db.select().from(schema.modules).where(eq(schema.modules.id, req.params.id)).get();
      if (!src) return reply.code(404).send({ error: 'not_found' });
      const dest = await destinationOrg(user.id, req.body?.orgSlug, addPermission('module'));
      if (!dest.ok) return reply.code(dest.code).send({ error: dest.error, permission: dest.permission });
      const sameOwner = dest.orgId ? src.ownerOrgId === dest.orgId : src.ownerUserId === user.id;
      if (titleTooLong(trimmed(req.body?.title))) return reply.code(400).send({ error: 'invalid_title' });
      const title = trimmed(req.body?.title) || clampTitle(sameOwner ? `${src.title} (copy)` : src.title);
      const r = await copyModuleTo(user, src, dest.orgId, title);
      if (!r.ok) return reply.code(r.status).send(r.body);
      const id = r.id;
      return reply.code(201).send({ id, title });
    },
  );

  // ---- patch (rename) ---------------------------------------------------
  app.patch<{ Params: { id: string }; Body: { title?: string } }>(
    '/api/modules/:id',
    { config: TOKEN_WRITE }, 
    async (req, reply) => {
      const user = requireUser(req);
      const { role } = await resolveResourceRole(user.id, 'module', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });
      if (!hasAtLeast(role, 'editor')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const updates: Partial<typeof schema.modules.$inferInsert> = {};
      if (req.body.title !== undefined) {
        const t = trimmed(req.body.title);
        if (!t || titleTooLong(t)) return reply.code(400).send({ error: 'invalid_title' });
        updates.title = t;
      }
      if (Object.keys(updates).length === 0) {
        return reply.code(400).send({ error: 'no_updates' });
      }
      updates.updatedAt = new Date();
      await db.update(schema.modules).set(updates).where(eq(schema.modules.id, req.params.id));
      return { ok: true };
    },
  );

  // ---- delete -----------------------------------------------------------
  app.delete<{ Params: { id: string } }>('/api/modules/:id', { config: TOKEN_WRITE }, async (req, reply) => {
    const user = requireUser(req);
    const { role } = await resolveResourceRole(user.id, 'module', req.params.id);
    if (role === null) return reply.code(404).send({ error: 'not_found' });
    if (!hasAtLeast(role, 'owner')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    // Club collections it's in lose it; their curators get a note.
    const gone = await db.select({ id: schema.modules.id, title: schema.modules.title }).from(schema.modules).where(eq(schema.modules.id, req.params.id)).get();
    if (gone) await dropModuleFromCollections(gone, 'deleted', null, user.id);
    await db.delete(schema.modules).where(eq(schema.modules.id, req.params.id));
    await writeAuditEvent({
      resourceKind: 'module',
      resourceId: req.params.id,
      userId: user.id,
      eventType: 'delete',
      payload: {},
    });
    return { ok: true };
  });

  // ---- snapshot (read) --------------------------------------------------
  app.get<{ Params: { id: string } }>('/api/modules/:id/snapshot', { config: TOKEN_READ }, async (req, reply) => {
    const user = requireUser(req);
    const { role } = await resolveResourceRole(user.id, 'module', req.params.id);
    if (role === null) return reply.code(404).send({ error: 'not_found' });
    const module = await db
      .select()
      .from(schema.modules)
      .where(eq(schema.modules.id, req.params.id))
      .get();
    if (!module) return reply.code(404).send({ error: 'not_found' });
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('X-Doc-Version', String(module.docVersion));
    return reply.send(Buffer.from(module.docSnapshot as Uint8Array));
  });

  // ---- snapshot (write, editor+) ----------------------------------------
  app.put<{ Params: { id: string }; Querystring: { note?: string } }>('/api/modules/:id/snapshot', { config: TOKEN_WRITE }, async (req, reply) => {
    const user = requireUser(req);
    const { role } = await resolveResourceRole(user.id, 'module', req.params.id);
    if (role === null) return reply.code(404).send({ error: 'not_found' });
    if (!hasAtLeast(role, 'editor')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const body = req.body;
    if (!body || !(body instanceof Buffer || body instanceof Uint8Array)) {
      return reply.code(400).send({ error: 'expected_binary_body' });
    }
    const bytes = body instanceof Buffer ? body : Buffer.from(body);
    if (bytes.length === 0) return reply.code(400).send({ error: 'empty_snapshot' });
    if (bytes.length > 50 * 1024 * 1024) {
      return reply.code(413).send({ error: 'snapshot_too_large' });
    }
    // Only a document both apps can read (the live editor's check).
    if (checkUpdate(bytes) !== null || checkGridSizes(null, bytes) !== null || snapshotWork(bytes) !== null) return reply.code(400).send({ error: 'unreadable_snapshot' });
    // A module has no background picture of its own: none, or the one it already had (ws/backgroundGuard.ts).
    const badBackground = await snapshotBackgroundProblem(bytes, req.params.id, async () => {
      const row = await db.select({ docSnapshot: schema.modules.docSnapshot }).from(schema.modules).where(eq(schema.modules.id, req.params.id)).get();
      return (row?.docSnapshot as Uint8Array | undefined) ?? null;
    });
    if (badBackground !== null) return reply.code(400).send({ error: 'invalid_background_image' });
    const updatedAt = new Date();
    const current = await db
      .select({
        docVersion: schema.modules.docVersion,
        ownerUserId: schema.modules.ownerUserId,
        ownerOrgId: schema.modules.ownerOrgId,
        bytes: sql<number>`length(${schema.modules.docSnapshot})`.mapWith(Number),
      })
      .from(schema.modules)
      .where(eq(schema.modules.id, req.params.id))
      .get();
    if (current) {
      const owner: Subject = current.ownerOrgId ? { kind: 'org', id: current.ownerOrgId } : { kind: 'user', id: current.ownerUserId ?? user.id };
      // The module's new contents, plus the version's own copy of them.
      const refusal = await checkGrowth({ actor: user, owner, add: { bytes: 2 * bytes.length - current.bytes }, uploadBytes: bytes.length });
      if (refusal) return reply.code(refusal.status).send(refusal.body);
    }
    const note = cleanNote(req.query?.note);
    if (note === undefined) return reply.code(400).send({ error: 'note_too_long' });
    await db
      .update(schema.modules)
      .set({
        docSnapshot: bytes,
        docVersion: (current?.docVersion ?? 0) + 1,
        updatedAt,
      })
      .where(eq(schema.modules.id, req.params.id));
    const version = await recordVersion(req.params.id, bytes, user.id, note);
    return { ok: true, updatedAt: updatedAt.getTime(), version };
  });

  // ---- thumbnail ----------------------------------------------------------
  // The editor makes a picture of the module (up to 1024 px) when it's saved
  // or opened, and sends it here as base64 in JSON: the site's firewall only
  // lets octet-stream through on the two snapshot routes. It's re-encoded as
  // WebP without metadata (images/thumbnails.ts) before it's stored.
  app.put<{ Params: { id: string }; Body: { mime?: unknown; data?: unknown } }>(
    '/api/modules/:id/thumbnail',
    { bodyLimit: THUMBNAIL_BODY_LIMIT, config: TOKEN_WRITE },
    async (req, reply) => {
      const user = requireUser(req);
      const { role } = await resolveResourceRole(user.id, 'module', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });
      if (!hasAtLeast(role, 'editor')) return reply.code(403).send({ error: 'forbidden' });
      const mime = req.body?.mime;
      const data = req.body?.data;
      if ((mime !== 'image/png' && mime !== 'image/webp') || typeof data !== 'string' || !BASE64_RE.test(data)) {
        return reply.code(400).send({ error: 'invalid_thumbnail' });
      }
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length === 0 || !looksLike(bytes, mime)) return reply.code(400).send({ error: 'invalid_thumbnail' });
      if (bytes.length > MAX_THUMBNAIL_BYTES) return reply.code(413).send({ error: 'thumbnail_too_large' });
      const stored = await reencode(bytes);
      if (!stored) return reply.code(400).send({ error: 'invalid_thumbnail' });
      const current = await db
        .select({
          ownerUserId: schema.modules.ownerUserId,
          ownerOrgId: schema.modules.ownerOrgId,
          bytes: sql<number>`coalesce(length(${schema.modules.thumbnail}), 0)`.mapWith(Number),
        })
        .from(schema.modules)
        .where(eq(schema.modules.id, req.params.id))
        .get();
      if (!current) return reply.code(404).send({ error: 'not_found' });
      const owner: Subject = current.ownerOrgId ? { kind: 'org', id: current.ownerOrgId } : { kind: 'user', id: current.ownerUserId ?? user.id };
      const refusal = await checkGrowth({ actor: user, owner, add: { bytes: stored.length - current.bytes }, uploadBytes: bytes.length });
      if (refusal) return reply.code(refusal.status).send(refusal.body);
      const thumbnailAt = new Date();
      await db
        .update(schema.modules)
        .set({ thumbnail: stored, thumbnailMime: 'image/webp', thumbnailAt })
        .where(eq(schema.modules.id, req.params.id));
      // The newest version's picture too (the history shows it).
      await db
        .update(schema.moduleVersions)
        .set({ thumbnail: stored, thumbnailMime: 'image/webp' })
        .where(
          and(
            eq(schema.moduleVersions.moduleId, req.params.id),
            eq(schema.moduleVersions.version, sql`(SELECT latest_version FROM modules WHERE id = ${req.params.id})`),
          ),
        );
      return { ok: true, thumbnailAt: thumbnailAt.getTime() };
    },
  );

  // `?size=small`: a 256 px copy for lists (made once, kept in memory).
  app.get<{ Params: { id: string }; Querystring: { size?: string } }>('/api/modules/:id/thumbnail', { config: TOKEN_READ }, async (req, reply) => {
    const user = requireUser(req);
    const { role } = await resolveResourceRole(user.id, 'module', req.params.id);
    // Moderators review collections, which show their modules' pictures.
    if (role === null && !(canModerate(user) && (await inACollection(req.params.id)))) return reply.code(404).send({ error: 'not_found' });
    const row = await db
      .select({ thumbnail: schema.modules.thumbnail, mime: schema.modules.thumbnailMime, at: schema.modules.thumbnailAt })
      .from(schema.modules)
      .where(eq(schema.modules.id, req.params.id))
      .get();
    if (!row?.thumbnail || !row.mime) return reply.code(404).send({ error: 'no_thumbnail' });
    // The list links it as ?v=<thumbnailAt>, so a new picture is a new URL.
    const small = req.query?.size === 'small';
    const etag = `"${row.at?.getTime() ?? 0}${small ? '-s' : ''}"`;
    reply.header('Cache-Control', 'private, max-age=86400');
    reply.header('ETag', etag);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    const full = Buffer.from(row.thumbnail as Uint8Array);
    const pic = small ? await smallCopy(full, row.mime) : { bytes: full, mime: row.mime };
    reply.header('Content-Type', pic.mime);
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(pic.bytes);
  });

  // ---- versions -----------------------------------------------------------
  app.get<{ Params: { id: string } }>('/api/modules/:id/versions', { config: TOKEN_READ }, async (req, reply) => {
    const user = requireUser(req);
    const { role } = await resolveResourceRole(user.id, 'module', req.params.id);
    if (role === null) return reply.code(404).send({ error: 'not_found' });
    const rows = await db
      .select({
        version: schema.moduleVersions.version,
        note: schema.moduleVersions.note,
        createdAt: schema.moduleVersions.createdAt,
        authorName: schema.users.displayName,
        authorId: schema.moduleVersions.authorId,
        hasThumbnail: sql<number>`${schema.moduleVersions.thumbnail} IS NOT NULL`,
        bytes: sql<number>`length(${schema.moduleVersions.docSnapshot})`.mapWith(Number),
      })
      .from(schema.moduleVersions)
      .leftJoin(schema.users, eq(schema.users.id, schema.moduleVersions.authorId))
      .where(eq(schema.moduleVersions.moduleId, req.params.id))
      .orderBy(desc(schema.moduleVersions.version));
    return {
      role,
      versions: rows.map((v) => ({
        version: v.version,
        note: v.note,
        createdAt: v.createdAt.getTime(),
        author: v.authorId && v.authorName !== null ? nameFor(user, v.authorId, v.authorName) : null,
        hasThumbnail: Boolean(v.hasThumbnail),
        bytes: v.bytes,
      })),
    };
  });

  app.get<{ Params: { id: string; n: string } }>('/api/modules/:id/versions/:n/snapshot', { config: TOKEN_READ }, async (req, reply) => {
    const found = await findVersion(req.user?.id, req.params.id, req.params.n);
    if (!found.ok) return reply.code(found.code).send({ error: found.error });
    reply.header('Content-Type', 'application/octet-stream');
    return reply.send(Buffer.from(found.row.docSnapshot as Uint8Array));
  });

  app.get<{ Params: { id: string; n: string }; Querystring: { size?: string } }>('/api/modules/:id/versions/:n/thumbnail', { config: TOKEN_READ }, async (req, reply) => {
    const found = await findVersion(req.user?.id, req.params.id, req.params.n);
    if (!found.ok) return reply.code(found.code).send({ error: found.error });
    if (!found.row.thumbnail || !found.row.thumbnailMime) return reply.code(404).send({ error: 'no_thumbnail' });
    // A version never changes, so its picture can be kept a long time.
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    const full = Buffer.from(found.row.thumbnail as Uint8Array);
    const pic = req.query?.size === 'small' ? await smallCopy(full, found.row.thumbnailMime) : { bytes: full, mime: found.row.thumbnailMime };
    reply.header('Content-Type', pic.mime);
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(pic.bytes);
  });

  // Restore: the old version becomes the module's contents again, as a new
  // version (nothing in the history is lost).
  app.post<{ Params: { id: string; n: string } }>('/api/modules/:id/versions/:n/restore', async (req, reply) => {
    const user = requireUser(req);
    const found = await findVersion(user.id, req.params.id, req.params.n);
    if (!found.ok) return reply.code(found.code).send({ error: found.error });
    if (!hasAtLeast(found.role, 'editor')) return reply.code(403).send({ error: 'forbidden' });
    const bytes = Buffer.from(found.row.docSnapshot as Uint8Array);
    const current = await db
      .select({
        ownerUserId: schema.modules.ownerUserId,
        ownerOrgId: schema.modules.ownerOrgId,
        docVersion: schema.modules.docVersion,
        bytes: sql<number>`length(${schema.modules.docSnapshot})`.mapWith(Number),
      })
      .from(schema.modules)
      .where(eq(schema.modules.id, req.params.id))
      .get();
    if (!current) return reply.code(404).send({ error: 'not_found' });
    const owner: Subject = current.ownerOrgId ? { kind: 'org', id: current.ownerOrgId } : { kind: 'user', id: current.ownerUserId ?? user.id };
    const refusal = await checkGrowth({ actor: user, owner, add: { bytes: 2 * bytes.length - current.bytes } });
    if (refusal) return reply.code(refusal.status).send(refusal.body);
    const now = new Date();
    const thumb = found.row.thumbnail ? Buffer.from(found.row.thumbnail as Uint8Array) : null;
    await db
      .update(schema.modules)
      .set({
        docSnapshot: bytes,
        docVersion: current.docVersion + 1,
        updatedAt: now,
        thumbnail: thumb,
        thumbnailMime: thumb ? found.row.thumbnailMime : null,
        thumbnailAt: thumb ? now : null,
      })
      .where(eq(schema.modules.id, req.params.id));
    const version = await recordVersion(req.params.id, bytes, user.id, `Restored version ${found.row.version}`, thumb, found.row.thumbnailMime);
    await writeAuditEvent({
      resourceKind: 'module',
      resourceId: req.params.id,
      userId: user.id,
      eventType: 'restore_version',
      payload: { from: found.row.version, version },
    });
    return { ok: true, version };
  });

  // ---- collaborators ----------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/api/modules/:id/collaborators',
    async (req, reply) => {
      const user = requireUser(req);
      const { role } = await resolveResourceRole(user.id, 'module', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });
      const collaborators = await db
        .select({
          userId: schema.moduleCollaborators.userId,
          role: schema.moduleCollaborators.role,
          addedAt: schema.moduleCollaborators.addedAt,
          email: schema.users.email,
          displayName: schema.users.displayName,
          avatarUrl: schema.users.avatarUrl,
        })
        .from(schema.moduleCollaborators)
        .innerJoin(schema.users, eq(schema.users.id, schema.moduleCollaborators.userId))
        .where(eq(schema.moduleCollaborators.moduleId, req.params.id));
      const seesEmails = emailsVisible(user, role);
      // Pending invites are addresses only: for the people who manage sharing.
      const invites = seesEmails
        ? await db
            .select()
            .from(schema.moduleInvites)
            .where(and(eq(schema.moduleInvites.moduleId, req.params.id), isNull(schema.moduleInvites.acceptedAt)))
        : [];
      return {
        invites: invites.map((i) => ({ id: i.id, invitedEmail: i.invitedEmail, role: i.role, expiresAt: i.expiresAt.getTime() })),
        collaborators: collaborators.map((c) => ({
          userId: c.userId,
          role: c.role,
          addedAt: c.addedAt.getTime(),
          // Addresses: the person themselves, the owners (who manage sharing) and site admins.
          email: seesEmails || c.userId === user.id ? c.email : '',
          displayName: nameFor(user, c.userId, c.displayName),
          avatarUrl: c.avatarUrl,
        })),
      };
    },
  );

  // Invites (POST /api/modules/:id/invites and accepting them) are in moduleInvites.ts.

  app.delete<{ Params: { id: string; userId: string } }>(
    '/api/modules/:id/collaborators/:userId',
    async (req, reply) => {
      const user = requireUser(req);
      const { role } = await resolveResourceRole(user.id, 'module', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });
      const isSelf = req.params.userId === user.id;
      if (!isSelf && !hasAtLeast(role, 'owner')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      await db
        .delete(schema.moduleCollaborators)
        .where(
          and(
            eq(schema.moduleCollaborators.moduleId, req.params.id),
            eq(schema.moduleCollaborators.userId, req.params.userId),
          ),
        );
      await writeAuditEvent({
        resourceKind: 'module',
        resourceId: req.params.id,
        userId: user.id,
        eventType: 'unshare',
        payload: { targetUserId: req.params.userId, selfRemoved: isSelf },
      });
      return { ok: true };
    },
  );
}

/** How many versions of each module are kept (the oldest go first). */
export const MODULE_VERSIONS_KEPT = 20;
const MAX_NOTE = 300;

/** The "What changed" note: trimmed, null when empty, undefined when too long. */
function cleanNote(raw: unknown): string | null | undefined {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t) return null;
  return t.length > MAX_NOTE ? undefined : t;
}

/** Keep `bytes` as the module's next version; drop the oldest past MODULE_VERSIONS_KEPT. Returns its number. */
export async function recordVersion(
  moduleId: string,
  bytes: Buffer,
  authorId: string,
  note: string | null,
  thumbnail: Buffer | null = null,
  thumbnailMime: 'image/png' | 'image/webp' | null = null,
): Promise<number> {
  const row = await db
    .select({ latest: schema.modules.latestVersion })
    .from(schema.modules)
    .where(eq(schema.modules.id, moduleId))
    .get();
  const version = (row?.latest ?? 0) + 1;
  await db.insert(schema.moduleVersions).values({
    id: randomUUID(),
    moduleId,
    version,
    docSnapshot: bytes,
    thumbnail,
    thumbnailMime,
    note,
    authorId,
    createdAt: new Date(),
  });
  await db.update(schema.modules).set({ latestVersion: version }).where(eq(schema.modules.id, moduleId));
  const old = await db
    .select({ id: schema.moduleVersions.id })
    .from(schema.moduleVersions)
    .where(eq(schema.moduleVersions.moduleId, moduleId))
    .orderBy(desc(schema.moduleVersions.version))
    .offset(MODULE_VERSIONS_KEPT)
    .limit(1000);
  if (old.length > 0) await db.delete(schema.moduleVersions).where(inArray(schema.moduleVersions.id, old.map((o) => o.id)));
  return version;
}

/** One version of a module the caller can open. */
async function findVersion(
  userId: string | undefined,
  moduleId: string,
  n: string,
): Promise<
  | { ok: true; role: Role; row: typeof schema.moduleVersions.$inferSelect }
  | { ok: false; code: 401 | 404; error: string }
> {
  if (!userId) return { ok: false, code: 401, error: 'unauthorized' };
  const { role } = await resolveResourceRole(userId, 'module', moduleId);
  if (role === null) return { ok: false, code: 404, error: 'not_found' };
  const version = Number(n);
  if (!Number.isInteger(version) || version < 1) return { ok: false, code: 404, error: 'not_found' };
  const row = await db
    .select()
    .from(schema.moduleVersions)
    .where(and(eq(schema.moduleVersions.moduleId, moduleId), eq(schema.moduleVersions.version, version)))
    .get();
  if (!row) return { ok: false, code: 404, error: 'not_found' };
  return { ok: true, role, row };
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** The file really is the picture type it says it is. */
function looksLike(bytes: Buffer, mime: 'image/png' | 'image/webp'): boolean {
  if (mime === 'image/png') return bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return bytes.length > 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP';
}

const moduleListColumns = {
  id: schema.modules.id,
  title: schema.modules.title,
  ownerUserId: schema.modules.ownerUserId,
  ownerOrgId: schema.modules.ownerOrgId,
  docVersion: schema.modules.docVersion,
  hasSidecar: sql<number>`${schema.modules.sidecarSnapshot} IS NOT NULL`,
  thumbnailAt: schema.modules.thumbnailAt,
  /** The picture's first bytes, for its size (imageSide), not the picture. */
  thumbnailHead: sql<Buffer | null>`substr(${schema.modules.thumbnail}, 1, ${HEAD_BYTES})`,
  latestVersion: schema.modules.latestVersion,
  createdAt: schema.modules.createdAt,
  updatedAt: schema.modules.updatedAt,
};

function toListItem(
  m: Pick<
    typeof schema.modules.$inferSelect,
    'id' | 'title' | 'ownerUserId' | 'ownerOrgId' | 'docVersion' | 'thumbnailAt' | 'latestVersion' | 'createdAt' | 'updatedAt'
  > & { hasSidecar: number; thumbnailHead?: Buffer | Uint8Array | null },
) {
  return {
    id: m.id,
    title: m.title,
    ownerUserId: m.ownerUserId,
    ownerOrgId: m.ownerOrgId,
    docVersion: m.docVersion,
    hasSidecar: Boolean(m.hasSidecar),
    /** When the picture was made (its cache key), or null: show a placeholder. */
    thumbnailAt: m.thumbnailAt ? m.thumbnailAt.getTime() : null,
    /** The picture's longest side in pixels; under 512 is an old, low-resolution one. */
    thumbnailSide: m.thumbnailAt ? imageSide(m.thumbnailHead ?? null) : null,
    /** The newest version's number; 0 when it has no history yet. */
    latestVersion: m.latestVersion,
    createdAt: m.createdAt.getTime(),
    updatedAt: m.updatedAt.getTime(),
  };
}
