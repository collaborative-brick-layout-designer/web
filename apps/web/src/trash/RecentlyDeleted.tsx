// Home's "Recently deleted": layouts, modules and venues deleted in the
// last 30 days (yours, and your clubs' where you may delete club items),
// each with Restore and Delete now. The words a delete asks with, and the
// toast's Undo, point here.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type RestoreResult, type TrashItem } from '../api';
import { confirmDelete, showToast } from '../ui/ConfirmDialog';
import { invalidateFor } from '../live/invalidate';


const KIND_WORD: Record<TrashItem['kind'], string> = { layout: 'Layout', module: 'Module', venue: 'Venue' };

const andList = (parts: string[]) => (parts.length <= 2 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

/**
 * What the toast says after a restore: the name, then (a module) the
 * collections it's back in, and any it was in that have since been deleted.
 */
export function restoredWords(title: string, r: Pick<RestoreResult, 'collections'>): string {
  const c = r.collections;
  if (!c || (c.back.length === 0 && c.gone === 0)) return `Restored “${title}”`;
  const parts = [`Restored “${title}”.`];
  if (c.back.length > 3) parts.push(`It’s back in its ${c.back.length} collections.`);
  else if (c.back.length > 0) parts.push(`It’s back in ${andList(c.back.map((b) => `“${b.title}”`))}.`);
  const other = c.back.length ? 'other ' : '';
  if (c.gone === 1) parts.push(`The ${other}collection it was in has been deleted since, so it isn’t in that one.`);
  else if (c.gone > 1) parts.push(`${c.gone} ${other}collections it was in have been deleted since, so it isn’t in those.`);
  return parts.join(' ');
}

/** Put a just-deleted thing back (the toast's Undo). */
export async function restoreDeleted(trashId: string | null | undefined, title?: string): Promise<void> {
  if (!trashId) return;
  const r = await api.trash.restore(trashId);
  if (title && r.collections) showToast(restoredWords(title, r));
}

function when(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function RecentlyDeleted() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['trash'], queryFn: api.trash.list, staleTime: 30_000 });
  const refresh = (kind?: TrashItem['kind']) => {
    void qc.invalidateQueries({ queryKey: ['trash'] });
    if (kind) void invalidateFor(qc, kind);
  };
  const restore = useMutation({
    mutationFn: (t: TrashItem) => api.trash.restore(t.id),
    onSuccess: (r, t) => {
      refresh(t.kind);
      showToast(restoredWords(t.title, r));
    },
  });
  const erase = useMutation({ mutationFn: (t: TrashItem) => api.trash.remove(t.id), onSuccess: () => refresh() });
  const items = list.data?.items ?? [];
  if (items.length === 0) return null;
  const error = restore.error ?? erase.error;
  return (
    <section aria-labelledby="trash-title" data-testid="recently-deleted" className="space-y-2">
      <details className="rounded-section border border-line bg-panel">
        <summary className="tap-target flex cursor-pointer items-center justify-between gap-2 px-4 py-3">
          <h2 id="trash-title" className="text-sm font-semibold uppercase tracking-wide text-muted">
            Recently deleted ({items.length})
          </h2>
          <span className="text-xs text-muted">Kept {list.data?.days ?? 30} days, then gone for good</span>
        </summary>
        <ul className="divide-y divide-line border-t border-line">
          {items.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
              <span className="min-w-0">
                <span className="block break-words text-sm text-ink">
                  <span className="mr-2 rounded bg-soft px-1.5 py-0.5 text-xs text-muted">{KIND_WORD[t.kind]}</span>
                  {t.title}
                </span>
                <span className="block text-xs text-muted">
                  Deleted {when(t.deletedAt)} · gone for good on {when(t.purgeAt)}
                </span>
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  disabled={restore.isPending}
                  onClick={() => restore.mutate(t)}
                  className="tap-target rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50"
                >
                  Restore
                </button>
                <button
                  type="button"
                  disabled={erase.isPending}
                  onClick={async () => {
                    const ok = await confirmDelete(t.title, {
                      title: `Delete “${t.title}” for good?`,
                      removes: `The ${t.kind} is erased now instead of in ${Math.max(1, Math.ceil((t.purgeAt - Date.now()) / 86_400_000))} days.`,
                      confirmLabel: 'Delete now',
                    });
                    if (ok) erase.mutate(t);
                  }}
                  className="tap-target rounded-lg border border-border px-3 py-1.5 text-sm text-danger hover:bg-soft disabled:opacity-50"
                >
                  Delete now
                </button>
              </span>
            </li>
          ))}
        </ul>
      </details>
      {error && <p className="text-sm text-danger">{(error as Error).message}</p>}
    </section>
  );
}
