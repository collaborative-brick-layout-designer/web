// Making notifications (docs/notifications.md). Every place that has news
// for someone calls `notify` with the people who may see it; the title and
// body are written here, on the server, from what those people can see
// anyway. A notification never fails the request that made it: errors are
// logged and the request goes on.
//
// `resolve` closes the notifications about a request once it is answered,
// whoever answered it and however (the bell, the club's page, the desktop):
// everyone who got it then sees "Ann approved this" instead of the buttons.

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { publish } from '../events/audience.js';
import { clubAudience, type ClubNotice } from '../access/clubNotices.js';
import { clubMembersAccess } from '../access/clubPermissions.js';
import type { NotificationType } from './types.js';
import { channelsFor, settingsFor } from './settings.js';
import { publicName } from '../utils/publicName.js';
import { ownsEmail } from '../auth/users.js';

export const TITLE_MAX = 200;
export const BODY_MAX = 2000;
const LINK_MAX = 500;

/** What a notification is about; `kind` is one of the subject kinds in docs/notifications.md. */
export interface Subject {
  kind: string;
  id: string;
}

export interface NotifyArgs {
  type: NotificationType;
  /** Who gets it. Duplicates, empties and the actor themselves are left out. */
  to: readonly (string | null | undefined)[];
  /** The club it's from or about. */
  club?: string | null;
  /** Only the club's members still see it (a request waiting in the club, a note to its runners). */
  needsMembership?: boolean;
  /** Who did it (never notified about their own act). */
  actor?: string | null;
  /** Notify the actor too (a warning's copy to the club's runners, say). */
  includeActor?: boolean;
  subject?: Subject | null;
  title: string;
  body?: string;
  link?: string | null;
  groupKey?: string | null;
  at?: Date;
}

/** Called for each new row once it's stored (Web B: email and push). */
type Deliverer = (rows: schema.Notification[]) => Promise<void>;
const deliverers: Deliverer[] = [];
export function onNotified(fn: Deliverer): void {
  deliverers.push(fn);
}

let logError: (msg: string, err: unknown) => void = (msg, err) => console.error(msg, err);
export function setNotifyErrorLogger(fn: (msg: string, err: unknown) => void): void {
  logError = fn;
}

/** A path on this site, or null: no other sites, no `//host`, no `javascript:`. */
export function safeLink(link: string | null | undefined): string | null {
  if (!link || link.length > LINK_MAX || !link.startsWith('/') || link.startsWith('//') || /[\s\\]/.test(link)) return null;
  return link;
}

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Tell the people's open tabs and apps that their notifications changed. */
export function hintNotifications(userIds: readonly string[], action = 'update', id?: string): void {
  if (userIds.length === 0) return;
  void publish({ kind: 'notification', action, ...(id ? { id } : {}) }, { ownerless: true, users: [...new Set(userIds)] });
}

/** Store one notification per person and tell them live. Returns the new rows. */
export async function notify(a: NotifyArgs): Promise<schema.Notification[]> {
  try {
    const who = [...new Set(a.to.filter((u): u is string => !!u && (a.includeActor || u !== a.actor)))];
    if (who.length === 0) return [];
    // People whose accounts are gone in the meantime are skipped (the insert would fail its key).
    const live = new Set(
      (await db.select({ id: schema.users.id }).from(schema.users).where(inArray(schema.users.id, who)).all()).map((r) => r.id),
    );
    const at = a.at ?? new Date();
    // Turned off in the app (Settings › Notifications): kept hidden, for their email summary.
    const prefs = await settingsFor(who.filter((u) => live.has(u)));
    const rows: schema.Notification[] = who
      .filter((u) => live.has(u))
      .map((userId) => ({
        id: randomUUID(),
        userId,
        type: a.type,
        clubOrgId: a.club ?? null,
        needsMembership: !!(a.needsMembership && a.club),
        actorUserId: a.actor ?? null,
        subjectKind: a.subject?.kind ?? null,
        subjectId: a.subject?.id ?? null,
        title: clip(a.title, TITLE_MAX),
        body: clip(a.body ?? '', BODY_MAX),
        link: safeLink(a.link),
        groupKey: a.groupKey ?? null,
        createdAt: at,
        readAt: null,
        doneAt: null,
        outcome: null,
        outcomeBy: null,
        hidden: !channelsFor(prefs.get(userId)!, a.type, a.club ?? null).app,
      }));
    if (rows.length === 0) return [];
    for (let i = 0; i < rows.length; i += 200) db.insert(schema.notifications).values(rows.slice(i, i + 200)).run();
    hintNotifications(
      rows.filter((r) => !r.hidden).map((r) => r.userId),
      'create',
    );
    for (const d of deliverers) {
      try {
        await d(rows);
      } catch (err) {
        logError('[notifications] delivery failed', err);
      }
    }
    return rows;
  } catch (err) {
    logError('[notifications] could not store a notification', err);
    return [];
  }
}

