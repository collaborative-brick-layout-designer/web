// A picked module's menu on a phone or tablet (the touch bar's Module
import { lazyRetry } from '../ui/lazyRetry';
// button): Edit module, Pin in place, Show / Hide name, Colors… and the
// Module library entries (Save to library…, Update Module library version…,
// Update from Module library), as the map's right-click menu has them.

import { Suspense, useEffect, useState } from 'react';
import type * as Y from 'yjs';
import { readSidecarFromDoc } from '@cld/ydoc';
import { enterModuleEdit, setModulePinned } from './moduleActions';
import { useLibraryEntries, type ModuleMenuEntry } from './moduleLibraryMenu';
import { updateSidecarModule } from './mutations';
import { withShowName } from './moduleLook';

const ModuleLookDialog = lazyRetry(() => import('./ModuleLookDialog').then((m) => ({ default: m.ModuleLookDialog })));

export function TouchModuleSheet({ doc, moduleId, onClose }: { doc: Y.Doc; moduleId: string; onClose: () => void }) {
  const mod = readSidecarFromDoc(doc)?.modules?.find((m) => m.id === moduleId);
  const library = useLibraryEntries(doc);
  const [open, setOpen] = useState(false);
  // Colors… replaces the sheet with the colors dialog; closing it closes both.
  const [look, setLook] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!mod) return null;
  if (look) {
    return (
      <Suspense fallback={null}>
        <ModuleLookDialog doc={doc} moduleId={mod.id} onClose={onClose} />
      </Suspense>
    );
  }
  const hidden = mod.showName === false;
  const entries: (ModuleMenuEntry & { keepOpen?: boolean })[] = [
    { id: 'edit', label: 'Edit module', onSelect: () => enterModuleEdit(mod.id) },
    { id: 'pin', label: mod.pinned ? 'Unpin' : 'Pin in place', onSelect: () => setModulePinned(doc, mod.id, !mod.pinned) },
    { id: 'name', label: hidden ? 'Show name' : 'Hide name', onSelect: () => updateSidecarModule(doc, mod.id, (m) => withShowName(m, hidden)) },
    { id: 'look', label: 'Colors…', keepOpen: true, onSelect: () => setLook(true) },
    ...library(mod),
  ];
  return (
    <div className="fixed inset-0 z-40" data-no-gesture data-bottom-sheet>
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${open ? 'opacity-100' : 'opacity-0'}`}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={mod.name || 'Module'}
        data-testid="touch-module-sheet"
        className={`absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-line bg-panel text-ink shadow-pop transition-transform duration-200 ease-out ${open ? 'translate-y-0' : 'translate-y-full'}`}
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-line" aria-hidden />
        <div className="flex items-center gap-2 px-4 pt-2">
          <h2 className="min-w-0 flex-1 truncate text-lg font-bold">{mod.name || 'Module'}</h2>
          <button type="button" onClick={onClose} className="min-h-11 rounded-control px-4 text-sm font-bold hover:bg-soft">
            Close
          </button>
        </div>
        <ul className="flex flex-col gap-1 px-2 pt-1">
          {entries.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                disabled={e.disabled}
                data-testid={`touch-module-${e.id}`}
                onClick={() => {
                  if (!e.keepOpen) onClose();
                  e.onSelect();
                }}
                className="flex min-h-12 w-full items-center rounded-control px-3 text-left text-base font-semibold hover:bg-soft disabled:opacity-40"
              >
                {e.label}
              </button>
              {e.disabled && e.title && <p className="px-3 pb-1 text-xs text-muted">{e.title}</p>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
