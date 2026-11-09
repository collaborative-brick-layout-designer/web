import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { DeadLinkHelp, SwitchAccountButton } from '../auth/signIn';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../api';

/**
 * /transfer/:token landing — accept a user→user layout transfer. Same
 * email-match guard as the layout-invite landing.
 */
export function TransferPage() {
  const params = useParams<{ token: string }>();
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const preview = useQuery({
    queryKey: ['transfer-preview', params.token],
    queryFn: () => api.transfers.preview(params.token!),
    enabled: !!params.token,
  });
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = useMutation({
    mutationFn: () => api.transfers.accept(params.token!),
    onSuccess: (res) => {
      setAccepted(true);
      setTimeout(() => navigate(`/editor/${res.layoutId}`), 600);
    },
    onError: (e: Error) => setError(e.message),
  });

  // The server says whether it's for this account (the address is masked otherwise).
  const matches = !!preview.data && !!me.data?.user && preview.data.forYou === true;
  useEffect(() => {
    if (matches && !accept.isPending && !accept.isSuccess && !accept.isError) accept.mutate();
  }, [matches, accept]);

  if (!params.token) return <Navigate to="/" replace />;
  if (preview.isLoading || me.isLoading) return <Centered>Loading transfer…</Centered>;

  if (preview.isError) {
    return (
      <Centered>
        <Box>
          <p className="font-semibold text-danger">This transfer isn't valid.</p>
          <p className="mt-1 text-xs">{(preview.error as Error).message}</p>
          <DeadLinkHelp what="transfer link" />
        </Box>
      </Centered>
    );
  }

  const t = preview.data!;
  const isSignedIn = !!me.data?.user;
  const wrongUser = isSignedIn && !matches;

  if (accepted) return <Centered>Transfer accepted. Opening the editor…</Centered>;

  return (
    <Centered>
      <Box>
        <h1 className="text-lg font-semibold">Layout transfer</h1>
        <p className="mt-2 text-sm text-muted">
          You've been offered ownership of <strong>{t.layoutTitle}</strong>. Accepting
          makes you the new owner; the previous owner stays as an editor.
        </p>
        {!isSignedIn && (
          <Link
            to={`/login?next=${encodeURIComponent(`/transfer/${params.token}`)}`}
            className="mt-3 flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 py-2 text-center text-accent-ink hover:bg-accent-hover"
          >
            Sign in as {t.recipientEmail}
          </Link>
        )}
        {wrongUser && (
          <p className="mt-3 rounded-lg border border-amber-900 bg-amber-950/30 p-3 text-xs text-amber-200">
            This transfer is for <strong>{t.recipientEmail}</strong>, but you're signed
            in as <strong>{me.data!.user!.email}</strong>.
            <SwitchAccountButton className="mt-2 block" />
          </p>
        )}
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
