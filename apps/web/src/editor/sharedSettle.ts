// Finishing an undo or redo for shared modules (doc shape 5; the rule is
// @cld/modules settle.ts, with the desktop's copy and shared vectors).
//
// The server keeps a shared module's unchanged parts when it puts a new
// version in, so an earlier undo step of mine can point at some of its parts
// and not the others. useUndoManager runs each undo and redo inside one
// change with finishShared, so the module ends whole: moved, turned or put
// on another sheet together, or removed together, and its placement follows.

import * as Y from 'yjs';
import type { RectangleF } from '@cld/model';
import { readSidecarCache, writeSidecarCache } from '@cld/ydoc';
import { readPlacement, settleShared, sharedModulesIn, withShared, type PartLookup, type Placement, type SettlePart, type SettleSide } from '@cld/modules';
import type { SidecarModule } from '@cld/bbm';
import { followedPlacement, partPoses, type PartPose } from './sharedPlacement';

/** A shared module before the step: its parts (in its order), their poses, and its placement. */
interface Before {
  side: SettleSide;
  poses: Map<string, PartPose>;
  placement: Placement | null;
}

const samePlacement = (a: Placement, b: Placement | null): boolean =>
  !!b &&
  Math.abs(a.degrees - b.degrees) < 1e-9 &&
  Math.abs(a.x - b.x) < 1e-9 &&
  Math.abs(a.y - b.y) < 1e-9 &&
  JSON.stringify(a.sheets ?? {}) === JSON.stringify(b.sheets ?? {});

/** Every part on the map by id: its entry, the sheet it is on, and where it is in that sheet's list. */
function partsById(doc: Y.Doc): Map<string, { map: Y.Map<unknown>; sheet: string }> {
  const out = new Map<string, { map: Y.Map<unknown>; sheet: string }>();
  const layerData = doc.getMap('layerData');
  for (const layerId of doc.getArray<string>('layers').toArray()) {
    const bricks = (layerData.get(layerId) as Y.Map<unknown> | undefined)?.get?.('bricks');
    if (!(bricks instanceof Y.Array)) continue;
    for (const b of bricks) {
      if (!(b instanceof Y.Map)) continue;
      const id = b.get('id');
      if (typeof id === 'string' && !out.has(id)) out.set(id, { map: b, sheet: layerId });
    }
  }
  return out;
}

function settlePart(id: string, at: { map: Y.Map<unknown>; sheet: string }): SettlePart {
  const a = (at.map.get('displayArea') as RectangleF | undefined) ?? { x: 0, y: 0, width: 0, height: 0 };
  return {
    id,
    sheet: at.sheet,
    partNumber: typeof at.map.get('partNumber') === 'string' ? (at.map.get('partNumber') as string) : '',
    displayArea: { x: a.x, y: a.y, width: a.width, height: a.height },
    orientation: typeof at.map.get('orientation') === 'number' ? (at.map.get('orientation') as number) : 0,
  };
}

/** The layout's shared modules as they are now, by placed id; empty when it has none. */
export function sharedBefore(doc: Y.Doc, partOf?: PartLookup): Map<string, Before> {
  const placed = sharedModulesIn(readSidecarCache(doc));
  const out = new Map<string, Before>();
  if (placed.length === 0) return out;
  const parts = partsById(doc);
  for (const p of placed) {
    const list = p.members.flatMap((id) => (parts.has(id) ? [settlePart(id, parts.get(id)!)] : []));
    out.set(p.placedId, { side: { record: true, parts: list }, poses: partPoses(doc, new Set(p.members), partOf), placement: p.placement });
  }
  return out;
}

/**
 * Finish the step that just ran for each shared module in `before`
 * (settleShared): call it inside the step's own transaction. Returns
 * whether it changed anything.
 */
export function finishShared(doc: Y.Doc, before: ReadonlyMap<string, Before>, partOf: PartLookup): boolean {
  if (before.size === 0) return false;
  const records = new Map(((readSidecarCache(doc)?.modules as SidecarModule[] | undefined) ?? []).map((m) => [m.id, m] as const));
  let parts = partsById(doc);
  let changed = false;
  const dropModules = new Set<string>();
  const placements = new Map<string, NonNullable<ReturnType<typeof followedPlacement>>>();
  for (const [placedId, was] of before) {
    const after: SettleSide = {
      record: records.has(placedId),
      parts: was.side.parts.flatMap((p) => (parts.has(p.id) ? [settlePart(p.id, parts.get(p.id)!)] : [])),
    };
    const s = settleShared(was.side, after, partOf);
    if (s.remove.length > 0 || s.removeModule || s.move.length > 0) changed = true;
    const layerData = doc.getMap('layerData');
    for (const id of s.remove) {
      const at = parts.get(id);
      const bricks = (layerData.get(at?.sheet ?? '') as Y.Map<unknown> | undefined)?.get('bricks');
      if (!at || !(bricks instanceof Y.Array)) continue;
      const i = bricks.toArray().indexOf(at.map);
      if (i >= 0) bricks.delete(i, 1);
    }
    if (s.removeModule) dropModules.add(placedId);
    for (const m of s.move) {
      const at = parts.get(m.id);
      if (!at) continue;
      if (at.sheet === m.sheet) {
        at.map.set('displayArea', m.displayArea);
        at.map.set('orientation', m.orientation);
        continue;
      }
      // Another sheet: the same part (its id and fields) there, as a sheet change makes it.
      const from = (layerData.get(at.sheet) as Y.Map<unknown>).get('bricks') as Y.Array<unknown>;
      const to = (layerData.get(m.sheet) as Y.Map<unknown> | undefined)?.get('bricks');
      if (!(to instanceof Y.Array)) continue;
      const copy = new Y.Map<unknown>();
      for (const [k, v] of at.map.entries()) if (k !== 'z') copy.set(k, v instanceof Y.AbstractType ? v.toJSON() : v);
      copy.set('displayArea', m.displayArea);
      copy.set('orientation', m.orientation);
      const i = from.toArray().indexOf(at.map);
      if (i >= 0) from.delete(i, 1);
      to.push([copy]);
    }
    if (s.move.length > 0) parts = partsById(doc);
    // Its placement follows its parts (an undo can't always put the placement back: the server rewrote it since).
    const record = records.get(placedId);
    if (!record || s.removeModule || !was.placement) continue;
    const next = followedPlacement(was.placement, was.poses, partPoses(doc, new Set(was.side.parts.map((p) => p.id)), partOf));
    const kept = readPlacement((record as { shared?: { placement?: unknown } }).shared?.placement);
    if (next && !samePlacement(next, kept)) {
      placements.set(placedId, next);
      changed = true;
    }
  }
  if (dropModules.size > 0 || placements.size > 0) {
    const cache = readSidecarCache(doc) ?? {};
    const modules = ((cache.modules as SidecarModule[] | undefined) ?? [])
      .filter((m) => !dropModules.has(m.id))
      .map((m) => (placements.has(m.id) ? withShared(m, { placement: placements.get(m.id)! }) : m));
    writeSidecarCache(doc, { ...cache, modules });
  }
  return changed;
}
