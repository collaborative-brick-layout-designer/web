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
//   - gone, with some of its parts left behind as loose parts;
//   - pulled apart: its parts not moved together (rigidMoveProblem). The
//     distances between their centers and the differences between their
//     turns have to stay the same, within a little for float rounding.
//
// Allowed: moving and turning it as a whole, putting it on another sheet
// (the same part ids deleted and added again), removing it whole, its name
// colors, pin and placement, and anything about modules that aren't
// shared. The server's own steps (sharedModules/apply.ts) aren't checked:
// they don't come through here.
//
// Also put back: a part a shared module's updates took out (`shared.retired`)
// that an update brings back, as undoing a change of sheet made before the
// update does in an app that doesn't finish its undo (settle rule 0).
//
// What happens to an update that breaks the lock (ws/handler.ts): it is
// taken, and the server then puts the modules it broke back as they were,
// in a step of its own that everyone gets (repairShared). Closing the
// connection instead (as the other guards do) would leave the change in
// the app's copy, and a desktop sends its saved copy again each time the
// layout is opened: refused again and again. Putting it back works the
// same for every app, old ones included.
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
import { readSidecarCache, writeSidecarCache } from '@cld/ydoc';
import { norm360, pivotOf, settleRetired, sharedModulesIn, type PartLookup, type Pt } from '@cld/modules';
import { guardWork, type DecodedUpdate } from './decoded.js';
import { pendingMayLand } from './pending.js';

/** sharedLockProblem's answer when the update needs a copy and `mayCopy` says no: slow the sender down. */
export const LOCK_COPY_BUDGET_SPENT = 'it needs a copy of the layout to check its shared modules, and its sender has used up their copies for now';

/** A part's fields that are its owner's: which part it is, and its height. */
const LOCKED_FIELDS = new Set(['id', 'partNumber', 'altitude']);
/** A part's fields that say where it is: a shared module's parts have to move together. */
const POSE_FIELDS = new Set(['displayArea', 'orientation']);
const LOOKED_AT = new Set([...LOCKED_FIELDS, ...POSE_FIELDS]);
/** Root maps that hold the sidecar (modules, their part keys). */
const SIDECAR_ROOTS = new Set(['sidecarItems', 'meta']);

/** Where a part is: its box, its turn, and which part it is (for its pivot). */
export interface PartPose {
  area: { x: number; y: number; width: number; height: number };
  o: number;
  pn: string;
}

interface Locked {
  /** The library module it follows. */
  follows: string;
  /** Its parts: id → what is locked about each. */
  parts: Map<string, string>;
  /** Its parts: id → where each is (those that can be read; the first of each). */
  poses: Map<string, PartPose>;
  /** Where its parts are, when an id is on the map more than once: the first of each id, the second, ... */
  sets: Map<string, PartPose>[];
  /** How many of each part are on the map (a pair moving it to another sheet at once makes two of each). */
  counts: Map<string, number>;
}

interface PartSnap {
  /** The sheet it was on. */
  layerId: string;
  /** All its fields, as they were. */
  fields: Record<string, unknown>;
}

export interface LockState {
  /** Shared placed modules by their id in the layout. */
  shared: Map<string, Locked>;
  /** Every module id in the layout's sidecar. */
  modules: Set<string>;
  /** Every part id on the map. */
  alive: Set<string>;
  /** The shared modules' sidecar values, and their parts as they were (the before side only, to put them back). */
  values?: Map<string, Record<string, unknown>>;
  snaps?: Map<string, PartSnap[]>;
}

function sidecarModules(doc: Y.Doc): Record<string, unknown>[] {
  const cache = readSidecarCache(doc);
  return Array.isArray(cache?.modules) ? (cache.modules as Record<string, unknown>[]).filter((m) => m && typeof m.id === 'string') : [];
}

