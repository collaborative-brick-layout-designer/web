// Render LayerRuler items — port of SceneBuilder ruler rendering at
// rendering/SceneBuilder.cpp:498-748 (linear) and 718-746 (circular).
//
// Faithful coverage of the desktop's behaviour:
//   - resolves attached endpoints to the attached brick's CURRENT
//     world centre, so a ruler "follows" its bricks when they move
//   - honours `AllowOffset` + `OffsetDistance` by translating the
//     visible measure line perpendicular to the anchor pair
//   - splits the main line around the centred distance label so the
//     text doesn't overlap the line
//   - rotates the label to the line angle and 180-flips it when it
//     would render upside-down
//   - draws perpendicular dashed guidelines from each anchor to the
//     offset endpoints when `AllowOffset` fires
//   - draws orange/green anchor dots at attached / free anchor points
//   - draws perpendicular end caps for short rulers without distance
//   - clickable so the editor can wire double-click → Edit Ruler
//
// Inputs are in stud-space; everything multiplies by `studToPx()` (8)
// at the leaves.

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore } from '../editorStore';
import { snapBypassed } from '../snapFeel';
import {
  Group,
  Circle as KonvaCircle,
  Line,
  Text as KonvaText,
} from 'react-konva';
import type Konva from 'konva';
import type {
  BbmMap,
  CircularRulerItem,
  ColorSpec,
  LayerRuler,
  LinearRulerItem,
} from '@cld/model';
import { studToPx, COLOR_DEFAULT } from './coords';
import type { KonvaEventObject } from 'konva/lib/Node';
import type { AnnoDragHandlers } from './groupDragNodes';
import { fontStack } from './fontStack';
import { colorSpecToCss } from '../layerOptions';
import { pivotOf } from '../brickGeometry';
import type { PartWire } from '../../api';
import { usePosedMap } from '../liveDragPose';
import { SELECTION, rulerHaloWidth } from './selectionStyle';
import { coarsePointer } from '../useViewportSize';
import { SHEET_FADE, SHEET_FULL_OPACITY } from './sheetFade';
import { useSheetFade } from './useSheetFade';

interface Props {
  map: BbmMap;
  /** A viewer isn't editing, so the other sheets never fade. */
  isViewer?: boolean;
  /** Catalog, so an attached end sits on the brick's sprite centre (its pivot). */
  partsByKey?: ReadonlyMap<string, PartWire>;
  /** Rulers in the (mixed) selection — drawn with a halo. */
  selectedRulerIds?: ReadonlySet<string>;
  /** The one ruler whose endpoint handles are shown (single ruler selected). */
  handleRulerId?: string | null;
  /** Mouse-down on a ruler; `additive` = Shift/Ctrl held (toggle). */
  onRulerSelect?: (rulerId: string, additive: boolean) => void;
  /** Drag a ruler together with the rest of the selection (MapViewDrag.cpp:412-450). */
  drag?: AnnoDragHandlers;
  onRulerDoubleClick?: (rulerId: string) => void;
  /**
   * Called continuously while the user drags a linear-ruler endpoint
   * handle and on release, with `which` = 0 / 1 (point1 / point2) and
   * `free` when Alt is held (the end goes where the pointer is, not on the
   * grid). Mirrors desktop's `MoveRulerEndpointCommand` flow at MapView.cpp:
   * 547-589 (live model mutate) + 680-724 (release commits).
   */
  onEndpointDrag?: (
    rulerId: string,
    which: 0 | 1,
    studX: number,
    studY: number,
    free: boolean,
  ) => void;
  /**
   * BlueBrick ScaleRuler: dragging the middle of a linear ruler's offset
   * line (when it allows an offset) or a circle's rim handle, live and on
   * release, with the pointer in studs.
   */
  onScaleDrag?: (rulerId: string, studX: number, studY: number) => void;
}

