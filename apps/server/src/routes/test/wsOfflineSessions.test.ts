// Large offline sessions against the merge guard (ws/mergeGuard.ts), over a
// real socket. A client that worked offline for a long time sends all of
// it in one sync step 2 when it reconnects, while others edited meanwhile,
// deleting the very layers its new ones sit next to. None of that may be
// refused: every new layer entry is placed next to items of this layout.
//
// Also the edges around the room itself: anchors deleted and garbage
// collected, a server restart mid-session (the room read back from the
// DB), and a server rolled back to a backup while a client was offline.
//
// Rollback, decided: a client that still holds newer state sends it back
// on reconnect and the server takes it. Its items are this layout's own
// history (placed next to items the backup has), so nothing it did is
// lost. What a rollback meant to throw away comes back with it; an admin
// who wants it gone deletes it again as an edit, which every client then
// receives. Only a "backup" that is not this layout's history (rebuilt
// from a .bbm, so none of its items are the ones clients hold) refuses
// the client's update, and the client keeps its copy (web: save it as a
// new layout or download it; desktop: an unsaved copy to save).

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import * as Y from 'yjs';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBbm } from '@cld/bbm';
import { encodeDoc, seedFromBbm } from '@cld/ydoc';
import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { layoutRoutes } from '../layouts.js';
import { WS_MAX_PAYLOAD, wsRoutes } from '../ws.js';
import { docHub } from '../../ws/docHub.js';
import { Peer, layerIds } from './wsPeer.js';
import {
  addLayer,
  brickBatches,
  deleteLayer,
  desktopWriteLayers,
  importAsModule,
  insertBricks,
  layoutJson,
  makeModule,
  moveLayer,
  replaceWithBbm,
  webUndoManager,
} from './clientEdits.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures');
const FORDYCE_TEXT = readFileSync(join(FIXTURES, 'fordyce-2026.bbm'), 'utf8');
const fordyce = () => readBbm(FORDYCE_TEXT).map;
const tightCorner = () => readBbm(readFileSync(join(FIXTURES, 'tight-corner.bbm'), 'utf8')).map;

const WEB = 'Mozilla/5.0 (X11; Linux x86_64)';
const DESKTOP = 'BrickLayoutDesigner/1.4.0 (desktop)';

/** Step 2 sizes of the offline sessions, printed at the end (the realistic sizes). */
const sizes: [string, number][] = [];
const mib = (n: number) => `${(n / 1048576).toFixed(2)} MiB`;


