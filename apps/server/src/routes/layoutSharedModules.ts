// A layout's shared (read-only) modules (docs/shared-modules.md).
//
//   GET  /api/layouts/:id/shared-modules                                    which it places, their owner, version, newest version and state (anyone who can open the layout)
//        ?check=<module id>                                                 and whether that module, one the caller can see, would follow its owner if placed here
//   GET  /api/layouts/:id/shared-modules/:placedId/versions                 the module's kept versions, seen through the layout
//   GET  /api/layouts/:id/shared-modules/:placedId/versions/:n/snapshot     one version's contents, seen through the layout
//   POST /api/layouts/:id/shared-modules/:placedId/apply   { version?, again? }   the server puts that version in (newer: Update; older: Go back; again: put the owner's version back). Layout editors.
//   POST /api/layouts/:id/shared-modules/apply-all                          every one that has a newer version
//   POST /api/layouts/:id/shared-modules/:placedId/detach                   "Make it mine" (the layout's owner; a club's admins and managers)
//
// "Seen through the layout": someone who edits a club's layout sees a
// module placed in it, its versions and its updates, without the module
// being shared with them in person.
//
// `apply` also serves a linked module that isn't shared (today's "Update
// from Module library"), for anyone who edits the layout and can see the
// library module: the server is then the one writer, so two people
// pressing Update at once no longer both put the parts in.

import { Buffer } from 'node:buffer';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { SidecarModule } from '@cld/bbm';
import { readSidecarCache } from '@cld/ydoc';
import { sharedPlaced } from '@cld/modules';
import { db, schema } from '../db/index.js';
import { requireUser } from '../auth/cookie.js';
import { hasAtLeast, resolveResourceRole } from '../access/resolveResourceRole.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { docHub } from '../ws/docHub.js';
import { applyVersion, detachModule, versionBytes } from '../sharedModules/apply.js';
import { stateFor, syncLayoutSharedModules, type SharedState } from '../sharedModules/placed.js';
import { followLayoutOwners } from '../sharedModules/lifecycle.js';
import { nameFor, publicName } from '../utils/publicName.js';
import { perPerson } from '../utils/rateLimits.js';
import { partGeometry } from './parts.js';
import type { User } from '../db/schema.js';

const TOKEN_READ = { apiToken: 'layouts:read' } as const;
const TOKEN_WRITE = { apiToken: 'layouts:write' } as const;

interface LayoutOwner {
  ownerUserId: string | null;
  ownerOrgId: string | null;
}

async function layoutOwner(layoutId: string): Promise<LayoutOwner | null> {
  return (
    (await db
      .select({ ownerUserId: schema.layouts.ownerUserId, ownerOrgId: schema.layouts.ownerOrgId })
      .from(schema.layouts)
      .where(eq(schema.layouts.id, layoutId))
      .get()) ?? null
  );
}

/** A version number from a path or a body: a whole number from 1, else null. */
function versionNumber(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 999_999_999 ? n : null;
}

/** The row of a placed shared module, kept up to date from the room when one is open. */
async function placedRow(layoutId: string, placedId: string) {
  const live = docHub.peek(layoutId);
  if (live) await syncLayoutSharedModules(layoutId, live.doc);
  return db
    .select()
    .from(schema.layoutSharedModules)
    .where(and(eq(schema.layoutSharedModules.layoutId, layoutId), eq(schema.layoutSharedModules.placedId, placedId)))
    .get();
}

/**
 * Before placing: would module `moduleId` follow its owner in this layout
 * (is it shared with the layout's owner too)? Answered only for a module
 * the caller can see, with the names the "ask its owner" message needs.
 */