export function RulerLayers({
  map: committedMap,
  isViewer = false,
  partsByKey,
  selectedRulerIds,
  handleRulerId = null,
  onRulerSelect,
  drag,
  onRulerDoubleClick,
  onEndpointDrag,
  onScaleDrag,
}: Props) {
  // The parts being dragged where they are now (liveDragPose.ts), so this
  // follows the drag every frame, not only the drop.
  const map = usePosedMap(committedMap, (pose) =>
    committedMap.layers.some(
      (l) =>
        l.type === 'ruler' &&
        l.rulerItems.some((r) => (r.kind === 'linear' ? pose.ids.has(r.attachedBrick1Id) || pose.ids.has(r.attachedBrick2Id) : pose.ids.has(r.attachedBrickId))),
    ),
  );
  const layers = map.layers.filter(
    (l): l is LayerRuler => l.type === 'ruler' && l.visible,
  );
  // The centres of the parts the rulers are attached to, by id. Only
  // those: on 7,520 parts, working out every part's centre after each
  // change (anyone's move) took about 20 ms at 4x slowed CPU. And the same
  // Map while they stay put, so the rulers aren't rendered again.
  const centresKept = useRef<Map<string, { x: number; y: number }>>(new Map());
  const brickCentres = useMemo(() => {
    const attached = new Set<string>();
    for (const layer of map.layers) {
      if (layer.type !== 'ruler') continue;
      for (const r of layer.rulerItems) {
        for (const id of r.kind === 'linear' ? [r.attachedBrick1Id, r.attachedBrick2Id] : [r.attachedBrickId]) if (id) attached.add(id);
      }
    }
    const m = new Map<string, { x: number; y: number }>();
    if (attached.size > 0) {
      for (const layer of map.layers) {
        if (layer.type !== 'brick') continue;
        for (const b of layer.bricks) {
          // Attached ends follow the sprite centre, like desktop
          // SceneBuilder brickCentreByGuid_ (imageCentre).
          if (attached.has(b.id)) m.set(b.id, pivotOf(b, partsByKey?.get(b.partNumber.toLowerCase())));
        }
      }
    }
    const was = centresKept.current;
    let same = was.size === m.size;
    if (same) {
      for (const [id, c] of m) {
        const w = was.get(id);
        if (!w || w.x !== c.x || w.y !== c.y) {
          same = false;
          break;
        }
      }
    }
    if (!same) centresKept.current = m;
    return centresKept.current;
  }, [map, partsByKey]);

  // The editor re-renders this on every frame of a box-select drag. The
  // handlers it passes are new each time, so they're called through a ref
  // and each ruler is memoised on what it draws: a ruler redraws (and its
  // sheet with every part on it) only when it changes. New point arrays on
  // every render used to redraw the whole parts layer on each mouse move.
  const live = useRef({ onRulerSelect, drag, onRulerDoubleClick, onEndpointDrag, onScaleDrag });
  live.current = { onRulerSelect, drag, onRulerDoubleClick, onEndpointDrag, onScaleDrag };
  const stable = useMemo(
    () => ({
      select: (id: string, additive: boolean) => live.current.onRulerSelect?.(id, additive),
      drag: {
        start: (kind, id, node) => live.current.drag?.start(kind, id, node),
        move: (node, evt) => live.current.drag?.move(node, evt),
        end: (node) => live.current.drag?.end(node),
      } satisfies AnnoDragHandlers,
    }),
    [],
  );
  const fade = useSheetFade(isViewer);

  if (layers.length === 0) return null;
  return (
    <Group>
      {layers.map((layer) => {
        const opacity = Math.max(0, Math.min(100, layer.transparency)) / 100;
        return (
          <Group key={layer.id} name={SHEET_FADE} opacity={opacity * fade(layer.id)} {...{ [SHEET_FULL_OPACITY]: opacity }}>
            {layer.rulerItems.map((item) => {
              const sel = !!selectedRulerIds?.has(item.id);
              // `key` must be passed directly to JSX, not spread from a
              // props object — React 19 warns (and doesn't reliably use
              // it for reconciliation) when key rides along in a spread.
              const props: {
                brickCentres: typeof brickCentres;
                selected: boolean;
                showHandles: boolean;
                rootProps: RulerRootProps;
                onClick?: () => void;
                onDoubleClick?: () => void;
                onEndpointDrag?: (which: 0 | 1, studX: number, studY: number, free: boolean) => void;
                onScaleDrag?: (studX: number, studY: number) => void;
              } = {
                brickCentres,
                selected: sel,
                showHandles: item.id === handleRulerId,
                rootProps: rulerRootProps(item.id, sel, onRulerSelect && stable.select, drag && stable.drag),
              };
              if (onRulerSelect) props.onClick = () => undefined;
              if (onRulerDoubleClick) props.onDoubleClick = () => live.current.onRulerDoubleClick?.(item.id);
              if (onEndpointDrag) {
                props.onEndpointDrag = (which, sx, sy, free) =>
                  live.current.onEndpointDrag?.(item.id, which, sx, sy, free);
              }
              if (onScaleDrag) props.onScaleDrag = (sx, sy) => live.current.onScaleDrag?.(item.id, sx, sy);
              return item.kind === 'linear' ? (
                <LinearRulerView key={item.id} item={item} {...props} />
              ) : (
                <CircularRulerView key={item.id} item={item} {...props} />
              );
            })}
          </Group>
        );
      })}
    </Group>
  );
}

