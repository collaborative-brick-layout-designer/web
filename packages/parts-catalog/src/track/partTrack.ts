// The ways a train can go through one part (trains design 3.2), and where
// a part is a switch. The desktop's src/track/PartTrack.cpp is the twin;
// both check fixtures/contracts/track-network.json.
//
// Rules, in order:
//   1. track-paths.json names the part: exactly its paths.
//   2. Electric circuits (two connections with opposite plugs) whose ends
//      are both track of one kind. They already leave out frog to frog.
//   3. Two track connections of one kind: one path.
//   4. Three or more track connections, no circuits (monorail points,
//      Duplo, 4.5V/12V): i to j when entering at i and leaving at j turns
//      no more than maxTurnDegrees.
// Every path can be used both ways.

import { TRACK_KINDS, TRACK_PATHS, type TrackKindsTable, type TrackPathsTable } from './tables.js';

/** "rail", "monorail", "duplo", ... (track-kinds.json `kinds`). */
export type TrackKind = string;

/** A part's connection as the track needs it: local studs, outward angle in degrees, electric plug. */
export interface TrackConn {
  type: string;
  x: number;
  y: number;
  angle: number;
  plug: number;
}

/** What a leg of a switch is called: straight, left or right (a second of one side gets " 2"). */
export type LegName = string;

/** A switch: a connection a train can leave from by more than one way. */
export interface PartSwitch {
  /** The connection the train comes in by. */
  heel: number;
  /** The connections it can leave by, lowest first. */
  exits: number[];
  /** The exit with the smallest turn: what a switch with no setting is set to. */
  default: number;
  /** Each exit's name, keyed by its connection index. */
  legs: Record<number, LegName>;
}

export interface PartTrack {
  /** Each connection's track kind, null when it isn't track. */
  kinds: (TrackKind | null)[];
  /** The ways through, each [i, j] with i < j, sorted. */
  paths: [number, number][];
  /** The switches, by heel. */
  switches: PartSwitch[];
}

const STRAIGHT_TURN = 2; // degrees: less than this is no turn
const STRAIGHT_SIDE = 0.15; // sin of the chord's angle: less than this is no side step (a 4DBrix diverger's straight leg steps 0.09)
const SAME_TURN = 0.5; // degrees: turns closer than this tie
const SAME_SIDE = 0.05;

/** An angle in degrees, wrapped into (-180, 180]. */
export function wrapDegrees(a: number): number {
  let x = ((a % 360) + 360) % 360;
  if (x > 180) x -= 360;
  return x;
}

/** The kind of a connection type, or null when it isn't track. `inCircuit`: it is one end of an electric circuit. */
export function trackKindOf(type: string, inCircuit: boolean, table: TrackKindsTable = TRACK_KINDS): TrackKind | null {
  if (table.notTrack.includes(type)) return null;
  const direct = table.types[type];
  if (direct) return direct;
  for (const [prefix, kind] of Object.entries(table.prefixes)) if (type.startsWith(prefix)) return kind;
  return inCircuit ? table.fallback : null;
}

/** Pairs of connections with opposite, non-zero plugs (BlueBrick's circuits). */
export function electricCircuits(conns: readonly TrackConn[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < conns.length; i++) {
    const p = conns[i]!.plug;
    if (!p) continue;
    for (let j = i + 1; j < conns.length; j++) if (conns[j]!.plug === -p) out.push([i, j]);
  }
  return out;
}

/** How much a train turns entering at `from` and leaving at `to` (degrees, + is to the right on the map, y down). */
export function turnThrough(conns: readonly TrackConn[], from: number, to: number): number {
  return wrapDegrees(conns[to]!.angle - (conns[from]!.angle + 180));
}

/** Sideways step from `from` to `to` against the way in: sin of the chord's angle, + to the right. */
function sideStep(conns: readonly TrackConn[], from: number, to: number): number {
  const a = conns[from]!;
  const b = conns[to]!;
  const r = ((a.angle + 180) * Math.PI) / 180;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len <= 1e-9) return 0;
  return (Math.cos(r) * dy - Math.sin(r) * dx) / len;
}

function overrideFor(key: string, table: TrackPathsTable): [number, number][] | undefined {
  const k = key.toLowerCase();
  for (const [name, entry] of Object.entries(table.parts)) if (name.toLowerCase() === k) return entry.paths;
  return undefined;
}

/** The ways through a part (`key`: its library key, part number and color). */
export function partTrack(
  key: string,
  conns: readonly TrackConn[],
  kindsTable: TrackKindsTable = TRACK_KINDS,
  pathsTable: TrackPathsTable = TRACK_PATHS,
): PartTrack {
  const circuits = electricCircuits(conns);
  const inCircuit = new Set(circuits.flat());
  const kinds = conns.map((c, i) => trackKindOf(c.type, inCircuit.has(i), kindsTable));
  const sameKind = (i: number, j: number) => kinds[i] !== null && kinds[i] === kinds[j];

  let paths: [number, number][] = [];
  const override = overrideFor(key, pathsTable);
  if (override) {
    paths = override.filter(([i, j]) => i < conns.length && j < conns.length && i !== j).map(([i, j]) => (i < j ? [i, j] : [j, i]));
  } else {
    const trackCircuits = circuits.filter(([i, j]) => sameKind(i, j));
    if (trackCircuits.length > 0) {
      paths = trackCircuits;
    } else {
      const track = kinds.flatMap((k, i) => (k === null ? [] : [i]));
      if (track.length === 2) {
        if (sameKind(track[0]!, track[1]!)) paths = [[track[0]!, track[1]!]];
      } else if (track.length > 2) {
        for (let a = 0; a < track.length; a++)
          for (let b = a + 1; b < track.length; b++) {
            const i = track[a]!;
            const j = track[b]!;
            if (sameKind(i, j) && Math.abs(turnThrough(conns, i, j)) <= kindsTable.maxTurnDegrees + 1e-9) paths.push([i, j]);
          }
      }
    }
  }
  paths.sort((p, q) => p[0] - q[0] || p[1] - q[1]);

  const switches: PartSwitch[] = [];
  for (let heel = 0; heel < conns.length; heel++) {
    const exits = paths.flatMap(([i, j]) => (i === heel ? [j] : j === heel ? [i] : [])).sort((a, b) => a - b);
    if (exits.length < 2) continue;
    const info = exits.map((exit) => {
      const turn = turnThrough(conns, heel, exit);
      const side = sideStep(conns, heel, exit);
      return { exit, turn, side, dir: Math.abs(turn) >= STRAIGHT_TURN ? Math.sign(turn) : Math.abs(side) >= STRAIGHT_SIDE ? Math.sign(side) : 0 };
    });
    const byStraightness = [...info].sort(
      (p, q) =>
        (Math.abs(Math.abs(p.turn) - Math.abs(q.turn)) > SAME_TURN ? Math.abs(p.turn) - Math.abs(q.turn) : 0) ||
        (Math.abs(Math.abs(p.side) - Math.abs(q.side)) > SAME_SIDE ? Math.abs(p.side) - Math.abs(q.side) : 0) ||
        p.exit - q.exit,
    );
    const legs: Record<number, LegName> = {};
    const used = new Map<string, number>();
    for (const leg of byStraightness) {
      const base = leg.dir === 0 ? 'straight' : leg.dir < 0 ? 'left' : 'right';
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      legs[leg.exit] = n === 1 ? base : `${base} ${n}`;
    }
    switches.push({ heel, exits, default: byStraightness[0]!.exit, legs });
  }
  return { kinds, paths, switches };
}
