// Partner clubs and one-off module offers between clubs
// (docs/shared-modules.md, section 11).
//
// - Partners: a club's Admins or Managers ask another club; its Admins or
//   Managers accept or decline. Partners share any of their club's modules
//   with each other, each module picked, with no accept per module
//   (module_club_shares, via 'partner').
// - One-off offers: a club's Admins or Managers offer one of its modules to
//   any club; that club's Admins or Managers accept it (module_club_shares,
//   via 'offer') or decline it.
// - Ending a partnership (either club's Admins) stops every module shared
//   through it, both ways, as "Stop sharing" does: placed copies stay at
//   their version, marked "No longer shared". Accepted one-off shares stay.
//
// "Admins or Managers" are whoever looks after the club's things: its Admins,
// and the roles that may delete its items (the starting Manager role does).
// That is the same rule as owning a club's module (clubThingAccess) and as
// taking a shared module off the club's list, so no new permission.

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { ClubAccess } from '../access/clubPermissions.js';
import { clubAudience } from '../access/clubNotices.js';
import { publish } from '../events/audience.js';
import { postClubNote, type NoteKind } from '../routes/warnings.js';
import { resolve } from '../notifications/notify.js';
import { moduleSharesChanged } from '../sharedModules/lifecycle.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';

/** The most clubs one module is shared with (the same limit as routes/moduleShares.ts). */
const MAX_SHARES_PER_MODULE = 50;

/** Partner requests one club may have waiting at once. */
export const OPEN_PARTNER_REQUESTS_MAX = 20;
/** Module offers one club may have waiting at once (to all clubs). */
export const OPEN_MODULE_OFFERS_MAX = 50;
/** Module offers one club may have waiting with one other club. */
export const OPEN_OFFERS_PER_CLUB_MAX = 20;
/** After a decline, the same request or offer can be sent again after this long. */
export const ASK_AGAIN_AFTER_MS = 24 * 60 * 60 * 1000;

type Org = typeof schema.orgs.$inferSelect;

/** Whether someone with `access` runs the club's partners and module offers (Admins or Managers). */
export function runsPartners(access: ClubAccess | null | undefined): boolean {
  return !!access && (access.isAdmin || access.permissions.has('delete_items'));
}

/** The club_partners key for two clubs: the smaller id first. */
export function pairOf(a: string, b: string): { orgA: string; orgB: string } {
  return a < b ? { orgA: a, orgB: b } : { orgA: b, orgB: a };
}

export async function arePartners(a: string, b: string): Promise<boolean> {
  const k = pairOf(a, b);
  const row = await db
    .select({ a: schema.clubPartners.orgA })
    .from(schema.clubPartners)
    .where(and(eq(schema.clubPartners.orgA, k.orgA), eq(schema.clubPartners.orgB, k.orgB)))
    .get();
  return !!row;
}

/** A club that is being deleted (hidden while it waits) counts as gone here. */
export function isLive(org: Pick<Org, 'deletionRequestedAt'> | null | undefined): boolean {
  return !!org && !org.deletionRequestedAt;
}

/** The partner clubs of `orgId`, with when they became partners. Clubs being deleted are left out. */
export async function partnersOf(orgId: string): Promise<{ org: Org; since: Date; requestedByOrg: string }[]> {
  const rows = await db
    .select()
    .from(schema.clubPartners)
    .where(or(eq(schema.clubPartners.orgA, orgId), eq(schema.clubPartners.orgB, orgId)))
    .all();
  if (rows.length === 0) return [];
  const otherIds = rows.map((r) => (r.orgA === orgId ? r.orgB : r.orgA));
  const orgs = new Map((await db.select().from(schema.orgs).where(inArray(schema.orgs.id, otherIds)).all()).map((o) => [o.id, o]));
  const out: { org: Org; since: Date; requestedByOrg: string }[] = [];
  for (const r of rows) {
    const o = orgs.get(r.orgA === orgId ? r.orgB : r.orgA);
    if (o && isLive(o)) out.push({ org: o, since: r.createdAt, requestedByOrg: r.requestedByOrg });
  }
  return out.sort((x, y) => x.org.name.localeCompare(y.org.name));
}

/**
 * A note to the club's Admins and Managers (with their other notices, live),
 * about another club: a partnership accepted or ended, a module accepted.
 */
export async function noteToClub(orgId: string, actorId: string | null, text: string, link: string | null, kind?: NoteKind): Promise<void> {
  const id = await postClubNote(orgId, actorId, text, link, kind);
  void publish({ kind: 'warning', id, action: 'create' }, { ownerless: true, users: await clubAudience(orgId, 'club_note') });
}

