import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Circle, Group, Image as KonvaImage, Line, Rect, Shape, Text as KonvaText } from 'react-konva';
import * as Y from 'yjs';
import type { KonvaEventObject } from 'konva/lib/Node';
import type Konva from 'konva';
import type { BbmMap, Brick, LayerBrick } from '@cld/model';
import { useQuery } from '@tanstack/react-query';
import { api, spriteUrlFor, type PartWire } from '../../api';
import { shapeSelectionIds, useEditorStore, type AnnoSelection, type Tool } from '../editorStore';
import { groupMembersOf } from '../sets';
import { brickDrag } from '../brickDrag';
import { connectionHingeAngle } from '@cld/parts-catalog/browser';
import { useShallow } from 'zustand/react/shallow';
import { readSidecarFromDoc } from '@cld/ydoc';
import {
  bricksByLayer,
  deleteBricks,
  moveBrick,
  moveBrickAndOrient,
  setActiveConnectionPoint,
} from '../mutations';
import { annoCount, deleteMixedSelection, translateMixedSelection } from '../mixedSelection';
import { LOCAL_ORIGIN } from '../useLayoutDoc';
import { studToPx } from './coords';
import { unknownPartLook } from './unknownPart';
import { MAP_FONT_STACK, MAP_LINE_HEIGHT } from './mapText';
import { ensureSprite, getSpriteSync, onSpriteReady } from './spriteCache';
import { tracePickShape } from './pickShape';
import { linkKeys, liveDragSnap, nearestConnectionIndex, type DragSnapResult } from '../snap';
import { grabSnapCorner } from '../gridSnap';
import { SnapSession, applyGroupTurn, holdReach, snapBypassed, type GroupTurn } from '../snapFeel';
import { snapTraceEnabled, traceFrame, traceStart } from '../snapTrace';
import { liveSnapReach } from '../liveSnapReach';
import { annoNodeNames, collectNodes, restoreNodes, shiftNodes, type NodeSnap } from './groupDragNodes';
import { EXPORT_HIDE } from '../exportRender';
import { indexParts } from '../partIndex';
import { pivotOf } from '../brickGeometry';
import { startFlexSession } from '../flexSession';
import { SELECTION } from './selectionStyle';
import { drawSelection, SELECTION_OVERLAY, type GlyphInfo } from './SelectionOverlay';
import { useLiveDragPose, type DragPose } from '../liveDragPose';
import { isTouchEvent, tapGuard } from '../touchGesture';
import type { SidecarModule } from '@cld/bbm';
import { boundsOf, canDragPart, moduleByPart, outsideEdit, outsideOutline, pinnedAmong, selectionUnit, type StudRect } from '../moduleEdit';
import { enterModuleEdit, leaveModuleEdit, takeOutOfModule, tellPinned } from '../moduleActions';
import { askConfirm } from '../../ui/ConfirmDialog';
import { useYjsSnapshot } from '../useYjsSnapshot';
import { SHEET_FADE } from './sheetFade';
import { useSheetFade } from './useSheetFade';

/**
 * The picked rulers and labels a drag shifts along: not those fixed to a
 * dragged part, which the live pose already moves.
 */
export function ridingAnno(
  anno: AnnoSelection,
  moving: ReadonlySet<string>,
  map: BbmMap,
  labels: readonly { id: string; kind: number; targetId: string }[],
): AnnoSelection {
  const fixedLabels = new Set(labels.filter((l) => l.kind === 1 && moving.has(l.targetId)).map((l) => l.id));
  const fixedRulers = new Set<string>();
  for (const layer of map.layers) {
    if (layer.type !== 'ruler') continue;
    for (const r of layer.rulerItems) {
      const ends = r.kind === 'linear' ? [r.attachedBrick1Id, r.attachedBrick2Id] : [r.attachedBrickId];
      if (ends.some((id) => id && moving.has(id))) fixedRulers.add(r.id);
    }
  }
  return { ...anno, labels: anno.labels.filter((id) => !fixedLabels.has(id)), rulers: anno.rulers.filter((id) => !fixedRulers.has(id)) };
}

/** The Konva layer the dragged parts move to for the drag (EditorPage). */
export const DRAG_LAYER = 'drag-layer';

/**
 * Lifts the dragged parts' nodes onto the drag layer, so a drag frame
 * redraws only them (a big layout has a thousand parts on its layer).
 * Returns how to put them back where they were, in their order.
 */
export function liftForDrag(nodes: readonly Konva.Node[]): () => void {
  const stage = nodes[0]?.getStage();
  const layer = stage?.findOne(`.${DRAG_LAYER}`) as Konva.Layer | undefined;
  if (!layer) return () => undefined;
  const was = nodes
    .map((node) => ({ node, parent: node.getParent(), z: node.zIndex() }))
    .filter((w): w is { node: Konva.Node; parent: NonNullable<typeof w.parent>; z: number } => !!w.parent);
  const layers = new Set(was.map((w) => w.node.getLayer()).filter((l): l is Konva.Layer => !!l));
  // The selection overlay draws only the parts on its own layer: the drag
  // layer gets a copy, above the parts, for the ones that move there.
  const overlay = [...layers].map((l) => l.findOne<Konva.Shape>(`.${SELECTION_OVERLAY}`)).find((n) => !!n);
  for (const w of was) w.node.moveTo(layer);
  const overlayCopy = overlay?.clone() as Konva.Shape | undefined;
  if (overlayCopy) layer.add(overlayCopy);
  return () => {
    overlayCopy?.destroy();
    for (const w of [...was].sort((a, b) => a.z - b.z)) {
      if (w.node.getParent() !== layer) continue; // gone meanwhile
      w.node.moveTo(w.parent);
      w.node.zIndex(Math.min(w.z, w.parent.getChildren().length - 1));
    }
    for (const l of layers) l.batchDraw();
    layer.batchDraw();
  };
}

/** How long the live pose stays after a drop, while the layout redraws with the parts in place (ms). */
const POSE_LINGER_MS = 1000;

/** How long a fast drag must be still before it snaps (ms). */
const SETTLE_MS = 120;

/** Konva's double-click window; the second press of a double-click starts a flex move. */
const DOUBLE_CLICK_MS = 400;
const lastPress = { id: '', time: 0, selection: [] as readonly string[] };

interface Props {
  map: BbmMap;
  doc: Y.Doc;
  /** When true, the canvas is read-only (no drag, no delete-on-click). */
  isViewer?: boolean;
  /** Double-click → open per-brick properties dialog. */
  onEditBrick?: (brick: Brick, layerId: string, meta: PartWire | undefined) => void;
  /** The Turn tool clicked a part: turn these (the part, or its group or module) by the turn step; `back` with Shift. */
  onTurn?: (ids: readonly string[], back: boolean) => void;
}

const NO_MODULES: SidecarModule[] = [];

/**
 * All brick layers. Memoised, and each glyph is memoised with only
 * primitive / identity-stable props, so a re-render of the canvas (pan,
 * zoom, marquee, HUD) or an edit to ONE brick re-renders only what
 * changed. That relies on the shared cached projection (useDocMap), which
 * keeps unchanged Brick objects identical across doc updates.
 */
