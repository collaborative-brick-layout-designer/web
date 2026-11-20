// LEGO Digital Designer's brick database, one entry at a time, for the
// browser's importer (docs/model-import.md, "In the browser"): a brick's
// geometry (Primitives/LOD0/<designID>.g) or Materials.xml, read from the
// Assets.lif an admin uploaded. Never the whole file, never a listing: a
// request names a design ID (digits) and gets that brick's shape.
//
// The LIF's table of contents is read once per install (the desktop's
// LifReader, src/import/lif/LifReader.cpp: the outer Assets.lif, then the
// db.lif nested in it) into an index of entry → offset and size in the file,
// so each request is one seek and one read. The ldraw.xml mapping (an
// admin's upload or the community one) is served whole: it is a public file.

import { createHash } from 'node:crypto';
import { open, readFile, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { lddState } from './libraries.js';

/** A design ID as LXFML writes it. */
export const DESIGN_ID = /^\d{1,10}$/;
export const MAX_GEOMETRY_BYTES = 16 * 1024 * 1024;
export const MAX_BATCH_BYTES = 24 * 1024 * 1024;
export const MAX_BATCH_IDS = 256;
/** The most of a LIF's table of contents read (LDD's is a few MB). */
const MAX_TOC_BYTES = 128 * 1024 * 1024;
const MAX_DEPTH = 64;

interface Entry {
  offset: number;
  size: number;
}

interface LddLibrary {
  version: string;
  /** The archive holding the database, or a folder of its files (an extracted db). */
  file: string | null;
  dir: string | null;
  index: Map<string, Entry>;
}

let cached: { key: string; lib: Promise<LddLibrary | null> } | null = null;

/** Tests: read the database again. */
export function forgetLddIndex(): void {
  cached = null;
}

async function readAt(fh: FileHandle, at: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(Math.max(0, length));
  const { bytesRead } = await fh.read(buf, 0, buf.length, at);
  return buf.subarray(0, bytesRead);
}

/**
 * The entries of the LIF archive at `base` (`length` bytes) in the file:
 * the desktop's parseTableOfContents, step for step, reading only the
 * header and the table of contents.
 */
export async function lifIndex(fh: FileHandle, base: number, length: number): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>();
  if (length < 84) throw new Error('not a LIF archive (too short)');
  const header = await readAt(fh, base, 84);
  if (header.subarray(0, 4).toString('latin1') !== 'LIFF') throw new Error('not a LIF archive');
  const tocStart = header.readUInt32BE(72) + 64;
  if (tocStart >= length) throw new Error('not a LIF archive (bad table of contents)');
  const toc = await readAt(fh, base + tocStart, Math.min(length - tocStart, MAX_TOC_BYTES));
  // Offsets are in the archive; the buffer starts at tocStart. Past either end reads 0.
  const u32 = (off: number) => (off - tocStart >= 0 && off - tocStart + 4 <= toc.length ? toc.readUInt32BE(off - tocStart) : 0);
  const u16 = (off: number) => (off - tocStart >= 0 && off - tocStart + 2 <= toc.length ? toc.readUInt16BE(off - tocStart) : 0);
  const byte = (off: number) => (off - tocStart >= 0 && off - tocStart < toc.length ? toc[off - tocStart]! : -1);
  let packed = 84;
  const walk = (prefix: string, offset: number, depth: number): number => {
    if (depth > MAX_DEPTH) throw new Error('folders nested too deep');
    offset += prefix ? 4 : 36;
    const count = u32(offset);
    for (let i = 0; i < count; i++) {
      offset += 4;
      const type = u16(offset);
      offset += 6;
      let name = '';
      for (;;) {
        const low = byte(offset + 1);
        if (low <= 0) break;
        name += String.fromCharCode(low);
        offset += 2;
      }
      offset += 6;
      const full = `${prefix}/${name}`;
      if (type === 1) {
        packed += 20;
        offset = walk(full, offset, depth + 1);
      } else if (type === 2) {
        packed += 20;
        const size = u32(offset) - 20;
        if (size < 0 || packed + size > length) throw new Error(`damaged entry ${full}`);
        out.set(full, { offset: base + packed, size });
        packed += size;
        offset += 24;
      } else {
        return offset;
      }
    }
    return offset;
  };
  walk('', tocStart, 0);
  return out;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Where the database is, as the desktop's LDDAssets::open looks (db.lif, an extracted db, Assets.lif). */
async function openLdd(root: string): Promise<Omit<LddLibrary, 'version'> | null> {
  if (await isFile(root)) return openArchive(root);
  for (const rel of ['db.lif', 'Assets/db.lif']) if (await isFile(join(root, rel))) return openArchive(join(root, rel));
  for (const rel of ['db', 'Assets/db']) if (await isFile(join(root, rel, 'Materials.xml'))) return { file: null, dir: join(root, rel), index: new Map() };
  if (await isFile(join(root, 'Assets.lif'))) return openArchive(join(root, 'Assets.lif'));
  return null;
}

async function openArchive(path: string): Promise<Omit<LddLibrary, 'version'> | null> {
  const fh = await open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    let index = await lifIndex(fh, 0, size);
    // LDD's Assets.lif holds its brick database as /db.lif.
    const nested = index.get('/db.lif');
    if (nested) index = await lifIndex(fh, nested.offset, nested.size);
    return { file: path, dir: null, index };
  } finally {
    await fh.close();
  }
}

