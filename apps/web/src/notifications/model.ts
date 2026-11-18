// What the bell, its panel and the Notifications page share: the queries,
// grouping, and the plain words for how a request was answered. The list
// comes from /api/notifications (docs/notifications.md); live hints of kind
// 'notification' refetch it in every tab (live/invalidate.ts).

import { useQuery } from '@tanstack/react-query';
import { api, type NotificationCategory, type NotificationItem } from '../api';

export const CATEGORY_LABEL: Record<NotificationCategory, string> = {
  moderation: 'Warnings and notes',
  clubs: 'Clubs',
  sharing: 'Sharing',
  shared_modules: 'Shared modules',
  account: 'Your account',
};

export function useNotificationCount(enabled: boolean) {
  return useQuery({ queryKey: ['notification-count'], queryFn: api.notifications.count, enabled, staleTime: 30_000, retry: false });
}

export function useNotificationTypes(enabled = true) {
  return useQuery({ queryKey: ['notification-types'], queryFn: api.notifications.types, enabled, staleTime: Infinity });
}

/** "99+" past 99. */
export function badgeText(n: number): string {
  return n > 99 ? '99+' : String(n);
}

export interface NotificationGroup {
  /** The newest of the group. */
  head: NotificationItem;
  /** The others with the same group key, newest first. */
  rest: NotificationItem[];
}

/**
 * Items with the same group key collapse into one ("3 requests to join
 * Arklug"); the others stay as they are. Order follows each group's newest.
 */
export function groupNotifications(items: readonly NotificationItem[]): NotificationGroup[] {
  const out: NotificationGroup[] = [];
  const byKey = new Map<string, NotificationGroup>();
  for (const n of items) {
    const g = n.groupKey ? byKey.get(n.groupKey) : undefined;
    if (g) {
      g.rest.push(n);
      continue;
    }
    const fresh = { head: n, rest: [] };
    out.push(fresh);
    if (n.groupKey) byKey.set(n.groupKey, fresh);
  }
  return out;
}

/** "You accepted" / "Ann declined" / "They took it back": what happened to a request. */
export function outcomeText(n: Pick<NotificationItem, 'outcome' | 'outcomeBy' | 'type'>): string | null {
  const who = n.outcomeBy ? (n.outcomeBy.you ? 'You' : n.outcomeBy.name || 'Someone') : null;
  switch (n.outcome) {
    case 'accepted':
      return n.type === 'club.join_request' ? `${who ?? 'Someone'} let them in` : `${who ?? 'Someone'} accepted`;
    case 'declined':
      return `${who ?? 'Someone'} declined`;
    case 'withdrawn':
      return 'Taken back, so nothing to answer';
    case 'gone':
      return 'No longer waiting';
    case 'acknowledged':
      return 'You understood';
    default:
      return null;
  }
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", then the date. */
export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} ${d === 1 ? 'day' : 'days'} ago`;
  return new Date(ts).toLocaleDateString();
}

/** Requests whose Decline the club page asks about first ask here too. */
export function declineNeedsConfirm(type: string): boolean {
  return type === 'club.join_request';
}

/** Warnings wait for "I understand" in a banner (Notices.tsx WarningBanner). */
export function isWarning(n: Pick<NotificationItem, 'type'>): boolean {
  return n.type === 'moderation.warning' || n.type === 'moderation.final_warning';
}