async function placeCheck(user: User, layoutId: string, moduleId: unknown) {
  if (typeof moduleId !== 'string' || !/^[0-9a-f-]{36}$/.test(moduleId)) return null;
  if ((await resolveResourceRole(user.id, 'module', moduleId)).role === null) return null;
  const layout = await layoutOwner(layoutId);
  const mod = await db
    .select({ title: schema.modules.title, ownerUserId: schema.modules.ownerUserId, ownerOrgId: schema.modules.ownerOrgId })
    .from(schema.modules)
    .where(eq(schema.modules.id, moduleId))
    .get();
  if (!layout || !mod) return null;
  const nameOf = async (o: LayoutOwner): Promise<{ kind: 'user' | 'org'; name: string; mine: boolean }> => {
    if (o.ownerOrgId) {
      const org = await db.select({ name: schema.orgs.name }).from(schema.orgs).where(eq(schema.orgs.id, o.ownerOrgId)).get();
      return { kind: 'org', name: org?.name ?? '', mine: false };
    }
    const u = o.ownerUserId ? await db.select({ name: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, o.ownerUserId)).get() : undefined;
    return { kind: 'user', name: o.ownerUserId ? publicName(o.ownerUserId, u?.name) : '', mine: o.ownerUserId === user.id };
  };
  return {
    moduleId,
    /** 'shared': a copy placed here follows its owner's updates. */
    state: await stateFor(layout, moduleId),
    title: mod.title,
    moduleOwner: await nameOf(mod),
    layoutOwner: await nameOf(layout),
  };
}

