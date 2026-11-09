// Integration tests for the WebSocket route: GET /ws/layout/:id
//
// Uses app.listen({ port: 0 }) to bind an ephemeral port, then connects
// real `ws` WebSocket clients. Messages are buffered from the moment the
// socket is created so no event is lost to a listener-registration race.

import { WebSocket } from 'ws';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, db, schema, testVerificationToken } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { sessionRoutes } from '../auth/session.js';
import { layoutRoutes } from '../layouts.js';
import { collaboratorRoutes } from '../collaborators.js';
import { wsRoutes } from '../ws.js';

// ---------------------------------------------------------------------------
// Protocol constants (mirror handler.ts)
// ---------------------------------------------------------------------------
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

// ---------------------------------------------------------------------------
// WsClient — wraps a WebSocket and buffers incoming messages so tests
// can consume them synchronously regardless of when the listener registers.
// ---------------------------------------------------------------------------

class WsClient {
  private buffer: Uint8Array[] = [];
  private waiters: Array<(msg: Uint8Array) => void> = [];
  readonly ws: WebSocket;
  readonly closed: Promise<number>;
  private closedCode = 0;

  constructor(port: number, layoutId: string, cookieStr?: string, userAgent?: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws/layout/${layoutId}`, {
      headers: { ...(cookieStr ? { cookie: cookieStr } : {}), ...(userAgent ? { 'user-agent': userAgent } : {}) },
    });

    // Buffer every message immediately so we never miss one.
    this.ws.on('message', (data: Buffer) => {
      const msg = new Uint8Array(data);
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(msg);
      } else {
        this.buffer.push(msg);
      }
    });

    let resolveClose!: (code: number) => void;
    this.closed = new Promise((r) => { resolveClose = r; });
    this.ws.on('close', (code) => {
      this.closedCode = code;
      resolveClose(code);
      // Unblock any pending nextMessage calls so they don't hang.
      while (this.waiters.length) {
        this.waiters.shift()!(new Uint8Array(0));
      }
    });
  }

  /** Wait for the socket to open (or reject on error before open). */
  waitOpen(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) { resolve(); return; }
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
      // If already closed before open (e.g. server rejected upgrade):
      this.ws.once('close', () => resolve());
    });
  }

  /** Consume the next buffered or future message. */
  nextMessage(timeoutMs = 5000): Promise<Uint8Array> {
    if (this.buffer.length > 0) {
      return Promise.resolve(this.buffer.shift()!);
    }
    return new Promise((resolve, reject) => {
      const waiter = (msg: Uint8Array) => {
        clearTimeout(t);
        resolve(msg);
      };
      const t = setTimeout(() => {
        // Remove THIS waiter (not `resolve`, which was never queued) so a
        // timed-out wait doesn't swallow the next message. The old
        // indexOf(resolve) never matched; tests only passed because the
        // server used to send every broadcast once per open socket.
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error(`nextMessage timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  send(bytes: Uint8Array): void {
    this.ws.send(bytes);
  }

  close(): void {
    this.ws.close();
  }

  get closeCode(): number {
    return this.closedCode;
  }

  /** Read the next message with a given outer message type, skipping others. */
  async nextMessageOfType(type: number, timeoutMs = 5000): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await this.nextMessage(deadline - Date.now());
      const dec = decoding.createDecoder(msg);
      const msgType = decoding.readVarUint(dec);
      if (msgType === type) return msg;
      // Otherwise discard and wait for next.
    }
    throw new Error(`nextMessageOfType(${type}) timed out`);
  }

  /** Read the next sync-protocol message (MESSAGE_SYNC=0). */
  nextSyncMessage(timeoutMs = 5000): Promise<Uint8Array> {
    return this.nextMessageOfType(MESSAGE_SYNC, timeoutMs);
  }
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

