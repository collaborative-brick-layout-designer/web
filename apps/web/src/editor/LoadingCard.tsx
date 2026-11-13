// The loading card over the map: "Opening layout…" while the layout and the
// parts list arrive, then "Loading part pictures… 132 of 480" with a real
// progress bar, then nothing — or "3 pictures couldn't load" with Retry.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { getSpriteProgress, retryFailedSprites, subscribeSpriteProgress, type SpriteProgress } from './render/spriteCache';
import { formatBytes, getDownloadProgress, subscribeDownloadProgress } from './layoutDownload';

/** A later batch (one new part, say) only shows its card if it takes this long. */
export const LATER_BATCH_DELAY_MS = 400;

const fmt = (n: number) => n.toLocaleString('en-US');

/** "1 picture" / "3 pictures". */
function pictures(n: number): string {
  return `${fmt(n)} ${n === 1 ? 'picture' : 'pictures'}`;
}

/**
 * The card itself. Without `total` the bar runs as "busy" (no number known yet).
 */
export function LoadingCard({
  title,
  detail,
  done,
  total,
  countText,
  centered,
  testId = 'loading-card',
}: {
  title: string;
  detail?: string | undefined;
  done?: number;
  total?: number;
  /** How far along, in words ("1.2 of 2.2 MB"), in place of "132 of 480". */
  countText?: string;
  /** In the middle of its box (first open); otherwise near the top. */
  centered?: boolean;
  testId?: string;
}) {
  const known = total !== undefined && done !== undefined && total > 0;
  const pct = known ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const count = countText ?? (known ? `${fmt(done)} of ${fmt(total)}` : undefined);
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 z-20 flex justify-center px-4 ${centered ? 'inset-y-0 items-center' : 'top-14'}`}
    >
      <div
        data-testid={testId}
        className="w-full max-w-sm rounded-card border border-line bg-panel px-4 py-3 text-ink shadow-pop"
      >
        <div role="status" aria-live="polite" className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-semibold">{title}</span>
          {count && (
            <span data-testid="loading-count" className="shrink-0 text-sm tabular-nums text-muted">
              {count}
            </span>
          )}
        </div>
        <div
          role="progressbar"
          aria-label={title}
          aria-valuemin={0}
          {...(known ? { 'aria-valuenow': done, 'aria-valuemax': total, 'aria-valuetext': count } : {})}
          className="mt-2 h-2 overflow-hidden rounded-full bg-soft"
        >
          {known ? (
            <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
          ) : (
            <div className="loading-busy h-full w-1/3 rounded-full bg-accent" />
          )}
        </div>
        {detail && <p className="mt-1.5 text-xs text-muted">{detail}</p>}
      </div>
    </div>
  );
}

/** The full-page card while the layout itself is arriving: how much of it, once known. */
export function OpeningLayoutScreen() {
  const d = useSyncExternalStore(subscribeDownloadProgress, getDownloadProgress);
  const total = d?.total ?? null;
  const countText = d ? (total ? `${formatBytes(Math.min(d.loaded, total))} of ${formatBytes(total)}` : formatBytes(d.loaded)) : undefined;
  return (
    <div className="relative h-screen bg-bg">
      <LoadingCard
        title="Opening layout…"
        detail="Getting the layout from the server."
        centered
        testId="opening-layout"
        {...(d && total ? { done: d.loaded, total } : {})}
        {...(countText ? { countText } : {})}
      />
    </div>
  );
}

/**
 * The card over the map: the parts list, then the part pictures, then any
 * failures. Shows nothing once everything has arrived.
 */
export function MapLoadingCard({ catalogLoading }: { catalogLoading: boolean }) {
  const p = useSyncExternalStore(subscribeSpriteProgress, getSpriteProgress);
  const pending = p.wanted - p.loaded - p.failed;
  // Whether every picture the map asked for has arrived (or failed), for
  // tests that count draws: a picture arriving draws its part again. Not
  // "ready" before the map has asked for any.
  const ready = !catalogLoading && p.wanted > 0 && pending <= 0;
  return (
    <>
      <MapLoadingCardBody catalogLoading={catalogLoading} p={p} pending={pending} />
      <span hidden data-testid="part-pictures" data-state={ready ? 'ready' : 'loading'} />
    </>
  );
}

function MapLoadingCardBody({ catalogLoading, p, pending }: { catalogLoading: boolean; p: SpriteProgress; pending: number }) {
  // A later batch waits a moment, so a quick picture doesn't flash a card.
  const [laterShown, setLaterShown] = useState(false);
  useEffect(() => {
    if (pending <= 0 || p.initial) {
      setLaterShown(false);
      return;
    }
    const t = setTimeout(() => setLaterShown(true), LATER_BATCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [pending > 0, p.initial]); // eslint-disable-line react-hooks/exhaustive-deps
  // Hiding the failure card lasts until the number of failures changes.
  const [dismissedAt, setDismissedAt] = useState(-1);

  if (catalogLoading) {
    return <LoadingCard title="Opening layout…" detail="Getting the parts list." centered />;
  }
  if (pending > 0 && (p.initial || laterShown)) {
    return (
      <LoadingCard
        title="Loading part pictures…"
        done={p.loaded + p.failed}
        total={p.wanted}
        centered={p.initial}
        detail={p.failed > 0 ? `${pictures(p.failed)} couldn't load so far.` : undefined}
      />
    );
  }
  if (pending <= 0 && p.failed > 0 && dismissedAt !== p.failed) {
    return (
      <div className="pointer-events-none absolute inset-x-0 top-14 z-20 flex justify-center px-4">
        <div
          data-testid="loading-failed"
          className="pointer-events-auto flex w-full max-w-sm items-center gap-2 rounded-card border border-line bg-panel py-2 pl-4 pr-2 text-ink shadow-pop"
        >
          <span role="status" aria-live="polite" className="min-w-0 flex-1 text-sm">
            <b className="text-danger">{pictures(p.failed)}</b> couldn't load.
          </span>
          <button
            type="button"
            onClick={retryFailedSprites}
            className="min-h-9 shrink-0 rounded-control bg-accent px-3 text-sm font-semibold text-accent-ink hover:bg-accent-hover pointer-coarse:min-h-11"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => setDismissedAt(p.failed)}
            aria-label="Hide this message"
            className="min-h-9 min-w-9 shrink-0 rounded-control text-muted hover:bg-soft pointer-coarse:min-h-11 pointer-coarse:min-w-11"
          >
            ✕
          </button>
        </div>
      </div>
    );
  }
  return null;
}