/** Props for a ruler view's root Group: name, selection on press, drag. */
interface RulerRootProps {
  name: string;
  draggable?: boolean;
  onMouseDown?: (e: KonvaEventObject<MouseEvent>) => void;
  onDragStart?: (e: KonvaEventObject<DragEvent>) => void;
  onDragMove?: (e: KonvaEventObject<DragEvent>) => void;
  onDragEnd?: (e: KonvaEventObject<DragEvent>) => void;
}

function rulerRootProps(
  id: string,
  selected: boolean,
  onSelect: Props['onRulerSelect'],
  drag: AnnoDragHandlers | undefined,
): RulerRootProps {
  const out: RulerRootProps = { name: `ruler-${id}` };
  if (onSelect) {
    out.onMouseDown = (e) => {
      if (e.evt.button !== 0) return;
      // Endpoint handles manage their own presses.
      if (e.target.name() === 'ruler-endpoint') return;
      e.cancelBubble = true;
      const additive = e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey;
      // Pressing an already-selected ruler keeps the mixed selection so
      // the drag moves all of it.
      if (additive || !selected) onSelect(id, additive);
    };
  }
  if (drag) {
    // Drag events bubble up from the endpoint handles; only react to the
    // ruler Group's own drag.
    out.draggable = true;
    out.onDragStart = (e) => { if (e.target === e.currentTarget) drag.start('rulers', id, e.target); };
    out.onDragMove = (e) => { if (e.target === e.currentTarget) drag.move(e.target, e.evt); };
    out.onDragEnd = (e) => { if (e.target === e.currentTarget) drag.end(e.target); };
  }
  return out;
}

function resolveAnchor(
  attachedBrickId: string,
  fallback: { x: number; y: number },
  brickCentres: Map<string, { x: number; y: number }>,
): { x: number; y: number } {
  if (!attachedBrickId) return fallback;
  return brickCentres.get(attachedBrickId) ?? fallback;
}

/**
 * Whether a ruler view would draw the same: everything but the handlers,
 * which RulerLayers routes through a ref (so a new one is the same one),
 * compared by being there or not.
 */
export function sameRulerView(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = a[k];
    const y = b[k];
    if (typeof x === 'function' || typeof y === 'function') {
      if (typeof x !== typeof y) return false;
      continue;
    }
    if (k === 'rootProps') {
      const p = x as RulerRootProps;
      const q = y as RulerRootProps;
      if (p.name !== q.name || p.draggable !== q.draggable || !p.onMouseDown !== !q.onMouseDown || !p.onDragStart !== !q.onDragStart) return false;
      continue;
    }
    if (x !== y) return false;
  }
  return true;
}

