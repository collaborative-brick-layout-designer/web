// Module library panel — port of desktop ModuleLibraryPanel.cpp.
// Lists the user's saved server modules; supports click-to-insert and
// drag-to-canvas (MIME `application/x-cld-module` carrying the module id).
// Drag drop is handled by the canvas event listeners in EditorPage.

import { Fragment, useRef, useState } from 'react';
import * as Y from 'yjs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ModuleSummary, SharedModuleSummary } from '../api';
import { api } from '../api';
import { useEditorStore } from './editorStore';
import { placeModuleAsking } from './SheetChoiceDialog';
import { fetchModuleBatches } from './moduleSnapshot';
import { libraryPlacement } from './sharedModules';

import { MODULE_MIME, MODULE_NAME_MIME, activeModuleDrag } from './mime';
import { ModuleThumb } from '../modules/ModuleThumb';
import { MoreMenu, MORE_ITEM } from '../ui/MoreMenu';
import { CreditLine, ReturnMenuItems } from '../owners/OwnerControls';
import { AddToCollectionDialog } from '../catalog/AddToCollection';
import { useIsDemo } from '../catalog/ShareToCatalog';
import { IconSizeSlider, useListIconSize, useResizeGestures } from './listIconSize';
import { askConfirm, confirmDelete, toastDeleted } from '../ui/ConfirmDialog';
import { clubCan } from '../orgs/clubPermissions';
import { errorText } from '../api';

/** What the server says when the module was already off the club's list. */
const NOT_SHARED = errorText('not_shared');
import { MODULE_DELETE_WORDING } from '../ui/deleteWording';
import { restoreDeleted } from '../trash/RecentlyDeleted';
import { HelpButton } from '../help/HelpButton';
import type { VenueLengthUnit } from '@cld/bbm';
import { LibraryModuleSetupDialog } from './ModuleSetupDialog';
import { powerText, tableText } from './moduleSetupText';
import { useLengthUnit } from '../theme/PrefsProvider';
export { MODULE_MIME };

type LibraryTab = 'mine' | 'clubs' | 'shared';

/** The club that shared a module with a club of yours (another club's module, not shared with you in person), or null. */
export function fromClubOf(m: Pick<ModuleSummary, 'owner'> & { sharedVia?: SharedModuleSummary['sharedVia'] }): string | null {
  return m.owner?.kind === 'org' && m.sharedVia && !m.sharedVia.direct && m.sharedVia.clubs.length > 0 ? m.owner.name : null;
}
/** The version a module row shows: never below 1 (a copy made before it had a first version, or one that was never saved, is version 1). */
export function shownVersion(m: Pick<ModuleSummary, 'docVersion' | 'latestVersion'>, shared: boolean): number {
  return Math.max(1, (shared ? (m.latestVersion ?? m.docVersion) : m.docVersion) || 0);
}

const LIBRARY_TABS: { id: LibraryTab; label: string }[] = [
  { id: 'mine', label: 'Mine' },
  { id: 'clubs', label: 'Clubs' },
  { id: 'shared', label: 'Shared with me' },
];

interface Props {
  doc: Y.Doc;
  isViewer: boolean;
  /** In the module editor: the module being edited (it can't go into itself). */
  editingModuleId?: string | null;
}

