// Custom parts (Phase 6.5).
//
// User- or org-uploaded brick definitions. The wire shape mirrors the
// catalog endpoint where possible: `partNumber`, `displayName`, sprite
// URL. The XML and sprite blobs are stored in SQLite — for v1 the parts
// catalog stays single-user / single-org scoped; a follow-up pass can
// fold custom parts into the global `/api/parts/catalog` response so
// the editor parts panel surfaces them inline.
//
// Sharing tiers mirror layouts: owner / editor / viewer; org ownership
// available; explicit collaborators via `custom_part_collaborators`.

import { stripImportSource, withNotListed } from '../utils/partXml.js';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { parsePartXml, xmlForGifSprite } from '@cld/parts-catalog';
import { db, schema } from '../db/index.js';
import { checkGrowth, type Subject } from '../limits/limits.js';
import { recordUpload } from '../metrics/usage.js';
import { requireUser } from '../auth/cookie.js';
import { isDemoUser } from '../demo/demoAccount.js';
import { hasAtLeast, resolveResourceRole, type Role } from '../access/resolveResourceRole.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { trimmed } from '../utils/validate.js';
import { matchesOwner, ownerLookup, resolveOwnerFilter } from './owners.js';
import { clubAccess, clubAccessMap, clubThingAccess } from '../access/clubPermissions.js';
import { dropModuleFromCollections } from './collections.js';
import { emailsVisible, nameFor } from '../utils/publicName.js';
import { creditLookup, withCredits } from './credits.js';
import { isImageOfType, MAX_SPRITE_SIDE, pngSize } from '../images/sniff.js';
import { forgetSetShares, revokeSetParts, setPartsFor, setsBringing } from '../access/setShares.js';
import { partIdsThroughModules } from '../access/moduleShares.js';

export interface CreatePartBody {
  partNumber: string;
  displayName: string;
  /** Base64-encoded XML payload. Bodies stay in JSON for simplicity. */
  xmlBase64: string;
  /** Base64-encoded sprite (gif or png); empty or absent for a set. */
  spriteBase64?: string;
  /** Absent for a set (a `<group>` XML): its parts draw it. */
  spriteMime?: 'image/gif' | 'image/png';
  /** When set, the part is org-owned. Caller must be a member of the org. */
  orgSlug?: string;
  /** Parts-browser category label. Defaults to 'Custom' for a part, 'My sets' for a set. */
  category?: string;
}

// 4MB cap on a sprite + XML (combined) — generous for legitimate parts,
// still bounded so a malicious user can't bloat the database.
const MAX_PART_BLOB_BYTES = 4 * 1024 * 1024;

/**
 * A new custom part for `user` (or the club `body.orgSlug` names): the
 * checks and writes of POST /api/custom-parts, shared with the website's
 * model import (imports/apply.ts).
 */
