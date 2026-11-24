// Back up your things: the zip holds only your own things, reads back,
// refuses what isn't a backup (or one too big to open), and a restore plan
// never replaces anything: what you still have is left out, a name you
// already use comes back as "… (restored)".
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildZip } from '../../bbmFiles';
import {
  BACKUP_FORMAT,
  buildAccountBackup,
  openAccountBackup,
  planRestore,
  zipDirectoryTotals,
  type BackupManifest,
  type Existing,
} from '../accountBackup';

// jsdom has no Blob streams for CompressionStream: entries stay stored here.
vi.mock('../../bbmFiles', async (original) => ({ ...(await original<typeof import('../../bbmFiles')>()), deflatedEntry: async (e: unknown) => e }));

const ME = { id: 'me', displayName: 'Me' };
const enc = new TextEncoder();

afterEach(() => vi.unstubAllGlobals());

function fakeServer() {
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === '/api/layouts?owner=me')
        return json({ layouts: [{ id: 'l1', title: 'Main yard', ownerUserId: 'me', updatedAt: 1 }, { id: 'l2', title: 'Club show', ownerUserId: null, ownerOrgId: 'c', updatedAt: 1 }] });
      if (url === '/api/modules?owner=me') return json({ modules: [{ id: 'm1', title: 'Corner', ownerUserId: 'me', ownerOrgId: null, docVersion: 1, hasSidecar: false, thumbnailAt: 5, setup: null, createdAt: 1 }] });
      if (url === '/api/venues?owner=me') return json({ venues: [{ id: 'v1', name: 'Hall', ownerUserId: 'me', ownerOrgId: null }] });
      if (url === '/api/rolling-stock?owner=me') return json({ stock: [{ id: 's1', number: '4014', name: 'Big Boy', ownerUserId: 'me', ownerOrgId: null, version: 1, updatedAt: 1, canManage: true, record: { number: '4014', name: 'Big Boy' } }] });
      if (url === '/api/layouts/l1/export.bld-layout') return new Response(new Uint8Array([1, 2, 3]));
      if (url === '/api/modules/m1/snapshot') return new Response(new Uint8Array([9, 9]));
      if (url === '/api/modules/m1/thumbnail') return new Response(new Uint8Array([7]));
      if (url === '/api/venues/v1') return json({ id: 'v1', name: 'Hall', data: { bounds: { w: 10, h: 10 } } });
      return new Response('{"error":"not_found"}', { status: 404 });
    }),
  );
  return calls;
}

describe('the backup zip', () => {
  it('holds your own things only, with a manifest, and reads back', async () => {
    const calls = fakeServer();
    const { bytes, manifest } = await buildAccountBackup(ME);
    expect(manifest.items.map((i) => `${i.kind}:${i.title}`)).toEqual(['layout:Main yard', 'module:Corner', 'venue:Hall', 'rolling-stock:4014 Big Boy']);
    // The club's layout was never even fetched.
    expect(calls.some((c) => c.includes('l2'))).toBe(false);
    const opened = await openAccountBackup(bytes);
    expect(opened.manifest.format).toBe(BACKUP_FORMAT);
    expect(opened.files.get('layouts/001 Main yard.bld-layout')).toEqual(new Uint8Array([1, 2, 3]));
    expect(opened.files.get('modules/001 Corner/module.ydoc')).toEqual(new Uint8Array([9, 9]));
    expect(opened.files.has('modules/001 Corner/thumbnail.webp')).toBe(true);
    expect(new TextDecoder().decode(opened.files.get('README.txt'))).toContain('Restore from a backup');
  });

  it('refuses a file that isn’t a backup, and one from a newer site', async () => {
    await expect(openAccountBackup(enc.encode('hello'))).rejects.toThrow(/isn’t a backup/);
    const other = buildZip([{ name: 'manifest.json', data: enc.encode(JSON.stringify({ format: 'bld-layout' })) }]);
    await expect(openAccountBackup(other)).rejects.toThrow(/isn’t a backup/);
    const newer = buildZip([{ name: 'manifest.json', data: enc.encode(JSON.stringify({ format: BACKUP_FORMAT, version: 99, items: [] })) }]);
    await expect(openAccountBackup(newer)).rejects.toThrow(/newer version/);
  });

  it('refuses a zip whose directory says it unpacks to too much, before unpacking it', async () => {
    const zip = buildZip([{ name: 'manifest.json', data: enc.encode('{}') }]);
    // Claim 3 GB unpacked in the central directory.
    const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    for (let i = zip.length - 22; i >= 0; i--) {
      if (v.getUint32(i, true) === 0x02014b50) {
        v.setUint32(i + 24, 0xc0000000, true);
        break;
      }
    }
    expect(zipDirectoryTotals(zip).unpacked).toBeGreaterThan(2 * 1024 ** 3);
    await expect(openAccountBackup(zip)).rejects.toThrow(/too big/);
  });
});

describe('the restore plan', () => {
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: 1,
    generator: 't',
    server: 'x',
    exportedAt: new Date(0).toISOString(),
    account: { id: 'me', name: 'Me' },
    items: [
      { kind: 'layout', id: 'still-here', title: 'Main yard', path: 'a', updatedAt: null },
      { kind: 'layout', id: 'gone', title: 'Harbor', path: 'b', updatedAt: null },
      { kind: 'module', id: 'gone-too', title: 'Corner', path: 'c', updatedAt: null },
      { kind: 'venue', id: 'v', title: 'Hall', path: 'd', updatedAt: null },
    ],
  };
  const existing: Existing = {
    ids: new Set(['still-here']),
    titles: { layout: new Set(['main yard', 'harbor']), module: new Set(), venue: new Set(), 'rolling-stock': new Set() },
  };

  it('leaves out what you still have, renames a clash, brings back the rest as named', () => {
    const plan = planRestore(manifest, existing);
    expect(plan.map((p) => [p.item.title, p.choice, p.newTitle, p.clash?.why ?? null])).toEqual([
      ['Main yard', 'skip', 'Main yard (restored)', 'same'],
      ['Harbor', 'add', 'Harbor (restored)', 'name'],
      ['Corner', 'add', 'Corner', null],
      ['Hall', 'add', 'Hall', null],
    ]);
  });
});
