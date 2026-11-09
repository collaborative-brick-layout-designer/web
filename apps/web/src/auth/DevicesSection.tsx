import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiTokenSummary, type SessionSummary } from '../api';
import { confirmDelete, toastDeleted } from '../ui/ConfirmDialog';
import { HelpButton } from '../help/HelpButton';
import { plural } from '../ui/plural';

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function scopeSummary(t: Pick<ApiTokenSummary, 'scopes'>): string {
  const has = (s: ApiTokenSummary['scopes'][number]) => t.scopes.includes(s);
  const parts = [has('layouts:write') ? 'Read & edit' : 'Read only'];
  if (has('layouts:create')) parts.push('publish layouts');
  if (has('parts:write')) parts.push('upload & delete parts');
  else if (has('parts:read')) parts.push('download parts');
  if (has('venues:write')) parts.push('save venues');
  else if (has('venues:read')) parts.push('download venues');
  if (has('account:prefs')) parts.push('sync settings');
  return parts.join(', ');
}

/**
 * Profile-page list of the desktop apps signed in to this account (API
 * tokens minted by the device-code flow), with Revoke. Revoking closes
 * the device's live connections straight away.
 */
export function DevicesSection() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ['api-tokens'], queryFn: api.tokens.list });
  const revoke = useMutation({
    mutationFn: (id: string) => api.tokens.revoke(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-tokens'] }),
  });

  return (
    <section id="devices" className="scroll-mt-6 space-y-2">
      <h2 className="flex items-center gap-1 text-sm font-semibold uppercase tracking-wide text-muted">
        Browsers and devices <HelpButton helpKey="account.devices" target="#devices" />
      </h2>
      <BrowsersList />
      <h3 className="pt-2 font-medium">Desktop apps</h3>
      <p className="text-sm text-muted">
        Desktop apps signed in to your account. To add one, choose “Sign in” in the desktop app and
        follow its instructions.
      </p>
      {tokens.isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : tokens.isError ? (
        <p className="text-sm text-danger">{(tokens.error as Error).message}</p>
      ) : tokens.data!.tokens.length === 0 ? (
        <p className="rounded-lg border border-line px-4 py-3 text-sm text-muted">
          No desktop apps signed in.
        </p>
      ) : (
        <ul className="rounded-lg border border-line">
          {tokens.data!.tokens.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between gap-4 border-b border-line px-4 py-2 last:border-b-0"
            >
              <div className="min-w-0">
                <div className="truncate">
                  {t.name}{' '}
                  <span className="font-mono text-xs text-muted">
                    {t.prefix}…{t.last4}
                  </span>
                </div>
                <div className="text-xs text-muted">
                  {scopeSummary(t)} · Created {formatDate(t.createdAt)} · Last used{' '}
                  {t.lastUsedAt ? formatDate(t.lastUsedAt) : 'never'} · Expires {formatDate(t.expiresAt)}
                </div>
              </div>
              <button
                onClick={async () => {
                  const ok = await confirmDelete(t.name, {
                    verb: 'Revoke',
                    removes: 'This device is signed out and can’t reach your account any more.',
                    keeps: 'Nothing on the server is deleted. You can sign that device in again later.',
                  });
                  if (ok) revoke.mutate(t.id, { onSuccess: () => toastDeleted(t.name) });
                }}
                disabled={revoke.isPending}
                aria-label={`Revoke ${t.name}`}
                className="shrink-0 text-sm text-danger hover:underline disabled:opacity-50"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {revoke.isError && <p className="text-sm text-danger">{(revoke.error as Error).message}</p>}
    </section>
  );
}

function browserTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The web browsers signed in to this account, this one first, each with Sign out. */
function BrowsersList() {
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions.list });
  const refresh = () => qc.invalidateQueries({ queryKey: ['sessions'] });
  const signOut = useMutation({ mutationFn: (id: string) => api.sessions.signOut(id), onSuccess: refresh });
  const others = useMutation({ mutationFn: () => api.sessions.signOutOthers(), onSuccess: refresh });
  const name = (s: SessionSummary) => s.device ?? 'A browser';
  const list = sessions.data?.sessions ?? [];
  const otherCount = list.filter((s) => !s.current).length;

  return (
    <div className="space-y-2" data-testid="browsers">
      <h3 className="font-medium">Browsers</h3>
      {sessions.isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : sessions.isError ? (
        <p className="text-sm text-danger">{(sessions.error as Error).message}</p>
      ) : (
        <ul className="rounded-lg border border-line" aria-label="Browsers signed in">
          {list.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-4 border-b border-line px-4 py-2 last:border-b-0">
              <div className="min-w-0">
                <div className="truncate">
                  {name(s)}
                  {s.current && <span className="ml-2 rounded-md bg-ok-soft px-1.5 py-0.5 text-xs text-ok">This browser</span>}
                </div>
                <div className="text-xs text-muted">
                  Signed in {browserTime(s.createdAt)}
                  {s.lastUsedAt && !s.current ? ` · Last used ${browserTime(s.lastUsedAt)}` : ''}
                </div>
              </div>
              {!s.current && (
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await confirmDelete(name(s), {
                      verb: 'Sign out',
                      removes: 'That browser is signed out now. Any layout it has open stops syncing.',
                      keeps: 'Nothing is deleted. You can sign in there again any time.',
                    });
                    if (ok) signOut.mutate(s.id);
                  }}
                  disabled={signOut.isPending}
                  aria-label={`Sign out ${name(s)}, signed in ${browserTime(s.createdAt)}`}
                  className="shrink-0 text-sm text-danger hover:underline disabled:opacity-50"
                >
                  Sign out
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {otherCount > 0 && (
        <button
          type="button"
          onClick={() => others.mutate()}
          disabled={others.isPending}
          className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-soft disabled:opacity-50"
        >
          Sign out of my other browsers
        </button>
      )}
      {others.isSuccess && (
        <p className="text-sm text-ok" role="status">
          {plural(others.data.signedOut, 'other browser')} signed out. You’re still signed in here.
        </p>
      )}
      {(signOut.isError || others.isError) && <p className="text-sm text-danger">{((signOut.error ?? others.error) as Error).message}</p>}
    </div>
  );
}
