// Routes on the map (trains design 4.2, 4.3, 6.2): each shown route as a
// wide line in its color along the track; a broken one dashed red as far
// as it still goes; a ring on each switch it needs that is set the other
// way. The route being drawn shows dashed, with its ends marked. Arrows
// along each show which way the train runs. The desktop draws the same
// (src/rendering/SceneBuilderRoutes.cpp).

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

/** How far apart the arrows along a route are (studs), and how far in the first is. */
export const ROUTE_ARROW_EVERY = 48;

/**
 * Arrows along a line, the way it runs: one every ROUTE_ARROW_EVERY studs,
 * the first half that in (one in the middle of a shorter line). Each is a
 * point and a unit direction, studs.
 */
export function routeArrows(line: readonly { x: number; y: number }[]): { x: number; y: number; dx: number; dy: number }[] {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += Math.hypot(line[i]!.x - line[i - 1]!.x, line[i]!.y - line[i - 1]!.y);
  if (total <= 1e-9) return [];
  const out: { x: number; y: number; dx: number; dy: number }[] = [];
  let next = total < ROUTE_ARROW_EVERY ? total / 2 : ROUTE_ARROW_EVERY / 2;
  let run = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len <= 1e-9) continue;
    while (next <= run + len) {
      const t = (next - run) / len;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, dx: (b.x - a.x) / len, dy: (b.y - a.y) / len });
      next += ROUTE_ARROW_EVERY;
    }
    run += len;
  }
  return out;
}

/** A chevron at an arrow, in pixels: wing, tip, wing. */
function chevron(a: { x: number; y: number; dx: number; dy: number }, size: number): number[] {
  const x = a.x * PX;
  const y = a.y * PX;
  return [x - a.dx * size - a.dy * size, y - a.dy * size + a.dx * size, x + a.dx * size, y + a.dy * size, x - a.dx * size + a.dy * size, y - a.dy * size - a.dx * size];
}

export function RouteLayer({ net, routes, statuses, hidden, zoom, draft }: Props) {
  const w = Math.max(2.4 * PX, 6 / zoom);
  const shown = useMemo(
    () =>
      routes
        .filter((r) => !hidden.has(r.id))
        .map((r) => {
          const st = statuses.get(r.id);
          const rings = st?.status === 'ok' ? st.setAgainst.map((k) => net.switchAt(k)).flatMap((sw) => (sw ? [net.port(sw.brick, sw.heel)?.p] : [])) : [];
          const lines = routeLines(net, r);
          return { r, broken: st?.status === 'broken', lines, arrows: lines.flatMap(routeArrows), rings: rings.filter((p): p is { x: number; y: number } => !!p) };
        }),
    [net, routes, statuses, hidden],
  );
  const draftLines = useMemo(() => (draft?.route ? routeLines(net, draft.route) : []), [net, draft]);
  const draftArrows = useMemo(() => draftLines.flatMap(routeArrows), [draftLines]);
  return (
    <Group name="routes" listening={false}>
      {shown.map(({ r, broken, lines, arrows, rings }) => (
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
          {arrows.map((a, i) => (
            <Line key={`a${i}`} name="route-arrow" points={chevron(a, w * 0.9)} stroke="#FFFFFF" strokeWidth={w * 0.35} lineCap="round" lineJoin="round" opacity={0.95} perfectDrawEnabled={false} />
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
          {draftArrows.map((a, i) => (
            <Line key={`a${i}`} name="route-draft-arrow" points={chevron(a, w * 0.9)} stroke="#1D4ED8" strokeWidth={w * 0.45} lineCap="round" lineJoin="round" perfectDrawEnabled={false} />
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
