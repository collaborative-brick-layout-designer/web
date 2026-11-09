// Local layout files: the zip reader and writer under .bld-layout
// (layoutFile.ts) and the window-level file drop.
//
// Desktop's .bbm files from before .bld-layout keep a layout's labels,
// modules, venue and background image in a `<file>.bbm.bld` sidecar next to
// the `.bbm`, and the server's export.zip holds the pair. Dropping a `.bbm`
// together with its `.bbm.bld`, such a `.zip`, or a `.bld-layout` loads it.

/** Same rule as the server's export filenames (routes/layouts.ts sanitizeFilename). */
export function sanitizeFilename(s: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\\/:*?"<>|\x00-\x1F]+/g, '_').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'layout';
}

// ---------------------------------------------------------------------------
// ZIP (PKZIP 2.0, stored entries — same writer as the server export)
// ---------------------------------------------------------------------------

let crcTable: Uint32Array | null = null;

export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  /** Written deflated (method 8): these bytes are `data` compressed. */
  deflated?: Uint8Array;
}

/** Raw deflate (no zlib header), as a zip entry holds it. */
export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** `entry` deflated, unless that doesn't make it smaller. */
export async function deflatedEntry(entry: ZipEntry): Promise<ZipEntry> {
  if (entry.data.length === 0) return entry;
  const deflated = await deflateRaw(entry.data);
  return deflated.length < entry.data.length ? { ...entry, deflated } : entry;
}

/** Build a zip: entries are stored, or deflated when they carry `deflated`. */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const body = e.deflated ?? e.data;
    const method = e.deflated ? 8 : 0;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cen.set(name, 46);
    parts.push(local, body);
    central.push(cen);
    offset += local.length + body.length;
  }
  const cenSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cenSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cenSize + 22);
  let p = 0;
  for (const part of [...parts, ...central, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Read a zip's entries (stored or deflated) via its central directory.
 * Throws on anything else.
 */
export async function readZip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt zip directory');
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const localOff = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const lNameLen = v.getUint16(localOff + 26, true);
    const lExtraLen = v.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + csize);
    if (method === 0) out.push({ name, data: raw.slice() });
    else if (method === 8) out.push({ name, data: await inflateRaw(raw) });
    else throw new Error(`unsupported zip compression (${method})`);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drop
// ---------------------------------------------------------------------------

/** A dropped layout: the `.bbm` text and, when found, its sidecar text. */
export interface DroppedLayout {
  name: string;
  bbm: string;
  sidecar?: string;
  /** What the conversion from another map format (or a newer layout file) skipped. */
  warnings?: string[];
  /** A .bld-layout's background image, for the server to keep. */
  background?: { type: string; data: Uint8Array };
  /** A .bld-layout's parts, by file name (layoutParts.ts uploads the missing ones). */
  parts?: Record<string, Uint8Array>;
}

/** Turns a TrackDesigner / 4DBrix file into .bbm text (mapFormats.ts). */
export type MapConverter = (name: string, bytes: Uint8Array) => Promise<{ bbm: string; warnings: string[] }>;

const MAP_FILE = /\.(tdl|ncp)$/i;

interface NamedText {
  name: string;
  text: () => Promise<string>;
}

const SIDECAR_EXT = /\.bbm\.(bld|cld)$/i;

/**
 * Pair every `.bbm` with the `<same name>.bbm.bld` (or legacy `.bbm.cld`)
 * dropped alongside it. Sidecars without their `.bbm` are ignored.
 */
export async function pairLayoutFiles(files: readonly NamedText[]): Promise<DroppedLayout[]> {
  const sidecars = new Map<string, NamedText>();
  for (const f of files) {
    const m = SIDECAR_EXT.exec(f.name);
    if (!m) continue;
    const key = f.name.slice(0, m.index).toLowerCase();
    // Desktop's own name (.bbm.bld) wins over the legacy one.
    if (!sidecars.has(key) || m[1]!.toLowerCase() === 'bld') sidecars.set(key, f);
  }
  const out: DroppedLayout[] = [];
  for (const f of files) {
    if (!/\.bbm$/i.test(f.name)) continue;
    const sc = sidecars.get(f.name.slice(0, -4).toLowerCase());
    const entry: DroppedLayout = { name: f.name, bbm: await f.text() };
    if (sc) entry.sidecar = await sc.text();
    out.push(entry);
  }
  return out;
}

/**
 * Layouts in dropped files: `.bld-layout` files, loose `.bbm` / `.bbm.bld`
 * files plus the contents of any `.zip`, and — given a converter —
 * TrackDesigner and 4DBrix maps.
 */
export async function layoutsFromFiles(files: readonly File[], convertMap?: MapConverter): Promise<DroppedLayout[]> {
  const loose: NamedText[] = [];
  const out: DroppedLayout[] = [];
  const dec = new TextDecoder();
  for (const f of files) {
    if (/\.bld-layout$/i.test(f.name)) {
      // Loaded on demand; layoutFile.ts imports this module.
      const { readLayoutFile } = await import('./layoutFile');
      const l = await readLayoutFile(new Uint8Array(await f.arrayBuffer()));
      out.push({
        name: f.name,
        bbm: l.bbm,
        ...(l.sidecar !== undefined ? { sidecar: l.sidecar } : {}),
        ...(l.background ? { background: l.background } : {}),
        ...(l.parts ? { parts: l.parts } : {}),
        ...(l.warnings.length ? { warnings: l.warnings } : {}),
      });
    } else if (MAP_FILE.test(f.name)) {
      if (!convertMap) continue;
      const { bbm, warnings } = await convertMap(f.name, new Uint8Array(await f.arrayBuffer()));
      out.push({ name: f.name, bbm, ...(warnings.length ? { warnings } : {}) });
    } else if (/\.zip$/i.test(f.name)) {
      const entries = await readZip(new Uint8Array(await f.arrayBuffer()));
      const named = entries.map((e) => ({ name: e.name.split('/').pop() ?? e.name, text: async () => dec.decode(e.data) }));
      out.push(...(await pairLayoutFiles(named)));
    } else {
      loose.push({ name: f.name, text: () => f.text() });
    }
  }
  const all = [...(await pairLayoutFiles(loose)), ...out];
  // A sidecar saved by a newer version opens, saying some of it isn't shown.
  const { sidecarWarnings } = await import('@cld/bbm/browser');
  for (const l of all) {
    const notes = l.sidecar !== undefined ? sidecarWarnings(l.sidecar) : [];
    if (notes.length) l.warnings = [...(l.warnings ?? []), ...notes];
  }
  return all;
}
