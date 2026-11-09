// One confirmation dialog for the whole app (and the same wording as the
// desktop app's ConfirmDialog). Ask with `confirmDelete(...)`/`askConfirm(...)`
// from anywhere, even outside React: it resolves true for Delete, false for
// Cancel, Esc or a tap outside. Focus starts on Cancel. On a phone it's a
// sheet at the bottom of the screen. For big or permanent deletions the
// person types the name before Delete turns on.
//
// After a deletion, `toastDeleted(name)` shows "Deleted ‹name›" for a few
// seconds (with Undo when the caller can bring it back).

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';

export interface ConfirmOptions {
  /** "Delete “Main yard”?" */
  title: string;
  /** What will be removed, in plain words. */
  removes?: string;
  /** What stays: "Its parts stay in your library." */
  keeps?: string;
  /** Whether it can be undone. */
  undo?: string;
  /** The red button. Default "Delete". */
  confirmLabel?: string;
  /** Red (default) or the accent color for things that aren't removals. */
  danger?: boolean;
  /** The person types this before the button turns on. */
  typeName?: string;
  /** Ask for a short text (a reason) as well. */
  reason?: { label: string; required?: boolean };
  /** The Cancel button's words ("Stay"). */
  cancelLabel?: string;
  /** A third answer, between Cancel and the confirm button (askChoice). */
  other?: { label: string; danger?: boolean };
}

/** What a dialog answers when its `other` button is pressed. */
const OTHER = '\u0001other';

interface Pending {
  opts: ConfirmOptions;
  resolve: (answer: string | null) => void;
  seq: number;
}

let seq = 0;

let pending: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function open(opts: ConfirmOptions): Promise<string | null> {
  // A second question replaces the first one, which counts as cancelled.
  pending?.resolve(null);
  return new Promise((resolve) => {
    pending = { opts, resolve, seq: ++seq };
    emit();
  });
}

function answer(value: string | null): void {
  const p = pending;
  pending = null;
  emit();
  p?.resolve(value);
}

/** Close any open question as cancelled. */
export function closeConfirm(): void {
  if (pending) answer(null);
}

/** Yes/no: true only when the person pressed the confirm button. */
export async function askConfirm(opts: ConfirmOptions): Promise<boolean> {
  return (await open(opts)) !== null;
}

/** Three ways out: the confirm button, the `other` button, or null for Cancel (Esc, a tap outside). */
export async function askChoice(opts: ConfirmOptions & { other: NonNullable<ConfirmOptions['other']> }): Promise<'confirm' | 'other' | null> {
  const a = await open(opts);
  return a === null ? null : a === OTHER ? 'other' : 'confirm';
}

/** With a text box: the text, or null when cancelled. */
export function askReason(opts: ConfirmOptions & { reason: NonNullable<ConfirmOptions['reason']> }): Promise<string | null> {
  return open(opts);
}

export interface DeleteWording {
  /** What will be removed. Default: "“‹name›” is deleted." */
  removes?: string;
  /** What stays. */
  keeps?: string;
  /** Can it be undone? Default false: "This can't be undone." */
  undoable?: boolean | string;
  /** Type the name first (big or permanent deletions). */
  typeName?: boolean;
  /** Button text, default "Delete" (e.g. "Remove", "Revoke"). */
  confirmLabel?: string;
  /** Title verb, default "Delete" (e.g. "Remove", "Revoke"). */
  verb?: string;
  /** A whole title instead of "‹verb› “‹name›”?" (when the thing has no name of its own). */
  title?: string;
}

/** The standard deletion question: "Delete “‹name›”?" with what goes, what stays and whether it comes back. */
export function deleteOptions(name: string, w: DeleteWording = {}): ConfirmOptions {
  const verb = w.verb ?? 'Delete';
  return {
    title: w.title ?? `${verb} “${name}”?`,
    removes: w.removes ?? `“${name}” is deleted.`,
    ...(w.keeps ? { keeps: w.keeps } : {}),
    undo: typeof w.undoable === 'string' ? w.undoable : w.undoable ? 'You can undo this.' : 'This can’t be undone.',
    confirmLabel: w.confirmLabel ?? verb,
    ...(w.typeName ? { typeName: name } : {}),
  };
}

export function confirmDelete(name: string, w: DeleteWording = {}): Promise<boolean> {
  return askConfirm(deleteOptions(name, w));
}

/**
 * Leaving a layout while changes haven't reached the server. Going
 * elsewhere in the app keeps sending them (useLayoutDoc finishSending);
 * nothing is kept once the tab closes, and the words say so.
 */
export function askLeaveUnsaved(): Promise<boolean> {
  return askConfirm({
    title: 'Leave before your changes reach the server?',
    removes: 'Some changes haven’t reached the server yet.',
    keeps: 'They keep sending while this tab stays open, and arrive when the connection is back. If you close the tab before then, they’re lost.',
    confirmLabel: 'Leave anyway',
    cancelLabel: 'Stay',
  });
}

/** Leaving the module editor with changes not saved: save them, drop them, or stay. */
export function askLeaveUnsavedModule(): Promise<'confirm' | 'other' | null> {
  return askChoice({
    title: 'Save your module before you leave?',
    removes: 'Your changes to this module aren’t saved yet. If you leave without saving, they’re lost.',
    confirmLabel: 'Save and leave',
    danger: false,
    other: { label: 'Leave without saving', danger: true },
    cancelLabel: 'Stay',
  });
}

