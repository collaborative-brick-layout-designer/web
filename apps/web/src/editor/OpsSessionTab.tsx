// The Live Ops panel's Session tab (Live Ops design 4, 6): start a session,
// give people their roles, pause and end it, send jobs out and mark them
// done (the dispatcher's board), the next session, and past sessions with
// their log. While a session runs the map's sheets are locked and each
// person moves only what their role reaches; the server holds everyone to
// the same (apps/server/src/ws/opsGuard.ts). The desktop's
// ui/OpsSessionTab.cpp is the twin.

import { useState } from 'react';
import type * as Y from 'yjs';
import { useQuery } from '@tanstack/react-query';
import { CREW_ROLES, sessionSummary, type CrewMember, type CrewRole, type OpsSession } from '@cld/parts-catalog/browser';
import { api } from '../api';
import { HelpButton } from '../help/HelpButton';
import { confirmDelete } from '../ui/ConfirmDialog';
import { placeName, type OpsView } from './ops';
import { bannerText, crewMember, endSession, newSession, nextSession, pauseSession, roleName, setJobStatus, setSession, startSession, type SessionState } from './sessions';
import { useEditorStore } from './editorStore';

const btn = 'rounded border border-border px-2 py-1 text-xs hover:bg-soft disabled:opacity-50';
const primary = 'h-9 rounded-control bg-accent px-3 text-xs font-bold text-accent-ink hover:bg-accent-hover disabled:opacity-50';
const field = 'w-full rounded border border-border bg-bg px-2 py-1 text-sm font-normal disabled:opacity-70';
const card = 'rounded-card border border-line bg-panel p-2';

export const ROLE_HINT: Record<CrewRole, string> = {
  dispatcher: 'Sends jobs out, marks them done, and sets any switch.',
  yardmaster: 'Moves the cars in their yards and sets the yard’s switches.',
  crew: 'Moves their job’s train and the cars at its stops, once the job is out.',
};

const JOB_STATUS_LABEL: Record<string, string> = { waiting: 'Waiting', out: 'Out', done: 'Done' };

interface Props {
  doc: Y.Doc;
  view: OpsView;
  state: SessionState;
  /** Owners and editors set sessions up; viewers see them. */
  canEdit: boolean;
  userId: string;
  layoutId: string;
  touch: boolean;
}

