import { useCallback, useRef, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import { presenceTextColor } from './presenceColors';
import { onePerPerson, useRemotePeers } from './useAwareness';
import { HelpButton } from '../help/HelpButton';
import { HELP_TEXTS } from '../help/helpTexts';
import { TapPopover } from '../ui/TapPopover';

/**
 * Shows everyone connected to the layout. Renders nothing if alone.
 *
 * The circles are one button: a tap (or a click) lists everyone by name,
 * since a finger has no hover to read the initials' names with.
 * `compact` (a phone's header): one circle, with "+3" on its corner for
 * the rest, and no separate "?" (the list says what the circles mean). It
 * is always one button wide, so however many people come, the circles
 * never run over the "Saved" pill or the layout's name.
 */
export function PresencePanel({ awareness, compact = false }: { awareness: Awareness | null; compact?: boolean }) {
  // One avatar per person, however many tabs they have open.
  const peers = onePerPerson(useRemotePeers(awareness));
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  if (peers.length === 0) return null;
  const circles = compact ? peers.slice(0, 1) : peers;
  const more = peers.length - circles.length;
  const circle = 'flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border-2 border-panel text-xs font-bold';
  return (
    <div className="flex shrink-0 items-center gap-2">
      <button
        ref={buttonRef}
        type="button"
        data-testid="people-here"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Who is here"
        onClick={() => setOpen((o) => !o)}
        className="relative flex shrink-0 items-center justify-center rounded-full px-1 hover:bg-soft"
      >
        <span className="flex items-center" aria-label="People here now" role="group">
          {circles.map(({ clientId, state, isIdle }, i) => (
            <span
              key={clientId}
              title={`${state.user.displayName}${isIdle ? ' · idle' : ''}`}
              className={`${circle} ${i > 0 ? '-ml-2' : ''}`}
              style={{ backgroundColor: state.user.color, color: presenceTextColor(state.user.color), opacity: isIdle ? 0.45 : 1 }}
            >
              <span aria-hidden>{initials(state.user.displayName)}</span>
              <span className="sr-only">{state.user.displayName}</span>
            </span>
          ))}
        </span>
        {more > 0 && (
          <span
            data-testid="people-more"
            className="absolute -right-0.5 bottom-0 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-panel bg-ink px-1 text-[11px] font-bold leading-none text-panel"
          >
            <span aria-hidden>+{more}</span>
            <span className="sr-only">{`and ${more} more`}</span>
          </span>
        )}
      </button>
      {!compact && <HelpButton helpKey="people.here" />}
      {open && (
        <TapPopover anchor={buttonRef} onClose={close} label="Who is here" testId="people-list">
          <p className="font-semibold">{peers.length === 1 ? '1 other person is here' : `${peers.length} other people are here`}</p>
          <ul className="mt-2 flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
            {peers.map(({ clientId, state, isIdle }) => (
              <li key={clientId} className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={circle}
                  style={{ backgroundColor: state.user.color, color: presenceTextColor(state.user.color), opacity: isIdle ? 0.45 : 1 }}
                >
                  {initials(state.user.displayName)}
                </span>
                <span className="min-w-0 flex-1 break-words">{state.user.displayName}</span>
                {isIdle && <span className="shrink-0 text-xs text-muted">stepped away</span>}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">{HELP_TEXTS['people.here'].more}</p>
        </TapPopover>
      )}
    </div>
  );
}

function initials(name: string): string {
  const parts = String(name ?? '').trim().split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : (parts[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}
