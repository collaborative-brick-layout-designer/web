// Map › Updates from shared modules… (docs/shared-modules.md, "Layout
// settings"): whether this layout asks first before a shared module's new
// version goes in, or takes each one automatically as soon as its owner
// saves it. Whoever may edit the layout changes it; it is the server's
// (api.sharedModules.setUpdates), so everyone's dialog and notices follow
// at once (the layout's live hint).

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type SharedModuleUpdates } from '../api';
import { HelpButton } from '../help/HelpButton';
import { useEditorStore } from './editorStore';
import { useEscape } from './useEscape';
import { sharedModulesKey } from './SharedModulesHost';

interface Props {
  layoutId: string;
  /** Can't change the layout: the choice is shown, not offered. */
  readOnly: boolean;
  onClose: () => void;
}

const CHOICES: { value: SharedModuleUpdates; label: string; text: string }[] = [
  { value: 'ask', label: 'Ask first', text: 'The layout says when a shared module has a new version. Nothing changes until someone chooses Update.' },
  {
    value: 'auto',
    label: 'Automatically',
    text: 'A new version goes in as soon as its owner saves it. You’ll see what changed and anything it now overlaps.',
  },
];

export function SharedUpdatesDialog({ layoutId, readOnly, onClose }: Props) {
  useEscape(onClose);
  const qc = useQueryClient();
  const meta = useQuery({ queryKey: ['layout', layoutId], queryFn: () => api.layouts.get(layoutId) });
  // While the server is asked, the choice already shows (back to what it was if it says no).
  const [pending, setPending] = useState<SharedModuleUpdates | null>(null);
  const current: SharedModuleUpdates = pending ?? meta.data?.layout.sharedModuleUpdates ?? 'ask';
  const [busy, setBusy] = useState(false);

  async function choose(value: SharedModuleUpdates) {
    if (readOnly || busy || value === current) return;
    setBusy(true);
    setPending(value);
    try {
      await api.sharedModules.setUpdates(layoutId, value);
      useEditorStore
        .getState()
        .showNotice(value === 'auto' ? 'New versions of shared modules now go in automatically.' : 'Shared modules now ask first before a new version goes in.', 'done', 5000);
    } catch (e) {
      useEditorStore.getState().showNotice(e instanceof Error ? e.message : String(e), 'error', 8000);
    } finally {
      await qc.invalidateQueries({ queryKey: ['layout', layoutId] });
      void qc.invalidateQueries({ queryKey: sharedModulesKey(layoutId) });
      setPending(null);
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-label="Updates from shared modules" aria-modal="true" className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/60 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-lg border border-line bg-panel p-5 shadow-xl">
        <div className="flex items-start gap-1">
          <h2 className="text-base font-semibold">Updates from shared modules</h2>
          <HelpButton helpKey="module.sharedUpdatesSetting" />
        </div>
        <p className="mt-1 text-sm text-muted">When someone who shared a module with this layout saves a new version:</p>
        <fieldset className="mt-3 flex flex-col gap-2" disabled={readOnly || busy || meta.isLoading} aria-label="Updates from shared modules">
          {CHOICES.map((c) => (
            <label key={c.value} className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm ${current === c.value ? 'border-accent bg-soft' : 'border-border'}`}>
              <input
                type="radio"
                name="shared-module-updates"
                value={c.value}
                checked={current === c.value}
                onChange={() => void choose(c.value)}
                className="mt-1"
              />
              <span>
                <span className="block font-semibold">{c.label}</span>
                <span className="block text-xs text-muted">{c.text}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {readOnly && <p className="mt-2 text-xs text-muted">Someone who can change this layout can change this.</p>}
        <div className="mt-5 flex justify-end">
          <button type="button" onClick={onClose} className="rounded-lg border border-border px-3 py-1 text-sm hover:bg-soft">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
