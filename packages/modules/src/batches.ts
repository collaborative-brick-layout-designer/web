// A module's contents as insert batches: one per sheet, in the module's
// own coordinates (desktop `LayerBatch`).

import * as Y from 'yjs';
import type { BbmMap, Group, RectangleF } from '@cld/model';
import { modulePlaces, readPlaces, renamePlaceBricks, type Place } from '@cld/bbm';
import { docToBbm, readPlacesFromDoc, readSidecarCache } from '@cld/ydoc';

export interface BatchBrick {
  /** Its id in the module's own contents (what the module's places name it by). */
  id?: string;
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
  /** On the first batch: the module's places (Live Ops design 2.1), naming parts by their id in the module. */
  places?: Place[];
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
        id: b.id,
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

/** A module's document as batches, its places on the first. */
export function moduleBatchesFromDoc(doc: Y.Doc): ModuleBatch[] {
  const out = moduleBatchesFromMap(docToBbm(doc));
  const places = docPlaces(doc);
  if (out[0] && places.length > 0) out[0].places = places;
  return out;
}

/** A module document's places: its own, and those of the modules placed in it. */
export function docPlaces(doc: Y.Doc): Place[] {
  const modules = readSidecarCache(doc)?.modules;
  const inner = Array.isArray(modules) ? modules.flatMap((m) => (m && typeof m === 'object' ? modulePlaces(m as object) : [])) : [];
  return readPlaces([...readPlacesFromDoc(doc), ...inner]);
}

/** The places the batches carry. */
export function batchPlaces(batches: readonly ModuleBatch[]): Place[] {
  return batches.flatMap((b) => b.places ?? []);
}

/**
 * The batches' places for the layout: each part's id in the module is its
 * new one, `ids` being the new parts in the batches' order.
 */
export function placesOn(batches: readonly ModuleBatch[], ids: readonly string[]): Place[] {
  const places = batchPlaces(batches);
  if (places.length === 0) return [];
  const to = new Map<string, string>();
  batches.flatMap((b) => b.bricks).forEach((b, i) => {
    if (b.id !== undefined && ids[i] !== undefined) to.set(b.id, ids[i]);
  });
  return renamePlaceBricks(places, (id) => to.get(id) ?? null);
}

/** A library module's stored contents (a Yjs update) as batches. Throws when they can't be read. */
export function moduleBatchesFromBytes(bytes: Uint8Array): ModuleBatch[] {
  const d = new Y.Doc();
  try {
    Y.applyUpdate(d, bytes);
    return moduleBatchesFromDoc(d);
  } finally {
    d.destroy();
  }
}

/** A sheet name as sheets are matched by: without case, or spaces at either end. */
export function sheetKey(name: string): string {
  return name.trim().toLowerCase();
}
