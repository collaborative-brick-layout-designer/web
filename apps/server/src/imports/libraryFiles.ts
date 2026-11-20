// Single files from the import libraries, for the browser's importer
// (docs/model-import.md, "In the browser"). The browser reads and draws the
// model itself, as the desktop's converter does, and asks here only for the
// library files the model uses: one LDraw part file at a time (or a batch),
// LDConfig.ldr's colors and the "~Moved to" index. Never a listing, never a
// whole library.
//
// A name is looked up the way the desktop's LDrawLibrary::resolve does
// (src/import/ldraw/LDrawLibrary.cpp), in an index of lower-case file names
// built once per folder. The name only ever selects an index entry: no path
// from the request is joined onto the disk, except a folder hint like "s/"
// or "48/" that must be plain letters and digits and stay inside the library.
//
// Each library install has a version id (its path, install time, LDConfig's
// release line and file time, hashed), so the browser can cache files for
// good under versioned URLs and simply miss after an update.

import { createHash } from 'node:crypto';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { ldrawState, studioState, type LibraryState } from './libraries.js';

export type LibraryName = 'ldraw' | 'studio';

/** A part file name the browser may ask for: LDraw's characters, a .dat or .ldr. */
const NAME = /^[A-Za-z0-9_\-.~+ #/\\]{1,160}$/;
const SEGMENT = /^[A-Za-z0-9_\-.~+ #]+$/;
/** The folder hint in "s/3001s01.dat" or "48/box5.dat". */
const HINT = /^[A-Za-z0-9_-]{1,32}(?:\/[A-Za-z0-9_-]{1,32})?$/;

/** The most a single file may be (LDraw's biggest printed baseplates are a few MB). */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** The most one batch answer carries; the rest come back in `more`. */
export const MAX_BATCH_BYTES = 16 * 1024 * 1024;
export const MAX_BATCH_NAMES = 256;

/**
 * The name, cleaned (forward slashes), when it's one the browser may ask
 * for: no "..", no empty or absolute parts, a .dat or .ldr at the end.
 */
export function cleanPartName(raw: unknown): string | null {
  if (typeof raw !== 'string' || !NAME.test(raw)) return null;
  const name = raw.trim().replace(/\\/g, '/');
  if (!name || name.startsWith('/')) return null;
  const parts = name.split('/');
  if (parts.length > 3) return null;
  for (const p of parts) if (!p || p === '.' || p === '..' || !SEGMENT.test(p)) return null;
  if (!/\.(dat|ldr)$/i.test(parts[parts.length - 1]!)) return null;
  return name;
}

interface Library {
  root: string;
  version: string;
  /** "subdir" → lower-case file name → absolute path. */
  indexes: Map<string, Promise<Map<string, string>>>;
  unofficial: Promise<string>;
  moved: Promise<Record<string, string[]>> | null;
}

const libraries = new Map<string, Library>();

async function versionOf(state: LibraryState, root: string): Promise<string> {
  let mtime = 0;
  try {
    mtime = (await stat(join(root, 'LDConfig.ldr'))).mtimeMs;
  } catch {
    /* none: the root's own time */
  }
  return createHash('sha256').update(`${root}|${state.installedAt ?? ''}|${state.version ?? ''}|${mtime}`).digest('hex').slice(0, 16);
}

/** The library as it is now (null when it isn't installed). */
export async function library(name: LibraryName): Promise<Library | null> {
  const state = name === 'ldraw' ? await ldrawState() : await studioState();
  if (!state.present || !state.path) return null;
  const version = await versionOf(state, state.path);
  const key = `${name}|${version}`;
  let lib = libraries.get(key);
  if (!lib) {
    // Forget the indexes of a library that has since been replaced.
    for (const k of libraries.keys()) if (k.startsWith(`${name}|`)) libraries.delete(k);
    const root = state.path;
    lib = { root, version, indexes: new Map(), unofficial: unofficialDir(root), moved: null };
    libraries.set(key, lib);
  }
  return lib;
}

/** Tests: build every index again. */
export function forgetLibraryIndexes(): void {
  libraries.clear();
}

async function unofficialDir(root: string): Promise<string> {
  try {
    for (const e of await readdir(root, { withFileTypes: true })) if (e.isDirectory() && e.name.toLowerCase() === 'unofficial') return e.name;
  } catch {
    /* no root: nothing */
  }
  return '';
}

/** The files of one folder of the library, by lower-case name (as the desktop's indexFor). */
function indexFor(lib: Library, subdir: string): Promise<Map<string, string>> {
  let idx = lib.indexes.get(subdir);
  if (!idx) {
    idx = (async () => {
      const out = new Map<string, string>();
      const dir = resolve(lib.root, subdir);
      // Stays inside the library, whatever the hint said.
      const rel = relative(resolve(lib.root), dir);
      if (rel.startsWith('..') || rel.includes(`..${sep}`)) return out;
      try {
        for (const e of await readdir(dir, { withFileTypes: true })) if (e.isFile()) out.set(e.name.toLowerCase(), join(dir, e.name));
      } catch {
        /* no such folder */
      }
      return out;
    })();
    lib.indexes.set(subdir, idx);
  }
  return idx;
}

/** LDraw's search order (desktop LDrawLibrary::resolve), without the model's own parts. */
export async function resolvePart(lib: Library, cleanName: string): Promise<string | null> {
  let rel = cleanName;
  const unofficial = await lib.unofficial;
  if (rel.includes('/')) {
    const tail = rel.slice(rel.lastIndexOf('/') + 1);
    const head = rel.slice(0, rel.lastIndexOf('/'));
    if (HINT.test(head)) {
      const prefixes = [`parts/${head}`, `p/${head}`];
      if (unofficial) prefixes.push(`${unofficial}/parts/${head}`, `${unofficial}/p/${head}`);
      prefixes.push(head);
      for (const p of prefixes) {
        const hit = (await indexFor(lib, p)).get(tail.toLowerCase());
        if (hit) return hit;
      }
    }
    rel = tail;
  }
  const official = ['parts', 'p', 'p/48', 'p/8', 'parts/s'];
  const dirs = [...official, ...(unofficial ? official.map((d) => `${unofficial}/${d}`) : []), ''];
  const needle = rel.toLowerCase();
  for (const d of dirs) {
    const hit = (await indexFor(lib, d)).get(needle);
    if (hit) return hit;
  }
  return null;
}

/** A resolved file's text, or null when it's missing or too big. */
export async function readPart(path: string): Promise<string | null> {
  try {
    const s = await stat(path);
    if (!s.isFile() || s.size > MAX_FILE_BYTES) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function readLDConfig(lib: Library): Promise<string | null> {
  return readPart(join(lib.root, 'LDConfig.ldr'));
}

function stemLower(name: string): string {
  let n = name.trim().toLowerCase().replace(/\\/g, '/');
  n = n.slice(n.lastIndexOf('/') + 1);
  return n.endsWith('.dat') ? n.slice(0, -4) : n;
}

/**
 * New part name → the earlier names moved to it (lower-case, no ".dat"):
 * the "0 ~Moved to <new>" first lines of parts/*.dat, as the desktop's
 * LDrawLibrary::formerNames reads them. Built once per library version.
 */
export function movedIndex(lib: Library): Promise<Record<string, string[]>> {
  if (!lib.moved) {
    lib.moved = (async () => {
      const out: Record<string, string[]> = {};
      const re = /^0\s+~Moved\s+to\s+(\S+)/i;
      const idx = await indexFor(lib, 'parts');
      // Sorted, so the lists come out the same every time.
      for (const [name, path] of [...idx.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        let fh;
        try {
          fh = await open(path, 'r');
          const buf = Buffer.alloc(256);
          const { bytesRead } = await fh.read(buf, 0, 256, 0);
          const first = buf.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)[0] ?? '';
          const m = re.exec(first);
          if (m) (out[stemLower(m[1]!)] ??= []).push(stemLower(name));
        } catch {
          /* unreadable: skipped */
        } finally {
          await fh?.close();
        }
      }
      return out;
    })();
  }
  return lib.moved;
}
