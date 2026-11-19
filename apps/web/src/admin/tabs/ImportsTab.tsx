// Admin › Model import: whether this site can import LDraw, Studio and LDD
// files (the converter), the libraries it reads them with, and the limits.
// Every setting is here; an env var that forces one is named instead.

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend, friendlyErrorMessage } from '../../api';
import { HelpButton } from '../../help/HelpButton';
import { Loading } from './shared';

interface LibraryRow {
  present: boolean;
  forcedBy: string | null;
  version?: string | null;
  date?: string | null;
  bytes: number | null;
  installedAt: string | null;
  from?: string | null;
}

interface AdminImports {
  available: boolean;
  reason: string | null;
  message: string | null;
  converter: { path: string; forcedBy: string | null; version: string | null; minimum: string; problem: string | null; sandbox: Record<string, unknown> | null };
  enabled: boolean;
  enabledSetting: boolean;
  enabledForcedBy: string | null;
  limits: { key: string; label: string; help: string; min: number; max: number; unit: string; value: number; builtIn: number }[];
  libraries: { ldraw: LibraryRow; ldd: LibraryRow; lddMapping: LibraryRow; studio: LibraryRow };
  queue: { queued: number; running: number; open: number };
}

const size = (n: number | null) => (n === null ? '' : n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(0)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const btn = 'tap-target rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-soft disabled:opacity-50';
const primary = 'tap-target rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50';

async function sendFile(path: string, file: File): Promise<AdminImports> {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetch(path, { method: 'POST', credentials: 'include', body: form });
  if (!res.ok) throw new Error(await friendlyErrorMessage(res, 'POST', path));
  return (await res.json()) as AdminImports;
}

export function ImportsTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-imports'], queryFn: () => apiGet<AdminImports>('/api/admin/imports') });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const done = (v: AdminImports) => {
    qc.setQueryData(['admin-imports'], v);
    void qc.invalidateQueries({ queryKey: ['imports-status'] });
  };
  const run = async (what: string, work: () => Promise<AdminImports>) => {
    setBusy(what);
    setErr('');
    try {
      done(await work());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiSend<AdminImports>('PATCH', '/api/admin/imports', body),
    onSuccess: done,
    onError: (e: Error) => setErr(e.message),
  });

  if (!q.data) return <Loading />;
  const d = q.data;
  return (
    <div className="space-y-6" data-testid="admin-imports">
      <section className="space-y-2">
        <h2 className="flex items-center gap-1 text-lg font-semibold">
          Model import <HelpButton helpKey="admin.imports" />
        </h2>
        <p className={d.available ? 'text-ink' : 'font-semibold text-danger'} data-testid="admin-imports-state">
          {d.available ? 'People can import LDraw, BrickLink Studio and LDD files on this site.' : d.message}
        </p>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={d.enabled}
            disabled={!!d.enabledForcedBy || patch.isPending}
            onChange={(e) => patch.mutate({ enabled: e.target.checked })}
          />
          Let people import models
        </label>
        {d.enabledForcedBy && <p className="text-xs text-muted">Forced by {d.enabledForcedBy} on the server.</p>}
        <p className="text-xs text-muted">
          Converter: {d.converter.version ? `version ${d.converter.version}` : 'not installed'} (this site needs {d.converter.minimum} or newer)
          {d.converter.forcedBy ? `, from ${d.converter.forcedBy}` : ''}.
          {d.converter.sandbox && ` Locked down: ${d.converter.sandbox.seccomp ? 'system-call filter' : 'no filter'}, ${d.converter.sandbox.netns ? 'own network' : 'no sockets'}.`}{' '}
          {d.queue.running} running, {d.queue.queued} waiting.
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="flex items-center gap-1 font-semibold">
          Libraries <HelpButton helpKey="admin.importLibraries" />
        </h3>
        <Library
          title="LDraw parts library"
          note="The official library from ldraw.org (free, CC BY 2.0, about 150 MB to download). Draws LDraw and Studio models."
          row={d.libraries.ldraw}
          busy={busy}
          testId="lib-ldraw"
          actions={
            <>
              <button type="button" className={primary} disabled={!!busy || !!d.libraries.ldraw.forcedBy} onClick={() => void run('ldraw', () => apiSend('POST', '/api/admin/imports/ldraw/download', {}))}>
                {busy === 'ldraw' ? 'Downloading…' : d.libraries.ldraw.present ? 'Get the latest' : 'Download it'}
              </button>
              {d.libraries.ldraw.present && !d.libraries.ldraw.forcedBy && (
                <button type="button" className={btn} disabled={!!busy} onClick={() => void run('ldraw-rm', () => apiSend('DELETE', '/api/admin/imports/ldraw', {}))}>
                  Remove
                </button>
              )}
            </>
          }
        />
        <Library
          title="LDD brick database (Assets.lif)"
          note="From an install of LEGO Digital Designer (about 500 MB). It isn’t free to share: upload your own copy. It stays on this server, is never served to anyone and is never in a backup or download."
          row={d.libraries.ldd}
          busy={busy}
          testId="lib-ldd"
          actions={
            <>
              <Upload label="Upload Assets.lif" accept=".lif" disabled={!!busy || !!d.libraries.ldd.forcedBy} onFile={(f) => void run('ldd', () => sendFile('/api/admin/imports/ldd/assets', f))} />
              {d.libraries.ldd.present && !d.libraries.ldd.forcedBy && (
                <button type="button" className={btn} disabled={!!busy} onClick={() => void run('ldd-rm', () => apiSend('DELETE', '/api/admin/imports/ldd/assets', {}))}>
                  Remove
                </button>
              )}
            </>
          }
        />
        <Library
          title="LDD → LDraw mapping (ldraw.xml)"
          note="Matches LDD bricks to LDraw parts, for snap points and for LDD models without the brick database. Get the community one (lxf2ldr, GPL-3), or upload your own."
          row={d.libraries.lddMapping}
          busy={busy}
          testId="lib-mapping"
          actions={
            <>
              <button type="button" className={primary} disabled={!!busy || !!d.libraries.lddMapping.forcedBy} onClick={() => void run('mapping', () => apiSend('POST', '/api/admin/imports/ldd/mapping/community', {}))}>
                {busy === 'mapping' ? 'Getting it…' : 'Get the community mapping'}
              </button>
              <Upload label="Upload ldraw.xml" accept=".xml,.p" disabled={!!busy || !!d.libraries.lddMapping.forcedBy} onFile={(f) => void run('mapping-up', () => sendFile('/api/admin/imports/ldd/mapping', f))} />
              {d.libraries.lddMapping.present && !d.libraries.lddMapping.forcedBy && (
                <button type="button" className={btn} disabled={!!busy} onClick={() => void run('mapping-rm', () => apiSend('DELETE', '/api/admin/imports/ldd/mapping', {}))}>
                  Remove
                </button>
              )}
            </>
          }
        />
        <Library
          title="BrickLink Studio’s parts library (optional)"
          note="A zip of the ldraw folder from a Studio install. Without it, Studio-only parts are left out of the picture and counted as missing."
          row={d.libraries.studio}
          busy={busy}
          testId="lib-studio"
          actions={
            <>
              <Upload label="Upload a zip" accept=".zip" disabled={!!busy || !!d.libraries.studio.forcedBy} onFile={(f) => void run('studio', () => sendFile('/api/admin/imports/studio', f))} />
              {d.libraries.studio.present && !d.libraries.studio.forcedBy && (
                <button type="button" className={btn} disabled={!!busy} onClick={() => void run('studio-rm', () => apiSend('DELETE', '/api/admin/imports/studio', {}))}>
                  Remove
                </button>
              )}
            </>
          }
        />
      </section>

      <section className="space-y-3">
        <h3 className="flex items-center gap-1 font-semibold">
          Limits <HelpButton helpKey="admin.importLimits" />
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {d.limits.map((l) => (
            <Limit key={l.key} limit={l} disabled={patch.isPending} onSave={(v) => patch.mutate({ limits: { [l.key]: v } })} />
          ))}
        </div>
      </section>
      {err && (
        <p role="alert" className="text-sm text-danger">
          {err}
        </p>
      )}
    </div>
  );
}

