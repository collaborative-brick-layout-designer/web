// Read-only sharing of a module (docs/shared-modules.md).
//
// A module's owner shares it with a person (a module_collaborators row,
// role 'viewer', by an emailed invite) or with a club they're in
// (module_club_shares). Either lets the receiver see the module and place
// it; neither lets them change it, and only the owner can share it.
//
// The owner's custom parts the module uses come along, read-only, for the
// same people (module_share_parts), the way a set's parts do
// (setShares.ts), so nothing draws as a placeholder. Those rows are
// worked out again whenever the module's parts or its shares change
// (`syncModuleShareParts`); a part someone has only that way goes when the
// share does.

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import * as Y from 'yjs';
import { decodeDoc } from '@cld/ydoc';
import { db, schema, sqlite } from '../db/index.js';
import { setPartsFor } from './setShares.js';

/** A club a module is shared with. */
export interface ClubShare {
  orgId: string;
  name: string;
  slug: string;
}

/** The clubs `moduleId` is shared with. */
export async function clubSharesOf(moduleId: string): Promise<(ClubShare & { sharedBy: string | null; createdAt: Date; via: string | null })[]> {
  return db
    .select({
      orgId: schema.orgs.id,
      name: schema.orgs.name,
      slug: schema.orgs.slug,
      sharedBy: schema.moduleClubShares.sharedBy,
      createdAt: schema.moduleClubShares.createdAt,
      via: schema.moduleClubShares.via,
    })
    .from(schema.moduleClubShares)
    .innerJoin(schema.orgs, eq(schema.orgs.id, schema.moduleClubShares.orgId))
    .where(eq(schema.moduleClubShares.moduleId, moduleId))
    .orderBy(schema.orgs.name)
    .all();
}

/** The clubs of `userId` that `moduleId` is shared with (none: not shared with them that way). */
export async function clubSharesReaching(userId: string, moduleId: string): Promise<ClubShare[]> {
  return db
    .select({ orgId: schema.orgs.id, name: schema.orgs.name, slug: schema.orgs.slug })
    .from(schema.moduleClubShares)
    .innerJoin(schema.orgMembers, eq(schema.orgMembers.orgId, schema.moduleClubShares.orgId))
    .innerJoin(schema.orgs, eq(schema.orgs.id, schema.moduleClubShares.orgId))
    .where(and(eq(schema.moduleClubShares.moduleId, moduleId), eq(schema.orgMembers.userId, userId)))
    .orderBy(schema.orgs.name)
    .all();
}

/**
 * Whether `userId` has `moduleId` only because it's shared with a club of
 * theirs: not its owner, not in the club that owns it, not shared in person.
 */
export async function onlyThroughClubShare(userId: string, moduleId: string): Promise<boolean> {
  const mod = await db
    .select({ ownerUserId: schema.modules.ownerUserId, ownerOrgId: schema.modules.ownerOrgId })
    .from(schema.modules)
    .where(eq(schema.modules.id, moduleId))
    .get();
  if (!mod || mod.ownerUserId === userId) return false;
  if (mod.ownerOrgId) {
    const member = await db
      .select({ u: schema.orgMembers.userId })
      .from(schema.orgMembers)
      .where(and(eq(schema.orgMembers.orgId, mod.ownerOrgId), eq(schema.orgMembers.userId, userId)))
      .get();
    if (member) return false;
  }
  const direct = await db
    .select({ u: schema.moduleCollaborators.userId })
    .from(schema.moduleCollaborators)
    .where(and(eq(schema.moduleCollaborators.moduleId, moduleId), eq(schema.moduleCollaborators.userId, userId)))
    .get();
  if (direct) return false;
  return (await clubSharesReaching(userId, moduleId)).length > 0;
}

/** Whether `moduleId` is shared with the club `orgId`. */
export async function sharedWithClub(moduleId: string, orgId: string): Promise<boolean> {
  const row = await db
    .select({ orgId: schema.moduleClubShares.orgId })
    .from(schema.moduleClubShares)
    .where(and(eq(schema.moduleClubShares.moduleId, moduleId), eq(schema.moduleClubShares.orgId, orgId)))
    .get();
  return !!row;
}

/** The part numbers (lower-cased) a module's contents use; none when they can't be read. */
export function partNumbersIn(snapshot: Uint8Array | null | undefined): string[] {
  if (!snapshot) return [];
  let doc: Y.Doc | null = null;
  try {
    doc = decodeDoc(snapshot);
    const out = new Set<string>();
    for (const layer of doc.getMap<unknown>('layerData').values()) {
      if (!(layer instanceof Y.Map)) continue;
      const bricks = layer.get('bricks');
      if (!(bricks instanceof Y.Array)) continue;
      for (const b of bricks) {
        const n = b instanceof Y.Map ? b.get('partNumber') : undefined;
        if (typeof n === 'string' && n) out.add(n.toLowerCase());
      }
    }
    return [...out];
  } catch {
    return [];
  } finally {
    doc?.destroy();
  }
}

/**
 * The custom parts that come along when `moduleId` is shared: its owner's
 * (the same person or club) parts whose numbers the module's newest
 * contents use, and the parts of any set of theirs among them.
 */
