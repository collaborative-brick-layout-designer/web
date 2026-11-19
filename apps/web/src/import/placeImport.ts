// Put an imported model's parts down in the open layout, as the editor's own
// change (docs/model-import.md, "Into the open layout"). The server made the
// part (or read the .bbm) and answered with `toPlace`; this puts it on the
// sheet, centred on `at`, in ONE transaction with the editor's origin, so it
// is one Undo step (and Redo brings it back), and the editor's sync shows it
// to everyone in the layout at once. The same path as Import .bbm as module
// (mutations.ts insertBricks, with the sets copied by cloneGroups).

import * as Y from 'yjs';
import { makeId } from '@cld/ydoc';
import { insertBricks } from '../editor/mutations';
import { cloneGroups } from '../editor/sets';
import { LOCAL_ORIGIN } from '../editor/useLayoutDoc';
import type { ImportResult, ToPlace } from './importApi';

/** The parts sheet to use: the one asked for while it's still there, else the first. */
export function partsSheetFor(doc: Y.Doc, wanted: string | null | undefined): string | null {
  const data = doc.getMap('layerData');
  const ids = doc.getArray<string>('layers').toArray();
  const isBrick = (id: string) => {
    const l = data.get(id);
    return l instanceof Y.Map && l.get('type') === 'brick';
  };
  if (wanted && ids.includes(wanted) && isBrick(wanted)) return wanted;
  return ids.find(isBrick) ?? null;
}

/** A saved part's one brick (the server's `toPlace` in part mode), from the result. */
export function partToPlace(result: Pick<ImportResult, 'part' | 'widthStuds' | 'heightStuds'>): ToPlace | null {
  if (!result.part || !result.widthStuds || !result.heightStuds) return null;
  const w = result.widthStuds;
  const h = result.heightStuds;
  return { bricks: [{ partNumber: `custom:${result.part.id}`, displayArea: { x: -w / 2, y: -h / 2, width: w, height: h }, orientation: 0 }], groups: [] };
}

/**
 * Put `toPlace` on `sheetId` (or the first parts sheet), its middle on `at`.
 * Returns the new parts' ids and the sheet used; none when there's no parts sheet.
 */
export function placeImported(doc: Y.Doc, sheetId: string | null | undefined, at: { x: number; y: number }, toPlace: ToPlace): { sheetId: string | null; ids: string[] } {
  const sheet = partsSheetFor(doc, sheetId);
  if (!sheet || toPlace.bricks.length === 0) return { sheetId: sheet, ids: [] };
  let sx = 0;
  let sy = 0;
  for (const b of toPlace.bricks) {
    sx += b.displayArea.x + b.displayArea.width / 2;
    sy += b.displayArea.y + b.displayArea.height / 2;
  }
  const n = toPlace.bricks.length;
  const offset = { dx: at.x - sx / n, dy: at.y - sy / n };
  // New ids for the sets, so a second import of the same model is its own sets.
  const copied = cloneGroups(toPlace.groups, toPlace.bricks, makeId);
  let ids: string[] = [];
  doc.transact(() => {
    ids = insertBricks(doc, sheet, copied.bricks, offset, copied.groups);
  }, LOCAL_ORIGIN);
  return { sheetId: sheet, ids };
}
