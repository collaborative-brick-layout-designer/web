// Doc shape 5 (keepIdsShape.ts): stamped with a shared module's first
// update that keeps its unchanged parts, in its own step, with a mark that
// raises a lower stamp written at the same moment again on opening; and a
// reader of shape 4 refuses it.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DOC_SCHEMA_VERSION, DOC_SHAPE_KEEP_IDS, KEPT_IDS_MARK, SHAPE_ORIGIN, canReadDoc, createDefaultLayoutDoc, restampKeepIds, stampKeepIds, upgradeDoc } from './index.js';

describe('doc shape 5', () => {
  it('is the newest shape, and a reader of shape 4 refuses it', () => {
    expect(DOC_SHAPE_KEEP_IDS).toBe(5);
    expect(DOC_SCHEMA_VERSION).toBe(5);
    expect(canReadDoc(5)).toBe(true);
    expect(canReadDoc(5, 4)).toBe(false);
    expect(canReadDoc(4, 5)).toBe(true);
  });

  it('is stamped with the mark in its own step, once', () => {
    const doc = createDefaultLayoutDoc();
    doc.getMap('meta').set('schemaVersion', 4);
    const origins: unknown[] = [];
    doc.on('afterTransaction', (t: Y.Transaction) => origins.push(t.origin));
    expect(stampKeepIds(doc)).toBe(true);
    expect(doc.getMap('meta').get('schemaVersion')).toBe(5);
    expect(doc.getMap('meta').get(KEPT_IDS_MARK)).toBe(true);
    expect(origins).toEqual([SHAPE_ORIGIN]);
    expect(stampKeepIds(doc)).toBe(false);
  });

  it('a lower stamp written at the same moment is raised again on opening', () => {
    const doc = createDefaultLayoutDoc();
    stampKeepIds(doc);
    doc.getMap('meta').set('schemaVersion', 4);
    expect(upgradeDoc(doc)).toBe(true);
    expect(doc.getMap('meta').get('schemaVersion')).toBe(5);
    // Without the mark, a doc stays as it is.
    const plain = createDefaultLayoutDoc();
    expect(restampKeepIds(plain)).toBe(false);
  });
});
