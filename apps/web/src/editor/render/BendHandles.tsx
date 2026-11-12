// Bend handles — the desktop's MapView::refreshBendHandles /
// paintBendHandles / startBendFromHandle. When the selection holds a
// flexible run (flex track sets, magnet couplings, hinges), a round handle
// sits on each of its free ends; dragging one bends the run (BlueBrick's
// solver, each hinge within its limit) so that end follows the pointer,
// by mouse or finger.

import { useEffect, useMemo, useRef } from 'react';
import { Group, Shape } from 'react-konva';
import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import type * as Y from 'yjs';
import type { BbmMap, LayerBrick } from '@cld/model';
import type { SidecarModule } from '@cld/bbm';
import { connectionHingeAngle } from '@cld/parts-catalog/browser';
import type { PartWire } from '../../api';
import { connectionWorld, type Pt } from '../brickGeometry';
import { startFlexSession } from '../flexSession';
import { pinnedAmong } from '../moduleEdit';
import { useEditorStore } from '../editorStore';
import { EXPORT_HIDE } from '../exportRender';
import { nodePointIn } from '../liveDragPose';
import { DRAG_LAYER } from './BrickLayer';

const PX = 8;

/** A free end of a flexible run, where a bend handle sits. */
export interface FlexEnd {
  layerId: string;
  /** The brick at the end. */
  brickId: string;
  /** Its free connection. */
  connection: number;
  /** Where that connection is, studs. */
  world: Pt;
  /** Where it is on its brick (studs from the sprite centre, before the turn). */
  local: Pt;
  /** Every brick of the run. */
  run: string[];
}

/**
 * The flexible runs through the selected bricks: every brick with a hinged
 * connection (and at most two connections) reachable through linked
 * connections from a selected one, so a chain of flex track sets is one
 * run. Returns their free ends — none for a run joined at both ends.
 */
export function flexRunEnds(map: Pick<BbmMap, 'layers'>, selection: readonly string[], parts: ReadonlyMap<string, PartWire>): FlexEnd[] {
  if (selection.length === 0) return [];
  const want = new Set(selection);
  const out: FlexEnd[] = [];
  for (const layer of map.layers) {
    if (layer.type !== 'brick' || layer.visible === false) continue;
    out.push(...layerRunEnds(layer, want, parts));
  }
  return out;
}

function layerRunEnds(layer: LayerBrick, want: ReadonlySet<string>, parts: ReadonlyMap<string, PartWire>): FlexEnd[] {
  const partOf = (partNumber: string) => parts.get(partNumber.toLowerCase());
  const flexible = (partNumber: string) => {
    const p = partOf(partNumber);
    return !!p && p.connections.length > 0 && p.connections.length <= 2 && p.connections.some((c) => connectionHingeAngle(c.type) !== 0);
  };
  const run = new Set<string>();
  const todo: string[] = [];
  for (const b of layer.bricks) {
    if (want.has(b.id) && flexible(b.partNumber)) {
      run.add(b.id);
      todo.push(b.id);
    }
  }
  // No flex part picked on this sheet: nothing to index (it indexed every
  // part and connection of the sheet after each change while anything was
  // picked, about 25 ms on 7,520 parts at 4x slowed CPU).
  if (todo.length === 0) return [];
  const owner = new Map<string, string>(); // connection id -> brick id
  const byId = new Map(layer.bricks.map((b) => [b.id, b]));
  for (const b of layer.bricks) for (const c of b.connexions) if (c.id) owner.set(c.id, b.id);
  while (todo.length > 0) {
    const b = byId.get(todo.pop()!)!;
    for (const c of b.connexions) {
      const next = c.linkedTo ? owner.get(c.linkedTo) : undefined;
      if (!next || run.has(next) || !flexible(byId.get(next)!.partNumber)) continue;
      run.add(next);
      todo.push(next);
    }
  }
  const ends: FlexEnd[] = [];
  const runIds = [...run];
  for (const b of layer.bricks) {
    if (!run.has(b.id)) continue;
    const p = partOf(b.partNumber)!;
    p.connections.forEach((c, i) => {
      if (!c.type || b.connexions[i]?.linkedTo) return;
      ends.push({ layerId: layer.id, brickId: b.id, connection: i, world: connectionWorld(b, p, i), local: { x: c.x, y: c.y }, run: runIds });
    });
  }
  return ends;
}

