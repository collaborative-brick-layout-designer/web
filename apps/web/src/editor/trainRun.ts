// Running trains in Run mode (trains design 5): Play, Pause, Restart and
// the speed choice, which trains run and on which route, and each frame's
// cars. Running is this person's own: nothing here writes to the layout,
// so it makes no undo steps and nobody else's map moves. A switch a train
// pushes through flips for this run only; a click on a switch is a real,
// shared flip (undoable), as in Run mode before. The layout's scale (1:38
// unless changed) is shared: it is a setting of the layout. The desktop's
// ui/RunPanel.cpp and MapViewRun.cpp do the same.

import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import type * as Y from 'yjs';
import {
  asScale,
  realMetresPerSecond,
  TrainRun,
  type PlacedTrain,
  type RollingStock,
  type Route,
  type RouteStatus,
  type RunNote,
  type RunState,
  type Train,
  type TrackNetwork,
} from '@cld/parts-catalog/browser';
import { readTrainScaleFromDoc, writeTrainScale } from '@cld/ydoc';
import type { LengthUnit } from '../venues/designer/units';
import { LOCAL_ORIGIN } from './useLayoutDoc';

/** Which trains run, and how: a route's id, or null to follow the switches from where the train stands. */
export interface RunPick {
  on: boolean;
  route: string | null;
}

/** A note shown in the Run panel (newest last), with an id for React. */
export type ShownNote = RunNote & { id: number };

interface RunStore {
  playing: boolean;
  /** Times real speed (¼× to 4×), this person's own. */
  multiplier: number;
  /** Show the speed a model really runs at, not its scale speed. */
  realSpeed: boolean;
  /** Changes to the default picks, by train id. */
  picks: Record<string, RunPick>;
  /** The run, once Play was pressed (until Restart or leaving Run mode). */
  run: TrainRun | null;
  /** Where each running train's cars are now (a new map each frame). */
  placed: ReadonlyMap<string, PlacedTrain | null>;
  /** The switches as the run has them (the layout's, with the run's pushes); null with no run. */
  states: Readonly<Record<string, number>> | null;
  /** Each running train's state. */
  trainStates: Readonly<Record<string, RunState>>;
  notes: ShownNote[];
  setPlaying: (v: boolean) => void;
  setMultiplier: (v: number) => void;
  setRealSpeed: (v: boolean) => void;
  setPick: (id: string, pick: RunPick) => void;
  /** Back to the start: the run goes, the trains stand where the layout has them. */
  restart: () => void;
}

const PREFS_KEY = 'cld:run';

function readPrefs(): { multiplier: number; realSpeed: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as { multiplier?: unknown; realSpeed?: unknown };
    return {
      multiplier: typeof v.multiplier === 'number' && [0.25, 0.5, 1, 2, 4].includes(v.multiplier) ? v.multiplier : 1,
      realSpeed: v.realSpeed === true,
    };
  } catch {
    return { multiplier: 1, realSpeed: false };
  }
}

function savePrefs(p: { multiplier: number; realSpeed: boolean }): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // Blocked storage: for this visit only.
  }
}

const EMPTY = new Map<string, PlacedTrain | null>();

export const useRunStore = create<RunStore>((set, get) => ({
  playing: false,
  ...readPrefs(),
  picks: {},
  run: null,
  placed: EMPTY,
  states: null,
  trainStates: {},
  notes: [],
  setPlaying: (v) => {
    const run = get().run;
    if (v && run) {
      run.resume();
      // Every train is at its end: Play runs them again from the start.
      if (!run.moving) {
        set({ run: null, placed: EMPTY, states: null, trainStates: {}, notes: [], playing: true });
        return;
      }
    }
    set({ playing: v });
  },
  setMultiplier: (v) => {
    set({ multiplier: v });
    savePrefs({ multiplier: v, realSpeed: get().realSpeed });
  },
  setRealSpeed: (v) => {
    set({ realSpeed: v });
    savePrefs({ multiplier: get().multiplier, realSpeed: v });
  },
  setPick: (id, pick) => set((s) => ({ picks: { ...s.picks, [id]: pick }, run: null, placed: EMPTY, states: null, trainStates: {}, notes: [] })),
  restart: () => set({ run: null, playing: false, placed: EMPTY, states: null, trainStates: {}, notes: [] }),
}));

