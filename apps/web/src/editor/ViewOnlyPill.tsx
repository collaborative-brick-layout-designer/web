import { useCallback, useRef, useState } from 'react';
import { TapPopover } from '../ui/TapPopover';

/**
 * "View only", shown to anyone who can look but not change. When the
 * club's roles are the reason it says why: on hover, read out, and on a
 * tap (a finger has no hover).
 */
export function ViewOnlyPill({ reason }: { reason?: string | undefined }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const look = 'shrink-0 whitespace-nowrap rounded-full bg-amber-900/40 px-2.5 py-1 text-xs font-bold text-amber-300';
  if (!reason)
    return (
      <span data-testid="view-only" data-tour="view.edit" className={look}>
        View only
      </span>
    );
  return (
    <>
      <button
        ref={ref}
        type="button"
        data-testid="view-only"
        data-tour="view.edit"
        title={reason}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        // (The button is finger-sized; the pill inside keeps its look.)
        className="flex shrink-0 items-center"
      >
        <span className={`${look} inline-flex items-center gap-1`}>
          View only
          <span aria-hidden className="flex size-4 items-center justify-center rounded-full border border-current text-[10px] leading-none">?</span>
        </span>
        <span className="sr-only">. {reason}</span>
      </button>
      {open && (
        <TapPopover anchor={ref} onClose={close} label="Why this is view only" testId="view-only-why">
          <p className="font-semibold">You can look, but not change this.</p>
          <p className="mt-1 text-muted">{reason}</p>
        </TapPopover>
      )}
    </>
  );
}
