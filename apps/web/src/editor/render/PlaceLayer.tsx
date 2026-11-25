// Places on the map (Live Ops design 6): with View › Places, each spot's
// stretch of track as a bracket in its kind's color with the cars it holds,
// and each place's name beside its first spot. The desktop's
// SceneBuilderPlaces.cpp draws the same.

import { Group, Label, Line, Tag, Text } from 'react-konva';
import { capacityText, kindColor, type SpotNow } from '../places';

const PX = 8;
/** The bracket's end marks reach this far each side of the track (studs). */
const TICK = 5;

interface Props {
  /** By spotKey, in place order (places.ts useSpots). */
  spots: ReadonlyMap<string, SpotNow>;
  zoom: number;
}

type Pt = { x: number; y: number };

/** The mark across the track at one end of a line: from `a` towards `b`. */
function tick(a: Pt, b: Pt): number[] {
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = (-(b.y - a.y) / d) * TICK;
  const ny = ((b.x - a.x) / d) * TICK;
  return [(a.x - nx) * PX, (a.y - ny) * PX, (a.x + nx) * PX, (a.y + ny) * PX];
}

export function PlaceLayer({ spots, zoom }: Props) {
  const font = Math.max(10, 12 / zoom);
  const w = Math.max(0.5 * PX, 3 / zoom);
  const named = new Set<string>();
  return (
    <Group name="places" listening={false}>
      {[...spots.values()].map(({ owner, place, spot, at, capacity }) => {
        if (!at || at.line.length === 0) return null;
        const color = kindColor(place.kind);
        const key = `${owner ?? ''}/${place.id}`;
        const first = !named.has(key);
        named.add(key);
        const cars = capacityText(capacity);
        const line = at.line;
        return (
          <Group key={`${key}/${spot.id}`} name="place-spot">
            {line.length > 1 && (
              <>
                <Line points={line.flatMap((p) => [p.x * PX, p.y * PX])} stroke={color} strokeWidth={w * 2} opacity={0.45} lineCap="butt" lineJoin="round" perfectDrawEnabled={false} />
                <Line points={tick(line[0]!, line[1]!)} stroke={color} strokeWidth={w} perfectDrawEnabled={false} />
                <Line points={tick(line[line.length - 1]!, line[line.length - 2]!)} stroke={color} strokeWidth={w} perfectDrawEnabled={false} />
              </>
            )}
            <Label name="place-label" x={at.middle.x * PX} y={at.middle.y * PX} opacity={0.95}>
              <Tag fill={color} cornerRadius={3 / zoom} pointerDirection="down" pointerWidth={6 / zoom} pointerHeight={4 / zoom} />
              <Text
                text={[first ? place.name : '', [place.spots.length > 1 ? spot.name : '', cars ?? ''].filter(Boolean).join(': ')].filter(Boolean).join('\n')}
                fontSize={font}
                padding={3 / zoom}
                fill="#FFFFFF"
                fontStyle="bold"
                align="center"
              />
            </Label>
          </Group>
        );
      })}
    </Group>
  );
}
