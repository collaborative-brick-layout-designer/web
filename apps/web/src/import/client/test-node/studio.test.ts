// @vitest-environment node
//
// BrickLink Studio's .io files in the browser (zip.ts, studioReader.ts,
// prepareModel.ts), on .io files made here (makeIo.ts) and the tiny test
// library: ZipCrypto with Studio's password, the model and its own custom
// parts, and every refusal the desktop's reader words.

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MapLibrary } from '@cld/parts-catalog/browser';
import { convertPart } from '../convert';
import { prepareModel } from '../prepareModel';
import { readStudioIo } from '../studioReader';
import { crc32, SafeZip, STUDIO_PASSWORDS, ZipReadFailed } from '../zip';
import { makeIo } from './makeIo';
import { FolderLibrary } from './nodeHelpers';

const MINI = resolve(__dirname, 'fixtures/minilib');
const parts = new MapLibrary(new Map());
const MODEL = '0 FILE Ninjago City.io\n0 Author: Studio Builder\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 box2.dat\n1 16 40 0 0 1 0 0 0 1 0 0 0 1 sub.ldr\n0 NOFILE\n0 FILE sub.ldr\n1 1 0 0 0 1 0 0 0 1 0 0 0 1 myplate.dat\n0 NOFILE\n';
// The model's own part: a 2 x 2 plate made of the library's stud, as Studio keeps it in CustomParts.
const CUSTOM = '0 My plate\n4 16 -20 -8 -20 20 -8 -20 20 -8 20 -20 -8 20\n1 16 0 -8 0 1 0 0 0 1 0 0 0 1 stud.dat\n';

describe('ZIP reading', () => {
  it('reads stored, deflated and ZipCrypto entries, checking the CRC', async () => {
    for (const opts of [{ password: null }, { password: null, store: true }, {}]) {
      const zip = new SafeZip(makeIo([{ name: 'a.txt', text: 'hello hello hello' }], opts), STUDIO_PASSWORDS);
      expect(zip.valid).toBe(true);
      expect(new TextDecoder().decode(await zip.read(zip.entries[0]!))).toBe('hello hello hello');
    }
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('says why it can’t: a wrong password, AES, damage, too big', async () => {
    const wrong = new SafeZip(makeIo([{ name: 'a', text: 'x' }], { password: 'other' }), STUDIO_PASSWORDS);
    await expect(wrong.read(wrong.entries[0]!)).rejects.toMatchObject({ why: 'wrong-password' });
    const aes = new SafeZip(makeIo([{ name: 'a', text: 'x' }], { aes: true }), STUDIO_PASSWORDS);
    await expect(aes.read(aes.entries[0]!)).rejects.toMatchObject({ why: 'aes' });
    const bad = new SafeZip(makeIo([{ name: 'a', text: 'x'.repeat(1000) }], { password: null, corrupt: true }));
    await expect(bad.read(bad.entries[0]!)).rejects.toBeInstanceOf(ZipReadFailed);
    const big = new SafeZip(makeIo([{ name: 'a', text: 'x'.repeat(1000) }], { password: null }));
    await expect(big.read(big.entries[0]!, 10)).rejects.toMatchObject({ why: 'too-big' });
    expect(new SafeZip(new Uint8Array([1, 2, 3])).valid).toBe(false);
  });
});

describe('Studio .io files', () => {
  it('reads model.ldr (an MPD) and keeps CustomParts as the model’s own parts', async () => {
    const io = makeIo([
      { name: 'modelv1.ldr', text: '10 4 old format' },
      { name: 'model.ldr', text: MODEL },
      { name: 'CustomParts/myplate.dat', text: CUSTOM },
      { name: 'CustomParts/../evil.dat', text: '0 no' },
      { name: 'thumbnail.png', bytes: new Uint8Array([1, 2, 3]) },
    ]);
    const r = await readStudioIo(io);
    expect(r.ok).toBe(true);
    expect(r.title).toBe('Ninjago City');
    expect(r.author).toBe('Studio Builder');
    expect(r.parts.map((p) => p.filename)).toEqual(['box2.dat', 'myplate.dat']);
    expect([...r.overlay!.keys()]).toEqual(['myplate.dat']);
  });

  it('words what’s wrong as the desktop does', async () => {
    expect((await readStudioIo(new Uint8Array([0x50, 0x4b]))).error).toContain("This isn't a Studio model");
    expect((await readStudioIo(makeIo([{ name: 'x.txt', text: 'x' }]))).error).toBe('This Studio file has no model in it (model.ldr is missing).');
    expect((await readStudioIo(makeIo([{ name: 'model.ldr', text: '0 just a comment\n' }]))).error).toBe('The model in this Studio file is empty.');
    expect((await readStudioIo(makeIo([{ name: 'model.ldr', text: MODEL }], { aes: true }))).error).toContain('AES encryption');
    expect((await readStudioIo(makeIo([{ name: 'model.ldr', text: MODEL }], { password: 'other' }))).error).toContain("encrypted in a way we don't recognise");
  });

  it('falls back to another .ldr, model2.ldr last, when model.ldr is empty', async () => {
    const r = await readStudioIo(
      makeIo([
        { name: 'model.ldr', text: '0 empty\n' },
        { name: 'model2.ldr', text: '1 4 0 0 0 1 0 0 0 1 0 0 0 1 two.dat\n' },
        { name: 'other.ldr', text: '1 4 0 0 0 1 0 0 0 1 0 0 0 1 other.dat\n' },
      ]),
    );
    expect(r.parts.map((p) => p.filename)).toEqual(['other.dat']);
  });

  it('draws a Studio model with its own custom part, and makes it into a part', async () => {
    const io = makeIo([
      { name: 'model.ldr', text: MODEL },
      { name: 'CustomParts/myplate.dat', text: CUSTOM },
    ]);
    const source = new FolderLibrary(MINI);
    const part = await prepareModel('Ninjago City.io', io, { source, parts });
    expect(part.error).toBe('');
    expect(part.kindLabel).toBe('Studio import');
    expect([part.widthStuds, part.heightStuds]).toEqual([4, 2]);
    expect(part.stats).toEqual({ ldrawResolved: 2, lddRendered: 0, unresolved: 0 });
    // The custom part itself never went to the site: only the stud it uses did.
    // box2, then s\box2s01 and the stud (the custom part's stud too); myplate.dat never goes to the site.
    expect(source.fetched).toBe(3);
    const made = convertPart(
      part,
      { quarterTurns: 0, align: '', nudge: [0, 0], drop: [], name: '', designer: '', designerUrl: '', author: 'A' },
      { name: 'Ninjago City.io', lastModified: null, format: 'studio' },
      '2026-11-20',
    );
    expect(made.xml).toContain('<ImportedFrom file="Ninjago City.io" format="studio" date="2026-11-20"/>');
    expect(made.displayName).toBe('Ninjago City');
  });

  it('a Studio file that can’t be read says so, with its name', async () => {
    const part = await prepareModel('broken.io', new Uint8Array([1, 2, 3]), { source: new FolderLibrary(MINI), parts });
    expect(part.error).toMatch(/^Could not read broken\.io: This isn't a Studio model/);
    expect(part.kindLabel).toBe('Studio import');
  });
});
