// The places the server takes (ws/placesGuard.ts): what the apps write
// passes, a place outside the limits is refused, on a live update and in a
// whole document; and a shared module's places stay its owner's
// (ws/sharedGuard.ts).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { modulePlaces, PLACE_LIMITS, withPlaces, type Place } from '@cld/bbm';
import { createDefaultLayoutDoc, deleteRecord, PLACES_KEY, readPlacesFromDoc, readSidecarCache, writePlace, writeSidecarCache } from '@cld/ydoc';
import { decodeIncoming, guardWork } from './decoded.js';
import { MAX_LAYOUT_PLACES, PLACES_COPY_BUDGET_SPENT, placesProblem, snapshotPlacesProblem } from './placesGuard.js';
import { repairShared, sharedLockCheck } from './sharedGuard.js';
import { checkUpdate } from './updateGuard.js';
import { contents, place as placeShared } from '../test/sharedWorld.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const contract = JSON.parse(readFileSync(join(ROOT, 'fixtures/contracts/places.json'), 'utf8')) as {
  valid: { value: unknown; expect: boolean }[];
  validList: { value: unknown; expect: boolean }[];
};

const cannery: Place = { id: 'pl-1', name: 'Acme Cannery', kind: 'industry', spots: [{ id: 's1', name: 'Dock', track: { brick: 'a', from: 0, to: 1 }, capacity: 3 }], accepts: ['reefer'], ships: [], tags: [], notes: '' };

function room(): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap('meta').set('schemaVersion', 1);
  doc.transact(() => {
    writeSidecarCache(doc, { schemaVersion: 1, bbmHashSha256: '', modules: [{ id: 'm1', name: 'Yard', members: ['a', 'b'] }] });
    writePlace(doc, cannery);
  });
  return doc;
}
function client(of: Y.Doc): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(of));
  return doc;
}
function updateOf(doc: Y.Doc, edit: () => void): Uint8Array {
  const updates: Uint8Array[] = [];
  const on = (u: Uint8Array) => updates.push(u);
  doc.on('update', on);
  doc.transact(edit);
  doc.off('update', on);
  return Y.mergeUpdates(updates);
}
const problem = (server: Y.Doc | null, update: Uint8Array): string | null => {
  expect(checkUpdate(update)).toBeNull();
  return placesProblem(server, decodeIncoming(update)!, update);
};
/** What `edit` makes of a layout that is there already (and, separately, of a whole new document). */
const refused = (edit: (doc: Y.Doc) => void): string | null => {
  const server = room();
  const c = client(server);
  return problem(server, updateOf(c, () => edit(c)));
};
const raw = (doc: Y.Doc) => doc.getMap('meta').get(PLACES_KEY) as Y.Map<unknown>;
const setModulePlaces = (doc: Y.Doc, places: unknown) => {
  const cache = readSidecarCache(doc)!;
  writeSidecarCache(doc, { ...cache, modules: (cache.modules as object[]).map((m) => ({ ...m, places })) });
};

describe('what the apps write passes', () => {
  it('the layout’s first place, another, a changed field, a deleted one, and the whole document', () => {
    const empty = new Y.Doc();
    const c = client(empty);
    expect(problem(empty, updateOf(c, () => writePlace(c, cannery)))).toBeNull();
    expect(refused((d) => writePlace(d, { ...cannery, id: 'pl-2' }))).toBeNull();
    expect(refused((d) => writePlace(d, { ...cannery, name: 'Mill', spots: [], notes: 'two\nlines' }))).toBeNull();
    expect(refused((d) => deleteRecord(d, PLACES_KEY, 'pl-1'))).toBeNull();
    expect(snapshotPlacesProblem(Y.encodeStateAsUpdate(room()))).toBeNull();
  });

  it('a module’s places, added, changed and taken away', () => {
    expect(refused((d) => setModulePlaces(d, [cannery]))).toBeNull();
    expect(refused((d) => setModulePlaces(d, undefined))).toBeNull();
  });

  it('an undo that puts a place back', () => {
    const server = room();
    const c = client(server);
    const um = new Y.UndoManager([c.getMap('meta')], { trackedOrigins: new Set([null]) });
    const gone = updateOf(c, () => deleteRecord(c, PLACES_KEY, 'pl-1'));
    Y.applyUpdate(server, gone);
    const updates: Uint8Array[] = [];
    c.on('update', (u: Uint8Array) => updates.push(u));
    um.undo();
    expect(problem(server, Y.mergeUpdates(updates))).toBeNull();
    Y.applyUpdate(server, Y.mergeUpdates(updates));
    expect(readPlacesFromDoc(server).map((p) => p.name)).toEqual(['Acme Cannery']);
  });

  it('anything else the apps write, at no more than one look at the update', () => {
    expect(refused((d) => d.getMap('layerData').set('x', new Y.Map([['places', 5]])))).toBeNull();
  });
});

