import type { FastifyInstance } from 'fastify';
import { generateCodeVerifier, generateState, OAuth2RequestError } from 'arctic';
import { google, github, type NormalisedProfile, type ProviderId } from '../../auth/providers.js';
import { and, eq } from 'drizzle-orm';
import { linkProvider, resolveOauthUser } from '../../auth/users.js';
import { createSession } from '../../auth/session.js';
import { requireUser, setSessionCookie } from '../../auth/cookie.js';
import { isDemoUser } from '../../demo/demoAccount.js';
import {
  consumePendingLink,
  createPendingLink,
  peekPendingLink,
  PENDING_LINK_COOKIE,
  PENDING_LINK_TTL_MS,
} from '../../auth/pendingLinks.js';
import { db, schema } from '../../db/index.js';
import { env } from '../../env.js';
import { looksLikeEmail } from '../../utils/publicName.js';
import { safeNextPath } from '../../utils/validate.js';

const STATE_COOKIE = 'cld_oauth_state';
const VERIFIER_COOKIE = 'cld_oauth_verifier';
/** Where to go once signed in (the login page's `?next=`). */
const NEXT_COOKIE = 'cld_oauth_next';

/**
 * A sign-in that didn't work goes back to the sign-in page, which says
 * why in plain words, never to a page of JSON.
 */
export function oauthFailure(reply: import('fastify').FastifyReply, error: 'invalid_state' | 'oauth_error' | 'email_not_verified' | 'email_unavailable') {
  reply.clearCookie(NEXT_COOKIE, { path: '/' });
  return reply.redirect(`/login?error=${error}`);
}

export async function oauthRoutes(app: FastifyInstance) {
  // ---- Google ------------------------------------------------------------
  const googleClient = google;
  if (googleClient) {
    // codeql[js/missing-rate-limiting] - rate limited via Fastify config.rateLimit
    app.get<{ Querystring: { next?: string } }>('/api/auth/google', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
      const state = generateState();
      const codeVerifier = generateCodeVerifier();
      const url = googleClient.createAuthorizationURL(state, codeVerifier, [
        'openid',
        'email',
        'profile',
      ]);
      setStateCookies(reply, state, codeVerifier, req.query.next);
      return reply.redirect(url.toString());
    });

    // codeql[js/missing-rate-limiting] - rate limited via Fastify config.rateLimit
    app.get('/api/auth/google/callback', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
      const params = req.query as { code?: string; state?: string };
      const stored = takeStateCookies(req, reply);
      if (!params.code || !params.state || !stored.state || params.state !== stored.state) {
        return oauthFailure(reply, 'invalid_state');
      }
      try {
        const tokens = await googleClient.validateAuthorizationCode(params.code, stored.verifier);
        const profile = await fetchGoogleProfile(tokens.accessToken());
        return await completeLogin(reply, 'google', profile, stored.next);
      } catch (e) {
        if (e instanceof OAuth2RequestError) return oauthFailure(reply, 'oauth_error');
        if (e instanceof UnverifiedEmailError) return oauthFailure(reply, 'email_not_verified');
        throw e;
      }
    });
  }

  // ---- GitHub ------------------------------------------------------------
  const githubClient = github;
  if (githubClient) {
    // codeql[js/missing-rate-limiting] - rate limited via Fastify config.rateLimit
    app.get<{ Querystring: { next?: string } }>('/api/auth/github', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
      const state = generateState();
      const url = githubClient.createAuthorizationURL(state, ['read:user', 'user:email']);
      setStateCookies(reply, state, '', req.query.next);
      return reply.redirect(url.toString());
    });

    // codeql[js/missing-rate-limiting] - rate limited via Fastify config.rateLimit
    app.get('/api/auth/github/callback', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
      const params = req.query as { code?: string; state?: string };
      const stored = takeStateCookies(req, reply);
      if (!params.code || !params.state || !stored.state || params.state !== stored.state) {
        return oauthFailure(reply, 'invalid_state');
      }
      try {
        const tokens = await githubClient.validateAuthorizationCode(params.code);
        const profile = await fetchGithubProfile(tokens.accessToken());
        return await completeLogin(reply, 'github', profile, stored.next);
      } catch (e) {
        if (e instanceof OAuth2RequestError) return oauthFailure(reply, 'oauth_error');
        if (e instanceof GithubEmailUnavailableError) return oauthFailure(reply, 'email_unavailable');
        throw e;
      }
    });
  }

  // ---- Account linking ----------------------------------------------------
  // After an OAuth sign-in whose email matched an existing account (see
  // completeLogin), the browser holds a pending-link cookie. The link is
  // committed only from a session already signed in to THAT account.

  // codeql[js/missing-rate-limiting] - rate limited via Fastify config.rateLimit
  app.get('/api/auth/link', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const link = peekPendingLink(req.cookies[PENDING_LINK_COOKIE]);
    if (!link) return reply.code(404).send({ error: 'no_pending_link' });
    return { provider: link.provider, signedInAsTarget: req.user?.id === link.userId };
  });

  // codeql[js/missing-rate-limiting] - rate limited via Fastify config.rateLimit
  app.post('/api/auth/link', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const user = requireUser(req);
    if (isDemoUser(user)) return reply.code(403).send({ error: 'demo_account_cannot_link' });
    const token = req.cookies[PENDING_LINK_COOKIE];
    const link = peekPendingLink(token);
    if (!token || !link) return reply.code(404).send({ error: 'no_pending_link' });
    // Proof of control of the existing account: you must be signed in to it.
    if (link.userId !== user.id) return reply.code(403).send({ error: 'wrong_account' });
    const existing = await db
      .select({ userId: schema.oauthAccounts.userId })
      .from(schema.oauthAccounts)
      .where(
        and(
          eq(schema.oauthAccounts.provider, link.provider),
          eq(schema.oauthAccounts.providerUserId, link.providerUserId),
        ),
      )
      .get();
    if (existing && existing.userId !== user.id) {
      consumePendingLink(token);
      reply.clearCookie(PENDING_LINK_COOKIE, { path: '/' });
      return reply.code(409).send({ error: 'provider_account_already_linked' });
    }
    await linkProvider(user.id, link.provider, link.providerUserId);
    consumePendingLink(token);
    reply.clearCookie(PENDING_LINK_COOKIE, { path: '/' });
    return { ok: true, provider: link.provider };
  });

  // codeql[js/missing-rate-limiting] - rate limited via Fastify config.rateLimit
  app.delete('/api/auth/link', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const token = req.cookies[PENDING_LINK_COOKIE];
    if (token) consumePendingLink(token);
    reply.clearCookie(PENDING_LINK_COOKIE, { path: '/' });
    return { ok: true };
  });

  // OIDC is plumbed through openid-client; deferred from this scaffold pass
  // so the file doesn't grow unbounded. Provider listing already advertises it
  // when env.oidc is set; the route handlers go in `oidc.ts` next.
}

