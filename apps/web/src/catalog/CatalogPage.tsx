// The public catalogs: what people shared for everyone. With no filter the
// page is a landing: Featured collections first, then a row of the newest
// (or most used) from each kind with "See all →". Picking a kind, searching
// or a tag switches to that full list, a page at a time; the address keeps
// the filter, so links and back/forward work. "Add to my modules / my
// parts" copies the item to you or a club you can add to. Signed-out
// visitors may browse when the site allows it; adding always needs an account.

import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { SignInLink } from '../auth/signIn';
import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type CatalogItem, type CatalogKind, type CatalogSummary, type CollectionSummary } from '../api';
import { AppHeader } from '../AppHeader';
import { HelpButton } from '../help/HelpButton';
import { SaveToPicker } from '../owners/OwnerControls';
import { CollectionCard, CollectionsSection } from './Collections';
import { TrustedBadge } from './TrustedBadge';
import { AddToCollectionDialog, type CollectionTarget } from './AddToCollection';
import { ItemCoverDialog } from './ItemCover';
import { useEscape } from '../editor/useEscape';

/** How many items a landing row shows, and a page of the full list. */
const ROW = 8;
const PAGE = 24;
const CARD_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,13rem),1fr))] gap-3';
/**
 * A landing row: on a phone only its first four, so the next kind is a short
 * scroll away. Four, not three, so two columns end on a full line.
 */
const ROW_GRID = `${CARD_GRID} max-sm:[&>li:nth-child(n+5)]:hidden`;

type Sort = 'newest' | 'popular';

