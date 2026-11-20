// The import libraries' single files, for the browser's importer
// (imports/libraryFiles.ts, docs/model-import.md "In the browser"). Signed
// in only, read only. Never a listing and never a whole library.
//
//   GET  /api/import-library                              which libraries there are, and their versions
//   GET  /api/import-library/:lib/:version/file?name=…    one part file (text); 204 when there's none
//   POST /api/import-library/:lib/:version/files          { names: string[] (≤ 256) } →
//                                                         { files: { [name]: text | null }, more: string[] }
//   GET  /api/import-library/:lib/:version/ldconfig       LDConfig.ldr (the colors)
//   GET  /api/import-library/:lib/:version/moved          { [newName]: earlierNames[] } ("~Moved to" stubs)
//   GET  /api/import-library/ldd/:version/geometry?id=…   one LDD brick's shape (Primitives/LOD0/<id>.g); 204 when there's none
//   POST /api/import-library/ldd/:version/geometry        { ids: designID[] (≤ 256) } →
//                                                         { files: { [id]: base64 | null }, more: string[] }
//   GET  /api/import-library/ldd/:version/materials       LDD's Materials.xml (its colors)
//   GET  /api/import-library/ldd-mapping/:version/ldraw-xml  the LDD → LDraw mapping
//
// LDD's database is proprietary: it is served one brick at a time to
// signed-in people (Aaron, 2026-11-19), never whole and never listed. A
// request names a design ID (digits only), never a path.
//
// :lib is "ldraw" or "studio". A version that isn't the current one is still
// answered (with the current files), but not cached, so a page open across a
// library update keeps working. A missing file is a 204 or a null, never a
// 4xx: the browser asks for names it can't know exist, and bursts of 4xx get
// a person banned by the WAF.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireUser } from '../auth/cookie.js';
import { perPerson } from '../utils/rateLimits.js';
import { importSettings } from '../imports/settings.js';
import { DESIGN_ID, lddLibrary, lddMapping, MAX_BATCH_BYTES as MAX_LDD_BATCH_BYTES, MAX_BATCH_IDS, readGeometry, readMaterials } from '../imports/lddFiles.js';
import { readFile } from 'node:fs/promises';
import {
  cleanPartName,
  library,
  MAX_BATCH_BYTES,
  MAX_BATCH_NAMES,
  movedIndex,
  readLDConfig,
  readPart,
  resolvePart,
  type LibraryName,
} from '../imports/libraryFiles.js';

const VERSION = /^[0-9a-f]{16}$/;
const IMMUTABLE = 'private, max-age=31536000, immutable';

function libName(v: string): LibraryName | null {
  return v === 'ldraw' || v === 'studio' ? v : null;
}

/** Caching for an answer under `asked`: for good when it's the current version. */
function cacheFor(reply: FastifyReply, asked: string, current: string, etag: string): void {
  if (asked === current) reply.header('cache-control', IMMUTABLE).header('etag', `"${etag}"`);
  else reply.header('cache-control', 'private, no-store');
}

