// The Routes panel (trains design 6.2): the layout's named routes, each with
// its length, a status (OK, switches set the other way, or broken) and an
// eye that shows or hides it on this person's map only. New route draws one
// on the track; each route can set its switches, find a new way when the
// track under it changed, be renamed or deleted. The desktop's
// ui/RoutesPanel.cpp is the twin.

import { useState } from 'react';
import type * as Y from 'yjs';
import type { FitCheck, Route, RouteStatus, TrackNetwork } from '@cld/parts-catalog/browser';
import { formatLength } from '../venues/designer/units';
import { useLengthUnit } from '../theme/PrefsProvider';
import { HelpButton } from '../help/HelpButton';
import { useEditorStore } from './editorStore';
import { setSwitches } from './mutations';
import { findAgain, problemText, removeRoute, saveRoute } from './routes';
import { FitChecksList } from './FitChecksList';
import type { namesOf } from './fitChecks';

interface Props {
  doc: Y.Doc;
  net: TrackNetwork | null;
  routes: readonly Route[];
  statuses: ReadonlyMap<string, RouteStatus>;
  hidden: ReadonlySet<string>;
  setShown: (id: string, shown: boolean) => void;
  isViewer: boolean;
  /** The routes' fit checks (turning a train around, polarity). */
  checks?: readonly FitCheck[];
  names?: ReturnType<typeof namesOf>;
}

function StatusChip({ status }: { status: RouteStatus | undefined }) {
  if (!status) return null;
  if (status.status === 'broken')
    return <span data-testid="route-status" className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-800 dark:bg-red-950 dark:text-red-200">Broken</span>;
  const n = status.setAgainst.length;
  if (n > 0)
    return (
      <span data-testid="route-status" className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900 dark:bg-amber-950 dark:text-amber-200">
        {n === 1 ? '1 switch set the other way' : `${n} switches set the other way`}
      </span>
    );
  return <span data-testid="route-status" className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-semibold text-green-800 dark:bg-green-950 dark:text-green-200">OK</span>;
}

