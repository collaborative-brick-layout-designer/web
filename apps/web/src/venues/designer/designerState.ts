// The Venue Designer's state and what each tool does with the pointer and
// the keyboard, as one reducer (no React, no canvas) so the tools are tested
// directly. The canvas turns mouse events into world points (studs) and
// dispatches them here; the desktop's VenueDesigner follows the same rules.

import type { Venue, VenueObstacleKind } from '@cld/bbm';
import {
  addDimension,
  addEdge,
  addNote,
  addObstacle,
  addPower,
  addRoom,
  cutOpening,
  deletePart,
  dist,
  duplicatePart,
  hitTest,
  lerp,
  moveCorner,
  movePart,
  moveVertex,
  segDist,
  type Pt,
  type Selection,
} from './model';
import { commit, redo, startHistory, undo, type History } from './history';
import { DEFAULT_STEP_STUDS, pointAtLength, snapPoint, type SnapKind } from './snap';
import { venueLengthUnit, withVenueLengthUnit } from '@cld/bbm';
import { formatLength, parseLength, type LengthUnit } from './units';

export type Tool =
  | 'select'
  | 'wall'
  | 'room'
  | 'door'
  | 'opening'
  | 'column'
  | 'stairs'
  | 'elevator'
  | 'counter'
  | 'railing'
  | 'power'
  | 'note'
  | 'measure'
  | 'calibrate';

/** Tools in palette order, with their one-key shortcuts. */
export const TOOLS: { tool: Tool; label: string; key: string; hint: string }[] = [
  { tool: 'select', label: 'Select', key: 'v', hint: 'Click to select, drag to move, drag a corner to reshape' },
  { tool: 'wall', label: 'Wall', key: 'w', hint: 'Click corner to corner; type a length and press Enter; Enter or Esc to finish' },
  { tool: 'room', label: 'Room', key: 'r', hint: 'Click two opposite corners, or click one and type width x depth' },
  { tool: 'door', label: 'Door', key: 'd', hint: 'Click where the door starts on a wall, then where it ends (or type its width)' },
  { tool: 'opening', label: 'Opening', key: 'o', hint: 'Click where the opening starts on a wall, then where it ends (or type its width)' },
  { tool: 'column', label: 'Column', key: 'c', hint: 'Click two opposite corners, or click one and type width x depth' },
  { tool: 'stairs', label: 'Stairs', key: 's', hint: 'Click two opposite corners; set the way up in the inspector' },
  { tool: 'elevator', label: 'Elevator', key: 'e', hint: 'Click two opposite corners' },
  { tool: 'counter', label: 'Counter', key: 'k', hint: 'Click two opposite corners' },
  { tool: 'railing', label: 'Railing', key: 'l', hint: 'Click where it starts and where it ends (or type its length)' },
  { tool: 'power', label: 'Power', key: 'p', hint: 'Click on a wall for a wall outlet, anywhere else for a floor outlet' },
  { tool: 'note', label: 'Note', key: 'n', hint: 'Click where the note goes, then type it in the inspector' },
  { tool: 'measure', label: 'Measure', key: 'm', hint: 'Click two points to add a measurement (or type its length)' },
];

const OBSTACLE_TOOLS: Partial<Record<Tool, VenueObstacleKind>> = {
  column: 'column',
  stairs: 'stairs',
  elevator: 'elevator',
  counter: 'counter',
};

export type Layer = 'plan' | 'obstacles' | 'power' | 'dimensions' | 'notes' | 'estimates';

export interface DesignerState {
  history: History;
  selection: Selection | null;
  tool: Tool;
  /** Points placed so far by the current tool. */
  draft: Pt[];
  /** Door / opening: the wall being cut. */
  cut: { edge: number; seg: number; t0: number } | null;
  /** What's typed while drawing (a length, or "W x D"). */
  typed: string;
  pointer: Pt | null;
  snapKind: SnapKind;
  unit: LengthUnit;
  snap: boolean;
  show: Record<Layer, boolean>;
  /** Moving a part or a corner with the Select tool. */
  drag: { sel: Selection; vertex?: number; from: Pt; base: Venue; moved: boolean } | null;
  /** Calibrating the floor plan: the two points clicked. */
  calibration: Pt[];
  /** A short message for the status line (errors from typed input). */
  message: string;
}

export function initialState(venue: Venue): DesignerState {
  return {
    history: startHistory(venue),
    selection: null,
    tool: 'select',
    draft: [],
    cut: null,
    typed: '',
    pointer: null,
    snapKind: 'none',
    // The venue remembers the unit it was drawn in.
    unit: venueLengthUnit(venue),
    snap: true,
    show: { plan: true, obstacles: true, power: true, dimensions: true, notes: true, estimates: true },
    drag: null,
    calibration: [],
    message: '',
  };
}

