import { Suspense, useEffect, useMemo, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { lazyRetry } from '../ui/lazyRetry';
import { RenameDialog, MAX_NAME_LENGTH } from '../ui/RenameDialog';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, lowResThumbnail, type LayoutSummary, type ModuleSummary, type OrgSummary } from '../api';
import { defaultSaveTo, matchesOwnerFilter, useOwnerFilter, type OwnedItem } from '../owners/owners';
import { CreditLine, MoveCopyDialog, OwnerChip, OwnerFilterBar, ReturnMenuItems, SaveToPicker } from '../owners/OwnerControls';
import { HelpButton } from '../help/HelpButton';
import { MoreMenu, MORE_ITEM } from '../ui/MoreMenu';
import { getNewLayoutTemplate, setNewLayoutTemplate, templateContent } from './newLayoutTemplate';
import { mapFileToBbm, mapFormatOf, type OpenedMapState } from '../mapFormats';
import { openFilePicker } from '../open/FileOpener';
import { DesktopOnlySteps } from '../open/DesktopOnly';
import { desktopOnlyFormat, OPEN_FORMATS_LINE, START_FILE_ACCEPT, titleFromFileName, type DesktopOnlyFormat } from '../open/openFiles';
import { LAYOUT_FILE, readLayoutFile, type LayoutImage } from '../layoutFile';
import { takeLayoutParts, type PartChoice, type PartDifference } from '../layoutParts';
import { PartDifferencesDialog } from './PartDifferencesDialog';
import { originalHere, OriginalLayoutNotice, type OriginalLayout } from './originalLayout';
import type { Venue } from '@cld/bbm';
import { sidecarWarnings } from '@cld/bbm/browser';
import { VenueList } from '../venues/VenueList';
import { orderVenuesForOwner, sidecarWithVenue } from '../venues/venueStart';
import { CustomPartsSection } from '../parts/CustomPartsSection';
import { AddToCollectionDialog } from '../catalog/AddToCollection';
import { HomeCollections } from '../catalog/Collections';
import { WelcomeCard } from '../tours/WelcomeCard';
import { MyInvites } from '../orgs/MyInvites';
import { WELCOME_ID } from '../tours/tours';
import { usePreferences } from '../theme/PrefsProvider';
import { lastLayoutToReopen } from './reopenLast';
import { useEditorStore } from '../editor/editorStore';
import { ModuleThumb } from '../modules/ModuleThumb';
import { ModuleVersionsDialog } from '../modules/ModuleVersionsDialog';
import { askConfirm, confirmDelete, toastDeleted } from '../ui/ConfirmDialog';
import { LAYOUT_DELETE_WORDING, MODULE_DELETE_WORDING } from '../ui/deleteWording';
import { RecentlyDeleted, restoreDeleted } from '../trash/RecentlyDeleted';
import { CatalogBadge, ShareToCatalogDialog, UpdateAvailable, useCatalogStatus } from '../catalog/ShareToCatalog';
import { useEscape } from '../editor/useEscape';
const ShareDialog = lazyRetry(() => import('./ShareDialog').then((m) => ({ default: m.ShareDialog })));
const ModuleShareDialog = lazyRetry(() => import('../modules/ModuleShareDialog').then((m) => ({ default: m.ModuleShareDialog })));