/**
 * The modules shared through the partnership of `a` and `b`, both ways:
 * shared 'partner' by one club with the other, and still that club's own
 * (a module handed to someone else keeps its shares, as any transfer does).
 */
export async function sharedThroughPartnership(a: string, b: string): Promise<{ moduleId: string; orgId: string; fromOrgId: string }[]> {
  const rows = await db
    .select({ moduleId: schema.moduleClubShares.moduleId, orgId: schema.moduleClubShares.orgId, fromOrgId: schema.moduleClubShares.fromOrgId, ownerOrgId: schema.modules.ownerOrgId })
    .from(schema.moduleClubShares)
    .innerJoin(schema.modules, eq(schema.modules.id, schema.moduleClubShares.moduleId))
    .where(
      and(
        eq(schema.moduleClubShares.via, 'partner'),
        or(
          and(eq(schema.moduleClubShares.fromOrgId, a), eq(schema.moduleClubShares.orgId, b)),
          and(eq(schema.moduleClubShares.fromOrgId, b), eq(schema.moduleClubShares.orgId, a)),
        ),
      ),
    )
    .all();
  return rows.filter((r) => r.ownerOrgId === r.fromOrgId).map((r) => ({ moduleId: r.moduleId, orgId: r.orgId, fromOrgId: r.fromOrgId! }));
}

/**
 * End the partnership of `orgId` and `otherId`: the partnership goes, and
 * every module shared through it stops, both ways (placed copies stay at
 * their version, "No longer shared"). One-off shares the clubs accepted
 * stay. Returns the modules that stopped, by the club that had them.
 */
export async function endPartnership(orgId: string, otherId: string): Promise<{ moduleId: string; orgId: string }[]> {
  const k = pairOf(orgId, otherId);
  const stopped = await sharedThroughPartnership(orgId, otherId);
  db.transaction((tx) => {
    tx.delete(schema.clubPartners).where(and(eq(schema.clubPartners.orgA, k.orgA), eq(schema.clubPartners.orgB, k.orgB))).run();
    for (const s of stopped) {
      tx.delete(schema.moduleClubShares)
        .where(and(eq(schema.moduleClubShares.moduleId, s.moduleId), eq(schema.moduleClubShares.orgId, s.orgId)))
        .run();
    }
  });
  for (const id of new Set(stopped.map((s) => s.moduleId))) await moduleSharesChanged(id);
  return stopped.map((s) => ({ moduleId: s.moduleId, orgId: s.orgId }));
}

/**
 * Before a club is erased: its partners, and the modules shared with it or
 * by it through partnerships and offers, so the state of each placed copy
 * is worked out again once the rows are gone (copies of its own modules
 * become "Deleted by its owner"; its one-off shares stop with it).
 */
export async function clubSharingBeforeErase(orgId: string): Promise<{ partners: Org[]; modules: string[] }> {
  const partners = (await partnersOf(orgId)).map((p) => p.org);
  const touched = await db
    .select({ moduleId: schema.moduleClubShares.moduleId })
    .from(schema.moduleClubShares)
    .where(or(eq(schema.moduleClubShares.orgId, orgId), eq(schema.moduleClubShares.fromOrgId, orgId)))
    .all();
  const own = await db.select({ id: schema.modules.id }).from(schema.modules).where(eq(schema.modules.ownerOrgId, orgId)).all();
  return { partners, modules: [...new Set([...touched.map((r) => r.moduleId), ...own.map((r) => r.id)])] };
}

/** After a club is erased: placed copies follow (see clubSharingBeforeErase), and its partners are told. */
export async function clubSharingAfterErase(before: { partners: Org[]; modules: string[] }, name: string, actorId: string | null): Promise<void> {
  for (const id of before.modules) {
    try {
      await moduleSharesChanged(id);
    } catch (err) {
      console.error("[clubPartners] couldn't refresh a module after a club was erased: %s", id, err);
    }
  }
  for (const p of before.partners) {
    // Its Partners section drops the club, live.
    void publish({ kind: 'club', owner: { kind: 'org', id: p.id }, id: p.id, action: 'update:partners' });
    await noteToClub(
      p.id,
      actorId,
      `${name} was deleted, so your clubs are no longer partners. Its modules placed in your layouts stay as they are, marked “Deleted by its owner”, and can be removed or made yours.`,
      `/orgs/${p.slug}?tab=partners`,
      { type: 'club.partner_deleted', title: `Your partner club ${name} was deleted` },
    );
  }
}

