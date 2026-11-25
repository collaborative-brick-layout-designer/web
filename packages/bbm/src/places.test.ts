// Places (places.ts), against the vectors both apps test
// (fixtures/contracts/places.json; the desktop's tests/saveload/PlacesTest.cpp
// reads the same file). BLD_WRITE_CONTRACTS=1 writes the answers.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  adoptPlaces, copyPlaces, libraryPlaces, PLACE_LIMITS, placeCounts, placeSize, readPlace, readPlaces, releasePlaces, sameCarType, spotCapacity, updatedPlaces, validPlace, validPlaces,
  type Place,
} from './places.js';
import { readSidecar, writeSidecar } from './sidecar.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/contracts/places.json');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doc = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, any>;
const writing = process.env.BLD_WRITE_CONTRACTS === '1';

/** New ids in the vectors: n1, n2, ... */
const ids = () => {
  let n = 0;
  return () => `n${++n}`;
};

/** Each case's answer: written, or compared. */
function each<C>(section: string, answer: (c: C) => unknown): void {
  it(section, () => {
    for (const c of doc[section] as (C & { expect?: unknown })[]) {
      const got = JSON.parse(JSON.stringify(answer(c) ?? null)) as unknown;
      if (writing) c.expect = got;
      else expect(got, JSON.stringify(c).slice(0, 200)).toEqual(c.expect);
    }
  });
}

describe('places contract (fixtures/contracts/places.json)', () => {
  it('limits', () => {
    if (writing) doc.limits = PLACE_LIMITS;
    else expect(doc.limits).toEqual(PLACE_LIMITS);
  });
  each<{ value: unknown }>('read', (c) => {
    const place = readPlace(c.value);
    // (What is read is always something the server takes.)
    if (place) expect(validPlace(place)).toBe(true);
    return { place, size: place ? placeSize(place) : null };
  });
  each<{ value: unknown }>('readList', (c) => readPlaces(c.value).map((p) => p.id));
  each<{ value: unknown }>('valid', (c) => validPlace(c.value));
  each<{ value: unknown }>('validList', (c) => validPlaces(c.value));
  each<{ places: Place[]; rename: Record<string, string> }>('copy', (c) => copyPlaces(c.places, (id) => c.rename[id] ?? null, ids()));
  each<{ current: Place[]; next: Place[] }>('update', (c) => updatedPlaces(c.current, c.next, ids()));
  each<{ places: Place[]; members: string[] }>('library', (c) => libraryPlaces(c.places, new Set(c.members)));
  each<{ layout: Place[]; members: string[] }>('adopt', (c) => {
    const r = adoptPlaces(c.layout, new Set(c.members));
    return { module: r.module.map((p) => p.id), layout: r.layout.map((p) => p.id) };
  });
  each<{ layout: Place[]; places: Place[] }>('release', (c) => releasePlaces(c.layout, c.places, ids()).map((p) => [p.id, p.source ?? null]).slice(-3));
  each<{ kinds: string[] }>('counts', (c) => placeCounts(c.kinds.map((kind) => ({ kind }))));
  each<{ a: string; b: string }>('carTypes', (c) => sameCarType(c.a, c.b));
  each<{ capacity: number | null; usable: number | null }>('capacity', (c) => spotCapacity(c.capacity === null ? {} : { capacity: c.capacity }, c.usable));
  if (writing) afterAll(() => writeFileSync(FILE, `${JSON.stringify(doc, null, 1)}\n`));
});

describe('places in a sidecar', () => {
  const place: Place = { id: 'pl-1', name: 'Acme Cannery', kind: 'industry', spots: [{ id: 's1', name: 'Dock', track: { brick: 'B1', from: 0, to: 1 }, capacity: 3 }], accepts: ['reefer'], ships: [], tags: [], notes: '', later: { x: 1 } };

  it('round-trip on a module and on the layout, with fields this build doesn’t know', () => {
    const raw = JSON.stringify({ schemaVersion: 1, bbmHashSha256: '', modules: [{ id: 'm', name: 'M', members: ['B1'], transform: [], places: [place] }], layoutPlaces: [{ ...place, id: 'pl-2' }], newer: 1 });
    const back = JSON.parse(writeSidecar(readSidecar(raw))) as { modules: { places: Place[] }[]; layoutPlaces: Place[]; newer: number };
    expect(back.modules[0]!.places).toEqual([place]);
    expect(back.layoutPlaces).toEqual([{ ...place, id: 'pl-2' }]);
    expect(back.newer).toBe(1);
  });

  it('a file’s places outside the limits are put within them; a module without any has no field', () => {
    const s = readSidecar(JSON.stringify({ schemaVersion: 1, modules: [{ id: 'm', name: 'M', members: [], transform: [], places: [{ ...place, name: 'x'.repeat(200) }, 5] }, { id: 'n', name: 'N', members: [], transform: [], places: 'junk' }], layoutPlaces: 'junk' }));
    expect(validPlaces(s.modules![0]!.places)).toBe(true);
    expect(s.modules![0]!.places![0]!.name).toHaveLength(80);
    expect('places' in s.modules![1]!).toBe(false);
    expect(s.layoutPlaces).toBeUndefined();
  });
});
