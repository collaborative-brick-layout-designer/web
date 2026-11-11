// Modules and anchored labels are kept one per key, so two people changing
// different ones at once both keep their change; meta.cache stays whole for
// apps that only read it, and a write by such an app is still honoured.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultLayoutDoc, decodeDoc, encodeDoc, exportSidecarFromDoc, readSidecarCache, removeDuplicateBricks, repairSidecarCache, sidecarBlobHash, writeSidecarCache } from './index.js';

const base = { schemaVersion: 1, bbmHashSha256: '', modules: [{ id: 'm0', name: 'Yard', members: [] }] };
const sync = (a: Y.Doc, b: Y.Doc) => {
  const sa = Y.encodeStateVector(a);
  const sb = Y.encodeStateVector(b);
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, sa));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, sb));
};
const names = (d: Y.Doc) => ((readSidecarCache(d)?.modules ?? []) as { name: string }[]).map((m) => m.name);

describe('sidecar items', () => {
  it('two people adding and renaming different modules at once both keep their change', () => {
    const a = new Y.Doc();
    a.transact(() => writeSidecarCache(a, base));
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const ca = readSidecarCache(a)!;
    a.transact(() => writeSidecarCache(a, { ...ca, modules: [...(ca.modules as object[]), { id: 'ma', name: 'Harbour', members: [] }] }));
    const cb = readSidecarCache(b)!;
    b.transact(() => writeSidecarCache(b, { ...cb, modules: [{ id: 'm0', name: 'Rail yard', members: [] }, { id: 'mb', name: 'Town', members: [] }] }));
    sync(a, b);
    for (const d of [a, b]) expect(names(d).sort()).toEqual(['Harbour', 'Rail yard', 'Town']);
    // meta.cache lags until a client repairs it; then apps reading only it agree.
    expect(repairSidecarCache(a, 'repair') || repairSidecarCache(b, 'repair')).toBe(true);
    sync(a, b);
    const blob = a.getMap('meta').get('cache') as { modules: { name: string }[] };
    expect(blob.modules.map((m) => m.name).sort()).toEqual(['Harbour', 'Rail yard', 'Town']);
    expect(repairSidecarCache(a, 'repair')).toBe(false);
    expect(repairSidecarCache(b, 'repair')).toBe(false);
  });

  it('a removed module stays removed, and labels merge the same way', () => {
    const a = new Y.Doc();
    a.transact(() => writeSidecarCache(a, { ...base, anchoredLabels: [{ id: 'l1', text: 'A' }] }));
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    a.transact(() => writeSidecarCache(a, { ...readSidecarCache(a)!, modules: [] }));
    const cb = readSidecarCache(b)!;
    b.transact(() => writeSidecarCache(b, { ...cb, anchoredLabels: [...(cb.anchoredLabels as object[]), { id: 'l2', text: 'B' }] }));
    sync(a, b);
    expect(names(a)).toEqual([]);
    expect(((readSidecarCache(a)!.anchoredLabels) as { id: string }[]).map((l) => l.id)).toEqual(['l1', 'l2']);
  });

  it('an app that only writes meta.cache (the desktop) is read as it wrote it', () => {
    const a = new Y.Doc();
    a.transact(() => writeSidecarCache(a, base));
    a.transact(() => a.getMap('meta').set('cache', { ...base, modules: [{ id: 'm9', name: 'Desk', members: [] }] }));
    expect(names(a)).toEqual(['Desk']);
    expect(repairSidecarCache(a, 'repair')).toBe(false);
    // The next write here takes it up.
    a.transact(() => writeSidecarCache(a, readSidecarCache(a)!));
    expect(names(a)).toEqual(['Desk']);
  });

  it('a doc without items reads meta.cache as before', () => {
    const a = new Y.Doc();
    a.getMap('meta').set('cache', base);
    expect(names(a)).toEqual(['Yard']);
  });
});

// The readers from before sidecarItems (packages/ydoc/src/index.ts at
// 63c80fc^), copied as they were: an older server or web build still in
// use reads only meta.cache.
const old = {
  readSidecarFromDoc(doc: Y.Doc): Record<string, unknown> | null {
    const cache = doc.getMap('meta').get('cache');
    if (!cache || typeof cache !== 'object') return null;
    return cache as Record<string, unknown>;
  },
  exportSidecarFromDoc(doc: Y.Doc): Record<string, unknown> | null {
    return (doc.getMap('meta').get('cache') as Record<string, unknown> | undefined) ?? null;
  },
};

