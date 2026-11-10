// The demo. An admin switches it on in Admin › Settings › Demo account;
// then the sign-in page offers "Try the demo". Each visitor gets a private
// demo space of their own: a throwaway account (isDemoAccount, a `.invalid`
// address, a name like "Demo builder 7f3a") with a copy of the samples. The
// samples themselves live in the template account `demo-account`, at fixed
// ids, so a link to them always opens (read only for visitors). A space is
// deleted with everything in it when its sign-in ends: at the next reset,
// or 24 hours at most (demo/reset.ts sweeps them).
//
// It can't reach anyone else: no invites, public links, clubs, custom
// part uploads, catalog submissions, transfers, profile changes or
// desktop tokens. Every such route asks `isDemoUser`.
//
// A demo sign-in ends at the next reset, and after 24 hours at most; it
// is never pushed back (auth/session.ts). Each reset signs every visitor
// out, and the web says "The demo was reset. Start again?".

import { randomBytes } from 'node:crypto';
import { and, count, eq, ne, or, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { PlatformSettings, User } from '../db/schema.js';
import { invalidateAllSessions } from '../auth/session.js';
import { revokeAllApiTokens } from '../auth/apiTokens.js';
import { DEMO_SIGN_IN_MAX_MS } from '../auth/signInSettings.js';
import { getPlatformSettings } from '../auth/platformSettings.js';

/** Fixed id, so the account is found (and re-enabled) the same way every time. */
export const DEMO_USER_ID = 'demo-account';
export const DEMO_DISPLAY_NAME = 'Demo builder';
/** A `.invalid` address can never receive mail or be signed up for. */
export const DEMO_EMAIL = 'demo-builder@demo.invalid';

export type DemoResetEvery = PlatformSettings['demoResetEvery'];
export const DEMO_RESET_CHOICES: readonly DemoResetEvery[] = ['1h', '6h', 'daily'];

const HOUR_MS = 60 * 60 * 1000;
export const DEMO_RESET_MS: Record<DemoResetEvery, number> = {
  '1h': HOUR_MS,
  '6h': 6 * HOUR_MS,
  daily: 24 * HOUR_MS,
};

/** Is this the demo account? The one check every restricted route makes. */
export function isDemoUser(user: Pick<User, 'isDemoAccount'> | null | undefined): boolean {
  return user?.isDemoAccount === true;
}

/** When the next reset is due, or null while the demo is off. */
export function nextDemoReset(s: Pick<PlatformSettings, 'demoEnabled' | 'demoResetEvery' | 'demoLastResetAt'>): Date | null {
  if (!s.demoEnabled) return null;
  if (!s.demoLastResetAt) return new Date(0);
  return new Date(s.demoLastResetAt.getTime() + DEMO_RESET_MS[s.demoResetEvery]);
}

/** Whether the timer should reset the demo now. */
export function demoResetDue(
  s: Pick<PlatformSettings, 'demoEnabled' | 'demoResetEvery' | 'demoLastResetAt'>,
  now: Date,
): boolean {
  const next = nextDemoReset(s);
  return next !== null && next.getTime() <= now.getTime();
}

/** What the sign-in page, the banner and the admin page show. */
export function demoStatus(s: PlatformSettings): {
  enabled: boolean;
  resetEvery: DemoResetEvery;
  lastResetAt: number | null;
  nextResetAt: number | null;
} {
  return {
    enabled: s.demoEnabled,
    resetEvery: s.demoResetEvery,
    lastResetAt: s.demoLastResetAt?.getTime() ?? null,
    // nextDemoReset is null while the demo is off.
    nextResetAt: nextDemoReset(s)?.getTime() ?? null,
  };
}

/**
 * Make the demo account, or put it back the way it should be (an admin
 * may have renamed it or made it an admin). No password: the only way in
 * is POST /api/auth/demo while the demo is on.
 */
export async function ensureDemoUser(): Promise<User> {
  const fields = {
    displayName: DEMO_DISPLAY_NAME,
    avatarUrl: null,
    passwordHash: null,
    isDemoAccount: true,
    isGlobalAdmin: false,
    isModerator: false,
    emailVerified: true,
  };
  const existing = await db.select().from(schema.users).where(eq(schema.users.id, DEMO_USER_ID)).get();
  if (existing) {
    await db.update(schema.users).set(fields).where(eq(schema.users.id, DEMO_USER_ID));
    // Nobody may sign in to it any other way.
    await db.delete(schema.oauthAccounts).where(eq(schema.oauthAccounts.userId, DEMO_USER_ID));
    return { ...existing, ...fields };
  }
  const row: User = { id: DEMO_USER_ID, email: DEMO_EMAIL, createdAt: new Date(), lastSeenAt: null, deletionRequestedAt: null, deletionDueAt: null, restrictedAt: null, demoExpiresAt: null, ...fields };
  const taken = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, DEMO_EMAIL)).get();
  // Somebody already has the address (it can't be signed up for, but an
  // admin could have typed it): give the demo account its own.
  if (taken) row.email = `demo-builder-${Date.now().toString(36)}@demo.invalid`;
  await db.insert(schema.users).values(row);
  return row;
}

