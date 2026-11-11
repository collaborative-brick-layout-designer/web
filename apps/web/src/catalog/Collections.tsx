// Catalog collections: named, ordered sets of modules and parts ("Starter
// town", "ArkLUG show standards").
//
// A collection is a person's or a club's. Private ones are only for their
// curator, or only for the club's members, and are never checked. Public
// ones are in the catalog: a moderator checks their title, description and
// cover first. Items are checked on their own: the curator's (or club's)
// own modules and parts in a public collection are shared to the catalog
// for their own review, and show publicly once approved.
//
// The Catalog page lists public collections (featured first), your clubs'
// and your own; a collection's page shows its items with Add all and a
// per-item Add.

import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { SignInLink } from '../auth/signIn';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type CatalogKind,
  type ClubCollection,
  type ClubCollections,
  type CollectionAddResult,
  type CollectionAudience,
  type CollectionDetail,
  type CollectionEntry,
  type CollectionItem,
  type CollectionSaved,
  type CollectionSummary,
  type EntryReview,
  type MyCollection,
} from '../api';
import { AppHeader } from '../AppHeader';
import { SaveToPicker } from '../owners/OwnerControls';
import { invalidateFor } from '../live/invalidate';
import { HelpButton } from '../help/HelpButton';
import { AddDialog, CatalogPreview, kindsOn } from './CatalogPage';

const KIND_NAME: Record<CatalogKind, string> = { module: 'Module', part: 'Part', layout: 'Layout', venue: 'Venue' };
import { AddToCollectionDialog, type CollectionTarget } from './AddToCollection';
import { TrustedBadge } from './TrustedBadge';
import { useIsDemo } from './ShareToCatalog';
import { askConfirm, askReason, confirmDelete, deleteOptions, toastDeleted, type DeleteWording } from '../ui/ConfirmDialog';
import { CoverPicker, type CoverMode, type CoverPickerHandle } from '../ui/CoverPicker';
import { useEscape } from '../editor/useEscape';

/** Who sees it, in a few words. */
export function audienceLabel(audience: CollectionAudience | undefined, clubName?: string | null): string {
  if (audience === 'private') return clubName ? `Only ${clubName} members` : 'Only you';
  return 'Everyone';
}

/** How one of my (or my club's) collections stands, in a few words. */
export function collectionStatus(
  c: Pick<MyCollection, 'status' | 'reason' | 'pending' | 'itemCount'> & { audience?: CollectionAudience },
  clubName?: string | null,
): { label: string; tone: 'ok' | 'wait' | 'bad' } {
  if (c.audience === 'private') {
    if (c.itemCount === 0) return { label: 'Empty: no items left', tone: 'bad' };
    return { label: `Private · ${audienceLabel('private', clubName).toLowerCase()}`, tone: 'ok' };
  }
  if (c.status === 'in_review') return { label: 'In review', tone: 'wait' };
  if (c.status === 'declined') return { label: c.reason ? `Declined: ${c.reason}` : 'Declined', tone: 'bad' };
  if (c.status === 'unpublished') return { label: c.reason ? `Unpublished: ${c.reason}` : 'Unpublished', tone: 'bad' };
  if (c.status === 'withdrawn') return { label: 'Withdrawn', tone: 'bad' };
  if (c.pending) return { label: 'Public · your change is in review', tone: 'wait' };
  if (c.itemCount === 0) return { label: 'Hidden: no items left', tone: 'bad' };
  if (c.reason) return { label: `Public · your change was declined: ${c.reason}`, tone: 'bad' };
  return { label: 'Public', tone: 'ok' };
}

/** How a collection's own module or part stands in the catalog, for its curators. */
export function reviewLabel(r: EntryReview | null | undefined): string | null {
  if (!r || r.state === 'public') return null;
  if (r.state === 'in_review') return 'Waiting for review';
  if (r.state === 'declined') return r.reason ? `Declined: ${r.reason}` : 'Declined';
  if (r.state === 'unpublished') return r.reason ? `Unpublished: ${r.reason}` : 'Unpublished';
  if (r.state === 'catalog_off') return 'Not shown: the catalog is off';
  return 'Not shared yet: shared when you save';
}

/** "Added 2 · you already had 1 · 1 couldn't be added". */
export function addAllSummary(r: CollectionAddResult): string {
  const parts: string[] = [];
  parts.push(r.added.length === 0 ? 'Nothing new to add' : `Added ${r.added.length} ${r.added.length === 1 ? 'item' : 'items'}`);
  if (r.skipped.length) parts.push(`already had ${r.skipped.length}`);
  if (r.failed.length) parts.push(`${r.failed.length} couldn’t be added`);
  return parts.join(' · ') + '.';
}

/** What happened when a collection was saved, in plain words. */
export function savedSummary(r: CollectionSaved, audience: CollectionAudience, clubName?: string | null): string {
  const out: string[] = [];
  if (audience === 'private') out.push(`Saved. ${audienceLabel('private', clubName)} can see it.`);
  else if (r.status === 'in_review' || r.pending) out.push('Sent for review. A moderator checks its title, description and cover before everyone sees it.');
  else out.push('It’s in the catalog now for everyone.');
  const n = r.submitted?.length ?? 0;
  if (n) out.push(`${n === 1 ? 'One of your own items was' : `${n} of your own items were`} shared to the catalog for review; each shows publicly once it’s approved.`);
  if (r.notShared?.length) out.push(`${r.notShared.length} couldn’t be shared to the catalog, so only you see ${r.notShared.length === 1 ? 'it' : 'them'} in it.`);
  return out.join(' ');
}

