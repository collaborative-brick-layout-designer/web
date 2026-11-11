// A module's parts one key per part (moduleMembers.ts, doc shape 3): two
// people adding and removing parts of one module at the same instant both
// keep their change; layouts from before read the same; builds from before
// refuse a layout that has the keys.
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DOC_SCHEMA_VERSION,
  DOC_SHAPE_MEMBER_KEYS,
  SHAPE_ORIGIN,
  canReadDoc,
  decodeDoc,
  encodeDoc,
  exportSidecarFromDoc,
  keepSidecarThroughUndo,
  memberKey,
  memberWrites,
  moduleMembers,
  parseMemberKey,
  readSidecarCache,
  repairSidecarCache,
  sidecarBlobHash,
  stampMemberKeys,
  upgradeDoc,
  validMemberValue,
  writeSidecarCache,
} from './index.js';

type Mod = { id: string; name: string; members?: string[] };
const LOCAL = 'local';

const sync = (a: Y.Doc, b: Y.Doc) => {
  const sa = Y.encodeStateVector(a);
  const sb = Y.encodeStateVector(b);
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, sa), 'remote');
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, sb), 'remote');
};
const copyOf = (a: Y.Doc): Y.Doc => {
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a), 'remote');
  return b;
};
const mods = (d: Y.Doc): Mod[] => (readSidecarCache(d)?.modules ?? []) as Mod[];
const mod = (d: Y.Doc, id = 'm1'): Mod | undefined => mods(d).find((m) => m.id === id);
const parts = (d: Y.Doc, id = 'm1'): string[] | undefined => mod(d, id)?.members;
/** Change one module as the editor does: read, change, write, in one transaction. */
const change = (d: Y.Doc, id: string, f: (m: Mod) => Mod): void => {
  d.transact(() => {
    const cache = readSidecarCache(d)!;
    writeSidecarCache(d, { ...cache, modules: (cache.modules as Mod[]).map((m) => (m.id === id ? f(m) : m)) });
  }, LOCAL);
};
const add = (d: Y.Doc, ...ids: string[]) => change(d, 'm1', (m) => ({ ...m, members: [...(m.members ?? []), ...ids] }));
const take = (d: Y.Doc, ...ids: string[]) => change(d, 'm1', (m) => ({ ...m, members: (m.members ?? []).filter((x) => !ids.includes(x)) }));
const schema = (d: Y.Doc) => d.getMap('meta').get('schemaVersion');
const blob = (d: Y.Doc) => d.getMap('meta').get('cache') as { modules: Mod[] };
const itemKeys = (d: Y.Doc) => [...d.getMap('sidecarItems').keys()].filter((k) => k.startsWith('p:')).sort();
/** Everyone has heard everything, and meta.cache has caught up. */
const settle = (...docs: Y.Doc[]) => {
  for (let round = 0; round < 4; round++) {
    for (const a of docs) for (const b of docs) if (a !== b) sync(a, b);
    for (const d of docs) repairSidecarCache(d, 'repair');
  }
  for (const a of docs) for (const b of docs) if (a !== b) sync(a, b);
};

const start = { schemaVersion: 1, bbmHashSha256: '', modules: [{ id: 'm1', name: 'Yard', members: ['a', 'b'] }] };
/** A layout with one module, and two people who have it. */
function pair(sidecar: Record<string, unknown> = start): [Y.Doc, Y.Doc] {
  const a = new Y.Doc();
  a.clientID = clientIds[0];
  a.getMap('meta').set('schemaVersion', 1);
  a.transact(() => writeSidecarCache(a, sidecar), LOCAL);
  const b = copyOf(a);
  b.clientID = clientIds[1];
  return [a, b];
}
// Which of two values written at the same instant Yjs keeps goes by the
// writers' client ids: every test below runs with the pair both ways round.
let clientIds: [number, number] = [1, 2];

