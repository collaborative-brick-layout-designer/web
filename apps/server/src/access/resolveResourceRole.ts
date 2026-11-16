// Generic access-control helper used by REST handlers AND the WS
// connection-time auth check. Mirrors the SQL function the desktop plan
// originally proposed; in SQLite it's a single TS function.
//
// A user has access to a resource iff any of:
//   1. They are the resource owner (ownerUserId match)
//   2. The resource is org-owned and they're a member of that org
//   3. They appear in the resource's collaborator table
//
// Role is the strongest of:
//   - 'owner'  — ownerUserId match, OR org-admin on the owning org
//   - 'editor' — org-member on the owning org (default), OR explicit editor
//   - 'viewer' — explicit viewer share
//
// Three resource kinds share this shape: layouts, custom_parts, modules.
// We dispatch by kind to the appropriate tables; the role-resolution
// algorithm itself is identical (per PLAN.md §3.3 / §6.5).

import { and, eq } from 'drizzle-orm';
import { db, schema, sqlite } from '../db/index.js';
import { atLeast, type ClubRole } from './clubRoles.js';
import { clubAccess, clubThingAccess } from './clubPermissions.js';

export type Role = 'owner' | 'editor' | 'viewer';
export type ResourceKind = 'layout' | 'custom_part' | 'module' | 'org';

