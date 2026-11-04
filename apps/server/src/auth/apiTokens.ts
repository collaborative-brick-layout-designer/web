// Personal access tokens (`bld_pat_…`) for non-browser clients — the
// desktop app's live sync, issued through the device-code flow
// (routes/auth/device.ts). Stored like sessions: only a sha256 of the
// secret, so a DB dump can't be replayed. Unlike sessions they are
// scoped and only honoured on an explicit route allow-list (see
// `apiToken` route config and attachUser in cookie.ts).

import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { ApiToken, User } from '../db/schema.js';
import { hashToken } from './session.js';
import { notifyCredentialRevoked } from './revocation.js';
import { signInEnd, signInLimits } from './signInSettings.js';

export const TOKEN_PREFIX = 'bld_pat_';

/**
 * - layouts:read / layouts:write: list, export and live-sync layouts (write edits them); list,
 *   insert, save and republish modules; browse the catalog and its collections (write adds
 *   from them); see and acknowledge your notices (warnings).
 * - layouts:create: publish a new layout (personal or to an org).
 * - parts:read / parts:write: download the parts catalog and custom parts (write uploads them).
 * - venues:read / venues:write: list and download saved venues (write saves, renames and deletes them).
 * - account:prefs: read and change the account's appearance settings (theme, color, text size),
 *   so the desktop app can keep them in step with the web.
 */
export const API_SCOPES = [
  'layouts:read',
  'layouts:write',
  'layouts:create',
  'parts:read',
  'parts:write',
  'venues:read',
  'venues:write',
  'account:prefs',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/*
 * How long a token lasts: Admin › Settings › Sign-in, "In the desktop
 * app" (auth/signInSettings.ts). It ends after the idle window without
 * use (each use pushes it back) and at its longest, counted from
 * createdAt, however much it is used. Both are read at each check, so a
 * changed setting applies to every token the next time it is used.
 */

/**
 * lastUsedAt / expiresAt are rewritten at most this often per token, so
 * a busy client doesn't turn every request into a DB write.
 */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Parse a space-separated scope string (OAuth style). Returns null when
 * it names an unknown scope; an empty/missing string means every scope.
 * The result is de-duplicated and in canonical order.
 */
export function parseScopes(raw: string | undefined | null): ApiScope[] | null {
  const parts = (raw ?? '').split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [...API_SCOPES];
  if (parts.some((p) => !(API_SCOPES as readonly string[]).includes(p))) return null;
  return API_SCOPES.filter((s) => parts.includes(s));
}

export function scopesOf(row: Pick<ApiToken, 'scopes'>): ApiScope[] {
  return parseScopes(row.scopes) ?? [];
}

/** A write scope implies its read scope (`layouts:write` → `layouts:read`, and the same for parts and venues). */
export function hasScope(scopes: readonly ApiScope[], needed: ApiScope): boolean {
  if (scopes.includes(needed)) return true;
  if (needed === 'layouts:read') return scopes.includes('layouts:write');
  if (needed === 'parts:read') return scopes.includes('parts:write');
  if (needed === 'venues:read') return scopes.includes('venues:write');
  return false;
}

/** Mint a token. The plaintext is returned once and never stored. */
export async function createApiToken(
  userId: string,
  name: string,
  scopes: readonly ApiScope[],
): Promise<{ token: string; row: ApiToken }> {
  const secret = randomBytes(32).toString('base64url');
  const token = `${TOKEN_PREFIX}${secret}`;
  const now = new Date();
  const expiresAt = new Date(signInEnd((await signInLimits(now.getTime())).desktop, now.getTime(), now.getTime()).slid);
  const row: ApiToken = {
    id: randomUUID(),
    userId,
    name,
    tokenHash: hashToken(token),
    prefix: token.slice(0, TOKEN_PREFIX.length + 4),
    last4: token.slice(-4),
    scopes: scopes.join(' '),
    createdAt: now,
    lastUsedAt: null,
    expiresAt,
    revokedAt: null,
  };
  await db.insert(schema.apiTokens).values(row);
  return { token, row };
}

/** When a token ends under today's rules: its stored expiry, or its longest if sooner. */
async function endOf(row: Pick<ApiToken, 'createdAt' | 'expiresAt'>, now: number): Promise<number> {
  const { cap } = signInEnd((await signInLimits(now)).desktop, row.createdAt.getTime(), now);
  return Math.min(row.expiresAt.getTime(), cap);
}

async function isLive(row: ApiToken, now: number): Promise<boolean> {
  if (row.revokedAt !== null) return false;
  const end = await endOf(row, now);
  if (end >= now) return true;
  // Past its longest though still in its idle window: write the end down,
  // so the Devices list and the clean-up see it as expired too.
  if (end < row.expiresAt.getTime()) {
    row.expiresAt = new Date(end);
    await db.update(schema.apiTokens).set({ expiresAt: row.expiresAt }).where(eq(schema.apiTokens.id, row.id));
  }
  return false;
}

/**
 * Slide expiry + stamp lastUsedAt, at most once per TOUCH_INTERVAL_MS.
 * Never past the token's longest; a shorter idle window than the token
 * was made with brings its end forward.
 */
async function touch(row: ApiToken, now: number): Promise<void> {
  if (row.lastUsedAt && now - row.lastUsedAt.getTime() < TOUCH_INTERVAL_MS) return;
  const lastUsedAt = new Date(now);
  const expiresAt = new Date(signInEnd((await signInLimits(now)).desktop, row.createdAt.getTime(), now).slid);
  await db
    .update(schema.apiTokens)
    .set({ lastUsedAt, expiresAt })
    .where(eq(schema.apiTokens.id, row.id));
  row.lastUsedAt = lastUsedAt;
  row.expiresAt = expiresAt;
}

/**
 * Resolve a presented `bld_pat_…` secret to its user. Null when unknown,
 * revoked or expired. A successful validation counts as a use.
 */
export async function validateApiToken(
  token: string,
): Promise<{ user: User; token: ApiToken; scopes: ApiScope[] } | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const row = await db
    .select({ token: schema.apiTokens, user: schema.users })
    .from(schema.apiTokens)
    .innerJoin(schema.users, eq(schema.apiTokens.userId, schema.users.id))
    .where(eq(schema.apiTokens.tokenHash, hashToken(token)))
    .get();
  const now = Date.now();
  if (!row || !(await isLive(row.token, now))) return null;
  await touch(row.token, now);
  return { user: row.user, token: row.token, scopes: scopesOf(row.token) };
}

