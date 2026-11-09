// Module library panel — port of desktop ModuleLibraryPanel.cpp.
// Lists the user's saved server modules; supports click-to-insert and
// drag-to-canvas (MIME `application/x-cld-module` carrying the module id).
// Drag drop is handled by the canvas event listeners in EditorPage.

import { useRef, useState } from 'react';
import * as Y from 'yjs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ModuleSummary } from '../api';
import { api } from '../api';
import { useEditorStore } from './editorStore';
import { placeModuleAsking } from './SheetChoiceDialog';
import { fetchModuleBatches } from './moduleSnapshot';

import { MODULE_MIME, MODULE_NAME_MIME, activeModuleDrag } from './mime';
import { ModuleThumb } from '../modules/ModuleThumb';
import { MoreMenu, MORE_ITEM } from '../ui/MoreMenu';
import { CreditLine, ReturnMenuItems } from '../owners/OwnerControls';
import { AddToCollectionDialog } from '../catalog/AddToCollection';
import { useIsDemo } from '../catalog/ShareToCatalog';
import { IconSizeSlider, useListIconSize, useResizeGestures } from './listIconSize';
import { confirmDelete, toastDeleted } from '../ui/ConfirmDialog';
import { MODULE_DELETE_WORDING } from '../ui/deleteWording';
import { restoreDeleted } from '../trash/RecentlyDeleted';
export { MODULE_MIME };

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
  const settings = useQuery({ queryKey: ['catalog-settings'], queryFn: api.catalog.settings, staleTime: 60_000 });
  const demo = useIsDemo();
  // Not for the demo account: the server keeps collections to real accounts.
  const collectionsOn = !!settings.data && (settings.data.modules || settings.data.parts) && !demo;

  // Picture size, shared with the Parts list: slider, Ctrl/⌘ + wheel or pinch.
  const [iconSize, setIconSize] = useListIconSize();
  const listRef = useRef<HTMLDivElement>(null);
  useResizeGestures(listRef, iconSize, setIconSize);

  const modules = (list.data?.modules ?? []).filter((m) =>
    !filter.trim() || m.title.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  async function insertModule(moduleId: string) {
    if (inserting) return;
    setError(null);
    setInserting(moduleId);
    try {
      const batches = await fetchModuleBatches(moduleId);
      // Bricks land on host layers matching the module's layer names and
      // are registered as a sidecar module in the same undo step
      // (desktop ImportBbmAsModuleCommand).
      const found = list.data?.modules.find((m) => m.id === moduleId);
      const title = found?.title ?? 'Module';
      // Linked to the Module library module: Update from Module library follows it.
      const version = found?.latestVersion;
      const res = await placeModuleAsking(doc, batches, { name: title, library: { id: moduleId, ...(version ? { version } : {}) } });
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
      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto touch-pan-y">
        {list.isLoading && <p className="p-3 text-xs text-muted">Loading…</p>}
        {!list.isLoading && modules.length === 0 && (
          <p className="p-3 text-xs text-muted">
            {filter ? 'No modules match.' : 'No saved modules yet. Make a module in this layout, then choose Save to Module library… from its ⋯ menu.'}
          </p>
        )}
        {error && (
          <p className="mx-2 mt-2 rounded-lg border border-red-900 bg-red-950/30 px-2 py-1 text-xs text-red-300">
            {error}
          </p>
        )}
        <ul className="divide-y divide-line/60">
          {modules.map((m) => (
            <ModuleLibraryRow
              key={m.id}
              module={m}
              thumbPx={iconSize}
              isViewer={isViewer}
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
              onDelete={async () => {
                if (!(await confirmDelete(m.title, MODULE_DELETE_WORDING))) return;
                void api.modules.remove(m.id).then((r) => {
                  toastDeleted(m.title, r.trashId ? () => void restoreDeleted(r.trashId) : undefined);
                  return qc.invalidateQueries({ queryKey: ['modules'] });
                });
              }}
            />
          ))}
        </ul>
      </div>
      {toCollection && <AddToCollectionDialog target={{ kind: 'module', module: toCollection }} onClose={() => setToCollection(null)} />}
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
}: {
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
      draggable={!editing && !isEditingThis}
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
        <div className="min-w-0 leading-tight" onDoubleClick={isViewer || isEditingThis ? undefined : onInsert}>
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
            v{module.docVersion} · {new Date(module.updatedAt).toLocaleDateString()}
          </p>
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
                disabled={isInserting}
                title={insertLabel}
                className="min-h-8 min-w-0 flex-1 truncate rounded-control border border-line px-2 text-xs font-semibold text-ink hover:bg-soft disabled:opacity-40 pointer-coarse:min-h-11"
              >
                {isInserting ? 'Adding…' : insertLabel}
              </button>
              <MoreMenu label={`More for ${module.title}`}>
                <a role="menuitem" href={`/modules/${module.id}`} target="_blank" rel="noreferrer" className={MORE_ITEM}>
                  Open to change it (new tab)
                </a>
                <button role="menuitem" type="button" onClick={startRename} className={MORE_ITEM}>
                  Rename…
                </button>
                {onAddToCollection && (
                  <button role="menuitem" type="button" onClick={onAddToCollection} className={MORE_ITEM}>
                    Add to a collection…
                  </button>
                )}
                <ReturnMenuItems kind="modules" id={module.id} title={module.title} credit={module.credit} />
                <button role="menuitem" type="button" onClick={onDelete} className={`${MORE_ITEM} text-danger`}>
                  Delete…
                </button>
              </MoreMenu>
            </div>
          )
        )}
      </div>
    </li>
  );
}
