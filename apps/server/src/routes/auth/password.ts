import { randomUUID, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, gt, or } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { User } from '../../db/schema.js';
import { createSession, hashToken, invalidateAllSessions, invalidateOtherSessions, SESSION_COOKIE, sessionIdForToken } from '../../auth/session.js';
import { requireUser, setSessionCookie } from '../../auth/cookie.js';
import { revokeAllApiTokens } from '../../auth/apiTokens.js';
import { loginWaitMs, noteLoginFailure, noteLoginSuccess } from '../../auth/loginPacing.js';
import { sendVerificationEmail } from '../../email/sendVerification.js';
import { sendSignupNoticeEmail } from '../../email/sendSignupNotice.js';
import { getPlatformSettings } from '../../auth/platformSettings.js';
import { findUserByEmail, listLinkedProviders } from '../../auth/users.js';
import { env } from '../../env.js';
import { normalizeEmail, safeNextPath } from '../../utils/validate.js';
import { needsName } from '../../utils/publicName.js';

const ARGON_OPTS = { memoryCost: 19456, timeCost: 2, outputLen: 32, parallelism: 1 };
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

/**
 * The browser that signs up gets this cookie. A verification link keeps
 * the password chosen at sign-up only when it is opened in that same
 * browser (the cookie matches the link's row). Opened anywhere else, the
 * person who opened it chooses the password instead. Scoped to the
 * password routes and lives as long as the link.
 */
export const SIGNUP_COOKIE = 'cld_signup';
const SIGNUP_COOKIE_PATH = '/api/auth/password';
/**
 * Verification rows bound to a sign-up browser have this id prefix plus
 * the sha256 of that browser's cookie (no extra column needed). Other
 * rows have a plain uuid id.
 */
const BOUND_ID_PREFIX = 'signup:';
/** Rows from before tokens were hashed hold the raw 24-byte hex token (48 chars); hashes are 64. */
const LEGACY_TOKEN_LENGTH = 48;

/**
 * At most one "someone tried to sign up with your email" note per
 * account in this window, so the sign-up form can't flood an inbox. In
 * memory (one server process), bounded.
 */
const SIGNUP_NOTICE_EVERY_MS = 60 * 60 * 1000;
const SIGNUP_NOTICE_MAX_TRACKED = 10_000;
const lastSignupNotice = new Map<string, number>();

/** A "Forgot password?" link works for an hour, once. */
export const RESET_TTL_MS = 60 * 60 * 1000;
/**
 * At most one reset email per account in this window, so the form can't
 * flood an inbox (the route is also limited per address). In memory, bounded.
 */
const RESET_EVERY_MS = 2 * 60 * 1000;
const lastResetEmail = new Map<string, number>();

/** Forget the reset-email throttle (tests). */
export function resetPasswordResetThrottleForTests(): void {
  lastResetEmail.clear();
}

/** The emailed "choose a new password" link. */
export function resetUrl(token: string): string {
  return `${env.publicUrl}/reset-password/${token}`;
}

/** Argon2 hash of a random password: login for an unknown email checks against it, so it takes as long as a wrong password. */
let dummyHash: Promise<string> | null = null;
function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hash(randomBytes(16).toString('hex'), ARGON_OPTS);
  return dummyHash;
}

/**
 * The emailed link. `next` (a path on this site) is where the person was
 * going when they signed up, e.g. a club invite: verifying takes them on
 * there instead of to Home.
 */
export function verificationUrl(token: string, next: string | null): string {
  const base = `${env.publicUrl}/verify-email/${token}`;
  return next && next !== '/' ? `${base}?next=${encodeURIComponent(next)}` : base;
}

function boundRowId(signupSecret: string): string {
  return `${BOUND_ID_PREFIX}${hashToken(signupSecret)}`;
}

function setSignupCookie(reply: FastifyReply, secret: string): void {
  reply.setCookie(SIGNUP_COOKIE, secret, {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: 'lax',
    path: SIGNUP_COOKIE_PATH,
    maxAge: VERIFICATION_TTL_MS / 1000,
  });
}

