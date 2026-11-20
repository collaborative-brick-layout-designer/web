// Importing LDraw, Studio and LDD files on the website (docs/model-import.md).
// The server runs the desktop's own converter on the upload (imports/), so
// the part or layout is the one the desktop would make.
//
//   GET    /api/imports/status            can this site import, and what it has
//   POST   /api/imports                   multipart `file`: upload, start the preview
//   GET    /api/imports/:id               the job: where it is, the preview, the result
//   GET    /api/imports/:id/preview.png   the preview's picture
//   POST   /api/imports/:id/convert       the preview's choices and where it goes:
//                                         target { kind: "new" | "layout" (+ clientPlaces) | "library" }
//   DELETE /api/imports/:id               cancel, and delete its files
//   POST   /api/imports/client            what the browser's own importer made (JSON):
//                                         mode "part": { partKey, displayName, xmlBase64, spriteBase64 (PNG),
//                                         widthStuds, heightStuds, category, target, stats?, warnings?, connections? };
//                                         mode "parts": { bbm (the .bbm's text), title, target, sheets?, bricks?, warnings? }
//                                         → the same result a server job ends with
//
// Admin › Model import:
//   GET    /api/admin/imports                       converter, libraries, settings, queue
//   PATCH  /api/admin/imports                       { enabled?, limits? }
//   POST   /api/admin/imports/ldraw/download        fetch the official LDraw library
//   DELETE /api/admin/imports/ldraw
//   POST   /api/admin/imports/ldd/assets            multipart `file`: LDD's Assets.lif
//   DELETE /api/admin/imports/ldd/assets
//   POST   /api/admin/imports/ldd/mapping           multipart `file`: an ldraw.xml
//   POST   /api/admin/imports/ldd/mapping/community fetch the community ldraw.xml
//   DELETE /api/admin/imports/ldd/mapping
//   POST   /api/admin/imports/studio                multipart `file`: a zip of Studio's ldraw folder
//   DELETE /api/admin/imports/studio
//
// Desktop tokens can't call any of these: the desktop imports on its own.

import { createWriteStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireGlobalAdmin, requireUser } from '../auth/cookie.js';
import { isDemoUser } from '../demo/demoAccount.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { perPerson } from '../utils/rateLimits.js';
import { converterState, forgetConverterState, type ConverterState } from '../imports/converter.js';
import { applyLayout, applyLayoutText, applyPart, applyPartFiles, checkTarget, type ImportTarget } from '../imports/apply.js';
import {
  cancelJob,
  enqueue,
  getJob,
  jobCounts,
  MAX_OPEN_PER_USER,
  newJob,
  openJobsOf,
  positionOf,
  secondsToNextTurn,
  takeTurn,
  type Job,
} from '../imports/jobs.js';
import {
  downloadLdraw,
  fetchCommunityMapping,
  lddState,
  ldrawState,
  MAX_ASSETS_BYTES,
  MAX_LDRAW_XML_BYTES,
  MAX_LIBRARY_ZIP_BYTES,
  NotThatKindOfFile,
  removeLdd,
  removeLdraw,
  removeStudio,
  saveLddAssets,
  saveLddMappingUpload,
  saveStudioZip,
  studioState,
  UploadTooBig,
  ZipRefused,
} from '../imports/libraries.js';
import { IMPORT_SETTINGS, importSettings, saveImportSettings } from '../imports/settings.js';
import { library } from '../imports/libraryFiles.js';

/** The file types the site imports. */
export const IMPORT_EXTENSIONS = ['ldr', 'mpd', 'dat', 'io', 'lxf', 'lxfml'] as const;

/**
 * The upload's own name, safe to keep on disk (the desktop suggests the
 * part's name from it): no folders, no control or shell-special characters,
 * at most 120 characters, one of the import extensions. Null when it isn't
 * a file the site imports.
 */
