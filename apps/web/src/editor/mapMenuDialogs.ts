// The Map menu's dialogs, read from the menu itself (mapMenu.ts), so the
// accessibility and phone-dialog tests cover every one, and a new entry
// can't be forgotten: an entry is a dialog unless it's listed below with
// why it isn't (a file picker, a drawing tool, a download).

import { mapMenuEntries, type MapMenuActions, type MapMenuToggles } from './mapMenu';
import { resolveMenu, type ResolvedEntry } from '../ui/menu/menuModel';

/** Map menu entries that open no dialog of their own, and what they do instead. */
export const MAP_MENU_NOT_DIALOGS: Readonly<Record<string, string>> = {
  'open-file': 'the browser’s file picker',
  'file-download-as': 'the same dialog as Download & export › Download as…',
  'make-module': 'needs parts picked first',
  'save-set': 'needs parts picked first',
  'venue-designer': 'the venue designer page',
  'venue-outline': 'a drawing tool on the map',
  'venue-obstacle': 'a drawing tool on the map',
  'venue-save-library': 'needs a venue first',
  'venue-export': 'a download',
  'venue-load': 'the browser’s file picker',
  'venue-clear': 'needs a venue first',
  'zoom-in': 'the view',
  'zoom-out': 'the view',
  fit: 'the view',
  'download-layout': 'a download',
};

const noop = () => {};
const toggle = { on: false, set: noop };

/** Every Map menu entry, as the labels to click from the Map button, with its id. */
export function mapMenuItemPaths(moduleMode = false): { id: string; path: string[] }[] {
  const actions = new Proxy({}, { get: () => noop }) as MapMenuActions;
  const toggles = new Proxy({}, { get: () => toggle }) as MapMenuToggles;
  const out: { id: string; path: string[] }[] = [];
  const walk = (entries: readonly ResolvedEntry[], at: string[]) => {
    for (const e of entries) {
      if (e.kind === 'item') out.push({ id: e.id, path: [...at, e.label] });
      else if (e.kind === 'submenu') walk(e.items, [...at, e.label]);
    }
  };
  walk(resolveMenu(mapMenuEntries(actions, toggles, 'Ctrl'), { moduleMode }), []);
  return out;
}

/** The Map menu entries that open a dialog: the label path to each. */
export function mapMenuDialogPaths(moduleMode = false): string[][] {
  return mapMenuItemPaths(moduleMode)
    .filter((e) => !(e.id in MAP_MENU_NOT_DIALOGS))
    .map((e) => e.path);
}
