// The ranges of the settings a map is drawn from (every sheet's own, a
// grid's, an area sheet's and each ruler's), kept when a layout is made
// from a .bbm (seedFromBbm). A value out of range is brought to the
// nearest end; one that isn't a number (NaN, infinite) gets the default; a
// dash pattern that isn't drawable is dropped (a solid guideline), and a
// cell-index corner that isn't an {x, y} object is the default corner (a
// font, hull or point that isn't an object is left as it is: there is
// nothing in it to keep in range, and spreading it would make an object of
// a string's characters). Nothing
// a layout made in either app holds is changed, and a file is never
// refused for these.
//
// The same ranges and defaults as the desktop (core::keepDrawnSettingsInRange,
// src/core/DrawnLimits.h), so one file opens the same in both apps. Each is
// inside what the server takes (fixtures/contracts/update-guard.json ›
// drawingSettings.limits, apps/server/src/ws/drawingSettings.ts), so the
// layout made is never one the live route would refuse an edit to.

import type { BbmMap, FontSpec, Layer, RulerItem } from '@cld/model';

interface Range {
  min: number;
  max: number;
  fallback: number;
}

/** The ranges, as the desktop's `limits` namespace. */
export const DRAWN_LIMITS = {
  transparency: { min: 0, max: 100, fallback: 100 },
  hullThickness: { min: 1, max: 100, fallback: 1 },
  gridSizeInStud: { min: 1, max: 2147483647, fallback: 32 },
  subDivisionNumber: { min: 2, max: 100, fallback: 4 },
  gridThickness: { min: 0, max: 100, fallback: 2 },
  subGridThickness: { min: 0, max: 100, fallback: 1 },
  cellIndexCorner: { min: -1_000_000, max: 1_000_000, fallback: 0 },
  areaCellSize: { min: 1, max: 1024, fallback: 32 },
  lineThickness: { min: 0, max: 100, fallback: 1 },
  guidelineThickness: { min: 0, max: 100, fallback: 1 },
  /** 0 studs, 1 LDU, 2 tracks, 3 modules, 4 meters, 5 feet; anything else is studs. */
  rulerUnit: { min: 0, max: 5, fallback: 0 },
  rulerCoordinate: { min: -1e7, max: 1e7, fallback: 0 },
  rulerRadius: { min: 0, max: 1e7, fallback: 0 },
  fontSize: { min: 1, max: 500, fallback: 8.25 },
  maxDashEntries: 64,
  maxDash: 1000,
  minDashTotal: 0.01,
} as const;

const L = DRAWN_LIMITS;

/** `v` in range; not a number, the default; not there, still not there (the apps use their default). */
const keep = (v: number, r: Range): number => {
  if (v === undefined) return v;
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(r.max, Math.max(r.min, v)) : r.fallback;
};
/** A whole number in range (the desktop holds an int); a fraction is rounded first. */
const keepInt = (v: number, r: Range): number => keep(typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : v, r);
/**
 * A plain object (not null, not an array). A field that should hold one
 * may hold something else in a damaged document (layouts imported before
 * 2026-09-27 hold the cell-index corner as the XML element's whitespace
 * text): spreading a string or an array would make an object of its
 * characters, so such a value is never spread.
 */
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v);
/** A font with its size in range; a value that isn't an object stays as it is (see isRecord). */
const keepFont = (f: FontSpec): FontSpec => (isRecord(f) ? { ...f, size: keep(f.size, L.fontSize) } : f);
const keepPoint = (p: { x: number; y: number }): { x: number; y: number } =>
  isRecord(p) ? { ...p, x: keep(p.x, L.rulerCoordinate), y: keep(p.y, L.rulerCoordinate) } : p;

/** A drawable dash pattern, or none (a solid guideline). */
function keepDashes(dashes: readonly number[]): number[] {
  if (!Array.isArray(dashes)) return [];
  const drawable = dashes.length <= L.maxDashEntries && dashes.every((d) => typeof d === 'number' && Number.isFinite(d) && d >= 0 && d <= L.maxDash);
  if (!drawable) return [];
  return dashes.length > 0 && dashes.reduce((a, b) => a + b, 0) < L.minDashTotal ? [] : [...dashes];
}

function keepRuler(r: RulerItem): RulerItem {
  const unit = r.unit === undefined || (Number.isInteger(r.unit) && r.unit >= L.rulerUnit.min && r.unit <= L.rulerUnit.max) ? r.unit : L.rulerUnit.fallback;
  const common = {
    lineThickness: keep(r.lineThickness, L.lineThickness),
    guidelineThickness: keep(r.guidelineThickness, L.guidelineThickness),
    guidelineDashPattern: r.guidelineDashPattern === undefined ? r.guidelineDashPattern : keepDashes(r.guidelineDashPattern),
    unit,
    measureFont: keepFont(r.measureFont),
  };
  if (r.kind === 'linear') {
    return { ...r, ...common, point1: keepPoint(r.point1), point2: keepPoint(r.point2), offsetDistance: keep(r.offsetDistance, L.rulerCoordinate) };
  }
  return { ...r, ...common, center: keepPoint(r.center), radius: keep(r.radius, L.rulerRadius) };
}

function keepLayer(layer: Layer): Layer {
  const common = {
    transparency: keep(layer.transparency, L.transparency),
    hullProperties: isRecord(layer.hullProperties)
      ? { ...layer.hullProperties, hullThickness: keep(layer.hullProperties.hullThickness, L.hullThickness) }
      : layer.hullProperties,
  };
  switch (layer.type) {
    case 'grid':
      return {
        ...layer,
        ...common,
        gridSizeInStud: keep(layer.gridSizeInStud, L.gridSizeInStud),
        subDivisionNumber: keepInt(layer.subDivisionNumber, L.subDivisionNumber),
        gridThickness: keep(layer.gridThickness, L.gridThickness),
        subGridThickness: keep(layer.subGridThickness, L.subGridThickness),
        cellIndexFont: keepFont(layer.cellIndexFont),
        // Not an object (a string, an array, a number): the default corner.
        cellIndexCorner:
          layer.cellIndexCorner === undefined
            ? layer.cellIndexCorner
            : isRecord(layer.cellIndexCorner)
              ? {
                  ...layer.cellIndexCorner,
                  x: keepInt(layer.cellIndexCorner.x, L.cellIndexCorner),
                  y: keepInt(layer.cellIndexCorner.y, L.cellIndexCorner),
                }
              : { x: L.cellIndexCorner.fallback, y: L.cellIndexCorner.fallback },
      };
    case 'area':
      return { ...layer, ...common, areaCellSize: keepInt(layer.areaCellSize, L.areaCellSize) };
    case 'ruler':
      return {
        ...layer,
        ...common,
        rulerItems: Array.isArray(layer.rulerItems) ? layer.rulerItems.map((r) => (isRecord(r) ? keepRuler(r) : r)) : layer.rulerItems,
      };
    default:
      return { ...layer, ...common };
  }
}

/**
 * `map` with every drawn setting in its range (see above). The map passed
 * in is left as it is; layers whose settings were all in range come out
 * equal to it.
 */
export function keepDrawnSettingsInRange(map: BbmMap): BbmMap {
  return { ...map, layers: map.layers.map(keepLayer) };
}
