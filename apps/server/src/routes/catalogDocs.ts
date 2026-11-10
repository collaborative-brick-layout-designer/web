// Layouts and venues in the public catalog: what's published, and the
// routes that hand it out.
//
// Publishing makes a cleaned COPY (catalog_item_versions), never the live
// layout or venue, which stays private and keeps changing:
//   - A layout is rebuilt from its map and sidecar into a fresh document,
//     so no edit history, no collaborators' ids, no presence. Comments,
//     chat, collaborators and share links live in other tables and aren't
//     copied. Left out: local file paths (modules' source files, the
//     export path, a desktop background picture's path), the background
//     picture itself, unknown sidecar fields, the venue's notes, and the
//     budget (how many of each part a club has is its own business).
//   - A venue keeps its plan (walls, doors, openings, obstacles, power,
//     measurements, the unit its lengths show in) and leaves out its notes
//     and any field we don't know.
//   - A summary for the public page: the size, and a layout's parts list.
//
// Routes (anyone may see a public item when the site lets signed-out
// visitors browse; owners and reviewers see a waiting version with ?v=):
//   GET /api/catalog/items/:id/snapshot   a layout's document (binary)
//   GET /api/catalog/items/:id/download   ?format=bld-layout|bbm (binary file)
//   GET /api/catalog/items/:id/venue      a venue's plan (JSON)

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import { venueLengthUnit, writeBbm, type Sidecar, type Venue } from '@cld/bbm';
import type { BbmMap } from '@cld/model';
import { BUDGET_LIMITS_KEY, decodeDoc, encodeDoc, exportBbmFromDoc, exportSidecarFromDoc, importSidecarIntoDoc, seedFromBbm } from '@cld/ydoc';
import { db, schema } from '../db/index.js';
import { can } from '../access/clubPermissions.js';
import { layoutFileBytes, smallZip } from '../privacy/exportFiles.js';
import { canModerate, catalogOn, isTrustedClub, manages, mayBrowse } from './catalog.js';
import { attachment, safeFileName } from '../utils/contentDisposition.js';

type Item = typeof schema.catalogItems.$inferSelect;
type Version = typeof schema.catalogItemVersions.$inferSelect;
const TOKEN_READ = { apiToken: 'layouts:read' } as const;

/** What the public page shows without opening the layout or venue. */
export interface CatalogSummary {
  /** Studs, rounded. */
  widthStuds: number;
  heightStuds: number;
  /** A layout: how many parts, and each part number's count (most first). */
  partCount?: number;
  parts?: { partNumber: string; count: number }[];
  /** A layout: built around a venue. */
  venue?: string | null;
}

const pick = <T extends object>(o: T, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(o).filter(([k, v]) => keys.includes(k) && v !== undefined)) as Partial<T>;

/** A venue as it's published: the plan, without notes or fields we don't know. */
export function publicVenue(v: Venue): Venue {
  const out: Venue = {
    name: typeof v.name === 'string' ? v.name : '',
    enabled: v.enabled !== false,
    minWalkwayStuds: Number(v.minWalkwayStuds) || 0,
    bounds: v.bounds,
    edges: (Array.isArray(v.edges) ? v.edges : []).map((e) => pick(e, ['kind', 'doorWidthStuds', 'label', 'poly', 'estimated']) as Venue['edges'][number]),
    obstacles: (Array.isArray(v.obstacles) ? v.obstacles : []).map((o) => pick(o, ['label', 'poly', 'kind', 'upDegrees']) as Venue['obstacles'][number]),
  };
  if (Array.isArray(v.power) && v.power.length) out.power = v.power.map((p) => pick(p, ['x', 'y', 'kind', 'label', 'amps', 'volts']) as NonNullable<Venue['power']>[number]);
  // The unit its lengths show in, so the public page reads as its owner drew it.
  if (venueLengthUnit(v) !== 'ftin') out.lengthUnit = venueLengthUnit(v);
  if (Array.isArray(v.dimensions) && v.dimensions.length) out.dimensions = v.dimensions.map((d) => pick(d, ['from', 'to', 'label', 'estimated']) as NonNullable<Venue['dimensions']>[number]);
  return out;
}

