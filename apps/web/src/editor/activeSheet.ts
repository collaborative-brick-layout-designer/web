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

export function sheetName(layer: Pick<Layer, 'name'> | undefined | null): string {
  return layer?.name || 'unnamed';
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
