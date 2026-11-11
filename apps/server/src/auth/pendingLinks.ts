// Pending OAuth account links.
//
// When an OAuth sign-in's email matches an existing account, we don't
// attach the provider automatically (a provider that doesn't verify
// emails would otherwise hand over the account). Instead the callback
// records a pending link and sends the browser to /link; the link is only
// committed by POST /api/auth/link from a session that is ALREADY signed
// in to that account, proving the person controls both.
//
// The pending link lives server-side, keyed by a random token that goes
// in the `cld_pending_link` cookie. (It used to be the link itself as
// plain JSON in an unsigned cookie — forgeable, so no endpoint could
// have safely trusted it.) In-memory is enough: the server is a single
// process, and a lost entry only means signing in with the provider again.

import { randomBytes } from 'node:crypto';
import type { ProviderId } from './providers.js';

export const PENDING_LINK_COOKIE = 'cld_pending_link';
export const PENDING_LINK_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 10_000;

export interface PendingLink {
  provider: ProviderId;
  providerUserId: string;
  issuer?: string;
  userId: string;
  expiresAt: number;
}

const pending = new Map<string, PendingLink>();

function sweep(now: number): void {
  for (const [token, link] of pending) {
    if (link.expiresAt < now) pending.delete(token);
  }
}

export function createPendingLink(link: Omit<PendingLink, 'expiresAt'>): string {
  const now = Date.now();
  sweep(now);
  while (pending.size >= MAX_PENDING) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
  const token = randomBytes(24).toString('hex');
  pending.set(token, { ...link, expiresAt: now + PENDING_LINK_TTL_MS });
  return token;
}

/** Look up a live pending link without consuming it. */
export function peekPendingLink(token: string | undefined): PendingLink | null {
  if (!token) return null;
  const link = pending.get(token);
  if (!link) return null;
  if (link.expiresAt < Date.now()) {
    pending.delete(token);
    return null;
  }
  return link;
}

export function consumePendingLink(token: string): void {
  pending.delete(token);
}