export async function completeLogin(
  reply: import('fastify').FastifyReply,
  provider: ProviderId,
  profile: NormalisedProfile,
  next = '',
) {
  reply.clearCookie(NEXT_COOKIE, { path: '/' });
  const { user, linkPrompt } = await resolveOauthUser(provider, profile);
  if (linkPrompt) {
    // Redirect to the link-confirmation page. The pending link is kept
    // server-side (see auth/pendingLinks.ts); the cookie only carries an
    // opaque token. POST /api/auth/link commits it once the user is
    // signed in to the existing account.
    const token = createPendingLink({ provider, providerUserId: profile.providerUserId, userId: user.id });
    reply.setCookie(PENDING_LINK_COOKIE, token, {
      httpOnly: true,
      secure: env.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: PENDING_LINK_TTL_MS / 1000,
    });
    return reply.redirect('/link');
  }
  const { token, expiresAt } = await createSession(user.id);
  setSessionCookie(reply, token, expiresAt);
  return reply.redirect(safeNextPath(next) ?? '/');
}

function setStateCookies(
  reply: import('fastify').FastifyReply,
  state: string,
  verifier: string,
  next: unknown,
) {
  const opts = {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 60 * 10,
  };
  reply.setCookie(STATE_COOKIE, state, opts);
  reply.setCookie(VERIFIER_COOKIE, verifier, opts);
  const to = safeNextPath(next);
  if (to) reply.setCookie(NEXT_COOKIE, to, opts);
  else reply.clearCookie(NEXT_COOKIE, { path: '/' });
}

/**
 * The state, verifier and next-path cookies, read once: the callback
 * clears them whatever happens next, so they never outlive the sign-in.
 */
function takeStateCookies(req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) {
  for (const name of [STATE_COOKIE, VERIFIER_COOKIE, NEXT_COOKIE]) {
    if (req.cookies[name] !== undefined) reply.clearCookie(name, { path: '/' });
  }
  return {
    state: req.cookies[STATE_COOKIE] ?? '',
    verifier: req.cookies[VERIFIER_COOKIE] ?? '',
    next: req.cookies[NEXT_COOKIE] ?? '',
  };
}

/** Thrown when GitHub shares no verified email for the account. */
export class GithubEmailUnavailableError extends Error {
  constructor() {
    super('github email unavailable');
  }
}

/** Thrown when the provider can't vouch for the account's email. */
export class UnverifiedEmailError extends Error {
  constructor() {
    super('provider email not verified');
  }
}

export async function fetchGoogleProfile(accessToken: string): Promise<NormalisedProfile> {
  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error('google userinfo failed');
  const data = (await res.json()) as {
    sub: string;
    email: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };
  // OAuth accounts are created with emailVerified=true and matched to
  // invites by email, so an address Google hasn't verified (possible for
  // Google accounts registered with a non-Gmail address) must not sign in.
  if (data.email_verified !== true || !data.email) throw new UnverifiedEmailError();
  return {
    providerUserId: data.sub,
    email: data.email,
    // Not the email when Google has no name: the person is asked for one after signing in.
    displayName: data.name && !looksLikeEmail(data.name) ? data.name : '',
    avatarUrl: data.picture ?? null,
  };
}

async function fetchGithubProfile(accessToken: string): Promise<NormalisedProfile> {
  const userRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'collaborative-brick-layout-designer' },
  });
  if (!userRes.ok) throw new Error('github user failed');
  const user = (await userRes.json()) as {
    id: number;
    login: string;
    name: string | null;
    avatar_url: string | null;
    email: string | null;
  };
  let email = user.email;
  if (!email) {
    const emailRes = await fetch('https://api.github.com/user/emails', {
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'collaborative-brick-layout-designer' },
    });
    if (emailRes.ok) {
      const emails = (await emailRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
      email = emails.find((e) => e.primary && e.verified)?.email ?? null;
    }
  }
  if (!email) throw new GithubEmailUnavailableError();
  return {
    providerUserId: String(user.id),
    email,
    displayName: user.name && !looksLikeEmail(user.name) ? user.name : user.login,
    avatarUrl: user.avatar_url,
  };
}
