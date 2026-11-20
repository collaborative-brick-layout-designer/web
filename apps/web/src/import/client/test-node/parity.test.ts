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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { scanCatalog } from '@cld/parts-catalog';
import { MapLibrary } from '@cld/parts-catalog/browser';
import { readBbm } from '@cld/bbm';
import { convertPart, type ConvertChoices } from '../convert';
import { isLayoutFile, layoutBbm, readLayout } from '../layout';
import { importedPartKey, prepareLDraw, suggestedImportName } from '../prepare';
import { toRgba } from '../rasterize';
import { compareImages, FolderLibrary, readPng, runConverter } from './nodeHelpers';

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
