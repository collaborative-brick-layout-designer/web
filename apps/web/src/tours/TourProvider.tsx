// Runs a guided tour: startTour(id) goes to the page the tour is about
// (the editor, the room designer or the home page), then shows one step
// at a time. Each step outlines a real control and a small card beside it
// says what it's for, with Back / Next / Skip. Esc closes, Tab stays in
// the card, and finishing or skipping remembers the tour in `toursSeen`.
// A step whose control isn't on screen just shows its card in the middle.

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { isPhoneWindow } from '../editor/useViewportSize';
import { usePreferences } from '../theme/PrefsProvider';
import { forClubless, forDevice, getTour, markSeen, stepCount, TOUR_BUTTONS, type Tour } from './tours';
import { LAST_LAYOUT_KEY } from '../layouts/reopenLast';

/** Phones get the shorter tours (same breakpoint as the editor's phone viewer). */
export function isPhoneScreen(): boolean {
  return isPhoneWindow();
}

interface TourApi {
  /** The tour showing now, and its step. */
  active: { tour: Tour; step: number } | null;
  startTour: (id: string) => void;
}

const TourContext = createContext<TourApi>({ active: null, startTour: () => {} });

export function useTours(): TourApi {
  return useContext(TourContext);
}

/** Where a tour happens: the page it needs, and how to get there. */
async function goWhereTourIs(
  tour: Tour,
  path: string,
  navigate: (to: string) => void,
  layouts: () => Promise<{ id: string }[]>,
  createLayout: () => Promise<{ id: string }>,
): Promise<void> {
  if (tour.id === 'rooms') {
    if (!path.startsWith('/venues/')) navigate('/venues/new');
  } else if (tour.id === 'clubs') {
    if (path !== '/') navigate('/');
  } else if (!path.startsWith('/editor/')) {
    // The editor tours need a layout: the last one, else the first, else a new one.
    let id: string | null = null;
    try {
      id = localStorage.getItem(LAST_LAYOUT_KEY);
    } catch {
      /* storage blocked */
    }
    const list = await layouts();
    if (!id || !list.some((l) => l.id === id)) id = list[0]?.id ?? (await createLayout()).id;
    navigate(`/editor/${id}`);
  }
}

export function TourProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<{ tour: Tour; step: number } | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const { prefs, setPrefs } = usePreferences();
  const seenRef = useRef(prefs.toursSeen);
  seenRef.current = prefs.toursSeen;

  // What had the focus when the tour started.
  const focusBefore = useRef<HTMLElement | null>(null);
  const startTour = useCallback(
    (id: string) => {
      const found = getTour(forDevice(id, isPhoneScreen()));
      if (!found) return;
      focusBefore.current = document.activeElement as HTMLElement | null;
      void goWhereTourIs(
        found,
        location.pathname,
        navigate,
        async () => (await api.layouts.list()).layouts,
        async () => {
          const created = await api.layouts.create({ title: 'My first layout' });
          void qc.invalidateQueries({ queryKey: ['layouts'] });
          return created;
        },
      )
        .catch(() => undefined)
        // Someone in no club skips the steps about their clubs' things.
        .then(async () => {
          if (!found.steps.some((s) => s.needsClub)) return found;
          const orgs = await qc.fetchQuery({ queryKey: ['orgs'], queryFn: api.orgs.list, staleTime: 30_000 }).catch(() => null);
          return forClubless(found, (orgs?.orgs?.length ?? 1) > 0);
        })
        .then((tour) => setActive({ tour, step: 0 }));
    },
    [location.pathname, navigate, qc],
  );

  // Focus goes back where it was when the tour ends.
  const tourOpen = active !== null;
  useEffect(() => {
    if (!tourOpen) return;
    return () => {
      const el = focusBefore.current;
      if (el && document.contains(el)) el.focus?.();
    };
  }, [tourOpen]);

  const tourId = active?.tour.id;
  const finish = useCallback(() => {
    if (tourId) setPrefs({ toursSeen: markSeen(seenRef.current, tourId) });
    setActive(null);
  }, [setPrefs, tourId]);

  const value = useMemo(() => ({ active, startTour }), [active, startTour]);
  return (
    <TourContext.Provider value={value}>
      {children}
      {active && (
        <TourStepCard
          key={`${active.tour.id}:${active.step}`}
          tour={active.tour}
          step={active.step}
          onStep={(step) => setActive({ tour: active.tour, step })}
          onClose={finish}
        />
      )}
    </TourContext.Provider>
  );
}

const PAD = 6;
const EDGE = 8;
const GAP = 12;

