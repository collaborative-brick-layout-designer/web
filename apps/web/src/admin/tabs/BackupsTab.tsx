// Admin › Backups: copies of the whole site's database (and the layouts'
// background pictures beside them). Nightly ones are made by the server;
// "Back up now" makes one at once. Each can be downloaded, and put back:
// the server checks the copy, makes a backup of the site as it is now,
// then restarts with the copy in place. A copy kept somewhere else can be
// uploaded (in pieces, so any size gets through a proxy) and restored the
// same way. Server: routes/adminBackups.ts.

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, friendlyErrorMessage, noteWrite, type AdminJobSetting } from '../../api';
import { HelpButton } from '../../help/HelpButton';
import { askConfirm } from '../../ui/ConfirmDialog';
import { formatAgo, formatBytes } from '../insights/format';
import { Loading } from './shared';

export type BackupKind = 'nightly' | 'manual' | 'before-restore' | 'upload' | 'pre-migration' | 'before-fix';

export interface BackupFile {
  name: string;
  kind: BackupKind;
  bytes: number;
  at: number;
  images: { name: string; bytes: number } | null;
}

export interface BackupCheck {
  newestAt: number | null;
  migratedAt: number | null;
  older: boolean;
  counts: { people: number; layouts: number; modules: number; clubs: number };
}

export interface BackupsView {
  nightly: AdminJobSetting<boolean>;
  files: BackupFile[];
  running: { kind: 'backup' | 'check' | 'restore'; startedAt: number } | null;
  lastError: { kind: string; message: string; at: number } | null;
  lastRestore: { from: string; by: { name: string }; doneAt: number; ok: boolean; message: string; safety: string } | null;
  restorePending: boolean;
  freeBytes: { backups: number | null; data: number | null };
  upload: { chunkBytes: number; maxBytes: number };
}

export const KIND_LABEL: Record<BackupKind, string> = {
  nightly: 'Nightly',
  manual: 'Made by hand',
  'before-restore': 'Before a restore',
  upload: 'Uploaded',
  'pre-migration': 'Before an update',
  'before-fix': 'Before a data fix',
};

async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, raw?: Blob): Promise<T> {
  const init: RequestInit = { method, credentials: 'include' };
  if (raw) {
    init.headers = { 'content-type': 'application/octet-stream' };
    init.body = raw;
  } else if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error('Couldn’t reach the server. Check the connection and try again.');
  }
  if (!res.ok) {
    let message: string | null = null;
    try {
      const b = (await res.clone().json()) as { message?: unknown };
      if (typeof b.message === 'string' && b.message) message = b.message;
    } catch {
      /* not JSON */
    }
    throw new Error(message ?? (await friendlyErrorMessage(res, method, path)));
  }
  if (method !== 'GET') noteWrite(method, path);
  return (res.status === 204 ? null : await res.json()) as T;
}

const backupsApi = {
  list: () => call<BackupsView>('GET', '/api/admin/backups'),
  backUpNow: () => call<{ started: true }>('POST', '/api/admin/backups', {}),
  check: (name: string) => call<BackupCheck>('POST', `/api/admin/backups/${encodeURIComponent(name)}/check`, {}),
  restore: (name: string, images: boolean) => call<{ restarting: true; safety: string }>('POST', `/api/admin/backups/${encodeURIComponent(name)}/restore`, { confirm: 'RESTORE', images }),
};

const downloadUrl = (name: string) => `/api/admin/backups/${encodeURIComponent(name)}/download`;

function when(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function countsLine(c: BackupCheck['counts']): string {
  const n = (v: number, one: string, many: string) => `${v.toLocaleString()} ${v === 1 ? one : many}`;
  return `${n(c.people, 'person', 'people')}, ${n(c.layouts, 'layout', 'layouts')}, ${n(c.modules, 'module', 'modules')} and ${n(c.clubs, 'club', 'clubs')}`;
}

/** After a restore: wait for the server to go and come back, then load the page fresh. */
function useWaitForRestart(active: boolean) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let sawDown = false;
    const started = Date.now();
    const tick = async () => {
      if (stopped) return;
      setSeconds(Math.round((Date.now() - started) / 1000));
      let up: boolean;
      try {
        const r = await fetch('/api/admin/backups', { credentials: 'include', cache: 'no-store' });
        // 503 "maintenance" or a proxy's 502 while it restarts: still down.
        up = r.status !== 503 && r.status !== 502 && r.status !== 504;
      } catch {
        up = false;
      }
      if (!up) sawDown = true;
      if (up && (sawDown || Date.now() - started > 20_000)) {
        window.location.reload();
        return;
      }
      setTimeout(() => void tick(), 1500);
    };
    const first = setTimeout(() => void tick(), 1500);
    return () => {
      stopped = true;
      clearTimeout(first);
    };
  }, [active]);
  return seconds;
}

