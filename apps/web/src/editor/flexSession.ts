// Flex move in the editor — desktop MapView::startFlexMove / updateFlexItems
// / finishFlexMove (MapView.cpp:600-613, 1692-1776): the second press of a
// double-click on a brick of a selected hinged chain (PFS flex track,
// magnet couplings...) bends the chain while the mouse moves, and the
// release commits every changed brick as one undo step. A double-click
// without moving changes nothing (the brick's properties open as usual).

import * as Y from 'yjs';
import type Konva from 'konva';
import type { BbmMap, LayerBrick } from '@cld/model';
import type { SidecarModule } from '@cld/bbm';
import { FlexMove, imageOffset, type FlexState } from '@cld/parts-catalog/browser';
import type { PartWire } from '../api';
import { useEditorStore } from './editorStore';
import { catalogFromParts } from './useConnectivity';
import { LOCAL_ORIGIN } from './useLayoutDoc';
import { liveSnapReach } from './liveSnapReach';
import { snapTraceEnabled, traceFrame, traceStart } from './snapTrace';
import { isTouchEvent } from './touchGesture';
import { holdReach, SnapSession, snapBypassed } from './snapFeel';
import { pinnedAmong } from './moduleEdit';
import { partsLocked } from './sharedLock';

const PX = 8;

type StudPoint = { studX: number; studY: number };
const samePoints = (a: readonly StudPoint[], b: readonly StudPoint[]) =>
  a.length === b.length && a.every((p, i) => p.studX === b[i]!.studX && p.studY === b[i]!.studY);

/** Write the chain's new poses into the doc as one undo step. */
export function commitFlex(doc: Y.Doc, layerId: string, states: readonly FlexState[]): void {
  if (states.length === 0) return;
  doc.transact(() => {
    const layer = doc.getMap('layerData').get(layerId);
    if (!(layer instanceof Y.Map)) return;
    const bricks = layer.get('bricks');
    if (!(bricks instanceof Y.Array)) return;
    const byId = new Map<unknown, Y.Map<unknown>>();
    bricks.forEach((b) => {
      if (b instanceof Y.Map) byId.set(b.get('id'), b);
    });
    for (const s of states) {
      const y = byId.get(s.id);
      if (!y) continue;
      y.set('displayArea', { ...s.displayArea });
      y.set('orientation', s.orientation);
    }
  }, LOCAL_ORIGIN);
}

/**
 * Start a flex move of `grabbedId` if the selection holds a flexible chain
 * through it. Returns false (and does nothing) otherwise.
 */
