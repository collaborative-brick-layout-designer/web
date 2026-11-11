import { randomBytes, createHash } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { User } from '../db/schema.js';
import { notifyCredentialRevoked } from './revocation.js';
import { DEMO_SIGN_IN_MAX_MS, signInEnd, signInLimits } from './signInSettings.js';

// How long a browser sign-in lasts (Admin › Settings › Sign-in): it ends
// after the idle window without use (each use in the second half of the
// window pushes it back), and at its longest, counted from createdAt,
// however much it is used. Both are read at every check, so a changed
// setting applies to every session the next time it is used.
//
// The demo account's sessions are different: they end at the next demo
// reset (each reset also signs every demo visitor out) and after 24 hours
// at most, and are never pushed back.

export const SESSION_COOKIE = 'cld_session';

function generateToken(): string {
  // 20 random bytes → base32-ish; we just hex-encode for simplicity.
  return randomBytes(24).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The sessions-table id for a raw session cookie value. */
export function sessionIdForToken(token: string): string {
  return hashToken(token);
}

type SessionRow = { createdAt: Date; expiresAt: Date };

/** When this session ends now, before any push back: its stored expiry, or sooner under today's rules. */
async function endOf(row: SessionRow, isDemo: boolean, now: number): Promise<{ end: number; slid: number; idleMs: number }> {
  const created = row.createdAt.getTime();
  const stored = row.expiresAt.getTime();
  if (isDemo) {
    const end = Math.min(stored, created + DEMO_SIGN_IN_MAX_MS);
    return { end, slid: end, idleMs: 0 };
  }
  const rule = (await signInLimits(now)).web;
  const { slid, cap } = signInEnd(rule, created, now);
  return { end: Math.min(stored, cap), slid, idleMs: rule.idleMs };
}

/** True while the session behind `sessionId` exists and hasn't ended. */
export async function isSessionActive(sessionId: string): Promise<boolean> {
  const row = await db
    .select({ createdAt: schema.sessions.createdAt, expiresAt: schema.sessions.expiresAt, isDemo: schema.users.isDemoAccount })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(eq(schema.sessions.id, sessionId))
    .get();
  if (!row) return false;
  const now = Date.now();
  return (await endOf(row, row.isDemo, now)).end >= now;
}

/** When a new session ends: the idle window, or for a demo space its own time. */
async function firstExpiry(userId: string, now: number): Promise<Date> {
  // A demo space (or the template): its sign-in ends with its time.
  const user = await db.select({ demo: schema.users.isDemoAccount, until: schema.users.demoExpiresAt }).from(schema.users).where(eq(schema.users.id, userId)).get();
  if (user?.demo) {
    const { demoSessionEnd } = await import('../demo/demoAccount.js');
    const end = await demoSessionEnd(now);
    return new Date(user.until ? Math.min(end, user.until.getTime()) : end);
  }
  return new Date(signInEnd((await signInLimits(now)).web, now, now).slid);
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const id = hashToken(token);
  const now = Date.now();
  const expiresAt = await firstExpiry(userId, now);
  await db.insert(schema.sessions).values({ id, userId, expiresAt, createdAt: new Date(now) });
  // Signing in keeps an account that was waiting to be deleted.
  const { cancelDeletionOnSignIn } = await import('../privacy/accountDeletion.js');
  await cancelDeletionOnSignIn(userId);
  return { token, expiresAt };
}

/** How often a session's "last used" time is written (not on every request). */
const LAST_USED_EVERY_MS = 5 * 60 * 1000;

/**
 * A rough, friendly name for a browser from its user agent: "Firefox on
 * Linux", "Safari on iPhone". Only this is kept, never the user agent.
 */
export function deviceName(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'Mac'
            : /CrOS/.test(ua)
              ? 'ChromeOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? 'A browser';
}

/** The id the owner sees for one of their sessions: not the stored id (a hash of the cookie), but a hash of that. */
export function publicSessionId(sessionId: string): string {
  return createHash('sha256').update(`listed:${sessionId}`).digest('hex').slice(0, 24);
}

export async function validateSession(
  token: string,
  userAgent?: string,
): Promise<{ user: User; session: { id: string; expiresAt: Date }; refreshed: boolean } | null> {
  const id = hashToken(token);
  const row = await db
    .select({ session: schema.sessions, user: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(eq(schema.sessions.id, id))
    .get();
  if (!row) return null;

  const now = Date.now();
  const { end, slid, idleMs } = await endOf(row.session, row.user.isDemoAccount, now);
  if (end < now) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
    return null;
  }

  // Sliding expiry: push it back when within the second half of the idle
  // window, never past the longest. A shorter window or longest than the
  // session was made with brings its end forward now.
  let refreshed = false;
  const stored = row.session.expiresAt.getTime();
  const pushBack = slid > stored && stored - now < idleMs / 2;
  const bringForward = slid < stored;
  if (!row.user.isDemoAccount && (pushBack || bringForward)) {
    const expiresAt = new Date(slid);
    await db.update(schema.sessions).set({ expiresAt }).where(eq(schema.sessions.id, id));
    row.session.expiresAt = expiresAt;
    refreshed = true;
  }
  // For Profile › Browsers and devices: when it was last used, and roughly what it is.
  const last = row.session.lastUsedAt?.getTime() ?? 0;
  if (now - last >= LAST_USED_EVERY_MS) {
    // A demo space keeps no device name (docs/PRIVACY-DATA.md, The demo).
    const device = row.user.isDemoAccount ? null : (row.session.device ?? deviceName(userAgent));
    await db.update(schema.sessions).set({ lastUsedAt: new Date(now), device }).where(eq(schema.sessions.id, id));
  }

  return { user: row.user, session: { id, expiresAt: row.session.expiresAt }, refreshed };
}

export async function invalidateSession(token: string): Promise<void> {
  const sessionId = hashToken(token);
  await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
  notifyCredentialRevoked({ sessionId });
}

/** Sign `userId` out of every browser. `reason`, when given, is what their open layouts are told (the WebSocket close reason). */
export async function invalidateAllSessions(userId: string, reason?: 'demo_reset' | 'demo_off'): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
  notifyCredentialRevoked(reason ? { userId, reason } : { userId });
}

/**
 * Sign `userId` out of every browser except the one holding
 * `keepSessionId` (e.g. after they change their password there). Returns
 * how many were signed out; their open layouts are closed at once.
 */
export async function invalidateOtherSessions(userId: string, keepSessionId: string | null): Promise<number> {
  const where = keepSessionId ? and(eq(schema.sessions.userId, userId), ne(schema.sessions.id, keepSessionId)) : eq(schema.sessions.userId, userId);
  const gone = await db.delete(schema.sessions).where(where).returning({ id: schema.sessions.id });
  for (const { id } of gone) notifyCredentialRevoked({ sessionId: id });
  return gone.length;
}
