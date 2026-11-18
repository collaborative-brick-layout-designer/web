// Notifications by email, as each person chose (settings.ts):
//
//   - right away: a delivery row per notification, due now or when their
//     quiet hours end; the delivery job sends what is due. Past
//     EMAILS_PER_HOUR in an hour, the rest wait for the next daily summary
//     instead ('deferred'), so a flood can't fill a mailbox. Warnings are
//     never held back by the cap.
//   - daily or weekly summary: one email listing what is unread since the
//     last summary, once its time comes in their time zone. A digest row is
//     written before the email goes, so a restart never sends one twice.
//
// Both run inside the server, every minute (workers/index.ts): nothing
// else is needed on the host. Without SMTP nothing is sent and nothing
// piles up (rows are marked 'skipped').

import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, gt, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { emailConfigured } from '../email/transporter.js';
import { sendNotificationEmail } from '../email/sendNotification.js';
import { channelsFor, periodKey, quietEnds, settingsFor, summaryDue, type Resolved } from './settings.js';
import { NOTIFICATION_TYPES, isNotificationType } from './types.js';
import { unsubscribePaths } from './unsubscribe.js';
import { onNotified } from './notify.js';

/** Right-away emails one person gets in an hour before the rest wait for the summary. */
export const EMAILS_PER_HOUR = 20;
/** Most items listed in one summary (the rest: "and N more"). */
const SUMMARY_MAX = 50;
const BATCH = 200;
const WARNING_TYPES = new Set(['moderation.warning', 'moderation.final_warning']);

let logError: (msg: string, err: unknown) => void = (msg, err) => console.error(msg, err);
export function setDeliveryErrorLogger(fn: (msg: string, err: unknown) => void): void {
  logError = fn;
}

/** Queue the right-away emails for new notifications (called by notify()). */
export async function queueDeliveries(rows: schema.Notification[], now = new Date()): Promise<void> {
  if (rows.length === 0) return;
  const settings = await settingsFor(rows.map((r) => r.userId));
  const out: (typeof schema.notificationDeliveries.$inferInsert)[] = [];
  for (const r of rows) {
    const s = settings.get(r.userId)!;
    const ch = channelsFor(s, r.type, r.clubOrgId);
    if (ch.email === 'now') {
      out.push({ id: randomUUID(), notificationId: r.id, userId: r.userId, channel: 'email', dueAt: quietEnds(s, now), state: 'waiting', createdAt: now });
    }
  }
  if (out.length) db.insert(schema.notificationDeliveries).values(out).run();
}

onNotified(async (rows) => {
  await queueDeliveries(rows);
  // What's due now goes at once, after the request (never slows it down).
  setImmediate(() => void sendDue().catch((err: unknown) => logError('[notifications] sending failed', err)));
});

const why = (type: string) => {
  const info = isNotificationType(type) ? NOTIFICATION_TYPES[type] : null;
  return info ? `You get this because “${info.label}” emails you right away in your notification settings.` : 'You get this because of your notification settings.';
};

/** Send the right-away emails that are due. Returns how many went. */
export async function sendDue(now = new Date()): Promise<number> {
  const d = schema.notificationDeliveries;
  const due = await db
    .select()
    .from(d)
    .where(and(eq(d.state, 'waiting'), eq(d.channel, 'email'), lte(d.dueAt, now)))
    .orderBy(d.dueAt)
    .limit(BATCH)
    .all();
  if (due.length === 0) return 0;
  const canSend = await emailConfigured();
  let sent = 0;
  for (const job of due) {
    // Claim it: two runs at once can't both send it.
    const claimed = db.update(d).set({ state: 'sending' }).where(and(eq(d.id, job.id), eq(d.state, 'waiting'))).run();
    if (claimed.changes === 0) continue;
    const n = await db.select().from(schema.notifications).where(eq(schema.notifications.id, job.notificationId)).get();
    const user = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, job.userId)).get();
    // Gone, already read or answered in the app meanwhile, or no email here: nothing to send.
    if (!n || !user || !canSend || (n.readAt && !WARNING_TYPES.has(n.type)) || (n.doneAt && !WARNING_TYPES.has(n.type))) {
      db.update(d).set({ state: 'skipped' }).where(eq(d.id, job.id)).run();
      continue;
    }
    if (!WARNING_TYPES.has(n.type)) {
      const lastHour = await db
        .select({ c: count() })
        .from(d)
        .where(and(eq(d.userId, job.userId), eq(d.channel, 'email'), eq(d.state, 'sent'), gte(d.sentAt, new Date(now.getTime() - 3_600_000))))
        .get();
      if ((lastHour?.c ?? 0) >= EMAILS_PER_HOUR) {
        db.update(d).set({ state: 'deferred' }).where(eq(d.id, job.id)).run();
        continue;
      }
    }
    const links = unsubscribePaths(job.userId, isNotificationType(n.type) ? n.type : 'all');
    const ok = await sendNotificationEmail({
      to: user.email,
      subject: n.title,
      items: [{ title: n.title, body: n.body, link: n.link ?? '/notifications' }],
      why: why(n.type),
      unsubscribePath: links?.page ?? null,
      oneClickPath: links?.oneClick ?? null,
      unsubscribeLabel: 'Stop these emails',
    });
    db.update(d).set({ state: ok ? 'sent' : 'failed', sentAt: ok ? new Date() : null }).where(eq(d.id, job.id)).run();
    if (ok) sent++;
  }
  return sent;
}

