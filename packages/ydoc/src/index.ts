// Yjs document shape + helpers for layouts. Used by the server (snapshot
// hydration, persistence) and the client (binding to the editor).
//
// The full Yjs<->BbmMap projection lands in Phase 4. For Phase 2 we only
// need:
//   - empty doc seed (createLayoutDoc / createSidecarDoc)
//   - bytes ↔ doc helpers (encodeDoc / decodeDoc) so the layouts table can
//     persist a binary snapshot from day one
// Phase 4 fills in the read/write of bricks, layers, etc.

import * as Y from 'yjs';
import { BBM_FORMAT_VERSION, type BbmMap } from '@cld/model';
import type { Sidecar } from '@cld/bbm';
import { bbmToDoc, docToBbm } from './projection.js';
import { keepDrawnSettingsInRange } from './drawnLimits.js';

import { DOC_BASE_SCHEMA } from './shape.js';

export { bbmToDoc, docToBbm, createDocProjector, type DocProjector } from './projection.js';
export * from './shape.js';
export { DRAWN_LIMITS, keepDrawnSettingsInRange } from './drawnLimits.js';
export { DOC_MIN_READABLE, DOC_SCHEMA_VERSION, canReadDoc, makeId, upgradeDoc } from './ids.js';

export function createLayoutDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap('meta').set('schemaVersion', DOC_BASE_SCHEMA);
  doc.getArray('layers');
  doc.getMap('layerData');
  doc.getMap('venue');
  doc.getMap('modules');
  doc.getMap('labels');
  return doc;
}

/**
 * Seed a new layout doc with the same defaults as the desktop app:
 *   - CornflowerBlue background
 *   - Grid layer (Layer 1, 96-stud cells, 3 sub-divisions)
 *   - Brick layer (Layer 2, empty)
 *
 * Mirrors MainWindowFileIO.cpp:200-249 "new map" sequence.
 */
export function createDefaultLayoutDoc(): Y.Doc {
  const now = new Date();
  const defaultMap: BbmMap = {
    version: BBM_FORMAT_VERSION,
    nbItems: 0,
    backgroundColor: { kind: 'known', name: 'CornflowerBlue' },
    author: '',
    lug: '',
    event: '',
    date: { day: now.getDate(), month: now.getMonth() + 1, year: now.getFullYear() },
    comment: '',
    exportInfo: {
      exportPath: '',
      exportFileType: 4,
      exportArea: { x: 0, y: 0, width: 0, height: 0 },
      exportScale: 0,
      exportWatermark: true,
      exportElectricCircuit: false,
      exportConnectionPoints: false,
    },
    selectedLayerIndex: 1,
    layers: [
      {
        id: 'grid-1',
        type: 'grid',
        name: 'Grid',
        visible: true,
        transparency: 100,
        hullProperties: { isVisible: false, hullColor: { kind: 'known', name: 'Black' }, hullThickness: 1 },
        gridColor: { kind: 'argb', argb: 'ffffffff' },
        gridThickness: 2,
        subGridColor: { kind: 'argb', argb: 'ffd3d3d3' },
        subGridThickness: 1,
        gridSizeInStud: 96,
        subDivisionNumber: 3,
        displayGrid: true,
        displaySubGrid: true,
        displayCellIndex: true,
        cellIndexFont: { family: 'Arial', size: 18, style: 'Regular' },
        cellIndexColor: { kind: 'argb', argb: 'ff000000' },
        cellIndexColumnType: '0',
        cellIndexRowType: '1',
        cellIndexCorner: { x: 0, y: 0 },
      },
      {
        id: 'brick-1',
        type: 'brick',
        name: 'Layout',
        visible: true,
        transparency: 100,
        hullProperties: { isVisible: false, hullColor: { kind: 'known', name: 'Black' }, hullThickness: 1 },
        displayBrickElevation: false,
        bricks: [],
        groups: [],
      },
    ],
  };
  const doc = new Y.Doc();
  bbmToDoc(defaultMap, doc);
  return doc;
}

export function createSidecarDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap('meta');
  doc.getMap('connections');
  doc.getArray('rulers');
  doc.getArray('areas');
  return doc;
}

/**
 * Seed a fresh Y.Doc from a parsed `.bbm` map using the full projection.
 * Replaces the Phase-2 `bbmCache` shortcut: every layer/brick/textCell now
 * lives in the Yjs tree and survives editing.
 */