export function startFlexSession(opts: {
  stage: Konva.Stage;
  doc: Y.Doc;
  map: BbmMap;
  layerId: string;
  grabbedId: string;
  /** Selection from before the double-click, when it held the grabbed brick. */
  pressSelection?: readonly string[];
  mouseStuds: { x: number; y: number };
  partsByKey: ReadonlyMap<string, PartWire>;
  /** The layout's modules: a pinned one never bends. */
  modules?: readonly SidecarModule[];
  /** The bricks that may bend (a bend handle's run), instead of the selection. */
  chain?: readonly string[];
  /** The grabbed brick's connection that follows the pointer (a bend handle's end), instead of its active one. */
  activeConnection?: number;
  /** The undo step's status message. */
  label?: string;
  onEnd: (moved: boolean) => void;
}): boolean {
  const { stage, doc, map, layerId, grabbedId, pressSelection = [], mouseStuds, partsByKey, modules = [], onEnd } = opts;
  const source = map.layers.find((l): l is LayerBrick => l.id === layerId && l.type === 'brick');
  if (!source) return false;
  // The move edits bricks in place: work on a copy of the layer.
  const layer = structuredClone(source);
  const st = useEditorStore.getState();
  // The chain is the current selection (the double-click's first click
  // selected the brick), as in BlueBrick.
  const selection = new Set(opts.chain ? [...opts.chain, grabbedId] : [...st.selection, ...pressSelection, grabbedId]);
  if (opts.activeConnection !== undefined) {
    const grabbed = layer.bricks.find((b) => b.id === grabbedId);
    if (grabbed) grabbed.activeConnectionPointIndex = opts.activeConnection;
  }
  const flex = FlexMove.start(layer, selection, grabbedId, mouseStuds, catalogFromParts([...new Set(partsByKey.values())]));
  if (!flex) return false;

  const chainIds = flex.initialState().map((s) => s.id);
  if (pinnedAmong(chainIds, modules, st.editingModuleId)) return false;
  // A shared module's track isn't bent here (sharedLock.ts): it says why.
  if (partsLocked(doc, chainIds, 'bend')) return false;
  st.setSelection(chainIds);
  let moved = false;

  const pointerStuds = () => {
    const p = stage.getPointerPosition();
    if (!p) return null;
    const w = stage.getAbsoluteTransform().copy().invert().point(p);
    return { x: w.x / PX, y: w.y / PX };
  };
  // The chain's nodes, found once (a find walks the whole stage).
  const nodes = new Map<string, Konva.Node | undefined>();
  const nodeOf = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, stage.findOne(`.brick-${id}`));
    return nodes.get(id);
  };
  const draw = () => {
    // Only the sheets the chain is drawn on: redrawing every layer of the
    // stage on each move is what made a slow phone fall behind the finger.
    const layers = new Set<Konva.Layer>();
    for (const s of flex.currentState()) {
      const node = nodeOf(s.id);
      if (!node) continue;
      const l = node.getLayer();
      if (l) layers.add(l);
      const b = layer.bricks.find((x) => x.id === s.id);
      const part = b ? partsByKey.get(b.partNumber.toLowerCase()) : undefined;
      const off = part ? imageOffset(part, s.orientation) : { x: 0, y: 0 };
      node.rotation(s.orientation);
      node.position({
        x: (s.displayArea.x + s.displayArea.width / 2 + off.x) * PX,
        y: (s.displayArea.y + s.displayArea.height / 2 + off.y) * PX,
      });
    }
    for (const l of layers) l.batchDraw();
  };
  // The end snaps like a dragged part's grabbed end (snap.ts, #240): it
  // joins the nearest free end of its type at any angle, reach measured
  // from where the pointer has it, with the calm-snap hold and switch.
  const session = new SnapSession();
  traceStart(performance.now());
  let bypass = false;
  // A finger bends with the bigger touch reach, as a finger drag snaps.
  let coarse = false;
  const bend = (m: { x: number; y: number }, final: boolean) => {
    const targets = flex.snapTargets();
    const end = flex.endFor(m);
    const reach = liveSnapReach(coarse);
    const hold = holdReach(reach);
    const candidates = targets.flatMap((t, index) => {
      const dist = Math.hypot(t.world.x - end.x, t.world.y - end.y);
      return dist <= hold ? [{ movingKey: 'flex', targetKey: t.key, dist, mouseDist: 0, index }] : [];
    });
    const pick = session.step(candidates, reach, { bypass, final });
    const joined = flex.bendTo(m, pick ? pick.index : -1);
    // Out of the chain's reach (each hinge within its limit): no join.
    if (pick && !joined) session.lock = null;
    if (snapTraceEnabled()) {
      const screen = stage.getPointerPosition();
      traceFrame(
        performance.now(),
        {
          kind: 'flex',
          pointer: coarse ? 'touch' : 'mouse',
          px: screen?.x ?? NaN,
          py: screen?.y ?? NaN,
          rawX: end.x,
          rawY: end.y,
          drawnX: m.x,
          drawnY: m.y,
          rot: 0,
          speed: Math.round(session.meter.speed()),
          fast: session.meter.isFast(),
          reach,
          hold,
          target: session.lock?.targetKey ?? null,
          dist: pick && joined ? pick.dist : null,
        },
        final,
      );
    }
    moved = true;
    const at = joined && pick ? targets[pick.index]!.world : null;
    // Only when they change: each change redraws the overlays' layers.
    const store = useEditorStore.getState();
    const live = at ? { studX: at.x, studY: at.y } : null;
    if (!samePoints(store.liveSnap ? [store.liveSnap] : [], live ? [live] : [])) store.setLiveSnap(live);
    const limits = flex.hingesAtLimit().map((p) => ({ studX: p.x, studY: p.y }));
    if (!samePoints(store.hingeLimits, limits)) store.setHingeLimits(limits);
    draw();
  };
  const onMove = (e?: { evt?: Event & { altKey?: boolean } }) => {
    const m = pointerStuds();
    if (!m) return;
    if (e?.evt) coarse = isTouchEvent(e.evt);
    const screen = stage.getPointerPosition();
    // The event's own time: a slow page handles several at once.
    if (screen) session.sample(screen.x, screen.y, e?.evt?.timeStamp ?? performance.now());
    // Alt bends without snapping.
    bypass = snapBypassed(e?.evt);
    bend(m, false);
  };
  let done = false;
  const onUp = () => {
    if (done) return;
    done = true;
    stage.off('mousemove.flex touchmove.flex');
    stage.off('mouseup.flex touchend.flex');
    window.removeEventListener('mouseup', onUp);
    // The release settles the join (no speed gate), so it links.
    const m = moved ? pointerStuds() : null;
    if (m) bend(m, true);
    useEditorStore.getState().setLiveSnap(null);
    useEditorStore.getState().setHingeLimits([]);
    if (moved) {
      commitFlex(doc, layerId, flex.currentState());
      useEditorStore.getState().showStatusMessage(opts.label ?? 'Flex move', 1500);
    }
    onEnd(moved);
  };
  stage.on('mousemove.flex touchmove.flex', onMove);
  stage.on('mouseup.flex touchend.flex', onUp);
  // A release outside the stage still ends the move.
  window.addEventListener('mouseup', onUp, { once: true });
  return true;
}