export function ModuleLibraryPanel({ doc, isViewer, editingModuleId = null }: Props) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['modules'], queryFn: api.modules.list, staleTime: 30_000 });
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [inserting, setInserting] = useState<string | null>(null);
  const [toCollection, setToCollection] = useState<ModuleSummary | null>(null);
  const [setupOf, setSetupOf] = useState<ModuleSummary | null>(null);
  const unit = useLengthUnit();
  const settings = useQuery({ queryKey: ['catalog-settings'], queryFn: api.catalog.settings, staleTime: 60_000 });
  const demo = useIsDemo();
  // Not for the demo account: the server keeps collections to real accounts.
  const collectionsOn = !!settings.data && (settings.data.modules || settings.data.parts) && !demo;

  // Picture size, shared with the Parts list: slider, Ctrl/⌘ + wheel or pinch.
  const [iconSize, setIconSize] = useListIconSize();
  const listRef = useRef<HTMLDivElement>(null);
  useResizeGestures(listRef, iconSize, setIconSize);

  // Mine / Clubs / Shared with me (docs/shared-modules.md): other people's modules shared
  // with you, in person or through a club, are on their own tab, each with its owner.
  const sharedList = useQuery({ queryKey: ['modules-shared'], queryFn: api.modules.sharedWithMe, staleTime: 30_000 });
  const [tab, setTab] = useState<LibraryTab>('mine');
  const sharedIds = new Set((sharedList.data?.modules ?? []).map((m) => m.id));
  const own = (list.data?.modules ?? []).filter((m) => !sharedIds.has(m.id));
  // Another club's module, shared with a club of yours (a partner, or accepted one off):
  // on the Clubs tab, under the club that shared it (docs/shared-modules.md, section 11).
  const fromClubs = (sharedList.data?.modules ?? []).filter((m) => fromClubOf(m) !== null);
  const byTab: Record<LibraryTab, ModuleSummary[]> = {
    mine: own.filter((m) => !m.ownerOrgId),
    clubs: [...own.filter((m) => !!m.ownerOrgId), ...[...fromClubs].sort((a, b) => (fromClubOf(a) ?? '').localeCompare(fromClubOf(b) ?? '') || a.title.localeCompare(b.title))],
    shared: (sharedList.data?.modules ?? []).filter((m) => fromClubOf(m) === null),
  };
  const modules = byTab[tab].filter((m) =>
    !filter.trim() || m.title.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  /** The heading over a run of another club's modules on the Clubs tab ("From Train Club"), or null. */
  const headingBefore = (i: number): string | null => {
    if (tab !== 'clubs') return null;
    const from = fromClubOf(modules[i]!);
    if (!from) return null;
    const prev = i > 0 ? fromClubOf(modules[i - 1]!) : null;
    return prev === from ? null : from;
  };
  // A club's admins and managers (whoever may delete the club's things) can take a
  // module shared with the club off its list; copies already placed stay.
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: api.orgs.list, staleTime: 60_000 });
  const removableFrom = (m: ModuleSummary): { id: string; name: string }[] => {
    const s = sharedList.data?.modules.find((x) => x.id === m.id);
    if (!s || isViewer) return [];
    return s.sharedVia.clubs.filter((c) => {
      const org = orgs.data?.orgs.find((o) => o.id === c.id || o.slug === c.slug);
      return !!org && (org.isAdmin === true || clubCan(org, 'delete_items'));
    });
  };
  async function removeFromClub(m: SharedModuleSummary | ModuleSummary, club: { id: string; name: string }) {
    const owner = (m as SharedModuleSummary).owner?.name;
    const ok = await askConfirm({
      title: `Take “${m.title}” off ${club.name}?`,
      keeps: 'The club’s layouts keep it as it is now.',
      removes: owner
        ? `The club gets no more updates of it, and its members can’t place it again. ${owner} is told.`
        : 'The club gets no more updates of it, and its members can’t place it again. Its owner is told.',
      confirmLabel: 'Remove',
      danger: false,
    });
    if (!ok) return;
    try {
      await api.modules.stopClubShare(m.id, club.id);
      useEditorStore.getState().showNotice(`“${m.title}” is off ${club.name}’s list.`, 'done', 6000);
    } catch (e) {
      // (Someone else took it off meanwhile: the list just catches up.)
      const said = e instanceof Error ? e.message : String(e);
      if (said !== NOT_SHARED) setError(`Couldn’t remove “${m.title}”: ${said}`);
    }
    void qc.invalidateQueries({ queryKey: ['modules-shared'] });
  }
  const sharedVia = (m: ModuleSummary): string | null => {
    const s = sharedList.data?.modules.find((x) => x.id === m.id);
    if (!s) return null;
    // Another club's: the heading names that club; the line says which of your clubs has it.
    if (fromClubOf(s)) return `shared with ${s.sharedVia.clubs.map((c) => c.name).join(', ')}`;
    const who = s.owner?.name ? `${s.owner.name} · ` : '';
    return `${who}${s.sharedVia.clubs.length > 0 ? `via ${s.sharedVia.clubs.map((c) => c.name).join(', ')}` : 'shared with you'}`;
  };

  async function insertModule(moduleId: string) {
    if (inserting) return;
    setError(null);
    setInserting(moduleId);
    try {
      const batches = await fetchModuleBatches(moduleId);
      // Bricks land on host layers matching the module's layer names and
      // are registered as a sidecar module in the same undo step
      // (desktop ImportBbmAsModuleCommand).
      const found = [...(list.data?.modules ?? []), ...(sharedList.data?.modules ?? [])].find((m) => m.id === moduleId);
      const title = found?.title ?? 'Module';
      // Linked to the Module library module: Update from Module library follows it.
      const version = found?.latestVersion;
      const library = await libraryPlacement(moduleId, version, { degrees: 0, x: 0, y: 0 });
      if (!library) return;
      const res = await placeModuleAsking(doc, batches, { name: title, library });
      if (res) useEditorStore.getState().setSelection(res.ids);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInserting(null);
    }
  }

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-panel text-sm">
      <div className="flex items-center gap-2 border-b border-line p-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter modules…"
          className="min-w-0 flex-1 rounded-lg border border-border bg-soft px-2 py-1 text-xs"
        />
        <IconSizeSlider value={iconSize} onChange={setIconSize} label="Module picture size" className="w-28 shrink-0" />
      </div>
      <div role="tablist" aria-label="Whose modules" className="flex items-center gap-1 border-b border-line px-2 py-1.5 text-xs">
        {LIBRARY_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            data-testid={`module-library-tab-${t.id}`}
            {...(t.id === 'shared' ? { 'data-tour': 'module.shared' } : {})}
            onClick={() => setTab(t.id)}
            className={`min-h-7 rounded-control px-2 pointer-coarse:min-h-11 ${tab === t.id ? 'bg-accent-soft font-semibold text-accent-text' : 'text-muted hover:bg-soft hover:text-ink'}`}
          >
            {t.label}
            {byTab[t.id].length > 0 ? ` (${byTab[t.id].length})` : ''}
          </button>
        ))}
        <HelpButton helpKey="module.shared" />
      </div>
      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto touch-pan-y">
        {list.isLoading && <p className="p-3 text-xs text-muted">Loading…</p>}
        {!list.isLoading && modules.length === 0 && (
          <p className="p-3 text-xs text-muted">
            {filter
              ? 'No modules match.'
              : tab === 'shared'
                ? 'Nothing is shared with you yet. When someone shares a module with you or one of your clubs, it shows here, ready to place.'
                : tab === 'clubs'
                  ? 'Your clubs have no modules yet.'
                  : 'No saved modules yet. Make a module in this layout, then choose Save to Module library… from its ⋯ menu.'}
          </p>
        )}
        {error && (
          <p className="mx-2 mt-2 rounded-lg border border-red-900 bg-red-950/30 px-2 py-1 text-xs text-red-300">
            {error}
          </p>
        )}
        <ul className="divide-y divide-line/60">
          {modules.map((m, i) => (
            <Fragment key={m.id}>
            {headingBefore(i) && (
              <li className="bg-soft/40 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted" data-testid="module-library-from-club">
                From {headingBefore(i)}
              </li>
            )}
            <ModuleLibraryRow
              module={m}
              thumbPx={iconSize}
              isViewer={isViewer}
              sharedVia={sharedVia(m)}
              removeFrom={removableFrom(m).map((c) => ({ name: c.name, onRemove: () => void removeFromClub(m, c) }))}
              isInserting={inserting === m.id}
              isEditingThis={m.id === editingModuleId}
              insertLabel={editingModuleId ? 'Add to this module' : 'Add to layout'}
              onInsert={() => void insertModule(m.id)}
              onRename={(newTitle) =>
                api.modules.rename(m.id, newTitle).then(() =>
                  qc.invalidateQueries({ queryKey: ['modules'] }),
                )
              }
              onAddToCollection={collectionsOn && (m.role === undefined || m.role === 'owner') ? () => setToCollection(m) : undefined}
              unit={unit}
              onSetup={m.role === undefined || m.role === 'owner' || m.role === 'editor' ? () => setSetupOf(m) : undefined}
              onDelete={async () => {
                if (!(await confirmDelete(m.title, MODULE_DELETE_WORDING))) return;
                void api.modules.remove(m.id).then((r) => {
                  toastDeleted(m.title, r.trashId ? () => void restoreDeleted(r.trashId, m.title) : undefined);
                  return qc.invalidateQueries({ queryKey: ['modules'] });
                });
              }}
            />
            </Fragment>
          ))}
        </ul>
      </div>
      {toCollection && <AddToCollectionDialog target={{ kind: 'module', module: toCollection }} onClose={() => setToCollection(null)} />}
      {setupOf && <LibraryModuleSetupDialog module={setupOf} onClose={() => setSetupOf(null)} />}
    </aside>
  );
}

