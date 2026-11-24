// Admin › Backups › Version history: the switch for keeping earlier versions
// of every layout, how often one is kept while people edit, what counts as
// a big delete, how long versions are kept, and how many of the hand-made,
// before-restore and uploaded backups are kept. Every number is here; an
// env var that forces the switch is named instead. Server: history/settings.ts.

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend } from '../../api';
import { HelpButton } from '../../help/HelpButton';

interface Limit {
  key: string;
  label: string;
  help: string;
  group: 'versions' | 'keep' | 'backups';
  min: number;
  max: number;
  unit: string;
  value: number;
  builtIn: number;
}
export interface AdminVersionHistory {
  enabled: boolean;
  enabledSetting: boolean;
  enabledForcedBy: string | null;
  limits: Limit[];
}

const btn = 'tap-target rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-soft disabled:opacity-50';

export function VersionHistorySettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-version-history'], queryFn: () => apiGet<AdminVersionHistory>('/api/admin/version-history') });
  const [err, setErr] = useState('');
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiSend<AdminVersionHistory>('PATCH', '/api/admin/version-history', body),
    onSuccess: (v) => {
      setErr('');
      qc.setQueryData(['admin-version-history'], v);
      void qc.invalidateQueries({ queryKey: ['version-history-status'] });
    },
    onError: (e: Error) => setErr(e.message),
  });
  if (!q.data) return q.error ? <p className="text-sm text-danger">{(q.error as Error).message}</p> : null;
  const d = q.data;
  const group = (g: Limit['group']) => (
    <div className="grid gap-3 sm:grid-cols-2">
      {d.limits
        .filter((l) => l.group === g)
        .map((l) => (
          <NumberSetting key={l.key} limit={l} disabled={patch.isPending} onSave={(v) => patch.mutate({ limits: { [l.key]: v } })} />
        ))}
    </div>
  );
  return (
    <section className="space-y-4 rounded-lg border border-line p-4" aria-labelledby="history-settings" data-testid="admin-version-history">
      <h3 id="history-settings" className="flex items-center gap-1 text-sm font-semibold">
        Version history <HelpButton helpKey="admin.versionHistory" />
      </h3>
      <p className="text-sm text-muted">
        The site keeps earlier versions of every layout, so people can look at one, put it back or copy it out as a new layout. Switched off, nothing new is kept and the versions already kept can still be looked at and copied out.
      </p>
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={d.enabled}
            disabled={!!d.enabledForcedBy || patch.isPending}
            onChange={(e) => patch.mutate({ enabled: e.target.checked })}
            data-testid="admin-version-history-enabled"
          />
          Keep earlier versions of layouts
        </label>
        {d.enabledForcedBy && (
          <p className="text-xs text-muted" data-testid="admin-version-history-forced">
            Set by <code>{d.enabledForcedBy}</code> on the server, so it can’t be changed here: change or remove that setting on the server.
          </p>
        )}
      </div>
      <div className="space-y-2">
        <h4 className="text-sm font-medium">When one is kept</h4>
        {group('versions')}
      </div>
      <div className="space-y-2">
        <h4 className="flex items-center gap-1 text-sm font-medium">
          How long they are kept <HelpButton helpKey="admin.versionHistoryKeep" />
        </h4>
        {group('keep')}
      </div>
      <div className="space-y-2">
        <h4 className="flex items-center gap-1 text-sm font-medium">
          How many backups are kept <HelpButton helpKey="admin.backupKeeps" />
        </h4>
        {group('backups')}
      </div>
      {err && (
        <p role="alert" className="text-sm text-danger">
          {err}
        </p>
      )}
    </section>
  );
}

function NumberSetting({ limit, disabled, onSave }: { limit: Limit; disabled: boolean; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(limit.value));
  // A saved (or someone else's) change shows here too.
  useEffect(() => setV(String(limit.value)), [limit.value]);
  const n = Number(v);
  const ok = v.trim() !== '' && Number.isInteger(n) && n >= limit.min && n <= limit.max;
  return (
    <label className="block text-sm">
      <span className="font-medium">{limit.label}</span>
      <span className="mt-1 flex items-center gap-2">
        <input
          type="number"
          min={limit.min}
          max={limit.max}
          value={v}
          aria-label={limit.label}
          onChange={(e) => setV(e.target.value)}
          className="w-28 rounded-lg border border-border bg-panel px-2 py-1"
        />
        <span className="text-muted">{limit.unit}</span>
        <button type="button" className={btn} disabled={disabled || !ok || n === limit.value} onClick={() => onSave(n)} aria-label={`Save ${limit.label}`}>
          Save
        </button>
      </span>
      <span className="mt-1 block text-xs text-muted">
        {limit.help} ({limit.min}–{limit.max}; {limit.builtIn} unless changed.)
      </span>
    </label>
  );
}
