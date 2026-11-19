// What "Open a file…" opens, what it explains instead, and the summary
// after opening.

import { describe, expect, it } from 'vitest';
import type { BbmMap } from '@cld/model';
import type { PartWire } from '../../api';
import { indexParts } from '../../editor/partIndex';
import { LAYOUT_ACCEPT } from '../../mapFormats';
import {
  desktopOnlyFormat,
  OPEN_FORMATS_LINE,
  OPEN_PICKER_ACCEPT,
  sortFiles,
  START_FILE_ACCEPT,
  summarizeMap,
  summaryLine,
  titleFromFileName,
} from '../openFiles';

const file = (name: string) => new File(['x'], name);

describe('sorting picked or dropped files', () => {
  it('opens layouts and the maps the website reads, with a .bbm’s sidecar', () => {
    for (const name of ['a.bld-layout', 'a.BBM', 'a.zip', 'a.tdl', 'a.NCP']) {
      const s = sortFiles([file(name)]);
      expect(s.kind, name).toBe('open');
    }
    const s = sortFiles([file('Yard.bbm'), file('Yard.bbm.bld'), file('notes.txt')]);
    expect(s.kind === 'open' && s.files.map((f) => f.name)).toEqual(['Yard.bbm', 'Yard.bbm.bld']);
  });

  it('explains LDraw, Studio and LDD files instead of opening them', () => {
    const cases: [string, string, boolean][] = [
      ['city.io', 'a BrickLink Studio file', true],
      ['house.lxf', 'a LEGO Digital Designer (LDD) file', true],
      ['house.LXFML', 'a LEGO Digital Designer (LDD) file', true],
      ['train.ldr', 'an LDraw file', false],
      ['train.mpd', 'an LDraw file', false],
      ['3001.dat', 'an LDraw part', true],
    ];
    for (const [name, what, part] of cases) {
      const s = sortFiles([file(name)]);
      expect(s.kind, name).toBe('desktop');
      if (s.kind === 'desktop') {
        expect(s.file.name).toBe(name);
        expect(s.format).toMatchObject({ what, part });
      }
    }
    expect(desktopOnlyFormat('city.io')?.where).toBe('Tools › Import › Studio');
    expect(desktopOnlyFormat('a.bbm')).toBeNull();
    expect(desktopOnlyFormat('radio.ion')).toBeNull();
  });

  it('opens what it can when a desktop-only file comes along', () => {
    const s = sortFiles([file('city.io'), file('Yard.bbm')]);
    expect(s.kind === 'open' && s.files.map((f) => f.name)).toEqual(['Yard.bbm']);
  });

  it('says when a file is nothing it knows, and does nothing for no files', () => {
    expect(sortFiles([file('photo.jpg')])).toMatchObject({ kind: 'unknown' });
    // A sidecar on its own isn't a layout.
    expect(sortFiles([file('Yard.bbm.bld')])).toMatchObject({ kind: 'unknown' });
    expect(sortFiles([])).toEqual({ kind: 'none' });
  });

  it('pickers offer the desktop-only files too, so picking one explains itself', () => {
    expect(LAYOUT_ACCEPT).toBe('.bld-layout,.bbm,.tdl,.ncp');
    for (const ext of ['.bld-layout', '.bbm', '.tdl', '.ncp', '.io', '.lxf', '.lxfml', '.ldr', '.mpd']) {
      expect(OPEN_PICKER_ACCEPT.split(','), ext).toContain(ext);
      expect(START_FILE_ACCEPT.split(','), ext).toContain(ext);
    }
    // The New layout dialog takes one layout file, not a .zip or a sidecar.
    expect(START_FILE_ACCEPT.split(',')).not.toContain('.zip');
    expect(OPEN_PICKER_ACCEPT.split(',')).toContain('.zip');
  });

  it('lists the formats in plain words', () => {
    expect(OPEN_FORMATS_LINE).toContain('BlueBrick (.bbm)');
    expect(OPEN_FORMATS_LINE).toContain('(.bld-layout)');
    expect(OPEN_FORMATS_LINE).toContain('TrackDesigner (.tdl)');
    expect(OPEN_FORMATS_LINE).toContain('4DBrix (.ncp)');
    expect(OPEN_FORMATS_LINE).toContain('imports LDraw (.ldr, .mpd, .dat), BrickLink Studio (.io) and LDD (.lxf, .lxfml) models');
  });

  it('titles a layout after its file', () => {
    expect(titleFromFileName('Show 2026.bld-layout')).toBe('Show 2026');
    expect(titleFromFileName('yard.TDL')).toBe('yard');
    expect(titleFromFileName('a.b.bbm')).toBe('a.b');
  });
});

const part = (key: string, partNumber: string, colorCode: string | null, oldNames?: string[]) =>
  ({ key, partNumber, colorCode, ...(oldNames ? { oldNames } : {}) }) as unknown as PartWire;

function mapOf(...layers: string[][]): BbmMap {
  return {
    layers: [
      { type: 'text', texts: [] },
      ...layers.map((pns) => ({ type: 'brick', bricks: pns.map((partNumber) => ({ partNumber })) })),
    ],
  } as unknown as BbmMap;
}

describe('the summary after opening', () => {
  const index = indexParts([part('3001.1', '3001', '1'), part('TRK.1', 'TRK', '1', ['OLD.1'])]);

  it('counts every part on every sheet and the ones the library lacks', () => {
    const s = summarizeMap(mapOf(['3001.1', 'TRK.1', 'X.7'], ['x.7', 'old.1', 'Y.2', 'X.7']), index);
    expect(s.parts).toBe(7);
    // Case doesn't matter and old names count as known.
    expect(s.missing).toBe(4);
    expect(s.missingParts).toEqual([
      { partNumber: 'X.7', count: 2 },
      { partNumber: 'x.7', count: 1 },
      { partNumber: 'Y.2', count: 1 },
    ]);
  });

  it('says it in one line, with thousands separated', () => {
    const many = mapOf([...Array(1204).fill('3001.1') as string[]]);
    expect(summaryLine('Yard.bbm', summarizeMap(many, index))).toBe('Opened Yard.bbm: 1,204 parts, all in the library');
    const some = mapOf([...Array(1167).fill('3001.1') as string[], ...Array(37).fill('Q.1') as string[]]);
    expect(summaryLine('Yard.bbm', summarizeMap(some, index))).toBe('Opened Yard.bbm: 1,204 parts, 37 not in the library');
    expect(summaryLine('one.tdl', summarizeMap(mapOf(['Q.1']), index))).toBe('Opened one.tdl: 1 part, 1 not in the library');
    expect(summaryLine('empty.bbm', summarizeMap(mapOf([]), index))).toBe('Opened empty.bbm: 0 parts');
  });
});
