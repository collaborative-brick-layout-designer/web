// Waybills, jobs and the routing of cars (Live Ops design 2.4, 3): where
// each car goes next, which job takes it there, the spot it is set out at,
// and each job's switch list; or, plainly, why it can't be routed. Worked
// out from the records, never stored.
//
// A waybill has four slots, as the four sides of a printed one, each a
// place to go to; its fields are flat (`to1` ... `note4`), and a job's
// stops are a field each (`stop_<id>`), so two people who change different
// things at once lose nothing. A waybill is in a car's pocket when both say
// so (the car's `opsWaybill`, the waybill's `car`); else it waits for a car.
//
// The desktop's src/track/Ops.cpp is the twin; both check
// fixtures/contracts/ops-routing.json.

import type { Pt } from './circuitPath.js';
import type { TrackNetwork } from './network.js';

/** What the apps hold a layout to; the server takes twice the counts (two people may each add the last ones at once). */
export const OPS_LIMITS = {
  waybills: 2000,
  jobs: 100,
  /** Stops of one job. */
  stops: 40,
  /** A job's name, and a leg's note. */
  name: 80,
  note: 200,
} as const;

/** How much work the routing does before it gives up (and says so): a step is one stop looked at. */
export const ROUTE_STEPS = 600_000;
/** The most jobs one car's way may take. */
const MAX_HOPS = 4;
/** Rounds of finding room (a car that doesn't fit stays where it is, and takes up room there). */
const MAX_ROUNDS = 8;

