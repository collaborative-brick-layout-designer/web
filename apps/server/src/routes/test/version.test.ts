// GET /api/version — what a desktop live-sync client checks first.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOC_BASE_SCHEMA, DOC_SCHEMA_VERSION } from '@cld/ydoc';
import { versionRoutes } from '../version.js';
import { DESKTOP_DOWNLOAD_URL, DESKTOP_MINIMUM, DESKTOP_RECOMMENDED, FEATURES, resetDesktopPolicy } from '../../compat.js';
import { resetDb } from '../../test/helpers.js';

describe('GET /api/version', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    resetDb();
    resetDesktopPolicy();
    app = Fastify();
    await app.register(versionRoutes);
  });
  afterEach(async () => {
    await app.close();
  });

  it('is public and reports version, protocols, the desktops it works with, and its features', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/version' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      version: '0.0.0',
      // Desktops before doc shape 2 read this one: they still connect.
      schemaVersion: 1,
      protocols: ['y-websocket/1'],
      desktop: { minimum: DESKTOP_MINIMUM, recommended: DESKTOP_RECOMMENDED, downloadUrl: DESKTOP_DOWNLOAD_URL },
      doc: { schemaVersion: 3, createdAs: 1, minReadable: 1 },
      sidecar: { schemaVersion: 1 },
      layoutFile: { version: 1 },
      features: [...FEATURES],
    });
    expect(DOC_SCHEMA_VERSION).toBe(3);
    expect(DOC_BASE_SCHEMA).toBe(1);
  });

  it('prefers APP_VERSION when set', async () => {
    process.env.APP_VERSION = '1.2.3';
    try {
      const other = Fastify();
      await other.register(versionRoutes);
      expect((await other.inject({ method: 'GET', url: '/api/version' })).json().version).toBe('1.2.3');
      await other.close();
    } finally {
      delete process.env.APP_VERSION;
    }
  });
});
