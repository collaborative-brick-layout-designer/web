// Places (Live Ops design 2.1): named spots on the track where cars go: an
// industry, a yard, staging or an interchange. A place has spots, each a
// piece of track with room for some cars.
//
//   { id, name, kind: 'industry' | 'yard' | 'staging' | 'interchange',
//     spots: [{ id, name, track?: { brick, from, to }, capacity?, role? }],
//     accepts: [car types], ships: [car types], tags: [], notes: '',
//     source? }
//
// A module's places are in its sidecar value (`modules[].places`) and go
// wherever the module goes; places on loose track are the layout's own
// (`layoutPlaces`; live, the doc's `meta.places`). A Module library module
// keeps its places in its own contents, as that document's layout places.
// `source` is a placed module's place's id in the Module library, so an
// update of the module finds it again. Never in a .bbm.
//
// The desktop's core/Places.cpp is the twin; both tests use
// fixtures/contracts/places.json.

export const PLACE_KINDS = ['industry', 'yard', 'staging', 'interchange'] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];
/** What a yard's track is for. */
export const YARD_ROLES = ['arrival', 'departure', 'class', 'rip', 'engine'] as const;
export type YardRole = (typeof YARD_ROLES)[number];
/** Car types offered as you type; any other text is fine too. */
export const CAR_TYPES = ['boxcar', 'hopper', 'tank', 'flat', 'gondola', 'reefer', 'autorack', 'passenger', 'caboose'] as const;

/** What the apps and the server hold a place to (lengths in UTF-16 units). */
export const PLACE_LIMITS = {
  /** Places a module may have, and places a layout may have of its own. */
  places: 200,
  spots: 50,
  id: 64,
  brick: 128,
  conn: 255,
  name: 80,
  kind: 40,
  /** A car type or tag, and how many of each. */
  word: 40,
  words: 20,
  notes: 2000,
  capacity: 999,
  /** `placeSize` of one whole place. */
  size: 65536,
} as const;

const L = PLACE_LIMITS;

/** A way through a part: from one of its connections to another. */
export interface SpotTrack {
  brick: string;
  from: number;
  to: number;
}

export interface PlaceSpot {
  id: string;
  name: string;
  /** The piece of track it is on; absent: none picked yet (or staging off the map). */
  track?: SpotTrack;
  /** Cars it holds; absent: worked out from the track it is on. */
  capacity?: number;
  /** A yard track's use (YARD_ROLES). */
  role?: string;
  [extra: string]: unknown;
}

export interface Place {
  id: string;
  name: string;
  /** One of PLACE_KINDS (a newer build may write others). */
  kind: string;
  spots: PlaceSpot[];
  accepts: string[];
  ships: string[];
  tags: string[];
  notes: string;
  /** A placed module's place: its id in the Module library. */
  source?: string;
  [extra: string]: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f]/;
// eslint-disable-next-line no-control-regex
const NOTE_CONTROL = /[\u0000-\u0009\u000b-\u001f]/;

/** `v` without control characters, at most `max` long (never half a character); notes keep their new lines. */
function clip(v: string, max: number, notes = false): string {
  // eslint-disable-next-line no-control-regex
  const clean = v.replace(notes ? /[\u0000-\u0009\u000b-\u001f]/g : /[\u0000-\u001f]/g, '');
  if (clean.length <= max) return clean;
  const code = clean.charCodeAt(max - 1);
  return clean.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** How big a value is: the same count in both apps, whatever order its keys are in. */
export function placeSize(v: unknown): number {
  if (typeof v === 'string') return v.length + 2;
  if (Array.isArray(v)) return v.reduce<number>((n, x) => n + placeSize(x) + 1, 2);
  if (isObj(v)) return Object.entries(v).reduce((n, [k, x]) => n + k.length + 3 + placeSize(x), 2);
  return 8;
}

const goodId = (v: unknown, max: number): v is string => typeof v === 'string' && v !== '' && v.length <= max && !CONTROL.test(v);
const goodText = (v: unknown, max: number): boolean => typeof v === 'string' && v.length <= max && !CONTROL.test(v);
const wholeIn = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

function goodTrack(v: unknown): v is SpotTrack {
  return isObj(v) && goodId(v.brick, L.brick) && wholeIn(v.from, 0, L.conn) && wholeIn(v.to, 0, L.conn) && v.from !== v.to;
}

const goodWords = (v: unknown): boolean => Array.isArray(v) && v.length <= L.words && v.every((x) => goodText(x, L.word) && x !== '');

/**
 * Whether `v` is a place as the apps write one, within the limits (what the
 * server takes). Fields this build doesn't know are fine, within `size`.
 */
export function validPlace(v: unknown): v is Place {
  if (!isObj(v)) return false;
  if (!goodId(v.id, L.id) || !goodText(v.name, L.name) || !goodText(v.kind, L.kind)) return false;
  if (!goodWords(v.accepts) || !goodWords(v.ships) || !goodWords(v.tags)) return false;
  if (typeof v.notes !== 'string' || v.notes.length > L.notes || NOTE_CONTROL.test(v.notes)) return false;
  if (v.source !== undefined && !goodId(v.source, L.id)) return false;
  if (!Array.isArray(v.spots) || v.spots.length > L.spots) return false;
  for (const s of v.spots as unknown[]) {
    if (!isObj(s) || !goodId(s.id, L.id) || !goodText(s.name, L.name)) return false;
    if (s.track !== undefined && !goodTrack(s.track)) return false;
    if (s.capacity !== undefined && !wholeIn(s.capacity, 1, L.capacity)) return false;
    if (s.role !== undefined && !goodText(s.role, L.kind)) return false;
  }
  return placeSize(v) <= L.size;
}

/** Whether `v` is a module's list of places the server takes. */
export function validPlaces(v: unknown): v is Place[] {
  return Array.isArray(v) && v.length <= L.places && v.every(validPlace) && new Set(v.map((p) => (p as Place).id)).size === v.length;
}

function readWords(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => (typeof x === 'string' ? [clip(x, L.word)] : [])).filter((x) => x !== '').slice(0, L.words);
}

