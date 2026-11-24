// @vitest-environment node
// The parts a .bld-layout carries (references/LAYOUT-FILE.md `parts/`).

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BbmMap } from '@cld/model';
import { api, type PartWire } from '../api';
import { buildLayoutFile, isLayoutPartFileName, readLayoutFile } from '../layoutFile';
import {
  applyPartChoices,
  findPartDifferences,
  layoutPartFiles,
  nextFreePartNumber,
  partInfo,
  planLayoutParts,
  renamePartInMap,
  renamePartsInBbm,
  stockPartKeys,
  takeLayoutParts,
  uploadLayoutParts,
  type PartFetcher,
} from '../layoutParts';
import { readBbm } from '@cld/bbm';
import TIGHT_CORNER from '../../../../packages/bbm/tests/fixtures/tight-corner.bbm?raw';
import { buildZip } from '../bbmFiles';

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);
const xml = (en: string, root = 'part') => bytes(`<?xml version="1.0"?>\n<${root}>\n\t<Description>\n\t\t<en>${en}</en>\n\t</Description>\n</${root}>\n`);

function part(p: Partial<PartWire> & Pick<PartWire, 'key' | 'partNumber' | 'source'>): PartWire {
  return {
    colorCode: '',
    kind: 'leaf',
    description: '',
    sortingKey: '',
    spritePath: '',
    pxPerStud: 8,
    category: '',
    connections: [],
    subparts: [],
    hullPts: [],
    customPartId: null,
    ...p,
  };
}

const CATALOG: PartWire[] = [
  part({ key: '3001.1', partNumber: '3001', colorCode: '1', source: 'bundled' }),
  part({ key: 'custom:a', partNumber: 'MINE.1', source: 'custom', customPartId: 'a' }),
  part({ key: 'custom:k', partNumber: 'KIT.1', source: 'custom', customPartId: 'k', kind: 'group' }),
  // A custom part shadowed by a bundled one of the same key isn't carried.
  part({ key: 'custom:s', partNumber: '3001.1', source: 'custom', customPartId: 's' }),
  part({ key: 'custom:u', partNumber: 'UNUSED.1', source: 'custom', customPartId: 'u' }),
];

function mapOf(parts: string[]): BbmMap {
  return {
    layers: [{ type: 'brick', bricks: parts.map((partNumber) => ({ partNumber })) }],
  } as unknown as BbmMap;
}

const fetcher: PartFetcher = {
  xml: async (id) => bytes(`<part id="${id}"/>`),
  sprite: async (id) => ({ type: id === 'a' ? 'image/png' : 'image/gif', data: bytes(`sprite-${id}`) }),
};

afterEach(() => vi.restoreAllMocks());

