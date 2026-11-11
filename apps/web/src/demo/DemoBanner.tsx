// "Your demo space is yours for about 45 more minutes." A small, friendly
// bar shown to a demo visitor. The end time comes from /api/auth/me (the
// space's own time, a fixed while from when it was made) and the count
// updates live, with no refresh. In the last 5 minutes it says the space is
// ending soon and offers "Download this layout" so the work can be kept.
// When the time is up it asks /api/auth/me again, which finds the visitor
// signed out and brings up "The demo was reset. Start again?" (DemoResetNotice).
// Clicks pass through the bar, except on its own link.

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { matchPath, useLocation } from 'react-router-dom';
import { api } from '../api';
import { minutesLeftText, timeUntil } from './demoText';

/** The last stretch, when the bar warns and offers a download. */
export const ENDING_SOON_MS = 5 * 60_000;

export function DemoBanner() {
  const qc = useQueryClient();
  const { pathname } = useLocation();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  // Only a demo space's /me carries `demo`.
  const demo = me.data?.user?.demo;
  const endsAt = demo?.expiresAt ?? null;
  const [now, setNow] = useState(() => Date.now());
  // Every 10 seconds, and each second in the last minute.
  const lastMinute = endsAt !== null && endsAt - now < 60_000;
  useEffect(() => {
    if (endsAt === null) return;
    const t = window.setInterval(() => setNow(Date.now()), lastMinute ? 1000 : 10_000);
    return () => window.clearInterval(t);
  }, [endsAt, lastMinute]);
  // Time is up: find out we were signed out (the "start again" card follows).
  useEffect(() => {
    if (endsAt !== null && now >= endsAt) void qc.invalidateQueries({ queryKey: ['me'] });
  }, [endsAt, now, qc]);
  if (!demo || endsAt === null) return null;
  const left = endsAt - now;
  const soon = left <= ENDING_SOON_MS;
  const layoutId = matchPath('/editor/:id', pathname)?.params.id ?? null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[max(0.25rem,env(safe-area-inset-top))] z-50 flex justify-center px-4">
      <p
        role="status"
        data-testid="demo-banner"
        data-state={soon ? 'ending' : 'running'}
        className={`pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-x-2 rounded-full border px-3 py-1 text-xs text-ink shadow-pop ${soon ? 'border-accent bg-panel' : 'pointer-events-none border-line bg-panel/95'}`}
      >
        {soon ? (
          <>
            <span data-testid="demo-banner-text">
              Your demo space is ending soon: {timeUntil(endsAt, now)} left.
            </span>
            {layoutId ? (
              <a
                href={`/api/layouts/${layoutId}/export.bld-layout`}
                download
                data-testid="demo-banner-download"
                className="font-semibold text-accent underline"
              >
                Download this layout
              </a>
            ) : (
              <a href="/" data-testid="demo-banner-download" className="font-semibold text-accent underline">
                Open your layout to download it
              </a>
            )}
          </>
        ) : (
          <span data-testid="demo-banner-text">Your demo space is yours for {minutesLeftText(endsAt, now)}.</span>
        )}
      </p>
    </div>
  );
}
