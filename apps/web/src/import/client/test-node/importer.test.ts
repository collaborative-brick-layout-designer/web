// @vitest-environment node
//
// The browser importer on a tiny library written for these tests
// (fixtures/minilib): reading, fetching what's used a round at a time,
// colors, the picture's footprint and lining up, the part's XML, turning
// and nudging, the outline, and the guards. The real LDraw library and the
// desktop converter are compared in parity.test.ts (opt-in).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MapLibrary } from '@cld/parts-catalog/browser';
import { alignPart, rotateImage, rotatePart } from '../align';
import { convertPart } from '../convert';
import { readLDraw } from '../ldrawReader';
import { LDrawFiles, refKey, subfileOf } from '../library';
import { MeshLoader, SubfileLoop } from '../meshLoader';
import { Palette, bundledColor } from '../palette';
import { fixed, g6, partXml } from '../partXml';
import { simplifyRing, traceCells } from '../pickShape';
import { completeBaseName, formerNames, friendlyImportWarnings, importedPartKey, prepareLDraw, suggestedImportName } from '../prepare';
import { baseLattice, over, packPremul, rasterizeMeshTopDown, toRgba, type Image } from '../rasterize';
import { FolderLibrary } from './nodeHelpers';

const MINI = resolve(__dirname, 'fixtures/minilib');
const MODEL = readFileSync(resolve(MINI, 'mini-model.mpd'), 'utf8');
const parts = new MapLibrary(new Map());

describe('reading an LDraw model', () => {
  it('flattens an .mpd: the first FILE is the model, submodels placed and colored', () => {
    const r = readLDraw(MODEL);
    expect(r.ok).toBe(true);
    expect(r.title).toBe('main');
    expect(r.author).toBe('Test Builder');
    expect(r.parts.map((p) => [p.filename, p.colorCode, p.x])).toEqual([
      ['box2.dat', 4, 0],
      ['oldbox.dat', 1, 40],
      ['glass2.dat', 47, 0],
      ['nothere.dat', 4, 0],
    ]);
  });

  it('takes the first comment as the title, inline geometry, and skips what it can’t read', () => {
    const r = readLDraw('0 My model\r\n0 Author: Me\r\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 a b.dat\r\n1 4 0 0\r\n3 4 0 0 0 1 0 0 0 0 1\r\nx y z\r\n');
    expect(r.title).toBe('My model');
    expect(r.parts.map((p) => p.filename)).toEqual(['a b.dat']);
    expect(r.primitives).toHaveLength(1);
  });

  it('refuses submodels that nest without end', () => {
    let text = '0 FILE m0.ldr\n';
    for (let i = 0; i < 40; i++) text += `1 16 0 0 0 1 0 0 0 1 0 0 0 1 m${i + 1}.ldr\n0 FILE m${i + 1}.ldr\n`;
    text += '1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n';
    const r = readLDraw(text);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('too large or its submodels nest too deeply');
  });
});

describe('fetching the files a model uses', () => {
  it('fetches the parts, then what they use, a round at a time; the model’s own files first', async () => {
    const src = new FolderLibrary(MINI);
    const files = new LDrawFiles(src, new Map([['glass2.dat', '0 my own glass\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 stud.dat\n']]));
    const seen: number[] = [];
    await files.load(['box2.dat', 'BOX2.DAT', 'glass2.dat', 'nothere.dat'], { onProgress: (p) => seen.push(p.done) });
    expect(src.requests).toBe(2); // box2 + nothere, then s\box2s01 + stud
    expect(files.get('s/box2s01.dat')).toContain('top');
    expect(files.get('glass2.dat')).toContain('my own glass');
    expect(files.has('nothere.dat')).toBe(false);
    expect(seen.at(-1)).toBe(4);
    expect(refKey(' S\\Box2s01.DAT ')).toBe('s/box2s01.dat');
    expect(subfileOf('1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\x y.dat')).toBe('s\\x y.dat');
    expect(subfileOf('2 24 0 0 0 1 1 1')).toBeNull();
  });

  it('follows "~Moved to" stubs back to earlier numbers', async () => {
    const moved = await new FolderLibrary(MINI).moved();
    expect(moved).toEqual({ box2: ['oldbox'] });
    expect(formerNames({ a: ['b'], b: ['c'] }, 'A.DAT')).toEqual(['b', 'c']);
  });

  it('refuses a part that refers to itself, rather than running forever', async () => {
    const files = new LDrawFiles(new FolderLibrary(MINI));
    await files.load(['loop.dat']);
    const loader = new MeshLoader(files, new Palette());
    expect(() => loader.loadPart('loop.dat')).toThrow(SubfileLoop);
  });
});

