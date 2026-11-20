// Grid snap, as BlueBrick does it (MapData/Layer.cs snapToGrid and
// updateSnapMargin, MapData/LayerBrick.cs getMovedSnapPoint). The desktop
// has the same functions in src/core/GridSnap.h, and both apps run the
// cases in test/fixtures/grid-snap-vectors.json.
//
// A part snaps by its snap corner: the top-left of its display area plus
// the offset its <SnapMargin> gives at its orientation. A 9V straight is
// 17 studs wide with half a stud of margin each side, so its 16-stud
// rails sit on the grid, not its box.
//
// Points (ruler ends, label corners, text and venue points) snap to the
// nearest grid point. One grid for everything: a whole number of studs a
// step, anchored at the layout's origin (0, 0).

import type { Brick, LayerBrick } from '@cld/model';
import type { PartWire, SnapMarginWire } from '../api';
import { topGroupId } from './sets';

export interface Pt {
  x: number;
  y: number;
}

/** From the top-left of a part's display area to its snap corner, at `orientation` degrees (BlueBrick's updateSnapMargin, its branches included). */
export function snapOffset(m: SnapMarginWire | undefined, orientation: number): Pt {
  if (!m || (m.left === 0 && m.right === 0 && m.top === 0 && m.bottom === 0)) return { x: 0, y: 0 };
  const a = (orientation * Math.PI) / 180;
  let c = Math.cos(a);
  let s = Math.sin(a);
  let x: number;
  let y: number;
  if (c > 0) {
    x = m.left * c;
    y = m.top * c;
  } else {
    c = -c;
    x = m.right * c;
    y = m.bottom * c;
  }
  if (s > 0) {
    x += m.bottom * s;
    y += m.left * s;
  } else {
    s = -s;
    x += m.top * s;
    y += m.right * s;
  }
  return { x, y };
}

/** So a value that is a whole number of steps apart from rounding noise counts as one. */
export const GRID_EPSILON = 1e-6;

/** The grid line at or before `v`. */
export function floorToStep(v: number, step: number): number {
  return Math.floor(v / step + GRID_EPSILON) * step;
}

/** The nearest grid line; halfway goes to the even step (C#'s Math.Round, which BlueBrick's centred snap uses). */
export function roundToStep(v: number, step: number): number {
  const q = v / step;
  let r = Math.floor(q + 0.5);
  if (Math.abs(q + 0.5 - r) < GRID_EPSILON && r % 2 !== 0) r -= 1;
  return r * step;
}

/** The nearest grid point to `p`; `p` itself when the step is 0 (off). */
export function snapPoint(p: Pt, step: number): Pt {
  if (step <= 0) return { x: p.x, y: p.y };
  return { x: roundToStep(p.x, step), y: roundToStep(p.y, step) };
}

/**
 * Where a moved part's snap corner lands: the nearest grid point, wherever
 * the part was grabbed. Dragged, dropped from the list, pasted or put down
 * as a module, it goes on the one stud grid anchored at the layout's origin
 * (vanilla BlueBrick floors relative to the grab instead).
 */
export function cornerOnGrid(rawCorner: Pt, step: number): Pt {
  return snapPoint(rawCorner, step);
}

/** The shift that takes a part whose snap corner the move has at `rawCorner` onto the grid. */
export function gridShift(rawCorner: Pt, step: number): Pt {
  const c = cornerOnGrid(rawCorner, step);
  return { x: c.x - rawCorner.x, y: c.y - rawCorner.y };
}

/**
 * How a move snaps (a per-person choice, as the desktop's editing/snapMode):
 * 'grid' puts the thing on the nearest point of the one stud grid; 'steps'
 * moves it a whole number of steps from where it started, so a piece off
 * the grid stays off it by the same amount.
 */
export type SnapMode = 'grid' | 'steps';
export const DEFAULT_SNAP_MODE: SnapMode = 'grid';

/** A saved mode, or the default for anything else. */
export function validSnapMode(v: unknown): SnapMode {
  return v === 'steps' || v === 'grid' ? v : DEFAULT_SNAP_MODE;
}

/** In 'steps' mode, the shift that rounds a move of `delta` to a whole number of steps. */
export function stepShift(delta: Pt, step: number): Pt {
  if (step <= 0) return { x: 0, y: 0 };
  return { x: roundToStep(delta.x, step) - delta.x, y: roundToStep(delta.y, step) - delta.y };
}

/**
 * The shift for something whose snap corner started at `start` and that
 * the move has at `rawCorner`: onto the nearest grid point ('grid'), or to
 * a whole number of steps from `start` ('steps'; without a start, the grid).
 */
export function moveShift(mode: SnapMode, start: Pt | null, rawCorner: Pt, step: number): Pt {
  if (mode === 'steps' && start) return stepShift({ x: rawCorner.x - start.x, y: rawCorner.y - start.y }, step);
  return gridShift(rawCorner, step);
}

/** The next grid line from `v` in direction `dir` (+1 or -1); the nearest when `dir` is 0. */
export function nudgeToStep(v: number, dir: number, step: number): number {
  if (dir > 0) return Math.floor(v / step + GRID_EPSILON) * step + step;
  if (dir < 0) return Math.ceil(v / step - GRID_EPSILON) * step - step;
  return roundToStep(v, step);
}