export const venueOf = (s: DesignerState): Venue => s.history.present;

export type Action =
  | { type: 'tool'; tool: Tool }
  | { type: 'move'; at: Pt; tol: number; free: boolean }
  | { type: 'down'; at: Pt; tol: number; free: boolean }
  | { type: 'up' }
  | { type: 'type'; text: string }
  | { type: 'enter' }
  | { type: 'escape' }
  | { type: 'delete' }
  | { type: 'duplicate' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'select'; selection: Selection | null }
  | { type: 'edit'; venue: Venue }
  | { type: 'unit'; unit: LengthUnit }
  | { type: 'snap'; on: boolean }
  | { type: 'show'; layer: Layer; on: boolean };

function edit(s: DesignerState, next: Venue, rest: Partial<DesignerState> = {}): DesignerState {
  return { ...s, history: commit(s.history, next), message: '', ...rest };
}

/** The pointer after snapping, from the last draft point when drawing a line. */
function snapped(s: DesignerState, at: Pt, tol: number, free: boolean): { pt: Pt; kind: SnapKind } {
  if (!s.snap) return { pt: at, kind: 'none' };
  const from = s.draft.length > 0 && (s.tool === 'wall' || s.tool === 'railing' || s.tool === 'measure') ? s.draft[s.draft.length - 1] : undefined;
  return snapPoint(venueOf(s), at, {
    ...(from ? { from } : {}),
    stepStuds: DEFAULT_STEP_STUDS,
    angleStepDeg: free ? 0 : 45,
    tolStuds: tol,
    toVenue: true,
  });
}

/** "40' x 30'", "40'4\" × 12'" → [w, d] studs, or one length → [len]. */
export function parseSize(text: string, unit: LengthUnit): number[] | null {
  const parts = text.split(/\s*[x×]\s*/i).filter((p) => p.trim() !== '');
  if (parts.length === 0 || parts.length > 2) return null;
  const out = parts.map((p) => parseLength(p, unit));
  return out.every((v): v is number => v !== null && v > 0) ? out : null;
}

/** Where the second corner of a rectangle goes for a typed width x depth, towards the pointer. */
function cornerFor(a: Pt, toward: Pt | null, w: number, d: number): Pt {
  const sx = toward && toward.x < a.x ? -1 : 1;
  const sy = toward && toward.y < a.y ? -1 : 1;
  return { x: a.x + sx * w, y: a.y + sy * d };
}

// Two-point tools: what happens when the second point is set.
function finishTwoPoint(s: DesignerState, a: Pt, b: Pt): DesignerState {
  const v = venueOf(s);
  const ob = OBSTACLE_TOOLS[s.tool];
  let next = v;
  let selection: Selection | null = null;
  if (s.tool === 'room') next = addRoom(v, a, b);
  else if (ob) {
    next = addObstacle(v, ob, a, b);
    if (next !== v) selection = { kind: 'obstacle', index: next.obstacles.length - 1 };
  } else if (s.tool === 'railing') {
    next = addObstacle(v, 'railing', a, b);
    if (next !== v) selection = { kind: 'obstacle', index: next.obstacles.length - 1 };
  } else if (s.tool === 'measure') {
    next = addDimension(v, a, b, formatLength(dist(a, b), s.unit));
    if (next !== v) selection = { kind: 'dimension', index: (next.dimensions ?? []).length - 1 };
  }
  return edit(s, next, { draft: [], typed: '', selection });
}

function finishCut(s: DesignerState, t1: number): DesignerState {
  if (!s.cut) return s;
  const kind = s.tool === 'door' ? 1 : 2;
  const v = venueOf(s);
  const next = cutOpening(v, s.cut.edge, s.cut.seg, s.cut.t0, t1, kind, kind === 1 ? 'door' : 'opening');
  const selection: Selection | null = next !== v ? { kind: 'edge', index: s.cut.edge + (s.cut.t0 > 0.0001 && t1 > 0.0001 ? 1 : 0) } : null;
  return edit(s, next, { cut: null, typed: '', selection });
}

// Where along the wall being cut the pointer is (0–1).
function tOnCut(s: DesignerState, p: Pt): number | null {
  if (!s.cut) return null;
  const e = venueOf(s).edges[s.cut.edge];
  const a = e?.poly[s.cut.seg], b = e?.poly[s.cut.seg + 1];
  return a && b ? segDist(p, a, b).t : null;
}

