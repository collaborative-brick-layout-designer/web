// Plain words for what a sheet holds and what each kind of sheet is for,
// shared by the Sheets panel and the touch Sheets list (and their delete
// questions, which say what goes with the sheet).

import type { Layer } from '@cld/model';
import type { LayerKind } from './mutations';
import type { DeleteWording } from '../ui/ConfirmDialog';
import { displaySheetName } from './activeSheet';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "12 parts", "3 texts", "nothing", or "the grid lines" for a grid sheet. */
export function sheetContents(layer: Layer): string {
  switch (layer.type) {
    case 'brick':
      return layer.bricks.length ? plural(layer.bricks.length, 'part', 'parts') : 'nothing';
    case 'text':
      return layer.textCells.length ? plural(layer.textCells.length, 'text', 'texts') : 'nothing';
    case 'area':
      return layer.areas.length ? plural(layer.areas.length, 'painted square', 'painted squares') : 'nothing';
    case 'ruler':
      return layer.rulerItems.length ? plural(layer.rulerItems.length, 'ruler', 'rulers') : 'nothing';
    case 'grid':
      return 'the grid lines';
  }
}

/** The delete question for a sheet: its name, and what leaves with it. */
export function deleteSheetWording(layer: Layer, undoHow: string): DeleteWording {
  const what = sheetContents(layer);
  return {
    title: `Delete the sheet “${layer.name ? displaySheetName(layer.name) : 'untitled'}”?`,
    removes:
      what === 'nothing'
        ? 'The sheet is empty, so only the sheet itself goes.'
        : `The sheet goes, along with ${what} on it.`,
    keeps: 'The other sheets don’t change.',
    undoable: undoHow,
  };
}

/** The kinds of sheet that can be added (the desktop's five, LayerPanel.cpp:85-89), most used first, with what each is for. */
export const SHEET_KINDS: { kind: LayerKind; label: string; about: string }[] = [
  { kind: 'brick', label: 'Parts sheet', about: 'Track, bricks and other parts' },
  { kind: 'text', label: 'Text sheet', about: 'Words on the map' },
  { kind: 'area', label: 'Area sheet', about: 'Painted squares of color, like grass or water' },
  { kind: 'ruler', label: 'Ruler sheet', about: 'Measurements' },
  { kind: 'grid', label: 'Grid sheet', about: 'Lines to line things up' },
];
