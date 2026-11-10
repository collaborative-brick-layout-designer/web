import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  NEWER_SIDECAR_WARNING,
  readSidecar,
  sidecarWarnings,
  readView,
  writeSidecar,
  type Sidecar,
} from './sidecar.js';
import { hashBbmBytes } from './sidecarHash.js';

const baseSidecar: Sidecar = {
  schemaVersion: 1,
  bbmHashSha256: '',
  anchoredLabels: [],
  modules: [],
};

describe('module look fields', () => {
  it('round-trips a module’s own look and keeps fields it does not know', () => {
    const mod = {
      id: 'm1',
      name: 'Harbour',
      members: ['b1'],
      transform: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      showName: false,
      outlineColor: '#ff8800',
      nameColor: '#112233',
      sameColor: false,
      pinned: true,
      fromTheFuture: { x: 1 },
    };
    const back = readSidecar(writeSidecar({ ...baseSidecar, modules: [mod] }));
    expect(back.modules).toEqual([mod]);
  });

  it('reads a module written before the look fields as the default look', () => {
    const back = readSidecar(JSON.stringify({ schemaVersion: 1, modules: [{ id: 'm', name: 'A', members: [], transform: [] }] }));
    const m = back.modules![0]!;
    expect(m.showName).toBeUndefined();
    expect(m.outlineColor).toBeUndefined();
    expect(m.sameColor).toBeUndefined();
  });
});

describe('placed sets', () => {
  it('round-trips the version each placed custom set came from, and keeps fields it does not know', () => {
    const sets = [
      { id: 'g1', version: '1572ba9befec980c', anchor: { brick: 'b1', x: 0, y: -4, angle: 90 } },
      { id: 'g2', version: 'aa', later: true },
    ];
    const back = readSidecar(writeSidecar({ schemaVersion: 1, bbmHashSha256: '', sets }));
    expect(back.sets).toEqual(sets);
    expect(back.extras).toBeUndefined();
    // Entries without an id or a version are dropped; none at all writes no field.
    expect(readSidecar(JSON.stringify({ schemaVersion: 1, sets: [{ id: 'x' }, null, { id: 'g', version: 'v' }] })).sets).toEqual([{ id: 'g', version: 'v' }]);
    expect(writeSidecar({ schemaVersion: 1, bbmHashSha256: '', sets: [] })).not.toContain('sets');
  });
});

describe('readSidecar', () => {
  it('parses a minimal sidecar', () => {
    const result = readSidecar(JSON.stringify({ schemaVersion: 1, bbmHashSha256: 'abc' }));
    expect(result.schemaVersion).toBe(1);
    expect(result.bbmHashSha256).toBe('abc');
  });

  it('treats missing bbmHashSha256 as empty (initial-state, hash detection skipped)', () => {
    const result = readSidecar(JSON.stringify({ schemaVersion: 1 }));
    expect(result.bbmHashSha256).toBe('');
  });

  // As the desktop does (docs/bbm-bld-schema.md): a newer version's file
  // opens with a warning, keeps what this version doesn't know (top level
  // and inside labels) and is written back with its own version number.
  it('opens a newer schemaVersion, keeps what it does not know and writes the version back', () => {
    const newer = CURRENT_SCHEMA_VERSION + 1;
    const raw = JSON.stringify({
      schemaVersion: newer,
      bbmHashSha256: '',
      anchoredLabels: [{ id: 'l1', text: 'Depot', glow: true }],
      futureField: { x: 1 },
    });
    const parsed = readSidecar(raw);
    expect(parsed.schemaVersion).toBe(newer);
    expect(parsed.extras).toEqual({ futureField: { x: 1 } });
    const back = JSON.parse(writeSidecar(parsed)) as Record<string, unknown>;
    expect(back.schemaVersion).toBe(newer);
    expect(back.futureField).toEqual({ x: 1 });
    expect((back.anchoredLabels as { glow?: boolean }[])[0]!.glow).toBe(true);
    expect(sidecarWarnings(raw)).toEqual([NEWER_SIDECAR_WARNING]);
  });

  it('warns only about a newer version', () => {
    expect(sidecarWarnings(JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION }))).toEqual([]);
    expect(sidecarWarnings(JSON.stringify({}))).toEqual([]);
    expect(sidecarWarnings('{not json')).toEqual([]);
  });

  it('preserves unknown top-level fields in extras', () => {
    const raw = JSON.stringify({ schemaVersion: 1, bbmHashSha256: '', futureField: { x: 1 } });
    const parsed = readSidecar(raw);
    expect(parsed.extras).toEqual({ futureField: { x: 1 } });
  });
});

