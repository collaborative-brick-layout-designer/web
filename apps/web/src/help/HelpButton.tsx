// The small round "?" next to anything that isn't obvious (redesign
// "Help" board). Three states:
//   at rest    a quiet circled ?;
//   hover/focus a one-sentence tooltip (the entry's `short`);
//   click/tap   a popover with the `more` text, "Show me" (pulses the
//               outline of the control it explains) and "Learn more"
//               (when the entry has an in-app help page).
// Esc closes the popover and puts focus back on the button. Nothing
// renders while Settings > Show help buttons is off.
//
// The tooltip and popover are portalled to <body> with fixed positions,
// so toolbars that scroll sideways and panels that clip don't cut them
// off, and they're kept inside the screen on a phone.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { usePreferences } from '../theme/PrefsProvider';
import { HELP_TEXTS, type HelpEntry, type HelpKey } from './helpTexts';
import { WEB_ONLY_HELP_TEXTS, type WebOnlyHelpKey } from './webOnlyHelpTexts';

/** A shared entry, or one only the web has (admin pages). */
function helpEntryFor(key: HelpKey | WebOnlyHelpKey): HelpEntry {
  return key in HELP_TEXTS ? HELP_TEXTS[key as HelpKey] : WEB_ONLY_HELP_TEXTS[key as WebOnlyHelpKey];
}

const PULSE_CLASS = 'help-pulse';
const PULSE_MS = 2700;
const EDGE = 8;
const GAP = 8;

/**
 * Pulse the outline of `el` for a moment, so people can see which
 * control a help text is about. Tours (phase c) will reuse this.
 */
export function pulseElement(el: Element | null): void {
  if (!(el instanceof HTMLElement)) return;
  el.classList.remove(PULSE_CLASS);
  // Restart the animation if it's already running.
  void el.offsetWidth;
  el.classList.add(PULSE_CLASS);
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  window.setTimeout(() => el.classList.remove(PULSE_CLASS), PULSE_MS);
}

/** The control a "?" explains: `target` (a selector) or the element just before it. */
function findTarget(button: HTMLElement, target: string | undefined): Element | null {
  if (target) return button.closest(target) ?? document.querySelector(target);
  return button.previousElementSibling ?? button.parentElement;
}

