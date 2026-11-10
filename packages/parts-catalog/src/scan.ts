// Recursively walk a parts-library directory, parse every `.xml` file, and
// pair it with the matching sprite. Returns an in-memory `Catalog`.

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parsePartXml } from './parse.js';
import { effectivePxPerStud, spriteExtensionsFor } from './spriteScale.js';
import type { Catalog, PartMetadata } from './types.js';
import { imageSize } from './imageSize.js';

export interface ScanResult {
  catalog: Catalog;
  /** Files that failed to parse, with the error message. Diagnostic only. */
  errors: { path: string; message: string }[];
}

export async function scanCatalog(rootDir: string): Promise<ScanResult> {
  const catalog: Catalog = new Map();
  const errors: { path: string; message: string }[] = [];

  if (!existsSync(rootDir)) {
    throw new Error(`parts-library not found at ${rootDir}`);
  }

  for await (const xmlPath of walkXml(rootDir)) {
    try {
      const part = await parseOne(rootDir, xmlPath);
      catalog.set(part.key, part);
    } catch (err) {
      errors.push({ path: relative(rootDir, xmlPath), message: (err as Error).message });
    }
  }

  return { catalog, errors };
}

async function parseOne(rootDir: string, xmlPath: string): Promise<PartMetadata> {
  const xml = await readFile(xmlPath, 'utf8');

  // Filename → libraryKey. Strip `.set.xml` (groups) or `.xml` (leaves).
  const filename = xmlPath.slice(xmlPath.lastIndexOf('/') + 1);
  const isGroupFile = filename.toLowerCase().endsWith('.set.xml');
  const stem = isGroupFile ? filename.slice(0, -'.set.xml'.length) : filename.slice(0, -'.xml'.length);

  // Stem is `"<partNumber>.<colorCode>"` — the LAST dot separates them.
  // Some part numbers contain dots (e.g. "TS_TRACK18S.8"), so simple
  // splitting on the FIRST dot is wrong. The desktop's `splitPartKey`
  // splits on the last dot, which we mirror.
  const lastDot = stem.lastIndexOf('.');
  const partNumber = lastDot === -1 ? stem : stem.slice(0, lastDot);
  const colorCode = lastDot === -1 ? '' : stem.slice(lastDot + 1);

  // Find a sibling sprite, in the desktop's order: .gif → .png → .jpg → .jpeg,
  // or .png first when the XML declares a hi-res <PixelsPerStud>.
  // For `.set.xml` files the sprite is `<stem>.set.gif` (BlueBrickParts
  // ships a few sets — like `3739-1.set.gif` — with their own thumbnail).
  // Match desktop's `PartsLibrary.cpp:140-150`, which uses `completeBaseName`
  // (= path with just `.xml` stripped) for the sprite-stem search regardless
  // of whether the .set suffix is present.
  const xmlBase = xmlPath.slice(0, -'.xml'.length);
  const xmlRelPath = relative(rootDir, xmlPath);
  const part = parsePartXml(xml, { partNumber, colorCode, spritePath: '', xmlRelPath });
  let spritePath = '';
  // A hi-res import draws its .png; its .gif is vanilla's 8 px a stud.
  for (const ext of spriteExtensionsFor(part.pxPerStud)) {
    const candidate = xmlBase + ext;
    if (existsSync(candidate)) {
      spritePath = relative(rootDir, candidate);
      break;
    }
  }

  part.spritePath = spritePath;
  part.pxPerStud = effectivePxPerStud(part.pxPerStud, spritePath);
  if (spritePath) {
    const size = imageSize(await readFile(join(rootDir, spritePath)));
    if (size) part.spriteSize = size;
  }
  return part;
}

async function* walkXml(dir: string, top = true): AsyncIterable<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // A library's own config/ (ConnectionTypeList.xml and the like) holds no parts,
      // as in BlueBrick, which reads it apart from the parts.
      if (top && entry.name.toLowerCase() === 'config') continue;
      yield* walkXml(full, false);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml')) {
      yield full;
    }
  }
}

/** Convenience wrapper for `fs.stat` on the root, returning a friendly error. */
export async function statRoot(root: string): Promise<void> {
  if (!existsSync(root)) throw new Error(`parts-library directory missing: ${root}`);
  const s = await stat(root);
  if (!s.isDirectory()) throw new Error(`parts-library path is not a directory: ${root}`);
}
