// Serves the parts catalog metadata. The bundled library is large
// (550+ parts) but constant per deploy — we scan it lazily once and
// cache the slim wire shape. Custom parts (per-user uploads, Phase 6.5)
// are merged in per request because they're cheap to query and we
// want them to surface immediately after upload.
//
// Response includes a `source` discriminator on every part:
//   - 'bundled' → sprite at /parts/<spritePath>
//   - 'custom'  → sprite at /api/custom-parts/<id>/sprite (auth required)

import { setVersion, withNestedSetVersions } from '../utils/setVersion.js';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { imageSize, parsePartXml, scanCatalog } from '@cld/parts-catalog';
import type { FourDBrixRemap, LDrawRemap, PartMetadata, TrackDesignerRemap } from '@cld/parts-catalog';
import { db, schema } from '../db/index.js';
import { env } from '../env.js';

interface ConnectionPointWire {
  type: string;
  x: number;
  y: number;
  angle: number;
  electricPlug: number;
  nextConnexionPreference?: number;
}

interface SubPartWire {
  /** Catalog key of the referenced part — `"<partNumber>.<colorCode>"` lowercased. */
  subKey: string;
  /** Local position in STUDS, relative to the group's origin. */
  x: number;
  y: number;
  /** Local rotation in degrees, clockwise positive. */
  angle: number;
}

interface PartWire {
  key: string;
  partNumber: string;
  colorCode: string;
  kind: 'leaf' | 'group';
  description: string;
  sortingKey: string;
  spritePath: string;
  pxPerStud: number;
  /**
   * Group-only: list of subparts that compose this `.set` part. The
   * client uses these to synthesise a thumbnail when the group has no
   * pre-rendered `.set.gif` on disk. Empty for leaf parts.
   */
  subparts: SubPartWire[];
  /** Group-only: false when the set may never be split (<CanUngroup>, flex.group); absent otherwise. */
  canUngroup?: false;
  /** BlueBrick's <NotListedInLibrary>true: only placed inside its sets, not by itself or listed; absent otherwise. */
  notListed?: true;
  /** Group-only: the set's <GroupConnectionPreferenceList> (connection index -> next); absent when none. */
  groupNextPreferred?: Record<number, number>;
  /**
   * UI category — the parent folder of the part's XML file inside the
   * parts library. Matches desktop's PartsBrowser::categoryForPath
   * (PartsBrowser.cpp:198-202): the dropdown shows e.g. "4DBrix",
   * "Baseplate", "Castle". Custom parts get the synthetic category
   * "Custom".
   */
  category: string;
  /**
   * Catalog connection points in local-part-coords (studs). Used by:
   *   - the editor's connectivity recompute
   *   - rendering connection-point markers (Phase 3 polish)
   * Empty for parts that never connect (most decorative bricks).
   */
  connections: ConnectionPointWire[];
  /**
   * Hull polygon points in pixel space (relative to sprite top-left).
   * Empty array means use the sprite bounding rect as proxy.
   */
  hullPts: { x: number; y: number }[];
  /** `<SnapMargin>` in studs (what grid snapping leaves out of the sprite); omitted when none. */
  snapMargin?: { left: number; right: number; top: number; bottom: number };
  /** `<PickShape>`: an imported part's outline rings in studs around the sprite centre; omitted when none. */
  pickShape?: { x: number; y: number }[][];
  /** `<Designer>`: who built the model an imported part was made from; omitted when none. */
  designer?: { name: string; url?: string };
  /**
   * Where this part came from. Drives sprite-URL resolution + UI
   * grouping. Defaults to 'bundled' so existing clients keep working.
   */
  source: 'bundled' | 'custom';
  /**
   * For 'custom' parts: the id of the row in `custom_parts`. Lets the
   * editor compose `/api/custom-parts/:id/sprite` without a separate
   * lookup. Always null for bundled parts.
   */
  customPartId: string | null;
  /** A custom set: no sprite of its own (its parts draw it); absent otherwise. */
  noSprite?: true;
  /** A custom set: its version (utils/setVersion.ts), so placed copies can say "Update available"; absent otherwise. */
  setVersion?: string;
  /** Earlier part numbers that resolve to this part (<OldNameList>); omitted when none. */
  oldNames?: string[];
  /** Sprite size in pixels, for the BlueBrick footprint; omitted when unreadable. */
  spriteSize?: { w: number; h: number };
  /** Map-format remaps (<LDraw>, <TrackDesigner>, <FourDBrix>), for opening and saving those maps; omitted when absent. */
  ldraw?: LDrawRemap;
  trackDesigner?: TrackDesignerRemap;
  fourDBrix?: FourDBrixRemap;
}