/** Move the entry at `from` to `to`, leaving the list as it was if either is out of range. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return [...list];
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x as T);
  return out;
}

/** "3 modules · 5 parts". */
export function counts(c: Pick<CollectionSummary, 'modules' | 'parts' | 'layouts' | 'venues'>): string {
  const out: string[] = [];
  if (c.modules) out.push(`${c.modules} ${c.modules === 1 ? 'module' : 'modules'}`);
  if (c.parts) out.push(`${c.parts} ${c.parts === 1 ? 'part' : 'parts'}`);
  if (c.layouts) out.push(`${c.layouts} ${c.layouts === 1 ? 'layout' : 'layouts'}`);
  if (c.venues) out.push(`${c.venues} ${c.venues === 1 ? 'venue' : 'venues'}`);
  return out.join(' · ') || 'empty';
}

/** An uploaded cover (a photo) fills its frame; an item's picture fits inside it. */
const isUploaded = (url: string | null) => !!url && (url.startsWith('data:') || url.includes('/cover?'));

function Cover({ url, className = '' }: { url: string | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  return url && !failed ? (
    <img
      src={url}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className={`rounded-lg border border-line bg-soft ${isUploaded(url) ? 'object-cover' : 'object-contain'} ${className}`}
    />
  ) : (
    <span aria-hidden className={`block rounded-lg border border-line bg-soft ${className}`} />
  );
}

const chip = 'rounded-full px-2 py-0.5 text-xs font-semibold';

export function CollectionCard({
  c,
  testId = 'collection-card',
  extra,
}: {
  c: CollectionSummary & { pinned?: boolean };
  testId?: string;
  extra?: React.ReactNode;
}) {
  return (
    <li data-testid={testId}>
      <Link
        to={`/catalog/collections/${c.id}`}
        className={`flex h-full flex-col gap-2 rounded-section border bg-panel p-3 hover:bg-soft ${c.featured ? 'border-accent' : 'border-line'}`}
      >
        <Cover url={c.coverUrl} className="aspect-[4/3] w-full" />
        <span className="flex flex-wrap items-center gap-1.5 font-semibold">
          {c.title}
          {c.pinned && <span className={`${chip} bg-accent/15 text-accent-text`}>Pinned</span>}
          {c.audience === 'private' && <span className={`${chip} bg-soft text-muted`}>Private</span>}
        </span>
        <span data-testid="collection-counts" className="text-xs text-muted">
          {c.featured ? 'Featured · ' : ''}
          {counts(c)} · by {c.by}
          {c.trustedClub && <TrustedBadge />}
        </span>
        {c.description && <span className="line-clamp-2 text-sm">{c.description}</span>}
        {extra}
      </Link>
    </li>
  );
}

const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-3';

function CollectionGrid({ rows, label }: { rows: CollectionSummary[]; label: string }) {
  return (
    <ul aria-label={label} className={GRID}>
      {rows.map((c) => (
        <CollectionCard key={c.id} c={c} />
      ))}
    </ul>
  );
}

/** The Catalog page's Collections: public ones (featured first), your clubs' and your own. */
export function CollectionsSection({ signedIn }: { signedIn: boolean }) {
  const demo = useIsDemo();
  const list = useQuery({ queryKey: ['catalog-collections'], queryFn: api.catalog.collections });
  const rows = list.data?.collections ?? [];
  const featured = rows.filter((c) => c.featured);
  const rest = rows.filter((c) => !c.featured);
  return (
    <section aria-labelledby="collections-heading" className="space-y-4" data-tour="catalog.collections">
      <h2 id="collections-heading" className="flex items-center gap-2 text-lg font-semibold">
        Collections
        <HelpButton helpKey="catalog.collections" />
      </h2>
      {featured.length > 0 && <CollectionGrid rows={featured} label="Featured collections" />}
      {rest.length > 0 && <CollectionGrid rows={rest} label="More collections" />}
      {list.isSuccess && rows.length === 0 && (
        <p className="text-sm text-muted">No public collections yet.{signedIn && !demo ? ' Make the first one under Your collections.' : ''}</p>
      )}
      {signedIn && <ClubCollectionsSection />}
      {signedIn && !demo && <MyCollections />}
    </section>
  );
}

/**
 * Your clubs' collections, or one club's (`club`, its slug). Every member
 * sees them; admins and managers get New collection.
 */
export function ClubCollectionsSection({ club }: { club?: string }) {
  const q = useQuery({ queryKey: ['club-collections', club ?? ''], queryFn: () => api.catalog.clubCollections(club) });
  const [editing, setEditing] = useState<{ club: ClubCollections } | null>(null);
  const clubs = (q.data?.clubs ?? []).filter((c) => c.canCurate || c.collections.length > 0);
  if (!clubs.length && !club) return null;
  return (
    <section aria-labelledby={`club-collections-${club ?? 'all'}`} className="space-y-3 rounded-section border border-line bg-panel p-4">
      <h2 id={`club-collections-${club ?? 'all'}`} className="flex items-center gap-2 text-lg font-semibold">
        {club ? 'Collections' : 'Your clubs'}
        <HelpButton helpKey="catalog.clubCollections" />
      </h2>
      {q.isLoading && <p className="text-sm text-muted">Loading…</p>}
      {club && q.isSuccess && clubs.length === 0 && <p className="text-sm text-muted">No collections yet.</p>}
      {clubs.map((cl) => (
        <div key={cl.id} data-testid="club-collections" className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {!club && (
              <Link to={`/orgs/${cl.slug}`} className="tap-target inline-flex items-center font-semibold hover:underline">
                {cl.name}
              </Link>
            )}
            {cl.canCurate && (
              <button
                type="button"
                onClick={() => setEditing({ club: cl })}
                aria-label={`New collection for ${cl.name}`}
                className="tap-target rounded-lg border border-border px-3 py-1.5 text-sm font-semibold hover:bg-soft"
              >
                New collection
              </button>
            )}
          </div>
          {cl.collections.length === 0 ? (
            <p className="text-sm text-muted">No collections yet. Make one for your members, like your show standards.</p>
          ) : (
            <ul aria-label={`${cl.name}’s collections`} className={GRID}>
              {cl.collections.map((c) => (
                <CollectionCard
                  key={c.id}
                  c={c}
                  testId="club-collection-card"
                  extra={
                    cl.canCurate && (
                      <span data-testid="collection-status" className="text-xs text-muted">
                        {collectionStatus(c, cl.name).label}
                      </span>
                    )
                  }
                />
              ))}
            </ul>
          )}
        </div>
      ))}
      {editing && <CollectionEditor id={null} club={editing.club} onClose={() => setEditing(null)} />}
    </section>
  );
}

/**
 * The question before deleting a collection. Only the collection goes: its
 * modules and parts stay where they are, and copies people added keep working.
 */
export function deleteWording(c: { title: string; status: string; audience?: string }): DeleteWording {
  const public_ = c.audience !== 'private' && c.status === 'public';
  return {
    removes: `The collection is deleted${public_ ? ' and leaves the catalog' : ''}.`,
    keeps: 'Its modules and parts aren’t deleted, and copies people already added keep working.',
  };
}

/** Your collections: how each stands, and a way to make one. */
export function MyCollections() {
  const qc = useQueryClient();
  const mine = useQuery({ queryKey: ['catalog-collections-mine'], queryFn: api.catalog.myCollections });
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const dismiss = useMutation({
    mutationFn: api.catalog.dismissCollectionNote,
    onSuccess: () => invalidateFor(qc, 'catalog'),
  });
  const remove = useMutation({
    mutationFn: api.catalog.deleteCollection,
    onSuccess: () => invalidateFor(qc, 'catalog'),
  });
  const rows = mine.data?.collections ?? [];
  return (
    <section aria-labelledby="mine-heading" className="space-y-3 rounded-section border border-line bg-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="mine-heading" className="flex items-center gap-2 text-lg font-semibold">
            Your collections
            <HelpButton helpKey="catalog.yourCollections" />
          </h2>
          <p className="text-sm text-muted">Put modules and parts together, like “Starter town”: just for you, or for everyone.</p>
        </div>
        <button
          type="button"
          onClick={() => setEditing({ id: null })}
          className="tap-target rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:bg-accent-hover"
        >
          New collection
        </button>
      </div>
      {mine.isSuccess && rows.length === 0 && (
        <p className="text-sm text-muted">None yet. Make one here, or use “Add to a collection…” on any module or part.</p>
      )}
      {rows.length > 0 && (
        <ul className="divide-y divide-line">
          {rows.map((c) => {
            const st = collectionStatus(c);
            return (
              <li key={c.id} data-testid="my-collection" className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <Cover url={c.coverUrl} className="size-12 shrink-0" />
                <div className="min-w-[10rem] flex-1">
                  <Link to={`/catalog/collections/${c.id}`} className="font-medium hover:underline">
                    {c.title}
                  </Link>
                  <p className="text-xs text-muted">{counts(c)}</p>
                  {c.curatorNote && (
                    <p role="note" className="mt-1 whitespace-pre-line rounded-md bg-soft px-2 py-1 text-xs">
                      {c.curatorNote}{' '}
                      <button type="button" onClick={() => dismiss.mutate(c.id)} className="font-semibold text-accent-text hover:underline">
                        OK
                      </button>
                    </p>
                  )}
                </div>
                <span
                  data-testid="collection-status"
                  className={`${chip} ${st.tone === 'ok' ? 'bg-accent/15 text-accent-text' : st.tone === 'wait' ? 'bg-soft text-ink' : 'bg-danger/15 text-danger'}`}
                >
                  {st.label}
                </span>
                {c.status !== 'withdrawn' && (
                  <button
                    type="button"
                    onClick={() => setEditing({ id: c.id })}
                    aria-label={`Edit ${c.title}`}
                    className="tap-target rounded-lg border border-border px-3 py-1.5 hover:bg-soft"
                  >
                    Edit
                  </button>
                )}
                <button
                  type="button"
                  disabled={remove.isPending}
                  onClick={async () => {
                    if (await confirmDelete(c.title, deleteWording(c))) remove.mutate(c.id, { onSuccess: () => toastDeleted(c.title) });
                  }}
                  aria-label={`Delete ${c.title}`}
                  className="tap-target rounded-lg border border-border px-3 py-1.5 text-danger hover:bg-soft disabled:opacity-50"
                >
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {editing && <CollectionEditor id={editing.id} onClose={() => setEditing(null)} />}
    </section>
  );
}

export { sizeText } from '../ui/CoverPicker';

/** One item in the editor's list. */
export interface Picked {
  source: 'catalog' | 'library';
  kind: CatalogKind;
  id: string;
  title: string;
  previewUrl: string;
}

export const pickedEntry = (p: Picked): CollectionEntry => (p.source === 'catalog' ? { source: 'catalog', id: p.id } : { source: 'library', kind: p.kind, id: p.id });
const pickedKey = (p: Pick<Picked, 'source' | 'kind' | 'id'>) => `${p.source}:${p.kind}:${p.id}`;

type KindFilter = 'all' | CatalogKind;

/** Search results: catalog items, then the curator's (or club's) own modules and parts. */
export function filterLibrary<T extends { title: string; kind: CatalogKind }>(rows: readonly T[], q: string, kind: KindFilter): T[] {
  const needle = q.trim().toLowerCase();
  return rows.filter((r) => (kind === 'all' || r.kind === kind) && (!needle || r.title.toLowerCase().includes(needle)));
}

/**
 * Make or change a collection: title, description, who can see it, items in
 * order, and the cover. `club` makes it that club's; `initial` puts items
 * in a new one ("New collection with this").
 */
export function CollectionEditor({
  id,
  club,
  initial,
  onClose,
}: {
  id: string | null;
  club?: { id: string; slug: string; name: string } | null;
  initial?: Picked[];
  onClose: () => void;
}) {
  useEscape(onClose);
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const settings = useQuery({ queryKey: ['catalog-settings'], queryFn: api.catalog.settings });
  const existing = useQuery({ queryKey: ['catalog-collection', id], queryFn: () => api.catalog.collection(id!), enabled: !!id });
  const modules = useQuery({ queryKey: ['modules'], queryFn: api.modules.list });
  const parts = useQuery({ queryKey: ['custom-parts'], queryFn: api.customParts.list });
  const [loadedFrom, setLoadedFrom] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [items, setItems] = useState<Picked[]>(initial ?? []);
  const [cover, setCover] = useState<string | null>(null);
  const [audience, setAudience] = useState<CollectionAudience>('private');
  const [q, setQ] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [error, setError] = useState<string | null>(null);
  // The cover: an item's picture, or one they upload (CoverPicker places it).
  const [coverMode, setCoverMode] = useState<CoverMode>('drawn');
  const [hadUpload, setHadUpload] = useState<string | null>(null);
  const picker = useRef<CoverPickerHandle | null>(null);
  const [coverError, setCoverError] = useState<string | null>(null);

  // Start from the change waiting for review, if any, else what's there.
  const d = existing.data;
  const owner = club ?? d?.collection.clubInfo ?? null;
  if (id && d && loadedFrom !== id) {
    const c = d.collection;
    const text = c.pending ?? c;
    setLoadedFrom(id);
    setTitle(text.title);
    setDescription(text.description);
    setItems(d.items.map((i) => ({ source: i.source ?? 'catalog', kind: i.kind, id: i.id, title: i.title, previewUrl: i.previewUrl })));
    const coverItem = text.coverItemId ? `catalog:${d.items.find((i) => i.id === text.coverItemId)?.kind ?? 'module'}:${text.coverItemId}` : null;
    setCover(text.coverModuleId ? `library:module:${text.coverModuleId}` : coverItem);
    const uploaded = (c.pending ? c.pending.coverImageId : c.coverImageId) ? (c.pending?.coverUrl ?? c.coverUrl) : null;
    setHadUpload(uploaded);
    setCoverMode(uploaded ? 'upload' : 'drawn');
    setAudience(c.audience ?? 'everyone');
  }

  const on: CatalogKind[] = kindsOn(settings.data);
  const kinds = on.filter((k) => kindFilter === 'all' || kindFilter === k);
  const found = useQuery({
    queryKey: ['catalog-items', 'picker', kinds.join(','), q],
    queryFn: async () => (await Promise.all(kinds.map((k) => api.catalog.items(k, { q })))).flatMap((r) => r.items),
    enabled: kinds.length > 0,
  });
  // The curator's own (or the club's) modules and parts.
  const myId = me.data?.user?.id;
  const ownsIt = (o: { ownerUserId: string | null; ownerOrgId: string | null }) => (owner ? o.ownerOrgId === owner.id : !!myId && o.ownerUserId === myId && !o.ownerOrgId);
  const library: Picked[] = [
    ...(modules.data?.modules ?? [])
      .filter(ownsIt)
      .map((m) => ({ source: 'library' as const, kind: 'module' as const, id: m.id, title: m.title, previewUrl: m.thumbnailAt ? `/api/modules/${m.id}/thumbnail?v=${m.thumbnailAt}` : '' })),
    ...(parts.data?.parts ?? [])
      .filter(ownsIt)
      .map((p) => ({ source: 'library' as const, kind: 'part' as const, id: p.id, title: p.displayName || p.partNumber, previewUrl: api.customParts.spriteUrl(p.id) })),
  ];
  const libraryFound = filterLibrary(library, q, kindFilter);
  const catalogFound = found.data ?? [];

  const save = useMutation({
    mutationFn: async () => {
      const coverPicked = items.find((i) => pickedKey(i) === cover);
      const body = {
        title: title.trim(),
        description: description.trim(),
        entries: items.map(pickedEntry),
        coverItemId: coverPicked?.source === 'catalog' ? coverPicked.id : null,
        coverModuleId: coverPicked?.source === 'library' && coverPicked.kind === 'module' ? coverPicked.id : null,
        audience,
      };
      let saved = id ? await api.catalog.updateCollection(id, body) : await api.catalog.createCollection({ ...body, ...(owner ? { clubSlug: owner.slug } : {}) });
      // The collection is saved; a picture that fails says so without losing it.
      try {
        const upload = await picker.current?.compose();
        if (coverMode === 'upload' && upload) saved = { ...saved, ...(await api.catalog.uploadCollectionCover(saved.id, { mime: upload.mime, data: upload.data })) };
        else if (hadUpload && coverMode === 'drawn') saved = { ...saved, ...(await api.catalog.removeCollectionCover(saved.id)) };
      } catch (e) {
        setCoverError(`Saved, but the cover picture wasn’t: ${(e as Error).message}`);
      }
      return saved;
    },
    onSuccess: () => invalidateFor(qc, 'catalog'),
    onError: (e: Error) => setError(e.message),
  });

  const has = new Set(items.map(pickedKey));
  const result = save.data;
  const nothingFound = (found.isSuccess || kinds.length === 0) && catalogFound.length === 0 && libraryFound.length === 0;
  const put = (p: Picked) => setItems([...items, p]);
  const resultRow = (p: Picked, by?: string) => (
    <li key={pickedKey(p)} className="flex items-center gap-2 px-2 py-1.5">
      <span className="flex-1">
        {p.title}{' '}
        <span className="text-xs text-muted">
          ({p.kind}
          {by ? `, by ${by}` : ''})
        </span>
      </span>
      <button
        type="button"
        disabled={has.has(pickedKey(p))}
        aria-label={`Put ${p.title} in the collection`}
        onClick={() => put(p)}
        className="rounded-lg border border-border px-2 py-1 hover:bg-soft disabled:opacity-40"
      >
        {has.has(pickedKey(p)) ? 'In it' : 'Add'}
      </button>
    </li>
  );
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={id ? 'Edit collection' : 'New collection'}
        className="w-full max-w-2xl space-y-4 rounded-section border border-line bg-panel p-4 text-sm sm:p-5"
      >
        <h3 className="text-lg font-semibold">
          {id ? 'Edit collection' : 'New collection'}
          {owner ? <span className="font-normal text-muted"> · {owner.name}</span> : null}
        </h3>
        {result ? (
          <>
            <p role="status">{savedSummary(result, audience, owner?.name)}</p>
            {coverError && <p className="text-danger">{coverError}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Link
                to={`/catalog/collections/${result.id}`}
                onClick={onClose}
                className="tap-target rounded-lg bg-accent px-4 py-2 font-semibold text-accent-ink hover:bg-accent-hover"
              >
                Open collection
              </Link>
              <button type="button" onClick={onClose} className="tap-target rounded-lg border border-border px-4 py-2 hover:bg-soft">
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="block">
              <span className="mb-1 block text-muted">Title</span>
              <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} className="min-h-10 w-full rounded-lg border border-border bg-soft px-3" />
            </label>
            <label className="block">
              <span className="mb-1 block text-muted">Description (optional)</span>
              <textarea
                value={description}
                maxLength={1000}
                rows={2}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full rounded-lg border border-border bg-soft px-3 py-2"
              />
            </label>
            <fieldset className="space-y-1">
              <legend className="mb-1 flex items-center gap-2 text-muted">
                Who can see this
                <HelpButton helpKey="collection.audience" />
              </legend>
              <label className="flex min-h-9 items-center gap-2">
                <input type="radio" name="audience" checked={audience === 'private'} onChange={() => setAudience('private')} />
                {audienceLabel('private', owner?.name)}
              </label>
              <label className="flex min-h-9 items-center gap-2">
                <input type="radio" name="audience" checked={audience === 'everyone'} onChange={() => setAudience('everyone')} disabled={on.length === 0} />
                Everyone (reviewed first)
              </label>
              {audience === 'everyone' && items.some((i) => i.source === 'library') && (
                <p className="text-xs text-muted">
                  {owner ? `${owner.name}’s` : 'Your'} own modules and parts in it are shared to the catalog, each for its own review, and show publicly once
                  approved.
                </p>
              )}
            </fieldset>
            <div className="space-y-2">
              <p className="text-muted">In this collection ({items.length}), in this order</p>
              {items.length === 0 ? (
                <p className="rounded-lg border border-dashed border-line p-3 text-muted">Nothing yet. Find modules and parts below and add them.</p>
              ) : (
                <ol aria-label="Items in the collection" className="divide-y divide-line rounded-lg border border-line">
                  {items.map((it, n) => (
                    <li key={pickedKey(it)} className="flex flex-wrap items-center gap-2 px-2 py-1.5">
                      <Cover url={it.previewUrl || null} className="size-10 shrink-0" />
                      <span className="min-w-[8rem] flex-1">
                        {it.title} <span className="text-xs text-muted">({it.kind})</span>
                      </span>
                      {coverMode === 'drawn' && !(it.source === 'library' && it.kind === 'part') && (
                        <label className="flex items-center gap-1 text-xs">
                          <input
                            type="radio"
                            name="cover"
                            checked={cover === pickedKey(it)}
                            onChange={() => setCover(pickedKey(it))}
                            aria-label={`Use ${it.title} as the cover`}
                          />
                          Cover
                        </label>
                      )}
                      <button type="button" aria-label={`Move ${it.title} up`} disabled={n === 0} onClick={() => setItems(moveItem(items, n, n - 1))} className="rounded px-2 hover:bg-soft disabled:opacity-40">
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${it.title} down`}
                        disabled={n === items.length - 1}
                        onClick={() => setItems(moveItem(items, n, n + 1))}
                        className="rounded px-2 hover:bg-soft disabled:opacity-40"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        aria-label={`Take ${it.title} out`}
                        onClick={() => {
                          setItems(items.filter((x) => pickedKey(x) !== pickedKey(it)));
                          if (cover === pickedKey(it)) setCover(null);
                        }}
                        className="rounded px-2 text-danger hover:bg-soft"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ol>
              )}
              {coverMode === 'drawn' && <p className="text-xs text-muted">Without a chosen cover, the first module’s picture is used.</p>}
            </div>
            <CoverPicker
              mode={coverMode}
              onModeChange={setCoverMode}
              drawnLabel="Use an item’s picture"
              drawnUrl={(items.find((i) => pickedKey(i) === cover) ?? items.find((i) => i.kind === 'module') ?? items[0])?.previewUrl || null}
              drawnHint={<p className="text-xs text-muted">Pick which item with “Cover” in the list below.</p>}
              currentUrl={hadUpload}
              maxBytes={settings.data?.coverMaxBytes ?? 5 * 1024 * 1024}
              reviewNote={audience === 'everyone' ? 'A moderator checks it before everyone sees it.' : undefined}
              handle={picker}
            />
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <input
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Find modules and parts"
                  aria-label="Find modules and parts"
                  className="min-h-10 min-w-0 flex-1 rounded-lg border border-border bg-soft px-3"
                />
                <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as KindFilter)} aria-label="Show modules or parts" className="min-h-10 rounded-lg border border-border bg-soft px-2">
                  <option value="all">Modules and parts</option>
                  <option value="module">Modules</option>
                  <option value="part">Parts</option>
                </select>
              </div>
              {nothingFound ? (
                <p data-testid="picker-empty" className="rounded-lg border border-dashed border-line p-3 text-muted">
                  {q ? 'Nothing matches.' : 'Nothing to add yet.'} A collection holds modules and parts from the public catalog, and{' '}
                  {owner ? `${owner.name}’s` : 'your'} own. To put someone else’s in, it has to be shared to the catalog first.{' '}
                  <Link to="/help#catalog" className="font-semibold text-accent-text hover:underline">
                    How to share a module or part
                  </Link>
                </p>
              ) : (
                <div className="max-h-64 space-y-2 overflow-y-auto">
                  {libraryFound.length > 0 && (
                    <ul aria-label={owner ? `${owner.name}’s modules and parts` : 'Your modules and parts'} className="divide-y divide-line rounded-lg border border-line">
                      <li className="bg-soft px-2 py-1 text-xs font-semibold text-muted">{owner ? `${owner.name}’s modules and parts` : 'Your modules and parts'}</li>
                      {libraryFound.map((p) => resultRow(p))}
                    </ul>
                  )}
                  {catalogFound.length > 0 && (
                    <ul aria-label="Catalog items to add" className="divide-y divide-line rounded-lg border border-line">
                      <li className="bg-soft px-2 py-1 text-xs font-semibold text-muted">From the catalog</li>
                      {catalogFound.map((it) => resultRow({ source: 'catalog', kind: it.kind, id: it.id, title: it.title, previewUrl: it.previewUrl }, it.by))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            {error && <p className="text-danger">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="tap-target rounded-lg border border-border px-4 py-2 hover:bg-soft">
                Cancel
              </button>
              <button
                type="button"
                disabled={save.isPending || !title.trim() || items.length === 0}
                onClick={() => {
                  setError(null);
                  save.mutate();
                }}
                className="tap-target rounded-lg bg-accent px-4 py-2 font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50"
              >
                {audience === 'everyone' && !id ? 'Submit' : id ? 'Save changes' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** "Add all": every item to me or a club; what's already there is skipped. */
function AddAllDialog({ c, onClose }: { c: CollectionDetail; onClose: () => void }) {
  useEscape(onClose);
  const qc = useQueryClient();
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: api.orgs.list });
  const [owner, setOwner] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => api.catalog.addCollection(c.id, owner || undefined),
    onSuccess: (r) => {
      void invalidateFor(qc, 'catalog');
      if (r.added.some((a) => a.kind === 'part')) void qc.fetchQuery({ queryKey: ['parts-catalog'], queryFn: api.parts.catalog, staleTime: 0 }).catch(() => undefined);
    },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/60 p-4">
      <div role="dialog" aria-modal="true" aria-label={`Add all of ${c.title}`} className="w-full max-w-md space-y-4 rounded-section border border-line bg-panel p-5 text-sm">
        <h3 className="text-lg font-semibold">Add all</h3>
        {add.data ? (
          <>
            <p role="status">{addAllSummary(add.data)} They’re your own copies: change them as you like.</p>
            <div className="flex justify-end">
              <button type="button" onClick={onClose} className="tap-target rounded-lg border border-border px-4 py-2 hover:bg-soft">
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              A copy of each of the {c.itemCount} items in “{c.title}” ({counts(c)}) goes to the place below. Ones already there are skipped.
            </p>
            <SaveToPicker value={owner} onChange={setOwner} orgs={orgs.data?.orgs} />
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
                Add all
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** One of the collection's own modules or parts, copied to you or a club. */
function AddLibraryDialog({ item, onClose }: { item: CollectionItem; onClose: () => void }) {
  useEscape(onClose);
  const qc = useQueryClient();
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: api.orgs.list });
  const [owner, setOwner] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => api.modules.copy(item.id, owner || undefined),
    onSuccess: () => invalidateFor(qc, 'module'),
    onError: (e: Error) => setError(e.message),
  });
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/60 p-4">
      <div role="dialog" aria-modal="true" aria-label={`Add ${item.title}`} className="w-full max-w-md space-y-4 rounded-section border border-line bg-panel p-5 text-sm">
        <h3 className="text-lg font-semibold">Add to my modules</h3>
        {add.data ? (
          <>
            <p role="status">“{item.title}” is now in your modules. It’s your own copy: change it as you like.</p>
            <div className="flex justify-end gap-2">
              <Link to={`/modules/${add.data.id}`} className="tap-target rounded-lg bg-accent px-4 py-2 font-semibold text-accent-ink hover:bg-accent-hover">
                Open it
              </Link>
              <button type="button" onClick={onClose} className="tap-target rounded-lg border border-border px-4 py-2 hover:bg-soft">
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p>A copy of “{item.title}” goes to:</p>
            <SaveToPicker value={owner} onChange={setOwner} orgs={orgs.data?.orgs} kind="module" />
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

/** /catalog/collections/:id */
export function CollectionPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const data = useQuery({ queryKey: ['catalog-collection', id], queryFn: () => api.catalog.collection(id), retry: false });
  const [adding, setAdding] = useState<CollectionItem | null>(null);
  const [toCollection, setToCollection] = useState<CollectionTarget | null>(null);
  const [addAll, setAddAll] = useState(false);
  const [editing, setEditing] = useState(false);
  const gone = () => {
    void invalidateFor(qc, 'catalog');
    const club = data.data?.collection.clubInfo;
    navigate(club ? `/orgs/${club.slug}` : '/catalog?kind=collections');
  };
  const withdraw = useMutation({ mutationFn: () => api.catalog.withdrawCollection(id), onSuccess: gone });
  const remove = useMutation({ mutationFn: () => api.catalog.deleteCollection(id), onSuccess: gone });
  const modRemove = useMutation({ mutationFn: (reason: string) => api.moderation.removeCollection(id, reason), onSuccess: gone });
  const pin = useMutation({
    mutationFn: (pinned: boolean) => api.catalog.updateCollection(id, { pinned }),
    onSuccess: () => invalidateFor(qc, 'catalog'),
  });
  const user = me.data?.user ?? null;
  // Gone (deleted, or you left its club) after it was shown: say so, don't keep showing it.
  const c = data.isError ? undefined : data.data?.collection;
  const items = (data.isError ? undefined : data.data?.items) ?? [];
  const clubName = c?.clubInfo?.name ?? null;
  // Members of its club (or its curator) can add its own modules; anyone signed in adds catalog items.
  const member = !!c && (c.canEdit || !!c.myRole);
  return (
    <div className="theme-page h-full overflow-y-auto bg-bg p-4 text-ink sm:p-8">
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
      <main className="mx-auto mt-6 max-w-5xl space-y-5">
        <Link to="/catalog?kind=collections" className="text-sm text-accent-text hover:underline">‹ Catalog</Link>
        {data.isLoading ? (
          <p className="text-muted">Loading…</p>
        ) : !c ? (
          <p className="rounded-lg border border-dashed border-line p-6 text-center text-muted">This collection isn’t in the catalog, or you can’t see it.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-start gap-4">
              <Cover url={c.coverUrl} className="aspect-[4/3] w-full max-w-48" />
              <div className="min-w-[14rem] flex-1 space-y-1">
                <h1 className="text-2xl font-bold">{c.title}</h1>
                <p className="text-sm text-muted">
                  {c.featured ? 'Featured · ' : ''}
                  {counts(c)} · by {c.clubInfo ? <Link to={`/orgs/${c.clubInfo.slug}`} className="hover:underline">{c.by}</Link> : c.by}
                  {c.trustedClub && <TrustedBadge />}
                </p>
                <p data-testid="collection-audience" className="text-sm">
                  <span className="text-muted">Who can see this:</span> {c.audience === 'private' ? audienceLabel('private', clubName) : 'Everyone'}
                </p>
                {c.description && <p>{c.description}</p>}
                {c.canEdit && (
                  <p data-testid="collection-status" className="text-sm font-semibold">
                    {collectionStatus({ ...c, pending: !!c.pending }, clubName).label}
                  </p>
                )}
                {c.curatorNote && <p className="whitespace-pre-line rounded-md bg-soft px-2 py-1 text-xs">{c.curatorNote}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                {user ? (
                  (member || c.status === 'public') &&
                  items.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setAddAll(true)}
                      className="tap-target rounded-lg bg-accent px-4 py-2 font-semibold text-accent-ink hover:bg-accent-hover"
                    >
                      Add all
                    </button>
                  )
                ) : (
                  <SignInLink className="tap-target rounded-lg border border-border px-4 py-2 font-semibold hover:bg-soft">
                    Sign in to add
                  </SignInLink>
                )}
                {c.canEdit && c.status !== 'withdrawn' && (
                  <button type="button" onClick={() => setEditing(true)} className="tap-target rounded-lg border border-border px-4 py-2 hover:bg-soft">
                    Edit
                  </button>
                )}
                {c.canEdit && c.clubInfo && (
                  <button
                    type="button"
                    aria-pressed={!!c.pinned}
                    onClick={() => pin.mutate(!c.pinned)}
                    className="tap-target rounded-lg border border-border px-4 py-2 hover:bg-soft"
                  >
                    {c.pinned ? 'Unpin' : 'Pin to the top'}
                  </button>
                )}
                {c.canEdit && c.audience !== 'private' && c.status !== 'withdrawn' && !c.clubInfo && (
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await askConfirm({
                        title: `Withdraw “${c.title}” from the catalog?`,
                        removes: 'It leaves the public catalog, so nobody new can add it.',
                        keeps: 'Your collection stays here, and copies people already added keep working.',
                        undo: 'You can share it to the catalog again later.',
                        confirmLabel: 'Withdraw',
                      });
                      if (ok) withdraw.mutate();
                    }}
                    className="tap-target rounded-lg border border-border px-4 py-2 text-danger hover:bg-soft"
                  >
                    Withdraw
                  </button>
                )}
                {c.canEdit && (
                  <button
                    type="button"
                    onClick={async () => {
                      if (await confirmDelete(c.title, deleteWording(c))) remove.mutate(undefined, { onSuccess: () => toastDeleted(c.title) });
                    }}
                    className="tap-target rounded-lg border border-border px-4 py-2 text-danger hover:bg-soft"
                  >
                    Delete
                  </button>
                )}
                {c.canRemove && !c.canEdit && (
                  <button
                    type="button"
                    onClick={async () => {
                      const reason = await askReason({
                        ...deleteOptions(c.title, {
                          verb: 'Remove',
                          removes: `It’s removed from ${clubName ?? 'the club'}.`,
                          keeps: 'Its modules and parts aren’t deleted.',
                        }),
                        reason: { label: 'Say why (the club’s admins can ask)' },
                      });
                      if (reason !== null) modRemove.mutate(reason);
                    }}
                    className="tap-target rounded-lg border border-border px-4 py-2 text-danger hover:bg-soft"
                  >
                    Remove (moderator)
                  </button>
                )}
              </div>
            </div>
            {items.length === 0 && <p className="rounded-lg border border-dashed border-line p-6 text-center text-muted">Nothing in it to show yet.</p>}
            <ul aria-label="Items in this collection" className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-3">
              {items.map((it) => {
                const waiting = reviewLabel(it.review);
                return (
                  <li key={`${it.source ?? 'catalog'}:${it.id}`} data-testid="collection-item" className="flex flex-col gap-2 rounded-section border border-line bg-panel p-3">
                    <CatalogPreview item={it} />
                    <div className="min-w-0 flex-1 space-y-1">
                      <h2 className="break-words font-semibold">{it.title}</h2>
                      <p className="text-xs text-muted">
                        {KIND_NAME[it.kind]} by {it.by}
                        {it.source === 'library' ? '' : ` · version ${it.version}`}
                      </p>
                      {waiting && (
                        <p data-testid="item-review" className={`${chip} inline-block bg-soft text-ink`}>
                          {waiting}
                        </p>
                      )}
                      {it.description && <p className="line-clamp-3 text-sm">{it.description}</p>}
                    </div>
                    {user && (
                      <div className="flex flex-wrap gap-2">
                        {(it.source !== 'library' || it.kind === 'module') && (
                          <button
                            type="button"
                            onClick={() => setAdding(it)}
                            aria-label={`Add ${it.title}`}
                            className="tap-target rounded-lg border border-border px-3 py-1.5 text-sm font-semibold hover:bg-soft"
                          >
                            Add
                          </button>
                        )}
                        {it.source !== 'library' && !me.data?.user?.isDemoAccount && (
                          <button
                            type="button"
                            onClick={() => setToCollection({ kind: 'catalog', item: it })}
                            aria-label={`${it.title}: add to a collection`}
                            className="tap-target rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-soft"
                          >
                            Add to a collection…
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {addAll && <AddAllDialog c={c} onClose={() => setAddAll(false)} />}
            {editing && <CollectionEditor id={c.id} club={c.clubInfo ?? null} onClose={() => setEditing(false)} />}
          </>
        )}
      </main>
      {adding && (adding.source === 'library' ? <AddLibraryDialog item={adding} onClose={() => setAdding(null)} /> : <AddDialog item={adding} onClose={() => setAdding(null)} />)}
      {toCollection && <AddToCollectionDialog target={toCollection} onClose={() => setToCollection(null)} />}
    </div>
  );
}

/** The Home page's collections: featured ones, your clubs', your own; hidden while the catalogs are off. */
export function HomeCollections() {
  const demo = useIsDemo();
  const settings = useQuery({ queryKey: ['catalog-settings'], queryFn: api.catalog.settings });
  const on = !!settings.data && (settings.data.modules || settings.data.parts);
  const pub = useQuery({ queryKey: ['catalog-collections'], queryFn: api.catalog.collections, enabled: on });
  const clubs = useQuery({ queryKey: ['club-collections', ''], queryFn: () => api.catalog.clubCollections(), enabled: on });
  const mine = useQuery({ queryKey: ['catalog-collections-mine'], queryFn: api.catalog.myCollections, enabled: on });
  const [creating, setCreating] = useState(false);
  if (!on) return null;
  const featured = (pub.data?.collections ?? []).filter((c) => c.featured).slice(0, 4);
  const clubRows: ClubCollection[] = (clubs.data?.clubs ?? []).flatMap((cl) => cl.collections.filter((c) => c.itemCount > 0)).slice(0, 8);
  const mineRows = (mine.data?.collections ?? []).filter((c) => c.status !== 'withdrawn').slice(0, 8);
  const empty = !featured.length && !clubRows.length && !mineRows.length;
  const row = (label: string, rows: CollectionSummary[], testId: string) =>
    rows.length > 0 && (
      <div className="space-y-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">{label}</h3>
        <ul aria-label={label} className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] sm:gap-3">
          {rows.map((c) => (
            <CollectionCard key={c.id} c={c} testId={testId} />
          ))}
        </ul>
      </div>
    );
  return (
    <section aria-labelledby="home-collections" className="space-y-3" data-testid="home-collections">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="home-collections" className="flex items-center gap-2 text-2xl font-bold">
          Collections
          <HelpButton helpKey="catalog.collections" />
        </h2>
        <div className="flex flex-wrap gap-2">
          <Link to="/catalog?kind=collections" className="tap-target inline-flex items-center rounded-lg border border-border px-3 py-1.5 text-sm font-semibold hover:bg-soft">
            Browse all
          </Link>
          {!demo && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="tap-target rounded-lg border border-border px-3 py-1.5 text-sm font-semibold hover:bg-soft"
            >
              New collection
            </button>
          )}
        </div>
      </div>
      {empty ? (
        <p className="rounded-lg border border-dashed border-line p-4 text-sm text-muted">
          Collections are sets of modules and parts that go well together. Browse the catalog’s{demo ? '.' : ', or make your own.'}
        </p>
      ) : (
        <>
          {row('Featured', featured, 'home-featured-collection')}
          {row('Your clubs’', clubRows, 'home-club-collection')}
          {row('Yours', mineRows, 'home-my-collection')}
        </>
      )}
      {creating && <CollectionEditor id={null} onClose={() => setCreating(false)} />}
    </section>
  );
}