export function OpsSessionTab({ doc, view, state, canEdit, userId, layoutId, touch }: Props) {
  const s = state.current;
  const [ending, setEnding] = useState(false);
  const tall = touch ? ' min-h-11' : '';
  const hostish = state.reach.role === 'host' || (canEdit && !state.running);
  const board = state.reach.role === 'host' || state.reach.role === 'dispatcher';
  const say = (t: string) => useEditorStore.getState().showStatusMessage(t, 5000);

  if (!s) {
    return (
      <div className="flex flex-col items-start gap-2" data-testid="ops-session-none">
        <p className="text-muted">
          A session is one evening of operating: people get roles (dispatcher, yardmaster, crews), jobs go out, and each person moves the cars their role allows. While it runs, the track is locked.
        </p>
        {view.places.length === 0 && <p className="text-muted">Tag a place first (an industry or a yard) so cars have somewhere to go.</p>}
        {canEdit ? (
          <div className="flex items-center gap-2">
            <button type="button" className={primary + tall} data-testid="ops-session-new" onClick={() => newSession(doc)}>
              Start your first session
            </button>
            <HelpButton helpKey="ops.session" />
          </div>
        ) : (
          <p className="text-muted">The layout’s owner or an editor sets up sessions.</p>
        )}
        <Past state={state} view={view} />
      </div>
    );
  }

  const summary = sessionSummary(s.id, state.log, view.jobs.map((j) => ({ ...j, status: (j as { status?: unknown }).status })));
  return (
    <div className="flex flex-col gap-2" data-testid="ops-session">
      <div className={card + ' flex flex-col gap-1.5'}>
        <div className="flex items-center gap-2">
          <input
            aria-label="Session name"
            className={field + ' font-semibold'}
            value={s.name}
            maxLength={80}
            readOnly={!canEdit || s.status === 'running'}
            onChange={(e) => setSession(doc, s.id, { name: e.target.value })}
          />
          <HelpButton helpKey="ops.session" />
        </div>
        <p className="text-xs" data-testid="ops-session-status">
          {s.status === 'running' ? bannerText(state) : s.status === 'paused' ? 'Paused: the track can be changed. Carry on when you’re ready.' : 'Being set up: give people their roles, then start.'}
        </p>
        {s.status === 'running' && state.reach.why && <p className="text-xs text-muted">{state.reach.why}</p>}
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            {s.status !== 'running' && (
              <button
                type="button"
                className={primary + tall}
                data-testid="ops-session-start"
                onClick={() => {
                  const why = startSession(doc, s.id, userId, layoutId);
                  if (why) say(why);
                }}
              >
                {s.status === 'paused' ? 'Carry on' : 'Start the session'}
              </button>
            )}
            {s.status === 'running' && state.reach.role === 'host' && (
              <button type="button" className={btn + tall} data-testid="ops-session-pause" onClick={() => pauseSession(doc, s.id, userId)}>
                Pause (to change the track)
              </button>
            )}
            {(s.status !== 'running' || state.reach.role === 'host') && s.status !== 'setup' && (
              <button type="button" className={btn + tall} data-testid="ops-session-end" onClick={() => setEnding(true)}>
                End the session
              </button>
            )}
          </div>
        )}
        {ending && (
          <div className={card + ' flex flex-col gap-1.5 border-accent'} role="dialog" aria-label="End the session" data-testid="ops-end-dialog">
            <p className="font-semibold">End “{s.name}”?</p>
            <p className="text-xs">
              {summary.moves === 1 ? '1 move' : `${summary.moves} moves`} made, {summary.cuts === 1 ? '1 cut moved' : `${summary.cuts} cuts moved`}, {summary.jobsLeft.length === 0 ? 'every job done' : `${summary.jobsLeft.length} jobs not done`}.
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={primary + tall} data-testid="ops-end-leave" onClick={() => { endSession(doc, s.id, userId, false); setEnding(false); }}>
                Leave the cars where they are
              </button>
              <button type="button" className={btn + tall} data-testid="ops-end-back" disabled={!s.start} onClick={() => { endSession(doc, s.id, userId, true); setEnding(false); }}>
                Put every car back where this session started
              </button>
              <button type="button" className={btn + tall} onClick={() => setEnding(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <Crew doc={doc} view={view} s={s} canEdit={canEdit && hostish && s.status !== 'running'} layoutId={layoutId} touch={touch} />

      <div className={card + ' flex flex-col gap-1'}>
        <h3 className="flex items-center gap-1 text-xs font-bold uppercase text-muted">
          Job board <HelpButton helpKey="ops.job" />
        </h3>
        {view.jobs.length === 0 && <p className="text-xs text-muted">No jobs yet: make them on the Jobs tab.</p>}
        <ul className="flex flex-col gap-1" aria-label="Job board">
          {view.jobs.map((j) => {
            const st = (j as { status?: string }).status ?? 'waiting';
            const status = st === 'out' || st === 'done' ? st : 'waiting';
            return (
              <li key={j.id} className="flex items-center gap-2" data-board-job={j.id}>
                <span className="min-w-0 flex-1 truncate">{j.name || 'A job'}</span>
                <span className="text-xs text-muted" data-testid="ops-board-status">{JOB_STATUS_LABEL[status]}</span>
                {board && canEdit && s.status === 'running' && status !== 'out' && status !== 'done' && (
                  <button type="button" className={btn + tall} onClick={() => setJobStatus(doc, j.id, 'out', s.id, userId)}>Send out</button>
                )}
                {board && canEdit && s.status === 'running' && status === 'out' && (
                  <button type="button" className={btn + tall} onClick={() => setJobStatus(doc, j.id, 'done', s.id, userId)}>Done</button>
                )}
              </li>
            );
          })}
        </ul>
        {board && !canEdit && <p className="text-xs text-muted">Ask the host to send jobs out: a dispatcher who views the layout sets switches and moves cars, but jobs are the host’s.</p>}
      </div>
      <Past state={state} view={view} onNext={canEdit && !state.running && s.status === 'ended' ? (p) => nextSession(doc, p) : undefined} />
    </div>
  );
}

function Crew({ doc, view, s, canEdit, layoutId, touch }: { doc: Y.Doc; view: OpsView; s: OpsSession; canEdit: boolean; layoutId: string; touch: boolean }) {
  const people = useQuery({ queryKey: ['collaborators', layoutId], queryFn: () => api.collaborators.list(layoutId), enabled: canEdit, staleTime: 60_000 });
  const [pick, setPick] = useState('');
  const tall = touch ? ' min-h-11' : '';
  const yards = view.places.filter((p) => p.place.kind === 'yard');
  const put = (crew: CrewMember[]) => setSession(doc, s.id, { crew });
  const change = (i: number, c: Partial<CrewMember>) => put(s.crew.map((x, k) => (k === i ? { ...x, ...c } : x)));
  const candidates = (people.data?.collaborators ?? []).filter((c) => !s.crew.some((x) => x.userId === c.userId));
  return (
    <div className={card + ' flex flex-col gap-1.5'}>
      <h3 className="flex items-center gap-1 text-xs font-bold uppercase text-muted">
        Crew <HelpButton helpKey="ops.crew" /> <HelpButton helpKey="ops.roles" />
      </h3>
      {s.crew.length === 0 && <p className="text-xs text-muted">Nobody has a role yet. People who only view the layout can still be crew: they move just what their role allows.</p>}
      <ul className="flex flex-col gap-1.5" aria-label="Crew">
        {s.crew.map((c, i) => (
          <li key={`${c.userId}-${i}`} className="flex flex-wrap items-center gap-1.5" data-crew={c.userId || c.name}>
            <span className="min-w-0 flex-1 truncate font-semibold">{c.name || 'Someone'}{c.userId === '' ? ' (on this device)' : ''}</span>
            <select aria-label={`${c.name}’s role`} className={field + ' w-auto' + tall} value={c.role} disabled={!canEdit} onChange={(e) => change(i, { role: e.target.value as CrewRole })} title={ROLE_HINT[c.role]}>
              {CREW_ROLES.map((r) => (
                <option key={r} value={r}>{roleName(r)}</option>
              ))}
            </select>
            {c.role === 'crew' && (
              <select aria-label={`${c.name}’s job`} className={field + ' w-auto' + tall} value={c.job} disabled={!canEdit} onChange={(e) => change(i, { job: e.target.value })}>
                <option value="">No job yet</option>
                {view.jobs.map((j) => (
                  <option key={j.id} value={j.id}>{j.name || 'A job'}</option>
                ))}
              </select>
            )}
            {c.role === 'yardmaster' && (
              <select aria-label={`${c.name}’s yard`} className={field + ' w-auto' + tall} value={c.places[0] ?? ''} disabled={!canEdit} onChange={(e) => change(i, { places: e.target.value ? [e.target.value] : [] })}>
                <option value="">No yard yet</option>
                {yards.map((y) => (
                  <option key={y.id} value={y.id}>{placeName(view, y.id)}</option>
                ))}
              </select>
            )}
            {canEdit && (
              <button type="button" className={btn + tall} aria-label={`Take ${c.name} off the crew`} onClick={async () => {
                if (await confirmDelete(c.name || 'this person', { removes: `${c.name || 'They'} come off this session’s crew.`, keeps: 'They keep their access to the layout.', undoable: true, confirmLabel: 'Remove' })) put(s.crew.filter((_, k) => k !== i));
              }}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-1.5">
          <select aria-label="Add someone to the crew" className={field + ' w-auto flex-1' + tall} value={pick} onChange={(e) => setPick(e.target.value)} data-testid="ops-crew-pick">
            <option value="">Add someone…</option>
            {candidates.map((c) => (
              <option key={c.userId} value={c.userId}>{c.displayName}</option>
            ))}
            <option value="guest">A guest on this device</option>
          </select>
          <button
            type="button"
            className={btn + tall}
            disabled={pick === ''}
            data-testid="ops-crew-add"
            onClick={() => {
              const c = candidates.find((x) => x.userId === pick);
              put([...s.crew, pick === 'guest' ? crewMember('', `Guest ${s.crew.filter((x) => x.userId === '').length + 1}`, 'crew') : crewMember(pick, c?.displayName ?? 'Someone', 'crew')]);
              setPick('');
            }}
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}

function Past({ state, view, onNext }: { state: SessionState; view: OpsView; onNext?: ((s: OpsSession) => void) | undefined }) {
  const [open, setOpen] = useState<string | null>(null);
  if (state.past.length === 0) return null;
  return (
    <div className={card + ' flex flex-col gap-1'}>
      <h3 className="text-xs font-bold uppercase text-muted">Past sessions</h3>
      <ul className="flex flex-col gap-1" aria-label="Past sessions">
        {state.past.map((p) => {
          const log = state.log.filter((e) => e.session === p.id);
          return (
            <li key={p.id} className="flex flex-col gap-0.5" data-past={p.id}>
              <div className="flex items-center gap-2">
                <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => setOpen(open === p.id ? null : p.id)}>
                  {p.name} · {log.filter((e) => e.kind === 'move').length} moves
                </button>
                {onNext && p === state.past[0] && (
                  <button type="button" className={btn} data-testid="ops-session-next" onClick={() => onNext(p)}>
                    Next session
                  </button>
                )}
              </div>
              {open === p.id && (
                <ol className="max-h-48 overflow-y-auto text-xs text-muted" aria-label={`${p.name}’s log`}>
                  {log.map((e) => (
                    <li key={e.id}>{logLine(view, p, e)}</li>
                  ))}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function logLine(view: OpsView, s: OpsSession, e: { at: number; by: string; kind: string; what: string; to: unknown }): string {
  const who = s.crew.find((c) => c.userId === e.by)?.name || (e.by === s.host ? 'The host' : 'Someone');
  const when = new Date(e.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (e.kind === 'move') return `${when} ${who} moved ${view.trains.find((t) => t.id === e.what)?.name || 'a cut'}`;
  if (e.kind === 'switch') return `${when} ${who} set a switch`;
  if (e.kind === 'job') return `${when} ${who}: ${view.jobs.find((j) => j.id === e.what)?.name || 'a job'} ${String(e.to)}`;
  return `${when} ${who}: the session ${String(e.to)}`;
}
