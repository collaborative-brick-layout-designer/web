// Pacing on the live route (ws/pacing.ts), and stored edits in batches:
//   - what the apps send stays well inside the limits: a first sync of a
//     large layout, a paste of 1000 parts, nudging 1000 selected parts with
//     a held arrow key while presence goes out 20 times a second, and an
//     offline session sent on reconnect (the numbers are logged);
//   - a burst of edits is stored as a few rows, not one each;
//   - past the limit the connection closes with 1013 slow_down, what was
//     taken is applied whole, and the reconnect brings the rest;
//   - requests for the whole layout (sync step 1) are answered a few times
//     per connection, then at most every step1EveryMs.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { layoutRoutes } from '../layouts.js';
import { wsRoutes } from '../ws.js';
import { docHub } from '../../ws/docHub.js';
import { wsPacing } from '../../ws/pacing.js';
import { Peer } from './wsPeer.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const defaults = { ...wsPacing };

function awarenessMsg(clientID: number, clock: number, state: unknown): Uint8Array {
  const inner = encoding.createEncoder();
  encoding.writeVarUint(inner, 1);
  encoding.writeVarUint(inner, clientID);
  encoding.writeVarUint(inner, clock);
  encoding.writeVarString(inner, JSON.stringify(state));
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 1);
  encoding.writeVarUint8Array(enc, encoding.toUint8Array(inner));
  return encoding.toUint8Array(enc);
}

/** Messages and bytes in the busiest second of a list of [ms, bytes]. */
function busiest(sent: [number, number][]): { messages: number; bytes: number } {
  let messages = 0;
  let bytes = 0;
  for (let i = 0, j = 0, b = 0; i < sent.length; i++) {
    b += sent[i]![1];
    while (sent[i]![0] - sent[j]![0] >= 1000) b -= sent[j++]![1];
    messages = Math.max(messages, i - j + 1);
    bytes = Math.max(bytes, b);
  }
  return { messages, bytes };
}

