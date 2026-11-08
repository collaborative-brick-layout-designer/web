// Local-only editor state. Selection, current tool, viewport pan/zoom.
// Phase 4 will project a slim subset of this to Yjs awareness so other
// users can see "alice is hovering on this brick"; in Phase 3 it stays
// purely local.

import { create } from 'zustand';
import { DEFAULT_SNAP_STRENGTH, type SnapStrength } from './snapFeel';

export type Tool =
  | 'select'
  | 'rotate'
  | 'delete'
  | 'paint'
  | 'erase'
  | 'rulerLinear'
  | 'rulerCircular'
  | 'venueOutline'
  | 'venueObstacle';

/**
 * Snap-step values offered in the toolbar. Mirrors desktop
 * PreferencesDialog.cpp:118-122 — `[off, 32, 16, 8, 4, 2, 1, 0.5]`
 * studs. 0 means "no grid snap" (connection snap still fires).
 */
export const SNAP_STEPS = [0, 32, 16, 8, 4, 2, 1, 0.5] as const;

/**
 * Rotation-step values. Mirrors desktop's rotation-step submenu
 * (MainWindowMenus.cpp:403-415) — 90 / 45 / 22.5 / 11.25 / 5 / 1°.
 */
export const ROTATION_STEPS = [90, 45, 22.5, 11.25, 5, 1] as const;

/**
 * Non-brick items in the selection — desktop selects rulers, anchored
 * labels and text cells together with bricks (Qt scene selection,
 * MapViewDrag.cpp:124-153). Text cells are keyed `${layerId}#${index}`
 * (see `textKey` in mixedSelection.ts); text cells have no id.
 */
/** What a saved view shows on screen: see EditorState.viewFilter. */
export interface ViewFilter {
  /** Layer ids shown, or null for the layout's own on/off. */
  sheets: string[] | null;
  grid: boolean;
  labels: boolean;
}

export interface AnnoSelection {
  rulers: string[];
  labels: string[];
  texts: string[];
}

export const EMPTY_ANNO: AnnoSelection = Object.freeze({
  rulers: [],
  labels: [],
  texts: [],
}) as AnnoSelection;

export type NoticeKind = 'busy' | 'done' | 'error';

export interface Notice {
  id: number;
  text: string;
  kind: NoticeKind;
  /** A button on the notice that fixes what it says (e.g. "Show sheet"). */
  action?: NoticeAction;
}

export interface NoticeAction {
  label: string;
  run: () => void;
}

/** The "→ <sheet>" tag that rides with a part dragged over the map. */
export interface DropTag {
  sheet: string;
  hidden: boolean;
  /** Viewport position of the pointer. */
  x: number;
  y: number;
}

let noticeSeq = 0;

/** Tell the user a file went to their Downloads folder (browsers often show nothing). */
export function noticeDownloaded(filename: string): void {
  useEditorStore.getState().showNotice(`Downloaded “${filename}”. Look in your Downloads folder.`, 'done', 7000);
}

/**
 * Shapes every new selection: modules are picked as one piece, and while a
 * module is being edited only its parts can be picked (moduleEdit.ts).
 * The editor installs it; plain tests keep the identity.
 */
let selectionShaper: (ids: string[]) => string[] = (ids) => ids;
export function setSelectionShaper(shaper: ((ids: string[]) => string[]) | null): void {
  selectionShaper = shaper ?? ((ids) => ids);
}
/** The selection `ids` would become (whole modules, or only the edited module's parts). */
export function shapeSelectionIds(ids: string[]): string[] {
  return selectionShaper(ids);
}

export type ModuleDialog = { kind: 'make' } | { kind: 'save' | 'publish'; moduleId: string };

