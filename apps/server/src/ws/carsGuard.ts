// Cars, trains, waybills and jobs (trains design 2.3, 2.4; Live Ops design
// 2.2-2.5) as a layout's document holds them: `meta.rollingStock`,
// `meta.trains`, `meta.waybills` and `meta.opsJobs`, each a Y.Map of id -> a Y.Map of fields. Whatever the server takes it stores
// and sends to everyone, so an update that writes one the apps couldn't
// have is refused like a place outside its limits (placesGuard.ts, which
// calls this):
//
//   - a list as anything but a map, an entry that isn't a map, a field
//     that isn't what its kind holds, a record too big;
//   - more of them than MAX_OF.
//
// Only what is written is checked, so a layout that holds an odd one
// already keeps working. Fields this build doesn't know are fine.

import * as Y from 'yjs';
import { placeSize } from '@cld/bbm';
import { CUT_LIMITS, OPS_LIMITS, STOP_PREFIX, WAYBILL_SLOTS } from '@cld/parts-catalog/browser';
import { OPS_JOBS_KEY, ROLLING_STOCK_KEY, TRAINS_KEY, WAYBILLS_KEY } from '@cld/ydoc';
import type { DecodedUpdate } from './decoded.js';
import { pathsOf } from './mapPaths.js';

export const CARS_KEYS: readonly string[] = [ROLLING_STOCK_KEY, TRAINS_KEY, WAYBILLS_KEY, OPS_JOBS_KEY];

/** More than the apps make (two people may each add the last ones at once). */
export const MAX_RECORDS = 2 * CUT_LIMITS.records;
/** Cars in one train: two people may each couple a full one at once. */
export const MAX_UNITS = 2 * CUT_LIMITS.units;
/** One car or train: what a roster takes (routes/rollingStock.ts), and as much again. */
export const MAX_RECORD_SIZE = 2 * 64 * 1024;
/** One waybill, or one job with its stops. */
export const MAX_OPS_SIZE = 32 * 1024;
/** How many of each, and how big one may be. */
export const MAX_OF: Readonly<Record<string, number>> = { [ROLLING_STOCK_KEY]: MAX_RECORDS, [TRAINS_KEY]: MAX_RECORDS, [WAYBILLS_KEY]: 2 * OPS_LIMITS.waybills, [OPS_JOBS_KEY]: 2 * OPS_LIMITS.jobs };
export const SIZE_OF: Readonly<Record<string, number>> = { [ROLLING_STOCK_KEY]: MAX_RECORD_SIZE, [TRAINS_KEY]: MAX_RECORD_SIZE, [WAYBILLS_KEY]: MAX_OPS_SIZE, [OPS_JOBS_KEY]: MAX_OPS_SIZE };
const MAX_ID = 128;
const MAX_FIELD = 64;
/** The longest car, studs (a roster's limit too). */
const MAX_LENGTH = 2000;
const MAX_TRUCKS = 16;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const goodId = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.length <= MAX_ID;
const wholeIn = (v: unknown, hi: number): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= hi;
const studs = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_LENGTH;

const idOrNone = (v: unknown): boolean => v === '' || goodId(v);
const LOAD_VALUES: readonly unknown[] = ['loaded', 'empty', ''];
const SLOT_FIELD = new RegExp(`^(to|spot|load|note)([1-${WAYBILL_SLOTS}])$`);

function validWaybillField(field: string, value: unknown): boolean {
  if (field === 'car' || field === 'from') return idOrNone(value);
  if (field === 'leg') return wholeIn(value, WAYBILL_SLOTS);
  const slot = SLOT_FIELD.exec(field)?.[1];
  if (slot === 'to' || slot === 'spot') return idOrNone(value);
  if (slot === 'load') return LOAD_VALUES.includes(value);
  if (slot === 'note') return typeof value === 'string' && value.length <= OPS_LIMITS.note;
  return true;
}

