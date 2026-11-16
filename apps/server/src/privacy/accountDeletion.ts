// "Delete my account", and erasing an account for good.
//
//   deletionSummary()   what will happen to each thing the person has, and
//                       anything to do first (hand a club over), in plain words
//   requestDeletion()   starts the waiting time (Privacy setting, default 14
//                       days): signs them out everywhere, emails them
//   cancelDeletion()    signing back in before then keeps the account
//   eraseUser()         the erasure itself (after the wait, or an admin's
//                       "Erase now"):
//     - things they own alone go with them (layouts, modules, parts, venues,
//       collections, public catalog items; background pictures and data
//       downloads on disk too)
//     - club things they made stay with the club, credited "Builder #…"
//       (deleted_author_id), with the club's admin standing in as its
//       maker; a club collection they curate moves to them too
//     - their edits to other people's layouts stay; they leave share lists
//     - a club they were the last admin of gets a new admin (someone who
//       may manage members and roles, else the longest-serving member:
//       clubSuccessor); a club with nobody else in it goes too
//     - the audit log keeps what happened, as "Deleted user #abc123": no
//       name, no email
//     - an `erasures` row records that it happened, with counts only
//
// The last site admin can never be deleted: someone has to run the site.

import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { and, asc, count, eq, inArray, isNotNull, like, lte, ne, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { User } from '../db/schema.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { addBuiltinRole, clubSuccessor } from '../access/clubPermissions.js';
import { invalidateAllSessions } from '../auth/session.js';
import { notifyCredentialRevoked } from '../auth/revocation.js';
import { docHub } from '../ws/docHub.js';
import { placedCopiesOfModulesOf, unlockPlacedCopies } from '../sharedModules/lifecycle.js';
import { publish } from '../events/audience.js';
import { sendNoticeEmail } from '../email/sendNotice.js';
import { postPersonalNote } from '../routes/warnings.js';
import { backgroundImagePath } from './exportFiles.js';
import { removeExportsOf } from './exports.js';
import { privacySettings } from './settings.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Deleted user #abc123": the same six characters as "Builder #abc123". */
export function erasedLabel(userId: string): string {
  return `Deleted user #${userId.replace(/[^0-9a-z]/gi, '').slice(0, 6).toLowerCase()}`;
}

interface Named {
  id: string;
  name: string;
}

export interface ClubLine {
  id: string;
  name: string;
  slug: string;
  role: 'admin' | 'manager' | 'member';
  /** Nobody else is in it: it goes with the account. */
  onlyMember: boolean;
  /** They're its only admin and others are in it: hand it over first. */
  lastAdmin: boolean;
}

export interface DeletionSummary {
  /** Things they own alone: deleted unless moved first. */
  ownedAlone: {
    layouts: Named[];
    modules: Named[];
    parts: Named[];
    venues: Named[];
    collections: Named[];
    /** Their public catalog items (people's copies stay). */
    catalogItems: Named[];
  };
  /** Club things they made: stay with the club, credited "Builder #…". */
  madeForClubs: number;
  /** Other people's layouts, modules and parts shared with them: their edits stay. */
  sharedWithThem: number;
  clubs: ClubLine[];
  /** Things to do first, each a guided step; empty when they may go ahead. */
  blockers: { kind: 'last_club_admin' | 'last_site_admin'; text: string; club?: { name: string; slug: string } }[];
  /** How long the account waits before it's erased. */
  graceDays: number;
  /** Set when a deletion is waiting. */
  pending: { requestedAt: number; dueAt: number } | null;
  /** The pseudonym the site will show afterwards. */
  erasedAs: string;
}

function named(rows: { id: string; name: string }[]): Named[] {
  return rows;
}

export async function deletionSummary(user: User): Promise<DeletionSummary> {
  const s = schema;
  const uid = user.id;
  const layouts = named(await db.select({ id: s.layouts.id, name: s.layouts.title }).from(s.layouts).where(eq(s.layouts.ownerUserId, uid)).all());
  const modules = named(await db.select({ id: s.modules.id, name: s.modules.title }).from(s.modules).where(eq(s.modules.ownerUserId, uid)).all());
  const parts = named(await db.select({ id: s.customParts.id, name: s.customParts.displayName }).from(s.customParts).where(eq(s.customParts.ownerUserId, uid)).all());
  const venues = named(await db.select({ id: s.venueLibrary.id, name: s.venueLibrary.name }).from(s.venueLibrary).where(eq(s.venueLibrary.ownerUserId, uid)).all());
  const collections = named(
    await db
      .select({ id: s.catalogCollections.id, name: s.catalogCollections.title })
      .from(s.catalogCollections)
      .where(and(eq(s.catalogCollections.ownerUserId, uid), sql`${s.catalogCollections.orgId} IS NULL`))
      .all(),
  );
  const catalogItems = named(
    await db
      .select({ id: s.catalogItems.id, name: s.catalogItems.title })
      .from(s.catalogItems)
      .where(and(eq(s.catalogItems.ownerUserId, uid), eq(s.catalogItems.status, 'public')))
      .all(),
  );
  const madeForClubs =
    ((await db.select({ n: count() }).from(s.layouts).where(and(eq(s.layouts.createdBy, uid), isNotNull(s.layouts.ownerOrgId))).get())?.n ?? 0) +
    ((await db.select({ n: count() }).from(s.modules).where(and(eq(s.modules.createdBy, uid), isNotNull(s.modules.ownerOrgId))).get())?.n ?? 0) +
    ((await db.select({ n: count() }).from(s.customParts).where(and(eq(s.customParts.createdBy, uid), isNotNull(s.customParts.ownerOrgId))).get())?.n ?? 0) +
    ((await db.select({ n: count() }).from(s.venueLibrary).where(and(eq(s.venueLibrary.createdBy, uid), isNotNull(s.venueLibrary.ownerOrgId))).get())?.n ?? 0);
  const sharedWithThem =
    ((await db.select({ n: count() }).from(s.layoutCollaborators).where(eq(s.layoutCollaborators.userId, uid)).get())?.n ?? 0) +
    ((await db.select({ n: count() }).from(s.moduleCollaborators).where(eq(s.moduleCollaborators.userId, uid)).get())?.n ?? 0) +
    ((await db.select({ n: count() }).from(s.customPartCollaborators).where(eq(s.customPartCollaborators.userId, uid)).get())?.n ?? 0);

  const clubs = await clubLines(uid);
  const blockers: DeletionSummary['blockers'] = [];
  for (const c of clubs.filter((c) => c.lastAdmin)) {
    blockers.push({
      kind: 'last_club_admin',
      text: `You're the only admin of ${c.name}. Hand it over to another member first, so the club keeps running.`,
      club: { name: c.name, slug: c.slug },
    });
  }
  if (user.isGlobalAdmin && (await siteAdminCount()) <= 1) {
    blockers.push({ kind: 'last_site_admin', text: "You're the only site admin, and someone has to run the site, so this account can't be deleted." });
  }
  const { deletionGraceDays } = await privacySettings();
  return {
    ownedAlone: { layouts, modules, parts, venues, collections, catalogItems },
    madeForClubs,
    sharedWithThem,
    clubs,
    blockers,
    graceDays: deletionGraceDays,
    pending: user.deletionDueAt ? { requestedAt: user.deletionRequestedAt?.getTime() ?? 0, dueAt: user.deletionDueAt.getTime() } : null,
    erasedAs: erasedLabel(uid),
  };
}

async function siteAdminCount(): Promise<number> {
  return (await db.select({ n: count() }).from(schema.users).where(eq(schema.users.isGlobalAdmin, true)).get())?.n ?? 0;
}

async function clubLines(uid: string): Promise<ClubLine[]> {
  const s = schema;
  const mine = await db
    .select({ id: s.orgs.id, name: s.orgs.name, slug: s.orgs.slug, role: s.orgMembers.role })
    .from(s.orgMembers)
    .innerJoin(s.orgs, eq(s.orgs.id, s.orgMembers.orgId))
    .where(eq(s.orgMembers.userId, uid))
    .all();
  const out: ClubLine[] = [];
  for (const c of mine) {
    const others = await db
      .select({ role: s.orgMembers.role })
      .from(s.orgMembers)
      .where(and(eq(s.orgMembers.orgId, c.id), ne(s.orgMembers.userId, uid)))
      .all();
    out.push({
      ...c,
      onlyMember: others.length === 0,
      lastAdmin: c.role === 'admin' && others.length > 0 && !others.some((o) => o.role === 'admin'),
    });
  }
  return out;
}

/** The typed confirmation: their email, or their name. */
export function confirmMatches(user: Pick<User, 'email' | 'displayName'>, typed: unknown): boolean {
  if (typeof typed !== 'string') return false;
  const t = typed.trim().toLowerCase();
  if (!t) return false;
  return t === user.email.trim().toLowerCase() || (!!user.displayName.trim() && t === user.displayName.trim().toLowerCase());
}

function whenText(d: Date): string {
  return d.toUTCString().replace(/ GMT$/, ' UTC');
}

/**
 * Start the waiting time. The caller has checked the confirmation and the
 * blockers. Signs them out of every browser; desktop sign-ins stay but
 * are refused until they sign back in (attachUser), so the desktop can
 * say why.
 */
export async function requestDeletion(user: User, now = new Date()): Promise<{ dueAt: Date }> {
  const { deletionGraceDays } = await privacySettings(now.getTime());
  const dueAt = new Date(now.getTime() + deletionGraceDays * DAY_MS);
  await db.update(schema.users).set({ deletionRequestedAt: now, deletionDueAt: dueAt }).where(eq(schema.users.id, user.id));
  // Live editors drop first, saying why; then every browser is signed out.
  notifyCredentialRevoked({ userId: user.id, reason: 'account_pending_deletion' });
  await invalidateAllSessions(user.id);
  await writeAuditEvent({
    resourceKind: 'user',
    resourceId: user.id,
    userId: user.id,
    eventType: 'deletion_request',
    payload: { dueAt: dueAt.getTime(), graceDays: deletionGraceDays },
  });
  await sendNoticeEmail({
    to: user.email,
    subject: 'Your account will be deleted',
    paragraphs: [
      `You asked us to delete your Collaborative Brick Layout Designer account. It will be deleted for good on ${whenText(dueAt)}.`,
      'Changed your mind? Just sign in before then and your account stays, with everything in it.',
      'If you did not ask for this, sign in now and change your password.',
    ],
    link: { text: 'Sign in to keep your account', path: '/login' },
  });
  return { dueAt };
}

/** Signing in keeps a pending account: called for every new session. True when one was cancelled. */
export async function cancelDeletionOnSignIn(userId: string): Promise<boolean> {
  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user?.deletionDueAt) return false;
  await db.update(schema.users).set({ deletionRequestedAt: null, deletionDueAt: null }).where(eq(schema.users.id, userId));
  await writeAuditEvent({ resourceKind: 'user', resourceId: userId, userId, eventType: 'deletion_cancel', payload: { by: 'sign_in' } });
  await postPersonalNote(userId, 'Welcome back. You signed in, so your account will not be deleted. Everything in it is just as you left it.', '/profile#delete-account');
  await sendNoticeEmail({
    to: user.email,
    subject: 'Your account will not be deleted',
    paragraphs: ['You signed in, so your Collaborative Brick Layout Designer account will not be deleted. Everything in it is just as you left it.'],
  });
  return true;
}

