// Who may receive a change hint. The rule is "the people who can see the
// thing", worked out from the same tables the access checks use:
//
//   - a person's own things: that person
//   - a club's things, and the club itself: the club's members
//   - a shared layout, module or custom part: also its collaborators
//   - layouts, modules and clubs: also site admins (the admin pages list them)
//   - catalog submissions: also site moderators and admins
//   - site-wide things (published catalog, global parts, site settings):
//     everyone signed in
//   - admin-only things (limits, admin lists): site admins
//   - warnings: worked out per warning (routeHints.ts `warningHint`)
//
// Anyone else gets nothing.

import { eq, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { connectedUserIds, deliver, type Hint } from './hub.js';
import { clubShareMemberIds } from '../access/moduleShares.js';
import { peopleWithPlacedCopies } from '../sharedModules/placed.js';

export interface Reach {
  /** Send to every open stream (site-wide, public data only). */
  everyone?: boolean;
  /** People to add to the hint's normal audience (a transfer's recipient, a removed member). */
  users?: readonly (string | null | undefined)[];
  /** Leave out the owner/club audience (admin-only hints). */
  ownerless?: boolean;
}

async function orgMemberIds(orgId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: schema.orgMembers.userId })
    .from(schema.orgMembers)
    .where(eq(schema.orgMembers.orgId, orgId))
    .all();
  return rows.map((r) => r.userId);
}

async function collaboratorIds(kind: Hint['kind'], id: string): Promise<string[]> {
  if (kind === 'layout') {
    const rows = await db
      .select({ userId: schema.layoutCollaborators.userId })
      .from(schema.layoutCollaborators)
      .where(eq(schema.layoutCollaborators.layoutId, id))
      .all();
    return rows.map((r) => r.userId);
  }
  if (kind === 'module') {
    const rows = await db
      .select({ userId: schema.moduleCollaborators.userId })
      .from(schema.moduleCollaborators)
      .where(eq(schema.moduleCollaborators.moduleId, id))
      .all();
    // And the members of the clubs it's shared with (module_club_shares).
    // ...and everyone who can open a layout that places it and follows it: its next version is theirs to put in.
    return [...rows.map((r) => r.userId), ...(await clubShareMemberIds(id)), ...(await peopleWithPlacedCopies(id))];
  }
  if (kind === 'custom-part') {
    const rows = await db
      .select({ userId: schema.customPartCollaborators.userId })
      .from(schema.customPartCollaborators)
      .where(eq(schema.customPartCollaborators.customPartId, id))
      .all();
    return rows.map((r) => r.userId);
  }
  return [];
}

export async function staffIds(moderators: boolean): Promise<string[]> {
  const cond = moderators
    ? or(eq(schema.users.isGlobalAdmin, true), eq(schema.users.isModerator, true))
    : eq(schema.users.isGlobalAdmin, true);
  const rows = await db.select({ id: schema.users.id }).from(schema.users).where(cond).all();
  return rows.map((r) => r.id);
}

/** Kinds the admin pages list, so admins hear about them. */
const ADMIN_SEES = new Set<Hint['kind']>(['layout', 'module', 'club', 'admin', 'limits']);
/** Kinds moderators hear about too. */
const MODERATOR_SEES = new Set<Hint['kind']>(['catalog']);

/**
 * The people who should get `hint`, among those `connected`. Returns
 * 'everyone' for site-wide hints.
 */
export async function audienceFor(hint: Hint, reach: Reach = {}): Promise<Set<string> | 'everyone'> {
  if (reach.everyone) return 'everyone';
  const out = new Set<string>();
  for (const u of reach.users ?? []) if (u) out.add(u);
  if (!reach.ownerless && hint.owner) {
    if (hint.owner.kind === 'user') out.add(hint.owner.id);
    else for (const u of await orgMemberIds(hint.owner.id)) out.add(u);
  }
  if (!reach.ownerless && hint.id) for (const u of await collaboratorIds(hint.kind, hint.id)) out.add(u);
  if (ADMIN_SEES.has(hint.kind) || MODERATOR_SEES.has(hint.kind)) {
    for (const u of await staffIds(MODERATOR_SEES.has(hint.kind))) out.add(u);
  }
  return out;
}

/** Errors in hint delivery are logged here, never thrown into a request. */
let onError: (err: unknown) => void = () => undefined;
export function setHintErrorLogger(fn: (err: unknown) => void): void {
  onError = fn;
}

/**
 * Send `hint` to its audience. Cheap when nobody is listening: the DB is
 * only asked once someone has a stream open.
 */
export async function publish(hint: Hint, reach: Reach = {}): Promise<number> {
  try {
    const connected = connectedUserIds();
    if (connected.length === 0) return 0;
    const who = await audienceFor(hint, reach);
    if (who === 'everyone') return deliver(hint, connected);
    return deliver(hint, connected.filter((u) => who.has(u)));
  } catch (err) {
    onError(err);
    return 0;
  }
}

/** The owner of a layout, module, venue or custom part, read before it changes (or goes). */
export async function ownerOfResource(
  kind: 'layout' | 'module' | 'venue' | 'custom-part' | 'rolling-stock',
  id: string,
): Promise<{ owner?: Hint['owner']; isGlobal?: boolean } | null> {
  const table =
    kind === 'layout' ? schema.layouts
    : kind === 'module' ? schema.modules
    : kind === 'venue' ? schema.venueLibrary
    : kind === 'rolling-stock' ? schema.rollingStock
    : schema.customParts;
  const row = await db
    .select({ ownerUserId: table.ownerUserId, ownerOrgId: table.ownerOrgId })
    .from(table)
    .where(eq(table.id, id))
    .get();
  if (!row) return null;
  let isGlobal = false;
  if (kind === 'custom-part') {
    const g = await db.select({ g: schema.customParts.isGlobal }).from(schema.customParts).where(eq(schema.customParts.id, id)).get();
    isGlobal = !!g?.g;
  }
  const owner: Hint['owner'] | undefined = row.ownerOrgId
    ? { kind: 'org', id: row.ownerOrgId }
    : row.ownerUserId
      ? { kind: 'user', id: row.ownerUserId }
      : undefined;
  return { owner, isGlobal };
}

/** A club's id from its slug (routes name clubs by slug). */
export async function orgIdBySlug(slug: string): Promise<string | null> {
  const row = await db.select({ id: schema.orgs.id }).from(schema.orgs).where(eq(schema.orgs.slug, slug)).get();
  return row?.id ?? null;
}