export interface EditorState {
  tool: Tool;
  /**
   * BlueBrick's Use as Model: the part a map part's menu asked the parts
   * list to show and pick (`seq` repeats a request for the same part).
   */
  modelPart: { key: string; seq: number } | null;
  useAsModel: (partNumber: string) => void;
  /**
   * The placed module being edited part by part ("Edit module"), or null:
   * then every module acts as one piece.
   */
  editingModuleId: string | null;
  /** Enter (an id) or leave (null) Edit module. Leaving clears the selection. */
  setEditingModule: (id: string | null) => void;
  /**
   * The module dialog open over the editor: Make a module (from the picked
   * parts), Save to library… or Update library version (a placed module).
   */
  moduleDialog: ModuleDialog | null;
  setModuleDialog: (d: ModuleDialog | null) => void;
  /** Brick ids currently selected. */
  selection: string[];
  /** Rulers / labels / text cells selected alongside `selection`. */
  annoSelection: AnnoSelection;
  /** Touch editing: a tap adds a part to the selection (or takes it out) instead of replacing it. */
  touchSelectMore: boolean;
  /** Touch editing: one finger on the map draws a box that picks what it touches, instead of moving the view. */
  touchSelectArea: boolean;
  /** Touch editing with a ruler tool: where the first tap put the ruler's start (or a circle's centre), in studs, until the second tap. */
  touchRulerStart: { x: number; y: number } | null;
  /** Layer id currently being edited. */
  activeLayerId: string | null;
  /** Part library key picked for the place tool. Empty when nothing chosen. */
  placePartKey: string;
  /** Stage zoom factor — 1 = native (1 stud = pxPerStud px). */
  zoom: number;
  /** Stage pan in stage-local pixels. */
  panX: number;
  panY: number;
  /**
   * The view the map's canvas is drawn at. The same as zoom/panX/panY,
   * except while the view moves (a pan, the wheel, a pinch): then the canvas
   * follows the view by a CSS transform, and this catches up only when the
   * move ends or leaves the picture taken for it (viewBitmap.ts). What is
   * drawn on the map reads this, so a pan renders nothing; the rest (the
   * status bar, pointer maths) reads zoom/panX/panY.
   */
  stageView: StageView;
  /**
   * Active grid-snap step in studs. 0 = grid snap disabled (connection
   * snap still applies). Default 1 stud (matches desktop default).
   */
  snapStepStuds: number;
  /**
   * Rotation step in degrees for R / Shift+R and the rotate tool.
   * Mirrors `editing/rotationStepDegrees` from desktop preferences.
   * Default 90° (matches desktop default).
   */
  rotationStepDegrees: number;
  /**
   * Live-snap indicator. Set during a drag when a connection snap is
   * firing; cleared on drag end. Coordinates are in WORLD STUDS.
   * Drives the green snap ring drawn by the canvas overlay (port of
   * SelectionOverlay::setSnapState — SelectionOverlay.cpp:63-68).
   */
  liveSnap: { studX: number; studY: number } | null;
  /** While bending flex track: the joints at their hinge limit (studs), drawn amber. */
  hingeLimits: { studX: number; studY: number }[];
  /**
   * The moving connection that joins (or would join) during a drag, in
   * world studs: drawn as a small dot so people see which end will
   * connect. Null when not dragging.
   */
  snapMoving: { studX: number; studY: number } | null;
  /**
   * Snap strength (account preference `connectionSnap`): off, gentle or
   * strong. Mirrored here from the preferences so drag handlers read it
   * without a React context.
   */
  connectionSnap: SnapStrength;
  /**
   * Paint color as AARRGGBB hex (uppercase, no leading "#"). Drives
   * the Paint Area tool. Defaults to a 50%-alpha green similar to the
   * desktop's Preferences default (`editing/paintColor`).
   */
  paintColor: string;
  /** Last known mouse position in WORLD STUDS — drives the status-bar HUD. */
  hudMouseStudX: number | null;
  hudMouseStudY: number | null;