/** The person's own data downloads go before they do; the caller audits. */
async function sweepFiles(layoutIds: string[]): Promise<void> {
  for (const id of layoutIds) {
    const bg = backgroundImagePath(id);
    if (bg) {
      try {
        unlinkSync(bg.path);
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Someone to stand in as `created_by` (which must name an account) once
 * the author is gone: the club's member chosen by permission (clubSuccessor),
 * else the longest-standing site admin.
 */
async function standIn(orgId: string | null, excluding: string): Promise<string | null> {
  if (orgId) {
    const member = await clubSuccessor(orgId, excluding);
    if (member) return member;
  }
  const site = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.isGlobalAdmin, true), ne(schema.users.id, excluding)))
    .orderBy(asc(schema.users.createdAt))
    .get();
  return site?.id ?? null;
}

export class EraseRefused extends Error {}

/**
 * Erase an account for good. `how` says who asked (the erasure record);
 * `actorId` is the admin who did it, or null for the person's own
 * deletion after the wait. Refuses the last site admin.
 */
export async function eraseUser(userId: string, how: 'self' | 'admin' | 'request', actorId: string | null, now = new Date()): Promise<{ ref: string; counts: Record<string, number> } | null> {
  const s = schema;
  const user = await db.select().from(s.users).where(eq(s.users.id, userId)).get();
  if (!user) return null;
  if (user.isDemoAccount) throw new EraseRefused('demo_account');
  if (user.isGlobalAdmin && (await siteAdminCount()) <= 1) throw new EraseRefused('last_site_admin');
  const ref = erasedLabel(userId);

  // ---- clubs: a new admin where they were the last; alone, the club goes ----
  const clubs = await clubLines(userId);
  const clubsGone: string[] = [];
  for (const c of clubs) {
    if (c.onlyMember) {
      clubsGone.push(c.id);
      continue;
    }
    if (!c.lastAdmin) continue;
    // By permission: whoever may manage members and roles, then whoever
    // may invite, then the longest-serving member (clubSuccessor).
    const heir = await clubSuccessor(c.id, userId);
    if (!heir) continue;
    // The heir gets the club's Admin role on top of the roles they hold.
    await addBuiltinRole(c.id, heir, 'admin');
    await writeAuditEvent({ resourceKind: 'org', resourceId: c.id, userId: null, eventType: 'hand_over', payload: { toUserId: heir, reason: 'admin_account_deleted' } });
    await postPersonalNote(heir, `${c.name}'s only admin deleted their account, so you're now its admin. You can make others admins too.`, `/orgs/${c.slug}`, {
      clubOrgId: c.id,
    });
  }

  // ---- what goes, for the counts and the files on disk ----------------------
  const ownedLayouts = (await db.select({ id: s.layouts.id }).from(s.layouts).where(eq(s.layouts.ownerUserId, userId)).all()).map((r) => r.id);
  const clubLayouts = clubsGone.length
    ? (await db.select({ id: s.layouts.id }).from(s.layouts).where(inArray(s.layouts.ownerOrgId, clubsGone)).all()).map((r) => r.id)
    : [];
  const counts: Record<string, number> = {
    layouts: ownedLayouts.length,
    modules: (await db.select({ n: count() }).from(s.modules).where(eq(s.modules.ownerUserId, userId)).get())?.n ?? 0,
    parts: (await db.select({ n: count() }).from(s.customParts).where(eq(s.customParts.ownerUserId, userId)).get())?.n ?? 0,
    venues: (await db.select({ n: count() }).from(s.venueLibrary).where(eq(s.venueLibrary.ownerUserId, userId)).get())?.n ?? 0,
    catalogItems: (await db.select({ n: count() }).from(s.catalogItems).where(eq(s.catalogItems.ownerUserId, userId)).get())?.n ?? 0,
    clubs: clubsGone.length,
  };

  // created_by must name an account: work out the stand-ins before the transaction.
  const authored: { table: 'layouts' | 'modules' | 'customParts'; id: string; ownerUserId: string | null; ownerOrgId: string | null }[] = [];
  for (const table of ['layouts', 'modules', 'customParts'] as const) {
    const t = s[table];
    const rows = await db.select({ id: t.id, ownerUserId: t.ownerUserId, ownerOrgId: t.ownerOrgId }).from(t).where(and(eq(t.createdBy, userId), or(ne(t.ownerUserId, userId), sql`${t.ownerUserId} IS NULL`))).all();
    for (const r of rows) authored.push({ table, ...r });
  }
  const standIns = new Map<string, string | null>();
  for (const a of authored) {
    const key = a.ownerUserId ? `u:${a.ownerUserId}` : `o:${a.ownerOrgId ?? ''}`;
    if (!standIns.has(key)) standIns.set(key, a.ownerUserId ?? (await standIn(a.ownerOrgId, userId)));
  }
  const clubCollections = await db
    .select({ id: s.catalogCollections.id, orgId: s.catalogCollections.orgId })
    .from(s.catalogCollections)
    .where(and(eq(s.catalogCollections.ownerUserId, userId), isNotNull(s.catalogCollections.orgId)))
    .all();
  const collectionHeirs = new Map<string, string | null>();
  for (const c of clubCollections) collectionHeirs.set(c.id, clubsGone.includes(c.orgId!) ? null : await standIn(c.orgId, userId));

  // Placed copies of their modules in other people's layouts lose the lock (sharedModules/lifecycle.ts).
  const placedCopies = await placedCopiesOfModulesOf(userId);

  const email = user.email;
  const name = user.displayName.trim();
  db.transaction((tx) => {
    // The audit log keeps what happened, without who it was.
    tx.update(s.auditEvents).set({ actorLabel: ref }).where(eq(s.auditEvents.userId, userId)).run();
    const touching = or(eq(s.auditEvents.userId, userId), and(eq(s.auditEvents.resourceKind, 'user'), eq(s.auditEvents.resourceId, userId)), like(s.auditEvents.payload, `%${email}%`));
    const rows = tx.select({ id: s.auditEvents.id, payload: s.auditEvents.payload, userId: s.auditEvents.userId }).from(s.auditEvents).where(touching).all();
    for (const r of rows) {
      let p = r.payload.split(email).join('(erased)');
      // Their name, only in their own rows (it may be a common word elsewhere).
      if (name.length >= 2 && (r.userId === userId || p.includes(userId))) p = p.split(JSON.stringify(name).slice(1, -1)).join(ref);
      if (p !== r.payload) tx.update(s.auditEvents).set({ payload: p }).where(eq(s.auditEvents.id, r.id)).run();
    }

    // Club things they made stay with the club, credited "Builder #…".
    for (const a of authored) {
      const by = standIns.get(a.ownerUserId ? `u:${a.ownerUserId}` : `o:${a.ownerOrgId ?? ''}`);
      const t = s[a.table];
      if (!by) {
        // Nobody can stand in (a club with no one left, and no site admin): it goes.
        tx.delete(t).where(eq(t.id, a.id)).run();
        continue;
      }
      tx.update(t).set({ createdBy: by, deletedAuthorId: userId }).where(eq(t.id, a.id)).run();
    }
    for (const [id, heir] of collectionHeirs) {
      if (heir) tx.update(s.catalogCollections).set({ ownerUserId: heir }).where(eq(s.catalogCollections.id, id)).run();
    }

    // Offers and invites that carry their name or email.
    tx.delete(s.layoutTransfers).where(or(eq(s.layoutTransfers.initiatedBy, userId), eq(s.layoutTransfers.recipientEmail, email))).run();
    tx.delete(s.moduleTransfers).where(or(eq(s.moduleTransfers.initiatedBy, userId), eq(s.moduleTransfers.recipientEmail, email))).run();
    tx.delete(s.orgInvites).where(or(eq(s.orgInvites.invitedBy, userId), eq(s.orgInvites.invitedEmail, email))).run();
    tx.delete(s.layoutInvites).where(or(eq(s.layoutInvites.invitedBy, userId), eq(s.layoutInvites.invitedEmail, email))).run();
    tx.delete(s.moduleInvites).where(or(eq(s.moduleInvites.invitedBy, userId), eq(s.moduleInvites.invitedEmail, email))).run();
    tx.delete(s.customPartInvites).where(or(eq(s.customPartInvites.invitedBy, userId), eq(s.customPartInvites.invitedEmail, email))).run();
    // Their own counters and limits.
    tx.delete(s.usageDaily).where(and(eq(s.usageDaily.subjectKind, 'user'), eq(s.usageDaily.subjectId, userId))).run();
    tx.delete(s.limitOverrides).where(and(eq(s.limitOverrides.subjectKind, 'user'), eq(s.limitOverrides.subjectId, userId))).run();
    // Clubs nobody else is in.
    if (clubsGone.length) tx.delete(s.orgs).where(inArray(s.orgs.id, clubsGone)).run();
    // The account: sessions, tokens, memberships, shares, preferences, notices
    // and everything they own alone cascade with it.
    tx.delete(s.users).where(eq(s.users.id, userId)).run();
    tx.insert(s.erasures)
      .values({ id: randomUUID(), kind: 'user', ref, how, requestedAt: user.deletionRequestedAt, erasedAt: now, counts: JSON.stringify(counts) })
      .run();
  });

  await removeExportsOf({ kind: 'user', id: userId });
  await sweepFiles([...ownedLayouts, ...clubLayouts]);
  notifyCredentialRevoked({ userId });
  await docHub.closeMany([...ownedLayouts, ...clubLayouts]);
  await unlockPlacedCopies(placedCopies, userId);
  await writeAuditEvent({ resourceKind: 'user', resourceId: userId, userId: actorId, eventType: 'account_erased', payload: { ref, how, counts } });
  void publish({ kind: 'admin', action: 'delete:user' }, { ownerless: true });
  return { ref, counts };
}

/** Accounts whose waiting time is over (the privacy clean-up erases them). */
export async function eraseDueAccounts(now = new Date()): Promise<number> {
  const due = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(isNotNull(schema.users.deletionDueAt), lte(schema.users.deletionDueAt, now)))
    .all();
  let n = 0;
  for (const d of due) {
    try {
      if (await eraseUser(d.id, 'self', null, now)) n++;
    } catch (err) {
      // The last site admin, say: leave the account and keep going.
      if (!(err instanceof EraseRefused)) console.error('[privacy] erase failed:', err);
    }
  }
  return n;
}
