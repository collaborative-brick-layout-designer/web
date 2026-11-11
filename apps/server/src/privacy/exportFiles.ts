// The files in a data download: what a person (or a club) owns, in the
// formats the apps open. Layouts and modules as .bld-layout files (the
// one-file layout format both apps open, references/LAYOUT-FILE.md), with
// their background picture inside; custom parts as their XML and picture;
// venues as JSON; collection and catalog item covers as pictures; the
// layouts and venues published to the catalog, as they are there.

import { withCustomPartNumbers, type PartViewer } from '../utils/customPartNumbers.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { writeBbm, writeSidecar } from '@cld/bbm';
import { decodeDoc, exportBbmFromDoc, exportSidecarFromDoc } from '@cld/ydoc';
import { db, schema } from '../db/index.js';
import { env } from '../env.js';
import { currentDocBytes } from '../routes/layouts.js';
import { trashContent, trashIdsOf } from '../trash/trash.js';
import { crc32 as crc32Of, type ZipFileWriter } from './zipWriter.js';

export type Owner = { kind: 'user' | 'org'; id: string };

const ownerViewer = (owner: Owner): PartViewer => (owner.kind === 'user' ? { userId: owner.id } : { orgId: owner.id });

const BG_EXTS = ['png', 'jpg', 'gif', 'webp'] as const;

/** The background picture saved for a layout, if any. */
export function backgroundImagePath(layoutId: string): { path: string; ext: string } | null {
  const dir = join(dirname(env.dbPath), 'bgimages');
  for (const ext of BG_EXTS) {
    const p = join(dir, `${layoutId}.${ext}`);
    if (existsSync(p)) return { path: p, ext };
  }
  return null;
}

