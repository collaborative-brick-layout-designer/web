import { randomUUID } from 'node:crypto';
import { withCustomPartNumbers } from '../utils/customPartNumbers.js';
import { Buffer } from 'node:buffer';
import { createWriteStream, createReadStream, existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, open, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { isImageOfType } from '../images/sniff.js';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import * as Y from 'yjs';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { readBbm, readSidecar, writeBbm, writeSidecar, type Sidecar } from '@cld/bbm';
import { hashBbmBytes } from '@cld/bbm/hash';
import { createDefaultLayoutDoc, decodeDoc, encodeDoc, exportBbmFromDoc, exportSidecarFromDoc, readSidecarCache, seedFromBbm, seedFromSidecar, writeSidecarCache } from '@cld/ydoc';
import { db, schema } from '../db/index.js';
import { requireUser } from '../auth/cookie.js';
import { isDemoUser } from '../demo/demoAccount.js';
import { hasAtLeast, resolveResourceRole } from '../access/resolveResourceRole.js';
import { env } from '../env.js';
import { docHub } from '../ws/docHub.js';
import { rollup } from '../metrics/rollup.js';
import { checkGrowth, declaredBytes, type Subject } from '../limits/limits.js';
import { recordUpload, usage } from '../metrics/usage.js';
import { touchLayoutOpened } from '../metrics/activity.js';
import { destinationOrg, matchesOwner, ownerLookup, resolveOwnerFilter } from './owners.js';
import { compareLayouts, type LayoutSnapshot } from '../sync/compare.js';
import { clubAccessMap, clubThingAccess } from '../access/clubPermissions.js';
import { creditLookup, withCredits } from './credits.js';
import { perPerson } from '../utils/rateLimits.js';
import { backgroundImagePath, layoutFileBytes, smallZip } from '../privacy/exportFiles.js';
import { attachment, safeFileName } from '../utils/contentDisposition.js';
import { clampTitle, titleTooLong, trimmed } from '../utils/validate.js';
import { checkUpdate } from '../ws/updateGuard.js';
import { checkGridSizes } from '../ws/gridGuard.js';
import { allowedBackgroundUrl, backgroundImageUrl, dropForeignBackgroundUrl, snapshotBackgroundProblem } from '../ws/backgroundGuard.js';
import { applyStoredUpdate, snapshotWork } from '../ws/yjsWork.js';

interface CreateLayoutBody {
  title?: string;
  /** Optional `.bbm` XML payload to seed the new layout from. */
  bbm?: string;
  /** Optional sidecar JSON payload (desktop `.bbm.bld` or legacy web `.bbm.cld`). */
  sidecar?: string;
  /**
   * If provided, the new layout is org-owned. The caller must be a
   * member of the org. Mutually exclusive with personal ownership.
   * The demo account can't join clubs, so it only makes its own.
   */
  orgSlug?: string;
  /**
   * The background image a `.bld-layout` carries (base64). Kept like an
   * uploaded one, and the sidecar's `backgroundImage` is pointed at it.
   */
  backgroundImage?: { type: string; data: string };
}

interface PatchLayoutBody {
  title?: string;
}

/**
 * Route config opting a read-only route in to API-token (desktop) auth.
 * Only the list, detail and export routes carry it; every other layout
 * route rejects token-authenticated requests (see attachUser).
 */
const TOKEN_READ = { apiToken: 'layouts:read' } as const;

/** Background-image file extensions, in the order GET probes them. */
const BG_EXTS = ['png', 'jpg', 'gif', 'webp'] as const;

/** Background-image types the upload takes, and their extensions. */
const BG_TYPE_EXT: Record<string, (typeof BG_EXTS)[number]> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const BG_MAX_BYTES = 10 * 1024 * 1024;

export async function layoutRoutes(app: FastifyInstance) {
  // Accept raw octet-stream bodies (binary Y.Doc snapshots). Without this,
  // Fastify rejects PUT /api/layouts/:id/snapshot with 415. The 50MB ceiling
  // matches the docSnapshot size limit enforced in the handler.
  if (!app.hasContentTypeParser('application/octet-stream')) {
    app.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: 50 * 1024 * 1024 },
      (_req, body, done) => done(null, body),
    );
  }

  // ---- list ----------------------------------------------------------------
  app.get<{ Querystring: { owner?: string } }>('/api/layouts', { config: TOKEN_READ }, async (req, reply) => {
    const user = requireUser(req);
    // ?owner=all|me|<club slug>: a club the caller isn't in is not found.
    const filter = await resolveOwnerFilter(user.id, req.query?.owner);
    if (!filter) return reply.code(404).send({ error: 'org_not_found' });
    // Three sources of layouts the user can see:
    //   1. ownerUserId === user.id          (personal)
    //   2. ownerOrgId joined to org_members (org-owned where they're a member)
    //   3. layout_collaborators row         (explicitly shared)
    // Dedupe by id since 2 and 3 can overlap (an org member who also has
    // an explicit per-user share). Set keyed by id wins.
    //
    // Metadata columns only: `select()` of whole rows pulled every
    // doc_snapshot / sidecar blob into memory just to build the list.
    const personal = await db
      .select(layoutListColumns)
      .from(schema.layouts)
      .where(eq(schema.layouts.ownerUserId, user.id));
    const orgOwned = await db
      .select({
        layout: layoutListColumns,
        orgName: schema.orgs.name,
        orgSlug: schema.orgs.slug,
        memberRole: schema.orgMembers.role,
      })
      .from(schema.orgMembers)
      .innerJoin(schema.layouts, eq(schema.layouts.ownerOrgId, schema.orgMembers.orgId))
      .innerJoin(schema.orgs, eq(schema.orgs.id, schema.orgMembers.orgId))
      .where(eq(schema.orgMembers.userId, user.id));
    const shared = await db
      .select({ layout: layoutListColumns, role: schema.layoutCollaborators.role })
      .from(schema.layoutCollaborators)
      .innerJoin(schema.layouts, eq(schema.layouts.id, schema.layoutCollaborators.layoutId))
      .where(eq(schema.layoutCollaborators.userId, user.id));

    const seen = new Set<string>();
    const all: ReturnType<typeof toListItem>[] = [];
    for (const l of personal) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      all.push(toListItem(l, 'owner'));
    }
    const access = await clubAccessMap(user.id);
    for (const { layout, orgName, orgSlug, memberRole } of orgOwned) {
      if (seen.has(layout.id)) continue;
      seen.add(layout.id);
      const a = access.get(layout.ownerOrgId ?? '');
      all.push(toListItem(layout, a ? clubThingAccess(a, 'layout') : memberRole === 'member' ? 'editor' : 'owner', orgName, orgSlug));
    }
    for (const { layout, role } of shared) {
      if (seen.has(layout.id)) continue;
      seen.add(layout.id);
      all.push(toListItem(layout, role));
    }
    const shown = all.filter((l) => matchesOwner(l, filter, user.id));
    const ownerOf = await ownerLookup(shown);
    return { layouts: await withCredits('layout', shown.map((l) => ({ ...l, owner: ownerOf(l) })), user.id) };
  });

  // ---- get -----------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/api/layouts/:id', { config: TOKEN_READ }, async (req, reply) => {
    const user = requireUser(req);
    const role = await resolveResourceRole(user.id, 'layout', req.params.id);
    if (!hasAtLeast(role.role, 'viewer')) return reply.code(404).send({ error: 'not_found' });

    const layout = await db
      .select(layoutListColumns)
      .from(schema.layouts)
      .where(eq(schema.layouts.id, req.params.id))
      .get();
    if (!layout) return reply.code(404).send({ error: 'not_found' });
    touchLayoutOpened(layout.id);

    const credit = (await creditLookup('layout', [layout.id], user.id))(layout.id);
    return {
      layout: { ...toListItem(layout, role.role), credit },
      role: role.role,
    };
  });

  // ---- create --------------------------------------------------------------
  // Desktop "Publish to Server" (sync P1b): a layouts:create token may
  // create a layout, personal or in an org where the user can.
  app.post<{ Body: CreateLayoutBody }>('/api/layouts', { config: { apiToken: 'layouts:create' } }, async (req, reply) => {
    const user = requireUser(req);
    const body = req.body ?? {};

    if (titleTooLong(trimmed(body.title))) return reply.code(400).send({ error: 'invalid_title' });
    let title = trimmed(body.title) || 'Untitled Layout';
    let sidecarSnapshot: Uint8Array | null = null;
    const id = randomUUID();

    // A .bld-layout's background image: checked here, written once the layout exists.
    let background: { ext: (typeof BG_EXTS)[number]; bytes: Buffer } | null = null;
    let sidecarText = body.sidecar;
    if (body.backgroundImage) {
      const ext = BG_TYPE_EXT[body.backgroundImage.type];
      if (!ext) return reply.code(415).send({ error: 'unsupported_image_type' });
      const bytes = Buffer.from(body.backgroundImage.data ?? '', 'base64');
      if (bytes.length === 0) return reply.code(400).send({ error: 'invalid_image' });
      if (bytes.length > BG_MAX_BYTES) return reply.code(413).send({ error: 'file_too_large' });
      if (!isImageOfType(bytes, body.backgroundImage.type)) return reply.code(415).send({ error: 'unsupported_image_type' });
      background = { ext, bytes };
    }
    if (sidecarText) {
      try {
        const raw = JSON.parse(sidecarText) as Record<string, unknown>;
        const bg = raw.backgroundImage;
        let changed = false;
        if (background && bg && typeof bg === 'object' && !Array.isArray(bg)) {
          // The image lives here now; the file named it by entry.
          const o = bg as Record<string, unknown>;
          delete o.file;
          delete o.path;
          o.url = backgroundImageUrl(id);
          changed = true;
        }
        // The picture is only ever loaded from this server (ws/backgroundGuard.ts).
        if (dropForeignBackgroundUrl(raw, id)) changed = true;
        if (changed) sidecarText = JSON.stringify(raw);
      } catch {
        /* reported by readSidecar below */
      }
    }

    let sidecar: Sidecar | null = null;
    if (sidecarText) {
      try {
        sidecar = readSidecar(sidecarText);
        sidecarSnapshot = encodeDoc(seedFromSidecar(sidecar));
      } catch (e) {
        return reply.code(400).send({ error: 'sidecar_parse_failed', detail: (e as Error).message });
      }
    }

    let doc: Y.Doc;
    if (body.bbm) {
      try {
        const parsed = readBbm(body.bbm);
        // If no title was provided, derive one from the .bbm metadata —
        // either the LUG/Event line or fall back to default.
        // BlueBrick's own "Unknown Event" (a map nobody named) isn't a title.
        if (!trimmed(body.title) && parsed.map.event && parsed.map.event.trim() !== 'Unknown Event') title = clampTitle(parsed.map.event);
        doc = seedFromBbm(parsed.map);
      } catch (e) {
        return reply.code(400).send({ error: 'bbm_parse_failed', detail: (e as Error).message });
      }
    } else {
      doc = createDefaultLayoutDoc();
    }
    // The editor reads (and edits) the sidecar from the main doc's
    // `meta.cache`, so an imported sidecar goes there too.
    if (sidecar) doc.getMap('meta').set('cache', sidecar as unknown as Record<string, unknown>);
    const docSnapshot = encodeDoc(doc);

    // Resolve owner — personal by default, or a club if `orgSlug` provided
    // (a member, and an admin when the club lets only admins add things).
    const dest = await destinationOrg(user.id, body.orgSlug);
    if (!dest.ok) return reply.code(dest.code).send({ error: dest.error, permission: dest.permission });
    const ownerUserId: string | null = dest.orgId ? null : user.id;
    const ownerOrgId: string | null = dest.orgId;

    const owner: Subject = ownerOrgId ? { kind: 'org', id: ownerOrgId } : { kind: 'user', id: user.id };
    const addBytes = docSnapshot.length + (sidecarSnapshot?.length ?? 0) + (background?.bytes.length ?? 0);
    // What was uploaded: the body as received (a chunked request declares no length).
    const uploaded = Math.max(declaredBytes(req.headers), Buffer.byteLength(JSON.stringify(req.body ?? null)));
    const refusal = await checkGrowth({ actor: user, owner, add: { layouts: 1, bytes: addBytes }, uploadBytes: uploaded });
    if (refusal) return reply.code(refusal.status).send(refusal.body);
    if (body.bbm || background) recordUpload(user.id, owner, uploaded);

    const now = new Date();

    await db.insert(schema.layouts).values({
      id,
      title,
      ownerUserId,
      ownerOrgId,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
      docSnapshot: Buffer.from(docSnapshot),
      docVersion: 0,
      sidecarSnapshot: sidecarSnapshot ? Buffer.from(sidecarSnapshot) : null,
    });
    if (background) {
      const bgDir = join(dirname(env.dbPath), 'bgimages');
      await mkdir(bgDir, { recursive: true });
      await writeFile(join(bgDir, `${id}.${background.ext}`), background.bytes);
    }

    return reply.code(201).send({ id, title });
  });

  // ---- patch (rename) ------------------------------------------------------
  app.patch<{ Params: { id: string }; Body: PatchLayoutBody }>(
    '/api/layouts/:id',
    async (req, reply) => {
      const user = requireUser(req);
      const role = await resolveResourceRole(user.id, 'layout', req.params.id);
      // No access at all → 404 (existence-leak protection). Insufficient
      // role (e.g. viewer can't rename) → 403, because the caller already
      // knows the resource exists.
      if (role.role === null) return reply.code(404).send({ error: 'not_found' });
      if (!hasAtLeast(role.role, 'editor')) return reply.code(403).send({ error: 'forbidden' });

      const updates: Partial<typeof schema.layouts.$inferInsert> = {};
      if (req.body.title !== undefined) {
        const t = trimmed(req.body.title);
        if (!t || titleTooLong(t)) return reply.code(400).send({ error: 'invalid_title' });
        updates.title = t;
      }
      if (Object.keys(updates).length === 0) {
        return reply.code(400).send({ error: 'no_updates' });
      }
      updates.updatedAt = new Date();
      await db.update(schema.layouts).set(updates).where(eq(schema.layouts.id, req.params.id));
      return { ok: true };
    },
  );

  // ---- delete --------------------------------------------------------------
  // The desktop app deletes layouts you own with a layouts:write token.
  app.delete<{ Params: { id: string } }>('/api/layouts/:id', { config: { apiToken: 'layouts:write' } }, async (req, reply) => {
    const user = requireUser(req);
    const role = await resolveResourceRole(user.id, 'layout', req.params.id);
    if (role.role === null) return reply.code(404).send({ error: 'not_found' });
    if (!hasAtLeast(role.role, 'owner')) return reply.code(403).send({ error: 'forbidden' });

    await db.delete(schema.layouts).where(eq(schema.layouts.id, req.params.id));
    // Shut any open editor sockets; otherwise their next update hits a
    // foreign-key failure against the deleted row.
    await docHub.close(req.params.id);
    return { ok: true };
  });

  // ---- copy to yourself or a club -------------------------------------------
  // Anyone who can open a layout can copy it, into their own layouts or a
  // club they're in (moving uses the transfer route). The copy carries the
  // current document, live edits included, its sidecar and its background.
  app.post<{ Params: { id: string }; Body: { orgSlug?: string; title?: string } }>(
    '/api/layouts/:id/copy',
    { config: { rateLimit: perPerson(30, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      const role = await resolveResourceRole(user.id, 'layout', req.params.id);
      if (!hasAtLeast(role.role, 'viewer')) return reply.code(404).send({ error: 'not_found' });
      const src = await db.select().from(schema.layouts).where(eq(schema.layouts.id, req.params.id)).get();
      if (!src) return reply.code(404).send({ error: 'not_found' });
      const dest = await destinationOrg(user.id, req.body?.orgSlug);
      if (!dest.ok) return reply.code(dest.code).send({ error: dest.error, permission: dest.permission });

      const sameOwner = dest.orgId ? src.ownerOrgId === dest.orgId : src.ownerUserId === user.id;
      if (titleTooLong(trimmed(req.body?.title))) return reply.code(400).send({ error: 'invalid_title' });
      const title = trimmed(req.body?.title) || clampTitle(sameOwner ? `${src.title} (copy)` : src.title);
      const ownerUserId = dest.orgId ? null : user.id;
      const copyOwner: Subject = dest.orgId ? { kind: 'org', id: dest.orgId } : { kind: 'user', id: user.id };
      const copyBytes = (src.docSnapshot as Uint8Array).length + ((src.sidecarSnapshot as Uint8Array | null)?.length ?? 0);
      const refusal = await checkGrowth({ actor: user, owner: copyOwner, add: { layouts: 1, bytes: copyBytes } });
      if (refusal) return reply.code(refusal.status).send(refusal.body);
      const prepared = await prepareLayoutCopy(src, { title, ownerUserId, ownerOrgId: dest.orgId, createdBy: user.id });
      await db.insert(schema.layouts).values(prepared.values);
      await prepared.copyBackground();
      const id = prepared.values.id;
      return reply.code(201).send({ id, title });
    },
  );

  // ---- compare (desktop reconnect preview) -------------------------------
  // Sync phase P1b: the desktop sends the copy it went offline with and its
  // offline edits; the reply lists every item either side changed since,
  // against the layout as it is now, and which of them conflict.
  app.post<{
    Params: { id: string };
    Body: { base?: { bbm?: unknown; sidecar?: unknown }; mine?: { bbm?: unknown; sidecar?: unknown } };
  }>(
    '/api/layouts/:id/compare',
    { config: { ...TOKEN_READ, rateLimit: perPerson(30, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      const role = await resolveResourceRole(user.id, 'layout', req.params.id);
      if (!hasAtLeast(role.role, 'viewer')) return reply.code(404).send({ error: 'not_found' });
      const parse = (side: { bbm?: unknown; sidecar?: unknown } | undefined): LayoutSnapshot | null => {
        if (!side || typeof side.bbm !== 'string') return null;
        if (side.sidecar !== undefined && typeof side.sidecar !== 'string') return null;
        try {
          return { map: readBbm(side.bbm).map, sidecar: side.sidecar ? readSidecar(side.sidecar) : null };
        } catch {
          return null;
        }
      };
      const base = parse(req.body?.base);
      const mine = parse(req.body?.mine);
      if (!base || !mine) return reply.code(400).send({ error: 'invalid_input' });

      const layout = await db.select().from(schema.layouts).where(eq(schema.layouts.id, req.params.id)).get();
      if (!layout) return reply.code(404).send({ error: 'not_found' });
      const doc = decodeDoc(await currentDocBytes(layout.id, layout.docSnapshot as Uint8Array));
      const map = exportBbmFromDoc(doc);
      if (!map) return reply.code(400).send({ error: 'export_unavailable_for_in_app_layout' });
      const sidecar =
        exportSidecarFromDoc(doc) ??
        (layout.sidecarSnapshot ? exportSidecarFromDoc(decodeDoc(layout.sidecarSnapshot as Uint8Array)) : null);
      const changes = compareLayouts(base, mine, { map, sidecar });
      return { changes, conflicts: changes.filter((c) => c.status === 'conflict').length };
    },
  );

  // ---- export (.bbm) -------------------------------------------------------
  app.get<{ Params: { id: string } }>('/api/layouts/:id/export.bbm', { config: TOKEN_READ }, async (req, reply) => {
    const user = requireUser(req);
    const role = await resolveResourceRole(user.id, 'layout', req.params.id);
    if (!hasAtLeast(role.role, 'viewer')) return reply.code(404).send({ error: 'not_found' });

    const layout = await db
      .select()
      .from(schema.layouts)
      .where(eq(schema.layouts.id, req.params.id))
      .get();
    if (!layout) return reply.code(404).send({ error: 'not_found' });

    const doc = decodeDoc(await currentDocBytes(layout.id, layout.docSnapshot as Uint8Array));
    const exported = exportBbmFromDoc(doc);
    // Named by part number, so BlueBrick and the desktop find the server's custom parts.
    const map = exported && (await withCustomPartNumbers(exported, { userId: user.id }));
    if (!map) {
      // The doc was authored in-app and there's no cached BbmMap yet.
      // Phase 3 fills this in once the editor mutates the Yjs structure
      // directly. For Phase 2, we only export what was imported.
      return reply.code(400).send({ error: 'export_unavailable_for_in_app_layout' });
    }
    const xml = writeBbm(map);
    rollup.count('exports', 'bbm');
    reply.header('Content-Type', 'application/xml; charset=utf-8');
    reply.header('Content-Disposition', attachment(`${safeFileName(layout.title)}.bbm`));
    return reply.send(xml);
  });

  // ---- export (.bld-layout) ------------------------------------------------
  // The whole layout as one native file (its sidecar and background picture
  // inside), for the desktop's "Download a copy". The same file the data
  // download puts in its layouts/ folder; it remembers where it came from.
  app.get<{ Params: { id: string } }>('/api/layouts/:id/export.bld-layout', { config: TOKEN_READ }, async (req, reply) => {
    const user = requireUser(req);
    const role = await resolveResourceRole(user.id, 'layout', req.params.id);
    if (!hasAtLeast(role.role, 'viewer')) return reply.code(404).send({ error: 'not_found' });
    const layout = await db.select().from(schema.layouts).where(eq(schema.layouts.id, req.params.id)).get();
    if (!layout) return reply.code(404).send({ error: 'not_found' });
    const bg = backgroundImagePath(layout.id);
    const bytes = await layoutFileBytes(
      await currentDocBytes(layout.id, layout.docSnapshot as Uint8Array),
      layout.sidecarSnapshot as Uint8Array | null,
      bg ? { bytes: readFileSync(bg.path), ext: bg.ext } : null,
      { layoutId: layout.id, title: layout.title },
      smallZip,
      { userId: user.id },
    );
    if (!bytes) return reply.code(400).send({ error: 'export_unavailable_for_in_app_layout' });
    rollup.count('exports', 'bld-layout');
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', attachment(`${safeFileName(layout.title)}.bld-layout`));
    return reply.send(Buffer.from(bytes));
  });

  // ---- snapshot (binary Y.Doc) --------------------------------------------
  // The editor reads this on /editor/:id load and writes it back on save.
  // Bytes are the y-update format; the server is dumb about doc internals.
  app.get<{ Params: { id: string } }>('/api/layouts/:id/snapshot', async (req, reply) => {
    const user = requireUser(req);
    const role = await resolveResourceRole(user.id, 'layout', req.params.id);
    if (!hasAtLeast(role.role, 'viewer')) return reply.code(404).send({ error: 'not_found' });

    const layout = await db
      .select()
      .from(schema.layouts)
      .where(eq(schema.layouts.id, req.params.id))
      .get();
    if (!layout) return reply.code(404).send({ error: 'not_found' });

    reply.header('Content-Type', 'application/octet-stream');
    reply.header('X-Doc-Version', String(layout.docVersion));
    return reply.send(
      Buffer.from(await currentDocBytes(layout.id, layout.docSnapshot as Uint8Array)),
    );
  });

  // PUT replaces the snapshot wholesale. Phase 4 (realtime) replaces this
  // with an incremental y-update protocol over WebSocket; for Phase 3 the
  // single-user editor just persists the full doc on save.
  app.put<{ Params: { id: string } }>('/api/layouts/:id/snapshot', async (req, reply) => {
    const user = requireUser(req);
    const role = await resolveResourceRole(user.id, 'layout', req.params.id);
    // No role at all → 404 (existence-leak protection). Has a role but not
    // editor (e.g. viewer) → 403, because the user already knows the
    // resource exists.
    if (role.role === null) return reply.code(404).send({ error: 'not_found' });
    if (!hasAtLeast(role.role, 'editor')) return reply.code(403).send({ error: 'forbidden' });

    const body = req.body;
    if (!body || !(body instanceof Buffer || body instanceof Uint8Array)) {
      return reply.code(400).send({ error: 'expected_binary_body' });
    }
    const bytes = body instanceof Buffer ? body : Buffer.from(body);
    if (bytes.length === 0) return reply.code(400).send({ error: 'empty_snapshot' });
    if (bytes.length > 50 * 1024 * 1024) {
      return reply.code(413).send({ error: 'snapshot_too_large' });
    }
    // Only a document both apps can read (the live editor's check).
    if (checkUpdate(bytes) !== null || checkGridSizes(null, bytes) !== null || snapshotWork(bytes) !== null) return reply.code(400).send({ error: 'unreadable_snapshot' });
    // While the layout is open in the realtime editor, the in-memory doc
    // is authoritative and its next flush would silently overwrite a
    // wholesale replacement written here. Refuse instead of losing it.
    if (docHub.has(req.params.id)) {
      return reply.code(409).send({ error: 'layout_open_in_editor' });
    }
    // The background picture only ever comes from this server (ws/backgroundGuard.ts).
    const badBackground = await snapshotBackgroundProblem(bytes, req.params.id, async () => {
      const row = await db.select({ docSnapshot: schema.layouts.docSnapshot }).from(schema.layouts).where(eq(schema.layouts.id, req.params.id)).get();
      return row ? currentDocBytes(req.params.id, row.docSnapshot as Uint8Array) : null;
    });
    if (badBackground !== null) return reply.code(400).send({ error: 'invalid_background_image' });
    const existing = await db
      .select({
        ownerUserId: schema.layouts.ownerUserId,
        ownerOrgId: schema.layouts.ownerOrgId,
        bytes: sql<number>`length(${schema.layouts.docSnapshot})`.mapWith(Number),
      })
      .from(schema.layouts)
      .where(eq(schema.layouts.id, req.params.id))
      .get();
    if (existing) {
      const owner: Subject = existing.ownerOrgId ? { kind: 'org', id: existing.ownerOrgId } : { kind: 'user', id: existing.ownerUserId ?? user.id };
      const refusal = await checkGrowth({ actor: user, owner, add: { bytes: bytes.length - existing.bytes }, uploadBytes: bytes.length });
      if (refusal) return reply.code(refusal.status).send(refusal.body);
    }

    const updatedAt = new Date();
    await db
      .update(schema.layouts)
      .set({
        docSnapshot: bytes,
        docVersion: (await currentVersion(req.params.id)) + 1,
        updatedAt,
      })
      .where(eq(schema.layouts.id, req.params.id));
    // A wholesale replacement supersedes any unflushed realtime updates;
    // replaying them over the new snapshot on next hydrate would merge
    // stale edits back in.
    await db
      .delete(schema.layoutUpdates)
      .where(
        and(
          eq(schema.layoutUpdates.layoutId, req.params.id),
          eq(schema.layoutUpdates.doc, 'main'),
        ),
      );
    rollup.distinct('layouts_edited', '', req.params.id);
    rollup.count('layout_edits', req.params.id);
    return { ok: true, updatedAt: updatedAt.getTime() };
  });

  // ---- export (.bbm.bld sidecar) -------------------------------------------
  // Desktop loads the sidecar only from `<file>.bbm.bld` (SidecarIO.cpp
  // sidecarPathFor), so that's the exported name. The JSON is the same
  // schema desktop's readSidecar decodes. `export.bbm.cld` is the legacy
  // URL, kept so old links still work.
  for (const path of ['/api/layouts/:id/export.bbm.bld', '/api/layouts/:id/export.bbm.cld']) {
    app.get<{ Params: { id: string } }>(path, { config: TOKEN_READ }, async (req, reply) => {
      const user = requireUser(req);
      const role = await resolveResourceRole(user.id, 'layout', req.params.id);
      if (!hasAtLeast(role.role, 'viewer')) return reply.code(404).send({ error: 'not_found' });

      const layout = await db
        .select()
        .from(schema.layouts)
        .where(eq(schema.layouts.id, req.params.id))
        .get();
      if (!layout) return reply.code(404).send({ error: 'no_sidecar' });
      const doc = decodeDoc(await currentDocBytes(layout.id, layout.docSnapshot as Uint8Array));
      const exported = exportBbmFromDoc(doc);
      // Named by part number, so BlueBrick and the desktop find the server's custom parts.
      const map = exported && (await withCustomPartNumbers(exported, { userId: user.id }));
      const json = sidecarJson(doc, layout.sidecarSnapshot as Uint8Array | null, map ? writeBbm(map) : null);
      if (!json) return reply.code(404).send({ error: 'no_sidecar' });
      rollup.count('exports', 'sidecar');
      reply.header('Content-Type', 'application/json; charset=utf-8');
      reply.header('Content-Disposition', attachment(`${safeFileName(layout.title)}.bbm.bld`));
      return reply.send(json);
    });
  }

  // ---- export (.zip — .bbm + optional .bbm.bld bundled together) ----------
  // Single-download equivalent of the two separate export routes above.
  // The .bbm.bld entry is omitted when the layout has no sidecar; unzipped
  // side by side, desktop opens both.
  app.get<{ Params: { id: string } }>('/api/layouts/:id/export.zip', { config: TOKEN_READ }, async (req, reply) => {
    const user = requireUser(req);
    const role = await resolveResourceRole(user.id, 'layout', req.params.id);
    if (!hasAtLeast(role.role, 'viewer')) return reply.code(404).send({ error: 'not_found' });

    const layout = await db
      .select()
      .from(schema.layouts)
      .where(eq(schema.layouts.id, req.params.id))
      .get();
    if (!layout) return reply.code(404).send({ error: 'not_found' });

    const doc = decodeDoc(await currentDocBytes(layout.id, layout.docSnapshot as Uint8Array));
    const exported = exportBbmFromDoc(doc);
    // Named by part number, so BlueBrick and the desktop find the server's custom parts.
    const map = exported && (await withCustomPartNumbers(exported, { userId: user.id }));
    if (!map) return reply.code(400).send({ error: 'export_unavailable_for_in_app_layout' });

    const safe = safeFileName(layout.title);
    const entries: { name: string; data: Buffer }[] = [];

    const xml = writeBbm(map);
    entries.push({ name: `${safe}.bbm`, data: Buffer.from(xml, 'utf8') });

    const json = sidecarJson(doc, layout.sidecarSnapshot as Uint8Array | null, xml);
    if (json) entries.push({ name: `${safe}.bbm.bld`, data: Buffer.from(json, 'utf8') });

    const zip = buildZip(entries);
    rollup.count('exports', 'zip');
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', attachment(`${safe}.zip`));
    return reply.send(zip);
  });

  /** What enable mints: 32 hex characters. */
  const SHARE_TOKEN = /^[0-9a-f]{32}$/;

  // ---- public share: enable -----------------------------------------------
  // Owner-only. Mints a fresh random token and stores it on the layout.
  // Anyone with the token URL (`/p/:token`) can read the layout without
  // signing in. Re-enabling on an already-shared layout returns the
  // existing token (idempotent) so the share UI doesn't accidentally
  // rotate the link on every click.
  app.post<{ Params: { id: string } }>('/api/layouts/:id/public-share', async (req, reply) => {
    const user = requireUser(req);
    if (isDemoUser(user)) return reply.code(403).send({ error: 'demo_account_cannot_share' });
    const role = await resolveResourceRole(user.id, 'layout', req.params.id);
    if (role.role === null) return reply.code(404).send({ error: 'not_found' });
    if (!hasAtLeast(role.role, 'owner')) return reply.code(403).send({ error: 'forbidden' });

    const layout = await db
      .select()
      .from(schema.layouts)
      .where(eq(schema.layouts.id, req.params.id))
      .get();
    if (!layout) return reply.code(404).send({ error: 'not_found' });

    let token = layout.publicShareToken;
    if (!token) {
      const owner: Subject = layout.ownerOrgId ? { kind: 'org', id: layout.ownerOrgId } : { kind: 'user', id: layout.ownerUserId ?? user.id };
      const refusal = await checkGrowth({ actor: user, owner, add: { shareLinks: 1 } });
      if (refusal) return reply.code(refusal.status).send(refusal.body);
      // 32 hex chars (16 bytes) is plenty for a public-share secret —
      // collision search is infeasible and the URL stays compact.
      token = randomUUID().replaceAll('-', '');
      await db
        .update(schema.layouts)
        .set({ publicShareToken: token })
        .where(eq(schema.layouts.id, req.params.id));
    }
    return reply.send({ token });
  });

  // ---- public share: disable ----------------------------------------------
  app.delete<{ Params: { id: string } }>('/api/layouts/:id/public-share', async (req, reply) => {
    const user = requireUser(req);
    const role = await resolveResourceRole(user.id, 'layout', req.params.id);
    if (role.role === null) return reply.code(404).send({ error: 'not_found' });
    if (!hasAtLeast(role.role, 'owner')) return reply.code(403).send({ error: 'forbidden' });

    await db
      .update(schema.layouts)
      .set({ publicShareToken: null })
      .where(eq(schema.layouts.id, req.params.id));
    return { ok: true };
  });

  // ---- public viewer: metadata --------------------------------------------
  // Anonymous endpoint. Looks up a layout by its public share token.
  // Returns the same summary shape as authenticated GET /api/layouts/:id,
  // minus owner identifiers (the public viewer doesn't need to know who
  // owns the layout — just title + version + a way to fetch bytes).
  app.get<{ Params: { token: string } }>('/api/public-layouts/:token', async (req, reply) => {
    const layout = await db
      .select()
      .from(schema.layouts)
      .where(eq(schema.layouts.publicShareToken, req.params.token))
      .get();
    // A club waiting to be deleted is hidden, its share links too.
    if (!layout || (await inDeletingClub(layout.ownerOrgId))) {
      // A link that was shared and since switched off (or its layout
      // deleted) is normal use: everyone at a show opening an old link
      // from the club chat must not add up to a burst of 404s that gets
      // the venue's address banned (README, "Operations: the 4xx
      // profile"). Anything not shaped like a share token is still a 404.
      if (SHARE_TOKEN.test(req.params.token)) {
        reply.header('Cache-Control', 'no-store');
        return { layout: null };
      }
      return reply.code(404).send({ error: 'not_found' });
    }
    rollup.count('share_views');
    if (layout.ownerOrgId) usage.count('org', layout.ownerOrgId, 'share_views');
    else if (layout.ownerUserId) usage.count('user', layout.ownerUserId, 'share_views');
    reply.header('Cache-Control', 'no-store');
    return {
      layout: {
        id: layout.id,
        title: layout.title,
        updatedAt: layout.updatedAt,
        docVersion: layout.docVersion,
        hasSidecar: layout.sidecarSnapshot !== null,
      },
    };
  });

  // ---- background image: upload -------------------------------------------
  // Editor-role required. Stores the uploaded image as a file under
  // `<data>/bgimages/<layoutId>.<ext>`. Returns the serve URL.
  // 10 MB ceiling; accepted types: image/jpeg, image/png, image/gif, image/webp.
  app.post<{ Params: { id: string } }>( // codeql[js/missing-rate-limiting]
    '/api/layouts/:id/background-image',
    { config: { rateLimit: perPerson(30, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      const layoutId = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(req.params.id)?.[1];
      if (!layoutId) return reply.code(400).send({ error: 'invalid_id' });
      const role = await resolveResourceRole(user.id, 'layout', layoutId);
      if (!hasAtLeast(role.role, 'editor')) return reply.code(403).send({ error: 'forbidden' });
      const target = await db
        .select({ ownerUserId: schema.layouts.ownerUserId, ownerOrgId: schema.layouts.ownerOrgId })
        .from(schema.layouts)
        .where(eq(schema.layouts.id, layoutId))
        .get();
      const owner: Subject | null = target
        ? target.ownerOrgId ? { kind: 'org', id: target.ownerOrgId } : { kind: 'user', id: target.ownerUserId ?? user.id }
        : null;
      if (owner) {
        // A quick refusal from the declared size; the real size is checked
        // again below, since a chunked upload declares none.
        const size = declaredBytes(req.headers);
        const refusal = await checkGrowth({ actor: user, owner, add: { bytes: size }, uploadBytes: size });
        if (refusal) return reply.code(refusal.status).send(refusal.body);
      }

      // One file and nothing else: text fields would otherwise be held in
      // memory (up to 1000 of 1 MB each by default) before the file arrives.
      const data = await req.file({ limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 1 } });
      if (!data) return reply.code(400).send({ error: 'no_file' });

      const mime = data.mimetype ?? '';
      const ext = mime === 'image/jpeg' ? 'jpg'
        : mime === 'image/png' ? 'png'
        : mime === 'image/gif' ? 'gif'
        : mime === 'image/webp' ? 'webp'
        : null;
      if (!ext) {
        await data.file.resume();
        return reply.code(415).send({ error: 'unsupported_image_type' });
      }

      const bgDir = join(dirname(env.dbPath), 'bgimages');
      await mkdir(bgDir, { recursive: true });
      const filename = `${layoutId}.${ext}`;
      const dest = join(bgDir, filename);
      // Stream into a temp file and only rename over the real one once
      // the whole upload arrived: writing to `dest` directly truncated
      // the existing image before an oversized upload was rejected.
      const tmp = join(bgDir, `${layoutId}.${randomUUID()}.upload`);
      try {
        // @types/node 26's PipelineSource requires an async iterator
        // matching ReadableStream's exactOptionalPropertyTypes-aware
        // shape, which even Node's own `Readable` class doesn't
        // structurally satisfy in these types — a type-declaration gap,
        // not a real behavior mismatch (Busboy's file stream is genuinely
        // a valid pipeline source at runtime). `any` is the least-bad
        // escape hatch until upstream fixes the declaration.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await pipeline(data.file as any, createWriteStream(tmp));
        if (data.file.truncated) {
          await unlink(tmp).catch(() => {});
          return reply.code(413).send({ error: 'file_too_large' });
        }
        // Stored and served as sent, so it must be the picture it says it is.
        const head = Buffer.alloc(16);
        const fh = await open(tmp, 'r');
        try {
          await fh.read(head, 0, 16, 0);
        } finally {
          await fh.close();
        }
        if (!isImageOfType(head, mime)) {
          await unlink(tmp).catch(() => {});
          return reply.code(415).send({ error: 'unsupported_image_type' });
        }
        if (owner) {
          const size = (await stat(tmp)).size;
          const refusal = await checkGrowth({ actor: user, owner, add: { bytes: size }, uploadBytes: size });
          if (refusal) {
            await unlink(tmp).catch(() => {});
            return reply.code(refusal.status).send(refusal.body);
          }
          recordUpload(user.id, owner, size);
        }
        await rename(tmp, dest);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
      // An image of a different type would otherwise shadow the new one
      // (the GET handler serves the first extension it finds).
      for (const other of BG_EXTS) {
        if (other === ext) continue;
        await unlink(join(bgDir, `${layoutId}.${other}`)).catch(() => {});
      }
      const url = `/api/layouts/${layoutId}/background-image`;
      return { url };
    },
  );

  // ---- background image: serve --------------------------------------------
  app.get<{ Params: { id: string } }>( // codeql[js/missing-rate-limiting]
    '/api/layouts/:id/background-image',
    { config: { rateLimit: perPerson(30, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      const layoutId = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(req.params.id)?.[1];
      if (!layoutId) return reply.code(400).send({ error: 'invalid_id' });
      const role = await resolveResourceRole(user.id, 'layout', layoutId);
      if (!hasAtLeast(role.role, 'viewer')) return reply.code(404).send({ error: 'not_found' });

      const bgDir = join(dirname(env.dbPath), 'bgimages');
      for (const ext of BG_EXTS) {
        const p = join(bgDir, `${layoutId}.${ext}`);
        if (existsSync(p)) {
          const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
          reply.header('Content-Type', mime);
          reply.header('Cache-Control', 'private, max-age=3600');
          return reply.send(createReadStream(p));
        }
      }
      return reply.code(404).send({ error: 'not_found' });
    },
  );

  // ---- background image: delete -------------------------------------------
  app.delete<{ Params: { id: string } }>( // codeql[js/missing-rate-limiting]
    '/api/layouts/:id/background-image',
    { config: { rateLimit: perPerson(30, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      const layoutId = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(req.params.id)?.[1];
      if (!layoutId) return reply.code(400).send({ error: 'invalid_id' });
      const role = await resolveResourceRole(user.id, 'layout', layoutId);
      if (!hasAtLeast(role.role, 'editor')) return reply.code(403).send({ error: 'forbidden' });

      const bgDir = join(dirname(env.dbPath), 'bgimages');
      for (const ext of BG_EXTS) {
        await unlink(join(bgDir, `${layoutId}.${ext}`)).catch(() => {});
      }
      return { ok: true };
    },
  );

  // ---- public viewer: snapshot bytes --------------------------------------
  app.get<{ Params: { token: string } }>(
    '/api/public-layouts/:token/snapshot',
    async (req, reply) => {
      const layout = await db
        .select()
        .from(schema.layouts)
        .where(eq(schema.layouts.publicShareToken, req.params.token))
        .get();
      if (!layout || (await inDeletingClub(layout.ownerOrgId))) return reply.code(404).send({ error: 'not_found' });
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('X-Doc-Version', String(layout.docVersion));
      return reply.send(
        Buffer.from(await currentDocBytes(layout.id, layout.docSnapshot as Uint8Array)),
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Is this layout's club waiting to be deleted (and so hidden)? */
async function inDeletingClub(orgId: string | null): Promise<boolean> {
  if (!orgId) return false;
  const org = await db.select({ due: schema.orgs.deletionDueAt }).from(schema.orgs).where(eq(schema.orgs.id, orgId)).get();
  return !!org?.due;
}

/** Columns for list/detail responses — everything except the doc blobs. */
export const layoutListColumns = {
  id: schema.layouts.id,
  title: schema.layouts.title,
  ownerUserId: schema.layouts.ownerUserId,
  ownerOrgId: schema.layouts.ownerOrgId,
  createdAt: schema.layouts.createdAt,
  updatedAt: schema.layouts.updatedAt,
  expiresAt: schema.layouts.expiresAt,
  docVersion: schema.layouts.docVersion,
  publicShareToken: schema.layouts.publicShareToken,
  hasSidecar: sql<number>`${schema.layouts.sidecarSnapshot} IS NOT NULL`,
};

type LayoutListRow = {
  [K in keyof typeof layoutListColumns]: K extends 'hasSidecar'
    ? number
    : (typeof schema.layouts.$inferSelect)[K & keyof typeof schema.layouts.$inferSelect];
};

/**
 * `role` is the caller's role on the layout. The public-share token is
 * the layout's read-anywhere secret and only its owners (who alone can
 * enable / disable sharing) get to see it; it used to be returned to
 * every viewer and collaborator.
 */
function toListItem(
  l: LayoutListRow,
  role: 'owner' | 'editor' | 'viewer' | null,
  ownerOrgName?: string,
  ownerOrgSlug?: string,
) {
  return {
    id: l.id,
    title: l.title,
    ownerUserId: l.ownerUserId,
    ownerOrgId: l.ownerOrgId,
    ownerOrgName: ownerOrgName ?? null,
    ownerOrgSlug: ownerOrgSlug ?? null,
    // The caller's role (the desktop's Access column reads it).
    role,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
    expiresAt: l.expiresAt,
    docVersion: l.docVersion,
    hasSidecar: Boolean(l.hasSidecar),
    publicShareToken: role === 'owner' ? (l.publicShareToken ?? null) : null,
  };
}

/**
 * A copy of layout `src` ready to insert: the current document, live
 * edits included, its sidecar, and (after the insert) its background
 * picture. Remembers what it was copied from. The caller checks rights
 * and limits.
 */
export async function prepareLayoutCopy(
  src: typeof schema.layouts.$inferSelect,
  to: { title: string; ownerUserId: string | null; ownerOrgId: string | null; createdBy: string },
): Promise<{ values: typeof schema.layouts.$inferInsert & { id: string }; copyBackground: () => Promise<void> }> {
  const id = randomUUID();
  const doc = decodeDoc(await currentDocBytes(src.id, src.docSnapshot as Uint8Array));
  // The background is served per layout: point the copy at its own.
  const oldBg = `/api/layouts/${src.id}/background-image`;
  // Everyone's modules and labels, kept one per key (@cld/ydoc).
  const cache = readSidecarCache(doc) ?? undefined;
  const bg = cache?.backgroundImage as Record<string, unknown> | undefined;
  if (cache && bg && typeof bg.url === 'string' && bg.url.startsWith(oldBg)) {
    doc.transact(() => writeSidecarCache(doc, { ...cache, backgroundImage: { ...bg, url: backgroundImageUrl(id) } }));
  } else if (cache && bg && !allowedBackgroundUrl(bg.url, id)) {
    // Any other address (stored before the server checked them): the copy doesn't keep it.
    doc.transact(() => writeSidecarCache(doc, { ...cache, backgroundImage: { ...bg, url: '' } }));
  }
  const now = new Date();
  return {
    values: {
      id,
      title: to.title,
      ownerUserId: to.ownerUserId,
      ownerOrgId: to.ownerOrgId,
      createdBy: to.createdBy,
      createdAt: now,
      updatedAt: now,
      docSnapshot: Buffer.from(encodeDoc(doc)),
      docVersion: 0,
      sidecarSnapshot: src.sidecarSnapshot,
      copiedFromId: src.id,
    },
    copyBackground: async () => {
      const bgDir = join(dirname(env.dbPath), 'bgimages');
      for (const ext of BG_EXTS) {
        const from = join(bgDir, `${src.id}.${ext}`);
        if (existsSync(from)) {
          await copyFile(from, join(bgDir, `${id}.${ext}`));
          break;
        }
      }
    },
  };
}

/**
 * The layout's current document, as y-update bytes. The persisted
 * snapshot alone lags behind realtime editing: the live session's
 * in-memory doc is authoritative while one is loaded, and otherwise any
 * layout_updates rows not yet compacted into the snapshot must be
 * replayed (same as DocSession.hydrate). Reading only docSnapshot made
 * exports / GET snapshot / the public viewer miss recent edits.
 */
export async function currentDocBytes(layoutId: string, snapshot: Uint8Array): Promise<Uint8Array> {
  const live = docHub.peek(layoutId);
  if (live) return Y.encodeStateAsUpdate(live.doc);
  const updates = await db
    .select({ updateBytes: schema.layoutUpdates.updateBytes })
    .from(schema.layoutUpdates)
    .where(
      and(
        eq(schema.layoutUpdates.layoutId, layoutId),
        eq(schema.layoutUpdates.doc, 'main'),
      ),
    )
    .orderBy(schema.layoutUpdates.id);
  if (updates.length === 0) return snapshot;
  const doc = new Y.Doc();
  try {
    if (snapshot.length > 0) Y.applyUpdate(doc, snapshot);
    // Corrupt or too costly to apply — skipped, as in DocSession.hydrate.
    for (const u of updates) applyStoredUpdate(doc, u.updateBytes as Uint8Array, `layout ${layoutId}`);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

async function currentVersion(layoutId: string): Promise<number> {
  const row = await db
    .select({ docVersion: schema.layouts.docVersion })
    .from(schema.layouts)
    .where(eq(schema.layouts.id, layoutId))
    .get();
  return row?.docVersion ?? 0;
}

/**
 * Build a minimal ZIP archive containing the provided entries.
 * Uses store (no compression, method=0) to avoid a native zlib dependency.
 * Format: PKZIP 2.0 — universally supported.
 */
function buildZip(entries: { name: string; data: Buffer }[]): Buffer {
  const localHeaders: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;

  for (const entry of entries) {
    offsets.push(offset);
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const crc = crc32Buffer(entry.data);
    const size = entry.data.length;
    // Local file header (30 bytes + name)
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);  // signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(0, 8);            // method: store
    local.writeUInt16LE(0, 10);           // mod time
    local.writeUInt16LE(0, 12);           // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);        // compressed size
    local.writeUInt32LE(size, 22);        // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);           // extra len
    // TypeScript 7's stricter ArrayBufferLike/SharedArrayBuffer variance
    // makes Buffer no longer structurally satisfy Uint8Array<ArrayBuffer>
    // as Buffer.copy's own `target` param — a type-declaration
    // self-incompatibility, not a real runtime issue (Buffer.copy has
    // always accepted a Buffer target).
    nameBytes.copy(local as unknown as Uint8Array<ArrayBuffer>, 30);
    localHeaders.push(local);
    offset += local.length + size;
  }

  const centralDirStart = offset;
  const centralHeaders: Buffer[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const crc = crc32Buffer(entry.data);
    const size = entry.data.length;
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(0, 8);           // flags
    central.writeUInt16LE(0, 10);          // method
    central.writeUInt16LE(0, 12);          // mod time
    central.writeUInt16LE(0, 14);          // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);          // extra len
    central.writeUInt16LE(0, 32);          // comment len
    central.writeUInt16LE(0, 34);          // disk start
    central.writeUInt16LE(0, 36);          // int attr
    central.writeUInt32LE(0, 38);          // ext attr
    central.writeUInt32LE(offsets[i]!, 42); // local header offset
    // Same TS7 Buffer/Uint8Array<ArrayBuffer> type-declaration gap as above.
    nameBytes.copy(central as unknown as Uint8Array<ArrayBuffer>, 46);
    centralHeaders.push(central);
  }

  const centralDirLen = centralHeaders.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);         // end of central dir signature
  eocd.writeUInt16LE(0, 4);                   // disk number
  eocd.writeUInt16LE(0, 6);                   // disk with start of CD
  eocd.writeUInt16LE(entries.length, 8);      // entries on disk
  eocd.writeUInt16LE(entries.length, 10);     // total entries
  eocd.writeUInt32LE(centralDirLen, 12);      // CD size
  eocd.writeUInt32LE(centralDirStart, 16);    // CD offset
  eocd.writeUInt16LE(0, 20);                  // comment len

  // Same TS7 Buffer/Uint8Array<ArrayBuffer> type-declaration gap as above.
  return Buffer.concat([
    ...localHeaders.flatMap((h, i) => [h, entries[i]!.data]),
    ...centralHeaders,
    eocd,
  ] as unknown as Uint8Array<ArrayBuffer>[]);
}

/** CRC-32 compatible with PKZIP (polynomial 0xEDB88320). */
function crc32Buffer(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Silence the unused-import: `or`/`isNull` are reserved for the org-join
// query that lands in Phase 6. Importing them here keeps the future diff
// small.
void or;
void isNull;
void and;

/**
 * Sidecar JSON for export, or null when the layout has none. The live
 * doc's `meta.cache` (what the editor edits) wins over the snapshot taken
 * at import. `bbmHashSha256` is the hash of the `.bbm` exported alongside,
 * so desktop doesn't flag the pair as drifted (MainWindowFileIO.cpp:88-94).
 */
function sidecarJson(doc: Y.Doc, sidecarSnapshot: Uint8Array | null, bbmXml: string | null): string | null {
  const sidecar =
    exportSidecarFromDoc(doc) ?? (sidecarSnapshot ? exportSidecarFromDoc(decodeDoc(sidecarSnapshot)) : null);
  if (!sidecar) return null;
  return writeSidecar(sidecar, bbmXml !== null ? { bbmHashSha256: hashBbmBytes(bbmXml) } : {});
}
