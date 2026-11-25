// Dragging cars along the track (Live Ops design 2.3): over each car that
// stands on the track, a shape that takes the pointer. A click picks the
// car (CarBar); a drag pulls it along the track, with the cars on the side
// it goes to (an engine takes its whole train), and shows where they would
// stop and what they would couple to. With a finger the car is picked
// first, so a pan that starts on one moves the map.

import { useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import type Konva from 'konva';
import { Group, Rect } from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { placeTrain, startDrag, type CutDrag, type CutMove, type PlacedTrain, type RollingStock, type TrackNetwork, type Train } from '@cld/parts-catalog/browser';
import type { PartWire } from '../../api';
import { moveText, writeCutChange } from '../cuts';
import { useEditorStore } from '../editorStore';
import { makeId } from '../mutations';
import { TrainLayer } from './TrainLayer';

const PX = 8;
export const CAR_HIT_NAME = 'car-hit';

interface Props {
  doc: Y.Doc;
  net: TrackNetwork;
  trains: readonly Train[];
  placed: ReadonlyMap<string, PlacedTrain | null>;
  stock: ReadonlyMap<string, RollingStock>;
  states: Readonly<Record<string, number>>;
  partsByKey: ReadonlyMap<string, PartWire>;
  zoom: number;
}

const none: ReadonlyMap<string, PlacedTrain | null> = new Map();

export function CarDragLayer({ doc, net, trains, placed, stock, states, partsByKey, zoom }: Props) {
  const picked = useEditorStore((s) => s.pickedCar);
  const [move, setMove] = useState<CutMove | null>(null);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  // The pointer reads the layout as it was when the drag began; a change meanwhile (someone else's) ends it.
  const during = useRef('');
  useEffect(() => {
    if (!stop.current || during.current === JSON.stringify(trains)) return;
    stop.current();
    useEditorStore.getState().showStatusMessage('Someone else moved cars. Drag again.', 4000);
  }, [trains]);

  const start = (e: KonvaEventObject<MouseEvent | TouchEvent>, train: Train, unit: number, car: string) => {
    if ('button' in e.evt && e.evt.button !== 0) return;
    const touch = 'touches' in e.evt;
    if ('touches' in e.evt && e.evt.touches.length > 1) return;
    const stage = e.target.getStage();
    if (!stage) return;
    e.cancelBubble = true;
    const isPicked = useEditorStore.getState().pickedCar === car;
    const at = (evt: MouseEvent | TouchEvent): { x: number; y: number } => {
      const p = 'touches' in evt ? (evt.touches[0] ?? evt.changedTouches[0])! : evt;
      const box = (stage as Konva.Stage).container().getBoundingClientRect();
      const st = useEditorStore.getState();
      return { x: (p.clientX - box.left - st.panX) / st.zoom / PX, y: (p.clientY - box.top - st.panY) / st.zoom / PX };
    };
    const from = at(e.evt);
    const slop = (touch ? 10 : 4) / useEditorStore.getState().zoom / PX;
    let drag: CutDrag | null = null;
    let moved = false;
    let latest: CutMove | null = null;
    const mid = placed.get(train.id)!.units[unit]!.centre;
    const onMove = (evt: MouseEvent | TouchEvent) => {
      if ('touches' in evt && evt.touches.length > 1) return end(false);
      const p = at(evt);
      if (!moved) {
        if (Math.hypot(p.x - from.x, p.y - from.y) < slop) return;
        moved = true;
        // (An unpicked car under a finger: the map moves.)
        if (touch && !isPicked) return end(false);
        drag = startDrag(net, trains, stock, states, train.id, unit, makeId());
      }
      latest = drag?.to({ x: mid.x + p.x - from.x, y: mid.y + p.y - from.y }) ?? null;
      setMove(latest);
    };
    const end = (drop: boolean) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
      window.removeEventListener('touchcancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      stop.current = null;
      setMove(null);
      const st = useEditorStore.getState();
      if (!drop) return;
      if (!moved) {
        st.setPickedCar(car);
        return;
      }
      if (!latest) return;
      const text = moveText(latest, trains, stock);
      writeCutChange(doc, latest.change);
      if (text) st.showStatusMessage(text, 4000);
    };
    const onUp = () => end(true);
    const onCancel = () => end(false);
    const onKey = (k: KeyboardEvent) => {
      if (k.key !== 'Escape') return;
      k.stopPropagation();
      end(false);
    };
    stop.current?.();
    stop.current = () => end(false);
    during.current = JSON.stringify(trains);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove);
    window.addEventListener('touchend', onUp);
    window.addEventListener('touchcancel', onCancel);
    window.addEventListener('keydown', onKey, true);
  };

  const ghost = move ? move.change.trains.filter((t) => t.units.some((u) => move.moved.includes(u.stock))) : [];
  const ghostPlaced = move ? new Map(ghost.map((t) => [t.id, placeTrain(net, t, stock, states)])) : none;
  return (
    <Group name="car-drag">
      {trains.map((t) =>
        placed.get(t.id)?.units.map((u, i) => {
          const s = stock.get(u.stock);
          if (!s) return null;
          const len = Math.max(s.bodyLength || s.length - 2, 4) * PX;
          // At least a fingertip wide.
          const wid = Math.max(s.width * PX, 20 / zoom);
          const on = picked === u.stock;
          return (
            <Rect
              key={`${t.id}:${i}`}
              name={CAR_HIT_NAME}
              id={u.stock}
              x={u.centre.x * PX}
              y={u.centre.y * PX}
              offsetX={len / 2}
              offsetY={wid / 2}
              width={len}
              height={wid}
              rotation={u.angle}
              fill="rgba(0,0,0,0)"
              {...(on ? { stroke: '#1D4ED8', strokeWidth: 3 / zoom, dash: [8 / zoom, 4 / zoom] } : {})}
              perfectDrawEnabled={false}
              onMouseDown={(e) => start(e, t, i, u.stock)}
              onTouchStart={(e) => start(e, t, i, u.stock)}
              onMouseEnter={(e) => {
                const c = e.target.getStage()?.container();
                if (c) c.style.cursor = 'grab';
              }}
              onMouseLeave={(e) => {
                const c = e.target.getStage()?.container();
                if (c) c.style.cursor = '';
              }}
            />
          );
        }),
      )}
      {ghost.length > 0 && (
        <Group opacity={0.7} listening={false}>
          <TrainLayer name="car-ghost" trains={ghost} placed={ghostPlaced} stock={stock} partsByKey={partsByKey} zoom={zoom} picked={ghost[0]!.id} />
        </Group>
      )}
    </Group>
  );
}