describe('a place outside the limits is refused', () => {
  it('each field of the layout’s own', () => {
    for (const [field, value] of [
      ['name', 'x'.repeat(PLACE_LIMITS.name + 1)],
      ['name', 5],
      ['kind', null],
      ['spots', 'none'],
      ['spots', Array.from({ length: PLACE_LIMITS.spots + 1 }, (_, i) => ({ id: `s${i}`, name: '' }))],
      ['spots', [{ id: 's', name: '', track: { brick: 'a', from: 1, to: 1 } }]],
      ['accepts', ['']],
      ['notes', 'n'.repeat(PLACE_LIMITS.notes + 1)],
      ['later', 'e'.repeat(PLACE_LIMITS.size)],
      ['f'.repeat(PLACE_LIMITS.kind + 1), 1],
    ] as const) {
      expect(refused((d) => (raw(d).get('pl-1') as Y.Map<unknown>).set(field, value)), field).toMatch(/place/);
      expect(refused((d) => writePlace(d, { ...cannery, id: 'pl-2', [field]: value } as Place)), field).toMatch(/place/);
    }
    expect(refused((d) => (raw(d).get('pl-1') as Y.Map<unknown>).set('spots', new Y.Array()))).toMatch(/place/);
  });

  it('an entry that isn’t a place, and the list as something else', () => {
    expect(refused((d) => raw(d).set('pl-2', 'text'))).toMatch(/place/);
    expect(refused((d) => raw(d).set('pl-2', cannery))).toMatch(/place/);
    expect(refused((d) => raw(d).set('p'.repeat(PLACE_LIMITS.id + 1), new Y.Map()))).toMatch(/place/);
    expect(refused((d) => d.getMap('meta').set(PLACES_KEY, 'text'))).toMatch(/places/);
    expect(refused((d) => d.getMap('meta').set(PLACES_KEY, new Y.Array()))).toMatch(/places/);
  });

  it('more places than a layout may have', () => {
    const many = (d: Y.Doc, n: number) => {
      for (let i = 0; i < n; i++) writePlace(d, { ...cannery, id: `q${i}` });
    };
    expect(refused((d) => many(d, MAX_LAYOUT_PLACES - 1))).toBeNull();
    expect(refused((d) => many(d, MAX_LAYOUT_PLACES))).toMatch(/more than/);
  });

  it('a module’s, in its own value and in the whole sidecar (as the contract has them)', () => {
    for (const c of contract.validList) {
      if (c.value === null) continue;
      const got = refused((d) => setModulePlaces(d, c.value));
      expect(got === null, JSON.stringify(c.value).slice(0, 80)).toBe(c.expect);
    }
    for (const c of contract.valid) expect(refused((d) => setModulePlaces(d, [c.value])) === null, JSON.stringify(c.value).slice(0, 80)).toBe(c.expect);
    expect(refused((d) => d.getMap('meta').set('cache', { modules: [], layoutPlaces: ['x'] }))).toMatch(/place/);
    const whole = new Y.Doc();
    whole.transact(() => writeSidecarCache(whole, { modules: [{ id: 'm', members: [], places: [{}] }] }));
    expect(snapshotPlacesProblem(Y.encodeStateAsUpdate(whole))).toMatch(/place/);
  });

  it('not when the layout already held it so: its other edits still go through', () => {
    const server = new Y.Doc();
    server.transact(() => writeSidecarCache(server, { modules: [{ id: 'm1', name: 'Yard', members: [], places: [{ old: 1 }] }] }));
    const c = client(server);
    const rename = updateOf(c, () => {
      const cache = readSidecarCache(c)!;
      writeSidecarCache(c, { ...cache, modules: (cache.modules as object[]).map((m) => ({ ...m, name: 'Mill' })) });
    });
    expect(problem(server, rename)).toBeNull();
    // (One that arrives before the edit it follows is refused too.)
    const worse = updateOf(c, () => setModulePlaces(c, [{ new: 1 }]));
    expect(problem(server, worse)).toMatch(/place/);
    Y.applyUpdate(server, rename);
    expect(problem(server, worse)).toMatch(/place/);
  });

  it('maps nested without end are read to a depth and no further', () => {
    const server = room();
    const c = client(server);
    const deep = updateOf(c, () => {
      let m = new Y.Map<unknown>();
      c.getMap('meta').set('x', m);
      for (let i = 0; i < 5000; i++) {
        const next = new Y.Map<unknown>();
        m.set(PLACES_KEY, next);
        m = next;
      }
    });
    expect(problem(server, deep)).toBeNull();
  });
});