/** Leaving Run mode: everything about the run goes (the speed choice stays). */
export function resetRun(): void {
  useRunStore.setState({ run: null, playing: false, picks: {}, placed: EMPTY, states: null, trainStates: {}, notes: [] });
}

/** What a train runs on when nobody picked: its own route (one made for it), else from where it stands; null when it can't run. */
export function defaultPick(t: Train, routes: readonly Route[], onTrack: boolean, statuses: ReadonlyMap<string, RouteStatus>): RunPick | null {
  const own = routes.find((r) => r.train === t.id && statuses.get(r.id)?.status !== 'broken');
  if (own) return { on: true, route: own.id };
  if (onTrack) return { on: true, route: null };
  return null;
}

/** Each train's pick: what the person chose, else the default; null when it can't run (not on the track, no route). */
export function picksFor(
  trains: readonly Train[],
  routes: readonly Route[],
  placed: ReadonlyMap<string, PlacedTrain | null>,
  statuses: ReadonlyMap<string, RouteStatus>,
  chosen: Readonly<Record<string, RunPick>>,
): Map<string, RunPick | null> {
  const out = new Map<string, RunPick | null>();
  for (const t of trains) {
    if (t.units.length === 0) {
      out.set(t.id, null);
      continue;
    }
    const onTrack = !!placed.get(t.id);
    const c = chosen[t.id];
    const routeOk = (id: string | null) => (id === null ? onTrack : routes.some((r) => r.id === id && statuses.get(r.id)?.status !== 'broken'));
    if (c && routeOk(c.route)) out.set(t.id, c);
    else out.set(t.id, defaultPick(t, routes, onTrack, statuses));
  }
  return out;
}

/** The layout's train scale (the N of 1:N); `version` changes when the doc does. */
export function useTrainScale(doc: Y.Doc | null, version: unknown): number {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (doc ? asScale(readTrainScaleFromDoc(doc)) : asScale(undefined)), [doc, version]);
}

/** Set the layout's train scale: one undo step, shared with everyone. */
export function setTrainScale(doc: Y.Doc, scale: number): void {
  doc.transact(() => writeTrainScale(doc, Math.round(scale) === 38 ? null : Math.round(scale)), LOCAL_ORIGIN);
}

const KMH_PER_MPH = 1.609344;

/** Whether speeds are in miles (the account measures in feet and inches). */
export const usesMiles = (unit: LengthUnit) => unit === 'ftin';

/** A scale speed in the account's system: "40 km/h" or "25 mph". */
export function formatScaleSpeed(kmh: number, unit: LengthUnit): string {
  return usesMiles(unit) ? `${Math.round(kmh / KMH_PER_MPH)} mph` : `${Math.round(kmh)} km/h`;
}

/** How fast the model really runs: "0.29 m/s" or "11.5 in/s"; in studs, "37 studs/s". */
export function formatRealSpeed(kmh: number, scale: number, unit: LengthUnit): string {
  const ms = realMetresPerSecond(kmh, scale);
  if (unit === 'ftin') return `${(ms / 0.0254).toFixed(1)} in/s`;
  if (unit === 'studs') return `${Math.round((ms * 1000) / 8)} studs/s`;
  return `${ms.toFixed(2)} m/s`;
}

/** A speed typed in the account's unit (km/h or mph) as scale km/h. */
export function speedToKmh(value: number, unit: LengthUnit): number {
  return usesMiles(unit) ? value * KMH_PER_MPH : value;
}

/** Scale km/h shown in the account's unit, rounded. */
export function kmhToShown(kmh: number, unit: LengthUnit): number {
  return Math.round(usesMiles(unit) ? kmh / KMH_PER_MPH : kmh);
}

/** The plain sentence for a note. */
export function noteText(n: RunNote, name: (trainId: string) => string, routeName?: (trainId: string) => string | null): string {
  const t = name(n.train);
  switch (n.kind) {
    case 'collision':
      return `${t} and ${n.other ? name(n.other) : 'another train'} would collide here, so both stopped.`;
    case 'pushedThrough':
      return `${t} pushed through a switch that was set the other way. It flipped for this run.`;
    case 'routeSet':
      return `A switch was set the other way for ${routeName?.(n.train) ?? 'its route'}; it flipped for this run.`;
    case 'arrived':
      return `${t} reached the end of ${routeName?.(n.train) ?? 'its route'}.`;
    case 'endOfTrack':
      return `${t} reached the end of the track.`;
  }
}

