// The clubs part of a module's Share dialog (docs/shared-modules.md):
// share it, read-only, with a club you're in; stop, with what that means
// said first; and where the module is used, as counts and club names
// (never the names of other people's layouts). A club's module goes to the
// club's partner clubs at once, or is offered to any other club, whose
// Admins or Managers must accept it (docs/shared-modules.md, section 11).

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ModuleShares } from '../api';
import { askConfirm } from '../ui/ConfirmDialog';
import { HelpButton } from '../help/HelpButton';
import { Link } from 'react-router-dom';

/** "Used in 4 layouts (Riverside LUG: 3, Bob: 1)", or null when it's placed nowhere. */
export function usedInText(u: ModuleShares['usedIn']): string | null {
  if (u.layouts === 0) return null;
  const parts = [...u.clubs.map((c) => `${c.name}: ${c.layouts}`), ...u.people.map((p) => `${p.name}: ${p.layouts}`), ...(u.others > 0 ? [`others: ${u.others}`] : [])];
  return `Used in ${u.layouts} layout${u.layouts === 1 ? '' : 's'}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`;
}

/** What stopping a share with `who` leaves behind. */
export function stopShareText(title: string, who: string, layouts: number, version: number): { title: string; keeps: string; removes: string } {
  const v = version > 0 ? ` (version ${version})` : '';
  return {
    title: `Stop sharing with ${who}?`,
    keeps: layouts > 0 ? `${layouts === 1 ? 'Its layout keeps' : `Its ${layouts} layouts keep`} “${title}” as it is now${v}.` : `Nothing changes in any layout: “${title}” isn’t placed in one of theirs.`,
    removes: 'They won’t get your updates anymore, and can’t place it again.',
  };
}

