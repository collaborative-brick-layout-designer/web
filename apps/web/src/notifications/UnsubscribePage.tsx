// /unsubscribe?t=…: where an email's "Stop these emails" link goes. It
// says what it would stop and asks first (mail scanners open links, so
// opening it changes nothing); no sign-in needed. Mail apps that support
// one-click (RFC 8058) stop it without this page.

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../api';

export function UnsubscribePage() {
  const [params] = useSearchParams();
  const t = params.get('t') ?? '';
  const info = useQuery({ queryKey: ['unsubscribe', t], queryFn: () => api.notifications.unsubscribeInfo(t), enabled: !!t, retry: false });
  const stop = useMutation({ mutationFn: () => api.notifications.unsubscribe(t) });
  const [done, setDone] = useState(false);
  return (
    <main className="mx-auto max-w-lg space-y-4 p-6 text-ink sm:p-10">
      <h1 className="font-display text-xl font-semibold">Stop these emails</h1>
      {!t || info.isError ? (
        <p className="text-sm text-muted">This link doesn’t work. You can choose your emails in Settings › Notifications after you sign in.</p>
      ) : info.isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : done ? (
        <p role="status" className="text-sm" data-testid="unsubscribe-done">
          Done. You won’t get {info.data!.what} any more. You can turn them back on any time in Settings › Notifications.
        </p>
      ) : (
        <>
          <p className="text-sm">Stop {info.data!.what}? You’ll still see them in the app’s notifications.</p>
          <button
            type="button"
            disabled={stop.isPending}
            onClick={() => stop.mutate(undefined, { onSuccess: () => setDone(true) })}
            className="tap-target rounded-control bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-60"
          >
            Stop these emails
          </button>
          {stop.isError && <p className="text-xs text-danger">{(stop.error as Error).message}</p>}
        </>
      )}
      <p className="text-sm">
        <Link to="/settings#notifications" className="text-accent-text hover:underline">
          All notification settings
        </Link>
      </p>
    </main>
  );
}
