// The libraries the converter reads (docs/model-import.md), all under
// <data>/import-libraries/, never in a backup or a data download. Only
// single LDraw / Studio part files go out, to signed-in people's browsers
// (imports/libraryFiles.ts); a library is never served whole or listed:
//   ldraw/        the official LDraw library (complete.zip, CC BY 2.0),
//                 downloaded on the admin's click; ldraw.json says which
//   ldd/          LEGO Digital Designer's Assets.lif (proprietary: an admin
//                 uploads it), and ldraw.xml, the LDD → LDraw mapping (an
//                 admin's upload, or the community one fetched on a click)
//   studio/       BrickLink Studio's own LDraw library (optional, uploaded
//                 as a zip of its ldraw folder)
// An IMPORT_* env var, when set, names a path to use instead (read only).

import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { env } from '../env.js';
import { safeFetch } from '../utils/safeFetch.js';
import { unpackZip, ZipRefused } from './zipFile.js';

export const LDRAW_URL = 'https://library.ldraw.org/library/updates/complete.zip';
export const COMMUNITY_LDRAW_XML_URL = 'https://gitlab.com/sylvainls/lxf2ldr.html/-/raw/master/ldraw.xml.p';

/** The biggest uploads the admin page takes. */
export const MAX_ASSETS_BYTES = 1536 * 1024 * 1024;
export const MAX_LDRAW_XML_BYTES = 32 * 1024 * 1024;
export const MAX_LIBRARY_ZIP_BYTES = 1024 * 1024 * 1024;
const LIBRARY_ZIP_LIMITS = { maxEntries: 200_000, maxTotalBytes: 4 * 1024 * 1024 * 1024, maxRatio: 200 };

export function librariesDir(): string {
  return join(dirname(env.dbPath), 'import-libraries');
}

/** Where the converter's jobs work (one folder each, deleted after). */
export function jobsDir(): string {
  return join(dirname(env.dbPath), 'import-jobs');
}

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; bytes: Buffer; lastModified: string | null }>;

let fetcher: Fetcher = async (url) => {
  const res = await safeFetch(url, {
    headers: { 'User-Agent': 'Collaborative Brick Layout Designer server (+https://github.com/collaborative-brick-layout-designer/web)' },
    signal: AbortSignal.timeout(15 * 60_000),
    maxBytes: 600 * 1024 * 1024,
  });
  return { ok: res.ok, status: res.status, bytes: Buffer.from(await res.arrayBuffer()), lastModified: res.headers.get('last-modified') };
};

/** Tests: fetch from somewhere else. */
export function setLibraryFetcher(f: Fetcher | null): void {
  fetcher = f ?? fetcher;
}

export interface LibraryState {
  /** Ready to use. */
  present: boolean;
  /** The path the converter gets, when present. */
  path: string | null;
  /** The env var that names it, when one does (the page then can't change it). */
  forcedBy: string | null;
  /** Shown to the admin. */
  version: string | null;
  date: string | null;
  bytes: number | null;
  installedAt: string | null;
}

