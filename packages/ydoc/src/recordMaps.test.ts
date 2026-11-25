import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { readBbm } from '@cld/bbm';
import {
  OPS_JOBS_KEY,
  RECORD_MAPS,
  ROLLING_STOCK_KEY,
  TRAINS_KEY,
  WAYBILLS_KEY,
  ensureRecordMaps,
  exportSidecarFromDoc,
  readPlacesFromDoc,
  readRecordsFromDoc,
  readRoutesFromDoc,
  readSwitchStatesFromDoc,
  seedFromBbm,
  writePlace,
  writeRecord,
  writeRoute,
  writeSwitchStates,
} from './index.js';

const BBM = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../bbm/tests/fixtures/tight-corner.bbm'), 'utf8');
const layout = () => seedFromBbm(readBbm(BBM).map);
const place = (id: string) => ({ id, name: id, kind: 'industry', spots: [], accepts: [], ships: [], tags: [], notes: '' });
const copy = (d: Y.Doc) => {
  const c = new Y.Doc();
  Y.applyUpdate(c, Y.encodeStateAsUpdate(d));
  return c;
};
const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
};

/** Two people each add the first of everything before either hears of the other. */
function bothAdd(room: Y.Doc): [Y.Doc, Y.Doc] {
  const a = copy(room);
  const b = copy(room);
  for (const [d, n] of [[a, 'a'], [b, 'b']] as const) {
    d.transact(() => {
      writePlace(d, place(n));
      writeRoute(d, { id: n, name: n, waypoints: [] } as never);
      writeRecord(d, ROLLING_STOCK_KEY, { id: n });
      writeRecord(d, TRAINS_KEY, { id: n });
      writeRecord(d, WAYBILLS_KEY, { id: n });
      writeRecord(d, OPS_JOBS_KEY, { id: n });
      writeSwitchStates(d, { [`${n}/0`]: 1 });
    });
  }
  sync(a, b);
  return [a, b];
}
const all = (d: Y.Doc) => [
  readPlacesFromDoc(d).map((x) => x.id),
  readRoutesFromDoc(d).map((x) => x.id),
  readRecordsFromDoc(d, ROLLING_STOCK_KEY).map((x) => x.id),
  readRecordsFromDoc(d, TRAINS_KEY).map((x) => x.id),
  readRecordsFromDoc(d, WAYBILLS_KEY).map((x) => x.id),
  readRecordsFromDoc(d, OPS_JOBS_KEY).map((x) => x.id),
  Object.keys(readSwitchStatesFromDoc(d)).map((k) => k[0]).sort(),
];