/**
 * When a demo sign-in made `now` ends: at the next reset, and 24 hours
 * from now at most (also when the reset is already due: the caller resets
 * first, see routes/auth/demo.ts).
 */
export async function demoSessionEnd(now: number): Promise<number> {
  const latest = now + DEMO_SIGN_IN_MAX_MS;
  const next = nextDemoReset(await getPlatformSettings())?.getTime() ?? latest;
  return next > now ? Math.min(next, latest) : latest;
}

/**
 * Sign every demo visitor out, everywhere: browser sessions and any
 * tokens. Their open layouts close with `reason` ('demo_reset' at a
 * reset), which the web turns into "The demo was reset. Start again?".
 */
export async function signOutDemo(reason: 'demo_reset' | 'demo_off' = 'demo_off'): Promise<void> {
  for (const { id } of await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.isDemoAccount, true)).all()) {
    await invalidateAllSessions(id, reason);
    await revokeAllApiTokens(id);
  }
}

/** Is this a visitor's own demo space (not the template that holds the samples)? */
export function isDemoSpace(user: Pick<User, 'id' | 'isDemoAccount'> | null | undefined): boolean {
  return user?.isDemoAccount === true && user.id !== DEMO_USER_ID;
}

/** Users that aren't a visitor's demo space (the admin's people list and counts leave those out). */
export function notDemoSpace(): SQL {
  return or(eq(schema.users.isDemoAccount, false), eq(schema.users.id, DEMO_USER_ID)) as SQL;
}

/** How many visitors' demo spaces there are now. */
export async function liveDemoSpaces(): Promise<number> {
  const row = await db
    .select({ n: count() })
    .from(schema.users)
    .where(and(eq(schema.users.isDemoAccount, true), ne(schema.users.id, DEMO_USER_ID)))
    .get();
  return row?.n ?? 0;
}

/**
 * A new visitor's demo space: its own account, ending with its sign-in
 * (`expiresAt`). No password and a `.invalid` address: the only way in is
 * the sign-in "Try the demo" hands it.
 */
export async function createDemoSpace(expiresAt: Date, now = new Date()): Promise<User> {
  const tag = randomBytes(6).toString('hex');
  const row: User = {
    id: `demo-${tag}`,
    email: `demo-${tag}@demo.invalid`,
    displayName: `${DEMO_DISPLAY_NAME} ${tag.slice(0, 4)}`,
    avatarUrl: null,
    passwordHash: null,
    isDemoAccount: true,
    demoExpiresAt: expiresAt,
    isGlobalAdmin: false,
    isModerator: false,
    emailVerified: true,
    createdAt: now,
    lastSeenAt: null,
    deletionRequestedAt: null,
    deletionDueAt: null,
    restrictedAt: null,
  };
  await db.insert(schema.users).values(row);
  return row;
}
