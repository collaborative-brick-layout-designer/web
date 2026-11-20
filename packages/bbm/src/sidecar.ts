// `.bbm.cld` sidecar reader/writer.
//
// The sidecar is a single JSON document holding fork-only metadata that
// vanilla BlueBrick doesn't understand: anchored labels, modules, venue.
// Per the desktop's `docs/bbm-cld-schema.md`:
//   - schemaVersion: integer (currently 1)
//   - bbmHashSha256: lowercase hex of the sibling .bbm bytes (sync detection)
//   - anchoredLabels / modules / venue: optional arrays / object
//
// Forward-compat rule (the same in both apps, docs/bbm-bld-schema.md): a
// file with `schemaVersion > CURRENT_SCHEMA_VERSION` opens, with a warning
// (`sidecarWarnings`), and its version is written back, so saving never
// quietly downgrades it. Writers preserve unknown fields they read
// (round-trip safety) by holding them in `extras`.

// Note: `hashBbmBytes` lives in ./sidecarHash.ts so this module has zero
// runtime dependencies on `node:crypto` — that lets the browser bundle
// import the readers/writers and the type definitions without a Node-only
// shim. The hash helper imports `node:crypto` lazily; it's server-side only.

export const CURRENT_SCHEMA_VERSION = 1;

/** What a sidecar saved by a newer version says when it opens (the desktop's words). */
export const NEWER_SIDECAR_WARNING =
  "The labels, modules and venue were saved by a newer version of the app. Anything this version doesn't know is kept as it is, but isn't shown.";

/**
 * What to tell the person opening a sidecar: a newer version's file opens,
 * and keeps what this one doesn't know, but some of it isn't shown.
 */
export function sidecarWarnings(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const v = parsed?.schemaVersion;
    return typeof v === 'number' && Number.isFinite(v) && v > CURRENT_SCHEMA_VERSION ? [NEWER_SIDECAR_WARNING] : [];
  } catch {
    return [];
  }
}

export type EdgeKind = 0 | 1 | 2; // 0=Wall, 1=Door, 2=Open

export type AnchoredLabelKind = 0 | 1 | 2 | 3; // 0=World, 1=Brick, 2=Group, 3=Module

export interface AnchoredLabel {
  id: string;
  text: string;
  font: { family: string; size: number; style: string };
  color: { known: boolean; argb: number; name: string };
  kind: AnchoredLabelKind;
  /** Brick / group / module GUID; empty for World. */
  targetId: string;
  offset: { x: number; y: number };
  rot: number;
  minZoom: number;
}

export interface SidecarModule {
  id: string;
  name: string;
  members: string[];
  /** 3x3 row-major affine transform; identity = [1,0,0,0,1,0,0,0,1]. */
  transform: number[];
  sourceFile?: string;
  /** ISO 8601 timestamp string. */
  importedAt?: string;
  // How this placed module looks and behaves. Each is written only when it
  // differs from the default, so a sidecar without them reads as before.
  /** Its name shows on the map (absent: true). The layout-wide View ▸ Module names still applies. */
  showName?: boolean;
  /** Its outline color, `#rrggbb` (absent: the default light blue). */
  outlineColor?: string;
  /** Its name color, `#rrggbb` (absent: the default light blue). */
  nameColor?: string;
  /** "Same color": the outline and name colors change together (absent: true). */
  sameColor?: boolean;
  /** Pinned in place: it can't be moved as a whole (Edit module still works). Absent: false. */
  pinned?: boolean;
  /**
   * The library module this placed module is linked to (its id on the
   * server), set when it is saved to the library or inserted from it.
   * Absent: not linked. BlueBrick never sees it (sidecar only).
   */
  libraryModuleId?: string;
  /** The library version this placed module matches (absent: unknown). */
  libraryVersion?: number;
  /** Fields a newer build added; kept as they are. */
  [extra: string]: unknown;
}

// Venue model (references/VENUE-MODEL.md). Everything is in studs, x to
// the east and y to the south. The optional fields came later and are
// written only when set; unknown fields are kept when a venue is read and
// written again, so an older build doesn't lose what a newer one added.

export interface VenueEdge {
  kind: EdgeKind;
  doorWidthStuds: number;
  label: string;
  poly: { x: number; y: number }[];
  /** Not measured yet (traced from a map, guessed). */
  estimated?: boolean;
  [extra: string]: unknown;
}