async function buildApp(): Promise<{ app: FastifyInstance; port: number }> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  app.addHook('preHandler', attachUser);
  await app.register(passwordRoutes);
  await app.register(sessionRoutes);
  await app.register(layoutRoutes);
  await app.register(collaboratorRoutes);
  await app.register(wsRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { app, port };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function registerAndLogin(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/password/register',
    payload: { email, password: 'correct horse battery', displayName: 'Tester' },
  });
  expect(res.statusCode).toBe(200);
  const user = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();
  const verification = await db
    .select()
    .from(schema.emailVerifications)
    .where(eq(schema.emailVerifications.userId, user!.id))
    .get();
  const verifyRes = await app.inject({
    method: 'POST',
    url: `/api/auth/password/verify-email/${await testVerificationToken(verification!)}`,
  });
  expect(verifyRes.statusCode).toBe(200);
  const setCookie = verifyRes.headers['set-cookie'];
  return Array.isArray(setCookie) ? setCookie.join('; ') : (setCookie ?? '');
}

async function createLayout(app: FastifyInstance, cookieStr: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/layouts',
    headers: { cookie: cookieStr },
    payload: { title: 'WS Test Layout' },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

/**
 * Drain the two messages the server always sends on a successful WS connect:
 *   1. sync step-1 (server → client state vector)
 *   2. awareness (server's own session doc state, always present because
 *      `new Awareness(doc)` calls `setLocalState({})` in its constructor)
 *
 * Both must be consumed before sending protocol messages to avoid stale
 * buffered messages confusing later assertions.
 */
async function drainConnect(client: WsClient): Promise<void> {
  // Drain exactly: one sync step-1 and one awareness update.
  await client.nextSyncMessage();
  await client.nextMessageOfType(MESSAGE_AWARENESS);
}

// ---------------------------------------------------------------------------
// Auth & access checks
// ---------------------------------------------------------------------------

describe('WS /ws/layout/:id — auth & access checks', () => {
  let app: FastifyInstance;
  let port: number;

  beforeEach(async () => {
    resetDb();
    ({ app, port } = await buildApp());
  });

  afterEach(async () => {
    await app.close();
  });

  it('closes with 1008 when no session cookie is present', async () => {
    const client = new WsClient(port, 'some-layout-id');
    const code = await client.closed;
    expect(code).toBe(1008);
  });

  it('closes with 4404 when the layout does not exist', async () => {
    const cookieStr = await registerAndLogin(app, 'ws-404@example.com');
    const client = new WsClient(port, 'no-such-layout-id', cookieStr);
    const code = await client.closed;
    expect(code).toBe(4404);
  });

  it('closes with 4426 for a desktop app older than the server allows', async () => {
    const ownerCookie = await registerAndLogin(app, 'ws-old-desktop@example.com');
    const layoutId = await createLayout(app, ownerCookie);
    const old = new WsClient(port, layoutId, ownerCookie, 'BrickLayoutDesigner/1.1.0 (desktop)');
    expect(await old.closed).toBe(4426);
    const current = new WsClient(port, layoutId, ownerCookie, 'BrickLayoutDesigner/1.3.0 (desktop)');
    await current.nextMessageOfType(0); // sync step 1: it's in
    current.ws.close();
    await current.closed;
  });

  it('closes with 4404 when the user has no access to the layout', async () => {
    const ownerCookie = await registerAndLogin(app, 'ws-owner@example.com');
    const strangerCookie = await registerAndLogin(app, 'ws-stranger@example.com');
    const layoutId = await createLayout(app, ownerCookie);
    const client = new WsClient(port, layoutId, strangerCookie);
    const code = await client.closed;
    expect(code).toBe(4404);
  });
});

// ---------------------------------------------------------------------------
// Sync protocol
// ---------------------------------------------------------------------------

describe('WS /ws/layout/:id — sync protocol', () => {
  let app: FastifyInstance;
  let port: number;
  let cookieStr: string;
  let layoutId: string;

  beforeEach(async () => {
    resetDb();
    ({ app, port } = await buildApp());
    cookieStr = await registerAndLogin(app, 'ws-sync@example.com');
    layoutId = await createLayout(app, cookieStr);
  });

  afterEach(async () => {
    await app.close();
  });

  it('sends a sync step-1 message immediately on connect', async () => {
    const client = new WsClient(port, layoutId, cookieStr);
    await client.waitOpen();
    // Read the first sync message (step-1); skip any awareness that precedes it.
    const msg = await client.nextSyncMessage();
    const decoder = decoding.createDecoder(msg);
    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_SYNC);
    expect(decoding.readVarUint(decoder)).toBe(syncProtocol.messageYjsSyncStep1);
    client.close();
  });

  it('responds to a client sync step-1 with a sync step-2', async () => {
    const client = new WsClient(port, layoutId, cookieStr);
    await client.waitOpen();
    // Server sends step-1 + awareness on connect; drain both.
    await drainConnect(client);

    // Send a client step-1.
    const clientDoc = new Y.Doc();
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, clientDoc);
    client.send(encoding.toUint8Array(enc));

    // Server replies with a sync step-2.
    const reply = await client.nextSyncMessage();
    const decoder = decoding.createDecoder(reply);
    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_SYNC);
    expect(decoding.readVarUint(decoder)).toBe(syncProtocol.messageYjsSyncStep2);
    client.close();
  });

  it('viewer sync step-1 is answered with step-2; viewer updates are dropped', async () => {
    const viewerCookie = await registerAndLogin(app, 'ws-viewer@example.com');
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: viewerCookie },
    });
    const viewerUserId = (meRes.json() as { user: { id: string } }).user.id;

    await db.insert(schema.layoutCollaborators).values({
      layoutId,
      userId: viewerUserId,
      role: 'viewer',
      addedAt: new Date(),
    });

    const client = new WsClient(port, layoutId, viewerCookie);
    await client.waitOpen();
    // Drain the server's connect-time messages (step-1 + awareness).
    await drainConnect(client);

    // A viewer's sync step-1 is a read request: the server must answer
    // with step-2, or y-websocket viewers never receive the document.
    const clientDoc = new Y.Doc();
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, clientDoc);
    client.send(encoding.toUint8Array(enc));
    const reply = decoding.createDecoder(await client.nextSyncMessage(2000));
    expect(decoding.readVarUint(reply)).toBe(MESSAGE_SYNC);
    expect(decoding.readVarUint(reply)).toBe(syncProtocol.messageYjsSyncStep2);

    // Step-2 / update messages are writes and are dropped (no reply,
    // nothing persisted).
    const edit = new Y.Doc();
    edit.getMap('m').set('evil', true);
    const upd = encoding.createEncoder();
    encoding.writeVarUint(upd, MESSAGE_SYNC);
    syncProtocol.writeUpdate(upd, Y.encodeStateAsUpdate(edit));
    client.send(encoding.toUint8Array(upd));
    const result = await client
      .nextSyncMessage(400)
      .then(() => 'got_sync' as const)
      .catch(() => 'timeout' as const);
    expect(result).toBe('timeout');
    const rows = await db
      .select()
      .from(schema.layoutUpdates)
      .where(eq(schema.layoutUpdates.layoutId, layoutId));
    expect(rows.length).toBe(0);
    client.close();
  });
});

