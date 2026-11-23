// The Run panel (trains design 5, 6.3): in the map's corner while Run mode
// is on. Play and Pause, Restart, how fast to watch (¼× to 4×), which
// trains run and on which route, how each is getting on, what happened
// (a switch pushed through, two trains that would collide) with Show me,
// and the layout's scale. Running is this person's own: the trains move
// on this screen only. The desktop's ui/RunPanel.cpp is the twin.

import { useId, useState } from 'react';
import type * as Y from 'yjs';
import { MAX_SCALE, MIN_SCALE, SPEED_MULTIPLIERS, type PlacedTrain, type Route, type RouteStatus, type Train } from '@cld/parts-catalog/browser';
import { useLengthUnit } from '../theme/PrefsProvider';
import { HelpButton } from '../help/HelpButton';
import { formatRealSpeed, formatScaleSpeed, noteText, picksFor, setTrainScale, useRunStore } from './trainRun';

interface Props {
  doc: Y.Doc;
  trains: readonly Train[];
  routes: readonly Route[];
  statuses: ReadonlyMap<string, RouteStatus>;
  /** Where each train stands on the layout (not running). */
  placed: ReadonlyMap<string, PlacedTrain | null>;
  scale: number;
  isViewer: boolean;
  /** A phone: under the banner at the top, clear of the touch tools at the bottom. */
  top?: boolean;
}

const MULT_TEXT: Record<number, string> = { 0.25: '¼×', 0.5: '½×', 1: '1×', 2: '2×', 4: '4×' };
const btn = 'h-8 rounded-control border border-border px-2 text-xs font-semibold hover:bg-soft disabled:opacity-50';
const primary = 'h-8 rounded-control bg-accent px-3 text-xs font-bold text-accent-ink hover:bg-accent-hover disabled:opacity-50';

const STATE_TEXT = {
  running: 'Running',
  arrived: 'At the end of its route',
  endOfTrack: 'At the end of the track',
  blocked: 'Stopped: another train is in the way',
} as const;

function showSpot(at: { x: number; y: number }) {
  window.dispatchEvent(new CustomEvent('cld:show-spot', { detail: at }));
}

