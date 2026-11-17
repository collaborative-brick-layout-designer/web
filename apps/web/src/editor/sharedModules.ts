// Shared (read-only) modules in the editor (docs/shared-modules.md): how a
// library module is placed (locked, when it is someone else's shared with
// you), the words for each state a placed copy can be in, which copies
// have a newer version waiting, and the server's steps on them (Update, Go
// back, Put back, Make it mine). The lock itself is sharedLock.ts.

import { droppedPlacement, movedPlacement, sharedPlaced, type Placement, type SharedPlaced } from '@cld/modules';
import type { SidecarModule } from '@cld/bbm';
import { moduleCopy } from './moduleCopy';
import { api, type LayoutSharedModule, type SharedPlaceCheck } from '../api';
import { askConfirm } from '../ui/ConfirmDialog';
import { useEditorStore } from './editorStore';

/** The layout the editor has open on the server (null: a module's own editor, or a file with no server). */
let layoutOnServer: string | null = null;

export function setSharedModulesLayout(layoutId: string | null): void {
  layoutOnServer = layoutId;
}

export function sharedModulesLayout(): string | null {
  return layoutOnServer;
}

/** How a module from the Module library is linked when it's placed (mutations.ts importBricksAsModule `library`). */
export interface LibraryPlacement {
  id: string;
  version?: number;
  shared?: { by: string; server?: string; placement: Placement };
}

/** Why a shared module can't go into this layout, and what to do about it. */
export function refusalText(c: SharedPlaceCheck): { title: string; body: string; ask: string } {
  const owner = c.moduleOwner.name || 'its owner';
  const where = c.layoutOwner.kind === 'org' ? c.layoutOwner.name || 'this club' : c.layoutOwner.mine ? 'you' : c.layoutOwner.name || 'this layout’s owner';
  const target = c.layoutOwner.kind === 'org' ? 'the club' : c.layoutOwner.mine ? 'you' : 'them';
  const body =
    c.layoutOwner.kind === 'user' && c.layoutOwner.mine
      ? `${owner} shared “${c.title}” with a club you’re in, for the club’s layouts, not with you. Ask ${owner} to share it with you too.`
      : `${owner} shared “${c.title}” with you, not with ${where}. Ask ${owner} to share it with ${target}.`;
  const ask =
    c.layoutOwner.kind === 'org'
      ? `Hi ${owner}, could you share your module “${c.title}” with ${where}? I’d like to place it in one of the club’s layouts.`
      : c.layoutOwner.mine
        ? `Hi ${owner}, could you share your module “${c.title}” with me as well? I’d like to place it in one of my own layouts.`
        : `Hi ${owner}, could you share your module “${c.title}” with ${where}? I’d like to place it in one of their layouts.`;
  return { title: `“${c.title}” can’t go in this layout yet`, body, ask };
}

/**
 * How to link the library module `moduleId` when it is placed here.
 * Your own modules, your clubs' own, and ones you may change are linked as
 * before. Someone else's, shared with you to place, is placed shared
 * (locked, following its owner), when it is shared with this layout's
 * owner too; when it isn't, the person is told whom to ask and nothing is
 * placed (null). `placement`: where the version's own coordinates land.
 */
export async function libraryPlacement(moduleId: string, version: number | undefined, placement: Placement): Promise<LibraryPlacement | null> {
  const plain: LibraryPlacement = { id: moduleId, ...(version ? { version } : {}) };
  const layoutId = layoutOnServer;
  if (!layoutId) return plain;
  try {
    const shared = (await api.modules.sharedWithMe()).modules.find((m) => m.id === moduleId);
    // "Can change it" (an editor share) stays a linked copy you can change.
    if (!shared || shared.role !== 'viewer') return plain;
  } catch {
    // An older server, or offline: placed as before.
    return plain;
  }
  const check = await api.sharedModules.check(layoutId, moduleId);
  if (!check) return plain;
  if (check.state !== 'shared') {
    const t = refusalText(check);
    const copy = await askConfirm({ title: t.title, keeps: t.body, confirmLabel: 'Copy a message to send', cancelLabel: 'Close', danger: false });
    if (copy) {
      try {
        await navigator.clipboard.writeText(t.ask);
        useEditorStore.getState().showNotice(`Copied. Send it to ${check.moduleOwner.name || 'the module’s owner'}.`, 'done', 6000);
      } catch {
        useEditorStore.getState().showNotice(t.ask, 'done', 15000);
      }
    }
    return null;
  }
  tipOnce();
  return { ...plain, shared: { by: check.moduleOwner.name, server: window.location.origin, placement } };
}