export type VenueObstacleKind = 'column' | 'stairs' | 'elevator' | 'counter' | 'railing';

export interface VenueObstacle {
  label: string;
  poly: { x: number; y: number }[];
  /** What it is; absent for anything else. */
  kind?: VenueObstacleKind;
  /** Stairs: the way up, degrees clockwise from east (270 = north). */
  upDegrees?: number;
  [extra: string]: unknown;
}

export interface VenuePower {
  x: number;
  y: number;
  kind: 'wall' | 'floor';
  label?: string;
  amps?: number;
  volts?: number;
  [extra: string]: unknown;
}

export interface VenueNote {
  x: number;
  y: number;
  text: string;
  estimated?: boolean;
  [extra: string]: unknown;
}

export interface VenueDimension {
  from: { x: number; y: number };
  to: { x: number; y: number };
  label?: string;
  estimated?: boolean;
  [extra: string]: unknown;
}

/** The unit a venue's lengths are shown in: feet and inches, meters or studs. */
export type VenueLengthUnit = 'ftin' | 'm' | 'studs';

/** The unit `venue` names for its own lengths (the Venue Designer's Units pick), or null when it names none (or one we don't know). */
export function venueOwnLengthUnit(venue: object | null | undefined): VenueLengthUnit | null {
  const u = (venue as { lengthUnit?: unknown } | null | undefined)?.lengthUnit;
  return u === 'ftin' || u === 'm' || u === 'studs' ? u : null;
}

/**
 * The unit `venue`'s lengths are shown in: its own, or `fallback` (the
 * account's length unit; feet and inches when not given) when it names none.
 */
export function venueLengthUnit(venue: object | null | undefined, fallback: VenueLengthUnit = 'ftin'): VenueLengthUnit {
  return venueOwnLengthUnit(venue) ?? fallback;
}

/**
 * `venue` showing its lengths in `unit`, picked in the Venue Designer, so it
 * is written even for feet and inches: a venue without one follows each
 * viewer's account unit.
 */
export function withVenueLengthUnit<V extends object>(venue: V, unit: VenueLengthUnit): V {
  if ((venue as { lengthUnit?: unknown }).lengthUnit === unit) return venue;
  return { ...venue, lengthUnit: unit } as V;
}

export interface Venue {
  name: string;
  enabled: boolean;
  minWalkwayStuds: number;
  bounds: { x: number; y: number; w: number; h: number };
  edges: VenueEdge[];
  obstacles: VenueObstacle[];
  /** Power outlets on the walls and in the floor. */
  power?: VenuePower[];
  notes?: VenueNote[];
  /** Measurements, drawn as dimension lines. */
  dimensions?: VenueDimension[];
  /**
   * The unit lengths are shown in (the Venue Designer's Units pick), so the
   * wall lengths read the same wherever the venue is drawn. Absent: the
   * viewer's account unit. Read it with `venueLengthUnit`.
   */
  lengthUnit?: VenueLengthUnit;
  [extra: string]: unknown;
}

export interface BackgroundImage {
  /**
   * Server-relative URL (e.g. `/api/layouts/<id>/background-image`).
   * Empty when the sidecar came from the desktop app, which stores a local
   * file `path` instead — the image itself isn't in the sidecar.
   */
  url: string;
  /**
   * Desktop's local image file path (SidecarIO.cpp `backgroundImage.path`).
   * Preserved so a desktop sidecar round-trips through the web without
   * losing it; the web can't load it.
   */
  path?: string;
  /** Opacity 0..1. Desktop default 0.5. */
  opacity: number;
  /** Placement rect in studs. null/absent = stretch to scene bounds. */
  rect?: { x: number; y: number; w: number; h: number };
}

/**
 * A saved view (references/LAYOUT-FILE.md "Saved views"): a named picture
 * of the layout that can be shown again, shared or exported. Everything is
 * in studs. `fit: true` means "fit the whole layout": the area is worked
 * out at export time from the bounds of what's drawn on the view's visible
 * sheets, plus a small margin, and `rect` is then ignored (usually null).
 * `sheets: null` means every sheet. Unknown fields are kept.
 */
export interface SavedView {
  id: string;
  name: string;
  fit: boolean;
  rect: { x: number; y: number; w: number; h: number } | null;
  /** Layer ids shown in this view, or null for all of them. */
  sheets: string[] | null;
  grid: boolean;
  labels: boolean;
  [extra: string]: unknown;
}