export function seedFromBbm(map: BbmMap): Y.Doc {
  const doc = new Y.Doc();
  // Drawing settings out of range (a hand-edited or damaged file) are put
  // back in range, as the desktop does on reading one (drawnLimits.ts).
  bbmToDoc(keepDrawnSettingsInRange(map), doc);
  return doc;
}

export function seedFromSidecar(sidecar: Sidecar): Y.Doc {
  const doc = createSidecarDoc();
  const meta = doc.getMap('meta');
  meta.set('schemaVersion', sidecar.schemaVersion);
  meta.set('bbmHashSha256', sidecar.bbmHashSha256);
  importSidecarIntoDoc(doc, sidecar);
  return doc;
}

// ---------------------------------------------------------------------------
// The budget (how many of each part the layout may use) is the one sidecar
// field that doesn't live in `meta.cache`: the editor keeps it as a Y.Map at
// `meta.budgetLimits` (part number → limit), so two people changing
// different rows merge. A sidecar file carries it as `budgetLimits`.
// ---------------------------------------------------------------------------

export const BUDGET_LIMITS_KEY = 'budgetLimits';

/** The doc's budget as a sidecar field, or undefined when the layout has no budget. */
export function readBudgetLimitsFromDoc(doc: Y.Doc): Record<string, number> | undefined {
  const y = doc.getMap('meta').get(BUDGET_LIMITS_KEY);
  if (!(y instanceof Y.Map)) return undefined;
  const out: Record<string, number> = {};
  for (const [part, limit] of y.entries()) {
    if (typeof limit === 'number' && Number.isFinite(limit) && limit >= 0) out[part] = limit;
  }
  return out;
}

/**
 * Puts a sidecar into a doc the way the editor reads it: everything but the
 * budget in `meta.cache`, the budget in `meta.budgetLimits`. With no
 * budget in the sidecar, the doc's budget is left as it is.
 */
export function importSidecarIntoDoc(doc: Y.Doc, sidecar: Sidecar): void {
  const { budgetLimits, ...rest } = sidecar;
  const meta = doc.getMap('meta');
  meta.set('cache', rest as unknown as Record<string, unknown>);
  if (!budgetLimits) return;
  const y = new Y.Map<number>();
  for (const [part, limit] of Object.entries(budgetLimits)) y.set(part, limit);
  meta.set(BUDGET_LIMITS_KEY, y);
}

/** `cache` with the doc's budget, as a sidecar. */
function withBudget(doc: Y.Doc, cache: Record<string, unknown> | null): Sidecar | null {
  const budgetLimits = readBudgetLimitsFromDoc(doc);
  if (!cache) return budgetLimits ? { schemaVersion: 1, bbmHashSha256: '', budgetLimits } : null;
  const { budgetLimits: _inCache, ...rest } = cache;
  return (budgetLimits ? { ...rest, budgetLimits } : rest) as unknown as Sidecar;
}

// ---------------------------------------------------------------------------
// The sidecar (modules, anchored labels, views, venue, ...) lives in
// `meta.cache` as one plain object, so two people changing it at once used
// to lose one of the changes: the last write won. Modules and anchored
// labels are now also kept one per key in the `sidecarItems` map, so
// concurrent edits to different ones merge. `meta.cache` stays complete for
// readers that don't know the map (older apps, the desktop), and
// `sidecarItems.__blob` records which `meta.cache` the items go with: when a
// writer that doesn't know the map replaces `meta.cache`, the hash no longer
// matches and the blob is read as it is.
// ---------------------------------------------------------------------------

const SIDECAR_ITEMS = 'sidecarItems';
const ITEM_KINDS = [
  { field: 'modules', prefix: 'm:' },
  { field: 'anchoredLabels', prefix: 'l:' },
] as const;

/**
 * JSON with every object's keys in sorted order (by UTF-16 code unit), so the
 * text, and the hash, don't depend on the order a writer gave the keys: the
 * desktop's yrs keeps an object's keys in no fixed order.
 */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stableStringify(x))).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * Which sidecar blob the items go with: FNV-1a over the UTF-16 code units of
 * its key-sorted JSON, and the text's length. The desktop computes the same
 * (sync/SidecarItems.cpp; shared vectors in sidecarItems.test.ts).
 */
export function sidecarBlobHash(blob: unknown): string {
  return blobHash(blob);
}

