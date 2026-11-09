// Signing in with GitHub/Google goes back to where the person was going
// (the login page's ?next=, e.g. /device for the desktop app or a club
// invite), and a sign-in that fails lands on the sign-in page with a
// reason, never on a page of JSON.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../../test/helpers.js';

// Before env.ts is read: GitHub sign-in switched on.
vi.hoisted(() => {
  process.env.GITHUB_CLIENT_ID = 'test-id';
  process.env.GITHUB_CLIENT_SECRET = 'test-secret';
});

let oauth: typeof import('../auth/oauth.js');
let app: FastifyInstance;

beforeAll(async () => {
  oauth = await import('../auth/oauth.js');
});

beforeEach(async () => {
  resetDb();
  app = Fastify();
  await app.register(cookie);
  await app.register(oauth.oauthRoutes);
});

function cookies(res: { headers: Record<string, unknown> }): string[] {
  const c = res.headers['set-cookie'];
  return Array.isArray(c) ? (c as string[]) : c ? [c as string] : [];
}

describe('OAuth sign-in keeps ?next=', () => {
  it('remembers a path on this site for the way back, and ignores other sites', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/github?next=%2Fdevice%3Fcode%3DAB' });
    expect(res.statusCode).toBe(302);
    expect(cookies(res).find((c) => c.startsWith('cld_oauth_next='))).toMatch(/^cld_oauth_next=(\/device\?code=AB|%2Fdevice%3Fcode%3DAB);/);

    const evil = await app.inject({ method: 'GET', url: '/api/auth/github?next=https%3A%2F%2Fevil.test' });
    expect(cookies(evil).find((c) => c.startsWith('cld_oauth_next='))).toMatch(/^cld_oauth_next=;/);
  });

  it('a callback that does not match goes to the sign-in page with a reason', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/github/callback?code=x&state=y', headers: { cookie: 'cld_oauth_state=z' } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login?error=invalid_state');
  });

  it('clears the state, verifier and next cookies once the callback has read them', async () => {
    const sent = 'cld_oauth_state=abc; cld_oauth_verifier=v; cld_oauth_next=%2Fdevice';
    const cleared = (res: { headers: Record<string, unknown> }) =>
      cookies(res)
        .filter((c) => /^[a-z_]+=;/.test(c) && /Expires=Thu, 01 Jan 1970/i.test(c))
        .map((c) => c.split('=')[0])
        .sort();
    // A callback that doesn't match.
    const bad = await app.inject({ method: 'GET', url: '/api/auth/github/callback?code=x&state=nope', headers: { cookie: sent } });
    expect(bad.headers.location).toBe('/login?error=invalid_state');
    expect(cleared(bad)).toEqual(['cld_oauth_next', 'cld_oauth_state', 'cld_oauth_verifier']);
    // One that matches but the provider refuses the code.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    try {
      const refused = await app.inject({ method: 'GET', url: '/api/auth/github/callback?code=x&state=abc', headers: { cookie: sent } });
      expect(refused.headers.location, refused.body).toBe('/login?error=oauth_error');
      expect(cleared(refused)).toEqual(['cld_oauth_next', 'cld_oauth_state', 'cld_oauth_verifier']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('signing in goes on to the remembered path, or Home when there is none or it is unsafe', async () => {
    const profile = { providerUserId: 'gh-1', email: 'nina@example.com', displayName: 'Nina', avatarUrl: null };
    const redirects: string[] = [];
    const reply = {
      setCookie: () => reply,
      clearCookie: () => reply,
      redirect: (to: string) => {
        redirects.push(to);
        return reply;
      },
    } as unknown as import('fastify').FastifyReply;
    await oauth.completeLogin(reply, 'github', profile, '/org-invite/abc');
    await oauth.completeLogin(reply, 'github', profile, '');
    await oauth.completeLogin(reply, 'github', profile, '//evil.test');
    expect(redirects).toEqual(['/org-invite/abc', '/', '/']);
  });
});
