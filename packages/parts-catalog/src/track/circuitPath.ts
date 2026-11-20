// The path an electric circuit (and a train: track/network.ts) takes through a part, so the circuit
// overlay follows the track instead of cutting straight across it — the
// desktop's src/rendering/CircuitPath.cpp, point for point (both apps check
// the same table, test/circuit-paths.json).
//
// BlueBrick (LayerBrick.cs draw) joins a circuit's two connection points
// with straight lines. Here the centreline is a biarc: two circular arcs,
// tangent to each connection's direction and to each other. A standard
// curve comes out as one arc (2867: R40), a straight as a line, and a
// switch branch or a crossover diagonal as an S of two arcs.

export interface Pt {
  x: number;
  y: number;
}

export interface CircuitPathPoint {
  /** On the centreline, studs. */
  p: Pt;
  /** Unit, BlueBrick's (-dir.y, dir.x) (y down). */
  normal: Pt;
  /** Distance along the path from the start, studs. */
  s: number;
}

/** BlueBrick's constants (studs). */
export const CIRCUIT_RAIL_OFFSET = 2.5; // ELECTRIC_WIDTH: half the 9V rail gauge
export const CIRCUIT_PEN_WIDTH = 0.5;
export const CIRCUIT_CUTTER_GAP = 2.25 * CIRCUIT_RAIL_OFFSET; // 862AC01/02: the second rail stops this far from each end
export const CIRCUIT_CUTTER_PEN = 1.5; // the orange bars, and the shortcut sign
export const CIRCUIT_SHORTCUT_SIZE = 3.0; // SHORTCUT_WIDTH: the sign's half size

const MAX_STEP = (2 * Math.PI) / 180; // 2 degrees

const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
const cross = (a: Pt, b: Pt) => a.x * b.y - a.y * b.x;
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
const unit = (v: Pt): Pt => {
  const l = Math.hypot(v.x, v.y);
  return l > 0 ? { x: v.x / l, y: v.y / l } : { x: 1, y: 0 };
};
const leftNormal = (t: Pt): Pt => ({ x: -t.y, y: t.x });
const direction = (degrees: number): Pt => {
  const r = (degrees * Math.PI) / 180;
  return { x: Math.cos(r), y: Math.sin(r) };
};

/** Points from `from` (leaving along unit tangent `t`) to `to`, on the circle tangent to t at `from`, without the first point. */
function appendArc(out: CircuitPathPoint[], from: Pt, t: Pt, to: Pt): void {
  const d = sub(to, from);
  const n = leftNormal(t);
  const dd = dot(d, d);
  const denom = 2 * dot(d, n);
  if (dd <= 1e-18) return;
  if (Math.abs(denom) <= 1e-9 * Math.sqrt(dd)) {
    out.push({ p: to, normal: leftNormal(unit(d)), s: 0 });
    return;
  }
  const r = dd / denom; // signed: the centre is r along the left normal
  const c = add(from, mul(n, r));
  const a = sub(from, c);
  const b = sub(to, c);
  const turn = cross(a, t) >= 0 ? 1 : -1; // +1: the angle grows along the path
  let sweep = Math.atan2(cross(a, b), dot(a, b));
  if (turn > 0 && sweep < 0) sweep += 2 * Math.PI;
  if (turn < 0 && sweep > 0) sweep -= 2 * Math.PI;
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / MAX_STEP - 1e-9));
  const a0 = Math.atan2(a.y, a.x);
  const radius = Math.abs(r);
  for (let k = 1; k <= steps; k++) {
    const ang = a0 + (sweep * k) / steps;
    const p = k === steps ? to : add(c, { x: Math.cos(ang) * radius, y: Math.sin(ang) * radius });
    const tangent = { x: -Math.sin(ang) * turn, y: Math.cos(ang) * turn };
    out.push({ p, normal: leftNormal(tangent), s: 0 });
  }
}

/**
 * The centreline from p1 to p2. `angle1`/`angle2` are the connections'
 * world angles in degrees (part orientation + connection angle), pointing
 * out of the part: the path leaves p1 against angle1 and reaches p2 along
 * angle2. Arcs are sampled every 2 degrees at most.
 */
export function circuitPath(p1: Pt, angle1: number, p2: Pt, angle2: number): CircuitPathPoint[] {
  const t1 = mul(direction(angle1), -1);
  const t2 = direction(angle2);
  const v = sub(p2, p1);
  const out: CircuitPathPoint[] = [{ p: p1, normal: leftNormal(t1), s: 0 }];
  const vv = dot(v, v);
  if (vv <= 1e-18) return out;

  // Equal-tangent biarc: control points q1 = p1 + d t1 and q2 = p2 - d t2
  // with |q2 - q1| = 2d; the arcs meet halfway between them.
  const tt = dot(t1, t2);
  const vt = dot(v, add(t1, t2));
  let d = -1;
  if (Math.abs(1 - tt) < 1e-12) {
    if (vt > 1e-12) d = vv / (2 * vt);
  } else {
    d = (vt - Math.sqrt(vt * vt + 2 * (1 - tt) * vv)) / (2 * (tt - 1));
  }
  if (!(d > 0) || !Number.isFinite(d)) {
    out.push({ p: p2, normal: leftNormal(unit(v)), s: 0 }); // no sensible curve: BlueBrick's straight line
    out[0]!.normal = out[1]!.normal;
  } else {
    const q1 = add(p1, mul(t1, d));
    const q2 = sub(p2, mul(t2, d));
    const j = mul(add(q1, q2), 0.5);
    appendArc(out, p1, t1, j);
    appendArc(out, j, unit(sub(q2, q1)), p2);
    // Both ends keep the connections' own direction.
    out[out.length - 1]!.normal = leftNormal(t2);
  }
  for (let i = 1; i < out.length; i++) {
    const step = sub(out[i]!.p, out[i - 1]!.p);
    out[i]!.s = out[i - 1]!.s + Math.hypot(step.x, step.y);
  }
  return out;
}

/** The rail on one side of the path: each point moved `offset` studs along its normal. */
export function offsetPath(path: readonly CircuitPathPoint[], offset: number): Pt[] {
  return path.map((pt) => add(pt.p, mul(pt.normal, offset)));
}

/** The point and normal at distance s along the path. */
export function pointAt(path: readonly CircuitPathPoint[], s: number): CircuitPathPoint {
  const first = path[0]!;
  if (s <= first.s) return first;
  for (let i = 1; i < path.length; i++) {
    const cur = path[i]!;
    if (s > cur.s) continue;
    const prev = path[i - 1]!;
    const span = cur.s - prev.s;
    const f = span > 0 ? (s - prev.s) / span : 0;
    return {
      p: add(prev.p, mul(sub(cur.p, prev.p), f)),
      normal: unit(add(prev.normal, mul(sub(cur.normal, prev.normal), f))),
      s,
    };
  }
  return path[path.length - 1]!;
}

/** The part of the path between distances s0 and s1, `offset` studs to the side. */
export function offsetPathBetween(path: readonly CircuitPathPoint[], offset: number, s0: number, s1: number): Pt[] {
  if (path.length === 0 || s1 <= s0) return [];
  const at = (pt: CircuitPathPoint) => add(pt.p, mul(pt.normal, offset));
  const out = [at(pointAt(path, s0))];
  for (const pt of path) if (pt.s > s0 && pt.s < s1) out.push(at(pt));
  out.push(at(pointAt(path, s1)));
  return out;
}
