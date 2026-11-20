// Node-only helpers for the browser importer's tests: an LDraw library in a
// folder (looked up as the server's libraryFiles.ts does), a PNG reader, and
// the desktop's converter (bld-import-server) run on a file.

import { execFileSync } from 'node:child_process';
import { existsSync, fstatSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import type { LibrarySource } from '../library';
import type { LddSource } from '../lddSource';

/** The server's lookup (libraryFiles.ts resolvePart) over a folder. */
export class FolderLibrary implements LibrarySource {
  private readonly idx = new Map<string, Map<string, string>>();
  private readonly unofficial: string;
  requests = 0;
  fetched = 0;

  constructor(readonly root: string) {
    this.unofficial = existsSync(root) ? (readdirSync(root, { withFileTypes: true }).find((e) => e.isDirectory() && e.name.toLowerCase() === 'unofficial')?.name ?? '') : '';
  }

  private index(sub: string): Map<string, string> {
    let m = this.idx.get(sub);
    if (!m) {
      m = new Map();
      const dir = resolve(this.root, sub);
      if (existsSync(dir) && statSync(dir).isDirectory()) for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isFile()) m.set(e.name.toLowerCase(), join(dir, e.name));
      this.idx.set(sub, m);
    }
    return m;
  }

  resolve(name: string): string | null {
    let rel = name.trim().replace(/\\/g, '/');
    const u = this.unofficial;
    if (rel.includes('/')) {
      const tail = rel.slice(rel.lastIndexOf('/') + 1);
      const head = rel.slice(0, rel.lastIndexOf('/'));
      const prefixes = [`parts/${head}`, `p/${head}`, ...(u ? [`${u}/parts/${head}`, `${u}/p/${head}`] : []), head];
      for (const p of prefixes) {
        const hit = this.index(p).get(tail.toLowerCase());
        if (hit) return hit;
      }
      rel = tail;
    }
    const official = ['parts', 'p', 'p/48', 'p/8', 'parts/s'];
    for (const d of [...official, ...(u ? official.map((o) => `${u}/${o}`) : []), '']) {
      const hit = this.index(d).get(rel.toLowerCase());
      if (hit) return hit;
    }
    return null;
  }

  async fetch(names: string[]): Promise<Map<string, string | null>> {
    this.requests++;
    const out = new Map<string, string | null>();
    for (const n of names) {
      const p = this.resolve(n);
      out.set(n, p ? readFileSync(p, 'utf8') : null);
      this.fetched++;
    }
    return out;
  }

  async ldconfig(): Promise<string | null> {
    const p = join(this.root, 'LDConfig.ldr');
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }

  async moved(): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const [name, path] of [...this.index('parts').entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const first = readFileSync(path, 'utf8').slice(0, 256).split(/\r?\n/)[0] ?? '';
      const m = /^0\s+~Moved\s+to\s+(\S+)/i.exec(first);
      if (!m) continue;
      const stem = (s: string) => {
        let x = s.trim().toLowerCase().replace(/\\/g, '/');
        x = x.slice(x.lastIndexOf('/') + 1);
        return x.endsWith('.dat') ? x.slice(0, -4) : x;
      };
      (out[stem(m[1]!)] ??= []).push(stem(name));
    }
    return out;
  }
}

