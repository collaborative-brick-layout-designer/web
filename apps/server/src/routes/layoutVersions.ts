// A layout's version history (history/layoutVersions.ts).
//
//   GET  /api/layouts/:id/versions                     the list, newest first (anyone who can see the layout)
//   GET  /api/layouts/:id/versions/:vid/snapshot       one version's document, to look at (Yjs state)
//   POST /api/layouts/:id/versions                     {reason?: "manual"|"before-import"|"before-merge", label?}: keep one now (editors)
//   POST /api/layouts/:id/versions/:vid/restore        put it back, as one change; a version of the layout as it was is kept first (editors)
//   POST /api/layouts/:id/versions/:vid/copy           {title?, orgSlug?}: a new layout from it (anyone who may copy the layout)
//   GET  /api/version-history/status                   {enabled}: whether new versions are being kept (any signed-in user; the apps hide their entry points when not)
//   GET  /api/admin/version-history                    the settings, for Admin › Backups (global admins)
//   PATCH /api/admin/version-history                   {enabled?, limits?: {key: whole number | null}}: change them; null puts one back to its default
//
// Switched off (Admin › Backups, or VERSION_HISTORY_ENABLED): nothing new is
// kept, "keep a version now" and restore answer 409 version_history_off
// (a keep before an import or paste answers 200 {id: null}, so those go on);
// the list, a version's document and "copy out" keep working.
//
// The desktop reaches them with its sign-in token (layouts:read / layouts:write).

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { db, schema } from '../db/index.js';
import { requireGlobalAdmin, requireUser } from '../auth/cookie.js';
import { hasAtLeast, resolveResourceRole } from '../access/resolveResourceRole.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { docHub } from '../ws/docHub.js';
import { SERVER_ORIGIN } from '../sharedModules/apply.js';
import { syncLayoutSharedModules, syncStoredLayout } from '../sharedModules/placed.js';
import { checkGrowth, type Subject } from '../limits/limits.js';
import { destinationOrg } from './owners.js';
import { currentDocBytes, prepareLayoutCopy } from './layouts.js';
import { clampTitle, titleTooLong, trimmed } from '../utils/validate.js';
import { perPerson } from '../utils/rateLimits.js';
import { CLIENT_REASONS, LABEL_MAX, listVersions, takeVersion, versionState, type VersionReason } from '../history/layoutVersions.js';
import { syncDocTo } from '../history/syncDoc.js';
import { ensureRecordMaps } from '@cld/ydoc';
import { HISTORY_SETTINGS, historySettings, saveHistorySettings } from '../history/settings.js';

async function adminView() {
  const s = await historySettings();
  return {
    enabled: s.enabled,
    enabledSetting: s.enabledSetting,
    enabledForcedBy: s.enabledForcedBy,
    limits: HISTORY_SETTINGS.map((i) => ({ ...i, value: s.limits[i.key] })),
  };
}

const READ = { apiToken: 'layouts:read' } as const;
const WRITE = { apiToken: 'layouts:write' } as const;
const ID_RE = /^[0-9a-f-]{36}$/;

