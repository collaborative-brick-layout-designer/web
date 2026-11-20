// Rolling stock and trains in the live doc (trains design 2.6): Y.Maps at
// meta.rollingStock and meta.trains, one Y.Map a record; a sidecar coming in
// puts them there, one going out reads them back; different records and
// fields merge; a delete against an edit: the delete wins.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createSidecarDoc, deleteRecord, exportSidecarFromDoc, importSidecarIntoDoc, readRecordsFromDoc, readSidecarCache, ROLLING_STOCK_KEY, TRAINS_KEY, writeRecord } from './index.js';

const car = (id: string, number: string) => ({ id, number, length: 32, trucks: [{ at: 8, swivelMax: 30 }, { at: -8, swivelMax: 30 }] });
const train = (id: string, name: string) => ({ id, name, units: [{ stock: 'c1', reversed: false }], position: null });

describe('rolling stock and trains in the doc', () => {
  it('come in from a sidecar to their maps, and go out again', () => {
    const doc = createSidecarDoc();
    importSidecarIntoDoc(doc, { schemaVersion: 1, bbmHashSha256: '', rollingStock: [car('c1', 'SP 1')], trains: [train('t1', 'Daylight')] });
    expect(doc.getMap('meta').get(ROLLING_STOCK_KEY)).toBeInstanceOf(Y.Map);
    expect(readSidecarCache(doc)).not.toHaveProperty('trains');
    const out = exportSidecarFromDoc(doc)!;
    expect(out.rollingStock).toEqual([car('c1', 'SP 1')]);
    expect(out.trains).toEqual([train('t1', 'Daylight')]);
  });

  it('two people changing different fields of one train, and adding cars, all stay; a delete wins over an edit', () => {
    const a = createSidecarDoc();
    writeRecord(a, TRAINS_KEY, train('t1', 'Daylight'));
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    writeRecord(a, TRAINS_KEY, { ...train('t1', 'Coast Daylight') });
    writeRecord(b, TRAINS_KEY, { ...train('t1', 'Daylight'), units: [{ stock: 'c2', reversed: true }] });
    writeRecord(b, ROLLING_STOCK_KEY, car('c2', 'SP 2'));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    for (const d of [a, b]) {
      expect(readRecordsFromDoc(d, TRAINS_KEY)[0]).toMatchObject({ name: 'Coast Daylight', units: [{ stock: 'c2', reversed: true }] });
      expect(readRecordsFromDoc(d, ROLLING_STOCK_KEY).map((r) => r.id)).toEqual(['c2']);
    }
    deleteRecord(a, TRAINS_KEY, 't1');
    writeRecord(b, TRAINS_KEY, train('t1', 'Renamed'));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(readRecordsFromDoc(a, TRAINS_KEY)).toEqual([]);
    expect(readRecordsFromDoc(b, TRAINS_KEY)).toEqual([]);
  });
});
