// Pure placement math for dropping / importing a module — port of the
// module branch of desktop `MapView::dropEvent` (MapView.cpp:1900-2060)
// and `batchesFromModuleMap` (MainWindow.cpp:1291-1308).

import type { BbmMap } from '@cld/model';
import { moduleBatchesFromMap } from '@cld/modules';
import type { PartWire } from '../api';
import type { ModuleBatch } from './mutations';
import { connKey, freeConnectionsCached, lookupPart } from './snap';
import { applyGroupTurn, facingTurn, holdReach, pickSnap, type GroupTurn, type SnapCandidate, type SnapSession } from './snapFeel';
import { areaForPivot, pivotOf } from './brickGeometry';
import { gridShift, snapCorner, stepShift, type SnapMode } from './gridSnap';

// (Shared with the server: @cld/modules batches.ts.)
export { moduleBatchesFromMap };

/** The part a group of parts (a module dropped, a paste) snaps to the grid by, as BlueBrick drops a group: the first that has a connection, else the first. */
export function snapLead<B extends { partNumber: string }>(bricks: readonly B[], partsByKey: Map<string, PartWire> | null): B | undefined {
  for (const b of bricks) {
    const meta = partsByKey ? lookupPart(partsByKey, b.partNumber) : undefined;
    if (meta?.connections.some((c) => c.type)) return b;
  }
  return bricks[0];
}

function moduleSnapLead(batches: ModuleBatch[], partsByKey: Map<string, PartWire> | null): ModuleBatch['bricks'][number] | undefined {
  return snapLead(batches.flatMap((b) => b.bricks), partsByKey);
}

/**
 * A paste's or duplicate's move, onto the grid: the lead part's (snapLead)
 * snap corner goes on the nearest grid point after `offset`, as a module
 * put down does; moving in steps, `offset` rounds to whole steps (the
 * desktop's MapView::pasteClipboard).
 */
export function pasteGridOffset(
  bricks: readonly { partNumber: string; displayArea: { x: number; y: number; width: number; height: number }; orientation?: number }[],
  offset: { dx: number; dy: number },
  snapStepStuds: number,
  partsByKey: Map<string, PartWire> | null,
  mode: SnapMode = 'grid',
): { dx: number; dy: number } {
  // Moving in steps: whole steps from the copied parts.
  if (mode === 'steps') {
    const s = stepShift({ x: offset.dx, y: offset.dy }, snapStepStuds);
    return { dx: offset.dx + s.x, dy: offset.dy + s.y };
  }
  const lead = snapStepStuds > 0 ? snapLead(bricks, partsByKey) : undefined;
  if (!lead) return offset;
  const corner = snapCorner(
    { displayArea: lead.displayArea, orientation: lead.orientation ?? 0 },
    partsByKey ? lookupPart(partsByKey, lead.partNumber) : undefined,
  );
  const shift = gridShift({ x: corner.x + offset.dx, y: corner.y + offset.dy }, snapStepStuds);
  return { dx: offset.dx + shift.x, dy: offset.dy + shift.y };
}

/** Connection snap for a module drop: reach, the drag's session, Alt, the drop. */
export interface ModuleSnapOptions {
  /** Reach in studs (`snapReachStuds`); 0 = no connection snap. */
  reach: number;
  session?: SnapSession;
  bypass?: boolean;
  final?: boolean;
}

/**
 * Translation that drops a module onto `target` (studs) like desktop:
 *   1. the module's centroid (mean brick centre) goes under the cursor;
 *   2. with a grid step, its lead part (the first with a connection, else
 *      the first) puts its snap corner on the grid, as BlueBrick drops a
 *      group (gridSnap.ts);
 *   3. connection-snap pass: if any free connection of the placed module
 *      lands within reach of a free compatible connection in the host,
 *      shift the whole module by the smallest such gap. No rotation —
 *      modules drop at a fixed orientation.
 */