/**
 * A bend handle's size on screen, px, the same at every zoom: a small ring
 * for the mouse, a bigger one under a finger, and the area that grabs it
 * (a 44 px target on touch).
 */
/** The Konva name of a handle's group (the touch gestures leave it to the handle). */
export const BEND_HANDLE_NAME = 'bend-handle';

export const BEND_HANDLE_PX = { ring: { mouse: 9, touch: 12 }, hit: { mouse: 12, touch: 22 } } as const;

/** Scene units for `screenPx` on screen, at the node's absolute scale. */
export function sceneRadius(screenPx: number, absoluteScale: number): number {
  return screenPx / Math.max(Math.abs(absoluteScale), 1e-6);
}

type Ctx = Pick<Konva.Context, 'beginPath' | 'arc' | 'closePath' | 'fillStrokeShape' | 'moveTo' | 'lineTo'>;
type ScaledShape = Pick<Konva.Shape, 'getAbsoluteScale'>;
/** Where the handle is drawn this frame, in the shape's frame (its origin by default). */
type Centre = (shape: ScaledShape) => { x: number; y: number };
const ORIGIN: Centre = () => ({ x: 0, y: 0 });

/** Draws (or hit-tests) a circle `screenPx` across on screen, whatever the scale. */
export function handleCircle(screenPx: number, centre: Centre = ORIGIN) {
  return (ctx: Ctx, shape: ScaledShape) => {
    const r = sceneRadius(screenPx, shape.getAbsoluteScale().x);
    const c = centre(shape);
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2, false);
    ctx.closePath();
    ctx.fillStrokeShape(shape as Konva.Shape);
  };
}

/** The curved arrow inside a handle of `screenPx` radius. */
export function handleArrow(screenPx: number, centre: Centre = ORIGIN) {
  return (ctx: Ctx, shape: ScaledShape) => {
    const r = sceneRadius(screenPx, shape.getAbsoluteScale().x) * 0.55;
    const c = centre(shape);
    const from = (200 * Math.PI) / 180;
    const to = (340 * Math.PI) / 180;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, from, to, false);
    const tip = { x: c.x + r * Math.cos(to), y: c.y + r * Math.sin(to) };
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - r * 0.55, tip.y - r * 0.1);
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - r * 0.1, tip.y + r * 0.55);
    ctx.fillStrokeShape(shape as Konva.Shape);
  };
}

/**
 * Where an end's handle is this frame: on the end's connection as its brick
 * is drawn now (liveDragPose nodePoint), so it follows a drag, a turn or a bend before
 * it's committed.
 */
export function liveEndCentre(end: Pick<FlexEnd, 'brickId' | 'local'>): Centre {
  return (shape) => nodePointIn(shape as unknown as Konva.Node, end.brickId, end.local);
}

interface Props {
  map: BbmMap;
  doc: Y.Doc;
  selection: readonly string[];
  partsByKey: Map<string, PartWire>;
  modules: readonly SidecarModule[];
  editingModuleId: string | null;
  /** Kept for the callers; the handle reads the stage's scale as it draws. */
  zoom?: number;
  touch: boolean;
  /**
   * The finger's halo: drawn under the parts (rendered before them), it
   * takes a finger within the 44 px target where it isn't on a part, so a
   * finger on a short flex set still moves the set. The rings, on top,
   * take a finger on them.
   */
  halo?: boolean;
}

