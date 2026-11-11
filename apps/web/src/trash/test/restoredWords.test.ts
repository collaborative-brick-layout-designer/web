// The toast after a restore from Recently deleted: a module says which
// collections it's back in, and that one it was in has since been deleted.

import { describe, expect, it } from 'vitest';
import { restoredWords } from '../RecentlyDeleted';

const back = (...titles: string[]) => titles.map((title, i) => ({ id: `c${i}`, title }));

describe('restoredWords', () => {
  it('a layout, venue or module that was in no collection: just the name', () => {
    expect(restoredWords('Main yard', {})).toBe('Restored “Main yard”');
    expect(restoredWords('Siding', { collections: { back: [], gone: 0 } })).toBe('Restored “Siding”');
  });

  it('names the collections it is back in', () => {
    expect(restoredWords('Siding', { collections: { back: back('Town'), gone: 0 } })).toBe('Restored “Siding”. It’s back in “Town”.');
    expect(restoredWords('Siding', { collections: { back: back('Town', 'Yard'), gone: 0 } })).toBe('Restored “Siding”. It’s back in “Town” and “Yard”.');
    expect(restoredWords('Siding', { collections: { back: back('A', 'B', 'C'), gone: 0 } })).toBe('Restored “Siding”. It’s back in “A”, “B” and “C”.');
    expect(restoredWords('Siding', { collections: { back: back('A', 'B', 'C', 'D'), gone: 0 } })).toBe('Restored “Siding”. It’s back in its 4 collections.');
  });

  it('says in plain words when a collection it was in is gone', () => {
    expect(restoredWords('Siding', { collections: { back: [], gone: 1 } })).toBe(
      'Restored “Siding”. The collection it was in has been deleted since, so it isn’t in that one.',
    );
    expect(restoredWords('Siding', { collections: { back: back('Town'), gone: 1 } })).toBe(
      'Restored “Siding”. It’s back in “Town”. The other collection it was in has been deleted since, so it isn’t in that one.',
    );
    expect(restoredWords('Siding', { collections: { back: back('Town'), gone: 2 } })).toBe(
      'Restored “Siding”. It’s back in “Town”. 2 other collections it was in have been deleted since, so it isn’t in those.',
    );
  });
  it('names a collection that filled up meanwhile, and says what to do', () => {
    expect(restoredWords('Yard', { collections: { back: [], gone: 0, full: [{ id: 'c', title: 'Picks' }] } })).toBe(
      'Restored “Yard”. “Picks” is full now, so it isn’t back in that one. Take something out of it, then add this again.',
    );
    expect(restoredWords('Yard', { collections: { back: [{ id: 'a', title: 'Best' }], gone: 0, full: [{ id: 'c', title: 'Picks' }, { id: 'd', title: 'Show' }] } })).toBe(
      'Restored “Yard”. It’s back in “Best”. “Picks” and “Show” are full now, so it isn’t back in those. Take something out of them, then add this again.',
    );
    // An older server says nothing about full collections.
    expect(restoredWords('Yard', { collections: { back: [], gone: 0 } })).toBe('Restored “Yard”');
  });
});