export async function modulePartIds(moduleId: string): Promise<string[]> {
  const mod = await db
    .select({ ownerUserId: schema.modules.ownerUserId, ownerOrgId: schema.modules.ownerOrgId, docSnapshot: schema.modules.docSnapshot })
    .from(schema.modules)
    .where(eq(schema.modules.id, moduleId))
    .get();
  if (!mod || (!mod.ownerUserId && !mod.ownerOrgId)) return [];
  const numbers = partNumbersIn(mod.docSnapshot as Uint8Array);
  if (numbers.length === 0) return [];
  const sameOwner = mod.ownerOrgId ? eq(schema.customParts.ownerOrgId, mod.ownerOrgId) : eq(schema.customParts.ownerUserId, mod.ownerUserId!);
  const out = new Set<string>();
  // In steps: a big module can use more part numbers than one query takes.
  for (let i = 0; i < numbers.length; i += 400) {
    const parts = await db
      .select({ id: schema.customParts.id, spriteMime: schema.customParts.spriteMime })
      .from(schema.customParts)
      .where(and(sameOwner, inArray(sql`lower(${schema.customParts.partNumber})`, numbers.slice(i, i + 400))))
      .all();
    for (const p of parts) {
      out.add(p.id);
      // A set: the parts it's made of come too.
      if (p.spriteMime === '') for (const inner of await setPartsFor(p.id)) out.add(inner.id);
    }
  }
  return [...out];
}

/**
 * Work out again which custom parts `moduleId` brings to whom: every part
 * of `modulePartIds`, for each person it's shared with and each club. Call
 * after the module is saved, shared, unshared, moved or restored. A module
 * that's gone has no rows left (they go with it).
 */
export async function syncModuleShareParts(moduleId: string): Promise<void> {
  const people = await db
    .select({ userId: schema.moduleCollaborators.userId })
    .from(schema.moduleCollaborators)
    .where(eq(schema.moduleCollaborators.moduleId, moduleId))
    .all();
  const clubs = await db
    .select({ orgId: schema.moduleClubShares.orgId })
    .from(schema.moduleClubShares)
    .where(eq(schema.moduleClubShares.moduleId, moduleId))
    .all();
  const parts = people.length + clubs.length > 0 ? await modulePartIds(moduleId) : [];
  const now = new Date();
  const rows = parts.flatMap((partId) => [
    ...people.map((p) => ({ moduleId, partId, userId: p.userId, orgId: null, addedAt: now })),
    ...clubs.map((c) => ({ moduleId, partId, userId: null, orgId: c.orgId, addedAt: now })),
  ]);
  db.transaction((tx) => {
    tx.delete(schema.moduleShareParts).where(eq(schema.moduleShareParts.moduleId, moduleId)).run();
    for (let i = 0; i < rows.length; i += 200) tx.insert(schema.moduleShareParts).values(rows.slice(i, i + 200)).run();
  });
}

/** The ids of every custom part `userId` may see through a shared module. */
export async function partIdsThroughModules(userId: string): Promise<string[]> {
  const direct = await db
    .selectDistinct({ id: schema.moduleShareParts.partId })
    .from(schema.moduleShareParts)
    .where(eq(schema.moduleShareParts.userId, userId))
    .all();
  const viaClub = await db
    .selectDistinct({ id: schema.moduleShareParts.partId })
    .from(schema.moduleShareParts)
    .innerJoin(schema.orgMembers, eq(schema.orgMembers.orgId, schema.moduleShareParts.orgId))
    .where(and(isNotNull(schema.moduleShareParts.orgId), eq(schema.orgMembers.userId, userId)))
    .all();
  // And through a layout they can open that places the module, still shared (sharedModules/placed.ts).
  const viaLayout = sqlite
    .prepare(
      `SELECT DISTINCT s.part_id AS id FROM module_share_parts s
         JOIN layout_shared_modules p ON p.module_id = s.module_id AND p.state = 'shared'
         JOIN layouts l ON l.id = p.layout_id
        WHERE l.owner_user_id = ?
           OR l.owner_org_id IN (SELECT org_id FROM org_members WHERE user_id = ?)
           OR l.id IN (SELECT layout_id FROM layout_collaborators WHERE user_id = ?)`,
    )
    .all(userId, userId, userId) as { id: string }[];
  return [...new Set([...direct, ...viaClub, ...viaLayout].map((r) => r.id))];
}

/** The modules shared with `userId`: with them in person, or with a club they're in. */
export async function sharedModuleIds(userId: string): Promise<{ direct: Set<string>; clubs: Map<string, ClubShare[]> }> {
  const direct = await db
    .select({ id: schema.moduleCollaborators.moduleId })
    .from(schema.moduleCollaborators)
    .where(eq(schema.moduleCollaborators.userId, userId))
    .all();
  const viaClub = await db
    .select({ id: schema.moduleClubShares.moduleId, orgId: schema.orgs.id, name: schema.orgs.name, slug: schema.orgs.slug })
    .from(schema.moduleClubShares)
    .innerJoin(schema.orgMembers, eq(schema.orgMembers.orgId, schema.moduleClubShares.orgId))
    .innerJoin(schema.orgs, eq(schema.orgs.id, schema.moduleClubShares.orgId))
    .where(eq(schema.orgMembers.userId, userId))
    .orderBy(schema.orgs.name)
    .all();
  const clubs = new Map<string, ClubShare[]>();
  for (const r of viaClub) clubs.set(r.id, [...(clubs.get(r.id) ?? []), { orgId: r.orgId, name: r.name, slug: r.slug }]);
  return { direct: new Set(direct.map((r) => r.id)), clubs };
}

/** Everyone a module's club shares reach (the members of those clubs), for live hints. */
export async function clubShareMemberIds(moduleId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: schema.orgMembers.userId })
    .from(schema.moduleClubShares)
    .innerJoin(schema.orgMembers, eq(schema.orgMembers.orgId, schema.moduleClubShares.orgId))
    .where(eq(schema.moduleClubShares.moduleId, moduleId))
    .all();
  return rows.map((r) => r.userId);
}

