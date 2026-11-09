import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

/**
 * The "Forgot password?" email's link: choose a new password. The link
 * works once, for an hour; the page checks it first, so nobody types a
 * new password into a link that's run out. Saving signs every other
 * browser and desktop app out and this browser in.
 */
export function ResetPasswordPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const check = useQuery({ queryKey: ['reset-link', token], queryFn: () => api.checkResetLink(token!), enabled: !!token, retry: false, staleTime: Infinity });
  const save = useMutation({
    mutationFn: () => api.resetPassword(token!, password),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me'] });
      setTimeout(() => navigate('/', { replace: true }), 900);
    },
    onError: (e: Error) => setError(e.message),
  });

  if (!token) return <Navigate to="/login" replace />;

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm space-y-4 rounded-lg border border-line bg-panel p-8 text-center shadow-sm">
        <img src="/logo.png" alt="" className="mx-auto h-12 w-12 rounded-lg" />
        <h1 className="text-lg font-semibold">Choose a new password</h1>
        {check.isLoading && <p className="text-muted">Checking the link…</p>}
        {check.isError && (
          <>
            <p className="text-danger" role="alert">
              {(check.error as Error).message}
            </p>
            <Link to="/login?forgot=1" className="tap-target inline-flex items-center text-sm text-accent-text hover:underline">
              Ask for a new link
            </Link>
          </>
        )}
        {check.isSuccess && save.isSuccess && (
          <p className="text-ok" role="status">
            Password changed. You’re signed in here, and signed out everywhere else. Taking you in…
          </p>
        )}
        {check.isSuccess && !save.isSuccess && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              if (password.length < 8) return setError('Use at least 8 characters.');
              if (password !== confirm) return setError('The two passwords don’t match.');
              save.mutate();
            }}
            className="space-y-2 text-left"
          >
            <p className="text-sm text-muted">This signs you out of your other browsers and desktop apps.</p>
            <input
              type="password"
              aria-label="New password"
              placeholder="New password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              className="w-full rounded-lg border border-border bg-soft px-3 py-2"
            />
            <input
              type="password"
              aria-label="New password again"
              placeholder="New password again"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              className="w-full rounded-lg border border-border bg-soft px-3 py-2"
            />
            {error && (
              <p className="text-sm text-danger" role="alert">
                {error}
              </p>
            )}
            <button type="submit" disabled={save.isPending} className="w-full rounded-lg bg-accent py-2 text-accent-ink hover:bg-accent-hover disabled:opacity-50">
              {save.isPending ? 'Saving…' : 'Save new password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