export async function createCustomPart(
  user: ReturnType<typeof requireUser>,
  body: CreatePartBody,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const out = (status: number, payload: Record<string, unknown>) => ({ status, body: payload });
  if (isDemoUser(user)) return out(403, { error: 'demo_account_cannot_upload_parts' });

  const parsed = parsePartBody(body);
  if ('error' in parsed) return out(parsed.status, { error: parsed.error });
  const { partNumber, displayName, xmlBlob, spriteBlob, spriteMime } = parsed;
  if (parsed.namesItself) return out(400, { error: 'set_named_like_its_part' });

  let ownerUserId: string | null = user.id;
  let ownerOrgId: string | null = null;
  if (body.orgSlug) {
    const org = await db
      .select({ id: schema.orgs.id })
      .from(schema.orgs)
      .where(eq(schema.orgs.slug, body.orgSlug.toLowerCase()))
      .get();
    if (!org) return out(404, { error: 'org_not_found' });
    const membership = await clubAccess(user.id, org.id);
    if (!membership) return out(403, { error: 'not_an_org_member' });
    if (!membership.permissions.has('add_parts')) return out(403, { error: 'only_club_admins_can_add', permission: 'add_parts' });
    ownerUserId = null;
    ownerOrgId = org.id;
  }

  // Reject duplicate `partNumber` for the same owner. (No DB unique
  // constraint because owner is split across two columns; we check
  // explicitly here.)
  const dupQuery = ownerOrgId
    ? db
        .select()
        .from(schema.customParts)
        .where(
          and(
            eq(schema.customParts.ownerOrgId, ownerOrgId),
            eq(schema.customParts.partNumber, partNumber),
          ),
        )
    : db
        .select()
        .from(schema.customParts)
        .where(
          and(
            eq(schema.customParts.ownerUserId, user.id),
            eq(schema.customParts.partNumber, partNumber),
          ),
        );
  const dup = await dupQuery.get();
  if (dup) return out(409, { error: 'part_number_taken' });

  const owner: Subject = ownerOrgId ? { kind: 'org', id: ownerOrgId } : { kind: 'user', id: user.id };
  const partBytes = xmlBlob.length + spriteBlob.length;
  const refusal = await checkGrowth({ actor: user, owner, add: { customParts: 1, bytes: partBytes }, uploadBytes: partBytes });
  if (refusal) return out(refusal.status, refusal.body as Record<string, unknown>);
  recordUpload(user.id, owner, partBytes);

  const id = randomUUID();
  const now = new Date();
  // Sets go in "My sets" whichever app made them (the website names it; a desktop may not).
  const category = trimmed(body.category) || (spriteMime === '' ? 'My sets' : 'Custom');
  await db.insert(schema.customParts).values({
    id,
    partNumber,
    displayName,
    category,
    ownerUserId,
    ownerOrgId,
    createdBy: user.id,
    xmlBlob,
    spriteBlob,
    spriteMime,
    createdAt: now,
    updatedAt: now,
  });
  await writeAuditEvent({
    resourceKind: 'custom_part',
    resourceId: id,
    userId: user.id,
    eventType: 'create',
    payload: { partNumber, displayName, owner: ownerOrgId ? { kind: 'org', id: ownerOrgId } : { kind: 'user', id: user.id } },
  });
  return out(201, { id, partNumber, displayName });
}

