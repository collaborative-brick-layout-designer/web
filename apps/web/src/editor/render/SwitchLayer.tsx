// The switches' arrows (trains design 6.3): on each switch, a short arrow
// along the leg it is set to, and the other legs faint, so anyone can see
// which way a train will go. Shown in Run mode, and while editing with
// View › Switches. Hidden when zoomed out too far for track to read. The
// desktop draws the same (src/rendering/SceneBuilderSwitches.cpp).

import { Arrow, Circle, Group, Line } from 'react-konva';
import { useMemo } from 'react';
import type { TrackNetwork } from '@cld/parts-catalog/browser';
import { switchArrows } from '../trackSwitches';

const PX = 8; // studs → pixels
/** Below this many screen pixels a stud, track is too small to read: no arrows. */
const MIN_PX_PER_STUD = 1.2;
export const SWITCH_SET_COLOR = '#16A34A';
export const SWITCH_TURNED_COLOR = '#EA580C';

interface Props {
  net: TrackNetwork;
  states: Readonly<Record<string, number>>;
  zoom: number;
}

export function SwitchLayer({ net, states, zoom }: Props) {
  const arrows = useMemo(() => switchArrows(net, states), [net, states]);
  if (arrows.length === 0 || PX * zoom < MIN_PX_PER_STUD) return null;
  // At least a few screen pixels wide, so they read at any zoom.
  const w = Math.max(1.1 * PX, 3 / zoom);
  const px = (pts: number[]) => pts.map((v) => v * PX);
  return (
    <Group name="switch-arrows" listening={false}>
      {arrows.map((a) => (
        <Group key={a.key} name={`switch-${a.key}`}>
          {a.others.map((o, i) => (
            <Line key={i} points={px(o)} stroke="#9CA3AF" strokeWidth={w * 0.45} opacity={0.8} lineCap="round" dash={[w, w]} perfectDrawEnabled={false} />
          ))}
          <Line points={px(a.set)} stroke="#FFFFFF" strokeWidth={w * 1.6} lineCap="round" lineJoin="round" perfectDrawEnabled={false} />
          <Arrow
            points={px(a.set)}
            stroke={a.turned ? SWITCH_TURNED_COLOR : SWITCH_SET_COLOR}
            fill={a.turned ? SWITCH_TURNED_COLOR : SWITCH_SET_COLOR}
            strokeWidth={w}
            pointerLength={w * 1.8}
            pointerWidth={w * 2.2}
            lineCap="round"
            lineJoin="round"
            perfectDrawEnabled={false}
          />
          <Circle x={a.set[0]! * PX} y={a.set[1]! * PX} radius={w * 0.9} fill="#FFFFFF" stroke={a.turned ? SWITCH_TURNED_COLOR : SWITCH_SET_COLOR} strokeWidth={w * 0.5} perfectDrawEnabled={false} />
        </Group>
      ))}
    </Group>
  );
}