describe('writeSidecar', () => {
  it('round-trips through JSON.parse / readSidecar', () => {
    const written = writeSidecar(baseSidecar);
    expect(readSidecar(written)).toEqual(baseSidecar);
  });

  it('emits 2-space-indented JSON by default', () => {
    const written = writeSidecar(baseSidecar);
    expect(written).toContain('\n  "schemaVersion": 1');
  });

  it('overrides bbmHashSha256 when an explicit digest is supplied', () => {
    const stale = { ...baseSidecar, bbmHashSha256: 'STALE' };
    const fresh = hashBbmBytes('abc');
    const written = writeSidecar(stale, { bbmHashSha256: fresh });
    const parsed = JSON.parse(written) as { bbmHashSha256: string };
    expect(parsed.bbmHashSha256).toBe(fresh);
    expect(parsed.bbmHashSha256).not.toBe('STALE');
  });

  it('preserves unknown extras on round-trip', () => {
    const sidecar: Sidecar = {
      ...baseSidecar,
      extras: { somethingNew: { nested: true } },
    };
    const written = writeSidecar(sidecar);
    const parsed = readSidecar(written);
    expect(parsed.extras).toEqual({ somethingNew: { nested: true } });
  });
});

describe('backgroundImage', () => {
  it('maps the desktop shape {path, rect:[x,y,w,h]} to the web shape', () => {
    // Shape written by desktop SidecarIO.cpp writeSidecar.
    const raw = JSON.stringify({
      schemaVersion: 1,
      bbmHashSha256: '',
      backgroundImage: { opacity: 0.35, path: '/home/me/hall.png', rect: [-10, 20.5, 300, 150] },
    });
    const parsed = readSidecar(raw);
    expect(parsed.backgroundImage).toEqual({
      url: '',
      path: '/home/me/hall.png',
      opacity: 0.35,
      rect: { x: -10, y: 20.5, w: 300, h: 150 },
    });
    expect(parsed.extras).toBeUndefined();
  });

  it('defaults opacity to 0.5 and omits rect when absent (desktop defaults)', () => {
    const parsed = readSidecar(
      JSON.stringify({ schemaVersion: 1, backgroundImage: { path: 'bg.jpg' } }),
    );
    expect(parsed.backgroundImage).toEqual({ url: '', path: 'bg.jpg', opacity: 0.5 });
  });

  it('reads the web shape {url, rect:{x,y,w,h}}', () => {
    const bg = { url: '/api/layouts/L1/background-image', opacity: 0.8, rect: { x: 1, y: 2, w: 3, h: 4 } };
    const parsed = readSidecar(JSON.stringify({ schemaVersion: 1, backgroundImage: bg }));
    expect(parsed.backgroundImage).toEqual(bg);
  });

  it('writes backgroundImage (previously dropped) in a shape both apps read', () => {
    const bg = { url: '/api/layouts/L1/background-image', opacity: 0.8, rect: { x: 1, y: 2, w: 3, h: 4 } };
    const written = writeSidecar({ ...baseSidecar, backgroundImage: bg });
    const json = JSON.parse(written) as { backgroundImage: { rect: unknown } };
    // Desktop only understands a 4-element rect array.
    expect(json.backgroundImage.rect).toEqual([1, 2, 3, 4]);
    expect(readSidecar(written).backgroundImage).toEqual(bg);
  });

  it('round-trips a desktop sidecar without losing path', () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      bbmHashSha256: '',
      backgroundImage: { opacity: 0.5, path: 'C:/maps/hall.png', rect: [0, 0, 10, 10] },
    });
    const json = JSON.parse(writeSidecar(readSidecar(raw))) as { backgroundImage: unknown };
    expect(json.backgroundImage).toEqual({
      opacity: 0.5,
      path: 'C:/maps/hall.png',
      rect: [0, 0, 10, 10],
      url: '',
    });
  });

  it('ignores a backgroundImage with neither url nor path', () => {
    const parsed = readSidecar(JSON.stringify({ schemaVersion: 1, backgroundImage: { opacity: 1 } }));
    expect(parsed.backgroundImage).toBeUndefined();
  });
});

