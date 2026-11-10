// The budget is the one sidecar field kept outside meta.cache: a Y.Map at
// meta.budgetLimits, as the editor edits it. A sidecar coming in (an upload,
// a .bld-layout) lands there, and a sidecar going out carries it.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { exportSidecarFromDoc, importSidecarIntoDoc, readBudgetLimitsFromDoc, readSidecarCache, readSidecarFromDoc, seedFromSidecar } from './index.js';

const side = { schemaVersion: 1, bbmHashSha256: '', modules: [{ id: 'm0', name: 'Yard', members: [], transform: [] }], budgetLimits: { '3001.1': 12, '3005.4': 0 } };

describe('budget limits in the doc', () => {
  it('an imported sidecar puts the budget in meta.budgetLimits, not in the cache', () => {
    const doc = new Y.Doc();
    importSidecarIntoDoc(doc, side);
    const y = doc.getMap('meta').get('budgetLimits');
    expect(y).toBeInstanceOf(Y.Map);
    expect([...(y as Y.Map<number>).entries()]).toEqual([['3001.1', 12], ['3005.4', 0]]);
    expect(readSidecarCache(doc)).not.toHaveProperty('budgetLimits');
    expect(readBudgetLimitsFromDoc(doc)).toEqual(side.budgetLimits);
  });

  it('a sidecar going out carries the budget, read or exported; none without one', () => {
    const doc = new Y.Doc();
    importSidecarIntoDoc(doc, side);
    expect(exportSidecarFromDoc(doc)?.budgetLimits).toEqual(side.budgetLimits);
    expect(readSidecarFromDoc(doc)?.budgetLimits).toEqual(side.budgetLimits);
    expect(exportSidecarFromDoc(doc)?.modules).toEqual(side.modules);
    const plain = new Y.Doc();
    importSidecarIntoDoc(plain, { schemaVersion: 1, bbmHashSha256: '', modules: side.modules });
    expect(exportSidecarFromDoc(plain)).not.toHaveProperty('budgetLimits');
    expect(readBudgetLimitsFromDoc(plain)).toBeUndefined();
  });

  it('a budget set in the editor is exported even when the layout has no other sidecar', () => {
    const doc = new Y.Doc();
    const y = new Y.Map<number>();
    y.set('3001.1', 4);
    doc.getMap('meta').set('budgetLimits', y);
    expect(exportSidecarFromDoc(doc)).toEqual({ schemaVersion: 1, bbmHashSha256: '', budgetLimits: { '3001.1': 4 } });
  });

  it('a sidecar without a budget leaves the doc’s budget alone; an empty one keeps "has a budget"', () => {
    const doc = seedFromSidecar(side);
    importSidecarIntoDoc(doc, { schemaVersion: 1, bbmHashSha256: '' });
    expect(readBudgetLimitsFromDoc(doc)).toEqual(side.budgetLimits);
    importSidecarIntoDoc(doc, { schemaVersion: 1, bbmHashSha256: '', budgetLimits: {} });
    expect(readBudgetLimitsFromDoc(doc)).toEqual({});
  });
});
