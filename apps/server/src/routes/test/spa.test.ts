// The web app's files and the page for every other address (routes/spa.ts).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerSpa } from '../spa.js';

const INDEX = '<!doctype html><title>app</title>';
let dir: string;
let app: FastifyInstance;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cld-spa-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), INDEX);
  writeFileSync(join(dir, 'sw.js'), '// worker');
  writeFileSync(join(dir, 'manifest.webmanifest'), '{}');
  writeFileSync(join(dir, 'assets/index-abc.js'), 'export {}');
  writeFileSync(join(dir, 'assets/index-abc.css'), 'a{}');
  app = Fastify();
  await registerSpa(app, dir, INDEX);
});
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the web app', () => {
  it('serves its files, the service worker and the manifest', async () => {
    for (const [url, type] of [
      ['/assets/index-abc.js', 'application/javascript'],
      ['/assets/index-abc.css', 'text/css'],
      ['/sw.js', 'application/javascript'],
      ['/manifest.webmanifest', 'application/manifest+json'],
    ] as const) {
      const res = await app.inject(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type'], url).toContain(type);
    }
  });

  it('opens the page at every address of the app', async () => {
    for (const url of ['/', '/library', '/orgs/some-club', '/layouts/52155445', '/library?tab=assets', '/assets-report']) {
      const res = await app.inject(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toBe(INDEX);
    }
    expect((await app.inject('/library')).headers['cache-control']).toBe('no-cache');
  });

  it('answers 404, not the page, for a built file that is not there', async () => {
    for (const url of ['/assets/index-old.js', '/assets/index-old.css', '/assets/index-old.js?v=1', '/assets/deep/x.png']) {
      const res = await app.inject(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type'], url).toContain('text/plain');
      expect(res.headers['cache-control'], url).toBe('no-store');
      expect(res.body).not.toContain('<!doctype');
    }
    expect((await app.inject('/api/nothing')).json()).toEqual({ error: 'not_found' });
  });
});
