// Updates the live handler holds back until the edit before them arrives.
//
// An update of a client can reach the room before an earlier one of the
// same client it follows: an edit made as a connection comes back, sent
// before the sync step 2 that carries the offline ones, or messages of one
// editor over several sockets. Yjs keeps such structs waiting
// (pending.ts), but applies the update's deletions at once. A drawing
// setting's change is the new value and the deletion of the old one: the
// old value went, the new one waited, and for a while the sheet had none
// (a grid without a cell size). The grid guard refused that, closing the
// connection with 1008, after which neither app sends the change again.
//
// So an update that would leave structs waiting and delete something the
// room has is held whole, structs and deletions together, and not applied
// (or stored, or relayed) until what it waits for has arrived. Then it is
// checked and applied like any update, as one. Held updates belong to the
// connection that sent them and are dropped when it closes (the app's
// next sync step 2 carries them again) or the room unloads, and a room
// holds at most MAX_HELD_UPDATES of them, within MAX_PENDING_BYTES
// together with what Yjs keeps waiting.

import * as Y from 'yjs';
import type { DecodedUpdate, DeleteSet } from './decoded.js';

/** Updates one room holds back at most (their bytes count against MAX_PENDING_BYTES, pending.ts). */
export const MAX_HELD_UPDATES = 64;

/** Passes over an update's references before giving up (only a hand-made update needs more than a few). */
const MAX_PASSES = 16;

/**
 * A change the room must have before `update` can be applied without
 * leaving any of it waiting, or null when nothing of it waits (or it is a
 * shape worked out the way Yjs would anyway: two structs for one clock, a
 * struct pointing at a later one of its own client, references in a
 * cycle). The room has the change once Y.getState(store, client) > clock.
 * It is a change the update can't bring itself, so the update can't be
 * applied whole before the room has it.
 */
export function waitsOn(doc: Y.Doc, update: DecodedUpdate): Y.ID | null {
  if (update.overlapping) return null;
  const state = (c: number) => Y.getState(doc.store, c);
  // How far each client's structs would integrate (exclusive end of the
  // run from the room's state on), the index of the first that wouldn't,
  // and why it wouldn't: a change of its own client before it, or one it
  // points at that the room doesn't have.
  const reach = new Map<number, number>();
  const stop = new Map<number, number>();
  const why = new Map<number, Y.ID>();
  for (const [c, list] of update.byClient) {
    let cur = state(c);
    let i = 0;
    for (; i < list.length; i++) {
      const s = list[i]!;
      if (s.id.clock > cur) {
        why.set(c, Y.createID(c, s.id.clock - 1));
        break;
      }
      // A skip brings nothing: what follows it waits for the clocks it skips.
      if (!(s instanceof Y.Skip)) cur = Math.max(cur, s.id.clock + s.length);
    }
    reach.set(c, cur);
    stop.set(c, i);
  }
  const has = (id: Y.ID) => id.clock < (reach.get(id.client) ?? state(id.client));
  for (let pass = 0; ; pass++) {
    if (pass === MAX_PASSES) return null;
    let changed = false;
    for (const [c, list] of update.byClient) {
      const end = stop.get(c)!;
      for (let i = 0; i < end; i++) {
        const s = list[i]!;
        if (!(s instanceof Y.Item) || s.id.clock + s.length <= state(c)) continue;
        let missing: Y.ID | null = null;
        for (const ref of [s.origin, s.rightOrigin, s.parent instanceof Y.ID ? s.parent : null]) {
          if (!ref) continue;
          if (ref.client === c) {
            if (ref.clock >= s.id.clock) return null; // Yjs can't read it: left to Yjs
            continue; // an earlier struct of the same run
          }
          if (!has(ref)) {
            missing = ref;
            break;
          }
        }
        if (missing) {
          stop.set(c, i);
          reach.set(c, Math.max(state(c), s.id.clock));
          why.set(c, missing);
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }
  // The last clock each client's structs in the update would bring (a trailing skip brings nothing).
  const brings = (c: number): number => {
    const list = update.byClient.get(c);
    if (!list) return 0;
    for (let i = list.length - 1; i >= 0; i--) if (!(list[i] instanceof Y.Skip)) return list[i]!.id.clock + list[i]!.length;
    return 0;
  };
  for (const [c, list] of update.byClient) {
    if (stop.get(c)! >= list.length) continue;
    const need = why.get(c)!;
    // A change of a client whose own structs here would bring it, once they
    // can: theirs is the one to wait for (another client of the loop).
    const blocked = stop.get(need.client) !== undefined && stop.get(need.client)! < update.byClient.get(need.client)!.length;
    if (need.client !== c && blocked && need.clock < brings(need.client)) continue;
    return need;
  }
  // Nothing waits; or every client waits on another's structs in the update (a cycle), left to Yjs.
  return null;
}

/** Does `ds` delete anything the room has (and hasn't deleted yet)? */
export function deletesPresent(doc: Y.Doc, ds: DeleteSet): boolean {
  for (const [client, ranges] of ds.clients) {
    const list = doc.store.clients.get(client);
    if (!list || list.length === 0) continue;
    const state = Y.getState(doc.store, client);
    for (const r of ranges) {
      const end = Math.min(r.clock + r.len, state);
      if (r.clock >= end) continue;
      for (let i = Y.findIndexSS(list, Math.max(r.clock, list[0]!.id.clock)); i < list.length && list[i]!.id.clock < end; i++) {
        const s = list[i]!;
        if (s instanceof Y.Item && !s.deleted) return true;
      }
    }
  }
  return false;
}

/** An update held back, and the connection it came from. */
export interface HeldUpdate<C, S> {
  client: C;
  sender: S;
  update: Uint8Array;
  decoded: DecodedUpdate;
  /** waitsOn's answer when last worked out: nothing to do until the room has it. */
  waitsFor: Y.ID;
}

/** A room's held updates, in the order they arrived. */
export class HeldUpdates<C, S> {
  private list: HeldUpdate<C, S>[] = [];
  private total = 0;

  get count(): number {
    return this.list.length;
  }

  /** Their bytes. */
  get bytes(): number {
    return this.total;
  }

  add(entry: HeldUpdate<C, S>): void {
    this.list.push(entry);
    this.total += entry.update.length;
  }

  /** The first held update that can now be applied whole, taken out; null when none can. */
  takeReady(doc: Y.Doc): HeldUpdate<C, S> | null {
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i]!;
      if (Y.getState(doc.store, e.waitsFor.client) <= e.waitsFor.clock) continue;
      const next = waitsOn(doc, e.decoded);
      if (next) {
        e.waitsFor = next;
        continue;
      }
      this.list.splice(i, 1);
      this.total -= e.update.length;
      return e;
    }
    return null;
  }

  /** Drop what a connection holds (it closed). */
  drop(client: C): void {
    if (!this.list.some((e) => e.client === client)) return;
    this.list = this.list.filter((e) => e.client !== client);
    this.total = this.list.reduce((n, e) => n + e.update.length, 0);
  }

  /** Drop everything (the room unloads). */
  clear(): void {
    this.list = [];
    this.total = 0;
  }

  /** The connections holding updates (tests). */
  holders(): C[] {
    return [...new Set(this.list.map((e) => e.client))];
  }
}