/**
 * A custom set placed in the layout (a named group of the .bbm): which
 * version of it its parts came from, so the editor can say "Update
 * available" when the set changes. Vanilla BlueBrick never sees it. Both
 * apps write it (the desktop's core::PlacedSet).
 */
export interface PlacedSet {
  /** The set's outermost group in the .bbm. */
  id: string;
  /** The set's version (the server's `setVersion`) when it was placed or last updated. */
  version: string;
  /**
   * One of its parts, and where that part sits in the set (studs, degrees),
   * so the set's place and turn can be found however it was moved since.
   */
  anchor?: { brick: string; x: number; y: number; angle: number };
  [extra: string]: unknown;
}

export interface Sidecar {
  schemaVersion: number;
  /** Lowercase hex of the .bbm bytes at write time, or empty when unknown. */
  bbmHashSha256: string;
  anchoredLabels?: AnchoredLabel[];
  modules?: SidecarModule[];
  venue?: Venue;
  backgroundImage?: BackgroundImage;
  /** Saved views, in list order. */
  views?: SavedView[];
  /** Custom sets placed in the layout, with the version each came from. */
  sets?: PlacedSet[];
  /**
   * The layout's budget: how many of each part (by part number) it may
   * use. Present, even empty, when the layout has a budget; absent when it
   * has none. Shared with everyone editing the layout (the live doc keeps
   * it in `meta.budgetLimits`); the desktop's `.bbb` files import and
   * export it.
   */
  budgetLimits?: Record<string, number>;
  /**
   * How the layout's switches are set (trains design 2.2): "<brick id>/<heel
   * connection>" to the connection a train leaves by. A switch with no key
   * is set to its default, the way that turns least; absent when none is
   * set. The live doc keeps it in `meta.switchStates`. Never in a .bbm.
   */
  switchStates?: Record<string, number>;
  /**
   * Named routes (trains design 2.5): each `{ id, name, train, from, to,
   * via, steps, color }` with fields this version doesn't know kept. The
   * live doc keeps them in `meta.routes`, one Y.Map a route. Never in a .bbm.
   */
  routes?: SidecarRoute[];
  /**
   * Rolling stock (trains design 2.3): each engine or car a record `{ id,
   * number, name, kind, length, width, trucks, couplers, look, ... }`, kept
   * as written. The live doc keeps them in `meta.rollingStock`. Never in a .bbm.
   */
  rollingStock?: SidecarRecord[];
  /** Trains (consists, trains design 2.4): `{ id, name, units, position, color, ... }`. Live: `meta.trains`. */
  trains?: SidecarRecord[];
  /** Unknown top-level fields preserved verbatim across round-trip. */
  extras?: Record<string, unknown>;
}

/** The budget limits of a sidecar's `budgetLimits` field: a part number to a whole number of 0 or more. */
export function readBudgetLimitsField(v: unknown): Record<string, number> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [part, limit] of Object.entries(v as Record<string, unknown>)) {
    if (typeof limit === 'number' && Number.isFinite(limit) && limit >= 0) out[part] = Math.floor(limit);
  }
  return out;
}

/** A named route as the sidecar keeps it (@cld/parts-catalog track/routes.ts `Route` reads it). */
export interface SidecarRoute {
  id: string;
  name: string;
  [field: string]: unknown;
}

/** A record kept by id (rolling stock, trains), as written. */
export interface SidecarRecord {
  id: string;
  [field: string]: unknown;
}

/** A sidecar's list of records: the entries with a string id, as they are; undefined when none. */
export function readRecordsField(v: unknown): SidecarRecord[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((r): r is SidecarRecord => !!r && typeof r === 'object' && typeof (r as SidecarRecord).id === 'string' && (r as SidecarRecord).id !== '');
  return out.length > 0 ? out : undefined;
}

/** A sidecar's `routes`: the entries with a string id (and name), as they are; undefined when none. */
export function readRoutesField(v: unknown): SidecarRoute[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((r): r is SidecarRoute => !!r && typeof r === 'object' && typeof (r as SidecarRoute).id === 'string' && (r as SidecarRoute).id !== '')
    .map((r) => ({ ...r, name: typeof r.name === 'string' ? r.name : '' }));
  return out.length > 0 ? out : undefined;
}