function clearSignupCookie(reply: FastifyReply): void {
  reply.clearCookie(SIGNUP_COOKIE, { path: SIGNUP_COOKIE_PATH });
}

/** The user's current verification row id when this request comes from the browser it is bound to, else null. */
async function boundIdForRequest(req: FastifyRequest, userId: string): Promise<string | null> {
  const secret = req.cookies[SIGNUP_COOKIE];
  if (!secret) return null;
  const wanted = boundRowId(secret);
  const row = await db
    .select({ userId: schema.emailVerifications.userId })
    .from(schema.emailVerifications)
    .where(eq(schema.emailVerifications.id, wanted))
    .get();
  return row && row.userId === userId ? wanted : null;
}

/**
 * Delete any existing verification token for a user and issue a fresh
 * one, emailing the link if SMTP is configured. The token is stored
 * hashed (sha256, like sessions); only the email carries it. `rowId` is
 * the bound id from sign-up (see BOUND_ID_PREFIX), or null for a link
 * that doesn't keep the sign-up password. When SMTP isn't configured the
 * link is logged instead: a brand-new account has nowhere else to show
 * it.
 */
async function issueVerification(
  log: FastifyBaseLogger,
  user: Pick<User, 'id' | 'email'>,
  next: string | null,
  rowId: string | null,
  purpose: 'verify' | 'set-password' = 'verify',
): Promise<void> {
  await db.delete(schema.emailVerifications).where(eq(schema.emailVerifications.userId, user.id));
  const token = randomBytes(24).toString('hex');
  await db.insert(schema.emailVerifications).values({
    id: rowId ?? randomUUID(),
    userId: user.id,
    token: hashToken(token),
    expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
    createdAt: new Date(),
  });
  const verifyUrl = verificationUrl(token, next);
  let delivered = false;
  try {
    delivered = await sendVerificationEmail({ to: user.email, verifyUrl, purpose });
  } catch (err) {
    log.warn({ err }, 'failed to send verification email');
  }
  if (!delivered) {
    // No SMTP configured (or delivery failed): the link is otherwise
    // unrecoverable, so surface it in the server log for local/dev use
    // and for an operator to hand-deliver if needed.
    log.info({ email: user.email, verifyUrl }, 'email verification link (SMTP not configured or delivery failed)');
  }
}

/**
 * Email a one-time "choose a new password" link (an hour, single use;
 * only its hash is stored, and any older link for the account stops
 * working). Without SMTP the link is logged, as verification links are.
 */
async function issuePasswordReset(log: FastifyBaseLogger, user: Pick<User, 'id' | 'email'>): Promise<void> {
  await db.delete(schema.passwordResets).where(eq(schema.passwordResets.userId, user.id));
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  await db.insert(schema.passwordResets).values({ id: randomUUID(), userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(now + RESET_TTL_MS), createdAt: new Date(now) });
  const url = resetUrl(token);
  let delivered = false;
  try {
    delivered = await sendVerificationEmail({ to: user.email, verifyUrl: url, purpose: 'reset-password' });
  } catch (err) {
    log.warn({ err }, 'failed to send password reset email');
  }
  if (!delivered) log.info({ email: user.email, resetUrl: url }, 'password reset link (SMTP not configured or delivery failed)');
}

/** True (and noted) when this account may get another reset email now. */
function mayEmailReset(userId: string, now: number = Date.now()): boolean {
  const last = lastResetEmail.get(userId);
  if (last !== undefined && now - last < RESET_EVERY_MS) return false;
  lastResetEmail.delete(userId);
  if (lastResetEmail.size >= SIGNUP_NOTICE_MAX_TRACKED) {
    const oldest = lastResetEmail.keys().next().value;
    if (oldest !== undefined) lastResetEmail.delete(oldest);
  }
  lastResetEmail.set(userId, now);
  return true;
}

