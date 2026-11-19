// What "Open a file…" takes, in plain words, and what it says about the
// rest. The website opens layouts (.bld-layout, .bbm with its sidecar or
// in a .zip) and TrackDesigner / 4DBrix maps. Models from LDraw,
// BrickLink Studio and LEGO Digital Designer are imported: the server runs
// the desktop app's importer (import/). When it can't, they get the
// desktop app's steps instead of nothing.

import type { BbmMap } from '@cld/model';
import type { PartWire } from '../api';
import { LAYOUT_ACCEPT, MAP_FORMAT_FILE } from '../mapFormats';

/** Files that open as a layout on their own. */
export const OPENS_HERE = /\.(bld-layout|bbm|zip)$/i;
/** Files that come along with a layout (the .bbm's sidecar). */
export const COMES_ALONG = /\.bbm\.(bld|cld)$/i;

/** The formats, in the words the open controls show. */
export const OPEN_FORMATS_LINE =
  'Opens this app’s layouts (.bld-layout), BlueBrick (.bbm), TrackDesigner (.tdl) and 4DBrix (.ncp), ' +
  'and imports LDraw (.ldr, .mpd, .dat), BrickLink Studio (.io) and LDD (.lxf, .lxfml) models.';

/** A file only the desktop app reads, and how to bring it here. */
export interface DesktopOnlyFormat {
  /** "a BrickLink Studio file" */
  what: string;
  /** Where the desktop app imports it. */
  where: string;
  /** It comes in as a custom part (sent from the Server window), not a layout. */
  part: boolean;
}

const DESKTOP_ONLY: readonly { re: RegExp; format: DesktopOnlyFormat }[] = [
  { re: /\.io$/i, format: { what: 'a BrickLink Studio file', where: 'Tools › Import › Studio', part: true } },
  { re: /\.(lxf|lxfml)$/i, format: { what: 'a LEGO Digital Designer (LDD) file', where: 'Tools › Import › LDD', part: true } },
  { re: /\.(ldr|mpd)$/i, format: { what: 'an LDraw file', where: 'File › Open, or Tools › Import to make it a part', part: false } },
  { re: /\.dat$/i, format: { what: 'an LDraw part', where: 'Tools › Import › LDraw', part: true } },
];

export function desktopOnlyFormat(fileName: string): DesktopOnlyFormat | null {
  return DESKTOP_ONLY.find((d) => d.re.test(fileName))?.format ?? null;
}

/** The desktop-only files, offered by the pickers so picking one explains itself. */
const DESKTOP_ONLY_ACCEPT = '.io,.lxf,.lxfml,.ldr,.mpd,.dat';

/** "Open a file…": what opens here (a .bbm's sidecar and .zip too), plus the desktop-only files. */
export const OPEN_PICKER_ACCEPT = `${LAYOUT_ACCEPT},.bld,.cld,.zip,${DESKTOP_ONLY_ACCEPT}`;

/** The New layout dialog's file: one layout file, plus the desktop-only files. */
export const START_FILE_ACCEPT = `${LAYOUT_ACCEPT},${DESKTOP_ONLY_ACCEPT}`;

export type FileSort =
  | { kind: 'open'; files: File[] }
  | { kind: 'desktop'; file: File; format: DesktopOnlyFormat }
  | { kind: 'unknown'; file: File }
  | { kind: 'none' };

/**
 * What to do with picked or dropped files: open the ones the website
 * reads (with any sidecars), else explain a desktop-only one, else say
 * the file isn't a layout. `none`: no files at all.
 */
export function sortFiles(files: readonly File[]): FileSort {
  if (files.length === 0) return { kind: 'none' };
  const opens = files.filter((f) => OPENS_HERE.test(f.name) || MAP_FORMAT_FILE.test(f.name));
  if (opens.length > 0) return { kind: 'open', files: files.filter((f) => opens.includes(f) || COMES_ALONG.test(f.name)) };
  for (const f of files) {
    const format = desktopOnlyFormat(f.name);
    if (format) return { kind: 'desktop', file: f, format };
  }
  return { kind: 'unknown', file: files[0]! };
}

/** The file's name without what the open controls take off it. */
export function titleFromFileName(name: string): string {
  return name.replace(/\.(bld-layout|bbm|zip|tdl|ncp)$/i, '');
}

// ---------------------------------------------------------------------------
// After opening
// ---------------------------------------------------------------------------

export interface MissingPart {
  partNumber: string;
  count: number;
}

export interface OpenSummary {
  /** Every part on the map. */
  parts: number;
  /** How many of them the parts library doesn't have. */
  missing: number;
  /** Those parts, most-used first. */
  missingParts: MissingPart[];
}

/** Count a map's parts and the ones `index` (partIndex.ts) has no entry for. */
export function summarizeMap(map: BbmMap, index: ReadonlyMap<string, PartWire>): OpenSummary {
  let parts = 0;
  const missing = new Map<string, number>();
  for (const layer of map.layers) {
    if (layer.type !== 'brick') continue;
    for (const b of layer.bricks) {
      parts++;
      if (!index.has(b.partNumber.toLowerCase())) missing.set(b.partNumber, (missing.get(b.partNumber) ?? 0) + 1);
    }
  }
  const missingParts = [...missing]
    .map(([partNumber, count]) => ({ partNumber, count }))
    .sort((a, b) => b.count - a.count || a.partNumber.localeCompare(b.partNumber));
  return { parts, missing: missingParts.reduce((n, p) => n + p.count, 0), missingParts };
}

/** "Opened Yard.bbm: 1,204 parts, 37 not in the library". */
export function summaryLine(name: string, s: OpenSummary): string {
  const n = (v: number) => v.toLocaleString('en-US');
  const parts = `${n(s.parts)} ${s.parts === 1 ? 'part' : 'parts'}`;
  const tail = s.missing > 0 ? `, ${n(s.missing)} not in the library` : s.parts > 0 ? ', all in the library' : '';
  return `Opened ${name}: ${parts}${tail}`;
}