  /** View toggle: show/hide connection-point dots (persisted). Desktop View menu. */
  showConnectionPoints: boolean;
  /** View toggle: show/hide the grid layer (persisted). Desktop View menu. */
  showGrid: boolean;
  /** View toggle: draw brick hull outlines (`view/brickHulls`). */
  showBrickHulls: boolean;
  /** View toggle: draw per-brick altitude badge labels (`view/brickElevation`). */
  showBrickElevation: boolean;
  /** View toggle: show ruler attach-point markers (`view/rulerAttachPoints`). */
  showRulerAttachPoints: boolean;
  /**
   * When true, connection-point dots render at full brightness on every
   * brick, not just selected ones. Desktop `appearance/alwaysShowConnections`.
   */
  alwaysShowConnections: boolean;
  /**
   * Wheel-zoom speed multiplier. 1.0 = desktop default (1.0015^delta).
   * Values > 1 zoom faster, < 1 slower. Mirrors `general/wheelZoomFactor`.
   */
  wheelZoomFactor: number;
  /**
   * Selection halo color as RRGGBB hex (no leading #, no alpha).
   * Mirrors `appearance/selectionTint`. Default is desktop gold FFD700.
   */
  selectionTint: string;
  /** Show module name labels on canvas (`view/moduleNames`). */
  showModuleNames: boolean;
  /**
   * Draw every sheet but the active one faded (`cld:fadeOtherSheets`, off by
   * default). A viewer preference only: never in the layout, never synced,
   * and exports draw without it (exportRender.ts).
   */
  fadeOtherSheets: boolean;
  setFadeOtherSheets: (v: boolean) => void;
  /** View → Status Bar: on by default, for this session only, like desktop (MainWindowMenus.cpp:524-527). */
  showStatusBar: boolean;
  setShowStatusBar: (v: boolean) => void;
  /** Budget → Use Budget Limitation: refuse to place parts over budget (`budget/useBudgetLimitation`, default off). */
  useBudgetLimitation: boolean;
  /** Parts without a limit are unlimited (true) or forbidden (false) (`budget/defaultInfinite`, default true). */
  budgetDefaultInfinite: boolean;
  /** Show the "Budget reached" box on a refusal (`general/warnBudgetLimitation`, default true). */
  warnBudgetLimitation: boolean;
  /** Budget → Show Only Budgeted Parts in the parts panel (`budget/showOnlyBudgetedParts`). */
  showOnlyBudgetedParts: boolean;
  /** Budget → Show Budget Numbers (used/limit) under part tiles (`budget/showBudgetNumbers`). */
  showBudgetNumbers: boolean;
  /** Module frame thickness in px (`view/moduleFrameThickness`). */
  moduleFrameThickness: number;
  /** Show electric circuit overlay (`view/electricCircuits`). No-op until circuit data exists. */
  showElectricCircuits: boolean;
  /** Stamp export watermark on canvas export (`export/watermark`). */
  showExportWatermark: boolean;
  /** Module label font size percent (`view/moduleLabelPercent`). */
  moduleLabelPercent: number;
  /** Venue edge-distance label font size in px (`appearance/venueLabelPx`). Default 28. */
  venueLabelPx: number;
  /**
   * Canvas text smaller than this on screen (CSS px) is not drawn. 0 draws
   * everything (desktop); the phone viewer sets PHONE_MIN_TEXT_PX.
   */
  minTextPx: number;
  setMinTextPx: (px: number) => void;
  /**
   * The saved view being looked at (savedViews.ts): which sheets show and
   * whether the grid and labels do. Only on this screen, never saved in
   * the layout. Null shows the layout as it is.
   */
  viewFilter: ViewFilter | null;
  /** The saved view picked last, so its row can show it; null for none. */
  activeViewId: string | null;
  /**
   * Maximum undo stack depth. 0 = unlimited (default, matches desktop default of 100).
   * Mirrors `general/undoStackDepth`.
   */
  undoStackDepth: number;
  /**
   * When true, opening the app navigates directly to the last opened layout.
   * Mirrors `general/reopenLastFile`.
   */
  reopenLastFile: boolean;
  /** Map bounding box in studs — updated by Canvas on every render. Drives the status bar. */
  hudMapWidthStuds: number | null;
  hudMapHeightStuds: number | null;