describe('layout parts', () => {
  it('carries the custom parts a layout uses, each XML with its sprite', async () => {
    const files = await layoutPartFiles(mapOf(['3001.1', 'MINE.1', 'mine.1', 'KIT.1']), CATALOG, fetcher);
    expect(Object.keys(files).sort()).toEqual(['KIT.1.set.gif', 'KIT.1.set.xml', 'MINE.1.png', 'MINE.1.xml']);
    expect(new TextDecoder().decode(files['MINE.1.png'])).toBe('sprite-a');
  });

  it('carries the part an engine or car is drawn with (an imported model’s), not a plain car’s', async () => {
    const sidecar = JSON.stringify({ rollingStock: [{ look: { mode: 'model', partKey: 'custom:a' } }, { look: { mode: 'simple', partKey: 'KIT.1' } }] });
    expect(stockPartKeys(sidecar)).toEqual(['custom:a']);
    expect(stockPartKeys(null)).toEqual([]);
    expect(stockPartKeys('not json')).toEqual([]);
    const files = await layoutPartFiles(mapOf(['3001.1']), CATALOG, fetcher, stockPartKeys(sidecar));
    expect(Object.keys(files).sort()).toEqual(['MINE.1.png', 'MINE.1.xml']);
  });

  it('carries a custom set its groups were placed from, as its XML only', async () => {
    const catalog = [...CATALOG, part({ key: 'custom:w', partNumber: 'Yard.whole', source: 'custom', customPartId: 'w', kind: 'group', noSprite: true })];
    const map = {
      layers: [{ type: 'brick', bricks: [{ partNumber: 'MINE.1' }], groups: [{ id: 'g', partNumber: 'custom:w', myGroup: '' }] }],
    } as unknown as BbmMap;
    const sprite = vi.fn(fetcher.sprite);
    const files = await layoutPartFiles(map, catalog, { ...fetcher, sprite });
    expect(Object.keys(files).sort()).toEqual(['MINE.1.png', 'MINE.1.xml', 'Yard.whole.set.xml']);
    expect(sprite).not.toHaveBeenCalledWith('w');
  });

  it('goes into the file under parts/, and comes out again', async () => {
    const parts = { 'MINE.1.xml': xml('Mine'), 'MINE.1.png': bytes('png') };
    const file = await buildLayoutFile({ bbm: '<Map/>', sidecar: null, parts });
    const back = await readLayoutFile(file);
    expect(back.parts).toEqual(parts);
    expect(back.warnings).toEqual([]);
  });

  it('drops part names that would leave their folder', async () => {
    for (const ok of ['MINE.1.xml', 'KIT.1.set.xml', 'Track 18 #2.8.png', 'x.JPEG']) expect(isLayoutPartFileName(ok)).toBe(true);
    for (const bad of ['../evil.xml', 'sub/MINE.1.xml', 'sub\\MINE.1.xml', '.hidden.xml', 'C:evil.xml', 'MINE.1.exe', ''])
      expect(isLayoutPartFileName(bad)).toBe(false);
    const file = buildZip([
      { name: 'manifest.json', data: bytes('{"format":"bld-layout","version":1}') },
      { name: 'layout.bbm', data: bytes('<Map/>') },
      { name: 'parts/../../evil.xml', data: bytes('x') },
      { name: 'parts/GOOD.1.xml', data: bytes('x') },
    ]);
    const back = await readLayoutFile(file);
    expect(Object.keys(back.parts ?? {})).toEqual(['GOOD.1.xml']);
    expect(back.warnings).toHaveLength(1);
  });

  it('plans to upload only what the server lacks, with a sprite it takes', () => {
    const plan = planLayoutParts(
      {
        'MINE.1.xml': xml('Mine'),
        'MINE.1.png': bytes('png'),
        '3001.1.xml': xml('Brick'),
        'NEW.1.xml': xml('New part'),
        'NEW.1.gif': bytes('gif'),
        'NEW.1.png': bytes('png'),
        'SET.1.set.xml': xml('A set', 'group'),
        'SET.1.set.gif': bytes('gif'),
        'BARE.1.xml': xml('No sprite'),
        'JPG.1.xml': xml('Only a jpeg'),
        'JPG.1.jpg': bytes('jpg'),
      },
      CATALOG,
    );
    expect(plan.known).toEqual(['3001.1', 'MINE.1']);
    expect(plan.skipped).toEqual(['BARE.1', 'JPG.1']);
    expect(plan.upload.map((u) => [u.partNumber, u.displayName, u.spriteMime])).toEqual([
      ['NEW.1', 'New part', 'image/png'],
      ['SET.1', 'A set', 'image/gif'],
    ]);
    expect(new TextDecoder().decode(plan.upload[0]!.sprite)).toBe('png'); // the .png, as the desktop prefers
  });

  it('plans a set without a picture (a Brick Track Designer export) as a set, but not a part without one', () => {
    const plan = planLayoutParts({ 'Yard.whole.set.xml': xml('Yard', 'group'), 'LONE.1.set.xml': xml('Not a set') }, CATALOG);
    expect(plan.upload.map((u) => [u.partNumber, u.sprite, u.spriteMime])).toEqual([['Yard.whole', undefined, undefined]]);
    expect(plan.skipped).toEqual(['LONE.1']);
  });

  it('uploads a set without a sprite', async () => {
    const create = vi.spyOn(api.customParts, 'create').mockResolvedValue({ id: 'x', partNumber: 'Yard.whole', displayName: 'Yard' });
    await uploadLayoutParts({ 'Yard.whole.set.xml': xml('Yard', 'group') }, async () => CATALOG);
    expect(create.mock.calls[0]![0]).toEqual({ partNumber: 'Yard.whole', displayName: 'Yard', xmlBase64: btoa(new TextDecoder().decode(xml('Yard', 'group'))) });
  });

  it('uploads them as custom parts and says what happened', async () => {
    const create = vi
      .spyOn(api.customParts, 'create')
      .mockImplementation(async (b) => {
        if (b.partNumber === 'BAD.1') throw new Error('500');
        return { id: 'x', partNumber: b.partNumber, displayName: b.displayName };
      });
    const notes = await uploadLayoutParts(
      {
        'NEW.1.xml': xml('New part'),
        'NEW.1.png': bytes('png'),
        'BAD.1.xml': xml('Bad'),
        'BAD.1.png': bytes('png'),
        'BARE.1.xml': xml('No sprite'),
        'MINE.1.xml': xml('Mine'),
      },
      async () => CATALOG,
      'club',
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![0]).toEqual({
      partNumber: 'NEW.1',
      displayName: 'New part',
      xmlBase64: btoa(new TextDecoder().decode(xml('New part'))),
      spriteBase64: btoa('png'),
      spriteMime: 'image/png',
      orgSlug: 'club',
    });
    expect(notes).toEqual(['1 part from the layout added to your custom parts', 'no sprite the server takes for BARE.1', 'could not upload BAD.1']);
    expect(await uploadLayoutParts(undefined, async () => CATALOG)).toEqual([]);
  });

  describe('parts that differ from the server', () => {
    const DIFF_CATALOG: PartWire[] = [
      ...CATALOG,
      part({ key: '3002.1', partNumber: '3002', colorCode: '1', source: 'bundled', spritePath: 'Brick/3002.1.gif' }),
    ];
    const text = (map: Record<string, string>) => async (url: string) => {
      if (!(url in map)) throw new Error(`404 ${url}`);
      return map[url]!;
    };

    it('lists a custom part only when its XML differs, ignoring surrounding whitespace', async () => {
      const files = {
        'MINE.1.xml': xml('Mine, changed'),
        'MINE.1.gif': bytes('gif'),
        'KIT.1.set.xml': xml('Kit', 'group'),
        '3001.1.xml': xml('Brick'),
        '3002.1.xml': xml('Brick 2, changed'),
        'NEW.1.xml': xml('New'),
      };
      const found = await findPartDifferences(
        files,
        DIFF_CATALOG,
        text({
          [api.customParts.xmlUrl('a')]: new TextDecoder().decode(xml('Mine')),
          [api.customParts.xmlUrl('k')]: `\n  ${new TextDecoder().decode(xml('Kit', 'group'))}\n`,
          // Bundled 3001.1 has no sprite path, so no XML to compare: not listed.
          '/parts/Brick/3002.1.xml': new TextDecoder().decode(xml('Brick 2')),
        }),
      );
      expect(found.differing.map((d) => [d.partNumber, d.customPartId, d.serverPartNumber, d.spriteMime])).toEqual([
        ['MINE.1', 'a', 'MINE.1', 'image/gif'],
      ]);
      expect(found.differing[0]!.serverXml).toContain('<en>Mine</en>');
      expect(found.differing[0]!.fileXml).toContain('Mine, changed');
      expect(found.bundled).toEqual(['3002.1']);
    });

    it('reads the description (English first) and the author', () => {
      expect(partInfo('<part><Author>Ann &amp; Bo</Author><Description><fr>Brique</fr><en>Brick</en></Description></part>')).toEqual({
        description: 'Brick',
        author: 'Ann & Bo',
      });
      expect(partInfo('<part><Description><de>Stein</de></Description></part>')).toEqual({ description: 'Stein', author: '' });
    });

    it('keeps both under the next free number, a set and the file\'s own parts counted', () => {
      expect(nextFreePartNumber('MINE.1', CATALOG)).toBe('MINE-2.1');
      const withSet = [...CATALOG, part({ key: 'custom:k2', partNumber: 'KIT-2.1', source: 'custom', customPartId: 'k2', kind: 'group' })];
      expect(nextFreePartNumber('KIT.1', withSet)).toBe('KIT-3.1');
      // A set the file carries takes its number too: its file is .set.xml.
      expect(nextFreePartNumber('KIT.1', withSet, { 'kit-3.1.set.xml': bytes('x') })).toBe('KIT-4.1');
      expect(nextFreePartNumber('KIT.1', withSet, {}, ['KIT-3.1'])).toBe('KIT-4.1');
      // A bundled key is taken as well; no color: the number goes on the end.
      expect(nextFreePartNumber('3001', [part({ key: '3001-2', partNumber: '3001', source: 'bundled' })])).toBe('3001-3');
    });

    it('renames only that part, in bricks and groups, leaving the map as it was', () => {
      const map = {
        layers: [
          {
            type: 'brick',
            bricks: [{ partNumber: 'MINE.1' }, { partNumber: 'OTHER.1' }, { partNumber: 'mine.1' }],
            groups: [{ id: 'g1', partNumber: 'MINE.1' }, { id: 'g2' }, { id: 'g3', partNumber: 'KIT.1' }],
          },
          { type: 'text', textCells: [], groups: [{ id: 't', partNumber: 'MINE.1' }] },
        ],
      } as unknown as BbmMap;
      const before = JSON.stringify(map);
      const { map: out, changed } = renamePartInMap(map, 'MINE.1', 'MINE-2.1');
      expect(changed).toBe(3);
      const layer = out.layers[0] as unknown as { bricks: { partNumber: string }[]; groups: { partNumber?: string }[] };
      expect(layer.bricks.map((b) => b.partNumber)).toEqual(['MINE-2.1', 'OTHER.1', 'MINE-2.1']);
      expect(layer.groups.map((g) => g.partNumber)).toEqual(['MINE-2.1', undefined, 'KIT.1']);
      expect(out.layers[1]).toBe(map.layers[1]);
      expect(JSON.stringify(map)).toBe(before);
      expect(renamePartInMap(map, 'NONE.1', 'X.1').changed).toBe(0);
    });

    it('renames it in the .bbm text, and leaves the rest of the file as it was', async () => {
      const fixture = TIGHT_CORNER;
      expect(await renamePartsInBbm(fixture, [])).toBe(fixture);
      const first = readBbm(fixture).map.layers.flatMap((l) => (l.type === 'brick' ? l.bricks : []))[0]!.partNumber;
      const out = await renamePartsInBbm(fixture, [[first, 'RENAMED-2.1']]);
      const esc = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(out).not.toMatch(new RegExp(`<PartNumber>${esc}</PartNumber>`, 'i'));
      expect(out.replace(/RENAMED-2\.1/g, first)).toBe(fixture);
    });

    it('carries out the choices: replace, add under a new number, keep; and says so', async () => {
      const replace = vi.spyOn(api.customParts, 'replace').mockResolvedValue({ id: 'a', partNumber: 'MINE.1', displayName: 'x' });
      const create = vi.spyOn(api.customParts, 'create').mockImplementation(async (b) => ({ id: 'n', partNumber: b.partNumber, displayName: b.displayName }));
      const d = (partNumber: string, id: string, sprite = true) => ({
        partNumber,
        customPartId: id,
        serverPartNumber: partNumber,
        serverXml: '<part/>',
        fileXml: new TextDecoder().decode(xml(`${partNumber} from the file`)),
        ...(sprite ? { sprite: bytes('png'), spriteMime: 'image/png' as const } : {}),
      });
      const differences = { differing: [d('MINE.1', 'a'), d('KIT.1', 'k'), d('UNUSED.1', 'u'), d('BARE.1', 'b', false)], bundled: ['3001.1'] };
      const out = await applyPartChoices(differences, ['file', 'both', 'server', 'both'], CATALOG, {}, 'club');
      expect(replace).toHaveBeenCalledWith('a', {
        partNumber: 'MINE.1',
        displayName: 'MINE.1 from the file',
        xmlBase64: btoa(new TextDecoder().decode(xml('MINE.1 from the file'))),
        spriteBase64: btoa('png'),
        spriteMime: 'image/png',
      });
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0]![0]).toMatchObject({ partNumber: 'KIT-2.1', displayName: 'KIT.1 from the file', orgSlug: 'club' });
      expect(out.renames).toEqual([['KIT.1', 'KIT-2.1']]);
      expect(out.changed).toBe(true);
      expect(out.notes).toEqual([
        "the layout's MINE.1 replaced the server's",
        "the layout's KIT.1 as KIT-2.1 added",
        "the server's UNUSED.1 kept",
        "could not take the layout's BARE.1",
        "the bundled 3001.1 kept, which differ from the layout's",
      ]);

      const all = await applyPartChoices({ differing: [d('MINE.1', 'a')], bundled: [] }, null, CATALOG, {});
      expect(all).toEqual({ renames: [], notes: ["the server's MINE.1 kept, which differ from the layout's"], changed: false });
    });

    it('asks only when a part differs, then uploads, applies and renames', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new TextDecoder().decode(xml('Mine'))));
      vi.spyOn(api.customParts, 'create').mockImplementation(async (b) => ({ id: 'n', partNumber: b.partNumber, displayName: b.displayName }));
      const bbm = '<Map><PartNumber>MINE.1</PartNumber></Map>';
      const ask = vi.fn(async () => null);
      const same = await takeLayoutParts({ 'MINE.1.xml': xml('Mine'), 'MINE.1.png': bytes('png') }, bbm, async () => CATALOG, ask);
      expect(ask).not.toHaveBeenCalled();
      expect(same).toEqual({ bbm, notes: [], changed: false });

      const kept = await takeLayoutParts({ 'MINE.1.xml': xml('Other'), 'MINE.1.png': bytes('png') }, bbm, async () => CATALOG, ask);
      expect(ask).toHaveBeenCalledTimes(1);
      expect((ask.mock.calls[0] as unknown as [{ partNumber: string }[]])[0].map((p) => p.partNumber)).toEqual(['MINE.1']);
      expect(kept.notes).toEqual(["the server's MINE.1 kept, which differ from the layout's"]);
      expect(kept.bbm).toBe(bbm);
    });
  });
});
