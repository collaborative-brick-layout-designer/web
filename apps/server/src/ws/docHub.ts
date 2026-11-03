// Hub for actively-edited Y.Docs. One DocSession per layout id, shared by
// every connected WebSocket client of that layout. Encapsulates:
//   - hydrating from layouts.docSnapshot + replaying layout_updates
//   - persistent append on every Yjs update (durability)
//   - in-memory awareness state
//   - connection bookkeeping (close last → flush + evict)
//
// Phase 5 will replace LRU eviction with explicit close-after-N-minutes;
// Phase 7 adds the daily compaction worker. For now the design is the
// simplest correct shape.

import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate } from 'y-protocols/awareness';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { eq, and } from 'drizzle-orm';
import { upgradeDoc } from '@cld/ydoc';
import { db, schema } from '../db/index.js';
import { encodeAwarenessUpdate, encodeSyncUpdate, isWsPeer, sendBytes } from './protocol.js';
import { rollup } from '../metrics/rollup.js';
import { applyStoredUpdate } from './yjsWork.js';
import { MAX_PENDING_BYTES, MAX_PENDING_DS_BYTES, dropPending, noteWaitingOnOpen, pendingBytes, pendingDsBytes } from './pending.js';
import { checkUpdate } from './updateGuard.js';

/**
 * Largest awareness (presence) message taken from a client. A presence
 * entry holds the selection's brick ids: selecting all 940 parts of Fordyce
 * is 6.6 KB, and 1 MiB holds the selection of a ~45 000-part layout (ids of up
 * to 19 digits). Larger messages are dropped.
 */
export const MAX_AWARENESS_BYTES = 1024 * 1024;

/** Awareness clientIDs one connection may own (an app uses one per layout it has open). */
export const MAX_AWARENESS_IDS = 4;

/** Live updates this close together are stored as one layout_updates row (DocSession.queuePersist)... */
const PERSIST_BATCH_MS = 50;
/** ...up to this many bytes. */
const PERSIST_BATCH_BYTES = 1024 * 1024;

export class DocSession {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  /** Connected WS clients. The hub closes the session when this is empty. */
  readonly clients = new Set<unknown>();
  /** Counter of unflushed updates since last snapshot. Drives compaction. */
  pendingUpdates = 0;
  /** True while a snapshot rewrite is in flight. */
  flushing = false;
  /** Idle timer id; clearTimeout on the next attached client. */
  idleTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Authenticated user id per attached client. Awareness entries from a
   * client get their `user.id` set to this value so a peer can't
   * impersonate someone else (applyClientAwareness).
   */
  readonly clientUsers = new Map<unknown, string>();
  /**
   * Awareness clientIDs each attached client owns. Yjs assigns a random
   * clientID per Y.Doc, so we learn them as updates flow through and
   * remove them when the client disconnects.
   */
  readonly clientAwarenessIds = new Map<unknown, Set<number>>();
  /** The attached client that owns each awareness clientID (the first to set it). */
  readonly awarenessOwners = new Map<number, unknown>();
  /** Set by DocHub.close(); a closed session never persists or re-arms. */
  closed = false;
  private broadcasting = false;
  /** Updates waiting to be stored as one layout_updates row (queuePersist). */
  private batch: Uint8Array[] = [];
  private batchBytes = 0;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private persistError: (err: unknown) => void = () => {};

