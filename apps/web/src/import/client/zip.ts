// A ZIP reader for untrusted archives (Studio .io, later LDD .lxf): the
// desktop's SafeZip (src/import/zip/SafeZip.cpp). Every size is bounded by
// the file's own, data is inflated with the browser's own deflate (never past
// the size the entry claims) and CRCs are checked. No ZIP64; stored and
// deflate only. Traditional PKWARE "ZipCrypto" entries (as BrickLink Studio
// writes them) are read with the passwords given; AES ones never are.

export interface ZipEntry {
  name: string;
  isDir: boolean;
  isSymLink: boolean;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  encrypted: boolean;
  aes: boolean;
  flags: number;
  modTime: number;
}

export type ZipReadError = 'damaged' | 'too-big' | 'unsupported' | 'wrong-password' | 'aes';

export class ZipReadFailed extends Error {
  constructor(readonly why: ZipReadError) {
    super(why);
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const crcByte = (crc: number, b: number) => (CRC_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8)) >>> 0;

/** PKWARE's three keys, stirred by every plain byte (APPNOTE 6.1). */
export class ZipCryptoKeys {
  private k0 = 0x12345678;
  private k1 = 0x23456789;
  private k2 = 0x34567890;

  constructor(password: Uint8Array) {
    for (const b of password) this.update(b);
  }

