// Rolling stock and trains in the editor (trains design 2.3, 2.4, 2.6, 6.4):
// the layout's engines and cars and its trains, read from the doc; where
// each train sits on the track now; the edits, each one undo step; and
// copies to and from a roster (yours or a club's), linked by libraryId and
// libraryVersion. The desktop's ui/TrainsPanel.cpp does the same.

import { useMemo } from 'react';
import * as Y from 'yjs';
import { deleteRecord, readRecordsFromDoc, ROLLING_STOCK_KEY, TRAINS_KEY, writeRecord } from '@cld/ydoc';
import {
  asStock,
  placeTrain,
  simpleStock,
  trainLength,
  type PlacedTrain,
  type RollingStock,
  type Train,
  type TrackNetwork,
  type TrainPosition,
} from '@cld/parts-catalog/browser';
import { LOCAL_ORIGIN } from './useLayoutDoc';
import { makeId } from './mutations';

/** The colors new cars and trains take in turn. */
export const STOCK_COLORS = ['#B40000', '#0055BF', '#237841', '#F2CD37', '#6C6E68', '#FE8A18', '#05131D', '#A0A5A9'];

/** Plain words for each kind of stock (the record keeps the key). */
export const KIND_LABELS: Record<RollingStock['kind'], string> = {
  engine: 'Engine',
  car: 'Car',
  cab: 'Cab car',
  unit: 'Powered car (multiple unit)',
  monorail: 'Monorail car',
};

/** A saved train read back, with defaults for what's missing (unknown fields kept). */
export function asTrain(r: Record<string, unknown>): Train {
  const p = r.position as Partial<TrainPosition> | null | undefined;
  const position: TrainPosition | null =
    p && typeof p === 'object' && typeof p.brick === 'string'
      ? { brick: p.brick, from: Number(p.from ?? 0), to: Number(p.to ?? 1), s: Number(p.s ?? 0), facing: p.facing === 'from' ? 'from' : 'to' }
      : null;
  return {
    ...r,
    id: String(r.id),
    name: typeof r.name === 'string' ? r.name : '',
    trackKind: typeof r.trackKind === 'string' ? r.trackKind : 'rail',
    units: Array.isArray(r.units)
      ? r.units
          .filter((u): u is { stock: string; reversed?: unknown } => !!u && typeof (u as { stock?: unknown }).stock === 'string')
          .map((u) => ({ stock: u.stock, reversed: !!u.reversed }))
      : [],
    position,
    color: typeof r.color === 'string' ? r.color : STOCK_COLORS[0]!,
    speed: typeof r.speed === 'number' ? r.speed : 40,
  };
}

/** The layout's rolling stock, by number then name; `version` changes when the doc does. */
export function useStock(doc: Y.Doc | null, version: unknown): RollingStock[] {
  return useMemo(
    () => (doc ? readRecordsFromDoc(doc, ROLLING_STOCK_KEY).map((r) => asStock(r)).sort(byNumber) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, version],
  );
}

/** The layout's trains, by name. */
export function useTrains(doc: Y.Doc | null, version: unknown): Train[] {
  return useMemo(
    () => (doc ? readRecordsFromDoc(doc, TRAINS_KEY).map((r) => asTrain(r)).sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, version],
  );
}

function byNumber(a: RollingStock, b: RollingStock): number {
  return a.number.localeCompare(b.number, undefined, { numeric: true }) || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1);
}

/** The name a car goes by in lists: "4021 Boxcar", or its kind when it has neither. */
export function stockLabel(s: RollingStock): string {
  return [s.number, s.name].filter(Boolean).join(' ') || KIND_LABELS[s.kind];
}

/** Where each train on the track sits now (rebuilt with the track and the switches). */
export function usePlacedTrains(
  net: TrackNetwork | null,
  trains: readonly Train[],
  stock: ReadonlyMap<string, RollingStock>,
  states: Readonly<Record<string, number>>,
): Map<string, PlacedTrain | null> {
  return useMemo(() => {
    const out = new Map<string, PlacedTrain | null>();
    if (!net) return out;
    for (const t of trains) if (t.position) out.set(t.id, placeTrain(net, t, stock, states));
    return out;
  }, [net, trains, stock, states]);
}

/** A train's state in plain terms: not on the map, on it, partly off the end, or its track is gone. */
export type TrainState = 'off' | 'ok' | 'offEnd' | 'lost';
export function trainState(t: Train, placed: PlacedTrain | null | undefined): TrainState {
  if (!t.position) return 'off';
  if (!placed) return 'lost';
  return placed.offTrack ? 'offEnd' : 'ok';
}

/** A new simple car of `length` studs (trains design 2.3: "quick cars"). */
export function newStock(fields: Partial<RollingStock>, taken: readonly RollingStock[]): RollingStock {
  const used = new Set(taken.map((s) => s.look.color));
  const color = STOCK_COLORS.find((c) => !used.has(c)) ?? STOCK_COLORS[taken.length % STOCK_COLORS.length]!;
  const base = simpleStock(makeId(), { length: fields.length ?? 32 });
  return { ...base, ...fields, look: { ...base.look, color, ...(fields.look ?? {}) }, id: base.id };
}

