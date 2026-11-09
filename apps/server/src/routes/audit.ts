// Read-side endpoints for the audit log.
//
// Two query shapes:
//   GET /api/layouts/:id/audit          → layout-scoped (legacy; what
//                                         the layout audit panel uses)
//   GET /api/audit?kind=...&id=...      → generic; works for layouts +
//                                         custom_parts + modules + orgs
//
// Both require the caller to have at least viewer access on the
// target resource (the same access check as the resource itself, so
// there's no extra information leak vs. just opening it).

import type { FastifyInstance } from 'fastify';
import { and, desc, eq, or, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { requireUser } from '../auth/cookie.js';
import { hasAtLeast, resolveResourceRole, type ResourceKind } from '../access/resolveResourceRole.js';
import type { AuditResourceKind } from '../audit/writeAuditEvent.js';
import { clubAccess } from '../access/clubPermissions.js';
import { nameFor, publicName } from '../utils/publicName.js';
import { maskPayloadEmails } from '../utils/maskEmail.js';

/** Batch-load display names for a set of userIds. Returns a map userId→name. */
async function loadUserNames(viewer: { id: string; isGlobalAdmin: boolean }, userIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: schema.users.id, displayName: schema.users.displayName, email: schema.users.email })
    .from(schema.users)
    .where(inArray(schema.users.id, ids));
  // Site admins (and the person themselves) see the stored name, falling
  // back to the email; everyone else never sees an address.
  return new Map(rows.map((r) => [r.id, nameFor(viewer, r.id, r.displayName) || (viewer.isGlobalAdmin ? r.email : publicName(r.id, ''))]));
}

interface AuditQuery {
  kind?: AuditResourceKind;
  id?: string;
  /** Pagination — newest first. Defaults to 100, max 500. */
  limit?: string;
}

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  // ---- layout-scoped (the editor's audit panel) -------------------------
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/layouts/:id/audit',
    async (req, reply) => {
      const user = requireUser(req);
      const { role } = await resolveResourceRole(user.id, 'layout', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });

      const limit = clampLimit(req.query.limit);
      const rows = await db
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.layoutId, req.params.id))
        .orderBy(desc(schema.auditEvents.createdAt))
        .limit(limit);
      const names = await loadUserNames(user, rows.map((r) => r.userId));
      return {
        events: rows.map((r) => toWire(r, names, user)),
      };
    },
  );

  // ---- org-admin: events touching resources owned by this org ----------
  // Org admins see layout events for layouts the org owns, plus resource
  // events where resourceKind='org' and resourceId matches.
  app.get<{ Params: { slug: string }; Querystring: { limit?: string; offset?: string } }>(
    '/api/orgs/:slug/audit',
    async (req, reply) => {
      const user = requireUser(req);
      const org = await db
        .select({ id: schema.orgs.id })
        .from(schema.orgs)
        .where(eq(schema.orgs.slug, req.params.slug.toLowerCase()))
        .get();
      if (!org) return reply.code(404).send({ error: 'not_found' });
      // The club's history is for the people who run it: inviting people, or managing members and roles.
      const membership = await clubAccess(user.id, org.id);
      if (!membership || !(membership.permissions.has('invite') || membership.permissions.has('manage_members'))) {
        return reply.code(403).send({ error: 'forbidden', permission: 'invite' });
      }
      const limit = clampLimit(req.query.limit);
      const offset = clampOffset(req.query.offset);

      // Layout ids owned by this org.
      const ownedLayouts = await db
        .select({ id: schema.layouts.id })
        .from(schema.layouts)
        .where(eq(schema.layouts.ownerOrgId, org.id));
      const layoutIds = ownedLayouts.map((l) => l.id);

      const where = layoutIds.length > 0
        ? or(
            inArray(schema.auditEvents.layoutId, layoutIds),
            and(eq(schema.auditEvents.resourceKind, 'org'), eq(schema.auditEvents.resourceId, org.id)),
          )
        : and(eq(schema.auditEvents.resourceKind, 'org'), eq(schema.auditEvents.resourceId, org.id));

      const rows = await db
        .select()
        .from(schema.auditEvents)
        .where(where)
        .orderBy(desc(schema.auditEvents.createdAt))
        .limit(limit)
        .offset(offset);
      const names = await loadUserNames(user, rows.map((r) => r.userId));
      return { events: rows.map((r) => toWire(r, names, user)), limit, offset };
    },
  );

  // ---- generic ----------------------------------------------------------
  app.get<{ Querystring: AuditQuery }>('/api/audit', async (req, reply) => {
    const user = requireUser(req);
    const kind = req.query.kind;
    const id = req.query.id;
    if (!kind || !id) {
      return reply.code(400).send({ error: 'kind_and_id_required' });
    }
    if (!isResolvableKind(kind)) {
      return reply.code(400).send({ error: 'unsupported_kind' });
    }
    const { role } = await resolveResourceRole(user.id, kind, id);
    if (role === null) return reply.code(404).send({ error: 'not_found' });
    if (!hasAtLeast(role, 'viewer')) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const limit = clampLimit(req.query.limit);
    const rows = await (kind === 'layout'
      ? db
          .select()
          .from(schema.auditEvents)
          .where(eq(schema.auditEvents.layoutId, id))
          .orderBy(desc(schema.auditEvents.createdAt))
          .limit(limit)
      : db
          .select()
          .from(schema.auditEvents)
          .where(
            and(
              eq(schema.auditEvents.resourceKind, kind),
              eq(schema.auditEvents.resourceId, id),
            ),
          )
          .orderBy(desc(schema.auditEvents.createdAt))
          .limit(limit));
    const names = await loadUserNames(user, rows.map((r) => r.userId));
    return { events: rows.map((r) => toWire(r, names, user)) };
  });
}

function isResolvableKind(kind: AuditResourceKind): kind is ResourceKind {
  return (
    kind === 'layout' ||
    kind === 'custom_part' ||
    kind === 'module' ||
    kind === 'org'
  );
}

function clampLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function clampOffset(raw: string | undefined): number {
  const n = raw ? parseInt(raw, 10) : 0;
  // Past what SQLite holds (a 64-bit integer) it refused the query with a 500.
  return Number.isFinite(n) && n >= 0 ? Math.min(n, Number.MAX_SAFE_INTEGER) : 0;
}

function toWire(row: typeof schema.auditEvents.$inferSelect, names: Map<string, string>, viewer: { isGlobalAdmin: boolean }) {
  return {
    id: row.id,
    layoutId: row.layoutId,
    resourceKind: row.resourceKind,
    resourceId: row.resourceId,
    userId: row.userId,
    // An erased account's rows read "Deleted user #abc123".
    userName: row.userId ? (names.get(row.userId) ?? null) : row.actorLabel,
    eventType: row.eventType,
    // Addresses in a payload (who was invited) are for site admins only;
    // club and layout managers see a masked form. So is the sender's app
    // ("Firefox on Linux") on a refused live update.
    payload: viewer.isGlobalAdmin ? safeParse(row.payload) : withoutClient(maskPayloadEmails(safeParse(row.payload))),
    docVersion: row.docVersion,
    createdAt: row.createdAt.getTime(),
  };
}

function withoutClient(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !('client' in payload)) return payload;
  const { client: _client, ...rest } = payload as Record<string, unknown>;
  return rest;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return { _parseError: true, raw: json };
  }
}
