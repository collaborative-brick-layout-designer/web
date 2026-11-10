// What applying an update costs (ws/yjsWork.ts) is limited on every way
// into a layout: a live update past the limit is refused like one the apps
// can't read (1008), one person's updates together are paced (1013), a
// snapshot past it is refused (400), and a stored update past it is
// skipped when the room is read back from its update log.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { layoutRoutes } from '../layouts.js';
import { moduleRoutes } from '../modules.js';
import { wsRoutes } from '../ws.js';
import { docHub } from '../../ws/docHub.js';
import { resetCopyBudgets, wsPacing } from '../../ws/pacing.js';
import { MAX_UPDATE_WORK } from '../../ws/yjsWork.js';
import { Peer } from './wsPeer.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A delete set of `client` listing [0, len) `times` times, after `structs` (bytes of an update's struct part, or none). */
function repeated(client: number, len: number, times: number, structs: Uint8Array = Uint8Array.of(0)): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeUint8Array(e, structs);
  encoding.writeVarUint(e, 1);
  encoding.writeVarUint(e, client);
  encoding.writeVarUint(e, times);
  for (let i = 0; i < times; i++) {
    encoding.writeVarUint(e, 0);
    encoding.writeVarUint(e, len);
  }
  return encoding.toUint8Array(e);
}

function updateMsg(update: Uint8Array): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 0);
  encoding.writeVarUint(e, 2);
  encoding.writeVarUint8Array(e, update);
  return encoding.toUint8Array(e);
}

describe('the work an update takes to apply', () => {
  let app: FastifyInstance;
  let port: number;
  let owner: { cookie: string; id: string };
  const opened: string[] = [];

  beforeEach(async () => {
    resetDb();
    resetCopyBudgets();
    app = Fastify({ logger: false });
    await app.register(cookie);
    app.addHook('preHandler', attachUser);
    await app.register(passwordRoutes);
    await app.register(layoutRoutes);
    await app.register(moduleRoutes);
    await app.register(wsRoutes);
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
    owner = await loginAs(app, 'work@x.com');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetCopyBudgets();
    for (const id of opened.splice(0)) await docHub.close(id);
    await app.close();
  });

  async function fordyce(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { cookie: owner.cookie },
      payload: { title: 'Fordyce', bbm: readFileSync(join(FIXTURES, 'fordyce-2026.bbm'), 'utf8') },
    });
    const id = res.json().id as string;
    opened.push(id);
    return id;
  }

  /** The room's busiest client: its id and how many clocks it has. */
  async function busiest(id: string): Promise<{ client: number; len: number; structs: number }> {
    const peer = new Peer(port, id, owner.cookie, new Y.Doc());
    await peer.synced;
    const doc = docHub.peek(id)!.doc;
    const [client, list] = [...doc.store.clients.entries()].sort((a, b) => b[1].length - a[1].length)[0]!;
    await peer.leave();
    return { client, len: Y.getState(doc.store, client), structs: list.length };
  }

  async function raw(id: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/layout/${id}`, { headers: { cookie: owner.cookie } });
    ws.on('error', () => {});
    const closed = new Promise<[number, string]>((r) => ws.once('close', (c, why) => r([c, why.toString()])));
    await new Promise<void>((r) => ws.once('message', () => r()));
    return { ws, closed };
  }

  it('past the limit, refuses it like one the apps can’t read, and leaves the layout as it was', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = await fordyce();
    const { client, len, structs } = await busiest(id);
    const before = Y.encodeStateVector(docHub.peek(id)!.doc);
    const peer = await raw(id);
    const times = Math.ceil((2 * MAX_UPDATE_WORK) / structs);
    const started = performance.now();
    peer.ws.send(updateMsg(repeated(client, len, times)));
    expect(await peer.closed).toEqual([1008, 'unreadable_update']);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(Y.encodeStateVector(docHub.peek(id)!.doc)).toEqual(before);
    expect([...docHub.peek(id)!.doc.store.clients.get(client)!].some((s) => s.deleted)).toBe(false);
  });

  it('within the limit each, slows down a person whose updates together take too much', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = { burst: wsPacing.workBurst, rate: wsPacing.workPerSecond };
    wsPacing.workBurst = 200;
    wsPacing.workPerSecond = 0;
    resetCopyBudgets();
    try {
      const id = await fordyce();
      const peer = await raw(id);
      const d = new Y.Doc();
      Y.applyUpdate(d, Y.encodeStateAsUpdate(docHub.peek(id)!.doc));
      for (let i = 0; i < 400 && peer.ws.readyState === WebSocket.OPEN; i++) {
        const sv = Y.encodeStateVector(d);
        d.getMap('meta').set('comment', `edit ${i}`);
        peer.ws.send(updateMsg(Y.encodeStateAsUpdate(d, sv)));
        await sleep(2);
      }
      expect(await Promise.race([peer.closed, sleep(5000).then(() => 'open' as const)])).toEqual([1013, 'slow_down']);
    } finally {
      wsPacing.workBurst = saved.burst;
      wsPacing.workPerSecond = saved.rate;
    }
  });

  it('a snapshot past the limit is refused', async () => {
    const id = await fordyce();
    const { client, len, structs } = await busiest(id);
    const whole = Y.encodeStateAsUpdate(docHub.peek(id)?.doc ?? new Y.Doc());
    expect(whole.at(-1)).toBe(0); // no deletions: a delete set goes in its place
    const heavy = repeated(client, len, Math.ceil((2 * MAX_UPDATE_WORK) / structs), whole.slice(0, -1));
    const put = (url: string) => app.inject({ method: 'PUT', url, headers: { cookie: owner.cookie, 'content-type': 'application/octet-stream' }, payload: Buffer.from(heavy) });
    const mod = await app.inject({ method: 'POST', url: '/api/modules', headers: { cookie: owner.cookie }, payload: { title: 'Siding' } });
    expect((await put(`/api/modules/${mod.json().id}/snapshot`)).json()).toEqual({ error: 'unreadable_snapshot' });
    // The same document without them is taken.
    const ok = await app.inject({ method: 'PUT', url: `/api/modules/${mod.json().id}/snapshot`, headers: { cookie: owner.cookie, 'content-type': 'application/octet-stream' }, payload: Buffer.from(whole) });
    expect(ok.statusCode).toBe(200);
  });

  it('a stored update past the limit is skipped, and logged, when the room is read back', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = await fordyce();
    const { client, len, structs } = await busiest(id);
    await docHub.close(id);
    db.insert(schema.layoutUpdates)
      .values({ layoutId: id, doc: 'main', updateBytes: Buffer.from(repeated(client, len, Math.ceil((40 * MAX_UPDATE_WORK) / structs))), createdAt: new Date() })
      .run();
    const started = performance.now();
    const peer = new Peer(port, id, owner.cookie, new Y.Doc());
    await peer.synced;
    expect(performance.now() - started).toBeLessThan(3000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped a stored update'));
    expect(peer.doc.getArray('layers').length).toBeGreaterThan(0);
    await peer.leave();
  });
});