export function reducer(s: DesignerState, a: Action): DesignerState {
  const v = venueOf(s);
  switch (a.type) {
    case 'tool':
      return { ...s, tool: a.tool, draft: [], cut: null, typed: '', drag: null, calibration: [], message: '', ...(a.tool !== 'select' ? { selection: null } : {}) };

    case 'move': {
      if (s.drag) {
        const d = { x: a.at.x - s.drag.from.x, y: a.at.y - s.drag.from.y };
        let target = a.at;
        if (s.drag.vertex !== undefined && s.snap) target = snapPoint(s.drag.base, a.at, { stepStuds: DEFAULT_STEP_STUDS, angleStepDeg: 0, tolStuds: a.tol, toVenue: true }).pt;
        let moved: Venue;
        if (s.drag.vertex === undefined) moved = movePart(s.drag.base, s.drag.sel, s.snap ? snapDelta(d) : d);
        else if (s.drag.sel.kind === 'edge') {
          // A corner of the outline: walls that meet there move together.
          const at = s.drag.base.edges[s.drag.sel.index]!.poly[s.drag.vertex]!;
          moved = moveCorner(s.drag.base, at, target);
        } else moved = moveVertex(s.drag.base, s.drag.sel, s.drag.vertex, target);
        return { ...s, history: { ...s.history, present: moved }, drag: { ...s.drag, moved: true }, pointer: a.at };
      }
      const sp = snapped(s, a.at, a.tol, a.free);
      return { ...s, pointer: sp.pt, snapKind: sp.kind };
    }

    case 'down': {
      const sp = snapped(s, a.at, a.tol, a.free);
      const p = sp.pt;
      switch (s.tool) {
        case 'select': {
          const hit = hitTest(v, a.at, a.tol);
          if (!hit) return { ...s, selection: null };
          const sel: Selection = { kind: hit.kind, index: hit.index };
          return { ...s, selection: sel, drag: { sel, ...(hit.vertex !== undefined ? { vertex: hit.vertex } : {}), from: a.at, base: v, moved: false } };
        }
        case 'wall': {
          if (s.draft.length === 0) return { ...s, draft: [p], typed: '' };
          const last = s.draft[s.draft.length - 1]!;
          if (dist(last, p) < 0.001) return s;
          const next = addEdge(v, [last, p], 0);
          // Clicking the first corner closes the outline and finishes.
          const closed = s.draft.length > 1 && dist(p, s.draft[0]!) < 0.001;
          return edit(s, next, { draft: closed ? [] : [...s.draft, p], typed: '' });
        }
        case 'room':
        case 'column':
        case 'stairs':
        case 'elevator':
        case 'counter':
        case 'railing':
        case 'measure':
          if (s.draft.length === 0) return { ...s, draft: [p], typed: '' };
          return finishTwoPoint(s, s.draft[0]!, p);
        case 'door':
        case 'opening': {
          if (!s.cut) {
            const hit = hitTest(v, a.at, a.tol);
            if (!hit || hit.kind !== 'edge' || hit.seg === undefined || v.edges[hit.index]!.kind !== 0)
              return { ...s, message: 'Click on a wall' };
            return { ...s, cut: { edge: hit.index, seg: hit.seg, t0: snapT(v, hit.index, hit.seg, hit.t ?? 0) }, typed: '', message: '' };
          }
          const t = tOnCut(s, a.at);
          if (t === null) return s;
          return finishCut(s, snapT(v, s.cut.edge, s.cut.seg, t));
        }
        case 'power': {
          const onWall = sp.kind === 'wall' || sp.kind === 'corner';
          const next = addPower(v, p, onWall ? 'wall' : 'floor');
          return edit(s, next, { selection: { kind: 'power', index: next.power!.length - 1 } });
        }
        case 'note': {
          const next = addNote(v, p, 'Note');
          return edit(s, next, { selection: { kind: 'note', index: next.notes!.length - 1 } });
        }
        case 'calibrate': {
          const pts = [...s.calibration, a.at].slice(-2);
          return { ...s, calibration: pts };
        }
      }
      return s;
    }

    case 'up': {
      if (!s.drag) return s;
      const done = s.history.present;
      const base = s.drag.base;
      const restored: DesignerState = { ...s, history: { ...s.history, present: base }, drag: null };
      return s.drag.moved ? edit(restored, done) : restored;
    }

    case 'type':
      return { ...s, typed: a.text, message: '' };

    case 'enter': {
      const typed = s.typed.trim();
      if (s.tool === 'wall') {
        if (!typed) return { ...s, draft: [], typed: '' };
        const len = parseLength(typed, s.unit);
        if (len === null || len <= 0 || s.draft.length === 0) return { ...s, message: `Not a length: ${typed}` };
        const last = s.draft[s.draft.length - 1]!;
        const end = pointAtLength(last, s.pointer ?? { x: last.x + 1, y: last.y }, len, 45);
        return edit(s, addEdge(v, [last, end], 0), { draft: [...s.draft, end], typed: '' });
      }
      if ((s.tool === 'door' || s.tool === 'opening') && s.cut) {
        const len = parseLength(typed, s.unit);
        const e = v.edges[s.cut.edge]!;
        const segLen = dist(e.poly[s.cut.seg]!, e.poly[s.cut.seg + 1]!);
        if (len === null || len <= 0 || segLen <= 0) return { ...s, message: `Not a length: ${typed}` };
        const tp = s.pointer ? tOnCut(s, s.pointer) : null;
        const dir = tp !== null && tp < s.cut.t0 ? -1 : 1;
        return finishCut(s, Math.max(0, Math.min(1, s.cut.t0 + (dir * len) / segLen)));
      }
      if (s.draft.length === 1 && typed) {
        const size = parseSize(typed, s.unit);
        if (!size) return { ...s, message: `Not a size: ${typed}` };
        const a0 = s.draft[0]!;
        if (s.tool === 'railing' || s.tool === 'measure' || size.length === 1) {
          if (s.tool === 'railing' || s.tool === 'measure')
            return finishTwoPoint(s, a0, pointAtLength(a0, s.pointer ?? { x: a0.x + 1, y: a0.y }, size[0]!, 45));
          return finishTwoPoint(s, a0, cornerFor(a0, s.pointer, size[0]!, size[0]!));
        }
        return finishTwoPoint(s, a0, cornerFor(a0, s.pointer, size[0]!, size[1]!));
      }
      return s;
    }

    case 'escape':
      if (s.drag) return { ...s, history: { ...s.history, present: s.drag.base }, drag: null };
      if (s.draft.length || s.cut || s.typed || s.calibration.length) return { ...s, draft: [], cut: null, typed: '', calibration: [], message: '' };
      if (s.tool !== 'select') return reducer(s, { type: 'tool', tool: 'select' });
      return { ...s, selection: null };

    case 'delete':
      if (!s.selection) return s;
      return edit(s, deletePart(v, s.selection), { selection: null });

    case 'duplicate': {
      if (!s.selection) return s;
      const d = duplicatePart(v, s.selection);
      return edit(s, d.venue, { selection: d.selection });
    }

    case 'undo': {
      const history = undo(s.history);
      return { ...s, history, unit: venueLengthUnit(history.present), selection: null, draft: [], cut: null };
    }
    case 'redo': {
      const history = redo(s.history);
      return { ...s, history, unit: venueLengthUnit(history.present), selection: null, draft: [], cut: null };
    }
    case 'select':
      return { ...s, selection: a.selection };
    case 'edit':
      return edit(s, a.venue);
    case 'unit':
      // Kept with the venue (an edit like any other: saved, and undone with
      // Undo), so its lengths show in this unit wherever it is drawn.
      return a.unit === s.unit ? s : edit(s, withVenueLengthUnit(v, a.unit), { unit: a.unit });
    case 'snap':
      return { ...s, snap: a.on };
    case 'show':
      return { ...s, show: { ...s.show, [a.layer]: a.on } };
  }
}

