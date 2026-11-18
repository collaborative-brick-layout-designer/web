// "Stop these emails": a token in every notification email that turns its
// email off with no sign-in (RFC 8058 one-click, or the page it opens). It
// names the account and what it stops (one type, or all notification
// email), signed with a key derived from this server's secret key
// (secrets/secretBox.ts). It doesn't expire: an old email's link keeps
// working, and it can only turn email off.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { secretKey } from '../secrets/secretBox.js';
import { isNotificationType, type NotificationType } from './types.js';

export type UnsubscribeScope = NotificationType | 'all';

function key(): Buffer | null {
  const k = secretKey();
  return k ? createHmac('sha256', k).update('cbld notification unsubscribe v1').digest() : null;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function unsubscribeToken(userId: string, scope: UnsubscribeScope): string | null {
  const k = key();
  if (!k) return null;
  const body = b64(JSON.stringify({ u: userId, s: scope }));
  return `${body}.${b64(createHmac('sha256', k).update(body).digest())}`;
}

export function readUnsubscribeToken(token: unknown): { userId: string; scope: UnsubscribeScope } | null {
  if (typeof token !== 'string' || token.length > 600) return null;
  const k = key();
  const [body, sig] = token.split('.');
  if (!k || !body || !sig) return null;
  const want = createHmac('sha256', k).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { u?: unknown; s?: unknown };
    if (typeof v.u !== 'string' || (v.s !== 'all' && !isNotificationType(v.s))) return null;
    return { userId: v.u, scope: v.s as UnsubscribeScope };
  } catch {
    return null;
  }
}

/** The page that asks "Stop these emails?", and the one-click API address mail apps POST to. */
export function unsubscribePaths(userId: string, scope: UnsubscribeScope): { page: string; oneClick: string } | null {
  const t = unsubscribeToken(userId, scope);
  if (!t) return null;
  const q = `t=${encodeURIComponent(t)}`;
  return { page: `/unsubscribe?${q}`, oneClick: `/api/notifications/unsubscribe?${q}` };
}