  constructor(public readonly layoutId: string) {
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);
  }

  /**
   * Install the session's single doc + awareness listeners: every doc
   * update is persisted once and fanned out once to every peer except
   * its origin, however many sockets are attached. (These used to be
   * registered per connection, so N sockets meant N broadcasts of every
   * update to every peer and N layout_updates rows.) Idempotent.
   */
  startBroadcasting(onPersistError: (err: unknown) => void): void {
    if (this.broadcasting) return;
    this.broadcasting = true;
    this.persistError = onPersistError;

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (this.closed) return;
      this.queuePersist(update);
      const bytes = encodeSyncUpdate(update);
      for (const client of this.clients) {
        if (client === origin) continue;
        sendBytes(client, bytes);
      }
    });

    this.awareness.on(
      'update',
      (
        changes: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        // (Who may set which entry, and the user.id on it, is settled
        // before it is applied: applyClientAwareness.)
        const changedClients = [...changes.added, ...changes.updated, ...changes.removed];
        if (changedClients.length === 0) return;
        const payload = encodeAwarenessUpdate(this.awareness, changedClients);
        for (const client of this.clients) {
          if (client === origin) continue;
          sendBytes(client, payload);
        }
      },
    );
  }

  /**
   * Apply an awareness (presence) message from an attached client. Each
   * entry is someone's presence, keyed by a clientID; a connection may set
   * only its own:
   *   - the first connection to set a clientID owns it until it
   *     disconnects; entries for one another person's connection owns are
   *     dropped (the same person's earlier connection hands it over: a
   *     reconnect before the old socket's close is seen);
   *   - at most MAX_AWARENESS_IDS clientIDs per connection, and never the
   *     server's own;
   *   - `user.id` is always the signed-in user's, whatever was sent;
   *   - a removal (state null) only of an entry it owns.
   * The caller drops messages over MAX_AWARENESS_BYTES. Throws on a
   * message that can't be read (the handler drops it).
   */
  applyClientAwareness(client: unknown, bytes: Uint8Array): void {
    const userId = this.clientUsers.get(client);
    if (userId === undefined) return;
    const dec = decoding.createDecoder(bytes);
    const enc = encoding.createEncoder();
    const kept: [number, number, string][] = [];
    let owned = this.clientAwarenessIds.get(client);
    const count = decoding.readVarUint(dec);
    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(dec);
      const clock = decoding.readVarUint(dec);
      const state = JSON.parse(decoding.readVarString(dec)) as unknown;
      if (clientId === this.awareness.clientID) continue;
      const owner = this.awarenessOwners.get(clientId);
      const mine = owner === client;
      if (!mine && owner !== undefined && this.clientUsers.get(owner) !== userId) continue;
      if (state === null) {
        if (!mine) continue;
        kept.push([clientId, clock, 'null']);
        continue;
      }
      if (typeof state !== 'object' || Array.isArray(state)) continue;
      if (!mine) {
        if ((owned?.size ?? 0) >= MAX_AWARENESS_IDS) continue;
        // Claim it (or take it over from this person's earlier connection).
        if (owner !== undefined) this.clientAwarenessIds.get(owner)?.delete(clientId);
        this.awarenessOwners.set(clientId, client);
        if (!owned) this.clientAwarenessIds.set(client, (owned = new Set()));
        owned.add(clientId);
      }
      const s = state as Record<string, unknown>;
      const user = s.user !== null && typeof s.user === 'object' && !Array.isArray(s.user) ? (s.user as Record<string, unknown>) : {};
      kept.push([clientId, clock, JSON.stringify({ ...s, user: { ...user, id: userId } })]);
    }
    if (kept.length === 0) return;
    encoding.writeVarUint(enc, kept.length);
    for (const [clientId, clock, json] of kept) {
      encoding.writeVarUint(enc, clientId);
      encoding.writeVarUint(enc, clock);
      encoding.writeVarString(enc, json);
    }
    applyAwarenessUpdate(this.awareness, encoding.toUint8Array(enc), client);
  }

  /** Forget what a client owned (it disconnected). Returns the clientIDs it still owned. */
  releaseAwareness(client: unknown): number[] {
    const owned = [...(this.clientAwarenessIds.get(client) ?? [])];
    for (const id of owned) if (this.awarenessOwners.get(id) === client) this.awarenessOwners.delete(id);
    this.clientAwarenessIds.delete(client);
    return owned;
  }

  /**
   * Hydrate the doc from its persisted snapshot + replay any updates that
   * arrived between the last snapshot and a server restart. Idempotent.
   */
  async hydrate(): Promise<void> {
    const layout = await db
      .select({
        docSnapshot: schema.layouts.docSnapshot,
      })
      .from(schema.layouts)
      .where(eq(schema.layouts.id, this.layoutId))
      .get();
    if (!layout) throw new Error(`layout ${this.layoutId} not found`);

    const updates = await db
      .select({ updateBytes: schema.layoutUpdates.updateBytes })
      .from(schema.layoutUpdates)
      .where(
        and(
          eq(schema.layoutUpdates.layoutId, this.layoutId),
          eq(schema.layoutUpdates.doc, 'main'),
        ),
      );
    this.load(
      layout.docSnapshot as Uint8Array,
      updates.map((u) => u.updateBytes as Uint8Array),
    );
  }

  /**
   * hydrate()'s work once the rows are read: the snapshot, then the update
   * log, then the repairs a layout gets on opening. (Also the fuzz
   * harness's way to reopen a room, src/fuzz/room.ts.)
   */
  load(snapshot: Uint8Array | null, updates: readonly Uint8Array[]): void {
    if (snapshot && snapshot.length > 0) {
      Y.applyUpdate(this.doc, snapshot);
    }
    // Corrupt updates, and any that would take too long to apply
    // (ws/yjsWork.ts), are skipped: the snapshot is the source of truth.
    for (const u of updates) applyStoredUpdate(this.doc, u, `layout ${this.layoutId}`);
    // A snapshot written before rooms had a limit on it may hold more
    // waiting for changes nobody sent than one may (ws/pending.ts).
    this.limitPending();
    // Who left what still waits isn't known: the room pays for it.
    noteWaitingOnOpen(this.doc);
    // Docs created before text cells had ids (schemaVersion 1) get them
    // now, so every live-sync client sees a stable id on every cell. This
    // runs before the persist listener is installed; the change reaches
    // the DB with the next snapshot flush (it is part of the doc state).
    upgradeDoc(this.doc);
  }

  /**
   * Append a y-update to layout_updates. Durable record of every change
   * between snapshot rewrites. The compaction worker periodically writes
   * a fresh snapshot and DELETEs the rows it has consumed.
   */
  async persistUpdate(update: Uint8Array, edits = 1): Promise<void> {
    await db.insert(schema.layoutUpdates).values({
      layoutId: this.layoutId,
      doc: 'main',
      updateBytes: Buffer.from(update),
      createdAt: new Date(),
    });
    this.pendingUpdates += 1;
    rollup.distinct('layouts_edited', '', this.layoutId);
    rollup.count('layout_edits', this.layoutId, edits);
  }

  /**
   * Store a live update. Updates arriving within PERSIST_BATCH_MS of each
   * other (or until PERSIST_BATCH_BYTES) go into one layout_updates row,
   * merged, so a burst of edits is a few rows rather than one each. If the
   * server stops before a batch is stored, the clients still have those
   * edits and send them again with their next sync step 2.
   */
  queuePersist(update: Uint8Array): void {
    this.batch.push(update);
    this.batchBytes += update.length;
    if (this.batchBytes >= PERSIST_BATCH_BYTES) {
      void this.flushBatch();
      return;
    }
    this.batchTimer ??= setTimeout(() => {
      this.batchTimer = null;
      void this.flushBatch();
    }, PERSIST_BATCH_MS);
  }

  /** Store the waiting batch now (tests, and before a snapshot replaces it). */
  async flushBatch(): Promise<void> {
    const updates = this.takeBatch();
    if (updates.length === 0 || this.closed) return;
    try {
      await this.persistUpdate(updates.length === 1 ? updates[0]! : Y.mergeUpdates(updates), updates.length);
    } catch (err) {
      // Never let a failed insert (e.g. the layout row was deleted while
      // sockets were still open -> FK violation) become an unhandled
      // rejection; that terminates the Node process.
      this.persistError(err);
    }
  }

  private takeBatch(): Uint8Array[] {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    const updates = this.batch;
    this.batch = [];
    this.batchBytes = 0;
    return updates;
  }

  /** Drop what waits to be stored (the doc is going away). */
  discardBatch(): void {
    this.takeBatch();
  }

  /**
   * Materialise a fresh snapshot from the in-memory doc and truncate the
   * append-log. Idempotent and safe to call concurrently with peer
   * updates because Y.encodeStateAsUpdate is a pure read.
   */
  async flushSnapshot(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    // The snapshot holds what waits to be stored; put back if it fails.
    let covered: Uint8Array[] = [];
    try {
      this.limitPending();
      covered = this.takeBatch();
      const bytes = Y.encodeStateAsUpdate(this.doc);
      await db
        .update(schema.layouts)
        .set({
          docSnapshot: Buffer.from(bytes),
          docVersion: (await this.currentVersion()) + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.layouts.id, this.layoutId));
      covered = [];
      // Crash-safe ordering: snapshot commits BEFORE deletes. If we crash
      // between the two, replay will re-apply already-included updates,
      // which is a no-op for Yjs (idempotent merge).
      await db
        .delete(schema.layoutUpdates)
        .where(
          and(
            eq(schema.layoutUpdates.layoutId, this.layoutId),
            eq(schema.layoutUpdates.doc, 'main'),
          ),
        );
      this.pendingUpdates = 0;
    } finally {
      this.flushing = false;
      if (covered.length > 0 && !this.closed) {
        this.batch = [...covered, ...this.batch];
        this.batchBytes += covered.reduce((n, u) => n + u.length, 0);
        this.batchTimer ??= setTimeout(() => {
          this.batchTimer = null;
          void this.flushBatch();
        }, PERSIST_BATCH_MS);
      }
    }
  }

  /**
   * Past MAX_PENDING_BYTES, drop what waits for changes the layout doesn't
   * have, so no snapshot stores (or serves) more than that. What waits goes
   * out with every sync, so it goes too when the apps couldn't read the
   * layout with it (ws/updateGuard.ts). The live handler keeps a room within
   * both; this covers older snapshots.
   */
  private limitPending(): void {
    const bytes = pendingBytes(this.doc);
    if (bytes === 0) return;
    const over = bytes > MAX_PENDING_BYTES || pendingDsBytes(this.doc) > MAX_PENDING_DS_BYTES;
    if (!over && checkUpdate(Y.encodeStateAsUpdate(this.doc)) === null) return;
    console.warn(`[docHub] layout ${this.layoutId}: dropped ${bytes} bytes waiting for changes the layout doesn't have`);
    dropPending(this.doc);
  }

  private async currentVersion(): Promise<number> {
    const row = await db
      .select({ docVersion: schema.layouts.docVersion })
      .from(schema.layouts)
      .where(eq(schema.layouts.id, this.layoutId))
      .get();
    return row?.docVersion ?? 0;
  }
}