describe('colors', () => {
  it('reads LDConfig’s colors, with ALPHA; codes it lacks come from the bundled table', () => {
    const p = Palette.fromLDConfig(readFileSync(resolve(MINI, 'LDConfig.ldr'), 'utf8'));
    expect(p.color(4)).toEqual({ r: 0xc9, g: 0x1a, b: 0x09, a: 255 });
    expect(p.color(47)).toEqual({ r: 0xfc, g: 0xfc, b: 0xfc, a: 128 });
    expect(p.color(14)).toEqual(bundledColor(14));
    expect(bundledColor(36).a).toBe(160);
    expect(bundledColor(99999)).toEqual({ r: 180, g: 180, b: 180, a: 255 });
  });

  it('blends as the desktop does (premultiplied, rounded)', () => {
    expect(packPremul(255, 0, 0, 128)).toBe(0x80800000);
    expect(over(0xff0000ff, packPremul(255, 255, 255, 128), 127)).toBe(0xff8080ff);
  });
});

describe('the picture', () => {
  it('draws the model at 32 px a stud, its base on the stud grid, and counts what’s missing', async () => {
    const part = await prepareLDraw('mini-model.mpd', MODEL, { source: new FolderLibrary(MINI), parts });
    expect(part.error).toBe('');
    // box2 at 0 and the moved one 40 LDU (2 studs) along: 4 x 2 studs.
    expect([part.widthStuds, part.heightStuds]).toEqual([4, 2]);
    expect(part.sprite!.width).toBe(128);
    expect(part.sprite!.height).toBe(64);
    expect(part.baseOnGrid).toBe(true);
    expect(part.snapMargin).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
    expect(part.stats).toEqual({ ldrawResolved: 3, lddRendered: 0, unresolved: 1 });
    expect(part.warnings).toEqual([
      '1 part(s) aren’t in your LDraw library, so they’re left out of the picture: nothere.dat.',
      'A newer LDraw library, set in Settings › Bringing in models, may have them.',
    ]);
    const rgba = toRgba(part.sprite!);
    // The red box's middle (lit from above: 0.85 + 0.15), the glass over it blended.
    const at = (x: number, y: number) => [...rgba.slice((y * 128 + x) * 4, (y * 128 + x) * 4 + 4)];
    expect(at(2, 32)[3]).toBe(255);
    expect(at(100, 32)[3]).toBe(255);
    expect(suggestedImportName(part)).toBe('main');
    expect(importedPartKey('Loop v1.5 & co.ldr')).toBe('Loop_v1.5_co');
    expect(completeBaseName('a/b.c.ldr')).toBe('b.c');
  });

  it('says so when nothing in the model has geometry', async () => {
    const part = await prepareLDraw('x.ldr', '1 4 0 0 0 1 0 0 0 1 0 0 0 1 nothere.dat\n', { source: new FolderLibrary(MINI), parts });
    expect(part.error).toContain('no geometry');
    expect(part.stats.unresolved).toBe(1);
  });

  it('finds the bottom layer’s lattice only for whole studs', () => {
    const flat = (w: number, h: number) => ({
      tri: new Float64Array([0, 0, 0, w, 0, 0, w, 0, h, 0, 0, 0, w, 0, h, 0, 0, h]),
      triColor: new Uint32Array([0xff0000ff, 0xff0000ff]),
      edge: new Float64Array(),
      edgeColor: new Uint32Array(),
    });
    expect(baseLattice(flat(40, 60))).toEqual({ x: 0, y: 0, width: 2, height: 3 });
    expect(baseLattice(flat(30, 60))).toBeNull();
    const r = rasterizeMeshTopDown(flat(30, 60));
    expect([r.spriteStuds.width, r.spriteStuds.height, r.baseOnGrid]).toEqual([2, 3, false]);
  });

  it('words its warnings as the desktop does, each part once', () => {
    expect(friendlyImportWarnings(['Unresolved part a.dat', 'Unresolved subfile A.DAT', 'Could not open x', 'Could not open x', 'other'], false)).toEqual([
      '1 part(s) aren’t in your LDraw library, so they’re left out of the picture: a.dat (2 times).',
      'A newer LDraw library, set in Settings › Bringing in models, may have them.',
      'Couldn’t open x. (2 times)',
      'other',
    ]);
    const many = Array.from({ length: 10 }, (_, i) => `Unresolved part p${i}.dat`);
    expect(friendlyImportWarnings(many, true)[0]).toContain('p7.dat and 2 more.');
  });
});