/** The database as it is now (null when there's none). */
export async function lddLibrary(): Promise<LddLibrary | null> {
  const state = await lddState();
  if (!state.present || !state.path) return null;
  let key = state.path;
  try {
    const s = await stat(state.path);
    key += `|${s.size}|${s.mtimeMs}`;
    if (s.isDirectory()) {
      const a = await stat(join(state.path, 'Assets.lif')).catch(() => null);
      if (a) key += `|${a.size}|${a.mtimeMs}`;
    }
  } catch {
    return null;
  }
  if (cached?.key !== key) {
    const version = createHash('sha256').update(key).digest('hex').slice(0, 16);
    cached = {
      key,
      lib: openLdd(state.path)
        .then((l) => (l ? { ...l, version } : null))
        .catch(() => null),
    };
  }
  return cached.lib;
}

/** A database file by its path in the database ("Primitives/LOD0/3001.g"), or null. */
async function readEntry(lib: LddLibrary, rel: string, max: number): Promise<Buffer | null> {
  if (lib.dir) {
    const p = join(lib.dir, rel);
    try {
      const s = await stat(p);
      if (!s.isFile() || s.size > max) return null;
      return await readFile(p);
    } catch {
      return null;
    }
  }
  // Paths from the archive root; some repackaged archives use a /db/ prefix.
  const e = lib.index.get(`/${rel}`) ?? lib.index.get(`/db/${rel}`);
  if (!e || e.size > max || !lib.file) return null;
  const fh = await open(lib.file, 'r');
  try {
    return await readAt(fh, e.offset, e.size);
  } finally {
    await fh.close();
  }
}

/** One brick's shape, by design ID (the desktop's LDDMeshBuilder::fetchPart). */
export function readGeometry(lib: LddLibrary, designId: string): Promise<Buffer | null> {
  if (!DESIGN_ID.test(designId)) return Promise.resolve(null);
  return readEntry(lib, `Primitives/LOD0/${designId}.g`, MAX_GEOMETRY_BYTES);
}

export function readMaterials(lib: LddLibrary): Promise<Buffer | null> {
  return readEntry(lib, 'Materials.xml', MAX_GEOMETRY_BYTES);
}

/** The LDD → LDraw mapping (ldraw.xml), with a version for its URL. */
export async function lddMapping(): Promise<{ version: string; path: string } | null> {
  const state = (await lddState()).mapping;
  if (!state.present || !state.path) return null;
  try {
    const s = await stat(state.path);
    return { version: createHash('sha256').update(`${state.path}|${s.size}|${s.mtimeMs}`).digest('hex').slice(0, 16), path: state.path };
  } catch {
    return null;
  }
}
