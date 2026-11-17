// The words and rules for shared modules in the editor (sharedModules.ts,
// modules/ModuleClubShares.tsx): a placed copy's state, which copies have
// a newer version, the notices, whom to ask when a module can't go into a
// layout, and what the owner is told about stopping a share and where the
// module is used.

import { describe, expect, it } from 'vitest';
import type { SharedPlaced } from '@cld/modules';
import type { LayoutSharedModule, SharedPlaceCheck } from '../../api';
import type { SidecarModule } from '@cld/bbm';
import { findSharedUpdates, forClipboard, newerVersion, pastedShared, refusalText, reviewText, sharedNote, updatesText } from '../sharedModules';
import { moduleCopy } from '../moduleCopy';
import { stopShareText, usedInText } from '../../modules/ModuleClubShares';

const placed = (o: Partial<SharedPlaced> = {}): SharedPlaced => ({
  placedId: 'p1', name: 'Harbor crane', moduleId: 'm', version: 7, by: 'Alice', server: null, placement: null, review: null, members: ['a', 'b'], ...o,
});
const row = (o: Partial<LayoutSharedModule> = {}): LayoutSharedModule => ({
  placedId: 'p1', moduleId: 'm', state: 'shared', version: 7, title: 'Harbor crane', owner: { kind: 'user', name: 'Alice' }, latest: 7, latestNote: null, hasPicture: false, ...o,
});

describe('a placed shared module, in words', () => {
  it('says who shared it, its version, and when a newer one is ready', () => {
    expect(sharedNote(placed(), row())).toBe('Shared by Alice · v7');
    expect(sharedNote(placed(), row({ latest: 8 }))).toBe('Shared by Alice · v7 · v8 is ready');
    // The owner's name now, when the server says; else the one the file kept.
    expect(sharedNote(placed(), row({ owner: { kind: 'user', name: 'Alice B' } }))).toBe('Shared by Alice B · v7');
    expect(sharedNote(placed(), undefined)).toBe('Shared by Alice · v7');
    expect(sharedNote(placed({ by: null, version: null }), undefined)).toBe('Shared');
  });

  it('says when it no longer follows its owner', () => {
    expect(sharedNote(placed(), row({ state: 'unshared', title: null, owner: null, latest: null }))).toBe('No longer shared · v7: no more updates');
    expect(sharedNote(placed(), row({ state: 'gone', title: null, owner: null, latest: null }))).toBe('Deleted by its owner · v7: no more updates');
  });

  it('finds the copies with a newer version, and only those still shared', () => {
    expect(newerVersion(placed(), row({ latest: 8 }))).toBe(8);
    expect(newerVersion(placed(), row({ latest: 7 }))).toBeNull();
    expect(newerVersion(placed({ version: null }), row({ latest: 3 }))).toBe(3);
    expect(newerVersion(placed(), row({ state: 'unshared', latest: 9 }))).toBeNull();
    expect(newerVersion(placed(), undefined)).toBeNull();
    const list = [placed(), placed({ placedId: 'p2', name: 'Tunnel', version: 3 }), placed({ placedId: 'p3', name: 'Depot' })];
    const rows = [row({ latest: 8 }), row({ placedId: 'p2', latest: 3 }), row({ placedId: 'p3', state: 'gone', latest: null })];
    expect(findSharedUpdates(list, rows).map((u) => [u.placed.placedId, u.latest])).toEqual([['p1', 8]]);
  });

  it('words the notices', () => {
    const one = findSharedUpdates([placed()], [row({ latest: 8, latestNote: 'longer pier' })]);
    expect(updatesText(one)).toBe('“Harbor crane” has a new version from Alice (v8): “longer pier”.');
    expect(updatesText(findSharedUpdates([placed()], [row({ latest: 8, owner: null })]))).toBe('“Harbor crane” has a new version (v8).');
    const three = [0, 1, 2].flatMap((i) => findSharedUpdates([placed({ placedId: `p${i}` })], [row({ placedId: `p${i}`, latest: 8 })]));
    expect(updatesText(three)).toBe('3 shared modules have new versions.');
    expect(reviewText(placed({ version: 8, review: { from: 7, to: 8, at: 1 } }))).toBe('“Harbor crane” is now version 8.');
  });
});

