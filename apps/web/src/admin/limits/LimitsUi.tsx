// Admin UI for usage limits: the "Heavy use" tab (top people and clubs,
// with flags), one person's or club's usage against limits with
// overrides and read-only, and the global limits form in Settings.

import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, LineChart, SERIES_STYLE } from '../insights/charts';
import { formatBytes, formatDate } from '../insights/format';
import { describeEvent, formatLimit, limitsApi, toInput, toStored, type AbuseRow, type GlobalLimit, type LimitUnit, type SubjectLimit } from './limitsApi';
import { api } from '../../api';
import { HelpButton } from '../../help/HelpButton';
import type { WebOnlyHelpKey } from '../../help/webOnlyHelpTexts';

// ---------------------------------------------------------------------------
// Heavy use: top people and clubs
// ---------------------------------------------------------------------------

const SORTS: { id: string; label: string; clubsOnly?: boolean }[] = [
  { id: 'storageBytes', label: 'Space used' },
  { id: 'layouts', label: 'Layouts' },
  { id: 'customParts', label: 'Custom parts' },
  { id: 'modules', label: 'Modules' },
  { id: 'rooms', label: 'Venues' },
  { id: 'submissions', label: 'Catalog submissions' },
  { id: 'uploads1d', label: 'Uploads today' },
  { id: 'uploads7d', label: 'Uploads, 7 days' },
  { id: 'requests1d', label: 'Requests today' },
  { id: 'refused7d', label: 'Refused, 7 days' },
  { id: 'shareViews7d', label: 'Share views, 7 days' },
  { id: 'live', label: 'Live now' },
  { id: 'members', label: 'Members', clubsOnly: true },
];

function Trend({ now, before, label }: { now: number; before: number; label: string }) {
  if (now === before) return null;
  const up = now > before;
  return (
    <span className="ml-1 text-xs text-muted" title={`${label}: ${before}`}>
      <span aria-hidden>{up ? '▲' : '▼'}</span>
      <span className="sr-only">
        {up ? 'up' : 'down'} from {before} {label}
      </span>
    </span>
  );
}

export function HeavyUseTab({ onOpen }: { onOpen: (kind: 'user' | 'org', id: string) => void }) {
  return (
    <div className="space-y-8">
      <style>{SERIES_STYLE}</style>
      <p className="max-w-3xl text-sm text-muted">
        Who uses the most. A <span className="font-medium text-ink">⚑ flag</span> means far above the usual (over 10× the middle value) or at 80% of a
        limit. Open a person or club to see their use against limits, change their limits or make them read-only.
      </p>
      <AbuseTable kind="users" onOpen={(id) => onOpen('user', id)} />
      <AbuseTable kind="clubs" onOpen={(id) => onOpen('org', id)} />
    </div>
  );
}

