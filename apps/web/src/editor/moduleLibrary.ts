// A placed module and its copy in the Module library, both ways.
//
// Make a module: the picked parts become a module in this layout only.
// Save to Module library…: a copy goes to your modules or a club's, and the placed
// module is linked to it (`libraryModuleId`, `libraryVersion` in the
// sidecar; BlueBrick never sees them). Modules added from the Module library are
// linked the same way. A linked module can then:
//   - Update Module library version: its parts in this layout become the
//     library's next version, with a "What changed?" note;
//   - Update from Module library: a newer library version replaces its parts,
//     where the module sits now, each part on its sheet. It asks first when
//     the module was changed in this layout.
// The desktop does the same (edit/ModuleLibraryLink.cpp).

import type * as Y from 'yjs';
import type { BbmMap, Brick } from '@cld/model';
import type { SidecarModule } from '@cld/bbm';
import { encodeDoc, readSidecarFromDoc, seedFromBbm } from '@cld/ydoc';
import {
  alignToPlaced as alignPlacement,
  matchesVersion as sameAsVersion,
  moduleBatchesFromBytes,
  placeVersion as placeAt,
  setupOf,
  withLibrarySetup,
  type AlignedPlacement,
  type ModuleSetup,
  type PartLookup,
  type Placement,
} from '@cld/modules';
import { api, type ModuleSummary, type PartWire } from '../api';
import { askConfirm } from '../ui/ConfirmDialog';
import { findPartsSheet, moduleMapFromSelection, moduleSheetsUsed, pickedPartsSheet } from './moduleSheets';
import { patchSidecarModule, replaceModuleParts, type ModuleBatch } from './mutations';
import { lookupPart } from './snap';
import { projectDoc } from './useDocMap';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The library module a placed module is linked to; `version` null when not known. */
export interface LibraryLink {
  id: string;
  version: number | null;
}

/**
 * The placed module's link to the Module library. Older builds kept the Module library
 * id (web) or the module's page on the server (desktop) in `sourceFile`;
 * those count as linked, at an unknown version.
 */
export function libraryLink(m: Pick<SidecarModule, 'libraryModuleId' | 'libraryVersion' | 'sourceFile'>): LibraryLink | null {
  const version = typeof m.libraryVersion === 'number' && m.libraryVersion > 0 ? m.libraryVersion : null;
  if (typeof m.libraryModuleId === 'string' && UUID_RE.test(m.libraryModuleId)) return { id: m.libraryModuleId, version };
  const src = typeof m.sourceFile === 'string' ? m.sourceFile : '';
  const legacy = UUID_RE.test(src) ? src : /\/modules\/([0-9a-f-]{36})\/?$/.exec(src)?.[1];
  return legacy && UUID_RE.test(legacy) ? { id: legacy, version: null } : null;
}

/** What the module's menus offer about its Module library copy. */
export type LibraryState =
  | { kind: 'unlinked' }
  /** Linked, but the Module library module isn't one you can see (deleted, or not shared with you). */
  | { kind: 'missing'; id: string }
  | {
      kind: 'linked';
      id: string;
      title: string;
      /** The version this layout's copy matches; null when not known. */
      version: number | null;
      /** The Module library's newest version (0: none yet). */
      latest: number;
      /** You may save new versions of it (its owner, or an editor). */
      canPublish: boolean;
      /** The Module library has a version this layout's copy doesn't. */
      newer: boolean;
    };

/** The module's library state, from your modules list (`api.modules.list`). */
export function libraryState(
  m: Pick<SidecarModule, 'libraryModuleId' | 'libraryVersion' | 'sourceFile'>,
  library: readonly ModuleSummary[] | undefined,
): LibraryState {
  const link = libraryLink(m);
  if (!link) return { kind: 'unlinked' };
  const found = library?.find((x) => x.id === link.id);
  if (!found) return { kind: 'missing', id: link.id };
  const latest = found.latestVersion ?? 0;
  return {
    kind: 'linked',
    id: link.id,
    title: found.title,
    version: link.version,
    latest,
    canPublish: found.role === undefined || found.role === 'owner' || found.role === 'editor',
    newer: latest > 0 && (link.version === null || latest > link.version),
  };
}