describe('changes that arrive out of order, and two structs for one id', () => {
  const noDeletes = (u: Uint8Array): Uint8Array => {
    const d = Y.decodeUpdate(u);
    for (let cut = 1; cut < u.length; cut++) {
      const t = new Uint8Array([...u.slice(0, cut), 0]);
      try {
        const r = Y.decodeUpdate(t);
        if (r.structs.length === d.structs.length && r.ds.clients.size === 0) return t;
      } catch {
        /* not there */
      }
    }
    throw new Error('no cut');
  };
  /** Two edits of one client; the second arrives first (without its deletions, so the room doesn't hold it whole). */
  const late = (first: (d: Y.Doc) => void, second: (d: Y.Doc) => void) => {
    const server = room();
    const c = client(server);
    const a = updateOf(c, () => first(c));
    const b = noDeletes(updateOf(c, () => second(c)));
    Y.applyUpdate(server, b);
    return { server, a };
  };

  it('a bad place that waits is refused when it would land; a good one isn’t', () => {
    const own = (d: Y.Doc) => raw(d).get('pl-1') as Y.Map<unknown>;
    const bad = late((d) => own(d).set('name', 'Mill'), (d) => own(d).set('name', 'x'.repeat(200)));
    expect(problem(bad.server, bad.a)).toMatch(/place a value/);
    const good = late((d) => own(d).set('name', 'Mill'), (d) => own(d).set('name', 'Cannery Row'));
    expect(problem(good.server, good.a)).toBeNull();
    const list = late((d) => d.getMap('meta').set('x', 1), (d) => writePlace(d, { ...cannery, id: 'pl-9', kind: 'k'.repeat(99) }));
    expect(problem(list.server, list.a)).toMatch(/place/);
  });

  it('a copy is made only when places may be in it, and only while the sender may have one', () => {
    const { server, a } = late((d) => d.getMap('meta').set('x', 1), (d) => writePlace(d, { ...cannery, id: 'pl-9' }));
    expect(placesProblem(server, decodeIncoming(a)!, a, () => false)).toBe(PLACES_COPY_BUDGET_SPENT);
    expect(placesProblem(server, decodeIncoming(a)!, a, () => true)).toBeNull();
    // Nothing about places anywhere: no copy.
    const plain = new Y.Doc();
    const c = client(plain);
    const one = updateOf(c, () => c.getMap('meta').set('x', 1));
    Y.applyUpdate(plain, updateOf(c, () => c.getMap('meta').set('y', 2)));
    const copies = guardWork.docCopies;
    expect(placesProblem(plain, decodeIncoming(one)!, one, () => false)).toBeNull();
    expect(guardWork.docCopies).toBe(copies);
  });

  it('two blocks of one client, in either order', () => {
    for (const swap of [false, true]) {
      const server = room();
      const c = client(server);
      c.clientID = 9001;
      const bad = noDeletes(updateOf(c, () => (raw(c).get('pl-1') as Y.Map<unknown>).set('name', 'x'.repeat(200))));
      const gone = new Y.Doc();
      gone.clientID = 9001;
      gone.getMap('m').set('k', 1);
      const other = Y.encodeStateAsUpdate(gone);
      const a = bad.subarray(1, bad.length - 1);
      const b = other.subarray(1, other.length - 1);
      const u = new Uint8Array([2, ...(swap ? [...b, ...a] : [...a, ...b]), 0]);
      expect(decodeIncoming(u)!.overlapping).toBe(true);
      const why = placesProblem(server, decodeIncoming(u)!, u);
      // (Yjs reads one of the two blocks: refused whenever that leaves a bad place.)
      Y.applyUpdate(server, u);
      const left = (raw(server).get('pl-1') as Y.Map<unknown>).get('name') as string;
      expect(why !== null).toBe(left.length > PLACE_LIMITS.name);
    }
  });

  it('many small fields can’t make one place too big', () => {
    const server = room();
    let refusedAt = 0;
    for (let i = 0; i < 12 && !refusedAt; i++) {
      const c = client(server);
      const u = updateOf(c, () => (raw(c).get('pl-1') as Y.Map<unknown>).set(`f${i}`, 'e'.repeat(20_000)));
      if (problem(server, u)) refusedAt = i;
      else Y.applyUpdate(server, u);
    }
    expect(refusedAt).toBeGreaterThan(3);
    expect(refusedAt).toBeLessThan(8);
  });
});