describe('the shared vectors (fixtures/contracts/module-members.json, the same file the desktop checks)', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/contracts/module-members.json');
  const c = JSON.parse(readFileSync(file, 'utf8')) as {
    shape: number;
    keys: { moduleId: string; partId: string; key: string }[];
    badKeys: string[];
    values: { value: unknown; valid: boolean }[];
    read: { what: string; members?: string[]; keys: Record<string, unknown>; expect: string[] }[];
    write: { what: string; members?: string[]; keys: Record<string, unknown>; want: string[]; set: [string, number | false][]; delete: string[] }[];
  };
  const keyMap = (o: Record<string, unknown>) => new Map(Object.entries(o));

  it('the shape', () => {
    expect(DOC_SHAPE_MEMBER_KEYS).toBe(c.shape);
    expect(DOC_SCHEMA_VERSION).toBe(c.shape);
  });
  it('keys', () => {
    expect(c.keys.length).toBeGreaterThanOrEqual(5);
    for (const k of c.keys) {
      expect(memberKey(k.moduleId, k.partId)).toBe(k.key);
      expect(parseMemberKey(k.key)).toEqual({ moduleId: k.moduleId, partId: k.partId });
    }
    for (const k of c.badKeys) expect(parseMemberKey(k), k).toBeNull();
    expect(parseMemberKey('m:m1')).toBeNull();
  });
  it('values', () => {
    for (const v of c.values) expect(validMemberValue(v.value), JSON.stringify(v.value)).toBe(v.valid);
    for (const v of [NaN, Infinity, -Infinity]) expect(validMemberValue(v)).toBe(false);
  });
  it('reading', () => {
    expect(c.read.length).toBeGreaterThanOrEqual(8);
    for (const r of c.read) expect(moduleMembers(r.members, keyMap(r.keys)), r.what).toEqual(r.expect);
  });
  it('writing', () => {
    expect(c.write.length).toBeGreaterThanOrEqual(8);
    for (const w of c.write) {
      const keys = keyMap(w.keys);
      expect(memberWrites(w.members, keys, w.want), w.what).toEqual({ set: w.set, delete: w.delete });
      // And after those writes the module reads as wanted (in the order the keys give).
      for (const id of w.delete) keys.delete(id);
      for (const [id, v] of w.set) keys.set(id, v);
      expect([...moduleMembers(w.members, keys)].sort(), w.what).toEqual([...w.want].sort());
    }
  });
});

