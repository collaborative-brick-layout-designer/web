// Cars on the track in the editor (Live Ops design 2.2, 2.3): what a drag,
// Put on the track, Take off the track and a car's load write, each one
// undo step. What an undo must not take away is written before it, outside
// Undo: the new cut's (empty) record, and the cut each car was in. So an
// undo leaves a car someone else has coupled there since standing where it
// is, and a car whose cut's list changed meanwhile goes back to its cut.
// The desktop's src/edit/CutCommands.cpp does the same.

import * as Y from 'yjs';
import { deleteRecord, readRecordsFromDoc, ROLLING_STOCK_KEY, TRAINS_KEY, writeRecord } from '@cld/ydoc';
import {
  asStock,
  CUT_LIMITS,
  EMPTIED_KEEP_MS,
  newCut,
  placeTrain,
  settleTrains,
  standingIn,
  standOver,
  takeOut,
  type CutChange,
  type CutMove,
  type Load,
  type RollingStock,
  type TrackNetwork,
  type Train,
  type TrainPosition,
} from '@cld/parts-catalog/browser';
import { LOCAL_ORIGIN } from './useLayoutDoc';
import { makeId } from './mutations';
import { asTrain, stockLabel } from './trains';

const BEFORE_ORIGIN = Symbol('cld-before-cut');
const plain = <T extends object>(v: T) => JSON.parse(JSON.stringify(v)) as Record<string, unknown> & { id: string };

/** The layout as it stands now: every train (cuts with no cars included), and the cars. */
export function readStanding(doc: Y.Doc): { trains: Train[]; stock: Map<string, RollingStock> } {
  const stock = new Map(readRecordsFromDoc(doc, ROLLING_STOCK_KEY).map((r) => [r.id, asStock(r)]));
  return { trains: settleTrains(readRecordsFromDoc(doc, TRAINS_KEY).map((r) => asTrain(r)), stock), stock };
}

/** The cut a car is in; '': none (a key that is there can be undone to what it was, one that isn't can't). */
function setCarCut(doc: Y.Doc, car: string, cut: string): void {
  const all = doc.getMap('meta').get(ROLLING_STOCK_KEY);
  const rec = all instanceof Y.Map ? (all.get(car) as unknown) : undefined;
  if (rec instanceof Y.Map && rec.get('opsCut') !== cut) rec.set('opsCut', cut);
}

/** Write what a drag (or taking a car out) does: one undo step. */
export function writeCutChange(doc: Y.Doc, change: CutChange, now = Date.now()): void {
  if (change.trains.length === 0 && change.emptied.length === 0 && Object.keys(change.cars).length === 0) return;
  const { trains, stock } = readStanding(doc);
  const byId = new Map(trains.map((t) => [t.id, t]));
  doc.transact(() => {
    for (const t of change.trains) if (!byId.has(t.id)) writeRecord(doc, TRAINS_KEY, plain({ ...t, units: [], emptiedAt: now }));
    for (const car of Object.keys(change.cars)) {
      setCarCut(doc, car, standingIn(car, trains)?.id ?? '');
    }
    // Cuts left empty a day ago or more, that no car names, go.
    const named = new Set([...stock.values()].map((s) => s.opsCut));
    for (const t of trains)
      if (t.cut && t.units.length === 0 && typeof t.emptiedAt === 'number' && now - t.emptiedAt > EMPTIED_KEEP_MS && !named.has(t.id) && !change.trains.some((x) => x.id === t.id)) deleteRecord(doc, TRAINS_KEY, t.id);
  }, BEFORE_ORIGIN);
  doc.transact(() => {
    for (const t of change.trains) writeRecord(doc, TRAINS_KEY, plain(t));
    for (const id of change.emptied) {
      const t = byId.get(id);
      if (t) writeRecord(doc, TRAINS_KEY, plain({ ...t, units: [], emptiedAt: now }));
    }
    for (const [car, cut] of Object.entries(change.cars)) setCarCut(doc, car, cut ?? '');
  }, LOCAL_ORIGIN);
}

/** Fold a later change into an earlier one (the trains it was made from are the earlier one's). */
function merged(a: CutChange, b: CutChange): CutChange {
  const trains = new Map([...a.trains, ...b.trains].map((t) => [t.id, t]));
  const emptied = [...new Set([...a.emptied, ...b.emptied])].filter((id) => !b.trains.some((t) => t.id === id));
  for (const id of emptied) trains.delete(id);
  return { trains: [...trains.values()], cars: { ...a.cars, ...b.cars }, emptied };
}