const LinearRulerView = memo(function LinearRulerView({
  item,
  brickCentres,
  selected,
  showHandles,
  rootProps,
  onClick,
  onDoubleClick,
  onEndpointDrag,
  onScaleDrag,
}: {
  item: LinearRulerItem;
  brickCentres: Map<string, { x: number; y: number }>;
  selected: boolean;
  showHandles: boolean;
  rootProps: RulerRootProps;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onEndpointDrag?: (which: 0 | 1, studX: number, studY: number, free: boolean) => void;
  onScaleDrag?: (studX: number, studY: number) => void;
}) {
  const PX = studToPx();
  const showRulerAttachPoints = useEditorStore((s) => s.showRulerAttachPoints);
  const p1Stud = resolveAnchor(item.attachedBrick1Id, item.point1, brickCentres);
  const p2Stud = resolveAnchor(item.attachedBrick2Id, item.point2, brickCentres);
  const a1 = { x: p1Stud.x * PX, y: p1Stud.y * PX };
  const a2 = { x: p2Stud.x * PX, y: p2Stud.y * PX };
  const dx = a2.x - a1.x;
  const dy = a2.y - a1.y;
  const lenPx = Math.hypot(dx, dy);

  // Offset measure line — perpendicular to the anchor pair.
  // Vanilla normal is `(uy, -ux)` — see SceneBuilder.cpp:531-532.
  const needOffset =
    item.allowOffset && Math.abs(item.offsetDistance) > 0.001 && lenPx > 0.001;
  let nrm = { x: 0, y: 0 };
  if (lenPx > 0.001) nrm = { x: dy / lenPx, y: -dx / lenPx };
  const offPx = needOffset ? item.offsetDistance * PX : 0;
  const o1 = { x: a1.x + nrm.x * offPx, y: a1.y + nrm.y * offPx };
  const o2 = { x: a2.x + nrm.x * offPx, y: a2.y + nrm.y * offPx };

  const stroke = cssColor(item.color);
  const strokeWidth = Math.max(0.5, item.lineThickness);

  // Distance label — sized 6 % of pixel length, clamped 9-36 px,
  // matching SceneBuilder.cpp:575-576. Bold/italic from font.style.
  const distStuds = Math.hypot(p2Stud.x - p1Stud.x, p2Stud.y - p1Stud.y);
  const labelText = item.displayDistance
    ? item.displayUnit
      ? formatDistance(distStuds, item.unit)
      : distStuds.toFixed(2)
    : null;
  const labelFontPx = Math.max(9, Math.min(36, lenPx * 0.06));
  const labelFontStyle = parseFontStyle(item.measureFont.style);

  // Compute label dimensions via a hidden Konva text + a measure ref.
  // The width determines how big a gap to leave in the main line.
  const textRef = useRef<Konva.Text | null>(null);
  const [labelWidth, setLabelWidth] = useState(0);
  useEffect(() => {
    if (!labelText) return;
    const node = textRef.current;
    if (!node) return;
    const r = node.getClientRect({ skipTransform: true });
    setLabelWidth(r.width);
  }, [labelText, labelFontPx, labelFontStyle, item.measureFont.family]);

  const halfText = labelWidth / 2 + 6;

  // Label rotation — flipped 180° when the line angle would put the
  // text upside-down (SceneBuilder.cpp:562-564).
  let angleDeg = 0;
  if (lenPx > 0.001) {
    angleDeg = (Math.atan2(o2.y - o1.y, o2.x - o1.x) * 180) / Math.PI;
    if (angleDeg > 90 || angleDeg < -90) angleDeg += 180;
  }

  const midX = (o1.x + o2.x) / 2;
  const midY = (o1.y + o2.y) / 2;

  // Unit vector along the offset line, used to split the main line
  // around the label.
  const ux = lenPx > 0.001 ? dx / lenPx : 1;
  const uy = lenPx > 0.001 ? dy / lenPx : 0;
  const splitOnLine = labelText && halfText * 2 < lenPx - 8;
  const seg1End = splitOnLine ? { x: midX - ux * halfText, y: midY - uy * halfText } : o2;
  const seg2Start = splitOnLine ? { x: midX + ux * halfText, y: midY + uy * halfText } : o1;

  // Short ruler without a distance label gets perpendicular end-caps
  // at each endpoint (SceneBuilder.cpp:638-673).
  const drawEndCaps = !item.displayDistance && distStuds < 4 && lenPx > 0.001;
  const capPx = 4 * PX;
  const perp = { x: dy / Math.max(0.001, lenPx), y: -dx / Math.max(0.001, lenPx) };

  // Hit-target for click/double-click — a thicker invisible line
  // along the visible measure line so the user doesn't have to hit
  // the 1-2px stroke.
  const HIT_PX = 12;

  // Anchor dots: drawn ONLY when the offset is in effect (matches
  // desktop SceneBuilder.cpp:694-716; without offset, the visible
  // ruler ends are the anchor points).
  const anchorMarkers: Array<{ x: number; y: number; attached: boolean }> = [];
  if (needOffset) {
    anchorMarkers.push({ x: a1.x, y: a1.y, attached: !!item.attachedBrick1Id });
    anchorMarkers.push({ x: a2.x, y: a2.y, attached: !!item.attachedBrick2Id });
  }

  // Guideline dash pattern: BlueBrick uses lengths in studs; Konva
  // wants px.
  const dash = item.guidelineDashPattern.length >= 2
    ? item.guidelineDashPattern.filter((d) => d > 0)
    : [4, 4];
  const guidelineStroke = cssColor(item.guidelineColor);
  const guidelineWidth = Math.max(0.5, item.guidelineThickness);

  return (
    <Group {...rootProps}>
      {/* Main measure line(s). */}
      {splitOnLine ? (
        <>
          <Line
            points={[o1.x, o1.y, seg1End.x, seg1End.y]}
            stroke={stroke}
            strokeWidth={strokeWidth}
            lineCap="butt"
            listening={false}
            perfectDrawEnabled={false}
          />
          <Line
            points={[seg2Start.x, seg2Start.y, o2.x, o2.y]}
            stroke={stroke}
            strokeWidth={strokeWidth}
            lineCap="butt"
            listening={false}
            perfectDrawEnabled={false}
          />
        </>
      ) : (
        <Line
          points={[o1.x, o1.y, o2.x, o2.y]}
          stroke={stroke}
          strokeWidth={strokeWidth}
          lineCap="butt"
          listening={false}
          perfectDrawEnabled={false}
        />
      )}

      {/* Distance label, rotated and flipped to stay readable. */}
      {labelText && (
        <KonvaText
          ref={textRef}
          x={midX}
          y={midY}
          text={labelText}
          fontFamily={fontStack(item.measureFont.family)}
          fontStyle={labelFontStyle}
          fontSize={labelFontPx}
          fill={cssColor(item.measureFontColor)}
          offsetX={labelWidth / 2}
          offsetY={labelFontPx / 2}
          rotation={angleDeg}
          listening={false}
          perfectDrawEnabled={false}
        />
      )}

      {/* End caps for short rulers without a label. */}
      {drawEndCaps && (
        <>
          <Line
            points={[
              o1.x + perp.x * capPx,
              o1.y + perp.y * capPx,
              o1.x - perp.x * capPx,
              o1.y - perp.y * capPx,
            ]}
            stroke={guidelineStroke}
            strokeWidth={guidelineWidth}
            dash={dash}
            listening={false}
            perfectDrawEnabled={false}
          />
          <Line
            points={[
              o2.x + perp.x * capPx,
              o2.y + perp.y * capPx,
              o2.x - perp.x * capPx,
              o2.y - perp.y * capPx,
            ]}
            stroke={guidelineStroke}
            strokeWidth={guidelineWidth}
            dash={dash}
            listening={false}
            perfectDrawEnabled={false}
          />
        </>
      )}

      {/* Perpendicular guidelines + anchor dots when offset is on. */}
      {needOffset && (
        <>
          <Line
            points={[a1.x, a1.y, o1.x, o1.y]}
            stroke={guidelineStroke}
            strokeWidth={guidelineWidth}
            dash={dash}
            listening={false}
            perfectDrawEnabled={false}
          />
          <Line
            points={[a2.x, a2.y, o2.x, o2.y]}
            stroke={guidelineStroke}
            strokeWidth={guidelineWidth}
            dash={dash}
            listening={false}
            perfectDrawEnabled={false}
          />
        </>
      )}
      {/* Anchor attachment dots — shown when ruler has an offset OR when the
          view/rulerAttachPoints toggle is on. Orange = free endpoint,
          green = attached to a brick. Port of SceneBuilder.cpp anchor dots. */}
      {(needOffset || showRulerAttachPoints) && anchorMarkers.map((m, i) => (
        <KonvaCircle
          key={i}
          x={m.x}
          y={m.y}
          radius={4}
          fill={m.attached ? 'rgb(30,180,60)' : 'rgb(240,140,30)'}
          stroke="rgb(40,40,40)"
          strokeWidth={1.5}
          listening={false}
          perfectDrawEnabled={false}
        />
      ))}

      {/* Selection halo on the offset line. */}
      {selected && (
        <Line
          points={[o1.x, o1.y, o2.x, o2.y]}
          name="export-hide"
          stroke={SELECTION.rulerHalo}
          strokeWidth={rulerHaloWidth(strokeWidth)}
          listening={false}
          perfectDrawEnabled={false}
        />
      )}

      {/* Invisible thick hit-target. */}
      {(onClick || onDoubleClick) && (
        <Line
          points={[o1.x, o1.y, o2.x, o2.y]}
          stroke="transparent"
          strokeWidth={HIT_PX}
          onClick={(e) => {
            e.cancelBubble = true;
            onClick?.();
          }}
          onTap={(e) => {
            e.cancelBubble = true;
            onClick?.();
          }}
          onDblClick={(e) => {
            e.cancelBubble = true;
            onDoubleClick?.();
          }}
          onDblTap={(e) => {
            e.cancelBubble = true;
            onDoubleClick?.();
          }}
        />
      )}

      {/* Endpoint reshape handles — only visible when this ruler is
          selected. Drag → MoveRulerEndpointCommand. Mirrors desktop
          MapView.cpp:399-444 (hit-test) + 547-589 (live drag) +
          680-724 (release commit). 0.8-stud * 1.5 = ~10px hit radius
          at native scale (port of MapView.cpp:409-410). */}
      {showHandles && onEndpointDrag && (
        <>
          <EndpointHandle x={a1.x} y={a1.y} which={0} onDrag={onEndpointDrag} />
          <EndpointHandle x={a2.x} y={a2.y} which={1} onDrag={onEndpointDrag} />
        </>
      )}
      {showHandles && onScaleDrag && item.allowOffset && (
        <ScaleHandle x={(a1.x + a2.x) / 2 + nrm.x * item.offsetDistance * PX} y={(a1.y + a2.y) / 2 + nrm.y * item.offsetDistance * PX} onDrag={onScaleDrag} />
      )}
    </Group>
  );
}, sameRulerView);

