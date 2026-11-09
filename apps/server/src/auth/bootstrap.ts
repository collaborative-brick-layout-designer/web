import { randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { db, schema } from '../db/index.js';
import { env } from '../env.js';
import { normalizeEmail } from '../utils/validate.js';
import { findUserByEmail } from './users.js';

export async function ensureBootstrapAdmin(): Promise<void> {
  const password = env.bootstrapAdminPassword;
  if (!env.bootstrapAdminEmail || !password) return;
  const email = normalizeEmail(env.bootstrapAdminEmail);

  // Only ever creates the account. An account that already has this email
  // is never promoted: anyone could have signed up with it first (with email
  // checks off, or still unverified), and promoting it would hand them the site.
  const existing = await findUserByEmail(email);
  if (existing) {
    if (existing.isDemoAccount) {
      // Anyone can sign in as the demo account: it is never an admin.
      console.warn(`[bootstrap] ${email} is the demo account; pick another BOOTSTRAP_ADMIN_EMAIL`);
    } else if (existing.isGlobalAdmin) {
      console.log(`[bootstrap] ${email} is already a site admin; sign in as it`);
    } else {
      console.warn('====================================================');
      console.warn(`[bootstrap] an account with ${email} already exists, so no admin was created`);
      console.warn('[bootstrap] and that account was NOT made a site admin. If it is yours,');
      console.warn('[bootstrap] promote it from Admin › Users while signed in as a site admin.');
      console.warn('[bootstrap] No site admin yet? Set BOOTSTRAP_ADMIN_EMAIL to an address with');
      console.warn('[bootstrap] no account, restart, sign in as that admin and promote it there.');
      console.warn('====================================================');
    }
    return;
  }

  const passwordHash = await hash(password, {
    memoryCost: 19456,
    timeCost: 2,
    outputLen: 32,
    parallelism: 1,
  });
  await db.insert(schema.users).values({
    id: randomUUID(),
    email,
    // Never the email (names are shown to others); they're asked for a name on first sign-in.
    displayName: '',
    avatarUrl: null,
    passwordHash,
    isDemoAccount: false,
    isGlobalAdmin: true,
    // The bootstrap admin has no inbox to click a verification link
    // from — it's created straight from a trusted env var, so it's
    // exempt from the password-signup email-verification requirement.
    emailVerified: true,
    createdAt: new Date(),
  });
  console.log('====================================================');
  console.log(`[bootstrap] CREATED GLOBAL ADMIN: ${email}`);
  console.log('[bootstrap] change the password from the profile page after first login');
  console.log('====================================================');
}