type MapRemaps = Pick<PartWire, 'ldraw' | 'trackDesigner' | 'fourDBrix'>;

function remapsOf(p: MapRemaps): MapRemaps {
  return {
    ...(p.ldraw ? { ldraw: p.ldraw } : {}),
    ...(p.trackDesigner ? { trackDesigner: p.trackDesigner } : {}),
    ...(p.fourDBrix ? { fourDBrix: p.fourDBrix } : {}),
  };
}

let bundledCache: { etag: string; wire: PartWire[] } | null = null;

const invalidationListeners = new Set<() => void>();

/** Run `listener` whenever the parts cache is dropped (the manifest's hashes follow it). */
export function onPartsCacheInvalidated(listener: () => void): void {
  invalidationListeners.add(listener);
}

/** Drop the in-process catalog cache so the next request triggers a rescan. */
export function invalidatePartsCache(): void {
  bundledCache = null;
  for (const l of invalidationListeners) l();
}

export async function partsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/parts/catalog', { config: { apiToken: 'parts:read' } }, async (req, reply) => {
    const bundled = await loadBundled(app);

    // Custom parts visible to this user. attachUser populates req.user
    // even on this endpoint — anonymous callers still get the bundled
    // catalog (no custom parts) so the docs site / public previews
    // can hit it without a session.
    const user = req.user;
    let customWire: PartWire[] = [];
    try {
      ({ wire: customWire } = await loadCustom(user?.id ?? null));
    } catch (err) {
      app.log.warn({ err }, 'custom parts merge failed; serving bundled only');
    }

    // The ETag hashes the custom parts this user gets, so any change to
    // them (a new set, a rename, a share or one taken back, even two in
    // the same second) is a new tag, without touching the bundled cache.
    // no-cache: the browser keeps the list but asks again every time (a
    // 304 when nothing changed), so a reload never shows the list from
    // before a set was added or renamed.
    const custom = createHash('sha1').update(JSON.stringify(customWire)).digest('base64url').slice(0, 16);
    const etag = user
      ? `"${bundled.etag.slice(1, -1)}-u-${user.id.slice(0, 8)}-${custom}"`
      : `"${bundled.etag.slice(1, -1)}-anon-${custom}"`;
    reply.header('etag', etag);
    reply.header('cache-control', 'private, no-cache');
    if (req.headers['if-none-match'] === etag) {
      return reply.code(304).send();
    }
    // A custom set's version follows the custom sets inside it.
    return { parts: withNestedSetVersions(uniqueByKey([...bundled.wire, ...customWire])) };
  });
}

/**
 * One entry per part key (case-insensitive). The same part can come from
 * the base library, a downloaded library and a custom upload; the editor
 * already draws the last one (indexParts), so the list keeps that one too
 * instead of showing the part twice.
 */
export function uniqueByKey(parts: readonly PartWire[]): PartWire[] {
  const byKey = new Map<string, PartWire>();
  for (const p of parts) {
    const k = p.key.toLowerCase();
    byKey.delete(k);
    byKey.set(k, p);
  }
  return [...byKey.values()];
}

/** Just enough of a Fastify instance to log scan problems. */
interface ScanLogger {
  log: { warn: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void };
}

