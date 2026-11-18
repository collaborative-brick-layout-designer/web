// The inline answers in a notification (POST /api/notifications/:id/act)
// run the existing route for that answer, in-process, so they go through
// exactly the same checks as the club page or the invite page. The inner
// request carries a one-time ticket instead of the caller's cookie or
// token: 32 random bytes, good for one request within a few seconds, held
// only in this process's memory and never sent to any client. attachUser
// (auth/cookie.ts) turns it back into the caller's account.

import { randomBytes } from 'node:crypto';

export const ACT_TICKET_HEADER = 'x-cbld-act-ticket';
const TTL_MS = 10_000;
const tickets = new Map<string, { userId: string; expires: number }>();

export function issueActTicket(userId: string): string {
  const now = Date.now();
  for (const [k, v] of tickets) if (v.expires < now) tickets.delete(k);
  const t = randomBytes(32).toString('base64url');
  tickets.set(t, { userId, expires: now + TTL_MS });
  return t;
}

/** The account a ticket stands for, once; null for an unknown, used or old ticket. */
export function redeemActTicket(ticket: string): string | null {
  const got = tickets.get(ticket);
  if (!got) return null;
  tickets.delete(ticket);
  return got.expires >= Date.now() ? got.userId : null;
}
