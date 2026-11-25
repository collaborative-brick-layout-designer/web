// Waybills, jobs and routing in the editor (Live Ops design 2.4, 3): the
// records read from the doc, the routing worked out from them and from
// where the cars stand, the edits (each one undo step), and the words. The
// desktop's src/edit/OpsCommands.cpp and src/ui/OpsText.cpp do the same.

import { useMemo } from 'react';
import * as Y from 'yjs';
import type { Place } from '@cld/bbm';
import { deleteRecord, OPS_JOBS_KEY, readRecordsFromDoc, ROLLING_STOCK_KEY, WAYBILLS_KEY, writeRecord } from '@cld/ydoc';
import {
  asJob, asWaybill, currentLeg, currentSlot, destinationOf, isEngine, jobsInOrder, makeWaybills, orderBetween, OPS_LIMITS, pocketOf, routeCars, spotUnder, STOP_PREFIX, standingIn, trackPieces, turnedWaybill, WAYBILL_SLOTS,
  type CantRoute, type Destination, type Job, type JobStop, type MadeWaybills, type OpsCar, type OpsPlace, type OpsRouting, type PlacedTrain, type RollingStock, type SpotLine, type TrackNetwork, type Train, type Waybill, type WaybillLeg,
} from '@cld/parts-catalog/browser';
import { makeId } from './mutations';
import { readStanding, takeCarOff } from './cuts';
import { spotKey, type PlaceGroup, type SpotNow } from './places';
import { stockLabel } from './trains';
import { LOCAL_ORIGIN } from './useLayoutDoc';

const BEFORE_ORIGIN = Symbol('cld-before-ops');

export interface OpsRecords {
  waybills: ReadonlyMap<string, Waybill>;
  jobs: readonly Job[];
}

export function readOps(doc: Y.Doc): OpsRecords {
  return {
    waybills: new Map(readRecordsFromDoc(doc, WAYBILLS_KEY).map((r) => [r.id, asWaybill(r)])),
    jobs: jobsInOrder(readRecordsFromDoc(doc, OPS_JOBS_KEY).map((r) => asJob(r))),
  };
}

/** `version` changes when the doc does. */
export function useOpsRecords(doc: Y.Doc | null, version: unknown): OpsRecords {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (doc ? readOps(doc) : { waybills: new Map(), jobs: [] }), [doc, version]);
}

// ---- what there is, and where it goes ----------------------------------------

/** A place to choose from, by the name that tells it apart. */
export interface NamedPlace {
  id: string;
  name: string;
  place: Place;
  /** Cars all its spots hold; null: not known, or off the layout. */
  capacity: number | null;
}

export interface OpsView extends OpsRecords {
  /** Every place once, by name. */
  places: readonly NamedPlace[];
  placeById: ReadonlyMap<string, NamedPlace>;
  stock: ReadonlyMap<string, RollingStock>;
  trains: readonly Train[];
  /** The waybill in each car's pocket. */
  pockets: ReadonlyMap<string, Waybill>;
  /** Where each car is: a place and spot, or null. */
  at: ReadonlyMap<string, { place: string; spot: string }>;
  to: ReadonlyMap<string, Destination>;
  routing: OpsRouting;
  /** A job's stops no track joins to the one before (indexes). */
  opsPlaces: readonly OpsPlace[];
  /** Where each car on the track is on the map (studs), for Show me. */
  points: ReadonlyMap<string, { x: number; y: number }>;
}

