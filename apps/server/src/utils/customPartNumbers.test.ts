// Files for BlueBrick and the desktop name a server's custom part by its
// part number, not the website's "custom:<id>" key.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readBbm, writeBbm } from '@cld/bbm';
import type { BbmMap } from '@cld/model';
import { db, resetDb, schema } from '../test/helpers.js';
import { stockWithCustomPartNumbers, withCustomPartNumbers } from './customPartNumbers.js';
import { encodeDoc, seedFromBbm } from '@cld/ydoc';
import { layoutFileBytes } from '../privacy/exportFiles.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/bbm/tests/fixtures/fordyce-2026.bbm');

/** The part's owner, for naming files with the parts they can see. */
let lastOwner = '';

async function addPart(partNumber: string, opts: { isGlobal?: boolean } = {}): Promise<string> {
  const now = new Date();
  const owner = randomUUID();
  await db.insert(schema.users).values({ id: owner, email: `${owner}@example.com`, displayName: 'o', createdAt: now });
  const id = randomUUID();
  await db.insert(schema.customParts).values({
    id,
    partNumber,
    displayName: partNumber,
    ownerUserId: owner,
    createdBy: owner,
    xmlBlob: Buffer.from('<part/>'),
    spriteBlob: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    spriteMime: 'image/png',
    isGlobal: opts.isGlobal ?? false,
    createdAt: now,
    updatedAt: now,
  });
  lastOwner = owner;
  return id;
}

const brickLayers = (m: BbmMap) => m.layers.filter((l) => l.type === 'brick');

describe('withCustomPartNumbers', () => {
  beforeEach(() => resetDb());

  it('names custom:<id> bricks by their part number, in any case, and leaves the rest alone', async () => {
    const id = await addPart('Ninjago_City_70620');
    const map = readBbm(readFileSync(FIXTURE, 'utf-8')).map;
    const layer = brickLayers(map)[0]!;
    if (layer.type !== 'brick') throw new Error('no brick sheet');
    const others = layer.bricks.slice(2).map((b) => b.partNumber);
    layer.bricks[0]!.partNumber = `custom:${id}`;
    layer.bricks[1]!.partNumber = `CUSTOM:${id.toUpperCase()}`;

    const out = await withCustomPartNumbers(map, { userId: lastOwner });
    const outLayer = brickLayers(out)[0]!;
    if (outLayer.type !== 'brick') throw new Error('no brick sheet');
    expect(outLayer.bricks[0]!.partNumber).toBe('Ninjago_City_70620');
    expect(outLayer.bricks[1]!.partNumber).toBe('Ninjago_City_70620');
    expect(outLayer.bricks.slice(2).map((b) => b.partNumber)).toEqual(others);
    expect(writeBbm(out)).not.toMatch(/custom:/i);
    // The input map is untouched.
    expect(layer.bricks[0]!.partNumber).toBe(`custom:${id}`);
  });

  it('keeps a key whose part is gone, and returns the same map when there are none', async () => {
    const map = readBbm(readFileSync(FIXTURE, 'utf-8')).map;
    expect(await withCustomPartNumbers(map, { userId: 'nobody' })).toBe(map);
    const layer = brickLayers(map)[0]!;
    if (layer.type !== 'brick') throw new Error('no brick sheet');
    layer.bricks[0]!.partNumber = 'custom:missing';
    const out = brickLayers(await withCustomPartNumbers(map, { userId: 'nobody' }))[0]!;
    if (out.type !== 'brick') throw new Error('no brick sheet');
    expect(out.bricks[0]!.partNumber).toBe('custom:missing');
  });

  it("names only parts the file's reader may see; global parts for everyone", async () => {
    const secret = await addPart('Private_1');
    const owner = lastOwner;
    const shared = await addPart('Global_1', { isGlobal: true });
    const map = readBbm(readFileSync(FIXTURE, 'utf-8')).map;
    const layer = brickLayers(map)[0]!;
    if (layer.type !== 'brick') throw new Error('no brick sheet');
    layer.bricks[0]!.partNumber = `custom:${secret}`;
    layer.bricks[1]!.partNumber = `custom:${shared}`;
    const forOther = brickLayers(await withCustomPartNumbers(map, { userId: 'someone-else' }))[0]!;
    if (forOther.type !== 'brick') throw new Error('no brick sheet');
    expect(forOther.bricks[0]!.partNumber).toBe(`custom:${secret}`);
    expect(forOther.bricks[1]!.partNumber).toBe('Global_1');
    const forOwner = brickLayers(await withCustomPartNumbers(map, { userId: owner }))[0]!;
    if (forOwner.type !== 'brick') throw new Error('no brick sheet');
    expect(forOwner.bricks[0]!.partNumber).toBe('Private_1');
  });
});

describe('.bld-layout downloads', () => {
  beforeEach(() => resetDb());

  it('name custom parts by their part number too', async () => {
    const id = await addPart('Rivendell_10316');
    const map = readBbm(readFileSync(FIXTURE, 'utf-8')).map;
    const layer = brickLayers(map)[0]!;
    if (layer.type !== 'brick') throw new Error('no brick sheet');
    layer.bricks[0]!.partNumber = `custom:${id}`;
    let bbm = '';
    const out = await layoutFileBytes(encodeDoc(seedFromBbm(map)), null, null, null, (entries) => {
      bbm = Buffer.from(entries.find((e) => e.name === 'layout.bbm')!.data).toString('utf8');
      return new Uint8Array([1]);
    }, { userId: lastOwner });
    expect(out).not.toBeNull();
    expect(bbm).toContain('Rivendell_10316');
    expect(bbm).not.toMatch(/custom:/i);
  });

  it('names an imported model car’s custom:<id> by its part number too, in its look and its model, for parts the viewer may see', async () => {
    const id = await addPart('Santa_Fe');
    const owner = lastOwner;
    const hidden = await addPart('Not_Yours');
    const sidecar: Record<string, unknown> = {
      rollingStock: [
        { id: 'a', look: { mode: 'model', partKey: `custom:${id}` }, model: { partKey: `custom:${id}`, file: 'santa-fe.io' } },
        { id: 'b', look: { mode: 'model', partKey: `custom:${hidden}` } },
        { id: 'c', look: { mode: 'part', partKey: '10194-1.WAGON' } },
      ],
    };
    await stockWithCustomPartNumbers(sidecar, { userId: owner });
    const stock = sidecar.rollingStock as { look: { partKey: string }; model?: { partKey: string; file: string } }[];
    expect(stock[0]!.look.partKey).toBe('Santa_Fe');
    expect(stock[0]!.model).toEqual({ partKey: 'Santa_Fe', file: 'santa-fe.io' });
    expect(stock[1]!.look.partKey).toBe(`custom:${hidden}`);
    expect(stock[2]!.look.partKey).toBe('10194-1.WAGON');
    // Nothing to name: nothing changes.
    const none: Record<string, unknown> = { labels: [] };
    await stockWithCustomPartNumbers(none, { userId: owner });
    expect(none).toEqual({ labels: [] });
  });
});