export const JOB_KINDS = ['local', 'yard', 'through', 'turn'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** Strings in the order both apps sort them in (UTF-16 units). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---- the records -------------------------------------------------------------

export interface WaybillLeg {
  /** The place (its id). */
  to: string;
  /** The spot there, '' for any. */
  spot: string;
  /** 'loaded', 'empty' or '' while it goes there. */
  load: string;
  note: string;
}

export interface Waybill {
  id: string;
  /** The car it is for, '' while it waits for one. */
  car: string;
  /** Where its first leg starts (shown on the card), or ''. */
  from: string;
  /** The slot it is on, 1 to 4; 0: finished. */
  leg: number;
  /** Its four slots; null: not used. */
  legs: (WaybillLeg | null)[];
}

export const WAYBILL_SLOTS = 4;

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A saved waybill read back. */
export function asWaybill(r: Readonly<Record<string, unknown>>): Waybill {
  const legs: (WaybillLeg | null)[] = [];
  for (let k = 1; k <= WAYBILL_SLOTS; k++) {
    const to = text(r[`to${k}`]);
    const load = text(r[`load${k}`]);
    legs.push(to ? { to, spot: text(r[`spot${k}`]), load: load === 'loaded' || load === 'empty' ? load : '', note: text(r[`note${k}`]) } : null);
  }
  const leg = r.leg;
  return { id: text(r.id), car: text(r.car), from: text(r.from), leg: typeof leg === 'number' && Number.isInteger(leg) && leg >= 0 && leg <= WAYBILL_SLOTS ? leg : 1, legs };
}

/** The slot a waybill is on (1 to 4), skipping those not used; 0: finished. */
export function currentSlot(w: Waybill): number {
  if (w.leg === 0) return 0;
  for (let k = w.leg; k <= WAYBILL_SLOTS; k++) if (w.legs[k - 1]) return k;
  return 0;
}

/** The leg a waybill is on, or null when it is finished. */
export function currentLeg(w: Waybill): WaybillLeg | null {
  const k = currentSlot(w);
  return k ? w.legs[k - 1]! : null;
}

/** A car's waybill turned to its next leg: the slot it is on then (0: finished), and the car's load. */
export function turnedWaybill(w: Waybill, load: string): { leg: number; load: string } {
  const k = currentSlot(w);
  if (k === 0) return { leg: 0, load };
  const next = currentSlot({ ...w, leg: k + 1 > WAYBILL_SLOTS ? 0 : k + 1 });
  if (next) return { leg: next, load: w.legs[next - 1]!.load || flipped(load) };
  return { leg: 0, load: flipped(w.legs[k - 1]!.load || load) };
}

const flipped = (load: string): string => (load === 'loaded' ? 'empty' : load === 'empty' ? 'loaded' : load);

export interface JobStop {
  /** Its own id (the field is `stop_<id>`). */
  id: string;
  place: string;
  /** Where it is among the stops. */
  at: number;
}

export interface Job {
  id: string;
  name: string;
  /** One of JOB_KINDS (a newer build may write others). */
  kind: string;
  /** The train that does it, or ''. */
  train: string;
  /** Where it is among the jobs. */
  order: number;
  stops: JobStop[];
}

/** The field a stop is kept in. */
export const STOP_PREFIX = 'stop_';

/** A saved job read back, its stops in order. */
export function asJob(r: Readonly<Record<string, unknown>>): Job {
  const stops: JobStop[] = [];
  for (const [k, v] of Object.entries(r)) {
    if (!k.startsWith(STOP_PREFIX) || !v || typeof v !== 'object') continue;
    const s = v as Record<string, unknown>;
    if (typeof s.place !== 'string' || s.place === '') continue;
    stops.push({ id: k.slice(STOP_PREFIX.length), place: s.place, at: typeof s.at === 'number' && Number.isFinite(s.at) ? s.at : 0 });
  }
  stops.sort((a, b) => a.at - b.at || cmp(a.id, b.id));
  stops.length = Math.min(stops.length, 2 * OPS_LIMITS.stops);
  const order = r.order;
  return {
    id: text(r.id),
    name: text(r.name),
    kind: text(r.kind) || 'local',
    train: text(r.train),
    order: typeof order === 'number' && Number.isFinite(order) ? order : 0,
    stops,
  };
}

/** Jobs in the order they are in. */
export function jobsInOrder(jobs: readonly Job[]): Job[] {
  return [...jobs].sort((a, b) => a.order - b.order || cmp(a.id, b.id));
}

/** A number between two others (of things kept in order by one); null: there is none left, number them all again. */
export function orderBetween(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return 1;
  if (a === null) return b! - 1;
  if (b === null) return a + 1;
  const m = (a + b) / 2;
  return m > a && m < b ? m : null;
}

/** The waybill in a car's pocket, if any. */
export function pocketOf(car: { id: string; opsWaybill?: unknown }, waybills: ReadonlyMap<string, Waybill>): Waybill | null {
  const w = typeof car.opsWaybill === 'string' ? waybills.get(car.opsWaybill) : undefined;
  return w && w.car === car.id ? w : null;
}

export interface Destination {
  place: string;
  /** '' for any spot. */
  spot: string;
  why: 'waybill' | 'home';
}

/** Where a car goes: its waybill's leg, else its home, else nowhere. */
export function destinationOf(waybill: Waybill | null, home: string): Destination | null {
  const leg = waybill ? currentLeg(waybill) : null;
  if (leg) return { place: leg.to, spot: leg.spot, why: 'waybill' };
  return home ? { place: home, spot: '', why: 'home' } : null;
}

// ---- where cars are ------------------------------------------------------------

/** How near (studs) a truck must be to a spot's track to stand on it. */
const ON_SPOT = 1.5;

export interface SpotLine {
  place: string;
  spot: string;
  line: readonly Pt[];
}

/** Which spot a car is at: the one with the most of its trucks on it (of two the same, the first by place and spot id), or null. */
export function spotUnder(trucks: readonly Pt[], spots: readonly SpotLine[]): { place: string; spot: string } | null {
  let best: SpotLine | null = null;
  let most = 0;
  for (const s of spots) {
    let n = 0;
    for (const t of trucks) if (nearLine(t, s.line)) n++;
    if (n > most || (n > 0 && n === most && best && (cmp(s.place, best.place) || cmp(s.spot, best.spot)) < 0)) {
      most = n;
      best = s;
    }
  }
  return best ? { place: best.place, spot: best.spot } : null;
}

function nearLine(p: Pt, line: readonly Pt[]): boolean {
  if (line.length === 1) return Math.hypot(line[0]!.x - p.x, line[0]!.y - p.y) <= ON_SPOT;
  for (let k = 1; k < line.length; k++) {
    const a = line[k - 1]!;
    const b = line[k]!;
    if (p.x < Math.min(a.x, b.x) - ON_SPOT || p.x > Math.max(a.x, b.x) + ON_SPOT || p.y < Math.min(a.y, b.y) - ON_SPOT || p.y > Math.max(a.y, b.y) + ON_SPOT) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    if (Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y) <= ON_SPOT) return true;
  }
  return false;
}

