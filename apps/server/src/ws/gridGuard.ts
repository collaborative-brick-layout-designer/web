// Grid sizes both apps can draw. A grid layer's `gridSizeInStud` (its cell
// size) must be a finite number from 1 to the largest 32-bit int: the
// desktop holds it as an int and draws its grid lines that far apart. An
// update or a whole document that
// would leave a grid layer outside that range (0, negative, a fraction
// below 1, too big for an int, not finite, not a number, or the field
// gone) is refused like one the apps can't read (ws/updateGuard.ts).
// So is one that leaves any other drawing setting of a sheet or a ruler
// outside its range (drawingSettings.ts): line thicknesses, sub-divisions,
// an area's cell size, transparency, a ruler's geometry and so on.
//
// The check is cheap for almost every update: it reads the update's
// structs (decoded once and shared with the merge guard, ws/decoded.ts),
// and only when the update could leave a grid layer without a valid size is
// the result worked out. That is when it:
//   - writes a layer's type as 'grid' (or as something not a plain value);
//     an item's key is the one Yjs gives it: its own, else its origin's,
//     else (no origin) its right origin's;
//   - writes a grid size that isn't one plain valid number, or deletes the
//     value it writes;
//   - writes any other drawing setting, or adds an entry to a list (it may
//     be a ruler);
//   - deletes the grid size of a layer that is a grid and stays;
//   - lands while the room has changes waiting for others that it may let
//     land (pending.ts pendingMayLand), or holds two structs for one id
//     (hand-made: Yjs reads one).
// Adding a layer of another kind, deleting a layer, and every edit that
// writes neither key (parts, labels, a paste, an offline session) can't
// leave a grid without a valid size, and need nothing more.
//
// A new grid layer and a change of a grid's size are worked out exactly
// from the keys they touch (exactVerdict): which structs Yjs would
// integrate, following its own order, then, for each layer the update
// touches, the value its type and grid size end up with. Only the layer's
// entry in layerData and those two keys are read, so it costs the same on a
// layout of 10 parts or 10,000. The few updates outside what that reading
// covers (some of it would wait for changes the room doesn't have, two
// writes race for one key, a struct Yjs would only partly apply, a hand-made
// shape Yjs reads its own way) are worked out on a copy of the room's
// document, as before.

import * as Y from 'yjs';
import { decodeIncoming, findStruct, guardWork, type DecodedUpdate, type DeleteSet, type Struct } from './decoded.js';
import { updateClientBlocks } from './updateGuard.js';
import { pendingMayLand } from './pending.js';
import { docSheetProblems, placeOf, RULER_KEYS, rulerView, SHEET_KEYS, sheetProblems, type RulerView } from './drawingSettings.js';

const SIZE_KEY = 'gridSizeInStud';
const TYPE_KEY = 'type';
const LAYER_DATA = 'layerData';
const RULERS_KEY = 'rulerItems';
/** The keys of a sheet whose writes the guard works out (drawingSettings.ts). */
const SHEET_READ: ReadonlySet<string> = new Set([TYPE_KEY, SIZE_KEY, RULERS_KEY, ...SHEET_KEYS]);
export const MAX_GRID_SIZE = 2147483647;

/** Whether `v` is a grid size both apps draw. */
export function validGridSize(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= MAX_GRID_SIZE;
}

/** The grid layers (by id) of `doc` whose size isn't valid. */
export function invalidGridLayers(doc: Y.Doc): Set<string> {
  const out = new Set<string>();
  const layerData = doc.share.get(LAYER_DATA);
  if (!layerData) return out;
  // A root type not read as a map yet: look at its entries as one.
  const map = layerData instanceof Y.Map ? layerData : doc.getMap(LAYER_DATA);
  map.forEach((layer, id) => {
    if (layer instanceof Y.Map && layer.get(TYPE_KEY) === 'grid' && !validGridSize(layer.get(SIZE_KEY))) out.add(id);
  });
  return out;
}

/** A sheet's grid size problem, as a problem key (`<sheet>.gridSizeInStud`). */
const sizeProblem = (sheet: string) => `${sheet}.${SIZE_KEY}`;

