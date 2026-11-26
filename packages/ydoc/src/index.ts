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
import { readPlace, readRecordsField, readRoutesField, readSwitchStatesField, readTrainScaleField, type Place, type Sidecar, type SidecarRecord, type SidecarRoute } from '@cld/bbm';
import { bbmToDoc, docToBbm } from './projection.js';
import { keepDrawnSettingsInRange } from './drawnLimits.js';

import { DOC_BASE_SCHEMA } from './shape.js';
import { MEMBER_PREFIX, memberKey, memberKeysByModule, memberWrites, moduleMembers, parseMemberKey, stampMemberKeysAfter } from './moduleMembers.js';
import { hasSharedMark, stampSharedAfter } from './sharedShape.js';

export { bbmToDoc, docToBbm, createDocProjector, type DocProjector } from './projection.js';
export * from './shape.js';
export { DRAWN_LIMITS, keepDrawnSettingsInRange } from './drawnLimits.js';
export {
  DOC_SHAPE_MEMBER_KEYS,
  MEMBER_PREFIX,
  memberKey,
  memberWrites,
  moduleMembers,
  parseMemberKey,
  stampMemberKeys,
  validMemberValue,
  type MemberWrites,
} from './moduleMembers.js';
export { RECORD_MAPS, ensureRecordMaps } from './recordMaps.js';
export { DOC_MIN_READABLE, DOC_SCHEMA_VERSION, canReadDoc, makeId, upgradeDoc } from './ids.js';
export { DOC_SHAPE_SHARED, hasSharedMark, holdsSharedModule, stampShared, stampSharedAfter } from './sharedShape.js';
export { DOC_SHAPE_KEEP_IDS, KEPT_IDS_MARK, restampKeepIds, stampKeepIds } from './keepIdsShape.js';

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
  const { budgetLimits, switchStates, routes, rollingStock, trains, trainScale, layoutPlaces, waybills, opsJobs, opsSessions, opsLog, ...rest } = sidecar;
  const meta = doc.getMap('meta');
  meta.set('cache', rest as unknown as Record<string, unknown>);
  if (trainScale !== undefined) meta.set(TRAIN_SCALE_KEY, trainScale);
  if (routes && routes.length > 0) {
    const y = new Y.Map<Y.Map<unknown>>();
    for (const r of routes) y.set(r.id, routeMap(r));
    meta.set(ROUTES_KEY, y);
  }
  for (const [key, list] of [[ROLLING_STOCK_KEY, rollingStock], [TRAINS_KEY, trains], [PLACES_KEY, layoutPlaces], [WAYBILLS_KEY, waybills], [OPS_JOBS_KEY, opsJobs], [OPS_SESSIONS_KEY, opsSessions], [OPS_LOG_KEY, opsLog]] as const) {
    if (!list || list.length === 0) continue;
    const y = new Y.Map<Y.Map<unknown>>();
    for (const r of list) y.set(r.id, routeMap(r as SidecarRoute));
    meta.set(key, y);
  }
  if (switchStates && Object.keys(switchStates).length > 0) {
    const y = new Y.Map<number>();
    for (const [key, exit] of Object.entries(switchStates)) y.set(key, exit);
    meta.set(SWITCH_STATES_KEY, y);
  }
  if (!budgetLimits) return;
  const y = new Y.Map<number>();
  for (const [part, limit] of Object.entries(budgetLimits)) y.set(part, limit);
  meta.set(BUDGET_LIMITS_KEY, y);
}

/** `cache` with the doc's budget and switch settings, as a sidecar. */
function withBudget(doc: Y.Doc, cache: Record<string, unknown> | null): Sidecar | null {
  const budgetLimits = readBudgetLimitsFromDoc(doc);
  const states = readSwitchStatesFromDoc(doc);
  const switchStates = Object.keys(states).length > 0 ? states : undefined;
  const allRoutes = readRoutesFromDoc(doc);
  const routes = allRoutes.length > 0 ? allRoutes : undefined;
  const stockList = readRecordsFromDoc(doc, ROLLING_STOCK_KEY);
  const trainList = readRecordsFromDoc(doc, TRAINS_KEY);
  const trainScale = readTrainScaleFromDoc(doc);
  const layoutPlaces = readPlacesFromDoc(doc);
  const waybills = readRecordsFromDoc(doc, WAYBILLS_KEY);
  const opsJobs = readRecordsFromDoc(doc, OPS_JOBS_KEY);
  const opsSessions = readRecordsFromDoc(doc, OPS_SESSIONS_KEY);
  const opsLog = readRecordsFromDoc(doc, OPS_LOG_KEY);
  const live = {
    ...(budgetLimits ? { budgetLimits } : {}),
    ...(switchStates ? { switchStates } : {}),
    ...(routes ? { routes } : {}),
    ...(stockList.length ? { rollingStock: stockList } : {}),
    ...(trainList.length ? { trains: trainList } : {}),
    ...(trainScale !== undefined ? { trainScale } : {}),
    ...(layoutPlaces.length ? { layoutPlaces } : {}),
    ...(waybills.length ? { waybills } : {}),
    ...(opsJobs.length ? { opsJobs } : {}),
    ...(opsSessions.length ? { opsSessions } : {}),
    ...(opsLog.length ? { opsLog } : {}),
  };
  if (!cache) {
    if (!budgetLimits && !switchStates && !routes && !stockList.length && !trainList.length && trainScale === undefined && !layoutPlaces.length && !waybills.length && !opsJobs.length && !opsSessions.length && !opsLog.length) return null;
    return { schemaVersion: 1, bbmHashSha256: '', ...live };
  }
  const { budgetLimits: _inCache, switchStates: _statesInCache, routes: _routesInCache, rollingStock: _stockInCache, trains: _trainsInCache, trainScale: _scaleInCache, layoutPlaces: _placesInCache, waybills: _waybillsInCache, opsJobs: _jobsInCache, opsSessions: _sessionsInCache, opsLog: _logInCache, ...rest } = cache;
  return { ...withoutMovedExtras(rest), ...live } as unknown as Sidecar;
}