/** A layout's sidecar as it's published: no local paths, background picture, venue notes, budget or unknown fields. */
export function publicSidecar(s: Sidecar): Sidecar {
  const out: Sidecar = { schemaVersion: s.schemaVersion, bbmHashSha256: '' };
  if (s.anchoredLabels?.length) out.anchoredLabels = s.anchoredLabels;
  if (s.modules?.length) {
    out.modules = s.modules.map((m) => {
      const { sourceFile: _sourceFile, importedAt: _importedAt, ...rest } = m;
      return rest;
    });
  }
  if (s.venue) out.venue = publicVenue(s.venue);
  if (s.views?.length) out.views = s.views;
  return out;
}

/** A map as it's published: no export path (a local folder). */
function publicMap(map: BbmMap): BbmMap {
  return { ...map, exportInfo: { ...map.exportInfo, exportPath: '' } };
}

export function layoutSummary(map: BbmMap, sidecar: Sidecar | null): CatalogSummary {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const counts = new Map<string, number>();
  for (const layer of map.layers) {
    if (layer.type !== 'brick') continue;
    for (const b of layer.bricks) {
      const a = b.displayArea;
      if ([a.x, a.y, a.width, a.height].every(Number.isFinite)) {
        minX = Math.min(minX, a.x);
        minY = Math.min(minY, a.y);
        maxX = Math.max(maxX, a.x + a.width);
        maxY = Math.max(maxY, a.y + a.height);
      }
      if (b.partNumber) counts.set(b.partNumber, (counts.get(b.partNumber) ?? 0) + 1);
    }
  }
  const parts = [...counts].map(([partNumber, count]) => ({ partNumber, count })).sort((a, b) => b.count - a.count || a.partNumber.localeCompare(b.partNumber));
  return {
    widthStuds: Number.isFinite(minX) ? Math.round(maxX - minX) : 0,
    heightStuds: Number.isFinite(minY) ? Math.round(maxY - minY) : 0,
    partCount: parts.reduce((n, p) => n + p.count, 0),
    parts,
    venue: sidecar?.venue?.name || null,
  };
}

export const venueSummary = (v: Venue): CatalogSummary => ({
  widthStuds: Math.round(Number(v.bounds?.w) || 0),
  heightStuds: Math.round(Number(v.bounds?.h) || 0),
});

/**
 * The published copy of a layout document (plus its separate sidecar, for
 * layouts imported before the sidecar moved into the document), and its
 * summary. Null when the document holds no map.
 */
export function publishLayoutDoc(docBytes: Uint8Array, sidecarSnapshot: Uint8Array | null): { doc: Buffer; summary: CatalogSummary } | null {
  const src = decodeDoc(docBytes);
  try {
    const map = exportBbmFromDoc(src);
    if (!map) return null;
    let sidecar = exportSidecarFromDoc(src);
    if (!sidecar && sidecarSnapshot) {
      const s = decodeDoc(sidecarSnapshot);
      sidecar = exportSidecarFromDoc(s);
      s.destroy();
    }
    const clean = publicMap(map);
    const out = seedFromBbm(clean);
    const side = sidecar ? publicSidecar(sidecar) : null;
    if (side) importSidecarIntoDoc(out, side);
    const bytes = Buffer.from(encodeDoc(out));
    out.destroy();
    return { doc: bytes, summary: layoutSummary(clean, side) };
  } finally {
    src.destroy();
  }
}

/**
 * A published copy as it's handed out. Copies made before the budget was
 * left out still hold one, so those are cleaned again on the way out; any
 * other copy goes as it is (the key's name is in the bytes of a document
 * that has it, so most are never opened here).
 */
