// The editor's Map menu as data (ui/menu/menuModel.ts draws it). Grouped
// like the desktop's menu bar: File ▸ (open a file, download), the layout
// itself, then Insert ▸, Modules & sets ▸, Venue ▸ (desktop Map ▸ Venue), View ▸,
// Budget ▸, Download & export ▸ and Preferences.
//
// The module editor has no venue, budget or layout download: those are
// hidden by predicate, and resolveMenu keeps the separators tidy.

import type { MenuEntry } from '../ui/menu/menuModel';

export interface MapMenuContext {
  /** Editing a module, not a layout. */
  moduleMode: boolean;
}

export interface MapMenuActions {
  /** Open a file as a new layout (open/FileOpener.tsx). */
  openFile: () => void;
  generalInfo: () => void;
  backgroundColor: () => void;
  backgroundImage: () => void;
  find: () => void;
  insertText: () => void;
  insertLabel: () => void;
  /** Make a module from the picked parts (saving one to the library is in its ⋯ menu). */
  createModule: () => void;
  saveAsSet: () => void;
  importBbm: () => void;
  venueDesigner: () => void;
  venueDrawOutline: () => void;
  venueDrawObstacle: () => void;
  venueDimensions: () => void;
  venueProps: () => void;
  venueSaveToLibrary: () => void;
  venueExportFile: () => void;
  venueLoadFromFile: () => void;
  venueClear: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  budget: () => void;
  downloadLayout: () => void;
  downloadAs: () => void;
  exportImage: () => void;
  exportCsv: () => void;
  preferences: () => void;
}

/** A View ▸ or Budget ▸ tick: its state and how to change it. */
export interface Toggle {
  on: boolean;
  set: (on: boolean) => void;
}

export interface MapMenuToggles {
  grid: Toggle;
  connectionPoints: Toggle;
  brickHulls: Toggle;
  brickElevation: Toggle;
  rulerAttachPoints: Toggle;
  alwaysShowConnections: Toggle;
  moduleNames: Toggle;
  electricCircuits: Toggle;
  statusBar: Toggle;
  budgetLimit: Toggle;
  budgetOnly: Toggle;
  budgetNumbers: Toggle;
}

const notInModule = (c: MapMenuContext) => c.moduleMode;

function check(id: string, label: string, t: Toggle): MenuEntry<MapMenuContext> {
  return { kind: 'check', id, label, checked: t.on, onToggle: t.set };
}

/** Ctrl on Windows / Linux, ⌘ on a Mac: what the shortcut hint says. */
export function modKey(platform: string = typeof navigator === 'undefined' ? '' : navigator.platform): string {
  return /Mac|iPhone|iPad/.test(platform) ? '⌘' : 'Ctrl';
}

/** Alt on Windows / Linux, Option on a Mac. */
export function altKey(platform: string = typeof navigator === 'undefined' ? '' : navigator.platform): string {
  return /Mac|iPhone|iPad/.test(platform) ? 'Option' : 'Alt';
}

