// Named routes in the editor (trains design 2.5, 4, 6.2): the layout's
// routes from the doc, each one's status against the track as it is now,
// which ones this person has hidden (their own view, not the layout's), and
// the edits, each one undo step. The desktop's ui/RoutesPanel.cpp does the same.

import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { deleteRoute, readRoutesFromDoc, writeRoute } from '@cld/ydoc';
import { findRoute, routeStatus, type Route, type RouteFound, type RouteProblem, type RouteStatus, type TrackNetwork, type TrackPosition } from '@cld/parts-catalog/browser';
import { LOCAL_ORIGIN } from './useLayoutDoc';
import { makeId } from './mutations';

/** The colors new routes take in turn. */
export const ROUTE_COLORS = ['#3B82F6', '#A855F7', '#14B8A6', '#F59E0B', '#EC4899', '#22C55E'];

/** A saved route read back: what the panel and the map show. */
export function asRoute(r: Record<string, unknown>): Route {
  const pos = (v: unknown): TrackPosition => {
    const o = (v ?? {}) as Partial<TrackPosition>;
    return { brick: String(o.brick ?? ''), from: Number(o.from ?? 0), to: Number(o.to ?? 1), s: Number(o.s ?? 0) };
  };
  return {
    ...r,
    id: String(r.id),
    name: typeof r.name === 'string' ? r.name : '',
    train: typeof r.train === 'string' ? r.train : null,
    from: pos(r.from),
    to: pos(r.to),
    via: Array.isArray(r.via) ? r.via.map((v) => ({ at: pos((v as { at?: unknown }).at), reverse: !!(v as { reverse?: unknown }).reverse })) : [],
    steps: Array.isArray(r.steps) ? (r.steps as Route['steps']) : [],
    color: typeof r.color === 'string' ? r.color : ROUTE_COLORS[0]!,
  };
}

/** The layout's routes; `version` changes when the doc does (the projected map). */
export function useRoutes(doc: Y.Doc | null, version: unknown): Route[] {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (doc ? readRoutesFromDoc(doc).map(asRoute) : []), [doc, version]);
}

/** Each route's status now (rebuilt with the network, so a moved part shows at once). */
export function useRouteStatuses(net: TrackNetwork | null, routes: readonly Route[], states: Readonly<Record<string, number>>): Map<string, RouteStatus> {
  return useMemo(() => {
    const out = new Map<string, RouteStatus>();
    if (!net) return out;
    for (const r of routes) out.set(r.id, routeStatus(net, r, states));
    return out;
  }, [net, routes, states]);
}

const hiddenKey = (layoutId: string) => `cld:routesHidden:${layoutId}`;

function readHidden(layoutId: string): Set<string> {
  try {
    const raw = localStorage.getItem(hiddenKey(layoutId));
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * The routes this person hid on the map (trains design 2.5, Aaron
 * 2026-11-19: each person's own view): kept in this browser, per layout.
 */
export function useHiddenRoutes(layoutId: string): { hidden: ReadonlySet<string>; setShown: (id: string, shown: boolean) => void } {
  const [hidden, setHidden] = useState(() => readHidden(layoutId));
  useEffect(() => {
    setHidden(readHidden(layoutId));
    const onStorage = (e: StorageEvent) => {
      if (e.key === hiddenKey(layoutId)) setHidden(readHidden(layoutId));
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('cld:routesHidden', onStorage as EventListener);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('cld:routesHidden', onStorage as EventListener);
    };
  }, [layoutId]);
  const setShown = useCallback(
    (id: string, shown: boolean) => {
      const next = readHidden(layoutId);
      if (shown) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(hiddenKey(layoutId), JSON.stringify([...next]));
      } catch {
        // Blocked storage: shown or hidden for this visit only.
      }
      setHidden(next);
      // Other views of the same layout in this tab (the panel and the map) follow.
      window.dispatchEvent(new StorageEvent('cld:routesHidden', { key: hiddenKey(layoutId) }));
    },
    [layoutId],
  );
  return { hidden, setShown };
}

/** A new route's record from what was found. */
export function newRoute(name: string, from: TrackPosition, to: TrackPosition, via: TrackPosition[], found: RouteFound, taken: readonly Route[]): Route {
  const used = new Set(taken.map((r) => r.color));
  const color = ROUTE_COLORS.find((c) => !used.has(c)) ?? ROUTE_COLORS[taken.length % ROUTE_COLORS.length]!;
  return { id: makeId(), name, train: null, from, to, via: via.map((at) => ({ at, reverse: false })), steps: found.steps, color };
}

/** Save a route (new, or changed fields of one): one undo step. */
export function saveRoute(doc: Y.Doc, route: Route): void {
  doc.transact(() => writeRoute(doc, route), LOCAL_ORIGIN);
}

/** Delete a route: one undo step. */
export function removeRoute(doc: Y.Doc, id: string): void {
  doc.transact(() => deleteRoute(doc, id), LOCAL_ORIGIN);
}

/** Find a new way for a broken route, from its start through its stops to its end (name and color kept). */
export function findAgain(net: TrackNetwork, route: Route): RouteFound | RouteProblem {
  return findRoute(net, route.from, route.to, { via: route.via.map((v) => v.at) });
}

/** What a search that found nothing says, in plain words. */
export function problemText(p: RouteProblem): string {
  if (p === 'noTrack') return 'There’s no track joining these two places.';
  if (p === 'turnAround') return 'The only way needs the train to turn around.';
  return 'Pick an end somewhere else along the track.';
}