export function moduleDropTranslation(
  batches: ModuleBatch[],
  target: { x: number; y: number },
  snapStepStuds: number,
  host: BbmMap | null,
  partsByKey: Map<string, PartWire> | null,
  snap: ModuleSnapOptions = { reach: 0 },
): { dx: number; dy: number; ringStudX?: number; ringStudY?: number; turn?: GroupTurn } {
  let cx = 0;
  let cy = 0;
  let n = 0;
  for (const batch of batches) {
    for (const b of batch.bricks) {
      const a = b.displayArea;
      cx += a.x + a.width / 2;
      cy += a.y + a.height / 2;
      n++;
    }
  }
  if (n === 0) return { dx: 0, dy: 0 };
  cx /= n;
  cy /= n;
  let tx = target.x;
  let ty = target.y;
  const lead = moduleSnapLead(batches, partsByKey);
  if (snapStepStuds > 0 && lead) {
    const corner = snapCorner(
      { displayArea: lead.displayArea, orientation: lead.orientation ?? 0 },
      partsByKey ? lookupPart(partsByKey, lead.partNumber) : undefined,
    );
    const shift = gridShift({ x: corner.x + tx - cx, y: corner.y + ty - cy }, snapStepStuds);
    tx += shift.x;
    ty += shift.y;
  }
  const dx = tx - cx;
  const dy = ty - cy;

  const reach = snap.bypass ? 0 : snap.reach;
  if (host && partsByKey && reach > 0) {
    const targets = freeConnectionsCached(host, partsByKey);
    const limit = holdReach(reach);
    const limitSq = limit * limit;
    interface Pair extends SnapCandidate {
      ex: number;
      ey: number;
      tx: number;
      ty: number;
      wx: number;
      wy: number;
      delta: number;
    }
    const pairs: Pair[] = [];
    if (targets.length > 0) {
      let brickIndex = 0;
      for (const batch of batches) {
        for (const b of batch.bricks) {
          const bi = brickIndex++;
          const meta = lookupPart(partsByKey, b.partNumber);
          if (!meta || meta.connections.length === 0) continue;
          const at = pivotOf(b as { displayArea: typeof b.displayArea; orientation: number }, meta);
          const bx = at.x + dx;
          const by = at.y + dy;
          const t = ((b.orientation ?? 0) * Math.PI) / 180;
          const cos = Math.cos(t);
          const sin = Math.sin(t);
          for (let ci = 0; ci < meta.connections.length; ci++) {
            const c = meta.connections[ci]!;
            if (!c.type) continue;
            const wx = bx + c.x * cos - c.y * sin;
            const wy = by + c.x * sin + c.y * cos;
            for (const tc of targets) {
              if (tc.type !== c.type) continue;
              const ex = tc.x - wx;
              const ey = tc.y - wy;
              const sq = ex * ex + ey * ey;
              if (sq > limitSq) continue;
              // The module turns as a whole to face the end, at any angle.
              const delta = facingTurn(tc.angle, c.angle + (b.orientation ?? 0));
              pairs.push({
                movingKey: `module#${bi}#${ci}`,
                targetKey: connKey(tc.brickId, tc.index),
                dist: Math.sqrt(sq),
                mouseDist: Math.hypot(wx - target.x, wy - target.y),
                turn: Math.abs(delta),
                ex,
                ey,
                tx: tc.x,
                ty: tc.y,
                wx,
                wy,
                delta,
              });
            }
          }
        }
      }
    }
    const best = snap.session
      ? snap.session.step(pairs, reach, { ...(snap.final ? { final: true } : {}) })
      : pickSnap(pairs, null, reach);
    if (best) {
      const out = { dx: dx + best.ex, dy: dy + best.ey, ringStudX: best.tx, ringStudY: best.ty };
      if (Math.abs(best.delta) <= 1e-6) return out;
      // Turned about the joined connection (where the drop put it, before
      // the snap), then onto the target.
      return { ...out, dx, dy, turn: { degrees: best.delta, pivotX: best.wx, pivotY: best.wy, toX: best.tx, toY: best.ty } };
    }
  } else if (snap.session) {
    snap.session.lock = null;
  }
  return { dx, dy };
}

/**
 * The module's batches where a drop puts them: moved by `offset` and, when
 * the snap turned the module, turned about the joined connection
 * (moduleDropTranslation). Insert the result with no further offset.
 */
export function placedModuleBatches(
  batches: ModuleBatch[],
  drop: { dx: number; dy: number; turn?: GroupTurn },
  partsByKey: Map<string, PartWire> | null,
): ModuleBatch[] {
  return batches.map((batch) => ({
    ...batch,
    bricks: batch.bricks.map((b) => {
      const area = { ...b.displayArea, x: b.displayArea.x + drop.dx, y: b.displayArea.y + drop.dy };
      if (!drop.turn) return { ...b, displayArea: area };
      const part = partsByKey ? lookupPart(partsByKey, b.partNumber) : undefined;
      const orientation = (b.orientation ?? 0) + drop.turn.degrees;
      const p = pivotOf({ displayArea: area, orientation: b.orientation ?? 0 }, part);
      const to = applyGroupTurn(drop.turn, p.x, p.y);
      return { ...b, orientation: ((orientation % 360) + 360) % 360, displayArea: areaForPivot(part, orientation, to, area) };
    }),
  }));
}