/**
 * Hub keyed by layout id. Sessions are lazy-loaded and evicted IDLE_MS
 * after the last client disconnects (giving brief reconnect grace before
 * we drop the in-memory doc).
 */
const IDLE_MS = 60_000;
const SNAPSHOT_INTERVAL_MS = 30_000;
const SNAPSHOT_MAX_PENDING = 100;

/** WS close code sent when the layout is deleted under open sockets. */
export const CLOSE_LAYOUT_GONE = 4404;

class DocHub {
  private sessions = new Map<string, Promise<DocSession>>();
  /** Hydrated sessions, for synchronous lookups (see `peek`). */
  private live = new Map<string, DocSession>();
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;

  startSnapshotWorker(): void {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setInterval(() => {
      void this.tickSnapshot();
    }, SNAPSHOT_INTERVAL_MS);
  }

  stopSnapshotWorker(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  /** Get-or-hydrate the session for a layout id. Concurrency-safe. */
  async getOrCreate(layoutId: string): Promise<DocSession> {
    const existing = this.sessions.get(layoutId);
    if (existing) return existing;
    const promise = (async () => {
      const session = new DocSession(layoutId);
      await session.hydrate();
      session.startBroadcasting((err) => this.onPersistError(session, err));
      this.live.set(layoutId, session);
      return session;
    })();
    this.sessions.set(layoutId, promise);
    try {
      return await promise;
    } catch (err) {
      // Hydration failed — drop the entry so the next request can retry.
      this.sessions.delete(layoutId);
      throw err;
    }
  }

  /** How many layouts are open in the live editor right now. */
  liveRoomCount(): number {
    let n = 0;
    for (const session of this.live.values()) if (!session.closed) n += 1;
    return n;
  }

  /** True while a session for this layout is loaded or hydrating. */
  has(layoutId: string): boolean {
    return this.sessions.has(layoutId);
  }

  /** The hydrated in-memory session for a layout, if one is loaded. */
  peek(layoutId: string): DocSession | undefined {
    const session = this.live.get(layoutId);
    return session && !session.closed ? session : undefined;
  }

  /**
   * Mark a client as connected; cancels any pending eviction. `userId`
   * is the authenticated user behind the client, used to pin awareness
   * identity (see DocSession.startBroadcasting).
   */
  attach(session: DocSession, client: unknown, userId?: string): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    session.clients.add(client);
    if (userId !== undefined) session.clientUsers.set(client, userId);
  }

