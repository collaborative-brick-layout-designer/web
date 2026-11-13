import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { User } from '../db/schema.js';
import type { NormalisedProfile, ProviderId } from './providers.js';
import { normalizeEmail, sameEmail } from '../utils/validate.js';

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
 * Whether `user` has proven they own their email address's mailbox: opened
 * a link sent to it, or signed in with a provider that vouches for that
 * same address (users.emailProvenAt). Accepting an invite or a transfer
 * addressed to an email, and the list of club invites waiting for it, need
 * this. `emailVerified` isn't enough: accounts made while verification was
 * switched off are stored verified without proving anything.
 */
export function hasProvenEmail(user: Pick<User, 'emailProvenAt'>): boolean {
  return user.emailProvenAt != null;
}

/** Note that `userId` just proved they own their address (keeps the first time). */
export async function markEmailProven(userId: string, at: Date = new Date()): Promise<void> {
  await db
    .update(schema.users)
    .set({ emailProvenAt: at })
    .where(and(eq(schema.users.id, userId), isNull(schema.users.emailProvenAt)));
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
    // The provider vouches for the address it sent (each provider's own
    // rule, in routes/auth/oauth.ts). That proves this account's address
    // only when it's the same one: the provider's may have changed since.
    let user = existingLink.user;
    if (!user.emailProvenAt && !user.isDemoAccount && sameEmail(profile.email, user.email)) {
      await markEmailProven(user.id);
      user = { ...user, emailProvenAt: new Date() };
    }
    return { user, linkPrompt: false };
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
    emailProvenAt: new Date(),
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