/** The placement of a module dropped on the map (moduleDrop.ts moduleDropTranslation's answer). */
export const dropPlacement = droppedPlacement;

const TIP_KEY = 'cld.sharedModuleTip';

/** The first time: what a shared module is, in one line. */
function tipOnce(): void {
  try {
    if (window.localStorage.getItem(TIP_KEY)) return;
    window.localStorage.setItem(TIP_KEY, '1');
  } catch {
    return;
  }
  useEditorStore
    .getState()
    .showNotice('Shared modules follow their owner’s updates. You can move and turn them; their parts stay as the owner made them.', 'done', 10000);
}

// ---- A placed copy's state, in words ------------------------------------------

/** What the server says about one placed copy (absent: not asked yet, or a file with no server). */
export type Row = LayoutSharedModule | undefined;

/** The newer version waiting for a placed copy, or null. */
export function newerVersion(placed: Pick<SharedPlaced, 'version'>, row: Row): number | null {
  if (!row || row.state !== 'shared' || !row.latest) return null;
  return placed.version === null || row.latest > placed.version ? row.latest : null;
}

/** The line the Modules panel shows under a shared module. */
export function sharedNote(placed: Pick<SharedPlaced, 'version' | 'by'>, row: Row): string {
  const by = row?.owner?.name || placed.by;
  const v = placed.version ? ` · v${placed.version}` : '';
  if (row?.state === 'unshared') return `No longer shared${v}: no more updates`;
  if (row?.state === 'gone') return `Deleted by its owner${v}: no more updates`;
  const base = by ? `Shared by ${by}${v}` : `Shared${v}`;
  const newer = newerVersion(placed, row);
  return newer ? `${base} · v${newer} is ready` : base;
}

/** A placed copy with a newer version waiting. */
export interface SharedUpdate {
  placed: SharedPlaced;
  row: LayoutSharedModule;
  latest: number;
}

/** The placed copies that have a newer version, in the layout's order. */
export function findSharedUpdates(placed: readonly SharedPlaced[], rows: readonly LayoutSharedModule[]): SharedUpdate[] {
  const byId = new Map(rows.map((r) => [r.placedId, r]));
  const out: SharedUpdate[] = [];
  for (const p of placed) {
    const row = byId.get(p.placedId);
    const latest = newerVersion(p, row);
    if (row && latest) out.push({ placed: p, row, latest });
  }
  return out;
}

/** The notice for new versions: one module by name, with its note; several by count. */
export function updatesText(updates: readonly SharedUpdate[]): string {
  if (updates.length === 1) {
    const u = updates[0]!;
    const who = u.row.owner?.name ? ` from ${u.row.owner.name}` : '';
    const note = u.row.latestNote ? `: “${u.row.latestNote}”` : '';
    return `“${u.placed.name || u.row.title || 'A shared module'}” has a new version${who} (v${u.latest})${note}.`;
  }
  return `${updates.length} shared modules have new versions.`;
}

/** The notice after an update: what it is now. */
export function reviewText(p: SharedPlaced): string {
  return `“${p.name || 'The shared module'}” is now version ${p.review?.to ?? p.version ?? ''}.`.replace(' .', '.');
}

