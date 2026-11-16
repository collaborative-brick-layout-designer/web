// The lock on shared (read-only) modules, on the server
// (docs/shared-modules.md, "Keeping it read-only").
//
// A shared placed module's parts are its owner's: the apps let people move,
// turn and remove the module as a whole, and nothing else. Their tools
// refuse the rest with a plain reason, so a normal app never sends such a
// change; this check is for an outdated or broken one. It runs on every
// incoming update BEFORE it is applied, and refuses one that would leave a
// module that was shared:
//
//   - with different parts: one added, one taken out (deleted without the
//     whole module going), or one whose part number (its color too) or
//     height changed;
//   - no longer shared, or following another library module, while it is
//     still in the layout ("Make it mine" is the server's step, for the
//     people who may);
//   - gone, with some of its parts left behind as loose parts.
//
// Allowed: moving and turning its parts (where they are isn't checked
// here), putting it on another sheet (the same part ids deleted and added
// again), removing it whole, its name colors, pin and placement, and
// anything about modules that aren't shared. The server's own steps
// (sharedModules/apply.ts) aren't checked: they don't come through here.
//
// What is compared is what the layout reads as before and after, not the
// keys an update happens to write, so two apps racing (one removing the
// module as the other moves it; an update arriving as the server puts a
// new version in) are never refused for it.
//
// A layout without shared modules pays nothing. With some, an update that
// can't touch them (it writes no sidecar value, deletes none of their
// parts and sets none of their parts' locked fields) is let through from
// its structs alone; the rest are worked out on a copy of the layout,
// against the sender's copy budget (ws/pacing.ts), like the grid guard.

import * as Y from 'yjs';
import { readSidecarCache } from '@cld/ydoc';
import { sharedModulesIn } from '@cld/modules';
import { guardWork, type DecodedUpdate } from './decoded.js';

/** sharedLockProblem's answer when the update needs a copy and `mayCopy` says no: slow the sender down. */
export const LOCK_COPY_BUDGET_SPENT = 'it needs a copy of the layout to check its shared modules, and its sender has used up their copies for now';

/** A part's fields that are its owner's: which part it is, and its height. */
const LOCKED_FIELDS = new Set(['id', 'partNumber', 'altitude']);
/** Root maps that hold the sidecar (modules, their part keys). */
const SIDECAR_ROOTS = new Set(['sidecarItems', 'meta']);

interface Locked {
  /** The library module it follows. */
  follows: string;
  /** Its parts: id → what is locked about each. */
  parts: Map<string, string>;
}

interface LockState {
  /** Shared placed modules by their id in the layout. */
  shared: Map<string, Locked>;
  /** Every module id in the layout's sidecar. */
  modules: Set<string>;
  /** Every part id on the map. */
  alive: Set<string>;
}

function sidecarModules(doc: Y.Doc): { id: string }[] {
  const cache = readSidecarCache(doc);
  return Array.isArray(cache?.modules) ? (cache.modules as { id: string }[]).filter((m) => m && typeof m.id === 'string') : [];
}

/** What the layout's shared modules hold right now. `full` also lists every part id (for the after side). */
function lockState(doc: Y.Doc): LockState {
  const cache = readSidecarCache(doc);
  const placed = sharedModulesIn(cache);
  const wanted = new Set<string>();
  for (const p of placed) for (const id of p.members) wanted.add(id);
  const sig = new Map<string, string>();
  const alive = new Set<string>();
  for (const layer of doc.getMap<unknown>('layerData').values()) {
    if (!(layer instanceof Y.Map)) continue;
    const bricks = layer.get('bricks');
    if (!(bricks instanceof Y.Array)) continue;
    for (const b of bricks) {
      if (!(b instanceof Y.Map)) continue;
      const id = b.get('id');
      if (typeof id !== 'string') continue;
      alive.add(id);
      if (wanted.has(id)) sig.set(id, `${String(b.get('partNumber'))}\u0000${String(b.get('altitude') ?? 0)}`);
    }
  }
  const shared = new Map<string, Locked>();
  for (const p of placed) {
    const parts = new Map<string, string>();
    for (const id of p.members) {
      const s = sig.get(id);
      if (s !== undefined) parts.set(id, s);
    }
    shared.set(p.placedId, { follows: p.moduleId, parts });
  }
  return { shared, modules: new Set(sidecarModules(doc).map((m) => m.id)), alive };
}

/** Why `after` breaks a lock that `before` held, or null. */
export function lockBroken(before: LockState, after: LockState): string | null {
  for (const [id, was] of before.shared) {
    const now = after.shared.get(id);
    if (!now) {
      if (after.modules.has(id)) return 'it unlocks a shared module (only "Make it mine" does that)';
      for (const part of was.parts.keys()) {
        if (after.alive.has(part)) return 'it removes a shared module but leaves some of its parts';
      }
      continue;
    }
    if (now.follows !== was.follows) return 'it makes a shared module follow another module';
    // Removed whole, its record left by a change made at the same moment.
    if (now.parts.size === 0) continue;
    if (now.parts.size !== was.parts.size) return now.parts.size < was.parts.size ? 'it takes a part out of a shared module' : 'it adds a part to a shared module';
    for (const [part, sig] of was.parts) {
      const s = now.parts.get(part);
      if (s === undefined) return 'it swaps a part of a shared module for another';
      if (s !== sig) return 'it changes a part of a shared module';
    }
  }
  return null;
}