describe('the part', () => {
  const img = (w: number, h: number, fill: (x: number, y: number) => number): Image => {
    const px = new Uint32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = fill(x, y);
    return { width: w, height: h, px };
  };

  it('turns the picture by whole pixels', () => {
    const a = img(3, 2, (x, y) => y * 3 + x + 1);
    expect([...rotateImage(a, 1).px]).toEqual([4, 1, 5, 2, 6, 3]);
    expect([...rotateImage(a, 2).px]).toEqual([6, 5, 4, 3, 2, 1]);
    expect([...rotateImage(rotateImage(a, 1), 3).px]).toEqual([...a.px]);
  });

  it('turns and lines up the numbers as the preview does', async () => {
    const part = await prepareLDraw('mini-model.mpd', MODEL, { source: new FolderLibrary(MINI), parts });
    const turned = rotatePart(part, 1);
    expect([turned.widthStuds, turned.heightStuds, turned.sprite!.width]).toEqual([2, 4, 64]);
    const nudged = alignPart(turned, '', { x: 0.25, y: 0 });
    expect([nudged.widthStuds, nudged.heightStuds]).toEqual([3, 4]);
    expect(nudged.sprite!.width).toBe(96);
    // A quarter stud is 8 px: the picture moved by whole pixels.
    expect(nudged.sprite!.px[8]).toBe(turned.sprite!.px[0]);
  });

  it('writes the part XML as the desktop does', async () => {
    const part = await prepareLDraw('mini-model.mpd', MODEL, { source: new FolderLibrary(MINI), parts });
    const made = convertPart(
      part,
      { quarterTurns: 1, align: 'box', nudge: [0.25, -0.125], drop: [], name: 'Mini & <co>', designer: 'Robin', designerUrl: 'example.com', author: 'Sam' },
      { name: 'mini-model.mpd', lastModified: Date.UTC(2026, 10, 19, 12, 0, 0, 5), format: 'ldraw' },
      '2026-11-19',
    );
    expect(made.partKey).toBe('Mini_co_');
    expect(made.displayName).toBe('Mini & <co>');
    const lines = made.xml.split('\n');
    expect(lines.slice(0, 18)).toEqual([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<part>',
      '  <Author>Sam</Author>',
      '  <Description>',
      '    <en>Mini &amp; &lt;co&gt;</en>',
      '  </Description>',
      '  <PixelsPerStud>32</PixelsPerStud>',
      '  <ImportedFrom file="mini-model.mpd" format="ldraw" date="2026-11-19"/>',
      '  <Designer url="https://example.com">Robin</Designer>',
      '  <ImportSource>',
      '    <SourcePath>mini-model.mpd</SourcePath>',
      '    <SourceModified>2026-11-19T12:00:00.005Z</SourceModified>',
      '    <QuarterTurns>1</QuarterTurns>',
      '    <Align>box</Align>',
      '    <Nudge x="0.2500" y="-0.1250"/>',
      '  </ImportSource>',
      '  <PickShape>',
      '    <ring>',
    ]);
    expect(made.xml.endsWith('  </SnapMargin>\n</part>\n')).toBe(true);
  });

  it('formats numbers as Qt does', () => {
    expect(fixed(-0, 4)).toBe('-0.0000');
    expect(fixed(-0.00001, 4)).toBe('-0.0000');
    expect(fixed(1.23456, 2)).toBe('1.23');
    expect(g6(-26.75)).toBe('-26.75');
    expect(g6(0.5)).toBe('0.5');
    expect(g6(1234567)).toBe('1.23457e+06');
    expect(g6(0.00001)).toBe('1e-05');
    expect(g6(100)).toBe('100');
  });

  it('traces the outline of the cells that show, and simplifies it', () => {
    // An L of three cells.
    const rings = traceCells(new Uint8Array([1, 0, 1, 1]), 2, 2);
    expect(rings).toEqual([
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 2, y: 1 },
        { x: 2, y: 2 },
        { x: 0, y: 2 },
      ],
    ]);
    // A hole is its own ring.
    expect(traceCells(new Uint8Array([1, 1, 1, 1, 0, 1, 1, 1, 1]), 3, 3)).toHaveLength(2);
    expect(simplifyRing([{ x: 0, y: 0 }, { x: 1, y: 0.1 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }], 0.35)).toHaveLength(4);
  });

  it('writes no ImportSource details that aren’t there', () => {
    const xml = partXml({ author: '', displayName: '', sourceFile: 'a.ldr', format: 'ldraw', sourceModified: null, date: 'd', pxPerStud: 8, quarterTurns: 0, align: '', nudge: { x: 0, y: 0 }, droppedConnections: [], designer: '', designerUrl: '', connections: [], pickShape: [], snapMargin: { left: 1, top: 0, right: 0, bottom: 0 } });
    expect(xml).toContain('<Author>Collaborative Brick Layout Designer import</Author>');
    expect(xml).toContain('<en>a</en>');
    expect(xml).not.toContain('PixelsPerStud');
    expect(xml).not.toContain('SourceModified');
    expect(xml).toContain('<left>1</left>');
  });
});