/** The line the Modules panel shows under a linked module. */
export function libraryNote(state: LibraryState): string | null {
  if (state.kind === 'unlinked') return null;
  if (state.kind === 'missing') return 'its Module library copy is gone';
  const v = state.version ? ` v${state.version}` : '';
  return state.newer ? `in the Module library${v} · v${state.latest} is newer` : `in the Module library${v}`;
}

// ---- Saving ---------------------------------------------------------------

/**
 * The placed module's table and power go to the Module library with its
 * parts. One with none set leaves the library's as they are.
 */
async function sendSetup(id: string, mod: SidecarModule): Promise<void> {
  const setup = setupOf(mod);
  if (!setup) return;
  try {
    await api.modules.setSetup(id, setup);
  } catch {
    // The parts are saved; the table and power can be set again from the Module library.
  }
}

type Thumb = { mime: 'image/png' | 'image/webp'; data: string };
export type MakeThumbnail = (region: { x: number; y: number; width: number; height: number }) => Promise<Thumb | null>;

/** A module's parts as a library module's contents (centred, sheets kept or one sheet). */
export function moduleContents(
  map: BbmMap,
  members: readonly string[],
  oneSheet = false,
): { bytes: Uint8Array; region: { x: number; y: number; width: number; height: number }; count: number } | null {
  const built = moduleMapFromSelection(map, members, { oneSheet });
  if (!built) return null;
  const d = seedFromBbm(built.moduleMap);
  const bytes = encodeDoc(d);
  d.destroy();
  return { bytes, region: built.region, count: built.count };
}

function findModule(doc: Y.Doc, moduleId: string): SidecarModule {
  const m = readSidecarFromDoc(doc)?.modules?.find((x) => x.id === moduleId);
  if (!m) throw new Error('That module is no longer in this layout.');
  return m;
}

async function versionOf(id: string, saved: { version?: number }): Promise<number | undefined> {
  if (saved.version) return saved.version;
  try {
    return (await api.modules.get(id)).module.latestVersion || undefined;
  } catch {
    return undefined;
  }
}

async function picture(id: string, region: { x: number; y: number; width: number; height: number }, makeThumbnail?: MakeThumbnail) {
  try {
    const thumb = await makeThumbnail?.(region);
    if (thumb) await api.modules.setThumbnail(id, thumb);
  } catch {
    // No picture: the lists show a placeholder until the module is opened.
  }
}

export interface SaveToLibraryOptions {
  /** A new library module's name. */
  title: string;
  /** Its owner: a club's slug, or '' for you. */
  ownerSlug: string;
  /** "What changed?" */
  note?: string;
  /** Put everything on one sheet. */
  oneSheet?: boolean;
  /** Save as a new version of this library module instead of a new one. */
  updateId?: string;
  makeThumbnail?: MakeThumbnail | undefined;
}

/**
 * Save to Module library…: the placed module's parts go to the Module library (a new
 * module, or a new version of one you can change), and the placed module
 * is linked to it. Returns the Module library module and its version.
 */
export async function saveModuleToLibrary(
  doc: Y.Doc,
  moduleId: string,
  o: SaveToLibraryOptions,
): Promise<{ id: string; title: string; version: number | undefined }> {
  const mod = findModule(doc, moduleId);
  const map = projectDoc(doc);
  const contents = map ? moduleContents(map, mod.members, o.oneSheet) : null;
  if (!contents) throw new Error('This module has no parts to save.');
  let id: string;
  let title: string;
  let version: number | undefined;
  if (o.updateId) {
    id = o.updateId;
    title = o.title;
    version = await versionOf(id, await api.modules.saveSnapshot(id, contents.bytes, o.note));
  } else {
    const created = await api.modules.create(o.ownerSlug ? { title: o.title, orgSlug: o.ownerSlug } : { title: o.title });
    id = created.id;
    title = created.title;
    try {
      version = await versionOf(id, await api.modules.saveSnapshot(id, contents.bytes, o.note));
    } catch (e) {
      // Don't leave an empty module behind when its contents didn't arrive.
      await api.modules.remove(id).catch(() => undefined);
      throw e;
    }
  }
  await picture(id, contents.region, o.makeThumbnail);
  await sendSetup(id, mod);
  patchSidecarModule(doc, moduleId, { libraryModuleId: id, ...(version ? { libraryVersion: version } : {}) });
  return { id, title, version };
}

