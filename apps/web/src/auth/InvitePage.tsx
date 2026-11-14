import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { ConfirmEmailPrompt } from './ConfirmEmailPrompt';
import { DeadLinkHelp, SwitchAccountButton } from './signIn';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../api';

/**
 * Invite-acceptance landing. Three states:
 *
 *   1. Not signed in → show "Sign in to accept" with the inviter's email
 *      pre-filled. The user is redirected back here after auth.
 *   2. Signed in as the wrong user → 403 from accept; offer to sign out.
 *   3. Signed in as the right user → POST /api/invites/:token automatically;
 *      redirect to /editor/:layoutId.
 */
export function InvitePage() {
  const params = useParams<{ token: string }>();
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const preview = useQuery({
    queryKey: ['invite-preview', params.token],
    queryFn: () => api.invites.preview(params.token!),
    enabled: !!params.token,
  });
  const [accepted, setAccepted] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  const accept = useMutation({
    mutationFn: () => api.invites.accept(params.token!),
    onSuccess: (res) => {
      setAccepted(true);
      // Brief pause so the user sees "joined!" before the editor mounts.
      setTimeout(() => navigate(`/editor/${res.layoutId}`), 600);
    },
    onError: (e: Error) => setAcceptError(e.message),
  });

  // Auto-accept once we know the user is signed in with the matching email.
  // The server says whether it's for this account (the address is masked otherwise).
  const matches = !!preview.data && !!me.data?.user && preview.data.forYou === true;
  // An address not confirmed yet: offer the confirmation email first; once
  // it's confirmed (the live `me` hint) this accepts by itself.
  const needsConfirm = matches && me.data?.user?.needsEmailConfirm === true;
  useEffect(() => {
    if (matches && !needsConfirm && !accept.isPending && !accept.isSuccess && !accept.isError) accept.mutate();
  }, [matches, needsConfirm, accept]);

  if (!params.token) return <Navigate to="/" replace />;

  if (preview.isLoading || me.isLoading)
    return <Centered>Loading invite…</Centered>;

  if (preview.isError) {
    return (
      <Centered>
        <div className="w-full max-w-md">
          <Alert
            tone="error"
            title="This invite isn't valid."
            body={(preview.error as Error).message ?? 'Unknown error'}
          />
          <DeadLinkHelp what="invite" />
        </div>
      </Centered>
    );
  }

  const inv = preview.data!;
  const isSignedIn = !!me.data?.user;
  const wrongUser = isSignedIn && !matches;

  if (accepted) {
    return <Centered>Joined! Opening the editor…</Centered>;
  }

  return (
    <Centered>
      <div className="w-full max-w-md space-y-4 rounded-lg border border-line bg-panel p-6">
        <h1 className="text-lg font-semibold">You're invited</h1>
        <p className="text-sm text-muted">
          You've been invited to <strong>{inv.layoutTitle}</strong> as {inv.role === 'editor' ? 'an editor' : 'a viewer'}.
        </p>

        {!isSignedIn && (
          <>
            <p className="text-sm text-neutral-300">
              Sign in as <strong>{inv.invitedEmail}</strong> to accept.
            </p>
            <Link
              to={`/login?next=${encodeURIComponent(`/invite/${params.token}`)}`}
              className="flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 py-2 text-center text-accent-ink hover:bg-accent-hover"
            >
              Sign in
            </Link>
          </>
        )}

        {wrongUser && (
          <Alert
            tone="warn"
            title="This invite is for a different account."
            body={
              <>
                The invite is for <strong>{inv.invitedEmail}</strong>, but
                you're signed in as <strong>{me.data!.user!.email}</strong>.
                Sign out and back in with the matching email.
                <SwitchAccountButton className="mt-2 block" />
              </>
            }
          />
        )}

        {needsConfirm && <ConfirmEmailPrompt toDo="accept this invite" />}
        {acceptError && (
          <Alert
            tone="error"
            title="Couldn't accept the invite."
            body={acceptError}
          />
        )}
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-screen place-items-center px-4">{children}</div>;
}

function Alert({
  tone,
  title,
  body,
}: {
  tone: 'error' | 'warn';
  title: string;
  body: React.ReactNode;
}) {
  const color =
    tone === 'error'
      ? 'border-red-900 bg-red-950/30 text-red-300'
      : 'border-amber-900 bg-amber-950/30 text-amber-200';
  return (
    <div className={`rounded-lg border ${color} p-3 text-sm`}>
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-xs">{body}</p>
    </div>
  );
}