function readSpot(v: unknown): PlaceSpot | null {
  if (!isObj(v) || !goodId(v.id, L.id)) return null;
  const out: PlaceSpot = { ...v, id: v.id, name: typeof v.name === 'string' ? clip(v.name, L.name) : '' };
  if (goodTrack(v.track)) out.track = { brick: v.track.brick, from: v.track.from, to: v.track.to };
  else delete out.track;
  if (!wholeIn(v.capacity, 1, L.capacity)) delete out.capacity;
  if (typeof v.role === 'string' && clip(v.role, L.kind) !== '') out.role = clip(v.role, L.kind);
  else delete out.role;
  return out;
}

/** A place as stored, put within the limits; null when it isn't one (no id). Fields this build doesn't know are kept. */
export function readPlace(v: unknown): Place | null {
  if (!isObj(v) || !goodId(v.id, L.id)) return null;
  const spots: PlaceSpot[] = [];
  for (const s of Array.isArray(v.spots) ? (v.spots as unknown[]) : []) {
    const spot = readSpot(s);
    if (spot && spots.length < L.spots && !spots.some((x) => x.id === spot.id)) spots.push(spot);
  }
  const known: Place = {
    id: v.id,
    name: typeof v.name === 'string' ? clip(v.name, L.name) : '',
    kind: typeof v.kind === 'string' && clip(v.kind, L.kind) !== '' ? clip(v.kind, L.kind) : 'industry',
    spots,
    accepts: readWords(v.accepts),
    ships: readWords(v.ships),
    tags: readWords(v.tags),
    notes: typeof v.notes === 'string' ? clip(v.notes, L.notes, true) : '',
  };
  const { source: _source, ...rest } = v;
  if (goodId(v.source, L.id)) known.source = v.source;
  const out: Place = { ...rest, ...known };
  if (placeSize(out) <= L.size) return out;
  // Too big: without what this build doesn't know.
  return { ...known, spots: spots.map((s) => ({ id: s.id, name: s.name, ...(s.track ? { track: s.track } : {}), ...(s.capacity !== undefined ? { capacity: s.capacity } : {}), ...(s.role !== undefined ? { role: s.role } : {}) })) };
}