export function safeModelName(raw: string): string | null {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const ext = /\.([A-Za-z]+)$/.exec(base)?.[1]?.toLowerCase();
  if (!ext || !(IMPORT_EXTENSIONS as readonly string[]).includes(ext)) return null;
  let stem = base.slice(0, base.length - ext.length - 1);
  // eslint-disable-next-line no-control-regex
  stem = stem.replace(/[\u0000-\u001f\u007f<>:"|?*`$\\]/g, '_').replace(/^[.\s-]+/, '').trim().slice(0, 110);
  return `${stem || 'model'}.${ext}`;
}

const REASONS: Record<string, string> = {
  off: 'An admin has turned importing off on this site.',
  missing: 'This server doesn’t have the import converter installed.',
  too_old: 'This server’s import converter is too old.',
  broken: 'This server’s import converter doesn’t start.',
  unsandboxed: 'This server can’t lock the import converter down, so importing is off.',
};

async function availability(): Promise<{ available: boolean; reason: string | null; message: string | null; converter: ConverterState }> {
  const settings = await importSettings();
  const converter = await converterState();
  const reason = !settings.enabled ? 'off' : converter.problem;
  return { available: !reason, reason, message: reason ? REASONS[reason] ?? null : null, converter };
}

/** What the person sees of a job. Paths on the server never leave it. */
function jobView(job: Job) {
  const a = job.analysis;
  const part = a?.part as Record<string, unknown> | undefined;
  return {
    id: job.id,
    fileName: job.fileName,
    state: job.state,
    step: job.step,
    position: positionOf(job),
    error: job.error,
    analysis: a
      ? {
          format: a.format,
          kindLabel: a.kindLabel,
          title: a.title ?? '',
          designer: a.designer ?? '',
          suggestedName: a.suggestedName ?? '',
          partKey: a.partKey ?? '',
          partError: a.partError ?? null,
          part: part
            ? {
                widthStuds: part.widthStuds,
                heightStuds: part.heightStuds,
                pxPerStud: part.pxPerStud,
                contentStuds: part.contentStuds,
                baseOnGrid: part.baseOnGrid,
                snapMargin: part.snapMargin,
                connections: part.connections,
                stats: part.stats,
                warnings: part.warnings,
                preview: `/api/imports/${job.id}/preview.png`,
              }
            : null,
          layout: a.layout ?? null,
          layoutError: a.layoutError ?? null,
        }
      : null,
    result: job.result,
  };
}

async function ownJob(req: { params: { id: string } }, userId: string): Promise<Job | null> {
  const job = getJob(req.params.id);
  return job && job.userId === userId ? job : null;
}

interface ConvertBody {
  mode?: unknown;
  quarterTurns?: unknown;
  align?: unknown;
  nudge?: unknown;
  drop?: unknown;
  name?: unknown;
  designer?: unknown;
  designerUrl?: unknown;
  category?: unknown;
  target?: unknown;
}

const s = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

function readTarget(v: unknown): ImportTarget | null {
  if (!v || typeof v !== 'object') return null;
  const t = v as Record<string, unknown>;
  if (t.kind === 'library') return { kind: 'library', ...(typeof t.orgSlug === 'string' && t.orgSlug ? { orgSlug: t.orgSlug.slice(0, 100) } : {}) };
  if (t.kind === 'new') return { kind: 'new', ...(typeof t.title === 'string' ? { title: t.title.slice(0, 200) } : {}), ...(typeof t.orgSlug === 'string' && t.orgSlug ? { orgSlug: t.orgSlug } : {}) };
  if (t.kind === 'layout' && typeof t.layoutId === 'string') {
    const at = t.at as { x?: unknown; y?: unknown } | undefined;
    const ok = at && typeof at.x === 'number' && typeof at.y === 'number' && Number.isFinite(at.x) && Number.isFinite(at.y) && Math.abs(at.x) < 1e6 && Math.abs(at.y) < 1e6;
    return {
      kind: 'layout',
      layoutId: t.layoutId,
      ...(typeof t.sheetId === 'string' && t.sheetId ? { sheetId: t.sheetId.slice(0, 100) } : {}),
      ...(ok ? { at: { x: at.x as number, y: at.y as number } } : {}),
      ...(t.clientPlaces === true ? { clientPlaces: true } : {}),
    };
  }
  return null;
}

interface ClientBody {
  mode?: unknown;
  partKey?: unknown;
  displayName?: unknown;
  xmlBase64?: unknown;
  spriteBase64?: unknown;
  widthStuds?: unknown;
  heightStuds?: unknown;
  connections?: unknown;
  category?: unknown;
  bbm?: unknown;
  title?: unknown;
  sheets?: unknown;
  stats?: unknown;
  warnings?: unknown;
  target?: unknown;
}

/** A browser import's files: a 4 MB part (custom parts' cap) or a layout, in base64 or text. */
const CLIENT_BODY_LIMIT = 96 * 1024 * 1024;

function readStats(v: unknown): { ldrawResolved: number; lddRendered: number; unresolved: number } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const n = (x: unknown) => (Number.isInteger(x) && (x as number) >= 0 ? Math.min(x as number, 10_000_000) : 0);
  return { ldrawResolved: n(o.ldrawResolved), lddRendered: n(o.lddRendered), unresolved: n(o.unresolved) };
}

/** What a finished import tells the page (a job's `result`). */
function resultOf(
  mode: 'part' | 'parts',
  applied: Extract<Awaited<ReturnType<typeof applyPartFiles>>, { ok: true }>,
  target: ImportTarget,
  extra: { stats: unknown; warnings: string[]; widthStuds: number | null; heightStuds: number | null; connections: number | null; sheets: number | null },
) {
  return {
    mode,
    layoutId: applied.layoutId,
    newLayout: target.kind === 'new',
    part: applied.part ?? null,
    placed: applied.placed,
    sheetId: applied.sheetId,
    brickIds: applied.brickIds,
    toPlace: applied.toPlace ?? null,
    ...extra,
  };
}

async function saveUpload(file: NodeJS.ReadableStream & { truncated?: boolean }, dest: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await pipeline(file as any, createWriteStream(dest));
  return !file.truncated;
}

/** What the browser's importer can do here: on, with an LDraw library, for LDraw files. */
async function browserImport(enabled: boolean) {
  const [ldraw, studio] = await Promise.all([library('ldraw'), library('studio')]);
  const available = enabled && !!ldraw;
  return { available, extensions: available ? ['ldr', 'mpd', 'dat'] : [], ldraw: ldraw?.version ?? null, studio: studio?.version ?? null };
}

async function adminView() {
  const [a, settings, ldraw, ldd, studio] = await Promise.all([availability(), importSettings(), ldrawState(), lddState(), studioState()]);
  return {
    available: a.available,
    reason: a.reason,
    message: a.message,
    converter: { path: a.converter.path, forcedBy: a.converter.forcedBy, version: a.converter.version, minimum: a.converter.minimum, problem: a.converter.problem, sandbox: a.converter.sandbox },
    enabled: settings.enabled,
    enabledSetting: settings.enabledSetting,
    enabledForcedBy: settings.enabledForcedBy,
    limits: IMPORT_SETTINGS.map((i) => ({ ...i, value: settings.limits[i.key] })),
    libraries: {
      ldraw: { ...ldraw, path: undefined },
      ldd: { present: ldd.present, forcedBy: ldd.forcedBy, bytes: ldd.bytes, installedAt: ldd.installedAt },
      lddMapping: { present: ldd.mapping.present, forcedBy: ldd.mapping.forcedBy, bytes: ldd.mapping.bytes, from: ldd.mapping.version, date: ldd.mapping.date, installedAt: ldd.mapping.installedAt },
      studio: { ...studio, path: undefined },
    },
    queue: jobCounts(),
  };
}

/** An IMPORT_* env var names the library: the page can't change it. */
class ForcedByEnv extends Error {}

function refusedFile(reply: FastifyReply, e: unknown) {
  if (e instanceof ForcedByEnv) return reply.code(409).send({ error: 'forced_by_env', message: e.message });
  if (e instanceof UploadTooBig) return reply.code(413).send({ error: 'file_too_large' });
  if (e instanceof NotThatKindOfFile || e instanceof ZipRefused) return reply.code(422).send({ error: 'not_that_kind_of_file', message: e.message });
  throw e;
}

export async function importRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/imports/status', { config: { rateLimit: perPerson(120, '1 minute') } }, async (req) => {
    requireUser(req);
    const [a, settings, ldraw, ldd, studio] = await Promise.all([availability(), importSettings(), ldrawState(), lddState(), studioState()]);
    return {
      available: a.available,
      reason: a.reason,
      message: a.message,
      extensions: IMPORT_EXTENSIONS,
      maxUploadBytes: settings.limits.maxUploadMb * 1024 * 1024,
      perHour: settings.limits.perHour,
      libraries: { ldraw: ldraw.present, ldd: ldd.present, lddMapping: ldd.mapping.present, studio: studio.present },
      // The browser's own importer (docs/model-import.md, "In the browser"):
      // the file types it reads, with the libraries' versions for its URLs.
      browser: await browserImport(settings.enabled),
    };
  });

  app.post('/api/imports', { config: { rateLimit: perPerson(30, '1 minute') } }, async (req, reply) => {
    const user = requireUser(req);
    if (isDemoUser(user)) return reply.code(403).send({ error: 'demo_account_cannot_import' });
    if (!req.isMultipart()) return reply.code(415).send({ error: 'not_multipart' });
    // A 4xx, not a 503: the site works, this feature is off (and nothing here answers 5xx).
    const a = await availability();
    if (!a.available) return reply.code(409).send({ error: 'import_unavailable', reason: a.reason, message: a.message });
    if (openJobsOf(user.id).length >= MAX_OPEN_PER_USER) return reply.code(429).send({ error: 'too_many_open_imports', max: MAX_OPEN_PER_USER });
    const { limits } = await importSettings();
    const maxBytes = limits.maxUploadMb * 1024 * 1024;
    const data = await req.file({ limits: { fileSize: maxBytes, files: 1, fields: 0, parts: 1 } });
    if (!data) return reply.code(400).send({ error: 'no_file' });
    const name = safeModelName(data.filename ?? '');
    if (!name) {
      data.file.resume();
      return reply.code(415).send({ error: 'unsupported_type', extensions: IMPORT_EXTENSIONS });
    }
    if (!(await takeTurn(user.id))) {
      data.file.resume();
      return reply.code(429).header('retry-after', String(secondsToNextTurn(user.id))).send({ error: 'import_rate_limited', perHour: limits.perHour });
    }
    const job = await newJob(user.id, name);
    try {
      if (!(await saveUpload(data.file, job.input))) {
        await cancelJob(job);
        return reply.code(413).send({ error: 'file_too_large', maxBytes });
      }
      if ((await stat(job.input)).size === 0) {
        await cancelJob(job);
        return reply.code(400).send({ error: 'empty_file' });
      }
    } catch (e) {
      await cancelJob(job);
      throw e;
    }
    enqueue(job, 'analyse');
    return reply.code(202).send(jobView(job));
  });

  app.get<{ Params: { id: string } }>('/api/imports/:id', { config: { rateLimit: perPerson(240, '1 minute') } }, async (req, reply) => {
    const user = requireUser(req);
    const job = await ownJob(req, user.id);
    if (!job) return reply.code(404).send({ error: 'not_found' });
    return jobView(job);
  });

  app.get<{ Params: { id: string } }>('/api/imports/:id/preview.png', { config: { rateLimit: perPerson(120, '1 minute') } }, async (req, reply) => {
    const user = requireUser(req);
    const job = await ownJob(req, user.id);
    if (!job || job.state !== 'ready' || !job.analysis?.part) return reply.code(404).send({ error: 'not_found' });
    try {
      const png = await readFile(join(job.dir, 'out', 'preview.png'));
      return reply.header('content-type', 'image/png').header('cache-control', 'private, no-store').send(png);
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
  });

  app.post<{ Params: { id: string }; Body: ConvertBody }>('/api/imports/:id/convert', { config: { rateLimit: perPerson(30, '1 minute') } }, async (req, reply) => {
    const user = requireUser(req);
    const job = await ownJob(req, user.id);
    if (!job) return reply.code(404).send({ error: 'not_found' });
    if (job.state !== 'ready') return reply.code(409).send({ error: 'not_ready', state: job.state });
    const body = req.body ?? {};
    const mode = body.mode === 'parts' ? 'parts' : body.mode === 'part' || body.mode === undefined ? 'part' : null;
    if (!mode) return reply.code(400).send({ error: 'invalid_mode' });
    if (mode === 'parts' && !job.analysis?.layout) return reply.code(400).send({ error: 'mode_unavailable' });
    if (mode === 'part' && !job.analysis?.part) return reply.code(400).send({ error: 'mode_unavailable' });
    const target = readTarget(body.target);
    if (!target) return reply.code(400).send({ error: 'invalid_target' });
    // Only a part can be saved to the library: placed parts need a layout.
    if (target.kind === 'library' && mode !== 'part') return reply.code(400).send({ error: 'invalid_target' });
    const allowed = await checkTarget(user, target);
    if (!allowed.ok) return reply.code(allowed.status).send({ error: allowed.error, ...(allowed.permission ? { permission: allowed.permission } : {}) });
    const align = body.align === 'bottom' || body.align === 'box' ? body.align : '';
    const nudge = Array.isArray(body.nudge) && body.nudge.length === 2 && body.nudge.every((n) => typeof n === 'number' && Number.isFinite(n)) ? (body.nudge as number[]).map((n) => Math.max(-64, Math.min(64, n))) : [0, 0];
    const drop = Array.isArray(body.drop) ? body.drop.filter((n): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < 10_000).slice(0, 10_000) : [];
    if (!(await takeTurn(user.id))) return reply.code(429).header('retry-after', String(secondsToNextTurn(user.id))).send({ error: 'import_rate_limited' });
    job.options = {
      mode,
      quarterTurns: Number.isInteger(body.quarterTurns) ? (((body.quarterTurns as number) % 4) + 4) % 4 : 0,
      align,
      nudge,
      drop,
      name: s(body.name, 200),
      designer: s(body.designer, 200),
      designerUrl: s(body.designerUrl, 500),
      author: user.displayName ?? '',
    };
    const category = s(body.category, 60);
    const title = s(job.analysis?.suggestedName, 200) || job.fileName.replace(/\.[^.]+$/, '');
    job.onConverted = async (j, r) => {
      const out = join(j.dir, 'out');
      const applied =
        mode === 'part'
          ? await applyPart(user, out, r as never, target, category)
          : await applyLayout(user, out, String(r.bbm ?? 'layout.bbm'), target, title);
      if (!applied.ok) return { code: applied.error, message: `The import couldn’t be saved (${applied.error}).` };
      return {
        mode,
        layoutId: applied.layoutId,
        newLayout: target.kind === 'new',
        part: applied.part ?? null,
        placed: applied.placed,
        sheetId: applied.sheetId,
        brickIds: applied.brickIds,
        // The editor puts these down itself, in its own undo (target "layout" with clientPlaces).
        toPlace: applied.toPlace ?? null,
        stats: r.stats ?? null,
        warnings: r.warnings ?? [],
        widthStuds: r.widthStuds ?? null,
        heightStuds: r.heightStuds ?? null,
        connections: r.connections ?? null,
        sheets: r.sheets ?? null,
      };
    };
    enqueue(job, 'convert');
    return reply.code(202).send(jobView(job));
  });

  // What the browser's own importer made (docs/model-import.md, "In the
  // browser"): saved exactly as a server job's result is, through the same
  // checks (createCustomPart for a part, readBbm and the growth limits for a
  // layout). The server doesn't run anything for it.
  app.post<{ Body: ClientBody }>(
    '/api/imports/client',
    { bodyLimit: CLIENT_BODY_LIMIT, config: { rateLimit: perPerson(30, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      if (isDemoUser(user)) return reply.code(403).send({ error: 'demo_account_cannot_import' });
      const settings = await importSettings();
      if (!settings.enabled) return reply.code(409).send({ error: 'import_unavailable', reason: 'off', message: REASONS.off });
      const body = req.body ?? {};
      const mode = body.mode === 'parts' ? 'parts' : body.mode === 'part' ? 'part' : null;
      if (!mode) return reply.code(400).send({ error: 'invalid_mode' });
      const target = readTarget(body.target);
      if (!target) return reply.code(400).send({ error: 'invalid_target' });
      if (target.kind === 'library' && mode !== 'part') return reply.code(400).send({ error: 'invalid_target' });
      const allowed = await checkTarget(user, target);
      if (!allowed.ok) return reply.code(allowed.status).send({ error: allowed.error, ...(allowed.permission ? { permission: allowed.permission } : {}) });
      const stats = readStats(body.stats);
      const warnings = Array.isArray(body.warnings) ? body.warnings.filter((w): w is string => typeof w === 'string').slice(0, 50).map((w) => w.slice(0, 500)) : [];
      if (mode === 'part') {
        const partKey = s(body.partKey, 120).replace(/[^A-Za-z0-9_\-.]/g, '_') || 'ImportedModel';
        const xml = typeof body.xmlBase64 === 'string' ? Buffer.from(body.xmlBase64, 'base64') : null;
        const sprite = typeof body.spriteBase64 === 'string' ? Buffer.from(body.spriteBase64, 'base64') : null;
        const w = body.widthStuds;
        const h = body.heightStuds;
        if (!xml?.length || !sprite?.length) return reply.code(400).send({ error: 'missing_files' });
        if (!Number.isInteger(w) || !Number.isInteger(h) || (w as number) < 1 || (h as number) < 1 || (w as number) > 4096 || (h as number) > 4096) {
          return reply.code(400).send({ error: 'invalid_size' });
        }
        const applied = await applyPartFiles(
          user,
          xml,
          sprite,
          { partKey, displayName: s(body.displayName, 200).trim(), spriteMime: 'image/png', widthStuds: w as number, heightStuds: h as number },
          target,
          s(body.category, 60),
        );
        if (!applied.ok) return reply.code(applied.status).send({ error: applied.error, ...(applied.permission ? { permission: applied.permission } : {}) });
        const connections = Number.isInteger(body.connections) ? (body.connections as number) : null;
        return resultOf('part', applied, target, { stats, warnings, widthStuds: w as number, heightStuds: h as number, connections, sheets: null });
      }
      const bbm = typeof body.bbm === 'string' ? body.bbm : '';
      if (!bbm) return reply.code(400).send({ error: 'missing_files' });
      if (Buffer.byteLength(bbm) > settings.limits.maxUploadMb * 1024 * 1024) return reply.code(413).send({ error: 'file_too_large' });
      const applied = await applyLayoutText(user, bbm, target, s(body.title, 200) || 'Imported model');
      if (!applied.ok) return reply.code(applied.status).send({ error: applied.error, ...(applied.permission ? { permission: applied.permission } : {}) });
      const sheets = Number.isInteger(body.sheets) ? (body.sheets as number) : null;
      return resultOf('parts', applied, target, { stats, warnings, widthStuds: null, heightStuds: null, connections: null, sheets });
    },
  );

  app.delete<{ Params: { id: string } }>('/api/imports/:id', { config: { rateLimit: perPerson(60, '1 minute') } }, async (req, reply) => {
    const user = requireUser(req);
    const job = await ownJob(req, user.id);
    if (!job) return reply.code(404).send({ error: 'not_found' });
    await cancelJob(job);
    return reply.code(204).send();
  });

  // ---- Admin › Model import ---------------------------------------------

  app.get('/api/admin/imports', { config: { rateLimit: perPerson(120, '1 minute') } }, async (req) => {
    requireGlobalAdmin(req);
    forgetConverterState();
    return adminView();
  });

  app.patch<{ Body: { enabled?: unknown; limits?: unknown } }>('/api/admin/imports', { config: { rateLimit: perPerson(60, '1 minute') } }, async (req, reply) => {
    const me = requireGlobalAdmin(req);
    const body = req.body ?? {};
    const err = await saveImportSettings(body, me.id);
    if (err) return reply.code(400).send({ error: 'invalid_settings', message: err });
    await writeAuditEvent({ resourceKind: 'platform_settings', resourceId: 'imports', userId: me.id, eventType: 'admin_import_settings', payload: { enabled: body.enabled, limits: body.limits } });
    return adminView();
  });

  const adminLib = (path: string, method: 'post' | 'delete', work: (req: FastifyRequest) => Promise<void>, event: string) => {
    const register = method === 'post' ? app.post.bind(app) : app.delete.bind(app);
    register(path, { config: { rateLimit: perPerson(20, '1 minute') } }, async (req, reply) => {
      const me = requireGlobalAdmin(req);
      try {
        await work(req);
      } catch (e) {
        if (e instanceof ForcedByEnv || e instanceof UploadTooBig || e instanceof NotThatKindOfFile || e instanceof ZipRefused) return refusedFile(reply, e);
        // A 4xx: the download or file didn't work out (nothing here answers 5xx).
        return reply.code(422).send({ error: 'library_failed', message: e instanceof Error ? e.message : 'failed' });
      }
      await writeAuditEvent({ resourceKind: 'platform_settings', resourceId: 'imports', userId: me.id, eventType: 'admin_import_library', payload: { what: event } });
      return adminView();
    });
  };

  const forced = async (which: 'ldraw' | 'ldd' | 'mapping' | 'studio') => {
    const st = which === 'ldraw' ? await ldrawState() : which === 'studio' ? await studioState() : which === 'ldd' ? await lddState() : (await lddState()).mapping;
    if (st.forcedBy) throw new ForcedByEnv(`${st.forcedBy} names this library on this server, so it can’t be changed here.`);
  };

  const uploadTo = async (req: FastifyRequest, max: number, save: (f: NodeJS.ReadableStream) => Promise<unknown>) => {
    if (!req.isMultipart()) throw new NotThatKindOfFile('Send the file as a form upload (multipart).');
    const data = await req.file({ limits: { fileSize: max + 1, files: 1, fields: 0, parts: 1 } });
    if (!data) throw new NotThatKindOfFile('No file was sent.');
    await save(data.file as unknown as NodeJS.ReadableStream);
    if (data.file.truncated) throw new UploadTooBig();
  };

  adminLib('/api/admin/imports/ldraw/download', 'post', async () => {
    await forced('ldraw');
    await downloadLdraw();
  }, 'admin_import_ldraw_download');
  adminLib('/api/admin/imports/ldraw', 'delete', async () => {
    await forced('ldraw');
    await removeLdraw();
  }, 'admin_import_ldraw_remove');
  adminLib('/api/admin/imports/ldd/assets', 'post', async (req) => {
    await forced('ldd');
    await uploadTo(req, MAX_ASSETS_BYTES, (f) => saveLddAssets(f as never));
  }, 'admin_import_ldd_assets');
  adminLib('/api/admin/imports/ldd/assets', 'delete', async () => {
    await forced('ldd');
    await removeLdd('assets');
  }, 'admin_import_ldd_assets_remove');
  adminLib('/api/admin/imports/ldd/mapping', 'post', async (req) => {
    await forced('mapping');
    await uploadTo(req, MAX_LDRAW_XML_BYTES, (f) => saveLddMappingUpload(f as never));
  }, 'admin_import_ldd_mapping');
  adminLib('/api/admin/imports/ldd/mapping/community', 'post', async () => {
    await forced('mapping');
    await fetchCommunityMapping();
  }, 'admin_import_ldd_mapping_community');
  adminLib('/api/admin/imports/ldd/mapping', 'delete', async () => {
    await forced('mapping');
    await removeLdd('mapping');
  }, 'admin_import_ldd_mapping_remove');
  adminLib('/api/admin/imports/studio', 'post', async (req) => {
    await forced('studio');
    await uploadTo(req, MAX_LIBRARY_ZIP_BYTES, (f) => saveStudioZip(f as never));
  }, 'admin_import_studio');
  adminLib('/api/admin/imports/studio', 'delete', async () => {
    await forced('studio');
    await removeStudio();
  }, 'admin_import_studio_remove');
}