describe('WS pacing', () => {
  let app: FastifyInstance;
  let port: number;
  let owner: { cookie: string; id: string };
  const opened: string[] = [];

  beforeEach(async () => {
    resetDb();
    Object.assign(wsPacing, defaults);
    app = Fastify({ logger: false });
    await app.register(cookie);
    app.addHook('preHandler', attachUser);
    await app.register(passwordRoutes);
    await app.register(layoutRoutes);
    await app.register(wsRoutes);
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
    owner = await loginAs(app, 'owner@x.com');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    Object.assign(wsPacing, defaults);
    for (const id of opened.splice(0)) await docHub.close(id);
    await app.close();
  });

  async function layout(payload: Record<string, unknown> = { title: 't' }): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: owner.cookie }, payload });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    opened.push(id);
    return id;
  }

  const rows = (id: string) => db.select().from(schema.layoutUpdates).where(eq(schema.layoutUpdates.layoutId, id)).all().length;
  const brickArray = (doc: Y.Doc) =>
    [...doc.getMap<Y.Map<unknown>>('layerData').values()]
      .map((l) => l.get('bricks'))
      .filter((b): b is Y.Array<Y.Map<unknown>> => b instanceof Y.Array)
      .sort((a, b) => b.length - a.length)[0]!;

  it('what the apps send stays inside the limits, and a burst of edits is stored as a few rows', { timeout: 60_000 }, async () => {
    const id = await layout({ title: 'Fordyce', bbm: readFileSync(join(FIXTURES, 'fordyce-2026.bbm'), 'utf8') });
    const doc = new Y.Doc();
    const peer = new Peer(port, id, owner.cookie, doc);
    const sent: [number, number][] = [];
    const origSend = peer.ws.send.bind(peer.ws);
    peer.ws.send = ((data: Uint8Array, ...rest: unknown[]) => {
      sent.push([performance.now(), data.length]);
      return (origSend as (d: Uint8Array, ...r: unknown[]) => void)(data, ...rest);
    }) as typeof peer.ws.send;
    await peer.synced;
    const bricks = brickArray(doc);
    // A paste of 1000 parts.
    doc.transact(() => {
      const pasted: Y.Map<unknown>[] = [];
      for (let i = 0; i < 1000; i++) {
        const y = new Y.Map<unknown>();
        y.set('id', String(9_000_000_000 + i));
        y.set('displayArea', { x: i, y: i, width: 8, height: 8 });
        y.set('partNumber', '3001.1');
        y.set('orientation', 0);
        y.set('connexions', []);
        pasted.push(y);
      }
      bricks.push(pasted);
    });
    // Nudging all 1000 pasted parts with a held arrow key (30 a second) for
    // 3 s, with presence 20 times a second (the selection in it).
    const selected = Array.from({ length: 1000 }, (_, i) => String(9_000_000_000 + i));
    const start = performance.now();
    let clock = 1;
    let nextPresence = start;
    for (let step = 0; performance.now() - start < 3000; step++) {
      doc.transact(() => {
        for (let i = bricks.length - 1000; i < bricks.length; i++) bricks.get(i).set('displayArea', { x: step, y: i, width: 8, height: 8 });
      });
      if (performance.now() >= nextPresence) {
        peer.ws.send(awarenessMsg(doc.clientID, clock++, { user: { id: owner.id, displayName: 'Owner' }, cursor: { x: step, y: 0 }, selection: { brickIds: selected }, lastActivityMs: Date.now() }));
        nextPresence += 50;
      }
      await sleep(33);
    }
    // 500 offline edits, sent on reconnect.
    await peer.leave();
    for (let i = 0; i < 500; i++) bricks.get(i % bricks.length).set('orientation', i % 360);
    const back = new Peer(port, id, owner.cookie, doc);
    await back.synced;
    await sleep(200);
    expect(back.ws.readyState).toBe(WebSocket.OPEN);
    expect(Y.encodeStateVector(docHub.peek(id)!.doc)).toEqual(Y.encodeStateVector(doc));
    const peak = busiest(sent);
    const largest = Math.max(...sent.map((s) => s[1]), back.largestStep2());
    console.log(
      `[measure] busiest second: ${peak.messages} messages, ${peak.bytes} bytes; largest message ${largest} bytes; ` +
        `${sent.length} messages in ${((performance.now() - start) / 1000).toFixed(1)} s`,
    );
    expect(peak.messages * 4).toBeLessThan(wsPacing.messagesPerSecond);
    expect(peak.bytes * 2).toBeLessThan(wsPacing.bytesPerSecond);
    await back.leave();

    // A burst: 900 edits at once (inside the burst) are all applied, in a few rows.
    const before = rows(id);
    const burst = new Peer(port, id, owner.cookie, doc);
    await burst.synced;
    await sleep(100);
    const r0 = rows(id);
    for (let i = 0; i < 900; i++) doc.getMap('meta').set('k', i);
    for (let i = 0; i < 100 && docHub.peek(id)!.doc.getMap('meta').get('k') !== 899; i++) await sleep(20);
    await sleep(150);
    expect(docHub.peek(id)!.doc.getMap('meta').get('k')).toBe(899);
    expect(burst.ws.readyState).toBe(WebSocket.OPEN);
    console.log(`[measure] 900 edits in a burst stored as ${rows(id) - r0} rows`);
    expect(rows(id) - r0).toBeLessThan(20);
    expect(rows(id)).toBeGreaterThan(before - 1);
    await burst.leave();
  });

  it('closes a connection sending past the limit with 1013, keeps what it took whole, and the reconnect brings the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    wsPacing.messageBurst = 50;
    wsPacing.messagesPerSecond = 5;
    const id = await layout();
    const doc = new Y.Doc();
    const peer = new Peer(port, id, owner.cookie, doc);
    await peer.synced;
    for (let i = 0; i < 200; i++) doc.getMap('meta').set(`k${i}`, i);
    expect(await peer.closed).toEqual([1013, 'slow_down']);
    const room = docHub.peek(id)!.doc.getMap('meta');
    const taken = [...room.keys()].filter((k) => k.startsWith('k')).length;
    expect(taken).toBeGreaterThan(0);
    expect(taken).toBeLessThan(200);
    // Applied in order and whole: k0..k(taken-1).
    for (let i = 0; i < taken; i++) expect(room.get(`k${i}`)).toBe(i);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('faster than allowed'))).toHaveLength(1);
    // Reconnecting, its step 2 brings the rest.
    Object.assign(wsPacing, defaults);
    const again = new Peer(port, id, owner.cookie, doc);
    await again.synced;
    await vi.waitFor(() => expect(Y.encodeStateVector(docHub.peek(id)!.doc)).toEqual(Y.encodeStateVector(doc)));
    expect(room.get('k199')).toBe(199);
    await again.leave();
  });

  it('closes a connection sending more bytes than the limit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    wsPacing.byteBurst = 64 * 1024;
    wsPacing.bytesPerSecond = 1024;
    const id = await layout();
    const doc = new Y.Doc();
    const peer = new Peer(port, id, owner.cookie, doc);
    await peer.synced;
    for (let i = 0; i < 10; i++) doc.getMap('meta').set(`big${i}`, 'b'.repeat(20 * 1024));
    expect(await peer.closed).toEqual([1013, 'slow_down']);
  });

  it('answers a few requests for the whole layout per connection, then at most one every step1EveryMs', async () => {
    const id = await layout();
    const ed = new Peer(port, id, owner.cookie, new Y.Doc());
    await ed.synced;
    ed.doc.getMap('m').set('big', 'y'.repeat(512 * 1024));
    await sleep(200);
    const viewer = await loginAs(app, 'viewer@x.com');
    await db.insert(schema.layoutCollaborators).values({ layoutId: id, userId: viewer.id, role: 'viewer', addedAt: new Date() });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/layout/${id}`, { headers: { cookie: viewer.cookie } });
    const step2s: number[] = [];
    ws.on('message', (d: Buffer) => {
      const dec = decoding.createDecoder(new Uint8Array(d));
      if (decoding.readVarUint(dec) === 0 && decoding.readVarUint(dec) === syncProtocol.messageYjsSyncStep2) step2s.push(d.length);
    });
    await new Promise((r) => ws.once('open', r));
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeSyncStep1(enc, new Y.Doc());
    const req = encoding.toUint8Array(enc);
    for (let i = 0; i < 50; i++) ws.send(req);
    await sleep(800);
    expect(step2s.length).toBe(wsPacing.step1Burst);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    await ed.leave();
  });
});
