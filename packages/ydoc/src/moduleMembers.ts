// A module's parts in the shared layout, one key per part (doc shape 3).
//
// A module is one value, `sidecarItems["m:<id>"]`, and its `members` list
// used to be part of that value: two people changing one module's parts at
// the same instant each wrote the whole value, and Yjs kept one. Now the
// value keeps the list the module was made with (its starting list, never
// rewritten), and each part added or taken out since has its own key in
// the same map:
//
//   p:<n>:<moduleId>:<partId>      n: the module id's length (UTF-16 units)
//
//   a number (finite, 0 or more)   the part is in the module; where it sorts
//                                  among the parts added this way
//   false                          the part was taken out of the starting list
//
// The module's parts: the starting list, in order, without the ids whose
// key is false; then the ids whose key is a number and that aren't in the
// starting list, by number then id. A layout from before this (a list, no
// keys) reads the same as ever, so nothing is converted on opening.
//
// The first `p:` key moves the doc to shape 3 (meta.schemaVersion), so
// builds that would read only the starting lists refuse it. The desktop
// does the same (src/sync/ModuleMembers.cpp); shared vectors in
// fixtures/contracts/module-members.json; docs/module-members.md.

import * as Y from 'yjs';
import { SHAPE_ORIGIN } from './shape.js';

/** The shape that keeps a module's part changes one per key. */
export const DOC_SHAPE_MEMBER_KEYS = 3;

export const MEMBER_PREFIX = 'p:';
const SIDECAR_ITEMS = 'sidecarItems';

/** The key of part `partId` in module `moduleId`. */
export function memberKey(moduleId: string, partId: string): string {
  return `${MEMBER_PREFIX}${moduleId.length}:${moduleId}:${partId}`;
}

/** The module and part a `p:` key names, or null when it isn't one a writer makes. */
export function parseMemberKey(key: string): { moduleId: string; partId: string } | null {
  if (!key.startsWith(MEMBER_PREFIX)) return null;
  const colon = key.indexOf(':', MEMBER_PREFIX.length);
  if (colon < 0) return null;
  const digits = key.slice(MEMBER_PREFIX.length, colon);
  // The length as a writer gives it: digits only, no leading zero, no more than a key could hold.
  if (!/^(0|[1-9][0-9]{0,8})$/.test(digits)) return null;
  const n = Number(digits);
  const start = colon + 1;
  if (key.length < start + n + 2 || key[start + n] !== ':') return null;
  return { moduleId: key.slice(start, start + n), partId: key.slice(start + n + 1) };
}

/** Whether `v` is a value a `p:` key may hold. */
export function validMemberValue(v: unknown): v is number | false {
  return v === false || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
}

const strings = (list: unknown): string[] => (Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);

/**
 * A module's parts: its starting list (`base`, the `members` of its value)
 * with what the keys (part id → value) changed. Values that aren't valid
 * are skipped.
 */
export function moduleMembers(base: unknown, keys: ReadonlyMap<string, unknown>): string[] {
  const start = strings(base);
  const inStart = new Set(start);
  const out = start.filter((id) => keys.get(id) !== false);
  const added: { id: string; at: number }[] = [];
  for (const [id, v] of keys) if (typeof v === 'number' && validMemberValue(v) && !inStart.has(id)) added.push({ id, at: v });
  added.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const a of added) out.push(a.id);
  return out;
}

export interface MemberWrites {
  /** Keys to set, in order: part id and value. */
  set: [string, number | false][];
  /** Part ids whose key goes. */
  delete: string[];
}

/** What to write so a module with starting list `base` and `keys` holds the parts `want`. */
export function memberWrites(base: unknown, keys: ReadonlyMap<string, unknown>, want: readonly string[]): MemberWrites {
  const inStart = new Set(strings(base));
  const now = new Set(moduleMembers(base, keys));
  // (An empty id has no key.)
  const wanted = new Set(want.filter((id) => id !== ''));
  now.delete('');
  const out: MemberWrites = { set: [], delete: [] };
  for (const id of now) {
    if (wanted.has(id)) continue;
    if (inStart.has(id)) out.set.push([id, false]);
    else out.delete.push(id);
  }
  let next = 0;
  for (const v of keys.values()) if (typeof v === 'number' && validMemberValue(v) && v >= next) next = Math.floor(v) + 1;
  for (const id of wanted) {
    if (now.has(id)) continue;
    if (inStart.has(id)) out.delete.push(id);
    else out.set.push([id, next++]);
  }
  return out;
}

/** Every module's keys in `items`: module id → part id → value (valid ones only). */
export function memberKeysByModule(items: Y.Map<unknown>): Map<string, Map<string, number | false>> {
  const out = new Map<string, Map<string, number | false>>();
  items.forEach((v, k) => {
    if (!k.startsWith(MEMBER_PREFIX) || !validMemberValue(v)) return;
    const at = parseMemberKey(k);
    if (!at) return;
    let keys = out.get(at.moduleId);
    if (!keys) out.set(at.moduleId, (keys = new Map()));
    keys.set(at.partId, v);
  });
  return out;
}

/**
 * Stamp the doc shape 3 when it holds a `p:` key under a lower stamp (the
 * first such key, or two stamps written at the same instant where the
 * lower one stayed). Its own transaction, never undone. Returns whether it
 * wrote.
 */
export function stampMemberKeys(doc: Y.Doc): boolean {
  const meta = doc.getMap('meta');
  const v = meta.get('schemaVersion');
  if (typeof v === 'number' && v >= DOC_SHAPE_MEMBER_KEYS) return false;
  let any = false;
  for (const k of doc.getMap(SIDECAR_ITEMS).keys()) {
    if (k.startsWith(MEMBER_PREFIX)) {
      any = true;
      break;
    }
  }
  if (!any) return false;
  doc.transact(() => meta.set('schemaVersion', DOC_SHAPE_MEMBER_KEYS), SHAPE_ORIGIN);
  return true;
}

const stampWaiting = new WeakSet<Y.Doc>();

/** stampMemberKeys once the transaction being made ends (a write inside one can't stamp untracked). */
export function stampMemberKeysAfter(doc: Y.Doc): void {
  if (stampWaiting.has(doc)) return;
  stampWaiting.add(doc);
  doc.once('afterTransaction', () => {
    stampWaiting.delete(doc);
    stampMemberKeys(doc);
  });
}
