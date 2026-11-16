// A module's contents as insert batches: one per sheet, in the module's
// own coordinates (desktop `LayerBatch`).

import * as Y from 'yjs';
import type { BbmMap, Group, RectangleF } from '@cld/model';
import { docToBbm } from '@cld/ydoc';

export interface BatchBrick {
  partNumber: string;
  displayArea: RectangleF;
  orientation?: number;
  altitude?: number;
  myGroup?: string;
}

/** One source brick layer of a module. */
export interface ModuleBatch {
  layerName: string;
  bricks: BatchBrick[];
  /** The source layer's groups: the sets in the module stay sets. */
  groups?: Group[];
}

/**
 * One batch per non-empty brick layer of a module, named after the source
 * layer ("Module" when unnamed), in file order.
 */
export function moduleBatchesFromMap(map: BbmMap): ModuleBatch[] {
  const out: ModuleBatch[] = [];
  for (const l of map.layers) {
    if (l.type !== 'brick' || l.bricks.length === 0) continue;
    out.push({
      layerName: l.name || 'Module',
      bricks: l.bricks.map((b) => ({
        partNumber: b.partNumber,
        displayArea: { ...b.displayArea },
        orientation: b.orientation,
        altitude: b.altitude,
        myGroup: b.myGroup,
      })),
      // Its sets stay sets (they're copied under new ids when it's placed).
      groups: l.groups,
    });
  }
  return out;
}

/** A library module's stored contents (a Yjs update) as batches. Throws when they can't be read. */
export function moduleBatchesFromBytes(bytes: Uint8Array): ModuleBatch[] {
  const d = new Y.Doc();
  try {
    Y.applyUpdate(d, bytes);
    return moduleBatchesFromMap(docToBbm(d));
  } finally {
    d.destroy();
  }
}

/** A sheet name as sheets are matched by: without case, or spaces at either end. */
export function sheetKey(name: string): string {
  return name.trim().toLowerCase();
}
