import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { User } from '../db/schema.js';
import type { NormalisedProfile, ProviderId } from './providers.js';
import { getPlatformSettings } from './platformSettings.js';
import { normalizeEmail } from '../utils/validate.js';

/**
 * Look a user up by email, case-insensitively. Rows written before
 * emails were normalised may be mixed-case; if case-variant duplicates
 * exist, the exact (normalised) match wins.
 */
export async function findUserByEmail(email: string): Promise<User | undefined> {
  const wanted = normalizeEmail(email);
  const rows = await db
    .select()
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${wanted}`)
    .limit(5);
  return rows.find((r) => r.email === wanted) ?? rows[0];
}

/**
 * Whether `user` has proven control of their email address, as far as
 * the current platform policy requires. Accepting an invite or transfer
 * addressed to an email must only work for someone who controls it.
 * When an admin has switched verification off, unverified accounts are
 * treated as verified (same as login does).
 */
export async function hasVerifiedEmail(user: Pick<User, 'emailVerified'>): Promise<boolean> {
  if (user.emailVerified) return true;
  const settings = await getPlatformSettings();
  return !settings.requireEmailVerification;
}

/** A single sign-on link whose sub came from an issuer other than the configured one. */
export class IssuerChangedError extends Error {
  constructor() {
    super('single sign-on issuer changed');
  }
}

/**
 * Resolve or create a user from an OAuth profile.
 *
 * Three cases, in order:
 *  1. (provider, providerUserId) is already linked → return that user. For
 *     single sign-on the issuer must match too: a link with none recorded
 *     gets the current one now; a different one throws IssuerChangedError.
 *  2. The provider's email matches an existing user → return that user with
 *     `linkPrompt: true` so the route layer can ask the user to confirm
 *     linking before we attach the provider. This avoids takeover via
 *     email-collision when one provider doesn't verify emails.
 *  3. New user — create one and link this provider.
 */
export async function resolveOauthUser(
  provider: ProviderId,
  profile: NormalisedProfile,
): Promise<{ user: User; linkPrompt: boolean }> {
  const existingLink = await db
    .select({ user: schema.users, issuer: schema.oauthAccounts.issuer })
    .from(schema.oauthAccounts)
    .innerJoin(schema.users, eq(schema.users.id, schema.oauthAccounts.userId))
    .where(
      and(
        eq(schema.oauthAccounts.provider, provider),
        eq(schema.oauthAccounts.providerUserId, profile.providerUserId),
      ),
    )
    .get();
  if (existingLink) {
    if (profile.issuer) {
      if (existingLink.issuer === null) {
        // A link made before the issuer was kept: trust it once, by sub, and
        // record who issued it. One row, written as it is used.
        await db
          .update(schema.oauthAccounts)
          .set({ issuer: profile.issuer })
          .where(
            and(
              eq(schema.oauthAccounts.provider, provider),
              eq(schema.oauthAccounts.providerUserId, profile.providerUserId),
              isNull(schema.oauthAccounts.issuer),
            ),
          );
      } else if (existingLink.issuer !== profile.issuer) {
        // The sub was handed out by another issuer: it may be someone else now.
        throw new IssuerChangedError();
      }
    }
    return { user: existingLink.user, linkPrompt: false };
  }

  const emailMatch = await findUserByEmail(profile.email);
  if (emailMatch) return { user: emailMatch, linkPrompt: true };

  const id = randomUUID();
  const created: User = {
    id,
    email: normalizeEmail(profile.email),
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    passwordHash: null,
    isDemoAccount: false,
    demoExpiresAt: null,
    isGlobalAdmin: false,
    isModerator: false,
    // OAuth/OIDC providers have already proven control of this email.
    emailVerified: true,
    createdAt: new Date(),
    lastSeenAt: null,
    deletionRequestedAt: null,
    deletionDueAt: null,
    restrictedAt: null,
  };
  await db.insert(schema.users).values(created);
  await db.insert(schema.oauthAccounts).values({
    provider,
    providerUserId: profile.providerUserId,
    userId: id,
    issuer: profile.issuer ?? null,
  });
  return { user: created, linkPrompt: false };
}

export async function linkProvider(
  userId: string,
  provider: ProviderId,
  providerUserId: string,
  issuer?: string,
): Promise<void> {
  await db
    .insert(schema.oauthAccounts)
    .values({ provider, providerUserId, userId, issuer: issuer ?? null })
    .onConflictDoNothing();
}

export async function listLinkedProviders(userId: string): Promise<ProviderId[]> {
  const rows = await db
    .select({ provider: schema.oauthAccounts.provider })
    .from(schema.oauthAccounts)
    .where(eq(schema.oauthAccounts.userId, userId));
  return rows.map((r) => r.provider as ProviderId);
}