export const BrickLayer = memo(function BrickLayer({ map, doc, isViewer = false, onEditBrick, onTurn }: Props) {
  const catalog = useQuery({
    queryKey: ['parts-catalog'],
    queryFn: api.parts.catalog,
    staleTime: 5 * 60 * 1000,
  });

  // Bricks store the catalog key (`<partNumber>.<colorCode>` lowercased)
  // in their `partNumber` field — that's how desktop CLD writes the .bbm.
  // Index by `key` so the lookup matches without a parse step. Fall back
  // to bare `partNumber` for the rare "no color code" entries (group
  // parts and some custom uploads). Built once per catalog (it used to be
  // rebuilt on every render, which also broke every glyph's memo).
  const { partsByKey, byBarePartNumber } = useMemo(() => {
    const byKey = indexParts(catalog.data?.parts);
    const bare = new Map<string, PartWire>();
    for (const p of catalog.data?.parts ?? []) {
      // First catalog entry per bare part number — what the old
      // per-brick linear `lookupByPartNumberOnly` scan returned.
      if (!bare.has(p.partNumber.toLowerCase())) bare.set(p.partNumber.toLowerCase(), p);
    }
    return { partsByKey: byKey, byBarePartNumber: bare };
  }, [catalog.data]);

  // Store-driven display state, subscribed ONCE here rather than per glyph
  // (thousands of per-glyph subscriptions each ran on every store write,
  // e.g. the per-frame HUD mouse update).
  const selection = useEditorStore((s) => s.selection);
  const fade = useSheetFade(isViewer);
  const view = useEditorStore(
    useShallow((s) => ({
      tool: s.tool,
      showConnectionPoints: s.showConnectionPoints,
      alwaysShowConnections: s.alwaysShowConnections,
      showBrickHulls: s.showBrickHulls,
      showBrickElevation: s.showBrickElevation,
      selectionTint: s.selectionTint,
      snapActive: s.liveSnap !== null,
    })),
  );
  const selectedIds = useMemo(() => new Set(selection), [selection]);
  // Each part keeps what the selection overlay needs here (SelectionOverlay.ts).
  const [glyphs] = useState(() => new Map<string, GlyphInfo>());
  // While the Connection Points view draws every part's dots, the parts
  // draw their own (bright when picked); otherwise the overlay draws the
  // picked parts' dots, and picking re-renders no part.
  const dotsInParts = !isViewer && (view.showConnectionPoints || view.alwaysShowConnections);
  // Modules act as one piece (moduleEdit.ts): their look and pins live in
  // the sidecar (meta), so follow it as well as the map.
  useYjsSnapshot(doc.getMap('meta') as unknown as Y.AbstractType<unknown>);
  const editingModuleId = useEditorStore((s) => s.editingModuleId);
  const modules = readSidecarFromDoc(doc)?.modules ?? NO_MODULES;
  const modulesRef = useRef(modules);
  modulesRef.current = modules;
  const getModules = useCallback(() => modulesRef.current, []);
  // Parts of a module picked whole: the module is highlighted as one piece
  // (ModuleOverlay), so they don't each get their own halo.
  const inPickedModule = useMemo(() => {
    const out = new Set<string>();
    for (const m of modules) {
      if (m.id === editingModuleId || m.members.length === 0) continue;
      if (m.members.every((id) => selectedIds.has(id))) for (const id of m.members) out.add(id);
    }
    return out;
  }, [modules, editingModuleId, selectedIds]);

  // Glyphs read the map only inside event handlers; hand them a stable
  // getter instead of the map itself (a new object on every doc change).
  const mapRef = useRef(map);
  mapRef.current = map;
  const getMap = useCallback(() => mapRef.current, []);

  const brickLayers = map.layers.filter((l): l is LayerBrick => l.type === 'brick');

  // The picked parts' halos (not a module picked whole: ModuleOverlay
  // shows that) and dots, one shape over every part, like the desktop.
  const haloIds = useMemo(() => (isViewer ? [] : selection.filter((id) => !inPickedModule.has(id))), [isViewer, selection, inPickedModule]);
  const tint = view.selectionTint;
  const drawPicked = useCallback(
    (ctx: Konva.Context, shape: Konva.Shape) => {
      drawSelection(ctx, shape, {
        glyphs,
        haloIds,
        dotIds: isViewer || dotsInParts ? [] : selection,
        // Read when drawn: a copy on the drag layer turns green as a snap starts.
        colors: () => selectionHalo(tint, useEditorStore.getState().liveSnap !== null),
        bendHandles: view.tool === 'select',
      });
    },
    // view.snapActive: a new function redraws the layer when a snap starts or ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [glyphs, haloIds, isViewer, dotsInParts, selection, tint, view.tool, view.snapActive],
  );

  return (
    <Group>
      {brickLayers.map((layer) => {
        if (!layer.visible) return null;
        // The sheet's transparency (0-100 → 0..1) goes on each brick, not
        // on the sheet as one picture: vanilla BlueBrick draws every part
        // with the alpha (LayerBrick.cs mImageAttributeDefault), so a part
        // shows the parts under it, as desktop's per-item setOpacity does.
        const opacity = Math.max(0, Math.min(100, layer.transparency)) / 100;
        const hull = layer.hullProperties;
        const showHull = (!isViewer && view.showBrickHulls) || hull.isVisible;
        const hullColor = hullColorToCss(hull.hullColor);
        const showElevation = (!isViewer && view.showBrickElevation) || layer.displayBrickElevation;
        return (
          <Group key={layer.id} name={SHEET_FADE} opacity={fade(layer.id)}>
            {/* The sheet's own order, like BlueBrick (an altitude edit sorts the sheet: editBrick). */}
            {layer.bricks.map((brick) => {
              const lower = brick.partNumber.toLowerCase();
              return (
                <BrickGlyph
                  key={brick.id}
                  brick={brick}
                  layerId={layer.id}
                  doc={doc}
                  meta={partsByKey.get(lower) ?? byBarePartNumber.get(lower)}
                  isViewer={isViewer}
                  isSelected={dotsInParts && selectedIds.has(brick.id)}
                  tool={isViewer ? 'select' : view.tool}
                  showConnectionPoints={!isViewer && view.showConnectionPoints}
                  alwaysShowConnections={!isViewer && view.alwaysShowConnections}
                  showHull={showHull}
                  hullColor={hullColor}
                  hullThickness={hull.hullThickness}
                  showElevation={showElevation}
                  opacity={opacity}
                  getMap={getMap}
                  getModules={getModules}
                  dragOk={canDragPart(brick.id, modules, editingModuleId)}
                  outside={outsideEdit(brick.id, modules, editingModuleId)}
                  partsByKey={partsByKey}
                  glyphs={glyphs}
                  {...(onEditBrick ? { onEditBrick } : {})}
                  {...(onTurn ? { onTurn } : {})}
                />
              );
            })}
          </Group>
        );
      })}
      <Shape name={`${EXPORT_HIDE} ${SELECTION_OVERLAY}`} listening={false} perfectDrawEnabled={false} sceneFunc={drawPicked} />
    </Group>
  );
});