export function BendHandles({ map, doc, selection, partsByKey, modules, editingModuleId, touch, halo = false }: Props) {
  const ends = useMemo(
    () => flexRunEnds(map, selection, partsByKey).filter((e) => !pinnedAmong(e.run, modules, editingModuleId)),
    [map, selection, partsByKey, modules, editingModuleId],
  );
  // The first time, a tip says what the handle does.
  // They stay while a run bends, following its ends (nodePoint).
  const shown = ends.length > 0;
  useEffect(() => {
    if (!shown || halo) return;
    try {
      if (localStorage.getItem('cld:hint:bendHandle')) return;
      localStorage.setItem('cld:hint:bendHandle', '1');
    } catch {
      /* no storage: say it anyway */
    }
    useEditorStore.getState().showStatusMessage('Drag the round handle at the end of the flex track to bend it', 8000);
  }, [shown, halo]);
  // The handles are drawn where their parts' nodes are when their layer
  // draws, so the layer must draw again whenever the parts do (a drag on
  // the drag layer, a bend, an undo, someone else's edit); otherwise it
  // shows, and hit-tests, where the ends were: a handle left over the
  // middle of a straightened run caught a double-click meant for a part.
  const groupRef = useRef<Konva.Group>(null);
  useEffect(() => {
    if (!shown) return;
    const own = groupRef.current?.getLayer();
    const stage = own?.getStage();
    if (!own || !stage) return;
    const parts = stage.getLayers().filter((l) => l !== own && (l.hasName('parts-layer') || l.hasName(DRAG_LAYER)));
    const redraw = () => own.batchDraw();
    for (const l of parts) l.on('draw.bend-handles', redraw);
    own.batchDraw();
    return () => {
      for (const l of parts) l.off('draw.bend-handles');
    };
  }, [shown, ends]);
  if (!shown || (halo && !touch)) return null;

  const ring = touch ? BEND_HANDLE_PX.ring.touch : BEND_HANDLE_PX.ring.mouse;
  // The ring takes a pointer within 12 px; the halo, under the parts, a finger within 22.
  const hit = halo ? BEND_HANDLE_PX.hit.touch : BEND_HANDLE_PX.hit.mouse;
  const start = (e: KonvaEventObject<MouseEvent | TouchEvent>, end: FlexEnd) => {
    if ('button' in e.evt && e.evt.button !== 0) return;
    e.cancelBubble = true;
    const stage = e.target.getStage();
    if (!stage) return;
    startFlexSession({
      stage,
      doc,
      map,
      layerId: end.layerId,
      grabbedId: end.brickId,
      chain: end.run,
      activeConnection: end.connection,
      mouseStuds: end.world,
      partsByKey,
      modules,
      label: 'Bend flex track',
      onEnd: () => undefined,
    });
  };
  return (
    <Group ref={groupRef} name={`${EXPORT_HIDE} ${halo ? 'bend-halos' : 'bend-rings'}`}>
      {ends.map((end) => (
        <Group
          key={`${end.brickId}:${end.connection}`}
          name={BEND_HANDLE_NAME}
          x={end.world.x * PX}
          y={end.world.y * PX}
          onMouseDown={(e) => start(e, end)}
          onTouchStart={(e) => start(e, end)}
          onMouseEnter={(e) => {
            const c = e.target.getStage()?.container();
            if (c) c.style.cursor = 'grab';
          }}
          onMouseLeave={(e) => {
            const c = e.target.getStage()?.container();
            if (c) c.style.cursor = '';
          }}
        >
          {/* Drawn at the scale the stage has when it draws, so the
              handle stays the same size on screen at every zoom, also
              mid-pinch. */}
          {halo ? (
            <Shape sceneFunc={() => undefined} hitFunc={handleCircle(hit, liveEndCentre(end))} fill="#000" />
          ) : (
            <>
              {/* Drawn at the scale the stage has when it draws, so the
                  handle stays the same size on screen at every zoom, also
                  mid-pinch, and where its end is drawn now (nodePoint). */}
              <Shape
                sceneFunc={handleCircle(ring, liveEndCentre(end))}
                hitFunc={handleCircle(hit, liveEndCentre(end))}
                fill="#ffd700"
                stroke="#ffffff"
                strokeWidth={2}
                strokeScaleEnabled={false}
                shadowColor="#000"
                shadowBlur={4}
                shadowOpacity={0.35}
              />
              {/* A curved arrow: bend. */}
              <Shape sceneFunc={handleArrow(ring, liveEndCentre(end))} stroke="#141414" strokeWidth={1.6} strokeScaleEnabled={false} listening={false} />
            </>
          )}
        </Group>
      ))}
    </Group>
  );
}
