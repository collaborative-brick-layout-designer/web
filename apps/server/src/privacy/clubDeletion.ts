// Deleting a club, done properly: it waits first, hidden, and anyone who
// ran it (or a site admin) can restore it with one click.
//
//   clubDeletionSummary()  what deleting it would take with it, in plain words
//   requestClubDeletion()  hides it now: its memberships are set aside in
//                          orgs.deletion_plan (so every list, page and access
//                          check stops showing it at once), live editors
//                          close, and every member gets a notice saying who
//                          deleted it, when it goes for good, and that its
//                          admins or a site admin can restore it
//   restoreClub()          puts the memberships back, as they were, with
//                          the roles each member held (custom ones too)
//   eraseClub()            after the wait (or a site admin's "Erase now"):
//                          the public catalog choice is applied (hand items
//                          and collections to a member, or take them down),
//                          then the club and everything it owns go
//
// Copies people already added from the catalog are theirs and stay either way.

import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { and, count, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { Org } from '../db/schema.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { docHub } from '../ws/docHub.js';
import { publish } from '../events/audience.js';
import { clubRoleList, successorRank } from '../access/clubPermissions.js';
import { postPersonalNote } from '../routes/warnings.js';
import { publicName } from '../utils/publicName.js';
import { backgroundImagePath } from './exportFiles.js';
import { removeExportsOf } from './exports.js';
import { privacySettings } from './settings.js';
import { clubSharingAfterErase, clubSharingBeforeErase } from '../clubPartners/partners.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export type CatalogChoice = 'hand' | 'takedown';

export interface DeletionPlan {
  /** roleIds: the club roles each held (member_roles goes with the membership rows). Absent in plans made before it was kept. */
  members: { userId: string; role: 'admin' | 'manager' | 'member'; joinedAt: number; roleIds?: string[] }[];
  listed: boolean;
  catalog: CatalogChoice;
  /** Who gets the public catalog items and collections ('hand'). */
  heirUserId: string | null;
}

export function readPlan(org: Pick<Org, 'deletionPlan'>): DeletionPlan | null {
  if (!org.deletionPlan) return null;
  try {
    return JSON.parse(org.deletionPlan) as DeletionPlan;
  } catch {
    return null;
  }
}

/** "Deleted club #abc123": the erasure record's pseudonym. */
export function erasedClubLabel(orgId: string): string {
  return `Deleted club #${orgId.replace(/[^0-9a-z]/gi, '').slice(0, 6).toLowerCase()}`;
}

interface Named {
  id: string;
  name: string;
}

export interface ClubDeletionSummary {
  name: string;
  members: { userId: string; name: string; role: string }[];
  layouts: Named[];
  modules: Named[];
  parts: Named[];
  venues: Named[];
  /** Collections only the club's members see: they go with it. */
  clubCollections: Named[];
  /** In the public catalog under the club's name: the admin chooses. */
  publicItems: Named[];
  publicCollections: Named[];
  graceDays: number;
}

export async function clubDeletionSummary(org: Org): Promise<ClubDeletionSummary> {
  const s = schema;
  const members = await db
    .select({ userId: s.orgMembers.userId, name: s.users.displayName, role: s.orgMembers.role })
    .from(s.orgMembers)
    .innerJoin(s.users, eq(s.users.id, s.orgMembers.userId))
    .where(eq(s.orgMembers.orgId, org.id))
    .all();
  const collections = await db
    .select({ id: s.catalogCollections.id, name: s.catalogCollections.title, audience: s.catalogCollections.audience, status: s.catalogCollections.status })
    .from(s.catalogCollections)
    .where(eq(s.catalogCollections.orgId, org.id))
    .all();
  const { deletionGraceDays } = await privacySettings();
  return {
    name: org.name,
    members: members.map((m) => ({ userId: m.userId, name: publicName(m.userId, m.name), role: m.role })),
    layouts: await db.select({ id: s.layouts.id, name: s.layouts.title }).from(s.layouts).where(eq(s.layouts.ownerOrgId, org.id)).all(),
    modules: await db.select({ id: s.modules.id, name: s.modules.title }).from(s.modules).where(eq(s.modules.ownerOrgId, org.id)).all(),
    parts: await db.select({ id: s.customParts.id, name: s.customParts.displayName }).from(s.customParts).where(eq(s.customParts.ownerOrgId, org.id)).all(),
    venues: await db.select({ id: s.venueLibrary.id, name: s.venueLibrary.name }).from(s.venueLibrary).where(eq(s.venueLibrary.ownerOrgId, org.id)).all(),
    clubCollections: collections.filter((c) => c.audience !== 'everyone').map(({ id, name }) => ({ id, name })),
    publicItems: await db
      .select({ id: s.catalogItems.id, name: s.catalogItems.title })
      .from(s.catalogItems)
      .where(and(eq(s.catalogItems.ownerOrgId, org.id), inArray(s.catalogItems.status, ['public', 'in_review'])))
      .all(),
    publicCollections: collections.filter((c) => c.audience === 'everyone').map(({ id, name }) => ({ id, name })),
    graceDays: deletionGraceDays,
  };
}

function day(d: Date): string {
  return d.toUTCString().replace(/ \d\d:\d\d:\d\d GMT$/, '');
}

/**
 * Hide the club and start its waiting time. The caller has checked who
 * may, the typed name, and the heir (a current member).
 */
export async function requestClubDeletion(
  org: Org,
  actor: { id: string; displayName: string; isGlobalAdmin?: boolean },
  choice: { catalog: CatalogChoice; heirUserId: string | null },
  now = new Date(),
): Promise<{ dueAt: Date }> {
  const s = schema;
  const { deletionGraceDays } = await privacySettings(now.getTime());
  const dueAt = new Date(now.getTime() + deletionGraceDays * DAY_MS);
  const members = await db.select().from(s.orgMembers).where(eq(s.orgMembers.orgId, org.id)).all();
  // Deleting the memberships below takes their role rows with them (cascade), so the plan keeps them.
  const held = new Map<string, string[]>();
  for (const r of await db.select().from(s.memberRoles).where(eq(s.memberRoles.orgId, org.id)).all()) {
    held.set(r.userId, [...(held.get(r.userId) ?? []), r.roleId]);
  }
  const plan: DeletionPlan = {
    members: members.map((m) => ({ userId: m.userId, role: m.role, joinedAt: m.joinedAt.getTime(), roleIds: held.get(m.userId) ?? [] })),
    listed: org.listed,
    catalog: choice.catalog,
    heirUserId: choice.heirUserId,
  };
  const layouts = (await db.select({ id: s.layouts.id }).from(s.layouts).where(eq(s.layouts.ownerOrgId, org.id)).all()).map((l) => l.id);
  db.transaction((tx) => {
    tx.update(s.orgs)
      .set({ deletionRequestedAt: now, deletionDueAt: dueAt, deletedBy: actor.id, deletionPlan: JSON.stringify(plan), listed: false })
      .where(eq(s.orgs.id, org.id))
      .run();
    tx.delete(s.orgMembers).where(eq(s.orgMembers.orgId, org.id)).run();
  });
  await docHub.closeMany(layouts);
  const by = actor.isGlobalAdmin && !members.some((m) => m.userId === actor.id) ? 'A site admin' : publicName(actor.id, actor.displayName);
  // Everyone else who was in it is told; whoever deleted it already knows.
  for (const m of members) {
    if (m.userId === actor.id) continue;
    await postPersonalNote(
      m.userId,
      `${by} deleted the club ${org.name} on ${day(now)}. It's hidden now, and will be gone for good on ${day(dueAt)}. Until then, any of the club's admins, or a site admin, can restore it with everything in it (Clubs › Being deleted).`,
      '/orgs#being-deleted',
      { clubOrgId: org.id, issuedBy: actor.id, kind: { type: 'club.deleted', title: `${by} deleted the club ${org.name}` } },
    );
  }
  await writeAuditEvent({
    resourceKind: 'org',
    resourceId: org.id,
    userId: actor.id,
    eventType: 'club_delete_request',
    payload: { name: org.name, slug: org.slug, dueAt: dueAt.getTime(), catalog: choice.catalog, heirUserId: choice.heirUserId, members: members.length },
  });
  // Everyone who was in it drops it from their screens.
  void publish({ kind: 'club', id: org.id, action: 'delete' }, { ownerless: true, users: [...members.map((m) => m.userId), actor.id] });
  return { dueAt };
}

/** May `user` restore this club? Its admins at the time, or a site admin. */
export function mayRestore(org: Pick<Org, 'deletionPlan'>, user: { id: string; isGlobalAdmin: boolean }): boolean {
  if (user.isGlobalAdmin) return true;
  return !!readPlan(org)?.members.some((m) => m.userId === user.id && m.role === 'admin');
}

export async function restoreClub(org: Org, actor: { id: string; displayName: string; isGlobalAdmin?: boolean }): Promise<number> {
  const s = schema;
  const plan = readPlan(org);
  const members = plan?.members ?? [];
  const alive = members.length
    ? new Set((await db.select({ id: s.users.id }).from(s.users).where(inArray(s.users.id, members.map((m) => m.userId))).all()).map((u) => u.id))
    : new Set<string>();
  const back = members.filter((m) => alive.has(m.userId));
  // The club's roles stay while it waits; any that went meanwhile are skipped.
  const roleIds = new Set((await db.select({ id: s.clubRoles.id }).from(s.clubRoles).where(eq(s.clubRoles.orgId, org.id)).all()).map((r) => r.id));
  // A club always has an admin: if none of its admins is still here, one
  // becomes it, chosen by permission as clubSuccessor does (whoever may
  // manage members and roles, then invite, then the longest member).
  if (back.length && !back.some((m) => m.role === 'admin')) {
    const roles = await clubRoleList(org.id);
    const rank = (m: (typeof back)[number]) => {
      const held = m.roleIds?.length ? roles.filter((r) => m.roleIds!.includes(r.id)) : roles.filter((r) => r.key === m.role);
      return successorRank({ isAdmin: held.some((r) => r.key === 'admin'), permissions: new Set(held.flatMap((r) => r.permissions)) });
    };
    const first = [...back].sort((a, b) => rank(a) - rank(b) || a.joinedAt - b.joinedAt)[0]!;
    first.role = 'admin';
    if (first.roleIds) first.roleIds = [...first.roleIds, `${org.id}:admin`];
  }
  db.transaction((tx) => {
    for (const m of back) {
      tx.insert(s.orgMembers).values({ orgId: org.id, userId: m.userId, role: m.role, joinedAt: new Date(m.joinedAt) }).onConflictDoNothing().run();
      // Older plans have no roleIds: those members get the built-in role org_members.role names (ensureClubRoles).
      for (const roleId of new Set(m.roleIds ?? [])) {
        if (roleIds.has(roleId)) tx.insert(s.memberRoles).values({ orgId: org.id, userId: m.userId, roleId }).onConflictDoNothing().run();
      }
    }
    tx.update(s.orgs)
      .set({ deletionRequestedAt: null, deletionDueAt: null, deletedBy: null, deletionPlan: null, listed: plan?.listed ?? false })
      .where(eq(s.orgs.id, org.id))
      .run();
  });
  const by = actor.isGlobalAdmin && !members.some((m) => m.userId === actor.id) ? 'A site admin' : publicName(actor.id, actor.displayName);
  for (const m of back) {
    if (m.userId === actor.id) continue;
    await postPersonalNote(m.userId, `${by} restored the club ${org.name}. It's back, with everything in it.`, `/orgs/${org.slug}`, {
      clubOrgId: org.id,
      issuedBy: actor.id,
      kind: { type: 'club.restored', title: `${org.name} is back` },
    });
  }
  await writeAuditEvent({ resourceKind: 'org', resourceId: org.id, userId: actor.id, eventType: 'club_restore', payload: { name: org.name, members: back.length } });
  void publish({ kind: 'club', owner: { kind: 'org', id: org.id }, id: org.id, action: 'update:restore' }, { users: [actor.id] });
  return back.length;
}

/**
 * Delete the club for good. Applies the public catalog choice first, then
 * the club and everything it owns go (layouts, modules, parts, venues,
 * club-only collections, invites, notices), with background pictures and
 * any club data downloads on disk. Leaves an erasures row.
 */
export async function eraseClub(orgId: string, actorId: string | null, how: 'self' | 'admin', now = new Date()): Promise<{ ref: string; counts: Record<string, number> } | null> {
  const s = schema;
  const org = await db.select().from(s.orgs).where(eq(s.orgs.id, orgId)).get();
  if (!org) return null;
  const plan = readPlan(org);
  const ref = erasedClubLabel(org.id);
  // Who gets the public things: the chosen member while they're still here,
  // else any of the club's admins at the time.
  let heir: string | null = null;
  if (plan?.catalog !== 'takedown') {
    const candidates = [plan?.heirUserId, ...(plan?.members ?? []).filter((m) => m.role === 'admin').map((m) => m.userId)].filter((x): x is string => !!x);
    for (const c of candidates) {
      if (await db.select({ id: s.users.id }).from(s.users).where(eq(s.users.id, c)).get()) {
        heir = c;
        break;
      }
    }
  }
  const layouts = (await db.select({ id: s.layouts.id }).from(s.layouts).where(eq(s.layouts.ownerOrgId, org.id)).all()).map((l) => l.id);
  const counts: Record<string, number> = {
    layouts: layouts.length,
    modules: (await db.select({ n: count() }).from(s.modules).where(eq(s.modules.ownerOrgId, org.id)).get())?.n ?? 0,
    parts: (await db.select({ n: count() }).from(s.customParts).where(eq(s.customParts.ownerOrgId, org.id)).get())?.n ?? 0,
    venues: (await db.select({ n: count() }).from(s.venueLibrary).where(eq(s.venueLibrary.ownerOrgId, org.id)).get())?.n ?? 0,
    members: plan?.members.length ?? (await db.select({ n: count() }).from(s.orgMembers).where(eq(s.orgMembers.orgId, org.id)).get())?.n ?? 0,
  };
  let handedOver = 0;
  // Its partnerships end, and its one-off shares stop with it (clubPartners/partners.ts).
  const sharing = await clubSharingBeforeErase(org.id);
  await docHub.closeMany(layouts);
  db.transaction((tx) => {
    if (heir) {
      // Public items and collections stay up, now the member's.
      handedOver += tx
        .update(s.catalogItems)
        .set({ ownerOrgId: null, ownerUserId: heir, updatedAt: now })
        .where(and(eq(s.catalogItems.ownerOrgId, org.id), inArray(s.catalogItems.status, ['public', 'in_review'])))
        .run().changes;
      handedOver += tx
        .update(s.catalogCollections)
        .set({ orgId: null, ownerUserId: heir, coverModuleId: null, pinned: false, updatedAt: now })
        .where(and(eq(s.catalogCollections.orgId, org.id), eq(s.catalogCollections.audience, 'everyone')))
        .run().changes;
    }
    counts.catalogHandedOver = handedOver;
    tx.delete(s.orgs).where(eq(s.orgs.id, org.id)).run();
    tx.insert(s.erasures).values({ id: randomUUID(), kind: 'org', ref, how, requestedAt: org.deletionRequestedAt, erasedAt: now, counts: JSON.stringify(counts) }).run();
  });
  for (const id of layouts) {
    const bg = backgroundImagePath(id);
    if (bg) {
      try {
        unlinkSync(bg.path);
      } catch {
        /* already gone */
      }
    }
  }
  await removeExportsOf({ kind: 'org', id: org.id });
  await clubSharingAfterErase(sharing, org.name, actorId);
  await writeAuditEvent({ resourceKind: 'org', resourceId: org.id, userId: actorId, eventType: 'club_erased', payload: { ref, how, counts, heir } });
  void publish({ kind: 'catalog', action: 'delete:club' }, { everyone: true });
  void publish({ kind: 'admin', action: 'delete:club' }, { ownerless: true });
  return { ref, counts };
}

/** Clubs whose waiting time is over (the privacy clean-up). */
export async function eraseDueClubs(now = new Date()): Promise<number> {
  const due = await db
    .select({ id: schema.orgs.id })
    .from(schema.orgs)
    .where(and(isNotNull(schema.orgs.deletionDueAt), lte(schema.orgs.deletionDueAt, now)))
    .all();
  let n = 0;
  for (const d of due) {
    try {
      if (await eraseClub(d.id, null, 'self', now)) n++;
    } catch (err) {
      console.error('[privacy] club erase failed:', err);
    }
  }
  return n;
}

/** Clubs waiting to be deleted that `user` was in (Clubs › Being deleted). */
export async function deletingClubsFor(user: { id: string; isGlobalAdmin: boolean }) {
  const rows = await db.select().from(schema.orgs).where(isNotNull(schema.orgs.deletionDueAt)).all();
  return rows
    .map((o) => ({ o, plan: readPlan(o) }))
    .filter(({ plan }) => plan?.members.some((m) => m.userId === user.id))
    .map(({ o }) => ({
      id: o.id,
      name: o.name,
      slug: o.slug,
      deletionRequestedAt: o.deletionRequestedAt?.getTime() ?? null,
      deletionDueAt: o.deletionDueAt!.getTime(),
      canRestore: mayRestore(o, user),
    }));
}