const BrickGlyph = memo(function BrickGlyph({
  brick,
  layerId,
  doc,
  meta,
  isViewer,
  isSelected,
  tool,
  showConnectionPoints,
  alwaysShowConnections,
  showHull,
  hullColor,
  hullThickness,
  showElevation,
  opacity,
  getMap,
  getModules,
  dragOk,
  outside,
  partsByKey,
  glyphs,
  onEditBrick,
  onTurn,
}: {
  brick: Brick;
  layerId: string;
  doc: Y.Doc;
  isViewer: boolean;
  meta: PartWire | undefined;
  /** Picked, while the part draws its own connection dots (the Connection Points view); the halo is the overlay's. */
  isSelected: boolean;
  tool: Tool;
  showConnectionPoints: boolean;
  alwaysShowConnections: boolean;
  showHull: boolean;
  hullColor: string;
  hullThickness: number;
  showElevation: boolean;
  /** The sheet's transparency, 0..1. */
  opacity: number;
  getMap: () => BbmMap;
  getModules: () => readonly SidecarModule[];
  /** It may be dragged: not out of reach while a module is edited, and not in a pinned module. */
  dragOk: boolean;
  /** A module is being edited and this part isn't in it: dimmed and out of reach. */
  outside: boolean;
  partsByKey: Map<string, PartWire>;
  /** Where the part tells the selection overlay what it needs (SelectionOverlay.ts). */
  glyphs: Map<string, GlyphInfo>;
  onEditBrick?: (brick: Brick, layerId: string, meta: PartWire | undefined) => void;
  onTurn?: (ids: readonly string[], back: boolean) => void;
}) {
  const spriteUrl = meta ? spriteUrlFor(meta) : '';
  const groupRef = useRef<Konva.Group | null>(null);

  // Ensure the sprite gets loaded into the sync cache. When it arrives (or
  // later, after a Retry on the loading card) this re-renders once to draw
  // it; a part whose picture is already here doesn't re-render at all.
  const [, setRev] = useState(0);
  const drewSprite = spriteUrl ? getSpriteSync(spriteUrl) !== null : true;
  useEffect(() => {
    if (!spriteUrl) return;
    let cancelled = false;
    const redraw = () => {
      if (!cancelled) setRev((r) => r + 1);
    };
    const off = onSpriteReady(spriteUrl, redraw);
    if (getSpriteSync(spriteUrl)) {
      // It arrived between the render and now.
      if (!drewSprite) redraw();
    } else {
      void ensureSprite(spriteUrl).catch(() => undefined);
    }
    return () => {
      cancelled = true;
      off();
    };
    // drewSprite: what the render that ran this saw.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spriteUrl]);

  const w = studToPx(brick.displayArea.width);
  const h = studToPx(brick.displayArea.height);
  // The Group sits on the brick's pivot (its sprite centre), which is
  // `imageOffset` from the displayArea centre for parts with a <hull>
  // (BrickPlacement.h). Everything below is drawn around it.
  const pivot = pivotOf(brick, meta);
  const pivotOff = { x: pivot.x - (brick.displayArea.x + brick.displayArea.width / 2), y: pivot.y - (brick.displayArea.y + brick.displayArea.height / 2) };

  const sprite = spriteUrl ? getSpriteSync(spriteUrl) : null;

  // Desktop draws the sprite at its NATURAL pixel size, scaled by
  // (kPixelsPerStud / authoredPxPerStud), then rotates around the
  // sprite's centre — see SceneBuilder.cpp:188-204. The .bbm's
  // `displayArea` is the AABB of the *rotated* sprite, so for any
  // brick with non-zero orientation, stretching to displayArea
  // distorts the image. We compute spriteWpx/spriteHpx from the
  // natural image size and use displayArea ONLY for placement (centre)
  // and selection (the AABB outline).
  const authoredPxPerStud = meta?.pxPerStud && meta.pxPerStud > 0 ? meta.pxPerStud : 8;
  const spriteScale = 8 / authoredPxPerStud; // STUD_PX / authoredPxPerStud
  const spriteWpx = sprite ? sprite.naturalWidth * spriteScale : w;
  const spriteHpx = sprite ? sprite.naturalHeight * spriteScale : h;

  // What the selection overlay draws this part's halo and dots from, kept
  // current on every render (no re-render needed when it's picked).
  const info = useRef<GlyphInfo>({ group: groupRef, brick, meta, spriteW: spriteWpx, spriteH: spriteHpx });
  info.current.brick = brick;
  info.current.meta = meta;
  info.current.spriteW = spriteWpx;
  info.current.spriteH = spriteHpx;
  useLayoutEffect(() => {
    const mine = info.current;
    glyphs.set(brick.id, mine);
    return () => {
      if (glyphs.get(brick.id) === mine) glyphs.delete(brick.id);
    };
  }, [glyphs, brick.id]);

  function handleClick(e: KonvaEventObject<MouseEvent | TouchEvent>) {
    // Right-click: if the clicked brick is already selected keep the whole
    // selection so the context menu applies to all selected bricks. If it's
    // NOT selected, select just this brick (standard OS right-click behaviour).
    if ('button' in e.evt && e.evt.button === 2) {
      if (tool === 'select') {
        const st = useEditorStore.getState();
        const currentSel = st.selection;
        // One ruler held and no parts: keep it, so the menu can attach
        // it to this part (desktop MapViewContextMenu heldRulerGuid).
        const holdsOneRuler = currentSel.length === 0 && st.annoSelection.rulers.length === 1
          && st.annoSelection.texts.length === 0 && st.annoSelection.labels.length === 0;
        if (!currentSel.includes(brick.id) && !holdsOneRuler) {
          st.setSelection([brick.id]);
        }
      }
      return;
    }
    const touch = isTouchEvent(e.evt);
    // A finger that moved the view, or was held down, doesn't also pick
    // the part it started on (touchGesture.ts tapGuard).
    if (touch && tapGuard.suppress) return;
    if (outside) {
      // Clicking outside the module being edited goes back to the whole layout.
      e.cancelBubble = true;
      leaveModuleEdit();
      return;
    }
    if (tool === 'select') {
      // Match Qt's default QGraphicsScene selection (the path desktop's
      // MapView::mousePressEvent falls through to at MapView.cpp:534):
      //   * plain click  → clear selection, select THIS item
      //   * shift / ctrl → toggle this item, keep the rest
      e.cancelBubble = true;
      // On a touch screen, "Select more" (or a long press) makes taps add.
      const additive =
        (touch && useEditorStore.getState().touchSelectMore) ||
        ('shiftKey' in e.evt ? e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey : false);

      // Group-aware selection: clicking a brick that belongs to a
      // group selects every brick sharing that group id, mirroring the
      // desktop's group selection behaviour. (`brick.myGroup` is empty
      // when ungrouped.)
      // A part of a module picks the whole module (unless it's the one
      // being edited: then its parts are picked one by one).
      const groupMembers = selectionUnit(
        brick.id,
        getModules(),
        useEditorStore.getState().editingModuleId,
        groupMembersOf(getMap(), brick.myGroup),
      );

      if (additive) {
        // Shift/ctrl-click toggles the whole group on/off, keeping any
        // selected rulers / labels / text (mixed selection).
        const sel = new Set(useEditorStore.getState().selection);
        const allIn = groupMembers.every((id) => sel.has(id));
        if (allIn) for (const id of groupMembers) sel.delete(id);
        else for (const id of groupMembers) sel.add(id);
        useEditorStore.setState({ selection: shapeSelectionIds([...sel]) });
      } else {
        useEditorStore.getState().setSelection(groupMembers);
      }
    } else if (tool === 'rotate' && !isViewer) {
      // Turn: a click turns the part (its whole group or module) by the
      // turn step, clockwise; Shift+click turns it back.
      e.cancelBubble = true;
      const unit = selectionUnit(brick.id, getModules(), useEditorStore.getState().editingModuleId, groupMembersOf(getMap(), brick.myGroup));
      onTurn?.(unit, 'shiftKey' in e.evt && e.evt.shiftKey);
    } else if (tool === 'delete' && !isViewer) {
      e.cancelBubble = true;
      deleteBricks(doc, layerId, [brick.id]);
    }
  }

  /**
   * Grab anchor — the connection nearest the press, captured on
   * mouse-down (desktop MapView.cpp:538-543 → captureGrabAnchor,
   * MapViewDrag.cpp:155-217). Persisted as the brick's active connection
   * and used as the snap lead of a single-brick drag.
   */
  const grabConnRef = useRef<number>(-1);
  /** This drag's snap corner when it started (gridSnap.ts grabSnapCorner), studs. */
  const snapCornerRef = useRef<{ x: number; y: number } | null>(null);

  /**
   * What the grabbed part's links may point at and still hold during the
   * drag: the parts moving with it (the selection it's in, else itself).
   */
  function grabKeys(): Set<string> {
    const sel = new Set(useEditorStore.getState().selection);
    if (!sel.has(brick.id)) return linkKeys([brick]);
    const moving: Brick[] = [];
    for (const layer of getMap().layers) {
      if (layer.type !== 'brick') continue;
      for (const b of layer.bricks) if (sel.has(b.id)) moving.push(b);
    }
    return linkKeys(moving);
  }

  /** A finger on the part: grab the connection nearest it, as a mouse press does. */
  function handleTouchStart(e: KonvaEventObject<TouchEvent>) {
    grabConnRef.current = -1;
    pointerKindRef.current = 'touch';
    if (isViewer || tool !== 'select' || e.evt.touches.length !== 1) return;
    const stage = e.target.getStage();
    const ptr = stage?.getPointerPosition();
    if (!stage || !ptr) return;
    const p = stage.getAbsoluteTransform().copy().invert().point(ptr);
    holdAt(p);
    const idx = nearestConnectionIndex(brick, meta, p.x / studToPx(), p.y / studToPx(), grabKeys());
    if (idx >= 0) grabConnRef.current = idx;
  }

  function handleMouseDown(e: KonvaEventObject<MouseEvent>) {
    grabConnRef.current = -1;
    pointerKindRef.current = 'mouse';
    if (isViewer || tool !== 'select' || e.evt.button !== 0 || outside) return;
    const stage = e.target.getStage();
    const ptr = stage?.getPointerPosition();
    if (!stage || !ptr) return;
    const p = stage.getAbsoluteTransform().copy().invert().point(ptr);
    holdAt(p);

    // The second press of a double-click on a hinged chain starts a flex
    // move (desktop MapView::mouseDoubleClickEvent → startFlexMove).
    // When the press happened, not when this handler got to run: on a busy
    // page the second press of a quick double-click can be handled well
    // after it was made (a flaky test on slow CI machines).
    const now = Number.isFinite(e.evt.timeStamp) && e.evt.timeStamp > 0 ? e.evt.timeStamp : performance.now();
    const second = lastPress.id === brick.id && now - lastPress.time < DOUBLE_CLICK_MS;
    // The selection as it was before the double-click's first press: that
    // click may have narrowed it to this brick (desktop pressSelection_).
    const pressSelection = lastPress.selection;
    if (!second) {
      lastPress.selection = useEditorStore.getState().selection;
      // A fresh press: an earlier flex move's release may never have
      // produced its double-click event.
      flexMovedRef.current = false;
    }
    lastPress.id = second ? '' : brick.id;
    lastPress.time = now;
    // A hinged chain bends even in a module (a flex track set is placed as
    // one), unless it's pinned; a double-click without a drag still opens
    // Edit module (onDblClick).
    if (second) {
      const group = groupRef.current;
      const started = startFlexSession({
        stage,
        doc,
        map: getMap(),
        layerId,
        grabbedId: brick.id,
        pressSelection: pressSelection.includes(brick.id) ? pressSelection : [],
        mouseStuds: { x: p.x / studToPx(), y: p.y / studToPx() },
        partsByKey,
        modules: getModules(),
        onEnd: (moved) => {
          group?.draggable(true);
          // Moved: the release is not a double-click that opens properties.
          if (moved) {
            flexMovedRef.current = true;
            return;
          }
          // Not moved: a double-click, acted on here. Konva's own dblclick
          // doesn't always come (the second press started the session and
          // changed the pick under the pointer), so it isn't waited for;
          // if it does come, it's this same double-click.
          doubleClickDoneAt.current = performance.now();
          doubleClickAction(false);
        },
      });
      if (started) {
        // The chain bends instead of the brick being dragged.
        group?.draggable(false);
        e.cancelBubble = true;
        return;
      }
    }
    const idx = nearestConnectionIndex(brick, meta, p.x / studToPx(), p.y / studToPx(), grabKeys());
    if (idx < 0) return;
    grabConnRef.current = idx;
    setActiveConnectionPoint(doc, layerId, brick.id, idx);
  }

  /** Set when a flex move bent the chain, so the double-click doesn't open properties. */
  const flexMovedRef = useRef(false);

  /** Selected rulers / labels moving along with this brick's drag. */
  const annoNodesRef = useRef<NodeSnap[]>([]);

  /**
   * Orientation the snap algorithm last suggested during a live drag.
   * Written each frame in handleDragMove; read in handleDragEnd to commit.
   * Null when no connection snap is active.
   */
  const snapOrientRef = useRef<number | null>(null);
  /** Last status-bar snap hint, to avoid a store write per drag frame. */
  const snapHintRef = useRef<string | null>(null);

  /**
   * Snapshot of every selected brick at drag-start. Lets `handleDragMove`
   * translate the entire selection rigidly with the leader. Mirrors the
   * desktop's `dragStart_` vector populated by `captureDragStart`
   * (MapViewDrag.cpp:106-127) and reused in `applyLiveConnectionSnap`
   * to apply a uniform `shiftPx` to every moving item.
   */
  const dragStartRef = useRef<
    | {
        leaderId: string;
        leaderStartCentre: { x: number; y: number };
        siblings: {
          id: string;
          startCentre: { x: number; y: number };
          node: Konva.Node | null;
          part: PartWire | undefined;
          links: { linkedTo: string; id?: string }[];
          orientation: number;
        }[];
      }
    | null
  >(null);

  /** Editing a module: its outline when this drag started, to tell when a part leaves it. */
  const moduleOutlineRef = useRef<{ moduleId: string; name: string; outline: StudRect; areas: Map<string, StudRect> } | null>(null);

  /** A group snap's turn, and the leader's raw centre it was made from (for the drop). */
  const groupTurnRef = useRef<{ turn: GroupTurn; raw: { x: number; y: number } } | null>(null);
  /** Puts the parts lifted onto the drag layer back (liftForDrag). */
  const putBackRef = useRef<(() => void) | null>(null);
  useEffect(() => () => putBackRef.current?.(), []);

  /** The dragged parts and where they were, for the live pose. */
  const poseStartRef = useRef<{ ids: ReadonlySet<string>; startAreas: ReadonlyMap<string, Brick['displayArea']> } | null>(null);

  /** This drag's snap state (held join, pointer speed). */
  const snapSessionRef = useRef<SnapSession | null>(null);
  /** The leader's centre where the pointer has it, before any snap (studs). */
  const rawCentreRef = useRef<{ x: number; y: number } | null>(null);
  /**
   * Pointer minus the leader's centre at the press (studs). The raw centre
   * is the pointer less this, every frame: never read back from the node,
   * which stands where the last snap put (and turned) it. Konva leaves the
   * node there when a touchmove brings no new position (a finger's
   * pressure changing), and reading that as the pointer's place made the
   * snap let go and take hold again on every such move.
   */
  const grabOffsetRef = useRef<{ x: number; y: number } | null>(null);

  /** The press: remember where the pointer holds the part (stage px `p`). */
  function holdAt(p: { x: number; y: number }) {
    const at = pivotOf(brick, meta);
    grabOffsetRef.current = { x: p.x / studToPx() - at.x, y: p.y / studToPx() - at.y };
  }

  /** The pointer on the map in studs, or null. */
  function pointerStuds(stage: Konva.Stage | null | undefined): { x: number; y: number } | null {
    const ptr = stage?.getPointerPosition();
    if (!stage || !ptr) return null;
    const p = stage.getAbsoluteTransform().copy().invert().point(ptr);
    return { x: p.x / studToPx(), y: p.y / studToPx() };
  }

  function handleDragStart(e: KonvaEventObject<DragEvent>) {
    snapOrientRef.current = null;
    {
      const layer = getMap().layers.find((l) => l.id === layerId);
      snapCornerRef.current = layer && layer.type === 'brick' ? grabSnapCorner(layer, brick, partsByKey) : null;
    }
    snapSessionRef.current = new SnapSession();
    rawCentreRef.current = null;
    traceStart(performance.now());
    // Where the pointer held the leader: taken on the press (as Konva
    // takes its drag offset), else now.
    if (!grabOffsetRef.current) {
      const p = pointerStuds(e.target.getStage());
      const at = pivotOf(brick, meta);
      grabOffsetRef.current = p ? { x: p.x - at.x, y: p.y - at.y } : null;
    }
    moduleOutlineRef.current = null;
    if (isViewer) return;
    if (tool !== 'select') return;
    const map = getMap();
    {
      // A part of a module drags the whole module, picked at once; a
      // pinned module doesn't move as a whole.
      const st = useEditorStore.getState();
      const modules = getModules();
      // Pressed on a part not picked yet: it's picked now with its set (or
      // its group), as a click picks it, so the whole set moves; dragging
      // only the pressed part left the rest of the set behind.
      if (!st.selection.includes(brick.id)) {
        const unit = selectionUnit(brick.id, modules, st.editingModuleId, groupMembersOf(map, brick.myGroup));
        if (unit.length > 1) st.setSelection(unit);
      }
      const pinned = pinnedAmong(
        useEditorStore.getState().selection.includes(brick.id) ? useEditorStore.getState().selection : [brick.id],
        modules,
        st.editingModuleId,
      );
      if (pinned) {
        e.target.stopDrag();
        e.target.position({ x: studToPx(pivot.x), y: studToPx(pivot.y) });
        tellPinned(pinned);
        dragStartRef.current = null;
        rawCentreRef.current = null;
        return;
      }
      // Editing a module: its outline now, to tell when a part leaves it.
      const editing = st.editingModuleId ? modules.find((m) => m.id === st.editingModuleId) : undefined;
      if (editing) {
        const areas = new Map<string, StudRect>();
        for (const l of map.layers) if (l.type === 'brick') for (const b of l.bricks) areas.set(b.id, b.displayArea);
        const outline = boundsOf(editing.members, areas);
        if (outline) moduleOutlineRef.current = { moduleId: editing.id, name: editing.name, outline, areas };
      }
    }
    brickDrag.started(e.target, brick.id, pointerKindRef.current !== 'touch');
    // Picked up again after a turn (brickDrag.ts): no press came first, so
    // the grabbed end is the one nearest the pointer now.
    if (grabConnRef.current < 0) {
      const p = pointerStuds(e.target.getStage());
      if (p) grabConnRef.current = nearestConnectionIndex(brick, meta, p.x, p.y, grabKeys());
    }
    const { selection, annoSelection } = useEditorStore.getState();
    // Selected rulers and labels move with the bricks (mixed selection,
    // MapViewDrag.cpp:124-153); only when this brick is part of it.
    // Labels and rulers fixed to the dragged parts follow them through the
    // live pose (liveDragPose.ts); shifting them as well would move them twice.
    annoNodesRef.current = selection.includes(brick.id)
      ? collectNodes(
          e.target.getStage(),
          annoNodeNames(ridingAnno(annoSelection, new Set(selection.length > 1 ? selection : [brick.id]), map, readSidecarFromDoc(doc)?.anchoredLabels ?? [])),
        )
      : [];
    // Only the brick under the cursor fires its own onDragStart in
    // Konva; the rest of the selection isn't dragged by Konva itself —
    // we translate them by hand on dragmove.
    const isMulti = selection.length > 1 && selection.includes(brick.id);
    // Where the dragged parts were, for the live pose (module outlines and
    // names follow the drag from it: liveDragPose.ts).
    {
      const moving = new Set(isMulti ? selection : [brick.id]);
      const startAreas = new Map<string, Brick['displayArea']>();
      for (const layer of map.layers) {
        if (layer.type !== 'brick') continue;
        for (const b of layer.bricks) if (moving.has(b.id)) startAreas.set(b.id, b.displayArea);
      }
      poseStartRef.current = { ids: moving, startAreas };
    }
    if (!isMulti) {
      dragStartRef.current = null;
      putBackRef.current = liftForDrag([e.target]);
      return;
    }
    const sel = new Set(selection);
    const leaderStart = pivotOf(brick, meta);
    // Resolve the sibling Konva nodes once here; looking each one up with
    // `stage.findOne` on every dragmove frame walked the whole scene graph
    // per sibling per frame.
    const stage = e.target.getStage();
    const siblings: NonNullable<typeof dragStartRef.current>['siblings'] = [];
    for (const layer of map.layers) {
      if (layer.type !== 'brick') continue;
      for (const b of layer.bricks) {
        if (b.id === brick.id || !sel.has(b.id)) continue;
        siblings.push({
          id: b.id,
          startCentre: pivotOf(b, partsByKey.get(b.partNumber.toLowerCase())),
          node: stage?.findOne(`.brick-${b.id}`) ?? null,
          part: partsByKey.get(b.partNumber.toLowerCase()),
          links: b.connexions,
          orientation: b.orientation,
        });
      }
    }
    dragStartRef.current = {
      leaderId: brick.id,
      leaderStartCentre: leaderStart,
      siblings,
    };
    putBackRef.current = liftForDrag([e.target, ...siblings.map((s) => s.node).filter((n): n is Konva.Node => !!n)]);
    void e;
  }

  /**
   * Apply live connection-snap mid-drag — port of
   * MapView::applyLiveConnectionSnap (MapViewDrag.cpp:239-410). Adjusts
   * the dragged Group's px position so the leader's nearest free
   * connection lands on the nearest matching free connection in the
   * rest of the map; for a multi-brick drag, every other selected
   * brick gets translated by the SAME delta so the group moves rigidly.
   */
  /** The pointer that is dragging: a finger snaps from a bigger reach. */
  const pointerKindRef = useRef<'mouse' | 'touch'>('mouse');

  /** Record this drag frame for the snap trace (snapTrace.ts; off unless switched on). */
  function trace(node: Konva.Node, raw: { x: number; y: number }, result: DragSnapResult, drop = false) {
    if (!snapTraceEnabled()) return;
    const ptr = node.getStage()?.getPointerPosition();
    const session = snapSessionRef.current;
    const reach = liveSnapReach(pointerKindRef.current === 'touch');
    traceFrame(
      performance.now(),
      {
        kind: 'drag',
        pointer: pointerKindRef.current,
        px: ptr?.x ?? NaN,
        py: ptr?.y ?? NaN,
        rawX: raw.x,
        rawY: raw.y,
        drawnX: node.x() / studToPx(),
        drawnY: node.y() / studToPx(),
        rot: node.rotation(),
        speed: session ? Math.round(session.meter.speed()) : 0,
        fast: session ? session.meter.isFast() : false,
        reach,
        hold: holdReach(reach),
        target: session?.lock?.targetKey ?? null,
        dist: result.snapDist,
      },
      drop,
    );
  }

  function handleDragMove(e: KonvaEventObject<DragEvent>) {
    if (isViewer) return;
    if (tool !== 'select') return;

    const node = e.target;
    // Where the pointer has the leader: the pointer less the grab offset.
    const p = pointerStuds(node.getStage());
    const off = grabOffsetRef.current;
    rawCentreRef.current =
      p && off ? { x: p.x - off.x, y: p.y - off.y } : { x: node.x() / studToPx(), y: node.y() / studToPx() };
    if (isTouchEvent(e.evt)) pointerKindRef.current = 'touch';
    const ptr = node.getStage()?.getPointerPosition();
    if (ptr) {
      if (!snapSessionRef.current) snapSessionRef.current = new SnapSession();
      // The event's own time: a slow page handles several moves at once,
      // which must not look like a burst of speed.
      snapSessionRef.current.sample(ptr.x, ptr.y, e.evt.timeStamp || performance.now());
    }
    dragFrame(node, snapBypassed(e.evt));
  }

  /** Re-runs the snap once a fast drag stops dead (no more moves come). */
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function clearSettle() {
    if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
  }

  /** One drag frame: snap from the raw centre, then the ring, hint and cursor. */
  function dragFrame(node: Konva.Node, bypass: boolean) {
    const raw = rawCentreRef.current;
    if (!raw) return;
    const stage = node.getStage();
    const ptr = stage?.getPointerPosition();
    const result = snapLeader(node, raw, bypass, false);
    trace(node, raw, result);
    // Too fast to snap: if the pointer stops here, snap shortly after.
    clearSettle();
    const session = snapSessionRef.current;
    if (session && !result.snappedToConnection && session.meter.isFast()) {
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        if (snapSessionRef.current !== session || !ptr) return;
        // The pointer is still where it was: a still sample slows the speed.
        session.sample(ptr.x, ptr.y, performance.now());
        dragFrame(node, bypass);
      }, SETTLE_MS);
    }

    if (result.snappedToConnection && result.ringStudX !== null) {
      useEditorStore.getState().setLiveSnap({ studX: result.ringStudX, studY: result.ringStudY! });
    } else {
      useEditorStore.getState().setLiveSnap(null);
    }
    useEditorStore
      .getState()
      .setSnapMoving(result.movingStudX !== null ? { studX: result.movingStudX, studY: result.movingStudY! } : null);

    // Status-bar snap diagnostic, as desktop shows during a live drag
    // (MapViewDrag.cpp). Only written when the text changes so a drag
    // doesn't hit the store every frame.
    const hint = result.snappedToConnection
      ? `Connection snap active (${result.movingConnCount} candidate conn(s))`
      : bypass
        ? 'Connection snap: off while Alt is held'
        : result.movingConnCount === 0
          ? 'Connection snap: no free connections in selection'
          : `Connection snap: ${result.movingConnCount} moving conn(s), no target in reach`;
    if (hint !== snapHintRef.current) {
      snapHintRef.current = hint;
      useEditorStore.getState().showStatusMessage(hint, 1500);
    }

    // Drag-out-to-delete cursor hint — port of MapView.cpp:584-587.
    const container = stage?.container();
    if (container) {
      const stageW = stage!.width();
      const stageH = stage!.height();
      const out = !ptr || ptr.x < 0 || ptr.y < 0 || ptr.x >= stageW || ptr.y >= stageH;
      container.style.cursor = out ? 'not-allowed' : '';
    }
  }

  /**
   * Snap the leader from its raw (pointer) centre and move it, the rest
   * of the selection and any riding rulers / labels to match. `final` is
   * the drop: one last snap with the speed gate off.
   */
  function snapLeader(node: Konva.Node, raw: { x: number; y: number }, bypass: boolean, final: boolean): DragSnapResult {
    const stage = node.getStage();
    const ptr = stage?.getPointerPosition();
    let mouseStudX = raw.x;
    let mouseStudY = raw.y;
    if (stage && ptr) {
      const t = stage.getAbsoluteTransform().copy().invert();
      const scenePos = t.point(ptr);
      mouseStudX = scenePos.x / studToPx();
      mouseStudY = scenePos.y / studToPx();
    }

    const dragStart = dragStartRef.current;
    const isMulti = !!dragStart && dragStart.siblings.length > 0;
    const session = snapSessionRef.current;

    const result = liveDragSnap(
      {
        part: meta,
        movingId: brick.id,
        ...(isMulti
          ? {
              siblings: dragStart.siblings.map((s) => ({
                id: s.id,
                part: s.part,
                links: s.links,
                offsetX: s.startCentre.x - dragStart.leaderStartCentre.x,
                offsetY: s.startCentre.y - dragStart.leaderStartCentre.y,
                orientation: s.orientation,
              })),
            }
          : {}),
        movingLinks: brick.connexions,
        centreX: raw.x,
        centreY: raw.y,
        width: brick.displayArea.width,
        height: brick.displayArea.height,
        pivotOffsetX: pivotOff.x,
        pivotOffsetY: pivotOff.y,
        ...(snapCornerRef.current
          ? { snapCornerX: snapCornerRef.current.x + raw.x - pivot.x, snapCornerY: snapCornerRef.current.y + raw.y - pivot.y }
          : {}),
        mouseStudX,
        mouseStudY,
        orientation: brick.orientation,
        snapStepStuds: useEditorStore.getState().snapStepStuds,
        // A finger gets the bigger reach (and with it the bigger hold).
        reach: liveSnapReach(pointerKindRef.current === 'touch'),
        ...(session ? { session } : {}),
        ...(bypass ? { bypass: true } : {}),
        ...(final ? { final: true } : {}),
        ...(grabConnRef.current >= 0 ? { leadConnIndex: grabConnRef.current } : {}),
      },
      getMap(),
      partsByKey,
    );

    // Position the leader at the snapped centre. A single-brick connection
    // snap also rotates it (mouth-to-mouth); the centre is already
    // rotation-aligned for that orientation, so the joint meets exactly.
    // Without a snap, restore the stored orientation (a previous frame may
    // have rotated it towards a target the cursor has since left).
    node.position({
      x: result.centreX * studToPx(),
      y: result.centreY * studToPx(),
    });
    snapOrientRef.current = result.newOrientation;
    const turn = result.groupTurn;
    groupTurnRef.current = turn ? { turn, raw } : null;
    node.rotation(result.newOrientation ?? brick.orientation + (turn?.degrees ?? 0));

    // Move every other selected brick with the leader so the group moves
    // rigidly (desktop MapViewDrag.cpp, shiftPx on every item in
    // dragStart_); when the snap turns the group, each turns about the
    // joined connection too, in the live preview.
    if (isMulti && stage) {
      const rawDx = raw.x - dragStart.leaderStartCentre.x;
      const rawDy = raw.y - dragStart.leaderStartCentre.y;
      const dxStud = result.centreX - dragStart.leaderStartCentre.x;
      const dyStud = result.centreY - dragStart.leaderStartCentre.y;
      for (const sib of dragStart.siblings) {
        const sibNode = sib.node;
        if (!sibNode) continue;
        const at = turn
          ? applyGroupTurn(turn, sib.startCentre.x + rawDx, sib.startCentre.y + rawDy)
          : { x: sib.startCentre.x + dxStud, y: sib.startCentre.y + dyStud };
        sibNode.position({ x: at.x * studToPx(), y: at.y * studToPx() });
        sibNode.rotation(sib.orientation + (turn?.degrees ?? 0));
      }
    }

    // Publish the pose (one shared source for everything drawn from the
    // layout that follows these parts: module outlines and names).
    const poseStart = poseStartRef.current;
    if (poseStart) {
      const leaderStart = isMulti ? dragStart.leaderStartCentre : pivot;
      const pose: DragPose =
        isMulti && turn
          ? {
              ...poseStart,
              about: { x: turn.pivotX - (raw.x - leaderStart.x), y: turn.pivotY - (raw.y - leaderStart.y) },
              to: { x: turn.toX, y: turn.toY },
              degrees: turn.degrees,
            }
          : {
              ...poseStart,
              about: leaderStart,
              to: { x: result.centreX, y: result.centreY },
              degrees: isMulti ? 0 : (result.newOrientation ?? brick.orientation + (turn?.degrees ?? 0)) - brick.orientation,
            };
      useLiveDragPose.getState().setPose(pose);
    }

    if (annoNodesRef.current.length > 0) {
      const startX = isMulti ? dragStart.leaderStartCentre.x : pivot.x;
      const startY = isMulti ? dragStart.leaderStartCentre.y : pivot.y;
      shiftNodes(annoNodesRef.current, (result.centreX - startX) * studToPx(), (result.centreY - startY) * studToPx());
    }

    return result;
  }

  function handleDragEnd(e: KonvaEventObject<DragEvent>) {
    brickDrag.ended(e.target);
    // The drop: one last snap at the normal reach, so a join the fast
    // drag held back happens now (and a held one stays).
    let finalSnap: DragSnapResult | null = null;
    if (!isViewer && tool === 'select' && rawCentreRef.current) {
      finalSnap = snapLeader(e.target, rawCentreRef.current, snapBypassed(e.evt), true);
      trace(e.target, rawCentreRef.current, finalSnap, true);
    }
    const wasSnapped = finalSnap ? finalSnap.snappedToConnection : useEditorStore.getState().liveSnap !== null;
    // Back from the drag layer, where they were in their sheets.
    putBackRef.current?.();
    putBackRef.current = null;
    clearSettle();
    snapSessionRef.current = null;
    rawCentreRef.current = null;
    grabOffsetRef.current = null;
    useEditorStore.getState().setLiveSnap(null);
    useEditorStore.getState().setSnapMoving(null);
    snapHintRef.current = null;
    const container = e.target.getStage()?.container();
    if (container) container.style.cursor = '';
    // Clear the multi-brick snapshot so the next single-brick drag
    // starts clean.
    const dragStart = dragStartRef.current;
    const snappedOrientation = snapOrientRef.current;
    const groupTurn = groupTurnRef.current;
    groupTurnRef.current = null;
    dragStartRef.current = null;
    snapOrientRef.current = null;
    const annoNodes = annoNodesRef.current;
    annoNodesRef.current = [];
    restoreNodes(annoNodes);
    grabConnRef.current = -1;
    if (isViewer) return;
    if (tool !== 'select') return;
    void dragStart;
    const map = getMap();
    const { selection, annoSelection } = useEditorStore.getState();
    const inSelection = selection.includes(brick.id);
    // Rulers / labels ride along only when they were captured at drag start.
    const anno = annoNodes.length > 0 ? annoSelection : { rulers: [], labels: [], texts: [] };

    // Drag-out-of-viewport-to-delete — port of MapView.cpp:725-736.
    // If the user released the mouse outside the Konva stage rect
    // (typically over the parts panel or browser chrome), interpret it
    // as a delete rather than a move.
    const stage = e.target.getStage();
    const ptr = stage?.getPointerPosition();
    const stageW = stage?.width() ?? 0;
    const stageH = stage?.height() ?? 0;
    // Not by touch: a finger that slides off the map onto the buttons
    // round it shouldn't throw the parts away (Delete is a button there).
    const outOfBounds =
      !isTouchEvent(e.evt) && (!ptr || ptr.x < 0 || ptr.y < 0 || ptr.x >= stageW || ptr.y >= stageH);
    if (outOfBounds) {
      // Desktop deleteSelected() removes the whole selection — bricks on
      // any layer plus rulers, labels and text — in one undo step.
      if (inSelection) {
        deleteMixedSelection(doc, map, selection, annoSelection);
      } else {
        deleteMixedSelection(doc, map, [brick.id], { rulers: [], labels: [], texts: [] });
      }
      useEditorStore.getState().setSelection([]);
      endPose(true);
      // Snap the visible Group back to its original position so it
      // doesn't briefly render at the off-stage drop coords before the
      // Yjs delete propagates.
      const node = e.target;
      node.position({ x: pivot.x * studToPx(), y: pivot.y * studToPx() });
      return;
    }

    const newCentreStudX = e.target.x() / studToPx();
    const newCentreStudY = e.target.y() / studToPx();
    const oldCentreStudX = pivot.x;
    const oldCentreStudY = pivot.y;
    const dx = newCentreStudX - oldCentreStudX;
    const dy = newCentreStudY - oldCentreStudY;
    const sidecar = annoCount(anno) > 0 ? readSidecarFromDoc(doc) : null;
    const labels = sidecar?.anchoredLabels ?? [];
    const modules = sidecar?.modules ?? [];

    if (inSelection && selection.length > 1 && groupTurn && dragStart) {
      // A group snap that turned the group: every selected brick turns
      // about the joined connection and lands with it, rulers / labels
      // follow the leader, all one undo step.
      const rawDx = groupTurn.raw.x - dragStart.leaderStartCentre.x;
      const rawDy = groupTurn.raw.y - dragStart.leaderStartCentre.y;
      doc.transact(() => {
        for (const [lid, ids] of bricksByLayer(map, selection)) {
          const layer = map.layers.find((l) => l.id === lid);
          if (!layer || layer.type !== 'brick') continue;
          const want = new Set(ids);
          for (const b of layer.bricks) {
            if (!want.has(b.id)) continue;
            const part = partsByKey.get(b.partNumber.toLowerCase());
            const p = pivotOf(b, part);
            const to = applyGroupTurn(groupTurn.turn, p.x + rawDx, p.y + rawDy);
            moveBrickAndOrient(doc, lid, b.id, to.x, to.y, b.orientation + groupTurn.turn.degrees, part);
          }
        }
        if (annoCount(anno) > 0) {
          translateMixedSelection(doc, map, labels, modules, { bricks: [], anno, dx, dy, movedBricks: selection });
        }
      }, LOCAL_ORIGIN);
    } else if (inSelection && selection.length > 1) {
      // Multi-select drag: translate every selected brick (and ruler /
      // label) by the same delta, across ALL layers in one transaction
      // so undo is one step.
      translateMixedSelection(doc, map, labels, modules, { bricks: selection, anno, dx, dy });
    } else {
      // Single brick: commit its snapped pose, plus any rulers / labels
      // selected with it, as one undo step.
      doc.transact(() => {
        if (snappedOrientation !== null) {
          moveBrickAndOrient(doc, layerId, brick.id, newCentreStudX, newCentreStudY, snappedOrientation, meta);
        } else {
          moveBrick(doc, layerId, brick.id, newCentreStudX, newCentreStudY, meta);
        }
        if (annoCount(anno) > 0) {
          translateMixedSelection(doc, map, labels, modules, { bricks: [], anno, dx, dy, movedBricks: [brick.id] });
        }
      }, LOCAL_ORIGIN);
    }
    // Desktop confirms the commit in the status bar (MapViewDrag.cpp:594-597).
    useEditorStore.getState().showStatusMessage(wasSnapped ? 'Connection snap' : 'Moved', 1500);
    // The layout has the parts in their new place now; the pose stops
    // applying by itself (poseMoves), and goes once the drawing caught up.
    endPose(false);

    // Editing a module: parts dragged clear of its outline may leave it.
    const edit = moduleOutlineRef.current;
    moduleOutlineRef.current = null;
    if (edit) {
      const moved = inSelection && selection.length > 1 ? selection : [brick.id];
      const left = moved.filter((id) => {
        const a = edit.areas.get(id);
        return a && outsideOutline({ ...a, x: a.x + dx, y: a.y + dy }, edit.outline);
      });
      const members = new Set(getModules().find((m) => m.id === edit.moduleId)?.members ?? []);
      const leaving = left.filter((id) => members.has(id));
      if (leaving.length > 0) void askTakeOut(edit.moduleId, edit.name, leaving);
    }
  }

  // A turn in mid-drag dropped the parts (brickDrag.ts): now that they're
  // drawn turned, the drag picks up again, the mouse still down.
  useEffect(() => {
    if (!brickDrag.takeResume(brick.id)) return;
    const node = groupRef.current;
    if (node && !isViewer && tool === 'select') node.startDrag();
  }, [brick, isViewer, tool]);

  /** The drag is over: the pose goes at once (nothing moved) or once the layout has redrawn. */
  function endPose(now: boolean) {
    poseStartRef.current = null;
    const pose = useLiveDragPose.getState().pose;
    if (!pose) return;
    if (now) {
      useLiveDragPose.getState().setPose(null);
      return;
    }
    setTimeout(() => {
      if (useLiveDragPose.getState().pose === pose) useLiveDragPose.getState().setPose(null);
    }, POSE_LINGER_MS);
  }

  async function askTakeOut(moduleId: string, name: string, ids: string[]) {
    const what = ids.length === 1 ? 'this part' : `these ${ids.length} parts`;
    const ok = await askConfirm({
      title: `Take ${what} out of “${name || 'the module'}”?`,
      removes: `${ids.length === 1 ? 'It stays' : 'They stay'} on the map, on ${ids.length === 1 ? 'its' : 'their'} own.`,
      keeps: `Cancel keeps ${ids.length === 1 ? 'it' : 'them'} in the module, which grows to take ${ids.length === 1 ? 'it' : 'them'} in.`,
      confirmLabel: 'Take out',
      danger: false,
    });
    if (ok) takeOutOfModule(doc, moduleId, ids);
  }

  /**
   * A double click or double tap: a module's part opens Edit module; a
   * double click on any other part opens its properties.
   */
  /** When a flex session's still second press acted as the double-click (see handleMouseDown). */
  const doubleClickDoneAt = useRef(-Infinity);

  function onDoubleClick(e: KonvaEventObject<MouseEvent | TouchEvent>, byTouch = false) {
    e.cancelBubble = true;
    // A double-click that bent a flex chain doesn't open properties.
    if (flexMovedRef.current) {
      flexMovedRef.current = false;
      return;
    }
    // Already acted on by the flex session that the second press started.
    if (performance.now() - doubleClickDoneAt.current < DOUBLE_CLICK_MS) return;
    doubleClickAction(byTouch);
  }

  /** What a double click or double tap does: Edit module, or the part's properties. */
  function doubleClickAction(byTouch: boolean) {
    // Only Select opens things: clicking fast with Turn turns the part
    // again (twice in a row isn't a double-click that opens its properties).
    if (isViewer || outside || tool !== 'select') return;
    // A module's part opens Edit module (the part picked); inside the
    // module being edited it opens the part's properties as usual.
    const mod = moduleByPart(getModules()).get(brick.id);
    if (mod && mod.id !== useEditorStore.getState().editingModuleId) {
      enterModuleEdit(mod.id, brick.id);
      return;
    }
    if (!byTouch && onEditBrick) onEditBrick(brick, layerId, meta);
  }

  // A picked flex track (or other hinged part) shows bend handles on its
  // free ends (BendHandles), not connection dots under them.
  const handlesInstead =
    isSelected && !isViewer && tool === 'select' && !!meta && meta.connections.length <= 2 &&
    meta.connections.some((c) => connectionHingeAngle(c.type) !== 0);

  return (
    <Group
      ref={groupRef}
      // Stable name so multi-brick drag can find sibling Groups via
      // `stage.findOne('.brick-<id>')` and translate them in step.
      name={`brick-${brick.id}`}
      x={studToPx(pivot.x)}
      y={studToPx(pivot.y)}
      rotation={brick.orientation}
      draggable={!isViewer && tool === 'select' && dragOk}
      opacity={outside ? opacity * 0.5 : opacity}
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
      onClick={handleClick}
      onTap={handleClick}
      onDblTap={(e) => onDoubleClick(e, true)}
      onDblClick={(e) => onDoubleClick(e)}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
    >
      {sprite ? (
        // Sprite is centred on (0,0) of the rotated Group; size is the
        // sprite's natural pixels, NOT the displayArea AABB. This keeps
        // a 45°-rotated 16x4 brick at its real 16x4 footprint (just
        // rotated) instead of stretching it into the AABB envelope.
        //
        // `listening` MUST be true here (or on some other shape in this
        // Group) — Konva hit-tests against an offscreen per-Layer hit
        // canvas that non-listening shapes never paint onto, and a
        // Group has no hit area of its own beyond the union of its
        // listening children's. With every shape in this Group at
        // `listening={false}`, the brick's `draggable` Group had no hit
        // area at all: clicking directly on a brick's own pixels never
        // registered a hit, so selecting/dragging bricks didn't work.
        <KonvaImage
          image={sprite}
          x={-spriteWpx / 2}
          y={-spriteHpx / 2}
          width={spriteWpx}
          height={spriteHpx}
          opacity={1}
          perfectDrawEnabled={false}
          // An imported part hits only inside its <PickShape>: clicks in its
          // empty corners and holes reach what is underneath.
          {...(meta?.pickShape ? {
            hitFunc: (ctx: Konva.Context, shape: Konva.Shape) => {
              const c = ctx._context;
              c.save();
              c.translate(spriteWpx / 2, spriteHpx / 2);
              tracePickShape(c, meta.pickShape!, 8);
              c.fillStyle = shape.colorKey;
              c.fill('evenodd');
              c.restore();
            },
          } : {})}
        />
      ) : (
        meta ? (
          // A known part whose sprite is still loading: a neutral box.
          <Rect name="brick-loading" x={-w / 2} y={-h / 2} width={w} height={h} fill="#404040" stroke="#888" strokeWidth={1} perfectDrawEnabled={false} />
        ) : (
          <UnknownPart partNumber={brick.partNumber} widthStuds={brick.displayArea.width} heightStuds={brick.displayArea.height} />
        )
      )}
      {/*
        Connection-point dots — port of SceneBuilder.cpp:238-310.
        Free (unlinked) CPs of a selected brick, or of every brick when
        Always Show Connections or the Connection Points view toggle is on
        (both off by default); brightness varies by selection state. Linked CPs render nothing — connectivity rebuild
        (Connectivity.cpp) links coincident CPs, preventing stacked dots
        at shared edges. The active CP gets bigger + gold when selected.
      */}
      {(showConnectionPoints || isSelected || alwaysShowConnections) && meta && !(handlesInstead) && meta.connections.map((cp, ci) => {
        // Skip non-numeric "type" values (custom non-snap joints) — same
        // gate desktop applies at SceneBuilder.cpp:262-267.
        if (!cp.type || !/^\d+$/.test(cp.type)) return null;
        const link = brick.connexions[ci];
        if (link && link.linkedTo !== '') return null;
        const isActive = isSelected && ci === brick.activeConnectionPointIndex;
        // `alwaysShowConnections` renders unselected CPs at full brightness
        // (desktop `appearance/alwaysShowConnections`).
        const effectiveSelected = isSelected || alwaysShowConnections;
        const r = isActive ? 13 : 10;
        return (
          <Circle
            key={`cp-${ci}`}
            name={EXPORT_HIDE}
            x={cp.x * 8}
            y={cp.y * 8}
            radius={r}
            fill={isActive ? 'rgb(255,215,0)' : effectiveSelected ? 'rgb(230,40,40)' : 'rgba(200,30,30,0.45)'}
            stroke={isActive ? 'rgb(30,30,30)' : effectiveSelected ? 'rgb(255,255,255)' : 'rgba(255,255,255,0.3)'}
            strokeWidth={isActive ? 3 : 2.5}
            strokeScaleEnabled={false}
            listening={false}
            perfectDrawEnabled={false}
          />
        );
      })}
      {/* Hull outline — per-layer hullProperties; drawn when view/brickHulls is on
          OR when the layer's own hullProperties.isVisible flag is set.
          When meta.hullPts is non-empty we draw the actual polygon (pixel coords
          relative to sprite top-left, shifted to the Group's local centre).
          Fallback: sprite bounding rect (desktop behaviour for parts without a
          hull element in the XML). */}
      {showHull && (() => {
        const color = hullColor;
        const sw = Math.max(1, hullThickness);
        const pts = meta?.hullPts;
        if (pts && pts.length >= 3) {
          // Flatten to Konva points array: [x0,y0, x1,y1, ...]
          // Translate from sprite-top-left coords to Group local (centred) coords.
          const ox = -spriteWpx / 2;
          const oy = -spriteHpx / 2;
          const flatPts = pts.flatMap((p) => [p.x + ox, p.y + oy]);
          return (
            <Line
              points={flatPts}
              closed
              stroke={color}
              strokeWidth={sw}
              strokeScaleEnabled={false}
              fillEnabled={false}
              listening={false}
              perfectDrawEnabled={false}
            />
          );
        }
        return (
          <Rect
            x={-spriteWpx / 2}
            y={-spriteHpx / 2}
            width={spriteWpx}
            height={spriteHpx}
            stroke={color}
            strokeWidth={sw}
            strokeScaleEnabled={false}
            fillEnabled={false}
            listening={false}
            perfectDrawEnabled={false}
          />
        );
      })()}
      {/* Elevation badge — shows brick.altitude when view/brickElevation is on
          OR when the layer's displayBrickElevation flag is set.
          Port of SceneBuilder.cpp elevation label (brickElevation key).
          Only shown for non-zero altitude so the canvas stays clean. */}
      {showElevation && brick.altitude !== 0 && (
        <KonvaText
          x={-spriteWpx / 2 + 2}
          y={-spriteHpx / 2 + 2}
          text={`${brick.altitude > 0 ? '+' : ''}${brick.altitude}`}
          fontSize={9}
          fontStyle="bold"
          fill="#fff"
          stroke="#000"
          strokeWidth={2}
          fillAfterStrokeEnabled
          listening={false}
          perfectDrawEnabled={false}
        />
      )}
    </Group>
  );
});

