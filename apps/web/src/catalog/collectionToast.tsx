// A small note at the bottom of the screen after something went into a
// collection, with a link to open it. One at a time; it goes by itself.

import { useEffect, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';

export interface CollectionToast {
  text: string;
  /** The collection to open. */
  collectionId: string;
}

let current: CollectionToast | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function showCollectionToast(t: CollectionToast): void {
  current = t;
  emit();
}

export function hideCollectionToast(): void {
  current = null;
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const TOAST_MS = 8000;

/** Mounted once (main.tsx). */
export function CollectionToastHost() {
  const t = useSyncExternalStore(subscribe, () => current);
  useEffect(() => {
    if (!t) return;
    const timer = window.setTimeout(hideCollectionToast, TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [t]);
  if (!t) return null;
  return (
    <div className="notice-dock pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex justify-center px-4">
      <div
        role="status"
        data-testid="collection-toast"
        className="pointer-events-auto flex max-w-md flex-wrap items-center gap-3 rounded-section border border-line bg-panel px-4 py-3 text-sm text-ink shadow-lg"
      >
        <span>{t.text}</span>
        <Link
          to={`/catalog/collections/${t.collectionId}`}
          onClick={hideCollectionToast}
          className="tap-target rounded-lg bg-accent px-3 py-1.5 font-semibold text-accent-ink hover:bg-accent-hover"
        >
          Open collection
        </Link>
        <button type="button" aria-label="Close" onClick={hideCollectionToast} className="tap-target rounded px-2 text-muted hover:text-ink">
          ✕
        </button>
      </div>
    </div>
  );
}
