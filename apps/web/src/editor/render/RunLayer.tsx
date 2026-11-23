// Running trains on the map (trains design 5): drawn on their own layer,
// so only it redraws each frame, as TrainLayer draws a train standing still.
// Where two trains would collide, a red ring with "!" marks the spot while
// they stand there. The desktop draws the same (src/ui/MapViewRun.cpp).

import { Circle, Group, Text } from 'react-konva';
import type { RollingStock, Train } from '@cld/parts-catalog/browser';
import type { PartWire } from '../../api';
import { useRunStore } from '../trainRun';
import { TRAIN_PROBLEM_COLOR, TrainLayer } from './TrainLayer';

const PX = 8;

interface Props {
  trains: readonly Train[];
  stock: ReadonlyMap<string, RollingStock>;
  partsByKey: ReadonlyMap<string, PartWire>;
  zoom: number;
}

export function RunLayer({ trains, stock, partsByKey, zoom }: Props) {
  const placed = useRunStore((s) => s.placed);
  const notes = useRunStore((s) => s.notes);
  const trainStates = useRunStore((s) => s.trainStates);
  const running = trains.filter((t) => placed.has(t.id));
  // A collision is marked while the train it stopped is still standing there.
  const marks = notes.filter((n) => n.kind === 'collision' && trainStates[n.train] === 'blocked');
  const r = Math.max(5 * PX, 16 / zoom);
  return (
    <Group name="run-trains" listening={false}>
      <TrainLayer trains={running} placed={placed} stock={stock} partsByKey={partsByKey} zoom={zoom} name="running-trains" />
      {marks.map((n) => (
        <Group key={n.id} name="collision-mark" x={n.at.x * PX} y={n.at.y * PX}>
          <Circle radius={r} stroke={TRAIN_PROBLEM_COLOR} strokeWidth={Math.max(PX * 0.5, 3 / zoom)} fill="rgba(220,38,38,0.18)" perfectDrawEnabled={false} />
          <Text text="!" fontSize={r * 1.2} fontStyle="bold" fill={TRAIN_PROBLEM_COLOR} width={r * 2} height={r * 2} offsetX={r} offsetY={r} align="center" verticalAlign="middle" />
        </Group>
      ))}
    </Group>
  );
}