/** Everything outside its range on one sheet of a document as it is (null: no such sheet). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sheetProblemsIn(layerData: Y.AbstractType<any> | undefined, sheet: string): string[] {
  const item = layerData?._map.get(sheet);
  if (!item || item.deleted) return [];
  const layer = item.content.getContent()[item.length - 1];
  if (!(layer instanceof Y.Map)) return [];
  const out = docSheetProblems(sheet, layer);
  if (layer.get(TYPE_KEY) === 'grid' && !validGridSize(layer.get(SIZE_KEY))) out.push(sizeProblem(sheet));
  return out;
}

/**
 * What was outside its range on each sheet of a room's document, worked
 * out once per sheet. An update the guard takes never leaves a problem
 * that wasn't there before, so what a sheet had when first read stays
 * true of it (some may have been fixed since; those may come back, as
 * when the layout was read). Reading a sheet with many rulers once,
 * instead of with every update to it, keeps each update's check to what
 * it touches.
 */
const knownProblems = new WeakMap<Y.Doc, Map<string, Set<string>>>();
function problemsBefore(doc: Y.Doc | null, sheet: string): Set<string> {
  if (!doc) return new Set();
  let sheets = knownProblems.get(doc);
  if (!sheets) knownProblems.set(doc, (sheets = new Map()));
  let known = sheets.get(sheet);
  if (!known) sheets.set(sheet, (known = new Set(sheetProblemsIn(doc.share.get(LAYER_DATA), sheet))));
  return known;
}

/** Everything outside its range in `doc`, every sheet. */
export function drawingProblems(doc: Y.Doc): Set<string> {
  const layerData = doc.share.get(LAYER_DATA);
  const out = new Set<string>();
  if (!layerData) return out;
  for (const sheet of layerData._map.keys()) for (const p of sheetProblemsIn(layerData, sheet)) out.add(p);
  return out;
}

/** Why an update is refused, for the log. */
function refusal(problem: string): string {
  if (problem.endsWith(`.${SIZE_KEY}`)) {
    return `it leaves grid layer ${problem.slice(0, -SIZE_KEY.length - 1)} with a cell size outside 1 to ${MAX_GRID_SIZE} studs`;
  }
  return `it leaves ${problem} outside what the apps draw`;
}

/** Could this write of a layer's type make it a grid? */
function mayWriteGrid(content: unknown): boolean {
  if (content instanceof Y.ContentDeleted) return false; // a type taken away: not a grid
  if (content instanceof Y.ContentAny) return content.arr.includes('grid');
  return true; // some other kind of value (JSON content, which the apps read differently, too): work it out
}

/**
 * Does the update's delete set take any of `item` away? Every range is
 * looked at: Y.isDeleted searches them as if sorted, and a hand-made update
 * may list them in any order (Yjs applies them all).
 */
function deletes(ds: DeleteSet, item: Y.Item): boolean {
  const { client, clock } = item.id;
  const end = clock + item.length;
  return (ds.clients.get(client) ?? []).some((r) => r.clock < end && clock < r.clock + r.len);
}

/**
 * Could this list entry be a ruler (a nested type, or plain JSON: rulerView)?
 * Only strings, deletions, formatting and values with no object in them
 * can't. Embeds and JSON content hold JSON too, though neither app writes
 * them, so they are worked out like values holding an object.
 */
function mayHoldRuler(content: unknown): boolean {
  if (content instanceof Y.ContentDeleted || content instanceof Y.ContentString || content instanceof Y.ContentFormat) return false;
  if (content instanceof Y.ContentAny) return content.arr.some((v) => v !== null && typeof v === 'object');
  return true;
}

/** Is this write of a grid size one valid number that stays? */
function writesValidSize(item: Y.Item, ds: DeleteSet): boolean {
  const c = item.content;
  if (!(c instanceof Y.ContentAny)) return false;
  return item.length === 1 && c.arr.length === 1 && validGridSize(c.arr[0]) && !deletes(ds, item);
}

