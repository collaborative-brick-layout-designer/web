// The editor's top bar pieces, per the redesign mockup: the layout-name
// menu, the Saved pill, the task tabs, Help and Settings. EditorPage
// wires them to the existing panels, dialogs and menus; nothing here
// owns layout state.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { SaveStatus } from './useLayoutDoc';
import { altKey, modKey } from './mapMenu';
import { usePreferences } from '../theme/PrefsProvider';
import { GETTING_STARTED } from '../help/guide';
import { ShortcutList } from '../help/HelpPage';
import { isPhoneScreen, useTours } from '../tours/TourProvider';
import { toursFor } from '../tours/tours';

export type EditorTask = 'build' | 'room' | 'notes' | 'parts';

export const TASKS: { id: EditorTask; label: string; hint: string }[] = [
  { id: 'build', label: 'Build', hint: 'Parts and sheets: lay out the track and buildings' },
  { id: 'room', label: 'Venue', hint: 'The venue the layout goes in' },
  { id: 'notes', label: 'Notes', hint: 'Author, club, event and notes for this layout' },
  { id: 'parts', label: 'Parts list', hint: 'Every part this layout uses' },
];

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

const Chevron = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
    <path d="M6 9l6 6 6-6" />
  </svg>
);

const MENU = 'absolute z-40 mt-1 min-w-56 overflow-hidden rounded-card border border-line bg-panel py-1 text-sm text-ink shadow-pop';
const MENU_ITEM = 'block w-full px-3.5 py-2 text-left hover:bg-soft';