function Library({ title, note, row, actions, testId }: { title: string; note: string; row: LibraryRow; busy: string | null; actions: React.ReactNode; testId: string }) {
  return (
    <div className="rounded-lg border border-border p-3" data-testid={testId}>
      <p className="font-semibold">
        {title}: <span className={row.present ? 'text-ink' : 'text-muted'}>{row.present ? 'ready' : 'not set up'}</span>
      </p>
      {row.present && (
        <p className="text-xs text-muted">
          {[row.version, row.date && `dated ${row.date}`, row.from && `from ${row.from === 'community' ? 'the community (lxf2ldr)' : 'an upload'}`, size(row.bytes), row.installedAt && `added ${new Date(row.installedAt).toLocaleDateString()}`]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      <p className="mt-1 text-sm text-muted">{note}</p>
      {row.forcedBy ? <p className="mt-1 text-xs text-muted">Set by {row.forcedBy} on the server, so it can’t be changed here.</p> : <div className="mt-2 flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

function Upload({ label, accept, disabled, onFile }: { label: string; accept: string; disabled: boolean; onFile: (f: File) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className={btn} disabled={disabled} onClick={() => ref.current?.click()}>
        {label}
      </button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        aria-label={label}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onFile(f);
        }}
      />
    </>
  );
}

function Limit({ limit, disabled, onSave }: { limit: AdminImports['limits'][number]; disabled: boolean; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(limit.value));
  // A saved (or someone else's) change shows here too.
  useEffect(() => setV(String(limit.value)), [limit.value]);
  const n = Number(v);
  const ok = Number.isInteger(n) && n >= limit.min && n <= limit.max;
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
        <button type="button" className={btn} disabled={disabled || !ok || n === limit.value} onClick={() => onSave(n)}>
          Save
        </button>
      </span>
      <span className="mt-1 block text-xs text-muted">
        {limit.help} ({limit.min}–{limit.max}; {limit.builtIn} unless changed.)
      </span>
    </label>
  );
}
