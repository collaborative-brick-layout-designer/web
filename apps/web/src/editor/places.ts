// Places in the editor (Live Ops design 2.1, 6): every place of the layout,
// its own and its modules', where each spot is on the track as it is now
// and how many cars it holds; the edits (each one undo step, a shared
// module's refused: sharedLock.ts); and what places are called. The
// desktop's ui/PlacesPanel.cpp and ui/PlacesText.cpp say the same.

import { useMemo } from 'react';
import type * as Y from 'yjs';
import { modulePlaces, placeCounts, PLACE_LIMITS, spotCapacity, TYPICAL_CAR, withPlaces, type Place, type PlaceSpot, type SidecarModule } from '@cld/bbm';
import { deleteRecord, makeId, PLACES_KEY, readPlacesFromDoc, readSidecarFromDoc, writePlace } from '@cld/ydoc';
import { sharedPlaced } from '@cld/modules';
import { spotOnTrack, type SpotOnTrack, type TrackNetwork, type TrackPosition, type TrackRun } from '@cld/parts-catalog/browser';
import { LOCAL_ORIGIN } from './useLayoutDoc';
import { updateSidecarModule } from './mutations';

/** Where a place is kept: a module's id, or null for the layout's own. */
export type PlaceOwner = string | null;

export interface PlaceGroup {
  owner: PlaceOwner;
  /** The module's name ('' for the layout's own). */
  name: string;
  /** A shared module's: its owner's, so they can't be changed here. */
  locked: boolean;
  places: Place[];
}

/** The layout's own places first, then each module's (modules without any are there too). */
export function placeGroups(doc: Y.Doc): PlaceGroup[] {
  const modules = readSidecarFromDoc(doc)?.modules ?? [];
  return [
    { owner: null, name: '', locked: false, places: readPlacesFromDoc(doc) },
    ...modules.map((m) => ({ owner: m.id, name: m.name || 'Module', locked: !!sharedPlaced(m as SidecarModule & { shared?: unknown }), places: modulePlaces(m) })),
  ];
}

/** `version` changes when the doc does (the projected map). */
export function usePlaceGroups(doc: Y.Doc | null, version: unknown): PlaceGroup[] {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (doc ? placeGroups(doc) : []), [doc, version]);
}

export interface SpotNow {
  owner: PlaceOwner;
  place: Place;
  spot: PlaceSpot;
  /** Where it is, or null when its track isn't on the map (or none is picked). */
  at: SpotOnTrack | null;
  /** Cars it holds; null when that can't be told. */
  capacity: number | null;
}

/** Where a spot is now. */
export function spotNow(net: TrackNetwork | null, runs: readonly TrackRun[], owner: PlaceOwner, place: Place, spot: PlaceSpot): SpotNow {
  const wanted = spot.capacity !== undefined ? spot.capacity * TYPICAL_CAR : null;
  const at = net && spot.track ? spotOnTrack(net, runs, spot.track, wanted) : null;
  return { owner, place, spot, at, capacity: spotCapacity(spot, at?.usable ?? null) };
}

export const spotKey = (owner: PlaceOwner, place: string, spot: string) => `${owner ?? ''}/${place}/${spot}`;

/** Every spot of every place, by spotKey. */
export function useSpots(net: TrackNetwork | null, runs: readonly TrackRun[], groups: readonly PlaceGroup[]): Map<string, SpotNow> {
  return useMemo(() => {
    const out = new Map<string, SpotNow>();
    for (const g of groups) for (const p of g.places) for (const s of p.spots) out.set(spotKey(g.owner, p.id, s.id), spotNow(net, runs, g.owner, p, s));
    return out;
  }, [net, runs, groups]);
}

// ---- Edits ------------------------------------------------------------------

/** Save a place (new, or changed): one undo step. A shared module's says why not. */
export function savePlace(doc: Y.Doc, owner: PlaceOwner, place: Place): void {
  if (owner === null) {
    doc.transact(() => writePlace(doc, place), LOCAL_ORIGIN);
    return;
  }
  updateSidecarModule(doc, owner, (m) => {
    const had = modulePlaces(m);
    return withPlaces(m, had.some((p) => p.id === place.id) ? had.map((p) => (p.id === place.id ? place : p)) : [...had, place]);
  });
}

/** Delete a place: one undo step. */
export function removePlace(doc: Y.Doc, owner: PlaceOwner, id: string): void {
  if (owner === null) doc.transact(() => deleteRecord(doc, PLACES_KEY, id), LOCAL_ORIGIN);
  else updateSidecarModule(doc, owner, (m) => withPlaces(m, modulePlaces(m).filter((p) => p.id !== id)));
}

