// A module's table and power: what it stands on and what it needs from the
// wall, so a layout coordinator can plan tables and power-strip runs. Store
// and show only: no riser math, no derived heights, no warnings.
//
// A placed module keeps them in the sidecar (BlueBrick never sees them):
//
//   table: { type: 'mils' | 'baseplate' | 'custom',
//            heightMm?: number,            // what was entered, in mm
//            measuredTo?: 'rail' }          // absent: the table top
//   power: { needed: boolean,
//            outlets?: number,              // when needed (absent: 1)
//            watts?: number,                // rough, when needed
//            plugSide?: 'front' | 'back' | 'left' | 'right' }
//
// A library module keeps the same two on the server (modules.setup), so
// they travel with it: adding it to a layout, or updating a placed copy,
// copies them onto the placed module. The desktop's core/ModuleSetup.h is
// the twin of this file; both tests use the same cases.

export const TABLE_TYPES = ['mils', 'baseplate', 'custom'] as const;
export type TableType = (typeof TABLE_TYPES)[number];
export const PLUG_SIDES = ['front', 'back', 'left', 'right'] as const;
export type PlugSide = (typeof PLUG_SIDES)[number];

/** Heights above this (5 m) aren't a table. */
export const MAX_HEIGHT_MM = 5000;
export const MAX_OUTLETS = 50;
export const MAX_WATTS = 100_000;

export interface ModuleTable {
  type: TableType;
  heightMm?: number;
  /** What the height is measured to; absent: the table top. */
  measuredTo?: 'rail';
  [extra: string]: unknown;
}

export interface ModulePower {
  needed: boolean;
  outlets?: number;
  watts?: number;
  plugSide?: PlugSide;
  [extra: string]: unknown;
}