/** "Make it mine…": asks first, then the server unlocks the copy. True when it did. */
export async function makeItMine(layoutId: string, placed: Pick<SharedPlaced, 'placedId' | 'name' | 'by'>): Promise<boolean> {
  const name = placed.name || 'This module';
  const ok = await askConfirm({
    title: `Make “${name}” yours?`,
    removes: `It stops following ${placed.by || 'its owner'}: no more updates, and this can’t be undone.`,
    keeps: 'Its parts stay where they are, and you can change them like any module of this layout.',
    confirmLabel: 'Make it mine',
    danger: false,
  });
  if (!ok) return false;
  const say = useEditorStore.getState().showNotice;
  try {
    await api.sharedModules.detach(layoutId, placed.placedId);
    say(`“${name}” is now a module of this layout.`, 'done', 7000);
    return true;
  } catch (e) {
    say(e instanceof Error ? e.message : String(e), 'error', 7000);
    return false;
  }
}

/** "Put back Alice’s version": the menu's and the notice's words. */
export function putBackLabel(by: string | null | undefined): string {
  return by ? `Put back ${by}’s version` : 'Put back the owner’s version';
}

// ---- Copy and paste ------------------------------------------------------------
//
// A copied shared module pastes as another shared placement (the owner's
// name, the same link and lock) when it can follow its owner in the layout
// it is pasted into; else as an ordinary module, and the person is told.

type WithShared = SidecarModule & { shared?: unknown };

/** The module as the clipboard keeps it: a shared one's placement names its sheets, not their ids (they differ in another layout). */
export function forClipboard(m: SidecarModule, sheetName: (layerId: string) => string | undefined): SidecarModule {
  const s = sharedPlaced(m);
  if (!s?.placement?.sheets) return m;
  const sheets: Record<string, string> = {};
  for (const [k, id] of Object.entries(s.placement.sheets)) {
    const name = sheetName(id);
    if (name !== undefined) sheets[k] = name;
  }
  const link = (m as WithShared).shared as Record<string, unknown>;
  return { ...m, shared: { ...link, placement: { ...s.placement, sheets } } } as SidecarModule;
}

/**
 * The pasted copy of a shared module: another shared placement holding
 * `members`, moved along by the paste (`dx`, `dy`), each of its version's
 * sheets the one its parts were pasted on (`sheetId`, by the name the
 * clipboard kept). Its review, if any, stays with the original.
 */
export function pastedShared(m: SidecarModule, members: string[], dx: number, dy: number, sheetId: (name: string) => string | undefined): SidecarModule {
  const s = sharedPlaced(m)!;
  const { review: _review, ...link } = ((m as WithShared).shared ?? {}) as Record<string, unknown>;
  let placement: Placement | undefined;
  if (s.placement) {
    const sheets: Record<string, string> = {};
    for (const [k, name] of Object.entries(s.placement.sheets ?? {})) {
      const id = sheetId(name);
      if (id) sheets[k] = id;
    }
    placement = { ...movedPlacement(s.placement, dx, dy), sheets };
  }
  return {
    ...moduleCopy(m, members),
    name: m.name,
    libraryModuleId: s.moduleId,
    ...(s.version ? { libraryVersion: s.version } : {}),
    shared: { ...link, ...(placement ? { placement } : {}) },
  } as SidecarModule;
}

/** Whether a copy of library module `moduleId` placed here follows its owner: this layout already has it shared, or it is shared with the layout's owner too. */
export async function followsHere(moduleId: string): Promise<boolean> {
  const layoutId = layoutOnServer;
  if (!layoutId) return false;
  try {
    const list = await api.sharedModules.list(layoutId);
    if (list.modules.some((r) => r.moduleId === moduleId && r.state === 'shared')) return true;
    return (await api.sharedModules.check(layoutId, moduleId))?.state === 'shared';
  } catch {
    return false;
  }
}

/** What a paste says when a shared module couldn't stay shared. */
export function pastedLooseText(m: Pick<SidecarModule, 'name'>, by: string | null): string {
  const name = m.name ? `“${m.name}”` : 'The shared module';
  const owner = by || 'its owner';
  return layoutOnServer
    ? `${name} is shared by ${owner}, but not with this layout, so the pasted copy is an ordinary module: it won’t get ${owner}’s updates. To place it shared here, ask ${owner} to share it with this layout’s owner.`
    : `${name} is shared by ${owner}, and only a layout on the server can follow ${by ? `${by}’s` : 'its owner’s'} updates, so the pasted copy is an ordinary module.`;
}
