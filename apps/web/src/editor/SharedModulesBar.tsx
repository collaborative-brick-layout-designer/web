// The notices for shared modules, over the bottom of the map
// (docs/shared-modules.md, "The update notice"): a new version is ready
// (Show / Update / Not now; several: Update all), and, after an update,
// what the module is now (and what it now overlaps) with Go back and OK;
// and a copy changed outside the app, with Put back and Make it mine.
// In an Ask first layout nothing updates by itself: someone who can edit
// the layout presses Update, and the server puts the version in for
// everyone (sharedModules.ts, api.sharedModules). An Automatically layout
// gets each version from the server; opening it later says what was
// "Updated while you were away", with Go back.

import { useState } from 'react';
import { HelpButton } from '../help/HelpButton';
import type { SharedPlaced } from '@cld/modules';
import { awayLine, awayText, putBackLabel, reviewText, updatesText, type AwayUpdate, type SharedUpdate } from './sharedModules';
import { marksText, type SharedMarks } from './sharedMarks';

interface Props {
  /** Placed copies with a newer version waiting. */
  updates: readonly SharedUpdate[];
  /** Placed copies an update just changed (their `review` is set). */
  reviews: readonly SharedPlaced[];
  /** What each of `reviews` now overlaps, by placed id. */
  marks?: Record<string, SharedMarks>;
  /** Copies whose parts aren't their version's ("changed outside the app"). */
  drifted?: readonly SharedPlaced[];
  /** Updated automatically since you last had the layout open. */
  away?: readonly AwayUpdate[];
  /** "Updated while you were away" is read. */
  onAwayOk?: (list: readonly AwayUpdate[]) => void;
  /** You can edit the layout: Update, Go back and OK are yours to press. */
  canUpdate: boolean;
  /** You may "Make it mine" (the layout's owner; a club's admins and managers). */
  canDetach?: boolean;
  /** Something is being sent to the server. */
  busy: boolean;
  onShow: (placedIds: readonly string[]) => void;
  onUpdate: (updates: readonly SharedUpdate[]) => void;
  onGoBack: (placed: SharedPlaced, version: number) => void;
  onOk: (placed: readonly SharedPlaced[]) => void;
  onPutBack?: (placed: SharedPlaced) => void;
  onMakeItMine?: (placed: SharedPlaced) => void;
  /** On a phone: at the top, under Undo / Redo. */
  top?: boolean;
}

const BTN = 'min-h-9 rounded-lg border border-border px-3 py-1 hover:bg-soft disabled:opacity-50';
const PRIMARY = 'min-h-9 rounded-lg bg-accent px-3 py-1 font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50';

