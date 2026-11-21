// Fit checks in the editor (trains design 3.5, 6.2): the track's runs (the
// siding lengths) and the checks for the trains on the map and the routes,
// worked out again whenever the track, a train, a car, a route or a switch
// changes; and what each one says, in plain words. The desktop's
// ui/FitChecksList.cpp says the same.

import { useMemo } from 'react';
import { fitChecks, trackRuns, type FitCheck, type PlacedTrain, type RollingStock, type Route, type TrackNetwork, type TrackRun, type Train } from '@cld/parts-catalog/browser';
import { formatLength, type LengthUnit } from '../venues/designer/units';
import { stockLabel } from './trains';

/** The network's runs of track and their usable lengths. */
export function useTrackRuns(net: TrackNetwork | null): TrackRun[] {
  return useMemo(() => (net ? trackRuns(net) : []), [net]);
}

/** Every fit check now: errors first, then by train and place. */
export function useFitChecks(
  net: TrackNetwork | null,
  runs: readonly TrackRun[],
  trains: readonly Train[],
  stock: ReadonlyMap<string, RollingStock>,
  routes: readonly Route[],
  states: Readonly<Record<string, number>>,
  placed: ReadonlyMap<string, PlacedTrain | null>,
): FitCheck[] {
  return useMemo(() => {
    if (!net) return [];
    const all = fitChecks(net, { trains, stock, routes, states, placed, runs });
    return all.map((c, i) => ({ c, i })).sort((a, b) => (a.c.severity === b.c.severity ? a.i - b.i : a.c.severity === 'error' ? -1 : 1)).map((x) => x.c);
  }, [net, runs, trains, stock, routes, states, placed]);
}

interface Names {
  trains: ReadonlyMap<string, Train>;
  stock: ReadonlyMap<string, RollingStock>;
  routes: ReadonlyMap<string, Route>;
}

const deg = (v: number | undefined) => `${Math.round(v ?? 0)}°`;

/** What a check says, in plain words. */
export function checkText(c: FitCheck, names: Names, unit: LengthUnit): string {
  const train = (c.train && names.trains.get(c.train)?.name) || 'A train';
  const car = c.stock ? names.stock.get(c.stock) : undefined;
  const carName = car ? stockLabel(car) : 'A car';
  const route = (c.route && names.routes.get(c.route)?.name) || 'A route';
  const len = (v: number | undefined) => formatLength(v ?? 0, unit);
  switch (c.kind) {
    case 'siding':
      return `${train} (${len(c.values.length)}) is longer than the track it stands in (${len(c.values.usable)} between its switches and ends).`;
    case 'truck':
      return `${carName} in ${train}: the curve is too tight for its trucks (they turn ${deg(c.values.angle)}; at most ${deg(c.values.max)}).`;
    case 'coupler':
      return (c.values.gap ?? 0) > 1
        ? `${carName} in ${train} can't reach the car ahead: its couplers are ${len(c.values.gap)} apart on this curve.`
        : `${carName} in ${train}: its coupler turns ${deg(c.values.angle)} on this curve (at most ${deg(c.values.max)}).`;
    case 'uncoupled':
      return `${carName} in ${train} has no coupler to the car ahead.`;
    case 'clearance':
      return `${carName} in ${train} is too close to the other track here.`;
    case 'overlap': {
      const other = (c.other && names.trains.get(c.other)?.name) || 'another train';
      return `${train} and ${other} are on top of each other.`;
    }
    case 'trackKind':
      return `${carName} in ${train} doesn't run on this kind of track (it runs on ${car?.trackKind === 'monorail' ? 'monorail' : 'train track'}).`;
    case 'offEnd':
      return `${train} runs off the end of the track.`;
    case 'lost':
      return `${train}'s track was moved or removed: put it on the track again.`;
    case 'reverse':
      return `${route} turns the train around (a reversing loop or wye).`;
    case 'power':
      return `${route} turns the train around on powered track: it needs a polarity switch there.`;
    case 'gap':
      return `The track doesn’t quite join here (the ends are ${len(c.values.gap)} apart). Trains and routes run across it; nudge one piece to close the gap.`;
  }
}

export function namesOf(trains: readonly Train[], stock: ReadonlyMap<string, RollingStock>, routes: readonly Route[]): Names {
  return { trains: new Map(trains.map((t) => [t.id, t])), stock, routes: new Map(routes.map((r) => [r.id, r])) };
}

/** Ask the map to show this spot (it zooms there and rings it for a moment). */
export function showSpot(at: { x: number; y: number }): void {
  window.dispatchEvent(new CustomEvent('cld:show-spot', { detail: at }));
}