/**
 * Every part key the server's installed libraries know (lower-cased,
 * old names included). The admin dashboard compares placed parts with
 * this to list the ones missing from every library.
 */
export async function bundledPartKeys(logger: ScanLogger): Promise<Set<string>> {
  const { wire } = await loadBundled(logger);
  const keys = new Set<string>();
  for (const p of wire) {
    keys.add(p.key.toLowerCase());
    for (const old of p.oldNames ?? []) keys.add(old.toLowerCase());
  }
  return keys;
}

/** The unreadable files a scan found, named (with why), the first 20, for the log. */
function unreadable(errors: readonly { path: string; message: string }[]): string[] {
  return errors.slice(0, 20).map((e) => `${e.path}: ${e.message.slice(0, 120)}`);
}

async function loadBundled(
  app: ScanLogger,
): Promise<{ etag: string; wire: PartWire[] }> {
  if (bundledCache) return bundledCache;

  const allWire: PartWire[] = [];

  // 1. Base library: PARTS_DIR/parts/ (the on-disk submodule path)
  const partsRoot = resolve(env.partsDir, 'parts');
  if (existsSync(partsRoot)) {
    try {
      const result = await scanCatalog(partsRoot);
      if (result.errors.length > 0) {
        app.log.warn({ count: result.errors.length, files: unreadable(result.errors) }, 'base library scan: some XML files unreadable');
      }
      for (const p of result.catalog.values()) allWire.push(toBundledWire(p));
    } catch (err) {
      app.log.error({ err }, 'failed to scan base parts library');
    }
  }

  // 2. Downloaded libraries: PARTS_DIR/libraries/<slug>/
  // Sprites live at PARTS_DIR/libraries/<slug>/... but are served at
  // /parts/libraries/<slug>/... — prefix spritePath accordingly.
  const libsDir = resolve(env.partsDir, 'libraries');
  if (existsSync(libsDir)) {
    const installedLibs = await db
      .select({ slug: schema.partLibraries.slug })
      .from(schema.partLibraries)
      .all();

    for (const { slug } of installedLibs) {
      if (slug === 'bluebrickparts') continue; // covered by partsRoot above
      const libDir = resolve(join(libsDir, slug));
      if (!existsSync(libDir)) continue;
      try {
        const result = await scanCatalog(libDir);
        if (result.errors.length > 0) {
          app.log.warn({ count: result.errors.length, slug, files: unreadable(result.errors) }, 'library scan: some XML files unreadable');
        }
        for (const p of result.catalog.values()) {
          allWire.push(toBundledWire(p, `libraries/${slug}/`));
        }
      } catch (err) {
        app.log.warn({ err, slug }, 'failed to scan library directory');
      }
    }
  }

  const etag = `"${Date.now().toString(36)}-${allWire.length}"`;
  bundledCache = { etag, wire: allWire };
  return bundledCache;
}

/** Custom-part columns needed for the catalog — no xml/sprite blobs. */
const customCatalogColumns = {
  id: schema.customParts.id,
  partNumber: schema.customParts.partNumber,
  displayName: schema.customParts.displayName,
  isGlobal: schema.customParts.isGlobal,
  ownerOrgId: schema.customParts.ownerOrgId,
  category: schema.customParts.category,
  /** '' for a set (no sprite of its own). */
  spriteMime: schema.customParts.spriteMime,
  updatedAt: schema.customParts.updatedAt,
};
export type CustomCatalogRow = {
  [K in keyof typeof customCatalogColumns]: (typeof schema.customParts.$inferSelect)[K];
};

interface ParsedCustomXml {
  connections: ConnectionPointWire[];
  pxPerStud: number;
  kind: 'leaf' | 'group';
  subparts?: SubPartWire[];
  canUngroup?: false;
  notListed?: true;
  hullPts: { x: number; y: number }[];
  snapMargin?: PartWire['snapMargin'];
  pickShape?: PartWire['pickShape'];
  designer?: PartWire['designer'];
  spriteSize?: { w: number; h: number };
  remaps?: MapRemaps;
  setVersion?: string;
}