/** The reset row behind a raw link token, while it still works. */
async function liveReset(raw: unknown): Promise<{ row: typeof schema.passwordResets.$inferSelect | null; expired: boolean }> {
  if (typeof raw !== 'string' || !/^[0-9a-f]{64}$/.test(raw)) return { row: null, expired: false };
  const row = (await db.select().from(schema.passwordResets).where(eq(schema.passwordResets.tokenHash, hashToken(raw))).get()) ?? null;
  if (!row) return { row: null, expired: false };
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(schema.passwordResets).where(eq(schema.passwordResets.id, row.id));
    return { row: null, expired: true };
  }
  return { row, expired: false };
}

/** A verified account with no password and no other sign-in: the only way back in is a link to its own mailbox. */
async function hasNoWayToSignIn(user: User): Promise<boolean> {
  if (user.passwordHash || user.isDemoAccount || !user.emailVerified) return false;
  return (await listLinkedProviders(user.id)).length === 0;
}

async function sendSignupNotice(log: FastifyBaseLogger, user: Pick<User, 'id' | 'email'>): Promise<void> {
  const now = Date.now();
  const last = lastSignupNotice.get(user.id);
  if (last !== undefined && now - last < SIGNUP_NOTICE_EVERY_MS) return;
  lastSignupNotice.delete(user.id);
  if (lastSignupNotice.size >= SIGNUP_NOTICE_MAX_TRACKED) {
    const oldest = lastSignupNotice.keys().next().value;
    if (oldest !== undefined) lastSignupNotice.delete(oldest);
  }
  lastSignupNotice.set(user.id, now);
  try {
    await sendSignupNoticeEmail({ to: user.email });
  } catch (err) {
    log.warn({ err }, 'failed to send sign-up notice email');
  }
}

/** Forget the sign-up notice throttle (tests). */
export function resetSignupNoticesForTests(): void {
  lastSignupNotice.clear();
}

/**
 * Sign-up with an address that already has an account. The answer is
 * the same as for a new address ("check your email"); what happens
 * depends on the account:
 *  - never verified: a fresh verification link. It keeps the sign-up
 *    password only when asked again from the browser that signed up,
 *    with the same password; otherwise whoever opens it chooses one.
 *  - no password and no other way to sign in: a link to choose one.
 *  - anything else: a short note to the owner, and nothing changes.
 */
async function registerExisting(
  req: FastifyRequest,
  existing: User,
  password: string,
  next: string | null,
  requireVerification: boolean,
): Promise<void> {
  if (requireVerification && !existing.emailVerified && existing.passwordHash) {
    const bound = await boundIdForRequest(req, existing.id);
    const samePassword = bound ? await verify(existing.passwordHash, password, ARGON_OPTS) : false;
    await issueVerification(req.log, existing, next, bound && samePassword ? bound : null);
    return;
  }
  // The same argon2 work as a new sign-up, so the answer takes as long.
  await hash(password, ARGON_OPTS);
  if (await hasNoWayToSignIn(existing)) {
    await issueVerification(req.log, existing, next, null, 'set-password');
    return;
  }
  await sendSignupNotice(req.log, existing);
}