describe('where a shared module may go', () => {
  const check = (o: Partial<SharedPlaceCheck>): SharedPlaceCheck => ({
    moduleId: 'm', state: 'unshared', title: 'Harbor crane', moduleOwner: { kind: 'user', name: 'Alice', mine: false }, layoutOwner: { kind: 'org', name: 'Riverside LUG', mine: false }, ...o,
  });

  it('shared with you, not with the club whose layout this is', () => {
    const t = refusalText(check({}));
    expect(t.title).toBe('“Harbor crane” can’t go in this layout yet');
    expect(t.body).toBe('Alice shared “Harbor crane” with you, not with Riverside LUG. Ask Alice to share it with the club.');
    expect(t.ask).toContain('share your module “Harbor crane” with Riverside LUG');
  });

  it('shared with a club, not with you, for your own layout', () => {
    const t = refusalText(check({ layoutOwner: { kind: 'user', name: 'bob', mine: true } }));
    expect(t.body).toBe('Alice shared “Harbor crane” with a club you’re in, for the club’s layouts, not with you. Ask Alice to share it with you too.');
    expect(t.ask).toContain('with me as well');
  });

  it('someone else’s layout', () => {
    const t = refusalText(check({ layoutOwner: { kind: 'user', name: 'Dan', mine: false } }));
    expect(t.body).toBe('Alice shared “Harbor crane” with you, not with Dan. Ask Alice to share it with them.');
  });
});

describe('what the owner is told', () => {
  it('where it is used: counts and club names, never a layout’s name', () => {
    expect(usedInText({ layouts: 0, clubs: [], people: [], others: 0 })).toBeNull();
    expect(usedInText({ layouts: 4, clubs: [{ orgId: 'o', name: 'Riverside LUG', layouts: 3 }], people: [{ userId: 'u', name: 'Bob', layouts: 1 }], others: 0 })).toBe('Used in 4 layouts (Riverside LUG: 3, Bob: 1)');
    expect(usedInText({ layouts: 1, clubs: [], people: [], others: 1 })).toBe('Used in 1 layout (others: 1)');
  });

  it('what stopping a share leaves behind', () => {
    expect(stopShareText('Harbor crane', 'Riverside LUG', 3, 7)).toEqual({
      title: 'Stop sharing with Riverside LUG?',
      keeps: 'Its 3 layouts keep “Harbor crane” as it is now (version 7).',
      removes: 'They won’t get your updates anymore, and can’t place it again.',
    });
    expect(stopShareText('Harbor crane', 'Riverside LUG', 1, 0).keeps).toBe('Its layout keeps “Harbor crane” as it is now.');
    expect(stopShareText('Harbor crane', 'Riverside LUG', 0, 7).keeps).toContain('Nothing changes in any layout');
  });
});

describe('a shared module copied and pasted', () => {
  const LIB = '5f0c0c0e-5d0e-4c55-9a43-1f3a2c9f7d10';
  const original = {
    id: 'M', name: 'Harbor crane', members: ['a', 'b'], transform: [1, 0, 0, 0, 1, 0, 0, 0, 1], outlineColor: '#ff0000', pinned: true,
    libraryModuleId: LIB, libraryVersion: 7,
    shared: { by: 'Alice', server: 'https://example.org', placement: { degrees: 90, x: 10, y: 20, sheets: { Track: 'L1', Scenery: 'L2' } }, review: { from: 6, to: 7, at: 1 } },
  } as unknown as SidecarModule;

  it('the clipboard keeps its sheets by name, and a paste puts them on the sheets its parts went to, moved along', () => {
    const clip = forClipboard(original, (id) => ({ L1: 'Track', L2: 'Trees' })[id]) as SidecarModule & { shared: { placement: { sheets: Record<string, string> } } };
    expect(clip.shared.placement.sheets).toEqual({ Track: 'Track', Scenery: 'Trees' });
    const pasted = pastedShared(clip, ['x', 'y'], 5, -2, (name) => ({ Track: 'N1', Trees: 'N2' })[name]) as SidecarModule & { shared: Record<string, unknown> };
    expect(pasted).toMatchObject({ name: 'Harbor crane', members: ['x', 'y'], libraryModuleId: LIB, libraryVersion: 7, outlineColor: '#ff0000' });
    expect(pasted.id).not.toBe('M');
    expect(pasted.pinned).toBeUndefined();
    // Another shared placement: the owner's name and server, where it now sits; the review stays with the original.
    expect(pasted.shared).toEqual({ by: 'Alice', server: 'https://example.org', placement: { degrees: 90, x: 15, y: 18, sheets: { Track: 'N1', Scenery: 'N2' } } });
  });

  it('a plain copy of it follows nothing: no link, no lock', () => {
    const copy = moduleCopy(original, ['x', 'y']) as SidecarModule & { shared?: unknown };
    expect(copy.shared).toBeUndefined();
    expect(copy.libraryModuleId).toBeUndefined();
    expect(copy.name).toBe('Harbor crane (copy)');
  });
});