export async function importLibraryRoutes(app: FastifyInstance): Promise<void> {
  // Generous: a big model is a few hundred files, asked for in batches.
  const reads = { config: { rateLimit: perPerson(600, '1 minute') } };

  app.get('/api/import-library', reads, async (req) => {
    requireUser(req);
    const { enabled } = await importSettings();
    const [ldraw, studio, ldd, mapping] = await Promise.all([library('ldraw'), library('studio'), lddLibrary(), lddMapping()]);
    return { enabled, ldraw: ldraw?.version ?? null, studio: studio?.version ?? null, ldd: ldd?.version ?? null, lddMapping: mapping?.version ?? null };
  });

  // The library, when import is on and it's installed; else the answer is sent.
  async function libOr(reply: FastifyReply, name: string) {
    const lib = libName(name) ? await library(name as LibraryName) : null;
    const { enabled } = await importSettings();
    if (!enabled) {
      void reply.code(409).send({ error: 'import_unavailable', reason: 'off' });
      return null;
    }
    if (!lib) {
      void reply.code(409).send({ error: 'no_library' });
      return null;
    }
    return lib;
  }

  app.get<{ Params: { lib: string; version: string }; Querystring: { name?: string } }>(
    '/api/import-library/:lib/:version/file',
    reads,
    async (req, reply) => {
      requireUser(req);
      if (!VERSION.test(req.params.version)) return reply.code(400).send({ error: 'invalid_version' });
      const name = cleanPartName(req.query.name);
      if (!name) return reply.code(400).send({ error: 'invalid_name' });
      const lib = await libOr(reply, req.params.lib);
      if (!lib) return reply;
      const path = await resolvePart(lib, name);
      const text = path ? await readPart(path) : null;
      cacheFor(reply, req.params.version, lib.version, `${lib.version}-${name.toLowerCase()}`);
      if (text === null) return reply.code(204).send();
      return reply.header('content-type', 'text/plain; charset=utf-8').send(text);
    },
  );

  app.post<{ Params: { lib: string; version: string }; Body: { names?: unknown } }>(
    '/api/import-library/:lib/:version/files',
    reads,
    async (req, reply) => {
      requireUser(req);
      if (!VERSION.test(req.params.version)) return reply.code(400).send({ error: 'invalid_version' });
      const raw = req.body?.names;
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BATCH_NAMES) return reply.code(400).send({ error: 'invalid_names', max: MAX_BATCH_NAMES });
      const names: string[] = [];
      for (const n of raw) {
        const clean = cleanPartName(n);
        if (!clean) return reply.code(400).send({ error: 'invalid_name' });
        names.push(n as string);
      }
      const lib = await libOr(reply, req.params.lib);
      if (!lib) return reply;
      const files: Record<string, string | null> = {};
      const more: string[] = [];
      let bytes = 0;
      for (const n of [...new Set(names)]) {
        if (bytes >= MAX_BATCH_BYTES) {
          more.push(n);
          continue;
        }
        const path = await resolvePart(lib, cleanPartName(n)!);
        const text = path ? await readPart(path) : null;
        bytes += text?.length ?? 0;
        files[n] = text;
      }
      reply.header('cache-control', 'private, no-store');
      return { version: lib.version, files, more };
    },
  );

  app.get<{ Params: { lib: string; version: string } }>('/api/import-library/:lib/:version/ldconfig', reads, async (req, reply) => {
    requireUser(req);
    if (!VERSION.test(req.params.version)) return reply.code(400).send({ error: 'invalid_version' });
    const lib = await libOr(reply, req.params.lib);
    if (!lib) return reply;
    const text = await readLDConfig(lib);
    cacheFor(reply, req.params.version, lib.version, `${lib.version}-ldconfig`);
    if (text === null) return reply.code(204).send();
    return reply.header('content-type', 'text/plain; charset=utf-8').send(text);
  });

  app.get<{ Params: { lib: string; version: string } }>('/api/import-library/:lib/:version/moved', reads, async (req, reply) => {
    requireUser(req);
    if (!VERSION.test(req.params.version)) return reply.code(400).send({ error: 'invalid_version' });
    const lib = await libOr(reply, req.params.lib);
    if (!lib) return reply;
    const moved = await movedIndex(lib);
    cacheFor(reply, req.params.version, lib.version, `${lib.version}-moved`);
    return moved;
  });

  // ---- LDD ------------------------------------------------------------------

  async function lddOr(reply: FastifyReply) {
    const { enabled } = await importSettings();
    if (!enabled) {
      void reply.code(409).send({ error: 'import_unavailable', reason: 'off' });
      return null;
    }
    const lib = await lddLibrary();
    if (!lib) {
      void reply.code(409).send({ error: 'no_library' });
      return null;
    }
    return lib;
  }

  app.get<{ Params: { version: string }; Querystring: { id?: string } }>('/api/import-library/ldd/:version/geometry', reads, async (req, reply) => {
    requireUser(req);
    if (!VERSION.test(req.params.version)) return reply.code(400).send({ error: 'invalid_version' });
    const id = req.query.id ?? '';
    if (!DESIGN_ID.test(id)) return reply.code(400).send({ error: 'invalid_id' });
    const lib = await lddOr(reply);
    if (!lib) return reply;
    const bytes = await readGeometry(lib, id);
    cacheFor(reply, req.params.version, lib.version, `${lib.version}-g-${id}`);
    if (!bytes) return reply.code(204).send();
    return reply.header('content-type', 'application/octet-stream').send(bytes);
  });

  app.post<{ Params: { version: string }; Body: { ids?: unknown } }>('/api/import-library/ldd/:version/geometry', reads, async (req, reply) => {
    requireUser(req);
    if (!VERSION.test(req.params.version)) return reply.code(400).send({ error: 'invalid_version' });
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BATCH_IDS) return reply.code(400).send({ error: 'invalid_ids', max: MAX_BATCH_IDS });
    if (!ids.every((i) => typeof i === 'string' && DESIGN_ID.test(i))) return reply.code(400).send({ error: 'invalid_id' });
    const lib = await lddOr(reply);
    if (!lib) return reply;
    const files: Record<string, string | null> = {};
    const more: string[] = [];
    let bytes = 0;
    for (const id of [...new Set(ids as string[])]) {
      if (bytes >= MAX_LDD_BATCH_BYTES) {
        more.push(id);
        continue;
      }
      const b = await readGeometry(lib, id);
      bytes += b?.length ?? 0;
      files[id] = b ? b.toString('base64') : null;
    }
    reply.header('cache-control', 'private, no-store');
    return { version: lib.version, files, more };
  });

  app.get<{ Params: { version: string } }>('/api/import-library/ldd/:version/materials', reads, async (req, reply) => {
    requireUser(req);
    if (!VERSION.test(req.params.version)) return reply.code(400).send({ error: 'invalid_version' });
    const lib = await lddOr(reply);
    if (!lib) return reply;
    const bytes = await readMaterials(lib);
    cacheFor(reply, req.params.version, lib.version, `${lib.version}-materials`);
    if (!bytes) return reply.code(204).send();
    return reply.header('content-type', 'application/xml; charset=utf-8').send(bytes);
  });

  app.get<{ Params: { version: string } }>('/api/import-library/ldd-mapping/:version/ldraw-xml', reads, async (req, reply) => {
    requireUser(req);
    if (!VERSION.test(req.params.version)) return reply.code(400).send({ error: 'invalid_version' });
    const { enabled } = await importSettings();
    if (!enabled) return reply.code(409).send({ error: 'import_unavailable', reason: 'off' });
    const mapping = await lddMapping();
    if (!mapping) return reply.code(409).send({ error: 'no_library' });
    cacheFor(reply, req.params.version, mapping.version, `${mapping.version}-ldraw-xml`);
    return reply.header('content-type', 'application/xml; charset=utf-8').send(await readFile(mapping.path));
  });
}
