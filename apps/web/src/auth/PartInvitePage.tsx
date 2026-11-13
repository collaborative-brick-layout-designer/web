import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { ConfirmEmailPrompt } from './ConfirmEmailPrompt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeadLinkHelp, SwitchAccountButton } from './signIn';
import { api } from '../api';

/**
 * Accepting an invite to a custom part (like ModuleInvitePage):
 *
 *   1. Not signed in → "Sign in as ‹email› to accept", back here after.
 *   2. Signed in as someone else → say so, offer to switch accounts.
 *   3. Signed in as the invited person → accept straight away, then open
 *      the parts on the home page.
 */
export function PartInvitePage() {
  const params = useParams<{ token: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const preview = useQuery({
    queryKey: ['part-invite-preview', params.token],
    queryFn: () => api.partInvites.preview(params.token!),
    enabled: !!params.token,
    retry: false,
  });
  const [accepted, setAccepted] = useState(false);
  const [cameAlong, setCameAlong] = useState(0);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  const accept = useMutation({
    mutationFn: () => api.partInvites.accept(params.token!),
    onSuccess: (res) => {
      setCameAlong(res.setParts?.length ?? 0);
      setAccepted(true);
      void qc.invalidateQueries({ queryKey: ['custom-parts'] });
      void qc.invalidateQueries({ queryKey: ['parts-catalog'] });
      // The home page's parts section (CustomPartsSection's PARTS_SECTION).
      setTimeout(() => navigate({ pathname: '/', hash: '#parts' }), 600);
    },
    onError: (e: Error) => setAcceptError(e.message),
  });

  // The server says whether it's for this account (the address is masked otherwise).
  const matches = !!preview.data && !!me.data?.user && preview.data.forYou === true;
  // An address not confirmed yet: offer the confirmation email first; once
  // it's confirmed (the live `me` hint) this accepts by itself.
  const needsConfirm = matches && me.data?.user?.emailProven === false;
  useEffect(() => {
    if (matches && !needsConfirm && !accept.isPending && !accept.isSuccess && !accept.isError) accept.mutate();
  }, [matches, needsConfirm, accept]);

  if (!params.token) return <Navigate to="/" replace />;
  if (preview.isLoading || me.isLoading) return <Centered>Loading invite…</Centered>;

  if (preview.isError) {
    return (
      <Centered>
        <div className="w-full max-w-md">
          <Note tone="error" title="This invite isn't valid." body={(preview.error as Error).message ?? 'Unknown error'} />
          <DeadLinkHelp what="invite" />
        </div>
      </Centered>
    );
  }

  const inv = preview.data!;
  const isSignedIn = !!me.data?.user;
  if (accepted)
    return (
      <Centered>
        {cameAlong > 0 ? `You have the set and ${cameAlong === 1 ? 'its part' : `its ${cameAlong} parts`}! Opening your parts…` : 'You have it! Opening your parts…'}
      </Centered>
    );

  return (
    <Centered>
      <div className="w-full max-w-md space-y-4 rounded-lg border border-line bg-panel p-6">
        <h1 className="text-lg font-semibold">You're invited</h1>
        <p className="text-sm text-muted">
          You've been invited to {inv.isSet ? 'the set' : 'the custom part'} <strong>{inv.partName}</strong>
          {inv.partNumber !== inv.partName && ` (${inv.partNumber})`} as {inv.role === 'editor' ? 'an editor' : 'a viewer'}.
        </p>
        {inv.setParts && inv.setParts.length > 0 && (
          <div className="text-sm text-muted" data-testid="invite-set-parts">
            <p>It's a set, so {inv.setParts.length === 1 ? 'this part of theirs comes' : `these ${inv.setParts.length} parts of theirs come`} with it, to look at and place:</p>
            <ul className="mt-1 list-inside list-disc text-xs">
              {inv.setParts.map((p) => (
                <li key={p.partNumber} className="break-words">
                  {p.displayName && p.displayName !== p.partNumber ? `${p.displayName} (${p.partNumber})` : p.partNumber}
                </li>
              ))}
            </ul>
          </div>
        )}
        {!isSignedIn && (
          <>
            <p className="text-sm text-neutral-300">
              Sign in as <strong>{inv.invitedEmail}</strong> to accept.
            </p>
            <Link
              to={`/login?next=${encodeURIComponent(`/part-invite/${params.token}`)}`}
              className="flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 py-2 text-center text-accent-ink hover:bg-accent-hover"
            >
              Sign in
            </Link>
          </>
        )}
        {isSignedIn && !matches && (
          <Note
            tone="warn"
            title="This invite is for a different account."
            body={
              <>
                The invite is for <strong>{inv.invitedEmail}</strong>, but you're signed in as <strong>{me.data!.user!.email}</strong>. Sign out and back in
                with the matching email.
                <SwitchAccountButton className="mt-2 block" />
              </>
            }
          />
        )}
        {matches && accept.isPending && <p className="text-sm text-muted">Accepting…</p>}
        {needsConfirm && <ConfirmEmailPrompt toDo="accept this invite" />}
        {acceptError && <Note tone="error" title="Couldn't accept the invite." body={acceptError} />}
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-screen place-items-center px-4">{children}</div>;
}

function Note({ tone, title, body }: { tone: 'error' | 'warn'; title: string; body: React.ReactNode }) {
  const color = tone === 'error' ? 'border-red-900 bg-red-950/30 text-red-300' : 'border-amber-900 bg-amber-950/30 text-amber-200';
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-lg border ${color} p-3 text-sm`}>
      <p className="font-semibold">{title}</p>
      <div className="mt-1 text-xs">{body}</div>
    </div>
  );
}