let noteId = 0;

/**
 * New notes after the ones shown (the last 20): a collision already shown
 * between the same two trains at the same spot (Play again, and they still
 * meet) isn't said twice.
 */
export function withNotes(shown: readonly ShownNote[], notes: readonly RunNote[]): ShownNote[] {
  const out = [...shown];
  for (const n of notes) {
    const same = n.kind === 'collision' && out.some((o) => o.kind === 'collision' && ((o.train === n.train && o.other === n.other) || (o.train === n.other && o.other === n.train)) && Math.hypot(o.at.x - n.at.x, o.at.y - n.at.y) < 2);
    if (!same) out.push({ ...n, id: ++noteId });
  }
  return out.slice(-20);
}

/**
 * Drives the run while Run mode is on: builds it on Play, moves it each
 * frame by the time since the last one (times the speed choice), and stops
 * when no train is moving. The layout's switches reach the run as they change.
 */
export function useTrainRunner(opts: {
  runMode: boolean;
  net: TrackNetwork | null;
  trains: readonly Train[];
  stock: ReadonlyMap<string, RollingStock>;
  routes: readonly Route[];
  statuses: ReadonlyMap<string, RouteStatus>;
  placed: ReadonlyMap<string, PlacedTrain | null>;
  switchStates: Readonly<Record<string, number>>;
  scale: number;
}): void {
  const { runMode, net, trains, stock, routes, statuses, placed, switchStates, scale } = opts;
  const playing = useRunStore((s) => s.playing);
  const run = useRunStore((s) => s.run);
  const picks = useRunStore((s) => s.picks);

  // Out of Run mode (or off the layout): no run.
  useEffect(() => {
    if (!runMode) resetRun();
  }, [runMode]);
  useEffect(() => () => resetRun(), []);

  // The scale changed: start again from the beginning at the new speeds.
  useEffect(() => {
    useRunStore.getState().restart();
  }, [scale]);

  // Play with no run yet: make one from the picks.
  useEffect(() => {
    if (!runMode || !playing || run || !net) return;
    const chosen = picksFor(trains, routes, placed, statuses, picks);
    const plans = trains.flatMap((train) => {
      const p = chosen.get(train.id);
      if (!p?.on) return [];
      const route = p.route ? routes.find((r) => r.id === p.route) ?? null : null;
      return [{ train, route }];
    });
    if (plans.length === 0) {
      useRunStore.setState({ playing: false });
      return;
    }
    const ids = new Set(plans.map((p) => p.train.id));
    const parked = new Map([...placed].filter(([id]) => !ids.has(id)));
    const r = new TrainRun(net, stock, plans, switchStates, scale, parked);
    const trainStates = Object.fromEntries(r.trainIds.map((id) => [id, r.stateOf(id)!]));
    // Trains that start touching stop at once: say so.
    const notes: ShownNote[] = r.startNotes.map((n) => ({ ...n, id: ++noteId }));
    useRunStore.setState({ run: r, placed: r.placed, states: r.states, trainStates, notes, playing: r.moving });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runMode, playing, run, net]);

  // The layout's switches reach the run.
  useEffect(() => {
    const r = useRunStore.getState().run;
    if (!r) return;
    r.setLayoutStates(switchStates);
    useRunStore.setState({ states: r.states });
  }, [switchStates, run]);

  // Each frame while playing.
  useEffect(() => {
    if (!playing || !run) return;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const s = useRunStore.getState();
      // A long pause (a hidden tab) doesn't jump the trains.
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000)) * s.multiplier;
      last = now;
      const notes = run.step(dt);
      const update: Partial<RunStore> = { placed: run.placed };
      if (notes.length > 0) {
        update.notes = withNotes(s.notes, notes);
        update.trainStates = Object.fromEntries(run.trainIds.map((id) => [id, run.stateOf(id)!]));
        if (notes.some((n) => n.kind === 'pushedThrough' || n.kind === 'routeSet')) update.states = run.states;
      }
      if (!run.moving) update.playing = false;
      useRunStore.setState(update);
      if (run.moving) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, run]);
}
