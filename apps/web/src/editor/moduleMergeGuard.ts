// Two people changing one module's name or look at the same instant.
//
// A module's parts merge by themselves: each part added or taken out is a
// key of its own in the shared layout (@cld/ydoc moduleMembers.ts), so two
// people's adds and removes, on the web or the desktop, both stay. The
// rest of a module (its name, its outline, whether it is pinned) is still
// one value (`sidecarItems`, one key per module), so when two people change
// those before either hears of the other, Yjs keeps one whole value and
// drops the other: Sam renames the module while Alex changes its outline,
// and one of the two is gone.
//
// This watches the module values this browser writes. When someone else's
// value replaces one of them, it asks Yjs whether that value was written
// knowing ours (each value records the one it replaced):
//
//   - It was: they saw our change and changed the module after it. Theirs
//     stands, whatever it says.
//   - It wasn't: they wrote at the same time, without ours. Our change is
//     put back on top of theirs, field by field: any field we changed that
//     they left alone. A field both changed stays theirs.
//
// Only this browser's own changes are put back (it remembers what it
// wrote; the value Yjs dropped is gone from the document), so each side
// repairs its own loss and the two end up the same.

import * as Y from 'yjs';
import { readSidecarCache, writeSidecarCache } from '@cld/ydoc';

/** The origin of a put-back write: not an undo step. */
export const MODULE_MERGE_ORIGIN = Symbol('cld-module-merge');

type Mod = Record<string, unknown>;

const ITEMS = 'sidecarItems';
const PREFIX = 'm:';
/** How many of its own writes to one module a browser keeps to compare against. */
const KEPT_WRITES = 30;

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}
const same = (a: unknown, b: unknown): boolean => stable(a) === stable(b);

/**
 * `theirs` with what `mine` changed since `base` put back: each field that
 * `mine` changed and `theirs` left as it was in `base`. The parts aren't
 * looked at: they merge by their own keys.
 */
export function mergeModule(base: Mod, mine: Mod, theirs: Mod): Mod {
  const out: Mod = { ...theirs };
  for (const k of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])) {
    if (k === 'members' || k === 'id' || k === '_order') continue;
    if (same(mine[k], base[k]) || !same(theirs[k], base[k])) continue;
    if (mine[k] === undefined) delete out[k];
    else out[k] = mine[k];
  }
  return out;
}

interface Write {
  client: number;
  clock: number;
  value: Mod;
}
/** This browser's writes to one module since someone else last had the say, oldest first, and the value before them. */
interface Mine {
  base: Mod | null;
  writes: Write[];
}

/** What Yjs keeps for one value of a map key (yjs's Item, the fields read here). */
interface Entry {
  id: { client: number; clock: number };
  /** The value this one replaced, as its writer saw it. */
  origin: { client: number; clock: number } | null;
  /** The value before it in the key's history (not always the one it replaced). */
  left: Entry | null;
  deleted: boolean;
}

function withoutOrder(v: unknown): Mod {
  const { _order: _, ...rest } = v as Mod;
  return rest;
}

/**
 * Watches `doc`: a module change made here at the same instant as someone
 * else's is put back on top of theirs (see above). Returns how to stop.
 * `onMerged` hears of each put-back (tests).
 */
export function watchModuleMerges(doc: Y.Doc, onMerged?: (moduleId: string) => void): () => void {
  const items = doc.getMap<unknown>(ITEMS);
  const entryOf = (key: string): Entry | undefined => (items as unknown as { _map: Map<string, Entry> })._map.get(key);
  const mine = new Map<string, Mine>();
  const valuesNow = (): Map<string, Mod> => {
    const out = new Map<string, Mod>();
    items.forEach((v, k) => {
      if (k.startsWith(PREFIX) && v && typeof v === 'object') out.set(k, v as Mod);
    });
    return out;
  };
  /** Every module's value after the last change seen. */
  let seen = valuesNow();

  /** Which of our writes `theirs` was written after: its index, or -1 for none of them. */
  const writtenAfter = (theirs: Entry, writes: readonly Write[]): number => {
    let at: Entry | null = theirs;
    for (let hops = 0; at && hops < 500; hops++) {
      const o: { client: number; clock: number } | null = at.origin;
      if (!o) return -1;
      const i = writes.findIndex((w) => w.client === o.client && w.clock === o.clock);
      if (i >= 0) return i;
      // The value it replaced, to see what that one replaced.
      let prev: Entry | null = at.left;
      while (prev && !(prev.id.client === o.client && prev.id.clock === o.clock)) prev = prev.left;
      at = prev;
    }
    return -1;
  };

  const putBack = (key: string): void => {
    const kept = mine.get(key);
    const cur = entryOf(key);
    if (!kept || kept.writes.length === 0) return;
    // They removed the module: it stays removed.
    if (!cur || cur.deleted) {
      mine.delete(key);
      return;
    }
    // Ours is still the value that counts.
    if (cur.id.client === doc.clientID) return;
    const after = writtenAfter(cur, kept.writes);
    mine.delete(key);
    // They had our latest: their change stands.
    if (after === kept.writes.length - 1) return;
    const base = after >= 0 ? kept.writes[after]!.value : kept.base;
    const theirs = items.get(key);
    if (!base || !theirs || typeof theirs !== 'object') return;
    const id = key.slice(PREFIX.length);
    const merged = mergeModule(withoutOrder(base), withoutOrder(kept.writes[kept.writes.length - 1]!.value), withoutOrder(theirs));
    if (same(merged, withoutOrder(theirs))) return;
    // (The value holds the module's starting list; its parts are the cache's.)
    const { members: _startingList, ...fields } = merged;
    doc.transact(() => {
      const cache = readSidecarCache(doc);
      const modules = cache && Array.isArray(cache.modules) ? (cache.modules as Mod[]) : null;
      if (!cache || !modules || !modules.some((m) => m.id === id)) return;
      writeSidecarCache(doc, { ...cache, modules: modules.map((m) => (m.id === id ? (m.members === undefined ? fields : { ...fields, members: m.members }) : m)) });
    }, MODULE_MERGE_ORIGIN);
    onMerged?.(id);
  };

  const onTransaction = (tr: Y.Transaction): void => {
    const keys = tr.changed.get(items as unknown as Y.AbstractType<Y.YEvent<Y.AbstractType<unknown>>>);
    if (!keys) return;
    const before = seen;
    const now = valuesNow();
    // (Set before putting anything back: a put-back is a write of ours, on top of what is there now.)
    seen = now;
    for (const key of keys) {
      if (typeof key !== 'string' || !key.startsWith(PREFIX)) continue;
      if (!tr.local) {
        putBack(key);
        continue;
      }
      const cur = entryOf(key);
      const value = now.get(key);
      // We removed the module, or this change left its value alone.
      if (!cur || cur.deleted || !value) {
        mine.delete(key);
        continue;
      }
      if (cur.id.client !== doc.clientID) continue;
      const kept = mine.get(key) ?? { base: before.get(key) ?? null, writes: [] };
      if (kept.writes.some((w) => w.client === cur.id.client && w.clock === cur.id.clock)) continue;
      kept.writes.push({ client: cur.id.client, clock: cur.id.clock, value });
      while (kept.writes.length > KEPT_WRITES) kept.base = kept.writes.shift()!.value;
      mine.set(key, kept);
    }
  };
  doc.on('afterTransaction', onTransaction);
  return () => doc.off('afterTransaction', onTransaction);
}