export function LayoutsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const list = useQuery({ queryKey: ['layouts'], queryFn: api.layouts.list });
  const modules = useQuery({ queryKey: ['modules'], queryFn: api.modules.list });
  const orgsQuery = useQuery({ queryKey: ['orgs'], queryFn: api.orgs.list });
  const orgs = orgsQuery.data?.orgs;
  // The welcome card offers Join a club until it's put away; after that, a small card does.
  const prefs = usePreferences();
  // All · Mine · each club; the last pick is remembered per person, and ?owner=<club> from a club page.
  const [filter, setFilter] = useOwnerFilter(orgs, me.data?.user?.id);
  // "Start layout" on a venue links here with ?newLayoutVenue=<id>[&owner=<club slug>].
  const [params, setParams] = useSearchParams();
  const startVenue = params.get('newLayoutVenue');
  // The editor's New layout (?new=1) opens the dialog; its Open another
  // layout (?open=1) shows the list to pick from.
  const [showCreate, setShowCreate] = useState(startVenue !== null || params.get('new') === '1');
  const pickAnother = params.get('open') === '1';
  // A venue's Start layout links back to this same page, so the page is
  // already open: open the dialog whenever the link arrives, not just on load.
  useEffect(() => {
    if (startVenue !== null) setShowCreate(true);
  }, [startVenue]);
  const [showNewModule, setShowNewModule] = useState(false);
  const [historyOf, setHistoryOf] = useState<ModuleSummary | null>(null);
  const [toCollection, setToCollection] = useState<ModuleSummary | null>(null);
  // A member (not an admin or manager) of a trusted club shares its modules for the club's own review.
  const trustedMember = (m: ModuleSummary) => m.role === 'editor' && !!m.ownerOrgId && !!orgs?.find((o) => o.id === m.ownerOrgId && o.trusted);
  const [sharing, setSharing] = useState<ModuleSummary | null>(null);
  const [sharingPeople, setSharingPeople] = useState<ModuleSummary | null>(null);
  const catalog = useCatalogStatus();
  const withdraw = useMutation({
    mutationFn: api.catalog.withdraw,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['catalog-mine'] }),
  });
  const [shareLayout, setShareLayout] = useState<LayoutSummary | null>(null);
  const [renameLayout, setRenameLayout] = useState<LayoutSummary | null>(null);
  const [moving, setMoving] = useState<{ kind: 'layout' | 'module'; item: LayoutSummary | ModuleSummary } | null>(null);

  const remove = useMutation({
    mutationFn: api.layouts.remove,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['layouts'] }),
  });
  const removeModule = useMutation({
    mutationFn: api.modules.remove,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['modules'] }),
  });

  // "Reopen last layout on startup" (Preferences): once per visit, and
  // never over a link that came here for something else.
  const reopenLastFile = useEditorStore((s) => s.reopenLastFile);
  const location = useLocation();
  useEffect(() => {
    const id = lastLayoutToReopen(reopenLastFile, location.search, location.hash);
    if (id) navigate(`/editor/${id}`, { replace: true });
  // Only on arriving here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // /library and the club page's Parts tab link to #parts: scroll there
  // once the lists are in.
  // Every list above the parts section, so it doesn't move after the scroll.
  const venuesQuery = useQuery({ queryKey: ['venues'], queryFn: api.venues.list });
  const partsQuery = useQuery({ queryKey: ['custom-parts'], queryFn: api.customParts.list });
  const listsReady = !list.isLoading && !modules.isLoading && !venuesQuery.isLoading && !partsQuery.isLoading;
  useEffect(() => {
    if (listsReady && location.hash === '#parts') document.getElementById('parts')?.scrollIntoView({ block: 'start' });
  }, [listsReady, location.hash]);

  // Open another layout: the list, in view, with a word on what to do.
  useEffect(() => {
    if (!pickAnother || list.isLoading) return;
    const h = document.getElementById('layouts-heading');
    h?.scrollIntoView({ block: 'start' });
    h?.focus({ preventScroll: true });
  }, [pickAnother, list.isLoading]);

  if (list.isLoading) return <p className="text-muted">Loading layouts…</p>;

  const myUserId = me.data?.user?.id;
  const hasClubs = (orgs?.length ?? 0) > 0;
  const shown = <T extends OwnedItem>(items: readonly T[]) => items.filter((i) => matchesOwnerFilter(i, filter, myUserId, orgs));
  const layouts = shown(list.data?.layouts ?? []);
  const moduleList = shown(modules.data?.modules ?? []);
  const club = orgs?.find((o) => o.slug === filter);
  const where = club ? `${club.name} has` : filter === 'me' ? 'You have' : 'There are';

  return (
    <section className="space-y-8">
      <WelcomeCard name={me.data?.user?.displayName} onLayout={() => setShowCreate(true)} />
      {me.data?.user && <MyInvites />}

      {!hasClubs && orgsQuery.isSuccess && prefs.ready && prefs.prefs.toursSeen.includes(WELCOME_ID) && (
        <div data-tour="clubs.join" data-testid="join-club-card" className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-panel px-4 py-3">
          <p className="text-sm text-muted">
            <span className="font-semibold text-ink">Not in a club yet?</span> A club admin can send you an invite link, or you can start your own club.
          </p>
          <Link to="/orgs" className="tap-target rounded-lg border border-border px-3 py-1.5 text-sm font-semibold hover:bg-soft">
            Join a club
          </Link>
        </div>
      )}
      {hasClubs && orgs && (
        <div className="space-y-2" data-tour="owners.filter">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Show</h2>
            <HelpButton helpKey="owners.filter" />
          </div>
          <OwnerFilterBar value={filter} onChange={setFilter} orgs={orgs} />
          {club && (
            <p className="text-sm text-muted">
              Showing {club.name}’s layouts, venues, modules and parts.{' '}
              <Link to={`/orgs/${club.slug}`} className="font-semibold text-accent-text hover:underline">
                Club page
              </Link>
            </p>
          )}
        </div>
      )}

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="layouts-heading" tabIndex={-1} className="text-2xl font-bold outline-hidden">Layouts</h2>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={openFilePicker}
              className="tap-target rounded-lg border border-border px-3 py-1.5 text-sm font-semibold hover:bg-soft"
            >
              Open a file…
            </button>
            <button
              onClick={() => setShowCreate(true)}
              data-tour="publish.owner"
              className="tap-target rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink hover:bg-accent-hover"
            >
              New layout
            </button>
          </div>
        </div>
        {pickAnother && (
          <p data-testid="pick-another" role="status" className="rounded-lg border border-accent bg-accent-soft px-3 py-2 text-sm text-ink">
            Pick a layout below to open it, or use <b>Open a file…</b> to bring one in.
          </p>
        )}
        <p className="flex items-start gap-1 text-sm text-muted" data-testid="open-formats">
          <span>{OPEN_FORMATS_LINE} You can also drop a file anywhere on this page.</span>
          <HelpButton helpKey="open.formats" />
        </p>
        {layouts.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-8 text-center text-muted">
            {where} no layouts yet. Click <em>New layout</em> to start one, or <em>Open a file…</em> to bring one in.
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-panel">
            {layouts.map((l) => (
              <LayoutRow
                key={l.id}
                layout={l}
                chip={<OwnerChip item={l} myUserId={myUserId} orgs={orgs} />}
                onDelete={async () => {
                  const ok = await confirmDelete(l.title, LAYOUT_DELETE_WORDING);
                  if (ok) remove.mutate(l.id, { onSuccess: (r) => toastDeleted(l.title, r.trashId ? () => void restoreDeleted(r.trashId) : undefined) });
                }}
                onShare={() => setShareLayout(l)}
                onRename={() => setRenameLayout(l)}
                onMove={hasClubs ? () => setMoving({ kind: 'layout', item: l }) : undefined}
              />
            ))}
          </ul>
        )}
      </div>

      {showCreate && (
        <CreateLayoutDialog
          initialVenueId={startVenue ?? ''}
          initialOwnerSlug={params.get('owner') ?? defaultSaveTo(filter)}
          onClose={() => {
            setShowCreate(false);
            if (startVenue !== null) setParams({}, { replace: true });
          }}
          onCreated={(id, openWarnings, openedFile) => {
            qc.invalidateQueries({ queryKey: ['layouts'] });
            setShowCreate(false);
            // Open the new layout straight away, like the desktop editor's
            // File > New and "Open a file…" (open/FileOpener.tsx) do.
            const state: OpenedMapState = {
              ...(openWarnings?.length ? { openWarnings } : {}),
              ...(openedFile ? { openedFile } : {}),
            };
            navigate(`/editor/${id}`, Object.keys(state).length ? { state } : undefined);
          }}
        />
      )}

      <div className="space-y-3">
        <h2 className="text-2xl font-bold">Venues</h2>
        <VenueList filter={filter} myUserId={myUserId} orgs={orgs} />
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-2xl font-bold">Modules</h2>
          <button
            onClick={() => setShowNewModule(true)}
            className="tap-target rounded-lg border border-border px-3 py-1.5 text-sm font-semibold hover:bg-soft"
          >
            New module
          </button>
        </div>
        {modules.isLoading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : moduleList.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line p-4 text-sm text-muted">
            {where} no saved modules yet. Click <em>New module</em> to build one from parts, or make a module in a layout and choose <em>Save to Module library…</em> from its ⋯ menu.
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-panel">
            {moduleList.map((m) => (
              <li key={m.id} data-testid="module-row" className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <ModuleThumb module={m} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="break-words font-medium">{m.title}</span>
                    <OwnerChip item={m} myUserId={myUserId} orgs={orgs} />
                    {catalog.shared('module', m.id) && <CatalogBadge item={catalog.shared('module', m.id)!} />}
                    <UpdateAvailable copyId={m.id} label={m.title} />
                  </p>
                  <p className="text-xs text-muted">
                    {m.latestVersion ? `version ${m.latestVersion} · ` : ''}updated {new Date(m.updatedAt).toLocaleString()}
                  </p>
                  <CreditLine credit={m.credit} />
                  {m.role !== 'viewer' && lowResThumbnail(m) && (
                    <p data-testid="low-res-picture" className="text-xs text-muted">
                      Picture is low resolution.{' '}
                      <Link to={`/modules/${m.id}?refresh=picture`} className="font-semibold text-accent-text hover:underline">
                        Refresh it
                      </Link>
                    </p>
                  )}
                </div>
                <Link
                  to={`/modules/${m.id}`}
                  aria-label={`Open ${m.title}`}
                  className="tap-target inline-flex min-h-9 shrink-0 items-center rounded-lg bg-accent px-4 font-semibold text-accent-ink hover:bg-accent-hover"
                >
                  Open
                </Link>
                <MoreMenu label={`More for ${m.title}`}>
                  <button role="menuitem" type="button" onClick={() => setHistoryOf(m)} className={MORE_ITEM}>
                    Version history…
                  </button>
                  {m.role !== 'viewer' && m.thumbnailAt && (
                    <Link role="menuitem" to={`/modules/${m.id}?refresh=picture`} className={MORE_ITEM}>
                      Refresh picture
                    </Link>
                  )}
                  <button role="menuitem" type="button" onClick={() => setSharingPeople(m)} className={MORE_ITEM}>
                    {m.role === undefined || m.role === 'owner' ? 'Share with people…' : 'People with access…'}
                  </button>
                  {(catalog.enabled('module') || catalog.enabled('part')) && (m.role === undefined || m.role === 'owner') && (
                    <button role="menuitem" type="button" onClick={() => setToCollection(m)} className={MORE_ITEM}>
                      Add to a collection…
                    </button>
                  )}
                  {catalog.enabled('module') && (m.role === undefined || m.role === 'owner' || trustedMember(m)) && (
                    <button role="menuitem" type="button" onClick={() => setSharing(m)} className={MORE_ITEM}>
                      {catalog.shared('module', m.id) ? 'Publish this update…' : 'Share to the public catalog…'}
                    </button>
                  )}
                  {(m.role === undefined || m.role === 'owner') &&
                    (catalog.shared('module', m.id)?.status === 'public' || catalog.shared('module', m.id)?.status === 'in_review') && (
                      <button
                        role="menuitem"
                        type="button"
                        onClick={async () => {
                          const ok = await askConfirm({
                            title: `Withdraw “${m.title}” from the catalog?`,
                            removes: 'It leaves the public catalog, so nobody new can add it.',
                            keeps: 'Your module stays here, and copies people already added keep working.',
                            undo: 'You can share it to the catalog again later.',
                            confirmLabel: 'Withdraw',
                          });
                          if (ok) withdraw.mutate(catalog.shared('module', m.id)!.id);
                        }}
                        className={MORE_ITEM}
                      >
                        Withdraw from the catalog
                      </button>
                    )}
                  {hasClubs && (
                    <button role="menuitem" type="button" onClick={() => setMoving({ kind: 'module', item: m })} className={MORE_ITEM}>
                      Move or copy…
                    </button>
                  )}
                  <ReturnMenuItems kind="modules" id={m.id} title={m.title} credit={m.credit} />
                  {(m.role === undefined || m.role === 'owner') && (
                    <button
                      role="menuitem"
                      type="button"
                      onClick={async () => {
                        if (await confirmDelete(m.title, MODULE_DELETE_WORDING))
                          removeModule.mutate(m.id, { onSuccess: (r) => toastDeleted(m.title, r.trashId ? () => void restoreDeleted(r.trashId) : undefined) });
                      }}
                      className={`${MORE_ITEM} text-danger`}
                    >
                      Delete
                    </button>
                  )}
                </MoreMenu>
              </li>
            ))}
          </ul>
        )}
      </div>

      <HomeCollections />

      <section id="parts" className="scroll-mt-4">
        <CustomPartsSection
          filter={filter}
          myUserId={myUserId}
          orgs={orgs}
          canUpload={!!me.data?.user && !me.data.user.isDemoAccount}
        />
      </section>

      {me.data?.user && <RecentlyDeleted />}

      {showNewModule && (
        <NewModuleDialog
          initialOwnerSlug={defaultSaveTo(filter)}
          orgs={orgs}
          onClose={() => setShowNewModule(false)}
          // Open it straight away, to build it from parts.
          onCreated={(id) => navigate(`/modules/${id}`)}
        />
      )}

      {historyOf && <ModuleVersionsDialog module={historyOf} onClose={() => setHistoryOf(null)} />}
      {sharingPeople && (
        <Suspense fallback={null}>
          <ModuleShareDialog module={sharingPeople} myUserId={myUserId} onClose={() => setSharingPeople(null)} />
        </Suspense>
      )}
      {toCollection && <AddToCollectionDialog target={{ kind: 'module', module: toCollection }} onClose={() => setToCollection(null)} />}
      {sharing && (
        <ShareToCatalogDialog
          kind="module"
          sourceId={sharing.id}
          title={sharing.title}
          existing={catalog.shared('module', sharing.id)}
          onClose={() => setSharing(null)}
          clubReview={trustedMember(sharing) ? orgs?.find((o) => o.id === sharing.ownerOrgId)?.name : undefined}
        />
      )}

      {moving && orgs && (
        <MoveCopyDialog
          kind={moving.kind}
          item={{ id: moving.item.id, title: moving.item.title, ownerOrgId: moving.item.ownerOrgId }}
          canMove={moving.item.role === undefined || moving.item.role === 'owner'}
          orgs={orgs}
          onClose={() => setMoving(null)}
        />
      )}

      {renameLayout && (
        <RenameDialog
          heading="Rename layout"
          current={renameLayout.title}
          onSave={async (name) => {
            await api.layouts.rename(renameLayout.id, name);
            await Promise.all([
              qc.invalidateQueries({ queryKey: ['layouts'] }),
              qc.invalidateQueries({ queryKey: ['layout', renameLayout.id] }),
            ]);
          }}
          onClose={() => setRenameLayout(null)}
        />
      )}
      {shareLayout && me.data?.user && (
        <ShareDialogLoader
          layout={shareLayout}
          myUserId={me.data.user.id}
          onClose={() => setShareLayout(null)}
        />
      )}
    </section>
  );
}