export function mapMenuEntries(a: MapMenuActions, t: MapMenuToggles, mod = modKey()): MenuEntry<MapMenuContext>[] {
  const sep: MenuEntry<MapMenuContext> = { kind: 'separator' };
  return [
    {
      kind: 'submenu', id: 'file', label: 'File', items: [
        { kind: 'item', id: 'open-file', label: 'Open a file…', onSelect: a.openFile },
        { kind: 'item', id: 'file-download-as', label: 'Download as…', onSelect: a.downloadAs },
      ],
    },
    sep,
    { kind: 'item', id: 'general-info', label: 'General info…', onSelect: a.generalInfo },
    { kind: 'item', id: 'background-color', label: 'Background color…', onSelect: a.backgroundColor },
    { kind: 'item', id: 'background-image', label: 'Background image…', onSelect: a.backgroundImage },
    { kind: 'item', id: 'find', label: 'Find…', shortcut: `${mod}+F`, onSelect: a.find },
    sep,
    {
      kind: 'submenu', id: 'insert', label: 'Insert', items: [
        // Plain T: the browser keeps Ctrl+T (a new tab) for itself.
        { kind: 'item', id: 'insert-text', label: 'Text…', shortcut: 'T', onSelect: a.insertText },
        { kind: 'item', id: 'insert-label', label: 'Anchored label…', shortcut: `${mod}+L`, onSelect: a.insertLabel },
      ],
    },
    {
      kind: 'submenu', id: 'modules', label: 'Modules & sets', items: [
        { kind: 'item', id: 'make-module', label: 'Make a module…', onSelect: a.createModule },
        { kind: 'item', id: 'save-set', label: 'Save selection as set…', onSelect: a.saveAsSet },
        { kind: 'item', id: 'import-bbm', label: 'Import .bbm as module…', onSelect: a.importBbm },
      ],
    },
    {
      kind: 'submenu', id: 'venue', label: 'Venue', hidden: notInModule, items: [
        { kind: 'item', id: 'venue-designer', label: 'Open venue designer…', onSelect: a.venueDesigner },
        sep,
        { kind: 'item', id: 'venue-outline', label: 'Draw outline…', onSelect: a.venueDrawOutline },
        { kind: 'item', id: 'venue-dimensions', label: 'Draw outline by dimensions…', onSelect: a.venueDimensions },
        { kind: 'item', id: 'venue-obstacle', label: 'Add obstacle…', onSelect: a.venueDrawObstacle },
        sep,
        { kind: 'item', id: 'venue-props', label: 'Edit venue properties…', onSelect: a.venueProps },
        { kind: 'item', id: 'venue-save-library', label: 'Save to venue library…', onSelect: a.venueSaveToLibrary },
        { kind: 'item', id: 'venue-export', label: 'Export venue as file…', onSelect: a.venueExportFile },
        { kind: 'item', id: 'venue-load', label: 'Load venue from file…', onSelect: a.venueLoadFromFile },
        sep,
        { kind: 'item', id: 'venue-clear', label: 'Clear venue…', onSelect: a.venueClear },
      ],
    },
    {
      kind: 'submenu', id: 'view', label: 'View', items: [
        { kind: 'item', id: 'zoom-in', label: 'Zoom in', shortcut: `${mod}+=`, onSelect: a.zoomIn },
        { kind: 'item', id: 'zoom-out', label: 'Zoom out', shortcut: `${mod}+-`, onSelect: a.zoomOut },
        { kind: 'item', id: 'fit', label: 'Fit to view', shortcut: 'F', onSelect: a.fit },
        sep,
        check('show-grid', 'Grid', t.grid),
        check('show-connection-points', 'Connection points', t.connectionPoints),
        check('always-show-connections', 'Always show connections', t.alwaysShowConnections),
        check('show-electric', 'Electric circuits', t.electricCircuits),
        check('show-ruler-points', 'Ruler attach points', t.rulerAttachPoints),
        check('show-hulls', 'Brick hulls', t.brickHulls),
        check('show-elevation', 'Brick elevation labels', t.brickElevation),
        check('show-module-names', 'Module names', t.moduleNames),
        check('show-status-bar', 'Status bar', t.statusBar),
      ],
    },
    {
      kind: 'submenu', id: 'budget', label: 'Budget', hidden: notInModule, items: [
        { kind: 'item', id: 'edit-budget', label: 'Edit budget…', onSelect: a.budget },
        sep,
        check('budget-limit', 'Stop at the budget limits', t.budgetLimit),
        check('budget-only', 'Show only parts in the budget', t.budgetOnly),
        check('budget-numbers', 'Show budget numbers', t.budgetNumbers),
      ],
    },
    {
      kind: 'submenu', id: 'export', label: 'Download & export', items: [
        { kind: 'item', id: 'download-layout', label: 'Download layout (.bld-layout)', hidden: notInModule, onSelect: a.downloadLayout },
        { kind: 'item', id: 'download-as', label: 'Download as…', onSelect: a.downloadAs },
        sep,
        { kind: 'item', id: 'export-image', label: 'Export as image…', onSelect: a.exportImage },
        { kind: 'item', id: 'export-part-list', label: 'Export part list…', onSelect: a.exportCsv },
      ],
    },
    sep,
    { kind: 'item', id: 'preferences', label: 'Preferences…', shortcut: `${mod}+,`, onSelect: a.preferences },
  ];
}

/** What a phone's Map menu does: the Map menu's actions that work by touch. */
export type PhoneMapActions = Pick<
  MapMenuActions,
  | 'openFile'
  | 'generalInfo'
  | 'backgroundColor'
  | 'backgroundImage'
  | 'find'
  | 'insertText'
  | 'insertLabel'
  | 'saveAsSet'
  | 'importBbm'
  | 'venueDesigner'
  | 'venueDimensions'
  | 'venueProps'
  | 'venueSaveToLibrary'
  | 'venueExportFile'
  | 'venueLoadFromFile'
  | 'venueClear'
  | 'fit'
  | 'budget'
  | 'downloadLayout'
  | 'downloadAs'
  | 'exportImage'
  | 'exportCsv'
  | 'preferences'
>;

/** A phone has no status bar to show or hide. */
export type PhoneMapToggles = Omit<MapMenuToggles, 'statusBar'>;