/** Which piece of joined-up track each brick is on (a number; two bricks on the same are joined). */
export function trackPieces(net: TrackNetwork): Map<string, number> {
  const out = new Map<string, number>();
  let n = 0;
  for (const start of net.brickIds) {
    if (out.has(start)) continue;
    n++;
    out.set(start, n);
    const queue = [start];
    while (queue.length) {
      const brick = queue.pop()!;
      const kinds = net.trackOf(brick)?.kinds.length ?? 0;
      for (let c = 0; c < kinds; c++) {
        const p = net.partner({ brick, conn: c });
        if (p && !out.has(p.brick)) {
          out.set(p.brick, n);
          queue.push(p.brick);
        }
      }
    }
  }
  return out;
}

// ---- routing --------------------------------------------------------------------

export interface OpsSpot {
  id: string;
  /** Cars it says it holds, or null. */
  capacity: number | null;
  /** The track's usable length (studs), or null when that can't be told. */
  usable: number | null;
  role: string;
  /** The piece of joined-up track it is on (trackPieces), or null: not on the track. */
  track: number | null;
}

export interface OpsPlace {
  id: string;
  kind: string;
  spots: readonly OpsSpot[];
}

export interface OpsCar {
  id: string;
  /** Studs. */
  length: number;
  /** The place and spot it is at ('' spot: at a place off the layout), or null. */
  at: { place: string; spot: string } | null;
  onTrack: boolean;
  /** The train or cut it stands in, or ''. */
  train: string;
  /** Its place in it, and how many cars from the nearest engine. */
  unit: number;
  fromEngine: number;
  to: Destination | null;
  hold: boolean;
}

export interface OpsJob {
  id: string;
  train: string;
  /** Place ids. */
  stops: readonly string[];
}

export type CantRoute =
  | { car: string; why: 'held' | 'offTrack' | 'nowhere' | 'tooMuch' }
  | { car: string; why: 'placeGone'; place: string; by: 'waybill' | 'home' }
  | { car: string; why: 'noJob' | 'noTrack'; from: string; place: string }
  | { car: string; why: 'full'; place: string; spot: string; count: number; capacity: number | null };

export interface RoutedCar {
  job: string;
  /** The stop it is picked up at (its index), or -1: it is on the job's train. */
  pickUp: number;
  /** The stop it is set out at, and the spot there ('' any, or off the layout). */
  setOut: number;
  spot: string;
  /** How many jobs it still takes, this one included. */
  jobs: number;
}

export interface ListStop {
  place: string;
  setOut: { car: string; spot: string }[];
  pickUp: { car: string; to: string }[];
}

export interface OpsRouting {
  cars: Map<string, RoutedCar>;
  /** Cars at their waybill's or home's place already, by id. */
  arrived: string[];
  cantRoute: CantRoute[];
  /** Each job's switch list: its stops, as the job has them. */
  lists: Map<string, ListStop[]>;
}

interface Way {
  jobs: number;
  job: number;
  pickUp: number;
  setOut: number;
}

interface JobWay {
  id: string;
  train: string;
  /** Its stops at places that are there: the stop's index, the place, and the stretch of joined-up stops it is in. */
  stops: { index: number; place: string; piece: number }[];
}

function firstById<T extends { id: string }>(list: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const x of list) if (!out.has(x.id)) out.set(x.id, x);
  return out;
}

