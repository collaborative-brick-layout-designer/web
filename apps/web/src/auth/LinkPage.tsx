import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, type ProviderId } from '../api';

const LABELS: Record<ProviderId, string> = { github: 'GitHub', google: 'Google', oidc: 'single sign-on' };

/**
 * A GitHub or Google sign-in whose email matched an account already here.
 * Nothing is linked by the email alone: the server keeps the pending link
 * (auth/pendingLinks.ts) until someone signed in to that account says yes
 * here. Signed in as someone else, or not at all, the page asks them to
 * sign in to that account first and brings them back.
 */
export function LinkPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pending = useQuery({ queryKey: ['pending-link'], queryFn: api.pendingLink, retry: false });
  // (For "Forgot password?": only where signing in with a password is on.)
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.providers });
  const confirm = useMutation({
    mutationFn: api.confirmLink,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      await qc.invalidateQueries({ queryKey: ['pending-link'] });
      navigate('/profile#sign-in');
    },
  });
  const cancel = useMutation({
    mutationFn: api.cancelLink,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['pending-link'] });
      navigate('/');
    },
  });

  const label = pending.data ? LABELS[pending.data.provider] : '';
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-md space-y-4 rounded-lg border border-line bg-panel p-8 text-center">
        {pending.isLoading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : !pending.data ? (
          <>
            <h1 className="text-xl font-semibold">Nothing to link</h1>
            <p className="text-sm text-muted">
              That sign-in has run out or was already used. Sign in again to link it.
            </p>
            <Link to="/login" className="tap-target inline-flex items-center text-accent-text hover:underline">
              Go to sign in
            </Link>
          </>
        ) : pending.data.signedInAsTarget ? (
          <>
            <h1 className="text-xl font-semibold">Link {label} to your account?</h1>
            <p className="text-sm text-muted">
              Its email address matches this account. Once linked, “Continue with {label}” signs you in here.
            </p>
            {confirm.error && (
              <p role="alert" className="text-sm text-danger">
                {(confirm.error as Error).message}
              </p>
            )}
            <div className="flex justify-center gap-2">
              <button
                type="button"
                className="tap-target rounded-lg bg-accent px-4 py-2 font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-60"
                disabled={confirm.isPending}
                onClick={() => confirm.mutate()}
              >
                Link {label}
              </button>
              <button
                type="button"
                className="tap-target rounded-lg border border-border px-4 py-2"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Don’t link
              </button>
            </div>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold">Link this account?</h1>
            <p className="text-sm text-muted">
              That {label} account’s email matches an account here. To link them, sign in to that account first
              (with its password, or a sign-in method it already has), then come back to this page.
            </p>
            <div className="flex flex-col items-center gap-2">
              <Link
                to="/login?next=%2Flink"
                className="tap-target inline-flex items-center rounded-lg bg-accent px-4 py-2 font-semibold text-accent-ink hover:bg-accent-hover"
              >
                Sign in to that account
              </Link>
              {providers.data?.passwordEnabled && (
                <p className="text-sm text-muted">
                  Don’t know its password?{' '}
                  <Link to="/login?forgot=1&next=%2Flink" className="tap-target inline-flex items-center text-accent-text hover:underline">
                    Forgot password?
                  </Link>{' '}
                  We’ll email you a link to choose a new one; then sign in and come back here.
                </p>
              )}
              <button
                type="button"
                className="tap-target text-sm text-accent-text hover:underline"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Don’t link
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