  /**
   * Transient status message shown in the status bar for ~3 s then auto-cleared.
   * Port of QMainWindow::showStatusMessage (MainWindow.cpp:861).
   */
  statusMessage: string | null;
  statusMessageTimerId: ReturnType<typeof setTimeout> | null;
  /**
   * A notice that pops up over the map for something the user asked for
   * and would otherwise miss: a download, a save, a long job's progress.
   * The status bar is for passing hints; this is for results.
   */
  notice: Notice | null;
  /**
   * Where a part / module being dragged over the canvas will land
   * ("Drop onto: <layer> ..."), shown in the status bar until the drag
   * leaves or drops. Port of MapView::showDropTargetHint (MapView.cpp:1653-1683).
   */
  dropTargetHint: string | null;
  /** Rides with a part dragged over the map, naming the sheet it will land on. */
  dropTag: DropTag | null;
  /**
   * A sheet the Sheets panel briefly lights up: where a part just went
   * when that wasn't the sheet the user had picked.
   */
  flashSheetId: string | null;

  setTool: (t: Tool) => void;
  /** Replace the selection with these bricks (clears rulers / labels / text). */
  setSelection: (ids: string[]) => void;
  /** Replace the whole mixed selection. */
  setMixedSelection: (ids: string[], anno: AnnoSelection) => void;
  toggleSelected: (id: string, additive: boolean) => void;
  setActiveLayer: (id: string | null) => void;
  setPlacePart: (key: string) => void;
  setZoom: (z: number) => void;
  setPan: (x: number, y: number) => void;
  setSnapStep: (studs: number) => void;
  setRotationStep: (degrees: number) => void;
  setLiveSnap: (p: { studX: number; studY: number } | null) => void;
  setHingeLimits: (points: { studX: number; studY: number }[]) => void;
  setSnapMoving: (p: { studX: number; studY: number } | null) => void;
  setConnectionSnap: (v: SnapStrength) => void;
  setPaintColor: (argbHex: string) => void;
  setHudMouse: (studX: number | null, studY: number | null) => void;
  setShowConnectionPoints: (v: boolean) => void;
  setShowGrid: (v: boolean) => void;
  setShowBrickHulls: (v: boolean) => void;
  setShowBrickElevation: (v: boolean) => void;
  setShowRulerAttachPoints: (v: boolean) => void;
  setAlwaysShowConnections: (v: boolean) => void;
  setWheelZoomFactor: (v: number) => void;
  setSelectionTint: (rrggbb: string) => void;
  setShowModuleNames: (v: boolean) => void;
  setUseBudgetLimitation: (v: boolean) => void;
  setBudgetDefaultInfinite: (v: boolean) => void;
  setWarnBudgetLimitation: (v: boolean) => void;
  setShowOnlyBudgetedParts: (v: boolean) => void;
  setShowBudgetNumbers: (v: boolean) => void;
  setModuleFrameThickness: (v: number) => void;
  setShowElectricCircuits: (v: boolean) => void;
  setShowExportWatermark: (v: boolean) => void;
  setModuleLabelPercent: (v: number) => void;
  setVenueLabelPx: (v: number) => void;
  setUndoStackDepth: (v: number) => void;
  setReopenLastFile: (v: boolean) => void;
  setHudMapBounds: (w: number | null, h: number | null) => void;
  /** Show a transient message in the status bar; auto-clears after `durationMs` (default 3000). */
  showStatusMessage: (msg: string, durationMs?: number) => void;
  /**
   * Pop up a notice. 'busy' stays until replaced; the others clear after
   * `durationMs` (default 6 s).
   */
  showNotice: (text: string, kind?: NoticeKind, durationMs?: number, action?: NoticeAction) => void;
  dismissNotice: () => void;
  setDropTargetHint: (hint: string | null) => void;
  setDropTag: (tag: DropTag | null) => void;
  /** Light up a sheet's row in the Sheets panel for a few seconds. */
  flashSheet: (id: string) => void;
  /**
   * Atomic zoom-around-point. Used by the wheel handler so the world
   * coordinate under the cursor stays put across the zoom step — desktop
   * achieves this via Qt's `AnchorUnderMouse` (MapView.cpp:89).
   */
  zoomAround: (newZoom: number, anchorPxX: number, anchorPxY: number) => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  tool: 'select',
  modelPart: null,
  useAsModel: (partNumber) => set((s) => ({ modelPart: { key: partNumber, seq: (s.modelPart?.seq ?? 0) + 1 } })),
  selection: [],
  editingModuleId: null,
  moduleDialog: null,
  setModuleDialog: (moduleDialog) => set({ moduleDialog }),
  annoSelection: EMPTY_ANNO,
  touchSelectMore: false,
  touchSelectArea: false,
  touchRulerStart: null,
  activeLayerId: null,
  placePartKey: '',
  zoom: 1,
  panX: 0,
  panY: 0,
  stageView: { zoom: 1, panX: 0, panY: 0 },
  statusMessage: null,
  statusMessageTimerId: null,
  notice: null,
  dropTargetHint: null,
  dropTag: null,
  flashSheetId: null,
  snapStepStuds: (() => {
    // Off by default, like desktop snapStepStuds (PreferencesDialog.cpp:137).
    const v = localStorage.getItem('cld:snapStepStuds');
    const n = v !== null ? parseFloat(v) : 0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  })(),
  rotationStepDegrees: (() => {
    const v = localStorage.getItem('cld:rotationStepDegrees');
    const n = v !== null ? parseFloat(v) : 90;
    return Number.isFinite(n) && n > 0 ? n : 90;
  })(),
  liveSnap: null,
  hingeLimits: [],
  snapMoving: null,
  connectionSnap: DEFAULT_SNAP_STRENGTH,
  hudMapWidthStuds: null,
  hudMapHeightStuds: null,
  paintColor: (() => {
    // Opaque #008000, like desktop paintColor (PreferencesDialog.cpp:152).
    const v = localStorage.getItem('cld:paintColor');
    return v ?? 'ff008000';
  })(),
  hudMouseStudX: null,
  hudMouseStudY: null,
  // Off by default, like desktop view/connectionPoints: selected bricks
  // still show their free connections (SceneBuilder.cpp:250-310).
  showConnectionPoints: localStorage.getItem('cld:showConnectionPoints') === 'true',
  showGrid: localStorage.getItem('cld:showGrid') !== 'false',
  showBrickHulls: localStorage.getItem('cld:showBrickHulls') === 'true',
  showBrickElevation: localStorage.getItem('cld:showBrickElevation') === 'true',
  showRulerAttachPoints: localStorage.getItem('cld:showRulerAttachPoints') === 'true',
  alwaysShowConnections: localStorage.getItem('cld:alwaysShowConnections') === 'true',
  wheelZoomFactor: (() => {
    const v = localStorage.getItem('cld:wheelZoomFactor');
    const n = v !== null ? parseFloat(v) : 1;
    return Number.isFinite(n) && n > 0 ? n : 1;
  })(),
  selectionTint: localStorage.getItem('cld:selectionTint') ?? 'FFD700',
  // One toggle for module names and frames, on by default (desktop
  // view/moduleNames, SceneBuilderSidecar.cpp:233-236).
  showModuleNames: localStorage.getItem('cld:showModuleNames') !== 'false',
  fadeOtherSheets: localStorage.getItem('cld:fadeOtherSheets') === 'true',
  showStatusBar: true,
  setShowStatusBar: (v) => set({ showStatusBar: v }),
  useBudgetLimitation: localStorage.getItem('cld:useBudgetLimitation') === 'true',
  budgetDefaultInfinite: localStorage.getItem('cld:budgetDefaultInfinite') !== 'false',
  warnBudgetLimitation: localStorage.getItem('cld:warnBudgetLimitation') !== 'false',
  showOnlyBudgetedParts: localStorage.getItem('cld:showOnlyBudgetedParts') === 'true',
  showBudgetNumbers: localStorage.getItem('cld:showBudgetNumbers') === 'true',
  moduleFrameThickness: (() => {
    // 5 px by default, 0.5-20 (PreferencesDialog.cpp:200-207).
    const v = localStorage.getItem('cld:moduleFrameThickness');
    const n = v !== null ? parseFloat(v) : 5;
    return Number.isFinite(n) && n > 0 ? Math.max(0.5, Math.min(20, n)) : 5;
  })(),
  undoStackDepth: (() => {
    const v = localStorage.getItem('cld:undoStackDepth');
    const n = v !== null ? parseInt(v, 10) : 100;
    return Number.isInteger(n) && n >= 0 ? n : 100;
  })(),
  reopenLastFile: localStorage.getItem('cld:reopenLastFile') === 'true',
  showElectricCircuits: localStorage.getItem('cld:showElectricCircuits') === 'true',
  showExportWatermark: localStorage.getItem('cld:showExportWatermark') === 'true',
  // Desktop `view/moduleLabelPercent`: % of the module's long axis,
  // 5..100, default 35. New storage key — the old one held a different,
  // unused scale.
  moduleLabelPercent: (() => {
    const v = localStorage.getItem('cld:moduleLabelPct');
    const n = v !== null ? parseFloat(v) : 35;
    return Number.isFinite(n) ? Math.max(5, Math.min(100, n)) : 35;
  })(),
  minTextPx: 0,
  setMinTextPx: (minTextPx) => set({ minTextPx }),
  viewFilter: null,
  activeViewId: null,
  venueLabelPx: (() => {
    const v = localStorage.getItem('cld:venueLabelPx');
    const n = v !== null ? parseInt(v, 10) : 28;
    return Number.isInteger(n) && n >= 4 ? n : 28;
  })(),

