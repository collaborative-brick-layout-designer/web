// A small "Rename" box: the current name, selected, with Save and Cancel.
import { useEffect, useRef, useState } from 'react';

export const MAX_NAME_LENGTH = 200;

export function RenameDialog({
  heading,
  current,
  onSave,
  onClose,
}: {
  /** "Rename layout" */
  heading: string;
  current: string;
  /** Resolves when saved; a rejection keeps the box open with the error. */
  onSave: (name: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const trimmed = name.trim();
  const save = async () => {
    if (!trimmed || busy) return;
    if (trimmed === current) return onClose();
    setBusy(true);
    setError(null);
    try {
      await onSave(trimmed);
      onClose();
    } catch (e) {
      // The reason when there is one ("There’s already a venue called …").
      setError(e instanceof Error && e.message ? e.message : 'Couldn’t rename it. Check your connection and try again.');
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="w-full max-w-md space-y-4 rounded-section border border-line bg-panel p-5 text-sm text-ink shadow-pop"
      >
        <h3 className="text-lg font-semibold">{heading}</h3>
        <label className="block">
          <span className="mb-1 block text-muted">Name</span>
          <input
            ref={input}
            value={name}
            maxLength={MAX_NAME_LENGTH}
            onChange={(e) => setName(e.target.value)}
            className="min-h-11 w-full rounded-lg border border-border bg-soft px-3 py-2 text-[16px]"
          />
        </label>
        {error && <p className="text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg border border-border px-4">
            Cancel
          </button>
          <button type="submit" disabled={!trimmed || busy} className="min-h-11 rounded-lg bg-accent px-4 font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-40">
            {busy ? 'Saving…' : 'Rename'}
          </button>
        </div>
      </form>
    </div>
  );
}