function readPose(b: Y.Map<unknown>): PartPose | null {
  const a = b.get('displayArea') as PartPose['area'] | undefined;
  if (!a || typeof a !== 'object') return null;
  const nums = [a.x, a.y, a.width, a.height];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const o = b.get('orientation') ?? 0;
  if (typeof o !== 'number' || !Number.isFinite(o)) return null;
  return { area: { x: a.x, y: a.y, width: a.width, height: a.height }, o, pn: String(b.get('partNumber') ?? '') };
}

/** What the layout's shared modules hold right now. `keep` also keeps what it takes to put them back. */
export function lockState(doc: Y.Doc, keep = false): LockState {
  const cache = readSidecarCache(doc);
  const placed = sharedModulesIn(cache);
  const wanted = new Set<string>();
  for (const p of placed) for (const id of p.members) wanted.add(id);
  const sig = new Map<string, string>();
  const counts = new Map<string, number>();
  const copies = new Map<string, (PartPose | null)[]>();
  const snaps = keep ? new Map<string, PartSnap[]>() : undefined;
  const alive = new Set<string>();
  const layerData = doc.getMap<unknown>('layerData');
  for (const [layerId, layer] of layerData) {
    if (!(layer instanceof Y.Map)) continue;
    const bricks = layer.get('bricks');
    if (!(bricks instanceof Y.Array)) continue;
    for (const b of bricks) {
      if (!(b instanceof Y.Map)) continue;
      const id = b.get('id');
      if (typeof id !== 'string') continue;
      alive.add(id);
      if (!wanted.has(id)) continue;
      const s = `${String(b.get('partNumber'))}\u0000${String(b.get('altitude') ?? 0)}`;
      const had = sig.get(id);
      if (had === undefined) sig.set(id, s);
      // Copies that aren't all the same: each kind, in an order of its own.
      else if (had !== s) sig.set(id, [...new Set([...had.split('\u0001'), s])].sort().join('\u0001'));
      counts.set(id, (counts.get(id) ?? 0) + 1);
      const at = copies.get(id);
      if (at) at.push(readPose(b));
      else copies.set(id, [readPose(b)]);
      if (snaps) {
        const snap = { layerId, fields: b.toJSON() as Record<string, unknown> };
        const list = snaps.get(id);
        if (list) list.push(snap);
        else snaps.set(id, [snap]);
      }
    }
  }
  const shared = new Map<string, Locked>();
  for (const p of placed) {
    const parts = new Map<string, string>();
    const sets: Map<string, PartPose>[] = [new Map()];
    const n = new Map<string, number>();
    for (const id of p.members) {
      const s = sig.get(id);
      if (s === undefined) continue;
      parts.set(id, s);
      n.set(id, counts.get(id)!);
      for (const [i, pose] of copies.get(id)!.entries()) {
        while (sets.length <= i) sets.push(new Map());
        if (pose) sets[i]!.set(id, pose);
      }
    }
    shared.set(p.placedId, { follows: p.moduleId, parts, poses: sets[0]!, sets, counts: n });
  }
  const all = sidecarModules(doc);
  const out: LockState = { shared, modules: new Set(all.map((m) => m.id as string)), alive };
  if (snaps) {
    out.values = new Map(all.filter((m) => shared.has(m.id as string)).map((m) => [m.id as string, structuredClone(m)]));
    out.snaps = snaps;
  }
  return out;
}