export function SharedModulesBar({
  updates,
  reviews,
  marks = {},
  drifted = [],
  away = [],
  onAwayOk,
  canUpdate,
  canDetach = false,
  busy,
  onShow,
  onUpdate,
  onGoBack,
  onOk,
  onPutBack,
  onMakeItMine,
  top = false,
}: Props) {
  // "Not now" for these versions; a newer one shows it again.
  const [closedFor, setClosedFor] = useState('');
  const key = updates.map((u) => `${u.placed.placedId}:${u.latest}`).join(',');
  const showUpdates = updates.length > 0 && closedFor !== key;
  // "Not now" for a changed copy: until it is opened again.
  const [driftClosed, setDriftClosed] = useState<string[]>([]);
  const drift = drifted.find((p) => !driftClosed.includes(p.placedId));
  // A module the "while you were away" notice is about isn't also told as "is now version N".
  const awayIds = new Set(away.map((a) => a.placed.placedId));
  reviews = reviews.filter((r) => !awayIds.has(r.placedId));
  if (!showUpdates && reviews.length === 0 && !drift && away.length === 0) return null;
  const review = reviews[0];
  const one = away.length === 1 ? away[0]! : null;
  const awayMarks = one ? marksText(marks[one.placed.placedId] ?? { overlaps: 0, looseEnds: 0 }) : '';
  const reviewMarks = review && reviews.length === 1 ? marksText(marks[review.placedId] ?? { overlaps: 0, looseEnds: 0 }) : '';
  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-30 flex flex-col items-center gap-2 px-3"
      style={top ? { top: 'var(--touch-top, 0.5rem)' } : { bottom: 'calc(4.5rem + var(--touch-bar-h, 0px))' }}
    >
      {away.length > 0 && (
        <div role="status" data-testid="shared-module-away" className="pointer-events-auto flex min-w-0 max-w-xl flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-accent bg-panel px-4 py-3 text-sm text-ink shadow-lg">
          <span className="flex min-w-0 items-start gap-1">
            <span>
              <span className="block font-semibold">Updated while you were away</span>
              <span className="mt-1 block">{[awayText(away), awayMarks].filter(Boolean).join(' ')}</span>
              {away.length > 1 && <span className="mt-1 block text-xs text-muted">{away.map(awayLine).join(', ')}</span>}
            </span>
            <HelpButton helpKey="module.sharedUpdatesSetting" />
          </span>
          <span className="flex flex-wrap gap-2">
            <button type="button" className={BTN} onClick={() => onShow(away.map((a) => a.placed.placedId))}>
              Show
            </button>
            {canUpdate && one && one.from !== null && one.from !== one.to && (
              <button type="button" className={BTN} disabled={busy} onClick={() => onGoBack(one.placed, one.from!)}>
                Go back to version {one.from}
              </button>
            )}
            <button type="button" className={PRIMARY} disabled={busy} onClick={() => onAwayOk?.(away)}>
              OK
            </button>
          </span>
        </div>
      )}
      {review && (
        <div role="status" data-testid="shared-module-updated" className="pointer-events-auto flex min-w-0 max-w-xl flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-accent bg-panel px-4 py-3 text-sm text-ink shadow-lg">
          <span className="min-w-0">
            {reviews.length === 1 ? [reviewText(review), reviewMarks].filter(Boolean).join(' ') : `${reviews.length} shared modules were updated.`}
          </span>
          <span className="flex flex-wrap gap-2">
            <button type="button" className={BTN} onClick={() => onShow(reviews.map((r) => r.placedId))}>
              Show
            </button>
            {canUpdate && reviews.length === 1 && review.review?.from != null && (
              <button type="button" className={BTN} disabled={busy} onClick={() => onGoBack(review, review.review!.from!)}>
                Go back to version {review.review.from}
              </button>
            )}
            {canUpdate && (
              <button type="button" className={PRIMARY} disabled={busy} onClick={() => onOk(reviews)}>
                OK
              </button>
            )}
          </span>
        </div>
      )}
      {drift && (
        <div role="status" data-testid="shared-module-drift" className="pointer-events-auto flex min-w-0 max-w-xl flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-accent bg-panel px-4 py-3 text-sm text-ink shadow-lg">
          <span className="flex min-w-0 items-start gap-1">
            <span>
              <span className="block font-semibold">“{drift.name || 'A shared module'}” was changed outside the app</span>
              <span className="mt-1 block text-xs text-muted">
                {drift.by
                  ? `Its parts aren’t ${drift.by}’s version ${drift.version ?? ''} anymore: another app changed this layout. Put ${drift.by}’s version back, or make the module yours.`
                  : `Its parts aren’t its owner’s version ${drift.version ?? ''} anymore: another app changed this layout. Put the owner’s version back, or make the module yours.`}
              </span>
            </span>
            <HelpButton helpKey="module.shared" />
          </span>
          <span className="flex flex-wrap gap-2">
            <button type="button" className={BTN} onClick={() => onShow([drift.placedId])}>
              Show
            </button>
            {canUpdate && onPutBack && (
              <button type="button" className={PRIMARY} disabled={busy} onClick={() => onPutBack(drift)}>
                {putBackLabel(drift.by)}
              </button>
            )}
            {canDetach && onMakeItMine && (
              <button type="button" className={BTN} disabled={busy} onClick={() => onMakeItMine(drift)}>
                Make it mine…
              </button>
            )}
            <button type="button" aria-label="Not now" title="Not now" onClick={() => setDriftClosed((c) => [...c, drift.placedId])} className="min-h-9 min-w-9 rounded-control px-1.5 text-muted hover:bg-soft hover:text-ink">
              ×
            </button>
          </span>
        </div>
      )}
      {showUpdates && (
        <div role="status" data-testid="shared-module-updates" className="pointer-events-auto flex min-w-0 max-w-xl flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-accent bg-panel px-4 py-3 text-sm text-ink shadow-lg">
          <span className="flex min-w-0 items-start gap-1">
            <span>
              {updatesText(updates)}
              {updates.length > 1 && (
                <span className="mt-1 block text-xs text-muted">{updates.map((u) => `“${u.placed.name || u.row.title || 'Module'}” v${u.latest}`).join(', ')}</span>
              )}
              {!canUpdate && <span className="mt-1 block text-xs text-muted">Someone who can change this layout can update it.</span>}
            </span>
            <HelpButton helpKey="module.sharedUpdates" />
          </span>
          <span className="flex flex-wrap gap-2">
            <button type="button" className={BTN} onClick={() => onShow(updates.map((u) => u.placed.placedId))}>
              Show
            </button>
            {canUpdate && (
              <button type="button" className={PRIMARY} disabled={busy} onClick={() => onUpdate(updates)}>
                {updates.length === 1 ? 'Update' : `Update all ${updates.length}`}
              </button>
            )}
            <button type="button" aria-label="Not now" title="Not now" onClick={() => setClosedFor(key)} className="min-h-9 min-w-9 rounded-control px-1.5 text-muted hover:bg-soft hover:text-ink">
              ×
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
