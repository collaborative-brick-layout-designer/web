import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cullOffscreen } from './render/cullOffscreen';
import { EditorErrorBoundary } from './EditorErrorBoundary';
import { lazyRetry, preloadLazy } from '../ui/lazyRetry';
import { RenameDialog } from '../ui/RenameDialog';
import { flushSync } from 'react-dom';
import * as Y from 'yjs';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Stage, Layer as KonvaLayer, Circle, Group, Image as KonvaImage, Line, Text } from 'react-konva';
import Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { api, spriteUrlFor, type LayoutSummary, type PartWire } from '../api';
import { DEMO_WAS_RESET, MERGE_REFUSED, SIGN_IN_TO_OPEN, useLayoutDoc, type LayoutDocState } from './useLayoutDoc';
import { useModuleDoc } from './useModuleDoc';
import { ModuleChangedCard } from './ModuleChangedCard';
import { ShareToCatalogDialog, useCatalogStatus } from '../catalog/ShareToCatalog';
import { makeModuleThumbnail, makeRegionThumbnail, waitForPartPictures } from './moduleThumbnail';
import { getSpriteProgress } from './render/spriteCache';
import { useLibraryEntries } from './moduleLibraryMenu';
import { TouchModuleSheet } from './TouchModuleSheet';
import { useDocMap, projectDoc } from './useDocMap';
import { emptyVenue } from '../venues/designer/model';
import { holdStageView, isStageViewHeld, setSelectionShaper, shapeSelectionIds, useEditorStore, SNAP_STEPS, ROTATION_STEPS, MIN_ZOOM, MAX_ZOOM, EMPTY_ANNO, type AnnoSelection, noticeDownloaded } from './editorStore';
import {
  annoCount,
  annotationsInMarquee,
  clickAnno,
  deleteMixedSelection,
  mergeAnno,
  translateMixedSelection,
} from './mixedSelection';
import {
  annoNodeNames,
  collectNodes,
  restoreNodes,
  shiftNodes,
  type AnnoDragHandlers,
  type NodeSnap,
} from './render/groupDragNodes';
import { Toolbar, toolLabel } from './Toolbar';
import { GridLayer } from './render/GridLayer';
import { BrickLayer } from './render/BrickLayer';
import { PartsPanel } from './PartsPanel';
import { LayersPanel } from './LayersPanel';
import { PanelHost } from './PanelHost';
import { HelpButton } from '../help/HelpButton';
import { FloatingPanel } from './FloatingPanel';
import { Resizer } from './Resizer';
import { splitterHeights, useDockLayout, type DockZone } from './dockLayout';
import { AreaLayers } from './render/AreaLayer';
import { TextLayers, type TextCellRef } from './render/TextLayer';
import { RulerLayers } from './render/RulerLayer';
import { AnchoredLabels } from './render/AnchoredLabels';
import { ElectricCircuitLayer } from './render/ElectricCircuitLayer';
import { BEND_HANDLE_NAME, BendHandles } from './render/BendHandles';
import { ModuleOverlay, measureBold, moduleLabelBoundsStuds } from './render/ModuleOverlay';
import { VenueOverlay } from './render/VenueOverlay';
import { readSidecarFromDoc } from '@cld/ydoc';
import { coarsePointer, useViewportSize } from './useViewportSize';
import { useElementSize } from './useElementSize';
import { useTouchView } from './useTouchView';
import { TouchToolsSheet } from './TouchTools';
import { besideTarget, readPhoneEdit, safeSessionStorage, writePhoneEdit, type Pt } from './touchGesture';
import { AddPartSheet, ModeSwitch, TouchActionBar, TouchUndoRedo } from './TouchEdit';
import { TouchPickedSheet } from './TouchPickedSheet';
import { SheetsSheet, TextEditSheet } from './TouchSheets';
import { placeModuleAsking, SheetChoiceHost } from './SheetChoiceDialog';
import { addSidecarModule, editAnchoredLabel, editTextCell, setExportElectricCircuit, updateSidecarModule } from './mutations';
import { brickIdsInDoc, parseTextKey, stillPicked } from './mixedSelection';
import { startSignedOutPoll } from './signedOutPoll';
import { PHONE_MIN_TEXT_PX } from './textLegibility';
import { sanitizeFilename } from '../bbmFiles';
import { downloadLocalLayout, saveFile } from './localLayoutFile';
import { backgroundImageRectPx, sameOriginImageUrl } from './background';
import { mapFontsReady, mapLineWidth } from './render/mapText';
import { scaleBar, studDisplay } from './scaleBar';
import { areaForPivot, areaSize, pivotOf } from './brickGeometry';
import { imageOffset } from '@cld/parts-catalog/browser';
import { askForPermission } from '../orgs/clubPermissions';
import { canAddToBudget, countUsage, overBudgetCount, sameBudgetOr, withinBudget } from './budgetUsage';
import { BudgetReachedDialog, BUDGET_REFUSED_STATUS } from './BudgetReachedDialog';
import { venueAfterDraw, VENUE_MIN_POINTS_MESSAGE } from './venueValidator';
import { docToBbm } from '@cld/ydoc';
import {
  addCircularRuler,
  addLinearRuler,
  addTextCell,
  attachRulerEndpoint,
  deleteTextCell,
  editTextCellFull,
  moveRulerEndpoint,
  scaleRuler,
  ensureAreaLayer,
  shownAreaLayer,
  ensureBrickLayer,
  ensureRulerLayer,
  ensureTextLayer,
  moveGridOrigin,
  newTextBox,
  rulerPreviewLabel,
  rulerStatusMessage,
  allVisibleBrickIds,
  bricksByLayer,
  deleteBricksAcrossLayers,
  groupBricksAcrossLayers,
  insertBricksAcrossLayers,
  insertBricks,
  insertSet,
  paintAreaCells,
  moveArea,
  placeBrick,
  readBudgetLimits,
  readSavedViews,
  reorderBricks,
  reorderAnnotations,
  moveBricksToLayer,
  addLayer,
  setBudgetLimits,
  rotateSelection,
  ungroupBricksAcrossLayers,
  setVenue,
  makeId,
  makeSetsOfModules,
  setLayerVisible,
  type ModuleBatch,
} from './mutations';
import { ActiveSheetControl } from './ActiveSheetControl';
import { displaySheetName, placementTarget, SHEET_KIND, sheetName, startingSheetId } from './activeSheet';
import { brickDrag } from './brickDrag';
import { cloneGroups, expandSet, expandToGroups, findLooseSets, findSetModules, setsAgainNotice, groupChain, selectedSet, setAnchorOrder, subpartOf, ungroupState } from './sets';
import { applySetUpdate, copyPlacedSets, findSetUpdates, linksByAnchor, placedSetLink, trackedSet, updateForSelection, writePlacedSets, type SetUpdate } from './setUpdates';
import { SetUpdatesBar } from './SetUpdatesBar';
import type { Group as BrickGroup } from '@cld/model';
import { TextDialog, type TextDialogResult } from './TextDialog';
import { UsedPartsPanel } from './UsedPartsPanel';
import { hasClipboardBricks, pasteOffset, pasteTarget, readClipboardStatus, writeBricksToClipboard, type ClipboardEntry, type SystemClipboard } from './clipboard';
import { moduleCopy, wholeModule } from './moduleCopy';
import { pxToStud, studToPx } from './render/coords';
import { SNAP_MARKS } from './render/selectionStyle';
import { ensureSprite, getSpriteSync, resetSpriteProgress, subscribeSpriteProgress, wantSprites } from './render/spriteCache';
import { ViewBitmap, VIEW_LIVE } from './render/viewBitmap';
import { hitsHeld, holdHits, releaseHits } from './render/viewMoving';
import { layoutSpriteUrls } from './render/layoutSprites';
import { MapLoadingCard, OpeningLayoutScreen } from './LoadingCard';
import { PlaceGhost } from './render/PlaceGhost';
import { ModuleGhost } from './render/ModuleGhost';
import { snapPlacement, snapToAnchorBrick, type SnapResult } from './snap';
import { MarqueeOverlay, bricksInMarquee } from './render/MarqueeOverlay';
import { useUndoManager } from './useUndoManager';
import { isEditableTarget } from './keyboardGuard';
import { catalogFromParts, recomputeConnectivity, useConnectivity } from './useConnectivity';
import type { OpenedMapState } from '../mapFormats';
import { usePublishAwareness, dispatchCursorMove, dispatchCursorLeave } from './useAwareness';
import { PresencePanel } from './PresencePanel';
import { ViewOnlyPill } from './ViewOnlyPill';
import { RemoteCursors } from './render/RemoteCursors';
import { MODULE_MIME, MODULE_NAME_MIME, activeModuleDrag } from './mime';
import { moduleByPart, shapeSelection } from './moduleEdit';
import { useLiveVenueReadout } from './liveVenueReadout';
import { ModuleEditBar } from './ModuleEditBar';
import { withShowName } from './moduleLook';
import { ModuleEditDim, editedModuleFrame } from './render/ModuleEditDim';
import { DRAG_LAYER } from './render/BrickLayer';
import { fetchModuleBatches, libraryVersionOf } from './moduleSnapshot';
import { moduleDropTranslation, placedModuleBatches } from './moduleDrop';
import type { GroupTurn } from './snapFeel';
import { absorbIntoEditedModule, openMakeModule, enterModuleEdit, leaveModuleEdit, selectionMayMove, setModulePinned } from './moduleActions';
import { applyViewSheets, moduleNamesShown, pictureGrid, setModuleNamesSource, viewRegionStuds, type PictureSpec } from './savedViews';
import { ViewsPanel, PictureIcon } from './ViewsPanel';
import { downloadAllViews } from './sharePicture';
import { NoticeToast } from './NoticeToast';
import { DropSheetTag } from './DropSheetTag';
import { writeBbm, type SavedView, type SidecarModule } from '@cld/bbm';
import { LOCAL_ORIGIN } from './useLayoutDoc';
import { hiddenPartNotice } from './hiddenParts';
import { contentBoundsStuds, EXPORT_HIDE, exportRegionStuds, unionStudRects, type StudRect, exportSceneSize, renderMapToCanvas, watermarkText } from './exportRender';
import { dropdownAnchor, dropTargetHint, viewCentreStuds, wheelZoomStep } from './viewHelpers';
import { parseVenueFile, VENUE_FILE_ACCEPT, VENUE_FILE_EXT, writeVenueFile } from './venueFile';
import '../konvaSetup';
import { actualPartNumber, indexParts } from './partIndex';
import { ColorAlphaInput } from './ColorAlphaInput';
import { fitView, isUntouchedFit, withGridLabels, type ViewInsets } from './viewFit';
import { PartListDialog } from './PartListDialog';
import { blueBrickLeavesOut, DownloadAsDialog } from './DownloadAsDialog';
import { askOverwrite, saveVenueToLibrary } from './venueLibrary';
import { drawnGridLayer, gridCellAt, parseCellIndexCorner } from './render/gridIndex';
import { AppMark, HelpMenu, LayoutNameMenu, SavePill, SettingsButton, TaskTabs, type EditorTask } from './EditorChrome';
import { SettingsDialog } from '../settings/SettingsPage';
import { usePreferences } from '../theme/PrefsProvider';
import { DEFAULT_SNAP_STRENGTH, SnapSession, snapBypassed } from './snapFeel';
import { annoDragShift, grabSnapCorner, snapPoint } from './gridSnap';
import { liveSnapReach } from './liveSnapReach';
import { LAST_LAYOUT_KEY } from '../layouts/reopenLast';
import { askConfirm, askLeaveUnsaved, askLeaveUnsavedModule } from '../ui/ConfirmDialog';
import { creditText } from '../owners/owners';
import type { Credit } from '../api';
import { useShallow } from 'zustand/react/shallow';
import { Menu } from '../ui/menu/Menu';
import { resolveMenu } from '../ui/menu/menuModel';
import { mapMenuEntries, modKey, phoneMapEntries, type MapMenuToggles } from './mapMenu';
import { openFilePicker } from '../open/FileOpener';
import { OpenedSummaryCard } from '../open/OpenedSummary';
import { DemoBanner } from '../demo/DemoBanner';
// Dialogs and infrequently-used panels — lazy-loaded so they don't bloat
// the initial editor chunk. React.lazy requires a default export, but all
// our components are named; the wrappers below re-export as default.
const SharePictureDialog = lazyRetry(() => import('./SharePictureDialog').then((m) => ({ default: m.SharePictureDialog })));
const ShareDialog = lazyRetry(() => import('../layouts/ShareDialog').then((m) => ({ default: m.ShareDialog })));
const InsertModuleDialog = lazyRetry(() => import('./InsertModuleDialog').then((m) => ({ default: m.InsertModuleDialog })));
const ModuleLookDialog = lazyRetry(() => import('./ModuleLookDialog').then((m) => ({ default: m.ModuleLookDialog })));
const ModuleDialogHost = lazyRetry(() => import('./ModuleDialogs').then((m) => ({ default: m.ModuleDialogHost })));
const EditBrickDialog = lazyRetry(() => import('./EditBrickDialog').then((m) => ({ default: m.EditBrickDialog })));
const EditRulerDialog = lazyRetry(() => import('./EditRulerDialog').then((m) => ({ default: m.EditRulerDialog })));
const GeneralInfoDialog = lazyRetry(() => import('./GeneralInfoDialog').then((m) => ({ default: m.GeneralInfoDialog })));
const BackgroundColorDialog = lazyRetry(() => import('./BackgroundColorDialog').then((m) => ({ default: m.BackgroundColorDialog })));
const BackgroundImageDialog = lazyRetry(() => import('./BackgroundImageDialog').then((m) => ({ default: m.BackgroundImageDialog })));
const FindDialog = lazyRetry(() => import('./FindDialog').then((m) => ({ default: m.FindDialog })));
const PreferencesDialog = lazyRetry(() => import('./PreferencesDialog').then((m) => ({ default: m.PreferencesDialog })));
const ImportBbmDialog = lazyRetry(() => import('./ImportBbmDialog').then((m) => ({ default: m.ImportBbmDialog })));
const ExportImageDialog = lazyRetry(() => import('./ExportImageDialog').then((m) => ({ default: m.ExportImageDialog })));
const AddAnchoredLabelDialog = lazyRetry(() => import('./AddAnchoredLabelDialog').then((m) => ({ default: m.AddAnchoredLabelDialog })));
const SaveAsSetDialog = lazyRetry(() => import('./SaveAsSetDialog').then((m) => ({ default: m.SaveAsSetDialog })));
const ModulesPanel = lazyRetry(() => import('./ModulesPanel').then((m) => ({ default: m.ModulesPanel })));
const ModuleLibraryPanel = lazyRetry(() => import('./ModuleLibraryPanel').then((m) => ({ default: m.ModuleLibraryPanel })));
const VenueDesigner = lazyRetry(() => import('../venues/designer/VenueDesigner').then((m) => ({ default: m.VenueDesigner })));
const VenuePropertiesDialog = lazyRetry(() => import('./VenuePropertiesDialog').then((m) => ({ default: m.VenuePropertiesDialog })));
const VenueDimensionsDialog = lazyRetry(() => import('./VenueDimensionsDialog').then((m) => ({ default: m.VenueDimensionsDialog })));
const BudgetDialog = lazyRetry(() => import('./BudgetDialog').then((m) => ({ default: m.BudgetDialog })));
const VenueLibraryPanel = lazyRetry(() => import('./VenueLibraryPanel').then((m) => ({ default: m.VenueLibraryPanel })));
const VenueSaveLibraryDialog = lazyRetry(() => import('./VenueSaveLibraryDialog').then((m) => ({ default: m.VenueSaveLibraryDialog })));

/** A part from the parts list being dragged over the map: where it would land (a set: its parts, placed). */
interface DropPart {
  key: string;
  studX: number;
  studY: number;
  snapped?: SnapResult;
  setBricks?: ModuleBatch['bricks'];
}

export function EditorPage() {
  const params = useParams<{ id: string }>();
  if (!params.id) return <Navigate to="/" replace />;

  return <LayoutEditor key={params.id} layoutId={params.id} />;
}

/** /modules/:id: the same editor on a saved module (saved with Save, no venue or views). */
export function ModuleEditorPage() {
  const params = useParams<{ id: string }>();
  if (!params.id) return <Navigate to="/" replace />;
  return <ModuleEditor key={params.id} moduleId={params.id} />;
}

function LayoutEditor({ layoutId }: { layoutId: string }) {
  // (The same query the editor reads its role from.)
  const meta = useQuery({ queryKey: ['layout', layoutId], queryFn: () => api.layouts.get(layoutId) });
  const demoCopyId = meta.data?.demoCopyId;
  const docState = useLayoutDoc(layoutId, meta.data && !demoCopyId ? meta.data.role !== 'viewer' : undefined);
  // A link to the demo's sample, opened in a demo space: open the visitor's own copy instead.
  if (demoCopyId) return <Navigate to={`/editor/${demoCopyId}`} replace state={DEMO_COPY_STATE} />;
  return (
    <EditorErrorBoundary what="layout" layoutId={layoutId} docState={docState}>
      <Editor layoutId={layoutId} docState={docState} moduleMode={false} />
    </EditorErrorBoundary>
  );
}

function ModuleEditor({ moduleId }: { moduleId: string }) {
  const info = useQuery({ queryKey: ['module', moduleId, 'info'], queryFn: () => api.modules.get(moduleId) });
  const docState = useModuleDoc(moduleId);
  const demoCopyId = info.data?.demoCopyId;
  // A link to the demo's sample module, opened in a demo space: open the visitor's own copy instead.
  if (demoCopyId) return <Navigate to={`/modules/${demoCopyId}`} replace state={DEMO_COPY_STATE} />;
  return (
    <>
      <EditorErrorBoundary what="module" layoutId={moduleId} docState={docState}>
        <Editor layoutId={moduleId} docState={docState} moduleMode />
      </EditorErrorBoundary>
      <ModuleChangedCard change={docState.moduleChange} onLoadTheirs={docState.loadTheirs} onSaveMine={docState.saveMine} onDismiss={docState.dismissChange} />
    </>
  );
}

/** The site's name, after the layout's in the browser tab. */
const APP_NAME = 'Collaborative Brick Layout Designer';

/** Sent along when a demo visitor is sent from a sample to their own copy of it. */
const DEMO_COPY_STATE = { demoCopy: true };
/** What the status bar says then. */
const DEMO_COPY_NOTICE = 'This is your own copy of the demo sample. Change anything you like.';

/** A module's details in the shape the editor reads a layout's. */
async function moduleMeta(id: string): Promise<{ layout: LayoutSummary; role: 'owner' | 'editor' | 'viewer' }> {
  const { module: m, role } = await api.modules.get(id);
  return {
    role,
    layout: {
      id: m.id,
      title: m.title,
      ownerUserId: m.ownerUserId,
      ownerOrgId: m.ownerOrgId,
      ownerOrgName: null,
      ownerOrgSlug: null,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      expiresAt: null,
      docVersion: m.docVersion,
      hasSidecar: m.hasSidecar,
      publicShareToken: null,
    },
  };
}

/**
 * The credit as one line ("by Sam · in ArkLUG · based on Yard by Sam"),
 * or null. Your own thing ("by you" and nothing more) says nothing new.
 */
function creditLabel(credit: Credit | null | undefined): string | null {
  const { line, basedOn } = creditText(credit);
  const text = [line, basedOn].filter(Boolean).join(' · ');
  return text && text !== 'by you' ? text : null;
}

/** Panels a module has no use for (it has no venue and no saved views). */
const NOT_IN_MODULES = new Set(['views', 'venuelibrary', 'modules']);
/** The sheets shown as one moving picture while the view moves (viewBitmap.ts), bottom first. */
const VIEW_BITMAP_LAYERS = ['background-layer', 'parts-layer', DRAG_LAYER]; // the drag layer holds the module outlines
/** One empty module list, so a layout without modules doesn't hand the map's layers a new one on every render (and frame of a pan). */
const NO_MODULES: NonNullable<NonNullable<ReturnType<typeof readSidecarFromDoc>>['modules']> = [];

