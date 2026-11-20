// What a finished import makes (docs/model-import.md, "Results"):
//   - mode "part": a custom part, made exactly as POST /api/custom-parts
//     makes the one the desktop sends (same checks, limits and audit), then
//     placed once;
//   - mode "parts": the parts of an .ldr / .mpd placed one by one, as the
//     desktop's File › Open places them (the converter's .bbm).
// Where it goes (the convert body's `target`):
//   - "new": a new layout, made here (nothing is open, so there is nothing
//     to undo: Home and a dropped file);
//   - "layout" with `clientPlaces: true`: the layout open in the editor. The
//     server makes the part (mode "part") and answers with the parts to put
//     down (`toPlace`); the editor puts them down itself, as its own change,
//     so one Undo takes the whole import back and collaborators see it at
//     once through the editor's sync;
//   - "library" (mode "part" only): the part is saved to you or a club, and
//     nothing is placed (Custom parts and the Parts panel's "Save to my parts").
// Deprecated: "layout" without `clientPlaces` (the editor before 2026-11-19)
// still puts the parts in as the server's change in the layout's room, out of
// anyone's undo. It stays for one release, for a page loaded before then.

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { readBbm } from '@cld/bbm';
import { createDefaultLayoutDoc, encodeDoc, makeId, seedFromBbm } from '@cld/ydoc';
import { appendBricks, cloneGroups, moduleBatchesFromMap, type BatchBrick } from '@cld/modules';
import { db, schema } from '../db/index.js';
import type { requireUser } from '../auth/cookie.js';
import { createCustomPart } from '../routes/customParts.js';
import { destinationOrg } from '../routes/owners.js';
import { checkGrowth, type Subject } from '../limits/limits.js';
import { recordUpload } from '../metrics/usage.js';
import { hasAtLeast, resolveResourceRole } from '../access/resolveResourceRole.js';
import { clampTitle } from '../utils/validate.js';
import { syncStoredLayout } from '../sharedModules/placed.js';
import { docHub } from '../ws/docHub.js';
import { SERVER_ORIGIN } from '../sharedModules/apply.js';
import { clubAccess } from '../access/clubPermissions.js';
import { publish, ownerOfResource } from '../events/audience.js';

type User = ReturnType<typeof requireUser>;

export type ImportTarget =
  | { kind: 'new'; title?: string; orgSlug?: string }
  | { kind: 'layout'; layoutId: string; sheetId?: string; at?: { x: number; y: number }; clientPlaces?: boolean }
  | { kind: 'library'; orgSlug?: string };

/** The parts the editor puts down itself (target "layout" with `clientPlaces`), as the .bbm has them. */
export interface ToPlace {
  bricks: BatchBrick[];
  groups: Parameters<typeof cloneGroups>[0][number][];
}