/**
 * Parsed-XML cache keyed by part id and validated by updatedAt, so the
 * catalog endpoint doesn't reload every XML blob and re-parse it on every
 * request. Bounded; oldest entries are dropped first.
 */
const parsedCustomCache = new Map<string, { updatedAt: number; parsed: ParsedCustomXml }>();
const PARSED_CUSTOM_CACHE_MAX = 5000;

async function parsedCustomXml(rows: CustomCatalogRow[]): Promise<Map<string, ParsedCustomXml>> {
  const out = new Map<string, ParsedCustomXml>();
  const misses: CustomCatalogRow[] = [];
  for (const r of rows) {
    const hit = parsedCustomCache.get(r.id);
    if (hit && hit.updatedAt === r.updatedAt.getTime()) out.set(r.id, hit.parsed);
    else misses.push(r);
  }
  // Fetch blobs only for the misses, in bounded batches.
  for (let i = 0; i < misses.length; i += 200) {
    const batch = misses.slice(i, i + 200);
    const blobs = await db
      .select({ id: schema.customParts.id, xmlBlob: schema.customParts.xmlBlob, spriteBlob: schema.customParts.spriteBlob })
      .from(schema.customParts)
      .where(inArray(schema.customParts.id, batch.map((r) => r.id)));
    const byId = new Map(blobs.map((b) => [b.id, b]));
    for (const r of batch) {
      const row = byId.get(r.id);
      if (!row) continue;
      const parsed = parseCustomXml(r.partNumber, row.xmlBlob as Uint8Array);
      const size = imageSize(row.spriteBlob as Uint8Array);
      if (size) parsed.spriteSize = size;
      out.set(r.id, parsed);
      parsedCustomCache.delete(r.id);
      parsedCustomCache.set(r.id, { updatedAt: r.updatedAt.getTime(), parsed });
      while (parsedCustomCache.size > PARSED_CUSTOM_CACHE_MAX) {
        const oldest = parsedCustomCache.keys().next().value;
        if (oldest === undefined) break;
        parsedCustomCache.delete(oldest);
      }
    }
  }
  return out;
}

/** Custom parts `userId` can see (all global ones when null), each once. */
export async function visibleCustomParts(userId: string | null): Promise<CustomCatalogRow[]> {
  // Four sources of custom parts a user can see:
  //   0. isGlobal === true (visible to everyone, including anonymous)
  //   1. ownerUserId === user.id
  //   2. ownerOrgId joined to org_members where user.id matches
  //   3. explicit collaborator on custom_part_collaborators
  const globals = await db
    .select(customCatalogColumns)
    .from(schema.customParts)
    .where(eq(schema.customParts.isGlobal, true));

  let rows: CustomCatalogRow[] = globals;
  if (userId) {
    const personal = await db
      .select(customCatalogColumns)
      .from(schema.customParts)
      .where(eq(schema.customParts.ownerUserId, userId));
    const orgOwned = await db
      .select({ part: customCatalogColumns })
      .from(schema.orgMembers)
      .innerJoin(
        schema.customParts,
        eq(schema.customParts.ownerOrgId, schema.orgMembers.orgId),
      )
      .where(eq(schema.orgMembers.userId, userId));
    const shared = await db
      .select({ part: customCatalogColumns })
      .from(schema.customPartCollaborators)
      .innerJoin(
        schema.customParts,
        eq(schema.customParts.id, schema.customPartCollaborators.customPartId),
      )
      .where(eq(schema.customPartCollaborators.userId, userId));
    const seen = new Set<string>();
    rows = [];
    for (const part of [
      ...globals,
      ...personal,
      ...orgOwned.map((o) => o.part),
      ...shared.map((s) => s.part),
    ]) {
      if (seen.has(part.id)) continue;
      seen.add(part.id);
      rows.push(part);
    }
  }
  return rows;
}

