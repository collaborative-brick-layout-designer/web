// "Insert module" command. Lists the user's modules, downloads the
// chosen module's Y.Doc snapshot, extracts its bricks, and inserts
// them into the active layout at the centre of the viewport.
//
// Modules are stored as Y.Doc snapshots with the same shape as a
// layout (PLAN.md §3.2). We reuse `docToBbm` to extract bricks; only
// LayerBrick contents are copied — text cells / areas / rulers in
// modules are silently skipped because the desktop's `Module` doesn't
// model those either.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type * as Y from 'yjs';
import { api } from '../api';
import { ModuleThumb } from '../modules/ModuleThumb';
import { useEditorStore } from './editorStore';
import { placeModuleAsking } from './SheetChoiceDialog';
import { fetchModuleBatches, libraryVersionOf } from './moduleSnapshot';
import { useEscape } from './useEscape';

interface Props {
  doc: Y.Doc;
  onClose: () => void;
}

export function InsertModuleDialog({ doc, onClose }: Props) {
  useEscape(onClose);
  const list = useQuery({ queryKey: ['modules'], queryFn: api.modules.list });
  const [error, setError] = useState<string | null>(null);
  // Your modules, or the public catalog (when it's on).
  const settings = useQuery({ queryKey: ['catalog-settings'], queryFn: api.catalog.settings, staleTime: 60_000 });
  const [tab, setTab] = useState<'mine' | 'catalog'>('mine');
  const [q, setQ] = useState('');
  const catalog = useQuery({
    queryKey: ['catalog-items', 'module', q, '', 'popular'],
    queryFn: () => api.catalog.items('module', { q, sort: 'popular' }),
    enabled: tab === 'catalog',
  });
  const qc = useQueryClient();
  // From the catalog: a copy goes into your modules, then onto the map.
  const fromCatalog = useMutation({
    mutationFn: async (item: { id: string; title: string }) => {
      const copy = await api.catalog.add(item.id);
      void qc.invalidateQueries({ queryKey: ['modules'] });
      const [batches, version] = await Promise.all([fetchModuleBatches(copy.id), libraryVersionOf(copy.id)]);
      // Linked to your copy: Update from Module library follows it.
      const res = await placeModuleAsking(doc, batches, { name: item.title, library: { id: copy.id, ...(version ? { version } : {}) } });
      if (res) useEditorStore.getState().setSelection(res.ids);
      return !!res;
    },
    // Cancel in "Where should these go?" keeps this dialog open.
    onSuccess: (placed) => {
      if (placed) onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  const insert = useMutation({
    mutationFn: async (moduleId: string) => {
      const batches = await fetchModuleBatches(moduleId);
      const version = list.data?.modules.find((m) => m.id === moduleId)?.latestVersion;
      // Modules are saved centred on the origin, so the block lands at
      // (0,0); drag from the Module library to drop it at the cursor.
      // Bricks keep their source layer names and become a sidecar module
      // in the same undo step (desktop ImportBbmAsModuleCommand).
      const title = list.data?.modules.find((m) => m.id === moduleId)?.title ?? 'Module';
      const res = await placeModuleAsking(doc, batches, { name: title, library: { id: moduleId, ...(version ? { version } : {}) } });
      if (res) useEditorStore.getState().setSelection(res.ids);
      return !!res;
    },
    onSuccess: (placed) => {
      if (placed) onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div role="dialog" aria-label="Insert module" aria-modal="true" className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="w-full max-w-md space-y-3 rounded-lg border border-line bg-panel p-6 text-sm">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold">Insert module</h3>
            <p className="text-xs text-muted">
              Pick a saved module to drop its parts onto the active sheet.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-muted hover:bg-soft"
          >
            ✕
          </button>
        </div>

        {settings.data?.modules && (
          <div role="tablist" aria-label="Modules from" className="flex rounded-lg border border-line p-0.5">
            {(['mine', 'catalog'] as const).map((t) => (
              <button
                key={t}
                role="tab"
                type="button"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-semibold ${tab === t ? 'bg-accent text-accent-ink' : 'hover:bg-soft'}`}
              >
                {t === 'mine' ? 'My modules' : 'Catalog'}
              </button>
            ))}
          </div>
        )}
        {tab === 'catalog' && (
          <>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search the catalog"
              aria-label="Search the catalog"
              className="w-full rounded-lg border border-border bg-soft px-3 py-1.5"
            />
            {catalog.isLoading && <p className="text-muted">Loading…</p>}
            {catalog.data && catalog.data.items.length === 0 && <p className="text-muted">Nothing in the catalog yet.</p>}
            <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line">
              {catalog.data?.items.map((it) => (
                <li key={it.id} className="flex items-center gap-3 px-3 py-2">
                  {it.previewUrl ? (
                    <img src={it.previewUrl} alt="" loading="lazy" className="size-14 shrink-0 rounded-lg border border-line bg-soft object-contain" />
                  ) : (
                    <span aria-hidden className="block size-14 shrink-0 rounded-lg border border-line bg-soft" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="break-words">{it.title}</p>
                    <p className="text-xs text-muted">by {it.by} · {it.uses} uses</p>
                  </div>
                  <button
                    onClick={() => fromCatalog.mutate({ id: it.id, title: it.title })}
                    disabled={fromCatalog.isPending}
                    aria-label={`Add and insert ${it.title}`}
                    className="rounded-lg bg-accent px-3 py-1 text-xs text-accent-ink hover:bg-accent-hover disabled:opacity-50"
                  >
                    Add and insert
                  </button>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted">Adding copies it into your modules first.</p>
          </>
        )}
        {tab === 'mine' && list.isLoading && <p className="text-muted">Loading…</p>}
        {tab === 'mine' && list.data && list.data.modules.length === 0 && (
          <p className="rounded-lg border border-dashed border-line p-4 text-muted">
            No saved modules yet. Pick some parts, make them a module (<em>Map ▸ Modules &amp; sets ▸ Make a module</em>), then choose <em>Save to Module library…</em> from its ⋯ menu. Or use <em>New module</em> on Home.
          </p>
        )}
        {tab === 'mine' && list.data && list.data.modules.length > 0 && (
          <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {list.data.modules.map((m) => (
              <li
                key={m.id}
                className="flex items-center justify-between px-3 py-2"
              >
                <ModuleThumb module={m} size="md" />
                <div className="min-w-0 flex-1 px-3">
                  <p className="break-words">{m.title}</p>
                  <p className="text-xs text-muted">
                    v{m.docVersion} · updated {new Date(m.updatedAt).toLocaleString()}
                  </p>
                </div>
                <button
                  onClick={() => insert.mutate(m.id)}
                  disabled={insert.isPending}
                  className="rounded-lg bg-accent text-accent-ink px-3 py-1 text-xs hover:bg-accent-hover disabled:opacity-50"
                >
                  Insert
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && (
          <p className="rounded-lg border border-red-900 bg-red-950/30 p-2 text-xs text-red-300">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