/** A list of places as stored (a module's `places`, a sidecar's `layoutPlaces`): the readable ones, each id once, within the limits. */
export function readPlaces(v: unknown): Place[] {
  if (!Array.isArray(v)) return [];
  const out: Place[] = [];
  const seen = new Set<string>();
  for (const x of v as unknown[]) {
    const p = readPlace(x);
    if (!p || seen.has(p.id) || out.length >= L.places) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/** A placed module's places ([] when it has none). */
export function modulePlaces(m: object): Place[] {
  return readPlaces((m as { places?: unknown }).places);
}

/** `m` with these places (none: without the field). */
export function withPlaces<M extends object>(m: M, places: readonly Place[]): M {
  const { places: _was, ...rest } = m as M & { places?: unknown };
  return (places.length > 0 ? { ...rest, places } : rest) as M;
}

/**
 * The places with their spots' parts renamed. `rename` gives a part's new
 * id, or null for one that isn't there: its spot stays, without its track.
 */
export function renamePlaceBricks(places: readonly Place[], rename: (id: string) => string | null): Place[] {
  return places.map((p) => ({
    ...p,
    spots: p.spots.map((s) => {
      if (!s.track) return s;
      const to = rename(s.track.brick);
      if (to !== null) return { ...s, track: { ...s.track, brick: to } };
      const { track: _gone, ...rest } = s;
      return rest;
    }),
  }));
}

/**
 * A copy of a module's places for another placed copy of it (from the
 * Module library, duplicated or pasted): new ids, remembering which place
 * of the Module library (or of the module copied) each is.
 */
export function copyPlaces(places: readonly Place[], rename: (id: string) => string | null, newId: () => string): Place[] {
  return renamePlaceBricks(places, rename).map((p) => ({ ...p, id: newId(), source: p.source ?? p.id }));
}

/**
 * A placed module's places when a library version's (`next`, its spots
 * already naming the layout's parts) take their place: each keeps the id
 * it has here, found by the library place it came from; new ones get one.
 */
export function updatedPlaces(current: readonly Place[], next: readonly Place[], newId: () => string): Place[] {
  const bySource = new Map(current.map((p) => [p.source ?? p.id, p.id]));
  const used = new Set<string>();
  return next.map((p) => {
    const key = p.source ?? p.id;
    const had = bySource.get(key);
    const id = had !== undefined && !used.has(had) ? had : newId();
    used.add(id);
    return { ...p, id, source: key };
  });
}

/**
 * A placed module's places as its Module library copy keeps them: under
 * the ids the library knows them by, spots only on the module's own parts.
 */
export function libraryPlaces(places: readonly Place[], members: ReadonlySet<string>): Place[] {
  const out: Place[] = [];
  const seen = new Set<string>();
  for (const p of renamePlaceBricks(places, (id) => (members.has(id) ? id : null))) {
    const { source, ...rest } = p;
    const id = source ?? p.id;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...rest, id } as Place);
  }
  return out;
}

/** The parts a place's spots are on. */
export function placeBricks(p: Place): string[] {
  return p.spots.flatMap((s) => (s.track ? [s.track.brick] : []));
}

/**
 * Making a module of parts: the layout's places that are all on those parts
 * become the module's own (so they go where it goes); the others stay.
 */
export function adoptPlaces(layoutPlaces: readonly Place[], members: ReadonlySet<string>): { module: Place[]; layout: Place[] } {
  const module: Place[] = [];
  const layout: Place[] = [];
  for (const p of layoutPlaces) {
    const bricks = placeBricks(p);
    if (bricks.length > 0 && bricks.every((b) => members.has(b)) && module.length < L.places) module.push(p);
    else layout.push(p);
  }
  return { module, layout };
}

/**
 * A module taken apart (its parts stay): its places become the layout's.
 * Those past the layout's limit go; a place whose id the layout has gets a new one.
 */
export function releasePlaces(layoutPlaces: readonly Place[], places: readonly Place[], newId: () => string): Place[] {
  const out = [...layoutPlaces];
  for (const p of places) {
    if (out.length >= L.places) break;
    const { source: _source, ...rest } = p;
    out.push({ ...rest, id: out.some((x) => x.id === p.id) ? newId() : p.id } as Place);
  }
  return out;
}

/** How many places there are of each kind (kinds in PLACE_KINDS order, then others by name). */
export function placeCounts(places: readonly Pick<Place, 'kind'>[]): { kind: string; count: number }[] {
  const n = new Map<string, number>();
  for (const p of places) n.set(p.kind, (n.get(p.kind) ?? 0) + 1);
  const known = PLACE_KINDS.filter((k) => n.has(k)) as string[];
  const others = [...n.keys()].filter((k) => !known.includes(k)).sort((a, b) => (a < b ? -1 : 1));
  return [...known, ...others].map((kind) => ({ kind, count: n.get(kind)! }));
}

/** Two car types are the same ignoring case and spaces at either end. */
export function sameCarType(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The car length capacities are worked out with when a spot doesn't say, studs. */
export const TYPICAL_CAR = 32;

/** How many cars a spot holds: what it says, else what fits in the track it is on (`usable` studs); null when that isn't known. */
export function spotCapacity(spot: Pick<PlaceSpot, 'capacity'>, usable: number | null): number | null {
  if (spot.capacity !== undefined) return spot.capacity;
  return usable === null ? null : Math.max(0, Math.floor(usable / TYPICAL_CAR + 1e-6));
}
