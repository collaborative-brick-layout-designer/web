// The header's one menu ("Menu ▾"): everything that isn't a page link, in
// groups. On a phone the page links come first, so it's the only menu.
//
//   Pages           Home · Clubs · Catalog · About · Notices (phones only)
//   Help            the tours · help buttons on/off · all help topics ·
//                   keyboard shortcuts (not on phones)
//   Account         Profile and name · Sign-in methods · Devices · Sign out
//   Look            Light or dark · Color and text size · Help and tours ·
//                   Install the app (only where installing is offered)
//   Admin settings  one entry per admin tab (moderators: Moderation only)
//
// Reviews waiting for a moderator, and people waiting to join a club, show
// as a badge on the button. Works by mouse, touch and keyboard (arrows,
// Home/End, Escape returns focus to the button). On a phone it opens as a
// bottom sheet over a dimmed page.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, apiGet, type Me } from './api';
import { isMobileDevice } from './pwa/install';
import { usePreferences } from './theme/PrefsProvider';
import { isPhoneScreen, useTours } from './tours/TourProvider';
import { toursFor } from './tours/tours';

export interface Entry {
  label: string;
  /** A page to open; or `onSelect` for an action (start a tour, a toggle). */
  to?: string;
  onSelect?: () => void;
  badge?: number;
  /** Words for the badge, for screen readers. */
  badgeLabel?: string;
  /** A quiet note on the right, like "seen" on a tour already taken. */
  note?: string;
}

interface Group {
  id: string;
  title: string;
  entries: Entry[];
}

/** Privacy requests overdue or due within a week, for site admins (the Admin menu's badge). */
export function usePrivacyDue(user: Pick<Me, 'isGlobalAdmin'>): number {
  const q = useQuery({
    queryKey: ['admin-privacy-summary'],
    queryFn: () => apiGet<{ overdue: number; dueSoon: number }>('/api/admin/privacy/summary'),
    enabled: user.isGlobalAdmin,
    staleTime: 60_000,
    retry: false,
  });
  return (q.data?.overdue ?? 0) + (q.data?.dueSoon ?? 0);
}

/** How many reviews are waiting (catalog items, new pictures and collections), for moderators and admins. */
export function useWaitingReviews(user: Pick<Me, 'isGlobalAdmin' | 'isModerator'>): number {
  const reviews = user.isGlobalAdmin || !!user.isModerator;
  // Only the counts, never the lists. The key starts with 'moderation', so a live change refreshes it.
  const counts = useQuery({ queryKey: ['moderation', 'counts'], queryFn: api.moderation.counts, enabled: reviews, staleTime: 60_000, retry: false });
  if (!reviews || !counts.data) return 0;
  return counts.data.waiting + counts.data.covers + counts.data.collections;
}

/** The menu's groups for this person. */
export function settingsMenuGroups(
  user: Pick<Me, 'isGlobalAdmin' | 'isModerator' | 'isDemoAccount'>,
  opts: { installOffered: boolean },
): Group[] {
  const account: Entry[] = [{ label: 'Profile and name', to: '/profile#name' }];
  // The shared demo account can't change its sign-in or connect a desktop app.
  if (!user.isDemoAccount) {
    account.push(
      { label: 'Sign-in methods', to: '/profile#sign-in' },
      { label: 'Browsers and devices', to: '/profile#devices' },
      { label: 'Your data', to: '/profile#my-data' },
      { label: 'Emails', to: '/settings#email' },
      { label: 'Delete my account', to: '/profile#delete-account' },
    );
  }
  const look: Entry[] = [
    { label: 'Light or dark', to: '/settings#look' },
    { label: 'Color and text size', to: '/settings#color' },
    { label: 'Help and tours', to: '/settings#help' },
  ];
  if (opts.installOffered) look.push({ label: 'Install the app', to: '/settings#install' });
  const groups: Group[] = [
    { id: 'account', title: 'Account', entries: account },
    { id: 'look', title: 'Look', entries: look },
  ];
  return groups;
}

const ITEM =
  'flex w-full min-h-11 items-center gap-2 px-4 py-2 text-left text-[15px] font-semibold text-ink hover:bg-soft focus-visible:bg-soft focus-visible:outline-none sm:min-h-9 sm:text-sm pointer-coarse:min-h-11';

function Badge({ n, label }: { n: number; label: string }) {
  return (
    <span className="rounded-full bg-accent px-1.5 text-xs font-bold text-accent-ink" aria-label={label}>
      {n}
    </span>
  );
}