describe('a shared module’s places', () => {
  const LIB = '5f0c0c0e-5d0e-4c55-9a43-1f3a2c9f7d10';
  const V1 = contents([{ pn: 'a.1', x: 0, y: 0 }, { pn: 'b.1', x: 4, y: 0 }]);
  const shared = () => {
    const doc = createDefaultLayoutDoc();
    placeShared(doc, { placedId: 'locked', moduleId: LIB, version: 1, bytes: V1, placement: { degrees: 0, x: 100, y: 50 } });
    doc.transact(() => {
      const cache = readSidecarCache(doc)!;
      writeSidecarCache(doc, { ...cache, modules: (cache.modules as object[]).map((m) => withPlaces(m, [cannery])) });
    });
    return doc;
  };
  const mods = (d: Y.Doc) => readSidecarCache(d)!.modules as Record<string, unknown>[];
  const change = (server: Y.Doc, f: (m: Record<string, unknown>) => object) => {
    const c = client(server);
    const u = updateOf(c, () => writeSidecarCache(c, { ...readSidecarCache(c)!, modules: mods(c).map(f) }));
    return { u, check: sharedLockCheck(server, u, decodeIncoming(u)!) };
  };

  it('changed, added to or taken away: put back as they were', () => {
    for (const places of [[], [{ ...cannery, name: 'Mine' }], [cannery, { ...cannery, id: 'pl-2' }]]) {
      const server = shared();
      const { u, check } = change(server, (m) => withPlaces(m, places));
      expect(check).toMatchObject({ modules: ['locked'], why: 'it changes the places of a shared module' });
      Y.applyUpdate(server, u);
      repairShared(server, check as never, 'server');
      expect(modulePlaces(mods(server)[0]!)).toEqual([cannery]);
    }
  });

  it('the rest of its value may change (its pin, its color), and the same places in another field order are the same', () => {
    expect(change(shared(), (m) => ({ ...m, pinned: true })).check).toBeNull();
    expect(change(shared(), (m) => ({ ...m, places: [Object.fromEntries(Object.entries(cannery).reverse())] })).check).toBeNull();
  });
});
