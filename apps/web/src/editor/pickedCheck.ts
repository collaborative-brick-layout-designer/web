// Whether the picked parts are still on the map, after each change, without
// going through every part of the doc (it did, after every change: about
// 7 ms on 7,520 parts at 4x slowed CPU, in the mover's own drop).

import * as Y from 'yjs';
import { getDocProjector } from './useDocMap';
import { brickIdsInDoc, stillPicked } from './mixedSelection';

/** How many times the check went through every part of the doc (for tests). */
export const pickedCheckStats = { wholeLooks: 0 };

/** Whether a part's Y.Map is in the doc: neither it, nor its sheet's list, nor its sheet deleted. */
function inDoc(y: Y.Map<unknown>, id: string): boolean {
  if (y.get('id') !== id) return false;
  type T = { _item: { deleted: boolean; parent: unknown } | null };
  for (let t: T | null = y as unknown as T; t; t = (t._item?.parent as T | undefined) ?? null) {
    if (t._item?.deleted) return false;
  }
  return !!y.doc;
}

/**
 * A check for `doc`: given the selection, the parts of it still in the doc,
 * or null when they all are (as `stillPicked(brickIdsInDoc(doc), selection)`).
 * Each picked part's Y.Map is remembered and asked directly; a part not
 * known yet is found through the doc's shared projection. Only when a
 * picked part isn't found that way (it went, or the projection is behind)
 * does it go through the doc itself, which is never behind a pick.
 */
export function pickedChecker(doc: Y.Doc): (selection: readonly string[]) => string[] | null {
  const known = new Map<string, Y.Map<unknown>>();
  return (selection) => {
    if (selection.length === 0) return null;
    let unknown: Set<string> | null = null;
    for (const id of selection) {
      const y = known.get(id);
      if (y && inDoc(y, id)) continue;
      known.delete(id);
      (unknown ??= new Set()).add(id);
    }
    if (!unknown) return null;
    // From the projection: a plain look at its parts' ids.
    try {
      const projector = getDocProjector(doc);
      const map = projector.project();
      for (const layer of map.layers) {
        if (layer.type !== 'brick') continue;
        for (const b of layer.bricks) {
          if (!unknown.has(b.id)) continue;
          const y = projector.brickYMap(b);
          if (y && inDoc(y, b.id)) {
            known.set(b.id, y);
            unknown.delete(b.id);
          }
        }
      }
    } catch {
      // (An incomplete doc: the look through the doc below.)
    }
    if (unknown.size === 0) return null;
    pickedCheckStats.wholeLooks++;
    return stillPicked(brickIdsInDoc(doc), selection);
  };
}
