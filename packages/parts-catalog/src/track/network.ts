// The track network (trains design 2.1, 3.4): derived from the bricks and
// the parts library, never stored or synced, rebuilt when bricks change.
// Every client builds the same network from the same bricks. The
// desktop's src/track/TrackNetwork.cpp is the twin; both check
// fixtures/contracts/track-network.json.
//
// A node is one connection of one brick (PortRef). Inside a brick a train
// follows the part's paths (partTrack.ts); between bricks it crosses a link
// (`linkedTo`, which connectivity re-derives from positions). A switch is
// a (brick, heel) a train can leave by more than one way; its setting is
// stored (switchStates.ts), the default being the exit that turns least.
//
// Two loose ends of one kind of track that nearly meet, facing each other
// (a gap: within GAP_REACH, not half a stud, so not linked) are joined for
// trains too: real track flexes that far, and a loop with a hairline gap
// is still a loop. `gaps` lists them so the editor can say so.

import { circuitPath, pointAt, type CircuitPathPoint, type Pt } from './circuitPath.js';
import { electricCircuits, partTrack, wrapDegrees, type PartSwitch, type PartTrack, type TrackConn, type TrackKind } from './partTrack.js';

/** One brick as the network reads it. */
export interface TrackBrickInput {
  id: string;
  /** Library key (part number and color), for track-paths.json. */
  partKey: string;
  /** The part's connections (local), or undefined for a part the library doesn't know. */
  conns: readonly TrackConn[] | undefined;
  /** Where each connection is on the map (studs): x then y for each of `conns`. */
  points: ArrayLike<number>;
  orientation: number;
  connexions: readonly { id: string; linkedTo: string }[];
}

/** One connection of one brick. */
export interface PortRef {
  brick: string;
  conn: number;
}

/** A switch on the map. */
export interface SwitchPoint extends PartSwitch {
  brick: string;
  /** "<brick>/<heel>": its key in switchStates. */
  key: string;
}

/**
 * A place on the track: on the path of `brick` from connection `from` to
 * `to`, `s` studs from `from`. Train heads, route ends and (later) cars
 * placed by Live Ops are all positions; one moves with its brick.
 */
export interface TrackPosition {
  brick: string;
  from: number;
  to: number;
  s: number;
}

interface BrickTrack {
  input: TrackBrickInput;
  track: PartTrack;
}

/** A switch's key in switchStates: "<brick id>/<heel connection>". */
export function switchKey(brick: string, heel: number): string {
  return `${brick}/${heel}`;
}

/** The brick and heel a switchStates key names, or null. */
export function parseSwitchKey(key: string): { brick: string; heel: number } | null {
  const at = key.lastIndexOf('/');
  if (at <= 0) return null;
  const heel = Number(key.slice(at + 1));
  if (!Number.isInteger(heel) || heel < 0 || String(heel) !== key.slice(at + 1)) return null;
  return { brick: key.slice(0, at), heel };
}

/** Two ends of track that nearly meet, joined for trains though not linked. */
export interface TrackGap {
  a: PortRef;
  b: PortRef;
  /** Halfway between them, studs. */
  at: Pt;
  /** How far apart they are, studs. */
  gap: number;
}

/** How far apart (studs) two facing loose ends may be and still join for trains. Links are made within half a stud. */
export const GAP_REACH = 1;
/** How far (degrees) from facing each other they may be turned. */
export const GAP_TURN = 15;

export class TrackNetwork {
  private readonly bricks = new Map<string, BrickTrack>();
  private readonly owner = new Map<string, PortRef>();
  private readonly paths = new Map<string, CircuitPathPoint[]>();
  private readonly switchList: SwitchPoint[] = [];
  private readonly switchByKey = new Map<string, SwitchPoint>();
  private readonly bridges = new Map<string, PortRef>();
  private readonly gapList: TrackGap[] = [];

  constructor(bricks: Iterable<TrackBrickInput>) {
    const memo = new Map<string, PartTrack>();
    for (const input of bricks) {
      if (!input.conns) continue;
      const memoKey = `${input.partKey.toLowerCase()}\u0000${input.conns.length}`;
      let track = memo.get(memoKey);
      if (!track) {
        track = partTrack(input.partKey, input.conns);
        memo.set(memoKey, track);
      }
      if (track.paths.length === 0) continue;
      this.bricks.set(input.id, { input, track });
      input.connexions.forEach((c, i) => {
        if (c.id && i < input.conns!.length) this.owner.set(c.id, { brick: input.id, conn: i });
      });
      for (const sw of track.switches) {
        const point: SwitchPoint = { ...sw, brick: input.id, key: switchKey(input.id, sw.heel) };
        this.switchList.push(point);
        this.switchByKey.set(point.key, point);
      }
    }
    this.findGaps();
  }