function Editor({ layoutId, docState, moduleMode }: { layoutId: string; docState: LayoutDocState; moduleMode: boolean }) {
  const { doc, awareness, loadError, loading, status, saveNow: checkSaved } = docState;
  // A layout is opening: the loading card counts its pictures afresh.
  useEffect(() => resetSpriteProgress(), [layoutId]);
  // Once the layout is open, fetch every panel and dialog while the Wi-Fi is
  // up, so they still open if it drops at the show.
  useEffect(() => {
    if (!doc) return;
    let idle = 0;
    const t = setTimeout(() => {
      // When the page has nothing else to do, so it never slows an edit.
      if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(() => void preloadLazy(), { timeout: 10000 });
      else void preloadLazy();
    }, 2000);
    return () => {
      clearTimeout(t);
      if (idle && typeof cancelIdleCallback === 'function') cancelIdleCallback(idle);
    };
  }, [doc]);
  // What opening an LDraw / TrackDesigner / 4DBrix file skipped (desktop
  // shows it in the status bar after the open).
  const location = useLocation();
  const openedState = location.state as OpenedMapState | null;
  const openWarnings = openedState?.openWarnings;
  // "Opened ‹name›: N parts, M not in the library" until closed.
  const [openedFile, setOpenedFile] = useState(openedState?.openedFile ?? null);
  const navigate = useNavigate();
  const closeOpenedSummary = () => {
    setOpenedFile(null);
    // Not again after a reload.
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  };
  // Opened from ⋯ › Refresh picture: say when the new picture is in.
  const refreshingPicture = new URLSearchParams(location.search).get('refresh') === 'picture';
  const openedDemoCopy = (location.state as { demoCopy?: boolean } | null)?.demoCopy === true;
  useEffect(() => {
    if (doc && openedDemoCopy) useEditorStore.getState().showStatusMessage(DEMO_COPY_NOTICE, 8000);
  }, [doc, openedDemoCopy]);
  useEffect(() => {
    if (doc && openWarnings?.length) useEditorStore.getState().showStatusMessage(`Opened with warnings: ${openWarnings.join('; ')}`, 10000);
  }, [doc, openWarnings]);
  const meta = useQuery({
    queryKey: [moduleMode ? 'module' : 'layout', layoutId],
    queryFn: moduleMode ? () => moduleMeta(layoutId) : () => api.layouts.get(layoutId),
  });
  const moduleInfo = useQuery({
    queryKey: ['module', layoutId, 'info'],
    queryFn: () => api.modules.get(layoutId),
    enabled: moduleMode,
  });
  const moduleCredit = creditLabel(moduleInfo.data?.module.credit);
  // The browser tab names the layout or module, as the desktop's title bar does.
  const shownTitle = meta.data?.layout.title;
  useEffect(() => {
    if (!shownTitle) return;
    const before = document.title;
    document.title = `${shownTitle} · ${APP_NAME}`;
    return () => {
      document.title = before;
    };
  }, [shownTitle]);
  // The parts catalog, for Save's offline download (declared further down).
  const partsRef = useRef<readonly PartWire[] | undefined>(undefined);
  // Save / Ctrl+S: every edit is already persisted server-side while the
  // socket is synced; when it isn't, offer the local state as a .bbm so
  // nothing is lost (desktop's Save always leaves a file on disk).
  const saveNow = useCallback(async (): Promise<void> => {
    if (!doc) return;
    if (moduleMode) {
      await saveModule();
      return;
    }
    const result = await checkSaved();
    if (result === 'saved') {
      useEditorStore.getState().showStatusMessage('All changes saved to the server', 3000);
      return;
    }
    const download = await askConfirm({
      title: 'Download a copy?',
      removes: 'You’re not connected to the server. Your latest changes sync when the connection returns.',
      keeps: 'You can download a copy of this layout (.bld-layout) now, to be safe.',
      confirmLabel: 'Download',
      danger: false,
    });
    if (download) void downloadLocalLayout(doc, layoutId, meta.data?.layout.title ?? 'layout', partsRef.current);
  }, [doc, layoutId, checkSaved, meta.data?.layout.title, moduleMode]);
  // The module editor's Save: the module's contents, then its picture.
  const saveModuleRef = useRef<() => Promise<void>>(async () => undefined);
  // The module editor: share it to the public catalog (when that's on).
  const catalogStatus = useCatalogStatus();
  const [sharingModule, setSharingModule] = useState(false);
  // The module editor's "What changed" note for its next save.
  const [saveNote, setSaveNoteText] = useState('');
  const saveModule = () => saveModuleRef.current();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const myOrgs = useQuery({ queryKey: ['orgs'], queryFn: api.orgs.list });
  const undo = useUndoManager(doc);
  // Signed out while it was open: read only until signed in again (SignedOutCard).
  const role = docState.signedOut ? 'viewer' : (meta.data?.role ?? 'viewer');
  useAccessChangeNotice(meta.data?.role, meta.data?.layout.title, moduleMode);
  // A club's layout or module the club's roles only let me look at: say which permission would let me edit it.
  const viewOnlyReason = role === 'viewer' && meta.data?.layout.ownerOrgId ? askForPermission(moduleMode ? 'edit_modules' : 'edit_layouts') : undefined;
  // A phone opens a layout in View mode (the phone viewer). People who
  // can edit get a View / Edit switch in the header; Edit turns on touch
  // editing. The choice is kept per layout for this visit (sessionStorage).
  // View re-uses the viewer-mode UI gating rather than a separate mode.
  const viewport = useViewportSize();
  const [phoneEdit, setPhoneEditState] = useState(() => readPhoneEdit(safeSessionStorage(), layoutId));
  const setPhoneEdit = useCallback(
    (edit: boolean) => {
      writePhoneEdit(safeSessionStorage(), layoutId, edit);
      setPhoneEditState(edit);
      if (!edit) {
        useEditorStore.getState().setSelection([]);
        useEditorStore.setState({ touchSelectMore: false, touchSelectArea: false });
      }
    },
    [layoutId],
  );
  const isViewer = role === 'viewer' || (viewport.isMobile && !phoneEdit);
  const [renaming, setRenaming] = useState(false);
  /** Editing on a phone: the touch bar, Undo / Redo and Add part over the map. */
  const touchEditing = viewport.isMobile && !isViewer;
  /** A tablet (full editor, touch screen): the bar for picked parts. */
  const touchTablet = !viewport.isMobile && !isViewer && coarsePointer();
  const [showAddPart, setShowAddPart] = useState(false);
  /** The phone's Map menu, opened from the layout-name menu (a new number opens it). */
  const [phoneMapOpen, setPhoneMapOpen] = useState(0);
  const [showTouchSheets, setShowTouchSheets] = useState(false);
  /** The one picked label or text, open in the touch text editor. */
  const [touchText, setTouchText] = useState<{ title: string; text: string; save: (t: string) => void } | null>(null);
  const openTouchText = () => {
    const { annoSelection: a } = useEditorStore.getState();
    const d = doc;
    if (!d) return;
    if (a.labels.length === 1) {
      const id = a.labels[0]!;
      const label = readSidecarFromDoc(d)?.anchoredLabels?.find((l) => l.id === id);
      if (label) setTouchText({ title: 'Edit label', text: label.text, save: (t) => editAnchoredLabel(d, id, { text: t }) });
    } else if (a.texts.length === 1) {
      const ref = parseTextKey(a.texts[0]!);
      const layer = ref ? docMap?.layers.find((l) => l.id === ref.layerId) : undefined;
      const cell = ref && layer?.type === 'text' ? layer.textCells[ref.cellIndex] : undefined;
      if (ref && cell) setTouchText({ title: 'Edit text', text: cell.text, save: (t) => editTextCell(d, ref.layerId, ref.cellIndex, t, mapLineWidth(cell.font.style.toLowerCase().includes('bold') ? 'bold' : 'normal')) });
    }
  };
  // The canvas area's real size, after the header, the status bar and the
  // browser's own bars: the stage fills it and Fit uses it.
  // 0 until measured, so the first fit waits for the real size.
  const [canvasBoxRef, canvasSize, canvasBox] = useElementSize({ width: 0, height: 0 });
  const [showShare, setShowShare] = useState(false);
  // "Share to the public catalog" (a layout): from the Share dialog, or Home's ⋯ menu (?catalog=share).
  const [sharingLayout, setSharingLayout] = useState(() => new URLSearchParams(location.search).get('catalog') === 'share');
  // "Share picture", with the picture picked when it opens (a saved view's id).
  const [sharePicture, setSharePicture] = useState<{ choice?: string } | null>(null);
  const [exportingViews, setExportingViews] = useState<string | null>(null);
  const activeViewId = useEditorStore((s) => s.activeViewId);
  const showGridNow = useEditorStore((s) => s.showGrid);
  const [showInsertModule, setShowInsertModule] = useState(false);
  // The picked module's menu on a phone (the touch bar's Module button).
  const [touchModuleId, setTouchModuleId] = useState<string | null>(null);
  const [showGeneralInfo, setShowGeneralInfo] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [task, setTask] = useState<EditorTask>('build');
  const [showBackgroundColor, setShowBackgroundColor] = useState(false);
  const [showBackgroundImage, setShowBackgroundImage] = useState(false);
  const [showFind, setShowFind] = useState(false);
  const [showExportImage, setShowExportImage] = useState(false);
  const [showPreferences, setShowPreferences] = useState(false);
  const [showImportBbm, setShowImportBbm] = useState(false);
  const [showAddLabel, setShowAddLabel] = useState(false);
  const [showSaveAsSet, setShowSaveAsSet] = useState(false);
  const mapToggles = useMapMenuToggles();
  /** The touch bar's More actions sheet (TouchPickedSheet). */
  const [showTouchPicked, setShowTouchPicked] = useState(false);
  const [showTouchTools, setShowTouchTools] = useState(false);
  const [showVenueProps, setShowVenueProps] = useState(false);
  const [showVenueDesigner, setShowVenueDesigner] = useState(false);
  const [showVenueDimensions, setShowVenueDimensions] = useState(false);
  const [showBudget, setShowBudget] = useState(false);
  const [showPartList, setShowPartList] = useState(false);
  const [showDownloadAs, setShowDownloadAs] = useState(false);
  const qc = useQueryClient();
  const showStatusBar = useEditorStore((s) => s.showStatusBar);
  const [showVenueSaveLibrary, setShowVenueSaveLibrary] = useState(false);

  // Imperative handle so the PartsPanel can trigger click-to-place
  // without lifting all of placePartAt's state up to Editor. Canvas
  // writes the current implementation into this ref on every render.
  const placeAtCenterRef = useRef<((part: PartWire) => void) | null>(null);
  const onPlacePart = useCallback((part: PartWire) => {
    placeAtCenterRef.current?.(part);
  }, []);

  // Imperative export-image handle: Canvas writes the handle on each render.
  // The ExportImageDialog reads it to produce the export (single PNG or tiled print).
  const exportImageRef = useRef<import('./ExportImageDialog').ExportHandle | null>(null);
  const onExportImage = useCallback(() => {
    setShowExportImage(true);
  }, []);

  // Imperative canvas-action handle (clipboard, delete, rotate, z-order,
  // zoom, insert text): Canvas writes the functions on every render so the
  // header toolbar and menus can call them without lifting canvas state
  // up to Editor.
  const canvasActionsRef = useRef<CanvasActions | null>(null);

  // Unsaved-changes guard. The useLayoutDoc hook tracks save status;
  // we block navigation when there are pending writes by returning a
  // string from the beforeunload handler (works in all browsers except
  // Chrome 119+ where custom messages are suppressed, but the dialog
  // still blocks).
  const isDirty = status.kind === 'reconnecting' || status.kind === 'error' || status.kind === 'unsaved' || status.kind === 'saving';
  useEffect(() => {
    if (!isDirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  // The Canvas component hosts the keyboard-shortcut listener and
  // dispatches `cld:open-find` so the parent (which owns the dialog
  // state) can react. Same for the Insert-Text dialog if we ever want
  // to open it from the canvas via a keyboard route. (Add Text is
  // currently driven from a Map-menu button only.)
  useEffect(() => {
    const onOpenFind = () => setShowFind(true);
    const onOpenPrefs = () => setShowPreferences(true);
    const onOpenLabel = () => setShowAddLabel(true);
    window.addEventListener('cld:open-find', onOpenFind);
    window.addEventListener('cld:open-preferences', onOpenPrefs);
    window.addEventListener('cld:open-label', onOpenLabel);
    return () => {
      window.removeEventListener('cld:open-find', onOpenFind);
      window.removeEventListener('cld:open-preferences', onOpenPrefs);
      window.removeEventListener('cld:open-label', onOpenLabel);
    };
  }, []);

  // Publish our awareness state (cursor / selection / tool / identity).
  usePublishAwareness({ awareness, me: me.data?.user ?? null, layoutId });

  // Connectivity recompute (debounced). The hook listens to LOCAL_ORIGIN
  // updates and patches `linkedTo` fields back into Yjs. It's a no-op
  // until the parts-catalog wire shape carries connection-point data —
  // see SESSION_NOTES.md.
  const catalog = useQuery({
    queryKey: ['parts-catalog'],
    queryFn: api.parts.catalog,
    staleTime: 5 * 60 * 1000,
  });
  useEffect(() => {
    partsRef.current = catalog.data?.parts;
  }, [catalog.data]);
  useConnectivity(doc, catalog.data?.parts);
  const partIndex = useMemo(() => indexParts(catalog.data?.parts), [catalog.data]);

  // Subscribe to ALL doc changes; the projection is shared (cached per
  // doc) with the canvas and panels, so this costs no extra docToBbm.
  const docMap = useDocMap(doc);
  // Budget limits live in the doc's meta (shared with collaborators,
  // undoable). A meta change yields a new docMap, so re-read on that.
  const budgetRead = useMemo(
    () => (doc ? readBudgetLimits(doc) : new Map<string, number>()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, docMap],
  );
  // The same Map while the limits are the same (sameBudgetOr).
  const budgetKept = useRef(budgetRead);
  budgetKept.current = sameBudgetOr(budgetKept.current, budgetRead);
  const budgetLimits = budgetKept.current;

  saveModuleRef.current = async () => {
    if (!doc) return;
    const { showNotice, showStatusMessage } = useEditorStore.getState();
    try {
      await checkSaved();
    } catch (e) {
      showNotice(`The module could not be saved: ${(e as Error).message}`, 'error', 10000);
      return;
    }
    showStatusMessage('Module saved', 3000);
    setSaveNoteText('');
    void qc.invalidateQueries({ queryKey: ['modules'] });
  };
  // Save makes the module's picture before it shows "Saved" (so leaving
  // straight after doesn't cut the picture off). It is the fresh picture,
  // so a backfill still waiting to start (below) is not needed.
  docState.setAfterSave?.(() => {
    const cancelBackfill = cancelBackfillRef.current;
    const uploaded = uploadModuleThumbnail();
    cancelBackfill?.();
    return uploaded;
  });
  // The module's picture, for the lists that show modules. A failed
  // picture never fails the save: the lists show a placeholder.
  // The parts list is in (until then parts draw as missing-part crosses).
  const catalogReadyRef = useRef(false);
  catalogReadyRef.current = catalog.isSuccess;
  // One picture upload at a time, in order: a backfill begun before a
  // Save would otherwise land after it and put back an older picture, and
  // "Saved" would show while a picture was still on its way.
  const thumbnailQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const uploadModuleThumbnail = (): Promise<boolean> => {
    const next = thumbnailQueueRef.current.then(makeAndUploadThumbnail);
    thumbnailQueueRef.current = next;
    return next;
  };
  const makeAndUploadThumbnail = async (): Promise<boolean> => {
    try {
      if (!doc) return false;
      // Let the canvas draw the latest change, with the parts list and every
      // part picture in, first: a picture taken earlier shows missing-part
      // crosses (Save can come right after an edit; the backfill right after
      // opening). If they don't all come in time, don't store a bad picture.
      const ready = await waitForPartPictures(() => catalogReadyRef.current, getSpriteProgress);
      if (!ready) return false;
      // Read the doc now, not this render's copy, which may be a change behind.
      const thumb = await makeModuleThumbnail(exportImageRef.current, projectDoc(doc), readSidecarFromDoc(doc));
      if (!thumb) return false;
      await api.modules.setThumbnail(layoutId, thumb);
      return true;
    } catch (e) {
      console.warn('module picture not saved', e);
      return false;
    }
  };
  // Each time someone who can edit a module opens it, its picture is
  // redrawn once everything has loaded. That gives older modules a picture
  // and replaces any taken before the part pictures were in (which showed
  // missing-part crosses).
  const backfilledRef = useRef(false);
  const cancelBackfillRef = useRef<(() => void) | null>(null);
  const needsBackfill = moduleMode && !!doc && !!docMap && !!moduleInfo.data && moduleInfo.data.role !== 'viewer';
  useEffect(() => {
    if (!needsBackfill || backfilledRef.current) return;
    backfilledRef.current = true;
    const done = (ok: boolean) => {
      if (ok) void qc.invalidateQueries({ queryKey: ['modules'] });
      if (refreshingPicture) {
        const { showStatusMessage, showNotice } = useEditorStore.getState();
        if (ok) showStatusMessage('Picture refreshed', 5000);
        else showNotice('The picture couldn’t be made. Try again once the module has loaded.', 'error', 8000);
      }
    };
    // Once the canvas has drawn (its export handle is set on render).
    const t = window.setTimeout(() => {
      cancelBackfillRef.current = null;
      void uploadModuleThumbnail().then(done);
    }, 800);
    // A Save before then makes the picture instead (and refreshes it).
    cancelBackfillRef.current = () => {
      window.clearTimeout(t);
      cancelBackfillRef.current = null;
      void thumbnailQueueRef.current.then((ok) => done(ok === true));
    };
    return () => {
      window.clearTimeout(t);
      cancelBackfillRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsBackfill]);

  // The active layer starts on the file's saved sheet, or the topmost brick layer.
  // Without an active layer the place tool has nowhere to put bricks.
  const setActiveLayer = useEditorStore((s) => s.setActiveLayer);
  const activeLayerId = useEditorStore((s) => s.activeLayerId);

  // Reset stale activeLayerId when switching layouts. The Zustand store
  // persists across React navigation, so if the user goes Library →
  // open Layout A → navigate back → open Layout B, the store still
  // holds Layout A's layer id which won't match any layer in Layout B.
  // Clearing it here lets the effect below re-pick the first brick layer.
  useEffect(() => {
    setActiveLayer(null);
    useEditorStore.getState().setSelection([]);
    // Record the last-visited layout for "reopen last file" (general/reopenLastFile).
    // (Not a module: that would reopen it as a layout.)
    if (!moduleMode) localStorage.setItem(LAST_LAYOUT_KEY, layoutId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutId]);

  useEffect(() => {
    if (!doc) return;
    try {
      const map = projectDoc(doc);
      if (!map) return;
      // The saved sheet when it takes parts, else the topmost parts sheet
      // (startingSheetId, the desktop's rule too).
      const start = startingSheetId(map.layers, map.selectedLayerIndex);
      if (!start) return;
      // If the current activeLayerId still exists in this map (of ANY
      // layer kind — the user may have deliberately activated an area,
      // text, or ruler layer via the Layers panel), keep it. Only pick a
      // fallback when there's no valid active layer at all (stale id
      // from another layout, or null on first load): default to the
      // first brick layer since tools that place parts need one.
      const current = useEditorStore.getState().activeLayerId;
      const stillValid = current && map.layers.some((l) => l.id === current);
      if (!stillValid) setActiveLayer(start);
    } catch {
      // Doc isn't fully populated yet (e.g. blank-create layout). Phase 3
      // doesn't seed an empty doc with default layers; the editor shows
      // an empty-state hint and the user must import a `.bbm`.
    }
  }, [doc, activeLayerId, setActiveLayer]);

  // Dock layout — per-user persisted (localStorage). Left and right
  // columns are shown when their respective zone has any panels.
  // IMPORTANT: this must run BEFORE the early returns below; otherwise
  // when loading flips false the hook count changes mid-tree and
  // React throws #310 ("rendered more hooks than during previous").
  const dock = useDockLayout(me.data?.user?.id ?? null);
  const panelsHere = (ids: readonly string[]) => (moduleMode ? ids.filter((id) => !NOT_IN_MODULES.has(id)) : [...ids]);
  const leftPanels = panelsHere(dock.state.left);
  const rightPanels = panelsHere(dock.state.right);
  const showLeft = !viewport.isMobile && !isViewer && leftPanels.length > 0;
  const showRight = !viewport.isMobile && !isViewer && rightPanels.length > 0;

  // Leaving the editor (leaveLayout, below); the canvas's Alt+N and Ctrl+O go the same way.
  const leaveRef = useRef<(to?: string) => Promise<void>>(async () => undefined);
  useEffect(() => {
    const onLeave = (e: Event) => void leaveRef.current((e as CustomEvent<string>).detail);
    window.addEventListener('cld:leave-editor', onLeave);
    return () => window.removeEventListener('cld:leave-editor', onLeave);
  }, []);
  if (loadError) return <ErrorScreen err={loadError} what={moduleMode ? 'module' : 'layout'} />;
  if (loading || !doc) return <OpeningLayoutScreen />;

  // Three fixed columns: left dock | canvas | right dock. Each dock
  // collapses to 0 when empty so we don't have to juggle headerColSpan
  // and grid-auto-flow ordering. Widths come from the persisted dock
  // state so the user's resize survives reload.
  const leftWidthPx = showLeft ? `${dock.state.leftWidth}px` : '0px';
  const rightWidthPx = showRight ? `${dock.state.rightWidth}px` : '0px';
  const cols = `${leftWidthPx} minmax(0, 1fr) ${rightWidthPx}`;
  const headerColSpan = 4;

  // Returns just the inner content for a panel (shared by docked + floating).
  function panelBody(panelId: string): React.ReactNode {
    if (!doc) return null;
    if (moduleMode && NOT_IN_MODULES.has(panelId)) return null;
    if (panelId === 'parts') return <PartsPanel onPlacePart={onPlacePart} budgetLimits={budgetLimits} map={budgetLimits.size > 0 ? docMap : null} canUploadPart={!!me.data?.user && !me.data.user.isDemoAccount} mapEmpty={!isViewer && mapHasNoParts(docMap)} />;
    if (panelId === 'layers') return <LayersPanelHost doc={doc} isViewer={isViewer} />;
    if (panelId === 'usedparts') return <UsedPartsPanel doc={doc} budgetLimits={budgetLimits} />;
    if (panelId === 'modules') return <Suspense fallback={null}><ModulesPanel doc={doc} isViewer={isViewer} /></Suspense>;
    if (panelId === 'modlibrary')
      return (
        <Suspense fallback={null}>
          <ModuleLibraryPanel doc={doc} isViewer={isViewer} editingModuleId={moduleMode ? layoutId : null} />
        </Suspense>
      );
    if (panelId === 'views') return viewsPanel(false);
    if (panelId === 'venuelibrary') return <Suspense fallback={null}><VenueLibraryPanel doc={doc} isViewer={isViewer} onDesigner={() => setShowVenueDesigner(true)} onDimensions={() => setShowVenueDimensions(true)} onDrawOutline={() => useEditorStore.getState().setTool('venueOutline')} /></Suspense>;
    return null;
  }

  function viewsPanel(touch: boolean): React.ReactNode {
    if (!doc) return null;
    return (
      <ViewsPanel
        doc={doc}
        isViewer={isViewer}
        touch={touch}
        sheets={sheetList}
        activeViewId={activeViewId}
        gridShown={showGridNow}
        screenRect={() => canvasActionsRef.current?.screenRect() ?? null}
        onGoTo={(v) => canvasActionsRef.current?.goToView(v)}
        onShowEverything={showEverything}
        onApply={(v) => canvasActionsRef.current?.showViewFilter(v)}
        onLeave={() => canvasActionsRef.current?.clearView()}
        onShare={(v) => setSharePicture({ choice: v.id })}
        onExportAll={() => void exportAll()}
        exporting={exportingViews}
      />
    );
  }

  // The Parts panel names the sheet its parts go on: "Parts → Tracks".
  const partsTarget = placementTarget(docMap?.layers ?? [], activeLayerId).target;
  const panelTitle = (panelId: string) =>
    panelId === 'parts' && partsTarget ? `Parts → ${sheetName(partsTarget)}` : (PANEL_TITLES[panelId] ?? panelId);

  function renderPanel(panelId: string, dockZone: 'left' | 'right'): React.ReactNode {
    if (!doc) return null;
    const zone = dock.zoneOf(panelId);
    const onMove = (id: string, z: DockZone) => dock.setZone(id, z);
    const onReorder = (fromId: string, toId: string) => dock.reorderPanel(dockZone, fromId, toId);
    const title = panelTitle(panelId);
    return (
      <PanelHost panelId={panelId} title={title} zone={zone} onMove={onMove} onReorder={onReorder}>
        {panelBody(panelId)}
      </PanelHost>
    );
  }

  // Saved views (savedViews.ts) and their pictures.
  const savedViews = readSavedViews(doc);
  const sheetList = (docMap?.layers ?? []).filter((l) => l.type !== 'grid').map((l) => ({ id: l.id, name: displaySheetName(l.name) }));
  const activeView = savedViews.find((v) => v.id === activeViewId) ?? null;
  const showEverything = () => {
    canvasActionsRef.current?.clearView();
    canvasActionsRef.current?.fit();
  };
  const exportAll = async () => {
    if (exportingViews) return;
    if (!docMap) return;
    const { showNotice } = useEditorStore.getState();
    const busy = (text: string) => {
      setExportingViews(text);
      showNotice(text, 'busy');
    };
    busy('Making the pictures…');
    try {
      const n = await downloadAllViews({
        title: meta.data?.layout.title ?? 'layout',
        views: savedViews,
        map: docMap,
        sidecar: readSidecarFromDoc(doc),
        handle: exportImageRef.current,
        onProgress: (done, total) => {
          if (total > 1) busy(`Making picture ${done + 1} of ${total}…`);
        },
      });
      if (n > 0) showNotice(`Downloaded ${n} ${n === 1 ? 'picture' : 'pictures'} in a zip file. Look in your Downloads folder.`, 'done', 8000);
      else showNotice('There is nothing to show yet.', 'error');
    } catch (e) {
      showNotice(`The pictures could not be made: ${(e as Error).message}`, 'error', 10000);
    } finally {
      setExportingViews(null);
    }
  };

  // Home; `to` the New layout dialog (/?new=1) or the list to open
  // another from (/?open=1).
  // In the app, not a page load: a layout's unsent changes keep sending
  // (useLayoutDoc finishSending), and there's no second browser question.
  // A module isn't saved by itself: save it, leave it, or stay.
  const leaveLayout = async (to = '/') => {
    const unsent = status.kind === 'reconnecting' || status.kind === 'offline' || status.kind === 'error' || status.kind === 'unsaved' || status.kind === 'saving';
    if (unsent && moduleMode) {
      const choice = await askLeaveUnsavedModule();
      if (choice === null) return;
      if (choice === 'confirm') {
        try {
          await checkSaved();
        } catch (e) {
          useEditorStore.getState().showNotice(`The module couldn’t be saved, so you’re still here: ${(e as Error).message}`, 'error', 10000);
          return;
        }
        void qc.invalidateQueries({ queryKey: ['modules'] });
      }
    } else if (unsent && !(await askLeaveUnsaved())) return;
    navigate(to);
  };
  leaveRef.current = leaveLayout;
  // Task tabs are shortcuts onto the existing panels and dialogs.
  const onTask = (t: EditorTask) => {
    const show = (id: string) => {
      if (dock.zoneOf(id) === 'hidden') dock.setZone(id, 'right');
    };
    if (t === 'notes') {
      setShowGeneralInfo(true);
      return;
    }
    setTask(t);
    if (t === 'build') {
      show('parts');
      show('layers');
      show('views');
    } else if (t === 'room') {
      show('venuelibrary');
    } else if (t === 'parts') {
      show('usedparts');
    }
  };
  const showRail = !viewport.isMobile && !isViewer;

  // The Map menu's Venue ▸ entries that aren't a dialog (the Map menu and the phone's).
  async function venueClear(): Promise<void> {
    if (!doc) return;
    if (!(await askConfirm({
      title: 'Remove the venue from this layout?',
      removes: 'The venue’s outline, walls, doors and obstacles leave this layout.',
      keeps: 'Your parts stay where they are, and the venue stays in the Venue library if you saved it there.',
      undo: 'You can undo this with Ctrl+Z.',
      confirmLabel: 'Remove',
    }))) return;
    setVenue(doc, null);
  }
  function venueSaveToLibrary(): void {
    if (!doc) return;
    const venue = readSidecarFromDoc(doc)?.venue;
    if (!venue) { useEditorStore.getState().showNotice('This layout has no venue yet. Draw one first (Map ▸ Venue).', 'error'); return; }
    setShowVenueSaveLibrary(true);
  }
  function venueExportFile(): void {
    if (!doc) return;
    const venue = readSidecarFromDoc(doc)?.venue;
    if (!venue) { useEditorStore.getState().showNotice('This layout has no venue yet. Draw one first (Map ▸ Venue).', 'error'); return; }
    // Desktop format (VenueIO.cpp): *.bld-venue, schema bld-venue/1.
    const blob = new Blob([writeVenueFile(venue)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // Named after the venue, else the layout ("Show 2026 venue").
    a.download = `${sanitizeFilename(venue.name.trim() || `${meta.data?.layout.title ?? 'Layout'} venue`)}${VENUE_FILE_EXT}`;
    a.click();
    noticeDownloaded(a.download);
    URL.revokeObjectURL(url);
  }
  function venueLoadFromFile(): void {
    if (!doc) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = VENUE_FILE_ACCEPT;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      file.text().then((text) => {
        try {
          setVenue(doc, parseVenueFile(text));
        } catch (e) {
          useEditorStore.getState().showNotice(`Couldn’t read ${file.name}: ${(e as Error).message}`, 'error', 10000);
        }
      });
    };
    input.click();
  }

  return (
    // A demo visitor's countdown sits in the flow above the header (floating,
    // it covered the task tabs), and the editor takes the rest of the height.
    <div className="h-app flex flex-col bg-bg text-ink">
    <DemoBanner placement="inline" />
    <div
      // dvh, not vh: on a phone 100vh is the height with the browser bars
      // hidden, so the bottom of the page (scale card, status bar) would sit
      // under the address bar. Less the "new version" bar while it shows
      // (styles.css .h-app), so the bar covers no zoom button.
      className="grid min-h-0 flex-1 grid-rows-[auto_auto_1fr_auto]"
      style={{ gridTemplateColumns: viewport.isMobile ? '0px 0px 1fr 0px' : `${showRail ? '76px' : '0px'} ${cols}` }}
    >
      {moduleMode ? (
        <header
          data-testid="editor-header"
          data-keep-clear
          className="theme-chrome flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-panel px-3 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] sm:px-4"
          style={{ gridColumn: '1 / -1' }}
        >
          <AppMark />
          <button type="button" onClick={() => void leaveLayout()} className="tap-target shrink-0 rounded-lg px-2 py-1.5 text-sm font-semibold text-accent-text hover:bg-soft">
            Home
          </button>
          <h1 data-testid="module-editor-title" className="min-w-0 flex-1 truncate font-display text-[17px] font-bold">
            <span className="font-normal text-muted">Editing module: </span>
            {meta.data?.layout.title ?? '…'}
          </h1>
          {moduleCredit && (
            <span data-testid="credit" className="hidden min-w-0 truncate text-xs text-muted sm:inline">
              {moduleCredit}
            </span>
          )}
          <SavePill status={status} />
          {role === 'viewer' ? <ViewOnlyPill reason={viewOnlyReason} /> : viewport.isMobile && <ModeSwitch edit={phoneEdit} onChange={setPhoneEdit} />}
          <div className="ml-auto flex items-center gap-2">
            {role !== 'viewer' && !viewport.isMobile && (
              <input
                value={saveNote}
                onChange={(e) => {
                  setSaveNoteText(e.target.value);
                  docState.setSaveNote?.(e.target.value);
                }}
                maxLength={300}
                placeholder="What changed? (optional)"
                aria-label="What changed (optional)"
                className="h-[38px] w-56 rounded-control border border-line bg-soft px-3 text-sm"
              />
            )}
            {role !== 'viewer' && (
              <button
                type="button"
                onClick={() => void saveNow()}
                disabled={status.kind === 'saving'}
                title="Save the module (Ctrl+S)"
                className="h-[38px] shrink-0 rounded-control bg-accent px-4 text-sm font-bold text-accent-ink hover:bg-accent-hover disabled:opacity-50"
              >
                Save module
              </button>
            )}
            {role === 'owner' && catalogStatus.enabled('module') && (
              <button
                type="button"
                onClick={() => setSharingModule(true)}
                title="Share to the public catalog"
                className="h-[38px] shrink-0 rounded-control border border-line px-3 text-sm font-bold hover:bg-soft"
              >
                {catalogStatus.shared('module', layoutId) ? 'Publish update…' : 'Share…'}
              </button>
            )}
            {sharingModule && (
              <ShareToCatalogDialog
                kind="module"
                sourceId={layoutId}
                title={meta.data?.layout.title ?? 'Module'}
                existing={catalogStatus.shared('module', layoutId)}
                onClose={() => setSharingModule(false)}
              />
            )}
            <HelpButton helpKey="panel.moduleLibrary" />
            <HelpMenu />
            <SettingsButton onClick={() => setShowSettings(true)} />
          </div>
        </header>
      ) : viewport.isMobile ? (
        <header
          // Phone: the name gets a row of its own (with View / Edit, or "View only"), and
          // the save state and the buttons share the second row, so the
          // title never runs into the pills.
          data-testid="editor-header"
          data-keep-clear
          className="theme-chrome flex flex-col gap-1 border-b border-line bg-panel px-3 pb-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] sm:flex-row sm:items-center sm:gap-3 sm:pt-1.5"
          // (A phone on its side has the room for one row.)
          style={{ gridColumn: '1 / -1' }}
        >
          <div className="flex min-w-0 items-center gap-2 sm:flex-1">
            <AppMark />
            <div className="min-w-0 flex-1">
              <LayoutNameMenu
                title={meta.data?.layout.title ?? 'Untitled'}
                onNew={isViewer ? undefined : () => void leaveLayout('/?new=1')}
                onOpen={isViewer ? undefined : () => void leaveLayout('/?open=1')}
                onRename={role !== 'viewer' ? () => setRenaming(true) : undefined}
              >
                <ViewsMenuItems
                  views={savedViews}
                  activeViewId={activeViewId}
                  onGoTo={(v) => canvasActionsRef.current?.goToView(v)}
                  onWhole={showEverything}
                  onSharePicture={() => setSharePicture({})}
                  phone
                />
                {role !== 'viewer' && (
                  <button role="menuitem" type="button" data-testid="phone-map" onClick={() => setPhoneMapOpen((n) => n + 1)} className="block w-full px-3.5 py-3 text-left hover:bg-soft">
                    Map…
                  </button>
                )}
                {role !== 'viewer' && (
                  // Also with parts picked (the bar's Sheets button is only there with none): move them to a sheet.
                  <button role="menuitem" type="button" data-testid="phone-sheets" onClick={() => setShowTouchSheets(true)} className="block w-full px-3.5 py-3 text-left hover:bg-soft">
                    Sheets…
                  </button>
                )}
                <button role="menuitem" type="button" onClick={() => setShowSettings(true)} className="block w-full px-3.5 py-3 text-left hover:bg-soft">
                  Settings
                </button>
              </LayoutNameMenu>
              {role !== 'viewer' && (
                <Menu
                  label="Map"
                  mode="sheet"
                  openRequest={phoneMapOpen}
                  entries={resolveMenu(
                    phoneMapEntries(
                      {
                        openFile: openFilePicker,
                        generalInfo: () => setShowGeneralInfo(true),
                        backgroundColor: () => setShowBackgroundColor(true),
                        backgroundImage: () => setShowBackgroundImage(true),
                        find: () => setShowFind(true),
                        insertText: () => canvasActionsRef.current?.insertText(),
                        insertLabel: () => setShowAddLabel(true),
                        saveAsSet: () => setShowSaveAsSet(true),
                        importBbm: () => setShowImportBbm(true),
                        venueDesigner: () => setShowVenueDesigner(true),
                        venueDimensions: () => setShowVenueDimensions(true),
                        venueProps: () => setShowVenueProps(true),
                        venueSaveToLibrary,
                        venueExportFile,
                        venueLoadFromFile,
                        venueClear: () => void venueClear(),
                        fit: () => canvasActionsRef.current?.fit(),
                        budget: () => setShowBudget(true),
                        downloadLayout: () => void downloadLocalLayout(doc, layoutId, meta.data?.layout.title ?? 'layout', catalog.data?.parts),
                        downloadAs: () => setShowDownloadAs(true),
                        exportImage: onExportImage,
                        exportCsv: () => setShowPartList(true),
                        preferences: () => setShowPreferences(true),
                      },
                      mapToggles,
                      !isViewer,
                    ),
                    { moduleMode },
                  )}
                />
              )}
            </div>
            {/* Who else is here, beside the name: the second row has no room left on a phone. */}
            <PresencePanel awareness={awareness} compact />
            {role === 'viewer' ? <ViewOnlyPill reason={viewOnlyReason} /> : <ModeSwitch edit={phoneEdit} onChange={setPhoneEdit} />}
          </div>
          <div className="flex min-w-0 items-center gap-2 sm:shrink-0">
            <SavePill status={status} />
            <HelpButton helpKey="topbar.saveStatus" />
            <div className="ml-auto flex min-w-0 items-center justify-end gap-2">
              <button
                type="button"
                aria-label="Share picture"
                data-tour="share.picture"
                title="Share a picture of the layout"
                onClick={() => setSharePicture({})}
                className="flex size-11 shrink-0 items-center justify-center rounded-control border border-line text-ink hover:bg-soft"
              >
                <PictureIcon />
              </button>
              <button
                onClick={() => (me.data?.user ? setShowShare(true) : setSharePicture({}))}
                className="h-11 shrink-0 rounded-control bg-accent px-4 text-sm font-bold text-accent-ink hover:bg-accent-hover"
              >
                Share
              </button>
              <HelpMenu />
              <SettingsButton onClick={() => setShowSettings(true)} />
            </div>
          </div>
        </header>
      ) : (
      <header
        data-keep-clear
        // A tablet held upright (768-1023 px) has no room for three columns:
        // the task tabs get a row of their own under the name and buttons.
        className="theme-chrome grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-line bg-panel px-4 py-1.5 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
        style={{ gridColumn: '1 / -1' }}
      >
        <div className="flex min-w-0 items-center gap-3">
          <AppMark />
          <LayoutNameMenu
            title={meta.data?.layout.title ?? 'Untitled'}
            credit={creditLabel(meta.data?.layout.credit)}
            onNew={isViewer ? undefined : () => void leaveLayout('/?new=1')}
            onOpen={isViewer ? undefined : () => void leaveLayout('/?open=1')}
            onRename={role !== 'viewer' ? () => setRenaming(true) : undefined}
          >
            {isViewer && (
              <ViewsMenuItems
                views={savedViews}
                activeViewId={activeViewId}
                onGoTo={(v) => canvasActionsRef.current?.goToView(v)}
                onWhole={showEverything}
                onSharePicture={() => setSharePicture({})}
              />
            )}
            <button role="menuitem" type="button" onClick={() => setShowSettings(true)} className="block w-full px-3.5 py-2 text-left hover:bg-soft">
              Settings
            </button>
          </LayoutNameMenu>
          <SavePill status={status} />
          <HelpButton helpKey="topbar.saveStatus" />
          {isViewer && <ViewOnlyPill />}
        </div>
        {!isViewer ? (
          <div className="order-last col-span-2 flex items-center justify-center gap-2 lg:order-none lg:col-span-1">
            <TaskTabs task={task} onTask={onTask} />
            <HelpButton helpKey="topbar.tasks" />
          </div>
        ) : (
          <span className="hidden lg:block" />
        )}
        <div className="flex min-w-0 items-center justify-end gap-2.5">
          <PresencePanel awareness={awareness} />
          <button
            type="button"
            title="Share a picture of the layout"
            aria-label="Share picture"
                data-tour="share.picture"
            onClick={() => setSharePicture({})}
            className="inline-flex h-[38px] shrink-0 items-center gap-1.5 rounded-control border border-line px-3 text-sm font-bold text-ink hover:bg-soft"
          >
            <PictureIcon />
            {/* Just the picture on a narrower screen. */}
            <span className="hidden xl:inline">Share picture</span>
          </button>
          <button
            onClick={() => (me.data?.user ? setShowShare(true) : setSharePicture({}))}
            className="h-[38px] shrink-0 rounded-control bg-accent px-4 text-sm font-bold text-accent-ink hover:bg-accent-hover"
          >
            Share
          </button>
          <HelpMenu />
          <SettingsButton onClick={() => setShowSettings(true)} />
        </div>
      </header>
      )}
      {/* The edit toolbar. A viewer can't change anything, so there is
          nothing here for them: no Undo / Redo either. */}
      {!isViewer && !viewport.isMobile && (
      <div
        role="toolbar"
        aria-label="Edit"
        // Floating panels (Find) stay clear of it.
        data-keep-clear
        // Wraps onto a second row on a narrower screen rather than hiding
        // controls off the side.
        className="theme-chrome flex min-h-[42px] min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-panel px-3 py-1"
        style={{ gridColumn: '1 / -1' }}
      >
          <button
            onClick={undo.undo}
            disabled={!undo.canUndo}
            title={`Undo (${modKey()}+Z)`}
            className="shrink-0 rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-30"
          >
            Undo
          </button>
          <button
            onClick={undo.redo}
            disabled={!undo.canRedo}
            title={`Redo (${modKey()}+Shift+Z)`}
            className="shrink-0 rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-30"
          >
            Redo
          </button>
          <ActiveSheetControl doc={doc} />
          {!isViewer && (
            <HeaderEditButtons
              saveNow={saveNow}
              canvasActionsRef={canvasActionsRef}
              touch={touchTablet}
            />
          )}
          {!isViewer && (
            <>
              <SnapPicker />
              <HelpButton helpKey="toolbar.snap" />
              <RotationPicker />
              <HelpButton helpKey="toolbar.rotateStep" />
              <PaintColorPicker />
              <HelpButton helpKey="toolbar.paintColor" />
              <PanelsMenu
                dock={dock.state}
                onToggle={(id, visible) => dock.setZone(id, visible ? 'right' : 'hidden')}
              />
              <HelpButton helpKey="toolbar.panels" />
            </>
          )}
          {!isViewer && (
            <MapMenu
              moduleMode={moduleMode}
              onGeneralInfo={() => setShowGeneralInfo(true)}
              onBackgroundColor={() => setShowBackgroundColor(true)}
              onBackgroundImage={() => setShowBackgroundImage(true)}
              onFind={() => setShowFind(true)}
              onExportImage={onExportImage}
              onExportCsv={() => setShowPartList(true)}
              onImportBbm={() => setShowImportBbm(true)}
              onCreateModule={() => openMakeModule(doc)}
              onSaveAsSet={() => setShowSaveAsSet(true)}
              onInsertLabel={() => setShowAddLabel(true)}
              onInsertText={() => canvasActionsRef.current?.insertText()}
              onZoomIn={() => canvasActionsRef.current?.zoom(ZOOM_STEP)}
              onZoomOut={() => canvasActionsRef.current?.zoom(1 / ZOOM_STEP)}
              onFit={() => canvasActionsRef.current?.fit()}
              onDownloadLayout={() => void downloadLocalLayout(doc, layoutId, meta.data?.layout.title ?? 'layout', catalog.data?.parts)}
              onDownloadAs={() => setShowDownloadAs(true)}
              onPreferences={() => setShowPreferences(true)}
              onVenueProps={() => setShowVenueProps(true)}
              onVenueDesigner={() => setShowVenueDesigner(true)}
              onVenueDimensions={() => setShowVenueDimensions(true)}
              onVenueClear={() => void venueClear()}
              onVenueDrawOutline={() => {
                useEditorStore.getState().setTool('venueOutline');
              }}
              onVenueDrawObstacle={() => {
                useEditorStore.getState().setTool('venueObstacle');
              }}
              onBudget={() => setShowBudget((v) => !v)}
              onVenueSaveToLibrary={venueSaveToLibrary}
              onVenueExportFile={venueExportFile}
              onVenueLoadFromFile={venueLoadFromFile}
            />
          )}
          {!isViewer && (
            <button
              onClick={() => setShowInsertModule(true)}
              className="rounded-lg border border-border px-3 py-1 text-sm hover:bg-soft whitespace-nowrap"
              title="Insert a saved module"
            >
              Insert module
            </button>
          )}
          {/* Save is in the edit toolbar (Save, Ctrl+S); a module has Save module in its header. */}
      </div>
      )}
      {showRail && (
        <aside aria-label="Tool rail" className="overflow-y-auto border-r border-line bg-panel py-3" style={{ gridColumn: '1', gridRow: '3' }}>
          <Toolbar noVenue={moduleMode} />
          <div className="mt-2 flex justify-center">
            <HelpButton helpKey="tools.rail" target='nav[aria-label="Build tools"]' />
          </div>
        </aside>
      )}
      {showLeft && (
        <DockColumn
          panels={leftPanels}
          renderPanel={(id) => renderPanel(id, 'left')}
          gridColumn="2"
          panelHeights={dock.state.panelHeights}
          onResizePanel={dock.setPanelHeight}
          edge={
            // The drag-handle on the LEFT dock sits on its right edge:
            // when the user drags it, `clientX` is the new column
            // width measured from the left of the screen.
            <Resizer axis="column" onResize={(clientX) => dock.setDockWidth('left', clientX)} />
          }
          edgeSide="end"
        />
      )}
      <main
        ref={canvasBoxRef}
        data-testid="canvas-area"
        data-tour="map"
        // touch-action: none keeps the browser's page zoom and scrolling
        // off the canvas, so a pinch zooms the map, not the page.
        // No text selection or iOS callout on a long press either.
        className="relative touch-none select-none overflow-hidden [-webkit-touch-callout:none]"
        style={{
          gridColumn: '3',
          gridRow: '3',
          ...(touchEditing || touchTablet ? { ['--touch-bar-h' as string]: '4.25rem' } : {}),
          // Below the floating Undo / Redo (and the saved view's name above them) on a phone.
          ...(touchEditing ? { ['--touch-top' as string]: activeView ? '6.5rem' : '3.75rem' } : {}),
        }}
      >
        {activeView && (
          <div
            data-testid="active-view"
            data-no-gesture
            className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center px-3"
          >
            <div className="pointer-events-auto flex max-w-full items-center gap-1 rounded-full border border-line bg-panel py-1 pl-3.5 pr-1 text-sm text-ink shadow-pop">
              <span className="min-w-0 truncate">
                Showing <b>{activeView.name}</b>
              </span>
              <button type="button" onClick={showEverything} className="min-h-9 shrink-0 rounded-full px-3 text-accent-text hover:bg-soft pointer-coarse:min-h-11">
                Show everything
              </button>
            </div>
          </div>
        )}
        {touchEditing && <TouchUndoRedo undo={undo} top={activeView ? '3.25rem' : '0.5rem'} />}
        {(touchEditing || touchTablet) && (
          <TouchActionBar
            actions={{
              rotate: (cw) => canvasActionsRef.current?.rotate(cw),
              duplicate: (beside) => canvasActionsRef.current?.duplicate(beside),
              delete: () => canvasActionsRef.current?.delete(),
            }}
            onAddPart={() => setShowAddPart(true)}
            onPaste={() => canvasActionsRef.current?.clipboardByTouch('paste')}
            onTools={() => setShowTouchTools(true)}
            onSheets={() => setShowTouchSheets(true)}
            onEditText={openTouchText}
            onModule={isViewer || !doc ? undefined : () => {
              // One whole module picked: its menu. Otherwise make one.
              const sel = useEditorStore.getState().selection;
              const byPart = moduleByPart(readSidecarFromDoc(doc)?.modules ?? NO_MODULES);
              const first = sel[0] ? byPart.get(sel[0]) : undefined;
              const whole = first && first.members.length === sel.length && sel.every((id) => byPart.get(id)?.id === first.id);
              if (whole && !useEditorStore.getState().editingModuleId) setTouchModuleId(first.id);
              else openMakeModule(doc);
            }}
            onMore={isViewer || !doc ? undefined : () => setShowTouchPicked(true)}
          />
        )}
        {showTouchTools && !isViewer && <TouchToolsSheet onClose={() => setShowTouchTools(false)} />}
        {showTouchPicked && !isViewer && (
          <TouchPickedSheet
            onClose={() => setShowTouchPicked(false)}
            actions={{
              copy: () => canvasActionsRef.current?.clipboardByTouch('copy'),
              cut: () => canvasActionsRef.current?.clipboardByTouch('cut'),
              paste: () => canvasActionsRef.current?.clipboardByTouch('paste'),
              saveAsSet: () => setShowSaveAsSet(true),
              group: () => canvasActionsRef.current?.group(),
              ungroup: () => canvasActionsRef.current?.ungroup(),
              ungroupState: () => canvasActionsRef.current?.ungroupState() ?? 'nothing',
              selectConnected: () => canvasActionsRef.current?.selectConnected(),
              reorder: (to) => canvasActionsRef.current?.reorder(to),
              moveToSheet: () => setShowTouchSheets(true),
            }}
          />
        )}
        {touchModuleId && doc && <TouchModuleSheet doc={doc} moduleId={touchModuleId} onClose={() => setTouchModuleId(null)} />}

        <Canvas doc={doc} awareness={awareness} isViewer={isViewer} size={canvasSize} touchEl={canvasBox} phone={viewport.isMobile} saveNow={saveNow} placeAtCenterRef={placeAtCenterRef} exportImageRef={exportImageRef} canvasActionsRef={canvasActionsRef} undo={undo} onOpenVenueProps={() => setShowVenueProps(true)} onMakeModule={() => openMakeModule(doc)} />
      </main>
      {showRight && (
        <DockColumn
          panels={rightPanels}
          renderPanel={(id) => renderPanel(id, 'right')}
          gridColumn="4"
          panelHeights={dock.state.panelHeights}
          onResizePanel={dock.setPanelHeight}
          edge={
            // The drag-handle on the RIGHT dock sits on its left edge:
            // the new width is `viewport.width - clientX`.
            <Resizer
              axis="column"
              onResize={(clientX) =>
                dock.setDockWidth('right', window.innerWidth - clientX)
              }
            />
          }
          edgeSide="start"
        />
      )}
      {/* Floating panels — rendered via portal into document.body */}
      {panelsHere(dock.state.float).map((id) => {
        const pos = dock.state.floatPos[id];
        if (!pos) return null;
        return (
          <FloatingPanel
            key={id}
            panelId={id}
            title={panelTitle(id)}
            pos={pos}
            onMove={(pid, z) => dock.setZone(pid, z)}
            onPosChange={dock.setFloatPos}
          >
            {panelBody(id)}
          </FloatingPanel>
        );
      })}
      <SheetChoiceHost />
      {touchText && (
        <TextEditSheet title={touchText.title} initial={touchText.text} onSave={touchText.save} onClose={() => setTouchText(null)} />
      )}
      {showTouchSheets && (touchEditing || touchTablet) && docMap && (
        <SheetsSheet
          map={docMap}
          doc={doc}
          onClose={() => setShowTouchSheets(false)}
          onMovePicked={isViewer ? undefined : (id) => canvasActionsRef.current?.moveToSheet(id)}
        />
      )}
      {showAddPart && (touchEditing || touchTablet) && (
        <AddPartSheet
          onClose={() => setShowAddPart(false)}
          onPick={(part) => {
            setShowAddPart(false);
            placeAtCenterRef.current?.(part);
          }}
        />
      )}
      <Suspense fallback={null}>
      {showShare && me.data?.user && meta.data && (
        <ShareDialog
          layoutId={layoutId}
          layoutTitle={meta.data.layout.title}
          myRole={role}
          myUserId={me.data.user.id}
          onClose={() => setShowShare(false)}
          onSharePicture={() => {
            setShowShare(false);
            setSharePicture({});
          }}
          {...(!moduleMode
            ? {
                onShareToCatalog: () => {
                  setShowShare(false);
                  setSharingLayout(true);
                },
              }
            : {})}
        />
      )}
      {sharingLayout && !moduleMode && meta.data && catalogStatus.enabled('layout') && (
        <ShareToCatalogDialog
          kind="layout"
          sourceId={layoutId}
          title={meta.data.layout.title}
          existing={catalogStatus.shared('layout', layoutId)}
          onClose={() => setSharingLayout(false)}
          makeThumbnail={async () => {
            if (!doc) return null;
            await waitForPartPictures(() => catalogReadyRef.current, getSpriteProgress);
            return makeModuleThumbnail(exportImageRef.current, projectDoc(doc), readSidecarFromDoc(doc));
          }}
        />
      )}
      {sharePicture && docMap && (
        <SharePictureDialog
          layoutTitle={meta.data?.layout.title ?? 'layout'}
          views={savedViews}
          map={docMap}
          sidecar={readSidecarFromDoc(doc)}
          exportImageRef={exportImageRef}
          phone={viewport.isMobile}
          {...(sharePicture.choice ? { initialChoice: sharePicture.choice } : {})}
          onMoreOptions={() => {
            setSharePicture(null);
            setShowExportImage(true);
          }}
          onClose={() => setSharePicture(null)}
        />
      )}
      {/* Status bar — port of MainWindow.cpp:861-1014 status widgets.
          Spans every column. Shows mouse coords / selection count / zoom. */}
      <NoticeToast lifted={touchEditing || touchTablet} />
      {docState.signedOut && <SignedOutCard what={moduleMode ? 'module' : 'layout'} reconnect={docState.reconnect} />}
      <DropSheetTag />
      {openedFile && !loading && docMap && catalog.data && (
        <OpenedSummaryCard
          name={openedFile}
          map={docMap}
          index={partIndex}
          warnings={openWarnings ?? []}
          onClose={closeOpenedSummary}
          lifted={touchEditing || touchTablet}
        />
      )}
      {showStatusBar && <StatusBar
        gridSpan={headerColSpan}
        compact={viewport.isMobile}
        onZoomIn={() => canvasActionsRef.current?.zoom(ZOOM_STEP)}
        onZoomOut={() => canvasActionsRef.current?.zoom(1 / ZOOM_STEP)}
        onFit={() => canvasActionsRef.current?.fit()}
        status={status}
        venue={doc ? (readSidecarFromDoc(doc)?.venue ?? null) : null}
        budgetLimits={budgetLimits}
        budgetMap={docMap}
      />}

      {showInsertModule && (
        <InsertModuleDialog doc={doc} onClose={() => setShowInsertModule(false)} />
      )}
      {doc && !isViewer && (
        <Suspense fallback={null}>
          <ModuleDialogHost
            doc={doc}
            layoutOwnerOrgId={meta.data?.layout.ownerOrgId ?? null}
            makeThumbnail={(region) => makeRegionThumbnail(exportImageRef.current, region)}
          />
        </Suspense>
      )}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {renaming && (
        <RenameDialog
          heading={moduleMode ? 'Rename module' : 'Rename layout'}
          current={meta.data?.layout.title ?? ''}
          onSave={async (name) => {
            await (moduleMode ? api.modules.rename(layoutId, name) : api.layouts.rename(layoutId, name));
            await Promise.all([
              qc.invalidateQueries({ queryKey: [moduleMode ? 'module' : 'layout', layoutId] }),
              qc.invalidateQueries({ queryKey: [moduleMode ? 'modules' : 'layouts'] }),
            ]);
          }}
          onClose={() => setRenaming(false)}
        />
      )}
      {showGeneralInfo && docMap && (
        <GeneralInfoDialog map={docMap} doc={doc} onClose={() => setShowGeneralInfo(false)} />
      )}
      {showBackgroundColor && docMap && (
        <BackgroundColorDialog
          current={docMap.backgroundColor}
          doc={doc}
          onClose={() => setShowBackgroundColor(false)}
        />
      )}
      {showBackgroundImage && (
        <BackgroundImageDialog
          layoutId={layoutId}
          doc={doc}
          map={docMap}
          onClose={() => setShowBackgroundImage(false)}
        />
      )}
      {showFind && docMap && (
        <FindDialog map={docMap} doc={doc} onClose={() => setShowFind(false)} />
      )}
      {showExportImage && (
        <ExportImageDialog
          layoutTitle={meta.data?.layout.title ?? 'layout'}
          exportImageRef={exportImageRef}
          onClose={() => setShowExportImage(false)}
        />
      )}
      {showPreferences && (
        <PreferencesDialog onClose={() => setShowPreferences(false)} />
      )}
      {showImportBbm && (
        <ImportBbmDialog doc={doc} onClose={() => setShowImportBbm(false)} />
      )}
      {showSaveAsSet && doc && (
        <SaveAsSetDialog
          doc={doc}
          viewOnly={role === 'viewer'}
          onClose={() => setShowSaveAsSet(false)}
        />
      )}
      {showAddLabel && (
        <AddAnchoredLabelDialog
          doc={doc}
          defaultTargetId={
            useEditorStore.getState().selection.length === 1
              ? (useEditorStore.getState().selection[0] ?? null)
              : null
          }
          viewCentre={snapPoint(
            canvasActionsRef.current?.viewCentre() ?? viewCentreStuds(viewport),
            useEditorStore.getState().snapStepStuds,
          )}
          onClose={() => setShowAddLabel(false)}
        />
      )}
      {showVenueSaveLibrary && doc && (() => {
        const venue = readSidecarFromDoc(doc)?.venue;
        if (!venue) return null;
        return (
          <VenueSaveLibraryDialog
            venueName={venue.name || ''}
            orgs={myOrgs.data?.orgs ?? []}
            onSave={(orgSlug, name) => {
              setShowVenueSaveLibrary(false);
              const orgId = orgSlug ? (myOrgs.data?.orgs.find((o) => o.slug === orgSlug)?.id ?? null) : null;
              void (async () => {
                const saved = (await qc.fetchQuery({ queryKey: ['venue-library'], queryFn: api.venues.list })).venues;
                const r = await saveVenueToLibrary(venue, name, { ...(orgSlug ? { orgSlug } : {}), orgId }, saved, api.venues, askOverwrite);
                if (r === 'cancelled') return;
                useEditorStore.getState().showStatusMessage('Venue saved to the Venue library.');
                await qc.invalidateQueries({ queryKey: ['venue-library'] });
              })().catch((e) => useEditorStore.getState().showNotice(`Couldn’t save the venue: ${(e as Error).message}`, 'error', 10000));
            }}
            onClose={() => setShowVenueSaveLibrary(false)}
          />
        );
      })()}
      {showVenueDesigner && doc && !isViewer && (
        <VenueDesigner
          initial={readSidecarFromDoc(doc)?.venue ?? emptyVenue(meta.data?.layout.title ? `${meta.data.layout.title} venue` : 'Venue')}
          subtitle={`Venue of ${meta.data?.layout.title ?? 'this layout'}`}
          saveLabel="Save to layout"
          onSave={(v) => {
            setVenue(doc, v);
            useEditorStore.getState().showStatusMessage('Venue saved to the layout.');
          }}
          onClose={() => setShowVenueDesigner(false)}
        />
      )}
      {showVenueProps && doc && (
        <VenuePropertiesDialog
          doc={doc}
          venue={readSidecarFromDoc(doc)?.venue ?? null}
          onClose={() => setShowVenueProps(false)}
        />
      )}
      {showVenueDimensions && doc && (
        <VenueDimensionsDialog
          doc={doc}
          onClose={() => setShowVenueDimensions(false)}
        />
      )}
      {showDownloadAs && docMap && (
        <DownloadAsDialog
          map={docMap}
          parts={catalog.data?.parts ?? []}
          title={meta.data?.layout.title ?? 'layout'}
          onDownloadLayout={() => void downloadLocalLayout(doc, layoutId, meta.data?.layout.title ?? 'layout', catalog.data?.parts)}
          onDownloadBbm={() => void downloadLocalBbm(doc, meta.data?.layout.title ?? 'layout')}
          blueBrickLeavesOut={blueBrickLeavesOut(readSidecarFromDoc(doc))}
          onClose={() => setShowDownloadAs(false)}
        />
      )}
      {showPartList && docMap && (
        <PartListDialog
          map={docMap}
          parts={partIndex}
          limits={budgetLimits}
          layoutTitle={meta.data?.layout.title ?? 'parts'}
          onClose={() => setShowPartList(false)}
        />
      )}
      {showBudget && (
        <BudgetDialog
          map={docMap}
          limits={budgetLimits}
          onLimitsChange={(next) => setBudgetLimits(doc, next)}
          resolvePart={(id) => actualPartNumber(partIndex, id)}
          partName={(id) => partIndex.get(id.toLowerCase())?.description || undefined}
          clearRight={rightWidthPx}
          onClose={() => setShowBudget(false)}
        />
      )}
      </Suspense>
    </div>
    </div>
  );
}

function Canvas({
  doc,
  awareness,
  isViewer,
  size,
  touchEl,
  phone,
  saveNow,
  placeAtCenterRef,
  exportImageRef,
  canvasActionsRef,
  undo,
  onOpenVenueProps,
  onMakeModule,
}: {
  doc: import('yjs').Doc;
  awareness: import('y-protocols/awareness').Awareness | null;
  isViewer: boolean;
  /** The canvas area's measured size. */
  size: { width: number; height: number };
  /** The canvas area element, for touch pan and pinch. */
  touchEl: HTMLElement | null;
  /** The phone viewer: one-finger pan, roomier fit, unreadable text hidden. */
  phone: boolean;
  saveNow: () => Promise<void> | void;
  placeAtCenterRef: React.MutableRefObject<((part: PartWire) => void) | null>;
  exportImageRef: React.MutableRefObject<import('./ExportImageDialog').ExportHandle | null>;
  canvasActionsRef: React.MutableRefObject<CanvasActions | null>;
  undo: { canUndo: boolean; canRedo: boolean; undo: () => void; redo: () => void };
  onOpenVenueProps: () => void;
  /** Make a module from the picked parts. */
  onMakeModule: () => void;
}) {
  const stageRef = useRef<Konva.Stage | null>(null);
  // The parts layer draws only what's on screen, and its hit canvas when it's
  // asked (render/cullOffscreen.ts): a change on a big layout redraws far less.
  const partsLayerRef = useRef<Konva.Layer | null>(null);
  useEffect(() => {
    const layer = partsLayerRef.current;
    return layer ? cullOffscreen(layer) : undefined;
  }, []);
  const hudLayerRef = useRef<Konva.Layer | null>(null);
  const { width, height } = size;
  // Touch, on phones and tablets alike: two fingers pan and zoom, one
  // finger moves the view, except that when editing a finger on a picked
  // part drags the part (Konva's drag, with the desktop's snapping). A tap
  // picks a part (Konva's tap) or, on empty map, clears the pick; a long
  // press picks more.
  /** The part under a point of the canvas area, from Konva's own hit test. */
  const brickAt = (p: Pt): { id: string; node: Konva.Node } | null => {
    const hit = itemAt(p);
    return hit?.kind === 'brick' ? hit : null;
  };
  /** The part, anchored label or text cell under a point of the canvas area. */
  const itemAt = (p: Pt): { kind: 'brick' | 'labels' | 'texts' | 'handle'; id: string; node: Konva.Node } | null => {
    const stage = stageRef.current;
    if (!stage || !touchEl) return null;
    const area = touchEl.getBoundingClientRect();
    const box = stage.container().getBoundingClientRect();
    freshHit();
    const shape = stage.getIntersection({ x: p.x + area.left - box.left, y: p.y + area.top - box.top });
    if (!shape) return null;
    if (shape.name() === 'text-cell') return { kind: 'texts', id: shape.id(), node: shape };
    // A picked ruler's round handles: the finger drags them, never pans.
    if (shape.name() === 'ruler-endpoint' || shape.name() === 'ruler-scale') return { kind: 'handle', id: '', node: shape };
    // A bend handle: the finger bends the run (BendHandles), never pans.
    const handle = shape.findAncestor((n: Konva.Node) => n.name() === BEND_HANDLE_NAME);
    if (handle) return { kind: 'handle', id: '', node: handle };
    const g = shape.findAncestor((n: Konva.Node) => n.getClassName() === 'Group' && /^(brick|label)-/.test(n.name()));
    if (!g) return null;
    return g.name().startsWith('brick-')
      ? { kind: 'brick', id: g.name().slice('brick-'.length), node: g }
      : { kind: 'labels', id: g.name().slice('label-'.length), node: g };
  };
  const isPicked = (id: string) => useEditorStore.getState().selection.includes(id);
  /** Picked, so a finger on it drags it: a part or an anchored label (text cells don't drag). */
  const dragsPicked = (hit: ReturnType<typeof itemAt>) => {
    if (!hit) return false;
    if (hit.kind === 'handle') return true;
    if (hit.kind === 'brick') return isPicked(hit.id);
    return hit.kind === 'labels' && useEditorStore.getState().annoSelection.labels.includes(hit.id);
  };
  /** A point of the canvas area in studs. */
  const areaStuds = (p: Pt): Pt | null => {
    const stage = stageRef.current;
    if (!stage || !touchEl) return null;
    const area = touchEl.getBoundingClientRect();
    const box = stage.container().getBoundingClientRect();
    const st = useEditorStore.getState();
    return {
      x: pxToStud((p.x + area.left - box.left - st.panX) / st.zoom),
      y: pxToStud((p.y + area.top - box.top - st.panY) / st.zoom),
    };
  };
  /**
   * A ruler by touch: the first tap is its start (a circle's middle), on
   * the grid as with a mouse; the second its end (a point on the edge).
   * It's then picked, with handles to drag, and the tool goes back to
   * picking.
   */
  function touchRulerTap(p: Pt): void {
    const at = areaStuds(p);
    if (!at) return;
    const pt = gridPointStuds(at);
    const st = useEditorStore.getState();
    const start = st.touchRulerStart;
    if (!start) {
      useEditorStore.setState({ touchRulerStart: pt });
      return;
    }
    const length = Math.hypot(pt.x - start.x, pt.y - start.y);
    // The same spot again: still waiting for the end.
    if (length < 0.5) return;
    const layerId = ensureRulerLayer(doc, st.activeLayerId);
    const id = st.tool === 'rulerCircular' ? addCircularRuler(doc, layerId, start, length) : addLinearRuler(doc, layerId, start, pt);
    announcePlacement([layerId], null, 'Your ruler');
    st.setTool('select');
    useEditorStore.setState({ selection: [], annoSelection: { ...EMPTY_ANNO, rulers: [id] } });
  }
  /**
   * Painting areas by touch, one finger's stroke: the squares under it
   * are painted (or erased) as it goes; a tap paints one. Nothing is
   * painted until the finger has moved a little or stayed a moment, so a
   * second finger landing for a pinch doesn't leave a square behind.
   */
  const touchStrokeRef = useRef<{ at: number; last: Pt | null; painting: boolean } | null>(null);
  function touchPaint(phase: 'move' | 'end' | 'cancel', from: Pt, to: Pt): void {
    if (phase === 'cancel') {
      touchStrokeRef.current = null;
      paintStrokeRef.current = null;
      return;
    }
    const stroke = (touchStrokeRef.current ??= { at: performance.now(), last: null, painting: false });
    if (!stroke.painting) {
      const settled = phase === 'end' || performance.now() - stroke.at >= 100 || Math.hypot(to.x - from.x, to.y - from.y) >= 12;
      if (!settled) return;
      stroke.painting = true;
      paintStrokeRef.current = new Set();
    }
    paintAlong(stroke.last ?? from, to);
    stroke.last = to;
    if (phase === 'end') {
      touchStrokeRef.current = null;
      paintStrokeRef.current = null;
    }
  }
  /** Paints the squares on the line from `a` to `b` (canvas-area px), so a fast finger leaves no gaps. */
  function paintAlong(a: Pt, b: Pt): void {
    const sa = areaStuds(a);
    const sb = areaStuds(b);
    if (!sa || !sb) return;
    const steps = Math.max(1, Math.ceil(Math.hypot(sb.x - sa.x, sb.y - sa.y) / 2));
    for (let i = 0; i <= steps; i++) doPaintStroke(sa.x + ((sb.x - sa.x) * i) / steps, sa.y + ((sb.y - sa.y) * i) / steps);
  }
  /** Where a long press on empty map offers "Paste here": the spot on the canvas area, and in studs. */
  const [pasteSpot, setPasteSpot] = useState<{ x: number; y: number; studs: Pt } | null>(null);
  useTouchView(
    touchEl,
    () => {
      const st = useEditorStore.getState();
      return { zoom: st.zoom, panX: st.panX, panY: st.panY };
    },
    (v) => useEditorStore.setState(v),
    {
      oneFingerPan: true,
      range: { min: MIN_ZOOM, max: MAX_ZOOM },
      panFrom: (p) => {
        if (isViewer || useEditorStore.getState().tool !== 'select') return true;
        return !dragsPicked(itemAt(p));
      },
      // "Select area": one finger draws a box, except on a picked part,
      // which it still drags.
      boxFrom: (p) => {
        const st = useEditorStore.getState();
        // Painting areas: one finger paints (touchPaint).
        if (!isViewer && (st.tool === 'paint' || st.tool === 'erase')) return true;
        if (isViewer || st.tool !== 'select' || !st.touchSelectArea) return false;
        return !dragsPicked(itemAt(p));
      },
      onBox: (phase, from, to) => {
        const tool = useEditorStore.getState().tool;
        if (tool === 'paint' || tool === 'erase') {
          touchPaint(phase, from, to);
          return;
        }
        const a = areaStuds(from);
        const b = areaStuds(to);
        if (phase === 'cancel' || !a || !b) {
          setMarquee(null);
          return;
        }
        const band = { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
        if (phase === 'move') {
          setMarquee(band);
          return;
        }
        setMarquee(null);
        // A box with no size is a tap, handled as one.
        if (Math.hypot(to.x - from.x, to.y - from.y) < 8) return;
        commitMarquee(band, useEditorStore.getState().touchSelectMore);
      },
      // Drawn once when they let go (in the same frame as the last view's
      // redraw, so only once).
      onViewMoving: (moving) => {
        if (moving) setPasteSpot(null);
        setViewMoving(moving);
      },
      onPinchStart: () => {
        // A part being dragged by the first finger stays where it is.
        const stage = stageRef.current;
        if (!stage) return;
        for (const id of useEditorStore.getState().selection) {
          const node = stage.findOne(`.brick-${id}`);
          if (node?.isDragging()) node.stopDrag();
        }
      },
      onTap: (p) => {
        setPasteSpot(null);
        if (isViewer) return;
        const st = useEditorStore.getState();
        if (st.tool === 'rulerLinear' || st.tool === 'rulerCircular') {
          touchRulerTap(p);
          return;
        }
        if (st.tool !== 'select' || st.touchSelectMore) return;
        // A part, label or text handles its own tap; empty map clears the pick.
        if (!itemAt(p)) st.setSelection([]);
      },
      onLongPress: (p) => {
        if (isViewer || useEditorStore.getState().tool !== 'select') return;
        const hit = brickAt(p);
        if (!hit) {
          // Held down on empty map: offer to paste there.
          if (itemAt(p)) return;
          const at = areaStuds(p);
          if (at) setPasteSpot({ x: p.x, y: p.y, studs: at });
          return;
        }
        // Held down: pick this part as well, and keep picking more with taps.
        const st = useEditorStore.getState();
        if (!st.selection.includes(hit.id)) useEditorStore.setState({ selection: shapeSelectionIds([...st.selection, hit.id]) });
        useEditorStore.setState({ touchSelectMore: true });
        try {
          navigator.vibrate?.(15);
        } catch {
          // No vibration here.
        }
      },
    },
  );
  // A finger on a part that isn't picked moves the view, so Konva mustn't
  // start dragging that part. Two fingers zoom and move the view wherever
  // they land, so nothing under either of them drags: a pinch on a busy
  // layout moved whatever part the second finger came down on. Turned off
  // as the finger lands (capture, so before Konva sees it) and back on
  // when the last one lifts.
  useEffect(() => {
    if (!touchEl || isViewer) return;
    let held: Konva.Node[] = [];
    const hold = (node: Konva.Node) => {
      if (!node.draggable()) return;
      // (Also ends a drag this node had begun, where it is.)
      node.draggable(false);
      held.push(node);
    };
    const release = (e: TouchEvent) => {
      if (e.touches.length > 0) return;
      for (const node of held) node.draggable(true);
      held = [];
    };
    const down = (e: TouchEvent) => {
      lastTouchAtRef.current = Date.now();
      if ((e.target as Element | null)?.closest?.('[data-no-gesture]')) return;
      const area = touchEl.getBoundingClientRect();
      const under = (t: Touch) => itemAt({ x: t.clientX - area.left, y: t.clientY - area.top });
      if (e.touches.length >= 2) {
        for (const t of Array.from(e.touches)) {
          const hit = under(t);
          if (hit) hold(hit.node);
        }
        return;
      }
      const hit = e.touches[0] ? under(e.touches[0]) : null;
      if (hit && hit.kind !== 'texts' && !dragsPicked(hit)) hold(hit.node);
    };
    touchEl.addEventListener('touchstart', down, { capture: true });
    touchEl.addEventListener('touchend', release);
    touchEl.addEventListener('touchcancel', release);
    return () => {
      for (const node of held) node.draggable(true);
      touchEl.removeEventListener('touchstart', down, { capture: true });
      touchEl.removeEventListener('touchend', release);
      touchEl.removeEventListener('touchcancel', release);
    };
    // brickAt reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touchEl, isViewer]);
  // The phone turned (or the window changed size) in the middle of a drag:
  // the view then fits the new screen, and the part jumped out from under
  // the finger. The drag ends where the part is, before the view changes,
  // as a second finger coming down ends it (onPinchStart). The window's
  // own size, so the editor's bars changing height never end a drag.
  useEffect(() => {
    let w = window.innerWidth;
    let h = window.innerHeight;
    const settle = (turned: boolean) => {
      if (!turned && window.innerWidth === w && window.innerHeight === h) return;
      w = window.innerWidth;
      h = window.innerHeight;
      const stage = stageRef.current;
      if (!stage) return;
      for (const node of stage.find((n: Konva.Node) => n.isDragging())) node.stopDrag();
    };
    const onResize = () => settle(false);
    const onTurn = () => settle(true);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onTurn);
    screen.orientation?.addEventListener?.('change', onTurn);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onTurn);
      screen.orientation?.removeEventListener?.('change', onTurn);
    };
  }, []);
  /** When a finger last came down: a long press also fires contextmenu, which isn't a right-click. */
  const lastTouchAtRef = useRef(0);
  // On a phone, text too small to read is left out (textLegibility.ts).
  useEffect(() => {
    useEditorStore.getState().setMinTextPx(phone ? PHONE_MIN_TEXT_PX : 0);
    return () => useEditorStore.getState().setMinTextPx(0);
  }, [phone]);
  // Pan/zoom are plain React state, passed straight to <Stage> as
  // x/y/scaleX/scaleY props below. (An earlier version additionally
  // pushed these onto the Stage node imperatively via a raw
  // `useEditorStore.subscribe`, with no selector — that callback fired
  // on EVERY store write, including the hud-mouse-coord update on every
  // single mousemove, so a `stage.batchDraw()` ran on every pixel of
  // mouse movement, including during a brick drag. It was pure
  // redundant work — the props below already keep the Stage in sync —
  // and competed with Konva's own drag-move redraws, making drags feel
  // like they stalled or wouldn't move. Removed; see issue about
  // dragging bricks being unresponsive.)
  // They are the stage's view (stageView): while the view moves it stays
  // put and the canvas follows by CSS (followView), so a pan renders nothing.
  const zoom = useEditorStore((s) => s.stageView.zoom);
  const panX = useEditorStore((s) => s.stageView.panX);
  const panY = useEditorStore((s) => s.stageView.panY);
  const tool = useEditorStore((s) => s.tool);
  const activeLayerId = useEditorStore((s) => s.activeLayerId);
  const setActiveLayer = useEditorStore((s) => s.setActiveLayer);
  const selection = useEditorStore((s) => s.selection);
  const snapStepStuds = useEditorStore((s) => s.snapStepStuds);
  const rotationStepDegrees = useEditorStore((s) => s.rotationStepDegrees);
  const setSelection = useEditorStore((s) => s.setSelection);
  const editingModuleId = useEditorStore((s) => s.editingModuleId);
  // Modules are picked as one piece, and while one is edited only its
  // parts can be picked (moduleEdit.ts shapeSelection).
  useEffect(() => {
    // A set (or a user's group) picks whole, then modules as before.
    setSelectionShaper((ids) =>
      shapeSelection(expandToGroups(ids, mapRef.current), readSidecarFromDoc(doc)?.modules ?? NO_MODULES, useEditorStore.getState().editingModuleId),
    );
    return () => setSelectionShaper(null);
  }, [doc]);
  // The module being edited was deleted (here or by someone else), or the
  // viewer can't edit: back to the whole layout.
  const editedModule = editingModuleId !== null ? (readSidecarFromDoc(doc)?.modules ?? NO_MODULES).find((m) => m.id === editingModuleId) : undefined;
  const editedModuleGone = editingModuleId !== null && (isViewer || !editedModule);
  // Its name while it was there, and whether the layout's last change came
  // from someone else: when they ungrouped or deleted the module, the
  // person editing it is told why Edit module closed.
  const editedModuleName = useRef('');
  if (editedModule) editedModuleName.current = editedModule.name;
  const lastChangeElsewhere = useRef(false);
  useEffect(() => {
    const onTransaction = (tr: Y.Transaction) => {
      if (tr.changed.size > 0) lastChangeElsewhere.current = !tr.local;
    };
    doc.on('afterTransaction', onTransaction);
    return () => doc.off('afterTransaction', onTransaction);
  }, [doc]);
  useEffect(() => {
    if (!editedModuleGone) return;
    if (!isViewer && lastChangeElsewhere.current) {
      const name = editedModuleName.current;
      useEditorStore
        .getState()
        .showNotice(
          `${name ? `“${name}”` : 'The module you were editing'} isn’t a module any more: someone ungrouped or deleted it. You’re back in the whole layout.`,
          'done',
          8000,
        );
    }
    leaveModuleEdit();
  }, [editedModuleGone, isViewer]);
  // Leaving the editor leaves Edit module too.
  useEffect(() => () => leaveModuleEdit(), []);
  const showElectricCircuits = useEditorStore((s) => s.showElectricCircuits);
  const venueLabelPx = useEditorStore((s) => s.venueLabelPx);



  // External drag-from-Parts-panel state. While the user is dragging a
  // thumbnail over the canvas the panel emits a custom MIME (key) on
  // dragover; we render the same PlaceGhost as the place tool so the
  // user sees a live preview with snap-to-connection. Mirrors desktop
  // `MapView::dragMoveEvent` + `updateDragPreview` (MapView.cpp:1678-1761).
  const [dropPart, setDropPart] = useState<DropPart | null>(null);
  // Same for a module dragged from the Module library: cursor position
  // plus the module's snapshot, fetched once per drag (MapView.cpp:1796-1900).
  const [dropModule, setDropModule] = useState<
    { studX: number; studY: number; offset?: { dx: number; dy: number; turn?: GroupTurn } } | null
  >(null);
  // Snap state of the part / module being dragged in (hold, speed gate).
  const placeSnapRef = useRef(new SnapSession());
  const moduleSnapRef = useRef(new SnapSession());
  // The Snap strength setting lives on the account; drag handlers read it
  // from the editor store.
  const { prefs: accountPrefs } = usePreferences();
  const connectionSnapPref = accountPrefs.connectionSnap ?? DEFAULT_SNAP_STRENGTH;
  useEffect(() => {
    useEditorStore.getState().setConnectionSnap(connectionSnapPref);
  }, [connectionSnapPref]);
  const moduleDragRef = useRef<{ key: string; batches: Promise<ModuleBatch[]>; ready: ModuleBatch[] | null } | null>(null);
  const [, setModuleDragReady] = useState(0);

  // Marquee state. Active while the user is dragging in select mode on
  // empty stage. Mouse-up commits the intersection to selection.
  const [marquee, setMarquee] = useState<import('./render/MarqueeOverlay').Marquee | null>(null);
  const marqueeAdditiveRef = useRef(false);

  // Context-menu state — position in viewport px + whether the click
  // landed on a brick (drives the selection-aware entry list).
  // The Module look window, opened from the map's right-click menu.
  const [lookModuleId, setLookModuleId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    studX: number;
    studY: number;
    onBrick: boolean;
    textCellRef: TextCellRef | null;
    rulerRef: { item: import('@cld/model').RulerItem; layerId: string } | null;
    brickIdUnderCursor: string | null;
  } | null>(null);

  // Edit-Brick dialog state — opened by double-click on a brick.
  const [editing, setEditing] = useState<
    { brick: import('@cld/model').Brick; layerId: string; meta: PartWire | undefined } | null
  >(null);

  const onEditBrick = useCallback(
    (brick: import('@cld/model').Brick, layerId: string, meta: PartWire | undefined) =>
      setEditing({ brick, layerId, meta }),
    [],
  );

  // The Turn tool: a click picks the part (its group or module) and turns
  // it clockwise by the turn step; Shift+click turns it back. The latest
  // rotatePicked, through a ref, so the parts' handler stays the same.
  const turnRef = useRef<(ids: readonly string[], back: boolean) => void>(() => undefined);
  const onTurnPart = useCallback((ids: readonly string[], back: boolean) => turnRef.current(ids, back), []);

  // Edit-AnchoredLabel dialog state — opened by double-click on a label.
  const [editingLabel, setEditingLabel] = useState<import('@cld/bbm').AnchoredLabel | null>(null);

  // Mixed selection: rulers, anchored labels and text cells selected
  // alongside bricks (store `annoSelection`; desktop Qt scene selection,
  // MapViewDrag.cpp:124-153). Endpoint handles and the ruler-attach menu
  // need exactly one ruler.
  const annoSelection = useEditorStore((s) => s.annoSelection);
  const selectedRulerIds = useMemo(() => new Set(annoSelection.rulers), [annoSelection.rulers]);
  const selectedLabelIds = useMemo(() => new Set(annoSelection.labels), [annoSelection.labels]);
  const selectedTextKeys = useMemo(() => new Set(annoSelection.texts), [annoSelection.texts]);
  const selectedRulerId = annoSelection.rulers.length === 1 ? annoSelection.rulers[0]! : null;
  /** Select an annotation: plain click → just it; Shift/Ctrl → toggle, keep the rest. */
  const selectAnno = useCallback((kind: keyof AnnoSelection, id: string, additive: boolean) => {
    const st = useEditorStore.getState();
    const next = clickAnno(st.selection, st.annoSelection, kind, id, additive);
    st.setMixedSelection(next.bricks, next.anno);
  }, []);
  const [editingRuler, setEditingRuler] = useState<
    { item: import('@cld/model').RulerItem; layerId: string } | null
  >(null);

  // Add-Text dialog state — opened by T.
  const [showAddText, setShowAddText] = useState(false);
  // Where "Add Text Here…" was invoked (studs); null = at the cursor.
  const [addTextAt, setAddTextAt] = useState<{ x: number; y: number } | null>(null);

  // Edit-Text dialog state — opened by double-click or context menu on a text cell.
  const [editingText, setEditingText] = useState<TextCellRef | null>(null);

  // Ruler-draw draft (linear or circular) — start point + current
  // mouse pos in stud space. Cleared on commit / cancel. Mirrors
  // desktop's `drawingRuler_` flag (MapView.cpp:454-468).
  const [rulerDraft, setRulerDraft] = useState<{
    kind: 'linear' | 'circular';
    startX: number;
    startY: number;
    curX: number;
    curY: number;
  } | null>(null);

  // While a ruler is drawn, the status bar also shows its length or
  // radius (MapView.cpp:661-680), as a backup to the floating label.
  useEffect(() => {
    if (!rulerDraft) return;
    const len = Math.hypot(rulerDraft.curX - rulerDraft.startX, rulerDraft.curY - rulerDraft.startY);
    if (len === 0) return;
    useEditorStore.getState().showStatusMessage(rulerStatusMessage(len, rulerDraft.kind === 'circular'), 1200);
  }, [rulerDraft]);

  // Venue-draw draft — accumulated polygon vertices in stud space.
  // `curX/curY` tracks the live preview cursor vertex.
  // Used for both venueOutline and venueObstacle tools.
  const [venueDraft, setVenueDraft] = useState<{
    kind: 'outline' | 'obstacle';
    pts: { x: number; y: number }[];
    curX: number;
    curY: number;
  } | null>(null);

  // Middle-button pan anchor — desktop MapView::mousePressEvent path at
  // MapView.cpp:446-451 ("if (e->button() == Qt::MiddleButton)").
  // While held, mousemove translates panX/panY by the cursor delta.
  const middlePanRef = useRef<{ lastX: number; lastY: number } | null>(null);
  /**
   * While the view moves (a middle-button pan, a turn of the wheel, fingers
   * on a touch screen) Konva needn't redraw its hit canvas (what a click
   * would land on) every frame: on a big layout that was about a third of
   * each frame. It's drawn once when the view stops.
   */
  const viewStillTimer = useRef<number | null>(null);
  /** The map as one moving picture while the view moves (viewBitmap.ts). */
  const viewBitmapRef = useRef<ViewBitmap | null>(null);
  function setViewMoving(moving: boolean): void {
    const stage = stageRef.current;
    if (!stage || hitsHeld(stage) === moving) return;
    if (moving) holdHits(stage);
    else releaseHits(stage);
    if (moving) {
      viewBitmapRef.current?.freeze();
      // The canvas follows the view by CSS from here (followView), and the
      // map renders nothing until the move ends.
      holdStageView(true);
    } else {
      stopViewMoving(stage);
    }
  }
  /**
   * The view has stopped: the stage goes to it and the sheets are drawn
   * sharp on the next frame, and in that same frame the CSS that moved
   * the canvas comes off.
   */
  function stopViewMoving(stage: Konva.Stage): void {
    hitStaleRef.current = true;
    flushSync(() => holdStageView(false));
    // A catch-up during the move may have put the stage somewhere React
    // never rendered (followView); it goes back to the view React has.
    const { stageView } = useEditorStore.getState();
    stage.setAttrs({ x: stageView.panX, y: stageView.panY, scaleX: stageView.zoom, scaleY: stageView.zoom });
    const vb = viewBitmapRef.current;
    vb?.thaw();
    for (const layer of stage.getLayers()) layer.batchDraw();
    // Queued after the layers' draws, so it runs in the same frame, after them.
    Konva.Util.requestAnimFrame(() => {
      hitStaleRef.current = false;
      vb?.settled();
    });
  }
  /**
   * The view has stopped, and the hit canvas (what a click lands on) is
   * drawn with the sheets on the next frame. Until then it still has the
   * map where it was before the move: it isn't drawn while the view moves.
   * A press that comes first (a fast click right after a pan, a zoom or a
   * pinch; on a quick machine it lands in that same frame) would hit what
   * used to be there, or nothing, and start a box that picks every part
   * under the pointer.
   */
  const hitStaleRef = useRef(false);
  /** Draws the hit canvas now if it's behind the view, so a hit test sees the map where it is. */
  function freshHit(): void {
    const stage = stageRef.current;
    if (!stage || !hitStaleRef.current || hitsHeld(stage)) return;
    hitStaleRef.current = false;
    for (const layer of stage.getLayers()) if (layer.isListening()) layer.drawHit();
  }
  /** A catch-up of the stage to the view is waiting for its frame. */
  const catchUpRef = useRef(false);
  /**
   * While the view moves: the canvas, and the picture under it, are moved
   * and scaled to the view by CSS. When the picture doesn't cover the view
   * any more, the stage catches up (its sheets drawn from a new picture),
   * and the CSS goes on from there. The catch-up moves Konva's stage
   * itself, with no render: React's `stageView` stays put until the move
   * ends, so what depends on the zoom in React (how thick an outline is,
   * whether text is big enough to show) is brought up to date then.
   */
  function followView(): void {
    const vb = viewBitmapRef.current;
    if (catchUpRef.current) return;
    const view = useEditorStore.getState();
    if (vb?.follow(view)) return;
    catchUpRef.current = true;
    const stage = stageRef.current;
    if (stage) {
      stage.setAttrs({ x: view.panX, y: view.panY, scaleX: view.zoom, scaleY: view.zoom });
      for (const layer of stage.getLayers()) layer.batchDraw();
    }
    Konva.Util.requestAnimFrame(() => {
      catchUpRef.current = false;
      if (isStageViewHeld()) followView();
    });
  }
  useEffect(
    () =>
      useEditorStore.subscribe((s, prev) => {
        if (s.zoom === prev.zoom && s.panX === prev.panX && s.panY === prev.panY) return;
        if (isStageViewHeld()) followView();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- followView reads refs only
    [],
  );
  /** The wheel has no "let go": the view counts as still once it stops turning for a moment. */
  function viewMovingFor(ms: number): void {
    setViewMoving(true);
    if (viewStillTimer.current !== null) window.clearTimeout(viewStillTimer.current);
    viewStillTimer.current = window.setTimeout(() => {
      viewStillTimer.current = null;
      setViewMoving(false);
    }, ms);
  }

  // Wheel-zoom coalescer. Multiple wheel events landing inside the same
  // animation frame (common on high-res trackpads — they fire 60+ Hz)
  // get merged and applied once on the next rAF, so the Yjs+catalog
  // re-render runs at frame rate instead of per-event.
  const zoomAccumRef = useRef<{ deltaY: number; ptrX: number; ptrY: number; raf: number | null }>(
    { deltaY: 0, ptrX: 0, ptrY: 0, raf: null },
  );

  // HUD mouse-coord coalescer. `setHudMouse` only feeds the status bar's
  // "Mouse: x, y" readout, which doesn't need per-pixel precision — but
  // writing it on every raw mousemove (which also fires continuously
  // while dragging a brick) forced a StatusBar re-render at native mouse
  // frequency. Coalesce to one write per frame instead.
  const hudMouseRafRef = useRef<{ x: number; y: number } | null | undefined>(undefined);
  const hudMouseRafIdRef = useRef<number | null>(null);
  function scheduleHudMouse(studs: { x: number; y: number } | null) {
    hudMouseRafRef.current = studs;
    if (hudMouseRafIdRef.current !== null) return;
    hudMouseRafIdRef.current = requestAnimationFrame(() => {
      hudMouseRafIdRef.current = null;
      const pending = hudMouseRafRef.current;
      hudMouseRafRef.current = undefined;
      if (pending === undefined) return;
      useEditorStore.getState().setHudMouse(pending?.x ?? null, pending?.y ?? null);
    });
  }
  useEffect(() => {
    return () => {
      if (hudMouseRafIdRef.current !== null) cancelAnimationFrame(hudMouseRafIdRef.current);
    };
  }, []);

  // Paint/erase stroke tracker — set of `${cx},${cy}` cells already
  // touched in the current stroke so we don't re-emit the same Yjs
  // change for cells the cursor crosses multiple times. Mirrors
  // desktop's `strokeCellsTouched_` (MapView.cpp:493-523).
  const paintStrokeRef = useRef<Set<string> | null>(null);
  // Ctrl+drag with Paint / Erase moves the whole area sheet (BlueBrick
  // MoveArea): where it started, in cells, and the shift shown so far.
  const areaMoveRef = useRef<{ layerId: string; cellSize: number; start: { x: number; y: number } } | null>(null);
  const [areaShift, setAreaShift] = useState<{ layerId: string; dx: number; dy: number } | null>(null);

  // Shared cached projection (see useDocMap): same object until the doc
  // changes, and unchanged bricks keep their identity across edits so the
  // memoised brick glyphs skip re-rendering.
  const map = useDocMap(doc);
  const hasMap = !!map;
  // A press right after a turn of the wheel lands on what's under it: the
  // hit canvas is brought up to date first, before Konva looks at it.
  useEffect(() => {
    const el = stageRef.current?.container();
    if (!el) return;
    // So does a press right after a pan or a pinch, before the frame that
    // draws the hit canvas again (freshHit).
    const settle = () => {
      const stage = stageRef.current;
      if (!stage) return;
      if (viewStillTimer.current !== null) {
        window.clearTimeout(viewStillTimer.current);
        viewStillTimer.current = null;
        releaseHits(stage);
        if (isStageViewHeld() || viewBitmapRef.current?.isFrozen) stopViewMoving(stage);
        hitStaleRef.current = true;
      }
      freshHit();
    };
    el.addEventListener('pointerdown', settle, true);
    el.addEventListener('mousedown', settle, true);
    el.addEventListener('touchstart', settle, { capture: true, passive: true });
    return () => {
      el.removeEventListener('pointerdown', settle, true);
      el.removeEventListener('mousedown', settle, true);
      el.removeEventListener('touchstart', settle, true);
      if (viewStillTimer.current !== null) window.clearTimeout(viewStillTimer.current);
    };
  }, [hasMap]);
  // The moving picture: made with the stage, and told when the map's
  // drawing changes so a move shows someone else's edit as it lands.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const vb = new ViewBitmap(stage, () => stage.getLayers().filter((l) => VIEW_BITMAP_LAYERS.some((n) => l.hasName(n))));
    vb.watchLayers();
    viewBitmapRef.current = vb;
    const changed = () => vb.invalidate();
    doc.on('update', changed);
    const offSprites = subscribeSpriteProgress(changed);
    const offStore = useEditorStore.subscribe((s, prev) => {
      if (
        s.selection !== prev.selection ||
        s.annoSelection !== prev.annoSelection ||
        s.tool !== prev.tool ||
        s.editingModuleId !== prev.editingModuleId ||
        s.viewFilter !== prev.viewFilter
      ) changed();
    });
    return () => {
      doc.off('update', changed);
      offSprites();
      offStore();
      vb.dispose();
      if (viewBitmapRef.current === vb) viewBitmapRef.current = null;
    };
  }, [hasMap, doc]);
  const mapRef = useRef(map);
  mapRef.current = map;
  // A saved view being looked at shows only its sheets (savedViews.ts).
  const viewFilter = useEditorStore((s) => s.viewFilter);
  const shownMap = useMemo(() => (map && viewFilter ? applyViewSheets(map, viewFilter.sheets) : map), [map, viewFilter]);

  /** `p` on the nearest grid point, unless the grid is off or `free` (Alt held). */
  function gridPointStuds(p: { x: number; y: number }, free = false): { x: number; y: number } {
    return snapPoint(p, free ? 0 : useEditorStore.getState().snapStepStuds);
  }

  // Ruler- or label-led drag of a mixed selection: everything moves by the
  // same amount, one undo step (MapViewDrag.cpp commitDragIfMoved). With
  // parts in it, the first part lands by its snap corner (gridSnap.ts, as
  // when a part leads); without, the grabbed ruler's first end (or
  // centre) or the label's corner goes on the nearest grid point, Alt
  // freeing it (MapViewDrag.cpp applyAnnoGridSnap).
  const partsByKeyRef = useRef<Map<string, PartWire>>(new Map());
  const annoDragRef = useRef<{
    lead: Konva.Node;
    x0: number;
    y0: number;
    others: NodeSnap[];
    bricks: string[];
    anno: AnnoSelection;
    /** The first part's snap corner at the start (studs), when parts move too. */
    corner: { x: number; y: number } | null;
    /** The point that goes on the grid without parts (studs). */
    ref: { x: number; y: number } | null;
    /** The move so far, snapped (px). */
    d: { x: number; y: number };
  } | null>(null);
  const annoDrag = useMemo<AnnoDragHandlers>(() => {
    // The move from where the lead started, on the grid (px).
    const snapped = (d: NonNullable<typeof annoDragRef.current>, node: Konva.Node, free: boolean) => {
      const raw = { x: node.x() - d.x0, y: node.y() - d.y0 };
      const shift = annoDragShift({
        moved: { x: pxToStud(raw.x), y: pxToStud(raw.y) },
        mouse: pointerStuds(),
        corner: d.corner,
        ref: d.ref,
        step: useEditorStore.getState().snapStepStuds,
        free,
      });
      return { x: raw.x + studToPx(shift.x), y: raw.y + studToPx(shift.y) };
    };
    return {
      start(kind, id, node) {
        const st = useEditorStore.getState();
        let bricks = st.selection;
        let anno = st.annoSelection;
        if (!anno[kind].includes(id)) {
          bricks = [];
          anno = { rulers: [], labels: [], texts: [], [kind]: [id] };
          st.setMixedSelection(bricks, anno);
        }
        const names = [...bricks.map((b) => `brick-${b}`), ...annoNodeNames(anno)];
        const m = mapRef.current;
        let corner: { x: number; y: number } | null = null;
        let ref: { x: number; y: number } | null = null;
        if (m && bricks.length > 0) {
          for (const l of m.layers) {
            if (l.type !== 'brick' || corner) continue;
            const b = l.bricks.find((x) => bricks.includes(x.id));
            if (b) corner = grabSnapCorner(l, b, partsByKeyRef.current);
          }
        } else if (m && kind === 'rulers') {
          for (const l of m.layers) {
            if (l.type !== 'ruler') continue;
            const r = l.rulerItems.find((x) => x.id === id);
            if (r) ref = r.kind === 'linear' ? { ...r.point1 } : { ...r.center };
          }
        } else if (m && kind === 'texts') {
          // The text box's corner goes on the grid, like a part's.
          const at = id.lastIndexOf('#');
          const l = m.layers.find((x) => x.id === id.slice(0, at));
          const cell = l?.type === 'text' ? l.textCells[Number(id.slice(at + 1))] : undefined;
          if (cell) ref = { x: cell.displayArea.x, y: cell.displayArea.y };
        } else if (kind === 'labels') {
          // The label's text corner, where it is drawn.
          const text = (node as Konva.Group).getChildren?.()[0];
          if (text) ref = { x: pxToStud(node.x() + text.x()), y: pxToStud(node.y() + text.y()) };
        }
        annoDragRef.current = {
          lead: node,
          x0: node.x(),
          y0: node.y(),
          others: collectNodes(node.getStage(), names, node),
          bricks,
          anno,
          corner,
          ref,
          d: { x: 0, y: 0 },
        };
      },
      move(node, evt) {
        const d = annoDragRef.current;
        if (!d || d.lead !== node) return;
        d.d = snapped(d, node, snapBypassed(evt));
        node.position({ x: d.x0 + d.d.x, y: d.y0 + d.d.y });
        shiftNodes(d.others, d.d.x, d.d.y);
      },
      end(node) {
        const d = annoDragRef.current;
        annoDragRef.current = null;
        if (!d || d.lead !== node) return;
        // Where the last move put it (the lead stands snapped there).
        const dx = pxToStud(d.d.x);
        const dy = pxToStud(d.d.y);
        restoreNodes(d.others);
        node.position({ x: d.x0, y: d.y0 });
        const m = mapRef.current;
        if (!m || (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6)) return;
        // A pinned module in the selection doesn't move as a whole.
        if (d.bricks.length > 0 && !selectionMayMove(doc, d.bricks)) return;
        const sc = readSidecarFromDoc(doc);
        translateMixedSelection(doc, m, sc?.anchoredLabels ?? [], sc?.modules ?? [], {
          bricks: d.bricks,
          anno: d.anno,
          dx,
          dy,
        });
      },
    };
  }, [doc]);

  /**
   * Resolve the layer that new parts should be placed into. `activeLayerId`
   * is the Layers-panel selection and can legitimately point at ANY layer
   * kind (area, text, ruler — the user may have clicked one on purpose).
   * Placing tools need a brick layer specifically: use the active layer
   * only when it IS a brick layer, otherwise fall back to the first brick
   * layer in the doc, creating one if none exists.
   */
  function resolveBrickLayerForPlacement(): string {
    if (activeLayerId && map?.layers.some((l) => l.id === activeLayerId && l.type === 'brick')) {
      return activeLayerId;
    }
    const firstBrick = map?.layers.find((l) => l.type === 'brick');
    return firstBrick?.id ?? ensureBrickLayer(doc);
  }

  /**
   * Say where new parts went when it isn't plain from the "Adding to"
   * control: onto a hidden sheet (with a button to show it), or onto a
   * parts sheet other than the picked one because that one can't hold
   * parts. The sheet that got them lights up in the Sheets panel.
   * `pickedId` is the sheet that was active before placing.
   */
  function announcePlacement(layerIds: readonly string[], pickedId: string | null, what: string, one = true) {
    const layers = projectDoc(doc)?.layers ?? [];
    const { showNotice, flashSheet } = useEditorStore.getState();
    const went = layerIds.map((id) => layers.find((l) => l.id === id)).filter((l) => l !== undefined);
    if (went.length === 0) return;
    const names = went.map((l) => `“${sheetName(l)}”`).join(', ');
    const hidden = went.filter((l) => !l.visible);
    if (hidden.length > 0) {
      for (const l of hidden) flashSheet(l.id);
      const hiddenNames = hidden.map((l) => `“${sheetName(l)}”`).join(', ');
      showNotice(
        went.length === 1
          ? `${what} went on ${names}, which is hidden, so you can’t see ${one ? 'it' : 'them'}.`
          : `${what} went on ${names}. ${hiddenNames} ${hidden.length === 1 ? 'is' : 'are'} hidden, so you can’t see all of them.`,
        'error',
        12000,
        {
          label: hidden.length === 1 ? 'Show sheet' : 'Show sheets',
          run: () => {
            for (const l of hidden) setLayerVisible(doc, l.id, true);
          },
        },
      );
      return;
    }
    const picked = pickedId ? layers.find((l) => l.id === pickedId) : undefined;
    if (picked && !layerIds.includes(picked.id)) {
      for (const l of went) flashSheet(l.id);
      const pickedKind = picked.type === 'brick' ? '' : `, a ${SHEET_KIND[picked.type]} sheet, which can’t hold parts`;
      showNotice(
        `${what} went on ${names}, not “${sheetName(picked)}”${pickedKind}.${
          useEditorStore.getState().activeLayerId === went[0]!.id ? ` ${names} is the active sheet now.` : ''
        }`,
        'done',
        8000,
      );
    }
  }

  // Push map bounding-box into the store so the StatusBar can show it
  // without prop-drilling. Runs whenever the map changes.
  const setHudMapBounds = useEditorStore((s) => s.setHudMapBounds);
  useEffect(() => {
    if (!map) { setHudMapBounds(null, null); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const layer of map.layers) {
      if (layer.type !== 'brick') continue;
      for (const b of layer.bricks) {
        minX = Math.min(minX, b.displayArea.x);
        minY = Math.min(minY, b.displayArea.y);
        maxX = Math.max(maxX, b.displayArea.x + b.displayArea.width);
        maxY = Math.max(maxY, b.displayArea.y + b.displayArea.height);
      }
    }
    if (!Number.isFinite(minX)) { setHudMapBounds(null, null); return; }
    setHudMapBounds(maxX - minX, maxY - minY);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  // Index parts by key for fast place-tool lookup.
  const catalog = useQuery({
    queryKey: ['parts-catalog'],
    queryFn: api.parts.catalog,
    staleTime: 5 * 60 * 1000,
  });
  const partsByKey = useMemo(() => {
    // Bricks reference the catalog KEY (`<partNumber>.<colorCode>`
    // lowercased) in their `partNumber` field — index by that, then
    // also stash the bare `partNumber` as a fallback for entries
    // arriving without a color code (group parts / some custom uploads).
    // Inconsistent indexing was breaking the snap helpers — see
    // editor/snap.ts `lookupPart`.
    return indexParts(catalog.data?.parts);
  }, [catalog.data]);
  partsByKeyRef.current = partsByKey;
  // A picked part deleted by someone else (live) or by an undo leaves the
  // selection. Checked against the doc itself, which is never behind a pick.
  useEffect(() => {
    if (!map) return;
    const kept = stillPicked(brickIdsInDoc(doc), useEditorStore.getState().selection);
    if (kept) useEditorStore.setState({ selection: kept });
  }, [map, doc]);
  // Older versions kept a placed set (flex track, a train set...) as a
  // module. Once the layout and the parts are in, a module that is still
  // exactly that set becomes a set again, one undo step, with a notice.
  const setsCheckedRef = useRef<Y.Doc | null>(null);
  useEffect(() => {
    if (isViewer || !map || partsByKey.size === 0 || setsCheckedRef.current === doc) return;
    if (!map.layers.some((l) => l.type === 'brick' && l.bricks.length > 0)) return;
    setsCheckedRef.current = doc;
    const fromModules = findSetModules(map, readSidecarFromDoc(doc)?.modules ?? NO_MODULES, partsByKey, makeId);
    const taken = new Set(fromModules.flatMap((s) => [...s.parentOf.keys()]));
    const loose = findLooseSets(map, partsByKey, makeId, taken);
    if (fromModules.length + loose.length === 0) return;
    makeSetsOfModules(doc, [...fromModules, ...loose]);
    useEditorStore.getState().showNotice(setsAgainNotice(fromModules.length, loose.length), 'done', 12000);
  }, [doc, map, partsByKey, isViewer]);
  const partOf = (partNumber: string) => partsByKey.get(partNumber.toLowerCase());
  // Ask for every picture the shown layout needs at once, so the loading
  // card counts against the real total ("132 of 480") from the start.
  useEffect(() => {
    const m = shownMap ?? map;
    if (!m || !catalog.data) return;
    wantSprites(layoutSpriteUrls(m, partsByKey));
  }, [shownMap, map, partsByKey, catalog.data]);
  const linkCatalog = useMemo(() => catalogFromParts(catalog.data?.parts), [catalog.data]);
  // Placed custom sets whose set changed since (sidecar `sets`, editor/setUpdates.ts).
  const setUpdates = useMemo(
    () => (isViewer ? [] : findSetUpdates(map, readSidecarFromDoc(doc) as Record<string, unknown> | null, partsByKey)),
    [map, partsByKey, doc, isViewer],
  );

  /** Unrotated sprite size of a brick in studs, once its sprite is loaded (marquee shape near 45°). */
  function brickSpriteStuds(b: { partNumber: string }): { w: number; h: number } | null {
    const meta = partsByKey.get(b.partNumber.toLowerCase());
    if (!meta) return null;
    const pxPerStud = meta.pxPerStud && meta.pxPerStud > 0 ? meta.pxPerStud : 8;
    const px = meta.spriteSize ?? (() => {
      const sprite = getSpriteSync(spriteUrlFor(meta));
      return sprite ? { w: sprite.naturalWidth, h: sprite.naturalHeight } : null;
    })();
    return px ? { w: px.w / pxPerStud, h: px.h / pxPerStud } : null;
  }

  // Drag-from-Parts-panel → drop on canvas. The Stage's container <div>
  // receives native HTML5 drag events. We accept the custom MIME type
  // emitted by PartsPanel, render a live ghost via `dropPart` while
  // dragover, and commit a `placePartAt` on drop. Direct port of
  // MapView::dragEnterEvent / dragMoveEvent / dropEvent (lines 1659-2042).
  // Latest drag-hover part, readable synchronously from the drop handler
  // (the Firefox fallback used to read a stale `dropPart` closure).
  const dropPartRef = useRef<{ key: string; studX: number; studY: number } | null>(null);
  const dropHandlersRef = useRef<{
    onDragOver: (e: DragEvent) => void;
    onDragLeave: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
  } | null>(null);
  {
    const PART_MIME = 'application/x-cld-part';

    function clientToStuds(clientX: number, clientY: number): { x: number; y: number } | null {
      const container = stageRef.current?.container();
      if (!container) return null;
      const rect = container.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      // Apply inverse of stage transform (live values, not the render's).
      const { panX: livePanX, panY: livePanY, zoom: liveZoom } = useEditorStore.getState();
      return {
        x: pxToStud((px - livePanX) / liveZoom),
        y: pxToStud((py - livePanY) / liveZoom),
      };
    }

    function updateDropPart(next: DropPart | null) {
      dropPartRef.current = next;
      setDropPart(next);
    }

    /** Show (or clear) the snap ring and the joining connection while dragging in. */
    function showDropSnap(ring: { x: number; y: number } | null) {
      const st = useEditorStore.getState();
      st.setLiveSnap(ring ? { studX: ring.x, studY: ring.y } : null);
      st.setSnapMoving(ring ? { studX: ring.x, studY: ring.y } : null);
    }

    /** Where the part being dragged in would land, snapped (the ghost). */
    function ghostSnap(key: string, studX: number, studY: number, bypass: boolean): SnapResult | undefined {
      const part = key ? partsByKey.get(key.toLowerCase()) : undefined;
      if (!part || !map) return undefined;
      const ghostUrl = spriteUrlFor(part);
      const cached = ghostUrl ? getSpriteSync(ghostUrl) : null;
      const widthStuds = cached ? cached.naturalWidth / part.pxPerStud : 16;
      const heightStuds = cached ? cached.naturalHeight / part.pxPerStud : 16;
      return snapPlacement(
        {
          part,
          centreX: studX,
          centreY: studY,
          orientation: 0,
          width: widthStuds,
          height: heightStuds,
          snapStepStuds,
          reach: liveSnapReach(),
          session: placeSnapRef.current,
          ...(bypass ? { bypass: true } : {}),
        },
        map,
        partsByKey,
      );
    }

    function readPartKey(dt: DataTransfer | null): string | null {
      if (!dt) return null;
      // dataTransfer.getData on dragover is reliably empty in some
      // browsers (Firefox); we accept either MIME but only test
      // presence in `types` so dragover updates fire even before
      // dragstart populated the buffer.
      if (!dt.types || dt.types.length === 0) return null;
      const has =
        Array.from(dt.types).some(
          (t) => t === PART_MIME || t === 'text/plain',
        );
      if (!has) return null;
      try {
        return dt.getData(PART_MIME) || dt.getData('text/plain') || '';
      } catch {
        return '';
      }
    }

    /** The module snapshot for this drag — fetched once, shared by ghost and drop. */
    function moduleDragBatches(id: string) {
      const key = `${activeModuleDrag.session}:${id}`;
      let entry = moduleDragRef.current;
      if (!entry || entry.key !== key) {
        const batches = fetchModuleBatches(id);
        const next = { key, batches, ready: null as ModuleBatch[] | null };
        batches
          .then((b) => {
            next.ready = b;
            setModuleDragReady((n) => n + 1);
          })
          .catch(() => undefined);
        moduleDragRef.current = entry = next;
      }
      return entry;
    }

    function onDragOver(e: DragEvent) {
      const dt = e.dataTransfer;
      if (!dt) return;
      // Quick MIME sniff — avoid hijacking unrelated drags.
      const types = Array.from(dt.types ?? []);
      const isModule = types.includes(MODULE_MIME);
      if (!isModule && !types.includes(PART_MIME) && !types.includes('text/plain')) return;
      e.preventDefault();
      dt.dropEffect = 'copy';
      useEditorStore.getState().setDropTargetHint(dropTargetHint(map?.layers ?? [], activeLayerId));
      const studs = clientToStuds(e.clientX, e.clientY);
      if (!studs) return;
      const now = performance.now();
      if (isModule) {
        // Ghost of the whole module where the drop will put it.
        const id = activeModuleDrag.id;
        if (!id) return;
        const entry = moduleDragBatches(id);
        moduleSnapRef.current.sample(e.clientX, e.clientY, now);
        const offset = entry.ready
          ? moduleDropTranslation(entry.ready, studs, snapStepStuds, map, partsByKey, {
              reach: liveSnapReach(),
              session: moduleSnapRef.current,
              bypass: e.altKey,
            })
          : undefined;
        showDropSnap(offset && offset.ringStudX !== undefined ? { x: offset.ringStudX, y: offset.ringStudY! } : null);
        setDropModule({
          studX: studs.x,
          studY: studs.y,
          ...(offset ? { offset: { dx: offset.dx, dy: offset.dy, ...(offset.turn ? { turn: offset.turn } : {}) } } : {}),
        });
        return;
      }
      // The "→ <sheet>" tag that rides with the part.
      const { target: dropSheet } = placementTarget(map?.layers ?? [], activeLayerId);
      useEditorStore.getState().setDropTag({
        sheet: dropSheet ? sheetName(dropSheet) : 'a new parts sheet',
        hidden: dropSheet ? !dropSheet.visible : false,
        x: e.clientX,
        y: e.clientY,
      });
      const key = readPartKey(dt);
      // dragover on Firefox doesn't expose getData payloads — fall back
      // to the most-recently-stored key from a previous dragover.
      const partKey = key || dropPartRef.current?.key || '';
      placeSnapRef.current.sample(e.clientX, e.clientY, now);
      const dragged = partKey ? partsByKey.get(partKey.toLowerCase()) : undefined;
      if (dragged?.kind === 'group' && dragged.subparts.length > 0) {
        // A set: all its parts as one ghost, snapped as the drop will.
        const layout = map ? setDropLayout(dragged, studs.x, studs.y, { session: placeSnapRef.current, bypass: e.altKey }) : null;
        const ring = layout?.drop.ringStudX !== undefined ? { x: layout.drop.ringStudX, y: layout.drop.ringStudY! } : null;
        showDropSnap(ring);
        updateDropPart({ key: partKey, studX: studs.x, studY: studs.y, ...(layout ? { setBricks: layout.placed } : {}) });
        return;
      }
      const snapped = ghostSnap(partKey, studs.x, studs.y, e.altKey);
      showDropSnap(snapped?.ringStudX !== undefined ? { x: snapped.ringStudX, y: snapped.ringStudY! } : null);
      updateDropPart({
        key: partKey,
        studX: studs.x,
        studY: studs.y,
        ...(snapped ? { snapped } : {}),
      });
    }

    function onDragLeave(_e: DragEvent) {
      updateDropPart(null);
      setDropModule(null);
      showDropSnap(null);
      placeSnapRef.current = new SnapSession();
      moduleSnapRef.current = new SnapSession();
      useEditorStore.getState().setDropTargetHint(null);
      useEditorStore.getState().setDropTag(null);
    }

    function onDrop(e: DragEvent) {
      e.preventDefault();
      const dt = e.dataTransfer;
      const lastDropPart = dropPartRef.current;
      updateDropPart(null);
      setDropModule(null);
      showDropSnap(null);
      // The drop's final snap keeps the join the drag was holding.
      const placeSnap = placeSnapRef.current;
      const moduleSnap = moduleSnapRef.current;
      placeSnapRef.current = new SnapSession();
      moduleSnapRef.current = new SnapSession();
      const bypass = e.altKey;
      useEditorStore.getState().setDropTargetHint(null);
      useEditorStore.getState().setDropTag(null);
      const dragged = moduleDragRef.current;
      moduleDragRef.current = null;

      // Module drop — fetch snapshot and insert bricks.
      const moduleIdRaw = dt?.getData(MODULE_MIME);
      const moduleId = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(moduleIdRaw ?? '')?.[1];
      if (moduleId) {
        const moduleName = dt?.getData(MODULE_NAME_MIME) || 'Module';
        const dropStuds = clientToStuds(e.clientX, e.clientY);
        const hostMap = map;
        const catalog = partsByKey;
        void (async () => {
          try {
            // Reuse the snapshot the ghost was drawn from, so the drop
            // lands exactly on the ghost.
            const version = libraryVersionOf(moduleId);
            const batches = await (dragged && dragged.key === `${activeModuleDrag.session}:${moduleId}`
              ? dragged.batches
              : fetchModuleBatches(moduleId));
            // Desktop drop (MapView.cpp:1900-2060): centroid under the
            // cursor, bbox top-left on the grid, then a connection snap
            // onto the host's free ends (turning the module to face one).
            const offset = dropStuds
              ? moduleDropTranslation(
                  batches,
                  dropStuds,
                  useEditorStore.getState().snapStepStuds,
                  hostMap,
                  catalog,
                  { reach: liveSnapReach(), session: moduleSnap, bypass, final: true },
                )
              : { dx: 0, dy: 0 };
            // Bricks go to host layers named like the module's layers and
            // are registered as a sidecar module in the same undo step.
            const v = await version;
            const res = await placeModuleAsking(doc, placedModuleBatches(batches, offset, catalog), {
              name: moduleName,
              library: { id: moduleId, ...(v ? { version: v } : {}) },
            });
            if (res) {
              absorbIntoEditedModule(doc, res.ids);
              setSelection(res.ids);
              useEditorStore
                .getState()
                .showStatusMessage(`Imported ${res.ids.length} bricks from module '${moduleName}'`, 4000);
            }
          } catch { /* silent */ }
        })();
        return;
      }

      const key = readPartKey(dt) || lastDropPart?.key || '';
      const studs = clientToStuds(e.clientX, e.clientY);
      if (!key || !studs) return;
      const meta = partsByKey.get(key.toLowerCase());
      if (!meta) return;
      void placePartAt(meta, studs.x, studs.y, { session: placeSnap, bypass, final: true });
    }

    // Refreshed every render so the listeners below (attached once per
    // stage) always run against the latest state / closures.
    dropHandlersRef.current = { onDragOver, onDragLeave, onDrop };
  }
  const hasStage = map !== null;
  useEffect(() => {
    const container = stageRef.current?.container();
    if (!container) return;
    const onDragOver = (e: DragEvent) => dropHandlersRef.current?.onDragOver(e);
    const onDragLeave = (e: DragEvent) => dropHandlersRef.current?.onDragLeave(e);
    const onDrop = (e: DragEvent) => dropHandlersRef.current?.onDrop(e);
    container.addEventListener('dragover', onDragOver);
    container.addEventListener('dragleave', onDragLeave);
    container.addEventListener('drop', onDrop);
    return () => {
      container.removeEventListener('dragover', onDragOver);
      container.removeEventListener('dragleave', onDragLeave);
      container.removeEventListener('drop', onDrop);
    };
  }, [hasStage]);

  /**
   * Fit the canvas to the brick AABB and centre on it. Shared between
   * the `F` shortcut, the `View → Fit to View` action, and the
   * auto-fit-on-open effect below. Mirrors desktop's `onFitToView`
   * (MainWindow.cpp:1348-1352) and the `setMap` initial fit
   * (MapView.cpp:300-308).
   *
   * Returns `true` when a fit was applied, `false` when the map has
   * no bricks (so the auto-fit effect can keep waiting for content
   * to land — important for fresh blank-create layouts where the doc
   * arrives empty and bricks come in via `.bbm` import a few ms later).
   */
  // Fit to View: every item (bricks, text, rulers, areas, labels, venue)
  // plus 50 scene px, like desktop's onFitToView (MainWindow.cpp:1372-1376).
  // The last automatic fit; while the view still equals it the user
  // hasn't panned or zoomed, so a new canvas size (phone rotated, browser
  // bars shown or hidden) fits again.
  const lastAutoFitRef = useRef<{ zoom: number; panX: number; panY: number } | null>(null);
  // Whether the grid draws its 1, 2, 3… row numbers (the scale card keeps clear of them on a phone).
  const showGridHud = useEditorStore((s) => s.showGrid);
  const hudGrid = showGridHud && map ? (drawnGridLayer(map.layers) as import('@cld/model').LayerGrid | undefined) : undefined;
  const rowNumbersShown = !!(hudGrid && hudGrid.visible && hudGrid.displayCellIndex);
  function fitToContent(): boolean {
    if (!map) return false;
    // The fit takes in the grid's A, B, C… / 1, 2, 3… labels too, so
    // column A and row 1 are never cut off at the top or left.
    const showGrid = useEditorStore.getState().showGrid;
    const grid = showGrid ? (drawnGridLayer(map.layers) as import('@cld/model').LayerGrid | undefined) : undefined;
    const sidecar = readSidecarFromDoc(doc);
    // Module names sit outside their frames; keep them on screen too.
    const bounds = withGridLabels(unionStudRects(contentBoundsStuds(map, sidecar), moduleNameBoxes(map, sidecar)) ?? null, grid);
    const fit = fitView(bounds, width, height, { min: MIN_ZOOM, max: MAX_ZOOM }, phone ? (width > height ? PHONE_LANDSCAPE_FIT_INSETS : PHONE_FIT_INSETS) : undefined, phone ? 0 : undefined);
    if (!fit) return false;
    useEditorStore.setState(fit);
    lastAutoFitRef.current = fit;
    return true;
  }


  // Auto-fit on first open. Mirrors desktop's `MapView::setMap` final
  // call to `fitInView` (MapView.cpp:300-308): as soon as the map has
  // content AND the canvas has its real size, centre + zoom to fit.
  // After that, fit again only when the canvas changes size and the user
  // hasn't moved the view since, so Yjs updates and the user's own pan /
  // zoom are never clobbered.
  const autoFittedRef = useRef(false);
  useEffect(() => {
    if (!hasMap || width <= 0 || height <= 0) return;
    if (autoFittedRef.current) {
      const st = useEditorStore.getState();
      if (!isUntouchedFit({ zoom: st.zoom, panX: st.panX, panY: st.panY }, lastAutoFitRef.current)) return;
    }
    if (fitToContent()) autoFittedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMap, width, height, phone]);

  // Finish the venue outline / obstacle being drawn and return to the
  // select tool. Enter or right-click, like desktop
  // MapView::finishVenueDraw (MapView.cpp:891-925): fewer than 3 points
  // drops them, says so and stays in the tool; drawing enables the venue.
  // Entering a venue drawing tool: an obstacle needs a venue outline
  // first, and the status bar says how to draw (MainWindowMapMenu.cpp:160-212).
  useEffect(() => {
    if (tool !== 'venueOutline' && tool !== 'venueObstacle') return;
    const st = useEditorStore.getState();
    if (tool === 'venueObstacle' && !readSidecarFromDoc(doc)?.venue) {
      st.setTool('select');
      st.showNotice('Draw the venue’s outline first, then add obstacles inside it.', 'error');
      return;
    }
    st.showStatusMessage(
      tool === 'venueOutline'
        ? 'Click points to outline the venue. Right-click / Enter to finish, Escape to cancel.'
        : 'Click points to outline an obstacle. Right-click / Enter to finish, Escape to cancel.',
      8000,
    );
  }, [tool, doc]);

  function finishVenueDraft() {
    if (isViewer) return;
    const kind = venueDraft?.kind ?? (tool === 'venueObstacle' ? 'obstacle' : 'outline');
    const next = venueAfterDraw(readSidecarFromDoc(doc)?.venue, kind, venueDraft?.pts ?? []);
    setVenueDraft(null);
    if (!next) {
      useEditorStore.getState().showStatusMessage(VENUE_MIN_POINTS_MESSAGE, 2500);
      return;
    }
    setVenue(doc, next);
    useEditorStore.getState().setTool('select');
  }

  // Canvas keyboard shortcuts — port of desktop MapView::keyPressEvent
  // (MapView.cpp:942-983) and MainWindowMenus.cpp shortcut bindings:
  //
  //   Escape                — cancel place / deselect
  //   Delete / Backspace    — delete selection                  (MapView.cpp:959)
  //   R                     — rotate CCW 90°                    (MapView.cpp:964, MainWindowMenus.cpp:423)
  //   Shift+R               — rotate CW 90°                     (MapView.cpp:964, MainWindowMenus.cpp:418)
  //   Arrow keys            — nudge selection by 1 stud         (MapView.cpp:970-980)
  //   Ctrl+A                — select all visible bricks          (MapView.cpp:1417)
  //   Ctrl+Shift+A          — select none                       (MainWindowMenus.cpp:362)
  // The handler is rebuilt every render (so it always sees the current
  // venueDraft / selection / map / status ...) and a single window
  // listener dispatches to the latest one. The previous effect listed its
  // deps by hand and missed several (venueDraft, pan/zoom, status), so
  // Enter/Escape for venue drawing never fired and Ctrl+V pasted at a
  // stale pointer position.
  const keyHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  {
    function onKey(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return;

      // Escape — works regardless of viewer state.
      if (e.key === 'Escape') {
        e.preventDefault();
        if (venueDraft) { setVenueDraft(null); return; }
        // Edit module: Esc goes back to the whole layout.
        if (useEditorStore.getState().editingModuleId) { leaveModuleEdit(); return; }
        setSelection([]);
        setRulerDraft(null);
        return;
      }

      // Enter — commit venue-draw polygon (≥3 pts) or obstacle.
      if (e.key === 'Enter' && (venueDraft || tool === 'venueOutline' || tool === 'venueObstacle') && !isViewer) {
        e.preventDefault();
        finishVenueDraft();
        return;
      }

      // Ctrl/Cmd + A / Shift+A — select-all / select-none.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        if (e.shiftKey) {
          setSelection([]);
        } else if (map) {
          // Every brick on every visible brick layer, like desktop
          // MapView::selectAll (MapView.cpp:1417).
          setSelection(allVisibleBrickIds(map));
        }
        return;
      }

      // Ctrl/Cmd + S — explicit save. Desktop MainWindowMenus.cpp:89
      // (QKeySequence::Save). Yjs already auto-saves; this just nudges
      // an explicit flush.
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (!isViewer) void saveNow();
        return;
      }

      // Ctrl/Cmd + C — copy selection to clipboard.
      // Ctrl/Cmd + X — cut. Ctrl/Cmd + V — paste at the current cursor.
      // Ctrl/Cmd + D — duplicate (= copy + paste at the cursor).
      // All ports of MapViewClipboard.cpp.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        void copySelection();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'x' || e.key === 'X')) {
        e.preventDefault();
        if (isViewer) return;
        void cutSelection();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        if (isViewer) return;
        void pasteAtCursor();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        if (isViewer || selection.length === 0) return;
        void duplicateSelection();
        return;
      }

      // Ctrl/Cmd + Shift + ] — bring to front. Ctrl/Cmd + Shift + [ — send to back.
      // Desktop MainWindowMenus.cpp:391-396.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === ']' || e.key === '}')) {
        e.preventDefault();
        reorderPicked('front');
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === '[' || e.key === '{')) {
        e.preventDefault();
        reorderPicked('back');
        return;
      }

      // Ctrl/Cmd + F — Find. Desktop MainWindowMenus.cpp:350.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        // Routed via the Editor parent's setShowFind via window event;
        // Canvas doesn't own that state. We dispatch a custom event the
        // Editor listens for at mount time.
        window.dispatchEvent(new CustomEvent('cld:open-find'));
        return;
      }

      // Ctrl/Cmd + , — Preferences dialog.
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('cld:open-preferences'));
        return;
      }

      // T — Insert ▸ Text (desktop's Ctrl+T, MainWindowMenus.cpp:431: the
      // browser keeps Ctrl+T for a new tab).
      // Ctrl+T still works where the browser lets it through (the installed app).
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
      if ((plain || ((e.metaKey || e.ctrlKey) && !e.altKey)) && (e.key === 't' || e.key === 'T')) {
        e.preventDefault();
        if (isViewer) return;
        setShowAddText(true);
        return;
      }

      // Ctrl/Cmd + L — Insert ▸ Anchored Label. Desktop MainWindowMenus.cpp:440-472.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        if (isViewer) return;
        window.dispatchEvent(new CustomEvent('cld:open-label'));
        return;
      }

      // Ctrl/Cmd + G — group; Ctrl/Cmd + Shift + G — ungroup.
      // Desktop MainWindowMenus.cpp:371-374.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        if (isViewer) return;
        if (e.shiftKey) ungroupSelection();
        else groupBricksAcrossLayers(doc, selectionByLayer());
        return;
      }

      // Ctrl/Cmd + P — Select Path: BFS walk over connexion links from
      // the current selection, across all brick layers. Port of
      // MapView.cpp:1481-1543.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        if (!map) return;
        const adj = buildConnectedAdj(map);
        const visited = new Set<string>(selection);
        const queue = [...selection];
        while (queue.length > 0) {
          const id = queue.shift()!;
          for (const nb of adj.get(id) ?? []) {
            if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
          }
        }
        setSelection([...visited]);
        return;
      }

      // Alt+N — New layout (desktop's Ctrl+N, MainWindowMenus.cpp:76-78: the
      // browser keeps Ctrl+N for a new window). Ctrl/Cmd+O — Open: the list
      // on Home (MainWindowMenus.cpp:80-82). Both ask first while changes
      // haven't reached the server.
      const newLayout = (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyN') || ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'n' || e.key === 'N'));
      const openOther = (e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'o' || e.key === 'O');
      if (newLayout || openOther) {
        e.preventDefault();
        // The editor asks first when changes haven't reached the server (leaveLayout).
        window.dispatchEvent(new CustomEvent('cld:leave-editor', { detail: newLayout ? '/?new=1' : '/?open=1' }));
        return;
      }

      // Ctrl/Cmd + = / - — zoom in/out by a fixed factor (matches
      // desktop MainWindowMenus.cpp:493-498). Re-uses zoomAround so the
      // anchor stays under the canvas centre.
      if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+' || e.key === '-')) {
        e.preventDefault();
        const factor = e.key === '-' ? 1 / ZOOM_STEP : ZOOM_STEP;
        const live = useEditorStore.getState().zoom;
        useEditorStore.getState().zoomAround(live * factor, width / 2, height / 2);
        return;
      }

      // F — fit canvas to map extent. Desktop MainWindowMenus.cpp:501.
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        fitToContent();
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isViewer) return; // viewers can't mutate

      // Delete / arrow nudge act on the whole mixed selection: bricks on
      // any layer plus rulers, labels and text cells (delete) / rulers and
      // labels (nudge — desktop text cells don't move). MapView.cpp:959-1041.
      if (selection.length + annoCount(annoSelection) > 0 && map) {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          deleteSelection();
          return;
        }
        const NUDGE = snapStepStuds > 0 ? snapStepStuds : 1;
        let dx = 0;
        let dy = 0;
        if (e.key === 'ArrowLeft') dx = -NUDGE;
        else if (e.key === 'ArrowRight') dx = NUDGE;
        else if (e.key === 'ArrowUp') dy = -NUDGE;
        else if (e.key === 'ArrowDown') dy = NUDGE;
        if (dx !== 0 || dy !== 0) {
          e.preventDefault();
          if (!selectionMayMove(doc, selection)) return;
          const sc = readSidecarFromDoc(doc);
          translateMixedSelection(doc, map, sc?.anchoredLabels ?? [], sc?.modules ?? [], {
            bricks: selection,
            anno: annoSelection,
            dx,
            dy,
          });
          return;
        }
      }

      if (selection.length + annoCount(annoSelection) === 0) return;

      if (e.key === 'r' || e.key === 'R') {
        // Shift+R = CW (+step), R = CCW (-step). Matches desktop's MainWindow
        // keys (MainWindowMenus.cpp:418,423) where Shift+R is CW and
        // bare R is CCW; step is the configured rotation step. The whole
        // selection (any layer) turns about its centroid.
        e.preventDefault();
        rotatePicked(e.shiftKey ? rotationStepDegrees : -rotationStepDegrees);
        return;
      }
    }
    keyHandlerRef.current = onKey;
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandlerRef.current?.(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Read the pointer's stud-space coordinates (live pan/zoom). */
  function pointerStuds(): { x: number; y: number } | null {
    const stage = stageRef.current;
    if (!stage) return null;
    const ptr = stage.getPointerPosition();
    if (!ptr) return null;
    const { panX: livePanX, panY: livePanY, zoom: liveZoom } = useEditorStore.getState();
    return {
      x: pxToStud((ptr.x - livePanX) / liveZoom),
      y: pxToStud((ptr.y - livePanY) / liveZoom),
    };
  }

  // Per-frame coalescing for mousemove-driven React state (middle-button
  // pan, marquee, ruler / venue drafts). Raw mousemove fires at 60-240 Hz;
  // each state write re-rendered the canvas, so apply at most once per
  // animation frame using the latest pointer position.
  const moveRafRef = useRef<{
    raf: number | null;
    panDx: number;
    panDy: number;
    studs: { x: number; y: number } | null;
    /** Alt held on the latest move: ruler and venue points go where the pointer is. */
    free: boolean;
  }>({ raf: null, panDx: 0, panDy: 0, studs: null, free: false });
  function flushPointerMove() {
    const m = moveRafRef.current;
    if (m.raf !== null) {
      cancelAnimationFrame(m.raf);
      m.raf = null;
    }
    if (m.panDx !== 0 || m.panDy !== 0) {
      const st = useEditorStore.getState();
      st.setPan(st.panX + m.panDx, st.panY + m.panDy);
      m.panDx = 0;
      m.panDy = 0;
    }
    const studs = m.studs;
    m.studs = null;
    if (!studs) return;
    setMarquee((prev) => (prev ? { ...prev, x1: studs.x, y1: studs.y } : prev));
    // Ruler ends and venue corners go on the grid, as they will land.
    const at = gridPointStuds(studs, m.free);
    setRulerDraft((prev) => (prev ? { ...prev, curX: at.x, curY: at.y } : prev));
    setVenueDraft((prev) => (prev ? { ...prev, curX: at.x, curY: at.y } : prev));
  }
  function schedulePointerMove() {
    const m = moveRafRef.current;
    if (m.raf === null) m.raf = requestAnimationFrame(flushPointerMove);
  }
  useEffect(() => {
    const m = moveRafRef.current;
    return () => {
      if (m.raf !== null) cancelAnimationFrame(m.raf);
    };
  }, []);

  // Grid origin drag (MapView.cpp:415-438, 590-600, 737-746): with the
  // active layer a visible grid showing cell indices, dragging empty space
  // moves the index origin by whole cells; right-click cancels.
  const gridDragRef = useRef<{ layerId: string; cellSize: number; before: { x: number; y: number }; start: { x: number; y: number }; last: { x: number; y: number } } | null>(null);
  const skipContextMenuRef = useRef(false);
  const [gridPreview, setGridPreview] = useState<{ layerId: string; corner: { x: number; y: number } } | null>(null);
  function endGridDrag(commit: boolean) {
    const g = gridDragRef.current;
    gridDragRef.current = null;
    setGridPreview(null);
    const stage = stageRef.current;
    if (stage) stage.container().style.cursor = '';
    if (g && commit) moveGridOrigin(doc, g.layerId, g.last.x - g.start.x, g.last.y - g.start.y);
  }

  function handleStageMouseDown(e: KonvaEventObject<MouseEvent>) {
    const evt = e.evt as MouseEvent;

    if (gridDragRef.current && evt.button === 2) {
      endGridDrag(false);
      skipContextMenuRef.current = true; // the right-click only cancels
      return;
    }

    // Middle-button pan — port of MapView.cpp:446-451 (desktop). Works on
    // any tool, on any target (brick or empty stage), so the user can
    // always reframe the canvas without changing tool.
    if (evt.button === 1) {
      evt.preventDefault();
      middlePanRef.current = { lastX: evt.clientX, lastY: evt.clientY };
      setViewMoving(true);
      return;
    }

    // Right-click opens the context menu — don't clear selection or start marquee.
    if (evt.button === 2) return;

    // Only the select tool defers to whatever was clicked; ruler, venue and
    // paint tools act anywhere, over bricks too (desktop handles them before
    // item hit-testing, MapView.cpp:456-535).
    if (tool === 'select' && editingModuleId && map && evt.button === 0) {
      // Edit module: a click outside the module (on empty map, the room or
      // a sheet's paint; parts handle their own) goes back to the whole layout.
      const onPart = !!e.target.findAncestor((n: Konva.Node) => /^brick-/.test(n.name()), true);
      const at = pointerStuds();
      const frame = editedModuleFrame(map, readSidecarFromDoc(doc)?.modules ?? NO_MODULES, editingModuleId);
      if (!onPart && at && (!frame || at.x < frame.x || at.y < frame.y || at.x > frame.x + frame.width || at.y > frame.y + frame.height)) {
        leaveModuleEdit();
        return;
      }
    }
    if (tool === 'select' && e.target !== e.target.getStage()) return;
    const studs = pointerStuds();
    if (!studs) return;

    if (tool === 'select' && !isViewer && evt.button === 0) {
      const grid = map?.layers.find((l) => l.id === activeLayerId);
      if (grid && grid.type === 'grid' && grid.visible && grid.displayCellIndex) {
        const cell = gridCellAt(studs.x, studs.y, grid.gridSizeInStud);
        const before = parseCellIndexCorner(grid.cellIndexCorner);
        gridDragRef.current = { layerId: grid.id, cellSize: grid.gridSizeInStud, before, start: cell, last: cell };
        setGridPreview({ layerId: grid.id, corner: before });
        const stage = stageRef.current;
        if (stage) stage.container().style.cursor = 'move';
        return;
      }
    }
    if (tool === 'select') {
      // Empty-space click in select mode → start marquee. Shift/Ctrl
      // extends the current selection instead of replacing it (Qt
      // rubber band with a modifier).
      marqueeAdditiveRef.current = evt.shiftKey || evt.ctrlKey || evt.metaKey;
      if (!marqueeAdditiveRef.current) setSelection([]);
      setMarquee({ x0: studs.x, y0: studs.y, x1: studs.x, y1: studs.y });
      return;
    }
    if (tool === 'paint' || tool === 'erase') {
      if (isViewer) return;
      const sheet = [...(map?.layers ?? [])].reverse().find((l) => l.type === 'area' && l.visible);
      if ((evt.ctrlKey || evt.metaKey) && sheet && sheet.type === 'area') {
        const cellSize = sheet.areaCellSize > 0 ? sheet.areaCellSize : 8;
        areaMoveRef.current = { layerId: sheet.id, cellSize, start: { x: Math.floor(studs.x / cellSize), y: Math.floor(studs.y / cellSize) } };
        return;
      }
      if (tool === 'erase' && !sheet) {
        useEditorStore.getState().showNotice('There’s no painted ground to erase. Use Paint first, or show the area sheet.', 'error');
        return;
      }
      paintStrokeRef.current = new Set();
      doPaintStroke(studs.x, studs.y);
    }
    if ((tool === 'rulerLinear' || tool === 'rulerCircular') && !isViewer) {
      // The start on the nearest grid point, as the desktop (Alt: free).
      const { x: sx, y: sy } = gridPointStuds(studs, snapBypassed(evt));
      setRulerDraft({
        kind: tool === 'rulerLinear' ? 'linear' : 'circular',
        startX: sx,
        startY: sy,
        curX: sx,
        curY: sy,
      });
    }
    if ((tool === 'venueOutline' || tool === 'venueObstacle') && !isViewer) {
      // Venue corners on the grid, as the parts are (Alt: where clicked).
      const { x: sx, y: sy } = gridPointStuds(studs, snapBypassed(evt));
      setVenueDraft((prev) =>
        prev
          ? { ...prev, pts: [...prev.pts, { x: sx, y: sy }], curX: sx, curY: sy }
          : { kind: tool === 'venueOutline' ? 'outline' : 'obstacle', pts: [{ x: sx, y: sy }], curX: sx, curY: sy }
      );
    }
  }

  function handleStageMouseMove(e: KonvaEventObject<MouseEvent>) {
    const evt = e.evt as MouseEvent;

    // Middle-button drag → translate pan. Mirrors MapView.cpp:649-657.
    if (middlePanRef.current) {
      const dx = evt.clientX - middlePanRef.current.lastX;
      const dy = evt.clientY - middlePanRef.current.lastY;
      middlePanRef.current = { lastX: evt.clientX, lastY: evt.clientY };
      moveRafRef.current.panDx += dx;
      moveRafRef.current.panDy += dy;
      schedulePointerMove();
      return;
    }

    const studs = pointerStuds();
    if (!studs) return;
    scheduleHudMouse(studs);
    const g = gridDragRef.current;
    if (g) {
      const cell = gridCellAt(studs.x, studs.y, g.cellSize);
      if (cell.x !== g.last.x || cell.y !== g.last.y) {
        g.last = cell;
        setGridPreview({ layerId: g.layerId, corner: { x: g.before.x + cell.x - g.start.x, y: g.before.y + cell.y - g.start.y } });
      }
      return;
    }
    const am = areaMoveRef.current;
    if (am && evt.buttons & 1) {
      const dx = Math.floor(studs.x / am.cellSize) - am.start.x;
      const dy = Math.floor(studs.y / am.cellSize) - am.start.y;
      if (dx !== areaShift?.dx || dy !== areaShift?.dy) setAreaShift({ layerId: am.layerId, dx, dy });
      return;
    }
    // Continue the paint/erase stroke while the button is held.
    if ((tool === 'paint' || tool === 'erase') && paintStrokeRef.current && evt.buttons & 1) {
      doPaintStroke(studs.x, studs.y);
    }
    if (marquee || rulerDraft || venueDraft) {
      moveRafRef.current.studs = studs;
      moveRafRef.current.free = snapBypassed(evt);
      schedulePointerMove();
    }
    // Always broadcast cursor so peers can see us — even when we're
    // panning or hovering empty space.
    dispatchCursorMove(studs.x, studs.y);
  }

  function handleStageMouseLeave() {
    dispatchCursorLeave();
    if (middlePanRef.current) setViewMoving(false);
    middlePanRef.current = null;
    paintStrokeRef.current = null;
    areaMoveRef.current = null;
    setAreaShift(null);
    scheduleHudMouse(null);
  }

  /**
   * Paint or erase the area-cell under the given studs. Uses the topmost
   * Area layer (creating one if none exists). Mirrors desktop's
   * MapView.cpp:491-533 + AreaCommands `PaintAreaCellsCommand`.
   */
  function doPaintStroke(studX: number, studY: number) {
    if (!map) return;
    const stroke = paintStrokeRef.current;
    if (!stroke) return;
    // Erasing needs painted ground: with no area sheet shown there's
    // nothing to erase, and no empty sheet is made for it.
    const layerId = tool === 'erase' ? shownAreaLayer(doc) : ensureAreaLayer(doc);
    if (!layerId) return;
    // The sheet's cell size, from the doc: a sheet this stroke just made
    // isn't in `map` yet (it used to be painted in 8-stud cells on a
    // 32-stud sheet, so the first stroke's squares landed apart).
    const fromDoc = doc.getMap<Y.Map<unknown>>('layerData').get(layerId)?.get('areaCellSize');
    const cellStuds = typeof fromDoc === 'number' && fromDoc > 0 ? fromDoc : 8;
    const cx = Math.floor(studX / cellStuds);
    const cy = Math.floor(studY / cellStuds);
    const key = `${cx},${cy}`;
    if (stroke.has(key)) return;
    stroke.add(key);
    const color = useEditorStore.getState().paintColor;
    paintAreaCells(doc, layerId, [{ x: cx, y: cy, color: tool === 'erase' ? null : color }]);
  }

  function handleStageMouseUp(e: KonvaEventObject<MouseEvent>) {
    const evt = e.evt as MouseEvent;
    if (gridDragRef.current && evt.button === 0) {
      endGridDrag(true);
      return;
    }
    if (evt.button === 1 && middlePanRef.current) {
      middlePanRef.current = null;
      flushPointerMove();
      setViewMoving(false);
      return;
    }
    paintStrokeRef.current = null;
    if (areaMoveRef.current && evt.button === 0) {
      const am = areaMoveRef.current;
      areaMoveRef.current = null;
      const studs = pointerStuds();
      const dx = studs ? Math.floor(studs.x / am.cellSize) - am.start.x : (areaShift?.dx ?? 0);
      const dy = studs ? Math.floor(studs.y / am.cellSize) - am.start.y : (areaShift?.dy ?? 0);
      setAreaShift(null);
      moveArea(doc, am.layerId, dx, dy);
      return;
    }
    // Pending (not yet rendered) pointer move: the marquee must commit
    // against the final pointer position, not the last painted frame.
    const pendingStuds = moveRafRef.current.studs;
    flushPointerMove();

    // Commit a ruler draft if one is active. Snap end point to grid.
    if (rulerDraft) {
      const studs = pointerStuds() ?? { x: rulerDraft.curX, y: rulerDraft.curY };
      const { x: ex, y: ey } = gridPointStuds(studs, snapBypassed(evt));
      const dx = ex - rulerDraft.startX;
      const dy = ey - rulerDraft.startY;
      // Skip degenerate zero-length drags (e.g. user clicked without drag).
      if (Math.hypot(dx, dy) >= 0.5) {
        const layerId = ensureRulerLayer(doc, activeLayerId);
        if (rulerDraft.kind === 'linear') {
          addLinearRuler(
            doc,
            layerId,
            { x: rulerDraft.startX, y: rulerDraft.startY },
            { x: ex, y: ey },
          );
        } else {
          addCircularRuler(
            doc,
            layerId,
            { x: rulerDraft.startX, y: rulerDraft.startY },
            Math.hypot(dx, dy),
          );
        }
        announcePlacement([layerId], null, 'Your ruler');
      }
      setRulerDraft(null);
    }

    if (!marquee) return;
    commitMarquee(pendingStuds ? { ...marquee, x1: pendingStuds.x, y1: pendingStuds.y } : marquee, marqueeAdditiveRef.current);
    marqueeAdditiveRef.current = false;
    setMarquee(null);
  }

  /** Pick what a finished rubber band touches (mouse or touch); `additive` keeps what was picked. */
  function commitMarquee(finalMarquee: import('./render/MarqueeOverlay').Marquee, additive: boolean) {
    // Commit selection across EVERY visible brick layer — matches the
    // desktop's `MapView::mouseReleaseEvent` rubber-band, which calls
    // `QGraphicsView::mouseReleaseEvent` and lets Qt's scene selection
    // pick from every brick item regardless of layer.
    //
    // Hidden layers are skipped so the user can't accidentally select
    // bricks they can't see; the brick z-order across layers doesn't
    // affect the result. Each brick is tested by its rotated shape, like
    // Qt's IntersectsItemShape rubber band (render/marqueeMath.ts).
    //
    // Rulers, anchored labels and text cells in the band join the
    // selection too (mixed selection, like desktop's scene selection).
    if (map) {
      const ids: string[] = [];
      for (const layer of map.layers) {
        if (layer.type !== 'brick' || !layer.visible) continue;
        ids.push(...bricksInMarquee(finalMarquee, layer.bricks, brickSpriteStuds, (b) => pivotOf(b, partOf(b.partNumber))));
      }
      const sc = readSidecarFromDoc(doc);
      let anno = annotationsInMarquee(finalMarquee, map, sc?.anchoredLabels ?? [], sc?.modules ?? [], zoom, partsByKey);
      let bricks = ids;
      if (additive) {
        const st = useEditorStore.getState();
        bricks = [...new Set([...st.selection, ...ids])];
        anno = mergeAnno(st.annoSelection, anno);
      }
      useEditorStore.getState().setMixedSelection(bricks, anno);
    }
  }

  // ---------------------------------------------------------------------
  // Clipboard — port of MapViewClipboard.cpp (29-132).
  // ---------------------------------------------------------------------

  /** Copies the picked parts; says whether the system clipboard took them too (null: nothing to copy). */
  async function copySelection(): Promise<SystemClipboard | null> {
    if (selection.length === 0 || !map) return null;
    const sel = new Set(selection);
    const entries: ClipboardEntry[] = [];
    const anchors = linksByAnchor(readSidecarFromDoc(doc) as Record<string, unknown> | null);
    // Walk every brick layer in declaration order so within-layer
    // z-order survives copy/paste — same as desktop's
    // MapViewClipboard.cpp:42-49.
    for (const layer of map.layers) {
      if (layer.type !== 'brick') continue;
      for (const b of layer.bricks) {
        if (!sel.has(b.id)) continue;
        entries.push({
          sourceLayerName: layer.name,
          brick: {
            partNumber: b.partNumber,
            displayArea: { ...b.displayArea },
            orientation: b.orientation,
            altitude: b.altitude,
            activeConnectionPointIndex: b.activeConnectionPointIndex,
            myGroup: b.myGroup,
          },
          // The sets (groups) it is in, so a pasted set stays a set.
          groups: groupChain(layer.groups, b.myGroup),
          // A placed custom set's anchor part: the pasted set keeps track of its version.
          ...(anchors.has(b.id) ? { placedSet: anchors.get(b.id)! } : {}),
        });
      }
    }
    // Exactly one module picked: a paste makes a copy of the module.
    return writeBricksToClipboard(entries, pickedWholeModule());
  }

  /** The one module the picked parts are exactly, outside Edit module (where parts join the edited module instead). */
  function pickedWholeModule() {
    if (useEditorStore.getState().editingModuleId) return null;
    return wholeModule(readSidecarFromDoc(doc)?.modules ?? NO_MODULES, selection);
  }

  /** Register `ids` as a copy of `module` ("X (copy)", its look, unlinked, unpinned). */
  function addModuleCopy(module: SidecarModule, ids: string[]): void {
    if (ids.length === 0 || useEditorStore.getState().editingModuleId) return;
    addSidecarModule(doc, moduleCopy(module, ids));
  }

  async function cutSelection(): Promise<SystemClipboard | null> {
    const copied = await copySelection();
    if (selection.length === 0) return copied;
    deleteBricksAcrossLayers(doc, selectionByLayer());
    setSelection([]);
    return copied;
  }

  /** A set may be split unless its <CanUngroup> is false (flex track). */
  function canUngroupSet(g: BrickGroup): boolean {
    return !g.partNumber || partsByKey.get(g.partNumber.toLowerCase())?.canUngroup !== false;
  }

  /** Ungroup, keeping whole the sets that are always used whole (flex track). */
  function ungroupSelection(): void {
    const { refused } = ungroupBricksAcrossLayers(doc, selectionByLayer(), canUngroupSet);
    if (refused > 0) useEditorStore.getState().showStatusMessage("This set is always used whole, so it can't be ungrouped", 4000);
  }

  /** The selection's brick ids grouped by the layer that holds them. */
  /**
   * Bring to Front / Send to Back for what's picked: parts, and text and
   * rulers too (BlueBrick's BringTextToFront, BringRulerToFront). One undo step.
   */
  function reorderPicked(to: 'front' | 'back'): void {
    if (isViewer) return;
    const st = useEditorStore.getState();
    const anno = st.annoSelection;
    if (st.selection.length === 0 && anno.texts.length === 0 && anno.rulers.length === 0) return;
    doc.transact(() => {
      if (st.selection.length > 0) reorderBricks(doc, st.selection, to);
      if (anno.texts.length > 0 || anno.rulers.length > 0) {
        const keys = reorderAnnotations(doc, anno, to);
        // Text is picked by sheet and position, which just changed.
        if (anno.texts.length > 0) useEditorStore.getState().setMixedSelection(st.selection, { ...anno, texts: keys });
      }
    }, LOCAL_ORIGIN);
  }

  /**
   * Rotate CW / CCW for what's picked: parts, and text and rulers too
   * (BlueBrick RotateText, RotateRulers), about one pivot. One undo step.
   */
  turnRef.current = (ids, back) => {
    if (isViewer) return;
    useEditorStore.getState().setSelection([...ids]);
    rotatePicked(back ? -rotationStepDegrees : rotationStepDegrees);
  };
  function rotatePicked(degrees: number): void {
    const st = useEditorStore.getState();
    if (st.selection.length + annoCount(st.annoSelection) === 0) return;
    if (!selectionMayMove(doc, st.selection)) return;
    // In mid-drag: the parts go down where they are first, then turn, and
    // the drag picks up again (brickDrag.ts).
    brickDrag.dropForTurn();
    rotateSelection(doc, map ? bricksByLayer(map, st.selection) : new Map(), st.annoSelection, degrees, partOf);
  }

  /** Also pick every part connected to the picked ones (Select Connected). */
  function selectConnected(): void {
    if (!map) return;
    const adj = buildConnectedAdj(map);
    const visited = new Set<string>(selection);
    const queue = [...selection];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const nb of adj.get(id) ?? []) {
        if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
      }
    }
    setSelection([...visited]);
  }

  function selectionByLayer(): Map<string, string[]> {
    return map ? bricksByLayer(map, selection) : new Map();
  }

  /** The selected parts to that part sheet, or (null) to a new one: one undo step. */
  function moveSelectionToSheet(target: string | null): void {
    if (isViewer) return;
    const byLayer = selectionByLayer();
    if (byLayer.size === 0) return;
    doc.transact(() => {
      const to = target ?? addLayer(doc, 'brick');
      if (moveBricksToLayer(doc, byLayer, to) > 0) setActiveLayer(to);
    }, LOCAL_ORIGIN);
  }

  /**
   * Delete the whole mixed selection — bricks on any layer, rulers,
   * labels and text cells — as one undo step (MapView.cpp:2108-2179).
   */
  function deleteSelection(): void {
    if (!map || selection.length + annoCount(annoSelection) === 0) return;
    deleteMixedSelection(doc, map, selection, annoSelection);
    setSelection([]);
  }

  // Use Budget Limitation (Budget menu): refuse parts over budget, like
  // MapView::budgetAllows. The layout has a budget when it has a limit.
  const [budgetBox, setBudgetBox] = useState(false);
  function reportBudgetRefusal() {
    const st = useEditorStore.getState();
    st.showStatusMessage(BUDGET_REFUSED_STATUS, 3000);
    if (st.warnBudgetLimitation) setBudgetBox(true);
  }
  function budgetLimitsInForce(): Map<string, number> | null {
    if (!useEditorStore.getState().useBudgetLimitation) return null;
    const limits = readBudgetLimits(doc);
    return limits.size > 0 ? limits : null;
  }
  function budgetAllows(part: string, quantity = 1): boolean {
    const limits = budgetLimitsInForce();
    if (!limits) return true;
    const { budgetDefaultInfinite } = useEditorStore.getState();
    if (canAddToBudget(limits, countUsage(map), part, quantity, budgetDefaultInfinite, partsByKey)) return true;
    reportBudgetRefusal();
    return false;
  }
  /** Paste / duplicate: leave out bricks beyond their budget (MapViewClipboard.cpp:84-95). */
  function keepWithinBudget<T>(bricks: T[], partOf: (brick: T) => string): T[] {
    const limits = budgetLimitsInForce();
    if (!limits) return bricks;
    const { kept, refused } = withinBudget(limits, map, bricks, partOf, useEditorStore.getState().budgetDefaultInfinite);
    if (refused > 0) reportBudgetRefusal();
    return kept;
  }

  /** Where a paste or duplicate lands: under the cursor, else the view centre. */
  function currentPasteTarget(): { x: number; y: number } {
    const { panX: livePanX, panY: livePanY, zoom: liveZoom } = useEditorStore.getState();
    return pasteTarget(pointerStuds(), { width, height, panX: livePanX, panY: livePanY, zoom: liveZoom });
  }

  /**
   * Pastes the copied parts, their centre under the cursor, or on `at`
   * (studs: a touch's spot, or the middle of the view). Says how many it
   * placed, whether there was anything to paste, and whether the browser
   * let it read the system clipboard.
   */
  async function pasteAtCursor(at?: { x: number; y: number }): Promise<{ pasted: number; found: boolean; system: SystemClipboard; hiddenSheet?: boolean }> {
    const { content: read, system } = await readClipboardStatus();
    const clipped = read?.entries;
    if (!clipped || clipped.length === 0 || !map) return { pasted: 0, found: false, system };
    // The group's centre lands under the cursor (MapViewClipboard.cpp:62-73).
    const { dx, dy } = pasteOffset(clipped.map((e) => e.brick.displayArea), at ?? currentPasteTarget());
    const entries = keepWithinBudget(clipped, (e) => e.brick.partNumber);
    if (entries.length === 0) return { pasted: 0, found: true, system };

    // Group entries by source-layer name; find or create a brick layer
    // with that name in the current map.
    const byLayerName = new Map<string, ClipboardEntry[]>();
    const layerOrder: string[] = [];
    for (const entry of entries) {
      const key = entry.sourceLayerName || 'Bricks';
      if (!byLayerName.has(key)) {
        byLayerName.set(key, []);
        layerOrder.push(key);
      }
      byLayerName.get(key)!.push(entry);
    }

    const newIds: string[] = [];
    const pastedOn: string[] = [];
    // One undo step: the parts, and the module copy when a whole module was copied.
    doc.transact(() => {
    for (const name of layerOrder) {
      const targetLayerId = findOrCreateBrickLayerByName(name);
      if (!targetLayerId) continue;
      if (!pastedOn.includes(targetLayerId)) pastedOn.push(targetLayerId);
      const layerEntries = byLayerName.get(name)!;
      const copied = cloneGroups(
        layerEntries.flatMap((e) => e.groups ?? []),
        layerEntries.map((e) => ({
          partNumber: e.brick.partNumber,
          displayArea: { ...e.brick.displayArea },
          orientation: e.brick.orientation,
          altitude: e.brick.altitude,
          myGroup: e.brick.myGroup ?? '',
        })),
        makeId,
      );
      const ids = insertBricks(doc, targetLayerId, copied.bricks, { dx, dy }, copied.groups);
      newIds.push(...ids);
      copyPlacedSets(doc, layerEntries.flatMap((e, i) => (e.placedSet && ids[i] ? [{ brick: ids[i], link: e.placedSet }] : [])));
    }
    if (read.module && entries.length === clipped.length) addModuleCopy(read.module, newIds);
    }, LOCAL_ORIGIN);
    absorbIntoEditedModule(doc, newIds);
    if (newIds.length > 0) setSelection(newIds);
    // A paste keeps each part's own sheet (by name), not the active one: say where they went.
    let hiddenSheet = false;
    if (newIds.length > 0) {
      const layers = projectDoc(doc)?.layers ?? [];
      const on = pastedOn.map((id) => layers.find((l) => l.id === id)).filter((l) => l !== undefined);
      hiddenSheet = on.some((l) => !l.visible);
      if (hiddenSheet) announcePlacement(pastedOn, activeLayerId, newIds.length === 1 ? 'The pasted part' : 'The pasted parts', newIds.length === 1);
      else {
        for (const l of on) useEditorStore.getState().flashSheet(l.id);
        useEditorStore.getState().showStatusMessage(`Pasted ${newIds.length === 1 ? '1 part' : `${newIds.length} parts`} → ${on.map((l) => sheetName(l)).join(', ')}`, 4000);
      }
    }
    return { pasted: newIds.length, found: true, system, hiddenSheet };
  }

  /**
   * Copy, Cut and Paste by touch: the same clipboard as Ctrl+C / Ctrl+V,
   * so a copy on a phone pastes on a tablet or computer and back, when the
   * browser shares its clipboard. What happened is said in plain words,
   * since a phone has no status bar.
   */
  async function clipboardByTouch(what: 'copy' | 'cut' | 'paste', at?: { x: number; y: number }): Promise<void> {
    if (isViewer) return;
    const notice = useEditorStore.getState().showNotice;
    const parts = (n: number) => (n === 1 ? '1 part' : `${n} parts`);
    if (what === 'paste') {
      const target = at ?? viewCentreStuds({ width, height });
      const { pasted, found, system, hiddenSheet } = await pasteAtCursor(target);
      if (pasted > 0 && !hiddenSheet) notice(`Pasted ${parts(pasted)}.`, 'done', 4000);
      else if (!found) {
        notice(
          system === 'blocked'
            ? 'Nothing to paste yet. Your browser didn’t let the app read the clipboard, so only parts copied in this tab can be pasted.'
            : 'Nothing to paste yet. Pick parts, then tap Actions and Copy.',
          'error',
          7000,
        );
      }
      return;
    }
    const n = selection.length;
    const system = what === 'cut' ? await cutSelection() : await copySelection();
    if (!system) return;
    const done = `${what === 'cut' ? 'Cut' : 'Copied'} ${parts(n)}.`;
    notice(
      system === 'ok'
        ? `${done} To place ${n === 1 ? 'it' : 'them'}, tap Paste, in this layout or another.`
        : `${done} Your browser keeps the copy in this tab only, so paste it in this tab, in this layout or another.`,
      'done',
      7000,
    );
  }

  async function duplicateSelection(beside = false): Promise<void> {
    await copySelection();
    // Desktop Duplicate is copy + paste (MapViewClipboard.cpp:144-147):
    // the copies land centred under the cursor. Each lands on its source
    // brick's own layer (desktop pastes by source layer), in one undo step.
    if (!map) return;
    const sel = new Set(selection);
    const perLayer = new Map<string, Parameters<typeof insertBricks>[2]>();
    // Each copy's original, so a placed set's copy keeps track of its version too.
    const sourceOf = new Map<object, string>();
    const groupsOf = new Map(map.layers.flatMap((l) => (l.type === 'brick' ? [[l.id, l.groups] as const] : [])));
    for (const layer of map.layers) {
      if (layer.type !== 'brick') continue;
      const bricks = layer.bricks
        .filter((b) => sel.has(b.id))
        .map((b) => {
          const copy = {
            partNumber: b.partNumber,
            displayArea: { ...b.displayArea },
            orientation: b.orientation,
            altitude: b.altitude,
            myGroup: b.myGroup,
          };
          sourceOf.set(copy, b.id);
          return copy;
        });
      if (bricks.length > 0) perLayer.set(layer.id, bricks);
    }
    const areas = [...perLayer.values()].flat().map((b) => b.displayArea);
    // By touch there's no cursor: the copy lands beside the original.
    const offset = pasteOffset(areas, (beside ? besideTarget(areas) : null) ?? currentPasteTarget());
    // Bricks beyond their budget are left out, in layer order.
    const flat = [...perLayer].flatMap(([layerId, bricks]) => bricks.map((brick) => ({ layerId, brick })));
    perLayer.clear();
    for (const { layerId, brick } of keepWithinBudget(flat, (f) => f.brick.partNumber)) {
      perLayer.set(layerId, [...(perLayer.get(layerId) ?? []), brick]);
    }
    // The sets in the selection stay sets: their groups come along.
    const groupsPerLayer = new Map<string, BrickGroup[]>();
    for (const [layerId, bricks] of perLayer) {
      const copied = cloneGroups(groupsOf.get(layerId) ?? [], bricks, makeId);
      copied.bricks.forEach((b, i) => sourceOf.set(b, sourceOf.get(bricks[i]!) ?? ''));
      perLayer.set(layerId, copied.bricks);
      groupsPerLayer.set(layerId, copied.groups);
    }
    const whole = pickedWholeModule();
    const kept = [...perLayer.values()].reduce((n, b) => n + b.length, 0);
    let ids: string[] = [];
    const anchors = linksByAnchor(readSidecarFromDoc(doc) as Record<string, unknown> | null);
    doc.transact(() => {
      ids = insertBricksAcrossLayers(doc, perLayer, offset, groupsPerLayer);
      if (whole && kept === whole.members.length) addModuleCopy(whole, ids);
      // (insertBricksAcrossLayers adds the layers' parts in this order.)
      const originals = [...perLayer.values()].flat().map((b) => sourceOf.get(b) ?? '');
      copyPlacedSets(doc, originals.flatMap((from, i) => (anchors.has(from) && ids[i] ? [{ brick: ids[i], link: anchors.get(from)! }] : [])));
    }, LOCAL_ORIGIN);
    absorbIntoEditedModule(doc, ids);
    if (ids.length > 0) setSelection(ids);
  }

  /**
   * Find a brick layer by name; if none exists, create one. Mirrors
   * MapViewClipboard.cpp:93-104. Returns null only when the doc isn't
   * a brick-layer-capable map yet.
   */
  function findOrCreateBrickLayerByName(name: string): string | null {
    if (!map) return null;
    for (const layer of map.layers) {
      if (layer.type === 'brick' && layer.name === name) return layer.id;
    }
    // No matching layer — fall back to ensureBrickLayer (creates a
    // generic Bricks layer). This loses the original name but is the
    // safest behaviour without a "rename layer" mutation.
    return ensureBrickLayer(doc);
  }

  /**
   * Shared place commit, used by the place tool AND by the drag-from-
   * parts-panel drop handler. Sprite-aware sizing + snap-to-connection
   * + grid fallback. For `.set` (group) parts this expands the set
   * into one brick per subpart — port of MapView.cpp:1279-1360.
   */
  async function placePartAt(
    meta: PartWire,
    studX: number,
    studY: number,
    snapOpts: { session?: SnapSession; bypass?: boolean; final?: boolean } = {},
  ) {
    // A part only used inside sets (<NotListedInLibrary>) isn't placed by itself.
    if (meta.notListed) {
      useEditorStore.getState().showNotice(hiddenPartNotice(meta), 'error', 7000);
      return;
    }
    if (!budgetAllows(meta.key)) return;
    // Group / set placement — expand into individual bricks at the
    // subpart-relative offsets the .set.xml declares. Single Yjs
    // transaction so undo unwinds the whole expansion.
    if (meta.kind === 'group' && meta.subparts.length > 0) {
      await placeSetAt(meta, studX, studY, snapOpts);
      return;
    }

    // Unturned size, used only when the catalog has no sprite size for the
    // footprint: the loaded sprite's `naturalSize / pxPerStud`, else 16x16.
    let widthStuds = 16;
    let heightStuds = 16;
    const spriteUrl = meta.spriteSize ? '' : spriteUrlFor(meta);
    if (meta.spriteSize) {
      ({ width: widthStuds, height: heightStuds } = areaSize(meta, 0));
    } else if (spriteUrl) {
      try {
        const img = await ensureSprite(spriteUrl);
        widthStuds = img.naturalWidth / meta.pxPerStud;
        heightStuds = img.naturalHeight / meta.pxPerStud;
      } catch {
        // Use the default; the brick still places, just sized 16x16.
      }
    }

    // Selection-anchor snap: if exactly one brick is selected and it has
    // a free connection compatible with the new part, lock onto that
    // connection. Takes priority over cursor-proximity snap. Port of
    // MapView::resolvePartPlacement lines 1147-1202 (MapView.cpp).
    // One placed set selected (flex track...): its free ends in the set's
    // GroupConnectionPreferenceList order (desktop edit::setAnchorOrder).
    let snapped = null as import('./snap').SnapResult | null;
    const metaOf = (pn: string) => partsByKey.get(pn.toLowerCase()) ?? partsByKey.get(pn.toLowerCase().split('.')[0] ?? '');
    if (map && selection.length === 1 && meta.kind !== 'group') {
      for (const layer of map.layers) {
        if (layer.type !== 'brick') continue;
        const anchorBrick = layer.bricks.find((b) => b.id === selection[0]);
        if (!anchorBrick) continue;
        const anchorMeta = metaOf(anchorBrick.partNumber);
        if (anchorMeta) {
          snapped = snapToAnchorBrick(anchorBrick, anchorMeta, meta, widthStuds, heightStuds);
        }
        break;
      }
    } else if (map && selection.length > 1 && meta.kind !== 'group') {
      for (const layer of map.layers) {
        if (layer.type !== 'brick') continue;
        const set = selectedSet(layer, selection);
        if (!set) continue;
        for (const end of setAnchorOrder(partsByKey, set.setKey, set.bricks)) {
          const anchorMeta = metaOf(end.brick.partNumber);
          snapped = anchorMeta ? snapToAnchorBrick(end.brick, anchorMeta, meta, widthStuds, heightStuds, [end.connection]) : null;
          if (snapped) break;
        }
        break;
      }
    }

    // Fallback: cursor-proximity connection snap, then grid snap.
    if (!snapped) {
      snapped = map
        ? snapPlacement(
            {
              part: meta,
              centreX: studX,
              centreY: studY,
              orientation: 0,
              width: widthStuds,
              height: heightStuds,
              pivotOffsetX: imageOffset(meta, 0).x,
              pivotOffsetY: imageOffset(meta, 0).y,
              snapStepStuds,
              reach: liveSnapReach(),
              ...snapOpts,
            },
            map,
            partsByKey,
          )
        : { centreX: studX, centreY: studY, snappedToConnection: false, newOrientation: null };
    }

    const pickedId = activeLayerId;
    const layerId = resolveBrickLayerForPlacement();
    if (activeLayerId !== layerId) setActiveLayer(layerId);

    // `snapPlacement` returns the rotation-aligned centre when connection
    // snap fired (mirrors desktop's `rotationAlignedTranslationStuds` +
    // `newOrientation` from ConnectionSnap.cpp:149-152). When no snap
    // fired, `newOrientation` is null and we default to 0°.
    const placeOrientation = snapped.newOrientation ?? 0;

    // The snap result is the pivot (sprite centre); the box is the
    // footprint at the final orientation around it (placeByImageCentre).
    const area = areaForPivot(meta, placeOrientation, { x: snapped.centreX, y: snapped.centreY }, { width: widthStuds, height: heightStuds });
    const newId = placeBrick(doc, layerId, {
      // Desktop stores the FULL catalog key (e.g. "2865.8") as the
      // brick's partNumber — see MapView.cpp:1380 `b.partNumber = partKey`.
      // We were saving the bare meta.partNumber ("2865"), which works at
      // runtime via the lookup fallback but writes a divergent value to
      // disk on export. Use `meta.key` so .bbm round-trip is byte-clean.
      partNumber: meta.key,
      x: area.x,
      y: area.y,
      width: area.width,
      height: area.height,
      orientation: placeOrientation,
    });
    // Link it now, like desktop's rebuild after AddBrickCommand: the new
    // links hand the active connection over (BlueBrick onLinked), so the
    // next chained placement anchors on the right end.
    recomputeConnectivity(doc, linkCatalog);
    absorbIntoEditedModule(doc, [newId]);
    // Auto-select the placed brick so chain-placing snaps off it.
    // Port of MapView.cpp:1394-1408.
    setSelection([newId]);
    announcePlacement([layerId], pickedId, 'Your part');
  }

  /**
   * Place a set as one BlueBrick group (a nested set is a child group),
   * never a module — the desktop's MapView::addPartAtScenePos. Each
   * sub-part's XML position is its box centre (BlueBrick's Group
   * constructor); its free ends snap like a module drop, and its own
   * joints are linked straight away. One undo step.
   */
  /**
   * Where a set put at (studX, studY) lands: its parts expanded there, then
   * its free ends snapped like a module drop's (no grid: the set sits where
   * it was put). Shared by the drop and the ghost shown while dragging, so
   * the ghost lands exactly where the set will. Parts without a footprint
   * take their picture's size (`natural`, else the loaded picture, else 2x2).
   */
  function setDropLayout(
    group: PartWire,
    studX: number,
    studY: number,
    snapOpts: { session?: SnapSession; bypass?: boolean; final?: boolean },
    natural?: ReadonlyMap<string, { width: number; height: number }>,
  ) {
    const pictureSize = (part: PartWire) => {
      const known = natural?.get(part.key);
      if (known) return known;
      const img = getSpriteSync(spriteUrlFor(part));
      return img ? { width: img.naturalWidth / part.pxPerStud, height: img.naturalHeight / part.pxPerStud } : null;
    };
    const set = expandSet(partsByKey, group.key, { x: studX, y: studY }, 0, makeId, (part, angle) =>
      part?.spriteSize ? areaSize(part, angle) : (part && pictureSize(part)) ?? { width: 2, height: 2 },
    );
    if (set.bricks.length === 0) return null;
    const centre = set.bricks.reduce(
      (acc, b) => ({ x: acc.x + (b.displayArea.x + b.displayArea.width / 2) / set.bricks.length, y: acc.y + (b.displayArea.y + b.displayArea.height / 2) / set.bricks.length }),
      { x: 0, y: 0 },
    );
    const batch: ModuleBatch = { layerName: '', bricks: set.bricks };
    const drop = moduleDropTranslation([batch], centre, 0, map, partsByKey, {
      reach: liveSnapReach(),
      ...(snapOpts.session ? { session: snapOpts.session } : {}),
      ...(snapOpts.bypass !== undefined ? { bypass: snapOpts.bypass } : {}),
      final: snapOpts.final ?? false,
    });
    const placed = placedModuleBatches([batch], drop, partsByKey)[0]!.bricks.map((b, i) => ({ ...b, myGroup: set.bricks[i]!.myGroup }));
    return { set, drop, placed };
  }

  async function placeSetAt(
    group: PartWire,
    studX: number,
    studY: number,
    snapOpts: { session?: SnapSession; bypass?: boolean; final?: boolean } = {},
  ) {
    if (group.subparts.length === 0) return;
    const pickedId = activeLayerId;
    const layerId = resolveBrickLayerForPlacement();
    if (activeLayerId !== layerId) setActiveLayer(layerId);

    // Parts without a footprint get their box from their picture.
    const natural = new Map<string, { width: number; height: number }>();
    const visit = async (set: PartWire, outer: readonly PartWire[]): Promise<void> => {
      const inside = [...outer, set];
      for (const sub of set.subparts) {
        const meta = subpartOf(partsByKey, sub.subKey, inside);
        if (!meta) continue;
        if (meta.kind === 'group') {
          if (inside.length < 16) await visit(meta, inside);
          continue;
        }
        const url = meta.spriteSize ? '' : spriteUrlFor(meta);
        if (!url || natural.has(meta.key)) continue;
        try {
          const img = await ensureSprite(url);
          natural.set(meta.key, { width: img.naturalWidth / meta.pxPerStud, height: img.naturalHeight / meta.pxPerStud });
        } catch {
          /* missing sprite — keep the 2x2 placeholder */
        }
      }
    };
    await visit(group, []);
    const layout = setDropLayout(group, studX, studY, { ...snapOpts, final: snapOpts.final ?? true }, natural);
    if (!layout) return;
    const { set, placed } = layout;
    const setName = group.description || group.key;
    let newIds: string[] = [];
    doc.transact(() => {
      newIds = insertSet(doc, layerId, { bricks: placed.map((b) => ({ ...b, orientation: b.orientation ?? 0 })), groups: set.groups });
      // A custom set keeps track of the version it came from (sidecar only).
      const link = trackedSet(partsByKey, group.key) ? placedSetLink(partsByKey, group, set.groups[0]?.id ?? '', newIds[0]) : null;
      if (link) writePlacedSets(doc, [link]);
    }, LOCAL_ORIGIN);
    recomputeConnectivity(doc, linkCatalog);
    absorbIntoEditedModule(doc, newIds);
    if (newIds.length > 0) setSelection(newIds);
    useEditorStore.getState().showStatusMessage(`Placed set: ${setName} (${newIds.length} parts) on “${sheetName(projectDoc(doc)?.layers.find((l) => l.id === layerId))}”`, 3000);
    if (newIds.length > 0) announcePlacement([layerId], pickedId, 'The set', false);
  }

  /** Update placed custom sets to their set's current version, where each sits now: one undo step. */
  function updatePlacedSets(list: readonly SetUpdate[]) {
    if (!map || list.length === 0) return;
    const sizeOf = (part: PartWire | undefined, angle: number) => {
      if (part?.spriteSize) return areaSize(part, angle);
      const img = part ? getSpriteSync(spriteUrlFor(part)) : null;
      return img && part ? { width: img.naturalWidth / part.pxPerStud, height: img.naturalHeight / part.pxPerStud } : { width: 2, height: 2 };
    };
    const ids: string[] = [];
    doc.transact(() => {
      for (const u of list) ids.push(...applySetUpdate(doc, map, u, partsByKey, makeId, sizeOf));
    }, LOCAL_ORIGIN);
    recomputeConnectivity(doc, linkCatalog);
    if (ids.length > 0) setSelection(ids);
    const names = [...new Set(list.map((u) => u.name))];
    useEditorStore
      .getState()
      .showNotice(
        names.length === 1 ? `Updated “${names[0]}” to its newest version. Undo (Ctrl+Z) puts it back.` : `Updated ${list.length} sets to their newest versions. Undo (Ctrl+Z) puts them back.`,
        'done',
        7000,
      );
  }

  /** Pick these placed copies, and bring them into view. */
  function showPlacedSets(list: readonly SetUpdate[]) {
    if (!map) return;
    const want = new Set(list.map((u) => u.group.id));
    const picked = map.layers.flatMap((l) => (l.type === 'brick' ? l.bricks.filter((b) => groupChain(l.groups, b.myGroup).some((g) => want.has(g.id))) : []));
    if (picked.length === 0) return;
    setSelection(picked.map((b) => b.id));
    const bounds = unionStudRects(
      null,
      picked.map((b) => ({ ...b.displayArea })),
    );
    // Not closer than now (or 1:1), so a small set isn't blown up to fill the screen.
    const fit = fitView(bounds, width, height, { min: MIN_ZOOM, max: Math.min(MAX_ZOOM, Math.max(1, useEditorStore.getState().zoom)) });
    if (fit) useEditorStore.setState(fit);
  }

  // Keep the imperative "place at view center" handle fresh every render
  // so the PartsPanel's click always uses the latest pan/zoom/size.
  // Port of MapView::addPartAtViewCenter (MapView.cpp:1279-1360).
  placeAtCenterRef.current = (meta: PartWire) => {
    if (isViewer) return;
    // Compute the world-stud coords of the canvas centre.
    const centreStudX = pxToStud((width / 2 - panX) / zoom);
    const centreStudY = pxToStud((height / 2 - panY) / zoom);
    void placePartAt(meta, centreStudX, centreStudY);
  };

  /** The map area on screen now, in studs (what "Use this area" keeps). */
  function screenRegion(): StudRect | null {
    const st = stageRef.current;
    const w = st?.width() ?? width;
    const h = st?.height() ?? height;
    if (!(w > 0 && h > 0 && zoom > 0)) return null;
    const x = pxToStud(-panX / zoom);
    const y = pxToStud(-panY / zoom);
    return { x, y, width: pxToStud(w / zoom), height: pxToStud(h / zoom) };
  }

  /**
   * One picture (savedViews.ts PictureSpec) at exactly `size` pixels.
   * The canvas shows the picture's sheets, grid and labels for the moment
   * it takes to draw it (with all text drawn, as on a computer), then goes
   * back to what it showed.
   */
  async function renderPicture(spec: PictureSpec, size: { width: number; height: number }): Promise<HTMLCanvasElement | null> {
    const stage = stageRef.current;
    const live = mapRef.current;
    if (!stage || !live) return null;
    // The pictures of the bricks it shows, before they're drawn.
    const shownLayers = applyViewSheets(live, spec.sheets).layers;
    const urls = new Set<string>();
    for (const l of shownLayers) {
      if (l.type !== 'brick' || !l.visible) continue;
      for (const b of l.bricks) {
        const meta = partsByKey.get(b.partNumber.toLowerCase());
        if (meta && !meta.spriteSize) urls.add(spriteUrlFor(meta));
      }
    }
    await Promise.allSettled([...urls].map((u) => ensureSprite(u)));
    await mapFontsReady();
    const before = useEditorStore.getState();
    const saved = { viewFilter: before.viewFilter, minTextPx: before.minTextPx };
    flushSync(() => useEditorStore.setState({ viewFilter: { sheets: spec.sheets, grid: spec.grid, labels: spec.labels }, minTextPx: 0 }));
    try {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const out = renderMapToCanvas(stage, live, readSidecarFromDoc(doc), {
        pixelRatio: 1,
        size,
        transparent: false,
        regionStuds: spec.region,
        grid: pictureGrid(live, spec),
        hudLayer: hudLayerRef.current,
      });
      return out?.canvas ?? null;
    } finally {
      flushSync(() => useEditorStore.setState(saved));
    }
  }

  // Keep the export-image handle fresh (needs stageRef).
  // Port of MainWindowMenus.cpp:97-201 — saves the canvas as a PNG.
  // Renders the whole map (content bounds + margin), not the viewport.
  exportImageRef.current = {
    render: ({ pixelRatio, transparent, size, antialias, watermark, regionStuds }) => {
      const stage = stageRef.current;
      if (!stage || !map) return null;
      const sidecar = readSidecarFromDoc(doc);
      const region = regionStuds ?? exportRegionStuds(map, sidecar, moduleNameBoxes(map, sidecar));
      return renderMapToCanvas(stage, map, sidecar, {
        pixelRatio,
        transparent,
        ...(size ? { size } : {}),
        ...(antialias !== undefined ? { antialias } : {}),
        ...(region ? { regionStuds: region } : {}),
        hudLayer: hudLayerRef.current,
        // Per-export option, desktop's "Embed general-info watermark".
        ...(watermark ? { watermark: watermarkText(map) } : {}),
      });
    },
    exportElectric: () => map?.exportInfo.exportElectricCircuit ?? false,
    setExportElectric: (on) => setExportElectricCircuit(doc, on),
    region: () => (map ? exportRegionStuds(map, readSidecarFromDoc(doc), moduleNameBoxes(map, readSidecarFromDoc(doc))) : null),
    screenRegion: () => screenRegion(),
    renderPicture: (spec, size) => renderPicture(spec, size),
    sceneSize: () => (map ? exportSceneSize(map, readSidecarFromDoc(doc), moduleNameBoxes(map, readSidecarFromDoc(doc))) : null),
  };

  // The Stage's own size (not a window estimate): World labels and
  // Insert Text land under its centre (mapToScene(viewport centre)).
  function stageCentreStuds(): { x: number; y: number } {
    const st = stageRef.current;
    return viewCentreStuds({ width: st?.width() ?? width, height: st?.height() ?? height });
  }

  canvasActionsRef.current = {
    cut: () => void cutSelection(),
    copy: () => void copySelection(),
    paste: () => void pasteAtCursor(),
    clipboardByTouch: (what) => void clipboardByTouch(what),
    delete: () => deleteSelection(),
    duplicate: (beside) => void duplicateSelection(beside),
    // Toolbar Rotate CCW / CW and Send to Back / Bring to Front
    // (MainWindow.cpp:733-742) — same actions as R / Shift+R and
    // Ctrl+Shift+[ / ].
    rotate: (cw) => {
      if (isViewer) return;
      rotatePicked(cw ? rotationStepDegrees : -rotationStepDegrees);
    },
    reorder: (to) => reorderPicked(to),
    group: () => {
      if (!isViewer) groupBricksAcrossLayers(doc, selectionByLayer());
    },
    ungroup: () => {
      if (!isViewer) ungroupSelection();
    },
    ungroupState: () => ungroupState(map, selection, canUngroupSet),
    selectConnected: () => selectConnected(),
    moveToSheet: (target) => moveSelectionToSheet(target),
    // View ▸ Zoom In / Zoom Out / Fit (MainWindowMenus.cpp:493-503).
    zoom: (factor) => {
      const live = useEditorStore.getState().zoom;
      useEditorStore.getState().zoomAround(live * factor, width / 2, height / 2);
    },
    fit: () => void fitToContent(),
    // Insert ▸ Text... at the view centre (MapView::addTextAtViewCenter).
    insertText: () => {
      if (isViewer) return;
      setAddTextAt(stageCentreStuds());
      setShowAddText(true);
    },
    viewCentre: () => stageCentreStuds(),
    screenRect: () => screenRegion(),
    goToView: (view) => {
      if (!map) return;
      useEditorStore.setState({
        viewFilter: { sheets: view.sheets, grid: view.grid, labels: view.labels },
        activeViewId: view.id,
      });
      const region = viewRegionStuds(view, map, readSidecarFromDoc(doc));
      const fit = fitView(region, width, height, { min: MIN_ZOOM, max: MAX_ZOOM }, phone ? (width > height ? PHONE_LANDSCAPE_FIT_INSETS : PHONE_FIT_INSETS) : undefined, phone ? 0 : undefined);
      if (fit) useEditorStore.setState(fit);
    },
    showViewFilter: (view) =>
      useEditorStore.setState({
        viewFilter: { sheets: view.sheets, grid: view.grid, labels: view.labels },
        activeViewId: view.id,
      }),
    clearView: () => useEditorStore.setState({ viewFilter: null, activeViewId: null }),
  };

  if (!map) return <EmptyDoc />;
  const shown = shownMap ?? map;
  const stageNode = (
    <Stage
      ref={stageRef}
      width={width}
      height={height}
      x={panX}
      y={panY}
      scaleX={zoom}
      scaleY={zoom}
      // No stage-level drag. Pan is middle-click only — matches desktop
      // MapView.cpp:446-451 + 649-657. Letting Konva drag the stage
      // would (a) hijack click+drag on bricks (their onDragEnd would
      // be ignored), and (b) bubble the brick's release coords up to
      // setPan, snapping the camera to wherever the brick landed.
      draggable={false}
      onWheel={(e) => {
        e.evt.preventDefault();
        // Wheel = zoom only, anchored under the cursor. Mirrors desktop
        // MapView::wheelEvent (MapView.cpp:354-390) + AnchorUnderMouse
        // (MapView.cpp:89): see wheelZoomStep.
        //
        // High-res trackpads emit wheel events at >60 Hz; processing
        // each one synchronously with a Yjs+catalog re-projection makes
        // the zoom feel choppy. Accumulate deltaY and apply once per
        // animation frame — same final zoom factor, far fewer renders.
        const stage = stageRef.current;
        if (!stage) return;
        const ptr = stage.getPointerPosition();
        if (!ptr) return;
        if (e.evt.deltaY === 0) return;
        viewMovingFor(200);

        const acc = zoomAccumRef.current;
        acc.deltaY += e.evt.deltaY;
        acc.ptrX = ptr.x;
        acc.ptrY = ptr.y;
        if (acc.raf !== null) return;

        acc.raf = requestAnimationFrame(() => {
          const a = zoomAccumRef.current;
          a.raf = null;
          if (a.deltaY === 0) return;
          const step = wheelZoomStep(a.deltaY, useEditorStore.getState().wheelZoomFactor);
          a.deltaY = 0;
          // Read the live zoom from the store at apply-time, not from
          // the closure — by now multiple frames may have elapsed.
          const live = useEditorStore.getState().zoom;
          useEditorStore.getState().zoomAround(live * step, a.ptrX, a.ptrY);
        });
      }}
      onMouseDown={handleStageMouseDown}
      onMouseMove={handleStageMouseMove}
      onMouseUp={handleStageMouseUp}
      onMouseLeave={handleStageMouseLeave}
      onContextMenu={(e) => {
        e.evt.preventDefault();
        // A long press by touch picks more parts instead (useTouchView).
        if (Date.now() - lastTouchAtRef.current < 1500) return;
        if (skipContextMenuRef.current) {
          skipContextMenuRef.current = false;
          return;
        }
        if (isViewer) return;
        if (tool === 'venueOutline' || tool === 'venueObstacle') {
          finishVenueDraft();
          return;
        }
        const stage = stageRef.current;
        if (!stage) return;
        const ptr = stage.getPointerPosition();
        if (!ptr) return;
        const studX = pxToStud((ptr.x - panX) / zoom);
        const studY = pxToStud((ptr.y - panY) / zoom);
        // Detect if any brick is under the cursor — if none, clicking on
        // empty canvas. Mirrors MapViewContextMenu.cpp:83-89 logic.
        const shapes = stage.getAllIntersections(ptr);
        const onBrick = shapes.some((s) => {
          const name = s.name?.() ?? '';
          return name.startsWith('brick-') || s.getAncestors?.().some?.((a: Konva.Node) => a.name?.()?.startsWith('brick-'));
        });
        // Detect text cell under cursor by AABB hit-test on the map.
        let textCellRef: TextCellRef | null = null;
        if (map) {
          outer: for (const layer of map.layers) {
            if (layer.type !== 'text' || !layer.visible) continue;
            for (let i = 0; i < layer.textCells.length; i++) {
              const cell = layer.textCells[i]!;
              const { x, y, width, height } = cell.displayArea;
              if (studX >= x && studX <= x + width && studY >= y && studY <= y + height) {
                textCellRef = { layerId: layer.id, cellIndex: i, cell };
                break outer;
              }
            }
          }
        }
        // The ruler under the cursor: the drawn one Konva hit (its line as
        // drawn, an attached end included), else by its box.
        let rulerRef: { item: import('@cld/model').RulerItem; layerId: string } | null = null;
        const hitRulerId = shapes
          .flatMap((s) => [s, ...(s.getAncestors?.() ?? [])])
          .map((n) => (n as Konva.Node).name?.() ?? '')
          .find((n) => n.startsWith('ruler-') && n !== 'ruler-endpoint' && n !== 'ruler-scale')
          ?.slice('ruler-'.length);
        if (map && hitRulerId) {
          for (const layer of map.layers) {
            if (layer.type !== 'ruler' || !layer.visible) continue;
            const item = layer.rulerItems.find((r) => r.id === hitRulerId);
            if (item) rulerRef = { item, layerId: layer.id };
          }
        }
        if (map && !rulerRef) {
          outerR: for (const layer of map.layers) {
            if (layer.type !== 'ruler' || !layer.visible) continue;
            for (const item of layer.rulerItems) {
              const { x, y, width, height } = item.displayArea;
              if (studX >= x && studX <= x + width && studY >= y && studY <= y + height) {
                rulerRef = { item, layerId: layer.id };
                break outerR;
              }
            }
          }
        }
        // Detect which brick (if any) is under the cursor by AABB hit-test.
        let brickIdUnderCursor: string | null = null;
        if (map && onBrick) {
          outerB: for (const layer of map.layers) {
            if (layer.type !== 'brick' || !layer.visible) continue;
            for (const b of layer.bricks) {
              const { x, y, width, height } = b.displayArea;
              if (studX >= x && studX <= x + width && studY >= y && studY <= y + height) {
                brickIdUnderCursor = b.id;
                break outerB;
              }
            }
          }
        }
        // Determine click position in client (viewport) coords for the
        // overlay div. getPointerPosition() is stage-local; convert.
        const rect = stage.container().getBoundingClientRect();
        // Right-clicking text or a ruler with no parts picked picks it, as
        // BlueBrick does, so the menu's Bring to Front acts on it.
        if (!onBrick && useEditorStore.getState().selection.length === 0 && (textCellRef || rulerRef)) {
          const key = textCellRef ? `${textCellRef.layerId}#${textCellRef.cellIndex}` : null;
          const anno = useEditorStore.getState().annoSelection;
          const already = key ? anno.texts.includes(key) : anno.rulers.includes(rulerRef!.item.id);
          if (!already) {
            useEditorStore.getState().setMixedSelection([], {
              rulers: key ? [] : [rulerRef!.item.id],
              labels: [],
              texts: key ? [key] : [],
            });
          }
        }
        setCtxMenu({ x: rect.left + ptr.x, y: rect.top + ptr.y, studX, studY, onBrick, textCellRef, rulerRef, brickIdUnderCursor });
      }}
      // A touch pans, pinches, taps or long-presses (useTouchView); it
      // doesn't start a marquee. "Select more" picks several by touch.
    >
      {/* Layer 1 — mostly-static background: grid, background image,
          venue outline, paint areas, electric circuits. Changing any of
          these redraws only this one canvas. Hit-testing is only enabled
          in editor mode (matching the venue overlay's own listening flag
          below) so double-click-to-edit on the venue outline works —
          Konva ANDs `listening` down the ancestor chain, so a hard
          `listening={false}` here would permanently defeat the child
          Group's `listening={!isViewer}`. */}
      <KonvaLayer name="background-layer" listening={!isViewer} perfectDrawEnabled={false}>
        {/* View-only (desktop paints it in drawBackground): hidden on export.
            It draws for whatever canvas it's drawn into, the moving
            picture's margin too (viewBitmap.ts); the cell-index labels are
            laid out for half a screen past each edge, for that margin. */}
        <Group name={`${EXPORT_HIDE} ${VIEW_LIVE}`} listening={false}>
          <GridLayer
            map={map}
            {...(viewFilter ? { showGrid: viewFilter.grid } : {})}
            cornerOverride={gridPreview}
            viewport={{
              studXMin: pxToStud((-width / 2 - panX) / zoom),
              studYMin: pxToStud((-height / 2 - panY) / zoom),
              studXMax: pxToStud((width * 1.5 - panX) / zoom),
              studYMax: pxToStud((height * 1.5 - panY) / zoom),
            }}
          />
        </Group>
        <BackgroundImageLayer doc={doc} />
        <Group listening={!isViewer}>
          {isViewer
            ? <VenueOverlay venue={readSidecarFromDoc(doc)?.venue ?? null} labelFontPx={venueLabelPx} />
            : <VenueOverlay venue={readSidecarFromDoc(doc)?.venue ?? null} labelFontPx={venueLabelPx} onDoubleClick={onOpenVenueProps} />}
        </Group>
        <AreaLayers map={areaShift ? shiftArea(shown, areaShift) : shown} isViewer={isViewer} />
        {showElectricCircuits && map && (
          <ElectricCircuitLayer map={shown} partsByKey={partsByKey} />
        )}
      </KonvaLayer>

      {/* Layer 2 — interactive content: bricks, text, rulers, labels.
          Hit-testing is enabled so clicks/drags on bricks and text work. */}
      <KonvaLayer ref={partsLayerRef} name="parts-layer" perfectDrawEnabled={false}>
        {!isViewer && tool === 'select' && (
          <BendHandles
            halo
            map={shown}
            doc={doc}
            selection={selection}
            partsByKey={partsByKey}
            modules={readSidecarFromDoc(doc)?.modules ?? NO_MODULES}
            editingModuleId={editingModuleId}
            touch={coarsePointer()}
          />
        )}
        <BrickLayer
          map={shown}
          doc={doc}
          isViewer={isViewer}
          onEditBrick={onEditBrick}
          onTurn={onTurnPart}
        />
        <Group listening={!isViewer && !editingModuleId}>
          <TextLayers
            map={shown}
            isViewer={isViewer}
            onEditText={(ref) => setEditingText(ref)}
            selectedKeys={selectedTextKeys}
            onSelectText={(key, additive) => selectAnno('texts', key, additive)}
            {...(!isViewer && tool === 'select' ? { drag: annoDrag } : {})}
          />
          <RulerLayers
            map={shown}
            isViewer={isViewer}
            partsByKey={partsByKey}
            selectedRulerIds={selectedRulerIds}
            handleRulerId={selection.length === 0 && annoCount(annoSelection) === 1 ? selectedRulerId : null}
            onRulerSelect={(id, additive) => selectAnno('rulers', id, additive)}
            {...(!isViewer && tool === 'select' ? { drag: annoDrag } : {})}
            onRulerDoubleClick={(id) => {
              const layer = map.layers.find(
                (l) => l.type === 'ruler' && l.rulerItems.some((r) => r.id === id),
              );
              if (!layer || layer.type !== 'ruler') return;
              const item = layer.rulerItems.find((r) => r.id === id);
              if (!item) return;
              selectAnno('rulers', id, false);
              setEditingRuler({ item, layerId: layer.id });
            }}
            onEndpointDrag={(rulerId, which, studX, studY, free) => {
              const layer = map.layers.find(
                (l) => l.type === 'ruler' && l.rulerItems.some((r) => r.id === rulerId),
              );
              if (!layer || layer.type !== 'ruler') return;
              // On the nearest grid point all the way, as the desktop (Alt: free).
              moveRulerEndpoint(doc, layer.id, rulerId, which, gridPointStuds({ x: studX, y: studY }, free));
            }}
            onScaleDrag={(rulerId, studX, studY) => {
              const layer = map.layers.find((l) => l.type === 'ruler' && l.rulerItems.some((r) => r.id === rulerId));
              if (!layer || layer.type !== 'ruler') return;
              // Not on the grid, as BlueBrick's ScaleRuler.
              scaleRuler(doc, layer.id, rulerId, { x: studX, y: studY });
            }}
          />
          {viewFilter && !viewFilter.labels ? null : isViewer
            ? <AnchoredLabels map={map} partsByKey={partsByKey} labels={readSidecarFromDoc(doc)?.anchoredLabels ?? []} modules={readSidecarFromDoc(doc)?.modules ?? NO_MODULES} zoom={zoom} />
            : <AnchoredLabels
                partsByKey={partsByKey}
                map={map}
                labels={readSidecarFromDoc(doc)?.anchoredLabels ?? []}
                modules={readSidecarFromDoc(doc)?.modules ?? NO_MODULES}
                zoom={zoom}
                onDoubleClick={setEditingLabel}
                selectedIds={selectedLabelIds}
                onSelect={(id, additive) => selectAnno('labels', id, additive)}
                {...(tool === 'select' ? { drag: annoDrag } : {})}
              />}
        </Group>
      </KonvaLayer>

      {/* Module outlines and names, and the parts being dragged: one layer
          (Konva wants 5 at most), off the parts layer, so a drag that moves
          them every frame (liveDragPose.ts) redraws only them, not every
          part on the map. The dragged parts move in above the outlines
          (BrickLayer's liftForDrag appends them). */}
      <KonvaLayer name={DRAG_LAYER} perfectDrawEnabled={false}>
        <Group name="module-overlay" listening={false}>
          <ModuleOverlay map={shown} modules={readSidecarFromDoc(doc)?.modules ?? NO_MODULES} />
        </Group>
      </KonvaLayer>

      {/* Bend handles' rings, above every part (the dragged ones too), on a
          layer of their own that redraws as their parts move. */}
      <KonvaLayer name="bend-layer" perfectDrawEnabled={false}>
        {!isViewer && tool === 'select' && (
          <BendHandles
            map={shown}
            doc={doc}
            selection={selection}
            partsByKey={partsByKey}
            modules={readSidecarFromDoc(doc)?.modules ?? NO_MODULES}
            editingModuleId={editingModuleId}
            touch={coarsePointer()}
          />
        )}
      </KonvaLayer>

      {/* Layer 3 — HUD overlays (no hit-testing): drag ghost, marquee,
          snap ring, ruler/venue drafts, remote cursors. */}
      <KonvaLayer ref={hudLayerRef} listening={false} perfectDrawEnabled={false}>
        {dropPart?.setBricks && (
          <ModuleGhost batches={[{ layerName: '', bricks: dropPart.setBricks }]} offset={{ dx: 0, dy: 0 }} partsByKey={partsByKey} />
        )}
        {dropPart && !dropPart.setBricks && (() => {
          // Snapped in the dragover handler, which keeps the drag's snap
          // session (hold, speed gate).
          const part = partsByKey.get(dropPart.key.toLowerCase()) ?? null;
          const at = dropPart.snapped ?? { centreX: dropPart.studX, centreY: dropPart.studY };
          return <PlaceGhost part={part} cursorStudX={at.centreX} cursorStudY={at.centreY} />;
        })()}
        {dropModule && dropModule.offset && moduleDragRef.current?.ready && (
          <ModuleGhost
            batches={placedModuleBatches(moduleDragRef.current.ready, dropModule.offset, partsByKey)}
            offset={{ dx: 0, dy: 0 }}
            partsByKey={partsByKey}
          />
        )}
        {editingModuleId && map && (
          <ModuleEditDim frame={editedModuleFrame(shown, readSidecarFromDoc(doc)?.modules ?? NO_MODULES, editingModuleId)} />
        )}
        <MarqueeOverlay marquee={marquee} />
        <SnapRing />
        <HingeLimits />
        {rulerDraft && <RulerDraftPreview draft={rulerDraft} />}
        <TouchRulerStart zoom={zoom} />
        {venueDraft && <VenueDraftPreview draft={venueDraft} />}
        <RemoteCursors awareness={awareness} map={map} zoom={zoom} />
      </KonvaLayer>
    </Stage>
  );

  function commitAddText(r: TextDialogResult) {
    // Like desktop's Insert Text (MapView::addTextAtScenePos): at the view
    // centre, or where "Add Text Here" was picked, on the first text
    // layer, in a box sized from the text and its Size.
    // Its middle on the grid, as the parts are.
    const target = gridPointStuds(addTextAt ?? viewCentreStuds({ width, height }));
    setAddTextAt(null);
    const layerId = ensureTextLayer(doc, activeLayerId);
    const box = newTextBox(r.text, r.fontSize, mapLineWidth(textFontStyle(r)));
    const styleParts: string[] = [];
    if (r.isBold) styleParts.push('Bold');
    if (r.isItalic) styleParts.push('Italic');
    addTextCell(doc, layerId, {
      centreX: target.x,
      centreY: target.y,
      widthStuds: box.width,
      heightStuds: box.height,
      text: r.text,
      font: { family: r.fontFamily, size: r.fontSize, style: styleParts.join(',') || 'Regular' },
      // Desktop's new text is the known color Black.
      fontColor: r.colorArgb.toUpperCase() === 'FF000000' ? { kind: 'known', name: 'Black' } : { kind: 'argb', argb: r.colorArgb },
      orientation: r.rotation,
    });
    announcePlacement([layerId], null, 'Your text');
    setShowAddText(false);
  }

  // The module the context menu is about: the part's under the pointer, or
  // a whole module that is the selection.
  const ctxModule = (() => {
    if (!ctxMenu) return null;
    const mods = readSidecarFromDoc(doc)?.modules ?? NO_MODULES;
    const byPart = moduleByPart(mods);
    if (ctxMenu.brickIdUnderCursor) return byPart.get(ctxMenu.brickIdUnderCursor) ?? null;
    const first = selection[0] ? byPart.get(selection[0]) : undefined;
    return first && first.members.length === selection.length && selection.every((id) => byPart.get(id)?.id === first.id) ? first : null;
  })();

  return (
    <>
      {stageNode}
      {pasteSpot && !isViewer && (
        <PasteHere
          at={pasteSpot}
          area={{ width, height }}
          onPaste={() => {
            setPasteSpot(null);
            void clipboardByTouch('paste', pasteSpot.studs);
          }}
          onClose={() => setPasteSpot(null)}
        />
      )}
      <ModuleEditBar doc={doc} awareness={awareness} />
      {lookModuleId && (
        <Suspense fallback={null}>
          <ModuleLookDialog doc={doc} moduleId={lookModuleId} onClose={() => setLookModuleId(null)} />
        </Suspense>
      )}
      <MapLoadingCard catalogLoading={catalog.isPending} />
      <Suspense fallback={null}>
      {editing && (
        <EditBrickDialog
          brick={editing.brick}
          layerId={editing.layerId}
          doc={doc}
          meta={editing.meta}
          onClose={() => setEditing(null)}
        />
      )}
      {editingRuler && (
        <EditRulerDialog
          item={editingRuler.item}
          layerId={editingRuler.layerId}
          doc={doc}
          onClose={() => setEditingRuler(null)}
        />
      )}
      {showAddText && (
        <TextDialog
          onClose={() => {
            setShowAddText(false);
            setAddTextAt(null);
          }}
          onCommit={commitAddText}
        />
      )}
      {editingText && (
        <TextDialog
          initial={editingText.cell}
          onClose={() => setEditingText(null)}
          onDelete={() => {
            deleteTextCell(doc, editingText.layerId, editingText.cellIndex);
            setSelection([]);
            setEditingText(null);
          }}
          onCommit={(r) => {
            const styleParts: string[] = [];
            if (r.isBold) styleParts.push('Bold');
            if (r.isItalic) styleParts.push('Italic');
            editTextCellFull(doc, editingText.layerId, editingText.cellIndex, {
              text: r.text,
              font: { family: r.fontFamily, size: r.fontSize, style: styleParts.join(',') || 'Regular' },
              fontColor: { kind: 'argb', argb: r.colorArgb },
              orientation: r.rotation,
            }, mapLineWidth(textFontStyle(r)));
            setEditingText(null);
          }}
        />
      )}
      {editingLabel && (
        <AddAnchoredLabelDialog
          doc={doc}
          defaultTargetId={null}
          initialLabel={editingLabel}
          onClose={() => setEditingLabel(null)}
        />
      )}
      </Suspense>
      <SetUpdatesBar updates={setUpdates} onUpdate={updatePlacedSets} onShow={showPlacedSets} top={phone} />
      {ctxMenu && !isViewer && (
        <CanvasContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          studX={ctxMenu.studX}
          studY={ctxMenu.studY}
          onBrick={ctxMenu.onBrick}
          selection={selection}
          map={map}
          doc={doc}
          activeLayerId={activeLayerId}
          undo={undo}
          onClose={() => setCtxMenu(null)}
          onCopy={() => void copySelection()}
          onCut={() => void cutSelection()}
          onPaste={() => void pasteAtCursor()}
          onDuplicate={() => void duplicateSelection()}
          onDelete={() => deleteSelection()}
          onRotateCCW={() => rotatePicked(-rotationStepDegrees)}
          onRotateCW={() => rotatePicked(rotationStepDegrees)}
          onBringToFront={() => reorderPicked('front')}
          onSendToBack={() => reorderPicked('back')}
          onMoveToSheet={(target) => moveSelectionToSheet(target)}
          onGroup={() => groupBricksAcrossLayers(doc, selectionByLayer())}
          onUngroup={() => ungroupSelection()}
          ungroup={ungroupState(map, selection, canUngroupSet)}
          setUpdate={(() => {
            const u = updateForSelection(map, setUpdates, selection);
            return u ? { name: u.name, onUpdate: () => updatePlacedSets([u]) } : null;
          })()}
          onSelectConnected={selectConnected}
          textCellRef={ctxMenu.textCellRef}
          rulerRef={ctxMenu.rulerRef}
          brickIdUnderCursor={ctxMenu.brickIdUnderCursor}
          selectedRulerId={selectedRulerId}
          onAttachRuler={(which) => {
            if (!ctxMenu.brickIdUnderCursor || !selectedRulerId || !map) return;
            const layer = map.layers.find(
              (l) => l.type === 'ruler' && l.rulerItems.some((r) => r.id === selectedRulerId),
            );
            if (!layer || layer.type !== 'ruler') return;
            attachRulerEndpoint(doc, layer.id, selectedRulerId, which, ctxMenu.brickIdUnderCursor);
          }}
          onEditText={(ref) => setEditingText(ref)}
          onAddTextHere={() => {
            // Prompt for the text first (desktop asks via its text dialog)
            // instead of dropping a placeholder "Text" cell.
            setAddTextAt({ x: ctxMenu.studX, y: ctxMenu.studY });
            setShowAddText(true);
          }}
          onProperties={() => {
            if (ctxMenu.textCellRef) {
              setEditingText(ctxMenu.textCellRef);
              return;
            }
            if (ctxMenu.rulerRef) {
              setEditingRuler(ctxMenu.rulerRef);
              return;
            }
            if (selection.length === 1 && map) {
              for (const layer of map.layers) {
                if (layer.type !== 'brick') continue;
                const b = layer.bricks.find((br) => br.id === selection[0]);
                if (b) {
                  const meta = partsByKey.get(b.partNumber.toLowerCase());
                  setEditing({ brick: b, layerId: layer.id, meta });
                  break;
                }
              }
            }
          }}
          onMakeModule={onMakeModule}
          module={ctxModule}
          editingModuleId={editingModuleId}
          onEditModule={(id) => enterModuleEdit(id)}
          onDoneEditing={leaveModuleEdit}
          onPinModule={(id, pinned) => setModulePinned(doc, id, pinned)}
          onModuleShowName={(id, show) => updateSidecarModule(doc, id, (m) => withShowName(m, show))}
          onModuleLook={(id) => setLookModuleId(id)}
        />
      )}
      {!isViewer && mapHasNoParts(map) && <EmptyMapHint touch={coarsePointer()} />}
      <ScaleBarHud zoom={zoom} right={phone && rowNumbersShown} />
      {budgetBox && <BudgetReachedDialog onClose={() => setBudgetBox(false)} />}
    </>
  );
}