export function RunPanel({ doc, trains, routes, statuses, placed, scale, isViewer, top = false }: Props) {
  const uid = useId();
  const unit = useLengthUnit();
  const [open, setOpen] = useState(true);
  const playing = useRunStore((s) => s.playing);
  const run = useRunStore((s) => s.run);
  const multiplier = useRunStore((s) => s.multiplier);
  const realSpeed = useRunStore((s) => s.realSpeed);
  const chosen = useRunStore((s) => s.picks);
  const notes = useRunStore((s) => s.notes);
  const trainStates = useRunStore((s) => s.trainStates);
  const { setPlaying, setMultiplier, setRealSpeed, setPick, restart } = useRunStore.getState();
  const picks = picksFor(trains, routes, placed, statuses, chosen);
  const anyOn = [...picks.values()].some((p) => p?.on);
  const nameOf = (id: string) => trains.find((t) => t.id === id)?.name || 'A train';
  const routeOf = (trainId: string) => {
    const p = picks.get(trainId);
    return p?.route ? routes.find((r) => r.id === p.route)?.name ?? null : null;
  };
  const [scaleText, setScaleText] = useState<string | null>(null);
  const commitScale = () => {
    if (scaleText === null) return;
    const n = Number(scaleText);
    if (Number.isFinite(n) && n >= MIN_SCALE && n <= MAX_SCALE && Math.round(n) !== scale) setTrainScale(doc, n);
    setScaleText(null);
  };
  const speedText = (t: Train) => (realSpeed ? formatRealSpeed(t.speed, scale, unit) : formatScaleSpeed(t.speed, unit));
  const finished = !!run && !playing && Object.values(trainStates).length > 0 && Object.values(trainStates).every((s) => s !== 'running');

  return (
    <section
      aria-label="Run trains"
      data-testid="run-panel"
      className={
        'pointer-events-auto absolute left-3 z-20 flex w-[300px] max-w-[calc(100%-24px)] flex-col overflow-hidden rounded-card border border-line bg-panel text-sm shadow-pop ' +
        (top ? 'top-16 max-h-[45%]' : 'bottom-3 max-h-[60%]')
      }
    >
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <button
          type="button"
          className={primary + ' min-w-[76px]'}
          data-testid="run-play"
          disabled={!anyOn}
          aria-pressed={playing}
          onClick={() => setPlaying(!playing)}
          title={playing ? 'Pause every train' : 'Start every ticked train'}
        >
          {playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <button type="button" className={btn} data-testid="run-restart" disabled={!run} onClick={restart} title="Every train back to where it started">
          ↺ Restart
        </button>
        <label className="sr-only" htmlFor={`${uid}-mult`}>
          How fast to watch
        </label>
        <select
          id={`${uid}-mult`}
          data-testid="run-multiplier"
          className="h-8 rounded-control border border-border bg-bg px-1 text-xs"
          value={multiplier}
          onChange={(e) => setMultiplier(Number(e.target.value))}
          title="How fast to watch: times real speed"
        >
          {SPEED_MULTIPLIERS.map((m) => (
            <option key={m} value={m}>
              {MULT_TEXT[m]}
            </option>
          ))}
        </select>
        <HelpButton helpKey="run.trains" />
        <button
          type="button"
          className="ml-auto h-8 rounded px-2 text-xs text-muted hover:bg-soft"
          aria-expanded={open}
          data-testid="run-panel-toggle"
          onClick={() => setOpen(!open)}
          title={open ? 'Show less' : 'Show the trains'}
        >
          {open ? '▾' : '▸'}
        </button>
      </div>
      {open && (
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto p-2">
          {trains.length === 0 ? (
            <div className="text-xs text-muted" data-testid="run-empty">
              <p>There are no trains on this layout yet.</p>
              <button type="button" className={btn + ' mt-1'} onClick={() => window.dispatchEvent(new CustomEvent('cld:show-panel', { detail: 'trains' }))}>
                Open Trains
              </button>
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5" aria-label="Trains to run">
              {trains.map((t) => {
                const p = picks.get(t.id) ?? null;
                const state = trainStates[t.id];
                const onTrack = !!placed.get(t.id);
                const usable = routes.filter((r) => statuses.get(r.id)?.status !== 'broken');
                return (
                  <li key={t.id} className="flex flex-col gap-1 rounded border border-border px-1.5 py-1" data-testid="run-train" data-train={t.id}>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        aria-label={`Run ${t.name}`}
                        checked={!!p?.on}
                        disabled={!p}
                        onChange={(e) => p && setPick(t.id, { ...p, on: e.target.checked })}
                      />
                      <span aria-hidden className="h-3 w-3 shrink-0 rounded-sm border border-black/20" style={{ background: t.color }} />
                      <span className="min-w-0 flex-1 truncate font-medium">{t.name || 'Train'}</span>
                      <span className="text-xs text-muted" data-testid="run-speed">{speedText(t)}</span>
                    </div>
                    {!p ? (
                      <p className="text-xs text-muted">Put it on the track, or draw a route for it, to run it.</p>
                    ) : (
                      <select
                        aria-label={`Where ${t.name} runs`}
                        data-testid="run-route"
                        className="h-7 w-full rounded border border-border bg-bg px-1 text-xs"
                        value={p.route ?? ''}
                        onChange={(e) => setPick(t.id, { on: true, route: e.target.value || null })}
                      >
                        {onTrack && <option value="">From where it stands, following the switches</option>}
                        {usable.map((r) => (
                          <option key={r.id} value={r.id}>
                            Route: {r.name}
                          </option>
                        ))}
                      </select>
                    )}
                    {state && (
                      <span data-testid="run-state" data-state={state} className={'text-xs ' + (state === 'blocked' ? 'font-semibold text-red-700 dark:text-red-300' : 'text-muted')}>
                        {STATE_TEXT[state]}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {finished && <p className="text-xs text-muted" data-testid="run-finished">Every train has stopped. Restart puts them back where they started.</p>}
          {notes.length > 0 && (
            <ul className="flex flex-col gap-1" aria-label="What happened" data-testid="run-notes">
              {[...notes].reverse().map((n) => (
                <li
                  key={n.id}
                  data-testid="run-note"
                  data-kind={n.kind}
                  className={'flex items-start gap-1 rounded px-1.5 py-1 text-xs ' + (n.kind === 'collision' ? 'bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100' : n.kind === 'pushedThrough' || n.kind === 'routeSet' ? 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100' : 'bg-soft')}
                >
                  <span className="flex-1">{noteText(n, nameOf, routeOf)}</span>
                  {n.kind === 'pushedThrough' && <HelpButton helpKey="run.switchPushed" />}
                  <button type="button" className="shrink-0 rounded px-1 font-semibold underline hover:bg-black/5" onClick={() => showSpot(n.at)}>
                    Show me
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2 text-xs">
            <label className="flex items-center gap-1" htmlFor={`${uid}-scale`}>
              Scale 1:
              <input
                id={`${uid}-scale`}
                data-testid="run-scale"
                type="number"
                min={MIN_SCALE}
                max={MAX_SCALE}
                step={1}
                disabled={isViewer}
                className="h-7 w-14 rounded border border-border bg-bg px-1"
                value={scaleText ?? String(scale)}
                onChange={(e) => setScaleText(e.target.value)}
                onBlur={commitScale}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitScale();
                  if (e.key === 'Escape') setScaleText(null);
                }}
              />
            </label>
            <HelpButton helpKey="trains.scale" />
            <label className="flex items-center gap-1">
              <input type="checkbox" data-testid="run-real-speed" checked={realSpeed} onChange={(e) => setRealSpeed(e.target.checked)} />
              Real speed
            </label>
          </div>
        </div>
      )}
    </section>
  );
}
