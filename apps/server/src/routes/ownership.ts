// Who owns a club's thing, and handing it back to the person who made it.
//
//   POST /api/{layouts|modules|custom-parts|venues}/:id/take-back
//        The author, while a member of the club that holds it, takes it back.
//   POST /api/{layouts|modules|custom-parts|venues}/:id/give-back
//        The club's admins and managers give it back, only ever to its author.
// An author who handed the thing to someone else (an accepted transfer)
// gave it away: it doesn't go back to them either way.
//   POST /api/custom-parts/:id/move   a person's part into a club (or club to club);
//                                     a set brings its owner's parts in it (access/setMoves.ts)
//   GET  /api/custom-parts/:id/move-plan?orgSlug=   what a set's move would do with its parts
//   POST /api/custom-parts/:id/copy   a copy into your parts or a club's
//   GET  /api/custom-parts/:id/copy-plan?orgSlug=   what a set's copy to a club would do with its parts
//
// No other club→person move exists. When a thing goes back, the club keeps
// its own copy, credited to the author and pointing at the original
// (copied_from_id), so nothing the club built with it changes: placed
// modules carry their own parts in the layout (they never point at the
// library module), and the club's custom part copy keeps the same part
// number, so club layouts using it still find it. The club's catalog
// listing and collections follow its copy. There is no waiting period;
// the club's admins and managers get a note in their notices, and the
// move is audit-logged.

import { stripImportSource } from '../utils/partXml.js';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { requireUser } from '../auth/cookie.js';
import { isDemoUser } from '../demo/demoAccount.js';
import { checkGrowth, type Subject } from '../limits/limits.js';
import { hasAtLeast, resolveResourceRole } from '../access/resolveResourceRole.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { publicName } from '../utils/publicName.js';
import type { User } from '../db/schema.js';
import { getMembership } from './orgs.js';
import { addPermission } from '../access/clubPermissions.js';
import { destinationOrg } from './owners.js';
import { creditRows, isKeptCopy, type CreditKind } from './credits.js';
import { prepareLayoutCopy } from './layouts.js';
import { copyPartTo, dropModuleFromCollections } from './collections.js';
import { postClubNote } from './warnings.js';
import { perPerson } from '../utils/rateLimits.js';
import { clearPendingLayoutShares, clearPendingModuleShares, clearPendingPartShares, handedOverIds } from '../access/pendingShares.js';
import { notifyAccessChanged } from '../ws/liveAccess.js';
import { emptyPlan, planSetCopy, planSetMove, type SetMovePlan } from '../access/setMoves.js';

const KINDS: { kind: CreditKind; path: string; token: 'layouts:write' | 'parts:write' | 'venues:write'; word: string }[] = [
  { kind: 'layout', path: 'layouts', token: 'layouts:write', word: 'layout' },
  { kind: 'module', path: 'modules', token: 'layouts:write', word: 'module' },
  { kind: 'custom-part', path: 'custom-parts', token: 'parts:write', word: 'part' },
  { kind: 'venue', path: 'venues', token: 'venues:write', word: 'venue' },
];

type Mode = 'take' | 'give';

export interface ReturnResult {
  ok: true;
  /** The original, now the author's. */
  id: string;
  /** The club's copy. */
  keptCopyId: string;
  ownerUserId: string;
  noticeId: string;
}

