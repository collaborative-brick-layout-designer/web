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

// Before env.ts is read: both providers switched on.
vi.hoisted(() => {
  process.env.GITHUB_CLIENT_ID = 'gh-client';
  process.env.GITHUB_CLIENT_SECRET = 'gh-secret';
  process.env.GOOGLE_CLIENT_ID = 'google-client';
  process.env.GOOGLE_CLIENT_SECRET = 'google-secret';
});

let oauth: typeof import('../auth/oauth.js');
let app: FastifyInstance;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  oauth = await import('../auth/oauth.js');
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
function idToken(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    base64url({ alg: 'RS256', kid: 'test', typ: 'JWT' }),
    base64url({ iss: 'https://accounts.google.com', aud: 'google-client', iat: now, exp: now + 3600, ...claims }),
    base64url('not-checked'),
  ].join('.');
}

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

  it('a state that is not the one it sent is refused before GitHub is asked', async () => {
    const s = await start('/api/auth/github');
    const seen = provider({});
    const back = await app.inject({ method: 'GET', url: '/api/auth/github/callback?code=x&state=someone-elses', headers: { cookie: s.cookie } });
    expect(back.headers.location).toBe('/login?error=invalid_state');
    expect(seen).toHaveLength(0);
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
