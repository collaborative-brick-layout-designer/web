// The Map menu's dialog list (for the a11y and phone-dialog tests) comes
// from the menu itself: every entry is a dialog or says why it isn't.

import { describe, expect, it } from 'vitest';
import { MAP_MENU_NOT_DIALOGS, mapMenuDialogPaths, mapMenuItemPaths } from '../mapMenuDialogs';

describe('Map menu dialogs', () => {
  it('lists only entries that exist', () => {
    const ids = new Set(mapMenuItemPaths().map((e) => e.id));
    expect(Object.keys(MAP_MENU_NOT_DIALOGS).filter((id) => !ids.has(id))).toEqual([]);
  });

  it('covers the dialogs the review found unlabeled, and the rest of the menu', () => {
    const paths = mapMenuDialogPaths().map((p) => p.join(' › '));
    for (const p of [
      'General info…',
      'Background color…',
      'Background image…',
      'Insert › Text…',
      'Insert › Anchored label…',
      'Venue › Draw outline by dimensions…',
      'Budget › Edit budget…',
      'Download & export › Export as image…',
      'Preferences…',
    ]) expect(paths).toContain(p);
    expect(paths).not.toContain('File › Open a file…');
  });

  it('leaves out what a module has no use for', () => {
    expect(mapMenuDialogPaths(true).some((p) => p[0] === 'Venue' || p[0] === 'Budget')).toBe(false);
  });
});
