// Regression tests for stored-XSS hardening:
//   - uploaded custom-part XML is served as a text/plain attachment
//   - /api/* and /parts/* responses carry a sandbox CSP + nosniff

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { beforeEach, describe, expect, it } from 'vitest';
import { loginAs, resetDb } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { customPartRoutes } from '../customParts.js';
import { PARTS_STATIC_OPTIONS, registerSecurityHeaders, SANDBOX_CSP, SPA_CSP } from '../../utils/securityHeaders.js';
import { registerErrorHandler } from '../../utils/errorHandler.js';
import { redactUrl } from '../../utils/logRedact.js';

const XHTML = '<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(document.cookie)</script></html>';

async function buildApp(staticRoot?: string): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  registerSecurityHeaders(app);
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  await app.register(passwordRoutes);
  await app.register(customPartRoutes);
  if (staticRoot) {
    await app.register(fastifyStatic, { root: staticRoot, prefix: '/parts/libraries/', ...PARTS_STATIC_OPTIONS });
  }
  app.get('/spa-route', async () => 'spa');
  app.get('/spa-html', async (_req, reply) => reply.type('text/html; charset=utf-8').send('<!doctype html><div id="root"></div>'));
  return app;
}

describe('stored XSS hardening', () => {
  beforeEach(() => resetDb());

  it('serves uploaded part XML as a text/plain attachment, never inline XML', async () => {
    const app = await buildApp();
    const a = await loginAs(app, 'a@x.com');
    const created = await app.inject({
      method: 'POST',
      url: '/api/custom-parts',
      headers: { cookie: a.cookie },
      payload: {
        partNumber: 'P',
        displayName: 'P',
        xmlBase64: Buffer.from(XHTML).toString('base64'),
        spriteBase64: 'R0lGODlh',
        spriteMime: 'image/gif',
      },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;

    const res = await app.inject({
      method: 'GET',
      url: `/api/custom-parts/${id}/xml`,
      headers: { cookie: a.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe(SANDBOX_CSP);
    expect(res.body).toBe(XHTML);
    await app.close();
  });

  it('sandboxes files served from /parts/libraries/* (e.g. html/svg from an installed zip)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cld-libs-'));
    try {
      mkdirSync(join(root, 'evil'));
      writeFileSync(join(root, 'evil', 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      const app = await buildApp(root);
      const res = await app.inject({ method: 'GET', url: '/parts/libraries/evil/x.svg' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-security-policy']).toBe(SANDBOX_CSP);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      await app.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('covers JSON API errors too, but leaves non-API (SPA) routes alone', async () => {
    const app = await buildApp();
    const api = await app.inject({ method: 'GET', url: '/api/custom-parts' });
    expect(api.statusCode).toBe(401);
    expect(api.headers['content-security-policy']).toBe(SANDBOX_CSP);
    const spa = await app.inject({ method: 'GET', url: '/spa-route' });
    expect(spa.headers['content-security-policy']).toBeUndefined();
    await app.close();
  });
});

describe('audit 2026-10 hardening', () => {
  beforeEach(() => resetDb());

  it("gives the SPA's HTML a script-src 'self' policy with no framing", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/spa-html' });
    expect(res.headers['content-security-policy']).toBe(SPA_CSP);
    expect(SPA_CSP).toContain("script-src 'self'");
    expect(SPA_CSP).not.toMatch(/script-src[^;]*unsafe/);
    expect(SPA_CSP).toContain("frame-ancestors 'none'");
    expect(SPA_CSP).toContain("object-src 'none'");
    await app.close();
  });

  it('lets the app load images only from this server and the sign-in avatar hosts', () => {
    const imgSrc = SPA_CSP.split('; ').find((d) => d.startsWith('img-src '))!;
    expect(imgSrc.split(' ').slice(1).sort()).toEqual(["'self'", 'blob:', 'data:', 'https://*.googleusercontent.com', 'https://avatars.githubusercontent.com'].sort());
    // No bare scheme: a layout's background address on another host stays blocked.
    expect(imgSrc).not.toMatch(/(^| )https?:( |$)/);
  });

  it('sandboxes an /api path even when its prefix is percent-encoded', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/%61pi/custom-parts' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-security-policy']).toBe(SANDBOX_CSP);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    await app.close();
  });

  it('never serves dotfiles from an installed part library', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cld-libs-'));
    try {
      mkdirSync(join(root, 'lib', '.hidden'), { recursive: true });
      writeFileSync(join(root, 'lib', '.env'), 'SECRET=1');
      writeFileSync(join(root, 'lib', '.hidden', 'config'), 'SECRET=2');
      writeFileSync(join(root, 'lib', 'ok.xml'), '<part/>');
      const app = await buildApp(root);
      expect((await app.inject({ method: 'GET', url: '/parts/libraries/lib/ok.xml' })).statusCode).toBe(200);
      for (const url of ['/parts/libraries/lib/.env', '/parts/libraries/lib/.hidden/config', '/parts/libraries/lib/%2eenv']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
        expect(res.body, url).not.toContain('SECRET');
      }
      await app.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('answers a server error without its internal message, but keeps 4xx messages', async () => {
    const app = Fastify({ bodyLimit: 64 });
    registerErrorHandler(app);
    app.post('/api/boom', async (req) => {
      const body = req.body as { title: unknown };
      (body.title as string).trim();
      return { ok: true };
    });
    app.post('/api/sql', async () => {
      throw new Error('SQLITE_ERROR: no such column: secret_column at /srv/app/db.ts');
    });
    const boom = await app.inject({ method: 'POST', url: '/api/boom', payload: { title: { a: 1 } } });
    expect(boom.statusCode).toBe(500);
    expect(boom.json()).toEqual({ error: 'internal' });
    const sql = await app.inject({ method: 'POST', url: '/api/sql', payload: {} });
    expect(sql.statusCode).toBe(500);
    expect(sql.body).not.toContain('SQLITE');
    expect(sql.body).not.toContain('/srv');
    const big = await app.inject({ method: 'POST', url: '/api/boom', payload: { title: 'x'.repeat(200) } });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ code: 'FST_ERR_CTP_BODY_TOO_LARGE' });
    const bad = await app.inject({
      method: 'POST',
      url: '/api/boom',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('masks link tokens and OAuth codes in logged URLs', () => {
    expect(redactUrl('/api/invites/abc123/accept')).toBe('/api/invites/[redacted]/accept');
    expect(redactUrl('/api/org-invites/tok')).toBe('/api/org-invites/[redacted]');
    expect(redactUrl('/api/transfers/tok')).toBe('/api/transfers/[redacted]');
    expect(redactUrl('/api/public-layouts/tok/snapshot')).toBe('/api/public-layouts/[redacted]/snapshot');
    expect(redactUrl('/api/auth/password/verify-email/tok')).toBe('/api/auth/password/verify-email/[redacted]');
    expect(redactUrl('/api/auth/github/callback?code=c0de&state=st4te')).toBe(
      '/api/auth/github/callback?code=[redacted]&state=[redacted]',
    );
    expect(redactUrl('/api/layouts?q=castle')).toBe('/api/layouts?q=castle');
  });
});