/**
 * A ruler handle's radius. With a mouse, the desktop's (scene px). By
 * touch, a fingertip's at any zoom: 12 px on screen, and 10 px more around
 * it that a finger still catches.
 */
function useHandleSize(): { radius: number; hitStrokeWidth?: number } {
  const zoom = useEditorStore((s) => s.stageView.zoom);
  if (!coarsePointer()) return { radius: SELECTION.handleRadius };
  return { radius: 12 / (zoom > 0 ? zoom : 1), hitStrokeWidth: 20 };
}

/** BlueBrick ScaleRuler's handle: the offset line's middle, or a circle's rim. */
function ScaleHandle({ x, y, onDrag }: { x: number; y: number; onDrag: (studX: number, studY: number) => void }) {
  const PX = studToPx();
  const size = useHandleSize();
  const report = (e: KonvaEventObject<DragEvent>) => {
    e.cancelBubble = true;
    onDrag(e.target.x() / PX, e.target.y() / PX);
  };
  return (
    <KonvaCircle
      name="ruler-scale"
      x={x}
      y={y}
      {...size}
      fill={SELECTION.handleStroke}
      stroke={SELECTION.handleFill}
      strokeWidth={SELECTION.handleStrokeWidth}
      strokeScaleEnabled={false}
      draggable
      onDragMove={report}
      onDragEnd={report}
    />
  );
}