/**
 * Screen space the phone fit keeps clear: a little air at the edges and
 * room for the scale card at the bottom. No scene margin on top of it, so
 * the layout fills the width (Town corner sat at 70% with the old margin).
 */
const PHONE_FIT_INSETS: ViewInsets = { top: 8, right: 8, bottom: 64, left: 8 };
/** Sideways the layout is height-bound and centred, clear of the card anyway. */
const PHONE_LANDSCAPE_FIT_INSETS: ViewInsets = { top: 8, right: 8, bottom: 8, left: 8 };

/** On a map with no parts yet: how to put the first one down. */
function EmptyMapHint({ touch }: { touch: boolean }) {
  return (
    <p
      data-testid="empty-map-hint"
      // By touch, below the Undo / Redo pill in the corner.
      className={`pointer-events-none absolute left-1/2 ${touch ? 'top-20' : 'top-3'} max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-card border border-line bg-panel/95 px-4 py-2 text-center text-sm text-ink shadow`}
    >
      {touch ? 'Tap Add part below to put down your first piece.' : 'Click a part in the Parts panel to add it, or drag it onto the map.'}
    </p>
  );
}

/**
 * Scale-bar HUD pinned to the lower-left corner of the canvas, like
 * desktop (MapViewPaint.cpp:195-243): a white pill with a bar of a
 * track-friendly stud count, labelled "N studs" above and mm / m below.
 */