/** A sidecar's `switchStates`: "<brick>/<heel>" to a connection index (a whole number, 0 or more); undefined when it has none. */
export function readSwitchStatesField(v: unknown): Record<string, number> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, exit] of Object.entries(v as Record<string, unknown>)) {
    if (typeof exit === 'number' && Number.isInteger(exit) && exit >= 0 && /^.+\/\d+$/.test(key)) out[key] = exit;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function readSidecar(raw: string): Sidecar {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  // Files the web wrote before 2026-10 could leave schemaVersion out (a
  // sidecar the editor started from nothing); they are version 1.
  // A newer version's file opens as it is (sidecarWarnings says so): the
  // fields this version knows are read, the rest are kept in `extras`.
  const schemaVersion = parsed.schemaVersion === undefined ? 1 : numberField(parsed, 'schemaVersion');

  const sidecar: Sidecar = {
    schemaVersion,
    bbmHashSha256: typeof parsed.bbmHashSha256 === 'string' ? parsed.bbmHashSha256 : '',
  };

  if (Array.isArray(parsed.anchoredLabels)) {
    sidecar.anchoredLabels = parsed.anchoredLabels as AnchoredLabel[];
  }
  if (Array.isArray(parsed.modules)) {
    sidecar.modules = parsed.modules as SidecarModule[];
  }
  if (parsed.venue && typeof parsed.venue === 'object') {
    sidecar.venue = parsed.venue as Venue;
  }
  const bg = readBackgroundImage(parsed.backgroundImage);
  if (bg) sidecar.backgroundImage = bg;
  if (Array.isArray(parsed.views)) {
    sidecar.views = parsed.views.map(readView).filter((v): v is SavedView => v !== null);
  }
  if (Array.isArray(parsed.sets)) {
    sidecar.sets = parsed.sets.filter(
      (v): v is PlacedSet => !!v && typeof v === 'object' && typeof (v as PlacedSet).id === 'string' && typeof (v as PlacedSet).version === 'string',
    );
  }
  const budget = readBudgetLimitsField(parsed.budgetLimits);
  if (budget) sidecar.budgetLimits = budget;
  const switches = readSwitchStatesField(parsed.switchStates);
  if (switches) sidecar.switchStates = switches;
  const routes = readRoutesField(parsed.routes);
  if (routes) sidecar.routes = routes;
  const rollingStock = readRecordsField(parsed.rollingStock);
  if (rollingStock) sidecar.rollingStock = rollingStock;
  const trains = readRecordsField(parsed.trains);
  if (trains) sidecar.trains = trains;

  const knownKeys = new Set([
    'schemaVersion',
    'bbmHashSha256',
    'anchoredLabels',
    'modules',
    'venue',
    'backgroundImage',
    'views',
    'sets',
    'budgetLimits',
    'switchStates',
    'routes',
    'rollingStock',
    'trains',
  ]);
  const extras: Record<string, unknown> = {};
  for (const key of Object.keys(parsed)) {
    if (!knownKeys.has(key)) extras[key] = parsed[key];
  }
  if (Object.keys(extras).length > 0) sidecar.extras = extras;

  return sidecar;
}

export interface WriteSidecarOptions {
  /**
   * If supplied, we use this string as `bbmHashSha256`, overriding whatever
   * was in the Sidecar object — that's the desired behaviour because the
   * hash MUST reflect the current .bbm content for sync detection to work.
   *
   * The caller computes the hash via `hashBbmBytes` (server-side, lives in
   * sidecarHash.ts) and passes the digest in. Keeping the hashing out of
   * this module means sidecar.ts has no `node:crypto` import, so the web
   * bundle can include it without a Node shim.
   */
  bbmHashSha256?: string;
  /** Indentation: defaults to 2 spaces. */
  indent?: number;
}

export function writeSidecar(sidecar: Sidecar, opts: WriteSidecarOptions = {}): string {
  const indent = opts.indent ?? 2;

  // A sidecar the web editor started from nothing (its first label, view
  // or venue) had no schemaVersion, and readSidecar refuses a file without
  // one: write the current version so the file opens again.
  const out: Record<string, unknown> = {
    // A newer version's file keeps its number: it is still that version's file.
    schemaVersion: Number.isFinite(sidecar.schemaVersion)
      ? Math.max(sidecar.schemaVersion, CURRENT_SCHEMA_VERSION)
      : CURRENT_SCHEMA_VERSION,
    bbmHashSha256: opts.bbmHashSha256 ?? sidecar.bbmHashSha256 ?? '',
  };
  if (sidecar.anchoredLabels) out.anchoredLabels = sidecar.anchoredLabels;
  if (sidecar.modules) out.modules = sidecar.modules;
  if (sidecar.venue) out.venue = sidecar.venue;
  if (sidecar.backgroundImage) out.backgroundImage = encodeBackgroundImage(sidecar.backgroundImage);
  if (sidecar.views) out.views = sidecar.views;
  if (sidecar.sets && sidecar.sets.length > 0) out.sets = sidecar.sets;
  if (sidecar.budgetLimits) out.budgetLimits = sidecar.budgetLimits;
  if (sidecar.switchStates && Object.keys(sidecar.switchStates).length > 0) out.switchStates = sidecar.switchStates;
  if (sidecar.routes && sidecar.routes.length > 0) out.routes = sidecar.routes;
  if (sidecar.rollingStock && sidecar.rollingStock.length > 0) out.rollingStock = sidecar.rollingStock;
  if (sidecar.trains && sidecar.trains.length > 0) out.trains = sidecar.trains;
  if (sidecar.extras) {
    for (const [k, v] of Object.entries(sidecar.extras)) out[k] = v;
  }

  return JSON.stringify(out, null, indent);
}

/**
 * Accepts both shapes:
 *   - web:     { url, opacity, rect?: { x, y, w, h } }
 *   - desktop: { path, opacity, rect?: [x, y, w, h] }   (SidecarIO.cpp readSidecar)
 * and normalises to the web `BackgroundImage` shape, keeping `path`.
 * Opacity defaults to 0.5 like desktop.
 */
function readBackgroundImage(raw: unknown): BackgroundImage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const url = typeof o.url === 'string' ? o.url : '';
  const path = typeof o.path === 'string' ? o.path : undefined;
  if (!url && !path) return undefined;
  const opacity = typeof o.opacity === 'number' && Number.isFinite(o.opacity) ? o.opacity : 0.5;
  const bg: BackgroundImage = { url, opacity };
  if (path !== undefined) bg.path = path;
  const rect = readRect(o.rect);
  if (rect) bg.rect = rect;
  return bg;
}