  /**
   * Pair up loose ends that nearly meet: in brick id then connection
   * order, each with the nearest one after it (ties: the first), of the
   * same kind, another brick, within GAP_REACH and facing it.
   */
  private findGaps(): void {
    const loose: { port: PortRef; p: Pt; angle: number; kind: string }[] = [];
    for (const brick of [...this.bricks.keys()].sort()) {
      const t = this.bricks.get(brick)!.track;
      for (let conn = 0; conn < t.kinds.length; conn++) {
        const kind = t.kinds[conn];
        if (!kind || this.linkedPartner({ brick, conn })) continue;
        const at = this.port(brick, conn);
        if (at) loose.push({ port: { brick, conn }, p: at.p, angle: at.angle, kind });
      }
    }
    const used = new Set<number>();
    for (let i = 0; i < loose.length; i++) {
      if (used.has(i)) continue;
      const a = loose[i]!;
      let best = -1;
      let bestD = Infinity;
      for (let j = i + 1; j < loose.length; j++) {
        const b = loose[j]!;
        if (used.has(j) || b.port.brick === a.port.brick || b.kind !== a.kind) continue;
        const d = Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y);
        if (d > GAP_REACH || Math.abs(wrapDegrees(a.angle - b.angle - 180)) > GAP_TURN) continue;
        if (d < bestD - 1e-9) {
          best = j;
          bestD = d;
        }
      }
      if (best < 0) continue;
      const b = loose[best]!;
      used.add(i).add(best);
      this.bridges.set(switchKey(a.port.brick, a.port.conn), b.port);
      this.bridges.set(switchKey(b.port.brick, b.port.conn), a.port);
      this.gapList.push({ a: a.port, b: b.port, at: { x: (a.p.x + b.p.x) / 2, y: (a.p.y + b.p.y) / 2 }, gap: bestD });
    }
  }

  /** Loose ends that nearly meet, joined for trains (in brick id order). */
  get gaps(): readonly TrackGap[] {
    return this.gapList;
  }

  /** Bricks with at least one way through. */
  get brickIds(): string[] {
    return [...this.bricks.keys()];
  }

  has(brick: string): boolean {
    return this.bricks.has(brick);
  }

  /** The brick's track: kinds, paths, switches. */
  trackOf(brick: string): PartTrack | undefined {
    return this.bricks.get(brick)?.track;
  }

  /** The connection a port is linked to, when that is track too, or the loose end it nearly meets (a gap). */
  partner(port: PortRef): PortRef | null {
    return this.linkedPartner(port) ?? this.bridges.get(switchKey(port.brick, port.conn)) ?? null;
  }

  /** The connection a port is linked to, when that is track too. */
  private linkedPartner(port: PortRef): PortRef | null {
    const b = this.bricks.get(port.brick);
    const link = b?.input.connexions[port.conn]?.linkedTo;
    if (!b || !link) return null;
    const other = this.owner.get(link);
    if (!other) return null;
    const kind = b.track.kinds[port.conn];
    const otherKind = this.bricks.get(other.brick)?.track.kinds[other.conn];
    return kind && kind === otherKind ? other : null;
  }

  /** The connections a train coming in at `entry` can leave `brick` by. */
  exits(brick: string, entry: number): number[] {
    const t = this.bricks.get(brick)?.track;
    if (!t) return [];
    return t.paths.flatMap(([i, j]) => (i === entry ? [j] : j === entry ? [i] : [])).sort((a, b) => a - b);
  }

  /** Every switch, in brick order then heel. */
  get switches(): readonly SwitchPoint[] {
    return this.switchList;
  }

  switchAt(key: string): SwitchPoint | undefined {
    return this.switchByKey.get(key);
  }

  /** Where the switch is set: the stored exit when it is one of its exits, else its default. */
  settingOf(sw: SwitchPoint, states: Readonly<Record<string, number>>): number {
    const v = states[sw.key];
    return typeof v === 'number' && sw.exits.includes(v) ? v : sw.default;
  }

  /** Where a connection is on the map (studs), and its outward angle there (degrees). */
  port(brick: string, conn: number): { p: Pt; angle: number } | null {
    const b = this.bricks.get(brick);
    if (!b || conn >= b.input.conns!.length) return null;
    return {
      p: { x: b.input.points[2 * conn]!, y: b.input.points[2 * conn + 1]! },
      angle: b.input.orientation + b.input.conns![conn]!.angle,
    };
  }

  /** The centreline from `from` to `to` through `brick`, or [] when that isn't a way through. */
  path(brick: string, from: number, to: number): CircuitPathPoint[] {
    const id = `${brick}\u0000${from}\u0000${to}`;
    const cached = this.paths.get(id);
    if (cached) return cached;
    if (!this.exits(brick, from).includes(to)) return [];
    const a = this.port(brick, from)!;
    const b = this.port(brick, to)!;
    const pts = circuitPath(a.p, a.angle, b.p, b.angle);
    this.paths.set(id, pts);
    return pts;
  }

  /** The length of a way through, studs (0 when it isn't one). */
  pathLength(brick: string, from: number, to: number): number {
    const pts = this.path(brick, from, to);
    return pts.length ? pts[pts.length - 1]!.s : 0;
  }

  /** The point at a track position, or null when its brick or path is gone. */
  pointAt(pos: TrackPosition): CircuitPathPoint | null {
    const pts = this.path(pos.brick, pos.from, pos.to);
    return pts.length ? pointAt(pts, Math.max(0, Math.min(pos.s, pts[pts.length - 1]!.s))) : null;
  }

  /** Whether the brick's track carries power: it has an electric circuit (9V). */
  isPowered(brick: string): boolean {
    const b = this.bricks.get(brick);
    return !!b && electricCircuits(b.input.conns!).length > 0;
  }

  /** The kind of track a brick is (its first track connection's). */
  kindOf(brick: string): TrackKind | null {
    return this.bricks.get(brick)?.track.kinds.find((k) => k !== null) ?? null;
  }
}

/**
 * switchStates with only the keys that name a switch here and one of its
 * exits: what a writer keeps (a key whose part is gone is dropped then).
 */
export function cleanSwitchStates(states: Readonly<Record<string, number>>, net: TrackNetwork): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, exit] of Object.entries(states)) {
    const sw = net.switchAt(key);
    if (sw && sw.exits.includes(exit)) out[key] = exit;
  }
  return out;
}

/** The next exit round a switch from its setting (a click in Run mode). */
export function nextExit(sw: SwitchPoint, current: number): number {
  const i = sw.exits.indexOf(current);
  return sw.exits[(i + 1) % sw.exits.length]!;
}
