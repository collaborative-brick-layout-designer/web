// Modules panel — port of desktop's ModulesPanel (`src/ui/ModulesPanel.cpp`).
// Lists sidecar modules: name, member count, optional sourceFile.
// Click → toggle member-brick selection.
// Right-click or ⋯ → its menu, with the Module library entries (Save to Module library…,
// Update Module library version…, Update from Module library: moduleLibraryMenu.ts).
// Make a module opens ModuleDialogs.tsx; Import… is ImportBbmDialog.

import { useOnScreen } from './menuPosition';
import { useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { useQuery } from '@tanstack/react-query';
import type { SidecarModule } from '@cld/bbm';
import { readSidecarFromDoc } from '@cld/ydoc';
import { useEditorStore } from './editorStore';
import { api } from '../api';
import {
  cloneModuleBricks,
  deleteModuleWithParts,
  flattenSidecarModule,
  moveModuleBricks,
  renameSidecarModule,
  rotateModuleBricks,
  updateSidecarModule,
} from './mutations';
import { enterModuleEdit, leaveModuleEdit, openMakeModule, setModulePinned } from './moduleActions';
import { libraryNote, libraryState } from './moduleLibrary';
import { useLibraryEntries, type ModuleMenuEntry } from './moduleLibraryMenu';
import { askConfirm, confirmDelete } from '../ui/ConfirmDialog';
import { ModuleLookDialog } from './ModuleLookDialog';
import { withShowName } from './moduleLook';
import { useDocMap } from './useDocMap';
import { hiddenSheetsNote, moduleSheetsUsed } from './moduleSheets';
import { indexParts } from './partIndex';
import type { PartGeom } from './brickGeometry';

interface Props {
  doc: Y.Doc;
  isViewer: boolean;
}

export function ModulesPanel({ doc, isViewer }: Props) {
  const sidecar = readSidecarFromDoc(doc);
  const modules = sidecar?.modules ?? [];
  const map = useDocMap(doc);

  const library = useQuery({ queryKey: ['modules'], queryFn: api.modules.list, enabled: modules.length > 0 });
  const libraryEntries = useLibraryEntries(doc);
  // Rotate needs each part's footprint, as rotating picked parts does.
  const catalog = useQuery({ queryKey: ['parts-catalog'], queryFn: api.parts.catalog, staleTime: 5 * 60 * 1000 });
  const partsByKey = useMemo(() => indexParts(catalog.data?.parts), [catalog.data]);
  const partOf = (partNumber: string) => partsByKey.get(partNumber.toLowerCase());
  // Desktop ModulesPanel's "Make a module" (createModuleRequested).
  const createButton = isViewer ? null : (
    <button
      onClick={() => openMakeModule(doc)}
      className="rounded-lg border border-border px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-neutral-300 hover:bg-soft"
      title="Make the picked parts one module in this layout"
    >
      + Make a module
    </button>
  );

  if (modules.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-center text-xs text-neutral-600">
        No modules in this layout yet. Pick some parts, then make them a module. To use one in other layouts, save it to your Module library from its ⋯ menu.
        {createButton}
      </div>
    );
  }

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-panel text-sm">
      <div className="flex items-center justify-between gap-2 border-b border-line px-2 py-1.5 text-xs uppercase tracking-wider text-muted">
        <span>Modules</span>
        <span className="flex items-center gap-2">
          {createButton}
          <span className="text-neutral-600">{modules.length}</span>
        </span>
      </div>
      <ul className="flex-1 min-h-0 overflow-y-auto">
        {modules.map((mod) => (
          <ModuleRow
            key={mod.id}
            module={mod}
            doc={doc}
            isViewer={isViewer}
            hiddenNote={map ? hiddenSheetsNote(moduleSheetsUsed(map, mod.members)) : null}
            libraryLine={libraryNote(libraryState(mod, library.data?.modules))}
            libraryEntries={libraryEntries(mod)}
            partOf={partOf}
          />
        ))}
      </ul>
    </aside>
  );
}