/** Why `after` breaks the lock module `id` held in `before` (its parts, its link), or null. */
function moduleBroken(id: string, was: Locked, after: LockState): string | null {
  const now = after.shared.get(id);
  if (!now) {
    if (after.modules.has(id)) return 'it unlocks a shared module (only "Make it mine" does that)';
    for (const part of was.parts.keys()) {
      if (after.alive.has(part)) return 'it removes a shared module but leaves some of its parts';
    }
    return null;
  }
  if (now.follows !== was.follows) return 'it makes a shared module follow another module';
  // Removed whole, its record left by a change made at the same moment.
  if (now.parts.size === 0) return null;
  if (now.parts.size !== was.parts.size) return now.parts.size < was.parts.size ? 'it takes a part out of a shared module' : 'it adds a part to a shared module';
  for (const [part, sig] of was.parts) {
    const s = now.parts.get(part);
    if (s === undefined) return 'it swaps a part of a shared module for another';
    if (s !== sig) return 'it changes a part of a shared module';
  }
  // Two people moving it to another sheet at once make two of every part;
  // more of only some is a part added.
  const more = [...now.counts].some(([part, k]) => k > was.counts.get(part)!);
  if (more && new Set(now.counts.values()).size > 1) return 'it adds a part to a shared module';
  return null;
}

/** Why `after` breaks a lock that `before` held, or null (the parts and links only; rigidMoveProblem is the moves). */
export function lockBroken(before: LockState, after: LockState): string | null {
  for (const [id, was] of before.shared) {
    const why = moduleBroken(id, was, after);
    if (why) return why;
  }
  return null;
}

// ---- Moved together? ----------------------------------------------------------

/** Two turns this far apart (degrees) are the same. */
export const SAME_TURN = 0.05;
/** A part this far (studs) from where moving the module together puts it is still there; plus RIGID_REL of how far from the origin it is. */
export const RIGID_SLACK = 0.05;
export const RIGID_REL = 1e-5;
/** A part with a hull, turned: its pivot is worked out from its picture, which an app's library may have slightly differently. */
export const HULL_SLACK = 0.25;

const turnApart = (a: number, b: number): number => {
  const d = Math.abs(norm360(a) - norm360(b));
  return Math.min(d, 360 - d);
};
/** `a` - `b` in (-180, 180]. */
const signedTurn = (a: number, b: number): number => {
  const d = norm360(a - b);
  return d > 180 ? d - 360 : d;
};

/**
 * Why a shared module's parts didn't move together from `before` to
 * `after` (each part's pose by id; parts in only one of them aren't
 * looked at), or null. "Together": every part turned by the same amount,
 * and the distances between their centers stayed the same. A center is the
 * part's pivot (its sprite center) when `partOf` knows the part; else the
 * box center, which a turn moves differently for a part with a hull, so
 * such a part is let off by its size when the module turned (and a part
 * with a hull by HULL_SLACK). With fewer than two parts whose center is
 * known, a turned module isn't looked at (nothing to measure it by).
 */
