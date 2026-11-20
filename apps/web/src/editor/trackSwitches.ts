// Switches on the map (trains design 6.3): the track network of what is
// drawn, where each switch is set, the arrow that shows it, the switch a
// click in Run mode means, and the right-click menu's choices. The
// desktop's src/ui/MapViewSwitches.cpp does the same.

import { useMemo } from 'react';
import type * as Y from 'yjs';
import type { BbmMap } from '@cld/model';
import { makeCatalogLookup, pointAt, trackNetworkOf, type CircuitPathPoint, type SwitchPoint, type TrackNetwork } from '@cld/parts-catalog/browser';
import { readSwitchStatesFromDoc } from '@cld/ydoc';
import type { PartWire } from '../api';
import { catalogFromParts } from './catalogFromParts';

/** The track network of `map` (rebuilt when the map or the parts change). */
export function useTrackNetwork(map: BbmMap | null, parts: readonly PartWire[] | undefined): TrackNetwork | null {
  const lookup = useMemo(() => makeCatalogLookup(catalogFromParts(parts as PartWire[] | undefined)), [parts]);
  return useMemo(() => (map ? trackNetworkOf(map, lookup) : null), [map, lookup]);
}

/** The doc's switch settings; `version` is anything that changes when the doc does (the projected map). */
export function useSwitchStates(doc: Y.Doc | null, version: unknown): Record<string, number> {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (doc ? readSwitchStatesFromDoc(doc) : {}), [doc, version]);
}

/** How long the arrow on a switch's set leg is, studs (shorter on a short leg). */
const ARROW_STUDS = 10;

export interface SwitchArrow {
  key: string;
  /** The set leg, from the heel, studs: x, y pairs. */
  set: number[];
  /** The other legs, as far as the arrow goes. */
  others: number[][];
  /** The arrow's tip and the way it points (unit vector). */
  tip: { x: number; y: number; dx: number; dy: number };
  /** Set the other way from its default. */
  turned: boolean;
}

function along(pts: readonly CircuitPathPoint[], length: number): number[] {
  const out: number[] = [];
  for (const p of pts) {
    if (p.s > length) break;
    out.push(p.p.x, p.p.y);
  }
  const end = pointAt(pts, length);
  out.push(end.p.x, end.p.y);
  return out;
}

/** The arrows of every switch, in studs. */
export function switchArrows(net: TrackNetwork, states: Readonly<Record<string, number>>): SwitchArrow[] {
  const out: SwitchArrow[] = [];
  for (const sw of net.switches) {
    const setExit = net.settingOf(sw, states);
    const legs = sw.exits.map((exit) => ({ exit, pts: net.path(sw.brick, sw.heel, exit) })).filter((l) => l.pts.length > 1);
    const set = legs.find((l) => l.exit === setExit);
    if (!set) continue;
    const len = Math.min(ARROW_STUDS, ...legs.map((l) => l.pts[l.pts.length - 1]!.s * 0.6));
    const tipAt = pointAt(set.pts, len);
    const back = pointAt(set.pts, Math.max(0, len - 0.5));
    const dx = tipAt.p.x - back.p.x;
    const dy = tipAt.p.y - back.p.y;
    const d = Math.hypot(dx, dy) || 1;
    out.push({
      key: sw.key,
      set: along(set.pts, len),
      others: legs.filter((l) => l !== set).map((l) => along(l.pts, len)),
      tip: { x: tipAt.p.x, y: tipAt.p.y, dx: dx / d, dy: dy / d },
      turned: setExit !== sw.default,
    });
  }
  return out;
}

/**
 * The switch a click at `at` (studs) means: the one whose heel or set leg is
 * nearest, within `reach` studs; null when none is that close.
 */
export function switchAt(net: TrackNetwork, states: Readonly<Record<string, number>>, at: { x: number; y: number }, reach: number): SwitchPoint | null {
  let best: SwitchPoint | null = null;
  let bestD = reach;
  for (const sw of net.switches) {
    const legs = sw.exits.map((exit) => net.path(sw.brick, sw.heel, exit));
    for (const pts of legs) {
      const len = pts.length ? pts[pts.length - 1]!.s : 0;
      for (const s of [0, Math.min(ARROW_STUDS, len * 0.6) / 2, Math.min(ARROW_STUDS, len * 0.6)]) {
        if (!pts.length) continue;
        const p = pointAt(pts, s).p;
        const d = Math.hypot(p.x - at.x, p.y - at.y);
        if (d < bestD) {
          bestD = d;
          best = sw;
        }
      }
    }
  }
  return best;
}

/** What a leg is called in menus: "Straight", "Turn left", "Turn right" ("Turn left (2)" for a second one). */
export function legLabel(name: string): string {
  const [side, n] = name.split(' ');
  const word = side === 'left' ? 'Turn left' : side === 'right' ? 'Turn right' : 'Straight';
  return n ? `${word} (${n})` : word;
}

export interface SwitchMenuItem {
  key: string;
  exit: number;
  label: string;
  checked: boolean;
}

/** The right-click menu's "Set the switch" choices for a brick (empty when it isn't a switch). */
export function switchMenuItems(net: TrackNetwork | null, states: Readonly<Record<string, number>>, brick: string | null): SwitchMenuItem[] {
  if (!net || !brick) return [];
  const here = net.switches.filter((s) => s.brick === brick);
  return here.flatMap((sw, n) =>
    [...sw.exits]
      .sort((a, b) => (a === sw.default ? -1 : b === sw.default ? 1 : a - b))
      .map((exit) => ({
        key: sw.key,
        exit,
        label: here.length > 1 ? `From end ${n + 1}: ${legLabel(sw.legs[exit] ?? 'straight')}` : legLabel(sw.legs[exit] ?? 'straight'),
        checked: net.settingOf(sw, states) === exit,
      })),
  );
}