export function BackupsTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-backups'], queryFn: backupsApi.list, refetchInterval: (query) => (query.state.data?.running ? 2000 : false) });
  const [restarting, setRestarting] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const waited = useWaitForRestart(restarting !== null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['admin-backups'] });

  const now = useMutation({
    mutationFn: backupsApi.backUpNow,
    onSuccess: refresh,
    onError: (e: Error) => setError(e.message),
  });
  const nightly = useMutation({
    mutationFn: (on: boolean) => api.admin.patchSettings({ backupsEnabled: on }),
    onSuccess: () => {
      refresh();
      void qc.invalidateQueries({ queryKey: ['admin-settings'] });
    },
    onError: (e: Error) => setError(e.message),
  });

  async function restore(f: BackupFile) {
    setError(null);
    setChecking(f.name);
    let check: BackupCheck;
    try {
      check = await backupsApi.check(f.name);
    } catch (e) {
      setError((e as Error).message);
      return;
    } finally {
      setChecking(null);
    }
    const ok = await askConfirm({
      title: `Restore the site to ${when(f.at)}?`,
      removes:
        `Everything on this site goes back to how it was in this backup (${countsLine(check.counts)}${check.newestAt ? `; the last layout change in it was ${when(check.newestAt)}` : ''}). ` +
        'Every change people made since then is replaced, and anyone who signed up or signed in since then has to again (you too). ' +
        `The site restarts and is down for about a minute${f.images ? '; the background pictures in the backup are put back too' : ''}.` +
        (check.older ? ' It was made by an older version of the server, so it is updated as the server starts.' : ''),
      keeps: 'First, a backup of the site as it is right now is made (“Before a restore” in this list), so you can go back to it. The server’s secret key isn’t in any backup and stays as it is.',
      undo: 'To undo, restore the “Before a restore” backup made now.',
      confirmLabel: 'Restore and restart',
      typeName: 'RESTORE',
    });
    if (!ok) return;
    try {
      await backupsApi.restore(f.name, !!f.images);
      setRestarting(f.name);
    } catch (e) {
      setError((e as Error).message);
      refresh();
    }
  }

  if (restarting) {
    return (
      <section role="status" aria-live="polite" className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-900/20 p-4">
        <h2 className="text-base font-semibold">Restoring {restarting}…</h2>
        <p className="text-sm">
          The server is restarting with the backup in place. This page reloads by itself when the site is back{waited > 0 ? ` (${waited} s so far)` : ''}. You may need to sign in again.
        </p>
        {waited > 90 && (
          <p className="text-sm">
            It’s taking longer than usual. If the server runs without automatic restarts, start it again: the restore finishes as it starts.
          </p>
        )}
      </section>
    );
  }

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <p className="text-sm text-red-400">{(q.error as Error | null)?.message ?? 'Couldn’t load the backups.'}</p>;
  const d = q.data;
  const busy = d.running !== null || d.restorePending;

  return (
    <div className="space-y-6">
      <section className="space-y-2" aria-labelledby="backups-heading">
        <h2 id="backups-heading" className="flex items-center gap-2 text-base font-semibold">
          Backups <HelpButton helpKey="admin.backups" />
        </h2>
        <p className="text-sm text-muted">
          Copies of the whole site: every account, club, layout, module and setting, with the layouts’ background pictures beside them. The server’s secret key is never in a backup.
        </p>
      </section>

      {d.lastRestore && (
        <div role="note" className={`rounded-lg border p-3 text-sm ${d.lastRestore.ok ? 'border-emerald-500/40 bg-emerald-900/20' : 'border-red-500/40 bg-red-900/20'}`}>
          <p>
            {d.lastRestore.message} Asked for by {d.lastRestore.by.name}, done {formatAgo(d.lastRestore.doneAt)}.
          </p>
          <p className="text-xs text-muted">The site as it was just before is the backup {d.lastRestore.safety}.</p>
        </div>
      )}
      {d.restorePending && (
        <p role="status" className="rounded-lg border border-amber-500/40 bg-amber-900/20 p-3 text-sm">
          A restore is waiting for the server to restart. If it doesn’t restart by itself, restart it.
        </p>
      )}

      <section className="space-y-3 rounded-lg border border-line p-4" aria-labelledby="backups-make">
        <h3 id="backups-make" className="text-sm font-semibold">Making backups</h3>
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={d.nightly.value} disabled={!!d.nightly.forcedBy || nightly.isPending} onChange={(e) => nightly.mutate(e.target.checked)} />
            Back up every night
            <HelpButton helpKey="admin.backupsNightly" />
          </label>
          <p className="text-xs text-muted">Keeps one for each of the last 7 days, 3 weeks and 12 months.</p>
          {d.nightly.forcedBy && (
            <p className="text-xs text-muted">
              Set by <code>{d.nightly.forcedBy}</code> on the server, so it can’t be changed here: change or remove that setting on the server.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              setError(null);
              now.mutate();
            }}
            disabled={busy || now.isPending}
            className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink disabled:opacity-50"
          >
            Back up now
          </button>
          {d.running?.kind === 'backup' && (
            <span role="status" className="text-sm text-muted">
              Making a backup… the site keeps working meanwhile.
            </span>
          )}
          {d.freeBytes.backups !== null && <span className="text-xs text-muted">{formatBytes(d.freeBytes.backups)} free in the backups folder.</span>}
        </div>
        {d.lastError && (
          <p role="alert" className="text-sm text-red-400">
            The last {d.lastError.kind === 'backup' ? 'backup' : 'restore'} didn’t work: {d.lastError.message}
          </p>
        )}
      </section>

      {error && (
        <p role="alert" className="rounded-lg border border-red-500/40 bg-red-900/20 p-3 text-sm">
          {error}
        </p>
      )}

      <section aria-labelledby="backups-list" className="space-y-2">
        <h3 id="backups-list" className="flex items-center gap-2 text-sm font-semibold">
          Saved backups <HelpButton helpKey="admin.backupsRestore" />
        </h3>
        {d.files.length === 0 ? (
          <p className="text-sm text-muted">No backups yet. Press Back up now to make the first one.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2">Made</th>
                  <th className="px-3 py-2">Kind</th>
                  <th className="px-3 py-2 text-right">Size</th>
                  <th className="px-3 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.files.map((f) => (
                  <tr key={f.name} className="border-t border-line" data-backup={f.name}>
                    <td className="px-3 py-2" data-label="Made">
                      <span className="block">{when(f.at)}</span>
                      <span className="block break-all text-xs text-muted">{f.name}</span>
                    </td>
                    <td className="px-3 py-2" data-label="Kind">
                      {KIND_LABEL[f.kind]}
                    </td>
                    <td className="px-3 py-2 text-right" data-label="Size">
                      {formatBytes(f.bytes)}
                      {f.images && <span className="block text-xs text-muted">+ {formatBytes(f.images.bytes)} pictures</span>}
                    </td>
                    <td className="px-3 py-2" data-label="Actions">
                      <div className="flex flex-wrap justify-end gap-2">
                        <a href={downloadUrl(f.name)} download className="inline-flex min-h-9 items-center rounded-lg border border-border px-3 text-xs hover:bg-soft" aria-label={`Download ${f.name}`}>
                          Download
                        </a>
                        {f.images && (
                          <a href={downloadUrl(f.images.name)} download className="inline-flex min-h-9 items-center rounded-lg border border-border px-3 text-xs hover:bg-soft" aria-label={`Download the pictures of ${f.name}`}>
                            Pictures
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() => void restore(f)}
                          disabled={busy || checking !== null}
                          aria-label={`Restore ${f.name}`}
                          className="min-h-9 rounded-lg border border-red-500/50 px-3 text-xs text-red-300 hover:bg-red-900/30 disabled:opacity-40"
                        >
                          {checking === f.name ? 'Checking…' : 'Restore…'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <UploadSection view={d} disabled={busy} onDone={refresh} />
    </div>
  );
}

/** Send a file in pieces; `onProgress` gets 0..1. Returns what the server said when it finished. */
async function sendInPieces<T>(file: File, start: Record<string, unknown>, chunkBytes: number, onProgress: (f: number) => void, signal: { cancelled: boolean }): Promise<T> {
  const { id } = await call<{ id: string }>('POST', '/api/admin/backups/uploads', { ...start, name: file.name, bytes: file.size });
  try {
    for (let off = 0; off < file.size; off += chunkBytes) {
      if (signal.cancelled) throw new Error('Upload cancelled.');
      const piece = file.slice(off, Math.min(file.size, off + chunkBytes));
      // A piece that meets a restart or a dropped connection is sent again (the server takes it once).
      for (let tries = 0; ; tries++) {
        try {
          await call('PUT', `/api/admin/backups/uploads/${id}?offset=${off}`, undefined, piece);
          break;
        } catch (e) {
          if (tries >= 4 || signal.cancelled) throw e;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** tries));
        }
      }
      onProgress(Math.min(1, (off + piece.size) / file.size));
    }
    return await call<T>('POST', `/api/admin/backups/uploads/${id}/finish`, {});
  } catch (e) {
    await call('DELETE', `/api/admin/backups/uploads/${id}`).catch(() => undefined);
    throw e;
  }
}

function UploadSection({ view, disabled, onDone }: { view: BackupsView; disabled: boolean; onDone: () => void }) {
  const dbInput = useRef<HTMLInputElement>(null);
  const picInput = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const cancel = useRef({ cancelled: false });

  async function go() {
    const db = dbInput.current?.files?.[0];
    const pics = picInput.current?.files?.[0];
    if (!db) {
      setMessage({ ok: false, text: 'Choose the database backup first (a file ending .sqlite.gz or .sqlite).' });
      return;
    }
    if (db.size > view.upload.maxBytes || (pics && pics.size > view.upload.maxBytes)) {
      setMessage({ ok: false, text: `A backup can be at most ${formatBytes(view.upload.maxBytes)}.` });
      return;
    }
    cancel.current = { cancelled: false };
    setMessage(null);
    setProgress(0);
    try {
      const total = db.size + (pics?.size ?? 0);
      const done = await sendInPieces<{ file: BackupFile | null; check: BackupCheck | null }>(
        db,
        { kind: 'database' },
        view.upload.chunkBytes,
        (f) => setProgress((f * db.size) / total),
        cancel.current,
      );
      if (pics && done.file) {
        await sendInPieces(pics, { kind: 'pictures', pairWith: done.file.name }, view.upload.chunkBytes, (f) => setProgress((db.size + f * pics.size) / total), cancel.current);
      }
      setMessage({
        ok: true,
        text: `Uploaded and checked${done.check ? `: ${countsLine(done.check.counts)}` : ''}. It is in the list as “Uploaded”; press Restore… there to put it back.`,
      });
      if (dbInput.current) dbInput.current.value = '';
      if (picInput.current) picInput.current.value = '';
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setProgress(null);
      onDone();
    }
  }

  return (
    <section className="space-y-3 rounded-lg border border-line p-4" aria-labelledby="backups-upload">
      <h3 id="backups-upload" className="flex items-center gap-2 text-sm font-semibold">
        Upload a backup <HelpButton helpKey="admin.backupsUpload" />
      </h3>
      <p className="text-xs text-muted">
        A backup downloaded from this site earlier. It is checked before it is listed; nothing changes on the site until you press Restore… on it.
      </p>
      <label className="block text-sm">
        <span className="mb-1 block">Database backup (.sqlite.gz or .sqlite)</span>
        <input ref={dbInput} type="file" accept=".gz,.sqlite" disabled={disabled || progress !== null} aria-label="Database backup file" className="block w-full text-sm" />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block">Its background pictures (.bgimages.tar.gz), if you have them</span>
        <input ref={picInput} type="file" accept=".gz" disabled={disabled || progress !== null} aria-label="Background pictures file" className="block w-full text-sm" />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void go()} disabled={disabled || progress !== null} className="min-h-11 rounded-lg border border-border px-4 text-sm font-semibold hover:bg-soft disabled:opacity-50">
          Upload
        </button>
        {progress !== null && (
          <>
            <progress value={progress} max={1} aria-label="Upload progress" className="w-40" />
            <span className="text-xs text-muted">{Math.round(progress * 100)}%</span>
            <button type="button" onClick={() => (cancel.current.cancelled = true)} className="text-xs underline">
              Cancel
            </button>
          </>
        )}
      </div>
      {message && (
        <p role={message.ok ? 'status' : 'alert'} className={`text-sm ${message.ok ? 'text-emerald-400' : 'text-red-400'}`}>
          {message.text}
        </p>
      )}
    </section>
  );
}