const wayOf = (pos: TrackPosition) => ({ brick: pos.brick, from: pos.from, to: pos.to });

/** A new place, with a spot on the track picked (none: off the layout, staging). */
export function newPlace(groups: readonly PlaceGroup[], pos: TrackPosition | null): Place {
  const names = new Set(groups.flatMap((g) => g.places.map((p) => p.name)));
  let n = 1;
  while (names.has(`Place ${n}`)) n++;
  return {
    id: makeId(),
    name: `Place ${n}`,
    kind: pos ? 'industry' : 'staging',
    spots: pos ? [{ id: makeId(), name: 'Spot 1', track: wayOf(pos) }] : [],
    accepts: [],
    ships: [],
    tags: [],
    notes: '',
  };
}

/** `place` with a spot put on the track: `spot`'s (a new one when null). */
export function withSpotOn(place: Place, spot: string | null, pos: TrackPosition): Place {
  if (spot !== null && place.spots.some((s) => s.id === spot)) {
    return { ...place, spots: place.spots.map((s) => (s.id === spot ? { ...s, track: wayOf(pos) } : s)) };
  }
  if (place.spots.length >= PLACE_LIMITS.spots) return place;
  let n = place.spots.length + 1;
  while (place.spots.some((s) => s.name === `Spot ${n}`)) n++;
  return { ...place, spots: [...place.spots, { id: makeId(), name: `Spot ${n}`, track: wayOf(pos) }] };
}

/** The module a part is in (its group), or null for loose track. */
export function groupOfPart(doc: Y.Doc, groups: readonly PlaceGroup[], brick: string): PlaceGroup | null {
  const m = readSidecarFromDoc(doc)?.modules?.find((x) => x.members.includes(brick));
  return m ? (groups.find((g) => g.owner === m.id) ?? null) : null;
}

// ---- Words --------------------------------------------------------------------

export const KIND_LABEL: Record<string, string> = { industry: 'Industry', yard: 'Yard', staging: 'Staging', interchange: 'Interchange' };
export const KIND_HINT: Record<string, string> = {
  industry: 'Somewhere cars are loaded or unloaded.',
  yard: 'Where cars are sorted into trains.',
  staging: 'Off the layout: where trains come from and go to.',
  interchange: 'Where cars change to another railroad, the rest of the world.',
};
export const ROLE_LABEL: Record<string, string> = { arrival: 'Arrival', departure: 'Departure', class: 'Sorting', rip: 'Repair', engine: 'Engines' };
/** The color a kind of place has on the map. */
export const KIND_COLOR: Record<string, string> = { industry: '#0F766E', yard: '#7C3AED', staging: '#B45309', interchange: '#1D4ED8' };
export const kindLabel = (kind: string): string => KIND_LABEL[kind] ?? kind;
export const kindColor = (kind: string): string => KIND_COLOR[kind] ?? '#475569';

const PLURAL: Record<string, [string, string]> = { industry: ['industry', 'industries'], yard: ['yard', 'yards'], staging: ['staging', 'staging'], interchange: ['interchange', 'interchanges'] };

/** "2 industries, 1 yard". */
export function countsText(counts: readonly { kind: string; count: number }[]): string {
  return counts.map(({ kind, count }) => `${count} ${PLURAL[kind]?.[count === 1 ? 0 : 1] ?? kind}`).join(', ');
}

export const placesText = (places: readonly Place[]): string => countsText(placeCounts(places));

/** "3 cars", "Too short for a car", or null when it can't be told. */
export function capacityText(capacity: number | null): string | null {
  if (capacity === null) return null;
  return capacity === 0 ? 'Too short for a car' : capacity === 1 ? '1 car' : `${capacity} cars`;
}

/** What is wrong with a spot's track, or null. */
export function spotProblem(now: SpotNow): string | null {
  if (!now.spot.track) return 'No track picked yet.';
  if (!now.at) return 'Its track was moved or removed. Pick it again.';
  return null;
}

/** Ask for a module's places (its ⋯ menu › Places…), or a place, in the Places panel. */
export function openPlaces(detail: { module?: string | null; place?: { owner: PlaceOwner; id: string } | null; fresh?: boolean } = {}): void {
  window.dispatchEvent(new CustomEvent('cld:open-places', { detail }));
}
