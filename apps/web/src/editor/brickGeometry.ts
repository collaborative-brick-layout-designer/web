// BlueBrick brick geometry — port of desktop parts/BrickPlacement.h.
//
// A brick's displayArea is the box around its rotated hull; its sprite
// centre (BlueBrick's pivot) sits `imageOffset` from the box centre, which
// is non-zero only for parts with an XML <hull>. Connection points, ruler
// attachments and rotation are all relative to the pivot. The footprint
// maths lives in @cld/parts-catalog (footprint.ts).

import { footprint } from '@cld/parts-catalog/browser';
import { areaCentre, areaForPivot, areaSize, pivotOf, rotated, type Pt } from '@cld/modules';
import type { Brick, RectangleF } from '@cld/model';
import type { PartWire } from '../api';

/** What the geometry needs from a catalog part. */
export type PartGeom = Pick<PartWire, 'pxPerStud' | 'hullPts' | 'spriteSize'> & {
  connections?: PartWire['connections'];
};

// The pivot and box maths is shared with the server (@cld/modules geometry.ts).
export { areaCentre, areaForPivot, areaSize, pivotOf, rotated, type Pt };

/** World position (studs) of connection `index`, from the pivot. */
export function connectionWorld(brick: Pick<Brick, 'displayArea' | 'orientation'>, part: PartGeom | undefined, index: number): Pt {
  const p = pivotOf(brick, part);
  const cp = part?.connections?.[index];
  if (!cp) return p;
  const r = rotated(cp, brick.orientation);
  return { x: p.x + r.x, y: p.y + r.y };
}

/**
 * Turn bricks by `degrees` around the selection's pivot — the mean of
 * their sprite centres, so a single brick turns in place — recomputing
 * each displayArea from the turned footprint (MapView::rotateSelected).
 */
export function rotateAroundPivots(
  bricks: readonly { brick: Pick<Brick, 'displayArea' | 'orientation'>; part: PartGeom | undefined }[],
  degrees: number,
  about?: Pt,
): { orientation: number; displayArea: RectangleF }[] {
  if (bricks.length === 0) return [];
  const centres = bricks.map(({ brick, part }) => pivotOf(brick, part));
  const pivot = about ?? {
    x: centres.reduce((s, c) => s + c.x, 0) / centres.length,
    y: centres.reduce((s, c) => s + c.y, 0) / centres.length,
  };
  return bricks.map(({ brick, part }, i) => {
    const orientation = brick.orientation + degrees;
    const r = rotated({ x: centres[i]!.x - pivot.x, y: centres[i]!.y - pivot.y }, degrees);
    return { orientation, displayArea: areaForPivot(part, orientation, { x: pivot.x + r.x, y: pivot.y + r.y }, brick.displayArea) };
  });
}

/**
 * Earlier builds kept a brick's displayArea size when turning or placing
 * it, and drew the sprite at the box centre; BlueBrick recomputes the size
 * on load and keeps the stored corner, so it shows such bricks shifted.
 * The corrected displayArea for a brick whose box doesn't match its
 * footprint (keeping the sprite where the old build drew it, at the box
 * centre), or null when it already matches or the part is unknown
 * (desktop fixStaleAreas).
 */
export function staleAreaFix(brick: Pick<Brick, 'displayArea' | 'orientation'>, part: PartGeom | undefined): RectangleF | null {
  const fp = part ? footprint(part, brick.orientation) : null;
  if (!fp) return null;
  const a = brick.displayArea;
  if (Math.abs(fp.size.w - a.width) <= 0.01 && Math.abs(fp.size.h - a.height) <= 0.01) return null;
  return areaForPivot(part, brick.orientation, areaCentre(a));
}