/** A plain file name from a title. */
export function fileTitle(s: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are what this strips
  const cleaned = s.replace(/[\\/:*?"<>|\x00-\x1F]+/g, '_').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 80) : fallback;
}

/**
 * A layout (or module) document as a .bld-layout zip, built in memory
 * (one layout at a time). Null when the document holds no map yet.
 */
export async function layoutFileBytes(
  docBytes: Uint8Array,
  sidecarSnapshot: Uint8Array | null,
  background: { bytes: Uint8Array; ext: string } | null,
  source: { layoutId: string; title: string } | null,
  zipOf: (entries: { name: string; data: Uint8Array }[]) => Uint8Array,
  /** Whose custom parts may be named by part number (customPartNumbers.ts). */
  viewer: PartViewer,
): Promise<Uint8Array | null> {
  const doc = decodeDoc(docBytes);
  try {
    const exported = exportBbmFromDoc(doc);
    if (!exported) return null;
    // Named by part number, so BlueBrick and the desktop find the server's custom parts.
    const map = await withCustomPartNumbers(exported, viewer);
    const manifest: Record<string, unknown> = { format: 'bld-layout', generator: 'Collaborative Brick Layout Designer (server data download)', version: 1 };
    if (source) {
      manifest.source = { server: new URL(env.publicUrl).origin, layoutId: source.layoutId, title: source.title, exportedAt: new Date().toISOString() };
    }
    const entries: { name: string; data: Uint8Array }[] = [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
      { name: 'layout.bbm', data: Buffer.from(writeBbm(map), 'utf8') },
    ];
    const sidecar = exportSidecarFromDoc(doc) ?? (sidecarSnapshot ? exportSidecarFromDoc(decodeDoc(sidecarSnapshot)) : null);
    if (sidecar) {
      const json = JSON.parse(writeSidecar(sidecar)) as Record<string, unknown>;
      delete json.bbmHashSha256;
      const bg = json.backgroundImage as Record<string, unknown> | undefined;
      if (bg && background) {
        const name = `background.${background.ext}`;
        delete bg.url;
        delete bg.path;
        bg.file = name;
        entries.push({ name, data: background.bytes });
      }
      entries.push({ name: 'sidecar.json', data: Buffer.from(JSON.stringify(json, null, 2)) });
    }
    return zipOf(entries);
  } finally {
    doc.destroy();
  }
}

/** A zip in memory (stored entries), for one .bld-layout inside the download. */
export function smallZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    const crc = crc32Of(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    parts.push(local, name, data);
    central.push(c, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, eocd] as unknown as Uint8Array<ArrayBuffer>[]);
}

const ownerWhere = <T extends { ownerUserId: unknown; ownerOrgId: unknown }>(t: T, o: Owner) =>
  o.kind === 'user' ? eq(t.ownerUserId as never, o.id) : eq(t.ownerOrgId as never, o.id);

/** What went into the folders, for the README. */
export interface FileCounts {
  layouts: number;
  modules: number;
  parts: number;
  venues: number;
  covers: number;
  /** Layouts and venues published to the catalog (the public copies). */
  catalog: number;
  /** Layouts, modules and venues waiting in Recently deleted. */
  deleted: number;
  /** Things that could not be turned into a file (kept as raw data instead). */
  raw: number;
}

/** Write everything `owner` owns into the zip's folders. */
export async function writeOwnedFiles(zip: ZipFileWriter, owner: Owner): Promise<FileCounts> {
  const s = schema;
  const counts: FileCounts = { layouts: 0, modules: 0, parts: 0, venues: 0, covers: 0, catalog: 0, deleted: 0, raw: 0 };

  // Layouts: one at a time, so a big library never sits in memory at once.
  const layouts = await db.select({ id: s.layouts.id, title: s.layouts.title }).from(s.layouts).where(ownerWhere(s.layouts, owner)).all();
  for (const l of layouts) {
    const row = await db.select().from(s.layouts).where(eq(s.layouts.id, l.id)).get();
    if (!row) continue;
    const bytes = await currentDocBytes(row.id, row.docSnapshot as Uint8Array);
    const bg = backgroundImagePath(row.id);
    const file = await layoutFileBytes(
      bytes,
      row.sidecarSnapshot as Uint8Array | null,
      bg ? { bytes: readFileSync(bg.path), ext: bg.ext } : null,
      { layoutId: row.id, title: row.title },
      smallZip,
      ownerViewer(owner),
    );
    const name = fileTitle(row.title, 'layout');
    if (file) {
      zip.add(`layouts/${name}.bld-layout`, file);
    } else {
      zip.add(`layouts/${name}.ydoc`, bytes);
      counts.raw++;
    }
    counts.layouts++;
  }

  const modules = await db.select({ id: s.modules.id }).from(s.modules).where(ownerWhere(s.modules, owner)).all();
  for (const m of modules) {
    const row = await db.select().from(s.modules).where(eq(s.modules.id, m.id)).get();
    if (!row) continue;
    const name = fileTitle(row.title, 'module');
    const bytes = row.docSnapshot as Uint8Array;
    let file: Uint8Array | null;
    try {
      file = await layoutFileBytes(bytes, row.sidecarSnapshot as Uint8Array | null, null, null, smallZip, ownerViewer(owner));
    } catch {
      file = null;
    }
    if (file) zip.add(`modules/${name}.bld-layout`, file);
    else {
      zip.add(`modules/${name}.ydoc`, bytes);
      counts.raw++;
    }
    if (row.thumbnail) zip.add(`modules/${name}.${row.thumbnailMime === 'image/webp' ? 'webp' : 'png'}`, row.thumbnail as Uint8Array);
    counts.modules++;
  }

  const parts = await db.select({ id: s.customParts.id }).from(s.customParts).where(ownerWhere(s.customParts, owner)).all();
  for (const p of parts) {
    const row = await db.select().from(s.customParts).where(eq(s.customParts.id, p.id)).get();
    if (!row) continue;
    const name = fileTitle(row.partNumber, 'part');
    zip.add(`parts/${name}.xml`, row.xmlBlob as Uint8Array);
    zip.add(`parts/${name}.${row.spriteMime === 'image/png' ? 'png' : 'gif'}`, row.spriteBlob as Uint8Array);
    counts.parts++;
  }

  const venues = await db.select().from(s.venueLibrary).where(ownerWhere(s.venueLibrary, owner)).all();
  for (const v of venues) {
    let data: unknown = v.data;
    try {
      data = JSON.parse(v.data);
    } catch {
      /* kept as text */
    }
    zip.add(`venues/${fileTitle(v.name, 'venue')}.json`, JSON.stringify({ name: v.name, venue: data }, null, 2));
    counts.venues++;
  }

  // Recently deleted: what waits there is still the owner's, so it comes
  // too, as the same kinds of files (one at a time: each can be big).
  for (const id of await trashIdsOf(owner)) {
    const t = await trashContent(id);
    if (!t) continue;
    const name = fileTitle(t.title, t.kind);
    if (t.kind === 'venue') {
      if (!t.venue) continue;
      let data: unknown = t.venue.data;
      try {
        data = JSON.parse(t.venue.data);
      } catch {
        /* kept as text */
      }
      zip.add(`recently-deleted/venues/${name}.json`, JSON.stringify({ name: t.venue.name, venue: data }, null, 2));
      counts.deleted++;
      continue;
    }
    if (!t.doc) continue;
    const folder = `recently-deleted/${t.kind === 'layout' ? 'layouts' : 'modules'}`;
    let file: Uint8Array | null;
    try {
      file = await layoutFileBytes(
        t.doc,
        t.sidecar ?? null,
        t.kind === 'layout' && t.picture ? t.picture : null,
        t.kind === 'layout' ? { layoutId: t.itemId, title: t.title } : null,
        smallZip,
        ownerViewer(owner),
      );
    } catch {
      file = null;
    }
    if (file) zip.add(`${folder}/${name}.bld-layout`, file);
    else {
      zip.add(`${folder}/${name}.ydoc`, t.doc);
      counts.raw++;
    }
    if (t.kind === 'module' && t.thumbnail) zip.add(`${folder}/${name}.${t.thumbnail.ext}`, t.thumbnail.bytes);
    counts.deleted++;
  }

  const collections = await db
    .select({ id: s.catalogCollections.id, title: s.catalogCollections.title })
    .from(s.catalogCollections)
    .where(
      owner.kind === 'user'
        ? and(eq(s.catalogCollections.ownerUserId, owner.id), isNull(s.catalogCollections.orgId))
        : eq(s.catalogCollections.orgId, owner.id),
    )
    .all();
  // A club's logo.
  if (owner.kind === 'org') {
    const logo = await db.select({ image: s.clubLogos.image }).from(s.clubLogos).where(eq(s.clubLogos.orgId, owner.id)).get();
    if (logo) {
      zip.add('club-logo.webp', logo.image as Uint8Array);
      counts.covers++;
    }
  }
  for (const c of collections) {
    const covers = await db.select().from(s.catalogCollectionCovers).where(eq(s.catalogCollectionCovers.collectionId, c.id)).all();
    for (const cover of covers) {
      zip.add(`covers/${fileTitle(c.title, 'collection')}.webp`, cover.image as Uint8Array);
      counts.covers++;
    }
  }

  // Catalog items' uploaded pictures, and the layouts and venues published
  // to the catalog (each as it is in the catalog now, in catalog/).
  const items = await db
    .select({ id: s.catalogItems.id, title: s.catalogItems.title, kind: s.catalogItems.kind, publicVersion: s.catalogItems.publicVersion })
    .from(s.catalogItems)
    .where(owner.kind === 'user' ? eq(s.catalogItems.ownerUserId, owner.id) : eq(s.catalogItems.ownerOrgId, owner.id))
    .all();
  for (const i of items) {
    const covers = await db.select().from(s.catalogItemCovers).where(eq(s.catalogItemCovers.itemId, i.id)).all();
    for (const cover of covers) {
      zip.add(`covers/${fileTitle(i.title, 'catalog item')}.webp`, cover.image as Uint8Array);
      counts.covers++;
    }
    if ((i.kind === 'layout' || i.kind === 'venue') && i.publicVersion > 0) {
      const v = await db
        .select({ doc: s.catalogItemVersions.docSnapshot })
        .from(s.catalogItemVersions)
        .where(and(eq(s.catalogItemVersions.itemId, i.id), eq(s.catalogItemVersions.version, i.publicVersion)))
        .get();
      if (!v?.doc) continue;
      if (i.kind === 'venue') {
        zip.add(`catalog/${fileTitle(i.title, 'venue')}.json`, v.doc as Uint8Array);
        counts.catalog++;
      } else {
        const file = await layoutFileBytes(v.doc as Uint8Array, null, null, null, smallZip, ownerViewer(owner));
        if (file) {
          zip.add(`catalog/${fileTitle(i.title, 'layout')}.bld-layout`, file);
          counts.catalog++;
        }
      }
    }
  }
  return counts;
}