/** The element a step points at: `[data-tour~=id]`, else the control a "?" for that help key explains. */
export function findTourTarget(id: string): HTMLElement | null {
  const visible = (el: Element | null): el is HTMLElement => {
    if (!(el instanceof HTMLElement)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  for (const el of document.querySelectorAll(`[data-tour~="${CSS.escape(id)}"]`)) if (visible(el)) return el;
  for (const b of document.querySelectorAll<HTMLElement>(`[data-help-key="${CSS.escape(id)}"]`)) {
    const sel = b.dataset.helpTarget;
    const t = sel ? (b.closest(sel) ?? document.querySelector(sel)) : (b.previousElementSibling ?? b.parentElement);
    if (visible(t)) return t;
  }
  return null;
}

/** Where the card goes: beside the outlined control, kept on screen; centred when there's none. */
function placeCard(target: DOMRect | null, card: { width: number; height: number }, phone: boolean): CSSProperties {
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  if (!target) return { left: Math.max(EDGE, (vw - card.width) / 2), top: Math.max(EDGE, (vh - card.height) / 2) };
  if (phone) {
    // A phone: across the bottom, or the top when the control is down there.
    const top = target.top + target.height / 2 > vh / 2 ? EDGE : vh - card.height - EDGE;
    return { left: EDGE, right: EDGE, top };
  }
  const clampX = (x: number) => Math.max(EDGE, Math.min(x, vw - card.width - EDGE));
  const clampY = (y: number) => Math.max(EDGE, Math.min(y, vh - card.height - EDGE));
  if (target.bottom + GAP + card.height <= vh - EDGE) return { left: clampX(target.left), top: target.bottom + GAP };
  if (target.top - GAP - card.height >= EDGE) return { left: clampX(target.left), top: target.top - GAP - card.height };
  if (target.right + GAP + card.width <= vw - EDGE) return { left: target.right + GAP, top: clampY(target.top) };
  if (target.left - GAP - card.width >= EDGE) return { left: target.left - GAP - card.width, top: clampY(target.top) };
  return { left: clampX(target.left), top: clampY(target.bottom - card.height) };
}

function TourStepCard({
  tour,
  step,
  onStep,
  onClose,
}: {
  tour: Tour;
  step: number;
  onStep: (step: number) => void;
  onClose: () => void;
}) {
  const s = tour.steps[step]!;
  const last = step === tour.steps.length - 1;
  const cardRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const phone = isPhoneScreen();

  // Find the control (it may still be loading after a page change), and follow it.
  useEffect(() => {
    let el: HTMLElement | null = null;
    let tries = 0;
    let timer = 0;
    // Pages still settle after a step starts (panels load, lists fill in): keep following the control.
    const measure = () => {
      const r = el ? el.getBoundingClientRect() : null;
      setRect((cur) =>
        cur && r && cur.left === r.left && cur.top === r.top && cur.width === r.width && cur.height === r.height ? cur : r,
      );
    };
    const follow = window.setInterval(() => el && measure(), 250);
    const look = () => {
      el = findTourTarget(s.target);
      if (el) {
        el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        measure();
      } else if (++tries < 20) timer = window.setTimeout(look, 100);
      else measure();
    };
    look();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(follow);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [s.target]);

  useLayoutEffect(() => {
    const card = cardRef.current?.getBoundingClientRect();
    if (card) setStyle(placeCard(rect, card, phone));
  }, [rect, phone]);

  // Each step's card takes the focus, once it's placed (a hidden card can't).
  const focused = useRef(false);
  const placed = style.visibility !== 'hidden';
  useEffect(() => {
    if (!placed || focused.current) return;
    focused.current = true;
    cardRef.current?.querySelector<HTMLElement>('[data-tour-primary]')?.focus();
  }, [placed]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The page underneath never sees the tour's keys (tool letters, Delete…).
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    // Tab and Shift+Tab go round the card's buttons.
    const items = Array.from(cardRef.current?.querySelectorAll<HTMLElement>('button') ?? []);
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === items.length - 1 ? 0 : at + 1;
    e.preventDefault();
    items[next]!.focus();
  };

  const titleId = `tour-${tour.id}-${step}-title`;
  const hole: CSSProperties | null = rect
    ? { left: rect.left - PAD, top: rect.top - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }
    : null;
  const btn = 'h-9 rounded-lg px-3 text-[13px] font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tour-ink pointer-coarse:h-11';

  return createPortal(
    <div data-testid="tour" data-tour-id={tour.id} data-tour-step={step} className="fixed inset-0 z-[300]" onKeyDown={onKeyDown}>
      {/* The page stays visible but can't be clicked while the tour is open. */}
      {hole ? (
        <div
          data-testid="tour-highlight"
          aria-hidden
          className="pointer-events-auto fixed rounded-[10px] ring-4 ring-accent transition-all"
          style={{ ...hole, boxShadow: '0 0 0 9999px rgba(20, 22, 25, 0.5)' }}
        />
      ) : (
        <div aria-hidden className="fixed inset-0 bg-[rgba(20,22,25,0.5)]" />
      )}
      <div className="fixed inset-0" aria-hidden onPointerDown={(e) => e.preventDefault()} />
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${titleId}-text`}
        style={{ position: 'fixed', ...style }}
        className="flex w-[min(340px,calc(100vw-16px))] flex-col gap-2 rounded-card bg-tour-bg p-4 text-tour-ink shadow-pop max-sm:w-auto"
      >
        <div className="text-xs font-semibold text-tour-muted">
          {tour.title} · {stepCount(step + 1, tour.steps.length)}
        </div>
        <h2 id={titleId} className="font-display text-lg font-bold leading-tight">
          {s.title}
        </h2>
        <p id={`${titleId}-text`} className="text-sm leading-[1.45] opacity-90">
          {s.text}
        </p>
        <div className="mt-1 flex items-center gap-2">
          {!last && (
            <button type="button" onClick={onClose} className={`${btn} text-tour-muted hover:text-tour-ink`}>
              {TOUR_BUTTONS.skip}
            </button>
          )}
          <span className="flex-1" />
          {step > 0 && (
            <button type="button" onClick={() => onStep(step - 1)} className={`${btn} text-tour-ink hover:opacity-80`}>
              {TOUR_BUTTONS.back}
            </button>
          )}
          <button
            type="button"
            data-tour-primary
            onClick={() => (last ? onClose() : onStep(step + 1))}
            className={`${btn} bg-tour-ink px-4 text-tour-bg hover:opacity-90`}
          >
            {last ? TOUR_BUTTONS.done : TOUR_BUTTONS.next}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