/** The Help group: the tours, the help buttons switch and the help pages. */
function useHelpEntries(phone: boolean): Entry[] {
  const { prefs, setPrefs } = usePreferences();
  const { startTour } = useTours();
  return [
    ...toursFor(phone).map((t) => ({
      label: `Tour: ${t.title}`,
      onSelect: () => startTour(t.id),
      ...(prefs.toursSeen.includes(t.id) ? { note: 'seen' } : {}),
    })),
    { label: prefs.helpIcons ? 'Turn help buttons off' : 'Turn help buttons on', onSelect: () => setPrefs({ helpIcons: !prefs.helpIcons }) },
    { label: 'All help topics', to: '/help' },
    { label: 'Privacy', to: '/privacy' },
    ...(phone ? [] : [{ label: 'Keyboard shortcuts', to: '/help#shortcuts' }]),
  ];
}

/** True below Tailwind's `sm` breakpoint, kept up to date as the window changes. */
function usePhoneWidth(): boolean {
  const query = '(max-width: 639.98px)';
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

const OPEN_GROUPS_KEY = 'cld:menuOpenGroups';

/** What a folded group would show as waiting (join requests, reviews). */
function groupBadge(g: Group): number {
  return g.entries.reduce((n, e) => n + (e.badge ?? 0), 0);
}

export function SettingsMenu({
  user,
  onSignOut,
  signingOut = false,
  pages = [],
}: {
  user: Me;
  onSignOut: () => void;
  signingOut?: boolean;
  /** The page links, shown in the menu on a phone (they're in the header otherwise). */
  pages?: Entry[];
}) {
  const [open, setOpen] = useState(false);
  // Which groups are open. Pages starts open; the rest start folded so the
  // menu fits without scrolling. Remembered in this browser.
  const [openGroups, setOpenGroups] = useState<string[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(OPEN_GROUPS_KEY) ?? 'null') as unknown;
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v;
    } catch {
      /* private mode or a bad value: use the default */
    }
    return ['pages'];
  });
  const toggleGroup = (id: string) =>
    setOpenGroups((now) => {
      const next = now.includes(id) ? now.filter((g) => g !== id) : [...now, id];
      try {
        localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify(next));
      } catch {
        /* not saved: fine */
      }
      return next;
    });
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const phone = usePhoneWidth();
  // One link to the admin pages (site admins), or to Moderation (moderators),
  // counting what waits there. The pages themselves have their own tabs.
  const reviews = useWaitingReviews(user);
  const privacyDue = usePrivacyDue(user);
  const adminWaiting = reviews + privacyDue;
  const admin = user.isGlobalAdmin
    ? { label: 'Site admin', to: '/admin' }
    : user.isModerator
      ? { label: 'Moderation', to: '/admin?tab=moderation' }
      : null;
  const adminBadgeLabel = [
    reviews > 0 ? `${reviews} ${reviews === 1 ? 'review' : 'reviews'} waiting` : '',
    privacyDue > 0 ? `${privacyDue} privacy ${privacyDue === 1 ? 'request' : 'requests'} due` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const help = useHelpEntries(phone || isPhoneScreen());
  // Installing is offered on phones and tablets (the Settings page's rule).
  const installOffered = useMemo(() => isMobileDevice(), []);
  const groups: Group[] = [
    ...(phone && pages.length > 0 ? [{ id: 'pages', title: 'Pages', entries: pages }] : []),
    { id: 'help', title: 'Help', entries: help },
    ...settingsMenuGroups(user, { installOffered }),
  ];
  // People waiting to join a club only show in the Pages group, so the button counts them on a phone.
  const pageBadges = phone ? pages.reduce((n, p) => n + (p.badge ?? 0), 0) : 0;
  const buttonBadge = pageBadges + adminWaiting;

  const items = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? []);
  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // Opening by keyboard or tap puts focus on the first entry.
  const [focusLast, setFocusLast] = useState(false);
  useEffect(() => {
    if (!open) return;
    const all = items();
    (focusLast ? all[all.length - 1] : all[0])?.focus();
  }, [open, focusLast]);

  function onButtonKey(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    setFocusLast(e.key === 'ArrowUp');
    setOpen(true);
  }

  function onMenuKey(e: React.KeyboardEvent) {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (e.key === 'ArrowDown') next = all[(at + 1) % all.length];
    else if (e.key === 'ArrowUp') next = all[(at - 1 + all.length) % all.length];
    else if (e.key === 'Home') next = all[0];
    else if (e.key === 'End') next = all[all.length - 1];
    else if (e.key === 'Tab') {
      // Tabbing out closes it, like any menu.
      setOpen(false);
      return;
    } else return;
    e.preventDefault();
    next?.focus();
  }

  return (
    <div ref={wrap} className="relative">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? 'settings-menu' : undefined}
        onClick={() => {
          setFocusLast(false);
          setOpen((v) => !v);
        }}
        onKeyDown={onButtonKey}
        className="tap-target inline-flex h-11 items-center gap-1.5 rounded-control border border-border px-3 text-sm font-semibold text-ink hover:bg-soft sm:h-9 pointer-coarse:h-11"
      >
        {user.avatarUrl && <img src={user.avatarUrl} alt="" className="-ml-1 hidden h-6 w-6 rounded-full sm:block" />}
        <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5 sm:hidden" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
        </svg>
        <span className="sr-only sm:not-sr-only">Menu</span>
        {buttonBadge > 0 && <Badge n={buttonBadge} label={`${buttonBadge} waiting`} />}
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className={`hidden transition-transform sm:block ${open ? 'rotate-180' : ''}`}>
          <path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <>
          {/* Phones: the page dims behind the sheet; a tap on it closes. */}
          <div aria-hidden className="fixed inset-0 z-40 bg-black/40 sm:hidden" onClick={() => setOpen(false)} />
          <div
            ref={menu}
            id="settings-menu"
            role="menu"
            aria-label="Menu"
            // A bottom sheet on a phone (max-sm): notices move clear of it (styles.css).
            data-bottom-sheet="phone"
            onKeyDown={onMenuKey}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('[role=menuitem]')) setOpen(false);
            }}
            className="z-50 overflow-y-auto overscroll-contain border-line bg-panel text-ink shadow-pop max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[80dvh] max-sm:rounded-t-2xl max-sm:border-t max-sm:pb-[env(safe-area-inset-bottom)] sm:absolute sm:right-0 sm:top-full sm:mt-1 sm:max-h-[calc(100dvh-6rem)] sm:w-72 sm:rounded-card sm:border sm:py-1"
          >
            <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-line sm:hidden" aria-hidden />
            <p className="truncate px-4 pb-1 pt-2 text-xs text-muted" data-testid="settings-menu-who">
              Signed in as <span className="font-semibold text-ink">{user.displayName || user.publicName || user.email}</span>
            </p>
            {groups.map((g) => (
              <div key={g.id} role="group" aria-labelledby={`settings-menu-${g.id}`} className="border-t border-line py-1">
                <button
                  type="button"
                  id={`settings-menu-${g.id}`}
                  aria-expanded={openGroups.includes(g.id)}
                  aria-controls={`settings-menu-${g.id}-items`}
                  onClick={() => toggleGroup(g.id)}
                  className="flex min-h-11 w-full items-center gap-2 px-4 text-left text-xs font-bold uppercase tracking-wide text-muted hover:bg-soft sm:min-h-9 pointer-coarse:min-h-11"
                >
                  <span className="flex-1">{g.title}</span>
                  {!openGroups.includes(g.id) && groupBadge(g) > 0 && <Badge n={groupBadge(g)} label={`${groupBadge(g)} waiting`} />}
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className={`transition-transform ${openGroups.includes(g.id) ? 'rotate-180' : ''}`}>
                    <path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                {openGroups.includes(g.id) && (
                <div id={`settings-menu-${g.id}-items`}>
                {g.entries.map((e) => {
                  const inner = (
                    <>
                      <span className="flex-1">{e.label}</span>
                      {e.note && <span className="text-xs font-normal text-muted">{e.note}</span>}
                      {e.badge !== undefined && <Badge n={e.badge} label={e.badgeLabel ?? `${e.badge} waiting`} />}
                    </>
                  );
                  return e.to ? (
                    <Link key={e.label} role="menuitem" to={e.to} className={ITEM}>
                      {inner}
                    </Link>
                  ) : (
                    <button key={e.label} type="button" role="menuitem" onClick={e.onSelect} className={ITEM}>
                      {inner}
                    </button>
                  );
                })}
                </div>
                )}
              </div>
            ))}
            {/* Always one tap away, whatever is folded. */}
            <div className="border-t border-line py-1">
              {admin && (
                <Link role="menuitem" to={admin.to} className={ITEM}>
                  <span className="flex-1">{admin.label}</span>
                  {adminWaiting > 0 && <Badge n={adminWaiting} label={adminBadgeLabel} />}
                </Link>
              )}
              <button
                type="button"
                role="menuitem"
                disabled={signingOut}
                onClick={onSignOut}
                className={`${ITEM} text-danger disabled:opacity-50`}
              >
                Sign out
              </button>
            </div>
            {/* A phone sheet gets a plain way out besides tapping the page. */}
            <div className="border-t border-line p-2 sm:hidden">
              <button type="button" onClick={() => close(true)} className="min-h-11 w-full rounded-control text-sm font-bold hover:bg-soft">
                Close
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