async function loadCustom(userId: string | null): Promise<{ wire: PartWire[] }> {
  const rows = await visibleCustomParts(userId);
  const parsed = await parsedCustomXml(rows);
  return { wire: rows.map((r) => customRowToWire(r, parsed.get(r.id))) };
}

function toBundledWire(p: PartMetadata, spritePrefix = ''): PartWire {
  return {
    key: p.key,
    partNumber: p.partNumber,
    colorCode: p.colorCode,
    kind: p.kind,
    description: pickDescription(p.descriptions),
    sortingKey: p.sortingKey,
    spritePath: p.spritePath ? spritePrefix + p.spritePath : p.spritePath,
    pxPerStud: p.pxPerStud,
    category: categoryFromXmlRelPath(p.xmlRelPath ?? ''),
    connections: p.connections.map((c) => ({
      type: c.type,
      x: c.x,
      y: c.y,
      angle: c.angle,
      electricPlug: c.electricPlug,
      ...(c.nextConnexionPreference !== undefined && { nextConnexionPreference: c.nextConnexionPreference }),
    })),
    subparts: p.subparts.map((s) => ({
      subKey: s.subKey,
      x: s.x,
      y: s.y,
      angle: s.angle,
    })),
    hullPts: p.hullPts,
    ...(p.snapMargin ? { snapMargin: p.snapMargin } : {}),
    ...(p.pickShape ? { pickShape: p.pickShape } : {}),
    ...(p.kind === 'group' && p.canUngroup === false ? { canUngroup: false as const } : {}),
    ...(p.notListed ? { notListed: true as const } : {}),
    ...(p.kind === 'group' && p.groupNextPreferred ? { groupNextPreferred: p.groupNextPreferred } : {}),
    ...(p.oldNames?.length ? { oldNames: p.oldNames } : {}),
    ...(p.spriteSize ? { spriteSize: p.spriteSize } : {}),
    ...remapsOf(p),
    source: 'bundled',
    customPartId: null,
  };
}

/**
 * `xmlRelPath` is library-relative, e.g. `4DBrix/TS_TRACK18S.8.xml`
 * (or `.set.xml` for groups). The first path component is the parent
 * folder = desktop category (PartsBrowser.cpp:198-202 —
 * `QFileInfo(absPath).dir().dirName()`). Earlier we derived this from
 * `spritePath` instead, which broke for groups that ship no
 * pre-rendered `.set.gif` — they all bucketed into "Other" and the
 * Parts panel's category dropdown effectively hid them.
 */
export function categoryFromXmlRelPath(xmlRelPath: string): string {
  // The folder the file is in, like desktop: a library that keeps its
  // parts one level down (`parts/Train/…`) still files them under Train.
  const dirs = xmlRelPath.split('/').slice(0, -1).filter((d) => d.length > 0);
  return dirs.length > 0 ? dirs[dirs.length - 1]! : 'Other';
}