export function publishedDoc(stored: Uint8Array): Buffer {
  const bytes = Buffer.from(stored);
  if (!bytes.includes(BUDGET_LIMITS_KEY)) return bytes;
  return publishLayoutDoc(bytes, null)?.doc ?? bytes;
}

const WALL = 0;
const DOOR = 1;

/** A venue's plan drawn as a picture, for its card (walls dark, obstacles grey, doors marked). */
export async function venuePicture(v: Venue): Promise<Buffer | null> {
  const b = v.bounds;
  if (!b || !(b.w > 0) || !(b.h > 0)) return null;
  const pad = Math.max(b.w, b.h) * 0.04;
  const vb = `${b.x - pad} ${b.y - pad} ${b.w + 2 * pad} ${b.h + 2 * pad}`;
  const stroke = Math.max(b.w, b.h) / 200;
  const pts = (poly: { x: number; y: number }[]) => poly.map((p) => `${Number(p.x)},${Number(p.y)}`).join(' ');
  const esc = (s: string) => s.replace(/[<>&"]/g, '');
  const edges = (v.edges ?? [])
    .filter((e) => Array.isArray(e.poly) && e.poly.length > 1)
    .map((e) => {
      const color = e.kind === WALL ? '#2A2E33' : e.kind === DOOR ? '#C2412D' : '#7A8691';
      const dash = e.kind === WALL ? '' : ` stroke-dasharray="${stroke * 3} ${stroke * 2}"`;
      return `<polyline points="${pts(e.poly)}" fill="none" stroke="${color}" stroke-width="${stroke * (e.kind === WALL ? 1.6 : 1.2)}" stroke-linejoin="round"${dash}/>`;
    })
    .join('');
  const obstacles = (v.obstacles ?? [])
    .filter((o) => Array.isArray(o.poly) && o.poly.length > 2)
    .map((o) => `<polygon points="${pts(o.poly)}" fill="#B9C0C7" stroke="#7A8691" stroke-width="${stroke * 0.6}"/>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="1024" height="${Math.round((1024 * (b.h + 2 * pad)) / (b.w + 2 * pad))}"><title>${esc(String(v.name ?? ''))}</title><rect x="${b.x - pad}" y="${b.y - pad}" width="${b.w + 2 * pad}" height="${b.h + 2 * pad}" fill="#F7F5F0"/>${obstacles}${edges}</svg>`;
  try {
    return await sharp(Buffer.from(svg), { limitInputPixels: 4096 * 4096 })
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    return null;
  }
}

/** The public version's summary of each layout or venue item (by item id). */
export async function catalogSummaries(items: readonly Pick<Item, 'id' | 'kind' | 'publicVersion'>[]): Promise<Map<string, CatalogSummary>> {
  const want = items.filter((i) => (i.kind === 'layout' || i.kind === 'venue') && i.publicVersion > 0);
  const out = new Map<string, CatalogSummary>();
  if (!want.length) return out;
  const rows = await db
    .select({ itemId: schema.catalogItemVersions.itemId, version: schema.catalogItemVersions.version, summary: schema.catalogItemVersions.summary })
    .from(schema.catalogItemVersions)
    .where(inArray(schema.catalogItemVersions.itemId, want.map((i) => i.id)));
  const pub = new Map(want.map((i) => [i.id, i.publicVersion]));
  for (const r of rows) {
    if (pub.get(r.itemId) !== r.version) continue;
    const sum = readSummary(r.summary);
    if (sum) out.set(r.itemId, sum);
  }
  return out;
}

/** Parse a stored summary. */
export function readSummary(raw: string | null | undefined): CatalogSummary | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CatalogSummary;
  } catch {
    return null;
  }
}

/**
 * The version of a layout or venue item that `req` may have: the public
 * one, or (`?v=`) one waiting, for those who manage it and its reviewers.
 */
async function versionFor(req: FastifyRequest<{ Params: { id: string }; Querystring: { v?: string } }>, kind: 'layout' | 'venue'): Promise<{ item: Item; v: Version } | { code: number; error: string }> {
  const item = await db.select().from(schema.catalogItems).where(eq(schema.catalogItems.id, req.params.id)).get();
  if (!item || item.kind !== kind || !(await catalogOn(kind))) return { code: 404, error: 'not_found' };
  const n = req.query?.v ? Number(req.query.v) : item.publicVersion;
  const isPublic = item.status === 'public' && n === item.publicVersion && n > 0;
  if (!isPublic) {
    const user = req.user;
    const insider =
      !!user &&
      ((await manages(user.id, item)) ||
        canModerate(user) ||
        (!!item.ownerOrgId && (await isTrustedClub(item.ownerOrgId)) && (await can(user.id, item.ownerOrgId, 'send_catalog'))));
    if (!insider) return { code: 404, error: 'not_found' };
  } else if (!(await mayBrowse(req))) {
    return { code: 401, error: 'unauthorized' };
  }
  const v = await db
    .select()
    .from(schema.catalogItemVersions)
    .where(and(eq(schema.catalogItemVersions.itemId, item.id), eq(schema.catalogItemVersions.version, n)))
    .get();
  if (!v || !v.docSnapshot) return { code: 404, error: 'not_found' };
  return { item, v };
}

const fileName = (s: string) => safeFileName(s);

export async function catalogDocRoutes(app: FastifyInstance): Promise<void> {
  type Req = { Params: { id: string }; Querystring: { v?: string; format?: string } };

  // A layout's published document, for the read-only viewer.
  app.get<Req>('/api/catalog/items/:id/snapshot', { config: TOKEN_READ }, async (req, reply) => {
    const r = await versionFor(req, 'layout');
    if ('code' in r) return reply.code(r.code).send({ error: r.error });
    reply.header('Cache-Control', 'private, max-age=300');
    reply.header('Content-Type', 'application/octet-stream');
    return reply.send(publishedDoc(r.v.docSnapshot as Uint8Array));
  });

  // "Download .bld-layout" / ".bbm": the published layout as a file.
  app.get<Req>('/api/catalog/items/:id/download', { config: TOKEN_READ }, async (req, reply) => {
    const r = await versionFor(req, 'layout');
    if ('code' in r) return reply.code(r.code).send({ error: r.error });
    const name = fileName(r.item.title);
    if (req.query?.format === 'bbm') {
      const doc = decodeDoc(r.v.docSnapshot as Uint8Array);
      try {
        const map = exportBbmFromDoc(doc);
        if (!map) return reply.code(404).send({ error: 'not_found' });
        reply.header('Content-Type', 'application/xml; charset=utf-8');
        reply.header('Content-Disposition', attachment(`${name}.bbm`));
        return reply.send(writeBbm(map));
      } finally {
        doc.destroy();
      }
    }
    // Named with the parts its owner could use when they published it.
    const bytes = await layoutFileBytes(publishedDoc(r.v.docSnapshot as Uint8Array), null, null, null, smallZip, {
      userId: r.item.ownerUserId,
      orgId: r.item.ownerOrgId,
    });
    if (!bytes) return reply.code(404).send({ error: 'not_found' });
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', attachment(`${name}.bld-layout`));
    return reply.send(Buffer.from(bytes));
  });

  // A venue's published plan.
  app.get<Req>('/api/catalog/items/:id/venue', { config: TOKEN_READ }, async (req, reply) => {
    const r = await versionFor(req, 'venue');
    if ('code' in r) return reply.code(r.code).send({ error: r.error });
    try {
      return { name: r.item.title, venue: JSON.parse(Buffer.from(r.v.docSnapshot as Uint8Array).toString('utf8')) as Venue };
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
  });
}