/**
 * Draggable endpoint handle on a selected linear ruler. Reports
 * stud-coords on every dragmove (live) and once more on dragend, with
 * `free` when Alt is held. Desktop's `MoveRulerEndpointCommand`
 * (RulerCommands.cpp:203-282) does the same.
 */
function EndpointHandle({
  x,
  y,
  which,
  onDrag,
}: {
  x: number;
  y: number;
  which: 0 | 1;
  onDrag: (which: 0 | 1, studX: number, studY: number, free: boolean) => void;
}) {
  const PX = studToPx();
  const size = useHandleSize();
  return (
    <KonvaCircle
      name="ruler-endpoint"
      x={x}
      y={y}
      {...size}
      fill={SELECTION.handleFill}
      stroke={SELECTION.handleStroke}
      strokeWidth={SELECTION.handleStrokeWidth}
      strokeScaleEnabled={false}
      draggable
      onDragMove={(e) => {
        e.cancelBubble = true;
        const node = e.target;
        onDrag(which, node.x() / PX, node.y() / PX, snapBypassed(e.evt));
      }}
      onDragEnd={(e) => {
        e.cancelBubble = true;
        const node = e.target;
        onDrag(which, node.x() / PX, node.y() / PX, snapBypassed(e.evt));
      }}
    />
  );
}

