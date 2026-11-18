// One list of notifications, as the bell's panel and the Notifications page
// show it: newest first, grouped, each with Mark read / unread, Open (which
// marks it read), and Accept / Decline or I understand where something
// waits for you. Answers go through POST /api/notifications/:id/act, which
// runs the same route the club or invite page uses; when someone else
// already answered, the item says so.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api, type NotificationItem } from '../api';
import { askConfirm } from '../ui/ConfirmDialog';
import { declineNeedsConfirm, groupNotifications, isWarning, outcomeText, timeAgo } from './model';

const BTN = 'tap-target rounded-control border border-border px-3 py-1 text-sm font-semibold hover:bg-soft disabled:opacity-60';
const PRIMARY = 'tap-target rounded-control bg-accent px-3 py-1 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-60';

export function NotificationList({
  items,
  compact = false,
  onOpen,
  selected,
  onSelect,
}: {
  items: readonly NotificationItem[];
  /** The panel: shorter bodies. */
  compact?: boolean;
  /** After an item is opened (the panel closes). */
  onOpen?: () => void;
  /** The page's bulk selection. */
  selected?: ReadonlySet<string>;
  onSelect?: (id: string, on: boolean) => void;
}) {
  const groups = groupNotifications(items);
  return (
    <ul className="divide-y divide-line" data-testid="notification-list">
      {groups.map((g) => (
        <Group key={g.head.id} head={g.head} rest={g.rest} compact={compact} onOpen={onOpen} selected={selected} onSelect={onSelect} />
      ))}
    </ul>
  );
}

function Group({
  head,
  rest,
  compact,
  onOpen,
  selected,
  onSelect,
}: {
  head: NotificationItem;
  rest: NotificationItem[];
  compact: boolean;
  onOpen?: (() => void) | undefined;
  selected?: ReadonlySet<string> | undefined;
  onSelect?: ((id: string, on: boolean) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const unreadInGroup = [head, ...rest].filter((n) => !n.readAt).length;
  return (
    <li>
      <Row n={head} compact={compact} onOpen={onOpen} selected={selected} onSelect={onSelect} />
      {rest.length > 0 && (
        <div className="px-3 pb-2 pl-9">
          <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="text-xs font-semibold text-accent-text hover:underline" data-testid="notification-group-toggle">
            {open ? 'Show fewer' : `${rest.length} more like this${unreadInGroup > (head.readAt ? 0 : 1) ? ' (new)' : ''}`}
          </button>
          {open && (
            <ul className="mt-1 divide-y divide-line rounded-control border border-line">
              {rest.map((n) => (
                <li key={n.id}>
                  <Row n={n} compact={compact} onOpen={onOpen} selected={selected} onSelect={onSelect} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function Row({
  n,
  compact,
  onOpen,
  selected,
  onSelect,
}: {
  n: NotificationItem;
  compact: boolean;
  onOpen?: (() => void) | undefined;
  selected?: ReadonlySet<string> | undefined;
  onSelect?: ((id: string, on: boolean) => void) | undefined;
}) {
  const read = useMutation({ mutationFn: () => api.notifications.read(n.id) });
  const unread = useMutation({ mutationFn: () => api.notifications.unread(n.id) });
  const ack = useMutation({ mutationFn: () => api.notifications.acknowledge(n.id) });
  const act = useMutation({ mutationFn: (a: 'accept' | 'decline') => api.notifications.act(n.id, a) });
  const busy = act.isPending || ack.isPending;
  const waiting = n.actions.includes('accept');
  const done = outcomeText(n);
  // Until a request is answered its thing isn't yours to open yet (an invite's layout).
  const link = n.link && !waiting ? n.link : null;
  const error = (act.error ?? ack.error ?? read.error ?? unread.error) as Error | null;

  const open = () => {
    if (!n.readAt) read.mutate();
    onOpen?.();
  };

  const decline = async () => {
    if (declineNeedsConfirm(n.type)) {
      const ok = await askConfirm({ title: `Decline this request?`, removes: 'The request to join is turned down.', keeps: 'They can ask again later.', confirmLabel: 'Decline' });
      if (!ok) return;
    }
    act.mutate('decline');
  };

  const title = <span className={n.readAt ? 'font-normal' : 'font-semibold'}>{n.title}</span>;
  return (
    <div
      data-testid="notification-item"
      data-type={n.type}
      data-read={n.readAt ? 'yes' : 'no'}
      className={`flex gap-2 px-3 py-2.5 text-sm ${n.readAt ? '' : 'bg-accent/5'} ${isWarning(n) && !n.doneAt ? 'border-l-4 border-danger' : ''}`}
    >
      {onSelect ? (
        <input
          type="checkbox"
          aria-label={`Select “${n.title}”`}
          checked={selected?.has(n.id) ?? false}
          onChange={(e) => onSelect(n.id, e.target.checked)}
          className="mt-1 h-4 w-4 shrink-0"
        />
      ) : (
        <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.readAt ? 'bg-transparent' : 'bg-accent'}`} />
      )}
      <div className="min-w-0 flex-1">
        <p className="break-words text-ink">
          {link ? (
            <Link to={link} onClick={open} className="hover:underline">
              {title}
            </Link>
          ) : (
            title
          )}
          {!n.readAt && <span className="sr-only"> (new)</span>}
        </p>
        {n.body && <p className={`mt-0.5 whitespace-pre-wrap break-words text-muted ${compact ? 'line-clamp-2' : ''}`}>{n.body}</p>}
        <p className="mt-0.5 text-xs text-muted">
          {timeAgo(n.createdAt)}
          {n.club ? ` · ${n.club.name}` : ''}
        </p>
        {(waiting || n.actions.includes('acknowledge')) && (
          <div className="mt-2 flex flex-wrap gap-2">
            {waiting && (
              <>
                <button type="button" className={PRIMARY} disabled={busy} onClick={() => act.mutate('accept')}>
                  {n.type === 'club.join_request' ? 'Let them in' : 'Accept'}
                </button>
                <button type="button" className={BTN} disabled={busy} onClick={() => void decline()}>
                  Decline
                </button>
              </>
            )}
            {n.actions.includes('acknowledge') && (
              <button type="button" className={PRIMARY} disabled={busy} onClick={() => ack.mutate()}>
                I understand
              </button>
            )}
          </div>
        )}
        {done && (
          <p role="status" className="mt-1 text-xs font-semibold text-muted" data-testid="notification-outcome">
            {done}
            {act.data?.already ? ' (someone else answered first)' : ''}
          </p>
        )}
        {error && <p className="mt-1 text-xs text-danger">{error.message}</p>}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <button
          type="button"
          onClick={() => (n.readAt ? unread.mutate() : read.mutate())}
          aria-label={n.readAt ? `Mark “${n.title}” as unread` : `Mark “${n.title}” as read`}
          title={n.readAt ? 'Mark as unread' : 'Mark as read'}
          className="tap-target rounded-control p-1 text-muted hover:bg-soft hover:text-ink"
        >
          {n.readAt ? (
            <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="5" />
            </svg>
          ) : (
            <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M5 12l4 4 10-10" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