function ScaleBarHud({ zoom, right = false }: { zoom: number; right?: boolean }) {
  const bar = scaleBar(zoom * 8); // 8 px per stud at zoom 1
  if (!bar) return null;
  // Fixed colors, not theme tokens: the card sits on the map, whose
  // background is the layout's own color in either theme. It keeps clear
  // of the phone's rounded corners and home bar (safe-area insets).
  return (
    <div
      data-testid="scale-bar"
      className="pointer-events-none absolute rounded-md border border-black/50 bg-white/95 px-3 py-0.5 text-[11px] leading-tight"
      style={{
        userSelect: 'none',
        width: bar.px + 24,
        color: '#1e2124',
        // On a phone the grid's row numbers fill the left edge after Fit, so
        // the card moves to the lower right, clear of them.
        ...(right ? { right: 'max(0.5rem, env(safe-area-inset-right))' } : { left: 'max(0.5rem, env(safe-area-inset-left))' }),
        // Above the touch bar while editing by touch.
        bottom: 'calc(0.5rem + var(--touch-bar-h, 0px))',
      }}
    >
      <div>{bar.primary}</div>
      <div className="relative my-0.5 h-2" style={{ width: bar.px }}>
        <div className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2" style={{ background: '#1e2124' }} />
        <div className="absolute left-0 top-0 h-2 w-0.5" style={{ background: '#1e2124' }} />
        <div className="absolute right-0 top-0 h-2 w-0.5" style={{ background: '#1e2124' }} />
      </div>
      <div>{bar.secondary}</div>
    </div>
  );
}