function validJobField(field: string, value: unknown): boolean {
  if (field.startsWith(STOP_PREFIX)) return isObj(value) && goodId(value.place) && typeof value.at === 'number' && Number.isFinite(value.at);
  if (field === 'name') return typeof value === 'string' && value.length <= OPS_LIMITS.name;
  if (field === 'kind') return typeof value === 'string' && value.length <= MAX_FIELD;
  if (field === 'train') return idOrNone(value);
  if (field === 'order') return typeof value === 'number' && Number.isFinite(value);
  return true;
}

/** Whether `value` may be field `field` of a car (`rollingStock`), train (`trains`), waybill or job. */
export function validCarField(key: string, field: string, value: unknown): boolean {
  if (field.length > MAX_FIELD || value instanceof Y.AbstractType || value instanceof Uint8Array) return false;
  if (key === WAYBILLS_KEY) return validWaybillField(field, value);
  if (key === OPS_JOBS_KEY) return validJobField(field, value);
  if (key === ROLLING_STOCK_KEY) {
    switch (field) {
      case 'length':
        return studs(value) && (value as number) > 0;
      case 'width':
      case 'bodyLength':
        return studs(value);
      case 'trucks':
        return Array.isArray(value) && value.length <= MAX_TRUCKS && value.every((t) => isObj(t) && (t.at === undefined || studs(t.at)));
      case 'opsCut':
      case 'opsWaybill':
      case 'opsHome':
      case 'opsAt':
        return idOrNone(value);
      case 'opsHold':
        return typeof value === 'boolean';
      case 'opsLoad':
        return typeof value === 'string' && value.length <= MAX_FIELD;
      default:
        return true;
    }
  }
  switch (field) {
    case 'units':
      return Array.isArray(value) && value.length <= MAX_UNITS && value.every((u) => isObj(u) && goodId(u.stock) && (u.reversed === undefined || typeof u.reversed === 'boolean'));
    case 'position':
      if (value === null) return true;
      return (
        isObj(value) &&
        goodId(value.brick) &&
        wholeIn(value.from, 255) &&
        wholeIn(value.to, 255) &&
        typeof value.s === 'number' &&
        Number.isFinite(value.s) &&
        (value.facing === undefined || value.facing === 'to' || value.facing === 'from')
      );
    case 'over': {
      if (!isObj(value)) return false;
      const all = Object.entries(value);
      return all.length <= MAX_UNITS && all.every(([k, v]) => k.length <= MAX_ID + 8 && wholeIn(v, 255));
    }
    case 'cut':
      return typeof value === 'boolean';
    case 'emptiedAt':
      return typeof value === 'number' && Number.isFinite(value);
    default:
      return true;
  }
}

/** A value as short text (a whole number too big for JSON included). */
const text = (v: unknown): string => {
  try {
    return JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? `${x}n` : x))?.slice(0, 200) ?? '';
  } catch {
    return '?';
  }
};

type MetaMap = { _map?: Map<string, Y.Item> } | undefined;

function liveMap(doc: Y.Doc | null, key: string): Y.Map<unknown> | null {
  const item = (doc?.share.get('meta') as unknown as MetaMap)?._map?.get(key);
  return item && !item.deleted && item.content instanceof Y.ContentType && item.content.type instanceof Y.Map ? (item.content.type as Y.Map<unknown>) : null;
}

const WHAT: Record<string, string> = { [ROLLING_STOCK_KEY]: 'car', [TRAINS_KEY]: 'train', [WAYBILLS_KEY]: 'waybill', [OPS_JOBS_KEY]: 'job' };