/** A module's table and power; either may be missing (not set). */
export interface ModuleSetup {
  table?: ModuleTable;
  power?: ModulePower;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const inRange = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** The table as stored, or null when it isn't one this build can read (it is then kept as it is, not shown). */
export function readTable(v: unknown): ModuleTable | null {
  if (!isObj(v) || !TABLE_TYPES.includes(v.type as TableType)) return null;
  const out: ModuleTable = { ...v, type: v.type as TableType };
  if (!inRange(v.heightMm, 0, MAX_HEIGHT_MM) || v.heightMm === 0) delete out.heightMm;
  if (v.measuredTo !== 'rail') delete out.measuredTo;
  return out;
}

/** The power needs as stored, or null when not readable. */
export function readPower(v: unknown): ModulePower | null {
  if (!isObj(v) || typeof v.needed !== 'boolean') return null;
  const out: ModulePower = { ...v, needed: v.needed };
  if (!inRange(v.outlets, 0, MAX_OUTLETS) || !Number.isInteger(v.outlets)) delete out.outlets;
  if (!inRange(v.watts, 0, MAX_WATTS)) delete out.watts;
  if (!PLUG_SIDES.includes(v.plugSide as PlugSide)) delete out.plugSide;
  return out;
}

/** How many outlets a module needing power uses: what it says, else one. */
export function outletsOf(p: ModulePower): number {
  return p.needed ? (p.outlets ?? 1) : 0;
}

/**
 * Whether `v` may be stored as a library module's setup (PATCH
 * /api/modules/:id): null, or an object with only `table` and `power`, each
 * absent, null or well formed, with no other keys and short.
 */
export function validSetup(v: unknown): v is ModuleSetup | null {
  if (v === null) return true;
  if (!isObj(v)) return false;
  if (Object.keys(v).some((k) => k !== 'table' && k !== 'power')) return false;
  const t = v.table;
  if (t !== undefined && t !== null) {
    if (!isObj(t) || Object.keys(t).some((k) => !['type', 'heightMm', 'measuredTo'].includes(k))) return false;
    if (!TABLE_TYPES.includes(t.type as TableType)) return false;
    if (t.heightMm !== undefined && !inRange(t.heightMm, 0, MAX_HEIGHT_MM)) return false;
    if (t.measuredTo !== undefined && t.measuredTo !== 'rail') return false;
  }
  const p = v.power;
  if (p !== undefined && p !== null) {
    if (!isObj(p) || Object.keys(p).some((k) => !['needed', 'outlets', 'watts', 'plugSide'].includes(k))) return false;
    if (typeof p.needed !== 'boolean') return false;
    if (p.outlets !== undefined && (!inRange(p.outlets, 0, MAX_OUTLETS) || !Number.isInteger(p.outlets))) return false;
    if (p.watts !== undefined && !inRange(p.watts, 0, MAX_WATTS)) return false;
    if (p.plugSide !== undefined && !PLUG_SIDES.includes(p.plugSide as PlugSide)) return false;
  }
  return true;
}

/** The setup a placed module (or any object with `table` / `power`) holds; null when neither is set. */
export function setupOf(m: object): ModuleSetup | null {
  const { table: t, power: p } = m as { table?: unknown; power?: unknown };
  const table = readTable(t);
  const power = readPower(p);
  if (!table && !power) return null;
  return { ...(table ? { table: tableToStore(table) } : {}), ...(power ? { power: powerToStore(power) } : {}) };
}

function tableToStore(t: ModuleTable): ModuleTable {
  return {
    type: t.type,
    ...(t.heightMm !== undefined ? { heightMm: Math.round(t.heightMm * 10) / 10 } : {}),
    ...(t.measuredTo === 'rail' ? { measuredTo: 'rail' as const } : {}),
  };
}

function powerToStore(p: ModulePower): ModulePower {
  if (!p.needed) return { needed: false };
  return {
    needed: true,
    ...(p.outlets !== undefined ? { outlets: p.outlets } : {}),
    ...(p.watts !== undefined ? { watts: Math.round(p.watts) } : {}),
    ...(p.plugSide ? { plugSide: p.plugSide } : {}),
  };
}

/** `m` with its table set (null: not set). */
export function withTable<M extends object>(m: M, table: ModuleTable | null): M {
  const { table: _was, ...rest } = m as M & { table?: unknown };
  return (table ? { ...rest, table: tableToStore(table) } : rest) as M;
}

/** `m` with its power needs set (null: not set). */
export function withPower<M extends object>(m: M, power: ModulePower | null): M {
  const { power: _was, ...rest } = m as M & { power?: unknown };
  return (power ? { ...rest, power: powerToStore(power) } : rest) as M;
}

/**
 * A placed module given a library module's setup (adding it, or updating
 * it from the library): what the library says replaces what it had; a
 * library module with none set leaves the placed module's own.
 */
export function withLibrarySetup<M extends object>(m: M, setup: ModuleSetup | null | undefined): M {
  if (!setup || (!setup.table && !setup.power)) return m;
  return withPower(withTable(m, setup.table ?? null), setup.power ?? null);
}

// ---- The layout's summary, for its coordinator -------------------------------

export interface HeightCount {
  heightMm: number;
  measuredTo: 'table' | 'rail';
  count: number;
}

export interface TableGroup {
  type: TableType;
  /** Modules with this table type. */
  count: number;
  /** Their heights, lowest first (table tops before rails at the same height); modules with no height aren't in it. */
  heights: HeightCount[];
}

export interface SetupSummary {
  modules: number;
  /** Modules that need power, the outlets they use and the watts they say. */
  power: { modules: number; outlets: number; watts: number; noPower: number; notSet: number };
  /** One per table type that's used, in TABLE_TYPES order. */
  tables: TableGroup[];
  /** Modules whose table isn't set. */
  tablesNotSet: number;
}

/** What the layout's modules need, all together. */
export function setupSummary(modules: readonly object[]): SetupSummary {
  const power = { modules: 0, outlets: 0, watts: 0, noPower: 0, notSet: 0 };
  const groups = new Map<TableType, TableGroup>();
  let tablesNotSet = 0;
  for (const mod of modules) {
    const m = mod as { table?: unknown; power?: unknown };
    const p = readPower(m.power);
    if (!p) power.notSet++;
    else if (!p.needed) power.noPower++;
    else {
      power.modules++;
      power.outlets += outletsOf(p);
      power.watts += Math.round(p.watts ?? 0);
    }
    const t = readTable(m.table);
    if (!t) {
      tablesNotSet++;
      continue;
    }
    const g = groups.get(t.type) ?? { type: t.type, count: 0, heights: [] };
    groups.set(t.type, g);
    g.count++;
    if (t.heightMm === undefined) continue;
    const heightMm = Math.round(t.heightMm * 10) / 10;
    const measuredTo = t.measuredTo === 'rail' ? 'rail' : 'table';
    const h = g.heights.find((x) => x.heightMm === heightMm && x.measuredTo === measuredTo);
    if (h) h.count++;
    else g.heights.push({ heightMm, measuredTo, count: 1 });
  }
  const tables = TABLE_TYPES.filter((t) => groups.has(t)).map((t) => {
    const g = groups.get(t)!;
    g.heights.sort((a, b) => a.heightMm - b.heightMm || (a.measuredTo === b.measuredTo ? 0 : a.measuredTo === 'table' ? -1 : 1));
    return g;
  });
  return { modules: modules.length, power, tables, tablesNotSet };
}

/** A setup stored as JSON text (the server's modules.setup); null when empty or not readable. */
export function parseStoredSetup(text: string | null | undefined): ModuleSetup | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? setupOf(v as object) : null;
  } catch {
    return null;
  }
}