  /**
   * Mark a client as disconnected; schedule eviction if last. Idempotent:
   * a socket that emits both 'error' and 'close' must not detach twice
   * (the second call used to arm a second, orphaned idle timer that
   * destroyed the doc under the next connected client).
   */
  async detach(session: DocSession, client: unknown): Promise<void> {
    if (!session.clients.delete(client)) return;
    session.clientUsers.delete(client);
    session.releaseAwareness(client);
    if (session.closed || session.clients.size > 0) return;
    // Final flush so a server restart doesn't lose the last few seconds.
    await session.flushSnapshot();
    // A client may have (re)attached while the flush was in flight.
    if (session.closed || session.clients.size > 0) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null;
      if (session.clients.size > 0) return;
      this.evict(session);
    }, IDLE_MS);
  }

  /**
   * Drop a layout's live session immediately: close every attached
   * socket with 4404 (clients show the same "layout not found" state a
   * reload would) and discard the in-memory doc WITHOUT flushing it.
   * Call this whenever a layout row is deleted, so open sockets can't
   * keep writing updates against a row that no longer exists.
   */
  async close(layoutId: string, reason = 'layout_deleted'): Promise<void> {
    const pending = this.sessions.get(layoutId);
    if (!pending) return;
    this.sessions.delete(layoutId);
    let session: DocSession;
    try {
      session = await pending;
    } catch {
      return; // hydration failed; nothing live
    }
    if (session.closed) return;
    session.closed = true;
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    const clients = [...session.clients];
    session.clients.clear();
    session.clientUsers.clear();
    session.clientAwarenessIds.clear();
    session.awarenessOwners.clear();
    for (const client of clients) {
      if (!isWsPeer(client)) continue;
      try {
        client.close(CLOSE_LAYOUT_GONE, reason);
      } catch {
        /* already closed */
      }
    }
    if (this.live.get(layoutId) === session) this.live.delete(layoutId);
    session.discardBatch();
    session.doc.destroy();
    session.awareness.destroy();
  }

  /** Close the live sessions of several layouts (see `close`). */
  async closeMany(layoutIds: Iterable<string>, reason?: string): Promise<void> {
    for (const id of layoutIds) await this.close(id, reason);
  }

  private evict(session: DocSession): void {
    if (this.live.get(session.layoutId) === session) {
      this.live.delete(session.layoutId);
      this.sessions.delete(session.layoutId);
    }
    session.discardBatch();
    session.doc.destroy();
    session.awareness.destroy();
  }

  /**
   * A persist failed. Log it, and if the cause is that the layout row is
   * gone (deleted through a path that didn't call `close`, e.g. an
   * ON DELETE CASCADE from its owner), shut the session down.
   */
  private onPersistError(session: DocSession, err: unknown): void {
    console.error(`[docHub] failed to persist update for layout ${session.layoutId}:`, err);
    void (async () => {
      try {
        const row = await db
          .select({ id: schema.layouts.id })
          .from(schema.layouts)
          .where(eq(schema.layouts.id, session.layoutId))
          .get();
        if (!row) await this.close(session.layoutId);
      } catch {
        /* DB unavailable; the next update will retry this check */
      }
    })();
  }

  /** Snapshot worker tick — flush any session past the per-doc threshold. */
  private async tickSnapshot(): Promise<void> {
    for (const [, p] of this.sessions) {
      try {
        const session = await p;
        if (!session.closed && session.pendingUpdates >= SNAPSHOT_MAX_PENDING) {
          await session.flushSnapshot();
        }
      } catch {
        // ignore — getOrCreate already cleaned up on hydration failure
      }
    }
  }
}

export const docHub = new DocHub();