function AbuseTable({ kind, onOpen }: { kind: 'users' | 'clubs'; onOpen: (id: string) => void }) {
  const [sort, setSort] = useState('storageBytes');
  const list = useQuery({ queryKey: ['admin-abuse', kind, sort], queryFn: () => limitsApi.abuse(kind, sort) });
  const title = kind === 'users' ? 'Top people' : 'Top clubs';
  const sorts = SORTS.filter((s) => kind === 'clubs' || !s.clubsOnly);
  const head = (id: string, label: string) => (
    <button
      type="button"
      onClick={() => setSort(id)}
      aria-pressed={sort === id}
      className={'min-h-9 whitespace-nowrap text-right ' + (sort === id ? 'font-semibold text-ink' : 'text-muted hover:text-ink')}
    >
      {label}
      {sort === id && <span aria-hidden> ▾</span>}
    </button>
  );
  const rows = list.data?.rows ?? [];
  return (
    <section aria-labelledby={`abuse-${kind}`} className="rounded-xl border border-line bg-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`abuse-${kind}`} className="text-base font-semibold text-ink">
          {title}
          {list.data && (
            <span className="ml-2 text-sm font-normal text-muted">
              {list.data.flagged > 0 ? `${list.data.flagged} flagged of ${list.data.total}` : `none flagged of ${list.data.total}`}
            </span>
          )}
        </h2>
        <label className="flex items-center gap-2 text-sm text-muted">
          Sort by
          <select value={sort} onChange={(e) => setSort(e.target.value)} className="min-h-11 rounded-lg border border-line bg-panel px-2 text-ink sm:min-h-9">
            {sorts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {list.isLoading ? (
        <p className="mt-3 text-sm text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted">Nothing yet.</p>
      ) : (
        <>
          {/* Phone: cards. */}
          <ul className="mt-3 space-y-2 xl:hidden">
            {rows.map((r) => (
              <li key={r.id} className="rounded-lg border border-line p-3">
                <button type="button" onClick={() => onOpen(r.id)} className="min-h-11 text-left font-medium text-accent-text hover:underline">
                  {r.name}
                </button>
                {r.email && <p className="break-all text-xs text-muted">{r.email}</p>}
                <Flags row={r} />
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                  <Pair term="Space" value={formatBytes(r.storageBytes)} />
                  <Pair term="Layouts" value={String(r.layouts)} />
                  <Pair term="Uploads, 7 days" value={String(r.uploads7d)} />
                  <Pair term="Requests today" value={String(r.requests1d)} />
                  <Pair term="Refused, 7 days" value={String(r.refused7d)} />
                  <Pair term="Live now" value={String(r.live)} />
                  {r.members !== undefined && <Pair term="Members" value={String(r.members)} />}
                </dl>
              </li>
            ))}
          </ul>
          {/* Computer: a table. */}
          <div className="mt-3 hidden overflow-x-auto xl:block">
            <table className="w-full text-sm">
              <thead className="text-xs">
                <tr className="text-left text-muted">
                  <th scope="col" className="px-2 py-1.5 font-medium">{kind === 'users' ? 'Person' : 'Club'}</th>
                  {kind === 'clubs' && <th scope="col" className="px-2 py-1.5 text-right">{head('members', 'Members')}</th>}
                  <th scope="col" className="px-2 py-1.5 text-right">{head('storageBytes', 'Space')}</th>
                  <th scope="col" className="px-2 py-1.5 text-right">{head('layouts', 'Layouts')}</th>
                  <th scope="col" className="px-2 py-1.5 text-right">{head('customParts', 'Parts')}</th>
                  <th scope="col" className="px-2 py-1.5 text-right">{head('modules', 'Modules')}</th>
                  <th scope="col" className="px-2 py-1.5 text-right">{head('rooms', 'Venues')}</th>
                  <th scope="col" className="px-2 py-1.5 text-right">{head('submissions', 'Shared')}</th>
                  <th scope="col" className="px-2 py-1.5 text-right">{head('uploads7d', 'Uploads 7d')}</th>
                  <th scope="col" className="px-2 py-1.5 text-right">{head('requests1d', 'Requests today')}</th>
                  <th scope="col" className="px-2 py-1.5 text-right">{head('refused7d', 'Refused 7d')}</th>
                  <th scope="col" className="px-2 py-1.5 text-right">{head('shareViews7d', 'Share views')}</th>
                  <th scope="col" className="px-2 py-1.5 text-right">{head('live', 'Live')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-line align-top">
                    <td className="max-w-64 px-2 py-1.5">
                      <button type="button" onClick={() => onOpen(r.id)} className="text-left text-accent-text hover:underline">
                        {r.name}
                      </button>
                      {r.email && <span className="block truncate text-xs text-muted">{r.email}</span>}
                      <Flags row={r} />
                    </td>
                    {kind === 'clubs' && <Num>{r.members ?? 0}</Num>}
                    <Num>{formatBytes(r.storageBytes)}</Num>
                    <Num>{r.layouts}</Num>
                    <Num>{r.customParts}</Num>
                    <Num>{r.modules}</Num>
                    <Num>{r.rooms}</Num>
                    <Num>{r.submissions ?? 0}</Num>
                    <Num>
                      {r.uploads7d}
                      <Trend now={r.uploads7d} before={r.uploadsPrev7d} label="the week before" />
                    </Num>
                    <Num>
                      {r.requests1d}
                      <Trend now={r.requests1d} before={r.requestsPrev1d} label="yesterday" />
                    </Num>
                    <Num>{r.refused7d}</Num>
                    <Num>{r.shareViews7d}</Num>
                    <Num>{r.live}</Num>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function Num({ children }: { children: ReactNode }) {
  return <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{children}</td>;
}

function Pair({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{term}</dt>
      <dd className="tabular-nums text-ink">{value}</dd>
    </div>
  );
}

function Flags({ row }: { row: AbuseRow }) {
  if (row.flags.length === 0 && !row.suspended) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {row.suspended && <span className="rounded-md bg-soft px-1.5 py-0.5 text-xs text-ink">🔒 Read-only</span>}
      {row.flags.map((f) => (
        <span key={f} className="rounded-md bg-accent-soft px-1.5 py-0.5 text-xs text-accent-text">
          <span aria-hidden>⚑ </span>
          {f}
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// One person or club: usage against limits, overrides, read-only, activity
// ---------------------------------------------------------------------------

export function SubjectLimitsPanel({ kind, id }: { kind: 'user' | 'org'; id: string }) {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['admin-usage', kind, id], queryFn: () => limitsApi.usage(kind, id) });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Parameters<typeof limitsApi.putLimits>[2]) => limitsApi.putLimits(kind, id, body),
    onSuccess: () => {
      setStatus('Saved.');
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ['admin-usage', kind, id] });
      void qc.invalidateQueries({ queryKey: ['admin-abuse'] });
    },
    onError: (e: Error) => setStatus(e.message),
  });
  if (data.isLoading) return <p className="text-sm text-muted">Loading use and limits…</p>;
  if (!data.data) return <p className="text-sm text-muted">Couldn’t load use and limits.</p>;
  const d = data.data;
  const who = kind === 'user' ? 'This person' : 'This club';

  const startEdit = () => {
    const next: Record<string, string> = {};
    for (const l of d.limits) next[l.key] = d.override.limits[l.key] !== undefined ? toInput(d.override.limits[l.key]!, l.unit) : '';
    setDraft(next);
    setEditing(true);
    setStatus(null);
  };
  const submit = () => {
    const limits: Record<string, number | null> = {};
    for (const l of d.limits) {
      const v = toStored(draft[l.key] ?? '', l.unit);
      if (Number.isNaN(v)) {
        setStatus(`“${l.label}” needs a number of 0 or more.`);
        return;
      }
      limits[l.key] = v;
    }
    save.mutate({ limits });
  };

  return (
    <div className="space-y-4">
      <style>{SERIES_STYLE}</style>
      <section aria-labelledby={`ro-${id}`} className="rounded-xl border border-line bg-panel p-4">
        <div className="flex items-center gap-1">
          <h3 id={`ro-${id}`} className="text-sm font-semibold text-ink">
            {d.override.suspended ? '🔒 Read-only' : 'Read-only'}
          </h3>
          <HelpButton helpKey="admin.readOnly" target={`[aria-labelledby="ro-${id}"]`} />
        </div>
        {d.override.suspended ? (
          <>
            <p className="mt-1 text-sm text-ink">
              {who} can look at and delete things, but can’t add or change anything.
              {d.override.reason ? ` Reason: ${d.override.reason}` : ''}
            </p>
            <button
              type="button"
              onClick={() => save.mutate({ suspended: false })}
              className="mt-2 min-h-11 rounded-lg border border-line px-3 text-sm hover:bg-soft sm:min-h-9"
            >
              Lift read-only
            </button>
          </>
        ) : (
          <>
            <p className="mt-1 text-sm text-muted">
              Make {kind === 'user' ? 'this account' : 'this club'} read-only while you look into something. Nothing is deleted; it can be lifted any time. It holds even while usage limits are off.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor={`reason-${id}`}>
                Reason (optional)
              </label>
              <input
                id={`reason-${id}`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason (optional)"
                className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-panel px-3 text-sm sm:min-h-9"
              />
              <button
                type="button"
                onClick={() => save.mutate({ suspended: true, reason: reason || null })}
                className="min-h-11 rounded-lg bg-accent px-3 text-sm font-medium text-accent-ink hover:bg-accent-hover sm:min-h-9"
              >
                Make read-only
              </button>
            </div>
          </>
        )}
      </section>

      <section aria-labelledby={`lim-${id}`} className="rounded-xl border border-line bg-panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`lim-${id}`} className="text-sm font-semibold text-ink">
            Use and limits
          </h3>
          {!editing && (
            <button type="button" onClick={startEdit} className="min-h-11 rounded-lg border border-line px-3 text-sm hover:bg-soft sm:min-h-9">
              Change limits
            </button>
          )}
        </div>
        {status && (
          <p role="status" className="mt-1 text-sm text-ink">
            {status}
          </p>
        )}
        <ul className="mt-3 space-y-3">
          {d.limits.map((l) => (
            <LimitRow key={l.key} l={l} editing={editing} value={draft[l.key] ?? ''} onChange={(v) => setDraft({ ...draft, [l.key]: v })} />
          ))}
        </ul>
        {editing && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={submit} disabled={save.isPending} className="min-h-11 rounded-lg bg-accent px-3 text-sm font-medium text-accent-ink hover:bg-accent-hover disabled:opacity-50 sm:min-h-9">
              Save limits
            </button>
            <button type="button" onClick={() => setEditing(false)} className="min-h-11 rounded-lg border border-line px-3 text-sm hover:bg-soft sm:min-h-9">
              Cancel
            </button>
            <p className="w-full text-xs text-muted">Leave a box empty to use the site-wide value. Sizes are in MB.</p>
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <LineChart title="Requests per day" values={d.series.requests} starts={d.series.days} bucket="day" />
        <LineChart title="Uploads per day" values={d.series.uploads} starts={d.series.days} bucket="day" />
        <LineChart title="Refused requests per day" values={d.series.refused} starts={d.series.days} bucket="day" />
        <LineChart title="Share link views per day" values={d.series.share_views} starts={d.series.days} bucket="day" />
      </div>

      <Card title="Recent activity">
        {d.activity.length === 0 ? (
          <p className="text-sm text-muted">Nothing recorded yet.</p>
        ) : (
          <ol className="space-y-1.5 text-sm">
            {d.activity.map((e) => (
              <li key={e.id} className="flex flex-wrap gap-x-2">
                <time className="w-24 shrink-0 text-muted tabular-nums" dateTime={new Date(e.at).toISOString()}>
                  {formatDate(e.at)}
                </time>
                <span className="min-w-0 break-words text-ink">{describeEvent(e)}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

function LimitRow({ l, editing, value, onChange }: { l: SubjectLimit; editing: boolean; value: string; onChange: (v: string) => void }) {
  const pct = l.used !== null && l.value > 0 ? Math.min(100, Math.round((l.used / l.value) * 100)) : null;
  const tone = pct === null ? 'var(--series-1)' : pct >= 100 ? 'var(--danger)' : pct >= 80 ? '#c98500' : 'var(--series-1)';
  const inputId = `lim-${l.key}`;
  return (
    <li className="cld-viz text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-ink">
          {l.label}
          {l.source !== 'default' && (
            <span className="ml-2 rounded-md bg-soft px-1.5 py-0.5 text-xs text-muted" title={l.reason ?? undefined}>
              {l.source === 'override' ? 'Set for them' : `Automatic: ${l.reason ?? ''}`}
            </span>
          )}
        </span>
        <span className="text-muted tabular-nums">
          {l.used !== null ? `${formatValue(l.used, l.unit)} of ` : ''}
          {formatLimit(l.value, l.unit)}
          {pct !== null && pct >= 80 && <span aria-hidden> ⚠</span>}
        </span>
      </div>
      {pct !== null && (
        <div className="mt-1 h-2 rounded-full bg-soft" role="meter" aria-label={l.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div className="h-2 rounded-full" style={{ width: `${Math.max(1, pct)}%`, background: tone }} />
        </div>
      )}
      <p className="mt-0.5 text-xs text-muted">{l.help}</p>
      {editing && (
        <div className="mt-1 flex items-center gap-2">
          <label htmlFor={inputId} className="text-xs text-muted">
            Their limit{l.unit === 'bytes' ? ' (MB)' : ''}
          </label>
          <input
            id={inputId}
            inputMode="numeric"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="site-wide"
            className="min-h-11 w-32 rounded-lg border border-line bg-panel px-2 text-sm sm:min-h-9"
          />
        </div>
      )}
    </li>
  );
}

function formatValue(n: number, unit: LimitUnit): string {
  return unit === 'bytes' ? formatBytes(n) : n.toLocaleString('en-US');
}

// ---------------------------------------------------------------------------
// Settings: site-wide limits
// ---------------------------------------------------------------------------

export function GlobalLimitsForm() {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['admin-limits'], queryFn: limitsApi.global });
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: limitsApi.patchGlobal,
    onSuccess: () => {
      setStatus('Saved. New limits apply right away; nothing already stored is removed.');
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ['admin-limits'] });
    },
    onError: (e: Error) => setStatus(e.message),
  });
  if (data.isLoading) return <p className="text-sm text-muted">Loading limits…</p>;
  if (!data.data) return null;
  const limits = data.data.limits;
  const values = draft ?? Object.fromEntries(limits.map((l) => [l.key, toInput(l.value, l.unit)]));
  const submit = () => {
    const patch: Record<string, number | null> = {};
    for (const l of limits) {
      const v = toStored(values[l.key] ?? '', l.unit);
      if (Number.isNaN(v)) {
        setStatus(`“${l.label}” needs a number of 0 or more.`);
        return;
      }
      if (v === null || v === l.default) {
        if (l.changedHere) patch[l.key] = null;
      } else if (v !== l.value || l.changedHere) patch[l.key] = v;
    }
    if (Object.keys(patch).length === 0) {
      setStatus('Nothing changed.');
      return;
    }
    save.mutate(patch);
  };
  return (
    <section aria-labelledby="global-limits" className="space-y-3">
      <div>
        <h2 id="global-limits" className="text-base font-semibold text-ink">
          Usage limits
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          These apply to everyone unless you set something else for one person or club (Heavy use tab). Limits only stop new growth: nothing
          already stored is removed, and people can always open and delete their things. Sizes are in MB. Empty a box to go back to the
          server’s default.
        </p>
      </div>
      <EnforceSwitch
        enforced={data.data?.enforced ?? true}
        setting={data.data?.enforcedSetting ?? true}
        source={data.data?.enforcementSource ?? 'setting'}
      />
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {limits.map((l) => (
          <GlobalRow key={l.key} l={l} value={values[l.key] ?? ''} onChange={(v) => setDraft({ ...values, [l.key]: v })} />
        ))}
      </ul>
      {status && (
        <p role="status" className="text-sm text-ink">
          {status}
        </p>
      )}
      <button type="button" onClick={submit} disabled={save.isPending} className="min-h-11 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink hover:bg-accent-hover disabled:opacity-50 sm:min-h-9">
        Save limits
      </button>
    </section>
  );
}

/** Limits whose one line of help needs more: their ⓘ. */
const LIMIT_HELP: Partial<Record<string, WebOnlyHelpKey>> = {
  inviteEmailsPerDay: 'admin.inviteEmails',
  newAccountInviteEmailsPerDay: 'admin.inviteEmails',
};

function GlobalRow({ l, value, onChange }: { l: GlobalLimit; value: string; onChange: (v: string) => void }) {
  const id = `glim-${l.key}`;
  const origin = l.changedHere ? 'Changed here' : l.fromEnv ? `From ${l.envVar}` : 'Default';
  return (
    <li className="rounded-xl border border-line bg-panel p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="inline-flex items-center gap-1">
          <label htmlFor={id} className="text-sm font-medium text-ink">
            {l.label}
            {l.unit === 'bytes' ? ' (MB)' : ''}
          </label>
          {LIMIT_HELP[l.key] && <HelpButton helpKey={LIMIT_HELP[l.key]!} target={`#${id}`} />}
        </span>
        <span className="rounded-md bg-soft px-1.5 py-0.5 text-xs text-muted">{origin}</span>
      </div>
      <p className="mt-0.5 text-xs text-muted">{l.help}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          id={id}
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={toInput(l.default, l.unit)}
          className="min-h-11 w-36 rounded-lg border border-line bg-panel px-2 text-sm sm:min-h-9"
        />
        <span className="text-xs text-muted">Server default: {formatLimit(l.default, l.unit)}</span>
      </div>
    </li>
  );
}

/**
 * "Enforce usage limits": on refuses growth past a limit; off still counts
 * use (Heavy use) but refuses no limit. Read-only holds either way. Takes effect at once. The server's
 * LIMITS_ENFORCE, when set, wins, and the switch says so.
 */
function EnforceSwitch({ enforced, setting, source }: { enforced: boolean; setting: boolean; source: 'setting' | 'forced-on' | 'forced-off' }) {
  const qc = useQueryClient();
  const forced = source !== 'setting';
  const save = useMutation({
    mutationFn: (on: boolean) => api.admin.patchSettings({ limitsEnforced: on }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-limits'] }),
  });
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-card border border-line bg-soft p-3" data-testid="limits-switch">
      <div className="min-w-0 text-sm">
        <p className="font-semibold text-ink">Enforce usage limits</p>
        <p className="text-muted" role="status" data-testid={enforced ? 'limits-on' : 'limits-off'}>
          {enforced
            ? 'On: growth past a limit is refused with a plain message. People can always open and delete their things.'
            : 'Off: use is counted and shown on the Heavy use tab, but no limit is refused. Read-only accounts and clubs stay read-only.'}
        </p>
        {forced && (
          <p className="mt-1 text-muted" data-testid="limits-forced">
            {source === 'forced-on' ? 'Forced on' : 'Forced off'} by the server setting <code>LIMITS_ENFORCE</code>. Remove it from the
            server to control this here.
          </p>
        )}
        {save.isError && <p className="mt-1 text-danger">{(save.error as Error).message}</p>}
      </div>
      <label className="inline-flex items-center gap-2 text-sm font-semibold">
        <input
          type="checkbox"
          role="switch"
          aria-label="Enforce usage limits"
          checked={forced ? enforced : setting}
          disabled={forced || save.isPending}
          onChange={(e) => save.mutate(e.target.checked)}
          className="size-5 accent-accent"
        />
        {forced ? (enforced ? 'On' : 'Off') : setting ? 'On' : 'Off'}
      </label>
    </div>
  );
}