/** The people who may have a summary due: someone chose one somewhere, or has right-away emails waiting for one. */
async function summaryCandidates(): Promise<string[]> {
  const chose = await db.select({ u: schema.notificationSettings.userId, s: schema.notificationSettings.settings }).from(schema.notificationSettings).all();
  const out = new Set(chose.filter((r) => r.s.includes('"daily"') || r.s.includes('"weekly"')).map((r) => r.u));
  const deferred = await db
    .selectDistinct({ u: schema.notificationDeliveries.userId })
    .from(schema.notificationDeliveries)
    .where(eq(schema.notificationDeliveries.state, 'deferred'))
    .all();
  for (const r of deferred) out.add(r.u);
  return [...out];
}

/** The clubs `userId` is in (club rows only reach members, as in the lists). */
async function clubsOf(userId: string): Promise<string[]> {
  return (await db.select({ o: schema.orgMembers.orgId }).from(schema.orgMembers).where(eq(schema.orgMembers.userId, userId)).all()).map((r) => r.o);
}

async function lastSummaryAt(userId: string, kind: 'daily' | 'weekly'): Promise<Date | null> {
  const g = schema.notificationDigests;
  const row = await db.select({ at: g.createdAt }).from(g).where(and(eq(g.userId, userId), eq(g.kind, kind), inArray(g.state, ['sent', 'empty']))).orderBy(desc(g.createdAt)).get();
  return row?.at ?? null;
}

/** One summary for one person, if it's due and not sent yet. Returns true when an email went. */
export async function summaryFor(userId: string, kind: 'daily' | 'weekly', s: Resolved, now: Date, canSend: boolean): Promise<boolean> {
  const wants = Object.values(s.types).some((t) => t.email === kind);
  const n = schema.notifications;
  const d = schema.notificationDeliveries;
  const deferred = kind === 'daily' ? await db.select({ id: d.id, nid: d.notificationId }).from(d).where(and(eq(d.userId, userId), eq(d.state, 'deferred'))).all() : [];
  if (!wants && deferred.length === 0) return false;
  if (!summaryDue(kind, s, now)) return false;
  const period = periodKey(kind, s, now);
  // Written first: a restart, or a second run at the same time, finds it and sends nothing.
  const id = randomUUID();
  const made = db.insert(schema.notificationDigests).values({ id, userId, kind, period, items: 0, state: 'sending', createdAt: now }).onConflictDoNothing().run();
  if (made.changes === 0) return false;
  const since = (await lastSummaryAt(userId, kind)) ?? new Date(now.getTime() - (kind === 'daily' ? 1 : 7) * 86_400_000);
  const clubs = await clubsOf(userId);
  const rows = await db
    .select()
    .from(n)
    .where(
      and(
        eq(n.userId, userId),
        isNull(n.readAt),
        or(gt(n.createdAt, since), inArray(n.id, deferred.length ? deferred.map((x) => x.nid) : ['-'])),
        clubs.length ? or(eq(n.needsMembership, false), inArray(n.clubOrgId, clubs)) : eq(n.needsMembership, false),
      ),
    )
    .orderBy(desc(n.createdAt))
    .all();
  const deferredIds = new Set(deferred.map((x) => x.nid));
  const items = rows.filter((r) => deferredIds.has(r.id) || channelsFor(s, r.type, r.clubOrgId).email === kind);
  if (deferred.length) db.update(d).set({ state: 'sent', sentAt: now }).where(inArray(d.id, deferred.map((x) => x.id))).run();
  const user = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).get();
  if (items.length === 0 || !user || !canSend) {
    db.update(schema.notificationDigests).set({ state: 'empty', items: items.length }).where(eq(schema.notificationDigests.id, id)).run();
    return false;
  }
  const shown = items.slice(0, SUMMARY_MAX);
  const more = items.length - shown.length;
  const links = unsubscribePaths(userId, 'all');
  const word = kind === 'daily' ? 'daily' : 'weekly';
  const ok = await sendNotificationEmail({
    to: user.email,
    subject: `Your ${word} summary: ${items.length} new ${items.length === 1 ? 'notification' : 'notifications'}`,
    intro: `Here’s what’s new since your last ${word} summary.${more > 0 ? ` The ${shown.length} newest are below, and ${more} more are in Notifications.` : ''}`,
    items: [...shown.map((r) => ({ title: r.title, body: r.body, link: r.link ?? '/notifications' })), ...(more > 0 ? [{ title: `And ${more} more`, body: '', link: '/notifications' }] : [])],
    why: `You get this because some notifications come in a ${word} summary in your notification settings.`,
    unsubscribePath: links?.page ?? null,
    oneClickPath: links?.oneClick ?? null,
    unsubscribeLabel: 'Stop all notification emails',
  });
  db.update(schema.notificationDigests).set({ state: ok ? 'sent' : 'failed', items: items.length }).where(eq(schema.notificationDigests.id, id)).run();
  return ok;
}

/** Every summary that is due now. Returns how many emails went. */
export async function sendSummaries(now = new Date()): Promise<number> {
  const users = await summaryCandidates();
  if (users.length === 0) return 0;
  const canSend = await emailConfigured();
  const settings = await settingsFor(users);
  let sent = 0;
  for (const u of users) {
    for (const kind of ['daily', 'weekly'] as const) {
      try {
        if (await summaryFor(u, kind, settings.get(u)!, now, canSend)) sent++;
      } catch (err) {
        logError('[notifications] a summary failed', err);
      }
    }
  }
  return sent;
}

/** The job, every minute: right-away emails now due (quiet hours over), then summaries. */
export async function notificationsTick(now = new Date()): Promise<{ sent: number; summaries: number }> {
  const sent = await sendDue(now);
  const summaries = await sendSummaries(now);
  return { sent, summaries };
}