/** The trains with a change made. */
export function afterChange(trains: readonly Train[], change: CutChange): Train[] {
  const byId = new Map(trains.map((t) => [t.id, t]));
  for (const t of change.trains) byId.set(t.id, t);
  for (const id of change.emptied) {
    const t = byId.get(id);
    if (t) byId.set(id, { ...t, units: [] });
  }
  return [...byId.values()];
}

/** Take these cars out of wherever they stand (`except`: not out of that one). */
export function takeOutAll(net: TrackNetwork, trains: readonly Train[], stock: ReadonlyMap<string, RollingStock>, states: Readonly<Record<string, number>>, cars: readonly string[], except?: string): CutChange {
  let change: CutChange = { trains: [], cars: {}, emptied: [] };
  let now = [...trains];
  for (const car of cars) {
    const at = standingIn(car, now);
    if (!at || at.id === except) continue;
    const c = takeOut(net, now, stock, states, car, makeId());
    change = merged(change, c);
    now = afterChange(now, c);
  }
  return change;
}

/** Put these cars on the track at `position`, coupled, as one cut (taken out of where they stand). Returns its id. */
export function putCarsOnTrack(doc: Y.Doc, net: TrackNetwork, states: Readonly<Record<string, number>>, cars: readonly string[], position: TrainPosition): string | null {
  const { trains, stock } = readStanding(doc);
  const list = cars.flatMap((id) => stock.get(id) ?? []).slice(0, CUT_LIMITS.units);
  if (list.length === 0) return null;
  const change = takeOutAll(net, trains, stock, states, list.map((s) => s.id));
  const cut = newCut(makeId(), list, position);
  cut.over = standOver(net, cut, stock, states);
  change.trains.push(cut);
  for (const s of list) change.cars[s.id] = cut.id;
  writeCutChange(doc, change);
  return cut.id;
}

/** Put a train on the track: its cars come off whatever cut they stand in. */
export function putTrainOnTrack(doc: Y.Doc, net: TrackNetwork, states: Readonly<Record<string, number>>, train: Train, position: TrainPosition): void {
  const { trains, stock } = readStanding(doc);
  // (Two plain trains may share a car, as before.)
  const taken = train.units.map((u) => u.stock).filter((id) => {
    const at = standingIn(id, trains);
    return at && at.id !== train.id && (at.cut || stock.get(id)?.opsCut);
  });
  const change = takeOutAll(net, trains, stock, states, taken, train.id);
  change.trains = change.trains.filter((t) => t.id !== train.id);
  const placed = { ...train, position, over: {} };
  change.trains.push({ ...placed, over: standOver(net, placed, stock, states) });
  for (const u of train.units) if (taken.includes(u.stock) || stock.get(u.stock)?.opsCut) change.cars[u.stock] = train.id;
  writeCutChange(doc, change);
}

/** Save a train as changed in its editor: cars added to one on the track come off where they stood, cars left out are no longer in it. */
export function saveTrainCars(doc: Y.Doc, net: TrackNetwork | null, states: Readonly<Record<string, number>>, train: Train): void {
  const { trains, stock } = readStanding(doc);
  const before = trains.find((t) => t.id === train.id);
  const left = (before?.units ?? []).map((u) => u.stock).filter((id) => !train.units.some((u) => u.stock === id));
  let change: CutChange = { trains: [], cars: {}, emptied: [] };
  if (train.position && net) {
    const added = train.units.map((u) => u.stock).filter((id) => {
      const at = standingIn(id, trains);
      return at && at.id !== train.id && (at.cut || stock.get(id)?.opsCut);
    });
    change = takeOutAll(net, trains, stock, states, added, train.id);
    for (const u of train.units) if (added.includes(u.stock) || stock.get(u.stock)?.opsCut) change.cars[u.stock] = train.id;
  }
  for (const id of left) if (stock.get(id)?.opsCut === train.id) change.cars[id] = null;
  change.trains.push(train.units.length ? train : { ...train, position: null });
  writeCutChange(doc, change);
}

/** Take one car off the track. */
export function takeCarOff(doc: Y.Doc, net: TrackNetwork, states: Readonly<Record<string, number>>, car: string): void {
  const { trains, stock } = readStanding(doc);
  writeCutChange(doc, takeOut(net, trains, stock, states, car, makeId()));
}

/** Take a whole cut off the track (its cars stay in the layout). */
export function takeCutOff(doc: Y.Doc, id: string): void {
  const t = readStanding(doc).trains.find((x) => x.id === id);
  if (t) writeCutChange(doc, { trains: [], cars: Object.fromEntries(t.units.map((u) => [u.stock, null])), emptied: [id] });
}

