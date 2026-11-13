// Home: club invites waiting for someone who already has an account, so
// they can join without finding the email. Join answers it; the invite's
// own page says more.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { ConfirmEmailPrompt } from '../auth/ConfirmEmailPrompt';

export function MyInvites() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const invites = useQuery({ queryKey: ['my-org-invites'], queryFn: api.orgInvites.mine, staleTime: 30_000 });
  const join = useMutation({
    mutationFn: (token: string) => api.orgInvites.accept(token),
    onSuccess: async (_r, token) => {
      const slug = invites.data?.invites.find((i) => i.token === token)?.orgSlug;
      await Promise.all([qc.invalidateQueries({ queryKey: ['my-org-invites'] }), qc.invalidateQueries({ queryKey: ['orgs'] })]);
      if (slug) navigate(`/orgs/${slug}`);
    },
  });
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const list = invites.data?.invites ?? [];
  // Not confirmed yet: the list stays empty until the address is proven, so say how.
  if (me.data?.user?.emailProven === false && !me.data.user.isDemoAccount) {
    return <ConfirmEmailPrompt toDo="see club invites sent to it" compact dismissKey={`cld.confirmEmail.dismissed.${me.data.user.id}`} />;
  }
  if (list.length === 0) return null;
  return (
    <section aria-labelledby="my-invites-title" data-testid="my-invites" className="space-y-2 rounded-section border border-accent bg-accent-soft/40 p-4">
      <h2 id="my-invites-title" className="font-semibold text-ink">
        {list.length === 1 ? 'You’re invited to a club' : `You’re invited to ${list.length} clubs`}
      </h2>
      <ul className="space-y-2">
        {list.map((i) => (
          <li key={i.token} className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-ink">
              <b>{i.orgName}</b>
              {i.roleName ? ` as ${i.roleName}` : ''}
              {i.invitedBy ? <span className="text-muted">, from {i.invitedBy}</span> : null}
            </span>
            <span className="flex items-center gap-2">
              <Link to={`/org-invite/${encodeURIComponent(i.token)}`} className="tap-target rounded-lg px-2 py-1.5 text-sm font-semibold text-accent-text underline underline-offset-2">
                Details
              </Link>
              <button
                type="button"
                disabled={join.isPending}
                onClick={() => join.mutate(i.token)}
                className="tap-target rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50"
              >
                Join {i.orgName}
              </button>
            </span>
          </li>
        ))}
      </ul>
      {join.isError && <p className="text-sm text-danger">{(join.error as Error).message}</p>}
    </section>
  );
}