export function CatalogPage() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const demo = !!me.data?.user?.isDemoAccount;
  const settings = useQuery({ queryKey: ['catalog-settings'], queryFn: api.catalog.settings });
  const [params, setParams] = useSearchParams();
  const { pathname } = useLocation();
  const user = me.data?.user ?? null;
  const s = settings.data;
  const kinds = kindsOn(s);
  const collectionsOn = !!(s?.modules || s?.parts);
  // "All" first, then each kind that's on, then Collections (as in the desktop app).
  const tabs: CatalogTab[] = [...(kinds.length > 1 ? (['all'] as const) : []), ...kinds, ...(collectionsOn ? (['collections'] as const) : [])];
  const wantedTab = (params.get('kind') ?? 'all') as CatalogTab;
  const tab: CatalogTab = tabs.includes(wantedTab) ? wantedTab : (tabs[0] ?? 'all');
  const q = params.get('q') ?? '';
  const tag = params.get('tag') ?? '';
  const sort: Sort = params.get('sort') === 'popular' ? 'popular' : 'newest';
  const landing = tab === 'all' && !q && !tag;
  const mayBrowse = !!user || !!s?.anonymousBrowse;

  /** The address for a filter: what's left out is the default. */
  const go = (next: { kind?: CatalogTab; q?: string; tag?: string; sort?: Sort }, replace = false) => {
    const k = next.kind ?? tab;
    const p: Record<string, string> = {};
    if (k !== 'all') p.kind = k;
    const nq = next.q ?? q;
    if (nq && k !== 'collections') p.q = nq;
    const nt = next.tag ?? tag;
    if (nt && k !== 'collections') p.tag = nt;
    const ns = next.sort ?? sort;
    if (ns !== 'newest') p.sort = ns;
    setParams(p, { replace });
  };

  // The search box types into the address after a short pause (replacing,
  // not adding, history entries), and follows it on back/forward.
  const [qInput, setQInput] = useState(q);
  const typed = useRef(q);
  useEffect(() => {
    if (q !== typed.current) {
      typed.current = q;
      setQInput(q);
    }
  }, [q]);
  useEffect(() => {
    if (qInput.trim() === q) return;
    const t = setTimeout(() => {
      // Already on the way to another page (e.g. "Open it" while the next
      // page loads): don't pull the address back to the catalog.
      if (window.location.pathname !== pathname) return;
      typed.current = qInput.trim();
      go({ q: qInput.trim() }, true);
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);

  const [adding, setAdding] = useState<CatalogItem | null>(null);
  // What I (or my clubs) shared: those cards offer "Cover picture…".
  const mine = useQuery({ queryKey: ['catalog-mine'], queryFn: api.catalog.mine, enabled: !!user && kinds.length > 0 });
  const mineIds = new Set((mine.data?.items ?? []).map((i) => i.id));
  const [coverFor, setCoverFor] = useState<string | null>(null);
  const [toCollection, setToCollection] = useState<CollectionTarget | null>(null);
  const cardProps: CardActions = {
    signedIn: !!user,
    demo,
    mineIds,
    onAdd: setAdding,
    onCollect: (it) => setToCollection({ kind: 'catalog', item: it }),
    onCover: setCoverFor,
    onTag: (t) => go({ tag: t }),
  };

  return (
    <div className="theme-page h-full overflow-y-auto bg-bg p-4 text-ink sm:p-6 lg:p-8">
      {user ? (
        <AppHeader user={user} />
      ) : (
        <header className="flex items-center justify-between gap-3">
          <Link to="/" className="tap-target inline-flex items-center font-display text-lg font-bold">Collaborative Brick Layout Designer</Link>
          <SignInLink className="tap-target rounded-lg bg-accent px-4 py-2 font-semibold text-accent-ink hover:bg-accent-hover">
            Sign in
          </SignInLink>
        </header>
      )}
      <main className="mt-6 w-full min-w-0 space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Catalog</h1>
          <p className="text-muted">What people have shared for everyone. Add one to copy it into your own things.</p>
        </div>
        {settings.isLoading || me.isLoading ? (
          <p className="text-muted">Loading…</p>
        ) : kinds.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line p-6 text-center text-muted">
            The public catalog isn’t open on this site.
            {user?.isGlobalAdmin && (
              <>
                {' '}You can open it in <Link to="/admin" className="font-semibold text-accent-text hover:underline">Admin › Settings</Link>.
              </>
            )}
          </p>
        ) : !mayBrowse ? (
          <p className="rounded-lg border border-dashed border-line p-6 text-center text-muted">
            <SignInLink className="font-semibold text-accent-text hover:underline">Sign in</SignInLink> to browse the catalog.
          </p>
        ) : (
          <>
            <div data-testid="catalog-filters" className="space-y-3 rounded-section border border-line bg-panel p-3">
              {tabs.length > 1 && (
                <div role="tablist" aria-label="Catalog" className="flex max-w-full flex-wrap gap-1">
                  {tabs.map((k) => (
                    <button
                      key={k}
                      role="tab"
                      type="button"
                      aria-selected={tab === k}
                      onClick={() => go({ kind: k, ...(k === 'all' ? { q: '', tag: '' } : {}) })}
                      className={`tap-target rounded-full px-4 py-1.5 text-sm font-semibold ${tab === k ? 'bg-accent text-accent-ink' : 'bg-soft hover:bg-line'}`}
                    >
                      {TAB_LABEL[k]}
                    </button>
                  ))}
                </div>
              )}
              {tab !== 'collections' && (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="search"
                    value={qInput}
                    onChange={(e) => setQInput(e.target.value)}
                    placeholder={tab === 'all' ? 'Search the whole catalog' : `Search ${TAB_LABEL[tab].toLowerCase()}`}
                    aria-label="Search the catalog"
                    className="min-h-11 min-w-0 flex-1 basis-full rounded-lg border border-border bg-soft px-3 sm:basis-auto"
                  />
                  <select
                    value={sort}
                    onChange={(e) => go({ sort: e.target.value as Sort })}
                    aria-label="Order"
                    className="min-h-11 rounded-lg border border-border bg-soft px-2"
                  >
                    <option value="newest">Newest</option>
                    <option value="popular">Most used</option>
                  </select>
                  {tag && (
                    <span className="inline-flex min-h-11 items-center gap-1 rounded-full bg-accent/15 px-3 text-sm">
                      Tagged <b>{tag}</b>
                      <button type="button" onClick={() => go({ tag: '' })} aria-label={`Show all, not only ${tag}`} className="tap-target px-1 text-accent-text hover:underline">
                        ✕
                      </button>
                    </span>
                  )}
                </div>
              )}
            </div>
            {tab === 'collections' ? (
              <CollectionsSection signedIn={!!user} />
            ) : landing ? (
              <Landing kinds={kinds} collectionsOn={collectionsOn} sort={sort} signedIn={!!user} card={cardProps} seeAll={(k) => go({ kind: k })} />
            ) : (
              <ItemGrid kind={tab} q={q} tag={tag} sort={sort} signedIn={!!user} card={cardProps} />
            )}
          </>
        )}
      </main>
      {adding && <AddDialog item={adding} onClose={() => setAdding(null)} />}
      {toCollection && <AddToCollectionDialog target={toCollection} onClose={() => setToCollection(null)} />}
      {coverFor && <ItemCoverDialog itemId={coverFor} onClose={() => setCoverFor(null)} />}
    </div>
  );
}

/** What a card's buttons do (the page owns the dialogs). */
type CardActions = {
  signedIn: boolean;
  demo: boolean;
  mineIds: Set<string>;
  onAdd: (it: CatalogItem) => void;
  onCollect: (it: CatalogItem) => void;
  onCover: (id: string) => void;
  onTag: (tag: string) => void;
};

/** The landing: Featured, then a row per kind (and one of collections), each with "See all →". */
function Landing({
  kinds,
  collectionsOn,
  sort,
  signedIn,
  card,
  seeAll,
}: {
  kinds: CatalogKind[];
  collectionsOn: boolean;
  sort: Sort;
  signedIn: boolean;
  card: CardActions;
  seeAll: (k: CatalogTab) => void;
}) {
  const rows = useLandingRows(kinds, sort);
  const colls = useQuery({ queryKey: ['catalog-collections'], queryFn: api.catalog.collections, enabled: collectionsOn });
  const all = colls.data?.collections ?? [];
  const featured = all.filter((c) => c.featured);
  const otherColls = all.filter((c) => !c.featured).slice(0, ROW);
  const loaded = rows.every((r) => !r.isLoading) && (!collectionsOn || !colls.isLoading);
  const empty = loaded && rows.every((r) => !r.data?.items.length) && all.length === 0;
  return (
    <div className="space-y-8">
      {featured.length > 0 && (
        <section aria-labelledby="catalog-featured" className="space-y-3 rounded-section border border-accent/40 bg-accent/5 p-3 sm:p-4" data-testid="catalog-featured">
          <h2 id="catalog-featured" className="flex items-center gap-2 text-xl font-bold">
            Featured
            <HelpButton helpKey="catalog.featured" />
          </h2>
          <ul aria-label="Featured collections" className={CARD_GRID}>
            {featured.map((c) => (
              <CollectionCard key={c.id} c={c} testId="featured-collection" />
            ))}
          </ul>
        </section>
      )}
      {kinds.map((k, i) => {
        const items = rows[i]?.data?.items ?? [];
        if (!items.length) return null;
        return (
          <Row key={k} id={`catalog-row-${k}`} title={TAB_LABEL[k]} onSeeAll={() => seeAll(k)}>
            <ul aria-label={TAB_LABEL[k]} className={ROW_GRID}>
              {items.map((it) => (
                <ItemCard key={it.id} it={it} {...card} />
              ))}
            </ul>
          </Row>
        );
      })}
      {otherColls.length > 0 && (
        <Row id="catalog-row-collections" title="Collections" onSeeAll={() => seeAll('collections')}>
          <ul aria-label="Collections" className={ROW_GRID}>
            {otherColls.map((c: CollectionSummary) => (
              <CollectionCard key={c.id} c={c} />
            ))}
          </ul>
        </Row>
      )}
      {!loaded && <p className="text-muted">Loading…</p>}
      {empty && (
        <p className="rounded-lg border border-dashed border-line p-6 text-center text-muted">
          {signedIn ? 'Nothing here yet. Share a module, part, layout or venue from its ⋯ menu on Home.' : 'Nothing here yet. Check back later, or sign in to share your own.'}
        </p>
      )}
    </div>
  );
}

/** Each landing row's first few, one request per kind that's on. */
function useLandingRows(kinds: CatalogKind[], sort: Sort) {
  return useQueries({
    queries: kinds.map((k) => ({ queryKey: ['catalog-items', 'row', k, sort], queryFn: () => api.catalog.items(k, { sort, limit: ROW }) })),
  });
}

function Row({ id, title, onSeeAll, children }: { id: string; title: string; onSeeAll: () => void; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={id} className="text-xl font-bold">
          {title}
        </h2>
        <button type="button" onClick={onSeeAll} aria-label={`See all ${title.toLowerCase()}`} className="tap-target shrink-0 font-semibold text-accent-text hover:underline">
          See all →
        </button>
      </div>
      {children}
    </section>
  );
}

/** The full list for a kind (or all of them), a page at a time as you scroll. */
function ItemGrid({ kind, q, tag, sort, signedIn, card }: { kind: CatalogKind | 'all'; q: string; tag: string; sort: Sort; signedIn: boolean; card: CardActions }) {
  const list = useInfiniteQuery({
    queryKey: ['catalog-items', 'grid', kind, q, tag, sort],
    queryFn: ({ pageParam }) => api.catalog.items(kind, { q, tag, sort, limit: PAGE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((e) => {
      if (e.some((x) => x.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  return (
    <div className="space-y-4">
      {list.isLoading && <p className="text-muted">Loading…</p>}
      {list.isError && <p className="text-danger">{(list.error as Error).message}</p>}
      {list.isSuccess && items.length === 0 && (
        <p className="rounded-lg border border-dashed border-line p-6 text-center text-muted">
          {q || tag
            ? 'Nothing matches. Try other words, or another kind.'
            : !signedIn
              ? 'Nothing here yet. Check back later, or sign in to share your own.'
              : kind === 'layout'
                ? 'Nothing here yet. Share a layout from the editor’s menu, or its ⋯ menu on Home.'
                : kind === 'venue'
                  ? 'Nothing here yet. Share a venue from its ⋯ menu in your venues.'
                  : `Nothing here yet. Share a ${kind === 'all' ? 'module or part' : kind} from its ⋯ menu on Home.`}
        </p>
      )}
      <ul className={CARD_GRID}>
        {items.map((it) => (
          <ItemCard key={it.id} it={it} {...card} />
        ))}
      </ul>
      {hasNextPage && (
        <div ref={sentinel} className="flex justify-center">
          <button
            type="button"
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
            className="tap-target rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-soft disabled:opacity-50"
          >
            {isFetchingNextPage ? 'Loading…' : 'Show more'}
          </button>
        </div>
      )}
    </div>
  );
}

/** One catalog item: its picture, who shared it, and Add (with the quieter extras under it). */
function ItemCard({ it, signedIn, demo, mineIds, onAdd, onCollect, onCover, onTag }: { it: CatalogItem } & CardActions) {
  return (
    <li data-testid="catalog-item" className="flex flex-col gap-2 rounded-section border border-line bg-panel p-3">
      {hasPage(it.kind) ? (
        <Link to={`/catalog/items/${it.id}`} aria-label={`Open ${it.title}`}>
          <CatalogPreview item={it} />
        </Link>
      ) : (
        <CatalogPreview item={it} />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <h3 className="break-words font-semibold">
          {hasPage(it.kind) ? (
            <Link to={`/catalog/items/${it.id}`} className="hover:underline">
              {it.title}
            </Link>
          ) : (
            it.title
          )}
        </h3>
        {it.summary && <p className="text-xs text-muted">{summaryText(it.summary)}</p>}
        <p className="text-xs text-muted">
          {KIND_LABEL[it.kind].one} · by {it.by}
          {it.trustedClub && <TrustedBadge />} · version {it.version} · {it.uses} {it.uses === 1 ? 'use' : 'uses'}
        </p>
        {it.description && <p className="line-clamp-2 text-sm">{it.description}</p>}
        {it.tags.length > 0 && (
          <p className="flex flex-wrap gap-1">
            {it.tags.map((t) => (
              <button key={t} type="button" onClick={() => onTag(t)} className="rounded-full bg-soft px-2 py-0.5 text-xs hover:bg-line">
                {t}
              </button>
            ))}
          </p>
        )}
      </div>
      {signedIn ? (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => onAdd(it)}
            // Its words, then which one (a name that starts with what it says, WCAG 2.5.3).
            aria-label={`${KIND_LABEL[it.kind].add}: ${it.title}`}
            className="tap-target rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink hover:bg-accent-hover"
          >
            {KIND_LABEL[it.kind].add}
          </button>
          <div className="flex flex-wrap justify-center gap-x-3">
            {!demo && (
              <button type="button" onClick={() => onCollect(it)} aria-label={`${it.title}: add to a collection`} className="tap-target text-sm text-accent-text hover:underline">
                Add to a collection…
              </button>
            )}
            {mineIds.has(it.id) && (
              <button type="button" onClick={() => onCover(it.id)} aria-label={`${it.title}: cover picture`} className="tap-target text-sm text-accent-text hover:underline">
                Cover picture…
              </button>
            )}
          </div>
        </div>
      ) : (
        <SignInLink className="tap-target rounded-lg border border-border px-3 py-1.5 text-center text-sm font-semibold hover:bg-soft">
          Sign in to add
        </SignInLink>
      )}
    </li>
  );
}

/** The card's picture: its owner's own fills the card (it was cropped to it); the drawn one fits inside. */
/** The Catalog page's tabs: All, each kind that's on, and Collections. */
export type CatalogTab = 'all' | CatalogKind | 'collections';

/** What each kind is called on tabs and buttons. */
export const KIND_LABEL: Record<CatalogKind, { tab: string; one: string; add: string; mine: string }> = {
  module: { tab: 'Modules', one: 'Module', add: 'Add to my modules', mine: 'modules' },
  part: { tab: 'Parts', one: 'Part', add: 'Add to my parts', mine: 'parts' },
  layout: { tab: 'Layouts', one: 'Layout', add: 'Copy to my layouts', mine: 'layouts' },
  venue: { tab: 'Venues', one: 'Venue', add: 'Copy to my venues', mine: 'venues' },
};

const TAB_LABEL: Record<CatalogTab, string> = {
  all: 'All',
  module: 'Modules',
  part: 'Parts',
  layout: 'Layouts',
  venue: 'Venues',
  collections: 'Collections',
};

/** The catalogs that are on, in tab order. */
export function kindsOn(s: { modules?: boolean; parts?: boolean; layouts?: boolean; venues?: boolean } | undefined): CatalogKind[] {
  if (!s) return [];
  return (['module', 'part', 'layout', 'venue'] as const).filter((k) => (k === 'module' ? s.modules : k === 'part' ? s.parts : k === 'layout' ? s.layouts : s.venues));
}

/** Layouts and venues have their own page (a viewer). */
export const hasPage = (k: CatalogKind) => k === 'layout' || k === 'venue';

/** "960 × 480 studs (7.7 × 3.8 m) · 1,204 parts". */
export function summaryText(s: CatalogSummary): string {
  const m = (studs: number) => (studs * 0.008).toFixed(1);
  const size = s.widthStuds && s.heightStuds ? `${s.widthStuds} × ${s.heightStuds} studs (${m(s.widthStuds)} × ${m(s.heightStuds)} m)` : '';
  const parts = s.partCount !== undefined ? `${s.partCount.toLocaleString()} ${s.partCount === 1 ? 'part' : 'parts'}` : '';
  return [size, parts].filter(Boolean).join(' · ');
}

export function CatalogPreview({ item }: { item: Pick<CatalogItem, 'previewUrl' | 'title' | 'coverUrl' | 'customCover'> }) {
  const [failed, setFailed] = useState(false);
  const custom = !!item.customCover && !!item.coverUrl;
  // No picture ('' from the server): a blank card, without asking for one.
  return failed || !(custom ? item.coverUrl : item.previewUrl) ? (
    <span aria-hidden className="block aspect-[4/3] w-full rounded-lg border border-line bg-soft" />
  ) : (
    <img
      src={custom ? item.coverUrl : item.previewUrl}
      alt=""
      loading="lazy"
      data-testid="catalog-preview"
      onError={() => setFailed(true)}
      className={`aspect-[4/3] w-full rounded-lg border border-line bg-soft ${custom ? 'object-cover' : 'object-contain'}`}
    />
  );
}

/** "Add to my modules / parts": where the copy goes, then where to find it. */
export function AddDialog({ item, onClose, onAdded }: { item: CatalogItem; onClose: () => void; onAdded?: (id: string) => void }) {
  useEscape(onClose);
  const qc = useQueryClient();
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: api.orgs.list });
  const [owner, setOwner] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => api.catalog.add(item.id, owner || undefined),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: [r.kind === 'module' ? 'modules' : r.kind === 'part' ? 'custom-parts' : r.kind === 'layout' ? 'layouts' : 'venues'] });
      if (r.kind === 'part') void qc.fetchQuery({ queryKey: ['parts-catalog'], queryFn: api.parts.catalog, staleTime: 0 }).catch(() => undefined);
      void qc.invalidateQueries({ queryKey: ['catalog-items'] });
      onAdded?.(r.id);
    },
    onError: (e: Error) => setError(e.message),
  });
  const isModule = item.kind === 'module';
  const label = KIND_LABEL[item.kind];
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/60 p-4">
      <div role="dialog" aria-modal="true" aria-label={`Add ${item.title}`} className="w-full max-w-md space-y-4 rounded-section border border-line bg-panel p-5 text-sm">
        <h3 className="text-lg font-semibold">{label.add}</h3>
        {add.data ? (
          <>
            <p role="status">
              “{item.title}” is now in your {label.mine}. It’s your own copy: change it as you like.
            </p>
            <div className="flex justify-end gap-2">
              {(isModule || item.kind === 'layout') && (
                <Link
                  to={isModule ? `/modules/${add.data.id}` : `/editor/${add.data.id}`}
                  className="tap-target rounded-lg bg-accent px-4 py-2 font-semibold text-accent-ink hover:bg-accent-hover"
                >
                  Open it
                </Link>
              )}
              {item.kind === 'venue' && (
                <Link to={`/?newLayoutVenue=${encodeURIComponent(add.data.id)}`} className="tap-target rounded-lg bg-accent px-4 py-2 font-semibold text-accent-ink hover:bg-accent-hover">
                  Start a layout in it
                </Link>
              )}
              <button type="button" onClick={onClose} className="tap-target rounded-lg border border-border px-4 py-2 hover:bg-soft">
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p>A copy of “{item.title}” goes to:</p>
            <SaveToPicker value={owner} onChange={setOwner} orgs={orgs.data?.orgs} kind={item.kind} />
            {error && <p className="text-danger">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="tap-target rounded-lg border border-border px-4 py-2 hover:bg-soft">
                Cancel
              </button>
              <button
                type="button"
                disabled={add.isPending}
                onClick={() => {
                  setError(null);
                  add.mutate();
                }}
                className="tap-target rounded-lg bg-accent px-4 py-2 font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
