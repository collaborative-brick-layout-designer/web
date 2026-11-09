// The module editor, when someone else saved the module since it opened:
// their save is never overwritten without asking. "Load theirs" puts their
// version here (the work here isn't saved); "Save mine as a new version"
// saves this one over it, and theirs stays in the module's history.

import { useState } from 'react';
import type { ModuleChange } from './useModuleDoc';

export function ModuleChangedCard({
  change,
  onLoadTheirs,
  onSaveMine,
  onDismiss,
}: {
  change: ModuleChange | null;
  onLoadTheirs: () => void;
  onSaveMine: () => Promise<unknown>;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!change) return null;
  return (
    <div
      role="alertdialog"
      aria-labelledby="module-changed-title"
      aria-describedby="module-changed-text"
      data-testid="module-changed"
      className="fixed bottom-[calc(1rem+var(--touch-bar-h,0px))] left-1/2 z-50 w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-accent bg-panel p-4 text-sm shadow-xl"
    >
      <h2 id="module-changed-title" className="font-semibold text-ink">
        Someone saved this module
      </h2>
      <p id="module-changed-text" className="mt-1 text-muted">
        {change.refused
          ? 'They saved it while you were working on it, so your save was held back. Nothing is lost: pick which one to keep going with.'
          : 'They saved a newer version while you have changes here that aren’t saved yet.'}
      </p>
      <ul className="mt-2 list-disc pl-5 text-xs text-muted">
        <li><b className="text-ink">Load theirs</b>: their version opens here. Your changes since your last save are dropped.</li>
        <li><b className="text-ink">Save mine as a new version</b>: yours becomes the module. Theirs stays in its Version history (on Home, the module’s ⋯ menu).</li>
      </ul>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onDismiss} className="tap-target rounded-lg px-3 py-1.5 text-muted hover:bg-soft">
          Not now
        </button>
        <button type="button" disabled={busy} onClick={onLoadTheirs} className="tap-target rounded-lg border border-border px-3 py-1.5 font-semibold hover:bg-soft disabled:opacity-50">
          Load theirs
        </button>
        <button
          type="button"
          disabled={busy}
          autoFocus
          onClick={() => {
            setBusy(true);
            setError(null);
            onSaveMine()
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => setBusy(false));
          }}
          className="tap-target rounded-lg bg-accent px-3 py-1.5 font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50"
        >
          Save mine as a new version
        </button>
      </div>
    </div>
  );
}
