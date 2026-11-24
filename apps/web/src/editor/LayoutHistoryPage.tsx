// A layout's version history (/editor/:id/history): the versions the
// server kept (server history/layoutVersions.ts), newest first, each with
// when, why and who, and what was in it. Picking one shows it in the
// read-only viewer. People who may edit the layout can keep a version now
// (with a name) and put one back: a version of the layout as it is is
// kept first, so a restore can itself be undone. Anyone who may copy the
// layout can copy a version out as a new layout. The list updates by
// itself (the live 'layout' hint refetches ['layout-versions']).

import { useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type * as Y from 'yjs';
import { decodeDoc } from '@cld/ydoc';
import { api, type LayoutVersion } from '../api';
import { askConfirm } from '../ui/ConfirmDialog';
import { HelpButton } from '../help/HelpButton';
import { LayoutViewer } from '../layouts/PublicLayoutPage';

export const REASON_WORDS: Record<LayoutVersion['reason'], string> = {
  auto: 'While editing',
  manual: 'Kept by hand',
  'before-import': 'Before a model was imported',
  'before-merge': 'Before another layout was added in',
  'before-restore': 'Before a restore',
  'before-bulk-delete': 'Before many parts were deleted',
};

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function whoOf(v: LayoutVersion): string {
  const names = v.editors.map((e) => e.name).filter(Boolean);
  if (names.length > 0) return names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
  return v.createdBy?.name ?? '';
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
export const summaryLine = (v: LayoutVersion) => `${plural(v.summary.parts, 'part', 'parts')} · ${plural(v.summary.sheets, 'sheet', 'sheets')}`;

export function LayoutHistoryPage() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <Navigate to="/" replace />;
  return <History layoutId={id} />;
}

function History({ layoutId }: { layoutId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const layout = useQuery({ queryKey: ['layout', layoutId], queryFn: () => api.layouts.get(layoutId), retry: false });
  const list = useQuery({ queryKey: ['layout-versions', layoutId], queryFn: () => api.layouts.versions(layoutId), retry: false });
  const [picked, setPicked] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; link?: { to: string; label: string } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const versions = list.data?.versions ?? [];
  const current = versions.find((v) => v.id === picked) ?? versions[0] ?? null;
  const snapshot = useQuery({
    queryKey: ['layout-version-snapshot', layoutId, current?.id],
    queryFn: () => api.layouts.versionSnapshot(layoutId, current!.id),
    enabled: !!current,
    staleTime: Infinity,
  });
  const doc = useMemo<Y.Doc | null>(() => {
    if (!snapshot.data) return null;
    try {
      return decodeDoc(snapshot.data.bytes);
    } catch {
      return null;
    }
  }, [snapshot.data]);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['layout-versions', layoutId] });

  const keep = useMutation({
    mutationFn: () => api.layouts.keepVersion(layoutId, { reason: 'manual', ...(name.trim() ? { label: name.trim() } : {}) }),
    onSuccess: (r) => {
      setName('');
      setError(null);
      setPicked(r.id);
      setStatus({ text: 'Kept a version of the layout as it is now.' });
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });
  const restore = useMutation({
    mutationFn: (v: LayoutVersion) => api.layouts.restoreVersion(layoutId, v.id),
    onSuccess: (r, v) => {
      setError(null);
      setPicked(r.safety);
      setStatus({ text: `The layout is back to how it was on ${when(v.createdAt)}. How it was just before is kept as “${REASON_WORDS['before-restore']}”, so you can go back.`, link: { to: `/editor/${layoutId}`, label: 'Open the layout' } });
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });
  const copy = useMutation({
    mutationFn: (v: LayoutVersion) => api.layouts.copyVersion(layoutId, v.id),
    onSuccess: (r) => {
      setError(null);
      setStatus({ text: `Made a new layout, “${r.title}”, from this version.`, link: { to: `/editor/${r.id}`, label: 'Open the copy' } });
    },
    onError: (e: Error) => setError(e.message),
  });

  if (layout.isError || list.isError) {
    return (
      <div className="grid min-h-screen place-items-center p-8 text-center">
        <div>
          <h1 className="text-xl font-semibold">Layout not found</h1>
          <Link to="/" className="mt-4 inline-block text-sm text-accent-text hover:underline">
            Go home
          </Link>
        </div>
      </div>
    );
  }
  const title = layout.data?.layout.title ?? '';
  const canRestore = !!list.data?.canRestore;
  const busy = keep.isPending || restore.isPending || copy.isPending;

  const panel = (
    <aside
      aria-label="Version history"
      className="absolute inset-x-0 bottom-0 z-20 flex max-h-[55dvh] flex-col rounded-t-section border border-line bg-panel shadow-lg sm:inset-x-auto sm:bottom-3 sm:right-3 sm:top-16 sm:max-h-none sm:w-96 sm:rounded-section"
    >
      <div className="space-y-2 border-b border-line p-3">
        <h1 className="flex items-center gap-2 text-base font-semibold">
          Version history <HelpButton helpKey="history.versions" />
        </h1>
        {canRestore && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              keep.mutate();
            }}
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="Name (optional), e.g. Before the show"
              aria-label="Name for the version"
              className="min-w-0 flex-1 rounded-lg border border-border bg-soft px-2 py-1 text-sm"
            />
            <button type="submit" disabled={busy} className="tap-target rounded-lg border border-border px-3 py-1 text-sm font-semibold hover:bg-soft disabled:opacity-50">
              Keep a version now
            </button>
          </form>
        )}
        {status && (
          <p role="status" className="text-sm text-ok">
            {status.text}{' '}
            {status.link && (
              <Link to={status.link.to} className="font-semibold underline">
                {status.link.label}
              </Link>
            )}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
      {list.isLoading ? (
        <p className="p-3 text-sm text-muted">Loading…</p>
      ) : versions.length === 0 ? (
        <p className="p-3 text-sm text-muted">No versions yet. One is kept after the first edits, then every half hour while people work on the layout.</p>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
          {versions.map((v) => {
            const on = v.id === current?.id;
            return (
              <li key={v.id} data-version={v.id}>
                <button
                  type="button"
                  onClick={() => setPicked(v.id)}
                  aria-current={on ? 'true' : undefined}
                  className={`block w-full px-3 py-2 text-left text-sm ${on ? 'bg-accent/15' : 'hover:bg-soft'}`}
                >
                  <span className="block font-medium">{when(v.createdAt)}</span>
                  <span className="block text-xs">
                    {v.label ? `“${v.label}”` : REASON_WORDS[v.reason]}
                    {whoOf(v) ? ` · ${whoOf(v)}` : ''}
                  </span>
                  <span className="block text-xs text-muted">{summaryLine(v)}</span>
                </button>
                {on && (
                  <div className="flex flex-wrap gap-2 px-3 pb-3">
                    {canRestore && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={async () => {
                          const ok = await askConfirm({
                            title: `Put the layout back to ${when(v.createdAt)}?`,
                            removes: 'The layout becomes as it was in this version. Everyone working in it sees the change at once.',
                            keeps: 'The layout as it is now is kept in this list first (“Before a restore”), so you can go back to it.',
                            confirmLabel: 'Restore this version',
                            danger: false,
                          });
                          if (ok) restore.mutate(v);
                        }}
                        className="tap-target rounded-lg bg-accent px-3 py-1 text-xs font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50"
                      >
                        Restore this version
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => copy.mutate(v)}
                      className="tap-target rounded-lg border border-border px-3 py-1 text-xs hover:bg-soft disabled:opacity-50"
                    >
                      Copy as a new layout
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );

  const back = (
    <button type="button" onClick={() => navigate(`/editor/${layoutId}`)} className="tap-target inline-flex items-center rounded-lg border border-border bg-panel/95 px-3 py-1.5 text-sm shadow hover:bg-soft">
      Back to the layout
    </button>
  );

  if (!doc) {
    return (
      <div className="h-app relative w-full overflow-hidden bg-panel">
        <div className="absolute left-3 top-3 z-10">{back}</div>
        {snapshot.isLoading || list.isLoading ? <p className="grid h-full place-items-center text-muted">Loading…</p> : null}
        {panel}
      </div>
    );
  }
  return <LayoutViewer key={current?.id} doc={doc} title={title} badge={current ? `Version from ${when(current.createdAt)}` : 'Version'} side={panel} topRight={back} />;
}