export function RoutesPanel({ doc, net, routes, statuses, hidden, setShown, isViewer, checks = [], names }: Props) {
  const unit = useLengthUnit();
  const drafting = useEditorStore((s) => s.routeDraft !== null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const hasTrack = !!net && net.brickIds.length > 0;

  const startNew = () => useEditorStore.getState().setRouteDraft({ from: null, via: [], to: null });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 text-sm" data-testid="routes-panel">
      {!isViewer && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={startNew}
            disabled={drafting || !hasTrack}
            data-testid="route-new"
            className="h-9 rounded-control bg-accent px-3 text-xs font-bold text-accent-ink hover:bg-accent-hover disabled:opacity-50"
          >
            New route
          </button>
          <HelpButton helpKey="routes.new" />
        </div>
      )}
      {message && (
        <p role="status" className="rounded-md bg-soft px-2 py-1 text-xs">
          {message}
        </p>
      )}
      {!hasTrack ? (
        <p className="text-muted">There’s no track on this layout yet. Add some from the Parts panel’s Track group, then draw a route along it.</p>
      ) : routes.length === 0 ? (
        <p className="text-muted">No routes yet. Press New route, then click two places on the track: where it starts and where it ends.</p>
      ) : (
        <ul className="flex flex-col gap-1.5" aria-label="Routes">
          {routes.map((r) => {
            const st = statuses.get(r.id);
            const shown = !hidden.has(r.id);
            return (
              <li key={r.id} data-route={r.id} className="rounded-card border border-line bg-panel p-2">
                <div className="flex items-center gap-2">
                  <span aria-hidden className="h-3 w-3 shrink-0 rounded-full" style={{ background: r.color }} />
                  {renaming === r.id ? (
                    <form
                      className="flex min-w-0 flex-1 gap-1"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (name.trim()) saveRoute(doc, { ...r, name: name.trim() });
                        setRenaming(null);
                      }}
                    >
                      <input autoFocus aria-label="Route name" value={name} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1 rounded border border-border bg-bg px-1" />
                      <button type="submit" className="rounded px-2 text-xs font-semibold hover:bg-soft">Save</button>
                    </form>
                  ) : (
                    <span className="min-w-0 flex-1 truncate font-semibold" title={r.name}>
                      {r.name || 'Untitled route'}
                    </span>
                  )}
                  <button
                    type="button"
                    aria-pressed={shown}
                    aria-label={shown ? `Hide ${r.name} on your map` : `Show ${r.name} on your map`}
                    title={shown ? 'Shown on your map (only yours)' : 'Hidden on your map (only yours)'}
                    onClick={() => setShown(r.id, !shown)}
                    className="grid h-8 w-8 place-items-center rounded hover:bg-soft"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
                      {shown ? <circle cx="12" cy="12" r="3" /> : <path d="M4 4l16 16" />}
                    </svg>
                  </button>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <StatusChip status={st} />
                  {st?.status === 'ok' && <span data-testid="route-length">{formatLength(st.length, unit)}</span>}
                  {st?.status === 'ok' && st.turnsAround.length > 0 && <span>Turns the train around</span>}
                  {st?.status === 'ok' && st.bothWays.length > 0 && <span data-testid="route-both-ways">Flip a switch on the way: it runs through it twice</span>}
                  {st?.status === 'broken' && (
                    <span className="flex items-center gap-1">
                      The track under it changed. <HelpButton helpKey="routes.broken" />
                    </span>
                  )}
                </div>
                {!isViewer && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {st?.status === 'ok' && Object.keys(st.switches).length > 0 && (
                      <span className="flex items-center gap-0.5">
                        <button
                          type="button"
                          className="rounded border border-border px-2 py-1 text-xs hover:bg-soft"
                          onClick={() => {
                            const changes: Record<string, number | null> = {};
                            for (const [key, exit] of Object.entries(st.switches)) {
                              const sw = net?.switchAt(key);
                              changes[key] = sw && sw.default === exit ? null : exit;
                            }
                            setSwitches(doc, changes);
                            setMessage(`Switches set for “${r.name}”.`);
                          }}
                        >
                          Set switches
                        </button>
                        <HelpButton helpKey="routes.setSwitches" />
                      </span>
                    )}
                    {st?.status === 'broken' && net && (
                      <button
                        type="button"
                        className="rounded border border-border px-2 py-1 text-xs font-semibold hover:bg-soft"
                        onClick={() => {
                          const found = findAgain(net, r);
                          if (typeof found === 'string') {
                            setMessage(`${problemText(found)} Draw the route again from its new start or end.`);
                            return;
                          }
                          saveRoute(doc, { ...r, steps: found.steps });
                          setMessage(`Found a new way for “${r.name}”.`);
                        }}
                      >
                        Find a new way
                      </button>
                    )}
                    <button type="button" className="rounded px-2 py-1 text-xs hover:bg-soft" onClick={() => { setRenaming(r.id); setName(r.name); }}>
                      Rename
                    </button>
                    {confirmDelete === r.id ? (
                      <span className="flex items-center gap-1 text-xs">
                        Delete “{r.name}”?
                        <button type="button" className="rounded bg-red-700 px-2 py-1 font-semibold text-white" onClick={() => { removeRoute(doc, r.id); setConfirmDelete(null); }}>
                          Delete
                        </button>
                        <button type="button" className="rounded px-2 py-1 hover:bg-soft" onClick={() => setConfirmDelete(null)}>
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="rounded px-2 py-1 text-xs hover:bg-soft" onClick={() => setConfirmDelete(r.id)}>
                        Delete
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {names && checks.length > 0 && <FitChecksList checks={checks} names={names} allClear="" title="Checks" />}
    </div>
  );
}
