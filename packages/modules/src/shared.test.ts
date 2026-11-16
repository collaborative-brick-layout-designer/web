// Reading a placed module's shared link from its sidecar value (shared.ts).

import { describe, expect, it } from 'vitest';
import { detached, isSharedModule, sharedModulesIn, sharedPlaced, withShared } from './index.js';

const LIB = '5f0c0c0e-5d0e-4c55-9a43-1f3a2c9f7d10';
const base = { id: 'p1', name: 'Harbor crane', members: ['a', 'b'], libraryModuleId: LIB, libraryVersion: 7 };

describe('a shared placed module', () => {
  it('needs `shared` and a library module to follow', () => {
    expect(sharedPlaced({ ...base, shared: { by: 'Alice', server: 'https://example.org', placement: { degrees: 90, x: 1, y: 2 }, review: { from: 6, to: 7, at: 5 } } })).toEqual({
      placedId: 'p1', name: 'Harbor crane', moduleId: LIB, version: 7, by: 'Alice', server: 'https://example.org',
      placement: { degrees: 90, x: 1, y: 2 }, review: { from: 6, to: 7, at: 5 }, members: ['a', 'b'],
    });
    expect(sharedPlaced({ ...base, shared: {} })).toMatchObject({ by: null, server: null, placement: null, review: null });
    for (const not of [base, { ...base, shared: true }, { ...base, shared: [] }, { ...base, shared: {}, libraryModuleId: 'nope' }, { ...base, shared: {}, libraryModuleId: undefined }, null, undefined]) {
      expect(isSharedModule(not as never)).toBe(false);
    }
    // A version or a review that isn't one reads as not known.
    expect(sharedPlaced({ ...base, libraryVersion: 0, shared: { review: { to: 'x' }, placement: { degrees: 'a' } } })).toMatchObject({ version: null, review: null, placement: null });
    expect(sharedPlaced({ ...base, shared: { review: { from: 0, to: 3 } } })?.review).toEqual({ from: null, to: 3, at: 0 });
  });

  it('lists a sidecar’s shared modules', () => {
    expect(sharedModulesIn({ modules: [base, { ...base, id: 'p2', shared: {} }, null, 'x'] }).map((s) => s.placedId)).toEqual(['p2']);
    expect(sharedModulesIn(null)).toEqual([]);
    expect(sharedModulesIn({ modules: 'x' })).toEqual([]);
  });

  it('changes the link keeping what it doesn’t know, and detaches', () => {
    const m = { ...base, shared: { by: 'Alice', future: 1, review: { from: 6, to: 7, at: 5 } }, outlineColor: '#f00' };
    expect(withShared(m, { review: undefined, placement: { degrees: 0, x: 3, y: 4 } }).shared).toEqual({ by: 'Alice', future: 1, placement: { degrees: 0, x: 3, y: 4 } });
    expect(detached(m)).toEqual({ id: 'p1', name: 'Harbor crane', members: ['a', 'b'], outlineColor: '#f00' });
  });
});