/**
 * True while the token exists, isn't revoked and hasn't expired. Used by
 * the WebSocket's periodic revalidation; an open socket counts as use,
 * so this also slides the expiry of a client that stays connected.
 */
export async function isApiTokenActive(tokenId: string): Promise<boolean> {
  const row = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, tokenId)).get();
  const now = Date.now();
  if (!row || !(await isLive(row, now))) return false;
  await touch(row, now);
  return true;
}

/** The user's live (unrevoked, unexpired) tokens, newest first, each with when it ends. */
export async function listApiTokens(userId: string): Promise<ApiToken[]> {
  const now = Date.now();
  const rows = await db
    .select()
    .from(schema.apiTokens)
    .where(
      and(
        eq(schema.apiTokens.userId, userId),
        isNull(schema.apiTokens.revokedAt),
        gt(schema.apiTokens.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(schema.apiTokens.createdAt));
  const out: ApiToken[] = [];
  for (const row of rows) {
    const end = await endOf(row, now);
    if (end >= now) out.push({ ...row, expiresAt: new Date(end) });
  }
  return out;
}

/**
 * Revoke one of `userId`'s tokens and close the sockets it opened.
 * Returns the revoked row, or null when there is no such live token.
 */
export async function revokeApiToken(userId: string, tokenId: string): Promise<ApiToken | null> {
  const row = await db
    .select()
    .from(schema.apiTokens)
    .where(and(eq(schema.apiTokens.id, tokenId), eq(schema.apiTokens.userId, userId)))
    .get();
  if (!row || row.revokedAt !== null) return null;
  const revokedAt = new Date();
  await db.update(schema.apiTokens).set({ revokedAt }).where(eq(schema.apiTokens.id, tokenId));
  notifyCredentialRevoked({ tokenId });
  return { ...row, revokedAt };
}

/** Revoke every live token of a user. Returns how many were revoked. */
export async function revokeAllApiTokens(userId: string): Promise<number> {
  const res = await db
    .update(schema.apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt)))
    .returning({ id: schema.apiTokens.id });
  for (const { id } of res) notifyCredentialRevoked({ tokenId: id });
  return res.length;
}