function parseCustomXml(partNumber: string, xmlBlob: Uint8Array): ParsedCustomXml {
  // Parse the stored XML to extract connection points + pxPerStud so
  // the connectivity recompute treats custom parts the same way as
  // bundled. Wrap in try/catch — a malformed upload shouldn't break
  // the whole catalog response.
  let connections: ConnectionPointWire[] = [];
  let pxPerStud = 8;
  let kind: 'leaf' | 'group' = 'leaf';
  let subparts: SubPartWire[] = [];
  let canUngroup: false | undefined;
  let notListed: true | undefined;
  let hullPts: { x: number; y: number }[] = [];
  let remaps: MapRemaps = {};
  let snapMargin: PartWire['snapMargin'];
  let pickShape: PartWire['pickShape'];
  let designer: PartWire['designer'];
  let version: string | undefined;
  try {
    const xml = Buffer.from(xmlBlob).toString('utf8');
    const parsed = parsePartXml(xml, {
      partNumber,
      colorCode: '',
      spritePath: '',
    });
    connections = parsed.connections.map((c) => ({
      type: c.type,
      x: c.x,
      y: c.y,
      angle: c.angle,
      electricPlug: c.electricPlug,
      ...(c.nextConnexionPreference !== undefined && { nextConnexionPreference: c.nextConnexionPreference }),
    }));
    pxPerStud = parsed.pxPerStud;
    kind = parsed.kind;
    subparts = parsed.subparts.map((s) => ({ subKey: s.subKey, x: s.x, y: s.y, angle: s.angle }));
    if (parsed.kind === 'group' && parsed.canUngroup === false) canUngroup = false;
    if (parsed.notListed) notListed = true;
    hullPts = parsed.hullPts;
    snapMargin = parsed.snapMargin;
    pickShape = parsed.pickShape;
    designer = parsed.designer;
    remaps = remapsOf(parsed);
    if (parsed.kind === 'group' && subparts.length > 0) version = setVersion({ name: parsed.descriptions.en ?? '', subparts });
  } catch {
    /* malformed — fall back to defaults; the part still renders as a sprite */
  }
  return { connections, pxPerStud, kind, ...(subparts.length ? { subparts } : {}), ...(canUngroup === false ? { canUngroup } : {}), ...(notListed ? { notListed } : {}), hullPts, remaps, ...(snapMargin ? { snapMargin } : {}), ...(pickShape ? { pickShape } : {}), ...(designer ? { designer } : {}), ...(version ? { setVersion: version } : {}) };
}

function customRowToWire(p: CustomCatalogRow, parsed: ParsedCustomXml | undefined): PartWire {
  const { connections, pxPerStud, kind, subparts, canUngroup, notListed, hullPts, snapMargin, pickShape, designer, spriteSize, remaps, setVersion: version } = parsed ?? {
    connections: [],
    pxPerStud: 8,
    kind: 'leaf' as const,
    hullPts: [],
  };
  // The "key" namespace is `custom:<id>` so it can never collide with
  // a bundled part's `<partNumber>.<colorCode>` slug.
  return {
    key: `custom:${p.id}`,
    partNumber: p.partNumber,
    colorCode: '',
    kind,
    description: p.displayName,
    // Group all custom parts under a high-numbered sortingKey so they
    // sort to the end of the bundled list. Override per-owner if we
    // want finer grouping later.
    sortingKey: p.isGlobal ? 'Z0-global-custom' : p.ownerOrgId ? 'Z2-org-custom' : 'Z1-my-custom',
    // Empty bundled-relative path; the editor uses `customPartId` to
    // build the sprite URL instead.
    spritePath: '',
    pxPerStud,
    category: p.category || 'Custom',
    connections,
    // A set (uploaded without a sprite) lists its parts, by part number.
    subparts: subparts ?? [],
    ...(canUngroup === false ? { canUngroup } : {}),
    ...(notListed ? { notListed } : {}),
    ...(p.spriteMime === '' ? { noSprite: true as const } : {}),
    ...(version ? { setVersion: version } : {}),
    hullPts,
    ...(snapMargin ? { snapMargin } : {}),
    ...(designer ? { designer } : {}),
    ...(pickShape ? { pickShape } : {}),
    ...(spriteSize ? { spriteSize } : {}),
    ...remaps,
    source: 'custom',
    customPartId: p.id,
  };
}

/**
 * Pick the user-visible description for a part. Mirrors desktop's
 * `makePartItem` (PartsBrowser.cpp:215-221): prefer English, otherwise
 * fall back to the FIRST description in iteration order (whichever
 * language the XML happened to put first).
 */
function pickDescription(descriptions: Record<string, string>): string {
  if (descriptions.en) return descriptions.en;
  for (const v of Object.values(descriptions)) {
    if (v) return v;
  }
  return '';
}