function hullColorToCss(c: import('@cld/model').ColorSpec): string {
  if (c.kind === 'known') {
    const known: Record<string, string> = {
      black: '#000', white: '#fff', red: '#f00', green: '#0f0',
      blue: '#00f', yellow: '#ff0', orange: '#ffa500', gray: '#808080',
      darkgray: '#a9a9a9', lightgray: '#d3d3d3',
    };
    return known[c.name.toLowerCase()] ?? '#000';
  }
  if (c.argb.length === 8) return `#${c.argb.slice(2)}`;
  return `#${c.argb}`;
}

// Mutation helpers (deleteBricks, moveBrick, translateBricks) live in
// `../mutations.ts`, where they're exercised by mutations.test.ts.

/**
 * Walk the map and return every brick id sharing the given `myGroup`.
 * Empty groupId returns an empty list.
 */
/**
 * Selection halo colors: the selection tint, or desktop's green while a
 * connection snap is live (SelectionOverlay.cpp:26-29).
 */
export function selectionHalo(tint: string, snapActive: boolean): { stroke: string; fill: string } {
  return snapActive
    ? { stroke: SELECTION.snapStroke, fill: SELECTION.snapFill }
    : { stroke: `#${tint}`, fill: `#${tint}${SELECTION.partFillAlpha.toString(16).toUpperCase().padStart(2, '0')}` };
}