export async function layoutSharedModuleRoutes(app: FastifyInstance): Promise<void> {
  followLayoutOwners();

  // ---- list ------------------------------------------------------------------
  app.get<{ Params: { id: string }; Querystring: { check?: string } }>('/api/layouts/:id/shared-modules', { config: TOKEN_READ }, async (req, reply) => {
    const user = requireUser(req);
    const { role } = await resolveResourceRole(user.id, 'layout', req.params.id);
    if (role === null) return reply.code(404).send({ error: 'not_found' });
    const check = await placeCheck(user, req.params.id, req.query?.check);
    const live = docHub.peek(req.params.id);
    if (live) await syncLayoutSharedModules(req.params.id, live.doc);
    const rows = await db.select().from(schema.layoutSharedModules).where(eq(schema.layoutSharedModules.layoutId, req.params.id)).all();
    const ids = [...new Set(rows.filter((r) => r.state === 'shared').map((r) => r.moduleId))];
    const mods = ids.length
      ? await db
          .select({
            id: schema.modules.id,
            title: schema.modules.title,
            latestVersion: schema.modules.latestVersion,
            ownerUserId: schema.modules.ownerUserId,
            ownerOrgId: schema.modules.ownerOrgId,
            thumbnailAt: schema.modules.thumbnailAt,
          })
          .from(schema.modules)
          .where(inArray(schema.modules.id, ids))
      : [];
    const byId = new Map(mods.map((m) => [m.id, m]));
    const ownerNames = new Map<string, string>();
    for (const m of mods) {
      const key = m.ownerOrgId ? `o:${m.ownerOrgId}` : `u:${m.ownerUserId ?? ''}`;
      if (ownerNames.has(key)) continue;
      if (m.ownerOrgId) {
        const org = await db.select({ name: schema.orgs.name }).from(schema.orgs).where(eq(schema.orgs.id, m.ownerOrgId)).get();
        ownerNames.set(key, org?.name ?? '');
      } else if (m.ownerUserId) {
        const u = await db.select({ name: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, m.ownerUserId)).get();
        ownerNames.set(key, publicName(m.ownerUserId, u?.name));
      }
    }
    // The newest version's "What changed?" note, for the notice.
    const notes = new Map<string, string | null>();
    for (const m of mods) {
      if (m.latestVersion < 1) continue;
      const v = await db
        .select({ note: schema.moduleVersions.note })
        .from(schema.moduleVersions)
        .where(and(eq(schema.moduleVersions.moduleId, m.id), eq(schema.moduleVersions.version, m.latestVersion)))
        .get();
      notes.set(m.id, v?.note ?? null);
    }
    return {
      /** May press Update and Go back. */
      canUpdate: hasAtLeast(role, 'editor'),
      /** May "Make it mine". */
      canDetach: hasAtLeast(role, 'owner'),
      ...(check ? { check } : {}),
      modules: rows
        .sort((a, b) => (a.placedId < b.placedId ? -1 : a.placedId > b.placedId ? 1 : 0))
        .map((r) => {
          // What a module's name and owner are is only said while it's still shared with this layout.
          const m = r.state === 'shared' ? byId.get(r.moduleId) : undefined;
          return {
            placedId: r.placedId,
            moduleId: r.moduleId,
            // (A module that went with its owner's account or club leaves its row behind.)
            state: (r.state === 'shared' && !m ? 'gone' : r.state) as SharedState,
            /** The version placed; 0 when the layout doesn't say. */
            version: r.version,
            title: m?.title ?? null,
            owner: m ? { kind: m.ownerOrgId ? ('org' as const) : ('user' as const), name: ownerNames.get(m.ownerOrgId ? `o:${m.ownerOrgId}` : `u:${m.ownerUserId ?? ''}`) ?? '' } : null,
            latest: m?.latestVersion ?? null,
            latestNote: m ? (notes.get(m.id) ?? null) : null,
            hasPicture: !!m?.thumbnailAt,
          };
        }),
    };
  });

  // ---- a module's versions, through the layout --------------------------------
  app.get<{ Params: { id: string; placedId: string } }>('/api/layouts/:id/shared-modules/:placedId/versions', { config: TOKEN_READ }, async (req, reply) => {
    const user = requireUser(req);
    const { role } = await resolveResourceRole(user.id, 'layout', req.params.id);
    if (role === null) return reply.code(404).send({ error: 'not_found' });
    const row = await placedRow(req.params.id, req.params.placedId);
    if (!row || row.state !== 'shared') return reply.code(404).send({ error: 'not_found' });
    const versions = await db
      .select({
        version: schema.moduleVersions.version,
        note: schema.moduleVersions.note,
        createdAt: schema.moduleVersions.createdAt,
        authorId: schema.moduleVersions.authorId,
        authorName: schema.users.displayName,
      })
      .from(schema.moduleVersions)
      .leftJoin(schema.users, eq(schema.users.id, schema.moduleVersions.authorId))
      .where(eq(schema.moduleVersions.moduleId, row.moduleId))
      .orderBy(desc(schema.moduleVersions.version));
    return {
      placed: row.version,
      versions: versions.map((v) => ({
        version: v.version,
        note: v.note,
        createdAt: v.createdAt.getTime(),
        author: v.authorId && v.authorName !== null ? nameFor(user, v.authorId, v.authorName) : null,
      })),
    };
  });

  app.get<{ Params: { id: string; placedId: string; n: string } }>(
    '/api/layouts/:id/shared-modules/:placedId/versions/:n/snapshot',
    { config: TOKEN_READ },
    async (req, reply) => {
      const user = requireUser(req);
      const { role } = await resolveResourceRole(user.id, 'layout', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });
      const row = await placedRow(req.params.id, req.params.placedId);
      const n = versionNumber(req.params.n);
      // No longer shared: only the version the layout already holds (its parts are in the layout anyway).
      if (!row || n === null || row.state === 'gone' || (row.state === 'unshared' && n !== row.version)) return reply.code(404).send({ error: 'not_found' });
      const bytes = await versionBytes(row.moduleId, n);
      if (!bytes) return reply.code(404).send({ error: 'not_found' });
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Cache-Control', 'private, max-age=3600');
      return reply.send(Buffer.from(bytes));
    },
  );

  /** The placed module as the layout's document has it now (the room is opened for it when nobody is in it). */
  async function placedInDoc(layoutId: string, placedId: string): Promise<SidecarModule | null> {
    const session = await docHub.getOrCreate(layoutId);
    const cache = readSidecarCache(session.doc);
    const list = Array.isArray(cache?.modules) ? (cache.modules as SidecarModule[]) : [];
    const found = list.find((m) => m && m.id === placedId) ?? null;
    await docHub.settle(session);
    return found;
  }

  /** Put `version` (the newest when null) of the module `mod` follows in its place, for `user`. */
  async function apply(
    user: User,
    layoutId: string,
    layout: LayoutOwner,
    mod: SidecarModule,
    version: number | null,
    again: boolean,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const moduleId = typeof mod.libraryModuleId === 'string' ? mod.libraryModuleId : '';
    if (!moduleId) return { status: 409, body: { error: 'not_linked' } };
    const shared = sharedPlaced(mod);
    if (shared) {
      // A shared module follows its owner only while it's still shared with the layout's owner.
      const state = await stateFor(layout, moduleId);
      if (state !== 'shared') return { status: 409, body: { error: state === 'gone' ? 'module_gone' : 'no_longer_shared', state } };
    } else if ((await resolveResourceRole(user.id, 'module', moduleId)).role === null) {
      // An ordinary linked module: only someone who can see its library copy.
      return { status: 404, body: { error: 'module_not_found' } };
    }
    const lib = await db
      .select({ latestVersion: schema.modules.latestVersion, ownerUserId: schema.modules.ownerUserId, ownerOrgId: schema.modules.ownerOrgId })
      .from(schema.modules)
      .where(eq(schema.modules.id, moduleId))
      .get();
    if (!lib) return { status: 409, body: { error: 'module_gone' } };
    const want = version ?? lib.latestVersion;
    if (want < 1) return { status: 409, body: { error: 'version_not_found' } };
    const partOf = await partGeometry(app, {
      userIds: [lib.ownerUserId, layout.ownerUserId, user.id],
      orgIds: [lib.ownerOrgId, layout.ownerOrgId],
    });
    const r = await applyVersion(layoutId, mod.id, moduleId, want, partOf, { again });
    if (!r.ok) return { status: r.error === 'version_not_found' ? 404 : 409, body: { error: r.error } };
    if (r.changed) {
      await writeAuditEvent({
        layoutId,
        userId: user.id,
        eventType: 'edit',
        payload: { sharedModule: moduleId, placedId: mod.id, from: r.from, version: r.version, parts: r.parts },
      });
    }
    return { status: 200, body: { ok: true, placedId: mod.id, changed: r.changed, version: r.version, from: r.from, parts: r.parts } };
  }

  // ---- apply a version -----------------------------------------------------------
  app.post<{ Params: { id: string; placedId: string }; Body: { version?: unknown; again?: unknown } }>(
    '/api/layouts/:id/shared-modules/:placedId/apply',
    { config: { ...TOKEN_WRITE, rateLimit: perPerson(60, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      const { role } = await resolveResourceRole(user.id, 'layout', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });
      if (!hasAtLeast(role, 'editor')) return reply.code(403).send({ error: 'forbidden' });
      const body = req.body ?? {};
      const version = body.version === undefined || body.version === null ? null : versionNumber(body.version);
      if (body.version !== undefined && body.version !== null && version === null) return reply.code(400).send({ error: 'invalid_version' });
      const layout = await layoutOwner(req.params.id);
      if (!layout) return reply.code(404).send({ error: 'not_found' });
      const mod = await placedInDoc(req.params.id, req.params.placedId);
      if (!mod) return reply.code(404).send({ error: 'not_placed' });
      const r = await apply(user, req.params.id, layout, mod, version, body.again === true);
      return reply.code(r.status).send(r.body);
    },
  );

  // ---- update all ------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/api/layouts/:id/shared-modules/apply-all',
    { config: { ...TOKEN_WRITE, rateLimit: perPerson(20, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      const { role } = await resolveResourceRole(user.id, 'layout', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });
      if (!hasAtLeast(role, 'editor')) return reply.code(403).send({ error: 'forbidden' });
      const layout = await layoutOwner(req.params.id);
      if (!layout) return reply.code(404).send({ error: 'not_found' });
      const session = await docHub.getOrCreate(req.params.id);
      await syncLayoutSharedModules(req.params.id, session.doc);
      const cache = readSidecarCache(session.doc);
      const list = (Array.isArray(cache?.modules) ? (cache.modules as SidecarModule[]) : []).filter((m) => sharedPlaced(m));
      await docHub.settle(session);
      const updated: { placedId: string; version: number; from: number | null }[] = [];
      const skipped: { placedId: string; error: string }[] = [];
      for (const mod of list) {
        const r = await apply(user, req.params.id, layout, mod, null, false);
        if (r.status !== 200) skipped.push({ placedId: mod.id, error: String(r.body.error) });
        else if (r.body.changed) updated.push({ placedId: mod.id, version: r.body.version as number, from: r.body.from as number | null });
      }
      return { ok: true, updated, skipped };
    },
  );

  // ---- make it mine ------------------------------------------------------------------
  app.post<{ Params: { id: string; placedId: string } }>(
    '/api/layouts/:id/shared-modules/:placedId/detach',
    { config: { ...TOKEN_WRITE, rateLimit: perPerson(60, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      const { role } = await resolveResourceRole(user.id, 'layout', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });
      // The layout's owner; a club's admins and managers for a club's layout.
      if (!hasAtLeast(role, 'owner')) return reply.code(403).send({ error: 'only_the_layouts_owner' });
      const r = await detachModule(req.params.id, req.params.placedId);
      if (!r.ok) return reply.code(404).send({ error: r.error });
      if (r.changed) {
        await writeAuditEvent({ layoutId: req.params.id, userId: user.id, eventType: 'edit', payload: { sharedModuleDetached: req.params.placedId } });
      }
      return { ok: true, changed: r.changed };
    },
  );
}