/**
 * Notify the members of a club whose roles hear `notice`
 * (access/clubNotices.ts): requests to join and warnings to the club go to
 * whoever runs its people; partner requests, offers and notes about its
 * things to whoever looks after its things.
 */
export async function notifyClub(orgId: string, notice: ClubNotice, a: Omit<NotifyArgs, 'to' | 'club'>): Promise<schema.Notification[]> {
  try {
    return await notify({ ...a, to: await clubAudience(orgId, notice), club: orgId, needsMembership: a.needsMembership ?? true });
  } catch (err) {
    logError('[notifications] could not find who hears a club notice', err);
    return [];
  }
}

/** Every member of a club. */
export async function clubMemberIds(orgId: string): Promise<string[]> {
  return [...(await clubMembersAccess(orgId)).keys()];
}

export type Outcome = 'accepted' | 'declined' | 'withdrawn' | 'gone' | 'acknowledged';

/**
 * A request was answered (or went away): every open notification about it
 * is done, saying how and by whom. The one who answered has theirs marked
 * read too. Safe to call twice.
 */
export async function resolve(subject: Subject, outcome: Outcome, by: string | null, at = new Date()): Promise<void> {
  try {
    const open = await db
      .select({ id: schema.notifications.id, userId: schema.notifications.userId })
      .from(schema.notifications)
      .where(and(eq(schema.notifications.subjectKind, subject.kind), eq(schema.notifications.subjectId, subject.id), isNull(schema.notifications.doneAt)))
      .all();
    if (open.length === 0) return;
    db.update(schema.notifications)
      .set({ doneAt: at, outcome, outcomeBy: by })
      .where(inArray(schema.notifications.id, open.map((o) => o.id)))
      .run();
    if (by) {
      db.update(schema.notifications)
        .set({ readAt: at })
        .where(and(inArray(schema.notifications.id, open.map((o) => o.id)), eq(schema.notifications.userId, by), isNull(schema.notifications.readAt)))
        .run();
    }
    hintNotifications(open.map((o) => o.userId));
  } catch (err) {
    logError('[notifications] could not close a request’s notifications', err);
  }
}

/** A person's display name for a notification's words ("Builder #abc123" when it looks like an email). */
export async function nameOf(userId: string | null | undefined): Promise<string> {
  if (!userId) return 'Someone';
  const u = await db.select({ n: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, userId)).get();
  return u ? publicName(userId, u.n) : 'Someone';
}

/** The account that owns `email` and has proven it (auth/users.ts ownsEmail), or null. */
export async function provenAccountFor(email: string): Promise<string | null> {
  const u = await db
    .select()
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${email.trim().toLowerCase()}`)
    .get();
  if (!u) return null;
  return (await ownsEmail(u)) ? u.id : null;
}

/** An invite or hand-over by email: the account that owns the address hears in the app too. */
export async function notifyInvitee(email: string, a: Omit<NotifyArgs, 'to'>): Promise<void> {
  try {
    const to = await provenAccountFor(email);
    if (to) await notify({ ...a, to: [to] });
  } catch (err) {
    logError('[notifications] could not tell an invited account', err);
  }
}

/**
 * Like `notify`, but one row per person and `groupKey`: while their last
 * one is unread, it is brought up to date (new words, new time) instead of
 * a new row, so a busy module doesn't fill the list ("Updates wait in …").
 */
export async function notifyGrouped(a: NotifyArgs & { groupKey: string }): Promise<void> {
  try {
    const who = [...new Set(a.to.filter((u): u is string => !!u && u !== a.actor))];
    if (who.length === 0) return;
    const n = schema.notifications;
    const open = await db
      .select({ id: n.id, userId: n.userId })
      .from(n)
      .where(and(inArray(n.userId, who), eq(n.type, a.type), eq(n.groupKey, a.groupKey), isNull(n.readAt)))
      .all();
    const have = new Set(open.map((o) => o.userId));
    if (open.length) {
      db.update(n)
        .set({ title: clip(a.title, TITLE_MAX), body: clip(a.body ?? '', BODY_MAX), link: safeLink(a.link), createdAt: a.at ?? new Date(), actorUserId: a.actor ?? null })
        .where(inArray(n.id, open.map((o) => o.id)))
        .run();
      hintNotifications([...have], 'update');
    }
    const rest = who.filter((u) => !have.has(u));
    if (rest.length) await notify({ ...a, to: rest });
  } catch (err) {
    logError('[notifications] could not bring a grouped notification up to date', err);
  }
}
