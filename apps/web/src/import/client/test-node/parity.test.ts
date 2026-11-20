// @vitest-environment node
//
// The browser importer against the desktop's converter, on the same files
// and choices (opt-in: the LDraw library and the converter aren't in the
// repo).
//   BLD_LDRAW_LIBRARY  an LDraw library (library.ldraw.org complete.zip, unpacked)
//   BLD_IMPORT_SERVER  bld-import-server (desktop release asset, v2.1.11 or later)
//   BLD_PARTS_DIR      BlueBrick parts (default: the repo's parts-library/parts)
//   BLD_PARITY_MODELS  more folders of .ldr / .mpd models, colon-separated (optional)
// The models are this folder's fixtures plus the library's own models/.
//
// What must match exactly: the footprint, the model's bounds, whether its
// base is on the grid, the snap margin, the connection points, the counts,
// the warnings, the title, designer and suggested name. The picture must be
// the same size; its see-through mask may differ at the edges (the
// rasterizer is the same, Qt's smooth shrink isn't quite a box filter):
// the masks' intersection over union is at least 0.98, and where both
// show, colors differ by at most 2/255 on average (one channel at a pixel
// may differ more, at an edge). The made part's XML matches line for line
// but for the date, the source path and time (the server's own), and the
// <PickShape> (Qt simplifies the outline its own way): the same number of
// rings, covering the same area within 2%.

import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { scanCatalog } from '@cld/parts-catalog';
import { MapLibrary } from '@cld/parts-catalog/browser';
import { readBbm } from '@cld/bbm';
import { convertPart, type ConvertChoices } from '../convert';
import { isLayoutFile, layoutBbm, readLayout } from '../layout';
import { importedPartKey, prepareLDraw, suggestedImportName } from '../prepare';
import { toRgba } from '../rasterize';
import { prepareModel } from '../prepareModel';
import { makeIo, type IoEntry } from './makeIo';
import { compareImages, FolderLdd, FolderLibrary, readPng, runConverter } from './nodeHelpers';

const LIB = process.env.BLD_LDRAW_LIBRARY ?? '';
const CONVERTER = process.env.BLD_IMPORT_SERVER ?? '';
const PARTS = process.env.BLD_PARTS_DIR ?? resolve(__dirname, '../../../../../../parts-library/parts');
const FIXTURES = resolve(__dirname, 'fixtures');
const enabled = !!LIB && !!CONVERTER && existsSync(LIB) && existsSync(CONVERTER) && existsSync(PARTS);

