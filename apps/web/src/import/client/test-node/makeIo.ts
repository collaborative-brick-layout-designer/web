// Studio-style .io files for the tests: a ZIP of model.ldr and
// CustomParts/*.dat, deflated, encrypted with ZipCrypto under Studio's
// published password as Studio 2.1 and later write them (or not, or AES-
// marked, or damaged, to check the refusals).

import { deflateRawSync } from 'node:zlib';
import { crc32, ZipCryptoKeys } from '../zip';

export interface IoEntry {
  name: string;
  text?: string;
  bytes?: Uint8Array;
}

export interface IoOptions {
  password?: string | null;
  /** Store instead of deflate. */
  store?: boolean;
  /** Mark entries as WinZip AES (method 99). */
  aes?: boolean;
  /** Flip a byte of the first entry's data. */
  corrupt?: boolean;
}

export function makeIo(entries: IoEntry[], opts: IoOptions = {}): Uint8Array {
  const password = opts.password === undefined ? 'soho0909' : opts.password;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  entries.forEach((entry, idx) => {
    const plain = entry.bytes ?? new TextEncoder().encode(entry.text ?? '');
    const crc = crc32(plain);
    let data: Uint8Array = opts.store ? plain : new Uint8Array(deflateRawSync(plain));
    let flags = 0x800;
    if (password !== null) {
      flags |= 1;
      const keys = new ZipCryptoKeys(new TextEncoder().encode(password));
      const header = new Uint8Array(12);
      for (let i = 0; i < 11; i++) header[i] = (i * 37 + idx) & 0xff;
      header[11] = (crc >>> 24) & 0xff;
      const enc = new Uint8Array(12 + data.length);
      for (let i = 0; i < 12; i++) enc[i] = keys.encryptByte(header[i]!);
      for (let i = 0; i < data.length; i++) enc[12 + i] = keys.encryptByte(data[i]!);
      data = enc;
    }
    if (opts.corrupt && idx === 0) {
      data = data.slice();
      data[data.length - 1] = (data[data.length - 1]! ^ 0xff) & 0xff;
    }
    const method = opts.aes ? 99 : opts.store ? 0 : 8;
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(plain.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, Buffer.from(data));
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  });
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}
