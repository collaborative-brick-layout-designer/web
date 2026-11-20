// An imported model as one part, ready for the preview: the desktop's
// prepareImport for LDraw files (src/ui/ImportPipeline.cpp: readLDraw,
// fromLDrawGeometry, friendlyImportWarnings, suggestedImportName) and the
// part key (src/import/ImportToPart.cpp's sanitizeKey).

import type { MapLibrary } from '@cld/parts-catalog/browser';
import { bakeMeshFromLDraw } from './bake';
import { externalConnections, toBlueBrickMap, type ImportedConnection } from './connections';
import { readLDraw, type LDrawReadResult } from './ldrawReader';
import { LDrawFiles, type FetchProgress, type LibrarySource } from './library';
import { MeshLoader } from './meshLoader';
import { Palette } from './palette';
import { IMPORT_RASTER, rasterizeMeshTopDown, type Image, type Margins, type Rect } from './rasterize';

export interface ImportStats {
  ldrawResolved: number;
  lddRendered: number;
  unresolved: number;
}

export interface PreparedPart {
  source: string;
  title: string;
  designer: string;
  kindLabel: string;
  sprite: Image | null;
  widthStuds: number;
  heightStuds: number;
  snapMargin: Margins;
  contentStuds: Rect;
  baseOnGrid: boolean;
  connections: ImportedConnection[];
  quarterTurns: number;
  droppedConnections: { x: number; y: number }[];
  align: '' | 'bottom' | 'box';
  nudgeStuds: { x: number; y: number };
  alignShift: { x: number; y: number };
  stats: ImportStats;
  warnings: string[];
  error: string;
}

export function emptyPart(source: string, kindLabel: string): PreparedPart {
  return {
    source,
    title: '',
    designer: '',
    kindLabel,
    sprite: null,
    widthStuds: 0,
    heightStuds: 0,
    snapMargin: { left: 0, top: 0, right: 0, bottom: 0 },
    contentStuds: { x: 0, y: 0, width: 0, height: 0 },
    baseOnGrid: false,
    connections: [],
    quarterTurns: 0,
    droppedConnections: [],
    align: '',
    nudgeStuds: { x: 0, y: 0 },
    alignShift: { x: 0, y: 0 },
    stats: { ldrawResolved: 0, lddRendered: 0, unresolved: 0 },
    warnings: [],
    error: '',
  };
}

/** Qt's tr() with %n and no translation: %n is the number, "(s)" stays as it is. */
const n = (text: string, count: number) => text.replace(/%n/g, String(count));

/** The importers' warnings as people read them (the desktop's friendlyImportWarnings). */
export function friendlyImportWarnings(raw: readonly string[], fromLdd: boolean): string[] {
  const order: string[] = [];
  const times = new Map<string, number>();
  const noGeo: string[] = [];
  const noGeoTimes = new Map<string, number>();
  const other: string[] = [];
  const otherTimes = new Map<string, number>();
  for (const w of raw) {
    const m = /^Unresolved (?:part|subfile) (.+)$/.exec(w);
    const g = /^missing \.g for designID (.+)$/.exec(w);
    if (m) {
      const part = m[1]!.trim();
      const key = part.toLowerCase();
      if (!times.has(key)) order.push(part);
      times.set(key, (times.get(key) ?? 0) + 1);
    } else if (g) {
      const id = g[1]!.trim();
      if (!noGeoTimes.has(id)) noGeo.push(id);
      noGeoTimes.set(id, (noGeoTimes.get(id) ?? 0) + 1);
    } else {
      const c = /^Could not open (.+)$/.exec(w);
      const line = c ? `Couldn’t open ${c[1]}.` : w;
      if (!otherTimes.has(line)) other.push(line);
      otherTimes.set(line, (otherTimes.get(line) ?? 0) + 1);
    }
  }
  const named = (names: string[], count: Map<string, number>, fold: boolean) => {
    const shown = names.slice(0, 8).map((name) => {
      const k = count.get(fold ? name.toLowerCase() : name) ?? 0;
      return k > 1 ? n(`${name} (%n times)`, k) : name;
    });
    let list = shown.join(', ');
    if (names.length > 8) list += ' ' + n('and %n more', names.length - 8);
    return list;
  };
  const out: string[] = [];
  if (order.length) {
    out.push(n('%n part(s) aren’t in your LDraw library, so they’re left out of the picture: ', order.length) + named(order, times, true) + '.');
    out.push(
      fromLdd
        ? 'A newer LDD → LDraw mapping (ldraw.xml) in Settings › Bringing in models may know them.'
        : 'A newer LDraw library, set in Settings › Bringing in models, may have them.',
    );
  }
  if (noGeo.length) out.push(n('LDD has no shape for %n brick(s), so they’re left out: ', noGeo.length) + named(noGeo, noGeoTimes, false) + '.');
  for (const line of other) {
    const k = otherTimes.get(line) ?? 0;
    out.push(k > 1 ? n(`${line} (%n times)`, k) : line);
  }
  return out;
}