/** Where a floating box goes: under the button (or above when there's no room), kept on screen. */
function place(anchor: DOMRect, box: { width: number; height: number }): CSSProperties {
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(box.width, vw - EDGE * 2);
  let left = anchor.left + anchor.width / 2 - width / 2;
  left = Math.max(EDGE, Math.min(left, vw - width - EDGE));
  const below = anchor.bottom + GAP;
  const top = below + box.height > vh - EDGE && anchor.top - GAP - box.height >= EDGE ? anchor.top - GAP - box.height : below;
  return { position: 'fixed', left, top };
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

interface Props {
  helpKey: HelpKey | WebOnlyHelpKey;
  /**
   * What "Show me" highlights: a selector, looked up among the button's
   * ancestors first. By default, the element just before the button.
   */
  target?: string;
  className?: string;
  /**
   * Shown in the popover under the entry's text: details the words can't
   * hold, such as this server's own addresses.
   */
  extra?: ReactNode;
}

export function HelpButton({ helpKey, target, className = '', extra }: Props) {
  const { prefs } = usePreferences();
  const entry = helpEntryFor(helpKey);
  const id = useId();
  const tipId = `${id}-tip`;
  const popId = `${id}-pop`;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [tipStyle, setTipStyle] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' });
  const [popStyle, setPopStyle] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' });
  // A tap or click focuses the button too; that shouldn't bring up the tooltip.
  const pointerDown = useRef(false);
  // Focus handed back after Esc shouldn't bring the tooltip straight back.
  const quietFocus = useRef(false);

  const showTip = (hover || focused) && !open;

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setHover(false);
    if (refocus) {
      quietFocus.current = true;
      buttonRef.current?.focus();
    }
  }, []);

  // Position the tooltip and popover against the button, and keep them there.
  useLayoutEffect(() => {
    if (!showTip && !open) return;
    const update = () => {
      const b = buttonRef.current?.getBoundingClientRect();
      if (!b) return;
      if (showTip && tipRef.current) setTipStyle(place(b, tipRef.current.getBoundingClientRect()));
      if (open && popRef.current) setPopStyle(place(b, popRef.current.getBoundingClientRect()));
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [showTip, open]);

  // Open: focus moves into the popover; a click or tap outside closes it.
  useEffect(() => {
    if (!open) return;
    popRef.current?.focus();
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('mousedown', onDown, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, [open, close]);

  if (!prefs.helpIcons) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    // Nothing of its own showing: Esc is the dialog's (closes it) or the map's.
    if (!open && !showTip) return;
    // Keep Esc from also closing the dialog or clearing the selection underneath.
    e.stopPropagation();
    e.preventDefault();
    if (open) close(true);
    else {
      setHover(false);
      setFocused(false);
    }
  };

  const showMe = () => {
    const el = buttonRef.current ? findTarget(buttonRef.current, target) : null;
    close(true);
    pulseElement(el);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Help: ${entry.title}`}
        aria-describedby={showTip ? tipId : undefined}
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-haspopup="dialog"
        data-help-key={helpKey}
        data-help-target={target}
        onPointerEnter={(e) => e.pointerType === 'mouse' && setHover(true)}
        onPointerLeave={(e) => e.pointerType === 'mouse' && setHover(false)}
        onPointerDown={(e) => {
          pointerDown.current = true;
          e.stopPropagation();
        }}
        onMouseDown={stop}
        onFocus={() => {
          if (!pointerDown.current && !quietFocus.current) setFocused(true);
          pointerDown.current = false;
          quietFocus.current = false;
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen((v) => !v);
        }}
        // A 20 px circle; on touch screens the button itself grows to 44 px
        // (negative margins keep the layout as it was).
        className={`group inline-flex size-5 shrink-0 items-center justify-center rounded-full align-middle outline-none pointer-coarse:-m-3 pointer-coarse:size-11 ${className}`}
      >
        <span
          aria-hidden
          className={`flex size-5 items-center justify-center rounded-full border-[1.6px] text-[11px] font-extrabold leading-none transition-colors group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-accent ${
            open || showTip ? 'border-accent-text bg-accent-soft text-accent-text' : 'border-muted bg-panel text-muted group-hover:border-accent-text group-hover:text-accent-text'
          }`}
        >
          ?
        </span>
      </button>
      {showTip &&
        createPortal(
          <div
            ref={tipRef}
            id={tipId}
            role="tooltip"
            style={tipStyle}
            className="pointer-events-none z-[200] w-max max-w-[min(15rem,calc(100vw-16px))] rounded-lg bg-tour-bg px-3 py-2 text-[13px] leading-snug text-tour-ink shadow-pop"
          >
            {entry.short}
          </div>,
          document.body,
        )}
      {open &&
        createPortal(
          <div
            ref={popRef}
            id={popId}
            role="dialog"
            aria-labelledby={`${popId}-title`}
            tabIndex={-1}
            style={popStyle}
            onKeyDown={(e) => {
              onKeyDown(e);
              // Tool letters and Enter belong to the popover while it has focus.
              e.stopPropagation();
            }}
            onClick={stop}
            onMouseDown={stop}
            onPointerDown={stop}
            onBlur={(e) => {
              const next = e.relatedTarget as Node | null;
              if (next && !popRef.current?.contains(next) && next !== buttonRef.current) close(false);
            }}
            data-help-popover={helpKey}
            className="z-[200] flex w-[min(300px,calc(100vw-16px))] flex-col gap-2 rounded-card bg-tour-bg p-4 text-tour-ink shadow-pop outline-none"
          >
            <div id={`${popId}-title`} className="text-[15px] font-bold">
              {entry.title}
            </div>
            <p className="text-sm leading-[1.45] opacity-90">{entry.more}</p>
            {extra && <div className="text-sm leading-[1.45] opacity-90">{extra}</div>}
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={showMe}
                className="h-8 rounded-lg bg-tour-ink px-3 text-[13px] font-bold text-tour-bg hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tour-ink pointer-coarse:h-11"
              >
                Show me
              </button>
              {'learnMoreUrl' in entry && entry.learnMoreUrl && (
                <a
                  href={entry.learnMoreUrl}
                  target="_blank"
                  rel="noopener"
                  className="flex h-8 items-center px-2 text-[13px] font-semibold text-tour-ink underline underline-offset-2 hover:opacity-80 focus-visible:outline-2 focus-visible:outline-tour-ink pointer-coarse:h-11"
                >
                  Learn more
                </a>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