/**
 * Selection-aware right-click context menu — port of
 * MapViewContextMenu.cpp:39-244. Implemented as a fixed-position DOM
 * overlay (not a Konva layer) so it can hold interactive HTML elements
 * and receive keyboard focus for accessibility.
 */
function CanvasContextMenu({
  x, y, onBrick, selection, map, doc, undo,
  textCellRef, onEditText, rulerRef, brickIdUnderCursor, selectedRulerId, onAttachRuler,
  onClose, onCopy, onCut, onPaste, onDuplicate, onDelete,
  onRotateCCW, onRotateCW, onBringToFront, onSendToBack, onMoveToSheet,
  onGroup, onUngroup, ungroup, onSelectConnected, onAddTextHere, onProperties, onMakeModule,
  setUpdate,
  module, editingModuleId, onEditModule, onDoneEditing, onPinModule, onModuleShowName, onModuleLook,
}: {
  module: import('@cld/bbm').SidecarModule | null;
  editingModuleId: string | null;
  onEditModule: (id: string) => void;
  onDoneEditing: () => void;
  onPinModule: (id: string, pinned: boolean) => void;
  onModuleShowName: (id: string, show: boolean) => void;
  onModuleLook: (id: string) => void;
  x: number; y: number; studX: number; studY: number; onBrick: boolean;
  selection: string[]; map: import('@cld/model').BbmMap | null;
  doc: import('yjs').Doc; activeLayerId: string | null;
  undo: { canUndo: boolean; canRedo: boolean; undo: () => void; redo: () => void };
  textCellRef: TextCellRef | null;
  rulerRef: { item: import('@cld/model').RulerItem; layerId: string } | null;
  brickIdUnderCursor: string | null;
  selectedRulerId: string | null;
  onAttachRuler: (which: 0 | 1) => void;
  onEditText: (ref: TextCellRef) => void;
  onClose: () => void;
  onCopy: () => void; onCut: () => void; onPaste: () => void; onDuplicate: () => void;
  onDelete: () => void; onRotateCCW: () => void; onRotateCW: () => void;
  onBringToFront: () => void; onSendToBack: () => void;
  /** Move the selected parts to that part sheet, or (null) to a new one. */
  onMoveToSheet: (layerId: string | null) => void;
  onGroup: () => void; onUngroup: () => void; onSelectConnected: () => void;
  /** What Ungroup would do: nothing grouped (hidden), split, or only sets always used whole (greyed out). */
  ungroup: 'nothing' | 'splits' | 'whole';
  /** The picked placed set's set has changed since it was placed: offer to update it. */
  setUpdate: { name: string; onUpdate: () => void } | null;
  onAddTextHere: () => void; onProperties: () => void; onMakeModule: () => void;
}) {
  const libraryEntries = useLibraryEntries(doc);
  const hasSel = selection.length > 0;
  const singleSel = selection.length === 1;
  const multiSel = selection.length >= 2;

  // Close on outside click, scroll, or Escape.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const el = (e.target as HTMLElement).closest('[data-ctx-menu]');
      if (!el) onClose();
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    function onScroll() { onClose(); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, { capture: true });
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, [onClose]);

  // Clamp so menu stays inside the viewport.
  const menuW = 200;
  const menuH = 320;
  const left = Math.min(x, window.innerWidth - menuW - 4);
  const top = Math.min(y, window.innerHeight - menuH - 4);

  function item(label: string, handler: () => void, disabled = false) {
    return (
      <button
        key={label}
        disabled={disabled}
        onClick={() => { handler(); onClose(); }}
        className="w-full px-3 py-1 text-left text-xs hover:bg-neutral-700 disabled:opacity-35 disabled:cursor-default"
      >
        {label}
      </button>
    );
  }
  function sep(key: string) {
    return <div key={key} className="my-1 border-t border-border" />;
  }

  const entries: React.ReactNode[] = [];

  // A module: Edit module (or Done), Pin in place / Unpin, its look.
  if (editingModuleId) {
    entries.push(item('Done editing module', onDoneEditing));
    entries.push(sep('sm0'));
  } else if (module) {
    entries.push(
      <div key="mh" className="truncate px-3 pb-0.5 pt-1 text-[11px] uppercase tracking-wide text-muted">
        {module.name || 'Module'}
      </div>,
    );
    entries.push(item('Edit module', () => onEditModule(module.id)));
    entries.push(item(module.pinned ? 'Unpin' : 'Pin in place', () => onPinModule(module.id, !module.pinned)));
    entries.push(item(module.showName === false ? 'Show name' : 'Hide name', () => onModuleShowName(module.id, module.showName === false)));
    entries.push(item('Colors…', () => onModuleLook(module.id)));
    entries.push(sep('sm1'));
    for (const e of libraryEntries(module)) entries.push(item(e.label, e.onSelect, !!e.disabled));
    entries.push(sep('sm2'));
  }

  // A placed custom set whose set changed since: Update available.
  if (setUpdate) {
    entries.push(
      <div key="su" className="truncate px-3 pb-0.5 pt-1 text-[11px] uppercase tracking-wide text-muted">
        Update available
      </div>,
    );
    entries.push(item(`Update set “${setUpdate.name}”`, setUpdate.onUpdate));
    entries.push(sep('su1'));
  }

  // Ruler-attach flow: when a ruler is selected and the cursor is on a
  // brick, offer Attach Endpoint 1 / 2 (and Centre for circular).
  // Mirrors MapViewContextMenu.cpp:116-158.
  if (selectedRulerId && brickIdUnderCursor) {
    const selRuler = map?.layers
      .find((l) => l.type === 'ruler' && l.rulerItems.some((r) => r.id === selectedRulerId));
    const rulerItem = selRuler?.type === 'ruler'
      ? selRuler.rulerItems.find((r) => r.id === selectedRulerId)
      : undefined;
    if (rulerItem) {
      if (rulerItem.kind === 'linear') {
        entries.push(item('Attach Endpoint 1 to this brick', () => onAttachRuler(0)));
        entries.push(item('Attach Endpoint 2 to this brick', () => onAttachRuler(1)));
      } else {
        entries.push(item('Attach Centre to this brick', () => onAttachRuler(0)));
      }
      entries.push(sep('sa'));
    }
  }

  if (textCellRef) {
    entries.push(item('Edit Text…', () => onEditText(textCellRef)));
    entries.push(item('Properties…', () => onEditText(textCellRef)));
    entries.push(sep('s0'));
    if (!hasSel) {
      // Text and rulers turn too (BlueBrick RotateText, RotateRulers).
      entries.push(item('Turn left', onRotateCCW));
      entries.push(item('Turn right', onRotateCW));
      entries.push(sep('s0tx'));
      entries.push(item('Bring to front', onBringToFront));
      entries.push(item('Send to back', onSendToBack));
      entries.push(sep('s0t'));
    }
  } else if (rulerRef) {
    entries.push(item('Properties…', onProperties));
    // BlueBrick's Detach (MapPanel.cs): free each attached end from its part.
    const r = rulerRef.item;
    const detach = (label: string, which: 0 | 1) =>
      entries.push(item(label, () => attachRulerEndpoint(doc, rulerRef.layerId, r.id, which, '')));
    if (r.kind === 'linear') {
      if (r.attachedBrick1Id) detach('Detach Endpoint 1', 0);
      if (r.attachedBrick2Id) detach('Detach Endpoint 2', 1);
    } else if (r.attachedBrickId) {
      detach('Detach Centre', 0);
    }
    entries.push(sep('s0'));
    if (!hasSel) {
      // Text and rulers turn too (BlueBrick RotateText, RotateRulers).
      entries.push(item('Turn left', onRotateCCW));
      entries.push(item('Turn right', onRotateCW));
      entries.push(sep('s0rx'));
      entries.push(item('Bring to front', onBringToFront));
      entries.push(item('Send to back', onSendToBack));
      entries.push(sep('s0r'));
    }
  } else if (singleSel && onBrick) {
    entries.push(item('Properties…', onProperties));
    // BlueBrick's Use as Model: pick this part in the parts list.
    const partNumber = map?.layers.flatMap((l) => (l.type === 'brick' ? l.bricks : [])).find((b) => b.id === selection[0])?.partNumber;
    if (partNumber) entries.push(item('Use as Model', () => useEditorStore.getState().useAsModel(partNumber)));
    entries.push(sep('s0'));
  }

  if (hasSel) {
    entries.push(item('Turn left', onRotateCCW));
    entries.push(item('Turn right', onRotateCW));
    entries.push(sep('s1'));
    entries.push(item('Bring to front', onBringToFront));
    entries.push(item('Send to back', onSendToBack));
    entries.push(sep('s2'));
    // Parts can go to another part sheet (on top of what's there).
    if (map) {
      const sel = new Set(selection);
      const from = new Set(map.layers.filter((l) => l.type === 'brick' && l.bricks.some((b) => sel.has(b.id))).map((l) => l.id));
      if (from.size > 0) {
        const seen = new Map<string, number>();
        for (const l of map.layers) {
          if (l.type !== 'brick' || (from.size === 1 && from.has(l.id))) continue;
          const n = (seen.get(l.name) ?? 0) + 1;
          seen.set(l.name, n);
          entries.push(item(`Move to sheet “${displaySheetName(l.name)}”${n > 1 ? ` (${n})` : ''}`, () => onMoveToSheet(l.id)));
        }
        entries.push(item('Move to a new sheet', () => onMoveToSheet(null)));
        entries.push(sep('s2b'));
      }
    }
    if (multiSel) entries.push(item('Group', onGroup));
    if (ungroup === 'splits') entries.push(item('Ungroup', onUngroup));
    else if (ungroup === 'whole') entries.push(item('Ungroup (this set is always used whole)', onUngroup, true));
    entries.push(item('Select Connected', onSelectConnected));
    entries.push(sep('s3'));
    // Already one whole module: its own entries are above.
    if (!module || editingModuleId) {
      entries.push(item('Make a module…', onMakeModule));
      entries.push(sep('s3b'));
    }
    entries.push(item('Cut', onCut));
    entries.push(item('Copy', onCopy));
    entries.push(item('Duplicate', onDuplicate));
    entries.push(sep('s4'));
    entries.push(item('Delete', onDelete));
    entries.push(sep('s5'));
  }

  // Empty-area menu only, Paste only with something to paste
  // (MapViewContextMenu.cpp:183-203).
  if (!hasSel) {
    if (hasClipboardBricks()) entries.push(item('Paste', onPaste));
    entries.push(item('Add Text Here…', onAddTextHere));
    entries.push(sep('s6'));
  }
  entries.push(item('Undo', undo.undo, !undo.canUndo));
  entries.push(item('Redo', undo.redo, !undo.canRedo));

  return (
    <div
      data-ctx-menu="1"
      style={{ position: 'fixed', left, top, zIndex: 9999, minWidth: menuW }}
      className="flex flex-col rounded-lg border border-border bg-panel py-1 shadow-xl text-ink"
    >
      {entries}
    </div>
  );
}