  setTool: (tool) => set({ tool, touchRulerStart: null }),
  setPaintColor: (paintColor) => {
    localStorage.setItem('cld:paintColor', paintColor);
    set({ paintColor });
  },
  setHudMouse: (hudMouseStudX, hudMouseStudY) => set({ hudMouseStudX, hudMouseStudY }),
  setShowConnectionPoints: (v) => {
    localStorage.setItem('cld:showConnectionPoints', String(v));
    set({ showConnectionPoints: v });
  },
  setShowGrid: (v) => {
    localStorage.setItem('cld:showGrid', String(v));
    set({ showGrid: v });
  },
  setShowBrickHulls: (v) => {
    localStorage.setItem('cld:showBrickHulls', String(v));
    set({ showBrickHulls: v });
  },
  setShowBrickElevation: (v) => {
    localStorage.setItem('cld:showBrickElevation', String(v));
    set({ showBrickElevation: v });
  },
  setShowRulerAttachPoints: (v) => {
    localStorage.setItem('cld:showRulerAttachPoints', String(v));
    set({ showRulerAttachPoints: v });
  },
  setAlwaysShowConnections: (v) => {
    localStorage.setItem('cld:alwaysShowConnections', String(v));
    set({ alwaysShowConnections: v });
  },
  setWheelZoomFactor: (v) => {
    const clamped = Math.max(0.1, Math.min(10, v));
    localStorage.setItem('cld:wheelZoomFactor', String(clamped));
    set({ wheelZoomFactor: clamped });
  },
  setSelectionTint: (rrggbb) => {
    const clean = rrggbb.replace(/[^0-9a-fA-F]/g, '').slice(0, 6).toUpperCase().padEnd(6, '0');
    localStorage.setItem('cld:selectionTint', clean);
    set({ selectionTint: clean });
  },
  setShowModuleNames: (v) => {
    localStorage.setItem('cld:showModuleNames', String(v));
    set({ showModuleNames: v });
  },
  setFadeOtherSheets: (v) => {
    localStorage.setItem('cld:fadeOtherSheets', String(v));
    set({ fadeOtherSheets: v });
  },
  setUseBudgetLimitation: (v) => {
    localStorage.setItem('cld:useBudgetLimitation', String(v));
    set({ useBudgetLimitation: v });
  },
  setBudgetDefaultInfinite: (v) => {
    localStorage.setItem('cld:budgetDefaultInfinite', String(v));
    set({ budgetDefaultInfinite: v });
  },
  setWarnBudgetLimitation: (v) => {
    localStorage.setItem('cld:warnBudgetLimitation', String(v));
    set({ warnBudgetLimitation: v });
  },
  setShowOnlyBudgetedParts: (v) => {
    localStorage.setItem('cld:showOnlyBudgetedParts', String(v));
    set({ showOnlyBudgetedParts: v });
  },
  setShowBudgetNumbers: (v) => {
    localStorage.setItem('cld:showBudgetNumbers', String(v));
    set({ showBudgetNumbers: v });
  },
  setModuleFrameThickness: (v) => {
    const clamped = Math.max(0.5, Math.min(20, Math.round(v * 2) / 2));
    localStorage.setItem('cld:moduleFrameThickness', String(clamped));
    set({ moduleFrameThickness: clamped });
  },
  setUndoStackDepth: (v) => {
    const clamped = Math.max(0, Math.min(1000, Math.round(v)));
    localStorage.setItem('cld:undoStackDepth', String(clamped));
    set({ undoStackDepth: clamped });
  },
  setReopenLastFile: (v) => {
    localStorage.setItem('cld:reopenLastFile', String(v));
    set({ reopenLastFile: v });
  },
  setShowElectricCircuits: (v) => {
    localStorage.setItem('cld:showElectricCircuits', String(v));
    set({ showElectricCircuits: v });
  },
  setShowExportWatermark: (v) => {
    localStorage.setItem('cld:showExportWatermark', String(v));
    set({ showExportWatermark: v });
  },
  setModuleLabelPercent: (v) => {
    const clamped = Math.max(5, Math.min(100, v));
    localStorage.setItem('cld:moduleLabelPct', String(clamped));
    set({ moduleLabelPercent: clamped });
  },
  setVenueLabelPx: (v) => {
    const clamped = Math.max(4, Math.min(200, Math.round(v)));
    localStorage.setItem('cld:venueLabelPx', String(clamped));
    set({ venueLabelPx: clamped });
  },
  setHudMapBounds: (hudMapWidthStuds, hudMapHeightStuds) => set({ hudMapWidthStuds, hudMapHeightStuds }),
  setDropTargetHint: (dropTargetHint) => set((s) => (s.dropTargetHint === dropTargetHint ? s : { dropTargetHint })),
  setDropTag: (dropTag) =>
    set((s) =>
      s.dropTag === dropTag ||
      (s.dropTag && dropTag && s.dropTag.sheet === dropTag.sheet && s.dropTag.hidden === dropTag.hidden && s.dropTag.x === dropTag.x && s.dropTag.y === dropTag.y)
        ? s
        : { dropTag },
    ),
  flashSheet: (id) => {
    set({ flashSheetId: id });
    setTimeout(() => {
      if (useEditorStore.getState().flashSheetId === id) useEditorStore.setState({ flashSheetId: null });
    }, 4000);
  },
  showNotice: (text, kind = 'done', durationMs = 6000, action) => {
    const id = ++noticeSeq;
    set({ notice: { id, text, kind, ...(action ? { action } : {}) } });
    if (kind !== 'busy') {
      setTimeout(() => {
        if (useEditorStore.getState().notice?.id === id) useEditorStore.setState({ notice: null });
      }, durationMs);
    }
  },
  dismissNotice: () => set({ notice: null }),
  showStatusMessage: (msg, durationMs = 3000) =>
    set((s) => {
      if (s.statusMessageTimerId !== null) clearTimeout(s.statusMessageTimerId);
      const id = setTimeout(() => {
        useEditorStore.setState({ statusMessage: null, statusMessageTimerId: null });
      }, durationMs);
      return { statusMessage: msg, statusMessageTimerId: id };
    }),
  setSnapStep: (studs) => {
    const v = Math.max(0, studs);
    localStorage.setItem('cld:snapStepStuds', String(v));
    set({ snapStepStuds: v });
  },
  setRotationStep: (degrees) => {
    const v = Math.max(0.1, degrees);
    localStorage.setItem('cld:rotationStepDegrees', String(v));
    set({ rotationStepDegrees: v });
  },
  setLiveSnap: (liveSnap) => set({ liveSnap }),
  setHingeLimits: (hingeLimits) => set({ hingeLimits }),
  setSnapMoving: (snapMoving) => set({ snapMoving }),
  setConnectionSnap: (connectionSnap) => set({ connectionSnap }),
  setEditingModule: (editingModuleId) =>
    set((s) =>
      s.editingModuleId === editingModuleId
        ? s
        : { editingModuleId, selection: [], annoSelection: EMPTY_ANNO },
    ),
  setSelection: (selection) => set({ selection: selectionShaper(selection), annoSelection: EMPTY_ANNO }),
  setMixedSelection: (selection, annoSelection) => set({ selection: selectionShaper(selection), annoSelection }),
  toggleSelected: (id, additive) =>
    set((s) => {
      if (additive) {
        return s.selection.includes(id)
          ? { selection: s.selection.filter((x) => x !== id) }
          : { selection: selectionShaper([...s.selection, id]) };
      }
      return { selection: selectionShaper([id]), annoSelection: EMPTY_ANNO };
    }),
  setActiveLayer: (activeLayerId) => set({ activeLayerId }),
  setPlacePart: (placePartKey) => set({ placePartKey }),
  setZoom: (zoom) => set({ zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM) }),
  setPan: (panX, panY) => set({ panX, panY }),
  zoomAround: (newZoom, anchorPxX, anchorPxY) =>
    set((s) => {
      const next = clamp(newZoom, MIN_ZOOM, MAX_ZOOM);
      if (next === s.zoom) return s;
      // Pin the world coord under the cursor: anchor (in stage pixels) maps
      // to world (anchor − pan) / zoom; keep that ratio constant by
      // adjusting pan to (anchor − world*newZoom).
      const worldX = (anchorPxX - s.panX) / s.zoom;
      const worldY = (anchorPxY - s.panY) / s.zoom;
      return {
        zoom: next,
        panX: anchorPxX - worldX * next,
        panY: anchorPxY - worldY * next,
      };
    }),
}));

