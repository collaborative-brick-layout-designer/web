// Which sheet new parts go on, and how to name a sheet's kind, shared by
// the "Adding to" control, the Sheets panel, the Parts panel title and
// the drag tag, so they always agree.

import type { Layer } from '@cld/model';

/** The small mark for each kind of sheet (the Sheets panel's rows). */
export const SHEET_GLYPH: Record<Layer['type'], string> = {
  grid: '#',
  brick: '▮',
  text: 'T',
  area: '▦',
  ruler: '─',
};

/** A sheet's kind in plain words: "a text sheet". */
export const SHEET_KIND: Record<Layer['type'], string> = {
  grid: 'grid',
  brick: 'parts',
  text: 'text',
  area: 'area',
  ruler: 'ruler',
};

/**
 * A sheet's name as shown. BlueBrick names new layers "Layer 1", "Layer 2"…;
 * this app says "sheet", so an untouched default shows as "Sheet 1". The
 * file keeps "Layer 1" (a .bbm export is byte for byte what was read), and
 * a name someone typed is shown as typed.
 */
export function displaySheetName(name: string): string {
  const m = /^Layer (\d+)$/.exec(name);
  return m ? `Sheet ${m[1]}` : name;
}

/** The new name to save from a rename box, or null when nothing changed (the shown default kept). */
export function renamedSheet(current: string, typed: string): string | null {
  const next = typed.trim();
  if (!next || next === current || next === displaySheetName(current)) return null;
  return next;
}

/** What a sheet with no name is called: its kind ("Grid"), not "(untitled)". */
export const UNNAMED_SHEET: Record<Layer['type'], string> = {
  grid: 'Grid',
  brick: 'Parts',
  text: 'Text',
  area: 'Area',
  ruler: 'Rulers',
};

export function sheetName(layer: (Pick<Layer, 'name'> & Partial<Pick<Layer, 'type'>>) | undefined | null): string {
  if (layer?.name) return displaySheetName(layer.name);
  return layer?.type ? UNNAMED_SHEET[layer.type] : 'unnamed';
}

type SheetLike = Pick<Layer, 'id' | 'type' | 'name' | 'visible'>;

export interface PlacementTarget<L extends SheetLike> {
  /** The sheet picked in the Sheets panel. */
  active: L | undefined;
  /**
   * Where a placed part goes: the active sheet when it holds parts, else
   * the first parts sheet (the editor's resolveBrickLayerForPlacement).
   * Undefined when there is no parts sheet yet (placing makes one).
   */
  target: L | undefined;
  /** The active sheet can't hold parts, so they go somewhere else. */
  redirected: boolean;
}

export function placementTarget<L extends SheetLike>(layers: readonly L[], activeLayerId: string | null): PlacementTarget<L> {
  const active = activeLayerId ? layers.find((l) => l.id === activeLayerId) : undefined;
  if (active?.type === 'brick') return { active, target: active, redirected: false };
  return { active, target: layers.find((l) => l.type === 'brick'), redirected: active !== undefined };
}

/**
 * The sheet a layout opens on, the same rule as the desktop app: the sheet
 * the file saved as selected when it holds parts, else the topmost parts
 * sheet (layers run bottom to top). Null when there is no parts sheet.
 */
export function startingSheetId<L extends Pick<Layer, 'id' | 'type'>>(layers: readonly L[], selectedLayerIndex: number | null | undefined): string | null {
  const saved = selectedLayerIndex != null ? layers[selectedLayerIndex] : undefined;
  if (saved?.type === 'brick') return saved.id;
  for (let i = layers.length - 1; i >= 0; i--) if (layers[i]!.type === 'brick') return layers[i]!.id;
  return null;
}