/**
 * The phone's Map menu (from the layout-name menu), in the Map menu's own
 * words. It leaves out what has another way in by touch: drawing the venue's
 * outline and obstacles on the map (the venue designer draws them by
 * touch), Make a module (the touch bar's Module button), zooming by steps
 * (pinch, and the zoom buttons) and the status bar (a phone has none).
 * What changes the layout shows only while editing (`editing`).
 */
export function phoneMapEntries(a: PhoneMapActions, t: PhoneMapToggles, editing: boolean): MenuEntry<MapMenuContext>[] {
  const viewing = () => !editing;
  const sep: MenuEntry<MapMenuContext> = { kind: 'separator' };
  return [
    { kind: 'item', id: 'open-file', label: 'Open a file…', onSelect: a.openFile },
    sep,
    { kind: 'item', id: 'general-info', label: 'General info…', hidden: viewing, onSelect: a.generalInfo },
    { kind: 'item', id: 'background-color', label: 'Background color…', hidden: viewing, onSelect: a.backgroundColor },
    { kind: 'item', id: 'background-image', label: 'Background image…', hidden: viewing, onSelect: a.backgroundImage },
    { kind: 'item', id: 'find', label: 'Find…', onSelect: a.find },
    sep,
    {
      kind: 'submenu', id: 'insert', label: 'Insert', hidden: viewing, items: [
        { kind: 'item', id: 'insert-text', label: 'Text…', onSelect: a.insertText },
        { kind: 'item', id: 'insert-label', label: 'Anchored label…', onSelect: a.insertLabel },
      ],
    },
    {
      kind: 'submenu', id: 'modules', label: 'Modules & sets', hidden: viewing, items: [
        { kind: 'item', id: 'save-set', label: 'Save selection as set…', onSelect: a.saveAsSet },
        { kind: 'item', id: 'import-bbm', label: 'Import .bbm as module…', onSelect: a.importBbm },
      ],
    },
    {
      kind: 'submenu', id: 'venue', label: 'Venue', hidden: (c) => viewing() || c.moduleMode, items: [
        { kind: 'item', id: 'venue-designer', label: 'Open venue designer…', onSelect: a.venueDesigner },
        { kind: 'item', id: 'venue-dimensions', label: 'Draw outline by dimensions…', onSelect: a.venueDimensions },
        sep,
        { kind: 'item', id: 'venue-props', label: 'Edit venue properties…', onSelect: a.venueProps },
        { kind: 'item', id: 'venue-save-library', label: 'Save to venue library…', onSelect: a.venueSaveToLibrary },
        { kind: 'item', id: 'venue-export', label: 'Export venue as file…', onSelect: a.venueExportFile },
        { kind: 'item', id: 'venue-load', label: 'Load venue from file…', onSelect: a.venueLoadFromFile },
        sep,
        { kind: 'item', id: 'venue-clear', label: 'Clear venue…', onSelect: a.venueClear },
      ],
    },
    {
      kind: 'submenu', id: 'view', label: 'View', items: [
        { kind: 'item', id: 'fit', label: 'Fit to view', onSelect: a.fit },
        sep,
        check('show-grid', 'Grid', t.grid),
        check('show-connection-points', 'Connection points', t.connectionPoints),
        check('always-show-connections', 'Always show connections', t.alwaysShowConnections),
        check('show-electric', 'Electric circuits', t.electricCircuits),
        check('show-ruler-points', 'Ruler attach points', t.rulerAttachPoints),
        check('show-hulls', 'Brick hulls', t.brickHulls),
        check('show-elevation', 'Brick elevation labels', t.brickElevation),
        check('show-module-names', 'Module names', t.moduleNames),
      ],
    },
    {
      kind: 'submenu', id: 'budget', label: 'Budget', hidden: notInModule, items: [
        { kind: 'item', id: 'edit-budget', label: 'Edit budget…', hidden: viewing, onSelect: a.budget },
        sep,
        check('budget-limit', 'Stop at the budget limits', t.budgetLimit),
        check('budget-only', 'Show only parts in the budget', t.budgetOnly),
        check('budget-numbers', 'Show budget numbers', t.budgetNumbers),
      ],
    },
    {
      kind: 'submenu', id: 'export', label: 'Download & export', items: [
        { kind: 'item', id: 'download-layout', label: 'Download layout (.bld-layout)', hidden: notInModule, onSelect: a.downloadLayout },
        { kind: 'item', id: 'download-as', label: 'Download as…', onSelect: a.downloadAs },
        { kind: 'item', id: 'export-image', label: 'Export as image…', onSelect: a.exportImage },
        { kind: 'item', id: 'export-part-list', label: 'Export part list…', onSelect: a.exportCsv },
      ],
    },
    sep,
    { kind: 'item', id: 'preferences', label: 'Preferences…', onSelect: a.preferences },
  ];
}
