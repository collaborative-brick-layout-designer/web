// A place's spots on the track (Live Ops design 2.1; @cld/bbm places.ts has
// the places themselves): the run of track a spot is on, how long a train
// can stand there (the fit checks' usable length) and the stretch of track
// the map marks for it. Worked out from the network, never stored. The
// desktop's track/PlacesOnTrack.cpp does the same; both tests use
// fixtures/contracts/places.json.

import { pointAt as pathPointAt, type Pt } from './circuitPath.js';
import { runAt, type TrackRun } from './fitChecks.js';
import type { TrackNetwork } from './network.js';

/** A spot on the track as it is now. */
export interface SpotOnTrack {
  /** What a train can stand in there, studs; null on a switch (no run). */
  usable: number | null;
  /** The stretch the map marks, studs, along the track. */
  line: Pt[];
  /** Its middle, for the label. */
  middle: Pt;
  /** The stretch's length, studs. */
  length: number;
}

/**
 * Where a spot is: `track` is the piece it was picked on, `wanted` how much
 * track it takes up (studs; null: the whole run). Null when the piece is no
 * longer on the map or no longer joins those two ends.
 *
 * The stretch is the run's usable part, or, for a spot that takes up less,
 * that much of it around the piece's middle.
 */
export function spotOnTrack(
  net: TrackNetwork,
  runs: readonly TrackRun[],
  track: { brick: string; from: number; to: number },
  wanted: number | null,
): SpotOnTrack | null {
  const own = net.path(track.brick, track.from, track.to);
  if (own.length < 2) return null;
  const ownLength = own[own.length - 1]!.s;
  const run = runAt(runs, track);
  if (!run) {
    return { usable: null, line: own.map((p) => ({ x: p.p.x, y: p.p.y })), middle: middleOf(own), length: ownLength };
  }
  // The piece's middle along the run, and the run's usable part.
  let at = 0;
  let mid = 0;
  for (const s of run.steps) {
    const len = net.pathLength(s.brick, s.from, s.to);
    if (s.brick === track.brick && Math.min(s.from, s.to) === Math.min(track.from, track.to) && Math.max(s.from, s.to) === Math.max(track.from, track.to)) mid = at + len / 2;
    at += len;
  }
  let lo = 0;
  let hi = run.length;
  if (run.ends[0].kind !== 'loop' && run.usable > 0) {
    lo = run.ends[0].foul;
    hi = run.length - run.ends[1].foul;
  }
  if (wanted !== null && wanted < hi - lo) {
    const from = Math.min(Math.max(mid - wanted / 2, lo), hi - wanted);
    lo = from;
    hi = from + wanted;
  }
  const line = between(net, run, lo, hi);
  return { usable: run.usable, line, middle: between(net, run, (lo + hi) / 2, (lo + hi) / 2)[0] ?? middleOf(own), length: hi - lo };
}

function middleOf(path: Parameters<typeof pathPointAt>[0]): Pt {
  const p = pathPointAt(path, path[path.length - 1]!.s / 2).p;
  return { x: p.x, y: p.y };
}

/** The run's line from `lo` to `hi` studs along it (one point when they are the same). */
function between(net: TrackNetwork, run: TrackRun, lo: number, hi: number): Pt[] {
  const out: Pt[] = [];
  const add = (p: Pt) => {
    const last = out[out.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-6) out.push({ x: p.x, y: p.y });
  };
  let at = 0;
  for (const s of run.steps) {
    const pts = net.path(s.brick, s.from, s.to);
    const len = pts.length ? pts[pts.length - 1]!.s : 0;
    if (pts.length > 1 && at + len >= lo && at <= hi) {
      add(pathPointAt(pts, Math.max(0, lo - at)).p);
      for (const p of pts) if (at + p.s > lo && at + p.s < hi) add(p.p);
      add(pathPointAt(pts, Math.min(len, hi - at)).p);
    }
    at += len;
  }
  return out;
}
