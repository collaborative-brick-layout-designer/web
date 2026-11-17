// The clubs part of a module's Share dialog (docs/shared-modules.md):
// share it, read-only, with a club you're in; stop, with what that means
// said first; and where the module is used, as counts and club names
// (never the names of other people's layouts).

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ModuleShares } from '../api';
import { askConfirm } from '../ui/ConfirmDialog';
import { HelpButton } from '../help/HelpButton';

/** "Used in 4 layouts (Riverside LUG: 3, Bob: 1)", or null when it's placed nowhere. */
export function usedInText(u: ModuleShares['usedIn']): string | null {
  if (u.layouts === 0) return null;
  const parts = [...u.clubs.map((c) => `${c.name}: ${c.layouts}`), ...u.people.map((p) => `${p.name}: ${p.layouts}`), ...(u.others > 0 ? [`others: ${u.others}`] : [])];
  return `Used in ${u.layouts} layout${u.layouts === 1 ? '' : 's'}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`;
}

/** What stopping a share with `who` leaves behind. */
export function stopShareText(title: string, who: string, layouts: number, version: number): { title: string; keeps: string; removes: string } {
  const v = version > 0 ? ` (version ${version})` : '';
  return {
    title: `Stop sharing with ${who}?`,
    keeps: layouts > 0 ? `${layouts === 1 ? 'Its layout keeps' : `Its ${layouts} layouts keep`} “${title}” as it is now${v}.` : `Nothing changes in any layout: “${title}” isn’t placed in one of theirs.`,
    removes: 'They won’t get your updates anymore, and can’t place it again.',
  };
}

export function ModuleClubShares({ moduleId, title }: { moduleId: string; title: string }) {
  const qc = useQueryClient();
  const key = ['module-shares', moduleId];
  const shares = useQuery({ queryKey: key, queryFn: () => api.modules.shares(moduleId) });
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['modules-shared'] });
  };
  const share = useMutation({
    mutationFn: (s: string) => api.modules.shareWithClub(moduleId, s),
    onSuccess: () => {
      setSlug('');
      setError(null);
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });
  const stop = useMutation({
    mutationFn: (orgId: string) => api.modules.stopClubShare(moduleId, orgId),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });
  const d = shares.data;
  if (!d) return shares.isError ? <p className="text-sm text-danger">{(shares.error as Error).message}</p> : null;
  const open = d.myClubs.filter((c) => !d.clubs.some((s) => s.orgId === c.orgId));
  const used = usedInText(d.usedIn);
  return (
    <section className="space-y-2" data-testid="module-club-shares">
      <h4 className="flex items-center gap-1 text-sm font-semibold">
        Clubs
        <HelpButton helpKey="module.share" />
      </h4>
      {!d.canShareWithClubs ? (
        <p className="text-xs text-muted">This is a club’s module: its members already have it.</p>
      ) : (
        <>
          <p className="text-xs text-muted">A club you share with can place this module in the club’s layouts and gets your updates. Its members can’t change its parts.</p>
          {d.myClubs.length === 0 ? (
            <p className="text-xs text-muted">You’re not in a club yet. Join or start one to share with it.</p>
          ) : open.length > 0 ? (
            <form
              className="flex flex-wrap items-end gap-2 text-sm"
              onSubmit={(e) => {
                e.preventDefault();
                if (slug) share.mutate(slug);
              }}
            >
              <label className="min-w-0 flex-1">
                <span className="mb-1 block text-xs text-muted">Share with a club</span>
                <select value={slug} onChange={(e) => setSlug(e.target.value)} data-testid="module-club-pick" className="w-full rounded-lg border border-border bg-soft px-2 py-1.5">
                  <option value="">Pick a club…</option>
                  {open.map((c) => (
                    <option key={c.orgId} value={c.slug}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" disabled={!slug || share.isPending} className="min-h-9 rounded-lg bg-accent px-3 py-1.5 font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50">
                {share.isPending ? 'Sharing…' : 'Share'}
              </button>
            </form>
          ) : (
            <p className="text-xs text-muted">It’s shared with every club you’re in.</p>
          )}
        </>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      {d.clubs.length > 0 && (
        <ul className="divide-y divide-line/60 rounded-lg border border-line text-sm" data-testid="module-clubs">
          {d.clubs.map((c) => (
            <li key={c.orgId} className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 truncate">
                {c.name} <span className="text-xs text-muted">(club) · can place it</span>
              </span>
              <button
                type="button"
                disabled={stop.isPending}
                className="min-h-9 rounded-lg border border-border px-3 py-1 hover:bg-soft disabled:opacity-50"
                onClick={async () => {
                  const n = d.usedIn.clubs.find((u) => u.orgId === c.orgId)?.layouts ?? 0;
                  const t = stopShareText(title, c.name, n, d.latestVersion);
                  if (await askConfirm({ ...t, confirmLabel: 'Stop', danger: false })) stop.mutate(c.orgId);
                }}
              >
                Stop
              </button>
            </li>
          ))}
        </ul>
      )}
      {used && (
        <p className="text-xs text-muted" data-testid="module-used-in">
          {used}
        </p>
      )}
    </section>
  );
}