/** Update Module library version: the placed module's parts become the Module library's next version. */
export async function publishModuleVersion(
  doc: Y.Doc,
  moduleId: string,
  o: { note?: string; oneSheet?: boolean; makeThumbnail?: MakeThumbnail | undefined },
): Promise<{ id: string; version: number | undefined }> {
  const mod = findModule(doc, moduleId);
  const link = libraryLink(mod);
  if (!link) throw new Error('Save this module to the Module library first.');
  const map = projectDoc(doc);
  const contents = map ? moduleContents(map, mod.members, o.oneSheet) : null;
  if (!contents) throw new Error('This module has no parts to save.');
  const version = await versionOf(link.id, await api.modules.saveSnapshot(link.id, contents.bytes, o.note));
  await picture(link.id, contents.region, o.makeThumbnail);
  await sendSetup(link.id, mod);
  patchSidecarModule(doc, moduleId, { libraryModuleId: link.id, ...(version ? { libraryVersion: version } : {}) });
  return { id: link.id, version };
}

// ---- Reading a library version ---------------------------------------------

/** A library module's contents as insert batches (one per sheet). */
export function batchesFromBytes(bytes: Uint8Array): ModuleBatch[] {
  try {
    return moduleBatchesFromBytes(bytes);
  } catch (e) {
    throw new Error('The module from the Module library couldn’t be read.', { cause: e });
  }
}

/** The Module library's newest version of a module (`version` absent), or one version. */
export async function fetchLibraryVersion(
  id: string,
  version?: number,
): Promise<{ batches: ModuleBatch[]; version: number; setup?: ModuleSetup | null }> {
  if (!UUID_RE.test(id)) throw new Error('invalid module id');
  if (version) return { batches: batchesFromBytes(await api.modules.versionSnapshot(id, version)), version };
  // The number first: a version saved in between makes this one look older, never newer.
  const { latestVersion, setup } = (await api.modules.get(id)).module;
  return { batches: batchesFromBytes(await api.modules.snapshot(id)), version: latestVersion ?? 0, setup: setup ?? null };
}

// ---- Where a library version goes on the map --------------------------------
//
// The math is shared with the server (@cld/modules placement.ts, with the
// desktop's copy held to the same vectors); these give it the editor's parts.

export type { AlignedPlacement, Placement };

/** The geometry of the editor's parts, by the number a brick names them by. */
export function partLookup(parts: Map<string, PartWire> | null): PartLookup {
  return (partNumber) => (parts ? lookupPart(parts, partNumber) : undefined);
}

/**
 * Where a library version's parts go so that its parts the layout already
 * has land on them: the turn most part pairs agree on, then the shift.
 * Robust to some parts having changed on either side. Falls back to the
 * placed module's middle, unturned, when no parts are alike.
 */
export function alignToPlaced(batches: readonly ModuleBatch[], placed: readonly Brick[], parts: Map<string, PartWire> | null): AlignedPlacement {
  return alignPlacement(batches, placed, partLookup(parts));
}

/** The library version's parts where `placement` puts them. */
export function placeVersion(batches: readonly ModuleBatch[], placement: Placement, parts: Map<string, PartWire> | null): ModuleBatch[] {
  return placeAt(batches, placement, partLookup(parts));
}

/**
 * Whether the placed module's parts are exactly the Module library version's
 * (same parts, same places and turns, within a hair): false when it was
 * changed in this layout.
 */
export function matchesVersion(batches: readonly ModuleBatch[], placed: readonly Brick[], parts: Map<string, PartWire> | null): boolean {
  return sameAsVersion(batches, placed, partLookup(parts));
}