export interface ApplyOk {
  ok: true;
  /** Null for target "library": no layout is made or changed. */
  layoutId: string | null;
  /** The new custom part, in part mode. */
  part?: { id: string; partNumber: string; displayName: string };
  placed: number;
  sheetId: string | null;
  /** The new parts' ids in the layout, so the editor can select them. */
  brickIds: string[];
  /** Target "layout" with `clientPlaces`: what the editor puts down. */
  toPlace?: ToPlace;
}
export type ApplyResult = ApplyOk | { ok: false; status: number; error: string; permission?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Read and check where it goes, before the converter runs. */
export async function checkTarget(user: User, target: ImportTarget): Promise<{ ok: true } | { ok: false; status: number; error: string; permission?: string }> {
  if (target.kind === 'new') {
    const dest = await destinationOrg(user.id, target.orgSlug);
    if (!dest.ok) return { ok: false, status: dest.code, error: dest.error, ...(dest.permission ? { permission: dest.permission } : {}) };
    return { ok: true };
  }
  if (target.kind === 'library') {
    // The same checks as Upload part (createCustomPart), before anything runs.
    if (!target.orgSlug) return { ok: true };
    const org = await db.select({ id: schema.orgs.id }).from(schema.orgs).where(eq(schema.orgs.slug, target.orgSlug.toLowerCase())).get();
    if (!org) return { ok: false, status: 404, error: 'org_not_found' };
    const access = await clubAccess(user.id, org.id);
    if (!access) return { ok: false, status: 403, error: 'not_an_org_member' };
    if (!access.permissions.has('add_parts')) return { ok: false, status: 403, error: 'only_club_admins_can_add', permission: 'add_parts' };
    return { ok: true };
  }
  if (!UUID.test(target.layoutId)) return { ok: false, status: 400, error: 'invalid_layout' };
  const role = await resolveResourceRole(user.id, 'layout', target.layoutId);
  if (!hasAtLeast(role.role, 'editor')) return { ok: false, status: 403, error: 'forbidden' };
  return { ok: true };
}

/** The club a new part goes to: the layout's club when the person may add parts there, else their own. */
async function partOrgSlug(user: User, target: ImportTarget): Promise<string | undefined> {
  let orgId: string | null;
  // Checked before the converter ran (checkTarget); createCustomPart checks it again.
  if (target.kind === 'library') return target.orgSlug?.toLowerCase() || undefined;
  if (target.kind === 'new') {
    if (!target.orgSlug) return undefined;
    const org = await db.select({ id: schema.orgs.id }).from(schema.orgs).where(eq(schema.orgs.slug, target.orgSlug.toLowerCase())).get();
    orgId = org?.id ?? null;
  } else {
    const row = await db.select({ ownerOrgId: schema.layouts.ownerOrgId }).from(schema.layouts).where(eq(schema.layouts.id, target.layoutId)).get();
    orgId = row?.ownerOrgId ?? null;
  }
  if (!orgId) return undefined;
  const access = await clubAccess(user.id, orgId);
  if (!access?.permissions.has('add_parts')) return undefined;
  const org = await db.select({ slug: schema.orgs.slug }).from(schema.orgs).where(eq(schema.orgs.id, orgId)).get();
  return org?.slug ?? undefined;
}

/** A part number the owner doesn't have yet: the desktop's "-2, -3 …" rule. */
async function freePartNumber(base: string, owner: { userId: string | null; orgId: string | null }): Promise<string> {
  const taken = new Set(
    (
      await db
        .select({ n: schema.customParts.partNumber })
        .from(schema.customParts)
        .where(owner.orgId ? eq(schema.customParts.ownerOrgId, owner.orgId) : eq(schema.customParts.ownerUserId, owner.userId ?? ''))
        .all()
    ).map((r) => r.n.toLowerCase()),
  );
  let key = base;
  for (let n = 2; taken.has(key.toLowerCase()); n++) key = `${base}-${n}`;
  return key;
}

async function newLayout(user: User, target: Extract<ImportTarget, { kind: 'new' }>, doc: Y.Doc, fallbackTitle: string): Promise<(ApplyOk & { layoutId: string }) | Extract<ApplyResult, { ok: false }>> {
  const dest = await destinationOrg(user.id, target.orgSlug);
  if (!dest.ok) return { ok: false, status: dest.code, error: dest.error, ...(dest.permission ? { permission: dest.permission } : {}) };
  const owner: Subject = dest.orgId ? { kind: 'org', id: dest.orgId } : { kind: 'user', id: user.id };
  const snapshot = encodeDoc(doc);
  const refusal = await checkGrowth({ actor: user, owner, add: { layouts: 1, bytes: snapshot.length }, uploadBytes: snapshot.length });
  if (refusal) return { ok: false, status: refusal.status, error: String((refusal.body as { error?: string }).error ?? 'limit_reached') };
  recordUpload(user.id, owner, snapshot.length);
  const id = randomUUID();
  const now = new Date();
  await db.insert(schema.layouts).values({
    id,
    title: clampTitle((target.title ?? '').trim() || fallbackTitle || 'Imported model'),
    ownerUserId: dest.orgId ? null : user.id,
    ownerOrgId: dest.orgId,
    createdBy: user.id,
    createdAt: now,
    updatedAt: now,
    docSnapshot: Buffer.from(snapshot),
    docVersion: 0,
    sidecarSnapshot: null,
  });
  await syncStoredLayout(id);
  return { ok: true, layoutId: id, placed: 0, sheetId: null, brickIds: [] };
}

function firstBrickSheet(doc: Y.Doc, wanted?: string): string | null {
  const data = doc.getMap('layerData');
  const ids = doc.getArray<string>('layers').toArray();
  const isBrick = (id: string) => {
    const l = data.get(id);
    return l instanceof Y.Map && l.get('type') === 'brick';
  };
  if (wanted && ids.includes(wanted) && isBrick(wanted)) return wanted;
  return ids.find(isBrick) ?? null;
}

/** Put `bricks` (centred on `at`) on a sheet of the layout, as the server's change. */
async function intoLayout(layoutId: string, sheetId: string | undefined, bricks: BatchBrick[], groups: ReturnType<typeof cloneGroups>['groups'], at: { x: number; y: number }): Promise<{ sheetId: string; ids: string[] } | null> {
  const session = await docHub.getOrCreate(layoutId);
  const sheet = firstBrickSheet(session.doc, sheetId);
  if (!sheet) return null;
  let sx = 0;
  let sy = 0;
  for (const b of bricks) {
    sx += b.displayArea.x + b.displayArea.width / 2;
    sy += b.displayArea.y + b.displayArea.height / 2;
  }
  const dx = at.x - sx / Math.max(1, bricks.length);
  const dy = at.y - sy / Math.max(1, bricks.length);
  const moved = bricks.map((b) => ({ ...b, displayArea: { ...b.displayArea, x: b.displayArea.x + dx, y: b.displayArea.y + dy } }));
  let ids: string[] = [];
  session.doc.transact(() => {
    ids = appendBricks(session.doc, sheet, moved, groups);
  }, SERVER_ORIGIN);
  await session.flushBatch();
  await docHub.settle(session);
  return { sheetId: sheet, ids };
}

async function hintLayout(layoutId: string, action: string): Promise<void> {
  const o = await ownerOfResource('layout', layoutId);
  if (o?.owner) await publish({ kind: 'layout', owner: o.owner, id: layoutId, action });
}

/** Mode "part": the converter's part files. */
export async function applyPart(
  user: User,
  outDir: string,
  result: { partKey: string; displayName: string; xml: string; sprite: string; spriteMime: string; widthStuds: number; heightStuds: number },
  target: ImportTarget,
  category: string,
): Promise<ApplyResult> {
  const [xml, sprite] = await Promise.all([readFile(join(outDir, result.xml)), readFile(join(outDir, result.sprite))]);
  return applyPartFiles(user, xml, sprite, result, target, category);
}

/** Mode "part" from the part's files: the converter's, or the browser's own (POST /api/imports/client). */
export async function applyPartFiles(
  user: User,
  xml: Buffer,
  sprite: Buffer,
  result: { partKey: string; displayName: string; spriteMime: string; widthStuds: number; heightStuds: number },
  target: ImportTarget,
  category: string,
): Promise<ApplyResult> {
  const orgSlug = await partOrgSlug(user, target);
  let orgId: string | null = null;
  if (orgSlug) orgId = (await db.select({ id: schema.orgs.id }).from(schema.orgs).where(eq(schema.orgs.slug, orgSlug)).get())?.id ?? null;
  const partNumber = await freePartNumber(result.partKey, { userId: orgId ? null : user.id, orgId });
  const made = await createCustomPart(user, {
    partNumber,
    displayName: result.displayName || partNumber,
    xmlBase64: xml.toString('base64'),
    spriteBase64: sprite.toString('base64'),
    spriteMime: result.spriteMime === 'image/png' ? 'image/png' : 'image/gif',
    ...(orgSlug ? { orgSlug } : {}),
    category: category.trim().slice(0, 60) || 'Imported',
  });
  if (made.status !== 201) return { ok: false, status: made.status, error: String(made.body.error ?? 'part_refused'), ...(made.body.permission ? { permission: String(made.body.permission) } : {}) };
  const part = { id: String(made.body.id), partNumber: String(made.body.partNumber), displayName: String(made.body.displayName) };
  const o = await ownerOfResource('custom-part', part.id);
  if (o?.owner) await publish({ kind: 'custom-part', owner: o.owner, id: part.id, action: 'create' });

  const brick: BatchBrick = {
    partNumber: `custom:${part.id}`,
    displayArea: { x: -result.widthStuds / 2, y: -result.heightStuds / 2, width: result.widthStuds, height: result.heightStuds },
    orientation: 0,
  };
  if (target.kind === 'new') {
    const doc = createDefaultLayoutDoc();
    const sheet = firstBrickSheet(doc);
    let ids: string[] = [];
    if (sheet) doc.transact(() => { ids = appendBricks(doc, sheet, [brick]); });
    const made2 = await newLayout(user, target, doc, part.displayName);
    if (!made2.ok) return made2;
    await hintLayout(made2.layoutId, 'create');
    return { ...made2, part, placed: ids.length, sheetId: sheet, brickIds: ids };
  }
  if (target.kind === 'library') return { ok: true, layoutId: null, part, placed: 0, sheetId: null, brickIds: [] };
  if (target.clientPlaces) return { ok: true, layoutId: target.layoutId, part, placed: 0, sheetId: target.sheetId ?? null, brickIds: [], toPlace: { bricks: [brick], groups: [] } };
  const placed = await intoLayout(target.layoutId, target.sheetId, [brick], [], target.at ?? { x: 0, y: 0 });
  if (!placed) return { ok: false, status: 409, error: 'no_sheet' };
  return { ok: true, layoutId: target.layoutId, part, placed: placed.ids.length, sheetId: placed.sheetId, brickIds: placed.ids };
}

/** Mode "parts": the converter's .bbm. */
export async function applyLayout(user: User, outDir: string, bbmFile: string, target: ImportTarget, fallbackTitle: string): Promise<ApplyResult> {
  return applyLayoutText(user, await readFile(join(outDir, bbmFile), 'utf8'), target, fallbackTitle);
}

/** Mode "parts" from the .bbm's text: the converter's, or the browser's own. */
export async function applyLayoutText(user: User, bbm: string, target: ImportTarget, fallbackTitle: string): Promise<ApplyResult> {
  let parsed: ReturnType<typeof readBbm>;
  try {
    parsed = readBbm(bbm);
  } catch {
    return { ok: false, status: 422, error: 'damaged_layout' };
  }
  if (target.kind === 'new') {
    const made = await newLayout(user, target, seedFromBbm(parsed.map), fallbackTitle);
    if (!made.ok) return made;
    await hintLayout(made.layoutId, 'create');
    const bricks = parsed.map.layers.reduce((n, l) => n + (l.type === 'brick' ? l.bricks.length : 0), 0);
    return { ...made, placed: bricks };
  }
  if (target.kind === 'library') return { ok: false, status: 400, error: 'invalid_target' };
  const bricks: BatchBrick[] = [];
  const groupsIn: Parameters<typeof cloneGroups>[0][number][] = [];
  for (const b of moduleBatchesFromMap(parsed.map)) {
    bricks.push(...b.bricks);
    groupsIn.push(...(b.groups ?? []));
  }
  if (bricks.length === 0) return { ok: false, status: 422, error: 'nothing_to_place' };
  // The editor gives them new ids and sets as it puts them down.
  if (target.clientPlaces) return { ok: true, layoutId: target.layoutId, placed: 0, sheetId: target.sheetId ?? null, brickIds: [], toPlace: { bricks, groups: groupsIn } };
  const copied = cloneGroups(groupsIn, bricks, makeId);
  const placed = await intoLayout(target.layoutId, target.sheetId, copied.bricks, copied.groups, target.at ?? { x: 0, y: 0 });
  if (!placed) return { ok: false, status: 409, error: 'no_sheet' };
  return { ok: true, layoutId: target.layoutId, placed: placed.ids.length, sheetId: placed.sheetId, brickIds: placed.ids };
}

