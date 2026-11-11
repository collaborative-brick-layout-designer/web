// Signing in with GitHub and with Google, from the button to a session,
// through openid-client: the redirect carries the state (and, for Google,
// PKCE), the callback trades the code at the provider's token endpoint,
// checks Google's ID token, reads the profile and signs the person in. And
// each way it can go wrong lands on the sign-in page with a reason.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { resetDb } from '../../test/helpers.js';
import { db, schema } from '../../db/index.js';

// Before env.ts is read: all three providers switched on.
vi.hoisted(() => {
  process.env.GITHUB_CLIENT_ID = 'gh-client';
  process.env.GITHUB_CLIENT_SECRET = 'gh-secret';
  process.env.GOOGLE_CLIENT_ID = 'google-client';
  process.env.GOOGLE_CLIENT_SECRET = 'google-secret';
  process.env.OIDC_ISSUER_URL = 'https://sso.test';
  process.env.OIDC_CLIENT_ID = 'oidc-client';
  process.env.OIDC_CLIENT_SECRET = 'oidc-secret';
});

let oauth: typeof import('../auth/oauth.js');
let providers: typeof import('../../auth/providers.js');
let app: FastifyInstance;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  oauth = await import('../auth/oauth.js');
  providers = await import('../../auth/providers.js');
});

beforeEach(async () => {
  resetDb();
  app = Fastify();
  await app.register(cookie);
  await app.register(oauth.oauthRoutes);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function setCookies(res: { headers: Record<string, unknown> }): string[] {
  const c = res.headers['set-cookie'];
  return Array.isArray(c) ? (c as string[]) : c ? [c as string] : [];
}

/** The cookies a response set, as a Cookie header for the next request. */
function cookieHeader(res: { headers: Record<string, unknown> }): string {
  return setCookies(res)
    .map((c) => c.split(';')[0]!)
    .filter((c) => !c.endsWith('='))
    .join('; ');
}

function base64url(v: object | string): string {
  return Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
}

/** An ID token as Google's token endpoint returns it (the signature isn't checked over TLS). */
function idToken(claims: Record<string, unknown>, iss = 'https://accounts.google.com', aud = 'google-client'): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    base64url({ alg: 'RS256', kid: 'test', typ: 'JWT' }),
    base64url({ iss, aud, iat: now, exp: now + 3600, ...claims }),
    base64url('not-checked'),
  ].join('.');
}

/** The single sign-on provider's discovery document, as openid-client reads it. */
const SSO_DISCOVERY = {
  issuer: 'https://sso.test',
  authorization_endpoint: 'https://sso.test/authorize',
  token_endpoint: 'https://sso.test/token',
  userinfo_endpoint: 'https://sso.test/userinfo',
  jwks_uri: 'https://sso.test/jwks',
  code_challenge_methods_supported: ['S256'],
};

interface Seen {
  url: string;
  body: string;
  auth: string | null;
}

/** Stands in for the provider's servers; records what the server sent. */
function provider(routes: Record<string, (seen: Seen) => Response>): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const s: Seen = { url: req.url, body: await req.clone().text(), auth: req.headers.get('authorization') };
    seen.push(s);
    const route = Object.keys(routes).find((r) => req.url.startsWith(r));
    if (!route) return new Response('not mocked: ' + req.url, { status: 599 });
    return routes[route]!(s);
  }) as typeof fetch;
  return seen;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function start(path: string) {
  const res = await app.inject({ method: 'GET', url: path });
  expect(res.statusCode).toBe(302);
  const to = new URL(res.headers.location as string);
  return { to, cookie: cookieHeader(res), state: to.searchParams.get('state')! };
}

