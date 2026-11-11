import { useState, type FormEvent } from 'react';
import { ClubLogo } from './ClubLogo';
import { Link, useNavigate } from 'react-router-dom';
import { SignInFirst } from '../auth/signIn';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { AppHeader } from '../AppHeader';
import { FindClubSection } from './ClubDirectory';
import { yourRolesText } from './clubRoles';
import { BeingDeletedSection } from './DeleteClub';
import { useHashScroll } from '../ui/useHashScroll';

/** /orgs landing: the clubs the user is in, a create button, and Find a club. */
export function OrgsPage() {
  const list = useQuery({ queryKey: ['orgs'], queryFn: api.orgs.list });
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const [showCreate, setShowCreate] = useState(false);
  const waiting = useQuery({ queryKey: ['join-request-count'], queryFn: api.orgs.joinRequestCount, enabled: Boolean(me.data?.user) });
  const waitingIn = (slug: string) => waiting.data?.clubs.find((c) => c.slug === slug)?.count ?? 0;
  // /orgs#being-deleted (a member's notice links there).
  useHashScroll(!!list.data);

  if (me.isLoading) return <div className="p-8 text-muted">Loading…</div>;
  if (!me.data?.user) return <SignInFirst />;

  return (
    <div className="theme-page h-full overflow-y-auto bg-bg p-4 text-ink sm:p-8">
      <AppHeader user={me.data.user} />
      <main className="mx-auto mt-8 max-w-3xl space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Clubs</h1>
          {!me.data.user.isDemoAccount && (
            <button
              onClick={() => setShowCreate(true)}
              className="rounded-lg bg-accent text-accent-ink px-3 py-1.5 text-sm hover:bg-accent-hover"
            >
              New club
            </button>
          )}
        </div>

        <h2 className="text-lg font-semibold">Your clubs</h2>
        {list.isLoading && <p className="text-muted">Loading…</p>}
        {list.data && (list.data.orgs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-8 text-center text-muted">
            {me.data.user.isDemoAccount
              ? 'The demo account can’t make or join clubs. Make your own account for that; until then, have a look at the clubs below.'
              : 'You’re not in a club yet. Find one below, make one, or ask a club’s admin to invite you.'}
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {list.data.orgs.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <ClubLogo name={o.name} logoUrl={o.logoUrl} size={40} />
                <div className="min-w-0 grow">
                  <Link to={`/orgs/${o.slug}`} className="font-medium hover:underline">
                    {o.name}
                  </Link>
                  <p className="text-xs text-muted">
                    /{o.slug} · {yourRolesText(o)}
                  </p>
                  {waitingIn(o.slug) > 0 && (
                    <Link
                      to={`/orgs/${o.slug}/admin`}
                      className="mt-1 inline-flex rounded-full bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent-text hover:underline"
                    >
                      {waitingIn(o.slug) === 1 ? '1 request to join' : `${waitingIn(o.slug)} requests to join`}
                    </Link>
                  )}
                  {(o.pendingReviews ?? 0) > 0 && (
                    <Link
                      to={`/orgs/${o.slug}/admin?tab=review`}
                      data-testid="club-review-waiting"
                      className="ml-1 mt-1 inline-flex rounded-full bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent-text hover:underline"
                    >
                      {o.pendingReviews === 1 ? '1 share to review' : `${o.pendingReviews} shares to review`}
                    </Link>
                  )}
                </div>
                <Link
                  to={`/orgs/${o.slug}`}
                  className="tap-target inline-flex shrink-0 items-center rounded-lg border border-border px-3 py-1 text-sm hover:bg-soft"
                >
                  Open
                </Link>
              </li>
            ))}
          </ul>
        ))}

        <BeingDeletedSection />

        <div className="pt-4">
          <FindClubSection />
        </div>

        {showCreate && <CreateOrgDialog onClose={() => setShowCreate(false)} />}
      </main>
    </div>
  );
}

/**
 * Slug-from-name: lowercase, replace anything non-alnum with `-`,
 * collapse consecutive `-`, trim leading/trailing `-`, cap at 40
 * chars, fall back to `org` when the name has no usable characters.
 * Constraint matches the server's validator (a-z0-9 + hyphens, 1–40).
 */
export function slugifyOrgName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  return cleaned || 'org';
}

function CreateOrgDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Slug is server-side derived now; we only show a preview here.
  const slug = slugifyOrgName(name);
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () => api.orgs.create(name.trim()),
    // Straight to the new club's page, where its admin sets it up.
    onSuccess: (club) => {
      qc.invalidateQueries({ queryKey: ['orgs'] });
      onClose();
      navigate(`/orgs/${club.slug}`);
    },
    onError: (e: Error) => setError(e.message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    create.mutate();
  }

  return (
    <div className="fixed inset-0 grid place-items-center bg-black/60 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md space-y-4 rounded-lg border border-line bg-panel p-6"
      >
        <h3 className="text-lg font-semibold">New club</h3>
        <label className="block text-sm">
          <span className="mb-1 block text-muted">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="Acme Bricks"
            className="w-full rounded-lg border border-border bg-soft px-3 py-2"
          />
          {/* Slug is auto-derived from the name and kept read-only —
              users found the manual two-field form annoying, and the
              slug is mostly an implementation detail (it shows up in
              URLs but nobody cares whether it's `acme` vs `acme-bricks`). */}
          <p className="mt-1 text-xs text-muted">
            URL: <span className="text-neutral-300">/orgs/{slug}</span>
          </p>
        </label>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 hover:bg-soft"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={create.isPending || name.trim().length === 0}
            className="rounded-lg bg-accent text-accent-ink px-4 py-2 hover:bg-accent-hover disabled:opacity-50"
          >
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