export async function customPartRoutes(app: FastifyInstance): Promise<void> {
  // ---- list parts the user can see ---------------------------------------
  // Desktop sync (P1b): API tokens with parts:read may list and download
  // custom parts, and with parts:write upload them.
  // Each part comes with its owner and the caller's role, narrowed by
  // ?owner=all|me|<club slug> like the other home-page lists.
  app.get<{ Querystring: { owner?: string } }>('/api/custom-parts', { config: { apiToken: 'parts:read' } }, async (req, reply) => {
    const user = requireUser(req);
    // A club the caller isn't in is not found.
    const filter = await resolveOwnerFilter(user.id, req.query?.owner);
    if (!filter) return reply.code(404).send({ error: 'org_not_found' });
    // Metadata columns only — never the xml/sprite blobs.
    const personal = await db
      .select(partListColumns)
      .from(schema.customParts)
      .where(eq(schema.customParts.ownerUserId, user.id));
    const orgOwned = await db
      .select({ part: partListColumns })
      .from(schema.orgMembers)
      .innerJoin(
        schema.customParts,
        eq(schema.customParts.ownerOrgId, schema.orgMembers.orgId),
      )
      .where(eq(schema.orgMembers.userId, user.id));
    const shared = await db
      .select({ part: partListColumns, role: schema.customPartCollaborators.role })
      .from(schema.customPartCollaborators)
      .innerJoin(
        schema.customParts,
        eq(schema.customParts.id, schema.customPartCollaborators.customPartId),
      )
      .where(eq(schema.customPartCollaborators.userId, user.id));

    const seen = new Set<string>();
    const all: (ReturnType<typeof toListItem> & { role: Role })[] = [];
    for (const p of personal) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      all.push({ ...toListItem(p), role: 'owner' });
    }
    const access = await clubAccessMap(user.id);
    for (const { part } of orgOwned) {
      if (seen.has(part.id)) continue;
      seen.add(part.id);
      const a = access.get(part.ownerOrgId ?? '');
      all.push({ ...toListItem(part), role: a ? clubThingAccess(a, 'custom_part') : 'viewer' });
    }
    for (const { part, role } of shared) {
      if (seen.has(part.id)) continue;
      seen.add(part.id);
      all.push({ ...toListItem(part), role });
    }
    // Parts that came along with a module shared with the caller or a club of theirs.
    const along = (await partIdsThroughModules(user.id)).filter((id) => !seen.has(id));
    for (let i = 0; i < along.length; i += 400) {
      const rows = await db.select(partListColumns).from(schema.customParts).where(inArray(schema.customParts.id, along.slice(i, i + 400)));
      for (const part of rows) {
        seen.add(part.id);
        all.push({ ...toListItem(part), role: 'viewer' });
      }
    }
    const shown = all.filter((p) => matchesOwner(p, filter, user.id));
    const ownerOf = await ownerLookup(shown);
    return { parts: await withCredits('custom-part', shown.map((p) => ({ ...p, owner: ownerOf(p) })), user.id) };
  });

  // ---- get one part (metadata + role; sprite via separate URL) -----------
  app.get<{ Params: { id: string } }>('/api/custom-parts/:id', async (req, reply) => {
    const user = requireUser(req);
    const { role } = await resolveResourceRole(user.id, 'custom_part', req.params.id);
    if (role === null) return reply.code(404).send({ error: 'not_found' });
    const part = await db
      .select(partListColumns)
      .from(schema.customParts)
      .where(eq(schema.customParts.id, req.params.id))
      .get();
    if (!part) return reply.code(404).send({ error: 'not_found' });
    const credit = (await creditLookup('custom-part', [part.id], user.id))(part.id);
    return { part: { ...toListItem(part), credit }, role };
  });

  // ---- get sprite (raw bytes) --------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/api/custom-parts/:id/sprite',
    { config: { apiToken: 'parts:read' } },
    async (req, reply) => {
      const user = requireUser(req);
      const { role } = await resolveResourceRole(user.id, 'custom_part', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });
      const part = await db
        .select({
          spriteBlob: schema.customParts.spriteBlob,
          spriteMime: schema.customParts.spriteMime,
        })
        .from(schema.customParts)
        .where(eq(schema.customParts.id, req.params.id))
        .get();
      if (!part) return reply.code(404).send({ error: 'not_found' });
      reply.header('Cache-Control', 'private, max-age=300');
      // A set has no picture of its own (its parts draw it): an empty one,
      // so an older desktop or a list still gets an image.
      if (isSetRow(part)) {
        reply.header('Content-Type', 'image/gif');
        return reply.send(EMPTY_GIF);
      }
      reply.header('Content-Type', part.spriteMime);
      return reply.send(Buffer.from(part.spriteBlob as Uint8Array));
    },
  );

  // ---- get XML (text) ----------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/api/custom-parts/:id/xml',
    { config: { apiToken: 'parts:read' } },
    async (req, reply) => {
      const user = requireUser(req);
      const { role } = await resolveResourceRole(user.id, 'custom_part', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });
      const part = await db
        .select({ xmlBlob: schema.customParts.xmlBlob })
        .from(schema.customParts)
        .where(eq(schema.customParts.id, req.params.id))
        .get();
      if (!part) return reply.code(404).send({ error: 'not_found' });
      // User-uploaded bytes: never let a browser render them as a
      // document on our origin (an XHTML payload served inline as
      // application/xml runs script). Plain text, forced download.
      reply.header('Content-Type', 'text/plain; charset=utf-8');
      reply.header('Content-Disposition', 'attachment; filename="part.xml"');
      reply.header('X-Content-Type-Options', 'nosniff');
      // Never the importer's local path, even for a part stored before
      // uploads were stripped (or copied from one).
      return reply.send(stripImportSource(Buffer.from(part.xmlBlob as Uint8Array)).toString('utf8'));
    },
  );

  // ---- create -------------------------------------------------------------
  app.post<{ Body: CreatePartBody }>('/api/custom-parts', { config: { apiToken: 'parts:write' } }, async (req, reply) => {
    const user = requireUser(req);
    const made = await createCustomPart(user, req.body ?? ({} as CreatePartBody));
    return reply.code(made.status).send(made.body);
  });

  // ---- replace ------------------------------------------------------------
  // A new XML and sprite for a part, as opening a layout whose copy of the
  // part differs does ("Use the file's"). Same body as create; the owner
  // stays as it is.
  app.put<{ Params: { id: string }; Body: CreatePartBody }>(
    '/api/custom-parts/:id',
    { config: { apiToken: 'parts:write' } },
    async (req, reply) => {
      const user = requireUser(req);
      if (isDemoUser(user)) return reply.code(403).send({ error: 'demo_account_cannot_upload_parts' });
      const { role } = await resolveResourceRole(user.id, 'custom_part', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });
      if (!hasAtLeast(role, 'editor')) return reply.code(403).send({ error: 'forbidden' });
      const parsed = parsePartBody(req.body ?? ({} as CreatePartBody));
      if ('error' in parsed) return reply.code(parsed.status).send({ error: parsed.error });
      const { partNumber, displayName, xmlBlob, spriteBlob, spriteMime } = parsed;

      const current = await db
        .select({
          partNumber: schema.customParts.partNumber,
          ownerUserId: schema.customParts.ownerUserId,
          ownerOrgId: schema.customParts.ownerOrgId,
          bytes: sql<number>`length(${schema.customParts.xmlBlob}) + length(${schema.customParts.spriteBlob})`.mapWith(Number),
        })
        .from(schema.customParts)
        .where(eq(schema.customParts.id, req.params.id))
        .get();
      if (!current) return reply.code(404).send({ error: 'not_found' });
      // Global parts have no owner and aren't limited.
      const owner: Subject | null = current.ownerOrgId
        ? { kind: 'org', id: current.ownerOrgId }
        : current.ownerUserId
          ? { kind: 'user', id: current.ownerUserId }
          : null;
      if (owner) {
        const newBytes = xmlBlob.length + spriteBlob.length;
        const refusal = await checkGrowth({ actor: user, owner, add: { bytes: newBytes - current.bytes }, uploadBytes: newBytes });
        if (refusal) return reply.code(refusal.status).send(refusal.body);
        recordUpload(user.id, owner, newBytes);
      }
      if (partNumber !== current.partNumber) {
        // (Renaming keeps the number, so a set saved before this check can still be renamed.)
        if (parsed.namesItself) return reply.code(400).send({ error: 'set_named_like_its_part' });
        const dup = await db
          .select({ id: schema.customParts.id })
          .from(schema.customParts)
          .where(
            and(
              current.ownerOrgId
                ? eq(schema.customParts.ownerOrgId, current.ownerOrgId)
                : eq(schema.customParts.ownerUserId, current.ownerUserId ?? ''),
              eq(schema.customParts.partNumber, partNumber),
            ),
          )
          .get();
        if (dup) return reply.code(409).send({ error: 'part_number_taken' });
      }

      await db
        .update(schema.customParts)
        .set({
          partNumber,
          displayName,
          ...(trimmed(req.body.category) ? { category: trimmed(req.body.category) } : {}),
          xmlBlob,
          spriteBlob,
          spriteMime,
          updatedAt: new Date(),
        })
        .where(eq(schema.customParts.id, req.params.id));
      await writeAuditEvent({
        resourceKind: 'custom_part',
        resourceId: req.params.id,
        userId: user.id,
        eventType: 'edit',
        payload: { partNumber, displayName },
      });
      return { id: req.params.id, partNumber, displayName };
    },
  );

  // ---- listed, or only used inside sets ------------------------------------
  // BlueBrick's <NotListedInLibrary>: a part that only makes sense inside
  // its sets (a cut piece, a flex half) isn't listed in the Parts panel or
  // placed by itself. Its XML gets (or loses) the tag, so the desktop and
  // vanilla BlueBrick read it the same way.
  app.patch<{ Params: { id: string }; Body: { notListed?: unknown } }>(
    '/api/custom-parts/:id/listing',
    { config: { apiToken: 'parts:write' } },
    async (req, reply) => {
      const user = requireUser(req);
      if (isDemoUser(user)) return reply.code(403).send({ error: 'demo_account_cannot_upload_parts' });
      const { role } = await resolveResourceRole(user.id, 'custom_part', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });
      if (!hasAtLeast(role, 'editor')) return reply.code(403).send({ error: 'forbidden' });
      if (typeof req.body?.notListed !== 'boolean') return reply.code(400).send({ error: 'invalid_input' });
      const part = await db
        .select({ xmlBlob: schema.customParts.xmlBlob, partNumber: schema.customParts.partNumber })
        .from(schema.customParts)
        .where(eq(schema.customParts.id, req.params.id))
        .get();
      if (!part) return reply.code(404).send({ error: 'not_found' });
      const before = Buffer.from(part.xmlBlob as Uint8Array).toString('utf8');
      const after = withNotListed(before, req.body.notListed);
      if (after !== before) {
        await db
          .update(schema.customParts)
          .set({ xmlBlob: Buffer.from(after, 'utf8'), updatedAt: new Date() })
          .where(eq(schema.customParts.id, req.params.id));
        await writeAuditEvent({
          resourceKind: 'custom_part',
          resourceId: req.params.id,
          userId: user.id,
          eventType: 'edit',
          payload: { partNumber: part.partNumber, notListed: req.body.notListed },
        });
      }
      return { id: req.params.id, notListed: req.body.notListed };
    },
  );

  // ---- delete -------------------------------------------------------------
  // The desktop deletes your own part or set with its API token
  // (parts:write, the deletePartsFromDesktop feature), under exactly the
  // website's checks: the owner, or a club role that manages its parts.
  app.delete<{ Params: { id: string } }>(
    '/api/custom-parts/:id',
    { config: { apiToken: 'parts:write' } },
    async (req, reply) => {
      const user = requireUser(req);
      const { role } = await resolveResourceRole(user.id, 'custom_part', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });
      if (!hasAtLeast(role, 'owner')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      // Collections it's in lose it; their curators get a note.
      const gone = await db.select({ id: schema.customParts.id, title: schema.customParts.displayName }).from(schema.customParts).where(eq(schema.customParts.id, req.params.id)).get();
      if (gone) await dropModuleFromCollections(gone, 'deleted', null, user.id, 'part');
      // A set going: the parts it brought along to the people it was shared with go too.
      await revokeSetParts(req.params.id);
      await db.delete(schema.customParts).where(eq(schema.customParts.id, req.params.id));
      await writeAuditEvent({
        resourceKind: 'custom_part',
        resourceId: req.params.id,
        userId: user.id,
        eventType: 'delete',
        payload: {},
      });
      return { ok: true };
    },
  );

  // ---- collaborators (mirror /api/layouts/.../collaborators shape) -------
  app.get<{ Params: { id: string } }>(
    '/api/custom-parts/:id/collaborators',
    async (req, reply) => {
      const user = requireUser(req);
      const { role } = await resolveResourceRole(user.id, 'custom_part', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });

      const collaborators = await db
        .select({
          userId: schema.customPartCollaborators.userId,
          role: schema.customPartCollaborators.role,
          addedAt: schema.customPartCollaborators.addedAt,
          email: schema.users.email,
          displayName: schema.users.displayName,
          avatarUrl: schema.users.avatarUrl,
        })
        .from(schema.customPartCollaborators)
        .innerJoin(schema.users, eq(schema.users.id, schema.customPartCollaborators.userId))
        .where(eq(schema.customPartCollaborators.customPartId, req.params.id));
      const seesEmails = emailsVisible(user, role);
      // Pending invites are addresses only: for the people who manage sharing.
      const invites = seesEmails
        ? await db
            .select()
            .from(schema.customPartInvites)
            .where(and(eq(schema.customPartInvites.customPartId, req.params.id), isNull(schema.customPartInvites.acceptedAt)))
        : [];
      // A set: its own custom parts, which come along when it's shared.
      // A part: who has it only through a shared set, and which. Both are
      // for the people who manage sharing (the owner's other parts and
      // sets aren't everyone's to see); each person sees their own sets.
      const setParts = seesEmails ? await setPartsFor(req.params.id) : [];
      const viaSets = await setsBringing(req.params.id);
      return {
        invites: invites.map((i) => ({ id: i.id, invitedEmail: i.invitedEmail, role: i.role, expiresAt: i.expiresAt.getTime() })),
        ...(setParts.length > 0 ? { setParts: setParts.map((p) => ({ id: p.id, partNumber: p.partNumber, displayName: p.displayName })) } : {}),
        collaborators: collaborators.map((c) => ({
          ...(viaSets.has(c.userId) && (seesEmails || c.userId === user.id) ? { viaSets: viaSets.get(c.userId) } : {}),
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

  // Invites (POST /api/custom-parts/:id/invites and accepting them) are in customPartInvites.ts.

  app.patch<{
    Params: { id: string; userId: string };
    Body: { role: 'viewer' | 'editor' };
  }>('/api/custom-parts/:id/collaborators/:userId', async (req, reply) => {
    const user = requireUser(req);
    const { role } = await resolveResourceRole(user.id, 'custom_part', req.params.id);
    if (role === null) return reply.code(404).send({ error: 'not_found' });
    if (!hasAtLeast(role, 'owner')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const newRole = req.body.role;
    if (newRole !== 'viewer' && newRole !== 'editor') {
      return reply.code(400).send({ error: 'invalid_role' });
    }
    await db
      .update(schema.customPartCollaborators)
      .set({ role: newRole })
      .where(
        and(
          eq(schema.customPartCollaborators.customPartId, req.params.id),
          eq(schema.customPartCollaborators.userId, req.params.userId),
        ),
      );
    await writeAuditEvent({
      resourceKind: 'custom_part',
      resourceId: req.params.id,
      userId: user.id,
      eventType: 'role_change',
      payload: { targetUserId: req.params.userId, toRole: newRole },
    });
    return { ok: true };
  });

  app.delete<{ Params: { id: string; userId: string } }>(
    '/api/custom-parts/:id/collaborators/:userId',
    async (req, reply) => {
      const user = requireUser(req);
      const { role } = await resolveResourceRole(user.id, 'custom_part', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });
      const isSelf = req.params.userId === user.id;
      if (!isSelf && !hasAtLeast(role, 'owner')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      await db
        .delete(schema.customPartCollaborators)
        .where(
          and(
            eq(schema.customPartCollaborators.customPartId, req.params.id),
            eq(schema.customPartCollaborators.userId, req.params.userId),
          ),
        );
      // Off a set: the parts it brought them go too (unless shared on their
      // own). Off a part they had through a set: no set holds it any more.
      const takenBack = await revokeSetParts(req.params.id, req.params.userId);
      await forgetSetShares(req.params.id, req.params.userId);
      await writeAuditEvent({
        resourceKind: 'custom_part',
        resourceId: req.params.id,
        userId: user.id,
        eventType: 'unshare',
        payload: { targetUserId: req.params.userId, selfRemoved: isSelf, ...(takenBack.length > 0 ? { setPartsTakenBack: takenBack } : {}) },
      });
      for (const partId of takenBack)
        await writeAuditEvent({
          resourceKind: 'custom_part',
          resourceId: partId,
          userId: user.id,
          eventType: 'unshare',
          payload: { targetUserId: req.params.userId, withSet: req.params.id },
        });
      return { ok: true };
    },
  );
}

type ParsedPartBody =
  | {
      partNumber: string;
      displayName: string;
      xmlBlob: Buffer;
      spriteBlob: Buffer;
      spriteMime: '' | 'image/gif' | 'image/png';
      /** A set numbered like a part inside it (see setNamesItself). */
      namesItself?: boolean;
    }
  | { status: 400 | 413; error: string };

/** A 1x1 transparent GIF: what a set's sprite URL serves. */
export const EMPTY_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/**
 * A set (a `<group>` XML of other parts, as BlueBrick's `.set.xml`) is
 * stored without a sprite: an empty sprite blob and MIME type.
 */
export function isSetRow(p: { spriteMime: string }): boolean {
  return p.spriteMime === '';
}

/** Whether `xml` is a set: a `<group>` with at least one sub-part. */
export function isSetXml(xml: Buffer): boolean {
  return setSubpartIds(xml) !== null;
}

/** The part numbers a set's XML names, as written; null when it isn't a set. */
export function setSubpartIds(xml: Buffer): string[] | null {
  try {
    const parsed = parsePartXml(stripImportSource(xml).toString('utf8'), { partNumber: 'set', colorCode: '', spritePath: '' });
    return parsed.kind === 'group' && parsed.subparts.length > 0 ? parsed.subparts.map((s) => s.subKey) : null;
  } catch {
    return null;
  }
}

/**
 * Whether a set numbered `partNumber` names a part of that same number
 * inside it. Placing it would find the set again for that part, and so
 * on, nesting copies of itself, so such a name is refused.
 */
export function setNamesItself(partNumber: string, subpartIds: readonly string[]): boolean {
  const own = partNumber.toLowerCase();
  return subpartIds.some((id) => id.toLowerCase() === own);
}

/** A create / replace body's fields, checked, with the blobs decoded. */
function parsePartBody(body: CreatePartBody): ParsedPartBody {
  const partNumber = trimmed(body.partNumber);
  const displayName = trimmed(body.displayName);
  if (!partNumber || !displayName) return { status: 400, error: 'invalid_input' };
  // A set: its XML only. Its parts are uploaded on their own.
  if (!body.spriteMime && !body.spriteBase64) {
    let xmlBlob: Buffer;
    try {
      xmlBlob = Buffer.from(body.xmlBase64 ?? '', 'base64');
    } catch {
      return { status: 400, error: 'invalid_base64' };
    }
    if (xmlBlob.length === 0) return { status: 400, error: 'empty_payload' };
    if (xmlBlob.length > MAX_PART_BLOB_BYTES) return { status: 413, error: 'payload_too_large' };
    const ids = setSubpartIds(xmlBlob);
    if (!ids) return { status: 400, error: 'invalid_set' };
    return {
      partNumber,
      displayName,
      xmlBlob: stripImportSource(xmlBlob),
      spriteBlob: Buffer.alloc(0),
      spriteMime: '',
      namesItself: setNamesItself(partNumber, ids),
    };
  }
  if (body.spriteMime !== 'image/gif' && body.spriteMime !== 'image/png') {
    return { status: 400, error: 'invalid_sprite_mime' };
  }
  let xmlBlob: Buffer;
  let spriteBlob: Buffer;
  try {
    xmlBlob = Buffer.from(body.xmlBase64, 'base64');
    spriteBlob = Buffer.from(body.spriteBase64 ?? '', 'base64');
  } catch {
    return { status: 400, error: 'invalid_base64' };
  }
  if (xmlBlob.length === 0 || spriteBlob.length === 0) return { status: 400, error: 'empty_payload' };
  if (xmlBlob.length + spriteBlob.length > MAX_PART_BLOB_BYTES) return { status: 413, error: 'payload_too_large' };
  // The sprite is stored and served as sent, so it must be the picture it says it is.
  if (!isImageOfType(spriteBlob, body.spriteMime)) return { status: 400, error: 'invalid_sprite' };
  const size = pngSize(spriteBlob);
  if (size && (size.width === 0 || size.height === 0 || size.width > MAX_SPRITE_SIDE || size.height > MAX_SPRITE_SIDE)) {
    return { status: 400, error: 'invalid_sprite' };
  }
  return { partNumber, displayName, xmlBlob: xmlForSprite(xmlBlob, body.spriteMime), spriteBlob, spriteMime: body.spriteMime };
}

/**
 * The XML stored with a sprite: a GIF is 8 px a stud whatever the XML
 * says (the desktop's rule), so its `<PixelsPerStud>` is dropped and every
 * reader sizes the part the same. Older desktops sent an import's 8 px a
 * stud .gif with the XML of its 32 px a stud .png.
 */
export function xmlForSprite(xmlBlob: Buffer, spriteMime: string): Buffer {
  const clean = stripImportSource(xmlBlob);
  if (spriteMime !== 'image/gif') return clean;
  const xml = clean.toString('utf8');
  const fixed = xmlForGifSprite(xml);
  return fixed === xml ? clean : Buffer.from(fixed, 'utf8');
}


const partListColumns = {
  id: schema.customParts.id,
  partNumber: schema.customParts.partNumber,
  displayName: schema.customParts.displayName,
  ownerUserId: schema.customParts.ownerUserId,
  ownerOrgId: schema.customParts.ownerOrgId,
  spriteMime: schema.customParts.spriteMime,
  createdAt: schema.customParts.createdAt,
  updatedAt: schema.customParts.updatedAt,
};

function toListItem(
  p: Pick<
    typeof schema.customParts.$inferSelect,
    'id' | 'partNumber' | 'displayName' | 'ownerUserId' | 'ownerOrgId' | 'spriteMime' | 'createdAt' | 'updatedAt'
  >,
) {
  return {
    id: p.id,
    partNumber: p.partNumber,
    displayName: p.displayName,
    ownerUserId: p.ownerUserId,
    ownerOrgId: p.ownerOrgId,
    spriteMime: p.spriteMime,
    ...(isSetRow(p) ? { kind: 'set' as const } : {}),
    createdAt: p.createdAt.getTime(),
    updatedAt: p.updatedAt.getTime(),
  };
}
