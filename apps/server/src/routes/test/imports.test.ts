// Importing LDraw, Studio and LDD files (routes/imports.ts, imports/):
// the whole route flow against a stand-in converter that behaves like the
// desktop's bld-import-server (desktop docs/import-server.md), plus the
// limits: size, rate, concurrency, timeout, crash, a missing / old /
// unsandboxed converter, an empty environment, files deleted every time.
// The real converter runs in importReal.test.ts (opt-in) and in the
// desktop repo's ImportServerTest.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bufConcat, db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { layoutRoutes } from '../layouts.js';
import { importRoutes, safeModelName } from '../imports.js';
import { env } from '../../env.js';
import { forgetConverterState, runConverter } from '../../imports/converter.js';
import { clearJobsAtStart, getJob, resetJobs, sweep, IDLE_MS } from '../../imports/jobs.js';
import { jobsDir, librariesDir, setLibraryFetcher, unwrapLdrawXmlP } from '../../imports/libraries.js';
import { invalidateImportSettings } from '../../imports/settings.js';
import { docHub } from '../../ws/docHub.js';

const tmp = mkdtempSync(join(tmpdir(), 'cld-import-'));
const BBM = new URL('../../../../../packages/bbm/tests/fixtures/tight-corner.bbm', import.meta.url).pathname;

/**
 * A stand-in converter: a Node script with the real one's command line and
 * JSON. What it does depends on the uploaded file's name: "slow" never
 * finishes, "crash" dies without a word, "flood" prints too much. It
 * reports its environment and arguments so the tests can check the lock-down.
 */