/**
 * Snap feedback while dragging: a green ring on the target connection
 * when a connection snap holds, and an amber dot on the moving
 * connection that joins (or would join). Sizes are screen pixels, the
 * same at any zoom, and match the desktop (SelectionOverlay.cpp,
 * SnapMarks in SelectionStyle.h). Driven by editor-store `liveSnap` and
 * `snapMoving`.
 */
/** Measuring by touch: where the first tap put the ruler's start, until the second tap. */
function TouchRulerStart({ zoom }: { zoom: number }) {
  const at = useEditorStore((s) => s.touchRulerStart);
  if (!at) return null;
  const px = (n: number) => n / (zoom > 0 ? zoom : 1);
  return (
    <Circle
      name="touch-ruler-start"
      x={studToPx(at.x)}
      y={studToPx(at.y)}
      radius={px(9)}
      stroke="rgb(255,150,0)"
      strokeWidth={px(3)}
      fill="rgba(255,150,0,0.35)"
      listening={false}
      perfectDrawEnabled={false}
    />
  );
}

/** While bending flex track: an amber ring on each joint at its hinge limit (desktop paintBendHandles). */
function HingeLimits() {
  const points = useEditorStore((s) => s.hingeLimits);
  const zoom = useEditorStore((s) => s.stageView.zoom);
  if (points.length === 0) return null;
  const px = (n: number) => n / (zoom > 0 ? zoom : 1);
  return (
    <>
      {points.map((p, i) => (
        <Circle
          key={i}
          name="hinge-limit"
          x={studToPx(p.studX)}
          y={studToPx(p.studY)}
          radius={px(9)}
          stroke="#f59e0b"
          strokeWidth={px(2.5)}
          fill="rgba(245, 158, 11, 0.35)"
          listening={false}
          perfectDrawEnabled={false}
        />
      ))}
    </>
  );
}

