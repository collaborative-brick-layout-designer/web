// Helpers for the shared-module tests: a library module's contents, and a
// layout document with a module placed in it the way the apps place one.

import * as Y from 'yjs';
import type { Place, SidecarModule } from '@cld/bbm';
import { createDefaultLayoutDoc, encodeDoc, readSidecarCache, writePlace, writeSidecarCache } from '@cld/ydoc';
import { appendBricks, moduleBatchesFromBytes, placeVersion, type Placement } from '@cld/modules';

export interface Part {
  pn: string;
  x: number;
  y: number;
}

/** The default layout's one parts sheet. */
export const SHEET = 'brick-1';

/** A library module's contents: 2 x 2 stud parts at (x, y) on a sheet named "Layout", and the places `places` names on them. */
export function contents(parts: readonly Part[], places?: (ids: readonly string[]) => Place[]): Buffer {
  const doc = createDefaultLayoutDoc();
  doc.transact(() => {
    const ids = appendBricks(doc, SHEET, parts.map((p) => ({ partNumber: p.pn, displayArea: { x: p.x, y: p.y, width: 2, height: 2 } })));
    for (const p of places?.(ids) ?? []) writePlace(doc, p);
  });
  const bytes = Buffer.from(encodeDoc(doc));
  doc.destroy();
  return bytes;
}

/** No part is in any catalog here: each keeps its box and turns about its middle. */
export const noParts = () => undefined;

/**
 * Place a library version in `doc` as the apps do: its parts where
 * `placement` puts them, and a module that follows `moduleId` at
 * `version`. `shared: false` makes an ordinary linked module. Returns the
 * placed module's id and its part ids.
 */
export function place(
  doc: Y.Doc,
  o: { placedId: string; moduleId: string; version: number; bytes: Uint8Array; placement: Placement; by?: string; shared?: boolean; name?: string },
): string[] {
  let ids: string[] = [];
  doc.transact(() => {
    const placed = placeVersion(moduleBatchesFromBytes(o.bytes), o.placement, noParts);
    ids = placed.flatMap((b) => appendBricks(doc, SHEET, b.bricks));
    const cache = readSidecarCache(doc) ?? { schemaVersion: 1, bbmHashSha256: '' };
    const mod: SidecarModule = {
      id: o.placedId,
      name: o.name ?? 'Harbor crane',
      members: ids,
      transform: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      libraryModuleId: o.moduleId,
      libraryVersion: o.version,
      ...(o.shared === false ? {} : { shared: { by: o.by ?? 'alice', placement: { ...o.placement, sheets: { Layout: SHEET } } } }),
    };
    writeSidecarCache(doc, { ...cache, modules: [...(Array.isArray(cache.modules) ? (cache.modules as SidecarModule[]) : []), mod] });
  });
  return ids;
}

/** Every part on the map: its number, where it is, and its id. */
export function partsOf(doc: Y.Doc): { id: string; pn: string; x: number; y: number }[] {
  const out: { id: string; pn: string; x: number; y: number }[] = [];
  for (const layer of doc.getMap<unknown>('layerData').values()) {
    if (!(layer instanceof Y.Map)) continue;
    const bricks = layer.get('bricks');
    if (!(bricks instanceof Y.Array)) continue;
    for (const b of bricks) {
      if (!(b instanceof Y.Map)) continue;
      const a = b.get('displayArea') as { x: number; y: number };
      out.push({ id: b.get('id') as string, pn: b.get('partNumber') as string, x: Math.round(a.x * 1000) / 1000, y: Math.round(a.y * 1000) / 1000 });
    }
  }
  return out.sort((p, q) => (p.pn < q.pn ? -1 : p.pn > q.pn ? 1 : p.x - q.x || p.y - q.y));
}

/** The placed module's sidecar value. */
export function moduleOf(doc: Y.Doc, placedId: string): (SidecarModule & { shared?: Record<string, unknown>; basedOn?: Record<string, unknown> }) | undefined {
  const cache = readSidecarCache(doc);
  return (Array.isArray(cache?.modules) ? (cache.modules as SidecarModule[]) : []).find((m) => m.id === placedId) as never;
}

/** Values no app writes, in the sidecar of a layout with a shared module: a nested one, a second entry, other places. */
export function oddSidecar(doc: Y.Doc): void {
  doc.transact(() => {
    const items = doc.getMap<unknown>('sidecarItems');
    const key = [...items.keys()].find((k) => k.startsWith('m:'))!;
    const value = items.get(key) as Record<string, unknown>;
    items.set('m:again', { ...value, _order: -1, places: [{ id: 'x', name: 'Other', kind: 'industry', spots: [], accepts: [], ships: [], tags: [], notes: '' }] });
    items.set('l:label', new Y.Map(Object.entries({ id: 'label', text: 'Hi' })));
  });
}

/** Values no app writes, in the parts of a layout with a shared module: a nested field, an entry that isn't a part. */
export function oddParts(doc: Y.Doc): void {
  doc.transact(() => {
    const list = doc.getMap<Y.Map<unknown>>('layerData').get(SHEET)!.get('bricks') as Y.Array<unknown>;
    const part = list.get(0) as Y.Map<unknown>;
    part.set('partNumber', new Y.Text(part.get('partNumber') as string));
    list.push([(list.get(1) as Y.Map<unknown>).toJSON()]);
  });
}