const full = {
  schemaVersion: 1,
  bbmHashSha256: 'abc',
  modules: [
    { id: 'm1', name: 'Yard', members: ['b1', 'b2'], transform: [1, 0, 0, 0, 1, 0, 0, 0, 1], sourceFile: 'yard.bbm' },
    { id: 'm2', name: 'Harbour', members: [], transform: [1, 0, 5, 0, 1, 7, 0, 0, 1] },
  ],
  anchoredLabels: [
    { id: 'l1', text: 'Station', kind: 0, targetId: '', offset: { x: 1, y: 2 }, rot: 0, minZoom: 0 },
    { id: 'l2', text: 'Crane', kind: 3, targetId: 'm2', offset: { x: 0, y: 0 }, rot: 90, minZoom: 0.5 },
  ],
  venue: { name: 'Hall', enabled: true, edges: [], obstacles: [], minWalkwayStuds: 2 },
  rulers: [{ id: 'r1', kind: 'linear' }],
  views: [{ id: 'v1', name: 'All', fit: true }],
};

describe('older builds read docs written with sidecarItems', () => {
  it('meta.cache is complete: an old reader sees what the new one does, with no item bookkeeping in it', () => {
    const a = new Y.Doc();
    a.transact(() => writeSidecarCache(a, full));
    const d = decodeDoc(encodeDoc(a));
    for (const read of [old.readSidecarFromDoc, old.exportSidecarFromDoc]) {
      expect(read(d)).toEqual(full);
      expect(read(d)).toEqual(readSidecarCache(d));
      expect(JSON.stringify(read(d))).not.toMatch(/_order|__blob/);
    }
    expect(exportSidecarFromDoc(d)).toEqual(full);
  });

  it('after edits (rename, add, remove, reorder) the old reader still matches', () => {
    const a = new Y.Doc();
    a.transact(() => writeSidecarCache(a, full));
    const next = {
      ...full,
      modules: [{ ...full.modules[1]!, name: 'Port' }, { id: 'm3', name: 'Town', members: ['b9'], transform: [1, 0, 0, 0, 1, 0, 0, 0, 1] }],
      anchoredLabels: [full.anchoredLabels[1]!],
    };
    a.transact(() => writeSidecarCache(a, next));
    const d = decodeDoc(encodeDoc(a));
    expect(old.readSidecarFromDoc(d)).toEqual(next);
    expect(readSidecarCache(d)).toEqual(next);
  });

  it('two new writers at once: once repaired, the old reader sees both changes', () => {
    const a = new Y.Doc();
    a.transact(() => writeSidecarCache(a, full));
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const ca = readSidecarCache(a)!;
    a.transact(() => writeSidecarCache(a, { ...ca, modules: [...(ca.modules as object[]), { id: 'ma', name: 'Docks', members: [] }] }));
    const cb = readSidecarCache(b)!;
    b.transact(() => writeSidecarCache(b, { ...cb, anchoredLabels: [...(cb.anchoredLabels as object[]), { id: 'lb', text: 'Pier' }] }));
    sync(a, b);
    repairSidecarCache(a, 'repair');
    repairSidecarCache(b, 'repair');
    sync(a, b);
    for (const d of [a, b]) {
      const o = old.readSidecarFromDoc(d)!;
      expect(o).toEqual(readSidecarCache(d));
      expect((o.modules as { id: string }[]).map((m) => m.id)).toEqual(['m1', 'm2', 'ma']);
      expect((o.anchoredLabels as { id: string }[]).map((l) => l.id)).toEqual(['l1', 'l2', 'lb']);
    }
  });

  // Steps: writeSidecarCache(doc, { modules: [{ id: 'a', name: 'One' }, { id: 'a', name: 'Two' }] }),
  // then readSidecarCache(doc): it returns one module, meta.cache (the old reader) has two.
  // The items map is keyed by id, so a sidecar with two modules sharing an id (or a label
  // with no id) loses one in the new reader while the old reader keeps both.
  it('a sidecar with repeated or missing ids reads the same in both', () => {
    const odd = {
      ...full,
      modules: [{ id: 'dup', name: 'One', members: [] }, { id: 'dup', name: 'Two', members: [] }, { name: 'No id', members: [] }],
      anchoredLabels: [{ text: 'No id' }],
    };
    const a = new Y.Doc();
    a.transact(() => writeSidecarCache(a, odd));
    expect(old.readSidecarFromDoc(a)).toEqual(odd);
    expect(readSidecarCache(a)).toEqual(odd);
    // …and isn't "repaired" into fewer entries either.
    expect(repairSidecarCache(a, 'repair')).toBe(false);
    expect(readSidecarCache(a)).toEqual(odd);
  });
});