async function fileSize(p: string): Promise<number | null> {
  try {
    const s = await stat(p);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function readMeta(name: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(join(librariesDir(), `${name}.json`), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeMeta(name: string, meta: Record<string, unknown>): Promise<void> {
  await mkdir(librariesDir(), { recursive: true });
  await writeFile(join(librariesDir(), `${name}.json`), JSON.stringify(meta, null, 2));
}

const str = (v: unknown) => (typeof v === 'string' ? v : null);
const num = (v: unknown) => (typeof v === 'number' ? v : null);

/** The LDraw library root inside a folder: itself, or its ldraw/ (as complete.zip unpacks). */
async function ldrawRoot(dir: string): Promise<string | null> {
  for (const d of [dir, join(dir, 'ldraw')]) if (await fileSize(join(d, 'LDConfig.ldr')) !== null && (await isDir(join(d, 'parts')))) return d;
  return null;
}

/** LDConfig.ldr's "!LDRAW_ORG ... UPDATE <date>" line, e.g. "2025-03". */
async function ldrawVersion(root: string): Promise<string | null> {
  try {
    const head = (await readFile(join(root, 'LDConfig.ldr'), 'utf8')).slice(0, 4000);
    const m = /!LDRAW_ORG\s+([^\r\n]+)/.exec(head);
    return m ? m[1]!.trim().slice(0, 80) : null;
  } catch {
    return null;
  }
}

export async function ldrawState(): Promise<LibraryState> {
  if (env.importLdrawDir) {
    const root = await ldrawRoot(env.importLdrawDir);
    return { present: !!root, path: root, forcedBy: 'IMPORT_LDRAW_DIR', version: root ? await ldrawVersion(root) : null, date: null, bytes: null, installedAt: null };
  }
  const root = await ldrawRoot(join(librariesDir(), 'ldraw'));
  const meta = await readMeta('ldraw');
  return {
    present: !!root,
    path: root,
    forcedBy: null,
    version: str(meta.version) ?? (root ? await ldrawVersion(root) : null),
    date: str(meta.date),
    bytes: num(meta.bytes),
    installedAt: str(meta.installedAt),
  };
}

/** Download complete.zip and unpack it in place of the library there was (if any). */
export async function downloadLdraw(): Promise<LibraryState> {
  const base = librariesDir();
  await mkdir(base, { recursive: true });
  const tag = randomUUID();
  const zip = join(base, `ldraw-${tag}.zip`);
  const fresh = join(base, `ldraw-${tag}`);
  try {
    const res = await fetcher(LDRAW_URL);
    if (!res.ok) throw new Error(`the LDraw site answered ${res.status}`);
    await writeFile(zip, res.bytes);
    const { bytes } = await unpackZip(zip, fresh, LIBRARY_ZIP_LIMITS);
    const root = await ldrawRoot(fresh);
    if (!root) throw new ZipRefused('that isn’t an LDraw library (no LDConfig.ldr and parts folder)');
    const old = join(base, `ldraw-old-${tag}`);
    await rename(join(base, 'ldraw'), old).catch(() => undefined);
    await rename(fresh, join(base, 'ldraw'));
    await rm(old, { recursive: true, force: true });
    const installed = await ldrawRoot(join(base, 'ldraw'));
    await writeMeta('ldraw', {
      version: installed ? await ldrawVersion(installed) : null,
      date: res.lastModified ? new Date(res.lastModified).toISOString().slice(0, 10) : null,
      bytes,
      installedAt: new Date().toISOString(),
      source: LDRAW_URL,
    });
  } finally {
    await rm(zip, { force: true });
    await rm(fresh, { recursive: true, force: true });
  }
  return ldrawState();
}

export async function removeLdraw(): Promise<void> {
  await rm(join(librariesDir(), 'ldraw'), { recursive: true, force: true });
  await rm(join(librariesDir(), 'ldraw.json'), { force: true });
}

// ---- LDD ------------------------------------------------------------------

export async function lddState(): Promise<LibraryState & { mapping: LibraryState }> {
  const meta = await readMeta('ldd');
  let assets: LibraryState;
  if (env.importLddAssets) {
    const p = env.importLddAssets;
    const ok = (await fileSize(p)) !== null || (await isDir(p));
    assets = { present: ok, path: ok ? p : null, forcedBy: 'IMPORT_LDD_ASSETS', version: null, date: null, bytes: await fileSize(p), installedAt: null };
  } else {
    const p = join(librariesDir(), 'ldd', 'Assets.lif');
    const size = await fileSize(p);
    // The converter opens the folder (Assets.lif, and ldraw.xml beside it).
    assets = { present: size !== null, path: size !== null ? join(librariesDir(), 'ldd') : null, forcedBy: null, version: null, date: null, bytes: size, installedAt: str(meta.assetsAt) };
  }
  let mapping: LibraryState;
  if (env.importLddLdrawXml) {
    const size = await fileSize(env.importLddLdrawXml);
    mapping = { present: size !== null, path: size !== null ? env.importLddLdrawXml : null, forcedBy: 'IMPORT_LDD_LDRAW_XML', version: null, date: null, bytes: size, installedAt: null };
  } else {
    const p = join(librariesDir(), 'ldd', 'ldraw.xml');
    const size = await fileSize(p);
    mapping = { present: size !== null, path: size !== null ? p : null, forcedBy: null, version: str(meta.mappingFrom), date: str(meta.mappingDate), bytes: size, installedAt: str(meta.mappingAt) };
  }
  return { ...assets, mapping };
}

export class UploadTooBig extends Error {}
export class NotThatKindOfFile extends Error {}

async function startsWith(path: string, magic: string): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const b = Buffer.alloc(magic.length);
    await fh.read(b, 0, magic.length, 0);
    return b.toString('latin1') === magic;
  } finally {
    await fh.close();
  }
}

/** An uploaded Assets.lif (or db.lif): kept only when it is a LIF archive. */
export async function saveLddAssets(file: Readable): Promise<void> {
  const dest = join(librariesDir(), 'ldd', 'Assets.lif');
  const tmpDir = join(librariesDir(), 'ldd');
  await mkdir(tmpDir, { recursive: true });
  const tmp = join(tmpDir, `assets-${randomUUID()}.upload`);
  try {
    await streamToExact(file, tmp, MAX_ASSETS_BYTES);
    if (!(await startsWith(tmp, 'LIFF'))) throw new NotThatKindOfFile('That isn’t LDD’s Assets.lif (a LIF archive).');
    await rename(tmp, dest);
    await writeMeta('ldd', { ...(await readMeta('ldd')), assetsAt: new Date().toISOString() });
  } finally {
    await rm(tmp, { force: true });
  }
}

async function streamToExact(file: Readable, dest: string, max: number): Promise<number> {
  let bytes = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (pipeline as (...s: any[]) => Promise<void>)(
    file,
    async function* (src: AsyncIterable<Buffer>) {
      for await (const chunk of src) {
        bytes += chunk.length;
        if (bytes > max) throw new UploadTooBig();
        yield chunk;
      }
    },
    createWriteStream(dest),
  );
  return bytes;
}

/** The community ldraw.xml is published wrapped in a script; the XML inside it. */
export function unwrapLdrawXmlP(text: string): string {
  if (text.trimStart().startsWith('<')) return text;
  let out = '';
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"/g)) out += JSON.parse(`"${m[1]}"`) as string;
  return out;
}

function looksLikeMapping(xml: string): boolean {
  return /<LDrawMapping[\s>]/.test(xml.slice(0, 4096)) && xml.includes('</LDrawMapping>');
}

async function saveMapping(xml: string, from: string, date: string | null): Promise<void> {
  if (!looksLikeMapping(xml)) throw new NotThatKindOfFile('That isn’t an LDD → LDraw mapping (ldraw.xml).');
  const dir = join(librariesDir(), 'ldd');
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `ldraw-${randomUUID()}.xml.tmp`);
  await writeFile(tmp, xml);
  await rename(tmp, join(dir, 'ldraw.xml'));
  await writeMeta('ldd', { ...(await readMeta('ldd')), mappingFrom: from, mappingDate: date, mappingAt: new Date().toISOString() });
}

export async function saveLddMappingUpload(file: Readable): Promise<void> {
  const dir = join(librariesDir(), 'ldd');
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `mapping-${randomUUID()}.upload`);
  try {
    await streamToExact(file, tmp, MAX_LDRAW_XML_BYTES);
    await saveMapping(unwrapLdrawXmlP(await readFile(tmp, 'utf8')), 'uploaded', null);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** The community mapping (lxf2ldr's ldraw.xml, GPL-3), fetched on the admin's click. */
export async function fetchCommunityMapping(): Promise<void> {
  const res = await fetcher(COMMUNITY_LDRAW_XML_URL);
  if (!res.ok) throw new Error(`the mapping's site answered ${res.status}`);
  if (res.bytes.length > MAX_LDRAW_XML_BYTES) throw new UploadTooBig();
  const xml = unwrapLdrawXmlP(res.bytes.toString('utf8'));
  const dated = /^\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(xml.slice(0, 2000))?.[1] ?? null;
  await saveMapping(xml, 'community', dated);
}

export async function removeLdd(what: 'assets' | 'mapping'): Promise<void> {
  const dir = join(librariesDir(), 'ldd');
  await rm(join(dir, what === 'assets' ? 'Assets.lif' : 'ldraw.xml'), { force: true });
}

// ---- Studio -----------------------------------------------------------------

export async function studioState(): Promise<LibraryState> {
  if (env.importStudioLdrawDir) {
    const root = await ldrawRoot(env.importStudioLdrawDir);
    return { present: !!root, path: root, forcedBy: 'IMPORT_STUDIO_LDRAW_DIR', version: null, date: null, bytes: null, installedAt: null };
  }
  const root = await ldrawRoot(join(librariesDir(), 'studio'));
  const meta = await readMeta('studio');
  return { present: !!root, path: root, forcedBy: null, version: null, date: null, bytes: num(meta.bytes), installedAt: str(meta.installedAt) };
}

/** A zip of Studio's ldraw folder, unpacked in place of the one there was. */
export async function saveStudioZip(file: Readable): Promise<LibraryState> {
  const base = librariesDir();
  await mkdir(base, { recursive: true });
  const tag = randomUUID();
  const zip = join(base, `studio-${tag}.zip`);
  const fresh = join(base, `studio-${tag}`);
  try {
    await streamToExact(file, zip, MAX_LIBRARY_ZIP_BYTES);
    // Its top folder, whatever it's called, is the library.
    const { bytes } = await unpackZip(zip, fresh, LIBRARY_ZIP_LIMITS);
    let root = await ldrawRoot(fresh);
    if (!root) {
      const { readdir } = await import('node:fs/promises');
      const subs = (await readdir(fresh, { withFileTypes: true })).filter((d) => d.isDirectory());
      if (subs.length === 1) root = await ldrawRoot(join(fresh, subs[0]!.name));
    }
    if (!root) throw new NotThatKindOfFile('That zip has no LDraw library in it (LDConfig.ldr and a parts folder).');
    const old = join(base, `studio-old-${tag}`);
    await rename(join(base, 'studio'), old).catch(() => undefined);
    await rename(fresh, join(base, 'studio'));
    await rm(old, { recursive: true, force: true });
    await writeMeta('studio', { bytes, installedAt: new Date().toISOString() });
  } finally {
    await rm(zip, { force: true });
    await rm(fresh, { recursive: true, force: true });
  }
  return studioState();
}

export async function removeStudio(): Promise<void> {
  await rm(join(librariesDir(), 'studio'), { recursive: true, force: true });
  await rm(join(librariesDir(), 'studio.json'), { force: true });
}

/** What the converter gets. */
export async function converterLibraries(): Promise<{ ldraw: string; studioLdraw: string; lddAssets: string; lddLdrawXml: string }> {
  const [l, s, d] = await Promise.all([ldrawState(), studioState(), lddState()]);
  return { ldraw: l.path ?? '', studioLdraw: s.path ?? '', lddAssets: d.path ?? '', lddLdrawXml: d.mapping.path ?? '' };
}

export { ZipRefused };