/** Could `update` leave a grid layer of `doc` without a valid size? (False: certainly not.) */
function mayBreakGrid(doc: Y.Doc | null, update: DecodedUpdate): boolean {
  // Changes the room holds back until others arrive may land with this one.
  if (pendingMayLand(doc, update)) return true;
  if (update.overlapping) return true;
  const { structs, ds, byClient } = update;
  const known = (id: Y.ID): boolean => !!doc && id.clock < Y.getState(doc.store, id.client);
  // The map key an item is the value of: written with it the first time a
  // key is set, else the key of the value it replaces (its origin; or the
  // one it is placed before, with no origin). Each
  // item's key is worked out once: a paste of 1000 parts is one chain of
  // origins 1000 long, so walking it from every item was quadratic.
  const keys = new Map<Y.Item, string | null>();
  const keyOf = (start: Y.Item): string | null => {
    const chain: Y.Item[] = [];
    const seen = new Set<Y.Item>();
    let item: Y.Item | null = start;
    let key: string | null = null;
    while (item) {
      const memo = keys.get(item);
      if (memo !== undefined) {
        key = memo;
        break;
      }
      chain.push(item);
      seen.add(item);
      if (item.parentSub !== null) {
        key = item.parentSub;
        break;
      }
      // Its parent written without a key: a list item, not a map value.
      if (item.parent !== null) break;
      const ref: Y.ID | null = item.origin ?? item.rightOrigin;
      if (!ref) break;
      if (known(ref)) {
        try {
          const there = Y.getItem(doc!.store, ref);
          key = there instanceof Y.Item ? there.parentSub : null;
        } catch {
          key = null;
        }
        break;
      }
      const next = findStruct(byClient.get(ref.client), ref.clock);
      item = next instanceof Y.Item && !seen.has(next) ? next : null;
    }
    for (const c of chain) keys.set(c, key);
    return key;
  };
  for (const s of structs) {
    if (!(s instanceof Y.Item)) continue;
    const key = keyOf(s);
    if (key === SIZE_KEY && !writesValidSize(s, ds)) return true;
    if (key === TYPE_KEY && mayWriteGrid(s.content)) return true;
    // Another drawing setting (a sheet's or a ruler's), or a list entry that may be a ruler.
    if (key !== null && (SHEET_KEYS.has(key) || RULER_KEYS.has(key) || key === RULERS_KEY)) return true;
    if (key === null && mayHoldRuler(s.content)) return true;
  }
  // Deleting the grid size of a layer that is a grid, unless the layer goes too.
  if (doc) {
    for (const [client, ranges] of ds.clients) {
      const list = doc.store.clients.get(client);
      if (!list) continue;
      for (const r of ranges) {
        const end = Math.min(r.clock + r.len, Y.getState(doc.store, client));
        if (r.clock >= end) continue;
        for (let i = Y.findIndexSS(list, r.clock); i < list.length && list[i]!.id.clock < end; i++) {
          const s = list[i];
          if (!(s instanceof Y.Item) || s.parentSub !== SIZE_KEY || s.deleted) continue;
          const layer = s.parent;
          if (!(layer instanceof Y.Map) || layer.get(TYPE_KEY) !== 'grid') continue;
          const layerItem = layer._item;
          if (layerItem && (layerItem.deleted || deletes(ds, layerItem))) continue;
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Null when `update` (Yjs update v1) leaves every grid layer of `doc` with
 * a size both apps draw, or doesn't change one; else why not, for the log.
 * `doc` is the room's document, or null for a whole document on its own (a
 * snapshot). A grid size that was already out of range before the update
 * doesn't refuse it (so a layout saved that way can still be fixed).
 */
export function checkGridSizes(doc: Y.Doc | null, update: Uint8Array): string | null {
  const decoded = decodeIncoming(update);
  // Unreadable: the update guard and Yjs refuse it on their own.
  return decoded ? checkGridSizesDecoded(doc, update, decoded) : null;
}

/** checkGridSizesDecoded's answer when the update needs a copy and `mayCopy` says no: slow the sender down. */
export const COPY_BUDGET_SPENT = 'it needs a copy of the layout, and its sender has used up their copies for now';

/**
 * checkGridSizes with the update already decoded (the live handler shares
 * one decode). `mayCopy`, when given, is asked before working an update
 * out on a copy of the room's document (the live handler's per-person
 * budget, ws/pacing.ts); no gives COPY_BUDGET_SPENT.
 */
export function checkGridSizesDecoded(doc: Y.Doc | null, update: Uint8Array, decoded: DecodedUpdate, mayCopy?: () => boolean): string | null {
  if (!mayBreakGrid(doc, decoded)) return null;
  const exact = exactVerdict(doc, update, decoded);
  if (exact !== UNSURE) {
    guardWork.gridExact += 1;
    return exact;
  }
  if (mayCopy && !mayCopy()) return COPY_BUDGET_SPENT;
  return checkGridSizesOnCopy(doc, update);
}

/** The same worked out on a copy of the room's document (exact for any update; costs the layout's size). */
export function checkGridSizesOnCopy(doc: Y.Doc | null, update: Uint8Array): string | null {
  guardWork.docCopies += 1;
  const before = doc ? drawingProblems(doc) : new Set<string>();
  const after = new Y.Doc();
  try {
    if (doc) {
      const state = Y.encodeStateAsUpdate(doc);
      guardWork.copyBytes += state.length;
      Y.applyUpdate(after, state);
    }
    try {
      Y.applyUpdate(after, update);
    } catch {
      // Yjs throws part-way through some hand-made updates and keeps what it
      // applied before (the room would too): that is what is checked. One it
      // can't read at all throws before changing anything.
    }
    for (const p of drawingProblems(after)) if (!before.has(p)) return refusal(p);
    return null;
  } catch {
    return null; // the room's own document can't be copied: nothing to compare
  } finally {
    after.destroy();
  }
}

// ---- exact, from the touched keys --------------------------------------------

/** exactVerdict's answer for an update outside what it reads: work it out on a copy. */
export const UNSURE = Symbol('unsure');
type Unsure = typeof UNSURE;

class NotSure extends Error {}
const unsure = (): never => {
  throw new NotSure();
};

const idKey = (client: number, clock: number) => `${client}:${clock}`;
const lastKey = (s: { id: Y.ID; length: number }) => idKey(s.id.client, s.id.clock + s.length - 1);
const ROOT_LAYERS = `r:${LAYER_DATA}`;

/** Does `ds` take away the last clock of `s`, the one a map key reads? */
function deletesLast(ds: DeleteSet, s: { id: Y.ID; length: number }): boolean {
  const clock = s.id.clock + s.length - 1;
  return (ds.clients.get(s.id.client) ?? []).some((r) => r.clock <= clock && clock < r.clock + r.len);
}

/** A key of a map: the map (`r:<root name>` or `i:<client>:<clock>` of its item) and the key. */
interface Slot {
  tok: string;
  key: string | null;
}

/**
 * The structs of the update Yjs integrates, in the order it does
 * (utils/encoding.js integrateStructs, Yjs 13.6), worked out on clocks
 * alone. Unsure when anything would wait for changes the room doesn't
 * have, a struct would be applied only in part, or a struct points at a
 * later one of its own client (Yjs can't read that).
 */
function integration(doc: Y.Doc | null, byClient: Map<number, Struct[]>): Struct[] {
  const state = new Map<number, number>();
  const st = (client: number): number => {
    let v = state.get(client);
    if (v === undefined) state.set(client, (v = doc ? Y.getState(doc.store, client) : 0));
    return v;
  };
  for (const list of byClient.values()) {
    for (const s of list) {
      if (s instanceof Y.Skip) unsure();
      if (!(s instanceof Y.Item)) continue;
      const c = s.id.client;
      for (const ref of [s.origin, s.rightOrigin, s.parent instanceof Y.ID ? s.parent : null]) {
        if (ref && ref.client === c && ref.clock >= s.id.clock) unsure();
      }
    }
  }
  const refs = new Map<number, { refs: Struct[]; i: number }>();
  for (const [c, list] of byClient) refs.set(c, { refs: list, i: 0 });
  const ids = [...refs.keys()].sort((a, b) => a - b);
  const nextTarget = () => {
    while (ids.length) {
      const t = refs.get(ids[ids.length - 1]!)!;
      if (t.i < t.refs.length) return t;
      ids.pop();
    }
    return null;
  };
  const missingOf = (s: Struct): number | null => {
    if (!(s instanceof Y.Item)) return null;
    const c = s.id.client;
    if (s.origin && s.origin.client !== c && s.origin.clock >= st(s.origin.client)) return s.origin.client;
    if (s.rightOrigin && s.rightOrigin.client !== c && s.rightOrigin.clock >= st(s.rightOrigin.client)) return s.rightOrigin.client;
    const p = s.parent;
    if (p instanceof Y.ID && p.client !== c && p.clock >= st(p.client)) return p.client;
    return null;
  };
  const placed: Struct[] = [];
  let cur = nextTarget();
  if (!cur) return placed;
  let head = cur.refs[cur.i++]!;
  const stack: Struct[] = [];
  for (;;) {
    const offset = st(head.id.client) - head.id.clock;
    if (offset < 0) unsure(); // waits for an earlier change of its own client
    const missing = missingOf(head);
    if (missing !== null) {
      stack.push(head);
      const t = refs.get(missing);
      if (!t || t.i === t.refs.length) unsure(); // waits for a change the room doesn't have
      head = t!.refs[t!.i++]!;
      continue;
    }
    if (offset === 0) {
      placed.push(head);
      state.set(head.id.client, head.id.clock + head.length);
    } else if (offset < head.length) unsure(); // applied in part
    if (stack.length) head = stack.pop()!;
    else if (cur && cur.i < cur.refs.length) head = cur.refs[cur.i++]!;
    else {
      cur = nextTarget();
      if (!cur) break;
      head = cur.refs[cur.i++]!;
    }
  }
  return placed;
}

/**
 * What the grid check on a copy would answer, worked out from the keys the
 * update touches; UNSURE for an update outside what this reads.
 */
export function exactVerdict(doc: Y.Doc | null, update: Uint8Array, decoded: DecodedUpdate): string | null | Unsure {
  if (pendingMayLand(doc, decoded) || decoded.overlapping) return UNSURE;
  // Yjs reads only the last block of a client that has two.
  const blocks = updateClientBlocks(update);
  if (!blocks || new Set(blocks).size !== blocks.length) return UNSURE;
  try {
    return exactOrThrow(doc, decoded);
  } catch (err) {
    if (err instanceof NotSure) return UNSURE;
    throw err;
  }
}

function exactOrThrow(doc: Y.Doc | null, decoded: DecodedUpdate): string | null {
  const { byClient, ds } = decoded;
  const placed = integration(doc, byClient);
  const known = (id: Y.ID): boolean => !!doc && id.clock < Y.getState(doc.store, id.client);
  const docStruct = (id: Y.ID): Y.Item | Y.GC => {
    try {
      return Y.getItem(doc!.store, id) as Y.Item | Y.GC;
    } catch {
      return unsure();
    }
  };
  const roots = new Map<unknown, string>();
  if (doc) for (const [name, t] of doc.share) roots.set(t, name);
  const typeTok = (t: unknown): string => {
    const type = t as Y.AbstractType<unknown>;
    if (type?._item) return `i:${idKey(type._item.id.client, type._item.id.clock)}`;
    const name = roots.get(type);
    return name === undefined ? unsure() : `r:${name}`;
  };
  const docSlot = (s: Y.Item): Slot => ({ tok: typeTok(s.parent), key: s.parentSub });

  // Where each integrated item lands (null: Yjs keeps it as garbage), in
  // the order Yjs integrates them, so whatever one points at is known.
  const slots = new Map<Y.Item, Slot | null>();
  const placedSet = new Set<Struct>(placed);
  const resolve = (id: Y.ID): { gc: boolean; slot: Slot | null; item: Y.Item | null } => {
    if (known(id)) {
      const s = docStruct(id);
      return s instanceof Y.Item ? { gc: false, slot: docSlot(s), item: s } : { gc: true, slot: null, item: null };
    }
    const s = findStruct(byClient.get(id.client), id.clock);
    if (!s || !placedSet.has(s)) return unsure();
    if (!(s instanceof Y.Item)) return { gc: true, slot: null, item: null };
    const slot = slots.get(s);
    if (slot === undefined) return unsure();
    return { gc: slot === null, slot, item: s };
  };
  const slotOf = (item: Y.Item): Slot | null => {
    const parent = item.parent as unknown;
    if (parent !== null) {
      if (typeof parent === 'string') return { tok: `r:${parent}`, key: item.parentSub };
      if (!(parent instanceof Y.ID)) return unsure();
      const p = resolve(parent);
      if (p.gc) return null;
      if (!(p.item!.content instanceof Y.ContentType)) return unsure();
      return { tok: `i:${idKey(parent.client, parent.clock)}`, key: item.parentSub };
    }
    const left = item.origin ? resolve(item.origin) : null;
    const right = item.rightOrigin ? resolve(item.rightOrigin) : null;
    if (left?.gc || right?.gc) return null;
    return (left ?? right ?? unsure()).slot;
  };
  for (const s of placed) if (s instanceof Y.Item) slots.set(s, slotOf(s));

  // Where a node of the update or the document sits: the slot of the item that holds it.
  const holderSlots = new Map<string, Slot | null>();
  const holderSlot = (tok: string): Slot | null => {
    if (!tok.startsWith('i:')) return null;
    let slot = holderSlots.get(tok);
    if (slot === undefined) {
      const [client, clock] = tok.slice(2).split(':').map(Number) as [number, number];
      slot = resolve(Y.createID(client, clock)).slot;
      holderSlots.set(tok, slot);
    }
    return slot;
  };
  // The sheet a map is (its key in layerData), or null.
  const layerOf = (tok: string): string | null => {
    const slot = holderSlot(tok);
    return slot?.tok === ROOT_LAYERS ? slot.key : null;
  };
  // The sheet whose rulerItems a list is, or null.
  const rulersOf = (tok: string): string | null => {
    const slot = holderSlot(tok);
    return slot?.key === RULERS_KEY ? layerOf(slot.tok) : null;
  };
  // The sheet a ruler (a map in a sheet's rulerItems) is on, or null.
  const rulerSheetOf = (tok: string): string | null => {
    const slot = holderSlot(tok);
    return slot && slot.key === null ? rulersOf(slot.tok) : null;
  };

  // The new items of each key and of each list, the sheets touched, and
  // the rulers of the room's document whose fields (or id) the update writes.
  const chains = new Map<string, Y.Item[]>();
  const lists = new Map<string, Y.Item[]>();
  const touched = new Set<string>();
  const touchedRulers = new Set<string>();
  const add = (sheet: string | null) => {
    if (sheet !== null) touched.add(sheet);
  };
  const touch = (slot: Slot) => {
    if (slot.key === null) add(rulersOf(slot.tok));
    else if (slot.tok === ROOT_LAYERS) touched.add(slot.key);
    else if (SHEET_READ.has(slot.key)) add(layerOf(slot.tok));
    else if (RULER_KEYS.has(slot.key) || slot.key === 'id') {
      const sheet = rulerSheetOf(slot.tok);
      if (sheet !== null) {
        touched.add(sheet);
        touchedRulers.add(slot.tok);
      }
    }
  };
  for (const [item, slot] of slots) {
    if (!slot) continue;
    const k = slot.key === null ? slot.tok : `${slot.tok}\u0000${slot.key}`;
    const to = slot.key === null ? lists : chains;
    const list = to.get(k);
    if (list) list.push(item);
    else to.set(k, [item]);
    touch(slot);
  }
  // Values the update deletes in the room's document.
  if (doc) {
    for (const [client, ranges] of ds.clients) {
      const list = doc.store.clients.get(client);
      if (!list) continue;
      const state = Y.getState(doc.store, client);
      for (const r of ranges) {
        const end = Math.min(r.clock + r.len, state);
        if (r.clock >= end) continue;
        for (let i = Y.findIndexSS(list, r.clock); i < list.length && list[i]!.id.clock < end; i++) {
          const s = list[i];
          if (s instanceof Y.Item && !s.deleted && s.parentSub !== null) touch(docSlot(s));
        }
      }
    }
  }

  // What a key of a map reads after the update.
  const docTail = (tok: string, key: string): Y.Item | null => {
    if (!doc) return null;
    if (tok.startsWith('r:')) return (doc.share.get(tok.slice(2))?._map.get(key) as Y.Item | undefined) ?? null;
    const [client, clock] = tok.slice(2).split(':').map(Number) as [number, number];
    const id = Y.createID(client, clock);
    if (!known(id)) return null;
    const s = docStruct(id);
    if (!(s instanceof Y.Item) || !(s.content instanceof Y.ContentType)) return null;
    return (s.content.type._map.get(key) as Y.Item | undefined) ?? null;
  };
  const read = (tok: string, key: string): { item: Y.Item | null; value: unknown } => {
    const tail = docTail(tok, key);
    let last: Y.Item | null = tail;
    const items = chains.get(`${tok}\u0000${key}`) ?? [];
    if (items.length) {
      // One chain of writes, each after the one before, the first after the
      // value there now: Yjs puts each at the end, so the last one is the value.
      const byOrigin = new Map<string, Y.Item>();
      for (const it of items) {
        if (it.rightOrigin) unsure();
        const k = it.origin ? idKey(it.origin.client, it.origin.clock) : '-';
        if (byOrigin.has(k)) unsure(); // two writes racing for the key
        byOrigin.set(k, it);
      }
      let n = 0;
      for (let it = byOrigin.get(tail ? lastKey(tail) : '-'); it; it = byOrigin.get(lastKey(it))) {
        last = it;
        if (++n > items.length) unsure();
      }
      if (n !== items.length) unsure();
    }
    if (!last) return { item: null, value: undefined };
    const gone = (known(last.id) ? last.deleted : last.content instanceof Y.ContentDeleted) || deletesLast(ds, last);
    return { item: last, value: gone ? undefined : last.content.getContent()[last.length - 1] };
  };
  const tokOf = (item: Y.Item) => `i:${idKey(item.id.client, item.id.clock)}`;
  const deletesClock = (client: number, clock: number) => (ds.clients.get(client) ?? []).some((r) => r.clock <= clock && clock < r.clock + r.len);

  // A sheet's rulers after the update: those of the list now that stay, and the new ones.
  const rulersAfter = (list: { item: Y.Item | null; value: unknown }): RulerView[] => {
    if (!(list.value instanceof Y.Array) || !list.item) return [];
    const out: RulerView[] = [];
    const entry = (item: Y.Item, j: number, value: unknown) => {
      if (deletesClock(item.id.client, item.id.clock + j)) return;
      const place = placeOf(item.id.client, item.id.clock + j);
      if (value instanceof Y.Map) {
        const tok = tokOf(item);
        const id = read(tok, 'id').value;
        out.push({ key: typeof id === 'string' && id ? id : place, read: (f) => read(tok, f).value });
        return;
      }
      const view = rulerView(value, place);
      if (view) out.push(view);
    };
    // Of the list the room has, only the rulers the update writes to: the
    // others are as they were, with the problems they had (problemsBefore).
    if (known(list.item.id)) {
      for (const tok of touchedRulers) {
        const [client, clock] = tok.slice(2).split(':').map(Number) as [number, number];
        const id = Y.createID(client, clock);
        if (!known(id)) continue;
        const item = docStruct(id);
        if (!(item instanceof Y.Item) || item.deleted || item.parent !== list.value) continue;
        item.content.getContent().forEach((v, j) => entry(item, j, v));
      }
    }
    for (const item of lists.get(tokOf(list.item)) ?? []) {
      if (item.content instanceof Y.ContentDeleted) continue;
      item.content.getContent().forEach((v, j) => entry(item, j, v));
    }
    return out;
  };

  for (const sheet of touched) {
    guardWork.gridLayersRead += 1;
    const entry = read(ROOT_LAYERS, sheet);
    if (!(entry.value instanceof Y.Map) || !entry.item) continue;
    const tok = tokOf(entry.item);
    const after = sheetProblems(sheet, (f) => read(tok, f).value, rulersAfter(read(tok, RULERS_KEY)));
    if (read(tok, TYPE_KEY).value === 'grid' && !validGridSize(read(tok, SIZE_KEY).value)) after.unshift(sizeProblem(sheet));
    if (after.length === 0) continue;
    const before = problemsBefore(doc, sheet);
    const fresh = after.find((p) => !before.has(p));
    if (fresh) return refusal(fresh);
  }
  return null;
}