/** A car's load (''; it doesn't apply): one undo step. */
export function setLoad(doc: Y.Doc, car: string, load: Load): void {
  doc.transact(() => {
    const all = doc.getMap('meta').get(ROLLING_STOCK_KEY);
    const rec = all instanceof Y.Map ? (all.get(car) as unknown) : undefined;
    if (!(rec instanceof Y.Map)) return;
    if (load === '') {
      if (rec.has('opsLoad')) rec.delete('opsLoad');
    } else if (rec.get('opsLoad') !== load) rec.set('opsLoad', load);
  }, LOCAL_ORIGIN);
}

/** Where cars or a train put at a spot sit: facing the way they fit. */
export function fitAt(net: TrackNetwork, train: Train, spot: Omit<TrainPosition, 'facing'>, stock: ReadonlyMap<string, RollingStock>, states: Readonly<Record<string, number>>): { position: TrainPosition; fits: boolean } {
  const tries = (['to', 'from'] as const).map((facing) => {
    const position = { ...spot, facing };
    return { position, placed: placeTrain(net, { ...train, position, over: {} }, stock, states) };
  });
  const best = tries.find((x) => x.placed && !x.placed.offTrack) ?? tries.find((x) => x.placed) ?? tries[0]!;
  return { position: best.position, fits: !!best.placed && !best.placed.offTrack };
}

/** What a cut is called: its first car, and how many more. */
export function cutName(t: Train, stock: ReadonlyMap<string, RollingStock>): string {
  const cars = t.units.flatMap((u) => stock.get(u.stock) ?? []);
  if (cars.length === 0) return 'Cars';
  const first = stockLabel(cars[0]!);
  return cars.length === 1 ? first : `${first} and ${cars.length - 1} more`;
}

/** Trains with a name to show: a cut's is its cars'. */
export function namedTrains(trains: readonly Train[], stock: ReadonlyMap<string, RollingStock>): Train[] {
  return trains.map((t) => (t.cut && !t.name ? { ...t, name: cutName(t, stock) } : t));
}

/** What a drag did (or why not), for the status line; null: nothing to say. */
export function moveText(m: CutMove, trains: readonly Train[], stock: ReadonlyMap<string, RollingStock>): string | null {
  const name = (id: string | null) => {
    const t = trains.find((x) => x.id === id);
    return t ? t.name || cutName(t, stock) : '';
  };
  if (m.couples) return `Coupled to ${name(m.couples)}.`;
  if (m.why === 'trains') return `Stopped against ${name(m.blockedBy)}: two trains don’t couple.`;
  if (m.why === 'coupler') return `Stopped against ${name(m.blockedBy)}: there’s no coupler at that end.`;
  if (m.why === 'full') return `Stopped against ${name(m.blockedBy)}: a train can have up to ${CUT_LIMITS.units} cars.`;
  if (m.blockedBy) return `Stopped against ${name(m.blockedBy)}.`;
  return null;
}

/** The fields every car and train has from the start (a car's opsCut: from its first move). */
const ALWAYS: Record<string, readonly string[]> = {
  [TRAINS_KEY]: ['name', 'trackKind', 'units', 'position', 'color', 'speed'],
  [ROLLING_STOCK_KEY]: ['number', 'name', 'kind', 'type', 'trackKind', 'length', 'width', 'bodyLength', 'trucks', 'couplers', 'look', 'notes', 'opsCut'],
};

/** Those fields of every car and train, before an undo or redo. */
export function trainFields(doc: Y.Doc): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, fields] of Object.entries(ALWAYS)) {
    const all = doc.getMap('meta').get(key);
    if (!(all instanceof Y.Map)) continue;
    for (const [id, rec] of all.entries()) if (rec instanceof Y.Map) for (const f of fields) if (rec.has(f)) out.set(JSON.stringify([key, id, f]), rec.get(f));
  }
  return out;
}

/**
 * Put back the fields an undo or redo took away: when two people set one at
 * once, Yjs undoes it to nothing, and a cut without its cars or its place
 * would lose them. It keeps what it had.
 */
export function keepTrainFields(doc: Y.Doc, before: ReadonlyMap<string, unknown>): void {
  doc.transact(() => {
    for (const [at, value] of before) {
      const [key, id, f] = JSON.parse(at) as [string, string, string];
      const all = doc.getMap('meta').get(key);
      const rec = all instanceof Y.Map ? (all.get(id) as unknown) : undefined;
      if (rec instanceof Y.Map && !rec.has(f)) rec.set(f, value);
    }
  }, BEFORE_ORIGIN);
}
