// Switch settings (trains design 2.2) in the live doc: a Y.Map at
// meta.switchStates, one key a switch, like the budget. A sidecar coming
// in puts them there; one going out reads them back; an older web build's
// copy in meta.cache is read until the first write moves it over; two
// people flipping different switches at once both keep their flip.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createSidecarDoc, exportSidecarFromDoc, importSidecarIntoDoc, readSidecarCache, readSidecarFromDoc, readSwitchStatesFromDoc, SWITCH_STATES_KEY, writeSwitchStates } from './index.js';

const side = { schemaVersion: 1, bbmHashSha256: '', modules: [], switchStates: { 'P/0': 2, 'Q/1': 0 } };

describe('switch settings in the doc', () => {
  it('an imported sidecar puts them in meta.switchStates, not in the cache, and they come back out', () => {
    const doc = createSidecarDoc();
    importSidecarIntoDoc(doc, side);
    expect(doc.getMap('meta').get(SWITCH_STATES_KEY)).toBeInstanceOf(Y.Map);
    expect(readSidecarCache(doc)).not.toHaveProperty('switchStates');
    expect(readSwitchStatesFromDoc(doc)).toEqual({ 'P/0': 2, 'Q/1': 0 });
    expect(exportSidecarFromDoc(doc)?.switchStates).toEqual({ 'P/0': 2, 'Q/1': 0 });
    expect(readSidecarFromDoc(doc)?.switchStates).toEqual({ 'P/0': 2, 'Q/1': 0 });
  });

  it('none set: no field going out, and an empty read', () => {
    const doc = createSidecarDoc();
    importSidecarIntoDoc(doc, { schemaVersion: 1, bbmHashSha256: '', modules: [] });
    expect(doc.getMap('meta').has(SWITCH_STATES_KEY)).toBe(false);
    expect(readSwitchStatesFromDoc(doc)).toEqual({});
    expect(exportSidecarFromDoc(doc)).not.toHaveProperty('switchStates');
  });

  it('sets, clears and prunes one key at a time', () => {
    const doc = createSidecarDoc();
    writeSwitchStates(doc, { 'P/0': 2, 'Q/1': 0 });
    writeSwitchStates(doc, { 'P/0': null });
    expect(readSwitchStatesFromDoc(doc)).toEqual({ 'Q/1': 0 });
    writeSwitchStates(doc, { 'R/0': 1 }, new Set(['R']));
    expect(readSwitchStatesFromDoc(doc)).toEqual({ 'R/0': 1 }); // Q is gone from the map
  });

  it('an older build’s copy in meta.cache is read, and moved over by the first write', () => {
    const doc = createSidecarDoc();
    doc.getMap('meta').set('cache', { schemaVersion: 1, bbmHashSha256: '', switchStates: { 'P/0': 2, 'X/0': 'bad' } });
    expect(readSwitchStatesFromDoc(doc)).toEqual({ 'P/0': 2 });
    writeSwitchStates(doc, { 'Q/1': 0 });
    expect(doc.getMap('meta').get(SWITCH_STATES_KEY)).toBeInstanceOf(Y.Map);
    expect(readSwitchStatesFromDoc(doc)).toEqual({ 'P/0': 2, 'Q/1': 0 });
    // Going out, the doc's settings win over the cache's.
    expect(exportSidecarFromDoc(doc)?.switchStates).toEqual({ 'P/0': 2, 'Q/1': 0 });
  });

  it('two people flipping different switches at once both keep their flip; the same switch, one wins', () => {
    const a = createSidecarDoc();
    writeSwitchStates(a, { 'P/0': 1 });
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    writeSwitchStates(a, { 'P/0': 2 });
    writeSwitchStates(b, { 'Q/1': 3, 'P/0': 1 });
    writeSwitchStates(b, { 'P/0': 2 });
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(readSwitchStatesFromDoc(a)).toEqual({ 'P/0': 2, 'Q/1': 3 });
    expect(readSwitchStatesFromDoc(b)).toEqual(readSwitchStatesFromDoc(a));

    const c = new Y.Doc();
    Y.applyUpdate(c, Y.encodeStateAsUpdate(a));
    writeSwitchStates(a, { 'Q/1': 0 });
    writeSwitchStates(c, { 'Q/1': 4 });
    Y.applyUpdate(a, Y.encodeStateAsUpdate(c));
    Y.applyUpdate(c, Y.encodeStateAsUpdate(a));
    expect([0, 4]).toContain(readSwitchStatesFromDoc(a)['Q/1']);
    expect(readSwitchStatesFromDoc(c)).toEqual(readSwitchStatesFromDoc(a));
  });
});
