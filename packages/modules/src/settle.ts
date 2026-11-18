// Finishing an undo or redo for a shared module (docs/shared-modules.md,
// phase 3; doc shape 5).
//
// An update that keeps a shared module's unchanged parts (keepIds.ts)
// leaves a person's earlier undo steps pointing at those parts, but not at
// the new ones. Undoing a move then moves only the kept parts back; undoing
// placing it (or pasting or duplicating it) takes only the kept parts
// away. Either would pull the module apart. So right after an undo or redo,
// in the same change, the apps finish it for the whole module:
//
//   1. its record went: every part of it still on the map goes too;
//   2. some of its parts went, its record didn't: the rest go, and the
//      record (the module removed whole, as the undo meant);
//   3. some of its parts moved (place, turn or sheet), the rest didn't: the
//      rest move the same way: turned by the same amount about their pivots
//      and moved by the same shift, taken from the first part that moved
//      (in the module's order), and put on the sheet the moved parts went to
//      from theirs.
//
// The web (editor/useUndoManager.ts) and the desktop (sync/SyncSession.cpp,
// edit/SharedSettle.cpp) do the same; shared vectors in
// fixtures/contracts/shared-module-settle.json.

import type { RectangleF } from '@cld/model';
import { areaForPivot, pivotOf, rotated, type PartLookup } from './geometry.js';
import { norm360 } from './placement.js';

/** One of a module's parts, where it is. */
export interface SettlePart {
  id: string;
  sheet: string;
  partNumber: string;
  displayArea: RectangleF;
  orientation: number;
}

/** A shared module, before or after the undo: whether its record is there, and its parts on the map (in its order). */
export interface SettleSide {
  record: boolean;
  parts: SettlePart[];
}

export interface Settled {
  /** Parts to remove. */
  remove: string[];
  /** Remove the module's record too. */
  removeModule: boolean;
  /** Parts to move: where each goes (its new place, turn and sheet). */
  move: SettlePart[];
}

const NOTHING: Settled = { remove: [], removeModule: false, move: [] };
const SAME = 1e-9;

const samePose = (a: SettlePart, b: SettlePart): boolean =>
  a.sheet === b.sheet &&
  Math.abs(a.displayArea.x - b.displayArea.x) < SAME &&
  Math.abs(a.displayArea.y - b.displayArea.y) < SAME &&
  Math.abs(a.displayArea.width - b.displayArea.width) < SAME &&
  Math.abs(a.displayArea.height - b.displayArea.height) < SAME &&
  Math.abs(norm360(a.orientation) - norm360(b.orientation)) < SAME;

/**
 * What finishes an undo or redo for one shared module, from how it was
 * before (`before`, its parts in its order) and after (`after`).
 */
export function settleShared(before: SettleSide, after: SettleSide, partOf: PartLookup): Settled {
  if (!before.record || before.parts.length === 0) return NOTHING;
  const now = new Map(after.parts.map((p) => [p.id, p] as const));
  const alive = before.parts.filter((p) => now.has(p.id));
  // 1. Its record went.
  if (!after.record) return alive.length > 0 ? { remove: alive.map((p) => p.id), removeModule: false, move: [] } : NOTHING;
  // 2. Some of its parts went.
  if (alive.length < before.parts.length) return { remove: alive.map((p) => p.id), removeModule: true, move: [] };
  // 3. Some of its parts moved.
  const moved = before.parts.filter((p) => !samePose(p, now.get(p.id)!));
  if (moved.length === 0 || moved.length === before.parts.length) return NOTHING;
  const first = moved[0]!;
  const to = now.get(first.id)!;
  const turn = to.orientation - first.orientation;
  const from = pivotOf({ displayArea: first.displayArea, orientation: first.orientation }, partOf(first.partNumber));
  const at = pivotOf({ displayArea: to.displayArea, orientation: to.orientation }, partOf(to.partNumber));
  const r = rotated(from, turn);
  const shift = { x: at.x - r.x, y: at.y - r.y };
  // Which sheet the moved parts went to from each sheet.
  const sheetTo = new Map<string, string>();
  for (const p of moved) if (!sheetTo.has(p.sheet)) sheetTo.set(p.sheet, now.get(p.id)!.sheet);
  const move: SettlePart[] = [];
  for (const p of before.parts) {
    if (moved.includes(p)) continue;
    const part = partOf(p.partNumber);
    const pivot = rotated(pivotOf({ displayArea: p.displayArea, orientation: p.orientation }, part), turn);
    const orientation = norm360(p.orientation + turn);
    move.push({
      id: p.id,
      sheet: sheetTo.get(p.sheet) ?? p.sheet,
      partNumber: p.partNumber,
      orientation,
      displayArea: areaForPivot(part, orientation, { x: pivot.x + shift.x, y: pivot.y + shift.y }, p.displayArea),
    });
  }
  return { remove: [], removeModule: false, move };
}