describe('the maps a layout keeps its records in', () => {
  it('without them, two people’s first records make two maps and one is lost', () => {
    const [a, b] = bothAdd(layout());
    for (const d of [a, b]) for (const ids of all(d)) expect(ids).toHaveLength(1);
  });

  it('with them, both stay, of every kind', () => {
    const room = layout();
    expect(ensureRecordMaps(room)).toBe(true);
    const [a, b] = bothAdd(room);
    for (const d of [a, b]) for (const ids of all(d)) expect(ids).toEqual(['a', 'b']);
  });

  it('Undo of the first takes back only that one', () => {
    const room = layout();
    ensureRecordMaps(room);
    const a = copy(room);
    const undo = new Y.UndoManager([a.getMap('meta')], { trackedOrigins: new Set(['me']) });
    a.transact(() => writePlace(a, place('a')), 'me');
    const b = copy(a);
    writePlace(b, place('b'));
    sync(a, b);
    undo.undo();
    expect(readPlacesFromDoc(a).map((x) => x.id)).toEqual(['b']);
  });

  it('made twice, or again after a restart that lost them, they are the same ones', () => {
    const room = layout();
    const bare = copy(room);
    ensureRecordMaps(room);
    expect(ensureRecordMaps(room)).toBe(false);
    const a = copy(room);
    writePlace(a, place('a'));
    ensureRecordMaps(bare);
    writePlace(bare, place('b'));
    sync(a, bare);
    for (const d of [a, bare]) expect(readPlacesFromDoc(d).map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('a map made by someone who hadn’t heard of them wins over the empty one', () => {
    const room = layout();
    const early = copy(room);
    writePlace(early, place('a'));
    ensureRecordMaps(room);
    sync(room, early);
    for (const d of [room, early]) expect(readPlacesFromDoc(d).map((x) => x.id)).toEqual(['a']);
  });

  it('leaves what a layout has, a layout whose import kept them in the cache, and one not seeded yet', () => {
    const room = layout();
    writePlace(room, place('a'));
    room.getMap('meta').set('cache', { schemaVersion: 1, bbmHashSha256: '', routes: [{ id: 'r', name: 'R', waypoints: [] }], extras: {} });
    const before = exportSidecarFromDoc(room);
    ensureRecordMaps(room);
    expect(exportSidecarFromDoc(room)).toEqual(before);
    expect(room.getMap('meta').get('routes')).toBeUndefined();
    expect(readPlacesFromDoc(room).map((x) => x.id)).toEqual(['a']);
    expect(ensureRecordMaps(new Y.Doc())).toBe(false);
    const old = layout();
    old.getMap('meta').set('cache', { schemaVersion: 1, bbmHashSha256: '', extras: { layoutPlaces: [place('x')] } });
    ensureRecordMaps(old);
    expect(readPlacesFromDoc(old).map((x) => x.id)).toEqual(['x']);
  });

  it('a layout that has the first five gets the two more, once, and nothing else changes', () => {
    const room = layout();
    ensureRecordMaps(room);
    // As one opened before there were waybills and jobs.
    const older = new Y.Doc();
    Y.applyUpdate(older, Y.encodeStateAsUpdate(layout()));
    for (const [key, client] of RECORD_MAPS.slice(0, 5)) {
      const one = new Y.Doc();
      one.clientID = client;
      one.getMap('meta').set(key, new Y.Map());
      Y.applyUpdate(older, Y.encodeStateAsUpdate(one));
    }
    writePlace(older, place('a'));
    const was = copy(older);
    const files = exportSidecarFromDoc(older);
    const sv = Y.encodeStateVector(older);
    expect(ensureRecordMaps(older)).toBe(true);
    // What it adds: two structs of their own, and no deletion.
    const added = Y.decodeUpdate(Y.encodeStateAsUpdate(older, sv));
    expect(added.structs.map((s) => [s.id.client, s.id.clock, s.length]).sort()).toEqual([[6, 0, 1], [7, 0, 1]]);
    const keys = (d: Y.Doc) => [...d.getMap('meta').keys()].filter((k) => k !== WAYBILLS_KEY && k !== OPS_JOBS_KEY).sort();
    expect(keys(older)).toEqual(keys(was));
    for (const k of keys(was)) expect(JSON.stringify(older.getMap('meta').get(k))).toBe(JSON.stringify(was.getMap('meta').get(k)));
    expect(exportSidecarFromDoc(older)).toEqual(files);
    // Once: not again, nor after it is stored and opened again.
    expect(ensureRecordMaps(older)).toBe(false);
    expect(ensureRecordMaps(copy(older))).toBe(false);
    // An older app's edit of what it knows leaves them as they are.
    const old = copy(older);
    writePlace(old, place('b'));
    sync(old, older);
    expect((older.getMap('meta').get(WAYBILLS_KEY) as Y.Map<unknown>).size).toBe(0);
    expect(ensureRecordMaps(older)).toBe(false);
  });

  it('a file an older build kept in the cache’s extras is read, and moves over with the first write', () => {
    const old = layout();
    old.getMap('meta').set('cache', { schemaVersion: 1, bbmHashSha256: '', extras: { waybills: [{ id: 'w' }], opsJobs: [{ id: 'j' }], later: 1 } });
    ensureRecordMaps(old);
    expect(exportSidecarFromDoc(old)).toMatchObject({ waybills: [{ id: 'w' }], opsJobs: [{ id: 'j' }], extras: { later: 1 } });
    writeRecord(old, WAYBILLS_KEY, { id: 'w2' });
    expect(readRecordsFromDoc(old, WAYBILLS_KEY).map((x) => x.id)).toEqual(['w', 'w2']);
    expect(exportSidecarFromDoc(old)!.waybills).toHaveLength(2);
  });

  it('an untouched layout writes the same files', () => {
    const room = layout();
    const before = exportSidecarFromDoc(room);
    ensureRecordMaps(room);
    expect(exportSidecarFromDoc(room)).toEqual(before);
    expect(new Set(RECORD_MAPS.map(([, c]) => c)).size).toBe(RECORD_MAPS.length);
  });
});
