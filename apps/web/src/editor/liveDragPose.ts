// Where the parts being dragged are right now, before the drop writes them
// to the layout. The canvas moves the parts' own nodes every frame; the
// things drawn from the layout (module outlines and names, and anything
// else that follows parts) read this pose so they move with the drag too,
// instead of waiting for the release. One shared source for every overlay
// (the desktop's MapView::liveDragPose is the same).
//
// The pose is rigid: a part's point p (studs, where it was when the drag
// started) is now R(degrees) · (p − about) + to.

import { useMemo } from 'react';
import { create } from 'zustand';
import type Konva from 'konva';
import type { BbmMap } from '@cld/model';

export interface DragPose {
  /** The parts being dragged. */
  ids: ReadonlySet<string>;
  /** Each dragged part's display area when the drag started (studs): the pose applies while the layout still has them there. */
  startAreas: ReadonlyMap<string, { x: number; y: number; width: number; height: number }>;
  about: { x: number; y: number };
  to: { x: number; y: number };
  degrees: number;
}

interface PoseState {
  pose: DragPose | null;
  setPose: (pose: DragPose | null) => void;
}

export const useLiveDragPose = create<PoseState>((set) => ({
  pose: null,
  setPose: (pose) => set({ pose }),
}));

/** Where a start-of-drag point (studs) is now. */
export function posedPoint(pose: DragPose, x: number, y: number): { x: number; y: number } {
  const r = (pose.degrees * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const dx = x - pose.about.x, dy = y - pose.about.y;
  return { x: pose.to.x + dx * c - dy * s, y: pose.to.y + dx * s + dy * c };
}

/**
 * The layout with the dragged parts where the drag has them now (their
 * areas moved and turned, their orientations turned), for everything drawn
 * from the layout that follows parts. Unchanged (the same object) when
 * nothing is being dragged, or once the drop is in the layout.
 */
export function posedMap(map: BbmMap, pose: DragPose | null): BbmMap {
  if (!pose) return map;
  let changed = false;
  const layers = map.layers.map((layer) => {
    if (layer.type !== 'brick') return layer;
    // Only the dragged parts are copied: a new list of every part on
    // each frame cost more than the parts moved.
    let bricks: typeof layer.bricks | null = null;
    for (let i = 0; i < layer.bricks.length; i++) {
      const b = layer.bricks[i]!;
      if (!pose.ids.has(b.id)) continue;
      const posed = posedBrick(b, pose);
      if (posed === b) continue;
      bricks ??= layer.bricks.slice();
      bricks[i] = posed;
    }
    if (!bricks) return layer;
    changed = true;
    return { ...layer, bricks };
  });
  return changed ? { ...map, layers } : map;
}

/** One dragged part where the drag has it now (the same object once the drop is in the layout). */
function posedBrick<B extends { id: string; displayArea: { x: number; y: number; width: number; height: number }; orientation: number }>(b: B, pose: DragPose): B {
  const was = pose.startAreas.get(b.id);
  const a = b.displayArea;
  if (!was || was.x !== a.x || was.y !== a.y || was.width !== a.width || was.height !== a.height) return b;
  const c = posedPoint(pose, a.x + a.width / 2, a.y + a.height / 2);
  // A turned area's box: the old box's corners, turned.
  const r = (pose.degrees * Math.PI) / 180;
  const w = Math.abs(a.width * Math.cos(r)) + Math.abs(a.height * Math.sin(r));
  const h = Math.abs(a.width * Math.sin(r)) + Math.abs(a.height * Math.cos(r));
  const round = (v: number) => Math.round(v * 1e9) / 1e9;
  return {
    ...b,
    displayArea: { x: c.x - round(w) / 2, y: c.y - round(h) / 2, width: round(w), height: round(h) },
    orientation: b.orientation + pose.degrees,
  };
}

/** The last posed layout (several overlays ask for the same one each frame). */
let lastPosed: { map: BbmMap; pose: DragPose; out: BbmMap } | null = null;

function posedMapCached(map: BbmMap, pose: DragPose | null): BbmMap {
  if (!pose) return map;
  if (lastPosed && lastPosed.map === map && lastPosed.pose === pose) return lastPosed.out;
  const out = posedMap(map, pose);
  lastPosed = { map, pose, out };
  return out;
}

/**
 * `map` with the live drag applied (see posedMap); re-renders the caller
 * as the drag moves, but only while `relevant(pose)` (say, a module or a
 * ruler of its is among the dragged parts), so overlays that don't follow
 * these parts aren't drawn again every frame.
 */
export function usePosedMap(map: BbmMap, relevant?: (pose: DragPose) => boolean): BbmMap;
export function usePosedMap(map: BbmMap | null, relevant?: (pose: DragPose) => boolean): BbmMap | null;
export function usePosedMap(map: BbmMap | null, relevant?: (pose: DragPose) => boolean): BbmMap | null {
  const pose = useLiveDragPose((s) => (s.pose && (!relevant || relevant(s.pose)) ? s.pose : null));
  return useMemo(() => (map ? posedMapCached(map, pose) : map), [map, pose]);
}

/** Whether any of `ids` is being dragged. */
export function dragsAny(pose: DragPose, ids: Iterable<string>): boolean {
  for (const id of ids) if (pose.ids.has(id)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// The pose of one part as drawn this frame: its Konva node (`.brick-<id>`).
// The drag pose above is rigid and set by a drag of parts; a part also
// moves before anything is committed while a flex run bends (each part on
// its own) and as a rotation snaps. Something attached to one part's own
// point (a bend handle on its free end) reads the part's node as Konva
// draws it, so it follows all of those, frame by frame, without a React
// render.

type Pt = { x: number; y: number };
const PX = 8; // studs → px

/**
 * Where the point `local` (studs, in the part's own frame: from its sprite
 * centre, before its turn, as a connection's position) is drawn now, in the
 * stage's absolute (container) pixels. Null when the part has no node.
 */
export function nodePoint(stage: Konva.Stage | null | undefined, brickId: string, local: Pt): Pt | null {
  const node = stage?.findOne(`.brick-${brickId}`);
  if (!node) return null;
  return node.getAbsoluteTransform().point({ x: local.x * PX, y: local.y * PX });
}

/** The same point in `shape`'s own drawing frame (what a sceneFunc or hitFunc draws in); the shape's origin when the part has no node. */
export function nodePointIn(shape: Pick<Konva.Node, 'getStage' | 'getAbsoluteTransform'>, brickId: string, local: Pt): Pt {
  const abs = nodePoint(shape.getStage(), brickId, local);
  if (!abs) return { x: 0, y: 0 };
  return shape.getAbsoluteTransform().copy().invert().point(abs);
}
