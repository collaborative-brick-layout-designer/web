// The server against compat/compat.json, the file the desktop app's tests
// read too: the same versions, features and answers on both sides.

import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION as SIDECAR_SCHEMA_VERSION } from '@cld/bbm';
import { DOC_BASE_SCHEMA, DOC_MIN_READABLE, DOC_SCHEMA_VERSION, canReadDoc } from '@cld/ydoc';
import { PLATFORM_SETTINGS_ID, getPlatformSettings } from './auth/platformSettings.js';
import {
  DESKTOP_DOWNLOAD_URL,
  DESKTOP_MINIMUM,
  DESKTOP_RECOMMENDED,
  DESKTOP_UA,
  FEATURES,
  compareVersions,
  desktopStanding,
  desktopVersionOf,
  registerDesktopGate,
  resetDesktopPolicy,
  resolvePolicy,
} from './compat.js';
import { LAYOUT_FILE_VERSION, PROTOCOLS, versionRoutes } from './routes/version.js';
import { db, resetDb, schema } from './test/helpers.js';

interface Compat {
  desktop: { minimum: string; recommended: string; downloadUrl: string; userAgentPattern: string };
  doc: { schemaVersion: number; createdAs: number; minReadable: number };
  sidecar: { schemaVersion: number };
  layoutFile: { version: number };
  protocols: string[];
  features: { id: string; label: string }[];
  serverFeatures: string[];
  desktopUses: string[];
  assumedWhenUnlisted: string[];
  cases: {
    versionCompare: { a: string; b: string; cmp: number | null }[];
    userAgent: { ua: string; version: string | null }[];
    standing: { app: string; minimum: string; recommended: string; expect: string }[];
    docReadable: { doc: number | null; schemaVersion: number; minReadable: number; expect: boolean }[];
  };
}

const compat = JSON.parse(readFileSync(new URL('../../../compat/compat.json', import.meta.url), 'utf8')) as Compat;

describe('compat/compat.json', () => {
  it('holds the versions this server uses', () => {
    expect(DESKTOP_MINIMUM).toBe(compat.desktop.minimum);
    expect(DESKTOP_RECOMMENDED).toBe(compat.desktop.recommended);
    expect(DESKTOP_DOWNLOAD_URL).toBe(compat.desktop.downloadUrl);
    expect(DESKTOP_UA.source).toBe(new RegExp(compat.desktop.userAgentPattern).source);
    expect(DOC_SCHEMA_VERSION).toBe(compat.doc.schemaVersion);
    expect(DOC_BASE_SCHEMA).toBe(compat.doc.createdAs);
    expect(DOC_MIN_READABLE).toBe(compat.doc.minReadable);
    expect(SIDECAR_SCHEMA_VERSION).toBe(compat.sidecar.schemaVersion);
    expect(LAYOUT_FILE_VERSION).toBe(compat.layoutFile.version);
    expect([...PROTOCOLS]).toEqual(compat.protocols);
  });

  it('lists every feature this server has, and the desktop needs none it lacks', () => {
    expect([...FEATURES]).toEqual(compat.serverFeatures);
    const known = compat.features.map((f) => f.id);
    for (const f of [...compat.serverFeatures, ...compat.desktopUses, ...compat.assumedWhenUnlisted]) {
      expect(known).toContain(f);
    }
    for (const f of compat.desktopUses) expect(FEATURES).toContain(f);
  });

  it.each(compat.cases.versionCompare)('compares $a with $b', ({ a, b, cmp }) => {
    expect(compareVersions(a, b)).toBe(cmp);
    if (cmp !== null) expect(compareVersions(b, a)).toBe(cmp === 0 ? 0 : -cmp);
  });

  it.each(compat.cases.userAgent)('reads the desktop version in "$ua"', ({ ua, version }) => {
    expect(desktopVersionOf(ua)).toBe(version);
  });

  it.each(compat.cases.standing)('$app against $minimum / $recommended is $expect', (c) => {
    expect(desktopStanding(c.app, c.minimum, c.recommended)).toBe(c.expect);
  });

  it.each(compat.cases.docReadable)('a doc at $doc read by $schemaVersion (from $minReadable): $expect', (c) => {
    expect(canReadDoc(c.doc, c.schemaVersion, c.minReadable)).toBe(c.expect);
  });
});

describe('the oldest desktop allowed', () => {
  it("never goes below the code's minimum, and lifts the recommendation with it", () => {
    expect(resolvePolicy(null)).toEqual({ minimum: DESKTOP_MINIMUM, recommended: DESKTOP_RECOMMENDED });
    expect(resolvePolicy('1.0.0')).toEqual({ minimum: DESKTOP_MINIMUM, recommended: DESKTOP_RECOMMENDED });
    expect(resolvePolicy('9.1.0')).toEqual({ minimum: '9.1.0', recommended: '9.1.0' });
  });
});

describe('desktop gate', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    resetDb();
    resetDesktopPolicy();
    app = Fastify();
    registerDesktopGate(app);
    await app.register(versionRoutes);
    app.get('/api/layouts', async () => ({ layouts: [] }));
  });
  afterEach(async () => {
    resetDesktopPolicy();
    await app.close();
  });

  const as = (ua: string, url = '/api/layouts') => app.inject({ method: 'GET', url, headers: { 'user-agent': ua } });

  it('tells a desktop older than the minimum to update, with where to get it', async () => {
    const res = await as('BrickLayoutDesigner/1.1.0 (desktop)');
    expect(res.statusCode).toBe(426);
    expect(res.json()).toEqual({
      error: 'update_required',
      message: `This server needs Collaborative Brick Layout Designer ${DESKTOP_MINIMUM} or newer. Please download the new version.`,
      minimum: DESKTOP_MINIMUM,
      downloadUrl: compat.desktop.downloadUrl,
    });
  });

  it('lets it read /api/version, and lets newer desktops and browsers through', async () => {
    expect((await as('BrickLayoutDesigner/1.1.0 (desktop)', '/api/version')).statusCode).toBe(200);
    expect((await as(`BrickLayoutDesigner/${DESKTOP_MINIMUM} (desktop)`)).statusCode).toBe(200);
    expect((await as('Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0')).statusCode).toBe(200);
  });

  it('knows the desktop under its new name as well as its old one', async () => {
    expect((await as('CollaborativeBrickLayoutDesigner/1.1.0 (desktop)')).statusCode).toBe(426);
    expect((await as('CollaborativeBrickLayoutDesigner/1.1.0 (desktop)', '/api/version')).statusCode).toBe(200);
    expect((await as(`CollaborativeBrickLayoutDesigner/${DESKTOP_MINIMUM} (desktop)`)).statusCode).toBe(200);
    expect((await as('BrickLayoutDesigner/1.1.0 (desktop)')).statusCode).toBe(426);
  });

  it('follows the minimum an admin sets', async () => {
    await getPlatformSettings();
    db.update(schema.platformSettings)
      .set({ minDesktopVersion: '1.3.0' })
      .where(eq(schema.platformSettings.id, PLATFORM_SETTINGS_ID))
      .run();
    resetDesktopPolicy();
    expect((await as('BrickLayoutDesigner/1.2.0 (desktop)')).statusCode).toBe(426);
    expect((await as('BrickLayoutDesigner/1.3.0 (desktop)')).statusCode).toBe(200);
    const version = (await as('BrickLayoutDesigner/1.2.0 (desktop)', '/api/version')).json();
    expect(version.desktop).toEqual({ minimum: '1.3.0', recommended: DESKTOP_RECOMMENDED, downloadUrl: DESKTOP_DOWNLOAD_URL });
  });
});
