// What the fuzz targets (guard.ts, room.ts) hold true of the server's live
// path, whatever bytes come in. A broken one throws PropertyFailure, which
// the fuzzer reports as a finding and keeps the input of.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as Y from 'yjs';
import { MAX_CLOCK, checkStateVector, checkUpdate } from '../ws/updateGuard.js';
import { decodeIncoming } from '../ws/decoded.js';
import { yjsWork } from '../ws/yjsWork.js';

export class PropertyFailure extends Error {
  override name = 'PropertyFailure';
}

export function fail(why: string): never {
  throw new PropertyFailure(why);
}

/**
 * The most time one message (or one input of the guard target) may take,
 * in ms. The server's own limits keep a message to tens of ms; this is far
 * above that so a busy machine doesn't trip it, and far below what a
 * quadratic blowup on a fuzz-sized input takes.
 */
export const BUDGET_MS = Number(process.env.FUZZ_BUDGET_MS ?? 1000);

/** Run `fn`, and fail when it takes longer than BUDGET_MS. */
export function timed<T>(what: string, fn: () => T): T {
  const t0 = performance.now();
  const out = fn();
  const ms = performance.now() - t0;
  if (ms > BUDGET_MS) fail(`${what} took ${ms.toFixed(0)} ms (budget ${BUDGET_MS} ms)`);
  return out;
}

/**
 * The desktop's limit on the work of one update (src/sync/UpdateGuard.h
 * kMaxUpdateWork): twice the server's, so whatever the server relays fits.
 */
export const DESKTOP_MAX_UPDATE_WORK = 8_000_000;

/**
 * Whatever the server sends a desktop (a relayed update, a sync step 2, a
 * whole layout) must pass the desktop's guard: the same rules as
 * updateGuard.ts (fixtures/contracts/update-guard.json), and no more work
 * than the desktop takes on `onto` (null: a document of its own).
 */
export function desktopReads(update: Uint8Array, what: string, onto: Y.Doc | null): void {
  const why = checkUpdate(update);
  if (why !== null) fail(`${what}: the desktop's guard refuses it (${why})`);
  const decoded = decodeIncoming(update);
  if (!decoded) fail(`${what}: Yjs can't read what it wrote`);
  const work = yjsWork(onto, decoded);
  if (work > DESKTOP_MAX_UPDATE_WORK) fail(`${what}: the desktop refuses it for its work (${work} steps)`);
}

/** Every struct of `doc` ends within MAX_CLOCK (read from the store, not the encoding). */
export function clocksInRange(doc: Y.Doc, what: string): void {
  for (const [client, structs] of doc.store.clients) {
    const last = structs[structs.length - 1];
    if (last && last.id.clock + last.length - 1 > MAX_CLOCK) fail(`${what}: client ${client} has a clock past ${MAX_CLOCK}`);
  }
}

/** The state vector as a comparable string (sorted by client). */
export function stateKey(doc: Y.Doc): string {
  return [...Y.decodeStateVector(Y.encodeStateVector(doc))]
    .sort((a, b) => a[0] - b[0])
    .map(([c, k]) => `${c}:${k}`)
    .join(',');
}

/** The repository's apps/server folder (fuzz data and migrations are read from it). */
export function serverDir(): string {
  return process.env.FUZZ_SERVER_DIR ?? process.cwd();
}

export function fuzzData(...path: string[]): string {
  return resolve(serverDir(), 'fuzz', ...path);
}

export interface ContractVector {
  what: string;
  kind: 'update' | 'stateVector' | 'document';
  hex: string;
  refused: boolean;
  contains?: string;
}

export interface UpdateGuardContract {
  vectors: ContractVector[];
  gridSize: { base: string; vectors: ContractVector[] };
  drawingSettings: { base: string; vectors: ContractVector[] };
}

let contract: UpdateGuardContract | null = null;

/**
 * The shared vectors (fixtures/contracts/update-guard.json), checked once
 * against the guard: the harness's notion of what the desktop accepts is
 * the guard's own, so the two must agree on every vector first.
 */
export function updateGuardContract(): UpdateGuardContract {
  if (contract) return contract;
  const c = JSON.parse(readFileSync(resolve(serverDir(), '../../fixtures/contracts/update-guard.json'), 'utf8')) as UpdateGuardContract;
  for (const v of c.vectors) {
    const bytes = fromHex(v.hex);
    const why = v.kind === 'stateVector' ? checkStateVector(bytes) : checkUpdate(bytes);
    if ((why !== null) !== v.refused) throw new Error(`the update guard disagrees with the contract on "${v.what}"`);
  }
  contract = c;
  return c;
}

export function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}