export interface OpsInput {
  records: OpsRecords;
  groups: readonly PlaceGroup[];
  spots: ReadonlyMap<string, SpotNow>;
  net: TrackNetwork | null;
  stock: ReadonlyMap<string, RollingStock>;
  trains: readonly Train[];
  placed: ReadonlyMap<string, PlacedTrain | null>;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Everything the Live Ops panel shows, worked out. */
export function opsView({ records, groups, spots, net, stock, trains, placed }: OpsInput): OpsView {
  const pieces = net ? trackPieces(net) : new Map<string, number>();
  // The places: the layout's first, then each module's, by the module's id (two of one id: the first).
  const named = new Map<string, NamedPlace>();
  const opsPlaces: OpsPlace[] = [];
  const lines: SpotLine[] = [];
  const times = new Map<string, number>();
  for (const g of groups) for (const p of g.places) times.set(p.name, (times.get(p.name) ?? 0) + 1);
  for (const g of [...groups].sort((a, b) => cmp(a.owner ?? '', b.owner ?? ''))) {
    for (const p of g.places) {
      if (named.has(p.id)) continue;
      const now = p.spots.map((s) => spots.get(spotKey(g.owner, p.id, s.id)));
      const caps = now.map((s) => s?.capacity ?? null);
      const name = p.name || '(no name)';
      named.set(p.id, {
        id: p.id,
        name: (times.get(p.name) ?? 0) > 1 && g.owner !== null ? `${name} (${g.name})` : name,
        place: p,
        capacity: caps.length > 0 && caps.every((c) => c !== null) ? caps.reduce<number>((n, c) => n + c!, 0) : null,
      });
      opsPlaces.push({
        id: p.id,
        kind: p.kind,
        spots: p.spots.map((s, i) => ({ id: s.id, capacity: s.capacity ?? null, usable: now[i]?.at?.usable ?? null, role: s.role ?? '', track: s.track ? (pieces.get(s.track.brick) ?? null) : null })),
      });
      p.spots.forEach((s, i) => {
        const at = now[i]?.at;
        if (at) lines.push({ place: p.id, spot: s.id, line: at.line });
      });
    }
  }
  const pockets = new Map<string, Waybill>();
  const at = new Map<string, { place: string; spot: string }>();
  const to = new Map<string, Destination>();
  const points = new Map<string, { x: number; y: number }>();
  const cars: OpsCar[] = [];
  const standing = new Map<string, { train: Train; unit: number }>();
  for (const t of trains) if (t.position) t.units.forEach((u, unit) => { if (!standing.has(u.stock)) standing.set(u.stock, { train: t, unit }); });
  for (const t of trains) {
    for (const u of placed.get(t.id)?.units ?? []) {
      if (standing.get(u.stock)?.train.id !== t.id) continue;
      points.set(u.stock, { x: (u.frontTruck.x + u.rearTruck.x) / 2, y: (u.frontTruck.y + u.rearTruck.y) / 2 });
      const spot = spotUnder([u.frontTruck, u.rearTruck], lines);
      if (spot) at.set(u.stock, spot);
    }
  }
  for (const s of stock.values()) {
    const w = pocketOf(s, records.waybills);
    if (w) pockets.set(s.id, w);
    const stands = standing.get(s.id);
    if (!stands && s.opsAt && named.has(s.opsAt)) at.set(s.id, { place: s.opsAt, spot: '' });
    const dest = destinationOf(w, s.opsHome ?? '');
    if (dest) to.set(s.id, dest);
    if (isEngine(s)) continue;
    const engines = stands ? stands.train.units.flatMap((u, i) => (isEngine(stock.get(u.stock)) ? [Math.abs(i - stands.unit)] : [])) : [];
    cars.push({
      id: s.id,
      length: s.length,
      at: at.get(s.id) ?? null,
      onTrack: !!stands,
      train: stands?.train.id ?? '',
      unit: stands?.unit ?? 0,
      fromEngine: engines.length ? Math.min(...engines) : 0,
      to: dest,
      hold: s.opsHold === true,
    });
  }
  const routing = routeCars({ places: opsPlaces, cars, jobs: records.jobs.map((j) => ({ id: j.id, train: j.train, stops: j.stops.map((s) => s.place) })) });
  return { ...records, places: [...named.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || cmp(a.id, b.id)), placeById: named, stock, trains, pockets, at, to, routing, opsPlaces, points };
}

// ---- edits -------------------------------------------------------------------

function carRecord(doc: Y.Doc, car: string): Y.Map<unknown> | null {
  const all = doc.getMap('meta').get(ROLLING_STOCK_KEY);
  const rec = all instanceof Y.Map ? (all.get(car) as unknown) : undefined;
  return rec instanceof Y.Map ? rec : null;
}

const NONE: Record<'opsWaybill' | 'opsHome' | 'opsAt' | 'opsHold', unknown> = { opsWaybill: '', opsHome: '', opsAt: '', opsHold: false };

/** Set a car's ops fields. One it doesn't have yet is first written as none, outside Undo: what is there can be undone to, a key that isn't can't. */
function setCar(doc: Y.Doc, car: string, fields: Partial<Record<keyof typeof NONE | 'opsLoad', unknown>>): void {
  const rec = carRecord(doc, car);
  if (rec) for (const [k, v] of Object.entries(fields)) if (rec.get(k) !== v) rec.set(k, v);
}
function prepareCars(doc: Y.Doc, cars: readonly string[], fields: readonly string[]): void {
  doc.transact(() => {
    for (const car of cars) {
      const rec = carRecord(doc, car);
      // (Only these: another field someone else sets just now would lose to it.)
      if (rec) for (const k of fields) if (!rec.has(k)) rec.set(k, NONE[k as keyof typeof NONE]);
    }
  }, BEFORE_ORIGIN);
}

/** A whole waybill's fields. */
export function waybillFields(w: { car?: string; from?: string; legs?: readonly (WaybillLeg | null)[] }): Record<string, unknown> {
  const out: Record<string, unknown> = { car: w.car ?? '', from: w.from ?? '', leg: 1 };
  for (let k = 1; k <= WAYBILL_SLOTS; k++) {
    const l = w.legs?.[k - 1] ?? null;
    out[`to${k}`] = l?.to ?? '';
    out[`spot${k}`] = l?.spot ?? '';
    out[`load${k}`] = l?.load ?? '';
    out[`note${k}`] = l?.note ?? '';
  }
  return out;
}

/** A new, empty waybill, or null when there are as many as there may be. */
export function addWaybill(doc: Y.Doc, car = ''): string | null {
  if (readRecordsFromDoc(doc, WAYBILLS_KEY).length >= OPS_LIMITS.waybills) return null;
  const id = makeId();
  if (car) prepareCars(doc, [car], ['opsWaybill']);
  doc.transact(() => {
    writeRecord(doc, WAYBILLS_KEY, { id, ...waybillFields({ car }) });
    if (car) setCar(doc, car, { opsWaybill: id });
  }, LOCAL_ORIGIN);
  return id;
}

/** Change some of a waybill's fields: one undo step. */
export function saveWaybill(doc: Y.Doc, id: string, fields: Record<string, unknown>): void {
  if (!readOps(doc).waybills.has(id)) return;
  doc.transact(() => writeRecord(doc, WAYBILLS_KEY, { id, ...fields }), LOCAL_ORIGIN);
}

/** Put a waybill in a car's pocket ('': in none, it waits for one). The one that was there waits for a car; the car's load is the leg's. */
export function giveWaybill(doc: Y.Doc, id: string, car: string): void {
  const { waybills } = readOps(doc);
  const w = waybills.get(id);
  if (!w) return;
  const held = readStanding(doc).stock.get(car)?.opsWaybill;
  prepareCars(doc, [car, w.car], ['opsWaybill']);
  doc.transact(() => {
    if (w.car && w.car !== car && carRecord(doc, w.car)?.get('opsWaybill') === id) setCar(doc, w.car, { opsWaybill: '' });
    if (car && held && held !== id && waybills.get(held)?.car === car) writeRecord(doc, WAYBILLS_KEY, { id: held, car: '' });
    writeRecord(doc, WAYBILLS_KEY, { id, car });
    if (car) {
      const load = currentLeg(w)?.load;
      setCar(doc, car, { opsWaybill: id, ...(load ? { opsLoad: load } : {}) });
    }
  }, LOCAL_ORIGIN);
}

export function removeWaybill(doc: Y.Doc, id: string): void {
  const w = readOps(doc).waybills.get(id);
  if (w?.car) prepareCars(doc, [w.car], ['opsWaybill']);
  doc.transact(() => {
    if (w?.car && carRecord(doc, w.car)?.get('opsWaybill') === id) setCar(doc, w.car, { opsWaybill: '' });
    deleteRecord(doc, WAYBILLS_KEY, id);
  }, LOCAL_ORIGIN);
}

/** Delivered: the car's waybill turns to its next leg, and its load with it. One bound for a place off the layout leaves the track. */
export function turnCar(doc: Y.Doc, car: string, offTo?: { place: string; net: TrackNetwork | null; states: Readonly<Record<string, number>> }): void {
  const { waybills } = readOps(doc);
  const { stock, trains } = readStanding(doc);
  const s = stock.get(car);
  const w = s ? pocketOf(s, waybills) : null;
  if (!s || !w || currentSlot(w) === 0) return;
  const next = turnedWaybill(w, s.opsLoad ?? '');
  if (offTo) prepareCars(doc, [car], ['opsAt']);
  doc.transact(() => {
    if (offTo) {
      const stands = standingIn(car, trains);
      if (stands && offTo.net) takeCarOff(doc, offTo.net, offTo.states, car);
      setCar(doc, car, { opsAt: offTo.place });
    }
    writeRecord(doc, WAYBILLS_KEY, { id: w.id, leg: next.leg });
    setCar(doc, car, { opsLoad: next.load });
  }, LOCAL_ORIGIN);
}

/** A finished waybill back on its first leg. */
export function restartWaybill(doc: Y.Doc, id: string): void {
  const w = readOps(doc).waybills.get(id);
  if (!w) return;
  const load = currentLeg({ ...w, leg: 1 })?.load;
  doc.transact(() => {
    writeRecord(doc, WAYBILLS_KEY, { id, leg: 1 });
    if (w.car && load && carRecord(doc, w.car)?.get('opsWaybill') === id) setCar(doc, w.car, { opsLoad: load });
  }, LOCAL_ORIGIN);
}

/** Set a car aside (or not), its home, or the place off the layout it is at: one undo step. */
export function setCarOps(doc: Y.Doc, car: string, fields: { opsHold?: boolean; opsHome?: string; opsAt?: string }): void {
  prepareCars(doc, [car], Object.keys(fields));
  doc.transact(() => setCar(doc, car, fields), LOCAL_ORIGIN);
}

/** What Make waybills would make, from a seed: every car without one. */
export function previewWaybills(view: OpsView, seed: number): MadeWaybills {
  const heading = new Map<string, number>();
  for (const d of view.to.values()) if (d.why === 'waybill') heading.set(d.place, (heading.get(d.place) ?? 0) + 1);
  const cars = [...view.stock.values()]
    .filter((s) => !isEngine(s) && s.opsHold !== true && !(view.pockets.get(s.id) && currentSlot(view.pockets.get(s.id)!) > 0))
    .map((s) => ({ id: s.id, type: s.type, at: view.at.get(s.id)?.place ?? '' }));
  return makeWaybills(cars, view.places.map((p) => ({ id: p.id, ships: p.place.ships, accepts: p.place.accepts, capacity: p.capacity })), heading, seed);
}

/** Make them: one undo step. Returns how many (as many as there is room for). */
export function addMadeWaybills(doc: Y.Doc, made: MadeWaybills): number {
  const free = OPS_LIMITS.waybills - readRecordsFromDoc(doc, WAYBILLS_KEY).length;
  const { waybills } = readOps(doc);
  const { stock } = readStanding(doc);
  // (Someone may have given a car one since the preview.)
  const list = made.made.filter((m) => {
    const s = stock.get(m.car);
    const w = s ? pocketOf(s, waybills) : null;
    return s && (!w || currentSlot(w) === 0);
  }).slice(0, Math.max(0, free));
  if (list.length === 0) return 0;
  prepareCars(doc, list.map((m) => m.car), ['opsWaybill']);
  doc.transact(() => {
    for (const m of list) {
      const id = makeId();
      const old = stock.get(m.car)!.opsWaybill;
      // A finished one is out of the way.
      if (old && waybills.get(old)?.car === m.car) deleteRecord(doc, WAYBILLS_KEY, old);
      writeRecord(doc, WAYBILLS_KEY, { id, ...waybillFields(m) });
      setCar(doc, m.car, { opsWaybill: id, opsLoad: m.legs[0]!.load });
    }
  }, LOCAL_ORIGIN);
  return list.length;
}

export function addJob(doc: Y.Doc): string | null {
  const { jobs } = readOps(doc);
  if (jobs.length >= OPS_LIMITS.jobs) return null;
  let n = jobs.length + 1;
  while (jobs.some((j) => j.name === `Job ${n}`)) n++;
  const id = makeId();
  doc.transact(() => writeRecord(doc, OPS_JOBS_KEY, { id, name: `Job ${n}`, kind: 'local', train: '', order: (jobs.at(-1)?.order ?? 0) + 1 }), LOCAL_ORIGIN);
  return id;
}

export function saveJob(doc: Y.Doc, id: string, fields: { name?: string; kind?: string; train?: string }): void {
  if (!readOps(doc).jobs.some((j) => j.id === id)) return;
  doc.transact(() => writeRecord(doc, OPS_JOBS_KEY, { id, ...fields }), LOCAL_ORIGIN);
}

export function removeJob(doc: Y.Doc, id: string): void {
  doc.transact(() => deleteRecord(doc, OPS_JOBS_KEY, id), LOCAL_ORIGIN);
}

/** The numbers a list needs so that the one at `i` moves by `d` (only it, when there is a number between): index -> number. */
function moved(at: readonly number[], i: number, d: -1 | 1): Map<number, number> {
  const j = i + d;
  if (i < 0 || j < 0 || j >= at.length) return new Map();
  const before = d < 0 ? (at[j - 1] ?? null) : at[j]!;
  const after = d < 0 ? at[j]! : (at[j + 1] ?? null);
  const n = before !== null && after !== null && !(before < after) ? null : orderBetween(before, after);
  if (n !== null) return new Map([[i, n]]);
  // No number left between: number them all.
  const order = at.map((_, k) => k);
  order.splice(i, 1);
  order.splice(j, 0, i);
  return new Map(order.map((k, n2) => [k, n2 + 1]));
}

export function moveJob(doc: Y.Doc, id: string, d: -1 | 1): void {
  const { jobs } = readOps(doc);
  const to = moved(jobs.map((j) => j.order), jobs.findIndex((j) => j.id === id), d);
  doc.transact(() => {
    for (const [k, order] of to) writeRecord(doc, OPS_JOBS_KEY, { id: jobs[k]!.id, order });
  }, LOCAL_ORIGIN);
}

const stopField = (s: JobStop, at = s.at) => ({ [STOP_PREFIX + s.id]: { place: s.place, at } });

export function addStop(doc: Y.Doc, job: string, place: string): void {
  const j = readOps(doc).jobs.find((x) => x.id === job);
  if (!j || j.stops.length >= OPS_LIMITS.stops) return;
  doc.transact(() => writeRecord(doc, OPS_JOBS_KEY, { id: job, ...stopField({ id: makeId(), place, at: (j.stops.at(-1)?.at ?? 0) + 1 }) }), LOCAL_ORIGIN);
}

export function moveStop(doc: Y.Doc, job: string, stop: string, d: -1 | 1): void {
  const j = readOps(doc).jobs.find((x) => x.id === job);
  if (!j) return;
  const to = moved(j.stops.map((s) => s.at), j.stops.findIndex((s) => s.id === stop), d);
  doc.transact(() => {
    for (const [k, at] of to) writeRecord(doc, OPS_JOBS_KEY, { id: job, ...stopField(j.stops[k]!, at) });
  }, LOCAL_ORIGIN);
}

export function removeStop(doc: Y.Doc, job: string, stop: string): void {
  const all = doc.getMap('meta').get(OPS_JOBS_KEY);
  const rec = all instanceof Y.Map ? (all.get(job) as unknown) : undefined;
  if (rec instanceof Y.Map) doc.transact(() => rec.delete(STOP_PREFIX + stop), LOCAL_ORIGIN);
}

// ---- words ---------------------------------------------------------------------

export const JOB_KIND_LABEL: Record<string, string> = { local: 'Local', yard: 'Yard job', through: 'Through freight', turn: 'Turn' };
export const JOB_KIND_HINT: Record<string, string> = {
  local: 'Works the industries along the way.',
  yard: 'Sorts cars in a yard.',
  through: 'Runs from one yard or staging to another.',
  turn: 'Goes out, works, and comes back.',
};

/** Ask for the Live Ops panel (on a phone, its sheet). */
export function openLiveOps(detail: { tab?: 'cars' | 'waybills' | 'jobs'; waybill?: string; job?: string } = {}): void {
  window.dispatchEvent(new CustomEvent('cld:open-live-ops', { detail }));
}

export const GONE_PLACE = 'A place that was deleted';
export const placeName = (view: Pick<OpsView, 'placeById'>, id: string): string => view.placeById.get(id)?.name ?? GONE_PLACE;
/** "Cannery, Dock". */
export function spotName(view: Pick<OpsView, 'placeById'>, place: string, spot: string): string {
  const p = view.placeById.get(place);
  const s = spot ? p?.place.spots.find((x) => x.id === spot) : undefined;
  return p && s ? `${p.name}, ${s.name || 'a spot'}` : placeName(view, place);
}
export function carName(view: Pick<OpsView, 'stock'>, id: string): string {
  const s = view.stock.get(id);
  return s ? stockLabel(s) : 'A car that was deleted';
}
export const trainName = (view: Pick<OpsView, 'trains' | 'stock'>, id: string): string => {
  const t = view.trains.find((x) => x.id === id);
  return t ? t.name || 'Train' : '';
};

/** "Loaded to Mill". */
export function legText(view: Pick<OpsView, 'placeById'>, leg: WaybillLeg): string {
  const where = spotName(view, leg.to, leg.spot);
  return leg.load === 'loaded' ? `Loaded to ${where}` : leg.load === 'empty' ? `Empty to ${where}` : `To ${where}`;
}

/** Why a car can't be routed. */
export function cantText(view: Pick<OpsView, 'placeById' | 'stock'>, c: CantRoute): string {
  switch (c.why) {
    case 'held':
      return 'It’s set aside.';
    case 'offTrack':
      return 'It isn’t on the track. Put it on the track, or say which place off the layout it’s at.';
    case 'nowhere':
      return 'It isn’t at a place.';
    case 'tooMuch':
      return 'There are too many jobs and places to work out its way.';
    case 'placeGone':
      return c.by === 'home' ? 'Its home was deleted. Pick another.' : 'The place it goes to was deleted. Pick another on its waybill.';
    case 'noTrack':
      return `No track joins ${placeName(view, c.from)} to ${placeName(view, c.place)}.`;
    case 'noJob':
      if (c.from === '') return `The job whose train it’s on doesn’t go to ${placeName(view, c.place)}.`;
      return c.from === c.place ? `No job stops at ${placeName(view, c.place)}.` : `No job goes from ${placeName(view, c.from)} to ${placeName(view, c.place)}.`;
    case 'full': {
      const where = spotName(view, c.place, c.spot);
      return c.capacity === null ? `${where} is full.` : `${where} is full (${c.count} of ${c.capacity}).`;
    }
  }
}

const some = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What deleting these places does to waybills, homes and jobs ('' when nothing names them). */
export function deletedPlacesText(doc: Y.Doc, places: readonly string[]): string {
  const { waybills, jobs } = readOps(doc);
  const gone = new Set(places);
  const w = [...waybills.values()].filter((x) => x.from !== '' && gone.has(x.from) ? true : x.legs.some((l) => l && gone.has(l.to))).length;
  const j = jobs.filter((x) => x.stops.some((s) => gone.has(s.place))).length;
  const homes = [...readStanding(doc).stock.values()].filter((s) => s.opsHome && gone.has(s.opsHome)).length;
  const parts = [...(w ? [some(w, 'waybill', 'waybills')] : []), ...(j ? [some(j, 'job', 'jobs')] : []), ...(homes ? [some(homes, 'car’s home', 'cars’ homes')] : [])];
  if (parts.length === 0) return '';
  return `In use by ${parts.join(', ')}: nothing is lost, and those cars are listed under Can’t route in Live Ops until you send them somewhere else.`;
}

/** What deleting a car does to its waybill ('' when it has none). */
export function deletedCarText(doc: Y.Doc, car: string): string {
  const s = readStanding(doc).stock.get(car);
  return s && pocketOf(s, readOps(doc).waybills) ? 'Its waybill stays, waiting for another car.' : '';
}
