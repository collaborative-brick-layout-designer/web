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
});