export interface RoleResolution {
  role: Role | null;
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };
function strongerOf(a: Role | null, b: Role | null): Role | null {
  if (a === null) return b;
  if (b === null) return a;
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

/**
 * A club member's role on one of the club's modules, from the old fixed
 * roles: managers and admins own them; members edit them when the club
 * lets members add things, and otherwise only view them. Kept for tests
 * that pin the migration (the live answer is clubThingAccess).
 */
export function clubModuleRole(role: ClubRole, membersCanCreate: boolean): Role {
  if (atLeast(role, 'manager')) return 'owner';
  return membersCanCreate ? 'editor' : 'viewer';
}

interface ResourceTables {
  ownerUserId: string | null;
  ownerOrgId: string | null;
  collaboratorRole: Role | null;
}

async function loadLayout(userId: string, id: string): Promise<ResourceTables | null> {
  const row = await db
    .select({
      ownerUserId: schema.layouts.ownerUserId,
      ownerOrgId: schema.layouts.ownerOrgId,
    })
    .from(schema.layouts)
    .where(eq(schema.layouts.id, id))
    .get();
  if (!row) return null;
  const collab = await db
    .select({ role: schema.layoutCollaborators.role })
    .from(schema.layoutCollaborators)
    .where(
      and(
        eq(schema.layoutCollaborators.layoutId, id),
        eq(schema.layoutCollaborators.userId, userId),
      ),
    )
    .get();
  return {
    ownerUserId: row.ownerUserId,
    ownerOrgId: row.ownerOrgId,
    collaboratorRole: (collab?.role as Role) ?? null,
  };
}

async function loadCustomPart(userId: string, id: string): Promise<ResourceTables | null> {
  const row = await db
    .select({
      ownerUserId: schema.customParts.ownerUserId,
      ownerOrgId: schema.customParts.ownerOrgId,
      isGlobal: schema.customParts.isGlobal,
    })
    .from(schema.customParts)
    .where(eq(schema.customParts.id, id))
    .get();
  if (!row) return null;
  const collab = await db
    .select({ role: schema.customPartCollaborators.role })
    .from(schema.customPartCollaborators)
    .where(
      and(
        eq(schema.customPartCollaborators.customPartId, id),
        eq(schema.customPartCollaborators.userId, userId),
      ),
    )
    .get();
  // Global parts are visible (viewer) to every authenticated user. That
  // is a floor, not an ownership grant: the real owner / org / explicit
  // collaborator rows still decide who can edit or delete. (Returning the
  // caller as `ownerUserId` here once made every user "owner" of every
  // global part.)
  // A part a module shared with the caller (or a club of theirs) uses comes
  // along with it, to look at (module_share_parts, access/moduleShares.ts).
  const floor: Role | null = row.isGlobal || (!collab && (await partComesWithModule(userId, id))) ? 'viewer' : null;
  return {
    ownerUserId: row.ownerUserId,
    ownerOrgId: row.ownerOrgId,
    collaboratorRole: strongerOf((collab?.role as Role) ?? null, floor),
  };
}

/** Whether a module shared with `userId`, or with a club they're in, brings the custom part `partId`. */
async function partComesWithModule(userId: string, partId: string): Promise<boolean> {
  const row = sqlite
    .prepare(
      `SELECT 1 FROM module_share_parts s
        WHERE s.part_id = ?
          AND (s.user_id = ? OR s.org_id IN (SELECT org_id FROM org_members WHERE user_id = ?))
        LIMIT 1`,
    )
    .get(partId, userId, userId);
  return !!row;
}

/** Whether the module is shared, read-only, with a club `userId` is in (module_club_shares). */
async function moduleSharedWithClubOf(userId: string, moduleId: string): Promise<boolean> {
  const row = sqlite
    .prepare(
      `SELECT 1 FROM module_club_shares s
         JOIN org_members m ON m.org_id = s.org_id
        WHERE s.module_id = ? AND m.user_id = ?
        LIMIT 1`,
    )
    .get(moduleId, userId);
  return !!row;
}

async function loadModule(userId: string, id: string): Promise<ResourceTables | null> {
  const row = await db
    .select({
      ownerUserId: schema.modules.ownerUserId,
      ownerOrgId: schema.modules.ownerOrgId,
    })
    .from(schema.modules)
    .where(eq(schema.modules.id, id))
    .get();
  if (!row) return null;
  const collab = await db
    .select({ role: schema.moduleCollaborators.role })
    .from(schema.moduleCollaborators)
    .where(
      and(
        eq(schema.moduleCollaborators.moduleId, id),
        eq(schema.moduleCollaborators.userId, userId),
      ),
    )
    .get();
  // Shared with a club the caller is in: they may look at it and place it.
  const viaClub: Role | null = !collab && (await moduleSharedWithClubOf(userId, id)) ? 'viewer' : null;
  return {
    ownerUserId: row.ownerUserId,
    ownerOrgId: row.ownerOrgId,
    collaboratorRole: (collab?.role as Role) ?? viaClub,
  };
}

export async function resolveResourceRole(
  userId: string,
  kind: ResourceKind,
  resourceId: string,
): Promise<RoleResolution> {
  // Orgs are special: there's no separate ownership row + collaborators,
  // the membership table IS the access list. admin → owner, member →
  // editor. We short-circuit here rather than threading orgs through
  // the loadXxx helpers (which assume the resource has its own row).
  if (kind === 'org') {
    const access = await clubAccess(userId, resourceId);
    if (!access) return { role: null };
    // The club itself (its settings) is the admins'; everyone else in it uses it.
    return { role: access.isAdmin ? 'owner' : 'editor' };
  }

  let res: ResourceTables | null;
  switch (kind) {
    case 'layout':
      res = await loadLayout(userId, resourceId);
      break;
    case 'custom_part':
      res = await loadCustomPart(userId, resourceId);
      break;
    case 'module':
      res = await loadModule(userId, resourceId);
      break;
  }
  if (!res) return { role: null };

  let role: Role | null = null;

  if (res.ownerUserId === userId) {
    role = strongerOf(role, 'owner');
  }

  if (res.ownerOrgId) {
    const access = await clubAccess(userId, res.ownerOrgId);
    if (access) role = strongerOf(role, clubThingAccess(access, kind));
  }

  if (res.collaboratorRole) role = strongerOf(role, res.collaboratorRole);

  // The demo's samples (the template account's): any demo visitor may look
  // at them, so a link to "Sample layout" always opens (read only); their
  // own copies are theirs to change (demo/demoAccount.ts).
  if (role === null && res.ownerUserId === DEMO_TEMPLATE_ID && (await isDemoVisitor(userId))) role = 'viewer';

  // A restricted person's own things are frozen (privacy: restriction):
  // anyone who may see them still can, but nobody changes them.
  if (role !== null && role !== 'viewer' && res.ownerUserId && (await isRestricted(res.ownerUserId))) role = 'viewer';

  return { role };
}

/** The demo's template account (demo/demoAccount.ts DEMO_USER_ID; not imported here, to keep the import graph flat). */
const DEMO_TEMPLATE_ID = 'demo-account';

async function isDemoVisitor(userId: string): Promise<boolean> {
  const row = await db.select({ d: schema.users.isDemoAccount }).from(schema.users).where(eq(schema.users.id, userId)).get();
  return !!row?.d;
}

async function isRestricted(userId: string): Promise<boolean> {
  const row = await db.select({ r: schema.users.restrictedAt }).from(schema.users).where(eq(schema.users.id, userId)).get();
  return !!row?.r;
}

/** Convenience predicate: does the user have at least the given role? */
export function hasAtLeast(actual: Role | null, required: Role): boolean {
  if (actual === null) return false;
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}