/** The four big Fordyce sessions take a few seconds alone and much longer on a busy machine: 30 s, not vitest's 5. */
const BIG_SESSION_MS = 30_000;
describe('WS merge guard: large offline sessions', () => {
  let app: FastifyInstance;
  let port: number;
  let cookieStr: string;
  const open: Peer[] = [];

  beforeEach(async () => {
    resetDb();
    app = Fastify();
    await app.register(cookie);
    app.addHook('preHandler', attachUser);
    await app.register(passwordRoutes);
    await app.register(layoutRoutes);
    await app.register(wsRoutes);
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
    cookieStr = (await loginAs(app, 'offline@example.com')).cookie;
  });

  afterEach(async () => {
    for (const p of open.splice(0)) if (p.ws.readyState === WebSocket.OPEN) await p.leave();
    await app.close();
  });

  afterAll(() => {
    console.log(`[offline step 2 sizes] limit ${mib(WS_MAX_PAYLOAD)}\n${sizes.map(([k, n]) => `  ${k}: ${n} bytes (${mib(n)})`).join('\n')}`);
  });

  async function create(payload: Record<string, unknown>): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/layouts', headers: { cookie: cookieStr }, payload });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  }

  async function connect(layoutId: string, doc: Y.Doc, ua = WEB): Promise<Peer> {
    const p = new Peer(port, layoutId, cookieStr, doc, ua);
    open.push(p);
    await p.synced;
    return p;
  }

  /** A fresh doc synced with the layout, then offline. */
  async function goOffline(layoutId: string, ua = WEB): Promise<Y.Doc> {
    const doc = new Y.Doc();
    await (await connect(layoutId, doc, ua)).leave();
    return doc;
  }

  async function refusals(): Promise<number> {
    const rows = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'layout_merge_refused'));
    return rows.length;
  }

  /** Reconnect with the offline work; it all reaches the room, nothing is refused. */
  async function reconnectAccepted(layoutId: string, doc: Y.Doc, label: string, ua = WEB): Promise<Peer> {
    const peer = await connect(layoutId, doc, ua);
    const session = await docHub.getOrCreate(layoutId);
    await vi.waitFor(() => expect(Y.encodeStateVector(session.doc)).toEqual(Y.encodeStateVector(doc)), { timeout: 15_000 });
    expect(peer.ws.readyState).toBe(WebSocket.OPEN);
    expect(await refusals()).toBe(0);
    expect(layerIds(session.doc)).toEqual(layerIds(doc));
    sizes.push([label, peer.largestStep2()]);
    return peer;
  }

  /** Someone else, online meanwhile. */
  async function other(layoutId: string): Promise<Y.Doc> {
    const doc = new Y.Doc();
    await connect(layoutId, doc);
    return doc;
  }

  /** Wait until the room has what this connected client did. */
  async function landed(layoutId: string, doc: Y.Doc): Promise<void> {
    const session = await docHub.getOrCreate(layoutId);
    await vi.waitFor(() => expect(Y.encodeStateVector(session.doc)).toEqual(Y.encodeStateVector(doc)));
  }

  /** The server process goes away and comes back: the room is read again from the DB. */
  async function restartServer(layoutId: string): Promise<void> {
    for (const p of open.splice(0)) if (p.ws.readyState === WebSocket.OPEN) await p.leave();
    // Every accepted update is written before it is relayed; let the writes finish.
    await new Promise((r) => setTimeout(r, 100));
    await docHub.close(layoutId, 'restart');
  }

  it('a long web session offline on Fordyce: import as module, 20 layers, 1000 parts pasted, 10 modules, undo and redo', async () => {
    const id = await create({ title: 'Fordyce', bbm: FORDYCE_TEXT });
    const mine = await goOffline(id);
    const before = layerIds(mine);
    const undo = webUndoManager(mine);

    // Meanwhile: someone deletes the last layer (where new ones go) and the
    // first, adds their own, and keeps placing parts.
    const them = await other(id);
    const sheetOfParts = before.find((l) => (them.getMap('layerData').get(l) as Y.Map<unknown>).get('type') === 'brick')!;
    deleteLayer(them, before.at(-1)!);
    deleteLayer(them, before[0]!);
    deleteLayer(them, sheetOfParts);
    const theirs = addLayer(them, 'Their sheet');
    insertBricks(them, theirs, brickBatches(fordyce())[0]!.bricks.slice(0, 50));
    await landed(id, them);

    // Offline, for a long time.
    importAsModule(mine, tightCorner(), 'Tight corner', 2000, 0);
    const added: string[] = [];
    for (let i = 0; i < 20; i++) added.push(addLayer(mine, `Sheet ${i + 1}`));
    for (const gone of added.splice(3, 5)) deleteLayer(mine, gone);
    for (let i = 0; i < 5; i++) added.push(addLayer(mine, `Again ${i + 1}`));
    moveLayer(mine, added[0]!, 'down');
    moveLayer(mine, added.at(-1)!, 'down');
    // Fordyce has ~940 parts: copied once and a bit.
    const fordyceParts = brickBatches(fordyce()).flatMap((b) => b.bricks);
    const all = [...fordyceParts, ...fordyceParts];
    const pasted = insertBricks(mine, added[1]!, all.slice(0, 1000), 0, 3000);
    for (let i = 0; i < 10; i++) makeModule(mine, `Module ${i + 1}`, pasted.slice(i * 100, (i + 1) * 100));
    // Undo all of it, redo all of it, then undo some and go on.
    let steps = 0;
    while (undo.canUndo()) {
      undo.undo();
      steps++;
    }
    expect(steps).toBeGreaterThan(40);
    expect(layerIds(mine)).toEqual(before);
    while (undo.canRedo()) undo.redo();
    for (let i = 0; i < 12; i++) undo.undo();
    addLayer(mine, 'After undo');
    // Parts placed on a sheet they deleted meanwhile.
    expect(insertBricks(mine, sheetOfParts, all.slice(0, 10))).toHaveLength(10);

    await reconnectAccepted(id, mine, 'web, long session on Fordyce');
    const session = await docHub.getOrCreate(id);
    expect(layerIds(session.doc)).toContain(theirs);
    expect(layerIds(session.doc)).not.toContain(before[0]);
    // The other client gets the same layout.
    await vi.waitFor(() => expect(layerIds(them)).toEqual(layerIds(session.doc)));
  }, BIG_SESSION_MS);

  it('a web session offline that replaces the whole layout with a .bbm, then adds Fordyce as a module', async () => {
    const id = await create({ title: 'Fordyce', bbm: FORDYCE_TEXT });
    const mine = await goOffline(id);
    const undo = webUndoManager(mine);
    const them = await other(id);
    // Meanwhile: every layer deleted, a new one made.
    for (const l of layerIds(them)) deleteLayer(them, l);
    addLayer(them, 'Starting over');
    await landed(id, them);

    replaceWithBbm(mine, tightCorner());
    importAsModule(mine, fordyce(), 'Fordyce again', 0, 4000);
    for (let i = 0; i < 6; i++) undo.undo();
    while (undo.canRedo()) undo.redo();
    replaceWithBbm(mine, fordyce());
    undo.undo();

    await reconnectAccepted(id, mine, 'web, replace whole layout + Fordyce as module');
  }, BIG_SESSION_MS);

  it('the largest realistic offline session: Fordyce replaced by itself, imported twice as modules, 1000 parts pasted, undo/redo', async () => {
    const id = await create({ title: 'Fordyce', bbm: FORDYCE_TEXT });
    const mine = await goOffline(id);
    const undo = webUndoManager(mine);
    replaceWithBbm(mine, fordyce());
    importAsModule(mine, fordyce(), 'Copy 1', 0, 4000);
    importAsModule(mine, fordyce(), 'Copy 2', 0, 8000);
    const target = addLayer(mine, 'Pasted');
    const parts = brickBatches(fordyce()).flatMap((b) => b.bricks);
    insertBricks(mine, target, [...parts, ...parts].slice(0, 1000), 4000, 0);
    while (undo.canUndo()) undo.undo();
    while (undo.canRedo()) undo.redo();
    const peer = await reconnectAccepted(id, mine, 'web, largest realistic (Fordyce x4 worth of parts)');
    // Well under the 16 MiB message limit.
    expect(peer.largestStep2()).toBeLessThan(WS_MAX_PAYLOAD / 4);
  }, BIG_SESSION_MS);

  it('the desktop: offline edits kept apart, written after the resync as "Keep mine" with a whole other layout', async () => {
    const id = await create({ title: 'Fordyce', bbm: FORDYCE_TEXT });
    // The desktop's shared doc, synced before it went offline.
    const desktop = await goOffline(id, DESKTOP);
    const them = await other(id);
    const layers = layerIds(them);
    deleteLayer(them, layers[0]!);
    deleteLayer(them, layers.at(-1)!);
    addLayer(them, 'Meanwhile');
    await landed(id, them);

    // Reconnect: the shared doc catches up (offline edits stay apart until reviewed).
    const peer = await connect(id, desktop, DESKTOP);
    await landed(id, desktop);
    // "Keep mine": its snapshot is a whole other layout, written through writeMap.
    const otherLayout = new Y.Doc();
    replaceWithBbm(otherLayout, tightCorner());
    const before = peer.sent.length;
    desktopWriteLayers(desktop, layoutJson(otherLayout));
    await landed(id, desktop);
    expect(peer.ws.readyState).toBe(WebSocket.OPEN);
    expect(await refusals()).toBe(0);
    const session = await docHub.getOrCreate(id);
    expect(layerIds(session.doc)).toEqual(layerIds(otherLayout));
    const update = peer.sent.slice(before).find((s) => s.kind === 'update');
    sizes.push(['desktop, Keep mine with a whole other layout (tight corner)', update?.bytes ?? 0]);

    // And a desktop whose own copy was Fordyce four times over.
    const big = new Y.Doc();
    replaceWithBbm(big, fordyce());
    importAsModule(big, fordyce(), 'Copy 1', 0, 4000);
    importAsModule(big, fordyce(), 'Copy 2', 0, 8000);
    importAsModule(big, fordyce(), 'Copy 3', 0, 12000);
    const mark = peer.sent.length;
    desktopWriteLayers(desktop, layoutJson(big));
    await landed(id, desktop);
    expect(await refusals()).toBe(0);
    const bigUpdate = peer.sent.slice(mark).find((s) => s.kind === 'update');
    sizes.push(['desktop, Keep mine with Fordyce x4', bigUpdate?.bytes ?? 0]);
    expect(bigUpdate!.bytes).toBeLessThan(WS_MAX_PAYLOAD / 4);
  }, BIG_SESSION_MS);

  it('an offline client whose only anchors were deleted and garbage-collected on the server', async () => {
    const id = await create({ title: 'Fordyce', bbm: FORDYCE_TEXT });
    const mine = await goOffline(id);
    const anchors = layerIds(mine);
    // Offline: new layers next to the old ones, and parts on them.
    const a = addLayer(mine, 'Mine at the end');
    mine.transact(() => mine.getArray<string>('layers').insert(0, ['first-' + a]));
    mine.getMap('layerData').set('first-' + a, new Y.Map());
    insertBricks(mine, a, brickBatches(fordyce())[0]!.bricks.slice(0, 200));
    // Meanwhile every layer it knew is deleted (their data with it, so
    // the contents are garbage-collected), and the server restarts: the
    // room comes back from a snapshot that holds only tombstones.
    const them = await other(id);
    for (const l of anchors) deleteLayer(them, l);
    await landed(id, them);
    const session = await docHub.getOrCreate(id);
    await session.flushSnapshot();
    await restartServer(id);
    const back = await docHub.getOrCreate(id);
    expect(layerIds(back.doc)).toEqual([]);

    await reconnectAccepted(id, mine, 'web, anchors deleted + GCed');
    expect(layerIds((await docHub.getOrCreate(id)).doc)).toEqual(['first-' + a, a]);
  });

  it('a server restarted mid-session: the room read back from the snapshot and the update log', async () => {
    const id = await create({ title: 'Fordyce', bbm: FORDYCE_TEXT });
    const mine = new Y.Doc();
    await connect(id, mine);
    // Online edits: in the update log, not in a snapshot yet.
    const online = addLayer(mine, 'Made online');
    insertBricks(mine, online, brickBatches(fordyce())[0]!.bricks.slice(0, 100));
    await landed(id, mine);
    // (Stored a moment later, in a batch: DocSession.queuePersist.)
    await vi.waitFor(async () => {
      const rows = await db.select().from(schema.layoutUpdates).where(eq(schema.layoutUpdates.layoutId, id));
      expect(rows.length).toBeGreaterThan(0);
    });
    await restartServer(id);

    // Offline while it was down: built on what it made online.
    const next = addLayer(mine, 'Made while the server was down');
    insertBricks(mine, online, brickBatches(fordyce())[1]!.bricks.slice(0, 100));
    moveLayer(mine, next, 'down');
    deleteLayer(mine, online);
    await reconnectAccepted(id, mine, 'web, after a server restart');
  });

  it('a server rolled back to a backup while a client was offline: its work comes back, nothing is refused', async () => {
    const id = await create({ title: 'Fordyce', bbm: FORDYCE_TEXT });
    const backup = (await db.select({ snap: schema.layouts.docSnapshot }).from(schema.layouts).where(eq(schema.layouts.id, id)).get())!.snap;

    // After the backup: two clients' work reaches the server.
    const mine = new Y.Doc();
    await connect(id, mine);
    const sheet = addLayer(mine, 'After the backup');
    insertBricks(mine, sheet, brickBatches(fordyce())[0]!.bricks.slice(0, 100));
    const them = await other(id);
    await vi.waitFor(() => expect(layerIds(them)).toContain(sheet));
    const theirs = addLayer(them, 'Theirs after the backup');
    await landed(id, them);
    await vi.waitFor(() => expect(layerIds(mine)).toContain(theirs));

    // The server is restored from the backup; this client is offline and
    // keeps working on the layers the backup doesn't have.
    await restartServer(id);
    await db.update(schema.layouts).set({ docSnapshot: backup }).where(eq(schema.layouts.id, id));
    await db.delete(schema.layoutUpdates).where(eq(schema.layoutUpdates.layoutId, id));
    expect(layerIds((await docHub.getOrCreate(id)).doc)).not.toContain(sheet);
    await docHub.close(id, 'restart');
    insertBricks(mine, sheet, brickBatches(fordyce())[1]!.bricks.slice(0, 100));
    addLayer(mine, 'Offline after the restore');
    const pasted = insertBricks(mine, theirs, brickBatches(fordyce())[0]!.bricks.slice(100, 150));
    makeModule(mine, 'On their sheet', pasted);

    await reconnectAccepted(id, mine, 'web, after a server rollback');
    const session = await docHub.getOrCreate(id);
    expect(layerIds(session.doc)).toEqual(expect.arrayContaining([sheet, theirs]));
  });

  it('a "backup" that is not this layout\'s history (rebuilt from a .bbm) refuses the stale client, and changes nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = await create({ title: 'Fordyce', bbm: FORDYCE_TEXT });
    const mine = await goOffline(id);
    const work = addLayer(mine, 'Offline work');
    // The row rewritten from the .bbm: same layers by id, none of the same items.
    await db
      .update(schema.layouts)
      .set({ docSnapshot: Buffer.from(encodeDoc(seedFromBbm(fordyce()))) })
      .where(eq(schema.layouts.id, id));
    await docHub.close(id, 'restart');
    const rebuilt = Y.encodeStateVector((await docHub.getOrCreate(id)).doc);

    const peer = new Peer(port, id, cookieStr, mine, WEB);
    open.push(peer);
    expect(await peer.closed).toEqual([1008, 'layout_merge_refused']);
    expect(Y.encodeStateVector((await docHub.getOrCreate(id)).doc)).toEqual(rebuilt);
    // The client still has everything it did (the apps then offer to keep it).
    expect(layerIds(mine)).toContain(work);
    vi.restoreAllMocks();
  });
});
