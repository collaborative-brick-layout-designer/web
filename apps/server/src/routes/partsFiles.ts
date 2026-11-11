// Serves the part files (XML and pictures) the editor loads:
//   /parts/*                 the base BlueBrickParts library (PARTS_DIR/parts/)
//   /parts/libraries/<slug>/ libraries an admin installs (PARTS_DIR/libraries/<slug>/)
//
// The libraries route is always registered, and its folder is made at
// startup. It used to be registered only when the folder already existed,
// so on a fresh server the first library an admin downloaded was listed
// but every one of its files 404'd until the server restarted.

import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { PARTS_STATIC_OPTIONS } from '../utils/securityHeaders.js';

export async function registerPartFiles(app: FastifyInstance, partsDir: string): Promise<void> {
  const libsRoot = resolve(partsDir, 'libraries');
  try {
    mkdirSync(libsRoot, { recursive: true });
  } catch (err) {
    app.log.warn({ err }, `cannot create ${libsRoot}; installed part libraries can't be served until it exists`);
  }
  await app.register(fastifyStatic, {
    root: libsRoot,
    prefix: '/parts/libraries/',
    ...PARTS_STATIC_OPTIONS,
  });

  // The submodule organises files under PARTS_DIR/parts/ so we point there.
  const partsRoot = resolve(partsDir, 'parts');
  if (existsSync(partsRoot)) {
    await app.register(fastifyStatic, {
      root: partsRoot,
      prefix: '/parts/',
      ...PARTS_STATIC_OPTIONS,
    });
  } else {
    // The usual setup (the Docker image): no library at PARTS_DIR/parts;
    // admins install them into libraries/ (Admin › Part libraries).
    const installed = installedLibraries(libsRoot);
    if (installed > 0) {
      app.log.info(`parts: ${installed} installed part ${installed === 1 ? 'library is' : 'libraries are'} served from ${libsRoot} (none at ${partsRoot}, which is fine)`);
    } else {
      app.log.warn(
        `no parts library is installed (nothing at ${partsRoot} or in ${libsRoot}): the Parts panel will be empty. ` +
          'Install one in Admin › Part libraries (Download default library).',
      );
    }
  }
}

/** How many folders in `libraries/` hold at least one file. */
export function installedLibraries(libsRoot: string): number {
  try {
    return readdirSync(libsRoot, { withFileTypes: true }).filter((d) => {
      if (!d.isDirectory()) return false;
      try {
        return readdirSync(resolve(libsRoot, d.name)).length > 0;
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}