export function rigidMoveProblem(before: ReadonlyMap<string, PartPose>, after: ReadonlyMap<string, PartPose>, partOf?: PartLookup): string | null {
  const ids = [...before.keys()].filter((id) => after.has(id));
  if (ids.length < 2) return null;
  const d0 = norm360(after.get(ids[0]!)!.o - before.get(ids[0]!)!.o);
  let sum = 0;
  for (const id of ids) {
    const d = norm360(after.get(id)!.o - before.get(id)!.o);
    if (turnApart(d, d0) > SAME_TURN) return 'it turns the parts of a shared module by different amounts';
    sum += signedTurn(d, d0);
  }
  const turn = norm360(d0 + sum / ids.length);
  const turned = turnApart(turn, 0) > SAME_TURN;
  const p: Pt[] = [];
  const q: Pt[] = [];
  const slack: number[] = [];
  let maxAbs = 0;
  for (const id of ids) {
    const b = before.get(id)!;
    const a = after.get(id)!;
    const part = partOf?.(b.pn);
    p.push(pivotOf({ displayArea: b.area, orientation: b.o }, part));
    q.push(pivotOf({ displayArea: a.area, orientation: a.o }, part));
    let s = 0;
    if (turned) {
      if (!part) s = Math.max(b.area.width, b.area.height, a.area.width, a.area.height);
      else if (part.hullPts?.length) s = HULL_SLACK;
    }
    slack.push(s);
    maxAbs = Math.max(maxAbs, Math.abs(p.at(-1)!.x), Math.abs(p.at(-1)!.y), Math.abs(q.at(-1)!.x), Math.abs(q.at(-1)!.y));
  }
  // Measured by the parts whose center is known (not let off by their size).
  const basis = ids.map((_, i) => i).filter((i) => slack[i]! <= HULL_SLACK);
  if (basis.length < 2) return null;
  const tol = RIGID_SLACK + RIGID_REL * maxAbs;
  // The best turn (or mirror and turn: only the distances are kept) taking
  // the parts' centers before onto them after, and how far each is off it.
  for (const mirror of [false, true]) {
    const from = p.map((v) => (mirror ? { x: v.x, y: -v.y } : v));
    const mid = (vs: Pt[]): Pt => {
      let x = 0;
      let y = 0;
      for (const i of basis) {
        x += vs[i]!.x;
        y += vs[i]!.y;
      }
      return { x: x / basis.length, y: y / basis.length };
    };
    const cp = mid(from);
    const cq = mid(q);
    let cross = 0;
    let dot = 0;
    for (const i of basis) {
      const u = { x: from[i]!.x - cp.x, y: from[i]!.y - cp.y };
      const v = { x: q[i]!.x - cq.x, y: q[i]!.y - cq.y };
      cross += u.x * v.y - u.y * v.x;
      dot += u.x * v.x + u.y * v.y;
    }
    const r = Math.atan2(cross, dot);
    const c = Math.cos(r);
    const s = Math.sin(r);
    let fits = true;
    for (let i = 0; i < ids.length && fits; i++) {
      const u = { x: from[i]!.x - cp.x, y: from[i]!.y - cp.y };
      const want = { x: cq.x + u.x * c - u.y * s, y: cq.y + u.x * s + u.y * c };
      if (Math.hypot(q[i]!.x - want.x, q[i]!.y - want.y) > tol + slack[i]!) fits = false;
    }
    if (fits) return null;
  }
  return 'it moves the parts of a shared module apart';
}

/**
 * The parts (of `members`) whose place the update writes over a value it
 * hadn't seen: someone else moved them meanwhile. The layout then holds
 * some of each person's move, which needn't be a move of the whole module,
 * and nobody is to blame for it, so their modules aren't measured.
 * (An app that writes a value replaces, and so deletes, the one it saw;
 * a part it deletes takes its fields with it.)
 */
export function racedParts(doc: Y.Doc, decoded: DecodedUpdate, members: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const seen = (item: Y.Item | null | undefined): boolean => !item || item.deleted || Y.isDeleted(decoded.ds, item.id);
  const known = (id: Y.ID): boolean => id.clock < Y.getState(doc.store, id.client);
  const partMap = (item: unknown): Y.Map<unknown> | null =>
    item instanceof Y.Item && item.content instanceof Y.ContentType && item.content.type instanceof Y.Map ? (item.content.type as Y.Map<unknown>) : null;
  const memberOf = (m: Y.Map<unknown> | null): string | null => {
    const id = m?.get('id');
    return typeof id === 'string' && members.has(id) ? id : null;
  };
  const head = (m: Y.Map<unknown>, key: string): Y.Item | undefined => (m as unknown as { _map: Map<string, Y.Item> })._map.get(key);
  try {
    for (const s of decoded.structs) {
      if (!(s instanceof Y.Item) || typeof s.parent === 'string') continue;
      let m: Y.Map<unknown> | null = null;
      let key: string | null = null;
      if (s.parent !== null) {
        // A field set for the first time: its map named by id.
        const pid = s.parent as unknown as Y.ID;
        if (s.parentSub === null || !known(pid)) continue;
        m = partMap(Y.getItem(doc.store, pid));
        key = s.parentSub;
      } else {
        // A value that replaces one: its map and key are the replaced value's.
        const ref: Y.ID | null = s.origin ?? s.rightOrigin;
        if (!ref || !known(ref)) continue;
        const there = Y.getItem(doc.store, ref);
        if (!(there instanceof Y.Item) || there.parentSub === null || !(there.parent instanceof Y.Map)) continue;
        m = there.parent as Y.Map<unknown>;
        key = there.parentSub;
      }
      if (!key || !POSE_FIELDS.has(key)) continue;
      const id = memberOf(m);
      if (id && !seen(head(m!, key))) out.add(id);
    }
    for (const [client, ranges] of decoded.ds.clients) {
      const state = Y.getState(doc.store, client);
      for (const r of ranges) {
        const end = Math.min(r.clock + r.len, state);
        let clock = r.clock;
        while (clock < end) {
          const item = Y.getItem(doc.store, Y.createID(client, clock));
          const m = item.deleted ? null : partMap(item);
          const id = memberOf(m);
          if (id) for (const k of POSE_FIELDS) if (!seen(head(m!, k))) out.add(id);
          clock = item.id.clock + item.length;
        }
      }
    }
  } catch {
    // Something it can't read: nobody is measured rather than someone wrongly.
    for (const id of members) out.add(id);
  }
  return out;
}