const CircularRulerView = memo(function CircularRulerView({
  item,
  brickCentres,
  selected,
  showHandles = false,
  rootProps,
  onClick,
  onDoubleClick,
  onScaleDrag,
}: {
  item: CircularRulerItem;
  brickCentres: Map<string, { x: number; y: number }>;
  selected: boolean;
  showHandles?: boolean;
  rootProps: RulerRootProps;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onScaleDrag?: (studX: number, studY: number) => void;
}) {
  const PX = studToPx();
  const cStud = resolveAnchor(item.attachedBrickId, item.center, brickCentres);
  const cx = cStud.x * PX;
  const cy = cStud.y * PX;
  const rPx = Math.max(0, item.radius) * PX;
  const stroke = cssColor(item.color);
  const strokeWidth = Math.max(0.5, item.lineThickness);

  const labelText = item.displayDistance
    ? item.displayUnit
      ? formatDistance(item.radius, item.unit)
      : item.radius.toFixed(2)
    : null;
  const labelFontPx = Math.max(9, Math.min(36, rPx * 0.18));
  const labelFontStyle = parseFontStyle(item.measureFont.style);

  return (
    <Group {...rootProps}>
      <KonvaCircle
        x={cx}
        y={cy}
        radius={rPx}
        stroke={stroke}
        strokeWidth={strokeWidth}
        fillEnabled={false}
        listening={false}
        perfectDrawEnabled={false}
      />
      {labelText && (
        <KonvaText
          x={cx + rPx + 4}
          y={cy - labelFontPx / 2}
          text={labelText}
          fontFamily={fontStack(item.measureFont.family)}
          fontStyle={labelFontStyle}
          fontSize={labelFontPx}
          fill={cssColor(item.measureFontColor)}
          listening={false}
          perfectDrawEnabled={false}
        />
      )}
      {selected && (
        <KonvaCircle
          x={cx}
          y={cy}
          radius={rPx}
          name="export-hide"
          stroke={SELECTION.rulerHalo}
          strokeWidth={rulerHaloWidth(strokeWidth)}
          fillEnabled={false}
          listening={false}
          perfectDrawEnabled={false}
        />
      )}
      {(onClick || onDoubleClick) && (
        <KonvaCircle
          x={cx}
          y={cy}
          radius={rPx}
          stroke="transparent"
          strokeWidth={12}
          fillEnabled={false}
          onClick={(e) => {
            e.cancelBubble = true;
            onClick?.();
          }}
          onTap={(e) => {
            e.cancelBubble = true;
            onClick?.();
          }}
          onDblClick={(e) => {
            e.cancelBubble = true;
            onDoubleClick?.();
          }}
          onDblTap={(e) => {
            e.cancelBubble = true;
            onDoubleClick?.();
          }}
        />
      )}
      {showHandles && onScaleDrag && <ScaleHandle x={cx + rPx} y={cy} onDrag={onScaleDrag} />}
    </Group>
  );
}, sameRulerView);

function parseFontStyle(style: string | undefined): string {
  const s = (style ?? '').toLowerCase();
  const bold = s.includes('bold');
  const italic = s.includes('italic');
  if (bold && italic) return 'bold italic';
  if (bold) return 'bold';
  if (italic) return 'italic';
  return 'normal';
}

/**
 * Format a stud count exactly like desktop `formatDistance`
 * (rendering/SceneBuilder.cpp:471-483; Tools/Distance.cs Unit enum:
 * 0 STUD, 1 LDU, 2 STRAIGHT_TRACK, 3 MODULE, 4 METER, 5 FEET).
 */
export function formatDistance(studs: number, unit: number): string {
  switch (unit) {
    case 1: // 1 stud = 20 LDU
      return `${(studs * 20).toFixed(0)} LDU`;
    case 2: // 1 straight track = 16 studs
      return `${(studs / 16).toFixed(2)} tracks`;
    case 3: // 1 AFOL module = 96 studs
      return `${(studs / 96).toFixed(2)} mod`;
    case 4:
      return `${(studs * 0.008).toFixed(3)} m`;
    case 5:
      return `${(studs * 0.026248).toFixed(2)} ft`;
    default:
      return `${studs.toFixed(2)} studs`;
  }
}

function cssColor(c: ColorSpec): string {
  return colorSpecToCss(c, COLOR_DEFAULT);
}