function ModuleLibraryRow({
  module,
  thumbPx,
  isViewer,
  isInserting,
  isEditingThis,
  insertLabel,
  onInsert,
  onRename,
  onDelete,
  onAddToCollection,
  sharedVia,
  removeFrom = [],
  unit,
  onSetup,
}: {
  /** The unit heights are shown in. */
  unit: VenueLengthUnit;
  /** "Table and power…" (when you may change the module). */
  onSetup?: (() => void) | undefined;
  /** Shared with a club you run: "Remove from ‹club›…", one per club. */
  removeFrom?: { name: string; onRemove: () => void }[];
  /** Someone else's module shared with you: "Alice · via Riverside LUG" (it has no menu: it isn't yours to change). */
  sharedVia?: string | null;
  module: ModuleSummary;
  thumbPx: number;
  isViewer: boolean;
  isInserting: boolean;
  /** This is the module open in the editor right now. */
  isEditingThis: boolean;
  insertLabel: string;
  onInsert: () => void;
  onRename: (title: string) => Promise<unknown>;
  onDelete: () => void;
  /** "Add to a collection…" (your own modules, and your club's when you run it). */
  onAddToCollection?: (() => void) | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [renaming, setRenaming] = useState(false);

  function startRename() {
    setDraft(module.title);
    setEditing(true);
  }

  async function commitRename() {
    const title = draft.trim();
    if (!title || title === module.title) { setEditing(false); return; }
    setRenaming(true);
    try {
      await onRename(title);
    } finally {
      setRenaming(false);
      setEditing(false);
    }
  }

  return (
    <li
      draggable={!editing && !isEditingThis && !module.empty}
      onDragStart={(e) => {
        if (!e.dataTransfer) return;
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData(MODULE_MIME, module.id);
        e.dataTransfer.setData(MODULE_NAME_MIME, module.title);
        e.dataTransfer.setData('text/plain', module.id);
        activeModuleDrag.id = module.id;
        activeModuleDrag.session++;
      }}
      onDragEnd={() => {
        activeModuleDrag.id = null;
      }}
      className={`flex items-start gap-2 px-2 py-2 ${isEditingThis ? 'bg-soft/60' : 'cursor-grab hover:bg-soft/60 active:cursor-grabbing'}`}
      data-testid="module-library-row"
    >
      <ModuleThumb module={module} px={thumbPx} />
      {/* The name and details, with the buttons on their own line under them,
          so a big picture in a narrow panel never squeezes the name away. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="min-w-0 leading-tight" onDoubleClick={isViewer || isEditingThis || module.empty ? undefined : onInsert}>
          {editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitRename();
                if (e.key === 'Escape') setEditing(false);
              }}
              disabled={renaming}
              className="w-full rounded-lg border border-neutral-600 bg-neutral-700 px-1 py-0 text-xs text-ink"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <p className="line-clamp-2 break-words text-xs font-medium text-ink" title={module.title}>
              {module.title}
            </p>
          )}
          <p className="text-[11px] text-muted">
            v{shownVersion(module, !!sharedVia)} · {new Date(module.updatedAt).toLocaleDateString()}
          </p>
          {(module.setup?.table || module.setup?.power) && (
            <p className="text-[11px] text-muted" data-testid="module-library-setup">
              {[module.setup.table ? tableText(module.setup.table, unit) : null, module.setup.power ? powerText(module.setup.power) : null]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          {sharedVia && (
            <p className="text-[11px] text-muted" data-testid="module-shared-via">
              <span aria-hidden>🔗 </span>
              {sharedVia}
            </p>
          )}
          {removeFrom.map((r) => (
            <button
              key={r.name}
              type="button"
              data-testid="module-remove-club-share"
              onClick={r.onRemove}
              title="Take this module off the club’s list. Copies already placed stay as they are."
              className="block text-left text-[11px] text-muted underline decoration-dotted underline-offset-2 hover:text-ink pointer-coarse:min-h-11"
            >
              Remove from {r.name}…
            </button>
          ))}
          {module.empty && (
            <p className="text-[11px] font-semibold text-muted" data-testid="module-empty" title="Open it to add some parts, then it can go in a layout.">
              No parts yet
            </p>
          )}
          <CreditLine credit={module.credit} className="!text-[11px] truncate" />
        </div>
        {isEditingThis ? (
          <span className="self-start rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-text" data-testid="editing-now">
            Editing now
          </span>
        ) : (
          !isViewer && (
            <div className="flex min-w-0 items-center gap-1">
              {/* The main thing to do with a module here: put it in what you're editing. */}
              <button
                type="button"
                onClick={onInsert}
                disabled={isInserting || module.empty}
                title={module.empty ? 'No parts yet: open it to add some' : insertLabel}
                className="min-h-8 min-w-0 flex-1 truncate rounded-control border border-line px-2 text-xs font-semibold text-ink hover:bg-soft disabled:opacity-40 pointer-coarse:min-h-11"
              >
                {isInserting ? 'Adding…' : insertLabel}
              </button>
              {!sharedVia && <MoreMenu label={`More for ${module.title}`}>
                <a role="menuitem" href={`/modules/${module.id}`} target="_blank" rel="noreferrer" className={MORE_ITEM}>
                  Open to change it (new tab)
                </a>
                <button role="menuitem" type="button" onClick={startRename} className={MORE_ITEM}>
                  Rename…
                </button>
                {onSetup && (
                  <button role="menuitem" type="button" data-testid="module-library-setup-open" onClick={onSetup} className={MORE_ITEM}>
                    Table and power…
                  </button>
                )}
                {onAddToCollection && (
                  <button role="menuitem" type="button" onClick={onAddToCollection} className={MORE_ITEM}>
                    Add to a collection…
                  </button>
                )}
                <ReturnMenuItems kind="modules" id={module.id} title={module.title} credit={module.credit} />
                <button role="menuitem" type="button" onClick={onDelete} className={`${MORE_ITEM} text-danger`}>
                  Delete…
                </button>
              </MoreMenu>}
            </div>
          )
        )}
      </div>
    </li>
  );
}