/** Change a car's length, keeping its trucks the same share in from each end (simple mode). */
export function withLength(s: RollingStock, length: number): RollingStock {
  const k = length / s.length;
  return { ...s, length, bodyLength: Math.max(1, length - 2), trucks: s.trucks.map((t) => ({ ...t, at: Math.round(t.at * k * 100) / 100 })) };
}

/** A new train of these units, not on the map yet. */
export function newTrain(name: string, units: Train['units'], taken: readonly Train[]): Train {
  const used = new Set(taken.map((t) => t.color));
  const color = STOCK_COLORS.find((c) => !used.has(c)) ?? STOCK_COLORS[taken.length % STOCK_COLORS.length]!;
  return { id: makeId(), name, trackKind: 'rail', units, position: null, color, speed: 40 };
}

const plain = <T extends object>(v: T) => JSON.parse(JSON.stringify(v)) as Record<string, unknown> & { id: string };

/** Save a car (new, or changed fields of one): one undo step. */
export function saveStock(doc: Y.Doc, s: RollingStock): void {
  doc.transact(() => writeRecord(doc, ROLLING_STOCK_KEY, plain(s)), LOCAL_ORIGIN);
}

/** Delete a car, and take it out of every train it's in: one undo step. */
export function removeStock(doc: Y.Doc, id: string, trains: readonly Train[]): void {
  doc.transact(() => {
    deleteRecord(doc, ROLLING_STOCK_KEY, id);
    for (const t of trains) {
      if (!t.units.some((u) => u.stock === id)) continue;
      const units = t.units.filter((u) => u.stock !== id);
      writeRecord(doc, TRAINS_KEY, plain({ ...t, units, position: units.length ? t.position : null }));
    }
  }, LOCAL_ORIGIN);
}

/** Save a train (new, or changed fields of one): one undo step. */
export function saveTrain(doc: Y.Doc, t: Train): void {
  doc.transact(() => writeRecord(doc, TRAINS_KEY, plain(t)), LOCAL_ORIGIN);
}

/** Delete a train (its cars stay): one undo step. */
export function removeTrain(doc: Y.Doc, id: string): void {
  doc.transact(() => deleteRecord(doc, TRAINS_KEY, id), LOCAL_ORIGIN);
}

/** The trains a car is in. */
export function trainsWith(stockId: string, trains: readonly Train[]): Train[] {
  return trains.filter((t) => t.units.some((u) => u.stock === stockId));
}

// ---- rosters -------------------------------------------------------------

/** What goes to a roster: the record without the layout's own id. */
export function forRoster(s: RollingStock): Record<string, unknown> {
  const { id: _id, ...rest } = plain(s);
  return rest;
}

/** A roster entry copied into the layout (a new id; linked back by libraryId). */
export function fromRoster(record: Record<string, unknown>): RollingStock {
  return asStock({ ...record, id: makeId() });
}

/** The layout's copy of a roster entry, if it has one. */
export function copyOf(libraryId: string, stock: readonly RollingStock[]): RollingStock | undefined {
  return stock.find((s) => s.libraryId === libraryId);
}

/** Whether the roster has a newer version of this car than the layout's copy. */
export function rosterIsNewer(s: RollingStock, entry: { id: string; version: number } | undefined): boolean {
  return !!entry && s.libraryId === entry.id && (s.libraryVersion ?? 0) < entry.version;
}

/** The layout's copy brought up to the roster's version (its id kept, so trains keep it). */
export function updatedFromRoster(s: RollingStock, record: Record<string, unknown>): RollingStock {
  return asStock({ ...record, id: s.id });
}

export { trainLength };

// ---- model import (trains design 3.3, Phase 6) ---------------------------

/** Today as the record keeps it (YYYY-MM-DD). */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * An engine or car made from an imported model: the model's custom part is
 * its picture (look mode "model"), its trucks and couplers as confirmed.
 * The desktop's stockFromModel (src/ui/TrainDialogs.cpp) makes the same.
 */
export function stockFromModel(
  made: { partKey: string; number: string; kind: RollingStock['kind']; setup: { length: number; width: number; bodyLength: number; trucks: [number, number] }; file: string; format: string },
  taken: readonly RollingStock[],
  date = today(),
): RollingStock {
  const [front, rear] = [...made.setup.trucks].sort((a, b) => b - a) as [number, number];
  const monorail = made.kind === 'monorail';
  return newStock(
    {
      number: made.number,
      kind: made.kind,
      trackKind: monorail ? 'monorail' : 'rail',
      powered: made.kind === 'engine' || made.kind === 'unit',
      length: made.setup.length,
      width: made.setup.width,
      bodyLength: made.setup.bodyLength,
      trucks: [
        { at: front, swivelMax: 30 },
        { at: rear, swivelMax: 30 },
      ],
      // (newStock picks its color: the outline, and the box if the picture is missing.)
      look: { mode: 'model', partKey: made.partKey } as RollingStock['look'],
      model: { partKey: made.partKey, file: made.file, format: made.format, importedAt: date },
    },
    taken,
  );
}
