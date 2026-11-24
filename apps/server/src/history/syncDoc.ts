// Make a live Yjs document hold what another one holds, as ordinary
// edits: keys set and deleted, list entries deleted and inserted, text
// replaced. Never a new document: what is deleted stays deleted (a
// tombstone), so someone still holding the old state can't bring it back,
// and everyone in the room gets the change as one update.
//
// Lists of maps with an `id` (parts, sheets' entries, rulers) are matched
// by id, so an unchanged part keeps its identity and a concurrent edit of
// it still merges; anything else that differs is replaced whole.

import * as Y from 'yjs';

type Value = unknown;

function plain(v: Value): unknown {
  return v instanceof Y.AbstractType ? v.toJSON() : v;
}

function same(a: Value, b: Value): boolean {
  return JSON.stringify(plain(a)) === JSON.stringify(plain(b));
}

/** A fresh, unattached copy of a value from the target document, to insert into the live one. */
function cloneValue(v: Value): Value {
  if (v instanceof Y.Map) {
    const m = new Y.Map();
    for (const [k, x] of v.entries()) m.set(k, cloneValue(x));
    return m;
  }
  if (v instanceof Y.Array) {
    const a = new Y.Array();
    a.push(v.toArray().map(cloneValue));
    return a;
  }
  if (v instanceof Y.Text) {
    const t = new Y.Text();
    t.applyDelta(v.toDelta());
    return t;
  }
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (v && typeof v === 'object') return JSON.parse(JSON.stringify(v)) as unknown;
  return v;
}

function syncMap(live: Y.Map<Value>, target: Y.Map<Value>): void {
  for (const key of [...live.keys()]) if (!target.has(key)) live.delete(key);
  for (const [key, t] of target.entries()) {
    const l = live.get(key);
    if (l instanceof Y.Map && t instanceof Y.Map) syncMap(l, t);
    else if (l instanceof Y.Array && t instanceof Y.Array) syncArray(l, t);
    else if (l instanceof Y.Text && t instanceof Y.Text) syncText(l, t);
    else if (!live.has(key) || !same(l, t)) live.set(key, cloneValue(t));
  }
}

const idOf = (v: Value): string | null => {
  if (v instanceof Y.Map) {
    const id = v.get('id');
    return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
  }
  return null;
};

function syncArray(live: Y.Array<Value>, target: Y.Array<Value>): void {
  const l = live.toArray();
  const t = target.toArray();
  if (l.length === t.length && l.every((x, i) => same(x, t[i]))) return;
  const lIds = l.map(idOf);
  const tIds = t.map(idOf);
  const keyed = lIds.every((x) => x !== null) && tIds.every((x) => x !== null) && new Set(lIds).size === lIds.length && new Set(tIds).size === tIds.length;
  if (!keyed) {
    live.delete(0, live.length);
    live.insert(0, t.map(cloneValue));
    return;
  }
  // By id: drop what the target doesn't have (from the end, so indexes hold),
  // then walk the target in order, syncing kept entries and inserting the rest.
  const wanted = new Set(tIds as string[]);
  for (let i = l.length - 1; i >= 0; i--) if (!wanted.has(lIds[i]!)) live.delete(i, 1);
  // Kept entries must already be in the target's order; if not, replace whole.
  const kept = (live.toArray().map(idOf) as string[]);
  const order = (tIds as string[]).filter((id) => kept.includes(id));
  if (kept.some((id, i) => id !== order[i])) {
    live.delete(0, live.length);
    live.insert(0, t.map(cloneValue));
    return;
  }
  for (let i = 0; i < t.length; i++) {
    const cur = live.length > i ? live.get(i) : undefined;
    if (idOf(cur) === tIds[i]) {
      syncMap(cur as Y.Map<Value>, t[i] as Y.Map<Value>);
    } else {
      live.insert(i, [cloneValue(t[i])]);
    }
  }
}

function syncText(live: Y.Text, target: Y.Text): void {
  if (live.toString() === target.toString() && same(live.toDelta(), target.toDelta())) return;
  live.delete(0, live.length);
  live.applyDelta(target.toDelta());
}

/** The layout document's own top-level types, by kind (@cld/ydoc). */
const MAPS = new Set(['meta', 'layerData', 'venue', 'modules', 'labels', 'connections']);
const ARRAYS = new Set(['layers', 'rulers', 'areas']);

type Kind = 'map' | 'array' | 'text' | null;

/** What a top-level type is: by name, else by what it holds (a decoded doc's types are untyped until asked for). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function kindOf(name: string, t: Y.AbstractType<any>): Kind {
  if (MAPS.has(name) || t instanceof Y.Map) return 'map';
  if (ARRAYS.has(name) || t instanceof Y.Array) return 'array';
  if (t instanceof Y.Text) return 'text';
  if (t._map.size > 0) return 'map';
  if (t._start) return t._start.content instanceof Y.ContentString || t._start.content instanceof Y.ContentFormat ? 'text' : 'array';
  return null;
}

/**
 * Change `live` to hold what `target` holds, in one transaction with
 * `origin`. Top-level types the target has are synced by their kind;
 * top-level types only the live document has are emptied.
 */
export function syncDocTo(live: Y.Doc, target: Y.Doc, origin: unknown): void {
  const names = new Map<string, Kind>();
  for (const [name, t] of target.share) names.set(name, kindOf(name, t));
  for (const [name, l] of live.share) if (!names.has(name) || names.get(name) === null) names.set(name, names.get(name) ?? kindOf(name, l));
  live.transact(() => {
    for (const [name, kind] of names) {
      if (kind === 'map') syncMap(live.getMap(name), target.getMap(name));
      else if (kind === 'array') syncArray(live.getArray(name), target.getArray(name));
      else if (kind === 'text') syncText(live.getText(name), target.getText(name));
    }
  }, origin);
}