function SnapRing() {
  const live = useEditorStore((s) => s.liveSnap);
  const moving = useEditorStore((s) => s.snapMoving);
  const zoom = useEditorStore((s) => s.stageView.zoom);
  if (!live && !moving) return null;
  const px = (n: number) => n / (zoom > 0 ? zoom : 1);
  return (
    <>
      {live && (
        <>
          <Circle
            x={studToPx(live.studX)}
            y={studToPx(live.studY)}
            radius={px(SNAP_MARKS.ringRadius + SNAP_MARKS.ringWidth)}
            stroke={SNAP_MARKS.halo}
            strokeWidth={px(SNAP_MARKS.haloWidth)}
            listening={false}
            perfectDrawEnabled={false}
          />
          <Circle
            name="snap-ring"
            x={studToPx(live.studX)}
            y={studToPx(live.studY)}
            radius={px(SNAP_MARKS.ringRadius)}
            stroke={SNAP_MARKS.ring}
            strokeWidth={px(SNAP_MARKS.ringWidth)}
            fill={SNAP_MARKS.ringFill}
            listening={false}
            perfectDrawEnabled={false}
          />
        </>
      )}
      {moving && (
        <Circle
          name="snap-moving"
          x={studToPx(moving.studX)}
          y={studToPx(moving.studY)}
          radius={px(SNAP_MARKS.dotRadius)}
          fill={SNAP_MARKS.dot}
          stroke={SNAP_MARKS.halo}
          strokeWidth={px(SNAP_MARKS.dotHaloWidth)}
          listening={false}
          perfectDrawEnabled={false}
        />
      )}
    </>
  );
}

/**
 * Header dropdown for re-showing hidden panels — minimal port of
 * desktop's View menu dock toggles (MainWindowMenus.cpp:505-516).
 * Always available, even when no panels are currently hidden, so the
 * affordance stays visible.
 */
// UI words: layers are "Sheets" (the ids stay).
const PANEL_TITLES: Record<string, string> = { parts: 'Parts', layers: 'Sheets', views: 'Views', usedparts: 'Parts list', modules: 'Modules', modlibrary: 'Module library', venuelibrary: 'Venue library' };

/**
 * Renders a vertical stack of panels in one dock column, with:
 *   - a column-resize Resizer on the column's outer edge (caller
 *     supplies it so left/right docks can wire opposite math)
 *   - a row-resize Resizer between every pair of stacked panels
 *
 * Panel sizing rule: the LAST panel in the column eats the residual
 * height (`flex-1`). Earlier panels honour their persisted
 * `panelHeights[id]` if set; otherwise they fall back to a content
 * size with a soft cap. This matches the desktop's QSplitter "the
 * bottom panel takes whatever space is left" convention.
 *
 * Dragging a divider works like a splitter (splitterHeights): only the
 * panels on either side of it change size; every other panel keeps the
 * height it has on screen.
 */
function DockColumn({
  panels,
  renderPanel,
  gridColumn,
  panelHeights,
  onResizePanel,
  edge,
  edgeSide,
}: {
  panels: string[];
  renderPanel: (id: string) => React.ReactNode;
  gridColumn: string;
  panelHeights: Record<string, number>;
  onResizePanel: (panelId: string, heightPx: number) => void;
  edge: React.ReactNode;
  edgeSide: 'start' | 'end';
}) {
  const slotRefs = useRef<(HTMLDivElement | null)[]>([]);
  // The divider under panel `i` moved to `clientY`.
  const dragDivider = (i: number, clientY: number) => {
    const els = slotRefs.current.slice(0, panels.length);
    if (els.some((e) => !e)) return;
    const heights = els.map((e) => e!.getBoundingClientRect().height);
    const top = els[i]!.getBoundingClientRect().top;
    const next = splitterHeights(heights, i, clientY - top);
    next.forEach((h, j) => onResizePanel(panels[j]!, h));
  };
  return (
    <div
      className="flex h-full flex-row overflow-hidden"
      style={{ gridColumn, gridRow: '3' }}
    >
      {edgeSide === 'start' && edge}
      <div className="flex h-full min-h-0 w-full flex-col">
        {panels.map((id, i) => {
          const isLast = i === panels.length - 1;
          const height = panelHeights[id];
          // Build the props with exactOptionalPropertyTypes-friendly
          // conditional spreads — `fixedHeightPx`/`onResize` only get
          // included when defined.
          const slotProps: {
            panelId: string;
            isLast: boolean;
            fixedHeightPx?: number;
            onResize?: (clientY: number) => void;
            slotRef: (el: HTMLDivElement | null) => void;
          } = { panelId: id, isLast, slotRef: (el) => { slotRefs.current[i] = el; } };
          if (!isLast && typeof height === 'number') slotProps.fixedHeightPx = height;
          if (!isLast) {
            slotProps.onResize = (clientY) => dragDivider(i, clientY);
          }
          return (
            <ResizableDockSlot key={id} {...slotProps}>
              {renderPanel(id)}
            </ResizableDockSlot>
          );
        })}
      </div>
      {edgeSide === 'end' && edge}
    </div>
  );
}

/**
 * Single slot in a dock column. Holds the panel content and (for non-
 * last slots) a row-axis Resizer at the bottom edge, which reports the
 * pointer's clientY to the column (DockColumn works out the sizes).
 */
function ResizableDockSlot({
  panelId,
  isLast,
  fixedHeightPx,
  onResize,
  slotRef,
  children,
}: {
  panelId: string;
  isLast: boolean;
  fixedHeightPx?: number;
  onResize?: (clientY: number) => void;
  slotRef: (el: HTMLDivElement | null) => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <div
        ref={slotRef}
        data-panel-id={panelId}
        className={
          'flex w-full min-h-0 flex-col overflow-hidden ' +
          (fixedHeightPx !== undefined ? '' : 'flex-1')
        }
        style={fixedHeightPx !== undefined ? { height: `${fixedHeightPx}px`, flex: 'none' } : undefined}
      >
        {children}
      </div>
      {!isLast && onResize && (
        <Resizer axis="row" onResize={onResize} />
      )}
    </>
  );
}

/**
 * Renders the sidecar background image as a Konva layer below all content.
 * Port of MapViewPaint.cpp:41-67: placed at its stored rect, or at native
 * size at the origin when there is none (see backgroundImageRectPx).
 */
function BackgroundImageLayer({ doc }: { doc: import('yjs').Doc }) {
  const bg = readSidecarFromDoc(doc)?.backgroundImage ?? null;
  // Only ever from this site: never an address on another host (background.ts).
  const src = bg ? sameOriginImageUrl(bg.url) : null;
  const [img, setImg] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!src) { setImg(null); return; }
    const el = new window.Image();
    el.onload = () => setImg(el);
    el.onerror = () => setImg(null);
    el.src = `${src}?t=${Date.now()}`;
  }, [src]);

  if (!bg || !img) return null;

  const r = backgroundImageRectPx(bg, { width: img.naturalWidth, height: img.naturalHeight });

  return (
    <Group listening={false}>
      <KonvaImage image={img} x={r.x} y={r.y} width={r.width} height={r.height} opacity={bg.opacity} listening={false} />
    </Group>
  );
}

/**
 * Live preview while drawing a linear/circular ruler. Renders the
 * pending shape AND a distance/radius readout right at the cursor so
 * the user knows the length before releasing — port of desktop's
 * preview path at MapView.cpp:824-875 and the addRulerLabel helper at
 * SceneBuilder.cpp:478-490.
 */
function RulerDraftPreview({
  draft,
}: {
  draft: { kind: 'linear' | 'circular'; startX: number; startY: number; curX: number; curY: number };
}) {
  const PX = 8;
  const ax = draft.startX * PX;
  const ay = draft.startY * PX;
  const bx = draft.curX * PX;
  const by = draft.curY * PX;
  if (draft.kind === 'linear') {
    const lenStuds = Math.hypot(draft.curX - draft.startX, draft.curY - draft.startY);
    const labelText = rulerPreviewLabel(lenStuds, false);
    return (
      <Group>
        <Line
          points={[ax, ay, bx, by]}
          stroke="rgb(255,150,0)"
          strokeWidth={2}
          dash={[6, 4]}
          listening={false}
        />
        <Text
          x={(ax + bx) / 2 + 8}
          y={(ay + by) / 2 - 16}
          text={labelText}
          fontFamily="Arial"
          fontSize={14}
          fontStyle="bold"
          fill="rgb(255,180,0)"
          stroke="rgba(0,0,0,0.5)"
          strokeWidth={2}
          fillAfterStrokeEnabled
          listening={false}
        />
      </Group>
    );
  }
  // Circular
  const rStuds = Math.hypot(draft.curX - draft.startX, draft.curY - draft.startY);
  const rPx = rStuds * PX;
  const labelText = rulerPreviewLabel(rStuds, true);
  return (
    <Group>
      <Circle
        x={ax}
        y={ay}
        radius={rPx}
        stroke="rgb(255,150,0)"
        strokeWidth={2}
        dash={[6, 4]}
        listening={false}
        fillEnabled={false}
      />
      <Text
        x={ax + rPx + 6}
        y={ay - 8}
        text={labelText}
        fontFamily="Arial"
        fontSize={14}
        fontStyle="bold"
        fill="rgb(255,180,0)"
        stroke="rgba(0,0,0,0.5)"
        strokeWidth={2}
        fillAfterStrokeEnabled
        listening={false}
      />
    </Group>
  );
}