/** Venue names are unique per owner: "Hall", else "Hall (2)", "Hall (3)"… among the author's own. */
async function freeVenueName(name: string, userId: string): Promise<string> {
  const mine = await db
    .select({ name: schema.venueLibrary.name })
    .from(schema.venueLibrary)
    .where(and(eq(schema.venueLibrary.ownerUserId, userId), isNull(schema.venueLibrary.ownerOrgId)));
  const taken = new Set(mine.map((v) => v.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const c = `${name} (${n})`;
    if (!taken.has(c.toLowerCase())) return c;
  }
}

/** Where the club's copy can be found, for the note. */
function linkTo(kind: CreditKind, id: string, orgSlug: string): string {
  if (kind === 'layout') return `/editor/${id}`;
  if (kind === 'module') return `/modules/${id}`;
  if (kind === 'custom-part') return `/?owner=${encodeURIComponent(orgSlug)}#parts`;
  return `/?owner=${encodeURIComponent(orgSlug)}`;
}

/**
 * Hand a club's thing back to its author, keeping a copy for the club.
 * `mode` 'take': the actor is the author and a member. 'give': the actor
 * runs the club. Answers the reply itself on refusal (returns null).
 */
export async function returnToAuthor(
  kind: CreditKind,
  id: string,
  actor: User,
  mode: Mode,
  reply: FastifyReply,
): Promise<ReturnResult | null> {
  const refuse = (code: number, error: string, message?: string) => {
    void reply.code(code).send({ error, ...(message ? { message } : {}) });
    return null;
  };
  if (isDemoUser(actor)) return refuse(403, 'demo_account_cannot_share');
  const [row] = await creditRows(kind, [id]);
  if (!row) return refuse(404, 'not_found');
  // Someone outside the club can't see it at all.
  const mine = row.ownerOrgId ? await getMembership(row.ownerOrgId, actor.id) : null;
  if (!row.ownerOrgId) {
    if (row.ownerUserId === actor.id) return refuse(409, 'already_yours', 'It’s already yours.');
    return refuse(404, 'not_found');
  }
  if (!mine) return refuse(404, 'not_found');
  const orgId = row.ownerOrgId;
  const author = row.deletedAuthorId ? null : row.createdBy;
  if (mode === 'take') {
    if (author !== actor.id) return refuse(403, 'only_the_author_can_take_back', 'Only the person who made it can take it back.');
  } else {
    if (!mine.permissions.has('delete_items')) {
      return refuse(403, 'only_club_admins_can_give_back', 'Giving it back needs the Delete club items permission. Ask a club admin.');
    }
  }
  const authorUser = author ? await db.select().from(schema.users).where(eq(schema.users.id, author)).get() : undefined;
  if (!authorUser) return refuse(409, 'author_gone', 'The person who made it no longer has an account here.');
  // An author who handed it to someone else by a transfer gave it away:
  // it no longer goes back to them.
  if ((await handedOverIds(kind, new Map([[id, { id: authorUser.id, email: authorUser.email }]]))).has(id)) {
    return refuse(
      409,
      'author_handed_it_over',
      mode === 'take' ? 'You handed this to someone else, so it stays with the club.' : 'Its author handed it to someone else, so it stays with the club.',
    );
  }
  const [source] = row.copiedFromId ? await creditRows(kind, [row.copiedFromId]) : [];
  if (isKeptCopy(row, source)) {
    return refuse(409, 'already_returned', 'This is the club’s copy; its author already has the original.');
  }
  const org = await db.select().from(schema.orgs).where(eq(schema.orgs.id, orgId)).get();
  if (!org) return refuse(404, 'not_found');
  const toAuthor: Subject = { kind: 'user', id: authorUser.id };
  const copyId = randomUUID();
  const now = new Date();
  // Each kind: check the author has room, then in one transaction write
  // the club's copy, hand the original over and point the club's catalog
  // listing and collections at the copy.
  let title = row.title;
  if (kind === 'layout') {
    const src = await db.select().from(schema.layouts).where(eq(schema.layouts.id, id)).get();
    if (!src) return refuse(404, 'not_found');
    const bytes = (src.docSnapshot as Uint8Array).length + ((src.sidecarSnapshot as Uint8Array | null)?.length ?? 0);
    const refusal = await checkGrowth({ actor, owner: toAuthor, add: { layouts: 1, bytes } });
    if (refusal) return refuse(refusal.status, (refusal.body as { error?: string }).error ?? 'limit', (refusal.body as { message?: string }).message);
    const prepared = await prepareLayoutCopy(src, { title: src.title, ownerUserId: null, ownerOrgId: orgId, createdBy: authorUser.id });
    prepared.values.id = copyId;
    db.transaction((tx) => {
      tx.insert(schema.layouts).values(prepared.values).run();
      tx.update(schema.layouts).set({ ownerUserId: authorUser.id, ownerOrgId: null, updatedAt: now }).where(eq(schema.layouts.id, id)).run();
    });
    notifyAccessChanged({ layoutId: id });
    await prepared.copyBackground();
    await clearPendingLayoutShares(id);
  } else if (kind === 'module') {
    const src = await db.select().from(schema.modules).where(eq(schema.modules.id, id)).get();
    if (!src) return refuse(404, 'not_found');
    const bytes =
      (src.docSnapshot as Uint8Array).length + ((src.sidecarSnapshot as Uint8Array | null)?.length ?? 0) + ((src.thumbnail as Uint8Array | null)?.length ?? 0);
    const refusal = await checkGrowth({ actor, owner: toAuthor, add: { bytes } });
    if (refusal) return refuse(refusal.status, (refusal.body as { error?: string }).error ?? 'limit', (refusal.body as { message?: string }).message);
    db.transaction((tx) => {
      tx.insert(schema.modules)
        .values({
          id: copyId,
          title: src.title,
          ownerUserId: null,
          ownerOrgId: orgId,
          createdBy: authorUser.id,
          docSnapshot: src.docSnapshot,
          docVersion: 0,
          sidecarSnapshot: src.sidecarSnapshot,
          setup: src.setup,
          thumbnail: src.thumbnail,
          thumbnailMime: src.thumbnailMime,
          thumbnailAt: src.thumbnailAt,
          copiedFromId: src.id,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      tx.update(schema.modules).set({ ownerUserId: authorUser.id, ownerOrgId: null, updatedAt: now }).where(eq(schema.modules.id, id)).run();
      followCopy(tx, 'module', id, copyId, orgId);
    });
    await clearPendingModuleShares(id);
  } else if (kind === 'custom-part') {
    const src = await db.select().from(schema.customParts).where(eq(schema.customParts.id, id)).get();
    if (!src) return refuse(404, 'not_found');
    title = src.displayName;
    const clash = await db
      .select({ id: schema.customParts.id })
      .from(schema.customParts)
      .where(and(eq(schema.customParts.ownerUserId, authorUser.id), eq(schema.customParts.partNumber, src.partNumber)))
      .get();
    if (clash) {
      return refuse(
        409,
        'part_number_taken',
        `${mode === 'take' ? 'You already have' : `${publicName(authorUser.id, authorUser.displayName)} already has`} a part numbered ${src.partNumber}.`,
      );
    }
    const bytes = (src.xmlBlob as Uint8Array).length + (src.spriteBlob as Uint8Array).length;
    const refusal = await checkGrowth({ actor, owner: toAuthor, add: { customParts: 1, bytes } });
    if (refusal) return refuse(refusal.status, (refusal.body as { error?: string }).error ?? 'limit', (refusal.body as { message?: string }).message);
    db.transaction((tx) => {
      tx.insert(schema.customParts)
        .values({
          id: copyId,
          partNumber: src.partNumber,
          displayName: src.displayName,
          category: src.category,
          ownerUserId: null,
          ownerOrgId: orgId,
          createdBy: authorUser.id,
          xmlBlob: stripImportSource(Buffer.from(src.xmlBlob as Uint8Array)),
          spriteBlob: Buffer.from(src.spriteBlob as Uint8Array),
          spriteMime: src.spriteMime,
          copiedFromId: src.id,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      tx.update(schema.customParts).set({ ownerUserId: authorUser.id, ownerOrgId: null, updatedAt: now }).where(eq(schema.customParts.id, id)).run();
      followCopy(tx, 'part', id, copyId, orgId);
    });
    await clearPendingPartShares(id);
  } else {
    const src = await db.select().from(schema.venueLibrary).where(eq(schema.venueLibrary.id, id)).get();
    if (!src) return refuse(404, 'not_found');
    const refusal = await checkGrowth({ actor, owner: toAuthor, add: { bytes: src.data.length } });
    if (refusal) return refuse(refusal.status, (refusal.body as { error?: string }).error ?? 'limit', (refusal.body as { message?: string }).message);
    const name = await freeVenueName(src.name, authorUser.id);
    db.transaction((tx) => {
      tx.insert(schema.venueLibrary)
        .values({ id: copyId, ownerUserId: null, ownerOrgId: orgId, name: src.name, data: src.data, createdBy: authorUser.id, copiedFromId: src.id, createdAt: now })
        .run();
      tx.update(schema.venueLibrary).set({ ownerUserId: authorUser.id, ownerOrgId: null, name }).where(eq(schema.venueLibrary.id, id)).run();
    });
  }

  const word = KINDS.find((k) => k.kind === kind)!.word;
  const authorName = publicName(authorUser.id, authorUser.displayName);
  const actorName = publicName(actor.id, actor.displayName);
  const reason =
    mode === 'take'
      ? `${authorName} took back the ${word} “${title}” they made. ${org.name} keeps its own copy, credited to them, so nothing the club built with it changes.`
      : `${actorName} gave the ${word} “${title}” back to ${authorName}, who made it. ${org.name} keeps its own copy, credited to them, so nothing the club built with it changes.`;
  const noticeId = await postClubNote(orgId, actor.id, reason, linkTo(kind, copyId, org.slug), {
    type: 'club.item_returned',
    title: mode === 'take' ? `${authorName} took back the ${word} “${title}”` : `${actorName} gave the ${word} “${title}” back to ${authorName}`,
  });
  const auditKind = kind === 'custom-part' ? 'custom_part' : kind;
  await writeAuditEvent({
    ...(kind === 'layout' ? { layoutId: id } : { resourceKind: auditKind, resourceId: id }),
    userId: actor.id,
    eventType: mode === 'take' ? 'take_back' : 'give_back',
    payload: { from: { kind: 'org', orgId, slug: org.slug }, to: { kind: 'user', userId: authorUser.id }, keptCopyId: copyId, noticeId },
  });
  await writeAuditEvent({
    ...(kind === 'layout' ? { layoutId: copyId } : { resourceKind: auditKind, resourceId: copyId }),
    userId: actor.id,
    eventType: 'create',
    payload: { copiedFrom: id, keptBy: { kind: 'org', orgId }, author: authorUser.id, reason: mode === 'take' ? 'take_back' : 'give_back' },
  });
  return { ok: true, id, keptCopyId: copyId, ownerUserId: authorUser.id, noticeId };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The club's catalog listing, its collections and its catalog-copy records
 * pointed at the original now point at the club's copy: they're the
 * club's, and the original has left.
 */
function followCopy(tx: Tx, kind: 'module' | 'part', fromId: string, toId: string, orgId: string): void {
  tx.update(schema.catalogItems)
    .set({ sourceId: toId })
    .where(and(eq(schema.catalogItems.kind, kind), eq(schema.catalogItems.sourceId, fromId), eq(schema.catalogItems.ownerOrgId, orgId)))
    .run();
  tx.update(schema.catalogCopies).set({ copyId: toId }).where(eq(schema.catalogCopies.copyId, fromId)).run();
  const clubCollections = tx
    .select({ id: schema.catalogCollections.id, cover: schema.catalogCollections.coverModuleId })
    .from(schema.catalogCollections)
    .where(eq(schema.catalogCollections.orgId, orgId))
    .all();
  for (const c of clubCollections) {
    if (kind === 'module') {
      tx.update(schema.catalogCollectionModules)
        .set({ moduleId: toId })
        .where(and(eq(schema.catalogCollectionModules.collectionId, c.id), eq(schema.catalogCollectionModules.moduleId, fromId)))
        .run();
      if (c.cover === fromId) tx.update(schema.catalogCollections).set({ coverModuleId: toId }).where(eq(schema.catalogCollections.id, c.id)).run();
    } else {
      tx.update(schema.catalogCollectionParts)
        .set({ partId: toId })
        .where(and(eq(schema.catalogCollectionParts.collectionId, c.id), eq(schema.catalogCollectionParts.partId, fromId)))
        .run();
    }
  }
}

export async function ownershipRoutes(app: FastifyInstance): Promise<void> {
  for (const k of KINDS) {
    for (const mode of ['take', 'give'] as const) {
      app.post<{ Params: { id: string } }>(
        `/api/${k.path}/:id/${mode}-back`,
        { config: { apiToken: k.token, rateLimit: perPerson(30, '1 minute') } },
        async (req, reply) => {
          const user = requireUser(req);
          const done = await returnToAuthor(k.kind, req.params.id, user, mode, reply);
          if (!done) return reply;
          return done;
        },
      );
    }
  }

  // ---- a custom part into a club --------------------------------------------
  // Like a layout's or module's transfer to a club: a person's own part, or
  // (club to club) one the caller runs. A club's part never moves out to one
  // person here: its author takes it back, or the club gives it back. A set
  // brings the custom parts in it (access/setMoves.ts); the move dialog
  // shows which first (move-plan).
  app.get<{ Params: { id: string }; Querystring: { orgSlug?: string } }>('/api/custom-parts/:id/move-plan', async (req, reply) => {
    const user = requireUser(req);
    const checked = await movable(user, req.params.id, req.query.orgSlug);
    if (!checked.ok) return reply.code(checked.code).send(checked.body);
    const { part, orgId } = checked;
    if (orgId === part.ownerOrgId) return { parts: emptyPlan() };
    return { parts: await planSetMove(part.id, user.id, orgId) };
  });

  app.post<{ Params: { id: string }; Body: { orgSlug?: string } }>(
    '/api/custom-parts/:id/move',
    { config: { apiToken: 'parts:write' } },
    async (req, reply) => {
      const user = requireUser(req);
      if (isDemoUser(user)) return reply.code(403).send({ error: 'demo_account_cannot_share' });
      const checked = await movable(user, req.params.id, req.body?.orgSlug);
      if (!checked.ok) return reply.code(checked.code).send(checked.body);
      const { part, orgId } = checked;
      if (orgId === part.ownerOrgId) return { ok: true, id: part.id };
      const clash = await db
        .select({ id: schema.customParts.id })
        .from(schema.customParts)
        .where(and(eq(schema.customParts.ownerOrgId, orgId), eq(schema.customParts.partNumber, part.partNumber)))
        .get();
      if (clash) return reply.code(409).send({ error: 'part_number_taken', message: `The club already has a part numbered ${part.partNumber}.` });
      // A set: the parts of its owner's in it come along (or a copy of them).
      const plan: SetMovePlan = part.spriteMime === '' ? await planSetMove(part.id, user.id, orgId) : emptyPlan();
      const along = [...plan.move, ...plan.copy].map((p) => p.id);
      const sizes = along.length
        ? await db
            .select({ id: schema.customParts.id, bytes: sql<number>`length(${schema.customParts.xmlBlob}) + length(${schema.customParts.spriteBlob})`.mapWith(Number) })
            .from(schema.customParts)
            .where(inArray(schema.customParts.id, along))
            .all()
        : [];
      const bytes = (part.xmlBlob as Uint8Array).length + (part.spriteBlob as Uint8Array).length + sizes.reduce((n, r) => n + r.bytes, 0);
      const refusal = await checkGrowth({ actor: user, owner: { kind: 'org', id: orgId }, add: { customParts: 1 + along.length, bytes } });
      if (refusal) return reply.code(refusal.status).send(refusal.body);
      const moving = [part.id, ...plan.move.map((p) => p.id)];
      const copies = plan.copy.length
        ? await db.select().from(schema.customParts).where(inArray(schema.customParts.id, plan.copy.map((p) => p.id))).all()
        : [];
      const now = new Date();
      const copyIds = new Map(copies.map((c) => [c.id, randomUUID()]));
      db.transaction((tx) => {
        tx.update(schema.customParts).set({ ownerUserId: null, ownerOrgId: orgId, updatedAt: now }).where(inArray(schema.customParts.id, moving)).run();
        for (const src of copies) {
          tx.insert(schema.customParts)
            .values({
              id: copyIds.get(src.id)!,
              partNumber: src.partNumber,
              displayName: src.displayName,
              category: src.category,
              ownerUserId: null,
              ownerOrgId: orgId,
              createdBy: src.createdBy ?? user.id,
              xmlBlob: stripImportSource(Buffer.from(src.xmlBlob as Uint8Array)),
              spriteBlob: Buffer.from(src.spriteBlob as Uint8Array),
              spriteMime: src.spriteMime,
              copiedFromId: src.id,
              createdAt: now,
              updatedAt: now,
            })
            .run();
        }
      });
      const from = part.ownerUserId ? { kind: 'user', userId: part.ownerUserId } : { kind: 'org', orgId: part.ownerOrgId };
      for (const id of moving) {
        // Invites still waiting were sent by someone who may no longer manage it.
        await clearPendingPartShares(id);
        const title = id === part.id ? part.displayName : plan.move.find((p) => p.id === id)!.displayName;
        if (part.ownerOrgId) await dropModuleFromCollections({ id, title }, 'moved to another club', orgId, user.id, 'part');
        await writeAuditEvent({
          resourceKind: 'custom_part',
          resourceId: id,
          userId: user.id,
          eventType: 'transfer',
          payload: { from, to: { kind: 'org', orgId }, ...(id === part.id ? {} : { withSet: part.id }) },
        });
      }
      for (const src of copies) {
        await writeAuditEvent({
          resourceKind: 'custom_part',
          resourceId: copyIds.get(src.id)!,
          userId: user.id,
          eventType: 'create',
          payload: { copiedFrom: src.id, owner: { kind: 'org', id: orgId }, withSet: part.id },
        });
      }
      const names = (list: { partNumber: string }[]) => list.map((p) => p.partNumber);
      return {
        ok: true,
        id: part.id,
        ...(part.spriteMime === ''
          ? { parts: { moved: names(plan.move), copied: names(plan.copy), inClub: names(plan.inClub), notYours: names(plan.notYours) } }
          : {}),
      };
    },
  );

  // ---- copy a custom part ----------------------------------------------------
  // A set copied to a club brings copies of your custom parts in it
  // (access/setMoves.ts planSetCopy); the dialog shows which first (copy-plan).
  app.get<{ Params: { id: string }; Querystring: { orgSlug?: string } }>('/api/custom-parts/:id/copy-plan', async (req, reply) => {
    const user = requireUser(req);
    const { role } = await resolveResourceRole(user.id, 'custom_part', req.params.id);
    if (role === null) return reply.code(404).send({ error: 'not_found' });
    if (!req.query.orgSlug) return reply.code(400).send({ error: 'copy_plan_needs_a_club' });
    const dest = await destinationOrg(user.id, req.query.orgSlug, addPermission('custom_part'));
    if (!dest.ok) return reply.code(dest.code).send({ error: dest.error, ...(dest.permission ? { permission: dest.permission } : {}) });
    const part = await db.select({ spriteMime: schema.customParts.spriteMime }).from(schema.customParts).where(eq(schema.customParts.id, req.params.id)).get();
    if (!part || part.spriteMime !== '' || !dest.orgId) return { parts: emptyPlan() };
    return { parts: await planSetCopy(req.params.id, user.id, dest.orgId) };
  });

  app.post<{ Params: { id: string }; Body: { orgSlug?: string } }>(
    '/api/custom-parts/:id/copy',
    { config: { apiToken: 'parts:write' } },
    async (req, reply) => {
      const user = requireUser(req);
      if (isDemoUser(user)) return reply.code(403).send({ error: 'demo_account_cannot_upload_parts' });
      const { role } = await resolveResourceRole(user.id, 'custom_part', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });
      const dest = await destinationOrg(user.id, req.body?.orgSlug, addPermission('custom_part'));
      if (!dest.ok) return reply.code(dest.code).send({ error: dest.error, permission: dest.permission });
      // A set into a club: copies of your custom parts in it come along.
      const part = await db.select({ spriteMime: schema.customParts.spriteMime }).from(schema.customParts).where(eq(schema.customParts.id, req.params.id)).get();
      const plan = part?.spriteMime === '' && dest.orgId ? await planSetCopy(req.params.id, user.id, dest.orgId) : null;
      const r = await copyPartTo(user, req.params.id, dest.orgId, plan?.copy.map((p) => p.id) ?? []);
      if (!r.ok) return reply.code(r.status).send(r.body);
      const names = (list: { partNumber: string }[]) => list.map((p) => p.partNumber);
      return reply.code(201).send({
        id: r.id,
        ...(plan ? { parts: { copied: names(r.copied), inClub: names(plan.inClub), notYours: names(plan.notYours) } } : {}),
      });
    },
  );
}

/**
 * The part `id`, when `user` may move it to the club `orgSlug` names: a
 * person's part by its owner (a share is not ownership), a club's by its
 * runners, into a club where they may add parts.
 */
async function movable(
  user: User,
  id: string,
  orgSlug: string | undefined,
): Promise<
  | { ok: true; part: typeof schema.customParts.$inferSelect; orgId: string }
  | { ok: false; code: number; body: { error: string; permission?: string } }
> {
  const { role } = await resolveResourceRole(user.id, 'custom_part', id);
  if (role === null) return { ok: false, code: 404, body: { error: 'not_found' } };
  const part = await db.select().from(schema.customParts).where(eq(schema.customParts.id, id)).get();
  if (!part || part.isGlobal) return { ok: false, code: 404, body: { error: 'not_found' } };
  if (part.ownerUserId ? part.ownerUserId !== user.id : !hasAtLeast(role, 'owner')) return { ok: false, code: 403, body: { error: 'forbidden' } };
  if (!orgSlug) return { ok: false, code: 400, body: { error: 'parts_can_only_move_to_clubs' } };
  const dest = await destinationOrg(user.id, orgSlug, addPermission('custom_part'));
  if (!dest.ok) return { ok: false, code: dest.code, body: { error: dest.error, ...(dest.permission ? { permission: dest.permission } : {}) } };
  return { ok: true, part, orgId: dest.orgId! };
}
