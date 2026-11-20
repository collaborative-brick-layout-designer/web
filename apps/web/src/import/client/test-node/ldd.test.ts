// @vitest-environment node
//
// LEGO Digital Designer models in the browser (lddReader.ts, lddMapping.ts,
// lddGeom.ts, prepareModel.ts) on shapes and files made here: LDD's own
// database is proprietary, so CI never sees it (parity.test.ts compares it
// with the converter, opt-in).

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MapLibrary } from '@cld/parts-catalog/browser';
import { convertPart } from '../convert';
import { bakeLdd, readLDDGeom, readMaterials } from '../lddGeom';
import { LddMapping } from '../lddMapping';
import { readLDD } from '../lddReader';
import type { LddSource } from '../lddSource';
import { NeedsServer, prepareModel } from '../prepareModel';
import { toRgba } from '../rasterize';
import { makeIo } from './makeIo';
import { FolderLibrary } from './nodeHelpers';

const MINI = resolve(__dirname, 'fixtures/minilib');
const parts = new MapLibrary(new Map());

/** A .g box w × h × d LDD units from the origin, normals out, like LDD's (no UVs). */
function box(w: number, h: number, d: number): Uint8Array {
  const v: number[][] = [];
  const n: number[][] = [];
  const idx: number[] = [];
  const quad = (p: number[][], normal: number[]) => {
    const base = v.length;
    for (const q of p) {
      v.push(q);
      n.push(normal);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  quad([[0, h, 0], [0, h, d], [w, h, d], [w, h, 0]], [0, 1, 0]); // top (counter-clockwise from above: normal up)
  quad([[0, 0, 0], [w, 0, 0], [w, 0, d], [0, 0, d]], [0, -1, 0]);
  quad([[0, 0, 0], [0, h, 0], [w, h, 0], [w, 0, 0]], [0, 0, -1]);
  quad([[0, 0, d], [w, 0, d], [w, h, d], [0, h, d]], [0, 0, 1]);
  quad([[0, 0, 0], [0, 0, d], [0, h, d], [0, h, 0]], [-1, 0, 0]);
  quad([[w, 0, 0], [w, h, 0], [w, h, d], [w, 0, d]], [1, 0, 0]);
  const buf = new ArrayBuffer(16 + v.length * 24 + idx.length * 4);
  const dv = new DataView(buf);
  [0x31, 0x30, 0x47, 0x42].forEach((b, i) => dv.setUint8(i, b));
  dv.setUint32(4, v.length, true);
  dv.setUint32(8, idx.length, true);
  dv.setUint32(12, 0, true);
  let o = 16;
  for (const c of [...v.flat(), ...n.flat()]) {
    dv.setFloat32(o, c, true);
    o += 4;
  }
  for (const i of idx) {
    dv.setUint32(o, i, true);
    o += 4;
  }
  return new Uint8Array(buf);
}

const MATERIALS = '<?xml version="1.0"?><Materials><Material MatID="21" Red="180" Green="0" Blue="0" /><Material MatID="40" Red="238" Green="238" Blue="238" Alpha="128" /></Materials>';

const LXFML = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<LXFML versionMajor="5" versionMinor="0" name="Test &amp; model">
  <Bricks cameraRef="0">
    <Brick refID="0" designID="3022"><Part refID="0" designID="3022" materials="21,0"><Bone refID="0" transformation="1,0,0,0,1,0,0,0,1,0,0,0"/></Part></Brick>
    <Brick refID="1" designID="3022"><Part refID="1" designID="3022" materials="40"><Bone refID="1" transformation="0,0,-1,0,1,0,1,0,0,1.6,0,0"/></Part></Brick>
    <Brick refID="2" designID="73200"><Part refID="2" designID="973" materials="21"><Bone refID="2" transformation="1,0,0,0,1,0,0,0,1,0,1,0"/></Part><Part refID="3" designID="981" materials="21"><Bone refID="3" transformation="1,0,0,0,1,0,0,0,1,0,2,0"/></Part></Brick>
    <Brick refID="4" designID="77777"><Part refID="4" designID="77777" materials="1"/></Brick>
  </Bricks>
</LXFML>`;

function source(shapes: Record<string, Uint8Array>, mapping: string | null = null, hasAssets = true): LddSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    hasAssets,
    asked,
    async shapes(ids) {
      asked.push(...ids);
      return new Map(ids.map((id) => [id, shapes[id] ?? null]));
    },
    async materials() {
      return MATERIALS;
    },
    async mapping() {
      return mapping;
    },
  };
}

describe('LDD files', () => {
  it('reads LXFML: column-major transforms, 25 LDU a unit, the first material, assemblies part by part', async () => {
    const r = await readLDD('test.lxfml', new TextEncoder().encode(LXFML));
    expect(r.ok).toBe(true);
    expect(r.lddAxes).toBe(true);
    expect(r.title).toBe('Test & model');
    expect(r.parts.map((p) => p.filename)).toEqual(['3022.21.dat', '3022.40.dat', '973.21.dat', '981.21.dat']);
    // "0,0,-1,0,1,0,1,0,0" lists columns: row-major it's [0 0 1; 0 1 0; -1 0 0].
    expect(r.parts[1]!.m).toEqual([0, 0, 1, 0, 1, 0, -1, 0, 0]);
    expect(r.parts[1]!.x).toBeCloseTo(40);
    expect(r.parts[3]!.y).toBeCloseTo(50);
  });

  it('reads the LXFML inside an .lxf, and says what’s wrong with a broken one', async () => {
    const lxf = makeIo([{ name: 'IMAGE100.PNG', bytes: new Uint8Array([1]) }, { name: 'LXFML', text: LXFML }], { password: null });
    expect((await readLDD('a.lxf', lxf)).parts).toHaveLength(4);
    expect((await readLDD('a.lxf', new Uint8Array([1, 2]))).error).toBe('Not a readable LDD .lxf archive: a.lxf');
    expect((await readLDD('a.lxf', makeIo([{ name: 'x.txt', text: 'x' }], { password: null }))).error).toBe('No LXFML entry found inside a.lxf');
    const bad = await readLDD('a.lxfml', new TextEncoder().encode('<LXFML><Bricks></LXFML>'));
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/^LXFML parse error/);
  });

  it('reads a .g brick shape and keeps the outlines of its top', () => {
    const g = readLDDGeom(box(1.6, 0.32, 1.6));
    expect(g.ok).toBe(true);
    expect(g.tri.length / 9).toBe(12);
    // 25 LDU a unit: the box is 40 LDU (2 studs) across.
    expect(Math.max(...g.tri.filter((_, i) => i % 3 === 0))).toBeCloseTo(40);
    // The top's four sides; its diagonal is flat, so it's left out.
    expect(g.edge.length / 6).toBe(4);
    expect(readLDDGeom(new Uint8Array(8)).error).toMatch(/too small/);
    expect(readLDDGeom(new Uint8Array(20)).error).toMatch(/magic/);
  });

  it('bakes each brick from its shape, painted from Materials.xml, and counts what’s missing', async () => {
    const r = await readLDD('test.lxfml', new TextEncoder().encode(LXFML));
    const baked = bakeLdd(r, new Map([['3022', box(1.6, 0.32, 1.6)]]), readMaterials(MATERIALS));
    expect(baked.rendered).toBe(2);
    expect(baked.skipped).toBe(2);
    expect(baked.errors).toEqual(['missing .g for designID 973', 'missing .g for designID 981']);
    expect(baked.mesh.triColor[0]! & 0xff).toBe(255);
    expect(baked.mesh.triColor[12]! & 0xff).toBe(128);
  });

  it('maps LDD to LDraw with ldraw.xml, and finds the built-in train track without one', async () => {
    const m = new LddMapping();
    expect(m.load('<LDrawMapping><Material ldraw="4" lego="21"/><Brick ldraw="3022.dat" lego="3022"/><Brick ldraw="3022b.dat" lego="3022"/><Transformation ldraw="3022.dat" tx="0" ty="0" tz="0" ax="0" ay="1" az="0" angle="0"/></LDrawMapping>')).toBe(true);
    const r = await readLDD('test.lxfml', new TextEncoder().encode(LXFML));
    const l = m.toLDraw(r);
    expect(l.lddAxes).toBe(false);
    expect(l.parts[0]).toMatchObject({ filename: '3022b.dat', colorCode: 4, aliases: ['3022.dat'] });
    // LDraw is -Y up: y and z flip.
    expect(l.parts[3]!.y).toBeCloseTo(-50);
    expect(new LddMapping().partFor('53401')).toBe('53401.dat');
    expect(new LddMapping().transformFor('74746.dat').exists).toBe(true);
  });

  it('draws an LDD model from LDD’s shapes, its title kept, and makes it into a part', async () => {
    const src = source({ '3022': box(1.6, 0.32, 1.6), '973': box(1.6, 0.96, 0.8), '981': box(0.4, 0.4, 0.4) });
    const part = await prepareModel('test.lxfml', new TextEncoder().encode(LXFML), { source: null, ldd: src, parts });
    expect(part.error).toBe('');
    expect(part.kindLabel).toBe('LDD import');
    expect(part.title).toBe('Test & model');
    expect(part.stats).toEqual({ ldrawResolved: 0, lddRendered: 4, unresolved: 0 });
    expect(part.sprite!.width).toBe(part.widthStuds * 32);
    expect(new Set(src.asked)).toEqual(new Set(['3022', '973', '981']));
    // The red plate shows, lit from above.
    expect(toRgba(part.sprite!).some((v, i) => i % 4 === 0 && v > 150)).toBe(true);
    const made = convertPart(part, { quarterTurns: 0, align: '', nudge: [0, 0], drop: [], name: '', designer: '', designerUrl: '', author: 'A' }, { name: 'test.lxfml', lastModified: null, format: 'ldd' }, '2026-11-20');
    expect(made.xml).toContain('format="ldd"');
    expect(made.displayName).toBe('Test & model');
  });

  it('without LDD’s database, draws the LDraw model ldraw.xml makes of it, or hands it to the server', async () => {
    const mapping = '<LDrawMapping><Brick ldraw="box2.dat" lego="3022"/></LDrawMapping>';
    const part = await prepareModel('test.lxfml', new TextEncoder().encode(LXFML), { source: new FolderLibrary(MINI), ldd: source({}, mapping, false), parts });
    expect(part.error).toBe('');
    expect(part.kindLabel).toBe('LDD import');
    expect(part.stats.ldrawResolved).toBe(2);
    await expect(prepareModel('test.lxfml', new TextEncoder().encode(LXFML), { source: new FolderLibrary(MINI), ldd: source({}, null, false), parts })).rejects.toBeInstanceOf(NeedsServer);
    await expect(prepareModel('test.lxfml', new TextEncoder().encode(LXFML), { source: null, ldd: source({}, mapping, false), parts })).rejects.toBeInstanceOf(NeedsServer);
  });

  it('a model LDD has no shapes for says so', async () => {
    const part = await prepareModel('test.lxfml', new TextEncoder().encode(LXFML), { source: null, ldd: source({}), parts });
    expect(part.error).toBe('LDD’s brick database on this site has no geometry for this model.');
    expect(part.warnings[0]).toBe('LDD has no shape for 3 brick(s), so they’re left out: 3022 (2 times), 973, 981.');
  });
});
