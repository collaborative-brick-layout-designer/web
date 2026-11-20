// Named routes in the live doc (trains design 2.5, 4.4): a Y.Map at
// meta.routes, one Y.Map a route, so different routes, and different fields
// of one, merge; a delete against an edit: the delete wins.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createSidecarDoc, deleteRoute, exportSidecarFromDoc, importSidecarIntoDoc, readRoutesFromDoc, readSidecarCache, ROUTES_KEY, writeRoute } from './index.js';

const at = (brick: string) => ({ brick, from: 0, to: 1, s: 2 });
const route = (id: string, name: string) => ({ id, name, train: null, from: at('A'), to: at('E'), via: [], steps: [{ brick: 'A', from: 0, to: 1 }], color: '#3B82F6' });

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
}

describe('routes in the doc', () => {
  it('a sidecar coming in puts them in meta.routes, and they go out again, by name', () => {
    const doc = createSidecarDoc();
    importSidecarIntoDoc(doc, { schemaVersion: 1, bbmHashSha256: '', routes: [route('r2', 'Yard'), route('r1', 'Main')] });
    expect(doc.getMap('meta').get(ROUTES_KEY)).toBeInstanceOf(Y.Map);
    expect(readSidecarCache(doc)).not.toHaveProperty('routes');
    expect(readRoutesFromDoc(doc).map((r) => r.name)).toEqual(['Main', 'Yard']);
    expect(exportSidecarFromDoc(doc)?.routes).toEqual([route('r1', 'Main'), route('r2', 'Yard')]);
  });

  it('a rename here and a new way there both stay; different routes both stay', () => {
    const a = createSidecarDoc();
    writeRoute(a, route('r1', 'Main'));
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    writeRoute(a, { ...route('r1', 'Main line'), steps: route('r1', '').steps });
    writeRoute(b, { ...route('r1', 'Main'), steps: [{ brick: 'B', from: 0, to: 1 }] });
    writeRoute(b, route('r2', 'Yard'));
    sync(a, b);
    for (const d of [a, b]) {
      const rs = readRoutesFromDoc(d);
      expect(rs.map((r) => r.id)).toEqual(['r1', 'r2']);
      expect(rs[0]!.name).toBe('Main line');
      expect(rs[0]!.steps).toEqual([{ brick: 'B', from: 0, to: 1 }]);
    }
  });

  it('a delete against an edit: the delete wins', () => {
    const a = createSidecarDoc();
    writeRoute(a, route('r1', 'Main'));
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    deleteRoute(a, 'r1');
    writeRoute(b, route('r1', 'Renamed'));
    sync(a, b);
    expect(readRoutesFromDoc(a)).toEqual([]);
    expect(readRoutesFromDoc(b)).toEqual([]);
  });

  it('an older build’s copy in meta.cache is read, and moved over by the first write', () => {
    const doc = createSidecarDoc();
    doc.getMap('meta').set('cache', { schemaVersion: 1, bbmHashSha256: '', routes: [route('r1', 'Main'), { name: 'no id' }] });
    expect(readRoutesFromDoc(doc).map((r) => r.id)).toEqual(['r1']);
    writeRoute(doc, route('r2', 'Yard'));
    expect(doc.getMap('meta').get(ROUTES_KEY)).toBeInstanceOf(Y.Map);
    expect(readRoutesFromDoc(doc).map((r) => r.id)).toEqual(['r1', 'r2']);
  });
});
