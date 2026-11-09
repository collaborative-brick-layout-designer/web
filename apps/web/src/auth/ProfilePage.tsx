import { useState } from 'react';

import { SignInFirst } from './signIn';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { AppHeader } from '../AppHeader';
import { DevicesSection } from './DevicesSection';
import { MyDataSection } from '../privacy/MyDataSection';
import { DeleteAccountSection } from '../privacy/DeleteAccount';
import { HelpButton } from '../help/HelpButton';
import { useHashScroll } from '../ui/useHashScroll';
import { SetPasswordForm } from './SetPasswordForm';
import { ChangePasswordForm } from './ChangePasswordForm';

export function ProfilePage() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.providers });

  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [error, setError] = useState<string | null>(null);

  // /profile#name, #sign-in, #devices (the header's Settings menu) open at that part.
  useHashScroll(!!me.data?.user);

  const saveName = useMutation({
    mutationFn: (displayName: string) => api.updateDisplayName(displayName),
    onSuccess: () => {
      setEditing(false);
      setError(null);
      // Awareness (live cursors/presence) reads displayName from this
      // same cached `me` query — see useAwareness.ts — so invalidating
      // it is also what makes a rename show up for peers in an open
      // editor session on the next presence broadcast.
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e: Error) => setError(e.message),
  });

  if (me.isLoading) return <div className="p-8 text-muted">Loading…</div>;
  if (!me.data?.user) return <SignInFirst />;
  const user = me.data.user;

  return (
    <div className="h-full overflow-y-auto p-8">
      <AppHeader user={user} />
      <main className="mx-auto mt-8 max-w-2xl space-y-6">
        <header id="name" className="flex scroll-mt-6 items-center gap-4">
          {user.avatarUrl && <img src={user.avatarUrl} alt="" className="h-16 w-16 rounded-full" />}
          <div className="flex-1">
            {editing ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const trimmed = draftName.trim();
                  if (trimmed.includes('@')) {
                    setError('Other people see your name, so it can’t be an email address. Try your first name or a nickname.');
                    return;
                  }
                  if (trimmed) saveName.mutate(trimmed);
                }}
                className="flex items-center gap-2"
              >
                <input
                  autoFocus
                  aria-label="Your name (shown to others)"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  maxLength={60}
                  className="rounded-lg border border-border bg-soft px-2 py-1 text-xl font-semibold"
                />
                <button
                  type="submit"
                  disabled={saveName.isPending || draftName.trim() === ''}
                  className="rounded-lg bg-accent text-accent-ink px-3 py-1 text-sm hover:bg-accent-hover disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => { setEditing(false); setError(null); }}
                  className="text-sm text-muted hover:underline"
                >
                  Cancel
                </button>
              </form>
            ) : (
              <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
                {user.displayName || <span className="text-muted">No name yet</span>}
                <HelpButton helpKey="account.publicName" />
                {!user.isDemoAccount && (
                  <button
                    onClick={() => { setDraftName(user.displayName); setEditing(true); }}
                    className="text-xs font-normal text-accent-text hover:underline"
                  >
                    Edit
                  </button>
                )}
              </h1>
            )}
            {error && <p className="mt-1 text-sm text-danger">{error}</p>}
            {user.isDemoAccount ? (
              <p className="text-xs text-amber-400">The shared demo account: it resets itself, and its name, password, sign-in and desktop app can’t be changed.</p>
            ) : (
              <p className="text-sm text-muted">{user.email}</p>
            )}
          </div>
        </header>

        {!user.isDemoAccount && (
        <section id="sign-in" className="scroll-mt-6 space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Linked sign-in methods
          </h2>
          <ul className="rounded-lg border border-line">
            {providers.data?.providers.map((p) => {
              const linked = user.linkedProviders.includes(p.id);
              return (
                <li
                  key={p.id}
                  className="flex items-center justify-between border-b border-line px-4 py-2 last:border-b-0"
                >
                  <span className={p.enabled ? '' : 'text-muted'}>{p.label}</span>
                  {linked ? (
                    <span className="text-sm text-emerald-400">linked</span>
                  ) : p.enabled ? (
                    <a href={`/api/auth/${p.id}`} className="text-sm text-accent-text hover:underline">
                      link
                    </a>
                  ) : (
                    <span className="text-sm text-muted">disabled</span>
                  )}
                </li>
              );
            })}
          </ul>
          {providers.data?.passwordEnabled && user.hasPassword && (
            <div className="space-y-2 rounded-lg border border-line p-4" id="password">
              <h3 className="flex items-center gap-1 font-medium">
                Password <HelpButton helpKey="account.password" target="#password" />
              </h3>
              <p className="text-sm text-muted">Change the password you sign in with. Your other browsers and desktop apps are signed out.</p>
              <ChangePasswordForm />
            </div>
          )}
          {providers.data?.passwordEnabled && user.hasPassword === false && (
            <div className="space-y-2 rounded-lg border border-line p-4" data-testid="set-password">
              <h3 className="font-medium">Password</h3>
              <p className="text-sm text-muted">This account has no password yet. Choose one to sign in with your email address.</p>
              <SetPasswordForm />
            </div>
          )}
        </section>
        )}

        {!user.isDemoAccount && <DevicesSection />}

        {!user.isDemoAccount && <MyDataSection />}

        {!user.isDemoAccount && <DeleteAccountSection email={user.email} name={user.displayName} />}
      </main>
    </div>
  );
}