describe.each([
  ['the first person has the lower client id', 1001, 2002],
  ['the first person has the higher client id', 2002, 1001],
] as const)('%s', (_name, first, second) => {
  beforeEach(() => {
    clientIds = [first, second];
  });

describe('two people changing one module at the same instant', () => {
  it('both add a part: both parts are in the module', () => {
    const [a, b] = pair();
    add(a, 'c');
    add(b, 'd');
    settle(a, b);
    for (const d of [a, b]) {
      expect(parts(d)).toEqual(['a', 'b', 'c', 'd']);
      expect(blob(d).modules[0]!.members).toEqual(['a', 'b', 'c', 'd']);
    }
  });

  it('one adds, one removes: both happen', () => {
    const [a, b] = pair();
    add(a, 'c');
    take(b, 'a');
    settle(a, b);
    for (const d of [a, b]) expect(parts(d)).toEqual(['b', 'c']);
  });

  it('both remove different parts: both are out', () => {
    const [a, b] = pair({ ...start, modules: [{ id: 'm1', name: 'Yard', members: ['a', 'b', 'c'] }] });
    take(a, 'a');
    take(b, 'c');
    settle(a, b);
    for (const d of [a, b]) expect(parts(d)).toEqual(['b']);
  });

  it('several rounds of adds and removes, each before hearing the other', () => {
    const [a, b] = pair();
    add(a, 'c');
    add(b, 'd');
    settle(a, b);
    take(a, 'd');
    add(b, 'e', 'f');
    settle(a, b);
    take(a, 'c', 'b');
    take(b, 'e');
    add(b, 'g');
    settle(a, b);
    for (const d of [a, b]) expect(parts(d)).toEqual(['a', 'f', 'g']);
  });

  it('one renames, one adds a part: the name and the part are both there', () => {
    const [a, b] = pair();
    change(a, 'm1', (m) => ({ ...m, name: 'Harbour' }));
    add(b, 'c');
    settle(a, b);
    for (const d of [a, b]) expect(mod(d)).toEqual({ id: 'm1', name: 'Harbour', members: ['a', 'b', 'c'] });
  });

  it('the same part added by both is there once', () => {
    const [a, b] = pair();
    add(a, 'c');
    add(b, 'c');
    settle(a, b);
    for (const d of [a, b]) expect(parts(d)).toEqual(['a', 'b', 'c']);
  });

  it('the same part taken out by one and kept by the other ends the same for both', () => {
    const [a, b] = pair();
    add(a, 'c');
    settle(a, b);
    take(a, 'c');
    change(b, 'm1', (m) => ({ ...m, name: 'Harbour' }));
    settle(a, b);
    for (const d of [a, b]) expect(mod(d)).toEqual({ id: 'm1', name: 'Harbour', members: ['a', 'b'] });
  });

  it('three people', () => {
    const [a, b] = pair();
    const c = copyOf(a);
    add(a, 'x');
    add(b, 'y');
    take(c, 'a');
    add(c, 'z');
    settle(a, b, c);
    for (const d of [a, b, c]) expect([...parts(d)!].sort()).toEqual(['b', 'x', 'y', 'z']);
    expect(parts(a)).toEqual(parts(b));
    expect(parts(a)).toEqual(parts(c));
  });

  it('one deletes the module while the other adds a part: it stays deleted, for both', () => {
    const [a, b] = pair();
    a.transact(() => writeSidecarCache(a, { ...readSidecarCache(a)!, modules: [] }), LOCAL);
    add(b, 'c');
    settle(a, b);
    for (const d of [a, b]) {
      expect(mods(d)).toEqual([]);
      expect(blob(d).modules).toEqual([]);
    }
  });
});

describe('what is written', () => {
  it('a new module is one value with its list, and no keys', () => {
    const [a] = pair();
    expect(itemKeys(a)).toEqual([]);
    expect(a.getMap('sidecarItems').get('m:m1')).toEqual({ id: 'm1', name: 'Yard', members: ['a', 'b'], _order: 0 });
    expect(schema(a)).toBe(1);
  });

  it('a part change writes keys, leaves the starting list alone, and stamps shape 3', () => {
    const [a] = pair();
    add(a, 'c');
    take(a, 'a');
    expect(itemKeys(a)).toEqual(['p:2:m1:a', 'p:2:m1:c']);
    expect(a.getMap('sidecarItems').get('p:2:m1:a')).toBe(false);
    expect(a.getMap('sidecarItems').get('p:2:m1:c')).toBe(0);
    expect((a.getMap('sidecarItems').get('m:m1') as Mod).members).toEqual(['a', 'b']);
    expect(blob(a).modules[0]!.members).toEqual(['b', 'c']);
    expect(schema(a)).toBe(3);
    // Putting them back as they were leaves no keys.
    take(a, 'c');
    change(a, 'm1', (m) => ({ ...m, members: ['a', 'b'] }));
    expect(itemKeys(a)).toEqual([]);
    expect(parts(a)).toEqual(['a', 'b']);
  });

  it('a rename, a new label or a new module writes no part key and leaves the shape', () => {
    const [a] = pair();
    change(a, 'm1', (m) => ({ ...m, name: 'Harbour' }));
    a.transact(() => {
      const c = readSidecarCache(a)!;
      writeSidecarCache(a, { ...c, anchoredLabels: [{ id: 'l1', text: 'Hi' }], modules: [...(c.modules as Mod[]), { id: 'm2', name: 'Town', members: ['x'] }] });
    }, LOCAL);
    expect(itemKeys(a)).toEqual([]);
    expect(schema(a)).toBe(1);
  });

  it('deleting a module takes its keys, and only its own', () => {
    const [a] = pair({ ...start, modules: [...start.modules, { id: 'm2', name: 'Town', members: ['x'] }] });
    add(a, 'c');
    change(a, 'm2', (m) => ({ ...m, members: ['x', 'y'] }));
    a.transact(() => {
      const c = readSidecarCache(a)!;
      writeSidecarCache(a, { ...c, modules: (c.modules as Mod[]).filter((m) => m.id !== 'm1') });
    }, LOCAL);
    expect(itemKeys(a)).toEqual(['p:2:m2:y']);
    expect(mods(a)).toEqual([{ id: 'm2', name: 'Town', members: ['x', 'y'] }]);
  });

  it('a write that changes nothing writes nothing but meta.cache and its hash', () => {
    const [a] = pair();
    add(a, 'c');
    const items = a.getMap('sidecarItems');
    const changed = new Set<string>();
    items.observe((e) => e.keysChanged.forEach((k) => changed.add(k)));
    a.transact(() => writeSidecarCache(a, readSidecarCache(a)!), LOCAL);
    expect([...changed].filter((k) => k !== '__blob')).toEqual([]);
  });

  it('the stamp is its own step: undoing the part change leaves it', () => {
    const [a] = pair();
    const undo = new Y.UndoManager([a.getMap('meta'), a.getMap('sidecarItems')], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
    const origins: unknown[] = [];
    a.on('afterTransaction', (tr: Y.Transaction) => {
      if (tr.changed.has(a.getMap('meta') as never) && tr.changedParentTypes.size > 0 && tr.origin === SHAPE_ORIGIN) origins.push(tr.origin);
    });
    add(a, 'c');
    expect(schema(a)).toBe(3);
    expect(origins).toEqual([SHAPE_ORIGIN]);
    undo.undo();
    expect(parts(a)).toEqual(['a', 'b']);
    expect(itemKeys(a)).toEqual([]);
    expect(schema(a)).toBe(3);
  });

  it('keys under a lower stamp (two stamps at once, the lower one stayed) are stamped again', () => {
    const [a] = pair();
    add(a, 'c');
    a.getMap('meta').set('schemaVersion', 2);
    expect(stampMemberKeys(a)).toBe(true);
    expect(schema(a)).toBe(3);
    expect(stampMemberKeys(a)).toBe(false);
    // The server does it on opening a room.
    a.getMap('meta').set('version', 5);
    a.getMap('meta').set('schemaVersion', 2);
    expect(upgradeDoc(a)).toBe(true);
    expect(schema(a)).toBe(3);
    expect(upgradeDoc(a)).toBe(false);
  });
});

describe('undo and redo', () => {
  const undoFor = (d: Y.Doc) => new Y.UndoManager([d.getMap('meta'), d.getMap('sidecarItems')], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });

  it("undoing my added part takes out mine and keeps the other person's; redo puts it back", () => {
    const [a, b] = pair();
    const undo = undoFor(a);
    add(a, 'c');
    add(b, 'd');
    settle(a, b);
    undo.undo();
    settle(a, b);
    for (const d of [a, b]) expect(parts(d)).toEqual(['a', 'b', 'd']);
    undo.redo();
    settle(a, b);
    for (const d of [a, b]) expect([...parts(d)!].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it("undoing my removed part puts it back and keeps the other person's removal", () => {
    const [a, b] = pair({ ...start, modules: [{ id: 'm1', name: 'Yard', members: ['a', 'b', 'c'] }] });
    const undo = undoFor(a);
    take(a, 'a');
    take(b, 'c');
    settle(a, b);
    for (const d of [a, b]) expect(parts(d)).toEqual(['b']);
    undo.undo();
    settle(a, b);
    for (const d of [a, b]) expect(parts(d)).toEqual(['a', 'b']);
    undo.redo();
    settle(a, b);
    for (const d of [a, b]) expect(parts(d)).toEqual(['b']);
  });

  it('undo at the same instant as the other person adds a part', () => {
    const [a, b] = pair();
    const undo = undoFor(a);
    add(a, 'c');
    settle(a, b);
    undo.undo();
    add(b, 'd');
    settle(a, b);
    for (const d of [a, b]) expect(parts(d)).toEqual(['a', 'b', 'd']);
  });

  it('undoing a deleted module brings back its parts, the ones added by key too', () => {
    const [a, b] = pair();
    add(a, 'c');
    settle(a, b);
    const undo = undoFor(a);
    a.transact(() => writeSidecarCache(a, { ...readSidecarCache(a)!, modules: [] }), LOCAL);
    settle(a, b);
    expect(mods(b)).toEqual([]);
    undo.undo();
    settle(a, b);
    for (const d of [a, b]) expect(parts(d)).toEqual(['a', 'b', 'c']);
  });
});

describe('offline, then back', () => {
  it('parts added and removed while one was away merge with what the others did meanwhile', () => {
    const [a, b] = pair();
    add(a, 'c');
    settle(a, b);
    // b is away; both go on working.
    add(b, 'x');
    take(b, 'a');
    change(b, 'm1', (m) => ({ ...m, name: 'Offline name' }));
    add(a, 'y');
    take(a, 'c');
    add(a, 'z');
    // Saved and loaded again while away (the browser's kept copy).
    const back = decodeDoc(encodeDoc(b));
    settle(a, back);
    for (const d of [a, back]) {
      expect([...parts(d)!].sort()).toEqual(['b', 'x', 'y', 'z']);
      expect(mod(d)!.name).toBe('Offline name');
    }
    expect(parts(a)).toEqual(parts(back));
  });

  it('the first part change of an old layout made by both while apart (nothing was converted, so nothing clashes)', () => {
    const [a, b] = pair();
    take(b, 'a');
    add(a, 'c');
    take(a, 'b');
    settle(a, b);
    for (const d of [a, b]) {
      expect(parts(d)).toEqual(['c']);
      expect(schema(d)).toBe(3);
    }
  });
});

// The reader and writer from before the keys (packages/ydoc/src/index.ts at
// 330850e), as they were: an older web tab, and what the desktop up to
// 2.1.2 does (it writes each module whole, with its list).
const old = {
  read(doc: Y.Doc): Record<string, unknown> | null {
    const cache = doc.getMap('meta').get('cache') as Record<string, unknown> | undefined;
    if (!cache || typeof cache !== 'object') return null;
    const items = doc.getMap('sidecarItems');
    if (items.size === 0) return cache;
    const out: Record<string, unknown> = { ...cache };
    const entries: { order: number; id: string; value: Record<string, unknown> }[] = [];
    items.forEach((v, k) => {
      if (!k.startsWith('m:') || !v || typeof v !== 'object') return;
      const { _order, ...value } = v as Record<string, unknown>;
      entries.push({ order: typeof _order === 'number' ? _order : 0, id: k, value });
    });
    entries.sort((x, y) => x.order - y.order || (x.id < y.id ? -1 : 1));
    out.modules = entries.map((e) => e.value);
    return out;
  },
  write(doc: Y.Doc, cache: Record<string, unknown>): void {
    const items = doc.getMap('sidecarItems');
    const list = (cache.modules ?? []) as Record<string, unknown>[];
    const want = new Map<string, Record<string, unknown>>();
    list.forEach((v, i) => want.set(`m:${String(v.id)}`, { ...v, _order: i }));
    for (const k of [...items.keys()]) if (k.startsWith('m:') && !want.has(k)) items.delete(k);
    for (const [k, v] of want) if (JSON.stringify(items.get(k)) !== JSON.stringify(v)) items.set(k, v);
    doc.getMap('meta').set('cache', cache);
    items.set('__blob', sidecarBlobHash(cache));
  },
  canRead: (doc: Y.Doc) => canReadDoc(doc.getMap('meta').get('schemaVersion'), 2, 1),
};

describe('layouts from before the keys', () => {
  it('a layout that only has meta.cache (a file just opened) reads the same, and nothing is written on reading', () => {
    const a = new Y.Doc();
    a.getMap('meta').set('cache', start);
    const before = Y.encodeStateVector(a);
    expect(readSidecarCache(a)).toEqual(start);
    expect(repairSidecarCache(a, 'repair')).toBe(false);
    expect(stampMemberKeys(a)).toBe(false);
    expect(Y.encodeStateVector(a)).toEqual(before);
  });

  it('a layout written by the build before (each module whole) reads the same, whoever opens it first', () => {
    const a = new Y.Doc();
    a.getMap('meta').set('schemaVersion', 2);
    a.transact(() => old.write(a, start));
    const b = copyOf(a);
    const c = copyOf(a);
    const sv = Y.encodeStateVector(b);
    expect(readSidecarCache(b)).toEqual(start);
    expect(readSidecarCache(c)).toEqual(start);
    expect(repairSidecarCache(b, 'repair')).toBe(false);
    expect(Y.encodeStateVector(b)).toEqual(sv);
    expect(schema(b)).toBe(2);
    // Both then change it, at the same instant.
    add(b, 'c');
    take(c, 'a');
    settle(b, c);
    for (const d of [b, c]) expect(parts(d)).toEqual(['b', 'c']);
  });

  it("the file a layout saves doesn't change: the sidecar has each module's full list and no bookkeeping", () => {
    const [a, b] = pair({ ...start, venue: { name: 'Hall' } });
    const before = JSON.stringify(exportSidecarFromDoc(a));
    expect(before).toBe(JSON.stringify({ ...start, venue: { name: 'Hall' } }));
    add(a, 'c');
    take(b, 'a');
    settle(a, b);
    const after = exportSidecarFromDoc(a) as unknown as { modules: Mod[] };
    expect(JSON.stringify(after)).toBe(JSON.stringify({ ...start, modules: [{ id: 'm1', name: 'Yard', members: ['b', 'c'] }], venue: { name: 'Hall' } }));
    expect(JSON.stringify(after)).not.toMatch(/_order|__blob|p:/);
    // Opened again from that file, and saved again: the same bytes.
    const again = new Y.Doc();
    again.getMap('meta').set('cache', JSON.parse(JSON.stringify(after)));
    expect(JSON.stringify(exportSidecarFromDoc(again))).toBe(JSON.stringify(after));
  });
});

describe('older and newer builds on one layout', () => {
  it('an older build refuses a layout that has part keys, and reads one that has none', () => {
    const [a] = pair();
    expect(old.canRead(a)).toBe(true);
    add(a, 'c');
    expect(old.canRead(a)).toBe(false);
    expect(canReadDoc(schema(a))).toBe(true);
  });

  it("an older build's change at the instant the layout moves to shape 3 is kept", () => {
    const [a, b] = pair();
    // b is the older build: it adds a part by writing the module whole.
    b.transact(() => {
      const c = old.read(b)!;
      old.write(b, { ...c, modules: (c.modules as Mod[]).map((m) => ({ ...m, members: [...m.members!, 'old'] })) });
    });
    add(a, 'new');
    take(a, 'a');
    settle(a, b);
    expect(parts(a)).toEqual(['b', 'old', 'new']);
    // The older build now sees the stamp and stops.
    expect(old.canRead(b)).toBe(false);
  });

  it('a newer build reads what an older one wrote after it (a list replaced whole)', () => {
    const [a, b] = pair();
    b.transact(() => old.write(b, { ...start, modules: [{ id: 'm1', name: 'Yard', members: ['b', 'q'] }] }));
    settle(a, b);
    expect(parts(a)).toEqual(['b', 'q']);
    add(a, 'c');
    expect(parts(a)).toEqual(['b', 'q', 'c']);
  });

  it('a build that only writes meta.cache replaces the lists: its lists stand, and the keys from before go with the next write', () => {
    const [a] = pair();
    add(a, 'c');
    take(a, 'a');
    a.transact(() => a.getMap('meta').set('cache', { ...start, modules: [{ id: 'm1', name: 'Desk', members: ['a', 'z'] }] }));
    expect(mod(a)).toEqual({ id: 'm1', name: 'Desk', members: ['a', 'z'] });
    add(a, 'y');
    expect(parts(a)).toEqual(['a', 'z', 'y']);
    expect(itemKeys(a)).toEqual([]);
    add(a, 'x');
    expect(itemKeys(a)).toEqual(['p:2:m1:x']);
    expect(parts(a)).toEqual(['a', 'z', 'y', 'x']);
  });
});
});

// Undo right after someone else wrote the same value at the same instant
// (before the editor's repair ran): Yjs takes ours back and, with theirs in
// between, puts nothing in its place. keepSidecarThroughUndo does.
describe.each([
  ['the one who undoes has the higher client id (their value was the one kept)', 2002, 1001],
  ['the one who undoes has the lower client id', 1001, 2002],
] as const)('undo straight after a change at the same instant: %s', (_name, first, second) => {
  const full = { ...start, venue: { name: 'Hall' }, views: [{ id: 'v1', name: 'All' }], anchoredLabels: [{ id: 'l1', text: 'Sign' }] };
  function two(): { a: Y.Doc; b: Y.Doc; undo: Y.UndoManager } {
    clientIds = [first, second];
    const [a, b] = pair(full);
    keepSidecarThroughUndo(a, 'repair');
    keepSidecarThroughUndo(b, 'repair');
    const undo = new Y.UndoManager([a.getMap('meta'), a.getMap('sidecarItems')], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
    return { a, b, undo };
  }
  const rest = (d: Y.Doc) => {
    const c = readSidecarCache(d)!;
    return { venue: c.venue, views: c.views, labels: c.anchoredLabels };
  };
  const whole = { venue: full.venue, views: full.views, labels: full.anchoredLabels };

  it('both add a part, one undoes at once: the sidecar is all still there, with the other person\'s part', () => {
    const { a, b, undo } = two();
    add(a, 'c');
    add(b, 'd');
    sync(a, b);
    undo.undo();
    expect(a.getMap('meta').get('cache')).toBeDefined();
    settle(a, b);
    for (const d of [a, b]) {
      expect(parts(d)).toEqual(['a', 'b', 'd']);
      expect(rest(d)).toEqual(whole);
      expect(blob(d).modules[0]!.members).toEqual(['a', 'b', 'd']);
    }
    undo.redo();
    settle(a, b);
    for (const d of [a, b]) {
      expect([...parts(d)!].sort()).toEqual(['a', 'b', 'c', 'd']);
      expect(rest(d)).toEqual(whole);
    }
  });

  it('both rename the module, one undoes at once: the module is still there', () => {
    const { a, b, undo } = two();
    change(a, 'm1', (m) => ({ ...m, name: 'North' }));
    change(b, 'm1', (m) => ({ ...m, name: 'South' }));
    sync(a, b);
    undo.undo();
    settle(a, b);
    for (const d of [a, b]) {
      expect(mods(d)).toHaveLength(1);
      expect(['North', 'South']).toContain(mod(d)!.name);
      expect(parts(d)).toEqual(['a', 'b']);
      expect(rest(d)).toEqual(whole);
    }
    expect(mod(a)).toEqual(mod(b));
  });

  it('both add the same part, one undoes at once: the part the other added stays', () => {
    const { a, b, undo } = two();
    add(a, 'c');
    add(b, 'c');
    sync(a, b);
    undo.undo();
    settle(a, b);
    for (const d of [a, b]) expect(parts(d)).toEqual(['a', 'b', 'c']);
  });

  it('both take the same part out, one undoes at once: it stays out', () => {
    const { a, b, undo } = two();
    take(a, 'a');
    take(b, 'a');
    sync(a, b);
    undo.undo();
    settle(a, b);
    for (const d of [a, b]) expect(parts(d)).toEqual(['b']);
  });

  it('nobody else wrote: undo takes back what it always did', () => {
    const { a, b, undo } = two();
    // The first module's part, a new module, a rename: each undone in turn.
    add(a, 'c');
    a.transact(() => {
      const c = readSidecarCache(a)!;
      writeSidecarCache(a, { ...c, modules: [...(c.modules as Mod[]), { id: 'm2', name: 'Town', members: ['x'] }] });
    }, LOCAL);
    change(a, 'm1', (m) => ({ ...m, name: 'Harbour' }));
    settle(a, b);
    undo.undo();
    expect(mod(a)!.name).toBe('Yard');
    undo.undo();
    expect(mods(a).map((m) => m.id)).toEqual(['m1']);
    expect(a.getMap('sidecarItems').has('m:m2')).toBe(false);
    undo.undo();
    expect(parts(a)).toEqual(['a', 'b']);
    expect(itemKeys(a)).toEqual([]);
    settle(a, b);
    expect(mods(b)).toEqual(mods(a));
    expect(rest(b)).toEqual(whole);
  });

  it('undoing the layout\'s very first sidecar leaves it without one, as before', () => {
    clientIds = [first, second];
    const a = new Y.Doc();
    a.clientID = first;
    keepSidecarThroughUndo(a, 'repair');
    const undo = new Y.UndoManager([a.getMap('meta'), a.getMap('sidecarItems')], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
    a.transact(() => writeSidecarCache(a, start), LOCAL);
    undo.undo();
    expect(a.getMap('meta').get('cache')).toBeUndefined();
    expect(a.getMap('sidecarItems').size).toBe(0);
    undo.redo();
    expect(parts(a)).toEqual(['a', 'b']);
  });
});

describe('values no writer makes', () => {
  it('are skipped when reading', () => {
    const [a] = pair();
    add(a, 'c');
    a.transact(() => {
      const items = a.getMap('sidecarItems');
      items.set('p:2:m1:bad', true);
      items.set('p:2:m1:worse', -4);
      items.set('p:9:m1:x', 0);
      items.set('p:2:m9:x', 0);
      items.set(memberKey('m1', 'nested'), new Y.Map());
    });
    expect(parts(a)).toEqual(['a', 'b', 'c']);
    add(a, 'd');
    expect(parts(a)).toEqual(['a', 'b', 'c', 'd']);
  });
});