/**
 * Where an arrow key takes a snap corner at `corner`: to the next grid line
 * in direction (dx, dy) (each -1, 0 or +1), the other axis on its nearest
 * grid line. In 'steps' mode, one step that way; with snap off, one stud.
 */
export function nudgeCorner(corner: Pt, dx: number, dy: number, step: number, mode: SnapMode = 'grid'): Pt {
  if (step <= 0) return { x: corner.x + dx, y: corner.y + dy };
  if (mode === 'steps') return { x: corner.x + dx * step, y: corner.y + dy * step };
  return { x: nudgeToStep(corner.x, dx, step), y: nudgeToStep(corner.y, dy, step) };
}

/** The stud grid fades in from this many screen pixels a stud (none below) to full at STUD_GRID_FULL_PX, as the desktop's. */
export const STUD_GRID_MIN_PX = 6;
export const STUD_GRID_FULL_PX = 16;

/** How strongly the stud grid shows at `pxPerStud` screen pixels a stud: 0 (not at all) to 1. */
export function studGridFade(pxPerStud: number): number {
  return Math.min(1, Math.max(0, (pxPerStud - STUD_GRID_MIN_PX) / (STUD_GRID_FULL_PX - STUD_GRID_MIN_PX)));
}

/** The steps the snap can take, in studs: whole studs only. */
export const SNAP_STEPS_STUDS = [1, 2, 4, 8, 16, 32] as const;
export const DEFAULT_SNAP_STEP = 1;

/** A saved step as one of SNAP_STEPS_STUDS (vanilla's 0.5 becomes 1); 0 (off) for nothing above 0. */
export function validSnapStep(step: number): number {
  if (!(step > 0)) return 0;
  let best: number = SNAP_STEPS_STUDS[0];
  for (const s of SNAP_STEPS_STUDS) if (Math.abs(s - step) < Math.abs(best - step)) best = s;
  return best;
}

/**
 * How far a drag led by a ruler or label shifts from where the pointer has
 * it, onto the grid (studs). With parts in it (`corner`: the first part's
 * snap corner at the start), the parts land by that corner as when a part
 * leads, Alt or not. Without, `ref` (the grabbed ruler's first end or
 * centre, or the label's corner, at the start) goes on the nearest grid
 * point; `free` (Alt) leaves it where the pointer has it.
 */
export function annoDragShift(o: {
  /** The pointer's move since the press, studs. */
  moved: Pt;
  corner: Pt | null;
  ref: Pt | null;
  step: number;
  free: boolean;
  /** 'steps': whole steps from where it started instead of the grid. */
  mode?: SnapMode;
}): Pt {
  const mode = o.mode ?? 'grid';
  if (o.corner) return moveShift(mode, o.corner, { x: o.corner.x + o.moved.x, y: o.corner.y + o.moved.y }, o.step);
  if (!o.ref) return { x: 0, y: 0 };
  if (mode === 'steps') return o.free ? { x: 0, y: 0 } : stepShift(o.moved, o.step);
  const at = { x: o.ref.x + o.moved.x, y: o.ref.y + o.moved.y };
  const to = snapPoint(at, o.free ? 0 : o.step);
  return { x: to.x - at.x, y: to.y - at.y };
}

type Parts = ReadonlyMap<string, PartWire>;
const partOf = (parts: Parts, key: string) => parts.get(key.toLowerCase());

/** The corner a brick snaps to the grid by: its display area's top-left plus its <SnapMargin> offset (BlueBrick's Position + SnapToGridOffset). */
export function snapCorner(brick: Pick<Brick, 'displayArea' | 'orientation'>, part: PartWire | undefined): Pt {
  const off = snapOffset(part?.snapMargin, brick.orientation);
  return { x: brick.displayArea.x + off.x, y: brick.displayArea.y + off.y };
}

/**
 * The corner a grab on `brick` snaps by. As in BlueBrick, a brick whose
 * outermost group is a set from the library snaps by the set: the box
 * around all its parts plus the set's <SnapMargin> at the set's turn (a
 * part of it, less the turn it has in the set). Otherwise, the brick's own.
 */
export function grabSnapCorner(layer: Pick<LayerBrick, 'bricks' | 'groups'>, brick: Brick, parts: Parts): Pt {
  const top = topGroupId(layer.groups, brick.myGroup);
  const set = top ? layer.groups.find((g) => g.id === top) : undefined;
  if (!set?.partNumber) return snapCorner(brick, partOf(parts, brick.partNumber));
  const meta = partOf(parts, set.partNumber);
  let minX = Infinity;
  let minY = Infinity;
  let turn: number | null = null;
  for (const m of layer.bricks) {
    if (m.id !== brick.id && topGroupId(layer.groups, m.myGroup) !== top) continue;
    minX = Math.min(minX, m.displayArea.x);
    minY = Math.min(minY, m.displayArea.y);
    if (turn !== null || !meta || m.myGroup !== top) continue;
    // (A custom set's parts are placed as `custom:<id>`: the same part either way.)
    const placed = partOf(parts, m.partNumber);
    const sp = meta.subparts.find((p) => p.subKey.toLowerCase() === m.partNumber.toLowerCase() || (!!placed && partOf(parts, p.subKey) === placed));
    if (sp) turn = m.orientation - sp.angle;
  }
  const off = snapOffset(meta?.snapMargin, turn ?? 0);
  return { x: minX + off.x, y: minY + off.y };
}
