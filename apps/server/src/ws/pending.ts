// Updates waiting for changes a room doesn't have yet.
//
// Yjs keeps the part of an update whose dependencies are missing in
// doc.store.pendingStructs / pendingDs, retries it on every later update and
// writes it into every snapshot, until the missing changes arrive. Normal
// flows never leave anything there: every client syncs the room before it
// edits, and its sync step 2 carries everything the room lacks
// (routes/test/wsUpdateGuard.test.ts measures the desktop's first sync, a
// paste of 1000 parts and an offline session: 0 bytes). So a room holds at
// most MAX_PENDING_BYTES of it, together with the updates the live handler
// holds back whole instead (held.ts: one that would also delete something
// the room has, before what replaces it lands).

import * as Y from 'yjs';
import type { DecodedUpdate } from './decoded.js';
import { TokenBucket, copyBudget, wsPacing } from './pacing.js';

/** Pending bytes (structs + deletions) one room holds at most. */
export const MAX_PENDING_BYTES = 2 * 1024 * 1024;

/**
 * Pending deletions one room holds at most. Yjs reads all of them again on
 * every update the room takes (utils/encoding.js readUpdateV2), so they
 * cost every edit of everyone in the room; normal flows leave none.
 */
export const MAX_PENDING_DS_BYTES = 16 * 1024;

/** The clients whose changes the pending deletions wait for, read once per pending record. */
const dsClients = new WeakMap<Uint8Array, Set<number>>();
function pendingDsClients(ds: Uint8Array): Set<number> {
  let out = dsClients.get(ds);
  if (!out) {
    try {
      out = new Set(Y.decodeUpdateV2(ds).ds.clients.keys());
    } catch {
      out = new Set();
    }
    dsClients.set(ds, out);
  }
  return out;
}

/**
 * Could what is pending in `doc` land with `update`? Yjs retries pending
 * structs only once a client they wait for gets past the clock they wait
 * for, and applies a pending deletion only to a struct that arrives: so
 * only an update with structs of such a client can. Every other update
 * lands on the document as it is, whatever waits.
 */
export function pendingMayLand(doc: Y.Doc | null, update: DecodedUpdate): boolean {
  const ps = doc?.store.pendingStructs;
  const pds = doc?.store.pendingDs;
  if (!ps && !pds) return false;
  const deletes = pds ? pendingDsClients(pds) : null;
  for (const [client, structs] of update.byClient) {
    if (deletes?.has(client)) return true;
    const waits = ps?.missing.get(client);
    if (waits === undefined) continue;
    for (const s of structs) if (s.id.clock + s.length > waits) return true;
  }
  return false;
}

export interface PendingState {
  structs: { missing: Map<number, number>; update: Uint8Array } | null;
  ds: Uint8Array | null;
  bytes: number;
}

/** Pending deletion bytes (MAX_PENDING_DS_BYTES). */
export function pendingDsBytes(doc: Y.Doc): number {
  return doc.store.pendingDs?.length ?? 0;
}

export function pendingBytes(doc: Y.Doc): number {
  const { pendingStructs, pendingDs } = doc.store;
  return (pendingStructs?.update.length ?? 0) + (pendingDs?.length ?? 0);
}

/** What is pending now (a copy: Yjs updates its pending record in place). */
export function savePending(doc: Y.Doc): PendingState {
  const { pendingStructs, pendingDs } = doc.store;
  return {
    structs: pendingStructs ? { missing: new Map(pendingStructs.missing), update: pendingStructs.update } : null,
    ds: pendingDs,
    bytes: pendingBytes(doc),
  };
}

/**
 * Put back what was pending before. What an update integrated stays (it is
 * in the doc, stored and sent); only what it left waiting goes. Anything of
 * the saved state that has since been integrated is skipped by Yjs when it
 * retries it, so this never changes the doc.
 */
export function restorePending(doc: Y.Doc, saved: PendingState): void {
  doc.store.pendingStructs = saved.structs ? { missing: new Map(saved.structs.missing), update: saved.structs.update } : null;
  doc.store.pendingDs = saved.ds;
}

/** Drop everything pending (it can't be read until changes nobody sent arrive). */
export function dropPending(doc: Y.Doc): void {
  doc.store.pendingStructs = null;
  doc.store.pendingDs = null;
}

