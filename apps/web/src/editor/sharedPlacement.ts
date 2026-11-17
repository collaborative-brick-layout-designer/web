// Keeping a shared module's placement (`shared.placement`, docs/shared-modules.md)
// up to date when the module is moved, turned or put on another sheet as a
// whole. The server puts an update exactly where the placement says, so it
// has to follow the module. mutations.ts (keepingPlacements) reads the
// parts before and after a move, in the same transaction, and this works
// out the placement that follows them: the turn and shift that took every
// part from where it was to where it is (a rigid move), and which sheet
// each of the version's sheets is on now. A change that isn't a rigid move
// of the whole module (one part turned in place, some parts left behind)
// leaves the placement as it was; the apps then find it again from the
// parts (packages/modules resolvePlacement).

import * as Y from 'yjs';
import { readSidecarCache } from '@cld/ydoc';
import { norm360, pivotOf, rotated, sharedPlaced, type PartLookup, type Placement, type Pt } from '@cld/modules';
import type { RectangleF } from '@cld/model';

/** Where a part is: its pivot, its turn, and its sheet. */
export interface PartPose {
  at: Pt;
  o: number;
  layer: string;
}

/** A shared module's placement and its parts' poses, before a change. */
export interface SharedShape {
  placedId: string;
  placement: Placement;
  poses: Map<string, PartPose>;
}

/** Within this, two turns (degrees) or two shifts (studs) are the same. */
const SAME_TURN = 1e-6;
const SAME_SHIFT = 1e-4;

const turnApart = (a: number, b: number) => {
  const d = Math.abs(norm360(a) - norm360(b));
  return Math.min(d, 360 - d);
};

/** The poses of the parts `ids`, on every sheet. Without `partOf` a part's pivot is its box centre (exact for moves and quarter turns). */
export function partPoses(doc: Y.Doc, ids: ReadonlySet<string>, partOf?: PartLookup): Map<string, PartPose> {
  const out = new Map<string, PartPose>();
  if (ids.size === 0) return out;
  const layerData = doc.getMap('layerData');
  for (const layer of doc.getArray<string>('layers').toArray()) {
    const data = layerData.get(layer);
    const bricks = data instanceof Y.Map ? data.get('bricks') : undefined;
    if (!(bricks instanceof Y.Array)) continue;
    bricks.forEach((b) => {
      if (!(b instanceof Y.Map)) return;
      const id = b.get('id') as string;
      if (!ids.has(id)) return;
      const area = b.get('displayArea') as RectangleF | undefined;
      if (!area) return;
      const o = (b.get('orientation') as number) ?? 0;
      const part = partOf ? partOf(b.get('partNumber') as string) : undefined;
      out.set(id, { at: pivotOf({ displayArea: area, orientation: o }, part), o, layer });
    });
  }
  return out;
}

/** The layout's shared modules that keep a placement, with their parts' poses now; empty when there are none. */
export function sharedShapes(doc: Y.Doc, partOf?: PartLookup): SharedShape[] {
  const cache = readSidecarCache(doc) as { modules?: unknown };
  const list = Array.isArray(cache?.modules) ? (cache.modules as Parameters<typeof sharedPlaced>[0][]) : [];
  const found: { placedId: string; placement: Placement; members: string[] }[] = [];
  for (const m of list) {
    const s = sharedPlaced(m);
    if (s?.placement && s.members.length > 0) found.push({ placedId: s.placedId, placement: s.placement, members: s.members });
  }
  if (found.length === 0) return [];
  const poses = partPoses(doc, new Set(found.flatMap((f) => f.members)), partOf);
  return found.map((f) => ({ placedId: f.placedId, placement: f.placement, poses: new Map(f.members.flatMap((id) => (poses.has(id) ? [[id, poses.get(id)!]] : []))) }));
}

/**
 * The placement after the module's parts went from `before` to `after`:
 * turned and moved together, or put on other sheets. Null when nothing
 * the placement says changed, or when the parts didn't move together.
 */
export function followedPlacement(placement: Placement, before: ReadonlyMap<string, PartPose>, after: ReadonlyMap<string, PartPose>): Placement | null {
  if (before.size === 0) return null;
  let turn: number | null = null;
  for (const [id, b] of before) {
    const a = after.get(id);
    if (!a) return null;
    const d = norm360(a.o - b.o);
    if (turn === null) turn = d;
    else if (turnApart(d, turn) > SAME_TURN) return null;
  }
  const degrees = turn ?? 0;
  let shift: Pt | null = null;
  for (const [id, b] of before) {
    const a = after.get(id)!;
    const r = rotated(b.at, degrees);
    const t = { x: a.at.x - r.x, y: a.at.y - r.y };
    if (shift === null) shift = t;
    else if (Math.hypot(t.x - shift.x, t.y - shift.y) > SAME_SHIFT) return null;
  }
  const t = shift ?? { x: 0, y: 0 };
  const turned = degrees > SAME_TURN && degrees < 360 - SAME_TURN;
  const moved = turned || Math.hypot(t.x, t.y) > 1e-9;

  // Each of the version's sheets goes where all its parts went.
  let sheets = placement.sheets;
  if (sheets) {
    const next: Record<string, string> = { ...sheets };
    let changed = false;
    for (const [name, layer] of Object.entries(sheets)) {
      const to = new Set<string>();
      for (const [id, b] of before) if (b.layer === layer) to.add(after.get(id)!.layer);
      if (to.size !== 1) continue;
      const now = [...to][0]!;
      if (now !== layer) {
        next[name] = now;
        changed = true;
      }
    }
    if (changed) sheets = next;
    else if (!moved) return null;
  } else if (!moved) return null;

  const at = turned ? rotated({ x: placement.x, y: placement.y }, degrees) : { x: placement.x, y: placement.y };
  return {
    ...placement,
    degrees: turned ? norm360(placement.degrees + degrees) : placement.degrees,
    x: at.x + t.x,
    y: at.y + t.y,
    ...(sheets ? { sheets } : {}),
  };
}
