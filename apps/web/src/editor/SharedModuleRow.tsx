// What the Modules panel adds for a shared module (docs/shared-modules.md):
// its state in words ("Shared by Alice · v7", "v8 is ready", "No longer
// shared"), and its menu: what changed, Update, Go back to an older
// version, and Make it mine.

import { useState } from 'react';
import type * as Y from 'yjs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SharedPlaced } from '@cld/modules';
import { api, type LayoutSharedModule } from '../api';
import { HelpButton } from '../help/HelpButton';
import { useEditorStore } from './editorStore';
import { useEscape } from './useEscape';
import { makeItMine, newerVersion, putBackLabel, sharedNote } from './sharedModules';
import { marksNote } from './sharedMarks';
import { sharedModulesKey } from './SharedModulesHost';

/** "🔗 Shared by Alice · v7 · v8 is ready", with help. */
export function SharedNote({ placed, row }: { placed: SharedPlaced; row: LayoutSharedModule | undefined }) {
  const changed = useEditorStore((s) => s.sharedChangedOutside.includes(placed.placedId));
  const overlaps = useEditorStore((s) => marksNote(s.sharedModuleMarks[placed.placedId]));
  const extra = [changed ? 'Changed outside the app' : '', overlaps].filter(Boolean);
  return (
    <span data-testid="module-shared-note" className="ml-2 inline-flex items-center gap-1 text-xs text-muted">
      <span aria-hidden>🔗</span>
      {[sharedNote(placed, row), ...extra].join(' · ')}
      <HelpButton helpKey="module.shared" />
    </span>
  );
}

interface MenuProps {
  layoutId: string;
  placed: SharedPlaced;
  row: LayoutSharedModule | undefined;
  canUpdate: boolean;
  canDetach: boolean;
  /** Close the row's menu. */
  close: () => void;
  onVersions: () => void;
}

const ITEM = 'block w-full px-3 py-1 text-left hover:bg-neutral-700 disabled:cursor-default disabled:opacity-40';

/** The shared module's own menu entries. */
export function SharedModuleMenu({ layoutId, placed, row, canUpdate, canDetach, close, onVersions }: MenuProps) {
  const qc = useQueryClient();
  const newer = newerVersion(placed, row);
  const following = row?.state === 'shared';
  const say = (text: string, kind: 'done' | 'error' = 'done') => useEditorStore.getState().showNotice(text, kind, 7000);
  const refresh = () => void qc.invalidateQueries({ queryKey: sharedModulesKey(layoutId) });
  const name = placed.name || 'This module';
  const changedOutside = useEditorStore((s) => s.sharedChangedOutside.includes(placed.placedId));
  return (
    <>
      <button className={ITEM} data-testid="module-menu-shared-versions" disabled={!following} title={following ? undefined : 'It no longer follows its owner, so there is nothing new to see'} onClick={() => { close(); onVersions(); }}>
        What changed (versions)…
      </button>
      {newer && (
        <button
          className={ITEM}
          data-testid="module-menu-shared-update"
          disabled={!canUpdate}
          title={canUpdate ? undefined : 'Someone who can change this layout can update it'}
          onClick={async () => {
            close();
            try {
              await api.sharedModules.apply(layoutId, placed.placedId, { version: newer });
            } catch (e) {
              say(e instanceof Error ? e.message : String(e), 'error');
            }
            refresh();
          }}
        >
          Update to version {newer}
        </button>
      )}
      {changedOutside && (
        <button
          className={ITEM}
          data-testid="module-menu-shared-putback"
          disabled={!canUpdate || !placed.version}
          title={canUpdate ? undefined : 'Someone who can change this layout can put it back'}
          onClick={async () => {
            close();
            try {
              await api.sharedModules.apply(layoutId, placed.placedId, { ...(placed.version ? { version: placed.version } : {}), again: true });
              const st = useEditorStore.getState();
              st.setSharedChangedOutside(st.sharedChangedOutside.filter((id) => id !== placed.placedId));
              say(`“${name}” is ${placed.by ? `${placed.by}’s` : 'its owner’s'} version again.`);
            } catch (e) {
              say(e instanceof Error ? e.message : String(e), 'error');
            }
            refresh();
          }}
        >
          {putBackLabel(placed.by)}
        </button>
      )}
      <button
        className={ITEM}
        data-testid="module-menu-shared-detach"
        disabled={!canDetach}
        title={canDetach ? undefined : 'Only the layout’s owner can do this (in a club’s layout, its admins and managers)'}
        onClick={async () => {
          close();
          if (await makeItMine(layoutId, placed)) {
            const st = useEditorStore.getState();
            st.setSharedChangedOutside(st.sharedChangedOutside.filter((id) => id !== placed.placedId));
          }
          refresh();
        }}
      >
        Make it mine…
      </button>
      <hr className="my-1 border-border" />
    </>
  );
}

/** The module's versions seen through the layout, each with its note, and "Put this version in". */
export function SharedVersionsDialog({ layoutId, placed, canUpdate, onClose }: { layoutId: string; placed: SharedPlaced; canUpdate: boolean; onClose: () => void; doc?: Y.Doc }) {
  useEscape(onClose);
  const qc = useQueryClient();
  const list = useQuery({ queryKey: [...sharedModulesKey(layoutId), 'versions', placed.placedId], queryFn: () => api.sharedModules.versions(layoutId, placed.placedId) });
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const has = placed.version ?? list.data?.placed ?? 0;
  const put = async (version: number) => {
    setBusy(version);
    setError(null);
    try {
      await api.sharedModules.apply(layoutId, placed.placedId, { version });
      void qc.invalidateQueries({ queryKey: sharedModulesKey(layoutId) });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/60 p-4" onClick={(e) => e.stopPropagation()}>
      <div role="dialog" aria-modal="true" aria-label={`Versions of ${placed.name}`} data-testid="shared-versions" className="w-full max-w-lg space-y-3 rounded-section border border-line bg-panel p-5 text-sm text-ink">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold">Versions of “{placed.name}”</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-control px-2 text-muted hover:bg-soft hover:text-ink">
            ✕
          </button>
        </div>
        <p className="text-muted">
          {placed.by ? `${placed.by} saves the versions. ` : ''}This layout has version {has || '?'}. Putting another one in changes it for everyone in the layout.
        </p>
        {list.isLoading && <p className="text-muted">Loading…</p>}
        {list.isError && <p className="text-danger">{(list.error as Error).message}</p>}
        {error && <p className="text-danger">{error}</p>}
        <ul className="max-h-[50vh] divide-y divide-line/60 overflow-y-auto">
          {(list.data?.versions ?? []).map((v) => (
            <li key={v.version} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="font-medium">Version {v.version}</span>
                {v.version === has && <span className="ml-2 rounded bg-soft px-1.5 py-0.5 text-xs">in this layout</span>}
                <span className="block text-xs text-muted">
                  {new Date(v.createdAt).toLocaleDateString()}
                  {v.author ? ` · ${v.author}` : ''}
                </span>
                <span className="block">{v.note ? `“${v.note}”` : <span className="text-muted">No note</span>}</span>
              </span>
              {canUpdate && v.version !== has && (
                <button type="button" disabled={busy !== null} onClick={() => void put(v.version)} className="min-h-9 shrink-0 rounded-lg border border-border px-3 py-1 hover:bg-soft disabled:opacity-50">
                  {busy === v.version ? 'Working…' : v.version > has ? 'Update to this' : 'Go back to this'}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
