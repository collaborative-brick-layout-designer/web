// Fit checks on the map (trains design 3.5, 6.2): with View › Siding lengths,
// each run of track labeled with the length a train can stand in; a ring at
// each spot a check is about (red: a problem, amber: a warning); and the
// spot "Show me" brought into view, ringed for a moment. The desktop's
// SceneBuilderFit.cpp draws the same.

import { Circle, Group, Label, Tag, Text } from 'react-konva';
import type { FitCheck, TrackRun } from '@cld/parts-catalog/browser';
import { formatLength } from '../../venues/designer/units';
import { useLengthUnit } from '../../theme/PrefsProvider';

const PX = 8;

interface Props {
  runs: readonly TrackRun[];
  checks: readonly FitCheck[];
  spotlight: { x: number; y: number } | null;
  zoom: number;
}

export function FitLayer({ runs, checks, spotlight, zoom }: Props) {
  const unit = useLengthUnit();
  const font = Math.max(10, 12 / zoom);
  const ring = Math.max(2.5 * PX, 14 / zoom);
  return (
    <Group name="fit-checks" listening={false}>
      {runs.map((r, i) => (
        <Label key={i} name="siding-length" x={r.middle.x * PX} y={r.middle.y * PX} opacity={0.92}>
          <Tag fill="#FFFFFF" stroke="#334155" strokeWidth={1 / zoom} cornerRadius={3 / zoom} pointerDirection="down" pointerWidth={6 / zoom} pointerHeight={4 / zoom} />
          <Text text={formatLength(r.usable, unit)} fontSize={font} padding={3 / zoom} fill="#0F172A" fontStyle="bold" />
        </Label>
      ))}
      {checks.map((c) => (
        <Circle
          key={c.key}
          name="fit-check-mark"
          x={c.at.x * PX}
          y={c.at.y * PX}
          radius={ring}
          stroke={c.severity === 'error' ? '#DC2626' : '#D97706'}
          strokeWidth={Math.max(0.4 * PX, 3 / zoom)}
          dash={[ring * 0.5, ring * 0.3]}
          perfectDrawEnabled={false}
        />
      ))}
      {spotlight && (
        <Circle name="fit-spotlight" x={spotlight.x * PX} y={spotlight.y * PX} radius={ring * 1.8} stroke="#1D4ED8" strokeWidth={Math.max(0.6 * PX, 4 / zoom)} perfectDrawEnabled={false} />
      )}
    </Group>
  );
}
