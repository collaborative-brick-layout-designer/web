// The bell in the header, always there while signed in, with the number of
// unread notifications (99+). It opens a panel (a bottom sheet on a phone):
// the newest first, All or Unread, a type filter, grouped items with their
// answers, "Mark all as read", and a link to the Notifications page.
// Everything refetches live in every tab ('notification' hints).

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type NotificationCategory } from '../api';
import { HelpButton } from '../help/HelpButton';
import { NotificationList } from './NotificationList';
import { PushPrompt } from './PushDevices';
import { CATEGORY_LABEL, badgeText, useNotificationCount, useNotificationTypes } from './model';

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const count = useNotificationCount(true);
  const unread = count.data?.unread ?? 0;
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      // A confirm dialog over the panel isn't "outside".
      if (wrap.current && !wrap.current.contains(t) && !t.closest('[role=alertdialog],[role=dialog]')) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role=alertdialog]')) close(true);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  const label = unread > 0 ? `Notifications, ${unread} unread` : 'Notifications';
  return (
    <div ref={wrap} className="relative">
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? 'notification-panel' : undefined}
        data-tour="notifications.bell"
        data-testid="notification-bell"
        onClick={() => setOpen((v) => !v)}
        className="tap-target relative inline-flex h-11 w-11 items-center justify-center rounded-control border border-border text-ink hover:bg-soft sm:h-9 sm:w-9 pointer-coarse:h-11 pointer-coarse:w-11"
      >
        <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && (
          <span data-testid="notification-badge" aria-hidden className="absolute -right-1.5 -top-1.5 min-w-5 rounded-full bg-accent px-1 text-center text-[11px] font-bold leading-5 text-accent-ink">
            {badgeText(unread)}
          </span>
        )}
      </button>
      {open && <Panel onClose={() => close(false)} />}
    </div>
  );
}

function Panel({ onClose }: { onClose: () => void }) {
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [type, setType] = useState('');
  const types = useNotificationTypes();
  const titleId = useId();
  // Opening it puts the focus in it, so the keyboard and screen readers start there.
  const panel = useRef<HTMLElement>(null);
  useEffect(() => panel.current?.focus(), []);
  const list = useQuery({
    queryKey: ['notifications', 'panel', filter, type],
    queryFn: () => api.notifications.list({ unread: filter === 'unread', ...(type ? typeFilter(type) : {}), limit: 25 }),
  });
  const readAll = useMutation({ mutationFn: () => api.notifications.readAll() });
  const items = list.data?.notifications ?? [];
  const unread = list.data?.unread ?? 0;
  const categories = types.data?.categories ?? [];

  return (
    <>
      {/* Phones: the page dims behind the sheet; a tap on it closes. */}
      <div aria-hidden className="fixed inset-0 z-40 bg-black/40 sm:hidden" onClick={onClose} />
      <section
        ref={panel}
        tabIndex={-1}
        id="notification-panel"
        role="dialog"
        aria-labelledby={titleId}
        data-bottom-sheet="phone"
        data-testid="notification-panel"
        className="z-50 flex flex-col overflow-hidden border-line outline-none bg-panel text-ink shadow-pop max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[85dvh] max-sm:rounded-t-2xl max-sm:border-t max-sm:pb-[env(safe-area-inset-bottom)] sm:absolute sm:right-0 sm:top-full sm:mt-1 sm:max-h-[min(36rem,calc(100dvh-6rem))] sm:w-[26rem] sm:rounded-card sm:border"
      >
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line sm:hidden" aria-hidden />
        <header className="flex items-center gap-2 border-b border-line px-3 py-2">
          <h2 id={titleId} className="flex-1 font-display text-base font-semibold">
            Notifications
          </h2>
          <HelpButton helpKey="notifications.bell" />
          <button
            type="button"
            disabled={unread === 0 || readAll.isPending}
            onClick={() => readAll.mutate()}
            className="tap-target rounded-control px-2 py-1 text-xs font-semibold text-accent-text hover:bg-soft disabled:opacity-50"
          >
            Mark all as read
          </button>
          <button type="button" onClick={onClose} aria-label="Close notifications" className="tap-target rounded-control p-1 text-muted hover:bg-soft hover:text-ink">
            <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>
        <PushPrompt />
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <div role="radiogroup" aria-label="Show" className="inline-flex rounded-control border border-border p-0.5 text-xs font-semibold">
            {(['all', 'unread'] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={filter === f}
                onClick={() => setFilter(f)}
                className={`tap-target rounded-[6px] px-2.5 py-1 ${filter === f ? 'bg-accent text-accent-ink' : 'text-muted hover:bg-soft'}`}
              >
                {f === 'all' ? 'All' : `Unread${unread ? ` (${badgeText(unread)})` : ''}`}
              </button>
            ))}
          </div>
          <TypeFilter value={type} onChange={setType} categories={categories} types={types.data?.types ?? []} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {list.isLoading ? (
            <p className="p-4 text-sm text-muted">Loading…</p>
          ) : list.isError ? (
            <p className="p-4 text-sm text-danger">{(list.error as Error).message}</p>
          ) : items.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted" data-testid="notification-empty">
              {filter === 'unread' ? 'You’re all caught up.' : 'Nothing yet. Requests, invites and news from your clubs show up here.'}
            </p>
          ) : (
            <NotificationList items={items} compact onOpen={onClose} />
          )}
        </div>
        <footer className="border-t border-line px-3 py-2 text-center">
          <Link to="/notifications" onClick={onClose} className="text-sm font-semibold text-accent-text hover:underline">
            See all notifications
          </Link>
        </footer>
      </section>
    </>
  );
}

/** `type` holds a type ('club.join_request') or a whole category ('cat:clubs'). */
export function typeFilter(v: string): { type?: string; category?: NotificationCategory } {
  return v.startsWith('cat:') ? { category: v.slice(4) as NotificationCategory } : { type: v };
}

export function TypeFilter({
  value,
  onChange,
  categories,
  types,
}: {
  value: string;
  onChange: (v: string) => void;
  categories: NotificationCategory[];
  types: { type: string; category: NotificationCategory; label: string }[];
}) {
  return (
    <label className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted">
      <span className="sr-only sm:not-sr-only">Type</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="min-w-0 flex-1 rounded-control border border-border bg-soft px-2 py-1 text-xs text-ink" aria-label="Type of notification">
        <option value="">Every type</option>
        {categories.map((c) => (
          <optgroup key={c} label={CATEGORY_LABEL[c]}>
            <option value={`cat:${c}`}>All {CATEGORY_LABEL[c].toLowerCase()}</option>
            {types
              .filter((t) => t.category === c)
              .map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