function fakeConverter(name: string, opts: { version?: string; sandbox?: Record<string, boolean> } = {}): string {
  const path = join(tmp, name);
  const sandbox = JSON.stringify(opts.sandbox ?? { rlimits: true, noNewPrivs: true, netns: false, seccomp: true, socketBlocked: true, execBlocked: true, forkBlocked: true });
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require('fs'), p = require('path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('bld-import-server ${opts.version ?? '2.1.11'}'); process.exit(0); }
if (args[0] === '--sandbox-check') { console.log(JSON.stringify({ ok: true, sandbox: ${sandbox} })); process.exit(0); }
const req = JSON.parse(fs.readFileSync(args[args.length - 1], 'utf8'));
const base = p.basename(req.input);
if (base.includes('slow')) setInterval(() => {}, 1000);
else if (base.includes('crash')) process.exit(139);
else if (base.includes('flood')) { process.stdout.write('x'.repeat(5 * 1024 * 1024)); process.exit(0); }
else {
  const out = { ok: true, version: '2.1.11', env: Object.keys(process.env).sort(), args, cwd: process.cwd(), sandbox: ${sandbox} };
  const ldr = /\\.(ldr|mpd)$/i.test(base);
  if (req.command === 'analyse') {
    fs.writeFileSync(p.join(req.outDir, 'preview.png'), Buffer.from('89504e470d0a1a0a0000', 'hex'));
    Object.assign(out, { format: base.endsWith('.io') ? 'studio' : 'ldraw', kindLabel: 'LDraw import', title: 'Two straights', designer: 'Robin',
      suggestedName: 'Two straights', partKey: 'Two_straights',
      part: { widthStuds: 8, heightStuds: 2, pxPerStud: 8, contentStuds: { x: 0, y: 0, width: 8, height: 2 }, baseOnGrid: true,
        snapMargin: { left: 0, top: 0, right: 0, bottom: 0 }, connections: [{ type: '1', x: -4, y: 0, angle: 180 }, { type: '1', x: 4, y: 0, angle: 0 }],
        stats: { ldrawResolved: 2, lddRendered: 0, unresolved: 1 }, warnings: ['1 part(s) aren’t in your LDraw library'], sprite: 'preview.png' } });
    if (ldr) out.layout = { sheets: 4, bricks: 300, warnings: [], partlyRead: false };
  } else if (req.options.mode === 'parts') {
    fs.copyFileSync(${JSON.stringify(BBM)}, p.join(req.outDir, 'layout.bbm'));
    Object.assign(out, { mode: 'parts', bbm: 'layout.bbm', sheets: 4, bricks: 300, warnings: [] });
  } else {
    fs.mkdirSync(p.join(req.outDir, 'part'), { recursive: true });
    const key = (req.options.name || 'Two straights').replace(/[^A-Za-z0-9]+/g, '_');
    fs.writeFileSync(p.join(req.outDir, 'part', key + '.xml'), '<part><Author>Sam</Author><Description><en>' + (req.options.name || 'Two straights') + '</en></Description><ImportSource><SourcePath>' + req.input + '</SourcePath></ImportSource></part>');
    fs.writeFileSync(p.join(req.outDir, 'part', key + '.gif'), Buffer.from('474946383961010001000000002c00000000010001000002', 'hex'));
    Object.assign(out, { mode: 'part', partKey: key, displayName: req.options.name || 'Two straights', xml: 'part/' + key + '.xml', sprite: 'part/' + key + '.gif',
      spriteMime: 'image/gif', widthStuds: 8, heightStuds: 2, connections: 2 - (req.options.drop || []).length, stats: { ldrawResolved: 2, lddRendered: 0, unresolved: 1 }, warnings: [] });
  }
  fs.writeFileSync(p.join(p.dirname(req.outDir), 'seen.json'), JSON.stringify(out));
  console.log(JSON.stringify(out));
}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function multipart(bytes: Buffer, filename: string): { body: Buffer; contentType: string } {
  const boundary = '----ImportBoundary' + Math.random().toString(36).slice(2);
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  return { body: bufConcat([Buffer.from(header), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]), contentType: `multipart/form-data; boundary=${boundary}` };
}

const LDR = Buffer.from('0 Two straights\n0 Author: Robin\n1 7 0 0 0 1 0 0 0 1 0 0 0 1 tt.dat\n1 7 80 0 0 1 0 0 0 1 0 0 0 1 tt.dat\n');

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(fastifyMultipart);
  app.addHook('preHandler', attachUser);
  await app.register(passwordRoutes);
  await app.register(layoutRoutes);
  await app.register(importRoutes);
  return app;
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('model import', () => {
  let app: FastifyInstance;
  let c: string;
  let userId: string;
  const savedConverter = env.importConverter;

  beforeAll(() => {
    env.importConverter = fakeConverter('good');
  });
  afterAll(() => {
    env.importConverter = savedConverter;
  });

  beforeEach(async () => {
    resetDb();
    resetJobs();
    await clearJobsAtStart();
    invalidateImportSettings();
    forgetConverterState();
    env.importConverter = fakeConverter('good');
    app = await buildApp();
    ({ cookie: c, id: userId } = await loginAs(app, 'importer@x.com'));
  });
  afterEach(async () => {
    resetJobs();
    await docHub.flushAll().catch(() => undefined);
    await app.close();
  });

  async function upload(bytes: Buffer, name: string, who = c) {
    const { body, contentType } = multipart(bytes, name);
    return app.inject({ method: 'POST', url: '/api/imports', headers: { cookie: who, 'content-type': contentType }, payload: body });
  }
  const job = (id: string, who = c) => app.inject({ method: 'GET', url: `/api/imports/${id}`, headers: { cookie: who } });
  const settle = (id: string, states: string[]) => until(async () => (await job(id)).json(), (j) => states.includes(j.state));

  async function admin(): Promise<string> {
    const a = await loginAs(app, 'admin@x.com');
    await db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.id, a.id));
    return a.cookie;
  }

  it('says what it can do, and that it can', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/imports/status', headers: { cookie: c } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ available: true, reason: null, extensions: ['ldr', 'mpd', 'dat', 'io', 'lxf', 'lxfml'], maxUploadBytes: 64 * 1024 * 1024 });
  });

  it('a missing, old or unlocked converter turns import off, and says why', async () => {
    for (const [conv, reason] of [
      [join(tmp, 'nowhere'), 'missing'],
      [fakeConverter('old', { version: '2.1.10' }), 'too_old'],
      [fakeConverter('open', { sandbox: { rlimits: true, socketBlocked: false, execBlocked: true, forkBlocked: true } }), 'unsandboxed'],
    ] as const) {
      env.importConverter = conv;
      forgetConverterState();
      const s = (await app.inject({ method: 'GET', url: '/api/imports/status', headers: { cookie: c } })).json();
      expect(s).toMatchObject({ available: false, reason });
      expect(s.message).toBeTruthy();
      const up = await upload(LDR, 'loop.ldr');
      expect(up.statusCode).toBe(409);
      expect(up.json()).toMatchObject({ error: 'import_unavailable', reason });
    }
  });

  it('previews, then makes the part and a new layout with it, and deletes the files', async () => {
    const up = await upload(LDR, 'loop.ldr');
    expect(up.statusCode).toBe(202);
    const id = up.json().id as string;
    const ready = await settle(id, ['ready', 'failed']);
    expect(ready.state).toBe('ready');
    expect(ready.analysis).toMatchObject({ format: 'ldraw', suggestedName: 'Two straights', designer: 'Robin', layout: { bricks: 300 } });
    expect(ready.analysis.part).toMatchObject({ widthStuds: 8, heightStuds: 2, preview: `/api/imports/${id}/preview.png` });
    // Nothing about where the server keeps it.
    expect(JSON.stringify(ready)).not.toContain(jobsDir());
    const pic = await app.inject({ method: 'GET', url: `/api/imports/${id}/preview.png`, headers: { cookie: c } });
    expect(pic.statusCode).toBe(200);
    expect(pic.headers['content-type']).toBe('image/png');

    // The converter ran as the server runs it: empty environment, limits, its own folder.
    const seen = JSON.parse(readFileSync(join(jobsDir(), id, 'seen.json'), 'utf8'));
    expect(seen.env).toEqual(['HOME', 'QT_QPA_PLATFORM', 'TMPDIR']);
    expect(seen.args.slice(0, 8)).toEqual(['--cpu', '180', '--memory-mb', '4096', '--file-size-mb', '256', '--open-files', '256']);
    expect(seen.cwd).toBe(join(jobsDir(), id));

    const conv = await app.inject({
      method: 'POST',
      url: `/api/imports/${id}/convert`,
      headers: { cookie: c },
      payload: { mode: 'part', quarterTurns: 1, align: 'box', nudge: [0.25, 0], drop: [0], name: 'Loop', category: 'Track', target: { kind: 'new' } },
    });
    expect(conv.statusCode).toBe(202);
    const done = await settle(id, ['done', 'failed']);
    expect(done.state).toBe('done');
    expect(done.result).toMatchObject({ mode: 'part', newLayout: true, placed: 1, part: { partNumber: 'Loop', displayName: 'Loop' } });
    const part = await db.select().from(schema.customParts).where(eq(schema.customParts.id, done.result.part.id)).get();
    expect(part).toMatchObject({ ownerUserId: userId, category: 'Track', spriteMime: 'image/gif' });
    // The server's folder never reaches the stored part.
    expect(Buffer.from(part!.xmlBlob as Uint8Array).toString()).not.toContain('ImportSource');
    const layout = await db.select().from(schema.layouts).where(eq(schema.layouts.id, done.result.layoutId)).get();
    expect(layout).toMatchObject({ ownerUserId: userId, title: 'Loop' });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(layout!.docSnapshot as Uint8Array));
    const sheet = doc.getMap('layerData').get('brick-1') as Y.Map<unknown>;
    const bricks = (sheet.get('bricks') as Y.Array<Y.Map<unknown>>).toArray();
    expect(bricks.map((b) => b.get('partNumber'))).toEqual([`custom:${part!.id}`]);
    expect(existsSync(join(jobsDir(), id))).toBe(false);
  });

  it('a second import of the same name keeps both, as the desktop does', async () => {
    for (const expected of ['Loop', 'Loop-2']) {
      const id = (await upload(LDR, 'loop.ldr')).json().id as string;
      await settle(id, ['ready']);
      await app.inject({ method: 'POST', url: `/api/imports/${id}/convert`, headers: { cookie: c }, payload: { name: 'Loop', target: { kind: 'new' } } });
      expect((await settle(id, ['done', 'failed'])).result.part.partNumber).toBe(expected);
    }
  });

  it('places the parts of an .ldr in a new layout, or in an open one as the server’s change', async () => {
    const id = (await upload(LDR, 'yard.mpd')).json().id as string;
    await settle(id, ['ready']);
    await app.inject({ method: 'POST', url: `/api/imports/${id}/convert`, headers: { cookie: c }, payload: { mode: 'parts', target: { kind: 'new', title: 'Yard' } } });
    const done = await settle(id, ['done', 'failed']);
    expect(done.result).toMatchObject({ mode: 'parts', newLayout: true });
    expect(done.result.placed).toBeGreaterThan(0);
    expect((await db.select().from(schema.layouts).where(eq(schema.layouts.id, done.result.layoutId)).get())?.title).toBe('Yard');

    const host = (await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: c }, payload: { title: 'Host' } })).json().id as string;
    const id2 = (await upload(LDR, 'yard.mpd')).json().id as string;
    await settle(id2, ['ready']);
    await app.inject({ method: 'POST', url: `/api/imports/${id2}/convert`, headers: { cookie: c }, payload: { mode: 'parts', target: { kind: 'layout', layoutId: host, sheetId: 'brick-1', at: { x: 100, y: 50 } } } });
    const into = await settle(id2, ['done', 'failed']);
    expect(into.result).toMatchObject({ mode: 'parts', newLayout: false, layoutId: host, sheetId: 'brick-1' });
    const session = await docHub.getOrCreate(host);
    const bricks = ((session.doc.getMap('layerData').get('brick-1') as Y.Map<unknown>).get('bricks') as Y.Array<Y.Map<unknown>>).toArray();
    expect(bricks.length).toBe(into.result.placed);
    expect(new Set(bricks.map((b) => b.get('id')))).toEqual(new Set(into.result.brickIds));
  });

  it('only into a layout the person may edit', async () => {
    const other = await loginAs(app, 'other@x.com');
    const theirs = (await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: other.cookie }, payload: {} })).json().id as string;
    const id = (await upload(LDR, 'loop.ldr')).json().id as string;
    await settle(id, ['ready']);
    const res = await app.inject({ method: 'POST', url: `/api/imports/${id}/convert`, headers: { cookie: c }, payload: { target: { kind: 'layout', layoutId: theirs } } });
    expect(res.statusCode).toBe(403);
    // Nobody else sees the job either.
    expect((await job(id, other.cookie)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/imports/${id}/preview.png`, headers: { cookie: other.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/imports/${id}`, headers: { cookie: other.cookie } })).statusCode).toBe(404);
  });

  it('refuses other file types, and keeps an upload’s name inside its folder', async () => {
    expect((await upload(LDR, 'evil.exe')).statusCode).toBe(415);
    expect((await upload(Buffer.alloc(0), 'empty.ldr')).statusCode).toBe(400);
    expect(safeModelName('../../etc/passwd.ldr')).toBe('passwd.ldr');
    expect(safeModelName('..\\..\\x.io')).toBe('x.io');
    expect(safeModelName('$(rm -rf).lxf')).toBe('_(rm -rf).lxf');
    expect(safeModelName('.ldr')).toBe('model.ldr');
    expect(safeModelName('a.ldr.exe')).toBeNull();
    const id = (await upload(LDR, '../../../x.ldr')).json().id as string;
    expect(getJob(id)!.input).toBe(join(jobsDir(), id, 'in', 'x.ldr'));
  });

  it('a file over the size limit is refused and leaves nothing', async () => {
    const a = await admin();
    expect((await app.inject({ method: 'PATCH', url: '/api/admin/imports', headers: { cookie: a }, payload: { limits: { maxUploadMb: 1 } } })).statusCode).toBe(200);
    const res = await upload(Buffer.alloc(1024 * 1024 + 10, 0x30), 'big.ldr');
    expect(res.statusCode).toBe(413);
    expect(readdirSync(jobsDir())).toEqual([]);
  });

  it('counts each person’s imports an hour, and how many they have open', async () => {
    const a = await admin();
    await app.inject({ method: 'PATCH', url: '/api/admin/imports', headers: { cookie: a }, payload: { limits: { perHour: 2 } } });
    const first = (await upload(LDR, 'one.ldr')).json().id as string;
    await settle(first, ['ready']);
    expect((await upload(LDR, 'two.ldr')).statusCode).toBe(202);
    const third = await upload(LDR, 'three.ldr');
    expect(third.statusCode).toBe(429);
    expect(third.json().error).toBe('import_rate_limited');
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    // Converting counts too.
    expect((await app.inject({ method: 'POST', url: `/api/imports/${first}/convert`, headers: { cookie: c }, payload: { target: { kind: 'new' } } })).statusCode).toBe(429);

    await app.inject({ method: 'PATCH', url: '/api/admin/imports', headers: { cookie: a }, payload: { limits: { perHour: 100 } } });
    expect((await upload(LDR, 'four.ldr')).statusCode).toBe(202);
    const fifth = await upload(LDR, 'five.ldr');
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json().error).toBe('too_many_open_imports');
  });

  it('runs one of a person’s files at a time and the server’s cap in all; the rest wait in line', async () => {
    const a = await admin();
    await app.inject({ method: 'PATCH', url: '/api/admin/imports', headers: { cookie: a }, payload: { limits: { atOnce: 1, timeoutSeconds: 10 } } });
    const slow = (await upload(LDR, 'slow.ldr')).json().id as string;
    await settle(slow, ['analysing']);
    const other = await loginAs(app, 'second@x.com');
    const waiting = (await upload(LDR, 'next.ldr', other.cookie)).json();
    expect(waiting).toMatchObject({ state: 'queued', position: 1 });
    // Cancelling the slow one lets the next run, and deletes its files.
    expect((await app.inject({ method: 'DELETE', url: `/api/imports/${slow}`, headers: { cookie: c } })).statusCode).toBe(204);
    expect(existsSync(join(jobsDir(), slow))).toBe(false);
    expect((await until(async () => (await job(waiting.id, other.cookie)).json(), (j) => j.state === 'ready')).state).toBe('ready');
  });

  it('stops a converter that runs too long, one that crashes, and one that says too much', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cld-import-run-'));
    writeFileSync(join(dir, 'req.json'), JSON.stringify({ command: 'analyse', input: join(dir, 'slow.ldr'), outDir: dir }));
    const t0 = Date.now();
    expect((await runConverter(join(dir, 'req.json'), dir, { timeoutSeconds: 1, memoryMb: 1024 })).kind).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(5000);
    writeFileSync(join(dir, 'req.json'), JSON.stringify({ command: 'analyse', input: join(dir, 'crash.ldr'), outDir: dir }));
    expect((await runConverter(join(dir, 'req.json'), dir, { timeoutSeconds: 10, memoryMb: 1024 })).kind).toBe('crashed');
    writeFileSync(join(dir, 'req.json'), JSON.stringify({ command: 'analyse', input: join(dir, 'flood.ldr'), outDir: dir }));
    expect((await runConverter(join(dir, 'req.json'), dir, { timeoutSeconds: 10, memoryMb: 1024 })).kind).toBe('crashed');

    // Through the routes: the person is told, and the files go.
    const id = (await upload(LDR, 'crash.ldr')).json().id as string;
    const failed = await settle(id, ['failed']);
    expect(failed.error.code).toBe('crashed');
    expect(existsSync(join(jobsDir(), id))).toBe(false);
  });

  it('leaves nothing behind: at start, after a while, and when cancelled', async () => {
    const id = (await upload(LDR, 'loop.ldr')).json().id as string;
    await settle(id, ['ready']);
    expect(existsSync(join(jobsDir(), id))).toBe(true);
    await sweep(Date.now() + IDLE_MS + 1000);
    expect(existsSync(join(jobsDir(), id))).toBe(false);
    expect((await job(id)).statusCode).toBe(404);
    writeFileSync(join(jobsDir(), 'left-by-a-crash'), 'x');
    await clearJobsAtStart();
    expect(existsSync(jobsDir())).toBe(false);
  });

  describe('Admin › Model import', () => {
    it('is for site admins only', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/admin/imports', headers: { cookie: c } })).statusCode).toBe(403);
    });

    it('switches import off and on, and keeps limits in range', async () => {
      const a = await admin();
      expect((await app.inject({ method: 'PATCH', url: '/api/admin/imports', headers: { cookie: a }, payload: { enabled: false } })).json()).toMatchObject({ enabled: false, reason: 'off' });
      expect((await upload(LDR, 'loop.ldr')).json()).toMatchObject({ error: 'import_unavailable', reason: 'off' });
      expect((await app.inject({ method: 'PATCH', url: '/api/admin/imports', headers: { cookie: a }, payload: { enabled: true, limits: { atOnce: 99 } } })).statusCode).toBe(400);
      const view = (await app.inject({ method: 'GET', url: '/api/admin/imports', headers: { cookie: a } })).json();
      expect(view).toMatchObject({ available: false, reason: 'off', enabled: false, converter: { version: '2.1.11', minimum: '2.1.11', problem: null } });
      expect(view.limits.map((l: { key: string }) => l.key)).toEqual(['maxUploadMb', 'perHour', 'perUserAtOnce', 'atOnce', 'timeoutSeconds', 'memoryMb']);
    });

    it('downloads the LDraw library on a click, and shows its version and date', async () => {
      const a = await admin();
      setLibraryFetcher(async () => ({
        ok: true,
        status: 200,
        lastModified: 'Mon, 09 Nov 2026 02:54:45 GMT',
        bytes: storedZip({ 'ldraw/LDConfig.ldr': '0 LDraw.org Configuration File\n0 !LDRAW_ORG Configuration UPDATE 2026-11-01\n', 'ldraw/parts/3001.dat': '0 Brick 2 x 4\n' }),
      }));
      const res = await app.inject({ method: 'POST', url: '/api/admin/imports/ldraw/download', headers: { cookie: a } });
      expect(res.statusCode).toBe(200);
      expect(res.json().libraries.ldraw).toMatchObject({ present: true, version: 'Configuration UPDATE 2026-11-01', date: '2026-11-09' });
      expect(existsSync(join(librariesDir(), 'ldraw', 'ldraw', 'parts', '3001.dat'))).toBe(true);
      // A zip that climbs out of its folder is refused and leaves nothing.
      setLibraryFetcher(async () => ({ ok: true, status: 200, lastModified: null, bytes: storedZip({ '../../evil.txt': 'x' }) }));
      expect((await app.inject({ method: 'POST', url: '/api/admin/imports/ldraw/download', headers: { cookie: a } })).statusCode).toBe(422);
      expect(existsSync(join(librariesDir(), '..', 'evil.txt'))).toBe(false);
      expect((await app.inject({ method: 'DELETE', url: '/api/admin/imports/ldraw', headers: { cookie: a } })).json().libraries.ldraw.present).toBe(false);
    });

    it('takes LDD’s Assets.lif and an ldraw.xml, and only those', async () => {
      const a = await admin();
      const send = (url: string, bytes: Buffer, name: string) => {
        const { body, contentType } = multipart(bytes, name);
        return app.inject({ method: 'POST', url, headers: { cookie: a, 'content-type': contentType }, payload: body });
      };
      expect((await send('/api/admin/imports/ldd/assets', Buffer.from('MZ not a lif'), 'Assets.lif')).statusCode).toBe(422);
      const ok = await send('/api/admin/imports/ldd/assets', bufConcat([Buffer.from('LIFF'), Buffer.alloc(100)]), 'Assets.lif');
      expect(ok.statusCode).toBe(200);
      expect(ok.json().libraries.ldd).toMatchObject({ present: true, bytes: 104 });
      expect(readdirSync(join(librariesDir(), 'ldd'))).toEqual(['Assets.lif']);
      const mapping = 'function ldraw_xml_p() {\n  return "<LDrawMapping>\\n" + \n  "</LDrawMapping>";\n}\n';
      expect(unwrapLdrawXmlP(mapping)).toBe('<LDrawMapping>\n</LDrawMapping>');
      expect((await send('/api/admin/imports/ldd/mapping', Buffer.from(mapping), 'ldraw.xml.p')).json().libraries.lddMapping).toMatchObject({ present: true, from: 'uploaded' });
      expect((await send('/api/admin/imports/ldd/mapping', Buffer.from('<html/>'), 'ldraw.xml')).statusCode).toBe(422);
      // The libraries live beside the database, never with the parts the site serves.
      expect(librariesDir().startsWith(env.partsDir)).toBe(false);
    });

    it('a library an env var names can’t be changed from the page', async () => {
      const a = await admin();
      const saved = env.importLdrawDir;
      env.importLdrawDir = join(tmp, 'ldraw-elsewhere');
      try {
        const view = (await app.inject({ method: 'GET', url: '/api/admin/imports', headers: { cookie: a } })).json();
        expect(view.libraries.ldraw).toMatchObject({ forcedBy: 'IMPORT_LDRAW_DIR', present: false });
        expect((await app.inject({ method: 'DELETE', url: '/api/admin/imports/ldraw', headers: { cookie: a } })).statusCode).toBe(409);
      } finally {
        env.importLdrawDir = saved;
      }
    });
  });
});

/** A zip with stored (uncompressed) entries. */
function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const n = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    locals.push(local, n, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