  private update(b: number) {
    this.k0 = crcByte(this.k0, b);
    this.k1 = (Math.imul((this.k1 + (this.k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    this.k2 = crcByte(this.k2, this.k1 >>> 24);
  }

  private stream(): number {
    const t = (this.k2 | 2) & 0xffff;
    return (Math.imul(t, t ^ 1) >>> 8) & 0xff;
  }

  decryptByte(c: number): number {
    const plain = (c ^ this.stream()) & 0xff;
    this.update(plain);
    return plain;
  }

  encryptByte(plain: number): number {
    const c = (plain ^ this.stream()) & 0xff;
    this.update(plain);
    return c;
  }
}

/** Studio's own password (the same in every copy) and an empty one, which some tools write. */
export const STUDIO_PASSWORDS = ['soho0909', ''];

/** Raw deflate, never more than `size` bytes out; null when it's damaged or doesn't come to exactly `size`. */
export async function inflateRaw(data: Uint8Array, size: number): Promise<Uint8Array | null> {
  const out = new Uint8Array(size);
  let at = 0;
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (at + value.length > size) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      out.set(value, at);
      at += value.length;
    }
  } catch {
    return null;
  }
  return at === size ? out : null;
}

export class SafeZip {
  readonly entries: ZipEntry[] = [];
  readonly valid: boolean;
  private readonly passwords: Uint8Array[];

  constructor(
    private readonly data: Uint8Array,
    passwords: string[] = [],
  ) {
    this.passwords = passwords.map((p) => new TextEncoder().encode(p));
    this.valid = this.parse();
  }

  private u16(at: number): number {
    return at < 0 || at + 2 > this.data.length ? 0 : this.data[at]! | (this.data[at + 1]! << 8);
  }

  private u32(at: number): number {
    return at < 0 || at + 4 > this.data.length ? 0 : (this.data[at]! | (this.data[at + 1]! << 8) | (this.data[at + 2]! << 16) | (this.data[at + 3]! << 24)) >>> 0;
  }

  private parse(): boolean {
    const d = this.data;
    const n = d.length;
    // The last end-of-central-directory record, within 64 KiB + 22 bytes of the end.
    let eocd = -1;
    for (let i = n - 4; i >= 0 && i >= n - 65557 - 4; i--) {
      if (d[i] === 0x50 && d[i + 1] === 0x4b && d[i + 2] === 0x05 && d[i + 3] === 0x06) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0 || eocd + 22 > n || eocd < n - 65557) return false;
    const count = this.u16(eocd + 10);
    let at = this.u32(eocd + 16);
    for (let i = 0; i < count; i++) {
      if (at < 0 || at + 46 > n || this.u32(at) !== 0x02014b50) return false;
      const flags = this.u16(at + 8);
      const method = this.u16(at + 10);
      const nameLen = this.u16(at + 28),
        extraLen = this.u16(at + 30),
        commentLen = this.u16(at + 32);
      const external = this.u32(at + 38);
      const e: ZipEntry = {
        name: '',
        isDir: false,
        isSymLink: ((external >>> 16) & 0o170000) === 0o120000,
        method,
        crc: this.u32(at + 16),
        compressedSize: this.u32(at + 20),
        size: this.u32(at + 24),
        localHeaderOffset: this.u32(at + 42),
        encrypted: (flags & 1) !== 0,
        aes: method === 99,
        flags,
        modTime: this.u16(at + 12),
      };
      if (at + 46 + nameLen > n) return false;
      const raw = d.subarray(at + 46, at + 46 + nameLen);
      e.name = flags & 0x800 ? new TextDecoder().decode(raw) : String.fromCharCode(...raw);
      e.isDir = e.name.endsWith('/');
      // Nothing may claim more than the file holds (no ZIP64 here).
      if (e.compressedSize > n || e.localHeaderOffset > n || e.size > n * 1100 + 65536) return false;
      this.entries.push(e);
      at += 46 + nameLen + extraLen + commentLen;
    }
    return true;
  }

  find(name: string, caseInsensitive = false): ZipEntry | undefined {
    const want = caseInsensitive ? name.toLowerCase() : name;
    return this.entries.find((e) => (caseInsensitive ? e.name.toLowerCase() : e.name) === want);
  }

  /** The entry's data; throws ZipReadFailed with why it couldn't. */
  async read(e: ZipEntry, maxSize = 1 << 30): Promise<Uint8Array> {
    if (e.isDir) throw new ZipReadFailed('damaged');
    if (e.aes) throw new ZipReadFailed('aes');
    if (e.size > maxSize) throw new ZipReadFailed('too-big');
    if (e.method !== 0 && e.method !== 8) throw new ZipReadFailed('unsupported');
    const n = this.data.length;
    const lh = e.localHeaderOffset;
    if (lh + 30 > n || this.u32(lh) !== 0x04034b50) throw new ZipReadFailed('damaged');
    const start = lh + 30 + this.u16(lh + 26) + this.u16(lh + 28);
    if (start > n || e.compressedSize > n - start) throw new ZipReadFailed('damaged');
    const raw = this.data.subarray(start, start + e.compressedSize);

    const unpack = async (src: Uint8Array): Promise<Uint8Array | null> => {
      let out: Uint8Array | null;
      if (e.method === 0) out = src.length === e.size ? src.slice() : null;
      else out = await inflateRaw(src, e.size);
      return out && crc32(out) === e.crc ? out : null;
    };

    if (!e.encrypted) {
      const out = await unpack(raw);
      if (!out) throw new ZipReadFailed('damaged');
      return out;
    }
    // ZipCrypto: a 12-byte header whose last byte is the CRC's high byte
    // (the time's, when the sizes follow the data: flag bit 3).
    if (e.compressedSize < 12) throw new ZipReadFailed('damaged');
    const check = e.flags & 0x8 ? (e.modTime >>> 8) & 0xff : (e.crc >>> 24) & 0xff;
    let headerFit = false;
    for (const password of this.passwords) {
      const keys = new ZipCryptoKeys(password);
      let last = 0;
      for (let i = 0; i < 12; i++) last = keys.decryptByte(raw[i]!);
      if (last !== check) continue;
      headerFit = true;
      const body = new Uint8Array(raw.length - 12);
      for (let i = 0; i < body.length; i++) body[i] = keys.decryptByte(raw[i + 12]!);
      const out = await unpack(body);
      if (out) return out;
    }
    throw new ZipReadFailed(headerFit ? 'damaged' : 'wrong-password');
  }
}