export async function layoutVersionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/version-history/status', { config: { ...READ, rateLimit: perPerson(120, '1 minute') } }, async (req) => {
    requireUser(req);
    return { enabled: (await historySettings()).enabled };
  });

  app.get('/api/admin/version-history', { config: { rateLimit: perPerson(120, '1 minute') } }, async (req) => {
    requireGlobalAdmin(req);
    return adminView();
  });

  // codeql[js/missing-rate-limiting] - rate limited via Fastify config.rateLimit
  app.patch<{ Body: { enabled?: unknown; limits?: unknown } }>('/api/admin/version-history', { config: { rateLimit: perPerson(60, '1 minute') } }, async (req, reply) => {
    const me = requireGlobalAdmin(req);
    const body = req.body ?? {};
    const err = await saveHistorySettings(body, me.id);
    if (err) return reply.code(400).send({ error: 'invalid_settings', message: err });
    await writeAuditEvent({ resourceKind: 'platform_settings', resourceId: 'history', userId: me.id, eventType: 'admin_history_settings', payload: { enabled: body.enabled, limits: body.limits } });
    return adminView();
  });

  app.get<{ Params: { id: string } }>('/api/layouts/:id/versions', { config: { ...READ, rateLimit: perPerson(120, '1 minute') } }, async (req, reply) => {
    const user = requireUser(req);
    const { role } = await resolveResourceRole(user.id, 'layout', req.params.id);
    if (!hasAtLeast(role, 'viewer')) return reply.code(404).send({ error: 'not_found' });
    return { versions: await listVersions(req.params.id), canRestore: hasAtLeast(role, 'editor'), enabled: (await historySettings()).enabled };
  });

  app.get<{ Params: { id: string; vid: string } }>(
    '/api/layouts/:id/versions/:vid/snapshot',
    { config: { ...READ, rateLimit: perPerson(120, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      const { role } = await resolveResourceRole(user.id, 'layout', req.params.id);
      if (!hasAtLeast(role, 'viewer') || !ID_RE.test(req.params.vid)) return reply.code(404).send({ error: 'not_found' });
      const state = await versionState(req.params.id, req.params.vid);
      if (!state) return reply.code(404).send({ error: 'not_found' });
      reply.header('content-type', 'application/octet-stream');
      reply.header('cache-control', 'private, max-age=86400, immutable');
      return reply.send(Buffer.from(state));
    },
  );

  // codeql[js/missing-rate-limiting] - rate limited via Fastify config.rateLimit
  app.post<{ Params: { id: string }; Body: { reason?: unknown; label?: unknown } }>(
    '/api/layouts/:id/versions',
    { config: { ...WRITE, rateLimit: perPerson(30, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      const { role } = await resolveResourceRole(user.id, 'layout', req.params.id);
      if (!hasAtLeast(role, 'viewer')) return reply.code(404).send({ error: 'not_found' });
      if (!hasAtLeast(role, 'editor')) return reply.code(403).send({ error: 'forbidden' });
      const reason = (req.body?.reason ?? 'manual') as VersionReason;
      if (!CLIENT_REASONS.includes(reason)) return reply.code(400).send({ error: 'invalid_reason' });
      if (!(await historySettings()).enabled) {
        // An import or a paste goes on without its safety copy; a version asked for by hand is refused.
        if (reason !== 'manual') return { id: null };
        return reply.code(409).send({ error: 'version_history_off', message: 'Version history is switched off on this server, so no new versions are kept.' });
      }
      const rawLabel = req.body?.label;
      if (rawLabel !== undefined && rawLabel !== null && typeof rawLabel !== 'string') return reply.code(400).send({ error: 'invalid_label' });
      const label = typeof rawLabel === 'string' ? rawLabel.trim().slice(0, LABEL_MAX) || null : null;
      const row = await db.select({ snapshot: schema.layouts.docSnapshot }).from(schema.layouts).where(eq(schema.layouts.id, req.params.id)).get();
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const state = await currentDocBytes(req.params.id, row.snapshot as Uint8Array);
      const id = await takeVersion({ layoutId: req.params.id, state, reason, by: user.id, label, editors: [{ id: user.id, name: user.displayName }] });
      if (!id) return reply.code(404).send({ error: 'not_found' });
      return reply.code(201).send({ id });
    },
  );

  // codeql[js/missing-rate-limiting] - rate limited via Fastify config.rateLimit
  app.post<{ Params: { id: string; vid: string } }>(
    '/api/layouts/:id/versions/:vid/restore',
    { config: { ...WRITE, rateLimit: perPerson(10, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      const layoutId = req.params.id;
      const { role } = await resolveResourceRole(user.id, 'layout', layoutId);
      if (!hasAtLeast(role, 'viewer') || !ID_RE.test(req.params.vid)) return reply.code(404).send({ error: 'not_found' });
      if (!hasAtLeast(role, 'editor')) return reply.code(403).send({ error: 'forbidden' });
      if (!(await historySettings()).enabled) {
        return reply.code(409).send({ error: 'version_history_off', message: 'Version history is switched off on this server, so a version can’t be put back. You can still copy it out as a new layout.' });
      }
      const state = await versionState(layoutId, req.params.vid);
      if (!state) return reply.code(404).send({ error: 'not_found' });
      const target = new Y.Doc();
      try {
        Y.applyUpdate(target, state);
      } catch {
        target.destroy();
        return reply.code(422).send({ error: 'version_unreadable' });
      }
      const session = await docHub.getOrCreate(layoutId);
      try {
        // The layout as it is now, first: restoring that one undoes this.
        const safety = await takeVersion({ layoutId, state: Y.encodeStateAsUpdate(session.doc), reason: 'before-restore', by: user.id, editors: [{ id: user.id, name: user.displayName }] });
        // (A version from before there were some of the record maps: they are emptied, not taken away, so two people's next first records both stay.)
        ensureRecordMaps(target);
        syncDocTo(session.doc, target, SERVER_ORIGIN);
        await session.flushBatch();
        await syncLayoutSharedModules(layoutId, session.doc);
        await writeAuditEvent({ layoutId, userId: user.id, eventType: 'restore_version', payload: { versionId: req.params.vid, safety } });
        return { ok: true, safety };
      } finally {
        target.destroy();
        await docHub.settle(session);
      }
    },
  );

  // codeql[js/missing-rate-limiting] - rate limited via Fastify config.rateLimit
  app.post<{ Params: { id: string; vid: string }; Body: { title?: string; orgSlug?: string } }>(
    '/api/layouts/:id/versions/:vid/copy',
    { config: { ...WRITE, rateLimit: perPerson(30, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      const { role } = await resolveResourceRole(user.id, 'layout', req.params.id);
      if (!hasAtLeast(role, 'viewer') || !ID_RE.test(req.params.vid)) return reply.code(404).send({ error: 'not_found' });
      const src = await db.select().from(schema.layouts).where(eq(schema.layouts.id, req.params.id)).get();
      const state = src ? await versionState(req.params.id, req.params.vid) : null;
      if (!src || !state) return reply.code(404).send({ error: 'not_found' });
      const dest = await destinationOrg(user.id, req.body?.orgSlug);
      if (!dest.ok) return reply.code(dest.code).send({ error: dest.error, permission: dest.permission });
      if (titleTooLong(trimmed(req.body?.title))) return reply.code(400).send({ error: 'invalid_title' });
      const title = trimmed(req.body?.title) || clampTitle(`${src.title} (earlier version)`);
      const owner: Subject = dest.orgId ? { kind: 'org', id: dest.orgId } : { kind: 'user', id: user.id };
      const refusal = await checkGrowth({ actor: user, owner, add: { layouts: 1, bytes: state.length + ((src.sidecarSnapshot as Uint8Array | null)?.length ?? 0) } });
      if (refusal) return reply.code(refusal.status).send(refusal.body);
      const prepared = await prepareLayoutCopy(src, { title, ownerUserId: dest.orgId ? null : user.id, ownerOrgId: dest.orgId, createdBy: user.id }, state);
      await db.insert(schema.layouts).values(prepared.values);
      await prepared.copyBackground();
      await syncStoredLayout(prepared.values.id);
      return reply.code(201).send({ id: prepared.values.id, title });
    },
  );
}