/** What an update broke: why (the first), and which shared modules, with the layout as it was before (to put them back). */
export interface LockBreak {
  why: string;
  modules: string[];
  before: LockState;
  /** Parts a shared module's updates took out (`shared.retired`) that it brought back: they go again (settle rule 0). */
  retiredBack: string[];
}

/** Why an update that brings back parts a shared module's updates took out is put back. */
export const RETIRED_BACK = 'it brings back a part an update of a shared module took out';

/**
 * Whether `decoded` writes a part id that is in `ids`: one of a shared
 * module's parts (its sheet changed, or a second one), or a part an update took out, put on the map again (an undo of a change of sheet made
 * before the update, in an app that doesn't finish it: settle rule 0).
 */
export function writesId(decoded: DecodedUpdate, ids: ReadonlySet<string>): boolean {
  if (ids.size === 0) return false;
  for (const s of decoded.structs) {
    if (!(s instanceof Y.Item) || s.parentSub !== 'id') continue;
    const c = s.content;
    const v = c instanceof Y.ContentAny ? c.arr[0] : c instanceof Y.ContentString ? c.str : undefined;
    if (typeof v === 'string' && ids.has(v)) return true;
  }
  return false;
}

/** Every shared module `after` breaks the lock of (parts, link, or moved apart), and why. */
function breaks(before: LockState, after: LockState, raced: ReadonlySet<string>, partOf?: PartLookup): { why: string; modules: string[] } | null {
  let why: string | null = null;
  const modules: string[] = [];
  for (const [id, was] of before.shared) {
    let w = moduleBroken(id, was, after);
    const now = after.shared.get(id);
    if (!w && now && now.parts.size > 0 && ![...was.parts.keys()].some((p) => raced.has(p))) {
      // Each set of its parts moved together from one that was there.
      for (const set of now.sets) {
        const apart = was.sets.map((from) => rigidMoveProblem(from, set, partOf));
        if (apart.every((x) => x !== null)) w = apart[0]!;
        if (w) break;
      }
    }
    if (!w) continue;
    why ??= w;
    modules.push(id);
  }
  return why ? { why, modules } : null;
}

/**
 * Put the modules `brk` names back as they were before the update: each
 * one's sidecar value (its parts, its link), and each of its parts' fields
 * (a part that went is put back, on the sheet it was on, with its id). One
 * transaction with `origin`, sent to everyone like any edit.
 */
