// Presence (awareness) over the live route belongs to the connection that
// set it: each connection sets and removes only its own entries, always as
// the signed-in user, within a size and a count limit. A viewer's own
// presence works like anyone's.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { sessionRoutes } from '../auth/session.js';
import { layoutRoutes } from '../layouts.js';
import { wsRoutes } from '../ws.js';
import { MAX_AWARENESS_BYTES, MAX_AWARENESS_IDS, PRESENCE_AVATAR_MAX, PRESENCE_COLOR_MAX, PRESENCE_NAME_MAX, docHub } from '../../ws/docHub.js';
import { Peer } from './wsPeer.js';
import { wsPacing } from '../../ws/pacing.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Client {
  ws: WebSocket;
  msgs: Uint8Array[];
  closed: Promise<[number, string]>;
}

function connect(port: number, layoutId: string, cookieStr: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/layout/${layoutId}`, { headers: { cookie: cookieStr } });
  const msgs: Uint8Array[] = [];
  ws.on('message', (d: Buffer) => msgs.push(new Uint8Array(d)));
  ws.on('error', () => {});
  const closed = new Promise<[number, string]>((r) => ws.once('close', (c, why) => r([c, why.toString()])));
  return new Promise((res, rej) => {
    ws.once('open', () => res({ ws, msgs, closed }));
    ws.once('error', rej);
  });
}

type Entry = { clientID: number; clock: number; state: unknown };

/** A presence state of the shape the apps send, with `extra` on top. */
function pres(displayName: string, extra: Record<string, unknown> = {}, user: Record<string, unknown> = {}): Record<string, unknown> {
  return { user: { displayName, ...user }, selection: { brickIds: [] }, lastActivityMs: 1, ...extra };
}

function awarenessMsg(entries: Entry[]): Uint8Array {
  const inner = encoding.createEncoder();
  encoding.writeVarUint(inner, entries.length);
  for (const e of entries) {
    encoding.writeVarUint(inner, e.clientID);
    encoding.writeVarUint(inner, e.clock);
    encoding.writeVarString(inner, JSON.stringify(e.state));
  }
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 1);
  encoding.writeVarUint8Array(enc, encoding.toUint8Array(inner));
  return encoding.toUint8Array(enc);
}

function awarenessSeen(msgs: Uint8Array[]): Entry[] {
  const out: Entry[] = [];
  for (const m of msgs) {
    const dec = decoding.createDecoder(m);
    if (decoding.readVarUint(dec) !== 1) continue;
    const inner = decoding.createDecoder(decoding.readVarUint8Array(dec));
    const n = decoding.readVarUint(inner);
    for (let i = 0; i < n; i++) {
      out.push({ clientID: decoding.readVarUint(inner), clock: decoding.readVarUint(inner), state: JSON.parse(decoding.readVarString(inner)) });
    }
  }
  return out;
}

describe('WS presence', () => {
  let app: FastifyInstance;
  let port: number;
  let owner: { cookie: string; id: string };
  let layoutId: string;
  const open: Client[] = [];

  beforeEach(async () => {
    resetDb();
    app = Fastify({ logger: false });
    await app.register(cookie);
    app.addHook('preHandler', attachUser);
    await app.register(passwordRoutes);
    await app.register(sessionRoutes);
    await app.register(layoutRoutes);
    await app.register(wsRoutes);
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
    owner = await loginAs(app, 'owner@x.com');
    layoutId = (await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: owner.cookie }, payload: { title: 't' } })).json().id;
  });

  afterEach(async () => {
    for (const c of open.splice(0)) c.ws.terminate();
    await sleep(50);
    await docHub.close(layoutId);
    await app.close();
  });

  async function client(cookieStr = owner.cookie): Promise<Client> {
    const c = await connect(port, layoutId, cookieStr);
    open.push(c);
    return c;
  }

  async function share(email: string, role: 'viewer' | 'editor'): Promise<{ cookie: string; id: string }> {
    const u = await loginAs(app, email);
    await db.insert(schema.layoutCollaborators).values({ layoutId, userId: u.id, role, addedAt: new Date() });
    return u;
  }

  const states = () => docHub.peek(layoutId)!.awareness.getStates();

  it("a viewer's own presence reaches others, always as the signed-in viewer", async () => {
    const viewer = await share('viewer@x.com', 'viewer');
    const v = await client(viewer.cookie);
    const watcher = await client();
    await sleep(100);
    watcher.msgs.length = 0;
    v.ws.send(awarenessMsg([{ clientID: 501, clock: 1, state: pres('Vee', { cursor: { x: 1, y: 2 } }) }]));
    await sleep(100);
    const seen = awarenessSeen(watcher.msgs).filter((e) => e.clientID === 501);
    expect(seen.at(-1)?.state).toEqual(pres('viewer', { cursor: { x: 1, y: 2 } }, { id: viewer.id }));
    // A forged id is replaced too.
    v.ws.send(awarenessMsg([{ clientID: 501, clock: 2, state: pres('Vee', {}, { id: owner.id }) }]));
    await sleep(100);
    expect((states().get(501) as { user: { id: string } }).user.id).toBe(viewer.id);
    // And it goes when the viewer leaves.
    v.ws.close();
    await v.closed;
    await sleep(100);
    expect(states().has(501)).toBe(false);
  });

  it("a presence entry carries the account's own name, with its other fields kept short", async () => {
    const viewer = await share('viewer4@x.com', 'viewer');
    const v = await client(viewer.cookie);
    const watcher = await client();
    await sleep(100);
    type Shown = { user: { id: string; displayName: string; color?: unknown; avatarUrl?: unknown } };
    const shown = () => (states().get(502) as Shown).user;
    const lastSeen = () => (awarenessSeen(watcher.msgs).filter((e) => e.clientID === 502).at(-1)!.state as Shown).user;

    // Whatever name is sent, the account's is shown.
    v.ws.send(awarenessMsg([{ clientID: 502, clock: 1, state: pres('owner') }]));
    await sleep(100);
    expect(shown()).toEqual({ id: viewer.id, displayName: 'viewer4' });
    expect(lastSeen().displayName).toBe('viewer4');
    v.ws.send(awarenessMsg([{ clientID: 502, clock: 2, state: pres('n'.repeat(100_000), {}, { color: '#'.repeat(5_000), avatarUrl: `https://pics.example/${'a'.repeat(PRESENCE_AVATAR_MAX)}` }) }]));
    await sleep(100);
    expect(shown()).toEqual({ id: viewer.id, displayName: 'viewer4', color: '#'.repeat(PRESENCE_COLOR_MAX), avatarUrl: null });
    // Ordinary values pass as they are.
    v.ws.send(awarenessMsg([{ clientID: 502, clock: 3, state: pres('viewer4', {}, { color: '#60a5fa', avatarUrl: 'https://pics.example/v.png' }) }]));
    await sleep(100);
    expect(shown()).toEqual({ id: viewer.id, displayName: 'viewer4', color: '#60a5fa', avatarUrl: 'https://pics.example/v.png' });

    // A new name set in Settings shows from the next presence message, without reconnecting.
    const renamed = await app.inject({ method: 'PATCH', url: '/api/auth/me', headers: { cookie: viewer.cookie }, payload: { displayName: 'Vee' } });
    expect(renamed.statusCode, renamed.body).toBe(200);
    v.ws.send(awarenessMsg([{ clientID: 502, clock: 4, state: pres('viewer4') }]));
    await sleep(100);
    expect(shown().displayName).toBe('Vee');
    expect(lastSeen().displayName).toBe('Vee');

    // A stored name that is an address or over-long never shows as it is.
    await db.update(schema.users).set({ displayName: 'someone@example.com' }).where(eq(schema.users.id, owner.id));
    const o = await client();
    await sleep(100);
    o.ws.send(awarenessMsg([{ clientID: 503, clock: 1, state: pres('someone@example.com') }]));
    await sleep(100);
    expect((states().get(503) as Shown).user.displayName).toMatch(/^Builder #[0-9a-z]{1,6}$/);
    await db.update(schema.users).set({ displayName: 'L'.repeat(300) }).where(eq(schema.users.id, owner.id));
    const o2 = await client();
    await sleep(100);
    o2.ws.send(awarenessMsg([{ clientID: 504, clock: 1, state: pres('x') }]));
    await sleep(100);
    expect((states().get(504) as Shown).user.displayName).toBe('L'.repeat(PRESENCE_NAME_MAX));
  });

  it("another connection can't change or remove someone's presence, or take it with it when it leaves", async () => {
    const viewer = await share('viewer2@x.com', 'viewer');
    const alice = await client();
    const other = await client(viewer.cookie);
    const watcher = await client();
    await sleep(100);
    const ALICE = 4242;
    alice.ws.send(awarenessMsg([{ clientID: ALICE, clock: 1, state: pres('Alice', { cursor: { x: 1 } }, { id: owner.id }) }]));
    await sleep(100);
    watcher.msgs.length = 0;
    other.ws.send(awarenessMsg([{ clientID: ALICE, clock: 2, state: pres('Alice (2)', { cursor: { x: 999 } }) }]));
    other.ws.send(awarenessMsg([{ clientID: ALICE, clock: 3, state: null }]));
    await sleep(150);
    expect(awarenessSeen(watcher.msgs).filter((e) => e.clientID === ALICE)).toEqual([]);
    expect(states().get(ALICE)).toEqual(pres('owner', { cursor: { x: 1 } }, { id: owner.id }));
    other.ws.close();
    await other.closed;
    await sleep(100);
    expect(alice.ws.readyState).toBe(WebSocket.OPEN);
    expect(states().has(ALICE)).toBe(true);
    // Alice herself can still update and remove it.
    alice.ws.send(awarenessMsg([{ clientID: ALICE, clock: 4, state: null }]));
    await sleep(100);
    expect(states().has(ALICE)).toBe(false);
  });

  it("the server's own entry can't be set by a connection", async () => {
    const c = await client();
    await sleep(100);
    const serverId = docHub.peek(layoutId)!.awareness.clientID;
    const before = states().get(serverId);
    c.ws.send(awarenessMsg([{ clientID: serverId, clock: 99, state: pres('x') }]));
    await sleep(100);
    expect(states().get(serverId)).toEqual(before);
  });

  it('the same person reconnecting keeps their presence', async () => {
    const first = await client();
    await sleep(100);
    first.ws.send(awarenessMsg([{ clientID: 77, clock: 1, state: pres('A') }]));
    await sleep(100);
    // A reconnect: the new connection is open before the old one closes.
    const second = await client();
    await sleep(50);
    second.ws.send(awarenessMsg([{ clientID: 77, clock: 2, state: pres('A', { cursor: { x: 5 } }) }]));
    await sleep(100);
    expect(states().get(77)).toEqual(pres('owner', { cursor: { x: 5 } }, { id: owner.id }));
    first.ws.close();
    await first.closed;
    await sleep(100);
    expect(states().has(77)).toBe(true);
  });

  it(`takes at most ${MAX_AWARENESS_IDS} entries per connection and no message over ${MAX_AWARENESS_BYTES} bytes`, async () => {
    const viewer = await share('viewer3@x.com', 'viewer');
    const v = await client(viewer.cookie);
    const peer = await client();
    await sleep(100);
    peer.msgs.length = 0;
    v.ws.send(awarenessMsg([{ clientID: 1, clock: 1, state: pres('big', { blob: 'x'.repeat(MAX_AWARENESS_BYTES) }) }]));
    v.ws.send(awarenessMsg(Array.from({ length: 5_000 }, (_, i) => ({ clientID: 10_000 + i, clock: 1, state: pres(`u${i}`) }))));
    await sleep(300);
    expect(states().has(1)).toBe(false);
    const mine = [...states().keys()].filter((id) => id >= 10_000 && id < 30_000);
    expect(mine).toHaveLength(MAX_AWARENESS_IDS);
    expect(peer.msgs.reduce((n, m) => n + m.length, 0)).toBeLessThan(4096);
    const joiner = await client();
    await sleep(200);
    expect(awarenessSeen(joiner.msgs).length).toBeLessThanOrEqual(MAX_AWARENESS_IDS + 2);
  });

  it("drops presence that isn't a person's (a tab still opening the layout sends {})", async () => {
    const c = await client();
    const watcher = await client();
    await sleep(100);
    watcher.msgs.length = 0;
    const bad: unknown[] = [
      {},
      { user: { id: 'x' } },
      { user: { displayName: 'No selection' }, lastActivityMs: 1 },
      { user: { displayName: 'No time' }, selection: { brickIds: [] } },
      { user: { displayName: 7 }, selection: { brickIds: [] }, lastActivityMs: 1 },
      { user: { displayName: 'Bad ids' }, selection: { brickIds: 'all' }, lastActivityMs: 1 },
      [],
      'x',
    ];
    c.ws.send(awarenessMsg(bad.map((state, i) => ({ clientID: 600 + i, clock: 1, state }))));
    await sleep(150);
    expect(awarenessSeen(watcher.msgs)).toEqual([]);
    for (let i = 0; i < bad.length; i++) expect(states().has(600 + i)).toBe(false);
    // Nor do they use up the connection's presence entries.
    c.ws.send(awarenessMsg([1, 2, 3, 4].map((n) => ({ clientID: 700 + n, clock: 1, state: pres(`ok${n}`) }))));
    await sleep(150);
    expect([1, 2, 3, 4].every((n) => states().has(700 + n))).toBe(true);
  });

  it("someone else's presence sent back (older web pages did) doesn't count against the sender's pacing", async () => {
    const carolUser = await share('carol@x.com', 'viewer');
    const alice = await client();
    await sleep(100);
    alice.ws.send(awarenessMsg([{ clientID: 900, clock: 1, state: pres('Alice') }]));
    await sleep(100);
    const before = wsPacing.messageBurst;
    wsPacing.messageBurst = 20;
    try {
      const tight = await client(carolUser.cookie);
      await sleep(100);
      // 200 relays of Alice's entry: all dropped, none counted.
      for (let i = 0; i < 200; i++) tight.ws.send(awarenessMsg([{ clientID: 900, clock: 2 + i, state: pres('Alice', { cursor: { x: i } }) }]));
      await sleep(300);
      expect(tight.ws.readyState).toBe(WebSocket.OPEN);
      expect((states().get(900) as { cursor?: unknown }).cursor).toBeUndefined();
    } finally {
      wsPacing.messageBurst = before;
    }
    expect(alice.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('passes the presence of someone who selected every part of a large layout', async () => {
    const big = (
      await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: owner.cookie }, payload: { title: 'F', bbm: readFileSync(join(FIXTURES, 'fordyce-2026.bbm'), 'utf8') } })
    ).json().id as string;
    const doc = new Y.Doc();
    const peer = new Peer(port, big, owner.cookie, doc);
    await peer.synced;
    const ids: string[] = [];
    for (const layer of doc.getMap<Y.Map<unknown>>('layerData').values()) {
      const bricks = layer.get('bricks');
      if (bricks instanceof Y.Array) for (const b of bricks.toArray() as Y.Map<unknown>[]) ids.push(String(b.get('id')));
    }
    const state = {
      user: { id: owner.id, displayName: 'Owner', avatarUrl: null, color: '#60a5fa' },
      cursor: { x: 10, y: 20, layerId: null },
      selection: { brickIds: ids },
      tool: 'select',
      editingModule: null,
      lastActivityMs: Date.now(),
    };
    const msg = awarenessMsg([{ clientID: 31337, clock: 1, state }]);
    peer.ws.send(msg);
    await sleep(150);
    console.log(`[measure] presence with all ${ids.length} parts of Fordyce selected: ${msg.length} bytes`);
    expect(msg.length).toBeLessThan(MAX_AWARENESS_BYTES / 10);
    expect((docHub.peek(big)!.awareness.getStates().get(31337) as typeof state).selection.brickIds).toHaveLength(ids.length);
    await peer.leave();
    await docHub.close(big);
  });
});