/** QFileInfo::completeBaseName: the file name without its last extension. */
export function completeBaseName(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : dot === 0 ? '' : name;
}

/** The desktop's suggestedImportName: the model's title, else the file's name. */
export function suggestedImportName(part: Pick<PreparedPart, 'title' | 'source'>): string {
  const t = part.title;
  if (!t || t.toLowerCase() === 'untitled model' || t.length > 80) return completeBaseName(part.source);
  return t;
}

const MODEL_EXT = /\.(ldr|dat|mpd|io|lxf|lxfml)$/i;

/** The part key from a name or file (the desktop's sanitizeKey). */
export function importedPartKey(nameOrPath: string): string {
  let stem = nameOrPath.slice(Math.max(nameOrPath.lastIndexOf('/'), nameOrPath.lastIndexOf('\\')) + 1);
  stem = stem.replace(MODEL_EXT, '');
  stem = stem.replace(/[^A-Za-z0-9_\-.]/g, '_').replace(/_+/g, '_');
  while (stem.endsWith('.')) stem = stem.slice(0, -1);
  return stem || 'ImportedModel';
}

export interface PrepareOptions {
  /** The site's LDraw library (or a folder in tests). */
  source: LibrarySource;
  /** BlueBrick's parts library: for where track snaps on. */
  parts: MapLibrary;
  signal?: AbortSignal;
  onFetch?: (p: FetchProgress) => void;
  onDraw?: () => void;
  /** Already read (Studio); otherwise `text` is read as LDraw. */
  read?: LDrawReadResult;
}

/** fromLDrawGeometry: the model drawn from the LDraw library, with its free connection points. */
export async function prepareLDraw(fileName: string, text: string, opts: PrepareOptions, kindLabel = 'LDraw import'): Promise<PreparedPart> {
  const out = emptyPart(fileName, kindLabel);
  const read = opts.read ?? readLDraw(text);
  if (!read.ok) {
    out.error = `Could not read ${fileName}: ${read.error}`;
    return out;
  }
  out.title = read.title.trim();
  out.designer = read.author;

  const files = new LDrawFiles(opts.source, read.overlay);
  const [ldconfig, moved] = await Promise.all([opts.source.ldconfig(), opts.source.moved()]);
  await files.load(
    read.parts.map((p) => p.filename),
    { ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.onFetch ? { onProgress: opts.onFetch } : {}) },
  );
  opts.signal?.throwIfAborted();
  opts.onDraw?.();
  const palette = Palette.fromLDConfig(ldconfig);
  const loader = new MeshLoader(files, palette);
  const baked = bakeMeshFromLDraw(read, loader, palette);
  const rast = baked.mesh.triColor.length ? rasterizeMeshTopDown(baked.mesh, IMPORT_RASTER) : null;
  out.warnings = friendlyImportWarnings([...read.warnings, ...baked.errors], false);
  out.stats.ldrawResolved = baked.resolvedRefs;
  out.stats.unresolved = baked.unresolvedRefs;
  if (!rast?.image) {
    out.error = 'This site’s LDraw library has no geometry for any part in this model.';
    return out;
  }
  out.sprite = rast.image;
  out.widthStuds = Math.round(rast.spriteStuds.width);
  out.heightStuds = Math.round(rast.spriteStuds.height);
  out.snapMargin = rast.snapMargin;
  out.contentStuds = { ...rast.meshBoundsXZ, x: rast.meshBoundsXZ.x - rast.spriteStuds.x, y: rast.meshBoundsXZ.y - rast.spriteStuds.y };
  out.baseOnGrid = rast.baseOnGrid;
  // Snap points: the model placed as BlueBrick parts (earlier part numbers
  // from the library's "~Moved to" stubs), relative to the picture's centre.
  const former = (name: string) => formerNames(moved, name);
  const placed = toBlueBrickMap(read, opts.parts, former, loader);
  out.connections = externalConnections(placed, opts.parts, { x: rast.spriteStuds.x + rast.spriteStuds.width / 2, y: rast.spriteStuds.y + rast.spriteStuds.height / 2 });
  return out;
}

/** The desktop's LDrawLibrary::formerNames: earlier numbers, newest first, chains followed. */
export function formerNames(moved: Record<string, string[]>, partName: string): string[] {
  let s = partName.trim().toLowerCase().replace(/\\/g, '/');
  s = s.slice(s.lastIndexOf('/') + 1);
  if (s.endsWith('.dat')) s = s.slice(0, -4);
  const out: string[] = [];
  const pending = [s];
  while (pending.length) {
    for (const old of moved[pending.shift()!] ?? []) {
      if (out.includes(old)) continue;
      out.push(old);
      pending.push(old);
    }
  }
  return out;
}