// Moves go in whole inches.
function snapDelta(d: Pt): Pt {
  const r = (x: number) => Math.round(x / DEFAULT_STEP_STUDS) * DEFAULT_STEP_STUDS;
  return { x: r(d.x), y: r(d.y) };
}

// A point along a wall at whole inches from its start.
function snapT(v: Venue, edge: number, seg: number, t: number): number {
  const e = v.edges[edge]!;
  const len = dist(e.poly[seg]!, e.poly[seg + 1]!);
  if (len <= 0) return t;
  return Math.max(0, Math.min(1, (Math.round((t * len) / DEFAULT_STEP_STUDS) * DEFAULT_STEP_STUDS) / len));
}

/** The line or shape being drawn, for the canvas to preview. */
export function preview(s: DesignerState): { line?: [Pt, Pt]; rect?: [Pt, Pt]; cut?: [Pt, Pt]; length?: number } {
  const p = s.pointer;
  if (!p) return {};
  if (s.cut) {
    const e = venueOf(s).edges[s.cut.edge];
    const a = e?.poly[s.cut.seg], b = e?.poly[s.cut.seg + 1];
    const t = tOnCut(s, p);
    if (!a || !b || t === null) return {};
    const p0 = lerp(a, b, s.cut.t0), p1 = lerp(a, b, t);
    return { cut: [p0, p1], length: dist(p0, p1) };
  }
  const a = s.draft[s.draft.length - 1];
  if (!a) return {};
  if (s.tool === 'wall' || s.tool === 'railing' || s.tool === 'measure') return { line: [a, p], length: dist(a, p) };
  return { rect: [a, p] };
}