export async function passwordRoutes(app: FastifyInstance) {
  if (!env.enablePasswordAuth) return;

  app.post<{ Body: { email: string; password: string; displayName?: string; next?: string } }>(
    '/api/auth/password/register',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const body: Partial<NonNullable<typeof req.body>> = req.body ?? {};
      const { password, displayName } = body;
      const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
      if (!email || typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
        return reply.code(400).send({ error: 'invalid_input' });
      }
      const settings = await getPlatformSettings();
      const next = safeNextPath(body.next);
      // Case-insensitive: `Alice@x.com` must not register alongside
      // `alice@x.com` (that would let a second account claim invites
      // addressed to the first). The answer never says whether the
      // address already had an account; the email does.
      const existing = await findUserByEmail(email);
      if (existing) {
        await registerExisting(req, existing, password, next, settings.requireEmailVerification);
        return reply.send({ ok: true, verificationRequired: true });
      }

      const passwordHash = await hash(password, ARGON_OPTS);
      const id = randomUUID();
      try {
        await db.insert(schema.users).values({
          id,
          email,
          // Never the email address: names are shown to other people. The
          // sign-up form asks for one; without it (older clients) the person
          // is asked after they sign in.
          displayName: typeof displayName === 'string' && !needsName(displayName) ? displayName.trim().slice(0, 60) : '',
          avatarUrl: null,
          passwordHash,
          isGlobalAdmin: false,
          emailVerified: !settings.requireEmailVerification,
          createdAt: new Date(),
        });
      } catch {
        // Two sign-ups for the same address at once: the other one made it.
        return reply.send({ ok: true, verificationRequired: true });
      }

      if (!settings.requireEmailVerification) {
        // Verification is off — behave exactly like pre-verification
        // register did: create the account already verified and log
        // straight in.
        const { token, expiresAt } = await createSession(id);
        setSessionCookie(reply, token, expiresAt);
        return reply.send({ ok: true, verificationRequired: false });
      }

      // The link keeps this password when it's opened in this browser.
      const signupSecret = randomBytes(24).toString('hex');
      setSignupCookie(reply, signupSecret);
      await issueVerification(req.log, { id, email }, next, boundRowId(signupSecret));
      // No session cookie yet — the account can't log in until verified.
      return reply.send({ ok: true, verificationRequired: true });
    },
  );

  app.post<{ Body: { email: string; next?: string } }>(
    '/api/auth/password/resend-verification',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const body: Partial<NonNullable<typeof req.body>> = req.body ?? {};
      const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
      if (!email) return reply.code(400).send({ error: 'invalid_input' });
      const settings = await getPlatformSettings();
      const user = await findUserByEmail(email);
      // Always return ok regardless of whether the account exists or is
      // already verified — don't let this endpoint be used to enumerate
      // registered emails.
      const next = safeNextPath(body.next);
      if (settings.requireEmailVerification && user && user.passwordHash && !user.emailVerified) {
        // Asked from the browser that signed up: the new link still keeps its password.
        await issueVerification(req.log, user, next, await boundIdForRequest(req, user.id));
      } else if (user && (await hasNoWayToSignIn(user))) {
        await issueVerification(req.log, user, next, null, 'set-password');
      }
      return reply.send({ ok: true });
    },
  );

  app.post<{ Params: { token: string } }>(
    '/api/auth/password/verify-email/:token',
    async (req, reply) => {
      const raw = req.params.token;
      // Rows are found by the token's hash. Links issued before tokens
      // were hashed (raw 48-hex values) keep working until they expire.
      const verification = await db
        .select()
        .from(schema.emailVerifications)
        .where(
          raw.length === LEGACY_TOKEN_LENGTH
            ? or(eq(schema.emailVerifications.token, hashToken(raw)), eq(schema.emailVerifications.token, raw))
            : eq(schema.emailVerifications.token, hashToken(raw)),
        )
        .get();
      if (!verification) return reply.code(404).send({ error: 'verification_not_found' });
      if (verification.expiresAt.getTime() < Date.now()) {
        return reply.code(410).send({ error: 'verification_expired' });
      }
      const user = await db.select().from(schema.users).where(eq(schema.users.id, verification.userId)).get();
      if (!user) return reply.code(404).send({ error: 'verification_not_found' });

      let passwordHash = user.passwordHash;
      if (!user.emailVerified) {
        // First verification: whoever opened the link controls the
        // mailbox, so the account is theirs from here on. The password
        // chosen at sign-up stays only when the link was opened in the
        // browser that signed up (and no other link was asked for since);
        // otherwise they choose a new one. Sessions and tokens from before
        // verification end either way.
        const secret = req.cookies[SIGNUP_COOKIE];
        const keepsPassword =
          !!secret && verification.id.startsWith(BOUND_ID_PREFIX) && verification.id === boundRowId(secret);
        if (!keepsPassword) passwordHash = null;
        await invalidateAllSessions(user.id);
        await revokeAllApiTokens(user.id);
        await db.update(schema.users).set({ emailVerified: true, passwordHash }).where(eq(schema.users.id, user.id));
      }
      await db.delete(schema.emailVerifications).where(eq(schema.emailVerifications.userId, user.id));
      clearSignupCookie(reply);

      // Verifying logs the user in directly — they already proved
      // control of the mailbox, which is a stronger check than a
      // password alone.
      const { token, expiresAt } = await createSession(user.id);
      setSessionCookie(reply, token, expiresAt);
      // No password: the page asks them to choose one next.
      return reply.send({ ok: true, needsPassword: !passwordHash });
    },
  );

  /**
   * Choose a password for an account that has none: after a verification
   * that didn't keep one, or an account that has only used GitHub/Google.
   * Browser session only (API tokens are refused); an account that
   * already has a password can't replace it here.
   */
  app.post<{ Body: { password?: string } }>(
    '/api/auth/password/set',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const user = requireUser(req);
      if (user.isDemoAccount) return reply.code(403).send({ error: 'demo_account_cannot_change_profile' });
      const password = req.body?.password;
      if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
        return reply.code(400).send({ error: 'invalid_password' });
      }
      if (user.passwordHash) return reply.code(409).send({ error: 'password_already_set' });
      const passwordHash = await hash(password, ARGON_OPTS);
      await db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, user.id));
      return reply.send({ ok: true });
    },
  );

  /**
   * Change the password: needs the current one. Every other browser is
   * signed out and every desktop app's sign-in revoked; this browser
   * stays signed in. Browser session only (desktop tokens never reach
   * this route).
   */
  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>(
    '/api/auth/password/change',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const user = requireUser(req);
      if (user.isDemoAccount) return reply.code(403).send({ error: 'demo_account_cannot_change_profile' });
      const { currentPassword, newPassword } = req.body ?? {};
      if (typeof newPassword !== 'string' || newPassword.length < PASSWORD_MIN || newPassword.length > PASSWORD_MAX) {
        return reply.code(400).send({ error: 'invalid_password' });
      }
      if (!user.passwordHash) return reply.code(409).send({ error: 'no_password_yet' });
      if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > PASSWORD_MAX) {
        return reply.code(400).send({ error: 'wrong_current_password' });
      }
      // Wrong guesses are paced like sign-in, for the same account.
      const waitMs = loginWaitMs(user.email);
      if (waitMs > 0) {
        const retryAfter = Math.ceil(waitMs / 1000);
        return reply.code(429).header('retry-after', String(retryAfter)).send({ error: 'login_paced', retryAfter });
      }
      if (!(await verify(user.passwordHash, currentPassword, ARGON_OPTS))) {
        noteLoginFailure(user.email);
        return reply.code(400).send({ error: 'wrong_current_password' });
      }
      noteLoginSuccess(user.email);
      const passwordHash = await hash(newPassword, ARGON_OPTS);
      await db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, user.id));
      await db.delete(schema.passwordResets).where(eq(schema.passwordResets.userId, user.id));
      const cookie = req.cookies[SESSION_COOKIE];
      const browsers = await invalidateOtherSessions(user.id, cookie ? sessionIdForToken(cookie) : null);
      const desktops = await revokeAllApiTokens(user.id);
      return reply.send({ ok: true, signedOutBrowsers: browsers, signedOutDesktops: desktops });
    },
  );

  /**
   * "Forgot password?": always the same answer, whether or not the
   * address has an account, so it can't be used to find out who's
   * signed up. An account gets a one-time link (an hour); one never
   * confirmed gets its confirmation link again instead. The email goes
   * out after the answer, so the answer takes as long either way.
   */
  app.post<{ Body: { email?: string } }>(
    '/api/auth/password/forgot',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const email = typeof req.body?.email === 'string' ? normalizeEmail(req.body.email) : '';
      if (!email) return reply.code(400).send({ error: 'invalid_input' });
      const user = await findUserByEmail(email);
      if (user && !user.isDemoAccount && mayEmailReset(user.id)) {
        const log = req.log;
        void (async () => {
          const settings = await getPlatformSettings();
          if (settings.requireEmailVerification && !user.emailVerified) {
            // Not confirmed yet: whoever opens the confirmation link chooses the password.
            await issueVerification(log, user, null, null);
          } else {
            await issuePasswordReset(log, user);
          }
        })().catch((err: unknown) => log.warn({ err }, 'password reset failed'));
      }
      return reply.send({ ok: true });
    },
  );

  /** Whether a reset link still works, so the page can say so before anyone types. */
  app.get<{ Params: { token: string } }>(
    '/api/auth/password/reset/:token',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const { row, expired } = await liveReset(req.params.token);
      if (!row) return reply.code(expired ? 410 : 404).send({ error: expired ? 'reset_link_expired' : 'reset_link_not_found' });
      return reply.send({ ok: true });
    },
  );

  /**
   * Choose a new password from a reset link. The link works once. Every
   * browser and desktop app is signed out, then this browser is signed
   * in (opening the link proved the mailbox, which also confirms it).
   */
  app.post<{ Body: { token?: string; password?: string } }>(
    '/api/auth/password/reset',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const password = req.body?.password;
      if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
        return reply.code(400).send({ error: 'invalid_password' });
      }
      const { row, expired } = await liveReset(req.body?.token);
      if (!row) return reply.code(expired ? 410 : 404).send({ error: expired ? 'reset_link_expired' : 'reset_link_not_found' });
      // Single use: only the request that deletes the row goes on.
      const taken = await db
        .delete(schema.passwordResets)
        .where(and(eq(schema.passwordResets.id, row.id), gt(schema.passwordResets.expiresAt, new Date())))
        .returning({ id: schema.passwordResets.id });
      if (taken.length === 0) return reply.code(404).send({ error: 'reset_link_not_found' });
      const user = await db.select().from(schema.users).where(eq(schema.users.id, row.userId)).get();
      if (!user || user.isDemoAccount) return reply.code(404).send({ error: 'reset_link_not_found' });
      const passwordHash = await hash(password, ARGON_OPTS);
      await db.update(schema.users).set({ passwordHash, emailVerified: true }).where(eq(schema.users.id, user.id));
      await db.delete(schema.passwordResets).where(eq(schema.passwordResets.userId, user.id));
      await db.delete(schema.emailVerifications).where(eq(schema.emailVerifications.userId, user.id));
      await invalidateAllSessions(user.id);
      await revokeAllApiTokens(user.id);
      noteLoginSuccess(user.email);
      const { token, expiresAt } = await createSession(user.id);
      setSessionCookie(reply, token, expiresAt);
      return reply.send({ ok: true });
    },
  );

  app.post<{ Body: { email: string; password: string } }>(
    '/api/auth/password/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const body: Partial<NonNullable<typeof req.body>> = req.body ?? {};
      const { password } = body;
      const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
      if (!email || typeof password !== 'string' || !password || password.length > PASSWORD_MAX) {
        return reply.code(400).send({ error: 'invalid_input' });
      }
      // Many wrong passwords for one account in a row: each further try
      // waits a little longer (see auth/loginPacing.ts). Answered at once,
      // the same for every address, whether it has an account or not.
      const waitMs = loginWaitMs(email);
      if (waitMs > 0) {
        const retryAfter = Math.ceil(waitMs / 1000);
        return reply.code(429).header('retry-after', String(retryAfter)).send({ error: 'login_paced', retryAfter });
      }
      const user = await findUserByEmail(email);
      if (!user || !user.passwordHash) {
        // The same argon2 work as a wrong password, so the answer takes as long.
        await verify(await dummyPasswordHash(), password, ARGON_OPTS);
        noteLoginFailure(email);
        return reply.code(401).send({ error: 'invalid_credentials' });
      }
      const ok = await verify(user.passwordHash, password, ARGON_OPTS);
      if (!ok) {
        noteLoginFailure(email);
        return reply.code(401).send({ error: 'invalid_credentials' });
      }
      noteLoginSuccess(email);
      if (!user.emailVerified) {
        // Re-check live: an admin may have turned verification off
        // after this account registered while it was still on. Don't
        // block a login that the current policy no longer requires.
        const settings = await getPlatformSettings();
        if (settings.requireEmailVerification) {
          return reply.code(403).send({ error: 'email_not_verified' });
        }
      }
      const { token, expiresAt } = await createSession(user.id);
      setSessionCookie(reply, token, expiresAt);
      return reply.send({ ok: true });
    },
  );
}
