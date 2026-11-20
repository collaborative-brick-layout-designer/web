// Routes on the map (trains design 4.2, 4.3, 6.2): each shown route as a
// wide line in its color along the track; a broken one dashed red as far
// as it still goes; a ring on each switch it needs that is set the other
// way. The route being drawn shows dashed, with its ends marked. The
// desktop draws the same (src/rendering/SceneBuilderRoutes.cpp).

import { Circle, Group, Line } from 'react-konva';
import { useMemo } from 'react';
import { routeLines, type Route, type RouteStatus, type TrackNetwork, type TrackPosition } from '@cld/parts-catalog/browser';

const PX = 8;
export const ROUTE_BROKEN_COLOR = '#DC2626';
export const ROUTE_AGAINST_COLOR = '#EA580C';

interface Props {
  net: TrackNetwork;
  routes: readonly Route[];
  statuses: ReadonlyMap<string, RouteStatus>;
  hidden: ReadonlySet<string>;
  zoom: number;
  /** The route being drawn: what's been clicked, and the way found so far. */
  draft?: { ends: TrackPosition[]; route: Pick<Route, 'steps' | 'from' | 'to'> | null } | null;
}

const flat = (pts: { x: number; y: number }[]) => pts.flatMap((p) => [p.x * PX, p.y * PX]);

export function RouteLayer({ net, routes, statuses, hidden, zoom, draft }: Props) {
  const w = Math.max(2.4 * PX, 6 / zoom);
  const shown = useMemo(
    () =>
      routes
        .filter((r) => !hidden.has(r.id))
        .map((r) => {
          const st = statuses.get(r.id);
          const rings = st?.status === 'ok' ? st.setAgainst.map((k) => net.switchAt(k)).flatMap((sw) => (sw ? [net.port(sw.brick, sw.heel)?.p] : [])) : [];
          return { r, broken: st?.status === 'broken', lines: routeLines(net, r), rings: rings.filter((p): p is { x: number; y: number } => !!p) };
        }),
    [net, routes, statuses, hidden],
  );
  const draftLines = useMemo(() => (draft?.route ? routeLines(net, draft.route) : []), [net, draft]);
  return (
    <Group name="routes" listening={false}>
      {shown.map(({ r, broken, lines, rings }) => (
        <Group key={r.id} name={`route-${r.id}`} opacity={0.55}>
          {lines.map((l, i) => (
            <Line
              key={i}
              name="route-line"
              points={flat(l)}
              stroke={broken ? ROUTE_BROKEN_COLOR : r.color}
              strokeWidth={w}
              {...(broken ? { dash: [w * 1.2, w * 0.8] } : {})}
              lineCap="round"
              lineJoin="round"
              perfectDrawEnabled={false}
            />
          ))}
          {rings.map((p, i) => (
            <Circle key={i} name="route-against" x={p.x * PX} y={p.y * PX} radius={w * 1.3} stroke={ROUTE_AGAINST_COLOR} strokeWidth={w * 0.45} opacity={1} perfectDrawEnabled={false} />
          ))}
        </Group>
      ))}
      {draft && (
        <Group name="route-draft">
          {draftLines.map((l, i) => (
            <Line key={i} points={flat(l)} stroke="#1D4ED8" strokeWidth={w} dash={[w * 1.5, w]} lineCap="round" opacity={0.7} perfectDrawEnabled={false} />
          ))}
          {draft.ends.map((e, i) => {
            const p = net.pointAt(e)?.p;
            return p ? <Circle key={i} name="route-draft-end" x={p.x * PX} y={p.y * PX} radius={w * 1.2} fill="#FFFFFF" stroke="#1D4ED8" strokeWidth={w * 0.5} /> : null;
          })}
        </Group>
      )}
    </Group>
  );
}
