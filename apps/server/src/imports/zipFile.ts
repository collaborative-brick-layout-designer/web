// Unpack a zip from a file on disk, entry by entry, streaming (an LDraw
// library is ~20,000 files and hundreds of MB): reads the central
// directory, never trusts a local header's sizes, refuses paths out of the
// folder, links, ZIP64 and encryption, and stops at the limits given.

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';

export interface ZipLimits {
  maxEntries: number;
  maxTotalBytes: number;
  /** Per entry over 1 MB: uncompressed / compressed. */
  maxRatio: number;
}

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  isDir: boolean;
  isLink: boolean;
}

export class ZipRefused extends Error {}

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

/** The central directory, checked against `limits`. Throws ZipRefused. */
export async function readZipDirectory(path: string, limits: ZipLimits): Promise<ZipEntry[]> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipRefused('not a zip file');
    const count = tail.readUInt16LE(eocd + 10);
    const dirSize = tail.readUInt32LE(eocd + 12);
    const dirOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || dirOffset === 0xffffffff) throw new ZipRefused('ZIP64 archives are not supported');
    if (count > limits.maxEntries) throw new ZipRefused(`more than ${limits.maxEntries} files`);
    if (dirOffset + dirSize > size) throw new ZipRefused('damaged zip');
    const dir = Buffer.alloc(dirSize);
    await fh.read(dir, 0, dirSize, dirOffset);
    const out: ZipEntry[] = [];
    let off = 0;
    let total = 0;
    for (let n = 0; n < count; n++) {
      if (off + 46 > dir.length || dir.readUInt32LE(off) !== CEN) throw new ZipRefused('damaged zip');
      const madeBy = dir.readUInt16LE(off + 4) >> 8;
      const flags = dir.readUInt16LE(off + 8);
      const method = dir.readUInt16LE(off + 10);
      const compressedSize = dir.readUInt32LE(off + 20);
      const entrySize = dir.readUInt32LE(off + 24);
      const nameLen = dir.readUInt16LE(off + 28);
      const extraLen = dir.readUInt16LE(off + 30);
      const commentLen = dir.readUInt16LE(off + 32);
      const external = dir.readUInt32LE(off + 38);
      const localOffset = dir.readUInt32LE(off + 42);
      const name = dir.subarray(off + 46, off + 46 + nameLen).toString('utf8');
      off += 46 + nameLen + extraLen + commentLen;
      if (flags & 1) throw new ZipRefused('encrypted zips are not supported');
      const isLink = madeBy === 3 && ((external >>> 16) & 0o170000) === 0o120000;
      const isDir = name.endsWith('/');
      total += entrySize;
      if (total > limits.maxTotalBytes) throw new ZipRefused('too big when unpacked');
      if (entrySize > 1 << 20 && entrySize > limits.maxRatio * Math.max(1, compressedSize)) throw new ZipRefused('a file in it unpacks far too much');
      if (method !== 0 && method !== 8 && !isDir) throw new ZipRefused('unsupported compression');
      out.push({ name, method, flags, compressedSize, size: entrySize, localOffset, isDir, isLink });
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** Where an entry goes under `dest`, or null when it would leave it. */
export function safeEntryPath(dest: string, name: string): string | null {
  const n = name.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').some((p) => p === '..') || n.includes('\0')) return null;
  const root = resolve(dest);
  const p = resolve(root, n);
  return p === root || p.startsWith(root + sep) ? p : null;
}

/** Stops a stream that grows past `max` bytes. */
function capped(max: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      seen += chunk.length;
      if (seen > max) cb(new ZipRefused('a file in it is bigger than it says'));
      else cb(null, chunk);
    },
  });
}

/**
 * Unpack `path` into `dest`. `keep(name)` picks the entries (and may
 * rename them: return the path to use, or null to skip). Links and
 * directories are never written as such. Returns how many files and bytes.
 */
export async function unpackZip(
  path: string,
  dest: string,
  limits: ZipLimits,
  keep: (name: string) => string | null = (n) => n,
): Promise<{ files: number; bytes: number }> {
  const entries = await readZipDirectory(path, limits);
  const fh = await open(path, 'r');
  let files = 0;
  let bytes = 0;
  try {
    for (const e of entries) {
      if (e.isDir || e.isLink) continue;
      const rel = keep(e.name);
      if (rel === null) continue;
      const target = safeEntryPath(dest, rel);
      if (!target) throw new ZipRefused(`a file in it points outside its folder: ${e.name.slice(0, 80)}`);
      const head = Buffer.alloc(30);
      await fh.read(head, 0, 30, e.localOffset);
      if (head.readUInt32LE(0) !== LOC) throw new ZipRefused('damaged zip');
      const start = e.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
      await mkdir(dirname(target), { recursive: true });
      const src = e.compressedSize === 0 ? null : createReadStream(path, { start, end: start + e.compressedSize - 1 });
      const sink = createWriteStream(target);
      if (!src) {
        sink.end();
        await new Promise((r) => sink.on('close', r));
      } else if (e.method === 0) {
        await pipeline(src, capped(e.size), sink);
      } else {
        await pipeline(src, createInflateRaw(), capped(e.size), sink);
      }
      files++;
      bytes += e.size;
    }
  } catch (err) {
    await rm(dest, { recursive: true, force: true });
    throw err;
  } finally {
    await fh.close();
  }
  return { files, bytes };
}

