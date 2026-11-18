// Doc shape 4 (sharedShape.ts): a layout moves to it with its first shared
// module, in a step of its own that is never undone; a layout without one
// stays as it is; a reader that knows only shape 3 refuses the doc.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DOC_SCHEMA_VERSION, DOC_SHAPE_SHARED, SHAPE_ORIGIN, canReadDoc, createDefaultLayoutDoc, hasSharedMark, holdsSharedModule, readSidecarCache, stampShared, upgradeDoc, writeSidecarCache } from './index.js';

const LIB = '5f0c0c0e-5d0e-4c55-9a43-1f3a2c9f7d10';
const plain = { id: 'm1', name: 'Yard', members: [], transform: [1, 0, 0, 0, 1, 0, 0, 0, 1], libraryModuleId: LIB, libraryVersion: 3 };
const shared = { ...plain, id: 'm2', name: 'Harbor crane', shared: { by: 'Alice', placement: { degrees: 0, x: 1, y: 2 } } };
const stampOf = (doc: Y.Doc) => doc.getMap('meta').get('schemaVersion');
const write = (doc: Y.Doc, modules: unknown[], origin: unknown = 'local') =>
  doc.transact(() => writeSidecarCache(doc, { schemaVersion: 1, bbmHashSha256: '', modules }), origin);

describe('doc shape 4', () => {
  it('is read from here on, and a reader of shape 3 refuses it', () => {
    expect(DOC_SHAPE_SHARED).toBe(4);
    expect(DOC_SCHEMA_VERSION).toBeGreaterThanOrEqual(4);
    expect(canReadDoc(4)).toBe(true);
    expect(canReadDoc(4, 3)).toBe(false);
    expect(canReadDoc(3, 4)).toBe(true);
  });

  it('knows a shared module by its `shared` field and its link', () => {
    expect(hasSharedMark(shared)).toBe(true);
    for (const not of [plain, { ...shared, shared: true }, { ...shared, shared: [] }, { ...shared, shared: null }, { ...shared, libraryModuleId: undefined }, { ...shared, libraryModuleId: '' }, null, 'x', 7]) {
      expect(hasSharedMark(not)).toBe(false);
    }
  });

  it('a layout moves to shape 4 with its first shared module, in a step of its own', () => {
    const doc = createDefaultLayoutDoc();
    const origins: unknown[] = [];
    doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin));
    write(doc, [plain]);
    expect(stampOf(doc)).toBe(1);
    expect(holdsSharedModule(doc)).toBe(false);
    write(doc, [plain, shared]);
    expect(stampOf(doc)).toBe(4);
    expect(holdsSharedModule(doc)).toBe(true);
    expect(origins).toEqual(['local', 'local', SHAPE_ORIGIN]);
    // Written again: no second stamp.
    write(doc, [plain, { ...shared, pinned: true }]);
    expect(origins).toEqual(['local', 'local', SHAPE_ORIGIN, 'local']);
  });

  it('the stamp is never undone, and stays when the shared module goes', () => {
    const doc = createDefaultLayoutDoc();
    const undo = new Y.UndoManager([doc.getMap('meta'), doc.getMap('sidecarItems')], { trackedOrigins: new Set(['local']) });
    write(doc, [shared]);
    expect(stampOf(doc)).toBe(4);
    undo.undo();
    expect((readSidecarCache(doc)?.modules as unknown[] | undefined) ?? []).toEqual([]);
    expect(stampOf(doc)).toBe(4);
    write(doc, []);
    expect(stampOf(doc)).toBe(4);
  });

  it('a doc holding a shared module under a lower stamp is stamped on opening, like part keys', () => {
    const doc = createDefaultLayoutDoc();
    write(doc, [shared]);
    // Two stamps written at the same instant, the lower one kept.
    doc.getMap('meta').set('schemaVersion', 3);
    expect(upgradeDoc(doc)).toBe(true);
    expect(stampOf(doc)).toBe(4);
    expect(upgradeDoc(doc)).toBe(false);
    // Only in the blob (a writer that doesn't know the items): still found.
    const blobOnly = createDefaultLayoutDoc();
    blobOnly.getMap('meta').set('cache', { schemaVersion: 1, bbmHashSha256: '', modules: [shared] });
    expect(stampShared(blobOnly)).toBe(true);
    expect(stampOf(blobOnly)).toBe(4);
  });

  it('a layout without shared modules stays in the shape it has', () => {
    const doc = createDefaultLayoutDoc();
    write(doc, [plain]);
    expect(stampShared(doc)).toBe(false);
    expect(upgradeDoc(doc)).toBe(false);
    expect(stampOf(doc)).toBe(1);
    // An empty, unseeded doc is left alone.
    expect(stampShared(new Y.Doc())).toBe(false);
  });
});
