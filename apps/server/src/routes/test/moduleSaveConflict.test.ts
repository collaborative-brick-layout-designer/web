// Area 2 Bug 1: two saves of one module never silently overwrite each
// other. A save names the version it started from (If-Match); someone
// else's save since then answers 409 module_changed and writes nothing.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createDefaultLayoutDoc, encodeDoc } from '@cld/ydoc';
import { loginAs, resetDb } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { moduleRoutes, baseVersion } from '../modules.js';

let app: FastifyInstance;
let ada: { cookie: string; id: string };

beforeEach(async () => {
  resetDb();
  app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  await app.register(passwordRoutes);
  await app.register(moduleRoutes);
  ada = await loginAs(app, 'ada@example.com');
});
afterEach(async () => {
  await app.close();
});

function contents(note: string): Buffer {
  const d = createDefaultLayoutDoc();
  d.getMap('meta').set('testNote', note);
  return Buffer.from(encodeDoc(d));
}

const put = (id: string, bytes: Buffer, ifMatch?: string) =>
  app.inject({
    method: 'PUT',
    url: `/api/modules/${id}/snapshot`,
    headers: { cookie: ada.cookie, 'content-type': 'application/octet-stream', ...(ifMatch !== undefined ? { 'if-match': ifMatch } : {}) },
    payload: bytes,
  });

async function current(id: string): Promise<{ note: unknown; version: number }> {
  const res = await app.inject({ method: 'GET', url: `/api/modules/${id}/snapshot`, headers: { cookie: ada.cookie } });
  const d = new Y.Doc();
  Y.applyUpdate(d, new Uint8Array(res.rawPayload));
  return { note: d.getMap('meta').get('testNote'), version: Number(res.headers['x-doc-version']) };
}

describe('module saves', () => {
  it('the second of two saves from the same start is refused, and the first is kept', async () => {
    const { id } = (await app.inject({ method: 'POST', url: '/api/modules', headers: { cookie: ada.cookie }, payload: { title: 'Station' } })).json() as { id: string };
    const start = (await current(id)).version;
    // Two editors opened it at `start`.
    const first = await put(id, contents('A'), `"${start}"`);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ docVersion: start + 1 });
    const second = await put(id, contents('B'), `"${start}"`);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'module_changed', docVersion: start + 1 });
    expect(await current(id)).toEqual({ note: 'A', version: start + 1 });
    // "Save mine as a new version": no If-Match, saved over it.
    expect((await put(id, contents('B'))).statusCode).toBe(200);
    expect(await current(id)).toEqual({ note: 'B', version: start + 2 });
    // From the newest version, a save goes through.
    expect((await put(id, contents('C'), `W/"${start + 2}"`)).statusCode).toBe(200);
  });

  it('a bad If-Match is refused', async () => {
    const { id } = (await app.inject({ method: 'POST', url: '/api/modules', headers: { cookie: ada.cookie }, payload: { title: 'Yard' } })).json() as { id: string };
    expect((await put(id, contents('A'), 'nonsense')).statusCode).toBe(400);
  });

  it('reads If-Match the ways a client sends it', () => {
    expect(baseVersion(undefined)).toBeNull();
    expect(baseVersion('*')).toBeNull();
    expect(baseVersion('"3"')).toBe(3);
    expect(baseVersion('W/"3"')).toBe(3);
    expect(baseVersion('3')).toBe(3);
    expect(baseVersion('abc')).toBe('bad');
  });
});