export function repairShared(doc: Y.Doc, brk: LockBreak, origin: unknown): void {
  const values = brk.before.values;
  const snaps = brk.before.snaps;
  if (!values || !snaps) return;
  doc.transact(() => {
    // Parts an update took out that came back: gone again.
    if (brk.retiredBack.length > 0) {
      const back = new Set(brk.retiredBack);
      const data = doc.getMap<unknown>('layerData');
      for (const layer of data.values()) {
        const bricks = layer instanceof Y.Map ? layer.get('bricks') : undefined;
        if (!(bricks instanceof Y.Array)) continue;
        for (let i = bricks.length - 1; i >= 0; i--) {
          const b = bricks.get(i);
          if (b instanceof Y.Map && back.has(b.get('id') as string)) bricks.delete(i, 1);
        }
      }
    }
    if (brk.modules.length === 0) return;
    const layerData = doc.getMap<unknown>('layerData');
    const sheets = doc
      .getArray<string>('layers')
      .toArray()
      .filter((id) => {
        const l = layerData.get(id);
        return l instanceof Y.Map && l.get('bricks') instanceof Y.Array;
      });
    const theirs = new Set(brk.modules.flatMap((id) => [...(brk.before.shared.get(id)?.parts.keys() ?? [])]));
    const where = new Map<string, Y.Map<unknown>[]>();
    const extra = new Set<Y.Map<unknown>>();
    for (const [layerId, layer] of layerData) {
      const bricks = layer instanceof Y.Map ? layer.get('bricks') : undefined;
      if (!(bricks instanceof Y.Array)) continue;
      for (const b of bricks) {
        const id = b instanceof Y.Map ? b.get('id') : undefined;
        if (typeof id !== 'string' || !theirs.has(id)) continue;
        // On a sheet the layout doesn't list (any more), nobody sees it.
        if (!sheets.includes(layerId)) {
          extra.add(b as Y.Map<unknown>);
          continue;
        }
        const list = where.get(id);
        if (list) list.push(b as Y.Map<unknown>);
        else where.set(id, [b as Y.Map<unknown>]);
      }
    }
    // As many of each part as there were: more go.
    for (const [id, list] of where) for (const b of list.slice(snaps.get(id)?.length ?? list.length)) extra.add(b);
    if (extra.size > 0) {
      for (const layer of layerData.values()) {
        const bricks = layer instanceof Y.Map ? layer.get('bricks') : undefined;
        if (!(bricks instanceof Y.Array)) continue;
        for (let i = bricks.length - 1; i >= 0; i--) if (extra.has(bricks.get(i) as Y.Map<unknown>)) bricks.delete(i, 1);
      }
    }
    for (const partId of theirs) {
      for (const [k, snap] of (snaps.get(partId) ?? []).entries()) {
        const now = where.get(partId)?.[k];
        if (now) {
          for (const [f, v] of Object.entries(snap.fields)) if (JSON.stringify(now.get(f) ?? null) !== JSON.stringify(v ?? null)) now.set(f, structuredClone(v));
          continue;
        }
        const sheet = sheets.includes(snap.layerId) ? snap.layerId : sheets[0];
        if (sheet === undefined) continue;
        const y = new Y.Map<unknown>();
        for (const [f, v] of Object.entries(snap.fields)) y.set(f, structuredClone(v));
        ((layerData.get(sheet) as Y.Map<unknown>).get('bricks') as Y.Array<unknown>).push([y]);
      }
    }
    const cache = readSidecarCache(doc) ?? {};
    const list = sidecarModules(doc);
    const back = new Set(brk.modules.filter((id) => values.has(id)));
    const modules = list.map((m) => (back.has(m.id as string) ? structuredClone(values.get(m.id as string)!) : m));
    for (const id of back) if (!list.some((m) => m.id === id)) modules.push(structuredClone(values.get(id)!));
    writeSidecarCache(doc, { ...cache, modules });
  }, origin);
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
 * locked field of a shared module's part or where it is, or such a part
 * itself.
 */
function touchy(doc: Y.Doc, item: Y.Item, members: ReadonlySet<string>): boolean {
  const parent = item.parent as Y.AbstractType<unknown> | null;
  if (item.parentSub !== null) {
    const root = rootName(doc, parent);
    if (root !== null) return SIDECAR_ROOTS.has(root) || root === 'layerData';
    // A sheet's parts list, swapped or taken away whole.
    if (item.parentSub === 'bricks') return true;
    if (!LOOKED_AT.has(item.parentSub)) return false;
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
 * their parts, or sets a locked field of one or where it is. Anything it
 * can't tell counts as yes.
 */
export function mayTouchShared(doc: Y.Doc, decoded: DecodedUpdate, members: ReadonlySet<string>): boolean {
  try {
    // Changes the room holds back until others arrive may land with this
    // one, and which of two structs for one clock Yjs reads isn't told here.
    if (pendingMayLand(doc, decoded) || decoded.overlapping) return true;
    const known = (id: Y.ID): boolean => id.clock < Y.getState(doc.store, id.client);
    const sheets = doc.getMap<unknown>('layerData');
    for (const s of decoded.structs) {
      if (!(s instanceof Y.Item)) continue;
      if (typeof s.parent === 'string') {
        // Written straight into a root: the sidecar's maps matter, and a
        // sheet that is there already; a new sheet, part list entry or layer doesn't.
        if (SIDECAR_ROOTS.has(s.parent)) return true;
        if (s.parent === 'layerData' && s.parentSub !== null && (sheets as unknown as { _map: Map<string, Y.Item> })._map.has(s.parentSub)) return true;
        continue;
      }
      if (s.parent !== null) {
        // Inside a nested type, named by id: a field of a part (or sheet) that is already in the room?
        const pid = s.parent as unknown as Y.ID;
        if (s.parentSub === 'bricks' && known(pid)) return true;
        if (s.parentSub !== null && LOOKED_AT.has(s.parentSub) && known(pid)) {
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
 * what it breaks (LockBreak), or LOCK_COPY_BUDGET_SPENT when `mayCopy`
 * says the sender may not have a copy made right now. `partOf` gives the
 * parts' geometry, for their pivots (ws/sharedGeometry.ts).
 */
export function sharedLockCheck(
  doc: Y.Doc,
  update: Uint8Array,
  decoded: DecodedUpdate,
  mayCopy?: () => boolean,
  partOf?: PartLookup,
): LockBreak | typeof LOCK_COPY_BUDGET_SPENT | null {
  const placed = sharedModulesIn(readSidecarCache(doc));
  if (placed.length === 0) return null;
  const members = new Set<string>();
  const retired = new Set<string>();
  for (const p of placed) {
    for (const id of p.members) members.add(id);
    for (const id of p.retired ?? []) retired.add(id);
  }
  if (!mayTouchShared(doc, decoded, members) && !writesId(decoded, retired) && !writesId(decoded, members)) return null;
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
    const before = lockState(doc);
    const now = lockState(after);
    const found = breaks(before, now, racedParts(doc, decoded, members), partOf);
    // Parts an update took out, brought back (settle rule 0, for apps that don't finish their undo).
    const retiredBack = settleRetired(retired, before.alive, now.alive);
    if (!found && retiredBack.length === 0) return null;
    // What it takes to put them back, read now, while the room is as it was.
    return { ...(found ?? { why: RETIRED_BACK, modules: [] }), before: lockState(doc, true), retiredBack };
  } catch {
    return null; // the room's own document can't be copied: nothing to compare
  } finally {
    after.destroy();
  }
}

/**
 * Null when `update` leaves the layout's shared modules as they are; else
 * why not, for the log (or LOCK_COPY_BUDGET_SPENT when `mayCopy` says the
 * sender may not have a copy made right now).
 */
export function sharedLockProblem(doc: Y.Doc, update: Uint8Array, decoded: DecodedUpdate, mayCopy?: () => boolean, partOf?: PartLookup): string | null {
  const r = sharedLockCheck(doc, update, decoded, mayCopy, partOf);
  return r === null || typeof r === 'string' ? r : r.why;
}