/** The root map's name when `type` is one, else null. */
function rootName(doc: Y.Doc, type: Y.AbstractType<unknown> | null): string | null {
  if (!type || type._item !== null) return null;
  for (const [name, t] of doc.share) if (t === type) return name;
  return null;
}

/**
 * Whether the item (in the room's store) is something an update may not
 * touch without a closer look: a sidecar value, a whole sheet's data, a
 * locked field of a shared module's part, or such a part itself.
 */
function touchy(doc: Y.Doc, item: Y.Item, members: ReadonlySet<string>): boolean {
  const parent = item.parent as Y.AbstractType<unknown> | null;
  if (item.parentSub !== null) {
    const root = rootName(doc, parent);
    if (root !== null) return SIDECAR_ROOTS.has(root) || root === 'layerData';
    if (!LOCKED_FIELDS.has(item.parentSub)) return false;
    const id = parent instanceof Y.Map ? parent.get('id') : undefined;
    // A part whose id can't be read is looked at closely.
    return typeof id !== 'string' || members.has(id);
  }
  const c = item.content;
  if (c instanceof Y.ContentType && c.type instanceof Y.Map) {
    const id = c.type.get('id');
    return typeof id === 'string' && members.has(id);
  }
  return false;
}

/**
 * Whether `decoded` could change anything about the layout's shared
 * modules: it writes or deletes a sidecar value or a sheet, deletes one of
 * their parts, or sets a locked field of one. Anything it can't tell
 * counts as yes.
 */
export function mayTouchShared(doc: Y.Doc, decoded: DecodedUpdate, members: ReadonlySet<string>): boolean {
  try {
    const known = (id: Y.ID): boolean => id.clock < Y.getState(doc.store, id.client);
    for (const s of decoded.structs) {
      if (!(s instanceof Y.Item)) continue;
      if (typeof s.parent === 'string') {
        // Written straight into a root: the sidecar's maps matter; a new sheet, part list entry or layer doesn't.
        if (SIDECAR_ROOTS.has(s.parent)) return true;
        continue;
      }
      if (s.parent !== null) {
        // Inside a nested type, named by id: a field of a part (or sheet) that is already in the room?
        const pid = s.parent as unknown as Y.ID;
        if (s.parentSub !== null && LOCKED_FIELDS.has(s.parentSub) && known(pid)) {
          const holder = Y.getItem(doc.store, pid);
          const type = holder instanceof Y.Item && holder.content instanceof Y.ContentType ? holder.content.type : null;
          const id = type instanceof Y.Map ? type.get('id') : undefined;
          if (typeof id !== 'string' || members.has(id)) return true;
        }
        continue;
      }
      // Its place comes from its neighbour (a value that replaces one, or a list entry next to one).
      const ref: Y.ID | null = s.origin ?? s.rightOrigin;
      if (!ref || !known(ref)) continue;
      const there = Y.getItem(doc.store, ref);
      if (there instanceof Y.Item && there.parentSub !== null && touchy(doc, there, members)) return true;
    }
    for (const [client, ranges] of decoded.ds.clients) {
      const state = Y.getState(doc.store, client);
      for (const r of ranges) {
        const end = Math.min(r.clock + r.len, state);
        let clock = r.clock;
        while (clock < end) {
          const item = Y.getItem(doc.store, Y.createID(client, clock));
          if (item instanceof Y.Item && !item.deleted && touchy(doc, item, members)) return true;
          clock = item.id.clock + item.length;
        }
      }
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Null when `update` leaves the layout's shared modules as they are; else
 * why not, for the log (or LOCK_COPY_BUDGET_SPENT when `mayCopy` says the
 * sender may not have a copy made right now).
 */
export function sharedLockProblem(doc: Y.Doc, update: Uint8Array, decoded: DecodedUpdate, mayCopy?: () => boolean): string | null {
  const placed = sharedModulesIn(readSidecarCache(doc));
  if (placed.length === 0) return null;
  const members = new Set<string>();
  for (const p of placed) for (const id of p.members) members.add(id);
  if (!mayTouchShared(doc, decoded, members)) return null;
  if (mayCopy && !mayCopy()) return LOCK_COPY_BUDGET_SPENT;
  guardWork.docCopies += 1;
  const after = new Y.Doc();
  try {
    const state = Y.encodeStateAsUpdate(doc);
    guardWork.copyBytes += state.length;
    Y.applyUpdate(after, state);
    try {
      Y.applyUpdate(after, update);
    } catch {
      // Yjs throws part-way through some hand-made updates and keeps what
      // it applied before (the room would too): that is what is checked.
    }
    return lockBroken(lockState(doc), lockState(after));
  } catch {
    return null; // the room's own document can't be copied: nothing to compare
  } finally {
    after.destroy();
  }
}