describe('hashBbmBytes', () => {
  it('produces lowercase hex', () => {
    const h = hashBbmBytes('hello');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches a known SHA-256 value', () => {
    // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(hashBbmBytes('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('accepts both string and Uint8Array', () => {
    const s = hashBbmBytes('hello');
    const b = hashBbmBytes(new TextEncoder().encode('hello'));
    expect(s).toBe(b);
  });
});

describe('views', () => {
  const fit = { id: 'v1', name: 'Whole layout', fit: true, rect: null, sheets: null, grid: true, labels: true };
  const area = { id: 'v2', name: 'Station', fit: false, rect: { x: -8, y: -8, w: 48, h: 32 }, sheets: ['L2'], grid: false, labels: false };

  it('round-trips saved views in list order', () => {
    const raw = writeSidecar({ ...baseSidecar, views: [fit, area] });
    expect(JSON.parse(raw).views).toEqual([fit, area]);
    expect(readSidecar(raw).views).toEqual([fit, area]);
    expect(readSidecar(raw).extras).toBeUndefined();
  });

  it('keeps unknown fields of a view and unknown top-level keys beside the views', () => {
    const raw = JSON.stringify({ schemaVersion: 1, bbmHashSha256: '', views: [{ ...area, zoom: 3 }], futureThing: [1] });
    const back = JSON.parse(writeSidecar(readSidecar(raw)));
    expect(back.views[0]).toEqual({ ...area, zoom: 3 });
    expect(back.futureThing).toEqual([1]);
  });

  it('fills what a view leaves out: no area means fit, everything shows', () => {
    const s = readSidecar(JSON.stringify({ schemaVersion: 1, views: [{ id: 'a' }, { id: 'b', rect: [1, 2, 3, 4] }, { name: 'no id' }] }));
    expect(s.views).toEqual([
      { id: 'a', name: '', fit: true, rect: null, sheets: null, grid: true, labels: true },
      { id: 'b', name: '', fit: false, rect: { x: 1, y: 2, w: 3, h: 4 }, sheets: null, grid: true, labels: true },
    ]);
  });

  it('a view without an area is always fit', () => {
    expect(readView({ id: 'a', fit: false })!.fit).toBe(true);
  });
});

describe('a sidecar started without a schemaVersion', () => {
  it('is written with the current one, so it reads back', () => {
    const started = { views: [{ id: 'v', name: 'Overview', fit: true, rect: null, sheets: null, grid: false, labels: true }] };
    const text = writeSidecar(started as unknown as Sidecar);
    const back = readSidecar(text);
    expect(back.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(back.bbmHashSha256).toBe('');
    expect(back.views?.map((v) => v.name)).toEqual(['Overview']);
  });
});

describe('a sidecar file written without a schemaVersion', () => {
  it('reads as version 1, and a wrong one is still refused', () => {
    expect(readSidecar('{"views":[]}').schemaVersion).toBe(1);
    expect(() => readSidecar('{"schemaVersion":"one"}')).toThrow(/schemaVersion/);
  });
});

describe('budget limits', () => {
  // The budget is shared with the layout (area 7, Bug 1): a sidecar carries
  // it as `budgetLimits`, part number → how many the layout may use.
  it('round-trips a budget, and keeps an empty one (the layout has a budget with no limits yet)', () => {
    const limits = { '3001.1': 12, '3005.4': 0 };
    expect(readSidecar(writeSidecar({ ...baseSidecar, budgetLimits: limits })).budgetLimits).toEqual(limits);
    expect(readSidecar(writeSidecar({ ...baseSidecar, budgetLimits: {} })).budgetLimits).toEqual({});
    expect(readSidecar(writeSidecar(baseSidecar)).budgetLimits).toBeUndefined();
    expect(JSON.parse(writeSidecar(baseSidecar))).not.toHaveProperty('budgetLimits');
  });

  it('reads only whole, non-negative numbers, and is not an unknown field', () => {
    const back = readSidecar(JSON.stringify({ schemaVersion: 1, budgetLimits: { a: 3, b: -1, c: 'x', d: 2.7, e: null } }));
    expect(back.budgetLimits).toEqual({ a: 3, d: 2 });
    expect(back.extras).toBeUndefined();
    expect(readSidecar(JSON.stringify({ schemaVersion: 1, budgetLimits: [1, 2] })).budgetLimits).toBeUndefined();
  });
});