/** New module: a title and where it's saved. */
function NewModuleDialog({
  initialOwnerSlug,
  orgs,
  onClose,
  onCreated,
}: {
  initialOwnerSlug: string;
  orgs: readonly OrgSummary[] | undefined;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  useEscape(onClose);
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [ownerSlug, setOwnerSlug] = useState(initialOwnerSlug);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: api.modules.create,
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['modules'] });
      onClose();
      onCreated(created.id);
    },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/60 p-4">
      <form
        role="dialog"
        aria-modal="true"
        aria-label="New module"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          create.mutate({
            ...(title.trim() ? { title: title.trim() } : {}),
            ...(ownerSlug ? { orgSlug: ownerSlug } : {}),
          });
        }}
        className="w-full max-w-md space-y-4 rounded-section border border-line bg-panel p-5 text-sm"
      >
        <h3 className="text-lg font-semibold">New module</h3>
        <label className="block">
          <span className="mb-1 block text-muted">Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)} maxLength={MAX_NAME_LENGTH}
            placeholder="Untitled Module"
            className="w-full rounded-lg border border-border bg-soft px-3 py-2"
          />
        </label>
        <SaveToPicker value={ownerSlug} onChange={setOwnerSlug} orgs={orgs} kind="module" />
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="tap-target rounded-lg border border-border px-4 py-2 hover:bg-soft">
            Cancel
          </button>
          <button
            type="submit"
            disabled={create.isPending}
            className="tap-target rounded-lg bg-accent px-4 py-2 text-accent-ink hover:bg-accent-hover disabled:opacity-50"
          >
            Create and open
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Resolves the user's role on the layout before opening ShareDialog. The
 * layouts list response doesn't include the role; we fetch it here and
 * mount the dialog with the right `myRole` to gate owner-only controls.
 */