/** The layout's name, opening a menu of the whole-layout actions. */
export function LayoutNameMenu({
  title,
  credit,
  onNew,
  onOpen,
  onRename,
  children,
}: {
  title: string;
  /** "by Sam · in ArkLUG · based on …", shown at the top of the menu. */
  credit?: string | null | undefined;
  onNew?: (() => void) | undefined;
  onOpen?: (() => void) | undefined;
  /** "Rename…", for people who may change it. */
  onRename?: (() => void) | undefined;
  /** Extra items (e.g. the existing Save). */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        data-tour="layout.menu"
        onClick={() => setOpen((v) => !v)}
        className="flex min-w-0 max-w-full items-center gap-1.5 rounded-lg px-2 py-1.5 pointer-coarse:min-h-11 font-display text-[17px] font-bold text-ink hover:bg-soft"
      >
        <h1 className="min-w-0 truncate text-[17px]">{title}</h1>
        <Chevron />
      </button>
      {open && (
        <div role="menu" className={MENU} onClick={() => setOpen(false)}>
          {credit && (
            <p data-testid="credit" className="max-w-72 break-words px-3.5 pb-1 pt-1.5 text-xs text-muted">
              {credit}
            </p>
          )}
          <Link role="menuitem" to="/" className={MENU_ITEM}>
            Home
          </Link>
          {onNew && (
            <button role="menuitem" type="button" title={`New layout (${altKey()}+N)`} onClick={onNew} className={MENU_ITEM}>
              New layout
            </button>
          )}
          {onOpen && (
            <button role="menuitem" type="button" title={`Open another layout (${modKey()}+O)`} onClick={onOpen} className={MENU_ITEM}>
              Open another layout
            </button>
          )}
          {onRename && (
            <button role="menuitem" type="button" onClick={onRename} className={MENU_ITEM}>
              Rename…
            </button>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

/** "Saved" when the server has everything; otherwise what's going on, in words. */
export function SavePill({ status }: { status: SaveStatus }) {
  let tone = 'bg-soft text-muted';
  let text: string;
  let title: string | undefined;
  switch (status.kind) {
    case 'connecting':
      text = 'Connecting…';
      break;
    case 'synced':
      tone = 'bg-ok-soft text-ok';
      text = 'Saved';
      title = 'Every change is saved to the server';
      break;
    case 'reconnecting':
      tone = 'bg-amber-950 text-amber-300';
      text = 'Reconnecting…';
      title = status.lastSyncedAt ? `Last saved ${timeAgo(status.lastSyncedAt)}` : undefined;
      break;
    case 'offline':
      tone = 'bg-amber-950 text-amber-300';
      text = 'Offline';
      title = status.lastSyncedAt ? 'Edits are kept on this computer and will save when you reconnect' : undefined;
      break;
    case 'error':
      tone = 'bg-red-950 text-danger';
      text = status.message;
      break;
    case 'unsaved':
      tone = 'bg-amber-950 text-amber-300';
      text = 'Not saved yet';
      title = 'Press Save to keep your changes';
      break;
    case 'saving':
      text = 'Saving…';
      break;
  }
  return (
    <span
      data-testid="save-status"
      data-tour="topbar.saveStatus"
      title={title}
      className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-bold ${tone}`}
    >
      {status.kind === 'synced' && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden>
          <path d="M5 12l5 5 9-10" />
        </svg>
      )}
      {text}
    </span>
  );
}

function timeAgo(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  return `${Math.round(secs / 60)}m ago`;
}

export function TaskTabs({ task, onTask }: { task: EditorTask; onTask: (t: EditorTask) => void }) {
  return (
    <div role="group" aria-label="Tasks" className="flex items-center gap-0.5 rounded-control bg-soft p-[3px]">
      {TASKS.map((t) => {
        const on = task === t.id;
        return (
          <button
            key={t.id}
            type="button"
            aria-pressed={on}
            title={t.hint}
            onClick={() => onTask(t.id)}
            className={`h-[34px] whitespace-nowrap rounded-lg px-3.5 text-[13px] ${on ? 'bg-panel font-bold text-ink shadow-sm' : 'font-semibold text-muted hover:text-ink'}`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export const ICON_BUTTON =
  'flex h-[38px] w-[38px] pointer-coarse:h-11 pointer-coarse:w-11 shrink-0 items-center justify-center rounded-control border border-border bg-panel text-ink hover:bg-soft';

/**
 * Help: Getting started, Keyboard shortcuts and turning the "?" buttons
 * off or on (redesign "Help" board). Tours join the list in phase (c).
 */
export function HelpMenu() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'menu' | 'start' | 'keys'>('menu');
  // On a phone the menu spans the screen just under the Help button.
  const [phoneTop, setPhoneTop] = useState(0);
  const { prefs, setPrefs } = usePreferences();
  const { startTour } = useTours();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    setView('menu');
  }, []);
  const ref = useDismiss(open, close);
  // Moving between the list and a page keeps keyboard focus inside the popover.
  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLElement>('button, a')?.focus();
  }, [open, view]);
  const item = 'flex w-full items-center gap-2.5 border-b border-line px-3.5 py-3 text-left text-sm font-semibold last:border-b-0 hover:bg-soft';
  const back = (
    <button type="button" onClick={() => setView('menu')} className="mb-2 text-[13px] font-semibold text-muted hover:text-ink">
      ← Help
    </button>
  );
  return (
    <div ref={ref} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label="Help"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tour="help.menu"
        onClick={() => {
          if (open) return close();
          setPhoneTop((buttonRef.current?.getBoundingClientRect().bottom ?? 52) + 4);
          setOpen(true);
        }}
        onKeyDown={(e) => e.key === 'Escape' && close()}
        className={ICON_BUTTON}
      >
        <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full border-[1.8px] border-current text-[11px] font-extrabold" aria-hidden>
          ?
        </span>
      </button>
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Help"
          style={{ '--phone-top': `${phoneTop}px` } as React.CSSProperties}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            close();
            buttonRef.current?.focus();
          }}
          className={`absolute right-0 z-40 mt-1 w-80 overflow-hidden rounded-card border border-line bg-panel text-sm text-ink shadow-pop max-sm:fixed max-sm:inset-x-2 max-sm:top-(--phone-top) max-sm:w-auto ${view === 'menu' ? '' : 'p-4'}`}
        >
          {view === 'menu' && (
            <>
              {toursFor(isPhoneScreen()).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={item}
                  onClick={() => {
                    close();
                    startTour(t.id);
                  }}
                >
                  <span className="flex-1">Tour: {t.title}</span>
                  {prefs.toursSeen.includes(t.id) && <span className="text-xs font-normal text-muted">seen</span>}
                </button>
              ))}
              <button type="button" className={item} onClick={() => setView('start')}>
                Getting started
              </button>
              <button type="button" className={item} onClick={() => setView('keys')}>
                Keyboard shortcuts
              </button>
              <button
                type="button"
                className={item}
                data-testid="help-icons-toggle"
                onClick={() => {
                  setPrefs({ helpIcons: !prefs.helpIcons });
                  close();
                  buttonRef.current?.focus();
                }}
              >
                {prefs.helpIcons ? 'Turn help buttons off' : 'Turn help buttons on'}
              </button>
              <Link to="/help" target="_blank" rel="noopener" className={`${item} font-normal text-muted`}>
                All help topics
              </Link>
              <Link to="/about" target="_blank" rel="noopener" className={`${item} font-normal text-muted`}>
                About this app
              </Link>
            </>
          )}
          {view === 'start' && (
            <>
              {back}
              <div className="mb-2 font-display text-base font-bold">Getting started</div>
              <ul className="list-disc space-y-1.5 pl-5 text-[13px] leading-snug text-muted">
                {GETTING_STARTED.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </>
          )}
          {view === 'keys' && (
            <>
              {back}
              <div className="mb-2 font-display text-base font-bold">Keyboard shortcuts</div>
              <div className="max-h-[60vh] overflow-y-auto">
                <ShortcutList />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function SettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" aria-label="Settings" title="Settings" onClick={onClick} className={ICON_BUTTON}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
      </svg>
    </button>
  );
}

/** The app's logo, linking back to the layouts list. */
export function AppMark() {
  return (
    <Link to="/" title="Home: all your layouts" aria-label="Home" className="flex h-[34px] w-[34px] pointer-coarse:h-11 pointer-coarse:w-11 shrink-0 items-center justify-center">
      <img src="/logo.png" alt="" className="h-full w-full rounded-[9px]" />
    </Link>
  );
}