// ---------------------------------------------------------------------------
// Switch settings (trains design 2.2) live outside `meta.cache` too, as a
// Y.Map at `meta.switchStates` ("<brick id>/<heel>" -> the connection a
// train leaves by), set one key at a time like the budget: two people
// flipping different switches merge; the same switch, the last one wins. A
// switch without a key is set to its default. An older web build that
// imported a file kept the field in `meta.cache`; it is read from there
// until the first flip moves it over.
// ---------------------------------------------------------------------------

export const SWITCH_STATES_KEY = 'switchStates';

// ---------------------------------------------------------------------------
// The scale trains run at (trains design 5), 1:N, is a plain number at
// `meta.trainScale` (the last one set wins); none means 1:38. An older web
// build that imported a file kept it in `meta.cache`: read from there.
// ---------------------------------------------------------------------------

export const TRAIN_SCALE_KEY = 'trainScale';

/** The layout's train scale (the N of 1:N), or undefined when it has none set. */
export function readTrainScaleFromDoc(doc: Y.Doc): number | undefined {
  const meta = doc.getMap('meta');
  const v = meta.get(TRAIN_SCALE_KEY);
  if (v !== undefined) return readTrainScaleField(v);
  const cache = meta.get('cache') as Record<string, unknown> | undefined;
  return readTrainScaleField(cache?.trainScale);
}

/** Set the layout's train scale (null: back to 1:38). Call inside the caller's transaction. */
export function writeTrainScale(doc: Y.Doc, scale: number | null): void {
  const meta = doc.getMap('meta');
  const v = scale === null ? undefined : readTrainScaleField(scale);
  if (v === undefined) {
    if (meta.has(TRAIN_SCALE_KEY)) meta.delete(TRAIN_SCALE_KEY);
  } else if (meta.get(TRAIN_SCALE_KEY) !== v) meta.set(TRAIN_SCALE_KEY, v);
}

// ---------------------------------------------------------------------------
// Named routes (trains design 2.5) live at `meta.routes`: a Y.Map of route
// id -> a Y.Map of its fields, so two people's edits to different routes,
// or to different fields of one (a rename and a new way), merge. Arrays
// (steps, via) are plain values, replaced whole. An older web build that
// imported a file kept them in `meta.cache`: read from there until the
// first write moves them over.
// ---------------------------------------------------------------------------

export const ROUTES_KEY = 'routes';

function routeMap(r: SidecarRoute): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(r)) if (v !== undefined) m.set(k, v);
  return m;
}