export interface StageView {
  zoom: number;
  panX: number;
  panY: number;
}

let stageViewHeld = false;

/** Whether `stageView` is the view (zoom/panX/panY). */
function stageViewIsLive(s: EditorState): boolean {
  return s.stageView.zoom === s.zoom && s.stageView.panX === s.panX && s.stageView.panY === s.panY;
}

/** Brings `stageView` up to the view. */
export function commitStageView(): void {
  const s = useEditorStore.getState();
  if (!stageViewIsLive(s)) useEditorStore.setState({ stageView: { zoom: s.zoom, panX: s.panX, panY: s.panY } });
}

/**
 * While the view moves, `stageView` stays where it is until it's committed
 * (`commitStageView`); letting go commits it.
 */
export function holdStageView(hold: boolean): void {
  stageViewHeld = hold;
  if (!hold) commitStageView();
}

export function isStageViewHeld(): boolean {
  return stageViewHeld;
}

// Every other change to the view (Fit, the zoom buttons, a saved view, a
// test setting it) reaches the canvas at once.
useEditorStore.subscribe((s) => {
  if (!stageViewHeld && !stageViewIsLive(s)) commitStageView();
});

/** View zoom range — desktop MapView.cpp:77-78 (`kMinZoom`/`kMaxZoom`). */
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 40;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
