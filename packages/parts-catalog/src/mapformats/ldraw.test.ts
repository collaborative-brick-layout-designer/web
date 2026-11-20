// LDraw .ldr / .mpd against vanilla BlueBrick (desktop LDrawMapTest.cpp):
// tight-corner.ldr/.mpd are what vanilla wrote for tight-corner.bbm, and
// tight-corner.from-*.bbm what it read back from them.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readBbm, writeBbm } from '@cld/bbm';
import type { LayerRuler } from '@cld/model';
import { rebuildConnectivity } from '../connectivity.js';
import { scanCatalog } from '../scan.js';
import { readLDrawMap, writeLDrawMap } from './ldraw.js';
import { readFourDBrixMap } from './fourDBrix.js';
import { MapLibrary, makeId, newBrickLayer, newGridLayer, newMap } from './library.js';
import { bricksOf, oracleMap, oracleText, PARTS, ROOT, unmatched } from './oracleUtil.js';

const corpus = (name: string) => readBbm(readFileSync(resolve(ROOT, 'packages/bbm/tests/fixtures', name), 'utf8')).map;

describe.skipIf(!existsSync(PARTS))('LDraw maps match vanilla BlueBrick', () => {
  let lib: MapLibrary;
  beforeAll(async () => {
    lib = new MapLibrary((await scanCatalog(PARTS)).catalog);
  }, 60_000);

  /**
   * Lines of an LDraw file, minus BlueBrick's file-name header (the
   * oracle's map was unnamed) and parts the library doesn't have (their
   * placeholder geometry is BlueBrick-specific).
   */
  const comparableLines = (text: string) => {
    const out: string[] = [];
    for (const raw of text.split('\n')) {
      const line = raw.replaceAll('\r', '');
      if (line.startsWith('0 FILE ') && out.length === 0) continue;
      if (line.startsWith('0 Name: ')) continue;
      if (out.length === 0 && line.startsWith('0 ') && !line.includes(':')) continue;
      if (line.startsWith('1 ')) {
        const tokens = line.split(' ');
        const part = tokens.slice(14).join(' ').slice(0, -4);
        if (!lib.meta(`${part}.${tokens[1]}`) && !lib.meta(part)) continue;
      }
      out.push(line);
    }
    return out;
  };

  // sleepers.bbm: rails with LDraw sleepers (one raised), angle and
  // translation remaps, and a hidden layer.
  const sources = { 'tight-corner': () => corpus('tight-corner.bbm'), sleepers: () => oracleMap('sleepers.bbm') };
  for (const [name, source] of Object.entries(sources)) {
    for (const ext of ['ldr', 'mpd']) {
      it(`writes the ${name}.${ext} vanilla wrote`, () => {
        const map = source();
        rebuildConnectivity(map, lib.catalog); // sleepers depend on the links
        const ours = writeLDrawMap(map, lib, `${name}.${ext}`);
        expect(ours).toContain('\r\n');
        expect(comparableLines(ours)).toEqual(comparableLines(oracleText(`${name}.${ext}`)));
      });

      it(`reads the ${name}.${ext} as vanilla did`, () => {
        const vanilla = oracleMap(`${name}.from-${ext}.bbm`);
        const ours = readLDrawMap(oracleText(`${name}.${ext}`), lib, { mpd: ext === 'mpd' });
        // BlueBrick drops parts with a space in their name when reading LDraw.
        const noSpace = (pn: string) => !pn.includes(' ');
        expect(unmatched(bricksOf(ours.map, noSpace), bricksOf(vanilla, noSpace))).toBe('');
        // Vanilla also keeps an empty layer for the .mpd main model, and names
        // .ldr layers with a global counter: compare the filled layers, and
        // .mpd names (which come from the file).
        const filled = (m: typeof vanilla) =>
          m.layers.filter((l) => l.type === 'brick' && l.bricks.length > 0).map((l) => [ext === 'mpd' ? l.name : '', l.visible]);
        expect(filled(ours.map)).toEqual(filled(vanilla));
      });
    }
  }

  it('keeps every brick through a round trip', () => {
    const map = corpus('fordyce-2026.bbm');
    const back = readLDrawMap(writeLDrawMap(map, lib, 'fordyce.mpd'), lib, { mpd: true });
    // Parts the library lacks come back with a placeholder size, and parts
    // without a numeric color aren't written (as in BlueBrick).
    const writable = (pn: string) => /^\d+$/.test(pn.slice(pn.lastIndexOf('.') + 1)) && !!lib.meta(pn);
    expect(unmatched(bricksOf(back.map, writable), bricksOf(map, writable), false)).toBe('');
  });

  it('keeps groups, rulers, hidden layers and the header', () => {
    const map = newMap();
    Object.assign(map, { author: 'Ann', lug: 'LUG X', event: 'Show', comment: 'one\ntwo', date: { day: 4, month: 7, year: 2025 } });
    const bricks = newBrickLayer('Track');
    bricks.visible = false;
    const group = { id: makeId(), partNumber: 'MYSET', myGroup: '' };
    for (let i = 0; i < 2; i++) {
      const b = lib.newBrick(lib.meta('2865.8')!);
      b.displayArea = { x: i * 16 - 8, y: -4, width: 16, height: 8 };
      b.myGroup = group.id;
      bricks.bricks.push(b);
    }
    bricks.groups.push(group);
    const common = {
      myGroup: '',
      color: { kind: 'argb', argb: 'ff00ff40' },
      lineThickness: 1,
      displayDistance: true,
      displayUnit: true,
      guidelineColor: { kind: 'known', name: 'Black' },
      guidelineThickness: 1,
      unit: 0,
      measureFont: { family: 'Microsoft Sans Serif', size: 8.25, style: 'Regular' },
      measureFontColor: { kind: 'known', name: 'Red' },
    } as const;
    const rulers: LayerRuler = {
      ...newBrickLayer('Rulers'),
      type: 'ruler',
      rulerItems: [
        { ...common, id: makeId(), kind: 'linear', displayArea: { x: 1, y: 2, width: 29, height: 0 }, guidelineDashPattern: [2, 4], point1: { x: 1, y: 2 }, point2: { x: 30, y: 2 }, attachedBrick1Id: '', attachedBrick2Id: '', offsetDistance: -4, allowOffset: true },
        // An empty dash pattern, which BlueBrick writes as nothing at all.
        { ...common, id: makeId(), kind: 'circular', displayArea: { x: 5, y: 5, width: 10, height: 10 }, guidelineDashPattern: [], displayDistance: false, center: { x: 10, y: 10 }, radius: 5, attachedBrickId: '' },
      ],
      groups: [],
    };
    map.layers.push(bricks, rulers, newGridLayer());

    for (const name of ['small.ldr', 'small.mpd']) {
      const text = writeLDrawMap(map, lib, name);
      expect(text).toContain('0 // Grid layer not implemented yet');
      const back = readLDrawMap(text, lib, { mpd: name.endsWith('.mpd') }).map;
      expect(back.layers.map((l) => l.type), name).toEqual(['brick', 'ruler']);
      expect(back).toMatchObject({ author: 'Ann', lug: 'LUG X', event: 'Show', date: { day: 4, month: 7, year: 2025 } });
      // The "not implemented" comment for the grid comes back too, as in BlueBrick.
      expect(back.comment).toBe('one\ntwo\nGrid layer not implemented yet, see you maybe in BB 1.9\n');
      const bl = back.layers[0]!;
      if (bl.type !== 'brick') throw new Error('brick layer');
      expect(bl.visible).toBe(false);
      expect(bl.bricks).toHaveLength(2);
      expect(bl.groups).toEqual([{ id: expect.any(String), partNumber: 'MYSET', myGroup: '' }]);
      expect(bl.bricks.map((b) => b.myGroup)).toEqual([bl.groups[0]!.id, bl.groups[0]!.id]);
      const rl = back.layers[1]!;
      if (rl.type !== 'ruler') throw new Error('ruler layer');
      const [lin, circ] = rl.rulerItems;
      expect(lin).toMatchObject({ kind: 'linear', point1: { x: 1, y: 2 }, point2: { x: 30, y: 2 }, offsetDistance: -4, allowOffset: true, guidelineDashPattern: [2, 4], color: { kind: 'argb', argb: 'ff00ff40' }, measureFontColor: { kind: 'known', name: 'Red' } });
      expect(circ).toMatchObject({ kind: 'circular', center: { x: 10, y: 10 }, radius: 5, displayDistance: false, guidelineDashPattern: [], displayArea: { x: 5, y: 5, width: 10, height: 10 } });
    }
  });

  it('skips ignorable parts and submodel references, and counts unknown parts', () => {
    const text = [
      '0 Untitled',
      '1 0 0 0 0 1 0 0 0 1 0 0 0 1 NOSUCHPART.DAT',
      '1 0 0 0 0 1 0 0 0 1 0 0 0 1 other.ldr',
      // A sleeper plate: an XML without an image.
      '1 15 0 0 0 1 0 0 0 1 0 0 0 1 3034.dat',
      '1 8 40 -24 60 1 0 0 0 1 0 0 0 1 s\\2865.dat',
    ].join('\n');
    expect(lib.meta('3034.15')?.spritePath).toBe('');
    const r = readLDrawMap(text, lib, { mpd: false });
    expect(r.warnings).toEqual(["1 part(s) aren't in your parts library, so they were left out."]);
    const l = r.map.layers[0]!;
    if (l.type !== 'brick') throw new Error('brick layer');
    expect(l.name).toBe('Layer 1');
    // Sorted by altitude; the unknown part gets a 2x2 placeholder.
    expect(l.bricks.map((b) => [b.partNumber, b.altitude])).toEqual([['2865.8', -24], ['NOSUCHPART.0', 0]]);
    expect(l.bricks[1]!.displayArea).toEqual({ x: -1, y: -1, width: 2, height: 2 });
    const centre = lib.imageCentre(l.bricks[0]!);
    expect(centre.x).toBeCloseTo(2);
    expect(centre.y).toBeCloseTo(-3);
  });

  it('puts one sleeper per joint, and a plate beats a grey 12V sleeper', () => {
    // No library part uses the grey 767 sleeper, so make two: copies of a
    // 12V straight with the grey sleeper.
    const rail = lib.meta('3228AC02.1')!;
    const catalog = new Map(lib.catalog);
    for (const pn of ['GREYA', 'GREYB']) {
      catalog.set(`${pn.toLowerCase()}.1`, { ...rail, key: `${pn.toLowerCase()}.1`, partNumber: pn, ldraw: { ...rail.ldraw!, sleeper: '767.7' } });
    }
    const grey = new MapLibrary(catalog);
    const chain = (parts: string[]) => {
      const bricks = parts.map((pn) => grey.newBrick(grey.meta(pn)!));
      bricks.forEach((b, i) => {
        if (i === 0) grey.placeByImageCentre(b, { x: 0, y: 0 });
        else grey.placeByConnection(b, 0, grey.connectionWorld(bricks[i - 1]!, 1));
      });
      const map = newMap();
      map.layers.push(newBrickLayer('Rails', bricks));
      rebuildConnectivity(map, catalog);
      const text = writeLDrawMap(map, grey, 'rails.ldr');
      return ['767', '3034'].map((pn) => text.split('\n').filter((l) => l.endsWith(` ${pn}.DAT\r`)).length);
    };
    // Two grey rails: 3 ends, one grey sleeper each.
    expect(chain(['GREYA.1', 'GREYB.1'])).toEqual([3, 0]);
    // Grey then plain: the joint gets the plain rail's plate.
    expect(chain(['GREYA.1', '3228AC02.1'])).toEqual([1, 2]);
    // Plain then grey: the plate is already there.
    expect(chain(['3228AC02.1', 'GREYA.1'])).toEqual([1, 2]);
  });

  it('reads numbers out of range as 0, so the map can be saved', () => {
    const r = readLDrawMap('1 8 1e999 -24 60 1 0 0 0 1 0 0 0 1 2865.dat', lib, { mpd: false });
    const l = r.map.layers[0]!;
    if (l.type !== 'brick') throw new Error('brick layer');
    expect(lib.imageCentre(l.bricks[0]!).x).toBeCloseTo(0);
    expect(() => writeBbm(r.map)).not.toThrow();
  });

  it('reads a hostile number in linear time (no regex backtracking blow-up)', () => {
    const t = performance.now();
    readLDrawMap(`1 8 ${'9'.repeat(50_000)}x 0 0 1 0 0 0 1 0 0 0 1 2865.dat`, lib, { mpd: false });
    readFourDBrixMap(`<data><node><coordinates x="${'9'.repeat(50_000)}x" y="0" z="0"/></node></data>`, lib);
    expect(performance.now() - t).toBeLessThan(500);
  });
});