/** The doc's named routes, by name then id ([] when none). */
export function readRoutesFromDoc(doc: Y.Doc): SidecarRoute[] {
  const meta = doc.getMap('meta');
  const y = meta.get(ROUTES_KEY);
  let out: SidecarRoute[];
  if (y instanceof Y.Map) {
    out = [];
    for (const [id, v] of y.entries()) {
      if (!(v instanceof Y.Map)) continue;
      const r = v.toJSON() as Record<string, unknown>;
      out.push({ ...r, id, name: typeof r.name === 'string' ? r.name : '' });
    }
  } else {
    const cache = meta.get('cache') as Record<string, unknown> | undefined;
    out = readRoutesField(cache?.routes) ?? [];
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function routesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  const meta = doc.getMap('meta');
  let y = meta.get(ROUTES_KEY);
  if (!(y instanceof Y.Map)) {
    const fromCache = readRoutesFromDoc(doc);
    y = new Y.Map<Y.Map<unknown>>();
    for (const r of fromCache) (y as Y.Map<Y.Map<unknown>>).set(r.id, routeMap(r));
    meta.set(ROUTES_KEY, y);
  }
  return y as Y.Map<Y.Map<unknown>>;
}

/**
 * Add a route, or change one: only the fields that differ are written, so
 * someone else's change to another field stays. Fields not in `route` are
 * left as they are. Call inside the caller's transaction.
 */
export function writeRoute(doc: Y.Doc, route: SidecarRoute): void {
  const all = routesMap(doc);
  const cur = all.get(route.id);
  if (!(cur instanceof Y.Map)) {
    all.set(route.id, routeMap(route));
    return;
  }
  for (const [k, v] of Object.entries(route)) {
    if (v === undefined) continue;
    if (JSON.stringify(cur.get(k)) !== JSON.stringify(v)) cur.set(k, v);
  }
}

// ---------------------------------------------------------------------------
// Rolling stock and trains (trains design 2.3, 2.4) are kept the same way:
// `meta.rollingStock` and `meta.trains`, a Y.Map of id -> a Y.Map of
// fields, so different records, and different fields of one, merge. Arrays
// (units, trucks, tags) are plain values, replaced whole.
// ---------------------------------------------------------------------------

export const ROLLING_STOCK_KEY = 'rollingStock';
export const TRAINS_KEY = 'trains';
/**
 * The layout's own places (Live Ops design 2.1; a module's are in its
 * sidecar value). An older web build that imported a file kept them in
 * meta.cache's extras: read from there until the first write moves them.
 */
export const PLACES_KEY = 'places';
/** Waybills and jobs (Live Ops design 2.4, 2.5): flat fields, kept like trains; an older web build kept a file's in the cache's extras too. */
export const WAYBILLS_KEY = 'waybills';
export const OPS_JOBS_KEY = 'opsJobs';
/** Operating sessions and their log (Live Ops design 2.5, 4): kept like jobs; a log entry is never changed once written. */
export const OPS_SESSIONS_KEY = 'opsSessions';
export const OPS_LOG_KEY = 'opsLog';
type RecordsKey = typeof ROLLING_STOCK_KEY | typeof TRAINS_KEY | typeof PLACES_KEY | typeof WAYBILLS_KEY | typeof OPS_JOBS_KEY | typeof OPS_SESSIONS_KEY | typeof OPS_LOG_KEY;

/** The doc's own places, each within the limits (@cld/bbm places.ts), by name then id. */
export function readPlacesFromDoc(doc: Y.Doc): Place[] {
  // (Two people may each add the last ones at once: none is left out here.)
  const list = readRecordsFromDoc(doc, PLACES_KEY).flatMap((r) => readPlace(r) ?? []);
  return list.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Add a place of the layout's own, or change one. Call inside the caller's transaction. */
export function writePlace(doc: Y.Doc, place: Place): void {
  writeRecord(doc, PLACES_KEY, place);
  // (A field taken away, as an imported place's `source`, goes too.)
  const cur = (doc.getMap('meta').get(PLACES_KEY) as Y.Map<Y.Map<unknown>>).get(place.id);
  if (cur instanceof Y.Map) for (const k of [...cur.keys()]) if (!(k in place)) cur.delete(k);
}

/** The kinds of records an older build, not knowing them, left in the cache's extras, and their name there. */
const IN_EXTRAS: Partial<Record<RecordsKey, string>> = { [PLACES_KEY]: 'layoutPlaces', [WAYBILLS_KEY]: 'waybills', [OPS_JOBS_KEY]: 'opsJobs', [OPS_SESSIONS_KEY]: 'opsSessions', [OPS_LOG_KEY]: 'opsLog' };

/** The cache's extras without those records (they are read above). */
function withoutMovedExtras(cache: Record<string, unknown>): Record<string, unknown> {
  const extras = cache.extras;
  if (!extras || typeof extras !== 'object' || !Object.values(IN_EXTRAS).some((k) => k in extras)) return cache;
  const rest = Object.fromEntries(Object.entries(extras).filter(([k]) => !Object.values(IN_EXTRAS).includes(k)));
  const { extras: _extras, ...out } = cache;
  return Object.keys(rest).length > 0 ? { ...out, extras: rest } : out;
}

function recordsInCache(cache: Record<string, unknown> | undefined, key: RecordsKey): unknown {
  const name = IN_EXTRAS[key];
  if (!name) return cache?.[key];
  const extras = cache?.extras;
  return cache?.[name] ?? (extras && typeof extras === 'object' ? (extras as Record<string, unknown>)[name] : undefined);
}

/** The doc's rolling stock or trains, in id order ([] when none); an older build's copy in meta.cache is read too. */
export function readRecordsFromDoc(doc: Y.Doc, key: RecordsKey): SidecarRecord[] {
  const meta = doc.getMap('meta');
  const y = meta.get(key);
  if (!(y instanceof Y.Map)) {
    const cache = meta.get('cache') as Record<string, unknown> | undefined;
    return readRecordsField(recordsInCache(cache, key)) ?? [];
  }
  const out: SidecarRecord[] = [];
  for (const [id, v] of y.entries()) if (v instanceof Y.Map) out.push({ ...(v.toJSON() as Record<string, unknown>), id });
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function recordsMap(doc: Y.Doc, key: RecordsKey): Y.Map<Y.Map<unknown>> {
  const meta = doc.getMap('meta');
  let y = meta.get(key);
  if (!(y instanceof Y.Map)) {
    const fromCache = readRecordsFromDoc(doc, key);
    y = new Y.Map<Y.Map<unknown>>();
    for (const r of fromCache) (y as Y.Map<Y.Map<unknown>>).set(r.id, routeMap(r as SidecarRoute));
    meta.set(key, y);
  }
  return y as Y.Map<Y.Map<unknown>>;
}

/** Add or change a record (only fields that differ are written). Call inside the caller's transaction. */
export function writeRecord(doc: Y.Doc, key: RecordsKey, record: SidecarRecord): void {
  const all = recordsMap(doc, key);
  const cur = all.get(record.id);
  if (!(cur instanceof Y.Map)) {
    all.set(record.id, routeMap(record as SidecarRoute));
    return;
  }
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined) continue;
    if (JSON.stringify(cur.get(k)) !== JSON.stringify(v)) cur.set(k, v);
  }
}

/** Delete a record. Call inside the caller's transaction. */
export function deleteRecord(doc: Y.Doc, key: RecordsKey, id: string): void {
  const all = recordsMap(doc, key);
  if (all.has(id)) all.delete(id);
}

/** Delete a route. Call inside the caller's transaction. */
export function deleteRoute(doc: Y.Doc, id: string): void {
  const all = routesMap(doc);
  if (all.has(id)) all.delete(id);
}

/** The doc's switch settings ({} when none is set). */
export function readSwitchStatesFromDoc(doc: Y.Doc): Record<string, number> {
  const meta = doc.getMap('meta');
  const y = meta.get(SWITCH_STATES_KEY);
  if (y instanceof Y.Map) {
    const out: Record<string, number> = {};
    for (const [key, exit] of y.entries()) if (typeof exit === 'number' && Number.isInteger(exit) && exit >= 0) out[key] = exit;
    return out;
  }
  const cache = meta.get('cache') as Record<string, unknown> | undefined;
  return readSwitchStatesField(cache?.switchStates) ?? {};
}

/**
 * Set some switches (null: back to the default, the key goes), one key at a
 * time. Keys of parts no longer on the map (`present`, when given) are
 * dropped as it writes. Call inside the caller's transaction (its origin
 * decides whether Undo takes it back).
 */
export function writeSwitchStates(doc: Y.Doc, changes: Readonly<Record<string, number | null>>, present?: ReadonlySet<string>): void {
  const meta = doc.getMap('meta');
  let y = meta.get(SWITCH_STATES_KEY);
  if (!(y instanceof Y.Map)) {
    const fromCache = readSwitchStatesFromDoc(doc);
    y = new Y.Map<number>();
    for (const [key, exit] of Object.entries(fromCache)) (y as Y.Map<number>).set(key, exit);
    meta.set(SWITCH_STATES_KEY, y);
  }
  const ym = y as Y.Map<number>;
  for (const [key, exit] of Object.entries(changes)) {
    if (exit === null) {
      if (ym.has(key)) ym.delete(key);
    } else if (ym.get(key) !== exit) {
      ym.set(key, exit);
    }
  }
  if (present) {
    for (const key of [...ym.keys()]) {
      const at = key.lastIndexOf('/');
      if (at <= 0 || !present.has(key.slice(0, at))) ym.delete(key);
    }
  }
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
//
// A module's value keeps the `members` list it was made with; each part
// added or taken out since is a `p:` key of its own (moduleMembers.ts), so
// two people changing one module's parts at once both keep their change.
// `meta.cache` has every module's full list.
// ---------------------------------------------------------------------------

const SIDECAR_ITEMS = 'sidecarItems';
const ITEM_KINDS = [
  { field: 'modules', prefix: 'm:' },
  { field: 'anchoredLabels', prefix: 'l:' },
] as const;

/** A plain object, as every app writes the sidecar's values (never one of Yjs's own types). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Y.AbstractType);
}

/**
 * JSON with every object's keys in sorted order (by UTF-16 code unit), so the
 * text, and the hash, don't depend on the order a writer gave the keys: the
 * desktop's yrs keeps an object's keys in no fixed order.
 */
function stableStringify(v: unknown): string {
  // (Not a value any app writes: never equal to one that is.)
  if (v instanceof Y.AbstractType) return 'nested';
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
  if (!isPlainObject(blob)) return null;
  const cache = blob;
  // Inside a transaction a change may be half made (a module's parts
  // deleted before the new ones go in, replaceModuleParts): the write at
  // its end leaves out what's gone.
  if (inTransaction(doc)) return mergedRead(doc, cache);
  // The same answer while the sidecar, its items and the ids on the map
  // stay as they were: each read hashed the whole sidecar, and put its
  // modules together again (about 1 ms a read on 7,520 parts in modules,
  // many reads per render).
  const ids = liveBrickIds(doc);
  const idsReads = ids ? (brickIdMemo.get(doc)?.reads ?? -1) : -1;
  let memo = sidecarMemo.get(doc);
  if (!memo) {
    const entry: SidecarMemo = { blob: null, stamp: 0, idsReads: -1, out: null };
    memo = entry;
    sidecarMemo.set(doc, entry);
    const meta = doc.getMap('meta');
    const items = doc.getMap(SIDECAR_ITEMS);
    doc.on('beforeObserverCalls', (tr: Y.Transaction) => {
      if (tr.changed.has(meta as unknown as Y.AbstractType<Y.YEvent<Y.AbstractType<unknown>>>) || tr.changed.has(items as unknown as Y.AbstractType<Y.YEvent<Y.AbstractType<unknown>>>)) entry.stamp++;
    });
  } else if (memo.out && memo.blob === blob && memo.idsReads === idsReads && memo.stamp === memo.stampRead) {
    return memo.out;
  }
  const out = withoutGoneParts(doc, mergedRead(doc, cache));
  memo.blob = blob;
  memo.idsReads = idsReads;
  memo.stampRead = memo.stamp;
  memo.out = out;
  return out;
}

interface SidecarMemo {
  blob: unknown;
  /** Bumped by each transaction that changes `meta` or the items. */
  stamp: number;
  /** `stamp` when `out` was read. */
  stampRead?: number;
  idsReads: number;
  out: Record<string, unknown> | null;
}
const sidecarMemo = new WeakMap<Y.Doc, SidecarMemo>();

function mergedRead(doc: Y.Doc, cache: Record<string, unknown>): Record<string, unknown> {
  const items = doc.getMap(SIDECAR_ITEMS);
  return items.size === 0 || items.get('__blob') !== blobHash(cache) || !idsUnique(cache) ? cache : mergedSidecar(cache, items);
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

// The ids on the map are kept up to date list by list: a transaction that
// only changes parts in place (a move, a turn: almost every edit, anyone's)
// leaves them as they were, and one that adds or takes parts out of a list
// reads that list again. On 7,520 parts in modules every transaction read
// every part's id again (about 2.4 ms, 10 ms at 4x slowed CPU).

/** Modules hold parts; a sidecar from elsewhere may list a text or a ruler too. */
const ID_FIELDS: ReadonlySet<string> = new Set(['bricks', 'textCells', 'rulerItems']);

interface BrickIdMemo {
  /** Every id on the map (one entry per id, however many lists have it). */
  ids: Set<string>;
  /** How many entries of the lists have each id. */
  counts: Map<string, number>;
  /** Each list read, and the ids it had then. */
  lists: Map<Y.Array<unknown>, string[]>;
  /** Lists to read again; `all` when the sheets themselves changed. */
  dirty: Set<Y.Array<unknown>>;
  all: boolean;
  /** How many times a list or the whole map was read (for tests); also tells a changed `ids` apart. */
  reads: number;
}

const brickIdMemo = new WeakMap<Y.Doc, BrickIdMemo>();

function idOf(b: unknown): string | undefined {
  const id = b instanceof Y.Map ? b.get('id') : b && typeof b === 'object' && !(b instanceof Y.AbstractType) ? (b as { id?: unknown }).id : undefined;
  return typeof id === 'string' ? id : undefined;
}

function idsOfList(list: Y.Array<unknown>): string[] {
  const out: string[] = [];
  for (const b of list.toArray()) {
    const id = idOf(b);
    if (id !== undefined) out.push(id);
  }
  return out;
}

/** Every id list on the map now. */
function idLists(doc: Y.Doc): Y.Array<unknown>[] {
  const out: Y.Array<unknown>[] = [];
  const layerData = doc.getMap('layerData');
  for (const layerId of doc.getArray<string>('layers').toArray()) {
    const layer = layerData.get(layerId);
    if (!(layer instanceof Y.Map)) continue;
    for (const field of ID_FIELDS) {
      const list = layer.get(field);
      if (list instanceof Y.Array) out.push(list);
    }
  }
  return out;
}

function countIds(m: BrickIdMemo, ids: readonly string[], by: 1 | -1): void {
  for (const id of ids) {
    const n = (m.counts.get(id) ?? 0) + by;
    if (n > 0) {
      m.counts.set(id, n);
      m.ids.add(id);
    } else {
      m.counts.delete(id);
      m.ids.delete(id);
    }
  }
}

/** What a transaction changed that the kept ids depend on. */
function markIdChanges(doc: Y.Doc, m: BrickIdMemo, tr: Y.Transaction): void {
  if (m.all) return;
  const layerData = doc.share.get('layerData');
  const layers = doc.share.get('layers');
  for (const [type, keys] of tr.changed) {
    // Sheets added, taken away or put in another order, or the map's own `meta.version`.
    if (type === layerData || type === layers) {
      m.all = true;
      return;
    }
    const item = type._item;
    if (!item) continue;
    // A list of parts, texts or rulers had entries added or taken out.
    if (type instanceof Y.Array && typeof item.parentSub === 'string' && ID_FIELDS.has(item.parentSub)) {
      m.dirty.add(type);
      continue;
    }
    if (!(type instanceof Y.Map)) continue;
    // A sheet given a new list.
    if (item.parent === layerData) {
      for (const k of keys) {
        if (k !== null && ID_FIELDS.has(k)) {
          m.all = true;
          return;
        }
      }
      continue;
    }
    // A part given another id (else a part changed in place: its id stands).
    if (keys.has('id')) {
      const list = item.parent;
      if (list instanceof Y.Array) m.dirty.add(list);
      else m.all = true;
    }
  }
}

/** The ids of every part (and text and ruler) on the map, or null for a doc that isn't a layout. */
function liveBrickIds(doc: Y.Doc): Set<string> | null {
  if (doc.getMap('meta').get('version') === undefined) return null;
  // Inside a transaction the parts may be changing: count them afresh.
  if (inTransaction(doc)) {
    const ids = new Set<string>();
    for (const list of idLists(doc)) for (const id of idsOfList(list)) ids.add(id);
    return ids;
  }
  let m = brickIdMemo.get(doc);
  if (!m) {
    const entry: BrickIdMemo = { ids: new Set(), counts: new Map(), lists: new Map(), dirty: new Set(), all: true, reads: 0 };
    m = entry;
    brickIdMemo.set(doc, entry);
    // Before any observer runs, so one that reads the sidecar sees this transaction's parts.
    doc.on('beforeObserverCalls', (tr: Y.Transaction) => markIdChanges(doc, entry, tr));
  }
  if (m.all) {
    m.all = false;
    m.dirty.clear();
    m.ids = new Set();
    m.counts.clear();
    m.lists.clear();
    m.reads++;
    for (const list of idLists(doc)) {
      const ids = idsOfList(list);
      m.lists.set(list, ids);
      countIds(m, ids, 1);
    }
  } else if (m.dirty.size > 0) {
    for (const list of m.dirty) {
      const had = m.lists.get(list);
      // A list that isn't on the map (a sheet's old list, or one not read yet) counts only when it is.
      if (!had && !idLists(doc).includes(list)) continue;
      m.reads++;
      if (had) countIds(m, had, -1);
      if (list._item?.deleted) {
        m.lists.delete(list);
        continue;
      }
      const ids = idsOfList(list);
      m.lists.set(list, ids);
      countIds(m, ids, 1);
    }
    m.dirty.clear();
  }
  return m.ids;
}

/** How many times the map's ids were read, whole or a list at a time (for tests). */
export function liveBrickIdReads(doc: Y.Doc): number {
  return brickIdMemo.get(doc)?.reads ?? 0;
}

/** `cache` without module members that aren't on the map (the same object when there are none). */
// The last answer for each sidecar read, while the ids on the map stay as
// they were: every read went through every module's parts again (each part
// of a module-heavy layout, many times per render).
const goneMemo = new WeakMap<object, { doc: Y.Doc; reads: number; out: Record<string, unknown> }>();

function withoutGoneParts(doc: Y.Doc, cache: Record<string, unknown>): Record<string, unknown> {
  const modules = cache.modules;
  if (!Array.isArray(modules) || modules.length === 0) return cache;
  const ids = liveBrickIds(doc);
  if (!ids) return cache;
  const memo = inTransaction(doc) ? undefined : brickIdMemo.get(doc);
  if (memo) {
    const had = goneMemo.get(cache);
    if (had && had.doc === doc && had.reads === memo.reads) return had.out;
    const out = withoutGone(cache, modules, ids);
    goneMemo.set(cache, { doc, reads: memo.reads, out });
    return out;
  }
  return withoutGone(cache, modules, ids);
}

function withoutGone(cache: Record<string, unknown>, modules: unknown[], ids: ReadonlySet<string>): Record<string, unknown> {
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
  const memberKeys = memberKeysByModule(items);
  for (const { field, prefix } of ITEM_KINDS) {
    const entries: { order: number; id: string; value: Record<string, unknown> }[] = [];
    items.forEach((v, k) => {
      if (!k.startsWith(prefix) || !isPlainObject(v)) return;
      const { _order, ...value } = v as Record<string, unknown>;
      // A module's parts: its starting list with what the `p:` keys changed.
      const keys = field === 'modules' ? memberKeys.get(k.slice(prefix.length)) : undefined;
      if (keys) value.members = moduleMembers(value.members, keys);
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
 * under its own key, changing only the ones that differ. A module that is
 * already there keeps its starting list, and the parts added to it or taken
 * out are written one key each (moduleMembers.ts). Call inside a
 * transaction.
 */
export function writeSidecarCache(doc: Y.Doc, written: Record<string, unknown>): void {
  const cache = withoutGoneParts(doc, written);
  const items = doc.getMap(SIDECAR_ITEMS);
  const blob = doc.getMap('meta').get('cache');
  // Whether the items are what the layout holds now. When they aren't (a
  // writer that doesn't know them replaced meta.cache, or ids are missing
  // or shared), each module starts again from the list written here.
  const splittable = idsUnique(cache);
  const current =
    splittable && items.size > 0 && isPlainObject(blob) && items.get('__blob') === blobHash(blob) && idsUnique(blob);
  const memberKeys = memberKeysByModule(items);
  const dropMemberKeys = (moduleId: string): void => {
    for (const k of [...items.keys()]) if (k.startsWith(MEMBER_PREFIX) && parseMemberKey(k)?.moduleId === moduleId) items.delete(k);
  };
  let wroteMemberKey = false;
  for (const { field, prefix } of ITEM_KINDS) {
    const list = Array.isArray(cache[field]) ? (cache[field] as Record<string, unknown>[]) : [];
    const want = new Map<string, Record<string, unknown>>();
    list.forEach((v, i) => {
      if (!v || typeof v !== 'object' || typeof v.id !== 'string') return;
      const k = prefix + v.id;
      if (field !== 'modules') {
        want.set(k, { ...v, _order: i });
        return;
      }
      const had = items.get(k);
      if (!current || !isPlainObject(had)) {
        // A new module (or one read from meta.cache): the list is its starting list.
        if (memberKeys.has(v.id)) dropMemberKeys(v.id);
        want.set(k, { ...v, _order: i });
        return;
      }
      const start = (had as Record<string, unknown>).members;
      const { members, ...rest } = v;
      want.set(k, start === undefined ? { ...rest, _order: i } : { ...rest, members: start, _order: i });
      if (!Array.isArray(members)) return;
      const keys = memberKeys.get(v.id) ?? new Map<string, number | false>();
      const writes = memberWrites(start, keys, members.filter((x): x is string => typeof x === 'string'));
      for (const id of writes.delete) items.delete(memberKey(v.id, id));
      for (const [id, value] of writes.set) {
        items.set(memberKey(v.id, id), value);
        wroteMemberKey = true;
      }
    });
    for (const k of [...items.keys()]) {
      if (!k.startsWith(prefix) || want.has(k)) continue;
      items.delete(k);
      if (field === 'modules') dropMemberKeys(k.slice(prefix.length));
    }
    for (const [k, v] of want) if (stableStringify(items.get(k)) !== stableStringify(v)) items.set(k, v);
  }
  // meta.cache as the items now read (a module's parts in the order the
  // keys give), so every writer, here and on the desktop, writes the same.
  const out = splittable ? mergedSidecar(cache, items) : cache;
  doc.getMap('meta').set('cache', out);
  items.set('__blob', blobHash(out));
  // Builds that read only the starting lists must refuse the doc from here.
  if (wroteMemberKey) stampMemberKeysAfter(doc);
  // And builds that don't know a shared module is locked (sharedShape.ts).
  if (Array.isArray(out.modules) && (out.modules as unknown[]).some(hasSharedMark)) stampSharedAfter(doc);
}

/** What repairSidecarShape would put right: values that aren't plain ones, and second entries with a shared module's id. */
export interface SidecarShapeProblems {
  nested: number;
  second: number;
}

function sidecarShape(doc: Y.Doc) {
  const items = doc.getMap<unknown>(SIDECAR_ITEMS);
  const blob = doc.getMap('meta').get('cache');
  const nestedBlob = blob instanceof Y.AbstractType;
  const nested = [...items.keys()].filter((k) => items.get(k) instanceof Y.AbstractType);
  const base = nestedBlob ? (blob.toJSON() as unknown) : blob;
  const read = nestedBlob ? (isPlainObject(base) ? base : {}) : readSidecarCache(doc);
  const second = (list: unknown): number => {
    if (!Array.isArray(list)) return 0;
    const shared = new Set<unknown>(list.map((v) => (hasSharedMark(v) && isPlainObject(v) ? v.id : undefined)).filter((x) => typeof x === 'string'));
    return list.filter((v) => isPlainObject(v) && shared.has(v.id)).length - shared.size;
  };
  return { items, nested, base, read, problems: { nested: nested.length + (nestedBlob ? 1 : 0), second: ITEM_KINDS.reduce((n, { field }) => n + second(read?.[field]), 0) } };
}

export function sidecarShapeProblems(doc: Y.Doc): SidecarShapeProblems {
  return sidecarShape(doc).problems;
}

/**
 * Put a sidecar that holds what no app writes back in shape: a module's or
 * label's value (or the whole sidecar) that is one of Yjs's own types, and
 * a second entry with a shared module's id. Each is then there as a plain
 * value, a shared module once (the first that is shared); for a nested value, what `meta.cache` has for it, else its fields. Makes
 * no change when there is nothing to put right. Returns true when it did.
 */
export function repairSidecarShape(doc: Y.Doc, origin?: unknown): boolean {
  const { items, nested, base, read, problems } = sidecarShape(doc);
  if (problems.nested + problems.second === 0) return false;
  const out: Record<string, unknown> = { ...(read ?? {}) };
  for (const { field, prefix } of ITEM_KINDS) {
    const list: Record<string, unknown>[] = Array.isArray(out[field]) ? [...(out[field] as Record<string, unknown>[])] : [];
    const had = new Set(list.map((v) => (isPlainObject(v) ? v.id : undefined)));
    for (const k of nested) {
      const id = k.slice(prefix.length);
      if (!k.startsWith(prefix) || had.has(id)) continue;
      const kept = isPlainObject(base) && Array.isArray(base[field]) ? (base[field] as unknown[]).find((v) => isPlainObject(v) && v.id === id) : undefined;
      const value = kept ?? (items.get(k) as Y.AbstractType<unknown>).toJSON();
      if (!isPlainObject(value)) continue;
      const { _order, ...rest } = value;
      list.push({ ...rest, id });
      had.add(id);
    }
    const keep = new Map<unknown, Record<string, unknown>>();
    for (const v of list) if (isPlainObject(v) && hasSharedMark(v) && !keep.has(v.id)) keep.set(v.id, v);
    if (list.length > 0 || Array.isArray(out[field])) out[field] = list.filter((v) => !isPlainObject(v) || !keep.has(v.id) || keep.get(v.id) === v);
  }
  doc.transact(() => {
    for (const k of nested) items.delete(k);
    writeSidecarCache(doc, structuredClone(out));
  }, origin);
  return true;
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

// ---------------------------------------------------------------------------
// Undo after two people wrote the same sidecar value at the same instant.
//
// Undo takes back the value this browser wrote and puts the one before it
// back. But when someone else wrote the same key at the same instant and
// ours was the one Yjs kept, theirs sits between ours and the one before,
// and Yjs then puts nothing back (it won't write over a value it sees as
// someone else's): the key is simply gone. For `meta.cache` that is the
// whole sidecar (venue, views, every module and label); for `m:<id>` it is
// the module; for a part key it is the part someone else also added or
// took out. So after an undo or redo, a sidecar value that was there
// before, is gone now, and was replaced that way is written again as it
// was (`meta.cache` with its modules and labels as the items now hold
// them). What the undo took back besides stays taken back.
// ---------------------------------------------------------------------------

/** What Yjs keeps for one value of a map key (yjs's Item, the fields read here). */
interface KeyEntry {
  id: { client: number; clock: number };
  length: number;
  /** The value it replaced, as its writer saw it. */
  origin: { client: number; clock: number } | null;
  /** The value before it in the key's history. */
  left: KeyEntry | null;
  deleted: boolean;
}

/** Whether `key`'s last value is gone and had been written at the same instant as someone else's (theirs sits before it). */
function goneAfterConcurrentWrite(map: Y.Map<unknown>, key: string): boolean {
  const top = (map as unknown as { _map: Map<string, KeyEntry> })._map.get(key);
  if (!top || !top.deleted || !top.left) return false;
  const o = top.origin;
  return !o || top.left.id.client !== o.client || top.left.id.clock + top.left.length - 1 !== o.clock;
}

/**
 * Watches `doc`: a sidecar value an undo or redo left missing because
 * someone else wrote it at the same instant is put back (see above), in a
 * transaction of origin `origin` (not an undo step). Returns how to stop.
 */
export function keepSidecarThroughUndo(doc: Y.Doc, origin: unknown): () => void {
  const meta = doc.getMap('meta');
  const items = doc.getMap<unknown>(SIDECAR_ITEMS);
  let lastBlob: unknown;
  let lastItems = new Map<string, unknown>();
  const remember = (): void => {
    lastBlob = meta.get('cache');
    lastItems = new Map(items.entries());
  };
  remember();
  const onTransaction = (tr: Y.Transaction): void => {
    const touched =
      tr.changed.has(meta as unknown as Y.AbstractType<Y.YEvent<Y.AbstractType<unknown>>>) ||
      tr.changed.has(items as unknown as Y.AbstractType<Y.YEvent<Y.AbstractType<unknown>>>);
    if (!touched) return;
    if (!(tr.origin instanceof Y.UndoManager)) {
      remember();
      return;
    }
    const back: [string, unknown][] = [];
    for (const [k, v] of lastItems) {
      if (k === '__blob' || v instanceof Y.AbstractType || items.has(k) || !goneAfterConcurrentWrite(items, k)) continue;
      back.push([k, v]);
    }
    const wasBlob = lastBlob && typeof lastBlob === 'object' && !(lastBlob instanceof Y.AbstractType) ? (lastBlob as Record<string, unknown>) : null;
    const blobGone = !!wasBlob && meta.get('cache') === undefined && goneAfterConcurrentWrite(meta, 'cache');
    const hashGone = lastItems.has('__blob') && !items.has('__blob') && goneAfterConcurrentWrite(items, '__blob');
    if (back.length > 0 || blobGone || hashGone) {
      const wasHash = lastItems.get('__blob');
      doc.transact(() => {
        for (const [k, v] of back) items.set(k, v);
        if (!blobGone && !hashGone) return;
        const blob = blobGone ? wasBlob! : meta.get('cache');
        if (!blob || typeof blob !== 'object') return;
        // The items went with the blob (a writer of both made it): its
        // modules and labels are the items'. Else the blob as it was.
        const paired = wasBlob !== null && wasHash === blobHash(wasBlob) && idsUnique(blob as Record<string, unknown>);
        const out = paired ? mergedSidecar(blob as Record<string, unknown>, items) : (blob as Record<string, unknown>);
        meta.set('cache', out);
        if (paired) items.set('__blob', blobHash(out));
        else if (typeof wasHash === 'string') items.set('__blob', wasHash);
      }, origin);
    }
    remember();
  };
  doc.on('afterTransaction', onTransaction);
  return () => doc.off('afterTransaction', onTransaction);
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
const ITEM_FIELDS: ReadonlySet<string> = new Set<ItemField>(['bricks', 'rulerItems', 'areas']);

/**
 * Whether `tr` may have left an item there twice, so removeDuplicateItems
 * has something to look for: only an insert can (a sheet's parts, rulers
 * or cells changed as a list, a new list or sheet, or the sheets' order).
 * A part moved or edited in place can't, and the look through every item
 * (7,520 parts on a big layout) is skipped.
 */
export function mayAddDuplicates(tr: Y.Transaction): boolean {
  const doc = tr.doc;
  const layerData = doc.share.get('layerData');
  const layers = doc.share.get('layers');
  for (const [type, keys] of tr.changed) {
    if (type === layerData || type === layers) return true;
    const item = type._item;
    if (type instanceof Y.Array && item && typeof item.parentSub === 'string' && ITEM_FIELDS.has(item.parentSub)) return true;
    // A sheet given a new list.
    if (type instanceof Y.Map && item && item.parent === layerData) {
      for (const k of keys) if (k !== null && ITEM_FIELDS.has(k)) return true;
    }
  }
  return false;
}

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