function ModuleRow({
  module,
  doc,
  isViewer,
  hiddenNote,
  libraryLine,
  libraryEntries,
  partOf,
}: {
  partOf: (partNumber: string) => PartGeom | undefined;
  module: SidecarModule;
  doc: Y.Doc;
  isViewer: boolean;
  /** Some or all of its parts are on hidden sheets: says so. */
  hiddenNote: string | null;
  /** "in the Module library v3 · v4 is newer", or null when not linked. */
  libraryLine: string | null;
  /** Save to Module library…, Update Module library version…, Update from Module library. */
  libraryEntries: ModuleMenuEntry[];
}) {
  const selection = useEditorStore((s) => s.selection);
  const setSelection = useEditorStore((s) => s.setSelection);
  const editingId = useEditorStore((s) => s.editingModuleId);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(module.name);
  const [showMove, setShowMove] = useState(false);
  // The Rotate submenu opens on hover with a mouse, and on a tap (no hover on a touch screen).
  const [rotateOpen, setRotateOpen] = useState(false);
  const [lookOpen, setLookOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuStyle = useOnScreen(menuRef, ctxMenu);

  const isMembersSelected =
    module.members.length > 0 &&
    module.members.every((id) => selection.includes(id));

  useEffect(() => {
    if (!ctxMenu) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setCtxMenu(null);
    }
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [ctxMenu]);

  function selectMembers() {
    setSelection(module.members);
    setCtxMenu(null);
  }

  function toggleMembers() {
    if (isMembersSelected) {
      setSelection(selection.filter((id) => !module.members.includes(id)));
    } else {
      const combined = new Set([...selection, ...module.members]);
      setSelection([...combined]);
    }
  }

  function commitRename() {
    const name = draft.trim() || module.name;
    renameSidecarModule(doc, module.id, name);
    setRenaming(false);
    setCtxMenu(null);
  }

  return (
    <li
      onClick={toggleMembers}
      onContextMenu={(e) => {
        if (isViewer) return;
        e.preventDefault();
        setRotateOpen(false);
        setCtxMenu({ x: e.clientX, y: e.clientY });
      }}
      className={
        'relative cursor-pointer border-b border-line/60 px-2 py-1.5 text-xs hover:bg-soft/60 ' +
        (isMembersSelected ? 'bg-blue-900/30' : '')
      }
    >
      {renaming ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            else if (e.key === 'Escape') { setDraft(module.name); setRenaming(false); }
          }}
          onBlur={commitRename}
          className="w-full rounded-lg border border-border bg-soft px-1 py-0.5 text-xs"
        />
      ) : (
        <span className="flex items-center gap-1">
          {(module.outlineColor || module.nameColor) && (
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-black/30"
              style={{ background: module.outlineColor ?? module.nameColor }}
            />
          )}
          <span className="min-w-0 flex-1">
            <span className="font-medium text-ink">{module.name || '(untitled)'}</span>
            {module.pinned && (
              <span className="ml-1 text-muted" title="Pinned in place" aria-label="Pinned in place">
                📌
              </span>
            )}
            {editingId === module.id && <span className="ml-1 text-xs text-accent">editing</span>}
            <span className="ml-2 text-neutral-600">
              {module.members.length} part{module.members.length !== 1 ? 's' : ''}
              {module.sourceFile && !libraryLine && !/^[0-9a-f-]{36}$/.test(module.sourceFile) ? ` — ${module.sourceFile.split(/[\\/]/).pop()}` : ''}
            </span>
            {libraryLine && (
              <span data-testid="module-library-note" className="ml-2 text-xs text-muted">
                {libraryLine}
              </span>
            )}
            {hiddenNote && (
              <span data-testid="module-hidden-note" className="ml-2 text-xs italic text-muted">
                {hiddenNote}
              </span>
            )}
          </span>
          {!isViewer && (
            <button
              type="button"
              aria-label={`More for ${module.name || 'this module'}`}
              title="More"
              data-testid="module-more"
              aria-haspopup="menu"
              onClick={(e) => {
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                setRotateOpen(false);
                setCtxMenu(ctxMenu ? null : { x: r.right - 170, y: r.bottom + 2 });
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted hover:bg-soft hover:text-ink"
            >
              ⋯
            </button>
          )}
        </span>
      )}

      {lookOpen && <ModuleLookDialog doc={doc} moduleId={module.id} onClose={() => setLookOpen(false)} />}
      {showMove && (
        <ModuleMoveDialog
          moduleName={module.name}
          onMove={(dx, dy) => { moveModuleBricks(doc, module.members, dx, dy); setShowMove(false); }}
          onClose={() => setShowMove(false)}
        />
      )}
      {ctxMenu && (
        <div
          ref={menuRef}
          style={menuStyle}
          className="min-w-[170px] rounded-lg border border-border bg-panel py-1 text-xs shadow-lg"
          onContextMenu={(e) => e.preventDefault()}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
            onClick={selectMembers}
          >
            Select its parts
          </button>
          <button
            data-testid="module-menu-edit"
            className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
            onClick={() => {
              setCtxMenu(null);
              if (editingId === module.id) leaveModuleEdit();
              else enterModuleEdit(module.id);
            }}
          >
            {editingId === module.id ? 'Done editing' : 'Edit module'}
          </button>
          <button
            data-testid="module-menu-pin"
            className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
            onClick={() => { setCtxMenu(null); setModulePinned(doc, module.id, !module.pinned); }}
          >
            {module.pinned ? 'Unpin' : 'Pin in place'}
          </button>
          <hr className="my-1 border-border" />
          <button
            className="block w-full px-3 py-1 text-left hover:bg-neutral-700 disabled:cursor-default disabled:opacity-40"
            disabled={!!module.pinned}
            title={module.pinned ? 'Pinned in place: unpin it to move it' : undefined}
            onClick={() => { setCtxMenu(null); setShowMove(true); }}
          >
            Move…
          </button>
          <div className="group relative">
            <button
              className="block w-full px-3 py-1 text-left hover:bg-neutral-700 disabled:cursor-default disabled:opacity-40"
              disabled={!!module.pinned}
              title={module.pinned ? 'Pinned in place: unpin it to turn it' : undefined}
              aria-expanded={rotateOpen}
              onClick={() => setRotateOpen((o) => !o)}
            >
              Turn ▸
            </button>
            <div className={`absolute left-full top-0 min-w-[100px] rounded-lg border border-border bg-panel py-1 shadow-lg ${module.pinned ? '' : 'group-hover:block'} ${rotateOpen && !module.pinned ? 'block' : 'hidden'}`}>
              {([-90, -45, 45, 90, 180] as const).map((deg) => (
                <button
                  key={deg}
                  className="block w-full px-3 py-1 text-left text-xs hover:bg-neutral-700"
                  onClick={() => {
                    setCtxMenu(null);
                    rotateModuleBricks(doc, module.members, deg, partOf);
                  }}
                >
                  {deg > 0 ? `+${deg}°` : `${deg}°`}
                </button>
              ))}
            </div>
          </div>
          <hr className="my-1 border-border" />
          <button
            className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
            onClick={() => { setCtxMenu(null); setDraft(module.name); setRenaming(true); }}
          >
            Rename…
          </button>
          <button
            role="menuitemcheckbox"
            aria-checked={module.showName !== false}
            data-testid="module-menu-show-name"
            className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-neutral-700"
            onClick={() => {
              setCtxMenu(null);
              updateSidecarModule(doc, module.id, (m) => withShowName(m, m.showName === false));
            }}
          >
            <span className="w-3">{module.showName !== false ? '✓' : ''}</span>
            Show name
          </button>
          <button
            data-testid="module-menu-look"
            className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
            onClick={() => { setCtxMenu(null); setLookOpen(true); }}
          >
            Colors…
          </button>
          <button
            className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
            onClick={() => { setCtxMenu(null); cloneModuleBricks(doc, module); }}
          >
            Duplicate
          </button>
          <hr className="my-1 border-border" />
          {libraryEntries.map((e) => (
            <button
              key={e.id}
              data-testid={`module-menu-${e.id}`}
              className="block w-full px-3 py-1 text-left hover:bg-neutral-700 disabled:cursor-default disabled:opacity-40"
              disabled={e.disabled}
              title={e.title}
              onClick={() => { setCtxMenu(null); e.onSelect(); }}
            >
              {e.label}
            </button>
          ))}
          <hr className="my-1 border-border" />
          <button
            className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
            onClick={async () => {
              setCtxMenu(null);
              const ok = await askConfirm({
                title: `Ungroup “${module.name}”?`,
                removes: 'It leaves the module list.',
                keeps: 'Its parts stay where they are.',
                undo: 'You can undo this with Ctrl+Z.',
                confirmLabel: 'Ungroup',
                danger: false,
              });
              if (!ok) return;
              flattenSidecarModule(doc, module.id);
            }}
          >
            Ungroup (keep the parts)
          </button>
          <hr className="my-1 border-border" />
          <button
            className="block w-full px-3 py-1 text-left text-danger hover:bg-neutral-700"
            onClick={async () => {
              setCtxMenu(null);
              const n = module.members.length;
              const ok = await confirmDelete(module.name, {
                removes: `The module and its ${n === 1 ? 'part' : `${n} parts`} leave the map.`,
                keeps: 'The Module library doesn’t change. To keep the parts, choose Ungroup instead.',
                undoable: 'You can undo this with Ctrl+Z.',
              });
              if (!ok) return;
              deleteModuleWithParts(doc, module.id);
            }}
          >
            Delete
          </button>
          <hr className="my-1 border-border" />
          <button
            className="block w-full px-3 py-1 text-left text-muted hover:bg-neutral-700"
            onClick={() => setCtxMenu(null)}
          >
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}

function ModuleMoveDialog({
  moduleName,
  onMove,
  onClose,
}: {
  moduleName: string;
  onMove: (dx: number, dy: number) => void;
  onClose: () => void;
}) {
  const [dx, setDx] = useState('0');
  const [dy, setDy] = useState('0');

  function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    const dxN = parseFloat(dx) || 0;
    const dyN = parseFloat(dy) || 0;
    if (dxN === 0 && dyN === 0) { onClose(); return; }
    onMove(dxN, dyN);
  }

  return (
    <div
      className="fixed inset-0 z-10000 grid place-items-center bg-black/60 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <form
        onSubmit={submit}
        className="w-72 space-y-3 rounded-lg border border-line bg-panel p-5 text-sm shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold">Move module — {moduleName}</h3>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">ΔX (studs)</span>
          <input
            type="number"
            step="0.5"
            value={dx}
            onChange={(e) => setDx(e.target.value)}
            autoFocus
            className="w-full rounded-lg border border-border bg-soft px-3 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">ΔY (studs)</span>
          <input
            type="number"
            step="0.5"
            value={dy}
            onChange={(e) => setDy(e.target.value)}
            className="w-full rounded-lg border border-border bg-soft px-3 py-1.5 text-sm"
          />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-soft"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-lg bg-accent text-accent-ink px-3 py-1.5 text-sm hover:bg-accent-hover"
          >
            Move
          </button>
        </div>
      </form>
    </div>
  );
}