// ---- who pays for changes waiting on another editor -------------------------
//
// Waiting changes normally wait on their own client's earlier ones (an
// update the room refused). Changes that wait on another client land with
// that client's edits, and an edit they land with is worked out on a copy
// of the layout (gridGuard.ts). That copy is charged to the room's budget
// and to whoever left the changes waiting, never to the editor whose edit
// they land with. When either is spent, the waiting changes are dropped
// instead of copied (nobody is slowed down for them), and no one may leave
// more changes waiting on another client in that room until it refills.

interface RoomWaits {
  /** The clients changes wait on that aren't their own, and who left them waiting (null: unknown, from a snapshot). */
  foreign: Map<number, Set<string | null>>;
  budget: TokenBucket;
}

const rooms = new WeakMap<Y.Doc, RoomWaits>();

function roomWaits(doc: Y.Doc): RoomWaits {
  let r = rooms.get(doc);
  if (!r) {
    r = { foreign: new Map(), budget: new TokenBucket(wsPacing.roomCopyByteBurst, wsPacing.roomCopyBytesPerSecond / 1000) };
    rooms.set(doc, r);
  }
  return r;
}

/** The clients what waits in `doc` waits on (structs and deletions). */
function waitedOn(doc: Y.Doc): Set<number> {
  const out = new Set<number>(doc.store.pendingStructs?.missing.keys() ?? []);
  if (doc.store.pendingDs) for (const c of pendingDsClients(doc.store.pendingDs)) out.add(c);
  return out;
}

/** A room opened with changes waiting: who left them is unknown, so each counts as waiting on another client. */
export function noteWaitingOnOpen(doc: Y.Doc): void {
  const r = roomWaits(doc);
  r.foreign.clear();
  for (const c of waitedOn(doc)) r.foreign.set(c, new Set([null]));
}

/**
 * The clients `update` left changes waiting on that aren't its own (none
 * of its structs are theirs), compared with what waited before
 * (`before`: savePending's).
 */
export function newForeignWaits(doc: Y.Doc, before: PendingState, update: DecodedUpdate | null): number[] {
  const had = new Set<number>(before.structs?.missing.keys() ?? []);
  if (before.ds) for (const c of pendingDsClients(before.ds)) had.add(c);
  const own = new Set(update?.byClient.keys() ?? []);
  return [...waitedOn(doc)].filter((c) => !had.has(c) && !own.has(c));
}

/** Whether changes waiting on another client may be left in this room now (its budget isn't spent). */
export function mayLeaveForeignWaits(doc: Y.Doc): boolean {
  return roomWaits(doc).budget.available();
}

/** Remember that `userId` left changes waiting on `clients`. */
export function noteForeignWaits(doc: Y.Doc, clients: readonly number[], userId: string): void {
  const r = roomWaits(doc);
  for (const c of clients) {
    const by = r.foreign.get(c);
    if (by) by.add(userId);
    else r.foreign.set(c, new Set([userId]));
  }
}

/** Who pays for working an update out on a copy: the sender, or the room and whoever left the changes it lands. */
export interface CopyPayer {
  available: () => boolean;
  charge: (bytes: number) => void;
  /** True when the room pays (changes waiting on another client land with it). */
  room: boolean;
}

/**
 * The payer of `update`'s copy, if it needs one. When changes waiting on
 * another client may land with it and their budget is spent, what waits
 * is dropped first (the update is then worked out as in a room with
 * nothing waiting, by its sender).
 */
export function copyPayer(doc: Y.Doc, update: DecodedUpdate | null, senderId: string): CopyPayer {
  const sender = copyBudget(senderId);
  const own: CopyPayer = { available: () => sender.available(), charge: (n) => sender.charge(n), room: false };
  const r = rooms.get(doc);
  if (!update || !r || r.foreign.size === 0) return own;
  // Forget clients nothing waits on any more (what waited landed, or was dropped).
  const waiting = waitedOn(doc);
  for (const c of r.foreign.keys()) if (!waiting.has(c)) r.foreign.delete(c);
  if (!pendingMayLand(doc, update)) return own;
  const leftBy = new Set<string | null>();
  for (const c of update.byClient.keys()) for (const u of r.foreign.get(c) ?? []) leftBy.add(u);
  if (leftBy.size === 0) return own;
  const payers = [r.budget, ...[...leftBy].filter((u): u is string => u !== null).map((u) => copyBudget(u))];
  if (!payers.every((b) => b.available())) {
    dropPending(doc);
    r.foreign.clear();
    return own;
  }
  return { available: () => payers.every((b) => b.available()), charge: (n) => payers.forEach((b) => b.charge(n)), room: true };
}

/** Forget every room's waiting record (tests). */
export function resetRoomWaits(doc: Y.Doc): void {
  rooms.delete(doc);
}