/** Whether a train can get from one place to another (a place off the track is always reachable). */
function placesJoined(a: OpsPlace, b: OpsPlace): boolean {
  if (a.id === b.id) return true;
  const ta = a.spots.flatMap((s) => (s.track === null ? [] : [s.track]));
  const tb = b.spots.flatMap((s) => (s.track === null ? [] : [s.track]));
  return ta.length === 0 || tb.length === 0 || ta.some((t) => tb.includes(t));
}

/** The stops a job goes on from that no track joins to the one before (indexes of its stops). */
export function brokenStops(stops: readonly string[], places: readonly OpsPlace[]): number[] {
  const byId = firstById(places);
  const out: number[] = [];
  let last: OpsPlace | null = null;
  stops.forEach((id, i) => {
    const p = byId.get(id);
    if (!p) return;
    if (last && !placesJoined(last, p)) out.push(i);
    last = p;
  });
  return out;
}

/**
 * Every car's next move. `jobs` are in their order. A car goes by the
 * first job that stops where it is and, later, where it goes; else by jobs
 * from yard to yard (the fewest). A car already on a job's train goes with
 * that job. A car that would not fit at its spot stays where it is.
 */
export function routeCars(input: { places: readonly OpsPlace[]; cars: readonly OpsCar[]; jobs: readonly OpsJob[]; maxSteps?: number }): OpsRouting {
  const places = firstById(input.places);
  const cars = [...firstById(input.cars).values()].sort((a, b) => cmp(a.id, b.id));
  const listed = [...firstById(input.jobs).values()];
  const jobs: JobWay[] = listed.map((j) => {
    const stops: JobWay['stops'] = [];
    let piece = 0;
    j.stops.forEach((id, index) => {
      const p = places.get(id);
      if (!p) return;
      const before = stops[stops.length - 1];
      if (before && !placesJoined(places.get(before.place)!, p)) piece++;
      stops.push({ index, place: id, piece });
    });
    return { id: j.id, train: j.train, stops };
  });
  let steps = input.maxSteps ?? ROUTE_STEPS;

  // The way from every place to one, by whole jobs: the first leg of each.
  const ways = new Map<string, Map<string, Way> | null>();
  const waysTo = (dest: string, loose: boolean): Map<string, Way> | null => {
    const key = `${loose ? 1 : 0}${dest}`;
    const had = ways.get(key);
    if (had !== undefined) return had;
    const out = new Map<string, Way>();
    for (let r = 1; r <= MAX_HOPS; r++) {
      let grew = false;
      for (let ji = 0; ji < jobs.length; ji++) {
        const stops = jobs[ji]!.stops;
        steps -= stops.length;
        if (steps < 0) {
          ways.set(key, null);
          return null;
        }
        // From the last stop back: the next stop on that the car can be set out at.
        let target = -1;
        for (let k = stops.length - 1; k >= 0; k--) {
          const s = stops[k]!;
          if (target >= 0 && !loose && stops[target]!.piece !== s.piece) target = -1;
          const w = out.get(s.place);
          if (target >= 0 && s.place !== dest && (!w || (w.jobs === r && w.job === ji))) {
            out.set(s.place, { jobs: r, job: ji, pickUp: k, setOut: target });
            grew = true;
          }
          const isTarget = r === 1 ? s.place === dest : places.get(s.place)!.kind === 'yard' && w !== undefined && w.jobs === r - 1;
          if (isTarget) target = k;
        }
      }
      if (!grew) break;
    }
    ways.set(key, out);
    return out;
  };

  const out: OpsRouting = { cars: new Map(), arrived: [], cantRoute: [], lists: new Map() };
  /** Cars with a way, before their room is looked for. */
  const going: { car: OpsCar; way: Way; aboard: boolean; last: boolean }[] = [];
  const aboardOf = (c: OpsCar): number[] => (c.train ? jobs.flatMap((j, i) => (j.train === c.train ? [i] : [])) : []);
  const ridden = new Set<string>();
  const cant = new Map<string, CantRoute>();

  for (const c of cars) {
    const aboard = aboardOf(c);
    if (aboard.length > 0) ridden.add(c.id);
    if (!c.to) continue;
    const dest = places.get(c.to.place);
    if (!dest) {
      cant.set(c.id, { car: c.id, why: 'placeGone', place: c.to.place, by: c.to.why });
      continue;
    }
    const wantSpot = c.to.spot && dest.spots.some((s) => s.id === c.to!.spot) ? c.to.spot : '';
    const here = c.at && places.has(c.at.place) ? c.at : null;
    if (aboard.length === 0 && here && here.place === dest.id && (!wantSpot || here.spot === wantSpot)) {
      out.arrived.push(c.id);
      continue;
    }
    if (c.hold) {
      cant.set(c.id, { car: c.id, why: 'held' });
      continue;
    }
    if (aboard.length > 0) {
      // On a job's train: set out where it goes, else at the yard nearest to it by jobs.
      let found: { way: Way; last: boolean } | null = null;
      let spent = false;
      for (const ji of aboard) {
        const stops = jobs[ji]!.stops;
        const hereAt = here ? stops.findIndex((s) => s.place === here.place) : -1;
        const after = stops.findIndex((s, k) => k >= hereAt && s.place === dest.id);
        const direct = after >= 0 ? after : stops.findIndex((s) => s.place === dest.id);
        if (direct >= 0) {
          found = { way: { jobs: 1, job: ji, pickUp: -1, setOut: direct }, last: true };
          break;
        }
        const on = waysTo(dest.id, false);
        if (!on) {
          spent = true;
          break;
        }
        for (let k = 0; k < stops.length; k++) {
          const w = places.get(stops[k]!.place)!.kind === 'yard' ? on.get(stops[k]!.place) : undefined;
          if (w && (!found || w.jobs + 1 < found.way.jobs)) found = { way: { jobs: w.jobs + 1, job: ji, pickUp: -1, setOut: k }, last: false };
        }
        if (found) break;
      }
      if (found) going.push({ car: c, way: found.way, aboard: true, last: found.last });
      else if (spent) cant.set(c.id, { car: c.id, why: 'tooMuch' });
      else cant.set(c.id, { car: c.id, why: 'noJob', from: '', place: dest.id });
      continue;
    }
    if (!here) {
      cant.set(c.id, { car: c.id, why: c.onTrack ? 'nowhere' : 'offTrack' });
      continue;
    }
    if (here.place === dest.id) {
      // At the place, another spot: the first job that stops there.
      const ji = jobs.findIndex((j) => j.stops.some((s) => s.place === dest.id));
      if (ji < 0) cant.set(c.id, { car: c.id, why: 'noJob', from: dest.id, place: dest.id });
      else {
        const k = jobs[ji]!.stops.findIndex((s) => s.place === dest.id);
        going.push({ car: c, way: { jobs: 1, job: ji, pickUp: k, setOut: k }, aboard: false, last: true });
      }
      continue;
    }
    const on = waysTo(dest.id, false);
    const way = on?.get(here.place);
    if (way) going.push({ car: c, way, aboard: false, last: way.jobs === 1 });
    else if (!on) cant.set(c.id, { car: c.id, why: 'tooMuch' });
    else {
      const loose = waysTo(dest.id, true);
      cant.set(c.id, { car: c.id, why: loose?.has(here.place) ? 'noTrack' : 'noJob', from: here.place, place: dest.id });
    }
  }

  // Room: those that leave make room; one that finds none stays, and takes up its own again.
  const stuck = new Map<string, CantRoute>();
  let spotsFor = new Map<string, string>();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const leaving = new Set(going.filter((g) => !stuck.has(g.car.id)).map((g) => g.car.id));
    const used = new Map<string, { count: number; length: number }>();
    const take = (place: string, spot: string, length: number) => {
      const key = JSON.stringify([place, spot]);
      const u = used.get(key);
      if (u) {
        u.count++;
        u.length += length;
      } else used.set(key, { count: 1, length });
    };
    for (const c of cars) if (c.at && !leaving.has(c.id) && !ridden.has(c.id)) take(c.at.place, c.at.spot, c.length);
    const at = (place: string, spot: string) => used.get(JSON.stringify([place, spot])) ?? { count: 0, length: 0 };
    const fits = (place: string, s: OpsSpot, length: number) => {
      const u = at(place, s.id);
      if (s.capacity !== null) return u.count < s.capacity;
      return s.usable === null || u.length + length <= s.usable + 1e-6;
    };
    spotsFor = new Map();
    let more = false;
    for (const g of going) {
      if (stuck.has(g.car.id)) continue;
      const place = places.get(jobs[g.way.job]!.stops[g.way.setOut]!.place)!;
      if (place.spots.length === 0) {
        spotsFor.set(g.car.id, '');
        continue;
      }
      const named = g.last && g.car.to!.spot ? place.spots.filter((s) => s.id === g.car.to!.spot) : [];
      const usual = place.spots.filter((s) => s.role !== 'rip' && s.role !== 'engine');
      const tries = named.length > 0 ? named : usual.length > 0 ? usual : place.spots;
      const room = tries.find((s) => fits(place.id, s, g.car.length));
      if (room) {
        take(place.id, room.id, g.car.length);
        spotsFor.set(g.car.id, room.id);
      } else if (!g.last) {
        // A yard on the way: the yardmaster finds it a track.
        spotsFor.set(g.car.id, '');
      } else {
        const total = tries.every((s) => s.capacity !== null) ? tries.reduce((n, s) => n + s.capacity!, 0) : null;
        stuck.set(g.car.id, {
          car: g.car.id,
          why: 'full',
          place: place.id,
          spot: named[0]?.id ?? '',
          count: tries.reduce((n, s) => n + at(place.id, s.id).count, 0),
          capacity: total,
        });
        more = true;
      }
    }
    if (!more) break;
  }
  for (const [id, why] of stuck) cant.set(id, why);

  // The lists.
  const lists = new Map<string, ListStop[]>(listed.map((j) => [j.id, j.stops.map((place) => ({ place, setOut: [], pickUp: [] }))]));
  const placed = going.filter((g) => !stuck.has(g.car.id));
  const spotIndex = (c: OpsCar) => (c.at ? Math.max(0, places.get(c.at.place)?.spots.findIndex((s) => s.id === c.at!.spot) ?? 0) : 0);
  placed.sort(
    (a, b) =>
      a.way.job - b.way.job ||
      Number(b.aboard) - Number(a.aboard) ||
      (a.aboard ? a.car.fromEngine - b.car.fromEngine : a.way.pickUp - b.way.pickUp || spotIndex(a.car) - spotIndex(b.car) || cmp(a.car.train, b.car.train)) ||
      a.car.unit - b.car.unit ||
      cmp(a.car.id, b.car.id),
  );
  for (const g of placed) {
    const job = jobs[g.way.job]!;
    const list = lists.get(job.id)!;
    const setOut = job.stops[g.way.setOut]!.index;
    const pickUp = g.aboard ? -1 : job.stops[g.way.pickUp]!.index;
    const spot = spotsFor.get(g.car.id) ?? '';
    out.cars.set(g.car.id, { job: job.id, pickUp, setOut, spot, jobs: g.way.jobs });
    list[setOut]!.setOut.push({ car: g.car.id, spot });
    if (pickUp >= 0) list[pickUp]!.pickUp.push({ car: g.car.id, to: g.car.to!.place });
  }
  out.cantRoute = [...cant.values()].sort((a, b) => cmp(a.car, b.car));
  out.lists = lists;
  return out;
}

