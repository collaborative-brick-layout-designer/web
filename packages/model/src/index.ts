// Shared TS types for the .bbm map model. Mirrors the desktop CLD's
// `src/core/` data model without depending on Qt/C++. Used by:
//   - packages/bbm  → reads/writes .bbm + .bbm.cld
//   - packages/ydoc → seeds and reconstructs Yjs docs
//   - apps/web      → drives Konva rendering
//   - apps/server   → import/export + access rules
//
// IDs are strings: vanilla BlueBrick uses decimal `ulong` ids, the desktop
// fork uses GUIDs and migrates to numeric on save. We preserve whatever was
// on disk and let the writer decide what to emit.
//
// The on-disk XML is pinned by a property test against vendored fixtures —
// see packages/bbm/tests/fixtures/.

export const BBM_FORMAT_VERSION = 9;

// ---------------------------------------------------------------------------
// Primitive value types
// ---------------------------------------------------------------------------

export interface RectangleF {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PointF {
  x: number;
  y: number;
}

/**
 * BlueBrick's color spec is two-element: a `IsKnownColor` flag plus a Name
 * field that's either a known-color name (e.g. "CornflowerBlue") or a raw
 * ARGB hex string ("ffd3d3d3").
 *
 * We expose this as a tagged union so callers don't have to inspect both
 * fields. The writer flattens it back to the IsKnownColor/Name pair.
 */
export type ColorSpec = { kind: 'known'; name: string } | { kind: 'argb'; argb: string };

/** Font as serialised in TextCells. */
export interface FontSpec {
  family: string;
  size: number;
  /** Comma-separated style list — matches .NET's FontStyle.ToString(). */
  style: string;
}

export interface ExportInfo {
  exportPath: string;
  exportFileType: number;
  exportArea: RectangleF;
  exportScale: number;
  exportWatermark: boolean;
  exportElectricCircuit: boolean;
  exportConnectionPoints: boolean;
}

// ---------------------------------------------------------------------------
// Layer model — discriminated union
// ---------------------------------------------------------------------------

export type LayerType = 'grid' | 'brick' | 'text' | 'area' | 'ruler';

interface LayerCommon {
  id: string;
  /** Non-null on every fixture we've seen, but the schema allows missing. */
  name: string;
  visible: boolean;
  /** Percent (0-100). Required at v9. */
  transparency: number;
  hullProperties: HullProperties;
}

export interface HullProperties {
  isVisible: boolean;
  hullColor: ColorSpec;
  hullThickness: number;
}

export interface LayerGrid extends LayerCommon {
  type: 'grid';
  gridColor: ColorSpec;
  gridThickness: number;
  subGridColor: ColorSpec;
  subGridThickness: number;
  gridSizeInStud: number;
  subDivisionNumber: number;
  displayGrid: boolean;
  displaySubGrid: boolean;
  displayCellIndex: boolean;
  cellIndexFont: FontSpec;
  cellIndexColor: ColorSpec;
  cellIndexColumnType: string;
  cellIndexRowType: string;
  /**
   * Integer cell coordinate (`QPoint` in desktop, LayerGrid.h) of the grid
   * cell whose top-left corner is labelled "A1"/"1". Serialised as
   * `<CellIndexCorner><X>..</X><Y>..</Y></CellIndexCorner>`.
   */
  cellIndexCorner: PointF;
}

export interface Connexion {
  id: string;
  /** Id of the partner brick's linked connexion, or empty string when unlinked. */
  linkedTo: string;
}

export interface Brick {
  id: string;
  displayArea: RectangleF;
  /** Empty string when not in a group. */
  myGroup: string;
  partNumber: string;
  orientation: number;
  activeConnectionPointIndex: number;
  altitude: number;
  connexions: Connexion[];
}

export interface Group {
  id: string;
  partNumber?: string;
  orientation?: number;
  altitude?: number;
  /** Parent group (for nested groups), empty when at top level. */
  myGroup?: string;
}

export interface LayerBrick extends LayerCommon {
  type: 'brick';
  /** v9+ flag controlling 3D elevation rendering. */
  displayBrickElevation: boolean;
  bricks: Brick[];
  groups: Group[];
}

export interface TextCell {
  /**
   * The `<TextCell id="…">` attribute. Vanilla BlueBrick never writes it
   * (desktop LayerIO.cpp reads it when present), so it is absent for most
   * files; the reader only sets it when the attribute exists and the
   * writer only emits it when set, keeping id-less files byte-identical.
   */
  id?: string;
  displayArea: RectangleF;
  myGroup: string;
  text: string;
  orientation: number;
  fontColor: ColorSpec;
  font: FontSpec;
  /** "Near" | "Center" | "Far". */
  textAlignment: string;
}

export interface LayerText extends LayerCommon {
  type: 'text';
  textCells: TextCell[];
  groups: Group[];
}

export interface AreaCell {
  x: number;
  y: number;
  /** Per the format survey, area cells use UPPERCASE hex unlike other ColorSpec uses. */
  color: string;
}

export interface LayerArea extends LayerCommon {
  type: 'area';
  /** Element name on disk is `<AreaCellSize>`, NOT `<AreaCellSizeInStud>`. */
  areaCellSize: number;
  areas: AreaCell[];
}

/**
 * Common ruler-item header fields. Ported from desktop's
 * `RulerItemBase` (saveload/LayerIO.cpp:381-393); element order in the
 * file is: DisplayArea, MyGroup, Color, LineThickness, DisplayDistance,
 * DisplayUnit, GuidelineColor, GuidelineThickness, GuidelineDashPattern,
 * Unit, MeasureFont, MeasureFontColor.
 */
export interface RulerItemCommon {
  /**
   * Stable in-memory id used by ruler commands (`MoveRuler`,
   * `EditRuler`, `MoveRulerEndpoint`, `AttachRuler`, `DeleteRuler`).
   * Mirrors desktop's `LayerItem.guid` (LayerItem.h:18) — assigned by
   * `core::newBbmId()` when the ruler is created and never written to
   * disk (the .bbm `<LinearRuler>`/`<CircularRuler>` element has no id
   * attribute upstream — see LayerIO.cpp:427-428).
   */
  id: string;
  displayArea: RectangleF;
  myGroup: string;
  color: ColorSpec;
  lineThickness: number;
  displayDistance: boolean;
  displayUnit: boolean;
  guidelineColor: ColorSpec;
  guidelineThickness: number;
  guidelineDashPattern: number[];
  unit: number;
  measureFont: FontSpec;
  measureFontColor: ColorSpec;
}

export interface LinearRulerItem extends RulerItemCommon {
  kind: 'linear';
  point1: { x: number; y: number };
  point2: { x: number; y: number };
  attachedBrick1Id: string;
  attachedBrick2Id: string;
  offsetDistance: number;
  allowOffset: boolean;
}

export interface CircularRulerItem extends RulerItemCommon {
  kind: 'circular';
  center: { x: number; y: number };
  radius: number;
  attachedBrickId: string;
}

export type RulerItem = LinearRulerItem | CircularRulerItem;

export interface LayerRuler extends LayerCommon {
  type: 'ruler';
  rulerItems: RulerItem[];
  groups: Group[];
}

export type Layer = LayerGrid | LayerBrick | LayerText | LayerArea | LayerRuler;

// ---------------------------------------------------------------------------
// Map (the document root)
// ---------------------------------------------------------------------------

export interface MapDate {
  day: number;
  month: number;
  year: number;
}

export interface BbmMap {
  /** Always `BBM_FORMAT_VERSION` for newly authored docs. Preserved on import. */
  version: number;
  /** Sum of items across all layers — re-derived on write. */
  nbItems: number;
  backgroundColor: ColorSpec;
  author: string;
  lug: string;
  event: string;
  date: MapDate;
  comment: string;
  exportInfo: ExportInfo;
  selectedLayerIndex: number;
  layers: Layer[];
}
export * from './legoColors.js';