function readRect(raw: unknown): BackgroundImage['rect'] {
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  let x, y, w, h;
  if (Array.isArray(raw)) {
    if (raw.length !== 4) return undefined;
    [x, y, w, h] = raw.map(num);
  } else if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    [x, y, w, h] = [r.x, r.y, r.w, r.h].map(num);
  } else {
    return undefined;
  }
  if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined;
  return { x, y, w, h };
}

/**
 * Written so both apps can read it: desktop reads `path` + `rect` as a
 * 4-array and ignores `url`; `readSidecar` accepts either shape. Key
 * order follows desktop's (QJsonObject sorts keys alphabetically).
 */
function encodeBackgroundImage(bg: BackgroundImage): Record<string, unknown> {
  const out: Record<string, unknown> = { opacity: bg.opacity };
  if (bg.path !== undefined) out.path = bg.path;
  if (bg.rect) out.rect = [bg.rect.x, bg.rect.y, bg.rect.w, bg.rect.h];
  out.url = bg.url;
  return out;
}

/**
 * Reads one saved view, filling defaults for missing fields so a view
 * written by an older or newer build still opens. Returns null for
 * something that isn't a view at all (no id). Unknown fields are kept.
 */
export function readView(raw: unknown): SavedView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id === '') return null;
  const rect = readRect(o.rect) ?? null;
  const sheets = Array.isArray(o.sheets) ? o.sheets.filter((s): s is string => typeof s === 'string') : null;
  return {
    ...o,
    id: o.id,
    name: typeof o.name === 'string' ? o.name : '',
    // A view with no area can only be "fit"; one with an area is fit only when it says so.
    fit: typeof o.fit === 'boolean' ? o.fit || rect === null : rect === null,
    rect,
    sheets,
    grid: typeof o.grid === 'boolean' ? o.grid : true,
    labels: typeof o.labels === 'boolean' ? o.labels : true,
  };
}

function numberField(node: Record<string, unknown>, key: string): number {
  const v = node[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`sidecar field ${key} is not a finite number`);
  }
  return v;
}