/** The name matches when it's the same ignoring case and the spaces around it. */
export function typedMatches(typed: string, name: string): boolean {
  return typed.trim().toLowerCase() === name.trim().toLowerCase();
}

/** Mounted once (main.tsx). */
export function ConfirmDialogHost() {
  const p = useSyncExternalStore(subscribe, () => pending);
  if (!p) return null;
  // The key resets the typed text for every new question.
  return <ConfirmDialog key={p.seq} opts={p.opts} onAnswer={answer} />;
}

export function ConfirmDialog({ opts, onAnswer }: { opts: ConfirmOptions; onAnswer: (value: string | null) => void }) {
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const cancel = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const danger = opts.danger ?? true;
  const ok =
    (!opts.typeName || typedMatches(typed, opts.typeName)) && (!opts.reason?.required || reason.trim().length > 0);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => before?.focus?.();
  }, []);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onAnswer(null);
      return;
    }
    if (e.key !== 'Tab') return;
    // Keep Tab inside the dialog.
    const items = Array.from(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea') ?? []);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const confirm = () => {
    if (ok) onAnswer(reason.trim());
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onAnswer(null);
      }}
    >
      <div
        ref={box}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-testid="confirm-dialog"
        onKeyDown={onKey}
        className="max-h-[90vh] w-full overflow-y-auto rounded-t-section border border-line bg-panel p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-sm text-ink shadow-pop sm:max-w-md sm:rounded-section sm:pb-5"
      >
        <h2 id={titleId} className="text-lg font-semibold break-words">
          {opts.title}
        </h2>
        <div id={bodyId} className="mt-2 space-y-1.5 text-muted">
          {opts.removes && <p>{opts.removes}</p>}
          {opts.keeps && <p>{opts.keeps}</p>}
          {opts.undo && <p className="font-medium text-ink">{opts.undo}</p>}
        </div>
        {opts.reason && (
          <label className="mt-4 block">
            <span className="mb-1 block text-muted">{opts.reason.label}</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="w-full rounded-lg border border-border bg-soft px-3 py-2"
            />
          </label>
        )}
        {opts.typeName && (
          <label className="mt-4 block">
            <span className="mb-1 block text-muted">
              Type <strong className="text-ink">{opts.typeName}</strong> to confirm
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirm();
              }}
              autoComplete="off"
              spellCheck={false}
              aria-label={`Type ${opts.typeName} to confirm`}
              className="w-full rounded-lg border border-border bg-soft px-3 py-2"
            />
          </label>
        )}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            ref={cancel}
            type="button"
            onClick={() => onAnswer(null)}
            className="tap-target min-h-11 rounded-lg border border-border px-4 py-2 hover:bg-soft pointer-fine:min-h-9"
          >
            {opts.cancelLabel ?? 'Cancel'}
          </button>
          {opts.other && (
            <button
              type="button"
              onClick={() => onAnswer(OTHER)}
              className={`tap-target min-h-11 rounded-lg border px-4 py-2 font-semibold pointer-fine:min-h-9 ${
                opts.other.danger ? 'border-danger text-danger hover:bg-soft' : 'border-border hover:bg-soft'
              }`}
            >
              {opts.other.label}
            </button>
          )}
          <button
            type="button"
            disabled={!ok}
            onClick={confirm}
            className={`tap-target min-h-11 rounded-lg px-4 py-2 font-semibold disabled:opacity-50 pointer-fine:min-h-9 ${
              danger ? 'bg-danger text-panel hover:opacity-90' : 'bg-accent text-accent-ink hover:bg-accent-hover'
            }`}
          >
            {opts.confirmLabel ?? 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- "Deleted ‹name›" ------------------------------------------------------

interface Toast {
  text: string;
  undo?: () => void;
  id: number;
}

let toast: Toast | null = null;
let toastSeq = 0;
const toastListeners = new Set<() => void>();
const toastEmit = () => toastListeners.forEach((l) => l());
const toastSubscribe = (l: () => void) => {
  toastListeners.add(l);
  return () => toastListeners.delete(l);
};

export const DELETED_TOAST_MS = 6000;

export function showToast(text: string, undo?: () => void): void {
  toast = { text, id: ++toastSeq, ...(undo ? { undo } : {}) };
  toastEmit();
}

export function toastDeleted(name: string, undo?: () => void): void {
  showToast(`Deleted “${name}”`, undo);
}

export function hideToast(): void {
  toast = null;
  toastEmit();
}

/** Mounted once (main.tsx). */
export function ToastHost() {
  const t = useSyncExternalStore(toastSubscribe, () => toast);
  useEffect(() => {
    if (!t) return;
    const timer = window.setTimeout(hideToast, DELETED_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [t]);
  if (!t) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex justify-center px-4">
      <div
        role="status"
        data-testid="toast"
        className="pointer-events-auto flex max-w-md flex-wrap items-center gap-3 rounded-section border border-line bg-panel px-4 py-3 text-sm text-ink shadow-lg"
      >
        <span>{t.text}</span>
        {t.undo && (
          <button
            type="button"
            onClick={() => {
              t.undo?.();
              hideToast();
            }}
            className="tap-target rounded-lg bg-accent px-3 py-1.5 font-semibold text-accent-ink hover:bg-accent-hover"
          >
            Undo
          </button>
        )}
        <button type="button" aria-label="Close" onClick={hideToast} className="tap-target rounded px-2 text-muted hover:text-ink">
          ✕
        </button>
      </div>
    </div>
  );
}
