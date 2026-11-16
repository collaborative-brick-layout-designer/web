// BlueBrick brick geometry (port of desktop parts/BrickPlacement.h), for
// the server and the web alike.
//
// A brick's displayArea is the box around its rotated hull; its sprite
// centre (BlueBrick's pivot) sits `imageOffset` from the box centre, which
// is non-zero only for parts with an XML <hull>. Connection points, ruler
// attachments and rotation are all relative to the pivot. The footprint
// maths lives in @cld/parts-catalog (footprint.ts).

import { footprint, imageOffset, type FootprintPart } from '@cld/parts-catalog/browser';
import type { RectangleF } from '@cld/model';

/** What the geometry needs from a catalog part. */
export type PartGeom = FootprintPart;

/** A part's geometry by the number a brick names it by; undefined when the part isn't known. */
export type PartLookup = (partNumber: string) => PartGeom | undefined;

export type Pt = { x: number; y: number };

export function rotated(v: Pt, degrees: number): Pt {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

export function areaCentre(a: RectangleF): Pt {
  return { x: a.x + a.width / 2, y: a.y + a.height / 2 };
}

/** The brick's pivot: its sprite centre, in studs. */
export function pivotOf(brick: { displayArea: RectangleF; orientation: number }, part: PartGeom | undefined): Pt {
  const c = areaCentre(brick.displayArea);
  if (!part) return c;
  const off = imageOffset(part, brick.orientation);
  return { x: c.x + off.x, y: c.y + off.y };
}

/**
 * displayArea size for a part at `orientation`: its footprint, else the
 * brick's current size (BlueBrick draws unknown parts at their stored
 * size), else 2 x 2 studs.
 */
export function areaSize(part: PartGeom | undefined, orientation: number, current?: { width: number; height: number }): { width: number; height: number } {
  const fp = part ? footprint(part, orientation) : null;
  if (fp) return { width: fp.size.w, height: fp.size.h };
  if (current && current.width > 0 && current.height > 0) return { width: current.width, height: current.height };
  return { width: 2, height: 2 };
}

/** The displayArea that puts the brick's pivot at `pivot` for `orientation`. */
export function areaForPivot(
  part: PartGeom | undefined,
  orientation: number,
  pivot: Pt,
  current?: { width: number; height: number },
): RectangleF {
  const size = areaSize(part, orientation, current);
  const off = part ? imageOffset(part, orientation) : { x: 0, y: 0 };
  return {
    x: pivot.x - off.x - size.width / 2,
    y: pivot.y - off.y - size.height / 2,
    width: size.width,
    height: size.height,
  };
}