export function ModuleClubShares({ moduleId, title }: { moduleId: string; title: string }) {
  const qc = useQueryClient();
  const key = ['module-shares', moduleId];
  const shares = useQuery({ queryKey: key, queryFn: () => api.modules.shares(moduleId) });
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['modules-shared'] });
  };
  const share = useMutation({
    mutationFn: (s: string) => api.modules.shareWithClub(moduleId, s),
    onSuccess: () => {
      setSlug('');
      setError(null);
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });
  const stop = useMutation({
    mutationFn: (orgId: string) => api.modules.stopClubShare(moduleId, orgId),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });
  const d = shares.data;
  if (!d) return shares.isError ? <p className="text-sm text-danger">{(shares.error as Error).message}</p> : null;
  const open = d.myClubs.filter((c) => !d.clubs.some((s) => s.orgId === c.orgId));
  const used = usedInText(d.usedIn);
  return (
    <section className="space-y-2" data-testid="module-club-shares">
      <h4 className="flex items-center gap-1 text-sm font-semibold">
        Clubs
        <HelpButton helpKey={d.canShareWithOtherClubs ? 'module.shareOtherClubs' : 'module.share'} />
      </h4>
      {d.canShareWithOtherClubs ? (
        <ClubToClub moduleId={moduleId} title={title} d={d} onShared={refresh} onError={setError} />
      ) : !d.canShareWithClubs ? (
        <p className="text-xs text-muted">This is a club’s module: its members already have it.</p>
      ) : (
        <>
          <p className="text-xs text-muted">A club you share with can place this module in the club’s layouts and gets your updates. Its members can’t change its parts.</p>
          {d.myClubs.length === 0 ? (
            <p className="text-xs text-muted">You’re not in a club yet. Join or start one to share with it.</p>
          ) : open.length > 0 ? (
            <form
              className="flex flex-wrap items-end gap-2 text-sm"
              onSubmit={(e) => {
                e.preventDefault();
                if (slug) share.mutate(slug);
              }}
            >
              <label className="min-w-0 flex-1">
                <span className="mb-1 block text-xs text-muted">Share with a club</span>
                <select value={slug} onChange={(e) => setSlug(e.target.value)} data-testid="module-club-pick" className="w-full rounded-lg border border-border bg-soft px-2 py-1.5">
                  <option value="">Pick a club…</option>
                  {open.map((c) => (
                    <option key={c.orgId} value={c.slug}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" disabled={!slug || share.isPending} className="min-h-9 rounded-lg bg-accent px-3 py-1.5 font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50">
                {share.isPending ? 'Sharing…' : 'Share'}
              </button>
            </form>
          ) : (
            <p className="text-xs text-muted">It’s shared with every club you’re in.</p>
          )}
        </>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      {d.clubs.length > 0 && (
        <ul className="divide-y divide-line/60 rounded-lg border border-line text-sm" data-testid="module-clubs">
          {d.clubs.map((c) => (
            <li key={c.orgId} className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 truncate">
                {c.name} <span className="text-xs text-muted">{viaWords(c.via)} · can place it</span>
              </span>
              <button
                type="button"
                disabled={stop.isPending}
                className="min-h-9 rounded-lg border border-border px-3 py-1 hover:bg-soft disabled:opacity-50"
                onClick={async () => {
                  const n = d.usedIn.clubs.find((u) => u.orgId === c.orgId)?.layouts ?? 0;
                  const t = stopShareText(title, c.name, n, d.latestVersion);
                  if (await askConfirm({ ...t, confirmLabel: 'Stop', danger: false })) stop.mutate(c.orgId);
                }}
              >
                Stop
              </button>
            </li>
          ))}
        </ul>
      )}
      {used && (
        <p className="text-xs text-muted" data-testid="module-used-in">
          {used}
        </p>
      )}
    </section>
  );
}

/** "(club)", "(partner club)" or "(accepted)": how a club came to have the module. */
export function viaWords(via: 'partner' | 'offer' | null | undefined): string {
  return via === 'partner' ? '(partner club)' : via === 'offer' ? '(club, accepted)' : '(club)';
}

/** One line for an offer: "Riverside LUG · waiting for them to accept", or "… · declined". */
export function offerWords(o: NonNullable<ModuleShares['offers']>[number], now = Date.now()): string {
  const who = o.club.name ?? `the club at /orgs/${o.club.slug}`;
  if (o.state === 'pending') return `${who} · waiting for them to accept`;
  return o.askAgainAt && o.askAgainAt > now ? `${who} · declined (you can offer it again in a day)` : `${who} · declined`;
}

const small = 'min-h-9 rounded-lg border border-border px-3 py-1 hover:bg-soft disabled:opacity-50';
const go = 'min-h-9 rounded-lg bg-accent px-3 py-1.5 font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50';

/**
 * A club's module: share it with a partner club (at once), or with another
 * club, found in the Clubs directory or by its link, which must accept it.
 */
function ClubToClub({
  moduleId,
  title,
  d,
  onShared,
  onError,
}: {
  moduleId: string;
  title: string;
  d: ModuleShares;
  onShared: () => void;
  onError: (e: string | null) => void;
}) {
  const [partner, setPartner] = useState('');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const isLink = /\/orgs\/[a-z0-9-]+/i.test(q);
  const targets = useQuery({
    queryKey: ['module-club-targets', moduleId, debounced],
    queryFn: () => api.modules.clubTargets(moduleId, debounced),
    enabled: debounced.length >= 2 && !isLink,
  });
  const send = useMutation({
    mutationFn: (slug: string) => api.modules.shareWithClub(moduleId, slug),
    onSuccess: (r) => {
      const who = r.name ?? `the club at /orgs/${r.slug}`;
      setSaid(r.status === 'offered' ? `Offered “${title}” to ${who}. It’s shared once their Admins or Managers accept it.` : `“${title}” is shared with ${who}.`);
      setPartner('');
      setQ('');
      onError(null);
      onShared();
    },
    onError: (e: Error) => {
      setSaid(null);
      onError(e.message);
      onShared();
    },
  });
  const withdraw = useMutation({
    mutationFn: (offerId: string) => api.modules.withdrawClubOffer(moduleId, offerId),
    onSuccess: () => {
      onError(null);
      onShared();
    },
    onError: (e: Error) => onError(e.message),
  });
  const shared = new Set(d.clubs.map((c) => c.orgId));
  const openPartners = (d.partners ?? []).filter((p) => !shared.has(p.orgId));
  const offers = d.offers ?? [];
  return (
    <div className="space-y-3" data-testid="club-to-club">
      <p className="text-xs text-muted">
        {d.club ? `This is ${d.club.name}’s module. ` : ''}Partner clubs get it straight away. Any other club must accept it first. Clubs you share with can place it in their layouts and get its updates; they can’t change its parts.
      </p>
      <form
        className="flex flex-wrap items-end gap-2 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (partner) send.mutate(partner);
        }}
      >
        <label className="min-w-0 flex-1">
          <span className="mb-1 block text-xs text-muted">Partner clubs</span>
          {(d.partners ?? []).length === 0 ? (
            <span className="block text-xs text-muted" data-testid="no-partners">
              {d.club ? (
                <>
                  {d.club.name} has no partner clubs yet.{' '}
                  <Link className="text-accent-text hover:underline" to={`/orgs/${d.club.slug}?tab=partners`}>
                    Ask a club to be partners
                  </Link>
                </>
              ) : (
                'No partner clubs yet.'
              )}
            </span>
          ) : openPartners.length === 0 ? (
            <span className="block text-xs text-muted">It’s shared with every partner club.</span>
          ) : (
            <select value={partner} onChange={(e) => setPartner(e.target.value)} data-testid="partner-club-pick" className="w-full rounded-lg border border-border bg-soft px-2 py-1.5">
              <option value="">Pick a partner club…</option>
              {openPartners.map((p) => (
                <option key={p.orgId} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </label>
        {openPartners.length > 0 && (
          <button type="submit" disabled={!partner || send.isPending} className={go}>
            Share
          </button>
        )}
      </form>
      <form
        className="space-y-2 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (isLink) send.mutate(q.trim());
        }}
      >
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Another club…</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search clubs, or paste a club’s link"
            aria-label="Another club: search clubs, or paste a club’s link"
            data-testid="other-club-search"
            className="w-full rounded-lg border border-border bg-soft px-2 py-1.5"
          />
        </label>
        {isLink && (
          <button type="submit" disabled={send.isPending} className={go}>
            Offer it to this club
          </button>
        )}
        {!isLink && debounced.length >= 2 && targets.data && (
          targets.data.clubs.length === 0 ? (
            <p className="text-xs text-muted">No listed club matches “{debounced}”. A club that isn’t listed is found by pasting its link.</p>
          ) : (
            <ul className="divide-y divide-line/60 rounded-lg border border-line" data-testid="other-club-results">
              {targets.data.clubs.map((c) => (
                <li key={c.orgId} className="flex items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate">
                    {c.name}
                    {c.partner && <span className="text-xs text-muted"> (partner club)</span>}
                  </span>
                  {c.shared ? (
                    <span className="text-xs text-muted">Shared</span>
                  ) : c.offer === 'pending' ? (
                    <span className="text-xs text-muted">Waiting for them</span>
                  ) : (
                    <button type="button" className={small} disabled={send.isPending} onClick={() => send.mutate(c.slug)}>
                      {c.partner ? 'Share' : 'Offer'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )
        )}
      </form>
      {said && (
        <p role="status" className="text-xs text-accent-text">
          {said}
        </p>
      )}
      {offers.length > 0 && (
        <ul className="divide-y divide-line/60 rounded-lg border border-line text-sm" data-testid="module-offers">
          {offers.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1">{offerWords(o)}</span>
              {o.state === 'declined' && !(o.askAgainAt && o.askAgainAt > Date.now()) && (
                <button type="button" className={small} disabled={send.isPending} onClick={() => send.mutate(o.club.slug)}>
                  Offer again
                </button>
              )}
              <button type="button" className={small} disabled={withdraw.isPending} onClick={() => withdraw.mutate(o.id)}>
                {o.state === 'pending' ? 'Take back' : 'Remove'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
