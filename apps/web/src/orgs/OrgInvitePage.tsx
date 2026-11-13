import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { DeadLinkHelp, SwitchAccountButton } from '../auth/signIn';
import { ConfirmEmailPrompt } from '../auth/ConfirmEmailPrompt';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { asRole } from './clubRoles';

/**
 * /org-invite/:token landing — same shape as the layout-invite page,
 * but for joining an org. Auto-accepts when the server says the invite
 * is for the signed-in account; otherwise prompts to sign in or surfaces
 * an email-mismatch notice (the address is masked unless it's yours).
 */
export function OrgInvitePage() {
  const params = useParams<{ token: string }>();
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const preview = useQuery({
    // Keyed on who's signed in: the answer says whether it's for them.
    queryKey: ['org-invite-preview', params.token, me.data?.user?.id ?? null],
    queryFn: () => api.orgInvites.preview(params.token!),
    enabled: !!params.token && !me.isLoading,
  });
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = useMutation({
    mutationFn: () => api.orgInvites.accept(params.token!),
    onSuccess: () => {
      setAccepted(true);
      setTimeout(() => navigate(`/orgs/${preview.data!.orgSlug}`), 600);
    },
    onError: (e: Error) => setError(e.message),
  });

  // An address not confirmed yet: offer the confirmation email first; once
  // it's confirmed (the live `me` hint) this accepts by itself.
  const needsConfirm = !!preview.data && !!me.data?.user && preview.data.forYou === true && me.data.user.emailProven === false;
  useEffect(() => {
    if (
      preview.data &&
      me.data?.user &&
      preview.data.forYou === true &&
      !needsConfirm &&
      !accept.isPending &&
      !accept.isSuccess &&
      !accept.isError
    ) {
      accept.mutate();
    }
  }, [preview.data, me.data, needsConfirm, accept]);

  if (!params.token) return <Navigate to="/" replace />;
  if (preview.isLoading || me.isLoading) return <Centered>Loading…</Centered>;

  if (preview.isError) {
    return (
      <Centered>
        <Box>
          <p className="font-semibold text-danger">This invite isn't valid.</p>
          <p className="mt-1 text-xs">{(preview.error as Error).message}</p>
          <DeadLinkHelp what="invite" />
        </Box>
      </Centered>
    );
  }

  const inv = preview.data!;
  const isSignedIn = !!me.data?.user;
  const wrongUser =
    isSignedIn && inv.forYou === false;

  if (accepted) return <Centered>Joined! Opening the club…</Centered>;

  return (
    <Centered>
      <Box>
        <h1 className="text-lg font-semibold">You're invited</h1>
        <p className="mt-2 text-sm text-muted">
          You've been invited to join <strong>{inv.orgName}</strong> {asRole(inv.role, inv.roleName)}.
        </p>
        {!isSignedIn && (
          <Link
            to={`/login?next=${encodeURIComponent(`/org-invite/${params.token}`)}`}
            className="mt-3 flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 py-2 text-center text-accent-ink hover:bg-accent-hover"
          >
            Sign in as {inv.invitedEmail}
          </Link>
        )}
        {wrongUser && (
          <p className="mt-3 rounded-lg border border-amber-900 bg-amber-950/30 p-3 text-xs text-amber-200">
            The invite is for <strong>{inv.invitedEmail}</strong>, but you're signed in
            as <strong>{me.data!.user!.email}</strong>. Sign out and back in with the
            matching email.
            <SwitchAccountButton className="mt-2 block" />
          </p>
        )}
        {needsConfirm && <ConfirmEmailPrompt toDo="join this club" />}
        {error && (
          <p className="mt-2 rounded-lg border border-red-900 bg-red-950/30 p-3 text-xs text-red-300">
            Couldn't accept: {error}
          </p>
        )}
      </Box>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-screen place-items-center px-4">{children}</div>;
}

function Box({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full max-w-md rounded-lg border border-line bg-panel p-6">
      {children}
    </div>
  );
}