/** An 8-bit RGB or RGBA PNG (what Qt writes) as straight RGBA bytes. */
export function readPng(buf: Buffer): { width: number; height: number; rgba: Uint8Array } {
  let o = 8;
  let width = 0,
    height = 0,
    type = 0;
  const idat: Buffer[] = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const kind = buf.toString('latin1', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('only 8-bit, not interlaced');
      type = data[9]!;
    } else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    o += 12 + len;
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 0;
  if (!bpp) throw new Error(`PNG color type ${type}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let v = line[i]!;
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a),
          pb = Math.abs(p - b),
          pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      rgba[(y * width + x) * 4] = cur[x * bpp]!;
      rgba[(y * width + x) * 4 + 1] = cur[x * bpp + 1]!;
      rgba[(y * width + x) * 4 + 2] = cur[x * bpp + 2]!;
      rgba[(y * width + x) * 4 + 3] = bpp === 4 ? cur[x * bpp + 3]! : 255;
    }
    prev.set(cur);
  }
  return { width, height, rgba };
}

export interface ConverterRun {
  json: Record<string, unknown>;
  files: Map<string, Buffer>;
}

/** Run the desktop's converter on `input` (analyse or convert), returning its JSON and what it wrote. */
export function runConverter(converter: string, request: Record<string, unknown>, input: string): ConverterRun {
  const work = mkdtempSync(join(tmpdir(), 'cbld-parity-'));
  try {
    const out = join(work, 'out');
    execFileSync('mkdir', ['-p', out]);
    const req = join(work, 'req.json');
    writeFileSync(req, JSON.stringify({ ...request, input, outDir: out }));
    let stdout: string;
    try {
      stdout = execFileSync(converter, [req], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      // It exits non-zero when nothing can be imported, with its JSON all the same.
      stdout = String((e as { stdout?: string }).stdout ?? '');
      if (!stdout.trim()) throw e;
    }
    const json = JSON.parse(stdout) as Record<string, unknown>;
    const files = new Map<string, Buffer>();
    const walk = (dir: string, rel: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name), `${rel}${e.name}/`);
        else files.set(`${rel}${e.name}`, readFileSync(join(dir, e.name)));
      }
    };
    walk(out, '');
    return { json, files };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** How alike two pictures are: the see-through masks' overlap and the colors where both show. */
export function compareImages(a: { width: number; height: number; rgba: Uint8Array | Uint8ClampedArray }, b: { width: number; height: number; rgba: Uint8Array | Uint8ClampedArray }) {
  if (a.width !== b.width || a.height !== b.height) return { sameSize: false, iou: 0, meanRgb: 255, maxRgb: 255 };
  let inter = 0,
    union = 0,
    sum = 0,
    count = 0,
    max = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    const oa = a.rgba[i * 4 + 3]! > 127;
    const ob = b.rgba[i * 4 + 3]! > 127;
    if (oa || ob) union++;
    if (oa && ob) {
      inter++;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a.rgba[i * 4 + c]! - b.rgba[i * 4 + c]!);
        sum += d;
        if (d > max) max = d;
      }
      count += 3;
    }
  }
  return { sameSize: true, iou: union ? inter / union : 1, meanRgb: count ? sum / count : 0, maxRgb: max };
}

/** LDD's database in Assets.lif (or db.lif) for the tests: the server's lifIndex, read synchronously. */
export class FolderLdd implements LddSource {
  readonly hasAssets: boolean;
  private readonly fd: number | null;
  private readonly index = new Map<string, { offset: number; size: number }>();
  fetched = 0;

  constructor(
    assetsLif: string | null,
    private readonly ldrawXml: string | null,
  ) {
    this.fd = assetsLif && existsSync(assetsLif) ? openSync(assetsLif, 'r') : null;
    this.hasAssets = this.fd !== null;
    if (this.fd !== null) {
      const size = fstatSync(this.fd).size;
      let idx = this.lif(0, size);
      const nested = idx.get('/db.lif');
      if (nested) idx = this.lif(nested.offset, nested.size);
      for (const [k, v] of idx) this.index.set(k, v);
    }
  }

  private read(at: number, n: number): Buffer {
    const b = Buffer.alloc(n);
    const got = readSync(this.fd!, b, 0, n, at);
    return b.subarray(0, got);
  }

  private lif(base: number, length: number): Map<string, { offset: number; size: number }> {
    const out = new Map<string, { offset: number; size: number }>();
    const header = this.read(base, 84);
    const tocStart = header.readUInt32BE(72) + 64;
    const toc = this.read(base + tocStart, length - tocStart);
    const u32 = (o: number) => (o - tocStart >= 0 && o - tocStart + 4 <= toc.length ? toc.readUInt32BE(o - tocStart) : 0);
    const u16 = (o: number) => (o - tocStart >= 0 && o - tocStart + 2 <= toc.length ? toc.readUInt16BE(o - tocStart) : 0);
    let packed = 84;
    const walk = (prefix: string, offset: number): number => {
      offset += prefix ? 4 : 36;
      const count = u32(offset);
      for (let i = 0; i < count; i++) {
        offset += 4;
        const type = u16(offset);
        offset += 6;
        let name = '';
        while (offset + 1 - tocStart < toc.length && toc[offset + 1 - tocStart] !== 0) {
          name += String.fromCharCode(toc[offset + 1 - tocStart]!);
          offset += 2;
        }
        offset += 6;
        if (type === 1) {
          packed += 20;
          offset = walk(`${prefix}/${name}`, offset);
        } else if (type === 2) {
          packed += 20;
          const size = u32(offset) - 20;
          out.set(`${prefix}/${name}`, { offset: base + packed, size });
          packed += size;
          offset += 24;
        } else return offset;
      }
      return offset;
    };
    walk('', tocStart);
    return out;
  }

  private entry(rel: string): Uint8Array | null {
    const e = this.index.get(`/${rel}`) ?? this.index.get(`/db/${rel}`);
    return e ? new Uint8Array(this.read(e.offset, e.size)) : null;
  }

  async shapes(ids: string[]): Promise<Map<string, Uint8Array | null>> {
    const out = new Map<string, Uint8Array | null>();
    for (const id of ids) {
      out.set(id, this.entry(`Primitives/LOD0/${id}.g`));
      this.fetched++;
    }
    return out;
  }

  async materials(): Promise<string | null> {
    const b = this.entry('Materials.xml');
    return b ? new TextDecoder().decode(b) : null;
  }

  async mapping(): Promise<string | null> {
    return this.ldrawXml && existsSync(this.ldrawXml) ? readFileSync(this.ldrawXml, 'utf8') : null;
  }
}
