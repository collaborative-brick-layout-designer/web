// /notifications: every notification, with All / Unread, a type filter,
// search, more pages on demand, and marking many as read at once.
// /notices (the old page) comes here.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { SignInFirst } from '../auth/signIn';
import { HelpButton } from '../help/HelpButton';
import { NotificationList } from './NotificationList';
import { TypeFilter, typeFilter } from './NotificationBell';
import { badgeText, useNotificationTypes } from './model';

const PAGE = 30;

export function NotificationsPage() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const signedIn = !!me.data?.user;
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const types = useNotificationTypes(signedIn);

  // Search as you type, a moment after the last key.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const list = useInfiniteQuery({
    queryKey: ['notifications', 'page', filter, type, q],
    enabled: signedIn,
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      api.notifications.list({ unread: filter === 'unread', ...(type ? typeFilter(type) : {}), ...(q ? { q } : {}), ...(pageParam ? { cursor: pageParam } : {}), limit: PAGE }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const readSome = useMutation({
    mutationFn: (ids: string[] | undefined) => api.notifications.readAll(ids),
    onSuccess: () => setSelected(new Set()),
  });

  if (me.isLoading) return <p className="p-8 text-muted">Loading…</p>;
  if (!signedIn) return <SignInFirst />;
  const items = list.data?.pages.flatMap((p) => p.notifications) ?? [];
  const first = list.data?.pages[0];
  const unread = first?.unread ?? 0;
  const pick = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-4 text-ink sm:p-8">
      <Link to="/" className="text-sm text-accent-text hover:underline">
        ← Home
      </Link>
      <div className="flex items-center gap-2">
        <h1 className="font-display text-xl font-semibold">Notifications</h1>
        <HelpButton helpKey="notifications.bell" />
      </div>
      <p className="text-sm text-muted">
        Requests and invites waiting for you, news from your clubs and the people you share with, and warnings from the site team or a club. You can answer requests right here.
      </p>
      <div className="flex flex-wrap items-center gap-2 rounded-card border border-line bg-panel p-3">
        <div role="radiogroup" aria-label="Show" className="inline-flex rounded-control border border-border p-0.5 text-sm font-semibold">
          {(['all', 'unread'] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={filter === f}
              onClick={() => setFilter(f)}
              className={`tap-target rounded-[6px] px-3 py-1 ${filter === f ? 'bg-accent text-accent-ink' : 'text-muted hover:bg-soft'}`}
            >
              {f === 'all' ? 'All' : `Unread${unread ? ` (${badgeText(unread)})` : ''}`}
            </button>
          ))}
        </div>
        <TypeFilter value={type} onChange={setType} categories={types.data?.categories ?? []} types={types.data?.types ?? []} />
        <label className="flex min-w-[12rem] flex-1 items-center">
          <span className="sr-only">Search notifications</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            className="w-full rounded-control border border-border bg-soft px-2 py-1 text-sm"
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button
          type="button"
          disabled={selected.size === 0 || readSome.isPending}
          onClick={() => readSome.mutate([...selected])}
          className="tap-target rounded-control border border-border px-3 py-1 font-semibold hover:bg-soft disabled:opacity-50"
        >
          Mark selected as read{selected.size ? ` (${selected.size})` : ''}
        </button>
        <button
          type="button"
          disabled={unread === 0 || readSome.isPending}
          onClick={() => readSome.mutate(undefined)}
          className="tap-target rounded-control border border-border px-3 py-1 font-semibold hover:bg-soft disabled:opacity-50"
        >
          Mark all as read
        </button>
        {items.length > 0 && (
          <button
            type="button"
            onClick={() => setSelected(selected.size === items.length ? new Set() : new Set(items.map((n) => n.id)))}
            className="tap-target rounded-control px-2 py-1 text-accent-text hover:underline"
          >
            {selected.size === items.length ? 'Select none' : 'Select all shown'}
          </button>
        )}
        {readSome.isError && <span className="text-xs text-danger">{(readSome.error as Error).message}</span>}
      </div>
      <div className="overflow-hidden rounded-card border border-line bg-panel">
        {list.isLoading ? (
          <p className="p-4 text-sm text-muted">Loading…</p>
        ) : list.isError ? (
          <p className="p-4 text-sm text-danger">{(list.error as Error).message}</p>
        ) : items.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted" data-testid="notification-empty">
            {q || type || filter === 'unread' ? 'Nothing matches. Try All, or another type.' : 'No notifications yet. All good.'}
          </p>
        ) : (
          <NotificationList items={items} selected={selected} onSelect={pick} />
        )}
      </div>
      {list.hasNextPage && (
        <div className="text-center">
          <button
            type="button"
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
            className="tap-target rounded-control border border-border px-4 py-1.5 text-sm font-semibold hover:bg-soft disabled:opacity-60"
          >
            {list.isFetchingNextPage ? 'Loading…' : 'Show more'}
          </button>
        </div>
      )}
    </main>
  );
}