/** The module's parts, on every sheet. */
export function placedParts(map: BbmMap, members: readonly string[]): Brick[] {
  const set = new Set(members);
  const out: Brick[] = [];
  for (const l of map.layers) if (l.type === 'brick') for (const b of l.bricks) if (set.has(b.id)) out.push(b);
  return out;
}

/**
 * Which sheet a library sheet's parts go on when the module is updated:
 * the layout's sheet with the same name, else the sheet most of the
 * module's parts are on now, else the picked sheet.
 */
export function sheetForUpdate(map: BbmMap, members: readonly string[], activeLayerId: string | null): (name: string) => string {
  const most = [...moduleSheetsUsed(map, members)].sort((a, b) => b.parts - a.parts)[0]?.id ?? null;
  const fallback = most ?? pickedPartsSheet(map, activeLayerId) ?? map.layers.find((l) => l.type === 'brick')?.id ?? '';
  return (name) => findPartsSheet(map.layers, name) ?? fallback;
}

export type PullResult = 'updated' | 'up-to-date' | 'cancelled' | { updated: 'by-server'; from: number | null; version: number };

/**
 * Update from Module library: the Module library's newest version replaces the module's
 * parts, where the module sits now, each on its sheet (one undo step). When
 * the module was changed in this layout (or that can't be told), `confirm`
 * asks first.
 */
export async function pullFromLibrary(
  doc: Y.Doc,
  moduleId: string,
  o: {
    parts: Map<string, PartWire> | null;
    activeLayerId: string | null;
    confirm?: (opts: Parameters<typeof askConfirm>[0]) => Promise<boolean>;
    /**
     * The layout on the server, when it is open live: the server then puts
     * the version in (api.sharedModules.apply), so two people pressing
     * Update at once get the parts once. It isn't an undo step; the answer
     * says which version to go back to.
     */
    layoutId?: string | null;
  },
): Promise<PullResult> {
  const mod = findModule(doc, moduleId);
  const link = libraryLink(mod);
  if (!link) throw new Error('This module isn’t in the Module library yet.');
  const latest = await fetchLibraryVersion(link.id);
  if (link.version !== null && latest.version <= link.version) return 'up-to-date';
  const map = projectDoc(doc);
  if (!map) throw new Error('The layout isn’t ready yet.');
  const placed = placedParts(map, mod.members);
  // Changed in this layout? Compare with the version it was linked at.
  let changed = true;
  if (link.version !== null) {
    try {
      changed = !matchesVersion((await fetchLibraryVersion(link.id, link.version)).batches, placed, o.parts);
    } catch {
      changed = true;
    }
  }
  if (changed) {
    const ok = await (o.confirm ?? askConfirm)({
      title: `Replace “${mod.name || 'this module'}” with version ${latest.version}?`,
      removes: 'This module was changed in this layout. Those changes are replaced by the Module library’s version.',
      keeps: o.layoutId ? 'Its name, colors and place on the map stay. You can go back to the version it has now.' : 'Its name, colors and place on the map stay. You can undo this.',
      confirmLabel: 'Update',
      danger: false,
    });
    if (!ok) return 'cancelled';
  }
  if (o.layoutId) {
    const r = await api.sharedModules.apply(o.layoutId, moduleId, { version: latest.version });
    return r.changed ? { updated: 'by-server', from: r.from, version: r.version } : 'up-to-date';
  }
  const placement = alignToPlaced(latest.batches, placed, o.parts);
  const batches = placeVersion(latest.batches, placement, o.parts);
  // The map may have changed while the Module library answered.
  const now = projectDoc(doc) ?? map;
  const current = findModule(doc, moduleId);
  // Its table and power come with the version, when the Module library has them.
  replaceModuleParts(doc, moduleId, batches, sheetForUpdate(now, current.members, o.activeLayerId), (m) =>
    withLibrarySetup({ ...m, libraryModuleId: link.id, ...(latest.version ? { libraryVersion: latest.version } : {}) }, latest.setup),
  );
  return 'updated';
}