describe('the new code reads docs written by older builds (meta.cache only)', () => {
  it('a blob-only doc reads as written, through every reader', () => {
    const a = new Y.Doc();
    a.getMap('meta').set('cache', full);
    const d = decodeDoc(encodeDoc(a));
    expect(readSidecarCache(d)).toEqual(full);
    expect(exportSidecarFromDoc(d)).toEqual(full);
    expect(repairSidecarCache(d, 'repair')).toBe(false);
  });

  it('an old build editing a doc the new one wrote wins, and the next new write keeps its edit', () => {
    const a = new Y.Doc();
    a.transact(() => writeSidecarCache(a, full));
    // An old build (blob only) renames a module, drops a label and adds a module.
    const b = decodeDoc(encodeDoc(a));
    const edited = {
      ...full,
      modules: [{ ...full.modules[0]!, name: 'Old-build yard' }, full.modules[1]!, { id: 'm7', name: 'Old-build town', members: [] }],
      anchoredLabels: [full.anchoredLabels[0]!],
    };
    b.getMap('meta').set('cache', edited);
    sync(a, b);
    for (const d of [a, b]) expect(readSidecarCache(d)).toEqual(edited);
    expect(repairSidecarCache(a, 'repair')).toBe(false);
    // The new build writes next, from what it reads: nothing of the old build's edit is lost.
    a.transact(() => writeSidecarCache(a, { ...readSidecarCache(a)!, rulers: [] }));
    sync(a, b);
    expect(readSidecarCache(b)).toEqual({ ...edited, rulers: [] });
    expect(old.readSidecarFromDoc(b)).toEqual({ ...edited, rulers: [] });
  });

  it('an old build clearing the sidecar is read as cleared', () => {
    const a = new Y.Doc();
    a.transact(() => writeSidecarCache(a, full));
    a.getMap('meta').delete('cache');
    expect(readSidecarCache(a)).toBeNull();
    expect(exportSidecarFromDoc(a)).toBeNull();
    a.getMap('meta').set('cache', { schemaVersion: 1 });
    expect(readSidecarCache(a)).toEqual({ schemaVersion: 1 });
  });
});

describe('removeDuplicateBricks', () => {
  it('two people moving the same part at once: every client keeps the same single copy', () => {
    const a = new Y.Doc();
    a.transact(() => {
      a.getArray<string>('layers').push(['L']);
      const layer = new Y.Map<unknown>();
      layer.set('type', 'brick');
      const bricks = new Y.Array<Y.Map<unknown>>();
      for (const id of ['p', 'q', 'r']) {
        const m = new Y.Map<unknown>();
        m.set('id', id);
        bricks.push([m]);
      }
      layer.set('bricks', bricks);
      a.getMap('layerData').set('L', layer);
    });
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    // Both "move" p to the end: delete it and insert a copy.
    for (const [d, tag] of [[a, 'A'], [b, 'B']] as const) {
      d.transact(() => {
        const arr = (d.getMap('layerData').get('L') as Y.Map<unknown>).get('bricks') as Y.Array<Y.Map<unknown>>;
        arr.delete(0, 1);
        const m = new Y.Map<unknown>();
        m.set('id', 'p');
        m.set('by', tag);
        arr.push([m]);
      });
    }
    sync(a, b);
    const ids = (d: Y.Doc) => ((d.getMap('layerData').get('L') as Y.Map<unknown>).get('bricks') as Y.Array<Y.Map<unknown>>).toArray().map((m) => m.get('id'));
    expect(ids(a).filter((x) => x === 'p')).toHaveLength(2);
    // Both tidy at the same time, before seeing each other's tidy.
    expect(removeDuplicateBricks(a, 'tidy')).toBe(1);
    expect(removeDuplicateBricks(b, 'tidy')).toBe(1);
    sync(a, b);
    for (const d of [a, b]) expect(ids(d).sort()).toEqual(['p', 'q', 'r']);
    const by = (d: Y.Doc) => ((d.getMap('layerData').get('L') as Y.Map<unknown>).get('bricks') as Y.Array<Y.Map<unknown>>).toArray().find((m) => m.get('id') === 'p')!.get('by');
    expect(by(a)).toBe(by(b));
  });
});

// The desktop computes the same hash (sync/SidecarItems.cpp, with these
// vectors in tests/sync/SidecarItemsTest.cpp): keep both in step.
describe('sidecarBlobHash', () => {
  it('matches the shared vectors (fixtures/contracts/sidecar-hash.json, the same file the desktop checks)', () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/contracts/sidecar-hash.json');
    const { vectors } = JSON.parse(readFileSync(file, 'utf8')) as { vectors: { json: string; hash: string }[] };
    expect(vectors.length).toBeGreaterThanOrEqual(5);
    for (const { json, hash } of vectors) expect(sidecarBlobHash(JSON.parse(json)), json).toBe(hash);
  });

  it("doesn't depend on the order of an object's keys", () => {
    expect(sidecarBlobHash({ a: 1, b: { d: [1, { y: 2, x: 1 }], c: 'z' } })).toBe(
      sidecarBlobHash({ b: { c: 'z', d: [1, { x: 1, y: 2 }] }, a: 1 }),
    );
  });
});