// ---------------------------------------------------------------------------
// Awareness broadcast
// ---------------------------------------------------------------------------

describe('WS /ws/layout/:id — awareness broadcast', () => {
  let app: FastifyInstance;
  let port: number;
  let ownerCookie: string;
  let layoutId: string;

  beforeEach(async () => {
    resetDb();
    ({ app, port } = await buildApp());
    ownerCookie = await registerAndLogin(app, 'ws-aware1@example.com');
    layoutId = await createLayout(app, ownerCookie);
  });

  afterEach(async () => {
    await app.close();
  });

  it('broadcasts awareness from one client to another', async () => {
    const editorCookie = await registerAndLogin(app, 'ws-aware2@example.com');
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: editorCookie },
    });
    const editorUserId = (meRes.json() as { user: { id: string } }).user.id;

    await db.insert(schema.layoutCollaborators).values({
      layoutId,
      userId: editorUserId,
      role: 'editor',
      addedAt: new Date(),
    });

    const ws1 = new WsClient(port, layoutId, ownerCookie);
    const ws2 = new WsClient(port, layoutId, editorCookie);
    await ws1.waitOpen();
    await ws2.waitOpen();

    // Drain the server's connect-time messages for both clients.
    await drainConnect(ws1);
    await drainConnect(ws2);

    // When ws2 connects, it broadcasts its own session awareness to ws1.
    // (The server's DocSession has awareness state for the session doc.)
    // Drain any pending awareness updates on ws1 that arrived during ws2's connect.
    // We use a short timeout to drain any buffered messages before the test send.
    const drainPending = async (client: WsClient) => {
      try {
        while (true) {
          await client.nextMessage(50);
        }
      } catch {
        // timed out — buffer is clear
      }
    };
    await drainPending(ws1);

    // ws2 sends a fresh awareness update.
    const doc2 = new Y.Doc();
    const awareness2 = new awarenessProtocol.Awareness(doc2);
    awareness2.setLocalState({ user: { id: editorUserId, displayName: 'Peer' }, selection: { brickIds: [] }, lastActivityMs: Date.now() });
    const awarenessBytes = awarenessProtocol.encodeAwarenessUpdate(awareness2, [doc2.clientID]);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessBytes);
    ws2.send(encoding.toUint8Array(enc));

    // ws1 should receive the awareness broadcast.
    const broadcast = await ws1.nextMessageOfType(MESSAGE_AWARENESS);
    const dec = decoding.createDecoder(broadcast);
    expect(decoding.readVarUint(dec)).toBe(MESSAGE_AWARENESS);

    ws1.close();
    ws2.close();
  });
});

