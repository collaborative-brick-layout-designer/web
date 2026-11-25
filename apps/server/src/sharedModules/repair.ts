// Extra copies of a shared module's parts (docs/shared-modules.md).
//
// A part of a shared module is on the map once. A layout can hold one
// twice all the same: two people put the module on another sheet at the
// same moment, or it was left so by an app that no longer does that. This
// takes the extra copies out, keeping the one that is its owner's: the one
// the version the layout has puts there. When none of them is, and every
// other part is in place, the first one is made so.
//
// It runs when a layout opens (after it is open), before an update of the
// module goes in, and after the server put the module back. It looks only
// at parts on the map more than once: a part that is there once and isn't
// the owner's ("Changed outside the app") is for people to decide. Nothing
// changes when the owner's version can't be had (the module isn't shared
// with the layout any more, is gone, has no owner, or that version isn't
// kept), when it can't tell which parts are which, when a part is listed by
// two modules, or when the layout as it was can't be kept first. Whole sets,
// each as its owner has it, stay on opening; before an update and after a
// put-back the one on the sheet the module is kept on stays.

import { and, eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { alignToPlaced, norm360, partsInPlace, pivotOf, placeVersion, resolvePlacement, sharedModulesIn, type BatchBrick, type ModuleBatch, type PartLookup, type SharedPlaced } from '@cld/modules';
import { readSidecarCache } from '@cld/ydoc';
import { db, schema } from '../db/index.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { hashOf, takeVersion } from '../history/layoutVersions.js';
import { docHub, type DocSession } from '../ws/docHub.js';
import { sharedPartLookup, warmSharedGeometry } from '../ws/sharedGeometry.js';
import { SERVER_ORIGIN, batchesOrNull, sheetChooser, versionBytes } from './apply.js';
import { stateFor } from './placed.js';

/** Within this a part is where the version puts it (as an update counts it, @cld/modules keepIds.ts). */
const SAME_PLACE = 0.1;
const SAME_TURN = 0.5;

/** Whether every part of `p` is there equally often and each set of them (the first of each, the second, ...) is the whole version, wherever it is. */
export function isWholeSets(doc: Y.Doc, p: SharedPlaced, batches: readonly ModuleBatch[], partOf: PartLookup): boolean {
  const found = copiesOf(doc, new Set(p.members));
  if (!found) return false;
  const sets: Copy[][] = [];
  const n = new Map<string, number>();
  for (const c of found.copies) {
    const k = n.get(c.id) ?? 0;
    n.set(c.id, k + 1);
    (sets[k] ??= []).push(c);
  }
  const size = batches.reduce((sum, b) => sum + b.bricks.length, 0);
  const heights = (xs: readonly { partNumber: string; altitude?: number | undefined }[]) =>
    xs.map((x) => `${x.partNumber.toLowerCase()} ${x.altitude ?? 0}`).sort().join('|');
  const want = heights(batches.flatMap((b) => b.bricks));
  return (
    sets.length > 1 &&
    sets.every((set) => {
      if (set.length !== size || n.size !== size) return false;
      const { matched: _matched, ...at } = alignToPlaced(batches, set, partOf);
      // (partsInPlace doesn't look at heights.)
      return partsInPlace(batches, set, at, partOf) === size && heights(set) === want;
    })
  );
}

interface Copy {
  map: Y.Map<unknown>;
  id: string;
  layerId: string;
  partNumber: string;
  altitude: number;
  displayArea: { x: number; y: number; width: number; height: number };
  orientation: number;
}

/** Why a module with extra copies is left as it is. */
export type SkipReason =
  /** A part of it is listed by another module too. */
  | 'listed_twice'
  /** It isn't shared with the layout's owner (any more). */
  | 'not_shared'
  /** The library module is gone, or has no owner. */
  | 'no_owner'
  /** The version the layout has isn't known, kept or readable. */
  | 'no_version'
  /** It is there whole more than once (as a change of sheet by two people at once leaves it): which one was meant can't be told on opening. */
  | 'whole_sets'
  /** Which parts are which can't be told. */
  | 'cannot_tell';

/** The shared placed modules with a part on the map more than once, and no part that another module lists too. */
export function withExtraCopies(doc: Y.Doc): SharedPlaced[] {
  return lookOver(doc).mine;
}

function lookOver(doc: Y.Doc): { mine: SharedPlaced[]; listedTwice: SharedPlaced[] } {
  const cache = readSidecarCache(doc);
  const shared = sharedModulesIn(cache);
  if (shared.length === 0) return { mine: [], listedTwice: [] };
  const count = new Map<string, number>();
  for (const p of shared) for (const id of p.members) count.set(id, 0);
  // (On the sheets the layout lists: nobody sees what is on another.)
  const data = doc.getMap<unknown>('layerData');
  for (const layerId of new Set(doc.getArray<string>('layers').toArray())) {
    const layer = data.get(layerId);
    const bricks = layer instanceof Y.Map ? layer.get('bricks') : undefined;
    if (!(bricks instanceof Y.Array)) continue;
    for (const b of bricks) {
      const id = b instanceof Y.Map ? b.get('id') : undefined;
      const n = typeof id === 'string' ? count.get(id) : undefined;
      if (n !== undefined) count.set(id as string, n + 1);
    }
  }
  const twice = shared.filter((p) => p.members.some((id) => count.get(id)! > 1));
  if (twice.length === 0) return { mine: [], listedTwice: [] };
  // Listed by two modules: whose it is can't be told.
  const listed = new Map<string, number>();
  for (const m of Array.isArray(cache?.modules) ? (cache.modules as { members?: unknown }[]) : []) {
    for (const id of new Set(Array.isArray(m?.members) ? m.members : [])) if (typeof id === 'string') listed.set(id, (listed.get(id) ?? 0) + 1);
  }
  const alone = (p: SharedPlaced) => p.members.every((id) => listed.get(id) === 1);
  return { mine: twice.filter(alone), listedTwice: twice.filter((p) => !alone(p)) };
}

function copiesOf(doc: Y.Doc, members: ReadonlySet<string>): { copies: Copy[]; sheets: { id: string; name: string }[] } | null {
  const copies: Copy[] = [];
  const sheets: { id: string; name: string }[] = [];
  const data = doc.getMap<unknown>('layerData');
  for (const layerId of new Set(doc.getArray<string>('layers').toArray())) {
    const l = data.get(layerId);
    if (!(l instanceof Y.Map)) continue;
    const bricks = l.get('bricks');
    if (!(bricks instanceof Y.Array)) continue;
    if (l.get('type') === 'brick') sheets.push({ id: layerId, name: typeof l.get('name') === 'string' ? (l.get('name') as string) : '' });
    for (const b of bricks) {
      if (!(b instanceof Y.Map)) continue;
      const id = b.get('id');
      if (typeof id !== 'string' || !members.has(id)) continue;
      const a = b.get('displayArea') as Copy['displayArea'] | undefined;
      const o = b.get('orientation') ?? 0;
      // A copy that can't be read: nothing here is decided.
      if (!a || ![a.x, a.y, a.width, a.height, o].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
      copies.push({ map: b as Y.Map<unknown>, id, layerId, partNumber: String(b.get('partNumber') ?? ''), altitude: Number(b.get('altitude') ?? 0), displayArea: { x: a.x, y: a.y, width: a.width, height: a.height }, orientation: o as number });
    }
  }
  return { copies, sheets };
}

export interface Repair {
  /** Copies that go. */
  remove: Set<Y.Map<unknown>>;
  /** Copies made what the version has there. */
  restore: { map: Y.Map<unknown>; to: BatchBrick }[];
}

/** What to change about placed module `p` so each of its parts is there once, as version `batches` has it; null: nothing. */
export function planRepair(doc: Y.Doc, p: SharedPlaced, batches: readonly ModuleBatch[], partOf: PartLookup): Repair | null {
  const found = copiesOf(doc, new Set(p.members));
  if (!found) return null;
  const { copies, sheets } = found;
  const byId = new Map<string, Copy[]>();
  for (const c of copies) byId.set(c.id, [...(byId.get(c.id) ?? []), c]);
  const extra = [...byId].filter(([, list]) => list.length > 1);
  if (extra.length === 0) return null;
  const chooser = sheetChooser(sheets, copies, p.placement?.sheets);
  if (!chooser) return null;
  const placement = resolvePlacement(batches, copies, p.placement, partOf);
  const want = placeVersion(batches, placement, partOf).flatMap((b) => {
    const sheet = chooser.pick(b.layerName || 'Module');
    return b.bricks.map((brick) => ({ brick, sheet, at: pivotOf({ displayArea: brick.displayArea, orientation: brick.orientation ?? 0 }, partOf(brick.partNumber)) }));
  });
  const byPart = new Map<string, number[]>();
  want.forEach((w, i) => {
    const k = w.brick.partNumber.toLowerCase();
    const list = byPart.get(k);
    if (list) list.push(i);
    else byPart.set(k, [i]);
  });
  const fits = (c: Copy): number[] => {
    const at = pivotOf({ displayArea: c.displayArea, orientation: c.orientation }, partOf(c.partNumber));
    return (byPart.get(c.partNumber.toLowerCase()) ?? []).filter((i) => {
      const w = want[i]!;
      const turn = Math.abs(norm360(c.orientation) - norm360(w.brick.orientation ?? 0));
      return Math.hypot(at.x - w.at.x, at.y - w.at.y) < SAME_PLACE && Math.min(turn, 360 - turn) < SAME_TURN && Math.abs(c.altitude - (w.brick.altitude ?? 0)) < 1e-6;
    });
  };
  // Parts on the map once first: theirs is taken.
  const taken = new Map<number, string>();
  let drifted = 0;
  for (const [id, list] of byId) {
    if (list.length > 1) continue;
    const i = fits(list[0]!).find((k) => !taken.has(k));
    if (i === undefined) drifted += 1;
    else taken.set(i, id);
  }
  const once = byId.size - extra.length;
  // Most of it isn't where (or what) the version has: not for this to judge.
  if (drifted * 2 > once) return null;
  // Then one copy of each of the others: on its sheet before any other.
  const fixed = new Set(taken.keys());
  const choice = new Map<string, Copy>();
  const options = new Map(
    extra.map(([id, list]) => [
      id,
      list
        .flatMap((copy) => fits(copy).filter((i) => !fixed.has(i)).map((i) => ({ copy, i, off: want[i]!.sheet === copy.layerId ? 0 : 1 })))
        .sort((a, b) => a.off - b.off),
    ]),
  );
  const assign = (id: string, seen: Set<number>): boolean => {
    for (const o of options.get(id) ?? []) {
      if (seen.has(o.i)) continue;
      seen.add(o.i);
      const other = taken.get(o.i);
      if (other !== undefined && !assign(other, seen)) continue;
      taken.set(o.i, id);
      choice.set(id, o.copy);
      return true;
    }
    return false;
  };
  const none: string[] = [];
  for (const [id] of extra) if (!assign(id, new Set())) none.push(id);
  // No part is where the version has one: nothing says this is it.
  if (taken.size === 0) return null;
  const out: Repair = { remove: new Set(), restore: [] };
  for (const [id, list] of extra) {
    const keep = choice.get(id);
    if (keep) for (const c of list) if (c !== keep) out.remove.add(c.map);
  }
  // None of its copies is the owner's: the first is made so, when what is missing can only be these.
  const missing = want.filter((_, i) => !taken.has(i));
  if (none.length > 0 && drifted === 0 && missing.length === none.length) {
    none.forEach((id, k) => {
      const [first, ...rest] = byId.get(id)!;
      out.restore.push({ map: first!.map, to: missing[k]!.brick });
      for (const c of rest) out.remove.add(c.map);
    });
  }
  return out.remove.size + out.restore.length > 0 ? out : null;
}

/** Make `repair`'s change to `doc`, in one step that everyone gets. */
export function applyRepair(doc: Y.Doc, repairs: readonly Repair[]): void {
  doc.transact(() => {
    const remove = new Set(repairs.flatMap((r) => [...r.remove]));
    for (const layer of doc.getMap<unknown>('layerData').values()) {
      const bricks = layer instanceof Y.Map ? layer.get('bricks') : undefined;
      if (!(bricks instanceof Y.Array)) continue;
      for (let i = bricks.length - 1; i >= 0; i--) if (remove.has(bricks.get(i) as Y.Map<unknown>)) bricks.delete(i, 1);
    }
    for (const r of repairs) {
      for (const { map, to } of r.restore) {
        map.set('partNumber', to.partNumber);
        map.set('altitude', to.altitude ?? 0);
        map.set('orientation', to.orientation ?? 0);
        map.set('displayArea', { ...to.displayArea });
      }
    }
  }, SERVER_ORIGIN);
}

export interface RepairOptions {
  placedId?: string;
  /** For a caller about to change the module: after one that is running, and at once. */
  wait?: boolean;
  /** One of several whole sets stays too (not on opening). */
  wholeSets?: boolean;
}

const running = new Map<string, Promise<boolean>>();
/** After a put-back, a room that couldn't be repaired isn't looked at again for a while (put-backs can come in quick succession). */
const RETRY_MS = 60_000;
const lastTry = new WeakMap<DocSession, number>();

/**
 * Take extra copies of shared modules' parts out of the room (of one placed
 * module, or all). True when something changed. Costs one look at the
 * layout's parts when it places a shared module, and nothing more unless
 * there is a part twice. */
export async function repairSharedParts(session: DocSession, opts: RepairOptions = {}): Promise<boolean> {
  if (session.closed || withExtraCopies(session.doc).length === 0) return false;
  const busy = running.get(session.layoutId);
  if (busy) {
    const did = await busy;
    if (!opts.wait) return did;
  }
  if (opts.wholeSets && !opts.wait && Date.now() - (lastTry.get(session) ?? 0) < RETRY_MS) return false;
  const work = run(session, opts).catch((err: unknown) => {
    console.error('[sharedModules] extra copies of parts were left in layout %s:', session.layoutId, err);
    return false;
  });
  running.set(session.layoutId, work);
  try {
    const did = await work;
    if (opts.wholeSets && !did) lastTry.set(session, Date.now());
    return did;
  } finally {
    if (running.get(session.layoutId) === work) running.delete(session.layoutId);
  }
}

type LayoutOwner = { ownerUserId: string | null; ownerOrgId: string | null };

/** The owner's version of `p`, when the layout still follows it; else why not. */
async function ownersVersion(owner: LayoutOwner, p: SharedPlaced): Promise<ModuleBatch[] | SkipReason> {
  const state = await stateFor(owner, p.moduleId);
  if (state !== 'shared') return state === 'gone' ? 'no_owner' : 'not_shared';
  const mod = await db.select({ u: schema.modules.ownerUserId, o: schema.modules.ownerOrgId }).from(schema.modules).where(eq(schema.modules.id, p.moduleId)).get();
  if (!mod || (!mod.u && !mod.o)) return 'no_owner';
  const batches = p.version === null ? null : batchesOrNull(await versionBytes(p.moduleId, p.version));
  return batches && batches.some((b) => b.bricks.length > 0) ? batches : 'no_version';
}

export interface Looked {
  repairs: { p: SharedPlaced; repair: Repair }[];
  skipped: { p: SharedPlaced; why: SkipReason }[];
}

/**
 * What a layout's document needs: everything read that has to be awaited,
 * then `plan`, which can be asked again as the document changes. (Also the
 * dry run's way to ask: ops/sharedRepairDryRun.ts.) Null: nothing is there twice.
 */
export async function examine(layoutId: string, owner: LayoutOwner, doc: Y.Doc, { placedId, wholeSets = false }: RepairOptions = {}): Promise<{ plan: () => Looked } | null> {
  const asked = (p: SharedPlaced) => placedId === undefined || p.placedId === placedId;
  const first = lookOver(doc);
  if (![...first.mine, ...first.listedTwice].some(asked)) return null;
  const versions = new Map<string, ModuleBatch[] | SkipReason>();
  const key = (p: SharedPlaced) => `${p.moduleId}|${p.version}`;
  for (const p of first.mine) if (asked(p) && !versions.has(key(p))) versions.set(key(p), await ownersVersion(owner, p));
  let partOf: PartLookup | undefined;
  if ([...versions.values()].some((v) => typeof v !== 'string')) {
    await warmSharedGeometry(layoutId, doc);
    partOf = sharedPartLookup(layoutId);
  }
  return {
    plan: () => {
      const out: Looked = { repairs: [], skipped: [] };
      const now = lookOver(doc);
      for (const p of now.listedTwice) if (asked(p)) out.skipped.push({ p, why: 'listed_twice' });
      for (const p of now.mine) {
        if (!asked(p)) continue;
        const v = versions.get(key(p));
        if (v !== undefined && typeof v !== 'string' && partOf && !wholeSets && isWholeSets(doc, p, v, partOf)) {
          out.skipped.push({ p, why: 'whole_sets' });
          continue;
        }
        const repair = v !== undefined && typeof v !== 'string' && partOf ? planRepair(doc, p, v, partOf) : null;
        if (repair) out.repairs.push({ p, repair });
        else out.skipped.push({ p, why: typeof v === 'string' ? v : 'cannot_tell' });
      }
      return out;
    },
  };
}

/** Keep the layout as it is; the one kept for a repair before, when it is the same document. `made`: new just now. */
async function keepFirst(layoutId: string, state: Uint8Array): Promise<{ id: string; made: boolean } | null> {
  const v = schema.layoutVersions;
  const same = await db.select({ id: v.id }).from(v).where(and(eq(v.layoutId, layoutId), eq(v.reason, 'before-repair'), eq(v.docHash, hashOf(state)))).limit(1).get();
  if (same) return { id: same.id, made: false };
  const had = new Set((await db.select({ id: v.id }).from(v).where(eq(v.layoutId, layoutId)).all()).map((r) => r.id));
  const id = await takeVersion({ layoutId, state, reason: 'before-repair', always: true });
  return id === null ? null : { id, made: !had.has(id) };
}

async function run(session: DocSession, opts: RepairOptions): Promise<boolean> {
  const { layoutId, doc } = session;
  const there = () => !session.closed && docHub.peek(layoutId) === session;
  const layout = await db.select({ ownerUserId: schema.layouts.ownerUserId, ownerOrgId: schema.layouts.ownerOrgId }).from(schema.layouts).where(eq(schema.layouts.id, layoutId)).get();
  if (!layout || !there()) return false;
  const looked = await examine(layoutId, layout, doc, opts);
  if (!looked) return false;
  // The layout as it is goes in its history first; when someone edits it
  // meanwhile, once more (what is kept is what the repair starts from).
  for (let tries = 0; tries < 3; tries++) {
    if (!there() || looked.plan().repairs.length === 0) return false;
    let changed = false;
    const note = (): void => {
      changed = true;
    };
    doc.on('update', note);
    let kept: { id: string; made: boolean } | null = null;
    let done = false;
    try {
      kept = await keepFirst(layoutId, Y.encodeStateAsUpdate(doc));
      if (kept === null) return false;
      // Still followed, now that it counts.
      for (const { p } of looked.plan().repairs) if ((await stateFor(layout, p.moduleId)) !== 'shared') return false;
      if (!there()) return false;
      if (changed) continue;
      const { repairs } = looked.plan();
      if (repairs.length === 0) return false;
      doc.off('update', note);
      applyRepair(doc, repairs.map((x) => x.repair));
      done = true;
      await session.flushBatch();
      for (const { p, repair } of repairs) {
        const removed = repair.remove.size;
        const restored = repair.restore.length;
        console.log('[sharedModules] tidied up layout %s: module %s (placed as %s), %d extra copies taken out, %d parts made as its version %d has them; the layout before is version %s', layoutId, p.moduleId, p.placedId, removed, restored, p.version, kept.id);
        await writeAuditEvent({ layoutId, userId: null, eventType: 'shared_module_repair', payload: { sharedModule: p.moduleId, placedId: p.placedId, version: p.version, removed, restored, safety: kept.id } });
      }
      return true;
    } finally {
      doc.off('update', note);
      // A version kept for a repair that didn't happen goes again, so openings don't pile them up.
      if (kept?.made && !done) await db.delete(schema.layoutVersions).where(eq(schema.layoutVersions.id, kept.id));
    }
  }
  return false;
}
