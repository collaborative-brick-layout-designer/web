// A club's partner clubs, on its page (docs/shared-modules.md, section 11):
// the partners, with how many modules go each way; for its Admins and
// Managers, asking a club (found in the directory, or by pasting its link),
// the requests in (Accept, Decline) and out (Take back, Ask again), and
// the modules other clubs offer (Accept, Decline); for its Admins, End
// partnership. Everything follows live (the club's hints), with no reload.

import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ClubPartners, type PartnerClubRef } from '../api';
import { ClubLogo } from './ClubLogo';
import { HelpButton } from '../help/HelpButton';
import { askConfirm } from '../ui/ConfirmDialog';

const btn = 'tap-target inline-flex items-center justify-center rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-soft disabled:opacity-50';
const primary = 'tap-target inline-flex items-center justify-center rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50';
const field = 'min-h-11 w-full rounded-lg border border-border bg-soft px-3 py-2 text-ink';

/** A club as a request shows it: its name, or (a club that isn't listed, before it accepts) its address. */
export function clubLabel(c: Pick<PartnerClubRef, 'name' | 'slug'>): string {
  return c.name ?? `the club at /orgs/${c.slug}`;
}

/** "2 modules from them · 1 to them", or null when none go either way. */
export function modulesBothWays(p: { modulesIn: number; modulesOut: number }): string | null {
  const n = (k: number) => `${k} ${k === 1 ? 'module' : 'modules'}`;
  const parts = [p.modulesIn ? `${n(p.modulesIn)} from them` : '', p.modulesOut ? `${n(p.modulesOut)} to them` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** What ending a partnership does, said before it's done. */
export function endPartnershipText(club: string, p: { modulesIn: number; modulesOut: number }): { title: string; keeps: string; removes: string } {
  const n = p.modulesIn + p.modulesOut;
  return {
    title: `End the partnership with ${club}?`,
    removes:
      n === 0
        ? `No modules are shared through it now. ${club} is told.`
        : `The ${n === 1 ? 'module' : `${n} modules`} your clubs shared through it stop, both ways: no more updates, and they can’t be placed again. ${club} is told.`,
    keeps: 'Copies already placed stay in the layouts as they are, marked “No longer shared”, and can be removed or made the club’s own. Modules shared one off and accepted stay shared.',
  };
}

/** "You can ask again on 20 Nov" for a declined request, or null once you can. */
export function askAgainText(askAgainAt: number | null, now = Date.now()): string | null {
  if (!askAgainAt || askAgainAt <= now) return null;
  const when = new Date(askAgainAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return `You can ask again from ${when}.`;
}

export function ClubPartnersSection({ slug, name }: { slug: string; name: string }) {
  const qc = useQueryClient();
  const key = ['club-partners', slug];
  const data = useQuery({ queryKey: key, queryFn: () => api.orgs.partners(slug) });
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const location = useLocation();
  // /orgs/:slug?tab=partners (the emails and notes link here).
  const wanted = new URLSearchParams(location.search).get('tab') === 'partners';
  useEffect(() => {
    if (wanted && data.data) document.getElementById('partners')?.scrollIntoView?.({ block: 'start' });
  }, [wanted, data.data]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['club-request-count'] });
    void qc.invalidateQueries({ queryKey: ['org', slug] });
    void qc.invalidateQueries({ queryKey: ['modules-shared'] });
  };
  const act = useMutation({
    mutationFn: (f: () => Promise<string | null>) => f(),
    onSuccess: (msg) => {
      setError(null);
      setSaid(msg);
      refresh();
    },
    onError: (e: Error) => {
      setSaid(null);
      setError(e.message);
      refresh();
    },
  });

  const d = data.data;
  const waiting = (d?.requestsIn?.length ?? 0) + (d?.offersIn?.length ?? 0);
  return (
    <section id="partners" aria-labelledby="partners-title" className="space-y-3 rounded-section border border-line bg-panel p-4" data-testid="club-partners">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="partners-title" className="text-lg font-semibold">
          Partner clubs
        </h2>
        <HelpButton helpKey="club.partners" />
        {waiting > 0 && (
          <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-accent-ink" data-testid="partners-waiting">
            {waiting} waiting
          </span>
        )}
      </div>
      {data.isLoading && <p className="text-sm text-muted">Loading…</p>}
      {data.isError && <p className="text-sm text-danger">{(data.error as Error).message}</p>}
      {d && (
        <>
          <p className="text-sm text-muted">
            Partner clubs share their modules with each other, read-only. Each module is still picked, and the other club doesn’t need to accept each one.
          </p>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          {said && (
            <p role="status" className="text-sm text-accent-text">
              {said}
            </p>
          )}
          {d.offersIn && d.offersIn.length > 0 && (
            <div className="space-y-2" data-testid="module-offers-in">
              <h3 className="flex items-center gap-1 text-sm font-semibold">
                Modules offered to {name}
                <HelpButton helpKey="club.moduleOffers" />
              </h3>
              <ul className="divide-y divide-line/60 rounded-lg border border-line text-sm">
                {d.offersIn.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <ClubLogo name={o.from.name} logoUrl={o.from.logoUrl} size={28} />
                    <span className="min-w-0 flex-1">
                      <strong>{o.from.name}</strong> wants to share “{o.module.title}” with you
                      {o.module.latestVersion > 0 && <span className="text-xs text-muted"> · version {o.module.latestVersion}</span>}
                    </span>
                    <button
                      type="button"
                      className={primary}
                      disabled={act.isPending}
                      onClick={() =>
                        act.mutate(async () => {
                          await api.orgs.answerModuleOffer(slug, o.id, 'accept');
                          return `“${o.module.title}” is shared with ${name}. Members who may edit the club’s layouts can place it from the Module library’s Clubs tab.`;
                        })
                      }
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      className={btn}
                      disabled={act.isPending}
                      onClick={() =>
                        act.mutate(async () => {
                          await api.orgs.answerModuleOffer(slug, o.id, 'decline');
                          return `Declined “${o.module.title}”.`;
                        })
                      }
                    >
                      Decline
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {d.requestsIn && d.requestsIn.length > 0 && (
            <div className="space-y-2" data-testid="partner-requests-in">
              <h3 className="text-sm font-semibold">Asking to be partners</h3>
              <ul className="divide-y divide-line/60 rounded-lg border border-line text-sm">
                {d.requestsIn.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <ClubLogo name={r.club.name} logoUrl={r.club.logoUrl} size={28} />
                    <span className="min-w-0 flex-1">
                      <strong>{r.club.name}</strong> wants to be partners with {name}
                    </span>
                    <button
                      type="button"
                      className={primary}
                      disabled={act.isPending}
                      onClick={() =>
                        act.mutate(async () => {
                          await api.orgs.answerPartnerRequest(slug, r.id, 'accept');
                          return `${r.club.name} and ${name} are partners now.`;
                        })
                      }
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      className={btn}
                      disabled={act.isPending}
                      onClick={() =>
                        act.mutate(async () => {
                          await api.orgs.answerPartnerRequest(slug, r.id, 'decline');
                          return `Declined ${r.club.name}’s request.`;
                        })
                      }
                    >
                      Decline
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <PartnerList d={d} onEnd={(p) => act.mutate(async () => {
            const r = await api.orgs.endPartnership(slug, p.id);
            return `The partnership with ${p.name} ended.${r.stopped ? ` ${r.stopped === 1 ? '1 module stopped' : `${r.stopped} modules stopped`}.` : ''}`;
          })} busy={act.isPending} />
          {d.requestsOut && d.requestsOut.length > 0 && (
            <div className="space-y-2" data-testid="partner-requests-out">
              <h3 className="text-sm font-semibold">Requests you sent</h3>
              <ul className="divide-y divide-line/60 rounded-lg border border-line text-sm">
                {d.requestsOut.map((r) => {
                  const later = r.state === 'declined' ? askAgainText(r.askAgainAt) : null;
                  return (
                    <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <ClubLogo name={r.club.name ?? r.club.slug} logoUrl={r.club.logoUrl ?? null} size={28} />
                      <span className="min-w-0 flex-1">
                        {clubLabel(r.club)}
                        <span className="block text-xs text-muted">
                          {r.state === 'pending' ? 'Waiting for them to accept.' : `Declined. ${later ?? 'You can ask again.'}`}
                        </span>
                      </span>
                      {r.state === 'declined' && !later && (
                        <button
                          type="button"
                          className={btn}
                          disabled={act.isPending}
                          onClick={() =>
                            act.mutate(async () => {
                              await api.orgs.askPartner(slug, r.club.slug);
                              return `Asked ${clubLabel(r.club)} again.`;
                            })
                          }
                        >
                          Ask again
                        </button>
                      )}
                      <button
                        type="button"
                        className={btn}
                        disabled={act.isPending}
                        onClick={() =>
                          act.mutate(async () => {
                            await api.orgs.withdrawPartnerRequest(slug, r.id);
                            return r.state === 'pending' ? `Took back the request to ${clubLabel(r.club)}.` : null;
                          })
                        }
                      >
                        {r.state === 'pending' ? 'Take back' : 'Remove'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {d.canManage ? (
            <AskPartner slug={slug} d={d} onAsk={(other) => act.mutate(async () => {
              const r = await api.orgs.askPartner(slug, other);
              return r.status === 'partners'
                ? `${clubLabel(r.club)} had asked you already: your clubs are partners now.`
                : `Asked ${clubLabel(r.club)}. Their Admins or Managers must accept it.`;
            })} busy={act.isPending} />
          ) : (
            <p className="text-xs text-muted">The club’s Admins and Managers ask other clubs to be partners and answer their requests.</p>
          )}
        </>
      )}
    </section>
  );
}

function PartnerList({ d, onEnd, busy }: { d: ClubPartners; onEnd: (p: ClubPartners['partners'][number]) => void; busy: boolean }) {
  if (d.partners.length === 0) return <p className="text-sm text-muted">No partner clubs yet.</p>;
  return (
    <ul className="divide-y divide-line/60 rounded-lg border border-line text-sm" data-testid="partner-list" aria-label="Partner clubs">
      {d.partners.map((p) => {
        const both = modulesBothWays(p);
        return (
          <li key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <ClubLogo name={p.name} logoUrl={p.logoUrl} size={28} />
            <span className="min-w-0 flex-1">
              <Link to={`/orgs/${p.slug}`} className="font-medium hover:underline">
                {p.name}
              </Link>
              <span className="block text-xs text-muted">{both ?? 'No modules shared yet.'}</span>
            </span>
            {d.canEnd ? (
              <button
                type="button"
                className={btn}
                disabled={busy}
                onClick={async () => {
                  const t = endPartnershipText(p.name, p);
                  if (await askConfirm({ ...t, confirmLabel: 'End partnership', danger: true })) onEnd(p);
                }}
              >
                End partnership
              </button>
            ) : (
              d.canManage && <span className="text-xs text-muted">Only the club’s Admins can end it.</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Ask a club: search the Clubs directory, or paste a club's link (a club that isn't listed is found only that way). */
function AskPartner({ slug, d, onAsk, busy }: { slug: string; d: ClubPartners; onAsk: (other: string) => void; busy: boolean }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const isLink = /\/orgs\/[a-z0-9-]+/i.test(q);
  const found = useQuery({
    queryKey: ['club-directory', debounced],
    queryFn: () => api.orgs.directory(debounced),
    enabled: debounced.length >= 2 && !isLink,
  });
  const taken = new Set([slug, ...d.partners.map((p) => p.slug), ...(d.requestsOut ?? []).map((r) => r.club.slug)]);
  const clubs = (found.data?.clubs ?? []).filter((c) => !taken.has(c.slug));
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (isLink) {
          onAsk(q.trim());
          setQ('');
        }
      }}
    >
      <label className="block text-sm">
        <span className="mb-1 block font-semibold">Ask a club to be partners</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search clubs, or paste a club’s link"
          aria-label="Search clubs, or paste a club’s link"
          className={field}
          data-testid="partner-search"
        />
      </label>
      <p className="text-xs text-muted">Their Admins or Managers must accept. A club that isn’t in the Clubs directory is found by pasting its link.</p>
      {isLink && (
        <button type="submit" className={primary} disabled={busy}>
          Ask this club
        </button>
      )}
      {!isLink && debounced.length >= 2 && found.data && (
        clubs.length === 0 ? (
          <p className="text-sm text-muted">No listed club matches “{debounced}”.</p>
        ) : (
          <ul className="divide-y divide-line/60 rounded-lg border border-line text-sm" data-testid="partner-search-results">
            {clubs.map((c) => (
              <li key={c.id} className="flex items-center gap-2 px-3 py-2">
                <ClubLogo name={c.name} logoUrl={c.logoUrl ?? null} size={28} />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <button
                  type="button"
                  className={btn}
                  disabled={busy}
                  onClick={() => {
                    onAsk(c.slug);
                    setQ('');
                  }}
                >
                  Ask
                </button>
              </li>
            ))}
          </ul>
        )
      )}
    </form>
  );
}