// ---------------------------------------------------------------------------
// Connection cap
// ---------------------------------------------------------------------------

describe('WS /ws/layout/:id — connection cap (MAX_WS_PER_USER = 8)', () => {
  let app: FastifyInstance;
  let port: number;
  let cookieStr: string;
  let layoutId: string;

  beforeEach(async () => {
    resetDb();
    ({ app, port } = await buildApp());
    cookieStr = await registerAndLogin(app, 'ws-cap@example.com');
    layoutId = await createLayout(app, cookieStr);
  });

  afterEach(async () => {
    await app.close();
  });

  it('closes the 9th concurrent connection with 4429', async () => {
    const clients: WsClient[] = [];
    for (let i = 0; i < 8; i++) {
      const c = new WsClient(port, layoutId, cookieStr);
      await c.waitOpen();
      await drainConnect(c); // drain step-1 + awareness to confirm the connection is live
      clients.push(c);
    }

    // 9th connection must be rejected.
    const c9 = new WsClient(port, layoutId, cookieStr);
    const code = await c9.closed;
    expect(code).toBe(4429);

    for (const c of clients) c.close();
  });
});

// ---------------------------------------------------------------------------
// docHub — non-empty snapshot hydration (covers docHub.ts line 49)
// ---------------------------------------------------------------------------

describe('WS /ws/layout/:id — docHub hydrates non-empty snapshot', () => {
  let app: FastifyInstance;
  let port: number;

  beforeEach(async () => {
    resetDb();
    ({ app, port } = await buildApp());
  });

  afterEach(async () => {
    await app.close();
  });

  it('hydrates from a non-empty docSnapshot and sends sync step-1', async () => {
    const cookieStr = await registerAndLogin(app, 'ws-snap@example.com');
    const layoutId = await createLayout(app, cookieStr);

    // Seed a meaningful snapshot.
    const seedDoc = new Y.Doc();
    seedDoc.getMap('meta').set('seeded', true);
    await db
      .update(schema.layouts)
      .set({ docSnapshot: Buffer.from(Y.encodeStateAsUpdate(seedDoc)) })
      .where(eq(schema.layouts.id, layoutId));

    const client = new WsClient(port, layoutId, cookieStr);
    await client.waitOpen();
    // The server sends step-1 regardless of snapshot size (covers docHub.ts line 49).
    const msg = await client.nextSyncMessage();

    const decoder = decoding.createDecoder(msg);
    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_SYNC);
    expect(decoding.readVarUint(decoder)).toBe(syncProtocol.messageYjsSyncStep1);

    client.close();
  });
});
