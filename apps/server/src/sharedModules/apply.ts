// The server's own changes to a placed module (docs/shared-modules.md):
//
//   applyVersion   its parts become another version of the library module
//                  it follows, where it sits now ("Update", "Go back to
//                  version N", "Put back the owner's version")
//   detachModule   it becomes an ordinary module of the layout, unlocked
//                  and no longer following anything ("Make it mine")
//
// One writer: the change is made in the layout's room (opened for it when
// nobody is in it), in one step between two reads of the document, so two
// people pressing Update at once get the new version once. The room then
// sends it to everyone like any edit. It is in nobody's undo stack; "Go
// back to version N" is the same step with the older version.

import { and, eq } from 'drizzle-orm';
import * as Y from 'yjs';
import type { SidecarModule } from '@cld/bbm';
import { readSidecarCache, writeSidecarCache } from '@cld/ydoc';
import {
  alignToPlaced,
  detached,
  moduleBatchesFromBytes,
  placeVersion,
  replaceModuleParts,
  resolvePlacement,
  sharedPlaced,
  sheetKey,
  withShared,
  type ModuleBatch,
  type PartLookup,
  type Placement,
} from '@cld/modules';
import { db, schema } from '../db/index.js';
import { docHub, type DocSession } from '../ws/docHub.js';
import { syncLayoutSharedModules } from './placed.js';
import { rememberSharedGeometry } from '../ws/sharedGeometry.js';

/** The origin of the server's own changes to a room's document. */
export const SERVER_ORIGIN = 'cld-server';

export type StepRefusal =
  /** The module isn't in the layout (any more). */
  | 'not_placed'
  /** It doesn't follow that library module (any more). */
  | 'not_linked'
  /** That version isn't kept (the newest 20 are), or can't be read. */
  | 'version_not_found'
  /** The layout has no parts sheet to put it on. */
  | 'no_sheet';

export type ApplyResult =
  | { ok: true; changed: boolean; version: number; from: number | null; parts: number }
  | { ok: false; error: StepRefusal };

interface PlacedBrick {
  id: string;
  partNumber: string;
  displayArea: { x: number; y: number; width: number; height: number };
  orientation: number;
  layerId: string;
}

function modulesOf(doc: Y.Doc): SidecarModule[] {
  const cache = readSidecarCache(doc);
  return Array.isArray(cache?.modules) ? (cache.modules as SidecarModule[]) : [];
}

/** The layout's parts sheets, in order, and the module's parts with the sheet each is on. */
function readPlaced(doc: Y.Doc, members: ReadonlySet<string>): { sheets: { id: string; name: string }[]; bricks: PlacedBrick[] } {
  const sheets: { id: string; name: string }[] = [];
  const bricks: PlacedBrick[] = [];
  const layerData = doc.getMap('layerData');
  for (const layerId of doc.getArray<string>('layers').toArray()) {
    const l = layerData.get(layerId);
    if (!(l instanceof Y.Map) || l.get('type') !== 'brick') continue;
    const list = l.get('bricks');
    if (!(list instanceof Y.Array)) continue;
    sheets.push({ id: layerId, name: typeof l.get('name') === 'string' ? (l.get('name') as string) : '' });
    if (members.size === 0) continue;
    for (const b of list) {
      if (!(b instanceof Y.Map)) continue;
      const id = b.get('id');
      if (typeof id !== 'string' || !members.has(id)) continue;
      const a = b.get('displayArea') as PlacedBrick['displayArea'] | undefined;
      if (!a) continue;
      bricks.push({
        id,
        partNumber: typeof b.get('partNumber') === 'string' ? (b.get('partNumber') as string) : '',
        displayArea: { x: a.x, y: a.y, width: a.width, height: a.height },
        orientation: typeof b.get('orientation') === 'number' ? (b.get('orientation') as number) : 0,
        layerId,
      });
    }
  }
  return { sheets, bricks };
}

/**
 * Which layout sheet each of the version's sheets goes on: the one the
 * placement kept for it (while it's still a parts sheet), else the layout's
 * sheet of the same name, else the sheet most of the module's parts are on
 * now, else the layout's first parts sheet.
 */
function sheetChooser(
  sheets: readonly { id: string; name: string }[],
  bricks: readonly PlacedBrick[],
  kept: Record<string, string> | undefined,
): { pick: (name: string) => string; used: Record<string, string> } | null {
  if (sheets.length === 0) return null;
  const ids = new Set(sheets.map((s) => s.id));
  const count = new Map<string, number>();
  for (const b of bricks) count.set(b.layerId, (count.get(b.layerId) ?? 0) + 1);
  const most = sheets.reduce<{ id: string; n: number } | null>((best, s) => {
    const n = count.get(s.id) ?? 0;
    return n > 0 && (!best || n > best.n) ? { id: s.id, n } : best;
  }, null);
  const fallback = most?.id ?? sheets[0]!.id;
  const keptByKey = new Map(Object.entries(kept ?? {}).map(([name, id]) => [sheetKey(name), id]));
  const used: Record<string, string> = {};
  const pick = (name: string): string => {
    const key = sheetKey(name);
    const keptId = keptByKey.get(key);
    const id = (keptId && ids.has(keptId) ? keptId : undefined) ?? sheets.find((s) => sheetKey(s.name) === key)?.id ?? fallback;
    used[name] = id;
    return id;
  };
  return { pick, used };
}

/** The contents of one kept version of a library module, or null. */
export async function versionBytes(moduleId: string, version: number): Promise<Uint8Array | null> {
  const row = await db
    .select({ docSnapshot: schema.moduleVersions.docSnapshot })
    .from(schema.moduleVersions)
    .where(and(eq(schema.moduleVersions.moduleId, moduleId), eq(schema.moduleVersions.version, version)))
    .get();
  return row ? (row.docSnapshot as Uint8Array) : null;
}