function ShareDialogLoader({
  layout,
  myUserId,
  onClose,
}: {
  layout: LayoutSummary;
  myUserId: string;
  onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: ['layout', layout.id],
    queryFn: () => api.layouts.get(layout.id),
  });
  if (detail.isLoading || !detail.data) return null;
  return (
    <Suspense fallback={null}>
      <ShareDialog
        layoutId={layout.id}
        layoutTitle={layout.title}
        myRole={detail.data.role}
        myUserId={myUserId}
        onClose={onClose}
      />
    </Suspense>
  );
}

function LayoutRow({
  layout,
  chip,
  onDelete,
  onShare,
  onRename,
  onMove,
}: {
  layout: LayoutSummary;
  chip: ReactNode;
  onDelete: () => void;
  onShare: () => void;
  onRename: () => void;
  /** Move or copy… (only offered to people in a club). */
  onMove?: (() => void) | undefined;
}) {
  // Older servers don't send the role: their list held only your own layouts.
  const isOwner = layout.role === undefined || layout.role === 'owner';
  const catalog = useCatalogStatus();
  // New layouts can start as a copy of this one (desktop's File > New template).
  const [isTemplate, setIsTemplate] = useState(() => getNewLayoutTemplate()?.id === layout.id);
  useEffect(() => {
    const sync = () => setIsTemplate(getNewLayoutTemplate()?.id === layout.id);
    window.addEventListener('cld:template-changed', sync);
    return () => window.removeEventListener('cld:template-changed', sync);
  }, [layout.id]);
  return (
    // The name, then Open and a "⋯" menu with everything else: one tidy
    // line even on a phone.
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2">
          <span className="break-words font-medium">{layout.title}</span>
          {chip}
          {catalog.shared('layout', layout.id) && <CatalogBadge item={catalog.shared('layout', layout.id)!} />}
        </p>
        <p className="text-xs text-muted">
          updated {new Date(layout.updatedAt).toLocaleString()}
          {layout.expiresAt && (
            <>
              {' · '}
              <span className="text-amber-400">
                expires {new Date(layout.expiresAt).toLocaleDateString()}
              </span>
            </>
          )}
        </p>
        <CreditLine credit={layout.credit} />
      </div>
      <div className="flex shrink-0 items-center gap-2 text-sm">
        <Link
          to={`/editor/${layout.id}`}
          className="tap-target inline-flex min-h-9 items-center rounded-lg bg-accent px-4 font-semibold text-accent-ink hover:bg-accent-hover"
        >
          Open
        </Link>
        <MoreMenu label={`More for ${layout.title}`}>
          <button role="menuitem" type="button" onClick={onShare} className={MORE_ITEM}>
            Share…
          </button>
          {layout.role !== 'viewer' && (
            <button role="menuitem" type="button" onClick={onRename} className={MORE_ITEM}>
              Rename…
            </button>
          )}
          <a
            role="menuitem"
            href={api.layouts.exportZipUrl(layout.id)}
            className={MORE_ITEM}
            title="A copy BlueBrick can open (.bbm in a .zip). To keep everything, open the layout and use Map › Download & export › Download layout."
          >
            Download for BlueBrick (.zip)
          </a>
          {isOwner && catalog.enabled('layout') && (
            // Its picture is drawn in the editor, so the share opens there.
            <Link role="menuitem" to={`/editor/${layout.id}?catalog=share`} className={MORE_ITEM}>
              {catalog.shared('layout', layout.id) ? 'Publish a new version to the catalog…' : 'Share to the public catalog…'}
            </Link>
          )}
          <label role="menuitemcheckbox" aria-checked={isTemplate} data-keep-open className={MORE_ITEM} title="New layouts start as a copy of this one">
            <input
              type="checkbox"
              checked={isTemplate}
              onChange={(e) => {
                setNewLayoutTemplate(e.target.checked ? { id: layout.id, title: layout.title } : null);
                window.dispatchEvent(new Event('cld:template-changed'));
              }}
            />
            Template for new layouts
          </label>
          {onMove && (
            <button role="menuitem" type="button" onClick={onMove} className={MORE_ITEM}>
              Move or copy…
            </button>
          )}
          <ReturnMenuItems kind="layouts" id={layout.id} title={layout.title} credit={layout.credit} />
          {isOwner && (
            <button role="menuitem" type="button" onClick={onDelete} className={`${MORE_ITEM} text-danger`}>
              Delete
            </button>
          )}
        </MoreMenu>
      </div>
    </li>
  );
}