function VenueDraftPreview({
  draft,
}: {
  draft: { kind: 'outline' | 'obstacle'; pts: { x: number; y: number }[]; curX: number; curY: number };
}) {
  const PX = 8;
  const color = draft.kind === 'outline' ? 'rgb(100,200,255)' : 'rgb(255,160,60)';
  // All committed vertices + the live cursor vertex
  const all = [...draft.pts, { x: draft.curX, y: draft.curY }];
  if (all.length < 2) return null;
  // Flat points array for Konva Line
  const points = all.flatMap((p) => [p.x * PX, p.y * PX]);
  // Closing segment from cursor back to first vertex
  const first = draft.pts[0];
  const closingPoints = first
    ? [draft.curX * PX, draft.curY * PX, first.x * PX, first.y * PX]
    : null;
  return (
    <Group>
      <Line
        points={points}
        stroke={color}
        strokeWidth={2}
        dash={[6, 4]}
        listening={false}
        perfectDrawEnabled={false}
      />
      {closingPoints && (
        <Line
          points={closingPoints}
          stroke={color}
          strokeWidth={1}
          dash={[3, 6]}
          opacity={0.5}
          listening={false}
          perfectDrawEnabled={false}
        />
      )}
      {draft.pts.map((p, i) => (
        <Circle
          key={i}
          x={p.x * PX}
          y={p.y * PX}
          radius={4}
          fill={color}
          listening={false}
          perfectDrawEnabled={false}
        />
      ))}
      <Text
        x={draft.curX * PX + 10}
        y={draft.curY * PX - 18}
        text={`${draft.pts.length} pts — Enter to commit, Esc to cancel`}
        fontFamily="Arial"
        fontSize={11}
        fill={color}
        listening={false}
        perfectDrawEnabled={false}
      />
    </Group>
  );
}

/**
 * The zoom as a percentage. It's written into the page straight from the
 * store, so a turn of the wheel or a pinch doesn't render the status bar
 * (which it did on every step).
 */
function ZoomPercent(props: { className?: string; 'aria-label'?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    let shown = '';
    const show = (zoom: number) => {
      const text = `${Math.round(zoom * 100)}%`;
      if (text === shown || !ref.current) return;
      shown = text;
      ref.current.textContent = text;
    };
    show(useEditorStore.getState().zoom);
    return useEditorStore.subscribe((s) => show(s.zoom));
  }, []);
  return <span ref={ref} data-testid="zoom-readout" {...props} />;
}

/**
 * Status bar at the bottom of the editor — minimal port of
 * MainWindow.cpp:861-1014's permanent widgets.
 *   - Mouse position in studs (clears on canvas-leave)
 *   - Selection count
 *   - Zoom percentage
 */
function StatusBar({ gridSpan, status, venue, budgetLimits, budgetMap, onZoomIn, onZoomOut, onFit, compact = false }: {
  gridSpan: number;
  /** Phone: just the piece count and big zoom buttons (no mouse, tool or sheet readouts). */
  compact?: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  status: import('./useLayoutDoc').SaveStatus;
  venue: import('@cld/bbm').Venue | null;
  budgetLimits: Map<string, number>;
  budgetMap: import('@cld/model').BbmMap | null;
}) {
  const studX = useEditorStore((s) => s.hudMouseStudX);
  const studY = useEditorStore((s) => s.hudMouseStudY);
  // Bricks plus selected rulers / labels / text cells (mixed selection).
  const selectionCount = useEditorStore((s) => s.selection.length + annoCount(s.annoSelection));
  // Which sheet the picked parts are on, so it's clear where they live.
  const selection = useEditorStore((s) => s.selection);
  const onSheets = budgetMap ? sheetsOfSelection(budgetMap, selection) : [];
  const sheetName = onSheets.length === 1 ? budgetMap?.layers.find((l) => l.id === onSheets[0])?.name : undefined;
  const tool = useEditorStore((s) => s.tool);
  const mapW = useEditorStore((s) => s.hudMapWidthStuds);
  const mapH = useEditorStore((s) => s.hudMapHeightStuds);
  const statusMessage = useEditorStore((s) => s.statusMessage);
  const dropTargetHint = useEditorStore((s) => s.dropTargetHint);
  const activeLayerId = useEditorStore((s) => s.activeLayerId);
  // Surfaced here so the active layer is visible even when the Layers
  // panel is collapsed or scrolled out of view (issue #61).
  const activeLayer = activeLayerId ? budgetMap?.layers.find((l) => l.id === activeLayerId) : null;
  // The status bar re-renders on every HUD mouse update; keep the
  // venue validation and the budget tally off that path.
  // Checked against the parts where a drag has them now (liveDragPose.ts),
  // so a warning shows (or clears) before the drop.
  const venueReadout = useLiveVenueReadout(venue, budgetMap ?? null);
  const budgetOver = useMemo(() => overBudgetCount(budgetMap, budgetLimits), [budgetMap, budgetLimits]);
  const dirty = status.kind === 'reconnecting' || status.kind === 'error';
  const pieces = useMemo(
    () => (budgetMap?.layers ?? []).reduce((n, l) => n + (l.type === 'brick' ? l.bricks.length : 0), 0),
    [budgetMap],
  );
  const zoomBtn = 'flex h-[26px] min-w-[26px] items-center justify-center rounded-md bg-soft px-1.5 text-ink hover:bg-neutral-700';
  if (compact) {
    const bigBtn = 'flex h-11 min-w-11 items-center justify-center rounded-control bg-soft px-2 text-base font-bold text-ink';
    return (
      <footer
        data-testid="status-bar"
        className="flex items-center justify-between gap-2 border-t border-line bg-panel px-3 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] text-sm text-muted"
        style={{ gridColumn: `span ${gridSpan}`, gridRow: '4' }}
      >
        {/* Stacked, so nothing gets cut short on a narrow phone. */}
        <span className="flex min-w-0 flex-col leading-tight">
          <span data-testid="piece-count" className="truncate">{pieces === 1 ? '1 piece' : `${pieces} pieces`}</span>
          {mapW !== null && mapH !== null && (
            <span className="truncate" title="Size of everything on the map">{studDisplay(mapW)} × {studDisplay(mapH)}</span>
          )}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <button type="button" aria-label="Zoom out" onClick={onZoomOut} className={bigBtn}>−</button>
          <ZoomPercent className="min-w-[3.25rem] text-center font-bold tabular-nums text-ink" aria-label="Zoom" />
          <button type="button" aria-label="Zoom in" onClick={onZoomIn} className={bigBtn}>+</button>
          <button type="button" title="Fit everything in view" onClick={onFit} className={bigBtn}>Fit</button>
        </div>
      </footer>
    );
  }
  return (
    <footer
      className="flex min-h-8 items-center justify-between gap-4 border-t border-line bg-panel px-4 py-0.5 text-xs text-muted"
      style={{ gridColumn: `span ${gridSpan}`, gridRow: '4' }}
    >
      <div className="flex min-w-0 items-center gap-4 overflow-hidden whitespace-nowrap">
        <span data-testid="piece-count">{pieces === 1 ? '1 piece' : `${pieces} pieces`}</span>
        {mapW !== null && mapH !== null && (
          <span title="Size of everything on the map">
            {studDisplay(mapW)} × {studDisplay(mapH)}
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <span title="Active sheet: new parts are placed here">
            Sheet:{' '}
            <span className={activeLayer ? 'text-ink' : 'text-neutral-600'}>
              {activeLayer ? (activeLayer.name ? displaySheetName(activeLayer.name) : 'unnamed') : 'none'}
            </span>
          </span>
          <HelpButton helpKey="status.sheet" />
        </span>
        <span>Tool: <span className="text-ink">{toolLabel(tool)}{dirty ? ' *' : ''}</span></span>
        {dropTargetHint || statusMessage ? (
          <span className="text-accent-text transition-opacity">{dropTargetHint ?? statusMessage}</span>
        ) : (
          // No mouse on a touch screen: nothing to read out.
          <span className="tabular-nums pointer-coarse:hidden">
            {studX !== null && studY !== null
              ? `Mouse: ${studX.toFixed(1)}, ${studY.toFixed(1)} st`
              : 'Mouse: —'}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3 whitespace-nowrap">
        {venueReadout && (
          // Desktop MainWindow.cpp:917-936: "Venue: OK" / "Venue: N issue(s)"
          // with the problems listed in the tooltip.
          <span className="flex items-center gap-1.5">
            <span
              data-testid="venue-status"
              title={venueReadout.tooltip}
              className={venueReadout.ok ? 'text-green-400' : 'font-semibold text-orange-400'}
            >
              {venueReadout.text}
            </span>
            <HelpButton helpKey="status.room" />
          </span>
        )}
        {budgetLimits.size > 0 && (
          <span className="flex items-center gap-1.5">
            <span className={budgetOver > 0 ? 'text-danger' : 'text-green-400'}
              title="Budget status">
              Budget: {budgetOver > 0 ? `${budgetOver} over` : 'OK'}
            </span>
            <HelpButton helpKey="status.budget" />
          </span>
        )}
        <span>
          {selectionCount === 0
            ? 'no selection'
            : `selected: ${selectionCount}`}
          {sheetName ? <span data-testid="status-sheet"> · on sheet “{sheetName}”</span> : onSheets.length > 1 ? <span data-testid="status-sheet"> · on {onSheets.length} sheets</span> : null}
        </span>
        <button type="button" aria-label="Zoom out" onClick={onZoomOut} className={zoomBtn}>−</button>
        <span className="font-bold tabular-nums text-ink">Zoom: <ZoomPercent /></span>
        <button type="button" aria-label="Zoom in" onClick={onZoomIn} className={zoomBtn}>+</button>
        <button type="button" title="Fit everything in view" onClick={onFit} className={`${zoomBtn} px-2.5 font-bold`}>Fit</button>
      </div>
    </footer>
  );
}

/**
 * The Map menu: File ▸, the layout, then Insert ▸, Modules & sets ▸, Venue ▸,
 * View ▸, Budget ▸, Download & export ▸ and Preferences (mapMenu.ts).
 * Grouped like desktop's menu bar (MainWindowMenus.cpp, MainWindowMapMenu.cpp).
 */
function MapMenu({
  moduleMode = false,
  onGeneralInfo,
  onBackgroundColor,
  onBackgroundImage,
  onFind,
  onExportImage,
  onExportCsv,
  onImportBbm,
  onCreateModule,
  onSaveAsSet,
  onInsertLabel,
  onInsertText,
  onZoomIn,
  onZoomOut,
  onFit,
  onDownloadLayout,
  onDownloadAs,
  onPreferences,
  onVenueProps,
  onVenueDesigner,
  onVenueDimensions,
  onVenueClear,
  onVenueDrawOutline,
  onVenueDrawObstacle,
  onVenueSaveToLibrary,
  onVenueExportFile,
  onVenueLoadFromFile,
  onBudget,
}: {
  onGeneralInfo: () => void;
  onBackgroundColor: () => void;
  onBackgroundImage: () => void;
  onFind: () => void;
  onExportImage: () => void;
  onExportCsv: () => void;
  onImportBbm: () => void;
  onCreateModule: () => void;
  onSaveAsSet: () => void;
  onInsertLabel: () => void;
  onInsertText: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onDownloadLayout: () => void;
  onDownloadAs: () => void;
  onPreferences: () => void;
  onVenueProps: () => void;
  onVenueDesigner: () => void;
  onVenueDimensions: () => void;
  onVenueClear: () => void;
  onVenueDrawOutline: () => void;
  onVenueDrawObstacle: () => void;
  onVenueSaveToLibrary: () => void;
  onVenueExportFile: () => void;
  onVenueLoadFromFile: () => void;
  onBudget: () => void;
  /** The module editor: no venue, budget or layout download. */
  moduleMode?: boolean;
}) {
  const toggles = useMapMenuToggles();
  const entries = resolveMenu(
    mapMenuEntries(
      {
        openFile: openFilePicker,
        generalInfo: onGeneralInfo,
        backgroundColor: onBackgroundColor,
        backgroundImage: onBackgroundImage,
        find: onFind,
        insertText: onInsertText,
        insertLabel: onInsertLabel,
        createModule: onCreateModule,
        saveAsSet: onSaveAsSet,
        importBbm: onImportBbm,
        venueDesigner: onVenueDesigner,
        venueDrawOutline: onVenueDrawOutline,
        venueDrawObstacle: onVenueDrawObstacle,
        venueDimensions: onVenueDimensions,
        venueProps: onVenueProps,
        venueSaveToLibrary: onVenueSaveToLibrary,
        venueExportFile: onVenueExportFile,
        venueLoadFromFile: onVenueLoadFromFile,
        venueClear: onVenueClear,
        zoomIn: onZoomIn,
        zoomOut: onZoomOut,
        fit: onFit,
        budget: onBudget,
        downloadLayout: onDownloadLayout,
        downloadAs: onDownloadAs,
        exportImage: onExportImage,
        exportCsv: onExportCsv,
        preferences: onPreferences,
      },
      toggles,
    ),
    { moduleMode },
  );
  return <Menu label="Map" entries={entries} buttonClassName="rounded-lg border border-border px-2 py-1 text-xs hover:bg-soft" />;
}

/** The Map menu's View ▸ and Budget ▸ ticks, from the editor store (the Map menu and the phone's). */
function useMapMenuToggles(): MapMenuToggles {
  const store = useEditorStore(
    useShallow((s) => ({
      showGrid: s.showGrid, setShowGrid: s.setShowGrid,
      showConnectionPoints: s.showConnectionPoints, setShowConnectionPoints: s.setShowConnectionPoints,
      showBrickHulls: s.showBrickHulls, setShowBrickHulls: s.setShowBrickHulls,
      showBrickElevation: s.showBrickElevation, setShowBrickElevation: s.setShowBrickElevation,
      showRulerAttachPoints: s.showRulerAttachPoints, setShowRulerAttachPoints: s.setShowRulerAttachPoints,
      alwaysShowConnections: s.alwaysShowConnections, setAlwaysShowConnections: s.setAlwaysShowConnections,
      showModuleNames: s.showModuleNames, setShowModuleNames: s.setShowModuleNames,
      showElectricCircuits: s.showElectricCircuits, setShowElectricCircuits: s.setShowElectricCircuits,
      showStatusBar: s.showStatusBar, setShowStatusBar: s.setShowStatusBar,
      useBudgetLimitation: s.useBudgetLimitation, setUseBudgetLimitation: s.setUseBudgetLimitation,
      showOnlyBudgetedParts: s.showOnlyBudgetedParts, setShowOnlyBudgetedParts: s.setShowOnlyBudgetedParts,
      showBudgetNumbers: s.showBudgetNumbers, setShowBudgetNumbers: s.setShowBudgetNumbers,
    })),
  );
  const toggle = (on: boolean, set: (v: boolean) => void) => ({ on, set });
  return {
    grid: toggle(store.showGrid, store.setShowGrid),
    connectionPoints: toggle(store.showConnectionPoints, store.setShowConnectionPoints),
    brickHulls: toggle(store.showBrickHulls, store.setShowBrickHulls),
    brickElevation: toggle(store.showBrickElevation, store.setShowBrickElevation),
    rulerAttachPoints: toggle(store.showRulerAttachPoints, store.setShowRulerAttachPoints),
    alwaysShowConnections: toggle(store.alwaysShowConnections, store.setAlwaysShowConnections),
    moduleNames: toggle(store.showModuleNames, store.setShowModuleNames),
    electricCircuits: toggle(store.showElectricCircuits, store.setShowElectricCircuits),
    statusBar: toggle(store.showStatusBar, store.setShowStatusBar),
    budgetLimit: toggle(store.useBudgetLimitation, store.setUseBudgetLimitation),
    budgetOnly: toggle(store.showOnlyBudgetedParts, store.setShowOnlyBudgetedParts),
    budgetNumbers: toggle(store.showBudgetNumbers, store.setShowBudgetNumbers),
  };
}

function LayersPanelHost({ doc, isViewer }: { doc: import('yjs').Doc; isViewer: boolean }) {
  // Re-renders on every Yjs update so layer ops (visibility, transparency,
  // rename, add, delete, move, name change) show immediately; the shared
  // cached projection means this costs no extra docToBbm.
  const map = useDocMap(doc);
  if (!map) return null;
  return <LayersPanel map={map} doc={doc} isViewer={isViewer} />;
}

function PanelsMenu({
  dock,
  onToggle,
}: {
  dock: import('./dockLayout').DockState;
  onToggle: (id: string, visible: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<React.CSSProperties>({});
  const button = useRef<HTMLButtonElement>(null);
  const allIds = Object.keys(PANEL_TITLES);
  // Esc closes it and gives the focus back to the button, like every other menu.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  return (
    <div className="relative">
      <button
        ref={button}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={(e) => {
          setAnchor(dropdownAnchor(e.currentTarget, window.innerWidth, 168));
          setOpen((v) => !v);
        }}
        className="rounded-lg border border-border px-2 py-1 text-xs hover:bg-soft"
        title="Toggle panels"
      >
        Panels
      </button>
      {open && (
        <>
          {/* Click-away backdrop */}
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <ul aria-label="Panels" className="fixed z-[45] min-w-[168px] rounded-lg border border-border bg-panel text-xs shadow-sm" style={anchor}>
            {allIds.map((id) => {
              const visible = dock.left.includes(id) || dock.right.includes(id) || dock.float.includes(id);
              return (
                <li key={id}>
                  <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-soft">
                    <input
                      type="checkbox"
                      checked={visible}
                      onChange={(e) => onToggle(id, e.target.checked)}
                      className="accent-accent"
                    />
                    {PANEL_TITLES[id] ?? id}
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * Paint color swatch — port of desktop's MainWindow toolbar color
 * button (MainWindow.cpp:578-845, "Paint color" entry): a color swatch
 * and an alpha slider. Stored value is AARRGGBB hex.
 */
function PaintColorPicker() {
  const value = useEditorStore((s) => s.paintColor);
  const set = useEditorStore((s) => s.setPaintColor);
  // Color and alpha, like desktop's paint color dialog (R6).
  return (
    <label className="flex items-center gap-1 text-xs text-muted" title="Paint color">
      <span>Color</span>
      <ColorAlphaInput compact label="Paint color" value={value} onChange={(v) => set(v.toUpperCase())} />
    </label>
  );
}

/**
 * Snap-step dropdown — port of desktop's PreferencesDialog combo
 * (PreferencesDialog.cpp:117-129). Same value list, same labels:
 * `[off, 32, 16, 8, 4, 2, 1, 0.5]` studs. The setting is local-only
 * (per-tab) for now; PLAN.md TBD whether to persist via cookie/localStorage.
 */
function SnapPicker() {
  const value = useEditorStore((s) => s.snapStepStuds);
  const set = useEditorStore((s) => s.setSnapStep);
  return (
    <label className="flex items-center gap-1 text-xs text-muted" title="Grid snap step (studs)">
      <span>Snap</span>
      <select
        value={value}
        onChange={(e) => set(parseFloat(e.target.value))}
        className="rounded-lg border border-border bg-panel px-1 py-0.5 text-xs"
      >
        {SNAP_STEPS.map((s) => (
          <option key={s} value={s}>
            {s === 0 ? 'off' : s}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Rotation-step dropdown — port of desktop's rotation-step submenu
 * (MainWindowMenus.cpp:403-415). Controls R / Shift+R step.
 */
function RotationPicker() {
  const value = useEditorStore((s) => s.rotationStepDegrees);
  const set = useEditorStore((s) => s.setRotationStep);
  return (
    <label className="flex items-center gap-1 text-xs text-muted" title="Turn step (degrees)">
      <span>Turn</span>
      <select
        value={value}
        onChange={(e) => set(parseFloat(e.target.value))}
        className="rounded-lg border border-border bg-panel px-1 py-0.5 text-xs"
      >
        {ROTATION_STEPS.map((s) => (
          <option key={s} value={s}>
            {s}°
          </option>
        ))}
      </select>
    </label>
  );
}


/**
 * Signed out while the layout was open (a sign-out in another browser, a
 * sign-in that ran out): it stays open, read only, behind this card, and
 * nothing is lost. Signing in again, in another tab, picks up where it
 * left off: this page notices (when it's looked at again, when the browser
 * comes back online, and now and then while it's visible; see
 * signedOutPoll.ts) and sends what wasn't sent.
 */
function SignedOutCard({ what, reconnect }: { what: 'layout' | 'module'; reconnect: (() => void) | undefined }) {
  const qc = useQueryClient();
  const here = `${window.location.pathname}${window.location.search}`;
  useEffect(
    () =>
      startSignedOutPoll({
        check: async () => !!(await api.me().catch(() => null))?.user,
        onSignedIn: () => {
          void qc.invalidateQueries();
          reconnect?.();
        },
      }),
    [qc, reconnect],
  );
  return (
    <div className="pointer-events-none fixed inset-x-0 top-16 z-40 flex justify-center px-4">
      <div role="alert" data-testid="signed-out" className="pointer-events-auto w-full max-w-md rounded-card border border-line bg-panel p-4 text-sm text-ink shadow-pop">
        <p className="font-semibold">You were signed out</p>
        <p className="mt-1 text-muted">
          {`Your changes can't be saved until you sign in again, so this ${what} is read only for now. Nothing is lost: sign in, and it picks up where you left off.`}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <a
            href={`/login?next=${encodeURIComponent(here)}`}
            target="_blank"
            rel="noopener"
            className="tap-target inline-flex items-center rounded-lg bg-accent px-3 py-1.5 font-semibold text-accent-ink hover:bg-accent-hover"
          >
            Sign in (opens a new tab)
          </a>
        </div>
      </div>
    </div>
  );
}

/** Said when someone's access changes while the layout is open (the desktop says the same). */
export function accessChangedText(nowViewer: boolean, title: string | undefined, what: 'layout' | 'module'): string {
  const name = title ? `“${title}”` : `this ${what}`;
  return nowViewer
    ? `You can only view this ${what} now. Your access to ${name} changed to view only, so changes can't be made here. Ask its owner, or a club admin, if you need to edit it.`
    : `You can edit this ${what} now. Your access to ${name} changed: your changes go to everyone again.`;
}

/** While the layout is open: say so when the owner lowers or raises this person's access. */
function useAccessChangeNotice(role: 'owner' | 'editor' | 'viewer' | undefined, title: string | undefined, moduleMode: boolean): void {
  const was = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (role === undefined) return;
    const viewer = role === 'viewer';
    const before = was.current;
    was.current = viewer;
    if (before === undefined || before === viewer) return;
    useEditorStore.getState().showNotice(accessChangedText(viewer, title, moduleMode ? 'module' : 'layout'), viewer ? 'error' : 'done', 12000);
  }, [role, title, moduleMode]);
}

function ErrorScreen({ err, what }: { err: Error; what: 'layout' | 'module' }) {
  const signIn = err.message === SIGN_IN_TO_OPEN;
  const here = `${window.location.pathname}${window.location.search}`;
  return (
    <div className="grid h-screen place-items-center p-4">
      <div role="alert" className="max-w-sm rounded-lg border border-red-900 bg-red-950/30 p-4 text-sm">
        <p className="font-semibold text-danger">
          {signIn
            ? `Sign in to open this ${what}`
            : err.message === MERGE_REFUSED
              ? 'Your changes weren’t sent'
              : err.message === DEMO_WAS_RESET
                ? 'The demo was reset'
                : `Couldn't open this ${what}`}
        </p>
        <p className="mt-2 text-neutral-300">{err.message}</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {signIn && (
            <Link to={`/login?next=${encodeURIComponent(here)}`} className="rounded-lg bg-accent px-3 py-1.5 text-accent-ink hover:bg-accent-hover">
              Sign in
            </Link>
          )}
          <Link to="/" className="text-accent-text hover:underline">
            ← Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}

function EmptyDoc() {
  return (
    <div className="absolute inset-0 grid place-items-center text-muted">
      <div className="text-center">
        <p>This layout has no map yet.</p>
        <p className="text-sm">Open a <code>.bld-layout</code> or <code>.bbm</code> file from the Layouts list to fill it.</p>
      </div>
    </div>
  );
}

function HeaderEditButtons({
  saveNow,
  canvasActionsRef,
  touch = false,
}: {
  saveNow: () => Promise<void> | void;
  canvasActionsRef: React.MutableRefObject<CanvasActions | null>;
  /** A touch screen: the touch bar has the picked parts' buttons (and Paste), so they aren't here twice. */
  touch?: boolean;
}) {
  const selection = useEditorStore((s) => s.selection);
  const annoTotal = useEditorStore((s) => annoCount(s.annoSelection));
  const hasSel = selection.length > 0;
  const btnCls = 'shrink-0 whitespace-nowrap rounded-lg border border-border px-2 py-1 text-xs hover:bg-soft disabled:opacity-30 disabled:cursor-default';
  const act = () => canvasActionsRef.current;
  return (
    <>
      <div className="h-4 w-px bg-neutral-700" />
      <button onClick={() => void saveNow()} title="Save (Ctrl+S)" className={btnCls}>
        Save
      </button>
      {!touch && (
      <>
      <div className="h-4 w-px bg-neutral-700" />
      <button onClick={() => act()?.cut()} disabled={!hasSel} title="Cut (Ctrl+X)" className={btnCls}>
        Cut
      </button>
      <button onClick={() => act()?.copy()} disabled={!hasSel} title="Copy (Ctrl+C)" className={btnCls}>
        Copy
      </button>
      <button onClick={() => act()?.paste()} title="Paste (Ctrl+V)" className={btnCls}>
        Paste
      </button>
      <button
        onClick={() => act()?.delete()}
        disabled={!hasSel && annoTotal === 0}
        title="Delete (Del)"
        className={btnCls + ' hover:bg-red-900/40'}
      >
        Delete
      </button>
      {/* Rotate + z-order, as on the desktop toolbar (MainWindow.cpp:733-742). */}
      <div className="h-4 w-px bg-neutral-700" />
      <button onClick={() => act()?.rotate(false)} disabled={!hasSel} title="Turn left (R)" aria-label="Turn left" className={btnCls}>
        ⟲
      </button>
      <button onClick={() => act()?.rotate(true)} disabled={!hasSel} title="Turn right (Shift+R)" aria-label="Turn right" className={btnCls}>
        ⟳
      </button>
      <button onClick={() => act()?.reorder('back')} disabled={!hasSel} title="Send to back (Ctrl+Shift+[)" aria-label="Send to back" className={btnCls + ' whitespace-nowrap'}>
        Send to back
      </button>
      <button onClick={() => act()?.reorder('front')} disabled={!hasSel} title="Bring to front (Ctrl+Shift+])" aria-label="Bring to front" className={btnCls + ' whitespace-nowrap'}>
        Bring to front
      </button>
      </>
      )}
    </>
  );
}

/**
 * Build a brick-id adjacency map from connexion data.
 *
 * `Connexion.linkedTo` stores the **connexion id** of the partner (e.g.
 * `"brickA_0"`), NOT the brick id. We need a connexion-id → brick-id
 * lookup to resolve it, then build brick→brick edges.
 */
/** No parts on any sheet yet (a new layout). */
function mapHasNoParts(map: import('@cld/model').BbmMap | null | undefined): boolean {
  return !!map && !map.layers.some((l) => l.type === 'brick' && l.bricks.length > 0);
}

function buildConnectedAdj(map: import('@cld/model').BbmMap): Map<string, string[]> {
  // Pass 1: connexion id → brick id
  const connToBrick = new Map<string, string>();
  for (const layer of map.layers) {
    if (layer.type !== 'brick') continue;
    for (const b of layer.bricks) {
      for (const cx of b.connexions) {
        connToBrick.set(cx.id, b.id);
      }
    }
  }
  // Pass 2: build brick → [brick] adjacency
  const adj = new Map<string, string[]>();
  for (const layer of map.layers) {
    if (layer.type !== 'brick') continue;
    for (const b of layer.bricks) {
      for (const cx of b.connexions) {
        if (!cx.linkedTo) continue;
        const partnerId = connToBrick.get(cx.linkedTo);
        if (!partnerId || partnerId === b.id) continue;
        if (!adj.has(b.id)) adj.set(b.id, []);
        adj.get(b.id)!.push(partnerId);
      }
    }
  }
  return adj;
}

/** Module frames and names as drawn now (none when View ▸ Module names is off), in studs. */
function moduleNameBoxes(map: import('@cld/model').BbmMap, sidecar: import('@cld/bbm').Sidecar | null | undefined): StudRect[] {
  const names = moduleNamesShown();
  return names && sidecar?.modules?.length ? moduleLabelBoundsStuds(map, sidecar.modules, names.percent, names.measure) : [];
}

// Saved views fit module names the way the map draws them.
setModuleNamesSource(() => {
  const s = useEditorStore.getState();
  return s.showModuleNames ? { percent: s.moduleLabelPercent, measure: measureBold } : null;
});

/** The .bbm alone, for BlueBrick: labels, modules, venue and background stay behind. */
async function downloadLocalBbm(doc: Y.Doc, title: string): Promise<void> {
  try {
    saveFile({ filename: `${sanitizeFilename(title)}.bbm`, type: 'application/xml', data: new TextEncoder().encode(writeBbm(docToBbm(doc))) });
  } catch (e) {
    useEditorStore.getState().showNotice(`Couldn’t make the .bbm: ${(e as Error).message}`, 'error', 10000);
  }
}

/** The part sheets (ids) that hold any of the selected parts. */
function sheetsOfSelection(map: import('@cld/model').BbmMap, selection: readonly string[]): string[] {
  if (selection.length === 0) return [];
  const sel = new Set(selection);
  return map.layers.filter((l) => l.type === 'brick' && l.bricks.some((b) => sel.has(b.id))).map((l) => l.id);
}

/** Keyboard / View-menu zoom step (desktop MainWindowMenus.cpp:493-498). */
const ZOOM_STEP = 1.2;

/**
 * After a long press on empty map by touch: "Paste here", by the finger,
 * kept inside the map. A tap anywhere else on the map closes it.
 */
function PasteHere({ at, area, onPaste, onClose }: {
  at: { x: number; y: number };
  area: { width: number; height: number };
  onPaste: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Above the finger, so it isn't hidden under it; inside the map's edges.
  const w = 196;
  const left = Math.max(8, Math.min(at.x - w / 2, area.width - w - 8));
  const top = Math.max(8, at.y - 76);
  return (
    <div
      role="dialog"
      aria-label="Paste here"
      data-testid="paste-here"
      data-no-gesture
      className="absolute z-20 flex items-center gap-1 rounded-control border border-line bg-panel p-1 shadow-pop"
      style={{ left, top, width: w }}
    >
      <button
        type="button"
        onClick={onPaste}
        className="flex min-h-12 flex-1 items-center justify-center rounded-control bg-accent px-3 text-base font-bold text-accent-ink hover:bg-accent-hover"
      >
        Paste here
      </button>
      <button type="button" aria-label="Close" onClick={onClose} className="flex min-h-12 min-w-11 items-center justify-center rounded-control text-lg font-bold hover:bg-soft">
        ×
      </button>
    </div>
  );
}

/** Imperative canvas actions shared with the header toolbar and menus. */
interface CanvasActions {
  cut: () => void;
  copy: () => void;
  paste: () => void;
  /** Copy, Cut or Paste (in the middle of the view) by touch, with a notice saying what happened. */
  clipboardByTouch: (what: 'copy' | 'cut' | 'paste') => void;
  delete: () => void;
  /** Duplicate the selection: under the cursor, or `beside` the original (touch). */
  duplicate: (beside?: boolean) => void;
  rotate: (cw: boolean) => void;
  reorder: (to: 'front' | 'back') => void;
  /** Group the picked parts (one undo step). */
  group: () => void;
  /** Ungroup them, keeping whole the sets that are always used whole. */
  ungroup: () => void;
  /** What Ungroup would do with what's picked. */
  ungroupState: () => 'nothing' | 'splits' | 'whole';
  /** Also pick every part connected to the picked ones. */
  selectConnected: () => void;
  /** Move the selected parts to that part sheet, or (null) to a new one. One undo step. */
  moveToSheet: (sheetId: string | null) => void;
  zoom: (factor: number) => void;
  fit: () => void;
  insertText: () => void;
  /** World-stud position under the centre of the canvas stage. */
  viewCentre: () => { x: number; y: number };
  /** The part of the map on screen now, in studs. */
  screenRect: () => StudRect | null;
  /** Show a saved view: its sheets, grid and labels, fitted to its area. */
  goToView: (view: SavedView) => void;
  /** Show a view's sheets, grid and labels, leaving the map where it is. */
  showViewFilter: (view: SavedView) => void;
  /** Back to the layout as it is (every sheet as the layout has it). */
  clearView: () => void;
}

/**
 * Saved views in the layout-name menu, for anyone without the Views panel
 * (viewers, phones): pick one to see it, or share a picture.
 */
function ViewsMenuItems({
  views,
  activeViewId,
  onGoTo,
  onWhole,
  onSharePicture,
  phone,
}: {
  views: readonly SavedView[];
  activeViewId: string | null;
  onGoTo: (v: SavedView) => void;
  onWhole: () => void;
  onSharePicture: () => void;
  phone?: boolean;
}) {
  const item = `flex w-full items-center gap-2 px-3.5 text-left hover:bg-soft ${phone ? 'min-h-11 py-2' : 'py-2'}`;
  return (
    <div role="group" aria-label="Views" className="border-y border-line py-1">
      <p className="px-3.5 pb-0.5 pt-1 text-xs font-bold uppercase tracking-wide text-muted">Views</p>
      <button role="menuitemradio" aria-checked={activeViewId === null} type="button" onClick={onWhole} className={item}>
        <span className="w-4 text-accent-text">{activeViewId === null ? '✓' : ''}</span>
        Whole layout
      </button>
      {views.map((v) => (
        <button key={v.id} role="menuitemradio" aria-checked={activeViewId === v.id} type="button" onClick={() => onGoTo(v)} className={item}>
          <span className="w-4 text-accent-text">{activeViewId === v.id ? '✓' : ''}</span>
          <span className="min-w-0 truncate">{v.name || 'View'}</span>
        </button>
      ))}
      <button role="menuitem" type="button" onClick={onSharePicture} className={`${item} font-bold`}>
        <PictureIcon />
        Share picture…
      </button>
    </div>
  );
}

/** The map with one area sheet's cells shown shifted (a MoveArea drag). */
function shiftArea(map: import('@cld/model').BbmMap, shift: { layerId: string; dx: number; dy: number }): import('@cld/model').BbmMap {
  return {
    ...map,
    layers: map.layers.map((l) =>
      l.type === 'area' && l.id === shift.layerId
        ? { ...l, areas: l.areas.map((c) => ({ ...c, x: c.x + shift.dx, y: c.y + shift.dy })) }
        : l,
    ),
  };
}

/** The canvas font style of a text's Bold / Italic, for measuring its box. */
function textFontStyle(r: { isBold: boolean; isItalic: boolean }): string {
  return [r.isItalic ? 'italic' : '', r.isBold ? 'bold' : ''].filter(Boolean).join(' ') || 'normal';
}