function batchesOrNull(bytes: Uint8Array | null): ModuleBatch[] | null {
  if (!bytes) return null;
  try {
    return moduleBatchesFromBytes(bytes);
  } catch {
    return null;
  }
}

/** Run `step` on the layout's document in its room, then store what it left (and close a room opened only for this). */
async function inRoom<T>(layoutId: string, step: (session: DocSession) => T): Promise<T> {
  const session = await docHub.getOrCreate(layoutId);
  const out = step(session);
  await session.flushBatch();
  await syncLayoutSharedModules(layoutId, session.doc);
  await docHub.settle(session);
  return out;
}

/**
 * Put version `version` of library module `moduleId` in place of the
 * placed module `placedId`'s parts. `partOf` gives the parts' geometry
 * (routes/parts.ts partGeometry). Already at that version: nothing is
 * changed, unless `again` (put the owner's version back over a copy that
 * was changed outside the app).
 */
export async function applyVersion(
  layoutId: string,
  placedId: string,
  moduleId: string,
  version: number,
  partOf: PartLookup,
  opts: { again?: boolean; now?: number } = {},
): Promise<ApplyResult> {
  const next = batchesOrNull(await versionBytes(moduleId, version));
  if (!next) return { ok: false, error: 'version_not_found' };
  // The guard measures this layout's moves with the same geometry (ws/sharedGeometry.ts).
  rememberSharedGeometry(layoutId, partOf);
  // Everything that has to be awaited is read before the step: nothing
  // may come between reading the module's state and writing it.
  const session = await docHub.getOrCreate(layoutId);
  const before = modulesOf(session.doc).find((m) => m.id === placedId);
  const hadVersion = typeof before?.libraryVersion === 'number' ? before.libraryVersion : null;
  const current = hadVersion && hadVersion !== version ? batchesOrNull(await versionBytes(moduleId, hadVersion)) : hadVersion === version ? next : null;
  return inRoom(layoutId, ({ doc }): ApplyResult => {
    const mod = modulesOf(doc).find((m) => m.id === placedId);
    if (!mod) return { ok: false, error: 'not_placed' };
    if (mod.libraryModuleId !== moduleId) return { ok: false, error: 'not_linked' };
    const from = typeof mod.libraryVersion === 'number' && mod.libraryVersion > 0 ? mod.libraryVersion : null;
    if (from === version && !opts.again) return { ok: true, changed: false, version, from, parts: mod.members.length };
    const shared = sharedPlaced(mod);
    const { sheets, bricks } = readPlaced(doc, new Set(mod.members));
    const kept = shared?.placement ?? null;
    const chooser = sheetChooser(sheets, bricks, kept?.sheets);
    if (!chooser) return { ok: false, error: 'no_sheet' };
    // Where the module sits: the placement it kept, while that still puts
    // the version it has onto its parts; else worked out from the parts.
    const basis = from !== null && from === hadVersion && current ? current : next;
    let placement: Placement;
    if (bricks.length === 0) placement = kept ?? { degrees: 0, x: 0, y: 0 };
    else if (kept || basis !== next) placement = resolvePlacement(basis, bricks, kept, partOf);
    else {
      const { matched: _matched, ...found } = alignToPlaced(next, bricks, partOf);
      placement = found;
    }
    const placed = placeVersion(next, placement, partOf);
    const ids = replaceModuleParts(
      doc,
      placedId,
      placed,
      chooser.pick,
      (m) => {
        const linked = { ...m, libraryModuleId: moduleId, libraryVersion: version };
        if (!shared) return linked;
        return withShared(linked, {
          placement: { degrees: placement.degrees, x: placement.x, y: placement.y, sheets: { ...chooser.used } },
          // Putting the same version back isn't news; a new version is, until someone says OK.
          ...(from === version ? {} : { review: { from, to: version, at: opts.now ?? Date.now() } }),
        });
      },
      SERVER_ORIGIN,
    );
    if (!ids) return { ok: false, error: 'not_placed' };
    return { ok: true, changed: true, version, from, parts: ids.length };
  });
}

export type DetachResult = { ok: true; changed: boolean } | { ok: false; error: 'not_placed' };

/**
 * "Make it mine": the placed module becomes an ordinary module of the
 * layout. Its parts stay as they are; it is unlocked, follows no library
 * module any more, and remembers what it was made from (`basedOn`).
 */
export async function detachModule(
  layoutId: string,
  placedId: string,
  /** `by`: the credit to keep instead of the name the layout has; `forget`: leave out which module it was (the module is gone for good). */
  opts: { by?: string; forget?: boolean } = {},
): Promise<DetachResult> {
  return inRoom(layoutId, ({ doc }): DetachResult => {
    const mod = modulesOf(doc).find((m) => m.id === placedId);
    if (!mod) return { ok: false, error: 'not_placed' };
    const shared = sharedPlaced(mod);
    if (!shared) return { ok: true, changed: false };
    doc.transact(() => {
      const cache = readSidecarCache(doc) ?? {};
      writeSidecarCache(doc, {
        ...cache,
        modules: modulesOf(doc).map((m) =>
          m.id === placedId
            ? {
                ...detached(m),
                basedOn: {
                  ...(opts.forget ? {} : { moduleId: shared.moduleId, ...(shared.version ? { version: shared.version } : {}) }),
                  ...((opts.by ?? shared.by) ? { by: opts.by ?? shared.by } : {}),
                },
              }
            : m,
        ),
      });
    }, SERVER_ORIGIN);
    return { ok: true, changed: true };
  });
}