// A part deleted at the same instant someone adds it to a module: the
// delete took it out of the modules it was in then, the other write lists
// it again. Reads and writes leave out parts that aren't on the map.
describe('module lists without deleted parts', () => {
  const brickLayer = (d: Y.Doc) => {
    const data = d.getMap('layerData');
    for (const id of d.getArray<string>('layers').toArray()) {
      const l = data.get(id);
      if (l instanceof Y.Map && l.get('type') === 'brick') return l.get('bricks') as Y.Array<Y.Map<unknown>>;
    }
    throw new Error('no parts sheet');
  };
  const addBrick = (d: Y.Doc, id: string) => {
    const b = new Y.Map<unknown>();
    b.set('id', id);
    brickLayer(d).push([b]);
  };
  const deleteBrick = (d: Y.Doc, id: string) => {
    const arr = brickLayer(d);
    const i = arr.toArray().findIndex((b) => b.get('id') === id);
    arr.delete(i, 1);
  };
  const members = (d: Y.Doc) =>
    ((readSidecarCache(d)?.modules ?? []) as { id: string; members: string[] }[]).map((m) => `${m.id}:${m.members.join(',')}`);

  it('two people at once: one deletes a part, the other adds it to a module', () => {
    const a = createDefaultLayoutDoc();
    a.transact(() => {
      addBrick(a, 'b1');
      addBrick(a, 'b2');
      writeSidecarCache(a, { ...base, modules: [{ id: 'm1', name: 'Yard', members: ['b1'] }] });
    });
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    // a deletes b2 (in no module yet, so no module changes)…
    a.transact(() => deleteBrick(a, 'b2'));
    // …while b adds it to the module.
    b.transact(() => writeSidecarCache(b, { ...readSidecarCache(b)!, modules: [{ id: 'm1', name: 'Yard', members: ['b1', 'b2'] }] }));
    expect(members(b)).toEqual(['m1:b1,b2']);
    sync(a, b);
    for (const d of [a, b]) expect(members(d)).toEqual(['m1:b1']);
    // meta.cache, which the desktop and older builds read, follows once repaired.
    expect(repairSidecarCache(a, 'repair') || repairSidecarCache(b, 'repair')).toBe(true);
    sync(a, b);
    for (const d of [a, b]) {
      expect((d.getMap('meta').get('cache') as { modules: { members: string[] }[] }).modules[0]!.members).toEqual(['b1']);
      expect(repairSidecarCache(d, 'repair')).toBe(false);
    }
  });

  it('a module whose last part went at the same time goes too; one made empty stays', () => {
    const a = createDefaultLayoutDoc();
    a.transact(() => {
      addBrick(a, 'b1');
      writeSidecarCache(a, { ...base, modules: [{ id: 'm0', name: 'Empty', members: [] }] });
    });
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    a.transact(() => deleteBrick(a, 'b1'));
    b.transact(() => {
      const c = readSidecarCache(b)!;
      writeSidecarCache(b, { ...c, modules: [...(c.modules as object[]), { id: 'm1', name: 'New', members: ['b1'] }] });
    });
    sync(a, b);
    for (const d of [a, b]) expect(members(d)).toEqual(['m0:']);
  });

  it('a write leaves out parts that are not on the map', () => {
    const a = createDefaultLayoutDoc();
    a.transact(() => {
      addBrick(a, 'b1');
      writeSidecarCache(a, { ...base, modules: [{ id: 'm1', name: 'Yard', members: ['b1', 'gone'] }] });
    });
    expect((a.getMap('meta').get('cache') as { modules: { members: string[] }[] }).modules[0]!.members).toEqual(['b1']);
    // Parts added in the same transaction as the module are on the map.
    a.transact(() => {
      addBrick(a, 'b3');
      writeSidecarCache(a, { ...readSidecarCache(a)!, modules: [{ id: 'm1', name: 'Yard', members: ['b1', 'b3'] }] });
    });
    expect(members(a)).toEqual(['m1:b1,b3']);
    // And a read after a delete sees it at once.
    a.transact(() => deleteBrick(a, 'b3'));
    expect(members(a)).toEqual(['m1:b1']);
  });

  it('a sidecar kept on its own (no map) keeps its lists', () => {
    const a = new Y.Doc();
    a.getMap('meta').set('cache', { ...base, modules: [{ id: 'm1', name: 'Yard', members: ['b1'] }] });
    expect(members(a)).toEqual(['m1:b1']);
  });
});