function CreateLayoutDialog({
  initialVenueId = '',
  initialOwnerSlug = '',
  onClose,
  onCreated,
}: {
  initialVenueId?: string;
  initialOwnerSlug?: string;
  onClose: () => void;
  /** `openedFile`: the layout started from this file. */
  onCreated: (id: string, openWarnings?: string[], openedFile?: string) => void;
}) {
  useEscape(onClose);
  const [title, setTitle] = useState('');
  const [bbm, setBbm] = useState<string | null>(null);
  // What converting a picked LDraw / TrackDesigner / 4DBrix file skipped.
  const [openWarnings, setOpenWarnings] = useState<string[]>([]);
  const qc = useQueryClient();
  const [sidecar, setSidecar] = useState<string | null>(null);
  // A sidecar saved by a newer version opens, saying some of it isn't shown.
  const sidecarNotes = useMemo(() => (sidecar ? sidecarWarnings(sidecar) : []), [sidecar]);
  // A picked .bld-layout's background image.
  const [background, setBackground] = useState<LayoutImage | null>(null);
  // …and its parts, the missing ones uploaded as custom parts on Create.
  const [layoutParts, setLayoutParts] = useState<Record<string, Uint8Array> | null>(null);
  // Parts the picked layout defines differently from the server, asked about on Create.
  const [asking, setAsking] = useState<{ differing: PartDifference[]; answer: (c: PartChoice[] | null) => void } | null>(null);
  const [bbmFilename, setBbmFilename] = useState<string | null>(null);
  // A picked file only the desktop app opens.
  const [desktopFile, setDesktopFile] = useState<{ name: string; format: DesktopOnlyFormat } | null>(null);
  // A picked .bld-layout saved from a layout on this server that you can open.
  const [original, setOriginal] = useState<OriginalLayout | null>(null);
  // Owner: empty string = personal; otherwise the org slug.
  const [ownerSlug, setOwnerSlug] = useState(initialOwnerSlug);
  // Start from a saved venue: its outline goes into the new layout's sidecar.
  const [venueId, setVenueId] = useState(initialVenueId);
  const venues = useQuery({ queryKey: ['venues'], queryFn: api.venues.list });
  const [error, setError] = useState<string | null>(null);
  // Start from the template layout, when one is set (desktop onNew).
  const [template] = useState(getNewLayoutTemplate);
  const [fromTemplate, setFromTemplate] = useState(template !== null);

  // Fetch the user's orgs so the dialog can offer them as owner options.
  // Cheap; cached by react-query so this almost never hits the network.
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: api.orgs.list });

  const create = useMutation({
    mutationFn: api.layouts.create,
    onError: (e: Error) => setError(e.message),
  });

  async function pickBbm(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    // LDraw, Studio and LDD files are imported in the desktop app: say how.
    const desktop = desktopOnlyFormat(file.name);
    setDesktopFile(desktop ? { name: file.name, format: desktop } : null);
    if (desktop) {
      e.target.value = '';
      return;
    }
    let text: string;
    let warnings: string[] = [];
    setBackground(null);
    setLayoutParts(null);
    setOriginal(null);
    if (LAYOUT_FILE.test(file.name)) {
      // The whole layout: labels, modules, venue and background come with it.
      try {
        const l = await readLayoutFile(new Uint8Array(await file.arrayBuffer()));
        text = l.bbm;
        warnings = l.warnings;
        setSidecar(l.sidecar ?? null);
        setBackground(l.background ?? null);
        setLayoutParts(l.parts ?? null);
        setOriginal(await originalHere(l.source));
      } catch (err) {
        setError(`Could not open ${file.name}: ${(err as Error).message}`);
        return;
      }
    } else if (mapFormatOf(file.name)) {
      // Other map formats are converted with the parts' remaps.
      try {
        const catalog = await qc.fetchQuery({ queryKey: ['parts-catalog'], queryFn: api.parts.catalog, staleTime: 5 * 60 * 1000 });
        ({ bbm: text, warnings } = await mapFileToBbm(file.name, new Uint8Array(await file.arrayBuffer()), catalog.parts));
      } catch (err) {
        setError(`Could not open ${file.name}: ${(err as Error).message}`);
        return;
      }
    } else {
      text = await file.text();
    }
    setBbm(text);
    setOpenWarnings(warnings);
    setBbmFilename(file.name);
    if (!title) setTitle(titleFromFileName(file.name));
  }

  async function pickSidecar(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setSidecar(await file.text());
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const body: { title?: string; bbm?: string; sidecar?: string; orgSlug?: string; backgroundImage?: LayoutImage } = {};
    const t = title.trim();
    if (t) body.title = t;
    if (bbm) body.bbm = bbm;
    if (sidecar) body.sidecar = sidecar;
    if (bbm && background) body.backgroundImage = background;
    // A picked .bbm wins over the template.
    if (!bbm && fromTemplate && template) {
      try {
        const c = await templateContent(template.id);
        body.bbm = c.bbm;
        if (c.sidecar !== undefined) body.sidecar = c.sidecar;
      } catch (err) {
        setError((err as Error).message);
        return;
      }
    }
    if (venueId) {
      try {
        const v = await api.venues.get(venueId);
        body.sidecar = sidecarWithVenue(body.sidecar, v.data as Venue);
      } catch (err) {
        setError(`Could not load the venue: ${(err as Error).message}`);
        return;
      }
    }
    if (ownerSlug) body.orgSlug = ownerSlug;
    // The file's parts this server lacks go up first, so the layout opens with them;
    // the ones it defines differently are asked about first.
    let partNotes: string[] = [];
    if (bbm && layoutParts) {
      try {
        const parts = await takeLayoutParts(
          layoutParts,
          bbm,
          async () => (await qc.fetchQuery({ queryKey: ['parts-catalog'], queryFn: api.parts.catalog, staleTime: 5 * 60 * 1000 })).parts,
          (differing) => new Promise((answer) => setAsking({ differing, answer })),
          ownerSlug || undefined,
        );
        body.bbm = parts.bbm;
        partNotes = parts.notes;
        // The browser keeps the catalog for 60 s: fetch past that so the editor sees the new parts.
        if (parts.changed) await qc.fetchQuery({ queryKey: ['parts-catalog'], queryFn: api.parts.catalog, staleTime: 0 });
      } catch (err) {
        partNotes = [`the layout's parts could not be added: ${(err as Error).message}`];
      }
    }
    create.mutate(body, { onSuccess: (res) => onCreated(res.id, [...openWarnings, ...sidecarNotes, ...partNotes], bbm ? (bbmFilename ?? undefined) : undefined) });
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/60 p-4">
      {asking && (
        <PartDifferencesDialog
          differences={asking.differing}
          onDone={(choices) => {
            setAsking(null);
            asking.answer(choices);
          }}
        />
      )}
      <form
        role="dialog"
        aria-modal="true"
        aria-label="New layout"
        onSubmit={(e) => void submit(e)}
        className="w-full max-w-md space-y-4 rounded-lg border border-line bg-panel p-5 sm:p-6"
      >
        <h3 className="text-lg font-semibold">New layout</h3>

        {original && <OriginalLayoutNotice original={original} onOpen={onClose} />}

        {template && !bbm && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={fromTemplate} onChange={(e) => setFromTemplate(e.target.checked)} />
            Start from template “{template.title}”
          </label>
        )}

        <label className="block text-sm">
          <span className="mb-1 block text-muted">Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)} maxLength={MAX_NAME_LENGTH}
            placeholder="Untitled Layout"
            className="w-full rounded-lg border border-border bg-soft px-3 py-2"
          />
        </label>

        <SaveToPicker value={ownerSlug} onChange={setOwnerSlug} orgs={orgs.data?.orgs} />

        {venues.data && venues.data.venues.length > 0 && (
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Start from a venue</span>
            <select
              value={venueId}
              onChange={(e) => setVenueId(e.target.value)}
              className="w-full rounded-lg border border-border bg-soft px-3 py-2"
            >
              <option value="">No venue</option>
              {orderVenuesForOwner(
                venues.data.venues,
                orgs.data?.orgs.find((o) => o.slug === ownerSlug)?.id ?? null,
              ).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                  {v.ownerOrgId ? ` (${orgs.data?.orgs.find((o) => o.id === v.ownerOrgId)?.name ?? 'club'})` : ''}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="block text-sm">
          <span className="mb-1 block text-muted">Optional: start from a file</span>
          <input type="file" accept={START_FILE_ACCEPT} onChange={pickBbm} className="text-sm" />
          {bbmFilename && <p className="mt-1 text-xs text-muted">{bbmFilename}</p>}
          {openWarnings.map((w) => (
            <p key={w} className="mt-1 text-xs text-amber-400">{w}</p>
          ))}
        </label>
        <div className="-mt-2 space-y-2">
          <p className="flex items-start gap-1 text-xs text-muted">
            <span>{OPEN_FORMATS_LINE}</span>
            <HelpButton helpKey="open.formats" />
          </p>
          {desktopFile && (
            <div className="rounded-lg border border-line bg-soft p-3 text-xs text-muted">
              <DesktopOnlySteps name={desktopFile.name} format={desktopFile.format} />
            </div>
          )}
        </div>

        <label className="block text-sm">
          <span className="mb-1 block text-muted">Optional: sidecar (.bbm.cld / desktop .bbm.bld)</span>
          <input
            type="file"
            accept=".cld,.bbm.cld,.bld,.bbm.bld,application/json"
            onChange={pickSidecar}
            className="text-sm"
          />
          {sidecarNotes.map((w) => (
            <p key={w} className="mt-1 text-xs text-amber-400" data-testid="sidecar-note">{w}</p>
          ))}
        </label>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="tap-target rounded-lg border border-border px-4 py-2 hover:bg-soft"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={create.isPending}
            className="tap-target rounded-lg bg-accent text-accent-ink px-4 py-2 hover:bg-accent-hover disabled:opacity-50"
          >
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