/** The converter's JSON, read loosely. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

export const IOU_MIN = 0.995;
export const MEAN_RGB_MAX = 2;

function models(): string[] {
  const own = readdirSync(FIXTURES).filter((f) => /\.(ldr|mpd|dat)$/i.test(f)).map((f) => join(FIXTURES, f));
  const lib = existsSync(join(LIB, 'models')) ? readdirSync(join(LIB, 'models')).filter((f) => /\.ldr$/i.test(f)).map((f) => join(LIB, 'models', f)) : [];
  const extra = (process.env.BLD_PARITY_MODELS ?? '').split(':').filter(Boolean).flatMap((d) => (existsSync(d) ? readdirSync(d).filter((f) => /\.(ldr|mpd)$/i.test(f)).map((f) => join(d, f)) : []));
  return [...own, ...lib, ...extra];
}

describe.skipIf(!enabled)('browser import matches the desktop converter', () => {
  let parts: MapLibrary;
  const source = new FolderLibrary(LIB);
  beforeAll(async () => {
    parts = new MapLibrary((await scanCatalog(PARTS)).catalog);
  }, 120_000);

  const CHOICES: [string, ConvertChoices][] = [
    ['track-line.ldr', { quarterTurns: 1, align: 'box', nudge: [0.25, -0.125], drop: [1], name: 'Loop & <Co> "x"', designer: 'Sam > Rail', designerUrl: 'example.com/sam', author: 'Tester' }],
    ['baseplate.ldr', { quarterTurns: 0, align: '', nudge: [0, 0], drop: [], name: '', designer: '', designerUrl: '', author: '' }],
    ['baseplate.ldr', { quarterTurns: 3, align: 'bottom', nudge: [-0.5, 0.0625], drop: [], name: 'Base v1.5', designer: 'A', designerUrl: 'https://a.example', author: 'B' }],
    ['car.ldr', { quarterTurns: 2, align: 'box', nudge: [0, 0], drop: [], name: 'Car', designer: '', designerUrl: 'ignored.example', author: 'C' }],
    ['nested.mpd', { quarterTurns: 1, align: 'bottom', nudge: [0.125, 0.125], drop: [], name: '', designer: 'Nest', designerUrl: '', author: 'D' }],
  ];
  const ringArea = (r: { x: number; y: number }[]) => Math.abs(r.reduce((a, p, i) => a + p.x * r[(i + 1) % r.length]!.y - r[(i + 1) % r.length]!.x * p.y, 0)) / 2;
  const pickRings = (xml: string) =>
    [...xml.matchAll(/<ring>([\s\S]*?)<\/ring>/g)].map((m) => [...m[1]!.matchAll(/<x>([^<]+)<\/x>\s*<y>([^<]+)<\/y>/g)].map((q) => ({ x: Number(q[1]), y: Number(q[2]) })));
  const comparable = (xml: string) =>
    xml
      .replace(/ date="[^"]*"/, '')
      .replace(/ *<SourcePath>[^<]*<\/SourcePath>\n/, '')
      .replace(/<PickShape>[\s\S]*<\/PickShape>\n/, '');

  for (const [file, choices] of enabled ? CHOICES : []) {
    it(`makes ${file} into a part as the converter does (${choices.quarterTurns} turns, ${choices.align || 'automatic'}, nudge ${choices.nudge})`, async () => {
      const model = models().find((m) => m.endsWith(`/${file}`))!;
      const conv = runConverter(
        CONVERTER,
        { command: 'convert', libraries: { parts: [PARTS], ldraw: LIB }, options: { mode: 'part', ...choices } },
        model,
      );
      const want = conv.json as Json;
      expect(want.ok, JSON.stringify(want)).toBe(true);
      const prepared = await prepareLDraw(file, readFileSync(model, 'utf8'), { source, parts });
      const made = convertPart(prepared, choices, { name: file, lastModified: Math.floor(statSync(model).mtimeMs), format: 'ldraw' });
      expect({ key: made.partKey, name: made.displayName, w: made.widthStuds, h: made.heightStuds, c: made.connections }).toEqual({
        key: want.partKey,
        name: want.displayName,
        w: want.widthStuds,
        h: want.heightStuds,
        c: want.connections,
      });
      const wantXml = conv.files.get(want.xml)!.toString('utf8');
      expect(comparable(made.xml)).toBe(comparable(wantXml));
      const ringsWant = pickRings(wantXml);
      const ringsGot = pickRings(made.xml);
      if (process.env.BLD_PARITY_LOG) console.log(file, 'pick exact', JSON.stringify(ringsGot) === JSON.stringify(ringsWant));
      expect(ringsGot.length).toBe(ringsWant.length);
      const areaWant = ringsWant.reduce((a, r) => a + ringArea(r), 0);
      const areaGot = ringsGot.reduce((a, r) => a + ringArea(r), 0);
      if (process.env.BLD_PARITY_LOG) console.log(file, 'pick area', areaGot, areaWant, ringsGot.map((r) => r.length), ringsWant.map((r) => r.length));
      expect(Math.abs(areaGot - areaWant) / areaWant).toBeLessThanOrEqual(0.02);
      const png = readPng(conv.files.get(want.sprite)!);
      const cmp = compareImages({ width: made.sprite.width, height: made.sprite.height, rgba: toRgba(made.sprite) }, png);
      if (process.env.BLD_PARITY_LOG) console.log(file, 'sprite', JSON.stringify(cmp));
      expect(cmp.sameSize).toBe(true);
      expect(cmp.iou).toBeGreaterThanOrEqual(IOU_MIN);
      expect(cmp.meanRgb).toBeLessThanOrEqual(MEAN_RGB_MAX);
    }, 120_000);
  }

  const bricks = (bbm: string) =>
    readBbm(bbm).map.layers.flatMap((l) =>
      l.type === 'brick'
        ? l.bricks.map((b) => [l.name, b.partNumber, b.displayArea.x.toFixed(4), b.displayArea.y.toFixed(4), b.displayArea.width.toFixed(4), b.displayArea.height.toFixed(4), b.orientation.toFixed(3), b.altitude.toFixed(3), b.connexions.filter((c) => c.linkedTo).length].join(' '))
        : [`${l.type} ${l.name}`],
    );

  for (const file of enabled ? ['track-line.ldr', 'baseplate.ldr', 'nested.mpd', 'car.ldr', 'missing.ldr'] : []) {
    it(`places ${file}'s parts one by one as the converter does`, async () => {
      const model = models().find((m) => m.endsWith(`/${file}`))!;
      const conv = runConverter(CONVERTER, { command: 'convert', libraries: { parts: [PARTS], ldraw: LIB }, options: { mode: 'parts' } }, model);
      const want = conv.json as Json;
      expect(want.ok, JSON.stringify(want)).toBe(true);
      const { map, summary } = readLayout(file, readFileSync(model, 'utf8'), parts);
      expect({ sheets: summary.sheets, bricks: summary.bricks, warnings: summary.warnings }).toEqual({ sheets: want.sheets, bricks: want.bricks, warnings: want.warnings });
      expect(bricks(layoutBbm(map))).toEqual(bricks(conv.files.get(want.bbm)!.toString('utf8')));
    }, 120_000);
  }

  for (const model of enabled ? models() : []) {
    it(`analyses ${model.split('/').pop()} as the converter does`, async () => {
      const name = model.split('/').pop()!;
      const conv = runConverter(CONVERTER, { command: 'analyse', libraries: { parts: [PARTS], ldraw: LIB }, options: {} }, model);
      const want = conv.json as Json;
      expect(want.ok, JSON.stringify(want)).toBe(true);
      const got = await prepareLDraw(name, readFileSync(model, 'utf8'), { source, parts });
      expect(got.title).toBe(want.title);
      expect(got.designer).toBe(want.designer);
      expect(suggestedImportName(got)).toBe(want.suggestedName);
      expect(importedPartKey(suggestedImportName(got))).toBe(want.partKey);
      if (isLayoutFile(name)) {
        const mine = readLayout(name, readFileSync(model, 'utf8'), parts).summary;
        expect(mine).toEqual(want.layout);
      }
      if (!want.part) {
        expect(got.error).not.toBe('');
        return;
      }
      const w = want.part;
      expect(got.error).toBe('');
      expect({ w: got.widthStuds, h: got.heightStuds, base: got.baseOnGrid, margin: got.snapMargin }).toEqual({ w: w.widthStuds, h: w.heightStuds, base: w.baseOnGrid, margin: w.snapMargin });
      for (const k of ['x', 'y', 'width', 'height'] as const) expect(got.contentStuds[k]).toBeCloseTo(w.contentStuds[k], 6);
      expect(got.stats).toEqual(w.stats);
      expect(got.warnings).toEqual(w.warnings);
      expect(got.connections.length).toBe(w.connections.length);
      got.connections.forEach((c, i) => {
        const e = w.connections[i];
        expect(c.type).toBe(e.type);
        expect(c.x).toBeCloseTo(e.x, 4);
        expect(c.y).toBeCloseTo(e.y, 4);
        expect(c.angle).toBeCloseTo(e.angle, 4);
      });
      const png = readPng(conv.files.get('preview.png')!);
      const mine = { width: got.sprite!.width, height: got.sprite!.height, rgba: toRgba(got.sprite!) };
      const cmp = compareImages(mine, png);
      if (process.env.BLD_PARITY_LOG) console.log(name, JSON.stringify({ size: [mine.width, mine.height], conns: got.connections.length, stats: got.stats, warnings: got.warnings.length, ...cmp }));
      expect(cmp.sameSize, `${mine.width}×${mine.height} vs ${png.width}×${png.height}`).toBe(true);
      expect(cmp.iou, JSON.stringify(cmp)).toBeGreaterThanOrEqual(IOU_MIN);
      expect(cmp.meanRgb, JSON.stringify(cmp)).toBeLessThanOrEqual(MEAN_RGB_MAX);
    }, 120_000);
  }
});

// The same check on this folder's tiny library: only the converter needed.
const MINI = resolve(__dirname, 'fixtures/minilib');
describe.skipIf(!CONVERTER || !existsSync(CONVERTER) || !existsSync(PARTS))('browser import matches the converter on the tiny library', () => {
  it('analyses and makes mini-model.mpd as the converter does', async () => {
    const parts = new MapLibrary((await scanCatalog(PARTS)).catalog);
    const model = join(MINI, 'mini-model.mpd');
    const text = readFileSync(model, 'utf8');
    const want = runConverter(CONVERTER, { command: 'analyse', libraries: { parts: [PARTS], ldraw: MINI }, options: {} }, model).json as Json;
    const got = await prepareLDraw('mini-model.mpd', text, { source: new FolderLibrary(MINI), parts });
    expect({ w: got.widthStuds, h: got.heightStuds, stats: got.stats, warnings: got.warnings, base: got.baseOnGrid }).toEqual({
      w: want.part.widthStuds,
      h: want.part.heightStuds,
      stats: want.part.stats,
      warnings: want.part.warnings,
      base: want.part.baseOnGrid,
    });
    const choices: ConvertChoices = { quarterTurns: 3, align: 'box', nudge: [0.5, 0.25], drop: [], name: 'Mini', designer: 'T', designerUrl: '', author: 'U' };
    const conv = runConverter(CONVERTER, { command: 'convert', libraries: { parts: [PARTS], ldraw: MINI }, options: { mode: 'part', ...choices } }, model);
    const made = convertPart(got, choices, { name: 'mini-model.mpd', lastModified: Math.floor(statSync(model).mtimeMs), format: 'ldraw' });
    const strip = (x: string) => x.replace(/ date="[^"]*"/, '').replace(/ *<SourcePath>[^<]*<\/SourcePath>\n/, '');
    expect(strip(made.xml)).toBe(strip(conv.files.get(String(conv.json.xml))!.toString('utf8')));
    const png = readPng(conv.files.get(String(conv.json.sprite))!);
    const cmp = compareImages({ width: made.sprite.width, height: made.sprite.height, rgba: toRgba(made.sprite) }, png);
    expect(cmp.sameSize).toBe(true);
    expect(cmp.iou).toBeGreaterThanOrEqual(IOU_MIN);
    expect(cmp.meanRgb).toBeLessThanOrEqual(MEAN_RGB_MAX);
  }, 120_000);
});

// Studio .io files: the fixtures packed as Studio 2.1 packs them (ZipCrypto,
// Studio's password), one with its own custom part, read by both.
describe.skipIf(!CONVERTER || !existsSync(CONVERTER) || !existsSync(PARTS))('Studio files in the browser match the converter', () => {
  const work = mkdtempSync(join(tmpdir(), 'cbld-io-parity-'));
  const CUSTOM = '0 My plate\n4 16 -20 -8 -20 20 -8 -20 20 -8 20 -20 -8 20\n1 16 0 -8 0 1 0 0 0 1 0 0 0 1 stud.dat\n';
  const cases: { name: string; lib: string; entries: IoEntry[] }[] = [
    {
      name: 'Mini city.io',
      lib: MINI,
      entries: [
        { name: 'model.ldr', text: '0 FILE Mini city.io\n0 Author: Studio Builder\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 box2.dat\n1 1 40 0 0 1 0 0 0 1 0 0 0 1 myplate.dat\n0 NOFILE\n' },
        { name: 'CustomParts/myplate.dat', text: CUSTOM },
      ],
    },
  ];
  if (LIB && existsSync(LIB))
    for (const f of ['track-line.ldr', 'baseplate.ldr', 'nested.mpd', 'glass.ldr'])
      cases.push({ name: f.replace(/\.(ldr|mpd)$/, '.io'), lib: LIB, entries: [{ name: 'model.ldr', text: readFileSync(join(FIXTURES, f), 'utf8') }] });

  for (const c of cases) {
    it(`reads, draws and makes ${c.name} as the converter does`, async () => {
      const parts = new MapLibrary((await scanCatalog(PARTS)).catalog);
      const file = join(work, c.name);
      const bytes = makeIo(c.entries);
      writeFileSync(file, bytes);
      const want = runConverter(CONVERTER, { command: 'analyse', libraries: { parts: [PARTS], ldraw: c.lib }, options: {} }, file).json as Json;
      expect(want.ok, JSON.stringify(want)).toBe(true);
      const got = await prepareModel(c.name, bytes, { source: new FolderLibrary(c.lib), parts });
      expect(got.kindLabel).toBe(want.kindLabel);
      expect([got.title, got.designer, suggestedImportName(got)]).toEqual([want.title, want.designer, want.suggestedName]);
      expect({ w: got.widthStuds, h: got.heightStuds, stats: got.stats, warnings: got.warnings, base: got.baseOnGrid, margin: got.snapMargin, n: got.connections.length }).toEqual({
        w: want.part.widthStuds,
        h: want.part.heightStuds,
        stats: want.part.stats,
        warnings: want.part.warnings,
        base: want.part.baseOnGrid,
        margin: want.part.snapMargin,
        n: want.part.connections.length,
      });
      const choices: ConvertChoices = { quarterTurns: 1, align: 'box', nudge: [0.25, 0], drop: [], name: '', designer: 'S', designerUrl: '', author: 'U' };
      const conv = runConverter(CONVERTER, { command: 'convert', libraries: { parts: [PARTS], ldraw: c.lib }, options: { mode: 'part', ...choices } }, file);
      const made = convertPart(got, choices, { name: c.name, lastModified: Math.floor(statSync(file).mtimeMs), format: 'studio' });
      const strip = (x: string) => x.replace(/ date="[^"]*"/, '').replace(/ *<SourcePath>[^<]*<\/SourcePath>\n/, '').replace(/<PickShape>[\s\S]*<\/PickShape>\n/, '');
      expect(strip(made.xml)).toBe(strip(conv.files.get(String(conv.json.xml))!.toString('utf8')));
      const png = readPng(conv.files.get(String(conv.json.sprite))!);
      const cmp = compareImages({ width: made.sprite.width, height: made.sprite.height, rgba: toRgba(made.sprite) }, png);
      if (process.env.BLD_PARITY_LOG) console.log(c.name, JSON.stringify(cmp));
      expect(cmp.sameSize).toBe(true);
      expect(cmp.iou).toBeGreaterThanOrEqual(IOU_MIN);
      expect(cmp.meanRgb).toBeLessThanOrEqual(MEAN_RGB_MAX);
    }, 120_000);
  }
});

// LDD models (opt-in: LDD's brick database is proprietary).
//   BLD_LDD_ROOT  a folder holding LDD's Assets.lif and its ldraw.xml (or BLD_LDD_LDRAW_XML)
// Each fixture is read three ways, as the converter can: from LDD's own
// shapes (with and without the LDraw library, for where track snaps), and,
// without the brick database, as the LDraw model ldraw.xml makes of it.
const LDD_ROOT = process.env.BLD_LDD_ROOT ?? '';
const LDD_XML = process.env.BLD_LDD_LDRAW_XML ?? (LDD_ROOT ? join(LDD_ROOT, 'ldraw.xml') : '');
describe.skipIf(!CONVERTER || !LDD_ROOT || !existsSync(join(LDD_ROOT, 'Assets.lif')) || !existsSync(PARTS))('LDD models in the browser match the converter', () => {
  const work = mkdtempSync(join(tmpdir(), 'cbld-ldd-parity-'));
  const lxf = join(work, 'LDD bricks.lxf');
  writeFileSync(lxf, makeIo([{ name: 'IMAGE100.PNG', bytes: new Uint8Array([1, 2, 3]) }, { name: 'LXFML', text: readFileSync(join(FIXTURES, 'ldd-bricks.lxfml'), 'utf8') }], { password: null }));
  const files = [...readdirSync(FIXTURES).filter((f) => f.endsWith('.lxfml')).map((f) => join(FIXTURES, f)), lxf];
  const ways: { name: string; assets: boolean; ldraw: boolean }[] = [
    { name: 'LDD’s shapes', assets: true, ldraw: false },
    { name: 'LDD’s shapes and the LDraw library', assets: true, ldraw: true },
    { name: 'ldraw.xml and the LDraw library', assets: false, ldraw: true },
  ];
  for (const file of files)
    for (const way of ways) {
      it(`${file.split('/').pop()}: ${way.name}`, async () => {
        if (way.ldraw && !(LIB && existsSync(LIB))) return;
        const parts = new MapLibrary((await scanCatalog(PARTS)).catalog);
        // The converter finds ldraw.xml beside Assets.lif, or takes it given.
        const libraries = { parts: [PARTS], ...(way.ldraw ? { ldraw: LIB } : {}), ...(way.assets ? { lddAssets: LDD_ROOT } : {}), lddLdrawXml: LDD_XML };
        const want = runConverter(CONVERTER, { command: 'analyse', libraries, options: {} }, file).json as Json;
        const name = file.split('/').pop()!;
        const bytes = new Uint8Array(readFileSync(file));
        const ldd = new FolderLdd(way.assets ? join(LDD_ROOT, 'Assets.lif') : null, LDD_XML);
        const got = await prepareModel(name, bytes, { source: way.ldraw ? new FolderLibrary(LIB) : null, ldd, parts });
        if (process.env.BLD_PARITY_LOG) console.log(name, way.name, JSON.stringify({ want: want.part ? { w: want.part.widthStuds, h: want.part.heightStuds, stats: want.part.stats } : want, got: { w: got.widthStuds, h: got.heightStuds, stats: got.stats, error: got.error } }));
        if (!want.ok) {
          // Nothing to draw (LDD has no shape for the old 9V track): both say so.
          expect(want.error).toBe('nothing_to_import');
          expect(got.error).toMatch(/has no geometry/);
          return;
        }
        expect(got.kindLabel).toBe(want.kindLabel);
        expect([got.title, suggestedImportName(got)]).toEqual([want.title, want.suggestedName]);
        expect({ w: got.widthStuds, h: got.heightStuds, stats: got.stats, warnings: got.warnings, base: got.baseOnGrid, margin: got.snapMargin }).toEqual({
          w: want.part.widthStuds,
          h: want.part.heightStuds,
          stats: want.part.stats,
          warnings: want.part.warnings,
          base: want.part.baseOnGrid,
          margin: want.part.snapMargin,
        });
        for (const k of ['x', 'y', 'width', 'height'] as const) expect(got.contentStuds[k]).toBeCloseTo(want.part.contentStuds[k], 6);
        expect(got.connections.length).toBe(want.part.connections.length);
        got.connections.forEach((c, i) => {
          expect(c.type).toBe(want.part.connections[i].type);
          expect(c.x).toBeCloseTo(want.part.connections[i].x, 4);
          expect(c.y).toBeCloseTo(want.part.connections[i].y, 4);
          expect(c.angle).toBeCloseTo(want.part.connections[i].angle, 4);
        });
        const choices: ConvertChoices = { quarterTurns: 3, align: 'box', nudge: [0, 0.25], drop: [], name: '', designer: '', designerUrl: '', author: 'U' };
        const conv = runConverter(CONVERTER, { command: 'convert', libraries, options: { mode: 'part', ...choices } }, file);
        const made = convertPart(got, choices, { name, lastModified: Math.floor(statSync(file).mtimeMs), format: 'ldd' });
        const strip = (x: string) => x.replace(/ date="[^"]*"/, '').replace(/ *<SourcePath>[^<]*<\/SourcePath>\n/, '').replace(/<PickShape>[\s\S]*<\/PickShape>\n/, '');
        expect(strip(made.xml)).toBe(strip(conv.files.get(String(conv.json.xml))!.toString('utf8')));
        const png = readPng(conv.files.get(String(conv.json.sprite))!);
        const cmp = compareImages({ width: made.sprite.width, height: made.sprite.height, rgba: toRgba(made.sprite) }, png);
        if (process.env.BLD_PARITY_LOG) console.log(name, way.name, JSON.stringify(cmp));
        expect(cmp.sameSize).toBe(true);
        expect(cmp.iou).toBeGreaterThanOrEqual(IOU_MIN);
        expect(cmp.meanRgb).toBeLessThanOrEqual(MEAN_RGB_MAX);
      }, 180_000);
    }
});