function blobHash(blob: unknown): string {
  const text = stableStringify(blob);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${text.length}:${(h >>> 0).toString(16)}`;
}

/**
 * The sidecar as everyone's edits left it: `meta.cache` with its modules and
 * anchored labels taken from `sidecarItems` when those go with this blob.
 */
export function readSidecarCache(doc: Y.Doc): Record<string, unknown> | null {
  const blob = doc.getMap('meta').get('cache');
  if (!blob || typeof blob !== 'object') return null;
  const cache = blob as Record<string, unknown>;
  const items = doc.getMap(SIDECAR_ITEMS);
  const read = items.size === 0 || items.get('__blob') !== blobHash(cache) || !idsUnique(cache) ? cache : mergedSidecar(cache, items);
  // Inside a transaction a change may be half made (a module's parts
  // deleted before the new ones go in, replaceModuleParts): the write at
  // its end leaves out what's gone.
  return inTransaction(doc) ? read : withoutGoneParts(doc, read);
}

// ---------------------------------------------------------------------------
// A part deleted at the same instant someone adds it to a module stays in
// the module's list: the delete dropped it from the modules it was in then,
// and the other person's write lists it again. So the list is read, and
// written, without parts that aren't on the map any more; a module left
// with none goes, as a delete of its last part takes it (deleteBricks). The
// desktop does the same (SidecarItems.cpp). Only a layout's own doc is
// checked: a doc without `meta.version` (a sidecar kept on its own) has no
// parts to check against.
// ---------------------------------------------------------------------------

function inTransaction(doc: Y.Doc): boolean {
  return (doc as unknown as { _transaction: unknown })._transaction != null;
}

const brickIdMemo = new WeakMap<Y.Doc, { ids: Set<string>; stale: boolean }>();

/** The ids of every part (and text and ruler) on the map, or null for a doc that isn't a layout. */
function liveBrickIds(doc: Y.Doc): Set<string> | null {
  if (doc.getMap('meta').get('version') === undefined) return null;
  // Inside a transaction the parts may be changing: count them afresh.
  const changing = inTransaction(doc);
  const memo = brickIdMemo.get(doc);
  if (!changing && memo && !memo.stale) return memo.ids;
  const ids = new Set<string>();
  const layerData = doc.getMap('layerData');
  for (const layerId of doc.getArray<string>('layers').toArray()) {
    const layer = layerData.get(layerId);
    if (!(layer instanceof Y.Map)) continue;
    // Modules hold parts; a sidecar from elsewhere may list a text or a ruler too.
    for (const field of ['bricks', 'textCells', 'rulerItems']) {
      const list = layer.get(field);
      if (!(list instanceof Y.Array)) continue;
      for (const b of list.toArray()) {
        const id = b instanceof Y.Map ? b.get('id') : b && typeof b === 'object' ? (b as { id?: unknown }).id : undefined;
        if (typeof id === 'string') ids.add(id);
      }
    }
  }
  if (!changing) {
    if (memo) {
      memo.ids = ids;
      memo.stale = false;
    } else {
      const entry = { ids, stale: false };
      brickIdMemo.set(doc, entry);
      doc.on('afterTransaction', () => {
        entry.stale = true;
      });
    }
  }
  return ids;
}

/** `cache` without module members that aren't on the map (the same object when there are none). */
function withoutGoneParts(doc: Y.Doc, cache: Record<string, unknown>): Record<string, unknown> {
  const modules = cache.modules;
  if (!Array.isArray(modules) || modules.length === 0) return cache;
  const ids = liveBrickIds(doc);
  if (!ids) return cache;
  let changed = false;
  const kept: unknown[] = [];
  for (const m of modules) {
    const members = m && typeof m === 'object' ? (m as { members?: unknown }).members : undefined;
    if (!Array.isArray(members)) {
      kept.push(m);
      continue;
    }
    const here = members.filter((id) => typeof id === 'string' && ids.has(id));
    if (here.length === members.length) {
      kept.push(m);
      continue;
    }
    changed = true;
    // (A module that had no parts to begin with is kept: only one that lost them goes.)
    if (here.length > 0) kept.push({ ...(m as object), members: here });
  }
  return changed ? { ...cache, modules: kept } : cache;
}

// The items are keyed by id: a sidecar where a module or label has no id,
// or shares one, can't be split into them without losing an entry, so it's
// read (and kept) as the blob it is.
function idsUnique(cache: Record<string, unknown>): boolean {
  for (const { field } of ITEM_KINDS) {
    const list = cache[field];
    if (!Array.isArray(list)) continue;
    const seen = new Set<string>();
    for (const v of list) {
      const id = v && typeof v === 'object' ? (v as { id?: unknown }).id : undefined;
      if (typeof id !== 'string' || seen.has(id)) return false;
      seen.add(id);
    }
  }
  return true;
}

function mergedSidecar(cache: Record<string, unknown>, items: Y.Map<unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cache };
  for (const { field, prefix } of ITEM_KINDS) {
    const entries: { order: number; id: string; value: Record<string, unknown> }[] = [];
    items.forEach((v, k) => {
      if (!k.startsWith(prefix) || !v || typeof v !== 'object') return;
      const { _order, ...value } = v as Record<string, unknown>;
      entries.push({ order: typeof _order === 'number' ? _order : 0, id: k, value });
    });
    if (entries.length === 0 && !Array.isArray(cache[field])) continue;
    entries.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    out[field] = entries.map((e) => e.value);
  }
  return out;
}

/**
 * Write the sidecar: `meta.cache` whole, and each module and anchored label
 * under its own key, changing only the ones that differ. Call inside a
 * transaction.
 */
export function writeSidecarCache(doc: Y.Doc, written: Record<string, unknown>): void {
  const cache = withoutGoneParts(doc, written);
  const items = doc.getMap(SIDECAR_ITEMS);
  for (const { field, prefix } of ITEM_KINDS) {
    const list = Array.isArray(cache[field]) ? (cache[field] as Record<string, unknown>[]) : [];
    const want = new Map<string, Record<string, unknown>>();
    list.forEach((v, i) => {
      if (v && typeof v === 'object' && typeof v.id === 'string') want.set(prefix + v.id, { ...v, _order: i });
    });
    for (const k of [...items.keys()]) if (k.startsWith(prefix) && !want.has(k)) items.delete(k);
    for (const [k, v] of want) if (JSON.stringify(items.get(k)) !== JSON.stringify(v)) items.set(k, v);
  }
  doc.getMap('meta').set('cache', cache);
  items.set('__blob', blobHash(cache));
}

/**
 * After someone else's edits: when `meta.cache` lags the merged items (two
 * people changed modules at once), write it again so readers that only
 * know `meta.cache` see everyone's. Every client computes the same blob,
 * so two doing it at once agree. Returns whether it wrote.
 */
export function repairSidecarCache(doc: Y.Doc, origin: unknown): boolean {
  const blob = doc.getMap('meta').get('cache');
  if (!blob || typeof blob !== 'object') return false;
  const items = doc.getMap(SIDECAR_ITEMS);
  if (items.size === 0 || !idsUnique(blob as Record<string, unknown>)) return false;
  // (Without parts that aren't on the map: a module may list one deleted as it was added.)
  const merged = withoutGoneParts(doc, mergedSidecar(blob as Record<string, unknown>, items));
  const hash = blobHash(merged);
  if (items.get('__blob') === hash && JSON.stringify(merged) === JSON.stringify(blob)) return false;
  // Only when the items still go with a blob some writer of the map made
  // (a writer that doesn't know the map leaves the blob alone).
  if (!itemsKnownForBlob(items, blob as Record<string, unknown>)) return false;
  doc.transact(() => {
    doc.getMap('meta').set('cache', merged);
    items.set('__blob', hash);
  }, origin);
  return true;
}

// Concurrent writers of the map each set the blob and its hash; Yjs keeps
// one writer's pair, so a matching hash means the items are current.
function itemsKnownForBlob(items: Y.Map<unknown>, blob: Record<string, unknown>): boolean {
  return items.get('__blob') === blobHash(blob);
}

/**
 * Yjs can't move an item: a reorder or a move to another sheet deletes it and
 * inserts a copy. When two people move the same part at once, both copies
 * survive and the part is there twice. This removes the extra copies,
 * keeping the one Yjs made first (lowest client, then clock), so every
 * client keeps the same one whatever order it sees them in. Returns how many
 * it removed. Bricks only, across all part sheets; removeDuplicateItems
 * also does rulers and painted area cells.
 */
export function removeDuplicateBricks(doc: Y.Doc, origin: unknown): number {
  return removeDuplicates(doc, origin, ['bricks']);
}

/**
 * removeDuplicateBricks for everything edited by delete-and-insert: bricks
 * and rulers (by id), and painted area cells (by cell). Two people moving
 * the same ruler at once left it there twice, and deleting it then left
 * the other copy behind; two people painting the same cell at once left
 * two cells there, and erasing it left one painted.
 */
export function removeDuplicateItems(doc: Y.Doc, origin: unknown): number {
  return removeDuplicates(doc, origin, ['bricks', 'rulerItems', 'areas']);
}

type ItemField = 'bricks' | 'rulerItems' | 'areas';

function itemKey(field: ItemField, v: unknown): string | null {
  if (field === 'bricks' || (field === 'rulerItems' && v instanceof Y.Map)) {
    const id = v instanceof Y.Map ? v.get('id') : undefined;
    return typeof id === 'string' && id !== '' ? id : null;
  }
  if (!v || typeof v !== 'object' || v instanceof Y.AbstractType) return null;
  const o = v as Record<string, unknown>;
  if (field === 'rulerItems') return typeof o.id === 'string' && o.id !== '' ? o.id : null;
  return typeof o.x === 'number' && typeof o.y === 'number' ? `${o.x},${o.y}` : null;
}

// Every live entry of a Y.Array with the id Yjs gave it (one item can hold
// several plain values: the n-th has the item's clock + n).
function entriesWithIds(arr: Y.Array<unknown>): { value: unknown; index: number; key: [number, number] }[] {
  const out: { value: unknown; index: number; key: [number, number] }[] = [];
  let index = 0;
  for (let n = arr._start; n; n = n.right) {
    if (n.deleted || !n.countable) continue;
    const content = n.content.getContent();
    for (let k = 0; k < content.length; k++) out.push({ value: content[k], index: index++, key: [n.id.client, n.id.clock + k] });
  }
  return out;
}

type Hit = { arr: Y.Array<unknown>; index: number; key: [number, number] };

function removeDuplicates(doc: Y.Doc, origin: unknown, fields: readonly ItemField[]): number {
  const layerData = doc.getMap('layerData');
  const extra: Hit[] = [];
  for (const field of fields) {
    // A brick id is unique across all part sheets; rulers and cells per sheet.
    const shared = new Map<string, Hit[]>();
    for (const id of doc.getArray<string>('layers').toArray()) {
      const layer = layerData.get(id);
      if (!(layer instanceof Y.Map)) continue;
      const arr = layer.get(field);
      if (!(arr instanceof Y.Array)) continue;
      const byKey = field === 'bricks' ? shared : new Map<string, Hit[]>();
      for (const e of entriesWithIds(arr as Y.Array<unknown>)) {
        const k = itemKey(field, e.value);
        if (k === null) continue;
        const list = byKey.get(k) ?? [];
        list.push({ arr: arr as Y.Array<unknown>, index: e.index, key: e.key });
        byKey.set(k, list);
      }
      if (byKey !== shared) collectExtra(byKey, extra);
    }
    collectExtra(shared, extra);
  }
  if (extra.length === 0) return 0;
  // Highest index first within each array, so earlier indexes stay valid.
  extra.sort((x, y) => y.index - x.index);
  doc.transact(() => {
    for (const h of extra) h.arr.delete(h.index, 1);
  }, origin);
  return extra.length;
}

function collectExtra(byKey: Map<string, Hit[]>, extra: Hit[]): void {
  for (const hits of byKey.values()) {
    if (hits.length < 2) continue;
    hits.sort((x, y) => x.key[0] - y.key[0] || x.key[1] - y.key[1]);
    extra.push(...hits.slice(1));
  }
}

/**
 * Best-effort read of the sidecar blob from a doc's meta. Returns null
 * if absent. Used by the editor's overlays (anchored labels, venue,
 * module annotations) to render fork-only data alongside the main map.
 *
 * The sidecar is a passive cache — until the editor learns to mutate
 * each entry collaboratively, it round-trips verbatim.
 */
export function readSidecarFromDoc(doc: Y.Doc): Sidecar | null {
  return withBudget(doc, readSidecarCache(doc));
}

/** Encode a doc to its binary y-update form — what we persist in the DB. */
export function encodeDoc(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

/** Reconstruct a doc from a stored snapshot. */
export function decodeDoc(bytes: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  return doc;
}

/**
 * Reconstruct a BbmMap from a populated Yjs doc. Returns `null` if the doc
 * is empty (no `meta.version` set) — i.e. the caller never seeded it from
 * a .bbm or `bbmToDoc`. The projection round-trips losslessly with
 * `bbmToDoc`, so this is the export path used by the server's
 * `/api/layouts/:id/export.bbm` route.
 */
export function exportBbmFromDoc(doc: Y.Doc): BbmMap | null {
  if (doc.getMap('meta').get('version') === undefined) return null;
  return docToBbm(doc);
}

export function exportSidecarFromDoc(doc: Y.Doc): Sidecar | null {
  return withBudget(doc, readSidecarCache(doc));
}