/** A part the library doesn't know, as vanilla BlueBrick draws it (unknownPart.ts). */
function UnknownPart({ partNumber, widthStuds, heightStuds }: { partNumber: string; widthStuds: number; heightStuds: number }) {
  const look = unknownPartLook(partNumber, widthStuds, heightStuds);
  const x = -look.width / 2;
  const y = -look.height / 2;
  return (
    // Not "brick-…": that prefix names a brick's own group (hit tests, e2e look-ups).
    <Group name="unresolved-part">
      {/* Clear, but it still takes clicks (Konva hit-tests the fill). */}
      <Rect x={x} y={y} width={look.width} height={look.height} fill="rgba(0,0,0,0)" perfectDrawEnabled={false} />
      <Line points={[x, y, -x, -y]} stroke="#ff0000" strokeWidth={look.penPx} listening={false} perfectDrawEnabled={false} />
      <Line points={[x, -y, -x, y]} stroke="#ff0000" strokeWidth={look.penPx} listening={false} perfectDrawEnabled={false} />
      <KonvaText
        x={x}
        y={-(look.fontPx * MAP_LINE_HEIGHT) / 2}
        width={look.width}
        align="center"
        wrap="none"
        lineHeight={MAP_LINE_HEIGHT}
        text={partNumber}
        fontSize={look.fontPx}
        fontFamily={MAP_FONT_STACK}
        fill="#000000"
        listening={false}
        perfectDrawEnabled={false}
      />
    </Group>
  );
}