/** Null when every car, train, waybill and job `decoded` writes is within the limits; else why not. Only its structs are read: placesProblem works the rest out on a copy. */
export function carsProblem(doc: Y.Doc | null, decoded: DecodedUpdate): string | null {
  const { structs } = decoded;
  const held = CARS_KEYS.some((k) => !!(doc?.share.get('meta') as unknown as MetaMap)?._map?.has(k));
  if (!held && !structs.some((s) => s instanceof Y.Item && s.parentSub !== null && CARS_KEYS.includes(s.parentSub))) return null;
  const { pathOf, deleted } = pathsOf(doc, decoded);
  const added = new Map(CARS_KEYS.map((k) => [k, new Set<string>()]));
  const sizes = new Map(CARS_KEYS.map((k) => [k, new Map<string, Map<string, number>>()]));
  for (const s of structs) {
    if (!(s instanceof Y.Item) || s.content instanceof Y.ContentDeleted) continue;
    const c = s.content;
    const path = pathOf(s);
    if (!path || path[0] !== 'meta' || !CARS_KEYS.includes(path[1]!) || deleted(s)) continue;
    const key = path[1]!;
    const what = WHAT[key]!;
    const isMap = c instanceof Y.ContentType && c.type.constructor === Y.Map;
    if (path.length === 2) {
      if (!isMap) return `it makes the layout’s ${what}s something other than a map`;
      continue;
    }
    const id = path[2]!;
    if (path.length === 3) {
      if (!isMap || id.length > MAX_ID) return `it writes a ${what} that isn’t one`;
      added.get(key)!.add(id);
      continue;
    }
    const field = path[3]!;
    if (path.length > 4 || !(c instanceof Y.ContentAny) || c.arr.length !== 1 || !validCarField(key, field, c.arr[0])) return `it gives a ${what} a value outside its limits`;
    const of = sizes.get(key)!;
    let fields = of.get(id);
    if (!fields) of.set(id, (fields = new Map()));
    // (Written more than once: the most it could be.)
    fields.set(field, Math.max(fields.get(field) ?? 0, placeSize(c.arr[0])));
  }
  for (const key of CARS_KEYS) {
    const now = liveMap(doc, key);
    for (const [id, fields] of sizes.get(key)!) {
      const had = now?.get(id);
      const was = had instanceof Y.Map ? (had.toJSON() as Record<string, unknown>) : {};
      const before = placeSize(was);
      let after = before;
      for (const [field, size] of fields) after += size - (Object.hasOwn(was, field) ? placeSize(was[field]) : -(field.length + 3));
      // (One that is too big already may still be changed, not grown.)
      if (after > SIZE_OF[key]! && after > before) return `it makes a ${WHAT[key]} too big`;
    }
    const fresh = added.get(key)!;
    if (fresh.size > 0) {
      let total = fresh.size;
      if (now) for (const k of now.keys()) if (!fresh.has(k)) total++;
      if (total > MAX_OF[key]!) return `it would leave the layout with more than ${MAX_OF[key]} ${WHAT[key]}s`;
    }
  }
  return null;
}

/** Everything about cars, trains, waybills and jobs outside the limits in a document as it is, each as a text of its own. */
export function docCarsProblems(doc: Y.Doc): Set<string> {
  const out = new Set<string>();
  const meta = doc.getMap('meta');
  for (const key of CARS_KEYS) {
    const what = WHAT[key]!;
    const live = meta.get(key);
    if (live === undefined) continue;
    if (!(live instanceof Y.Map)) {
      out.add(`it makes the layout’s ${what}s something other than a map`);
      continue;
    }
    if (live.size > MAX_OF[key]!) out.add(`it would leave the layout with more than ${MAX_OF[key]} ${what}s`);
    for (const [id, v] of live.entries()) {
      if (!(v instanceof Y.Map) || id.length > MAX_ID) {
        out.add(`it writes a ${what} that isn’t one (${id.slice(0, MAX_ID)})`);
        continue;
      }
      for (const [field, value] of v.entries())
        if (!validCarField(key, field, value)) out.add(`it gives a ${what} a value outside its limits (${id}.${field.slice(0, MAX_FIELD)} ${text(value)})`);
      if (placeSize(v.toJSON()) > SIZE_OF[key]!) out.add(`it makes a ${what} too big (${id})`);
    }
  }
  return out;
}