describe('GitHub sign-in', () => {
  it('goes to GitHub with the state and the callback, and signs in from the code', async () => {
    const { to, cookie, state } = await start('/api/auth/github?next=%2Fdevice');
    expect(to.origin + to.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(to.searchParams.get('client_id')).toBe('gh-client');
    expect(to.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/auth/github/callback');
    expect(to.searchParams.get('scope')).toBe('read:user user:email');
    expect(state).toMatch(/^[\w-]{20,}$/);

    const seen = provider({
      'https://github.com/login/oauth/access_token': () => json({ access_token: 'gho_abc', token_type: 'bearer', scope: 'read:user,user:email' }),
      'https://api.github.com/user/emails': () => json([{ email: 'nina@example.com', primary: true, verified: true }]),
      'https://api.github.com/user': () => json({ id: 4242, login: 'nina', name: 'Nina Rails', avatar_url: 'https://avatars.example/n', email: null }),
    });
    const back = await app.inject({ method: 'GET', url: `/api/auth/github/callback?code=the-code&state=${state}`, headers: { cookie } });
    expect(back.statusCode, back.body).toBe(302);
    expect(back.headers.location).toBe('/device');
    expect(setCookies(back).some((c) => /^cld_session=[^;]+;/.test(c))).toBe(true);

    const token = seen.find((s) => s.url.startsWith('https://github.com/login/oauth/access_token'))!;
    const sent = new URLSearchParams(token.body);
    expect(sent.get('code')).toBe('the-code');
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('redirect_uri')).toBe('http://localhost:3000/api/auth/github/callback');
    expect(seen.find((s) => s.url === 'https://api.github.com/user')!.auth).toBe('Bearer gho_abc');

    const user = db.select().from(schema.users).where(eq(schema.users.email, 'nina@example.com')).get();
    expect(user?.displayName).toBe('Nina Rails');
    const linked = db.select().from(schema.oauthAccounts).where(eq(schema.oauthAccounts.providerUserId, '4242')).get();
    expect(linked?.provider).toBe('github');
  });

  it('a refused code, an unreachable GitHub and no verified email each say why on the sign-in page', async () => {
    let s = await start('/api/auth/github');
    provider({ 'https://github.com/login/oauth/access_token': () => json({ error: 'bad_verification_code' }) });
    let back = await app.inject({ method: 'GET', url: `/api/auth/github/callback?code=x&state=${s.state}`, headers: { cookie: s.cookie } });
    expect(back.headers.location).toBe('/login?error=oauth_error');

    s = await start('/api/auth/github');
    provider({ 'https://github.com/login/oauth/access_token': () => new Response('bad gateway', { status: 502 }) });
    back = await app.inject({ method: 'GET', url: `/api/auth/github/callback?code=x&state=${s.state}`, headers: { cookie: s.cookie } });
    expect(back.headers.location).toBe('/login?error=oauth_error');

    s = await start('/api/auth/github');
    provider({
      'https://github.com/login/oauth/access_token': () => json({ access_token: 'gho_abc', token_type: 'bearer' }),
      'https://api.github.com/user/emails': () => json([{ email: 'x@example.com', primary: true, verified: false }]),
      'https://api.github.com/user': () => json({ id: 1, login: 'x', name: null, avatar_url: null, email: null }),
    });
    back = await app.inject({ method: 'GET', url: `/api/auth/github/callback?code=x&state=${s.state}`, headers: { cookie: s.cookie } });
    expect(back.headers.location).toBe('/login?error=email_unavailable');
  });

  // Pressing Cancel on GitHub's page comes back with error=access_denied and
  // our state, and no code: said as what it was, not "took too long".
  it('cancelling at GitHub says so, and GitHub is never asked for a token', async () => {
    const s = await start('/api/auth/github?next=%2Fdevice');
    const seen = provider({});
    const back = await app.inject({
      method: 'GET',
      url: `/api/auth/github/callback?error=access_denied&error_description=The+user+has+denied+your+application+access.&state=${s.state}`,
      headers: { cookie: s.cookie },
    });
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe('/login?error=canceled');
    expect(seen).toHaveLength(0);
    expect(setCookies(back).some((c) => /^cld_session=[^;]+;/.test(c))).toBe(false);

    // Another problem the provider reports itself: the sign-in didn't go through.
    const t = await start('/api/auth/github');
    const other = await app.inject({ method: 'GET', url: `/api/auth/github/callback?error=server_error&state=${t.state}`, headers: { cookie: t.cookie } });
    expect(other.headers.location).toBe('/login?error=oauth_error');

    // "Cancelled" with a state that isn't ours is not believed.
    const u = await start('/api/auth/github');
    const forged = await app.inject({ method: 'GET', url: '/api/auth/github/callback?error=access_denied&state=someone-elses', headers: { cookie: u.cookie } });
    expect(forged.headers.location).toBe('/login?error=invalid_state');
  });

  // A provider's name is cut to the 60 characters a display name may have.
  it('a very long name from the provider is cut to 60 characters', async () => {
    const { cookie, state } = await start('/api/auth/github');
    const long = 'Bartholomew Maximilian Fitzgerald-Montgomery von Hohenzollern the Third of Northumberland';
    provider({
      'https://github.com/login/oauth/access_token': () => json({ access_token: 'gho_abc', token_type: 'bearer' }),
      'https://api.github.com/user/emails': () => json([{ email: 'bart@example.com', primary: true, verified: true }]),
      'https://api.github.com/user': () => json({ id: 777, login: 'bart', name: `  ${long}  `, avatar_url: null, email: null }),
    });
    const back = await app.inject({ method: 'GET', url: `/api/auth/github/callback?code=c&state=${state}`, headers: { cookie } });
    expect(back.statusCode, back.body).toBe(302);
    const user = db.select().from(schema.users).where(eq(schema.users.email, 'bart@example.com')).get();
    expect(user?.displayName).toBe(long.slice(0, 60).trim());
    expect(user!.displayName.length).toBeLessThanOrEqual(60);
  });

  it('a state that is not the one it sent is refused before GitHub is asked', async () => {
    const s = await start('/api/auth/github');
    const seen = provider({});
    const back = await app.inject({ method: 'GET', url: '/api/auth/github/callback?code=x&state=someone-elses', headers: { cookie: s.cookie } });
    expect(back.headers.location).toBe('/login?error=invalid_state');
    expect(seen).toHaveLength(0);
  });
});

describe('providerDisplayName', () => {
  it('trims, keeps a short name whole, and never cuts through an emoji', () => {
    expect(oauth.providerDisplayName('  Nina Rails ')).toBe('Nina Rails');
    expect(oauth.providerDisplayName('x'.repeat(60))).toBe('x'.repeat(60));
    expect(oauth.providerDisplayName('x'.repeat(61))).toBe('x'.repeat(60));
    // 59 letters, then an emoji that takes two: it doesn't fit, so it's left off whole.
    expect(oauth.providerDisplayName('x'.repeat(59) + '🚂')).toBe('x'.repeat(59));
    expect(oauth.providerDisplayName('x'.repeat(58) + '🚂')).toBe('x'.repeat(58) + '🚂');
    expect(oauth.providerDisplayName('y'.repeat(59) + ' zzz')).toBe('y'.repeat(59));
  });
});

describe('Google sign-in', () => {
  it('goes to Google with PKCE, checks the ID token and signs in', async () => {
    const { to, cookie, state } = await start('/api/auth/google');
    expect(to.origin + to.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(to.searchParams.get('scope')).toBe('openid email profile');
    expect(to.searchParams.get('code_challenge_method')).toBe('S256');
    expect(to.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(to.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/auth/google/callback');

    const seen = provider({
      'https://oauth2.googleapis.com/token': () =>
        json({ access_token: 'ya29.abc', token_type: 'Bearer', expires_in: 3599, id_token: idToken({ sub: 'g-77', email: 'ola@example.com' }) }),
      'https://openidconnect.googleapis.com/v1/userinfo': () =>
        json({ sub: 'g-77', email: 'ola@example.com', email_verified: true, name: 'Ola Track', picture: 'https://pics.example/o' }),
    });
    const back = await app.inject({ method: 'GET', url: `/api/auth/google/callback?code=g-code&state=${state}`, headers: { cookie } });
    expect(back.statusCode, back.body).toBe(302);
    expect(back.headers.location).toBe('/');
    const sent = new URLSearchParams(seen.find((s) => s.url.startsWith('https://oauth2.googleapis.com/token'))!.body);
    expect(sent.get('code_verifier')).toMatch(/^[\w-]{43,}$/);
    const user = db.select().from(schema.users).where(eq(schema.users.email, 'ola@example.com')).get();
    expect(user?.displayName).toBe('Ola Track');
  });

  it('an ID token for another app, or an unverified address, does not sign in', async () => {
    let s = await start('/api/auth/google');
    provider({
      'https://oauth2.googleapis.com/token': () =>
        json({ access_token: 'ya29.abc', token_type: 'Bearer', id_token: idToken({ sub: 'g-1', aud: 'someone-else' }) }),
    });
    let back = await app.inject({ method: 'GET', url: `/api/auth/google/callback?code=x&state=${s.state}`, headers: { cookie: s.cookie } });
    expect(back.headers.location).toBe('/login?error=oauth_error');

    s = await start('/api/auth/google');
    provider({
      'https://oauth2.googleapis.com/token': () =>
        json({ access_token: 'ya29.abc', token_type: 'Bearer', id_token: idToken({ sub: 'g-2' }) }),
      'https://openidconnect.googleapis.com/v1/userinfo': () => json({ sub: 'g-2', email: 'u@example.com', email_verified: false }),
    });
    back = await app.inject({ method: 'GET', url: `/api/auth/google/callback?code=x&state=${s.state}`, headers: { cookie: s.cookie } });
    expect(back.headers.location).toBe('/login?error=email_not_verified');
    expect(db.select().from(schema.users).where(eq(schema.users.email, 'u@example.com')).get()).toBeUndefined();
  });
});

describe('Single sign-on (OpenID Connect)', () => {
  beforeEach(() => providers.forgetOidcDiscovery());

  it('reads the provider by discovery, goes there with PKCE and a nonce, and signs in from the ID token and UserInfo', async () => {
    let sentNonce = '';
    const seen = provider({
      'https://sso.test/.well-known/openid-configuration': () => json(SSO_DISCOVERY),
      // The ID token carries the nonce the server sent, and no email.
      'https://sso.test/token': () =>
        json({ access_token: 'sso-token', token_type: 'Bearer', expires_in: 3599, id_token: idToken({ sub: 'u-9', nonce: sentNonce }, 'https://sso.test', 'oidc-client') }),
      'https://sso.test/userinfo': () => json({ sub: 'u-9', email: 'mira@example.com', name: 'Mira Switch' }),
    });
    const { to, cookie, state } = await start('/api/auth/oidc?next=%2Fsettings');
    expect(to.origin + to.pathname).toBe('https://sso.test/authorize');
    expect(to.searchParams.get('client_id')).toBe('oidc-client');
    expect(to.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/auth/oidc/callback');
    expect(to.searchParams.get('scope')).toBe('openid email profile');
    expect(to.searchParams.get('code_challenge_method')).toBe('S256');
    sentNonce = to.searchParams.get('nonce')!;
    expect(sentNonce).toMatch(/^[\w-]{20,}$/);

    const back = await app.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=sso-code&state=${state}`, headers: { cookie } });
    expect(back.statusCode, back.body).toBe(302);
    expect(back.headers.location).toBe('/settings');
    expect(setCookies(back).some((c) => /^cld_session=[^;]+;/.test(c))).toBe(true);
    expect(seen.find((s) => s.url === 'https://sso.test/userinfo')!.auth).toBe('Bearer sso-token');

    const user = db.select().from(schema.users).where(eq(schema.users.email, 'mira@example.com')).get();
    expect(user?.displayName).toBe('Mira Switch');
    const linked = db.select().from(schema.oauthAccounts).where(eq(schema.oauthAccounts.providerUserId, 'u-9')).get();
    expect(linked?.provider).toBe('oidc');
  });

  it('cancelling at the single sign-on provider says so', async () => {
    const seen = provider({ 'https://sso.test/.well-known/openid-configuration': () => json(SSO_DISCOVERY) });
    const { cookie, state } = await start('/api/auth/oidc');
    const asked = seen.length;
    const back = await app.inject({ method: 'GET', url: `/api/auth/oidc/callback?error=access_denied&state=${state}`, headers: { cookie } });
    expect(back.headers.location).toBe('/login?error=canceled');
    // The provider's token endpoint is never asked.
    expect(seen.slice(asked).some((s) => s.url.startsWith('https://sso.test/token'))).toBe(false);
  });

  it('a provider whose discovery document can’t be read says so on the sign-in page, and is asked again next time', async () => {
    provider({ 'https://sso.test/.well-known/openid-configuration': () => new Response('down', { status: 503 }) });
    let res = await app.inject({ method: 'GET', url: '/api/auth/oidc' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login?error=sso_unavailable');

    // Back up: the next sign-in reads the document again and goes through.
    provider({ 'https://sso.test/.well-known/openid-configuration': () => json(SSO_DISCOVERY) });
    res = await app.inject({ method: 'GET', url: '/api/auth/oidc' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/sso\.test\/authorize\?/);
  });

  it('an ID token with the wrong nonce, or an address the provider marks unverified, does not sign in', async () => {
    provider({
      'https://sso.test/.well-known/openid-configuration': () => json(SSO_DISCOVERY),
      'https://sso.test/token': () => json({ access_token: 't', token_type: 'Bearer', id_token: idToken({ sub: 'u-1', nonce: 'replayed' }, 'https://sso.test', 'oidc-client') }),
    });
    let s = await start('/api/auth/oidc');
    let back = await app.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=x&state=${s.state}`, headers: { cookie: s.cookie } });
    expect(back.headers.location).toBe('/login?error=oauth_error');

    s = await start('/api/auth/oidc');
    const nonce = s.to.searchParams.get('nonce')!;
    provider({
      'https://sso.test/.well-known/openid-configuration': () => json(SSO_DISCOVERY),
      'https://sso.test/token': () => json({ access_token: 't', token_type: 'Bearer', id_token: idToken({ sub: 'u-2', nonce, email: 'v@example.com', email_verified: false }, 'https://sso.test', 'oidc-client') }),
    });
    back = await app.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=x&state=${s.state}`, headers: { cookie: s.cookie } });
    expect(back.headers.location).toBe('/login?error=email_not_verified');
    expect(db.select().from(schema.users).where(eq(schema.users.email, 'v@example.com')).get()).toBeUndefined();
  });

  it('takes the verified mark only as true or "true"; any other value does not sign in', async () => {
    const signIn = async (sub: string, email: string, mark: unknown) => {
      provider({ 'https://sso.test/.well-known/openid-configuration': () => json(SSO_DISCOVERY) });
      const s = await start('/api/auth/oidc');
      const nonce = s.to.searchParams.get('nonce')!;
      provider({
        'https://sso.test/.well-known/openid-configuration': () => json(SSO_DISCOVERY),
        'https://sso.test/token': () => json({ access_token: 't', token_type: 'Bearer', id_token: idToken({ sub, nonce, email, email_verified: mark }, 'https://sso.test', 'oidc-client') }),
      });
      return app.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=x&state=${s.state}`, headers: { cookie: s.cookie } });
    };
    for (const [i, mark] of ['false', 0, 'no', 'False', null, 1, ''].entries()) {
      const back = await signIn(`w-${i}`, `w${i}@example.com`, mark);
      expect(back.headers.location, JSON.stringify(mark)).toBe('/login?error=email_not_verified');
      expect(setCookies(back).some((c) => /^cld_session=[^;]+;/.test(c)), JSON.stringify(mark)).toBe(false);
      expect(db.select().from(schema.users).where(eq(schema.users.email, `w${i}@example.com`)).get(), JSON.stringify(mark)).toBeUndefined();
    }
    for (const [i, mark] of [true, 'true'].entries()) {
      const back = await signIn(`y-${i}`, `y${i}@example.com`, mark);
      expect(back.headers.location, JSON.stringify(mark)).toBe('/');
      expect(db.select().from(schema.users).where(eq(schema.users.email, `y${i}@example.com`)).get(), JSON.stringify(mark)).toBeDefined();
    }
  });
});