// ---- making waybills -------------------------------------------------------------

export interface MakeCar {
  id: string;
  type: string;
  /** The place it is at, or ''. */
  at: string;
}

export interface MakePlace {
  id: string;
  ships: readonly string[];
  accepts: readonly string[];
  /** Cars it holds altogether, or null when that isn't known (or it is off the layout). */
  capacity: number | null;
}

export interface MadeWaybill {
  car: string;
  from: string;
  legs: WaybillLeg[];
}

export interface MadeWaybills {
  made: MadeWaybill[];
  /** Cars left without: no type, no pair of places for it, or those are full. */
  skipped: { car: string; why: 'noType' | 'noPlaces' | 'full' }[];
}

const typeKey = (t: string): string => t.trim().toLowerCase();

/** Whole numbers below `n`, the same from one seed in both apps. */
export function seeded(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

/** The most places Make waybills looks at (the first by id). */
const MAKE_PLACES = 2000;

/**
 * A waybill for each of these cars (those without one, not engines, not
 * set aside): empty to a place that sends out its type, loaded to one that
 * takes it in. Places are picked at random from the seed, the least used
 * first; none gets more cars than it holds (`heading`: the cars already
 * going to each).
 */
export function makeWaybills(carsIn: readonly MakeCar[], placesIn: readonly MakePlace[], heading: ReadonlyMap<string, number>, seed: number): MadeWaybills {
  const next = seeded(seed);
  const places = [...firstById(placesIn).values()].sort((a, b) => cmp(a.id, b.id)).slice(0, MAKE_PLACES);
  const ships = new Map<string, MakePlace[]>();
  const accepts = new Map<string, MakePlace[]>();
  for (const p of places) {
    for (const [words, into] of [[p.ships, ships], [p.accepts, accepts]] as const)
      for (const t of new Set(words.map(typeKey))) {
        if (!t) continue;
        const l = into.get(t);
        if (l) l.push(p);
        else into.set(t, [p]);
      }
  }
  const cars = [...firstById(carsIn).values()].sort((a, b) => cmp(a.id, b.id));
  for (let i = cars.length - 1; i > 0; i--) {
    const j = next(i + 1);
    [cars[i], cars[j]] = [cars[j]!, cars[i]!];
  }
  const load = new Map<string, number>();
  const going = (p: MakePlace) => load.get(p.id) ?? heading.get(p.id) ?? 0;
  const room = (p: MakePlace) => p.capacity === null || going(p) < p.capacity;
  const pick = (list: readonly MakePlace[], ok: (p: MakePlace) => boolean): MakePlace | null => {
    let least = Infinity;
    let from: MakePlace[] = [];
    for (const p of list) {
      if (!ok(p)) continue;
      const n = going(p);
      if (n < least) {
        least = n;
        from = [p];
      } else if (n === least) from.push(p);
    }
    return from.length ? from[next(from.length)]! : null;
  };
  const out: MadeWaybills = { made: [], skipped: [] };
  for (const c of cars) {
    const t = typeKey(c.type);
    if (!t) {
      out.skipped.push({ car: c.id, why: 'noType' });
      continue;
    }
    const s = ships.get(t) ?? [];
    const a = accepts.get(t) ?? [];
    if (!s.some((p) => a.some((q) => q.id !== p.id))) {
      out.skipped.push({ car: c.id, why: 'noPlaces' });
      continue;
    }
    // Loaded where it stands when that sends out its type, else somewhere that does and has room.
    const isOnly = (p: MakePlace) => a.length === 1 && a[0]!.id === p.id;
    const own = s.find((p) => p.id === c.at && !isOnly(p)) ?? null;
    const from = own ?? pick(s, (p) => room(p) && !isOnly(p));
    const to = from ? pick(a, (p) => p.id !== from.id && room(p)) : null;
    if (!from || !to) {
      out.skipped.push({ car: c.id, why: 'full' });
      continue;
    }
    if (!own) load.set(from.id, going(from) + 1);
    load.set(to.id, going(to) + 1);
    const loaded: WaybillLeg = { to: to.id, spot: '', load: 'loaded', note: '' };
    out.made.push({ car: c.id, from: from.id, legs: own ? [loaded] : [{ to: from.id, spot: '', load: 'empty', note: '' }, loaded] });
  }
  return out;
}