/** The pending partner requests and module offers waiting for each of `orgIds` to answer. */
export async function waitingFor(orgIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (orgIds.length === 0) return out;
  const reqs = await db
    .select({ to: schema.clubPartnerRequests.toOrgId, from: schema.clubPartnerRequests.fromOrgId })
    .from(schema.clubPartnerRequests)
    .innerJoin(schema.orgs, eq(schema.orgs.id, schema.clubPartnerRequests.fromOrgId))
    .where(and(inArray(schema.clubPartnerRequests.toOrgId, orgIds), eq(schema.clubPartnerRequests.state, 'pending'), isNull(schema.orgs.deletionRequestedAt)))
    .all();
  const offers = await db
    .select({ to: schema.moduleClubOffers.toOrgId })
    .from(schema.moduleClubOffers)
    .innerJoin(schema.orgs, eq(schema.orgs.id, schema.moduleClubOffers.fromOrgId))
    .where(and(inArray(schema.moduleClubOffers.toOrgId, orgIds), eq(schema.moduleClubOffers.state, 'pending'), isNull(schema.orgs.deletionRequestedAt)))
    .all();
  for (const r of [...reqs, ...offers]) out.set(r.to, (out.get(r.to) ?? 0) + 1);
  return out;
}

/**
 * Two clubs became partners: any module offer still waiting between them,
 * either way, becomes a partner share at once. Partners get modules without
 * accepting, so a waiting offer would be a dead end. The receiving club's
 * Admins and Managers are told. Offers that can't be turned (the module left
 * the club that offered it, or it is at its share limit) are left alone.
 */
export async function settleOffersBetween(a: string, b: string, actorId: string | null): Promise<number> {
  const rows = await db
    .select({ offer: schema.moduleClubOffers, title: schema.modules.title, ownerOrgId: schema.modules.ownerOrgId })
    .from(schema.moduleClubOffers)
    .innerJoin(schema.modules, eq(schema.modules.id, schema.moduleClubOffers.moduleId))
    .where(
      and(
        eq(schema.moduleClubOffers.state, 'pending'),
        or(
          and(eq(schema.moduleClubOffers.fromOrgId, a), eq(schema.moduleClubOffers.toOrgId, b)),
          and(eq(schema.moduleClubOffers.fromOrgId, b), eq(schema.moduleClubOffers.toOrgId, a)),
        ),
      ),
    )
    .all();
  let settled = 0;
  for (const r of rows) {
    const o = r.offer;
    if (r.ownerOrgId !== o.fromOrgId) continue;
    const have = await db.select({ n: schema.moduleClubShares.orgId }).from(schema.moduleClubShares).where(eq(schema.moduleClubShares.moduleId, o.moduleId)).all();
    if (have.length >= MAX_SHARES_PER_MODULE) continue;
    db.transaction((tx) => {
      tx.insert(schema.moduleClubShares)
        .values({ moduleId: o.moduleId, orgId: o.toOrgId, sharedBy: o.offeredBy, createdAt: new Date(), via: 'partner', fromOrgId: o.fromOrgId })
        .onConflictDoNothing()
        .run();
      tx.delete(schema.moduleClubOffers).where(eq(schema.moduleClubOffers.id, o.id)).run();
    });
    settled++;
    await resolve({ kind: 'module_offer', id: o.id }, 'accepted', actorId);
    await moduleSharesChanged(o.moduleId);
    await writeAuditEvent({ resourceKind: 'module', resourceId: o.moduleId, userId: actorId, eventType: 'share', payload: { club: o.toOrgId, readOnly: true, via: 'partner', fromOffer: true } });
    const [from, to] = await Promise.all([
      db.select().from(schema.orgs).where(eq(schema.orgs.id, o.fromOrgId)).get(),
      db.select().from(schema.orgs).where(eq(schema.orgs.id, o.toOrgId)).get(),
    ]);
    if (from && to) {
      await noteToClub(
        to.id,
        actorId,
        `${from.name} offered your club the module “${r.title}”, and now that your clubs are partners it is shared with you. Its members can place it in the club’s layouts, and they get ${from.name}’s updates.`,
        `/orgs/${to.slug}?tab=partners`,
        { type: 'sharing.module_shared', title: `${from.name} shared the module “${r.title}” with your club` },
      );
    }
  }
  return settled;
}
